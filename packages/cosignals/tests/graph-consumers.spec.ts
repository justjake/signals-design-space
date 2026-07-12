/**
 * Graph-consumer coherence audit. The engine keeps two families of edge
 * stores — the kernel's packed dependency links and the
 * per-world world arenas (strong + segregated weak links) — and every
 * consumer of edge/subscriber/liveness state must
 * decide explicitly which store(s) it consults. Each row below is that
 * decision; rows no other suite enforces are pinned by the tests in
 * this file (the suite is the audit). "Kernel-only" below means the
 * consumer reads kernel links alone; "arena-only" means the arenas alone.
 *
 * Part 1 — consumers: consumer (site) | stores | verdict | enforcement
 *  1  linkInsert first-sub branch                      | kernel edge → union refcount | union (kernel 0→1 half)   | graph.spec, observe-union.spec, T1
 *  2  unwatched() signal branch                        | kernel edge → union refcount | union (kernel 1→0 half)   | observe-union.spec 'kernel+watcher=ONE', T1
 *  3  unwatched() computed branch (lazy re-track)      | kernel                   | kernel-only: kernel liveness is kernel memory management | conformance 179, T3
 *  4  unwatched()/dispose() effect+scope auto-dispose  | kernel                   | kernel-only: scope nesting is a kernel structure | conformance, graph.spec, T4
 *  5  notify() parent-chain SUBS read (outer-first)    | kernel                   | kernel-only: effect nesting is kernel-only | conformance ordering cases
 *  6  kernel propagate/shallowPropagate seeds          | kernel                   | kernel-only by design: kernel flush serves kernel subscribers; arena consumers get the delivery walk; union = the sum of both paths | concurrent-scars S2/S3, T5
 *  7  invalidateComputed (suspense settle)             | kernel                   | kernel-only: boxes live on kernel computeds; world serving folds SuspendedRead as a value | suspense.spec
 *  8  Atom.state host seam                             | kernel or world          | route-by-frame: world routing only with no kernel frame open; a kernel-frame read makes a kernel link + fills a kernel cache, so it must serve newest (a world-routed kernel-frame read would poison the kernel cache) | T6, one-core 'overlay world evaluation' pins the routed side
 *  9  Computed.state (no host seam)                    | kernel                   | kernel-only: standalone computeds are not world-routable (bindings reject via resolveNode) | T6, hooks.ts resolveNode error
 * 10  deliveryWalk (arena strong lists+nodeToWatchers) | arenas (strong)          | arena-only: kernel consumers already served by eager kernel apply; weak lists never traversed; may deliver fewer than the union-conservative model (⊆ bound; the dead-arena retreat pins the degraded case) | battery case 1, scars S2/S3, T5, arena-sb.spec
 * 11  core effect() reach (kernel flush)               | kernel                   | kernel-only: core effects are real kernel effects, flushed by the eager kernel apply over tracked links only (untracked deps invalidate values, never notify); sibling firing order under one op is implementation-defined by contract — the lockstep differ compares same-step runs as a multiset | fuzz (multiset differ), trace.spec core-effect stage
 * 12  weak (untracked) links — segregated subs lists   | arena weak lists         | weak-only: mark propagation + drain candidates, never deliveries | battery 'taint member', arena-sa2 mixed-mode, arena-sb untracked-fan, fuzz
 * 13  arena reclamation (getConsumerCount sweep)          | watchers + SignalEffects | zero-consumer quiescence sweep; no reachability walk needed — coverage is the arena itself | arena-sa2 root-churn, long-seed fuzz (episode churn), T7
 * 14  drainCommittedObservers (arena dirty lists)      | arenas (strong+weak)     | arena-only, conservative: dirty-list seeds expand over both lists; entries persist until decay (drain seeding stands on it) | lockstep drain parity, scars S26, T9
 * 15  runMountFixup dependencyClosureOf                   | render arena ∪ committed arena ∪ kernel links (strong) | the triple walk: correctives arm dedup bits, so the closure must cover every later-routable cone | battery cases 9/10, scars S43, lockstep corpus (seeds 29/97/173)
 * 16  quiesce                                          | arenas persist           | no refresh: routing coverage survives by arena persistence; duties = zero-consumer sweep + read-clock renumber | quiet-mode 'quiesce() interoperates', T7
 * 17  Watcher.live setter → shiftObservedCount → retain/release  | edge → union refcount    | union (watcher half, via the observation index) | observe-union.spec (all), T1
 * 18  observation index (obsRefs/obsDeps/capture) | eval-time strong deps → kernel lifecycle | union-transitive: a live watcher observes every atom its node's current evaluation (transitively) reads — retains follow fn re-runs in every world (arena refolds carry the capture), survive quiescence, release with the last watcher | T2 (flipped pin), observe-transitive.spec
 * 19  watchers map + nodeToWatchers index mutation     | dual store               | must move together via removeWatcher (a map-only delete strands the per-node index entry) | T7, cosignals-react graph-consumers.spec.tsx
 * 20  dependencyEdges/graphviz snapshot                | arenas (both lists)      | arena-only diagnostics (current structure; persists with the arenas) | graphviz docstring; not behavior-bearing
 * 21  shim liveness flips (claim/orphan/finalize)      | via one setter           | union + both stores (delegates to Watcher.live + removeWatcher) | cosignals-react hooks.spec StrictMode netting + graph-consumers.spec.tsx
 * 22  useSignal render branches (watchers.get/w.live)  | engine watchers          | engine watcher records are the one source | cosignals-react battery/hooks.spec
 * 23  SignalEffect terminal links                     | committed arena strong links | one canonical dependency store drives dirtiness, value validation, retracking, and observation liveness | concurrent-battery case 16, observe-union.spec, cosignals-react hooks.spec useSignalEffect
 *
 * Part 2 — dual-representation agreements: pair | enforcement
 *  A1 kernel value ≡ fold(base, log entries)              | lockstep EVERY step: oracle-adapter snapshot `newest` reads the kernel arena, the model folds; concurrent-fuzz.spec 'diff clean' + concurrent-battery
 *  A2 newest kernel caches ≡ write logs (+retirement stamps) | lockstep values; scars S5 pins log-entry-after-read invalidation
 *  A3 quiet flag ≡ pending state (batches/renders/write logs) | quiet-mode.spec arming/disarming battery
 *  A4 handle resolution = the one engine's internals registry | T8: resolution is the handle-internals link + the dense-row probe through the record's live NODE_INDEX; content allocates once and writes land on it
 *  A5 arena-served value ≡ fold-truth (naive cache-free re-fold) | the armed checker (tests/arena-checker.ts): every op epilogue in the lockstep suites and the fuzz corpus serves every shadow and compares
 *  A6 observation refcount ≡ live consumers            | observe-union.spec + T1/T2
 *  A7 committedBits ≡ committedBatches×slot             | rebuildCommittedBits at retire + internSlot back-fill; battery case 11, scars S19a
 *  A8 render-pass maskBits/includedBits ≡ the model's mask/captured slot sets | the engine's only slot-set form; model-view derives the reference model's Sets from the bits; lockstep render worlds
 *  A9 batch.atomsTouched ⊇ write log batch columns          | retirement stamping via touch lists; quiesce residue InvariantViolation + lockstep retirement visibility
 * A10 batch records are episode-lifetime                    | T10 (re-pinned: a retired batch outlives its log entries and drops with the episode)
 * A11 DIRTY flag ⇒ dirty-list membership (decay + drain seeding stand on it) | the structural validator at every armed epilogue; arena-sa2 decay pins
 * A12 shim previousCells ≡ last committed value        | cosignals-react hooks.spec 'ctx.previous returns the last committed value'
 */
