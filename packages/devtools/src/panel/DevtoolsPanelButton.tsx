import { lazy, Suspense, useRef, useState } from 'react'
import type { Backend } from '../protocol.ts'

/**
 * The devtools' inline entry point: a small floating button that opens the
 * panel in an overlay. The heavy panel (views, stylesheet, layout) is code-
 * split and loaded with React.lazy only when first opened — a shimmer shows
 * while it arrives — so a host page that never opens the devtools pays only
 * for this button.
 *
 * The button docks to the nearest screen edge and can be dragged along it
 * (defaults to the bottom-right). The overlay pane docks right or bottom and
 * drag-resizes at its inner edge; the panel inside gets its own close (✕) and
 * dock toggle. Everything here is inline-styled so the button needs none of
 * the panel's (lazy) stylesheet.
 */
const Panel = lazy(() => import('./App.tsx').then((m) => ({ default: m.App })))

export type Corner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'
const BTN_W = 140
const BTN_H = 30
const EDGE = 12

function cornerPos(corner: Corner): { x: number; y: number } {
	const right = window.innerWidth - BTN_W - EDGE
	const bottom = window.innerHeight - BTN_H - EDGE
	return {
		x: corner.endsWith('right') ? right : EDGE,
		y: corner.startsWith('bottom') ? bottom : EDGE,
	}
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** Snap a button top-left to the nearest screen edge, clamped along it. */
function snap(x: number, y: number): { x: number; y: number } {
	const W = window.innerWidth
	const H = window.innerHeight
	const dl = x
	const dr = W - (x + BTN_W)
	const dt = y
	const db = H - (y + BTN_H)
	if (Math.min(dl, dr) <= Math.min(dt, db)) {
		return { x: dl < dr ? EDGE : W - BTN_W - EDGE, y: clamp(y, EDGE, H - BTN_H - EDGE) }
	}
	return { x: clamp(x, EDGE, W - BTN_W - EDGE), y: dt < db ? EDGE : H - BTN_H - EDGE }
}

function Shimmer({ dock }: { dock: 'right' | 'bottom' }) {
	return (
		<div style={{ position: 'absolute', inset: 0, background: '#191919', display: 'grid', placeItems: 'center' }}>
			<style>{'@keyframes signals-devtools-shimmer{50%{opacity:.35}}'}</style>
			<div style={{ font: '12px system-ui, sans-serif', color: '#a19e99', animation: 'signals-devtools-shimmer 1.2s ease-in-out infinite' }}>
				loading signals devtools · {dock === 'bottom' ? 'bottom' : 'side'}…
			</div>
		</div>
	)
}

export function DevtoolsPanelButton({
	backend,
	defaultCorner = 'bottom-right',
	defaultOpen = false,
	label = '⚙ signals',
}: {
	backend: Backend
	defaultCorner?: Corner
	defaultOpen?: boolean
	label?: string
}) {
	const [open, setOpen] = useState(defaultOpen)
	const [dock, setDock] = useState<'right' | 'bottom'>('right')
	const [size, setSize] = useState(() => Math.round(window.innerWidth * 0.46))
	const [pos, setPos] = useState(() => cornerPos(defaultCorner))
	const drag = useRef<{ gx: number; gy: number; moved: boolean } | null>(null)

	const overlay =
		dock === 'right'
			? { top: 0, right: 0, height: '100vh', width: size }
			: { left: 0, right: 0, bottom: 0, height: size }

	return (
		<>
			<button
				aria-label="Toggle signals devtools"
				onPointerDown={(e) => {
					drag.current = { gx: e.clientX - pos.x, gy: e.clientY - pos.y, moved: false }
					e.currentTarget.setPointerCapture(e.pointerId)
				}}
				onPointerMove={(e) => {
					const d = drag.current
					if (d === null) return
					if (Math.abs(e.clientX - (d.gx + pos.x)) + Math.abs(e.clientY - (d.gy + pos.y)) > 3) d.moved = true
					setPos(snap(e.clientX - d.gx, e.clientY - d.gy))
				}}
				onPointerUp={(e) => {
					const d = drag.current
					drag.current = null
					e.currentTarget.releasePointerCapture(e.pointerId)
					if (d !== null && !d.moved) setOpen((o) => !o)
				}}
				style={{
					position: 'fixed',
					left: pos.x,
					top: pos.y,
					width: BTN_W,
					height: BTN_H,
					zIndex: 2147483001,
					padding: '0 12px',
					font: '12px system-ui, sans-serif',
					background: '#1c2028',
					color: '#d6dbe4',
					border: '1px solid #2b313d',
					borderRadius: 6,
					cursor: drag.current?.moved ? 'grabbing' : 'pointer',
					touchAction: 'none',
				}}
			>
				{open ? '✕ signals' : label}
			</button>

			{open ? (
				<div
					style={{
						position: 'fixed',
						...overlay,
						zIndex: 2147483000,
						boxShadow: dock === 'right' ? '-2px 0 16px rgba(0,0,0,.5)' : '0 -2px 16px rgba(0,0,0,.5)',
					}}
				>
					<Grip dock={dock} onResize={(delta) => setSize((s) => clamp(s + delta, 280, (dock === 'right' ? window.innerWidth : window.innerHeight) - 80))} />
					<div style={{ position: 'absolute', inset: 0 }}>
						<Suspense fallback={<Shimmer dock={dock} />}>
							<Panel
								backend={backend}
								dock={dock}
								onToggleDock={() => setDock((x) => (x === 'right' ? 'bottom' : 'right'))}
								onClose={() => setOpen(false)}
							/>
						</Suspense>
					</div>
				</div>
			) : null}
		</>
	)
}

/** Inner-edge resize grip for the overlay pane (inline-styled; no panel CSS). */
function Grip({ dock, onResize }: { dock: 'right' | 'bottom'; onResize: (delta: number) => void }) {
	const last = useRef<number | null>(null)
	return (
		<div
			role="separator"
			onPointerDown={(e) => {
				last.current = dock === 'right' ? e.clientX : e.clientY
				e.currentTarget.setPointerCapture(e.pointerId)
			}}
			onPointerMove={(e) => {
				if (last.current === null) return
				const cur = dock === 'right' ? e.clientX : e.clientY
				// Inner edge: dragging toward the page grows the pane.
				onResize(dock === 'right' ? last.current - cur : last.current - cur)
				last.current = cur
			}}
			onPointerUp={(e) => {
				last.current = null
				e.currentTarget.releasePointerCapture(e.pointerId)
			}}
			style={{
				position: 'absolute',
				zIndex: 1,
				...(dock === 'right'
					? { left: 0, top: 0, bottom: 0, width: 6, cursor: 'col-resize' }
					: { top: 0, left: 0, right: 0, height: 6, cursor: 'row-resize' }),
			}}
		/>
	)
}
