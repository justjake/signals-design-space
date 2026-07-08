/**
 * Causality debug log: an attachable tracer that answers "why did this
 * happen?". Every event carries a causal parent id, so a component
 * re-render can be walked back through the delivery that scheduled it to
 * the write (or batch retirement) that originated the chain.
 *
 * Detached cost is one `tracer !== null` branch per emit site. Attached,
 * events append to either an unbounded array or a bounded ring; ring
 * overflow increments a counter — dropped events are counted, never
 * silent.
 */

export type TraceEventKind =
	| 'write' // canonical or draft write; data: label, batch (0 = canonical)
	| 'write-dropped' // equality-dropped write
	| 'batch-open'
	| 'batch-retire'
	| 'batch-discard'
	| 'pass-start' // render pass began; data: root, lanes
	| 'pass-end' // render pass closed; data: disposition 'commit' | 'discard'
	| 'root-commit' // data: root, lanes
	| 'mutation-window' // data: phase 'start' | 'stop'
	| 'deliver' // subscription notified; data: target label, batch
	| 'render' // component re-render observed by a hook; data: component
	| 'effect-run'
	| 'settle' // async settlement; data: label, ok
	| 'refresh'
	| 'install'; // SSR state install

export interface TraceEvent {
	id: number;
	kind: TraceEventKind;
	/** Causal parent event id; undefined for root causes. */
	cause?: number;
	data?: Record<string, unknown>;
}

export interface TracerOptions {
	/** Bounded-memory mode: keep at most this many events (a ring). */
	ring?: number;
}

export interface Tracer {
	events(kind?: TraceEventKind): TraceEvent[];
	/** Number of events discarded by the ring; 0 in unbounded mode. */
	dropped(): number;
	/** Latest event matching a predicate, searching newest-first. */
	last(pred: (e: TraceEvent) => boolean): TraceEvent | undefined;
	/** The causal chain from an event back to its root cause (oldest first). */
	chain(id: number): TraceEvent[];
	/** Human-readable line per chain event. */
	explain(id: number): string[];
	stop(): void;
}

let active: TracerState | null = null;
let nextEventId = 1;
/** The event id currently acting as the causal parent for new events. */
let currentCause = 0;

interface TracerState {
	buf: (TraceEvent | undefined)[];
	ring: number; // 0 = unbounded
	head: number; // next write index in ring mode
	count: number; // total appended
	dropped: number;
	byId: Map<number, TraceEvent>;
}

/** True when a tracer is attached (the one branch emit sites pay). */
export function tracing(): boolean {
	return active !== null;
}

/**
 * Emits an event and returns its id (0 when detached). The cause defaults
 * to the ambient causal parent established by `withCause`.
 */
export function emit(kind: TraceEventKind, data?: Record<string, unknown>, cause?: number): number {
	const t = active;
	if (t === null) {
		return 0;
	}
	const id = nextEventId++;
	const parent = cause ?? currentCause;
	const e: TraceEvent = { id, kind, data };
	if (parent !== 0) {
		e.cause = parent;
	}
	if (t.ring > 0) {
		const evicted = t.buf[t.head];
		if (evicted !== undefined) {
			t.byId.delete(evicted.id);
			t.dropped++;
		}
		t.buf[t.head] = e;
		t.head = (t.head + 1) % t.ring;
	} else {
		t.buf.push(e);
	}
	t.byId.set(id, e);
	t.count++;
	return id;
}

/** Runs `fn` with `cause` as the ambient causal parent for emitted events. */
export function withCause<T>(cause: number, fn: () => T): T {
	if (active === null) {
		return fn();
	}
	const prev = currentCause;
	currentCause = cause;
	try {
		return fn();
	} finally {
		currentCause = prev;
	}
}

/** Current ambient cause id (0 = none); lets emitters stash a parent. */
export function ambientCause(): number {
	return active === null ? 0 : currentCause;
}

function describe(e: TraceEvent): string {
	const bits = e.data
		? Object.entries(e.data)
				.map(([k, v]) => `${k}=${String(v)}`)
				.join(' ')
		: '';
	return `#${e.id} ${e.kind}${bits ? ' ' + bits : ''}${e.cause ? ` <- #${e.cause}` : ''}`;
}

export function attachTracer(options?: TracerOptions): Tracer {
	const ring = options?.ring ?? 0;
	const state: TracerState = {
		buf: ring > 0 ? new Array<TraceEvent | undefined>(ring) : [],
		ring,
		head: 0,
		count: 0,
		dropped: 0,
		byId: new Map(),
	};
	active = state;
	const ordered = (): TraceEvent[] => {
		if (state.ring === 0) {
			return state.buf.filter((e): e is TraceEvent => e !== undefined);
		}
		const out: TraceEvent[] = [];
		for (let i = 0; i < state.ring; i++) {
			const e = state.buf[(state.head + i) % state.ring];
			if (e !== undefined) {
				out.push(e);
			}
		}
		return out;
	};
	const chain = (id: number): TraceEvent[] => {
		const out: TraceEvent[] = [];
		let cur = state.byId.get(id);
		const seen = new Set<number>();
		while (cur !== undefined && !seen.has(cur.id)) {
			seen.add(cur.id);
			out.unshift(cur);
			cur = cur.cause !== undefined ? state.byId.get(cur.cause) : undefined;
		}
		return out;
	};
	return {
		events: (kind) => (kind ? ordered().filter((e) => e.kind === kind) : ordered()),
		dropped: () => state.dropped,
		last: (pred) => {
			const all = ordered();
			for (let i = all.length - 1; i >= 0; i--) {
				if (pred(all[i]!)) {
					return all[i];
				}
			}
			return undefined;
		},
		chain,
		explain: (id) => chain(id).map(describe),
		stop() {
			if (active === state) {
				active = null;
			}
		},
	};
}
