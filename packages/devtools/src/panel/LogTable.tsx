/**
 * The log table: flat (newest first) or nested under causes (tree mode), with
 * per-row kind chips, cause jumps, and collapse carets on operation roots.
 * Selection is reported up; the coordinator (LogView) owns the row data and
 * the collapsed set.
 */
import { useEffect, useRef } from 'react'
import type { EventId, NodeId } from '../protocol.ts'
import { fmtDelta, fmtId, fmtTook, type Guide, type LogRow, type TreeRow } from './viewmodel.ts'
import { kindTip } from './kind-style.ts'

function Guides({ guides }: { guides: Guide[] }) {
	return (
		<>
			{guides.map((g, i) => (
				// eslint-disable-next-line react/no-array-index-key -- fixed-length per row
				<span key={i} className={`g ${g === 'none' ? '' : g}`} />
			))}
		</>
	)
}

function NameCell({
	row,
	onCause,
	onNode,
}: {
	row: LogRow
	onCause: () => void
	onNode: (id: NodeId) => void
}) {
	const nodeId = row.node
	// The whole row selects (the <tr> handles the click); the cause ref is the
	// one secondary action, so it stops propagation and jumps instead.
	const cause = row.cause > 0 ? (
		<button className="causeref" onClick={(e) => { e.stopPropagation(); onCause() }}>
			⤷{fmtId('event', row.cause)}
		</button>
	) : undefined
	const name =
		row.name === undefined ? (
			<span style={{ color: 'var(--faint)' }}>—</span>
		) : (
			<>
				<span className="lname">{row.name}</span>
				{nodeId !== undefined ? (
					<button className="nid" onClick={(e) => { e.stopPropagation(); onNode(nodeId) }}>
						{fmtId('node', nodeId)}
					</button>
				) : undefined}
			</>
		)
	return (
		<td className="name">
			{name}
			{cause}
		</td>
	)
}

