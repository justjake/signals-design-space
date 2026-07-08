import {
  atomId,
  batch,
  computedId,
  effect,
  effectScope,
  read,
  reset,
  set,
  setAutomaticReclamation,
} from "../src";
import type { CellId } from "../src";

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
setAutomaticReclamation(false);
const framework: ReactiveFramework<CellId> = {
  name: "Royale SH2",
  createSignal: atomId,
  readSignal: read,
  writeSignal: set,
  createComputed: computedId,
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
    reset();
  },
};

export default framework;
