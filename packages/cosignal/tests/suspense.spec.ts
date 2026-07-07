/**
 * ctx.use — reading async values inside a computed. Two forms, both exact
 * React `use()` parity:
 *
 *  1. `ctx.use(thenable)` — caller-cached promise: settled work unwraps
 *     synchronously; pending work throws a SuspendedRead that stays the same
 *     object across reads and re-evaluations (a lazy expando on the
 *     instrumented thenable); settlement invalidates and re-evaluates.
 *  2. `ctx.use(key, factory)` — per-key cache scoped to the LIVING node:
 *     same key shares the entry (pending shares the in-flight thenable,
 *     settled replays the value/error) for the node's whole lifetime;
 *     different keys coexist — one key's pending work never blocks or
 *     collides with another key's settled work.
 *
 * The bare positional-factory form is GONE (this file used to pin its
 * "pending previous wins across different inputs" semantics — that contract
 * was judged world-unsound and replaced by the keyed contract below). Also
 * covered: rejection rethrows the reason from cache, and read-site
 * self-heal (a read after settlement recomputes instead of throwing stale).
 */
import { describe, expect, test } from 'vitest';
import { mountEngineReactEffect } from './helpers.js';
import { Atom, Computed, SuspendedRead, effect, __newBridgeForTest } from '../src/index';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const tick = (): Promise<void> => new Promise<void>((res) => queueMicrotask(res));

function catchOf(fn: () => unknown): unknown {
	try {
		fn();
	} catch (e) {
		return e;
	}
	return undefined;
}

