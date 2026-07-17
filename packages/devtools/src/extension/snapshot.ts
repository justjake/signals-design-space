/**
 * Cross-realm bridge core. The panel's Backend is synchronous, but in the
 * extension it lives in a different realm from the engine — so the page pushes
 * bounded, structured-clone-safe **snapshots**, and the panel serves its sync
 * Backend from the latest one. This keeps the same panel code working over a
 * postMessage/port pipe with no async leaking into the UI.
 *
 * Everything here is plain data + pure logic, so the whole bridge is testable
 * without a browser: build a snapshot from a live Backend, round-trip it
 * through JSON, and a SnapshotBackend answers the same queries.
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
} from '../protocol.ts'
import { causeChainFrom, eventFilterPredicate, nodeMatchesQuery } from '../protocol.ts'

/** A structured-clone-safe view of the engine, posted page → panel on flush. */
export interface Snapshot {
	counts: Counts
	events: DevtoolsEvent[]
	nodes: NodeDetails[]
}

const EMPTY: Snapshot = { counts: { nodes: 0, events: 0, byKind: {} }, events: [], nodes: [] }

/** Serialize a live Backend into a bounded snapshot (page side). */
export function buildSnapshot(backend: Backend, opts?: { events?: number; nodes?: number }): Snapshot {
	const events = backend.events({}, opts?.events ?? 1000)
	const graph = backend.search('', opts?.nodes ?? 1000)
	const nodes: NodeDetails[] = []
	for (const g of graph) {
		const d = backend.node(g.id)
		if (d !== undefined) nodes.push(d)
	}
	return { counts: backend.counts(), events, nodes }
}

/** Panel-side Backend that reads from the latest pushed snapshot. */
export class SnapshotBackend implements Backend {
	private snap: Snapshot = EMPTY
	private readonly byNode = new Map<NodeId, NodeDetails>()
	private readonly listeners = new Set<() => void>()

	/** Install a new snapshot and notify subscribers. */
	update(snap: Snapshot): void {
		this.snap = snap
		this.byNode.clear()
		for (const n of snap.nodes) this.byNode.set(n.id, n)
		for (const l of this.listeners) l()
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	counts(): Counts {
		return this.snap.counts
	}

	events(filter: EventFilter, limit: number): DevtoolsEvent[] {
		const matches = eventFilterPredicate(filter)
		const out: DevtoolsEvent[] = []
		const all = this.snap.events
		for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
			const e = all[i]
			if (matches(e)) out.push(e)
		}
		return out.reverse()
	}

	causeChain(eventId: EventId): DevtoolsEvent[] {
		const byId = new Map<EventId, DevtoolsEvent>()
		for (const e of this.snap.events) byId.set(e.id, e)
		return causeChainFrom((id) => byId.get(id), eventId)
	}

	search(query: string, cap: number): GraphNode[] {
		const q = query.toLowerCase()
		const out: GraphNode[] = []
		for (const n of this.snap.nodes) {
			if (out.length >= cap) break
			if (nodeMatchesQuery(n, q)) out.push(n)
		}
		return out
	}

	node(id: NodeId): NodeDetails | undefined {
		return this.byNode.get(id) ?? undefined
	}
}
