/**
 * React hooks over the engine.
 *
 * The subscribing read hook owns TWO channels:
 *
 * - Store channel (useSyncExternalStore): the snapshot is a subscription
 *   epoch — a stable identity, never a value — so equal resolutions never
 *   re-render and the store never "changes" during a transition. Drafts
 *   live in worlds, not in the store, which is what keeps React's
 *   transition machinery (holding, time slicing, interruption) intact.
 *
 * - Draft-lane channel (a per-hook reducer): when a transition writes a
 *   cell, exactly the subscribers of that cell (and of watched computeds
 *   over it) receive the draft id as a reducer dispatch inside the
 *   transition's own scope. React's update queues then decide visibility
 *   per pass: urgent passes skip the update (canonical), the transition's
 *   passes include it, rebased retries recompute it. The render value
 *   resolves the hook's own world — no context value ever changes, so a
 *   transition re-renders only the components its writes actually touch.
 *   Dispatches are deduped per hook per render window (see `delivered`
 *   below): a burst of writes to one cell costs each subscriber one
 *   dispatch, not one per write.
 */
import * as React from 'react';
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
} from '../index.ts';
import { Flag, observeNode, type ReactiveNode } from '../graph.ts';
import { resolveState, worldOf, type DraftId, type World } from '../worlds.ts';
import { type DerivedState, type ErrorBox, type Suspension } from '../asyncs.ts';
import { getActiveTracer } from '../tracer.ts';
import {
  correctSubscription,
  dispatchDraftWake,
  noteHookRender,
  renderPassIds,
} from './host.ts';
import { EMPTY_WORLD, ScopeContext, worldsReducer } from './scope.ts';

type AnyReadable = Signal<any> | Computed<any>;
type Readable<T> = Signal<T> | Computed<T>;

const NO_IDS: readonly DraftId[] = [];

const lastDelivered = new WeakMap<ReactiveNode, unknown>();
const NEVER = Symbol('never-delivered');

