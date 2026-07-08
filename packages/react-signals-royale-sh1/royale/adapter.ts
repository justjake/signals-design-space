import * as React from "react";
import { act } from "react";
import * as ReactDOMClient from "react-dom/client";
import { flushSync as reactFlushSync } from "react-dom";
import {
  Atom,
  atom,
  batch,
  committed,
  computed,
  effect,
  initializeAtomState,
  isPending,
  latest,
  onDomMutation,
  read,
  rebaseDeferredOverUrgent,
  refresh,
  register,
  resetForTest,
  serializeAtomState,
  startTransitionWrite,
  trace,
  untracked,
  useCommitted,
  useComputed,
  useIsPending,
  useSignalEffect,
  useValue,
} from "../src/index";

let atomSequence = 0;
const protocol = (React as unknown as { unstable_Signals: { world(): unknown } }).unstable_Signals;

const adapter = {
  slug: "sh1",
  React,
  ReactDOMClient,
  act: async <T>(fn: () => T | Promise<T>) => {
    await act(fn);
    return undefined;
  },
  flushSync: (fn: () => void) => rebaseDeferredOverUrgent(() => reactFlushSync(fn)),
  register,
  resetForTest() {
    atomSequence = 0;
    resetForTest();
  },
  atom<T>(
    initial: T | (() => T),
    options?: {
      equals?(a: T, b: T): boolean;
      onObserved?(ctx: { get(): T; set(value: T): void }): void | (() => void);
      label?: string;
    },
  ) {
    return atom(initial, {
      equals: options?.equals,
      effect: options?.onObserved,
      label: options?.label,
      key: options?.label ?? String(atomSequence++),
    });
  },
  set(cell: unknown, value: unknown) {
    if (protocol.world() !== null) throw new Error("Signals cannot be written during render");
    (cell as Atom<unknown>).set(value);
  },
  update(cell: unknown, fn: (prev: unknown) => unknown) {
    if (protocol.world() !== null) throw new Error("Signals cannot be written during render");
    (cell as Atom<unknown>).update(fn);
  },
  computed<T>(
    fn: (use: <U>(promise: PromiseLike<U>) => U) => T,
    options?: { equals?(a: T, b: T): boolean; label?: string },
  ) {
    return computed(fn, options);
  },
  read: (cell: unknown) => read(cell as Atom<unknown>),
  latest: (cell: unknown) => latest(cell as Atom<unknown>),
  committed: (cell: unknown, container?: object) => committed(cell as Atom<unknown>, container),
  isPending: (cell: unknown) => isPending(cell as Atom<unknown>),
  refresh: (cell: unknown) => refresh(cell as Atom<unknown>),
  effect,
  batch,
  untracked,
  serialize: (atoms: unknown[]) => serializeAtomState(atoms as Atom<unknown>[]),
  initialize: (json: string, atoms: unknown[]) =>
    initializeAtomState(json, atoms as Atom<unknown>[]),
  useValue: (cell: unknown) => useValue(cell as Atom<unknown>),
  useComputed,
  useSignalEffect,
  useIsPending: (cell: unknown) => useIsPending(cell as Atom<unknown>),
  useCommitted: (cell: unknown) => useCommitted(cell as Atom<unknown>),
  startTransitionWrite,
  trace,
  onDomMutation,
};

export default adapter;
