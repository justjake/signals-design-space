/**
 * Engine-level concurrent semantics: draft batches, updater replay, worlds as
 * visibility predicates, the read family, async pending, refresh.
 */
import { afterEach, describe, expect, test } from 'vitest';
import {
	__resetEngine,
	atom,
	batch,
	committed,
	computed,
	createBatch,
	effect,
	isPending,
	latest,
	makeWorld,
	PendingValue,
	read,
	readInWorld,
	refresh,
	setCommittedCutoffProvider,
	currentSeq,
} from '../src/index';

afterEach(() => {
	__resetEngine();
});

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('draft batches', () => {
	test('drafts are invisible to canonical readers and effects until retirement', () => {
		const a = atom(0);
		const seen: number[] = [];
		const dispose = effect(() => seen.push(a.get()));
		const b = createBatch();
		b.run(() => a.set(1));
		expect(a.get()).toBe(0);
		expect(latest(a)).toBe(1);
		expect(isPending(a)).toBe(true);
		expect(seen).toEqual([0]);
		b.retire();
		expect(a.get()).toBe(1);
		expect(isPending(a)).toBe(false);
		expect(seen).toEqual([0, 1]);
		dispose();
	});

	test('updater replay: urgent double under a pending +1 lands (1+1)*2 = 4', () => {
		const a = atom(1);
		const b = createBatch();
		b.run(() => a.update((x) => x + 1));
		a.update((x) => x * 2);
		expect(a.get()).toBe(2); // urgent alone
		expect(latest(a)).toBe(4); // newest intent replays the whole log
		b.retire();
		expect(a.get()).toBe(4);
	});

	test('branch state: +2 draft under urgent *2 gives 2 now, 6 after retirement', () => {
		const a = atom(1);
		const b = createBatch();
		b.run(() => a.update((x) => x + 2));
		a.update((x) => x * 2);
		expect(a.get()).toBe(2);
		b.retire();
		expect(a.get()).toBe(6);
	});

	test('discard drops intent; canonical untouched', () => {
		const a = atom(1);
		const b = createBatch();
		b.run(() => a.set(9));
		expect(latest(a)).toBe(9);
		b.discard();
		expect(latest(a)).toBe(1);
		expect(a.get()).toBe(1);
		expect(isPending(a)).toBe(false);
	});

	test('two batches retire independently, in retirement order', () => {
		const a = atom(0);
		const b1 = createBatch();
		const b2 = createBatch();
		b1.run(() => a.update((x) => x + 1));
		b2.run(() => a.update((x) => x * 10));
		b2.retire();
		expect(a.get()).toBe(0); // (0)*10
		b1.retire();
		expect(a.get()).toBe(10); // full replay in seq order: (0+1)*10
	});
});

describe('worlds', () => {
	test('a world sees canonical-at-cutoff plus its batches; siblings agree', () => {
		const a = atom(0);
		const b = createBatch();
		b.run(() => a.set(5));
		const w = makeWorld([b.id]);
		expect(readInWorld(a, w)).toBe(5);
		a.set(100); // urgent after the cutoff: invisible to the latched world
		expect(readInWorld(a, w)).toBe(5);
		expect(a.get()).toBe(100);
		w.release();
		b.discard();
	});

	test('computeds evaluate per world with world-specific dependencies', () => {
		const flag = atom(false);
		const x = atom(1);
		const y = atom(2);
		const c = computed(() => (flag.get() ? x.get() : y.get()));
		expect(c.get()).toBe(2);
		const b = createBatch();
		b.run(() => flag.set(true));
		const w = makeWorld([b.id]);
		expect(readInWorld(c, w)).toBe(1); // world took the x-branch
		expect(c.get()).toBe(2); // canonical still on y
		w.release();
		b.retire();
		expect(c.get()).toBe(1);
	});

	test('a world latched before a fold still folds the batch (folded-seq guard)', () => {
		const a = atom(1);
		const b = createBatch();
		b.run(() => a.update((n) => n + 1));
		const w = makeWorld([b.id]); // latched pre-retirement
		b.retire(); // canonical becomes 2 at a later seq
		expect(readInWorld(a, w)).toBe(2); // applies the (now folded) draft once, not twice
		w.release();
	});

	test('committed views are pure cutoffs', () => {
		const a = atom(0);
		const w0 = makeWorld([]); // keeps the episode (and history) alive
		const cut = currentSeq();
		a.set(1);
		setCommittedCutoffProvider((container) => (container === 'old' ? cut : currentSeq()));
		expect(committed(a, 'old')).toBe(0);
		expect(committed(a)).toBe(1);
		w0.release();
	});
});

