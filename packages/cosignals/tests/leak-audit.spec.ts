/**
 * LEAK AUDIT (post-NF2) — one churn probe per allocation class: create/use/
 * dispose in a loop, then assert the relevant counters/lengths/pool sizes
 * return to baseline or stay bounded. Verdicts per class live in the test
 * names; the fix pinned here is the ARENA dead-shadow free list (a LIVE
 * committed arena no longer grows its record plane by one shadow record per
 * useComputed recreation — the pre-fix signature was `shell.next` +8 ints
 * per dispose→create→re-evaluate cycle, forever, in every live arena).
 *
 * Related pins cited by the audit (not duplicated here):
 *  - kernel link free-list threading discipline: tests/freelist.spec.ts
 *  - arena link free-list row-2 discipline:      tests/arena-freelist.spec.ts
 *  - pool cap 8 / release scrub / grown-capacity reuse: tests/arena-sd.spec.ts
 *  - dispose→reuse id tenancy:                   tests/arena-sc.spec.ts
 *  - watcher dual-store rule (T7):               tests/graph-consumers.spec.ts
 *    + cosignals-react/tests/graph-consumers.spec.tsx (the shim-side fix)
 *  - mid-episode batch/render reclamation exists because a never-quiescent
 *    process (batches always in flight) must still reclaim retired records
 *  - KNOWN-HOLE-BY-RULING (not probed, not fixed): root records are immortal
 *    (RUL-6 — no root-teardown event exists; concurrent.ts arenaQuiesceSweep).
 */
import { describe, expect, it } from 'vitest';
import {
	Atom,
	Computed,
	LinkField,
	NodeField,
	SuspendedRead,
	__ctxUse,
	__kernelSideColumnsForTest,
	effect,
	effectScope,
} from '../src/index.js';
import { engine, __resetEngineForTest, type AnyInternals, type AtomInternals, type ComputedInternals, type CosignalEngine, type EngineResetOptions } from '../src/CosignalEngine.js';
import { E } from '../src/CosignalEngine.js';
import { __useCacheForTest } from '../src/CosignalEngine.js';
import { armArenaCheck } from './arena-checker.js';

const tick = (): Promise<void> => new Promise<void>((res) => setTimeout(res, 0));

function bridge(options?: EngineResetOptions): CosignalEngine {
	// Finish the previous test's leftover episode so the reset's idle preconditions hold.
	engine.discardAllWip();
	for (const t of engine.liveBatches()) {
		if (t.parked) engine.settleAction(t.id);
		else engine.retire(t.id);
	}
	__resetEngineForTest(options);
	return engine;
}

