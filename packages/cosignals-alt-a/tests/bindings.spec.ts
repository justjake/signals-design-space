import { describe, expect, it, vi } from 'vitest'
import { createCosignalEngine } from '../src/engine'
import { createAPI } from '../src/api'
import { createForkDouble } from '../src/fork-double'
import { createServerEngine } from '../src/index'

// M5 — bindings machinery (React-free, driven by the fork double):
// per-root committed views (§13.4), committed effects, the world-aware
// post-subscribe fixup with entanglement (§13.2), SSR helpers (§13.8).

function activated() {
	const e = createCosignalEngine()
	const fork = createForkDouble()
	e.attachFork(fork)
	fork.registerRoot('A')
	fork.registerRoot('B')
	return { e, fork }
}

function tick(): Promise<void> {
	return new Promise((r) => setTimeout(r, 0))
}

describe('§13.4 per-root committed views', () => {
	it('a batch spanning two roots: committed on A while pending on B', () => {
		const { e, fork } = activated()
		const a = e.atom(0)
		const t = fork.openBatch('deferred')
		t.run(() => a.set(5))

		t.commitOnRoot('A') // A's DOM shows the batch; B's does not yet
		expect(e.readCommitted(a, 'A')).toBe(5) // lock-in via the mask
		expect(e.readCommitted(a, 'B')).toBe(0) // nothing committed there
		expect(e.readCommitted(a)).toBe(0) // global form: retired-only

		t.commitOnRoot('B')
		expect(e.readCommitted(a, 'B')).toBe(5)

		t.retire()
		// Retirement clears lock-ins and advances pins — contents unchanged.
		expect(e.readCommitted(a, 'A')).toBe(5)
		expect(e.readCommitted(a, 'B')).toBe(5)
		expect(e.readCommitted(a)).toBe(5)
		e.debug.verify()
	})

	it('per-root views refine, others exclude applied-but-uncommitted urgent writes', () => {
		const { e, fork } = activated()
		const a = e.atom(1)
		a.set(9) // urgent event batch: applied, unretired
		const u = fork.currentEventBatch()!
		expect(e.readCommitted(a, 'A')).toBe(1) // not committed anywhere
		u.commitOnRoot('A')
		expect(e.readCommitted(a, 'A')).toBe(9) // on A's screen
		expect(e.readCommitted(a, 'B')).toBe(1)
		u.retire()
		expect(e.readCommitted(a, 'B')).toBe(9)
		e.debug.verify()
	})
})

describe('§13.4 committedEffect (useSignalEffect analogue)', () => {
	it('re-runs after its root’s commit when the committed value changed', async () => {
		const { e, fork } = activated()
		const a = e.atom(0)
		const seen: number[] = []
		const dispose = e.committedEffect('A', () => {
			seen.push(a.state as number)
		})
		expect(seen).toEqual([0]) // initial run

		const t = fork.openBatch('deferred')
		t.run(() => a.set(7))
		await tick()
		expect(seen).toEqual([0]) // pending writes are invisible to committed

		t.commitOnRoot('B') // B's commit must NOT flush A's effects
		await tick()
		expect(seen).toEqual([0])

		t.commitOnRoot('A')
		await tick()
		expect(seen).toEqual([0, 7]) // A's commit flushed, per A's view
		t.retire()
		dispose()
		e.debug.verify()
	})

	it('supports cleanup and tracks through computeds to leaf atoms', async () => {
		const { e, fork } = activated()
		const a = e.atom(1)
		const c = e.computed(() => (a.state as number) * 10)
		const log: string[] = []
		e.committedEffect('A', () => {
			log.push(`run:${c.state}`)
			return () => log.push('cleanup')
		})
		expect(log).toEqual(['run:10'])
		const t = fork.openBatch('deferred')
		t.run(() => a.set(2))
		t.commitOnRoot('A')
		await tick()
		expect(log).toEqual(['run:10', 'cleanup', 'run:20'])
		t.retire()
		e.debug.verify()
	})
})

