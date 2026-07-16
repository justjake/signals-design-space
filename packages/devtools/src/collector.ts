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

/**
 * The adapter's view of a live node, by id. All reads are inert (see the
 * fx2 adapter). `undefined` from any method means the node is gone.
 */
export interface NodeProvider {
	kind(id: number): NodeKind | undefined
	label(id: number): string | null
	value(id: number): { preview: string | null; status: NodeStatus; stale: boolean; pending: string | null } | undefined
	/** A deeper, multi-line value preview for the inspector (on-demand only). */
	valueFull(id: number): string | null | undefined
	deps(id: number): number[]
	subs(id: number): number[]
}

interface DebugState {
	kind: NodeKind
	recomputes: number
	changes: number
	lastEventId: number
	lastKind: string
}

const DEFAULT_CAPACITY = 4096

export class Collector implements Backend {
	private readonly provider: NodeProvider
	private readonly capacity: number
	private readonly ring: DevtoolsEvent[] = []
	private ringHead = 0
	private nextId = 1
	private totalEvents = 0
	/**
	 * id → event, for O(chain) cause walks without scanning the ring. Bounded
	 * to `capacity`: an entry is dropped when its event is evicted.
	 */
	private readonly byId = new Map<number, DevtoolsEvent>()
	/** Reduced, retained per-node state — survives ring eviction. */
	private readonly nodes = new Map<number, DebugState>()
	/**
	 * Live node count per kind, maintained incrementally so `counts()` is O(1)
	 * rather than O(nodes) — it runs on every panel render.
	 */
	private readonly kindCounts: Partial<Record<NodeKind, number>> = {}
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
			wall: Date.now(),
			node,
			data,
		}
		if (this.ring.length < this.capacity) {
			this.ring.push(evt)
		} else {
			const evicted = this.ring[this.ringHead]
			if (evicted !== undefined) this.byId.delete(evicted.id)
			this.ring[this.ringHead] = evt
			this.ringHead = (this.ringHead + 1) % this.capacity
		}
		this.byId.set(id, evt)
		if (node !== null && nodeKind !== undefined) {
			let st = this.nodes.get(node)
			if (st === undefined) {
				st = { kind: nodeKind, recomputes: 0, changes: 0, lastEventId: id, lastKind: kind }
				this.nodes.set(node, st)
				this.kindCounts[nodeKind] = (this.kindCounts[nodeKind] ?? 0) + 1
			}
			st.lastEventId = id
			st.lastKind = kind
			const cls = kindClass(kind)
			if (cls === 'compute') st.recomputes++
			if (cls === 'write') st.changes++
		}
		this.scheduleFlush()
		return id
	}

	/**
	 * Close a span opened by `record()`: stamp its duration (end − start, in µs)
	 * from the collector's own clock, and record a compute's changed/unchanged
	 * outcome. The engine emits the entry before the work runs and closes it
	 * after; timing lives here, where the clock is. No-op if evicted.
	 */
	endSpan(id: number, changed?: boolean): void {
		const e = this.byId.get(id)
		if (e === undefined) return
		e.data.took = Math.max(0, Math.round(this.now() - this.t0) - e.t)
		if (changed !== undefined) {
			e.data.changed = changed
			// Show the new result: peek the node's just-updated value inertly.
			if (changed && e.node !== null) {
				const v = this.provider.value(e.node)?.preview
				if (v != null) e.data.value = v
			}
		}
		this.scheduleFlush()
	}

	/** Drop a node's retained state when the adapter observes it was GC'd. */
	forget(id: number): void {
		const st = this.nodes.get(id)
		if (st === undefined) return
		const c = this.kindCounts[st.kind]
		if (c !== undefined) this.kindCounts[st.kind] = c - 1
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
		return { nodes: this.nodes.size, events: this.totalEvents, byKind: { ...this.kindCounts } }
	}

	events(filter: EventFilter, limit: number): DevtoolsEvent[] {
		const classes = filter.classes ? new Set<KindClass>(filter.classes) : null
		const out: DevtoolsEvent[] = []
		const n = this.ring.length
		if (n === 0) return out
		// Walk newest → oldest by index (no full-ring copy), stop at `limit`.
		const full = n === this.capacity
		let idx = full ? (this.ringHead - 1 + this.capacity) % this.capacity : n - 1
		for (let scanned = 0; scanned < n && out.length < limit; scanned++) {
			const e = this.ring[idx]
			idx = full ? (idx - 1 + this.capacity) % this.capacity : idx - 1
			if (filter.node !== undefined && e.node !== filter.node) continue
			if (classes !== null && !classes.has(kindClass(e.kind))) continue
			out.push(e)
		}
		return out.reverse()
	}

	causeChain(eventId: number): DevtoolsEvent[] {
		const chain: DevtoolsEvent[] = []
		let id = eventId
		let guard = 0
		while (id > 0 && guard++ < 10000) {
			const e = this.byId.get(id)
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
			lastEventId: st?.lastEventId ?? 0,
			lastKind: st?.lastKind ?? null,
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
			valueFull: this.provider.valueFull(id) ?? null,
		}
	}
}
