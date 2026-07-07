// Measures the logged build's retirement cost on the same write/effect
// graph as the base-build comparator (4 atoms, 4 computeds, 4 core
// effects); WATCHERS adds N committed watchers on one root, which
// retirement must also reconcile (logged-only surface). Burst = open K
// batches, M writes each (round-robin atoms, always-changing values), then
// retire all K as committed. retireNs isolates retirement itself: stamping
// log entries, folding them into base values, reconciling committed watchers
// and effects, clearing per-root bookkeeping, releasing slots.
import { envInt, row } from '/Users/jitl/src/alien-signals-opt/packages/cosignal/bench/util.mjs';

const ROOT = process.env.COSIGNAL_ROOT ?? '/Users/jitl/src/alien-signals-opt';
const mod = await import(`${ROOT}/packages/cosignal/src/index.ts`);

const K = envInt('K', 8);
const M = envInt('M', 8);
const WATCHERS = envInt('WATCHERS', 0);
const REPS = envInt('REPS', 7);
const WARMUP = envInt('WARMUP', 2);

// A/B seam (COSIGNAL_ROOT swaps trees): the anchor tree registers a bridge
// instance; this tree has ONE module engine.
const b = typeof mod.registerReactBridge === 'function'
	? mod.registerReactBridge()
	: (mod.__resetEngineForTest?.(), mod.engine);
const atoms = [];
for (let i = 0; i < 4; i++) atoms.push(b.atom(`a${i}`, 0));
const computeds = [];
for (let j = 0; j < 4; j++) {
	const x = atoms[j];
	const y = atoms[(j + 1) % 4];
	computeds.push(b.computed(`c${j}`, (read) => Number(read(x)) + Number(read(y))));
}
// Core effects, per arm: the anchor tree mounts newest-policy bridge
// subscriptions; on this tree kernel `effect()` on the node's public handle
// IS the core-effect form (value-gated like the anchor's subscription, so
// per-write observer work matches).
if (typeof b.mountCoreEffect === 'function') {
	for (const c of computeds) b.mountCoreEffect(c, `e-${c.name}`);
} else {
	for (const c of computeds) {
		let last;
		mod.effect(() => {
			const value = c.handle.state; // tracked kernel read (newest world)
			if (Object.is(value, last)) return; // value gate
			last = value;
		});
	}
}
if (WATCHERS > 0) {
	const p = b.renderStart('R', []);
	for (let i = 0; i < WATCHERS; i++) b.mountWatcher(p.id, computeds[i % 4], `w${i}`);
	b.renderEnd(p.id, 'commit');
}

let v = 0;
function repOnce() {
	if (b.events !== undefined) b.events.length = 0; // anchor-tree retained log; this tree retains no events
	const t0 = process.hrtime.bigint();
	const batches = [];
	for (let k = 0; k < K; k++) batches.push(b.openBatch());
	for (let k = 0; k < K; k++) {
		for (let m = 0; m < M; m++) b.write(batches[k].id, atoms[m % 4], 0, ++v);
	}
	const t1 = process.hrtime.bigint();
	for (const t of batches) b.retire(t.id);
	const t2 = process.hrtime.bigint();
	return {
		writeNsPerBatch: Number(t1 - t0) / K,
		retireNsPerBatch: Number(t2 - t1) / K,
		totalNsPerBatch: Number(t2 - t0) / K,
	};
}

for (let r = 0; r < WARMUP; r++) repOnce();
const acc = [];
for (let r = 0; r < REPS; r++) { globalThis.gc?.(); acc.push(repOnce()); }
const med = (key) => { const s = acc.map((x) => x[key]).sort((x, y) => x - y); return s[s.length >> 1]; };
const checksum = computeds.reduce((s, c) => s + Number(b.newestValue(c)), 0);
const shape = `K${K}xM${M}${WATCHERS > 0 ? `+${WATCHERS}w` : ''}`;
const base = { gate: 'SPK-R', config: 'logged', shape, checksum };
row({ ...base, metric: `writeNs:${shape}`, value: med('writeNsPerBatch') });
row({ ...base, metric: `retireNs:${shape}`, value: med('retireNsPerBatch') });
row({ ...base, metric: `totalNs:${shape}`, value: med('totalNsPerBatch') });
