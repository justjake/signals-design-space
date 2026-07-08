/**
 * Async evaluation: pending as graph state, parallel registration, stable
 * sentinels, error boxes, settlement-as-write, refresh, and per-world
 * fetch isolation.
 */
import { describe, expect, test, beforeEach } from 'vitest';
import {
	__resetEngine,
	AsyncError,
	atom,
	computed,
	effect,
	isPending,
	isPendingValue,
	latest,
	openBatch,
	read,
	readInWorld,
	refresh,
	retireBatch,
	retryThenable,
	set,
	setInBatch,
	settledHistory,
} from '../src/index';

beforeEach(() => {
	__resetEngine();
});

function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('pending as graph state', () => {
	test('unresolved use evaluates to a stable pending box; settlement is a write', async () => {
		const d = deferred<string>();
		let evals = 0;
		const c = computed((use) => {
			evals++;
			return use(d.promise).toUpperCase();
		});
		const v1 = read(c);
		expect(isPendingValue(v1)).toBe(true);
		expect(read(c)).toBe(v1); // reference-stable sentinel, no re-evaluation churn
		expect(evals).toBe(1);
		const seen: unknown[] = [];
		const dispose = effect(() => {
			seen.push(read(c));
		});
		expect(seen).toHaveLength(1);
		d.resolve('data');
		await tick();
		expect(read(c)).toBe('DATA');
		expect(seen).toHaveLength(2); // settlement invalidated like a write
		expect(seen[1]).toBe('DATA');
		expect(evals).toBe(2); // one evaluation per generation, not per read
		dispose();
	});

	test('parallel fetches: both async reads register before the evaluation parks', async () => {
		const d1 = deferred<number>();
		const d2 = deferred<number>();
		let f1 = 0;
		let f2 = 0;
		const c = computed((use) => {
			const a = use('one', () => (f1++, d1.promise));
			const b = use('two', () => (f2++, d2.promise));
			return a + b;
		});
		expect(isPendingValue(read(c))).toBe(true);
		expect(f1).toBe(1);
		expect(f2).toBe(1); // registered despite `one` being unresolved
		d1.resolve(1);
		await tick();
		expect(isPendingValue(read(c))).toBe(true);
		d2.resolve(2);
		await tick();
		expect(read(c)).toBe(3);
		expect(f1).toBe(1);
		expect(f2).toBe(1); // keyed factories ran exactly once
	});

	test('downstream computeds forward pending; settlement propagates through', async () => {
		const d = deferred<number>();
		const inner = computed((use) => use(d.promise) * 2);
		const outer = computed(() => read(inner) + 1);
		const v = read(outer);
		expect(isPendingValue(v)).toBe(true);
		const retry = retryThenable(outer, []);
		d.resolve(10);
		await retry;
		await tick();
		expect(read(outer)).toBe(21);
	});

	test('rejections become one reference-stable box rethrown at read sites', async () => {
		const d = deferred<number>();
		const c = computed((use) => use(d.promise));
		expect(isPendingValue(read(c))).toBe(true);
		d.reject(new Error('boom'));
		await tick();
		let box1: unknown;
		let box2: unknown;
		try {
			read(c);
		} catch (e) {
			box1 = e;
		}
		try {
			read(c);
		} catch (e) {
			box2 = e;
		}
		expect(box1).toBeInstanceOf(AsyncError);
		expect(box1).toBe(box2);
		expect((box1 as AsyncError).reason).toBeInstanceOf(Error);
	});

	test('still-pending after a dependency change is not a flip (stable sentinel)', async () => {
		const kick = atom(0);
		const d = deferred<string>();
		const c = computed((use) => {
			read(kick);
			return use('k', () => d.promise);
		});
		const seen: unknown[] = [];
		const dispose = effect(() => {
			seen.push(read(c));
		});
		expect(seen).toHaveLength(1);
		expect(isPendingValue(seen[0])).toBe(true);
		set(kick, 1); // re-evaluates; still pending; same sentinel; no effect re-fire
		expect(seen).toHaveLength(1);
		d.resolve('DATA');
		await tick();
		expect(seen).toHaveLength(2);
		expect(seen[1]).toBe('DATA');
		set(kick, 2); // value-gated: same settled value, no extra fire
		expect(seen).toHaveLength(2);
		dispose();
	});
});

