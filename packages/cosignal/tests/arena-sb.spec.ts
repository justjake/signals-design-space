/**
 * NF2 P2.S-B pins — the routing-authority transfer (plans/2026-07-06 §4.8
 * S-B). Deliveries and drains route from the per-world ARENAS; K1 is gone.
 * Two pin families:
 *
 *  - S-NF2-D1 (§4.4.5, three interleavings): the DEAD-ARENA retREAT,
 *    pinned with its documented degraded-but-value-correct outcomes. A
 *    discarded pass takes the only arena holding a branch's links with it;
 *    a write in the gap reaches NO live arena and delivers NOTHING (HEAD's
 *    episode-union K1 would have scheduled the watcher in the writer's
 *    lane). The repair arrives at the next committed-truth motion via the
 *    drain — value-correct, lane-degraded. Any future silent worsening (or
 *    fix) diffs loudly here.
 *  - Routing coverage pins: M1's population schedule (§4.4.2 — the
 *    passEnd re-staled loop populates the committed arena BEFORE any
 *    post-commit write needs routing) and the untracked-fan member
 *    (§4.4.1 — weak links never carry deliveries THROUGH the new walk;
 *    drains still reach through them).
 *
 * Every bridge runs with the divergence check ARMED (arena-served ≡
 * fold-truth after every public operation) — these schedules must stay
 * clean under the S-B checker while exhibiting the pinned lane outcomes.
 */
import { describe, expect, it } from 'vitest';
import { __newBridgeForTest, type AnyNode, type CosignalBridge } from '../src/concurrent.js';

function bridge(): CosignalBridge {
	const b = __newBridgeForTest();
	b.registerBridge();
	b.__setArenaCheck(true);
	return b;
}

/** Mount a live committed watcher on `node` via a clean commit. */
function mount(b: CosignalBridge, root: string, node: AnyNode, name: string) {
	const p = b.passStart(root, []);
	const w = b.mountWatcher(p.id, node, name);
	b.passEnd(p.id, 'commit');
	return w;
}

function deliveriesTo(b: CosignalBridge, watcher: string, token?: number) {
	return b.eventsOfType('delivery').filter((e) => e.watcher === watcher && (token === undefined || e.token === token));
}

function suppressionsTo(b: CosignalBridge, watcher: string, token?: number) {
	return b.eventsOfType('suppressed').filter((e) => e.watcher === watcher && (token === undefined || e.token === token));
}

function correctionsTo(b: CosignalBridge, watcher: string) {
	return b.eventsOfType('reconcile-correction').filter((e) => e.watcher === watcher);
}

/** The D1 topology: committed truth shows the b-branch; a parked action
 * flips the discriminant only in its own (soon-discarded) pass world. */
function d1Topology(b: CosignalBridge) {
	const flag = b.atom('flag', 0);
	const a = b.atom('a', 1);
	const bb = b.atom('b', 2);
	const c = b.computed('c', (read) => ((read(flag) as number) ? read(a) : read(bb)));
	return { flag, a, bb, c };
}

