/**
 * Randomized oracle: a naive, memo-free model of this engine's semantics
 * fuzzed against the real engine.
 *
 * Model: each atom is a base value plus an ordered op list tagged with the
 * batch that issued it (null = urgent). A world's value is the fold of ops
 * visible in that world, in scheduling order: urgent ops, retired batches'
 * ops, and the world's own open batches. Computeds rederive from scratch on
 * every question. Render passes pin the canonical value at pass start.
 *
 * Two context rules ride along on every schedule (the judgement classes):
 * - latest() from a simulated render body resolves that pass's own world
 *   (never newest intent — that is the render-tear class).
 * - refresh() — canonical or issued inside a batch — is value-neutral for
 *   synchronous computeds in EVERY world, through marks, world evaluations,
 *   retirement carries, and aborts.
 *
 * Failures print the seed and a shrunk schedule; every bug found gets pinned
 * as a named regression in engine-regressions.spec.ts.
 */
import { expect, test } from "vitest";
import {
  Cell,
  Derived,
  atom,
  computed,
  effect,
  batch as engineBatch,
  setHost,
  resetEngine,
  episodeFor,
  retireEpisode,
  abortEpisode,
  beginPass,
  commitPass,
  frameForRoot,
  latest,
  isPending,
  peekSlot,
  read,
  refresh,
  type Episode,
} from "../src/index";

// ---------------------------------------------------------------------------
// Deterministic PRNG
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

type OpTag = number | null; // batch id, null = urgent
interface ModelOp {
  tag: OpTag;
  kind: "set" | "update";
  value: number;
  updateId: number;
}
interface ModelAtom {
  base: number;
  ops: ModelOp[];
}
interface ModelComputed {
  deps: number[]; // indexes into atoms/computeds below it
  compute: (inputs: number[]) => number;
}

/** The pure update functions the schedule can pick from (shared by engine
 * writes and model replay so replays agree). */
const UPDATE_FNS: Array<(x: number) => number> = [
  (x) => x + 1,
  (x) => x * 2,
  (x) => x - 3,
  (x) => (x % 97) + 7,
];

type ModelNode = { kind: "atom"; a: ModelAtom } | { kind: "computed"; c: ModelComputed };

class Model {
  /** Nodes in creation order (schedules index into this — stable). */
  nodes: ModelNode[] = [];
  open = new Set<number>();
  retired = new Set<number>();

  value(i: number, world: ReadonlySet<number>): number {
    const n = this.nodes[i]!;
    if (n.kind === "atom") {
      let v = n.a.base;
      for (const op of n.a.ops) {
        const visible =
          op.tag === null ||
          this.retired.has(op.tag) ||
          (this.open.has(op.tag) && world.has(op.tag));
        if (!visible) continue;
        v = op.kind === "set" ? op.value : UPDATE_FNS[op.updateId]!(v);
      }
      return v;
    }
    return n.c.compute(n.c.deps.map((d) => this.value(d, world)));
  }

  isAtom(i: number): boolean {
    return this.nodes[i]!.kind === "atom";
  }

  atomAt(i: number): ModelAtom {
    const n = this.nodes[i]!;
    if (n.kind !== "atom") throw new Error("not an atom");
    return n.a;
  }

  isPending(i: number): boolean {
    // Pending = the all-open world disagrees with canonical.
    return this.value(i, new Set()) !== this.value(i, this.open);
  }
}

// ---------------------------------------------------------------------------
// Schedule representation (shrinkable)
// ---------------------------------------------------------------------------

type Step =
  | { op: "atom"; init: number }
  | { op: "computed"; deps: number[]; fnId: number }
  | {
      op: "write";
      target: number;
      kind: "set" | "update";
      value: number;
      updateId: number;
      inBatch: number | null;
    }
  | { op: "openBatch"; id: number }
  | { op: "retire"; id: number }
  | { op: "abort"; id: number }
  | { op: "beginPass"; root: number; batches: number[] }
  | { op: "commitPass"; root: number }
  | { op: "readPass"; root: number; target: number }
  | { op: "refresh"; target: number; inBatch: number | null }
  | { op: "engineBatchWrites"; writes: Array<{ target: number; value: number }> }
  | { op: "checkAll" };

const COMPUTE_FNS: Array<(inputs: number[]) => number> = [
  (xs) => xs.reduce((a, b) => a + b, 0),
  (xs) => xs.reduce((a, b) => a * 2 - b, 1),
  (xs) => (xs.length === 0 ? 0 : Math.max(...xs) - Math.min(...xs)),
  (xs) => xs.reduce((a, b) => a + (b % 13), 100),
];

