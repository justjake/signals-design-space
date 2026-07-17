/**
 * Memory probe child: measures retained heap for ONE framework.
 * Port of upstream-alien-signals/benchs/memoryUsage.mjs with its bug FIXED:
 * effect bodies are wrapped in braces so they do not return numbers (upstream
 * `effect(() => last())` returns a number that the effect runtime would treat
 * as a cleanup function, crashing v3.2.1 in the tree phase).
 *
 * Phases:
 *   1. 10_000 signals
 *   2. 10_000 computeds (computed[i] = signal[i] + 1)
 *   3. 10_000 effects   (effect[i] reads computed[i])
 *   4. 100x100 grid of computed chains, one effect per computed, then one
 *      source write (upstream "tree" phase)
 *
 * Rows print to stdout as `@@ROW {"framework","metric","kb"}`.
 * memory/run.ts bundles this file with esbuild (keepNames OFF — see
 * util/cli.ts bundleChild) and spawns `node --expose-gc <bundle>.mjs`.
 *
 * Caveat recorded in harness/README.md: numbers are measured through the
 * shared adapter, so each signal/computed carries an extra {read,write}
 * wrapper object. The overhead is uniform across frameworks — compare
 * relatively, and do not compare against upstream memoryUsage.mjs output.
 */
import { loadAdapter } from "../adapters/index"
import type { AdapterComputed, AdapterSignal } from "../adapters/types"

const frameworkName = process.env.FRAMEWORK ?? "alien-v3"
const adapter = await loadAdapter(frameworkName)

if (!globalThis.gc) {
  throw new Error("memory probe requires --expose-gc")
}
/**
 * Full GC until heapUsed stabilizes (a single gc();gc() pair proved
 * unreliable: leftover collectible garbage at the "before" mark can skew
 * phase deltas by multiple MB).
 */
const gcNow = () => {
  let prev = Infinity
  for (let i = 0; i < 10; i++) {
    globalThis.gc!()
    const used = process.memoryUsage().heapUsed
    if (prev - used < 16 * 1024) {
      break
    }
    prev = used
  }
}

/** Keeps every phase's allocations alive for later phases + final report. */
const keepAlive: unknown[] = []

function measure(metric: string, build: () => unknown): void {
  gcNow()
  const before = process.memoryUsage().heapUsed
  keepAlive.push(build())
  gcNow()
  const after = process.memoryUsage().heapUsed
  const kb = (after - before) / 1024
  console.error(`${metric}: ${kb.toFixed(2)} KB`)
  console.log(
    `@@ROW ${JSON.stringify({ framework: adapter.name, metric, kb: Number(kb.toFixed(2)) })}`,
  )
}

const N = 10_000

const signals: AdapterSignal<number>[] = []
measure("signals-10k", () => {
  for (let i = 0; i < N; i++) {
    signals.push(adapter.signal(0))
  }
  return signals
})

const computeds: AdapterComputed<number>[] = []
measure("computeds-10k", () => {
  for (let i = 0; i < N; i++) {
    const s = signals[i]
    computeds.push(adapter.computed(() => s.read() + 1))
  }
  return computeds
})

measure("effects-10k", () => {
  const disposers: (() => void)[] = []
  for (let i = 0; i < N; i++) {
    const c = computeds[i]
    // FIX vs upstream: braces so the effect body returns undefined.
    disposers.push(
      adapter.effect(() => {
        c.read()
      }),
    )
  }
  return disposers
})

measure("grid-100x100", () => {
  const w = 100
  const h = 100
  const src = adapter.signal(1)
  const disposers: (() => void)[] = []
  const nodes: AdapterComputed<number>[] = []
  for (let i = 0; i < w; i++) {
    // `last` is intentionally captured by reference, matching the upstream
    // probe's shape (effects re-read the column's latest computed on rerun).
    let last: AdapterComputed<number> = src
    for (let j = 0; j < h; j++) {
      const prev = last
      last = adapter.computed(() => prev.read() + 1)
      nodes.push(last)
      // FIX vs upstream: braces so the effect body returns undefined.
      disposers.push(
        adapter.effect(() => {
          last.read()
        }),
      )
    }
  }
  src.write(src.read() + 1)
  return { src, nodes, disposers }
})
