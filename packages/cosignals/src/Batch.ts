/**
 * The batch mechanism and its lifecycle: batch identity (`Batch` records
 * keyed by `BatchId`), the 31-entry recycling slot table (`BatchSlotMeta`),
 * slot interning / release / the loud release-anyway backstop, the
 * committed-bits rebuild, the live-batch bookkeeping, the ambient default
 * batch, and retirement — the batch's terminal transition, whose fan
 * (fold-valve folds, arena fan-out, durable drains, per-root membership
 * clears, slot release, the episode close) reaches the other mechanisms
 * through the shared engine core record's late-bound slots. A batch is the
 * group of writes belonging to one UI update; a slot is the batch's
 * position in the 31-entry table while it is live-and-written, so "which
 * batches affect X" fits one 31-bit integer word (a `BatchSlotSet`) — the
 * vocabulary is defined in full at the top of concurrent.ts.
 *
 * Batch records are EPISODE-LIFETIME (WriteLog.ts's episode lifecycle): a
 * retired record persists — write-log entries reference batches by id, so
 * the record must outlive them — and drops wholesale at the episode close,
 * never by per-record bookkeeping.
 *
 * `createBatchManager` is a factory in the kernel's own style (index.ts
 * `createKernel`): it closes over its state and returns its operation
 * table (the `BatchManager`); the engine runs it once per composition
 * (module initialization,
 * test resets) and keeps `idToBatch`/`slots`
 * aliased for its resident readers (the shared-array pattern the kernel
 * uses for its `values`/`fns` side columns). It takes the shared core
 * record for retirement's cross-module fan (every such call reads its
 * late-bound slot at call time); the remaining resident-state edges
 * (the driver/devChecks presence) come in through `deps` as a host slice.
 */

import { ScheduleError } from './errors.js';
import { probes, type ConcurrentEngineHost } from './ConcurrentEngine.js';
import type { IdBrand } from './CosignalEngine.js';
import type { AtomInternals, RootState, Seq, TraceHooks } from './concurrent.js';
import type { EngineCore } from './World.js';

// Leniently branded batch scalars (the kernel's one-symbol IdBrand —
// CosignalEngine.ts, ported from dalien-signals src/system.ts:525-535): plain
// numbers assign in cast-free (`1 << slot` builds a BatchSlotSet with no
// ceremony), but the brands are mutually exclusive — in particular a slot
// ordinal handed where a slot-set bit mask belongs (or vice versa) is a
// compile error, the exact swap that would otherwise type-check at every
// `1 << slot.id` site.

export type BatchId = number & IdBrand<'batch'>;
/** The reserved "no batch context" BatchId. Never allocated (batch ids start
 * at 1): `driver.currentBatch() === BATCH_NONE` means the write executes in
 * no host batch context, so it has no batch to join.
 * The React fork names the same sentinel on its side (protocol v2 shares one
 * id space between the engine and React, so the sentinel must too). */
export const BATCH_NONE: BatchId = 0;
/** A slot ordinal (0–30): the batch's position in the recycling table. */
export type BatchSlot = number & IdBrand<'batchSlot'>;
/** A 31-bit slot set: bit i = slot i (mask/included/committed/dedup words). */
export type BatchSlotSet = number & IdBrand<'batchSlotSet'>;

export type Batch = {
	id: BatchId;
	action: boolean;
	parked: boolean;
	/** The React-side classification told to the driver's batch-id allocator
	 * at creation (true = transition-like: renders don't block paint and the
	 * batch commits later). A driver-owned annotation stored on the shared
	 * record so the driver needs no side table — the engine itself never
	 * branches on it (scheduling stays React's). False for engine-created
	 * batches (ambient, tests) that no allocator classified. */
	deferred: boolean;
	state: 'live' | 'retired';
	slot: BatchSlot | undefined;
	retiredSeq: Seq | undefined;
	/** Sequence of this batch's last log entry (0 = none). The mount fixup's
	 * fast-path clock check reads this per committing-render member batch,
	 * because a batch whose first write landed mid-render has no slot in the
	 * render's captured slot sets (see runMountFixup). */
	lastWriteSeq: Seq;
	/** Atoms this batch appended to (may hold benign duplicates; deduped at retirement). */
	atomsTouched: AtomInternals[];
	ambient: boolean;
};

