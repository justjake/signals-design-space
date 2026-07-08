/**
 * Causality debug log: an attachable tracer answering "why did this happen?".
 *
 * Every event carries a causal parent id; unrelated operations never chain
 * (the ambient cause is scoped to the propagation that raised it). Detached,
 * the cost is one null check per emit site. The ring mode bounds memory:
 * overflow evicts oldest and counts, never silently.
 */
import { setTraceEmitter, type TraceId } from './core.ts';

export interface TraceEvent {
	id: TraceId;
	kind: string;
	cause?: TraceId;
	detail?: Record<string, unknown>;
}

export class Tracer {
	events: TraceEvent[] = [];
	byId = new Map<TraceId, TraceEvent>();
	nextId: TraceId = 1;
	/** Ring capacity; Infinity = unbounded. */
	capacity: number;
	overflow = 0;
	attached = false;

	constructor(opts?: { capacity?: number }) {
		this.capacity = opts?.capacity ?? Infinity;
	}

	attach(): this {
		this.attached = true;
		setTraceEmitter((kind, cause, detail) => this.emit(kind, cause, detail));
		return this;
	}

	detach(): void {
		if (!this.attached) return;
		this.attached = false;
		setTraceEmitter(null);
	}

	emit(kind: string, cause: TraceId | undefined, detail?: Record<string, unknown>): TraceId {
		const event: TraceEvent = { id: this.nextId++, kind, cause, detail };
		this.events.push(event);
		this.byId.set(event.id, event);
		if (this.events.length > this.capacity) {
			const evicted = this.events.shift()!;
			this.byId.delete(evicted.id);
			this.overflow++;
		}
		return event.id;
	}

	/** The causal chain ending at `event`, oldest first. */
	chain(id: TraceId): TraceEvent[] {
		const out: TraceEvent[] = [];
		let cursor = this.byId.get(id);
		while (cursor !== undefined) {
			out.unshift(cursor);
			cursor = cursor.cause !== undefined ? this.byId.get(cursor.cause) : undefined;
		}
		return out;
	}

	/** Newest event matching `predicate`, or undefined. */
	findLast(predicate: (e: TraceEvent) => boolean): TraceEvent | undefined {
		for (let i = this.events.length - 1; i >= 0; i--) {
			if (predicate(this.events[i])) return this.events[i];
		}
		return undefined;
	}

	/** Human-readable causal chain from the newest event matching `predicate`
	 * back to its originating write or batch retirement. */
	explainLast(predicate: (e: TraceEvent) => boolean): string[] {
		const last = this.findLast(predicate);
		if (last === undefined) return ['(no matching event recorded)'];
		return this.chain(last.id).map(formatEvent);
	}
}

export function formatEvent(e: TraceEvent): string {
	const parts = [`#${e.id} ${e.kind}`];
	if (e.detail !== undefined) {
		for (const [k, v] of Object.entries(e.detail)) {
			if (v === undefined) continue;
			parts.push(`${k}=${formatValue(v)}`);
		}
	}
	if (e.cause !== undefined) parts.push(`<- #${e.cause}`);
	return parts.join(' ');
}

function formatValue(v: unknown): string {
	if (typeof v === 'string') return v;
	try {
		return JSON.stringify(v) ?? String(v);
	} catch {
		return String(v);
	}
}
