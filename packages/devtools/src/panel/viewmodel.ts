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
	type GraphNode,
	kindClass,
	type KindClass,
	type NodeDetails,
} from '../protocol.ts'

/** A log-table row: verbatim kind + its color class + the node's display name. */
export interface LogRow {
	id: number
	kind: string
	cls: KindClass
	/** Node id this entry is about; null for engine entries. */
	node: number | null
	/** Node label, or `kind#id` when unlabeled, or null for engine entries. */
	name: string | null
	/** One-line, plain-words summary of the entry's data. */
	summary: string
	/** µs since attach. */
	t: number
	cause: number
}

function nodeName(backend: Backend, id: number | null): string | null {
	if (id === null) return null
	const n = backend.node(id)
	if (n === null) return `#${id}`
	return n.label ?? `${n.kind}#${id}`
}

function summarize(e: DevtoolsEvent): string {
	const d = e.data
	if (typeof d.error === 'string') return d.error
	const parts: string[] = []
	if (typeof d.phase === 'string') parts.push(d.phase)
	if (typeof d.status === 'string') parts.push(d.status)
	if (d.draftId !== undefined) parts.push(`draft ${String(d.draftId)}`)
	return parts.join(' · ')
}

export function logRows(backend: Backend, filter: EventFilter, limit: number): LogRow[] {
	return backend.events(filter, limit).map((e) => ({
		id: e.id,
		kind: e.kind,
		cls: kindClass(e.kind),
		node: e.node,
		name: nodeName(backend, e.node),
		summary: summarize(e),
		t: e.t,
		cause: e.cause,
	}))
}

/** A node-list row for the graph view. */
export interface NodeRow {
	id: number
	kind: GraphNode['kind']
	name: string
	value: string
	status: GraphNode['status']
	stale: boolean
	recomputes: number
}

export function nodeRows(backend: Backend, query: string, cap: number): NodeRow[] {
	return backend.search(query, cap).map((n) => ({
		id: n.id,
		kind: n.kind,
		name: n.label ?? `${n.kind}#${n.id}`,
		value: n.valuePreview ?? '—',
		status: n.status,
		stale: n.stale,
		recomputes: n.recomputes,
	}))
}

/** The inspector payload plus the "why this ran" cause chain, resolved to
 * display rows. */
export interface InspectorModel {
	node: NodeDetails
	name: string
	deps: { id: number; name: string }[]
	subs: { id: number; name: string }[]
	/** Cause chain of the node's most recent entry, root first. */
	why: LogRow[]
}

export function inspectorModel(backend: Backend, id: number): InspectorModel | null {
	const node = backend.node(id)
	if (node === null) return null
	const nameOf = (nid: number) => ({ id: nid, name: nodeName(backend, nid) ?? `#${nid}` })
	// The node's most recent entry anchors the "why" chain.
	const last = backend.events({ node: id }, 1)[0]
	const why = last
		? backend.causeChain(last.id).map((e) => ({
				id: e.id,
				kind: e.kind,
				cls: kindClass(e.kind),
				node: e.node,
				name: nodeName(backend, e.node),
				summary: summarize(e),
				t: e.t,
				cause: e.cause,
			}))
		: []
	return {
		node,
		name: node.label ?? `${node.kind}#${node.id}`,
		deps: node.deps.map(nameOf),
		subs: node.subs.map(nameOf),
		why,
	}
}
