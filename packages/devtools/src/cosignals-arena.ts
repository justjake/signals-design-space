/**
 * cosignals-arena binding — plug cosignals-arena/debug into a
 * Collector. The whole adapter body lives in ./engine.ts, parameterized
 * over the shared `/debug` contract; this module only supplies the arena
 * fork's surface.
 */

import * as arenaDebug from "cosignals-arena/debug"
import {
  attachEngineDevtools,
  createEngineDevtools,
  type EngineDebug,
  type EngineDevtools,
} from "./engine.ts"

export type CosignalsArenaDevtools = EngineDevtools

/**
 * Create a devtools session for the active cosignals-arena engine and start
 * recording immediately: the trace hooks are installed and the collector is
 * exposed on `globalThis.__SIGNALS_DEVTOOLS__`. Call the returned `detach()`
 * to stop recording; `attach()` resumes into the same collector.
 */
export function attachCosignalsArenaDevtools(opts?: {
  capacity?: number
  now?: () => number
}): CosignalsArenaDevtools {
  return attachEngineDevtools(arenaDebug as EngineDebug, opts)
}

/**
 * Create a devtools session for the active cosignals-arena engine without
 * recording anything yet. Nothing is traced — and the page pays nothing —
 * until the returned session's `attach()` is called.
 */
export function createCosignalsArenaDevtools(opts?: {
  capacity?: number
  now?: () => number
}): CosignalsArenaDevtools {
  return createEngineDevtools(arenaDebug as EngineDebug, opts)
}
