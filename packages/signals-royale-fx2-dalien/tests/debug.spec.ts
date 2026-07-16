import { describe, expect, it } from 'vitest'
import { createAtom, createComputed, effect, read, set } from '../src/index.ts'
import { attachTracer, inspect, nodeId, nodeKind, nodeOf, setHotTracer } from '../src/debug/index.ts'

describe('debug/inspect — inert observation', () => {
	it('reports kind, label, and value', () => {
		const a = createAtom(1, { label: 'a' })
		const c = createComputed(() => a.get() * 2, { label: 'c' })
		expect(read(c)).toBe(2)

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
		expect(read(c)).toBe(20)
		const cn = nodeOf(c)

		// A dependency changes; we deliberately do NOT read c.
		set(a, 100)

		const tracer = attachTracer()
		for (let i = 0; i < 3; i++) {
			const snap = inspect(cn)
			expect(snap.value).toBe(20) // old value, not 200 — proves no recompute
			expect(snap.stale).toBe(true)
		}
		// The load-bearing property: inspecting emitted zero compute events.
		expect(tracer.events().filter((e) => e.kind === 'compute')).toHaveLength(0)
		tracer.stop()

		// A real read re-evaluates and clears staleness.
		expect(read(c)).toBe(200)
		expect(inspect(cn).value).toBe(200)
		expect(inspect(cn).stale).toBe(false)
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
		const dispose = effect(
			() => c.get(),
			() => {},
		)

		// Detached (the default): writes and reads emit ZERO hot events. The
		// causal tracer is an independent channel — it sees the write, and no
		// hot kind ever flows through it.
		const tracer = attachTracer()
		set(a, 1)
		expect(read(c)).toBe(2)
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
		set(a, 2)
		expect(steps).toContain('propagate:hot-a')
		expect(steps).toContain('pull:hot-c')
		expect(steps.some((s) => s.startsWith('check:'))).toBe(true)

		// A subsequent read of a stale unwatched computed checks then pulls.
		const u = createComputed(() => a.get() * 10, { label: 'hot-u' })
		expect(read(u)).toBe(20)
		expect(steps).toContain('check:hot-u')
		expect(steps).toContain('pull:hot-u')

		// Detaching restores silence.
		setHotTracer(null)
		const recorded = steps.length
		set(a, 3)
		expect(read(u)).toBe(30)
		expect(steps).toHaveLength(recorded)
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
			const dispose = effect(
				() => c.get(),
				() => {},
			)
			set(a, 2)
			expect(read(c)).toBe(4)
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
