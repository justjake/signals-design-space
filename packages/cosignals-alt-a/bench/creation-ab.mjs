// Creation-cost A/B: FinalizationRegistry registration ON vs OFF.
// Methodology matches ab.mjs: fastest-of-N, but the two modes are
// INTERLEAVED pair-by-pair (and order-alternated) so thermal/JIT drift and
// ordering bias hit both sides equally.
//
//   pnpm exec esbuild src/index.ts --bundle --format=esm \
//     --outfile=bench/dist/cosignals.js
//   node bench/creation-ab.mjs [itersPerRep]
import { createCosignalEngine } from './dist/cosignals.js';

const ITERS = Number(process.argv[2] ?? 100_000);
const REPS = 13;
// Preallocate so neither side pays plane growth inside the timed region.
const big = { initialRecords: ITERS * 4 + 4096, initialLogRecords: 1 << 12, initialMemoRecords: 1 << 12 };

function timeOnce(finalization, shape) {
	globalThis.gc?.(); // normalize heap state per rep (run with --expose-gc)
	const e = createCosignalEngine({ ...big, finalization });
	shape(e, 64); // warm the shape on this engine
	const t0 = performance.now();
	shape(e, ITERS);
	const dt = performance.now() - t0;
	return (dt / ITERS) * 1e6; // ns/op
}

function ab(label, shape) {
	let bestOff = Infinity;
	let bestOn = Infinity;
	for (let r = 0; r < REPS; ++r) {
		if (r & 1) {
			bestOn = Math.min(bestOn, timeOnce(true, shape));
			bestOff = Math.min(bestOff, timeOnce(false, shape));
		} else {
			bestOff = Math.min(bestOff, timeOnce(false, shape));
			bestOn = Math.min(bestOn, timeOnce(true, shape));
		}
	}
	const ratio = bestOn / bestOff;
	console.log(
		`${label}: FR-off ${bestOff.toFixed(1)} ns/op  FR-on ${bestOn.toFixed(1)} ns/op  ratio ${ratio.toFixed(3)}x (${((ratio - 1) * 100).toFixed(1)}%)`,
	);
}

// Shape 1: bare atom creation (the registration cost in isolation).
ab('atom-create           ', (e, n) => {
	for (let i = 0; i < n; ++i) {
		e.atom(i);
	}
});

// Shape 2: bare computed creation.
ab('computed-create       ', (e, n) => {
	for (let i = 0; i < n; ++i) {
		e.computed(() => i);
	}
});

// Shape 3: the mount-like create shape — atom + dependent computed + first
// read (creation cost in realistic proportion to linking/eval work).
ab('create-shape (a+c+read)', (e, n) => {
	for (let i = 0; i < n; ++i) {
		const a = e.atom(i);
		const c = e.computed(() => a.state + 1);
		c.state;
	}
});
