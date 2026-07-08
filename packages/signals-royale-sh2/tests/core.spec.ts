import { describe, expect, test, vi } from "vitest";
import {
  atom,
  batch,
  computed,
  effect,
  initializeAtomState,
  read,
  serializeAtomState,
  set,
  update,
} from "../src";

describe("slab engine", () => {
  test("lazy atoms initialize once before a set", () => {
    const initialize = vi.fn(() => 2);
    const value = atom(initialize);
    expect(initialize).not.toHaveBeenCalled();
    set(value, 3);
    expect(initialize).toHaveBeenCalledOnce();
    expect(read(value)).toBe(3);
  });

  test("dynamic computed dependencies are trimmed", () => {
    const left = atom(1);
    const right = atom(2);
    const chooseLeft = atom(true);
    const calls = vi.fn(() => (read(chooseLeft) ? read(left) : read(right)));
    const selected = computed(calls);
    expect(read(selected)).toBe(1);
    set(chooseLeft, false);
    expect(read(selected)).toBe(2);
    set(left, 3);
    expect(read(selected)).toBe(2);
    expect(calls).toHaveBeenCalledTimes(2);
  });

  test("effects coalesce across a batch", () => {
    const value = atom(0);
    const seen: number[] = [];
    effect(() => {
      seen.push(read(value));
    });
    batch(() => {
      set(value, 1);
      update(value, (x) => x + 1);
    });
    expect(seen).toEqual([0, 2]);
  });

  test("state round trips by app keys", () => {
    const first = atom(1, { key: "first" });
    const json = serializeAtomState([first]);
    const second = atom(0, { key: "first" });
    initializeAtomState(json, [second]);
    expect(read(second)).toBe(1);
  });
});
