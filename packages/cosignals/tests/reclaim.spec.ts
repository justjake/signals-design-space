/**
 * Signal-reclamation probes.
 *
 * Two layers:
 *  - REAL-GC plateau probes (P-L1a/b, P-L2, P-DEPS-gc): bounded gc()+timer
 *    rounds with one-round plateau tolerance, never exact-baseline — run only
 *    under --expose-gc (vitest.config.ts forks every worker with it).
 *  - DETERMINISTIC probes through the `__simulateReclaimForTest` seam (real
 *    GC cannot schedule a stale finalizer deterministically): one P-RETRY per
 *    reclamation guard row, P-DEPS, P-CLEANUP (throwing and
 *    reentrant), P-ABA, P-EPOCH.
 *
 * Without FinalizationRegistry-driven reclamation every probe below that
 * asserts a record frees after handle death fails by construction — a build
 * with reclamation removed shows unbounded id growth on these shapes.
 */
import { describe, expect, it } from 'vitest';
import {
	Atom,
	Computed,
	NodeField,
	SuspendedRead,
	effect,
} from '../src/index.js';
import { engine, __resetEngineForTest, type AtomInternals, type CosignalEngine, type EngineResetOptions } from '../src/concurrent.js';
import { E, engineEpoch, __reclaimStatsForTest, __simulateReclaimForTest } from '../src/CosignalEngine.js';

const hasGC = typeof globalThis.gc === 'function';
const gcNow = (): void => (globalThis.gc as () => void)();

/** Let GC + FinalizationRegistry callbacks (task-scheduled) + the reclaim
 * nudge microtask run. */
async function gcSettle(rounds = 8): Promise<void> {
	for (let i = 0; i < rounds; ++i) {
		gcNow();
		await new Promise((r) => setTimeout(r, 2));
	}
}

const tick = (): Promise<void> => new Promise<void>((res) => setTimeout(res, 0));

const idOf = (s: object): number => (s as { _id: number })._id;
const genOf = (id: number): number => E.buffer()[id + NodeField.GEN]!;
const stats = __reclaimStatsForTest;

function bridge(options?: EngineResetOptions): CosignalEngine {
	engine.discardAllWip();
	for (const t of engine.liveBatches()) {
		if (t.parked) engine.settleAction(t.id);
		else engine.retire(t.id);
	}
	__resetEngineForTest(options);
	return engine;
}

function mount(b: CosignalEngine, root: string, node: Parameters<CosignalEngine['mountWatcher']>[1], name: string) {
	const p = b.renderStart(root, []);
	const w = b.mountWatcher(p.id, node, name);
	b.renderEnd(p.id, 'commit');
	return w;
}

function commitWrite(b: CosignalEngine, node: AtomInternals, value: unknown): void {
	const t = b.openBatch();
	b.write(t.id, node, 0, value);
	b.retire(t.id);
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((res) => { resolve = res; });
	return { promise, resolve };
}

// ---- P-RETRY: one probe per reclamation guard row --------------------------------

