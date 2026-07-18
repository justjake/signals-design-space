/** Test-only adapter for the shared conformance and benchmark harnesses. */
import { SkipTest } from "reactive-framework-test-suite"
import {
  createAtom,
  createComputed,
  createEffect,
  effectScope,
  endBatch,
  startBatch,
  untrack,
} from "../src/index.ts"
import { SignalWriteForbidden } from "../src/graph.ts"
import { installState } from "../src/ssr.ts"

const adapter = {
  name: "cosignals",
  signal<T>(initialValue: T) {
    // The engine treats function-valued initials as lazy initializers; the
    // harness stores plain values, including functions, so opt out here.
    const s = createAtom(initialValue)
    if (typeof initialValue === "function") {
      installState(s, initialValue)
    }
    return {
      read: () => s.get(),
      write(value: T) {
        try {
          s.set(value)
        } catch (error) {
          if (
            error instanceof SignalWriteForbidden &&
            error.message === "writes inside computeds are forbidden"
          ) {
            throw new SkipTest("computed writes are disabled by policy")
          }
          throw error
        }
      },
    }
  },
  computed<T>(fn: () => T) {
    const c = createComputed(fn)
    return { read: () => c.get() }
  },
  // The harness's effect is a single tracked body. It runs as the compute;
  // a body that writes signals throws the computed write-policy error,
  // which signal.write above converts to SkipTest.
  effect(fn: () => void | (() => void)): () => void {
    return createEffect(
      () => fn(),
      (cleanup) => cleanup,
      { equals: () => false },
    )
  },
  // The pair shape is this library's native effect: compute runs tracked,
  // the reaction handler runs untracked when compute's value changes under
  // the default equality.
  effectPair(compute: () => unknown, reaction: (value: unknown) => void): () => void {
    return createEffect(compute, reaction)
  },
  effectScope,
  startBatch,
  endBatch,
  untracked: untrack,
}

export default adapter
