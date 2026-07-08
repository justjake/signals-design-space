import { expect, test } from "vitest";
import { atom, computed, effect } from "../src/index";

declare const global: { gc?: () => void };
declare function setTimeout(callback: () => void, delay: number): unknown;

test("dropped computed handles are reclaimable", async () => {
  if (global.gc === undefined) throw new Error("GC test requires --expose-gc");
  let reference!: WeakRef<object>;
  (() => {
    const source = atom(1);
    const derived = computed(() => source.state + 1);
    derived.state;
    reference = new WeakRef(derived);
  })();
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    global.gc();
  }
  expect(reference.deref()).toBeUndefined();
});

test("a dropped effect disposer releases its graph subscription", async () => {
  if (global.gc === undefined) throw new Error("GC test requires --expose-gc");
  let stops = 0;
  const source = atom(1, {
    effect: () => () => {
      stops++;
    },
  });
  (() => {
    effect(() => {
      source.state;
    });
  })();
  for (let attempt = 0; attempt < 50 && stops === 0; attempt++) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    global.gc();
  }
  await Promise.resolve();
  expect(stops).toBe(1);
});
