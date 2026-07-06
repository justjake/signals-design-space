/**
 * M6 — the packed trace recorder (§16.2).
 *
 * Fixed-size integer records (stride 8) in Int32Array storage; zero
 * allocation per event. Two recording modes sharing one emit path:
 *
 * - RING(capacity): the flight recorder — one buffer, oldest overwritten;
 *   loss (overwrite) is expected and detectable via the drop counter.
 * - SESSION(chunkSize, maxBytes): lossless capture — a filled chunk is
 *   SEALED (immutable; stream/serialize while recording continues) and a new
 *   fixed-size chunk is appended; nothing is ever copied. If the next chunk
 *   would cross maxBytes, a loud truncation-marker event is emitted and the
 *   recorder degrades to RING behavior over the final chunk — loss is never
 *   silent.
 *
 * The event id is a monotonic counter doubling as the record's address:
 * RING position = id & (capacity-1); SESSION position = chunk[id >>
 * log2(chunkSize)] at (id & (chunkSize-1)) * 8. Dense monotonic ids make
 * losslessness PROVABLE: a session capture is complete iff its ids form one
 * gap-free range with no truncation-marker inside it (§16.2 / G-21).
 *
 * Record layout: +0 KIND, +1 CAUSE (event id of the provoking event; 0 =
 * root), +2 NODE, +3 WORLD, +4 TIME (µs delta, saturating), +5..+7 ARG0..2.
 */

import { KIND_NAMES, __setTracer } from './engine';

const STRIDE = 8;
const TK_TRUNCATION_MARKER = 13;

export type TraceEvent = {
	id: number;
	kind: number;
	kindName: string;
	cause: number;
	node: number;
	world: number;
	timeDeltaUs: number;
	args: [number, number, number];
};

export type TraceOptions =
	| { mode: 'ring'; capacity?: number }
	| { mode: 'session'; chunkSize?: number; maxBytes?: number };

function log2OfPow2(n: number): number {
	let b = 0;
	while (1 << b !== n) {
		++b;
		if (b > 30) {
			throw new Error('cosignals-alt-b/trace: capacity must be a power of two');
		}
	}
	return b;
}

const now: () => number = () => {
	const p = (globalThis as { performance?: { now(): number } }).performance;
	return p !== undefined ? p.now() * 1000 : 0;
};

export class PackedTracer {
	readonly mode: 'ring' | 'session';
	// Event ids are 1-based: CAUSE = 0 means "root cause" (§16.2), so a real
	// event id can never alias it.
	private nextId = 1;
	private lastTime = now();
	// ring
	private ring: Int32Array | undefined;
	private capacity = 0;
	private capBits = 0;
	// session
	private chunks: Int32Array[] = [];
	private chunkSize = 0;
	private chunkBits = 0;
	private maxBytes = 0;
	private degraded = false;
	truncationMarkerId = -1;

	constructor(options: TraceOptions) {
		this.mode = options.mode;
		if (options.mode === 'ring') {
			this.capacity = options.capacity ?? 1 << 16;
			this.capBits = log2OfPow2(this.capacity);
			this.ring = new Int32Array(this.capacity * STRIDE);
		} else {
			this.chunkSize = options.chunkSize ?? 1 << 12;
			this.chunkBits = log2OfPow2(this.chunkSize);
			this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
			this.chunks.push(new Int32Array(this.chunkSize * STRIDE));
		}
	}

	/** The engine's Tracer interface: seven integer stores, one now(). */
	emit(
		kind: number,
		cause: number,
		node: number,
		world: number,
		a0: number,
		a1: number,
		a2: number,
	): number {
		const id = this.nextId++;
		const t = now();
		let dt = (t - this.lastTime) | 0;
		if (dt < 0) {
			dt = 0;
		}
		if (dt > 0x7ffffffe) {
			dt = 0x7ffffffe; // saturating delta (a real impl emits clock-sync)
		}
		this.lastTime = t;
		let buf: Int32Array;
		let base: number;
		if (this.mode === 'ring') {
			buf = this.ring!;
			base = (id & (this.capacity - 1)) * STRIDE;
		} else {
			const chunkIndex = id >> this.chunkBits;
			if (!this.degraded && chunkIndex === this.chunks.length) {
				const nextBytes = (this.chunks.length + 1) * this.chunkSize * STRIDE * 4;
				if (nextBytes > this.maxBytes) {
					// Degrade to RING over the final chunk — loudly (§16.2).
					this.degraded = true;
					this.truncationMarkerId = id;
					buf = this.chunks[this.chunks.length - 1];
					base = (id & (this.chunkSize - 1)) * STRIDE;
					buf[base] = TK_TRUNCATION_MARKER;
					buf[base + 1] = 0;
					buf[base + 2] = 0;
					buf[base + 3] = 0;
					buf[base + 4] = dt;
					buf[base + 5] = id; // the drop boundary's event id
					buf[base + 6] = 0;
					buf[base + 7] = 0;
					return id;
				}
				this.chunks.push(new Int32Array(this.chunkSize * STRIDE));
				// The previous chunk is now SEALED (immutable).
			}
			if (this.degraded) {
				buf = this.chunks[this.chunks.length - 1];
				base = (id & (this.chunkSize - 1)) * STRIDE;
			} else {
				buf = this.chunks[chunkIndex];
				base = (id & (this.chunkSize - 1)) * STRIDE;
			}
		}
		buf[base] = kind;
		buf[base + 1] = cause;
		buf[base + 2] = node;
		buf[base + 3] = world;
		buf[base + 4] = dt;
		buf[base + 5] = a0;
		buf[base + 6] = a1;
		buf[base + 7] = a2;
		return id;
	}

