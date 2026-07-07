// Measures the logged build's delivery fan-out: F watchers on c=a+1 (one
// root), B fresh batches per frame, W writes/frame round-robin across them,
// alternating changed/equal values (equal writes exercise value-blindness:
// the logged build records and delivers them; the base build drops them).
// Frame = writes -> render pass (renders all watchers, commits) -> retire
// the frame's batches. HELD=1 adds a batch held open for the whole rep,
// whose unretired log entry blocks history compaction behind it. Metrics:
// propagate ns/write (write-call time only), frame ns, deliveries and
// spurious renders per (watcher, batch, cycle), held-row history growth +
// first/last frame write-time degradation.
import { registerReactBridge } from '/Users/jitl/src/alien-signals-opt/packages/cosignal/src/index.ts';
import { env, envInt, row } from '/Users/jitl/src/alien-signals-opt/packages/cosignal/bench/util.mjs';

const F = envInt('F', 8); // watchers
const B = envInt('B', 1); // batches (fresh batches) per frame
const W = envInt('W', 8); // writes per frame
const FRAMES = envInt('FRAMES', 30);
const HELD = envInt('HELD', 0) === 1;
/**
 * INTERLEAVE=1: the frame's writes land while the render pass is YIELDED
 * with the written slot in its mask and its pin predating the writes, so
 * render-aware suppression MUST deliver interleaved (that render's frozen
 * world cannot show the writes). Equal-value interleaved deliveries are the
 * spurious-render exposure.
 */
const INTERLEAVE = envInt('INTERLEAVE', 0) === 1;
const REPS = envInt('REPS', 5);
const WARMUP = envInt('WARMUP', 1);

const b = registerReactBridge();
const a = b.atom('a', 0);
const c = b.computed('c', (read) => read(a) + 1);
const setup = b.renderStart('R', []);
const watchers = [];
for (let i = 0; i < F; i++) watchers.push(b.mountWatcher(setup.id, c, `w${i}`));
b.renderEnd(setup.id, 'commit');

let v = 0;
function repOnce() {
	const held = HELD ? b.openBatch() : undefined;
	let writeNs = 0;
	let frameNsTot = 0;
	let maxDeliv = 0; // deliveries per (watcher,batch) within one cycle, max
	let maxSpurious = 0; // value-unchanged delivered renders per (watcher,batch,cycle), max
	const firstLast = [];
	for (let f = 0; f < FRAMES; f++) {
		b.events.length = 0;
		const f0 = process.hrtime.bigint();
		const batches = [];
		for (let i = 0; i < B; i++) batches.push(b.openBatch());
		if (held !== undefined) b.write(held.id, a, 0, ++v);
		// per-(watcher,slot) delivery/spurious accounting keyed on event slices
		const perWB = new Map(); // `${watcher}:${slot}` -> {d, s}
		let frameWriteNs = 0;
		let interRender;
		if (INTERLEAVE) {
			// Slot intern happens at first write: seed one changing write per
			// batch so the render mask captures their slots, then open+yield.
			for (const batch of batches) b.write(batch.id, a, 0, ++v);
			interRender = b.renderStart('R', b.liveBatches().map((t) => t.id));
			for (const w of watchers) b.renderWatcher(interRender.id, w.id);
			b.renderYield(interRender.id);
		}
		for (let k = 0; k < W; k++) {
			const batch = batches[k % B];
			const changed = k % 2 === 0;
			const value = changed ? ++v : v;
			const mark = b.events.length;
			const t0 = process.hrtime.bigint();
			b.write(batch.id, a, 0, value);
			const t1 = process.hrtime.bigint();
			frameWriteNs += Number(t1 - t0);
			for (let e = mark; e < b.events.length; e++) {
				const ev = b.events[e];
				if (ev.type !== 'delivery') continue;
				const key = `${ev.watcher}:${ev.slot}`;
				let rec = perWB.get(key);
				if (rec === undefined) { rec = { d: 0, s: 0 }; perWB.set(key, rec); }
				rec.d++;
				if (!changed) rec.s++;
			}
		}
		writeNs += frameWriteNs;
		firstLast.push(frameWriteNs / W);
		if (interRender !== undefined) {
			b.renderResume(interRender.id);
			b.renderEnd(interRender.id, 'commit');
		} else {
			// render cycle: a render pass over all live batches, render every watcher, commit.
			const live = b.liveBatches().map((t) => t.id);
			const p = b.renderStart('R', live);
			for (const w of watchers) b.renderWatcher(p.id, w.id);
			b.renderEnd(p.id, 'commit');
		}
		for (const t of batches) b.retire(t.id);
		const f1 = process.hrtime.bigint();
		frameNsTot += Number(f1 - f0);
		for (const rec of perWB.values()) {
			if (rec.d > maxDeliv) maxDeliv = rec.d;
			if (rec.s > maxSpurious) maxSpurious = rec.s;
		}
	}
	const logLen = a.log.length;
	if (held !== undefined) b.retire(held.id);
	const n = firstLast.length;
	const head = firstLast.slice(0, 5).reduce((x, y) => x + y, 0) / Math.min(5, n);
	const tail = firstLast.slice(-5).reduce((x, y) => x + y, 0) / Math.min(5, n);
	return {
		writeNsPerWrite: writeNs / (FRAMES * W),
		frameNs: frameNsTot / FRAMES,
		maxDeliv, maxSpurious, logLen,
		degradation: tail / head,
	};
}

for (let r = 0; r < WARMUP; r++) repOnce();
const acc = [];
for (let r = 0; r < REPS; r++) { globalThis.gc?.(); acc.push(repOnce()); }
const med = (key) => { const s = acc.map((x) => x[key]).sort((x, y) => x - y); return s[s.length >> 1]; };
const checksum = Number(b.newestValue(c)) + watchers.length;
const base = { gate: 'SPK-N1', config: 'logged', shape: `F${F}xB${B}xW${W}${HELD ? '+held' : ''}${INTERLEAVE ? '+inter' : ''}`, checksum };
row({ ...base, metric: `propNs:${base.shape}`, value: med('writeNsPerWrite') });
row({ ...base, metric: `frameNs:${base.shape}`, value: med('frameNs') });
row({ ...base, metric: `maxDeliv:${base.shape}`, value: med('maxDeliv') });
row({ ...base, metric: `maxSpurious:${base.shape}`, value: med('maxSpurious') });
row({ ...base, metric: `logLen:${base.shape}`, value: med('logLen') });
row({ ...base, metric: `degrade:${base.shape}`, value: med('degradation') });
