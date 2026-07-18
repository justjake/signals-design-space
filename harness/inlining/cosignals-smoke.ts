import {
  createAtom,
  createComputed,
  createEffect,
  flushScheduledEffects,
  type Computed,
} from "../../packages/cosignals/src/core.ts"
import { withWorld } from "../../packages/cosignals/src/graph.ts"
import { BASE_WORLD } from "../../packages/cosignals/src/worlds.ts"

const depth = Number(process.env.SMOKE_DEPTH)
const warmIters = Number(process.env.SMOKE_WARM ?? 50_000)
const steadyIters = Number(process.env.SMOKE_STEADY ?? 10_000)

let sink = 0
const source = createAtom(0)
let tail: Computed<number> = createComputed(() => source.get() + 1)
for (let i = 1; i < depth; i++) {
  const previous = tail
  tail = createComputed(() => previous.get() + 1)
}
// Sync lane: every write below drains this effect two-phase (pull the
// compute chain, then run the handler).
const dispose = createEffect(
  () => tail.get(),
  (v: number) => {
    sink = (sink ^ v) | 0
  },
)

// Warm the deferred-lane enqueue/drain and the world-selected read path
// separately from the steady propagation source. Named callbacks keep this
// probe allocation-free.
const scheduledSource = createAtom(0)
// The handler returns a cleanup so the second delivery below exercises
// runEffectCleanup; the drain skips the call entirely for effects without
// one, and an uncalled function never compiles, so the bytecode budget
// suite would find nothing to measure.
function scheduledCleanup(): void {
  sink |= 0
}
const disposeScheduled = createEffect(
  () => scheduledSource.get(),
  (v: number) => {
    sink ^= v
    return scheduledCleanup
  },
  { schedule: "useLayoutEffect" },
)
function readBaseWorld(): void {
  sink ^= tail.get()
}
for (let i = 0; i < warmIters; i++) {
  withWorld(BASE_WORLD, readBaseWorld)
}
scheduledSource.set(1)
flushScheduledEffects()
scheduledSource.set(2)
flushScheduledEffects()

function run(start: number, count: number): void {
  for (let i = start; i < start + count; i++) {
    source.set(i)
  }
}

run(0, warmIters)
console.log("@@STEADY-START")
for (let i = 0; i < steadyIters; i++) {
  withWorld(BASE_WORLD, readBaseWorld)
}
run(warmIters, steadyIters)
console.log("@@STEADY-END")
disposeScheduled()
dispose()
console.log("sink:", sink)
