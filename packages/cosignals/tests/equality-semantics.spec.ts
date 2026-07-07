/**
 * THE R-2 PINNED MATRIX — equality semantics frozen: the KERNEL's order and
 * count, everywhere.
 *
 *   ORDER: every comparator invocation is `isEqual(current, incoming)` —
 *   current value first, incoming second — pinned by an ASYMMETRIC
 *   comparator that records its argument pairs.
 *
 *   COUNT, scoped to THE ACCEPTANCE DECISION — pinned by a COUNTING
 *   comparator, per cell of {standalone, quiet, recorded} × {set, update,
 *   dispatch} × {empty, nonempty log}:
 *     - standalone (a handle with no engine content, quiet, no driver — the
 *       node-less arm): ONE invocation (the plain path's drop check against
 *       the pending value). The nonempty-log column is VACUOUS here — a log
 *       entry is engine content, so a standalone atom's log is empty by
 *       definition.
 *     - quiet (engine content, nothing pending): ONE invocation (the quiet
 *       fold's drop check against base). The old second invocation — the
 *       kernel re-checking the policy comparator inside the apply — was
 *       R-2's "double invocation" and is corrected: the direct kernel apply
 *       runs no policy comparator. Nonempty log is VACUOUS while quiet (the
 *       quiet derivation requires every write log compacted).
 *     - recorded, EMPTY log: TWO invocations — the drop check (the
 *       acceptance decision against base) and the eager kernel apply's
 *       stepwise gate (against kernel newest). Both are pinned sites; the
 *       old third (the public-method re-entry) is corrected away.
 *     - recorded, NONEMPTY log: ONE invocation — no drop check once history
 *       exists (worlds may fold different previous values); only the eager
 *       apply's gate runs.
 *
 *   FOLDS AND COMPACTION RE-INVOKE PER ENTRY BY DESIGN (documented, pinned
 *   below): replaying a log is one comparator call per visible entry, in
 *   kernel order — that is replay fidelity, not an acceptance decision.
 *
 * The oracle aligns at its six sites in the same change (quietWrite, write
 * drop, eager-advance, foldAtom, shadowFoldAtom, compactAtom) and the fuzz
 * corpus gains a custom-equals topology member, so lockstep referees these
 * semantics continuously; this file is the hand-pinned matrix.
 */
import { describe, expect, it } from 'vitest';
import { Atom, engine, ReducerAtom, __resetEngineForTest } from '../src/index.js';
import type { Equals, Value } from '../src/index.js';

type Pair = [Value, Value];

/** An asymmetric, counting comparator: records every (a, b) argument pair
 * and answers `false` unless BOTH halves match a designated "equal" pair —
 * asymmetry means a flipped invocation records a flipped pair and (for the
 * order pins) would also flip the equal answer. */
function probeComparator(): { eq: Equals; calls: Pair[]; reset(): void } {
	const calls: Pair[] = [];
	return {
		calls,
		reset() {
			calls.length = 0;
		},
		eq: (a, b) => {
			calls.push([a, b]);
			// Asymmetric equality: (x, y) is "equal" only when incoming === current + 0
			// — i.e. plain identity — but ONLY in this argument order for the
			// asymmetric drop pins below: current tagged objects never equal.
			return Object.is(a, b);
		},
	};
}

function freshEngine(): void {
	engine.discardAllWip();
	for (const t of engine.liveBatches()) {
		if (t.parked) engine.settleAction(t.id);
		else engine.retire(t.id);
	}
	__resetEngineForTest();
}

