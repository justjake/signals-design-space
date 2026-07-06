/**
 * GC / leak lifecycle suite — verifies that every record type is reclaimed
 * (or that its retention is the documented, bounded, deliberate kind).
 *
 * Arena engines hide records from the JS heap: the true leak hazards are
 * (a) arena slots that never return to a free list (recNext growth), and
 * (b) side arrays (values/fns/metas/logVals/memoVals/lastBroadcast/
 * broadcastLog) that keep strong references for dead records — those pin
 * user closures and values, which is a real heap leak.
 *
 * Lifecycles covered (per the audit matrix):
 *  (a) create+dispose effects/scopes/watchers  → free list, recNext stable
 *  (b) watched→unwatched computeds, handles dropped → FinalizationRegistry
 *  (c) never-watched dropped handles → documented leak (default) /
 *      reclaimed (finalization: true)
 *  (d) dynamic dependency churn → link free list, recNext stable
 *  (e) transition open/commit/abort/truncate cycles → tapes, memos, certs,
 *      slot chains, watcher baselines all at baseline after quiescence
 *  (f) trace RING wraparound and SESSION chunk lifecycle → bounded storage
 * plus the finalization retry paths (GC callback raced a guard) and the
 * heapUsed stabilization checks (--expose-gc).
 */
import { describe, expect, it } from 'vitest';
import { createCosignalEngine } from '../src/engine';
import { createForkDouble } from '../src/fork-double';
import { createTracer, TraceKind } from '../src/tracing';

const hasGC = typeof globalThis.gc === 'function';

function gcNow(): void {
	(globalThis.gc as () => void)();
}

/** Let GC + FinalizationRegistry callbacks (macrotask-scheduled) run. */
async function gcSettle(rounds = 8): Promise<void> {
	for (let i = 0; i < rounds; ++i) {
		gcNow();
		await new Promise((r) => setTimeout(r, 2));
	}
}

// ---- (a) effects / scopes / watchers: create + dispose N ----------------------

describe('lifecycle (a): create+dispose churn returns records to the free lists', () => {
	it('effects: recNext stable across 50 create/dispose cycles', () => {
		const e = createCosignalEngine();
		const a = e.atom(0);
		const churn = (n: number): void => {
			const disposers: Array<() => void> = [];
			for (let i = 0; i < n; ++i) {
				disposers.push(e.effect(() => void a.state));
			}
			for (const d of disposers) {
				d();
			}
		};
		churn(32); // warmup: reach the high-water mark
		const base = e.debug.stats().recNext;
		for (let i = 0; i < 50; ++i) {
			churn(32);
		}
		expect(e.debug.stats().recNext).toBe(base);
		expect(e.debug.stats().pendingFreeLen).toBe(0);
		e.debug.verify();
	});

	it('scopes with nested effects: recNext stable across cycles', () => {
		const e = createCosignalEngine();
		const a = e.atom(0);
		const churn = (n: number): void => {
			const disposers: Array<() => void> = [];
			for (let i = 0; i < n; ++i) {
				disposers.push(
					e.effectScope(() => {
						e.effect(() => void a.state);
						e.effect(() => void a.state);
					}),
				);
			}
			for (const d of disposers) {
				d();
			}
		};
		churn(16);
		const base = e.debug.stats().recNext;
		for (let i = 0; i < 50; ++i) {
			churn(16);
		}
		expect(e.debug.stats().recNext).toBe(base);
		e.debug.verify();
	});

	it('watchers: recNext stable and the live-watcher registry drains', () => {
		const e = createCosignalEngine();
		const a = e.atom(0);
		const churn = (n: number): void => {
			const handles = [];
			for (let i = 0; i < n; ++i) {
				handles.push(e.watch(a, () => {}));
			}
			for (const h of handles) {
				h.dispose();
			}
		};
		churn(16);
		const base = e.debug.stats().recNext;
		for (let i = 0; i < 50; ++i) {
			churn(16);
		}
		expect(e.debug.stats().recNext).toBe(base);
		expect(e.debug.stats().liveWatcherCount).toBe(0);
		e.debug.verify();
	});
});

