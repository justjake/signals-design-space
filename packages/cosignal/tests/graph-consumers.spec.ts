/**
 * GRAPH-CONSUMER COHERENCE AUDIT. The engine keeps two edge stores — K0 (the
 * kernel's packed dependency links, index.ts) and K1 (the engine's episode
 * edge log + watcher/effect indexes, logged.ts) — and every consumer of
 * edge/subscriber/liveness state must decide explicitly which store(s) it
 * consults. Each row below is that decision; rows whose enforcement was
 * NOTHING are pinned by the tests in this file (the suite IS the audit).
 *
 * §1 CONSUMERS ─ consumer (site) | stores | verdict | enforcement
 *  1  linkInsert first-sub branch (index.ts D1)        | K0 edge → union refcount | UNION (kernel 0→1 half)   | graph.spec, observe-union.spec, T1
 *  2  unwatched() signal branch (index.ts D1)          | K0 edge → union refcount | UNION (kernel 1→0 half)   | observe-union.spec 'kernel+watcher=ONE', T1
 *  3  unwatched() computed branch (lazy re-track)      | K0                       | K0-ONLY: kernel liveness is kernel memory mgmt; overlay computeds hold no kernel records | conformance 179, T3
 *  4  unwatched()/dispose() effect+scope auto-dispose  | K0                       | K0-ONLY: scope nesting is a kernel structure | conformance, graph.spec, T4
 *  5  notify() parent-chain SUBS read (outer-first)    | K0                       | K0-ONLY: effect nesting is kernel-only | conformance ordering cases
 *  6  kernel propagate/shallowPropagate seeds          | K0                       | K0-ONLY BY DESIGN: kernel flush serves K0 subscribers; K1 consumers get the delivery walk; union = the SUM of both paths | logged-scars S2/S3, T5
 *  7  invalidateComputed (suspense settle)             | K0                       | K0-ONLY: boxes live on kernel computeds; overlay folds SuspendedRead as a value | suspense.spec
 *  8  Atom.state host seam (index.ts)                  | K0 or world              | ROUTE-BY-FRAME: world routing only with NO kernel frame open; a kernel-frame read makes a K0 link + fills a K0 cache, so it must serve K0 (newest) — FIXED (was: world-routed → kernel cache poisoned = torn newest plane) | T6 (new), one-core 'overlay world evaluation' pins the routed side
 *  9  Computed.state (no host seam)                    | K0                       | K0-ONLY: standalone computeds are not world-routable (bindings reject via resolveNode) | T6, hooks.ts resolveNode error
 * 10  deliveryWalk (outList+watchersByNode+coreFx)     | K1                       | K1-ONLY: K0 consumers already served by eager kernel apply | battery case 1, scars S2/S3, T5
 * 11  marking walk + recordEdge bit inheritance        | K1                       | K1-ONLY; feeds touched words; retroactive edges inherit source bits | fuzz, T9
 * 12  propagateTaint / weak (untracked) edges          | K1 weak                  | K1-WEAK-ONLY: drain candidates, never deliveries | battery 'taint member', fuzz
 * 13  sweepK1 reachability seeds (byNode lists+inList) | K1                       | K1-ONLY | long-seed fuzz (episode churn), T7
 * 14  drainCommittedObservers (slotTouched+weak+outs)  | K1                       | K1-ONLY, conservative | lockstep drain parity, scars S26, T9
 * 15  mountFixup dependencyClosureOf (inList)          | K1                       | K1-ONLY: worlds fold receipts, kernel links irrelevant | battery cases 9/10 + the always-on fast-out audit (BridgeInvariantViolation)
 * 16  quiesce refresh-target collection (byNode+lists) | K1                       | K1-ONLY | quiet-mode 'quiesce() interoperates', T7
 * 17  Watcher.live setter → obsShift → retain/release  | K1 edge → union refcount | UNION (watcher half, via the observed-closure plane) | observe-union.spec (all), T1
 * 18  observed-closure plane (obsRefs/obsDeps/capture) | eval-time strong deps → K0 lifecycle | UNION-TRANSITIVE: a live watcher observes every atom its node's CURRENT evaluation (transitively) reads — retains follow fn re-runs (dep flips move them), survive quiescence, and release with the last watcher — FIXED (was: only DIRECT atom watchers retained; useComputed+useSignal left closure atoms unobserved) | T2 (flipped pin), observe-transitive.spec
 * 19  watchers map + watchersByNode index mutation     | K1 dual store            | MUST MOVE TOGETHER via removeWatcher — FIXED (shim's map-only deletes stranded index entries: dead watchers seeded sweeps + quiesce refresh forever) | T7 (new), cosignal-react graph-consumers.spec.tsx
 * 20  episodeEdges/graphviz snapshot                   | K1                       | K1-ONLY diagnostics (documented: edges recorded since idle) | graphviz docstring; not behavior-bearing
 * 21  shim liveness flips (claim/orphan/finalize)      | K1 via one setter        | UNION + both stores (delegates to Watcher.live + removeWatcher) | cosignal-react hooks.spec StrictMode netting + graph-consumers.spec.tsx
 * 22  useSignal render branches (watchers.get/w.live)  | K1                       | K1-ONLY: bridge watcher records are the one source | cosignal-react battery/hooks.spec
 * 23  committed-subscription dep snapshots (captureRun) | committed VALUES + obs union + subDepRefs | value-gated per EF2 boundary, no edge store; snapshot nodes retain OL1 and seed sweep/quiesce coverage | logged-battery case 16, observe-union.spec, cosignal-react hooks.spec useSignalEffect
 *
 * §2 DUAL-REPRESENTATION AGREEMENTS ─ pair | enforcement
 *  A1 kernel value ≡ fold(base, receipts)              | lockstep EVERY step: oracle-adapter snapshot `newest` reads the kernel plane, the model folds; logged-fuzz.spec 'diff clean' + logged-battery
 *  A2 memo fingerprints ≡ tapes (+retirement stamps)   | lockstep values; scars S5 pins receipt-after-read invalidation
 *  A3 quiet flag ≡ pending state (tokens/passes/tapes) | quiet-mode.spec arming/disarming battery
 *  A4 adoption stamp ≡ byKernelId registry             | T8 (new pin): stale foreign stamps re-resolve via the registry probe, writes land on the ACTIVE bridge's node
 *  A5 touched words ⊇ K1 reachability (UNDER-approx impossible: write sets source bit; recordEdge inherits bits over NEW edges; clears are pin-gated) | lockstep + T9 (new pin: post-write edge still drained)
 *  A6 observation refcount ≡ live consumers            | observe-union.spec + T1/T2
 *  A7 committedBits ≡ committedTokens×slot             | rebuildCommittedBits at retire + internSlot back-fill; battery case 11, scars S19a
 *  A8 pass maskBits/includedBits ≡ mask/captured sets  | derived once at passStart from one loop; lockstep pass worlds
 *  A9 token.atomsTouched ⊇ tape token columns          | retirement stamping via touch lists; quiesce residue BridgeInvariantViolation + lockstep retirement visibility
 * A10 token.liveReceipts ≡ un-compacted receipts       | T10 (new pin: token outlives pinned receipts, reclaims after compaction)
 * A11 slotTouched lists ≡ touched words                | applyBits appends per newly-set bit; lockstep drain parity + T9 exercises the list path
 * A12 shim previousCells ≡ last committed value        | cosignal-react hooks.spec 'ctx.previous returns the last committed value'
 */
