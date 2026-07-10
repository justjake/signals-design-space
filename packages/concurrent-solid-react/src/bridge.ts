/**
 * Maps the shared React batch registry onto the Solid core's transitions.
 *
 * The world model, in one paragraph: every *deferred* fork batch token owns a
 * Solid `Transition`. Deferred writes stage into that transition's
 * `_pendingValue` buffers; committed `_value` buffers stay untouched, so an
 * urgent render reads the committed world while a transition render (a render
 * pass whose `includedBatches` name the token) reads the staged world. A
 * retainer in the transition's `_actions` keeps it open; when React retires
 * the batch (`onBatchRetired`, inside the retiring commit), the retainer is
 * released and the transition completes — staged values become committed and
 * held user effects run. Solid's commit point IS React's commit point.
 *
 * Suspense: a pending read during render throws Solid's NotReadyError; the
 * hook converts it to a promise held on the async source node itself
 * (resolved by the core's `_onStatusSettled` hook when the node settles).
 * Node-held identity is what React's Suspense retries key on — retries see
 * the same thenable and converge instead of refetch-looping.
 */
import { NotReadyError } from './solid/error.js'
import {
	setAmbientWorldResolver,
	setRenderValueInterceptor,
	setWriteRouter,
	staleValues,
} from './solid/core.js'
import {
	activeTransition,
	createBridgeTransition,
	currentTransition,
	flush,
	globalQueue,
	isTransitionLive,
	releaseTransition,
	retainTransition,
	runInTransition,
	setActiveTransition,
	type Transition,
} from './solid/scheduler.js'
import { STATUS_PENDING } from './solid/constants.js'
import type { Computed, Signal } from './solid/types.js'
import { pokeReadersInCone, probeRead, type DepNode } from './reader.js'
import { ReactBatchRegistry } from 'react-signals-utils'

export interface ForkReact {
	__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: {
		T?: { gesture?: unknown } | null
		E?: unknown
	}
}

interface WorldRecord {
	token: number
	transition: Transition
	retainer: { csrToken: number }
}

export interface BridgeHandle {
	/** Errors thrown inside protocol listeners (never rethrown into React's
	 * commit); tests assert this stays empty. */
	errors: unknown[]
	dispose(): void
}

export const PENDING = Symbol('concurrent-solid-react.pending')

let bridge: Bridge | null = null

export function activeBridge(): Bridge | null {
	return bridge
}

export class Bridge {
	readonly fork: ForkReact
	readonly errors: unknown[] = []
	/** live deferred batch token -> its transition world */
	readonly worlds = new Map<number, WorldRecord>()
	/** container -> the transition world of its open render pass (null = urgent) */
	readonly passWorlds = new Map<unknown, Transition | null>()
	/**
	 * container -> per-pass pinned read values. React time-slices a render
	 * pass while the engine keeps committing urgent writes between slices; the
	 * first value each node produces in a pass is pinned for the pass's whole
	 * life, so every component in one committed frame agrees. Staleness is
	 * corrected pre-paint by the commit fixup. Cleared on pass start/end;
	 * deliberately kept across yields and suspensions (the frame is one pass).
	 */
	readonly passValues = new Map<unknown, Map<object, unknown>>()
	private registry: ReactBatchRegistry
	private unsubscribe: () => void

	constructor(fork: ForkReact) {
		this.fork = fork
		this.registry = new ReactBatchRegistry(fork)
		this.unsubscribe = this.registry.subscribe({
			onBatchOpened: (token) =>
				this.guard(() => {
					if (!(token & 1)) {
						return
					}
					const transition = createBridgeTransition()
					const retainer = { csrToken: token }
					retainTransition(transition, retainer)
					this.worlds.set(token, { token, transition, retainer })
				}),
			onRenderPassStart: (container, included) =>
				this.guard(() => {
					this.passValues.delete(container)
					this.beginPass(container, included)
				}),
			onRenderPassEnd: (container) =>
				this.guard(() => {
					this.passWorlds.delete(container)
					this.passValues.delete(container)
				}),
			onBatchRetired: (token) => this.guard(() => this.retire(token)),
		})
		setWriteRouter((el) => this.routeWrite(el))
		// [react-adapt E5] lets an untracked read inside a startTransition scope
		// (or a re-wrapped async-action continuation) see the scope's own staged
		// writes; all other outside-render reads resolve committed state.
		setAmbientWorldResolver(() => {
			if (renderReadDepth > 0) {
				return null
			}
			const scope = this.fork.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?.T
			if (scope === null || scope === undefined || scope.gesture) {
				return null
			}
			const token = this.registry.getCurrentWriteBatch()
			if (!(token & 1)) {
				return null
			}
			const rec = this.worlds.get(token)
			return rec && isTransitionLive(rec.transition) ? currentTransition(rec.transition) : null
		})
		// [react-adapt E13] per-pass value pinning; passthrough outside render
		// (commit fixups must see live values).
		setRenderValueInterceptor((el, value) => {
			const ctx = this.registry.getRenderContext()
			if (ctx === null) {
				return value
			}
			let pinned = this.passValues.get(ctx.container)
			if (pinned === undefined) {
				this.passValues.set(ctx.container, (pinned = new Map()))
			}
			if (pinned.has(el)) {
				return pinned.get(el)
			}
			pinned.set(el, value)
			return value
		})
	}

