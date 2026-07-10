/**
 * cosignals-react — the hook surface: useSignal, useComputed, useReducerAtom,
 * useSignalEffect, startSignalTransition, plus registerCosignalReact — the
 * activation call that couples `cosignals`'s default browser engine to a
 * protocol React build via the Shim (whose constructor attaches the engine
 * driver — the seam that arms write classification and world routing).
 *
 * Watcher lifecycle, shared by the subscription hooks (a watcher is the
 * engine's record of one subscribed component instance): render creates (or
 * re-tracks) a watcher in the current render's world, so the component reads
 * the view of the render it is part of; the layout effect claims the
 * subscription after commit (StrictMode's double-mount nets to one live
 * watcher via microtask-debounced unsubscription); the mount fixup — the
 * engine's commit-time reconciliation of a freshly mounted component
 * against updates that were in flight while it mounted — runs inside the
 * engine at the commit edge, and its corrective re-renders and urgent
 * corrections reach React as pre-paint setStates through the shim.
 */

import * as React from 'react'
import { BATCH_NONE, isAtom, isComputed } from 'cosignals'
import type {
	AnyInternals,
	Atom,
	Computed,
	Cosignals,
	CosignalEngine,
	ReducerAtom,
	RootId,
} from 'cosignals'
import {
	ROOT_UNKNOWN,
	Shim,
	getActiveShim,
	setActiveShim,
	unregisterShim,
	type BoundCtx,
	type WatcherTarget,
} from './shim.js'

// ---- activation -------------------------------------------------------------------

export type CosignalReactHandle = {
	/** The default browser instance's engine surface; the field keeps the
	 * bindings' historical name. */
	bridge: CosignalEngine
	shim: Shim
	dispose: () => void
}

/**
 * Activates the bindings: attaches the engine driver (write classification,
 * world routing, delivery listeners — the Shim constructor's job) and
 * subscribes the shim to the private React signals taps. Call during
 * app setup, after importing react-dom/client (the renderer must have
 * registered its protocol provider first), before rendering any root;
 * throws on stock React — see assertForkPresent. One registration at a
 * time: dispose the handle before registering again. Dispose releases the
 * React-side registrations only — the engine's driver slot is cleared only
 * by the test-only engine reset (`__TEST__resetEngine`), so tests reset
 * the engine between registrations.
 *
 * `instance` binds a specific createCosignals() instance instead of the default
 * browser instance — the synchronous-SSR path. renderToString is synchronous
 * and single-threaded, so register(instance) → renderToString → dispose is
 * race-free within one request; every hook (and every handle created with the
 * instance) then routes through that request's isolated graph. This is a GLOBAL
 * registration (one active shim at a time), so it is NOT safe for streaming or
 * concurrent SSR that keeps several instances live at once — a second concurrent
 * register() throws rather than corrupting; see the README's SSR section.
 */
export function registerCosignalReact(instance?: Cosignals): CosignalReactHandle {
	if (getActiveShim() !== undefined) {
		throw new Error(
			'cosignals-react: already registered (dispose the previous registration first).',
		)
	}
	const shim = new Shim(instance)
	setActiveShim(shim)
	return {
		bridge: shim.bridge,
		shim,
		dispose: () => {
			shim.dispose()
			unregisterShim(shim) // clears the slot only if it still points at this shim — never a successor's registration
		},
	}
}

export function requireShim(): Shim {
	const shim = getActiveShim()
	if (shim === undefined) {
		throw new Error(
			'cosignals-react: registerCosignalReact() must run before using cosignals hooks.',
		)
	}
	return shim
}

// ---- signal sources ---------------------------------------------------------------------
// (Kernel `Computed` handles are the supported derived
// type. `useComputed` returns a real `Computed`; standalone `Computed`
// instances route to the render's world through the core's computed-read
// seam and subscribe through `useSignal` exactly like atoms.)

export type SignalSource<T> = Atom<T> | ReducerAtom<T, unknown> | Computed<T>