// ---- (d) dynamic dependency churn ----------------------------------------------

describe('lifecycle (d): dynamic dep churn reuses link records', () => {
	it('branch-flipping computed under an effect: recNext stable over 200 flips', () => {
		const e = createCosignalEngine();
		const flag = e.atom(true);
		const x = e.atom(1);
		const y = e.atom(2);
		const c = e.computed(() => (flag.state ? x.state : y.state));
		const stop = e.effect(() => void c.state);
		flag.set(false); // warmup: both branches' links exist(ed)
		flag.set(true);
		const base = e.debug.stats().recNext;
		for (let i = 0; i < 200; ++i) {
			flag.update((v) => !v);
		}
		expect(e.debug.stats().recNext).toBe(base);
		stop();
		e.debug.verify();
	});
});

// ---- (b)/(c) dropped handles: documented default leak, reclaimed with the flag --

describe('lifecycle (b)/(c): dropped atom/computed handles', () => {
	it('DOCUMENTED LEAK (finalization off, the default): dropped handles retain their records — bounded at one record + its own slots each, linear growth only', () => {
		const e = createCosignalEngine();
		const base = e.debug.stats().recNext;
		for (let i = 0; i < 100; ++i) {
			e.atom(i); // handle dropped immediately
		}
		const afterFirst = e.debug.stats().recNext;
		expect(afterFirst - base).toBe(100 * 8); // exactly one record per atom, never freed
		// The bound: leaked records never grow per-operation afterwards —
		// another batch of drops grows by exactly its own records.
		for (let i = 0; i < 100; ++i) {
			e.atom(i);
		}
		expect(e.debug.stats().recNext - afterFirst).toBe(100 * 8);
		e.debug.verify();
	});

	it.runIf(hasGC)(
		'finalization: true — GC reclaims dropped never-watched atoms/computeds (arena plateaus)',
		async () => {
			const e = createCosignalEngine({ finalization: true });
			const makeGarbage = (n: number): void => {
				for (let i = 0; i < n; ++i) {
					e.atom(i);
					e.computed(() => i * 2);
				}
			};
			makeGarbage(64);
			await gcSettle();
			const base = e.debug.stats().recNext;
			for (let round = 0; round < 4; ++round) {
				makeGarbage(64);
				await gcSettle();
			}
			// Unreclaimed growth would be 4 * 128 records; a plateau within one
			// round's worth proves the registry is returning records.
			expect(e.debug.stats().recNext - base).toBeLessThanOrEqual(128 * 8);
			e.debug.verify();
		},
	);

	it.runIf(hasGC)(
		'finalization: true — watched→unwatched computeds reclaim after handles drop',
		async () => {
			const e = createCosignalEngine({ finalization: true });
			const src = e.atom(0);
			// NOTE (documented limitation, inherent to JS closures): the
			// computed's fn must be created in a scope that does NOT also
			// capture the handle — the engine retains fn strongly (fns[]), and
			// V8 gives every closure born in a scope the scope's one shared
			// context; if that context also held `c`, fn would pin the handle
			// and finalization could never fire.
			const makeComputed = () => e.computed(() => (src.state as number) * 2);
			const cycle = (): void => {
				const c = makeComputed();
				const stop = e.effect(() => void c.state); // watched
				stop(); // unwatched: deps dropped, subscribers gone
			};
			for (let i = 0; i < 50; ++i) {
				cycle();
			}
			await gcSettle();
			const base = e.debug.stats().recNext;
			for (let i = 0; i < 50; ++i) {
				cycle();
			}
			await gcSettle();
			expect(e.debug.stats().recNext - base).toBeLessThanOrEqual(16 * 8);
			e.debug.verify();
		},
	);
});

// ---- finalization retry: the GC callback raced a guard --------------------------

