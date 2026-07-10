/** The engine's error types; all are exported from the package entry. */

/** Thrown when a computed is read during its own evaluation — a dependency
 * cycle (upstream alien-signals silently serves the stale cache instead). */
export class CycleError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'CycleError'
	}
}

/** An operation that is illegal in the engine's current state — e.g. a write
 * into a retired batch. It signals a mis-timed call, never data corruption. */
export class ScheduleError extends Error {}

/** An engine self-check failed — always a bug; never catch this. */
export class InvariantViolation extends Error {}

/** Look up an id, or throw {@link ScheduleError} for an unknown one. */
export function getOrThrow<K, V>(map: Map<K, V>, id: K, what: string): V {
	const v = map.get(id)
	if (v === undefined) throw new ScheduleError(`unknown ${what} ${id}`)
	return v
}
