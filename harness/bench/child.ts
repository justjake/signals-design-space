/**
 * Bench child process: runs milomg-reactivity-benchmark suites for ONE
 * framework, importing the benchmark code directly from the submodule's
 * TypeScript source. bench/run.ts bundles this file with esbuild
 * (keepNames OFF — see util/cli.ts bundleChild for why) and spawns:
 *
 *   node --expose-gc <bundled child>.mjs
 *
 * env: FRAMEWORK (adapter name), SUITES (csv of kairo,sbench,cellx,dynamic).
 * Result rows print to stdout as `@@ROW {"suite","framework","test","time"}`;
 * progress and console.assert noise go to stderr.
 *
 * Note: only the bench modules + util/ are imported from the submodule; they
 * do not import any framework packages (verified 2026-07-03).
 */
import { loadAdapter } from "../adapters/index"
import type { AdapterComputed, AdapterSignal, FrameworkAdapter } from "../adapters/types"
import type { ReactiveFramework } from "../../milomg-reactivity-benchmark/packages/core/src/util/reactiveFramework"
import type { PerfResult } from "../../milomg-reactivity-benchmark/packages/core/src/util/perfLogging"
import { kairoBench } from "../../milomg-reactivity-benchmark/packages/core/src/benches/kairoBench"
import { sbench } from "../../milomg-reactivity-benchmark/packages/core/src/benches/sBench"
import { cellxbench } from "../../milomg-reactivity-benchmark/packages/core/src/benches/cellxBench"
import { dynamicBench } from "../../milomg-reactivity-benchmark/packages/core/src/benches/reactively/dynamicBench"

/**
 * The opaque cell type our adapter exposes to the benches: signals are
 * AdapterSignal handles (structurally an AdapterComputed plus write) and
 * computeds are AdapterComputed handles, so every cell can `.read()`.
 * readComputed must accept signal cells too (see reactiveFramework.ts) —
 * AdapterSignal is assignable to AdapterComputed, so that holds by typing.
 */
type Cell = AdapterComputed<unknown>

/**
 * Wrap our shared adapter in milomg's ReactiveFramework interface (the
 * static-method form: createX/readX/writeX over opaque cells).
 * Mirrors the submodule's own alienSignals.ts adapter: one scope disposer
 * held between withBuild and cleanup.
 */
function toReactiveFramework(adapter: FrameworkAdapter): ReactiveFramework<Cell> {
  let scope: (() => void) | null = null
  // Only defined when the adapter has a native (compute, reaction) effect;
  // the bench suites skip pair-style rows when this is undefined, so the
  // property must stay absent rather than becoming a wrapper.
  const effectPair = adapter.effectPair
    ? (compute: () => unknown, reaction: (value: unknown) => void): void => {
        // The disposer is intentionally dropped: effects die with the scope.
        adapter.effectPair!(compute, reaction)
      }
    : undefined
  return {
    effectPair,
    name: adapter.name,
    createSignal: (initialValue) => adapter.signal(initialValue),
    readSignal: (signal) => signal.read(),
    writeSignal: (signal, value) => {
      // createSignal only ever hands out AdapterSignal cells, and benches
      // only writeSignal cells they created via createSignal.
      ;(signal as AdapterSignal<unknown>).write(value)
    },
    createComputed: (fn) => adapter.computed(fn),
    readComputed: (cell) => cell.read(),
    effect: (fn) => {
      // The interface contract now guarantees fn returns undefined (bench
      // bodies are block-bodied), so fn passes through without the old
      // protective wrapper — a returned value would be treated as a cleanup
      // handle by alien v3.2+.
      // The disposer is intentionally dropped: effects die with the scope.
      adapter.effect(fn)
    },
    withBatch: (fn) => {
      adapter.startBatch()
      try {
        fn()
      } finally {
        adapter.endBatch()
      }
    },
    withBuild: <T>(fn: () => T): T => {
      let out!: T
      scope = adapter.effectScope(() => {
        out = fn()
      })
      return out
    },
    cleanup: () => {
      if (scope) {
        scope()
        scope = null
      }
    },
  }
}

type SuiteRunner = (
  framework: ReactiveFramework<Cell>,
  log: (result: PerfResult) => void,
) => Promise<void>

const SUITES: Record<string, SuiteRunner> = {
  // kairo includes molBench as its final case.
  kairo: (fw, log) => kairoBench([{ framework: fw }], log),
  sbench: (fw, log) => sbench(fw, log),
  cellx: (fw, log) => cellxbench([{ framework: fw }], log),
  dynamic: (fw, log) => dynamicBench([{ framework: fw, testPullCounts: true }], log),
}

export const suiteNames = Object.keys(SUITES)

async function main(): Promise<void> {
  const frameworkName = process.env.FRAMEWORK ?? "alien-v3"
  const requested = (process.env.SUITES ?? suiteNames.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  for (const suite of requested) {
    if (!SUITES[suite]) {
      throw new Error(`Unknown suite "${suite}". Known suites: ${suiteNames.join(", ")}`)
    }
  }
  if (!globalThis.gc) {
    console.error("warning: gc() unavailable — run with --expose-gc")
  }

  const adapter = await loadAdapter(frameworkName)
  const framework = toReactiveFramework(adapter)

  for (const suite of requested) {
    console.error(`[${adapter.name}] running suite: ${suite}`)
    const log = (result: PerfResult) => {
      console.error(`  ${result.test}: ${result.time.toFixed(2)} ms`)
      console.log(`@@ROW ${JSON.stringify({ suite, ...result })}`)
    }
    await SUITES[suite](framework, log)
  }
}

await main()
