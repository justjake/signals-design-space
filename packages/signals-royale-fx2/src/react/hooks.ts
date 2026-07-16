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
	captureOwnerStack,
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
	createAtom,
	createComputed,
	effect,
	isPendingPassive,
	isUninitialized,
	nodeOf,
	type Atom,
	type AtomOptions,
	type EqualsFn,
	type Signal,
	type SignalValues,
	type UseFn,
} from '../index.ts'
import { type ErrorBox, type ResolvedState, type Suspension } from '../asyncs.ts'
import {
	currentCause,
	emitEvent,
	Flag,
	NO_EVENT,
	observeNode,
	type GraphChangeClock,
	type ProducerNode,
	type RenderWatcherNode,
	type TraceEventId,
} from '../graph.ts'
import { BASE_WORLD, resolveState, worldOf, type DraftId, type World } from '../worlds.ts'
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
	/**
	 * Trace id of the 'notify' whose dispatch the next base-world render
	 * answers; that render is caused by it and consumes it. NO_EVENT when
	 * nothing scheduled the render (mount, a parent-driven pass).
	 */
	notifyEvent: TraceEventId
	/**
	 * Trace id of the latest 'transition-notify' delivered to this hook.
	 * Draft-world renders chain to it without consuming it: a transition
	 * re-renders its passes (suspend, rebase, retry) and every pass answers
	 * the same wake.
	 */
	draftNotifyEvent: TraceEventId
	/** Best-effort React component name that owns this hook, for labeling the
	 * watcher in the devtools; captured once, only when a tracer is attached. */
	watcherLabel: string | undefined
	/** The engine watcher node this hook subscribes with, once its layout effect
	 * has run. notify/render/transition-notify are recorded against it — we
	 * deliver to watchers, so those events belong to this component's
	 * subscription, not the producer it watches. undefined before the first
	 * subscription: the mount render falls back to the node. */
	watcher: RenderWatcherNode | undefined
	/**
	 * What the committed tree shows for this hook. Advances only in the
	 * layout effect, so a transition's speculative values never enter it
	 * while the transition is held. The notify predicate compares against
	 * this, which keeps folds silent when the committed tree already shows
	 * their values and keeps live appends from double-dispatching repairs.
	 */
	committed: RenderedResolution
}

const NOOP = (): void => {}
const NO_STORE_SUBSCRIPTION = (): (() => void) => NOOP

const NO_IDS: readonly DraftId[] = []

/** Best-effort React component name that owns the current hook, for labeling
 * its watcher in the devtools. Read once at mount and only when a tracer is
 * attached. Prefers React 19's captureOwnerStack() — the same owner-component
 * stack React uses for error/warning stacks — and falls back to a raw stack on
 * older React. Minified builds mangle names; a manual label always wins. */
function renderingComponentName(): string | undefined {
	let stack: string | null | undefined
	try {
		stack = typeof captureOwnerStack === 'function' ? captureOwnerStack() : null
	} catch {
		stack = null
	}
	// captureOwnerStack lists owner components directly; the raw fallback also
	// has this helper + hook frames, which the filter below skips.
	if (stack == null || stack === '') stack = new Error().stack
	if (stack == null) return undefined
	for (const line of stack.split('\n')) {
		const m = line.match(/^\s*at (\w+)/)
		if (m === null) continue
		const name = m[1]
		if (name === 'renderingComponentName' || name.startsWith('use') || name === 'Object') continue
		if (/^[A-Z]/.test(name)) return name
	}
	return undefined
}

/**
 * These hooks cannot work without a SignalsFrameworkProvider. The root
 * connection carries transition worlds, and a subscriber without one has
 * no channel for them. Fail at the hook and name both supported fixes.
 */
