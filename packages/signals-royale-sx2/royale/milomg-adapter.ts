import {
  atom,
  batch,
  computed,
  effect,
  effectScope,
  type Atom,
  type Computed,
} from "../src/index";

type Cell = Atom<unknown> | Computed<unknown>;
let disposeScope: (() => void) | undefined;

export default {
  name: "Royale SX2",
  createSignal: (initialValue: unknown): Cell => atom(initialValue),
  readSignal: (signal: Cell): unknown => signal.get(),
  writeSignal: (signal: Cell, value: unknown): void =>
    (signal as Atom<unknown>).set(value),
  createComputed: (fn: () => unknown): Cell => computed(fn),
  readComputed: (cell: Cell): unknown => cell.get(),
  effect(fn: () => void): void {
    effect(fn);
  },
  withBatch(fn: () => void): void {
    batch(fn);
  },
  withBuild<T>(fn: () => T): T {
    let value!: T;
    disposeScope = effectScope(() => {
      value = fn();
    });
    return value;
  },
  cleanup(): void {
    disposeScope?.();
    disposeScope = undefined;
  },
};
