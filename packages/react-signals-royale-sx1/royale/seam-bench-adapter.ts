import type { ComponentType, ReactNode } from 'react';
import { atom, batch, set, startTransitionWrite, useValue } from '../src/index.js';

export interface CellStore {
	useCell(i: number): number;
	writeCell(i: number, value: number): void;
	writeMany(updates: Array<[number, number]>): void;
	writeManyInTransition(updates: Array<[number, number]>): void;
	dispose(): void;
	Provider?: ComponentType<{ children: ReactNode }>;
}

const contender = {
	name: 'royale-sx1',
	createCells(count: number): CellStore {
		const cells = new Array<ReturnType<typeof atom<number>>>(count);
		for (let i = 0; i < count; i++) cells[i] = atom(0);
		return {
			useCell: index => useValue(cells[index]),
			writeCell: (index, value) => set(cells[index], value),
			writeMany(updates) {
				batch(() => {
					for (const [index, value] of updates) set(cells[index], value);
				});
			},
			writeManyInTransition(updates) {
				startTransitionWrite(() => this.writeMany(updates));
			},
			dispose() {},
		};
	},
};

export default contender;
