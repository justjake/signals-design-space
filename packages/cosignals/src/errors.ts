/**
 * The engine's two error carriers, shared by every engine module (and thrown
 * through the public surface, so both are exported from the package entry).
 */

/**
 * An operation that is illegal in the engine's current state (a write into a
 * retired batch, a resume of a non-yielded render, …). Schedule drivers — the
 * React bindings and the test harnesses simulating them — treat it as "this
 * call must not happen here", never as data corruption.
 */
export class ScheduleError extends Error {}

/** An engine self-check failed — always a bug; never catch this. */
export class InvariantViolation extends Error {}

/** Look up an id or throw the schedule error every resolver shares (the
 * node/batch/render/watcher registries all speak it). */
export function mustGet<K, V>(map: Map<K, V>, id: K, what: string): V {
	const v = map.get(id);
	if (v === undefined) throw new ScheduleError(`unknown ${what} ${id}`);
	return v;
}
