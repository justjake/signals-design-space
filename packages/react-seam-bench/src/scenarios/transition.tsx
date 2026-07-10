/**
 * The transition seam: rewrite all 2000 cells inside React.startTransition
 * while an unrelated urgent useState input keeps updating. Bindings that
 * classify external writes into the transition let each urgent update
 * commit quickly while the bulk re-render proceeds at transition priority.
 * useSyncExternalStore contenders instead re-render synchronously (see
 * adapters/useReactive.ts), so their first urgent update waits behind the
 * full blocking flush — that asymmetry in the p95 is the measurement, not
 * a harness bug. Native useState/useReducer baselines do participate in
 * transitions, so they sit between the two.
 */
import { useEffect, useState } from 'react'
import type { Scenario } from './scenario.js'
import { drain, p95, renderCells, sleep, until } from './support.js'

const N = 2000
const URGENT_UPDATES = 30
const URGENT_INTERVAL_MS = 16

let urgentSetter: ((v: number) => void) | null = null

function UrgentInput() {
	const [v, setV] = useState(0)
	useEffect(() => {
		urgentSetter = setV
		return () => {
			if (urgentSetter === setV) {
				urgentSetter = null
			}
		}
	}, [])
	return <output id="urgent">{v}</output>
}

function readUrgent(): string | null {
	const el = document.getElementById('urgent')
	return el === null ? null : el.textContent
}

const transition: Scenario = {
	name: 'transition',
	async run(contender, report) {
		const store = contender.createCells(N)
		const tree = renderCells(store, N, <UrgentInput />)
		await until(() => tree.readCell(N - 1) === '0' && readUrgent() === '0', 'transition mount')
		await drain()

		const updates: Array<[number, number]> = []
		for (let i = 0; i < N; i++) {
			updates.push([i, 1])
		}

		const latencies: number[] = []
		const tStart = performance.now()
		store.writeManyInTransition(updates)
		for (let k = 1; k <= URGENT_UPDATES; k++) {
			// The first urgent update fires immediately so it contends with
			// however the contender scheduled the bulk re-render; the rest
			// pace at roughly one per frame.
			if (k > 1) {
				await sleep(URGENT_INTERVAL_MS)
			}
			const set = urgentSetter
			if (set === null) {
				throw new Error('transition: urgent input is not mounted')
			}
			const t0 = performance.now()
			set(k)
			await until(() => readUrgent() === String(k), `urgent update ${k}`)
			latencies.push(performance.now() - t0)
		}
		await until(
			() => tree.readCell(0) === '1' && tree.readCell(N - 1) === '1',
			'transition completion',
		)
		const totalMs = performance.now() - tStart

		const sorted = [...latencies].sort((a, b) => a - b)
		report(p95(latencies), {
			urgentUpdates: URGENT_UPDATES,
			urgentMedianMs: Number(sorted[Math.floor(sorted.length / 2)].toFixed(2)),
			urgentMaxMs: Number(sorted[sorted.length - 1].toFixed(2)),
			transitionTotalMs: Number(totalMs.toFixed(2)),
			profilerCommits: tree.profiler.commits,
		})

		await tree.unmount()
		store.dispose()
		await drain()
	},
}

export default transition
