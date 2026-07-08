import { expect, test } from "vitest";
import { atom, liveBatchIds, retireBatch, withWriteBatch } from "../src/index";

test("dropped cells reclaim and retired episodes leave no live batches", async () => {
  if (globalThis.gc === undefined) throw new Error("test requires --expose-gc");
  let reference!: WeakRef<object>;
  (() => {
    const cell = atom(1);
    reference = new WeakRef(cell);
    withWriteBatch(8, () => cell.set(2));
    retireBatch(8, false);
  })();
  for (let attempt = 0; attempt < 20; attempt++) {
    globalThis.gc();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(reference.deref()).toBeUndefined();
  expect(liveBatchIds()).toEqual([]);
});
