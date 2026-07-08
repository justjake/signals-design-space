import * as React from "react";
import {
  atom,
  batchCause,
  committed,
  computed,
  effect,
  isPending,
  liveBatchIds,
  observeCell,
  recordCommitted,
  retireBatch,
  subscribePending,
  subscribeView,
  traceEvent,
  withWorld,
  withWriteBatch,
  Atom,
  type Computed,
} from "signals-royale-sx2";

type Cell<T> = Atom<T> | Computed<T>;
type ProtocolEvent = {
  type: "pass" | "commit" | "mutation";
  phase?: "start" | "stop" | "commit" | "discard";
  container: object;
  lanes?: number;
  pending?: number;
  finished?: number;
};
type Protocol = {
  version: number;
  subscribe(listener: (event: ProtocolEvent) => void): () => void;
  getWriteLane(): number;
  getRenderContext(): { container: object; lanes: number } | null;
  runInLane<T>(lane: number, fn: () => T): T;
};

type Pass = { lanes: number; values: Map<object, unknown> };
const passes = new WeakMap<object, Pass>();
const pendingRoots = new Map<number, Set<object>>();
const committedBatches = new Set<number>();
const mutationListeners = new Set<
  (phase: "start" | "stop", container: Element) => void
>();
let protocol: Protocol | undefined;
let unsubscribeProtocol: (() => void) | undefined;
let currentErrors: unknown[] = [];

function findProtocol(): Protocol {
  const internals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: {
        L?: Protocol;
      };
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const found = internals?.L;
  if (found?.version !== 1) {
    throw new Error(
      "react-signals-royale-sx2 requires its patched React build",
    );
  }
  return found;
}

function onProtocolEvent(event: ProtocolEvent): void {
  if (event.type === "pass") {
    traceEvent(`render pass ${event.phase}`, undefined, event.lanes);
    if (event.phase === "start") {
      passes.set(event.container, {
        lanes: event.lanes ?? 0,
        values: new Map(),
      });
    } else if (event.phase === "discard") {
      passes.delete(event.container);
    }
    return;
  }
  if (event.type === "mutation") {
    for (const listener of mutationListeners) {
      try {
        listener(event.phase as "start" | "stop", event.container as Element);
      } catch (error) {
        currentErrors.push(error);
      }
    }
    return;
  }
  traceEvent("root commit", undefined, event.lanes);
  const pass = passes.get(event.container);
  if (pass !== undefined) {
    for (const [cell] of pass.values) {
      for (const batchId of liveBatchIds()) {
        if (((event.lanes ?? 0) & batchId) !== 0) {
          traceEvent("component delivery", batchCause(batchId), batchId, cell);
        }
      }
    }
    recordCommitted(event.container, pass.values);
    passes.delete(event.container);
  }
  for (const batchId of liveBatchIds()) {
    const roots = pendingRoots.get(batchId);
    if (roots?.has(event.container) !== true) continue;
    if (((event.finished ?? 0) & batchId) === 0) continue;
    roots.delete(event.container);
    if (((event.lanes ?? 0) & batchId) !== 0) committedBatches.add(batchId);
    if (roots === undefined || roots.size === 0) {
      pendingRoots.delete(batchId);
      retireBatch(batchId, committedBatches.delete(batchId));
    }
  }
}

function requireProtocol(): Protocol {
  if (protocol === undefined)
    throw new Error("register() must be called before rendering");
  return protocol;
}

function closeStoreOnly(batchId: number): void {
  if (batchId === 0) return;
  queueMicrotask(() => {
    if (pendingRoots.has(batchId)) return;
    for (const liveId of liveBatchIds()) {
      if (liveId === batchId) {
        retireBatch(batchId, true);
        return;
      }
    }
  });
}

export interface RegistrationHandle {
  errors: unknown[];
  dispose(): void;
}

export function register(): RegistrationHandle {
  if (protocol === undefined) {
    protocol = findProtocol();
    currentErrors = [];
    unsubscribeProtocol = protocol.subscribe(onProtocolEvent);
  }
  const errors = currentErrors;
  return {
    errors,
    dispose() {
      unsubscribeProtocol?.();
      unsubscribeProtocol = undefined;
      protocol = undefined;
    },
  };
}