describe('P-RETRY: every guard skips the reclaim and its clearing site retries it', () => {
	it('kernel SUBS row (computed): skip while watched; unwatched() at the last-subscriber unlink retries and frees', () => {
		bridge();
		const src = new Atom(1);
		const c = new Computed(() => src.state);
		const stop = effect(() => { void c.state; });
		const id = idOf(c);
		const gen = genOf(id);
		__simulateReclaimForTest(id);
		expect(stats().skipped).toBe(1); // guarded: something reads this record
		expect(genOf(id)).toBe(gen); // record untouched
		stop(); // last subscriber unlinks -> unwatched(c) files the retry; the disposer's boundary drains it
		expect(stats().skipped).toBe(0);
		expect(genOf(id)).toBe(gen + 1); // freed: GEN bumped at the sweep
	});

	it('kernel SUBS row (atom): skip while a live effect reads it; frees when the effect disposes', () => {
		bridge();
		const a = new Atom(7);
		const stop = effect(() => { void a.state; });
		const id = idOf(a);
		const gen = genOf(id);
		__simulateReclaimForTest(id);
		expect(stats().skipped).toBe(1);
		stop();
		expect(stats().skipped).toBe(0);
		expect(genOf(id)).toBe(gen + 1);
	});

	it('watcher-index row: skip while a watcher entry exists (live or dormant); removeWatcher retries and frees', async () => {
		const b = bridge();
		const at = new Atom(1);
		const an = b.internalsForAtom(at as unknown as Atom<unknown>);
		const w = mount(b, 'R', an, 'W');
		await tick(); // let mount/lifecycle microtasks settle
		const id = idOf(at);
		const gen = genOf(id);
		__simulateReclaimForTest(id);
		expect(stats().skipped).toBe(1); // guarded by the watcher-index membership
		expect(genOf(id)).toBe(gen);
		b.removeWatcher(w.id); // the index removal files the retry (per-id, edge-triggered)
		await tick(); // the reclaim nudge microtask drains at a boundary
		expect(stats().skipped).toBe(0);
		expect(genOf(id)).toBe(gen + 1);
	});

	it('open-render arena membership row: skip while an open render arena holds the node; render end (arena release) retries and frees', async () => {
		const b = bridge();
		const at = new Atom(3);
		const an = b.internalsForAtom(at as unknown as Atom<unknown>);
		const keep = b.computed('keep', () => 0); // no dep on the atom: isolates the membership row
		const p = b.renderStart('R', []);
		const w = b.mountWatcher(p.id, keep, 'W');
		expect(b.renderValue(an, p)).toBe(3); // pulls the ATOM into the OPEN render's arena (membership only)
		const id = idOf(at);
		const gen = genOf(id);
		__simulateReclaimForTest(id);
		// Guarded: open-render arena membership (the atom has no kernel subs,
		// no watcher, no observation retain — `keep` never reads it).
		expect(stats().skipped).toBe(1);
		expect(genOf(id)).toBe(gen);
		b.renderEnd(p.id, 'commit'); // arena release: the whole-teardown drain re-attempts
		await tick();
		expect(stats().skipped).toBe(0);
		expect(genOf(id)).toBe(gen + 1);
		expect(w.live).toBe(true); // the watched computed itself is untouched
		expect(b.committedValue(keep, 'R')).toBe(0); // the surviving machinery still serves
	});

	it('suspended-list row: skip while any arena suspended list holds the node; the shared removal op (refold unsuspend) retries and frees', async () => {
		const b = bridge();
		const gate = deferred<string>();
		const pub = new Computed<unknown>((ctx) => ctx.use(gate.promise));
		const cn = b.internalsForComputed(pub as unknown as Computed<unknown>);
		const keep = b.computed('keep', () => 0);
		mount(b, 'R', keep, 'W'); // the committed arena lives without watching cn
		expect(b.committedValue(cn, 'R')).toBeInstanceOf(SuspendedRead); // suspended in the committed arena
		expect(b.__arenaStats().suspended).toBe(1);
		const id = idOf(pub);
		const gen = genOf(id);
		__simulateReclaimForTest(id);
		expect(stats().skipped).toBe(1); // guarded: suspended-list membership
		gate.resolve('x');
		await tick(); // settlement drain marks; the suspended entry clears at the refold's arenaUnsuspend
		expect(b.committedValue(cn, 'R')).toBe('x'); // refold consumes the box (arenaUnsuspend files the retry)
		await tick();
		expect(stats().skipped).toBe(0);
		expect(genOf(id)).toBe(gen + 1);
	});

	it('lifecycle-ACTIVE row: skip while the active record exists; the dormancy deletion retries and frees (the dormant fns-slot owner is not a guard)', async () => {
		bridge();
		let cleanups = 0;
		let effects = 0;
		const a = new Atom(0, { effect: () => { effects++; return () => { cleanups++; }; } });
		const id = idOf(a);
		const gen = genOf(id);
		const stop = effect(() => { void a.state; });
		await tick(); // union 0->1 flush: mounted
		expect(effects).toBe(1);
		stop(); // union 1->0 queued; SUBS guard clears but lifecycle is still ACTIVE
		__simulateReclaimForTest(id);
		expect(stats().skipped).toBe(1); // guarded: the id-keyed active lifecycle record
		expect(genOf(id)).toBe(gen);
		await tick(); // flap flush runs the cleanup -> dormancy deletion files the retry
		expect(cleanups).toBe(1);
		await tick(); // nudge boundary
		expect(stats().skipped).toBe(0);
		expect(genOf(id)).toBe(gen + 1); // freed; freeNode cleared the dormant fns-slot owner
	});

	it('obsRefs row: skip while a committed subscription snapshot retains the node; the release-to-zero site retries and frees', async () => {
		const b = bridge();
		const at = new Atom(5);
		const an = b.internalsForAtom(at as unknown as Atom<unknown>);
		const sub = b.mountCommittedObserver('R', 'obs');
		b.captureRun(sub.id, () => { void b.captureRead(an); }); // snapshot retains `an` (retains live while the subscription lives)
		const id = idOf(at);
		const gen = genOf(id);
		__simulateReclaimForTest(id);
		expect(stats().skipped).toBe(1); // guarded: obsRefs > 0 (no kernel subs, no watcher)
		b.removeSubscription(sub.id); // snapshot release drops obsRefs to zero -> retry
		await tick();
		expect(stats().skipped).toBe(0);
		expect(genOf(id)).toBe(gen + 1);
	});

	it('WriteLog row: skip while log entries exist; compaction tape-empty transition retries and frees', async () => {
		const b = bridge();
		const at = new Atom(0);
		const an = b.internalsForAtom(at as unknown as Atom<unknown>);
		const t = b.openBatch();
		b.write(t.id, an, 0, 9);
		const id = idOf(at);
		const gen = genOf(id);
		__simulateReclaimForTest(id);
		expect(stats().skipped).toBe(1); // guarded: a non-empty write log
		b.retire(t.id); // retirement compacts the log to empty -> the transition files the retry
		expect(an.log.n - an.log.start).toBe(0);
		await tick();
		expect(stats().skipped).toBe(0);
		expect(genOf(id)).toBe(gen + 1);
	});
});

