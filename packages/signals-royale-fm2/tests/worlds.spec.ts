/** Concurrent model semantics: worlds, drafts, retirement, read family. */
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
	atom,
	computed,
	effect,
	batch,
	createBatch,
	retireBatch,
	abortBatch,
	runInWriteBatch,
	withWorld,
	subscribeNode,
	latest,
	committed,
	isPending,
	refresh,
	createCommittedView,
	installState,
	serializeAtomState,
	initializeAtomState,
	flushLifetimeEffects,
	resetForTest,
	openBatchCount,
} from '../src/index';

afterEach(() => resetForTest());

describe('worlds and drafts', () => {
	test('transition draft is invisible canonically, visible in its world', () => {
		const a = atom(1);
		const b = createBatch(true);
		runInWriteBatch(b, () => a.set(5));
		expect(a.get()).toBe(1);
		expect(withWorld([b], () => a.get())).toBe(5);
		expect(latest(a)).toBe(5);
		retireBatch(b);
		expect(a.get()).toBe(5);
		expect(openBatchCount()).toBe(0);
	});

	test('functional updates replay in dispatch order (rebase arithmetic)', () => {
		const a = atom(1);
		const t = createBatch(true);
		runInWriteBatch(t, () => a.update((x) => x + 1));
		// Urgent write lands alone and immediately: the +1 draft is skipped.
		a.update((x) => x * 2);
		expect(a.get()).toBe(2);
		// The transition world folds the whole queue in dispatch order.
		expect(withWorld([t], () => a.get())).toBe(4); // (1+1)*2
		retireBatch(t);
		expect(a.get()).toBe(4); // not 3: urgent x2 replays after the draft +1
	});

	test('aborting a batch drops drafts and re-notifies draft watchers', () => {
		const a = atom(1);
		const b = createBatch(true);
		const seen: Array<number | null> = [];
		const unsub = subscribeNode(a, (batchArg) => seen.push(batchArg ? batchArg.id : null));
		runInWriteBatch(b, () => a.set(9));
		expect(seen).toEqual([b.id]);
		abortBatch(b);
		expect(seen).toEqual([b.id, b.id]);
		expect(a.get()).toBe(1);
		unsub();
	});

	test('computeds resolve per-world values with per-world dependency sets', () => {
		const cond = atom(true);
		const x = atom('x');
		const y = atom('y');
		const c = computed(() => (cond.get() ? x.get() : y.get()));
		expect(c.get()).toBe('x');
		const b = createBatch(true);
		runInWriteBatch(b, () => cond.set(false));
		expect(withWorld([b], () => c.get())).toBe('y');
		expect(c.get()).toBe('x'); // canonical untouched
		retireBatch(b);
		expect(c.get()).toBe('y');
	});

	test('effects observe canonical state only', () => {
		const a = atom(0);
		const log: number[] = [];
		const dispose = effect(() => {
			log.push(a.get());
		});
		const b = createBatch(true);
		runInWriteBatch(b, () => a.set(7));
		expect(log).toEqual([0]);
		retireBatch(b);
		expect(log).toEqual([0, 7]);
		dispose();
	});

	test('batch coalesces effect runs', () => {
		const a = atom(0);
		const bAtom = atom(0);
		let runs = 0;
		const dispose = effect(() => {
			a.get();
			bAtom.get();
			runs++;
		});
		batch(() => {
			a.set(1);
			bAtom.set(1);
		});
		expect(runs).toBe(2); // initial + one coalesced flush
		dispose();
	});
});

describe('read family', () => {
	test('latest inside a world resolves that world, not newer batches', () => {
		const a = atom(0);
		const b1 = createBatch(true);
		const b2 = createBatch(true);
		runInWriteBatch(b1, () => a.set(1));
		runInWriteBatch(b2, () => a.set(2));
		expect(withWorld([b1], () => latest(a))).toBe(1);
		expect(latest(a)).toBe(2); // outside: folds all open batches
	});

	test('committed view lags urgent writes until the root commits', () => {
		const a = atom(1);
		const view = createCommittedView();
		a.set(2);
		expect(a.get()).toBe(2);
		expect(committed(a, view)).toBe(1); // screen still shows 1
		view.commit();
		expect(committed(a, view)).toBe(2);
		view.dispose();
	});

	test('committed computed derives from the committed view', () => {
		const a = atom(2);
		const c = computed(() => a.get() * 10);
		expect(c.get()).toBe(20);
		const view = createCommittedView();
		a.set(3);
		expect(c.get()).toBe(30);
		expect(committed(c, view)).toBe(20);
		view.commit();
		expect(committed(c, view)).toBe(30);
		view.dispose();
	});

	test('isPending flips for atoms with open drafts', () => {
		const a = atom(1);
		expect(isPending(a)).toBe(false);
		const b = createBatch(true);
		runInWriteBatch(b, () => a.set(2));
		expect(isPending(a)).toBe(true);
		retireBatch(b);
		expect(isPending(a)).toBe(false);
	});
});

