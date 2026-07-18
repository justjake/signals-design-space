/**
 * A benchmark-shape adapter for cosignals-arena that imports only the
 * React-free core entry. The reactivity benchmark's own arena adapter
 * imports the package root, which registers the arena's React bindings as
 * an import side effect — fine in a benchmark worker, wrong on an engine
 * page whose React integration belongs to the page's selected engine
 * alone. The operations are identical to that adapter's, so timings and
 * field behavior are comparable.
 */
import {
  batch,
  createAtom,
  createComputed,
  createEffect,
  effectScope,
  type Atom,
  type Computed,
  type Signal,
} from "cosignals-arena/core"
import { installState } from "cosignals-arena/ssr"
import type { ReactiveFramework } from "../../../../milomg-reactivity-benchmark/packages/core/src/util/reactiveFramework"

type Cell = Signal<unknown>

let disposeScope: (() => void) | null = null

const NEVER_EQUAL = (): boolean => false
const NOOP_HANDLER = (): void => {}

export const cosignalsArenaCoreFramework: ReactiveFramework<Cell> = {
  name: "cosignals-arena",
  createSignal: (initialValue) => {
    const s = createAtom(initialValue)
    if (typeof initialValue === "function") {
      // The benchmark stores plain values; opt out of lazy-initializer
      // treatment for function-valued ones.
      installState(s, initialValue)
    }
    return s
  },
  readSignal: (s) => (s as Atom<unknown>).get(),
  writeSignal: (s, value) => {
    ;(s as Atom<unknown>).set(value)
  },
  createComputed: (fn) => createComputed(fn),
  readComputed: (cell) => (cell as Computed<unknown>).get(),
  effect: (fn) => {
    // The benchmark's tracked effect is a single tracked body; it runs as
    // the compute, and never-equal delivery keeps one handler run per re-run.
    createEffect(fn, NOOP_HANDLER, { equals: NEVER_EQUAL })
  },
  effectPair: (compute, reaction) => {
    createEffect(compute, reaction)
  },
  withBatch: (fn) => {
    batch(fn)
  },
  withBuild: <T,>(fn: () => T): T => {
    let out!: T
    disposeScope = effectScope(() => {
      out = fn()
    })
    return out
  },
  cleanup: () => {
    disposeScope?.()
    disposeScope = null
  },
}
