/**
 * cosignals binding — plug cosignals/debug into a Collector. The whole
 * adapter body lives in ./engine.ts, parameterized over the shared `/debug`
 * contract; this module only supplies the cosignals surface.
 */

import * as cosignalsDebug from "cosignals/debug"
import { NO_EVENT } from "cosignals/debug"
import { attachEngineDevtools, type EngineDebug, type EngineDevtools } from "./engine.ts"

export type CosignalsDevtools = EngineDevtools

/**
 * Attach the collector to the active cosignals engine and expose it on
 * `globalThis.__SIGNALS_DEVTOOLS__`. Call the returned `detach()` to remove
 * the trace hook and stop observing.
 */
export function attachCosignalsDevtools(opts?: {
  capacity?: number
  now?: () => number
}): CosignalsDevtools {
  return attachEngineDevtools(cosignalsDebug as EngineDebug, opts)
}

// Re-export so callers can reference the root sentinel if they build cause
// chains by hand.
export { NO_EVENT }
