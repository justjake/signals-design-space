import { useMemo, useState } from 'react'
import type { Backend, KindClass } from '../protocol.ts'
import { causeRows, fmtDelta, fmtTook, type Guide, type LogRow, logRows, logTree } from './viewmodel.ts'
import { copyText, logMarkdown } from './markdown.ts'

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
		<button className="causeref" title="jump to cause" onClick={(e) => { e.stopPropagation(); onCause() }}>
			⤷#{row.cause}
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
	node,
	setNode,
	inspect,
}: {
	backend: Backend
	node: number | null
	setNode: (id: number | null) => void
	inspect: (id: number) => void
}) {
	const [mode, setMode] = useState<'flat' | 'tree'>('flat')
	const [query, setQuery] = useState('')
	const [on, setOn] = useState<Record<string, boolean>>({ write: true, compute: true, render: true, effect: true, internals: false })
	const [paused, setPaused] = useState<LogRow[] | null>(null)
	const [floor, setFloor] = useState(0)
	const [collapse, setCollapse] = useState(false)
	const [selected, setSelected] = useState<number | null>(null)
	const [copied, setCopied] = useState(false)

	const classes = useMemo(() => {
		const set = new Set<KindClass>(ALWAYS_ON)
		for (const c of CHIPS) if (on[c.key]) for (const k of c.classes) set.add(k)
		return [...set]
	}, [on])

	const live = logRows(backend, { node: node ?? undefined, classes }, LIMIT)
	const base = (paused ?? live).filter((r) => r.id > floor)
	const rows = base.filter((r) => matchesSearch(r, query))

	const tree = mode === 'tree' ? logTree(rows) : null
	const treeRows = tree === null ? null : collapse ? tree.filter((t) => t.depth === 0) : tree

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

	const sel = selected === null ? null : rows.find((r) => r.id === selected) ?? null
	const spine = sel === null ? [] : causeRows(backend, sel.id)
	const opRoot = spine[0] ?? sel
	const opEntries = sel === null ? 0 : ops.get(rootOf(sel.id))?.count ?? 1

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
				{node !== null ? (
					<button className="tbtn" onClick={() => setNode(null)}>
						✕ node filter
					</button>
				) : null}
				{mode === 'tree' ? (
					<button className="tbtn" aria-pressed={collapse} onClick={() => setCollapse(!collapse)}>
						Collapse to roots
					</button>
				) : null}
				<button className="tbtn" onClick={copy}>
					⧉ {copied ? 'Copied' : 'Copy as markdown'}
				</button>
			</div>

			<div className="timeline">
				<svg viewBox="0 0 1200 56" preserveAspectRatio="none" aria-label="Timeline of recorded entries">
					{[...ops.entries()]
						.filter(([, g]) => g.count > 1)
						.map(([root, g]) => {
							const x0 = x(g.minT)
							return <rect key={root} className="tl-span" x={x0} y={6} width={Math.max(3, x(g.maxT) - x0)} height={9} fill="var(--border-strong)" />
						})}
					{rows.map((r) => (
						<rect key={r.id} x={x(r.t)} y={44} width={2} height={8} fill={`var(--${classVar(r.cls)})`} />
					))}
					{sel !== null ? <rect className="tl-window" x={x(sel.t) - 3} y={2} width={6} height={52} rx={3} /> : null}
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
											className={r.id === selected ? 'selected' : undefined}
											aria-selected={r.id === selected}
											onClick={() => setSelected(r.id)}
										>
											<td className="id">#{r.id}</td>
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
											className={`${t.depth === 0 && t.children > 0 ? 'op-head' : ''} ${t.row.id === selected ? 'selected' : ''}`.trim() || undefined}
											aria-selected={t.row.id === selected}
											onClick={() => setSelected(t.row.id)}
										>
											<td className="id">
												{t.depth === 0 && t.children > 0 ? <span className="caret">▾</span> : null}#{t.row.id}
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
										no entries {node !== null ? 'for this node ' : ''}yet
									</td>
								</tr>
							) : null}
						</tbody>
					</table>
				</div>

				{sel !== null ? (
					<aside className="causality" aria-label="Why this ran">
						<div className="cz-head">
							<div className="cz-kicker">Selected entry</div>
							<div className="cz-title">
								#{sel.id} {sel.kind}
							</div>
							<div className="cz-sub">
								{sel.name ?? 'engine'} · +{((sel.t - (opRoot?.t ?? sel.t)) / 1000).toFixed(3)}ms into the operation
							</div>
						</div>
						<div className="cz-section">
							<h3 data-tip="The chain that led here, in stack-trace order: the selected entry on top, each cause beneath it, the user input at the bottom.">
								Why this ran
							</h3>
							<ol className="spine">
								{[...spine].reverse().map((e, i) => (
									<li key={e.id} className={i === 0 ? 'terminus' : undefined}>
										<div className="knot" />
										<div className="ev">
											<span className="id">#{e.id}</span>
											<button onClick={() => setSelected(e.id)}>
												{e.kind} {e.name ?? ''}
											</button>
										</div>
										{e.summary ? <div className="because">{e.summary}</div> : null}
										{i === 0 ? (
											<div className="impact-card">
												whole operation: <b>{opEntries} entries</b>
												<br />
												{sel.node !== null ? (
													<button className="srclink" onClick={() => inspect(sel.node!)}>
														view {sel.name} in graph →
													</button>
												) : null}
											</div>
										) : null}
									</li>
								))}
							</ol>
						</div>
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
