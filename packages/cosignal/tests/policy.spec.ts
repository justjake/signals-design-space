/**
 * Policy-layer contracts of the base library — the behavior layered above
 * the packed core, which itself compares only reference identity: custom
 * equality (an equality cutoff returns the old reference), error sentinel
 * boxes, the ctx.previous hint, ReducerAtom, updater/reducer purity, and
 * configure() input validation.
 */
import { describe, expect, test } from 'vitest';
import { Atom, Computed, ReducerAtom, configure, effect } from '../src/index';

describe('custom equality (policy wrapper, kernel compares identity only)', () => {
	test('atom isEqual drops equal writes entirely (empty-history equality drop)', () => {
		const a = new Atom({ n: 1 }, { isEqual: (x, y) => x.n === y.n });
		const first = a.state;
		let runs = 0;
		const dispose = effect(() => {
			a.state;
			runs++;
		});
		expect(runs).toBe(1);

		a.set({ n: 1 }); // equal by policy — dropped before the kernel sees it
		expect(runs).toBe(1);
		expect(a.state).toBe(first); // reference stable: the old object survives

		a.set({ n: 2 });
		expect(runs).toBe(2);
		expect(a.state.n).toBe(2);
		dispose();
	});

	test('computed isEqual returns the OLD reference and cuts off downstream', () => {
		const a = new Atom(1);
		let evals = 0;
		const c = new Computed(() => {
			evals++;
			return [a.state % 2];
		}, { isEqual: (x, y) => x[0] === y[0] });
		let runs = 0;
		let seen: number[] | undefined;
		const dispose = effect(() => {
			seen = c.state;
			runs++;
		});
		const first = seen;
		expect(evals).toBe(1);
		expect(runs).toBe(1);

		a.set(3); // 1 -> 3: recompute produces [1] again — equal by policy
		expect(evals).toBe(2); // the computed re-evaluated…
		expect(runs).toBe(1); // …but downstream saw no change (cutoff)
		expect(c.state).toBe(first); // and the old reference is preserved

		a.set(4); // [0] — genuinely different
		expect(runs).toBe(2);
		expect(seen).not.toBe(first);
		expect(seen![0]).toBe(0);
		dispose();
	});

	test('default equality is reference identity (kernel compare)', () => {
		const a = new Atom({ n: 1 });
		let runs = 0;
		const dispose = effect(() => {
			a.state;
			runs++;
		});
		a.set({ n: 1 }); // different reference — counts as a change
		expect(runs).toBe(2);
		dispose();
	});
});

describe('error sentinel boxes', () => {
	test('throwing fn caches one error; every read site rethrows it; recovery on next change', () => {
		const a = new Atom(0);
		let evals = 0;
		const boom = new Error('boom');
		const c = new Computed(() => {
			evals++;
			if (a.state === 0) {
				throw boom;
			}
			return a.state * 2;
		});

		expect(() => c.state).toThrow('boom');
		expect(evals).toBe(1);
		// Cached: a second read rethrows without re-evaluating (flags uncorrupted,
		// cache holds the reference-stable box).
		expect(() => c.state).toThrow('boom');
		expect(evals).toBe(1);

		// Errors chain through dependent computeds as the SAME error instance.
		const d = new Computed(() => c.state + 1);
		let caught: unknown;
		try {
			d.state;
		} catch (e) {
			caught = e;
		}
		expect(caught).toBe(boom);

		// Recovery: the graph is intact, a change re-evaluates normally.
		a.set(2);
		expect(c.state).toBe(4);
		expect(d.state).toBe(5);
		expect(evals).toBe(2);
	});

	test('identical rethrow keeps the old box: no downstream churn', () => {
		const a = new Atom(0);
		const boom = new Error('stable');
		const c = new Computed(() => {
			if (a.state < 10) {
				throw boom;
			}
			return a.state;
		});
		let downstreamEvals = 0;
		const d = new Computed(() => {
			downstreamEvals++;
			try {
				return c.state;
			} catch {
				return -1;
			}
		});
		expect(d.state).toBe(-1);
		expect(downstreamEvals).toBe(1);
		a.set(1); // c re-evaluates, throws the SAME error → same box → cutoff
		expect(d.state).toBe(-1);
		expect(downstreamEvals).toBe(1);
		a.set(10);
		expect(d.state).toBe(10);
		expect(downstreamEvals).toBe(2);
	});

	test('an effect observing a throwing computed surfaces the error to the writer', () => {
		const a = new Atom(1);
		const c = new Computed(() => {
			if (a.state === 0) {
				throw new Error('effect boom');
			}
			return a.state;
		});
		const log: number[] = [];
		const dispose = effect(() => {
			log.push(c.state);
		});
		expect(log).toEqual([1]);
		expect(() => a.set(0)).toThrow('effect boom');
		// Recovery: the effect is still subscribed.
		a.set(5);
		expect(log).toEqual([1, 5]);
		dispose();
	});
});

