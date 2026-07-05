/**
 * SPK-R core child, LOGGED build: dense retirement. Same write/effect graph
 * as the DIRECT comparator (4 atoms, 4 computeds, 4 core effects); WATCHERS
 * env adds N committed watchers on one root — the advance-drain reconcile
 * surface (LOGGED-only; disclosed). Burst = open K tokens, M writes each
 * (round-robin atoms, always-changing values), then retire all K
 * (committed). retireNs isolates the retirement engine: receipt stamping,
 * compaction folds (this build's stand-in for the promotion walk — there
 * are no version chains to promote; folds recompute), durable drains
 * (watcher reconcile + committed-effect revalidation), per-root row clears,
 * slot release.
 */
import { registerReactBridge } from '/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts';
import { envInt, row } from '/Users/jitl/src/alien-signals-opt/packages/cosignal/bench/util.mjs';

const K = envInt('K', 8);
const M = envInt('M', 8);
const WATCHERS = envInt('WATCHERS', 0);
const REPS = envInt('REPS', 7);
const WARMUP = envInt('WARMUP', 2);

const b = registerReactBridge();
const atoms = [];
for (let i = 0; i < 4; i++) atoms.push(b.atom(`a${i}`, 0));
const computeds = [];
for (let j = 0; j < 4; j++) {
	const x = atoms[j];
	const y = atoms[(j + 1) % 4];
	computeds.push(b.computed(`c${j}`, (read) => Number(read(x)) + Number(read(y))));
}
for (const c of computeds) b.mountCoreEffect(c, `e-${c.name}`);
if (WATCHERS > 0) {
	const p = b.passStart('R', []);
	for (let i = 0; i < WATCHERS; i++) b.mountWatcher(p.id, computeds[i % 4], `w${i}`);
	b.passEnd(p.id, 'commit');
}

let v = 0;
function repOnce() {
	b.events.length = 0;
	const t0 = process.hrtime.bigint();
	const toks = [];
	for (let k = 0; k < K; k++) toks.push(b.openBatch('default'));
	for (let k = 0; k < K; k++) {
		for (let m = 0; m < M; m++) b.write(toks[k].id, atoms[m % 4], { kind: 'set', value: ++v });
	}
	const t1 = process.hrtime.bigint();
	for (const t of toks) b.retire(t.id, true);
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
