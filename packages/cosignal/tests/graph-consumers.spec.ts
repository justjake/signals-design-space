/**
 * GRAPH-CONSUMER COHERENCE AUDIT. The engine keeps two families of edge
 * stores — K0 (the kernel's packed dependency links, index.ts) and the
 * per-world SHADOW ARENAS (strong + segregated weak links, concurrent.ts;
 * they replaced the K1 episode edge log at NF2 S-B) plus the newest memos'
 * strong dep records (the ladder's surviving arm, the kernel-links stand-in
 * until S-C) — and every consumer of edge/subscriber/liveness state must
 * decide explicitly which store(s) it consults. Each row below is that
 * decision; rows whose enforcement was NOTHING are pinned by the tests in
 * this file (the suite IS the audit).
 *
 * §1 CONSUMERS ─ consumer (site) | stores | verdict | enforcement
 *  1  linkInsert first-sub branch (index.ts D1)        | K0 edge → union refcount | UNION (kernel 0→1 half)   | graph.spec, observe-union.spec, T1
 *  2  unwatched() signal branch (index.ts D1)          | K0 edge → union refcount | UNION (kernel 1→0 half)   | observe-union.spec 'kernel+watcher=ONE', T1
 *  3  unwatched() computed branch (lazy re-track)      | K0                       | K0-ONLY: kernel liveness is kernel memory mgmt; overlay computeds hold no kernel records | conformance 179, T3
 *  4  unwatched()/dispose() effect+scope auto-dispose  | K0                       | K0-ONLY: scope nesting is a kernel structure | conformance, graph.spec, T4
 *  5  notify() parent-chain SUBS read (outer-first)    | K0                       | K0-ONLY: effect nesting is kernel-only | conformance ordering cases
 *  6  kernel propagate/shallowPropagate seeds          | K0                       | K0-ONLY BY DESIGN: kernel flush serves K0 subscribers; arena consumers get the delivery walk; union = the SUM of both paths | concurrent-scars S2/S3, T5
 *  7  invalidateComputed (suspense settle)             | K0                       | K0-ONLY: boxes live on kernel computeds; overlay folds SuspendedRead as a value | suspense.spec
 *  8  Atom.state host seam (index.ts)                  | K0 or world              | ROUTE-BY-FRAME: world routing only with NO kernel frame open; a kernel-frame read makes a K0 link + fills a K0 cache, so it must serve K0 (newest) — FIXED (was: world-routed → kernel cache poisoned = torn newest arena) | T6 (new), one-core 'overlay world evaluation' pins the routed side
 *  9  Computed.state (no host seam)                    | K0                       | K0-ONLY: standalone computeds are not world-routable (bindings reject via resolveNode) | T6, hooks.ts resolveNode error
 * 10  deliveryWalk (arena STRONG lists+watchersByNode) | arenas (strong)          | ARENA-ONLY: K0 consumers already served by eager kernel apply; weak lists never traversed (§4.4.1); may deliver FEWER than the union-conservative model (⊆ bound; S-NF2-D1 pins the retreat) | battery case 1, scars S2/S3, T5, arena-sb.spec
 * 11  core effect() reach (kernel flush; W9)           | K0                       | K0-ONLY: core effects are REAL kernel effects, flushed by the eager kernel apply over tracked links only (untracked deps invalidate values, never notify); sibling firing order under one op is implementation-defined [owner ruling 2026-07-06] — the lockstep differ compares same-step runs as a multiset | fuzz (multiset differ), trace.spec core-effect stage
 * 12  weak (untracked) links — segregated subs lists   | arena weak lists         | WEAK-ONLY: mark propagation + drain candidates, never deliveries | battery 'taint member', arena-sa2 mixed-mode, arena-sb untracked-fan, fuzz
 * 13  arena reclamation (consumerCount sweep)          | watchers + committed subs | ZERO-CONSUMER quiescence sweep (§4.5.8); no reachability walk needed — coverage is the arena itself | arena-sa2 root-churn, long-seed fuzz (episode churn), T7
 * 14  drainCommittedObservers (arena dirty lists)      | arenas (strong+weak)     | ARENA-ONLY, conservative: dirty-list seeds expand over BOTH lists; entries persist until decay (drain seeding stands on it) | lockstep drain parity, scars S26, T9
 * 15  mountFixup dependencyClosureOf                   | pass arena ∪ committed arena ∪ newest memos (strong) | §4.4.7's triple (the memo leg stands in for kernel links until S-C): correctives arm dedup bits, so the closure must cover every later-routable cone | battery cases 9/10, scars S43, lockstep corpus (seeds 29/97/173)
 * 16  quiesce                                          | arenas persist           | NO refresh: routing coverage survives by arena persistence (§4.1); duties = zero-consumer sweep + read-clock renumber | quiet-mode 'quiesce() interoperates', T7
 * 17  Watcher.live setter → obsShift → retain/release  | edge → union refcount    | UNION (watcher half, via the observation index) | observe-union.spec (all), T1
 * 18  observation index (obsRefs/obsDeps/capture) | eval-time strong deps → K0 lifecycle | UNION-TRANSITIVE: a live watcher observes every atom its node's CURRENT evaluation (transitively) reads — retains follow fn re-runs in EVERY world (arena refolds carry the capture, §4.7/M6), survive quiescence, release with the last watcher | T2 (flipped pin), observe-transitive.spec
 * 19  watchers map + watchersByNode index mutation     | dual store               | MUST MOVE TOGETHER via removeWatcher — FIXED (shim's map-only deletes stranded index entries) | T7 (new), cosignal-react graph-consumers.spec.tsx
 * 20  dependencyEdges/graphviz snapshot                | arenas (both lists)      | ARENA-ONLY diagnostics (current structure; persists with the arenas) | graphviz docstring; not behavior-bearing
 * 21  shim liveness flips (claim/orphan/finalize)      | via one setter           | UNION + both stores (delegates to Watcher.live + removeWatcher) | cosignal-react hooks.spec StrictMode netting + graph-consumers.spec.tsx
 * 22  useSignal render branches (watchers.get/w.live)  | bridge watchers          | bridge watcher records are the one source | cosignal-react battery/hooks.spec
 * 23  committed-subscription dep snapshots (captureRun) | committed VALUES + obs union | value-gated per EF2 boundary, no edge store; the capture's committed evaluations POPULATE the root's arena, whose marks the re-checks validate through (subDepRefs dissolved at S-B, §4.0) | concurrent-battery case 16, observe-union.spec, cosignal-react hooks.spec useSignalEffect
 *
 * §2 DUAL-REPRESENTATION AGREEMENTS ─ pair | enforcement
 *  A1 kernel value ≡ fold(base, receipts)              | lockstep EVERY step: oracle-adapter snapshot `newest` reads the kernel arena, the model folds; concurrent-fuzz.spec 'diff clean' + concurrent-battery
 *  A2 newest memo fingerprints ≡ tapes (+retirement stamps) | lockstep values; scars S5 pins receipt-after-read invalidation
 *  A3 quiet flag ≡ pending state (tokens/passes/tapes) | quiet-mode.spec arming/disarming battery
 *  A4 adoption stamp ≡ byKernelId registry             | T8 (new pin): stale foreign stamps re-resolve via the registry probe, writes land on the ACTIVE bridge's node
 *  A5 arena-served value ≡ fold-truth (naive cache-free re-fold) | THE ARMED CHECKER (__checkArenas): every op epilogue in the twin suites AND the fuzz corpus serves every shadow and compares
 *  A6 observation refcount ≡ live consumers            | observe-union.spec + T1/T2
 *  A7 committedBits ≡ committedTokens×slot             | rebuildCommittedBits at retire + internSlot back-fill; battery case 11, scars S19a
 *  A8 pass maskBits/includedBits ≡ the model's mask/captured slot sets | the engine's ONLY slot-set form (W1); model-view derives the oracle's Sets from the bits; lockstep pass worlds
 *  A9 token.atomsTouched ⊇ tape token columns          | retirement stamping via touch lists; quiesce residue BridgeInvariantViolation + lockstep retirement visibility
 * A10 token.liveReceipts ≡ un-compacted receipts       | T10 (new pin: token outlives pinned receipts, reclaims after compaction)
 * A11 DIRTY flag ⇒ dirty-list membership (decay + drain seeding stand on it) | the structural validator at every armed epilogue; arena-sa2 decay pins
 * A12 shim previousCells ≡ last committed value        | cosignal-react hooks.spec 'ctx.previous returns the last committed value'
 */
