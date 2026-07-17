/**
 * cosignals-arena binding — plug cosignals-arena/debug into a
 * Collector. The whole adapter body lives in ./engine.ts, parameterized
 * over the shared `/debug` contract; this module only supplies the arena
 * fork's surface.
 */

import * as arenaDebug from "cosignals-arena/debug"
import { attachEngineDevtools, type EngineDebug, type EngineDevtools } from "./engine.ts"

export type CosignalsArenaDevtools = EngineDevtools

/**
 * Attach the collector to the active cosignals-arena engine and expose it on
 * `globalThis.__SIGNALS_DEVTOOLS__`. Call the returned `detach()` to remove
 * the trace hook and stop observing.
 */
export function attachCosignalsArenaDevtools(opts?: {
  capacity?: number
  now?: () => number
}): CosignalsArenaDevtools {
  return attachEngineDevtools(arenaDebug as EngineDebug, opts)
}
