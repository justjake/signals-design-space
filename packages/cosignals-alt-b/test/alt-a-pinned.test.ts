// §17 — alt-a's pinned oracle danger cases (packages/cosignals-alt-a/tests/
// oracle.spec.ts, read-only), translated into this driver's op vocabulary and
// run against THIS engine + oracle. Their fixed universe:
//   0: atom(1)   1: atom(0)   2: atom(0) "flag"   3: reducer(0)
//   4: branch = flag%2 ? n0 : n1    5: sum = n0 + n1    6: chain = n4 + 1
// Their write encoding: batch -1 = the current urgent event batch (retired by
// closeEvent); UPDATE payloads are UPDATE_FNS indexes (0 = x+1, 1 = x*2%1000,
// 2 = identity, 3 = x-3).
import { describe, expect, it } from 'vitest';
import { runScript } from './driver';
import type { Op } from './driver';

const UNIVERSE: Op[] = [
	{ t: 'atom', v: 1 }, // 0
	{ t: 'atom', v: 0 }, // 1
	{ t: 'atom', v: 0 }, // 2: flag
	{ t: 'reducer', v: 0 }, // 3
	{ t: 'branch', cond: 2, ifTrue: 0, ifFalse: 1 }, // 4
	{ t: 'sum', deps: [0, 1] }, // 5
	{ t: 'chain', dep: 4 }, // 6
];

// Read every node in every reachable world at the end of a script, so value
// agreement is asserted even for cases whose original assertions lived in
// alt-a's own runner.
const READ_ALL: Op[] = [0, 1, 2, 3, 4, 5, 6].flatMap((node): Op[] => [
	{ t: 'read', node, ctx: 'newest' },
	{ t: 'read', node, ctx: 'committed' },
]);

