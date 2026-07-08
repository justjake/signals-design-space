import * as React from "react";
import {
  Atom,
  Computed,
  Transaction,
  atom,
  batch,
  causeOf,
  committed,
  computed,
  effect,
  emit,
  initializeAtomState,
  isPending,
  latest,
  openTransaction,
  pendingTransaction,
  read,
  rebaseDeferredOverUrgent,
  refresh,
  resetForTest as resetEngine,
  retireTransaction,
  rootWorld,
  runInTransaction,
  serializeAtomState,
  setRootWorld,
  subscribeNode,
  subscribeReact,
  trace as createTracer,
  untracked,
  withWorld,
  type TraceId,
} from "signals-royale-sh1";

type Cell<T = unknown> = Atom<T> | Computed<T>;
type Protocol = {
  register(runtime: Runtime): () => void;
  run<T>(batch: number, fn: () => T): T;
  urgent<T>(fn: () => T): T;
  world(): RenderWorld | null;
  reset(): void;
};
type FiberRoot = { containerInfo: object };
type RenderWorld = { render: readonly Transaction[]; committed: readonly Transaction[] };

const protocol = (React as unknown as { unstable_Signals?: Protocol }).unstable_Signals;
const transactions = new Map<number, Transaction>();
const lanes = new Map<number, number>();
let rootLanes = new WeakMap<FiberRoot, Map<number, Transaction>>();
let rootCommitted = new WeakMap<FiberRoot, Transaction[]>();
let openPasses = new WeakMap<FiberRoot, number>();
let passCauses = new WeakMap<FiberRoot, TraceId>();
const mutationListeners = new Set<(phase: "start" | "stop", container: Element) => void>();
const deliveries = new WeakMap<object, TraceId>();
type Callback = (transaction?: Transaction) => void;
let callbacks = new WeakMap<object, Set<Callback>>();
const allCallbacks = new Set<Callback>();
const computedCallbacks = new Set<Callback>();
const stale = new WeakMap<object, unknown>();
let version = 0;
let unregister: (() => void) | undefined;
let registrations = 0;

subscribeReact((transaction, target, canonical) => {
  version++;
  if (canonical) return;
  if (target === undefined) {
    for (const callback of allCallbacks) callback(transaction);
    return;
  }
  const direct = callbacks.get(target);
  if (direct !== undefined) for (const callback of direct) callback(transaction);
  if (target instanceof Atom) {
    for (const callback of computedCallbacks) callback(transaction);
  }
});

const runtime: Runtime = {
  lane(batchId) {
    return lanes.get(batchId) ?? 0;
  },
  schedule(root, lane, batchId) {
    const transaction = transactions.get(batchId);
    if (transaction === undefined) return;
    lanes.set(batchId, lane);
    transaction.roots.add(root);
    let map = rootLanes.get(root);
    if (map === undefined) rootLanes.set(root, (map = new Map()));
    map.set(lane, transaction);
  },
  render(root, renderLanes) {
    const committedWorld: Transaction[] = [];
    const committed = rootCommitted.get(root);
    if (committed !== undefined) {
      for (const transaction of committed) {
        if (!transaction.closed) committedWorld.push(transaction);
      }
    }
    const world = committedWorld.slice();
    const map = rootLanes.get(root);
    if (map !== undefined) {
      for (const [lane, transaction] of map) {
        if ((lane & renderLanes) !== 0 && !world.includes(transaction)) world.push(transaction);
      }
    }
    const open = openPasses.get(root);
    if (open !== renderLanes) {
      if (open !== undefined) {
        emit("render-pass-end", passCauses.get(root), { root, disposition: "discard" });
      }
      const cause = world[world.length - 1]?.cause;
      openPasses.set(root, renderLanes);
      if (cause !== undefined) passCauses.set(root, cause);
      emit("render-pass-start", cause, { root, lanes: renderLanes });
    }
    return { render: world, committed: committedWorld };
  },
  commit(root, committedLanes, remainingLanes) {
    const cause = passCauses.get(root);
    emit("render-pass-end", cause, { root, disposition: "commit" });
    emit("root-commit", cause, { root, lanes: committedLanes });
    openPasses.delete(root);
    const map = rootLanes.get(root);
    if (map === undefined) return;
    let view = rootCommitted.get(root) ?? [];
    for (const [lane, transaction] of map) {
      if ((lane & remainingLanes) !== 0) continue;
      const landed = (lane & committedLanes) !== 0;
      if (landed) {
        transaction.landed = true;
        if (!view.includes(transaction)) view = [...view, transaction];
      }
      transaction.roots.delete(root);
      map.delete(lane);
      if (transaction.roots.size === 0) {
        transactions.delete(transaction.id);
        lanes.delete(transaction.id);
        retireTransaction(transaction, transaction.landed, !transaction.landed);
      }
    }
    if (map.size === 0) rootLanes.delete(root);
    const live: Transaction[] = [];
    for (const transaction of view) if (!transaction.closed) live.push(transaction);
    if (live.length === 0) rootCommitted.delete(root);
    else rootCommitted.set(root, live);
    setRootWorld(root.containerInfo, live);
  },
  mutation(root, start) {
    const phase = start ? "start" : "stop";
    emit(`dom-mutation-${phase}`, passCauses.get(root), { root });
    for (const listener of mutationListeners) listener(phase, root.containerInfo as Element);
  },
};

