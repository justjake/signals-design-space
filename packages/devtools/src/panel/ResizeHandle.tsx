import { useRef } from "react"

/**
 * A thin drag handle between two panes. `dir: 'v'` resizes height (a horizontal
 * bar you drag up/down); `dir: 'h'` resizes width (a vertical bar you drag
 * left/right). It reports incremental pixel deltas; the parent clamps and
 * stores the size. Pointer capture keeps the drag alive off the handle.
 */
export function ResizeHandle({
  dir,
  onDelta,
}: {
  dir: "v" | "h"
  onDelta: (delta: number) => void
}) {
  const last = useRef<number | undefined>(undefined)
  return (
    <div
      className={`resizer resizer-${dir}`}
      role="separator"
      aria-orientation={dir === "v" ? "horizontal" : "vertical"}
      onPointerDown={(e) => {
        last.current = dir === "v" ? e.clientY : e.clientX
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        if (last.current === undefined) return
        const cur = dir === "v" ? e.clientY : e.clientX
        onDelta(cur - last.current)
        last.current = cur
      }}
      onPointerUp={(e) => {
        last.current = undefined
        e.currentTarget.releasePointerCapture(e.pointerId)
      }}
    />
  )
}

/** Clamp helper for size state. */
export function clampSize(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}
