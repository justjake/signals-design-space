/**
 * Copy-as-markdown — turn the current selection into agent-ready markdown.
 *
 * This is the devtools' AI handoff: no embedded chat, no export file. You copy
 * a node (or the visible log) as plain markdown and paste it into any chat.
 * Everything here comes from real recorded data; nothing is fabricated.
 */
import type { Backend, NodeId } from "../protocol.ts"
import { inspectorModel, type LogRow, type TreeRow } from "./viewmodel.ts"

/** A node's identity, value, edges, and why-it-last-ran chain, as markdown. */
export function nodeMarkdown(backend: Backend, id: NodeId): string {
  const m = inspectorModel(backend, id)
  if (m === undefined) return `(node #${id} is gone)`
  const n = m.node
  const lines: string[] = []
  lines.push(`## ${m.name} — ${n.kind}#${n.id}`)
  lines.push("")
  lines.push(`- value: ${n.valuePreview ?? "—"}`)
  lines.push(`- status: ${n.status}${n.stale ? " (stale)" : ""}`)
  if (n.pending !== undefined) lines.push(`- pending: ${n.pending}`)
  lines.push(`- recomputes: ${n.recomputes}`)
  lines.push("")
  lines.push(`### Upstream — ${m.deps.length} direct`)
  for (const d of m.deps) lines.push(`- ${d.name} (#${d.id})`)
  if (m.deps.length === 0) lines.push("- (none)")
  lines.push("")
  lines.push(`### Downstream — ${m.subs.length} direct`)
  for (const s of m.subs) lines.push(`- ${s.name} (#${s.id})`)
  if (m.subs.length === 0) lines.push("- (none)")
  lines.push("")
  lines.push("### Why this last ran")
  if (m.why.length === 0) lines.push("- (no recorded activity)")
  for (const e of m.why)
    lines.push(
      `${e.id === m.why[m.why.length - 1].id ? "➤" : "-"} #${e.id} ${e.kind}${e.name ? ` ${e.name}` : ""}${e.summary ? ` — ${e.summary}` : ""}`,
    )
  return lines.join("\n")
}

/** The visible log rows as a markdown list, each with its cause reference. */
export function logMarkdown(rows: LogRow[]): string {
  const lines: string[] = ["## Signals log", ""]
  for (const r of rows) {
    const when = `${(r.t / 1000).toFixed(3)}ms`
    const name = r.name ?? "—"
    const cause = r.cause > 0 ? ` ⤷#${r.cause}` : ""
    const summary = r.summary ? ` — ${r.summary}` : ""
    lines.push(`- #${r.id} \`${r.kind}\` **${name}** (${when})${cause}${summary}`)
  }
  return lines.join("\n")
}

/** One selected event's causal chain and consequences, as agent-ready markdown —
 * "why did this happen, and what did it cause". `spine` is root-first; `caused`
 * is the consequence tree (depth ≥ 1). */
export function causalityMarkdown(spine: LogRow[], caused: TreeRow[]): string {
  const line = (r: LogRow, indent = 0) =>
    `${"  ".repeat(indent)}- #${r.id} \`${r.kind}\`${r.name != null ? ` **${r.name}**` : ""}${r.summary ? ` — ${r.summary}` : ""}`
  const lines: string[] = ["## Why this happened", ""]
  if (spine.length === 0) lines.push("- (no recorded cause)")
  for (const r of spine) lines.push(line(r))
  if (caused.length > 0) {
    lines.push("", "## What it caused", "")
    for (const t of caused) lines.push(line(t.row, Math.max(0, t.depth - 1)))
  }
  return lines.join("\n")
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