	private guard(fn: () => void): void {
		try {
			fn()
		} catch (e) {
			this.errors.push(e)
		}
	}

	private beginPass(container: unknown, included: ReadonlyArray<number>): void {
		// The pass world is the (entangled) transition of the included deferred
		// batches. React only includes multiple deferred batches in one pass when
		// it renders them together, which is exactly Solid's transition merge.
		let world: Transition | null = null
		for (const token of included) {
			if (!(token & 1)) {
				continue
			}
			const rec = this.worlds.get(token)
			if (!rec || !isTransitionLive(rec.transition)) {
				continue
			}
			const t = currentTransition(rec.transition)
			if (world === null) {
				world = t
			} else if (world !== t) {
				world = this.entangle(world, t)
			}
		}
		this.passWorlds.set(container, world)
	}

	private entangle(a: Transition, b: Transition): Transition {
		// Merge through initTransition so scheduler bookkeeping stays canonical.
		const prev = activeTransition
		setActiveTransition(b)
		globalQueue.initTransition(a)
		const merged = activeTransition!
		setActiveTransition(prev ? currentTransition(prev) : null)
		return merged
	}

	private retire(token: number): void {
		const rec = this.worlds.get(token)
		if (!rec) {
			return
		} // urgent tokens have no world
		this.worlds.delete(token)
		const root = currentTransition(rec.transition)
		releaseTransition(root, rec.retainer)
		if (root._actions.length === 0 && isTransitionLive(root)) {
			// Last batch of this world retired: complete the transition — commit
			// staged values, release held user effects. This runs inside React's
			// commit, so Solid's committed world advances exactly at React commit.
			setActiveTransition(root)
			try {
				flush()
			} finally {
				if (activeTransition === root) {
					setActiveTransition(null)
				}
			}
		}
	}

	/** [react-adapt E3] setSignal classification hook. */
	private routeWrite(_el: Signal<any> | Computed<any>): (() => void) | undefined {
		if (renderReadDepth > 0) {
			return
		} // internal writes during a render read keep the render's world
		if (this.registry.getRenderContext() !== null) {
			// React renders speculatively and replays them freely; a write issued
			// from a render body can run any number of times, including from
			// renders whose output is discarded. (Engine-internal writes during a
			// render read run under renderReadDepth and are exempt above.)
			throw new Error(
				'concurrent-solid-react: signal write during React render. Rendering must stay ' +
					'pure — move the write to an event handler or an effect.',
			)
		}
		const token = this.registry.getCurrentWriteBatch()
		if (!(token & 1)) {
			return
		} // urgent (or no batch): ambient world untouched
		const rec = this.worlds.get(token)
		if (!rec || !isTransitionLive(rec.transition)) {
			return
		}
		const prev = activeTransition
		const root = currentTransition(rec.transition)
		if (prev === root) {
			return () => pokeReadersInCone(_el)
		}
		globalQueue.initTransition(root)
		return () => {
			// Wake affected component readers NOW, inside the transition scope and
			// world, so their setStates land in this batch's lane before React's
			// close edge can retire a store-only batch (see pokeReadersInCone).
			pokeReadersInCone(_el)
			setActiveTransition(prev ? currentTransition(prev) : null)
		}
	}

	/** The transition world of the render pass currently on the callstack. */
	currentRenderWorld(): Transition | null {
		const ctx = this.registry.getRenderContext()
		if (!ctx) {
			return null
		}
		const world = this.passWorlds.get(ctx.container) ?? null
		return world && isTransitionLive(world) ? currentTransition(world) : null
	}

	/** First live token of a transition world (scanned from its retainers). */
	tokenOfWorld(world: Transition): number {
		for (const action of currentTransition(world)._actions) {
			const token = (action as { csrToken?: number } | null)?.csrToken
			if (typeof token === 'number' && this.worlds.has(token)) {
				return token
			}
		}
		return 0
	}

