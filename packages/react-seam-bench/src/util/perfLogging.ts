/**
 * Fixed-width CSV rows: `framework , test , time` with framework padded to
 * 32 characters, test to 60, time to 8. Downstream tooling (src/chart.mjs,
 * spreadsheet imports) splits on commas and trims whitespace, so values must
 * not contain commas. The header row uses the literal words framework/test/
 * time under the same padding.
 */
export interface PerfResultStrings {
  framework: string
  test: string
  time: string
}

/**
 * Pseudo-test name for the child's single-thread speed probe. The child
 * reports it like any other row; the isolated runner uses it to detect
 * rounds that ran on slow silicon (macOS placing the process on
 * efficiency cores roughly triples it) and excludes the row from output.
 */
export const CALIBRATION_TEST = "__probe__"

const columnWidth: Record<keyof PerfResultStrings, number> = {
  framework: 32,
  test: 60,
  time: 8,
}

function trimColumns(row: PerfResultStrings): PerfResultStrings {
  const trimmed = { ...row }
  for (const key of Object.keys(columnWidth) as Array<keyof PerfResultStrings>) {
    trimmed[key] = (row[key] || "").slice(0, columnWidth[key]).padEnd(columnWidth[key])
  }
  return trimmed
}

export function perfResultHeaders(): PerfResultStrings {
  return { framework: "framework", test: "test", time: "time" }
}

export function formatPerfResult(row: PerfResultStrings): string {
  const t = trimColumns(row)
  return [t.framework, t.test, t.time].join(" , ")
}
