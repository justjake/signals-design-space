/**
 * Engine adapter — plug any engine exposing the `/debug` contract into a
 * Collector.
 *
 * Both `signals-royale-fx2/debug` and `signals-royale-fx2-dalien/debug`
 * export the same surface (that contract is the whole point of the debug
 * entry); this module is the one adapter body, parameterized over that
 * surface, and `./fx2` / `./dalien` are thin bindings of it. It installs
 * the trace hook (events flow straight through, kind strings verbatim) and
 * implements the NodeProvider with the inert `inspect`/`deps`/`subs` peeks.
 * Node handles are held only via WeakRef and pruned through a
 * FinalizationRegistry, so attaching the devtools never keeps a disposed
 * node alive. No engine internals are touched beyond the ./debug contract.
 */

import { Collector, type NodeProvider } from './collector.ts'
import type { EventId, NodeId, NodeKind, NodeStatus, StackFrame } from './protocol.ts'

/**
 * The structural slice of an engine node the adapter reads directly;
 * everything else goes through the debug functions. Handles are otherwise
 * opaque.
 */
export interface EngineNode {
	label?: string | undefined
}

/** The inert snapshot shape shared by both engines' `inspect`. */
export interface EngineInspected {
	value: unknown
	uninitialized: boolean
	status: string
	stale: boolean
	pending: unknown
}

/** The structural slice of TraceFields the adapter forwards. */
export interface EngineTraceFields {
	root?: object
	suspension?: object
	draftId?: number
	error?: unknown
	status?: string
	phase?: string
	world?: readonly number[]
}

/**
 * The `/debug` surface the adapter consumes. Declared with method
 * signatures (bivariant) so each engine's own nominal node types satisfy it
 * structurally — the adapter only ever hands back nodes the engine gave it.
 */
export interface EngineDebug {
	setTracer(
		sink: {
			emitEvent(kind: string, node: EngineNode | null, parent: number, attrs?: EngineTraceFields): number
			startSpan(kind: string, node: EngineNode | null, parent: number, attrs?: EngineTraceFields): number
			endSpan?(id: number, attrs?: { changed?: boolean }): void
		} | null,
	): void
	setHotTracer(fn: ((node: EngineNode, step: string, cause?: number) => void) | null): void
	inspect(node: EngineNode): EngineInspected
	deps(node: EngineNode): EngineNode[]
	subs(node: EngineNode): EngineNode[]
	nodeId(node: EngineNode): number
	nodeKind(node: EngineNode): string
	nodeStatus(node: EngineNode): string
}

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
	// Both engines wrap thrown values in an ErrorBox { error }.
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

/** Changed leaf paths between two structured values — bounded in depth and
 * count — formatted "path: prev → next" (e.g. "todos[3].done: false → true").
 * Descends matching containers (both arrays, or both plain objects); a shape
 * change or a changed leaf reports at its path. Inert: reads values, never the
 * graph. */