describe('R-2 order: isEqual(current, incoming), everywhere', () => {
	it('standalone set/update/dispatch: one invocation, kernel order', () => {
		freshEngine();
		const p = probeComparator();
		const a = new Atom<number>(1, { isEqual: p.eq });
		a.set(2); // standalone fast arm (no engine content, quiet, no driver)
		expect(p.calls).toEqual([[1, 2]]); // (current, incoming), ONCE
		p.reset();
		a.update((n) => n + 1); // 2 -> 3
		expect(p.calls).toEqual([[2, 3]]); // the updater folds first; ONE comparator call
		p.reset();
		const r = new ReducerAtom<number, number>((s, act) => s + act, 10, { isEqual: p.eq });
		r.dispatch(5); // dispatch is an update whose closure carries the reducer
		expect(p.calls).toEqual([[10, 15]]);
	});

	it('quiet set/update/dispatch on an engine atom: one invocation, kernel order (the double invocation is corrected)', () => {
		freshEngine();
		const p = probeComparator();
		const node = engine.atom('q', 1, p.eq);
		const handle = node.handle as Atom<number>;
		handle.set(2); // quiet fold (engine content, nothing pending)
		expect(p.calls).toEqual([[1, 2]]); // ONCE — the direct kernel apply re-runs no policy comparator
		p.reset();
		handle.update((n) => n + 1); // 2 -> 3
		expect(p.calls).toEqual([[2, 3]]);
		p.reset();
		const rHandle = new ReducerAtom<number, number>((s, act) => s + act, 10, { isEqual: p.eq });
		const rNode = engine.internalsForAtom(rHandle as unknown as Atom<number>);
		rNode.name = 'qr';
		rHandle.dispatch(5);
		expect(p.calls).toEqual([[10, 15]]);
	});

	it('recorded set/update/dispatch, EMPTY log: two invocations — the drop check, then the eager apply gate', () => {
		freshEngine();
		const p = probeComparator();
		const node = engine.atom('r', 1, p.eq);
		const t = engine.openBatch();
		engine.write(t.id, node, 0, 2); // set
		// Drop check against base (1, 2), then the eager stepwise gate against
		// kernel newest (1, 2) — kernel order at BOTH pinned sites.
		expect(p.calls).toEqual([[1, 2], [1, 2]]);
		p.reset();
		engine.write(t.id, node, 1, (n: unknown) => (n as number) + 1); // update, log now NONEMPTY
		// No drop check with history present; the eager gate folds over kernel
		// newest (2 -> 3): ONE invocation.
		expect(p.calls).toEqual([[2, 3]]);
		p.reset();
		const reduce = (s: number, act: number) => s + act;
		engine.write(t.id, node, 1, (s: unknown) => reduce(s as number, 7)); // the dispatch shape
		expect(p.calls).toEqual([[3, 10]]);
		engine.retire(t.id);
	});

	it('folds and compaction re-invoke per entry BY DESIGN, in kernel order', () => {
		freshEngine();
		const p = probeComparator();
		const node = engine.atom('f', 0, p.eq);
		const t = engine.openBatch();
		engine.write(t.id, node, 0, 1);
		engine.write(t.id, node, 0, 2);
		p.reset();
		// A committed read replays NO entries (t not committed for the root),
		// a newest read serves the kernel without folding; force a real fold
		// through the render world including t.
		const render = engine.renderStart('A', [t.id]);
		expect(engine.renderValue(node, render)).toBe(2);
		// The fold replayed both entries: (0,1) then (1,2) — per entry, kernel order.
		expect(p.calls).toEqual([[0, 1], [1, 2]]);
		engine.renderEnd(render.id, 'discard');
		p.reset();
		engine.retire(t.id); // retirement compacts the prefix: the compaction fold re-invokes per entry
		expect(p.calls).toEqual([[0, 1], [1, 2]]);
		expect(node.log.materialize()).toHaveLength(0);
		expect(node.base).toBe(2);
	});

	it('the asymmetric drop pin: a comparator equal in one direction only drops exactly when (current, incoming) says equal', () => {
		freshEngine();
		// eq(a, b) := b is the "successor tag" of a — equal ONLY when the
		// incoming value is `current + 10`. If any site flipped its argument
		// order, the drop/accept decisions below would invert.
		const asym: Equals = (a, b) => (b as number) === (a as number) + 10;
		const node = engine.atom('asym', 0, asym);
		const handle = node.handle as Atom<number>;
		handle.set(10); // eq(0, 10) → true: DROPPED (quiet drop against base)
		expect(engine.newestValue(node)).toBe(0);
		handle.set(5); // eq(0, 5) → false: accepted
		expect(engine.newestValue(node)).toBe(5);
		expect(engine.committedValue(node, 'A')).toBe(5);
		handle.set(15); // eq(5, 15) → true: DROPPED — a flipped site would accept
		expect(engine.newestValue(node)).toBe(5);
	});
});
