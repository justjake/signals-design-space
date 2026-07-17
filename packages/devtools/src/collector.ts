/**
 * Collector — the in-page, library-agnostic heart of the devtools.
 *
 * Plain JS: a ring of normalized events, a reduced per-node DebugState, and
 * the Backend query surface. It holds only numbers and strings — never a
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
	EventId,
	GraphNode,
	NodeDetails,
	NodeId,
	NodeKind,
	NodeStatus,
} from './protocol.ts'
import { causeChainFrom, eventFilterPredicate, kindClass, nodeMatchesQuery } from './protocol.ts'

/**
 * The adapter's view of a live node, by id. All reads are inert (see the
 * cosignals adapter). `undefined` from any method means the node is gone.
 */
export interface NodeProvider {
	kind(id: NodeId): NodeKind | undefined
	label(id: NodeId): string | undefined
	value(id: NodeId): { preview: string | undefined; status: NodeStatus; stale: boolean; pending: string | undefined } | undefined
	/** A deeper, multi-line value preview for the inspector (on-demand only). */
	valueFull(id: NodeId): string | undefined
	/** Name of the node's equality fn, for the inspector; null if none/anonymous. */
	equals(id: NodeId): string | undefined
	/** A synthesized creation signature (stringified fn), or undefined. */
	source(id: NodeId): string | undefined
	deps(id: NodeId): NodeId[]
	subs(id: NodeId): NodeId[]
}

