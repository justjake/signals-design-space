/**
 * Pinned oracle regressions imported from the sibling variant's suite
 * (packages/cosignals-alt-b/test/oracle.test.ts, read-only) and translated
 * into this harness's op format. These were shrunk fuzz failures and danger
 * cases oracle-validated over there; the shared spec sections mean they must
 * hold here too. Explicit `read` ops from the source scripts are omitted —
 * this runner compares every node in every available world after every op,
 * which subsumes them. Their `sweep` op is engine-internal here (sweeps run
 * at retirement/pass-end/boundaries).
 */
import { describe, expect, it } from 'vitest';
import { runSchedule, type NodeSpec, type Op } from './helpers/oracle';

function expectClean(name: string, specs: NodeSpec[], ops: Op[]): void {
	const r = runSchedule(specs, ops, name);
	expect(r.failure, r.failure).toBeUndefined();
}

describe('alt-b pinned oracle regressions (imported)', () => {
	it('rebase walkthrough: deferred update + urgent-batch update, both retire', () => {
		expectClean('alt-b rebase', [{ kind: 'atom', initial: 1 }], [
			{ t: 'openDeferred' }, // 0 = T
			{ t: 'openUrgent' }, // 1 = U
			{ t: 'write', w: { batch: 0, atom: 0, op: 'update', v: 0 } }, // +1
			{ t: 'write', w: { batch: 1, atom: 0, op: 'update', v: 1 } }, // *2
			{ t: 'retire', b: 1, committed: true },
			{ t: 'retire', b: 0, committed: true },
		]);
	});

	it('equal urgent-batch SET over a pending transition (the receipt)', () => {
		expectClean('alt-b receipt', [{ kind: 'atom', initial: 0 }], [
			{ t: 'watch', n: 0 },
			{ t: 'openDeferred' }, // 0
			{ t: 'openUrgent' }, // 1
			{ t: 'write', w: { batch: 0, atom: 0, op: 'set', v: 1 } },
			{ t: 'write', w: { batch: 1, atom: 0, op: 'set', v: 1 } }, // equal to newest
			{ t: 'retire', b: 1, committed: true },
			{ t: 'retire', b: 0, committed: true },
		]);
	});

	it('divergent-dep follow-up write with the atom unlogged at first read (T1 shape)', () => {
		const specs: NodeSpec[] = [
			{ kind: 'atom', initial: 0 }, // 0: flag
			{ kind: 'atom', initial: 0 }, // 1: a
			{ kind: 'atom', initial: 0 }, // 2: b
			{ kind: 'computed', type: 'branch', srcs: [0, 1, 2] }, // 3: flag%2 ? a : b
		];
		expectClean('alt-b T1', specs, [
			{ t: 'watch', n: 3 }, // canonical eval happens at subscription
			{ t: 'openDeferred' }, // 0 = k
			{ t: 'write', w: { batch: 0, atom: 0, op: 'set', v: 1 } }, // flag odd in k
			{ t: 'write', w: { batch: 0, atom: 1, op: 'set', v: 5 } }, // a unlogged at memo time
			{ t: 'retire', b: 0, committed: true },
		]);
	});

	it('urgent write flips a branch onto a pending world (urgent-drain expansion)', () => {
		const specs: NodeSpec[] = [
			{ kind: 'atom', initial: 0 }, // 0: sel
			{ kind: 'atom', initial: 0 }, // 1: z
			{ kind: 'atom', initial: 9 }, // 2: b
			{ kind: 'computed', type: 'branch', srcs: [0, 1, 2] }, // 3
		];
		expectClean('alt-b expansion', specs, [
			{ t: 'watch', n: 3 },
			{ t: 'openDeferred' }, // 0 = k writes z; no divergence yet (sel even)
			{ t: 'write', w: { batch: 0, atom: 1, op: 'set', v: 5 } },
			{ t: 'openUrgent' }, // 1: urgent flips sel — first divergence for k
			{ t: 'write', w: { batch: 1, atom: 0, op: 'set', v: 1 } },
			{ t: 'retire', b: 1, committed: true },
			{ t: 'retire', b: 0, committed: true },
		]);
	});

	it('a pass pinned across two retirements, third batch holding the era open', () => {
		expectClean('alt-b retention', [{ kind: 'atom', initial: 0 }], [
			{ t: 'openDeferred' }, // 0
			{ t: 'openDeferred' }, // 1
			{ t: 'openDeferred' }, // 2 (kept live)
			{ t: 'write', w: { batch: 0, atom: 0, op: 'set', v: 1 } },
			{ t: 'passStart', include: [2] },
			{ t: 'passYield' },
			{ t: 'write', w: { batch: 1, atom: 0, op: 'set', v: 2 } },
			{ t: 'retire', b: 0, committed: true },
			{ t: 'retire', b: 1, committed: true },
			{ t: 'passResume' },
			{ t: 'passEnd' },
			{ t: 'retire', b: 2, committed: false },
		]);
	});

	it('functional replay over a moved base (sweep + late writer)', () => {
		expectClean('alt-b moved base', [{ kind: 'atom', initial: 1 }], [
			{ t: 'openDeferred' }, // 0
			{ t: 'openDeferred' }, // 1
			{ t: 'write', w: { batch: 0, atom: 0, op: 'update', v: 0 } }, // +1
			{ t: 'write', w: { batch: 1, atom: 0, op: 'update', v: 1 } }, // *2
			{ t: 'retire', b: 0, committed: true }, // sweeps fold the base forward
			{ t: 'retire', b: 1, committed: true }, // late writer replays over it
		]);
	});

	it('shrunk seed 39: one grouped drain, two batches writing one region (per-token walk tickets)', () => {
		expectClean('alt-b s39', [{ kind: 'reducer', initial: 2 }], [
			{ t: 'watch', n: 0 },
			{ t: 'openDeferred' }, // 0
			{ t: 'openDeferred' }, // 1
			{
				t: 'group',
				writes: [
					{ batch: 0, atom: 0, op: 'dispatch', v: 7 },
					{ batch: 1, atom: 0, op: 'dispatch', v: 6 },
				],
			},
			{ t: 'retire', b: 0, committed: true },
			{ t: 'retire', b: 1, committed: true },
		]);
	});

	it('shrunk seed 38: truncation re-notifies the truncated world, then re-writes', () => {
		expectClean('alt-b s38', [{ kind: 'atom', initial: 6 }], [
			{ t: 'watch', n: 0 },
			{ t: 'openDeferred' }, // 0
			{ t: 'write', w: { batch: 0, atom: 0, op: 'set', v: 3 } },
			{ t: 'truncate', b: 0 }, // rollback: world 0's value reverts
			{ t: 'write', w: { batch: 0, atom: 0, op: 'set', v: 7 } },
			{ t: 'retire', b: 0, committed: true },
		]);
	});

	it("shrunk seed 36: a W0 no-op retirement still changes other pending worlds' folds", () => {
		expectClean('alt-b s36', [{ kind: 'atom', initial: 9 }], [
			{ t: 'watch', n: 0 },
			{ t: 'openDeferred' }, // 0
			{ t: 'openDeferred' }, // 1: rebase target
			{ t: 'write', w: { batch: 0, atom: 0, op: 'set', v: 7 } },
			{ t: 'retire', b: 0, committed: false },
			{ t: 'write', w: { batch: 1, atom: 0, op: 'update', v: 0 } }, // world 1: 7+1
			{ t: 'openDeferred' }, // 2
			{ t: 'write', w: { batch: 2, atom: 0, op: 'set', v: 7 } }, // equal to W0
			{ t: 'retire', b: 2, committed: true }, // W0 no-op; world 1 reorders
			{ t: 'retire', b: 1, committed: true },
		]);
	});

	it('shrunk seed 17: equal-value urgent-batch write onto a logged atom shifts pending folds', () => {
		expectClean('alt-b s17', [{ kind: 'atom', initial: 8 }], [
			{ t: 'watch', n: 0 },
			{ t: 'openDeferred' }, // 0
			{ t: 'write', w: { batch: 0, atom: 0, op: 'set', v: 6 } }, // world 0: 6
			{ t: 'openUrgent' }, // 1
			{ t: 'write', w: { batch: 1, atom: 0, op: 'set', v: 8 } }, // W0 8→8: no propagate
			{ t: 'retire', b: 1, committed: true },
			{ t: 'retire', b: 0, committed: true },
		]);
	});

	it('shrunk seed 30: revalidation snapshots old values before broadcast decisions re-memoize', () => {
		const specs: NodeSpec[] = [
			{ kind: 'atom', initial: 8 }, // 0
			{ kind: 'atom', initial: 8 }, // 1
			{ kind: 'computed', type: 'sum', srcs: [0, 0] }, // 2
			{ kind: 'atom', initial: 9 }, // 3
			{ kind: 'computed', type: 'branch', srcs: [0, 2, 1] }, // 4
			{ kind: 'computed', type: 'sum', srcs: [2, 4] }, // 5
		];
		expectClean('alt-b s30', specs, [
			{ t: 'openDeferred' }, // 0
			{ t: 'openDeferred' }, // 1
			{ t: 'openDeferred' }, // 2
			{ t: 'newNode', spec: { kind: 'computed', type: 'sum', srcs: [5, 3] } }, // 6
			{ t: 'newNode', spec: { kind: 'computed', type: 'branch', srcs: [4, 3, 6] } }, // 7
			{ t: 'openDeferred' }, // 3
			{ t: 'newNode', spec: { kind: 'computed', type: 'branch', srcs: [0, 3, 5] } }, // 8
			{ t: 'watch', n: 8 },
			{ t: 'openDeferred' }, // 4
			{ t: 'openUrgent' }, // 5
			{ t: 'group', writes: [{ batch: 1, atom: 1, op: 'set', v: 0 }] },
			{ t: 'write', w: { batch: 5, atom: 0, op: 'set', v: 7 } },
			{ t: 'write', w: { batch: 1, atom: 3, op: 'set', v: 4 } },
			{ t: 'write', w: { batch: 4, atom: 0, op: 'set', v: 4 } },
			{ t: 'watch', n: 4 },
			{ t: 'retire', b: 1, committed: true },
			{ t: 'retire', b: 4, committed: true },
			{ t: 'retire', b: 5, committed: true },
		]);
	});
});
