import type { Contender } from '../adapters/types.js'

/**
 * Records one CSV row for the current scenario. `ms` becomes the time
 * column; `extra` carries secondary stats (render counts, transition
 * totals) that the child prints to stderr so stdout stays pure CSV.
 */
export type Report = (ms: number, extra?: Record<string, unknown>) => void

export interface Scenario {
	/** The CSV test column, and the suite key src/chart.mjs groups by. */
	name: string
	run(contender: Contender, report: Report): Promise<void>
}
