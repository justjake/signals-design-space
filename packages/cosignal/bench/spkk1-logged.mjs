// Measures the logged build's growth under a never-quiescent soak: two
// overlapping holder batches keep at least one batch live forever (blocking
// full history compaction), the dependency topology rotates periodically so
// stale recorded edges accumulate, and a frame loop of writes + periodic
// committed render passes runs for DURATION_MS. Samples heap after gc(),
// recorded-edge counts, log-history totals, batch/render map sizes, event
// counts, and write-latency window medians (degradation = last/first).
// EVENTS=truncate zeroes the diagnostic event stream at each sample to
// isolate the engine's retained state; EVENTS=retain leaves it in place to
// measure the unbounded stream itself.
import { env, envInt, row } from '/Users/jitl/src/alien-signals-opt/packages/cosignal/bench/util.mjs';

const ROOT = process.env.COSIGNAL_ROOT ?? '/Users/jitl/src/alien-signals-opt';
const mod = await import(`${ROOT}/packages/cosignal/src/index.ts`);

const DURATION_MS = envInt('DURATION_MS', 60_000);
const SAMPLE_MS = envInt('SAMPLE_MS', 5_000);
const ROTATE_MS = envInt('ROTATE_MS', 1_000);
const HOLD_MS = envInt('HOLD_MS', 5_000);
const NA = envInt('NA', 64);
const NC = envInt('NC', 64);
const EVENTS = env('EVENTS', 'truncate');

// A/B seam (COSIGNAL_ROOT swaps trees): the anchor tree registers a bridge
// instance; this tree has ONE module engine.
const b = typeof mod.registerReactBridge === 'function'
	? mod.registerReactBridge()
	: (mod.__resetEngineForTest?.(), mod.engine);
// Event retention exists only on the anchor tree (this tree deleted the
// retained event log — nothing accumulates, and the EVENTS knob's
// truncate/retain split measures nothing here; its rows report 0).
const hasEvents = b.events !== undefined;
const eventsLen = hasEvents ? () => b.events.length : () => 0;
// Measurement isolation (anchor arm): the truncate config's intent is
// "truncate bridge.events at each sample so the heap slope isolates the
// engine's retained state" — but at this frame rate a 5s inter-sample event
// backlog is hundreds of MB and drowns that signal. Bound the diagnostic
// stream in the truncate config only; the retain config still measures the
// unbounded-stream liability.
if (hasEvents && EVENTS === 'truncate') b.setEventCapacity(65536);
const atoms = [];
for (let i = 0; i < NA; i++) atoms.push(b.atom(`a${i}`, 0));
let phase = 0;
const computeds = [];
for (let i = 0; i < NC; i++) {
	const idx = i;
	computeds.push(b.computed(`c${i}`, (read) => {
		const x = Number(read(atoms[(idx + phase) % NA]));
		const y = Number(read(atoms[(idx * 7 + phase) % NA]));
		return x + y;
	}));
}
const setup = b.renderStart('R', []);
const watchers = [];
for (let i = 0; i < 4; i++) watchers.push(b.mountWatcher(setup.id, computeds[i], `w${i}`));
b.renderEnd(setup.id, 'commit');

let holderA = b.openBatch();
b.write(holderA.id, atoms[0], 0, 1);
let holderB;

const k1EdgeCount = () => { let n = 0; for (const s of b.dependencyEdges.values()) n += s.size; return n; };
const logTotal = () => { let n = 0; for (const nd of b.idToNode.values()) if (nd.kind === 'atom') n += nd.log.length; return n; };

const samples = [];
const t0 = Date.now();
let lastRotate = t0;
let lastHold = t0;
let lastSample = t0;
let v = 0;
let frame = 0;
let writeNsWindow = [];
let eventsSinceSample = 0;
const windowMedians = [];

function takeSample(now) {
	globalThis.gc?.();
	const heap = process.memoryUsage().heapUsed;
	writeNsWindow.sort((a, c) => a - c);
	const wMed = writeNsWindow.length ? writeNsWindow[writeNsWindow.length >> 1] : 0;
	windowMedians.push(wMed);
	samples.push({
		t: (now - t0) / 1000, heap,
		k1: k1EdgeCount(), k1Keys: b.dependencyEdges.size,
		log: logTotal(),
		batches: b.idToBatch.size, renderPasses: b.idToRenderPass.size,
		events: eventsLen(), eventsRate: eventsSinceSample,
		writeNsMed: wMed,
	});
	eventsSinceSample = 0;
	writeNsWindow = [];
	if (hasEvents && EVENTS === 'truncate') b.events.length = 0;
}