describe('finalization retry (fixed leak): a guarded skip must not leak forever', () => {
	it('retries when the last subscriber unlinks (watcher held the atom)', () => {
		const e = createCosignalEngine({ finalization: true });
		const a = e.atom(1);
		const w = e.watch(a, () => {});
		// GC decides the atom handle is unreachable while the watcher still
		// subscribes: the reclaim must be deferred, not dropped.
		e.debug.simulateFinalize(a);
		expect(e.debug.stats().finalizePending).toBe(1);
		w.dispose(); // last subscriber gone → deferred reclaim fires
		expect(e.debug.stats().finalizePending).toBe(0);
		const before = e.debug.stats().recNext;
		e.atom(2); // reuses a reclaimed record
		expect(e.debug.stats().recNext).toBe(before);
		e.debug.verify();
	});

	it('retries when the live tape sweeps away (LOGGED guard)', () => {
		const e = createCosignalEngine({ finalization: true });
		const fork = createForkDouble();
		e.attachFork(fork);
		fork.registerRoot('root');
		const a = e.atom(1);
		const t = fork.openBatch('deferred');
		t.run(() => a.set(5));
		e.debug.simulateFinalize(a); // guarded: LOGGED (sweep owns the tape)
		expect(e.debug.stats().finalizePending).toBe(1);
		t.retire(); // absorb + sweep frees the tape → deferred reclaim fires
		expect(e.debug.stats().finalizePending).toBe(0);
		expect(e.debug.stats().loggedAtomCount).toBe(0);
		const before = e.debug.stats().recNext;
		e.atom(2);
		expect(e.debug.stats().recNext).toBe(before);
		e.debug.verify();
	});
});

// ---- (e) transition cycles: tapes, memos, certs, slots, baselines ---------------

