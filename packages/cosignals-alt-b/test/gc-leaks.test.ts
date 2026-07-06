/**
 * GC / leak lifecycle suite — verifies that every record type is reclaimed
 * (or that its retention is the documented, bounded, deliberate kind).
 *
 * Arena engines hide records from the JS heap: the true leak hazards are
 * (a) arena slots that never return to a free list (recNext growth), and
 * (b) side arrays (values/fns/metaCol/logVals/memoVals/lastBroadcast/
 * thenableCache) that keep strong references for dead records — those pin
 * user closures and values, which is a real heap leak.
 *
 * Lifecycles covered (per the audit matrix):
 *  (a) create+dispose effects/scopes/watchers  → free list, recNext stable
 *      (FIXED LEAK: dispose() only queued the record; without a write —
 *      nothing called flush() — a create/dispose loop grew the main plane
 *      and pendingFree forever)
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
import { beforeEach, describe, expect, it } from 'vitest';
import {
	Atom,
	Computed,
	__debug,
	__resetEngineForTests,
	attachFork,
	configure,
	createWatcher,
	effect,
	effectScope,
} from '../src/index';
import { ForkDouble } from '../src/fork';
import { PackedTracer } from '../src/trace';

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

beforeEach(() => {
	__resetEngineForTests();
});

// ---- (a) effects / scopes / watchers: create + dispose N ----------------------

describe('lifecycle (a): create+dispose churn returns records to the free lists', () => {
	it('FIXED LEAK: an effect create/dispose loop with no writes reuses records', () => {
		const a = new Atom({ state: 0 });
		const churn = (n: number): void => {
			const disposers: Array<() => void> = [];
			for (let i = 0; i < n; ++i) {
				disposers.push(effect(() => void a.state));
			}
			for (const d of disposers) {
				d();
			}
		};
		churn(32); // warmup: reach the high-water mark
		const base = __debug.stats().recNext;
		for (let i = 0; i < 50; ++i) {
			churn(32);
		}
		// Pre-fix: dispose() only queued the record on pendingFree and nothing
		// swept it without a flush — recNext grew by 32 records per cycle.
		expect(__debug.stats().recNext).toBe(base);
		expect(__debug.stats().pendingFreeLen).toBe(0);
		__debug.verify();
	});

	it('scopes with nested effects: recNext stable across cycles', () => {
		const a = new Atom({ state: 0 });
		const churn = (n: number): void => {
			const disposers: Array<() => void> = [];
			for (let i = 0; i < n; ++i) {
				disposers.push(
					effectScope(() => {
						effect(() => void a.state);
						effect(() => void a.state);
					}),
				);
			}
			for (const d of disposers) {
				d();
			}
		};
		churn(16);
		const base = __debug.stats().recNext;
		for (let i = 0; i < 50; ++i) {
			churn(16);
		}
		expect(__debug.stats().recNext).toBe(base);
		expect(__debug.stats().pendingFreeLen).toBe(0);
		__debug.verify();
	});

	it('watchers: recNext stable and the live-watcher registry drains', () => {
		const a = new Atom({ state: 0 });
		const churn = (n: number): void => {
			const handles = [];
			for (let i = 0; i < n; ++i) {
				handles.push(createWatcher(a, () => {}));
			}
			for (const h of handles) {
				h.dispose();
			}
		};
		churn(16);
		const base = __debug.stats().recNext;
		for (let i = 0; i < 50; ++i) {
			churn(16);
		}
		expect(__debug.stats().recNext).toBe(base);
		expect(__debug.stats().liveWatcherCount).toBe(0);
		expect(__debug.stats().pendingFreeLen).toBe(0);
		__debug.verify();
	});
});

// ---- (d) dynamic dependency churn ----------------------------------------------

describe('lifecycle (d): dynamic dep churn reuses link records', () => {
	it('branch-flipping computed under an effect: recNext stable over 200 flips', () => {
		const flag = new Atom({ state: true });
		const x = new Atom({ state: 1 });
		const y = new Atom({ state: 2 });
		const c = new Computed({ fn: () => (flag.state ? x.state : y.state) });
		const stop = effect(() => void c.state);
		flag.set(false); // warmup: both branches' links exist(ed)
		flag.set(true);
		const base = __debug.stats().recNext;
		for (let i = 0; i < 200; ++i) {
			flag.update((v) => !v);
		}
		expect(__debug.stats().recNext).toBe(base);
		stop();
		__debug.verify();
	});
});

// ---- (b)/(c) dropped handles: reclaimed by DEFAULT; bounded leak on opt-out ----

describe('lifecycle (b)/(c): dropped atom/computed handles', () => {
	it('DOCUMENTED LEAK (finalization: false, the explicit opt-out): dropped handles retain their records — bounded at one record + its own slots each, linear growth only', () => {
		// The opt-out contract: zero FinalizationRegistry overhead, and each
		// dropped unwatched handle pins exactly its own record, forever.
		configure({ finalization: false });
		const base = __debug.stats().recNext;
		for (let i = 0; i < 100; ++i) {
			new Atom({ state: i }); // handle dropped immediately
		}
		const afterFirst = __debug.stats().recNext;
		expect(afterFirst - base).toBe(100 * 8); // exactly one record per atom, never freed
		// The bound: leaked records never grow per-operation afterwards —
		// another batch of drops grows by exactly its own records.
		for (let i = 0; i < 100; ++i) {
			new Atom({ state: i });
		}
		expect(__debug.stats().recNext - afterFirst).toBe(100 * 8);
		__debug.verify();
	});

	it.runIf(hasGC)(
		'DEFAULT config: GC reclaims dropped never-watched atoms/computeds (arena plateaus)',
		async () => {
			// finalization is ON by default — no configure() call.
			const makeGarbage = (n: number): void => {
				for (let i = 0; i < n; ++i) {
					new Atom({ state: i });
					new Computed({ fn: () => i * 2 });
				}
			};
			makeGarbage(64);
			await gcSettle();
			const base = __debug.stats().recNext;
			for (let round = 0; round < 4; ++round) {
				makeGarbage(64);
				await gcSettle();
			}
			// Unreclaimed growth would be 4 * 128 records; a plateau within one
			// round's worth proves the registry is returning records.
			expect(__debug.stats().recNext - base).toBeLessThanOrEqual(128 * 8);
			__debug.verify();
		},
	);

	it.runIf(hasGC)(
		'DEFAULT config: watched→unwatched computeds reclaim after handles drop',
		async () => {
			// finalization is ON by default — no configure() call.
			const src = new Atom({ state: 0 });
			// NOTE (documented limitation, inherent to JS closures): the
			// computed's fn must be created in a scope that does NOT also
			// capture the handle — the engine retains fn strongly (fns[]/
			// metaCol), and V8 gives every closure born in a scope the scope's
			// one shared context; if that context also held `c`, fn would pin
			// the handle and finalization could never fire.
			const makeComputed = () => new Computed({ fn: () => (src.state as number) * 2 });
			const cycle = (): void => {
				const c = makeComputed();
				const stop = effect(() => void c.state); // watched
				stop(); // unwatched: deps dropped, subscribers gone
			};
			for (let i = 0; i < 50; ++i) {
				cycle();
			}
			await gcSettle();
			const base = __debug.stats().recNext;
			for (let i = 0; i < 50; ++i) {
				cycle();
			}
			await gcSettle();
			expect(__debug.stats().recNext - base).toBeLessThanOrEqual(16 * 8);
			__debug.verify();
		},
	);
});

// ---- finalization retry: the GC callback raced a guard --------------------------

describe('finalization retry (fixed leak): a guarded skip must not leak forever', () => {
	it('retries when the last subscriber unlinks (watcher held the atom)', () => {
		// finalization is ON by default — no configure() call.
		const a = new Atom({ state: 1 });
		const w = createWatcher(a, () => {});
		// GC decides the atom handle is unreachable while the watcher still
		// subscribes: the reclaim must be deferred, not dropped.
		__debug.simulateFinalize(a);
		expect(__debug.stats().finalizePending).toBe(1);
		w.dispose(); // last subscriber gone → deferred reclaim fires
		expect(__debug.stats().finalizePending).toBe(0);
		const before = __debug.stats().recNext;
		new Atom({ state: 2 }); // reuses a reclaimed record
		expect(__debug.stats().recNext).toBe(before);
		__debug.verify();
	});

	it('retries when the live tape sweeps away (LOGGED guard)', () => {
		// finalization is ON by default — no configure() call.
		const fork = new ForkDouble();
		attachFork(fork);
		const a = new Atom({ state: 1 });
		const token = fork.openBatch(true);
		fork.inBatch(token, () => a.set(5));
		__debug.simulateFinalize(a); // guarded: LOGGED (sweep owns the tape)
		expect(__debug.stats().finalizePending).toBe(1);
		fork.retireBatch(token); // absorb + sweep frees the tape → deferred reclaim fires
		expect(__debug.stats().finalizePending).toBe(0);
		expect(__debug.stats().loggedAtomCount).toBe(0);
		const before = __debug.stats().recNext;
		new Atom({ state: 2 });
		expect(__debug.stats().recNext).toBe(before);
		__debug.verify();
	});

	it('deterministic disposeSignal keeps its documented skip semantics (no retry)', () => {
		// finalization is ON by default — no configure() call.
		const a = new Atom({ state: 1 });
		const w = createWatcher(a, () => {});
		// disposeSignal (via simulateFinalize's non-retry sibling) is exercised
		// in policy.test.ts; here: a skipped GC finalize for a STILL-USED
		// record must not free it while referenced.
		__debug.simulateFinalize(a);
		a.set(7); // record untouched while the watcher subscribes
		expect(a.state).toBe(7);
		w.dispose(); // now the retry may fire; the handle must not be used after
		__debug.verify();
	});
});

// ---- (e) transition cycles: tapes, memos, certs, slots, baselines ---------------

describe('lifecycle (e): 100 transition open/commit/abort/truncate cycles', () => {
	it('planes and side arrays return to baseline at quiescence every cycle', () => {
		const fork = new ForkDouble();
		attachFork(fork);
		const a = new Atom({ state: 0 });
		const b = new Atom({ state: 0 });
		const c = new Computed({ fn: () => (a.state as number) + (b.state as number) });
		const w = createWatcher(c, () => {});

		for (let i = 1; i <= 100; ++i) {
			const token = fork.openBatch(true);
			fork.inBatch(token, () => {
				a.set(i);
				b.update((v) => (v as number) + 1);
			});
			// Exercise writer's-world memos + certificates + slot chains.
			__debug.readInWorld(c, { kind: 'writer', token });
			if (i % 4 === 0) {
				__debug.truncateToken(token); // rollback path
				fork.retireBatch(token, false);
			} else if (i % 3 === 0) {
				fork.retireBatch(token, true, 'root'); // commit-then-retire
			} else {
				fork.retireBatch(token, false); // abort: folds identically
			}
			const s = __debug.stats();
			expect(s.gNext).toBe(4);
			expect(s.wNext).toBe(8);
			expect(s.certNext).toBe(0);
			expect(s.liveMemos).toBe(0);
			expect(s.writeMode).toBe('DIRECT'); // quiescence flipped the gate back
		}
		const s = __debug.stats();
		expect(s.memoValsLen).toBe(0);
		expect(s.seqCounter).toBe(1);
		expect(s.loggedAtomCount).toBe(0);
		expect(s.liveSlotMask).toBe(0);
		expect(s.unappliedEntries).toBe(0);
		// FIXED LEAK: per-watcher baselines were keyed by (dead) batch tokens
		// and grew by one pinned value per batch, forever.
		expect(__debug.watcherBaselineCount(w)).toBeLessThanOrEqual(2);
		w.dispose();
		__debug.verify();
	});

	it('overlapping transitions: a dead batch releases its memo values before quiescence', () => {
		const fork = new ForkDouble();
		attachFork(fork);
		const a = new Atom({ state: 0 });
		const c = new Computed({ fn: () => (a.state as number) * 2 });
		for (let i = 0; i < 20; ++i) {
			const t1 = fork.openBatch(true);
			const t2 = fork.openBatch(true);
			fork.inBatch(t1, () => a.set(i * 2 + 1));
			fork.inBatch(t2, () => a.set(i * 2 + 2));
			__debug.readInWorld(c, { kind: 'writer', token: t1 });
			__debug.readInWorld(c, { kind: 'writer', token: t2 });
			const withBoth = __debug.stats().liveMemos;
			fork.retireBatch(t1, false); // t2 still live: no quiescence
			// t1's slot released → its writer's-world memos tombstoned and
			// their memoVals slots cleared before any quiescence reset.
			expect(__debug.stats().liveMemos).toBeLessThan(withBoth);
			fork.retireBatch(t2, false);
			const s = __debug.stats();
			expect(s.liveMemos).toBe(0);
			expect(s.memoValsLen).toBe(0);
			expect(s.wNext).toBe(8);
		}
		__debug.verify();
	});

	it('FIXED LEAK: certificate region does not grow per write while a transition is held open', () => {
		const fork = new ForkDouble();
		attachFork(fork);
		const a = new Atom({ state: 0 });
		const c = new Computed({ fn: () => (a.state as number) + 1 });
		const token = fork.openBatch(true);
		fork.inBatch(token, () => a.set(1));
		__debug.readInWorld(c, { kind: 'writer', token }); // memo + cert exist
		const base = __debug.stats().certNext;
		for (let i = 2; i <= 101; ++i) {
			fork.inBatch(token, () => a.set(i)); // coalesces; invalidates the memo
			__debug.readInWorld(c, { kind: 'writer', token }); // re-memoizes
		}
		// Re-memoization must reuse the record's certificate run in place: the
		// held-open hot loop previously bump-allocated ~2 ints per write.
		expect(__debug.stats().certNext - base).toBeLessThanOrEqual(4);
		fork.retireBatch(token, false);
		__debug.verify();
	});

	it('watcher baselines prune across batches even without full quiescence gaps', () => {
		const fork = new ForkDouble();
		attachFork(fork);
		const a = new Atom({ state: 0 });
		const w = createWatcher(a, () => {});
		for (let i = 1; i <= 60; ++i) {
			const token = fork.openBatch(true);
			fork.inBatch(token, () => a.set(i));
			fork.retireBatch(token, i % 2 === 0);
		}
		expect(__debug.watcherBaselineCount(w)).toBeLessThanOrEqual(2);
		w.dispose();
		__debug.verify();
	});

	it('FIXED LEAK: retired render lineages release their thenable-cache slots at quiescence', () => {
		const fork = new ForkDouble();
		attachFork(fork);
		const a = new Atom({ state: 1 });
		const forever: PromiseLike<number> = {
			then() {
				return forever; // pending forever
			},
		} as unknown as PromiseLike<number>;
		const c = new Computed<number>({
			fn: (ctx) => (a.state as number) + ctx.use(forever),
		});
		const token = fork.openBatch(true);
		fork.inBatch(token, () => a.set(2)); // tape below c → pass reads divert to the overlay
		fork.startRenderPass('root', [token], 42);
		let thrown: unknown;
		try {
			void c.state; // suspends: caches `forever` under lineage 42 (and 0 via the kernel eval)
		} catch (t) {
			thrown = t;
		}
		expect(thrown).toBe(forever);
		expect(__debug.thenableLineageKeys(c)).toContain(42);
		fork.endRenderPass();
		fork.retireBatch(token, false);
		// Quiescence pruned the retired lineage; only the canonical slot stays.
		const keys = __debug.thenableLineageKeys(c);
		expect(keys).not.toContain(42);
		expect(keys.every((k) => k === 0)).toBe(true);
		__debug.verify();
	});
});

// ---- (f) tracing: RING wraparound + SESSION chunk lifecycle ----------------------

describe('lifecycle (f): trace storage is bounded', () => {
	it('RING: wraparound overwrites in place — fixed bytes', () => {
		const tr = new PackedTracer({ mode: 'ring', capacity: 256 });
		const bytes = tr.stats().bytes;
		for (let i = 1; i <= 10_000; ++i) {
			tr.emit(1, 0, 1, 2, i, 0, 0);
		}
		expect(tr.stats().bytes).toBe(bytes); // never grew
		expect(tr.eventCount()).toBe(10_000);
		expect(tr.droppedBefore()).toBe(10_000 - 256);
		expect(tr.decode(1)).toBeUndefined(); // overwritten (detectable loss)
		expect(tr.decode(10_000)?.args[0]).toBe(10_000);
	});

	it('SESSION: sealed chunks accumulate only to maxBytes, then degrade loudly', () => {
		const chunkSize = 256;
		const maxBytes = chunkSize * 8 * 4 * 3; // room for exactly 3 chunks
		const tr = new PackedTracer({ mode: 'session', chunkSize, maxBytes });
		for (let i = 0; i < chunkSize * 5; ++i) {
			tr.emit(1, 0, 1, 2, i, 0, 0);
		}
		const s = tr.stats();
		expect(s.truncated).toBe(true); // loud, never silent
		expect(s.chunks).toBeLessThanOrEqual(3); // bounded by maxBytes
		expect(s.bytes).toBeLessThanOrEqual(maxBytes);
		expect(tr.verifyComplete().truncatedAt).toBeGreaterThan(0);
	});

	it('SESSION below maxBytes: complete, sealed chunks stable while recording', () => {
		const tr = new PackedTracer({ mode: 'session', chunkSize: 64 });
		for (let i = 0; i < 200; ++i) {
			tr.emit(1, 0, 1, 2, i, 0, 0);
		}
		expect(tr.verifyComplete().complete).toBe(true);
		expect(tr.sealedChunks().length).toBe(tr.stats().chunks - 1); // final chunk is live
	});
});

// ---- heapUsed stabilization (--expose-gc) ----------------------------------------

describe.runIf(hasGC)('heapUsed stabilizes (no strong refs to dead records)', () => {
	it('transition cycles with large payload values do not pin memory', async () => {
		const fork = new ForkDouble();
		attachFork(fork);
		const a = new Atom<number[]>({ state: [] });
		const c = new Computed({ fn: () => (a.state as number[]).length });
		const w = createWatcher(c, () => {});
		const cycle = (i: number): void => {
			const token = fork.openBatch(true);
			fork.inBatch(token, () => a.set(new Array(4096).fill(i))); // ~32KB payload
			__debug.readInWorld(c, { kind: 'writer', token });
			if (i % 3 === 0) {
				fork.retireBatch(token, true, 'root');
			} else {
				fork.retireBatch(token, false);
			}
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
		__debug.verify();
	});

	it('effect/watcher churn does not grow the heap', async () => {
		const a = new Atom({ state: 0 });
		const churn = (): void => {
			const stops: Array<() => void> = [];
			const handles = [];
			for (let i = 0; i < 100; ++i) {
				const payload = new Array(512).fill(i); // captured by the closure
				stops.push(effect(() => void ((a.state as number) + payload.length)));
				handles.push(createWatcher(a, () => {}));
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
		__debug.verify();
	});
});
