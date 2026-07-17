import { useLayoutEffect, useRef, useState } from 'react'
import type { Backend, EventId, NodeId } from '../protocol.ts'
import { nodeDisplayName } from '../protocol.ts'
import { useBackend } from './store.ts'
import { PANEL_CSS } from './styles.ts'
import { ThemeDialog } from './ThemeDialog.tsx'
import { Tooltips } from './Tooltips.tsx'
import { GraphView } from './GraphView.tsx'
import { LogView } from './LogView.tsx'

/** A place you navigated to: a node in the graph, or an event in the log. The
 * back/forward history is one timeline of these across both views. */
type NavLoc = { tab: 'graph'; node: NodeId } | { tab: 'log'; event: EventId }

function sameLoc(a: NavLoc | undefined, b: NavLoc): boolean {
	if (a === undefined || a.tab !== b.tab) return false
	return a.tab === 'graph' && b.tab === 'graph'
		? a.node === b.node
		: a.tab === 'log' && b.tab === 'log'
			? a.event === b.event
			: false
}

/**
 * The devtools panel: chrome (brand · back/forward · Graph/Log tabs · theme ·
 * recording), then the active view. Navigation is global: inspecting a node,
 * opening an event in the log, or following a cross-view link all append to one
 * history, so back/forward retraces your path across both views.
 *
 * Standalone extras (dock toggle, close ✕) appear only when the host wires
 * them — an inline/overlay launcher does; the Chrome extension panel doesn't
 * (the browser owns docking and there's nothing to close).
 */
export function App({
	backend,
	dock,
	onToggleDock,
	onClose,
}: {
	backend: Backend
	dock?: 'right' | 'bottom'
	onToggleDock?: () => void
	onClose?: () => void
}) {
	const events = useBackend(backend) // re-render on each collector flush
	// Callback-ref → state so children (tooltips, theme) get the root element on
	// mount, not a frame late.
	const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null)
	const [tab, setTab] = useState<'graph' | 'log'>('graph')
	// Per-view selection (persists when you switch tabs) + one shared history.
	const [graphSel, setGraphSel] = useState<NodeId | undefined>(undefined)
	const [logSel, setLogSel] = useState<EventId | undefined>(undefined)
	const [logQuery, setLogQuery] = useState('')
	// Log tree/flat mode lives here so it survives switching to the graph and back
	// (LogView unmounts on tab change). Tree is the default — causality is the point.
	const [logMode, setLogMode] = useState<'flat' | 'tree'>('tree')
	const [nav, setNav] = useState<{ trail: NavLoc[]; at: number }>({ trail: [], at: -1 })
	const [themeOpen, setThemeOpen] = useState(false)

	// Point a view at a location. Never re-records when a view reports the
	// location it's already on, so a prop-driven selection (a back/forward move)
	// can't feed back into the history.
	const apply = (loc: NavLoc) => {
		setTab(loc.tab)
		if (loc.tab === 'graph') setGraphSel(loc.node)
		else setLogSel(loc.event)
	}
	// The location the views were last pointed at. navigate() applies directly
	// (its target is its argument, so there is nothing stale to read); go() only
	// moves nav.at, and the effect below applies the location that move landed
	// on. Tracking the applied location here keeps the effect from re-applying
	// what navigate() already did.
	const appliedRef = useRef<NavLoc | undefined>(undefined)
	const navigate = (loc: NavLoc) => {
		setNav((n) => {
			if (sameLoc(n.trail[n.at], loc)) return n
			const trail = [...n.trail.slice(0, n.at + 1), loc].slice(-30)
			return { trail, at: trail.length - 1 }
		})
		appliedRef.current = loc
		apply(loc)
	}
	// go() computes the new index inside the updater, so two clicks batched
	// into one frame each advance from the other's result instead of both
	// reading the same render-scope nav and moving one step total.
	const go = (delta: number) => {
		setNav((n) => {
			const at = n.at + delta
			return at < 0 || at >= n.trail.length ? n : { ...n, at }
		})
	}
	// Apply the location a go() move landed on. Applying is a side effect
	// (it sets other state), so it can't run inside the setNav updater; this
	// effect sees the settled nav after all batched moves. A layout effect, so
	// the view switches before the browser paints the moved history state.
	// Trail entries keep their identity, so a location navigate() just applied
	// is skipped by reference.
	useLayoutEffect(() => {
		const loc = nav.trail[nav.at]
		if (loc === undefined || loc === appliedRef.current) return
		appliedRef.current = loc
		apply(loc)
	}, [nav])

	// Open a node in the graph / an event in the log. Used by both the views'
	// own selections and the cross-view links (a log row's "view in graph", a
	// graph spine entry's jump to its log row).
	const openNode = (id: NodeId) => navigate({ tab: 'graph', node: id })
	const openEvent = (eventId: EventId) => navigate({ tab: 'log', event: eventId })
	// "Open in Log" pre-populates the visible search filter with the node's name
	// — a filter action, not a single-target jump, so it doesn't join the history.
	const openInLog = (id: NodeId) => {
		const n = backend.node(id)
		setLogQuery(`name:${n === undefined ? `node#${id}` : nodeDisplayName(n)}`)
		setTab('log')
	}

	return (
		<div className="signals-devtools-root" ref={setRootEl}>
			<style>{PANEL_CSS}</style>
			<header className="chrome">
				<div className="brand">
					<span className="dot" />
					Signals
				</div>
				<span className="histnav" role="group" aria-label="Navigate history">
					<button className="theme-btn" data-tip="Back to the previous place you looked." aria-label="Back" disabled={nav.at <= 0} onClick={() => go(-1)}>
						◀
					</button>
					<button className="theme-btn" data-tip="Forward." aria-label="Forward" disabled={nav.at >= nav.trail.length - 1} onClick={() => go(1)}>
						▶
					</button>
				</span>
				<nav className="tabs">
					<button className="tab" aria-current={tab === 'graph' ? 'page' : undefined} onClick={() => setTab('graph')}>
						Graph
					</button>
					<button className="tab" aria-current={tab === 'log' ? 'page' : undefined} onClick={() => setTab('log')}>
						Log
					</button>
				</nav>
				<div className="spacer" />
				{onToggleDock ? (
					<button className="theme-btn" data-tip="Dock the panel to the side or the bottom." onClick={onToggleDock}>
						{dock === 'bottom' ? '⇥ side' : '⤓ bottom'}
					</button>
				) : undefined}
				<button className="theme-btn" onClick={() => setThemeOpen(true)}>
					Theme
				</button>
				<div className="rec">
					<span className="pulse" />
					recording · {events.toLocaleString()} entries
				</div>
				{onClose ? (
					<button className="theme-btn" aria-label="Close devtools" style={{ marginLeft: 8 }} onClick={onClose}>
						✕
					</button>
				) : undefined}
			</header>

			{tab === 'graph' ? (
				<GraphView backend={backend} selected={graphSel} onSelect={openNode} openInLog={openInLog} openEventInLog={openEvent} />
			) : (
				<LogView backend={backend} query={logQuery} setQuery={setLogQuery} inspect={openNode} selected={logSel} onSelect={openEvent} mode={logMode} setMode={setLogMode} />
			)}

			<ThemeDialog open={themeOpen} onClose={() => setThemeOpen(false)} root={rootEl} />
			<Tooltips root={rootEl} />
		</div>
	)
}
