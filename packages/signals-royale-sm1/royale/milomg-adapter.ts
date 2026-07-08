import { atom, batch, computed, effect, effectScope } from "../src/index.ts";

export interface ReactiveFramework<S = unknown> {
  name: string;
  createSignal(initialValue: unknown): S;
  readSignal(signal: S): unknown;
  writeSignal(signal: S, value: unknown): void;
  createComputed(fn: () => unknown): S;
  readComputed(cell: S): unknown;
  effect(fn: () => void): void;
  withBatch(fn: () => void): void;
  withBuild<T>(fn: () => T): T;
  cleanup(): void;
}

type Cell = ReturnType<typeof atom<unknown>> | ReturnType<typeof computed<unknown>>;
let disposeBuild: (() => void) | null = null;

const adapter: ReactiveFramework<Cell> = {
  name: "Royale SM1",
  createSignal: (initialValue) => atom(initialValue),
  readSignal: (signal) => signal.state,
  writeSignal(signal, value) {
    if (!("set" in signal)) throw new Error("Cannot write a computed.");
    signal.set(value);
  },
  createComputed: (fn) => computed(fn),
  readComputed: (cell) => cell.state,
  effect(fn) {
    effect(() => {
      fn();
    });
  },
  withBatch: batch,
  withBuild<T>(fn: () => T): T {
    let value!: T;
    disposeBuild = effectScope(() => {
      value = fn();
    });
    return value;
  },
  cleanup() {
    disposeBuild?.();
    disposeBuild = null;
  },
};

export default adapter;