import { describe, expect, it } from 'vitest';
import { Atom, Computed, effect, effectScope, __newBridgeForTest, type CosignalBridge } from '../src/index.js';

const tick = (): Promise<void> => new Promise<void>((res) => queueMicrotask(res));

/** Fresh registered bridge in referee posture (events retained, quiet off). */
function bridge(): CosignalBridge {
	const b = __newBridgeForTest();
	b.registerBridge();
	return b;
}

function observedAtom(initial: number): { atom: Atom<number>; log: string[] } {
	const log: string[] = [];
	const atom = new Atom(initial, {
		effect: () => {
			log.push('observe');
			return () => log.push('unobserve');
		},
	});
	return { atom, log };
}

describe('§1 rows 1/2/17 — observation is a UNION refcount over both stores', () => {
	it('T1: fires with K1 empty (kernel-only), holds across a store handoff, releases only when both empty', async () => {
		const b = bridge();
		const { atom, log } = observedAtom(0);
		const node = b.adoptAtom('a', atom as Atom<unknown>);
		const dispose = effect(() => {
			void atom.state; // K0 subscriber; K1 watcher plane holds nothing
		});
		await tick();
		expect(log).toEqual(['observe']);
		expect(b.watchers.size).toBe(0); // the disagreement: K1 says "no consumers"
		const p = b.passStart('A', []);
		const w = b.mountWatcher(p.id, node, 'W');
		b.passEnd(p.id, 'commit'); // K1 watcher joins
		dispose(); // K0 SUBS now empty — the stores disagree; the union must hold
		await tick();
		expect(log).toEqual(['observe']);
		w.live = false; // last consumer of EVERY kind leaves
		await tick();
		expect(log).toEqual(['observe', 'unobserve']);
	});

	it('T2: UNION-TRANSITIVE (row 18) — a watcher over an overlay COMPUTED retains the atoms its evaluation reads; a direct atom watcher joining is an interior transition', async () => {
		const b = bridge();
		const { atom, log } = observedAtom(0);
		const node = b.adoptAtom('a', atom as Atom<unknown>);
		const oc = b.computed('oc', (read) => read(node));
		const p = b.passStart('A', []);
		const wc = b.mountWatcher(p.id, oc, 'WC'); // no direct atom watcher anywhere
		b.passEnd(p.id, 'commit');
		await tick();
		expect(log).toEqual(['observe']); // the closure atom IS observed through the derived node
		const p2 = b.passStart('A', []);
		const wa = b.mountWatcher(p2.id, node, 'WA'); // direct atom watcher joins the same union
		b.passEnd(p2.id, 'commit');
		await tick();
		expect(log).toEqual(['observe']); // interior transition: no re-observe
		wa.live = false; // direct consumer leaves; the transitive one still holds
		await tick();
		expect(log).toEqual(['observe']);
		wc.live = false; // last consumer of EVERY kind leaves
		await tick();
		expect(log).toEqual(['observe', 'unobserve']);
	});
});

