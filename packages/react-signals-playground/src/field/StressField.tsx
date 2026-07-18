/**
 * The canvas stress test, ported from the dalien-signals example site: one
 * signal or computed per pixel, one render effect per pixel on top, and a
 * wave driver writing ~10% of the graph per frame. Every library on the
 * roster builds the identical field through the reactivity benchmark's own
 * adapters, so switching libraries compares their schedulers on the same
 * workload — and drawing on the canvas writes into the band under the
 * pointer.
 *
 * React renders the chrome (selectors, buttons); the field itself is
 * imperative. The graph, the frame loop, and the HUD readouts live outside
 * React state: HUD tiles update through refs because per-frame stats would
 * otherwise re-render the section 60 times a second, and the pixel loop
 * paints straight into an ImageData buffer.
 *
 * Nothing here loads until the user starts the field: the graph is built
 * on demand, and the selected library's adapter chunk is fetched then.
 */
import * as React from "react"
import { BAND, buildGraph, makeWaveDriver, type FieldGraph, type WaveDriver } from "./graph"
import { makeRowMix, paintPixel } from "./palette"
import { makeRuntime, type FieldRuntime } from "./runtime"
import { LIBRARIES, libraryByKey, type LibraryEntry } from "./frameworks"

const TIERS: Record<string, readonly [number, number]> = {
  "320p": [568, 320],
  "480p": [854, 480],
  "720p": [1280, 720],
}
type Mode = "off" | "wave" | "storm"

function tierPixels(tierKey: string): number {
  const [w, h] = TIERS[tierKey]
  return w * h
}

function tierFits(entry: LibraryEntry, tierKey: string): boolean {
  return entry.fieldMaxPixels === undefined || tierPixels(tierKey) <= entry.fieldMaxPixels
}

/** The largest tier the library can hold, falling back to the smallest. */
function clampTier(entry: LibraryEntry, tierKey: string): string {
  if (tierFits(entry, tierKey)) return tierKey
  const keys = Object.keys(TIERS)
  for (let i = keys.length - 1; i >= 0; i--) {
    if (tierPixels(keys[i]) < tierPixels(tierKey) && tierFits(entry, keys[i])) {
      return keys[i]
    }
  }
  return keys[0]
}

interface FieldView {
  rt: FieldRuntime
  graph: FieldGraph
  driver: WaveDriver
  w: number
  h: number
  image: ImageData
  vals: Float32Array
  flash: Float32Array
  flashList: Int32Array
  flashEnd: number
  rowMix: Float32Array
}

interface FieldStatsView {
  nodes: string
  edges: string
  buildMs: string
}

function buildView(framework: Parameters<typeof makeRuntime>[0], tier: string): FieldView {
  const [w, h] = TIERS[tier]
  const rt = makeRuntime(framework)
  const count = w * h
  const image = new ImageData(w, h)
  const data = image.data
  const vals = new Float32Array(count)
  // Glow bookkeeping: flash[i] is pixel i's glow level, and the first
  // flashEnd entries of flashList are exactly the pixels with glow > 0.
  // The render loop decays that list instead of scanning the field, and
  // flash[i] === 0 doubles as "not in the list", so a pixel is never
  // appended twice.
  const flash = new Float32Array(count)
  const flashList = new Int32Array(count)
  const rowMix = makeRowMix(h)
  const view: FieldView = {
    rt,
    graph: undefined as unknown as FieldGraph,
    driver: undefined as unknown as WaveDriver,
    w,
    h,
    image,
    vals,
    flash,
    flashList,
    flashEnd: 0,
    rowMix,
  }
  // Everything the graph owns — signals, computeds, render effects — is
  // created inside the runtime's build scope, so dispose() can hand the
  // whole graph back through the framework's own ownership mechanism.
  rt.build(() => {
    const graph = buildGraph(w, h, rt)
    view.graph = graph
    const get = rt.get
    const ids = graph.ids
    // Settle the graph before wiring watchers: a plain read pass evaluates
    // every cell in dependency order, so effect creation links into a
    // finished graph and does uniform work per pixel, instead of driving
    // cold cascades of arbitrary depth from inside each effect body.
    for (let i = 0; i < ids.length; i++) {
      get(ids[i])
    }
    // One render effect per pixel: the finest possible subscription, so
    // each library's own scheduler decides exactly which pixels repaint.
    // An effect reruns only when its cell produced a new value (every
    // library here cuts propagation on equality), so the body repaints
    // unconditionally — running at all is the proof of change.
    const renderPixel = (i: number, mix: number) => (): void => {
      const v0 = get(ids[i])
      vals[i] = v0
      if (flash[i] === 0) flashList[view.flashEnd++] = i
      flash[i] = 1
      paintPixel(data, i, v0, 1, mix)
    }
    for (let y = 0, i = 0; y < h; y++) {
      const mix = rowMix[y]
      for (let x = 0; x < w; x++, i++) {
        rt.effect(renderPixel(i, mix))
      }
    }
  })
  view.driver = makeWaveDriver(view.graph)
  return view
}

