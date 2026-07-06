/**
 * Quiet-epoch clean-read fast path pins (dalien port study row 1, D8).
 *
 * The fast path serves a computed's cached value when its verification
 * stamp equals the global write epoch — skipping the flags ladder. These
 * tests pin the three correctness subtleties dalien's history documents
 * (each was a real bug class there) plus the cosignal-specific constraints:
 *
 *   1. ENTRY-captured stamping: a write from user code mid-verification
 *      bumps the epoch, so the stamp written at the read tail can only
 *      miss, never lie (stamping the CURRENT epoch would fast-serve a node
 *      the inner write just re-marked Pending — a permanent stale value).
 *   2. Stamp invalidation on Dirty-WITHOUT-a-write paths: unwatched marks
 *      an unwatching computed Dirty with no epoch bump anywhere; the stamp
 *      must be dropped or the alien-mandated recompute is skipped
 *      (pull-count exactness — conformance polices the same rule).
 *   3. The epoch bumps ONLY on OBSERVED writes: an unobserved write can
 *      stale no stamp (a stamped node has, or had until its stamp was
 *      cleared, dependency links), so unobserved write throughput keeps
 *      its exact shape. Pinned through the @internal __epochProbe seam —
 *      the rule is deliberately invisible to public behavior.
 *
 * Plus: HAS_BOX outcomes are never stamped (a stamp hit returns the raw
 * value slot — for a boxed outcome that would hand back the thrown error
 * object instead of throwing it); D2 CycleError still fires on re-entry
 * when stamps are hot; stamps survive an arena growth (closure rebuild
 * carries the buffer bytes; the epoch is module-level).
 */
import { describe, expect, test } from 'vitest';
import { __epochProbe, Atom, Computed, configure, CycleError, effect } from '../src/index';

