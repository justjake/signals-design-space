// M6 — packed tracing (§16.2): choke-point coverage, ring overwrite + drop
// counter, SESSION sealed chunks + provable losslessness + loud truncation
// (the G-20/G-21 gates' structural test forms; G-19's timing form lives in
// the perf harness).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	Atom,
	Computed,
	ForkDouble,
	__resetEngineForTests,
	attachFork,
	createWatcher,
} from '../src/index';
import { PackedTracer, startTracing, stopTracing } from '../src/trace';

let fork: ForkDouble;

beforeEach(() => {
	__resetEngineForTests();
	fork = new ForkDouble();
	attachFork(fork);
});

afterEach(() => {
	stopTracing();
});

function runEpisode(): void {
	const a = new Atom({ state: 0 });
	const c = new Computed({ fn: () => a.state + 1 });
	expect(c.state).toBe(1);
	createWatcher(c, () => {});
	const k = fork.openBatch(true);
	fork.inBatch(k, () => a.set(1));
	fork.inBatch(k, () => a.set(2)); // coalesces
	fork.startRenderPass('root', [k]);
	expect(c.state).toBe(3);
	fork.endRenderPass();
	fork.retireBatch(k, true);
}

describe('choke-point coverage and causality', () => {
	it('records the write→walk→broadcast→retire→absorb→quiescence chain', () => {
		const t = startTracing({ mode: 'ring', capacity: 1 << 10 });
		runEpisode();
		const kinds = t.events().map((e) => e.kindName);
		for (const expected of [
			'atom-write',
			'log-append',
			'log-coalesce',
			'notify-walk',
			'broadcast',
			'computed-eval',
			'render-pass-start',
			'render-pass-end',
			'batch-retired',
			'absorb',
			'quiescence',
		]) {
			expect(kinds, `missing ${expected}`).toContain(expected);
		}
		// Causality: the notify-walk's CAUSE is the write that provoked it.
		const walk = t.events().find((e) => e.kindName === 'notify-walk')!;
		const chain = t.causeChain(walk.id);
		expect(chain[chain.length - 1].kindName).toBe('atom-write');
		// The absorb's CAUSE is the retirement.
		const absorb = t.events().find((e) => e.kindName === 'absorb')!;
		expect(t.decode(absorb.cause)?.kindName).toBe('batch-retired');
	});

	it('memo hits are flagged on computed-eval events', () => {
		const t = startTracing({ mode: 'ring', capacity: 1 << 10 });
		const a = new Atom({ state: 0 });
		const c = new Computed({ fn: () => a.state + 1 });
		expect(c.state).toBe(1);
		const k = fork.openBatch(true);
		fork.inBatch(k, () => a.set(5));
		const readTwice = () => {
			fork.startRenderPass('root', [k]);
			expect(c.state).toBe(6);
			expect(c.state).toBe(6);
			fork.endRenderPass();
		};
		readTwice();
		const evals = t.events().filter((e) => e.kindName === 'computed-eval');
		expect(evals.some((e) => e.args[0] === 0)).toBe(true); // a real evaluation
		expect(evals.some((e) => e.args[0] === 1)).toBe(true); // a memo hit
		fork.retireBatch(k, true);
	});
});

describe('RING mode (G-20 structural form)', () => {
	it('records with zero buffer growth; overwrite is detectable via the drop counter', () => {
		const t = startTracing({ mode: 'ring', capacity: 1 << 4 }); // 16 records
		const bytesBefore = t.stats().bytes;
		for (let i = 0; i < 100; ++i) {
			runEpisode();
			__resetEngineForTests();
			fork = new ForkDouble();
			attachFork(fork);
		}
		expect(t.stats().bytes).toBe(bytesBefore); // no allocation ever
		expect(t.droppedBefore()).toBe(t.eventCount() - 16);
		// Overwritten ids decode to undefined; live ids decode.
		expect(t.decode(1)).toBeUndefined();
		expect(t.decode(t.lastId())).toBeDefined();
		// Ids are dense and monotonic: the live tail is exactly the capacity.
		expect(t.events().length).toBe(16);
	});
});