describe('§1 rows 3/4 — kernel liveness transitions consult K0 only', () => {
	it('T3: an unwatched kernel computed goes lazy-dirty regardless of live K1 watchers over the same atom', () => {
		const b = bridge();
		const handle = new Atom(1);
		const node = b.adoptAtom('a', handle as Atom<unknown>);
		const p = b.passStart('A', []);
		const w = b.mountWatcher(p.id, b.computed('oc', (read) => read(node)), 'W');
		b.passEnd(p.id, 'commit'); // K1 holds a live watcher over the atom
		let evals = 0;
		const kc = new Computed(() => {
			evals++;
			return handle.state;
		});
		const dispose = effect(() => {
			void kc.state;
		});
		expect(evals).toBe(1);
		dispose(); // K0: last subscriber left → unwatched(kc) drops deps + marks dirty
		expect(kc.state).toBe(1);
		expect(evals).toBe(2); // recomputed although no dep changed and K1 still "watches" the atom
		w.live = false;
	});

	it('T4: scope disposal auto-disposes child effects through K0 parent links alone', () => {
		const a = new Atom(0);
		let runs = 0;
		const disposeScope = effectScope(() => {
			effect(() => {
				void a.state;
				runs++;
			});
		});
		expect(runs).toBe(1);
		disposeScope();
		a.set(5);
		expect(runs).toBe(1); // child died with the scope — no K1 involvement exists here
	});
});

describe('§1 rows 6/10 — one logged write notifies via BOTH stores (K0 flush + K1 walk), each serving its own consumers', () => {
	it('T5: a kernel effect (no K1 record) and a bridge watcher (no K0 link) both hear one write', () => {
		const b = bridge();
		const handle = new Atom(0);
		const node = b.adoptAtom('a', handle as Atom<unknown>);
		let kernelSeen = -1;
		const dispose = effect(() => {
			kernelSeen = handle.state as number; // K0 subscriber
		});
		const oc = b.computed('oc', (read) => read(node));
		const p = b.passStart('A', []);
		b.mountWatcher(p.id, oc, 'W'); // K1 subscriber (edge a→oc recorded by the mount eval)
		b.passEnd(p.id, 'commit');
		const mark = b.eventCursor();
		const t = b.openBatch();
		b.write(t.id, node, { kind: 'set', value: 9 });
		expect(kernelSeen).toBe(9); // K0: eager kernel apply flushed the effect
		expect(b.eventsSince(mark).some((e) => e.type === 'delivery' && e.watcher === 'W')).toBe(true); // K1: delivery walk
		b.retire(t.id, true);
		dispose();
	});
});

describe('§1 rows 8/9 — kernel-frame reads are NEVER world-routed (the fix + its boundary)', () => {
	it('T6: a kernel computed evaluated inside a pass world reads K0 (newest), records no K1 edge, and its cache stays newest-coherent', () => {
		const b = bridge();
		const handle = new Atom(0);
		const node = b.adoptAtom('a', handle as Atom<unknown>);
		let kcEvals = 0;
		const kc = new Computed(() => {
			kcEvals++;
			return (handle.state as number) + 100;
		});
		const c = b.computed('c', () => kc.state); // standalone kernel computed inside an overlay fn
		const t = b.openBatch();
		b.write(t.id, node, { kind: 'set', value: 5 }); // kernel newest = 5
		const p = b.passStart('A', []); // t excluded: the pass world's a is 0
		// kc's evaluation is a KERNEL frame: its atom read serves the kernel
		// plane, never the pass world (pre-fix: 100 here — and a torn cache).
		expect(b.passValue(c, p)).toBe(105);
		expect(kcEvals).toBe(1);
		expect(b.episodeEdges.size).toBe(0); // the kernel read left no K1 edge (row 9: delivery-blind by design)
		const routed = b.computed('r', () => handle.state); // contrast: overlay-frame handle read IS world-routed
		expect(b.passValue(routed, p)).toBe(0);
		b.passEnd(p.id, 'discard');
		// The kernel's newest plane stayed coherent with the eager-apply
		// invariant (A1): pre-fix this read served 0-world residue (100).
		expect(kc.state).toBe(105);
		b.retire(t.id, true);
	});
});