describe('quiet-epoch fast path (D8)', () => {
	test('clean repeat reads are served without re-evaluation (the fast path exists)', () => {
		let evals = 0;
		const a = new Atom(1);
		const c = new Computed(() => {
			evals++;
			return a.state * 2;
		});
		expect(c.state).toBe(2);
		expect(c.state).toBe(2);
		expect(c.state).toBe(2);
		expect(evals).toBe(1);
		a.set(3); // observed (c subscribed a at its evaluation)
		expect(c.state).toBe(6);
		expect(evals).toBe(2);
	});

	test('subtlety 1: an inner write mid-getter forces the next read to re-verify (entry-captured stamp)', () => {
		// Self-feedback shape (tolerated writes-in-computeds): each
		// evaluation reads w, then writes w+1 — an OBSERVED write (w's
		// subscriber is this computed), so the epoch moves DURING the
		// evaluation and the node ends Pending again. A stamp written with
		// the post-write epoch would fast-serve the stale value forever;
		// the entry-captured stamp guarantees a miss and lazy convergence.
		let evals = 0;
		const w = new Atom(0);
		const c = new Computed(() => {
			evals++;
			const x = w.state;
			if (x < 3) {
				w.set(x + 1);
			}
			return x;
		});
		expect(c.state).toBe(0); // evaluated; wrote w=1; left Pending
		expect(c.state).toBe(1); // MUST re-verify (a stale fast-hit would return 0)
		expect(c.state).toBe(2);
		expect(c.state).toBe(3); // converged: no write this time
		expect(evals).toBe(4);
		expect(c.state).toBe(3); // clean: stamped, no re-evaluation
		expect(evals).toBe(4);
	});

	test('subtlety 2: dispose-without-write still forces the unwatched recompute (pull-count exactness)', () => {
		let evals = 0;
		const a = new Atom(1);
		const c = new Computed(() => {
			evals++;
			return a.state * 2;
		});
		const dispose = effect(() => {
			void c.state;
		});
		expect(evals).toBe(1);
		expect(c.state).toBe(2); // clean read under the watcher; stamps the node
		expect(evals).toBe(1);
		dispose(); // top-level dispose: NO write anywhere — no epoch bump
		// unwatched marked c Dirty (alien semantics: an unwatched computed
		// re-evaluates on its next read). The stamp must have been dropped.
		expect(c.state).toBe(2);
		expect(evals).toBe(2);
	});

	test('subtlety 3: the epoch moves only on observed writes (__epochProbe)', () => {
		const lone = new Atom(0);
		const a = new Atom(0);
		const c = new Computed(() => a.state + 1);
		const dispose = effect(() => {
			void c.state;
		});
		const e0 = __epochProbe();
		lone.set(1); // changed, but zero subscribers → stamp-neutral
		lone.set(2);
		expect(__epochProbe()).toBe(e0);
		a.set(5); // observed (a → c → effect) → must bump
		expect(__epochProbe()).toBeGreaterThan(e0);
		const e1 = __epochProbe();
		a.set(5); // equal write: dropped before propagation → no bump
		expect(__epochProbe()).toBe(e1);
		dispose();
	});

	test('subtlety 3 payoff: an unobserved write leaves other stamps consumable', () => {
		let evals = 0;
		const lone = new Atom(0);
		const a = new Atom(1);
		const c = new Computed(() => {
			evals++;
			return a.state;
		});
		expect(c.state).toBe(1);
		lone.set(7); // unrelated, unobserved
		expect(c.state).toBe(1); // still served clean
		expect(evals).toBe(1);
	});

	test('boxed outcomes are never stamped: a cached error re-THROWS on every read', () => {
		let evals = 0;
		const a = new Atom(1);
		const boom = new Error('boom');
		const c = new Computed(() => {
			evals++;
			if (a.state === 1) {
				throw boom;
			}
			return a.state;
		});
		expect(() => c.state).toThrow(boom);
		// The lethal wrong-stamp failure: a stamped boxed outcome would make
		// this second read RETURN the raw Error object as the value.
		expect(() => c.state).toThrow(boom);
		expect(() => c.state).toThrow(boom);
		a.set(2);
		expect(c.state).toBe(2);
		expect(evals).toBeGreaterThanOrEqual(2);
	});

	test('D2 with stamps hot: re-entrant read during a recompute still throws CycleError', () => {
		const s = new Atom(0);
		let seen: unknown = 'none';
		// eslint-disable-next-line prefer-const
		let self!: Computed<number>;
		const c = new Computed(() => {
			const v = s.state;
			if (v === 1) {
				try {
					void self.state; // re-entrant self-read mid-evaluation
					seen = 'stale-serve';
				} catch (e) {
					seen = e;
				}
			}
			return v;
		});
		self = c;
		expect(c.state).toBe(0); // clean eval; node stamped
		s.set(1); // observed → c re-evaluates on next read
		expect(c.state).toBe(1);
		expect(seen).toBeInstanceOf(CycleError); // never the stale cache
	});

	test('diamond flush keeps pull counts exact (tracked-read stamps are consumable, never lying)', () => {
		let lEvals = 0;
		let rEvals = 0;
		let jEvals = 0;
		let runs = 0;
		const a = new Atom(1);
		const left = new Computed(() => {
			lEvals++;
			return a.state + 1;
		});
		const right = new Computed(() => {
			rEvals++;
			return a.state * 10;
		});
		const join = new Computed(() => {
			jEvals++;
			return (left.state as number) + (right.state as number);
		});
		const dispose = effect(() => {
			runs++;
			void join.state;
		});
		expect([lEvals, rEvals, jEvals, runs]).toEqual([1, 1, 1, 1]);
		a.set(2);
		expect([lEvals, rEvals, jEvals, runs]).toEqual([2, 2, 2, 2]);
		// Post-flush reads: everything verified during the flush serves
		// clean — exactly one evaluation each, values exact.
		expect(join.state).toBe(23);
		expect(left.state).toBe(3);
		expect(right.state).toBe(20);
		expect([lEvals, rEvals, jEvals]).toEqual([2, 2, 2]);
		dispose();
	});

	test('stamps survive arena growth (closure rebuild carries the buffer; epoch is module-level)', () => {
		let evals = 0;
		const a = new Atom(4);
		const c = new Computed(() => {
			evals++;
			return a.state * 2;
		});
		expect(c.state).toBe(8); // stamped in the pre-growth arena
		configure({ initialRecords: (1 << 20) * 2 }); // above the default floor → grow + rebuild NOW
		expect(c.state).toBe(8); // carried stamp still hits — no spurious recompute
		expect(evals).toBe(1);
		a.set(5); // observed write through the rebuilt engine
		expect(c.state).toBe(10);
		expect(evals).toBe(2);
	});
});
