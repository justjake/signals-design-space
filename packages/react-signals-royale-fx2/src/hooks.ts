/**
 * React hooks over the engine.
 *
 * The subscribing read hook resolves the render pass's world (from
 * SignalScope state) and subscribes through useSyncExternalStore. The
 * subscription snapshot is a stable identity key — the resolved value for
 * plain values, the episode for pending spans, the error box for failures —
 * so equal resolutions never re-render and the store never "changes" during
 * a transition (which is exactly what keeps React's transition holding
 * behavior intact: transition drafts live in worlds, not in the store).
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
import { captureRenderDispatcher } from './host.ts';
import { ContainerContext, WorldContext } from './scope.ts';

type AnyReadable = Signal<any> | Computed<any>;
type Readable<T> = Signal<T> | Computed<T>;

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
function unwrapForRender(x: AnyReadable, ids: readonly DraftId[]): unknown {
  const env: Envelope = engine.resolveEnvelope(x, ids);
  if (env.kind === 'value') return env.value;
  if (env.kind === 'error') throw env.box.error;
  if (engine.hasLiveDrafts(ids)) throw env.episode.promise;
  if (env.stale) return env.value;
  throw env.episode.promise;
}

/**
 * Subscribing read hook: resolves this render pass's world.
 *
 * The useSyncExternalStore snapshot is deliberately WORLD-INDEPENDENT — the
 * engine's subscription epoch, not a value. React compares snapshots to
 * detect store mutations: a per-world snapshot would read as a mutation
 * during every transition pass (demoting the transition to a synchronous
 * render), and a committed-value snapshot would read as a mutation right
 * AFTER every transition commit (a synchronous repair render of every
 * subscriber). The epoch advances exactly when committed-view subscribers
 * must re-render: urgent canonical changes, settlements, rollbacks — while
 * values a transition already delivered through render-pass worlds fold
 * silently. The render VALUE resolves the pass's own world from context.
 */
export function useValue<T>(x: Readable<T>): T {
  captureRenderDispatcher();
  const world = React.useContext(WorldContext);
  engine.setRenderWorld(world.ids);
  const subscribe = React.useCallback((cb: () => void) => engine.subscribe(x as AnyReadable, cb), [x]);
  const epochSnap = React.useCallback(() => engine.epochSnapshot(x as AnyReadable), [x]);
  React.useSyncExternalStore(subscribe, epochSnap, epochSnap);
  const value = unwrapForRender(x as AnyReadable, world.ids) as T;
  traceDelivery(x as AnyReadable, value);
  return value;
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
  captureRenderDispatcher();
  const subscribe = React.useCallback((cb: () => void) => engine.subscribe(x as AnyReadable, cb), [x]);
  const snap = React.useCallback(() => engine.isPendingIn(x as AnyReadable, null), [x]);
  return React.useSyncExternalStore(subscribe, snap, () => false);
}

/** What this root's screen shows for x (the per-root committed view). */
export function useCommitted<T>(x: Readable<T>): T {
  captureRenderDispatcher();
  const container = React.useContext(ContainerContext);
  const subscribe = React.useCallback((cb: () => void) => engine.subscribe(x as AnyReadable, cb), [x]);
  const committedSnap = React.useCallback(
    () => engine.committedSnapshot(x as AnyReadable, container ?? undefined),
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