import { describe, expect, it } from 'vitest';
import { Atom, Computed, effect, effectScope, __newBridgeForTest, type CosignalBridge } from '../src/index.js';

const tick = (): Promise<void> => new Promise<void>((res) => queueMicrotask(res));

/** Fresh registered bridge in referee posture (events retained; quiet arms by the production derivation). */
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
			void atom.state; // K0 subscriber; K1 observation index holds nothing
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

describe('§1 rows 8/9 — kernel-FRAME reads are never world-routed; kernel COMPUTEDS world-route through the S-C seam', () => {
	it('T6 (re-pinned at S-C): a kernel computed read inside a world evaluation ADOPTS and evaluates under that world (arena links recorded); the kernel cache stays newest-coherent because worlds never touch it; kernel-frame reads still serve newest', () => {
		const b = bridge();
		const handle = new Atom(0);
		const node = b.adoptAtom('a', handle as Atom<unknown>);
		let kcEvals = 0;
		const kc = new Computed(() => {
			kcEvals++;
			return (handle.state as number) + 100;
		});
		const c = b.computed('c', () => kc.state); // standalone kernel computed inside a bridge fn
		const t = b.openBatch();
		b.write(t.id, node, { kind: 'set', value: 5 }); // kernel newest = 5
		const p = b.passStart('A', []); // t excluded: the pass world's a is 0
		// S-C INVERSION (§4.8 — one computed): kc's read inside c's ARENA
		// evaluation routes through the computed host-read seam, adopts kc,
		// and evaluates it UNDER THE PASS WORLD — the pass sees a=0. (Pre-S-C
		// this read was a kernel frame serving newest: 105.)
		expect(b.passValue(c, p)).toBe(100);
		expect(kcEvals).toBe(1); // the arena evaluation ran the raw fn once
		// The world evaluation recorded ARENA links (a→kc→c) — kc's cone is
		// deliverable — while the KERNEL slot was never written by the world
		// path (arenas own world values):
		expect(b.dependencyEdges.size).toBeGreaterThan(0);
		expect(kc.state).toBe(105); // newest read: kernel evaluates its own record
		expect(kcEvals).toBe(2); // …a SECOND, kernel-frame run — no world residue served
		// KERNEL-FRAME reads stay un-routed (the boundary that survives S-C:
		// the seam gates on activeSub === 0): a kernel effect re-reading kc
		// during the open pass sees NEWEST.
		let kernelSeen = -1;
		const dispose = effect(() => {
			kernelSeen = kc.state as number;
		});
		expect(kernelSeen).toBe(105);
		b.passEnd(p.id, 'discard');
		expect(kc.state).toBe(105); // eager-apply coherence (A1), unchanged
		b.retire(t.id, true);
		dispose();
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
		b.quiesce(); // zero-consumer sweep releases the root's arena; NO refresh evaluations run
		expect(evals).toBe(before); // a stranded index entry would keep the watcher population nonzero (arena retained, coverage leaked)
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
		// b2 is at rest, so the write is a quiet fold: base advances on the
		// ACTIVE bridge's node (no receipt is minted while nothing is pending).
		expect(n2.base).toBe(1);
		expect(n2.tp.length).toBe(0);
		expect(n1.base).toBe(0); // the foreign bridge's node saw nothing
		expect(n1.tp.length).toBe(0);
	});
});

describe('§2 A5/A11 + rows 11/14 — structure recorded AFTER a write still drains (population coverage)', () => {
	it('T9: links recorded AFTER the write (the mount + re-staled loop populate the committed arena) still route the retirement drain to the watcher', () => {
		const b = bridge();
		const a = b.atom('a', 0);
		const c = b.computed('c', (read) => read(a));
		const t = b.openBatch();
		b.write(t.id, a, { kind: 'set', value: 7 }); // no arena holds a→c yet
		const p = b.passStart('A', []); // pin postdates the write; t excluded → renders base
		const w = b.mountWatcher(p.id, c, 'W'); // pass-arena links record NOW; the commit's re-staled loop populates the committed arena (§4.4.2)
		expect(w.lastRenderedValue).toBe(0);
		b.passEnd(p.id, 'commit');
		b.retire(t.id, true); // site-(a) fanout marks `a`; the drain walks the dirty cone to the watcher
		expect(w.lastRenderedValue).toBe(7);
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