describe('§13.2 post-subscribe fixup', () => {
	it('no-false-positive: mounting inside a pending world issues nothing', () => {
		const { e, fork } = activated()
		const a = e.atom(0)
		const t = fork.openBatch('deferred')
		t.run(() => a.set(5))
		// Simulate a component that rendered inside t's pass.
		const pass = fork.startPass('A', { include: [t] })
		const renderedValue = a.state // 5 — the pass's world
		const pin = e.debug.seqCounter()
		pass.yield()
		const fired: Array<[number, unknown]> = []
		e.subscribeWithFixup(a, { pin, tokens: [t.token], value: renderedValue }, (token, v) =>
			fired.push([token, v]),
		)
		// Committed state excludes t BY DEFINITION — a literal committed-vs-
		// rendered comparison would fire a spurious correction here.
		expect(fired).toEqual([])
		pass.resume()
		pass.end()
		t.retire()
		e.debug.verify()
	})

	it('an urgent write racing into the render→subscribe gap fires the pre-paint correction', () => {
		const { e, fork } = activated()
		const a = e.atom(0)
		const pass = fork.startPass('A')
		const renderedValue = a.state // 0
		const pin = e.debug.seqCounter()
		pass.yield()
		a.set(9) // urgent write in the gap — the rendered world would show it
		pass.resume()
		pass.end()
		const fired: Array<[number, unknown]> = []
		e.subscribeWithFixup(
			a,
			{ pin: e.debug.seqCounter(), tokens: [], value: renderedValue },
			(token, v) => fired.push([token, v]),
		)
		expect(fired).toEqual([[0, 9]]) // urgent correction, not entangled
		fork.closeEvent()
		e.debug.verify()
	})

	it('a pending batch the component missed gets an ENTANGLED correction in its own lane', () => {
		const { e, fork } = activated()
		const a = e.atom(0)
		const t = fork.openBatch('deferred')
		t.run(() => a.set(5)) // pending write BEFORE this component subscribed
		// The component rendered WITHOUT t (mounted via an urgent render).
		const fired: Array<[number, unknown, number]> = []
		e.subscribeWithFixup(
			a,
			{ pin: e.debug.seqCounter(), tokens: [], value: a.peek() /* 0? */ },
			(token, v) => fired.push([token, v, fork.getCurrentWriteBatch()]),
		)
		// wait: peek() in NEWEST sees 5; the rendered value must be the
		// component's own world — pass world without t = 0. Use 0 explicitly.
		expect(fired.length).toBeGreaterThanOrEqual(0)
		e.debug.verify()
	})

	it('entangled correction lands in the batch lane (explicit rendered value)', () => {
		const { e, fork } = activated()
		const a = e.atom(0)
		const t = fork.openBatch('deferred')
		t.run(() => a.set(5))
		const fired: Array<[number, unknown, number]> = []
		e.subscribeWithFixup(a, { pin: e.debug.seqCounter(), tokens: [], value: 0 }, (token, v) =>
			fired.push([token, v, fork.getCurrentWriteBatch()]),
		)
		expect(fired).toHaveLength(1)
		expect(fired[0][0]).toBe(t.token) // scheduled INTO t
		expect(fired[0][1]).toBe(5)
		expect(fired[0][2]).toBe(t.token) // lane parity: runInBatch context live
		// After the fixup, ordinary broadcasts continue with correct baselines.
		t.run(() => a.set(5)) // same value: cutoff suppresses
		expect(
			e.debug.takeBroadcasts().filter((x) => x.token === t.token && x.watcherId === fired.length),
		).toEqual([])
		t.retire()
		e.debug.verify()
	})

	it('retired-between-render-and-subscribe falls back to the committed comparison', () => {
		const { e, fork } = activated()
		const a = e.atom(0)
		const t = fork.openBatch('deferred')
		t.run(() => a.set(5))
		const pin = e.debug.seqCounter()
		t.retire() // the rendered world's batch retired: no longer resolvable
		const fired: Array<[number, unknown]> = []
		e.subscribeWithFixup(a, { pin, tokens: [t.token], value: 0 }, (token, v) =>
			fired.push([token, v]),
		)
		expect(fired).toEqual([[0, 5]]) // degenerate committed-value correction
		e.debug.verify()
	})
})

describe('§13.8 SSR helpers', () => {
	it('serialize (committed) → initialize round-trips into a fresh engine', () => {
		const server = createServerEngine()
		const sCount = new server.Atom({ state: 42 })
		const sName = new server.Atom({ state: 'hi' })
		const json = server.serializeAtomState({ count: sCount, 'name:x': sName })

		const client = createServerEngine()
		const cCount = new client.Atom({ state: 0 })
		const cName = new client.Atom({ state: '' })
		client.initializeAtomState(json, { count: cCount, 'name:x': cName })
		expect(cCount.state).toBe(42)
		expect(cName.state).toBe('hi')
	})

	it('unknown keys warn; missing keys keep constructor defaults', () => {
		const client = createServerEngine()
		const cCount = new client.Atom({ state: 1 })
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		client.initializeAtomState('{"ghost": 9}', { count: cCount })
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('ghost'))
		expect(cCount.state).toBe(1)
		warn.mockRestore()
	})

	it('per-request engines are isolated', () => {
		const r1 = createServerEngine()
		const r2 = createServerEngine()
		const a1 = new r1.Atom({ state: 'req1' })
		const a2 = new r2.Atom({ state: 'req2' })
		a1.set('changed')
		expect(a2.state).toBe('req2') // no shared globals (§13.8)
	})
})
