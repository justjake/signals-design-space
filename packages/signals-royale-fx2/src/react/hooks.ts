/**
 * React hooks over the engine.
 *
 * ONE notification channel: every wake is a dispatch into the hook's own
 * reducer, so every re-render gets its lane from the dispatch context —
 * exactly useState's semantics. A base write in a click handler renders
 * synchronously before paint; the same write from a timeout or a promise
 * renders at default priority (and may land after a paint — flushSync is
 * the escape hatch, as for any React state); a drafted write dispatches
 * inside its owning transition and renders in that transition's passes.
 *
 * Two message kinds flow through the reducer:
 *
 * - Draft ids: when a transition writes a cell, exactly the subscribers of
 *   that cell (and of watched computeds over it) receive the draft id,
 *   dispatched inside the transition's own scope. React's update queues
 *   decide visibility per pass: urgent passes skip the update (base
 *   state), the transition's passes include it, rebased retries recompute
 *   it. Deduped per hook per render window (see `delivered`).
 *
 * - REPAIR_WAKE: "re-render against current state". Sent by the
 *   render-notify predicate (resolutionDiffers in host.ts) when the engine
 *   notifies this subscriber AND re-rendering would actually show it
 *   something different from what it rendered — the per-subscriber compare
 *   that replaces both a store-version snapshot and any global silent-fold
 *   suppression. Deduped per render window (see `repairPending`).
 *
 * Subscriptions attach in a passive effect (commit time). The gap between
 * rendering and attaching — including hydration, whose first commit is just
 * the widest such gap — is closed by correctSubscription, which replays
 * missed drafts and compares the rendered resolution against current state.
 */
import * as React from 'react'
import {
	computed,
	committedSnapshot,
	effect as engineEffect,
	isErrorBox,
	isPendingPassive,
	isUninitialized,
	nodeOf,
	signal,
	type Computed,
	type Signal,
	type SignalOptions,
} from '../index.ts'
import { Flag, observeNode, type ReactiveNode } from '../graph.ts'
import { resolveState, worldOf, type DraftId, type World } from '../worlds.ts'
import { type DerivedState, type ErrorBox, type Suspension } from '../asyncs.ts'
import { getActiveTracer } from '../tracer.ts'
import {
	correctSubscription,
	dispatchDraftWake,
	dispatchUrgent,
	noteHookRender,
	renderPassIds,
	resolutionDiffers,
	REPAIR_WAKE,
	type ProviderRecord,
	type RenderedResolution,
} from './host.ts'
import { EMPTY_WORLD, ScopeContext, worldsReducer } from './scope.ts'

type AnyReadable = Signal<any> | Computed<any>
type Readable<T> = Signal<T> | Computed<T>

interface UseValueState {
	delivered: Set<DraftId>
	rendered: RenderedResolution
	repairPending: boolean
	/** What the committed tree shows. Advances only in the layout effect, so
	 * a held transition's speculative values stay in the draft channel. This
	 * makes folds silent when the carrier already shows their values and keeps
	 * live appends from double-dispatching repairs. */
	committed: RenderedResolution
}

const NO_IDS: readonly DraftId[] = []

function forceReducer(count: number): number {
	return count + 1
}

/** The hooks have no mode without a SignalScope: the scope is the world
 * carrier, and a subscriber without one would have no channel for
 * transition worlds at all. Rendering a scope-consuming hook outside a
 * scope is a wiring error — fail loudly, at the hook, naming the fixes. */