describe('lifecycle (e): 100 transition open/commit/abort/truncate cycles', () => {
	it('planes and side arrays return to baseline at quiescence every cycle', () => {
		const e = createCosignalEngine();
		const fork = createForkDouble();
		e.attachFork(fork);
		fork.registerRoot('root');
		const a = e.atom(0);
		const b = e.atom(0);
		const c = e.computed(() => (a.state as number) + (b.state as number));
		const w = e.watch(c, () => {});

		for (let i = 1; i <= 100; ++i) {
			const t = fork.openBatch('deferred');
			t.run(() => {
				a.set(i);
				b.update((v) => (v as number) + 1);
			});
			// Exercise writer's-world memos + certificates + slot chains.
			e.debug.readWorld(c, { kind: 'writer', token: t.token });
			if (i % 4 === 0) {
				e.truncateBatch(t.token); // rollback path
				t.retire(false);
			} else if (i % 3 === 0) {
				t.commitOnRoot('root');
				t.retire();
			} else {
				t.retire(false); // abort: retired-uncommitted folds identically
			}
			expect(e.debug.quiescent()).toBe(true);
			const residue = e.debug.planeResidue();
			expect(residue.g).toBe(true);
			expect(residue.w).toBe(true);
		}
		const s = e.debug.stats();
		expect(s.gNext).toBe(4);
		expect(s.wNext).toBe(8);
		expect(s.certNext).toBe(2);
		expect(s.memoValsLen).toBe(0);
		expect(s.seqCounter).toBe(1);
		expect(s.loggedAtomCount).toBe(0);
		expect(s.liveSlotMask).toBe(0);
		expect(s.unappliedEntries).toBe(0);
		// FIXED LEAK: per-watcher baselines were keyed by (dead) batch tokens
		// and grew by one pinned value per batch, forever.
		expect(e.debug.watcherBaselineCount(w)).toBeLessThanOrEqual(2);
		e.debug.takeBroadcasts();
		w.dispose();
		e.debug.verify();
	});

	it('overlapping transitions: a dead batch releases its memo values before quiescence', () => {
		const e = createCosignalEngine();
		const fork = createForkDouble();
		e.attachFork(fork);
		fork.registerRoot('root');
		const a = e.atom(0);
		const c = e.computed(() => (a.state as number) * 2);
		for (let i = 0; i < 20; ++i) {
			const t1 = fork.openBatch('deferred');
			const t2 = fork.openBatch('deferred');
			t1.run(() => a.set(i * 2 + 1));
			t2.run(() => a.set(i * 2 + 2));
			e.debug.readWorld(c, { kind: 'writer', token: t1.token });
			e.debug.readWorld(c, { kind: 'writer', token: t2.token });
			t1.retire(false); // t2 still live: no quiescence — slot release must clean up
			expect(e.debug.quiescent()).toBe(false);
			t2.retire(false);
			expect(e.debug.quiescent()).toBe(true);
			expect(e.debug.stats().memoValsLen).toBe(0);
		}
		e.debug.verify();
	});

	it('FIXED LEAK: certificate region does not grow per write while a transition is held open', () => {
		const e = createCosignalEngine();
		const fork = createForkDouble();
		e.attachFork(fork);
		fork.registerRoot('root');
		const a = e.atom(0);
		const c = e.computed(() => (a.state as number) + 1);
		const t = fork.openBatch('deferred');
		t.run(() => a.set(1));
		e.debug.readWorld(c, { kind: 'writer', token: t.token }); // memo + cert exist
		const base = e.debug.stats().certNext;
		for (let i = 2; i <= 101; ++i) {
			t.run(() => a.set(i)); // coalesces on the tape; invalidates the memo
			e.debug.readWorld(c, { kind: 'writer', token: t.token }); // re-memoizes
		}
		// Re-memoization must reuse the record's certificate run in place: the
		// held-open hot loop previously bump-allocated ~2 ints per write.
		expect(e.debug.stats().certNext - base).toBeLessThanOrEqual(4);
		t.retire(false);
		e.debug.verify();
	});

	it('watcher baselines prune across batches even without full quiescence gaps', () => {
		const e = createCosignalEngine();
		const fork = createForkDouble();
		e.attachFork(fork);
		fork.registerRoot('root');
		const a = e.atom(0);
		const w = e.watch(a, () => {});
		for (let i = 1; i <= 60; ++i) {
			const t = fork.openBatch('deferred');
			t.run(() => a.set(i));
			t.retire(i % 2 === 0);
		}
		expect(e.debug.watcherBaselineCount(w)).toBeLessThanOrEqual(2);
		w.dispose();
		e.debug.takeBroadcasts();
		e.debug.verify();
	});
});

// ---- broadcastLog bound (fixed leak) --------------------------------------------

describe('broadcast log (fixed leak): bounded when never drained', () => {
	it('drops oldest events past the cap instead of growing forever', () => {
		const e = createCosignalEngine();
		const fork = createForkDouble();
		e.attachFork(fork);
		fork.registerRoot('root');
		const a = e.atom(0);
		const w = e.watch(a, () => {});
		const t = fork.openBatch('deferred');
		for (let i = 1; i <= 17_000; ++i) {
			t.run(() => a.set(i)); // one writer's-world broadcast each
		}
		const s = e.debug.stats();
		expect(s.broadcastLogSize).toBeLessThanOrEqual(16_384);
		expect(s.broadcastLogDropped).toBeGreaterThan(0);
		expect(e.debug.takeBroadcasts().length).toBeLessThanOrEqual(16_384);
		t.retire(false);
		w.dispose();
		e.debug.verify();
	});
});

// ---- (f) tracing: RING wraparound + SESSION chunk lifecycle ----------------------

