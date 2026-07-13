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
 *   dispatched inside the transition's own context. React's update queues
 *   then decide visibility per pass: urgent passes skip the update and
 *   see base state, the transition's passes include it, rebased retries
 *   recompute it. Deduped per hook per render window (see `delivered`).
 *
 * - REPAIR_WAKE, meaning "re-render against current state". Sent when the
 *   engine notifies this subscriber and re-rendering would actually show
 *   it something different from what it rendered (resolutionDiffers in
 *   host.ts). Deduped per render window (see `repairPending`).
 *
 * Subscriptions attach in a layout effect, at commit time. The gap between
 * rendering and attaching — hydration's first commit is just the widest
 * such gap — is closed before paint by correctSubscription, which replays
 * missed drafts and compares the rendered resolution against current state.
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
	useSyncExternalStore,
} from 'react'
import {
	committedSnapshot,
	createAtom,
	createComputed,
	isPendingPassive,
	isUninitialized,
	nodeOf,
	type Atom,
	type AtomOptions,
	type Signal,
} from '../index.ts'
import { isErrorBox, type ErrorBox, type ResolvedState, type Suspension } from '../asyncs.ts'
import {
	Flag,
	NO_EVENT,
	activeWorldSourceConsumer,
	makeScheduledEffect,
	observeNode,
	type GraphChangeClock,
	type Link,
	type ProducerNode,
	type ScheduledEffect,
	type TraceEventId,
} from '../graph.ts'
import {
	committedWorldOf,
	BASE_WORLD,
	resolveState,
	trackWorldSources,
	withWorld,
	worldOf,
	type DraftId,
	type World,
} from '../worlds.ts'
import { getActiveTracer } from '../tracer.ts'
import {
	correctSubscription,
	dispatchDraftWake,
	dispatchUrgent,
	noteHookRender,
	renderPassIds,
	resolutionDiffers,
	REPAIR_WAKE,
	type ReactRootConnection,
	type RenderedResolution,
} from './host.ts'
import {
	EMPTY_WORLD,
	ReactRootConnectionContext,
	worldsReducer,
} from './SignalsFrameworkProvider.ts'

interface UseValueState {
	delivered: Set<DraftId>
	/** What the hook's most recent render resolved (committed or not). */
	rendered: RenderedResolution
	repairPending: boolean
	/** What the committed tree shows for this hook. Advances only in the
	 * layout effect, so a transition's speculative values never enter it
	 * while the transition is held. The notify predicate compares against
	 * this, which keeps folds silent when the committed tree already shows
	 * their values and keeps live appends from double-dispatching repairs. */
	committed: RenderedResolution
}

const NOOP = (): void => {}
const NO_STORE_SUBSCRIPTION = (): (() => void) => NOOP

