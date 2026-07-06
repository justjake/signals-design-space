import { describe, expect, it } from 'vitest';
import { createCosignalEngine } from '../src/engine';
import { createForkDouble } from '../src/fork-double';
import { TraceKind, createTracer } from '../src/tracing';

// §16 — tracing: the packed recorder in RING and SESSION modes, the decoder
// view, engine choke-point emits, and the G-20/G-21 test forms. (The G-18/
// G-19 RATIOS are measured in gates.spec.ts; here we pin the structural
// guarantees.)

describe('§16.2 RING mode (flight recorder)', () => {
	it('overwrites oldest, keeps ids stable, reports drops', () => {
		const t = createTracer({ mode: 'ring', capacity: 8 });
		for (let i = 0; i < 20; ++i) {
			t.emit(TraceKind.ATOM_WRITE, i, 0);
		}
		expect(t.eventCount).toBe(20);
		expect(t.dropCount).toBe(12); // detectable loss, never silent
		expect(t.decode(3)).toBeUndefined(); // overwritten
		const last = t.decode(19)!;
		expect(last.kind).toBe('atom-write');
		expect(last.node).toBe(19);
		// A ring is complete only if nothing was ever overwritten.
		expect(t.verifyLossless().lossless).toBe(false);
	});

	it('G-20 (RING): zero allocations per event after construction', () => {
		const t = createTracer({ mode: 'ring', capacity: 8 });
		for (let i = 0; i < 1000; ++i) {
			t.emit(TraceKind.LOG_APPEND, i, 0);
		}
		expect(t.stats().allocations).toBe(1); // the constructor's single buffer
		expect(t.stats().chunks).toBe(1);
	});
});

describe('§16.2 SESSION mode (lossless capture)', () => {
	it('G-20 (SESSION): exactly one chunk allocation amortized per chunkSize events', () => {
		const t = createTracer({ mode: 'session', chunkSize: 16, maxBytes: 1 << 20 });
		for (let i = 0; i < 100; ++i) {
			t.emit(TraceKind.LOG_APPEND, i, 0);
		}
		expect(t.stats().chunks).toBe(Math.ceil(100 / 16));
		expect(t.stats().allocations).toBe(Math.ceil(100 / 16));
	});

	it('G-21: losslessness is provable — one gap-free id range', () => {
		const t = createTracer({ mode: 'session', chunkSize: 16, maxBytes: 1 << 20 });
		for (let i = 0; i < 50; ++i) {
			t.emit(TraceKind.ATOM_WRITE, i, 0);
		}
		const proof = t.verifyLossless();
		expect(proof).toEqual({ lossless: true, from: 0, to: 49, truncatedAtId: -1 });
		for (let id = 0; id < 50; ++id) {
			expect(t.decode(id)?.node).toBe(id);
		}
	});

	it('G-21: sealed chunks stream during recording and decode identically after', () => {
		const t = createTracer({ mode: 'session', chunkSize: 8, maxBytes: 1 << 20 });
		for (let i = 0; i < 20; ++i) {
			t.emit(TraceKind.ATOM_WRITE, i, 0);
		}
		const sealedMid = t.sealedChunks();
		expect(sealedMid.length).toBe(2); // chunks 0 and 1 are full and immutable
		const snapshot = sealedMid.map((c) => c.slice()); // "transfer" a copy now
		for (let i = 20; i < 40; ++i) {
			t.emit(TraceKind.ATOM_WRITE, i, 0); // recording continues
		}
		// Post-hoc decode of the same ids matches the streamed bytes.
		for (let k = 0; k < snapshot.length; ++k) {
			expect([...t.sealedChunks()[k]]).toEqual([...snapshot[k]]);
		}
	});

	it('G-21: maxBytes breach emits a loud truncation-marker and degrades to RING', () => {
		// chunkSize 8 records * 8 slots * 4 bytes = 256 B/chunk; cap at 2 chunks.
		const t = createTracer({ mode: 'session', chunkSize: 8, maxBytes: 512 });
		for (let i = 0; i < 40; ++i) {
			t.emit(TraceKind.ATOM_WRITE, i, 0);
		}
		const proof = t.verifyLossless();
		expect(proof.lossless).toBe(false);
		expect(proof.truncatedAtId).toBeGreaterThan(0); // the boundary is named
		expect(t.stats().truncated).toBe(true);
		// Recent events keep flowing (RING behavior over the final chunk).
		// The marker consumed one id, so the 40th write is the last event.
		expect(t.decode(t.eventCount - 1)?.node).toBe(39);
		// Events before the marker are still intact (the lossless prefix).
		expect(t.decode(0)?.node).toBe(0);
		expect(proof.to).toBe(proof.truncatedAtId - 1);
	});
});

describe('§16.2 engine choke-point emits', () => {
	it('captures the write→walk→broadcast→retire→quiescence causality of one transition', () => {
		const engine = createCosignalEngine();
		const fork = createForkDouble();
		engine.attachFork(fork);
		fork.registerRoot('root');
		const tr = createTracer({ mode: 'session', chunkSize: 256, maxBytes: 1 << 20 });
		engine.setTracer(tr);

		const a = engine.atom(0);
		const c = engine.computed(() => (a.state as number) * 2);
		expect(c.state).toBe(0);
		engine.watch(c);
		const t = fork.openBatch('deferred');
		t.run(() => a.set(5));
		const pass = fork.startPass('root', { include: [t] });
		expect(c.state).toBe(10);
		pass.end();
		t.retire();
		engine.setTracer(undefined);

		const kinds: string[] = [];
		for (let id = 0; id < tr.eventCount; ++id) {
			kinds.push(tr.decode(id)!.kind);
		}
		expect(kinds).toContain('atom-write');
		expect(kinds).toContain('log-append');
		expect(kinds).toContain('notify-walk');
		expect(kinds).toContain('broadcast');
		expect(kinds).toContain('computed-eval');
		expect(kinds).toContain('render-pass-start');
		expect(kinds).toContain('render-pass-end');
		expect(kinds).toContain('batch-retired');
		expect(kinds).toContain('quiescence');
		// Ordering sanity: write precedes its walk precedes retirement.
		expect(kinds.indexOf('atom-write')).toBeLessThan(kinds.indexOf('notify-walk'));
		expect(kinds.indexOf('notify-walk')).toBeLessThan(kinds.indexOf('batch-retired'));
		expect(kinds.indexOf('batch-retired')).toBeLessThan(kinds.indexOf('quiescence'));
		expect(tr.verifyLossless().lossless).toBe(true);
	});

	it('G-18 (structural form): no tracer → no records, engine behavior identical', () => {
		const engine = createCosignalEngine();
		const a = engine.atom(1);
		const c = engine.computed(() => (a.state as number) + 1);
		a.set(2);
		expect(c.state).toBe(3); // no tracer installed anywhere: nothing throws
	});
});
