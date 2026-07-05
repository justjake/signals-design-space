/**
 * SPK-K1 child, LOGGED build — never-quiescent growth soak (O25/G9).
 * DURATION_MS (default 60s) of continuous traffic with NO quiescence:
 *  - two overlapping holder tokens keep liveTokens >= 1 forever (holders
 *    rotate every HOLD_MS; each writes once, so a holder receipt blocks
 *    its atom's compaction prefix while held);
 *  - dependency topology ROTATES every ROTATE_MS: NC computeds read
 *    atoms[(i+phase)%NA] and atoms[(i*7+phase)%NA]; K1 episode edges are
 *    add-only until quiescence, so every rotation strands old edges;
 *  - frame loop: token -> 4 writes (rotating atoms) -> every 16th frame a
 *    render pass over 4 watchers (commit) -> retire. Retired tokens and
 *    ended passes are only reclaimed AT quiescence (§5.12), so their
 *    records accumulate — the declared-gap surface this soak measures.
 * EVENTS=truncate (default): bridge.events zeroed at each sample so the
 * heap slope isolates the retained planes (K1 + receipts + token/pass
 * records + dedup); EVENTS=retain leaves the always-allocated BridgeEvent
 * stream in place (the reference build's own unbounded growth — reported
 * separately). Samples every SAMPLE_MS: heapUsed after gc(), K1 edge
 * count, tape/archive totals, tokens/passes map sizes, event counts,
 * write latency window medians (walk degradation = last window / first).
 */
import { registerReactBridge } from '/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts';
import { env, envInt, row } from '/Users/jitl/src/alien-signals-opt/packages/cosignal/bench/util.mjs';

const DURATION_MS = envInt('DURATION_MS', 60_000);
const SAMPLE_MS = envInt('SAMPLE_MS', 5_000);
const ROTATE_MS = envInt('ROTATE_MS', 1_000);
const HOLD_MS = envInt('HOLD_MS', 5_000);
const NA = envInt('NA', 64);
const NC = envInt('NC', 64);
const EVENTS = env('EVENTS', 'truncate');

const b = registerReactBridge();
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
const setup = b.passStart('R', []);
const watchers = [];
for (let i = 0; i < 4; i++) watchers.push(b.mountWatcher(setup.id, computeds[i], `w${i}`));
b.passEnd(setup.id, 'commit');

let holderA = b.openBatch('default');
b.write(holderA.id, atoms[0], { kind: 'set', value: 1 });
let holderB;

const k1EdgeCount = () => { let n = 0; for (const s of b.episodeEdges.values()) n += s.size; return n; };
const tapeTotal = () => { let n = 0; for (const nd of b.nodes.values()) if (nd.kind === 'atom') n += nd.tape.length; return n; };
const archiveTotal = () => { let n = 0; for (const nd of b.nodes.values()) if (nd.kind === 'atom') n += nd.archive.length; return n; };

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
		k1: k1EdgeCount(), k1Keys: b.episodeEdges.size,
		tape: tapeTotal(), archive: archiveTotal(),
		tokens: b.tokens.size, passes: b.passes.size,
		events: b.events.length, eventsRate: eventsSinceSample,
		writeNsMed: wMed,
	});
	eventsSinceSample = 0;
	writeNsWindow = [];
	if (EVENTS === 'truncate') b.events.length = 0;
}

while (Date.now() - t0 < DURATION_MS) {
	const now = Date.now();
	if (now - lastRotate >= ROTATE_MS) { phase++; lastRotate = now; }
	if (now - lastHold >= HOLD_MS) {
		// overlap: open the new holder BEFORE retiring the old (never quiescent)
		holderB = b.openBatch('default');
		b.write(holderB.id, atoms[phase % NA], { kind: 'set', value: ++v });
		b.retire(holderA.id, true);
		holderA = holderB;
		lastHold = now;
	}
	const tok = b.openBatch('default');
	const preEvents = b.events.length;
	for (let m = 0; m < 4; m++) {
		const a = atoms[(frame + m * 13) % NA];
		const s0 = process.hrtime.bigint();
		b.write(tok.id, a, { kind: 'set', value: ++v });
		const s1 = process.hrtime.bigint();
		writeNsWindow.push(Number(s1 - s0));
	}
	eventsSinceSample += b.events.length - preEvents;
	if (frame % 16 === 0) {
		const p = b.passStart('R', b.liveTokens().map((t) => t.id));
		for (const w of watchers) b.renderWatcher(p.id, w.id);
		b.passEnd(p.id, 'commit');
	}
	b.retire(tok.id, true);
	frame++;
	if (now - lastSample >= SAMPLE_MS) { takeSample(now); lastSample = now; }
}
takeSample(Date.now());

// linear-fit heap slope over samples (skip the first two: warmup/JIT)
const fit = samples.slice(2);
const n = fit.length;
const mx = fit.reduce((s, p) => s + p.t, 0) / n;
const my = fit.reduce((s, p) => s + p.heap, 0) / n;
const slope = fit.reduce((s, p) => s + (p.t - mx) * (p.heap - my), 0) / fit.reduce((s, p) => s + (p.t - mx) ** 2, 0);
const mbPerHour = (slope * 3600) / (1024 * 1024);
const first = windowMedians[1] ?? windowMedians[0];
const last = windowMedians[windowMedians.length - 1];
const degradePct = ((last - first) / first) * 100;
const end = samples[samples.length - 1];
const start = samples[2];
const perHour = (key) => ((end[key] - start[key]) / (end.t - start.t)) * 3600;

const base = { gate: 'SPK-K1', config: `logged-${EVENTS}`, shape: `soak${Math.round(DURATION_MS / 1000)}s` };
row({ ...base, metric: 'mbPerHour', value: mbPerHour, checksum: v });
row({ ...base, metric: 'walkDegradePct', value: degradePct, checksum: end.writeNsMed });
row({ ...base, metric: 'writeNsFirstWin', value: first, checksum: 0 });
row({ ...base, metric: 'writeNsLastWin', value: last, checksum: 0 });
row({ ...base, metric: 'k1EdgesPerHour', value: perHour('k1'), checksum: end.k1 });
row({ ...base, metric: 'tapeEnd', value: end.tape, checksum: 0 });
row({ ...base, metric: 'tokensPerHour', value: perHour('tokens'), checksum: end.tokens });
row({ ...base, metric: 'passesPerHour', value: perHour('passes'), checksum: end.passes });
row({ ...base, metric: 'eventsPerHour', value: (samples.slice(2).reduce((s, p) => s + p.eventsRate, 0) / (end.t - start.t)) * 3600, checksum: 0 });
row({ ...base, metric: 'framesPerSec', value: frame / end.t, checksum: frame });
console.log(`samples: ${JSON.stringify(samples.map((s) => ({ t: s.t, heapMB: +(s.heap / 1048576).toFixed(2), k1: s.k1, tape: s.tape, tokens: s.tokens, passes: s.passes, wNs: s.writeNsMed })))}`);
