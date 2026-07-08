// NF2 P2.S-B bench gate (plans/2026-07-06 §4.9.6, codex major 6): the
// untracked-fan shape — one hot atom, K=100 weak-only dependents in each of
// R=4 committed arenas, write-storm delivery cost ≤ 1.4× the head-bridge
// anchor; breach = mid-stage STOP before S-C (forcing the §4.4.1
// segregated-list fallback decision). The weak-edge bit-test cost lands with
// S-B's walk re-home: the anchor's K1 walk never visited weak edges (they
// lived in a separate table), while the arena walk visits-and-skips every
// weak link on the hot atom's subs list.
//
// Run twice and compare (same script, both trees):
//   COSIGNAL_ROOT=<head-worktree> node --expose-gc --import tsx spkb-sb-gates.mjs   → anchor
//   COSIGNAL_ROOT=<repo>          node --expose-gc --import tsx spkb-sb-gates.mjs   → S-B
import process from 'node:process';

const ROOT = process.env.COSIGNAL_ROOT ?? '/Users/jitl/src/alien-signals-opt';
// The engine module moved (concurrent.ts fused into CosignalEngine.ts);
// this bench drives A/B across generations, so try the fused module first
// and fall back to the old path on pre-fusion trees.
let mod = await import(`${ROOT}/packages/cosignals/src/CosignalEngine.ts`);
if (mod.engine === undefined) mod = await import(`${ROOT}/packages/cosignals/src/concurrent.ts`);

/**
 * A/B seam (COSIGNAL_ROOT swaps trees): the anchor tree constructs one
 * bridge per shape; the fused tree resets its default instance between
 * shapes (`__TEST__resetEngine`; `__resetEngineForTest` on pre-fusion trees).
 * The reset asserts quiescence — the
 * shape below already ends quiescent (every render ends, every batch
 * retires) — and the drain below is insurance for leftovers.
 */
function acquireEngine() {
	if (typeof mod.__newBridgeForTest === 'function') {
		const b = mod.__newBridgeForTest();
		b.registerBridge();
		// Pre-rename trees expose the render frame as pass*: alias so one
		// script drives both sides of the A/B.
		if (b.renderStart === undefined) {
			b.renderStart = b.passStart;
			b.renderEnd = b.passEnd;
			b.renderValue = b.passValue;
		}
		return b;
	}
	const e = mod.engine;
	e.discardAllWip();
	for (const t of e.liveBatches()) (t.parked ? e.settleAction(t.id) : e.retire(t.id));
	(mod.__TEST__resetEngine ?? mod.__resetEngineForTest)();
	return e;
}

const REPS = Number(process.env.REPS ?? 15);
const K = 100; // weak-only dependents per arena
const R = 4; // committed arenas (roots)
const WRITES = 2000; // write storm length per rep

function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function untrackedFan() {
	const b = acquireEngine();
	const hot = b.atom('hot', 0);
	let checksum = 0;
	const aggs = [];
	// Per root: K computeds reading `hot` UNTRACKED (weak links only) plus a
	// tiny tracked distinguisher, aggregated under one committed watcher so
	// the whole fan populates the root's committed arena.
	for (let r = 0; r < R; r++) {
		const base = b.atom(`base${r}`, r);
		const fans = Array.from({ length: K }, (_, i) =>
			b.computed(`c${r}.${i}`, (read, untracked) => Number(untracked(hot)) + Number(read(base)) + i));
		const agg = b.computed(`agg${r}`, (read) => {
			let s = 0;
			for (let i = 0; i < K; i++) s += Number(read(fans[i]));
			return s;
		});
		const p = b.renderStart(`R${r}`, []);
		b.mountWatcher(p.id, agg, `W${r}`);
		b.renderEnd(p.id, 'commit'); // committed arena now holds K weak hot→c links
		aggs.push(agg);
	}
	const times = [];
	for (let rep = 0; rep < REPS + 3; rep++) {
		const t = b.openBatch();
		globalThis.gc?.();
		const t0 = process.hrtime.bigint();
		for (let i = 0; i < WRITES; i++) {
			b.write(t.id, hot, 0, i + rep);
		}
		const t1 = process.hrtime.bigint();
		b.retire(t.id);
		for (let r = 0; r < R; r++) checksum += Number(b.committedValue(aggs[r], `R${r}`));
		if (rep >= 3) times.push(Number(t1 - t0) / WRITES); // per-write ns (delivery walk incl. weak bit-tests)
	}
	return { ns: median(times), checksum };
}

const uf = untrackedFan();
console.log(`@@ROW ${JSON.stringify({ gate: 'S-B', shape: 'untracked-fan', metric: 'writeStormNsPerWrite', value: uf.ns, checksum: uf.checksum, root: ROOT })}`);
