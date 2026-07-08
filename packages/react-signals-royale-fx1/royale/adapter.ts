/**
 * RoyaleAdapter — the shared cross-entrant battery surface.
 */
import * as React from "react";
import * as ReactDOMClient from "react-dom/client";
import { flushSync } from "react-dom";
import { act } from "react";
import {
  atom,
  computed,
  effect,
  batch,
  untracked,
  latest,
  committed,
  isPending,
  refresh,
  read,
  update,
  serializeAtomState,
  initializeAtomState,
  startTrace,
  type Atom,
  type Computed,
  type Use,
} from "signals-royale-fx1";
import { register, resetForTest, startTransitionWrite, onDomMutation } from "../src/runtime";
import { useValue, useComputed, useSignalEffect, useIsPending, useCommitted } from "../src/hooks";

export interface RoyaleHandle {
  errors: unknown[];
  dispose(): void;
}
export interface RoyaleTraceView {
  whyLastDelivery(x: unknown): string[];
  events(): Array<{ id: number; kind: string; cause?: number }>;
  stop(): void;
}

const adapter = {
  slug: "fx1",
  React,
  ReactDOMClient: ReactDOMClient as unknown as {
    createRoot(el: Element): { render(node: unknown): void; unmount(): void };
  },
  act: act as <T>(fn: () => T | Promise<T>) => Promise<undefined>,
  flushSync(fn: () => void): void {
    flushSync(fn);
  },
  register(): RoyaleHandle {
    return register();
  },
  resetForTest,
  atom<T>(
    initial: T | (() => T),
    opts?: {
      equals?(a: T, b: T): boolean;
      onObserved?(ctx: { get(): T; set(v: T): void }): void | (() => void);
      label?: string;
    },
  ): unknown {
    return atom(initial, opts);
  },
  set(a: unknown, v: unknown): void {
    (a as Atom<unknown>).set(v);
  },
  update(a: unknown, fn: (prev: unknown) => unknown): void {
    update(a as Atom<unknown>, fn);
  },
  computed<T>(
    fn: (use: <U>(t: PromiseLike<U>) => U) => T,
    opts?: { equals?(a: T, b: T): boolean; label?: string },
  ): unknown {
    return computed(fn as (use: Use) => T, opts);
  },
  read(x: unknown): unknown {
    return read(x as Atom<unknown>);
  },
  latest(x: unknown): unknown {
    return latest(x as Atom<unknown>);
  },
  committed(x: unknown, container?: unknown): unknown {
    return committed(x as Atom<unknown>, container as object | undefined);
  },
  isPending(x: unknown): boolean {
    return isPending(x as Atom<unknown>);
  },
  refresh(x: unknown): void {
    refresh(x as Atom<unknown>);
  },
  effect(fn: () => void | (() => void)): () => void {
    return effect(fn);
  },
  batch(fn: () => void): void {
    batch(fn);
  },
  untracked<T>(fn: () => T): T {
    return untracked(fn);
  },
  serialize(atoms: unknown[]): string {
    return serializeAtomState(atoms as Array<Atom<unknown>>);
  },
  initialize(json: string, atoms: unknown[]): void {
    initializeAtomState(json, atoms as Array<Atom<unknown>>);
  },
  useValue(x: unknown): unknown {
    return useValue(x as Atom<unknown>);
  },
  useComputed<T>(fn: () => T, deps: unknown[]): T {
    return useComputed(fn, deps);
  },
  useSignalEffect,
  useIsPending(x: unknown): boolean {
    return useIsPending(x as Atom<unknown>);
  },
  useCommitted(x: unknown): unknown {
    return useCommitted(x as Atom<unknown>);
  },
  startTransitionWrite,
  trace(): RoyaleTraceView {
    const tracer = startTrace();
    return {
      whyLastDelivery(x: unknown): string[] {
        return tracer.whyLastDelivery(x as object);
      },
      events(): Array<{ id: number; kind: string; cause?: number }> {
        return tracer.events().map((e) => ({
          id: e.id,
          kind: e.kind,
          cause: e.cause === 0 ? undefined : e.cause,
        }));
      },
      stop(): void {
        tracer.stop();
      },
    };
  },
  onDomMutation,
};

export type RoyaleAdapter = typeof adapter;
export default adapter;

export type { Atom, Computed };
