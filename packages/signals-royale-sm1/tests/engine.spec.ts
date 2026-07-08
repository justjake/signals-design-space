import { describe, expect, it } from "vitest";
import {
  atom,
  computed,
  effect,
  initializeAtomState,
  installState,
  isPending,
  latest,
  read,
  refresh,
  serializeAtomState,
  startTrace,
} from "../src/index.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("engine features", () => {
  it("materializes lazy state once, untracked, before a first write", () => {
    const dependency = atom(1);
    let initializes = 0;
    const value = atom(() => {
      initializes++;
      return dependency.state + 4;
    });
    expect(initializes).toBe(0);
    value.set(9);
    expect(initializes).toBe(1);
    expect(value.state).toBe(9);
    dependency.set(2);
    expect(initializes).toBe(1);
    expect(value.state).toBe(9);
  });

  it("rejects writes from a lazy initializer and supports install without materializing", () => {
    const other = atom(0);
    const bad = atom(() => {
      other.set(1);
      return 2;
    });
    expect(() => bad.state).toThrow(/initializer must not write/);

    let initializes = 0;
    const installed = atom(() => {
      initializes++;
      return 1;
    });
    installState(installed, 7);
    expect(installed.state).toBe(7);
    expect(initializes).toBe(0);
  });

  it("coalesces lifetime observation across a computed chain", async () => {
    let starts = 0;
    let stops = 0;
    const source = atom(1, {
      effect() {
        starts++;
        return () => {
          stops++;
        };
      },
    });
    const doubled = computed(() => source.state * 2);
    const dispose = effect(() => {
      doubled.state;
    });
    await Promise.resolve();
    expect(starts).toBe(1);
    dispose();
    await Promise.resolve();
    expect(stops).toBe(1);
  });

  it("registers all parallel thenables and preserves the thrown identity", async () => {
    const first = deferred<number>();
    const second = deferred<number>();
    let evaluations = 0;
    const sum = computed((use) => {
      evaluations++;
      return use(first.promise) + use(second.promise);
    });
    let pending: unknown;
    try {
      read(sum);
    } catch (error) {
      pending = error;
    }
    expect(pending).toBeInstanceOf(Promise);
    let repeated: unknown;
    try {
      read(sum);
    } catch (error) {
      repeated = error;
    }
    expect(repeated).toBe(pending);
    expect(evaluations).toBe(1);
    first.resolve(2);
    second.resolve(3);
    await Promise.all([first.promise, second.promise]);
    await Promise.resolve();
    expect(read(sum)).toBe(5);
  });

  it("latest never suspends and keeps the enclosing computed in its own world", () => {
    const request = deferred<number>();
    const remote = computed(() => request.promise);
    const projection = computed(() => latest(remote) ?? -1);
    expect(latest(remote)).toBeUndefined();
    expect(projection.state).toBe(-1);
  });

  it("keeps stale data through an urgent refresh and uses a stable error", async () => {
    const requests = [deferred<string>(), deferred<string>()];
    let request = 0;
    const remote = computed(() => requests[request].promise);
    expect(() => read(remote)).toThrow(requests[0].promise);
    requests[0].resolve("one");
    await requests[0].promise;
    await Promise.resolve();
    expect(read(remote)).toBe("one");
    request = 1;
    refresh(remote);
    expect(read(remote)).toBe("one");
    expect(latest(remote)).toBe("one");
    expect(isPending(remote)).toBe(true);
    const failure = new Error("nope");
    requests[1].reject(failure);
    await requests[1].promise.catch(() => undefined);
    await Promise.resolve();
    expect(() => read(remote)).toThrow(failure);
    expect(() => read(remote)).toThrow(failure);
  });

  it("serializes keyed state with replacer and installs it with a reviver", () => {
    const source = atom(new Date("2026-01-02T00:00:00.000Z"), { key: "date" });
    const json = serializeAtomState({ date: source }, function (key, value) {
      return key === "date" ? { iso: (this as { date: Date }).date.toISOString() } : value;
    });
    let initializes = 0;
    const target = atom(() => {
      initializes++;
      return new Date(0);
    });
    initializeAtomState(json, { date: target }, (key, value) => {
      if (key === "date") return new Date((value as { iso: string }).iso);
      return value;
    });
    expect(target.state.toISOString()).toBe("2026-01-02T00:00:00.000Z");
    expect(initializes).toBe(0);
  });

  it("bounds trace memory and reports overflow", () => {
    const trace = startTrace(2);
    const value = atom(0);
    value.set(1);
    value.set(2);
    value.set(3);
    expect(trace.events()).toHaveLength(2);
    expect(trace.overflow).toBeGreaterThan(0);
    trace.stop();
  });
});
