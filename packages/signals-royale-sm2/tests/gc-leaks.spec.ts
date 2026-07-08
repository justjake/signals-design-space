import { expect, it } from "vitest";
import { createRuntime, type Atom, type Runtime } from "../src/index";

const gc = (globalThis as { gc?: () => void }).gc;

async function collect(reference: WeakRef<object>): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 100; ++i) {
    const pressure = new Array(10_000);
    pressure.fill(i);
    gc?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return reference.deref() === undefined;
}

function droppedComputed(runtime: Runtime, source: Atom<number>): WeakRef<object> {
  const computed = runtime.computed(() => source.get() + 1);
  expect(computed.get()).toBe(2);
  return new WeakRef(computed);
}

it("reclaims dropped computed handles and clears retired episode state", async () => {
  expect(gc).toBeTypeOf("function");
  const runtime = createRuntime();
  const source = runtime.atom(1);
  const reference = droppedComputed(runtime, source);
  expect(await collect(reference)).toBe(true);

  const batch = runtime.allocateBatch(true);
  runtime.retireBatch(batch, false);
  expect(runtime.liveBatchCount()).toBe(0);
});

it("finalizes a dropped standalone effect handle", async () => {
  const runtime = createRuntime();
  const source = runtime.atom(0);
  let runs = 0;
  const reference = (() => {
    const dispose = runtime.effect(() => {
      source.get();
      ++runs;
    });
    return new WeakRef(dispose);
  })();
  expect(runs).toBe(1);
  expect(await collect(reference)).toBe(true);
  for (let i = 0; i < 10 && source.subscribers.size !== 0; ++i) {
    gc?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(source.subscribers.size).toBe(0);
  source.set(1);
  expect(runs).toBe(1);
});
