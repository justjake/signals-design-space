import { expect, test, vi } from "vitest";
import {
  atom,
  batch,
  computed,
  effect,
  latest,
  isPending,
  refresh,
  retireBatch,
  trace,
  useThenable,
  withWorld,
  withWriteBatch,
} from "../src/index";

test("computed dependencies trim and equality cuts off effects", () => {
  const chooseLeft = atom(true);
  const left = atom(1);
  const right = atom(1);
  const selected = computed(
    () => (chooseLeft.get() ? left.get() : right.get()) & 1,
  );
  const values: number[] = [];
  const dispose = effect(() => {
    values.push(selected.get());
  });

  left.set(3);
  chooseLeft.set(false);
  left.set(4);
  right.set(2);
  expect(values).toEqual([1, 0]);
  dispose();
});

test("batch coalesces an effect flush", () => {
  const value = atom(0);
  const run = vi.fn(() => {
    value.get();
  });
  const dispose = effect(run);
  batch(() => {
    value.set(1);
    value.set(2);
  });
  expect(run).toHaveBeenCalledTimes(2);
  dispose();
});

test("lazy initializers run once at first materialization, including set", () => {
  const initialize = vi.fn(() => 1);
  const value = atom(initialize);
  expect(initialize).not.toHaveBeenCalled();
  value.set(2);
  expect(initialize).toHaveBeenCalledOnce();
  expect(value.get()).toBe(2);
});

test("lazy initializers are untracked and cannot write", () => {
  const target = atom(0);
  const source = atom(() => {
    target.set(1);
    return 2;
  });
  expect(() => source.get()).toThrow(/initializer/);
  expect(target.get()).toBe(0);
});

test("lifetime effects coalesce observation flaps", async () => {
  const starts: string[] = [];
  const value = atom(1, {
    effect: () => {
      starts.push("start");
      return () => starts.push("stop");
    },
  });
  const dispose = effect(() => {
    value.get();
  });
  dispose();
  const disposeAgain = effect(() => {
    value.get();
  });
  await Promise.resolve();
  expect(starts).toEqual(["start"]);
  disposeAgain();
  await Promise.resolve();
  expect(starts).toEqual(["start", "stop"]);
});

test("a deferred reducer replays over an urgent write", () => {
  const value = atom(1);
  withWriteBatch(8, () => value.update((previous) => previous * 2));
  expect(value.get()).toBe(1);
  expect(latest(value)).toBe(2);
  value.update((previous) => previous + 1);
  expect(value.get()).toBe(2);
  expect(withWorld({ lanes: 8, deferred: true }, () => value.get())).toBe(3);
  retireBatch(8, true);
  expect(value.get()).toBe(3);
});

test("an urgent reducer keeps its place after a deferred reducer", () => {
  const value = atom(1);
  withWriteBatch(8, () => value.update((previous) => previous + 1));
  value.update((previous) => previous * 2);
  expect(value.get()).toBe(2);
  retireBatch(8, true);
  expect(value.get()).toBe(4);
});

test("latest derives the newest world without changing canonical cache", () => {
  const source = atom(1);
  const derived = computed(() => source.get() * 10);
  expect(derived.get()).toBe(10);
  withWriteBatch(8, () => source.set(2));
  expect(derived.get()).toBe(10);
  expect(latest(derived)).toBe(20);
  retireBatch(8, false);
});

test("latest inside a computed resolves the evaluation world", () => {
  const source = atom(0);
  const derived = computed(() => latest(source) * 10);
  withWriteBatch(8, () => source.set(1));

  expect(derived.get()).toBe(0);
  expect(withWorld({ lanes: 8, deferred: true }, () => derived.get())).toBe(10);
  expect(latest(derived)).toBe(10);
  retireBatch(8, false);
});

test("discard removes a draft without touching canonical state", () => {
  const value = atom(1);
  withWriteBatch(16, () => value.set(9));
  retireBatch(16, false);
  expect(value.get()).toBe(1);
});

test("pending is graph state and all async reads register before suspension", async () => {
  let resolveOne!: (value: number) => void;
  let resolveTwo!: (value: number) => void;
  const one = new Promise<number>((resolve) => {
    resolveOne = resolve;
  });
  const two = new Promise<number>((resolve) => {
    resolveTwo = resolve;
  });
  const value = computed(() => useThenable(one) + useThenable(two));
  let first: unknown;
  try {
    value.get();
  } catch (error) {
    first = error;
  }
  let retry: unknown;
  try {
    value.get();
  } catch (error) {
    retry = error;
  }
  expect(retry).toBe(first);
  expect(isPending(value)).toBe(true);
  resolveOne(1);
  resolveTwo(2);
  await Promise.resolve();
  await Promise.resolve();
  expect(value.get()).toBe(3);
});

test("refresh serves stale while a replacement settles", async () => {
  let resolve!: (value: number) => void;
  let request = Promise.resolve(1);
  const value = computed(() => useThenable(request));
  let first: unknown;
  try {
    value.get();
  } catch (error) {
    first = error;
  }
  await first;
  expect(value.get()).toBe(1);
  request = new Promise<number>((done) => {
    resolve = done;
  });
  refresh(value);
  expect(value.get()).toBe(1);
  expect(isPending(value)).toBe(true);
  resolve(2);
  await Promise.resolve();
  await Promise.resolve();
  expect(value.get()).toBe(2);
});

test("trace explains an effect run back to its write", () => {
  const value = atom(0);
  const tracer = trace();
  const dispose = effect(() => {
    value.get();
  });
  value.set(1);
  expect(tracer.whyLastDelivery(dispose)).toEqual([
    "effect run",
    "write [batch 0]",
  ]);
  dispose();
  tracer.stop();
});
