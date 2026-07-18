/**
 * The transition seam: rewrite all 2000 cells inside React.startTransition
 * while urgent clicks keep arriving on an unrelated button. Bindings that
 * classify external writes into the transition let each click commit
 * quickly while the bulk re-render proceeds at transition priority.
 * useSyncExternalStore contenders instead re-render synchronously (see
 * adapters/useReactive.ts), so a click that lands during their blocking
 * flush waits for all of it — that asymmetry in the p95 is the
 * measurement, not a harness bug.
 *
 * Urgency is simulated with real DOM click events, not a setState from
 * the timer callback, because React prioritizes them differently: a
 * discrete event preempts an in-flight transition render, while a
 * default-priority update (what setState gets in a timer context) queues
 * behind the entire remaining transition render and its commit. A timer
 * setState here would measure that queueing rule — one unlucky update
 * absorbing a multi-hundred-ms stall on a slow core — instead of what a
 * user feels when they click mid-transition.
 */
import { useState } from "react"
import type { Scenario } from "./scenario.js"
import { drain, p95, renderCells, sleep, until } from "./support.js"

const N = 2000
// 100 samples so a single-click stall (a blocking store's whole cost lands
// on one click) sits above the p95 cutoff yet cannot make the p95 itself;
// contenders are separated by how many clicks they slow down, not by one
// unlucky sample. The worst single click still reports as urgentMaxMs.
const URGENT_UPDATES = 100
const URGENT_INTERVAL_MS = 16

/**
 * The value the next click commits. The scenario chooses it outside React
 * and the click handler reads it, so the handler needs no per-update
 * re-wiring and the button's subtree stays byte-identical between
 * updates.
 */
let nextUrgent = 0

function UrgentInput() {
  const [v, setV] = useState(0)
  return (
    <button id="urgent" onClick={() => setV(nextUrgent)}>
      {v}
    </button>
  )
}

function readUrgent(): string | null {
  const el = document.getElementById("urgent")
  return el === null ? null : el.textContent
}

function clickUrgent(): void {
  const el = document.getElementById("urgent")
  if (el === null) {
    throw new Error("transition: urgent input is not mounted")
  }
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }))
}

const transition: Scenario = {
  name: "transition",
  async run(contender, report) {
    const store = contender.createCells(N)
    const tree = renderCells(store, N, <UrgentInput />)
    await until(() => tree.readCell(N - 1) === "0" && readUrgent() === "0", "transition mount")
    await drain()

    const updates: Array<[number, number]> = []
    for (let i = 0; i < N; i++) {
      updates.push([i, 1])
    }

    const latencies: number[] = []
    const tStart = performance.now()
    store.writeManyInTransition(updates)
    for (let k = 1; k <= URGENT_UPDATES; k++) {
      // The first click fires immediately so it contends with however the
      // contender scheduled the bulk re-render; the rest pace at roughly
      // one per frame.
      if (k > 1) {
        await sleep(URGENT_INTERVAL_MS)
      }
      nextUrgent = k
      const t0 = performance.now()
      clickUrgent()
      await until(() => readUrgent() === String(k), `urgent update ${k}`)
      latencies.push(performance.now() - t0)
    }
    await until(
      () => tree.readCell(0) === "1" && tree.readCell(N - 1) === "1",
      "transition completion",
    )
    const totalMs = performance.now() - tStart

    const sorted = [...latencies].sort((a, b) => a - b)
    report(p95(latencies), {
      urgentUpdates: URGENT_UPDATES,
      urgentMedianMs: Number(sorted[Math.floor(sorted.length / 2)].toFixed(2)),
      urgentMaxMs: Number(sorted[sorted.length - 1].toFixed(2)),
      transitionTotalMs: Number(totalMs.toFixed(2)),
      profilerCommits: tree.profiler.commits,
    })

    await tree.unmount()
    store.dispose()
    await drain()
  },
}

export default transition
