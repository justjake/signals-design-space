import { useEffect, useMemo, useRef, useState } from 'react'
import type { Backend, EventId, KindClass, NodeId } from '../protocol.ts'
import { causedTree, causeRows, fmtDelta, fmtId, fmtTook, type Guide, type LogRow, logRows, logTree } from './viewmodel.ts'
import { CauseSpine, EventRef } from './CauseSpine.tsx'
import { copyText, logMarkdown } from './markdown.ts'
import { clampSize, ResizeHandle } from './ResizeHandle.tsx'
import { StackTrace } from './StackTrace.tsx'

const LIMIT = 1000

/**
 * Filter chips. Each toggles the kind-classes it names; origin/error/batch/
 * async are structural and always shown. Internals (bookkeeping) is off by
 * default. Hot is off by default too, and it is more than a filter: it also
 * switches the engine's hot channel on and off (nothing is recorded while
 * it's off — that channel is zero-cost when disabled).
 */
const CHIPS: { key: string; label: string; sw: string; classes: KindClass[]; tip: string }[] = [
	{ key: 'write', label: 'set/update', sw: 'var(--atom)', classes: ['write'], tip: 'Changes to atoms: set (assigned a value) and update (computed from the previous value) — where every change starts.' },
	{ key: 'compute', label: 'recompute', sw: 'var(--computed)', classes: ['compute'], tip: 'Recompute: a computed re-ran its function.' },
	{ key: 'render', label: 'render', sw: 'var(--watcher)', classes: ['notify', 'render'], tip: 'Rendering: notify (a watcher was told its inputs changed) and render (a render pass, start to commit).' },
	{ key: 'effect', label: 'effect', sw: 'var(--effect)', classes: ['effect'], tip: 'Effects — code that runs after changes commit: effect() (library) and useSignalEffect (component).' },
	{ key: 'internals', label: 'internals', sw: 'var(--system)', classes: ['system'], tip: 'Library bookkeeping with no user intent behind it. Off by default. Batch begins and transitions stay visible — they are structure, not noise.' },
	{ key: 'hot', label: 'hot', sw: 'var(--hot)', classes: ['hot'], tip: 'The engine\'s internal steps, recorded only while this is on: propagate (a change marks what it reaches stale), check (a read confirms whether inputs really changed), pull (a stale computed re-evaluates). Very high volume; off by default.' },
]
const ALWAYS_ON: KindClass[] = ['origin', 'error', 'batch', 'async']

/** Per-kind tooltip text for the row chips. Unknown kinds fall back to a
 * generic error/verbatim hint so a future kind still explains itself. */
const KIND_TIPS: Record<string, string> = {
	'dom-event': 'The DOM event that started this operation.',
	set: 'atom.set(value): the atom was assigned a new value.',
	update: 'atom.update(fn): the atom was computed from its previous value.',
	compute: 'A computed re-ran its function because an input changed.',
	effect: 'An effect ran after changes committed.',
	notify: 'A watcher was told its inputs changed (re-render scheduled).',
	render: 'A component rendered a committed value.',
	settle: 'An awaited async value resolved.',
	retry: 'A suspended computation retried after its await resolved.',
	'compute-suspend': 'A recompute paused awaiting a Promise.',
	'transition-open': 'A transition began; its updates render in the background.',
	'transition-commit': 'A transition committed to the UI.',
	'transition-retire': 'A committed transition folded into base state.',
	'transition-discard': 'A transition was abandoned.',
	propagate: 'Hot step: a change pushed "possibly stale" marks down to its subscribers.',
	check: 'Hot step: a read walked dependencies to confirm whether anything really changed.',
	pull: 'Hot step: a stale computed or effect computation re-evaluated.',
}
function kindTip(kind: string): string {
	return KIND_TIPS[kind] ?? (kind.endsWith('-error') ? 'This step threw an error.' : kind)
}

function matchesSearch(r: LogRow, query: string): boolean {
	if (query === '') return true
	const name = (r.name ?? '').toLowerCase()
	let ok = true
	for (const tok of query.toLowerCase().split(/\s+/).filter(Boolean)) {
		if (tok.startsWith('kind:')) ok &&= r.kind.toLowerCase().includes(tok.slice(5))
		else if (tok.startsWith('name:')) ok &&= name.includes(tok.slice(5))
		else ok &&= r.kind.toLowerCase().includes(tok) || name.includes(tok)
	}
	return ok
}

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

