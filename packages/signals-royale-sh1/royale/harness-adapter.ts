import { computed, effect, effectScope, endBatch, startBatch, atom, untracked } from "../src/index";

export default {
  name: "signals-royale-sh1",
  signal<T>(initialValue: T) {
    const value = atom(initialValue);
    return { read: () => value.state, write: (next: T) => value.set(next) };
  },
  computed<T>(fn: () => T) {
    const value = computed(fn);
    return { read: () => value.state };
  },
  effect,
  effectScope,
  startBatch,
  endBatch,
  untracked,
};
