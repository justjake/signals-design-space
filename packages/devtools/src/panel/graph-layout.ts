/**
 * Focus-set layout for the graph canvas — pure geometry, no React, no DOM.
 *
 * The canvas never draws the whole graph (there may be 100k nodes). It draws
 * the neighborhood of one focused node: `depth` levels of dependencies to the
 * left, `depth` levels of subscribers to the right, laid out in columns. Each
 * column caps how many nodes it shows and collapses the rest into a frontier
 * stub, so the drawing stays bounded no matter how large the real graph is.
 *
 * Selection never moves a node — it only restyles it. Moving focus recomputes
 * the whole set. That keeps the picture stable to read.
 */
import type { Backend, EventId, NodeDetails, NodeId, NodeKind, NodeStatus } from '../protocol.ts'
import { nodeDisplayName } from '../protocol.ts'

const COL_GAP = 250
const NODE_W = 176
const FOCUS_W = 200
/** Node box height, shared with the canvas renderer for hit areas and culling. */
export const NODE_H = 40
const ROW_GAP = 54
const PAD_Y = 24
/** Per-column node cap before the rest collapse into a frontier stub. */
export const DEFAULT_PER_COL = 6

export interface PlacedNode {
	id: NodeId
	x: number
	y: number
	w: number
	kind: NodeKind
	label: string
	sub: string
	status: NodeStatus
	hot: boolean
	focus: boolean
	/** Most recent entry id — the flash re-keys on this so a node flashes when
	 * it updates. */
	lastEventId: EventId
}

export interface PlacedEdge {
	d: string
	hot: boolean
	dim: boolean
	/** Axis-aligned bounds of the curve, for viewport culling. */
	minX: number
	minY: number
	maxX: number
	maxY: number
}

export interface FrontierStub {
	x: number
	y: number
	w: number
	count: number
	dir: 'deps' | 'subs'
}

export interface GraphLayout {
	nodes: PlacedNode[]
	edges: PlacedEdge[]
	stubs: FrontierStub[]
	width: number
	height: number
	/** Total nodes reachable in the focus set before capping (for the status line). */
	shown: number
}

/** Nodes touched by the last propagation — drawn "hot" with the causal thread. */
function hotSet(backend: Backend): Set<NodeId> {
	const last = backend.events({}, 1)[0]
	const set = new Set<NodeId>()
	if (last === undefined) return set
	for (const e of backend.causeChain(last.id)) if (e.node !== undefined) set.add(e.node)
	return set
}

function subLine(n: NodeDetails): string {
	if (n.status === 'error') return n.pending ?? '! error'
	// A suspended node keeps serving its last settled value (cosignals stale-while-
	// revalidate); show that value with a pending marker, not the Suspension
	// object. Only a never-yet-resolved node has no value to show.
	if (n.status === 'suspended') return n.valuePreview !== undefined ? `⧗ ${n.valuePreview}` : '⧗ pending'
	if (n.valuePreview !== undefined) return `· ${n.valuePreview}`
	return ''
}

/**
 * Walk `depth` levels out from `focusId` in one direction, one column per level.
 * Returns columns nearest-focus-first; caps each column and reports overflow.
 */
function walk(
	backend: Backend,
	focusId: NodeId,
	dir: 'deps' | 'subs',
	depth: number,
	maxPerCol: number,
	placed: Set<NodeId>,
): { columns: NodeId[][]; overflow: number[] } {
	const columns: NodeId[][] = []
	const overflow: number[] = []
	let frontier = [focusId]
	for (let level = 0; level < depth; level++) {
		const next: NodeId[] = []
		const seen = new Set<NodeId>()
		for (const id of frontier) {
			const n = backend.node(id)
			if (n === undefined) continue
			for (const nb of dir === 'deps' ? n.deps : n.subs) {
				if (placed.has(nb) || seen.has(nb)) continue
				seen.add(nb)
				next.push(nb)
			}
		}
		if (next.length === 0) break
		const cap = next.length > maxPerCol ? maxPerCol - 1 : next.length
		const shown = next.slice(0, cap)
		if (next.length > cap) overflow[level] = next.length - cap
		for (const id of shown) placed.add(id)
		columns.push(shown)
		frontier = shown
	}
	return { columns, overflow }
}