// ---- P-DEPS ----------------------------------------------------------------------

describe('P-DEPS: a never-subscribed evaluated computed reclaims and DISPOSES its deps', () => {
	it('deterministic: the dep link unlinks and the source is left subscriber-free', () => {
		bridge();
		const src = new Atom(1);
		const c = new Computed(() => src.state);
		expect(c.state).toBe(1); // evaluated: one dep link src -> c, never subscribed
		const id = idOf(c);
		const gen = genOf(id);
		expect(E.buffer()[idOf(src) + NodeField.SUBS]).not.toBe(0);
		__simulateReclaimForTest(id);
		expect(genOf(id)).toBe(gen + 1); // freed immediately: no guard holds
		expect(E.buffer()[idOf(src) + NodeField.SUBS]).toBe(0); // outgoing deps DISPOSED (not a guard)
		expect(stats().skipped).toBe(0);
	});
});

// ---- P-CLEANUP -------------------------------------------------------------------

describe('P-CLEANUP: owned-effect cleanups defer to the boundary sweep (never the GC job)', () => {
	it('throwing cleanup: reportError isolation, the sweep completes, the record frees behind its cleanups', () => {
		bridge();
		const ran: string[] = [];
		const reported: unknown[] = [];
		const g = globalThis as { reportError?: (e: unknown) => void };
		const orig = g.reportError;
		g.reportError = (e: unknown) => { reported.push(e); };
		try {
			const src = new Atom(1);
			const c = new Computed(() => {
				effect(() => { void src.state; return () => { ran.push('a'); }; });
				effect(() => () => { ran.push('boom'); throw new Error('boom'); });
				return src.state;
			});
			expect(c.state).toBe(1);
			const id = idOf(c);
			const gen = genOf(id);
			__simulateReclaimForTest(id); // phase 1 files the deferred entry; the trailing boundary is phase 2
			expect(ran).toEqual(['boom', 'a']); // reverse dep order (deterministic disposal's order); the throw did not stop the sweep
			expect(reported).toHaveLength(1);
			expect((reported[0] as Error).message).toBe('boom');
			expect(genOf(id)).toBe(gen + 1); // freed AFTER its own cleanups (free-list insertion last)
			expect(stats().deferredCleanups).toBe(0);
		} finally {
			g.reportError = orig;
		}
	});

	it('reentrant cleanup: a cleanup that writes an atom re-enters boundary work, finds the drain guard set, and everything still frees exactly once', () => {
		bridge();
		const target = new Atom(0);
		let cleanupRuns = 0;
		const c = new Computed(() => {
			effect(() => () => {
				cleanupRuns++;
				target.set(42); // re-enters writeAtom -> maybeBoundary -> the nested drain no-ops on the guard
			});
			return 1;
		});
		expect(c.state).toBe(1);
		const id = idOf(c);
		const gen = genOf(id);
		__simulateReclaimForTest(id);
		expect(cleanupRuns).toBe(1); // never double-run
		expect(target.state).toBe(42); // the write landed through the normal public path
		expect(genOf(id)).toBe(gen + 1); // the record still freed after its cleanup
		expect(stats().deferredCleanups).toBe(0);
		expect(stats().skipped).toBe(0);
	});
});

