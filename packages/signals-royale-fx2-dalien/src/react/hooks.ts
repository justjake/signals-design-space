/**
 * React hooks connect signals to components: they read values, subscribe
 * to changes, and re-render through React's own state machinery.
 *
 * Every re-render request is a dispatch into the hook's own reducer, so
 * each re-render gets its scheduling from the dispatch context — exactly
 * useState's semantics. A base write in a click handler renders
 * synchronously before paint; the same write from a timeout or a promise
 * renders at default priority (and may land after a paint — flushSync is
 * the escape hatch, as for any React state); a drafted write dispatches
 * inside its owning transition and renders in that transition's passes.
 *
 * Two message kinds flow through the reducer:
 *
 * - Draft ids: when a transition writes an atom, exactly the subscribers
 *   of that atom (and of watched computeds over it) receive the draft id,
 *   dispatched inside the transition's own scope. React's update queues
 *   then decide visibility per pass: urgent passes skip the update and
 *   see base state, the transition's passes include it, rebased retries
 *   recompute it. Deduped per hook per render window (see `delivered`).
 *
 * - REPAIR_WAKE, meaning "re-render against current state". Sent when the
 *   engine notifies this subscriber and re-rendering would actually show
 *   it something different from what it rendered (resolutionDiffers in
 *   host.ts). Deduped per render window (see `repairPending`).
 *
 * Subscriptions attach in a passive effect, at commit time. The gap
 * between rendering and attaching — hydration's first commit is just the
 * widest such gap — is closed by correctSubscription, which replays
 * missed drafts and compares the rendered resolution against current
 * state.
 */
import type * as React from 'react'
import {
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useReducer,
	useRef,
} from 'react'
import {
	committedSnapshot,
	createAtom,
	createComputed,
	isErrorBox,
	isPendingPassive,
	isUninitialized,
	nodeOf,
	type Atom,
	type AtomOptions,
	type Signal,
} from '../index.ts'
import {
	Flag,
	activeWorldSourceConsumer,
	dependencyOf,
	makeScheduledEffect,
	nextDependency,
	observeNode,
	type Link,
	type ReactiveNode,
	type ScheduledEffect,
} from '../graph.ts'
import {
	committedWorldOf,
	resolveState,
	trackWorldSources,
	withWorld,
	worldOf,
	type DraftId,
	type World,
} from '../worlds.ts'
import { type ErrorBox, type ResolvedState, type Suspension } from '../asyncs.ts'
import { getActiveTracer } from '../tracer.ts'
import {
	correctSubscription,
	dispatchDraftWake,
	dispatchUrgent,
	noteHookRender,
	renderPassIds,
	resolutionDiffers,
	REPAIR_WAKE,
	type SignalScope,
	type RenderedResolution,
} from './host.ts'
import { EMPTY_WORLD, ScopeContext, worldsReducer } from './SignalScopeProvider.ts'

interface UseValueState {
	delivered: Set<DraftId>
	/** What the hook's most recent render resolved (committed or not). */
	rendered: RenderedResolution
	repairPending: boolean
	/**
	 * What the committed tree shows for this hook. Advances only in the
	 * layout effect, so a transition's speculative values never enter it
	 * while the transition is held. The notify predicate compares against
	 * this, which keeps folds silent when the committed tree already shows
	 * their values and keeps live appends from double-dispatching repairs.
	 */
	committed: RenderedResolution
}

interface SignalEffectState {
	effect: ScheduledEffect | null
	/** The scope whose committed world the installed watcher currently uses. */
	scope: SignalScope | null
	/**
	 * The watcher owns dependency identity and edges. This is only its
	 * current link head plus parallel per-root committed values.
	 */
	dependencies: Link | undefined
	dependencyValues: unknown[]
	dependencyCount: number
	version: number
	running: boolean
	rerunRequested: boolean
}

const NO_IDS: readonly DraftId[] = []

function forceReducer(count: number): number {
	return count + 1
}

function signalEffectValue(node: ReactiveNode, world: World): unknown {
	const state = resolveState(node, world)
	if (activeWorldSourceConsumer !== null && (node.flags & Flag.KindDerived) !== 0) {
		trackWorldSources(node, world)
	}
	if ((state.flags & Flag.AsyncError) !== 0) {
		return state.throwable
	}
	if ((state.flags & Flag.AsyncSuspended) !== 0 && isUninitialized(state.value)) {
		return state.throwable
	}
	return state.value
}

