/**
 * ONE ID SPACE — the kernel record id is THE NodeId package-wide; engine
 * columns re-key by the NODE INDEX stored in kernel record memory
 * (NodeField.NODE_INDEX, field 7 of node records). These tests pin the
 * semantic obligations of that merge:
 *
 *  P1  dormant-watcher aliasing: a watcher mounted (never committed) on a
 *      computed whose kernel record is later freed and REUSED must not
 *      silently bind the new tenant at its late commit — the watcher's
 *      record-generation stamp makes every resolution miss (loud skip).
 *      Written to FAIL against a naive id merge (which would bind the new
 *      tenant) and PASS with the stamps.
 *  P2  nodeIndex lifecycle: indexes recycle with the record slot (a reused
 *      record inherits its slot's index), so columns are bounded by node
 *      count under create/drop churn — and the record-free scrub clears
 *      every nodeIndex-keyed row, so a new tenant at the same index never
 *      sees the old tenant's rows (watcher rows, observation refs, walk
 *      stamps, per-arena shadow lookups).
 *  P3  the kernel-GEN test seam: __TEST__bumpNodeGen re-expressed as a
 *      LIVE record's tenancy bump in kernel memory — arena shadows re-tenant
 *      cold and watcher stamps go stale, exactly as a real free+reuse.
 *
 * (The elements-kind shape probes — columns stay PACKED — live in
 * tests/elements-kind.spec.ts: they need --allow-natives-syntax.)
 */
import { describe, expect, it } from 'vitest';
import { Atom, Computed } from '../src/index.js';
import { attachDriver, BATCH_NONE, engine, __TEST__resetEngine, type AnyInternals, type AtomInternals, type CosignalEngine, type Watcher } from '../src/CosignalEngine.js';
import { getKernelGeneration, getKernelNodeIndex } from '../src/CosignalEngine.js';
import { armArenaCheck } from './arena-checker.js';

function freshEngine(): CosignalEngine {
	// Finish the previous test's leftover episode so the reset's idle preconditions hold.
	engine.discardAllWip();
	for (const t of engine.liveBatches()) {
		if (t.parked) engine.settleAction(t.id);
		else engine.retire(t.id);
	}
	__TEST__resetEngine({ devChecks: true });
	// R-5: a devChecks harness that opens batches must attach a driver first.
	attachDriver({ currentBatch: () => BATCH_NONE, worldFor: () => undefined });
	return engine;
}