// ---- P-ABA / P-EPOCH -------------------------------------------------------------

describe('P-ABA: generation defusing (raw int32 equality)', () => {
	it('a stale finalizer for a reused record id is inert against the new tenant', () => {
		bridge();
		const src = new Atom(1);
		const make = () => new Computed(() => src.state);
		const c1 = make();
		expect(c1.state).toBe(1);
		const id = idOf(c1);
		const oldGen = genOf(id);
		engine.disposeComputed(c1 as unknown as Computed<unknown>); // deterministic dispose does NOT unregister
		const c2 = make();
		expect(idOf(c2)).toBe(id); // the free list handed the record to the new tenant
		const newGen = genOf(id);
		expect(newGen).toBe(oldGen + 1);
		expect(c2.state).toBe(1);
		__simulateReclaimForTest(id, oldGen); // the dead handle's finalizer arrives late
		expect(genOf(id)).toBe(newGen); // defused: tenancy compare failed
		expect(c2.state).toBe(1); // the new tenant still serves
	});

	it('a stale finalizer never cancels the NEW tenant\'s pending retry ticket', () => {
		bridge();
		const src = new Atom(1);
		const make = () => new Computed(() => src.state);
		const c1 = make();
		void c1.state;
		const id = idOf(c1);
		const oldGen = genOf(id);
		engine.disposeComputed(c1 as unknown as Computed<unknown>);
		const c2 = make();
		expect(idOf(c2)).toBe(id);
		const newGen = genOf(id);
		const stop = effect(() => { void c2.state; });
		__simulateReclaimForTest(id); // new tenant: guarded by SUBS -> ticket filed
		expect(stats().skipped).toBe(1);
		__simulateReclaimForTest(id, oldGen); // stale finalizer for the SAME id
		expect(stats().skipped).toBe(1); // the ticket survives (gen-matched drop only)
		stop();
		expect(stats().skipped).toBe(0);
		expect(genOf(id)).toBe(newGen + 1); // the retry still freed the new tenant's record
	});
});

