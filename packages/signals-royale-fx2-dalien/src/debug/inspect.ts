/**
 * `signals-royale-fx2-dalien/debug/inspect` — read graph state WITHOUT
 * perturbing it.
 *
 * Everything here is inert: plain field reads (node.value / node.throwable /
 * node.flags) and record-list walks. Nothing calls the reactive read API.
 * That distinction is load-bearing: `read(x)` (even wrapped in `untracked`)
 * evaluates a stale computed, advancing clocks and emitting a `compute` into
 * the very trace the devtools is observing. Reading the cached field does not.
 * So the devtools sees the last-known value plus a `stale` flag, never a value
 * it forced into existence.
 *
 * This module is inside the engine, so it may read private node fields and
 * know the `Flag` bit layout; it exposes only the stable shapes below.
 * External consumers (the devtools) import these, never core internals —
 * that's the boundary that lets the engine refactor internals freely.
 */

import {
	Flag,
	dependencyOf,
	isUninitialized,
	nextDependency,
	nextSubscriber,
	subscriberOf,
	type CellNode,
	type DerivedNode,
	type ReactiveNode,
} from '../graph.ts'

// nodeOf maps a public Signal to its node handle.
export { nodeOf } from '../index.ts'

// Opaque node handles for consumers: pass them to inspect/deps/subs; never
// read their fields (that's the encapsulation boundary).
export type { ReactiveNode } from '../graph.ts'

/**
 * A debug-assigned node id, unique within one engine (WeakMap-backed, handed
 * out on first sighting). Pair with an engine id for global uniqueness. The
 * arena's record offsets are reused across node lifetimes, so stable identity
 * lives here, on the handle.
 */
export type NodeId = number & { readonly __nodeId: unique symbol }

/**
 * Unpacked from the node-kind bits of `Flag` (KindCell / KindDerived /
 * Watching + WatchRender vs WatchRunEffect).
 */
export type NodeKind = 'atom' | 'computed' | 'watcher' | 'effect'

/** Unpacked from the async bits of `Flag` (AsyncError / AsyncSuspended). */
export type NodeStatus = 'ok' | 'suspended' | 'error'

/**
 * Everything the devtools needs about one node, read inertly. The value may
 * be stale (a dependency changed but the node hasn't re-evaluated) — `stale`
 * says so, and the devtools shows the last-known value with a marker rather
 * than forcing a recompute to freshen it.
 */
export interface Inspected {
	id: NodeId
	kind: NodeKind
	label: string | undefined
	/** Last committed value. `undefined` (with `uninitialized`) when never run. */
	value: unknown
	/** True when the node has never evaluated (value is UNINITIALIZED). */
	uninitialized: boolean
	/** ok | suspended (parked on a thenable) | error (last eval threw). */
	status: NodeStatus
	/**
	 * When status is 'error', the ErrorBox (has `.error`); when 'suspended',
	 * the pending Suspension. Read from node.throwable — never rethrown or
	 * awaited. `null` when status is 'ok'.
	 */
	pending: unknown
	/**
	 * True when a dependency changed since this node last evaluated (StaleCheck
	 * or StaleDirty set): `value` is the previous result, not the current one.
	 */
	stale: boolean
}

const nodeIds = new WeakMap<object, NodeId>()
let nextNodeId = 1

/** Assign or fetch a node's debug id. Identity only — reads nothing reactive. */
export function nodeId(node: ReactiveNode): NodeId {
	let id = nodeIds.get(node)
	if (id === undefined) {
		id = nextNodeId++ as NodeId
		nodeIds.set(node, id)
	}
	return id
}

/** Node kind from the `Flag` bitfield. */
export function nodeKind(node: ReactiveNode): NodeKind {
	const f = node.flags as number
	if ((f & Flag.KindCell) !== 0) return 'atom'
	if ((f & Flag.KindDerived) !== 0) return 'computed'
	if ((f & Flag.WatchRunEffect) !== 0) return 'effect'
	return 'watcher'
}

/** Async status from the `Flag` bitfield. */
export function nodeStatus(node: ReactiveNode): NodeStatus {
	const f = node.flags as number
	if ((f & Flag.AsyncError) !== 0) return 'error'
	if ((f & Flag.AsyncSuspended) !== 0) return 'suspended'
	return 'ok'
}

/**
 * Inert snapshot of a producer (atom or computed). Field reads only: no
 * evaluation, no dependency edge, no trace event. This is the accessor the
 * devtools uses instead of the reactive read API.
 */
export function inspect(node: ReactiveNode): Inspected {
	const valued = node as CellNode<unknown> | DerivedNode<unknown>
	const uninitialized = isUninitialized(valued.value)
	const status = nodeStatus(node)
	const isComputed = ((node.flags as number) & Flag.KindDerived) !== 0
	return {
		id: nodeId(node),
		kind: nodeKind(node),
		label: node.label,
		value: uninitialized ? undefined : valued.value,
		uninitialized,
		status,
		pending: status === 'ok' ? null : node.throwable,
		stale: isComputed ? computedStale(node as DerivedNode<unknown>) : false,
	}
}

/**
 * Inert staleness for a computed: the eager flag (set on observed nodes at
 * write time) OR the lazy clock comparison the engine uses internally — a
 * dependency changed more recently than this node last validated. Both are
 * field reads.
 */
function computedStale(node: DerivedNode<unknown>): boolean {
	if (((node.flags as number) & Flag.StaleMask) !== 0) return true
	const validAt = node.validAtGraphChange as unknown as number
	let link = node.deps
	while (link !== undefined) {
		if ((dependencyOf(link).changedAtGraphChange as unknown as number) > validAt) return true
		link = nextDependency(link)
	}
	return false
}

/** Direct dependencies — what this node reads. Walks the `deps` link list. */
export function deps(node: ReactiveNode): ReactiveNode[] {
	const out: ReactiveNode[] = []
	let link = node.deps
	while (link !== undefined) {
		out.push(dependencyOf(link))
		link = nextDependency(link)
	}
	return out
}

/** Direct subscribers — what reacts when this node changes. Walks `subs`. */
export function subs(node: ReactiveNode): ReactiveNode[] {
	const out: ReactiveNode[] = []
	let link = node.subs
	while (link !== undefined) {
		out.push(subscriberOf(link))
		link = nextSubscriber(link)
	}
	return out
}
