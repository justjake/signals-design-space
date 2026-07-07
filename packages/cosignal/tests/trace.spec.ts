/**
 * Trace semantics coverage for cosignal/trace: every traced event class
 * fires with correct payloads on a representative schedule (a staged
 * narrative over one traced bridge, then a fuzz sweep proving the capture's
 * integrity — losslessness, total decode/format, terminating causality, and
 * the referee decoder's coverage of the packed stream, which is the engine's
 * ONLY event output). Causality (CAUSE edges + queries) and the stable human
 * format are asserted here too.
 */
import { describe, expect, it } from 'vitest';
import { mountEngineCoreEffect, mountEngineReactEffect } from './helpers.js';
import { generateSchedule } from '../../cosignal-oracle/src/schedule.js';
import { __newBridgeForTest, type TraceEvent, type CosignalBridge } from '../src/concurrent.js';
import { attachTracer, formatTrace, formatTraceRecord, Tracer, type TraceRecord, type TraceKind } from '../src/trace.js';
import { applyEngineOp, buildEngineTopology } from './oracle-adapter.js';
import { attachRefereeStream, decodeTraceEvent, decodedTraceEvents } from './trace-events.js';

function tick(): () => number {
	let t = 0;
	return () => (t += 10);
}

/** All decoded events of a kind. */
function all(tr: Tracer, kind: TraceKind): TraceRecord[] {
	return tr.events(kind);
}

function last(tr: Tracer, kind: TraceKind): TraceRecord {
	const found = all(tr, kind);
	expect(found.length, `expected at least one ${kind} event`).toBeGreaterThan(0);
	return found[found.length - 1]!;
}

/** The referee's view of the same records (the deleted object log's shape). */
function tevents<T extends TraceEvent['type']>(tr: Tracer, type: T): Extract<TraceEvent, { type: T }>[] {
	return decodedTraceEvents(tr).filter((e): e is Extract<TraceEvent, { type: T }> => e.type === type);
}