describe('P-EPOCH: per-epoch registry delivery', () => {
	it('a dead epoch\'s callback no-ops on the closure epoch compare', () => {
		bridge();
		const c = new Computed(() => 1);
		expect(c.state).toBe(1);
		const id = idOf(c);
		const gen = genOf(id);
		__simulateReclaimForTest(id, gen, engineEpoch - 1); // extracted before a reset, delivered after
		expect(genOf(id)).toBe(gen); // untouched
		expect(stats().skipped).toBe(0); // and no ticket filed for a dead epoch
		expect(c.state).toBe(1);
	});

	it('__resetEngineForTest scrubs reclamation state (registry swap + queues)', () => {
		bridge();
		const src = new Atom(1);
		const c = new Computed(() => src.state);
		const stop = effect(() => { void c.state; });
		__simulateReclaimForTest(idOf(c));
		expect(stats().skipped).toBe(1);
		stop();
		bridge(); // reset: skip map, retry queue, deferred queue scrubbed; fresh registry
		const s = stats();
		expect(s.skipped).toBe(0);
		expect(s.retryQueue).toBe(0);
		expect(s.deferredCleanups).toBe(0);
		expect(s.registryPresent).toBe(true);
	});
});

// ---- REAL-GC plateau probes -------------------------------------------------------

describe.runIf(hasGC)('P-L1a: dropped plain atoms reclaim (arena plateaus)', () => {
	it('recNext plateaus within one round after churn rounds of dropped handles', async () => {
		bridge();
		const makeGarbage = (n: number): void => {
			for (let i = 0; i < n; ++i) {
				void new Atom(i);
			}
		};
		makeGarbage(64); // warmup: reach the high-water mark
		await gcSettle();
		const base = stats().recNext;
		for (let round = 0; round < 4; ++round) {
			makeGarbage(64);
			await gcSettle();
		}
		// Unreclaimed growth would be 4 * 64 records (x8 ints); a plateau
		// within one round's worth proves the registry is returning records.
		expect(stats().recNext - base).toBeLessThanOrEqual(64 * 8);
	});
});

describe.runIf(hasGC)('P-L1b: unwatch-then-drop computeds reclaim', () => {
	it('watched -> unwatched -> dropped computeds plateau', async () => {
		bridge();
		const src = new Atom(0);
		// NOTE (inherent to JS closures): the computed's fn is created in a
		// scope that does NOT capture the handle — the engine retains fn
		// strongly (fns column), and a shared closure context holding `c`
		// would pin the handle forever.
		const makeComputed = () => new Computed(() => (src.state as number) * 2);
		const cycle = (): void => {
			const c = makeComputed();
			const stop = effect(() => { void c.state; }); // watched
			stop(); // unwatched
		};
		for (let i = 0; i < 50; ++i) cycle();
		await gcSettle();
		const base = stats().recNext;
		for (let i = 0; i < 50; ++i) cycle();
		await gcSettle();
		expect(stats().recNext - base).toBeLessThanOrEqual(16 * 8);
		expect(E.buffer()[idOf(src) + NodeField.SUBS]).toBe(0); // every dep link disposed
	});
});

describe.runIf(hasGC)('P-L2: engine columns and maps release with the record', () => {
	it('content-ful dropped handles leave idToInternals/nodeIndexToInternals at baseline after GC', async () => {
		const b = bridge();
		const keep = b.computed('keep', () => 0);
		mount(b, 'R', keep, 'W'); // a live committed arena, so content sees real machinery
		const churn = (n: number): void => {
			for (let i = 0; i < n; ++i) {
				const at = new Atom(i);
				const an = b.internalsForAtom(at as unknown as Atom<unknown>);
				commitWrite(b, an, i + 1); // log entry + retirement compaction (guard exercised and cleared)
			}
		};
		churn(16);
		await gcSettle();
		const base = b.idToInternals.size;
		for (let round = 0; round < 4; ++round) {
			churn(16);
			await gcSettle();
		}
		expect(b.idToInternals.size - base).toBeLessThanOrEqual(16); // one-round tolerance, never exact-baseline
		expect(stats().skipped).toBeLessThanOrEqual(16);
	});
});
