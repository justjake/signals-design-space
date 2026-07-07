/**
 * Quiet-mode writes (Phase 1b) — the owner-ratified short-circuit: while
 * NOTHING is pending (no live batch, no open render pass, every write log
 * compacted), an unclassified write to a REGISTERED atom folds directly —
 * committed base and the kernel advance together; no log entry, no write log
 * append, no batch (the ambient batch is NOT created), no delivery
 * walk. The pipeline arms while anything is pending and re-arms at the last
 * retirement / render close. Observation never perturbs the derivation: an
 * attached tracer gets ONE quiet-write record per accepted fold and the
 * write path stays the quiet one.
 *
 * The oracle mirrors the same derivation and fold, so the lockstep corpus
 * referees quiet semantics directly ('quiet-write' is a compared event);
 * this file pins the arming/disarming schedules by hand.
 */
import { describe, expect, it } from 'vitest';
import { mountEngineCoreEffect, mountEngineReactEffect } from './helpers.js';
import { attachRefereeStream } from './trace-events.js';
import {
	__coreProbes,
	__resetEngineForTest,
	Atom,
	Computed,
	effect,
	engine,
	ReducerAtom,
	type CosignalEngine,
} from '../src/index.js';

/** A fresh engine in PRODUCTION posture — which is the only posture now: no
 * driver, no tracer (quiet arms by derivation alone — there is no semantic
 * switch to flip; always-concurrent means composition IS activation). */
function quietBridge(): CosignalEngine {
	engine.discardAllWip();
	for (const t of engine.liveBatches()) {
		if (t.parked) engine.settleAction(t.id);
		else engine.retire(t.id);
	}
	__resetEngineForTest();
	return engine;
}

const probes = () => {
	const p = __coreProbes();
	return { logEntries: p.logEntries, batches: p.batches };
};

