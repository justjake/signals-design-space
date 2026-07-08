import { describe, expect, it } from "vitest";
import {
  atom,
  attachHost,
  committed,
  computed,
  latest,
  read,
  resetForTest,
  type RootToken,
  type SignalHost,
  type SignalHostListener,
} from "../src/index.ts";

type ModelOperation = {
  target: 0 | 1;
  kind: 0 | 1 | 2;
  value: number;
  lane: number;
  committed: boolean;
};
type Action = [kind: number, target: number, value: number];

class FakeHost implements SignalHost {
  listener: SignalHostListener | null = null;
  classification = 0;
  context: { container: RootToken; lanes: number } | null = null;

  currentWriteLane(): number {
    return this.classification;
  }

  renderContext() {
    return this.context;
  }

  runInLane<T>(lane: number, fn: () => T): T {
    const previous = this.classification;
    this.classification = -lane;
    try {
      return fn();
    } finally {
      this.classification = previous;
    }
  }

  subscribe(listener: SignalHostListener): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }
}

function apply(value: number, operation: ModelOperation): number {
  if (operation.kind === 0) return operation.value;
  if (operation.kind === 1) return value + operation.value;
  return value * operation.value;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function runSchedule(actions: Action[]): string | null {
  resetForTest();
  const host = new FakeHost();
  const detach = attachHost(host);
  const root = {};
  const atoms = [atom(1), atom(2)] as const;
  const derived = computed(() => atoms[0].state * 3 + atoms[1].state);
  const initial = [1, 2];
  const drafts = new Map<number, ModelOperation[]>();
  const history: ModelOperation[] = [];
  let liveMask = 0;

  function modelValue(target: 0 | 1, lanes: number): number {
    let value = initial[target];
    for (const operation of history) {
      if (operation.target === target && (operation.committed || (lanes & operation.lane) !== 0)) {
        value = apply(value, operation);
      }
    }
    return value;
  }

  try {
    for (let step = 0; step < actions.length; step++) {
      const [kind, rawTarget, rawValue] = actions[step];
      const target = (rawTarget & 1) as 0 | 1;
      const operation: ModelOperation = {
        target,
        kind: (rawValue % 3) as 0 | 1 | 2,
        value: (rawValue % 5) + 1,
        lane: 0,
        committed: false,
      };
      if (kind < 3) {
        host.classification = 0;
        const dropped = operation.kind === 0 && modelValue(target, 0) === operation.value;
        if (operation.kind === 0) atoms[target].set(operation.value);
        else if (operation.kind === 1) atoms[target].update((value) => value + operation.value);
        else atoms[target].update((value) => value * operation.value);
        if (!dropped) {
          operation.committed = true;
          history.push(operation);
        }
      } else if (kind < 6) {
        const lane = rawValue & 1 ? 128 : 256;
        const dropped = operation.kind === 0 && modelValue(target, lane) === operation.value;
        host.classification = -lane;
        if (operation.kind === 0) atoms[target].set(operation.value);
        else if (operation.kind === 1) atoms[target].update((value) => value + operation.value);
        else atoms[target].update((value) => value * operation.value);
        if (!dropped) {
          let laneOperations = drafts.get(lane);
          if (laneOperations === undefined) {
            laneOperations = [];
            drafts.set(lane, laneOperations);
          }
          operation.lane = lane;
          laneOperations.push(operation);
          history.push(operation);
          liveMask |= lane;
          host.listener?.onRootPending(root, liveMask);
        }
      } else if (kind === 6) {
        const lanes = rawValue % 3 === 0 ? liveMask : rawValue & 1 ? 128 : 256;
        host.listener?.onRenderStart(root, lanes);
        host.context = { container: root, lanes };
        const a = read(atoms[0]);
        const b = read(atoms[1]);
        const c = read(derived);
        host.context = null;
        host.listener?.onRenderEnd(root, false);
        const expectedA = modelValue(0, lanes);
        const expectedB = modelValue(1, lanes);
        if (a !== expectedA || b !== expectedB || c !== expectedA * 3 + expectedB) {
          return `step ${step}: render ${lanes} got ${a},${b},${c} expected ${expectedA},${expectedB},${
            expectedA * 3 + expectedB
          }`;
        }
      } else if (kind === 7) {
        const a = latest(atoms[0]);
        const b = latest(atoms[1]);
        if (a !== modelValue(0, liveMask) || b !== modelValue(1, liveMask)) {
          return `step ${step}: latest got ${a},${b}`;
        }
      } else {
        const lane = rawValue & 1 ? 128 : 256;
        const laneOperations = drafts.get(lane);
        if (laneOperations !== undefined) {
          liveMask &= ~lane;
          host.listener?.onRootCommit(root, lane, liveMask);
          for (const item of laneOperations) item.committed = true;
          drafts.delete(lane);
        }
      }
      const canonicalA = modelValue(0, 0);
      const canonicalB = modelValue(1, 0);
      const actualA = read(atoms[0]);
      const actualB = read(atoms[1]);
      const actualDerived = read(derived);
      if (
        actualA !== canonicalA ||
        actualB !== canonicalB ||
        actualDerived !== canonicalA * 3 + canonicalB
      ) {
        return `step ${step}: canonical got ${actualA},${actualB},${actualDerived} expected ${canonicalA},${canonicalB},${
          canonicalA * 3 + canonicalB
        }`;
      }
    }
    return null;
  } finally {
    host.context = null;
    detach();
  }
}

function minimize(actions: Action[]): Action[] {
  let candidate = actions.slice();
  for (let width = Math.floor(candidate.length / 2); width > 0; width = Math.floor(width / 2)) {
    for (let start = 0; start + width <= candidate.length; start++) {
      const smaller = candidate.slice(0, start).concat(candidate.slice(start + width));
      if (runSchedule(smaller) !== null) {
        candidate = smaller;
        start = -1;
      }
    }
  }
  return candidate;
}

describe("world-fold oracle", () => {
  it("retires every operation in original dispatch order", () => {
    resetForTest();
    const host = new FakeHost();
    const detach = attachHost(host);
    const root = {};

    const urgentFirst = atom(1);
    urgentFirst.update((current) => current + 1);
    host.classification = -128;
    urgentFirst.update((current) => current * 2);
    host.listener?.onRootPending(root, 128);
    host.listener?.onRootCommit(root, 128, 0);
    expect(read(urgentFirst)).toBe(4);

    const deferredSet = atom(1);
    host.classification = -256;
    deferredSet.set(10);
    host.listener?.onRootPending(root, 256);
    host.classification = 0;
    deferredSet.update((current) => current + 5);
    expect(read(deferredSet)).toBe(6);
    host.listener?.onRootCommit(root, 256, 0);
    expect(read(deferredSet)).toBe(15);

    detach();
  });

  it("preserves dispatch order in per-root committed views", () => {
    resetForTest();
    const host = new FakeHost();
    const detach = attachHost(host);
    const firstRoot = {};
    const secondRoot = {};
    const value = atom(1);
    host.classification = -128;
    value.update((current) => current * 2);
    host.listener?.onRootPending(firstRoot, 128);
    host.listener?.onRootPending(secondRoot, 128);
    host.classification = 0;
    value.update((current) => current + 1);
    expect(read(value)).toBe(2);
    expect(latest(value)).toBe(3);
    host.listener?.onRootCommit(firstRoot, 128, 0);
    expect(committed(value, firstRoot)).toBe(3);
    expect(committed(value, secondRoot)).toBe(2);
    host.listener?.onRootCommit(secondRoot, 128, 0);
    expect(read(value)).toBe(3);
    detach();
  });

  const environment = (globalThis as { process?: { env: Record<string, string | undefined> } })
    .process?.env;
  const seeds = Number(environment?.ORACLE_SEEDS ?? 300);
  const steps = Number(environment?.ORACLE_STEPS ?? 90);

  it(`matches the naive fold for ${seeds} seeds x ${steps} steps`, () => {
    for (let seed = 1; seed <= seeds; seed++) {
      const random = mulberry32(seed);
      const actions: Action[] = [];
      for (let step = 0; step < steps; step++) {
        actions.push([
          Math.floor(random() * 10),
          Math.floor(random() * 2),
          Math.floor(random() * 20),
        ]);
      }
      const failure = runSchedule(actions);
      if (failure !== null) {
        const shrunk = minimize(actions);
        expect.fail(
          `seed ${seed}: ${runSchedule(shrunk)}\nshrunk schedule: ${JSON.stringify(shrunk)}`,
        );
      }
    }
  });
});