describe('per-world async isolation', () => {
	test('a draft world fetches its own key; the committed world serves settled data', async () => {
		const q = atom('q1');
		const gates: Record<string, ReturnType<typeof deferred<string>>> = {
			q1: deferred<string>(),
			q2: deferred<string>(),
		};
		let fetches = 0;
		const data = computed((use) => {
			const query = read(q);
			return use(query, () => (fetches++, gates[query]!.promise));
		});
		expect(isPendingValue(read(data))).toBe(true);
		expect(fetches).toBe(1);
		gates.q1!.resolve('DATA1');
		await tick();
		expect(read(data)).toBe('DATA1');
		// Transition asks a different key.
		const b = openBatch();
		setInBatch(b, q, 'q2');
		expect(isPendingValue(readInWorld(data, [b]))).toBe(true);
		expect(fetches).toBe(2);
		// The committed world is untouched: settled data serves synchronously.
		expect(read(data)).toBe('DATA1');
		expect(fetches).toBe(2);
		gates.q2!.resolve('DATA2');
		await tick();
		expect(readInWorld(data, [b])).toBe('DATA2');
		retireBatch(b);
		await tick();
		// Promotion: the retired world's settled fetch carried over — no refetch.
		expect(read(data)).toBe('DATA2');
		expect(fetches).toBe(2);
	});

	test('settlement of a draft-world fetch stays out of canonical until retirement', async () => {
		const q = atom('a');
		const gate = deferred<string>();
		const data = computed((use) => {
			const query = read(q);
			return query === 'a' ? 'sync-a' : use('b', () => gate.promise);
		});
		expect(read(data)).toBe('sync-a');
		const b = openBatch();
		setInBatch(b, q, 'b');
		expect(isPendingValue(readInWorld(data, [b]))).toBe(true);
		gate.resolve('async-b');
		await tick();
		expect(read(data)).toBe('sync-a'); // canonical untouched by the settlement
		expect(readInWorld(data, [b])).toBe('async-b');
		retireBatch(b);
		expect(read(data)).toBe('async-b');
	});
});

describe('refresh', () => {
	test('refetches with unchanged inputs; stale serves; latest preserved; isPending flips', async () => {
		const gates = [deferred<string>(), deferred<string>()];
		let calls = 0;
		const data = computed((use) => use('k', () => gates[calls++]!.promise));
		expect(isPendingValue(read(data))).toBe(true);
		gates[0]!.resolve('v1');
		await tick();
		expect(read(data)).toBe('v1');
		refresh(data);
		expect(calls).toBe(2); // refetch launched
		expect(read(data)).toBe('v1'); // stale keeps serving
		expect(latest(data)).toBe('v1'); // no fallback flash
		expect(isPending(data)).toBe(true);
		gates[1]!.resolve('v2');
		await tick();
		expect(read(data)).toBe('v2');
		expect(isPending(data)).toBe(false);
		expect(settledHistory(data)).toEqual({ has: true, value: 'v2' });
	});

	test('latest-wins on refresh races', async () => {
		const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
		let calls = 0;
		const data = computed((use) => use('k', () => gates[calls++]!.promise));
		read(data);
		gates[0]!.resolve('v1');
		await tick();
		refresh(data); // fetch #2
		refresh(data); // fetch #3 supersedes #2
		gates[2]!.resolve('v3');
		await tick();
		expect(read(data)).toBe('v3');
		gates[1]!.resolve('v2-late');
		await tick();
		expect(read(data)).toBe('v3'); // the superseded refresh cannot regress
	});

	test('refresh inside a transition belongs to that transition', async () => {
		const gates = [deferred<string>(), deferred<string>()];
		let calls = 0;
		const data = computed((use) => use('k', () => gates[calls]!.promise));
		read(data);
		gates[0]!.resolve('v1');
		await tick();
		expect(read(data)).toBe('v1');
		const b = openBatch();
		calls = 1;
		// Attribute the refresh to the batch (host classification).
		b.refreshes.add(data as never);
		b.version++;
		expect(read(data)).toBe('v1'); // canonical serves stale
		expect(isPendingValue(readInWorld(data, [b]))).toBe(true); // the draft world refetches
		expect(calls).toBe(1);
		gates[1]!.resolve('v2');
		await tick();
		expect(readInWorld(data, [b])).toBe('v2');
		expect(read(data)).toBe('v1'); // still stale canonically
		retireBatch(b);
		await tick();
		expect(read(data)).toBe('v2'); // the refresh committed with the transition
	});
});
