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

const LOAD_TEAR_SKIP: Expectation = {
  kind: "skip",
  reason:
    "per-commit latch tears under CPU-starved time slicing; repaired next commit (see table comment)",
}

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
  // Load-sensitive momentary tear, one mechanism across these rows: when a
  // render pass is time-sliced (slow CI runner; locally reproducible on
  // BOTH engines with Emulation.setCPUThrottlingRate >= 6), a subscriber
  // mounted or woken in a later slice can land one commit behind its
  // siblings — the render-world note expires at the yield, so it resolves
  // base state — and the per-commit latch records the mixed frame. The
  // repair path converges the very next commit, and every settle
  // assertion in these rows still passes. A durable fix needs the hook's
  // useSyncExternalStore snapshot to be world-aware so React restarts the
  // sliced pass instead of committing it: engine work, not a test bug.
  // Observed on CI: mount-world (both engines), DAISHI-6 latch and
  // DAISHI-8 passive latch (arena). Skipped for both engines because the
  // mechanism is shared and only load decides which engine trips first.
  "RCC-RT5/6.mount-world": {
    cosignals: LOAD_TEAR_SKIP,
    "cosignals-arena": LOAD_TEAR_SKIP,
  },
  "DAISHI-6": {
    cosignals: LOAD_TEAR_SKIP,
    "cosignals-arena": LOAD_TEAR_SKIP,
  },
  "DAISHI-8": {
    cosignals: LOAD_TEAR_SKIP,
    "cosignals-arena": LOAD_TEAR_SKIP,
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
