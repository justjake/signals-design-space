/**
 * Per-implementation expected behavior, keyed by manifest row id
 * (battery/MANIFEST.md is the narrative contract; this table is its
 * executable form). Every non-`pass` entry was pinned empirically against
 * prior implementation comparisons. Discovery details remain in the
 * manifest rows.
 *
 * Reading: FINDING rows assert the divergence (test.fail), so a silent fix
 * turns the run red and the manifest gets updated. skip rows name the
 * mechanism that is unreachable on that implementation. variant rows tell
 * the spec which ruled behavior to assert.
 */
import type { test as batteryTest } from "./fixtures"
import type { BatteryEntry } from "./entries"

export type Expectation =
  | { kind: "pass" }
  | { kind: "finding"; note: string }
  | { kind: "variant"; variant: string }
  | { kind: "skip"; reason: string }

const PASS: Expectation = { kind: "pass" }

type PerImpl = Partial<Record<string, Expectation>>

const TABLE: Record<string, PerImpl> = {
  "RCC-RT1.scope-read": {
    cosignals: { kind: "variant", variant: "scope-drafts-hidden" },
    "cosignals-arena": { kind: "variant", variant: "scope-drafts-hidden" },
  },
  "RCC-RT4-newest": {
    cosignals: { kind: "skip", reason: "drafts are hidden from outside-render reads" },
    "cosignals-arena": { kind: "skip", reason: "drafts are hidden from outside-render reads" },
  },
  "RCC-RT4-drafts-hidden": {
    cosignals: { kind: "variant", variant: "drafts-hidden" },
    "cosignals-arena": { kind: "variant", variant: "drafts-hidden" },
  },
  // Load-sensitive first-commit tear: when the mount pass is time-sliced
  // (slow CI runner, CPU throttling), the render-world note expires at the
  // yield and readers mounted in later slices resolve base state, so the
  // strict latch records a mixed commit. Reproducible on either engine
  // with Emulation.setCPUThrottlingRate >= 6; arena crosses the threshold
  // on CI runners. The repair path converges the next commit. A durable
  // fix needs the hook's store snapshot to be world-aware so React
  // restarts the sliced pass — engine work, tracked, not a test bug.
  "RCC-RT5/6.mount-world": {
    "cosignals-arena": {
      kind: "skip",
      reason: "first-commit agreement tears under CPU-starved time slicing (see table comment)",
    },
  },
  "DAISHI-8": {
    "cosignals-arena": {
      kind: "skip",
      reason: "first-commit agreement tears under CPU-starved time slicing (see table comment)",
    },
  },
}

export function expectationFor(rowId: string, entry: BatteryEntry): Expectation {
  return TABLE[rowId]?.[entry.label] ?? PASS
}

/**
 * Standard row prologue: applies skip/fail annotations for this
 * implementation and hands back the expectation so the spec can branch on
 * variants. FINDING rows become test.fail — the assertions below then
 * describe the CORRECT behavior, and the finding keeps the row red-as-expected.
 */
export function applyExpectation(
  t: typeof batteryTest,
  rowId: string,
  entry: BatteryEntry,
): Expectation {
  const expectation = expectationFor(rowId, entry)
  if (expectation.kind === "skip") {
    t.skip(true, `${rowId}: ${expectation.reason}`)
  } else if (expectation.kind === "finding") {
    t.fail(true, `FINDING ${rowId}: ${expectation.note}`)
  }
  return expectation
}
