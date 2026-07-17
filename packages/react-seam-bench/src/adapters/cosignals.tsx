/**
 * cosignals consumed through its own React bindings — stock React,
 * no useSyncExternalStore: every hook wake is a reducer dispatch, so React's
 * own update queues decide which render passes see which state. Writes
 * wrapped in startSignalTransition become a draft world carried by the
 * transition itself, so the bulk re-render proceeds at transition priority
 * while urgent updates keep committing — the participation the transition
 * scenario exists to separate.
 *
 * CosignalsProvider is mandatory, so this contender sets Provider.
 * registerReactSignals() is idempotent and process-wide.
 */
import { batch, createAtom, type Atom } from 'cosignals'
import {
	registerReactSignals,
	CosignalsProvider,
	startSignalTransition,
	useSignal,
} from 'cosignals/react'
import type { Contender } from './types.js'

registerReactSignals()

const cosignals: Contender = {
	name: 'cosignals',
	createCells(n) {
		const cells: Array<Atom<number>> = []
		for (let i = 0; i < n; i++) {
			cells.push(createAtom(0))
		}
		return {
			useCell: (i) => useSignal(cells[i]),
			writeCell: (i, v) => cells[i].set(v),
			writeMany: (updates) => {
				batch(() => {
					for (const [i, v] of updates) {
						cells[i].set(v)
					}
				})
			},
			writeManyInTransition: (updates) => {
				startSignalTransition(() => {
					for (const [i, v] of updates) {
						cells[i].set(v)
					}
				})
			},
			dispose() {},
			Provider: CosignalsProvider,
		}
	},
}

export default cosignals