function generate(rng: () => number, steps: number): Step[] {
  const out: Step[] = [];
  let nodes = 0;
  const atomIndexes: number[] = [];
  let nextBatch = 1;
  const openBatches: number[] = [];
  const liveRoots = new Map<number, number[]>(); // root -> batches
  let nextRoot = 1;
  const int = (n: number) => Math.floor(rng() * n);
  const anyNode = () => int(nodes);
  for (let i = 0; i < steps; i++) {
    const r = rng();
    if (atomIndexes.length === 0 || r < 0.12) {
      out.push({ op: "atom", init: int(100) });
      atomIndexes.push(nodes);
      nodes++;
    } else if (r < 0.2 && nodes >= 1) {
      const depCount = 1 + int(Math.min(3, nodes));
      const deps: number[] = [];
      for (let d = 0; d < depCount; d++) deps.push(int(nodes));
      out.push({ op: "computed", deps, fnId: int(COMPUTE_FNS.length) });
      nodes++;
    } else if (r < 0.45) {
      out.push({
        op: "write",
        target: atomIndexes[int(atomIndexes.length)]!,
        kind: rng() < 0.5 ? "set" : "update",
        value: int(1000),
        updateId: int(UPDATE_FNS.length),
        inBatch:
          openBatches.length > 0 && rng() < 0.55 ? openBatches[int(openBatches.length)]! : null,
      });
    } else if (r < 0.52) {
      const id = nextBatch++;
      openBatches.push(id);
      out.push({ op: "openBatch", id });
    } else if (r < 0.6 && openBatches.length > 0) {
      const idx = int(openBatches.length);
      const id = openBatches[idx]!;
      openBatches.splice(idx, 1);
      out.push({ op: rng() < 0.8 ? "retire" : "abort", id });
    } else if (r < 0.68) {
      const root =
        rng() < 0.5 && liveRoots.size > 0
          ? [...liveRoots.keys()][int(liveRoots.size)]!
          : nextRoot++;
      const batches = openBatches.filter(() => rng() < 0.5);
      liveRoots.set(root, batches);
      out.push({ op: "beginPass", root, batches });
    } else if (r < 0.76 && liveRoots.size > 0) {
      const root = [...liveRoots.keys()][int(liveRoots.size)]!;
      out.push({ op: "readPass", root, target: anyNode() });
    } else if (r < 0.82 && liveRoots.size > 0) {
      const root = [...liveRoots.keys()][int(liveRoots.size)]!;
      liveRoots.delete(root);
      out.push({ op: "commitPass", root });
    } else if (r < 0.85 && nodes > 0) {
      out.push({
        op: "refresh",
        target: anyNode(),
        inBatch:
          openBatches.length > 0 && rng() < 0.55 ? openBatches[int(openBatches.length)]! : null,
      });
    } else if (r < 0.88) {
      const writes = [];
      const n = 1 + int(3);
      for (let w = 0; w < n; w++)
        writes.push({ target: atomIndexes[int(atomIndexes.length)]!, value: int(1000) });
      out.push({ op: "engineBatchWrites", writes });
    } else {
      out.push({ op: "checkAll" });
    }
  }
  out.push({ op: "checkAll" });
  return out;
}

// ---------------------------------------------------------------------------
// Executor: run one schedule against the engine + model, comparing behavior
// ---------------------------------------------------------------------------