describe('SESSION mode (G-21)', () => {
	it('is provably lossless below maxBytes: one gap-free id range', () => {
		const t = startTracing({ mode: 'session', chunkSize: 1 << 4, maxBytes: 1 << 20 });
		for (let i = 0; i < 10; ++i) {
			runEpisode();
			__resetEngineForTests();
			fork = new ForkDouble();
			attachFork(fork);
		}
		const v = t.verifyComplete();
		expect(v.complete).toBe(true);
		expect(v.from).toBe(1);
		expect(v.to).toBe(t.lastId());
		expect(v.truncatedAt).toBeUndefined();
		expect(t.events().length).toBe(t.eventCount());
		// Chunk allocation is amortized: one chunk per chunkSize of id space.
		expect(t.stats().chunks).toBe((t.lastId() >> 4) + 1);
	});

	it('sealed chunks are immutable and stream-decodable during recording', () => {
		const t = startTracing({ mode: 'session', chunkSize: 1 << 4, maxBytes: 1 << 20 });
		runEpisode();
		while (t.sealedChunks().length < 2) {
			__resetEngineForTests();
			fork = new ForkDouble();
			attachFork(fork);
			runEpisode();
		}
		// Snapshot the sealed chunks and some decoded events mid-recording.
		const sealed = t.sealedChunks().map((c) => c.slice());
		const early = Array.from({ length: 16 }, (_, i) => t.decode(i + 1));
		// Keep recording.
		__resetEngineForTests();
		fork = new ForkDouble();
		attachFork(fork);
		runEpisode();
		// The sealed bytes did not move, and the early events decode identically.
		const after = t.sealedChunks();
		for (let i = 0; i < sealed.length; ++i) {
			expect([...after[i]]).toEqual([...sealed[i]]);
		}
		for (let i = 0; i < 16; ++i) {
			expect(t.decode(i + 1)).toEqual(early[i]);
		}
	});

	it('a maxBytes breach emits a loud truncation-marker and degrades to ring', () => {
		// 2 chunks of 16 records = 2 * 16 * 8 * 4 bytes; cap there.
		const t = startTracing({
			mode: 'session',
			chunkSize: 1 << 4,
			maxBytes: 2 * 16 * 8 * 4,
		});
		for (let i = 0; i < 12; ++i) {
			runEpisode();
			__resetEngineForTests();
			fork = new ForkDouble();
			attachFork(fork);
		}
		expect(t.stats().truncated).toBe(true);
		expect(t.truncationMarkerId).toBeGreaterThanOrEqual(0);
		const v = t.verifyComplete();
		expect(v.truncatedAt).toBe(t.truncationMarkerId);
		expect(v.complete).toBe(true); // gap-free up to the sealed boundary
		// Recording continued after the breach (recent events keep flowing).
		expect(t.lastId()).toBeGreaterThan(t.truncationMarkerId);
		expect(t.decode(t.lastId())).toBeDefined();
		// No chunk was allocated past the cap.
		expect(t.stats().bytes).toBeLessThanOrEqual(2 * 16 * 8 * 4);
	});
});

describe('tracer slot lifecycle (§16.1)', () => {
	it('uninstalling stops recording; the engine works identically', () => {
		const t = startTracing({ mode: 'ring', capacity: 1 << 8 });
		runEpisode();
		const n = t.eventCount();
		expect(n).toBeGreaterThan(0);
		stopTracing();
		__resetEngineForTests();
		fork = new ForkDouble();
		attachFork(fork);
		runEpisode(); // no tracer: must not throw, no recording
		expect(t.eventCount()).toBe(n);
	});

	it('a fresh PackedTracer is directly usable as an engine tracer', () => {
		const t = new PackedTracer({ mode: 'ring', capacity: 1 << 4 });
		const id0 = t.emit(1, 0, 42, 7, 1, 2, 3);
		expect(id0).toBe(1); // ids are 1-based: CAUSE 0 means root
		expect(t.decode(1)).toMatchObject({ kind: 1, node: 42, world: 7, args: [1, 2, 3] });
	});
});