export function StressField(): React.ReactElement {
  const [lib, setLib] = React.useState("cosignals")
  const [tier, setTier] = React.useState("480p")
  const [mode, setMode] = React.useState<Mode>("wave")
  const [status, setStatus] = React.useState<"idle" | "building" | "running" | "failed">("idle")
  const [note, setNote] = React.useState("Choose a library and start. Code loads on demand.")
  const [stats, setStats] = React.useState<FieldStatsView | null>(null)

  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const frameEl = React.useRef<HTMLElement | null>(null)
  const recomputedEl = React.useRef<HTMLElement | null>(null)
  const shareEl = React.useRef<HTMLElement | null>(null)
  const fpsEl = React.useRef<HTMLElement | null>(null)
  const viewRef = React.useRef<FieldView | null>(null)
  const modeRef = React.useRef<Mode>(mode)
  modeRef.current = mode
  // Monotonic build tokens: a stale async build (library switched while a
  // chunk downloaded) must never install its view over a newer one.
  const buildSeq = React.useRef(0)

  const disposeView = React.useCallback(() => {
    const view = viewRef.current
    viewRef.current = null
    view?.rt.dispose()
  }, [])

  const start = React.useCallback(
    async (libKey: string, tierKey: string) => {
      const seq = ++buildSeq.current
      setStatus("building")
      setNote(`Building ${libKey} at ${tierKey}…`)
      try {
        const framework = await libraryByKey(libKey).load()
        if (seq !== buildSeq.current) return
        // Two frames so the "building…" note paints before the multi-second
        // synchronous build blocks the main thread.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        if (seq !== buildSeq.current) return
        disposeView()
        const t0 = performance.now()
        const view = buildView(framework, tierKey)
        if (seq !== buildSeq.current) {
          view.rt.dispose()
          return
        }
        const canvas = canvasRef.current
        if (canvas !== null) {
          canvas.width = view.w
          canvas.height = view.h
        }
        viewRef.current = view
        setStats({
          nodes: view.graph.nodes.toLocaleString(),
          edges: view.graph.edges.toLocaleString(),
          buildMs: `${(performance.now() - t0).toFixed(0)} ms`,
        })
        setStatus("running")
        setNote(
          `${libKey} at ${tierKey}. ${view.graph.nodes.toLocaleString()} nodes. Draw on the canvas.`,
        )
      } catch (error) {
        if (seq !== buildSeq.current) return
        setStatus("failed")
        setNote(`Could not build ${libKey} at ${tierKey}: ${String(error)}`)
      }
    },
    [disposeView],
  )

  // The frame loop runs for the component's lifetime and no-ops without a
  // view; per-frame stats go straight to the DOM through refs.
  React.useEffect(() => {
    let raf = 0
    let frames = 0
    let fpsWindow = performance.now()
    const setText = (ref: React.RefObject<HTMLElement | null>, text: string): void => {
      if (ref.current !== null) ref.current.textContent = text
    }
    const frame = (): void => {
      raf = requestAnimationFrame(frame)
      const view = viewRef.current
      if (view === null) return
      const { graph, rt } = view
      graph.stats.recomputes = 0
      graph.stats.deepRecomputes = 0
      graph.stats.wideRecomputes = 0
      const m = modeRef.current
      const t0 = performance.now()
      rt.batch(() => {
        if (m === "wave") {
          view.driver.step(rt)
        } else if (m === "storm") {
          const drops = Math.max(4, view.w >> 7)
          for (let k = 0; k < drops; k++) {
            const band = graph.bandSources[Math.floor(Math.random() * graph.bandSources.length)]
            rt.set(band.cells[Math.floor(Math.random() * view.w)], Math.random() * 0.9)
          }
        }
      })
      const ms = performance.now() - t0
      if (m === "wave") view.driver.observe()
      setText(frameEl, `${ms.toFixed(2)} ms`)
      setText(recomputedEl, Math.round(graph.stats.recomputes).toLocaleString())
      setText(shareEl, `${((graph.stats.recomputes / graph.nodes) * 100).toFixed(1)}%`)

      // The glow pass walks only the pixels with active glow — the live
      // prefix of flashList — compacting the list in place as entries fade
      // out, so its cost tracks recent change, not field size.
      if (view.flashEnd > 0) {
        const { image, flash, flashList, vals, rowMix, w } = view
        const data = image.data
        const end = view.flashEnd
        let live = 0
        for (let k = 0; k < end; k++) {
          const i = flashList[k]
          const mix = rowMix[(i / w) | 0]
          const f = flash[i] * 0.66
          if (f > 0.02) {
            flash[i] = f
            flashList[live++] = i
            paintPixel(data, i, vals[i], f, mix)
          } else {
            flash[i] = 0 // 0 also means "not in the list"
            paintPixel(data, i, vals[i], 0, mix)
          }
        }
        view.flashEnd = live
        canvasRef.current?.getContext("2d")?.putImageData(image, 0, 0)
      }

      frames++
      const now = performance.now()
      if (now - fpsWindow > 500) {
        setText(fpsEl, String(Math.round((frames * 1000) / (now - fpsWindow))))
        frames = 0
        fpsWindow = now
      }
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      disposeView()
    }
  }, [disposeView])

  // Pointer painting: writes into the source row of the band under the
  // pointer. Left button paints light, right button paints dark.
  const paintingRef = React.useRef(false)
  const paint = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const view = viewRef.current
    const canvas = canvasRef.current
    if (view === null || canvas === null) return
    const dark = (e.buttons & 2) !== 0 || e.button === 2
    const rect = canvas.getBoundingClientRect()
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * view.w)
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * view.h)
    const { graph, rt } = view
    const band =
      graph.bandSources[
        Math.min(graph.bandSources.length - 1, Math.max(0, Math.floor(y / BAND)))
      ]
    const brush = Math.max(2, view.w >> 7)
    rt.batch(() => {
      for (let dx = -brush; dx <= brush; dx++) {
        const value = dark ? 0 : 1 - (Math.abs(dx) / (brush + 1)) * 0.7
        rt.set(band.cells[(x + dx + view.w) % view.w], value)
      }
    })
  }

  const running = status === "running"
  const switchTo = (libKey: string, tierKey: string): void => {
    // A library with a capacity ceiling drops to the largest tier it fits.
    const fitted = clampTier(libraryByKey(libKey), tierKey)
    setLib(libKey)
    setTier(fitted)
    // Only rebuild live: before the first start, selection is just setup.
    if (viewRef.current !== null || status === "building") {
      void start(libKey, fitted)
    }
  }

  return (
    <div className="field">
      <div className="field-controls">
        <div className="knob">
          <label>library</label>
          <span className="libpick wrap">
            {LIBRARIES.map((entry) => (
              <button
                key={entry.key}
                type="button"
                className={lib === entry.key ? "on" : undefined}
                title={entry.slow === undefined ? entry.label : `${entry.label}: ${entry.slow}`}
                onClick={() => switchTo(entry.key, tier)}
              >
                {entry.label}
                {entry.slow === undefined ? "" : " ⚠"}
              </button>
            ))}
          </span>
        </div>
        <div className="knob">
          <label>resolution</label>
          <span className="libpick">
            {Object.keys(TIERS).map((key) => {
              const fits = tierFits(libraryByKey(lib), key)
              return (
                <button
                  key={key}
                  type="button"
                  className={tier === key ? "on" : undefined}
                  disabled={!fits}
                  title={fits ? undefined : `${lib} can't hold this many cells`}
                  onClick={() => switchTo(lib, key)}
                >
                  {key}
                </button>
              )
            })}
          </span>
        </div>
        <div className="knob">
          <label>writes</label>
          <span className="libpick">
            {(["off", "wave", "storm"] as const).map((key) => (
              <button
                key={key}
                type="button"
                className={mode === key ? "on" : undefined}
                onClick={() => setMode(key)}
              >
                {key}
              </button>
            ))}
          </span>
        </div>
        {running ? null : (
          <button
            type="button"
            className="field-start"
            disabled={status === "building"}
            onClick={() => void start(lib, tier)}
          >
            {status === "building" ? "building…" : "start field"}
          </button>
        )}
      </div>

      <section id="field-hud" aria-label="field stats">
        <div className="stat">
          <span ref={(el) => void (frameEl.current = el)}>–</span>
          <label>write and propagate per frame</label>
        </div>
        <div className="stat">
          <span ref={(el) => void (recomputedEl.current = el)}>–</span>
          <label>cells recomputed</label>
        </div>
        <div className="stat">
          <span ref={(el) => void (shareEl.current = el)}>–</span>
          <label>share of graph</label>
        </div>
        <div className="stat">
          <span ref={(el) => void (fpsEl.current = el)}>–</span>
          <label>fps</label>
        </div>
        <div className="stat">
          <span>{stats?.nodes ?? "–"}</span>
          <label>nodes</label>
        </div>
        <div className="stat">
          <span>{stats?.edges ?? "–"}</span>
          <label>edges</label>
        </div>
        <div className="stat">
          <span>{stats?.buildMs ?? "–"}</span>
          <label>build</label>
        </div>
      </section>

      <canvas
        ref={canvasRef}
        className="field-canvas"
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          paintingRef.current = true
          e.currentTarget.setPointerCapture(e.pointerId)
          paint(e)
        }}
        onPointerMove={(e) => {
          if (paintingRef.current) paint(e)
        }}
        onPointerUp={() => {
          paintingRef.current = false
        }}
      />
      <p className="hint">{note}</p>
    </div>
  )
}