describe('lifecycle (f): trace storage is bounded', () => {
	it('RING: wraparound overwrites in place — one allocation, fixed bytes', () => {
		const tr = createTracer({ mode: 'ring', capacity: 256 });
		for (let i = 0; i < 10_000; ++i) {
			tr.emit(TraceKind.ATOM_WRITE, 1, 2, i, 0, 0);
		}
		expect(tr.stats().allocations).toBe(1); // never grew
		expect(tr.eventCount).toBe(10_000);
		expect(tr.dropCount).toBe(10_000 - 256);
		expect(tr.decode(0)).toBeUndefined(); // overwritten (detectable loss)
		expect(tr.decode(9_999)?.args[0]).toBe(9_999);
	});

	it('SESSION: sealed chunks accumulate only to maxBytes, then degrade loudly', () => {
		const chunkSize = 256;
		const maxBytes = chunkSize * 8 * 4 * 3; // room for exactly 3 chunks
		const tr = createTracer({ mode: 'session', chunkSize, maxBytes });
		for (let i = 0; i < chunkSize * 5; ++i) {
			tr.emit(TraceKind.ATOM_WRITE, 1, 2, i, 0, 0);
		}
		const s = tr.stats();
		expect(s.truncated).toBe(true); // loud, never silent
		expect(s.chunks).toBeLessThanOrEqual(3); // bounded by maxBytes
		expect(s.chunks * chunkSize * 8 * 4).toBeLessThanOrEqual(maxBytes);
		expect(tr.verifyLossless().lossless).toBe(false);
	});

	it('SESSION below maxBytes: lossless, sealed chunks stable while recording', () => {
		const tr = createTracer({ mode: 'session', chunkSize: 64 });
		for (let i = 0; i < 200; ++i) {
			tr.emit(TraceKind.ATOM_WRITE, 1, 2, i, 0, 0);
		}
		expect(tr.verifyLossless().lossless).toBe(true);
		expect(tr.sealedChunks().length).toBe(3); // 200/64 → 3 sealed + 1 live
	});
});

// ---- heapUsed stabilization (--expose-gc) ----------------------------------------

describe.runIf(hasGC)('heapUsed stabilizes (no strong refs to dead records)', () => {
	it('transition cycles with large payload values do not pin memory', async () => {
		const e = createCosignalEngine();
		const fork = createForkDouble();
		e.attachFork(fork);
		fork.registerRoot('root');
		const a = e.atom<number[]>([]);
		const c = e.computed(() => (a.state as number[]).length);
		const w = e.watch(c, () => {});
		const cycle = (i: number): void => {
			const t = fork.openBatch('deferred');
			t.run(() => a.set(new Array(4096).fill(i))); // ~32KB payload
			e.debug.readWorld(c, { kind: 'writer', token: t.token });
			if (i % 3 === 0) {
				t.commitOnRoot('root');
				t.retire();
			} else {
				t.retire(false);
			}
			e.debug.takeBroadcasts();
		};
		const samples: number[] = [];
		for (let round = 0; round < 6; ++round) {
			for (let i = 1; i <= 25; ++i) {
				cycle(round * 25 + i);
			}
			await gcSettle(4);
			samples.push(process.memoryUsage().heapUsed);
		}
		// A pinned-payload leak would grow ≈ 800KB per round; allow generous
		// noise while catching monotonic growth.
		const growth = samples[5] - samples[1];
		expect(growth).toBeLessThan(1024 * 1024);
		w.dispose();
		e.debug.verify();
	});

	it('effect/watcher churn does not grow the heap', async () => {
		const e = createCosignalEngine();
		const a = e.atom(0);
		const churn = (): void => {
			const stops: Array<() => void> = [];
			const handles = [];
			for (let i = 0; i < 100; ++i) {
				const payload = new Array(512).fill(i); // captured by the closure
				stops.push(e.effect(() => void ((a.state as number) + payload.length)));
				handles.push(e.watch(a, () => {}));
			}
			for (const s of stops) {
				s();
			}
			for (const h of handles) {
				h.dispose();
			}
		};
		const samples: number[] = [];
		for (let round = 0; round < 6; ++round) {
			for (let i = 0; i < 5; ++i) {
				churn();
			}
			await gcSettle(4);
			samples.push(process.memoryUsage().heapUsed);
		}
		const growth = samples[5] - samples[1];
		expect(growth).toBeLessThan(768 * 1024);
		e.debug.verify();
	});
});