function resolveNode(shim: Shim, signal: SignalSource<unknown>): AnyInternals {
	// Brand-based, not `instanceof`: createCosignals() creates per-instance
	// Atom/Computed classes, so `instanceof Atom` from the default instance
	// rejects a per-request handle. isAtom/isComputed recognize a handle from ANY
	// instance; the bridge's internalsForAtom/internalsForComputed then assert the
	// handle belongs to THIS shim's bound engine, throwing a clear cross-instance
	// error rather than silently resolving its id against the wrong arena.
	if (isAtom(signal)) {
		return shim.internalsForAtom(signal as Atom<unknown>)
	}
	if (isComputed(signal)) {
		return shim.bridge.internalsForComputed(signal as Computed<unknown>)
	}
	throw new Error(
		'cosignals-react: useSignal accepts Atom/ReducerAtom/Computed handles (useComputed results are Computed handles).',
	)
}

// ---- useSignal --------------------------------------------------------------------------

type SignalRecord = {
	node: AnyInternals
	watcherId: number | undefined
	target: WatcherTarget
	pendingUnsub: boolean
	root: RootId | undefined
	lastValue: unknown
}

type SignalRefState = { current: SignalRecord | null; retired: SignalRecord[] }

function createSignalRecord(node: AnyInternals, bump: () => void): SignalRecord {
	return {
		node,
		watcherId: undefined,
		target: { bump, live: false },
		pendingUnsub: false,
		root: undefined,
		lastValue: undefined,
	}
}

/**
 * Subscribes the component to an atom (or a useComputed result) and returns
 * its value in the world of the render the component is part of: a
 * transition render sees the transition's pending value, an urgent render
 * sees committed state, and every component in one render pass sees the
 * same frozen view — no frame can mix old and new state. The component
 * re-renders whenever the value changes in some batch's world, and that
 * re-render is scheduled in the batch's own lane, so it stays part of the
 * update that caused it.
 *
 * Mounting is the subtle case. A component can mount while other updates
 * are in flight, and its subscription only activates at commit — so writes
 * could slip by unobserved between its render and its commit. The layout
 * effect below claims the subscription, and the bridge's mount fixup (run
 * at the commit edge) closes the window: for every still-live batch that
 * touched relevant state but was not part of this component's render, a
 * corrective re-render is scheduled into that batch's own lane — the
 * component joins the pending update
 * instead of revealing it early or missing it — and one comparison against
 * committed-state-as-of-now catches anything that committed or retired
 * during the window, fixed urgently before paint.
 */
