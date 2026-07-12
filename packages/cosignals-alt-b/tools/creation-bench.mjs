// Creation-cost A/B: FinalizationRegistry registration ON vs OFF.
// Fastest-of-N, modes interleaved pair-by-pair (and order-alternated) so
// thermal/JIT drift and ordering bias hit both sides equally.
//
//   pnpm exec esbuild src/index.ts --bundle --format=esm \
//     --outfile=tools/dist/cosignals-alt-b.js
//   node --expose-gc tools/creation-bench.mjs [itersPerRep]
import { Atom, Computed, __resetEngineForTests, configure } from './dist/cosignals-alt-b.js'

const ITERS = Number(process.argv[2] ?? 100_000)
const REPS = 13

function timeOnce(finalization, shape) {
	globalThis.gc?.() // normalize heap state per rep (run with --expose-gc)
	// Preallocate so neither side pays plane growth inside the timed region.
	__resetEngineForTests({ initialRecords: ITERS * 4 + 4096 })
	configure({ finalization })
	shape(64) // warm the shape on this engine era
	const t0 = performance.now()
	shape(ITERS)
	const dt = performance.now() - t0
	return (dt / ITERS) * 1e6 // ns/op
}

function ab(label, shape) {
	let bestOff = Infinity
	let bestOn = Infinity
	for (let r = 0; r < REPS; ++r) {
		if (r & 1) {
			bestOn = Math.min(bestOn, timeOnce(true, shape))
			bestOff = Math.min(bestOff, timeOnce(false, shape))
		} else {
			bestOff = Math.min(bestOff, timeOnce(false, shape))
			bestOn = Math.min(bestOn, timeOnce(true, shape))
		}
	}
	const ratio = bestOn / bestOff
	console.log(
		`${label}: FR-off ${bestOff.toFixed(1)} ns/op  FR-on ${bestOn.toFixed(1)} ns/op  ratio ${ratio.toFixed(3)}x (${((ratio - 1) * 100).toFixed(1)}%)`,
	)
}

// Shape 1: bare atom creation (the registration cost in isolation).
ab('atom-create           ', (n) => {
	for (let i = 0; i < n; ++i) {
		new Atom({ state: i })
	}
})

// Shape 2: bare computed creation.
ab('computed-create       ', (n) => {
	for (let i = 0; i < n; ++i) {
		new Computed({ fn: () => i })
	}
})

// Shape 3: the mount-like create shape — atom + dependent computed + first
// read (creation cost in realistic proportion to linking/eval work).
ab('create-shape (a+c+read)', (n) => {
	for (let i = 0; i < n; ++i) {
		const a = new Atom({ state: i })
		const c = new Computed({ fn: () => a.state + 1 })
		c.state
	}
})
