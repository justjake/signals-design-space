import * as React from "react";
import { createRuntime, type BatchId, type Runtime } from "signals-royale-sm2";

interface RenderContext {
  container: object;
  lanes: number;
}

interface ForkListener {
  onRenderStart?(container: object, lanes: number): void;
  onRenderStop?(container: object, lanes: number, committed: boolean, remainingLanes: number): void;
  onCommitStart?(container: object, lanes: number): void;
  onCommitStop?(container: object, lanes: number, remainingLanes: number): void;
  onMutationStart?(container: Element): void;
  onMutationStop?(container: Element): void;
}

interface ForkReact {
  unstable_subscribeToSignalRuntime(listener: ForkListener): () => void;
  unstable_getCurrentSignalWriteLane(): number;
  unstable_isCurrentSignalWriteDeferred(): boolean;
  unstable_getSignalRenderContext(): RenderContext | null;
  unstable_runWithSignalLane<T>(lane: number, fn: () => T): T;
}

export interface RegistrationHandle {
  errors: unknown[];
  dispose(): void;
}

const fork = React as unknown as Partial<ForkReact>;
const pendingRoots = new Map<BatchId, Set<object>>();
const committedBatches = new Set<BatchId>();
const mutationListeners = new Set<(phase: "start" | "stop", container: Element) => void>();
let runtime = createRuntime();
let registration: RegistrationHandle | undefined;

function requiredFork(): ForkReact {
  if (
    fork.unstable_subscribeToSignalRuntime === undefined ||
    fork.unstable_getCurrentSignalWriteLane === undefined ||
    fork.unstable_isCurrentSignalWriteDeferred === undefined ||
    fork.unstable_getSignalRenderContext === undefined ||
    fork.unstable_runWithSignalLane === undefined
  ) {
    throw new Error("react-signals-royale-sm2 requires its patched React build");
  }
  return fork as ForkReact;
}

function retireFinishedBatch(batchId: BatchId): void {
  const roots = pendingRoots.get(batchId);
  if (roots !== undefined && roots.size !== 0) return;
  pendingRoots.delete(batchId);
  const committed = committedBatches.delete(batchId);
  runtime.retireBatch(batchId, committed);
}

export function expectBatchRoot(batchId: BatchId, container: object): void {
  if (!runtime.isDeferredBatch(batchId)) return;
  let roots = pendingRoots.get(batchId);
  if (roots === undefined) pendingRoots.set(batchId, (roots = new Set()));
  roots.add(container);
}

export function getRuntime(): Runtime {
  return runtime;
}

export function register(): RegistrationHandle {
  if (registration !== undefined) return registration;
  const api = requiredFork();
  const errors: unknown[] = [];
  runtime.attachHost({
    getCurrentWriteBatch() {
      const lane = api.unstable_getCurrentSignalWriteLane();
      if (api.unstable_isCurrentSignalWriteDeferred() && runtime.ensureBatch(lane, true)) {
        queueMicrotask(() => {
          if ((pendingRoots.get(lane)?.size ?? 0) === 0) committedBatches.add(lane);
          retireFinishedBatch(lane);
        });
      }
      return lane;
    },
    getRenderBatches() {
      const context = api.unstable_getSignalRenderContext();
      return context === null ? null : runtime.batchIdsForLanes(context.lanes);
    },
    getRenderContainer: () => api.unstable_getSignalRenderContext()?.container ?? null,
    runInBatch: (batchId, fn) => api.unstable_runWithSignalLane(batchId, fn),
  });
  const unsubscribe = api.unstable_subscribeToSignalRuntime({
    onRenderStart(container, lanes) {
      const batches = runtime.batchIdsForLanes(lanes);
      for (const batchId of batches) expectBatchRoot(batchId, container);
      runtime.emitDebug({ kind: "render-pass-start", subject: container, batchId: batches[0] });
    },
    onRenderStop(container, lanes, committed, remainingLanes) {
      runtime.emitDebug({
        kind: committed ? "render-pass-commit" : "render-pass-discard",
        subject: container,
        batchId: runtime.batchIdsForLanes(lanes)[0],
      });
      if (committed) return;
      const batches = runtime.batchIdsForLanes(lanes);
      for (const batchId of batches) {
        if ((remainingLanes & batchId) !== 0) continue;
        pendingRoots.get(batchId)?.delete(container);
        retireFinishedBatch(batchId);
      }
    },
    onCommitStart(container, lanes) {
      const batches = runtime.batchIdsForLanes(lanes);
      for (const batchId of batches) committedBatches.add(batchId);
      runtime.rootCommitted(container, batches);
    },
    onCommitStop(container, lanes, remainingLanes) {
      const batches = runtime.batchIdsForLanes(lanes);
      for (const batchId of batches) {
        if ((remainingLanes & batchId) !== 0) continue;
        pendingRoots.get(batchId)?.delete(container);
        retireFinishedBatch(batchId);
      }
    },
    onMutationStart(container) {
      for (const listener of mutationListeners) listener("start", container);
    },
    onMutationStop(container) {
      for (const listener of mutationListeners) listener("stop", container);
    },
  });
  registration = {
    errors,
    dispose() {
      if (registration !== this) return;
      runtime.attachHost(undefined);
      unsubscribe();
      registration = undefined;
    },
  };
  return registration;
}

export function resetForTest(): void {
  registration?.dispose();
  pendingRoots.clear();
  committedBatches.clear();
  runtime = createRuntime();
  register();
}

export function currentContainer(): object | undefined {
  return requiredFork().unstable_getSignalRenderContext()?.container;
}

export function onDomMutation(
  listener: (phase: "start" | "stop", container: Element) => void,
): () => void {
  mutationListeners.add(listener);
  return () => mutationListeners.delete(listener);
}
