import { describe, expect, test, vi } from 'vitest';
import {
	Snapshot,
	atom,
	batch,
	commitBatch,
	committed,
	computed,
	discardBatch,
	effect,
	isPending,
	latest,
	openBatch,
	refresh,
	serializeAtomState,
	initializeAtomState,
	update,
	withAmbientBatch,
	withSnapshot,
	write,
} from '../src/index.ts';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('classified writes and rebase', () => {
	test('urgent write is canonically visible immediately', () => {
		const a = atom(1);
		write(a, 2);
		expect(a.peek()).toBe(2);
	});

	test('transition write stays invisible to canonical readers until commit', () => {
		const a = atom(1);
		const b = openBatch();
		withAmbientBatch(b, () => write(a, 5));
		expect(a.peek()).toBe(1);
		commitBatch(b);
		expect(a.peek()).toBe(5);
	});

	test('functional updates replay: (1 +1 urgent) x2 transition = 4', () => {
		const a = atom(1);
		const b = openBatch();
		withAmbientBatch(b, () => update(a, (x) => x * 2));
		// Urgent write lands alone, immediately.
		update(a, (x) => x + 1);
		expect(a.peek()).toBe(2);
		// The transition retires rebased on the urgent base.
		commitBatch(b);
		expect(a.peek()).toBe(4);
	});

	test('discarded batch never lands', () => {
		const a = atom(1);
		const b = openBatch();
		withAmbientBatch(b, () => write(a, 9));
		discardBatch(b);
		expect(a.peek()).toBe(1);
		// Committing after discard is inert.
		commitBatch(b);
		expect(a.peek()).toBe(1);
	});

	test('effects observe canonical state only, never drafts', () => {
		const a = atom(0);
		const log: number[] = [];
		effect(() => log.push(a.get()));
		const b = openBatch();
		withAmbientBatch(b, () => write(a, 7));
		expect(log).toEqual([0]);
		commitBatch(b);
		expect(log).toEqual([0, 7]);
	});
});

describe('snapshots', () => {
	test('a snapshot folds open batches over the pinned base', () => {
		const a = atom(1);
		const b = openBatch();
		withAmbientBatch(b, () => update(a, (x) => x * 10));
		const snap = new Snapshot([b], true);
		expect(withSnapshot(snap, () => a.get())).toBe(10);
		expect(a.peek()).toBe(1);
	});

	test('a pinned snapshot is isolated from later urgent writes', () => {
		const a = atom(1);
		const snap = new Snapshot([], false);
		snap.pin();
		a.set(50);
		expect(withSnapshot(snap, () => a.get())).toBe(1);
		snap.release();
		expect(a.peek()).toBe(50);
	});

	test('computeds evaluate inside the snapshot world, memoized per snapshot', () => {
		const a = atom(2);
		let calls = 0;
		const c = computed(() => {
			calls++;
			return a.get() * 100;
		});
		expect(c.get()).toBe(200);
		const b = openBatch();
		withAmbientBatch(b, () => write(a, 3));
		const snap = new Snapshot([b], true);
		calls = 0;
		expect(withSnapshot(snap, () => c.get())).toBe(300);
		expect(withSnapshot(snap, () => c.get())).toBe(300);
		expect(calls).toBe(1);
		// Canonical cache untouched by the draft evaluation.
		expect(c.get()).toBe(200);
		discardBatch(b);
	});

	test('distinct worlds may see distinct dependency sets', () => {
		const cond = atom(false);
		const left = atom('L');
		const right = atom('R');
		const pick = computed(() => (cond.get() ? left.get() : right.get()));
		expect(pick.get()).toBe('R');
		const b = openBatch();
		withAmbientBatch(b, () => write(cond, true));
		const snap = new Snapshot([b], true);
		expect(withSnapshot(snap, () => pick.get())).toBe('L');
		expect(pick.get()).toBe('R');
		discardBatch(b);
	});
});

describe('read family', () => {
	test('latest sees open drafts; canonical does not', () => {
		const a = atom(1);
		const c = computed(() => a.get() + 1);
		expect(c.get()).toBe(2);
		const b = openBatch();
		withAmbientBatch(b, () => write(a, 10));
		expect(latest(a)).toBe(10);
		expect(latest(c)).toBe(11);
		expect(a.peek()).toBe(1);
		expect(c.get()).toBe(2);
		discardBatch(b);
	});

	test('latest inside a snapshot resolves that snapshot world, not newer drafts', () => {
		const a = atom(1);
		const b1 = openBatch();
		withAmbientBatch(b1, () => write(a, 2));
		const snap = new Snapshot([], false); // a world without b1
		expect(withSnapshot(snap, () => latest(a))).toBe(1);
		expect(latest(a)).toBe(2);
		discardBatch(b1);
	});

	test('isPending flips while a batch touches an atom or its ancestors', () => {
		const a = atom(1);
		const c = computed(() => a.get() * 2);
		expect(c.get()).toBe(2);
		expect(isPending(a)).toBe(false);
		expect(isPending(c)).toBe(false);
		const b = openBatch();
		withAmbientBatch(b, () => write(a, 5));
		expect(isPending(a)).toBe(true);
		expect(isPending(c)).toBe(true);
		commitBatch(b);
		expect(isPending(a)).toBe(false);
		expect(isPending(c)).toBe(false);
	});

	test('committed without container reads canonical committed state', () => {
		const a = atom(1);
		const b = openBatch();
		withAmbientBatch(b, () => write(a, 5));
		expect(committed(a)).toBe(1);
		commitBatch(b);
		expect(committed(a)).toBe(5);
	});
});

