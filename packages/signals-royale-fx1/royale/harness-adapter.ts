/**
 * FrameworkAdapter for the shared conformance/benchmark harness.
 */
import { atom, computed, effect, effectScope, startBatch, endBatch, untracked } from "../src/index";

export interface AdapterSignal<T> {
  read(): T;
  write(value: T): void;
}
export interface AdapterComputed<T> {
  read(): T;
}
export interface FrameworkAdapter {
  name: string;
  signal<T>(initialValue: T): AdapterSignal<T>;
  computed<T>(fn: () => T): AdapterComputed<T>;
  effect(fn: () => void | (() => void)): () => void;
  effectScope(fn: () => void): () => void;
  startBatch(): void;
  endBatch(): void;
  untracked<T>(fn: () => T): T;
}

const adapter: FrameworkAdapter = {
  name: "signals-royale-fx1",
  signal<T>(initialValue: T): AdapterSignal<T> {
    // A function-valued initial here is a value, not a lazy initializer.
    const a =
      typeof initialValue === "function" ? atom<T>(() => initialValue) : atom<T>(initialValue);
    return {
      read: () => a.get(),
      write: (value: T) => a.set(value),
    };
  },
  computed<T>(fn: () => T): AdapterComputed<T> {
    const c = computed<T>(() => fn());
    return { read: () => c.get() };
  },
  effect(fn) {
    return effect(fn);
  },
  effectScope(fn) {
    return effectScope(fn);
  },
  startBatch,
  endBatch,
  untracked,
};

export default adapter;