describe('S-NF2-D1 — the dead-arena retreat, pinned (§4.4.5)', () => {
	it('D1-1 second-write-before-pass-restart: the pre-discard write delivers (pass arena route); the gap write delivers NOTHING — not even a suppression; value repairs at retirement', () => {
		const b = bridge();
		const { flag, a, c } = d1Topology(b);
		const w = mount(b, 'R', c, 'W'); // committed arena: {flag,b}→c
		expect(w.lastRenderedValue).toBe(2);

		const T = b.openBatch({ action: true }); // parked: cannot retire until settled
		b.write(T.id, flag, { kind: 'set', value: 1 }); // delivered into T via committed flag→c
		expect(deliveriesTo(b, 'W', T.id).length).toBe(1);

		const pT = b.passStart('R', [T.id]);
		b.passValue(c, pT); // T's pass evaluates the a-branch: ONLY pT's arena holds a→c
		const U = b.openBatch();
		b.write(U.id, a, { kind: 'set', value: 10 }); // pass arena alive: routed, fresh delivery
		expect(deliveriesTo(b, 'W', U.id).length).toBe(1);

		b.passEnd(pT.id, 'discard'); // the arena — and the only a→c link — dies; T stays pending
		b.write(U.id, a, { kind: 'set', value: 20 }); // THE GAP WRITE
		// Documented degraded outcome: no live arena holds a→c, so the walk
		// collects nothing — no delivery AND no suppression (HEAD's K1 union
		// logged 'suppressed' here; the dedup bit was armed by the first
		// write). The watcher's committed view did not change (RCC-SP5's
		// MUST half is met): no correction either.
		expect(deliveriesTo(b, 'W', U.id).length).toBe(1);
		expect(suppressionsTo(b, 'W', U.id).length).toBe(0);
		expect(correctionsTo(b, 'W').length).toBe(0);

		// Pass restart + commit: T locks in (flag=1 committed), the render
		// folds base a (U still pending) — committed truth agrees.
		const p2 = b.passStart('R', [T.id]);
		b.renderWatcher(p2.id, w.id);
		b.passEnd(p2.id, 'commit');
		expect(w.lastRenderedValue).toBe(1); // a-branch at base a
		// U's retirement is the repair boundary: the drain corrects to 20.
		b.retire(U.id, true);
		expect(w.lastRenderedValue).toBe(20);
		const cs = correctionsTo(b, 'W');
		expect(cs[cs.length - 1]).toMatchObject({ from: 1, to: 20, cause: 'retirement' });
		b.settleAction(T.id, true);
	});

	it('D1-2 write-after-discard-before-restart: the gap write reaches nothing; the repair arrives in TWO drain corrections as committed truth moves', () => {
		const b = bridge();
		const { flag, a, c } = d1Topology(b);
		const w = mount(b, 'R', c, 'W');

		const T = b.openBatch({ action: true });
		b.write(T.id, flag, { kind: 'set', value: 1 });
		const pT = b.passStart('R', [T.id]);
		b.passValue(c, pT); // a-branch links live only here
		b.passEnd(pT.id, 'discard');

		const U = b.openBatch();
		b.write(U.id, a, { kind: 'set', value: 10 }); // the gap write
		expect(deliveriesTo(b, 'W', U.id).length).toBe(0); // documented: lane-degraded
		expect(w.lastRenderedValue).toBe(2); // committed view unchanged

		// T settles+retires: site-(a) fanout marks flag, the drain refolds c
		// committed (flag=1 → a-branch at base a=1) and RE-TRACKS the
		// committed links to {flag,a} — the §4.4.4(ii) discriminant repair.
		b.settleAction(T.id, true);
		expect(w.lastRenderedValue).toBe(1);
		expect(correctionsTo(b, 'W')[0]).toMatchObject({ from: 2, to: 1, cause: 'retirement' });
		// U's retirement now routes through the re-tracked a→c: value lands.
		b.retire(U.id, true);
		expect(w.lastRenderedValue).toBe(10);
		expect(correctionsTo(b, 'W')[1]).toMatchObject({ from: 1, to: 10, cause: 'retirement' });
	});

	it('D1-3 batch-attribution variant (codex 4): U retires FIRST — its boundary shows no motion at all; the whole repair lands at T\'s boundary, attributed to T\'s lane', () => {
		const b = bridge();
		const { flag, a, c } = d1Topology(b);
		const w = mount(b, 'R', c, 'W');

		const T = b.openBatch({ action: true });
		b.write(T.id, flag, { kind: 'set', value: 1 });
		const pT = b.passStart('R', [T.id]);
		b.passValue(c, pT);
		b.passEnd(pT.id, 'discard');

		const U = b.openBatch();
		b.write(U.id, a, { kind: 'set', value: 10 });
		expect(deliveriesTo(b, 'W', U.id).length).toBe(0); // no route at the write

		// U retires while committed truth still shows the b-branch: the
		// drain's value gate sees no difference — NO correction is
		// attributable to U's lane, ever (its write's visibility is pending
		// on T's flip).
		b.retire(U.id, true);
		expect(correctionsTo(b, 'W').length).toBe(0);
		expect(w.lastRenderedValue).toBe(2);

		// T's settlement flips the discriminant: ONE correction carries the
		// combined repair (flag=1 AND a=10) — value-correct, with the lane
		// attribution degraded onto T's boundary.
		b.settleAction(T.id, true);
		expect(correctionsTo(b, 'W').length).toBe(1);
		expect(correctionsTo(b, 'W')[0]).toMatchObject({ from: 2, to: 10, cause: 'retirement' });
		expect(w.lastRenderedValue).toBe(10);
	});
});

describe('S-B routing coverage pins (§4.4.1 / §4.4.2)', () => {
	it('M1 population schedule: mount C=f(A), commit, handler write in a FRESH batch — the walk finds A→C in the root\'s committed arena (the re-staled loop populated it)', () => {
		const b = bridge();
		const A = b.atom('A', 0);
		const C = b.computed('C', (read) => read(A));
		const w = mount(b, 'R', C, 'W');
		const t2 = b.openBatch();
		b.write(t2.id, A, { kind: 'set', value: 5 }); // post-commit write, brand-new batch
		expect(deliveriesTo(b, 'W', t2.id).length).toBe(1); // routed via the committed arena
		b.retire(t2.id, true);
		expect(w.lastRenderedValue).toBe(5);
	});

	it('untracked-fan member THROUGH the new routing: weak links never carry the delivery walk; drains still expand over them', () => {
		const b = bridge();
		const a = b.atom('a', 1);
		const bb = b.atom('b', 2);
		const c = b.computed('c', (read, untracked) => (read(bb) as number) + (untracked(a) as number));
		const d = b.computed('d', (read) => (read(c) as number) * 1);
		const w = mount(b, 'R', d, 'W');
		expect(w.lastRenderedValue).toBe(3);
		expect(b.__arenaLinkMode('R', a, c)).toBe('weak');
		expect(b.__arenaLinkMode('R', bb, c)).toBe('strong');

		const T = b.openBatch();
		b.write(T.id, a, { kind: 'set', value: 100 }); // untracked dep: the walk tests the weak bit and skips
		expect(deliveriesTo(b, 'W').length).toBe(0);
		expect(suppressionsTo(b, 'W').length).toBe(0);

		const U = b.openBatch();
		b.write(U.id, bb, { kind: 'set', value: 5 }); // tracked dep: delivers
		expect(deliveriesTo(b, 'W', U.id).length).toBe(1);

		// T retires: site-(a) fanout marks `a`, weak a→c propagates PENDING,
		// the drain collects the watcher off the dirty cone, and the
		// committed re-evaluation corrects — coverage without notification.
		b.retire(T.id, true);
		expect(w.lastRenderedValue).toBe(102); // b=2 still pending in U; a=100 retired
		b.retire(U.id, true);
		expect(w.lastRenderedValue).toBe(105);
	});
});
