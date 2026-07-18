/**
 * Runs every scenario for ONE contender and prints CSV rows to stdout.
 *
 * One contender per process is structural, not a convenience: registering
 * cosignals registers its React integration
 * process-wide, and V8's JIT specializes hot call sites to whichever
 * library ran first — either would contaminate a second contender measured
 * in the same process. Per-scenario extra stats go to stderr as `#` comment
 * lines so stdout stays machine-parseable.
 *
 * Usage: node dist/child.js <contenderName>
 */
import { freshDom } from "./scenarios/dom.js" // must stay the first import: installs DOM globals before react-dom/client evaluates
import { loadContender } from "./adapters/index.js"
import { contenderNames } from "./adapters/names.js"
import { scenarios } from "./scenarios/index.js"
import type { Contender } from "./adapters/types.js"
import { CALIBRATION_TEST, formatPerfResult } from "./util/perfLogging.js"

function spin(iterations: number): number {
  let acc = 0
  for (let i = 0; i < iterations; i++) {
    acc += Math.sqrt(i)
  }
  return acc
}

/**
 * How long a fixed CPU-bound loop takes on whatever core the OS gave this
 * process. On Apple Silicon a process placed on efficiency cores measures
 * roughly 3x a performance core, so the isolated runner can tell a slow
 * library from slow silicon. The first spin warms the JIT so the timed
 * one measures the core, not compilation.
 */
function measureProbeMs(): number {
  spin(1_000_000)
  const t0 = performance.now()
  spin(8_000_000)
  return performance.now() - t0
}

// argv is typed string[] but a missing argument reads as undefined at runtime.
const name: string | undefined = process.argv[2]
if (name === undefined) {
  console.error(`usage: node dist/child.js <contender>; available: ${contenderNames.join(", ")}`)
  process.exit(1)
}

let contender: Contender
try {
  contender = await loadContender(name)
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}

const probeBeforeMs = measureProbeMs()

for (const scenario of scenarios) {
  freshDom()
  await scenario.run(contender, (ms, extra) => {
    console.log(
      formatPerfResult({ framework: contender.name, test: scenario.name, time: ms.toFixed(2) }),
    )
    if (extra !== undefined) {
      console.error(`# ${contender.name} ${scenario.name} ${JSON.stringify(extra)}`)
    }
  })
}

// Probe on both sides of the scenarios and report the worse reading: core
// placement can change mid-process, and a run that spent any measured
// scenario on efficiency cores should be caught either way.
const probeMs = Math.max(probeBeforeMs, measureProbeMs())
console.log(
  formatPerfResult({ framework: contender.name, test: CALIBRATION_TEST, time: probeMs.toFixed(2) }),
)

// Everything should be settled, so the process exits on its own; if a stray
// handle keeps the event loop alive anyway, exit once stdout has had a beat
// to flush. unref() keeps this failsafe from holding the loop open itself.
setTimeout(() => process.exit(0), 1000).unref()
