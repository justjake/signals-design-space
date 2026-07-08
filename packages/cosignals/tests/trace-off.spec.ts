/**
 * Recorder mechanics and the zero-cost-when-off contract of cosignals/trace.
 *
 * Zero cost is asserted via the design, not micro-benchmarks:
 *  - the base entry carries no tracing instructions (source assertion;
 *    twin-build.spec.ts's zero-import check further pins its module graph
 *    to {index.ts});
 *  - the CONCURRENT-engine entry's only tracing state is ONE nullable slot, captured
 *    locally and checked once per site, and it never imports the trace
 *    module (lazy-loadability);
 *  - the trace/graphviz entries are runtime-import-free (type-only imports),
 *    so loading them pulls no engine code;
 *  - runtime: the slot stays undefined until attach; stop() restores it and
 *    freezes the capture; tracing never perturbs engine semantics (identical
 *    schedules produce identical event streams traced and untraced).
 *
 * Recorder: RING wrap accounting, SESSION chunk append + sealed prefix,
 * truncation marker + degrade-to-ring, clock-sync on saturated deltas,
 * ref-ring retention, and the Graphviz renderers.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateSchedule } from '../../cosignals-oracle/src/schedule.js';
import { mountEngineReactEffect } from './helpers.js';
import { dependencyGraphToDot, traceToDot } from '../src/graphviz.js';
import { engine, __resetEngineForTest, type CosignalEngine } from '../src/concurrent.js';
import { attachTracer, REF_DROPPED, Tracer } from '../src/Tracer.js';
import { applyEngineOp, buildEngineTopology } from './oracle-adapter.js';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The concurrent engine's module set (the one entry plus its extracted
 * mechanism modules) — every source-discipline scan below covers all of
 * them, so an extraction can never silently exit the zero-cost contract. */
const ENGINE_MODULES = [
	'src/concurrent.ts',
	'src/ConcurrentEngine.ts',
	'src/errors.ts',
	'src/NotificationQueue.ts',
	'src/ObservationIndex.ts',
	'src/WriteLog.ts',
	'src/Batch.ts',
	'src/World.ts',
	'src/settlement.ts',
	// The engine module — kernel, evaluation policy, observed lifecycle,
	// world arenas, observer records, committed observers, render
	// integration, reclamation — the same zero-cost scans cover every
	// section.
	'src/CosignalEngine.ts',
];

function src(rel: string): string {
	return readFileSync(join(pkgDir, rel), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/[^\n]*/g, '');
}

/** Fresh engine (the per-test bridge analog): finish any leftover episode
 * so the reset's idle preconditions hold, then reset. */
function bridge(): CosignalEngine {
	engine.discardAllWip();
	for (const t of engine.liveBatches()) {
		if (t.parked) engine.settleAction(t.id);
		else engine.retire(t.id);
	}
	__resetEngineForTest();
	return engine;
}

/** A tracer over a fresh engine reset, for driving the recorder synthetically. */
function bareTracer(opts?: Parameters<typeof attachTracer>[1]): Tracer {
	return attachTracer(bridge(), opts);
}

/** One record per call, with a recognizable payload (the typed epoch-reset
 * create — the direct emit surface the engine's sites call). */
function emitN(tr: Tracer, n: number, from = 0): void {
	for (let i = from; i < from + n; i++) tr.epochReset(i);
}

