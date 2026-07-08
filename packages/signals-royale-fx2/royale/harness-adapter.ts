/** FrameworkAdapter for the shared conformance/bench harness. */
import {
  Computed,
  Signal,
  computed,
  effect,
  effectScope,
  endBatch,
  signal,
  startBatch,
  untracked,
} from '../src/index.ts';

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
  name: 'signals-royale-fx2',
  signal<T>(initialValue: T): AdapterSignal<T> {
    // The engine treats function-valued initials as lazy initializers; the
    // harness stores plain values, including functions, so opt out here.
    const s: Signal<T> = new Signal(initialValue, undefined);
    if (typeof initialValue === 'function') {
      s.node.initializer = undefined;
      s.node.value = initialValue;
    }
    return {
      read: () => s.get(),
      write: (value: T) => s.set(value),
    };
  },
  computed<T>(fn: () => T): AdapterComputed<T> {
    const c: Computed<T> = computed(fn);
    return { read: () => c.get() };
  },
  effect,
  effectScope,
  startBatch,
  endBatch,
  untracked,
};

export default adapter;
