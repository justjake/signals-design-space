import { expect, test } from 'vitest'
import { Runtime, type Signal } from '../src/index'

test('a deep shared DAG materializes without rechecking clean subgraphs', () => {
	const runtime = new Runtime()
	let row: Signal<number>[] = []
	for (let i = 0; i < 5; i++) row.push(runtime.atom(i))
	let pulls = 0
	for (let depth = 1; depth < 30; depth++) {
		const previous = row
		row = []
		for (let i = 0; i < 5; i++) {
			row.push(
				runtime.computed(() => {
					pulls++
					return previous[i]!.state + previous[(i + 1) % 5]!.state
				}),
			)
		}
	}
	const dispose = runtime.effect(() => {
		for (let i = 0; i < row.length; i++) row[i]!.state
	})
	expect(pulls).toBe(145)
	dispose()
})
