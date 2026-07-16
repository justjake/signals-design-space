/**
 * Panel view-model — pure functions turning a Backend into the rows the UI
 * renders. Framework-free and headlessly testable; the React components are
 * thin renderers of these. Keeping the logic here means the panel's behavior
 * is verifiable without a DOM or a running React.
 */

import {
	type Backend,
	type DevtoolsEvent,
	type EventFilter,
	type EventId,
	type GraphNode,
	kindClass,
	type KindClass,
	type NodeDetails,
	type NodeId,
	type NodeKind,
	type NodeStatus,
	type StackFrame,
} from '../protocol.ts'

/** A log-table row: verbatim kind + its color class + the node's display name. */
export interface LogRow {
	id: EventId
	kind: string
	cls: KindClass
	/** Node id this entry is about; undefined for engine entries. */
	node: NodeId | undefined
	/** Node label, or `kind#id` when unlabeled, or undefined for engine entries. */
	name: string | undefined
	/** One-line, plain-words summary of the entry's data. */
	summary: string
	/** µs since attach. */
	t: number
	cause: EventId
	/** Duration in µs, where the entry is a closed span (compute/effect). */
	took: number | undefined
	/** Short real wall-clock timestamp (HH:MM:SS.mmm). */
	time: string
	/** µs since the previous entry in the stream; undefined for the first. */
	delta: number | undefined
	/** App stack captured at an operation root; undefined otherwise. */
	stack: StackFrame[] | undefined
}

function nodeName(backend: Backend, id: NodeId | undefined): string | undefined {
	if (id === undefined) return undefined
	const n = backend.node(id)
	if (n === undefined) return `#${id}`
	return n.label ?? `${n.kind}#${id}`
}

function summarize(e: DevtoolsEvent): string {
	const d = e.data
	if (typeof d.error === 'string') return d.error
	// A write carries a value diff (previewed strings from the adapter).
	if (typeof d.next === 'string') return typeof d.prev === 'string' ? `${d.prev} → ${d.next}` : `→ ${d.next}`
	// A closed compute reports whether its result changed, and to what.
	if (typeof d.changed === 'boolean')
		return d.changed ? (typeof d.value === 'string' ? `new result · ${d.value}` : 'new result') : 'same result'
	const parts: string[] = []
	if (typeof d.phase === 'string') parts.push(d.phase)
	if (typeof d.status === 'string') parts.push(d.status)
	if (d.draftId !== undefined) parts.push(`draft ${String(d.draftId)}`)
	return parts.join(' · ')
}

function toRow(backend: Backend, e: DevtoolsEvent): LogRow {
	return {
		id: e.id,
		kind: e.kind,
		cls: kindClass(e.kind),
		node: e.node,
		// Engine-level entries have no node; a captured DOM origin labels itself.
		name: nodeName(backend, e.node) ?? (typeof e.data.label === 'string' ? e.data.label : undefined),
		summary: summarize(e),
		t: e.t,
		cause: e.cause,
		took: typeof e.data.took === 'number' ? e.data.took : undefined,
		time: formatClock(e.wall),
		delta: undefined,
		stack: Array.isArray(e.data.stack) ? (e.data.stack as StackFrame[]) : undefined,
	}
}

export function logRows(backend: Backend, filter: EventFilter, limit: number): LogRow[] {
	const rows = backend.events(filter, limit).map((e) => toRow(backend, e))
	// Rows are chronological (oldest first): each entry's delta is the µs gap
	// from the one before it in the stream.
	for (let i = 1; i < rows.length; i++) rows[i].delta = rows[i].t - rows[i - 1].t
	return rows
}

/** The cause chain leading to `eventId`, resolved to rows, root first. */
export function causeRows(backend: Backend, eventId: EventId): LogRow[] {
	return backend.causeChain(eventId).map((e) => toRow(backend, e))
}

/**
 * Render a numeric id with a one/two-letter namespace prefix so ids from
 * different spaces can't be mistaken for one another: G = graph node, L = log
 * event, Su = suspense. Everything monospace, so the prefix aligns.
 */