import { describe, expect, it } from 'vitest'
import {
	Atom,
	Computed,
	effect,
	effectScope,
	engine,
	untracked,
	__TEST__resetEngine,
	type CosignalEngine,
} from '../src/index.js'
import { attachRefereeStream, refereeStreamOf } from './trace-events.js'

const tick = (): Promise<void> => new Promise<void>((res) => queueMicrotask(res))

/** Fresh engine in comparison posture (a lossless session tracer is the event
 * surface; quiet arms by the production derivation; no driver — the tests
 * pass explicit batch ids). */
function freshEngine(): CosignalEngine {
	engine.discardAllWip()
	for (const t of engine.liveBatches()) {
		if (t.parked) {
			engine.settleAction(t.id)
		} else {
			engine.retire(t.id)
		}
	}
	__TEST__resetEngine()
	attachRefereeStream(engine)
	return engine
}

function observedAtom(initial: number): { atom: Atom<number>; log: string[] } {
	const log: string[] = []
	const atom = new Atom(initial, {
		effect: () => {
			log.push('observe')
			return () => log.push('unobserve')
		},
	})
	return { atom, log }
}

describe('§1 rows 1/2/17 — observation is a UNION refcount over both stores', () => {
	it('T1: fires with K1 empty (kernel-only), holds across a store handoff, releases only when both empty', async () => {
		const b = freshEngine()
		const { atom, log } = observedAtom(0)
		const node = (() => {
			const n0 = b.internalsForAtom(atom)
			n0.name = 'a'
			return n0
		})()
		const dispose = effect(() => {
			void atom.state // kernel subscriber; the watcher index holds nothing
		})
		await tick()
		expect(log).toEqual(['observe'])
		expect(b.watchers.size).toBe(0) // the disagreement: the watcher store says "no consumers"
		const p = b.renderStart('A', [])
		const w = b.mountWatcher(p.id, node, 'W')
		b.renderEnd(p.id, 'commit') // a watcher joins
		dispose() // kernel SUBS now empty — the stores disagree; the union must hold
		await tick()
		expect(log).toEqual(['observe'])
		w.live = false // last consumer of EVERY kind leaves
		await tick()
		expect(log).toEqual(['observe', 'unobserve'])
	})

	it('T2: UNION-TRANSITIVE (row 18) — a watcher over an overlay COMPUTED retains the atoms its evaluation reads; a direct atom watcher joining is an interior transition', async () => {
		const b = freshEngine()
		const { atom, log } = observedAtom(0)
		const node = (() => {
			const n0 = b.internalsForAtom(atom)
			n0.name = 'a'
			return n0
		})()
		const oc = b.computed('oc', (read) => read(node))
		const p = b.renderStart('A', [])
		const wc = b.mountWatcher(p.id, oc, 'WC') // no direct atom watcher anywhere
		b.renderEnd(p.id, 'commit')
		await tick()
		expect(log).toEqual(['observe']) // the closure atom IS observed through the derived node
		const p2 = b.renderStart('A', [])
		const wa = b.mountWatcher(p2.id, node, 'WA') // direct atom watcher joins the same union
		b.renderEnd(p2.id, 'commit')
		await tick()
		expect(log).toEqual(['observe']) // interior transition: no re-observe
		wa.live = false // direct consumer leaves; the transitive one still holds
		await tick()
		expect(log).toEqual(['observe'])
		wc.live = false // last consumer of EVERY kind leaves
		await tick()
		expect(log).toEqual(['observe', 'unobserve'])
	})
})

