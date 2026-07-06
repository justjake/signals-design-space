// §17.2 — the randomized replay oracle: the engine must agree with the naive
// model on every read, every retirement fold, and every broadcast drain,
// across randomized schedules. Failures print their seed and the shrunk
// minimal script; shrunk failures get pinned below before the fix lands.
import { describe, expect, it } from 'vitest';
import { genScript, runScript, shrink } from './driver';
import type { Op } from './driver';

// ---- the fuzz --------------------------------------------------------------------------
// Seed count and step length are env-tunable for long offline sweeps:
//   FUZZ_SEEDS=200 FUZZ_STEPS=500 vitest run test/oracle.test.ts
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
	?.env;
const SEED_COUNT = Number(env?.FUZZ_SEEDS ?? 40);
const SEEDS = Array.from({ length: SEED_COUNT }, (_, i) => i + 1);
const STEPS = Number(env?.FUZZ_STEPS ?? 350);

describe('randomized replay oracle (§17.2)', () => {
	it.each(SEEDS.map((s) => [s] as const))('seed %i agrees with the oracle', (seed) => {
		const script = genScript(seed, STEPS);
		const result = runScript(script);
		if (result.failed) {
			const minimal = shrink(script);
			const minResult = runScript(minimal);
			expect.fail(
				`seed ${seed} diverged at op ${result.atOp}: ${String(result.error)}\n`
					+ `minimal script (${minimal.length} ops): ${JSON.stringify(minimal)}\n`
					+ `minimal failure: ${minResult.failed ? String((minResult as { error: unknown }).error) : '??'}`,
			);
		}
	});
});

// ---- pinned deterministic scripts (the §17.2 danger list, as oracle ops) ---------------

