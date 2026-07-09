import { atom, type Atom } from "signals-royale-sx2";
import { register, startTransitionWrite, useValue, write } from "../src/index";

register();

export interface CellStore {
  useCell(index: number): number;
  writeCell(index: number, value: number): void;
  writeMany(updates: Array<[number, number]>): void;
  writeManyInTransition(updates: Array<[number, number]>): void;
  dispose(): void;
}

export default {
  name: "royale-sx2",
  createCells(count: number): CellStore {
    const cells: Atom<number>[] = [];
    for (let index = 0; index < count; index++) cells.push(atom(0));
    return {
      useCell(index) {
        return useValue(cells[index]);
      },
      writeCell(index, value) {
        write(cells[index], value);
      },
      writeMany(updates) {
        for (const [index, value] of updates) write(cells[index], value);
      },
      writeManyInTransition(updates) {
        startTransitionWrite(() => {
          for (const [index, value] of updates) write(cells[index], value);
        });
      },
      dispose() {
        cells.length = 0;
      },
    };
  },
};
