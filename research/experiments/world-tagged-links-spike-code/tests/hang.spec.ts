/**
 * NF2 entry-criterion regression test (spec/react-compliance-contract.md §5):
 * the disposal-hang schedule — a dep-flipping computed (flag ? a : b)
 * evaluated under two worlds with different flag values, interleaved with
 * deliveries/invalidation mid-walk, then disposal.
 *
 * RED half: the FAILED historical design (world evaluations hosted on the
 * kernel's own computed records/links — `__naiveWorldRead`) must corrupt:
 * wrong per-world values, a poisoned newest cache, or structural link damage.
 * GREEN half: the world-tagged (per-world segregated plane) mechanism
 * `__worldRead` must terminate, serve correct per-world values, leave the
 * kernel plane structurally sound, and dispose cleanly.
 *
 * Written BEFORE the prototype (red = exports missing), kept green throughout.
 */
import { describe, expect, test } from 'vitest';
import {
	Atom,
	Computed,
	effect,
	// ---- spike-only surface (world-tagged links prototype) ----
	__worldBegin,
	__worldSet,
	__worldRead,
	__worldDiscard,
	__worldLiveCount,
	__naiveWorldRead,
	__spikeGraphCheck,
} from '../cosignal/src/index.js';

/**
 * The NF2 graph: c = flag ? a : b through a middle computed layer, watched
 * by a kernel effect so unwatched/dispose cascades engage.
 */
function buildGraph() {
	const flag = new Atom(true);
	const a = new Atom(10);
	const b = new Atom(20);
	// middle computed — the dep-flipper (kernel-shared, world-evaluated)
	const m = new Computed<number>(() => (flag.state ? a.state : b.state));
	// downstream computed — gives dispose walks depth (computed-on-computed)
	const c = new Computed<number>(() => m.state + 1);
	const seen: number[] = [];
	const dispose = effect(() => {
		seen.push(c.state);
	});
	const ids = [flag._id, a._id, b._id, m._id, c._id];
	return { flag, a, b, m, c, seen, dispose, ids };
}

