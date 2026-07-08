/**
 * Causality debug log.
 *
 * An attachable event log that answers "why did this happen?". Every event
 * carries the id of the event that caused it (`cause`), so a consumer can walk
 * from a component re-render back through the delivery that scheduled it to the
 * write or batch retirement that started the chain. Detached, every emit site
 * costs a single branch on `tracing`.
 *
 * The log can run unbounded (default) or as a bounded ring: when the ring is
 * full the oldest events are dropped and counted, never silently lost.
 */

export type EventId = number;

export interface TraceEvent {
	id: EventId;
	kind: string;
	/** The event that caused this one; 0 when the operation was externally initiated. */
	cause: EventId;
	/** Human-oriented subject: an atom/computed label, a batch id, a container tag. */
	label?: string;
	data?: unknown;
}

/** True while a tracer is attached. Emit sites check this before building events. */
export let tracing = false;

let events: TraceEvent[] = [];
let ringCap = 0; // 0 = unbounded
let ringStart = 0; // index of oldest event when ring wrapped
let droppedCount = 0;
let nextId: EventId = 1;
let ambientCause: EventId = 0;

/** Record one event and return its id. Call only when `tracing` is true. */
export function emit(kind: string, label?: string, data?: unknown): EventId {
	const id = nextId++;
	const ev: TraceEvent = { id, kind, cause: ambientCause };
	if (label !== undefined) ev.label = label;
	if (data !== undefined) ev.data = data;
	if (ringCap > 0 && events.length >= ringCap) {
		events[ringStart] = ev;
		ringStart = (ringStart + 1) % ringCap;
		droppedCount++;
	} else {
		events.push(ev);
	}
	return id;
}

/** Set the ambient cause for subsequently emitted events; returns the previous one. */
export function setCause(id: EventId): EventId {
	const prev = ambientCause;
	ambientCause = id;
	return prev;
}

export function getCause(): EventId {
	return ambientCause;
}

/** Run `fn` with `id` as the ambient cause for everything it emits. */
export function withCause<T>(id: EventId, fn: () => T): T {
	const prev = ambientCause;
	ambientCause = id;
	try {
		return fn();
	} finally {
		ambientCause = prev;
	}
}

export interface TraceHandle {
	events(): TraceEvent[];
	/** Events dropped by the bounded ring since attach. */
	dropped(): number;
	/** The causal chain ending at `id`, oldest first, human-readable. */
	explain(id: EventId): string[];
	stop(): void;
}

/** Attach the tracer. `ring` bounds memory to the newest N events. */
export function startTrace(opts?: { ring?: number }): TraceHandle {
	tracing = true;
	events = [];
	ringStart = 0;
	droppedCount = 0;
	ringCap = opts?.ring ?? 0;
	return {
		events: snapshotEvents,
		dropped: () => droppedCount,
		explain,
		stop() {
			tracing = false;
			events = [];
		},
	};
}

function snapshotEvents(): TraceEvent[] {
	if (ringCap > 0 && events.length === ringCap) {
		return events.slice(ringStart).concat(events.slice(0, ringStart));
	}
	return events.slice();
}

function findEvent(id: EventId): TraceEvent | undefined {
	// Ids are dense and ascending; binary search over the (possibly rotated) log.
	const all = snapshotEvents();
	let lo = 0;
	let hi = all.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (all[mid].id === id) return all[mid];
		if (all[mid].id < id) lo = mid + 1;
		else hi = mid - 1;
	}
	return undefined;
}

/** Format one event as a single line. */
export function formatEvent(ev: TraceEvent): string {
	let s = `#${ev.id} ${ev.kind}`;
	if (ev.label !== undefined) s += ` ${ev.label}`;
	if (ev.data !== undefined) s += ` ${JSON.stringify(ev.data)}`;
	if (ev.cause !== 0) s += ` <- #${ev.cause}`;
	return s;
}

function explain(id: EventId): string[] {
	const chain: string[] = [];
	let cur = findEvent(id);
	let guard = 0;
	while (cur !== undefined && guard++ < 1000) {
		chain.push(formatEvent(cur));
		if (cur.cause === 0) break;
		const parent = findEvent(cur.cause);
		if (parent === undefined) {
			chain.push(`#${cur.cause} (evicted from ring)`);
			break;
		}
		cur = parent;
	}
	chain.reverse();
	return chain;
}
