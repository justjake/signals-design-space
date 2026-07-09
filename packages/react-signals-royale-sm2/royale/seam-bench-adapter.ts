import { getRuntime, register, startTransitionWrite, useValue } from "../src/index";

register();

export default {
  name: "royale-sm2",
  createCells(count: number) {
    const runtime = getRuntime();
    const cells = new Array(count);
    for (let i = 0; i < count; ++i) cells[i] = runtime.atom(0);
    return {
      useCell(index: number): number {
        return useValue(cells[index]);
      },
      writeCell(index: number, value: number): void {
        cells[index].set(value);
      },
      writeMany(updates: Array<[number, number]>): void {
        runtime.batch(() => {
          for (const [index, value] of updates) cells[index].set(value);
        });
      },
      writeManyInTransition(updates: Array<[number, number]>): void {
        startTransitionWrite(() => {
          runtime.batch(() => {
            for (const [index, value] of updates) cells[index].set(value);
          });
        });
      },
      dispose(): void {},
    };
  },
};
