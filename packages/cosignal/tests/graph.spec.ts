/**
 * Graph disciplines of the base library: the observed lifecycle
 * (coalescing of rapid observe/unobserve flips of the engine's
 * has-subscribers state), writes during computed evaluation
 * (tolerated / cycle / forbidden), cycle rejection, the batch/untracked
 * contracts, and the core's dispose/reclamation paths.
 */
import { describe, expect, test } from 'vitest';
import {
	Atom,
	Computed,
	CycleError,
	batch,
	configure,
	effect,
	effectScope,
	untracked,
} from '../src/index';

const tick = (): Promise<void> => new Promise<void>((res) => queueMicrotask(res));

describe('observed lifecycle (AtomOptions.effect)', () => {
	test('mounts on first watcher, unmounts on last, in microtasks', async () => {
		let mounts = 0;
		let unmounts = 0;
		const a = new Atom(1, {
			effect: () => {
				mounts++;
				return () => {
					unmounts++;
				};
			},
		});
		expect(mounts).toBe(0);
		const dispose = effect(() => {
			a.state;
		});
		expect(mounts).toBe(0); // delivery is a microtask, never synchronous
		await tick();
		expect(mounts).toBe(1);
		expect(unmounts).toBe(0);
		dispose();
		expect(unmounts).toBe(0);
		await tick();
		expect(unmounts).toBe(1);
	});

	test('flap damping: observe+unobserve within one tick coalesces to nothing', async () => {
		let mounts = 0;
		let unmounts = 0;
		const a = new Atom(1, {
			effect: () => {
				mounts++;
				return () => {
					unmounts++;
				};
			},
		});
		const dispose = effect(() => {
			a.state;
		});
		dispose(); // same tick
		await tick();
		expect(mounts).toBe(0);
		expect(unmounts).toBe(0);

		// And the mirror flap while mounted: unobserve+reobserve nets out.
		const d1 = effect(() => {
			a.state;
		});
		await tick();
		expect(mounts).toBe(1);
		d1();
		const d2 = effect(() => {
			a.state;
		});
		await tick();
		expect(mounts).toBe(1);
		expect(unmounts).toBe(0);
		d2();
		await tick();
		expect(unmounts).toBe(1);
	});

	test('re-observation re-fires the effect', async () => {
		let mounts = 0;
		let unmounts = 0;
		const a = new Atom(1, {
			effect: () => {
				mounts++;
				return () => {
					unmounts++;
				};
			},
		});
		const d1 = effect(() => {
			a.state;
		});
		await tick();
		d1();
		await tick();
		const d2 = effect(() => {
			a.state;
		});
		await tick();
		expect(mounts).toBe(2);
		expect(unmounts).toBe(1);
		d2();
		await tick();
		expect(unmounts).toBe(2);
	});

	test('lifecycle ctx: state reads untracked; set/update write through policy', async () => {
		const a = new Atom(1, {
			effect: (ctx) => {
				// state is a plain (untracked) read of the current value.
				ctx.set(ctx.state + 10);
				ctx.update((v) => v * 2);
			},
		});
		const log: number[] = [];
		const dispose = effect(() => {
			log.push(a.state);
		});
		expect(log).toEqual([1]);
		await tick();
		expect(log).toEqual([1, 11, 22]);
		dispose();
	});

	test('unmounts when the observing chain goes cold through a computed', async () => {
		let mounts = 0;
		let unmounts = 0;
		const a = new Atom(1, {
			effect: () => {
				mounts++;
				return () => {
					unmounts++;
				};
			},
		});
		const c = new Computed(() => a.state + 1);
		const dispose = effect(() => {
			c.state;
		});
		await tick();
		expect(mounts).toBe(1);
		dispose(); // effect unsubscribes c; c goes cold and drops its deps
		await tick();
		expect(unmounts).toBe(1);
	});
});