export function useSignal<T>(signal: SignalSource<T>): T {
	const shim = requireShim()
	const node = resolveNode(shim, signal as SignalSource<unknown>)
	const [, force] = React.useReducer((c: number) => c + 1, 0)
	const ref = React.useRef<SignalRefState | null>(null)
	if (ref.current === null) {
		ref.current = { current: null, retired: [] }
	}
	const state = ref.current

	// Signal identity changed across renders: queue the old subscription for
	// teardown (finalized at the next layout effect) and create a fresh one.
	if (state.current !== null && state.current.node !== node) {
		state.retired.push(state.current)
		state.current = null
	}
	if (state.current === null) {
		state.current = createSignalRecord(node, () => force())
	}
	const rec = state.current

	const rendering = shim.renderingRoot()
	const bridge = shim.bridge
	let value: unknown
	if (rendering?.renderPass !== undefined && rendering.renderPass.state !== 'ended') {
		const render = rendering.renderPass
		rec.root = rendering.id
		const w = rec.watcherId === undefined ? undefined : bridge.watchers.get(rec.watcherId)
		if (w === undefined) {
			// Mount: create the watcher in this render's world; the value it renders
			// is captured so the commit-edge fixup can compare against it.
			value = shim.hookRead(() => {
				const created = bridge.mountWatcher(render.id, node, 'w?')
				created.name = `w${created.id}`
				rec.watcherId = created.id
				shim.targets.set(created.id, rec.target)
				shim.noteCreated(rendering, created.id)
				return created.lastRenderedValue
			})
		} else if (w.live) {
			// Re-render: re-arm the watcher's delivery dedup and read this render's world.
			bridge.renderWatcher(render.id, w.id)
			value = shim.hookRead(() => bridge.renderValue(node, render))
		} else {
			// Reveal-shaped re-render (previously hidden content shown again, e.g.
			// React Activity/Offscreen): adopt the dormant watcher into this render
			// so the commit-edge mount fixup reconciles it — against batches this
			// render did not include, and against committed state — as if it were
			// a fresh mount.
			bridge.adoptRevealedMount(render.id, w.id)
			shim.noteCreated(rendering, w.id)
			value = shim.hookRead(() => bridge.renderValue(node, render))
		}
	} else {
		// Render outside a tracked render pass (defensive): unrouted newest read.
		value = shim.hookRead(() => bridge.newestValue(node))
	}
	rec.lastValue = value

	React.useLayoutEffect(() => {
		shim.claimWatcher(rec)
		for (const old of state.retired.splice(0)) {
			shim.finalizeUnsub(old)
		}
		return () => {
			// Microtask-debounced unsubscribe. In development StrictMode React
			// mounts, unmounts, and remounts each component to surface unsafe
			// effects; the unmount's cleanup and the remount's claim both run
			// synchronously inside the commit, before this microtask fires, so
			// the pair nets out to one live subscription instead of a teardown
			// plus a fresh subscribe. Activity hide/reveal cancels the same way.
			rec.pendingUnsub = true
			queueMicrotask(() => {
				// The disposed guard is the cross-reset guard: tests dispose the
				// shim before resetting the default engine, and a microtask crossing
				// that boundary would tear down a watcher id inside a fresh
				// composition it never belonged to. A disposed shim's pending
				// unsubscribes died with its targets.
				if (!shim.disposed && rec.pendingUnsub) {
					shim.finalizeUnsub(rec)
				}
			})
		}
	}, [shim, rec])

	return value as T
}

// ---- useComputed ------------------------------------------------------------------------

let nextComputedSerial = 1

/**
 * A derived value scoped to the component, with useMemo semantics applied to
 * node identity: while `deps` are equal you keep the same node (nothing is
 * created); when `deps` change, a fresh node capturing the new closure is
 * created in work-in-progress hook state — kept if the render commits,
 * dropped if the render is discarded. Returns a real kernel `Computed`
 * handle whose `.state` reads in the current render's
 * world through the core's computed-read seam.
 *
 * Recreating instead of swapping the function in place is deliberate: a
 * node's evaluating function must stay immutable for the node's whole life,
 * because pending worlds replay evaluation — if a live node's function
 * could change, one world could observe another closure's output. A changed
 * function therefore only takes effect through changed deps (the useMemo
 * rule). Inside `fn`, ctx.previous is a hint carrying the last committed
 * value (possibly stale or undefined) and ctx.use reads async data
 * (suspending the component via React Suspense while pending) in two forms:
 * `ctx.use(promise)` for a promise the app's data layer caches, and
 * `ctx.use(key, factory)` for a request cached per key on the node itself.
 * The keyed cache lives exactly as long as the node: deps changes (and
 * discarded mount attempts, which throw away hook state) recreate the node
 * and refetch — React's own useMemo/uncached-promise lifecycle.
 *
 * Reclamation: when a deps change commits, the SUPERSEDED handle's
 * kernel record is disposed after the commit (a passive effect keyed on the
 * handle — by then every subscription hook re-keyed to the replacement), so
 * kernel ids recycle deterministically per deps change; the record's
 * generation stamp makes the reuse sound. Discarded render attempts drop
 * their created handle with the discarded hook state; the record recovers
 * through the garbage-collection reclamation path once the handle is
 * collected.
 */
