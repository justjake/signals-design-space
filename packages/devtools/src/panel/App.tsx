import { useState } from 'react'
import type { Backend } from '../protocol.ts'
import { useBackend } from './store.ts'
import { PANEL_CSS } from './styles.ts'
import { ThemeDialog } from './ThemeDialog.tsx'
import { Tooltips } from './Tooltips.tsx'
import { GraphView } from './GraphView.tsx'
import { LogView } from './LogView.tsx'

/**
 * The devtools panel: chrome (brand · Graph/Log tabs · theme · recording),
 * then the active view. Selecting a node anywhere focuses the Graph tab on it;
 * a node's "Open in Log" jumps to the Log filtered to it.
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
	const [focus, setFocus] = useState<number | null>(null)
	const [logQuery, setLogQuery] = useState('')
	const [themeOpen, setThemeOpen] = useState(false)

	const inspect = (id: number) => {
		setFocus(id)
		setTab('graph')
	}
	// "Open in Log" pre-populates the visible search filter with the node's name
	// — no hidden per-node state; it's the log, filtered, and you can see and
	// clear the filter.
	const openInLog = (id: number) => {
		const n = backend.node(id)
		setLogQuery(`name:${n?.label ?? `${n?.kind ?? 'node'}#${id}`}`)
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
				) : null}
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
				) : null}
			</header>

			{tab === 'graph' ? (
				<GraphView backend={backend} focus={focus} setFocus={setFocus} openInLog={openInLog} />
			) : (
				<LogView backend={backend} query={logQuery} setQuery={setLogQuery} inspect={inspect} />
			)}

			<ThemeDialog open={themeOpen} onClose={() => setThemeOpen(false)} root={rootEl} />
			<Tooltips root={rootEl} />
		</div>
	)
}
