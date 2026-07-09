import { Atom, Computed, type AtomOptions, type ComputedOptions } from "signals-royale-sm2";
import { getRuntime } from "./protocol";

export function atom<T>(initial: T | (() => T), options?: AtomOptions<T>): Atom<T> {
  return getRuntime().atom(initial, options);
}

export function computed<T>(
  fn: (use: <U>(promise: PromiseLike<U>) => U) => T,
  options?: ComputedOptions<T>,
): Computed<T> {
  return getRuntime().computed(fn, options);
}

export function batch<T>(fn: () => T): T {
  return getRuntime().batch(fn);
}

export function effect(fn: () => void | (() => void)): () => void {
  return getRuntime().effect(fn);
}

export function untracked<T>(fn: () => T): T {
  return getRuntime().untracked(fn);
}

export function latest<T>(value: Atom<T> | Computed<T>): T {
  return getRuntime().latest(value);
}

export function committed<T>(value: Atom<T> | Computed<T>, container?: object): T {
  return getRuntime().committed(value, container);
}

export function isPending<T>(value: Atom<T> | Computed<T>): boolean {
  return getRuntime().isPending(value);
}

export function refresh<T>(value: Atom<T> | Computed<T>): void {
  getRuntime().refresh(value);
}

export function serializeAtomState(
  atoms: readonly Atom<any>[],
  replacer?: (this: unknown, key: string, value: unknown) => unknown,
): string {
  const state: Record<string, unknown> = {};
  for (let i = 0; i < atoms.length; ++i) {
    const current = atoms[i];
    state[current.key ?? String(i)] = current.peek();
  }
  return JSON.stringify(state, replacer);
}

export function initializeAtomState(
  json: string,
  atoms: readonly Atom<any>[],
  reviver?: (this: unknown, key: string, value: unknown) => unknown,
): void {
  const state = JSON.parse(json, reviver) as Record<string, unknown>;
  for (let i = 0; i < atoms.length; ++i) {
    const current = atoms[i];
    const key = current.key ?? String(i);
    if (Object.hasOwn(state, key)) current.install(state[key]);
  }
}

export { Atom, Computed, type AtomOptions, type ComputedOptions };
