/**
 * In-page benchmarks: the reactivity benchmark submodule's actual suites
 * (sbench, kairo, cellx, dynamic) over its actual framework adapters.
 * Every (suite, library) cell runs in a FRESH Worker — a new realm with
 * untrained modules — the browser analogue of the CI methodology's
 * process-per-framework isolation. One round on the viewing machine:
 * indicative; the cosignals README's CI charts are the scoreboard.
 *
 * The library checklist decides which columns run. A handful default on;
 * everything else on the roster is one checkbox away.
 */
import * as React from "react"
import { LIBRARIES } from "../field/frameworks"
import type { BenchRequest, BenchResponse } from "./benchWorker"

const SUITES = [
  { key: "sbench", label: "sbench: create & update" },
  { key: "kairo", label: "kairo: propagation shapes" },
  { key: "cellx", label: "cellx: layered grids" },
  { key: "dynamic", label: "dynamic: changing graphs" },
] as const

// Fixed categorical palette by roster order, so a library keeps its color
// across runs regardless of which subset is checked.
const COLORS = [
  "#7fd4ff",
  "#b48bff",
  "#ffd479",
  "#6fdc9c",
  "#ff8f8f",
  "#2a78d6",
  "#eda100",
  "#1baf7a",
  "#d66ad0",
  "#8fd3c7",
  "#c2b280",
  "#7a9cff",
  "#e0709a",
  "#69c3e8",
  "#a3d977",
  "#f2975a",
]
const colorOf = new Map(LIBRARIES.map((lib, index) => [lib.key, COLORS[index % COLORS.length]]))

function runCell(
  suite: string,
  lib: string,
  onTest: (test: string, time: number) => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./benchWorker.ts", import.meta.url), { type: "module" })
    const fail = (error: Error): void => {
      clearTimeout(timeout)
      worker.terminate()
      reject(error)
    }
    const timeout = setTimeout(() => fail(new Error("timeout")), 300_000)
    worker.onmessage = (e: MessageEvent<BenchResponse>) => {
      const message = e.data
      switch (message.type) {
        case "test":
          onTest(message.test, message.time)
          break
        case "done":
          clearTimeout(timeout)
          worker.terminate()
          resolve(message.totalMs)
          break
        case "error":
          fail(new Error(message.message))
          break
        default: {
          const exhaustive: never = message
          fail(new Error(`unexpected worker message ${JSON.stringify(exhaustive)}`))
        }
      }
    }
    worker.onerror = (event) => fail(new Error(event.message || "worker error"))
    worker.postMessage({ suite, lib } satisfies BenchRequest)
  })
}

type Results = Record<string, Record<string, number>>

export function BenchSection(): React.ReactElement {
  const [checked, setChecked] = React.useState<ReadonlySet<string>>(
    () => new Set(LIBRARIES.filter((lib) => lib.benchDefault).map((lib) => lib.key)),
  )
  const [running, setRunning] = React.useState(false)
  const [progress, setProgress] = React.useState("")
  const [results, setResults] = React.useState<Results | null>(null)
  const [failures, setFailures] = React.useState<readonly string[]>([])

  const toggle = (key: string): void => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  const run = async (): Promise<void> => {
    if (running) return
    const libs = LIBRARIES.filter((lib) => checked.has(lib.key))
    if (libs.length === 0) {
      setProgress("check at least one library")
      return
    }
    setRunning(true)
    setFailures([])
    const out: Results = {}
    const failed: string[] = []
    for (const suite of SUITES) {
      out[suite.key] = {}
      for (const lib of libs) {
        setProgress(`${suite.label} / ${lib.label}`)
        // A cell failure (a worker can overflow its stack where the same
        // suite passes under Node) skips that bar, not the run.
        try {
          out[suite.key][lib.key] = await runCell(suite.key, lib.key, (test, time) => {
            setProgress(`${suite.label} / ${lib.label} / ${test}: ${time.toFixed(0)} ms`)
          })
        } catch (error) {
          failed.push(`${suite.key}/${lib.label}: ${(error as Error).message ?? error}`)
        }
        setResults({ ...out })
        setFailures([...failed])
      }
    }
    setProgress("Done. One fresh worker per cell and one round on this machine.")
    setRunning(false)
  }

  return (
    <div className="bench">
      <div className="bench-libs">
        {LIBRARIES.map((lib) => (
          <label key={lib.key} className="bench-lib">
            <input
              type="checkbox"
              checked={checked.has(lib.key)}
              disabled={running}
              onChange={() => toggle(lib.key)}
            />
            <span className="bench-dot" style={{ background: colorOf.get(lib.key) }} />
            {lib.label}
            {lib.slow === undefined ? "" : <span className="lib-slow">{lib.slow}</span>}
          </label>
        ))}
      </div>
      <div className="actions">
        <button type="button" onClick={() => void run()} disabled={running}>
          {running ? "running…" : "run benchmarks"}
        </button>
        <span className="hint">{progress}</span>
      </div>
      {results === null ? null : <BenchChart results={results} />}
      {failures.length === 0 ? null : (
        <p className="hint">Skipped: {failures.join(" · ")}</p>
      )}
    </div>
  )
}

function BenchChart({ results }: { results: Results }): React.ReactElement {
  const groups = SUITES.filter(
    (suite) => results[suite.key] !== undefined && Object.keys(results[suite.key]).length > 0,
  )
  const rowH = 22
  const rows: React.ReactElement[] = []
  let y = 8
  for (const suite of groups) {
    const times = results[suite.key]
    const best = Math.min(...Object.values(times))
    rows.push(
      <text key={`${suite.key}-name`} className="bench-name" x={0} y={y + 12}>
        {suite.label}, total
      </text>,
    )
    y += 20
    for (const lib of LIBRARIES) {
      const time = times[lib.key]
      if (time === undefined) continue
      const ratio = time / best
      const w = Math.min(520, (ratio / 3) * 520)
      rows.push(
        <React.Fragment key={`${suite.key}-${lib.key}`}>
          <rect x={170} y={y + 4} width={w} height={14} rx={4} fill={colorOf.get(lib.key)} />
          <text className="lib" x={164} y={y + 15}>
            {lib.label}
          </text>
          <text className="val" x={176 + w} y={y + 15}>
            {time.toFixed(0)} ms · {ratio.toFixed(2)}×
          </text>
        </React.Fragment>,
      )
      y += rowH
    }
    y += 20
  }
  return (
    <div className="bench-chart">
      <svg
        viewBox={`0 0 780 ${y}`}
        role="img"
        aria-label="Suite totals by library; bars show time relative to the fastest library per suite, lower is better"
      >
        {rows}
      </svg>
      <p className="hint">
        Each bar shows the suite total relative to the fastest result. Lower is better. Each cell
        runs once in a fresh worker. The package READMEs link to interleaved CI results.
      </p>
    </div>
  )
}