describe('R11 zero-cost-when-off: source discipline', () => {
	it('DIRECT (src/index.ts) contains no tracing instructions', () => {
		const direct = src('src/index.ts');
		expect(direct).not.toMatch(/TraceHooks|attachTracer|\btracer\b|\.trace\b/);
	});

	it('the engine modules never import the trace or graphviz entries (lazy-loadability)', () => {
		for (const rel of ENGINE_MODULES) {
			const engineSrc = src(rel);
			expect(engineSrc, rel).not.toMatch(/from '\.\/Tracer\.js'|from '\.\/graphviz\.js'/);
		}
	});

	it("the engine's only tracing state is the one nullable slot, captured locally", () => {
		// The slot's STORAGE is the shared engine-core record's `trace` field
		// (World.ts declares it; the engine surface exposes the `engine.trace`
		// accessor pair over it). Mechanism modules capture it locally per
		// site — `const tr = core.trace;` (or `const tr = c.trace;` over a
		// one-load core alias) for the core-wired factories, or through a
		// deps arrow (`trace: () => core.trace`) for the arrow-wired ones.
		const lines = src('src/concurrent.ts').split('\n');
		for (const line of lines) {
			if (!/\bcore\.trace\b/.test(line) && !/\bc\.trace\b/.test(line)) continue;
			const t = line.trim();
			expect(
				t.startsWith('const tr = core.trace;') || t.startsWith('const tr = c.trace;') || t === 'return core.trace;' || t === 'core.trace = hooks;',
				`unexpected use of the trace slot: ${t}`,
			).toBe(true);
		}
		// The engine-surface accessor pair is the only surface over the core field.
		expect(src('src/concurrent.ts')).toMatch(/return core\.trace;/);
		for (const rel of ['src/World.ts', 'src/CosignalEngine.ts', 'src/settlement.ts', 'src/Batch.ts', 'src/NotificationQueue.ts', 'src/ConcurrentEngine.ts']) {
			const lines2 = src(rel).split('\n');
			for (const line of lines2) {
				if (!/\bcore\.trace\b/.test(line) && !/\bc\.trace\b/.test(line)) continue;
				const t = line.trim();
				expect(
					t.startsWith('const tr = core.trace;') || t.startsWith('const tr = c.trace;') || t === 'trace: undefined,' || t === 'trace: () => core.trace,' || t.startsWith('trace: TraceHooks | undefined;'),
					`unexpected use of the trace slot in ${rel}: ${t}`,
				).toBe(true);
			}
		}
	});

	it('every hook invocation sits behind a single tr !== undefined check', () => {
		for (const rel of ENGINE_MODULES) {
			const lines = src(rel).split('\n');
			for (let i = 0; i < lines.length; i++) {
				const t = lines[i]!.trim();
				if (!/(^|[^.\w])tr\.\w+\(/.test(t)) continue;
				const guardedInline = /^if \(tr !== undefined\) tr\.\w+\(/.test(t);
				const guardedBlock = lines.slice(Math.max(0, i - 3), i).some((l) => l.includes('if (tr !== undefined) {'));
				expect(guardedInline || guardedBlock, `unguarded trace hook call in ${rel}: ${t}`).toBe(true);
			}
		}
	});

	it('the trace and graphviz entries are runtime-import-free (type-only imports)', () => {
		for (const rel of ['src/Tracer.ts', 'src/graphviz.ts']) {
			const s = src(rel);
			expect(s, `${rel} must only use "import type"`).not.toMatch(/(^|\n)\s*import (?!type )/);
		}
	});

	it('package.json exposes ./trace and ./graphviz beside the ONE library entry', () => {
		const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { exports: Record<string, string> };
		expect(pkg.exports['./trace']).toBe('./src/Tracer.ts');
		expect(pkg.exports['./graphviz']).toBe('./src/graphviz.ts');
		expect(pkg.exports['.']).toBe('./src/index.ts');
		expect(pkg.exports['./concurrent']).toBeUndefined(); // One Core: no second entry
	});
});

describe('R11 runtime enable/disable', () => {
	it('the slot stays undefined without attach; attach/stop/re-attach at runtime', () => {
		const b = bridge();
		const a = b.atom('a', 0);
		expect(b.trace).toBeUndefined();
		b.bareWrite(a, 0, 1);
		expect(b.trace).toBeUndefined(); // nothing armed it

		const tr = attachTracer(b);
		expect(b.trace).toBe(tr);
		expect(tr.attached).toBe(true);
		expect(() => attachTracer(b)).toThrow(/already attached/);
		b.bareWrite(a, 0, 2);
		const recorded = tr.stats().recorded;
		expect(recorded).toBeGreaterThan(0);

		tr.stop();
		expect(b.trace).toBeUndefined();
		expect(tr.attached).toBe(false);
		b.bareWrite(a, 0, 3);
		expect(tr.stats().recorded).toBe(recorded); // capture frozen, still decodable
		// The bridge was at rest for every write above, so the captured records
		// are quiet folds (the production default write path), not log entries.
		expect(tr.events('quiet-write').length).toBeGreaterThan(0);

		const tr2 = attachTracer(b); // a later session starts fresh
		b.bareWrite(a, 0, 4);
		expect(tr2.stats().recorded).toBeGreaterThan(0);
		tr2.stop();
	});

	it('tracing never perturbs semantics: identical schedules, identical counters and observable values', () => {
		// ONE engine now, so the runs are sequential RESETS: run traced,
		// snapshot every observable, reset, run untraced, compare snapshots.
		const run = (traced: boolean) => {
			const b = bridge();
			buildEngineTopology(b);
			const tr = traced ? attachTracer(b, { mode: 'ring', capacity: 16 }) : undefined; // tiny ring: wrap under load
			for (const op of generateSchedule(7, 80)) applyEngineOp(b, op);
			const snapshot = {
				seq: b.seq,
				committedAdvance: b.committedAdvance,
				epoch: b.epoch,
				// NodeIds line up exactly across resets (the kernel scrubs at
				// reset, so identical schedules allocate identical record ids).
				nodes: [...b.idToInternals.values()].map((n) => ({ id: n.id, name: n.name, newest: b.newestValue(n) })),
			};
			tr?.stop();
			return snapshot;
		};
		const traced = run(true);
		const plain = run(false);
		// The engine's only event output is the tracer itself now, so the
		// untraced run has no stream to diff — the perturbation check compares
		// what exists on both sides: every clock and every observable value.
		expect(traced.seq).toBe(plain.seq);
		expect(traced.committedAdvance).toBe(plain.committedAdvance);
		expect(traced.epoch).toBe(plain.epoch);
		expect(traced.nodes.length).toBe(plain.nodes.length);
		for (let i = 0; i < plain.nodes.length; i++) {
			const n = plain.nodes[i]!;
			const tn = traced.nodes[i]!;
			expect(tn.id, 'node ids diverged under tracing').toBe(n.id);
			expect(tn.name, 'node population diverged under tracing').toBe(n.name);
			expect(
				Object.is(tn.newest, n.newest),
				`newest(${n.name}) diverged under tracing`,
			).toBe(true);
		}
	});
});

describe('R11 RING mode (flight recorder)', () => {
	it('wraps at capacity: ids stay addresses, loss is counted, decode refuses overwritten ids', () => {
		const tr = bareTracer({ mode: 'ring', capacity: 8 });
		emitN(tr, 20);
		const s = tr.stats();
		expect(s).toMatchObject({ mode: 'ring', recorded: 20, retained: 8, firstRetained: 12, dropped: 12, chunks: 1 });
		expect(tr.decode(11)).toBeUndefined(); // overwritten
		expect(tr.decode(12)!.data).toEqual({ epoch: 12 }); // id ↔ record alignment survives the wrap
		expect(tr.events().map((e) => e.id)).toEqual([12, 13, 14, 15, 16, 17, 18, 19]);
		expect(tr.verifyComplete().complete).toBe(false);
		tr.stop();
	});
});

describe('R11 SESSION mode (lossless capture)', () => {
	it('appends sealed chunks, never copies; losslessness is provable', () => {
		const tr = bareTracer({ mode: 'session', chunkSize: 8 });
		emitN(tr, 20);
		const s = tr.stats();
		expect(s).toMatchObject({ mode: 'session', recorded: 20, retained: 20, dropped: 0, truncated: false, chunks: 3 });
		expect(tr.verifyComplete()).toEqual({ complete: true, from: 0, to: 19 });
		expect(tr.events().map((e) => e.id)).toEqual([...Array(20).keys()]);
		tr.stop();
	});

	it('crossing maxBytes: loud truncation marker, degrade to ring over the final chunk, sealed prefix kept', () => {
		// 2 chunks × 8 records × 32 B = 512 B budget → the 3rd chunk is refused
		const tr = bareTracer({ mode: 'session', chunkSize: 8, maxBytes: 512 });
		emitN(tr, 20);
		const s = tr.stats();
		expect(s.truncated).toBe(true);
		expect(s.chunks).toBe(2);
		expect(s.recorded).toBe(21); // 20 events + the truncation marker
		const marker = tr.events('truncation')[0]!;
		expect(marker.id).toBe(16);
		expect(marker.data).toEqual({ boundaryId: 16 });
		expect(tr.decode(17)!.data).toEqual({ epoch: 16 }); // the event that crossed, re-emitted after the marker
		// sealed prefix intact; the middle fell to the ring window [head-8, head)
		expect(tr.decode(0)!.data).toEqual({ epoch: 0 });
		expect(tr.decode(7)!.data).toEqual({ epoch: 7 });
		expect(tr.decode(10)).toBeUndefined();
		expect(tr.events().map((e) => e.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 13, 14, 15, 16, 17, 18, 19, 20]);
		expect(tr.verifyComplete().complete).toBe(false);
		tr.stop();
	});
});

describe('R11 recorder details', () => {
	it('clock-sync: a saturated µs delta emits an absolute-time record', () => {
		const times = [0, 100, 100 + 2147483648];
		let i = 0;
		const tr = bareTracer({ now: () => times[Math.min(i++, times.length - 1)]! });
		emitN(tr, 2);
		const kinds = tr.events().map((e) => e.kind);
		expect(kinds).toEqual(['epoch-reset', 'clock-sync', 'epoch-reset']);
		expect(tr.events('clock-sync')[0]!.data).toEqual({ absoluteUs: 100 + 2147483648 });
		expect(tr.events()[2]!.dt).toBe(0); // the synced event restarts the delta line
		tr.stop();
	});

	it('ref-ring: object payloads retained until overwritten; capacity 0 disables capture', () => {
		const tr = bareTracer({ refCapacity: 8 });
		for (let i = 0; i < 10; i++) tr.coreEffectRun('E', i);
		expect(tr.decode(0)!.data['value']).toBe(REF_DROPPED); // overwritten
		expect(tr.decode(1)!.data['value']).toBe(REF_DROPPED);
		expect(tr.decode(2)!.data['value']).toBe(2); // oldest survivor
		expect(tr.decode(9)!.data['value']).toBe(9);
		tr.stop();

		const off = bareTracer({ refCapacity: 0 });
		off.coreEffectRun('E', 42);
		expect(off.decode(0)!.data['value']).toBe(REF_DROPPED); // events record, payloads drop
		expect(off.stats().refsCaptured).toBe(0);
		off.stop();
	});
});

describe('R11 Graphviz renderers', () => {
	it('dependencyGraphToDot: nodes, K1 union edges, watchers, effects', () => {
		const b = bridge();
		const flag = b.atom('flag', 0);
		const a = b.atom('a', 0);
		const c = b.computed('c', (read) => (read(flag) ? read(a) : 0));
		const p = b.renderStart('A', []);
		b.mountWatcher(p.id, c, 'W');
		b.renderEnd(p.id, 'commit');
		// A committed observer (core effect()s are kernel effects now — no
		// bridge record, so nothing of theirs appears in the dump).
		mountEngineReactEffect(b, 'A', c, 'E');
		const dot = dependencyGraphToDot(b);
		expect(dot).toMatch(/^digraph cosignals \{/);
		expect(dot).toContain(`n${flag.id} [shape=box`);
		expect(dot).toContain(`n${flag.id} -> n${c.id};`); // the union edge the concurrent engine recorded
		expect(dot).toContain('"W@A"');
		expect(dot).toContain('E@A runs:0');
		expect(dot.trim().endsWith('}')).toBe(true);
	});

	it('traceToDot: cause edges drawn within the kept set; filter respected', () => {
		const b = bridge();
		const a = b.atom('a', 0);
		const c = b.computed('c', (read) => read(a));
		const tr = attachTracer(b);
		const p = b.renderStart('A', []);
		b.mountWatcher(p.id, c, 'W');
		b.renderEnd(p.id, 'commit');
		const t = b.openBatch();
		b.write(t.id, a, 0, 1);

		const write = tr.events('write')[0]!;
		const delivery = tr.events('delivery')[0]!;
		const dot = traceToDot(tr.events());
		expect(dot).toMatch(/^digraph trace \{/);
		expect(dot).toContain(`t${write.id} [label="#${write.id} write(a)"`);
		expect(dot).toContain(`t${write.id} -> t${delivery.id};`); // the causal edge
		const onlyWrites = traceToDot(tr.events(), (e) => e.kind === 'write');
		expect(onlyWrites).not.toContain('->'); // causes outside the kept set are not drawn
		tr.stop();
		b.retire(t.id);
	});
});
