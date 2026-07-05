/**
 * cosignal consumed through its own React bindings (cosignal-react).
 *
 * The activation sequence below is load-bearing and once-per-process:
 * react-dom/client must evaluate first so the renderer registers its
 * external-runtime protocol provider, then registerCosignalReact() couples
 * the engine to it — before any root is created. Registration also patches
 * Atom's prototype over to the concurrent engine for the whole process,
 * which is why the contender registry loads this module with a dynamic
 * import: a process benchmarking any other contender must never load it.
 */
import 'react-dom/client';
import { Atom, batch, registerCosignalReact, useSignal } from 'cosignal-react';
import { startTransition } from 'react';
import type { Contender } from './types.js';

registerCosignalReact();

const cosignalReact: Contender = {
	name: 'cosignal-react',
	createCells(n) {
		const atoms: Atom<number>[] = [];
		for (let i = 0; i < n; i++) atoms.push(new Atom(0));
		return {
			// Reads subscribe via the bindings' own hook; writes stay plain
			// atom.set calls from outside React (writes during render throw).
			useCell: (i) => useSignal(atoms[i]),
			writeCell: (i, v) => atoms[i].set(v),
			writeMany(updates) {
				batch(() => {
					for (const [i, v] of updates) atoms[i].set(v);
				});
			},
			// Writes made inside React.startTransition classify into that
			// transition and render at transition priority — the capability
			// the transition scenario is built to expose.
			writeManyInTransition(updates) {
				startTransition(() => {
					batch(() => {
						for (const [i, v] of updates) atoms[i].set(v);
					});
				});
			},
			dispose() {},
		};
	},
};

export default cosignalReact;
