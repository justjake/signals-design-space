import { beforeEach, describe, expect, it } from 'vitest'
import { createCosignalEngine, type CosignalEngine } from '../src/engine'
import { createForkDouble, type BatchScript, type ForkDouble } from '../src/fork-double'

// §17.4 — world-divergent dependency scenarios. Common setup: atoms
// flag=false, a=0, b=0; computed c = flag ? a : b; a watcher on c; deferred
// batch k. A computed's dependency set can differ per world; these tests pin
// that invalidation keys on the RE-OBSERVED per-world read set (certificate
// zeros included) and that pending-world-only dependencies still notify
// watchers through the slot memo chains.

let e: CosignalEngine
let fork: ForkDouble
let flag: ReturnType<CosignalEngine['atom']>
let a: ReturnType<CosignalEngine['atom']>
let b: ReturnType<CosignalEngine['atom']>
let c: ReturnType<CosignalEngine['computed']>
let k: BatchScript

beforeEach(() => {
	e = createCosignalEngine()
	fork = createForkDouble()
	e.attachFork(fork)
	fork.registerRoot('root')
	flag = e.atom<boolean | number>(false) as never
	a = e.atom(0) as never
	b = e.atom(0) as never
	c = e.computed(() => (flag.state ? a.state : b.state)) as never
	expect(c.state).toBe(0) // canonical evaluation: reads flag, b
	e.watch(c)
	e.debug.takeBroadcasts()
	k = fork.openBatch('deferred')
})

