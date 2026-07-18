import type { ComponentType, ReactNode } from "react"

/**
 * What createCells returns: the hook cell components call, plus the write
 * entry points the harness drives. Writes always originate OUTSIDE React
 * (event handlers are not part of what this benchmark measures).
 */
export interface CellStore {
  /** Component hook: subscribes the calling component to cell i and returns its value. */
  useCell(i: number): number
  /** Single-cell write from outside React. */
  writeCell(i: number, v: number): void
  /** Bulk write, batched however the contender batches. */
  writeMany(updates: Array<[number, number]>): void
  /**
   * Bulk write wrapped in React.startTransition. This is the scenario that
   * separates bindings whose writes classify into the transition from
   * stores that force a blocking re-render regardless (see
   * adapters/useReactive.ts for the documented React behavior).
   */
  writeManyInTransition(updates: Array<[number, number]>): void
  /** Teardown between scenarios. */
  dispose(): void
  /**
   * Set by contenders whose reads need a component mounted above the
   * cells: the context baseline (its cell values live in a useReducer
   * inside this component), redux-toolkit (react-redux's store context),
   * and the cosignals contenders (CosignalsProvider). Contenders whose
   * hooks reach their store directly omit it.
   */
  Provider?: ComponentType<{ children: ReactNode }>
}

export interface Contender {
  /** CSV key (the framework column): under 32 characters, no commas. */
  name: string
  /** Build a store of n independent numeric cells, all initialized to 0. */
  createCells(n: number): CellStore
}
