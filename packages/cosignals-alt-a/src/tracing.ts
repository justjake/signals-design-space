/**
 * §16 — tracing: packed arena records, not an object stream. The write side
 * is hot (per-write/per-read events at engine frequency); the read side is
 * rare and human — so writes are seven integer stores into an Int32Array and
 * reads hydrate lazily through the decoder view.
 *
 * Modes (§16.2): RING(capacity) — the flight recorder, oldest overwritten,
 * loss detectable via the drop counter; SESSION(chunkSize, maxBytes) — the
 * LOSSLESS capture: filled chunks are SEALED (immutable; streamable while
 * recording continues), nothing is ever copied, and a maxBytes breach emits
 * a loud truncation-marker then degrades to RING behavior over the final
 * chunk. Losslessness is provable, not promised: ids are dense and
 * monotonic, so a decoder verifies a capture as one gap-free id range with
 * no truncation-marker inside it.
 */

// Same-file const enum (§15.1 discipline).
const enum T {
	STRIDE = 8,
	F_KIND = 0,
	F_CAUSE = 1,
	F_NODE = 2,
	F_WORLD = 3,
	F_TIME = 4, // µs delta since previous event, saturating
	F_ARG0 = 5,
	F_ARG1 = 6,
	F_ARG2 = 7,
}

// A REGULAR enum on purpose: cross-file const enums are forbidden (§15.1 —
// packaging-dependent inlining). Emit sites in the engine are guarded by the
// tracer slot check, so the property accesses are dead code when untraced.
export enum TraceKind {
	ATOM_WRITE = 1,
	LOG_APPEND = 2,
	LOG_COALESCE = 3,
	TRUNCATE = 4,
	BATCH_RETIRED = 5,
	ABSORB = 6,
	COMPUTED_EVAL = 7, // flags in ARG2: 1 = memo hit
	NOTIFY_WALK = 8,
	BROADCAST = 9,
	RENDER_PASS_START = 10,
	RENDER_PASS_END = 11,
	SWEEP = 12,
	QUIESCENCE = 13,
	CLOCK_SYNC = 14,
	TRUNCATION_MARKER = 15,
}

export const TRACE_KIND_NAMES: Record<number, string> = {
	1: 'atom-write',
	2: 'log-append',
	3: 'log-coalesce',
	4: 'truncate',
	5: 'batch-retired',
	6: 'absorb',
	7: 'computed-eval',
	8: 'notify-walk',
	9: 'broadcast',
	10: 'render-pass-start',
	11: 'render-pass-end',
	12: 'sweep',
	13: 'quiescence',
	14: 'clock-sync',
	15: 'truncation-marker',
};

export type TraceEvent = {
	id: number;
	kind: string;
	kindCode: number;
	cause: number;
	node: number;
	world: number;
	timeDeltaUs: number;
	args: [number, number, number];
};

export type TracerMode =
	| { mode: 'ring'; capacity?: number }
	| { mode: 'session'; chunkSize?: number; maxBytes?: number };

export type Tracer = ReturnType<typeof createTracer>;

