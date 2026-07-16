/**
 * Causality debug log: an attachable tracer that answers "why did this
 * happen?". Every event carries a causal parent id, so the chain from a
 * component's latest re-render (or an effect's latest run) walks back to
 * the originating write, batch retirement, or thenable settlement.
 *
 * Detached cost is one null check per emit site. Attached, events go into a
 * bounded ring; overflow evicts the oldest events and counts them — never
 * silently.
 */

import {
	type Link,
	type ProducerNode,
	type ReactiveNode,
	type TraceEventId,
	type TraceFields,
	NO_EVENT,
	setTracer,
} from './graph.ts'

/** One entry in the tracer's ring. */
export interface TraceEvent {
	id: TraceEventId
	kind: string
	/** Causal parent event id; NO_EVENT when the operation was a root cause. */
	cause: TraceEventId
	label: string | undefined
	rootId: number | undefined
	suspensionId: number | undefined
	draftId: number | undefined
	error: unknown
	status: string | undefined
	phase: string | undefined
	world: readonly number[] | undefined
}

/** Options accepted by the Tracer constructor and attachTracer(). */
export interface TracerOptions {
	/** Ring capacity in events; overflow evicts oldest and is counted. */
	capacity?: number
}

/** Hard ceilings and defaults for the ring and its walks. */
const enum Limit {
	/** Smallest allowed ring; tiny rings evict too fast to answer anything. */
	MinCapacity = 16,
	/** Default ring capacity in events. */
	DefaultCapacity = 4096,
	/** whyLastDelivery chain ceiling: a corrupt cause chain must not hang. */
	MaxChainWalk = 1000,
}

class ObjectIds extends WeakMap<object, number> {
	private next = 1

	idFor(value: object): number {
		let id = this.get(value)
		if (id === undefined) {
			id = this.next++
			this.set(value, id)
		}
		return id
	}
}

/**
 * Bounded in-memory causality trace for the active signals engine.
 *
 * Constructing a tracer does not activate it; use {@link attachTracer} for
 * normal use. The public methods also support debug tooling that needs to
 * inspect or format retained events.
 */
export class Tracer {
	private ring: TraceEvent[]
	private head = 0
	private size = 0
	private stopped = false
	private firstEventId: TraceEventId
	private rootIds = new ObjectIds()
	private suspensionIds = new ObjectIds()
	/** Events evicted by ring overflow. */
	dropped = 0
	/** Most recent delivery event per node (component re-render / effect run). */
	private lastDelivery = new WeakMap<object, TraceEventId>()

	constructor(opts?: TracerOptions) {
		const capacity = Math.max(Limit.MinCapacity, opts?.capacity ?? Limit.DefaultCapacity)
		this.ring = new Array(capacity)
		this.firstEventId = nextTraceEventId
	}

	/** Record one event when this tracer is active and return its event id. */
	emit(
		kind: string,
		node: ReactiveNode | null,
		cause: TraceEventId,
		fields?: TraceFields,
	): TraceEventId {
		// attachTracer is the only activation path. Inactive instances cannot
		// emit, so event-id ranges from separate sessions never interleave.
		if (this.stopped || activeTracer !== this) {
			return NO_EVENT
		}
		const id = nextTraceEventId++
		// Reactive nodes can outlive a trace session. Only causes emitted by
		// this tracer are meaningful in its ring; older sessions are unrelated,
		// not "evicted" ancestors of the new event.
		const ownCause = cause >= this.firstEventId && cause < id ? cause : NO_EVENT
		const root = fields?.root
		const rootId = root === undefined ? undefined : this.rootIds.idFor(root)
		const suspension = fields?.suspension
		const suspensionId =
			suspension === undefined ? undefined : this.suspensionIds.idFor(suspension)
		const evt: TraceEvent = {
			id,
			kind,
			cause: ownCause,
			label: node?.label,
			rootId,
			suspensionId,
			draftId: fields?.draftId,
			error: fields?.error,
			status: fields?.status,
			phase: fields?.phase,
			world: fields?.world,
		}
		if (this.size === this.ring.length) {
			this.head = (this.head + 1) % this.ring.length
			this.dropped++
		} else {
			this.size++
		}
		this.ring[(this.head + this.size - 1) % this.ring.length] = evt
		if (kind === 'notify' || kind === 'effect') {
			if (node !== null) {
				this.lastDelivery.set(node, id)
			}
		}
		return id
	}

