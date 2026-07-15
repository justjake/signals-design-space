import { describe, expect, it } from 'vitest'
import { createAtom, createComputed, read, set } from '../src/index.ts'
import { attachTracer, inspect, nodeId, nodeKind, nodeOf } from '../src/debug/index.ts'

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
