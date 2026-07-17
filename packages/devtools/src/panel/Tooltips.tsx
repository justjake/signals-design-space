import { useEffect, useRef } from "react"

/**
 * One tooltip for the whole panel, driven by `data-tip` attributes. Delegated
 * hover/focus on the root shows a fixed card near the target — the same
 * approach the mockups use, and the only way to tip SVG nodes (which can't
 * host a CSS `::after`). Plain DOM; no per-element React, no signals.
 */
export function Tooltips({ root }: { root: HTMLElement | null }) {
  const tipRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const tip = tipRef.current
    if (root === null || tip === null) return

    const show = (el: Element) => {
      const text = el instanceof HTMLElement ? el.dataset.tip : el.getAttribute("data-tip")
      if (!text) return
      tip.textContent = text
      tip.style.display = "block"
      const r = el.getBoundingClientRect()
      const h = tip.offsetHeight
      const below = r.bottom + 6 + h <= window.innerHeight
      tip.style.top = `${below ? r.bottom + 6 : Math.max(6, r.top - h - 6)}px`
      tip.style.left = `${Math.max(6, Math.min(r.left, window.innerWidth - 262))}px`
    }
    const hide = () => {
      tip.style.display = "none"
    }
    const onOver = (e: Event) => {
      const el = (e.target as Element | null)?.closest("[data-tip]")
      if (el !== null && el !== undefined) show(el)
    }
    root.addEventListener("mouseover", onOver)
    root.addEventListener("mouseout", hide)
    root.addEventListener("focusin", onOver)
    root.addEventListener("focusout", hide)
    return () => {
      root.removeEventListener("mouseover", onOver)
      root.removeEventListener("mouseout", hide)
      root.removeEventListener("focusin", onOver)
      root.removeEventListener("focusout", hide)
    }
  }, [root])

  return <div className="svgtip" ref={tipRef} style={{ display: "none" }} role="tooltip" />
}
