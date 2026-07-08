/** react-seam-bench Contender for fx2. */
import type { ComponentType, ReactNode } from 'react';
import { batch, set, signal, type Signal } from 'signals-royale-fx2';
import { SignalScope, registerReactSignals, startTransitionWrite, useValue } from '../src/index.ts';

registerReactSignals();

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
  name: 'royale-fx2',
  createCells(n: number): CellStore {
    const cells: Signal<number>[] = [];
    for (let i = 0; i < n; i++) cells.push(signal(0));
    return {
      useCell(i: number): number {
        return useValue(cells[i]);
      },
      writeCell(i: number, v: number): void {
        set(cells[i], v);
      },
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
        cells.length = 0; // dropped handles reclaim structurally
      },
      Provider: SignalScope as ComponentType<{ children: ReactNode }>,
    };
  },
};

export default contender;
