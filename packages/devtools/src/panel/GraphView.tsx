import { useEffect, useRef, useState } from 'react'
import type { Backend, EventId, NodeId, NodeKind, NodeStatus } from '../protocol.ts'
import { causedTree, causeRows, fmtId, fmtTook, inspectorModel, isUnstable, logRows, type NeighborRef, nodeRows } from './viewmodel.ts'
import { CauseSpine, EventRef } from './CauseSpine.tsx'
import { Code } from './highlight.tsx'
import { glyphFor, layoutFocus } from './graph-layout.ts'
import { copyText, nodeMarkdown } from './markdown.ts'
import { clampSize, ResizeHandle } from './ResizeHandle.tsx'
import { StackTrace } from './StackTrace.tsx'
import { useFlashOnChange } from './useFlash.ts'

const NODE_H = 40
const DEFAULT_PER_COL = 6
/** Viewport rectangle in canvas coordinates (an SVG viewBox). */
interface Box {
	x: number
	y: number
	w: number
	h: number
}

const KIND_LABEL: Record<NodeKind, string> = { atom: 'Atom', computed: 'Computed', watcher: 'Watcher', effect: 'Effect' }
const KIND_TIP: Record<NodeKind, string> = {
	atom: 'Atom: holds a value you set directly.',
	computed: 'Computed: derives its value from other nodes; recomputes when they change.',
	watcher: 'Watcher: a UI subscription — usually a component that re-renders when its inputs change.',
	effect: 'Effect: code that runs after changes commit (persistence, document.title, …).',
}
function kindVar(kind: NodeKind): string {
	return `var(--${kind === 'atom' ? 'atom' : kind === 'computed' ? 'computed' : kind === 'watcher' ? 'watcher' : 'effect'})`
}
function statusVar(status: NodeStatus): string {
	return status === 'error' ? 'var(--danger)' : status === 'suspended' ? 'var(--suspended)' : 'var(--muted)'
}

const KIND_CHIPS: { kind: NodeKind; label: string }[] = [
	{ kind: 'atom', label: 'atom' },
	{ kind: 'computed', label: 'computed' },
	{ kind: 'watcher', label: 'watcher' },
	{ kind: 'effect', label: 'effect' },
]

/**
 * The "+ metrics" opt-in node-list columns (DESIGN §6 progressive disclosure);
 * clicking a header ranks the listed window by that metric, descending.
 * DESIGN §6's fourth column, "downstream cost", is a follow-on: it needs the
 * trace-ring chain-walk attribution of DESIGN §4, which nothing computes yet.
 */
type MetricKey = 'recomputes' | 'selfUs' | 'unchanged'
const METRIC_COLS: { key: MetricKey; label: string; tip: string }[] = [
	{ key: 'recomputes', label: 'recomputes', tip: 'How many times this node ran in the recorded window. Click to rank.' },
	{ key: 'selfUs', label: 'run time', tip: 'Total time spent running this node’s own function in the recorded window. Click to rank.' },
	{ key: 'unchanged', label: 'unchanged', tip: 'Share of recomputes that produced the same result — downstream work stopped. Click to rank.' },
]

function NeighborList({ items, onPick }: { items: NeighborRef[]; onPick: (id: NodeId) => void }) {
	return (
		<ul className="linklist">
			{items.map((n) => (
				<li key={n.id}>
					<span className="sw" style={{ background: kindVar(n.kind) }} />
					<button data-tip={`${n.kind} ${n.name}${n.status !== 'ok' ? ` · ${n.status}` : ''}`} onClick={() => onPick(n.id)}>
						{n.name}
					</button>
					{n.status !== 'ok' ? (
						<span className="meta" style={{ color: statusVar(n.status) }}>
							{n.status}
						</span>
					) : undefined}
				</li>
			))}
			{items.length === 0 ? <li style={{ color: 'var(--faint)' }}>none</li> : undefined}
		</ul>
	)
}

