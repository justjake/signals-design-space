import {
  computed,
  effect,
  effectScope,
  endBatch,
  read,
  startBatch,
  atom,
  set,
  untracked,
} from "../src";

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
  name: "signals-royale-sh2",
  signal<T>(initialValue: T) {
    const cell = atom<T>(initialValue);
    return { read: () => read<T>(cell), write: (value: T) => set<T>(cell, value) };
  },
  computed<T>(fn: () => T) {
    const cell = computed(fn);
    return { read: () => read(cell) };
  },
  effect,
  effectScope,
  startBatch,
  endBatch,
  untracked,
};

export default adapter;