type Runtime = {
  lane(batch: number): number;
  schedule(root: FiberRoot, lane: number, batch: number): void;
  render(root: FiberRoot, lanes: number): RenderWorld;
  commit(root: FiberRoot, lanes: number, remaining: number): void;
  mutation(root: FiberRoot, start: boolean): void;
};

function requireProtocol(): Protocol {
  if (protocol === undefined)
    throw new Error("This package requires the signals-royale-sh1 React fork");
  return protocol;
}

export function register(): { errors: unknown[]; dispose(): void } {
  const errors: unknown[] = [];
  if (unregister === undefined) unregister = requireProtocol().register(runtime);
  registrations++;
  let disposed = false;
  return {
    errors,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (--registrations === 0) {
        unregister?.();
        unregister = undefined;
      }
    },
  };
}

function useSubscription(cell: Cell<any>, urgent = false): void {
  const [, force] = React.useReducer((value: number) => value + 1, 0);
  const renderedVersion = version;
  React.useLayoutEffect(() => {
    const callback = (transaction?: Transaction) => {
      const rerender = () => {
        deliveries.set(
          cell,
          emit("component-delivery", transaction?.cause ?? causeOf(cell), { target: cell }),
        );
        force();
      };
      if (urgent) requireProtocol().urgent(rerender);
      else if (transaction !== undefined && !transaction.closed)
        requireProtocol().run(transaction.id, rerender);
      else rerender();
    };
    let set = callbacks.get(cell);
    if (set === undefined) callbacks.set(cell, (set = new Set()));
    set.add(callback);
    allCallbacks.add(callback);
    if (cell instanceof Computed) computedCallbacks.add(callback);
    const unsubscribeNode = subscribeNode(cell, callback);
    const pending = pendingTransaction(cell);
    if (pending !== undefined) callback(pending);
    else if (renderedVersion !== version) callback();
    return () => {
      set.delete(callback);
      if (set.size === 0) callbacks.delete(cell);
      allCallbacks.delete(callback);
      computedCallbacks.delete(callback);
      unsubscribeNode();
    };
  }, [cell, urgent]);
}

export function useValue<T>(cell: Cell<T>): T {
  useSubscription(cell);
  const world = requireProtocol().world();
  try {
    const value = world === null ? read(cell) : withWorld(world.render, () => read(cell));
    stale.set(cell, value);
    return value;
  } catch (error) {
    if (
      world?.render.length === 0 &&
      stale.has(cell) &&
      typeof (error as { then?: unknown })?.then === "function"
    ) {
      return stale.get(cell) as T;
    }
    throw error;
  }
}

export function useComputed<T>(fn: () => T, deps: readonly unknown[]): T {
  return useValue(React.useMemo(() => computed(fn), deps));
}

export function useSignalEffect(fn: () => void | (() => void)): void {
  React.useEffect(() => effect(fn), [fn]);
}

export function useCommitted<T>(cell: Cell<T>): T {
  useSubscription(cell);
  const world = requireProtocol().world();
  return world === null ? committed(cell) : withWorld(world.committed, () => read(cell));
}

export function useIsPending(cell: Cell<any>): boolean {
  useSubscription(cell, true);
  return isPending(cell);
}

export function useAtom<T>(
  initial: T | (() => T),
  options?: Parameters<typeof atom<T>>[1],
): Atom<T> {
  const ref = React.useRef<Atom<T>>(undefined);
  if (ref.current === undefined) ref.current = atom(initial, options);
  return ref.current;
}

export function startTransitionWrite(scope: () => void): void {
  const transaction = openTransaction(true);
  transactions.set(transaction.id, transaction);
  React.startTransition(() => {
    requireProtocol().run(transaction.id, () => runInTransaction(transaction, scope));
  });
  if (transaction.roots.size === 0) {
    transactions.delete(transaction.id);
    retireTransaction(transaction, true, false);
  }
}

export function onDomMutation(
  listener: (phase: "start" | "stop", container: Element) => void,
): () => void {
  mutationListeners.add(listener);
  return () => mutationListeners.delete(listener);
}

export function trace() {
  const tracer = createTracer();
  return {
    whyLastDelivery(cell: object) {
      return tracer.chain(deliveries.get(cell) ?? 0);
    },
    events: () => tracer.events().map(({ id, kind, cause }) => ({ id, kind, cause })),
    stop: () => tracer.stop(),
  };
}

export function resetForTest(): void {
  unregister?.();
  unregister = undefined;
  registrations = 0;
  requireProtocol().reset();
  transactions.clear();
  lanes.clear();
  rootLanes = new WeakMap();
  rootCommitted = new WeakMap();
  openPasses = new WeakMap();
  passCauses = new WeakMap();
  mutationListeners.clear();
  callbacks = new WeakMap();
  allCallbacks.clear();
  computedCallbacks.clear();
  version = 0;
  resetEngine();
}

export {
  Atom,
  Computed,
  atom,
  batch,
  committed,
  computed,
  effect,
  initializeAtomState,
  isPending,
  latest,
  read,
  rebaseDeferredOverUrgent,
  refresh,
  rootWorld,
  serializeAtomState,
  untracked,
};
