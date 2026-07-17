/**
 * The graph view's events drawer: the focused node's recent log entries.
 * Picking a row roots the inspector's "why this ran" chain at that event; the
 * coordinator (GraphView) owns the picked-event state and the row data.
 */
import type { EventId, NodeId } from '../protocol.ts'
import { fmtId, fmtTook, type LogRow } from './viewmodel.ts'

export function NodeEventsDrawer({
	rows,
	nodeName,
	sel,
	eventSel,
	onPickEvent,
	open,
	onToggleOpen,
	height,
	openInLog,
}: {
	rows: LogRow[]
	/** Display name of the node the entries belong to. */
	nodeName: string | undefined
	/** The inspected node, for the "Open in Log" jump. */
	sel: NodeId | undefined
	/** The drawer-picked event (highlighted row). */
	eventSel: EventId | undefined
	onPickEvent: (id: EventId) => void
	open: boolean
	onToggleOpen: () => void
	height: number
	openInLog: (id: NodeId) => void
}) {
	return (
		<section className="drawer" aria-label="Log entries for the focused node" style={open ? { height, maxHeight: height } : { maxHeight: 'none' }}>
			<div className="drawer-head">
				Log <span className="name">{nodeName}</span> · {rows.length} entries
				<span className="spacer" />
				<button onClick={() => sel !== undefined && openInLog(sel)}>Open in Log ↗</button>
				<button aria-expanded={open} onClick={onToggleOpen}>
					{open ? '▾ hide' : '▸ show'}
				</button>
			</div>
			{open ? (
			<table>
				<tbody>
					{rows.map((r) => (
						<tr
							key={r.id}
							className={r.id === eventSel ? 'selected' : undefined}
							aria-selected={r.id === eventSel}
							style={{ cursor: 'pointer' }}
							onClick={() => onPickEvent(r.id)}
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
					{rows.length === 0 ? (
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
	)
}
