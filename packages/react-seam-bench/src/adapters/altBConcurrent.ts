/**
 * cosignals-alt-b consumed through its REAL concurrent React bindings
 * (cosignals-alt-b/react): useSignal subscriptions, writes classified by the
 * patched build's external-runtime protocol, transition writes riding the
 * transition's own batch (log-overlay worlds; no useSyncExternalStore).
 *
 * Activation order is load-bearing (same as the cosignals contender):
 * react-dom/client evaluates first so the renderer registers the protocol
 * provider; registerAltBReact() couples the module-singleton engine to it
 * before any root exists. Loaded via dynamic import only — registration is
 * process-wide.
 */
import 'react-dom/client';
import { Atom, __resetEngineForTests, batch } from 'cosignals-alt-b';
import { registerAltBReact, useSignal } from 'cosignals-alt-b/react';
import { startTransition } from 'react';
import type { Contender } from './types.js';

// Pre-size the engine planes for the 5000-cell tree before any node exists
// (planes regrow only at operation boundaries). 2^18 records = 8 MiB.
__resetEngineForTests({ initialRecords: 1 << 18 });
registerAltBReact();

/** The slice of alt-b's Atom this adapter needs (read + write a number). */
interface NumAtom {
	readonly id: number;
	readonly state: number;
	set(next: number): void;
}

const altBReact: Contender = {
	name: 'alt-b-react',
	createCells(n) {
		const atoms: NumAtom[] = [];
		for (let i = 0; i < n; i++) atoms.push(new Atom({ state: 0 }));
		const writeMany = (updates: Array<[number, number]>): void => {
			batch(() => {
				for (const [i, v] of updates) atoms[i].set(v);
			});
		};
		return {
			useCell: (i) => useSignal(atoms[i] as NumAtom & { state: number }),
			writeCell: (i, v) => atoms[i].set(v),
			writeMany,
			// Writes inside React.startTransition classify into the transition
			// batch (the engine's write gate reads the protocol's transition
			// context) and render at transition priority.
			writeManyInTransition: (updates) => startTransition(() => writeMany(updates)),
			dispose() {},
		};
	},
};

export default altBReact;
