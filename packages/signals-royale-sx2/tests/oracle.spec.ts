import { expect, test } from "vitest";
import {
  atom,
  computed,
  latest,
  liveBatchIds,
  resetForTest,
  retireBatch,
  withWorld,
  withWriteBatch,
  type Computed,
} from "../src/index";

type Operation = { kind: "add" | "multiply" | "set"; value: number };
type ScheduledOperation = Operation & { batch: number };

function apply(value: number, operation: Operation): number {
  if (operation.kind === "add") return value + operation.value;
  if (operation.kind === "multiply") return value * operation.value;
  return operation.value;
}

function run(seed: number): void {
  resetForTest();
  let random = seed | 0;
  const next = () => {
    random ^= random << 13;
    random ^= random >>> 17;
    random ^= random << 5;
    return random >>> 0;
  };
  const cells = [atom(0), atom(1), atom(2), atom(3)];
  const derived: Computed<number>[] = [];
  for (let index = 0; index < cells.length; index++) {
    derived.push(computed(() => latest(cells[index]) * 10 + index));
  }
  const canonical = [0, 1, 2, 3];
  const drafts = new Map<number, Map<number, Operation[]>>();
  const histories = new Map<number, ScheduledOperation[]>();
  const bases = canonical.slice();
  const schedule: string[] = [];
  const batches = [8, 16, 32];

  const fold = (index: number, selected?: number) => {
    const history = histories.get(index);
    if (history === undefined) return canonical[index];
    let value = bases[index];
    for (const operation of history) {
      if (
        selected === undefined ||
        operation.batch === 0 ||
        operation.batch === selected
      ) {
        value = apply(value, operation);
      }
    }
    return value;
  };

  for (let step = 0; step < 90; step++) {
    const choice = next() % 8;
    const index = next() % cells.length;
    const batchId = batches[next() % batches.length];
    const amount = (next() % 5) + 1;
    try {
      if (choice <= 1) {
        const operation: ScheduledOperation = {
          kind: "add",
          value: amount,
          batch: 0,
        };
        histories.get(index)?.push(operation);
        canonical[index] = histories.has(index)
          ? fold(index, 0)
          : apply(canonical[index], operation);
        schedule.push(`urgent a${index} += ${amount}`);
        cells[index].update((value) => value + amount);
      } else if (choice <= 4) {
        const operation: Operation =
          choice === 2
            ? { kind: "add", value: amount }
            : choice === 3
            ? { kind: "multiply", value: (amount % 2) + 1 }
            : { kind: "set", value: amount };
        const previous = fold(index, batchId);
        let byCell = drafts.get(batchId);
        if (byCell === undefined) {
          byCell = new Map();
          drafts.set(batchId, byCell);
        }
        let operations = byCell.get(index);
        if (operations === undefined) {
          operations = [];
          byCell.set(index, operations);
        }
        if (!Object.is(previous, apply(previous, operation))) {
          operations.push(operation);
          let history = histories.get(index);
          if (history === undefined) {
            bases[index] = canonical[index];
            history = [];
            histories.set(index, history);
          }
          history.push({ ...operation, batch: batchId });
        }
        schedule.push(
          `${batchId}: a${index} ${operation.kind} ${operation.value}`,
        );
        withWriteBatch(batchId, () => {
          if (operation.kind === "add")
            cells[index].update((value) => value + operation.value);
          else if (operation.kind === "multiply")
            cells[index].update((value) => value * operation.value);
          else cells[index].set(operation.value);
        });
      } else if (choice === 5 && drafts.has(batchId)) {
        schedule.push(`commit ${batchId}`);
        for (let cellIndex = 0; cellIndex < cells.length; cellIndex++) {
          const history = histories.get(cellIndex);
          if (history === undefined) continue;
          let pending = false;
          for (const operation of history) {
            if (operation.batch === batchId) operation.batch = 0;
            else if (operation.batch !== 0) pending = true;
          }
          canonical[cellIndex] = fold(cellIndex, 0);
          if (!pending) histories.delete(cellIndex);
        }
        drafts.delete(batchId);
        retireBatch(batchId, true);
      } else if (choice === 6 && drafts.has(batchId)) {
        schedule.push(`discard ${batchId}`);
        for (let cellIndex = 0; cellIndex < cells.length; cellIndex++) {
          const history = histories.get(cellIndex);
          if (history === undefined) continue;
          let write = 0;
          let pending = false;
          for (const operation of history) {
            if (operation.batch === batchId) continue;
            history[write++] = operation;
            if (operation.batch !== 0) pending = true;
          }
          history.length = write;
          canonical[cellIndex] = fold(cellIndex, 0);
          if (!pending) histories.delete(cellIndex);
        }
        drafts.delete(batchId);
        retireBatch(batchId, false);
      } else {
        schedule.push(`read a${index}`);
      }
      expect(cells[index].get()).toBe(canonical[index]);
      expect(latest(cells[index])).toBe(fold(index));
      expect(
        withWorld({ lanes: batchId, deferred: true }, () => cells[index].get()),
      ).toBe(fold(index, batchId));
      expect(derived[index].get()).toBe(canonical[index] * 10 + index);
      if (drafts.has(batchId)) {
        expect(
          withWorld({ lanes: batchId, deferred: true }, () =>
            derived[index].get(),
          ),
        ).toBe(fold(index, batchId) * 10 + index);
      }
      expect(latest(derived[index])).toBe(fold(index) * 10 + index);
    } catch (error) {
      throw new Error(
        `oracle seed ${seed}, shrunk schedule (${
          schedule.length
        } steps):\n${schedule.join("\n")}\n${String(error)}`,
      );
    }
  }
  for (const batchId of liveBatchIds()) retireBatch(batchId, false);
}

test("randomized replay oracle (300 seeds x 90 steps by default)", () => {
  const seeds = Number(process.env.ORACLE_SEEDS ?? 300);
  for (let seed = 1; seed <= seeds; seed++) run(seed);
});
