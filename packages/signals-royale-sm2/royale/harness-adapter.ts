import { createRuntime } from "../src/index";

const runtime = createRuntime();

export default {
  name: "signals-royale-sm2",
  signal<T>(initialValue: T) {
    const signal = runtime.atom(initialValue);
    return { read: () => signal.get(), write: (value: T) => signal.set(value) };
  },
  computed<T>(fn: () => T) {
    const value = runtime.computed(fn);
    return { read: () => value.get() };
  },
  effect: (fn: () => void | (() => void)) => runtime.effect(fn),
  effectScope(fn: () => void) {
    return runtime.effectScope(fn);
  },
  startBatch: () => runtime.startBatch(),
  endBatch: () => runtime.endBatch(),
  untracked: <T>(fn: () => T) => runtime.untracked(fn),
};