describe('§1 rows 3/4 — kernel liveness transitions consult K0 only', () => {
	it('T3: an unwatched kernel computed goes lazy-dirty regardless of live K1 watchers over the same atom', () => {
		const b = freshEngine()
		const handle = new Atom(1)
		const node = b.internalsForAtom(handle)
		node.name = 'a'
		const p = b.renderStart('A', [])
		const w = b.mountWatcher(
			p.id,
			b.computed('oc', (read) => read(node)),
			'W',
		)
		b.renderEnd(p.id, 'commit') // a live watcher watches the atom
		let evals = 0
		const kc = new Computed(() => {
			evals++
			return handle.state
		})
		const dispose = effect(() => {
			void kc.state
		})
		expect(evals).toBe(1)
		dispose() // kernel: last subscriber left → unwatched(kc) drops deps + marks dirty
		expect(kc.state).toBe(1)
		expect(evals).toBe(2) // recomputed although no dep changed and a watcher still watches the atom
		w.live = false
	})

	it('T4: scope disposal auto-disposes child effects through K0 parent links alone', () => {
		const a = new Atom(0)
		let runs = 0
		const disposeScope = effectScope(() => {
			effect(() => {
				void a.state
				runs++
			})
		})
		expect(runs).toBe(1)
		disposeScope()
		a.set(5)
		expect(runs).toBe(1) // child died with the scope — no watcher store involvement exists here
	})
})

