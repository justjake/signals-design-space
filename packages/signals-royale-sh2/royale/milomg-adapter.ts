import { atom, batch, computed, effect, effectScope, read, set } from "../src";
import type { Cell } from "../src";

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

let dispose: (() => void) | undefined;
const framework: ReactiveFramework<Cell> = {
  name: "Royale SH2",
  createSignal: atom,
  readSignal: read,
  writeSignal: set,
  createComputed: computed,
  readComputed: read,
  effect(fn) {
    effect(fn);
  },
  withBatch: batch,
  withBuild<T>(fn: () => T): T {
    let value!: T;
    dispose = effectScope(() => {
      value = fn();
    });
    return value;
  },
  cleanup() {
    dispose?.();
    dispose = undefined;
  },
};

export default framework;
