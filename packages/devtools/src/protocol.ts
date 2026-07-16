/**
 * Devtools protocol — the normalized, library-agnostic wire types.
 *
 * Modeled on the causal shape every tracer in this repo shares (an entry with
 * a `cause` parent id), NOT on any one library's kind vocabulary. Kind strings
 * pass through verbatim from the adapter; the panel colors/filters via
 * `kindClass`, and unknown kinds fall through to 'system' so a future kind
 * still renders. No DOM, no signals — this module is pure data.
 */

/**
 * Coarse bucket for coloring/filtering; the only place the UI reduces the
 * open kind vocabulary. Mirrors signals-royale-fx2/debug's TraceKindClass.
 */
export type KindClass =
	| 'origin'
	| 'write'
	| 'compute'
	| 'notify'
	| 'render'
	| 'effect'
	| 'batch'
	| 'async'
	| 'error'
	| 'system'

export type NodeKind = 'atom' | 'computed' | 'watcher' | 'effect'
export type NodeStatus = 'ok' | 'suspended' | 'error'

/**
 * A graph node as the panel sees it. `id` is adapter-scoped; pair with the
 * engine id for global uniqueness.
 */
export interface GraphNode {
	id: number
	kind: NodeKind
	label: string | null
	status: NodeStatus
	/** Short, structured-clone-safe preview of the current value. */
	valuePreview: string | null
	/** True when the cached value is stale (a dep changed, no recompute yet). */
	stale: boolean
	/** Retained per-node stats reduced from the event stream. */
	recomputes: number
	changes: number
	/**
	 * The node's most recent entry — retained, so listing a node never scans
	 * the ring. 0 / null when the node has no entry in the window.
	 */
	lastEventId: number
	lastKind: string | null
}

/** A dependency edge: data flows dep → sub. */
export interface GraphEdge {
	from: number
	to: number
}

/** One normalized trace entry. `kind` is the library's verbatim string. */
export interface DevtoolsEvent {
	id: number
	kind: string
	/** Provoking entry id; 0 = operation root. */
	cause: number
	/** µs since the collector attached — monotonic, for durations and deltas. */
	t: number
	/** Wall-clock (epoch ms) when recorded, for a real timestamp in the UI. */
	wall: number
	/** Node this entry is about; null for engine-level entries. */
	node: number | null
	/** Kind-specific fields the adapter passed through (phase, error preview…). */
	data: Record<string, unknown>
}

/** Full inspector payload for one node (on-demand, inert). */
export interface NodeDetails extends GraphNode {
	deps: number[]
	subs: number[]
	/** Error message / awaited-source preview when status !== 'ok'. */
	pending: string | null
}

export interface Counts {
	nodes: number
	events: number
	byKind: Partial<Record<NodeKind, number>>
}

export interface EventFilter {
	/** Restrict to entries about this node id. */
	node?: number
	/** Restrict to these kind classes. */
	classes?: KindClass[]
}

/**
 * The query surface the panel talks to. In-realm inline; an RPC proxy in the
 * extension. Query, don't snapshot — the adapter walks the live graph.
 */
export interface Backend {
	counts(): Counts
	/** Recent entries, newest last, capped. */
	events(filter: EventFilter, limit: number): DevtoolsEvent[]
	/** Ancestor chain from the operation root to `eventId`, root first. */
	causeChain(eventId: number): DevtoolsEvent[]
	/** Label/kind substring match, capped. */
	search(query: string, cap: number): GraphNode[]
	/** Inspector payload for one node (inert field peek + edge walk). */
	node(id: number): NodeDetails | null
	/** Subscribe to flushes; returns an unsubscribe. */
	subscribe(listener: () => void): () => void
}

/**
 * Classify a verbatim kind string. Unknown → 'system'. Kept in sync with
 * signals-royale-fx2/debug's kindClass; the adapter may pass its own instead.
 */
export function kindClass(kind: string): KindClass {
	switch (kind) {
		case 'dom-event':
			return 'origin'
		case 'write':
		case 'set':
		case 'update':
			return 'write'
		case 'compute':
			return 'compute'
		case 'notify':
		case 'transition-notify':
			return 'notify'
		case 'render':
		case 'render-suspend':
		case 'transition-commit':
			return 'render'
		case 'effect':
			return 'effect'
		case 'transition-open':
		case 'transition-retire':
		case 'transition-discard':
		case 'batch':
			return 'batch'
		case 'settle':
		case 'retry':
		case 'compute-suspend':
			return 'async'
		case 'compute-error':
		case 'effect-error':
		case 'render-error':
		case 'callback-error':
		case 'cleanup-error':
		case 'flush-error':
		case 'policy-error':
			return 'error'
		default:
			return 'system'
	}
}
