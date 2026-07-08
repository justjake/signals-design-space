/**
 * Contender adapter for react-seam-bench: n independent numeric cells.
 */
import type { ComponentType, ReactNode } from 'react';
import { atom, batch, set, type Atom } from 'signals-royale-fh2';
import { registerReactSignals, startTransitionWrite, useValue } from '../src/index';

export interface CellStore {
	useCell(i: number): number;
	writeCell(i: number, v: number): void;
	writeMany(updates: Array<[number, number]>): void;
	writeManyInTransition(updates: Array<[number, number]>): void;
	dispose(): void;
	Provider?: ComponentType<{ children: ReactNode }>;
}

export interface Contender {
	name: string;
	createCells(n: number): CellStore;
}

registerReactSignals();

const contender: Contender = {
	name: 'royale-fh2',
	createCells(n: number): CellStore {
		const cells: Array<Atom<number>> = [];
		for (let i = 0; i < n; i++) {
			cells.push(atom(0));
		}
		return {
			useCell: (i) => useValue(cells[i]!),
			writeCell: (i, v) => set(cells[i]!, v),
			writeMany(updates) {
				batch(() => {
					for (const [i, v] of updates) {
						set(cells[i]!, v);
					}
				});
			},
			writeManyInTransition(updates) {
				startTransitionWrite(() => {
					for (const [i, v] of updates) {
						set(cells[i]!, v);
					}
				});
			},
			dispose() {
				cells.length = 0; // handles reclaim once subscribers unmount
			},
		};
	},
};

export default contender;
