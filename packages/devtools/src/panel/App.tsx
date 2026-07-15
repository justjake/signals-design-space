import { useRef, useState } from 'react'
import type { Backend } from '../protocol.ts'
import { useBackend } from './store.ts'
import { PANEL_CSS } from './styles.ts'
import { ThemeDialog } from './ThemeDialog.tsx'
import { GraphView } from './GraphView.tsx'
import { LogView } from './LogView.tsx'

/**
 * The devtools panel: chrome (brand · Graph/Log tabs · theme · recording),
 * then the active view. Selecting a node anywhere focuses the Graph tab on it;
 * a node's "Open in Log" jumps to the Log filtered to it.
 */
export function App({ backend }: { backend: Backend }) {
	const events = useBackend(backend) // re-render on each collector flush
	const rootRef = useRef<HTMLDivElement>(null)
	const [tab, setTab] = useState<'graph' | 'log'>('graph')
	const [focus, setFocus] = useState<number | null>(null)
	const [logNode, setLogNode] = useState<number | null>(null)
	const [themeOpen, setThemeOpen] = useState(false)

	const inspect = (id: number) => {
		setFocus(id)
		setTab('graph')
	}
	const openInLog = (id: number) => {
		setLogNode(id)
		setTab('log')
	}

	return (
		<div className="signals-devtools-root" ref={rootRef}>
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
				<button className="theme-btn" onClick={() => setThemeOpen(true)}>
					Theme
				</button>
				<div className="rec">
					<span className="pulse" />
					recording · {events.toLocaleString()} entries
				</div>
			</header>

			{tab === 'graph' ? (
				<GraphView backend={backend} focus={focus} setFocus={setFocus} openInLog={openInLog} />
			) : (
				<LogView backend={backend} node={logNode} setNode={setLogNode} inspect={inspect} />
			)}

			<ThemeDialog open={themeOpen} onClose={() => setThemeOpen(false)} root={rootRef.current} />
		</div>
	)
}