function traceDelivery(node: ReactiveNode, value: unknown): void {
  const prev = lastDelivered.has(node) ? lastDelivered.get(node) : NEVER;
  if (prev !== value) {
    lastDelivered.set(node, value);
    getActiveTracer()?.emit('deliver', node, node.causeEvent);
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
  const asyncBits = st.flags & Flag.AsyncMask;
  if (asyncBits === 0) return st.value;
  if (asyncBits === Flag.DerivedError) throw (st.throwable as ErrorBox).error;
  const suspension = st.throwable as Suspension;
  if (world.drafts.length > 0) throw suspension.promise;
  if (!isUninitialized(st.value)) return st.value; // settled history: stale serves
  throw suspension.promise;
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
 * Outside any SignalScope there is no world carrier: the hook renders the
 * canonical view and snapshots the canonical epoch, which counts silent
 * folds — their only delivery channel for committed transitions. Scoped
 * subscribers keep the silent-fold-blind epoch (render-pass worlds already
 * delivered those values), so no post-commit repair storm exists; the gap
 * for subscribers that attached late is closed by correctSubscription at
 * subscribe time.
 */
export function useValue<T>(x: Readable<T>): T {
  const node = nodeOf(x);
  const scope = React.useContext(ScopeContext);
  const scoped = scope !== null;
  const [hookWorld, wake] = React.useReducer(worldsReducer, EMPTY_WORLD);
  noteHookRender(scope, scoped ? hookWorld.ids : NO_IDS);
  const ids = scoped ? (renderPassIds(scope) ?? hookWorld.ids) : NO_IDS;
  // Draft ids delivered to this hook's reducer since its last render. The
  // dispatch is scheduling-only, so a repeat id adds nothing: it is already
  // sitting undelivered in this hook's queue and the pass that consumes it
  // resolves the world live, appends included. Cleared UNCONDITIONALLY each
  // render because a pass that consumed the draft ends the guarantee — a
  // later append must re-dispatch or React bails out and the transition
  // commits a stale frame. Over-clearing (abandoned pass, StrictMode double
  // render) only permits a redundant dispatch, which is harmless; writes
  // during render throw, so no delivery can race the clear.
  const delivered = React.useRef<Set<DraftId>>(new Set());
  delivered.current.clear();
  const deliver = React.useCallback(
    (id: DraftId) => {
      if (delivered.current.has(id)) return;
      delivered.current.add(id);
      dispatchDraftWake(id, wake);
    },
    [wake],
  );
  // One mutable stash per hook (not per render): what the latest completed
  // render resolved, for the subscribe-time repair check.
  const rendered = React.useRef<{ ids: readonly DraftId[]; value: unknown; live: boolean }>({
    ids: NO_IDS,
    value: undefined,
    live: false,
  });
  const subscribe = React.useCallback(
    (cb: () => void) => {
      const off = observeNode(node, cb, scope !== null ? deliver : undefined);
      // The subscription attaches at commit, after the render that created
      // it: repair anything that happened in between (live drafts this hook
      // missed, silent folds the epoch snapshot cannot see).
      if (scope !== null && rendered.current.live) {
        correctSubscription(node, rendered.current, scope, deliver, wake);
      }
      return off;
    },
    [node, scope, deliver, wake],
  );
  // Subscription epoch snapshots: reactEpoch changes exactly when scoped
  // committed-view subscribers must re-render; canonicalEpoch counts silent
  // draft folds too — the only channel for subscribers outside any scope.
  const epochSnap = React.useCallback(
    () => (scoped ? node.reactEpoch : node.canonicalEpoch),
    [node, scoped],
  );
  React.useSyncExternalStore(subscribe, epochSnap, epochSnap);
  const world = worldOf(ids);
  const st = resolveState(node, world);
  const value = unwrapState(st, world);
  const stash = rendered.current;
  stash.ids = ids;
  stash.value = value;
  stash.live = true;
  traceDelivery(node, value);
  return value as T;
}

/** A component-scoped computed (disposed by dropping; graph edges are
 * dependency-ward only, so unmount reclaims it structurally). */
export function useComputed<T>(fn: () => T, deps: readonly unknown[]): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const c = React.useMemo(() => computed(fn), deps as unknown[]);
  return useValue(c);
}

/** Engine effect bound to the component lifetime: observes canonical
 * (committed) values only, cleanup honored, StrictMode nets one. */
export function useSignalEffect(fn: () => void | (() => void)): void {
  React.useEffect(() => engineEffect(fn), []);
}

/** True while newer data exists behind the committed value of x: a pending
 * transition draft on it, or an async refetch behind stale. The snapshot is
 * world-independent (ambient pendingness) for the same reason as useValue's. */
export function useIsPending(x: AnyReadable): boolean {
  const node = nodeOf(x);
  noteHookRender(React.useContext(ScopeContext), null);
  const subscribe = React.useCallback((cb: () => void) => observeNode(node, cb), [node]);
  const snap = React.useCallback(() => isPendingPassive(node, null), [node]);
  return React.useSyncExternalStore(subscribe, snap, () => false);
}

/** What this root's screen shows for x (the per-root committed view). */
export function useCommitted<T>(x: Readable<T>): T {
  const node = nodeOf(x);
  const scope = React.useContext(ScopeContext);
  noteHookRender(scope, null);
  const container = scope?.container ?? undefined;
  const subscribe = React.useCallback((cb: () => void) => observeNode(node, cb), [node]);
  const committedSnap = React.useCallback(
    () => committedSnapshot(node, container),
    [node, container],
  );
  const snap = React.useSyncExternalStore(subscribe, committedSnap, committedSnap);
  if (isErrorBox(snap)) throw snap.error;
  return snap as T;
}

/** A component-owned atom: created once, reclaimed after unmount by
 * dropping (no registry needed — see the engine's ownership model). */
export function useAtom<T>(initial: T | (() => T), opts?: SignalOptions<T>): Signal<T> {
  const [atom] = React.useState(() => signal(initial, opts));
  return atom;
}
