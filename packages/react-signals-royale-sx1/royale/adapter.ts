import * as React from "react";
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
} from "../src/index.js";

interface Adapter {
  slug: string;
  React: typeof React;
  ReactDOMClient: typeof ReactDOMClient;
  act: typeof React.act;
  flushSync: typeof flushSync;
  register: typeof register;
  resetForTest: typeof resetForTest;
  atom<T>(
    initial: T | (() => T),
    options?: {
      equals?(a: T, b: T): boolean;
      onObserved?(ctx: { get(): T; set(value: T): void }): void | (() => void);
      label?: string;
    },
  ): unknown;
  set(value: unknown, next: unknown): void;
  update(value: unknown, fn: (previous: unknown) => unknown): void;
  computed<T>(
    fn: (use: <U>(promise: PromiseLike<U>) => U) => T,
    options?: {
      equals?(a: T, b: T): boolean;
      label?: string;
    },
  ): unknown;
  read(value: unknown): any;
  latest(value: unknown): any;
  committed(value: unknown, container?: unknown): any;
  isPending(value: unknown): boolean;
  refresh(value: unknown): void;
  effect: typeof effect;
  batch: typeof batch;
  untracked: typeof untracked;
  serialize(values: unknown[]): string;
  initialize(json: string, values: unknown[]): void;
  useValue(value: unknown): any;
  useComputed: typeof useComputed;
  useSignalEffect: typeof useSignalEffect;
  useIsPending(value: unknown): boolean;
  useCommitted(value: unknown): any;
  startTransitionWrite: typeof startTransitionWrite;
  trace(): {
    events(): Array<{ id: number; kind: string; cause?: number }>;
    whyLastDelivery(value: unknown): string[];
    stop(): void;
  };
  onDomMutation(listener: (phase: "start" | "stop", container: Element) => void): () => void;
}

const adapter = {
  slug: "sx1",
  React,
  ReactDOMClient,
  act: React.act,
  flushSync,
  register,
  resetForTest,
  atom(
    initial: unknown,
    options?: {
      equals?(a: unknown, b: unknown): boolean;
      onObserved?(ctx: { get(): unknown; set(value: unknown): void }): void | (() => void);
      label?: string;
    },
  ) {
    return atom(initial, {
      equals: options?.equals,
      effect: options?.onObserved,
      label: options?.label,
    });
  },
  set,
  update,
  computed,
  read,
  latest,
  committed,
  isPending,
  refresh,
  effect,
  batch,
  untracked,
  serialize: serializeAtomState,
  initialize: initializeAtomState,
  useValue,
  useComputed,
  useSignalEffect,
  useIsPending,
  useCommitted,
  startTransitionWrite,
  trace,
  onDomMutation,
} as unknown as Adapter;

export default adapter;
