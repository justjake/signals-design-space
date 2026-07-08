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
    type Action = [kind: 0 | 1, value: number, sequence: number];
    interface World {
      actions: Action[][];
      bases: Array<number | undefined>;
    }
    const worlds = new Map<number, World>();
    const immediate: Action[][] = [[], [], [], []];
    let sequence = 0;
    const modelValue = (slot: number, selected: Iterable<World>) => {
      const ordered: Action[] = [];
      let first = Infinity;
      let value = base[slot];
      for (const world of selected) {
        const actions = world.actions[slot];
        if (actions.length !== 0 && actions[0][2] < first) {
          first = actions[0][2];
          value = world.bases[slot]!;
        }
        for (const action of actions) ordered.push(action);
      }
      if (first === Infinity) return value;
      for (const action of immediate[slot]) if (action[2] > first) ordered.push(action);
      ordered.sort((a, b) => a[2] - b[2]);
      for (const [kind, amount] of ordered) value = kind === 1 ? value + amount : amount;
      return value;
    };
    const schedule: string[] = [];
    try {
      for (let step = 0; step < 90; step++) {
        const operation = next(7);
        const slot = next(cells.length);
        const amount = next(9) - 4;
        if (operation === 0) {
          schedule.push(`set ${slot} ${amount}`);
          set(cells[slot], amount);
          for (const world of worlds.values()) {
            if (world.actions[slot].length === 0) continue;
            immediate[slot].push([0, amount, ++sequence]);
            break;
          }
          base[slot] = amount;
        } else if (operation === 1) {
          schedule.push(`update ${slot} ${amount}`);
          update(cells[slot], (value) => value + amount);
          for (const world of worlds.values()) {
            if (world.actions[slot].length === 0) continue;
            immediate[slot].push([1, amount, ++sequence]);
            break;
          }
          base[slot] += amount;
        } else if (operation === 2 || worlds.size === 0) {
          const id = beginDraft();
          worlds.set(id, { actions: [[], [], [], []], bases: [] });
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
          const world = worlds.get(id)!;
          const actions = world.actions[slot];
          const current = modelValue(slot, [world]);
          if (operation === 3 || current !== amount) {
            if (actions.length === 0) world.bases[slot] = base[slot];
            actions.push([operation === 3 ? 1 : 0, amount, ++sequence]);
          }
        } else if (operation === 5) {
          const ids = [...worlds.keys()];
          const id = ids[next(ids.length)];
          schedule.push(`render ${id}`);
          enterRenderWorld([id]);
          for (let i = 0; i < cells.length; i++) {
            expect(read(cells[i])).toBe(modelValue(i, [worlds.get(id)!]));
          }
          leaveRenderWorld();
        } else {
          const id = worlds.keys().next().value as number;
          schedule.push(`commit ${id}`);
          commitDrafts({}, [id]);
          for (let i = 0; i < cells.length; i++) base[i] = modelValue(i, [worlds.get(id)!]);
          worlds.delete(id);
          if (worlds.size === 0) for (const actions of immediate) actions.length = 0;
        }
        for (let i = 0; i < cells.length; i++) expect(read(cells[i])).toBe(base[i]);
        for (let i = 0; i < cells.length; i++) {
          expect(latest(cells[i])).toBe(modelValue(i, worlds.values()));
        }
      }
    } catch (error) {
      throw new Error(`oracle seed ${seed}; minimal failing prefix:\n${schedule.join("\n")}`, {
        cause: error,
      });
    }
  }
});
