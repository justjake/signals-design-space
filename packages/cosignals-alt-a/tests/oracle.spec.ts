import { describe, expect, it } from 'vitest';
import {
	generateSchedule,
	generateUniverse,
	mulberry32,
	runSchedule,
	shrink,
	type NodeSpec,
	type Op,
} from './helpers/oracle';

// §17.2 — the randomized replay oracle: pinned danger cases first, then the
// seeded fuzz. Every failure prints its seed and (shrunk) op list; re-runs
// are reproducible from them.

// Fixed universe for the pinned cases:
//   0: atom(1)   1: atom(0)   2: atom(0) "flag"   3: reducer(0)
//   4: branch = flag%2 ? n0 : n1      5: sum = n0 + n1     6: chain = n4 + 1
const PINNED_UNIVERSE: NodeSpec[] = [
	{ kind: 'atom', initial: 1 },
	{ kind: 'atom', initial: 0 },
	{ kind: 'atom', initial: 0 },
	{ kind: 'reducer', initial: 0 },
	{ kind: 'computed', type: 'branch', srcs: [2, 0, 1] },
	{ kind: 'computed', type: 'sum', srcs: [0, 1] },
	{ kind: 'computed', type: 'chain', srcs: [4] },
];

// UPDATE_FNS indexes: 0 = x+1, 1 = x*2 %1000, 2 = identity, 3 = x-3.
const pinned: Record<string, Op[]> = {
	'rebase walkthrough (§10.7)': [
		{ t: 'openDeferred' },
		{ t: 'write', w: { batch: 0, atom: 0, op: 'update', v: 0 } }, // +1 deferred
		{ t: 'write', w: { batch: -1, atom: 0, op: 'update', v: 1 } }, // *2 urgent
		{ t: 'passStart', include: [-1] }, // urgent render excludes the transition
		{ t: 'passEnd' },
		{ t: 'closeEvent' }, // urgent batch retires
		{ t: 'passStart', include: [0] }, // transition render: rebased on top
		{ t: 'passEnd' },
		{ t: 'retire', b: 0, committed: true },
	],
	'two-batch write into an already-marked region (§9.8)': [
		{ t: 'watch', n: 4 },
		{ t: 'watch', n: 6 },
		{ t: 'openDeferred' },
		{ t: 'openDeferred' },
		{ t: 'write', w: { batch: 0, atom: 2, op: 'set', v: 1 } },
		{ t: 'write', w: { batch: 1, atom: 2, op: 'set', v: 3 } },
		{ t: 'retire', b: 0, committed: true },
		{ t: 'retire', b: 1, committed: true },
	],
	'same-batch second write after cutoff-suppressed first (§9.8)': [
		{ t: 'watch', n: 5 },
		{ t: 'openDeferred' },
		{ t: 'write', w: { batch: 0, atom: 0, op: 'update', v: 2 } }, // identity: cutoff
		{ t: 'write', w: { batch: 0, atom: 0, op: 'set', v: 5 } },
		{ t: 'retire', b: 0, committed: true },
	],
	'flushSync excludes the idle write’s default batch (§9.1)': [
		{ t: 'watch', n: 5 },
		{ t: 'write', w: { batch: -1, atom: 0, op: 'set', v: 5 } },
		{ t: 'passStart', include: [] },
		{ t: 'passEnd' },
		{ t: 'closeEvent' },
	],
	'equal urgent SET over a pending transition is not dropped (§9.3)': [
		{ t: 'openDeferred' },
		{ t: 'write', w: { batch: 0, atom: 1, op: 'set', v: 1 } },
		{ t: 'write', w: { batch: -1, atom: 1, op: 'set', v: 0 } }, // equal to W0
		{ t: 'passStart', include: [-1] },
		{ t: 'passEnd' },
		{ t: 'closeEvent' },
		{ t: 'retire', b: 0, committed: true },
	],
	'divergent dep with unlogged-at-first-read atom (T1, §17.4)': [
		{ t: 'watch', n: 4 },
		{ t: 'openDeferred' },
		{ t: 'write', w: { batch: 0, atom: 2, op: 'set', v: 1 } }, // flag flips in k only
		{ t: 'write', w: { batch: 0, atom: 0, op: 'set', v: 5 } }, // world-only dep
		{ t: 'retire', b: 0, committed: true },
	],
	'set superseded by urgent, then retirement folds': [
		{ t: 'openDeferred' },
		{ t: 'write', w: { batch: 0, atom: 0, op: 'set', v: 3 } },
		{ t: 'write', w: { batch: -1, atom: 0, op: 'set', v: 4 } },
		{ t: 'retire', b: 0, committed: true },
		{ t: 'closeEvent' },
	],
	'functional replay over a moved base': [
		{ t: 'openDeferred' },
		{ t: 'write', w: { batch: 0, atom: 0, op: 'update', v: 0 } }, // +1
		{ t: 'write', w: { batch: -1, atom: 0, op: 'set', v: 7 } },
		{ t: 'closeEvent' },
		{ t: 'write', w: { batch: -1, atom: 0, op: 'update', v: 1 } }, // *2
		{ t: 'closeEvent' },
		{ t: 'retire', b: 0, committed: true },
	],
	'pass pinned across two retirements (retention)': [
		{ t: 'openDeferred' },
		{ t: 'openDeferred' },
		{ t: 'write', w: { batch: 0, atom: 0, op: 'set', v: 2 } },
		{ t: 'write', w: { batch: 1, atom: 1, op: 'set', v: 3 } },
		{ t: 'passStart', include: [] },
		{ t: 'passYield' },
		{ t: 'retire', b: 0, committed: true },
		{ t: 'retire', b: 1, committed: false },
		{ t: 'passResume' },
		{ t: 'passEnd' },
	],
	'slot reuse after retirement': [
		{ t: 'openDeferred' },
		{ t: 'write', w: { batch: 0, atom: 0, op: 'set', v: 2 } },
		{ t: 'retire', b: 0, committed: true },
		{ t: 'openDeferred' },
		{ t: 'write', w: { batch: 1, atom: 0, op: 'set', v: 3 } },
		{ t: 'retire', b: 1, committed: true },
	],
	'coalescing blocked by an open pass': [
		{ t: 'openDeferred' },
		{ t: 'write', w: { batch: 0, atom: 0, op: 'set', v: 1 } },
		{ t: 'passStart', include: [0] },
		{ t: 'passYield' },
		{ t: 'write', w: { batch: 0, atom: 0, op: 'set', v: 2 } },
		{ t: 'passResume' },
		{ t: 'passEnd' },
		{ t: 'retire', b: 0, committed: true },
	],
	'truncation re-notifies the rolled-back lane (resolution 4)': [
		{ t: 'watch', n: 5 },
		{ t: 'openDeferred' },
		{ t: 'write', w: { batch: 0, atom: 0, op: 'set', v: 5 } },
		{ t: 'truncate', b: 0 },
		{ t: 'retire', b: 0, committed: false },
	],
	'era-crossing schedules re-using seq values (§9.7)': [
		{ t: 'openDeferred' },
		{ t: 'write', w: { batch: 0, atom: 0, op: 'set', v: 2 } },
		{ t: 'retire', b: 0, committed: true },
		// quiescence here — seqs restart; identical shape again:
		{ t: 'openDeferred' },
		{ t: 'write', w: { batch: 1, atom: 0, op: 'set', v: 3 } },
		{ t: 'retire', b: 1, committed: true },
	],
	'W0-no-op retirement shifts other pending worlds': [
		{ t: 'watch', n: 0 },
		{ t: 'write', w: { batch: -1, atom: 0, op: 'set', v: 5 } },
		{ t: 'openDeferred' }, // b0 = T2
		{ t: 'write', w: { batch: 0, atom: 0, op: 'set', v: 7 } },
		{ t: 'openDeferred' }, // b1 = T1
		{ t: 'write', w: { batch: 1, atom: 0, op: 'set', v: 5 } }, // equal to W0
		{ t: 'closeEvent' },
		{ t: 'retire', b: 1, committed: true }, // W0 no-op; T2's world 7 → 5
		{ t: 'retire', b: 0, committed: true },
	],
};