describe('§1 rows 6/10 — one logged write notifies via BOTH stores (K0 flush + K1 walk), each serving its own consumers', () => {
	it('T5: a kernel effect (no K1 record) and an engine watcher (no K0 link) both hear one write', () => {
		const b = freshEngine()
		const handle = new Atom(0)
		const node = b.internalsForAtom(handle)
		node.name = 'a'
		let kernelSeen = -1
		const dispose = effect(() => {
			kernelSeen = handle.state // kernel subscriber
		})
		const oc = b.computed('oc', (read) => read(node))
		const p = b.renderStart('A', [])
		b.mountWatcher(p.id, oc, 'W') // watcher subscriber (edge a→oc recorded by the mount eval)
		b.renderEnd(p.id, 'commit')
		const stream = refereeStreamOf(b)
		const mark = stream.cursor()
		const t = b.openBatch()
		b.write(t.id, node, 0, 9)
		expect(kernelSeen).toBe(9) // kernel: eager kernel apply flushed the effect
		expect(stream.eventsSince(mark).some((e) => e.type === 'delivery' && e.watcher === 'W')).toBe(
			true,
		) // arena delivery walk
		b.retire(t.id)
		dispose()
	})
})

describe('§1 rows 8/9 — kernel-FRAME reads are never world-routed; kernel COMPUTEDS world-route through the S-C seam', () => {
	it('T6 (re-pinned at S-C): a kernel computed read inside a world evaluation ADOPTS and evaluates under that world (arena links recorded); the kernel cache stays newest-coherent because worlds never touch it; kernel-frame reads still serve newest', () => {
		const b = freshEngine()
		const handle = new Atom(0)
		const node = b.internalsForAtom(handle)
		node.name = 'a'
		let kcEvals = 0
		const kc = new Computed(() => {
			kcEvals++
			return handle.state + 100
		})
		const c = b.computed('c', () => kc.state) // standalone kernel computed inside an engine fn
		const t = b.openBatch()
		b.write(t.id, node, 0, 5) // kernel newest = 5
		const p = b.renderStart('A', []) // t excluded: the render world's a is 0
		// One-computed inversion: kc's read inside c's arena
		// evaluation routes through the computed host-read seam, adopts kc,
		// and evaluates it under the render world — the render sees a=0
		// (a kernel-frame read would have served newest: 105).
		expect(b.renderValue(c, p)).toBe(100)
		expect(kcEvals).toBe(1) // the arena evaluation ran the raw fn once
		// The world evaluation recorded ARENA links (a→kc→c) — kc's cone is
		// deliverable — while the KERNEL slot was never written by the world
		// path (arenas own world values):
		expect(b.dependencyEdges.size).toBeGreaterThan(0)
		expect(kc.state).toBe(105) // newest read: kernel evaluates its own record
		expect(kcEvals).toBe(2) // …a second, kernel-frame run — no world residue served
		// Kernel-frame reads stay un-routed (the seam gates on
		// activeSub === 0): a kernel effect re-reading kc
		// during the open render sees newest.
		let kernelSeen = -1
		const dispose = effect(() => {
			kernelSeen = kc.state
		})
		expect(kernelSeen).toBe(105)
		b.renderEnd(p.id, 'discard')
		expect(kc.state).toBe(105) // eager-apply coherence (A1), unchanged
		b.retire(t.id)
		dispose()
	})

	it('T6b: untracked temporarily disables links, not the kernel-frame world', () => {
		const b = freshEngine()
		const handle = new Atom(0)
		const node = b.internalsForAtom(handle)
		const t = b.openBatch()
		b.write(t.id, node, 0, 5)
		const p = b.renderStart('A', []) // render world sees 0; kernel newest is 5
		const c = new Computed(() => untracked(() => handle.state) + 100)
		let seen = -1
		const dispose = effect(() => {
			seen = c.state
		})
		expect(seen).toBe(105) // the untracked read cannot poison c with render-world 0
		b.renderEnd(p.id, 'discard')
		b.retire(t.id)
		dispose()
	})
})