export function GraphView({
	backend,
	selected,
	onSelect,
	openInLog,
	openEventInLog,
}: {
	backend: Backend
	/** The inspected node, owned by App (drives the global nav history). */
	selected: NodeId | undefined
	/** Report a user selection so App records it and updates `selected`. */
	onSelect: (id: NodeId) => void
	openInLog: (id: NodeId) => void
	openEventInLog: (eventId: EventId) => void
}) {
	const [query, setQuery] = useState('')
	const [depth, setDepth] = useState(2)
	const [kindOn, setKindOn] = useState<Record<NodeKind, boolean>>({ atom: true, computed: true, watcher: true, effect: true })
	const [drawerOpen, setDrawerOpen] = useState(true)
	// Canvas center — the node the layout is built around. Distinct from the
	// inspected `selected` (a prop): clicking a shown node inspects it without
	// moving the canvas; navigating to an off-canvas node recenters here.
	const [focus, setFocus] = useState<NodeId | undefined>(undefined)
	const [copied, setCopied] = useState(false)
	// Resizable pane sizes (px).
	const [nodeListH, setNodeListH] = useState(168)
	const [drawerH, setDrawerH] = useState(200)
	const [inspectorW, setInspectorW] = useState(320)
	// A specific event picked from the drawer to inspect in the sidebar; null
	// falls back to the node's most recent event.
	const [eventSel, setEventSel] = useState<EventId | undefined>(undefined)
	// Optional status filter for the node list (error / suspended).
	const [statusOnly, setStatusOnly] = useState<NodeStatus | undefined>(undefined)
	// "+ metrics" columns: off by default (progressive disclosure); rankBy is
	// the metric header the list is sorted by, descending.
	const [metricsOn, setMetricsOn] = useState(false)
	const [rankBy, setRankBy] = useState<MetricKey | undefined>(undefined)
	// Per-column node cap; a frontier stub raises it to reveal more.
	const [perCol, setPerCol] = useState(DEFAULT_PER_COL)
	// Pan/zoom viewBox; undefined means "fit the whole focus set".
	const [view, setView] = useState<Box | undefined>(undefined)
	const svgRef = useRef<SVGSVGElement | null>(null)
	const panRef = useRef<{ cx: number; cy: number; vx: number; vy: number } | undefined>(undefined)
	// Ids currently drawn, so the recenter effect can tell an in-view selection
	// (inspect in place) from an off-canvas one (recenter). Set after `layout`.
	const shownRef = useRef<Set<NodeId>>(new Set())

	// Cap the listed window: the list is a searchable index into a possibly
	// huge graph, not a full render. Narrow with search; the canvas is the
	// spatial view. Keeps DOM + value snapshots bounded at 100k nodes.
	const LIST_CAP = 100
	const counts = backend.counts()
	const allRows = nodeRows(backend, query, LIST_CAP)
	const rows = allRows.filter((n) => kindOn[n.kind] && (statusOnly === undefined || n.status === statusOnly))
	const effectiveFocus = focus ?? rows[0]?.id ?? allRows[0]?.id ?? undefined
	// Rank in place, after the focus fallback took rows[0], so sorting the list
	// never relayouts the canvas. Nodes with no settled recompute rank as 0%.
	if (metricsOn && rankBy !== undefined)
		rows.sort((a, b) =>
			rankBy === 'recomputes'
				? b.recomputes - a.recomputes
				: rankBy === 'selfUs'
					? b.selfUs - a.selfUs
					: (b.sameResults / (b.newResults + b.sameResults) || 0) - (a.sameResults / (a.newResults + a.sameResults) || 0),
		)
	const moreThanListed = counts.nodes - allRows.length
	// Status counts over the listed window (a searchable slice, not the whole
	// graph) — enough to surface errored/suspended nodes to filter to.
	const errCount = allRows.filter((n) => n.status === 'error').length
	const suspCount = allRows.filter((n) => n.status === 'suspended').length

	// Recentering the canvas resets expansion and viewport.
	useEffect(() => {
		setPerCol(DEFAULT_PER_COL)
		setView(undefined)
	}, [effectiveFocus])

	// When the inspected node changes — a pick here, or a link / back-forward
	// from App — recenter the canvas onto it only if it isn't already drawn (so
	// inspecting a visible node never shifts the graph), and drop any drawer
	// event pick. `shownRef` holds the ids drawn this render for that test.
	useEffect(() => {
		if (selected !== undefined && !shownRef.current.has(selected)) setFocus(selected)
		setEventSel(undefined)
	}, [selected])

	const sel = selected ?? effectiveFocus
	const model = sel === undefined ? undefined : inspectorModel(backend, sel)
	const layout = effectiveFocus === undefined ? undefined : layoutFocus(backend, effectiveFocus, depth, perCol)
	shownRef.current = new Set(layout ? layout.nodes.map((n) => n.id) : [])
	const drawer = sel === undefined ? [] : logRows(backend, { node: sel }, 40)

	// One click behaves the same for a canvas node or a list row: report the
	// selection to App. The [selected] effect recenters only if it's off-canvas,
	// so inspecting a visible node never shifts the graph.
	const pick = (id: NodeId) => onSelect(id)
	// The "why this ran" chain shown in the inspector: a drawer-picked event if
	// there is one, else the node's most recent event.
	const whyChain = eventSel !== undefined ? causeRows(backend, eventSel) : (model?.why ?? [])
	// The node's most recent *causing* event — a write or recompute, not a leaf
	// notify/render — and the consequence tree it produced, mirroring the log's
	// "what this caused" into the graph sidebar.
	const lastCause = sel !== undefined ? backend.events({ node: sel, classes: ['write', 'compute'] }, 1)[0] : undefined
	const lastCaused = lastCause !== undefined ? causedTree(logRows(backend, {}, 1000), lastCause.id) : []
	const inspStack = whyChain.find((e) => e.stack !== undefined)?.stack ?? undefined

	// Flash a node or row only when its last event actually advances — never on
	// reveal, relayout, or selection.
	const flashNodes = useFlashOnChange(layout ? layout.nodes.map((n) => [n.id, n.lastEventId]) : [])
	const flashRows = useFlashOnChange(rows.map((n) => [n.id, n.last?.id ?? 0]))

	// Current viewBox: an explicit pan/zoom box, else fit the whole layout.
	const base: Box | undefined = layout ? { x: 0, y: 0, w: layout.width, h: layout.height } : undefined
	const vb = view ?? base
	// Live refs so the once-installed wheel listener never reads a stale box.
	const vbRef = useRef<Box | undefined>(vb)
	vbRef.current = vb
	const baseRef = useRef<Box | undefined>(base)
	baseRef.current = base

	// Cull to the viewport (+ margin): only draw nodes/edges near the viewBox,
	// so a deep set stays cheap when zoomed in.
	const M = 40
	const inBox = (x0: number, y0: number, x1: number, y1: number, v: Box) =>
		x0 <= v.x + v.w + M && x1 >= v.x - M && y0 <= v.y + v.h + M && y1 >= v.y - M
	const visNodes = layout && vb ? layout.nodes.filter((n) => inBox(n.x, n.y, n.x + n.w, n.y + NODE_H, vb)) : (layout?.nodes ?? [])
	const visEdges = layout && vb ? layout.edges.filter((e) => inBox(e.minX, e.minY, e.maxX, e.maxY, vb)) : (layout?.edges ?? [])

	// Zoom around a view-space point, keeping it fixed; clamps to sane extents.
	const zoomAround = (factor: number, px: number, py: number) => {
		const v = vbRef.current
		const b = baseRef.current
		if (v === undefined || b === undefined) return
		const w = Math.max(160, Math.min(b.w * 2.5, v.w * factor))
		const h = w * (v.h / v.w)
		const next = { x: px - (px - v.x) * (w / v.w), y: py - (py - v.y) * (h / v.h), w, h }
		// Wheel events can arrive faster than React renders. Advance the live box
		// immediately so every pinch delta compounds instead of replacing the last.
		vbRef.current = next
		setView(next)
	}
	// Chromium exposes a macOS trackpad pinch as a ctrl+wheel gesture. Plain
	// two-finger motion pans, matching the native canvas gesture vocabulary.
	useEffect(() => {
		const svg = svgRef.current
		if (svg === null) return
		const onWheel = (e: WheelEvent) => {
			const v = vbRef.current
			const b = baseRef.current
			if (v === undefined || b === undefined) return
			e.preventDefault()
			const rect = svg.getBoundingClientRect()
			const scale = Math.min(rect.width / v.w, rect.height / v.h)
			if (e.ctrlKey) {
				const px = v.x + (e.clientX - rect.left - (rect.width - v.w * scale) / 2) / scale
				const py = v.y + (e.clientY - rect.top - (rect.height - v.h * scale) / 2) / scale
				// Base-2 scaling gives small trackpad deltas fine control while a fast
				// pinch can still cross the canvas quickly. Positive delta zooms out.
				const factor = 2 ** Math.max(-1, Math.min(1, e.deltaY * 0.02))
				zoomAround(factor, px, py)
				return
			}

			const next = {
				...v,
				x: clampSize(v.x + e.deltaX / scale, -v.w * 0.5, b.w - v.w * 0.5),
				y: clampSize(v.y + e.deltaY / scale, -v.h * 0.5, b.h - v.h * 0.5),
			}
			vbRef.current = next
			setView(next)
		}
		svg.addEventListener('wheel', onWheel, { passive: false })
		return () => svg.removeEventListener('wheel', onWheel)
	}, [])

	const copyNode = () => {
		if (sel === undefined) return
		void copyText(nodeMarkdown(backend, sel)).then((ok) => {
			setCopied(ok)
			if (ok) setTimeout(() => setCopied(false), 1200)
		})
	}

	return (
		<>
			<div className="toolbar">
				<input
					className="search"
					type="search"
					placeholder="find a node… label or kind"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
				<div className="kind-filters" role="group" aria-label="Node kinds">
					{KIND_CHIPS.map((c) => (
						<button
							key={c.kind}
							className={`kchip ${kindOn[c.kind] ? 'on' : ''}`}
							aria-pressed={kindOn[c.kind]}
							onClick={() => setKindOn({ ...kindOn, [c.kind]: !kindOn[c.kind] })}
						>
							<span className="sw" style={{ background: kindVar(c.kind) }} />
							{c.label} · {counts.byKind[c.kind] ?? 0}
						</button>
					))}
					<button
						className={`kchip ${statusOnly === 'error' ? 'on' : ''}`}
						data-tip="Show only errored nodes — their last recompute threw."
						aria-pressed={statusOnly === 'error'}
						onClick={() => setStatusOnly(statusOnly === 'error' ? undefined : 'error')}
					>
						<span className="sw" style={{ background: 'var(--danger)' }} />
						error · {errCount}
					</button>
					<button
						className={`kchip ${statusOnly === 'suspended' ? 'on' : ''}`}
						data-tip="Show only suspended nodes — a recompute is awaiting async."
						aria-pressed={statusOnly === 'suspended'}
						onClick={() => setStatusOnly(statusOnly === 'suspended' ? undefined : 'suspended')}
					>
						<span className="sw" style={{ background: 'var(--suspended)' }} />
						suspended · {suspCount}
					</button>
				</div>
			</div>

			<div className="main">
				<div className="canvas-col">
					<section className="nodelist" aria-label="All nodes" style={{ height: nodeListH, maxHeight: nodeListH }}>
						<table>
							<thead>
								<tr>
									<th data-tip="The node's label, or kind#id when it has none.">name</th>
									<th data-tip="atom · computed · watcher · effect.">kind</th>
									<th data-tip="Current value preview — or the error / pending reason when the node isn't ok.">value</th>
									<th data-tip="The node's most recent recorded event.">last event</th>
									{metricsOn
										? METRIC_COLS.map((c) => (
												<th
													key={c.key}
													className={`num${rankBy === c.key ? ' sorted' : ''}`}
													aria-sort={rankBy === c.key ? 'descending' : undefined}
													data-tip={c.tip}
													onClick={() => setRankBy(rankBy === c.key ? undefined : c.key)}
												>
													{c.label}
												</th>
											))
										: undefined}
									<th className="metrics-th">
										<button
											className="tbtn"
											aria-pressed={metricsOn}
											data-tip="Add metric columns — recomputes, run time, unchanged — over the recorded window. Click a column to rank."
											onClick={() => setMetricsOn(!metricsOn)}
										>
											{metricsOn ? '− metrics' : '+ metrics'}
										</button>
									</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((n) => (
									<tr
										key={n.id}
										className={`${n.id === sel ? 'selected' : ''}${flashRows.has(n.id) ? ' flash' : ''}`.trim() || undefined}
										aria-selected={n.id === sel}
										onClick={() => pick(n.id)}
									>
										<td>
											<span className="dot" style={{ background: kindVar(n.kind) }} />
											{n.name}
											{isUnstable(n.kind, n.newResults, n.sameResults, n.value === '—' ? undefined : n.value) ? (
												<span className="unstable-mark" data-tip="Unstable: returns a new object every run and never memoizes — its subscribers re-run on every change.">
													⚠
												</span>
											) : undefined}
										</td>
										<td>{n.kind}</td>
										<td className="dimtxt" style={n.status === 'error' ? { color: 'var(--danger)' } : n.status === 'suspended' ? { color: 'var(--suspended)' } : undefined}>
											{n.status !== 'ok' && n.pending !== undefined ? `${n.status === 'error' ? '! ' : '⧗ '}${n.pending}` : n.value}
										</td>
										<td className="dimtxt">{n.last ? `${fmtId('event', n.last.id)} ${n.last.kind}` : '—'}</td>
										{metricsOn ? (
											<>
												<td className="num">{n.recomputes}</td>
												<td className="num">{fmtTook(n.selfUs)}</td>
												<td className="num">
													{n.newResults + n.sameResults > 0 ? `${Math.round((n.sameResults / (n.newResults + n.sameResults)) * 100)}%` : ''}
												</td>
											</>
										) : undefined}
										<td />
									</tr>
								))}
							</tbody>
							<tfoot>
								<tr>
									<td colSpan={metricsOn ? 8 : 5}>
										{rows.length} shown
										{allRows.length > rows.length ? ` · ${allRows.length - rows.length} hidden by kind` : ''}
										{moreThanListed > 0 ? ` · ${moreThanListed.toLocaleString()} more — search to narrow` : ''}
									</td>
								</tr>
							</tfoot>
						</table>
					</section>
					<ResizeHandle dir="v" onDelta={(d) => setNodeListH((h) => clampSize(h + d, 60, 460))} />

					<div className="canvas-wrap">
						{layout !== undefined ? (
							<div className="canvas-controls">
								<button className="tbtn" data-tip="How many levels of dependencies/subscribers to lay out around the focus." onClick={() => setDepth(depth >= 3 ? 1 : depth + 1)}>
									Depth: {depth}
								</button>
								<span role="group" aria-label="Zoom" style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
									<button className="tbtn mode" aria-label="Zoom out" onClick={() => zoomAround(1.25, (vb?.x ?? 0) + (vb?.w ?? 0) / 2, (vb?.y ?? 0) + (vb?.h ?? 0) / 2)}>
										−
									</button>
									<button className="tbtn mode" aria-label="Zoom in" onClick={() => zoomAround(0.8, (vb?.x ?? 0) + (vb?.w ?? 0) / 2, (vb?.y ?? 0) + (vb?.h ?? 0) / 2)}>
										+
									</button>
								</span>
								<button className="tbtn" data-tip="Reset pan and zoom to fit the whole focus set." onClick={() => setView(undefined)}>
									Fit
								</button>
							</div>
						) : undefined}
						{layout === undefined ? (
							<div className="canvas-status">no node focused</div>
						) : (
							<svg
								ref={svgRef}
								viewBox={vb ? `${vb.x} ${vb.y} ${vb.w} ${vb.h}` : '0 0 100 100'}
								preserveAspectRatio="xMidYMid meet"
								aria-label={`Focus graph: ${layout.shown} of ${counts.nodes} nodes`}
								style={{ cursor: panRef.current ? 'grabbing' : 'grab', touchAction: 'none' }}
								onPointerDown={(e) => {
									if ((e.target as Element).closest('.node, .stub') !== null || vb === undefined) return
									panRef.current = { cx: e.clientX, cy: e.clientY, vx: vb.x, vy: vb.y }
									e.currentTarget.setPointerCapture(e.pointerId)
								}}
								onPointerMove={(e) => {
									const p = panRef.current
									const svg = svgRef.current
									if (p === undefined || vb === undefined || svg === null) return
									const r = svg.getBoundingClientRect()
									const nx = p.vx - ((e.clientX - p.cx) / r.width) * vb.w
									const ny = p.vy - ((e.clientY - p.cy) / r.height) * vb.h
									// Clamp so the content can't be panned entirely off-screen: at
									// least part of the layout always stays in the viewBox.
									const bw = base?.w ?? vb.w
									const bh = base?.h ?? vb.h
									setView({ ...vb, x: clampSize(nx, -vb.w * 0.5, bw - vb.w * 0.5), y: clampSize(ny, -vb.h * 0.5, bh - vb.h * 0.5) })
								}}
								onPointerUp={() => {
									panRef.current = undefined
								}}
							>
								<defs>
									<marker id="signals-devtools-arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
										<path d="M0,0.5 L8,4 L0,7.5 z" fill="var(--border-strong)" />
									</marker>
									<marker id="signals-devtools-arr-hot" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
										<path d="M0,0.5 L8,4 L0,7.5 z" fill="var(--thread)" />
									</marker>
								</defs>
								{visEdges.map((e, i) => (
									// eslint-disable-next-line react/no-array-index-key -- edges are positional
									<path key={i} className={e.hot ? 'thread' : `edge${e.dim ? ' dim' : ''}`} d={e.d} />
								))}
								{visNodes.map((n) => (
									<g
										key={n.id}
										className={`node ${n.kind}${n.id === sel ? ' selected' : ''}${n.status === 'suspended' ? ' suspended' : ''}${n.status === 'error' ? ' error' : ''}${n.hot ? ' hot' : ''}${flashNodes.has(n.id) ? ' flash' : ''}`}
										transform={`translate(${n.x},${n.y})`}
										role="button"
										tabIndex={0}
										aria-label={`${KIND_LABEL[n.kind]} ${n.label}`}
										data-tip={`${KIND_TIP[n.kind]}${n.status !== 'ok' ? ` Currently ${n.status}.` : ''}`}
										onClick={() => pick(n.id)}
									>
										{n.hot ? <rect className="ring" width={n.w} height={NODE_H} rx={5} fill="none" stroke="var(--thread)" strokeWidth={2} opacity={0} /> : undefined}
										<rect width={n.w} height={NODE_H} rx={5} />
										{n.status !== 'ok' ? (
											<g className={`badge ${n.status === 'error' ? 'err' : 'sus'}`}>
												<circle cx={n.w - 10} cy={10} r={7} />
												<text x={n.w - 10} y={13}>
													{n.status === 'error' ? '!' : '⧗'}
												</text>
											</g>
										) : undefined}
										<text x={8} y={16}>
											<tspan className="glyph">{glyphFor(n.kind)}</tspan> {n.label}
										</text>
										<text className="sub status" x={8} y={30}>
											{n.sub}
										</text>
									</g>
								))}
								{layout.stubs.map((s, i) => (
									// eslint-disable-next-line react/no-array-index-key -- stubs are positional
									<g key={i} className="stub" transform={`translate(${s.x},${s.y})`} role="button" tabIndex={0} onClick={() => setPerCol((p) => p + 12)}>
										<rect width={s.w} height={24} />
										<text x={8} y={16}>
											⊞ <tspan className="count">{s.count}</tspan> more {s.dir === 'deps' ? 'deps' : 'subscribers'}
										</text>
									</g>
								))}
							</svg>
						)}
						{layout !== undefined && model !== undefined ? (
							<div className="canvas-status">
								drawn <b>{visNodes.length}</b> · set <b>{layout.shown}</b> of <b>{counts.nodes}</b> · focus <b>{model.name}</b> · depth {depth} · pinch to zoom, drag or scroll to pan
							</div>
						) : undefined}
					</div>

					{effectiveFocus !== undefined && drawerOpen ? (
						<ResizeHandle dir="v" onDelta={(d) => setDrawerH((h) => clampSize(h - d, 80, 520))} />
					) : undefined}
					{effectiveFocus !== undefined ? (
						<section className="drawer" aria-label="Log entries for the focused node" style={drawerOpen ? { height: drawerH, maxHeight: drawerH } : { maxHeight: 'none' }}>
							<div className="drawer-head">
								Log <span className="name">{model?.name}</span> · {drawer.length} entries
								<span className="spacer" />
								<button onClick={() => sel !== undefined && openInLog(sel)}>Open in Log ↗</button>
								<button aria-expanded={drawerOpen} onClick={() => setDrawerOpen(!drawerOpen)}>
									{drawerOpen ? '▾ hide' : '▸ show'}
								</button>
							</div>
							{drawerOpen ? (
							<table>
								<tbody>
									{drawer.map((r) => (
										<tr
											key={r.id}
											className={r.id === eventSel ? 'selected' : undefined}
											aria-selected={r.id === eventSel}
											style={{ cursor: 'pointer' }}
											onClick={() => setEventSel(r.id)}
										>
											<td className="id">{fmtId('event', r.id)}</td>
											<td className="t">{r.time}</td>
											<td>
												<span className={`chip ${r.cls}`}>{r.kind}</span>
											</td>
											<td className="data">{r.summary || (r.cause > 0 ? `cause #${r.cause}` : '')}</td>
											<td className="took">{fmtTook(r.took)}</td>
										</tr>
									))}
									{drawer.length === 0 ? (
										<tr>
											<td className="data" style={{ color: 'var(--faint)' }}>
												no entries yet
											</td>
										</tr>
									) : undefined}
								</tbody>
							</table>
							) : undefined}
						</section>
					) : undefined}
				</div>

				<ResizeHandle dir="h" onDelta={(d) => setInspectorW((w) => clampSize(w - d, 220, 640))} />
				{model === undefined ? (
					<aside className="inspector" aria-label="Node inspector" style={{ width: inspectorW }}>
						<div className="insp-section" style={{ color: 'var(--muted)' }}>
							No nodes yet — interact with the app to populate the graph.
						</div>
					</aside>
				) : (
					<aside className="inspector" aria-label="Node inspector" style={{ width: inspectorW }}>
						<div className="insp-head">
							<div className="insp-kind" style={{ color: kindVar(model.node.kind) }}>
								<span className="sw" />
								{KIND_LABEL[model.node.kind]}
								<button className="srclink2 copy-md" onClick={copyNode}>
									⧉ {copied ? 'copied' : 'copy as markdown'}
								</button>
							</div>
							<div className="insp-name">{model.name}</div>
							<div className="insp-id">
								{model.node.kind} · {fmtId('node', model.node.id)} · engine fx2
							</div>
							<div className="insp-desc">{KIND_TIP[model.node.kind].replace(/^[^:]+:\s*/, '')}</div>
						</div>

						<div className="insp-section">
							<h3>Value</h3>
							<div className="value-preview">
								<Code>{model.node.valueFull ?? model.node.valuePreview ?? '—'}</Code>
							</div>
							{model.node.pending !== undefined ? (
								<div className="sumline" style={{ color: statusVar(model.node.status) }}>
									{model.node.pending}
								</div>
							) : undefined}
						</div>

						{model.node.source !== undefined ? (
							<div className="insp-section">
								<h3>Source</h3>
								<div className="value-preview">
									<Code>{model.node.source}</Code>
								</div>
							</div>
						) : undefined}

						<div className="insp-section">
							<h3 data-tip="How this node spent the recorded window: how long its own work took, and whether recomputes produced a new result (work flowed downstream) or the same result (downstream work stopped).">
								Evaluation <span className="win">recorded window</span>
							</h3>
							<div className="kv">
								<span className="k">last event</span>
								<span className="v">
									{model.last ? (
										<>
											<EventRef row={model.last} showName={false} />
											{model.last.took !== undefined ? ` · ${fmtTook(model.last.took)}` : ''}
										</>
									) : (
										'—'
									)}
								</span>
								{model.node.equals !== undefined ? (
									<>
										<span className="k" data-tip="The equality function that decides whether a recompute changed the value.">equals</span>
										<span className="v">{model.node.equals}</span>
									</>
								) : undefined}
								<span className="k" data-tip="Total time spent running this node’s own function in the recorded window.">run time</span>
								<span className="v">{fmtTook(model.node.selfUs)} · {model.node.recomputes} {model.node.recomputes === 1 ? 'run' : 'runs'}</span>
								<span className="k">status</span>
								<span className="v">{model.node.stale ? 'stale' : model.node.status}</span>
							</div>
							{model.node.newResults + model.node.sameResults > 0 ? (
								<>
									<div className="memo-bar" role="img" aria-label={`${model.node.newResults + model.node.sameResults} recomputes: ${model.node.newResults} new, ${model.node.sameResults} same`}>
										{model.node.newResults > 0 ? <span style={{ width: `${(model.node.newResults / (model.node.newResults + model.node.sameResults)) * 100}%`, background: 'var(--computed)' }} /> : undefined}
										{model.node.sameResults > 0 ? <span style={{ width: `${(model.node.sameResults / (model.node.newResults + model.node.sameResults)) * 100}%`, background: 'var(--system)' }} /> : undefined}
									</div>
									<div className="memo-legend">
										<span><span className="sw" style={{ background: 'var(--computed)' }} /><b>{model.node.newResults}×</b> new result — flowed downstream</span>
										<span><span className="sw" style={{ background: 'var(--system)' }} /><b>{model.node.sameResults}×</b> same result — downstream work stopped</span>
									</div>
								</>
							) : undefined}
							{isUnstable(model.node.kind, model.node.newResults, model.node.sameResults, model.node.valuePreview) ? (
								<div
									className="sumline unstable"
									data-tip="This computed returns a fresh object every run, so its equality check never cuts off — every change re-runs its subscribers. A stable reference or a custom equals would let it memoize."
								>
									⚠ unstable — never memoizes (a new object each run)
								</div>
							) : undefined}
						</div>

						<div className="insp-section">
							<h3 data-tip="The chain that led to the shown event, in stack-trace order: it on top, each cause beneath, user input at the bottom. Pick an event in the log below to trace it.">
								Last caused by{eventSel !== undefined ? ` · #${eventSel}` : ''}
							</h3>
							<CauseSpine chain={whyChain} onPick={(e) => openEventInLog(e.id)} />
						</div>

						{lastCaused.length > 0 ? (
							<div className="insp-section">
								<h3 data-tip="Everything the node’s most recent event caused, directly and transitively.">What it caused · {lastCaused.length}</h3>
								<ul className="caused-tree">
									{lastCaused.map((t) => (
										<li key={t.row.id} style={{ paddingLeft: (t.depth - 1) * 14 }}>
											<EventRef row={t.row} onClick={() => openEventInLog(t.row.id)} />
										</li>
									))}
								</ul>
							</div>
						) : undefined}

						{inspStack !== undefined ? <StackTrace frames={inspStack} /> : undefined}
						<div className="insp-section">
							<h3>
								Upstream{' '}
								<span className="win">
									{model.depsTotal} direct
									{model.depsTransitive > model.depsTotal ? ` · ${model.depsTransitive.toLocaleString()} transitive` : ''}
								</span>
							</h3>
							<NeighborList items={model.deps} onPick={pick} />
						</div>

						<div className="insp-section">
							<h3>
								Downstream{' '}
								<span className="win">
									{model.subsTotal} direct
									{model.subsTransitive > model.subsTotal ? ` · ${model.subsTransitive.toLocaleString()} transitive` : ''}
								</span>
							</h3>
							<NeighborList items={model.subs} onPick={pick} />
						</div>
					</aside>
				)}
			</div>
		</>
	)
}
