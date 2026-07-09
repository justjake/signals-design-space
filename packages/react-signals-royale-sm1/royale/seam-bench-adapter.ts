import type { ComponentType, ReactNode } from "react";
import { atom, batch, register, startTransitionWrite, useValue, type Atom } from "../src/index.ts";

export interface CellStore {
  useCell(index: number): number;
  writeCell(index: number, value: number): void;
  writeMany(updates: Array<[number, number]>): void;
  writeManyInTransition(updates: Array<[number, number]>): void;
  dispose(): void;
  Provider?: ComponentType<{ children: ReactNode }>;
}

export interface Contender {
  name: string;
  createCells(count: number): CellStore;
}

register();

const contender: Contender = {
  name: "royale-sm1",
  createCells(count) {
    const cells: Atom<number>[] = [];
    for (let index = 0; index < count; index++) cells.push(atom(0));
    return {
      useCell: (index) => useValue(cells[index]),
      writeCell: (index, value) => cells[index].set(value),
      writeMany(updates) {
        batch(() => {
          for (const [index, value] of updates) cells[index].set(value);
        });
      },
      writeManyInTransition(updates) {
        startTransitionWrite(() => {
          for (const [index, value] of updates) cells[index].set(value);
        });
      },
      dispose() {},
    };
  },
};

export default contender;
