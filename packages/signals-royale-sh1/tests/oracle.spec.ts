import { describe, expect, test } from "vitest";
import {
  activeTransactions,
  atom,
  latest,
  openTransaction,
  read,
  retireTransaction,
  runInTransaction,
  type Atom,
  type Transaction,
} from "../src/index";

declare const process: { env: Record<string, string | undefined> };

type Op =
  | { kind: "urgent-set"; atom: number; value: number }
  | { kind: "urgent-update"; atom: number; update: number }
  | { kind: "open" }
  | { kind: "draft-set"; tx: number; atom: number; value: number }
  | { kind: "draft-update"; tx: number; atom: number; update: number }
  | { kind: "retire"; tx: number; commit: boolean };

const updates = [
  (value: number) => value + 1,
  (value: number) => value * 2,
  (value: number) => value - 3,
];

function random(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let out = value;
    out = Math.imul(out ^ (out >>> 15), out | 1);
    out ^= out + Math.imul(out ^ (out >>> 7), out | 61);
    return ((out ^ (out >>> 14)) >>> 0) / 4294967296;
  };
}

function generate(seed: number, length: number): Op[] {
  const rng = random(seed);
  const live: number[] = [];
  let txCount = 0;
  const ops: Op[] = [];
  for (let step = 0; step < length; step++) {
    const roll = rng();
    const atom = Math.floor(rng() * 3);
    if (roll < 0.18 && live.length < 3) {
      live.push(txCount++);
      ops.push({ kind: "open" });
    } else if (roll < 0.38 && live.length !== 0) {
      ops.push({
        kind: "draft-set",
        tx: live[Math.floor(rng() * live.length)],
        atom,
        value: Math.floor(rng() * 20),
      });
    } else if (roll < 0.58 && live.length !== 0) {
      ops.push({
        kind: "draft-update",
        tx: live[Math.floor(rng() * live.length)],
        atom,
        update: Math.floor(rng() * updates.length),
      });
    } else if (roll < 0.7 && live.length !== 0) {
      const index = Math.floor(rng() * live.length);
      ops.push({ kind: "retire", tx: live[index], commit: rng() < 0.75 });
      live.splice(index, 1);
    } else if (roll < 0.84) {
      ops.push({ kind: "urgent-update", atom, update: Math.floor(rng() * updates.length) });
    } else {
      ops.push({ kind: "urgent-set", atom, value: Math.floor(rng() * 20) });
    }
  }
  return ops;
}

function run(ops: Op[]): string | undefined {
  const cells = [atom(1), atom(2), atom(3)];
  const base = [1, 2, 3];
  const engineTx: Transaction[] = [];
  const modelTx: Array<{
    writes: Array<{ atom: number; set?: number; update?: number }>;
    live: boolean;
  }> = [];
  const apply = (values: number[], write: { atom: number; set?: number; update?: number }) => {
    values[write.atom] =
      write.set === undefined ? updates[write.update!](values[write.atom]) : write.set;
  };
  for (let step = 0; step < ops.length; step++) {
    const op = ops[step];
    if (op.kind === "open") {
      engineTx.push(openTransaction());
      modelTx.push({ writes: [], live: true });
    } else if (op.kind === "urgent-set") {
      cells[op.atom].set(op.value);
      base[op.atom] = op.value;
    } else if (op.kind === "urgent-update") {
      cells[op.atom].update(updates[op.update]);
      base[op.atom] = updates[op.update](base[op.atom]);
      } else if (op.kind === "draft-set" || op.kind === "draft-update") {
        const write =
          op.kind === "draft-set"
            ? { atom: op.atom, set: op.value }
            : { atom: op.atom, update: op.update };
        let before = base[op.atom];
        for (const prior of modelTx[op.tx].writes) {
          if (prior.atom === op.atom) {
            before = prior.set === undefined ? updates[prior.update!](before) : prior.set;
          }
        }
        const after = write.set === undefined ? updates[write.update!](before) : write.set;
        if (!Object.is(before, after)) modelTx[op.tx].writes.push(write);
      runInTransaction(engineTx[op.tx], () => {
        if (op.kind === "draft-set") cells[op.atom].set(op.value);
        else cells[op.atom].update(updates[op.update]);
      });
    } else {
      const tx = modelTx[op.tx];
      tx.live = false;
      if (op.commit) for (const write of tx.writes) apply(base, write);
      retireTransaction(engineTx[op.tx], op.commit);
    }
    const newest = base.slice();
    for (const tx of modelTx) if (tx.live) for (const write of tx.writes) apply(newest, write);
    for (let index = 0; index < cells.length; index++) {
      if (read(cells[index]) !== base[index] || latest(cells[index]) !== newest[index]) {
        return `step ${step}, atom ${index}: canonical ${read(cells[index])}/${
          base[index]
        }, latest ${latest(cells[index])}/${newest[index]}`;
      }
    }
  }
  for (const tx of activeTransactions().slice()) retireTransaction(tx, false);
}

describe("STM replay oracle", () => {
  test("functional drafts rebase over urgent updates", () => {
    const value = atom(1);
    const tx = openTransaction();
    runInTransaction(tx, () => value.update((current) => current * 2));
    value.update((current) => current + 1);
    expect(value.state).toBe(2);
    retireTransaction(tx, true);
    expect(value.state).toBe(4);
  });

  test("aborted drafts never contaminate canonical state", () => {
    const value = atom(1);
    const tx = openTransaction();
    runInTransaction(tx, () => value.set(99));
    value.update((current) => current * 2);
    retireTransaction(tx, false);
    expect(value.state).toBe(2);
  });

  const seeds = Number(process.env.ORACLE_SEEDS ?? 300);
  const length = Number(process.env.ORACLE_LENGTH ?? 90);
  test(`matches a memo-free operation-log model for ${seeds} seeds x ${length} steps`, () => {
    for (let seed = 1; seed <= seeds; seed++) {
      const ops = generate(seed, length);
      const failure = run(ops);
      if (failure !== undefined) {
        let end = ops.length;
        while (end > 1 && run(ops.slice(0, end - 1)) !== undefined) end--;
        throw new Error(
          `seed ${seed}: ${failure}\nshrunk schedule: ${JSON.stringify(ops.slice(0, end))}`,
        );
      }
    }
  }, 30_000);
});
