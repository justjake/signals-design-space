// §18 — the perf gate harness (what is measurable without React).
// Run with: PERF=1 vitest run test/perf.test.ts
//
// Measured gates:
//   G-6a  first logged write (tape creation + mark-only cone walk), cone
//         sizes 10/100/1000, vs a DIRECT write to the same graph — plus the
//         IDLE-WRITE STREAMING-STORE workload that prices the A-vs-B gate
//         decision: variant B's loose contract keeps idle writes DIRECT;
//         an always-logged gate (variant A's activation / strictLanes) pays
//         log + mint + retire + absorb + reset per event.
//   G-6b  steady logged urgent write (tape exists, coalescing) vs DIRECT.
//   G-7   deferred write drain (walk + writer's-world decisions + chain
//         re-validation), fan-out 10/100/1000 watchers, vs DIRECT fan-out.
//   G-8   held-open transition: hot NEWEST read of the marked cone
//         (memo-hit path; certificate scan lengths 1/4/16) vs DIRECT read.
//   G-19  tier-0-ish episode traced (RING and SESSION) vs untraced.
//
// Loose sanity ceilings only (10x the spec gates) so noise never fails CI;
// the printed numbers are the report.
import { describe, expect, it } from 'vitest';
import {
	Atom,
	Computed,
	ForkDouble,
	__debug,
	__resetEngineForTests,
	attachFork,
	createWatcher,
} from '../src/index';
import { startTracing, stopTracing } from '../src/trace';

const PERF = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
	?.env?.PERF === '1';

const results: string[] = [];

function report(line: string): void {
	results.push(line);
	// The default vitest reporter swallows console output; write the report
	// file directly so measurements survive any reporter.
	void import('node:fs').then((fs) => {
		fs.appendFileSync('/tmp/altb-perf.txt', `PERF ${line}\n`);
	});
	(globalThis as { console?: { log(m: string): void } }).console?.log(`PERF ${line}`);
}

const nowMs = (): number =>
	(globalThis as { performance?: { now(): number } }).performance?.now() ?? Date.now();

/** ns/op, best of `rounds` timed batches after one warmup batch. */
function bench(fn: () => void, iters: number, rounds = 5): number {
	fn(); // warmup shape
	for (let i = 0; i < Math.min(iters, 1000); ++i) {
		fn();
	}
	let best = Infinity;
	for (let r = 0; r < rounds; ++r) {
		const t0 = nowMs();
		for (let i = 0; i < iters; ++i) {
			fn();
		}
		const t1 = nowMs();
		best = Math.min(best, ((t1 - t0) * 1e6) / iters);
	}
	return best;
}

function setup(): ForkDouble {
	__resetEngineForTests();
	const fork = new ForkDouble();
	attachFork(fork);
	return fork;
}

/** 1 atom → `cone` watched computeds. */
function buildCone(a: Atom<number>, cone: number): Computed<number>[] {
	const cs: Computed<number>[] = [];
	for (let i = 0; i < cone; ++i) {
		const c = new Computed({ fn: () => a.state + i });
		void c.state;
		createWatcher(c, () => {});
		cs.push(c);
	}
	return cs;
}

