import {
  computed,
  effect,
  effectScope,
  endBatch,
  startBatch,
  atom,
  untracked,
} from "../src/index";

export interface AdapterSignal<T> {
  read(): T;
  write(value: T): void;
}
export interface AdapterComputed<T> {
  read(): T;
}

export default {
  name: "signals-royale-sx2",
  signal<T>(initialValue: T): AdapterSignal<T> {
    const cell = atom(initialValue);
    return { read: () => cell.get(), write: (value) => cell.set(value) };
  },
  computed<T>(fn: () => T): AdapterComputed<T> {
    const cell = computed(fn);
    return { read: () => cell.get() };
  },
  effect,
  effectScope,
  startBatch,
  endBatch,
  untracked,
};