describe('ctx.use', () => {
	test('pending → SuspendedRead carrying the thenable; identity stable across re-eval', async () => {
		const d = deferred<string>();
		const gate = new Atom(0);
		let evals = 0;
		const c = new Computed((ctx) => {
			evals++;
			gate.state;
			return ctx.use(d.promise);
		});

		const e1 = catchOf(() => c.state);
		expect(e1).toBeInstanceOf(SuspendedRead);
		expect((e1 as SuspendedRead).thenable).toBe(d.promise);
		expect(evals).toBe(1);

		// Re-read while pending: cached box, no re-evaluation, SAME sentinel.
		const e2 = catchOf(() => c.state);
		expect(e2).toBe(e1);
		expect(evals).toBe(1);

		// Dependency-driven re-eval while pending: same thenable → same box.
		gate.set(1);
		const e3 = catchOf(() => c.state);
		expect(e3).toBe(e1);
		expect(evals).toBe(2);

		// Settlement invalidates: the value is served after settle.
		d.resolve('done');
		await d.promise;
		await tick();
		expect(c.state).toBe('done');
	});

	test('settlement re-runs subscribed effects', async () => {
		const d = deferred<number>();
		const c = new Computed<number>((ctx) => ctx.use(d.promise) * 2);
		const log: Array<number | 'pending'> = [];
		const dispose = effect(() => {
			try {
				log.push(c.state);
			} catch (e) {
				if (e instanceof SuspendedRead) {
					log.push('pending');
				} else {
					throw e;
				}
			}
		});
		expect(log).toEqual(['pending']);
		d.resolve(21);
		await d.promise;
		await tick();
		expect(log).toEqual(['pending', 42]);
		dispose();
	});

	test('rejection settles into an error box; read sites rethrow the reason', async () => {
		const d = deferred<number>();
		const reason = new Error('fetch failed');
		const c = new Computed((ctx) => ctx.use(d.promise));
		expect(catchOf(() => c.state)).toBeInstanceOf(SuspendedRead);
		d.reject(reason);
		await d.promise.catch(() => {});
		await tick();
		expect(catchOf(() => c.state)).toBe(reason);
	});

	test('keyed form: same key shares the in-flight entry (factory not re-called while pending)', async () => {
		const gate = new Atom(0);
		let factoryCalls = 0;
		const d = deferred<string>();
		const c = new Computed((ctx) => {
			gate.state;
			return ctx.use('req', () => {
				factoryCalls++;
				return d.promise;
			});
		});
		const e1 = catchOf(() => c.state);
		expect(e1).toBeInstanceOf(SuspendedRead);
		expect(factoryCalls).toBe(1);
		gate.set(1); // dep-driven re-eval while pending: same key → same entry
		const e2 = catchOf(() => c.state);
		expect(e2).toBe(e1); // shared entry ⇒ shared stable sentinel
		expect(factoryCalls).toBe(1);
		d.resolve('shared');
		await d.promise;
		await tick();
		expect(c.state).toBe('shared');
		expect(factoryCalls).toBe(1); // the settled entry replays; no refetch
	});

	test('keyed form: different keys coexist — a settled key never suspends on another key\'s pending work', async () => {
		// The cross-key schedule the reviews walked (single-world analog):
		// key q1 settles; key q2 is fetched and left pending; a re-read that
		// asks q1 again must serve q1's settled value synchronously — NOT
		// suspend on q2's promise, NOT refetch q1.
		const query = new Atom('q1');
		const gates: Record<string, ReturnType<typeof deferred<string>>> = {
			q1: deferred<string>(),
			q2: deferred<string>(),
		};
		let fetches = 0;
		const c = new Computed((ctx) => {
			const q = query.state;
			return ctx.use(['fetch', q], () => {
				fetches++;
				return gates[q]!.promise;
			});
		});
		expect(catchOf(() => c.state)).toBeInstanceOf(SuspendedRead);
		expect(fetches).toBe(1);
		gates.q1!.resolve('DATA1');
		await gates.q1!.promise;
		await tick();
		expect(c.state).toBe('DATA1'); // q1 settled
		query.set('q2'); // new key: fetches q2, suspends on IT
		const e2 = catchOf(() => c.state);
		expect(e2).toBeInstanceOf(SuspendedRead);
		expect((e2 as SuspendedRead).thenable).toBe(gates.q2!.promise);
		expect(fetches).toBe(2);
		query.set('q1'); // back to the settled key while q2 is still pending
		expect(c.state).toBe('DATA1'); // synchronous replay — no suspension, no collision
		expect(fetches).toBe(2); // and no refetch: entries live as long as the node
	});

	test('pre-instrumented custom thenables: settled status is consumed synchronously', () => {
		type Fake = PromiseLike<number> & { status?: string; value?: number };
		const fake: Fake = {
			status: 'fulfilled',
			value: 9,
			then: () => {
				throw new Error('unreachable for settled thenables');
			},
		};
		const c = new Computed((ctx) => ctx.use(fake as PromiseLike<number>) + 1);
		expect(c.state).toBe(10); // no suspension flap for already-settled work
	});

	test('read-site self-heal: a settled-but-not-yet-delivered suspension recovers on read', () => {
		// A hand-instrumented thenable whose settle callbacks are withheld:
		// simulates reading after settlement but before the listener microtask.
		type Fake = PromiseLike<string> & { status?: string; value?: string };
		const callbacks: Array<() => void> = [];
		const fake: Fake = {
			status: 'pending',
			then: (onF?: ((v: string) => unknown) | null) => {
				callbacks.push(() => onF?.(fake.value!));
				return undefined as never;
			},
		};
		const c = new Computed((ctx) => ctx.use(fake as PromiseLike<string>));
		expect(catchOf(() => c.state)).toBeInstanceOf(SuspendedRead);
		// Settle WITHOUT running the stored callbacks.
		fake.status = 'fulfilled';
		fake.value = 'healed';
		expect(c.state).toBe('healed'); // self-heal: invalidate + recompute on read
	});

	test('keyed entries persist for the node\'s lifetime: a changed key refetches, the old key replays', async () => {
		const gate = new Atom(0);
		let fetches = 0;
		const boxes: Array<ReturnType<typeof deferred<number>>> = [];
		const c = new Computed((ctx) => {
			const g = gate.state;
			return ctx.use(g, () => {
				fetches++;
				const d = deferred<number>();
				boxes.push(d);
				d.resolve(g * 100);
				return d.promise;
			});
		});
		expect(catchOf(() => c.state)).toBeInstanceOf(SuspendedRead);
		await boxes[0]!.promise;
		await tick();
		expect(c.state).toBe(0);
		expect(fetches).toBe(1);
		gate.set(2); // NEW key: fresh entry, refetch
		expect(catchOf(() => c.state)).toBeInstanceOf(SuspendedRead);
		expect(fetches).toBe(2);
		await boxes[1]!.promise;
		await tick();
		expect(c.state).toBe(200);
		gate.set(0); // back to a key that already settled: replay, NO refetch
		expect(c.state).toBe(0);
		expect(fetches).toBe(2);
	});

	test('the bare positional-factory form is gone (loud error), and keys reject objects/functions', () => {
		const c1 = new Computed((ctx) => (ctx.use as (s: unknown) => unknown)(() => Promise.resolve(1)));
		expect(catchOf(() => c1.state)).toMatchObject({ message: expect.stringMatching(/bare factory form.*removed/) });
		const c2 = new Computed((ctx) => (ctx.use as (k: unknown, f: unknown) => unknown)({ q: 1 }, () => Promise.resolve(1)));
		expect(catchOf(() => c2.state)).toMatchObject({ message: expect.stringMatching(/keys must be strings, numbers/) });
		const c3 = new Computed((ctx) => (ctx.use as (s: unknown) => unknown)(42));
		expect(catchOf(() => c3.state)).toMatchObject({ message: expect.stringMatching(/takes a thenable/) });
	});

	test('key serialization is type-stable: 1, "1", [1], true, "true", null, "null" all coexist', async () => {
		const which = new Atom(0);
		const keys: unknown[] = [1, '1', [1], true, 'true', null, 'null', [1, [2]], ['1,2']];
		let fetches = 0;
		const c = new Computed((ctx) => {
			const k = keys[which.state];
			return (ctx.use as (k: unknown, f: () => PromiseLike<unknown>) => unknown)(k, () => {
				fetches++;
				return Promise.resolve(`v${fetches}`);
			});
		});
		for (let i = 0; i < keys.length; i++) {
			which.set(i);
			catchOf(() => c.state); // mint (suspends; Promise.resolve settles next tick)
		}
		await tick();
		expect(fetches).toBe(keys.length); // every key minted its own entry
	});

	test('ctx.use outside a computed evaluation throws', () => {
		let leaked: { use<V>(source: PromiseLike<V>): V } | undefined;
		const c = new Computed<number>((ctx) => {
			leaked = ctx;
			return 1;
		});
		expect(c.state).toBe(1);
		expect(() => leaked!.use(Promise.resolve(1))).toThrow(/only be called during/);
	});

	test('suspension chains through dependent computeds with a stable payload', async () => {
		const d = deferred<number>();
		const inner = new Computed<number>((ctx) => ctx.use(d.promise));
		const outer = new Computed(() => inner.state + 1);
		const e1 = catchOf(() => outer.state);
		expect(e1).toBeInstanceOf(SuspendedRead);
		expect((e1 as SuspendedRead).thenable).toBe(d.promise);
		const e2 = catchOf(() => outer.state);
		expect(e2).toBe(e1); // outer's own box is reference-stable too
		d.resolve(4);
		await d.promise;
		await tick();
		expect(outer.state).toBe(5);
	});
});

