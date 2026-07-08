import { describe, expect, it, vi } from "vitest";
import { createRuntime, initializeAtomState, installState, serializeAtomState } from "../src/index";

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("engine features", () => {
  it("materializes lazy atoms once on the first read or write", () => {
    const runtime = createRuntime();
    const initialize = vi.fn(() => 2);
    const value = runtime.atom(initialize);
    expect(initialize).not.toHaveBeenCalled();
    value.set(3);
    expect(initialize).toHaveBeenCalledOnce();
    expect(value.get()).toBe(3);
    value.get();
    expect(initialize).toHaveBeenCalledOnce();
  });

  it("forbids writes from lazy initializers", () => {
    const runtime = createRuntime();
    const target = runtime.atom(0);
    const value = runtime.atom(() => {
      target.set(1);
      return 2;
    });
    expect(() => value.get()).toThrow("initializer cannot write");
    expect(target.get()).toBe(0);
  });

  it("coalesces observation flaps across computed and effect subscribers", async () => {
    const runtime = createRuntime();
    const lifecycle: string[] = [];
    const source = runtime.atom(1, {
      effect() {
        lifecycle.push("start");
        return () => lifecycle.push("stop");
      },
    });
    const derived = runtime.computed(() => source.get() * 2);
    const disposeA = runtime.effect(() => {
      derived.get();
    });
    const disposeB = runtime.effect(() => {
      source.get();
    });
    disposeA();
    const disposeC = runtime.effect(() => {
      derived.get();
    });
    disposeB();
    await tick();
    expect(lifecycle).toEqual(["start"]);
    disposeC();
    await tick();
    expect(lifecycle).toEqual(["start", "stop"]);
  });

  it("registers all pending thenables and reuses their identities", async () => {
    const runtime = createRuntime();
    let resolveA!: (value: number) => void;
    let resolveB!: (value: number) => void;
    const a = new Promise<number>((resolve) => {
      resolveA = resolve;
    });
    const b = new Promise<number>((resolve) => {
      resolveB = resolve;
    });
    const value = runtime.computed((use) => (use(a) ?? 0) + (use(b) ?? 0));
    let first: unknown;
    let second: unknown;
    try {
      value.get();
    } catch (error) {
      first = error;
    }
    try {
      value.get();
    } catch (error) {
      second = error;
    }
    expect(first).toBe(second);
    resolveA(2);
    resolveB(3);
    await tick();
    expect(value.get()).toBe(5);
  });

  it("forwards pending graph state through downstream computeds", async () => {
    const runtime = createRuntime();
    let resolve!: (value: number) => void;
    const promise = new Promise<number>((done) => {
      resolve = done;
    });
    const source = runtime.computed((use) => use(promise));
    const downstream = runtime.computed(() => source.get() + 1);
    let pending: unknown;
    try {
      downstream.get();
    } catch (error) {
      pending = error;
    }
    expect(pending).toBe(promise);
    expect(runtime.isPending(downstream)).toBe(true);
    resolve(4);
    await tick();
    expect(downstream.get()).toBe(5);
  });

  it("serves stale data while an explicit refresh is pending", async () => {
    const runtime = createRuntime();
    let current = Promise.resolve("old");
    const value = runtime.computed((use) => use(current));
    expect(() => value.get()).toThrow();
    await tick();
    expect(value.get()).toBe("old");
    let resolve!: (value: string) => void;
    current = new Promise((done) => {
      resolve = done;
    });
    runtime.refresh(value);
    expect(runtime.isPending(value)).toBe(true);
    expect(runtime.latest(value)).toBe("old");
    resolve("new");
    await tick();
    expect(value.get()).toBe("new");
  });

  it("serializes keyed atoms and installs without running lazy initializers", () => {
    const runtime = createRuntime();
    const sourceA = runtime.atom(4, { key: "a" });
    const sourceB = runtime.atom("five", { key: "b" });
    const json = serializeAtomState([sourceA, sourceB], (_key, value) => value);
    const initialize = vi.fn(() => 0);
    const targetA = runtime.atom(initialize, { key: "a" });
    const targetB = runtime.atom("", { key: "b" });
    initializeAtomState(json, [targetA, targetB]);
    expect(initialize).not.toHaveBeenCalled();
    expect(targetA.get()).toBe(4);
    expect(targetB.get()).toBe("five");
    const third = runtime.atom(initialize);
    installState(third, 9);
    expect(third.get()).toBe(9);
    expect(initialize).not.toHaveBeenCalled();
  });
});
