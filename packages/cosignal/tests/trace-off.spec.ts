/**
 * Recorder mechanics and the zero-cost-when-off contract of cosignal/trace.
 *
 * Zero cost is asserted via the design, not micro-benchmarks:
 *  - the base entry carries no tracing instructions (source assertion;
 *    twin-build.spec.ts's zero-import check further pins its module graph
 *    to {index.ts});
 *  - the LOGGED entry's only tracing state is ONE nullable slot, captured
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
import { generateSchedule } from '../../cosignal-oracle/src/schedule.js';
import { dependencyGraphToDot, traceToDot } from '../src/graphviz.js';
import { __newBridgeForTest, type CosignalBridge } from '../src/logged.js';
import { attachTracer, REF_DROPPED, Tracer } from '../src/trace.js';
import { applyEngineOp, buildEngineTopology } from './oracle-adapter.js';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');

function src(rel: string): string {
	return readFileSync(join(pkgDir, rel), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/[^\n]*/g, '');
}

/** A tracer over a throwaway bridge, for driving the recorder synthetically. */
function bareTracer(opts?: Parameters<typeof attachTracer>[1]): Tracer {
	return attachTracer(__newBridgeForTest(), opts);
}

/** One record per call, with a recognizable payload. */
function emitN(tr: Tracer, n: number, from = 0): void {
	for (let i = from; i < from + n; i++) tr.event({ type: 'epoch-reset', epoch: i });
}