function mount(b: CosignalEngine, root: string, node: AnyInternals, name: string): Watcher {
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

/** The engine's dense nodeIndex-keyed columns (probes only observe; they never mutate). */
const cols = (b: CosignalEngine) => b.__TEST__columns();

/** A node record's nodeIndex, read live from kernel memory (field 7). */
const ixOf = getKernelNodeIndex;
/** A node record's tenancy generation, read live from kernel memory. */
const genOf = getKernelGeneration;

describe('P1 — dormant-watcher aliasing across record reuse', () => {
	it('a watcher mounted in an uncommitted render on a later-disposed computed skips loudly at its commit instead of binding the record\'s new tenant', () => {
		const b = freshEngine();
		armArenaCheck(b);
		const a = b.atom('a', 1);
		const keep = b.computed('keep', (read) => read(a));
		mount(b, 'R', keep, 'Wkeep'); // committed arena stays alive across the churn

		let oldEvals = 0;
		const cOld = b.computed('cOld', (read) => {
			oldEvals++;
			return (read(a) as number) * 2;
		});
		// Mount a watcher on cOld inside a render and do NOT commit yet.
		const p = b.renderStart('R2', []);
		const w = b.mountWatcher(p.id, cOld, 'Wdormant');
		expect(w.live).toBe(false); // dormant: layout effects fire only at commit

		// Dispose cOld (legal: the watcher is not live) — the kernel record
		// frees at the boundary sweep inside the call, bumping its GEN.
		const oldId = cOld.handle._id;
		const genAtMount = genOf(oldId);
		b.disposeComputed(cOld.handle);
		expect(genOf(oldId)).toBeGreaterThan(genAtMount); // record freed: tenancy moved

		// Reuse: the next computed allocation takes the freed record.
		let newEvals = 0;
		const cNew = b.computed('cNew', (read) => {
			newEvals++;
			return (read(a) as number) + 1000;
		});
		expect(cNew.handle._id).toBe(oldId); // the free list handed the record to the new tenant
		const w2 = mount(b, 'R', cNew, 'Wnew');
		expect(b.committedValue(cNew, 'R')).toBe(1001);
		const newEvalsBeforeCommit = newEvals;
		const oldEvalsBeforeCommit = oldEvals;

		// Commit the OLD render: the dormant watcher's activation resolves its
		// node — the generation stamp must MISS (loud skip), never bind cNew.
		const skipsBefore = b.__TEST__staleWatcherSkips;
		b.renderEnd(p.id, 'commit');
		expect(b.__TEST__staleWatcherSkips).toBeGreaterThan(skipsBefore); // the skip is loud
		expect(w.live).toBe(false); // never activated: no observation retain on the new tenant
		expect(oldEvals).toBe(oldEvalsBeforeCommit); // the dead fn never ran again

		// The new tenant is untouched by the stale commit: no watcher-index row
		// names the dormant watcher, and deliveries reach only the real watcher.
		const rows = cols(b).nodeToWatchers;
		const row = rows[ixOf(oldId)];
		expect(row === undefined || !row.includes(w)).toBe(true);
		expect(row !== undefined && row.includes(w2)).toBe(true);
		commitWrite(b, a, 2);
		expect(b.committedValue(cNew, 'R')).toBe(1002);
		expect(w2.lastRenderedValue).toBe(1002); // the real watcher corrected
		expect(w.lastRenderedValue).toBe(2); // the stale watcher kept its render-world value: no correction ever bound it
		expect(newEvals).toBeGreaterThanOrEqual(newEvalsBeforeCommit); // sanity: cNew serving stayed live
	});
});

describe('P2 — nodeIndex lifecycle: recycling bounds the columns', () => {
	it('a reused record inherits its slot\'s nodeIndex; create/drop churn neither grows the engine columns nor a live arena\'s nodeToShadow', () => {
		const b = freshEngine();
		armArenaCheck(b);
		const at = new Atom(1);
		const an = b.internalsForAtom(at as unknown as Atom<unknown>);
		const keep = b.computed('keep', (read) => read(an));
		mount(b, 'R', keep, 'W');
		// Warm one full dispose→create cycle so the steady state is the baseline.
		const warm = new Computed(() => (at.state as number) * 2);
		b.committedValue(b.internalsForComputed(warm as unknown as Computed<unknown>), 'R');
		b.disposeComputed(warm as unknown as Computed<unknown>);

		const arrBase = cols(b).nodeIndexToInternals.length;
		const shell = b.__TEST__arena('R')!;
		const shadowBase = shell.nodeToShadow.length;
		const indexes = new Set<number>();
		const N = 200;
		for (let i = 0; i < N; i++) {
			const c = new Computed(() => (at.state as number) + i);
			const node = b.internalsForComputed(c as unknown as Computed<unknown>);
			expect(b.committedValue(node, 'R')).toBe(1 + i);
			indexes.add(ixOf(c._id));
			b.disposeComputed(c as unknown as Computed<unknown>);
		}
		expect(indexes.size).toBeLessThanOrEqual(2); // the slot's index recycles with the record
		expect(cols(b).nodeIndexToInternals.length).toBe(arrBase); // columns bounded by node count — not creation count
		expect(cols(b).lastWalk.length).toBe(arrBase);
		expect(cols(b).obsRefs.length).toBe(arrBase);
		expect(shell.nodeToShadow.length).toBe(shadowBase); // per-arena lookup bounded too
	});

	it('fresh slots take fresh indexes: two live nodes never share a nodeIndex', () => {
		const b = freshEngine();
		const c1 = new Computed(() => 1);
		const c2 = new Computed(() => 2);
		b.internalsForComputed(c1 as unknown as Computed<unknown>);
		b.internalsForComputed(c2 as unknown as Computed<unknown>);
		expect(ixOf(c1._id)).not.toBe(0); // index 0 is burned (the arenas' "none" sentinel)
		expect(ixOf(c2._id)).not.toBe(0);
		expect(ixOf(c1._id)).not.toBe(ixOf(c2._id));
	});
});

describe('P2 — record-free scrub: a new tenant never sees the old tenant\'s rows', () => {
	it('after the record frees, every nodeIndex-keyed row is cleared (watcher rows, observation refs, walk stamps, node registry, arena shadows)', () => {
		const b = freshEngine();
		armArenaCheck(b);
		const a = b.atom('a', 5);
		const keep = b.computed('keep', (read) => read(a));
		mount(b, 'R', keep, 'Wkeep');

		const cOld = b.computed('cOld', (read) => (read(a) as number) * 2);
		expect(b.committedValue(cOld, 'R')).toBe(10); // arena shadow exists
		// Observation refs: a live watcher on an observer of cOld retains cOld
		// transitively (obsDeps of the observer name cOld).
		const obs = b.computed('obs', (read) => (read(cOld) as number) + 1);
		const wObs = mount(b, 'R', obs, 'Wobs');
		// A committed write makes the delivery walk stamp cOld's walk row.
		commitWrite(b, a, 6);
		expect(b.committedValue(obs, 'R')).toBe(13);

		const oldId = cOld.handle._id;
		const ix = ixOf(oldId);
		expect(cols(b).obsRefs[ix]!).toBeGreaterThan(0); // retained via the observer's dep snapshot
		// Leave a DORMANT watcher row on cOld (mounted, never committed).
		const p = b.renderStart('R2', []);
		b.mountWatcher(p.id, cOld, 'Wstale');
		expect(cols(b).nodeToWatchers[ix]!.length).toBe(1);

		// Supersede + dispose (the watcher is dormant, the retain is transitive
		// — both legal), then the boundary sweep frees the record.
		b.removeWatcher(wObs.id);
		b.disposeComputed(obs.handle); // release the observer first (its snapshot held cOld)
		b.disposeComputed(cOld.handle);

		// The scrub: every nodeIndex-keyed row for the freed record is cleared.
		expect(cols(b).nodeIndexToInternals[ix]).toBeUndefined();
		expect(cols(b).nodeToWatchers[ix]).toBeUndefined();
		expect(cols(b).obsRefs[ix]).toBe(0);
		expect(cols(b).obsDeps[ix]).toBeUndefined();
		expect(cols(b).lastWalk[ix]).toBe(0);
		expect(cols(b).evalMark[ix]).toBe(0);
		expect(b.__TEST__arena('R')!.nodeToShadow[ix] ?? 0).toBe(0);
		expect(b.idToInternals.has(oldId)).toBe(false);

		// New tenant at the same index: fresh rows only.
		const cNew = b.computed('cNew', (read) => (read(a) as number) + 100);
		expect(cNew.handle._id).toBe(oldId);
		expect(ixOf(cNew.handle._id)).toBe(ix);
		const wNew = mount(b, 'R', cNew, 'Wnew');
		expect(b.committedValue(cNew, 'R')).toBe(106); // cold fold under the new tenant
		const row = cols(b).nodeToWatchers[ix]!;
		expect(row.length).toBe(1);
		expect(row[0]).toBe(wNew);
	});

	it('a stale observation reference to a freed node never corrupts the new tenant\'s refcount (object-identity guard)', async () => {
		const b = freshEngine();
		armArenaCheck(b);
		const gate = b.atom('gate', 1);
		const a = b.atom('a', 5);
		const cOld = b.computed('cOld', (read) => (read(a) as number) * 2);
		// Observer whose CURRENT strong dep set includes cOld.
		const obs = b.computed('obs', (read) => ((read(gate) as number) !== 0 ? (read(cOld) as number) : (read(a) as number)));
		mount(b, 'R', obs, 'Wobs');
		const oldId = cOld.handle._id;
		const ix = ixOf(oldId);
		expect(cols(b).obsRefs[ix]!).toBeGreaterThan(0);

		// Dispose cOld while the observer's snapshot still names it (the
		// discipline breach the identity guard defuses), then reuse the record.
		b.disposeComputed(cOld.handle);
		const cNew = b.computed('cNew', (read) => (read(a) as number) + 100);
		expect(cNew.handle._id).toBe(oldId);
		const wNew = mount(b, 'R', cNew, 'Wnew'); // the new tenant is observed: obsRefs[ix] = its own count
		const newRefs = cols(b).obsRefs[ix]!;
		expect(newRefs).toBeGreaterThan(0);

		// Flip the observer's deps: its re-point releases the STALE cOld
		// reference — the release must not decrement the new tenant's count.
		commitWrite(b, gate, 0);
		expect(b.committedValue(obs, 'R')).toBe(5);
		expect(cols(b).obsRefs[ix]!).toBe(newRefs);
		expect(wNew.live).toBe(true);
	});
});

describe('P3 — the kernel-GEN referee seam', () => {
	it('__TEST__bumpNodeGen bumps the LIVE record\'s kernel GEN: arena shadows re-tenant cold and dormant watcher stamps go stale', () => {
		const b = freshEngine();
		armArenaCheck(b);
		const a = b.atom('a', 1);
		let evals = 0;
		const c = b.computed('c', (read) => {
			evals++;
			return (read(a) as number) * 2;
		});
		mount(b, 'R', c, 'W');
		expect(b.committedValue(c, 'R')).toBe(2);
		const genBefore = genOf(c.handle._id);
		const evalsBefore = evals;

		// A dormant watcher mounted BEFORE the bump: its stamp must go stale.
		const p = b.renderStart('R2', []);
		const wDormant = b.mountWatcher(p.id, c, 'Wdormant');

		b.__TEST__bumpNodeGen(c.id); // the free-list reuse analog, forced on a live record
		expect(genOf(c.handle._id)).toBe(genBefore + 1); // the seam moves KERNEL tenancy

		// Arena re-tenancy: the read refolds cold, never serves the dead tenancy.
		expect(b.committedValue(c, 'R')).toBe(2);
		expect(evals).toBeGreaterThan(evalsBefore);

		// Watcher staleness: the dormant watcher's commit skips loudly.
		const skipsBefore = b.__TEST__staleWatcherSkips;
		b.renderEnd(p.id, 'commit');
		expect(b.__TEST__staleWatcherSkips).toBeGreaterThan(skipsBefore);
		expect(wDormant.live).toBe(false);
	});
});
