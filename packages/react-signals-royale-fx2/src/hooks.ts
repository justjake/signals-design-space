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
 */
import * as React from 'react';
import {
  computed,
  effect as engineEffect,
  signal,
  reactIntegration as engine,
  type Computed,
  type DraftId,
  type Envelope,
  type Signal,
  type SignalOptions,
} from 'signals-royale-fx2';
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

const lastDelivered = new WeakMap<object, unknown>();
const NEVER = Symbol('never-delivered');

function traceDelivery(x: AnyReadable, value: unknown): void {
  const prev = lastDelivered.has(x) ? lastDelivered.get(x) : NEVER;
  if (prev !== value) {
    lastDelivered.set(x, value);
    engine.trace('deliver', x, engine.causeOf(x));
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
function unwrapEnvelope(env: Envelope, ids: readonly DraftId[]): unknown {
  if (env.kind === 'value') return env.value;
  if (env.kind === 'error') throw env.box.error;
  if (engine.hasLiveDrafts(ids)) throw env.suspension.promise;
  if (env.stale) return env.value;
  throw env.suspension.promise;
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
  const scope = React.useContext(ScopeContext);
  const scoped = scope !== null;
  const [hookWorld, wake] = React.useReducer(worldsReducer, EMPTY_WORLD);
  noteHookRender(scope, scoped ? hookWorld.ids : NO_IDS);
  const ids = scoped ? (renderPassIds(scope) ?? hookWorld.ids) : NO_IDS;
  // One mutable stash per hook (not per render): what the latest completed
  // render resolved, for the subscribe-time repair check.
  const rendered = React.useRef<{ ids: readonly DraftId[]; value: unknown; live: boolean }>({
    ids: NO_IDS,
    value: undefined,
    live: false,
  });
  const subscribe = React.useCallback(
    (cb: () => void) => {
      const off = engine.subscribe(
        x as AnyReadable,
        cb,
        scope !== null ? (id) => dispatchDraftWake(id, wake) : undefined,
      );
      // The subscription attaches at commit, after the render that created
      // it: repair anything that happened in between (live drafts this hook
      // missed, silent folds the epoch snapshot cannot see).
      if (scope !== null && rendered.current.live) {
        correctSubscription(x, rendered.current, scope, wake);
      }
      return off;
    },
    [x, scope, wake],
  );
  const epochSnap = React.useCallback(
    () =>
      scoped
        ? engine.epochSnapshot(x as AnyReadable)
        : engine.canonicalEpochSnapshot(x as AnyReadable),
    [x, scoped],
  );
  React.useSyncExternalStore(subscribe, epochSnap, epochSnap);
  const env = engine.resolveEnvelope(x as AnyReadable, ids);
  const value = unwrapEnvelope(env, ids);
  const stash = rendered.current;
  stash.ids = ids;
  stash.value = value;
  stash.live = true;
  traceDelivery(x as AnyReadable, value);
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
  noteHookRender(React.useContext(ScopeContext), null);
  const subscribe = React.useCallback((cb: () => void) => engine.subscribe(x as AnyReadable, cb), [x]);
  const snap = React.useCallback(() => engine.isPendingIn(x as AnyReadable, null), [x]);
  return React.useSyncExternalStore(subscribe, snap, () => false);
}

/** What this root's screen shows for x (the per-root committed view). */
export function useCommitted<T>(x: Readable<T>): T {
  const scope = React.useContext(ScopeContext);
  noteHookRender(scope, null);
  const container = scope?.container ?? undefined;
  const subscribe = React.useCallback((cb: () => void) => engine.subscribe(x as AnyReadable, cb), [x]);
  const committedSnap = React.useCallback(
    () => engine.committedSnapshot(x as AnyReadable, container),
    [x, container],
  );
  const snap = React.useSyncExternalStore(subscribe, committedSnap, committedSnap);
  if (snap !== null && typeof snap === 'object' && 'engineErrorBox' in (snap as object)) {
    throw (snap as { engineErrorBox: unknown }).engineErrorBox;
  }
  return snap as T;
}

/** A component-owned atom: created once, reclaimed after unmount by
 * dropping (no registry needed — see the engine's ownership model). */
export function useAtom<T>(initial: T | (() => T), opts?: SignalOptions<T>): Signal<T> {
  const [atom] = React.useState(() => signal(initial, opts));
  return atom;
}