describe('ctx.previous (committed-value hint; DIRECT: the cached value)', () => {
	test('undefined on first eval, then the last committed value', () => {
		const a = new Atom(1);
		const seen: Array<number | undefined> = [];
		const c = new Computed<number>((ctx) => {
			seen.push(ctx.previous);
			return a.state * 2;
		});
		expect(c.state).toBe(2);
		a.set(3);
		expect(c.state).toBe(6);
		expect(seen).toEqual([undefined, 2]);
	});

	test('undefined while the cache holds a sentinel (no committed value)', () => {
		const a = new Atom(0);
		const seen: Array<number | undefined> = [];
		const c = new Computed<number>((ctx) => {
			seen.push(ctx.previous);
			if (a.state === 0) {
				throw new Error('nope');
			}
			return a.state;
		});
		expect(() => c.state).toThrow('nope');
		a.set(7);
		expect(c.state).toBe(7);
		expect(seen).toEqual([undefined, undefined]);
	});
});

describe('fold purity (throws in all builds)', () => {
	test('reads and writes inside update(fn) throw', () => {
		const a = new Atom(1);
		const b = new Atom(2);
		expect(() => a.update(() => b.state)).toThrow(/not allowed inside/);
		expect(() => a.update((v) => {
			b.set(9);
			return v;
		})).toThrow(/not allowed inside/);
		// The failed folds wrote nothing.
		expect(a.state).toBe(1);
		expect(b.state).toBe(2);
		// A pure updater works and sees the newest value.
		a.update((v) => v + 10);
		expect(a.state).toBe(11);
	});

	test('reads and writes inside a reducer throw; read before dispatch instead', () => {
		const other = new Atom(100);
		const r = new ReducerAtom((s: number, action: 'add' | 'peek') => {
			if (action === 'peek') {
				return s + other.state;
			}
			return s + 1;
		}, 0);
		r.dispatch('add');
		expect(r.state).toBe(1);
		expect(() => r.dispatch('peek')).toThrow(/not allowed inside/);
		expect(r.state).toBe(1);
	});
});

describe('ReducerAtom', () => {
	test('dispatch reduces over the newest value; reducer fixed at creation', () => {
		const r = new ReducerAtom((s: number, a: number) => s + a, 10);
		expect(r.reduce(1, 2)).toBe(3);
		r.dispatch(5);
		r.dispatch(7);
		expect(r.state).toBe(22);
		// It is also a plain Atom (set/update work).
		r.set(0);
		expect(r.state).toBe(0);
	});

	test('isEqual applies to dispatch results (equality drop)', () => {
		const r = new ReducerAtom(
			(s: { n: number }, a: number) => ({ n: s.n + a }),
			{ n: 1 },
			{ isEqual: (x, y) => x.n === y.n },
		);
		const first = r.state;
		let runs = 0;
		const dispose = effect(() => {
			r.state;
			runs++;
		});
		r.dispatch(0); // {n:1} — equal by policy → dropped
		expect(runs).toBe(1);
		expect(r.state).toBe(first);
		r.dispatch(2);
		expect(runs).toBe(2);
		expect(r.state.n).toBe(3);
		dispose();
	});
});

describe('configure', () => {
	test('initialRecords validates input and accepts a raise', () => {
		expect(() => configure({ initialRecords: 0 })).toThrow(/>= 2/);
		expect(() => configure({ initialRecords: Number.NaN })).toThrow(/>= 2/);
		// A floor below the current capacity is a no-op.
		configure({ initialRecords: 2 });
		const a = new Atom(1);
		expect(a.state).toBe(1);
	});

	test('forbidWritesInComputeds toggles and is honored', () => {
		const a = new Atom(1);
		const side = new Atom(0);
		configure({ forbidWritesInComputeds: true });
		try {
			const c = new Computed(() => {
				side.set(a.state);
				return a.state;
			});
			expect(() => c.state).toThrow(/forbidden/);
			expect(side.state).toBe(0);
		} finally {
			configure({ forbidWritesInComputeds: false });
		}
	});
});
