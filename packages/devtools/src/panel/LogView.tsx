/**
 * The log tab, as a coordinator: it owns the pause/clear/filter/brush state,
 * resolves the view-model rows the child components render, and wires their
 * selections back into App's navigation. The pieces live in their own files —
 * LogTimeline (the brushable strip), LogTable (flat/tree rows), LogDetail
 * (the selected entry's causality pane).
 */
import { useEffect, useMemo, useRef, useState } from "react"
import type { Backend, EventId, KindClass, NodeId } from "../protocol.ts"
import {
  causedTree,
  causeRows,
  fmtTook,
  type LogRow,
  logRows,
  logTree,
  opGroups,
} from "./viewmodel.ts"
import { LogDetail } from "./LogDetail.tsx"
import { LogTable } from "./LogTable.tsx"
import { LogTimeline } from "./LogTimeline.tsx"
import { copyText, logMarkdown } from "./markdown.ts"
import { clampSize, ResizeHandle } from "./ResizeHandle.tsx"
import { useBackend } from "./store.ts"

const LIMIT = 1000

/**
 * Filter chips. Each toggles the kind-classes it names; origin/error/batch/
 * async are structural and always shown. Internals (bookkeeping) is off by
 * default. Hot is off by default too, and it is more than a filter: it also
 * switches the engine's hot channel on and off (nothing is recorded while
 * it's off — that channel is zero-cost when disabled).
 */
const CHIPS: { key: string; label: string; sw: string; classes: KindClass[]; tip: string }[] = [
  {
    key: "write",
    label: "set/update",
    sw: "var(--atom)",
    classes: ["write"],
    tip: "Changes to atoms: set (assigned a value) and update (computed from the previous value) — where every change starts.",
  },
  {
    key: "compute",
    label: "recompute",
    sw: "var(--computed)",
    classes: ["compute"],
    tip: "Recompute: a computed re-ran its function.",
  },
  {
    key: "render",
    label: "render",
    sw: "var(--watcher)",
    classes: ["notify", "render"],
    tip: "Rendering: notify (a watcher was told its inputs changed) and render (a render pass, start to commit).",
  },
  {
    key: "effect",
    label: "effect",
    sw: "var(--effect)",
    classes: ["effect"],
    tip: "Effects — code that runs after changes commit: effect() (library) and useSignalEffect (component).",
  },
  {
    key: "hot",
    label: "internals",
    sw: "var(--hot)",
    classes: ["hot"],
    tip: "The engine's low-level algorithm steps, recorded only while this is on (zero cost otherwise): propagate (a change marks what it reaches stale) and check (a read confirms whether inputs really changed). These are a deeper view of the same work the events above already summarize — very high volume, for debugging the engine itself.",
  },
]
// Structural kinds (origin/error/batch/async) and any unclassified kind
// (system) are always shown — they are never noise and have no toggle.
const ALWAYS_ON: KindClass[] = ["origin", "error", "batch", "async", "system"]

function matchesSearch(r: LogRow, query: string): boolean {
  if (query === "") return true
  const name = (r.name ?? "").toLowerCase()
  let ok = true
  for (const tok of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (tok.startsWith("kind:")) ok &&= r.kind.toLowerCase().includes(tok.slice(5))
    else if (tok.startsWith("name:")) ok &&= name.includes(tok.slice(5))
    else ok &&= r.kind.toLowerCase().includes(tok) || name.includes(tok)
  }
  return ok
}