describe('pinned oracle regressions', () => {
	function expectClean(script: Op[]): void {
		const result = runScript(script);
		if (result.failed) {
			expect.fail(`pinned script diverged at op ${result.atOp}: ${String(result.error)}`);
		}
	}

	it('rebase walkthrough (§10.7): deferred update + urgent update, both retire', () => {
		expectClean([
			{ t: 'atom', v: 1 },
			{ t: 'open', deferred: true }, // batch 0 = T
			{ t: 'open', deferred: false }, // batch 1 = U
			{ t: 'write', w: { batch: 0, node: 0, op: 'update', v: 1 } },
			{ t: 'write', w: { batch: 1, node: 0, op: 'update', v: 2 } },
			{ t: 'read', node: 0, ctx: 'newest' },
			{ t: 'read', node: 0, ctx: 'committed' },
			{ t: 'read', node: 0, ctx: 'writer', batch: 0 },
			{ t: 'read', node: 0, ctx: 'writer', batch: 1 },
			{ t: 'retire', batch: 1, committed: true },
			{ t: 'read', node: 0, ctx: 'writer', batch: 0 },
			{ t: 'retire', batch: 0, committed: true },
			{ t: 'read', node: 0, ctx: 'newest' },
		]);
	});

	it('equal urgent SET over a pending transition (the receipt that must not drop)', () => {
		expectClean([
			{ t: 'atom', v: 0 },
			{ t: 'watcher', node: 0 },
			{ t: 'open', deferred: true },
			{ t: 'open', deferred: false },
			{ t: 'write', w: { batch: 0, node: 0, op: 'set', v: 1 } },
			{ t: 'write', w: { batch: 1, node: 0, op: 'set', v: 1 } }, // equal to newest
			{ t: 'read', node: 0, ctx: 'writer', batch: 1 },
			{ t: 'read', node: 0, ctx: 'committed' },
			{ t: 'retire', batch: 1, committed: true },
			{ t: 'retire', batch: 0, committed: true },
			{ t: 'read', node: 0, ctx: 'newest' },
		]);
	});

	it('divergent-dep follow-up write with the atom unlogged at first read (T1 shape)', () => {
		expectClean([
			{ t: 'atom', v: 0 }, // 0: flag
			{ t: 'atom', v: 0 }, // 1: a
			{ t: 'atom', v: 0 }, // 2: b
			{ t: 'branch', cond: 0, ifTrue: 1, ifFalse: 2 }, // 3: c = flag%2 ? a : b
			{ t: 'read', node: 3, ctx: 'newest' }, // canonical eval: flag, b
			{ t: 'watcher', node: 3 },
			{ t: 'open', deferred: true }, // batch 0 = k
			{ t: 'write', w: { batch: 0, node: 0, op: 'set', v: 1 } }, // flag odd in k
			{ t: 'read', node: 3, ctx: 'writer', batch: 0 },
			{ t: 'write', w: { batch: 0, node: 1, op: 'set', v: 7 } }, // a: unlogged at memo time
			{ t: 'read', node: 3, ctx: 'writer', batch: 0 },
			{ t: 'read', node: 3, ctx: 'committed' },
			{ t: 'retire', batch: 0, committed: true },
			{ t: 'read', node: 3, ctx: 'newest' },
		]);
	});

	it('urgent write flips a branch onto a pending world (the urgent-drain expansion case)', () => {
		expectClean([
			{ t: 'atom', v: 0 }, // 0: sel
			{ t: 'atom', v: 0 }, // 1: z
			{ t: 'atom', v: 9 }, // 2: b
			{ t: 'branch', cond: 0, ifTrue: 1, ifFalse: 2 }, // 3
			{ t: 'read', node: 3, ctx: 'newest' },
			{ t: 'watcher', node: 3 },
			{ t: 'open', deferred: true }, // k writes z; no divergence yet (sel even)
			{ t: 'write', w: { batch: 0, node: 1, op: 'set', v: 5 } },
			{ t: 'open', deferred: false }, // urgent flips sel — first divergence for k
			{ t: 'write', w: { batch: 1, node: 0, op: 'set', v: 1 } },
			{ t: 'read', node: 3, ctx: 'writer', batch: 0 }, // k: sel=1 → z=5
			{ t: 'read', node: 3, ctx: 'newest' },
			{ t: 'retire', batch: 1, committed: true },
			{ t: 'retire', batch: 0, committed: true },
			{ t: 'read', node: 3, ctx: 'newest' },
		]);
	});

	it('a pass pinned across two retirements (retention)', () => {
		expectClean([
			{ t: 'atom', v: 0 },
			{ t: 'open', deferred: true }, // 0
			{ t: 'open', deferred: true }, // 1
			{ t: 'open', deferred: true }, // 2 (kept live to hold LOGGED mode)
			{ t: 'write', w: { batch: 0, node: 0, op: 'set', v: 1 } },
			{ t: 'startPass', batches: [2] },
			{ t: 'read', node: 0, ctx: 'render' },
			{ t: 'yield' },
			{ t: 'write', w: { batch: 1, node: 0, op: 'set', v: 2 } },
			{ t: 'retire', batch: 0, committed: true },
			{ t: 'retire', batch: 1, committed: true },
			{ t: 'resume' },
			{ t: 'read', node: 0, ctx: 'render' }, // still the pinned world
			{ t: 'endPass' },
			{ t: 'read', node: 0, ctx: 'newest' },
			{ t: 'retire', batch: 2, committed: false },
			{ t: 'read', node: 0, ctx: 'newest' },
		]);
	});

	it('functional replay over a moved base (sweep + late writer)', () => {
		expectClean([
			{ t: 'atom', v: 1 },
			{ t: 'open', deferred: true }, // 0
			{ t: 'open', deferred: true }, // 1
			{ t: 'write', w: { batch: 0, node: 0, op: 'update', v: 10 } },
			{ t: 'write', w: { batch: 1, node: 0, op: 'update', v: 100 } },
			{ t: 'retire', batch: 0, committed: true },
			{ t: 'sweep' },
			{ t: 'read', node: 0, ctx: 'writer', batch: 1 },
			{ t: 'retire', batch: 1, committed: true },
			{ t: 'read', node: 0, ctx: 'newest' }, // 1 + 10 + 100
		]);
	});

	// ---- shrunk fuzz failures, pinned before their fixes landed --------------

	it('shrunk seed 39: one grouped drain, two batches writing one region (per-token walk tickets)', () => {
		expectClean([
			{ t: 'reducer', v: 2 }, // node 0
			{ t: 'watcher', node: 0 },
			{ t: 'open', deferred: true }, // 0
			{ t: 'open', deferred: true }, // 1
			{
				t: 'group',
				writes: [
					{ batch: 0, node: 0, op: 'dispatch', v: 7 },
					{ batch: 1, node: 0, op: 'dispatch', v: 6 },
				],
			},
			{ t: 'retire', batch: 0, committed: true },
			{ t: 'retire', batch: 1, committed: true },
			{ t: 'read', node: 0, ctx: 'newest' },
		]);
	});

	it('shrunk seed 38: truncation re-notifies the truncated world', () => {
		expectClean([
			{ t: 'atom', v: 6 }, // node 0
			{ t: 'watcher', node: 0 },
			{ t: 'open', deferred: true }, // 0
			{ t: 'write', w: { batch: 0, node: 0, op: 'set', v: 3 } },
			{ t: 'truncate', batch: 0 }, // rollback: world 0's value reverts
			{ t: 'write', w: { batch: 0, node: 0, op: 'set', v: 7 } },
			{ t: 'retire', batch: 0, committed: true },
			{ t: 'read', node: 0, ctx: 'newest' },
		]);
	});

	it("shrunk seed 36: a W0 no-op retirement still changes other pending worlds' folds", () => {
		expectClean([
			{ t: 'atom', v: 9 }, // node 0
			{ t: 'watcher', node: 0 },
			{ t: 'open', deferred: true }, // 0
			{ t: 'open', deferred: true }, // 1: rebase target
			{ t: 'write', w: { batch: 0, node: 0, op: 'set', v: 7 } },
			{ t: 'retire', batch: 0, committed: false },
			{ t: 'write', w: { batch: 1, node: 0, op: 'update', v: 4 } }, // world 1: 7+4
			{ t: 'open', deferred: true }, // 2
			{ t: 'write', w: { batch: 2, node: 0, op: 'set', v: 7 } }, // equal to W0
			{ t: 'retire', batch: 2, committed: true }, // W0 fold no-op; world 1 → 7+... reorders
			{ t: 'retire', batch: 1, committed: true },
			{ t: 'read', node: 0, ctx: 'newest' },
		]);
	});

	it('shrunk seed 17: equal-value urgent write onto a logged atom shifts pending folds', () => {
		expectClean([
			{ t: 'atom', v: 8 }, // node 0
			{ t: 'watcher', node: 0 },
			{ t: 'open', deferred: true }, // 0
			{ t: 'write', w: { batch: 0, node: 0, op: 'set', v: 6 } }, // world 0: 6
			{ t: 'open', deferred: false }, // 1
			{ t: 'write', w: { batch: 1, node: 0, op: 'set', v: 8 } }, // W0 8→8: no propagate,
			// but world 0's fold becomes 6-then-8 = 8 — its lane must hear.
			{ t: 'read', node: 0, ctx: 'writer', batch: 0 },
			{ t: 'retire', batch: 1, committed: true },
			{ t: 'retire', batch: 0, committed: true },
			{ t: 'read', node: 0, ctx: 'newest' },
		]);
	});

	it('shrunk seed 30: revalidation snapshots old values before broadcast decisions re-memoize', () => {
		expectClean([
			{ t: 'atom', v: 8 }, // 0
			{ t: 'atom', v: 8 }, // 1
			{ t: 'sum', deps: [0, 0] }, // 2
			{ t: 'atom', v: 9 }, // 3
			{ t: 'branch', cond: 0, ifTrue: 2, ifFalse: 1 }, // 4
			{ t: 'sum', deps: [2, 4] }, // 5
			{ t: 'open', deferred: true }, // 0
			{ t: 'open', deferred: true }, // 1
			{ t: 'open', deferred: true }, // 2
			{ t: 'sum', deps: [5, 3] }, // 6
			{ t: 'branch', cond: 4, ifTrue: 3, ifFalse: 6 }, // 7
			{ t: 'open', deferred: true }, // 3
			{ t: 'branch', cond: 0, ifTrue: 3, ifFalse: 5 }, // 8
			{ t: 'watcher', node: 8 },
			{ t: 'open', deferred: true }, // 4
			{ t: 'open', deferred: false }, // 5
			{
				t: 'group',
				writes: [{ batch: 1, node: 1, op: 'set', v: 0 }],
			},
			{ t: 'write', w: { batch: 5, node: 0, op: 'set', v: 7 } },
			{ t: 'write', w: { batch: 1, node: 3, op: 'set', v: 4 } },
			{ t: 'write', w: { batch: 4, node: 0, op: 'set', v: 4 } },
			{ t: 'watcher', node: 4 },
			{ t: 'retire', batch: 1, committed: true },
			{ t: 'read', node: 8, ctx: 'newest' },
			{ t: 'read', node: 4, ctx: 'writer', batch: 4 },
			{ t: 'retire', batch: 4, committed: true },
			{ t: 'retire', batch: 5, committed: true },
			{ t: 'read', node: 4, ctx: 'newest' },
		]);
	});
});
