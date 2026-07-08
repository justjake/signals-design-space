import * as React from 'react';
import { flushSync } from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import {
  asyncComputed,
  atom,
  batch,
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
  startTransitionWrite,
  trace,
  untracked,
  update,
  useCommitted,
  useComputed,
  useIsPending,
  useSignalEffect,
  useValue,
  committed,
  effect,
  type Cell,
} from '../src';

const adapter = {
  slug: 'sh2',
  React,
  ReactDOMClient,
  async act<T>(fn: () => T | Promise<T>): Promise<undefined> {
    await React.act(fn);
    return undefined;
  },
  flushSync,
  register,
  resetForTest,
  atom<T>(initial: T | (() => T), opts?: {
    equals?(a: T, b: T): boolean;
    onObserved?(ctx: { get(): T; set(v: T): void }): void | (() => void);
    label?: string;
  }): Cell<T> {
    return atom(initial, { equals: opts?.equals, effect: opts?.onObserved, label: opts?.label, key: opts?.label });
  },
  set(a: unknown, value: unknown) { set(a as Cell, value); },
  update(a: unknown, fn: (previous: unknown) => unknown) { update(a as Cell, fn); },
  computed<T>(fn: (use: <U>(thenable: PromiseLike<U>) => U) => T, opts?: {
    equals?(a: T, b: T): boolean;
    label?: string;
  }): Cell<T> {
    return asyncComputed(fn, opts);
  },
  read(x: unknown) { return read(x as Cell); },
  latest(x: unknown) { return latest(x as Cell); },
  committed(x: unknown, container?: unknown) { return committed(x as Cell, container as object | undefined); },
  isPending(x: unknown) { return isPending(x as Cell); },
  refresh(x: unknown) { refresh(x as Cell); },
  effect,
  batch,
  untracked,
  serialize(atoms: unknown[]) { return serializeAtomState(atoms as Cell[]); },
  initialize(json: string, atoms: unknown[]) { initializeAtomState(json, atoms as Cell[]); },
  useValue(x: unknown) { return useValue(x as Cell); },
  useComputed,
  useSignalEffect,
  useIsPending(x: unknown) { return useIsPending(x as Cell); },
  useCommitted(x: unknown) { return useCommitted(x as Cell); },
  startTransitionWrite,
  trace,
  onDomMutation,
};

export default adapter;
