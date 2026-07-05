// Measures the QUIET-MODE write price (Phase 1b): the bridge is registered
// and the written atom is REGISTERED, but nothing is pending — no batches,
// no passes — so every public `a.set(i)` takes the quiet fold (committed
// base + kernel advance together; no receipt/token/walk/event). Same graph
// shapes and protocol as spkw-direct.mjs; compare per-write ns against it.
import { Atom, Computed, effect, registerReactBridge, __coreProbes } from '/Users/jitl/src/alien-signals-opt/packages/cosignal/src/index.ts';
import { env, envInt, row } from '/Users/jitl/src/alien-signals-opt/packages/cosignal/bench/util.mjs';

const SHAPE = env('SHAPE', 'bare');
const WRITES = envInt('WRITES', 100_000);
const REPS = envInt('REPS', 7);
const WARMUP = envInt('WARMUP', 2);

const bridge = registerReactBridge(); // production posture: quiet ON, no event retention

let sink = 0;
const a = new Atom(0);
const node = bridge.adoptAtom('a', a); // REGISTERED: the host write seam engages
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
// Quiet-mode invariants, asserted in the bench itself: zero pipeline
// activity, committed == kernel == last write.
const probes = __coreProbes();
if (probes.receipts !== 0 || probes.tokens !== 0 || probes.bridgeEvents !== 0) {
	throw new Error(`SPK-W quiet invariant: pipeline activity while quiet (${JSON.stringify(probes)})`);
}
if (bridge.ambientToken !== undefined) throw new Error('SPK-W quiet invariant: ambient batch minted');
if (bridge.committedValue(node, 'A') !== i || bridge.newestValue(node) !== i) {
	throw new Error('SPK-W quiet invariant: fold diverged from kernel');
}
const checksum = a.state + (top !== undefined ? top.state : 0) + sink;
row({ gate: 'SPK-W', config: 'quiet', shape: SHAPE, metric: `writeNs:${SHAPE}`, value: med, checksum });
