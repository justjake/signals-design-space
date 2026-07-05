/**
 * SPK-R core child, DIRECT build: the comparator side — `batch()` over the
 * identical write/effect graph. Graph: 4 atoms, 4 computeds (each reads two
 * atoms), 4 effects. One "batch" = M writes round-robin across atoms inside
 * batch() (effects flush at close). K batches per burst.
 */
import { Atom, Computed, batch, effect } from '/Users/jitl/src/alien-signals-opt/packages/cosignal/src/index.ts';
import { envInt, row } from '/Users/jitl/src/alien-signals-opt/packages/cosignal/bench/util.mjs';

const K = envInt('K', 8); // batches per burst
const M = envInt('M', 8); // writes per batch
const REPS = envInt('REPS', 7);
const WARMUP = envInt('WARMUP', 2);

let sink = 0;
const atoms = [];
for (let i = 0; i < 4; i++) atoms.push(new Atom(0));
const computeds = [];
for (let j = 0; j < 4; j++) {
	const x = atoms[j];
	const y = atoms[(j + 1) % 4];
	computeds.push(new Computed(() => x.state + y.state));
}
for (const c of computeds) effect(() => { sink += c.state; });

let v = 0;
function repOnce() {
	const t0 = process.hrtime.bigint();
	for (let k = 0; k < K; k++) {
		batch(() => {
			for (let m = 0; m < M; m++) atoms[m % 4].set(++v);
		});
	}
	const t1 = process.hrtime.bigint();
	return Number(t1 - t0) / K; // ns per batch (writes + flush)
}

for (let r = 0; r < WARMUP; r++) repOnce();
const acc = [];
for (let r = 0; r < REPS; r++) { globalThis.gc?.(); acc.push(repOnce()); }
acc.sort((x, y) => x - y);
const checksum = sink + computeds.reduce((s, c) => s + c.state, 0);
row({ gate: 'SPK-R', config: 'direct', shape: `K${K}xM${M}`, metric: `batchNs:K${K}xM${M}`, value: acc[acc.length >> 1], checksum });
