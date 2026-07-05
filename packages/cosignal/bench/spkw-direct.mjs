/**
 * SPK-W child, DIRECT build (imports index.ts ONLY — twin purity).
 * Shapes: bare (atom only), chain3 (a -> c1 -> c2 -> c3 -> effect),
 * fan8 (a -> 8 computeds -> 8 effects), watch1 (a -> c1 -> 1 effect).
 * Metric: per-write ns for `a.set(i)` including synchronous propagation.
 */
import { Atom, Computed, effect } from '/Users/jitl/src/alien-signals-opt/packages/cosignal/src/index.ts';
import { env, envInt, row } from '/Users/jitl/src/alien-signals-opt/packages/cosignal/bench/util.mjs';

const SHAPE = env('SHAPE', 'bare');
const WRITES = envInt('WRITES', 100_000);
const REPS = envInt('REPS', 7);
const WARMUP = envInt('WARMUP', 2);

let sink = 0;
const a = new Atom(0);
let top; // deepest/last computed, read for checksum

if (SHAPE === 'chain3') {
	const c1 = new Computed(() => a.state + 1);
	const c2 = new Computed(() => c1.state + 1);
	const c3 = new Computed(() => c2.state + 1);
	effect(() => { sink += c3.state; });
	top = c3;
} else if (SHAPE === 'fan8') {
	for (let i = 0; i < 8; i++) {
		const c = new Computed(() => a.state + 1);
		effect(() => { sink += c.state; });
		top = c;
	}
} else if (SHAPE === 'watch1') {
	const c1 = new Computed(() => a.state + 1);
	effect(() => { sink += c1.state; });
	top = c1;
} else if (SHAPE !== 'bare') {
	throw new Error(`unknown SHAPE ${SHAPE}`);
}

let i = 0;
function repOnce() {
	const t0 = process.hrtime.bigint();
	for (let k = 0; k < WRITES; k++) a.set(++i);
	const t1 = process.hrtime.bigint();
	return Number(t1 - t0);
}

for (let r = 0; r < WARMUP; r++) repOnce();
const perWrite = [];
for (let r = 0; r < REPS; r++) {
	globalThis.gc?.();
	perWrite.push(repOnce() / WRITES);
}
perWrite.sort((x, y) => x - y);
const med = perWrite[perWrite.length >> 1];
const checksum = a.state + (top !== undefined ? top.state : 0) + sink;
row({ gate: 'SPK-W', config: 'direct', shape: SHAPE, metric: `writeNs:${SHAPE}`, value: med, checksum });
