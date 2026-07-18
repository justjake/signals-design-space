/**
 * cosignals' reducer atom driven exactly like a Redux store: ONE atom
 * holding every cell in a single array, mutated only by dispatching
 * actions through a pure copying reducer. This contender exists to compare
 * against redux-toolkit with the store architecture held equal — same
 * actions, same single-array state, same immutable-copy cost per dispatch —
 * so the difference measured is the store engine and its React seam, not
 * the state layout. The per-cell-atom design this library would normally
 * use is the separate "cosignals" contender.
 *
 * Reads mirror react-redux's per-component selector: each cell mounts a
 * useComputed selecting its own index, so a dispatch recomputes every
 * cell's selector (an O(1) array index, the same sweep react-redux runs
 * over its useSelector subscribers) but only the changed cell's computed
 * value passes the equality cutoff and re-renders its component.
 *
 * Dispatches inside startSignalTransition are recorded and replayed against
 * pending snapshots — the reducer atom's distinguishing feature — so the
 * transition scenario measures genuine transition participation rather
 * than the useSyncExternalStore sync fallback.
 */
import { createReducerAtom } from "cosignals"
import {
  registerReactSignals,
  CosignalsProvider,
  startSignalTransition,
  useComputed,
} from "cosignals/react"
import type { Contender } from "./types.js"

registerReactSignals()

type Action =
  | { type: "write"; i: number; v: number }
  | { type: "many"; updates: Array<[number, number]> }

function reduce(state: number[], action: Action): number[] {
  const next = state.slice()
  switch (action.type) {
    case "write":
      next[action.i] = action.v
      break
    case "many":
      for (const [i, v] of action.updates) {
        next[i] = v
      }
      break
    default:
      action satisfies never
  }
  return next
}

const cosignalsReducer: Contender = {
  name: "cosignals-reducer",
  createCells(n) {
    const cells = createReducerAtom<number[], Action>(reduce, () =>
      new Array<number>(n).fill(0),
    )
    return {
      useCell: (i) => useComputed(() => cells.get()[i], [i]),
      writeCell: (i, v) => cells.dispatch({ type: "write", i, v }),
      // One action for the whole batch, matching the redux-toolkit
      // contender: a single reducer pass and a single propagation.
      writeMany: (updates) => cells.dispatch({ type: "many", updates }),
      writeManyInTransition: (updates) => {
        startSignalTransition(() => {
          cells.dispatch({ type: "many", updates })
        })
      },
      dispose() {},
      Provider: CosignalsProvider,
    }
  },
}

export default cosignalsReducer