interface SignalEffectState {
	effect: ScheduledEffect | null
	/** The connection whose committed world the installed watcher currently uses. */
	connection: ReactRootConnection | null
	/** The watcher owns dependency identity and edges. This is only its
	 * current link head plus parallel per-root committed values. */
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

function signalEffectValue(node: ProducerNode, world: World): unknown {
	const state = resolveState(node, world)
	if (activeWorldSourceConsumer !== null && (node.flags & Flag.KindComputed) !== 0) {
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
		if (!Object.is(signalEffectValue(link!.dep, world), state.dependencyValues[i])) {
			return true
		}
		link = link!.nextDep
	}
	return false
}

/** Dispose a scheduled effect and release every hook-side reference it
 * retained. Used both by React unmount and by the setup-throw path, where a
 * later cleanup hook in the same commit would never get a chance to mount. */
function disposeSignalEffect(state: SignalEffectState): void {
	const effect = state.effect
	const connection = state.connection
	try {
		if (effect !== null) {
			const world = connection === null ? null : committedWorldOf(connection)
			if (world === null || world.drafts.length === 0) {
				effect.dispose()
			} else {
				withWorld(world, () => effect.dispose())
			}
		}
	} finally {
		state.effect = null
		state.connection = null
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

/** These hooks cannot work without a SignalsFrameworkProvider. The root
 * connection carries transition worlds, and a subscriber without one has
 * no channel for them. Fail at the hook and name both supported fixes. */
function requireRootConnection(hook: string): ReactRootConnection {
	const connection = useContext(ReactRootConnectionContext)
	if (connection === null) {
		const error = new Error(
			`${hook} was rendered without a SignalsFrameworkProvider above it. ` +
				'Create roots with wrapCreateRoot(createRoot), or wrap the tree in <SignalsFrameworkProvider>.',
		)
		getActiveTracer()?.emit('policy-error', null, NO_EVENT, {
			error,
			phase: 'missing-provider',
		})
		throw error
	}
	return connection
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
function unwrapState(
	st: ResolvedState,
	world: World,
	connection: ReactRootConnection,
	node: ProducerNode,
): unknown {
	const asyncBits = st.flags & Flag.AsyncMask
	if (asyncBits === 0) {
		return st.value
	}
	if (asyncBits === Flag.AsyncError) {
		const error = (st.throwable as ErrorBox).error
		getActiveTracer()?.emit('render-error', node, node.causeEvent, { error, root: connection })
		throw error
	}
	const suspension = st.throwable as Suspension
	// Base-world refreshes keep serving settled history while pending.
	if (world.drafts.length === 0 && !isUninitialized(st.value)) {
		return st.value
	}
	// This render path is about to throw the suspension promise. The root
	// identifies the rendering connection; it does not claim that React catches
	// the promise, parks work, or schedules a retry.
	getActiveTracer()?.emit('render-suspend', node, NO_EVENT, {
		root: connection,
		suspension,
	})
	throw suspension.promise
}

/**
 * Read x and subscribe: the component re-renders whenever the value it
 * would show changes.
 *
 * The hook renders in a world chosen from React state: the pass's valid
 * note when the hook's connection wrote one (covering components that mount
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
	const connection = requireRootConnection('useValue')
	const [hookWorld, wake] = useReducer(worldsReducer, EMPTY_WORLD)
	const baseSnapshot = useCallback((): GraphChangeClock => {
		resolveState(node, BASE_WORLD)
		return node.changedAtGraphChange
	}, [node])
	// This subscription's only job is React's pre-commit snapshot check.
	// The engine watcher below owns notifications and transition scheduling.
	useSyncExternalStore(NO_STORE_SUBSCRIPTION, baseSnapshot, baseSnapshot)
	noteHookRender(connection, hookWorld.ids)
	const ids = renderPassIds(connection) ?? hookWorld.ids
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
		(id: DraftId, cause: TraceEventId) => {
			if (state.delivered.has(id)) {
				return
			}
			state.delivered.add(id)
			getActiveTracer()?.emit('draft-wake', node, cause, {
				draftId: id,
				root: connection,
			})
			dispatchDraftWake(id, wake)
		},
		[connection, node, state, wake],
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
		// The connection's first-child marker confirms before descendant layout
		// effects. During that narrow window this render is the one committing,
		// so compare against it directly; outside it, never trust speculative
		// render state over the last completed commit.
		const stash = connection.committing ? state.rendered : state.committed
		if (!stash.live || state.repairPending) {
			return
		}
		if (!resolutionDiffers(node, stash)) {
			return
		}
		state.repairPending = true
		wake(REPAIR_WAKE)
	}, [node, connection, state, wake])
	// Subscribe in a layout effect so correctSubscription repairs a value
	// that changed during a time-sliced mount before the frame can paint.
	useLayoutEffect(() => {
		const off = observeNode(node, onNotify, deliver)
		if (state.rendered.live) {
			correctSubscription(node, state.rendered, connection, deliver, wake)
		}
		return off
	}, [node, connection, state, deliver, wake, onNotify])
	const world = worldOf(ids)
	const st = resolveState(node, world)
	const value = unwrapState(st, world, connection, node)
	const stash = state.rendered
	stash.ids = ids
	stash.value = value
	stash.live = true
	const renderEvent =
		getActiveTracer()?.emit('render-value', node, node.causeEvent, {
			root: connection,
		}) ?? NO_EVENT
	// Advance the committed stash at commit time. No dependency array: the
	// effect runs on every commit with that render's resolution, and a
	// suspended render never reaches it.
	useLayoutEffect(() => {
		const c = state.committed
		c.ids = ids
		c.value = value
		c.live = true
		getActiveTracer()?.emit('deliver', node, renderEvent, { root: connection })
	})
	return value as T
}

/** A component-owned computed. No explicit disposal: an unwatched
 * computed only holds references toward its dependencies, so dropping it
 * at unmount makes it garbage-collectible. */
export function useComputed<T>(fn: () => T, deps: React.DependencyList): T {
	requireRootConnection('useComputed') // fail with this hook's name, not useValue's
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const c = useMemo(() => createComputed(fn), deps)
	return useValue(c)
}

function useSignalEffectImpl(
	fn: () => void | (() => void),
	usePhaseEffect: typeof useEffect,
	connection: ReactRootConnection,
): void {
	const [version, schedule] = useReducer(forceReducer, 0)
	const stateRef = useRef<SignalEffectState | null>(null)
	let state = stateRef.current
	if (state === null) {
		state = {
			effect: null,
			connection: null,
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
		const connectionChanged = state.connection !== connection
		const signalRequested = state.version !== version
		const rerunRequested = state.rerunRequested
		if (!connectionChanged && !signalRequested && !rerunRequested) {
			return
		}
		state.connection = connection
		state.version = version
		state.rerunRequested = false
		const world = committedWorldOf(connection)
		if (
			!connectionChanged &&
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
				const committedConnection = state.connection
				if (committedConnection !== null && state.effect !== null) {
					const changed = state.effect.refresh(() =>
						signalEffectDependenciesChanged(state, committedWorldOf(committedConnection)),
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
			for (let link = state.dependencies; link !== undefined; link = link.nextDep) {
				state.dependencyValues[count] = signalEffectValue(link.dep, world)
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
	useSignalEffectImpl(fn, useEffect, requireRootConnection('useSignalEffect'))
}

/** Run a tracked signal effect during React's layout-effect phase. */
export function useSignalLayoutEffect(fn: () => void | (() => void)): void {
	useSignalEffectImpl(fn, useLayoutEffect, requireRootConnection('useSignalLayoutEffect'))
}

/** True while newer data exists behind the committed value of x: a
 * pending transition draft on it, or an async refetch loading behind a
 * stale value. */
export function useIsPending(x: Signal<any>): boolean {
	const node = nodeOf(x)
	noteHookRender(requireRootConnection('useIsPending'), null)
	const subscribe = useCallback(
		(notify: () => void) =>
			observeNode(node, () => {
				// The flip escapes any ambient transition: an indicator scheduled
				// inside the transition it indicates would be held hostage by it.
				// React's own useTransition schedules isPending before entering the
				// transition for the same reason.
				dispatchUrgent(notify)
			}),
		[node],
	)
	const getSnapshot = useCallback(() => isPendingPassive(node, null), [node])
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** What this root's screen shows for x (the per-root committed view). */
export function useCommitted<T>(x: Signal<T>): T {
	const node = nodeOf(x)
	const connection = requireRootConnection('useCommitted')
	noteHookRender(connection, null)
	const [, force] = useReducer(forceReducer, 0)
	const snap = committedSnapshot(node, connection)
	const shown = useRef(snap)
	shown.current = snap
	// The committed snapshot has stable identity (a value, or a stable
	// error box), so Object.is is the whole comparison.
	const onNotify = useCallback(() => {
		if (!Object.is(committedSnapshot(node, connection), shown.current)) {
			force()
		}
	}, [node, connection])
	useLayoutEffect(() => {
		let notified = false
		const off = observeNode(node, () => {
			notified = true
			onNotify()
		})
		if (!notified) {
			onNotify()
		}
		return off
	}, [node, onNotify])
	if (isErrorBox(snap)) {
		getActiveTracer()?.emit('render-error', node, node.causeEvent, {
			error: snap.error,
			root: connection,
		})
		throw snap.error
	}
	return snap as T
}

/** A component-owned atom: created once on mount, garbage-collected after
 * unmount when the component's references to it drop. */
export function useAtom<T>(initial: T | (() => T), opts?: AtomOptions<T>): Atom<T> {
	const atomRef = useRef<Atom<T> | null>(null)
	atomRef.current ??= createAtom(initial, opts)
	return atomRef.current
}