while (Date.now() - t0 < DURATION_MS) {
	const now = Date.now();
	if (now - lastRotate >= ROTATE_MS) { phase++; lastRotate = now; }
	if (now - lastHold >= HOLD_MS) {
		// overlap: open the new holder BEFORE retiring the old (never quiescent)
		holderB = b.openBatch();
		b.write(holderB.id, atoms[phase % NA], 0, ++v);
		b.retire(holderA.id);
		holderA = holderB;
		lastHold = now;
	}
	const batch = b.openBatch();
	const preEvents = eventsLen();
	for (let m = 0; m < 4; m++) {
		const a = atoms[(frame + m * 13) % NA];
		const s0 = process.hrtime.bigint();
		b.write(batch.id, a, 0, ++v);
		const s1 = process.hrtime.bigint();
		writeNsWindow.push(Number(s1 - s0));
	}
	eventsSinceSample += eventsLen() - preEvents;
	if (frame % 16 === 0) {
		const p = b.renderStart('R', b.liveBatches().map((t) => t.id));
		for (const w of watchers) b.renderWatcher(p.id, w.id);
		b.renderEnd(p.id, 'commit');
	}
	b.retire(batch.id);
	frame++;
	if (now - lastSample >= SAMPLE_MS) { takeSample(now); lastSample = now; }
}
takeSample(Date.now());

// linear-fit heap slope over samples (skip the first two: warmup/JIT;
// short liability runs keep at least the last two samples)
const fit = samples.length > 4 ? samples.slice(2) : samples.slice(-2);
const n = fit.length;
const mx = fit.reduce((s, p) => s + p.t, 0) / n;
const my = fit.reduce((s, p) => s + p.heap, 0) / n;
const slope = fit.reduce((s, p) => s + (p.t - mx) * (p.heap - my), 0) / fit.reduce((s, p) => s + (p.t - mx) ** 2, 0);
const mbPerHour = (slope * 3600) / (1024 * 1024);
const first = (windowMedians.length > 2 ? windowMedians[1] : windowMedians[0]) ?? windowMedians[0];
const last = windowMedians[windowMedians.length - 1];
const degradePct = ((last - first) / first) * 100;
const end = samples[samples.length - 1];
const start = samples.length > 4 ? samples[2] : samples[0];
const perHour = (key) => ((end[key] - start[key]) / (end.t - start.t)) * 3600;

const base = { gate: 'SPK-K1', config: `logged-${EVENTS}`, shape: `soak${Math.round(DURATION_MS / 1000)}s` };
row({ ...base, metric: 'mbPerHour', value: mbPerHour, checksum: v });
row({ ...base, metric: 'walkDegradePct', value: degradePct, checksum: end.writeNsMed });
row({ ...base, metric: 'writeNsFirstWin', value: first, checksum: 0 });
row({ ...base, metric: 'writeNsLastWin', value: last, checksum: 0 });
row({ ...base, metric: 'k1EdgesPerHour', value: perHour('k1'), checksum: end.k1 });
row({ ...base, metric: 'logEnd', value: end.log, checksum: 0 });
row({ ...base, metric: 'batchesPerHour', value: perHour('batches'), checksum: end.batches });
row({ ...base, metric: 'renderPassesPerHour', value: perHour('renderPasses'), checksum: end.renderPasses });
row({ ...base, metric: 'eventsPerHour', value: (samples.slice(2).reduce((s, p) => s + p.eventsRate, 0) / (end.t - start.t)) * 3600, checksum: 0 });
row({ ...base, metric: 'framesPerSec', value: frame / end.t, checksum: frame });
console.log(`samples: ${JSON.stringify(samples.map((s) => ({ t: s.t, heapMB: +(s.heap / 1048576).toFixed(2), k1: s.k1, log: s.log, batches: s.batches, renderPasses: s.renderPasses, wNs: s.writeNsMed })))}`);
