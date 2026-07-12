import {
	BASE_WORLD,
	createComputed,
	createAtom,
	effect,
	type Computed,
} from '../../packages/signals-royale-fx2/src/index.ts'
import { makeScheduledEffect } from '../../packages/signals-royale-fx2/src/graph.ts'
import { withWorld } from '../../packages/signals-royale-fx2/src/worlds.ts'

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
const dispose = effect(() => {
	sink = (sink ^ tail.get()) | 0
})

// Warm the React-phase watcher/world-read path separately from the steady
// propagation source. Named callbacks keep this probe allocation-free.
const scheduledSource = createAtom(0)
const scheduledEffect = makeScheduledEffect(
	() => {
		sink++
	},
	() => {},
)
function readScheduledAtom(): void {
	sink ^= scheduledSource.get()
}
function runScheduledRead(): void {
	withWorld(BASE_WORLD, readScheduledAtom)
}
for (let i = 0; i < warmIters; i++) {
	scheduledEffect.run(runScheduledRead)
}
scheduledSource.set(1)

function run(start: number, count: number): void {
	for (let i = start; i < start + count; i++) {
		source.set(i)
	}
}

run(0, warmIters)
console.log('@@STEADY-START')
for (let i = 0; i < steadyIters; i++) {
	scheduledEffect.run(runScheduledRead)
}
run(warmIters, steadyIters)
console.log('@@STEADY-END')
scheduledEffect.dispose()
dispose()
console.log('sink:', sink)