describe('async: pending as graph state', () => {
	test('pending evaluation throws a stable box; settlement re-runs subscribed effects', async () => {
		const d = deferred<number>();
		const c = computed((use) => use(d.promise) * 2);
		const log: Array<number | 'pending'> = [];
		const dispose = effect(() => {
			try {
				log.push(c.get());
			} catch (e) {
				if (e instanceof PendingValue) log.push('pending');
				else throw e;
			}
		});
		expect(log).toEqual(['pending']);
		let box1: unknown;
		try {
			read(c);
		} catch (e) {
			box1 = e;
		}
		let box2: unknown;
		try {
			read(c);
		} catch (e) {
			box2 = e;
		}
		expect(box1).toBeInstanceOf(PendingValue);
		expect(box2).toBe(box1); // reference-stable across reads
		d.resolve(21);
		await d.promise;
		await tick();
		expect(log).toEqual(['pending', 42]);
		dispose();
	});

	test('rejection becomes a stable error rethrown at read sites', async () => {
		const d = deferred<number>();
		const boom = new Error('boom');
		const c = computed((use) => use(d.promise));
		expect(() => c.get()).toThrow(PendingValue);
		d.reject(boom);
		await d.promise.catch(() => {});
		await tick();
		expect(() => c.get()).toThrow(boom);
		expect(() => c.get()).toThrow(boom);
	});

	test('downstream evaluations forward pending; latest serves last settled', async () => {
		const d = deferred<string>();
		const src = computed((use) => use(d.promise));
		const down = computed(() => `[${src.get()}]`);
		expect(() => down.get()).toThrow(PendingValue);
		d.resolve('ok');
		await d.promise;
		await tick();
		expect(down.get()).toBe('[ok]');
	});

	test('refresh: stale keeps serving via latest; isPending flips; keyed use refetches', async () => {
		let fetches = 0;
		const gates: Array<ReturnType<typeof deferred<string>>> = [];
		const c = computed((use) =>
			use('req', () => {
				fetches++;
				const g = deferred<string>();
				gates.push(g);
				return g.promise;
			}),
		);
		expect(() => c.get()).toThrow(PendingValue);
		expect(fetches).toBe(1);
		gates[0].resolve('one');
		await gates[0].promise;
		await tick();
		expect(c.get()).toBe('one');
		refresh(c);
		expect(fetches).toBe(2);
		expect(isPending(c)).toBe(true);
		expect(latest(c)).toBe('one'); // stale serves, no gap
		gates[1].resolve('two');
		await gates[1].promise;
		await tick();
		expect(c.get()).toBe('two');
		expect(isPending(c)).toBe(false);
	});

	test('refresh inside a batch belongs to it: canonical never goes pending', async () => {
		let fetches = 0;
		const gates: Array<ReturnType<typeof deferred<string>>> = [];
		const c = computed((use) =>
			use('req', () => {
				fetches++;
				const g = deferred<string>();
				gates.push(g);
				return g.promise;
			}),
		);
		expect(() => c.get()).toThrow(PendingValue);
		gates[0].resolve('one');
		await gates[0].promise;
		await tick();
		expect(c.get()).toBe('one');
		const b = createBatch();
		b.run(() => refresh(c));
		expect(c.get()).toBe('one'); // canonical unaffected by the transition's refetch
		expect(isPending(c)).toBe(true);
		const w = makeWorld([b.id]);
		expect(() => readInWorld(c, w)).toThrow(PendingValue); // the batch's world refetches
		expect(fetches).toBe(2);
		gates[1].resolve('two');
		await gates[1].promise;
		await tick();
		expect(() => readInWorld(c, w)).not.toThrow();
		expect(readInWorld(c, w)).toBe('two');
		expect(c.get()).toBe('one'); // still stale canonically until retirement
		w.release();
		b.retire();
		expect(c.get()).toBe('two');
		dispose: void 0;
	});
});

