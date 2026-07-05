// Measures per-write ns of the logged build (receipt append + eager core
// apply + marking/delivery walks + effect flush) on the same shapes as the
// base-build child; writes run in windows of WINDOW per batch, retired
// between windows — retirement excluded from writeNs, included in amortNs.
// bridge.events is truncated between reps so earlier reps cannot skew later ones.
import { registerReactBridge } from '/Users/jitl/src/alien-signals-opt/packages/cosignal/src/index.ts';
import { env, envInt, row } from '/Users/jitl/src/alien-signals-opt/packages/cosignal/bench/util.mjs';

const SHAPE = env('SHAPE', 'bare');
const WRITES = envInt('WRITES', 6400); // per rep
const WINDOW = envInt('WINDOW', 64); // writes per token window
const REPS = envInt('REPS', 7);
const WARMUP = envInt('WARMUP', 2);

const b = registerReactBridge();
const a = b.atom('a', 0);
let evals = 0;
let top;

if (SHAPE === 'chain3') {
	const c1 = b.computed('c1', (read) => { evals++; return read(a) + 1; });
	const c2 = b.computed('c2', (read) => { evals++; return read(c1) + 1; });
	const c3 = b.computed('c3', (read) => { evals++; return read(c2) + 1; });
	b.mountCoreEffect(c3, 'e3');
	top = c3;
} else if (SHAPE === 'fan8') {
	for (let i = 0; i < 8; i++) {
		const c = b.computed(`c${i}`, (read) => { evals++; return read(a) + 1; });
		b.mountCoreEffect(c, `e${i}`);
		top = c;
	}
} else if (SHAPE === 'watch1') {
	const c1 = b.computed('c1', (read) => { evals++; return read(a) + 1; });
	top = c1;
	const p = b.passStart('root', []);
	b.mountWatcher(p.id, c1, 'w1');
	b.passEnd(p.id, 'commit');
} else if (SHAPE !== 'bare') {
	throw new Error(`unknown SHAPE ${SHAPE}`);
}

let i = 0;
/** One rep: WRITES writes in windows of WINDOW; returns [writeNs, amortNs]. */
function repOnce() {
	let writeNs = 0;
	const windows = Math.ceil(WRITES / WINDOW);
	const t0 = process.hrtime.bigint();
	for (let w = 0; w < windows; w++) {
		const tok = b.openBatch();
		const s0 = process.hrtime.bigint();
		for (let k = 0; k < WINDOW; k++) b.write(tok.id, a, { kind: 'set', value: ++i });
		const s1 = process.hrtime.bigint();
		writeNs += Number(s1 - s0);
		b.retire(tok.id, true);
	}
	const t1 = process.hrtime.bigint();
	return [writeNs / (windows * WINDOW), Number(t1 - t0) / (windows * WINDOW)];
}

for (let r = 0; r < WARMUP; r++) repOnce();
const writes = [];
const amorts = [];
let evalsPerWrite = 0;
let eventsPerWrite = 0;
let deliveries = 0;
let suppressed = 0;
for (let r = 0; r < REPS; r++) {
	b.events.length = 0;
	globalThis.gc?.();
	evals = 0;
	const [w, am] = repOnce();
	writes.push(w);
	amorts.push(am);
	evalsPerWrite = evals / WRITES;
	const evs = b.events;
	eventsPerWrite = evs.length / WRITES;
	deliveries = evs.filter((e) => e.type === 'delivery').length / WRITES;
	suppressed = evs.filter((e) => e.type === 'suppressed').length / WRITES;
}
writes.sort((x, y) => x - y);
amorts.sort((x, y) => x - y);
const checksum = b.newestValue(a) + (top !== undefined ? Number(b.newestValue(top)) : 0);
const base = { gate: 'SPK-W', config: 'logged', shape: SHAPE, checksum };
row({ ...base, metric: `writeNs:${SHAPE}`, value: writes[writes.length >> 1] });
row({ ...base, metric: `amortNs:${SHAPE}`, value: amorts[amorts.length >> 1] });
row({ ...base, metric: `evalsPerWrite:${SHAPE}`, value: evalsPerWrite });
row({ ...base, metric: `eventsPerWrite:${SHAPE}`, value: eventsPerWrite });
row({ ...base, metric: `deliveriesPerWrite:${SHAPE}`, value: deliveries });
row({ ...base, metric: `suppressedPerWrite:${SHAPE}`, value: suppressed });