interface DebugState {
	kind: NodeKind
	recomputes: number
	changes: number
	/** Cumulative µs across this node's own spans (recompute/effect). */
	selfUs: number
	/** Recompute outcomes: result changed vs. stayed equal. */
	newResults: number
	sameResults: number
	/** Hot-channel counts (only accrue while hot mode is on): dependency
	 * validations (`check`) and re-evaluations (`pull`). A check that didn't
	 * lead to a pull served the value from cache — the memoization win. */
	checks: number
	pulls: number
	lastEventId: EventId
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
	private readonly byId = new Map<EventId, DevtoolsEvent>()
	/** Reduced, retained per-node state — survives ring eviction. */
	private readonly nodes = new Map<NodeId, DebugState>()
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
		node: NodeId | undefined,
		cause: EventId,
		nodeKind: NodeKind | undefined,
		data: Record<string, unknown>,
	): EventId {
		const id = this.nextId++ as EventId
		this.totalEvents++
		const evt: DevtoolsEvent = {
			id,
			kind,
			cause: cause > 0 && cause < id ? cause : (0 as EventId),
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
		if (node !== undefined && nodeKind !== undefined) {
			let st = this.nodes.get(node)
			if (st === undefined) {
				st = { kind: nodeKind, recomputes: 0, changes: 0, selfUs: 0, newResults: 0, sameResults: 0, checks: 0, pulls: 0, lastEventId: id, lastKind: kind }
				this.nodes.set(node, st)
				this.kindCounts[nodeKind] = (this.kindCounts[nodeKind] ?? 0) + 1
			}
			st.lastEventId = id
			st.lastKind = kind
			const cls = kindClass(kind)
			if (cls === 'compute') st.recomputes++
			if (cls === 'write') st.changes++
			if (kind === 'check') st.checks++
			else if (kind === 'pull') st.pulls++
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
	endSpan(id: EventId, changed?: boolean): void {
		const e = this.byId.get(id)
		if (e === undefined) return
		const took = Math.max(0, Math.round(this.now() - this.t0) - e.t)
		e.data.took = took
		if (changed !== undefined) {
			e.data.changed = changed
			// Show the new result: peek the node's just-updated value inertly.
			if (changed && e.node !== undefined) {
				const v = this.provider.value(e.node)?.preview
				if (v !== undefined) e.data.value = v
			}
		}
		// Fold the span's duration/outcome into the node's retained stats so the
		// inspector's evaluation metrics survive ring eviction.
		if (e.node !== undefined) {
			const st = this.nodes.get(e.node)
			if (st !== undefined) {
				const cls = kindClass(e.kind)
				if (cls === 'compute' || cls === 'effect') st.selfUs += took
				if (cls === 'compute' && changed !== undefined) {
					if (changed) st.newResults++
					else st.sameResults++
				}
			}
		}
		this.scheduleFlush()
	}

	/** Drop a node's retained state when the adapter observes it was GC'd. */
	forget(id: NodeId): void {
		const st = this.nodes.get(id)
		if (st === undefined) return
		const c = this.kindCounts[st.kind]
		if (c !== undefined) this.kindCounts[st.kind] = c - 1
		this.nodes.delete(id)
	}

	// ── Hot algorithm channel ──────────────────────────────────────────────
	// The engine-side hook is the adapter's to install; the collector owns
	// only the on/off state the panel toggles. Hot events arrive through
	// `record()` like everything else: ids and strings into the bounded ring.

	/** Adapter-installed switch that starts/stops the engine's hot channel. */
	private hotInstall: ((on: boolean) => void) | undefined
	private hotOn = false

	/** Adapter API: register the engine switch behind `setHotMode`. */
	setHotSource(install: (on: boolean) => void): void {
		this.hotInstall = install
	}

	setHotMode(on: boolean): void {
		if (this.hotOn === on) return
		this.hotOn = on
		this.hotInstall?.(on)
	}

	hotMode(): boolean {
		return this.hotOn
	}

	/**
	 * The most recent state-change event (a write or a notify), so the render
	 * observer can root a cascade at what triggered the pass.
	 */
	latestSignalCause(): EventId {
		return this.events({ classes: ['write', 'notify'] }, 1)[0]?.id ?? (0 as EventId)
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
		const matches = eventFilterPredicate(filter)
		const out: DevtoolsEvent[] = []
		const n = this.ring.length
		if (n === 0) return out
		// Walk newest → oldest by index (no full-ring copy), stop at `limit`.
		const full = n === this.capacity
		let idx = full ? (this.ringHead - 1 + this.capacity) % this.capacity : n - 1
		for (let scanned = 0; scanned < n && out.length < limit; scanned++) {
			const e = this.ring[idx]
			idx = full ? (idx - 1 + this.capacity) % this.capacity : idx - 1
			if (matches(e)) out.push(e)
		}
		return out.reverse()
	}

	causeChain(eventId: EventId): DevtoolsEvent[] {
		return causeChainFrom((id) => this.byId.get(id), eventId)
	}

	private snapshot(id: NodeId): GraphNode | undefined {
		const st = this.nodes.get(id)
		const kind = st?.kind ?? this.provider.kind(id)
		if (kind === undefined) return undefined
		const v = this.provider.value(id)
		return {
			id,
			kind,
			label: this.provider.label(id),
			status: v?.status ?? 'ok',
			valuePreview: v?.preview ?? undefined,
			pending: v?.pending ?? undefined,
			stale: v?.stale ?? false,
			recomputes: st?.recomputes ?? 0,
			changes: st?.changes ?? 0,
			selfUs: st?.selfUs ?? 0,
			newResults: st?.newResults ?? 0,
			sameResults: st?.sameResults ?? 0,
			checks: st?.checks ?? 0,
			pulls: st?.pulls ?? 0,
			lastEventId: st?.lastEventId ?? (0 as EventId),
			lastKind: st?.lastKind ?? undefined,
		}
	}

	search(query: string, cap: number): GraphNode[] {
		const q = query.toLowerCase()
		const out: GraphNode[] = []
		for (const id of this.nodes.keys()) {
			if (out.length >= cap) break
			const snap = this.snapshot(id)
			if (snap === undefined) continue
			if (nodeMatchesQuery(snap, q)) out.push(snap)
		}
		return out
	}

	node(id: NodeId): NodeDetails | undefined {
		const snap = this.snapshot(id)
		if (snap === undefined) return undefined
		return {
			...snap,
			deps: this.provider.deps(id),
			subs: this.provider.subs(id),
			valueFull: this.provider.valueFull(id) ?? undefined,
			equals: this.provider.equals(id),
			source: this.provider.source(id),
		}
	}
}