describe('lazy initializers', () => {
	test('runs once at first read; set-before-read runs it first', () => {
		let runs = 0;
		const a = atom(() => {
			runs++;
			return 1;
		});
		expect(runs).toBe(0);
		a.set(5);
		expect(runs).toBe(1);
		expect(a.get()).toBe(5);
		expect(runs).toBe(1);
	});

	test('initializer is untracked and forbidden from writing', () => {
		const other = atom(0);
		const a = atom(() => {
			other.set(9);
			return 1;
		});
		expect(() => a.get()).toThrow(/initializer/);
	});

	test('equal set-before-read drops against the initialized base', () => {
		let runs = 0;
		const a = atom(() => {
			runs++;
			return 5;
		});
		const seen: number[] = [];
		const dispose = effect(() => seen.push(a.get()));
		expect(seen).toEqual([5]);
		a.set(5);
		expect(seen).toEqual([5]);
		expect(runs).toBe(1);
		dispose();
	});
});

describe('batch() coalescing is orthogonal to deferred batches', () => {
	test('batch() coalesces effect runs for urgent writes', () => {
		const a = atom(0);
		const b = atom(0);
		const seen: string[] = [];
		const dispose = effect(() => seen.push(`${a.get()},${b.get()}`));
		batch(() => {
			a.set(1);
			b.set(2);
		});
		expect(seen).toEqual(['0,0', '1,2']);
		dispose();
	});
});

describe('latest() context rule: an evaluation resolves its own world', () => {
	// Judgement-round regression: latest() inside a CANONICAL computed
	// evaluation must resolve the canonical world (drafts hidden) and must
	// register the dependency like any other tracked read.

	test('canonical computed first-evaluated while a draft is live caches the canonical value, not the draft', () => {
		const a = atom(1);
		const c = computed(() => latest(a) * 10);
		const b = createBatch();
		b.run(() => a.set(2));
		expect(read(a)).toBe(1);
		expect(read(c)).toBe(10); // NOT 20: the draft is invisible to canon
		b.discard();
		expect(read(c)).toBe(10);
	});

	test('latest inside a canonical computed is tracked: urgent writes invalidate and watching effects re-fire', () => {
		const a = atom(1);
		const c = computed(() => latest(a));
		const seen: number[] = [];
		const dispose = effect(() => {
			seen.push(c.get());
		});
		expect(seen).toEqual([1]);
		a.set(2); // urgent write, full quiescence — no batches anywhere
		expect(read(c)).toBe(2); // not permanently stale
		expect(seen).toEqual([1, 2]); // the effect re-fired
		dispose();
	});

	test('latest inside a world-scoped evaluation still resolves that world', () => {
		const a = atom(1);
		const c = computed(() => latest(a) + 100);
		const b = createBatch();
		b.run(() => a.set(2));
		const w = makeWorld([b.id]);
		expect(readInWorld(c, w)).toBe(102); // the world lists the batch
		expect(read(c)).toBe(101); // canon still hides it
		w.release();
		b.discard();
	});
});

describe('fuzz pins', () => {
	test('seed 207: discarding a batch invalidates world caches that listed it', () => {
		const a = atom(1);
		const c = computed(() => a.get() * 2);
		const b = createBatch();
		const w = makeWorld([b.id]);
		expect(readInWorld(c, w)).toBe(2);
		b.run(() => a.set(11));
		expect(readInWorld(c, w)).toBe(22);
		b.discard();
		expect(readInWorld(c, w)).toBe(2); // the cached 22 must not survive the discard
		w.release();
	});
});
