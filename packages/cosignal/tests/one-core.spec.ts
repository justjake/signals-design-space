/**
 * The One Core promise (always-concurrent form):
 *  - ONE public entry: `cosignal` exports the base API plus the concurrent
 *    engine's surface (attachDriver / engine / engine types); no
 *    `./concurrent` entry exists.
 *  - ZERO COST WHEN UNUSED, asserted behaviorally: the engine composes at
 *    module initialization, but with no driver attached and no batch ever
 *    opened, heavy create/write/read/effect traffic creates zero log
 *    entries, zero batches, zero world evaluations (the engine's
 *    referee-surface probes, `__coreProbes`; events are packed trace records
 *    behind per-site tracer guards — no tracer, no event machinery at all).
 *    Sync-only apps pay one predictable boolean check per public read/write
 *    and nothing else.
 *  - QUIET ≡ SYNC: while nothing is pending, public writes fold directly
 *    (committed base and the kernel advance together); once a batch is
 *    live, public writes to engine atoms classify into the ambient default
 *    batch as WHOLE ops (set/update — replay fidelity), and public reads
 *    inside a world evaluation serve that world's fold.
 *
 * NOTE: the driver slot is engine state and vitest isolates test FILES, so
 * the zero-cost tests run FIRST in this file; the driver-attach pins follow.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	__coreProbes,
	__resetEngineForTest,
	attachDriver,
	Atom,
	batch,
	BATCH_NONE,
	Computed,
	configure,
	effect,
	engine,
	ReducerAtom,
	untracked,
} from '../src/index.js';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('one entry', () => {
	it('package.json exposes exactly one library entry (plus trace/graphviz diagnostics)', () => {
		const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
			exports: Record<string, string>;
		};
		expect(Object.keys(pkg.exports).sort()).toEqual(['.', './graphviz', './trace']);
		expect(pkg.exports['.']).toBe('./src/index.ts');
	});
});

describe('zero cost with no driver attached (behavioral)', () => {
	it('heavy sync-only traffic creates zero log entries/batches/worlds', () => {
		const before = __coreProbes();
		// (No event probe anymore: events are packed trace records, created only
		// behind each site's tracer guard — the object channel is gone, so with
		// no tracer there is no event machinery left to count. `bridges` counts
		// COMPOSITIONS now: exactly one, the module-initialization compose —
		// always-concurrent means the engine exists, and the zero-cost promise
		// is that it never RUNS for plain traffic.)
		expect(before).toEqual({ logEntries: 0, batches: 0, worldEvals: 0, bridges: 1 });

		// Heavy create/write/read/derive/effect traffic through the public API.
		const atoms = Array.from({ length: 50 }, (_, i) => new Atom(i));
		const doubles = atoms.map((a) => new Computed(() => a.state * 2));
		const sum = new Computed(() => doubles.reduce((acc, d) => acc + d.state, 0));
		let effectRuns = 0;
		const dispose = effect(() => {
			void sum.state;
			effectRuns++;
		});
		const r = new ReducerAtom((s: number, action: number) => s + action, 0);
		let sink = 0;
		for (let round = 0; round < 20; round++) {
			batch(() => {
				for (let i = 0; i < atoms.length; i++) {
					atoms[i]!.set(round * 100 + i);
					atoms[i]!.update((v) => v + 1);
				}
				r.dispatch(1);
			});
			for (let i = 0; i < atoms.length; i++) {
				sink += doubles[i]!.state;
			}
			sink += untracked(() => sum.state) + r.state;
		}
		dispose();

		expect(sink).not.toBe(0); // the traffic really ran
		expect(effectRuns).toBeGreaterThan(1);
		expect(__coreProbes()).toEqual(before); // NOTHING concurrent ever executed
	});
});

describe('always-concurrent, quiet: sync semantics preserved', () => {
	it('attachDriver installs exactly once; the reset clears the slot (the driver-attach pins)', () => {
		const minimal = { currentBatch: () => BATCH_NONE, worldFor: () => undefined };
		attachDriver(minimal);
		expect(() => attachDriver(minimal)).toThrow(/already attached/); // one driver per composition
		expect(__coreProbes().bridges).toBe(1); // attach composes nothing — the module composition is the one
		__resetEngineForTest(); // clears the driver slot (and everything else)
		attachDriver(minimal); // a fresh composition accepts a fresh driver
		expect(() => attachDriver(minimal)).toThrow(/already attached/);
		__resetEngineForTest(); // leave the rest of the file driver-less (quiet ≡ sync)
	});

	it('plain atoms/computeds/effects behave exactly as sync (values, laziness, batching)', () => {
		const a = new Atom(1);
		const b = new Atom(2);
		let pulls = 0;
		const sum = new Computed(() => {
			pulls++;
			return a.state + b.state;
		});
		expect(sum.state).toBe(3);
		expect(pulls).toBe(1);
		expect(sum.state).toBe(3);
		expect(pulls).toBe(1); // cached — no spurious recompute under the always-live engine
		const seen: number[] = [];
		const dispose = effect(() => {
			seen.push(sum.state);
		});
		const entriesBefore = __coreProbes().logEntries;
		batch(() => {
			a.set(10);
			b.set(20);
		});
		expect(seen).toEqual([3, 30]); // one flush at batch close, exactly as sync
		expect(untracked(() => sum.state)).toBe(30);
		expect(__coreProbes().logEntries).toBe(entriesBefore); // quiet: no log entries
		dispose();
	});

	it('zero batches: content-less traffic still does zero log entry/world work', () => {
		const before = __coreProbes();
		const a = new Atom(0);
		const c = new Computed(() => a.state + 1);
		let sink = 0;
		const dispose = effect(() => {
			sink += c.state;
		});
		for (let i = 0; i < 1000; i++) {
			a.set(i);
			a.update((v) => v + 1);
			sink += c.state;
		}
		dispose();
		expect(sink).toBeGreaterThan(0);
		const after = __coreProbes();
		expect(after.logEntries).toBe(before.logEntries);
		expect(after.batches).toBe(before.batches);
		expect(after.worldEvals).toBe(before.worldEvals);
	});

	it('update/dispatch fold purity still throws through the POISON table', () => {
		const a = new Atom(1);
		const r = new ReducerAtom((s: number, action: number) => s + action, 0);
		expect(() => a.update(() => a.state + 1)).toThrow(/not allowed inside an update/);
		r.dispatch(5);
		expect(r.state).toBe(5);
	});

	it('public writes to an ENGINE atom: QUIET folds directly; ARMED classifies into the ambient default batch with WHOLE ops', () => {
		// While nothing is pending the pipeline stays disarmed and the write
		// folds to committed base + kernel in one step (Phase 1b semantics,
		// unchanged by the merge).
		const la = engine.atom('pub', 0);
		const before = __coreProbes();
		la.handle.set(7); // application code writing through the public API, while QUIET
		(la.handle as Atom<number>).update((n) => n + 1);
		expect(la.log.materialize()).toHaveLength(0); // no log entry
		expect(engine.ambientBatch).toBeUndefined(); // ambient batch NOT created while quiet
		expect(engine.newestValue(la)).toBe(8); // kernel advanced
		expect(engine.committedValue(la, 'A')).toBe(8); // committed truth advanced WITH it
		const afterQuiet = __coreProbes();
		expect(afterQuiet.logEntries).toBe(before.logEntries);
		expect(afterQuiet.batches).toBe(before.batches);
		// ARM the pipeline (a live batch exists): the same public writes now
		// classify into the ambient default batch as WHOLE ops.
		const t = engine.openBatch();
		la.handle.set(100);
		(la.handle as Atom<number>).update((n) => n + 1); // op captured UNFOLDED
		expect(la.log.materialize()).toHaveLength(2);
		expect(la.log.materialize()[0]!.op).toEqual({ kind: 'set', value: 100 });
		expect(la.log.materialize()[1]!.op.kind).toBe('update'); // replay fidelity: the updater itself
		const ambient = engine.ambientBatch;
		expect(ambient).toBeDefined();
		expect(la.log.materialize()[0]!.batch).toBe(ambient);
		expect(engine.newestValue(la)).toBe(101); // writes apply to the kernel immediately
		expect(engine.committedValue(la, 'A')).toBe(8); // not committed yet: base still holds the quiet fold
		engine.retire(ambient!);
		expect(engine.committedValue(la, 'A')).toBe(101); // persistence never depends on subscription
		engine.retire(t.id); // last retirement: quiet re-arms
		expect(la.log.materialize()).toHaveLength(0); // pin-free retirement compacts the prefix
		la.handle.set(500); // and the next write folds again
		expect(la.log.materialize()).toHaveLength(0);
		expect(engine.committedValue(la, 'A')).toBe(500);
	});

	it('zero-cost probes: heavy ENGINE-atom writes, no transitions — zero log entries/batches', () => {
		// The Phase 1b population: atoms WITH engine content, kernel
		// derivations and effects subscribed — and NO transition, batch, or
		// render pass ever open. Heavy public write/read traffic must leave
		// the concurrency pipeline fully disarmed: zero log entries, zero
		// batches (and with no tracer attached, every record site is one dead
		// branch).
		const atoms = Array.from({ length: 20 }, (_, i) => engine.atom(`reg${i}`, i));
		const handles = atoms.map((n) => n.handle as Atom<number>);
		const doubles = handles.map((h) => new Computed(() => h.state * 2));
		let effectRuns = 0;
		const dispose = effect(() => {
			void doubles[0]!.state;
			effectRuns++;
		});
		const rHandle = new ReducerAtom<number, number>((s, a) => s + a, 0);
		const r = engine.nodeForAtom(rHandle as unknown as Atom<number>);
		r.name = 'regReducer';
		// No reducer wiring: dispatch records as an update whose closure carries the reducer.
		const before = __coreProbes();
		let sink = 0;
		for (let round = 0; round < 50; round++) {
			for (let i = 0; i < handles.length; i++) {
				handles[i]!.set(round * 1000 + i);
				handles[i]!.update((v) => v + 1);
			}
			rHandle.dispatch(1);
			for (let i = 0; i < doubles.length; i++) sink += doubles[i]!.state;
		}
		dispose();
		expect(sink).not.toBe(0);
		expect(effectRuns).toBeGreaterThan(1); // kernel effects observed the quiet folds
		const after = __coreProbes();
		expect(after.logEntries).toBe(before.logEntries); // ZERO log entries
		expect(after.batches).toBe(before.batches); // ZERO batches (no ambient create)
		expect(engine.ambientBatch).toBeUndefined();
		// And the folds are real: base == kernel == committed for every atom.
		expect(engine.newestValue(atoms[3]!)).toBe(49 * 1000 + 3 + 1);
		expect(engine.committedValue(atoms[3]!, 'A')).toBe(49 * 1000 + 3 + 1);
		expect(engine.committedValue(r, 'A')).toBe(50);
	});

	it('standalone-era atoms join as committed-only base state (the node-less arm)', () => {
		const handle = new Atom(41);
		handle.set(42); // standalone history: the node-less arm (plain graph write)
		const la = engine.nodeForAtom(handle); // content allocates; base seeds from kernel-current
		la.name = 'joined';
		expect(la.base).toBe(42);
		expect(la.log.materialize()).toHaveLength(0);
		expect(engine.committedValue(la, 'A')).toBe(42);
	});

	it('replayed updaters run under the fold guard: raw reads inside them throw, and nothing records', () => {
		const la = engine.atom('pure', 1);
		const handle = la.handle as Atom<number>;
		expect(() => handle.update((n) => n + (handle.state as number))).toThrow(/not allowed inside an update/);
		expect(la.log.materialize()).toHaveLength(0); // the rejected write left no log entry
		expect(engine.newestValue(la)).toBe(1); // and no kernel mutation
	});

	it('forbidWritesInComputeds rejects engine writes BEFORE any log entry lands', () => {
		configure({ forbidWritesInComputeds: true });
		try {
			const la = engine.atom('guarded', 0);
			const probe = new Computed(() => {
				(la.handle as Atom<number>).set(9); // engine write during a computed evaluation
				return 1;
			});
			expect(() => probe.state).toThrow(/writes inside computeds are forbidden/);
			expect(la.log.materialize()).toHaveLength(0); // policy first, capture second: no log entry behind the throw
			expect(engine.newestValue(la)).toBe(0);
		} finally {
			configure({ forbidWritesInComputeds: false });
		}
	});

	it('public reads of an engine atom inside an overlay world evaluation serve the world fold', () => {
		const la = engine.atom('routed', 0);
		const viaHandle = engine.computed('viaHandle', () => la.handle.state as number); // NOT the reader — the public API
		const t = engine.openBatch();
		engine.write(t.id, la, 0, 5);
		expect(engine.newestValue(viaHandle)).toBe(5); // newest = kernel arena
		const p = engine.renderStart('A', []); // t excluded
		expect(engine.renderValue(viaHandle, p)).toBe(0); // the world evaluation routes the public read: the excluded batch stays invisible
		engine.renderEnd(p.id, 'discard');
		engine.retire(t.id);
		expect(engine.committedValue(viaHandle, 'A')).toBe(5);
	});

	it('growth with the engine live carries state through the closure rebuild', () => {
		const before = new Atom(123);
		// Force a kernel growth boundary: raise the capacity floor past the
		// current arena, then cross an operation boundary (the write) — the
		// closure rebuild swaps buffers under the live engine.
		const bump = new Atom(0);
		configure({ initialRecords: 1 << 21 });
		bump.set(1);
		expect(before.state).toBe(123); // carried buffers intact across rebuild(s)
	});
});
