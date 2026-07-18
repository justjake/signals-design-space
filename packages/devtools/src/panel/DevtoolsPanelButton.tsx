import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react"
import type { EngineDevtools } from "../engine.ts"

/**
 * The devtools' inline entry point: a small floating button that opens the
 * panel in an overlay. The heavy panel (views, stylesheet, layout) is code-
 * split and loaded with React.lazy only when first opened — a shimmer shows
 * while it arrives — so a host page that never opens the devtools pays only
 * for this button.
 *
 * The button also owns the recording lifecycle. Tracing costs real time on
 * every signal operation, so nothing is attached to the engine until the user
 * asks: the host passes a `create` factory, and the button builds one session
 * from it on first need, then attaches/detaches its hooks as recording starts
 * and stops. The button has two click targets:
 *
 * - the whole button opens the panel if it is closed, and starts recording if
 *   it is stopped
 * - the record light toggles recording on its own, whether or not the panel
 *   is open (stopping never closes the panel — the recorded data stays up)
 *
 * The button docks to the nearest screen edge and can be dragged along it
 * (defaults to the bottom-right). The overlay pane docks right or bottom and
 * drag-resizes at its inner edge; the panel inside gets its own close (✕) and
 * dock toggle. Everything here is inline-styled so the button needs none of
 * the panel's (lazy) stylesheet.
 */
const Panel = lazy(() => import("./App.tsx").then((m) => ({ default: m.App })))

// Persist the launcher's open/recording/dock/size/position so a full page
// reload — e.g. a Vite reload after editing a non-component devtools module —
// resumes where it was instead of dropping back to a closed, idle button.
const STATE_KEY = "signals-devtools-launcher"
interface Persisted {
  open: boolean
  recording: boolean
  dock: "right" | "bottom"
  size: number
  pos: { x: number; y: number }
}
function loadState(): Partial<Persisted> {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY) ?? "{}") as Partial<Persisted>
  } catch {
    return {}
  }
}

// Launcher chrome, injected inline (the panel's stylesheet is lazy). On-brand
// with the panel: base16 surface, mono, a glowing record light (steady gold
// when idle, pulsing red while recording). The light is its own hit target —
// `.rec` is an inner button padded well past the 8px dot — so it can be
// clicked without triggering the whole-button action.
const LAUNCH_CSS = `
@keyframes signals-devtools-launchpulse { 50% { opacity: .4; } }
.signals-devtools-launch {
  position: fixed; z-index: 2147483001; display: flex; align-items: center; gap: 2px;
  height: 30px; padding: 0 14px 0 4px; border-radius: 8px; box-sizing: border-box;
  font: 600 12px "IBM Plex Mono", ui-monospace, monospace; letter-spacing: .02em;
  color: #d4d3cf; background: #202020; border: 1px solid #383836;
  box-shadow: 0 4px 16px rgba(0,0,0,.45); touch-action: none; cursor: pointer;
  transition: border-color .15s, color .15s, box-shadow .15s;
}
.signals-devtools-launch:hover { color: #f0efed; border-color: #7d7a75; box-shadow: 0 6px 22px rgba(0,0,0,.55); }
.signals-devtools-launch .rec {
  appearance: none; background: none; border: 0; margin: 0; padding: 8px;
  display: flex; align-items: center; justify-content: center; flex: none;
  border-radius: 50%; cursor: pointer;
}
.signals-devtools-launch .rec:hover { background: rgba(255,255,255,.08); }
.signals-devtools-launch .dot { width: 8px; height: 8px; border-radius: 50%; background: #eac26b; box-shadow: 0 0 8px #eac26b; flex: none; }
.signals-devtools-launch.recording .dot { background: #e97366; box-shadow: 0 0 8px #e97366; animation: signals-devtools-launchpulse 1.8s ease-in-out infinite; }
`

export type Corner = "bottom-right" | "bottom-left" | "top-right" | "top-left"
const BTN_W = 140
const BTN_H = 30
const EDGE = 12