function signalEffectDependenciesChanged(state: SignalEffectState, world: World): boolean {
	let link = state.dependencies
	for (let i = 0; i < state.dependencyCount; i++) {
		if (!Object.is(signalEffectValue(dependencyOf(link!), world), state.dependencyValues[i])) {
			return true
		}
		link = nextDependency(link!)
	}
	return false
}

/**
 * Dispose a scheduled effect and release every hook-side reference it
 * retained. Used both by React unmount and by the setup-throw path, where a
 * later cleanup hook in the same commit would never get a chance to mount.
 */
function disposeSignalEffect(state: SignalEffectState): void {
	const effect = state.effect
	const scope = state.scope
	try {
		if (effect !== null) {
			const world = scope === null ? null : committedWorldOf(scope)
			if (world === null || world.drafts.length === 0) {
				effect.dispose()
			} else {
				withWorld(world, () => effect.dispose())
			}
		}
	} finally {
		state.effect = null
		state.scope = null
		state.dependencies = undefined
		state.version = -1
		state.running = false
		state.rerunRequested = false
		for (let i = 0; i < state.dependencyCount; i++) {
			state.dependencyValues[i] = undefined
		}
		state.dependencyCount = 0
	}
}

/**
 * These hooks cannot work without a SignalScopeProvider: the scope carries
 * transition worlds, and a subscriber without one would have no channel
 * for them at all. Rendering a scope-consuming hook outside a scope is a
 * wiring error — fail loudly, at the hook, naming the fixes.
 */
function requireScope(hook: string): SignalScope {
	const scope = useContext(ScopeContext)
	if (scope === null) {
		throw new Error(
			`${hook} was rendered without a SignalScopeProvider above it. ` +
				'Create roots with wrapCreateRoot(createRoot), or wrap the tree in <SignalScopeProvider>.',
		)
	}
	return scope
}

const lastDelivered = new WeakMap<ReactiveNode, unknown>()
const NEVER = Symbol('never-delivered')

function traceDelivery(node: ReactiveNode, value: unknown): void {
	const prev = lastDelivered.has(node) ? lastDelivered.get(node) : NEVER
	if (prev !== value) {
		lastDelivered.set(node, value)
		getActiveTracer()?.emit('deliver', node, node.causeEvent)
	}
}

/**
 * Unwrap a resolved state for a render, deciding between suspending and
 * serving a stale value:
 * - a transition render (its world carries live drafts) hands React the
 *   pending thenable, so the transition holds and the previous UI stays;
 * - an urgent render with settled history serves the stale value —
 *   useIsPending is the loading indicator, and there is no fallback
 *   flash;
 * - a never-settled value suspends everywhere.
 */
function unwrapState(st: ResolvedState, world: World): unknown {
	const asyncBits = st.flags & Flag.AsyncMask
	if (asyncBits === 0) {
		return st.value
	}
	if (asyncBits === Flag.AsyncError) {
		throw (st.throwable as ErrorBox).error
	}
	const suspension = st.throwable as Suspension
	if (world.drafts.length > 0) {
		throw suspension.promise
	}
	if (!isUninitialized(st.value)) {
		return st.value
	} // settled history: stale serves
	throw suspension.promise
}

/**
 * Read x and subscribe: the component re-renders whenever the value it
 * would show changes.
 *
 * The hook renders in a world chosen from React state: the pass's valid
 * note when the hook's scope wrote one (covering components that mount
 * inside a transition pass, whose reducers never received the write-time
 * dispatch), and otherwise the hook's own reducer state. Both come from
 * React state for this very pass, so neither can run ahead of it.
 *
 * A committed transition costs no extra renders by construction:
 * resolutionDiffers resolves in the world this hook rendered, and a
 * fold whose values were already delivered through render-pass worlds
 * compares equal. The gap for subscribers that attached late is closed by
 * correctSubscription at subscribe time.
 */
