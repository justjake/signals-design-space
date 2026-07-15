/**
 * Copy-as-markdown — turn the current selection into agent-ready markdown.
 *
 * This is the devtools' AI handoff: no embedded chat, no export file. You copy
 * a node (or the visible log) as plain markdown and paste it into any chat.
 * Everything here comes from real recorded data; nothing is fabricated.
 */
import type { Backend } from '../protocol.ts'
import { inspectorModel, type LogRow } from './viewmodel.ts'

/** A node's identity, value, edges, and why-it-last-ran chain, as markdown. */
export function nodeMarkdown(backend: Backend, id: number): string {
	const m = inspectorModel(backend, id)
	if (m === null) return `(node #${id} is gone)`
	const n = m.node
	const lines: string[] = []
	lines.push(`## ${m.name} — ${n.kind}#${n.id}`)
	lines.push('')
	lines.push(`- value: ${n.valuePreview ?? '—'}`)
	lines.push(`- status: ${n.status}${n.stale ? ' (stale)' : ''}`)
	if (n.pending !== null) lines.push(`- pending: ${n.pending}`)
	lines.push(`- recomputes: ${n.recomputes}`)
	lines.push('')
	lines.push(`### Upstream — ${m.deps.length} direct`)
	for (const d of m.deps) lines.push(`- ${d.name} (#${d.id})`)
	if (m.deps.length === 0) lines.push('- (none)')
	lines.push('')
	lines.push(`### Downstream — ${m.subs.length} direct`)
	for (const s of m.subs) lines.push(`- ${s.name} (#${s.id})`)
	if (m.subs.length === 0) lines.push('- (none)')
	lines.push('')
	lines.push('### Why this last ran')
	if (m.why.length === 0) lines.push('- (no recorded activity)')
	for (const e of m.why) lines.push(`${e.id === m.why[m.why.length - 1].id ? '➤' : '-'} #${e.id} ${e.kind}${e.name ? ` ${e.name}` : ''}${e.summary ? ` — ${e.summary}` : ''}`)
	return lines.join('\n')
}

/** The visible log rows as a markdown list, each with its cause reference. */
export function logMarkdown(rows: LogRow[]): string {
	const lines: string[] = ['## Signals log', '']
	for (const r of rows) {
		const when = `${(r.t / 1000).toFixed(3)}ms`
		const name = r.name ?? '—'
		const cause = r.cause > 0 ? ` ⤷#${r.cause}` : ''
		const summary = r.summary ? ` — ${r.summary}` : ''
		lines.push(`- #${r.id} \`${r.kind}\` **${name}** (${when})${cause}${summary}`)
	}
	return lines.join('\n')
}

/** Write text to the clipboard; resolves false if the API is unavailable. */
export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text)
		return true
	} catch {
		return false
	}
}
