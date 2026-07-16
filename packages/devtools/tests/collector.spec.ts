import { describe, expect, it } from 'vitest'
import { createAtom, createComputed, effect, set } from 'signals-royale-fx2'
import { attachFx2Devtools } from '../src/fx2.ts'

// Deterministic monotonic clock so event timestamps are stable.
function fakeClock() {
	let t = 0
	return () => (t += 1000)
}

describe('fx2 → collector pipeline', () => {
	it('captures events, builds a graph, and inspects values inertly', () => {
		const dt = attachFx2Devtools({ now: fakeClock() })
		const { collector } = dt
		try {
			const count = createAtom(1, { label: 'count' })
			const doubled = createComputed(() => count.get() * 2, { label: 'doubled' })
			effect(
				() => doubled.get(),
				() => {},
			)

			set(count, 5)

			// Events captured with fx2's verbatim kind strings.
			const events = collector.events({}, 200)
			expect(events.length).toBeGreaterThan(0)
			const kinds = new Set(events.map((e) => e.kind))
			expect(kinds.has('set')).toBe(true)
			expect(kinds.has('compute')).toBe(true)
			expect(kinds.has('effect')).toBe(true)

			// Cause chain: the set-triggered effect run walks back to a root.
			const effectRun = [...events].reverse().find((e) => e.kind === 'effect')!
			const chain = collector.causeChain(effectRun.id)
			expect(chain[chain.length - 1].id).toBe(effectRun.id)
			expect(chain[0].cause).toBe(0)

			// Graph: nodes discovered with kinds + labels.
			const nodes = collector.search('', 200)
			const doubledNode = nodes.find((n) => n.label === 'doubled')!
			const countNode = nodes.find((n) => n.label === 'count')!
			expect(countNode.kind).toBe('atom')
			expect(doubledNode.kind).toBe('computed')

			// Inspection is inert and current: doubled recomputed to 10, deps → count.
			const details = collector.node(doubledNode.id)!
			expect(details.valuePreview).toBe('10')
			expect(details.stale).toBe(false)
			expect(details.deps).toContain(countNode.id)

			// Counts.
			const c = collector.counts()
			expect(c.nodes).toBeGreaterThanOrEqual(2)
			expect(c.byKind.atom).toBeGreaterThanOrEqual(1)
			expect(c.byKind.computed).toBeGreaterThanOrEqual(1)
			expect(c.events).toBe(events.length)
		} finally {
			dt.detach()
		}
	})

	it('hot mode is off by default and toggling installs/removes the engine hook', () => {
		const dt = attachFx2Devtools({ now: fakeClock() })
		const { collector } = dt
		const hotRows = () =>
			collector.events({}, 500).filter((e) => e.kind === 'propagate' || e.kind === 'check' || e.kind === 'pull')
		try {
			const count = createAtom(1, { label: 'hot-count' })
			const doubled = createComputed(() => count.get() * 2, { label: 'hot-doubled' })
			const dispose = effect(
				() => doubled.get(),
				() => {},
			)

			// Off by default: exercising the graph records no hot rows.
			expect(collector.hotMode()).toBe(false)
			set(count, 2)
			expect(hotRows()).toHaveLength(0)

			// Enabled: the same write now records propagate/check/pull rows,
			// carrying node ids only (numbers), never a node object.
			collector.setHotMode(true)
			expect(collector.hotMode()).toBe(true)
			set(count, 3)
			const hot = hotRows()
			const kinds = new Set(hot.map((e) => e.kind))
			expect(kinds.has('propagate')).toBe(true)
			expect(kinds.has('check')).toBe(true)
			expect(kinds.has('pull')).toBe(true)
			for (const e of hot) expect(typeof e.node).toBe('number')
			// The rows filter under their own kind class.
			expect(collector.events({ classes: ['hot'] }, 500)).toHaveLength(hot.length)

			// Disabled again: the hook is removed, no further hot rows arrive.
			collector.setHotMode(false)
			expect(collector.hotMode()).toBe(false)
			const recorded = hotRows().length
			set(count, 4)
			expect(hotRows()).toHaveLength(recorded)
			dispose()
		} finally {
			dt.detach()
		}
	})
})