function requireRootConnection(hook: string): ReactRootConnection {
	const connection = useContext(ReactRootConnectionContext)
	if (connection === null) {
		const error = new Error(
			`${hook} was rendered without a SignalsFrameworkProvider above it. ` +
				'Create roots with wrapCreateRoot(createRoot), or wrap the tree in <SignalsFrameworkProvider>.',
		)
		emitEvent?.('policy-error', null, NO_EVENT, {
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
		emitEvent?.('render-error', node, node.causeEvent, { error, root: connection })
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
	emitEvent?.('render-suspend', node, NO_EVENT, {
		root: connection,
		suspension,
	})
	throw suspension.promise
}

/**
 * Read x and subscribe: the component re-renders whenever the value it
 * would show changes.
 *
 * Implementation notes. The hook picks which snapshot to render from
 * React state, so it can never run ahead of the pass:
 * - when this root's provider noted a snapshot for the current pass, the
 *   hook uses that — it covers components that mount in the middle of a
 *   transition pass, whose own reducers never received the write-time
 *   dispatch;
 * - otherwise the hook uses its own reducer state.
 * A committed transition costs no extra renders by construction:
 * resolutionDiffers compares against what this hook rendered, and a fold
 * whose values were already delivered through render passes compares
 * equal. The gap for subscribers that attached late is closed by
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
			notifyEvent: NO_EVENT,
			draftNotifyEvent: NO_EVENT,
			// Capture the owning component's name once, only when tracing is on.
			watcherLabel: emitEvent !== null ? renderingComponentName() : undefined,
			watcher: undefined,
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
			state.draftNotifyEvent =
				emitEvent?.('transition-notify', state.watcher ?? node, cause, {
					draftId: id,
					root: connection,
				}) ?? NO_EVENT
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
	const onNotify = useCallback(
		(cause: TraceEventId) => {
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
			// The state change that woke this watcher (the write/settle/fold the
			// invalidation stamped) causes the notify; the render this dispatch
			// produces is caused by the notify in turn.
			state.notifyEvent = emitEvent?.('notify', state.watcher ?? node, cause, { root: connection }) ?? NO_EVENT
			wake(REPAIR_WAKE)
		},
		[node, connection, state, wake],
	)
	// Subscribe in a layout effect so correctSubscription repairs a value
	// that changed during a time-sliced mount before the frame can paint.
	useLayoutEffect(() => {
		const off = observeNode(node, onNotify, deliver, state.watcherLabel)
		state.watcher = off.watcher
		if (state.rendered.live) {
			correctSubscription(node, state.rendered, connection, deliver, wake)
		}
		return () => {
			state.watcher = undefined
			off()
		}
	}, [node, connection, state, deliver, wake, onNotify])
	const world = worldOf(ids)
	const st = resolveState(node, world)
	const value = unwrapState(st, world, connection, node)
	const stash = state.rendered
	stash.ids = ids
	stash.value = value
	stash.live = true
	if (emitEvent !== null) {
		// A draft-world render is caused by the transition-notify that woke
		// this hook; a base-world render consumes and answers the notify that
		// scheduled it. A render nothing scheduled (mount, a parent-driven
		// pass) roots at the node's last recorded state change — never at
		// another render.
		let renderCause: TraceEventId
		if (world.drafts.length !== 0) {
			renderCause = state.draftNotifyEvent
		} else {
			renderCause = state.notifyEvent
			state.notifyEvent = NO_EVENT
		}
		if (renderCause === NO_EVENT) {
			renderCause = node.causeEvent !== NO_EVENT ? node.causeEvent : currentCause
		}
		emitEvent('render', state.watcher ?? node, renderCause, { root: connection })
	}
	// Advance the committed stash at commit time. No dependency array: the
	// effect runs on every commit with that render's resolution, and a
	// suspended render never reaches it.
	useLayoutEffect(() => {
		const c = state.committed
		c.ids = ids
		c.value = value
		c.live = true
	})
	return value as T
}

/**
 * A component-owned computed. No explicit disposal: an unwatched
 * computed only holds references toward its dependencies, so dropping it
 * at unmount makes it garbage-collectible.
 */
export function useComputed<T>(fn: () => T, deps: React.DependencyList): T {
	requireRootConnection('useComputed') // fail with this hook's name, not useValue's
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const c = useMemo(() => createComputed(fn), deps)
	return useValue(c)
}

/**
 * Everything a spec's `watch` can be: a compute function, a signal, a
 * tuple of signals, or a record of signals — the same shapes
 * {@link effect} accepts as its first argument.
 */
export type WatchSource =
	| ((use: UseFn, previous: any) => unknown)
	| Signal<any>
	| readonly Signal<any>[]
	| Record<string, Signal<any>>

/** The value a watch source delivers to run(). */
export type WatchValue<S> = S extends (use: UseFn, previous: any) => infer T
	? T
	: S extends Signal<infer V>
		? V
		: S extends readonly Signal<any>[] | Record<string, Signal<any>>
			? SignalValues<S>
			: never

/**
 * One component-owned signal effect, as built by the factory passed to
 * useSignalEffect or useSignalLayoutEffect. Which hook runs the factory
 * decides the schedule; everything else is described per field.
 */
export interface SignalEffectSpec<S extends WatchSource> {
	/**
	 * What the effect reacts to. One of:
	 * - a compute function: tracked while it runs, so the signals it read
	 *   — and only those — become dependencies, branch by branch;
	 * - a signal: shorthand for a compute that reads it;
	 * - a tuple or record of signals: shorthand for a compute that reads
	 *   each one into a same-shaped tuple or record of values.
	 * These are the same shapes {@link effect} accepts as its first
	 * argument.
	 */
	watch: S
	/**
	 * What the effect does: called with the watched value and the previous
	 * value it handled (undefined on the first call). May return a cleanup,
	 * which runs before the next call and when the effect is disposed.
	 * Reads inside run() are not tracked — a value the effect should react
	 * to belongs in `watch`.
	 */
	run: (value: WatchValue<S>, previous: WatchValue<S> | undefined) => void | (() => void)
	/**
	 * Delivery cutoff; defaults to Object.is, or the package's
	 * `shallowEquals` for tuple and record watches.
	 */
	equals?: EqualsFn<WatchValue<S>>
	/** Debug name shown in trace output. */
	label?: string
}

/**
 * The component-owned effect. The factory runs inside the matching React
 * phase on mount and on every deps change — disposing the previous
 * effect first, exactly useEffect's re-create cycle, so captures are
 * always deps-fresh and `previous` restarts at undefined. One closure
 * carries every capture, so react-hooks/exhaustive-deps checks the whole
 * spec against deps once these hooks are listed in `additionalHooks`.
 * Both hooks observe base state and therefore need no provider.
 */
function useSignalPhaseEffect(
	usePhaseEffect: typeof useEffect,
	schedule: 'useLayoutEffect' | 'useEffect',
	create: () => SignalEffectSpec<any>,
	deps: React.DependencyList,
): void {
	usePhaseEffect(() => {
		const spec = create()
		return effect(spec.watch, spec.run, { equals: spec.equals, label: spec.label, schedule })
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, deps)
}

/**
 * Run a side effect when watched signals change, without re-rendering
 * this component. The factory you pass works like a useEffect body: it
 * runs on mount and again whenever `deps` change (cleaning up the effect
 * it previously built), and returns what to watch and what to run:
 *
 * ```tsx
 * useSignalEffect(() => ({
 *   watch: query,                 // or [a, b], {a, b}, () => a.get() + b.get()
 *   run: (q) => { analytics.pageView(q) },
 * }), [])
 * ```
 *
 * Captured props and state belong in `deps`, exactly as with useEffect.
 * When a watched signal changes, `run` executes alongside the useEffect
 * callbacks of the React update that change caused — off the critical
 * path of the frame.
 */
export function useSignalEffect<const S extends WatchSource>(
	create: () => SignalEffectSpec<S>,
	deps: React.DependencyList,
): void {
	useSignalPhaseEffect(useEffect, 'useEffect', create, deps)
}

/**
 * Run a DOM-touching side effect when watched signals change, without
 * re-rendering this component. The factory you pass works like a
 * useLayoutEffect body: it runs on mount and again whenever `deps`
 * change (cleaning up the effect it previously built), and returns what
 * to watch and what to run:
 *
 * ```tsx
 * useSignalLayoutEffect(() => ({
 *   watch: query,                 // or [a, b], {a, b}, () => a.get() + b.get()
 *   run: (q) => { el.textContent = q },
 * }), [el])
 * ```
 *
 * Captured props and state belong in `deps`, exactly as with
 * useLayoutEffect. When a watched signal changes, `run` executes in the
 * layout phase of the React update that change caused — after React has
 * applied its own DOM updates, before the browser paints — so DOM reads
 * and writes in `run` land in the same frame as React's output.
 */
export function useSignalLayoutEffect<const S extends WatchSource>(
	create: () => SignalEffectSpec<S>,
	deps: React.DependencyList,
): void {
	useSignalPhaseEffect(useLayoutEffect, 'useLayoutEffect', create, deps)
}

/**
 * True while newer data exists behind the committed value of x:
 * - a transition draft with writes over x is still pending, or
 * - an async computed is loading again while its previous settled value
 *   keeps serving.
 */
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

/**
 * A component-owned atom: created once on mount, garbage-collected after
 * unmount when the component's references to it drop.
 */
export function useAtom<T>(initial: T | (() => T), opts?: AtomOptions<T>): Atom<T> {
	const atomRef = useRef<Atom<T> | null>(null)
	atomRef.current ??= createAtom(initial, opts)
	return atomRef.current
}
