/**
 * The observation union (AtomOptions.effect over BOTH consumer kinds):
 * kernel-subscriber liveness (the D1 bit) and engine-watcher liveness feed
 * ONE refcount owned by the atom's lifecycle registration, so an atom
 * observes once when its first consumer of ANY kind attaches and unobserves
 * only when the last consumer of EVERY kind detaches. The microtask flap
 * coalescing spans the union.
 *
 * Engine-direct (no lockstep driver): the reference model deliberately models no
 * observe lifecycle, and these transitions are direct callbacks — never
 * TraceEvents — so the lockstep comparison surfaces cannot see them (the
 * last test pins that). Watcher liveness is driven the way the shim drives
 * it: the commit layout loop flips it on; `w.live = false` is the shim's
 * debounce-finalized unsubscribe / orphan sweep shape.
 */
import { describe, expect, it } from 'vitest'
import { mountEngineReactEffectPick } from './helpers.js'
import { attachRefereeStream } from './trace-events.js'
import { engine, __TEST__resetEngine, Atom, effect, type CosignalEngine } from '../src/index.js'

const tick = (): Promise<void> => new Promise<void>((res) => queueMicrotask(res))

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

/** A fresh engine reset (production posture — the only posture: no
 * event objects exist; quiet arming follows the production derivation). */
function freshEngine(): CosignalEngine {
	// Finish the previous test's leftover episode so the reset's idle preconditions hold.
	engine.discardAllWip()
	for (const t of engine.liveBatches()) {
		if (t.parked) {
			engine.settleAction(t.id)
		} else {
			engine.retire(t.id)
		}
	}
	__TEST__resetEngine()
	return engine
}

