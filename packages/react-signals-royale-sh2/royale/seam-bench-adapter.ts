import type { ComponentType, ReactNode } from 'react';
import { atom, batch, disposeCell, read, set, startTransitionWrite, useValue, type Cell } from '../src';

export interface CellStore {
  useCell(i: number): number;
  writeCell(i: number, v: number): void;
  writeMany(updates: Array<[number, number]>): void;
  writeManyInTransition(updates: Array<[number, number]>): void;
  dispose(): void;
  Provider?: ComponentType<{ children: ReactNode }>;
}

const contender = {
  name: 'royale-sh2',
  createCells(n: number): CellStore {
    const cells: Cell<number>[] = [];
    for (let i = 0; i < n; i++) cells.push(atom(0));
    return {
      useCell(i) { return useValue(cells[i]); },
      writeCell(i, value) { set(cells[i], value); },
      writeMany(updates) { batch(() => { for (const [i, value] of updates) set(cells[i], value); }); },
      writeManyInTransition(updates) {
        startTransitionWrite(() => { for (const [i, value] of updates) set(cells[i], value); });
      },
      dispose() { for (const cell of cells) disposeCell(cell); },
    };
  },
};

export default contender;
