// Quiet side of the residual measurement: registerReactBridge() has swapped
// in the logged build's read/write wrappers and one registered decoy
// atom + computed exist, but no batches, render passes, or log entries are live during
// measurement. The hot loops run on UNREGISTERED plain signals through the
// armed wrappers — the cost an app pays for merely loading the concurrent
// engine. Same injected shape code as the base-build child.
import {
	env,
	envInt,
	row,
} from '/Users/jitl/src/alien-signals-opt/packages/cosignals/bench/util.mjs'
import {
	makeShape,
	SHAPE_OPS,
} from '/Users/jitl/src/alien-signals-opt/packages/cosignals/bench/spkl-shapes.mjs'

const ROOT = process.env.COSIGNAL_ROOT ?? '/Users/jitl/src/alien-signals-opt'
const mod = await import(`${ROOT}/packages/cosignals/src/index.ts`)
const { Atom, Computed, effect } = mod

const SHAPE = env('SHAPE', 'readPoll')
const REPS = envInt('REPS', 9)
const WARMUP = envInt('WARMUP', 3)
const OPS = envInt('OPS', SHAPE_OPS[SHAPE])

// Arm the seam BEFORE building the workload (mounted-quiet app state).
// A/B seam (COSIGNAL_ROOT swaps trees): the anchor tree registers a bridge
// instance; this tree resets its default engine.
const bridge =
	typeof mod.registerReactBridge === 'function'
		? mod.registerReactBridge()
		: ((mod.__TEST__resetEngine ?? mod.__resetEngineForTest)?.(), mod.engine)
const decoy = bridge.atom('decoy', 0)
bridge.computed('decoyC', (read) => Number(read(decoy)) + 1)

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
// Quiet invariant, per arm: the anchor tree retains an event log (must stay
// empty); this tree deleted event retention — the engine-activity probes
// (log entries created, batches opened) carry the same "nothing touched the
// engine" fact.
if (bridge.events !== undefined) {
	if (bridge.liveBatches().length !== 0 || bridge.events.length !== 0) {
		throw new Error('SPK-L invariant: the quiet workload must not touch the bridge')
	}
} else {
	const probes = (mod.__TEST__coreProbes ?? mod.__coreProbes)()
	if (bridge.liveBatches().length !== 0 || probes.logEntries !== 0 || probes.batches !== 0) {
		throw new Error(
			`SPK-L invariant: the quiet workload must not touch the engine (${JSON.stringify(probes)})`,
		)
	}
}
row({
	gate: 'SPK-L',
	config: 'logged-quiet',
	shape: SHAPE,
	metric: `opNs:${SHAPE}`,
	value: times[times.length >> 1],
	checksum: shape.checksum(),
})
