/**
 * The graph canvas: an SVG drawing of the focused node's neighborhood, with
 * pan/zoom, viewport culling, frontier stubs, and the depth/zoom/fit controls.
 * Pure presentation of a prebuilt layout — the coordinator (GraphView) decides
 * what the focus is and computes the layout.
 */
import { useEffect, useRef, useState } from "react"
import type { NodeId } from "../protocol.ts"
import { type GraphLayout, glyphFor, NODE_H } from "./graph-layout.ts"
import { KIND_LABEL, KIND_TIP } from "./kind-style.ts"
import { clampSize } from "./ResizeHandle.tsx"
import { flashClass, useFlashOnChange } from "./useFlash.ts"

/** Viewport rectangle in canvas coordinates (an SVG viewBox). */
interface Box {
  x: number
  y: number
  w: number
  h: number
}

export function GraphCanvas({
  layout,
  focusId,
  focusName,
  totalNodes,
  sel,
  depth,
  setDepth,
  onPick,
  onExpandColumn,
}: {
  layout: GraphLayout | undefined
  /** The node the layout is centered on; a change resets pan/zoom. */
  focusId: NodeId | undefined
  /** Display name of the focus, for the status line. */
  focusName: string | undefined
  totalNodes: number
  /** The inspected node — restyled, never moved. */
  sel: NodeId | undefined
  depth: number
  setDepth: (d: number) => void
  onPick: (id: NodeId) => void
  /** Reveal more nodes in a capped column (a frontier stub was clicked). */
  onExpandColumn: () => void
}) {
  // Pan/zoom viewBox; undefined means "fit the whole focus set".
  const [view, setView] = useState<Box | undefined>(undefined)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const panRef = useRef<{ cx: number; cy: number; vx: number; vy: number } | undefined>(undefined)

  // Recentering the canvas resets the viewport.
  useEffect(() => {
    setView(undefined)
  }, [focusId])

  // Flash a node only when its last event actually advances — never on
  // reveal, relayout, or selection.
  const flashNodes = useFlashOnChange(layout ? layout.nodes.map((n) => [n.id, n.lastEventId]) : [])

  // Current viewBox: an explicit pan/zoom box, else fit the whole layout.
  const base: Box | undefined = layout
    ? { x: 0, y: 0, w: layout.width, h: layout.height }
    : undefined
  const vb = view ?? base
  // Live refs so the once-installed wheel listener never reads a stale box.
  const vbRef = useRef<Box | undefined>(vb)
  vbRef.current = vb
  const baseRef = useRef<Box | undefined>(base)
  baseRef.current = base

  // Cull to the viewport (+ margin): only draw nodes/edges near the viewBox,
  // so a deep set stays cheap when zoomed in.
  const M = 40
  const inBox = (x0: number, y0: number, x1: number, y1: number, v: Box) =>
    x0 <= v.x + v.w + M && x1 >= v.x - M && y0 <= v.y + v.h + M && y1 >= v.y - M
  const visNodes =
    layout && vb
      ? layout.nodes.filter((n) => inBox(n.x, n.y, n.x + n.w, n.y + NODE_H, vb))
      : (layout?.nodes ?? [])
  const visEdges =
    layout && vb
      ? layout.edges.filter((e) => inBox(e.minX, e.minY, e.maxX, e.maxY, vb))
      : (layout?.edges ?? [])

  // Zoom around a view-space point, keeping it fixed; clamps to sane extents.
  const zoomAround = (factor: number, px: number, py: number) => {
    const v = vbRef.current
    const b = baseRef.current
    if (v === undefined || b === undefined) return
    const w = Math.max(160, Math.min(b.w * 2.5, v.w * factor))
    const h = w * (v.h / v.w)
    const next = { x: px - (px - v.x) * (w / v.w), y: py - (py - v.y) * (h / v.h), w, h }
    // Wheel events can arrive faster than React renders. Advance the live box
    // immediately so every pinch delta compounds instead of replacing the last.
    vbRef.current = next
    setView(next)
  }
  // Chromium exposes a macOS trackpad pinch as a ctrl+wheel gesture. Plain
  // two-finger motion pans, matching the native canvas gesture vocabulary.
  useEffect(() => {
    const svg = svgRef.current
    if (svg === null) return
    const onWheel = (e: WheelEvent) => {
      const v = vbRef.current
      const b = baseRef.current
      if (v === undefined || b === undefined) return
      e.preventDefault()
      const rect = svg.getBoundingClientRect()
      const scale = Math.min(rect.width / v.w, rect.height / v.h)
      if (e.ctrlKey) {
        const px = v.x + (e.clientX - rect.left - (rect.width - v.w * scale) / 2) / scale
        const py = v.y + (e.clientY - rect.top - (rect.height - v.h * scale) / 2) / scale
        // Base-2 scaling gives small trackpad deltas fine control while a fast
        // pinch can still cross the canvas quickly. Positive delta zooms out.
        const factor = 2 ** Math.max(-1, Math.min(1, e.deltaY * 0.02))
        zoomAround(factor, px, py)
        return
      }

      const next = {
        ...v,
        x: clampSize(v.x + e.deltaX / scale, -v.w * 0.5, b.w - v.w * 0.5),
        y: clampSize(v.y + e.deltaY / scale, -v.h * 0.5, b.h - v.h * 0.5),
      }
      vbRef.current = next
      setView(next)
    }
    svg.addEventListener("wheel", onWheel, { passive: false })
    return () => svg.removeEventListener("wheel", onWheel)
  }, [])

  return (
    <div className="canvas-wrap">
      {layout !== undefined ? (
        <div className="canvas-controls">
          <button
            className="tbtn"
            data-tip="How many levels of dependencies/subscribers to lay out around the focus."
            onClick={() => setDepth(depth >= 3 ? 1 : depth + 1)}
          >
            Depth: {depth}
          </button>
          <span
            role="group"
            aria-label="Zoom"
            style={{
              display: "inline-flex",
              border: "1px solid var(--border)",
              borderRadius: 4,
              overflow: "hidden",
            }}
          >
            <button
              className="tbtn mode"
              aria-label="Zoom out"
              onClick={() =>
                zoomAround(1.25, (vb?.x ?? 0) + (vb?.w ?? 0) / 2, (vb?.y ?? 0) + (vb?.h ?? 0) / 2)
              }
            >
              −
            </button>
            <button
              className="tbtn mode"
              aria-label="Zoom in"
              onClick={() =>
                zoomAround(0.8, (vb?.x ?? 0) + (vb?.w ?? 0) / 2, (vb?.y ?? 0) + (vb?.h ?? 0) / 2)
              }
            >
              +
            </button>
          </span>
          <button
            className="tbtn"
            data-tip="Reset pan and zoom to fit the whole focus set."
            onClick={() => setView(undefined)}
          >
            Fit
          </button>
        </div>
      ) : undefined}
      {layout === undefined ? (
        <div className="canvas-status">no node focused</div>
      ) : (
        <svg
          ref={svgRef}
          viewBox={vb ? `${vb.x} ${vb.y} ${vb.w} ${vb.h}` : "0 0 100 100"}
          preserveAspectRatio="xMidYMid meet"
          aria-label={`Focus graph: ${layout.shown} of ${totalNodes} nodes`}
          style={{ cursor: panRef.current ? "grabbing" : "grab", touchAction: "none" }}
          onPointerDown={(e) => {
            if ((e.target as Element).closest(".node, .stub") !== null || vb === undefined) return
            panRef.current = { cx: e.clientX, cy: e.clientY, vx: vb.x, vy: vb.y }
            e.currentTarget.setPointerCapture(e.pointerId)
          }}
          onPointerMove={(e) => {
            const p = panRef.current
            const svg = svgRef.current
            if (p === undefined || vb === undefined || svg === null) return
            const r = svg.getBoundingClientRect()
            const nx = p.vx - ((e.clientX - p.cx) / r.width) * vb.w
            const ny = p.vy - ((e.clientY - p.cy) / r.height) * vb.h
            // Clamp so the content can't be panned entirely off-screen: at
            // least part of the layout always stays in the viewBox.
            const bw = base?.w ?? vb.w
            const bh = base?.h ?? vb.h
            setView({
              ...vb,
              x: clampSize(nx, -vb.w * 0.5, bw - vb.w * 0.5),
              y: clampSize(ny, -vb.h * 0.5, bh - vb.h * 0.5),
            })
          }}
          onPointerUp={() => {
            panRef.current = undefined
          }}
        >
          <defs>
            <marker
              id="signals-devtools-arr"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0,0.5 L8,4 L0,7.5 z" fill="var(--border-strong)" />
            </marker>
            <marker
              id="signals-devtools-arr-hot"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0,0.5 L8,4 L0,7.5 z" fill="var(--thread)" />
            </marker>
          </defs>
          {visEdges.map((e, i) => (
            // eslint-disable-next-line react/no-array-index-key -- edges are positional
            <path key={i} className={e.hot ? "thread" : `edge${e.dim ? " dim" : ""}`} d={e.d} />
          ))}
          {visNodes.map((n) => (
            <g
              key={n.id}
              className={`node ${n.kind}${n.id === sel ? " selected" : ""}${n.status === "suspended" ? " suspended" : ""}${n.status === "error" ? " error" : ""}${n.hot ? " hot" : ""} ${flashClass(flashNodes, n.id)}`.trimEnd()}
              transform={`translate(${n.x},${n.y})`}
              role="button"
              tabIndex={0}
              aria-label={`${KIND_LABEL[n.kind]} ${n.label}`}
              data-tip={`${KIND_TIP[n.kind]}${n.status !== "ok" ? ` Currently ${n.status}.` : ""}`}
              onClick={() => onPick(n.id)}
            >
              {n.hot ? (
                <rect
                  className="ring"
                  width={n.w}
                  height={NODE_H}
                  rx={5}
                  fill="none"
                  stroke="var(--thread)"
                  strokeWidth={2}
                  opacity={0}
                />
              ) : undefined}
              <rect width={n.w} height={NODE_H} rx={5} />
              {n.status !== "ok" ? (
                <g className={`badge ${n.status === "error" ? "err" : "sus"}`}>
                  <circle cx={n.w - 10} cy={10} r={7} />
                  <text x={n.w - 10} y={13}>
                    {n.status === "error" ? "!" : "⧗"}
                  </text>
                </g>
              ) : undefined}
              {/* Clip label + value to the box: an errored node's message can run
							    far past the right edge, and SVG text doesn't wrap. The badge
							    sits outside the clip so the status glyph is never cut. */}
              <clipPath id={`signals-devtools-nodeclip-${n.id}`}>
                <rect width={n.status !== "ok" ? n.w - 20 : n.w - 8} height={NODE_H} rx={5} />
              </clipPath>
              <g clipPath={`url(#signals-devtools-nodeclip-${n.id})`}>
                <text x={8} y={16}>
                  <tspan className="glyph">{glyphFor(n.kind)}</tspan> {n.label}
                </text>
                <text className="sub status" x={8} y={30}>
                  {n.sub}
                </text>
              </g>
            </g>
          ))}
          {layout.stubs.map((s, i) => (
            // eslint-disable-next-line react/no-array-index-key -- stubs are positional
            <g
              key={i}
              className="stub"
              transform={`translate(${s.x},${s.y})`}
              role="button"
              tabIndex={0}
              onClick={onExpandColumn}
            >
              <rect width={s.w} height={24} />
              <text x={8} y={16}>
                ⊞ <tspan className="count">{s.count}</tspan> more{" "}
                {s.dir === "deps" ? "deps" : "subscribers"}
              </text>
            </g>
          ))}
        </svg>
      )}
      {layout !== undefined && focusName !== undefined ? (
        <div className="canvas-status">
          drawn <b>{visNodes.length}</b> · set <b>{layout.shown}</b> of <b>{totalNodes}</b> · focus{" "}
          <b>{focusName}</b> · depth {depth} · pinch to zoom, drag or scroll to pan
        </div>
      ) : undefined}
    </div>
  )
}
