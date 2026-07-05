/**
 * Quiet-mode writes (Phase 1b) — the owner-ratified short-circuit: while
 * NOTHING is pending (no live batch token, no open render pass, every tape
 * compacted, no event consumer), an unclassified write to a REGISTERED atom
 * folds directly — committed base and the kernel advance together; no
 * receipt, no tape append, no batch token (the ambient batch is NOT minted),
 * no delivery walk, no bridge event. The pipeline arms while anything is
 * pending and re-arms at the last retirement / pass close.
 *
 * This file is the quiet-mode referee: the oracle models always-receipt
 * semantics, so the lockstep corpus runs the engine with the short-circuit
 * DISABLED (referee mode — `__newBridgeForTest` defaults `setQuietWrites(false)`,
 * and retained events disarm quiet anyway); the arming/disarming schedules
 * below are pinned directly instead.
 */
import { describe, expect, it } from 'vitest';
import {
	__coreProbes,
	__newBridgeForTest,
	Atom,
	Computed,
	effect,
	ReducerAtom,
	type CosignalBridge,
} from '../src/index.js';

/** A fresh bridge in PRODUCTION posture: quiet ON, no event retention. */
function quietBridge(): CosignalBridge {
	const b = __newBridgeForTest();
	b.setRetainEvents(false);
	b.setQuietWrites(true);
	b.registerBridge();
	return b;
}

const probes = () => {
	const p = __coreProbes();
	return { receipts: p.receipts, tokens: p.tokens, events: p.bridgeEvents };
};