describe('§17.4 world-divergent dependencies', () => {
	it('T1: same-batch follow-up write to a world-only dep — three mechanisms fire', () => {
		k.run(() => flag.set(true))
		// k-world read of c: reads flag(k)=true, a — and a is UNLOGGED at this
		// read, so the memo's certificate records the zero pair (a, 0).
		expect(e.debug.readWorld(c, { kind: 'writer', token: k.token })).toBe(0)
		e.debug.takeBroadcasts() // (flag write may or may not have fired; c: 0→0 cutoff)

		k.run(() => a.set(1)) // SAME batch; a has NO canonical subscribers

		// Mechanism 1: the k-world read returns 1 — the write created a's tape,
		// so the certificate's zero pair mismatches the new tail (§10.5).
		expect(e.debug.readWorld(c, { kind: 'writer', token: k.token })).toBe(1)
		// Mechanism 2: the watcher was notified IN K'S LANE — reachable only
		// through the slot-chain re-validation + entanglement (§9.8).
		const evs = e.debug.takeBroadcasts()
		const kEv = evs.find((x) => x.token === k.token && x.value === 1)
		expect(kEv).toBeDefined()
		expect(kEv!.forkBatchDuringCallback).toBe(k.token)
		// Mechanism 3: the committed world still reads 0 via b.
		expect(e.readCommitted(c)).toBe(0)
		k.retire()
		e.debug.verify()
	})

	it('T2: no tear from the committed-only dep', () => {
		k.run(() => flag.set(true))
		expect(e.debug.readWorld(c, { kind: 'writer', token: k.token })).toBe(0)
		e.debug.takeBroadcasts()
		k.run(() => b.set(5)) // k's world reads a, not b
		expect(e.debug.readWorld(c, { kind: 'writer', token: k.token })).toBe(0)
		expect(e.readCommitted(c)).toBe(0) // deferred writes invisible
		// No spurious broadcast past the equality cutoff.
		const evs = e.debug.takeBroadcasts()
		expect(evs.filter((x) => x.value !== 0)).toEqual([])
		k.retire()
		e.debug.verify()
	})

	it('T3: writing the shared dep re-evaluates down the other branch', () => {
		k.run(() => flag.set(true))
		k.run(() => a.set(1))
		expect(e.debug.readWorld(c, { kind: 'writer', token: k.token })).toBe(1)
		e.debug.takeBroadcasts()
		k.run(() => flag.set(false)) // shared dep: k's memo invalidates (flag in cert)
		expect(e.debug.readWorld(c, { kind: 'writer', token: k.token })).toBe(0) // b branch
		const evs = e.debug.takeBroadcasts()
		// Value changed 1 → 0 in k's world: watcher notified in k's lane.
		expect(evs.map((x) => [x.token, x.value])).toContainEqual([k.token, 0])
		k.retire()
		e.debug.verify()
	})

	it('T4: urgent write to the committed-only dep', () => {
		k.run(() => flag.set(true))
		expect(e.debug.readWorld(c, { kind: 'writer', token: k.token })).toBe(0)
		e.debug.takeBroadcasts()
		b.set(7) // urgent
		// Committed/newest c is 7 (canonical flag=false → b) and the watcher
		// re-renders urgently.
		expect(e.debug.readWorld(c, { kind: 'w0' })).toBe(7)
		const evs = e.debug.takeBroadcasts()
		expect(evs.map((x) => [x.token, x.value])).toContainEqual([0, 7])
		// k's world still reads a → 0; no k-lane broadcast (its value is 0 and
		// its last k decision was 0-equal).
		expect(e.debug.readWorld(c, { kind: 'writer', token: k.token })).toBe(0)
		expect(evs.filter((x) => x.token === k.token && x.value !== 0)).toEqual([])
		fork.closeEvent()
		k.retire()
		e.debug.verify()
	})

	it('T5: urgent write to the pending-only dep reaches k through the chain', () => {
		k.run(() => flag.set(true))
		expect(e.debug.readWorld(c, { kind: 'writer', token: k.token })).toBe(0) // memo: (flag,seq),(a,0)
		e.debug.takeBroadcasts()
		a.set(9) // urgent; a has NO canonical subscribers — kernel propagate reaches nothing
		// k's world includes applied urgent entries: c in k = 9.
		expect(e.debug.readWorld(c, { kind: 'writer', token: k.token })).toBe(9)
		// The notification can only come from the urgent drain re-validating
		// EVERY live deferred slot's chain (resolutions 1/3).
		const evs = e.debug.takeBroadcasts()
		expect(evs.map((x) => [x.token, x.value])).toContainEqual([k.token, 9])
		// Committed c unchanged at 0, no committed broadcast.
		expect(e.readCommitted(c)).toBe(0)
		expect(evs.filter((x) => x.token === 0)).toEqual([])
		fork.closeEvent()
		k.retire()
		e.debug.verify()
	})

	it('T6: retire/reuse hygiene with flipped polarity', () => {
		// Run T1 through k's retirement.
		k.run(() => flag.set(true))
		expect(e.debug.readWorld(c, { kind: 'writer', token: k.token })).toBe(0)
		k.run(() => a.set(1))
		k.retire()
		expect(e.readCommitted(c)).toBe(1) // flag=true, a=1 committed
		expect(e.debug.readWorld(c, { kind: 'w0' })).toBe(1)
		e.debug.takeBroadcasts()

		// New batch k2 (may reuse k's slot after sweep); flip polarity.
		const k2 = fork.openBatch('deferred')
		k2.run(() => flag.set(false)) // k2's world: c reads b
		expect(e.debug.readWorld(c, { kind: 'writer', token: k2.token })).toBe(0) // b = 0
		e.debug.takeBroadcasts()
		k2.run(() => b.set(5)) // world-only dep for k2 now
		expect(e.debug.readWorld(c, { kind: 'writer', token: k2.token })).toBe(5)
		const evs = e.debug.takeBroadcasts()
		expect(evs.map((x) => [x.token, x.value])).toContainEqual([k2.token, 5])
		// Canonical world unaffected by k2.
		expect(e.debug.readWorld(c, { kind: 'w0' })).toBe(1)
		k2.retire()
		expect(e.readCommitted(c)).toBe(5) // committed: flag=false → b = 5
		expect(e.debug.readWorld(c, { kind: 'w0' })).toBe(5)
		e.debug.verify()
	})
})
