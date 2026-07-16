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
	setTracer,
	subs as fx2Subs,
	type TraceEventId,
	type TraceFields,
} from 'signals-royale-fx2/debug'
import { Collector, type NodeProvider } from './collector.ts'
import type { NodeKind, NodeStatus, StackFrame } from './protocol.ts'

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

/** A deeper, multi-line preview for the inspector: a couple levels of an
 * object/array, capped at a few entries per level, indented. Bounded depth and
 * width keep it cheap and safe on huge or cyclic values; it returns a string
 * and never retains the value. */
function deepPreview(v: unknown, depth: number): string {
	if (depth <= 0 || v === null || typeof v !== 'object') return preview(v)
	const indent = (s: string) => s.replace(/\n/g, '\n  ')
	if (Array.isArray(v)) {
		const rows = v.slice(0, 6).map((x) => `  ${indent(deepPreview(x, depth - 1))},`)
		if (v.length > 6) rows.push(`  … ${v.length - 6} more`)
		return `[\n${rows.join('\n')}\n]`
	}
	const keys = Object.keys(v as object)
	const rows = keys.slice(0, 6).map((k) => `  ${k}: ${indent(deepPreview((v as Record<string, unknown>)[k], depth - 1))},`)
	if (keys.length > 6) rows.push(`  … ${keys.length - 6} more`)
	return `{\n${rows.join('\n')}\n}`
}

/** Capture the current JS stack, keeping the app's own frames (engine,
 * adapter, framework, and node_modules frames are dropped) so an operation
 * root can be traced back to the code that triggered it. */
function captureStack(): StackFrame[] {
	const raw = new Error().stack
	if (raw == null) return []
	const parsed: StackFrame[] = []
	for (const line of raw.split('\n')) {
		const m = line.match(/at (?:(.*?) \()?(.*?):(\d+):(\d+)\)?\s*$/)
		if (m !== null) parsed.push({ fn: m[1] || '<anonymous>', file: m[2], line: Number(m[3]), col: Number(m[4]) })
	}
	// The top frames are this adapter module (captureStack, emit); drop them by
	// file, then drop engine/framework/dep frames, leaving the app's own.
	const selfFile = parsed[0]?.file
	const out: StackFrame[] = []
	for (const f of parsed) {
		if (f.file === selfFile) continue
		if (/node_modules|signals-royale-fx2|\/react-dom|\/react\/|\/react-jsx|\breact\.development\b|\/scheduler/.test(f.file)) continue
		out.push(f)
		if (out.length >= 12) break
	}
	return out
}

/** Short label for the DOM event behind an operation: "click button#submit". */
function describeEvent(ev: Event): string {
	const t = ev.target
	if (t instanceof Element) {
		let where = t.tagName.toLowerCase()
		if (t.id) where += `#${t.id}`
		else if (typeof t.className === 'string' && t.className.trim()) where += `.${t.className.trim().split(/\s+/)[0]}`
		return `${ev.type} ${where}`
	}
	return ev.type
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
	// Last value preview recorded per node, for the write diff. Only previews
	// (short strings) are held — never a node or a live value — so this can't
	// leak the graph. Pruned with the node.
	const lastValue = new Map<number, string>()
	// Dedup key + id of the DOM event currently attributed as an operation root.
	let lastDomKey = ''
	let lastDomId = 0
	const finalizer =
		typeof FinalizationRegistry !== 'undefined'
			? new FinalizationRegistry<number>((id) => {
					registry.delete(id)
					lastValue.delete(id)
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
		valueFull(id) {
			const node = deref(id)
			if (node === undefined) return undefined
			const kind = kindOf(node)
			if (kind !== 'atom' && kind !== 'computed') return null
			const snap = inspect(node as ProducerNode)
			if (snap.uninitialized) return 'uninitialized'
			try {
				return deepPreview(snap.value, 2)
			} catch {
				return preview(snap.value)
			}
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

	// emitEvent (points) and startSpan (compute/effect opens) both record an
	// entry the same way; endSpan closes a span so the collector can time it.
	const emit = (kind: string, node: ReactiveNode | null, cause: TraceEventId, fields?: TraceFields): TraceEventId => {
		const nodeIdNum = node !== null ? register(node) : null
		const nodeKind = node !== null ? kindOf(node) : undefined
		const data = fields !== undefined ? fieldsToData(fields) : {}
		let parent = cause as unknown as number
		// Value diff on a write: the atom already holds the new value when this
		// fires, so peek it inertly and diff against the last we recorded. The
		// engine never sends values — value inspection lives here — so the diff
		// costs nothing when the devtools isn't attached and can't leak.
		if (nodeIdNum !== null && (kind === 'set' || kind === 'update')) {
			const next = provider.value(nodeIdNum)?.preview
			if (next != null) {
				const prev = lastValue.get(nodeIdNum)
				if (prev !== undefined) data.prev = prev
				data.next = next
				lastValue.set(nodeIdNum, next)
			}
			// A root write with no engine cause is the start of an operation:
			// capture the app stack that led here, and attribute it to the DOM
			// event being dispatched so the causal chain begins at the user input.
			// One origin per event, shared by its writes.
			if (parent === 0) {
				const stack = captureStack()
				if (stack.length > 0) data.stack = stack
				const ev = (globalThis as { event?: Event }).event
				if (ev != null && typeof ev.type === 'string') {
					const key = `${ev.type}@${ev.timeStamp}`
					if (key !== lastDomKey) {
						lastDomKey = key
						lastDomId = collector.record('dom-event', null, 0, undefined, { label: describeEvent(ev) })
					}
					parent = lastDomId
				}
			}
		}
		return collector.record(kind, nodeIdNum, parent, nodeKind, data) as unknown as TraceEventId
	}
	setTracer({
		emitEvent: emit,
		startSpan: emit,
		endSpan: (id, attrs) => collector.endSpan(id as unknown as number, attrs?.changed),
	})

	const g = globalThis as { __SIGNALS_DEVTOOLS__?: unknown }
	g.__SIGNALS_DEVTOOLS__ = collector

	return {
		collector,
		detach() {
			setTracer(null)
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