describe('R11 event-class coverage (staged narrative, one traced bridge)', () => {
	const b = __newBridgeForTest();
	const flag = b.atom('flag', 0);
	const a = b.atom('a', 0);
	const bb = b.atom('b', 0);
	const c = b.computed('c', (read) => (read(flag) ? read(a) : read(bb)));
	b.registerBridge();
	const tr = attachTracer(b, { mode: 'session', now: tick() });
	let w!: ReturnType<CosignalBridge['mountWatcher']>;

	it('render lifecycle + mount fixup fast-out: render-start/render-end payloads, eval records, disposition', () => {
		const p1 = b.renderStart('A', []);
		w = b.mountWatcher(p1.id, c, 'W');
		b.renderEnd(p1.id, 'commit');

		expect(all(tr, 'render-start')[0]!.data).toEqual({ renderPass: p1.id, root: 'A', pin: 0, maskSize: 0 });
		expect(all(tr, 'render-start')[0]!.cause).toBeUndefined();
		const end = all(tr, 'render-end')[0]!;
		expect(end.data).toEqual({ renderPass: p1.id, root: 'A', disposition: 'commit' });
		// world evaluations recorded: the mount render evaluated c in p1's world
		const evals = all(tr, 'eval');
		expect(evals.some((e) => e.data['node'] === 'c' && e.data['world'] === `render:${p1.id}`)).toBe(true);
		// conditions-first fixup: a passing four-condition test skips the
		// mount-fix evaluation entirely — no mount-fix eval record exists
		expect(evals.some((e) => e.data['world'] === 'mount-fix:A')).toBe(false);
		// clean mount on a quiet root: fast-out, zero correctives; provoked by the commit
		const fx = all(tr, 'mount-fixup')[0]!;
		expect(fx.data).toEqual({ watcher: 'W', root: 'A', disposition: 'fast-out', correctives: 0 });
		expect(tr.causeChain(fx.id).map((e) => e.kind)).toContain('render-end');
	});

	it('writes: batch-open, slot-claim, log entry payload with op, fresh delivery caused by the write', () => {
		const k = b.openBatch();
		b.write(k.id, flag, 0, 1);

		expect(all(tr, 'batch-open')[0]!.data).toEqual({ batch: k.id, action: false, ambient: false });
		expect(all(tr, 'slot-claim')[0]!.data).toEqual({ slot: 0, batch: k.id });
		const seq = tevents(tr, 'write')[0]!.seq; // the slot claim created its own seq before the write's
		const w1 = all(tr, 'write')[0]!;
		expect(w1.data).toEqual({ node: 'flag', op: 'set', batch: k.id, slot: 0, seq });
		expect(w1.cause).toBeUndefined(); // operation root
		const d1 = all(tr, 'delivery')[0]!;
		expect(d1.data).toEqual({ watcher: 'W', batch: k.id, slot: 0, seq, mode: 'fresh' });
		expect(d1.cause).toBe(w1.id); // the delivery is provoked by its write

		// Engine mechanics: the flip's topology (c now reads a) is discovered
		// at evaluation sites. Routing structure lives in the per-world
		// arenas (S-B): the newest pull below feeds the newest memo (core
		// effects, stage below), and the NEXT stage's render read records the
		// a→c link in its own arena — the structure its interleaved
		// delivery walks.
		b.newestValue(c);
	});

	it('dedup suppression: second write into the armed (watcher, slot) suppresses with a reason', () => {
		const k = 1; // batch id from the previous stage
		b.write(k, flag, 0, 2);
		const w2 = all(tr, 'write')[1]!;
		expect(w2.cause).toBeUndefined(); // opEnd isolated the previous write's chain
		const s = all(tr, 'suppressed')[0]!;
		expect(s.data).toEqual({ watcher: 'W', batch: k, slot: 0, seq: tevents(tr, 'suppressed')[0]!.seq, reason: 'dedup-pending-fold' });
		expect(s.cause).toBe(w2.id);
	});

	it('render yield/resume edges; post-pin write delivers interleaved (§5.9)', () => {
		const p2 = b.renderStart('A', [1]);
		b.renderValue(c, p2); // the render reads c: p2's arena records flag→c, a→c (the routing structure the write below walks)
		b.renderYield(p2.id);
		b.renderResume(p2.id);
		expect(all(tr, 'render-start')[1]!.data).toEqual({ renderPass: p2.id, root: 'A', pin: p2.pin, maskSize: 1 });
		expect(all(tr, 'render-yield')[0]!.data).toEqual({ renderPass: p2.id, root: 'A' });
		expect(all(tr, 'render-yield')[0]!.cause).toBeUndefined();
		expect(all(tr, 'render-resume')[0]!.data).toEqual({ renderPass: p2.id, root: 'A' });

		b.write(1, a, 0, 5);
		const d = last(tr, 'delivery');
		const seq = tevents(tr, 'write')[2]!.seq;
		expect(d.data).toEqual({ watcher: 'W', batch: 1, slot: 0, seq, mode: 'interleaved' });

		b.renderWatcher(p2.id, w.id);
		b.renderEnd(p2.id, 'commit', { retireAtCommit: [1] });
	});

	it('retirement at commit chains: render-end → batch-retire → slot-release (causeChain)', () => {
		const end = all(tr, 'render-end')[1]!;
		expect(end.data['disposition']).toBe('commit');
		const ret = all(tr, 'batch-retire')[0]!;
		expect(ret.data).toEqual({ batch: 1, retiredSeq: tevents(tr, 'retired')[0]!.retiredSeq });
		expect(ret.cause).toBe(end.id); // retirement folded inside the commit
		const rel = all(tr, 'slot-release')[0]!;
		expect(rel.data).toEqual({ slot: 0, batch: 1 });
		expect(tr.causeChain(rel.id).map((e) => e.kind)).toEqual(['slot-release', 'batch-retire', 'render-end']);
	});

	it('per-root commit with generation; react effect run caused by it', () => {
		mountEngineReactEffect(b, 'A', c, 'RE'); // committed c = 5
		const t2 = b.openBatch();
		b.write(t2.id, a, 0, 7);
		const p3 = b.renderStart('A', [t2.id]);
		b.renderWatcher(p3.id, w.id);
		b.renderEnd(p3.id, 'commit'); // lock-in without retirement

		const rc = all(tr, 'root-commit')[0]!;
		expect(rc.data).toEqual({ root: 'A', batch: t2.id, commitGen: 1 });
		expect(rc.cause).toBe(all(tr, 'render-end')[2]!.id);
		const re = all(tr, 'react-effect-run')[0]!;
		expect(re.data).toEqual({ effect: 'RE', root: 'A', value: 7, values: [7] }); // values = the dep snapshot (referee-compared)
		expect(re.cause).toBe(rc.id);
		expect(tr.whyEffectRan('RE').map((e) => e.kind)).toEqual(['react-effect-run', 'root-commit', 'render-end']);
	});

	it('core effect run caused by its write; reconcile-correction caused by a top-level retirement', () => {
		mountEngineCoreEffect(b, c, 'CE'); // real kernel effect(); newest c = 7
		const t3 = b.openBatch();
		b.write(t3.id, a, 0, 8);
		const wr = last(tr, 'write');
		const ce = last(tr, 'core-effect-run');
		expect(ce.data).toEqual({ effect: 'CE#0', value: 8 }); // '#0': the per-mount name ordinal (see mountEngineCoreEffect)
		expect(ce.cause).toBe(wr.id);

		b.retire(t3.id); // top-level: an operation root, not chained to prior ops
		const ret = last(tr, 'batch-retire');
		expect(ret.cause).toBeUndefined();
		const rec = last(tr, 'reconcile-correction');
		expect(rec.data).toEqual({ watcher: 'W', root: 'A', from: 7, to: 8, cause: 'retirement' });
		expect(rec.cause).toBe(ret.id);
		expect(tr.whyDelivered('W').map((e) => e.kind)).toEqual(['reconcile-correction', 'batch-retire']);
	});

	it('write-dropped (§5.3 step 2) records the dropped batch', () => {
		const t4 = b.openBatch();
		b.write(t4.id, bb, 0, 0); // empty write log, equal against base
		expect(last(tr, 'write-dropped').data).toEqual({ node: 'b', batch: t4.id });
		b.retire(t4.id);
	});

	it('action settlement: batch-settle is the root; its retirement chains under it', () => {
		const act = b.openBatch({ action: true });
		expect(last(tr, 'batch-open').data).toMatchObject({ batch: act.id, action: true });
		b.write(act.id, bb, 0, 3);
		b.settleAction(act.id);
		const settle = last(tr, 'batch-settle');
		expect(settle.data).toEqual({ batch: act.id });
		expect(settle.cause).toBeUndefined();
		const ret = last(tr, 'batch-retire');
		expect(ret.data).toMatchObject({ batch: act.id });
		expect(ret.cause).toBe(settle.id);
	});

	it('batch-disposition: the bindings-created report decodes {batch, committed} and claims no cause', () => {
		// The engine never creates this kind — the React bindings' protocol
		// handler does, through the same TraceHooks surface. Create directly.
		tr.batchDisposition(41, true);
		const yes = last(tr, 'batch-disposition');
		expect(yes.data).toEqual({ batch: 41, committed: true });
		tr.batchDisposition(42, false);
		const no = last(tr, 'batch-disposition');
		expect(no.data).toEqual({ batch: 42, committed: false });
		expect(no.cause).toBe(yes.cause); // not a cause-claiming kind: the register is untouched
	});

	it('ambient classification and op kinds: update log entries (reducer-style closures included); bare writes stay lint-free', () => {
		const r = b.atom('r', 0);
		b.bareWrite(r, 1, (s: unknown) => (s as number) + 1); // the closure form a ReducerAtom dispatch records
		expect(last(tr, 'batch-open').data).toMatchObject({ ambient: true });
		expect(last(tr, 'write').data).toMatchObject({ node: 'r', op: 'update' });

		b.write(undefined, a, 1, (p: unknown) => (p as number) + 1); // a: 8 → 9
		expect(last(tr, 'write').data).toMatchObject({ node: 'a', op: 'update' });

		const act2 = b.openBatch({ action: true }); // parked
		b.bareWrite(a, 0, 99); // classifies ambient; the post-await lint is adapter-only (no trace event)
		expect(last(tr, 'write').data).toMatchObject({ node: 'a', op: 'set' });
		b.settleAction(act2.id);
		expect(last(tr, 'batch-settle').data).toEqual({ batch: act2.id });
	});

	it('slot-release-deferred while an open mask names the slot; released at the discard render-end', () => {
		const t5 = b.openBatch();
		b.write(t5.id, a, 0, 42);
		const claimed = last(tr, 'slot-claim').data['slot'];
		const p4 = b.renderStart('A', [t5.id]);
		b.retire(t5.id);
		const def = last(tr, 'slot-release-deferred');
		expect(def.data).toEqual({ slot: claimed, batch: t5.id });
		expect(def.cause).toBe(last(tr, 'batch-retire').id);

		b.renderEnd(p4.id, 'discard');
		const end = last(tr, 'render-end');
		expect(end.data).toMatchObject({ renderPass: p4.id, disposition: 'discard' });
		const rel = last(tr, 'slot-release');
		expect(rel.data).toEqual({ slot: claimed, batch: t5.id });
		expect(rel.cause).toBe(end.id);
	});

	it('mount fixup: corrected (urgent pre-paint fix) when committed truth moved under the open render', () => {
		// retire the straggler batches (ambient, t2): live written batches would
		// (correctly) draw mount correctives on every mount below
		for (const t of b.liveBatches()) b.retire(t.id);
		const p5 = b.renderStart('A', []);
		b.mountWatcher(p5.id, c, 'W2'); // renders committed-at-pin: c = 42
		const t6 = b.openBatch();
		b.write(t6.id, a, 0, 50);
		b.retire(t6.id); // committedAdvance moves past p5's pin
		b.renderEnd(p5.id, 'commit');

		const fx = last(tr, 'mount-fixup');
		expect(fx.data).toEqual({ watcher: 'W2', root: 'A', disposition: 'corrected', correctives: 0 });
		const cor = last(tr, 'mount-correction');
		expect(cor.data).toEqual({ watcher: 'W2', from: 42, to: 50 });
	});

	it('mount fixup: fast-out with a post-pin write into a committed-live batch — corrective scheduled, no urgent correction', () => {
		const tc = b.openBatch();
		b.write(tc.id, a, 0, 70);
		const pc = b.renderStart('A', [tc.id]);
		b.renderWatcher(pc.id, w.id);
		b.renderEnd(pc.id, 'commit'); // tc locked in, still live
		const p7 = b.renderStart('A', []);
		b.mountWatcher(p7.id, c, 'W3'); // sees committed member tc: c = 70
		b.write(tc.id, a, 0, 80); // post-pin write, mask-batch-quiet
		b.renderEnd(p7.id, 'commit');

		// the write moved no condition (tc is a committed member, outside the
		// render mask), so the fast path holds and the corrective in tc's own
		// lane is the whole fix — no evaluation, no urgent correction
		const cor = last(tr, 'mount-corrective');
		expect(cor.data).toMatchObject({ watcher: 'W3', batch: tc.id });
		const fx = last(tr, 'mount-fixup');
		expect(fx.data).toEqual({ watcher: 'W3', root: 'A', disposition: 'fast-out', correctives: 1 });
		expect(all(tr, 'mount-correction').filter((e) => e.data['watcher'] === 'W3')).toHaveLength(0);
		b.retire(tc.id);
	});

	it('mount fixup: compare-clean when the fast-out fails but values agree', () => {
		const p8 = b.renderStart('A', []);
		b.mountWatcher(p8.id, c, 'W4'); // c = 80
		const t8 = b.openBatch();
		b.write(t8.id, bb, 0, 123); // c is on the a-path: value unaffected
		b.retire(t8.id); // committedAdvance moves → fast-out fails
		b.renderEnd(p8.id, 'commit');
		expect(last(tr, 'mount-fixup').data).toEqual({ watcher: 'W4', root: 'A', disposition: 'compare-clean', correctives: 0 });
	});

	it('nested world evaluations record post-order with depth', () => {
		// Engine mechanics: newest-world evaluations are memoized and `c`'s
		// memo is valid here, so a chain over it would serve the cache without
		// an inner eval record — nest through a FRESH inner node so both
		// evaluations genuinely run.
		const cn = b.computed('cn', (read) => (read(a) as number) + 1);
		const cc = b.computed('cc', (read) => (read(cn) as number) + 1);
		b.newestValue(cc);
		const evals = all(tr, 'eval').filter((e) => e.data['world'] === 'newest');
		const iC = evals.findIndex((e) => e.data['node'] === 'cn' && e.data['depth'] === 1);
		const iCC = evals.findIndex((e) => e.data['node'] === 'cc' && e.data['depth'] === 0);
		expect(iC).toBeGreaterThanOrEqual(0);
		expect(iCC).toBeGreaterThan(iC); // inner evaluation ends (and records) first
	});

	it('quiescence: epoch-reset recorded; the trace remains a chronicle of the dead episode', () => {
		// retire everything still live (batches t2 and the ambient batch)
		for (const t of b.liveBatches()) b.retire(t.id);
		b.quiesce();
		expect(last(tr, 'epoch-reset').data).toEqual({ epoch: 1 });
		// SESSION capture of the whole narrative is provably complete
		expect(tr.verifyComplete().complete).toBe(true);
		expect(tr.stats().dropped).toBe(0);
	});

	it('stable human format: fixed grammar #id +Δµs kind(subject) k=v … [<- #cause]', () => {
		const w1 = all(tr, 'write')[0]!;
		expect(formatTraceRecord(w1)).toMatch(/^#\d+ \+\d+µs write\(flag\) op=set batch=1 slot=0 seq=\d+$/);
		const d1 = all(tr, 'delivery')[0]!;
		expect(formatTraceRecord(d1)).toMatch(/^#\d+ \+\d+µs delivery\(W\) batch=1 slot=0 seq=\d+ mode=fresh <- #\d+$/);
		const fx = all(tr, 'mount-fixup')[0]!;
		expect(formatTraceRecord(fx)).toMatch(/^#\d+ \+\d+µs mount-fixup\(W\) root=A disposition=fast-out correctives=0 <- #\d+$/);
		const rc = all(tr, 'root-commit')[0]!;
		expect(formatTraceRecord(rc)).toMatch(/^#\d+ \+\d+µs root-commit\(A\) batch=2 commitGen=1 <- #\d+$/);
	});

	it('effectRunCount agrees with the referee-decoded stream', () => {
		const expected = tevents(tr, 'react-effect-run').filter((e) => e.effect === 'RE').length;
		expect(tr.effectRunCount('RE')).toBe(expected);
		expect(tr.effectRunCount('nope')).toBe(0);
	});
});

// ---- fuzz sweep: capture integrity + referee-decode coverage ------------------
// The packed stream is the engine's ONLY event output (the old cross-check
// against a parallel object stream died with that stream — decoded-stream
// correctness is now refereed where it matters, against the ORACLE, by
// concurrent-fuzz.spec's lockstep differ). What this sweep still owns:
// losslessness, total decode/format over every kind a real schedule
// produces, terminating causality, and the structural pairing between
// pre-consequence render-end records and post-consequence render markers.

describe('R11 fuzz sweep: lossless capture, total decode, terminating causality (oracle schedules)', () => {
	it('20 seeds × 60 steps: session lossless; decode/format total; referee decode covers the stream; causality terminates', () => {
		for (let seed = 1; seed <= 20; seed++) {
			const b = __newBridgeForTest();
			buildEngineTopology(b);
			b.registerBridge();
			const tr = attachTracer(b, { mode: 'session', refCapacity: 0 });
			for (const op of generateSchedule(seed, 60)) applyEngineOp(b, op);

			expect(tr.verifyComplete().complete, `seed ${seed}: session must be lossless`).toBe(true);
			const decoded = tr.events();
			expect(decoded.length).toBe(tr.stats().recorded);

			// the referee decoder maps every TraceEvent-vocabulary record and
			// nothing else (kind-for-kind agreement with a manual partition)
			const bridgeEvents = decodedTraceEvents(tr);
			const mapped = decoded.filter((e) => decodeTraceEvent(e) !== undefined);
			expect(bridgeEvents.length, `seed ${seed}: referee coverage`).toBe(mapped.length);
			// every render end has exactly one disposition record BEFORE its
			// consequences and exactly one referee marker after them
			const renderEnds = decoded.filter((e) => e.kind === 'render-end');
			const markers = decoded.filter((e) => e.kind === 'render-committed' || e.kind === 'render-discarded');
			expect(renderEnds.length, `seed ${seed}: render-end records`).toBe(markers.length);
			for (const m of markers) {
				expect(m.id, `seed ${seed}: marker #${m.id} must follow a render-end`).toBeGreaterThan(
					renderEnds.find((e) => e.data['renderPass'] === m.data['renderPass'] && e.data['root'] === m.data['root'])!.id,
				);
			}
			// causality always terminates at an operation root without leaving the capture
			for (const e of decoded.slice(-50)) {
				const chain = tr.causeChain(e.id);
				expect(chain.length).toBeGreaterThan(0);
				expect(chain[chain.length - 1]!.cause).toBeUndefined();
			}
			expect(formatTrace(decoded).split('\n')).toHaveLength(decoded.length);
			tr.stop();
		}
	});
});

describe('R11 slot backstop (fresh bridge: 31 live tenants, keep-the-dirt table)', () => {
	it('backstop release records loudly, then the claim proceeds', () => {
		const b = __newBridgeForTest();
		const a = b.atom('a', 0);
		b.registerBridge();
		const tr = attachTracer(b, { mode: 'session' });
		const batches = [];
		for (let i = 0; i < 31; i++) {
			const t = b.openBatch();
			batches.push(t);
			b.write(t.id, a, 0, i + 1);
		}
		const p = b.renderStart('A', batches.map((t) => t.id)); // masks all 31 slots
		for (const t of batches) b.retire(t.id); // all releases defer
		expect(all(tr, 'slot-release-deferred')).toHaveLength(31);

		const t32 = b.openBatch();
		b.write(t32.id, a, 0, 99); // no free slot → backstop
		const back = last(tr, 'slot-backstop-release');
		expect(back.data).toEqual({ slot: 0, batch: batches[0]!.id }); // oldest retiredSeq evicted
		expect(last(tr, 'slot-claim').data).toEqual({ slot: 0, batch: t32.id });
		b.renderEnd(p.id, 'discard');
		b.retire(t32.id);
	});
});

describe('fixed memory under a tracer: the engine retains nothing on the tracer’s behalf', () => {
	it('production posture: hammering writes stores records ONLY in the tracer’s own fixed ring', () => {
		const b = __newBridgeForTest(); // production posture — no event objects exist anywhere
		b.registerBridge();
		const a = b.atom('a', 0);
		const tr = attachTracer(b, { mode: 'ring', capacity: 256, now: tick() });
		const N = 5000;
		for (let i = 0; i < N; i++) {
			const t = b.openBatch();
			b.write(t.id, a, 0, i + 1);
			b.retire(t.id);
		}
		expect(tr.stats().recorded).toBeGreaterThanOrEqual(N * 3); // every site created, live (open+claim+write+retire+release per loop)
		expect(tr.stats().retained).toBe(256); // into the fixed ring — nothing engine-side grew
		expect(tr.stats().bytes).toBe(256 * 8 * 4); // record storage stayed exactly one ring
		tr.stop();
	});

	it('referee posture: a lossless session decodes the complete stream (lockstep needs it)', () => {
		const b = __newBridgeForTest();
		const stream = attachRefereeStream(b, { now: tick() }); // the referee’s session tracer
		b.registerBridge();
		const a = b.atom('a', 0);
		const t = b.openBatch();
		b.write(t.id, a, 0, 1);
		b.retire(t.id);
		expect(stream.eventsOfType('write')).toHaveLength(1); // full stream decodable for the referee
		expect(stream.eventsOfType('retired')).toHaveLength(1);
		expect(stream.tracer.verifyComplete().complete).toBe(true); // nothing dropped — provably
		expect(stream.tracer.stats().recorded).toBeGreaterThan(0);
	});
});
