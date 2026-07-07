/**
 * cosignals-alt-a consumed as a PLAIN uSES-style external store: subscribe
 * via `effect` (re-fires when the atom's committed state changes), snapshot
 * via `.state`, bulk writes batched with `startBatch`/`endBatch`.
 *
 * LIMITATION (documented, not a bug): alt-a's concurrent machinery routes
 * through its ForkDouble runtime adapter (`createForkDouble`), not through
 * real React — there is no React binding that classifies writes into a
 * React transition. So `writeManyInTransition` here is the plain-store
 * shape: `startTransition(() => writeMany(...))`, which per React's
 * useSyncExternalStore caveat falls back to one blocking synchronous
 * re-render. This contender measures alt-a as an ordinary signal store at
 * the uSES seam, directly comparable to alien-uses/dalien-uses.
 */
import { Atom, effect, endBatch, startBatch } from 'cosignals-alt-a';
import { startTransition, useCallback, useSyncExternalStore } from 'react';
import type { Contender } from './types.js';

/** The slice of alt-a's Atom this adapter needs (read + write a number). */
interface NumAtom {
	readonly state: number;
	set(next: number): void;
}

function useCell(atom: NumAtom): number {
	const subscribe = useCallback(
		(cb: () => void) => {
			// Same subscription shape as the shared useReactive adapter: an
			// effect that reads the atom (establishing the dependency) and
			// notifies React on every rerun.
			const dispose = effect(() => {
				void atom.state;
				cb();
			});
			return dispose;
		},
		[atom],
	);
	const getSnapshot = useCallback((): number => atom.state, [atom]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const altAUses: Contender = {
	name: 'alt-a-uses',
	createCells(n) {
		const cells: NumAtom[] = [];
		for (let i = 0; i < n; i++) cells.push(new Atom({ state: 0 }));
		const writeMany = (updates: Array<[number, number]>): void => {
			startBatch();
			for (const [i, v] of updates) cells[i].set(v);
			endBatch();
		};
		return {
			useCell: (i) => useCell(cells[i]),
			writeCell: (i, v) => cells[i].set(v),
			writeMany,
			writeManyInTransition: (updates) => startTransition(() => writeMany(updates)),
			dispose() {},
		};
	},
};

export default altAUses;
