/**
 * Causality debug log: an attachable tracer that records "what caused what"
 * across the engine and the React bindings.
 *
 * Every event carries a causal parent id. Emit sites pass the ambient cause
 * (`currentCauseId()`) unless they know a more specific parent (a batch's
 * open event, a write event). When no tracer is attached, every emit site
 * costs one null check and returns 0.
 *
 * Storage is a bounded ring: overflow evicts the oldest events and counts
 * them (`dropped`), never silently.
 */

export type TraceEventId = number;

export interface TraceEvent {
	id: TraceEventId;
	kind: string;
	cause: TraceEventId;
	data?: Record<string, unknown>;
}

export interface Tracer {
	/** Ring storage. `events()` returns them oldest-first. */
	events(): TraceEvent[];
	/** How many events were evicted by the ring bound. */
	dropped(): number;
	/** Formatted causal chain from the newest event matching `pred` to its root. */
	why(pred: (e: TraceEvent) => boolean): string[];
	/** Detach: emits become no-ops again. */
	stop(): void;
}

let nextEventId: TraceEventId = 1;
let activeRing: TraceEvent[] | null = null;
let ringCapacity = 0;
let ringDropped = 0;

/** Ambient causal parent for events emitted right now. */
let ambientCause: TraceEventId = 0;

export function currentCauseId(): TraceEventId {
	return ambientCause;
}

export function withCause<T>(cause: TraceEventId, fn: () => T): T {
	const prev = ambientCause;
	ambientCause = cause;
	try {
		return fn();
	} finally {
		ambientCause = prev;
	}
}

export function traceActive(): boolean {
	return activeRing !== null;
}

/**
 * Record an event; returns its id (0 when detached). The returned id can be
 * held by long-lived objects (batches) to parent later events.
 */
export function emitTrace(
	kind: string,
	cause: TraceEventId,
	data?: Record<string, unknown>,
): TraceEventId {
	if (activeRing === null) return 0;
	const id = nextEventId++;
	activeRing.push({ id, kind, cause, data });
	if (activeRing.length > ringCapacity) {
		activeRing.splice(0, activeRing.length - ringCapacity);
		ringDropped += 1;
	}
	return id;
}

/** Emit and also make the new event the ambient cause for `fn`. */
export function emitAndRun<T>(
	kind: string,
	data: Record<string, unknown> | undefined,
	fn: () => T,
): T {
	const id = emitTrace(kind, ambientCause, data);
	if (id === 0) return fn();
	return withCause(id, fn);
}

function formatEvent(e: TraceEvent): string {
	let s = `#${e.id} ${e.kind}`;
	if (e.data) {
		for (const [k, v] of Object.entries(e.data)) {
			if (typeof v === 'object' && v !== null) continue;
			s += ` ${k}=${String(v)}`;
		}
	}
	return s;
}

export function startTrace(capacity = 10_000): Tracer {
	const ring: TraceEvent[] = [];
	activeRing = ring;
	ringCapacity = capacity;
	ringDropped = 0;
	return {
		events: () => ring.slice(),
		dropped: () => ringDropped,
		why(pred: (e: TraceEvent) => boolean): string[] {
			for (let i = ring.length - 1; i >= 0; i--) {
				if (!pred(ring[i])) continue;
				const chain: string[] = [];
				const byId = new Map<TraceEventId, TraceEvent>();
				for (const e of ring) byId.set(e.id, e);
				let cur: TraceEvent | undefined = ring[i];
				while (cur !== undefined) {
					chain.push(formatEvent(cur));
					cur = cur.cause === 0 ? undefined : byId.get(cur.cause);
				}
				return chain;
			}
			return [];
		},
		stop() {
			if (activeRing === ring) activeRing = null;
		},
	};
}
