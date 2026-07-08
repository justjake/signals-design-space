/**
 * Routing-authority pins. Deliveries and drains route from the per-world
 * arenas — the arenas are the only routing structure; no separate
 * episode-union edge store exists.
 * Two pin families:
 *
 *  - The dead-arena retreat (three interleavings),
 *    pinned with its documented degraded-but-value-correct outcomes. A
 *    discarded render takes the only arena holding a branch's links with it;
 *    a write in the gap reaches no live arena and delivers nothing (an
 *    episode-union edge store would have scheduled the watcher in the writer's
 *    lane). The repair arrives at the next committed-truth motion via the
 *    drain — value-correct, lane-degraded. Any future silent worsening (or
 *    fix) diffs loudly here.
 *  - Routing coverage pins: the population schedule (the
 *    renderEnd re-staled loop populates the committed arena before any
 *    post-commit write needs routing) and the untracked-fan member
 *    (weak links never carry deliveries through the delivery walk;
 *    drains still reach through them).
 *
 * Every engine reset runs with the divergence check armed (arena-served ≡
 * fold-truth after every public operation) — these schedules must stay
 * clean under the checker while exhibiting the pinned lane outcomes.
 */
import { describe, expect, it } from 'vitest';
import { engine, __TEST__resetEngine, type AnyInternals, type CosignalEngine } from '../src/CosignalEngine.js';
import { armArenaCheck } from './arena-checker.js';
import { attachRefereeStream, refereeStreamOf } from './trace-events.js';

function freshEngine(): CosignalEngine {
	// Finish the previous test's leftover episode so the reset's idle preconditions hold.
	engine.discardAllWip();
	for (const t of engine.liveBatches()) {
		if (t.parked) engine.settleAction(t.id);
		else engine.retire(t.id);
	}
	__TEST__resetEngine();
	const b = engine;
	attachRefereeStream(b); // the decoded packed stream is the event surface
	armArenaCheck(b);
	return b;
}

/** Mount a live committed watcher on `node` via a clean commit. */
function mount(b: CosignalEngine, root: string, node: AnyInternals, name: string) {
	const p = b.renderStart(root, []);
	const w = b.mountWatcher(p.id, node, name);
	b.renderEnd(p.id, 'commit');
	return w;
}

function deliveriesTo(b: CosignalEngine, watcher: string, batch?: number) {
	return refereeStreamOf(b).eventsOfType('delivery').filter((e) => e.watcher === watcher && (batch === undefined || e.batch === batch));
}

function suppressionsTo(b: CosignalEngine, watcher: string, batch?: number) {
	return refereeStreamOf(b).eventsOfType('suppressed').filter((e) => e.watcher === watcher && (batch === undefined || e.batch === batch));
}

function correctionsTo(b: CosignalEngine, watcher: string) {
	return refereeStreamOf(b).eventsOfType('reconcile-correction').filter((e) => e.watcher === watcher);
}

/** The D1 topology: committed truth shows the b-branch; a parked action
 * flips the discriminant only in its own (soon-discarded) render world. */
function d1Topology(b: CosignalEngine) {
	const flag = b.atom('flag', 0);
	const a = b.atom('a', 1);
	const bb = b.atom('b', 2);
	const c = b.computed('c', (read) => ((read(flag) as number) ? read(a) : read(bb)));
	return { flag, a, bb, c };
}

