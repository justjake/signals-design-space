/**
 * Contender adapter for react-seam-bench: cells as engine atoms, reads via
 * the subscribing hook, transitions via the engine's own batch scope.
 */
import type { ComponentType, ReactNode } from "react";
import { atom, batch, type Atom } from "signals-royale-fx1";
import { register, startTransitionWrite } from "../src/runtime";
import { useValue } from "../src/hooks";

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
  name: "royale-fx1",
  createCells(n: number): CellStore {
    let cells: Array<Atom<number>> | null = Array.from({ length: n }, () => atom(0));
    return {
      useCell(i: number): number {
        return useValue(cells![i]!);
      },
      writeCell(i: number, v: number): void {
        cells![i]!.set(v);
      },
      writeMany(updates: Array<[number, number]>): void {
        batch(() => {
          for (const [i, v] of updates) cells![i]!.set(v);
        });
      },
      writeManyInTransition(updates: Array<[number, number]>): void {
        startTransitionWrite(() => {
          batch(() => {
            for (const [i, v] of updates) cells![i]!.set(v);
          });
        });
      },
      dispose(): void {
        cells = null; // atoms carry no engine registry entries once unsubscribed
      },
    };
  },
};

export default contender;
