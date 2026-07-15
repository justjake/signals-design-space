import {
	BASE_WORLD,
	createAtom,
	createComputed,
	effect,
	flushScheduledEffects,
	type Computed,
} from '../../packages/signals-royale-fx2/src/index.ts'
import { withWorld } from '../../packages/signals-royale-fx2/src/graph.ts'

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
const dispose = effect(
	() => tail.get(),
	(v) => {
		sink = (sink ^ v) | 0
	},
)

// Warm the deferred-lane enqueue/drain and the world-selected read path
// separately from the steady propagation source. Named callbacks keep this
// probe allocation-free.
const scheduledSource = createAtom(0)
const disposeScheduled = effect(
	() => scheduledSource.get(),
	(v) => {
		sink ^= v
	},
	{ schedule: 'useLayoutEffect' },
)
function readBaseWorld(): void {
	sink ^= tail.get()
}
for (let i = 0; i < warmIters; i++) {
	withWorld(BASE_WORLD, readBaseWorld)
}
scheduledSource.set(1)
flushScheduledEffects()

function run(start: number, count: number): void {
	for (let i = start; i < start + count; i++) {
		source.set(i)
	}
}

run(0, warmIters)
console.log('@@STEADY-START')
for (let i = 0; i < steadyIters; i++) {
	withWorld(BASE_WORLD, readBaseWorld)
}
run(warmIters, steadyIters)
console.log('@@STEADY-END')
disposeScheduled()
dispose()
console.log('sink:', sink)
