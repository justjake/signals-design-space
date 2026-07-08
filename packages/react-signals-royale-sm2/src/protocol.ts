import * as React from "react";
import { createRuntime, type BatchId, type Runtime } from "signals-royale-sm2";

interface ForkListener {
  onRenderPassStart?(container: object, batches: readonly BatchId[]): void;
  onRenderPassYield?(container: object): void;
  onRenderPassResume?(container: object): void;
  onRenderPassEnd?(container: object, committed: boolean): void;
  onBeforeMutation?(container: Element): void;
  onAfterMutation?(container: Element): void;
  onBatchRetired?(batchId: BatchId, committed: boolean): void;
  onRootCommitted?(container: object, batches: readonly BatchId[], generation: number): void;
}

interface ForkReact {
  unstable_subscribeToExternalRuntime(listener: ForkListener): () => void;
  unstable_registerBatchIdAllocator(allocate: (deferred: boolean) => BatchId): () => void;
  unstable_getCurrentWriteBatch(): BatchId;
  unstable_getRenderContext(): { container: object } | null;
  unstable_runInBatch<T>(batchId: BatchId, fn: () => T): T;
  unstable_resetBatchRegistryForTest(): void;
}

export interface RegistrationHandle {
  errors: unknown[];
  dispose(): void;
}

const fork = React as unknown as Partial<ForkReact>;
const frames = new WeakMap<object, readonly BatchId[]>();
const mutationListeners = new Set<(phase: "start" | "stop", container: Element) => void>();
let runtime = createRuntime();
let registration: RegistrationHandle | undefined;

function requiredFork(): ForkReact {
  if (
    fork.unstable_subscribeToExternalRuntime === undefined ||
    fork.unstable_registerBatchIdAllocator === undefined ||
    fork.unstable_getCurrentWriteBatch === undefined ||
    fork.unstable_getRenderContext === undefined ||
    fork.unstable_runInBatch === undefined ||
    fork.unstable_resetBatchRegistryForTest === undefined
  ) {
    throw new Error("react-signals-royale-sm2 requires its patched React build");
  }
  return fork as ForkReact;
}

export function getRuntime(): Runtime {
  return runtime;
}

export function register(): RegistrationHandle {
  if (registration !== undefined) return registration;
  const api = requiredFork();
  const errors: unknown[] = [];
  const unregisterAllocator = api.unstable_registerBatchIdAllocator((deferred) =>
    runtime.allocateBatch(deferred),
  );
  runtime.attachHost({
    getCurrentWriteBatch: () => api.unstable_getCurrentWriteBatch(),
    getRenderBatches() {
      const context = api.unstable_getRenderContext();
      return context === null ? null : frames.get(context.container) ?? [];
    },
    getRenderContainer: () => api.unstable_getRenderContext()?.container ?? null,
    runInBatch: (batchId, fn) => api.unstable_runInBatch(batchId, fn),
  });
  const unsubscribe = api.unstable_subscribeToExternalRuntime({
    onRenderPassStart(container, batches) {
      frames.set(container, batches);
      runtime.emitDebug({ kind: "render-pass-start", subject: container, batchId: batches[0] });
    },
    onRenderPassEnd(container, committed) {
      runtime.emitDebug({
        kind: committed ? "render-pass-commit" : "render-pass-discard",
        subject: container,
      });
      frames.delete(container);
    },
    onBeforeMutation(container) {
      for (const listener of mutationListeners) listener("start", container);
    },
    onAfterMutation(container) {
      for (const listener of mutationListeners) listener("stop", container);
    },
    onRootCommitted(container, batches) {
      runtime.rootCommitted(container, batches);
    },
    onBatchRetired(batchId, committed) {
      runtime.retireBatch(batchId, committed);
    },
  });
  registration = {
    errors,
    dispose() {
      if (registration !== this) return;
      runtime.attachHost(undefined);
      unsubscribe();
      unregisterAllocator();
      registration = undefined;
    },
  };
  return registration;
}

export function resetForTest(): void {
  registration?.dispose();
  requiredFork().unstable_resetBatchRegistryForTest();
  runtime = createRuntime();
  register();
}

export function currentContainer(): object | undefined {
  return requiredFork().unstable_getRenderContext()?.container;
}

export function onDomMutation(
  listener: (phase: "start" | "stop", container: Element) => void,
): () => void {
  mutationListeners.add(listener);
  return () => mutationListeners.delete(listener);
}