export function createTracer(opts: TracerMode) {
	const isSession = opts.mode === 'session';
	const capacity = !isSession ? (opts.capacity ?? 1 << 16) : 0;
	const chunkSize = isSession ? (opts.chunkSize ?? 1 << 12) : 0;
	const maxBytes = isSession ? (opts.maxBytes ?? 64 << 20) : 0;
	if (!isSession && (capacity & (capacity - 1)) !== 0) {
		throw new Error('tracing: ring capacity must be a power of two');
	}
	if (isSession && (chunkSize & (chunkSize - 1)) !== 0) {
		throw new Error('tracing: session chunkSize must be a power of two');
	}

	// RING storage: one buffer, position id & (capacity-1).
	// SESSION storage: a chunk list; position chunks[id >> log2(chunkSize)].
	const chunks: Int32Array[] = [new Int32Array((isSession ? chunkSize : capacity) * T.STRIDE)];
	const chunkShift = isSession ? Math.log2(chunkSize) : 0;
	let nextId = 0;
	let lastTime = 0;
	let truncatedAtId = -1; // SESSION: the truncation-marker's id; -1 = lossless
	let currentCause = 0;
	let allocations = 1; // observability for the G-20 test form

	function emit(kind: number, node: number, world: number, a0 = 0, a1 = 0, a2 = 0): number {
		const id = nextId++;
		let buf: Int32Array;
		let pos: number;
		if (!isSession) {
			buf = chunks[0];
			pos = (id & (capacity - 1)) * T.STRIDE;
		} else if (truncatedAtId >= 0) {
			// Degraded: RING behavior over the final chunk (§16.2).
			buf = chunks[chunks.length - 1];
			pos = (id & (chunkSize - 1)) * T.STRIDE;
		} else {
			const chunkIndex = id >> chunkShift;
			if (chunkIndex >= chunks.length) {
				const nextBytes = (chunks.length + 1) * chunkSize * T.STRIDE * 4;
				if (nextBytes > maxBytes) {
					// Loud, never silent: mark the boundary, then degrade.
					truncatedAtId = id;
					buf = chunks[chunks.length - 1];
					pos = (id & (chunkSize - 1)) * T.STRIDE;
					buf[pos + T.F_KIND] = TraceKind.TRUNCATION_MARKER;
					buf[pos + T.F_CAUSE] = currentCause;
					buf[pos + T.F_NODE] = 0;
					buf[pos + T.F_WORLD] = 0;
					buf[pos + T.F_TIME] = 0;
					buf[pos + T.F_ARG0] = id; // the drop-boundary event id
					buf[pos + T.F_ARG1] = 0;
					buf[pos + T.F_ARG2] = 0;
					return emit(kind, node, world, a0, a1, a2);
				}
				chunks.push(new Int32Array(chunkSize * T.STRIDE));
				++allocations; // exactly one bounded allocation per chunkSize events
			}
			buf = chunks[chunkIndex];
			pos = (id & (chunkSize - 1)) * T.STRIDE;
		}
		const now = Math.floor(performance.now() * 1000);
		const delta = lastTime === 0 ? 0 : Math.min(now - lastTime, 0x7ffffffe);
		lastTime = now;
		buf[pos + T.F_KIND] = kind;
		buf[pos + T.F_CAUSE] = currentCause;
		buf[pos + T.F_NODE] = node;
		buf[pos + T.F_WORLD] = world;
		buf[pos + T.F_TIME] = delta;
		buf[pos + T.F_ARG0] = a0;
		buf[pos + T.F_ARG1] = a1;
		buf[pos + T.F_ARG2] = a2;
		return id;
	}

	function locate(id: number): { buf: Int32Array; pos: number } | undefined {
		if (id < 0 || id >= nextId) {
			return undefined;
		}
		if (!isSession) {
			if (nextId - id > capacity) {
				return undefined; // overwritten (detectable loss)
			}
			return { buf: chunks[0], pos: (id & (capacity - 1)) * T.STRIDE };
		}
		if (truncatedAtId >= 0 && id >= truncatedAtId) {
			const tail = chunks[chunks.length - 1];
			if (nextId - id > chunkSize) {
				return undefined;
			}
			return { buf: tail, pos: (id & (chunkSize - 1)) * T.STRIDE };
		}
		const chunkIndex = id >> chunkShift;
		if (chunkIndex >= chunks.length) {
			return undefined;
		}
		return { buf: chunks[chunkIndex], pos: (id & (chunkSize - 1)) * T.STRIDE };
	}

	// The verbose object event exists ONLY as a lazy decoder view (§16.2).
	function decode(id: number): TraceEvent | undefined {
		const loc = locate(id);
		if (loc === undefined) {
			return undefined;
		}
		const { buf, pos } = loc;
		return {
			id,
			kindCode: buf[pos + T.F_KIND],
			kind: TRACE_KIND_NAMES[buf[pos + T.F_KIND]] ?? `kind:${buf[pos + T.F_KIND]}`,
			cause: buf[pos + T.F_CAUSE],
			node: buf[pos + T.F_NODE],
			world: buf[pos + T.F_WORLD],
			timeDeltaUs: buf[pos + T.F_TIME],
			args: [buf[pos + T.F_ARG0], buf[pos + T.F_ARG1], buf[pos + T.F_ARG2]],
		};
	}

	return {
		emit,
		decode,
		setCause(id: number): number {
			const prev = currentCause;
			currentCause = id;
			return prev;
		},
		get eventCount(): number {
			return nextId;
		},
		get dropCount(): number {
			if (!isSession) {
				return Math.max(0, nextId - capacity);
			}
			return truncatedAtId >= 0 ? Math.max(0, nextId - chunkSize - truncatedAtId) : 0;
		},
		/** SESSION: sealed (immutable, streamable) chunks — all but the one
		 * being written, while lossless. */
		sealedChunks(): Int32Array[] {
			if (!isSession || truncatedAtId >= 0) {
				return [];
			}
			const writing = nextId >> chunkShift;
			return chunks.slice(0, Math.min(writing, chunks.length));
		},
		/** §16.2/G-21: losslessness is provable — one gap-free id range with
		 * no truncation-marker inside it. */
		verifyLossless(): { lossless: boolean; from: number; to: number; truncatedAtId: number } {
			if (!isSession) {
				const from = Math.max(0, nextId - capacity);
				return { lossless: from === 0, from, to: nextId - 1, truncatedAtId: -1 };
			}
			if (truncatedAtId >= 0) {
				return { lossless: false, from: 0, to: truncatedAtId - 1, truncatedAtId };
			}
			for (let id = 0; id < nextId; ++id) {
				if (locate(id) === undefined) {
					return { lossless: false, from: 0, to: id - 1, truncatedAtId: -1 };
				}
			}
			return { lossless: true, from: 0, to: nextId - 1, truncatedAtId: -1 };
		},
		stats(): { events: number; chunks: number; allocations: number; truncated: boolean } {
			return {
				events: nextId,
				chunks: chunks.length,
				allocations,
				truncated: truncatedAtId >= 0,
			};
		},
	};
}
