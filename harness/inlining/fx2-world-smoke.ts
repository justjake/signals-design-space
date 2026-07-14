import { createAtom, createComputed } from '../../packages/signals-royale-fx2/src/index.ts'
import {
	makeScheduledEffect,
	withWorld,
} from '../../packages/signals-royale-fx2/src/graph.ts'
import {
	discardDraft,
	openDraft,
	runWithDraftWrites,
	worldOf,
} from '../../packages/signals-royale-fx2/src/worlds.ts'

const warmIters = Number(process.env.SMOKE_WARM ?? 50_000)
const steadyIters = Number(process.env.SMOKE_STEADY ?? 10_000)

let sink = 0
const source = createAtom(0)
const computed = createComputed(() => source.get() + 1)
const draft = openDraft()
runWithDraftWrites(draft, () => source.set(1))
const world = worldOf([draft.id])

function schedule(): void {
	sink++
}
function draftWake(): void {
	sink++
}
const scheduledEffect = makeScheduledEffect(schedule, draftWake)
function readScheduledComputed(): void {
	sink ^= computed.get()
}
function runScheduledRead(): void {
	scheduledEffect.run(readScheduledComputed)
}

for (let i = 0; i < warmIters; i++) {
	withWorld(world, runScheduledRead)
}
console.log('@@STEADY-START')
for (let i = 0; i < steadyIters; i++) {
	withWorld(world, runScheduledRead)
}
console.log('@@STEADY-END')
scheduledEffect.dispose()
discardDraft(draft.id)
console.log('sink:', sink)