describe('quiet-mode writes', () => {
	it('arms at composition; quiet folds leave zero log entries/batches/events and no ambient batch', () => {
		const b = quietBridge();
		expect(b.quiet).toBe(true);
		const a = b.atom('a', 0);
		const before = probes();
		(a.handle as Atom<number>).set(1);
		(a.handle as Atom<number>).update((v) => v + 1);
		expect(probes()).toEqual(before); // ZERO pipeline activity
		expect(a.log.materialize()).toHaveLength(0);
		expect(b.ambientBatch).toBeUndefined();
		expect(b.newestValue(a)).toBe(2);
		expect(b.committedValue(a, 'A')).toBe(2); // base advanced WITH the kernel
		expect(b.quiescent()).toBe(true); // folds never leave pending state behind
	});

	it('write-heavy quiet phases interleaved with batch lifecycles: disarm at open, re-arm at last retirement', () => {
		const b = quietBridge();
		const a = b.atom('a', 0);
		(a.handle as Atom<number>).set(5); // quiet fold
		const t = b.openBatch();
		expect(b.quiet).toBe(false); // a live batch arms the pipeline
		(a.handle as Atom<number>).set(6); // armed: classifies into the AMBIENT batch
		expect(b.ambientBatch).toBeDefined();
		expect(a.log.materialize()).toHaveLength(1);
		b.write(t.id, a, 1, (v: unknown) => (v as number) * 10);
		expect(b.newestValue(a)).toBe(60);
		// A render excluding both live batches folds committed base — which
		// already contains the QUIET fold (5), not the live log entries.
		const p = b.renderStart('A', []);
		expect(b.renderValue(a, p)).toBe(5);
		b.renderEnd(p.id, 'discard');
		b.retire(b.ambientBatch!);
		expect(b.quiet).toBe(false); // t is still live
		b.retire(t.id);
		expect(b.quiet).toBe(true); // LAST retirement: write logs compacted, quiet re-armed
		expect(a.log.materialize()).toHaveLength(0);
		expect(b.committedValue(a, 'A')).toBe(60);
		(a.handle as Atom<number>).set(61); // and folds resume
		expect(a.log.materialize()).toHaveLength(0);
		expect(b.committedValue(a, 'A')).toBe(61);
		expect(b.newestValue(a)).toBe(61);
	});

	it('a transition opened after quiet folds starts from committed base (per-root tables stay coherent)', () => {
		const b = quietBridge();
		const a = b.atom('a', 0);
		(a.handle as Atom<number>).set(5); // quiet history
		const t = b.openBatch();
		b.write(t.id, a, 1, (v: unknown) => (v as number) + 1); // folds over base 5
		const p = b.renderStart('A', [t.id]);
		expect(b.renderValue(a, p)).toBe(6); // the transition world = quiet base + its own log entry
		b.renderEnd(p.id, 'commit');
		const root = b.root('A');
		expect(root.committedBatches.has(t.id)).toBe(true); // locked in at commit
		expect(b.committedValue(a, 'A')).toBe(6); // membership clause
		const genAtCommit = root.commitGen;
		b.retire(t.id);
		expect(root.committedBatches.size).toBe(0); // retired clause subsumes membership
		expect(root.committedDirtySlots).toBe(0);
		expect(b.quiet).toBe(true);
		(a.handle as Atom<number>).set(7); // quiet again
		expect(b.committedValue(a, 'A')).toBe(7);
		expect(root.commitGen).toBe(genAtCommit); // quiet folds advance values, not commit generations
	});

	it('live watchers reconcile value-gated while quiet: corrections fire, deliveries do not', () => {
		const b = quietBridge();
		const a = b.atom('a', 0);
		const c = b.computed('c', (read) => (read(a) as number) + 1);
		// Mount a watcher on c through a committed render (the render ARMS the
		// pipeline; quiet re-arms once it closes and nothing stays live).
		const p = b.renderStart('A', []);
		const w = b.mountWatcher(p.id, c, 'w1');
		b.renderEnd(p.id, 'commit');
		expect(b.quiet).toBe(true);
		let corrections = 0;
		let deliveries = 0;
		b.onCorrection = () => corrections++;
		b.onDelivery = () => deliveries++;
		const before = probes();
		(a.handle as Atom<number>).set(10); // quiet fold moves committed truth
		expect(probes()).toEqual(before); // still zero log entries/batches/events
		expect(corrections).toBe(1); // urgent value-gated correction reached the watcher
		expect(deliveries).toBe(0); // NO value-blind delivery walk ran
		expect(w.lastRenderedValue).toBe(11); // reconciled to committed-now
		(a.handle as Atom<number>).set(10); // equal write: dropped before any observer work
		(a.handle as Atom<number>).update((v) => v); // identity updater: dropped too
		expect(corrections).toBe(1);
	});

	it('core effects and committed React effects observe quiet folds, value-gated', () => {
		const b = quietBridge();
		const a = b.atom('a', 0);
		const c = b.computed('c', (read) => (read(a) as number) * 2);
		const ce = mountEngineCoreEffect(b, c, 'ce'); // real kernel effect(): the quiet fold's direct kernel apply flushes it
		const re = mountEngineReactEffect(b, 'A', c, 're');
		const ceRuns = ce.runs;
		const reRuns = re.runs;
		(a.handle as Atom<number>).set(3); // quiet fold
		expect(ce.runs).toBe(ceRuns + 1);
		expect(ce.lastValue).toBe(6);
		expect(re.runs).toBe(reRuns + 1);
		expect(re.lastValue).toBe(6);
		(a.handle as Atom<number>).update((v) => v); // no-op: value-gated everywhere
		expect(ce.runs).toBe(ceRuns + 1);
		expect(re.runs).toBe(reRuns + 1);
		// Kernel-level effects see the folds too (the fold applies to the kernel).
		let kernelSeen = 0;
		const k = new Computed(() => (a.handle as Atom<number>).state + 100);
		const dispose = effect(() => {
			kernelSeen = k.state;
		});
		(a.handle as Atom<number>).set(4);
		expect(kernelSeen).toBe(104);
		dispose();
	});

	it('quiet folds run updaters/reducers under both fold-purity guards and leave no state on rejection', () => {
		const b = quietBridge();
		const a = b.atom('a', 1);
		const handle = a.handle as Atom<number>;
		expect(() => handle.update((n) => n + handle.state)).toThrow(/not allowed inside an update|updaters and reducers must be pure/);
		expect(b.newestValue(a)).toBe(1);
		expect(b.committedValue(a, 'A')).toBe(1);
		expect(a.log.materialize()).toHaveLength(0);
		expect(b.quiet).toBe(true); // the rejected write disturbed nothing
		// Reducers: registered dispatch folds once over base (the recorded op
		// is an update whose closure carries the reducer and the action).
		const rHandle = new ReducerAtom<number, string>((s, act) => (act === 'inc' ? s + 1 : s), 10);
		const r = b.internalsForAtom(rHandle as unknown as Atom<number>);
		r.name = 'r';
		rHandle.dispatch('inc');
		expect(b.newestValue(r)).toBe(11);
		expect(b.committedValue(r, 'A')).toBe(11);
		expect(r.log.materialize()).toHaveLength(0);
	});

	it('pin-blocked arming: an open render holds the pipeline armed past the last retirement; render close compacts and re-arms', () => {
		const b = quietBridge();
		const a = b.atom('a', 0);
		const t = b.openBatch();
		b.write(t.id, a, 0, 1);
		const p = b.renderStart('B', [t.id]); // pin freezes before the retirement below
		b.retire(t.id);
		// The render's pin blocks compaction: the retired log entry is still on
		// the write log, so quiet must NOT re-arm (a fold would slide base under
		// a log entry that replays over it).
		expect(a.log.materialize()).toHaveLength(1);
		expect(b.quiet).toBe(false);
		(a.handle as Atom<number>).set(2); // armed semantics: ambient log entry
		expect(b.ambientBatch).toBeDefined();
		expect(a.log.materialize()).toHaveLength(2);
		b.retire(b.ambientBatch!);
		expect(b.quiet).toBe(false); // render still open
		b.renderEnd(p.id, 'discard'); // pin lapses: compaction drains, quiet re-arms
		expect(a.log.materialize()).toHaveLength(0);
		expect(b.quiet).toBe(true);
		(a.handle as Atom<number>).set(3);
		expect(a.log.materialize()).toHaveLength(0);
		expect(b.committedValue(a, 'B')).toBe(3);
		expect(b.newestValue(a)).toBe(3);
	});

	it('an attached tracer does not disarm quiet: writes still fold quietly AND their records appear', () => {
		const b = quietBridge();
		const stream = attachRefereeStream(b); // referee posture: the packed stream is the event channel
		expect(b.quiet).toBe(true); // observation never changes which write path executes
		const a = b.atom('a', 0);
		(a.handle as Atom<number>).set(1);
		expect(b.ambientBatch).toBeUndefined(); // NO ambient batch: the quiet fold ran
		expect(a.log.materialize()).toHaveLength(0); // no log entry
		expect(stream.eventsOfType('write').length).toBe(0);
		expect(stream.eventsOfType('quiet-write')).toEqual([{ type: 'quiet-write', node: 'a', seq: a.baseSeq }]);
		expect(b.newestValue(a)).toBe(1);
		expect(b.committedValue(a, 'A')).toBe(1); // base advanced WITH the kernel
		// The equality drop stays silent — no batch exists to attribute a drop to.
		(a.handle as Atom<number>).set(1);
		expect(stream.eventsOfType('quiet-write')).toHaveLength(1);
		expect(stream.eventsOfType('write-dropped')).toHaveLength(0);
		// Armed semantics still create log entries + write records past the same consumer.
		const t = b.openBatch();
		expect(b.quiet).toBe(false);
		(a.handle as Atom<number>).set(2);
		expect(stream.eventsOfType('write').length).toBe(1);
		b.retire(b.ambientBatch!);
		b.retire(t.id);
		expect(b.quiet).toBe(true); // and quiet re-arms with the consumer still attached
	});

	it('quiesce() interoperates: epoch reset preserves quiet arming and folds keep working', () => {
		const b = quietBridge();
		const a = b.atom('a', 0);
		(a.handle as Atom<number>).set(41); // quiet fold
		expect(b.quiescent()).toBe(true);
		b.quiesce(); // episode reset: bumps the epoch (sequences keep climbing)
		expect(b.quiet).toBe(true);
		(a.handle as Atom<number>).set(42); // folds fine in the new episode
		expect(b.newestValue(a)).toBe(42);
		expect(b.committedValue(a, 'A')).toBe(42);
		expect(a.log.materialize()).toHaveLength(0);
	});
});
