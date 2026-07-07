/**
 * The One Core promise (replaces the old twin-build spec):
 *  - ONE public entry: `cosignal` exports the base API plus the concurrent
 *    engine's surface (registerReactBridge / CosignalBridge / bridge types);
 *    no `./concurrent` entry exists.
 *  - ZERO COST WHEN UNUSED, asserted behaviorally: with no host attached,
 *    heavy create/write/read/effect traffic mints zero receipts, zero batch
 *    batches, zero world evaluations, zero bridges (the engine's
 *    referee-surface probes, `__coreProbes`; events are packed trace records
 *    behind per-site tracer guards — no tracer, no event machinery at all).
 *    Sync-only apps pay one predictable branch per public read/write and
 *    nothing else.
 *  - ATTACHED BUT QUIET ≡ SYNC: registering the bridge preserves direct
 *    semantics for everything not bridge-registered, while public writes to
 *    REGISTERED atoms classify into the ambient default batch as WHOLE ops
 *    (set/update — replay fidelity), and public reads of registered
 *    atoms inside a world evaluation serve that world's fold.
 *
 * NOTE: attaching is process-wide and vitest isolates test FILES, so the
 * zero-cost tests run FIRST in this file; the attach tests follow.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	__coreProbes,
	__newBridgeForTest,
	Atom,
	batch,
	Computed,
	configure,
	effect,
	ReducerAtom,
	registerReactBridge,
	untracked,
	type CosignalBridge,
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

describe('zero cost with no host attached (behavioral)', () => {
	it('heavy sync-only traffic mints zero receipts/batches/worlds/bridges', () => {
		const before = __coreProbes();
		// (No event probe anymore: events are packed trace records, minted only
		// behind each site's tracer guard — the object channel is gone, so with
		// no tracer there is no event machinery left to count.)
		expect(before).toEqual({ receipts: 0, batches: 0, worldEvals: 0, bridges: 0 });

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

describe('host attached but quiet: sync semantics preserved', () => {
	let bridge: CosignalBridge;

	it('registerReactBridge attaches exactly once (constructs the one bridge)', () => {
		bridge = registerReactBridge();
		expect(() => bridge.registerBridge()).toThrow(/already registered/); // the returned bridge IS registered
		expect(__coreProbes().bridges).toBe(1);
		expect(() => registerReactBridge()).toThrow(/only be called once/);
	});

	it('unregistered atoms/computeds/effects behave exactly as sync (values, laziness, batching)', () => {
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
		expect(pulls).toBe(1); // cached — no spurious recompute with the host armed
		const seen: number[] = [];
		const dispose = effect(() => {
			seen.push(sum.state);
		});
		const receiptsBefore = __coreProbes().receipts;
		batch(() => {
			a.set(10);
			b.set(20);
		});
		expect(seen).toEqual([3, 30]); // one flush at batch close, exactly as sync
		expect(untracked(() => sum.state)).toBe(30);
		expect(__coreProbes().receipts).toBe(receiptsBefore); // unregistered: no receipts
		dispose();
	});

	it('host attached, zero batches: unregistered traffic still does zero receipt/world work', () => {
		// The harness cosignal-concurrent adapter's gate, in-package: attached-idle
		// semantics ≡ sync semantics, and the probes prove no concurrent
		// machinery ran for plain traffic.
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
		expect(after.receipts).toBe(before.receipts);
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

	it('public writes to a REGISTERED atom: QUIET folds directly; ARMED classifies into the ambient default batch with WHOLE ops', () => {
		// RE-PINNED for Phase 1b (quiet-mode writes). The old contract —
		// attached-but-quiet registered writes always mint ambient receipts —
		// is gone: while nothing is pending the pipeline stays disarmed and
		// the write folds to committed base + kernel in one step.
		const la = bridge.atom('pub', 0);
		const before = __coreProbes();
		la.handle.set(7); // application code writing through the public API, while QUIET
		(la.handle as Atom<number>).update((n) => n + 1);
		expect(la.tp.materialize()).toHaveLength(0); // no receipt
		expect(bridge.ambientBatch).toBeUndefined(); // ambient batch NOT minted while quiet
		expect(bridge.newestValue(la)).toBe(8); // kernel advanced
		expect(bridge.committedValue(la, 'A')).toBe(8); // committed truth advanced WITH it
		const afterQuiet = __coreProbes();
		expect(afterQuiet.receipts).toBe(before.receipts);
		expect(afterQuiet.batches).toBe(before.batches);
		// ARM the pipeline (a live batch exists): the same public writes now
		// classify into the ambient default batch as WHOLE ops.
		const t = bridge.openBatch();
		la.handle.set(100);
		(la.handle as Atom<number>).update((n) => n + 1); // op captured UNFOLDED
		expect(la.tp.materialize()).toHaveLength(2);
		expect(la.tp.materialize()[0]!.op).toEqual({ kind: 'set', value: 100 });
		expect(la.tp.materialize()[1]!.op.kind).toBe('update'); // replay fidelity: the updater itself
		const ambient = bridge.ambientBatch;
		expect(ambient).toBeDefined();
		expect(la.tp.materialize()[0]!.batch).toBe(ambient);
		expect(bridge.newestValue(la)).toBe(101); // writes apply to the kernel immediately
		expect(bridge.committedValue(la, 'A')).toBe(8); // not committed yet: base still holds the quiet fold
		bridge.retire(ambient!);
		expect(bridge.committedValue(la, 'A')).toBe(101); // persistence never depends on subscription
		bridge.retire(t.id); // last retirement: quiet re-arms
		expect(la.tp.materialize()).toHaveLength(0); // pin-free retirement compacts the prefix
		la.handle.set(500); // and the next write folds again
		expect(la.tp.materialize()).toHaveLength(0);
		expect(bridge.committedValue(la, 'A')).toBe(500);
	});

	it('zero-cost probes: heavy REGISTERED-atom writes, host attached, no transitions — zero receipts/batches', () => {
		// The Phase 1b population (the reviews' "wrong population" fix): atoms
		// REGISTERED with the bridge, host attached, kernel derivations and
		// effects subscribed — and NO transition, batch, or render pass ever
		// open. Heavy public write/read traffic must leave the concurrency
		// pipeline fully disarmed: zero receipts, zero batches (and with
		// no tracer attached, every record site is one dead branch).
		const atoms = Array.from({ length: 20 }, (_, i) => bridge.atom(`reg${i}`, i));
		const handles = atoms.map((n) => n.handle as Atom<number>);
		const doubles = handles.map((h) => new Computed(() => h.state * 2));
		let effectRuns = 0;
		const dispose = effect(() => {
			void doubles[0]!.state;
			effectRuns++;
		});
		const rHandle = new ReducerAtom<number, number>((s, a) => s + a, 0);
		const r = bridge.adoptAtom('regReducer', rHandle as unknown as Atom<number>);
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
		expect(after.receipts).toBe(before.receipts); // ZERO receipts
		expect(after.batches).toBe(before.batches); // ZERO batches (no ambient mint)
		expect(bridge.ambientBatch).toBeUndefined();
		// And the folds are real: base == kernel == committed for every atom.
		expect(bridge.newestValue(atoms[3]!)).toBe(49 * 1000 + 3 + 1);
		expect(bridge.committedValue(atoms[3]!, 'A')).toBe(49 * 1000 + 3 + 1);
		expect(bridge.committedValue(r, 'A')).toBe(50);
	});

	it('sync-era atoms join as committed-only base state (§5.1 rule 2)', () => {
		const handle = new Atom(41);
		handle.set(42); // pre-registration history
		const la = bridge.adoptAtom('adopted', handle);
		expect(la.base).toBe(42);
		expect(la.tp.materialize()).toHaveLength(0);
		expect(bridge.committedValue(la, 'A')).toBe(42);
	});

	it('replayed updaters run under the fold guard: raw reads inside them throw, and nothing records', () => {
		const la = bridge.atom('pure', 1);
		const handle = la.handle as Atom<number>;
		expect(() => handle.update((n) => n + (handle.state as number))).toThrow(/not allowed inside an update/);
		expect(la.tp.materialize()).toHaveLength(0); // the rejected write left no receipt
		expect(bridge.newestValue(la)).toBe(1); // and no kernel mutation
	});

	it('forbidWritesInComputeds rejects hosted writes BEFORE any receipt lands', () => {
		configure({ forbidWritesInComputeds: true });
		try {
			const la = bridge.atom('guarded', 0);
			const probe = new Computed(() => {
				(la.handle as Atom<number>).set(9); // hosted write during a computed evaluation
				return 1;
			});
			expect(() => probe.state).toThrow(/writes inside computeds are forbidden/);
			expect(la.tp.materialize()).toHaveLength(0); // policy first, capture second: no receipt behind the throw
			expect(bridge.newestValue(la)).toBe(0);
		} finally {
			configure({ forbidWritesInComputeds: false });
		}
	});

	it('public reads of a registered atom inside an overlay world evaluation serve the world fold', () => {
		const la = bridge.atom('routed', 0);
		const viaHandle = bridge.computed('viaHandle', () => la.handle.state as number); // NOT the reader — the public API
		const t = bridge.openBatch();
		bridge.write(t.id, la, 0, 5);
		expect(bridge.newestValue(viaHandle)).toBe(5); // newest = kernel arena
		const p = bridge.renderStart('A', []); // t excluded
		expect(bridge.renderValue(viaHandle, p)).toBe(0); // the world evaluation routes the public read: the excluded batch stays invisible
		bridge.renderEnd(p.id, 'discard');
		bridge.retire(t.id);
		expect(bridge.committedValue(viaHandle, 'A')).toBe(5);
	});

	it('growth with the host attached carries state through the closure rebuild', () => {
		const before = new Atom(123);
		const fresh = __newBridgeForTest(); // second bridge instance for tests: replaces routing
		fresh.registerBridge();
		expect(before.state).toBe(123); // carried buffers intact across rebuild(s)
	});
});
