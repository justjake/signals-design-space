import { createAtom, createComputed } from "../../packages/cosignals/src/core.ts"
import { withWorld } from "../../packages/cosignals/src/graph.ts"
import {
  discardDraft,
  openDraft,
  runWithDraftWrites,
  worldOf,
} from "../../packages/cosignals/src/worlds.ts"

const warmIters = Number(process.env.SMOKE_WARM ?? 50_000)
const steadyIters = Number(process.env.SMOKE_STEADY ?? 10_000)

let sink = 0
const source = createAtom(0)
const computed = createComputed(() => source.get() + 1)
const draft = openDraft()
runWithDraftWrites(draft, () => source.set(1))
const world = worldOf([draft.id])

// The render-path read: a world-selected get() resolves the draft world
// through the memo (memoFor/memoValid/recordSource/inheritCertificate on
// the steady hit path).
function readWorldComputed(): void {
  sink ^= computed.get()
}

for (let i = 0; i < warmIters; i++) {
  withWorld(world, readWorldComputed)
}
console.log("@@STEADY-START")
for (let i = 0; i < steadyIters; i++) {
  withWorld(world, readWorldComputed)
}
console.log("@@STEADY-END")
discardDraft(draft.id)
console.log("sink:", sink)
