/**
 * signals-royale-fx2 consumed through its own React bindings — stock React,
 * no useSyncExternalStore: every hook wake is a reducer dispatch, so React's
 * own update queues decide which render passes see which state. Writes
 * wrapped in startSignalTransition become a draft world carried by the
 * transition itself, so the bulk re-render proceeds at transition priority
 * while urgent updates keep committing — the participation the transition
 * scenario exists to separate.
 *
 * SignalScopeProvider is mandatory (hooks throw unscoped), so this
 * contender sets Provider. registerReactSignals() is idempotent and
 * process-wide.
 */
import { batch, createAtom, type Atom } from 'signals-royale-fx2'
import {
	registerReactSignals,
	SignalScopeProvider,
	startSignalTransition,
	useValue,
} from 'signals-royale-fx2/react'
import type { Contender } from './types.js'

registerReactSignals()

const fx2React: Contender = {
	name: 'fx2-react',
	createCells(n) {
		const cells: Array<Atom<number>> = []
		for (let i = 0; i < n; i++) {
			cells.push(createAtom(0))
		}
		return {
			useCell: (i) => useValue(cells[i]),
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
			Provider: SignalScopeProvider,
		}
	},
}

export default fx2React
