import { describe, expect, it } from 'vitest'
import {
	generateSchedule,
	generateUniverse,
	mulberry32,
	runSchedule,
	shrink,
	type NodeSpec,
	type Op,
} from './helpers/oracle'

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
]

// UPDATE_FNS indexes: 0 = x+1, 1 = x*2 %1000, 2 = identity, 3 = x-3.
const pinned: Record<string, Op[]> = {
	// ALT-FAMILY AMBIENT RULE pin (speculation-leak elimination): the urgent
	// "handler" write DERIVES from the current value while a transition's
	// draft is pending — the derivation must read W0 (atom0 = 1 → *2 = 2,
	// never the draft 9 → 18), and ABORTING the transition leaves no
	// contamination in any world.
	'speculation leak: urgent derivation reads W0 under a pending transition; abort is clean': [
		{ t: 'watch', n: 0 },
		{ t: 'watch', n: 5 },
		{ t: 'openDeferred' }, // 0 = the transition
		{ t: 'write', w: { batch: 0, atom: 0, op: 'set', v: 9 } }, // the draft
		{ t: 'write', w: { batch: -1, atom: 0, op: 'update', v: 1 } }, // handler: *2 of W0
		{ t: 'closeEvent' }, // the handler's event batch retires
		{ t: 'retire', b: 0, committed: false }, // ABORT the transition
	],
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
}

describe('§17.2 oracle: pinned danger cases', () => {
	for (const [name, ops] of Object.entries(pinned)) {
		it(name, () => {
			const r = runSchedule(PINNED_UNIVERSE, ops, name)
			expect(r.failure, r.failure).toBeUndefined()
		})
	}
})

describe('§17.2 oracle: pinned danger cases (own universes)', () => {
	it('join-of-join identity: same flattened wait set across worlds (fuzz seed 281, shrunk)', () => {
		// A forwarded pending part arriving both DIRECTLY and inside a
		// sibling's join must not make two worlds' identical wait sets look
		// different — joins key on the FLATTENED ultimate source set. Here
		// node6 = asyncgate over pending node4 (its thenable is the join
		// {never4, never6}); node7 = sum(6, 5). In W0 node5 is settled, so
		// node7 waits on {J6}; in the writer world node5 forwards never4, so
		// node7's immediate parts are {J6, never4} — the SAME flattened set.
		const universe: NodeSpec[] = [
			{ kind: 'atom', initial: 4 },
			{ kind: 'reducer', initial: 1 },
			{ kind: 'atom', initial: 6 },
			{ kind: 'atom', initial: 6 },
			{ kind: 'computed', type: 'asyncgate', srcs: [1] },
			{ kind: 'computed', type: 'branch', srcs: [3, 4, 2] },
			{ kind: 'computed', type: 'asyncgate', srcs: [4] },
			{ kind: 'computed', type: 'sum', srcs: [6, 5] },
		]
		const ops: Op[] = [
			{ t: 'openDeferred' },
			{ t: 'watch', n: 7 },
			{ t: 'openDeferred' },
			{
				t: 'group',
				writes: [
					{ batch: -1, atom: 0, op: 'update', v: 0 },
					{ batch: 1, atom: 0, op: 'update', v: 0 },
					{ batch: 1, atom: 3, op: 'set', v: 3 },
				],
			},
			{ t: 'retire', b: 1, committed: true },
			{ t: 'retire', b: 0, committed: true },
		]
		const r = runSchedule(universe, ops, 'seed-281')
		expect(r.failure, r.failure).toBeUndefined()
	})
})

describe('§17.2 oracle: seeded randomized fuzz', () => {
	const SEEDS = Number(process.env.ORACLE_SEEDS ?? 300)
	const LENGTH = Number(process.env.ORACLE_LENGTH ?? 90)
	const FIRST_SEED = Number(process.env.ORACLE_FIRST_SEED ?? 1)

	it(`agrees with the naive model across ${SEEDS} random schedules (seeds ${FIRST_SEED}..${FIRST_SEED + SEEDS - 1}, length ${LENGTH})`, () => {
		for (let seed = FIRST_SEED; seed < FIRST_SEED + SEEDS; ++seed) {
			const rng = mulberry32(Math.imul(seed, 0x9e3779b1) ^ 0x2545f491)
			const specs = generateUniverse(rng)
			const ops = generateSchedule(rng, specs, LENGTH)
			const r = runSchedule(specs, ops, `seed ${seed}`)
			if (r.failure !== undefined) {
				const minimal = shrink(specs, ops, `seed ${seed}`)
				const finalFailure = runSchedule(specs, minimal, `seed ${seed} (shrunk)`).failure
				throw new Error(
					`Oracle disagreement at seed ${seed}.\n` +
						`Failure: ${finalFailure ?? r.failure}\n` +
						`Universe: ${JSON.stringify(specs.map((s) => ('type' in s ? s : { ...s })))}\n` +
						`Minimal schedule (${minimal.length} ops):\n${JSON.stringify(minimal)}`,
				)
			}
		}
	}, 120_000)
})
