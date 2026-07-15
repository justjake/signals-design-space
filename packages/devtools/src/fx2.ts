/**
 * fx2 adapter — plug signals-royale-fx2/debug into a Collector.
 *
 * Installs the trace hook (events flow straight through, kind strings
 * verbatim) and implements the NodeProvider with the inert `inspect`/`deps`/
 * `subs` peeks. Node handles are held only via WeakRef and pruned through a
 * FinalizationRegistry, so attaching the devtools never keeps a disposed node
 * alive. No fx2 internals are touched beyond the ./debug contract.
 */

import {
	deps as fx2Deps,
	inspect,
	nodeId as fx2NodeId,
	nodeKind as fx2NodeKind,
	nodeStatus,
	type NodeId,
	NO_EVENT,
	type ReactiveNode,
	type ProducerNode,
	setTraceHook,
	subs as fx2Subs,
	type TraceEventId,
	type TraceFields,
} from 'signals-royale-fx2/debug'
import { Collector, type NodeProvider } from './collector.ts'
import type { NodeKind, NodeStatus } from './protocol.ts'

const PREVIEW_MAX = 60

/** Small, structured-clone-safe value preview. */
function preview(v: unknown): string {
	switch (typeof v) {
		case 'string':
			return JSON.stringify(v.length > PREVIEW_MAX ? v.slice(0, PREVIEW_MAX) + '…' : v)
		case 'number':
		case 'boolean':
		case 'bigint':
			return String(v)
		case 'undefined':
			return 'undefined'
		case 'function':
			return `ƒ ${(v as { name?: string }).name || 'anonymous'}`
		case 'object': {
			if (v === null) return 'null'
			if (Array.isArray(v)) return `Array(${v.length})`
			const ctor = (v as object).constructor?.name
			return ctor && ctor !== 'Object' ? ctor : '{…}'
		}
		default:
			return String(v)
	}
}

function errorPreview(e: unknown): string {
	if (e instanceof Error) return `${e.name}: ${e.message}`
	// fx2 wraps thrown values in an ErrorBox { error }.
	if (e && typeof e === 'object' && 'error' in e) return errorPreview((e as { error: unknown }).error)
	return preview(e)
}

export interface Fx2Devtools {
	collector: Collector
	detach(): void
}

/**
 * Attach the collector to the active fx2 engine and expose it on
 * `globalThis.__SIGNALS_DEVTOOLS__`. Call the returned `detach()` to remove
 * the trace hook and stop observing.
 */
export function attachFx2Devtools(opts?: { capacity?: number; now?: () => number }): Fx2Devtools {
	// id -> live node, WeakRef so a disposed node can be collected.
	const registry = new Map<number, WeakRef<ReactiveNode>>()
	const finalizer =
		typeof FinalizationRegistry !== 'undefined'
			? new FinalizationRegistry<number>((id) => {
					registry.delete(id)
					collector.forget(id)
				})
			: null

	function register(node: ReactiveNode): number {
		const id = fx2NodeId(node) as unknown as number
		if (!registry.has(id)) {
			registry.set(id, new WeakRef(node))
			finalizer?.register(node, id)
		}
		return id
	}

	function deref(id: number): ReactiveNode | undefined {
		return registry.get(id)?.deref()
	}

	function kindOf(node: ReactiveNode): NodeKind {
		return fx2NodeKind(node) as NodeKind
	}

	const provider: NodeProvider = {
		kind(id) {
			const node = deref(id)
			return node ? kindOf(node) : undefined
		},
		label(id) {
			const node = deref(id)
			return (node?.label as string | undefined) ?? null
		},
		value(id) {
			const node = deref(id)
			if (node === undefined) return undefined
			const kind = kindOf(node)
			// Only producers (atoms, computeds) carry a value; peek inertly.
			if (kind === 'atom' || kind === 'computed') {
				const snap = inspect(node as ProducerNode)
				return {
					preview: snap.uninitialized ? 'uninitialized' : preview(snap.value),
					status: snap.status as NodeStatus,
					stale: snap.stale,
					pending: snap.pending == null ? null : errorPreview(snap.pending),
				}
			}
			return { preview: null, status: nodeStatus(node) as NodeStatus, stale: false, pending: null }
		},
		deps(id) {
			const node = deref(id)
			if (node === undefined) return []
			return fx2Deps(node).map(register)
		},
		subs(id) {
			const node = deref(id)
			if (node === undefined) return []
			// Only producers have a subscriber list; others yield an empty walk.
			return fx2Subs(node as ProducerNode).map(register)
		},
	}

	const collector = new Collector(provider, opts)

	setTraceHook((kind, node, cause, fields?: TraceFields): TraceEventId => {
		const nodeIdNum = node !== null ? register(node) : null
		const nodeKind = node !== null ? kindOf(node) : undefined
		const data = fields !== undefined ? fieldsToData(fields) : {}
		const id = collector.record(kind, nodeIdNum, cause as unknown as number, nodeKind, data)
		return id as unknown as TraceEventId
	})

	const g = globalThis as { __SIGNALS_DEVTOOLS__?: unknown }
	g.__SIGNALS_DEVTOOLS__ = collector

	return {
		collector,
		detach() {
			setTraceHook(null)
			if (g.__SIGNALS_DEVTOOLS__ === collector) g.__SIGNALS_DEVTOOLS__ = undefined
		},
	}
}

/** Flatten TraceFields into a structured-clone-safe data bag for the event. */
function fieldsToData(fields: TraceFields): Record<string, unknown> {
	const data: Record<string, unknown> = {}
	if (fields.draftId !== undefined) data.draftId = fields.draftId
	if (fields.phase !== undefined) data.phase = fields.phase
	if (fields.status !== undefined) data.status = fields.status
	if (fields.world !== undefined) data.world = fields.world
	if (fields.error !== undefined) data.error = errorPreview(fields.error)
	return data
}

// Re-export so the hook's unused-import guard is satisfied and callers can
// reference the root sentinel if they build cause chains by hand.
export { NO_EVENT }