	/**
	 * Deliver a component wake-up in the lane of the world that caused it:
	 * inside React's commit/event code this runs synchronously (inheriting the
	 * writer's priority); during a render pass it defers to a microtask (React
	 * forbids cross-component setState mid-render). `forceUrgent` (optimistic
	 * wake-ups) escapes an ambient startTransition scope via the protocol's
	 * BATCH_NONE fallback — discrete priority, outside any transition — so
	 * optimistic UI shows immediately even when the write happened inside a
	 * transition callback.
	 */
	deliver(
		wake: () => void,
		world: Transition | null = activeTransition,
		forceUrgent: boolean = false,
	): void {
		const token = world && isTransitionLive(world) ? this.tokenOfWorld(world) : 0
		const fire = () => {
			if (token && this.worlds.has(token)) {
				this.registry.runInBatch(token, wake)
			} else if (forceUrgent) {
				this.registry.runInBatch(0, wake)
			} else {
				wake()
			}
		}
		if (this.registry.getRenderContext() !== null) {
			queueMicrotask(() => this.guard(fire))
		} else {
			fire()
		}
	}

	dispose(): void {
		setWriteRouter(null)
		setAmbientWorldResolver(null)
		setRenderValueInterceptor(null)
		this.unsubscribe()
		this.passValues.clear()
		this.registry.dispose()
		// Complete any worlds still open so engine state doesn't leak across
		// tests: writes are real (React never reverts them either).
		for (const rec of this.worlds.values()) {
			this.retire(rec.token)
		}
		this.passWorlds.clear()
		if (bridge === this) {
			bridge = null
		}
	}
}

let renderReadDepth = 0

export interface RenderReadResult<T> {
	value: T | typeof PENDING
	deps: DepNode[]
	world: Transition | null
	/** set when value === PENDING: the stable thenable to throw to React */
	thenable?: PromiseLike<unknown>
	/** set when the selector threw a non-pending error */
	error?: unknown
	errored: boolean
}

/**
 * Read `selector` the way a React render must: stale posture (committed
 * values for foreign worlds, staged values for the render's own world),
 * probe-tracked (deps harvested, no graph residue), pending converted to a
 * node-held stable thenable.
 */
export function renderRead<T>(selector: () => T): RenderReadResult<T> {
	const world = bridge ? bridge.currentRenderWorld() : null
	renderReadDepth++
	const prevWorld = activeTransition
	if (world) {
		setActiveTransition(world)
	}
	try {
		const { value, deps } = staleValues(() => probeRead(selector))
		return { value, deps, world, errored: false }
	} catch (e) {
		const deps = ((e as any)?.__csrDeps as DepNode[] | undefined) ?? []
		if (e instanceof NotReadyError && e.source) {
			return {
				value: PENDING,
				deps,
				world,
				thenable: settlementOf(e.source as Computed<any>),
				errored: false,
			}
		}
		return { value: PENDING, deps, world, error: e, errored: true }
	} finally {
		if (world) {
			setActiveTransition(prevWorld ? currentTransition(prevWorld) : null)
		}
		renderReadDepth--
	}
}

// -- Node-held suspense thenables -------------------------------------------

const settlements = new WeakMap<Computed<any>, Promise<void>>()

/**
 * The stable promise identifying "this async source's current wait". Created
 * on first suspension, resolved via the core's `_onStatusSettled` hook when
 * pending clears (value or error), then discarded — a later refetch gets a
 * fresh promise. Stability across Suspense retries is load-bearing: React
 * re-runs render after suspension and keys retry state on thenable identity.
 */
export function settlementOf(source: Computed<any>): Promise<void> {
	let p = settlements.get(source)
	if (p) {
		return p
	}
	let resolve!: () => void
	p = new Promise<void>((res) => (resolve = res))
	settlements.set(source, p)
	source._onStatusSettled = () => {
		source._onStatusSettled = undefined
		settlements.delete(source)
		resolve()
	}
	// Raced settle (status cleared between throw and here): resolve now.
	if (!(source._statusFlags & STATUS_PENDING)) {
		source._onStatusSettled()
	}
	return p
}

// -- Registration ------------------------------------------------------------

export function attachBridge(fork: ForkReact): Bridge {
	if (bridge) {
		throw new Error('concurrent-solid-react: bridge already attached')
	}
	assertForkPresent(fork)
	bridge = new Bridge(fork)
	return bridge
}

export function assertForkPresent(react: Partial<ForkReact>): asserts react is ForkReact {
	const channel = react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?.E as
		| { forkProtocolVersion?: unknown }
		| null
		| undefined
	if (channel?.forkProtocolVersion !== 1) {
		throw new Error(
			'concurrent-solid-react requires the patched React signals protocol; stock React is unsupported.',
		)
	}
}

/** Test-only: run `fn` inside a transition world (simulates a deferred batch
 * without React). */
export function __runInWorld<T>(t: Transition, fn: () => T): T {
	return runInTransition(t, fn)
}