export function useValue<T>(x: Signal<T>): T {
	const node = nodeOf(x)
	const scope = requireScope('useValue')
	const [hookWorld, wake] = useReducer(worldsReducer, EMPTY_WORLD)
	noteHookRender(scope, hookWorld.ids)
	const ids = renderPassIds(scope) ?? hookWorld.ids
	// One record per hook owns the delivery/repair protocol. Initialize it
	// explicitly because useRef evaluates a non-primitive initializer every
	// render even though React consumes that value only on mount.
	const stateRef = useRef<UseValueState | null>(null)
	let state = stateRef.current
	if (state === null) {
		state = {
			delivered: new Set(),
			rendered: { ids: NO_IDS, value: undefined, live: false },
			repairPending: false,
			committed: { ids: NO_IDS, value: undefined, live: false },
		}
		stateRef.current = state
	}
	// Draft ids delivered to this hook's reducer since its last render. A
	// repeat id adds nothing while the first is still queued: the dispatch
	// only schedules, and the pass that consumes it resolves the world
	// live, later appends included. The set is cleared unconditionally on
	// every render because a pass that consumed the draft ends that
	// guarantee — a later append must re-dispatch, or React bails out and
	// the transition commits a stale frame. Over-clearing (an abandoned
	// pass, a StrictMode double render) merely permits a redundant
	// dispatch, which is harmless; writes during render throw, so no
	// delivery can race the clear.
	state.delivered.clear()
	const deliver = useCallback(
		(id: DraftId) => {
			if (state.delivered.has(id)) {
				return
			}
			state.delivered.add(id)
			dispatchDraftWake(id, wake)
		},
		[state, wake],
	)
	// At most one REPAIR_WAKE per render window, cleared alongside
	// `delivered` under the same reasoning: a pending dispatch already
	// guarantees a re-render against current state.
	state.repairPending = false
	// Render-notify delivery: the engine says "something over your sources
	// moved" (a base wave, a poke, a fold), and the predicate answers
	// "would the committed tree show anything different if re-rendered
	// now?". The dispatch inherits the ambient scheduling context —
	// exactly useState's semantics for the write that caused it.
	const onNotify = useCallback(() => {
		// The scope's first-child marker confirms before descendant layout
		// effects. During that narrow window this render is the one committing,
		// so compare against it directly; outside it, never trust speculative
		// render state over the last completed commit.
		const stash = scope.committing ? state.rendered : state.committed
		if (!stash.live || state.repairPending) {
			return
		}
		if (!resolutionDiffers(node, stash)) {
			return
		}
		state.repairPending = true
		wake(REPAIR_WAKE)
	}, [node, scope, state, wake])
	// Subscribe in a passive effect, at commit time; correctSubscription
	// closes the gap between rendering and the subscription attaching.
	useEffect(() => {
		const off = observeNode(node, onNotify, deliver)
		if (state.rendered.live) {
			correctSubscription(node, state.rendered, scope, deliver, wake)
		}
		return off
	}, [node, scope, state, deliver, wake, onNotify])
	const world = worldOf(ids)
	const st = resolveState(node, world)
	const value = unwrapState(st, world)
	const stash = state.rendered
	stash.ids = ids
	stash.value = value
	stash.live = true
	// Advance the committed stash at commit time. No dependency array: the
	// effect runs on every commit with that render's resolution, and a
	// suspended render never reaches it.
	useLayoutEffect(() => {
		const c = state.committed
		c.ids = ids
		c.value = value
		c.live = true
	})
	traceDelivery(node, value)
	return value as T
}

/**
 * A component-scoped computed. No explicit disposal: an unwatched
 * computed only holds references toward its dependencies, so dropping it
 * at unmount makes it garbage-collectible.
 */
export function useComputed<T>(fn: () => T, deps: React.DependencyList): T {
	requireScope('useComputed') // fail with this hook's name, not useValue's
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const c = useMemo(() => createComputed(fn), deps)
	return useValue(c)
}