	eventCount(): number {
		return this.nextId - 1;
	}

	lastId(): number {
		return this.nextId - 1;
	}

	/** RING: how many events have been overwritten (drop counter). */
	droppedBefore(): number {
		if (this.mode === 'ring') {
			return Math.max(0, this.eventCount() - this.capacity);
		}
		return 0;
	}

	/** Lazy decoder view (§16.2): one object materialized on demand; returns
	 * undefined for ids that were overwritten or never emitted. */
	decode(id: number): TraceEvent | undefined {
		if (id < 1 || id >= this.nextId) {
			return undefined;
		}
		let buf: Int32Array;
		let base: number;
		if (this.mode === 'ring') {
			if (id <= this.droppedBefore()) {
				return undefined; // overwritten
			}
			buf = this.ring!;
			base = (id & (this.capacity - 1)) * STRIDE;
		} else {
			if (this.degraded && id >= this.lossBoundary()) {
				// The final chunk is now a ring: it holds exactly the last
				// chunkSize ids (positions cycle by id & (chunkSize-1)).
				if (id < this.nextId - this.chunkSize) {
					return undefined; // overwritten
				}
				buf = this.chunks[this.chunks.length - 1];
				base = (id & (this.chunkSize - 1)) * STRIDE;
			} else {
				buf = this.chunks[id >> this.chunkBits];
				base = (id & (this.chunkSize - 1)) * STRIDE;
			}
		}
		const kind = buf[base];
		return {
			id,
			kind,
			kindName: KIND_NAMES[kind] ?? `kind:${kind}`,
			cause: buf[base + 1],
			node: buf[base + 2],
			world: buf[base + 3],
			timeDeltaUs: buf[base + 4],
			args: [buf[base + 5], buf[base + 6], buf[base + 7]],
		};
	}

	/** All decodable events, in id order. */
	events(): TraceEvent[] {
		const out: TraceEvent[] = [];
		for (let id = 1; id < this.nextId; ++id) {
			const e = this.decode(id);
			if (e !== undefined) {
				out.push(e);
			}
		}
		return out;
	}

	/** Sealed chunks (SESSION): immutable once full — safe to stream or
	 * serialize while recording continues. */
	sealedChunks(): readonly Int32Array[] {
		if (this.mode !== 'session') {
			return [];
		}
		// The final chunk is always live (it is the ring after a degrade);
		// every chunk below it is sealed.
		return this.chunks.slice(0, this.chunks.length - 1);
	}

	/** First id that is no longer overwrite-stable after a degrade: the start
	 * of the final (now ring) chunk. Sealed chunks below it never move. */
	private lossBoundary(): number {
		return (this.chunks.length - 1) * this.chunkSize;
	}

	/** G-21 — losslessness is provable, not promised: a SESSION capture is
	 * complete iff its ids form one gap-free range up to the loss boundary
	 * announced by the truncation-marker (or the whole capture when none). */
	verifyComplete(): {
		complete: boolean;
		from: number;
		to: number;
		truncatedAt: number | undefined;
	} {
		if (this.mode !== 'session') {
			const dropped = this.droppedBefore();
			return {
				complete: dropped === 0,
				from: dropped + 1,
				to: this.lastId(),
				truncatedAt: undefined,
			};
		}
		const truncatedAt = this.truncationMarkerId >= 0 ? this.truncationMarkerId : undefined;
		const to = truncatedAt !== undefined ? this.lossBoundary() - 1 : this.lastId();
		let complete = true;
		for (let id = 1; id <= to; ++id) {
			if (this.decode(id) === undefined) {
				complete = false;
				break;
			}
		}
		return { complete, from: 1, to, truncatedAt };
	}

	/** Walk CAUSE edges from an event back to its root cause (§16.2's
	 * cause-chain queries, as a decoder view over the packed records). */
	causeChain(id: number): TraceEvent[] {
		const chain: TraceEvent[] = [];
		let cur = this.decode(id);
		let guard = 0;
		while (cur !== undefined && ++guard < 1000) {
			chain.push(cur);
			if (cur.cause === 0 || cur.cause === cur.id) {
				break;
			}
			cur = this.decode(cur.cause);
		}
		return chain;
	}

	stats() {
		return {
			mode: this.mode,
			events: this.nextId,
			dropped: this.droppedBefore(),
			chunks: this.chunks.length,
			sealed: this.sealedChunks().length,
			truncated: this.truncationMarkerId >= 0,
			bytes:
				this.mode === 'ring'
					? this.ring!.byteLength
					: this.chunks.length * this.chunkSize * STRIDE * 4,
		};
	}
}

let installed: PackedTracer | undefined;

/** Install a recorder into the core's tracer slot. Whole-boot captures must
 * call this before the engine's first operation (§16.2 recipe). */
export function startTracing(options: TraceOptions): PackedTracer {
	installed = new PackedTracer(options);
	__setTracer(installed);
	return installed;
}

export function stopTracing(): PackedTracer | undefined {
	const t = installed;
	installed = undefined;
	__setTracer(undefined);
	return t;
}
