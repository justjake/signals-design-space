import { atom, batch, register, startTransitionWrite, useValue } from "../src/index";

register();

export default {
  name: "royale-sh1",
  createCells(count: number) {
    const cells: Array<ReturnType<typeof atom<number>>> = [];
    for (let index = 0; index < count; index++) cells.push(atom(0));
    return {
      useCell: (index: number) => useValue(cells[index]),
      writeCell: (index: number, value: number) => cells[index].set(value),
      writeMany(updates: Array<[number, number]>) {
        batch(() => {
          for (const [index, value] of updates) cells[index].set(value);
        });
      },
      writeManyInTransition(updates: Array<[number, number]>) {
        startTransitionWrite(() => {
          for (const [index, value] of updates) cells[index].set(value);
        });
      },
      dispose() {},
    };
  },
};