/** One entry of the 31-slot recycling table a written batch occupies (see
 * the slot/intern/tenant definitions in concurrent.ts's header). */
export type BatchSlotMeta = {
	id: BatchSlot;
	tenant: BatchId | undefined;
	/** Claim sequence — a point on the shared timeline created at every
	 * intern (the creation itself is load-bearing for model parity: both sides
	 * spend one sequence per claim). The engine never reads the stored
	 * value; the reference model's (`cosignals-oracle`) `checkInvariants`
	 * tenancy orderings consult it through the test-side model view. */
	claimSeq: Seq;
	/** Sequence of the last write under this slot; zeroed when a new tenant
	 * claims it (the mount fixup's clock conjunct compares it against
	 * snapshot pins). */
	writeClock: Seq;
	releasePending: boolean;
};

const SLOT_COUNT = 31; // at most 31 live batches — one per React lane, and slot sets fit one int bit mask.

/** BatchId source — monotonic for the process's whole life, never reused
 * and never rewound (ids start at 1; BATCH_NONE = 0 is never allocated).
 * With protocol v2 these ids are stored verbatim in React's batch registry,
 * so monotonicity is what keeps a stale fork-side id from ever colliding
 * with a later batch. Module-level deliberately: the counter survives
 * `__resetEngineForTest` (which re-runs the factory below) — a host lane
 * table can legally hold an id across an engine reset, and monotonicity
 * guarantees a stale id can never collide with a post-reset batch. */
let nextBatchId = 1;

/** The next id the allocator would hand out (test harnesses rebase their
 * model↔engine batch-id comparison on it across resets). @internal */
export function __peekNextBatchIdForTest(): BatchId {
	return nextBatchId;
}

/** The resident-state edges the manager consumes (provided by the engine's
 * composition site), as a named slice of the engine host's record type. */
export type BatchManagerDeps = {
	/** The engine host's resident slice: the driver-attached probe + the
	 * devChecks switch — openBatch's dev guard (with devChecks armed, opening
	 * a batch with no driver attached
	 * throws: the documented host contract is "hosts that open batches must
	 * retire them"; the guard catches harnesses that forgot to attach). */
	host: Pick<ConcurrentEngineHost, 'isDriverAttached' | 'isDevChecksEnabled'>;
};

export type BatchManager = {
	/** Batch records by id (shared identity: the engine aliases it for its
	 * resident readers — commits, mount fixup, tests). */
	idToBatch: Map<BatchId, Batch>;
	/** The 31-entry recycling slot table (shared identity, as above). */
	slots: BatchSlotMeta[];
	getLiveBatchCount(): number;
	openBatch(opts?: { action?: boolean; ambient?: boolean; deferred?: boolean }): Batch;
	getBatchById(id: BatchId): Batch;
	liveBatches(): Batch[];
	internSlot(batch: Batch): BatchSlotMeta;
	releaseSlot(slot: BatchSlotMeta): void;
	rebuildCommittedBits(r: RootState): void;
	/** The ambient default batch for bare (context-free) writes — the id, or
	 * undefined while none is live (retirement clears it). */
	getAmbientBatch(): BatchId | undefined;
	setAmbientBatch(id: BatchId): void;
	/** True iff any open render's mask names the slot (retirement's deferred
	 * release + the render-close re-evaluation share the one predicate). */
	isSlotRetainedByOpenMask(slot: BatchSlot): boolean;
	/** Retirement (public operation) + the settlement edge of an async action. */
	retire(batchId: BatchId): void;
	settleAction(batchId: BatchId): void;
	/** The retirement fold itself (render-commit's retire-at-commit calls it
	 * inside the commit's own operation frame). */
	retireInner(batch: Batch): void;
};

