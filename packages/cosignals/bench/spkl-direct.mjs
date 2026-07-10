// Baseline side of the quiet-residual measurement: the base build only
// (imports the base entry), hot loops on plain public-API signals; per-op ns
// via within-process median of REPS timed reps.
import {
	Atom,
	Computed,
	effect,
} from '/Users/jitl/src/alien-signals-opt/packages/cosignals/src/index.ts'
import {
	env,
	envInt,
	row,
} from '/Users/jitl/src/alien-signals-opt/packages/cosignals/bench/util.mjs'
import {
	makeShape,
	SHAPE_OPS,
} from '/Users/jitl/src/alien-signals-opt/packages/cosignals/bench/spkl-shapes.mjs'

const SHAPE = env('SHAPE', 'readPoll')
const REPS = envInt('REPS', 9)
const WARMUP = envInt('WARMUP', 3)
const OPS = envInt('OPS', SHAPE_OPS[SHAPE])

const shape = makeShape(SHAPE, { Atom, Computed, effect })
for (let r = 0; r < WARMUP; r++) shape.run(OPS)
const times = []
for (let r = 0; r < REPS; r++) {
	globalThis.gc?.()
	const t0 = process.hrtime.bigint()
	shape.run(OPS)
	const t1 = process.hrtime.bigint()
	times.push(Number(t1 - t0) / OPS)
}
times.sort((a, b) => a - b)
row({
	gate: 'SPK-L',
	config: 'direct',
	shape: SHAPE,
	metric: `opNs:${SHAPE}`,
	value: times[times.length >> 1],
	checksum: shape.checksum(),
})
