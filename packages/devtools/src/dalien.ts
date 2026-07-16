/**
 * fx2-dalien binding — plug signals-royale-fx2-dalien/debug into a
 * Collector. The whole adapter body lives in ./engine.ts, parameterized
 * over the shared `/debug` contract; this module only supplies the arena
 * fork's surface.
 */

import * as dalienDebug from 'signals-royale-fx2-dalien/debug'
import { attachEngineDevtools, type EngineDebug, type EngineDevtools } from './engine.ts'

export type DalienDevtools = EngineDevtools

/**
 * Attach the collector to the active fx2-dalien engine and expose it on
 * `globalThis.__SIGNALS_DEVTOOLS__`. Call the returned `detach()` to remove
 * the trace hook and stop observing.
 */
export function attachDalienDevtools(opts?: { capacity?: number; now?: () => number }): DalienDevtools {
	return attachEngineDevtools(dalienDebug as EngineDebug, opts)
}
