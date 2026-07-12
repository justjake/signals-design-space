import {
	computed,
	effect,
	signal,
	type Computed,
} from '../../packages/signals-royale-fx2/src/index.ts'

const depth = Number(process.env.SMOKE_DEPTH)
const warmIters = Number(process.env.SMOKE_WARM ?? 50_000)
const steadyIters = Number(process.env.SMOKE_STEADY ?? 10_000)

let sink = 0
const source = signal(0)
let tail: Computed<number> = computed(() => source.get() + 1)
for (let i = 1; i < depth; i++) {
	const previous = tail
	tail = computed(() => previous.get() + 1)
}
const dispose = effect(() => {
	sink = (sink ^ tail.get()) | 0
})

function run(start: number, count: number): void {
	for (let i = start; i < start + count; i++) {
		source.set(i)
	}
}

run(0, warmIters)
console.log('@@STEADY-START')
run(warmIters, steadyIters)
console.log('@@STEADY-END')
dispose()
console.log('sink:', sink)
