/**
 * Randomized oracle: a naive, memo-free model of THIS engine's semantics —
 * per-atom intent history (urgent and drafted, in dispatch order), worlds as
 * replay folds, computeds as pure rederivation — fuzzed against the real
 * engine. Failures print the seed and a shrunk schedule; found bugs get
 * pinned as named regression tests in oracle-regressions.spec.ts.
 *
 * Seed count: ROYALE_FX2_SEEDS (default 300) x ~90 steps.
 */
import { describe, expect, test } from 'vitest';
import {
  ASYNC_MASK,
  computed,
  effect,
  isPending,
  latest,
  read,
  reactIntegration as ri,
  resetEngineForTest,
  signal,
  batch,
  type Computed,
  type Signal,
} from '../src/index.ts';

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

type ModelIntent = { seq: number; kind: 'set' | 'update'; payload: number | ((p: number) => number); draft: number | null };
type ModelCell = { base: number; intents: ModelIntent[] };
type DraftState = 'live' | 'retired' | 'discarded';

interface Model {
  cells: ModelCell[];
  drafts: Map<number, DraftState>;
  seq: number;
}

function modelValue(m: Model, cellIx: number, worldIds: readonly number[] | 'latest' | null): number {
  const cell = m.cells[cellIx];
  const live = (id: number) => m.drafts.get(id) === 'live';
  let v = cell.base;
  for (const it of cell.intents) {
    const included =
      it.draft === null ||
      m.drafts.get(it.draft) === 'retired' ||
      (worldIds === 'latest'
        ? live(it.draft)
        : worldIds !== null && worldIds.includes(it.draft) && live(it.draft));
    if (!included) continue;
    v = it.kind === 'set' ? (it.payload as number) : (it.payload as (p: number) => number)(v);
  }
  return v;
}

// Computed shapes: pure expressions over cells and earlier computeds.
type Expr =
  | { op: 'sum'; args: Ref[] }
  | { op: 'mul'; args: Ref[] }
  | { op: 'pick'; cond: Ref; then: Ref; else: Ref };
type Ref = { cell: number } | { comp: number };

