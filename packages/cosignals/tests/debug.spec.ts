import { describe, expect, it } from 'vitest'
import { createAtom, createComputed, createEffect } from '../src/index.ts'
import { attachTracer, inspect, nodeId, nodeKind, nodeOf, setHotTracer } from '../src/debug/index.ts'

describe('debug/inspect — inert observation', () => {
	it('reports kind, label, and value', () => {
		const a = createAtom(1, { label: 'a' })
		const c = createComputed(() => a.get() * 2, { label: 'c' })
		expect(c.get()).toBe(2)

		const snap = inspect(nodeOf(c))
		expect(snap.kind).toBe('computed')
		expect(snap.label).toBe('c')
		expect(snap.value).toBe(2)
		expect(snap.stale).toBe(false)
		expect(snap.status).toBe('ok')
	})

	it('shows the stale last-known value and never triggers a compute', () => {
		const a = createAtom(10, { label: 'a2' })
		const c = createComputed(() => a.get() * 2, { label: 'c2' })
		expect(c.get()).toBe(20)
		const cn = nodeOf(c)

		// A dependency changes; we deliberately do NOT read c.
		a.set(100)

		const tracer = attachTracer()
		for (let i = 0; i < 3; i++) {
			const snap = inspect(cn)
			expect(snap.value).toBe(20) // old value, not 200 — proves no recompute
			expect(snap.stale).toBe(true)
		}
		// The load-bearing property: inspecting emitted zero evaluation events.
		expect(tracer.events().filter((e) => e.kind === 'compute' || e.kind === 'recompute')).toHaveLength(0)
		tracer.stop()

		// A real read re-evaluates and clears staleness.
		expect(c.get()).toBe(200)
		expect(inspect(cn).value).toBe(200)
		expect(inspect(cn).stale).toBe(false)
	})

	it('traces compute on first evaluation and recompute after', () => {
		const a = createAtom(1, { label: 'src' })
		const c = createComputed(() => a.get() + 1, { label: 'cc' })
		const tracer = attachTracer()
		expect(c.get()).toBe(2) // first evaluation
		a.set(2)
		expect(c.get()).toBe(3) // re-evaluation
		const kinds = tracer
			.events()
			.filter((e) => e.label === 'cc' && (e.kind === 'compute' || e.kind === 'recompute'))
			.map((e) => e.kind)
		expect(kinds).toEqual(['compute', 'recompute'])
		tracer.stop()
	})

	it('classifies atoms and assigns stable ids', () => {
		const a = createAtom(0)
		const an = nodeOf(a)
		expect(nodeKind(an)).toBe('atom')
		expect(inspect(an).kind).toBe('atom')
		expect(nodeId(an)).toBe(nodeId(an))
	})
})

async function collect(times = 5): Promise<void> {
	if (typeof gc !== 'function') {
		throw new Error('run with --expose-gc')
	}
	for (let i = 0; i < times; i++) {
		gc()
		await new Promise<void>((r) => setTimeout(() => r(), 10))
	}
}

describe('debug/hot — gated hot algorithm channel', () => {
	it('is silent detached, emits propagate/check/pull attached, and silences again', () => {
		const a = createAtom(0, { label: 'hot-a' })
		const c = createComputed(() => a.get() + 1, { label: 'hot-c' })
		const dispose = createEffect(
			() => c.get(),
			() => {},
		)

		// Detached (the default): writes and reads emit ZERO hot events. The
		// causal tracer is an independent channel — it sees the write, and no
		// hot kind ever flows through it.
		const tracer = attachTracer()
		a.set(1)
		expect(c.get()).toBe(2)
		const kinds = new Set(tracer.events().map((e) => e.kind))
		tracer.stop()
		expect(kinds.has('set')).toBe(true)
		expect(kinds.has('propagate')).toBe(false)
		expect(kinds.has('check')).toBe(false)
		expect(kinds.has('pull')).toBe(false)

		// Attached: a write propagates to the watched subscriber, the flush
		// validates and re-evaluates — propagate, check, and pull all appear.
		const steps: string[] = []
		setHotTracer((node, step) => {
			steps.push(`${step}:${node.label ?? '?'}`)
		})
		a.set(2)
		expect(steps).toContain('propagate:hot-a')
		expect(steps).toContain('pull:hot-c')
		expect(steps.some((s) => s.startsWith('check:'))).toBe(true)

		// A subsequent read of a stale unwatched computed checks then pulls.
		const u = createComputed(() => a.get() * 10, { label: 'hot-u' })
		expect(u.get()).toBe(20)
		expect(steps).toContain('check:hot-u')
		expect(steps).toContain('pull:hot-u')

		// Detaching restores silence.
		setHotTracer(null)
		const recorded = steps.length
		a.set(3)
		expect(u.get()).toBe(30)
		expect(steps).toHaveLength(recorded)
		dispose()
	})

	it('hot steps carry the cause of the write that drove them', () => {
		const a = createAtom(0, { label: 'hc-a' })
		const c = createComputed(() => a.get() + 1, { label: 'hc-c' })
		const dispose = createEffect(
			() => c.get(),
			() => {},
		)
		const tracer = attachTracer()
		const hot: { step: string; cause: number }[] = []
		setHotTracer((_node, step, cause) => hot.push({ step, cause }))
		a.set(1)
		const write = tracer.events().find((e) => e.kind === 'set' && e.label === 'hc-a')!
		const propagate = hot.find((h) => h.step === 'propagate')!
		expect(propagate.cause).toBe(write.id) // the write that drove the wave, not a root
		// The pull driven by this write's flush chains to it too (not a root).
		expect(hot.some((h) => h.step === 'pull' && h.cause === write.id)).toBe(true)
		setHotTracer(null)
		tracer.stop()
		dispose()
	})

	it('an attached hot hook adds no strong retention of nodes', async () => {
		const steps: string[] = []
		// The hook receives live nodes but records only strings — the contract
		// the devtools adapter follows (ids/strings, never the node).
		setHotTracer((_node, step) => {
			steps.push(step)
		})
		let aRef!: WeakRef<object>
		let cRef!: WeakRef<object>
		;(() => {
			const a = createAtom(1)
			const c = createComputed(() => a.get() * 2)
			const dispose = createEffect(
				() => c.get(),
				() => {},
			)
			a.set(2)
			expect(c.get()).toBe(4)
			aRef = new WeakRef(nodeOf(a))
			cRef = new WeakRef(nodeOf(c))
			dispose()
		})()
		// Collected with the hook still attached: enabling hot mode pins nothing.
		await collect(10)
		setHotTracer(null)
		expect(steps.length).toBeGreaterThan(0)
		expect(aRef.deref()).toBeUndefined()
		expect(cRef.deref()).toBeUndefined()
	})
})
