/**
 * Fan-out: 5000 independent cells, one component each; 200 single-cell
 * writes from outside React, each awaited to commit. The time column is the
 * median write-to-commit latency. For subscription-based contenders exactly
 * one cell component should re-render per write; the context baseline
 * re-renders all 5000. Both counts land in the extra stats rather than
 * failing the run — a wrong count shows up as data, not a crash.
 */
import type { Scenario } from './scenario.js'
import { cellRenderCount, drain, median, renderCells, until } from './support.js'

const N = 5000
const WRITES = 200

const fanout: Scenario = {
	name: 'fanout',
	async run(contender, report) {
		const store = contender.createCells(N)
		const tree = renderCells(store, N)
		await until(() => tree.readCell(N - 1) === '0', 'fanout mount')
		await drain()

		const times: number[] = []
		let renders = 0
		let maxRenders = 0
		// Deterministic LCG so every contender writes the same cell sequence.
		let seed = 0x2f6e2b1
		for (let w = 0; w < WRITES; w++) {
			seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff
			const i = seed % N
			const v = w + 1 // unique per write, so the sentinel match is unambiguous
			const before = cellRenderCount()
			const t0 = performance.now()
			store.writeCell(i, v)
			await until(() => tree.readCell(i) === String(v), `fanout write ${w} (cell ${i})`)
			times.push(performance.now() - t0)
			const delta = cellRenderCount() - before
			renders += delta
			if (delta > maxRenders) maxRenders = delta
		}

		report(median(times), {
			writes: WRITES,
			meanCellRendersPerWrite: Number((renders / WRITES).toFixed(2)),
			maxCellRendersPerWrite: maxRenders,
			profilerCommits: tree.profiler.commits,
			profilerActualDurationMs: Number(tree.profiler.actualDurationMs.toFixed(2)),
		})

		await tree.unmount()
		store.dispose()
		await drain()
	},
}

export default fanout
