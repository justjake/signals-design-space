/**
 * Concurrent semantics at the engine level: draft batches, world folds,
 * rebase arithmetic, the read family, rollback, and quiescence.
 */
import { describe, expect, test, beforeEach } from 'vitest';
import {
	__internals,
	__resetEngine,
	atom,
	committed,
	computed,
	discardBatch,
	effect,
	isPending,
	latest,
	openBatch,
	quiescent,
	read,
	readInWorld,
	registerRoot,
	retireBatch,
	rootCommitted,
	set,
	setInBatch,
	subscribe,
	update,
	updateInBatch,
	currentGraphEpoch,
} from '../src/index';

beforeEach(() => {
	__resetEngine();
});

describe('draft batches and worlds', () => {
	test('a draft write is invisible to canonical readers until retirement', () => {
		const a = atom(0);
		const b = openBatch();
		setInBatch(b, a, 5);
		expect(read(a)).toBe(0);
		expect(readInWorld(a, [b])).toBe(5);
		expect(latest(a)).toBe(5);
		retireBatch(b);
		expect(read(a)).toBe(5);
		expect(quiescent()).toBe(true);
	});

	test('rebase arithmetic: urgent (1+1) commits alone, transition x2 lands as 4', () => {
		const a = atom(1);
		const b = openBatch();
		updateInBatch(b, a, (x) => x * 2);
		update(a, (x) => x + 1); // urgent, mid-transition
		expect(read(a)).toBe(2); // urgent committed alone
		expect(readInWorld(a, [b])).toBe(4); // draft folds over the new base
		retireBatch(b);
		expect(read(a)).toBe(4); // never 2, never a torn 3
	});

	test('computeds evaluate per world with world-specific dependency sets', () => {
		const flag = atom(true);
		const x = atom(1);
		const y = atom(100);
		let evals = 0;
		const pick = computed(() => {
			evals++;
			return read(flag) ? read(x) : read(y);
		});
		expect(read(pick)).toBe(1);
		const b = openBatch();
		setInBatch(b, flag, false);
		expect(readInWorld(pick, [b])).toBe(100);
		expect(read(pick)).toBe(1); // canonical cache untouched
		// A draft write to the world-only dependency invalidates the world value.
		setInBatch(b, y, 200);
		expect(readInWorld(pick, [b])).toBe(200);
		retireBatch(b);
		expect(read(pick)).toBe(200);
		expect(evals).toBeGreaterThanOrEqual(3);
	});

	test('world memoization: same world, unchanged fingerprint, one evaluation', () => {
		const a = atom(1);
		let evals = 0;
		const c = computed(() => {
			evals++;
			return read(a) * 10;
		});
		const b = openBatch();
		setInBatch(b, a, 2);
		expect(readInWorld(c, [b])).toBe(20);
		expect(readInWorld(c, [b])).toBe(20);
		const evalsAfter = evals;
		expect(readInWorld(c, [b])).toBe(20);
		expect(evals).toBe(evalsAfter);
		retireBatch(b);
	});

	test('two batches fold in creation order', () => {
		const a = atom('');
		const b1 = openBatch();
		const b2 = openBatch();
		updateInBatch(b1, a, (s) => s + 'A');
		updateInBatch(b2, a, (s) => s + 'B');
		expect(readInWorld(a, [b2, b1])).toBe('AB');
		retireBatch(b1);
		retireBatch(b2);
		expect(read(a)).toBe('AB');
	});

	test('discard rolls back and re-notifies subscribers that saw the draft', () => {
		const a = atom(0);
		const deliveries: Array<number | null> = [];
		const sub = subscribe(a, (d) => deliveries.push(d.batch ? d.batch.id : null));
		const b = openBatch();
		setInBatch(b, a, 9);
		expect(deliveries).toEqual([b.id]);
		discardBatch(b);
		expect(deliveries).toEqual([b.id, null]); // rollback re-notify
		expect(read(a)).toBe(0);
		sub.dispose();
	});

	test('equal draft writes drop against the batch world, not canonical', () => {
		const a = atom(5);
		const b = openBatch();
		setInBatch(b, a, 5); // equal to the batch world value: dropped
		expect(b.ops.size).toBe(0);
		set(a, 7); // urgent
		setInBatch(b, a, 7); // batch world folds canonical 7: dropped too
		expect(b.ops.size).toBe(0);
		setInBatch(b, a, 8);
		expect(b.ops.size).toBe(1);
		retireBatch(b);
		expect(read(a)).toBe(8);
	});

	test('effects observe canonical only — never speculative drafts', () => {
		const a = atom(0);
		const seen: number[] = [];
		const dispose = effect(() => {
			seen.push(read(a));
		});
		const b = openBatch();
		setInBatch(b, a, 1);
		expect(seen).toEqual([0]); // draft invisible
		retireBatch(b);
		expect(seen).toEqual([0, 1]); // retirement is the write
		dispose();
	});

	test('quiescence reclaims world caches and batches', () => {
		const a = atom(0);
		const c = computed(() => read(a) + 1);
		const b = openBatch();
		setInBatch(b, a, 1);
		readInWorld(c, [b]);
		expect(__internals().worldCaches).toBeGreaterThan(0);
		retireBatch(b);
		expect(__internals().openBatches).toBe(0);
		expect(__internals().worldCaches).toBe(0);
		expect(quiescent()).toBe(true);
	});
});

