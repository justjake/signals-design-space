/**
 * The graph view's node list: a searchable, capped index into the graph with
 * opt-in metric columns. Owns the "+ metrics" toggle and the rank-by-column
 * sort; ranking reorders only this list (a copy), never the coordinator's row
 * order, so sorting can't move the canvas focus.
 */
import { useState } from "react"
import type { NodeId } from "../protocol.ts"
import { fmtId, fmtTook, isUnstable, type NodeRow } from "./viewmodel.ts"
import { kindVar } from "./kind-style.ts"
import { flashClass, useFlashOnChange } from "./useFlash.ts"

/**
 * The "+ metrics" opt-in node-list columns, hidden by default so the list
 * stays scannable; clicking a header ranks the listed window by that
 * metric, descending. A fourth column, "downstream cost" (time spent in
 * work a node's changes caused), is a follow-on: it needs per-event cost
 * attribution rolled up along cause chains, which nothing computes yet.
 */
type MetricKey = "recomputes" | "selfUs" | "unchanged"
const METRIC_COLS: { key: MetricKey; label: string; tip: string }[] = [
  {
    key: "recomputes",
    label: "recomputes",
    tip: "How many times this node ran in the recorded window. Click to rank.",
  },
  {
    key: "selfUs",
    label: "run time",
    tip: "Total time spent running this node’s own function in the recorded window. Click to rank.",
  },
  {
    key: "unchanged",
    label: "unchanged",
    tip: "Share of recomputes that produced the same result — downstream work stopped. Click to rank.",
  },
]

export function NodeList({
  rows,
  sel,
  onPick,
  height,
  hiddenByKind,
  moreThanListed,
}: {
  rows: NodeRow[]
  sel: NodeId | undefined
  onPick: (id: NodeId) => void
  height: number
  /** Rows the active kind/status filters hid, for the footer count. */
  hiddenByKind: number
  /** Nodes beyond the listed cap, for the "search to narrow" hint. */
  moreThanListed: number
}) {
  // "+ metrics" columns: off by default (progressive disclosure); rankBy is
  // the metric header the list is sorted by, descending.
  const [metricsOn, setMetricsOn] = useState(false)
  const [rankBy, setRankBy] = useState<MetricKey | undefined>(undefined)

  // Rank a copy, so the coordinator's row order (which feeds the canvas focus
  // fallback) never changes. Nodes with no settled recompute rank as 0%.
  const listed =
    metricsOn && rankBy !== undefined
      ? [...rows].sort((a, b) =>
          rankBy === "recomputes"
            ? b.recomputes - a.recomputes
            : rankBy === "selfUs"
              ? b.selfUs - a.selfUs
              : (b.sameResults / (b.newResults + b.sameResults) || 0) -
                (a.sameResults / (a.newResults + a.sameResults) || 0),
        )
      : rows

  // Flash a row only when its last event actually advances — never on
  // reveal, relayout, or selection.
  const flashRows = useFlashOnChange(rows.map((n) => [n.id, n.last?.id ?? 0]))

  return (
    <section className="nodelist" aria-label="All nodes" style={{ height, maxHeight: height }}>
      <table>
        <thead>
          <tr>
            <th data-tip="The node's label, or kind#id when it has none.">name</th>
            <th data-tip="atom · computed · watcher · effect.">kind</th>
            <th data-tip="Current value preview — or the error / pending reason when the node isn't ok.">
              value
            </th>
            <th data-tip="The node's most recent recorded event.">last event</th>
            {metricsOn
              ? METRIC_COLS.map((c) => (
                  <th
                    key={c.key}
                    className={`num${rankBy === c.key ? " sorted" : ""}`}
                    aria-sort={rankBy === c.key ? "descending" : undefined}
                    data-tip={c.tip}
                    onClick={() => setRankBy(rankBy === c.key ? undefined : c.key)}
                  >
                    {c.label}
                  </th>
                ))
              : undefined}
            <th className="metrics-th">
              <button
                className="tbtn"
                aria-pressed={metricsOn}
                data-tip="Add metric columns — recomputes, run time, unchanged — over the recorded window. Click a column to rank."
                onClick={() => setMetricsOn(!metricsOn)}
              >
                {metricsOn ? "− metrics" : "+ metrics"}
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {listed.map((n) => (
            <tr
              key={n.id}
              className={
                `${n.id === sel ? "selected" : ""} ${flashClass(flashRows, n.id)}`.trim() ||
                undefined
              }
              aria-selected={n.id === sel}
              onClick={() => onPick(n.id)}
            >
              <td>
                <span className="dot" style={{ background: kindVar(n.kind) }} />
                {n.name}
                {isUnstable(
                  n.kind,
                  n.newResults,
                  n.sameResults,
                  n.value === "—" ? undefined : n.value,
                ) ? (
                  <span
                    className="unstable-mark"
                    data-tip="Unstable: returns a new object every run and never memoizes — its subscribers re-run on every change."
                  >
                    ⚠
                  </span>
                ) : undefined}
              </td>
              <td>{n.kind}</td>
              <td
                className="dimtxt"
                style={
                  n.status === "error"
                    ? { color: "var(--danger)" }
                    : n.status === "suspended"
                      ? { color: "var(--suspended)" }
                      : undefined
                }
              >
                {n.status === "error" && n.pending !== undefined
                  ? `! ${n.pending}`
                  : n.status === "suspended"
                    ? `⧗ ${n.value}`
                    : n.value}
              </td>
              <td className="dimtxt">
                {n.last ? `${fmtId("event", n.last.id)} ${n.last.kind}` : "—"}
              </td>
              {metricsOn ? (
                <>
                  <td className="num">{n.recomputes}</td>
                  <td className="num">{fmtTook(n.selfUs)}</td>
                  <td className="num">
                    {n.newResults + n.sameResults > 0
                      ? `${Math.round((n.sameResults / (n.newResults + n.sameResults)) * 100)}%`
                      : ""}
                  </td>
                </>
              ) : undefined}
              <td />
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={metricsOn ? 8 : 5}>
              {rows.length} shown
              {hiddenByKind > 0 ? ` · ${hiddenByKind} hidden by kind` : ""}
              {moreThanListed > 0
                ? ` · ${moreThanListed.toLocaleString()} more — search to narrow`
                : ""}
            </td>
          </tr>
        </tfoot>
      </table>
    </section>
  )
}
