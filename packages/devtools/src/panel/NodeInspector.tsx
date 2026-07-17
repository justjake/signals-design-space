/**
 * The graph view's inspector sidebar: one node's value, source, evaluation
 * stats, causal context, and neighbor lists, in collapsible sections. Renders
 * prebuilt view-model rows — the coordinator (GraphView) resolves them.
 */
import { type ReactNode, useState } from "react"
import type { EventId, NodeId, StackFrame } from "../protocol.ts"
import {
  fmtId,
  fmtTook,
  type InspectorModel,
  isUnstable,
  type LogRow,
  type NeighborRef,
  type TreeRow,
} from "./viewmodel.ts"
import { CauseSpine, EventRef } from "./CauseSpine.tsx"
import { Code } from "./highlight.tsx"
import { KIND_LABEL, KIND_TIP, kindVar, statusVar } from "./kind-style.ts"
import { copyText } from "./markdown.ts"
import { StackTrace } from "./StackTrace.tsx"

/**
 * A collapsible inspector section (progressive disclosure): click the header to
 * fold a section you don't need, so a long inspector stays scannable. `closed`
 * holds the folded section ids; the section reveals its body when open.
 */
function Sec({
  id,
  title,
  tip,
  closed,
  onToggle,
  children,
}: {
  id: string
  title: ReactNode
  tip?: string
  closed: ReadonlySet<string>
  onToggle: (id: string) => void
  children: ReactNode
}) {
  const isClosed = closed.has(id)
  return (
    <div className="insp-section">
      <h3 className="sec-toggle" data-tip={tip} onClick={() => onToggle(id)}>
        <span className="sec-caret">{isClosed ? "▸" : "▾"}</span> {title}
      </h3>
      {isClosed ? null : children}
    </div>
  )
}

function NeighborList({ items, onPick }: { items: NeighborRef[]; onPick: (id: NodeId) => void }) {
  return (
    <ul className="linklist">
      {items.map((n) => (
        <li key={n.id}>
          <span className="sw" style={{ background: kindVar(n.kind) }} />
          <button
            data-tip={`${n.kind} ${n.name}${n.status !== "ok" ? ` · ${n.status}` : ""}`}
            onClick={() => onPick(n.id)}
          >
            {n.name}
          </button>
          {n.status !== "ok" ? (
            <span className="meta" style={{ color: statusVar(n.status) }}>
              {n.status}
            </span>
          ) : undefined}
        </li>
      ))}
      {items.length === 0 ? <li style={{ color: "var(--faint)" }}>none</li> : undefined}
    </ul>
  )
}

