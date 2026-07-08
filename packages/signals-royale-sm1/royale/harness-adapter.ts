import { Atom, computed, effect, effectScope, startBatch, endBatch, untracked } from '../src/index.ts';

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

function createSignal<T>(initialValue: T): AdapterSignal<T> {
  const target = new Atom<T>(initialValue);
  return { read: () => target.state, write: (value: T) => target.set(value) };
}

function createComputed<T>(fn: () => T): AdapterComputed<T> {
  const target = computed(fn);
  return { read: () => target.state };
}

const adapter: FrameworkAdapter = {
  name: 'signals-royale-sm1',
  signal: createSignal,
  computed: createComputed,
  effect,
  effectScope,
  startBatch,
  endBatch,
  untracked,
};

export default adapter;
