/**
 * ctx.use — reading async values inside a computed, in the base build:
 * while the thenable is pending, reads throw a reference-stable
 * SuspendedRead box; settlement invalidates and re-evaluates; the box's
 * identity is stable across re-evaluation; per-slot idempotence (pending
 * previous work wins); the lazy factory form; rejection → error box; and
 * read-site self-heal.
 */
import { describe, expect, test } from 'vitest';
import { Atom, Computed, SuspendedRead, effect } from '../src/index';

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

	test('per-slot idempotence: while pending, a re-created thenable is dropped (pending previous wins)', async () => {
		const gate = new Atom(0);
		const made: Array<ReturnType<typeof deferred<string>>> = [];
		const c = new Computed((ctx) => {
			gate.state;
			const d = deferred<string>();
			made.push(d);
			return ctx.use(d.promise);
		});

		const e1 = catchOf(() => c.state);
		expect(made.length).toBe(1);
		gate.set(1); // re-eval creates a NEW promise, but slot 0's is still pending
		const e2 = catchOf(() => c.state);
		expect(made.length).toBe(2);
		expect(e2).toBe(e1); // the first thenable still owns the slot → same box

		made[0].resolve('first');
		await made[0].promise;
		await tick();
		expect(c.state).toBe('first'); // the ORIGINAL work's value is consumed
	});

	test('lazy factory form: not called while the slot is pending', async () => {
		const gate = new Atom(0);
		let factoryCalls = 0;
		const d = deferred<string>();
		const c = new Computed((ctx) => {
			gate.state;
			return ctx.use(() => {
				factoryCalls++;
				return d.promise;
			});
		});
		expect(catchOf(() => c.state)).toBeInstanceOf(SuspendedRead);
		expect(factoryCalls).toBe(1);
		gate.set(1); // dep-driven re-eval while pending
		expect(catchOf(() => c.state)).toBeInstanceOf(SuspendedRead);
		expect(factoryCalls).toBe(1); // factory skipped — pending slot wins
		d.resolve('lazy');
		await d.promise;
		await tick();
		expect(c.state).toBe('lazy');
		expect(factoryCalls).toBe(1); // settled slot consumed on the settle re-eval
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

	test('consumed use-slots reset once an evaluation completes (fresh work refetches)', async () => {
		const gate = new Atom(0);
		let fetches = 0;
		const boxes: Array<ReturnType<typeof deferred<number>>> = [];
		const c = new Computed((ctx) => {
			const g = gate.state;
			return ctx.use(() => {
				fetches++;
				const d = deferred<number>();
				boxes.push(d);
				d.resolve(g * 100);
				return d.promise;
			});
		});
		expect(catchOf(() => c.state)).toBeInstanceOf(SuspendedRead);
		await boxes[0].promise;
		await tick();
		expect(c.state).toBe(0);
		expect(fetches).toBe(1);
		gate.set(2); // dep change AFTER completion: the slot was consumed → refetch
		expect(catchOf(() => c.state)).toBeInstanceOf(SuspendedRead);
		expect(fetches).toBe(2);
		await boxes[1].promise;
		await tick();
		expect(c.state).toBe(200);
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