describe.skipIf(!PERF)('§18 perf gates (PERF=1)', () => {
	it('G-6a: idle-write streaming store — the A-vs-B gate price', () => {
		// Variant B loose default: React fully idle → DIRECT writes.
		let fork = setup();
		void fork;
		const a = new Atom({ state: 0 });
		const c = new Computed({ fn: () => a.state + 1 });
		void c.state;
		createWatcher(c, () => {});
		let v = 0;
		const direct = bench(() => {
			a.set(++v);
		}, 50_000);
		expect(__debug.isDirect()).toBe(true);
		expect(__debug.stats().gNext).toBe(4); // zero overlay instructions

		// Always-logged gate (variant A activation / strictLanes): each idle
		// event pays mint + log + tape lifecycle + retire + absorb + reset.
		const fork2 = setup();
		const a2 = new Atom({ state: 0 });
		const c2 = new Computed({ fn: () => a2.state + 1 });
		void c2.state;
		createWatcher(c2, () => {});
		let v2 = 0;
		const logged = bench(() => {
			const t = fork2.openBatch(false);
			fork2.inBatch(t, () => a2.set(++v2));
			fork2.retireBatch(t, true);
		}, 5_000);
		report(
			`G-6a idle-stream: DIRECT ${direct.toFixed(0)} ns/write; always-logged event ${logged.toFixed(0)} ns/write; ratio ${(logged / direct).toFixed(1)}x`,
		);
		expect(logged / direct).toBeLessThan(500); // sanity only
	});

	it('G-6a: tape creation + mark-only cone walk across cone sizes', () => {
		for (const cone of [10, 100, 1000]) {
			const fork = setup();
			const a = new Atom({ state: 0 });
			buildCone(a, cone);
			let v = 0;
			// DIRECT write to the same graph (idle):
			const direct = bench(() => {
				a.set(++v);
			}, cone >= 1000 ? 1_000 : 5_000);
			// Tape-creating write: one per era — force a fresh era per iteration
			// (open batch → first write creates tape + walks the cone → retire
			// → absorb → sweep → quiescence reset).
			const create = bench(
				() => {
					const t = fork.openBatch(true);
					fork.inBatch(t, () => a.set(++v));
					fork.retireBatch(t, true);
				},
				cone >= 1000 ? 100 : 500,
				3,
			);
			report(
				`G-6a tape-create cone=${cone}: DIRECT ${direct.toFixed(0)} ns; create-era ${create.toFixed(0)} ns; ratio ${(create / direct).toFixed(1)}x`,
			);
		}
	});

	it('G-6b: steady logged urgent write (coalescing tape) vs DIRECT — spec gate 2x', () => {
		const fork = setup();
		const a = new Atom({ state: 0 });
		const c = new Computed({ fn: () => a.state + 1 });
		void c.state;
		createWatcher(c, () => {});
		let v = 0;
		const direct = bench(() => {
			a.set(++v);
		}, 50_000);
		// Hold one urgent batch open; steady same-batch urgent writes coalesce.
		const t = fork.openBatch(false);
		const keepAlive = fork.openBatch(true); // keeps LOGGED even at sweep
		void keepAlive;
		fork.inBatch(t, () => a.set(++v)); // tape creation, once
		const steady = bench(() => {
			fork.inBatch(t, () => a.set(++v));
		}, 30_000);
		report(
			`G-6b steady logged urgent: DIRECT ${direct.toFixed(0)} ns; logged ${steady.toFixed(0)} ns; ratio ${(steady / direct).toFixed(2)}x (spec gate ≤2x)`,
		);
		expect(steady / direct).toBeLessThan(20); // sanity only
	});

	it('G-7: deferred write drain across fan-outs — provisional ceiling 3x', () => {
		for (const fanout of [10, 100, 1000]) {
			// DIRECT fan-out baseline:
			setup();
			const a0 = new Atom({ state: 0 });
			buildCone(a0, fanout);
			let v0 = 0;
			const direct = bench(() => {
				a0.set(++v0);
			}, fanout >= 1000 ? 300 : 3_000, 3);
			// Deferred fan-out: walk + writer's-world decisions + revalidation.
			const fork = setup();
			const a = new Atom({ state: 0 });
			buildCone(a, fanout);
			const t = fork.openBatch(true);
			let v = 0;
			fork.inBatch(t, () => a.set(++v));
			const deferred = bench(() => {
				fork.inBatch(t, () => a.set(++v));
			}, fanout >= 1000 ? 300 : 3_000, 3);
			report(
				`G-7 deferred drain fanout=${fanout}: DIRECT ${direct.toFixed(0)} ns; deferred ${deferred.toFixed(0)} ns; ratio ${(deferred / direct).toFixed(2)}x (provisional ceiling 3x)`,
			);
		}
	});

	it('G-8: held-open transition, hot NEWEST reads over the marked cone — spec gate 1.5x', () => {
		for (const certLen of [1, 4, 16]) {
			// DIRECT read baseline: same shape, no overlay.
			setup();
			const atoms0 = Array.from({ length: certLen }, (_, i) => new Atom({ state: i }));
			const c0 = new Computed({ fn: () => atoms0.reduce((s, x) => s + x.state, 0) });
			void c0.state;
			const direct = bench(() => {
				void c0.state;
			}, 100_000);
			// Marked cone: a held-open transition wrote one of the atoms.
			const fork = setup();
			const atoms = Array.from({ length: certLen }, (_, i) => new Atom({ state: i }));
			const c = new Computed({ fn: () => atoms.reduce((s, x) => s + x.state, 0) });
			void c.state;
			const t = fork.openBatch(true);
			fork.inBatch(t, () => atoms[0].set(100)); // marks the cone; unapplied
			const marked = bench(() => {
				void c.state; // NEWEST read: memo hit + certificate scan
			}, 50_000);
			report(
				`G-8 marked-cone read certLen=${certLen}: DIRECT ${direct.toFixed(0)} ns; marked ${marked.toFixed(0)} ns; ratio ${(marked / direct).toFixed(2)}x (spec gate ≤1.5x)`,
			);
			fork.retireBatch(t, true);
		}
	});

	it('G-19: tracing overhead (RING and SESSION) vs untraced — spec gate 1.15x', () => {
		const episode = (fork: ForkDouble, a: Atom<number>, v: number): void => {
			const t = fork.openBatch(true);
			fork.inBatch(t, () => a.set(v));
			fork.startRenderPass('root', [t]);
			fork.endRenderPass();
			fork.retireBatch(t, true);
		};
		let fork = setup();
		let a = new Atom({ state: 0 });
		const c1 = new Computed({ fn: () => a.state + 1 });
		void c1.state;
		createWatcher(c1, () => {});
		let i = 0;
		const untraced = bench(() => episode(fork, a, ++i), 3_000);

		fork = setup();
		a = new Atom({ state: 0 });
		const c2 = new Computed({ fn: () => a.state + 1 });
		void c2.state;
		createWatcher(c2, () => {});
		startTracing({ mode: 'ring', capacity: 1 << 16 });
		i = 0;
		const ring = bench(() => episode(fork, a, ++i), 3_000);
		stopTracing();

		fork = setup();
		a = new Atom({ state: 0 });
		const c3 = new Computed({ fn: () => a.state + 1 });
		void c3.state;
		createWatcher(c3, () => {});
		startTracing({ mode: 'session', chunkSize: 1 << 12, maxBytes: 1 << 30 });
		i = 0;
		const session = bench(() => episode(fork, a, ++i), 3_000);
		stopTracing();

		report(
			`G-19 tracing: untraced ${untraced.toFixed(0)} ns/episode; RING ${ring.toFixed(0)} (${(ring / untraced).toFixed(2)}x, gate ≤1.15x); SESSION ${session.toFixed(0)} (${(session / ring).toFixed(2)}x of RING, gate: within noise)`,
		);
		expect(ring / untraced).toBeLessThan(5); // sanity only
	});
});

describe.skipIf(PERF)('perf harness placeholder', () => {
	it('is skipped unless PERF=1 (measurements are a report, not a CI gate)', () => {
		expect(true).toBe(true);
	});
});