function cornerPos(corner: Corner): { x: number; y: number } {
  const right = window.innerWidth - BTN_W - EDGE
  const bottom = window.innerHeight - BTN_H - EDGE
  return {
    x: corner.endsWith("right") ? right : EDGE,
    y: corner.startsWith("bottom") ? bottom : EDGE,
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** Snap a button top-left to the nearest screen edge, clamped along it. */
function snap(x: number, y: number): { x: number; y: number } {
  const W = window.innerWidth
  const H = window.innerHeight
  const dl = x
  const dr = W - (x + BTN_W)
  const dt = y
  const db = H - (y + BTN_H)
  if (Math.min(dl, dr) <= Math.min(dt, db)) {
    return { x: dl < dr ? EDGE : W - BTN_W - EDGE, y: clamp(y, EDGE, H - BTN_H - EDGE) }
  }
  return { x: clamp(x, EDGE, W - BTN_W - EDGE), y: dt < db ? EDGE : H - BTN_H - EDGE }
}

function Shimmer({ dock }: { dock: "right" | "bottom" }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "#191919",
        display: "grid",
        placeItems: "center",
      }}
    >
      <style>{"@keyframes signals-devtools-shimmer{50%{opacity:.35}}"}</style>
      <div
        style={{
          font: "12px system-ui, sans-serif",
          color: "#a19e99",
          animation: "signals-devtools-shimmer 1.2s ease-in-out infinite",
        }}
      >
        loading signals devtools · {dock === "bottom" ? "bottom" : "side"}…
      </div>
    </div>
  )
}