export function LogTable({
	mode,
	rows,
	treeRows,
	selected,
	onSelect,
	collapsed,
	toggleCollapsed,
	flashing,
	opRollup,
	inspect,
	emptyHint,
}: {
	mode: 'flat' | 'tree'
	/** Filtered entries, chronological; flat mode reverses for display. */
	rows: LogRow[]
	/** Nested rows for tree mode; undefined in flat mode. */
	treeRows: TreeRow[] | undefined
	selected: EventId | undefined
	onSelect: (id: EventId) => void
	collapsed: ReadonlySet<EventId>
	toggleCollapsed: (id: EventId) => void
	/** Ids that should carry the arrival flash this render. */
	flashing: ReadonlySet<EventId>
	/** One-line rollup for an operation-root row; undefined for other rows. */
	opRollup: (id: EventId) => string | undefined
	inspect: (id: NodeId) => void
	/** Empty-table message ("no entries yet" / "…match the filter"). */
	emptyHint: string
}) {
	const selRowRef = useRef<HTMLTableRowElement | null>(null)

	// Scroll the selected entry into view after following a link or jump-to-cause,
	// but not when the user directly clicked a row here — a click's selection is
	// already where they're looking, and scrolling it mid-gesture would swallow
	// the double-click-to-collapse. clickSelectRef distinguishes the two sources.
	// In a rAF because when a link switches to the log this component just mounted
	// and the rows aren't laid out yet when the effect first fires.
	const clickSelectRef = useRef(false)
	// Native onDoubleClick is unreliable here: the first click changes `selected`,
	// which re-renders the table before the second click, so the browser never
	// resolves the pair into a dblclick. Detect it ourselves from the onClick that
	// always fires — two clicks on the same collapsible row within the OS-typical
	// 500ms double-click window toggle it.
	const lastClickRef = useRef<{ id: EventId; t: number } | undefined>(undefined)
	useEffect(() => {
		if (selected === undefined) return
		if (clickSelectRef.current) {
			clickSelectRef.current = false
			return
		}
		const raf = requestAnimationFrame(() => selRowRef.current?.scrollIntoView({ block: 'nearest' }))
		return () => cancelAnimationFrame(raf)
	}, [selected])

	return (
		<div className={`log ${mode}`} role="region" aria-label="Log">
			<table>
				<thead>
					<tr>
						<th>#</th>
						<th data-tip="When this happened — time since recording started.">when</th>
						<th data-tip="What happened. Chips are colored by category.">kind</th>
						<th data-tip="The node this event is about.">name</th>
						<th data-tip="What came of it, in plain words.">outcome</th>
						<th style={{ textAlign: 'right' }}>took</th>
					</tr>
				</thead>
				<tbody>
					{mode === 'flat'
						? [...rows].reverse().map((r) => (
								<tr
									key={r.id}
									ref={r.id === selected ? selRowRef : undefined}
									className={`${r.id === selected ? 'selected' : ''}${flashing.has(r.id) ? ' flash' : ''}`.trim() || undefined}
									aria-selected={r.id === selected}
									onClick={() => {
										clickSelectRef.current = true
										onSelect(r.id)
									}}
								>
									<td className="id">{fmtId('event', r.id)}</td>
									<td className="t">
										{r.time}
										{r.delta !== undefined ? <span className="tdelta"> {fmtDelta(r.delta)}</span> : undefined}
									</td>
									<td>
										<span className={`chip ${r.cls}`} data-tip={kindTip(r.kind)}>{r.kind}</span>
									</td>
									<NameCell row={r} onCause={() => onSelect(r.cause)} onNode={inspect} />
									<td className="data">{r.summary}</td>
									<td className="took">{fmtTook(r.took)}</td>
								</tr>
							))
						: treeRows!.map((t) => (
								<tr
									key={t.row.id}
									ref={t.row.id === selected ? selRowRef : undefined}
									className={`${t.op % 2 === 1 ? 'op-alt ' : ''}${t.depth === 0 && t.children > 0 ? 'op-head ' : ''}${t.row.id === selected ? 'selected ' : ''}${flashing.has(t.row.id) ? 'flash' : ''}`.trim() || undefined}
									aria-selected={t.row.id === selected}
									onClick={() => {
										const now = Date.now()
										const prev = lastClickRef.current
										if (t.children > 0 && prev && prev.id === t.row.id && now - prev.t < 500) {
											toggleCollapsed(t.row.id)
											lastClickRef.current = undefined
											return
										}
										lastClickRef.current = { id: t.row.id, t: now }
										clickSelectRef.current = true
										onSelect(t.row.id)
									}}
								>
									<td className="id">
										<span className="treecell">
											<Guides guides={t.guides} />
											{t.children > 0 ? (
												<button
													className="caret"
													aria-label={collapsed.has(t.row.id) ? 'Expand' : 'Collapse'}
													onClick={(e) => {
														e.stopPropagation()
														toggleCollapsed(t.row.id)
													}}
												>
													{collapsed.has(t.row.id) ? '▸' : '▾'}
												</button>
											) : (
												<span className="caret-spacer" />
											)}
											<span className="lid">{fmtId('event', t.row.id)}</span>
										</span>
									</td>
									<td className="t">
										{t.row.time}
										{t.row.delta !== undefined ? <span className="tdelta"> {fmtDelta(t.row.delta)}</span> : undefined}
									</td>
									<td>
										<span className={`chip ${t.row.cls}`} data-tip={kindTip(t.row.kind)}>{t.row.kind}</span>
									</td>
									<NameCell row={t.row} onCause={() => onSelect(t.row.cause)} onNode={inspect} />
									<td className="data">
										{t.depth === 0 && t.children > 0 ? (
											<span className="op-rollup">{opRollup(t.row.id) ?? t.row.summary}</span>
										) : (
											t.row.summary
										)}
									</td>
									<td className="took">{fmtTook(t.row.took)}</td>
								</tr>
							))}
					{rows.length === 0 ? (
						<tr>
							<td className="data" colSpan={6} style={{ color: 'var(--faint)', fontStyle: 'italic' }}>
								{emptyHint}
							</td>
						</tr>
					) : undefined}
				</tbody>
			</table>
		</div>
	)
}