describe('§1 rows 13/16/19 — the two watcher stores move together (removeWatcher)', () => {
	it('T7: removeWatcher retires the id map, the per-node walk index, and open mounted lists in one call', () => {
		const b = freshEngine()
		const a = b.atom('a', 0)
		let evals = 0
		const c = b.computed('c', (read) => {
			evals++
			return read(a)
		})
		const p = b.renderStart('A', [])
		const w = b.mountWatcher(p.id, c, 'W')
		b.renderEnd(p.id, 'commit')
		expect(b.watchers.size).toBe(1)
		b.removeWatcher(w.id)
		expect(b.watchers.size).toBe(0)
		expect(w.live).toBe(false) // liveness (and any observation retain) released
		const before = evals
		b.quiesce() // zero-consumer sweep releases the root's arena; NO refresh evaluations run
		expect(evals).toBe(before) // a stranded index entry would keep the watcher population nonzero (arena retained, coverage leaked)
		// Removal inside an open render scrubs the mounted list: commit must not revive it.
		const p2 = b.renderStart('A', [])
		const w2 = b.mountWatcher(p2.id, c, 'W2')
		b.removeWatcher(w2.id)
		b.renderEnd(p2.id, 'commit')
		expect(b.watchers.size).toBe(0)
	})
})

describe('§2 A4 — handle resolution vs the one engine registry', () => {
	it('T8: resolution is idempotent content allocation — one node per handle, registry-probed by kernel record id, and writes land on it', () => {
		const b = freshEngine()
		const handle = new Atom(0)
		handle.set(1) // standalone history first (the node-less arm: kernel only)
		const n = b.internalsForAtom(handle) // content allocates ONCE; base seeds from kernel-current
		n.name = 'a'
		expect(n.base).toBe(1) // the standalone history is committed-only base state
		expect(b.internalsForAtom(handle as Atom<unknown>)).toBe(n) // idempotent: the handle-node link resolves, never re-allocates
		expect(b.idToInternals.get(handle._id)).toBe(n) // and the registry row is the same node
		const other = new Atom(0)
		expect(b.internalsForAtom(other as Atom<unknown>)).not.toBe(n) // a different handle gets its own node
		handle.set(2) // public write → THE node (quiet fold: base advances, no log entry)
		expect(n.base).toBe(2)
		expect(n.log.length).toBe(0)
	})
})

describe('§2 A5/A11 + rows 11/14 — structure recorded AFTER a write still drains (population coverage)', () => {
	it('T9: links recorded AFTER the write (the mount + re-staled loop populate the committed arena) still route the retirement drain to the watcher', () => {
		const b = freshEngine()
		const a = b.atom('a', 0)
		const c = b.computed('c', (read) => read(a))
		const t = b.openBatch()
		b.write(t.id, a, 0, 7) // no arena holds a→c yet
		const p = b.renderStart('A', []) // pin postdates the write; t excluded → renders base
		const w = b.mountWatcher(p.id, c, 'W') // render-arena links record now; the commit's re-staled loop populates the committed arena
		expect(w.lastRenderedValue).toBe(0)
		b.renderEnd(p.id, 'commit')
		b.retire(t.id) // site-(a) fanout marks `a`; the drain walks the dirty cone to the watcher
		expect(w.lastRenderedValue).toBe(7)
		expect(refereeStreamOf(b).eventsOfType('reconcile-correction').length).toBeGreaterThan(0)
		w.live = false
	})
})

describe('§2 A10 — batch records are episode-lifetime (they outlive their log entries by construction)', () => {
	it('T10: a retired batch record persists while the episode stays open and drops at the episode close', () => {
		const b = freshEngine()
		const a = b.atom('a', 0)
		const t = b.openBatch()
		b.write(t.id, a, 0, 1)
		const p = b.renderStart('A', []) // the open render holds the episode open past the retirement
		b.retire(t.id)
		expect(b.idToBatch.has(t.id)).toBe(true) // log entries still on the write log reference the batch by id
		b.renderEnd(p.id, 'discard') // last render closed, no live batches → the episode closes and drops its records
		expect(b.idToBatch.has(t.id)).toBe(false)
	})
})