	/** All retained events, oldest first. */
	events(): TraceEvent[] {
		const out: TraceEvent[] = []
		for (let i = 0; i < this.size; i++) {
			const evt = this.ring[(this.head + i) % this.ring.length]
			out.push(evt)
		}
		return out
	}

	/** Find a retained event by id, or `undefined` after ring eviction. */
	find(id: TraceEventId): TraceEvent | undefined {
		for (let i = this.size - 1; i >= 0; i--) {
			const evt = this.ring[(this.head + i) % this.ring.length]
			if (evt.id === id) {
				return evt
			}
			if (evt.id < id) {
				break
			}
		}
		return undefined
	}

	/** Format one event as a compact, human-readable trace line. */
	format(evt: TraceEvent): string {
		const label = evt.label !== undefined ? ` ${JSON.stringify(evt.label)}` : ''
		const root = evt.rootId !== undefined ? ` root=${evt.rootId}` : ''
		const suspension = evt.suspensionId !== undefined ? ` suspension=${evt.suspensionId}` : ''
		const draft = evt.draftId !== undefined ? ` draft=${evt.draftId}` : ''
		const status = evt.status !== undefined ? ` status=${evt.status}` : ''
		const phase = evt.phase !== undefined ? ` phase=${evt.phase}` : ''
		const error = evt.error instanceof Error ? ` error=${JSON.stringify(evt.error.message)}` : ''
		return `#${evt.id} ${evt.kind}${label}${root}${suspension}${draft}${status}${phase}${error}`
	}

	/**
	 * The causal chain from the most recent delivery caused by this node,
	 * back to its originating write or retirement, human-readable.
	 *
	 * We deliver to watchers, not to the watched node, so notify/render are
	 * recorded against a subscriber. Asked about a producer, report the most
	 * recent delivery among its subscribers (a watcher passed directly still
	 * resolves via its own entry).
	 */
	whyLastDelivery(node: ReactiveNode | object): string[] {
		let start = this.lastDelivery.get(node)
		if (start === undefined) {
			for (let link: Link | undefined = (node as ProducerNode).subs; link !== undefined; link = link.nextSub) {
				const delivery = this.lastDelivery.get(link.sub)
				if (delivery !== undefined && (start === undefined || delivery > start)) {
					start = delivery
				}
			}
		}
		if (start === undefined) {
			return ['(no delivery recorded for this node)']
		}
		const chain: string[] = []
		let id: TraceEventId = start
		let guard = 0
		while (id !== NO_EVENT && guard++ < Limit.MaxChainWalk) {
			const evt = this.find(id)
			if (evt === undefined) {
				chain.push(`#${id} (evicted from ring; ${this.dropped} events dropped)`)
				break
			}
			chain.push(this.format(evt))
			id = evt.cause
		}
		return chain
	}

	/** Detach this tracer if active and ignore later attempts to emit into it. */
	stop(): void {
		this.stopped = true
		if (activeTracer === this) {
			activeTracer = null
			setTracer(null)
		}
	}
}

let activeTracer: Tracer | null = null
/**
 * Event ids never restart, so a node cannot accidentally point into a
 * later tracer session after the tracer that recorded its cause stops.
 */
let nextTraceEventId: TraceEventId = 1

/** Attach a tracer (replacing any active one). Detach via session.stop(). */
export function attachTracer(opts?: TracerOptions): Tracer {
	activeTracer?.stop()
	const tracer = new Tracer(opts)
	activeTracer = tracer
	// The built-in tracer records every entry the same way; a span open is just
	// another recorded event, and it doesn't time spans, so it needs no endSpan.
	const emit = (kind: string, node: ReactiveNode | null, cause: TraceEventId, data?: TraceFields) =>
		tracer.emit(kind, node, cause, data)
	setTracer({ emitEvent: emit, startSpan: emit })
	return tracer
}

/** Return the currently attached built-in tracer, or `null` when detached. */
export function getActiveTracer(): Tracer | null {
	return activeTracer
}
