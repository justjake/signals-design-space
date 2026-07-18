/**
 * One (suite, library) cell per worker lifetime: a fresh realm per cell,
 * so no library inherits JIT feedback, arena contents, or main-thread
 * work from the page or from other cells. The suites are the reactivity
 * benchmark submodule's own — the code its CI runs. The adapter is loaded
 * through the shared roster's dynamic import, so a worker evaluates
 * exactly one library.
 */
import { sbench } from "../../../../milomg-reactivity-benchmark/packages/core/src/benches/sBench"
import { kairoBench } from "../../../../milomg-reactivity-benchmark/packages/core/src/benches/kairoBench"
import { cellxbench } from "../../../../milomg-reactivity-benchmark/packages/core/src/benches/cellxBench"
import { dynamicBench } from "../../../../milomg-reactivity-benchmark/packages/core/src/benches/reactively/dynamicBench"
import { libraryByKey } from "../field/frameworks"
import type { ReactiveFramework } from "../../../../milomg-reactivity-benchmark/packages/core/src/util/reactiveFramework"

export interface BenchRequest {
  suite: string
  lib: string
}

export type BenchResponse =
  | { type: "test"; test: string; time: number }
  | { type: "done"; totalMs: number }
  | { type: "error"; message: string }

type SuiteRunner = (
  fw: ReactiveFramework<any>,
  log: (result: { test: string; time: number }) => void,
) => Promise<void>

const SUITES: Record<string, SuiteRunner> = {
  sbench: (fw, log) => sbench(fw, log),
  kairo: (fw, log) => kairoBench([{ framework: fw, testPullCounts: true }], log),
  cellx: (fw, log) => cellxbench([{ framework: fw, testPullCounts: true }], log),
  dynamic: (fw, log) => dynamicBench([{ framework: fw, testPullCounts: true }], log),
}

self.onmessage = async (e: MessageEvent<BenchRequest>) => {
  const { suite, lib } = e.data
  const post = (message: BenchResponse): void => self.postMessage(message)
  let total = 0
  try {
    const runner = SUITES[suite]
    if (runner === undefined) {
      throw new Error(`unknown suite "${suite}"`)
    }
    const framework = await libraryByKey(lib).load()
    await runner(framework, (result) => {
      total += result.time
      post({ type: "test", test: result.test, time: result.time })
    })
    post({ type: "done", totalMs: total })
  } catch (error) {
    post({ type: "error", message: String((error as Error)?.message ?? error) })
  }
}
