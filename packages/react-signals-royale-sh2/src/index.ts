import * as React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  asyncComputed,
  atom,
  batch,
  beginDraft,
  commitDrafts,
  commitIfUnscheduled,
  committed,
  computed,
  deliveryCause,
  createTrace,
  disposeCell,
  effect,
  emit,
  enterRenderWorld,
  initializeAtomState,
  installState,
  isPending,
  latest,
  leaveRenderWorld,
  markDraftScheduled,
  pendingBatch,
  read,
  refresh,
  revision,
  reset,
  renderIncludesDraft,
  serializeAtomState,
  set,
  staleValue,
  subscribe,
  untracked,
  update,
  withDraft,
  type AtomOptions,
  type Cell,
  type ComputedOptions,
  type TraceView,
} from "signals-royale-sh2";

interface ForkReact extends Omit<typeof React, "startTransition"> {
  startTransition(scope: () => void): void;
  unstable_registerSignalRuntime?(runtime: SignalRuntime): () => void;
  unstable_runWithSignalBatch?<T>(batch: number, scope: () => T): T;
  unstable_runInSignalBatch?<T>(batch: number, scope: () => T): T;
}

interface SignalRuntime {
  batchScheduled(batch: number): void;
  renderStart(container: object, batches: number[]): void;
  renderEnd(completed: boolean): void;
  commit(container: object, batches: number[]): void;
  mutation(start: boolean, container: Element): void;
}

const Fork = React as ForkReact;
const mutationListeners = new Set<(phase: "start" | "stop", container: Element) => void>();
const registrationErrors: unknown[] = [];
let registered = false;

const runtime: SignalRuntime = {
  batchScheduled(batch) {
    markDraftScheduled(batch);
  },
  renderStart(_container, batches) {
    enterRenderWorld(batches);
  },
  renderEnd() {
    leaveRenderWorld();
  },
  commit(container, batches) {
    commitDrafts(container, batches);
  },
  mutation(start, container) {
    for (const listener of mutationListeners) listener(start ? "start" : "stop", container);
  },
};

export interface RegistrationHandle {
  errors: unknown[];
  dispose(): void;
}

export function register(): RegistrationHandle {
  if (!registered) {
    if (
      Fork.unstable_registerSignalRuntime === undefined ||
      Fork.unstable_runInSignalBatch === undefined
    ) {
      throw new Error("This package requires the signals-royale-sh2 React fork.");
    }
    Fork.unstable_registerSignalRuntime(runtime);
    registered = true;
  }
  return { errors: registrationErrors, dispose() {} };
}

export function useValue<T>(cell: Cell<T>): T {
  register();
  const [, deliver] = React.useState(0);
  const renderedRevision = revision(cell);
  const revisionRef = React.useRef(renderedRevision);
  revisionRef.current = renderedRevision;
  React.useLayoutEffect(() => {
    const stop = subscribe(cell, () => deliver((value) => value + 1));
    if (revision(cell) !== revisionRef.current) deliver((value) => value + 1);
    const batch = pendingBatch(cell);
    if (batch !== 0) Fork.unstable_runInSignalBatch!(batch, () => deliver((value) => value + 1));
    return stop;
  }, [cell]);
  const cause = deliveryCause(cell);
  React.useLayoutEffect(() => {
    emit("component delivery", cell.id, cause);
  }, [cell, cause, renderedRevision]);
  try {
    return read(cell);
  } catch (error) {
    const stale = staleValue(cell);
    if (
      !renderIncludesDraft() &&
      stale.available &&
      error !== null &&
      typeof error === "object" &&
      "then" in error
    )
      return stale.value as T;
    throw error;
  }
}

export function useComputed<T>(calculate: () => T, dependencies: unknown[]): T {
  const cell = React.useMemo(() => computed(calculate), dependencies);
  React.useEffect(() => () => disposeCell(cell), [cell]);
  return useValue(cell);
}

export function useSignalEffect(calculate: () => void | (() => void)): void {
  React.useEffect(() => effect(calculate), [calculate]);
}

export function useIsPending(cell: Cell): boolean {
  register();
  const [, deliver] = React.useState(0);
  React.useLayoutEffect(() => {
    let active = true;
    const stop = subscribe(cell, () => {
      if (pendingBatch(cell) !== 0) {
        queueMicrotask(() => {
          if (active) deliver((value) => value + 1);
        });
      } else deliver((value) => value + 1);
    });
    const batch = pendingBatch(cell);
    if (batch !== 0) Fork.unstable_runInSignalBatch!(batch, () => deliver((value) => value + 1));
    return () => {
      active = false;
      stop();
    };
  }, [cell]);
  return isPending(cell);
}

export function useCommitted<T>(cell: Cell<T>): T {
  return committed(cell);
}

export function useAtom<T>(initial: T | (() => T), options?: AtomOptions<T>): Cell<T> {
  const [cell] = React.useState(() => atom(initial, options));
  React.useEffect(() => () => disposeCell(cell), [cell]);
  return cell;
}

export function startTransitionWrite(scope: () => void): void {
  register();
  const id = beginDraft();
  Fork.unstable_runWithSignalBatch!(id, () => {
    Fork.startTransition(() => withDraft(id, scope));
  });
  queueMicrotask(() => commitIfUnscheduled(id));
}

export function onDomMutation(
  listener: (phase: "start" | "stop", container: Element) => void,
): () => void {
  register();
  mutationListeners.add(listener);
  return () => {
    mutationListeners.delete(listener);
  };
}

export function trace(capacity?: number): TraceView {
  return createTrace(capacity);
}

export function resetForTest(): void {
  reset();
  mutationListeners.clear();
  registrationErrors.length = 0;
}

export {
  React,
  createRoot,
  flushSync,
  atom,
  asyncComputed,
  batch,
  committed,
  computed,
  disposeCell,
  effect,
  initializeAtomState,
  installState,
  isPending,
  latest,
  read,
  refresh,
  serializeAtomState,
  set,
  untracked,
  update,
};
export type { Cell, ComputedOptions };
