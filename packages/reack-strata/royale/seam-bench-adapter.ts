import type { ComponentType, ReactNode } from 'react'
import { Runtime } from 'strata-signals'
import { registerStrata, startSignalTransition, useSignal } from '../src/index'

export interface CellStore {
	useCell(i: number): number
	writeCell(i: number, value: number): void
	writeMany(updates: Array<[number, number]>): void
	writeManyInTransition(updates: Array<[number, number]>): void
	dispose(): void
	Provider?: ComponentType<{ children: ReactNode }>
}

export default {
	name: 'strata',
	createCells(size: number): CellStore {
		const runtime = new Runtime()
		const cells = new Array(size)
		for (let i = 0; i < size; i++) cells[i] = runtime.atom(0)
		const unregister = registerStrata(runtime)
		return {
			useCell(i) {
				return useSignal(cells[i]!)
			},
			writeCell(i, value) {
				cells[i]!.set(value)
			},
			writeMany(updates) {
				runtime.batch(() => {
					for (let i = 0; i < updates.length; i++) {
						const update = updates[i]!
						cells[update[0]]!.set(update[1])
					}
				})
			},
			writeManyInTransition(updates) {
				startSignalTransition(() => {
					runtime.batch(() => {
						for (let i = 0; i < updates.length; i++) {
							const update = updates[i]!
							cells[update[0]]!.set(update[1])
						}
					})
				})
			},
			dispose() {
				unregister()
				cells.length = 0
			},
		}
	},
}
