import { useEffect, useMemo, useRef, useState } from 'react'
import type { Backend, KindClass } from '../protocol.ts'
import { causeRows, fmtDelta, fmtId, fmtTook, type Guide, type LogRow, logRows, logTree } from './viewmodel.ts'
import { CauseSpine, EventRef } from './CauseSpine.tsx'
import { copyText, logMarkdown } from './markdown.ts'
import { clampSize, ResizeHandle } from './ResizeHandle.tsx'
import { StackTrace } from './StackTrace.tsx'

const LIMIT = 1000

/**
 * Filter chips. Each toggles the kind-classes it names; origin/error/batch/
 * async are structural and always shown. Internals (bookkeeping) is off by
 * default.
 */
const CHIPS: { key: string; label: string; sw: string; classes: KindClass[]; tip: string }[] = [
	{ key: 'write', label: 'set/update', sw: 'var(--atom)', classes: ['write'], tip: 'Changes to atoms: set (assigned a value) and update (computed from the previous value) — where every change starts.' },
	{ key: 'compute', label: 'recompute', sw: 'var(--computed)', classes: ['compute'], tip: 'Recompute: a computed re-ran its function.' },
	{ key: 'render', label: 'render', sw: 'var(--watcher)', classes: ['notify', 'render'], tip: 'Rendering: notify (a watcher was told its inputs changed) and render (a render pass, start to commit).' },
	{ key: 'effect', label: 'effect', sw: 'var(--effect)', classes: ['effect'], tip: 'Effects — code that runs after changes commit: effect() (library) and useSignalEffect (component).' },
	{ key: 'internals', label: 'internals', sw: 'var(--system)', classes: ['system'], tip: 'Library bookkeeping with no user intent behind it. Off by default. Batch begins and transitions stay visible — they are structure, not noise.' },
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
	guides,
	onCause,
}: {
	row: LogRow
	guides: Guide[] | null
	onCause: () => void
}) {
	// The whole row selects (the <tr> handles the click); the cause ref is the
	// one secondary action, so it stops propagation and jumps instead.
	const cause = row.cause > 0 ? (
		<button className="causeref" onClick={(e) => { e.stopPropagation(); onCause() }}>
			⤷{fmtId('event', row.cause)}
		</button>
	) : null
	const name =
		row.name === null ? <span style={{ color: 'var(--faint)' }}>—</span> : <span className="lname">{row.name}</span>
	if (guides === null) {
		return (
			<td className="name">
				{name}
				{cause}
			</td>
		)
	}
	return (
		<td className="name">
			<div className="kcell">
				<Guides guides={guides} />
				<span className="ntext">
					{name}
					{cause}
				</span>
			</div>
		</td>
	)
}

