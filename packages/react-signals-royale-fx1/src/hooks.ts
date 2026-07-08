/**
 * React hooks over the engine.
 *
 * A subscribing hook resolves its render pass's world (the engine frame the
 * runtime opened when React started the pass), renders that world's value,
 * and claims its engine subscription in a commit effect with post-subscribe
 * fixup — a write that lands between render and claim re-delivers. Deliveries
 * arrive as reducer bumps dispatched by the runtime under the right lane, so
 * the component re-renders in exactly the batch that owns the change.
 */
import * as React from 'react';
import {
  Cell,
  Derived,
  Failure,
  Pending,
  SUB_NEVER,
  committed,
  isPending,
  peekSlot,
  registerSubRoot,
  renderRead,
  subscribe,
  unregisterSubRoot,
  effect as engineEffect,
  atom as createAtom,
  computed as createComputed,
  episodeAffects,
  openEpisodesSnapshot,
  trace,
  type AtomOptions,
  type Equality,
  type Use,
} from 'signals-royale-fx1';
import {
  currentEpisode,
  currentRenderFrame,
  deliver,
  startTransitionWrite,
  type HostSub,
} from './runtime';

type AnyNode = Cell<unknown> | Derived<unknown>;

const bumpReducer = (n: number): number => n + 1;

interface HookSubState {
  sub: HostSub;
  dispose: (() => void) | null;
  renderedSlot: unknown;
  renderedCells: Set<Cell<unknown>> | null;
}

function makeSub(node: AnyNode, bump: () => void, probe: boolean): HostSub {
  return {
    node,
    rootKey: null,
    snapshot: SUB_NEVER,
    cells: null,
    probe,
    lastPending: undefined,
    causeId: 0,
    bump,
  };
}

/** Apply the two-level suspend-vs-stale rule to a rendered slot. */
function surface(slot: unknown, inTransitionRender: boolean): unknown {
  if (slot instanceof Failure) throw slot.error;
  if (slot instanceof Pending) {
    // Inside a transition render, hand React the (stable) thenable: the
    // transition holds, the old screen stays. An urgent render with settled
    // history serves the stale value (isPending is the indicator). A
    // never-settled read suspends everywhere.
    if (!inTransitionRender && slot.ctx.hasSettled) return slot.ctx.settledValue;
    throw slot.promise;
  }
  return slot;
}

/**
 * Read a signal or computed and re-render when it changes — in the batch that
 * owns each change. The render pass's own world decides what it shows.
 */
export function useValue<T>(x: Cell<T> | Derived<T>): T {
  const node = x as AnyNode;
  const [, bump] = React.useReducer(bumpReducer, 0);
  const stateRef = React.useRef<HookSubState | null>(null);
  if (stateRef.current === null || stateRef.current.sub.node !== node) {
    // Node identity changed (or first render): a fresh subscription identity.
    stateRef.current = { sub: makeSub(node, bump, false), dispose: null, renderedSlot: undefined, renderedCells: null };
  }
  const state = stateRef.current;
  state.sub.bump = bump;

  const { frame, rootKey } = currentRenderFrame();
  if (rootKey !== null) state.sub.rootKey = rootKey;
  const { slot, cells } = renderRead(node, frame);
  state.renderedSlot = slot;
  state.renderedCells = cells;
  if (trace !== null) trace.emit('render', state.sub.causeId, node.label, node);

  // Claim the subscription at commit; fix up anything missed in between.
  React.useEffect(() => {
    const st = stateRef.current!;
    if (st.dispose === null || st.sub.node !== node) {
      st.dispose?.();
      st.sub.snapshot = st.renderedSlot;
      st.sub.cells = st.renderedCells;
      st.dispose = subscribe(st.sub);
      registerSubRoot(st.sub);
      // Post-subscribe fixup 1: a canonical write between render and claim.
      try {
        if (!Object.is(peekSlot(node, null), st.renderedSlot)) bump();
      } catch {
        bump(); // slot now throws (pending/error): re-render decides
      }
      // Post-subscribe fixup 2: join open episodes that already affect this
      // node so this subscriber re-renders inside their commits, not beside.
      for (const ep of openEpisodesSnapshot()) {
        if (episodeAffects(ep, node)) {
          ep.noteDelivery(st.sub);
          deliver(st.sub, ep);
        }
      }
      return () => {
        st.dispose?.();
        st.dispose = null;
        unregisterSubRoot(st.sub);
      };
    }
    return undefined;
  }, [node]);

  // Track what the screen shows after every commit (delivery equality skip).
  React.useEffect(() => {
    const st = stateRef.current!;
    st.sub.snapshot = st.renderedSlot;
    st.sub.cells = st.renderedCells;
  });

  const inTransitionRender = frame !== null && frame.episodes.length > 0;
  return surface(slot, inTransitionRender) as T;
}

