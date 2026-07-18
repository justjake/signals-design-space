/**
 * cosignals binding — plug cosignals/debug into a Collector. The whole
 * adapter body lives in ./engine.ts, parameterized over the shared `/debug`
 * contract; this module only supplies the cosignals surface.
 */

import * as cosignalsDebug from "cosignals/debug"
import { NO_EVENT } from "cosignals/debug"
import {
  attachEngineDevtools,
  createEngineDevtools,
  type EngineDebug,
  type EngineDevtools,
} from "./engine.ts"

export type CosignalsDevtools = EngineDevtools

/**
 * Create a devtools session for the active cosignals engine and start
 * recording immediately: the trace hooks are installed and the collector is
 * exposed on `globalThis.__SIGNALS_DEVTOOLS__`. Call the returned `detach()`
 * to stop recording; `attach()` resumes into the same collector.
 */
export function attachCosignalsDevtools(opts?: {
  capacity?: number
  now?: () => number
}): CosignalsDevtools {
  return attachEngineDevtools(cosignalsDebug as EngineDebug, opts)
}

/**
 * Create a devtools session for the active cosignals engine without
 * recording anything yet. Nothing is traced — and the page pays nothing —
 * until the returned session's `attach()` is called.
 */
export function createCosignalsDevtools(opts?: {
  capacity?: number
  now?: () => number
}): CosignalsDevtools {
  return createEngineDevtools(cosignalsDebug as EngineDebug, opts)
}

// Re-export so callers can reference the root sentinel if they build cause
// chains by hand.
export { NO_EVENT }