function diffPaths(prev: unknown, next: unknown, path: string, out: string[], depth: number): void {
	if (out.length >= 12 || depth > 5 || Object.is(prev, next)) return
	const pa = Array.isArray(prev)
	const na = Array.isArray(next)
	const po = !pa && prev !== null && typeof prev === 'object'
	const no = !na && next !== null && typeof next === 'object'
	if ((pa && na) || (po && no)) {
		const keys = new Set<string>([...Object.keys(prev as object), ...Object.keys(next as object)])
		for (const k of keys) {
			if (out.length >= 12) break
			const seg = pa ? `[${k}]` : path === '' ? k : `.${k}`
			diffPaths((prev as Record<string, unknown>)[k], (next as Record<string, unknown>)[k], path + seg, out, depth + 1)
		}
	} else {
		out.push(`${path || 'value'}: ${preview(prev)} → ${preview(next)}`)
	}
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
	// (The signals-royale-fx2 pattern also matches the -dalien package path.)
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

export interface EngineDevtools {
	collector: Collector
	detach(): void
}

/**
 * Attach the collector to the given engine's debug surface and expose it on
 * `globalThis.__SIGNALS_DEVTOOLS__`. Call the returned `detach()` to remove
 * the trace hook and stop observing.
 */
export function attachEngineDevtools(
	engine: EngineDebug,
	opts?: { capacity?: number; now?: () => number },
): EngineDevtools {
	// id -> live node, WeakRef so a disposed node can be collected.
	const registry = new Map<NodeId, WeakRef<EngineNode>>()
	// Last value preview recorded per node, for the write diff. Only previews
	// (short strings) are held — never a node or a live value — so this can't
	// leak the graph. Pruned with the node.
	const lastValue = new Map<NodeId, string>()
	// The last structured value per node, for the write PATH diff. It's updated
	// to the live value on every write, so between writes it holds the same
	// object the engine does — no extra retention; only during a diff does it
	// briefly hold the prior value. Pruned with the node: bounded and reclaimed,
	// so not a leak. (The preview-only `lastValue` above stays for the summary.)
	const lastFull = new Map<NodeId, unknown>()
	// Dedup key + id of the DOM event currently attributed as an operation root.
	let lastDomKey = ''
	let lastDomId: EventId = 0 as EventId
	const finalizer =
		typeof FinalizationRegistry !== 'undefined'
			? new FinalizationRegistry<NodeId>((id) => {
					registry.delete(id)
					lastValue.delete(id)
					lastFull.delete(id)
					collector.forget(id)
				})
			: null

	function register(node: EngineNode): NodeId {
		const id = engine.nodeId(node) as unknown as NodeId
		if (!registry.has(id)) {
			registry.set(id, new WeakRef(node))
			finalizer?.register(node, id)
		}
		return id
	}

	function deref(id: NodeId): EngineNode | undefined {
		return registry.get(id)?.deref()
	}

	function kindOf(node: EngineNode): NodeKind {
		return engine.nodeKind(node) as NodeKind
	}

	const provider: NodeProvider = {
		kind(id) {
			const node = deref(id)
			return node ? kindOf(node) : undefined
		},
		label(id) {
			const node = deref(id)
			return node?.label
		},
		value(id) {
			const node = deref(id)
			if (node === undefined) return undefined
			const kind = kindOf(node)
			// Only producers (atoms, computeds) carry a value; peek inertly.
			if (kind === 'atom' || kind === 'computed') {
				const snap = engine.inspect(node)
				return {
					preview: snap.uninitialized ? 'uninitialized' : preview(snap.value),
					status: snap.status as NodeStatus,
					stale: snap.stale,
					pending: snap.pending == null ? undefined : errorPreview(snap.pending),
				}
			}
			return { preview: undefined, status: engine.nodeStatus(node) as NodeStatus, stale: false, pending: undefined }
		},
		valueFull(id) {
			const node = deref(id)
			if (node === undefined) return undefined
			const kind = kindOf(node)
			if (kind !== 'atom' && kind !== 'computed') return undefined
			const snap = engine.inspect(node)
			if (snap.uninitialized) return 'uninitialized'
			try {
				return deepPreview(snap.value, 2)
			} catch {
				return preview(snap.value)
			}
		},
		equals(id) {
			// The equality fn is a static field on atoms/computeds; read its name
			// inertly. Only surface a custom comparator — the default is the
			// engine's reference check (Object.is, name "is"), which is the norm
			// and not worth a row on every node. Anonymous/absent → null.
			const node = deref(id)
			if (node === undefined) return undefined
			const fn = (node as { equals?: (a: unknown, b: unknown) => boolean }).equals
			return typeof fn === 'function' && fn.name !== '' && fn.name !== 'is' ? fn.name : undefined
		},
		source(id) {
			// Synthesize a "how this was created" signature from the node's
			// stringified function(s), read inertly. Computeds carry the compute
			// fn; effects also carry the handler; plain atoms have neither.
			const node = deref(id)
			if (node === undefined) return undefined
			const trunc = (f: unknown): string | undefined => {
				if (typeof f !== 'function') return undefined
				const s = (f as { toString(): string }).toString()
				return s.length > 240 ? `${s.slice(0, 240)}…` : s
			}
			const fn = trunc((node as { fn?: unknown }).fn)
			const kind = kindOf(node)
			if (kind === 'computed') return fn !== undefined ? `computed(${fn})` : undefined
			if (kind === 'effect') {
				const handler = trunc((node as { handler?: unknown }).handler)
				return fn !== undefined ? `effect(${fn}${handler !== undefined ? `, ${handler}` : ''})` : undefined
			}
			return undefined
		},
		deps(id) {
			const node = deref(id)
			if (node === undefined) return []
			return engine.deps(node).map(register)
		},
		subs(id) {
			const node = deref(id)
			if (node === undefined) return []
			// Only producers have a subscriber list; others yield an empty walk.
			return engine.subs(node).map(register)
		},
	}

	const collector = new Collector(provider, opts)

	// emitEvent (points) and startSpan (compute/effect opens) both record an
	// entry the same way; endSpan closes a span so the collector can time it.
	const emit = (kind: string, node: EngineNode | null, cause: number, fields?: EngineTraceFields): number => {
		const nodeIdNum = node !== null ? register(node) : undefined
		const nodeKind = node !== null ? kindOf(node) : undefined
		const data = fields !== undefined ? fieldsToData(fields) : {}
		let parent = cause as unknown as EventId
		// Value diff on a write: the atom already holds the new value when this
		// fires, so peek it inertly and diff against the last we recorded. The
		// engine never sends values — value inspection lives here — so the diff
		// costs nothing when the devtools isn't attached and can't leak.
		if (nodeIdNum !== undefined && (kind === 'set' || kind === 'update')) {
			const next = provider.value(nodeIdNum)?.preview
			if (next != null) {
				const prev = lastValue.get(nodeIdNum)
				if (prev !== undefined) data.prev = prev
				data.next = next
				lastValue.set(nodeIdNum, next)
			}
			// Path diff: for object values, diff the structured value against the
			// last so a change reads as "todos[3].done: false → true", not just the
			// whole-value preview. Structured peek is inert; held value tracks the
			// live one between writes (no extra retention).
			const nodeRef = deref(nodeIdNum)
			if (nodeRef !== undefined) {
				try {
					const cur = engine.inspect(nodeRef).value
					if (cur !== null && typeof cur === 'object') {
						const before = lastFull.get(nodeIdNum)
						if (before !== undefined) {
							const paths: string[] = []
							diffPaths(before, cur, '', paths, 0)
							if (paths.length > 0) data.diff = paths.join('; ')
						}
						lastFull.set(nodeIdNum, cur)
					} else {
						lastFull.delete(nodeIdNum)
					}
				} catch {
					/* an inert peek threw; skip the diff */
				}
			}
			// A root write with no engine cause is the start of an operation:
			// capture the app stack that led here, and attribute it to the DOM
			// event being dispatched so the causal chain begins at the user input.
			// One origin per event, shared by its writes.
			if (parent === (0 as EventId)) {
				const stack = captureStack()
				if (stack.length > 0) data.stack = stack
				const ev = (globalThis as { event?: Event }).event
				if (ev != null && typeof ev.type === 'string') {
					const key = `${ev.type}@${ev.timeStamp}`
					if (key !== lastDomKey) {
						lastDomKey = key
						lastDomId = collector.record('dom-event', undefined, 0 as EventId, undefined, { label: describeEvent(ev) })
					}
					parent = lastDomId
				}
			}
		}
		return collector.record(kind, nodeIdNum, parent, nodeKind, data) as unknown as number
	}
	engine.setTracer({
		emitEvent: emit,
		startSpan: emit,
		endSpan: (id, attrs) => collector.endSpan(id as unknown as EventId, attrs?.changed),
	})

	// Hot algorithm channel: the engine hook is installed only while hot mode
	// is on (collector.setHotMode), so the disabled cost stays the engine's own
	// per-site null check. Each hot event carries the node's registered id and
	// the step string — the ring never holds a node, same as every other event.
	collector.setHotSource((on) =>
		engine.setHotTracer(
			on ? (node, step, cause) => void collector.record(step, register(node), (cause ?? 0) as EventId, kindOf(node), {}) : null,
		),
	)

	const g = globalThis as { __SIGNALS_DEVTOOLS__?: unknown }
	g.__SIGNALS_DEVTOOLS__ = collector

	return {
		collector,
		detach() {
			engine.setTracer(null)
			engine.setHotTracer(null)
			if (g.__SIGNALS_DEVTOOLS__ === collector) g.__SIGNALS_DEVTOOLS__ = undefined
		},
	}
}

/** Flatten TraceFields into a structured-clone-safe data bag for the event. */
function fieldsToData(fields: EngineTraceFields): Record<string, unknown> {
	const data: Record<string, unknown> = {}
	if (fields.draftId !== undefined) data.draftId = fields.draftId
	if (fields.phase !== undefined) data.phase = fields.phase
	if (fields.status !== undefined) data.status = fields.status
	if (fields.world !== undefined) data.world = fields.world
	if (fields.error !== undefined) data.error = errorPreview(fields.error)
	return data
}
