/**
 * Collector — the in-page, library-agnostic heart of the devtools.
 *
 * Plain JS: a ring of normalized events, a reduced per-node DebugState, and
 * the Backend query surface. It holds ONLY numbers and strings — never a
 * reactive node object — so it can't leak the graph it observes and can't feed
 * back into it. Node metadata (kind, value, edges) is fetched through a
 * NodeProvider the library adapter implements; the collector never sees a
 * library type. No signals used internally, by construction.
 */

import type {
	Backend,
	Counts,
	DevtoolsEvent,
	EventFilter,
	GraphNode,
	KindClass,
	NodeDetails,
	NodeKind,
	NodeStatus,
} from './protocol.ts'
import { kindClass } from './protocol.ts'

/** The adapter's view of a live node, by id. All reads are inert (see the
 * fx2 adapter). `undefined` from any method means the node is gone. */
export interface NodeProvider {
	kind(id: number): NodeKind | undefined
	label(id: number): string | null
	value(id: number): { preview: string | null; status: NodeStatus; stale: boolean; pending: string | null } | undefined
	deps(id: number): number[]
	subs(id: number): number[]
}

interface DebugState {
	kind: NodeKind
	recomputes: number
	changes: number
	lastEventId: number
}

const DEFAULT_CAPACITY = 4096

export class Collector implements Backend {
	private readonly provider: NodeProvider
	private readonly capacity: number
	private readonly ring: DevtoolsEvent[] = []
	private ringHead = 0
	private nextId = 1
	private totalEvents = 0
	/** Reduced, retained per-node state — survives ring eviction. */
	private readonly nodes = new Map<number, DebugState>()
	private readonly listeners = new Set<() => void>()
	private t0 = 0
	private flushQueued = false

	constructor(provider: NodeProvider, opts?: { capacity?: number; now?: () => number }) {
		this.provider = provider
		this.capacity = Math.max(16, opts?.capacity ?? DEFAULT_CAPACITY)
		this.now = opts?.now ?? (() => performance.now() * 1000)
		this.t0 = this.now()
	}

	private now: () => number

	/**
	 * Ingest one trace event. Returns the assigned id so the adapter can hand
	 * it back to the engine as the cause of downstream events. `nodeKind` lets
	 * the collector register a node's kind on first sighting without a
	 * provider round-trip.
	 */
	record(
		kind: string,
		node: number | null,
		cause: number,
		nodeKind: NodeKind | undefined,
		data: Record<string, unknown>,
	): number {
		const id = this.nextId++
		this.totalEvents++
		const evt: DevtoolsEvent = {
			id,
			kind,
			cause: cause > 0 && cause < id ? cause : 0,
			t: Math.round(this.now() - this.t0),
			node,
			data,
		}
		if (this.ring.length < this.capacity) {
			this.ring.push(evt)
		} else {
			this.ring[this.ringHead] = evt
			this.ringHead = (this.ringHead + 1) % this.capacity
		}
		if (node !== null && nodeKind !== undefined) {
			let st = this.nodes.get(node)
			if (st === undefined) {
				st = { kind: nodeKind, recomputes: 0, changes: 0, lastEventId: id }
				this.nodes.set(node, st)
			}
			st.lastEventId = id
			const cls = kindClass(kind)
			if (cls === 'compute') st.recomputes++
			if (cls === 'write') st.changes++
		}
		this.scheduleFlush()
		return id
	}

	/** Drop a node's retained state when the adapter observes it was GC'd. */
	forget(id: number): void {
		this.nodes.delete(id)
	}

	private scheduleFlush(): void {
		if (this.flushQueued || this.listeners.size === 0) return
		this.flushQueued = true
		queueMicrotask(() => {
			this.flushQueued = false
			for (const l of this.listeners) l()
		})
	}

	// ── Backend ────────────────────────────────────────────────────────────

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	counts(): Counts {
		const byKind: Partial<Record<NodeKind, number>> = {}
		for (const st of this.nodes.values()) byKind[st.kind] = (byKind[st.kind] ?? 0) + 1
		return { nodes: this.nodes.size, events: this.totalEvents, byKind }
	}

	private ordered(): DevtoolsEvent[] {
		// Ring in chronological order (oldest first).
		if (this.ring.length < this.capacity) return this.ring
		return this.ring.slice(this.ringHead).concat(this.ring.slice(0, this.ringHead))
	}

	events(filter: EventFilter, limit: number): DevtoolsEvent[] {
		const classes = filter.classes ? new Set<KindClass>(filter.classes) : null
		const out: DevtoolsEvent[] = []
		const all = this.ordered()
		for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
			const e = all[i]
			if (filter.node !== undefined && e.node !== filter.node) continue
			if (classes !== null && !classes.has(kindClass(e.kind))) continue
			out.push(e)
		}
		return out.reverse()
	}

	causeChain(eventId: number): DevtoolsEvent[] {
		const byId = new Map<number, DevtoolsEvent>()
		for (const e of this.ring) if (e !== undefined) byId.set(e.id, e)
		const chain: DevtoolsEvent[] = []
		let id = eventId
		let guard = 0
		while (id > 0 && guard++ < 10000) {
			const e = byId.get(id)
			if (e === undefined) break
			chain.push(e)
			id = e.cause
		}
		return chain.reverse()
	}

	private snapshot(id: number): GraphNode | null {
		const st = this.nodes.get(id)
		const kind = st?.kind ?? this.provider.kind(id)
		if (kind === undefined) return null
		const v = this.provider.value(id)
		return {
			id,
			kind,
			label: this.provider.label(id),
			status: v?.status ?? 'ok',
			valuePreview: v?.preview ?? null,
			stale: v?.stale ?? false,
			recomputes: st?.recomputes ?? 0,
			changes: st?.changes ?? 0,
		}
	}

	search(query: string, cap: number): GraphNode[] {
		const q = query.toLowerCase()
		const out: GraphNode[] = []
		for (const id of this.nodes.keys()) {
			if (out.length >= cap) break
			const snap = this.snapshot(id)
			if (snap === null) continue
			const hay = `${snap.label ?? ''} ${snap.kind}`.toLowerCase()
			if (q === '' || hay.includes(q)) out.push(snap)
		}
		return out
	}

	node(id: number): NodeDetails | null {
		const snap = this.snapshot(id)
		if (snap === null) return null
		const v = this.provider.value(id)
		return {
			...snap,
			deps: this.provider.deps(id),
			subs: this.provider.subs(id),
			pending: v?.pending ?? null,
		}
	}
}
