/** Contender adapter for react-seam-bench. */
import type { ComponentType, ReactNode } from 'react';
import { atom, batch, set, type Atom } from 'signals-royale-fm2';
import { register, resetForTest, startTransitionWrite } from '../src/host.ts';
import { useValue } from '../src/hooks.ts';

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

register();

const contender: Contender = {
	name: 'royale-fm2',
	createCells(n: number): CellStore {
		const cells: Atom<number>[] = [];
		for (let i = 0; i < n; i++) cells.push(atom(0));
		return {
			useCell: (i) => useValue(cells[i]),
			writeCell: (i, v) => set(cells[i], v),
			writeMany(updates) {
				batch(() => {
					for (const [i, v] of updates) set(cells[i], v);
				});
			},
			writeManyInTransition(updates) {
				startTransitionWrite(() => {
					for (const [i, v] of updates) set(cells[i], v);
				});
			},
			dispose() {
				resetForTest();
			},
		};
	},
};

export default contender;