describe('observation union at the engine', () => {
	it('a live watcher alone observes; dropping it unobserves', async () => {
		const b = freshEngine()
		const { atom, log } = observedAtom(0)
		const node = b.internalsForAtom(atom as Atom<unknown>)
		const p = b.renderStart('A', [])
		const w = b.mountWatcher(p.id, node, 'W')
		await tick()
		expect(log).toEqual([]) // created ≠ subscribed: a render alone does not observe
		b.renderEnd(p.id, 'commit') // layout: the watcher goes live
		expect(log).toEqual([]) // delivery is a microtask, never synchronous
		await tick()
		expect(log).toEqual(['observe'])
		w.live = false // debounce-finalized unsubscribe (the shim's shape)
		await tick()
		expect(log).toEqual(['observe', 'unobserve'])
	})

	it('kernel subscriber + watcher = ONE observation; unobserve only after BOTH detach', async () => {
		const b = freshEngine()
		const { atom, log } = observedAtom(0)
		const node = b.internalsForAtom(atom as Atom<unknown>)
		const dispose = effect(() => {
			void atom.state // kernel consumer: links on the atom's record
		})
		await tick()
		expect(log).toEqual(['observe'])
		const p = b.renderStart('A', [])
		const w = b.mountWatcher(p.id, node, 'W')
		b.renderEnd(p.id, 'commit') // watcher consumer joins (union 1→2)
		await tick()
		expect(log).toEqual(['observe']) // interior transition: no re-observe
		dispose() // kernel side leaves (2→1)
		await tick()
		expect(log).toEqual(['observe']) // still held by the watcher
		w.live = false // last consumer leaves (1→0)
		await tick()
		expect(log).toEqual(['observe', 'unobserve'])
	})

	it('deferMountEffects hidden prepare never observes; the adoptRevealedMount reveal observes exactly once', async () => {
		const b = freshEngine()
		const { atom, log } = observedAtom(0)
		const node = b.internalsForAtom(atom as Atom<unknown>)
		const hidden = b.renderStart('A', [])
		const w = b.mountWatcher(hidden.id, node, 'W')
		b.deferMountEffects(w.id) // Activity pre-render: layout effects deferred
		b.renderEnd(hidden.id, 'commit')
		await tick()
		expect(w.live).toBe(false)
		expect(log).toEqual([]) // the hidden commit subscribed nothing
		const reveal = b.renderStart('A', [])
		b.adoptRevealedMount(reveal.id, w.id)
		b.renderEnd(reveal.id, 'commit') // adopting commit: subscribe fires HERE
		await tick()
		expect(log).toEqual(['observe']) // one clean 0→1 — the reveal never flapped
		w.live = false
		await tick()
		expect(log).toEqual(['observe', 'unobserve'])
	})

	it('same-tick handoff between consumer kinds coalesces (no flap either direction)', async () => {
		const b = freshEngine()
		const { atom, log } = observedAtom(0)
		const node = b.internalsForAtom(atom as Atom<unknown>)
		const p = b.renderStart('A', [])
		const w = b.mountWatcher(p.id, node, 'W')
		b.renderEnd(p.id, 'commit')
		await tick()
		expect(log).toEqual(['observe'])
		// watcher → kernel handoff within one tick: the union never sits at 0
		// across a flush point, so nothing fires.
		w.live = false
		const dispose = effect(() => {
			void atom.state
		})
		await tick()
		expect(log).toEqual(['observe'])
		// kernel → watcher handoff, same rule.
		const p2 = b.renderStart('A', [])
		const w2 = b.mountWatcher(p2.id, node, 'W2')
		b.renderEnd(p2.id, 'commit')
		dispose() // same tick as w2 going live
		await tick()
		expect(log).toEqual(['observe'])
		w2.live = false
		await tick()
		expect(log).toEqual(['observe', 'unobserve'])
	})

	it('cold flap: commit-subscribe and unsubscribe within one tick net to nothing', async () => {
		const b = freshEngine()
		const { atom, log } = observedAtom(0)
		const node = b.internalsForAtom(atom as Atom<unknown>)
		const p = b.renderStart('A', [])
		const w = b.mountWatcher(p.id, node, 'W')
		b.renderEnd(p.id, 'commit')
		w.live = false // same tick: e.g. a mount whose tree is immediately torn down
		await tick()
		expect(log).toEqual([]) // coalesced — the documented flap-damping contract
	})

	it('re-asserting watcher liveness is edge-filtered (idempotent, no double retain)', async () => {
		const b = freshEngine()
		const { atom, log } = observedAtom(0)
		const node = b.internalsForAtom(atom as Atom<unknown>)
		const p = b.renderStart('A', [])
		const w = b.mountWatcher(p.id, node, 'W')
		b.renderEnd(p.id, 'commit')
		w.live = true // re-assertion (already live): must not double-count
		await tick()
		expect(log).toEqual(['observe'])
		w.live = false // a double retain would strand the union at 1 here
		await tick()
		expect(log).toEqual(['observe', 'unobserve'])
	})

	it('quiet mode: observation transitions need no armed pipeline (production posture)', async () => {
		const b = freshEngine() // production posture (quiet arms by derivation alone)
		const { atom, log } = observedAtom(0)
		const node = b.internalsForAtom(atom as Atom<unknown>)
		expect(b.quiet).toBe(true)
		const p = b.renderStart('A', []) // the render disarms quiet while open…
		const w = b.mountWatcher(p.id, node, 'W')
		b.renderEnd(p.id, 'commit') // …and it re-arms at the commit
		expect(b.quiet).toBe(true)
		await tick()
		expect(log).toEqual(['observe']) // fired with the pipeline fully quiet
		atom.set(7) // quiet fold — still no log entries/batches
		expect(b.newestValue(node)).toBe(7)
		expect(b.quiet).toBe(true)
		w.live = false
		await tick()
		expect(log).toEqual(['observe', 'unobserve'])
		expect(b.quiet).toBe(true)
	})

	it('observation transitions are direct callbacks — never events (lockstep surface unchanged)', async () => {
		const b = freshEngine()
		const stream = attachRefereeStream(b) // referee posture: decode the packed stream
		const { atom, log } = observedAtom(0)
		const node = b.internalsForAtom(atom as Atom<unknown>)
		const before = stream.cursor()
		const p = b.renderStart('A', [])
		const w = b.mountWatcher(p.id, node, 'W')
		b.renderEnd(p.id, 'commit')
		await tick()
		w.live = false
		await tick()
		expect(log).toEqual(['observe', 'unobserve'])
		const created = stream.eventsSince(before).map((e) => e.type)
		expect(created.filter((t) => /observe|lifecycle/i.test(t))).toEqual([])
		expect(created).toEqual(['render-committed']) // render-pass bookkeeping only
	})

	// RCC-OL1 re-pin (effects unification, 2026-07-06): SignalEffects COUNT
	// toward the observation union — OL1's "anything that subscribes" — via
	// ordinary strong dependency edges, retracked per run. Before the unification an
	// atom observed ONLY by a useSignalEffect never triggered its observe
	// lifecycle (the incident-I3-shaped asymmetry the plan closed).
	it('an atom observed ONLY by a SignalEffect observes; removal unobserves; a dep flip moves the retain', async () => {
		const b = freshEngine()
		const { atom, log } = observedAtom(0)
		const { atom: atomB, log: logB } = observedAtom(0)
		const nodeA = b.internalsForAtom(atom as Atom<unknown>)
		const nodeB = b.internalsForAtom(atomB as Atom<unknown>)
		const flag = b.atom('flag', 0)
		const e = mountEngineReactEffectPick(b, 'A', flag, nodeA, nodeB, 'E') // flag=0 → edges {flag, b}
		await tick()
		expect(log).toEqual([]) // a has no edge
		expect(logB).toEqual(['observe']) // b's strong edge holds one union retain
		const t = b.openBatch()
		b.write(t.id, flag, 0, 1)
		b.retire(t.id) // boundary: the body re-chooses a; the retains re-point
		await tick()
		expect(log).toEqual(['observe'])
		expect(logB).toEqual(['observe', 'unobserve'])
		b.removeSignalEffect(e.id) // teardown removes the terminal's ordinary edges
		await tick()
		expect(log).toEqual(['observe', 'unobserve'])
	})
})