export function NodeInspector({
  model,
  whyChain,
  lastCaused,
  inspStack,
  eventSel,
  width,
  onPick,
  openEventInLog,
  getCopyMarkdown,
}: {
  /** The inspected node's resolved payload; undefined shows the empty hint. */
  model: InspectorModel | undefined
  /** The "why this ran" chain: a drawer-picked event's, else the node's own. */
  whyChain: LogRow[]
  /** Consequence tree of the node's most recent causing event. */
  lastCaused: TreeRow[]
  /** App stack from the first chain entry that captured one. */
  inspStack: StackFrame[] | undefined
  /** The drawer-picked event the why-chain is rooted at, for the header. */
  eventSel: EventId | undefined
  width: number
  onPick: (id: NodeId) => void
  openEventInLog: (eventId: EventId) => void
  /** Build the copy-as-markdown text for the inspected node. */
  getCopyMarkdown: () => string
}) {
  const [copied, setCopied] = useState(false)
  // Folded inspector sections (progressive disclosure).
  const [secClosed, setSecClosed] = useState<ReadonlySet<string>>(() => new Set())
  const toggleSec = (id: string) =>
    setSecClosed((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const copyNode = () => {
    void copyText(getCopyMarkdown()).then((ok) => {
      setCopied(ok)
      if (ok) setTimeout(() => setCopied(false), 1200)
    })
  }

  if (model === undefined) {
    return (
      <aside className="inspector" aria-label="Node inspector" style={{ width }}>
        <div className="insp-section" style={{ color: "var(--muted)" }}>
          No nodes yet — interact with the app to populate the graph.
        </div>
      </aside>
    )
  }

  return (
    <aside className="inspector" aria-label="Node inspector" style={{ width }}>
      <div className="insp-head">
        <div className="insp-kind" style={{ color: kindVar(model.node.kind) }}>
          <span className="sw" />
          {KIND_LABEL[model.node.kind]}
          <button className="srclink2 copy-md" onClick={copyNode}>
            ⧉ {copied ? "copied" : "copy as markdown"}
          </button>
        </div>
        <div className="insp-name">
          {model.name} <span className="insp-id">{fmtId("node", model.node.id)}</span>
        </div>
        <div className="insp-desc">{KIND_TIP[model.node.kind].replace(/^[^:]+:\s*/, "")}</div>
      </div>

      <Sec id="value" title="Value" closed={secClosed} onToggle={toggleSec}>
        <div className="value-preview">
          <Code>{model.node.valueFull ?? model.node.valuePreview ?? "—"}</Code>
        </div>
        {model.node.status !== "ok" ? (
          <div className="sumline" style={{ color: statusVar(model.node.status) }}>
            {model.node.status === "error" ? "errored" : "suspended"}
            {model.statusSince !== undefined ? ` at ${model.statusSince}` : ""}
            {model.node.pending !== undefined ? ` — ${model.node.pending}` : ""}
          </div>
        ) : undefined}
      </Sec>

      {model.node.source !== undefined ? (
        <Sec id="source" title="Source" closed={secClosed} onToggle={toggleSec}>
          <div className="value-preview">
            <Code>{model.node.source}</Code>
          </div>
        </Sec>
      ) : undefined}

      <Sec
        id="eval"
        tip="How this node spent the recorded window: how long its own work took, and whether recomputes produced a new result (work flowed downstream) or the same result (downstream work stopped)."
        title={
          <>
            Evaluation <span className="win">recorded window</span>
          </>
        }
        closed={secClosed}
        onToggle={toggleSec}
      >
        <div className="kv">
          <span className="k">last event</span>
          <span className="v">
            {model.last ? (
              <>
                <EventRef row={model.last} showName={false} />
                {model.last.took !== undefined ? ` · ${fmtTook(model.last.took)}` : ""} ·{" "}
                {model.last.time}
              </>
            ) : (
              "—"
            )}
          </span>
          {model.node.equals !== undefined ? (
            <>
              <span
                className="k"
                data-tip="The equality function that decides whether a recompute changed the value."
              >
                equals
              </span>
              <span className="v">{model.node.equals}</span>
            </>
          ) : undefined}
          <span
            className="k"
            data-tip="Total time spent running this node’s own function in the recorded window."
          >
            run time
          </span>
          <span className="v">
            {fmtTook(model.node.selfUs)} · {model.node.recomputes}{" "}
            {model.node.recomputes === 1 ? "run" : "runs"}
          </span>
          <span className="k">status</span>
          <span className="v">{model.node.stale ? "stale" : model.node.status}</span>
          {model.node.checks > 0 ? (
            <>
              <span
                className="k"
                data-tip="Reads that found the node already fresh and served the memoized value without re-evaluating — the memoization win. Counted only while the hot channel is on."
              >
                from cache
              </span>
              <span className="v">
                {Math.max(0, model.node.checks - model.node.pulls).toLocaleString()} of{" "}
                {model.node.checks.toLocaleString()} reads
              </span>
            </>
          ) : undefined}
        </div>
        {model.node.newResults + model.node.sameResults > 0 ? (
          <>
            <div
              className="memo-bar"
              role="img"
              aria-label={`${model.node.newResults + model.node.sameResults} recomputes: ${model.node.newResults} new, ${model.node.sameResults} same`}
            >
              {model.node.newResults > 0 ? (
                <span
                  style={{
                    width: `${(model.node.newResults / (model.node.newResults + model.node.sameResults)) * 100}%`,
                    background: "var(--computed)",
                  }}
                />
              ) : undefined}
              {model.node.sameResults > 0 ? (
                <span
                  style={{
                    width: `${(model.node.sameResults / (model.node.newResults + model.node.sameResults)) * 100}%`,
                    background: "var(--system)",
                  }}
                />
              ) : undefined}
            </div>
            <div className="memo-legend">
              <span>
                <span className="sw" style={{ background: "var(--computed)" }} />
                <b>{model.node.newResults}×</b> new result — flowed downstream
              </span>
              <span>
                <span className="sw" style={{ background: "var(--system)" }} />
                <b>{model.node.sameResults}×</b> same result — downstream work stopped
              </span>
            </div>
          </>
        ) : undefined}
        {isUnstable(
          model.node.kind,
          model.node.newResults,
          model.node.sameResults,
          model.node.valuePreview,
        ) ? (
          <div
            className="sumline unstable"
            data-tip="This computed returns a fresh object every run, so its equality check never cuts off — every change re-runs its subscribers. A stable reference or a custom equals would let it memoize."
          >
            ⚠ unstable — never memoizes (a new object each run)
          </div>
        ) : undefined}
      </Sec>

      <Sec
        id="why"
        tip="The chain that led to the shown event, in stack-trace order: it on top, each cause beneath, user input at the bottom. Pick an event in the log below to trace it."
        title={<>Last caused by{eventSel !== undefined ? ` · #${eventSel}` : ""}</>}
        closed={secClosed}
        onToggle={toggleSec}
      >
        <CauseSpine chain={whyChain} onPick={(e) => openEventInLog(e.id)} />
      </Sec>

      {lastCaused.length > 0 ? (
        <Sec
          id="caused"
          tip="Everything the node’s most recent event caused, directly and transitively."
          title={`What it caused · ${lastCaused.length}`}
          closed={secClosed}
          onToggle={toggleSec}
        >
          <ul className="caused-tree">
            {lastCaused.map((t) => (
              <li key={t.row.id} style={{ paddingLeft: (t.depth - 1) * 14 }}>
                <EventRef row={t.row} onClick={() => openEventInLog(t.row.id)} />
              </li>
            ))}
          </ul>
        </Sec>
      ) : undefined}

      {inspStack !== undefined ? <StackTrace frames={inspStack} /> : undefined}
      <Sec
        id="upstream"
        title={
          <>
            Upstream{" "}
            <span className="win">
              {model.depsTotal} direct
              {model.depsTransitive > model.depsTotal
                ? ` · ${model.depsTransitive.toLocaleString()} transitive`
                : ""}
            </span>
          </>
        }
        closed={secClosed}
        onToggle={toggleSec}
      >
        <NeighborList items={model.deps} onPick={onPick} />
      </Sec>

      <Sec
        id="downstream"
        title={
          <>
            Downstream{" "}
            <span className="win">
              {model.subsTotal} direct
              {model.subsTransitive > model.subsTotal
                ? ` · ${model.subsTransitive.toLocaleString()} transitive`
                : ""}
            </span>
          </>
        }
        closed={secClosed}
        onToggle={toggleSec}
      >
        <NeighborList items={model.subs} onPick={onPick} />
      </Sec>
    </aside>
  )
}
