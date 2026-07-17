/**
 * The graph tab, as a coordinator: it owns the search/filter/focus state,
 * resolves the view-model rows the child components render, and wires their
 * selections back into App's navigation. The pieces live in their own files —
 * NodeList (the searchable index), GraphCanvas (the SVG neighborhood),
 * NodeEventsDrawer (the focused node's entries), NodeInspector (the sidebar).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Backend, EventId, NodeId, NodeKind, NodeStatus } from '../protocol.ts'
import { causedTree, causeRows, inspectorModel, logRows, nodeRows } from './viewmodel.ts'
import { DEFAULT_PER_COL, glyphFor, layoutFocus } from './graph-layout.ts'
import { GraphCanvas } from './GraphCanvas.tsx'
import { kindVar } from './kind-style.ts'
import { nodeMarkdown } from './markdown.ts'
import { NodeEventsDrawer } from './NodeEventsDrawer.tsx'
import { NodeInspector } from './NodeInspector.tsx'
import { NodeList } from './NodeList.tsx'
import { clampSize, ResizeHandle } from './ResizeHandle.tsx'
import { useBackend } from './store.ts'

const KIND_CHIPS: { kind: NodeKind; label: string }[] = [
	{ kind: 'atom', label: 'atom' },
	{ kind: 'computed', label: 'computed' },
	{ kind: 'watcher', label: 'watcher' },
	{ kind: 'effect', label: 'effect' },
]

// Cap the listed window: the list is a searchable index into a possibly
// huge graph, not a full render. Narrow with search; the canvas is the
// spatial view. Keeps DOM + value snapshots bounded at 100k nodes.
const LIST_CAP = 100

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
	// Flush counter: bumps when the collector records new entries. The memos
	// below key their backend reads on it, so a re-render caused by local state
	// (a selection, a resize) never re-walks the graph.
	const flush = useBackend(backend)
	const [query, setQuery] = useState('')
	const [depth, setDepth] = useState(2)
	const [kindOn, setKindOn] = useState<Record<NodeKind, boolean>>({ atom: true, computed: true, watcher: true, effect: true })
	const [drawerOpen, setDrawerOpen] = useState(true)
	// Canvas center — the node the layout is built around. Distinct from the
	// inspected `selected` (a prop): clicking a shown node inspects it without
	// moving the canvas; navigating to an off-canvas node recenters here.
	const [focus, setFocus] = useState<NodeId | undefined>(undefined)
	// Resizable pane sizes (px).
	const [nodeListH, setNodeListH] = useState(168)
	const [drawerH, setDrawerH] = useState(200)
	const [inspectorW, setInspectorW] = useState(320)
	// A specific event picked from the drawer to inspect in the sidebar; null
	// falls back to the node's most recent event.
	const [eventSel, setEventSel] = useState<EventId | undefined>(undefined)
	// Optional status filter for the node list (error / suspended).
	const [statusOnly, setStatusOnly] = useState<NodeStatus | undefined>(undefined)
	// Per-column node cap; a frontier stub raises it to reveal more.
	const [perCol, setPerCol] = useState(DEFAULT_PER_COL)
	// Ids currently drawn, so the recenter effect can tell an in-view selection
	// (inspect in place) from an off-canvas one (recenter). Set after `layout`.
	const shownRef = useRef<Set<NodeId>>(new Set())

	const counts = backend.counts()
	const allRows = useMemo(() => nodeRows(backend, query, LIST_CAP), [backend, flush, query])
	const rows = allRows.filter((n) => kindOn[n.kind] && (statusOnly === undefined || n.status === statusOnly))
	const effectiveFocus = focus ?? rows[0]?.id ?? allRows[0]?.id ?? undefined
	// Status counts over the listed window (a searchable slice, not the whole
	// graph) — enough to surface errored/suspended nodes to filter to.
	const errCount = allRows.filter((n) => n.status === 'error').length
	const suspCount = allRows.filter((n) => n.status === 'suspended').length

	// Recentering the canvas resets expansion (the canvas resets its own viewport).
	useEffect(() => {
		setPerCol(DEFAULT_PER_COL)
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
	const model = useMemo(() => (sel === undefined ? undefined : inspectorModel(backend, sel)), [backend, flush, sel])
	const layout = useMemo(
		() => (effectiveFocus === undefined ? undefined : layoutFocus(backend, effectiveFocus, depth, perCol)),
		[backend, flush, effectiveFocus, depth, perCol],
	)
	shownRef.current = new Set(layout ? layout.nodes.map((n) => n.id) : [])
	const drawer = useMemo(() => (sel === undefined ? [] : logRows(backend, { node: sel }, 40)), [backend, flush, sel])

	// One click behaves the same for a canvas node or a list row: report the
	// selection to App. The [selected] effect recenters only if it's off-canvas,
	// so inspecting a visible node never shifts the graph.
	const pick = (id: NodeId) => onSelect(id)
	// The "why this ran" chain shown in the inspector: a drawer-picked event if
	// there is one, else the node's most recent event.
	const whyChain = useMemo(
		() => (eventSel !== undefined ? causeRows(backend, eventSel) : (model?.why ?? [])),
		[backend, flush, eventSel, model],
	)
	// The node's most recent *causing* event — a write or recompute, not a leaf
	// notify/render — and the consequence tree it produced, mirroring the log's
	// "what this caused" into the graph sidebar.
	const lastCaused = useMemo(() => {
		if (sel === undefined) return []
		const lastCause = backend.events({ node: sel, classes: ['write', 'compute'] }, 1)[0]
		return lastCause !== undefined ? causedTree(logRows(backend, {}, 1000), lastCause.id) : []
	}, [backend, flush, sel])
	const inspStack = whyChain.find((e) => e.stack !== undefined)?.stack ?? undefined

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
							<span className="kglyph" style={{ color: kindVar(c.kind) }}>{glyphFor(c.kind)}</span>
							{c.label} · {counts.byKind[c.kind] ?? 0}
						</button>
					))}
					<button
						className={`kchip ${statusOnly === 'error' ? 'on' : ''}`}
						data-tip="Show only errored nodes — their last recompute threw."
						aria-pressed={statusOnly === 'error'}
						onClick={() => setStatusOnly(statusOnly === 'error' ? undefined : 'error')}
					>
						<span className="kglyph" style={{ color: 'var(--danger)' }}>!</span>
						error · {errCount}
					</button>
					<button
						className={`kchip ${statusOnly === 'suspended' ? 'on' : ''}`}
						data-tip="Show only suspended nodes — a recompute is awaiting async."
						aria-pressed={statusOnly === 'suspended'}
						onClick={() => setStatusOnly(statusOnly === 'suspended' ? undefined : 'suspended')}
					>
						<span className="kglyph" style={{ color: 'var(--suspended)' }}>⧗</span>
						suspended · {suspCount}
					</button>
				</div>
			</div>

			<div className="main">
				<div className="canvas-col">
					<NodeList
						rows={rows}
						sel={sel}
						onPick={pick}
						height={nodeListH}
						hiddenByKind={allRows.length - rows.length}
						moreThanListed={counts.nodes - allRows.length}
					/>
					<ResizeHandle dir="v" onDelta={(d) => setNodeListH((h) => clampSize(h + d, 60, 460))} />

					<GraphCanvas
						layout={layout}
						focusId={effectiveFocus}
						focusName={model?.name}
						totalNodes={counts.nodes}
						sel={sel}
						depth={depth}
						setDepth={setDepth}
						onPick={pick}
						onExpandColumn={() => setPerCol((p) => p + 12)}
					/>

					{effectiveFocus !== undefined && drawerOpen ? (
						<ResizeHandle dir="v" onDelta={(d) => setDrawerH((h) => clampSize(h - d, 80, 520))} />
					) : undefined}
					{effectiveFocus !== undefined ? (
						<NodeEventsDrawer
							rows={drawer}
							nodeName={model?.name}
							sel={sel}
							eventSel={eventSel}
							onPickEvent={setEventSel}
							open={drawerOpen}
							onToggleOpen={() => setDrawerOpen(!drawerOpen)}
							height={drawerH}
							openInLog={openInLog}
						/>
					) : undefined}
				</div>

				<ResizeHandle dir="h" onDelta={(d) => setInspectorW((w) => clampSize(w - d, 220, 640))} />
				<NodeInspector
					model={model}
					whyChain={whyChain}
					lastCaused={lastCaused}
					inspStack={inspStack}
					eventSel={eventSel}
					width={inspectorW}
					onPick={pick}
					openEventInLog={openEventInLog}
					getCopyMarkdown={() => (sel === undefined ? '' : nodeMarkdown(backend, sel))}
				/>
			</div>
		</>
	)
}
