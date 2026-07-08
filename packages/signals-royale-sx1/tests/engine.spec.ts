import { expect, test } from 'vitest';
import {
	atom,
	commitRoot,
	committed,
	computed,
	initializeAtomState,
	latest,
	read,
	serializeAtomState,
	subscribe,
	trace,
	retireBatch,
	type BatchToken,
} from '../src/index.js';

test('lazy initializers run once at first materialization and before set', () => {
	let calls = 0;
	const first = atom(() => ++calls);
	expect(calls).toBe(0);
	expect(read(first)).toBe(1);
	expect(read(first)).toBe(1);
	const second = atom(() => ++calls);
	second.set(10);
	expect(calls).toBe(2);
	expect(read(second)).toBe(10);
});

test('installing serialized state does not run a lazy initializer', () => {
	const server = atom(7, { label: 'count' });
	const json = serializeAtomState([server as ReturnType<typeof atom<unknown>>]);
	let calls = 0;
	const client = atom(() => ++calls, { label: 'count' });
	initializeAtomState(json, [client as ReturnType<typeof atom<unknown>>]);
	expect(calls).toBe(0);
	expect(read(client)).toBe(7);
});

test('lifetime observations coalesce subscription flaps', async () => {
	let starts = 0;
	let stops = 0;
	const value = atom(1, { effect: () => {
		starts++;
		return () => { stops++; };
	} });
	const first = subscribe(value, () => {});
	first();
	const second = subscribe(value, () => {});
	await Promise.resolve();
	expect({ starts, stops }).toEqual({ starts: 1, stops: 0 });
	second();
	await Promise.resolve();
	expect({ starts, stops }).toEqual({ starts: 1, stops: 1 });
});

test('a lazy initializer is untracked and cannot write', () => {
	const target = atom(0);
	const invalid = atom(() => {
		target.set(1);
		return 2;
	});
	expect(() => invalid.read()).toThrow('must not write');
});

test('the bounded causality log links delivery to its write', () => {
	const value = atom(0);
	const log = trace(3);
	value.set(1);
	expect(log.whyLastDelivery(value)).toEqual([
		expect.stringMatching(/^delivery#/),
		expect.stringMatching(/^write#/),
	]);
	value.set(2);
	expect(log.events()[0]?.kind).toMatch(/^overflow:/);
	log.stop();
});

test('an async evaluation registers independent pending reads before parking', () => {
	let first!: (value: number) => void;
	let second!: (value: number) => void;
	const a = new Promise<number>(resolve => { first = resolve; });
	const b = new Promise<number>(resolve => { second = resolve; });
	let reads = 0;
	const value = computed(use => {
		reads++;
		return use(a) + use(b);
	});
	let thrown: unknown;
	try { value.read(); } catch (error) { thrown = error; }
	expect(thrown).toBeInstanceOf(Promise);
	expect(reads).toBe(1);
	first(1);
	second(2);
});

test('computed caches do not collapse canonical, latest, and root worlds', () => {
	const source = atom(1);
	const value = computed(() => source.read() * 10);
	const token: BatchToken = { id: 7, deferred: true, live: true, committed: false };
	const root = {};
	expect(value.read()).toBe(10);
	source.set(2, token);
	expect(latest(value)).toBe(20);
	expect(value.read()).toBe(10);
	commitRoot(root, [token]);
	expect(committed(value, root)).toBe(20);
	expect(value.read()).toBe(10);
	retireBatch(token, true);
	expect(value.read()).toBe(20);
});
