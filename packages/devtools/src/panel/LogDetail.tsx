/**
 * The log's detail pane for one selected entry: what it is, the cause chain
 * that led to it, the app stack at the operation root, and the consequence
 * tree it produced. The coordinator (LogView) resolves all the rows; this
 * renders them and offers copy-as-markdown.
 */
import { useState } from 'react'
import type { NodeId, StackFrame } from '../protocol.ts'
import { fmtTook, type LogRow, type TreeRow } from './viewmodel.ts'
import { CauseSpine, EventRef } from './CauseSpine.tsx'
import { kindTip } from './kind-style.ts'
import { causalityMarkdown, copyText } from './markdown.ts'
import { StackTrace } from './StackTrace.tsx'

export function LogDetail({
	sel,
	spine,
	caused,
	opRoot,
	opEntries,
	opTotalUs,
	opStack,
	width,
	onSelect,
	inspect,
}: {
	/** The selected entry's row. */
	sel: LogRow
	/** Cause chain from the operation root to `sel`, root first. */
	spine: LogRow[]
	/** Consequence tree of `sel` (depth ≥ 1). */
	caused: TreeRow[]
	/** The operation root's row, for the "+Nms into the operation" line. */
	opRoot: LogRow | undefined
	/** Whole-operation rollup numbers. */
	opEntries: number
	opTotalUs: number
	/** App stack captured at the operation root, if any. */
	opStack: StackFrame[] | undefined
	width: number
	onSelect: (id: LogRow['id']) => void
	inspect: (id: NodeId) => void
}) {
	const [copied, setCopied] = useState(false)
	return (
		<aside className="causality" aria-label="Caused by" style={{ width }}>
			<div className="cz-head">
				<div className="cz-kicker">
					Selected entry
					<button
						className="srclink2"
						style={{ float: 'right' }}
						data-tip="Copy this event's cause chain and consequences as markdown — paste into a chat to explain why it happened."
						onClick={() => {
							void copyText(causalityMarkdown(spine, caused)).then((ok) => {
								setCopied(ok)
								if (ok) setTimeout(() => setCopied(false), 1200)
							})
						}}
					>
						⧉ {copied ? 'copied' : 'copy'}
					</button>
				</div>
				<div className="cz-title">
					<EventRef row={sel} />
				</div>
				<div className="cz-sub">
					+{((sel.t - (opRoot?.t ?? sel.t)) / 1000).toFixed(3)}ms into the operation
				</div>
				<div className="insp-desc">{kindTip(sel.kind)}</div>
			</div>
			<div className="cz-section">
				<h3 data-tip="The chain that led here, in stack-trace order: the selected entry on top, each cause beneath it, the user input at the bottom.">
					Caused by
				</h3>
				<CauseSpine
					chain={spine}
					onPick={(e) => onSelect(e.id)}
					renderExtra={(t) => (
						<div className="impact-card">
							whole operation: <b>{opEntries} entries</b>
							{opTotalUs > 0 ? <> · <b>{fmtTook(opTotalUs)}</b></> : undefined}
							<br />
							{t.node !== undefined ? (
								<button className="srclink" onClick={() => inspect(t.node!)}>
									view {t.name} in graph →
								</button>
							) : undefined}
						</div>
					)}
				/>
			</div>
			{opStack !== undefined ? <StackTrace frames={opStack} /> : undefined}
			{caused.length > 0 ? (
				<div className="cz-section">
					<h3 data-tip="Everything this entry caused, directly and transitively — its consequence tree.">What this caused · {caused.length}</h3>
					<ul className="caused-tree">
						{caused.map((t) => (
							<li key={t.row.id} style={{ paddingLeft: (t.depth - 1) * 14 }}>
								<EventRef row={t.row} onClick={() => onSelect(t.row.id)} />
							</li>
						))}
					</ul>
				</div>
			) : undefined}
		</aside>
	)
}
