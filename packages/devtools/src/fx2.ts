/**
 * fx2 binding — plug signals-royale-fx2/debug into a Collector. The whole
 * adapter body lives in ./engine.ts, parameterized over the shared `/debug`
 * contract; this module only supplies fx2's surface.
 */

import * as fx2Debug from 'signals-royale-fx2/debug'
import { NO_EVENT } from 'signals-royale-fx2/debug'
import { attachEngineDevtools, type EngineDebug, type EngineDevtools } from './engine.ts'

export type Fx2Devtools = EngineDevtools

/**
 * Attach the collector to the active fx2 engine and expose it on
 * `globalThis.__SIGNALS_DEVTOOLS__`. Call the returned `detach()` to remove
 * the trace hook and stop observing.
 */
export function attachFx2Devtools(opts?: { capacity?: number; now?: () => number }): Fx2Devtools {
	return attachEngineDevtools(fx2Debug as EngineDebug, opts)
}

// Re-export so callers can reference the root sentinel if they build cause
// chains by hand.
export { NO_EVENT }