describe('§17.2 oracle: pinned danger cases', () => {
	for (const [name, ops] of Object.entries(pinned)) {
		it(name, () => {
			const r = runSchedule(PINNED_UNIVERSE, ops, name);
			expect(r.failure, r.failure).toBeUndefined();
		});
	}
});

describe('§17.2 oracle: seeded randomized fuzz', () => {
	const SEEDS = Number(process.env.ORACLE_SEEDS ?? 300);
	const LENGTH = Number(process.env.ORACLE_LENGTH ?? 90);
	const FIRST_SEED = Number(process.env.ORACLE_FIRST_SEED ?? 1);

	it(`agrees with the naive model across ${SEEDS} random schedules (seeds ${FIRST_SEED}..${FIRST_SEED + SEEDS - 1}, length ${LENGTH})`, () => {
		for (let seed = FIRST_SEED; seed < FIRST_SEED + SEEDS; ++seed) {
			const rng = mulberry32(Math.imul(seed, 0x9e3779b1) ^ 0x2545f491);
			const specs = generateUniverse(rng);
			const ops = generateSchedule(rng, specs, LENGTH);
			const r = runSchedule(specs, ops, `seed ${seed}`);
			if (r.failure !== undefined) {
				const minimal = shrink(specs, ops, `seed ${seed}`);
				const finalFailure = runSchedule(specs, minimal, `seed ${seed} (shrunk)`).failure;
				throw new Error(
					`Oracle disagreement at seed ${seed}.\n`
					+ `Failure: ${finalFailure ?? r.failure}\n`
					+ `Universe: ${JSON.stringify(specs.map((s) => ('type' in s ? s : { ...s })))}\n`
					+ `Minimal schedule (${minimal.length} ops):\n${JSON.stringify(minimal)}`,
				);
			}
		}
	}, 120_000);
});
