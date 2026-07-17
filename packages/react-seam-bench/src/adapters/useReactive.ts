/**
 * Shared useSyncExternalStore adapter for callable-signal libraries.
 * alien-signals and dalien-signals share one call style — read `sig()`,
 * write `sig(v)` — so both instantiate this factory.
 *
 * Per React's documented semantics, updates that reach components through
 * useSyncExternalStore are always synchronous, even when the store write
 * happens inside React.startTransition: mutating an external store during a
 * non-blocking transition makes React fall back to a blocking update
 * (https://react.dev/reference/react/useSyncExternalStore#caveats). This
 * adapter exists to measure exactly that behavior next to bindings whose
 * writes can classify into the transition.
 */
import { useCallback, useSyncExternalStore } from "react"

/** One numeric cell: call with no args to read, with a value to write. */
export type CallableCell = { (): number; (next: number): void }

export interface CallableSignalLib {
  signal(initial: number): CallableCell
  computed<T>(getter: () => T): () => T
  /** Runs fn now and on any change of its dependencies; returns dispose. */
  effect(fn: () => void): () => void
  startBatch(): void
  endBatch(): void
}

export function makeUseCell(lib: CallableSignalLib): (sig: CallableCell) => number {
  return function useCell(sig: CallableCell): number {
    const subscribe = useCallback(
      (cb: () => void) => {
        const dispose = lib.effect(() => {
          sig()
          cb()
        })
        return dispose
      },
      [sig],
    )
    // The cell is an overloaded callable (reader + writer); hand
    // useSyncExternalStore an unambiguous zero-arg reader.
    const getSnapshot = useCallback((): number => sig(), [sig])
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  }
}

export function makeCells(
  lib: CallableSignalLib,
  n: number,
): {
  cells: CallableCell[]
  writeCell(i: number, v: number): void
  writeMany(updates: Array<[number, number]>): void
} {
  const cells: CallableCell[] = []
  for (let i = 0; i < n; i++) {
    cells.push(lib.signal(0))
  }
  return {
    cells,
    writeCell(i: number, v: number): void {
      cells[i](v)
    },
    writeMany(updates: Array<[number, number]>): void {
      lib.startBatch()
      for (const [i, v] of updates) {
        cells[i](v)
      }
      lib.endBatch()
    },
  }
}
