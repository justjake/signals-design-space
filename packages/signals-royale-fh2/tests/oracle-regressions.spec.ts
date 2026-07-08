/**
 * Named regressions pinned from oracle-fuzz catches. Each carries the seed
 * and the shrunk schedule that found it.
 */
import { describe, expect, test, beforeEach } from 'vitest';
import {
	__resetEngine,
	atom,
	computed,
	discardBatch,
	openBatch,
	read,
	readInWorld,
	retireBatch,
	set,
	setInBatch,
	subscribe,
	update,
	updateInBatch,
} from '../src/index';

beforeEach(() => {
	__resetEngine();
});

describe('oracle regressions', () => {
	test('seed 880 — a canonically-dropped urgent update still reshapes draft worlds (and wakes their readers)', () => {
		// set a=0; open B; draft set a=8; urgent update x2 (0*2 = 0: canonical
		// drop). The update joins the queue, so world[B] must fold it: 8*2.
		const a = atom(1);
		const c = computed(() => read(a) * 10);
		const deliveries: Array<number | null> = [];
		const sub = subscribe(c, (d) => deliveries.push(d.batch ? d.batch.id : null));
		set(a, 0);
		const b = openBatch();
		setInBatch(b, a, 8);
		expect(readInWorld(c, [b])).toBe(80); // caches the world value
		const before = deliveries.length;
		update(a, (x) => x * 2);
		expect(read(a)).toBe(0); // canonical unmoved
		expect(readInWorld(a, [b])).toBe(16); // queue replay: (0 -> 8) * 2
		expect(readInWorld(c, [b])).toBe(160); // world cache invalidated
		expect(deliveries.length).toBeGreaterThan(before); // draft readers woken
		retireBatch(b);
		expect(read(a)).toBe(16);
		sub.dispose();
	});

	test('seed 924 — retiring a canonical-no-op batch still invalidates sibling open worlds', () => {
		// Two open batches share an atom's queue. Retiring B2 (whose fold is a
		// canonical no-op: 0*2 = 0) turns its update canonical in place, which
		// changes B1's fold from set-3 to (set-3)*2.
		const a = atom(0);
		const b1 = openBatch();
		const b2 = openBatch();
		setInBatch(b1, a, 3);
		updateInBatch(b2, a, (x) => x * 2);
		expect(readInWorld(a, [b1])).toBe(3); // caches world [b1]
		retireBatch(b2); // canonical: 0*2 = 0 (no movement)
		expect(read(a)).toBe(0);
		expect(readInWorld(a, [b1])).toBe(6); // b2's op is canonical now
		retireBatch(b1);
		expect(read(a)).toBe(6);
	});

	test('discard of a queued op reshapes sibling open worlds too', () => {
		const a = atom(0);
		const b1 = openBatch();
		const b2 = openBatch();
		updateInBatch(b1, a, (x) => x + 1);
		updateInBatch(b2, a, (x) => x + 10);
		expect(readInWorld(a, [b2])).toBe(10);
		discardBatch(b1);
		expect(readInWorld(a, [b2])).toBe(10);
		retireBatch(b2);
		expect(read(a)).toBe(10);
	});

	test('seed 6 (first sweep) — sequential equality gating matches replay gating', () => {
		// A custom equality gates every fold step identically on the direct
		// canonical path and on queue replay.
		const a = atom<number>(0, { equals: (x, y) => x === y });
		update(a, (x) => x + 0); // no-op update: gated, no change, no throw
		expect(read(a)).toBe(0);
		const b = openBatch();
		updateInBatch(b, a, (x) => x + 0);
		retireBatch(b);
		expect(read(a)).toBe(0);
	});
});