describe('quiet-mode writes', () => {
	it('arms at registration; quiet folds leave zero receipts/tokens/events and no ambient batch', () => {
		const b = quietBridge();
		expect(b.quiet).toBe(true);
		const a = b.atom('a', 0);
		const before = probes();
		(a.handle as Atom<number>).set(1);
		(a.handle as Atom<number>).update((v) => v + 1);
		expect(probes()).toEqual(before); // ZERO pipeline activity
		expect(a.tape).toHaveLength(0);
		expect(b.ambientToken).toBeUndefined();
		expect(b.newestValue(a)).toBe(2);
		expect(b.committedValue(a, 'A')).toBe(2); // base advanced WITH the kernel
		expect(b.quiescent()).toBe(true); // folds never leave pending state behind
	});

	it('write-heavy quiet phases interleaved with batch lifecycles: disarm at open, re-arm at last retirement', () => {
		const b = quietBridge();
		const a = b.atom('a', 0);
		(a.handle as Atom<number>).set(5); // quiet fold
		const t = b.openBatch('deferred');
		expect(b.quiet).toBe(false); // a live batch arms the pipeline
		(a.handle as Atom<number>).set(6); // armed: classifies into the AMBIENT batch
		expect(b.ambientToken).toBeDefined();
		expect(a.tape).toHaveLength(1);
		b.write(t.id, a, { kind: 'update', fn: (v) => (v as number) * 10 });
		expect(b.newestValue(a)).toBe(60);
		// A pass excluding both live batches folds committed base — which
		// already contains the QUIET fold (5), not the live receipts.
		const p = b.passStart('A', []);
		expect(b.passValue(a, p)).toBe(5);
		b.passEnd(p.id, 'discard');
		b.retire(b.ambientToken!, true);
		expect(b.quiet).toBe(false); // t is still live
		b.retire(t.id, true);
		expect(b.quiet).toBe(true); // LAST retirement: tapes compacted, quiet re-armed
		expect(a.tape).toHaveLength(0);
		expect(b.committedValue(a, 'A')).toBe(60);
		(a.handle as Atom<number>).set(61); // and folds resume
		expect(a.tape).toHaveLength(0);
		expect(b.committedValue(a, 'A')).toBe(61);
		expect(b.newestValue(a)).toBe(61);
	});

	it('a transition opened after quiet folds starts from committed base (per-root tables stay coherent)', () => {
		const b = quietBridge();
		const a = b.atom('a', 0);
		(a.handle as Atom<number>).set(5); // quiet history
		const t = b.openBatch('deferred');
		b.write(t.id, a, { kind: 'update', fn: (v) => (v as number) + 1 }); // folds over base 5
		const p = b.passStart('A', [t.id]);
		expect(b.passValue(a, p)).toBe(6); // the transition world = quiet base + its own receipt
		b.passEnd(p.id, 'commit');
		const root = b.root('A');
		expect(root.committedTokens.has(t.id)).toBe(true); // locked in at commit
		expect(b.committedValue(a, 'A')).toBe(6); // membership clause
		const genAtCommit = root.commitGen;
		b.retire(t.id, true);
		expect(root.committedTokens.size).toBe(0); // retired clause subsumes membership
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
		// Mount a watcher on c through a committed pass (the pass ARMS the
		// pipeline; quiet re-arms once it closes and nothing stays live).
		const p = b.passStart('A', []);
		const w = b.mountWatcher(p.id, c, 'w1');
		b.passEnd(p.id, 'commit');
		expect(b.quiet).toBe(true);
		let corrections = 0;
		let deliveries = 0;
		b.onCorrection = () => corrections++;
		b.onDelivery = () => deliveries++;
		const before = probes();
		(a.handle as Atom<number>).set(10); // quiet fold moves committed truth
		expect(probes()).toEqual(before); // still zero receipts/tokens/events
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
		const ce = b.mountCoreEffect(c, 'ce');
		const re = b.mountReactEffect('A', c, 're');
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
		expect(a.tape).toHaveLength(0);
		expect(b.quiet).toBe(true); // the rejected write disturbed nothing
		// Reducers: registered dispatch folds once over base.
		const rHandle = new ReducerAtom<number, string>((s, act) => (act === 'inc' ? s + 1 : s), 10);
		const r = b.adoptAtom('r', rHandle as unknown as Atom<number>);
		r.reducer = (s, act) => (act === 'inc' ? (s as number) + 1 : s);
		rHandle.dispatch('inc');
		expect(b.newestValue(r)).toBe(11);
		expect(b.committedValue(r, 'A')).toBe(11);
		expect(r.tape).toHaveLength(0);
	});

	it('pin-blocked arming: an open pass holds the pipeline armed past the last retirement; pass close compacts and re-arms', () => {
		const b = quietBridge();
		const a = b.atom('a', 0);
		const t = b.openBatch('deferred');
		b.write(t.id, a, { kind: 'set', value: 1 });
		const p = b.passStart('B', [t.id]); // pin freezes before the retirement below
		b.retire(t.id, true);
		// The pass's pin blocks compaction: the retired receipt is still on
		// the tape, so quiet must NOT re-arm (a fold would slide base under
		// a receipt that replays over it).
		expect(a.tape).toHaveLength(1);
		expect(b.quiet).toBe(false);
		(a.handle as Atom<number>).set(2); // armed semantics: ambient receipt
		expect(b.ambientToken).toBeDefined();
		expect(a.tape).toHaveLength(2);
		b.retire(b.ambientToken!, true);
		expect(b.quiet).toBe(false); // pass still open
		b.passEnd(p.id, 'discard'); // pin lapses: compaction drains, quiet re-arms
		expect(a.tape).toHaveLength(0);
		expect(b.quiet).toBe(true);
		(a.handle as Atom<number>).set(3);
		expect(a.tape).toHaveLength(0);
		expect(b.committedValue(a, 'B')).toBe(3);
		expect(b.newestValue(a)).toBe(3);
	});

	it('referee interlock: an event consumer keeps always-receipt semantics even with quietWrites enabled', () => {
		const b = __newBridgeForTest(); // events retained (referee posture)
		b.setQuietWrites(true); // the semantic switch alone must not fold past a referee
		b.registerBridge();
		expect(b.quiet).toBe(false); // eventsOn disarms quiet
		const a = b.atom('a', 0);
		(a.handle as Atom<number>).set(1);
		expect(b.ambientToken).toBeDefined(); // ambient batch minted: full pipeline
		expect(a.tape).toHaveLength(1);
		expect(b.eventsOfType('write').length).toBe(1);
	});

	it('quiesce() interoperates: epoch reset preserves quiet arming and folds keep working', () => {
		const b = quietBridge();
		const a = b.atom('a', 0);
		(a.handle as Atom<number>).set(41); // quiet fold
		expect(b.quiescent()).toBe(true);
		b.quiesce(); // renumbers sequences, bumps the epoch
		expect(b.quiet).toBe(true);
		(a.handle as Atom<number>).set(42); // folds fine in the new episode
		expect(b.newestValue(a)).toBe(42);
		expect(b.committedValue(a, 'A')).toBe(42);
		expect(a.tape).toHaveLength(0);
	});
});
