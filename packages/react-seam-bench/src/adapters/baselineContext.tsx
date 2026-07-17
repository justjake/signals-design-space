/**
 * The honest React-only baseline: every cell value lives in one useReducer
 * at the root and reaches cells through a single context. Any write
 * produces a new context value, so every subscribed cell re-renders on
 * every write — React.memo on the cell components cannot prevent that,
 * because context updates bypass memo. That fan-out cost is the point of
 * this contender; do not "fix" it with per-cell contexts or selectors.
 */
import {
  createContext,
  startTransition,
  useContext,
  useEffect,
  useReducer,
  type ReactNode,
} from "react"
import type { Contender } from "./types.js"

type Action =
  | { type: "write"; i: number; v: number }
  | { type: "many"; updates: Array<[number, number]> }

function reduce(state: number[], action: Action): number[] {
  const next = state.slice()
  if (action.type === "write") {
    next[action.i] = action.v
  } else {
    for (const [i, v] of action.updates) {
      next[i] = v
    }
  }
  return next
}

const baselineContext: Contender = {
  name: "baseline-context",
  createCells(n) {
    const CellsContext = createContext<number[] | null>(null)
    const initial = new Array<number>(n).fill(0)
    // External writes go through the root component's dispatch, captured
    // on mount (dispatch identity is stable for the life of the root).
    let dispatchRef: ((action: Action) => void) | null = null

    function Provider({ children }: { children: ReactNode }) {
      const [state, dispatch] = useReducer(reduce, initial)
      useEffect(() => {
        dispatchRef = dispatch
        return () => {
          if (dispatchRef === dispatch) {
            dispatchRef = null
          }
        }
      }, [dispatch])
      return <CellsContext.Provider value={state}>{children}</CellsContext.Provider>
    }

    function requireDispatch(): (action: Action) => void {
      if (dispatchRef === null) {
        throw new Error("baseline-context: write before the Provider mounted")
      }
      return dispatchRef
    }

    return {
      Provider,
      useCell(i: number): number {
        const cells = useContext(CellsContext)
        if (cells === null) {
          throw new Error("baseline-context: useCell outside its Provider")
        }
        return cells[i]
      },
      writeCell: (i, v) => requireDispatch()({ type: "write", i, v }),
      // One action for the whole batch: a single reducer pass and a
      // single render, which is the best a reducer-in-React store can do.
      writeMany: (updates) => requireDispatch()({ type: "many", updates }),
      writeManyInTransition: (updates) =>
        startTransition(() => requireDispatch()({ type: "many", updates })),
      dispose() {
        dispatchRef = null
      },
    }
  },
}

export default baselineContext
