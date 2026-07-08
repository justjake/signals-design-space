/**
 * cosignals-alt-a consumed through its OWN real-React bindings
 * (cosignals-alt-a/react): the concurrent contender. Reads subscribe via the
 * package's useSignal (render reads resolve the render pass's world through
 * the engine's §10 visibility machinery — no useSyncExternalStore anywhere);
 * transition writes go through startSignalTransition, so they classify into
 * the React transition batch via the §6 protocol bridge and render at
 * transition priority. This is the scenario the plain alt-a-uses contender
 * documents as its limitation.
 *
 * Activation order is load-bearing and once-per-process: react-dom/client
 * evaluates first (the renderer registers its protocol provider), then
 * registerAltAReact couples the default engine to it — before any root.
 * The contender registry dynamic-imports this module so no other contender's
 * process ever loads it.
 */
import 'react-dom/client';
import { Atom, batch, defaultApi } from 'cosignals-alt-a';
import { registerAltAReact, startSignalTransition, useSignal } from 'cosignals-alt-a/react';
import type { Contender } from './types.js';

registerAltAReact(defaultApi);

const altAReact: Contender = {
	name: 'alt-a-react',
	createCells(n) {
		const atoms: InstanceType<typeof Atom<number>>[] = [];
		for (let i = 0; i < n; i++) atoms.push(new Atom({ state: 0 }));
		return {
			useCell: (i) => useSignal<number>(atoms[i]),
			writeCell: (i, v) => atoms[i].set(v),
			writeMany(updates) {
				batch(() => {
					for (const [i, v] of updates) atoms[i].set(v);
				});
			},
			// Writes inside startSignalTransition classify into the transition
			// batch through the write classifier (one drain per batch), and the
			// corrective/broadcast re-renders land in the transition's own lanes.
			writeManyInTransition(updates) {
				startSignalTransition(() => {
					for (const [i, v] of updates) atoms[i].set(v);
				});
			},
			dispose() {},
		};
	},
};

export default altAReact;
