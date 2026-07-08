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
 *   dispatch} × {empty, retired-history, live log}:
 *     - standalone (a handle with no engine content, quiet, no driver — the
 *       node-less arm): ONE invocation (the plain path's drop check against
 *       the pending value). The log columns are VACUOUS here — a log entry
 *       is engine content, so a standalone atom's log is empty by
 *       definition.
 *     - quiet (engine content, nothing pending): ONE invocation (the quiet
 *       fold's drop check against base). The old second invocation — the
 *       kernel re-checking the policy comparator inside the apply — was
 *       R-2's "double invocation" and is corrected: the direct kernel apply
 *       runs no policy comparator. The log columns are VACUOUS while quiet
 *       (the quiet derivation requires the episode's write records dropped).
 *     - recorded, EMPTY log: TWO invocations — the drop check (the
 *       acceptance decision against base) and the eager kernel apply's
 *       stepwise gate (against kernel newest). Both are pinned sites; the
 *       old third (the public-method re-entry) is corrected away.
 *     - recorded, RETIRED-HISTORY log (every entry retired at or below every
 *       live render pin): the SAME counts as the empty cell — the drop
 *       check runs against kernel newest, the one value every world folds
 *       to (the eager-apply invariant). This is exactly the state where the
 *       reference model's log is empty (it folds retired pin-clear history
 *       eagerly at each boundary; the engine keeps the entries and drops
 *       them wholesale at the episode close).
 *     - recorded, LIVE log (an unretired or pinned entry exists): ONE
 *       invocation — no drop check while worlds may fold different previous
 *       values; only the eager apply's gate runs.
 *
 *   FOLDS RE-INVOKE PER ENTRY BY DESIGN (documented, pinned below):
 *   replaying a log is one comparator call per visible entry, in kernel
 *   order — replay fidelity, not an acceptance decision. Two fold sites
 *   exist: world folds, and the bounded-memory sealed-chunk fold that keeps
 *   a held-open episode's log finite (WriteLog.ts foldSealedChunks).
 *
 *   THE EPISODE CLOSE RE-INVOKES NOTHING (the flattening's one sanctioned
 *   semantic change, replacing the repealed per-entry re-invocation at
 *   retirement): when the last batch retires with every render closed, each
 *   touched atom's base adopts kernel newest BY IDENTITY — every write's
 *   acceptance gate was already paid at the write — and the log drops
 *   whole. ZERO comparator invocations, pinned below.
 *
 * The oracle keeps its own eager per-boundary folds (its compactAtom
 * re-invokes model-side; comparators are pure by the fold contract, so the
 * count difference is unobservable to lockstep) and the fuzz corpus carries
 * a custom-equals topology member, so lockstep checks the acceptance/order
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
		engine.write(t.id, node, 1, (n: unknown) => (n as number) + 1); // update, log now LIVE (unretired entry)
		// No drop check with live history present; the eager gate folds over
		// kernel newest (2 -> 3): ONE invocation.
		expect(p.calls).toEqual([[2, 3]]);
		p.reset();
		const reduce = (s: number, act: number) => s + act;
		engine.write(t.id, node, 1, (s: unknown) => reduce(s as number, 7)); // the dispatch shape
		expect(p.calls).toEqual([[3, 10]]);
		engine.retire(t.id);
	});

	it('recorded, RETIRED-HISTORY log: the drop check re-arms against kernel newest — the same counts as the empty cell', () => {
		freshEngine();
		const p = probeComparator();
		const node = engine.atom('rh', 0, p.eq);
		const hold = engine.openBatch(); // write-free: holds the episode open past t's retirement
		const t = engine.openBatch();
		engine.write(t.id, node, 0, 5);
		engine.retire(t.id); // every entry retired, no pins — but `hold` keeps the episode (and the log) alive
		expect(node.log.materialize()).toHaveLength(1); // the entry persists until the episode drop
		p.reset();
		// Equal against kernel newest (the one value every world folds to):
		// DROPPED after ONE invocation, exactly as an empty-log drop — this is
		// the state where the reference model's log is already empty.
		engine.write(hold.id, node, 0, 5);
		expect(p.calls).toEqual([[5, 5]]);
		expect(node.log.materialize()).toHaveLength(1); // no entry appended
		p.reset();
		// Unequal: accepted with the empty cell's TWO invocations — the
		// re-armed drop check, then the eager apply gate (both against newest).
		engine.write(hold.id, node, 0, 6);
		expect(p.calls).toEqual([[5, 6], [5, 6]]);
		engine.retire(hold.id);
	});

	it('world folds re-invoke per entry BY DESIGN, in kernel order; the episode close re-invokes NOTHING', () => {
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
		// THE REWRITTEN PIN (the flattening's one sanctioned semantic change).
		// The repealed contract: retirement's fold once re-invoked the
		// comparator per entry as it folded the retired prefix into base. The
		// new mechanism: this retirement is the last pending durable work, so
		// the EPISODE CLOSES — base adopts kernel newest by identity (each
		// write's sole acceptance gate already ran at the write, pinned
		// above), the log drops whole, and the comparator runs ZERO times.
		engine.retire(t.id);
		expect(p.calls).toEqual([]);
		expect(node.log.materialize()).toHaveLength(0);
		expect(node.base).toBe(2);
	});

	it('the bounded-memory sealed-chunk fold (held-open episode) replays per entry, kernel order; the close still re-invokes nothing', () => {
		freshEngine();
		const p = probeComparator();
		const node = engine.atom('chunky', 0, p.eq);
		const parked = engine.openBatch({ action: true }); // a parked action holds the episode open indefinitely
		const t = engine.openBatch();
		const CHUNK = 1024; // WriteLog.ts TAPE_CHUNK_ENTRIES
		const N = CHUNK + 200; // one full (sealed) chunk + a partial tail
		for (let i = 1; i <= N; i++) engine.write(t.id, node, 0, i);
		p.reset();
		// Retiring t stamps every entry, but the parked action keeps the
		// episode open — the sealed-chunk valve folds the FULL chunk into base
		// (per entry, kernel order: replay fidelity) and keeps the tail.
		engine.retire(t.id);
		expect(p.calls.length).toBe(CHUNK);
		expect(p.calls[0]).toEqual([0, 1]);
		expect(p.calls[CHUNK - 1]).toEqual([CHUNK - 1, CHUNK]);
		expect(node.base).toBe(CHUNK);
		expect(node.log.length).toBe(N - CHUNK); // the partial tail stays for the episode drop
		p.reset();
		// Settlement retires the last batch: the episode closes; the tail
		// drops whole with base adopting kernel newest by identity — zero
		// comparator invocations.
		engine.settleAction(parked.id);
		expect(p.calls).toEqual([]);
		expect(node.log.length).toBe(0);
		expect(node.base).toBe(N);
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
