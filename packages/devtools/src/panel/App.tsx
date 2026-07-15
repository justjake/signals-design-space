import { useState } from 'react'
import type { Backend, KindClass } from '../protocol.ts'
import { useBackend } from './store.ts'
import { THEME_CSS } from './theme.ts'
import { inspectorModel, logRows, nodeRows } from './viewmodel.ts'

const CLASS_VAR: Record<KindClass, string> = {
	origin: 'var(--thread)',
	write: 'var(--atom)',
	compute: 'var(--computed)',
	notify: 'var(--watcher)',
	render: 'var(--watcher)',
	effect: 'var(--effect)',
	batch: 'var(--system)',
	async: 'var(--suspended)',
	error: 'var(--danger)',
	system: 'var(--muted)',
}

function Chip({ cls, label }: { cls: KindClass; label: string }) {
	const color = CLASS_VAR[cls]
	return (
		<span
			className="sd-chip"
			style={{ color, borderColor: color, background: `color-mix(in srgb, ${color} 9%, transparent)` }}
		>
			{label}
		</span>
	)
}

function LogView({ backend, onSelect }: { backend: Backend; onSelect: (id: number) => void }) {
	const rows = logRows(backend, {}, 200)
	return (
		<div className="sd-scroll">
			<table className="sd-table">
				<thead>
					<tr>
						<th>#</th>
						<th>when</th>
						<th>kind</th>
						<th>name</th>
						<th>data</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((r) => (
						<tr key={r.id}>
							<td className="sd-muted">#{r.id}</td>
							<td className="sd-muted">{(r.t / 1000).toFixed(1)}ms</td>
							<td>
								<Chip cls={r.cls} label={r.kind} />
							</td>
							<td>
								{r.name === null ? (
									<span className="sd-muted">—</span>
								) : (
									<button className="sd-name" onClick={() => r.node != null && onSelect(r.node)}>
										{r.name}
									</button>
								)}
							</td>
							<td className="sd-muted">{r.summary}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}

function GraphView({
	backend,
	selected,
	onSelect,
}: {
	backend: Backend
	selected: number | null
	onSelect: (id: number) => void
}) {
	const [query, setQuery] = useState('')
	const rows = nodeRows(backend, query, 300)
	const model = selected != null ? inspectorModel(backend, selected) : null
	return (
		<>
			<div className="sd-scroll">
				<input
					className="sd-search"
					placeholder="filter nodes…"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
				<table className="sd-table">
					<thead>
						<tr>
							<th>name</th>
							<th>kind</th>
							<th>value</th>
							<th>recomputes</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((n) => (
							<tr key={n.id}>
								<td>
									<button className="sd-name" onClick={() => onSelect(n.id)}>
										{n.name}
									</button>
									{n.stale ? <span className="sd-muted"> · stale</span> : null}
								</td>
								<td className="sd-muted">{n.kind}</td>
								<td className="sd-muted">{n.value}</td>
								<td className="sd-muted">{n.recomputes || ''}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<aside className="sd-inspector">
				{model === null ? (
					<span className="sd-muted">Select a node</span>
				) : (
					<>
						<div style={{ font: '600 15px "IBM Plex Mono"' }}>{model.name}</div>
						<div className="sd-muted">{model.node.kind}</div>
						<h3>Value</h3>
						<div>{model.node.valuePreview ?? '—'}</div>
						{model.node.pending ? <div style={{ color: 'var(--danger)' }}>{model.node.pending}</div> : null}
						<h3>Dependencies · {model.deps.length}</h3>
						{model.deps.map((d) => (
							<div key={d.id}>
								<button className="sd-name" onClick={() => onSelect(d.id)}>
									{d.name}
								</button>
							</div>
						))}
						<h3>Subscribers · {model.subs.length}</h3>
						{model.subs.map((s) => (
							<div key={s.id}>
								<button className="sd-name" onClick={() => onSelect(s.id)}>
									{s.name}
								</button>
							</div>
						))}
						<h3>Why this ran</h3>
						{model.why.map((e) => (
							<div key={e.id}>
								<Chip cls={e.cls} label={e.kind} /> <span className="sd-muted">{e.name ?? ''}</span>
							</div>
						))}
					</>
				)}
			</aside>
		</>
	)
}

export function App({ backend }: { backend: Backend }) {
	useBackend(backend) // re-render on each flush
	const [tab, setTab] = useState<'graph' | 'log'>('log')
	const [selected, setSelected] = useState<number | null>(null)
	const select = (id: number) => {
		setSelected(id)
		setTab('graph')
	}
	return (
		<div className="sd-root">
			<style>{THEME_CSS}</style>
			<div className="sd-chrome">
				<button className="sd-tab" data-active={tab === 'graph'} onClick={() => setTab('graph')}>
					Graph
				</button>
				<button className="sd-tab" data-active={tab === 'log'} onClick={() => setTab('log')}>
					Log
				</button>
			</div>
			<div className="sd-main">
				{tab === 'log' ? (
					<LogView backend={backend} onSelect={select} />
				) : (
					<GraphView backend={backend} selected={selected} onSelect={setSelected} />
				)}
			</div>
		</div>
	)
}
