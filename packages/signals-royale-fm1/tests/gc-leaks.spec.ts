/**
 * Leak audit (--expose-gc, forks pool): dropped handles reclaim, and
 * quiescence leaves no per-episode state behind.
 */
import { describe, expect, test } from 'vitest';
import {
	atom,
	commitBatch,
	computed,
	discardBatch,
	effect,
	listOpenBatches,
	openBatch,
	pinCountForTest,
	withAmbientBatch,
	write,
	Snapshot,
} from '../src/index.ts';

function gcNow(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(() => {
			global.gc!();
			setTimeout(() => {
				global.gc!();
				resolve();
			}, 0);
		}, 0);
	});
}

describe('leak audit', () => {
	test('dropped atoms and computeds reclaim', async () => {
		expect(global.gc).toBeDefined();
		const registry: string[] = [];
		const fin = new FinalizationRegistry<string>((tag) => registry.push(tag));
		(() => {
			const a = atom({ big: new Array(1000).fill(1) });
			const c = computed(() => a.get().big.length);
			c.get();
			fin.register(a, 'atom');
			fin.register(c, 'computed');
		})();
		for (let i = 0; i < 10 && registry.length < 2; i++) await gcNow();
		expect(registry.sort()).toEqual(['atom', 'computed']);
	});

	test('disposed effects release their subject graph', async () => {
		const registry: string[] = [];
		const fin = new FinalizationRegistry<string>((tag) => registry.push(tag));
		(() => {
			const a = atom(0);
			const c = computed(() => a.get() + 1);
			const dispose = effect(() => c.get());
			a.set(1);
			dispose();
			fin.register(a, 'atom');
			fin.register(c, 'computed');
		})();
		for (let i = 0; i < 10 && registry.length < 2; i++) await gcNow();
		expect(registry.sort()).toEqual(['atom', 'computed']);
	});

	test('quiescence: retired batches and released snapshots leave no state', () => {
		const a = atom(1);
		const committedBatch = openBatch();
		withAmbientBatch(committedBatch, () => write(a, 2));
		const discarded = openBatch();
		withAmbientBatch(discarded, () => write(a, 3));
		const snap = new Snapshot([committedBatch], true);
		snap.pin();
		a.set(10); // canonical write while pinned records past values
		expect((a as { past: unknown }).past).not.toBeNull();
		commitBatch(committedBatch);
		discardBatch(discarded);
		snap.release();
		expect(listOpenBatches().length).toBe(0);
		expect(pinCountForTest()).toBe(0);
		expect((a as { past: unknown }).past).toBeNull();
	});

	test('retired batches reclaim (write intents are per-episode state)', async () => {
		const registry: string[] = [];
		const fin = new FinalizationRegistry<string>((tag) => registry.push(tag));
		const a = atom(0);
		(() => {
			const b = openBatch();
			withAmbientBatch(b, () => write(a, 1));
			fin.register(b, 'batch');
			commitBatch(b);
		})();
		for (let i = 0; i < 10 && registry.length < 1; i++) await gcNow();
		expect(registry).toEqual(['batch']);
		expect(a.peek()).toBe(1);
	});
});
