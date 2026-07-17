/**
 * The log's timeline strip: one tick per entry (durationful spans draw as
 * bars), one span bar per multi-entry operation, and a drag-to-brush time
 * window. The coordinator (LogView) owns the brushed window and filters the
 * table by it.
 */
import { useRef } from "react"
import type { EventId, KindClass } from "../protocol.ts"
import type { LogRow, OpGroup } from "./viewmodel.ts"

/** KindClass → the base color var used for timeline ticks. */
function classVar(cls: KindClass): string {
  switch (cls) {
    case "write":
      return "atom"
    case "compute":
      return "computed"
    case "notify":
    case "render":
      return "watcher"
    case "effect":
      return "effect"
    case "error":
      return "danger"
    case "async":
      return "suspended"
    case "origin":
      return "thread"
    case "hot":
      return "hot"
    case "batch":
    case "system":
      return "system"
    default: {
      const exhaustive: never = cls
      return exhaustive
    }
  }
}

export function LogTimeline({
  rows,
  ops,
  brush,
  setBrush,
  selT,
}: {
  /** All entries in the recorded window (unfiltered by search/brush). */
  rows: LogRow[]
  /** Per-operation rollups, for the span bars. */
  ops: ReadonlyMap<EventId, OpGroup>
  /** Brushed time window [t0, t1] in µs, or undefined for the full window. */
  brush: [number, number] | undefined
  setBrush: (b: [number, number] | undefined) => void
  /** The selected entry's time, for the cursor line. */
  selT: number | undefined
}) {
  const tlRef = useRef<SVGSVGElement | null>(null)
  const brushing = useRef<number | undefined>(undefined)

  const minT = rows.length ? rows[0].t : 0
  const span = Math.max(1, (rows.length ? rows[rows.length - 1].t : 1) - minT)
  const x = (t: number) => 40 + ((t - minT) / span) * 1120
  // Inverse of x: a client x-coordinate on the timeline → a time (µs), clamped.
  const tAt = (clientX: number): number => {
    const el = tlRef.current
    if (el === null) return minT
    const r = el.getBoundingClientRect()
    const sx = ((clientX - r.left) / r.width) * 1200
    return Math.max(minT, Math.min(minT + span, minT + ((sx - 40) / 1120) * span))
  }

  return (
    <div className="timeline">
      <svg
        ref={tlRef}
        viewBox="0 0 1200 56"
        preserveAspectRatio="none"
        aria-label="Timeline — drag to select a time window, click to clear"
        style={{ cursor: "crosshair", touchAction: "none" }}
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
          if (start !== undefined && Math.abs(tAt(e.clientX) - start) < span * 0.01)
            setBrush(undefined)
        }}
      >
        {[...ops.entries()]
          .filter(([, g]) => g.count > 1)
          .map(([root, g]) => {
            const x0 = x(g.minT)
            return (
              <rect
                key={root}
                className="tl-span"
                x={x0}
                y={6}
                width={Math.max(3, x(g.maxT) - x0)}
                height={9}
                fill="var(--border-strong)"
              />
            )
          })}
        {rows.map((r) => {
          // A durationful event (a compute/effect span) draws as a bar whose
          // width is its time, so a slow one is visibly wide on the strip;
          // instantaneous events stay a thin tick.
          const w = r.took !== undefined && r.took > 0 ? Math.max(2, x(r.t + r.took) - x(r.t)) : 2
          return (
            <rect
              key={r.id}
              x={x(r.t)}
              y={44}
              width={w}
              height={8}
              fill={`var(--${classVar(r.cls)})`}
            />
          )
        })}
        {brush !== undefined ? (
          <rect
            className="tl-window"
            x={x(brush[0])}
            y={2}
            width={Math.max(2, x(brush[1]) - x(brush[0]))}
            height={52}
            rx={3}
          />
        ) : undefined}
        {selT !== undefined ? (
          <rect className="tl-cursor" x={x(selT) - 1} y={2} width={2} height={52} />
        ) : undefined}
      </svg>
    </div>
  )
}
