import { expect, test } from "vitest";
import {
  atom,
  latest,
  liveBatchIds,
  resetForTest,
  retireBatch,
  withWorld,
  withWriteBatch,
} from "../src/index";

type Operation = { kind: "add" | "multiply" | "set"; value: number };

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
  const canonical = [0, 1, 2, 3];
  const drafts = new Map<number, Map<number, Operation[]>>();
  const order: number[] = [];
  const schedule: string[] = [];
  const batches = [8, 16, 32];

  const fold = (index: number, selected?: number) => {
    let value = canonical[index];
    for (const batchId of order) {
      if (selected !== undefined && selected !== batchId) continue;
      const operations = drafts.get(batchId)?.get(index);
      if (operations !== undefined) {
        for (const operation of operations) value = apply(value, operation);
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
        canonical[index] += amount;
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
          order.push(batchId);
        }
        let operations = byCell.get(index);
        if (operations === undefined) {
          operations = [];
          byCell.set(index, operations);
        }
        if (!Object.is(previous, apply(previous, operation)))
          operations.push(operation);
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
          canonical[cellIndex] = fold(cellIndex, batchId);
        }
        drafts.delete(batchId);
        order.splice(order.indexOf(batchId), 1);
        retireBatch(batchId, true);
      } else if (choice === 6 && drafts.has(batchId)) {
        schedule.push(`discard ${batchId}`);
        drafts.delete(batchId);
        order.splice(order.indexOf(batchId), 1);
        retireBatch(batchId, false);
      } else {
        schedule.push(`read a${index}`);
      }
      expect(cells[index].get()).toBe(canonical[index]);
      expect(latest(cells[index])).toBe(fold(index));
      expect(
        withWorld({ lanes: batchId, deferred: true }, () => cells[index].get()),
      ).toBe(fold(index, batchId));
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

test("randomized replay oracle", () => {
  const seeds = Number(process.env.ORACLE_SEEDS ?? 300);
  for (let seed = 1; seed <= seeds; seed++) run(seed);
});