function useSignalEffectImpl(
	fn: () => void | (() => void),
	usePhaseEffect: typeof useEffect,
): void {
	const scope = requireScope(
		usePhaseEffect === useLayoutEffect ? 'useSignalLayoutEffect' : 'useSignalEffect',
	)
	const [version, schedule] = useReducer(forceReducer, 0)
	const stateRef = useRef<SignalEffectState | null>(null)
	let state = stateRef.current
	if (state === null) {
		state = {
			effect: null,
			scope: null,
			dependencies: undefined,
			dependencyValues: [],
			dependencyCount: 0,
			version: -1,
			running: false,
			rerunRequested: false,
		}
		stateRef.current = state
	}
	usePhaseEffect(() => {
		const scopeChanged = state.scope !== scope
		const signalRequested = state.version !== version
		const rerunRequested = state.rerunRequested
		if (!scopeChanged && !signalRequested && !rerunRequested) {
			return
		}
		state.scope = scope
		state.version = version
		state.rerunRequested = false
		const world = committedWorldOf(scope)
		if (
			!scopeChanged &&
			!rerunRequested &&
			state.effect !== null &&
			!state.effect.refresh(() => signalEffectDependenciesChanged(state, world))
		) {
			return
		}
		state.effect ??= makeScheduledEffect(
			() => {
				if (state.running) {
					state.rerunRequested = true
					schedule()
					return
				}
				const committedScope = state.scope
				if (committedScope !== null && state.effect !== null) {
					const changed = state.effect.refresh(() =>
						signalEffectDependenciesChanged(state, committedWorldOf(committedScope)),
					)
					if (changed) {
						schedule()
					}
				}
			},
			() => schedule(),
		)
		try {
			state.running = true
			try {
				const effect = state.effect
				state.dependencies =
					world.drafts.length === 0 ? effect.run(fn) : withWorld(world, () => effect.run(fn))
			} finally {
				state.running = false
			}
			const previousCount = state.dependencyCount
			let count = 0
			for (
				let link = state.dependencies;
				link !== undefined;
				link = nextDependency(link)
			) {
				state.dependencyValues[count] = signalEffectValue(dependencyOf(link), world)
				count++
			}
			for (let i = count; i < previousCount; i++) {
				state.dependencyValues[i] = undefined
			}
			state.dependencyCount = count
		} catch (error) {
			disposeSignalEffect(state)
			throw error
		}
	})
	usePhaseEffect(() => {
		return () => disposeSignalEffect(state)
	}, [])
}

/** Run a tracked signal effect during React's passive-effect phase. */
export function useSignalEffect(fn: () => void | (() => void)): void {
	useSignalEffectImpl(fn, useEffect)
}

/** Run a tracked signal effect during React's layout-effect phase. */
export function useSignalLayoutEffect(fn: () => void | (() => void)): void {
	useSignalEffectImpl(fn, useLayoutEffect)
}

/**
 * True while newer data exists behind the committed value of x: a
 * pending transition draft on it, or an async refetch loading behind a
 * stale value.
 */
export function useIsPending(x: Signal<any>): boolean {
	const node = nodeOf(x)
	noteHookRender(requireScope('useIsPending'), null)
	const [, force] = useReducer(forceReducer, 0)
	const pending = isPendingPassive(node, null)
	const shown = useRef(pending)
	shown.current = pending
	// Dispatch only when the boolean this hook shows would actually flip;
	// pokes and waves over-notify by design.
	const onNotify = useCallback(() => {
		// The flip escapes any ambient transition: an indicator scheduled
		// inside the transition it indicates would be held hostage by it.
		// React's own useTransition schedules isPending before the scope
		// for the same reason.
		if (isPendingPassive(node, null) !== shown.current) {
			dispatchUrgent(force)
		}
	}, [node])
	useEffect(() => observeNode(node, onNotify), [node, onNotify])
	return pending
}

/** What this root's screen shows for x (the per-root committed view). */
export function useCommitted<T>(x: Signal<T>): T {
	const node = nodeOf(x)
	const scope = requireScope('useCommitted')
	noteHookRender(scope, null)
	const [, force] = useReducer(forceReducer, 0)
	const snap = committedSnapshot(node, scope)
	const shown = useRef(snap)
	shown.current = snap
	// The committed snapshot has stable identity (a value, or a stable
	// error box), so Object.is is the whole comparison.
	const onNotify = useCallback(() => {
		if (!Object.is(committedSnapshot(node, scope), shown.current)) {
			force()
		}
	}, [node, scope])
	useEffect(() => observeNode(node, onNotify), [node, onNotify])
	if (isErrorBox(snap)) {
		throw snap.error
	}
	return snap as T
}

/**
 * A component-owned atom: created once on mount, garbage-collected after
 * unmount when the component's references to it drop.
 */
export function useAtom<T>(initial: T | (() => T), opts?: AtomOptions<T>): Atom<T> {
	const atomRef = useRef<Atom<T> | null>(null)
	atomRef.current ??= createAtom(initial, opts)
	return atomRef.current
}