export function LogView({
	backend,
	query,
	setQuery,
	inspect,
}: {
	backend: Backend
	query: string
	setQuery: (q: string) => void
	inspect: (id: number) => void
}) {
	const [mode, setMode] = useState<'flat' | 'tree'>('flat')
	const [on, setOn] = useState<Record<string, boolean>>({ write: true, compute: true, render: true, effect: true, internals: false })
	const [paused, setPaused] = useState<LogRow[] | null>(null)
	const [floor, setFloor] = useState(0)
	const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set())
	const [selected, setSelected] = useState<number | null>(null)
	const [copied, setCopied] = useState(false)
	const [czW, setCzW] = useState(320)
	// Timeline brush: [t0, t1] in µs, or null for the full window.
	const [brush, setBrush] = useState<[number, number] | null>(null)
	const tlRef = useRef<SVGSVGElement | null>(null)
	const brushing = useRef<number | null>(null)
	const selRowRef = useRef<HTMLTableRowElement | null>(null)

	// Scroll the selected entry into view (e.g. after a jump-to-cause).
	useEffect(() => {
		selRowRef.current?.scrollIntoView({ block: 'nearest' })
	}, [selected])

	// Esc clears the timeline window (a click on the strip clears it too).
	useEffect(() => {
		if (brush === null) return
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setBrush(null)
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
		(r) => matchesSearch(r, query) && (brush === null || (r.t >= brush[0] && r.t <= brush[1])),
	)

	// Tree mode: resolve any cause referenced but outside the visible window
	// (still in the ring) and prepend its ancestry, so rows nest under the real
	// event instead of orphaning. Then nest, honoring the collapsed set.
	let treeInput = rows
	if (mode === 'tree') {
		const inWindow = new Set(rows.map((r) => r.id))
		const extra = new Map<number, LogRow>()
		for (const r of rows) {
			if (r.cause > 0 && !inWindow.has(r.cause) && !extra.has(r.cause)) {
				for (const anc of causeRows(backend, r.cause)) if (!inWindow.has(anc.id)) extra.set(anc.id, anc)
			}
		}
		if (extra.size > 0) treeInput = [...extra.values(), ...rows]
	}
	const tree = mode === 'tree' ? logTree(treeInput, collapsed) : null
	const treeRows = tree
	const toggleCollapsed = (id: number) =>
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
	const rootMemo = new Map<number, number>()
	const rootOf = (id: number): number => {
		const seen: number[] = []
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
	const ops = new Map<number, { minT: number; maxT: number; count: number }>()
	for (const r of base) {
		const root = rootOf(r.id)
		const g = ops.get(root)
		if (g === undefined) ops.set(root, { minT: r.t, maxT: r.t, count: 1 })
		else { g.maxT = r.t; g.count++ }
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
	const spine = selected === null ? [] : causeRows(backend, selected)
	const sel = selected === null ? null : (rows.find((r) => r.id === selected) ?? spine[spine.length - 1] ?? null)
	const opRoot = spine[0] ?? sel
	const opEntries = sel === null ? 0 : ops.get(rootOf(sel.id))?.count ?? 1
	// Entries this one directly caused (children), from the visible window.
	const children = sel === null ? [] : base.filter((r) => r.cause === sel.id)
	// The app stack captured at the operation root (the first chain entry with one).
	const opStack = spine.find((e) => e.stack !== null)?.stack ?? null

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
					aria-pressed={paused !== null}
					style={{ minWidth: 84, textAlign: 'left' }}
					onClick={() => setPaused(paused === null ? live : null)}
				>
					{paused === null ? '⏸ Pause' : '▶ Resume'}
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
								const next = new Set<number>()
								for (const t of tree ?? []) if (t.depth === 0 && t.children > 0) next.add(t.row.id)
								return next
							})
						}
					>
						{collapsed.size > 0 ? 'Expand all' : 'Collapse to roots'}
					</button>
				) : null}
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
							onClick={() => setOn({ ...on, [c.key]: !on[c.key] })}
						>
							<span className="sw" style={{ background: c.sw }} />
							{c.label}
						</button>
					))}
				</div>
				<div className="spacer" />
				{brush !== null ? (
					<button className="tbtn" onClick={() => setBrush(null)}>
						✕ time window
					</button>
				) : null}
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
						if (start === null) return
						const t = tAt(e.clientX)
						setBrush([Math.min(start, t), Math.max(start, t)])
					}}
					onPointerUp={(e) => {
						const start = brushing.current
						brushing.current = null
						e.currentTarget.releasePointerCapture(e.pointerId)
						// A click (negligible drag) clears the window.
						if (start !== null && Math.abs(tAt(e.clientX) - start) < span * 0.01) setBrush(null)
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
					{brush !== null ? <rect className="tl-window" x={x(brush[0])} y={2} width={Math.max(2, x(brush[1]) - x(brush[0]))} height={52} rx={3} /> : null}
					{brush === null && sel !== null ? <rect className="tl-window" x={x(sel.t) - 3} y={2} width={6} height={52} rx={3} /> : null}
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
											className={r.id === selected ? 'selected' : undefined}
											aria-selected={r.id === selected}
											onClick={() => setSelected(r.id)}
										>
											<td className="id">{fmtId('event', r.id)}</td>
											<td className="t">
												{r.time}
												{r.delta !== null ? <span className="tdelta"> {fmtDelta(r.delta)}</span> : null}
											</td>
											<td>
												<span className={`chip ${r.cls}`} data-tip={kindTip(r.kind)}>{r.kind}</span>
											</td>
											<NameCell row={r} guides={null} onCause={() => setSelected(r.cause)} />
											<td className="data">{r.summary}</td>
											<td className="took">{fmtTook(r.took)}</td>
										</tr>
									))
								: treeRows!.map((t) => (
										<tr
											key={t.row.id}
											ref={t.row.id === selected ? selRowRef : undefined}
											className={`${t.depth === 0 && t.children > 0 ? 'op-head' : ''} ${t.row.id === selected ? 'selected' : ''}`.trim() || undefined}
											aria-selected={t.row.id === selected}
											onClick={() => setSelected(t.row.id)}
										>
											<td className="id">
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
											) : null}
											{fmtId('event', t.row.id)}
											</td>
											<td className="t">
												{t.row.time}
												{t.row.delta !== null ? <span className="tdelta"> {fmtDelta(t.row.delta)}</span> : null}
											</td>
											<td>
												<span className={`chip ${t.row.cls}`} data-tip={kindTip(t.row.kind)}>{t.row.kind}</span>
											</td>
											<NameCell row={t.row} guides={t.depth === 0 ? null : t.guides} onCause={() => setSelected(t.row.cause)} />
											<td className="data">{t.row.summary}</td>
											<td className="took">{fmtTook(t.row.took)}</td>
										</tr>
									))}
							{rows.length === 0 ? (
								<tr>
									<td className="data" colSpan={6} style={{ color: 'var(--faint)', fontStyle: 'italic' }}>
										no entries {query || brush ? 'match the filter' : 'yet'}
									</td>
								</tr>
							) : null}
						</tbody>
					</table>
				</div>

				{sel !== null ? <ResizeHandle dir="h" onDelta={(d) => setCzW((w) => clampSize(w - d, 220, 640))} /> : null}
				{sel !== null ? (
					<aside className="causality" aria-label="Why this ran" style={{ width: czW }}>
						<div className="cz-head">
							<div className="cz-kicker">Selected entry</div>
							<div className="cz-title">
								<EventRef row={sel} />
							</div>
							<div className="cz-sub">
								+{((sel.t - (opRoot?.t ?? sel.t)) / 1000).toFixed(3)}ms into the operation
							</div>
						</div>
						<div className="cz-section">
							<h3 data-tip="The chain that led here, in stack-trace order: the selected entry on top, each cause beneath it, the user input at the bottom.">
								Why this ran
							</h3>
							<CauseSpine
								chain={spine}
								onPick={(e) => setSelected(e.id)}
								renderExtra={(t) => (
									<div className="impact-card">
										whole operation: <b>{opEntries} entries</b>
										<br />
										{t.node !== null ? (
											<button className="srclink" onClick={() => inspect(t.node!)}>
												view {t.name} in graph →
											</button>
										) : null}
									</div>
								)}
							/>
						</div>
						{opStack !== null ? <StackTrace frames={opStack} /> : null}
						{children.length > 0 ? (
							<div className="cz-section">
								<h3 data-tip="Entries this one directly caused (its children in the causal tree).">What this caused · {children.length}</h3>
								<ul className="linklist">
									{children.map((c) => (
										<li key={c.id}>
											<EventRef row={c} onClick={() => setSelected(c.id)} />
										</li>
									))}
								</ul>
							</div>
						) : null}
					</aside>
				) : null}
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
		default:
			return 'system'
	}
}
