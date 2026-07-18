/**
 * The ONE shared adapter shape that both the conformance runner and the
 * benchmark/memory runners consume. It mirrors the public API every library
 * in this repo must expose (same surface as upstream alien-signals index.ts),
 * with values wrapped in { read, write } handles so benchmark code can
 * destructure them uniformly.
 */

export interface AdapterSignal<T> {
  read(): T
  write(value: T): void
}

export interface AdapterComputed<T> {
  read(): T
}

export interface FrameworkAdapter {
  /** Unique name; used for results files and result tables. */
  name: string
  signal<T>(initialValue: T): AdapterSignal<T>
  computed<T>(fn: () => T): AdapterComputed<T>
  /** Returns a disposer. `fn` may return a cleanup function. */
  effect(fn: () => void | (() => void)): () => void
  /**
   * Optional: an effect expressed as a (compute, reaction) pair — compute
   * runs tracked and returns a value, reaction runs untracked when that
   * value changes. Only libraries whose effect primitive natively takes
   * this shape implement it; the benchmark runner skips pair-style rows
   * for adapters that leave it undefined. Returns a disposer.
   */
  effectPair?(compute: () => unknown, reaction: (value: unknown) => void): () => void
  /** Returns a disposer that disposes every effect created inside `fn`. */
  effectScope(fn: () => void): () => void
  startBatch(): void
  endBatch(): void
  /**
   * Optional: run `fn` with dependency tracking suppressed. When absent, the
   * conformance suite's "Untracked / Unsampled Reads" section is skipped.
   */
  untracked?<T>(fn: () => T): T
}
