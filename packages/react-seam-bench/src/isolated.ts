/**
 * Runs the benchmark with each contender in its own node process, so that
 * one contender's JIT warmup, GC pressure, and polymorphic call sites can't
 * affect another contender's numbers — and because cosignals'
 * registration is once-per-process and patches Atom's prototype, two
 * contenders sharing a process would be wrong, not merely noisy.
 *
 * Contenders run in ROUNDS, round-robin (A B C, A B C, ...), and each
 * test's final time is the MEDIAN of its per-round times. Interleaving
 * decorrelates slow machine drift (thermals, background load) from any one
 * contender, and the median discards lucky/unlucky rounds — on a laptop a
 * single sequential pass can move totals by more than the gaps measured.
 * No forced GC between tests: forced collections evict every contender's
 * working set, which distorts comparisons more than the cross-test GC
 * billing they remove.
 *
 * Each child also reports a CPU calibration probe (a fixed spin loop; see
 * child.ts). On Apple Silicon, macOS sometimes places a whole child
 * process on efficiency cores, inflating every number it reports by
 * roughly 3x — a discrete bimodal distribution that medians over a few
 * rounds cannot reliably reject. A round whose probe reads more than
 * PROBE_SLOW_RATIO times the best probe seen is re-run (a bounded number
 * of times), and any still-slow samples are excluded from the medians
 * when cleaner samples exist for that test.
 *
 * Exits 1 if any requested contender produced zero result rows.
 *
 * Usage: node dist/isolated.js [--rounds N] [contenderName...]
 */
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { contenderNames } from "./adapters/names.js"
import { CALIBRATION_TEST, formatPerfResult, perfResultHeaders } from "./util/perfLogging.js"

const childJs = path.join(path.dirname(fileURLToPath(import.meta.url)), "child.js")

/** Probe readings above this multiple of the session's best are treated as slow silicon. */
const PROBE_SLOW_RATIO = 1.5
/** How many times to re-run one contender's round before accepting a slow-silicon result. */
const MAX_PROBE_RETRIES = 2

const argv = process.argv.slice(2)
let rounds = 3
const roundsAt = argv.indexOf("--rounds")
if (roundsAt !== -1) {
  rounds = Number(argv[roundsAt + 1])
  if (!Number.isInteger(rounds) || rounds < 1) {
    console.error("--rounds expects a positive integer")
    process.exit(1)
  }
  argv.splice(roundsAt, 2)
}

const names: readonly string[] = contenderNames
const requested = argv
const unknown = requested.filter((name) => !names.includes(name))
if (unknown.length > 0) {
  console.error(`unknown contenders: ${unknown.join(", ")}; available: ${names.join(", ")}`)
  process.exit(1)
}
const selected = requested.length > 0 ? requested : [...names]

function medianOf(times: number[]): number {
  const sorted = [...times].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

interface Sample {
  time: number
  /** The run's calibration probe, or null if the child never reported one (it crashed). */
  probeMs: number | null
}

interface ChildRun {
  rows: Array<{ test: string; time: number }>
  probeMs: number | null
}

function runChild(name: string): ChildRun {
  const result = spawnSync(process.execPath, [childJs, name], {
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) {
    console.error(
      `⚠ ${name} exited with ${
        result.status !== null ? `code ${result.status}` : result.signal
      } (keeping rows from its other rounds)`,
    )
  }
  const rows: ChildRun["rows"] = []
  let probeMs: number | null = null
  for (const line of (result.stdout ?? "").split("\n")) {
    const parts = line.split(",").map((p) => p.trim())
    if (parts.length < 3 || parts[0] !== name) {
      continue
    }
    const time = Number(parts[2])
    if (!Number.isFinite(time)) {
      continue
    }
    if (parts[1] === CALIBRATION_TEST) {
      probeMs = time
    } else {
      rows.push({ test: parts[1], time })
    }
  }
  return { rows, probeMs }
}

// (contender, test) -> per-round samples; test order preserved per contender.
const samples = new Map<string, Map<string, Sample[]>>()
for (const name of selected) {
  samples.set(name, new Map())
}

let bestProbeMs = Infinity
function noteProbe(probeMs: number | null): void {
  if (probeMs !== null && probeMs < bestProbeMs) {
    bestProbeMs = probeMs
  }
}
function ranOnSlowSilicon(probeMs: number | null): boolean {
  return probeMs !== null && probeMs > bestProbeMs * PROBE_SLOW_RATIO
}

for (let round = 0; round < rounds; round++) {
  for (const name of selected) {
    console.error(`round ${round + 1}/${rounds}: ${name}`)
    let attempt = runChild(name)
    noteProbe(attempt.probeMs)
    for (let retry = 0; ranOnSlowSilicon(attempt.probeMs) && retry < MAX_PROBE_RETRIES; retry++) {
      console.error(
        `⚠ ${name} round ${round + 1} ran on slow silicon ` +
          `(probe ${attempt.probeMs!.toFixed(1)}ms vs best ${bestProbeMs.toFixed(1)}ms); retrying`,
      )
      const again = runChild(name)
      noteProbe(again.probeMs)
      if (again.probeMs !== null && (attempt.probeMs === null || again.probeMs < attempt.probeMs)) {
        attempt = again
      }
    }
    const perTest = samples.get(name)!
    for (const row of attempt.rows) {
      let arr = perTest.get(row.test)
      if (arr === undefined) {
        arr = []
        perTest.set(row.test, arr)
      }
      arr.push({ time: row.time, probeMs: attempt.probeMs })
    }
  }
}

console.log(formatPerfResult(perfResultHeaders()))
for (const name of selected) {
  const perTest = samples.get(name)!
  for (const [test, all] of perTest) {
    // The retry loop's ratio check was against the best probe seen SO FAR,
    // so early rounds may have been accepted on silicon the session later
    // learned was slow. Re-filter against the final best, keeping slow
    // samples only when nothing cleaner exists.
    const clean = all.filter((s) => !ranOnSlowSilicon(s.probeMs))
    const usable = clean.length > 0 ? clean : all
    if (clean.length < all.length) {
      console.error(
        `⚠ ${name} / ${test}: dropped ${all.length - clean.length}/${all.length} slow-silicon rounds`,
      )
    }
    if (usable.length < rounds) {
      console.error(`⚠ ${name} / ${test}: only ${usable.length}/${rounds} rounds used`)
    }
    console.log(
      formatPerfResult({
        framework: name,
        test,
        time: medianOf(usable.map((s) => s.time)).toFixed(2),
      }),
    )
  }
}

// A contender that crashed every round has a header entry but no rows; that
// is a failed run, not a partial one.
const empty = selected.filter((name) => samples.get(name)!.size === 0)
if (empty.length > 0) {
  console.error(`✗ no results for: ${empty.join(", ")}`)
}
process.exit(empty.length > 0 ? 1 : 0)
