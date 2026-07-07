/**
 * Link free-list discipline: the kernel threads its link free list through a
 * spare link field (LinkField.FREE_NEXT = 7), never through NEXT_DEP,
 * because upstream's walks deliberately read stale nextDep/nextSub off links
 * unlinked earlier in the same walk (conformance #203 exercises exactly
 * that) and those stale pointers must keep naming former neighbors — never
 * the free list.
 *
 * These tests are mutation-style: with the free list threaded through
 * NEXT_DEP (the pre-fix layout), checkDirty's unwind pops a link freed by a
 * mid-walk dispose, reads its NEXT_DEP — now a free-list pointer — and walks
 * INTO the free list, treating freed records as live links: it reads DEP off
 * them and update()s whatever those stale ids name (silent spurious
 * recomputes). A fresh arena hides the bug (free head = 0 terminates the
 * walk), so the tests PRIME the free list first.
 */
import { describe, expect, test } from 'vitest';
import { Atom, Computed, effect } from '../src/index';
import { E, maybeBoundary, __reclaimStatsForTest } from '../src/graph.js';

describe('kernel link free list threads through a spare field', () => {
	test('#203 shape with a primed free list: the mid-walk-freed link must not lead into the free list', () => {
		// --- The #203 graph FIRST (its links allocate from the bump pointer,
		//     so the primed free list below stays intact until the schedule).
		//   S(s) → *C(a)  [always returns 0]
		//   S(s) →  C(a2) [disposes eff when s truthy]
		//     {a, a2} → C(b) ← E(eff)
		const s = new Atom(0);
		let disposeEff!: () => void;
		let aEvals = 0;
		let a2Evals = 0;
		let bEvals = 0;
		const a = new Computed(() => {
			aEvals++;
			s.state;
			return 0; // value never changes
		});
		const a2 = new Computed(() => {
			a2Evals++;
			if (s.state) {
				disposeEff();
			}
			return s.state;
		});
		const b = new Computed(() => {
			bEvals++;
			a.state;
			a2.state;
			return 0;
		});
		disposeEff = effect(() => {
			b.state;
		});
		expect([aEvals, a2Evals, bEvals]).toEqual([1, 1, 1]);

		// --- PRIME the link free list: build and tear down a victim cone, so
		//     the free head points at freed links whose stale DEP fields still
		//     name `victim` — a live, unwatched-DIRTY computed. A walk that
		//     enters the free list will update() it.
		const s2 = new Atom(0);
		let victimEvals = 0;
		const victim = new Computed(() => {
			victimEvals++;
			return s2.state;
		});
		const disposeVictimEffect = effect(() => {
			victim.state;
		});
		expect(victimEvals).toBe(1);
		disposeVictimEffect(); // frees eff2→victim, then victim unwatched: DIRTY + frees victim→s2

		// --- The #203 schedule: a2's update disposes eff mid-checkDirty. The
		//     unwind pops the freed eff→b link; its stale NEXT_DEP must read as
		//     the former neighbor (0 — eff had one dep), NOT the free list.
		expect(() => s.set(1)).not.toThrow();

		// Exact pull counts. The in-graph recomputes (a, a2, b once more each)
		// are upstream-conformant behavior; `victim` is OUTSIDE the schedule's
		// cone and must never be pulled. Pre-fix this reads 2: checkDirty's
		// unwind followed eff→b.NEXT_DEP (= the primed free head) into the
		// free list and update()ed victim off a freed link's stale DEP.
		expect(victimEvals).toBe(1);
		// `a` evaluates twice during the schedule: once from checkDirty's own
		// update(), once more when b's rebuild pulls it (the dispose cascade
		// left it unwatched-DIRTY mid-walk). `a2` evaluates once: it was
		// mid-evaluation when the cascade reached it (its own getter ran the
		// dispose), and unwatched() never strips mid-evaluation records
		// (stripping the live re-track cursor makes dep lists go cyclic — a
		// hang), so its just-computed cache serves b's rebuild.
		expect([aEvals, a2Evals, bEvals]).toEqual([3, 2, 2]);
	});

	test('primed free list + mid-walk dispose leaves the free list coherent (allocation after the schedule)', () => {
		// Same shape; afterwards, churn allocations through the free list and
		// assert the graph still behaves — a walk that entered the free list
		// can re-track freed records into live chains (double-use) and corrupt
		// later allocations.
		const s = new Atom(0);
		let disposeEff!: () => void;
		const a = new Computed(() => {
			s.state;
			return 0;
		});
		const a2 = new Computed(() => {
			if (s.state) {
				disposeEff();
			}
			return s.state;
		});
		const b = new Computed(() => {
			a.state;
			a2.state;
			return 0;
		});
		disposeEff = effect(() => {
			b.state;
		});

		// Prime with a WIDE cone so the free list is deep.
		const spares: Atom<number>[] = [];
		for (let i = 0; i < 8; i++) {
			spares.push(new Atom(i));
		}
		const wide = new Computed(() => spares.reduce((acc, at) => acc + at.state, 0));
		const disposeWide = effect(() => {
			wide.state;
		});
		disposeWide(); // frees 9 links (eff→wide + wide→spare×8)

		expect(() => s.set(1)).not.toThrow();

		// Post-schedule: fresh graph built entirely from recycled records.
		let sumEvals = 0;
		const driver = new Atom(1);
		const sum = new Computed(() => {
			sumEvals++;
			return driver.state + spares[0].state;
		});
		let observed = -1;
		const disposeSum = effect(() => {
			observed = sum.state;
		});
		expect(observed).toBe(1);
		driver.set(41);
		expect(observed).toBe(41);
		expect(sumEvals).toBe(2);
		disposeSum();
	});
});

