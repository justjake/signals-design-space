/**
 * Trace semantics coverage for cosignal/trace: every traced event class
 * fires with correct payloads on a representative schedule (a staged
 * narrative over one traced bridge, then a fuzz sweep cross-checking the
 * trace stream against the engine's BridgeEvent stream — the same event
 * vocabulary the reference model emits). Causality (CAUSE edges + queries)
 * and the stable human format are asserted here too.
 */
import { describe, expect, it } from 'vitest';
import { generateSchedule } from '../../cosignal-oracle/src/schedule.js';
import { __newBridgeForTest, type BridgeEvent, type CosignalBridge } from '../src/concurrent.js';
import { attachTracer, formatTrace, formatTraceEvent, Tracer, type TraceEvent, type TraceKind } from '../src/trace.js';
import { applyEngineOp, buildEngineTopology } from './oracle-adapter.js';

function tick(): () => number {
	let t = 0;
	return () => (t += 10);
}

/** All decoded events of a kind. */
function all(tr: Tracer, kind: TraceKind): TraceEvent[] {
	return tr.events(kind);
}

function last(tr: Tracer, kind: TraceKind): TraceEvent {
	const found = all(tr, kind);
	expect(found.length, `expected at least one ${kind} event`).toBeGreaterThan(0);
	return found[found.length - 1]!;
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

	it('pass lifecycle + mount fixup fast-out: pass-start/pass-end payloads, eval records, disposition', () => {
		const p1 = b.passStart('A', []);
		w = b.mountWatcher(p1.id, c, 'W');
		b.passEnd(p1.id, 'commit');

		expect(all(tr, 'pass-start')[0]!.data).toEqual({ pass: p1.id, root: 'A', pin: 0, maskSize: 0 });
		expect(all(tr, 'pass-start')[0]!.cause).toBeUndefined();
		const end = all(tr, 'pass-end')[0]!;
		expect(end.data).toEqual({ pass: p1.id, root: 'A', disposition: 'commit' });
		// world evaluations recorded: the mount render evaluated c in p1's world
		const evals = all(tr, 'eval');
		expect(evals.some((e) => e.data['node'] === 'c' && e.data['world'] === `pass:${p1.id}`)).toBe(true);
		// the fixup evaluated c in the fast-forwarded mount-fix world
		expect(evals.some((e) => e.data['node'] === 'c' && e.data['world'] === 'mount-fix:A')).toBe(true);
		// clean mount on a quiet root: fast-out, zero correctives; provoked by the commit
		const fx = all(tr, 'mount-fixup')[0]!;
		expect(fx.data).toEqual({ watcher: 'W', root: 'A', disposition: 'fast-out', correctives: 0 });
		expect(tr.causeChain(fx.id).map((e) => e.kind)).toContain('pass-end');
	});

	it('writes: batch-open, slot-claim, receipt payload with op, fresh delivery caused by the write', () => {
		const k = b.openBatch();
		b.write(k.id, flag, { kind: 'set', value: 1 });

		expect(all(tr, 'batch-open')[0]!.data).toEqual({ token: k.id, action: false, ambient: false });
		expect(all(tr, 'slot-claim')[0]!.data).toEqual({ slot: 0, token: k.id });
		const seq = b.eventsOfType('write')[0]!.seq; // the slot claim minted its own seq before the write's
		const w1 = all(tr, 'write')[0]!;
		expect(w1.data).toEqual({ node: 'flag', op: 'set', token: k.id, slot: 0, seq });
		expect(w1.cause).toBeUndefined(); // operation root
		const d1 = all(tr, 'delivery')[0]!;
		expect(d1.data).toEqual({ watcher: 'W', token: k.id, slot: 0, seq, mode: 'fresh' });
		expect(d1.cause).toBe(w1.id); // the delivery is provoked by its write

		// Engine mechanics: the flip's newest topology (c now reads a) is
		// discovered at evaluation sites, not by an eager per-write refresh —
		// pull once so the a→c edge is recorded (the retroactive replay on
		// the edge-add is silent here: W's dedup bit is already armed) and
		// the staged writes below walk the same dependency cone this
		// narrative assumes.
		b.newestValue(c);
	});

	it('dedup suppression: second write into the armed (watcher, slot) suppresses with a reason', () => {
		const k = 1; // token id from the previous stage
		b.write(k, flag, { kind: 'set', value: 2 });
		const w2 = all(tr, 'write')[1]!;
		expect(w2.cause).toBeUndefined(); // opEnd isolated the previous write's chain
		const s = all(tr, 'suppressed')[0]!;
		expect(s.data).toEqual({ watcher: 'W', token: k, slot: 0, seq: b.eventsOfType('suppressed')[0]!.seq, reason: 'dedup-pending-fold' });
		expect(s.cause).toBe(w2.id);
	});

	it('pass yield/resume edges; post-pin write delivers interleaved (§5.9)', () => {
		const p2 = b.passStart('A', [1]);
		b.passYield(p2.id);
		b.passResume(p2.id);
		expect(all(tr, 'pass-start')[1]!.data).toEqual({ pass: p2.id, root: 'A', pin: p2.pin, maskSize: 1 });
		expect(all(tr, 'pass-yield')[0]!.data).toEqual({ pass: p2.id, root: 'A' });
		expect(all(tr, 'pass-yield')[0]!.cause).toBeUndefined();
		expect(all(tr, 'pass-resume')[0]!.data).toEqual({ pass: p2.id, root: 'A' });

		b.write(1, a, { kind: 'set', value: 5 });
		const d = last(tr, 'delivery');
		const seq = b.eventsOfType('write')[2]!.seq;
		expect(d.data).toEqual({ watcher: 'W', token: 1, slot: 0, seq, mode: 'interleaved' });

		b.renderWatcher(p2.id, w.id);
		b.passEnd(p2.id, 'commit', { retireAtCommit: [1] });
	});

	it('retirement at commit chains: pass-end → batch-retire → slot-release (causeChain)', () => {
		const end = all(tr, 'pass-end')[1]!;
		expect(end.data['disposition']).toBe('commit');
		const ret = all(tr, 'batch-retire')[0]!;
		expect(ret.data).toEqual({ token: 1, retiredSeq: b.eventsOfType('retired')[0]!.retiredSeq, committed: true });
		expect(ret.cause).toBe(end.id); // retirement folded inside the commit
		const rel = all(tr, 'slot-release')[0]!;
		expect(rel.data).toEqual({ slot: 0, token: 1 });
		expect(tr.causeChain(rel.id).map((e) => e.kind)).toEqual(['slot-release', 'batch-retire', 'pass-end']);
	});

	it('per-root commit with generation; react effect run caused by it', () => {
		b.mountReactEffect('A', c, 'RE'); // committed c = 5
		const t2 = b.openBatch();
		b.write(t2.id, a, { kind: 'set', value: 7 });
		const p3 = b.passStart('A', [t2.id]);
		b.renderWatcher(p3.id, w.id);
		b.passEnd(p3.id, 'commit'); // lock-in without retirement

		const rc = all(tr, 'root-commit')[0]!;
		expect(rc.data).toEqual({ root: 'A', token: t2.id, commitGen: 1 });
		expect(rc.cause).toBe(all(tr, 'pass-end')[2]!.id);
		const re = all(tr, 'react-effect-run')[0]!;
		expect(re.data).toEqual({ effect: 'RE', root: 'A', value: 7 });
		expect(re.cause).toBe(rc.id);
		expect(tr.whyEffectRan('RE').map((e) => e.kind)).toEqual(['react-effect-run', 'root-commit', 'pass-end']);
	});

	it('core effect run caused by its write; reconcile-correction caused by a top-level retirement', () => {
		b.mountCoreEffect(c, 'CE'); // newest c = 7
		const t3 = b.openBatch();
		b.write(t3.id, a, { kind: 'set', value: 8 });
		const wr = last(tr, 'write');
		const ce = last(tr, 'core-effect-run');
		expect(ce.data).toEqual({ effect: 'CE', value: 8 });
		expect(ce.cause).toBe(wr.id);

		b.retire(t3.id, true); // top-level: an operation root, not chained to prior ops
		const ret = last(tr, 'batch-retire');
		expect(ret.cause).toBeUndefined();
		const rec = last(tr, 'reconcile-correction');
		expect(rec.data).toEqual({ watcher: 'W', root: 'A', from: 7, to: 8, cause: 'retirement' });
		expect(rec.cause).toBe(ret.id);
		expect(tr.whyDelivered('W').map((e) => e.kind)).toEqual(['reconcile-correction', 'batch-retire']);
	});

	it('write-dropped (§5.3 step 2) records the dropped token', () => {
		const t4 = b.openBatch();
		b.write(t4.id, bb, { kind: 'set', value: 0 }); // empty tape, equal against base
		expect(last(tr, 'write-dropped').data).toEqual({ node: 'b', token: t4.id });
		b.retire(t4.id, false);
	});

	it('action settlement: batch-settle is the root; its retirement chains under it', () => {
		const act = b.openBatch({ action: true });
		expect(last(tr, 'batch-open').data).toMatchObject({ token: act.id, action: true });
		b.scopeWrite(act.id, bb, { kind: 'set', value: 3 });
		b.settleAction(act.id, true);
		const settle = last(tr, 'batch-settle');
		expect(settle.data).toEqual({ token: act.id, committed: true });
		expect(settle.cause).toBeUndefined();
		const ret = last(tr, 'batch-retire');
		expect(ret.data).toMatchObject({ token: act.id, committed: true });
		expect(ret.cause).toBe(settle.id);
	});

	it('ambient classification and op kinds: update receipts (reducer-style closures included); bare writes stay lint-free', () => {
		const r = b.atom('r', 0);
		b.bareWrite(r, { kind: 'update', fn: (s) => (s as number) + 1 }); // the closure form a ReducerAtom dispatch records
		expect(last(tr, 'batch-open').data).toMatchObject({ ambient: true });
		expect(last(tr, 'write').data).toMatchObject({ node: 'r', op: 'update' });

		b.write(undefined, a, { kind: 'update', fn: (p) => (p as number) + 1 }); // a: 8 → 9
		expect(last(tr, 'write').data).toMatchObject({ node: 'a', op: 'update' });

		const act2 = b.openBatch({ action: true }); // parked
		b.bareWrite(a, { kind: 'set', value: 99 }); // classifies ambient; the post-await lint is adapter-only (no trace event)
		expect(last(tr, 'write').data).toMatchObject({ node: 'a', op: 'set' });
		b.settleAction(act2.id, false);
		expect(last(tr, 'batch-settle').data).toEqual({ token: act2.id, committed: false });
	});

	it('slot-release-deferred while an open mask names the slot; released at the discard pass-end', () => {
		const t5 = b.openBatch();
		b.write(t5.id, a, { kind: 'set', value: 42 });
		const claimed = last(tr, 'slot-claim').data['slot'];
		const p4 = b.passStart('A', [t5.id]);
		b.retire(t5.id, false);
		const def = last(tr, 'slot-release-deferred');
		expect(def.data).toEqual({ slot: claimed, token: t5.id });
		expect(def.cause).toBe(last(tr, 'batch-retire').id);

		b.passEnd(p4.id, 'discard');
		const end = last(tr, 'pass-end');
		expect(end.data).toMatchObject({ pass: p4.id, disposition: 'discard' });
		const rel = last(tr, 'slot-release');
		expect(rel.data).toEqual({ slot: claimed, token: t5.id });
		expect(rel.cause).toBe(end.id);
	});

	it('mount fixup: corrected (urgent pre-paint fix) when committed truth moved under the open pass', () => {
		// retire the straggler tokens (ambient, t2): live written batches would
		// (correctly) draw mount correctives on every mount below
		for (const t of b.liveTokens()) b.retire(t.id, true);
		const p5 = b.passStart('A', []);
		b.mountWatcher(p5.id, c, 'W2'); // renders committed-at-pin: c = 42
		const t6 = b.openBatch();
		b.write(t6.id, a, { kind: 'set', value: 50 });
		b.retire(t6.id, true); // cas moves past p5's pin
		b.passEnd(p5.id, 'commit');

		const fx = last(tr, 'mount-fixup');
		expect(fx.data).toEqual({ watcher: 'W2', root: 'A', disposition: 'corrected', correctives: 0 });
		const cor = last(tr, 'mount-correction');
		expect(cor.data).toEqual({ watcher: 'W2', from: 42, to: 50 });
	});

	it('mount fixup: fast-out-covered — post-pin write into a committed-live batch is exactly corrective-covered', () => {
		const tc = b.openBatch();
		b.write(tc.id, a, { kind: 'set', value: 70 });
		const pc = b.passStart('A', [tc.id]);
		b.renderWatcher(pc.id, w.id);
		b.passEnd(pc.id, 'commit'); // tc locked in, still live
		const p7 = b.passStart('A', []);
		b.mountWatcher(p7.id, c, 'W3'); // sees committed member tc: c = 70
		b.write(tc.id, a, { kind: 'set', value: 80 }); // post-pin write, mask-token-quiet
		b.passEnd(p7.id, 'commit');

		const cor = last(tr, 'mount-corrective');
		expect(cor.data).toMatchObject({ watcher: 'W3', token: tc.id });
		const fx = last(tr, 'mount-fixup');
		expect(fx.data).toEqual({ watcher: 'W3', root: 'A', disposition: 'fast-out-covered', correctives: 1 });
		b.retire(tc.id, true);
	});

	it('mount fixup: compare-clean when the fast-out fails but values agree', () => {
		const p8 = b.passStart('A', []);
		b.mountWatcher(p8.id, c, 'W4'); // c = 80
		const t8 = b.openBatch();
		b.write(t8.id, bb, { kind: 'set', value: 123 }); // c is on the a-path: value unaffected
		b.retire(t8.id, true); // cas moves → fast-out fails
		b.passEnd(p8.id, 'commit');
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
		// retire everything still live (tokens t2 and the ambient token)
		for (const t of b.liveTokens()) b.retire(t.id, true);
		b.quiesce();
		expect(last(tr, 'epoch-reset').data).toEqual({ epoch: 1 });
		// SESSION capture of the whole narrative is provably complete
		expect(tr.verifyComplete().complete).toBe(true);
		expect(tr.stats().dropped).toBe(0);
	});

	it('stable human format: fixed grammar #id +Δµs kind(subject) k=v … [<- #cause]', () => {
		const w1 = all(tr, 'write')[0]!;
		expect(formatTraceEvent(w1)).toMatch(/^#\d+ \+\d+µs write\(flag\) op=set token=1 slot=0 seq=\d+$/);
		const d1 = all(tr, 'delivery')[0]!;
		expect(formatTraceEvent(d1)).toMatch(/^#\d+ \+\d+µs delivery\(W\) token=1 slot=0 seq=\d+ mode=fresh <- #\d+$/);
		const fx = all(tr, 'mount-fixup')[0]!;
		expect(formatTraceEvent(fx)).toMatch(/^#\d+ \+\d+µs mount-fixup\(W\) root=A disposition=fast-out correctives=0 <- #\d+$/);
		const rc = all(tr, 'root-commit')[0]!;
		expect(formatTraceEvent(rc)).toMatch(/^#\d+ \+\d+µs root-commit\(A\) token=2 commitGen=1 <- #\d+$/);
	});

	it('effectRunCount agrees with the bridge event stream', () => {
		const expected = b.eventsOfType('react-effect-run').filter((e) => e.effect === 'RE').length;
		expect(tr.effectRunCount('RE')).toBe(expected);
		expect(tr.effectRunCount('nope')).toBe(0);
	});
});

// ---- trace stream ≡ BridgeEvent stream (cross-checked on generated schedules) ----

/** BridgeEvent → the trace record it must map to ('write' maps to the receipt-borne kind). */
function expectedTraceOf(e: BridgeEvent): { kind: TraceKind; data: Record<string, unknown> } | undefined {
	switch (e.type) {
		case 'write': return { kind: 'write', data: { node: e.node, token: e.token, slot: e.slot, seq: e.seq } };
		case 'write-dropped': return { kind: 'write-dropped', data: { node: e.node, token: e.token } };
		case 'delivery': return { kind: 'delivery', data: { watcher: e.watcher, token: e.token, slot: e.slot, seq: e.seq, mode: e.mode } };
		case 'suppressed': return { kind: 'suppressed', data: { watcher: e.watcher, token: e.token, slot: e.slot, seq: e.seq } };
		case 'core-effect-run': return { kind: 'core-effect-run', data: { effect: e.effect } };
		case 'react-effect-run': return { kind: 'react-effect-run', data: { effect: e.effect, root: e.root } };
		case 'reconcile-correction': return { kind: 'reconcile-correction', data: { watcher: e.watcher, root: e.root, cause: e.cause } };
		case 'mount-corrective': return { kind: 'mount-corrective', data: { watcher: e.watcher, token: e.token, slot: e.slot } };
		case 'mount-urgent-correction': return { kind: 'mount-correction', data: { watcher: e.watcher } };
		case 'per-root-commit': return { kind: 'root-commit', data: { root: e.root, token: e.token } };
		case 'retired': return { kind: 'batch-retire', data: { token: e.token, committed: e.committed, retiredSeq: e.retiredSeq } };
		case 'slot-claimed': return { kind: 'slot-claim', data: { slot: e.slot, token: e.token } };
		case 'slot-released': return { kind: 'slot-release', data: { slot: e.slot, token: e.token } };
		case 'slot-backstop-released': return { kind: 'slot-backstop-release', data: { slot: e.slot, token: e.token } };
		case 'epoch-reset': return { kind: 'epoch-reset', data: { epoch: e.epoch } };
		case 'pass-committed':
		case 'pass-discarded':
			return undefined; // mapped to the earlier pass-end record (asserted separately)
	}
}

const MIRRORED = new Set<TraceKind>([
	'write', 'write-dropped', 'delivery', 'suppressed', 'core-effect-run', 'react-effect-run',
	'reconcile-correction', 'mount-corrective', 'mount-correction', 'root-commit', 'batch-retire',
	'slot-claim', 'slot-release', 'slot-backstop-release', 'epoch-reset',
]);

describe('R11 fuzz cross-check: trace stream ≡ engine event stream (oracle schedules)', () => {
	it('20 seeds × 60 steps: mirrored kinds match 1:1 in order with payloads; capture lossless; decode/format total', () => {
		for (let seed = 1; seed <= 20; seed++) {
			const b = __newBridgeForTest();
			buildEngineTopology(b);
			b.registerBridge();
			const tr = attachTracer(b, { mode: 'session', refCapacity: 0 });
			for (const op of generateSchedule(seed, 60)) applyEngineOp(b, op);

			expect(tr.verifyComplete().complete, `seed ${seed}: session must be lossless`).toBe(true);
			const decoded = tr.events();
			expect(decoded.length).toBe(tr.stats().recorded);

			const expected = b.events.map(expectedTraceOf).filter((x) => x !== undefined);
			const mirrored = decoded.filter((e) => MIRRORED.has(e.kind));
			expect(mirrored.length, `seed ${seed}: mirrored event counts`).toBe(expected.length);
			for (let i = 0; i < expected.length; i++) {
				expect(mirrored[i]!.kind, `seed ${seed} event ${i}`).toBe(expected[i]!.kind);
				expect(mirrored[i]!.data, `seed ${seed} event ${i} payload`).toMatchObject(expected[i]!.data);
			}
			// every pass end has exactly one disposition record, and it precedes its consequences
			const passEnds = decoded.filter((e) => e.kind === 'pass-end');
			const bridgeEnds = b.events.filter((e) => e.type === 'pass-committed' || e.type === 'pass-discarded');
			expect(passEnds.length, `seed ${seed}: pass-end records`).toBe(bridgeEnds.length);
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
		const tokens = [];
		for (let i = 0; i < 31; i++) {
			const t = b.openBatch();
			tokens.push(t);
			b.write(t.id, a, { kind: 'set', value: i + 1 });
		}
		const p = b.passStart('A', tokens.map((t) => t.id)); // masks all 31 slots
		for (const t of tokens) b.retire(t.id, false); // all releases defer
		expect(all(tr, 'slot-release-deferred')).toHaveLength(31);

		const t32 = b.openBatch();
		b.write(t32.id, a, { kind: 'set', value: 99 }); // no free slot → backstop
		const back = last(tr, 'slot-backstop-release');
		expect(back.data).toEqual({ slot: 0, token: tokens[0]!.id }); // oldest retiredSeq evicted
		expect(last(tr, 'slot-claim').data).toEqual({ slot: 0, token: t32.id });
		b.passEnd(p.id, 'discard');
		b.retire(t32.id, false);
	});
});

describe('fixed memory under a tracer: the log retains nothing on the tracer’s behalf', () => {
	it('production posture (no referee): hammering writes leaves bridge.events empty while the tracer records', () => {
		const b = __newBridgeForTest();
		b.setRetainEvents(false); // production posture: no referee — a tracer is the only consumer
		b.registerBridge();
		const a = b.atom('a', 0);
		const tr = attachTracer(b, { mode: 'ring', capacity: 256, now: tick() });
		const N = 5000;
		for (let i = 0; i < N; i++) {
			const t = b.openBatch();
			b.write(t.id, a, { kind: 'set', value: i + 1 });
			b.retire(t.id, true);
		}
		expect(b.events.length).toBe(0); // the log retained NOTHING — fixed memory
		expect(b.eventCursor()).toBeGreaterThanOrEqual(N * 3); // yet events minted (the cursor counts them as dropped)
		expect(tr.stats().recorded).toBeGreaterThanOrEqual(N * 3); // and the tracer consumed every one, live
		expect(tr.stats().retained).toBe(256); // into its own fixed ring
		tr.stop();
	});

	it('referee posture: retention is unchanged with a tracer attached (lockstep needs complete streams)', () => {
		const b = __newBridgeForTest(); // retains events by default (referee mode)
		b.registerBridge();
		const a = b.atom('a', 0);
		const tr = attachTracer(b, { mode: 'session', now: tick() });
		const t = b.openBatch();
		b.write(t.id, a, { kind: 'set', value: 1 });
		b.retire(t.id, true);
		expect(b.eventsOfType('write')).toHaveLength(1); // full stream retained for the referee
		expect(b.eventsOfType('retired')).toHaveLength(1);
		expect(b.events.length).toBe(b.eventCursor()); // nothing dropped
		expect(tr.stats().recorded).toBeGreaterThan(0); // the tracer consumed the same stream
		tr.stop();
	});
});