describe('R11 zero-cost-when-off: source discipline', () => {
	it('DIRECT (src/index.ts) contains no tracing instructions', () => {
		const direct = src('src/index.ts');
		expect(direct).not.toMatch(/TraceHooks|attachTracer|\btracer\b|\.trace\b/);
	});

	it('LOGGED never imports the trace or graphviz entries (lazy-loadability)', () => {
		const logged = src('src/logged.ts');
		expect(logged).not.toMatch(/from '\.\/trace\.js'|from '\.\/graphviz\.js'/);
	});

	it("LOGGED's only tracing state is the one nullable slot, captured locally", () => {
		const lines = src('src/logged.ts').split('\n');
		for (const line of lines) {
			if (!line.includes('this.trace')) continue;
			const t = line.trim();
			expect(
				t === 'trace: TraceHooks | undefined = undefined;' || t.startsWith('const tr = this.trace;'),
				`unexpected use of the trace slot: ${t}`,
			).toBe(true);
		}
	});

	it('every hook invocation sits behind a single tr !== undefined check', () => {
		const lines = src('src/logged.ts').split('\n');
		for (let i = 0; i < lines.length; i++) {
			const t = lines[i]!.trim();
			if (!/(^|[^.\w])tr\.\w+\(/.test(t)) continue;
			const guardedInline = /^if \(tr !== undefined\) tr\.\w+\(/.test(t);
			const guardedBlock = lines.slice(Math.max(0, i - 3), i).some((l) => l.includes('if (tr !== undefined) {'));
			expect(guardedInline || guardedBlock, `unguarded trace hook call: ${t}`).toBe(true);
		}
	});

	it('the trace and graphviz entries are runtime-import-free (type-only imports)', () => {
		for (const rel of ['src/trace.ts', 'src/graphviz.ts']) {
			const s = src(rel);
			expect(s, `${rel} must only use "import type"`).not.toMatch(/(^|\n)\s*import (?!type )/);
		}
	});

	it('package.json exposes ./trace and ./graphviz beside the ONE library entry', () => {
		const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { exports: Record<string, string> };
		expect(pkg.exports['./trace']).toBe('./src/trace.ts');
		expect(pkg.exports['./graphviz']).toBe('./src/graphviz.ts');
		expect(pkg.exports['.']).toBe('./src/index.ts');
		expect(pkg.exports['./logged']).toBeUndefined(); // One Core: no second entry
	});
});

describe('R11 runtime enable/disable', () => {
	it('the slot stays undefined without attach; attach/stop/re-attach at runtime', () => {
		const b = __newBridgeForTest();
		const a = b.atom('a', 0);
		b.registerBridge();
		expect(b.trace).toBeUndefined();
		b.bareWrite(a, { kind: 'set', value: 1 });
		expect(b.trace).toBeUndefined(); // nothing armed it

		const tr = attachTracer(b);
		expect(b.trace).toBe(tr);
		expect(tr.attached).toBe(true);
		expect(() => attachTracer(b)).toThrow(/already attached/);
		b.bareWrite(a, { kind: 'set', value: 2 });
		const recorded = tr.stats().recorded;
		expect(recorded).toBeGreaterThan(0);

		tr.stop();
		expect(b.trace).toBeUndefined();
		expect(tr.attached).toBe(false);
		b.bareWrite(a, { kind: 'set', value: 3 });
		expect(tr.stats().recorded).toBe(recorded); // capture frozen, still decodable
		expect(tr.events('write').length).toBeGreaterThan(0);

		const tr2 = attachTracer(b); // a later session starts fresh
		b.bareWrite(a, { kind: 'set', value: 4 });
		expect(tr2.stats().recorded).toBeGreaterThan(0);
		tr2.stop();
	});

	it('tracing never perturbs semantics: identical schedules, identical event streams', () => {
		const run = (traced: boolean): CosignalBridge => {
			const b = __newBridgeForTest();
			buildEngineTopology(b);
			b.registerBridge();
			if (traced) attachTracer(b, { mode: 'ring', capacity: 16 }); // tiny ring: wrap under load
			for (const op of generateSchedule(7, 80)) applyEngineOp(b, op);
			return b;
		};
		const plain = run(false);
		const traced = run(true);
		expect(JSON.stringify(traced.events)).toBe(JSON.stringify(plain.events));
		expect(traced.seq).toBe(plain.seq);
		expect(traced.cas).toBe(plain.cas);
		expect(traced.epoch).toBe(plain.epoch);
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
		for (let i = 0; i < 10; i++) tr.event({ type: 'core-effect-run', effect: 'E', value: i });
		expect(tr.decode(0)!.data['value']).toBe(REF_DROPPED); // overwritten
		expect(tr.decode(1)!.data['value']).toBe(REF_DROPPED);
		expect(tr.decode(2)!.data['value']).toBe(2); // oldest survivor
		expect(tr.decode(9)!.data['value']).toBe(9);
		tr.stop();

		const off = bareTracer({ refCapacity: 0 });
		off.event({ type: 'core-effect-run', effect: 'E', value: 42 });
		expect(off.decode(0)!.data['value']).toBe(REF_DROPPED); // events record, payloads drop
		expect(off.stats().refsCaptured).toBe(0);
		off.stop();
	});
});

describe('R11 Graphviz renderers', () => {
	it('dependencyGraphToDot: nodes, K1 union edges, watchers, effects', () => {
		const b = __newBridgeForTest();
		const flag = b.atom('flag', 0);
		const a = b.atom('a', 0);
		const c = b.computed('c', (read) => (read(flag) ? read(a) : 0));
		b.registerBridge();
		const p = b.passStart('A', []);
		b.mountWatcher(p.id, c, 'W');
		b.passEnd(p.id, 'commit');
		b.mountCoreEffect(c, 'CE');
		const dot = dependencyGraphToDot(b);
		expect(dot).toMatch(/^digraph cosignal \{/);
		expect(dot).toContain(`n${flag.id} [shape=box`);
		expect(dot).toContain(`n${flag.id} -> n${c.id};`); // the union edge the logged engine recorded
		expect(dot).toContain('"W@A"');
		expect(dot).toContain('CE runs:0');
		expect(dot.trim().endsWith('}')).toBe(true);
	});

	it('traceToDot: cause edges drawn within the kept set; filter respected', () => {
		const b = __newBridgeForTest();
		const a = b.atom('a', 0);
		const c = b.computed('c', (read) => read(a));
		b.registerBridge();
		const tr = attachTracer(b);
		const p = b.passStart('A', []);
		b.mountWatcher(p.id, c, 'W');
		b.passEnd(p.id, 'commit');
		const t = b.openBatch('default');
		b.write(t.id, a, { kind: 'set', value: 1 });

		const write = tr.events('write')[0]!;
		const delivery = tr.events('delivery')[0]!;
		const dot = traceToDot(tr.events());
		expect(dot).toMatch(/^digraph trace \{/);
		expect(dot).toContain(`t${write.id} [label="#${write.id} write(a)"`);
		expect(dot).toContain(`t${write.id} -> t${delivery.id};`); // the causal edge
		const onlyWrites = traceToDot(tr.events(), (e) => e.kind === 'write');
		expect(onlyWrites).not.toContain('->'); // causes outside the kept set are not drawn
		tr.stop();
		b.retire(t.id, false);
	});
});
