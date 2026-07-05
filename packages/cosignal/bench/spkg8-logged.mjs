// Measures the logged build's world-evaluation cost, no base-build
// comparator (worlds only exist in the logged build). MODE=burst: bursts of
// writes into one atom among G computeds (only c0 depends on it; the others
// read unrelated atoms), one committed watcher; HELD=1 keeps a yielded
// render pass + unsettled action batch open so extra worlds stay live —
// reports per-write ns and evals per write as G grows. MODE=typeahead:
// each keystroke writes into a parked action batch, discards the open
// render pass, and starts+yields a fresh one; the batch retires only at the
// end, so its receipts accumulate — reports per-keystroke ns, evals per
// keystroke, and the receipt-history length every replay must walk.
import { registerReactBridge } from '/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts';
import { env, envInt, row } from '/Users/jitl/src/alien-signals-opt/packages/cosignal/bench/util.mjs';

const MODE = env('MODE', 'burst');
const G = envInt('G', 16); // total computeds (flagged region stays 1 chain)
const HELD = envInt('HELD', 0) === 1;
const W = envInt('W', 64); // burst writes per frame
const FRAMES = envInt('FRAMES', 20);
const KEYS = envInt('KEYS', 50);
const REPS = envInt('REPS', 5);
const WARMUP = envInt('WARMUP', 1);

const b = registerReactBridge();
let evals = 0;
const query = b.atom('query', 0);
const unrelated = [];
const computeds = [];
for (let i = 0; i < G; i++) {
	if (i === 0) {
		computeds.push(b.computed('c0', (read) => { evals++; return Number(read(query)) + 1; }));
	} else {
		const u = b.atom(`u${i}`, i);
		unrelated.push(u);
		computeds.push(b.computed(`c${i}`, (read) => { evals++; return Number(read(u)) + 1; }));
	}
}
const setup = b.passStart('R', []);
const watcher = b.mountWatcher(setup.id, computeds[0], 'w0');
b.passEnd(setup.id, 'commit');

let v = 0;

function repBurst() {
	let held;
	let heldPass;
	if (HELD) {
		held = b.openBatch('deferred', { action: true });
		b.write(held.id, query, { kind: 'set', value: ++v });
		heldPass = b.passStart('R', [held.id]);
		b.renderWatcher(heldPass.id, watcher.id);
		b.passYield(heldPass.id);
	}
	evals = 0;
	let writeNs = 0;
	for (let f = 0; f < FRAMES; f++) {
		b.events.length = 0;
		const tok = b.openBatch('default');
		const t0 = process.hrtime.bigint();
		for (let k = 0; k < W; k++) b.write(tok.id, query, { kind: 'set', value: ++v });
		const t1 = process.hrtime.bigint();
		writeNs += Number(t1 - t0);
		b.retire(tok.id, true);
	}
	const evalsPerWrite = evals / (FRAMES * W);
	const tapeLen = query.tape.length;
	if (heldPass !== undefined) {
		b.passResume(heldPass.id);
		b.passEnd(heldPass.id, 'commit');
	}
	if (held !== undefined) b.settleAction(held.id, true);
	return { writeNs: writeNs / (FRAMES * W), evalsPerWrite, tapeLen };
}

function repTypeahead() {
	const t0all = process.hrtime.bigint();
	const T = b.openBatch('deferred', { action: true });
	evals = 0;
	let open;
	let keyNs = 0;
	for (let k = 0; k < KEYS; k++) {
		const t0 = process.hrtime.bigint();
		b.write(T.id, query, { kind: 'set', value: ++v });
		if (open !== undefined) b.passEnd(open.id, 'discard'); // interruption: restart
		open = b.passStart('R', [T.id]);
		b.renderWatcher(open.id, watcher.id);
		b.passYield(open.id);
		const t1 = process.hrtime.bigint();
		keyNs += Number(t1 - t0);
	}
	const tapeLen = query.tape.length; // retention/prefix length before settle
	const evalsPerKey = evals / KEYS;
	b.passResume(open.id);
	b.passEnd(open.id, 'commit');
	b.settleAction(T.id, true);
	const t1all = process.hrtime.bigint();
	b.events.length = 0;
	return { keyNs: keyNs / KEYS, evalsPerKey, tapeLen, runNs: Number(t1all - t0all) / KEYS };
}

const rep = MODE === 'burst' ? repBurst : repTypeahead;
for (let r = 0; r < WARMUP; r++) rep();
const acc = [];
for (let r = 0; r < REPS; r++) { globalThis.gc?.(); acc.push(rep()); }
const med = (key) => { const s = acc.map((x) => x[key]).sort((x, y) => x - y); return s[s.length >> 1]; };
const checksum = Number(b.newestValue(computeds[0])) + evals;
const shape = MODE === 'burst' ? `G${G}${HELD ? '+held' : ''}` : `type-G${G}xK${KEYS}`;
const base = { gate: 'SPK-G8', config: 'logged', shape, checksum };
if (MODE === 'burst') {
	row({ ...base, metric: `writeNs:${shape}`, value: med('writeNs') });
	row({ ...base, metric: `evalsPerWrite:${shape}`, value: med('evalsPerWrite') });
	row({ ...base, metric: `tapeLen:${shape}`, value: med('tapeLen') });
} else {
	row({ ...base, metric: `keyNs:${shape}`, value: med('keyNs') });
	row({ ...base, metric: `evalsPerKey:${shape}`, value: med('evalsPerKey') });
	row({ ...base, metric: `tapeLen:${shape}`, value: med('tapeLen') });
	row({ ...base, metric: `runNsPerKey:${shape}`, value: med('runNs') });
}
