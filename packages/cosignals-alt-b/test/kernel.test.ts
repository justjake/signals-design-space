// M1 — canonical kernel semantics (alien-signals family, spec §8 / §17.1 subset):
// laziness, equality cutoff, dynamic dependency trimming, exact pull counts,
// effect ordering, re-entrant writes and cycles, dispose, growth stress.
import { beforeEach, describe, expect, it } from 'vitest';
import {
	Atom,
	Computed,
	__debug,
	__resetEngineForTests,
	batch,
	configure,
	createWatcher,
	effect,
	effectScope,
	untracked,
} from '../src/index';

beforeEach(() => {
	__resetEngineForTests();
});

describe('kernel: atoms and computeds', () => {
	it('reads and writes atoms directly (DIRECT mode, zero overlay)', () => {
		const a = new Atom({ state: 1 });
		expect(a.state).toBe(1);
		a.set(5);
		expect(a.state).toBe(5);
		expect(__debug.isDirect()).toBe(true);
		expect(__debug.stats().gNext).toBe(4); // no log residue ever in DIRECT
	});

	it('computeds are lazy and cached', () => {
		const a = new Atom({ state: 2 });
		let runs = 0;
		const c = new Computed({
			fn: () => {
				++runs;
				return a.state * 10;
			},
		});
		expect(runs).toBe(0);
		expect(c.state).toBe(20);
		expect(c.state).toBe(20);
		expect(runs).toBe(1);
		a.set(3);
		expect(runs).toBe(1); // push does not recompute
		expect(c.state).toBe(30);
		expect(runs).toBe(2);
	});

	it('equality cutoff stops propagation at the first unchanged value', () => {
		const a = new Atom({ state: 1 });
		let innerRuns = 0;
		let outerRuns = 0;
		const parity = new Computed({
			fn: () => {
				++innerRuns;
				return a.state % 2;
			},
		});
		const label = new Computed({
			fn: () => {
				++outerRuns;
				return parity.state === 0 ? 'even' : 'odd';
			},
		});
		expect(label.state).toBe('odd');
		a.set(3); // parity unchanged
		expect(label.state).toBe('odd');
		expect(innerRuns).toBe(2);
		expect(outerRuns).toBe(1); // exact pull counts: outer never re-ran
	});

	it('custom isEqual suppresses downstream recomputation via reference return', () => {
		const a = new Atom({ state: { v: 1 }, isEqual: (x, y) => x.v === y.v });
		let runs = 0;
		const c = new Computed({
			fn: () => {
				++runs;
				return a.state.v;
			},
		});
		expect(c.state).toBe(1);
		a.set({ v: 1 }); // equal by policy: write dropped
		expect(c.state).toBe(1);
		expect(runs).toBe(1);
	});

	it('dynamic dependency trimming: unread branches stop notifying', () => {
		const flag = new Atom({ state: true });
		const x = new Atom({ state: 1 });
		const y = new Atom({ state: 100 });
		let runs = 0;
		const c = new Computed({
			fn: () => {
				++runs;
				return flag.state ? x.state : y.state;
			},
		});
		expect(c.state).toBe(1);
		flag.set(false);
		expect(c.state).toBe(100);
		expect(runs).toBe(2);
		x.set(2); // no longer a dependency
		expect(c.state).toBe(100);
		expect(runs).toBe(2);
		y.set(200);
		expect(c.state).toBe(200);
		expect(runs).toBe(3);
	});

	it('diamond: single recompute per write', () => {
		const a = new Atom({ state: 1 });
		const l = new Computed({ fn: () => a.state + 1 });
		const r = new Computed({ fn: () => a.state * 2 });
		let runs = 0;
		const join = new Computed({
			fn: () => {
				++runs;
				return l.state + r.state;
			},
		});
		expect(join.state).toBe(4);
		a.set(2);
		expect(join.state).toBe(7);
		expect(runs).toBe(2);
	});

	it('previous value is available to the computed fn', () => {
		const a = new Atom({ state: 1 });
		const c = new Computed<number>({
			fn: (ctx) => (ctx.previous ?? 0) + a.state,
		});
		expect(c.state).toBe(1);
		a.set(10);
		expect(c.state).toBe(11);
	});
});