export function useComputed<T>(fn: (ctx: BoundCtx<T>) => T, deps: readonly unknown[]): Computed<T> {
	const shim = requireShim()
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const handle = React.useMemo(
		() => {
			// shim.Computed is the BOUND instance's class, so the handle belongs to
			// the engine this shim routes through (matters for SSR per-request
			// instances; identical to the default class in the browser).
			const c = new shim.Computed<T>(fn, { label: `useComputed#${nextComputedSerial++}` })
			shim.bridge.internalsForComputed(c as Computed<unknown>) // allocate engine content + wrap for world evaluation
			return c
		},
		// The user's deps ARE the memo key: a changed fn takes effect only with changed deps.
		[shim, ...deps],
	)
	const prevRef = React.useRef<Computed<T> | null>(null)
	React.useEffect(() => {
		const prev = prevRef.current
		prevRef.current = handle
		if (prev !== null && prev !== handle) {
			shim.bridge.disposeComputed(prev as Computed<unknown>)
		}
	}, [shim, handle])
	return handle
}

// ---- useReducerAtom -----------------------------------------------------------------------

let warnedReducerSwap = false

/**
 * [value, dispatch] with useReducer parity, backed by an atom created once
 * for the component's lifetime. The reducer is fixed at creation and must
 * be pure: dispatched actions are stored and replayed to compute each
 * world's value, so an impure or swapped reducer would let worlds disagree
 * about the same history. A render passing a different reducer function
 * does not swap it (warns once in development; remount with a `key` to
 * change reducers).
 */
export function useReducerAtom<S, A>(
	reducer: (state: S, action: A) => S,
	initial: S,
): [S, (action: A) => void] {
	const shim = requireShim()
	// shim.ReducerAtom is the bound instance's class (see useComputed).
	const [record] = React.useState(() => ({
		atom: new shim.ReducerAtom<S, A>(reducer, initial),
		reducer,
	}))
	if (record.reducer !== reducer && !warnedReducerSwap) {
		warnedReducerSwap = true
		// eslint-disable-next-line no-console
		console.warn(
			'cosignals: useReducerAtom reducers are fixed at creation — remount with a key to change reducers.',
		)
	}
	const value = useSignal(record.atom as unknown as Atom<S>)
	const dispatch = React.useCallback((action: A) => record.atom.dispatch(action), [record])
	return [value, dispatch]
}

// ---- useSignalEffect ----------------------------------------------------------------------

/**
 * One effect with two ways to be requested to run — a change to `deps` in a
 * committed React render, or a durable change reaching a signal it read during
 * its last run — that converge on a single cleanup/body lifecycle. Its signal
 * reads resolve in the committed world of the component's root, never pending
 * state: side effects (network, imperative DOM, logging) must track what the
 * user actually sees, and a pending transition may still be discarded.
 *
 * Observable behavior:
 * - The body runs once after mount.
 * - A `deps`-only change runs it once (through React's own useEffect).
 * - A signal-only change runs it once WITHOUT scheduling a React render.
 * - When the same cause reaches the effect through both a committed render and
 *   signal propagation, it runs ONCE — with the committed React closure and
 *   committed signal values, never an old closure against new signal state.
 * - Cleanup runs once before each actual rerun and once at unmount.
 * - A signal write from the body queues any resulting rerun until the current
 *   run finishes; it does not re-render the component from inside the body.
 *
 * Re-fires are AT-LEAST-ONCE: writes that put a value back where the effect
 * last saw it usually coalesce away at the next boundary, but an equal-value
 * round trip whose intermediate state the engine observed elsewhere may re-fire
 * the effect with unchanged inputs — write idempotent effect bodies, exactly as
 * you would for React's own Strict Mode re-runs. Equality-gated write ACCEPTANCE
 * is unaffected: a write that changes nothing is still not a change.
 */