function mount(b: CosignalEngine, root: string, node: AnyInternals, name: string) {
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

/** The engine's dense nodeIndex-keyed columns (probes only observe; they never mutate). */
const engineCols = (b: CosignalEngine) => b.__columnsForTest();

/** Sample the kernel node free-list head: create a throwaway Computed (alloc
 * pops the free list first) and dispose it right back. */
function sampleFreeNodeId(): number {
	const c = new Computed(() => 0);
	const id = (c as unknown as { _id: number })._id;
	engine.disposeComputed(c as unknown as Computed<unknown>);
	return id;
}

describe('1. KERNEL (index.ts arena)', () => {
	it('node records — effect/scope create+dispose churn reuses freed records via the freelist; the arena never grows (RECLAIMED)', () => {
		const src = new Atom(0);
		const buf = E.buffer();
		const ids = new Set<number>();
		for (let i = 0; i < 500; i++) {
			const stop = effect(() => { void src.state; });
			stop();
			const stopScope = effectScope(() => { effect(() => { void src.state; }); });
			stopScope(); // scope dispose cascades into its child effect
			ids.add(sampleFreeNodeId());
		}
		expect(ids.size).toBeLessThanOrEqual(4); // bump pointer untouched: churn cycles a handful of freed records
		expect(E.buffer()).toBe(buf); // no growth rebuild — freelist balance held
	});

	it('computed records — disposeComputed churn recycles ids and freeNode clears the values/fns side columns (RECLAIMED)', () => {
		const src = new Atom(1);
		const ids = new Set<number>();
		let lastId = 0;
		for (let i = 0; i < 500; i++) {
			const c = new Computed(() => src.state);
			void c.state; // evaluate: value cache + one dep link
			lastId = (c as unknown as { _id: number })._id;
			ids.add(lastId);
			engine.disposeComputed(c as unknown as Computed<unknown>);
		}
		expect(ids.size).toBeLessThanOrEqual(2); // LIFO freelist steady state
		const cols = __kernelSideColumnsForTest(lastId);
		expect(cols.value).toBeUndefined(); // cached value released
		expect(cols.aux).toBeUndefined(); // the aux slot stays empty for computeds by construction now (ctx.use is id-keyed; the engine never pins handles)
		expect(cols.fn).toBeUndefined(); // getter closure released
	});

	it('link records — dep-flip churn recycles link records through the FREE_NEXT chain (RECLAIMED; threading pinned by freelist.spec.ts)', () => {
		const gate = new Atom(true);
		const x = new Atom(1);
		const y = new Atom(2);
		const c = new Computed(() => (gate.state ? x.state : y.state));
		const cid = (c as unknown as { _id: number })._id;
		const linkIds = new Set<number>();
		for (let i = 0; i < 400; i++) {
			gate.set(i % 2 === 0);
			void c.state; // re-track: one link unlinks (freed), its replacement allocates
			const memory = E.buffer();
			for (let l = memory[cid + NodeField.DEPS]!; l !== 0; l = memory[l + LinkField.NEXT_DEP]!) linkIds.add(l);
		}
		expect(linkIds.size).toBeLessThanOrEqual(6); // the flip cycles the same few records, not 400 fresh ones
	});
});

describe('2. ENGINE REGISTRY (nodeIndexToInternals + dense per-node columns)', () => {
	it('adopt/dispose churn returns idToInternals to baseline, recycles kernel ids AND their nodeIndexes, and the record-free scrub leaves only cleared dense rows (RECLAIMED; columns bounded by node count)', () => {
		const b = bridge();
		const at = new Atom(1);
		const an = b.internalsForAtom(at as unknown as Atom<unknown>);
		const keep = b.computed('keep', (read) => read(an));
		mount(b, 'R', keep, 'W');
		// Warm one dispose→create cycle so the free list (and its recycled
		// nodeIndex) is the steady state the baseline measures.
		const warm = new Computed(() => (at.state as number) * 2);
		b.committedValue(b.internalsForComputed(warm as unknown as Computed<unknown>), 'R');
		b.disposeComputed(warm as unknown as Computed<unknown>);
		const nodesBase = b.idToInternals.size;
		const arrBase = engineCols(b).nodeIndexToInternals.length;
		const kids = new Set<number>();
		const indexes = new Set<number>();
		let lastIx = 0;
		const N = 200;
		for (let i = 0; i < N; i++) {
			const c = new Computed(() => (at.state as number) + i);
			const node = b.internalsForComputed(c as unknown as Computed<unknown>);
			expect(b.committedValue(node, 'R')).toBe(1 + i);
			kids.add((c as unknown as { _id: number })._id);
			lastIx = (node as unknown as { ix: number }).ix;
			indexes.add(lastIx);
			b.disposeComputed(c as unknown as Computed<unknown>);
		}
		expect(b.idToInternals.size).toBe(nodesBase); // registry entries removed at dispose (kernel-id keyed since the id merge)
		expect(kids.size).toBeLessThanOrEqual(2); // kernel records recycled (arena-sc pins tenancy)
		expect(indexes.size).toBeLessThanOrEqual(2); // a reused record inherits its slot's nodeIndex
		const arr = engineCols(b).nodeIndexToInternals;
		expect(arr.length).toBe(arrBase); // nodeIndex recycling: the dense columns do NOT grow with creation count
		expect(arr[lastIx]).toBeUndefined(); // the record-free scrub cleared the row
		expect(engineCols(b).obsRefs[lastIx]).toBe(0);
		expect(engineCols(b).lastWalk[lastIx]).toBe(0);
		expect(engineCols(b).nodeToWatchers[lastIx]).toBeUndefined();
	});
});

describe('3. ARENA SHADOWS (the live-arena record plane)', () => {
	it('kernel-node recreation churn (dispose → new node → re-evaluate) does NOT grow a LIVE committed arena: dead shadows recycle through the per-arena free list (LEAK-FIXED)', () => {
		const b = bridge();
		armArenaCheck(b); // fold-truth divergence check armed across record reuse
		const at = new Atom(1);
		const an = b.internalsForAtom(at as unknown as Atom<unknown>);
		const other = b.atom('other', 0);
		const keep = b.computed('keep', (read) => read(an));
		const w = mount(b, 'R', keep, 'W'); // consumers never hit zero: the arena LIVES for the whole probe
		// Warm one full dispose→create cycle so the steady state is the baseline.
		const warm = new Computed(() => (at.state as number) * 2);
		b.committedValue(b.internalsForComputed(warm as unknown as Computed<unknown>), 'R');
		b.disposeComputed(warm as unknown as Computed<unknown>);
		const shell = b.__arenaForTest('R')!;
		const next0 = shell.next;
		const wlen0 = shell.memory.length;
		const vals0 = shell.vals.length;
		const links0 = shell.links;
		const N = 400;
		for (let i = 1; i <= N; i++) {
			const c = new Computed(() => (at.state as number) * 2 + i);
			const node = b.internalsForComputed(c as unknown as Computed<unknown>); // useComputed: adopt…
			expect(b.committedValue(node, 'R')).toBe(2 + i); // …evaluate in the live committed arena (serves correctly through reuse)…
			if (i % 64 === 0) commitWrite(b, other, i); // …with committed-truth flips + the armed check interleaved
			b.disposeComputed(c as unknown as Computed<unknown>); // …then the deps-change disposal
		}
		// Pre-fix signature: shell.next === next0 + 8 * N (one dead 8-int record
		// + ~6 side-column slots leaked per recreation, per live arena, forever).
		expect(shell.next).toBe(next0);
		expect(shell.memory.length).toBe(wlen0);
		expect(shell.vals.length).toBe(vals0);
		expect(shell.links).toBe(links0); // dep links recycled through the arena link free list
		expect(shell.suspended.length).toBe(0);
		expect(shell.dirty.length).toBeLessThanOrEqual(4);
		// The old accepted residue is GONE: nodeToShadow keys by nodeIndex,
		// which recycles with the record slot — the lookup column is bounded
		// by peak node count, not creation count.
		expect(shell.nodeToShadow.length).toBeLessThan(N);
		expect(w.live).toBe(true);
		expect(b.__arenaStats().committed).toBe(1);
	});

	it('dispose-while-suspended purges the suspended-list entry and its nodeToShadow row from the live arena; a post-dispose settlement is inert (RECLAIMED)', async () => {
		const b = bridge();
		armArenaCheck(b);
		const gate = deferred<string>();
		const c: ComputedInternals = b.computed('c', () => {
			try {
				return __ctxUse(c.ix, 'k', () => gate.promise);
			} catch (err) {
				if (err instanceof SuspendedRead) return err; // background fold (battery 16d)
				throw err;
			}
		});
		const keep = b.computed('keep', () => 0);
		mount(b, 'R', keep, 'W'); // arena stays alive without watching c
		expect(b.committedValue(c, 'R')).toBeInstanceOf(SuspendedRead);
		expect(b.__arenaStats().suspended).toBe(1);
		b.disposeComputed((c as ComputedInternals).handle);
		expect(b.__arenaStats().suspended).toBe(0); // arenaEvictShadow swap-removed the entry
		gate.resolve('x');
		await tick();
		expect(b.__arenaStats().pendingSettlements).toBe(0); // tap fast-out: nothing suspended anywhere
	});

	it('adversarial reuse interleaving: settle marks a shadow DIRTY-and-listed, dispose orphans it with the stale list entry outstanding, the record reuses, decay stays exact (LEAK-FIXED pin)', async () => {
		const b = bridge();
		armArenaCheck(b);
		const at = new Atom(1);
		const an = b.internalsForAtom(at as unknown as Atom<unknown>);
		const gate = deferred<string>();
		const c: ComputedInternals = b.computed('c', () => {
			try { return __ctxUse(c.ix, 'k', () => gate.promise); } catch (err) {
				if (err instanceof SuspendedRead) return err;
				throw err;
			}
		});
		const keep = b.computed('keep', (read) => read(an));
		mount(b, 'R', keep, 'W');
		expect(b.committedValue(c, 'R')).toBeInstanceOf(SuspendedRead); // c cached suspended, UNWATCHED
		gate.resolve('data');
		await tick(); // settlement drain marks c DIRTY + lists it (no decay runs in the drain)
		const shell = b.__arenaForTest('R')!;
		b.disposeComputed((c as ComputedInternals).handle); // orphan the record while its stale dirty-list entry is outstanding
		const nextAfterDispose = shell.next;
		const c2 = new Computed(() => (at.state as number) + 7); // reuse: the freed SHADOW record re-tenants…
		expect(b.committedValue(b.internalsForComputed(c2 as unknown as Computed<unknown>), 'R')).toBe(8);
		expect(shell.next).toBe(nextAfterDispose + 8); // …+8 is c2's one dep LINK, a genuinely new live record (the suspended c held no links to recycle)
		commitWrite(b, an, 2); // boundary: fanout + drain + DECAY process the stale entry against the new tenant (armed check verifies values)
		expect(b.committedValue(keep, 'R')).toBe(2);
		expect(b.committedValue(b.internalsForComputed(c2 as unknown as Computed<unknown>), 'R')).toBe(9);
		b.disposeComputed(c2 as unknown as Computed<unknown>); // second cycle: now a shadow AND a link sit in the free lists…
		const c3 = new Computed(() => (at.state as number) + 9);
		expect(b.committedValue(b.internalsForComputed(c3 as unknown as Computed<unknown>), 'R')).toBe(11);
		expect(shell.next).toBe(nextAfterDispose + 8); // …and the plane is FLAT across dispose→create→re-evaluate
		expect(shell.dirty.length).toBeLessThanOrEqual(4);
	});
});

describe('4. ARENA POOL', () => {
	it('bounded at 8 shells; pooled capacity is the tenancy high-water and small tenancies never grow it (BOUNDED-BY-DESIGN; cap/scrub/growth pinned by arena-sd.spec.ts)', () => {
		const b = bridge({ arenaInitInts: 64 });
		const atoms = Array.from({ length: 40 }, (_, i) => b.atom(`a${i}`, i));
		const big = b.computed('big', (read) => atoms.reduce((s, n) => s + (read(n) as number), 0));
		const w = mount(b, 'B', big, 'WB');
		expect(b.__arenaForTest('B')!.memory.length).toBeGreaterThan(64); // the big tenancy grew its buffer
		w.live = false;
		b.quiesce();
		const capAfterBig = Math.max(...b.__arenaPoolForTest().map((a) => a.memory.length));
		for (let i = 0; i < 12; i++) {
			const s = b.computed(`s${i}`, (read) => read(atoms[0]!));
			const ws = mount(b, `S${i}`, s, `WS${i}`); // small tenancies churn pool claims (render + committed shells)
			ws.live = false;
			b.quiesce();
		}
		expect(b.__arenaPoolForTest().length).toBeLessThanOrEqual(8); // the cap: extra releases DROP the shell
		expect(Math.max(...b.__arenaPoolForTest().map((a) => a.memory.length))).toBe(capAfterBig); // capacity kept (by design), never grown by small renders
	});
});

describe('5. WRITE LOGS / BATCHES / RENDER PASSES', () => {
	it('open/write/retire churn incl. parked actions stays bounded with NO quiesce() call (regression pin: each episode close drops its records; with no tracer attached the record sites are dead branches — nothing event-shaped exists to retain)', () => {
		const b = bridge(); // production posture: no referee, no tracer, no armed checker
		const an = b.atom('a', 0);
		const c = b.computed('c', (read) => read(an));
		const w = mount(b, 'R', c, 'W');
		for (let i = 1; i <= 400; i++) {
			const t = b.openBatch();
			b.write(t.id, an, 0, i);
			if (i % 8 === 0) {
				const p = b.renderStart('R', [t.id]); // an open render holds the episode open…
				b.renderWatcher(p.id, w.id);
				b.renderEnd(p.id, 'commit', { retireAtCommit: [t.id] }); // …and its close ends it (retirement folded in)
			} else {
				b.retire(t.id);
			}
			if (i % 16 === 0) {
				const act = b.openBatch({ action: true }); // parked async action…
				b.write(act.id, an, 0, i + 1000);
				b.settleAction(act.id); // …parks then settles
			}
		}
		expect(b.idToBatch.size).toBe(0); // retired batches dropped at the episode closes — NO quiesce ran
		expect(b.idToRenderPass.size).toBe(0); // ended renders reclaimed at render end
		expect(an.log.length).toBe(0); // write logs dropped whole at the episode closes
		expect(an.log.entries.length).toBe(0); // no entry survives the drop
		expect(b.trace).toBeUndefined(); // no tracer ⇒ every record site stayed one dead branch (nothing created anywhere)
		expect(b.__arenaStats().dirty).toBeLessThanOrEqual(4); // boundary decay keeps the dirty lists to live cones
		expect(b.committedValue(c, 'R')).toBe(1400);
	});
});

describe('6 + 7. WATCHERS / OBSERVATION / SETTLEMENT', () => {
	it('watcher mount/remove churn empties both watcher stores, releases every observation retain, and balances the observed-lifecycle union (RECLAIMED; dual-store rule pinned by graph-consumers T7 + the react shim suite)', async () => {
		const b = bridge(); // reset FIRST: the kernel scrub would orphan handles created before it
		let effects = 0;
		let cleanups = 0;
		const at = new Atom(1, { effect: () => { effects++; return () => { cleanups++; }; } });
		const an = b.internalsForAtom(at as unknown as Atom<unknown>);
		an.name = 'life';
		const c = b.computed('c', (read) => read(an));
		for (let i = 1; i <= 25; i++) {
			const w = mount(b, 'R', c, `W${i}`);
			await tick(); // union transitions flush on microtasks
			expect(effects).toBe(i); // 0→1: the observed-lifecycle effect ran (obs index arm; MACHINERY_OWNED kernel links contribute nothing)
			b.removeWatcher(w.id);
			await tick();
			expect(cleanups).toBe(i); // 1→0: cleanup ran — no stuck retain anywhere in the closure
		}
		expect(b.watchers.size).toBe(0);
		expect(engineCols(b).obsRefs.every((r) => r === 0)).toBe(true);
		expect(engineCols(b).nodeToWatchers.every((l) => l === undefined || l.length === 0)).toBe(true);
		b.quiesce();
		expect(b.__arenaStats().committed).toBe(0); // zero consumers: the arena released to the pool
	});

	it('suspend/settle churn drains the settlement queue and suspended lists to zero every cycle; the per-node ctx.use cache is bounded by node lifetime (RECLAIMED + noted contract)', async () => {
		const b = bridge();
		armArenaCheck(b);
		const version = b.atom('v', 0);
		const gates = Array.from({ length: 20 }, () => deferred<string>());
		const c: ComputedInternals = b.computed('c', (read) => {
			const v = read(version) as number;
			try {
				return __ctxUse(c.ix, `k${v}`, () => gates[v]!.promise);
			} catch (err) {
				if (err instanceof SuspendedRead) return err;
				throw err;
			}
		});
		mount(b, 'R', c, 'W');
		for (let v = 0; v < 20; v++) {
			if (v > 0) commitWrite(b, version, v);
			expect(b.__arenaStats().suspended).toBe(1);
			gates[v]!.resolve(`d${v}`);
			await tick();
			expect(b.__arenaStats().suspended).toBe(0); // settlement re-marked + the correction consumed the box
			expect(b.__arenaStats().pendingSettlements).toBe(0); // queue drained to its fixed point
			expect(b.committedValue(c, 'R')).toBe(`d${v}`);
		}
		expect(__useCacheForTest(c.ix)!.size).toBe(20); // per-key cache is monotone PER NODE and dies with it — the documented ctx.use contract
	});
});
