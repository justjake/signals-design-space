/** Contender for react-seam-bench. */
import { Atom, atom, batch } from 'signals-royale-fm1';
import {
	register,
	set,
	startTransitionWrite,
	useValue,
} from '../src/index.ts';

import type { ComponentType, ReactNode } from 'react';

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
	name: 'royale-fm1',
	createCells(n: number): CellStore {
		const cells: Atom<number>[] = [];
		for (let i = 0; i < n; i++) cells.push(atom(0));
		return {
			useCell(i: number): number {
				return useValue(cells[i]);
			},
			writeCell(i: number, v: number): void {
				set(cells[i], v);
			},
			writeMany(updates: Array<[number, number]>): void {
				batch(() => {
					for (const [i, v] of updates) set(cells[i], v);
				});
			},
			writeManyInTransition(updates: Array<[number, number]>): void {
				startTransitionWrite(() => {
					batch(() => {
						for (const [i, v] of updates) set(cells[i], v);
					});
				});
			},
			dispose(): void {
				cells.length = 0;
			},
		};
	},
};

export default contender;
