/**
 * SPK-L child, LOGGED-ARMED-QUIET build: registerReactBridge() has swapped
 * the operation table (read wrapper: 1 activeWorld check; write wrapper:
 * mode check + byKernelId Map probe per write), one registered decoy atom
 * + computed exist (the "mounted" state), no batches/passes/receipts are
 * live during measurement — quiet React. The measured hot loops run on
 * UNREGISTERED plain signals through the armed table: exactly the O19
 * quiet-read/write residual. Same injected shape code as the DIRECT child.
 */
import { Atom, Computed, effect } from '/Users/jitl/src/alien-signals-opt/packages/cosignal/src/index.ts';
import { registerReactBridge } from '/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts';
import { env, envInt, row } from '/Users/jitl/src/alien-signals-opt/packages/cosignal/bench/util.mjs';
import { makeShape, SHAPE_OPS } from '/Users/jitl/src/alien-signals-opt/packages/cosignal/bench/spkl-shapes.mjs';

const SHAPE = env('SHAPE', 'readPoll');
const REPS = envInt('REPS', 9);
const WARMUP = envInt('WARMUP', 3);
const OPS = envInt('OPS', SHAPE_OPS[SHAPE]);

// Arm the seam BEFORE building the workload (mounted-quiet app state).
const bridge = registerReactBridge();
const decoy = bridge.atom('decoy', 0);
bridge.computed('decoyC', (read) => Number(read(decoy)) + 1);

const shape = makeShape(SHAPE, { Atom, Computed, effect });
for (let r = 0; r < WARMUP; r++) shape.run(OPS);
const times = [];
for (let r = 0; r < REPS; r++) {
	globalThis.gc?.();
	const t0 = process.hrtime.bigint();
	shape.run(OPS);
	const t1 = process.hrtime.bigint();
	times.push(Number(t1 - t0) / OPS);
}
times.sort((a, b) => a - b);
if (bridge.liveTokens().length !== 0 || bridge.events.length !== 0) {
	throw new Error('SPK-L invariant: the quiet workload must not touch the bridge');
}
row({
	gate: 'SPK-L', config: 'logged-quiet', shape: SHAPE,
	metric: `opNs:${SHAPE}`, value: times[times.length >> 1], checksum: shape.checksum(),
});