describe('S-NF2-D1 — the dead-arena retreat, pinned (§4.4.5)', () => {
	it('D1-1 second-write-before-render-restart: the pre-discard write delivers (render arena route); the gap write delivers NOTHING — not even a suppression; value repairs at retirement', () => {
		const b = freshEngine();
		const { flag, a, c } = d1Topology(b);
		const w = mount(b, 'R', c, 'W'); // committed arena: {flag,b}→c
		expect(w.lastRenderedValue).toBe(2);

		const T = b.openBatch({ action: true }); // parked: cannot retire until settled
		b.write(T.id, flag, 0, 1); // delivered into T via committed flag→c
		expect(deliveriesTo(b, 'W', T.id).length).toBe(1);

		const pT = b.renderStart('R', [T.id]);
		b.renderValue(c, pT); // T's render evaluates the a-branch: ONLY pT's arena holds a→c
		const U = b.openBatch();
		b.write(U.id, a, 0, 10); // render arena alive: routed, fresh delivery
		expect(deliveriesTo(b, 'W', U.id).length).toBe(1);

		b.renderEnd(pT.id, 'discard'); // the arena — and the only a→c link — dies; T stays pending
		b.write(U.id, a, 0, 20); // THE GAP WRITE
		// Documented degraded outcome: no live arena holds a→c, so the walk
		// collects nothing — no delivery and no suppression (an episode-union
		// edge store would have logged 'suppressed' here; the dedup bit was armed
		// by the first write). The watcher's committed view did not change,
		// so no correction either.
		expect(deliveriesTo(b, 'W', U.id).length).toBe(1);
		expect(suppressionsTo(b, 'W', U.id).length).toBe(0);
		expect(correctionsTo(b, 'W').length).toBe(0);

		// RenderPass restart + commit: T locks in (flag=1 committed), the render
		// folds base a (U still pending) — committed truth agrees.
		const p2 = b.renderStart('R', [T.id]);
		b.renderWatcher(p2.id, w.id);
		b.renderEnd(p2.id, 'commit');
		expect(w.lastRenderedValue).toBe(1); // a-branch at base a
		// U's retirement is the repair boundary: the drain corrects to 20.
		b.retire(U.id);
		expect(w.lastRenderedValue).toBe(20);
		const cs = correctionsTo(b, 'W');
		expect(cs[cs.length - 1]).toMatchObject({ from: 1, to: 20, cause: 'retirement' });
		b.settleAction(T.id);
	});

	it('D1-2 write-after-discard-before-restart: the gap write reaches nothing; the repair arrives in TWO drain corrections as committed truth moves', () => {
		const b = freshEngine();
		const { flag, a, c } = d1Topology(b);
		const w = mount(b, 'R', c, 'W');

		const T = b.openBatch({ action: true });
		b.write(T.id, flag, 0, 1);
		const pT = b.renderStart('R', [T.id]);
		b.renderValue(c, pT); // a-branch links live only here
		b.renderEnd(pT.id, 'discard');

		const U = b.openBatch();
		b.write(U.id, a, 0, 10); // the gap write
		expect(deliveriesTo(b, 'W', U.id).length).toBe(0); // documented: lane-degraded
		expect(w.lastRenderedValue).toBe(2); // committed view unchanged

		// T settles+retires: site-(a) fanout marks flag, the drain refolds c
		// committed (flag=1 → a-branch at base a=1) and re-tracks the
		// committed links to {flag,a} — the refold repairs the routing structure.
		b.settleAction(T.id);
		expect(w.lastRenderedValue).toBe(1);
		expect(correctionsTo(b, 'W')[0]).toMatchObject({ from: 2, to: 1, cause: 'retirement' });
		// U's retirement now routes through the re-tracked a→c: value lands.
		b.retire(U.id);
		expect(w.lastRenderedValue).toBe(10);
		expect(correctionsTo(b, 'W')[1]).toMatchObject({ from: 1, to: 10, cause: 'retirement' });
	});

	it('D1-3 batch-attribution variant (codex 4): U retires FIRST — its boundary shows no motion at all; the whole repair lands at T\'s boundary, attributed to T\'s lane', () => {
		const b = freshEngine();
		const { flag, a, c } = d1Topology(b);
		const w = mount(b, 'R', c, 'W');

		const T = b.openBatch({ action: true });
		b.write(T.id, flag, 0, 1);
		const pT = b.renderStart('R', [T.id]);
		b.renderValue(c, pT);
		b.renderEnd(pT.id, 'discard');

		const U = b.openBatch();
		b.write(U.id, a, 0, 10);
		expect(deliveriesTo(b, 'W', U.id).length).toBe(0); // no route at the write

		// U retires while committed truth still shows the b-branch: the
		// drain's value gate sees no difference — NO correction is
		// attributable to U's lane, ever (its write's visibility is pending
		// on T's flip).
		b.retire(U.id);
		expect(correctionsTo(b, 'W').length).toBe(0);
		expect(w.lastRenderedValue).toBe(2);

		// T's settlement flips the discriminant: ONE correction carries the
		// combined repair (flag=1 AND a=10) — value-correct, with the lane
		// attribution degraded onto T's boundary.
		b.settleAction(T.id);
		expect(correctionsTo(b, 'W').length).toBe(1);
		expect(correctionsTo(b, 'W')[0]).toMatchObject({ from: 2, to: 10, cause: 'retirement' });
		expect(w.lastRenderedValue).toBe(10);
	});
});

describe('S-B routing coverage pins (§4.4.1 / §4.4.2)', () => {
	it('M1 population schedule: mount C=f(A), commit, handler write in a FRESH batch — the walk finds A→C in the root\'s committed arena (the re-staled loop populated it)', () => {
		const b = freshEngine();
		const A = b.atom('A', 0);
		const C = b.computed('C', (read) => read(A));
		const w = mount(b, 'R', C, 'W');
		const t2 = b.openBatch();
		b.write(t2.id, A, 0, 5); // post-commit write, brand-new batch
		expect(deliveriesTo(b, 'W', t2.id).length).toBe(1); // routed via the committed arena
		b.retire(t2.id);
		expect(w.lastRenderedValue).toBe(5);
	});

	it('untracked-fan member THROUGH the new routing: weak links never carry the delivery walk; drains still expand over them', () => {
		const b = freshEngine();
		const a = b.atom('a', 1);
		const bb = b.atom('b', 2);
		const c = b.computed('c', (read, untracked) => (read(bb) as number) + (untracked(a) as number));
		const d = b.computed('d', (read) => (read(c) as number) * 1);
		const w = mount(b, 'R', d, 'W');
		expect(w.lastRenderedValue).toBe(3);
		expect(b.__TEST__arenaLinkMode('R', a, c)).toBe('weak');
		expect(b.__TEST__arenaLinkMode('R', bb, c)).toBe('strong');

		const T = b.openBatch();
		b.write(T.id, a, 0, 100); // untracked dep: the walk tests the weak bit and skips
		expect(deliveriesTo(b, 'W').length).toBe(0);
		expect(suppressionsTo(b, 'W').length).toBe(0);

		const U = b.openBatch();
		b.write(U.id, bb, 0, 5); // tracked dep: delivers
		expect(deliveriesTo(b, 'W', U.id).length).toBe(1);

		// T retires: site-(a) fanout marks `a`, weak a→c propagates PENDING,
		// the drain collects the watcher off the dirty cone, and the
		// committed re-evaluation corrects — coverage without notification.
		b.retire(T.id);
		expect(w.lastRenderedValue).toBe(102); // b=2 still pending in U; a=100 retired
		b.retire(U.id);
		expect(w.lastRenderedValue).toBe(105);
	});
});