export function LogView({
	backend,
	query,
	setQuery,
	inspect,
	selected,
	onSelect,
}: {
	backend: Backend
	query: string
	setQuery: (q: string) => void
	inspect: (id: NodeId) => void
	/** The selected event, owned by App (drives the global nav history). */
	selected: EventId | undefined
	/** Report a user selection so App records it and updates `selected`. */
	onSelect: (id: EventId) => void
}) {
	const [mode, setMode] = useState<'flat' | 'tree'>('flat')
	// Hot mirrors the backend's channel state so a remounted panel shows the truth.
	const [on, setOn] = useState<Record<string, boolean>>(() => ({ write: true, compute: true, render: true, effect: true, internals: false, hot: backend.hotMode?.() ?? false }))
	const [paused, setPaused] = useState<LogRow[] | undefined>(undefined)
	const [floor, setFloor] = useState(0)
	const [collapsed, setCollapsed] = useState<ReadonlySet<EventId>>(() => new Set())
	const [copied, setCopied] = useState(false)
	const [czW, setCzW] = useState(320)
	// Timeline brush: [t0, t1] in µs, or undefined for the full window.
	const [brush, setBrush] = useState<[number, number] | undefined>(undefined)
	const tlRef = useRef<SVGSVGElement | null>(null)
	const brushing = useRef<number | undefined>(undefined)
	const selRowRef = useRef<HTMLTableRowElement | null>(null)

	// Scroll the selected entry into view (e.g. after a jump-to-cause).
	useEffect(() => {
		selRowRef.current?.scrollIntoView({ block: 'nearest' })
	}, [selected])

	// Esc clears the timeline window (a click on the strip clears it too).
	useEffect(() => {
		if (brush === undefined) return
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setBrush(undefined)
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [brush])

	const classes = useMemo(() => {
		const set = new Set<KindClass>(ALWAYS_ON)
		for (const c of CHIPS) if (on[c.key]) for (const k of c.classes) set.add(k)
		return [...set]
	}, [on])

	const live = logRows(backend, { classes }, LIMIT)
	const base = (paused ?? live).filter((r) => r.id > floor)
	const rows = base.filter(
		(r) => matchesSearch(r, query) && (brush === undefined || (r.t >= brush[0] && r.t <= brush[1])),
	)

	// Flash a row only when its event genuinely arrives — never on a view or
	// filter switch, which re-render or remount existing rows. A high-water mark
	// of the largest event id seen baselines on the first commit (no flash for
	// the initial fill); later commits flash only ids above it.
	const seenMax = useRef<EventId | undefined>(undefined)
	const [flashing, setFlashing] = useState<ReadonlySet<EventId>>(() => new Set())
	useEffect(() => {
		let max = seenMax.current ?? (0 as EventId)
		const fresh: EventId[] = []
		for (const r of rows) {
			if (seenMax.current !== undefined && r.id > seenMax.current) fresh.push(r.id)
			if (r.id > max) max = r.id
		}
		seenMax.current = max
		if (fresh.length === 0) return
		setFlashing((f) => new Set([...f, ...fresh]))
		const t = setTimeout(() => setFlashing((f) => {
			const n = new Set(f)
			for (const id of fresh) n.delete(id)
			return n
		}), 800)
		return () => clearTimeout(t)
	})

	// Tree mode: resolve any cause referenced but outside the visible window
	// (still in the ring) and prepend its ancestry, so rows nest under the real
	// event instead of orphaning. Then nest, honoring the collapsed set.
	let treeInput = rows
	if (mode === 'tree') {
		const inWindow = new Set(rows.map((r) => r.id))
		const extra = new Map<EventId, LogRow>()
		for (const r of rows) {
			if (r.cause > 0 && !inWindow.has(r.cause) && !extra.has(r.cause)) {
				for (const anc of causeRows(backend, r.cause)) if (!inWindow.has(anc.id)) extra.set(anc.id, anc)
			}
		}
		if (extra.size > 0) treeInput = [...extra.values(), ...rows]
	}
	const tree = mode === 'tree' ? logTree(treeInput, collapsed) : undefined
	const treeRows = tree
	const toggleCollapsed = (id: EventId) =>
		setCollapsed((prev) => {
			const next = new Set(prev)
			if (next.has(id)) next.delete(id)
			else next.add(id)
			return next
		})

	// Group entries by operation root in one pass, following cause pointers
	// within the shown set. Drives the timeline spans and the op entry count —
	// without walking a cause chain per row.
	const byId = new Map(base.map((r) => [r.id, r]))
	const rootMemo = new Map<EventId, EventId>()
	const rootOf = (id: EventId): EventId => {
		const seen: EventId[] = []
		let cur = id
		for (;;) {
			const memo = rootMemo.get(cur)
			if (memo !== undefined) { cur = memo; break }
			const r = byId.get(cur)
			if (r === undefined || r.cause === 0 || !byId.has(r.cause)) break
			seen.push(cur)
			cur = r.cause
		}
		for (const s of seen) rootMemo.set(s, cur)
		return cur
	}
	const ops = new Map<EventId, { minT: number; maxT: number; count: number; renders: number; us: number }>()
	for (const r of base) {
		const root = rootOf(r.id)
		const took = r.took ?? 0
		const isRender = r.kind === 'render'
		const g = ops.get(root)
		if (g === undefined) ops.set(root, { minT: r.t, maxT: r.t, count: 1, renders: isRender ? 1 : 0, us: took })
		else {
			g.maxT = r.t
			g.count++
			if (isRender) g.renders++
			g.us += took
		}
	}
	// One-line rollup for an operation-root row: the "how big was this tree"
	// glance the log tree exists to give. Undefined for non-root rows.
	const opRollup = (id: EventId): string | undefined => {
		const g = ops.get(id)
		if (g === undefined) return undefined
		const parts = [`${g.count} ${g.count === 1 ? 'entry' : 'entries'}`]
		if (g.renders > 0) parts.push(`${g.renders} rendered`)
		if (g.maxT > g.minT) parts.push(fmtTook(g.maxT - g.minT))
		return parts.join(' · ')
	}

	const minT = base.length ? base[0].t : 0
	const span = Math.max(1, (base.length ? base[base.length - 1].t : 1) - minT)
	const x = (t: number) => 40 + ((t - minT) / span) * 1120
	// Inverse of x: a client x-coordinate on the timeline → a time (µs), clamped.
	const tAt = (clientX: number): number => {
		const el = tlRef.current
		if (el === null) return minT
		const r = el.getBoundingClientRect()
		const sx = ((clientX - r.left) / r.width) * 1200
		return Math.max(minT, Math.min(minT + span, minT + ((sx - 40) / 1120) * span))
	}

	// The cause chain resolves from the backend, so a selected entry outside the
	// visible window (e.g. jumped-to via ⤷) still shows — its own entry is the
	// chain's last element.
	const spine = selected === undefined ? [] : causeRows(backend, selected)
	const sel = selected === undefined ? undefined : (rows.find((r) => r.id === selected) ?? spine[spine.length - 1] ?? undefined)
	const opRoot = spine[0] ?? sel
	const opGroup = sel === undefined ? undefined : ops.get(rootOf(sel.id))
	const opEntries = opGroup?.count ?? (sel === undefined ? 0 : 1)
	// Total wall time the whole operation spanned (root → last consequence) — the
	// "how big was this tree" number you trace back from a slow update.
	const opTotalUs = opGroup ? opGroup.maxT - opGroup.minT : 0
	// The consequence tree of the selected entry: everything it caused, directly
	// and transitively, within the window, nested (bounded for huge fan-outs).
	// logTree roots it at sel and orders siblings newest-first; we show depth ≥ 1.
	const caused = sel === undefined ? [] : causedTree(base, sel.id)
	// The app stack captured at the operation root (the first chain entry with one).
	const opStack = spine.find((e) => e.stack !== undefined)?.stack ?? undefined

	const copy = () => {
		void copyText(logMarkdown(rows)).then((ok) => {
			setCopied(ok)
			if (ok) setTimeout(() => setCopied(false), 1200)
		})
	}

	return (
		<>
			<div className="controls">
				<button
					className="tbtn"
					aria-pressed={paused !== undefined}
					style={{ minWidth: 84, textAlign: 'left' }}
					onClick={() => setPaused(paused === undefined ? live : undefined)}
				>
					{paused === undefined ? '⏸ Pause' : '▶ Resume'}
				</button>
				<button className="tbtn" onClick={() => setFloor(live.length ? live[live.length - 1].id : 0)}>
					Clear
				</button>
				<span role="group" aria-label="Ordering" style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
					<button className="tbtn mode" aria-pressed={mode === 'tree'} onClick={() => setMode('tree')}>
						Tree
					</button>
					<button className="tbtn mode" aria-pressed={mode === 'flat'} onClick={() => setMode('flat')}>
						Flat
					</button>
				</span>
				{mode === 'tree' ? (
					<button
						className="tbtn"
						aria-pressed={collapsed.size > 0}
						onClick={() =>
							setCollapsed((prev) => {
								if (prev.size > 0) return new Set()
								const next = new Set<EventId>()
								for (const t of tree ?? []) if (t.depth === 0 && t.children > 0) next.add(t.row.id)
								return next
							})
						}
					>
						{collapsed.size > 0 ? 'Expand all' : 'Collapse to roots'}
					</button>
				) : undefined}
				<input
					className="search"
					type="search"
					placeholder="filter… kind:set name:todos"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
				<div className="kind-filters" role="group" aria-label="Entry kinds">
					{CHIPS.map((c) => (
						<button
							key={c.key}
							className={`kchip ${on[c.key] ? 'on' : ''}`}
							data-tip={c.tip}
							aria-pressed={on[c.key]}
							onClick={() => {
								const next = !on[c.key]
								// The hot chip drives the engine channel, not just the filter.
								if (c.key === 'hot') backend.setHotMode?.(next)
								setOn({ ...on, [c.key]: next })
							}}
						>
							<span className="sw" style={{ background: c.sw }} />
							{c.label}
						</button>
					))}
				</div>
				<div className="spacer" />
				{brush !== undefined ? (
					<button className="tbtn" onClick={() => setBrush(undefined)}>
						✕ time window
					</button>
				) : undefined}
				<button className="tbtn" onClick={copy}>
					⧉ {copied ? 'Copied' : 'Copy as markdown'}
				</button>
			</div>

			<div className="timeline">
				<svg
					ref={tlRef}
					viewBox="0 0 1200 56"
					preserveAspectRatio="none"
					aria-label="Timeline — drag to select a time window, click to clear"
					style={{ cursor: 'crosshair', touchAction: 'none' }}
					onPointerDown={(e) => {
						const t = tAt(e.clientX)
						brushing.current = t
						setBrush([t, t])
						e.currentTarget.setPointerCapture(e.pointerId)
					}}
					onPointerMove={(e) => {
						const start = brushing.current
						if (start === undefined) return
						const t = tAt(e.clientX)
						setBrush([Math.min(start, t), Math.max(start, t)])
					}}
					onPointerUp={(e) => {
						const start = brushing.current
						brushing.current = undefined
						e.currentTarget.releasePointerCapture(e.pointerId)
						// A click (negligible drag) clears the window.
						if (start !== undefined && Math.abs(tAt(e.clientX) - start) < span * 0.01) setBrush(undefined)
					}}
				>
					{[...ops.entries()]
						.filter(([, g]) => g.count > 1)
						.map(([root, g]) => {
							const x0 = x(g.minT)
							return <rect key={root} className="tl-span" x={x0} y={6} width={Math.max(3, x(g.maxT) - x0)} height={9} fill="var(--border-strong)" />
						})}
					{base.map((r) => (
						<rect key={r.id} x={x(r.t)} y={44} width={2} height={8} fill={`var(--${classVar(r.cls)})`} />
					))}
					{brush !== undefined ? <rect className="tl-window" x={x(brush[0])} y={2} width={Math.max(2, x(brush[1]) - x(brush[0]))} height={52} rx={3} /> : undefined}
					{brush === undefined && sel !== undefined ? <rect className="tl-window" x={x(sel.t) - 3} y={2} width={6} height={52} rx={3} /> : undefined}
				</svg>
			</div>

			<div className="main">
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
											onClick={() => onSelect(r.id)}
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
											onClick={() => onSelect(t.row.id)}
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
										no entries {query || brush ? 'match the filter' : 'yet'}
									</td>
								</tr>
							) : undefined}
						</tbody>
					</table>
				</div>

				{sel !== undefined ? <ResizeHandle dir="h" onDelta={(d) => setCzW((w) => clampSize(w - d, 220, 640))} /> : undefined}
				{sel !== undefined ? (
					<aside className="causality" aria-label="Caused by" style={{ width: czW }}>
						<div className="cz-head">
							<div className="cz-kicker">Selected entry</div>
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
				) : undefined}
			</div>
		</>
	)
}

/** KindClass → the base color var used for timeline ticks. */
function classVar(cls: KindClass): string {
	switch (cls) {
		case 'write':
			return 'atom'
		case 'compute':
			return 'computed'
		case 'notify':
		case 'render':
			return 'watcher'
		case 'effect':
			return 'effect'
		case 'error':
			return 'danger'
		case 'async':
			return 'suspended'
		case 'origin':
			return 'thread'
		case 'hot':
			return 'hot'
		default:
			return 'system'
	}
}
