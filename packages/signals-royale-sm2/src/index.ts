export {
  Atom,
  Computed,
  Runtime,
  createRuntime,
  getDefaultRuntime,
  type AtomOptions,
  type BatchId,
  type ComputedOptions,
  type HostProtocol,
  type RuntimeEvent,
} from "./runtime";

import {
  getDefaultRuntime,
  type Atom,
  type AtomOptions,
  type Computed,
  type ComputedOptions,
} from "./runtime";

const runtime = getDefaultRuntime();

export function atom<T>(initial: T | (() => T), options?: AtomOptions<T>): Atom<T> {
  return runtime.atom(initial, options);
}

export function computed<T>(
  fn: (use: <U>(promise: PromiseLike<U>) => U) => T,
  options?: ComputedOptions<T>,
): Computed<T> {
  return runtime.computed(fn, options);
}

export const effect = runtime.effect.bind(runtime);
export const effectScope = runtime.effectScope.bind(runtime);
export const batch = runtime.batch.bind(runtime);
export const startBatch = runtime.startBatch.bind(runtime);
export const endBatch = runtime.endBatch.bind(runtime);
export const untracked = runtime.untracked.bind(runtime);
export const latest = runtime.latest.bind(runtime);
export const committed = runtime.committed.bind(runtime);
export const isPending = runtime.isPending.bind(runtime);
export const refresh = runtime.refresh.bind(runtime);

export function serializeAtomState(
  atoms: readonly Atom<any>[],
  replacer?: (this: unknown, key: string, value: unknown) => unknown,
): string {
  const state: Record<string, unknown> = {};
  for (const current of atoms) {
    if (current.key === undefined) throw new Error("Every serialized atom needs a key");
    state[current.key] = current.peek();
  }
  return JSON.stringify(state, replacer);
}

export function initializeAtomState(
  json: string,
  atoms: readonly Atom<any>[],
  reviver?: (this: unknown, key: string, value: unknown) => unknown,
): void {
  const state = JSON.parse(json, reviver) as Record<string, unknown>;
  for (const current of atoms) {
    if (current.key === undefined) throw new Error("Every initialized atom needs a key");
    if (Object.hasOwn(state, current.key)) current.install(state[current.key]);
  }
}

export function installState<T>(target: Atom<T>, value: T): void {
  target.install(value);
}
