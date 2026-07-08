/**
 * Leak audit: dropped handles reclaim, and quiescence leaves no per-episode
 * state. Runs under --expose-gc (see vitest.config.ts). Allocations happen
 * in helper functions so no stack slot in the test frame pins them.
 */
import { afterEach, describe, expect, test } from 'vitest';
import {
	atom,
	computed,
	effect,
	createBatch,
	retireBatch,
	abortBatch,
	runInWriteBatch,
	withWorld,
	subscribeNode,
	resetForTest,
	openBatchCount,
	type Atom,
	type Computed,
	type WorldBatch,
} from '../src/index';

declare const gc: () => void;

afterEach(() => resetForTest());

async function collected(refs: WeakRef<object>[]): Promise<boolean> {
	for (let i = 0; i < 10; i++) {
		// deref() pins its target until the end of the turn, so run gc in a
		// fresh turn (before any deref) and only then check.
		gc();
		await new Promise((r) => setTimeout(r, 0));
		gc();
		if (refs.every((r) => r.deref() === undefined)) return true;
		await new Promise((r) => setTimeout(r, 0));
	}
	return false;
}

function makeDroppedNodes(): WeakRef<object>[] {
	const refs: WeakRef<object>[] = [];
	for (let i = 0; i < 100; i++) {
		const a = atom(i);
		const c = computed(() => a.get() * 2);
		c.get();
		refs.push(new WeakRef(a), new WeakRef(c));
	}
	return refs;
}

function makeDisposedEffectGraph(): WeakRef<object>[] {
	const a = atom(1);
	const c = computed(() => a.get() + 1);
	const dispose = effect(() => {
		c.get();
	});
	a.set(2);
	dispose();
	return [new WeakRef(a), new WeakRef(c)];
}

function makeUnsubscribedGraph(): WeakRef<object>[] {
	const a = atom(1);
	const unsub = subscribeNode(a, () => {});
	a.set(2);
	unsub();
	return [new WeakRef(a)];
}

function churnBatches(a: Atom<number>, keep: Computed<number>): WeakRef<object>[] {
	const refs: WeakRef<object>[] = [];
	for (let i = 0; i < 50; i++) {
		const b: WorldBatch = createBatch(true);
		runInWriteBatch(b, () => a.update((x) => x + 1));
		withWorld([b], () => keep.get()); // populate world caches
		if (i % 2 === 0) retireBatch(b);
		else abortBatch(b);
		refs.push(new WeakRef(b));
	}
	return refs;
}

describe('leak audit', () => {
	test('dropped atoms and computeds are reclaimed', async () => {
		expect(await collected(makeDroppedNodes())).toBe(true);
	});

	test('disposed effects release the graph they subscribed to', async () => {
		expect(await collected(makeDisposedEffectGraph())).toBe(true);
	});

	test('unsubscribed external subscriptions release their nodes', async () => {
		expect(await collected(makeUnsubscribedGraph())).toBe(true);
	});

	test('retired and aborted batches leave no per-episode state', async () => {
		const a = atom(0);
		const keep = computed(() => a.get() + 1);
		const unsub = subscribeNode(keep, () => {});
		const refs = churnBatches(a, keep);
		expect(openBatchCount()).toBe(0);
		unsub();
		expect(await collected(refs)).toBe(true);
	});

	test('quiescent machinery holds nothing for surviving nodes', () => {
		const a = atom(0);
		const c = computed(() => a.get() * 3);
		const unsub = subscribeNode(c, () => {});
		const b = createBatch(true);
		runInWriteBatch(b, () => a.set(5));
		expect(withWorld([b], () => c.get())).toBe(15);
		retireBatch(b);
		expect(a.hasOpenDrafts()).toBe(false);
		expect(openBatchCount()).toBe(0);
		unsub();
	});
});