export function useSignalEffect(fn: () => void | (() => void), deps?: readonly unknown[]): void {
	const shim = requireShim()
	const rootRef = React.useRef<RootId | undefined>(undefined)
	const stateRef = React.useRef<{
		id: number | undefined
		fn: (() => void | (() => void)) | undefined
		deps: readonly unknown[] | undefined
		cleanup: void | (() => void)
		hasRun: boolean
		disposed: boolean
		run: () => void
	} | null>(null)
	if (stateRef.current === null) {
		stateRef.current = {
			id: undefined,
			fn: undefined,
			deps: undefined,
			cleanup: undefined,
			hasRun: false,
			disposed: false,
			run: () => {
				const current = stateRef.current!
				current.cleanup = current.fn!()
			},
		}
	}
	const state = stateRef.current
	const rendering = shim.renderingRoot()
	if (rendering !== undefined) {
		rootRef.current = rendering.id
	} // idempotent render capture
	if (
		state.id !== undefined &&
		state.hasRun &&
		rendering?.renderPass !== undefined &&
		rendering.renderPass.state !== 'ended'
	) {
		const previousDeps = state.deps
		let changed =
			deps === undefined || previousDeps === undefined || deps.length !== previousDeps.length
		if (!changed && deps !== undefined && previousDeps !== undefined) {
			for (let i = 0; i < deps.length; i++) {
				if (!Object.is(deps[i], previousDeps[i])) {
					changed = true
					break
				}
			}
		}
		shim.renderSignalEffect(rendering.renderPass.id, state.id, changed)
	}
	// eslint-disable-next-line react-hooks/exhaustive-deps
	React.useEffect(
		() => {
			const root = rootRef.current ?? ROOT_UNKNOWN
			state.disposed = false
			state.fn = fn
			state.deps = deps
			state.hasRun = true
			if (state.id === undefined) {
				const id = shim.registerEffect(root, () => {
					if (state.disposed || state.id === undefined || state.fn === undefined) {
						return
					}
					const cleanup = state.cleanup
					state.cleanup = undefined
					if (typeof cleanup === 'function') {
						cleanup()
					}
					shim.captureEffectRun(state.id, state.run)
				})
				state.id = id
			}
			const cleanup = state.cleanup
			state.cleanup = undefined
			if (typeof cleanup === 'function') {
				cleanup()
			}
			shim.captureEffectRun(state.id, state.run)
		},
		deps === undefined ? undefined : [shim, ...deps],
	)
	React.useEffect(() => {
		return () => {
			state.disposed = true
			if (state.id !== undefined) {
				shim.unregisterEffect(state.id)
			}
			state.id = undefined
			const cleanup = state.cleanup
			state.cleanup = undefined
			if (typeof cleanup === 'function') {
				cleanup()
			}
		}
	}, [shim, state])
}

// ---- startSignalTransition ------------------------------------------------------------------

/**
 * Starts a transition action with the exact rule React's own startTransition
 * has. (A transition marks an update as non-urgent: React renders it in the
 * background while urgent updates keep landing and committing in between.)
 * `fn` receives no arguments and needs no special API: inside its
 * synchronous part the protocol's write-batch context IS the action's batch,
 * so ordinary `atom.set` / `atom.update` / `ReducerAtom.dispatch` calls
 * classify into it through the one write classifier — exactly like every
 * other write. Returning a promise parks the batch until it settles (React
 * async-action semantics), so pending state stays pending across the whole
 * action. Writes after an `await` classify like any other write at that
 * moment — urgent unless re-wrapped in a fresh startTransition — because
 * the async continuation runs on a fresh call stack with no ambient
 * transition context: the same rule, for the same reason, as React's own
 * transitions (a bare post-await write while an action is pending gets a
 * development warning).
 */
export function startSignalTransition(fn: () => unknown): void {
	const shim = requireShim()
	React.startTransition((): void => {
		// React's transition scope selects the registry batch; the shim maps it
		// to the engine batch used by every signal write in this callback.
		const batchId = shim.currentBatch()
		// Upgrade the batch to action semantics immediately (parked — kept pending —
		// until the action settles), before fn writes anything: the parked
		// batch holds the pending window open for the action's whole life,
		// even for an action that only writes after its first await. With no
		// batch context (BATCH_NONE, dev checks off) there is no batch to park:
		// the action runs and its writes classify as they land — ordinary
		// no-context writes, the same fall-through as the write classifier —
		// rather than creating a parked batch nothing could ever settle.
		if (batchId !== BATCH_NONE) {
			shim.upgradeToAction(batchId)
		}
		// Returning fn's thenable keeps the transition pending until it settles
		// (React async-action semantics); the protocol host retires the batch
		// at settlement, which is when its writes become permanent history.
		return fn() as undefined
	})
}
