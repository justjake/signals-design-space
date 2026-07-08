import { describe, expect, test, vi } from "vitest";
import {
  activeTransactions,
  atom,
  computed,
  effect,
  initializeAtomState,
  isPending,
  latest,
  read,
  serializeAtomState,
  subscribeNode,
  trace,
} from "../src/index";

describe("engine features", () => {
  test("lazy initialization happens once, before set, and cannot write", () => {
    const initialize = vi.fn(() => 1);
    const value = atom(initialize);
    expect(initialize).not.toHaveBeenCalled();
    value.set(2);
    expect(initialize).toHaveBeenCalledOnce();
    expect(value.state).toBe(2);
    const other = atom(0);
    const bad = atom(() => {
      other.set(1);
      return 1;
    });
    expect(() => bad.state).toThrow("cannot write");
  });

  test("installState skips lazy initializers and round-trips keyed state", () => {
    const initialize = vi.fn(() => 1);
    const source = atom(7, { key: "count" });
    const json = serializeAtomState([source]);
    const target = atom(initialize, { key: "count" });
    initializeAtomState(json, [target]);
    expect(target.state).toBe(7);
    expect(initialize).not.toHaveBeenCalled();
  });

  test("lifetime effects span computed and effect subscribers without flapping", async () => {
    let starts = 0;
    let stops = 0;
    const source = atom(1, {
      effect: () => {
        starts++;
        return () => {
          stops++;
        };
      },
    });
    const derived = computed(() => source.state * 2);
    const dispose = effect(() => {
      derived.state;
    });
    expect(starts).toBe(1);
    dispose();
    const unsubscribe = subscribeNode(source, () => {});
    unsubscribe();
    await Promise.resolve();
    expect(stops).toBe(1);
  });

  test("pending is graph state: parallel reads register and retries reuse one join", async () => {
    let resolveA!: (value: number) => void;
    let resolveB!: (value: number) => void;
    const a = new Promise<number>((resolve) => {
      resolveA = resolve;
    });
    const b = new Promise<number>((resolve) => {
      resolveB = resolve;
    });
    let evaluations = 0;
    const value = computed((use) => {
      evaluations++;
      return use(a) + use(b);
    });
    expect(() => latest(value)).not.toThrow();
    expect(isPending(value)).toBe(true);
    let first: unknown;
    let second: unknown;
    try {
      read(value);
    } catch (error) {
      first = error;
    }
    try {
      read(value);
    } catch (error) {
      second = error;
    }
    expect(first).toBe(second);
    expect(evaluations).toBe(1);
    resolveA(2);
    resolveB(3);
    await Promise.all([a, b]);
    await Promise.resolve();
    expect(read(value)).toBe(5);
  });

  test("tracing has causal parents and bounded overflow accounting", () => {
    const tracer = trace(2);
    const value = atom(0);
    value.set(1);
    value.set(2);
    value.set(3);
    expect(tracer.events()).toHaveLength(2);
    expect(tracer.overflow).toBe(1);
    tracer.stop();
  });

  test("transaction episodes are reclaimed at quiescence", () => {
    expect(activeTransactions()).toHaveLength(0);
  });
});
