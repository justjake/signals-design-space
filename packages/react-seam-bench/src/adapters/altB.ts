/**
 * cosignals-alt-b consumed as a PLAIN uSES-style external store: subscribe
 * via `effect` (re-fires when the atom's committed state changes), snapshot
 * via `.state`, bulk writes batched with `startBatch`/`endBatch`.
 *
 * LIMITATION (documented, not a bug): alt-b's `startSignalTransition`
 * throws unless a ForkDouble runtime adapter is attached — its concurrent
 * API drives a simulated React, not the real one mounted by this benchmark.
 * So `writeManyInTransition` here is the plain-store shape:
 * `startTransition(() => writeMany(...))`, which per React's
 * useSyncExternalStore caveat falls back to one blocking synchronous
 * re-render. This contender measures alt-b as an ordinary signal store at
 * the uSES seam, directly comparable to alien-uses/dalien-uses.
 */
import { Atom, __resetEngineForTests, effect, endBatch, startBatch } from 'cosignals-alt-b';
import { startTransition, useCallback, useSyncExternalStore } from 'react';
import type { Contender } from './types.js';

// Same pre-sizing the harness adapter uses: the engine's typed-array planes
// regrow only at operation boundaries, so give the module-singleton engine
// room for the 5000-cell tree (cells + one subscription effect per mounted
// component, times fresh roots in the mount scenario) before any node
// exists. 2^18 records = an 8 MiB Int32Array main plane.
__resetEngineForTests({ initialRecords: 1 << 18 });

/** The slice of alt-b's Atom this adapter needs (read + write a number). */
interface NumAtom {
	readonly state: number;
	set(next: number): void;
}

function useCell(atom: NumAtom): number {
	const subscribe = useCallback(
		(cb: () => void) => {
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

const altBUses: Contender = {
	name: 'alt-b-uses',
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

export default altBUses;