export function useValue<T>(cell: Cell<T>): T {
  const activeProtocol = requireProtocol();
  const [, render] = React.useReducer((value: number) => value + 1, 0);
  const context = activeProtocol.getRenderContext();
  if (context === null)
    throw new Error("useValue must run during a React render");
  const container = React.useRef(context.container);
  container.current = context.container;
  let deferred = false;
  for (const batchId of liveBatchIds()) {
    if ((context.lanes & batchId) !== 0) {
      deferred = true;
      break;
    }
  }
  const value = withWorld({ lanes: context.lanes, deferred }, () => cell.get());
  let pass = passes.get(context.container);
  if (pass === undefined) {
    pass = { lanes: context.lanes, values: new Map() };
    passes.set(context.container, pass);
  }
  pass.values.set(cell, value);

  React.useLayoutEffect(() => {
    const deliver = (batchId: number, cause?: number) => {
      const target = container.current;
      traceEvent("component delivery", cause, batchId, cell);
      if (batchId === 0) {
        render();
      } else {
        let roots = pendingRoots.get(batchId);
        if (roots === undefined) {
          roots = new Set();
          pendingRoots.set(batchId, roots);
        }
        roots.add(target);
        activeProtocol.runInLane(batchId, render);
      }
    };
    const stopView = subscribeView(cell, deliver);
    const stopObservation = observeCell(cell);
    for (const batchId of liveBatchIds(
      cell instanceof Atom ? cell : undefined,
    )) {
      deliver(batchId);
    }
    return () => {
      stopView();
      stopObservation();
    };
  }, [cell, activeProtocol]);
  return value;
}

export function useComputed<T>(fn: () => T, deps: React.DependencyList): T {
  const cell = React.useMemo(() => computed(fn), deps);
  return useValue(cell);
}

export function useSignalEffect(fn: () => void | (() => void)): void {
  React.useEffect(() => effect(fn), [fn]);
}

export function useIsPending<T>(cell: Cell<T>): boolean {
  const [, render] = React.useReducer((value: number) => value + 1, 0);
  React.useLayoutEffect(() => {
    let active = true;
    const stop = subscribePending(cell, () => {
      queueMicrotask(() => {
        if (active) render();
      });
    });
    const stopObservation = observeCell(cell);
    return () => {
      active = false;
      stop();
      stopObservation();
    };
  }, [cell]);
  const context = requireProtocol().getRenderContext();
  return context === null
    ? isPending(cell)
    : withWorld({ lanes: context.lanes, deferred: false }, () =>
        isPending(cell),
      );
}

export function useCommitted<T>(cell: Cell<T>): T {
  useValue(cell);
  const context = requireProtocol().getRenderContext();
  return committed(cell, context?.container);
}

export function useAtom<T>(initial: T | (() => T)): Atom<T> {
  const reference = React.useRef<Atom<T> | undefined>(undefined);
  if (reference.current === undefined) reference.current = atom(initial);
  return reference.current;
}

export function startTransitionWrite(scope: () => void): void {
  const activeProtocol = requireProtocol();
  React.startTransition(() => {
    const lane = activeProtocol.getWriteLane();
    withWriteBatch(lane, scope);
  });
}

export function write<T>(cell: Atom<T>, value: T): void {
  const lane = requireProtocol().getWriteLane();
  withWriteBatch(lane, () => cell.set(value));
  closeStoreOnly(lane);
}

export function reduce<T>(cell: Atom<T>, fn: (previous: T) => T): void {
  const lane = requireProtocol().getWriteLane();
  withWriteBatch(lane, () => cell.update(fn));
  closeStoreOnly(lane);
}

export function onDomMutation(
  listener: (phase: "start" | "stop", container: Element) => void,
): () => void {
  mutationListeners.add(listener);
  return () => mutationListeners.delete(listener);
}

export function resetBindingForTest(): void {
  pendingRoots.clear();
  committedBatches.clear();
  mutationListeners.clear();
  currentErrors.length = 0;
}
