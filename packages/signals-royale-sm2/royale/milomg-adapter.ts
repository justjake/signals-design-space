import { createRuntime, type Atom, type Computed } from "../src/index";

type Cell = Atom<unknown> | Computed<unknown>;
const runtime = createRuntime();
let disposeBuild: (() => void) | undefined;

export default {
  name: "Royale SM2",
  createSignal(initialValue: unknown): Cell {
    return runtime.atom(initialValue);
  },
  readSignal(signal: Cell): unknown {
    return signal.get();
  },
  writeSignal(signal: Cell, value: unknown): void {
    if ("set" in signal) signal.set(value);
  },
  createComputed(fn: () => unknown): Cell {
    return runtime.computed(fn);
  },
  readComputed(cell: Cell): unknown {
    return cell.get();
  },
  effect(fn: () => void): void {
    runtime.effect(fn);
  },
  withBatch(fn: () => void): void {
    runtime.batch(fn);
  },
  withBuild<T>(fn: () => T): T {
    let result!: T;
    disposeBuild = runtime.effectScope(() => {
      result = fn();
    });
    return result;
  },
  cleanup(): void {
    disposeBuild?.();
    disposeBuild = undefined;
  },
};