describe('async computeds', () => {
	test('pending is graph state; settlement propagates like a write', async () => {
		let resolve!: (v: string) => void;
		const promise = new Promise<string>((r) => (resolve = r));
		const src = atom(promise);
		const c = computed((use) => use(src.get()));
		const d = computed(() => `got:${c.get()}`);
		// Never-settled: reads suspend by throwing the stable park promise.
		let thrown1: unknown;
		let thrown2: unknown;
		try {
			c.get();
		} catch (e) {
			thrown1 = e;
		}
		try {
			c.get();
		} catch (e) {
			thrown2 = e;
		}
		expect(thrown1).toBeDefined();
		expect(thrown1).toBe(thrown2); // stable identity across retries
		expect(isPending(c)).toBe(true);
		resolve('hi');
		await tick();
		expect(c.get()).toBe('hi');
		expect(d.get()).toBe('got:hi');
		expect(isPending(c)).toBe(false);
	});

	test('downstream evaluations forward pending', () => {
		const never = new Promise<string>(() => {});
		const src = atom(never);
		const c = computed((use) => use(src.get()));
		const d = computed(() => c.get());
		expect(() => d.get()).toThrow();
		expect(isPending(d)).toBe(true);
	});

	test('errors become reference-stable and rethrow at read sites', () => {
		const a = atom(1);
		const c = computed(() => {
			a.get();
			throw new Error('boom');
		});
		let e1: unknown;
		let e2: unknown;
		try {
			c.get();
		} catch (e) {
			e1 = e;
		}
		try {
			c.get();
		} catch (e) {
			e2 = e;
		}
		expect(e1).toBe(e2);
		expect((e1 as Error).message).toBe('boom');
	});

	test('refresh refetches with unchanged inputs; stale serves meanwhile', async () => {
		// The fetch is cached per generation, the way real data layers cache by
		// input: re-evaluations reuse the in-flight thenable.
		let fetches = 0;
		let release!: () => void;
		let inflight: Promise<string> | null = null;
		const c = computed((use) => {
			if (fetches === 0) {
				fetches++;
				return 'first';
			}
			if (inflight === null) {
				fetches++;
				inflight = new Promise<string>((r) => {
					release = () => r('second');
				});
			}
			return use(inflight);
		});
		expect(c.get()).toBe('first');
		refresh(c);
		expect(fetches).toBe(2);
		expect(isPending(c)).toBe(true);
		expect(c.get()).toBe('first'); // stale keeps serving, no fallback flash
		release();
		await tick();
		expect(c.get()).toBe('second');
		expect(isPending(c)).toBe(false);
	});
});

describe('lifetime effects', () => {
	test('observation opens on first subscriber, closes on last; flaps coalesce', async () => {
		let opens = 0;
		let closes = 0;
		const a = atom(0, {
			onObserved: () => {
				opens++;
				return () => closes++;
			},
		});
		const dispose1 = effect(() => a.get());
		const dispose2 = effect(() => a.get());
		await tick();
		expect(opens).toBe(1);
		dispose1();
		dispose2();
		await tick();
		expect(closes).toBe(1);
		// Flap within one tick: unobserve+observe coalesces to nothing.
		const dispose3 = effect(() => a.get());
		await tick();
		expect(opens).toBe(2);
		dispose3();
		const dispose4 = effect(() => a.get());
		await tick();
		expect(opens).toBe(2);
		expect(closes).toBe(1);
		dispose4();
		await tick();
		expect(closes).toBe(2);
	});
});

describe('lazy initializers', () => {
	test('initializer runs once, at first read', () => {
		const init = vi.fn(() => 42);
		const a = atom(init);
		expect(init).not.toHaveBeenCalled();
		expect(a.get()).toBe(42);
		expect(a.get()).toBe(42);
		expect(init).toHaveBeenCalledTimes(1);
	});

	test('set before first read still runs the initializer (equality base)', () => {
		const init = vi.fn(() => 5);
		const a = atom(init, { equals: (x, y) => x === y });
		a.set(5);
		expect(init).toHaveBeenCalledTimes(1);
		expect(a.version).toBe(1); // equal write dropped against the base
	});

	test('initializer is forbidden from writing', () => {
		const other = atom(0);
		const a = atom(() => {
			other.set(1);
			return 0;
		});
		expect(() => a.get()).toThrow(/initializer/);
	});

	test('SSR install does not run the initializer', () => {
		const init = vi.fn(() => 1);
		const a = atom(init);
		initializeAtomState('{"a": 99}', { a });
		expect(init).not.toHaveBeenCalled();
		expect(a.get()).toBe(99);
	});
});

describe('SSR', () => {
	test('serialize then initialize round-trips app-keyed state', () => {
		const a = atom(1);
		const b = atom('x');
		a.set(3);
		const json = serializeAtomState({ a, b });
		const a2 = atom(0);
		const b2 = atom('');
		initializeAtomState(json, { a: a2, b: b2 });
		expect(a2.get()).toBe(3);
		expect(b2.get()).toBe('x');
	});

	test('unmaterialized lazy atoms are omitted from serialization', () => {
		const a = atom(() => 1);
		expect(serializeAtomState({ a })).toBe('{}');
	});

	test('install is not a write: no notifications', () => {
		const a = atom(1);
		const log: number[] = [];
		effect(() => log.push(a.get()));
		initializeAtomState('{"a": 2}', { a });
		expect(log).toEqual([1]);
	});
});

describe('batch coalescing', () => {
	test('one flush per scope', () => {
		const a = atom(0);
		const b = atom(0);
		let runs = 0;
		effect(() => {
			a.get();
			b.get();
			runs++;
		});
		runs = 0;
		batch(() => {
			a.set(1);
			b.set(1);
		});
		expect(runs).toBe(1);
	});
});