function requireScope(hook: string): ProviderRecord {
	const scope = React.useContext(ScopeContext)
	if (scope === null) {
		throw new Error(
			`${hook} was rendered without a SignalScope above it. ` +
				'Create roots with wrapCreateRoot(createRoot), or wrap the tree in <SignalScope>.',
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
 * The two-level suspend-vs-stale rule at the React boundary:
 * - a transition render (its world carries live drafts) hands React the
 *   pending thenable — the transition holds, previous UI stays;
 * - an urgent render with settled history serves the stale value
 *   (useIsPending is the indicator; no fallback flash);
 * - a never-settled value suspends everywhere.
 */
function unwrapState(st: DerivedState, world: World): unknown {
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
 * Subscribing read hook.
 *
 * Render world = the pass's valid note when the hook's scope wrote one
 * (covers components mounting inside a transition pass, whose reducers
 * never received the write-time dispatch), else the hook's own reducer
 * state. Both come from React state for THIS pass, so neither can run
 * ahead of it.
 *
 * Silent folds cost no renders by construction: the render-notify
 * predicate resolves in the world this hook RENDERED, and a fold whose
 * values were already delivered through render-pass worlds compares equal.
 * The gap for subscribers that attached late is closed by
 * correctSubscription at subscribe time.
 */
export function useValue<T>(x: Readable<T>): T {
	const node = nodeOf(x)
	const scope = requireScope('useValue')
	const [hookWorld, wake] = React.useReducer(worldsReducer, EMPTY_WORLD)
	noteHookRender(scope, hookWorld.ids)
	const ids = renderPassIds(scope) ?? hookWorld.ids
	// One record per hook owns the delivery/repair protocol. Initialize it
	// explicitly because useRef evaluates a non-primitive initializer every
	// render even though React consumes that value only on mount.
	const stateRef = React.useRef<UseValueState | null>(null)
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
	// Draft ids delivered to this hook's reducer since its last render. The
	// dispatch is scheduling-only, so a repeat id adds nothing: it is already
	// sitting undelivered in this hook's queue and the pass that consumes it
	// resolves the world live, appends included. Cleared UNCONDITIONALLY each
	// render because a pass that consumed the draft ends the guarantee — a
	// later append must re-dispatch or React bails out and the transition
	// commits a stale frame. Over-clearing (abandoned pass, StrictMode double
	// render) only permits a redundant dispatch, which is harmless; writes
	// during render throw, so no delivery can race the clear.
	state.delivered.clear()
	const deliver = React.useCallback(
		(id: DraftId) => {
			if (state.delivered.has(id)) {
				return
			}
			state.delivered.add(id)
			dispatchDraftWake(id, wake)
		},
		[state, wake],
	)
	// Base-channel dedup: at most one REPAIR_WAKE per render window, cleared
	// with `delivered` under the same reasoning (a pending dispatch already
	// guarantees a re-render against current state).
	state.repairPending = false
	// Render-notify delivery: the engine says "something over your sources
	// moved" (a base wave, a poke, a fold); the predicate answers "would the
	// committed tree show anything different if re-rendered now?". The
	// dispatch inherits the ambient lane — exactly useState's semantics for
	// the write that caused it.
	const onNotify = React.useCallback(() => {
		const stash = state.committed
		if (!stash.live || state.repairPending) {
			return
		}
		if (!resolutionDiffers(node, stash)) {
			return
		}
		state.repairPending = true
		wake(REPAIR_WAKE)
	}, [node, state, wake])
	// Subscribe in a passive effect (commit time) — the constant-snapshot
	// remnant of useSyncExternalStore is exactly this effect, so the effect
	// is used directly. correctSubscription closes the render→attach gap.
	React.useEffect(() => {
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
	// Commit-sync the committed stash (no deps: runs on every commit, with
	// this render's resolution; a suspended render never reaches it).
	React.useLayoutEffect(() => {
		const c = state.committed
		c.ids = ids
		c.value = value
		c.live = true
	})
	traceDelivery(node, value)
	return value as T
}

/** A component-scoped computed (disposed by dropping; graph edges are
 * dependency-ward only, so unmount reclaims it structurally). */
export function useComputed<T>(fn: () => T, deps: readonly unknown[]): T {
	requireScope('useComputed') // fail with this hook's name, not useValue's
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const c = React.useMemo(() => computed(fn), deps as unknown[])
	return useValue(c)
}

/** Engine effect bound to the component lifetime: observes base
 * (committed) values only, cleanup honored, StrictMode nets one. */
export function useSignalEffect(fn: () => void | (() => void)): void {
	React.useEffect(() => engineEffect(fn), [])
}

/** True while newer data exists behind the committed value of x: a pending
 * transition draft on it, or an async refetch behind stale. The snapshot is
 * world-independent (ambient pendingness) for the same reason as useValue's. */
export function useIsPending(x: AnyReadable): boolean {
	const node = nodeOf(x)
	noteHookRender(requireScope('useIsPending'), null)
	const [, force] = React.useReducer(forceReducer, 0)
	const pending = isPendingPassive(node, null)
	const shown = React.useRef(pending)
	shown.current = pending
	// Predicate wake: dispatch only when the boolean this hook shows would
	// actually flip (pokes and waves over-notify by design).
	const onNotify = React.useCallback(() => {
		// The flip escapes any ambient transition: an indicator scheduled
		// inside the transition it indicates would be held by it (React's own
		// useTransition schedules isPending before the scope for this reason).
		if (isPendingPassive(node, null) !== shown.current) {
			dispatchUrgent(force)
		}
	}, [node])
	React.useEffect(() => observeNode(node, onNotify), [node, onNotify])
	return pending
}

/** What this root's screen shows for x (the per-root committed view). */
export function useCommitted<T>(x: Readable<T>): T {
	const node = nodeOf(x)
	const scope = requireScope('useCommitted')
	noteHookRender(scope, null)
	const container = scope.container ?? undefined
	const [, force] = React.useReducer(forceReducer, 0)
	const snap = committedSnapshot(node, container)
	const shown = React.useRef(snap)
	shown.current = snap
	// Predicate wake: the committed snapshot has stable identity (values, or
	// a stable error box), so Object.is is the whole compare.
	const onNotify = React.useCallback(() => {
		if (!Object.is(committedSnapshot(node, container), shown.current)) {
			force()
		}
	}, [node, container])
	React.useEffect(() => observeNode(node, onNotify), [node, onNotify])
	if (isErrorBox(snap)) {
		throw snap.error
	}
	return snap as T
}

/** A component-owned atom: created once, reclaimed after unmount by
 * dropping (no registry needed — see the engine's ownership model). */
export function useAtom<T>(initial: T | (() => T), opts?: SignalOptions<T>): Signal<T> {
	const atomRef = React.useRef<Signal<T> | null>(null)
	atomRef.current ??= signal(initial, opts)
	return atomRef.current
}