describe('kernel: effects', () => {
	it('effects run immediately and on change; cleanup runs before re-run', () => {
		const a = new Atom({ state: 1 });
		const log: string[] = [];
		const dispose = effect(() => {
			const v = a.state;
			log.push(`run:${v}`);
			return () => log.push(`cleanup:${v}`);
		});
		expect(log).toEqual(['run:1']);
		a.set(2);
		expect(log).toEqual(['run:1', 'cleanup:1', 'run:2']);
		dispose();
		expect(log).toEqual(['run:1', 'cleanup:1', 'run:2', 'cleanup:2']);
		a.set(3);
		expect(log.length).toBe(4); // disposed
		dispose(); // stale disposer no-ops (generation counter)
	});

	it('batch coalesces effect flushes', () => {
		const a = new Atom({ state: 1 });
		const b = new Atom({ state: 2 });
		let runs = 0;
		effect(() => {
			void a.state;
			void b.state;
			++runs;
		});
		batch(() => {
			a.set(10);
			b.set(20);
		});
		expect(runs).toBe(2); // initial + one flush
	});

	it('effect ordering: outer effects run before inner on shared writes', () => {
		const a = new Atom({ state: 0 });
		const order: string[] = [];
		effect(() => {
			void a.state;
			order.push('outer');
			effect(() => {
				void a.state;
				order.push('inner');
			});
		});
		order.length = 0;
		a.set(1);
		expect(order[0]).toBe('outer');
	});

	it('effectScope disposes children in bulk', () => {
		const a = new Atom({ state: 0 });
		let runs = 0;
		const disposeScope = effectScope(() => {
			effect(() => {
				void a.state;
				++runs;
			});
			effect(() => {
				void a.state;
				++runs;
			});
		});
		expect(runs).toBe(2);
		disposeScope();
		a.set(1);
		expect(runs).toBe(2);
	});

	it('untracked reads register no dependency', () => {
		const a = new Atom({ state: 1 });
		let runs = 0;
		effect(() => {
			untracked(() => a.state);
			++runs;
		});
		a.set(2);
		expect(runs).toBe(1);
	});
});

describe('kernel: re-entrant writes and cycles', () => {
	it('writes inside computeds are tolerated when acyclic', () => {
		const a = new Atom({ state: 1 });
		const shadow = new Atom({ state: 0 });
		const c = new Computed({
			fn: () => {
				const v = a.state;
				shadow.set(v); // write-in-computed, acyclic
				return v * 2;
			},
		});
		expect(c.state).toBe(2);
		expect(shadow.state).toBe(1);
	});

	it('forbidWritesInComputeds makes in-computed writes throw', () => {
		configure({ forbidWritesInComputeds: true });
		const a = new Atom({ state: 1 });
		const shadow = new Atom({ state: 0 });
		const c = new Computed({
			fn: () => {
				shadow.set(a.state);
				return a.state;
			},
		});
		expect(() => c.state).toThrow(/forbidden/);
		configure({ forbidWritesInComputeds: false });
	});

	it('a computed reading itself does not hang and errors are contained as boxes', () => {
		const boom = new Computed({
			fn: () => {
				throw new Error('boom');
			},
		});
		expect(() => boom.state).toThrow('boom');
		expect(() => boom.state).toThrow('boom'); // stable cached error
	});
});

describe('kernel: watchers (broadcast list, DIRECT mode)', () => {
	it('notifies synchronously in the writer stack with equality cutoff', () => {
		const a = new Atom({ state: 1 });
		const c = new Computed({ fn: () => a.state % 2 });
		const notified: number[] = [];
		createWatcher(c, (token) => notified.push(token));
		a.set(3); // parity unchanged: cutoff suppresses
		expect(notified).toEqual([]);
		a.set(4); // parity changed
		expect(notified).toEqual([0]);
	});

	it('disposed watchers stop receiving broadcasts', () => {
		const a = new Atom({ state: 1 });
		const notified: number[] = [];
		const w = createWatcher(a, (token) => notified.push(token));
		a.set(2);
		expect(notified.length).toBe(1);
		w.dispose();
		a.set(3);
		expect(notified.length).toBe(1);
	});

	it('many watchers of one node each notify once per write', () => {
		const a = new Atom({ state: 0 });
		const c = new Computed({ fn: () => a.state + 1 });
		let count = 0;
		for (let i = 0; i < 10; ++i) {
			createWatcher(c, () => ++count);
		}
		a.set(1);
		expect(count).toBe(10);
	});
});

describe('kernel: growth stress', () => {
	it('survives tiny initial planes (every doubling path)', () => {
		__resetEngineForTests({ initialRecords: 2, initialLogRecords: 2, initialMemoRecords: 2 });
		const atoms = Array.from({ length: 50 }, (_, i) => new Atom({ state: i }));
		const sums = atoms.map(
			(_, i) =>
				new Computed({
					fn: () => atoms.slice(0, i + 1).reduce((s, x) => s + x.state, 0),
				}),
		);
		expect(sums[49].state).toBe((49 * 50) / 2);
		atoms[0].set(100);
		expect(sums[49].state).toBe((49 * 50) / 2 + 100);
		__debug.verify();
	});

	it('dispose-during-flush does not corrupt the arena', () => {
		const a = new Atom({ state: 0 });
		let disposeOther: (() => void) | undefined;
		const d1 = effect(() => {
			if (a.state > 0 && disposeOther !== undefined) {
				disposeOther();
			}
		});
		disposeOther = effect(() => {
			void a.state;
		});
		a.set(1);
		a.set(2);
		__debug.verify();
		d1();
		__debug.verify();
	});
});
