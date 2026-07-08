import { describe, expect, it } from "vitest";
import { createRuntime, type Atom, type BatchId, type HostProtocol } from "../src/index";

function random(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = Math.imul(state ^ (state >>> 15), 1 | state);
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    return ((state ^ (state >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

interface ModelBatch {
  values: Map<number, number>;
}

describe("reducer-capsule oracle", () => {
  const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process
    ?.env;
  const seeds = Number(env?.ORACLE_SEEDS ?? 300);
  const steps = Number(env?.ORACLE_STEPS ?? 90);

  it(`matches a memo-free world-fold model for ${seeds} seeds x ${steps} steps`, () => {
    for (let seed = 1; seed <= seeds; ++seed) {
      const runtime = createRuntime();
      const canonical = [0, 1, 2, 3];
      const batches = new Map<BatchId, ModelBatch>();
      let writing = 0;
      let rendering: BatchId[] | null = null;
      const host: HostProtocol = {
        getCurrentWriteBatch: () => writing,
        getRenderBatches: () => rendering,
        getRenderContainer: () => null,
        runInBatch: (_id, fn) => fn(),
      };
      runtime.attachHost(host);
      const atoms = new Array<Atom<number>>(4);
      for (let i = 0; i < atoms.length; ++i) atoms[i] = runtime.atom(canonical[i]);
      const total = runtime.computed(() => {
        let value = 0;
        for (const atom of atoms) value += atom.get();
        return value;
      });
      const contextualLatestTotal = runtime.computed(() => {
        let value = 0;
        for (const atom of atoms) value += runtime.latest(atom);
        return value;
      });
      const history: string[] = [];
      const rng = random(seed);

      const modelRead = (index: number): number => {
        let value = canonical[index];
        if (rendering !== null) {
          for (const id of rendering) value = batches.get(id)?.values.get(index) ?? value;
        }
        return value;
      };
      const check = (label: string) => {
        for (let i = 0; i < atoms.length; ++i) {
          const actual = atoms[i].get();
          const expected = modelRead(i);
          if (actual !== expected) {
            throw new Error(
              `seed=${seed} ${label}: atom ${i}, expected ${expected}, got ${actual}\n` +
                `shrunk schedule:\n${history.join("\n")}`,
            );
          }
        }
        let expectedTotal = 0;
        for (let i = 0; i < atoms.length; ++i) expectedTotal += modelRead(i);
        const actualTotal = total.get();
        if (actualTotal !== expectedTotal) {
          throw new Error(
            `seed=${seed} ${label}: total expected ${expectedTotal}, got ${actualTotal}\n` +
              `shrunk schedule:\n${history.join("\n")}`,
          );
        }
        const actualLatestTotal = contextualLatestTotal.readWorld(rendering ?? []);
        if (actualLatestTotal !== expectedTotal) {
          throw new Error(
            `seed=${seed} ${label}: contextual latest expected ${expectedTotal}, ` +
              `got ${actualLatestTotal}\nshrunk schedule:\n${history.join("\n")}`,
          );
        }
      };

      for (let step = 0; step < steps; ++step) {
        const roll = rng();
        if (roll < 0.16 && batches.size < 3) {
          const id = runtime.allocateBatch(true);
          batches.set(id, { values: new Map() });
          history.push(`open ${id}`);
        } else if (roll < 0.51) {
          const index = Math.floor(rng() * atoms.length);
          const delta = Math.floor(rng() * 5) - 2;
          let id = 0;
          if (batches.size !== 0 && rng() < 0.55) {
            const offset = Math.floor(rng() * batches.size);
            let cursor = 0;
            for (const batchId of batches.keys()) {
              if (cursor++ === offset) {
                id = batchId;
                break;
              }
            }
          }
          writing = id;
          atoms[index].update((value: number) => value + delta);
          writing = 0;
          if (id === 0) {
            canonical[index] += delta;
            for (const batch of batches.values()) {
              const value = batch.values.get(index);
              if (value !== undefined) batch.values.set(index, value + delta);
            }
          } else {
            const batch = batches.get(id)!;
            batch.values.set(index, (batch.values.get(index) ?? canonical[index]) + delta);
          }
          history.push(`update a${index} ${delta >= 0 ? "+" : ""}${delta} @${id}`);
        } else if (roll < 0.67 && batches.size !== 0) {
          const id = batches.keys().next().value as BatchId;
          const committed = rng() < 0.75;
          runtime.retireBatch(id, committed);
          const batch = batches.get(id)!;
          if (committed) {
            for (const [index, value] of batch.values) canonical[index] = value;
          }
          batches.delete(id);
          history.push(`retire ${id} ${committed ? "commit" : "rollback"}`);
        } else {
          rendering = [];
          for (const id of batches.keys()) {
            if (rng() < 0.6) rendering.push(id);
          }
          history.push(`render [${rendering.join(",")}]`);
          check(`step ${step}`);
          rendering = null;
        }
        check(`step ${step} canonical`);
      }
    }
  });

  it("regression: urgent transforms replay through a live capsule", () => {
    const runtime = createRuntime();
    let batch = 0;
    runtime.attachHost({
      getCurrentWriteBatch: () => batch,
      getRenderBatches: () => null,
      getRenderContainer: () => null,
      runInBatch: (_id, fn) => fn(),
    });
    const count = runtime.atom(1);
    batch = runtime.allocateBatch(true);
    count.update((value) => value + 1);
    batch = 0;
    count.update((value) => value * 2);
    expect(count.get()).toBe(2);
    runtime.retireBatch(1, true);
    expect(count.get()).toBe(4);
  });

  it("regression: abandoning a capsule restores canonical state", () => {
    const runtime = createRuntime();
    let writing = runtime.allocateBatch(true);
    let rendering: BatchId[] | null = null;
    runtime.attachHost({
      getCurrentWriteBatch: () => writing,
      getRenderBatches: () => rendering,
      getRenderContainer: () => null,
      runInBatch: (_id, fn) => fn(),
    });
    const value = runtime.atom("old");
    value.set("draft");
    rendering = [writing];
    expect(value.get()).toBe("draft");
    rendering = null;
    writing = 0;
    runtime.retireBatch(1, false);
    expect(value.get()).toBe("old");
  });
});