// Battery 16d at the ENGINE level (the adapter rule promoted verbatim into
// the committed-subscription boundary scan): a dep whose committed re-read is
// a still-pending suspension is NOT a flip. Engine-direct — the reference
// model deliberately models no suspense (declared in the oracle README).
describe('committed-subscription dep snapshots under suspension (battery 16d)', () => {
	test('a stable pending sentinel VALUE is not a flip; the settled value is', () => {
		const b = __newBridgeForTest();
		b.registerBridge();
		const d = deferred<string>();
		const sentinel = new SuspendedRead(d.promise);
		const gate = b.atom('gate', 0);
		let settled: string | undefined;
		// The shim's background translation shape: pending folds to its STABLE
		// sentinel as a value (hook-initiated evaluations rethrow instead).
		const c = b.computed('c', (read) => {
			read(gate);
			return settled === undefined ? sentinel : settled;
		});
		const e = mountEngineReactEffect(b, 'A', c, 'E'); // snapshot: (c, sentinel)
		expect(e.lastValue).toBe(sentinel);
		const t1 = b.openBatch();
		b.write(t1.id, gate, { kind: 'set', value: 1 });
		b.retire(t1.id); // boundary: re-read is the SAME sentinel — still pending, no flip
		expect(e.runs).toBe(0);
		settled = 'DATA';
		const t2 = b.openBatch();
		b.write(t2.id, gate, { kind: 'set', value: 2 });
		b.retire(t2.id); // boundary: the settled value replaced the sentinel — a real flip
		expect(e.runs).toBe(1);
		expect(e.lastValue).toBe('DATA');
	});

	test('a dep whose committed re-read THROWS a still-pending suspension is skipped, not a crash and not a flip', () => {
		const b = __newBridgeForTest();
		b.registerBridge();
		const d = deferred<string>();
		const sentinel = new SuspendedRead(d.promise);
		const gate = b.atom('gate', 0);
		let pending = false;
		const c = b.computed('c', (read) => {
			read(gate);
			if (pending) throw sentinel; // hook-shaped rethrow on re-evaluation
			return 'v0';
		});
		const e = mountEngineReactEffect(b, 'A', c, 'E'); // snapshot: (c, 'v0')
		pending = true;
		const t = b.openBatch();
		b.write(t.id, gate, { kind: 'set', value: 1 });
		b.retire(t.id); // boundary: the re-read suspends — not a flip (and not an error)
		expect(e.runs).toBe(0);
		expect(e.lastValue).toBe('v0');
	});
});