describe('async computeds', () => {
	test('pending forwards downstream; settlement propagates like a write', async () => {
		let resolveIt!: (v: number) => void;
		const p = new Promise<number>((r) => (resolveIt = r));
		const src = computed((use) => use(p) * 2);
		const dst = computed(() => src.get() + 1);
		expect(isPending(dst)).toBe(true);
		expect(() => dst.get()).toThrow();
		resolveIt(10);
		await p;
		await Promise.resolve();
		expect(dst.get()).toBe(21);
		expect(isPending(dst)).toBe(false);
	});

	test('thenable identity is stable across repeated pending reads', () => {
		let fetches = 0;
		const key = atom(1);
		const c = computed((use) => {
			const k = key.get();
			return use(`item-${k}`, () => {
				fetches++;
				return new Promise<number>(() => {});
			});
		});
		const grab = () => {
			try {
				c.get();
				return null;
			} catch (e) {
				return e;
			}
		};
		const first = grab();
		const second = grab();
		expect(fetches).toBe(1);
		expect(first).toBe(second); // reference-stable pending box
	});

	test('refresh keeps serving stale via latest, flips isPending, latest-wins', async () => {
		let calls = 0;
		const resolvers: Array<(v: number) => void> = [];
		const c = computed((use) =>
			use('k', () => {
				calls++;
				return new Promise<number>((r) => resolvers.push(r));
			}),
		);
		expect(isPending(c)).toBe(true);
		resolvers[0](1);
		await Promise.resolve();
		await Promise.resolve();
		expect(c.get()).toBe(1);
		refresh(c);
		expect(calls).toBe(1); // refetch is lazy until next evaluation
		expect(latest(c)).toBe(1); // stale keeps serving
		expect(calls).toBe(2);
		expect(isPending(c)).toBe(true);
		resolvers[1](2);
		await Promise.resolve();
		await Promise.resolve();
		expect(c.get()).toBe(2);
		expect(isPending(c)).toBe(false);
	});
});

describe('lazy initializers and SSR', () => {
	test('initializer runs once, at first read, untracked, and may not write', () => {
		let runs = 0;
		const a = atom(() => {
			runs++;
			return 41;
		});
		expect(runs).toBe(0); // construction never materializes
		expect(a.get()).toBe(41);
		expect(runs).toBe(1);
		a.get();
		expect(runs).toBe(1);

		const other = atom(1);
		const bad = atom((): number => {
			other.set(5);
			return 0;
		});
		expect(() => bad.get()).toThrow(/initializers must not write/);
	});

	test('set before first read still runs the initializer (equality contract)', () => {
		let runs = 0;
		const a = atom(() => {
			runs++;
			return 10;
		});
		a.set(10); // equal to the lazy base: must drop
		expect(runs).toBe(1);
		const listener = vi.fn();
		const unsub = subscribeNode(a, listener);
		a.set(10);
		expect(listener).not.toHaveBeenCalled();
		unsub();
	});

	test('installState does not run the initializer and is not a write', () => {
		let runs = 0;
		const a = atom(() => {
			runs++;
			return 1;
		});
		installState(a, 99);
		expect(runs).toBe(0);
		const listener = vi.fn();
		const unsub = subscribeNode(a, listener); // subscription after install: no init
		expect(runs).toBe(0);
		expect(listener).not.toHaveBeenCalled();
		expect(a.get()).toBe(99);
		unsub();
	});

	test('serialize -> initialize round-trips values into a fresh graph', () => {
		const a = atom(1);
		const b = atom('hi');
		const json = serializeAtomState({ a, b });
		const a2 = atom(() => {
			throw new Error('initializer must not run on install');
		});
		const b2 = atom('');
		initializeAtomState(json, { a: a2 as never, b: b2 });
		expect(a2.get()).toBe(1);
		expect(b2.get()).toBe('hi');
	});
});

describe('lifetime effects', () => {
	test('first subscriber of any kind observes; last unsubscribe cleans up', () => {
		const log: string[] = [];
		const a = atom(0, {
			effect: () => {
				log.push('observe');
				return () => log.push('unobserve');
			},
		});
		const unsub1 = subscribeNode(a, () => {});
		const disposeEffect = effect(() => {
			a.get();
		});
		flushLifetimeEffects();
		expect(log).toEqual(['observe']); // union of kinds: exactly one observation
		unsub1();
		flushLifetimeEffects();
		expect(log).toEqual(['observe']); // effect still holds it
		disposeEffect();
		flushLifetimeEffects();
		expect(log).toEqual(['observe', 'unobserve']);
	});

	test('flaps within a tick coalesce to nothing', () => {
		const log: string[] = [];
		const a = atom(0, {
			effect: () => {
				log.push('observe');
			},
		});
		const unsub = subscribeNode(a, () => {});
		unsub();
		flushLifetimeEffects();
		expect(log).toEqual([]);
	});
});
