import type { ReactNode } from 'react'
import type { LogRow } from './viewmodel.ts'
import { fmtId } from './viewmodel.ts'

/**
 * One event, rendered the same everywhere it's named: a color-coded kind chip,
 * the node it's about, and its dim #id. The chip color is the event's category
 * (the same one the log table and timeline use), so a single event reads
 * identically in the table, the causal spine, and the inspector — you can spot
 * "that's the same #20 compute" at a glance across the whole panel.
 *
 * `showName` is off where the surrounding context already is the node (e.g. the
 * inspector's own "last event" line, where the name would just repeat the node
 * being inspected).
 */
export function EventRef({ row, onClick, showName = true }: { row: LogRow; onClick?: () => void; showName?: boolean }) {
	const inner = (
		<>
			<span className={`chip ${row.cls}`}>{row.kind}</span>
			{showName && row.name !== null ? <span className="lname">{row.name}</span> : null}
			<span className="eid">{fmtId('event', row.id)}</span>
		</>
	)
	return onClick ? (
		<button className="evref" onClick={onClick}>
			{inner}
		</button>
	) : (
		<span className="evref">{inner}</span>
	)
}

/**
 * The "why this ran" causal thread, drawn identically in the graph inspector
 * and the log's causality panel. `chain` is root-first (as the backend resolves
 * it) and shown terminus-first: the event in question on top, each cause
 * beneath it, the user input at the bottom. `onPick` navigates to a chain entry
 * (the two views select it differently — a node in the graph, an entry in the
 * log). `renderExtra` decorates the terminus, e.g. the log's operation rollup.
 */
export function CauseSpine({
	chain,
	onPick,
	renderExtra,
}: {
	chain: LogRow[]
	onPick: (row: LogRow) => void
	renderExtra?: (terminus: LogRow) => ReactNode
}) {
	if (chain.length === 0) return <div className="sumline">no recorded activity yet</div>
	return (
		<ol className="spine">
			{[...chain].reverse().map((e, i) => (
				<li key={e.id} className={i === 0 ? 'terminus' : undefined}>
					<div className="knot" />
					<div className="ev">
						<EventRef row={e} onClick={() => onPick(e)} />
					</div>
					{e.summary ? <div className="because">{e.summary}</div> : null}
					{i === 0 && renderExtra ? renderExtra(e) : null}
				</li>
			))}
		</ol>
	)
}
