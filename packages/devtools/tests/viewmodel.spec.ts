import { describe, expect, it } from 'vitest'
import { createAtom, createComputed, effect, set } from 'signals-royale-fx2'
import { attachFx2Devtools } from '../src/fx2.ts'
import { inspectorModel, logRows, nodeRows } from '../src/panel/viewmodel.ts'

function clock() {
	let t = 0
	return () => (t += 1000)
}

describe('panel view-model', () => {
	it('derives log rows, node rows, and an inspector model from live data', () => {
		const dt = attachFx2Devtools({ now: clock() })
		const { collector } = dt
		try {
			const count = createAtom(1, { label: 'count' })
			const doubled = createComputed(() => count.get() * 2, { label: 'doubled' })
			effect(
				() => doubled.get(),
				() => {},
			)
			set(count, 5)

			// Log rows carry the verbatim kind, a color class, and the node name.
			const rows = logRows(collector, {}, 50)
			expect(rows.length).toBeGreaterThan(0)
			const write = rows.find((r) => r.kind === 'set')!
			expect(write.cls).toBe('write')
			expect(write.name).toBe('count')
			const compute = rows.find((r) => r.kind === 'compute' && r.name === 'doubled')!
			expect(compute).toBeDefined()
			expect(compute.cls).toBe('compute')

			// Node rows for the graph view.
			const nrows = nodeRows(collector, '', 50)
			const dRow = nrows.find((n) => n.name === 'doubled')!
			expect(dRow.kind).toBe('computed')
			expect(dRow.value).toBe('10')
			expect(dRow.recomputes).toBeGreaterThanOrEqual(1)

			// Inspector model: value, deps by name, and a why-chain rooted at 0.
			const details = inspectorModel(collector, dRow.id)!
			expect(details.name).toBe('doubled')
			expect(details.node.valuePreview).toBe('10')
			expect(details.deps.map((d) => d.name)).toContain('count')
			expect(details.why.length).toBeGreaterThan(0)
			expect(details.why[0].cause).toBe(0)

			// A second write shows a real prev → next value diff: the adapter peeks
			// the atom's value inertly and diffs against the last it recorded.
			set(count, 9)
			const after = logRows(collector, {}, 50)
			const lastWrite = [...after].reverse().find((r) => r.kind === 'set' && r.name === 'count')!
			expect(lastWrite.summary).toBe('5 → 9')
		} finally {
			dt.detach()
		}
	})
})
