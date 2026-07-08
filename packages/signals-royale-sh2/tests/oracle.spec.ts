import { expect, test } from "vitest";
import {
  atom,
  beginDraft,
  commitDrafts,
  enterRenderWorld,
  latest,
  leaveRenderWorld,
  read,
  reset,
  set,
  update,
  withDraft,
} from "../src";

const seedCount = Number(
  (globalThis as typeof globalThis & { process?: { env: Record<string, string | undefined> } })
    .process?.env.ORACLE_SEEDS ?? 300,
);

test(`randomized world-fold oracle (${seedCount} seeds x 90 steps)`, () => {
  for (let seed = 1; seed <= seedCount; seed++) {
    reset();
    let random = seed;
    const next = (limit: number) => {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      return random % limit;
    };
    const cells = [atom(0), atom(1), atom(2), atom(3)];
    const base = [0, 1, 2, 3];
    const worlds = new Map<number, Array<Array<[0 | 1, number]>>>();
    const schedule: string[] = [];
    try {
      for (let step = 0; step < 90; step++) {
        const operation = next(7);
        const slot = next(cells.length);
        const amount = next(9) - 4;
        if (operation === 0) {
          schedule.push(`set ${slot} ${amount}`);
          set(cells[slot], amount);
          base[slot] = amount;
        } else if (operation === 1) {
          schedule.push(`update ${slot} ${amount}`);
          update(cells[slot], (value) => value + amount);
          base[slot] += amount;
        } else if (operation === 2 || worlds.size === 0) {
          const id = beginDraft();
          worlds.set(id, [[], [], [], []]);
          schedule.push(`open ${id}`);
        } else if (operation === 3 || operation === 4) {
          const ids = [...worlds.keys()];
          const id = ids[next(ids.length)];
          schedule.push(
            `${operation === 3 ? "draft-update" : "draft-set"} ${id} ${slot} ${amount}`,
          );
          withDraft(id, () => {
            if (operation === 3) update(cells[slot], (value) => value + amount);
            else set(cells[slot], amount);
          });
          const actions = worlds.get(id)![slot];
          let current = base[slot];
          for (const [kind, value] of actions) current = kind === 1 ? current + value : value;
          if (operation === 3 || current !== amount)
            actions.push([operation === 3 ? 1 : 0, amount]);
        } else if (operation === 5) {
          const ids = [...worlds.keys()];
          const id = ids[next(ids.length)];
          schedule.push(`render ${id}`);
          enterRenderWorld([id]);
          for (let i = 0; i < cells.length; i++) {
            let expected = base[i];
            for (const [kind, value] of worlds.get(id)![i])
              expected = kind === 1 ? expected + value : value;
            expect(read(cells[i])).toBe(expected);
          }
          leaveRenderWorld();
        } else {
          const id = worlds.keys().next().value as number;
          schedule.push(`commit ${id}`);
          commitDrafts({}, [id]);
          for (let i = 0; i < cells.length; i++) {
            for (const [kind, value] of worlds.get(id)![i])
              base[i] = kind === 1 ? base[i] + value : value;
          }
          worlds.delete(id);
        }
        for (let i = 0; i < cells.length; i++) expect(read(cells[i])).toBe(base[i]);
        for (let i = 0; i < cells.length; i++) {
          let expected = base[i];
          for (const actions of worlds.values()) {
            for (const [kind, value] of actions[i])
              expected = kind === 1 ? expected + value : value;
          }
          expect(latest(cells[i])).toBe(expected);
        }
      }
    } catch (error) {
      throw new Error(`oracle seed ${seed}; minimal failing prefix:\n${schedule.join("\n")}`, {
        cause: error,
      });
    }
  }
});