describe('§1 rows 13/16/19 — the two watcher stores move together (removeWatcher)', () => {
	it('T7: removeWatcher retires the id map, the per-node walk index, and open mounted lists in one call', () => {
		const b = bridge();
		const a = b.atom('a', 0);
		let evals = 0;
		const c = b.computed('c', (read) => {
			evals++;
			return read(a);
		});
		const p = b.passStart('A', []);
		const w = b.mountWatcher(p.id, c, 'W');
		b.passEnd(p.id, 'commit');
		expect(b.watchers.size).toBe(1);
		b.removeWatcher(w.id);
		expect(b.watchers.size).toBe(0);
		expect(w.live).toBe(false); // liveness (and any observation retain) released
		const before = evals;
		b.quiesce(); // refresh targets = K1-touched nodes still holding watcher/effect snapshots
		expect(evals).toBe(before); // a map-only delete would leave c listed and re-evaluate it here
		// Removal inside an open pass scrubs the mounted list: commit must not revive it.
		const p2 = b.passStart('A', []);
		const w2 = b.mountWatcher(p2.id, c, 'W2');
		b.removeWatcher(w2.id);
		b.passEnd(p2.id, 'commit');
		expect(b.watchers.size).toBe(0);
	});
});

describe('§2 A4 — adoption stamp vs registry', () => {
	it('T8: a foreign bridge stamp never leaks — nodeFor validates against THIS bridge and writes land on the ACTIVE one', () => {
		const b1 = bridge();
		const handle = new Atom(0);
		const n1 = b1.adoptAtom('a', handle as Atom<unknown>);
		const b2 = bridge(); // replaces the active routing; handle's stamp now points at b2 after re-adoption
		const n2 = b2.adoptAtom('a', handle as Atom<unknown>);
		expect(b1.nodeFor(handle as Atom<unknown>)).toBe(n1); // registry probe backstops the foreign stamp
		expect(b2.nodeFor(handle as Atom<unknown>)).toBe(n2); // (and re-stamps per bridge)
		handle.set(1); // public write → the ACTIVE bridge's node, whatever the stamp said last
		expect(n2.tp.length).toBe(1);
		expect(n1.tp.length).toBe(0);
	});
});

describe('§2 A5/A11 + rows 11/14 — touched words may over-approximate, never under-approximate', () => {
	it('T9: an edge recorded AFTER the write inherits the slot bit, so the retirement drain still reaches the watcher', () => {
		const b = bridge();
		const a = b.atom('a', 0);
		const c = b.computed('c', (read) => read(a));
		const t = b.openBatch();
		b.write(t.id, a, { kind: 'set', value: 7 }); // bit lands on `a`; no K1 edges exist yet
		const p = b.passStart('A', []); // pin postdates the write; t excluded → renders base
		const w = b.mountWatcher(p.id, c, 'W'); // the mount eval records a→c NOW (retroactive edge)
		expect(w.lastRenderedValue).toBe(0);
		b.passEnd(p.id, 'commit');
		b.retire(t.id, true); // durable drain enumerates the slot's touched list
		expect(w.lastRenderedValue).toBe(7); // reached through the post-write edge — bits inherited on recordEdge
		expect(b.eventsOfType('reconcile-correction').length).toBeGreaterThan(0);
		w.live = false;
	});
});

describe('§2 A10 — token.liveReceipts gates reclamation against un-compacted receipts', () => {
	it('T10: a retired token outlives its pin-blocked receipts and reclaims exactly when they compact', () => {
		const b = bridge();
		const a = b.atom('a', 0);
		const t = b.openBatch();
		b.write(t.id, a, { kind: 'set', value: 1 });
		const p = b.passStart('A', []); // live pin below the coming retirement blocks compaction
		b.retire(t.id, true);
		expect(b.tokens.has(t.id)).toBe(true); // receipts still on the tape reference the token by id
		b.passEnd(p.id, 'discard'); // pin released → compaction folds the receipt → gate opens
		expect(b.tokens.has(t.id)).toBe(false);
	});
});
