import { useEffect, useRef, useState } from 'react'
import type { Backend, NodeKind, NodeStatus } from '../protocol.ts'
import { fmtTook, inspectorModel, logRows, type NeighborRef, nodeRows } from './viewmodel.ts'
import { glyphFor, layoutFocus } from './graph-layout.ts'
import { copyText, nodeMarkdown } from './markdown.ts'
import { clampSize, ResizeHandle } from './ResizeHandle.tsx'

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

function NeighborList({ items, onPick }: { items: NeighborRef[]; onPick: (id: number) => void }) {
	return (
		<ul className="linklist">
			{items.map((n) => (
				<li key={n.id}>
					<span className="sw" style={{ background: kindVar(n.kind) }} />
					<button onClick={() => onPick(n.id)}>{n.name}</button>
					{n.status !== 'ok' ? (
						<span className="meta" style={{ color: statusVar(n.status) }}>
							{n.status}
						</span>
					) : null}
				</li>
			))}
			{items.length === 0 ? <li style={{ color: 'var(--faint)' }}>none</li> : null}
		</ul>
	)
}

export function GraphView({
	backend,
	focus,
	setFocus,
	openInLog,
}: {
	backend: Backend
	focus: number | null
	setFocus: (id: number | null) => void
	openInLog: (id: number) => void
}) {
	const [query, setQuery] = useState('')
	const [depth, setDepth] = useState(2)
	const [kindOn, setKindOn] = useState<Record<NodeKind, boolean>>({ atom: true, computed: true, watcher: true, effect: true })
	const [drawerOpen, setDrawerOpen] = useState(true)
	const [history, setHistory] = useState<number[]>([])
	const [copied, setCopied] = useState(false)
	// Resizable pane sizes (px).
	const [nodeListH, setNodeListH] = useState(168)
	const [drawerH, setDrawerH] = useState(200)
	const [inspectorW, setInspectorW] = useState(320)
	// Selection (inspected + highlighted) is separate from focus (what the
	// canvas lays out around): a single click selects without moving anything;
	// a double-click re-focuses and relayouts. So clicking a node never shifts
	// the picture.
	const [selected, setSelected] = useState<number | null>(null)
	// Per-column node cap; a frontier stub raises it to reveal more.
	const [perCol, setPerCol] = useState(DEFAULT_PER_COL)
	// Pan/zoom viewBox; null means "fit the whole focus set".
	const [view, setView] = useState<Box | null>(null)
	const svgRef = useRef<SVGSVGElement | null>(null)
	const panRef = useRef<{ cx: number; cy: number; vx: number; vy: number } | null>(null)

	// Cap the listed window: the list is a searchable index into a possibly
	// huge graph, not a full render. Narrow with search; the canvas is the
	// spatial view. Keeps DOM + value snapshots bounded at 100k nodes.
	const LIST_CAP = 100
	const counts = backend.counts()
	const allRows = nodeRows(backend, query, LIST_CAP)
	const rows = allRows.filter((n) => kindOn[n.kind])
	const effectiveFocus = focus ?? rows[0]?.id ?? allRows[0]?.id ?? null
	const moreThanListed = counts.nodes - allRows.length

	// Moving focus resets selection, expansion, viewport, and the breadcrumb.
	useEffect(() => {
		setSelected(effectiveFocus)
		setPerCol(DEFAULT_PER_COL)
		setView(null)
		if (effectiveFocus !== null) {
			setHistory((h) => (h[h.length - 1] === effectiveFocus ? h : [...h.slice(-6), effectiveFocus]))
		}
	}, [effectiveFocus])

	const sel = selected ?? effectiveFocus
	const model = sel === null ? null : inspectorModel(backend, sel)
	const layout = effectiveFocus === null ? null : layoutFocus(backend, effectiveFocus, depth, perCol)
	const drawer = sel === null ? [] : logRows(backend, { node: sel }, 40)

	// Current viewBox: an explicit pan/zoom box, else fit the whole layout.
	const base: Box | null = layout ? { x: 0, y: 0, w: layout.width, h: layout.height } : null
	const vb = view ?? base
	// Live refs so the once-installed wheel listener never reads a stale box.
	const vbRef = useRef<Box | null>(vb)
	vbRef.current = vb
	const baseRef = useRef<Box | null>(base)
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
		if (v === null || b === null) return
		const w = Math.max(160, Math.min(b.w * 2.5, v.w * factor))
		const h = w * (v.h / v.w)
		setView({ x: px - (px - v.x) * (w / v.w), y: py - (py - v.y) * (h / v.h), w, h })
	}
	// Native, non-passive wheel so we can preventDefault the pane scroll.
	useEffect(() => {
		const svg = svgRef.current
		if (svg === null) return
		const onWheel = (e: WheelEvent) => {
			const v = vbRef.current
			if (v === null) return
			e.preventDefault()
			const r = svg.getBoundingClientRect()
			const px = v.x + ((e.clientX - r.left) / r.width) * v.w
			const py = v.y + ((e.clientY - r.top) / r.height) * v.h
			zoomAround(e.deltaY < 0 ? 0.83 : 1.2, px, py)
		}
		svg.addEventListener('wheel', onWheel, { passive: false })
		return () => svg.removeEventListener('wheel', onWheel)
	}, [])

	const copyNode = () => {
		if (sel === null) return
		void copyText(nodeMarkdown(backend, sel)).then((ok) => {
			setCopied(ok)
			if (ok) setTimeout(() => setCopied(false), 1200)
		})
	}

	return (
		<>
			<div className="toolbar">
				<select className="select" aria-label="Engine">
					<option>fx2 · {counts.nodes} nodes</option>
				</select>
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
				</div>
				<div className="spacer" />
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
				<button className="tbtn" data-tip="Reset pan and zoom to fit the whole focus set." onClick={() => setView(null)}>
					Fit
				</button>
			</div>

			<nav className="crumbs" aria-label="Focus history">
				<span data-tip="The canvas draws only the neighborhood of the focused node. This trail is where you've been.">focus:</span>
				{history.map((id, i) => {
					const n = backend.node(id)
					const name = n === null ? `#${id}` : n.label ?? `${n.kind}#${id}`
					const here = i === history.length - 1
					return (
						<span key={`${id}-${i}`}>
							{i > 0 ? ' › ' : ' '}
							{here ? <span className="here">{name}</span> : <button onClick={() => setFocus(id)}>{name}</button>}
						</span>
					)
				})}
				<span style={{ marginLeft: 'auto' }}>click a node to focus</span>
			</nav>

			<div className="main">
				<div className="canvas-col">
					<section className="nodelist" aria-label="All nodes" style={{ height: nodeListH, maxHeight: nodeListH }}>
						<table>
							<thead>
								<tr>
									<th>name</th>
									<th>kind</th>
									<th>value</th>
									<th>last event</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((n) => (
									<tr
										key={`${n.id}:${n.last?.id ?? 0}`}
										className={n.id === effectiveFocus ? 'selected' : undefined}
										aria-selected={n.id === effectiveFocus}
									>
										<td>
											<span className="dot" style={{ background: kindVar(n.kind) }} />
											<button onClick={() => setFocus(n.id)}>{n.name}</button>
										</td>
										<td>{n.kind}</td>
										<td className="dimtxt" style={n.status === 'error' ? { color: 'var(--danger)' } : n.status === 'suspended' ? { color: 'var(--suspended)' } : undefined}>
											{n.value}
										</td>
										<td className="dimtxt">{n.last ? `#${n.last.id} ${n.last.kind}` : '—'}</td>
									</tr>
								))}
							</tbody>
							<tfoot>
								<tr>
									<td colSpan={4}>
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
						{layout === null ? (
							<div className="canvas-status">no node focused</div>
						) : (
							<svg
								ref={svgRef}
								viewBox={vb ? `${vb.x} ${vb.y} ${vb.w} ${vb.h}` : '0 0 100 100'}
								aria-label={`Focus graph: ${layout.shown} of ${counts.nodes} nodes`}
								style={{ cursor: panRef.current ? 'grabbing' : 'grab', touchAction: 'none' }}
								onPointerDown={(e) => {
									if ((e.target as Element).closest('.node, .stub') !== null || vb === null) return
									panRef.current = { cx: e.clientX, cy: e.clientY, vx: vb.x, vy: vb.y }
									e.currentTarget.setPointerCapture(e.pointerId)
								}}
								onPointerMove={(e) => {
									const p = panRef.current
									const svg = svgRef.current
									if (p === null || vb === null || svg === null) return
									const r = svg.getBoundingClientRect()
									setView({ ...vb, x: p.vx - ((e.clientX - p.cx) / r.width) * vb.w, y: p.vy - ((e.clientY - p.cy) / r.height) * vb.h })
								}}
								onPointerUp={() => {
									panRef.current = null
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
										key={`${n.id}:${n.lastEventId}`}
										className={`node ${n.kind}${n.id === sel ? ' selected' : ''}${n.status === 'suspended' ? ' suspended' : ''}${n.status === 'error' ? ' error' : ''}${n.hot ? ' hot' : ''}`}
										transform={`translate(${n.x},${n.y})`}
										role="button"
										tabIndex={0}
										aria-label={`${KIND_LABEL[n.kind]} ${n.label}`}
										data-tip={`${KIND_TIP[n.kind]}${n.status !== 'ok' ? ` Currently ${n.status}.` : ''} Click to inspect, double-click to focus.`}
										onClick={() => setSelected(n.id)}
										onDoubleClick={() => setFocus(n.id)}
									>
										{n.hot ? <rect className="ring" width={n.w} height={NODE_H} rx={5} fill="none" stroke="var(--thread)" strokeWidth={2} opacity={0} /> : null}
										<rect width={n.w} height={NODE_H} rx={5} />
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
						{layout !== null && model !== null ? (
							<div className="canvas-status">
								drawn <b>{visNodes.length}</b> · set <b>{layout.shown}</b> of <b>{counts.nodes}</b> · focus <b>{model.name}</b> · depth {depth} · scroll to zoom, drag to pan
							</div>
						) : null}
					</div>

					{effectiveFocus !== null && drawerOpen ? (
						<ResizeHandle dir="v" onDelta={(d) => setDrawerH((h) => clampSize(h - d, 80, 520))} />
					) : null}
					{effectiveFocus !== null && drawerOpen ? (
						<section className="drawer" aria-label="Log entries for the focused node" style={{ maxHeight: drawerH }}>
							<div className="drawer-head">
								Log <span className="name">{model?.name}</span> · {drawer.length} entries
								<span className="spacer" />
								<button onClick={() => sel !== null && openInLog(sel)}>Open in Log ↗</button>
								<button aria-expanded={true} onClick={() => setDrawerOpen(false)}>
									▾ hide
								</button>
							</div>
							<table>
								<tbody>
									{drawer.map((r) => (
										<tr key={r.id}>
											<td className="id">#{r.id}</td>
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
									) : null}
								</tbody>
							</table>
						</section>
					) : null}
				</div>

				<ResizeHandle dir="h" onDelta={(d) => setInspectorW((w) => clampSize(w - d, 220, 640))} />
				{model === null ? (
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
							</div>
							<div className="insp-name">{model.name}</div>
							<div className="insp-id">
								{model.node.kind}#{model.node.id} · engine fx2
							</div>
							<button className="srclink2" onClick={copyNode}>
								⧉ {copied ? 'copied' : 'copy as markdown'}
							</button>
						</div>

						<div className="insp-section">
							<h3>Value</h3>
							<div className="value-preview">{model.node.valuePreview ?? '—'}</div>
							{model.node.pending !== null ? (
								<div className="sumline" style={{ color: statusVar(model.node.status) }}>
									{model.node.pending}
								</div>
							) : null}
						</div>

						<div className="insp-section">
							<h3>Evaluation</h3>
							<div className="kv">
								<span className="k">last event</span>
								<span className="v">
									{model.last ? `#${model.last.id} ${model.last.kind}` : '—'}
									{model.last && model.last.took !== null ? ` · ${fmtTook(model.last.took)}` : ''}
								</span>
								<span className="k">recomputes</span>
								<span className="v">{model.node.recomputes}</span>
								<span className="k">status</span>
								<span className="v">{model.node.stale ? 'stale' : model.node.status}</span>
							</div>
						</div>

						<div className="insp-section">
							<h3 data-tip="The chain that led to this node's most recent activity, in stack-trace order: this node on top, each cause beneath, user input at the bottom.">
								Why this ran
							</h3>
							{model.why.length === 0 ? (
								<div className="sumline">no recorded activity yet</div>
							) : (
								<ol className="spine">
									{[...model.why].reverse().map((e, i) => (
										<li key={e.id} className={i === 0 ? 'terminus' : undefined}>
											<div className="knot" />
											<div className="ev">
												<span className="id">#{e.id}</span>
												<button onClick={() => e.node !== null && setFocus(e.node)}>
													{e.kind} {e.name ?? ''}
												</button>
											</div>
											{e.summary ? <div className="because">{e.summary}</div> : null}
										</li>
									))}
								</ol>
							)}
						</div>

						<div className="insp-section">
							<h3>
								Upstream <span className="win">{model.depsTotal} direct</span>
							</h3>
							<NeighborList items={model.deps} onPick={setFocus} />
						</div>

						<div className="insp-section">
							<h3>
								Downstream <span className="win">{model.subsTotal} direct</span>
							</h3>
							<NeighborList items={model.subs} onPick={setFocus} />
						</div>
					</aside>
				)}
			</div>
		</>
	)
}