function runSchedule(steps: Step[]): void {
  resetEngine();
  const model = new Model();
  const engineNodes: Array<Cell<number> | Derived<number>> = [];
  const tokens = new Map<number, object>();
  const episodes = new Map<number, Episode>();
  const rootKeys = new Map<number, object>();
  const rootBatches = new Map<number, number[]>();
  const effectSeen = new Map<number, { value: number }>(); // computed idx -> last effect capture
  let ambient: object | null = null;
  /** Non-null while a readPass step simulates a render body on that root. */
  let renderingRoot: number | null = null;

  setHost({
    currentBatchToken: () => ambient,
    isRendering: () => false,
    deliver: () => {},
    currentPassFrame: () => {
      if (renderingRoot === null) return null;
      const key = rootKeys.get(renderingRoot);
      return key === undefined ? null : frameForRoot(key);
    },
  });

  const node = (i: number): Cell<number> | Derived<number> => engineNodes[i]!;
  const modelValue = (i: number, world: ReadonlySet<number>): number => model.value(i, world);
  const NO_WORLD: ReadonlySet<number> = new Set();

  const repinRootsIncluding = (batchId: number) => {
    for (const [root, batches] of rootBatches) {
      if (!batches.includes(batchId)) continue;
      doBeginPass(root, batches);
    }
  };

  const passSnapshots = new Map<number, Map<number, number>>();
  const doBeginPass = (root: number, batches: number[]) => {
    let key = rootKeys.get(root);
    if (key === undefined) {
      key = { root };
      rootKeys.set(root, key);
    }
    rootBatches.set(root, batches);
    const eps = batches.map((b) => episodes.get(b)!).filter((e) => e !== undefined);
    beginPass(key, eps);
    const world = new Set(batches.filter((b) => model.open.has(b)));
    const snap = new Map<number, number>();
    for (let i = 0; i < model.nodes.length; i++) snap.set(i, modelValue(i, world));
    passSnapshots.set(root, snap);
  };

  const checkNode = (i: number, where: string) => {
    const n = node(i);
    expect(read(n), `canonical ${where} node ${i}`).toBe(modelValue(i, NO_WORLD));
    const allOpen = new Set(model.open);
    expect(latest(n), `latest ${where} node ${i}`).toBe(modelValue(i, allOpen));
    const enginePending = isPending(n);
    if (model.isAtom(i)) {
      expect(enginePending, `isPending ${where} atom ${i}`).toBe(model.isPending(i));
    } else if (model.isPending(i)) {
      // The derived probe is topology-based (it never evaluates, so it can
      // never refetch); it may over-report but must never under-report.
      expect(enginePending, `isPending ${where} computed ${i} (model pending)`).toBe(true);
    }
  };

  for (const step of steps) {
    switch (step.op) {
      case "atom": {
        engineNodes.push(atom(step.init));
        model.nodes.push({ kind: "atom", a: { base: step.init, ops: [] } });
        break;
      }
      case "computed": {
        if (step.deps.some((d) => d >= engineNodes.length)) break;
        const deps = step.deps;
        const fn = COMPUTE_FNS[step.fnId]!;
        const c = computed(() => fn(deps.map((d) => node(d).get())));
        engineNodes.push(c);
        model.nodes.push({ kind: "computed", c: { deps, compute: fn } });
        const idx = engineNodes.length - 1;
        if (step.fnId % 3 === 0) {
          // A live watcher: exercises the hot (push-invalidated) paths and
          // pins that effects observe canonical state only.
          const captured = { value: 0 };
          effectSeen.set(idx, captured);
          effect(() => {
            captured.value = c.get();
          });
        }
        break;
      }
      case "write": {
        if (step.target >= engineNodes.length || !model.isAtom(step.target)) break;
        const target = engineNodes[step.target] as Cell<number>;
        const inBatch = step.inBatch;
        if (inBatch !== null && model.open.has(inBatch)) {
          ambient = tokens.get(inBatch)!;
          if (step.kind === "set") target.set(step.value);
          else target.update(UPDATE_FNS[step.updateId]!);
          ambient = null;
          const before = model.value(step.target, new Set([inBatch]));
          const after = step.kind === "set" ? step.value : UPDATE_FNS[step.updateId]!(before);
          if (!(step.kind === "set" && before === after)) {
            model.atomAt(step.target).ops.push({
              tag: inBatch,
              kind: step.kind,
              value: step.value,
              updateId: step.updateId,
            });
          }
          repinRootsIncluding(inBatch);
        } else {
          if (step.kind === "set") target.set(step.value);
          else target.update(UPDATE_FNS[step.updateId]!);
          model.atomAt(step.target).ops.push({
            tag: null,
            kind: step.kind,
            value: step.value,
            updateId: step.updateId,
          });
        }
        break;
      }
      case "openBatch": {
        const token = { batch: step.id };
        tokens.set(step.id, token);
        ambient = token;
        episodes.set(step.id, episodeFor(token));
        ambient = null;
        model.open.add(step.id);
        break;
      }
      case "retire": {
        if (!model.open.has(step.id)) break;
        const ep = episodes.get(step.id);
        if (ep !== undefined) retireEpisode(ep);
        model.open.delete(step.id);
        model.retired.add(step.id);
        repinRootsIncluding(step.id);
        break;
      }
      case "abort": {
        if (!model.open.has(step.id)) break; // already landed: abort is a no-op
        const ep = episodes.get(step.id);
        if (ep !== undefined) abortEpisode(ep);
        model.open.delete(step.id);
        for (const n of model.nodes) {
          if (n.kind === "atom") n.a.ops = n.a.ops.filter((o) => o.tag !== step.id);
        }
        repinRootsIncluding(step.id);
        break;
      }

      case "beginPass": {
        doBeginPass(step.root, step.batches);
        break;
      }
      case "readPass": {
        const key = rootKeys.get(step.root);
        const snap = passSnapshots.get(step.root);
        if (key === undefined || snap === undefined) break;
        if (step.target >= engineNodes.length || !snap.has(step.target)) break;
        const frame = frameForRoot(key);
        if (frame === null) break;
        const slot = peekSlot(node(step.target), frame);
        expect(slot, `pass read root ${step.root} node ${step.target}`).toBe(snap.get(step.target));
        // The same read issued from inside the pass's render body: latest()
        // must resolve the executing pass's own world, never newest intent.
        renderingRoot = step.root;
        try {
          expect(
            latest(node(step.target)),
            `latest in render body, root ${step.root} node ${step.target}`,
          ).toBe(snap.get(step.target));
        } finally {
          renderingRoot = null;
        }
        break;
      }
      case "commitPass": {
        const key = rootKeys.get(step.root);
        const batches = rootBatches.get(step.root) ?? [];
        if (key !== undefined) {
          commitPass(
            key,
            batches.map((b) => episodes.get(b)!).filter((e) => e !== undefined),
          );
        }
        for (const b of batches) {
          if (model.open.has(b)) {
            model.open.delete(b);
            model.retired.add(b);
          }
        }
        rootBatches.delete(step.root);
        passSnapshots.delete(step.root);
        break;
      }
      case "refresh": {
        if (step.target >= engineNodes.length) break;
        // Value-neutral by contract for synchronous computeds (and a no-op on
        // atoms): the model does not change. Every later check — canonical,
        // latest, pass reads, effect captures — pins that the refetch
        // machinery (marks, world evaluations, retirement carries, aborts)
        // never alters what any world shows.
        if (step.inBatch !== null && model.open.has(step.inBatch)) {
          ambient = tokens.get(step.inBatch)!;
          refresh(node(step.target));
          ambient = null;
        } else {
          refresh(node(step.target));
        }
        break;
      }
      case "engineBatchWrites": {
        engineBatch(() => {
          for (const w of step.writes) {
            if (w.target >= engineNodes.length || !model.isAtom(w.target)) continue;
            (engineNodes[w.target] as Cell<number>).set(w.value);
            model
              .atomAt(w.target)
              .ops.push({ tag: null, kind: "set", value: w.value, updateId: 0 });
          }
        });
        break;
      }
      case "checkAll": {
        for (let i = 0; i < engineNodes.length; i++) checkNode(i, "checkAll");
        for (const [idx, captured] of effectSeen) {
          expect(captured.value, `effect canonical capture of node ${idx}`).toBe(
            modelValue(idx, NO_WORLD),
          );
        }
        break;
      }
    }
  }
  setHost(null);
}

