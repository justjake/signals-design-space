/**
 * §18 — the React-free gate measurements this environment can price:
 *
 *   G-6a  first logged write (tape creation + mark-only cone walk) across
 *         cone sizes, plus the streaming-store idle-write workload (the
 *         measurement that decides experiment E4 — the A-vs-B gate).
 *   G-6b  steady logged urgent write (tape exists).
 *   G-7   deferred write, drain-amortized, across watcher fan-outs.
 *   G-8   held-open transition, hot NEWEST read loop over the marked cone.
 *   G-18/19 tracing unloaded / RING-enabled overhead.
 *
 * These are REPORTS (numbers printed for the milestone record), not hard CI
 * gates: micro-timings on shared CI hardware flake, and this pass explicitly
 * defers the perf work (const-closure planes, watermark growth, budget CI).
 * Only gross sanity ceilings are asserted.
 */
import { describe, expect, it } from 'vitest'
import { createCosignalEngine, type CosignalEngine } from '../src/engine'
import { createForkDouble, type ForkDouble } from '../src/fork-double'
import { createTracer } from '../src/tracing'

function bench(fn: () => void, iters: number): number {
	fn() // warm
	let best = Infinity
	for (let rep = 0; rep < 5; ++rep) {
		const t0 = performance.now()
		for (let i = 0; i < iters; ++i) {
			fn()
		}
		const dt = (performance.now() - t0) / iters
		if (dt < best) {
			best = dt
		}
	}
	return best * 1e6 // ns/op
}

function directEngine(): CosignalEngine {
	return createCosignalEngine()
}

function loggedEngine(): { e: CosignalEngine; fork: ForkDouble } {
	const e = createCosignalEngine()
	const fork = createForkDouble()
	e.attachFork(fork)
	fork.registerRoot('root')
	return { e, fork }
}

function buildCone(e: CosignalEngine, size: number): { atom: ReturnType<CosignalEngine['atom']> } {
	const atom = e.atom(0)
	for (let i = 0; i < size; ++i) {
		const c = e.computed(() => atom.state + i)
		c.state // link canonically
	}
	return { atom }
}

const report: Record<string, string> = {}