describe('mass-teardown sweep restores ascending free-list order', () => {
	test('a qualifying batch reuses the lowest freed node ids first, and recycled records stay coherent', () => {
		// Build one anchor atom and a batch of effects reading it — big enough
		// to cross both MassTeardown bounds (batch > 4096 and >= 1/64 of the
		// arena's used extent). Created through the raw kernel ops so the ids
		// are visible, and disposed through E.disposeEffect directly (the
		// public disposer runs a boundary per call, which would sweep the
		// batch one record at a time — the raw op defers every free to one
		// sweep, the mass-teardown shape).
		const anchor = new Atom(0);
		const BATCH = 4200;
		const ids: number[] = [];
		for (let i = 0; i < BATCH; i++) {
			ids.push(E.newEffect(() => {
				anchor.state;
			}));
		}
		for (const id of ids) {
			E.disposeEffect(id);
		}
		expect(__reclaimStatsForTest().pendingFree).toBe(BATCH);

		// One boundary sweeps the whole batch. Effects were created (and so
		// disposed) in ascending id order, so a plain LIFO thread would hand
		// the HIGHEST freed id back first; the mass-teardown sort must hand
		// back the lowest ids, ascending.
		maybeBoundary();
		expect(__reclaimStatsForTest().pendingFree).toBe(0);
		const recNextAfterSweep = __reclaimStatsForTest().recNext;
		const a1 = new Atom(1);
		const a2 = new Atom(2);
		const a3 = new Atom(3);
		expect([a1._id, a2._id, a3._id]).toEqual([ids[0], ids[1], ids[2]]);

		// The rethreaded link free list must still be a coherent list: a fresh
		// cone built entirely from recycled records allocates nothing past the
		// bump pointer and behaves normally.
		let observed = -1;
		const disposeProbe = effect(() => {
			observed = a1.state + a2.state;
		});
		expect(observed).toBe(3);
		a1.set(10);
		expect(observed).toBe(12);
		expect(__reclaimStatsForTest().recNext).toBe(recNextAfterSweep);
		disposeProbe();
	});
});