describe('NF2 hang schedule', () => {
	test('GREEN: world-tagged evaluation terminates, is per-world correct, disposes cleanly', () => {
		const g = buildGraph();
		expect(g.seen).toEqual([11]); // effect ran: newest flag=true -> a=10 -> c=11

		// Two worlds with DIFFERENT flag values (the dep flip).
		const w1 = __worldBegin(); // will see flag=false -> b branch
		const w2 = __worldBegin(); // will see flag=true (kernel) -> a branch
		__worldSet(w1, g.flag as Atom<unknown>, false);

		// First evaluations under both worlds (deps diverge: m@w1 -> {flag,b}, m@w2 -> {flag,a}).
		expect(__worldRead(w1, g.c)).toBe(21); // b=20 + 1
		expect(__worldRead(w2, g.c)).toBe(11); // a=10 + 1
		__spikeGraphCheck(g.ids);

		// DELIVERY mid-schedule: kernel write while both worlds hold live links.
		g.a.set(100); // newest: c=101; w2 (no override on a) must see it; w1 unaffected (b branch)
		expect(g.seen[g.seen.length - 1]).toBe(101);
		expect(__worldRead(w2, g.c)).toBe(101);
		expect(__worldRead(w1, g.c)).toBe(21);
		__spikeGraphCheck(g.ids);

		// INVALIDATION mid-schedule: world-local write flips w1's branch BACK
		// (dep flip in the opposite direction, re-track under the world).
		__worldSet(w1, g.flag as Atom<unknown>, true);
		expect(__worldRead(w1, g.c)).toBe(101); // now a branch, a=100
		__worldSet(w1, g.flag as Atom<unknown>, false);
		expect(__worldRead(w1, g.c)).toBe(21); // back to b branch
		__spikeGraphCheck(g.ids);

		// Delivery INTERLEAVED with world evaluation mid-walk: a computed whose
		// getter WRITES a kernel signal (tolerated writes-in-computeds) while a
		// world evaluation frame is open — propagate runs inside the eval.
		const poker = new Atom(0);
		const noisy = new Computed<number>(() => {
			const v = g.flag.state ? g.a.state : g.b.state;
			poker.set(v); // kernel propagate during (world) evaluation
			return v;
		});
		expect(__worldRead(w1, noisy)).toBe(20); // w1: flag=false -> b
		expect(__worldRead(w2, noisy)).toBe(100); // w2: flag=true -> a=100
		expect(noisy.state).toBe(100); // newest evaluation, kernel path
		__spikeGraphCheck([...g.ids, poker._id, noisy._id]);

		// Kernel dep flip UNDER live worlds: newest re-track while world links live.
		g.flag.set(false); // newest: m -> {flag, b}; effect sees c=21
		expect(g.seen[g.seen.length - 1]).toBe(21);
		expect(__worldRead(w2, g.c)).toBe(21); // w2 has no flag override: sees kernel flip
		expect(__worldRead(w1, g.c)).toBe(21);
		__spikeGraphCheck(g.ids);

		// DISPOSAL: the NF2 hang site — unwatched computed cascade
		// (disposeAllDepsInReverse) with world links still live.
		g.dispose();
		__spikeGraphCheck(g.ids);
		// Kernel still fully functional after dispose (lazy re-eval).
		g.a.set(7);
		g.flag.set(true);
		expect(g.c.state).toBe(8);
		// Worlds still correct after kernel dispose/writes.
		expect(__worldRead(w1, g.c)).toBe(21); // w1: flag=false override, b=20
		expect(__worldRead(w2, g.c)).toBe(8);

		// WORLD TEARDOWN, both modes: surgical (per-edge) and bulk.
		__worldDiscard(w1, 'surgical');
		__worldDiscard(w2, 'bulk');
		expect(__worldLiveCount()).toBe(0);
		__spikeGraphCheck(g.ids);
		// Zero-world sync semantics fully intact after everything.
		g.b.set(99);
		g.flag.set(false);
		expect(g.c.state).toBe(100);
	});

	test('RED (documents the failed design): naive kernel-hosted world evaluation corrupts', () => {
		const g = buildGraph();
		const w1 = __worldBegin();
		__worldSet(w1, g.flag as Atom<unknown>, false);

		// Naive world read rides the kernel's OWN computed records: link lists
		// re-tracked per world, kernel value slots absorbing world folds.
		const w1c = __naiveWorldRead(w1, g.c);
		expect(w1c).toBe(21); // the naive read itself computes the right fold...

		// ...but the kernel cache is now POISONED: the newest world must see
		// flag=true -> a=10 -> 11, and the effect (kernel subscriber) was never
		// told anything changed — no invalidation separates the streams.
		const newestAfter = g.c.state;
		const corrupted =
			newestAfter !== 11 // stale world fold served as newest (tearing)
			|| (() => {
				try {
					__spikeGraphCheck(g.ids);
					return false;
				} catch {
					return true; // structural link damage
				}
			})();
		expect(corrupted).toBe(true);
		__worldDiscard(w1, 'bulk');
	});

	test('GREEN: discard-heavy churn with dep flips never corrupts and never leaks', () => {
		const g = buildGraph();
		for (let i = 0; i < 200; i++) {
			const w = __worldBegin();
			if (i & 1) __worldSet(w, g.flag as Atom<unknown>, false);
			expect(__worldRead(w, g.c)).toBe(i & 1 ? 21 : 11);
			if (i % 3 === 0) g.a.set(10 + (i % 2)); // interleaved deliveries
			g.a.set(10);
			__worldDiscard(w, i % 2 ? 'bulk' : 'surgical');
		}
		expect(__worldLiveCount()).toBe(0);
		__spikeGraphCheck(g.ids);
		g.dispose();
		__spikeGraphCheck(g.ids);
		expect(g.c.state).toBe(11);
	});
});
