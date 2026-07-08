import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  atom,
  batch,
  committed,
  computed,
  effect,
  flushSync,
  initializeAtomState,
  isPending,
  latest,
  onDomMutation,
  read,
  refresh,
  register,
  resetForTest,
  serializeAtomState,
  set,
  startTrace,
  startTransitionWrite,
  untracked,
  update,
  useCommitted,
  useComputed,
  useIsPending,
  useSignalEffect,
  useValue,
  type Atom,
  type Computed,
} from '../src/index.ts';

export interface RoyaleHandle {
  errors: unknown[];
  dispose(): void;
}

export interface RoyaleTraceView {
  whyLastDelivery(x: unknown): string[];
  events(): Array<{ id: number; kind: string; cause?: number }>;
  stop(): void;
}

export interface RoyaleAdapter {
  slug: string;
  React: any;
  ReactDOMClient: { createRoot: typeof createRoot };
  act<T>(fn: () => T | Promise<T>): Promise<undefined>;
  flushSync(fn: () => void): void;
  register(): RoyaleHandle;
  resetForTest(): void;
  atom<T>(
    initial: T | (() => T),
    options?: {
      equals?(a: T, b: T): boolean;
      onObserved?(ctx: { get(): T; set(value: T): void }): void | (() => void);
      label?: string;
    },
  ): unknown;
  set(target: unknown, value: unknown): void;
  update(target: unknown, fn: (previous: unknown) => unknown): void;
  computed<T>(
    fn: (use: <U>(thenable: PromiseLike<U>) => U) => T,
    options?: { equals?(a: T, b: T): boolean; label?: string },
  ): unknown;
  read(target: unknown): unknown;
  latest(target: unknown): unknown;
  committed(target: unknown, container?: unknown): unknown;
  isPending(target: unknown): boolean;
  refresh(target: unknown): void;
  effect(fn: () => void | (() => void)): () => void;
  batch(fn: () => void): void;
  untracked<T>(fn: () => T): T;
  serialize(atoms: unknown[]): string;
  initialize(json: string, atoms: unknown[]): void;
  useValue(target: unknown): unknown;
  useComputed<T>(fn: () => T, dependencies: unknown[]): T;
  useSignalEffect(fn: () => void | (() => void)): void;
  useIsPending(target: unknown): boolean;
  useCommitted(target: unknown): unknown;
  startTransitionWrite(scope: () => void): void;
  trace(): RoyaleTraceView;
  onDomMutation(callback: (phase: 'start' | 'stop', container: Element) => void): () => void;
}

type Cell<T = unknown> = Atom<T> | Computed<T>;

const adapter: RoyaleAdapter = {
  slug: 'sm1',
  React,
  ReactDOMClient: { createRoot },
  act: act as RoyaleAdapter['act'],
  flushSync,
  register,
  resetForTest,
  atom(initial, options) {
    return atom(initial, {
      equals: options?.equals,
      effect: options?.onObserved,
      label: options?.label,
    });
  },
  set(target, value) {
    set(target as Atom<unknown>, value);
  },
  update(target, fn) {
    update(target as Atom<unknown>, fn);
  },
  computed,
  read(target) {
    return read(target as Cell);
  },
  latest(target) {
    return latest(target as Cell);
  },
  committed(target, container) {
    return committed(target as Cell, container as object | undefined);
  },
  isPending(target) {
    return isPending(target as Cell);
  },
  refresh(target) {
    refresh(target as Computed<unknown>);
  },
  effect,
  batch,
  untracked,
  serialize(atoms) {
    return serializeAtomState(atoms as Atom<unknown>[]);
  },
  initialize(json, atoms) {
    initializeAtomState(json, atoms as Atom<unknown>[]);
  },
  useValue(target) {
    return useValue(target as Cell);
  },
  useComputed,
  useSignalEffect,
  useIsPending(target) {
    return useIsPending(target as Cell);
  },
  useCommitted(target) {
    return useCommitted(target as Cell);
  },
  startTransitionWrite,
  trace() {
    return startTrace();
  },
  onDomMutation,
};

export default adapter;