// ---------------------------------------------------------------------------
// Shrinking and the seed loop
// ---------------------------------------------------------------------------

function fails(steps: Step[]): boolean {
  try {
    runSchedule(steps);
    return false;
  } catch {
    return true;
  }
}

/** Greedy chunk removal: drop spans while the schedule still fails. */
function shrink(steps: Step[]): Step[] {
  let current = steps;
  let chunk = Math.max(1, Math.floor(current.length / 2));
  while (chunk >= 1) {
    let i = 0;
    while (i < current.length) {
      const candidate = [...current.slice(0, i), ...current.slice(i + chunk)];
      if (candidate.length > 0 && fails(candidate)) {
        current = candidate;
      } else {
        i += chunk;
      }
    }
    if (chunk === 1) break;
    chunk = Math.floor(chunk / 2);
  }
  return current;
}

const SEED_COUNT = Number(process.env.ORACLE_SEEDS ?? 300);
const STEPS = Number(process.env.ORACLE_STEPS ?? 90);
const SEED_BASE = Number(process.env.ORACLE_SEED_BASE ?? 1);

test(`oracle fuzz: ${SEED_COUNT} seeds x ${STEPS} steps`, () => {
  for (let seed = SEED_BASE; seed < SEED_BASE + SEED_COUNT; seed++) {
    const steps = generate(mulberry32(seed), STEPS);
    try {
      runSchedule(steps);
    } catch (e) {
      const small = shrink(steps);
      // eslint-disable-next-line no-console
      console.error(
        `\noracle failure seed=${seed} steps=${STEPS}\nshrunk schedule (${small.length} steps):\n` +
          small.map((s) => JSON.stringify(s)).join("\n"),
      );
      // Re-run the shrunk schedule so the reported error matches it.
      runSchedule(small);
      throw e;
    }
  }
});
