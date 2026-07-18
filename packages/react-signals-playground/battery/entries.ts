/**
 * The battery's view of the two engines. Segments, labels, and names come
 * straight from the app's own implementation table
 * (src/engine/implementations.ts), so a new engine row automatically
 * becomes a candidate battery project.
 *
 * `holdStyle` is a historical field from the multi-engine era, when some
 * engines could not suspend inside a transition ("defer-write"). Both
 * remaining engines hold transitions open through Suspense; the smoke spec
 * still verifies this table against the running page
 * (window.__store.holdStyle under ?test=1), so drift fails loudly.
 */
import { implementationHref, implementations } from "../src/engine/implementations"

export type HoldStyle = "suspense" | "defer-write"

export interface BatteryEntry {
  /** Playwright project name; also the app tab label. */
  readonly label: string
  /** Shim `name` — the impl-name HUD tile must show exactly this. */
  readonly name: string
  /** Page path for this implementation. */
  readonly path: string
  /** How this implementation holds a transition open on async data. */
  readonly holdStyle: HoldStyle
}

const HOLD_STYLES: Record<string, HoldStyle> = {
  cosignals: "suspense",
  "cosignals-arena": "suspense",
}

export const ENTRIES: readonly BatteryEntry[] = implementations.map((impl) => {
  const holdStyle = HOLD_STYLES[impl.label]
  if (holdStyle === undefined) {
    throw new Error(
      `battery/entries.ts has no holdStyle for implementation "${impl.label}" — ` +
        "add it here and to the expectations table",
    )
  }
  return {
    label: impl.label,
    name: impl.name,
    path: implementationHref(impl),
    holdStyle,
  }
})
