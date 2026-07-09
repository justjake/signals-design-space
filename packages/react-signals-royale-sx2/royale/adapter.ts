import * as React from "react";
import { act } from "react";
import * as ReactDOMClient from "react-dom/client";
import { flushSync } from "react-dom";
import {
  atom,
  batch,
  committed,
  computed,
  effect,
  initializeAtomState,
  isPending,
  latest,
  read,
  refresh,
  resetForTest as resetEngineForTest,
  serializeAtomState,
  trace,
  untracked,
  useThenable,
  withWriteBatch,
  type Atom,
  type Computed,
} from "signals-royale-sx2";
import {
  onDomMutation,
  reduce,
  register,
  resetBindingForTest,
  startTransitionWrite,
  useCommitted,
  useComputed,
  useIsPending,
  useSignalEffect,
  useValue,
  write,
} from "../src/index";

type Cell<T = unknown> = Atom<T> | Computed<T>;

export default {
  slug: "sx2",
  React,
  ReactDOMClient,
  act,
  flushSync,
  register,
  resetForTest() {
    resetBindingForTest();
    resetEngineForTest();
  },
  atom<T>(
    initial: T | (() => T),
    options?: {
      equals?(a: T, b: T): boolean;
      onObserved?(context: {
        get(): T;
        set(value: T): void;
      }): void | (() => void);
      label?: string;
    },
  ) {
    return atom(initial, {
      equals: options?.equals,
      onObserved: options?.onObserved,
      label: options?.label,
    });
  },
  set(cell: unknown, value: unknown) {
    write(cell as Atom<unknown>, value);
  },
  update(cell: unknown, fn: (previous: unknown) => unknown) {
    reduce(cell as Atom<unknown>, fn);
  },
  computed<T>(
    fn: (use: <U>(thenable: PromiseLike<U>) => U) => T,
    options?: { equals?(a: T, b: T): boolean; label?: string },
  ) {
    return computed(() => fn(useThenable), options);
  },
  read(cell: unknown) {
    return read(cell as Cell);
  },
  latest(cell: unknown) {
    return latest(cell as Cell);
  },
  committed(cell: unknown, container?: unknown) {
    return committed(cell as Cell, container as object | undefined);
  },
  isPending(cell: unknown) {
    return isPending(cell as Cell);
  },
  refresh(cell: unknown) {
    const internals = (
      React as unknown as {
        __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
          L: { getWriteLane(): number };
        };
      }
    ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const lane = internals.L.getWriteLane() as number;
    withWriteBatch(lane, () => refresh(cell as Cell));
  },
  effect,
  batch,
  untracked,
  serialize(atoms: unknown[]) {
    return serializeAtomState(atoms as Atom<unknown>[]);
  },
  initialize(json: string, atoms: unknown[]) {
    initializeAtomState(json, atoms as Atom<unknown>[]);
  },
  useValue(cell: unknown) {
    return useValue(cell as Cell);
  },
  useComputed,
  useSignalEffect,
  useIsPending(cell: unknown) {
    return useIsPending(cell as Cell);
  },
  useCommitted(cell: unknown) {
    return useCommitted(cell as Cell);
  },
  startTransitionWrite,
  trace() {
    const tracer = trace();
    return {
      whyLastDelivery(cell: unknown) {
        return tracer.whyLastDelivery(cell as object);
      },
      events() {
        return tracer.events();
      },
      stop() {
        tracer.stop();
      },
    };
  },
  onDomMutation,
};
