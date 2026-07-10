/**
 * dalien-signals (alien-signals with a data-oriented memory layout, same
 * call style: read `s()`, write `s(v)`) consumed through the shared
 * useSyncExternalStore adapter — identical adapter semantics to alien.ts so
 * the two libraries differ only in the library under the seam.
 */
import { computed, effect, endBatch, signal, startBatch } from 'dalien-signals'
import { startTransition } from 'react'
import type { Contender } from './types.js'
import { makeCells, makeUseCell, type CallableSignalLib } from './useReactive.js'

const lib: CallableSignalLib = {
	signal: (initial) => signal(initial),
	computed: (getter) => computed(getter),
	effect: (fn) => effect(fn),
	startBatch,
	endBatch,
}

const useCell = makeUseCell(lib)

const dalienUses: Contender = {
	name: 'dalien-uses',
	createCells(n) {
		const { cells, writeCell, writeMany } = makeCells(lib, n)
		return {
			useCell: (i) => useCell(cells[i]),
			writeCell,
			writeMany,
			writeManyInTransition: (updates) => startTransition(() => writeMany(updates)),
			dispose() {},
		}
	},
}

export default dalienUses
