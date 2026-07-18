/**
 * cosignals-arena consumed through its own React bindings. The public
 * contract matches cosignals — reducer-dispatch wakes, transition drafts,
 * a mandatory provider — but the engine underneath stores the reactive
 * graph in flat typed arrays instead of linked objects. Benchmarking both
 * shows what the data-oriented engine changes at the React seam.
 *
 * CosignalsProvider is mandatory, so this contender sets Provider.
 * registerReactSignals() is idempotent and process-wide.
 */
import { batch, createAtom, type Atom } from "cosignals-arena"
import {
  registerReactSignals,
  CosignalsProvider,
  startSignalTransition,
  useSignal,
} from "cosignals-arena/react"
import type { Contender } from "./types.js"

registerReactSignals()

const cosignalsArena: Contender = {
  name: "cosignals-arena",
  createCells(n) {
    const cells: Array<Atom<number>> = []
    for (let i = 0; i < n; i++) {
      cells.push(createAtom(0))
    }
    return {
      useCell: (i) => useSignal(cells[i]),
      writeCell: (i, v) => cells[i].set(v),
      writeMany: (updates) => {
        batch(() => {
          for (const [i, v] of updates) {
            cells[i].set(v)
          }
        })
      },
      writeManyInTransition: (updates) => {
        startSignalTransition(() => {
          for (const [i, v] of updates) {
            cells[i].set(v)
          }
        })
      },
      dispose() {},
      Provider: CosignalsProvider,
    }
  },
}

export default cosignalsArena