describe('writes in computeds', () => {
	test('acyclic side-channel writes are tolerated and land', () => {
		const src = new Atom(1);
		const side = new Atom(0);
		const writer = new Computed(() => {
			const v = src.state;
			side.set(v * 10);
			return v;
		});
		const sideLog: number[] = [];
		const dispose = effect(() => {
			sideLog.push(side.state);
		});
		expect(sideLog).toEqual([0]);
		expect(writer.state).toBe(1);
		expect(side.state).toBe(10);
		expect(sideLog).toEqual([0, 10]); // the side effect notified observers
		src.set(2);
		expect(writer.state).toBe(2);
		expect(side.state).toBe(20);
		dispose();
	});

	test('write-then-read of the same atom converges (no false cycle)', () => {
		const a = new Atom(0);
		const c = new Computed(() => {
			a.set(5); // written BEFORE it is tracked this run
			return a.state;
		});
		expect(c.state).toBe(5);
	});

	test('self-feedback writes are tolerated alien-style: perpetually pending, exact per-read values (conformance #179 shape)', () => {
		const a = new Atom(1);
		const c = new Computed(() => {
			a.set(a.state + 1); // read-then-write feedback through a tracked dep
			return a.state;
		});
		// Each read re-evaluates (the write re-marks the computed pending) and
		// intra-run read-after-write values are exact.
		expect(c.state).toBe(2);
		expect(a.state).toBe(2);
		expect(c.state).toBe(3);
		expect(a.state).toBe(3);
	});

	test('forbidWritesInComputeds rejects every write during evaluation', () => {
		configure({ forbidWritesInComputeds: true });
		try {
			const a = new Atom(1);
			const side = new Atom(0);
			const c = new Computed(() => {
				side.set(a.state); // acyclic, but forbidden by configuration
				return a.state;
			});
			expect(() => c.state).toThrow(/forbidden/);
			expect(side.state).toBe(0); // nothing landed
		} finally {
			configure({ forbidWritesInComputeds: false });
		}
	});
});

describe('cycle rejection', () => {
	test('computed reading itself during evaluation throws CycleError', () => {
		// eslint-disable-next-line prefer-const
		let self: Computed<number> | undefined;
		const c = new Computed<number>(() => self!.state + 1);
		self = c;
		expect(() => c.state).toThrow(CycleError);
	});

	test('a caught cycle error recovers once the branch changes (conformance #153 shape)', () => {
		const a = new Atom(0);
		const c: Computed<number> = new Computed<number>(() => {
			if (a.state === 0) {
				try {
					return c.state;
				} catch {
					return -1;
				}
			}
			return a.state;
		});
		expect(c.state).toBe(-1);
		a.set(1);
		expect(c.state).toBe(1);
	});

	test('mutual computed recursion throws instead of overflowing', () => {
		// eslint-disable-next-line prefer-const
		let b: Computed<number> | undefined;
		const a = new Computed<number>(() => b!.state + 1);
		b = new Computed<number>(() => a.state + 1);
		expect(() => a.state).toThrow(CycleError);
	});
});

