import { expect, test, vi } from "vitest";
import {
  atom,
  batch,
  computed,
  effect,
  latest,
  retireBatch,
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
  expect(withWorld({ lanes: 8, deferred: true }, () => value.get())).toBe(4);
  retireBatch(8, true);
  expect(value.get()).toBe(4);
});

test("discard removes a draft without touching canonical state", () => {
  const value = atom(1);
  withWriteBatch(16, () => value.set(9));
  retireBatch(16, false);
  expect(value.get()).toBe(1);
});
