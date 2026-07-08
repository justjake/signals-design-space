/**
 * The engine's error carriers, shared by every engine module (and thrown
 * through the public surface, so all are exported from the package entry).
 */

/**
 * Thrown when a computed is read while its own evaluation frame is open —
 * that read is a dependency cycle. cosignals fails loudly instead of serving
 * the stale cached value (which is what upstream alien-signals does).
 */
export class CycleError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CycleError';
	}
}

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
export function getOrThrow<K, V>(map: Map<K, V>, id: K, what: string): V {
	const v = map.get(id);
	if (v === undefined) throw new ScheduleError(`unknown ${what} ${id}`);
	return v;
}
