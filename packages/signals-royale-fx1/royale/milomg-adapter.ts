/**
 * ReactiveFramework adapter for the milomg js-reactivity-benchmark.
 */
import {
  atom,
  computed,
  effect,
  effectScope,
  startBatch,
  endBatch,
  type Atom,
  type Computed,
} from 'signals-royale-fx1';

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

type Cell = Atom<unknown> | Computed<unknown>;

let scopeDispose: (() => void) | null = null;

export const royaleFx1Framework: ReactiveFramework<Cell> = {
  name: 'Royale FX1',
  createSignal: (initialValue) => atom(initialValue),
  readSignal: (s) => (s as Atom<unknown>).get(),
  writeSignal: (s, value) => {
    (s as Atom<unknown>).set(value);
  },
  createComputed: (fn) => computed(fn),
  readComputed: (c) => (c as Computed<unknown>).get(),
  effect: (fn) => {
    effect(fn);
  },
  withBatch: (fn) => {
    startBatch();
    fn();
    endBatch();
  },
  withBuild: <T>(fn: () => T): T => {
    let out!: T;
    scopeDispose = effectScope(() => {
      out = fn();
    });
    return out;
  },
  cleanup: () => {
    // Dispose the whole graph the build created: no leaks in the bench.
    scopeDispose!();
    scopeDispose = null;
  },
};

export default royaleFx1Framework;