export function DevtoolsPanelButton({
  create,
  defaultCorner = "bottom-right",
  defaultOpen = false,
  defaultRecording = defaultOpen,
  label = "signals",
}: {
  /**
   * Builds the devtools session (collector + trace hooks) for the page's
   * engine, without attaching anything — e.g. `createCosignalsDevtools`. The
   * button calls it at most once, on first need (recording starts or the
   * panel opens), and drives the session's attach/detach from then on.
   */
  create: () => EngineDevtools
  defaultCorner?: Corner
  defaultOpen?: boolean
  /** Start recording as soon as the button mounts. Defaults to `defaultOpen`. */
  defaultRecording?: boolean
  label?: string
}) {
  const saved = useRef(loadState()).current
  const [open, setOpen] = useState(saved.open ?? defaultOpen)
  const [recording, setRecording] = useState(saved.recording ?? defaultRecording)
  const [dock, setDock] = useState<"right" | "bottom">(saved.dock ?? "right")
  const [size, setSize] = useState(() => saved.size ?? Math.round(window.innerWidth * 0.46))
  const [pos, setPos] = useState(() =>
    saved.pos ? snap(saved.pos.x, saved.pos.y) : cornerPos(defaultCorner),
  )
  const drag = useRef<{ gx: number; gy: number; moved: boolean } | undefined>(undefined)

  // The one session for this page, created lazily so an idle page never even
  // builds a collector. The ref is the source of truth (handlers and effects
  // read it); the state mirror re-renders the panel once it exists.
  const sessionRef = useRef<EngineDevtools | null>(null)
  const [session, setSession] = useState<EngineDevtools | null>(null)
  const ensureSession = (): EngineDevtools => {
    let s = sessionRef.current
    if (s === null) {
      s = create()
      sessionRef.current = s
      setSession(s)
    }
    return s
  }

  // Attach the trace hooks while recording; detach on stop and on unmount. A
  // layout effect (not a passive one) so a host that mounts the button inside
  // flushSync has the hooks installed before it renders its app — that's how
  // the first render's nodes and watcher names get captured.
  useLayoutEffect(() => {
    if (!recording) return
    const s = ensureSession()
    s.attach()
    return () => s.detach()
  }, [recording])

  // An open panel needs a collector to display even when recording hasn't
  // started (e.g. the panel was restored open with recording stopped).
  useLayoutEffect(() => {
    if (open) ensureSession()
  }, [open])

  useEffect(() => {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({ open, recording, dock, size, pos }))
    } catch {
      /* private mode — the panel just won't survive a reload */
    }
  }, [open, recording, dock, size, pos])

  // Inject the launcher's stylesheet once (the panel's own CSS is lazy).
  useEffect(() => {
    const id = "signals-devtools-launch-css"
    if (document.getElementById(id) !== null) return
    const el = document.createElement("style")
    el.id = id
    el.textContent = LAUNCH_CSS
    document.head.appendChild(el)
  }, [])

  const overlay =
    dock === "right"
      ? { top: 0, right: 0, height: "100vh", width: size }
      : { left: 0, right: 0, bottom: 0, height: size }

  // Whole-button action: open the panel if it's closed, and start recording
  // if it's stopped. Closing lives on the panel's own ✕; stopping lives on
  // the record light.
  const engage = (): void => {
    if (!open) setOpen(true)
    if (!recording) setRecording(true)
  }

  return (
    <>
      {/* A div-with-button-role rather than a <button>, because the record
          light inside is a real <button> and buttons can't nest. */}
      <div
        role="button"
        tabIndex={0}
        className={`signals-devtools-launch${recording ? " recording" : ""}`}
        aria-label="Open signals devtools and record"
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            engage()
          }
        }}
        onPointerDown={(e) => {
          drag.current = { gx: e.clientX - pos.x, gy: e.clientY - pos.y, moved: false }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (d === undefined) return
          if (Math.abs(e.clientX - (d.gx + pos.x)) + Math.abs(e.clientY - (d.gy + pos.y)) > 3)
            d.moved = true
          setPos(snap(e.clientX - d.gx, e.clientY - d.gy))
        }}
        onPointerUp={(e) => {
          const d = drag.current
          drag.current = undefined
          e.currentTarget.releasePointerCapture(e.pointerId)
          if (d !== undefined && !d.moved) engage()
        }}
        style={{
          left: pos.x,
          top: pos.y,
          width: BTN_W,
          cursor: drag.current?.moved ? "grabbing" : "pointer",
        }}
      >
        <button
          type="button"
          className="rec"
          aria-label={recording ? "Stop recording" : "Start recording"}
          aria-pressed={recording}
          title={recording ? "Stop recording" : "Start recording"}
          // Swallow the pointer stream so the outer target neither drags nor
          // engages; this click only toggles recording.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            setRecording((r) => !r)
          }}
        >
          <span className="dot" />
        </button>
        {label}
      </div>

      {open && session !== null ? (
        <div
          style={{
            position: "fixed",
            ...overlay,
            zIndex: 2147483000,
            boxShadow:
              dock === "right" ? "-2px 0 16px rgba(0,0,0,.5)" : "0 -2px 16px rgba(0,0,0,.5)",
          }}
        >
          <Grip
            dock={dock}
            onResize={(delta) =>
              setSize((s) =>
                clamp(
                  s + delta,
                  280,
                  (dock === "right" ? window.innerWidth : window.innerHeight) - 80,
                ),
              )
            }
          />
          <div style={{ position: "absolute", inset: 0 }}>
            <Suspense fallback={<Shimmer dock={dock} />}>
              <Panel
                backend={session.collector}
                dock={dock}
                onToggleDock={() => setDock((x) => (x === "right" ? "bottom" : "right"))}
                onClose={() => setOpen(false)}
              />
            </Suspense>
          </div>
        </div>
      ) : undefined}
    </>
  )
}

/** Inner-edge resize grip for the overlay pane (inline-styled; no panel CSS). */
function Grip({ dock, onResize }: { dock: "right" | "bottom"; onResize: (delta: number) => void }) {
  const last = useRef<number | undefined>(undefined)
  return (
    <div
      role="separator"
      onPointerDown={(e) => {
        last.current = dock === "right" ? e.clientX : e.clientY
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        if (last.current === undefined) return
        const cur = dock === "right" ? e.clientX : e.clientY
        // Inner edge: dragging toward the page center grows the pane. The
        // delta sign is the same for both docks — the grip is the left edge
        // when docked right and the top edge when docked bottom.
        onResize(last.current - cur)
        last.current = cur
      }}
      onPointerUp={(e) => {
        last.current = undefined
        e.currentTarget.releasePointerCapture(e.pointerId)
      }}
      style={{
        position: "absolute",
        zIndex: 1,
        ...(dock === "right"
          ? { left: 0, top: 0, bottom: 0, width: 6, cursor: "col-resize" }
          : { top: 0, left: 0, right: 0, height: 6, cursor: "row-resize" }),
      }}
    />
  )
}
