/**
 * react-seam-bench Contender: signals-royale-fh1 through its own bindings.
 * Module load registers the runtime against the signal-seam fork build.
 */
import type { ComponentType, ReactNode } from 'react';
import { atom, batch, type Atom } from 'signals-royale-fh1';
import { register, startTransitionWrite, useValue } from '../src/index';

register();

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

const contender: Contender = {
	name: 'royale-fh1',
	createCells(n: number): CellStore {
		const cells: Atom<number>[] = [];
		for (let i = 0; i < n; i++) cells.push(atom(0));
		return {
			useCell: (i) => useValue(cells[i]),
			writeCell: (i, v) => cells[i].set(v),
			writeMany(updates) {
				batch(() => {
					for (const [i, v] of updates) cells[i].set(v);
				});
			},
			writeManyInTransition(updates) {
				startTransitionWrite(() => {
					for (const [i, v] of updates) cells[i].set(v);
				});
			},
			dispose() {},
		};
	},
};

export default contender;
