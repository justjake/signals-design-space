/**
 * Leak audit (requires --expose-gc): dropped handles reclaim, and
 * quiescence leaves no per-episode state behind. Handle creation happens
 * in separate function frames so the test frame holds no hidden references.
 */
import { describe, expect, test, beforeEach } from 'vitest';
import {
	__internals,
	__resetEngine,
	atom,
	committed,
	computed,
	effect,
	openBatch,
	quiescent,
	read,
	readInWorld,
	reportCommittedValue,
	retireBatch,
	set,
	setInBatch,
	subscribe,
	type Atom,
} from '../src/index';

declare const gc: (() => void) | undefined;

beforeEach(() => {
	__resetEngine();
});

declare const setTimeout: (fn: () => void, ms?: number) => unknown;

async function collect(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		gc!();
		await new Promise<void>((r) => setTimeout(() => r(), 0));
	}
}

function makeGraphGarbage(): [WeakRef<object>, WeakRef<object>] {
	const a = atom({ big: new Array(1000).fill(1) });
	const c = computed(() => (read(a) as { big: number[] }).big.length);
	if (read(c) !== 1000) {
		throw new Error('sanity');
	}
	return [new WeakRef(a as object), new WeakRef(c as object)];
}

function makeViewGarbage(container: object): WeakRef<object> {
	const a = atom(1);
	reportCommittedValue(container, a as Atom<unknown>, 1);
	if (committed(a, container) !== 1) {
		throw new Error('sanity');
	}
	const b = openBatch();
	setInBatch(b, a, 2);
	if (readInWorld(a, [b]) !== 2) {
		throw new Error('sanity');
	}
	retireBatch(b);
	return new WeakRef(a as object);
}

function makeSubscribedGarbage(): WeakRef<object> {
	const a = atom(0);
	const sub = subscribe(a, () => {});
	const dispose = effect(() => {
		void read(a);
	});
	set(a, 1);
	sub.dispose();
	dispose();
	return new WeakRef(a as object);
}

async function makeAsyncGarbage(): Promise<WeakRef<object>> {
	const c = computed((use) => use('k', () => Promise.resolve(7)));
	read(c);
	await new Promise<void>((r) => setTimeout(() => r(), 0));
	if (read(c) !== 7) {
		throw new Error('sanity');
	}
	return new WeakRef(c as object);
}

describe('gc / leaks', () => {
	test('dropped atom and computed handles reclaim', async () => {
		expect(typeof gc).toBe('function');
		const [aRef, cRef] = makeGraphGarbage();
		await collect();
		expect(aRef.deref()).toBeUndefined();
		expect(cRef.deref()).toBeUndefined();
	});

	test('handles reclaim even after committed-view reports and world reads', async () => {
		const container = {};
		const aRef = makeViewGarbage(container);
		await collect();
		expect(aRef.deref()).toBeUndefined();
	});

	test('disposed subscriptions and effects release their targets', async () => {
		const aRef = makeSubscribedGarbage();
		await collect();
		expect(aRef.deref()).toBeUndefined();
	});

	test('async computed handles reclaim after settlement', async () => {
		const cRef = await makeAsyncGarbage();
		await collect();
		expect(cRef.deref()).toBeUndefined();
	});

	test('a full episode returns to quiescence with zero per-episode state', () => {
		const a = atom(0);
		const c = computed(() => read(a) * 2);
		const sub = subscribe(c, () => {});
		const b1 = openBatch();
		const b2 = openBatch();
		setInBatch(b1, a, 1);
		setInBatch(b2, a, 2);
		readInWorld(c, [b1]);
		readInWorld(c, [b2, b1]);
		set(a, 5);
		expect(quiescent()).toBe(false);
		retireBatch(b1);
		retireBatch(b2);
		sub.dispose();
		expect(quiescent()).toBe(true);
		expect(__internals()).toEqual({ openBatches: 0, worldCaches: 0, pendingListeners: 0 });
	});
});
