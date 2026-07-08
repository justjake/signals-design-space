import { expect, test } from "vitest";
import {
  __debug,
  atom,
  computed,
  effect,
  retireBatch,
  subscribe,
  type BatchToken,
} from "../src/index.js";

declare function setTimeout(callback: (...args: unknown[]) => void, delay: number): unknown;

async function collected(reference: WeakRef<object>): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pressure = new Array<object>(10_000);
    for (let index = 0; index < pressure.length; index++) pressure[index] = { index };
    globalThis.gc?.();
    if (reference.deref() === undefined) return true;
  }
  return false;
}

function droppedAtom(): WeakRef<object> {
  const value = atom({ payload: 1 });
  value.set({ payload: 2 });
  return new WeakRef(value);
}

function droppedComputed(source: ReturnType<typeof atom<number>>): WeakRef<object> {
  const value = computed(() => source.read() * 2);
  value.read();
  return new WeakRef(value);
}

function droppedEffect(source: ReturnType<typeof atom<number>>): WeakRef<object> {
  const dispose = effect(() => {
    source.read();
  });
  return new WeakRef(dispose);
}

function droppedSubscription(source: ReturnType<typeof atom<number>>): WeakRef<object> {
  const dispose = subscribe(source, () => {});
  return new WeakRef(dispose);
}

test("dropped atom and computed handles are reclaimable", async () => {
  if (globalThis.gc === undefined) throw new Error("GC test requires --expose-gc");
  const atomRef = droppedAtom();
  expect(await collected(atomRef)).toBe(true);

  const source = atom(1);
  const computedRef = droppedComputed(source);
  expect(source.subs.size).toBe(0);
  expect(await collected(computedRef)).toBe(true);
});

test("dropped effect and subscription disposers clean their retained graph links", async () => {
  const source = atom(0);
  expect(await collected(droppedEffect(source))).toBe(true);
  expect(await collected(droppedSubscription(source))).toBe(true);
  for (
    let attempt = 0;
    attempt < 50 && (source.subs.size !== 0 || __debug.listenerCount() !== 0);
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    globalThis.gc?.();
  }
  expect(source.subs.size).toBe(0);
  expect(__debug.listenerCount()).toBe(0);
});

test("retirement leaves no live operation episode", () => {
  const value = atom(0);
  const token: BatchToken = { id: 1, deferred: true, live: true, committed: false };
  value.set(1, token);
  expect(__debug.operations).toHaveLength(1);
  retireBatch(token, true);
  expect(__debug.operations).toHaveLength(0);
});

export {};