/** Component-local computed: memoized on deps, subscribed like useValue. */
export function useComputed<T>(fn: (use: Use) => T, deps: unknown[]): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const c = React.useMemo(() => createComputed(fn), deps);
  return useValue(c);
}

/** Component-owned atom, reclaimed after unmount. */
export function useAtom<T>(initial: T | (() => T), opts?: AtomOptions<T>): Cell<T> {
  const [cell] = React.useState(() => createAtom(initial, opts));
  return cell;
}

/**
 * Run an engine effect for the component's lifetime. The effect observes
 * canonical (committed ∪ urgent) values and re-runs when they change;
 * cleanup is honored between runs and at unmount.
 */
export function useSignalEffect(fn: () => void | (() => void)): void {
  const fnRef = React.useRef(fn);
  fnRef.current = fn;
  React.useEffect(() => engineEffect(() => fnRef.current()), []);
}

/** Subscribe to `isPending(x)`: true while newer data loads behind stale. */
export function useIsPending<T>(x: Cell<T> | Derived<T>): boolean {
  const node = x as AnyNode;
  const [, bump] = React.useReducer(bumpReducer, 0);
  const subRef = React.useRef<HostSub | null>(null);
  if (subRef.current === null || subRef.current.node !== node) {
    subRef.current = makeSub(node, bump, true);
  }
  subRef.current.bump = bump;
  const { rootKey } = currentRenderFrame();
  if (rootKey !== null) subRef.current.rootKey = rootKey;
  const value = isPending(node);
  subRef.current.lastPending = value;
  React.useEffect(() => {
    const sub = subRef.current!;
    const dispose = subscribe(sub);
    if (isPending(node) !== sub.lastPending) bump();
    return dispose;
  }, [node]);
  return value;
}

/** Subscribe to the committed (on-screen) value of `x`. */
export function useCommitted<T>(x: Cell<T> | Derived<T>): T {
  const node = x as AnyNode;
  const [, bump] = React.useReducer(bumpReducer, 0);
  const subRef = React.useRef<HostSub | null>(null);
  if (subRef.current === null || subRef.current.node !== node) {
    const sub = makeSub(node, bump, false);
    sub.committedWatcher = true;
    subRef.current = sub;
  }
  subRef.current.bump = bump;
  const { rootKey } = currentRenderFrame();
  if (rootKey !== null) subRef.current.rootKey = rootKey;
  React.useEffect(() => {
    const sub = subRef.current!;
    sub.snapshot = SUB_NEVER; // commit snapshots drive deliveries, not values
    const dispose = subscribe(sub);
    registerSubRoot(sub);
    return () => {
      dispose();
      unregisterSubRoot(sub);
    };
  }, [node]);
  return committed(x, subRef.current.rootKey ?? undefined) as T;
}

/**
 * useTransition married to an engine batch: `start(scope)` classifies engine
 * writes into the transition and React reports pending state for it.
 */
export function useTransitionWrite(): [boolean, (scope: () => void) => void] {
  const [reactPending, reactStart] = React.useTransition();
  const start = React.useCallback((scope: () => void) => {
    reactStart(() => {
      startTransitionWrite(scope);
    });
  }, [reactStart]);
  return [reactPending, start];
}

export { startTransitionWrite, currentEpisode };