function place(
	backend: Backend,
	ids: NodeId[],
	x: number,
	centerY: number,
	focusId: NodeId,
	hot: Set<NodeId>,
	out: PlacedNode[],
): void {
	const total = ids.length * ROW_GAP - (ROW_GAP - NODE_H)
	let y = centerY - total / 2
	for (const id of ids) {
		const n = backend.node(id)
		if (n !== undefined) {
			out.push({
				id,
				x,
				y,
				w: id === focusId ? FOCUS_W : NODE_W,
				kind: n.kind,
				label: nodeDisplayName(n),
				sub: subLine(n),
				status: n.status,
				hot: hot.has(id),
				focus: id === focusId,
				lastEventId: n.lastEventId,
			})
		}
		y += ROW_GAP
	}
}

const GLYPH: Record<NodeKind, string> = { atom: '◆', computed: 'ƒ', watcher: '▣', effect: '⚡' }

export function glyphFor(kind: NodeKind): string {
	return GLYPH[kind]
}

/** Build the layout for the neighborhood of `focusId`. `maxPerCol` caps each
 * column (the rest collapse into a frontier stub); raise it to expand. */
export function layoutFocus(backend: Backend, focusId: NodeId, depth: number, maxPerCol = DEFAULT_PER_COL): GraphLayout | undefined {
	const focus = backend.node(focusId)
	if (focus === undefined) return undefined
	const hot = hotSet(backend)
	const placed = new Set<NodeId>([focusId])
	const up = walk(backend, focusId, 'deps', depth, maxPerCol, placed)
	const down = walk(backend, focusId, 'subs', depth, maxPerCol, placed)

	// Columns left→right: farthest upstream level … focus … farthest downstream.
	const columns: { ids: NodeId[]; overflow: number; dir: 'deps' | 'subs' | 'focus' }[] = []
	for (let level = up.columns.length - 1; level >= 0; level--)
		columns.push({ ids: up.columns[level], overflow: up.overflow[level] ?? 0, dir: 'deps' })
	columns.push({ ids: [focusId], overflow: 0, dir: 'focus' })
	for (let level = 0; level < down.columns.length; level++)
		columns.push({ ids: down.columns[level], overflow: down.overflow[level] ?? 0, dir: 'subs' })

	const maxRows = Math.max(1, ...columns.map((c) => c.ids.length + (c.overflow > 0 ? 1 : 0)))
	const height = PAD_Y * 2 + maxRows * ROW_GAP - (ROW_GAP - NODE_H)
	const centerY = height / 2
	const width = 40 + columns.length * COL_GAP

	const nodes: PlacedNode[] = []
	const stubs: FrontierStub[] = []
	columns.forEach((col, i) => {
		const x = 20 + i * COL_GAP
		place(backend, col.ids, x, centerY, focusId, hot, nodes)
		if (col.overflow > 0) {
			// Stub sits one slot below the column's placed nodes.
			const total = col.ids.length * ROW_GAP - (ROW_GAP - NODE_H)
			stubs.push({ x, y: centerY - total / 2 + col.ids.length * ROW_GAP, w: NODE_W, count: col.overflow, dir: col.dir === 'subs' ? 'subs' : 'deps' })
		}
	})

	// Edges: dep → sub, between any two placed nodes.
	const byId = new Map(nodes.map((n) => [n.id, n]))
	const edges: PlacedEdge[] = []
	for (const p of nodes) {
		const details = backend.node(p.id)
		if (details === undefined) continue
		for (const subId of details.subs) {
			const s = byId.get(subId)
			if (s === undefined) continue
			const x1 = p.x + p.w
			const y1 = p.y + NODE_H / 2
			const x2 = s.x
			const y2 = s.y + NODE_H / 2
			const mx = (x1 + x2) / 2
			const bothHot = p.hot && s.hot
			edges.push({
				d: `M ${x1},${y1} C ${mx},${y1} ${mx},${y2} ${x2},${y2}`,
				hot: bothHot,
				dim: !bothHot && !p.focus && !s.focus,
				minX: Math.min(x1, x2),
				minY: Math.min(y1, y2),
				maxX: Math.max(x1, x2),
				maxY: Math.max(y1, y2),
			})
		}
	}

	return { nodes, edges, stubs, width, height, shown: placed.size }
}
