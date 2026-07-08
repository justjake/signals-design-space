import * as React from 'react';
import * as ReactDOMClient from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Atom, Computed } from 'signals-royale-sm2';
import {
  getRuntime,
  onDomMutation,
  register,
  resetForTest,
  startTransitionWrite,
  trace,
  useCommitted,
  useComputed,
  useIsPending,
  useSignalEffect,
  useValue,
} from '../src/index';

type Readable = Atom<unknown> | Computed<unknown>;

const adapter = {
  slug: 'sm2',
  React,
  ReactDOMClient,
  async act<T>(fn: () => T | Promise<T>): Promise<undefined> {
    await React.act(fn);
    return undefined;
  },
  flushSync,
  register,
  resetForTest,
  atom<T>(
    initial: T | (() => T),
    options?: {
      equals?(a: T, b: T): boolean;
      onObserved?(ctx: { get(): T; set(value: T): void }): void | (() => void);
      label?: string;
    },
  ): Atom<T> {
    return getRuntime().atom(initial, {
      equals: options?.equals,
      effect: options?.onObserved,
      label: options?.label,
      key: options?.label,
    });
  },
  set(atom: unknown, value: unknown): void {
    (atom as Atom<unknown>).set(value);
  },
  update(atom: unknown, update: (previous: unknown) => unknown): void {
    (atom as Atom<unknown>).update(update);
  },
  computed<T>(
    fn: (use: <U>(promise: PromiseLike<U>) => U) => T,
    options?: { equals?(a: T, b: T): boolean; label?: string },
  ): Computed<T> {
    return getRuntime().computed(fn, options);
  },
  read(value: unknown): unknown {
    return (value as Readable).get();
  },
  latest(value: unknown): unknown {
    return getRuntime().latest(value as Readable);
  },
  committed(value: unknown, container?: unknown): unknown {
    return getRuntime().committed(value as Readable, container as object | undefined);
  },
  isPending(value: unknown): boolean {
    return getRuntime().isPending(value as Readable);
  },
  refresh(value: unknown): void {
    getRuntime().refresh(value as Readable);
  },
  effect(fn: () => void | (() => void)): () => void {
    return getRuntime().effect(fn);
  },
  batch(fn: () => void): void {
    getRuntime().batch(fn);
  },
  untracked<T>(fn: () => T): T {
    return getRuntime().untracked(fn);
  },
  serialize(atoms: unknown[]): string {
    const state: Record<string, unknown> = {};
    for (let i = 0; i < atoms.length; ++i) {
      const atom = atoms[i] as Atom<unknown>;
      state[atom.key ?? String(i)] = atom.peek();
    }
    return JSON.stringify(state);
  },
  initialize(json: string, atoms: unknown[]): void {
    const state = JSON.parse(json) as Record<string, unknown>;
    for (let i = 0; i < atoms.length; ++i) {
      const atom = atoms[i] as Atom<unknown>;
      const key = atom.key ?? String(i);
      if (Object.hasOwn(state, key)) atom.install(state[key]);
    }
  },
  useValue,
  useComputed,
  useSignalEffect,
  useIsPending,
  useCommitted,
  startTransitionWrite,
  trace,
  onDomMutation,
};

export default adapter;