export function LogView({
  backend,
  query,
  setQuery,
  inspect,
  selected,
  onSelect,
  mode,
  setMode,
}: {
  backend: Backend
  query: string
  setQuery: (q: string) => void
  inspect: (id: NodeId) => void
  /** The selected event, owned by App (drives the global nav history). */
  selected: EventId | undefined
  /** Report a user selection so App records it and updates `selected`. */
  onSelect: (id: EventId) => void
  /** Tree/flat mode, owned by App so it persists across tab navigation. */
  mode: "flat" | "tree"
  setMode: (m: "flat" | "tree") => void
}) {
  // Flush counter: bumps when the collector records new entries. The memos
  // below key their backend reads on it, so a re-render caused by local state
  // (a selection, a brush drag) never re-reads and re-nests the whole window.
  const flush = useBackend(backend)
  // Hot mirrors the backend's channel state so a remounted panel shows the truth.
  const [on, setOn] = useState<Record<string, boolean>>(() => ({
    write: true,
    compute: true,
    render: true,
    effect: true,
    internals: false,
    hot: backend.hotMode?.() ?? false,
  }))
  const [paused, setPaused] = useState<LogRow[] | undefined>(undefined)
  const [floor, setFloor] = useState(0)
  const [collapsed, setCollapsed] = useState<ReadonlySet<EventId>>(() => new Set())
  const [copied, setCopied] = useState(false)
  const [czW, setCzW] = useState(320)
  // Timeline brush: [t0, t1] in µs, or undefined for the full window.
  const [brush, setBrush] = useState<[number, number] | undefined>(undefined)

  // Esc clears the timeline window (a click on the strip clears it too).
  useEffect(() => {
    if (brush === undefined) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBrush(undefined)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [brush])

  const classes = useMemo(() => {
    const set = new Set<KindClass>(ALWAYS_ON)
    for (const c of CHIPS) if (on[c.key]) for (const k of c.classes) set.add(k)
    return [...set]
  }, [on])

  const live = useMemo(() => logRows(backend, { classes }, LIMIT), [backend, flush, classes])
  const base = useMemo(() => (paused ?? live).filter((r) => r.id > floor), [paused, live, floor])
  const rows = useMemo(
    () =>
      base.filter(
        (r) =>
          matchesSearch(r, query) && (brush === undefined || (r.t >= brush[0] && r.t <= brush[1])),
      ),
    [base, query, brush],
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
    const t = setTimeout(
      () =>
        setFlashing((f) => {
          const n = new Set(f)
          for (const id of fresh) n.delete(id)
          return n
        }),
      800,
    )
    return () => clearTimeout(t)
  })

  // Tree mode: resolve any cause referenced but outside the visible window
  // (still in the ring) and prepend its ancestry, so rows nest under the real
  // event instead of orphaning. Then nest, honoring the collapsed set.
  const tree = useMemo(() => {
    if (mode !== "tree") return undefined
    let treeInput = rows
    const inWindow = new Set(rows.map((r) => r.id))
    const extra = new Map<EventId, LogRow>()
    for (const r of rows) {
      if (r.cause > 0 && !inWindow.has(r.cause) && !extra.has(r.cause)) {
        for (const anc of causeRows(backend, r.cause))
          if (!inWindow.has(anc.id)) extra.set(anc.id, anc)
      }
    }
    if (extra.size > 0) treeInput = [...extra.values(), ...rows]
    return logTree(treeInput, collapsed)
  }, [mode, rows, collapsed, backend, flush])
  const toggleCollapsed = (id: EventId) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // Group entries by operation root — drives the timeline spans and the op
  // entry count without walking a cause chain per row.
  const { groups: ops, rootById } = useMemo(() => opGroups(base), [base])
  // One-line rollup for an operation-root row: the "how big was this tree"
  // glance the log tree exists to give. Undefined for non-root rows.
  const opRollup = (id: EventId): string | undefined => {
    const g = ops.get(id)
    if (g === undefined) return undefined
    const parts = [`${g.count} ${g.count === 1 ? "entry" : "entries"}`]
    if (g.renders > 0) parts.push(`${g.renders} rendered`)
    if (g.maxT > g.minT) parts.push(fmtTook(g.maxT - g.minT))
    return parts.join(" · ")
  }

  // The cause chain resolves from the backend, so a selected entry outside the
  // visible window (e.g. jumped-to via ⤷) still shows — its own entry is the
  // chain's last element.
  const spine = useMemo(
    () => (selected === undefined ? [] : causeRows(backend, selected)),
    [backend, flush, selected],
  )
  const sel =
    selected === undefined
      ? undefined
      : (rows.find((r) => r.id === selected) ?? spine[spine.length - 1] ?? undefined)
  const opRoot = spine[0] ?? sel
  const opGroup = sel === undefined ? undefined : ops.get(rootById.get(sel.id) ?? sel.id)
  const opEntries = opGroup?.count ?? (sel === undefined ? 0 : 1)
  // Total wall time the whole operation spanned (root → last consequence) — the
  // "how big was this tree" number you trace back from a slow update.
  const opTotalUs = opGroup ? opGroup.maxT - opGroup.minT : 0
  // The consequence tree of the selected entry: everything it caused, directly
  // and transitively, within the window, nested (bounded for huge fan-outs).
  // logTree roots it at sel and orders siblings newest-first; we show depth ≥ 1.
  const caused = useMemo(() => (sel === undefined ? [] : causedTree(base, sel.id)), [base, sel])
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
          style={{ minWidth: 84, textAlign: "left" }}
          onClick={() => setPaused(paused === undefined ? live : undefined)}
        >
          {paused === undefined ? "⏸ Pause" : "▶ Resume"}
        </button>
        <button
          className="tbtn"
          onClick={() => setFloor(live.length ? live[live.length - 1].id : 0)}
        >
          Clear
        </button>
        <span
          role="group"
          aria-label="Ordering"
          style={{
            display: "inline-flex",
            border: "1px solid var(--border)",
            borderRadius: 4,
            overflow: "hidden",
          }}
        >
          <button
            className="tbtn mode"
            aria-pressed={mode === "tree"}
            onClick={() => setMode("tree")}
          >
            Tree
          </button>
          <button
            className="tbtn mode"
            aria-pressed={mode === "flat"}
            onClick={() => setMode("flat")}
          >
            Flat
          </button>
        </span>
        {mode === "tree" ? (
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
            {collapsed.size > 0 ? "Expand all" : "Collapse to roots"}
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
              className={`kchip ${on[c.key] ? "on" : ""}`}
              data-tip={c.tip}
              aria-pressed={on[c.key]}
              onClick={() => {
                const next = !on[c.key]
                // The hot chip drives the engine channel, not just the filter.
                if (c.key === "hot") backend.setHotMode?.(next)
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
          ⧉ {copied ? "Copied" : "Copy as markdown"}
        </button>
      </div>

      <LogTimeline rows={base} ops={ops} brush={brush} setBrush={setBrush} selT={sel?.t} />

      <div className="main">
        <LogTable
          mode={mode}
          rows={rows}
          treeRows={tree}
          selected={selected}
          onSelect={onSelect}
          collapsed={collapsed}
          toggleCollapsed={toggleCollapsed}
          flashing={flashing}
          opRollup={opRollup}
          inspect={inspect}
          emptyHint={`no entries ${query || brush ? "match the filter" : "yet"}`}
        />

        {sel !== undefined ? (
          <ResizeHandle dir="h" onDelta={(d) => setCzW((w) => clampSize(w - d, 220, 640))} />
        ) : undefined}
        {sel !== undefined ? (
          <LogDetail
            sel={sel}
            spine={spine}
            caused={caused}
            opRoot={opRoot}
            opEntries={opEntries}
            opTotalUs={opTotalUs}
            opStack={opStack}
            width={czW}
            onSelect={onSelect}
            inspect={inspect}
          />
        ) : undefined}
      </div>
    </>
  )
}