describe('read family', () => {
	test('latest folds all open batches; read stays canonical', () => {
		const a = atom(1);
		const b1 = openBatch();
		const b2 = openBatch();
		updateInBatch(b1, a, (x) => x + 10);
		updateInBatch(b2, a, (x) => x * 2);
		expect(read(a)).toBe(1);
		expect(latest(a)).toBe(22);
		retireBatch(b1);
		retireBatch(b2);
		expect(read(a)).toBe(22);
	});

	test('committed views: per-root pre-images clear at that root commit', () => {
		const a = atom(0);
		registerRoot('r1');
		registerRoot('r2');
		const s1 = subscribe(a, () => {}, { root: 'r1' });
		const s2 = subscribe(a, () => {}, { root: 'r2' });
		set(a, 1);
		expect(read(a)).toBe(1);
		expect(committed(a, 'r1')).toBe(0); // r1 has not committed the change
		expect(committed(a, 'r2')).toBe(0);
		rootCommitted('r1', currentGraphEpoch());
		expect(committed(a, 'r1')).toBe(1);
		expect(committed(a, 'r2')).toBe(0);
		rootCommitted('r2', currentGraphEpoch());
		expect(committed(a, 'r2')).toBe(1);
		s1.dispose();
		s2.dispose();
	});

	test('committed computed folds the view pre-images', () => {
		const a = atom(2);
		registerRoot('r1');
		const sub = subscribe(a, () => {}, { root: 'r1' });
		const c = computed(() => read(a) * 10);
		expect(read(c)).toBe(20);
		set(a, 5);
		expect(read(c)).toBe(50);
		expect(committed(c, 'r1')).toBe(20);
		rootCommitted('r1', currentGraphEpoch());
		expect(committed(c, 'r1')).toBe(50);
		sub.dispose();
	});

	test('isPending flips for atoms written in open batches, and downstream', () => {
		const a = atom(0);
		const c = computed(() => read(a) + 1);
		expect(read(c)).toBe(1);
		expect(isPending(a)).toBe(false);
		expect(isPending(c)).toBe(false);
		const b = openBatch();
		setInBatch(b, a, 3);
		expect(isPending(a)).toBe(true);
		expect(isPending(c)).toBe(true); // upstream draft: newer data on the way
		retireBatch(b);
		expect(isPending(a)).toBe(false);
		expect(isPending(c)).toBe(false);
	});
});

describe('lazy initializers', () => {
	test('runs once at first read, never at construction', () => {
		let runs = 0;
		const a = atom(() => {
			runs++;
			return 41;
		});
		expect(runs).toBe(0);
		expect(read(a)).toBe(41);
		expect(runs).toBe(1);
		read(a);
		expect(runs).toBe(1);
	});

	test('set before first read still runs the initializer (equality contract)', () => {
		let runs = 0;
		const a = atom(
			() => {
				runs++;
				return 10;
			},
			{ equals: (x, y) => x === y },
		);
		set(a, 10); // equal to the initialized base: dropped
		expect(runs).toBe(1);
		expect(read(a)).toBe(10);
		set(a, 11);
		expect(read(a)).toBe(11);
	});

	test('initializer is forbidden from writing', () => {
		const other = atom(0);
		const a = atom(() => {
			set(other, 1);
			return 0;
		});
		expect(() => read(a)).toThrow(/initializer/);
	});

	test('functional update materializes first, then replays', () => {
		const a = atom(() => 7);
		update(a, (x) => x + 1);
		expect(read(a)).toBe(8);
	});
});