describe('batch and untracked contracts', () => {
	test('batch defers core-effect flushing to the close; values stay live inside', () => {
		const a = new Atom(1);
		const b = new Atom(10);
		const log: number[] = [];
		const dispose = effect(() => {
			log.push(a.state + b.state);
		});
		expect(log).toEqual([11]);
		const result = batch(() => {
			a.set(2);
			b.set(20);
			expect(a.state).toBe(2); // newest world is readable inside the batch
			expect(log).toEqual([11]); // …but effects have not flushed
			return 'done';
		});
		expect(result).toBe('done');
		expect(log).toEqual([11, 22]); // one flush at close
		dispose();
	});

	test('nested batches flush once at the outermost close', () => {
		const a = new Atom(0);
		let runs = 0;
		const dispose = effect(() => {
			a.state;
			runs++;
		});
		batch(() => {
			a.set(1);
			batch(() => {
				a.set(2);
			});
			expect(runs).toBe(1);
		});
		expect(runs).toBe(2);
		dispose();
	});

	test('batch flushes (and rethrows) even when fn throws', () => {
		const a = new Atom(0);
		let runs = 0;
		const dispose = effect(() => {
			a.state;
			runs++;
		});
		expect(() =>
			batch(() => {
				a.set(1);
				throw new Error('mid-batch');
			}),
		).toThrow('mid-batch');
		expect(runs).toBe(2); // the write still flushed at close
		dispose();
	});

	test('untracked reads register no dependency edges', () => {
		const tracked = new Atom(1);
		const ignored = new Atom(100);
		let runs = 0;
		let seen = 0;
		const dispose = effect(() => {
			runs++;
			seen = tracked.state + untracked(() => ignored.state);
		});
		expect(seen).toBe(101);
		ignored.set(200); // no edge — no re-run
		expect(runs).toBe(1);
		tracked.set(2);
		expect(runs).toBe(2);
		expect(seen).toBe(202); // temporal staleness resolved by the tracked re-run
		dispose();
	});

	test('untracked inside a computed skips the edge', () => {
		const a = new Atom(1);
		const b = new Atom(2);
		let evals = 0;
		const c = new Computed(() => {
			evals++;
			return a.state + untracked(() => b.state);
		});
		expect(c.state).toBe(3);
		b.set(5);
		expect(c.state).toBe(3); // cached: b is not a dependency
		expect(evals).toBe(1);
		a.set(2);
		expect(c.state).toBe(7); // recompute picks up the newest b
		expect(evals).toBe(2);
	});
});

describe('dispose and reclamation (donor paths)', () => {
	test('effect cleanup runs before each re-run and at dispose', () => {
		const a = new Atom(0);
		const log: string[] = [];
		const dispose = effect(() => {
			const v = a.state;
			log.push(`run ${v}`);
			return () => {
				log.push(`cleanup ${v}`);
			};
		});
		a.set(1);
		dispose();
		expect(log).toEqual(['run 0', 'cleanup 0', 'run 1', 'cleanup 1']);
		a.set(2); // disposed: no further runs
		expect(log.length).toBe(4);
	});

	test('double-dispose is safe; stale disposers are defused by the generation guard', () => {
		const a = new Atom(0);
		const b = new Atom(0);
		let aRuns = 0;
		let bRuns = 0;
		const disposeA = effect(() => {
			a.state;
			aRuns++;
		});
		disposeA(); // dispose → record pending free
		disposeA(); // second call: no-op
		// New nodes force a boundary sweep, letting the freed record be reused.
		const disposeB = effect(() => {
			b.state;
			bRuns++;
		});
		disposeA(); // stale disposer (generation bumped) must NOT kill the new effect
		b.set(1);
		expect(bRuns).toBe(2);
		expect(aRuns).toBe(1);
		disposeB();
		b.set(2);
		expect(bRuns).toBe(2);
	});

	test('effectScope disposes every effect created inside it', () => {
		const a = new Atom(0);
		let runs = 0;
		const disposeScope = effectScope(() => {
			effect(() => {
				a.state;
				runs++;
			});
			effect(() => {
				a.state;
				runs++;
			});
		});
		expect(runs).toBe(2);
		a.set(1);
		expect(runs).toBe(4);
		disposeScope();
		a.set(2);
		expect(runs).toBe(4);
	});

	test('an effect disposed by its own cleanup stays disposed', () => {
		const a = new Atom(0);
		let runs = 0;
		// eslint-disable-next-line prefer-const
		let dispose: (() => void) | undefined;
		dispose = effect(() => {
			a.state;
			runs++;
			return () => {
				dispose!();
			};
		});
		a.set(1); // cleanup fires and disposes the effect mid-flush
		expect(runs).toBeLessThanOrEqual(2);
		const after = runs;
		a.set(2);
		expect(runs).toBe(after);
	});
});