const cases: Record<string, Op[]> = {
	'rebase walkthrough (§10.7)': [
		{ t: 'open', deferred: true }, // batch 0
		{ t: 'write', w: { batch: 0, node: 0, op: 'update', v: 0, uf: 0 } }, // +1 deferred
		{ t: 'urgentWrite', w: { node: 0, op: 'update', v: 0, uf: 1 } }, // *2 urgent
		{ t: 'startPass', batches: [] }, // urgent render excludes the transition
		{ t: 'read', node: 0, ctx: 'render' },
		{ t: 'endPass' },
		{ t: 'closeEvent' }, // urgent batch retires
		{ t: 'startPass', batches: [0] }, // transition render: rebased on top
		{ t: 'read', node: 0, ctx: 'render' },
		{ t: 'endPass' },
		{ t: 'retire', batch: 0, committed: true },
	],
	'two-batch write into an already-marked region (§9.8)': [
		{ t: 'watcher', node: 4 },
		{ t: 'watcher', node: 6 },
		{ t: 'open', deferred: true }, // 0
		{ t: 'open', deferred: true }, // 1
		{ t: 'write', w: { batch: 0, node: 2, op: 'set', v: 1 } },
		{ t: 'write', w: { batch: 1, node: 2, op: 'set', v: 3 } },
		{ t: 'retire', batch: 0, committed: true },
		{ t: 'retire', batch: 1, committed: true },
	],
	'same-batch second write after cutoff-suppressed first (§9.8)': [
		{ t: 'watcher', node: 5 },
		{ t: 'open', deferred: true },
		{ t: 'write', w: { batch: 0, node: 0, op: 'update', v: 0, uf: 2 } }, // identity: cutoff
		{ t: 'write', w: { batch: 0, node: 0, op: 'set', v: 5 } },
		{ t: 'retire', batch: 0, committed: true },
	],
	"flushSync excludes the idle write's default batch (§9.1)": [
		{ t: 'watcher', node: 5 },
		{ t: 'urgentWrite', w: { node: 0, op: 'set', v: 5 } },
		{ t: 'startPass', batches: [] },
		{ t: 'read', node: 5, ctx: 'render' },
		{ t: 'endPass' },
		{ t: 'closeEvent' },
	],
	'equal urgent SET over a pending transition is not dropped (§9.3)': [
		{ t: 'open', deferred: true },
		{ t: 'write', w: { batch: 0, node: 1, op: 'set', v: 1 } },
		{ t: 'urgentWrite', w: { node: 1, op: 'set', v: 0 } }, // equal to W0
		{ t: 'startPass', batches: [] },
		{ t: 'read', node: 1, ctx: 'render' },
		{ t: 'endPass' },
		{ t: 'closeEvent' },
		{ t: 'retire', batch: 0, committed: true },
	],
	'divergent dep with unlogged-at-first-read atom (T1, §17.4)': [
		{ t: 'watcher', node: 4 },
		{ t: 'open', deferred: true },
		{ t: 'write', w: { batch: 0, node: 2, op: 'set', v: 1 } }, // flag flips in k only
		{ t: 'read', node: 4, ctx: 'writer', batch: 0 },
		{ t: 'write', w: { batch: 0, node: 0, op: 'set', v: 5 } }, // world-only dep
		{ t: 'read', node: 4, ctx: 'writer', batch: 0 },
		{ t: 'retire', batch: 0, committed: true },
	],
	'set superseded by urgent, then retirement folds': [
		{ t: 'open', deferred: true },
		{ t: 'write', w: { batch: 0, node: 0, op: 'set', v: 3 } },
		{ t: 'urgentWrite', w: { node: 0, op: 'set', v: 4 } },
		{ t: 'retire', batch: 0, committed: true },
		{ t: 'closeEvent' },
	],
	'functional replay over a moved base': [
		{ t: 'open', deferred: true },
		{ t: 'write', w: { batch: 0, node: 0, op: 'update', v: 0, uf: 0 } }, // +1
		{ t: 'urgentWrite', w: { node: 0, op: 'set', v: 7 } },
		{ t: 'closeEvent' },
		{ t: 'urgentWrite', w: { node: 0, op: 'update', v: 0, uf: 1 } }, // *2
		{ t: 'closeEvent' },
		{ t: 'retire', batch: 0, committed: true },
	],
	'pass pinned across two retirements (retention)': [
		{ t: 'open', deferred: true }, // 0
		{ t: 'open', deferred: true }, // 1
		{ t: 'write', w: { batch: 0, node: 0, op: 'set', v: 2 } },
		{ t: 'write', w: { batch: 1, node: 1, op: 'set', v: 3 } },
		{ t: 'startPass', batches: [] },
		{ t: 'read', node: 5, ctx: 'render' },
		{ t: 'yield' },
		{ t: 'retire', batch: 0, committed: true },
		{ t: 'retire', batch: 1, committed: false },
		{ t: 'resume' },
		{ t: 'read', node: 5, ctx: 'render' }, // the pinned world persists
		{ t: 'endPass' },
	],
	'slot reuse after retirement': [
		{ t: 'open', deferred: true },
		{ t: 'write', w: { batch: 0, node: 0, op: 'set', v: 2 } },
		{ t: 'retire', batch: 0, committed: true },
		{ t: 'open', deferred: true },
		{ t: 'write', w: { batch: 1, node: 0, op: 'set', v: 3 } },
		{ t: 'retire', batch: 1, committed: true },
	],
	'coalescing blocked by an open pass': [
		{ t: 'open', deferred: true },
		{ t: 'write', w: { batch: 0, node: 0, op: 'set', v: 1 } },
		{ t: 'startPass', batches: [0] },
		{ t: 'read', node: 0, ctx: 'render' },
		{ t: 'yield' },
		{ t: 'write', w: { batch: 0, node: 0, op: 'set', v: 2 } },
		{ t: 'resume' },
		{ t: 'read', node: 0, ctx: 'render' }, // still the pinned 1
		{ t: 'endPass' },
		{ t: 'retire', batch: 0, committed: true },
	],
	'truncation re-notifies the rolled-back lane (resolution 4)': [
		{ t: 'watcher', node: 5 },
		{ t: 'open', deferred: true },
		{ t: 'write', w: { batch: 0, node: 0, op: 'set', v: 5 } },
		{ t: 'truncate', batch: 0 },
		{ t: 'retire', batch: 0, committed: false },
	],
	'era-crossing schedules re-using seq values (§9.7)': [
		{ t: 'open', deferred: true },
		{ t: 'write', w: { batch: 0, node: 0, op: 'set', v: 2 } },
		{ t: 'retire', batch: 0, committed: true },
		// quiescence here — seqs restart; identical shape again:
		{ t: 'open', deferred: true },
		{ t: 'write', w: { batch: 1, node: 0, op: 'set', v: 3 } },
		{ t: 'retire', batch: 1, committed: true },
	],
	'W0-no-op retirement shifts other pending worlds': [
		{ t: 'watcher', node: 0 },
		{ t: 'urgentWrite', w: { node: 0, op: 'set', v: 5 } },
		{ t: 'open', deferred: true }, // 0 = T2
		{ t: 'write', w: { batch: 0, node: 0, op: 'set', v: 7 } },
		{ t: 'open', deferred: true }, // 1 = T1
		{ t: 'write', w: { batch: 1, node: 0, op: 'set', v: 5 } }, // equal to W0
		{ t: 'closeEvent' },
		{ t: 'read', node: 0, ctx: 'writer', batch: 0 },
		{ t: 'retire', batch: 1, committed: true }, // W0 no-op; T2's world 7 → 5
		{ t: 'read', node: 0, ctx: 'writer', batch: 0 },
		{ t: 'retire', batch: 0, committed: true },
	],
};

describe("alt-a's pinned oracle danger cases (hosted)", () => {
	for (const [name, ops] of Object.entries(cases)) {
		it(name, () => {
			const script = [...UNIVERSE, ...ops, ...READ_ALL];
			const r = runScript(script);
			if (r.failed) {
				expect.fail(`diverged at op ${r.atOp}: ${String(r.error)}`);
			}
		});
	}
});