describe('§18 gate measurements (reported; sanity ceilings only)', () => {
	it('G-6a: first logged write across cone sizes + streaming-store idle writes', () => {
		for (const cone of [10, 100, 1000]) {
			// DIRECT baseline: steady write into the cone.
			const d = directEngine()
			const dc = buildCone(d, cone)
			let v = 0
			const directNs = bench(() => dc.atom.set(++v), 2000)

			// LOGGED tape-creation: one write per fresh era (write → retire →
			// quiescence sweeps the tape, so every write re-creates it).
			const { e, fork } = loggedEngine()
			const lc = buildCone(e, cone)
			let lv = 0
			const createNs = bench(() => {
				lc.atom.set(++lv)
				fork.closeEvent() // retire → sweep → quiescence: next write re-creates
			}, 500)
			report[`G-6a cone=${cone}`] =
				`DIRECT ${directNs.toFixed(0)}ns vs tape-create+retire ${createNs.toFixed(0)}ns = ${(createNs / directNs).toFixed(1)}x`
			expect(createNs / directNs).toBeLessThan(500)
		}

		// Streaming-store idle-write workload (E4's decider): sustained bare
		// urgent writes, React idle, batch retired per event.
		const d2 = directEngine()
		const da = d2.atom(0)
		let x = 0
		const directNs = bench(() => da.set(++x), 5000)
		const { e: e2, fork: f2 } = loggedEngine()
		const la = e2.atom(0)
		let y = 0
		const idleNs = bench(() => {
			la.set(++y)
			f2.closeEvent()
		}, 5000)
		report['G-6a streaming-store idle'] =
			`DIRECT ${directNs.toFixed(0)}ns vs LOGGED-idle ${idleNs.toFixed(0)}ns = ${(idleNs / directNs).toFixed(1)}x`
	})

	it('G-6b: steady logged urgent write (tape already exists) — spec target ≤2x', () => {
		const d = directEngine()
		const da = d.atom(0)
		let x = 0
		const directNs = bench(() => da.set(++x), 5000)

		const { e, fork } = loggedEngine()
		const la = e.atom(0)
		const holder = fork.openBatch('deferred') // keeps the era open: tape persists
		holder.run(() => la.set(-1))
		let y = 0
		const steadyNs = bench(() => la.set(++y), 5000)
		report['G-6b steady logged write'] =
			`DIRECT ${directNs.toFixed(0)}ns vs LOGGED ${steadyNs.toFixed(0)}ns = ${(steadyNs / directNs).toFixed(1)}x (spec gate 2x)`
		holder.retire()
		expect(steadyNs / directNs).toBeLessThan(200)
	})

	it('G-7: deferred write, drain-amortized, across watcher fan-outs — provisional ceiling 3x', () => {
		for (const fanout of [10, 100]) {
			const d = directEngine()
			const da = d.atom(0)
			for (let i = 0; i < fanout; ++i) {
				d.watch(da)
			}
			let x = 0
			const directNs = bench(() => da.set(++x), 1000)
			d.debug.takeBroadcasts()

			const { e, fork } = loggedEngine()
			const la = e.atom(0)
			for (let i = 0; i < fanout; ++i) {
				e.watch(la)
			}
			const t = fork.openBatch('deferred')
			let y = 0
			const deferredNs = bench(() => t.run(() => la.set(++y)), 1000)
			e.debug.takeBroadcasts()
			report[`G-7 fanout=${fanout}`] =
				`DIRECT-urgent ${directNs.toFixed(0)}ns vs deferred-drain ${deferredNs.toFixed(0)}ns = ${(deferredNs / directNs).toFixed(1)}x (provisional 3x)`
			t.retire()
		}
	})

	it('G-8: held-open transition, hot NEWEST read loop over the marked cone — spec gate 1.5x', () => {
		for (const certLen of [1, 4, 16]) {
			// DIRECT baseline: hot read of a computed over certLen atoms.
			const d = directEngine()
			const datoms = Array.from({ length: certLen }, (_, i) => d.atom(i))
			const dc = d.computed(() => datoms.reduce((s, a) => s + a.state, 0))
			dc.state
			const directNs = bench(() => dc.state, 20000)

			const { e, fork } = loggedEngine()
			const atoms = Array.from({ length: certLen }, (_, i) => e.atom(i))
			const c = e.computed(() => atoms.reduce((s, a) => s + a.state, 0))
			c.state
			const t = fork.openBatch('deferred') // held open
			t.run(() => atoms[0].set(100)) // marks the cone; unapplied entries live
			const markedNs = bench(() => c.state, 20000)
			report[`G-8 certLen=${certLen}`] =
				`DIRECT ${directNs.toFixed(0)}ns vs marked-NEWEST ${markedNs.toFixed(0)}ns = ${(markedNs / directNs).toFixed(1)}x (spec gate 1.5x)`
			t.retire()
		}
	})

	it('G-18/G-19: tracing on tier-0 DIRECT shapes (zero emits) + the LOGGED-loop clock floor', () => {
		// G-19's gate is tier-0 DIRECT shapes: the DIRECT write/read paths
		// carry ZERO tracing instructions, so the ratio prices only the
		// tracer-slot checks (§16.5 discipline).
		const d = directEngine()
		const da = d.atom(0)
		let prev = d.computed(() => da.state + 1)
		for (let i = 0; i < 30; ++i) {
			const p = prev
			prev = d.computed(() => p.state + 1)
		}
		const tail = prev
		d.effect(() => {
			tail.state
		})
		let y = 0
		const directLoop = (): void => {
			da.set(++y)
		}
		const untracedNs = bench(directLoop, 3000)
		d.setTracer(createTracer({ mode: 'ring', capacity: 1 << 16 }))
		const tracedNs = bench(directLoop, 3000)
		d.setTracer(undefined)
		const afterNs = bench(directLoop, 3000)
		report['G-19 RING traced (tier-0 DIRECT)'] =
			`untraced ${untracedNs.toFixed(0)}ns vs traced ${tracedNs.toFixed(0)}ns = ${(tracedNs / untracedNs).toFixed(2)}x (spec gate 1.15x)`
		report['G-18 tracer detached'] =
			`before ${untracedNs.toFixed(0)}ns vs after-detach ${afterNs.toFixed(0)}ns = ${(afterNs / untracedNs).toFixed(2)}x (expect ~1x)`
		expect(tracedNs / untracedNs).toBeLessThan(2)

		// Report (declared floor, not a gate): tracing a LOGGED write loop
		// pays ~20-25ns of performance.now() per emit.
		const { e, fork } = loggedEngine()
		const a = e.atom(0)
		const c = e.computed(() => a.state + 1)
		c.state
		const holder = fork.openBatch('deferred')
		holder.run(() => a.set(-1))
		let x = 0
		const loggedLoop = (): void => {
			a.set(++x)
			c.state
		}
		const lu = bench(loggedLoop, 5000)
		e.setTracer(createTracer({ mode: 'ring', capacity: 1 << 16 }))
		const lt = bench(loggedLoop, 5000)
		e.setTracer(undefined)
		report['G-19 LOGGED loop (report; clock floor)'] =
			`untraced ${lu.toFixed(0)}ns vs traced ${lt.toFixed(0)}ns = ${(lt / lu).toFixed(2)}x (~performance.now per emit)`
		holder.retire()
	})

	it('prints the gate report', () => {
		// eslint-disable-next-line no-console
		console.log('\n§18 gate measurements (this machine, unoptimized correctness build):')
		for (const [k, v] of Object.entries(report)) {
			// eslint-disable-next-line no-console
			console.log(`  ${k}: ${v}`)
		}
		expect(Object.keys(report).length).toBeGreaterThan(0)
	})
})