function modelEval(m: Model, exprs: Expr[], ref: Ref, world: readonly number[] | 'latest' | null): number {
  if ('cell' in ref) return modelValue(m, ref.cell, world);
  const e = exprs[ref.comp];
  if (e.op === 'sum') return e.args.reduce((acc, r) => acc + modelEval(m, exprs, r, world), 0);
  if (e.op === 'mul') return e.args.reduce((acc, r) => acc * modelEval(m, exprs, r, world), 1) % 1000003;
  return modelEval(m, exprs, e.cond, world) % 2 === 0
    ? modelEval(m, exprs, e.then, world)
    : modelEval(m, exprs, e.else, world);
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

type Step =
  | { t: 'cell'; init: number }
  | { t: 'comp'; expr: Expr }
  | { t: 'set'; cell: number; v: number }
  | { t: 'update'; cell: number; k: number }
  | { t: 'batchWrites'; writes: Array<{ cell: number; v: number }> }
  | { t: 'open' }
  | { t: 'draftSet'; draft: number; cell: number; v: number }
  | { t: 'draftUpdate'; draft: number; cell: number; k: number }
  /** silent mirrors the React bindings' fold-after-commit: no reactEpoch
   * bump. Model semantics are identical; the bare subscribers below assert
   * the canonical channel still converges. */
  | { t: 'retire'; draft: number; silent: boolean }
  | { t: 'discard'; draft: number }
  | { t: 'readCanonical'; ref: Ref }
  | { t: 'readWorld'; ref: Ref; ids: number[] }
  | { t: 'readLatest'; cell: number }
  | { t: 'probePending'; cell: number };

function generate(rand: () => number, steps: number): Step[] {
  const out: Step[] = [];
  let cells = 0;
  let comps = 0;
  let draftIds: number[] = [];
  let nextDraft = 0;
  const anyRef = (): Ref =>
    comps > 0 && rand() < 0.35
      ? { comp: Math.floor(rand() * comps) }
      : { cell: Math.floor(rand() * cells) };
  for (let i = 0; i < steps; i++) {
    const r = rand();
    if (cells === 0 || (r < 0.08 && cells < 8)) {
      out.push({ t: 'cell', init: Math.floor(rand() * 10) });
      cells++;
    } else if (r < 0.16 && comps < 8) {
      const op = rand() < 0.4 ? 'sum' : rand() < 0.7 ? 'mul' : 'pick';
      const expr: Expr =
        op === 'pick'
          ? { op, cond: anyRef(), then: anyRef(), else: anyRef() }
          : { op, args: [anyRef(), anyRef()] };
      out.push({ t: 'comp', expr });
      comps++;
    } else if (r < 0.3) {
      out.push({ t: 'set', cell: Math.floor(rand() * cells), v: Math.floor(rand() * 20) });
    } else if (r < 0.4) {
      out.push({ t: 'update', cell: Math.floor(rand() * cells), k: 1 + Math.floor(rand() * 3) });
    } else if (r < 0.45) {
      const writes = [];
      const n = 1 + Math.floor(rand() * 3);
      for (let j = 0; j < n; j++) {
        writes.push({ cell: Math.floor(rand() * cells), v: Math.floor(rand() * 20) });
      }
      out.push({ t: 'batchWrites', writes });
    } else if (r < 0.52 && draftIds.length < 4) {
      out.push({ t: 'open' });
      draftIds.push(nextDraft++);
    } else if (r < 0.62 && draftIds.length > 0) {
      const d = draftIds[Math.floor(rand() * draftIds.length)];
      if (rand() < 0.5) {
        out.push({ t: 'draftSet', draft: d, cell: Math.floor(rand() * cells), v: Math.floor(rand() * 20) });
      } else {
        out.push({ t: 'draftUpdate', draft: d, cell: Math.floor(rand() * cells), k: 1 + Math.floor(rand() * 3) });
      }
    } else if (r < 0.68 && draftIds.length > 0) {
      const ix = Math.floor(rand() * draftIds.length);
      const d = draftIds[ix];
      draftIds = draftIds.filter((x) => x !== d);
      out.push(
        rand() < 0.7 ? { t: 'retire', draft: d, silent: rand() < 0.5 } : { t: 'discard', draft: d },
      );
    } else if (r < 0.8) {
      out.push({ t: 'readCanonical', ref: anyRef() });
    } else if (r < 0.9) {
      const ids = draftIds.filter(() => rand() < 0.5);
      out.push({ t: 'readWorld', ref: anyRef(), ids });
    } else if (r < 0.95) {
      out.push({ t: 'readLatest', cell: Math.floor(rand() * cells) });
    } else {
      out.push({ t: 'probePending', cell: Math.floor(rand() * cells) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Execution: engine + model side by side
// ---------------------------------------------------------------------------

function runSchedule(steps: Step[]): string | null {
  resetEngineForTest();
  const model: Model = { cells: [], drafts: new Map(), seq: 0 };
  const exprs: Expr[] = [];
  const engCells: Signal<number>[] = [];
  const engComps: Computed<number>[] = [];
  const engDrafts = new Map<number, number>(); // schedule draft ix -> engine draft id
  const effectLog: number[] = [];
  const expectedEffectLog: number[] = [];
  let effectRef: Ref | null = null;
  let disposeEffect: (() => void) | null = null;

  const engRead = (ref: Ref): number => ('cell' in ref ? read(engCells[ref.cell]) : read(engComps[ref.comp]));

  // Bare subscribers: the scope-less React shape. Subscribe, snapshot the
  // canonical epoch, re-read only when the snapshot changes (the
  // useSyncExternalStore bail). Their view must track model canonical state
  // through every fold — silent ones included (the bare-root fold class).
  interface BareSub {
    ref: Ref;
    snap: number;
    view: number;
    unsub: () => void;
  }
  const bareSubs: BareSub[] = [];
  const attachBare = (ref: Ref) => {
    const target = 'cell' in ref ? engCells[ref.cell] : engComps[ref.comp];
    const sub: BareSub = {
      ref,
      snap: ri.canonicalEpochSnapshot(target),
      view: engRead(ref),
      unsub: () => {},
    };
    sub.unsub = ri.subscribe(target, () => {
      const s = ri.canonicalEpochSnapshot(target);
      if (s === sub.snap) return;
      sub.snap = s;
      sub.view = engRead(ref);
    });
    bareSubs.push(sub);
  };
  const checkBareSubs = (): string | null => {
    for (const sub of bareSubs) {
      const want = modelEval(model, exprs, sub.ref, null);
      if (sub.view !== want) {
        return `bare subscriber ${JSON.stringify(sub.ref)}: view ${sub.view} != model ${want}`;
      }
    }
    return null;
  };

  const refreshExpectedEffect = () => {
    if (effectRef === null) return;
    const v = modelEval(model, exprs, effectRef, null);
    if (expectedEffectLog.length === 0 || expectedEffectLog[expectedEffectLog.length - 1] !== v) {
      expectedEffectLog.push(v);
    }
  };

  try {
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const fail = (msg: string) => `step ${i} ${JSON.stringify(s)}: ${msg}`;
      switch (s.t) {
        case 'cell': {
          model.cells.push({ base: s.init, intents: [] });
          engCells.push(signal(s.init));
          if (engCells.length === 1) attachBare({ cell: 0 });
          break;
        }
        case 'comp': {
          exprs.push(s.expr);
          const ix = exprs.length - 1;
          const e = s.expr;
          const engRef = (r: Ref): number =>
            'cell' in r ? engCells[r.cell].get() : engComps[r.comp].get();
          const fn =
            e.op === 'sum'
              ? () => e.args.reduce((acc, r) => acc + engRef(r), 0)
              : e.op === 'mul'
                ? () => e.args.reduce((acc, r) => acc * engRef(r), 1) % 1000003
                : () => (engRef(e.cond) % 2 === 0 ? engRef(e.then) : engRef(e.else));
          engComps.push(computed(fn));
          if (effectRef === null && ix === 0) {
            effectRef = { comp: 0 };
            disposeEffect = effect(() => {
              const v = engComps[0].get();
              if (effectLog.length === 0 || effectLog[effectLog.length - 1] !== v) {
                effectLog.push(v);
              }
            });
            refreshExpectedEffect();
            attachBare({ comp: 0 });
          }
          break;
        }
        case 'set': {
          model.cells[s.cell].intents.push({ seq: model.seq++, kind: 'set', payload: s.v, draft: null });
          engCells[s.cell].set(s.v);
          refreshExpectedEffect();
          break;
        }
        case 'update': {
          const k = s.k;
          model.cells[s.cell].intents.push({ seq: model.seq++, kind: 'update', payload: (p) => p + k, draft: null });
          engCells[s.cell].update((p) => p + k);
          refreshExpectedEffect();
          break;
        }
        case 'batchWrites': {
          batch(() => {
            for (const w of s.writes) {
              model.cells[w.cell].intents.push({ seq: model.seq++, kind: 'set', payload: w.v, draft: null });
              engCells[w.cell].set(w.v);
            }
          });
          refreshExpectedEffect();
          break;
        }
        case 'open': {
          const d = ri.openDraft();
          const ix = engDrafts.size;
          engDrafts.set(ix, d.id);
          model.drafts.set(ix, 'live');
          break;
        }
        case 'draftSet': {
          if (model.drafts.get(s.draft) !== 'live') break;
          model.cells[s.cell].intents.push({ seq: model.seq++, kind: 'set', payload: s.v, draft: s.draft });
          ri.runInDraft(engDrafts.get(s.draft)!, () => engCells[s.cell].set(s.v));
          break;
        }
        case 'draftUpdate': {
          if (model.drafts.get(s.draft) !== 'live') break;
          const k = s.k;
          model.cells[s.cell].intents.push({ seq: model.seq++, kind: 'update', payload: (p) => p + k, draft: s.draft });
          ri.runInDraft(engDrafts.get(s.draft)!, () => engCells[s.cell].update((p) => p + k));
          break;
        }
        case 'retire': {
          if (model.drafts.get(s.draft) !== 'live') break;
          model.drafts.set(s.draft, 'retired');
          ri.retireDraft(engDrafts.get(s.draft)!, { silent: s.silent });
          refreshExpectedEffect();
          break;
        }
        case 'discard': {
          if (model.drafts.get(s.draft) !== 'live') break;
          model.drafts.set(s.draft, 'discarded');
          ri.discardDraft(engDrafts.get(s.draft)!);
          break;
        }
        case 'readCanonical': {
          const got = engRead(s.ref);
          const want = modelEval(model, exprs, s.ref, null);
          if (got !== want) return fail(`canonical read: engine ${got} != model ${want}`);
          break;
        }
        case 'readWorld': {
          const ids = s.ids.filter((ix) => model.drafts.get(ix) === 'live');
          const engIds = ids.map((ix) => engDrafts.get(ix)!);
          const target = 'cell' in s.ref ? engCells[s.ref.cell] : engComps[s.ref.comp];
          const st = ri.resolveState(target, engIds);
          if ((st.flags & ASYNC_MASK) !== 0) return fail(`world read: unexpected flags ${st.flags}`);
          const want = modelEval(model, exprs, s.ref, ids);
          if (st.value !== want) return fail(`world read [${ids}]: engine ${String(st.value)} != model ${want}`);
          break;
        }
        case 'readLatest': {
          const got = latest(engCells[s.cell]);
          const want = modelValue(model, s.cell, 'latest');
          if (got !== want) return fail(`latest: engine ${got} != model ${want}`);
          break;
        }
        case 'probePending': {
          const got = isPending(engCells[s.cell]);
          const want = model.cells[s.cell].intents.some(
            (it) => it.draft !== null && model.drafts.get(it.draft) === 'live',
          );
          if (got !== want) return fail(`isPending: engine ${got} != model ${want}`);
          break;
        }
      }
      // Bare subscribers converge synchronously (notifications flush with
      // the wave), so their view must match model canonical after any step.
      const bare = checkBareSubs();
      if (bare !== null) return fail(bare);
    }
    // Final canonical sweep + effect-log comparison.
    for (let cix = 0; cix < engCells.length; cix++) {
      const got = read(engCells[cix]);
      const want = modelValue(model, cix, null);
      if (got !== want) return `final sweep cell ${cix}: engine ${got} != model ${want}`;
    }
    for (let cix = 0; cix < engComps.length; cix++) {
      const got = read(engComps[cix]);
      const want = modelEval(model, exprs, { comp: cix }, null);
      if (got !== want) return `final sweep comp ${cix}: engine ${got} != model ${want}`;
    }
    if (effectLog.join(',') !== expectedEffectLog.join(',')) {
      return `effect log: engine [${effectLog}] != model [${expectedEffectLog}]`;
    }
    return null;
  } finally {
    disposeEffect?.();
    for (const sub of bareSubs) sub.unsub();
  }
}

/** Greedy shrink: drop one step at a time while the failure reproduces. */
function shrink(steps: Step[]): Step[] {
  let current = steps;
  let progress = true;
  while (progress) {
    progress = false;
    for (let i = 0; i < current.length; i++) {
      const candidate = current.slice(0, i).concat(current.slice(i + 1));
      if (candidate.length > 0 && runSchedule(candidate) !== null) {
        current = candidate;
        progress = true;
        break;
      }
    }
  }
  return current;
}

const SEEDS = Number(process.env.ROYALE_FX2_SEEDS ?? '300');
const STEPS = 90;

describe(`oracle fuzz (${SEEDS} seeds x ${STEPS} steps)`, () => {
  test('canary: a sabotaged engine is caught by the oracle', () => {
    const real = ri.retireDraft;
    (ri as { retireDraft: typeof real }).retireDraft = () => {
      /* sabotage: retirement silently dropped */
    };
    try {
      const schedule: Step[] = [
        { t: 'cell', init: 1 },
        { t: 'open' },
        { t: 'draftSet', draft: 0, cell: 0, v: 9 },
        { t: 'retire', draft: 0, silent: false },
        { t: 'readCanonical', ref: { cell: 0 } },
      ];
      expect(runSchedule(schedule)).not.toBeNull();
    } finally {
      (ri as { retireDraft: typeof real }).retireDraft = real;
      resetEngineForTest();
    }
  });

  test('canary: a bare subscriber blinded to silent folds is caught (the scope-less staleness class)', () => {
    // Sabotage: the bare subscriber's snapshot reverts to the world-delivered
    // epoch, which silent folds keep still — exactly the pre-fix wiring that
    // stranded subscribers outside any SignalScope.
    const real = ri.canonicalEpochSnapshot;
    (ri as { canonicalEpochSnapshot: typeof real }).canonicalEpochSnapshot = (x) =>
      ri.epochSnapshot(x);
    try {
      const schedule: Step[] = [
        { t: 'cell', init: 1 },
        { t: 'open' },
        { t: 'draftSet', draft: 0, cell: 0, v: 9 },
        { t: 'retire', draft: 0, silent: true },
      ];
      expect(runSchedule(schedule)).not.toBeNull();
    } finally {
      (ri as { canonicalEpochSnapshot: typeof real }).canonicalEpochSnapshot = real;
      resetEngineForTest();
    }
  });

  test('engine matches the naive model on every seed', () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const steps = generate(mulberry32(seed), STEPS);
      const failure = runSchedule(steps);
      if (failure !== null) {
        const small = shrink(steps);
        const replay = runSchedule(small);
        failures.push(
          `seed ${seed}: ${failure}\n  shrunk to ${small.length} steps: ${JSON.stringify(small)}\n  shrunk failure: ${replay}`,
        );
        if (failures.length >= 3) break;
      }
    }
    expect(failures, failures.join('\n\n')).toEqual([]);
  });
});