export function fmtId(space: 'node' | 'event' | 'suspense', id: number): string {
	return `${space === 'node' ? 'G' : space === 'event' ? 'L' : 'Su'}${id}`
}

/** Compact µs/ms duration, or empty when no duration was recorded. */
export function fmtTook(us: number | undefined): string {
	if (us === undefined) return ''
	if (us < 1000) return `${us}µs`
	return `${(us / 1000).toFixed(us < 10000 ? 1 : 0)}ms`
}

/** Signed inter-entry gap ("+23µs", "+1.2ms"), or empty for the first entry. */
export function fmtDelta(us: number | undefined): string {
	if (us === undefined) return ''
	return `+${fmtTook(us)}`
}

/** Short real wall-clock timestamp, HH:MM:SS.mmm. */
export function formatClock(ms: number): string {
	const d = new Date(ms)
	const p2 = (n: number) => String(n).padStart(2, '0')
	return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

/**
 * A row in the causal tree: a log row plus its nesting depth and the guide
 * glyphs that draw the branch lines to its left.
 */
export type Guide = 'vert' | 'tee' | 'elbow' | 'none'
export interface TreeRow {
	row: LogRow
	depth: number
	guides: Guide[]
	/** Direct children — drives the expand caret on operation roots. */
	children: number
	/** 0-based index of the operation (root) this row belongs to, so the table
	 * can shade whole operation subtrees alternately for scanning. */
	op: number
}

/**
 * Nest entries under the entry that caused them. Entries whose cause is 0, or
 * whose cause isn't in `rows` (the caller resolves out-of-window causes first,
 * so this is only a truly-evicted cause), are operation roots. Children always
 * follow their cause in time (the collector guarantees cause < id), so a
 * depth-first walk emits a stable, readable tree. A row whose id is in
 * `collapsed` is emitted, but its subtree is not.
 */
export function logTree(rows: LogRow[], collapsed?: ReadonlySet<EventId>): TreeRow[] {
	const present = new Set(rows.map((r) => r.id))
	const childrenOf = new Map<EventId, LogRow[]>()
	const roots: LogRow[] = []
	for (const r of rows) {
		if (r.cause > 0 && present.has(r.cause)) {
			const list = childrenOf.get(r.cause)
			if (list === undefined) childrenOf.set(r.cause, [r])
			else list.push(r)
		} else {
			roots.push(r)
		}
	}
	// Newest-first within each level while a parent still precedes its children:
	// sort roots and every sibling list by descending id. A cause always has a
	// lower id than its effects, so this never reorders a parent after a child.
	roots.sort((a, b) => b.id - a.id)
	for (const list of childrenOf.values()) list.sort((a, b) => b.id - a.id)
	const out: TreeRow[] = []
	const walk = (row: LogRow, depth: number, trail: boolean[], isLast: boolean, op: number) => {
		if (depth > 40) return // guard against a pathological chain
		const guides: Guide[] = []
		for (let i = 0; i < depth; i++) {
			if (i < depth - 1) guides.push(trail[i] ? 'vert' : 'none')
			else guides.push(isLast ? 'elbow' : 'tee')
		}
		const kids = childrenOf.get(row.id) ?? []
		out.push({ row, depth, guides, children: kids.length, op })
		if (collapsed?.has(row.id)) return
		const nextTrail = trail.concat(!isLast)
		kids.forEach((k, i) => walk(k, depth + 1, nextTrail, i === kids.length - 1, op))
	}
	roots.forEach((r, i) => walk(r, 0, [], i === roots.length - 1, i))
	return out
}

/**
 * The consequence tree of one event: everything it caused, directly and
 * transitively, within the given rows — nested (root = the event, shown as
 * depth ≥ 1), bounded for huge fan-outs. Shared by the log's "what this caused"
 * and the graph inspector's last-event view.
 */
export function causedTree(rows: LogRow[], eventId: EventId, cap = 200): TreeRow[] {
	const self = rows.find((r) => r.id === eventId)
	if (self === undefined) return []
	const kids = new Map<EventId, LogRow[]>()
	for (const r of rows) {
		if (r.cause > 0) {
			const l = kids.get(r.cause)
			if (l !== undefined) l.push(r)
			else kids.set(r.cause, [r])
		}
	}
	const sub: LogRow[] = []
	const seen = new Set<EventId>()
	const walk = (id: EventId): void => {
		for (const c of kids.get(id) ?? []) {
			if (sub.length >= cap || seen.has(c.id)) continue
			seen.add(c.id)
			sub.push(c)
			walk(c.id)
		}
	}
	walk(eventId)
	return logTree([self, ...sub]).filter((t) => t.depth >= 1)
}

/** A node-list row for the graph view. */
export interface NodeRow {
	id: NodeId
	kind: GraphNode['kind']
	name: string
	value: string
	/** Error / awaited-source message when status !== 'ok'; shown in place of the
	 * value so an errored or suspended node reads its reason in the list. */
	pending: string | undefined
	status: GraphNode['status']
	stale: boolean
	recomputes: number
	/** Total µs spent running the node's own work, for the "run time" column. */
	selfUs: number
	/** Recompute outcomes (changed vs. same result), for the "unchanged" column. */
	newResults: number
	sameResults: number
	/** The node's most recent entry, for the "last event" column. */
	last: { id: EventId; kind: string } | undefined
}

export function nodeRows(backend: Backend, query: string, cap: number): NodeRow[] {
	// Uses the node's retained last-event pointer — never scans the event ring,
	// so listing stays cheap at 100k nodes.
	return backend.search(query, cap).map((n) => ({
		id: n.id,
		kind: n.kind,
		name: n.label ?? `${n.kind}#${n.id}`,
		value: n.valuePreview ?? '—',
		pending: n.pending,
		status: n.status,
		stale: n.stale,
		recomputes: n.recomputes,
		selfUs: n.selfUs,
		newResults: n.newResults,
		sameResults: n.sameResults,
		last: n.lastEventId > 0 ? { id: n.lastEventId, kind: n.lastKind ?? '' } : undefined,
	}))
}

/**
 * A resolved neighbor (dependency or subscriber), enriched for the inspector's
 * colored, clickable lists.
 */
export interface NeighborRef {
	id: NodeId
	name: string
	kind: NodeKind
	status: NodeStatus
}

/**
 * How many neighbors the inspector enriches per direction before summarizing
 * the rest as a count — bounds work when a node has a huge fan-out.
 */
const NEIGHBOR_CAP = 40

function neighbors(backend: Backend, ids: NodeId[]): NeighborRef[] {
	const out: NeighborRef[] = []
	for (const id of ids) {
		if (out.length >= NEIGHBOR_CAP) break
		const n = backend.node(id)
		if (n === undefined) continue
		out.push({ id, name: n.label ?? `${n.kind}#${id}`, kind: n.kind, status: n.status })
	}
	return out
}

/**
 * The inspector payload plus the "why this ran" cause chain, resolved to
 * display rows.
 */
export interface InspectorModel {
	node: NodeDetails
	name: string
	deps: NeighborRef[]
	subs: NeighborRef[]
	depsTotal: number
	subsTotal: number
	/** Cause chain of the node's most recent entry, root first. */
	why: LogRow[]
	/** The node's most recent entry, or undefined if it has none in the window. */
	last: LogRow | undefined
}

export function inspectorModel(backend: Backend, id: NodeId): InspectorModel | undefined {
	const node = backend.node(id)
	if (node === undefined) return undefined
	// The node's most recent entry anchors the "why" chain.
	const lastEvent = backend.events({ node: id }, 1)[0]
	const why = lastEvent ? backend.causeChain(lastEvent.id).map((e) => toRow(backend, e)) : []
	return {
		node,
		name: node.label ?? `${node.kind}#${node.id}`,
		deps: neighbors(backend, node.deps),
		subs: neighbors(backend, node.subs),
		depsTotal: node.deps.length,
		subsTotal: node.subs.length,
		why,
		last: lastEvent ? toRow(backend, lastEvent) : undefined,
	}
}
