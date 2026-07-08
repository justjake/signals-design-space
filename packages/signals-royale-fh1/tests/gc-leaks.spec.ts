/**
 * Leak audit (--expose-gc, forks pool): dropped handles reclaim, and
 * quiescence leaves no per-episode state behind.
 */
import { describe, expect, test } from 'vitest';
import {
	__resetEngine,
	atom,
	computed,
	createBatch,
	effect,
	latest,
	liveBatches,
	makeWorld,
	readInWorld,
	subscribeHook,
	type Atom,
} from '../src/index';

function gcNow(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(() => {
			globalThis.gc!();
			globalThis.gc!();
			resolve();
		}, 0);
	});
}

describe('leak audit', () => {
	test('an unobserved computed over a live atom is collectable', async () => {
		const a = atom(0);
		let ref: WeakRef<object> | undefined;
		(() => {
			const c = computed(() => a.get() * 2);
			c.get();
			ref = new WeakRef(c);
		})();
		await gcNow();
		expect(ref!.deref()).toBeUndefined();
		a.set(1); // the source still works; no dangling edges throw
		expect(a.get()).toBe(1);
	});

	test('a computed chain is collectable after its effect is disposed', async () => {
		const a = atom(0);
		const refs: WeakRef<object>[] = [];
		(() => {
			const c1 = computed(() => a.get() + 1);
			const c2 = computed(() => c1.get() + 1);
			const dispose = effect(() => c2.get());
			refs.push(new WeakRef(c1), new WeakRef(c2));
			dispose();
		})();
		await gcNow();
		expect(refs.map((r) => r.deref())).toEqual([undefined, undefined]);
		expect((a as Atom<number> & { obs: unknown[] }).obs.length).toBe(0);
	});

	test('atoms dropped while subscribed via hooks reclaim after unsubscribe', async () => {
		let ref: WeakRef<object> | undefined;
		(() => {
			const a = atom(0);
			const unsub = subscribeHook(a, () => {});
			a.set(1);
			unsub();
			ref = new WeakRef(a);
		})();
		await gcNow();
		expect(ref!.deref()).toBeUndefined();
	});

	test('quiescence reclaims every per-episode structure', () => {
		const a = atom(1);
		const bAtom = atom(2);
		const c = computed(() => a.get() + bAtom.get());
		const b1 = createBatch();
		const w = makeWorld([b1.id]);
		b1.run(() => {
			a.update((x) => x + 1);
			bAtom.set(9);
		});
		a.set(5); // urgent write joins the log
		expect(readInWorld(c, w)).toBe(11); // (1+1) + 9 (urgent 5 is after the cutoff)
		w.release();
		b1.retire();
		// Quiescent: histories, logs, world caches, and draft edges are gone.
		const aa = a as Atom<number> & {
			hist: unknown;
			log: unknown;
			draftSubs: unknown;
		};
		expect(aa.hist).toBeNull();
		expect(aa.log).toBeNull();
		expect(aa.draftSubs).toBeNull();
		expect((c as unknown as { wc: unknown }).wc).toBeNull();
		expect(liveBatches.size).toBe(0);
		// Replay in sequence order: (1+1) = 2, then the urgent set lands 5.
		expect(a.get()).toBe(5);
	});

	test('canonical replay after quiescence matches the log order', () => {
		__resetEngine();
		const a = atom(1);
		const b1 = createBatch();
		b1.run(() => a.update((x) => x + 1));
		a.set(5);
		b1.retire();
		// Replay in sequence order: (1 + 1) = 2, then set 5 -> 5.
		expect(a.get()).toBe(5);
		expect(latest(a)).toBe(5);
	});

	test('dropped worlds release computed world caches', () => {
		const a = atom(1);
		const c = computed(() => a.get() * 3);
		const b = createBatch();
		b.run(() => a.set(2));
		const w = makeWorld([b.id]);
		expect(readInWorld(c, w)).toBe(6);
		expect((c as unknown as { wc: unknown[] }).wc).not.toBeNull();
		w.release();
		expect((c as unknown as { wc: unknown[] | null }).wc).toBeNull();
		b.discard();
	});

	test('discarded batches leave no retained atoms', () => {
		const b = createBatch();
		const a = atom(0);
		b.run(() => a.set(1));
		expect(b.atoms.size).toBe(1);
		b.discard();
		expect(b.atoms.size).toBe(0);
		expect(liveBatches.size).toBe(0);
	});
});