export function createBatchManager(core: EngineCore, deps: BatchManagerDeps): BatchManager {
	// Stable resident containers, aliased once (identity-shared); host
	// functions bind once at composition, so warm call sites stay direct.
	const roots = core.roots;
	const rootToOpenRender = core.rootToOpenRender;
	const { isDriverAttached, isDevChecksEnabled } = deps.host;

	const idToBatch = new Map<BatchId, Batch>();
	const slots: BatchSlotMeta[] = [];
	for (let i = 0; i < SLOT_COUNT; i++) {
		slots.push({
			id: i,
			tenant: undefined,
			claimSeq: 0,
			writeClock: 0,
			releasePending: false,
		});
	}
	let liveBatchCount = 0;
	/** Ambient default batch for bare (context-free) writes. */
	let ambientBatch: BatchId | undefined;

	/** Create a batch. At most 31 live at once — React schedules each
	 * batch on one of its 31 lanes, so more can never be in flight. (The
	 * lane/priority itself stays React's: the engine never consults it —
	 * with protocol v2 the driver's batch-id allocator opens the batch and
	 * hands its id straight to React, one shared number space, no map.)
	 *
	 * Allocation-only envelope (the driver's allocator calls this from
	 * React's batch-creation site, which can sit mid-render, mid-commit, or
	 * inside protocol listeners — i.e. at opDepth > 0): bookkeeping only —
	 * counter, registry map, quiet recompute, probes/trace records. No
	 * operation epilogue, no drains, no kernel mutation, no user code.
	 *
	 * With devChecks armed, opening a batch with no driver attached
	 * throws — the documented host contract is "hosts that open batches
	 * must retire them", and a devChecks harness must attach its driver
	 * before opening engine batches. */
	function openBatch(opts?: { action?: boolean; ambient?: boolean; deferred?: boolean }): Batch {
		if (isDevChecksEnabled() && !isDriverAttached()) {
			throw new ScheduleError('openBatch with no driver attached — hosts that open batches must retire them; attach a driver first (devChecks)');
		}
		if (liveBatchCount >= SLOT_COUNT) {
			throw new ScheduleError('at most 31 batches may be live at once (one per React lane)');
		}
		const parked = opts?.action ?? false;
		probes.batches++; // engine-activity counter (tests/one-core.spec.ts's zero-cost check)
		const batch: Batch = {
			id: nextBatchId++,
			action: opts?.action ?? false,
			parked, // async-action batches park (cannot retire) until their promise settles
			deferred: opts?.deferred ?? false, // driver-owned annotation (see Batch.deferred)
			state: 'live', slot: undefined,
			retiredSeq: undefined, lastWriteSeq: 0, atomsTouched: [],
			ambient: opts?.ambient ?? false,
		};
		idToBatch.set(batch.id, batch);
		liveBatchCount++;
		core.recomputeQuiet(); // a live batch: the pipeline is armed until the last retirement
		const tr = core.trace;
		if (tr !== undefined) tr.batchOpen(batch);
		return batch;
	}

	/** Look up a batch id or throw the schedule error every resolver shares. */
	function getBatchById(id: BatchId): Batch {
		const t = idToBatch.get(id);
		if (t === undefined) throw new ScheduleError(`unknown batch ${id}`);
		return t;
	}

	function liveBatches(): Batch[] {
		return [...idToBatch.values()].filter((t) => t.state === 'live');
	}

	/**
	 * Intern the batch's slot, claiming a free one on its first write.
	 * Claim housekeeping: the write clock zeroes; per-(watcher, slot) dedup
	 * bits clear (the bit now means a different batch).
	 */
	function internSlot(batch: Batch): BatchSlotMeta {
		if (batch.slot !== undefined) return slots[batch.slot]!;
		let free = slots.find((s) => s.tenant === undefined);
		if (free === undefined) {
			// Backstop: release the oldest mask-retained retired slot anyway,
			// loudly — starving new batches would deadlock the scheduler, and
			// the affected paused render self-corrects through drains/fixup.
			const candidates = slots.filter((s) => s.releasePending);
			if (candidates.length === 0) {
				throw new ScheduleError('slot table full of live tenants — unreachable under the 31-live-batch guard');
			}
			candidates.sort((a, b) => {
				const ra = getBatchById(a.tenant!).retiredSeq ?? 0;
				const rb = getBatchById(b.tenant!).retiredSeq ?? 0;
				return ra - rb;
			});
			const victim = candidates[0]!;
			const tr = core.trace;
			if (tr !== undefined) tr.slotBackstopReleased(victim.id, victim.tenant!);
			releaseSlot(victim);
			free = victim;
		}
		free.tenant = batch.id;
		free.claimSeq = core.nextSeq(); // claim-after-release gets its own point on the timeline
		free.writeClock = 0;
		free.releasePending = false;
		batch.slot = free.id;
		// Claim housekeeping over the shared root/watcher stores, in claim
		// order. A committed-but-slotless batch (late first write — e.g. a
		// member write landing after a root committed the batch) interns here —
		// its root's membership bits gain the slot immediately so the committed world's
		// membership clause sees the coming log entries.
		for (const r of roots.values()) {
			if (r.committedBatches.has(batch.id)) r.committedBits |= 1 << free.id;
		}
		{
			const clear = ~(1 << free.id);
			for (const w of core.watchers.values()) w.dedupBits &= clear; // dedup clear at re-intern
		}
		{
			const tr = core.trace;
			if (tr !== undefined) tr.slotClaimed(free.id, batch.id);
		}
		return free;
	}

	function releaseSlot(slot: BatchSlotMeta): void {
		const tenant = slot.tenant === undefined ? undefined : getBatchById(slot.tenant);
		if (tenant !== undefined) {
			tenant.slot = undefined; // identity release; log entries keep their denormalized slot
			const tr = core.trace;
			if (tr !== undefined) tr.slotReleased(slot.id, tenant.id);
		}
		slot.tenant = undefined;
		slot.releasePending = false;
		// (The released tenant's record persists: batch records are
		// episode-lifetime and drop wholesale at the episode close.)
	}

	function rebuildCommittedBits(r: RootState): void {
		let bits = 0;
		for (const tid of r.committedBatches) {
			const batch = idToBatch.get(tid);
			if (batch !== undefined && batch.slot !== undefined) bits |= 1 << batch.slot;
		}
		r.committedBits = bits;
	}

	function isSlotRetainedByOpenMask(slot: BatchSlot): boolean {
		for (const p of rootToOpenRender.values()) {
			if ((p.maskBits >>> slot) & 1) return true;
		}
		return false;
	}

	// ---------------------------------------------------------- retirement

	/** Retirement fires exactly once per batch; parked async actions retire
	 * only at settlement (their pending state must stay pending until then). */
	function retire(batchId: BatchId): void {
		const t = getBatchById(batchId);
		if (t.state === 'retired') throw new ScheduleError('retirement fires exactly once per batch');
		if (t.parked) throw new ScheduleError('parked action batches retire only at settlement');
		core.opDepth++; // public-operation frame (see the engine's write dispatch)
		try {
			retireInner(t);
			// Boundary rule: retirement is a guaranteed flush point for every root
			// (a write-free retirement still flushes pending member-write flips).
			core.revalidateCommittedSubscriptions(undefined);
			core.endOperation();
		} finally {
			core.opDepth--;
		}
		core.runOperationEpilogue();
	}

	/** The async action's promise settled; the protocol host then retires the batch. */
	function settleAction(batchId: BatchId): void {
		const t = getBatchById(batchId);
		if (!t.action) throw new ScheduleError('settle targets an action batch');
		if (!t.parked || t.state !== 'live') throw new ScheduleError('action already settled');
		core.opDepth++; // public-operation frame (see the engine's write dispatch)
		try {
			t.parked = false;
			const tr = core.trace;
			if (tr !== undefined) tr.batchSettle(t);
			retireInner(t);
			core.revalidateCommittedSubscriptions(undefined); // boundary rule: settlement is a guaranteed flush point
			core.endOperation();
		} finally {
			core.opDepth--;
		}
		core.runOperationEpilogue();
	}

	/**
	 * Retirement — the batch's writes become permanent history visible to
	 * every world. The internal order matters: stamp log entries, fold what
	 * the stamps made foldable (the fold valve), retirement stamps +
	 * committed-advance, durable drains, clear per-root rows (the retired
	 * clause now subsumes membership), release the slot (deferred if an open
	 * render's render mask still names it), and close the episode when this
	 * was the last pending durable work. Retirement is disposition-blind: a
	 * batch React abandoned retires through this same path — whether writes
	 * persist never depends on who was subscribed (the bindings record the
	 * committed/abandoned report diagnostically at its source; see
	 * TraceHooks.batchDisposition).
	 */
	function retireInner(batch: Batch): void {
		if (batch.state === 'live') {
			liveBatchCount--;
		}
		batch.state = 'retired';
		batch.parked = false;
		const retiredSeq = core.nextSeq(); // one retirement sequence per retirement event
		batch.retiredSeq = retiredSeq;
		// Stamp only the atoms this batch actually touched (the per-batch
		// touch list replaces an all-nodes/all-log entries scan).
		let touchedAny = false;
		const touchedAtoms = batch.atomsTouched;
		for (let i = 0; i < touchedAtoms.length; i++) {
			const n = touchedAtoms[i]!;
			if (n.retirementStamp === retiredSeq) continue; // duplicate touch entry
			const log = n.log;
			const entries = log.entries;
			let stamped = 0;
			for (let j = 0; j < entries.length; j++) {
				const e = entries[j]!;
				if (e.batch === batch.id && e.retiredSeq === undefined) {
					e.retiredSeq = retiredSeq;
					stamped++;
				}
			}
			if (stamped !== 0) {
				log.unretired -= stamped;
				log.maxRetiredSeq = retiredSeq; // stamps are monotone: plain assignment maintains the max
				// Create the retirement stamp per touched atom (visibility of its
				// history changed; fingerprints must reflect that).
				n.retirementStamp = retiredSeq;
				touchedAny = true;
			}
		}
		if (touchedAny) core.advanceCommitted();
		// The bounded-memory fold valve (see WriteLog.ts foldRetiredPrefix for
		// the two-clause predicate) — a size check unless a candidate exists.
		core.runFoldValve();
		// Committed-truth flip site: retirement — after stamps +
		// committedAdvance + the fold valve, before the drain loop (the
		// ordering joint every flip site shares: mutate → fan → drain), fan
		// the retiring batch's touched atoms into every committed arena.
		if (touchedAny) core.fanAtomsToCommittedArenas(batch.atomsTouched);
		{
			const tr = core.trace;
			if (tr !== undefined) tr.retired(batch.id, retiredSeq);
		}
		// Durable drains, per root, gated on a flipped slot, member-write
		// drift, or restaled leftovers: candidates come from
		// each root arena's dirty list — the site-(a) fanout above marked
		// them, and list entries persist until a drain-then-decay boundary
		// consumes them (never a consumable write-time queue).
		{
			const slotBit = batch.slot !== undefined ? 1 << batch.slot : 0;
			for (const r of roots.values()) {
				const bits = slotBit | r.committedDirtySlots;
				r.committedDirtySlots = 0;
				const re = core.restaled.get(r.id);
				if (bits !== 0 || (re !== undefined && re.size > 0)) core.drainCommittedObservers(r.id, 'retirement');
			}
			// Boundary mark decay — unconsumed marks on unwatched
			// nodes drop to cold instead of re-appending forever.
			for (const a of core.rootToArena.values()) core.arenaDecay(a);
		}
		// Clear per-root rows (the retired clause subsumes membership now),
		// then release the slot unless an open render mask names it.
		for (const r of roots.values()) {
			if (r.committedBatches.delete(batch.id)) rebuildCommittedBits(r);
		}
		if (batch.slot !== undefined) {
			const slot = slots[batch.slot]!;
			if (isSlotRetainedByOpenMask(slot.id)) {
				slot.releasePending = true; // re-evaluated at every render end
				const tr = core.trace;
				if (tr !== undefined) tr.slotReleaseDeferred(slot.id, batch.id);
			} else {
				releaseSlot(slot);
			}
		}
		if (ambientBatch === batch.id) ambientBatch = undefined;
		// The last retirement with every render closed ends the episode: the
		// durable handoff runs and the episode's records drop wholesale
		// (WriteLog.ts maybeCloseEpisode) — before quiet re-derives below, so
		// notification/settlement callbacks of this same operation classify
		// their writes against the post-episode state, exactly as the
		// reference model's derivation does.
		core.maybeCloseEpisode();
		core.recomputeQuiet(); // the last retirement (episode closed) re-arms quiet
	}

	return {
		idToBatch,
		slots,
		getLiveBatchCount: () => liveBatchCount,
		openBatch,
		getBatchById,
		liveBatches,
		internSlot,
		releaseSlot,
		rebuildCommittedBits,
		getAmbientBatch: () => ambientBatch,
		setAmbientBatch: (id) => {
			ambientBatch = id;
		},
		isSlotRetainedByOpenMask,
		retire,
		settleAction,
		retireInner,
	};
}
