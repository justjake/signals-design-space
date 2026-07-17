import { useEffect, useRef, useState } from "react"

/**
 * Theme editor — the whole UI derives from 16 base colors (base16). Edit them
 * as swatches or paste a base16 palette as JSON; Apply writes them as CSS
 * custom properties on the panel root, so every color re-derives at once.
 * Nothing here touches the host page's styles.
 */

const KEYS = [
  "base00",
  "base01",
  "base02",
  "base03",
  "base04",
  "base05",
  "base06",
  "base07",
  "base08",
  "base09",
  "base0A",
  "base0B",
  "base0C",
  "base0D",
  "base0E",
  "base0F",
] as const
type Key = (typeof KEYS)[number]

const ROLE: Record<Key, string> = {
  base00: "background",
  base01: "panels",
  base02: "lines",
  base03: "faint text",
  base04: "muted text",
  base05: "text",
  base06: "bright",
  base07: "brightest",
  base08: "red · error",
  base09: "orange",
  base0A: "yellow · you",
  base0B: "green · effect",
  base0C: "cyan · compute",
  base0D: "blue · async",
  base0E: "purple · render",
  base0F: "pink",
}

const DEFAULT: Record<Key, string> = {
  base00: "#191919",
  base01: "#202020",
  base02: "#383836",
  base03: "#7d7a75",
  base04: "#a19e99",
  base05: "#d4d3cf",
  base06: "#f0efed",
  base07: "#f9f8f7",
  base08: "#e97366",
  base09: "#de9255",
  base0A: "#eac26b",
  base0B: "#72bc8f",
  base0C: "#4fb9c9",
  base0D: "#5e9fe8",
  base0E: "#bf8eda",
  base0F: "#df84a8",
}

function norm(h: string): string | undefined {
  let s = h.trim()
  if (!s.startsWith("#")) s = "#" + s
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : undefined
}

/** `root` is the `.signals-devtools-root` element the vars live on. */
export function ThemeDialog({
  open,
  onClose,
  root,
}: {
  open: boolean
  onClose: () => void
  root: HTMLElement | null
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [draft, setDraft] = useState<Record<Key, string>>(DEFAULT)
  const [note, setNote] = useState<{ text: string; kind: "" | "ok" | "err" }>({
    text: "",
    kind: "",
  })

  // Drive the native modal from the `open` prop (guarded for jsdom).
  useEffect(() => {
    const dlg = dialogRef.current
    if (dlg === null) return
    if (open) {
      // Seed the draft from whatever is currently applied.
      if (root !== null) {
        const cs = getComputedStyle(root)
        const next = { ...DEFAULT }
        for (const k of KEYS) next[k] = norm(cs.getPropertyValue("--" + k)) ?? DEFAULT[k]
        setDraft(next)
      }
      setNote({ text: "", kind: "" })
      if (typeof dlg.showModal === "function" && !dlg.open) dlg.showModal()
    } else if (typeof dlg.close === "function" && dlg.open) {
      dlg.close()
    }
  }, [open, root])

  const apply = (theme: Record<Key, string>) => {
    if (root === null) return
    for (const k of KEYS) root.style.setProperty("--" + k, theme[k])
  }

  const onJson = (text: string) => {
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      setNote({ text: "Not valid JSON yet.", kind: "err" })
      return
    }
    const pal =
      (data as { palette?: Record<string, unknown> }).palette ?? (data as Record<string, unknown>)
    const next = { ...draft }
    let n = 0
    for (const k of KEYS) {
      const v = pal[k]
      const hex = typeof v === "string" ? norm(v) : undefined
      if (hex !== undefined) {
        next[k] = hex
        n++
      }
    }
    setDraft(next)
    setNote({ text: `${n} of 16 colors loaded — Apply to use.`, kind: "ok" })
  }

  return (
    <dialog ref={dialogRef} className="theme-dialog" aria-label="Theme" onClose={onClose}>
      <div className="td-head">
        <strong>Theme</strong>
        <span className="td-sub">16 base colors — everything derives from these</span>
        <button type="button" className="td-x" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="td-body">
        <div className="td-swatches">
          {KEYS.map((k) => (
            <div className="td-row" key={k}>
              <input
                type="color"
                aria-label={k}
                value={draft[k]}
                onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
              />
              <span className="td-key">{k}</span>
              <span className="td-role">{ROLE[k]}</span>
              <input
                className="td-hex"
                value={draft[k]}
                spellCheck={false}
                onChange={(e) => {
                  const hex = norm(e.target.value)
                  setDraft({ ...draft, [k]: hex ?? e.target.value })
                }}
              />
            </div>
          ))}
        </div>
        <label className="td-json-label" htmlFor="td-json">
          Or paste a base16 theme (JSON)
        </label>
        <textarea
          id="td-json"
          className="td-json"
          spellCheck={false}
          placeholder={'{ "base00": "#191919", "base01": "#202020", … }'}
          onChange={(e) => onJson(e.target.value)}
        />
        <div className={`td-note ${note.kind}`}>{note.text}</div>
      </div>
      <div className="td-foot">
        <button type="button" className="tbtn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="tbtn"
          onClick={() => {
            setDraft(DEFAULT)
            apply(DEFAULT)
            setNote({ text: "Reset to default.", kind: "" })
          }}
        >
          Reset to default
        </button>
        <button
          type="button"
          className="tbtn td-apply"
          onClick={() => {
            apply(draft)
            onClose()
          }}
        >
          Apply
        </button>
      </div>
    </dialog>
  )
}
