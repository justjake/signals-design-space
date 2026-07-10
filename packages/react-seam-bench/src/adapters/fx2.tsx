/**
 * signals-royale-fx2 consumed through its own React bindings — stock React,
 * no useSyncExternalStore: every hook wake is a reducer dispatch, so React's
 * own update queues decide which render passes see which state. Writes
 * wrapped in startTransitionWrite become a draft world carried by the
 * transition itself, so the bulk re-render proceeds at transition priority
 * while urgent updates keep committing — the participation the transition
 * scenario exists to separate.
 *
 * SignalScope is mandatory (hooks throw unscoped), so this contender sets
 * Provider. registerReactSignals() is idempotent and process-wide.
 */
import { batch, signal, type Signal } from 'signals-royale-fx2';
import {
	registerReactSignals,
	SignalScope,
	startTransitionWrite,
	useValue,
} from 'signals-royale-fx2/react';
import type { Contender } from './types.js';

registerReactSignals();

const fx2React: Contender = {
	name: 'fx2-react',
	createCells(n) {
		const cells: Array<Signal<number>> = [];
		for (let i = 0; i < n; i++) cells.push(signal(0));
		return {
			useCell: (i) => useValue(cells[i]),
			writeCell: (i, v) => cells[i].set(v),
			writeMany: (updates) => {
				batch(() => {
					for (const [i, v] of updates) cells[i].set(v);
				});
			},
			writeManyInTransition: (updates) => {
				startTransitionWrite(() => {
					for (const [i, v] of updates) cells[i].set(v);
				});
			},
			dispose() {},
			Provider: SignalScope,
		};
	},
};

export default fx2React;
