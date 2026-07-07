/**
 * The batch MECHANISM and its LIFECYCLE: batch identity (`Batch` records
 * keyed by `BatchId`), the 31-entry recycling slot table (`BatchSlotMeta`),
 * slot interning / release / the loud release-anyway backstop, the
 * committed-bits rebuild, the live-batch bookkeeping, the ambient default
 * batch, AND retirement — the batch's terminal transition, whose fan
 * (compaction, arena fan-out, durable drains, per-root membership clears,
 * slot release) reaches the other mechanisms through the shared engine core
 * record's late-bound slots. A BATCH is the group of writes belonging to
 * one UI update; a SLOT is the batch's position in the 31-entry table while
 * it is live-and-written, so "which batches affect X" fits one 31-bit
 * integer word (a `BatchSlotSet`) — the vocabulary is defined in full at the
 * top of concurrent.ts.
 *
 * `createBatch` is a factory in the kernel's own style (index.ts
 * `createEngine`): it closes over its state and returns its operation
 * table; the engine composes one per bridge and keeps `idToBatch`/`slots`
 * aliased for its resident readers (the shared-array pattern the kernel
 * uses for its `values`/`fns` side columns). It takes the shared core
 * record for retirement's cross-module fan (every such call reads its
 * late-bound slot at call time); the two remaining resident-state edges
 * (the registered latch, the write path's last-batch cache) come in
 * through `deps`.
 */

import { ScheduleError } from './errors.js';
import { probes } from './engine.js';
import type { AtomNode, RootState, Seq, TraceHooks } from './concurrent.js';
import type { EngineCore } from './World.js';

export type BatchId = number;
/** The reserved "no batch context" BatchId. Never allocated (batch ids start
 * at 1): `getCurrentWriteBatch() === BATCH_NONE` means no renderer provider
 * has registered, and a classified write carrying it has no batch to join.
 * The React fork names the same sentinel on its side (protocol v2 shares ONE
 * id space between the engine and React, so the sentinel must too). */
export const BATCH_NONE: BatchId = 0;
export type BatchSlot = number;
/** A 31-bit slot set: bit i = slot i (mask/included/committed/dedup words). */
export type BatchSlotSet = number;

export type Batch = {
	id: BatchId;
	action: boolean;
	parked: boolean;
	/** The React-side classification told to the driver's batch-id allocator
	 * at creation (true = transition-like: renders don't block paint and the
	 * batch commits later). A DRIVER-owned annotation stored on the shared
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
	 * render's captured slot sets (see mountFixup). */
	lastWriteSeq: Seq;
	/** Atoms this batch appended to (may hold benign duplicates; deduped at retirement). */
	atomsTouched: AtomNode[];
	/** Un-compacted log entries still on write logs. Log entries reference batches by id,
	 * so the batch record must outlive them (reclamation gate). */
	liveLogEntries: number;
	ambient: boolean;
};

/** One entry of the 31-slot recycling table a written batch occupies (see
 * the SLOT/INTERN/TENANT definitions in concurrent.ts's header). */
export type BatchSlotMeta = {
	id: BatchSlot;
	tenant: BatchId | undefined;
	/** Claim sequence — a point on the shared timeline created at every
	 * intern (the creation itself is load-bearing for model parity: both sides
	 * spend one sequence per claim). The engine never reads the stored
	 * value; the oracle's `checkInvariants` tenancy orderings consult it
	 * through the test-side model view. */
	claimSeq: Seq;
	/** Sequence of the last write under this slot; zeroed when a new tenant
	 * claims it (the mount fixup's clock conjunct compares it against
	 * snapshot pins). */
	writeClock: Seq;
	releasePending: boolean;
};

const SLOT_COUNT = 31; // at most 31 live batches — one per React lane, and slot sets fit one int bit mask.

/** BatchId source — MONOTONIC for the PROCESS's whole life, never reused
 * and never rewound (ids start at 1; BATCH_NONE = 0 is never allocated).
 * With protocol v2 these ids are stored verbatim in React's batch registry,
 * so monotonicity is what keeps a stale fork-side id from ever colliding
 * with a later batch. MODULE-LEVEL deliberately: the counter SURVIVES
 * `__resetEngineForTest` (which re-runs the factory below) — a host lane
 * table can legally hold an id across an engine reset, and monotonicity
 * guarantees a stale id can never collide with a post-reset batch. */
let nextBatchId = 1;

/** The next id the allocator would hand out (test harnesses rebase their
 * model↔engine batch-id comparison on it across resets). @internal */
export function __peekNextBatchIdForTest(): BatchId {
	return nextBatchId;
}

/** The resident-state edges the mechanism consumes (provided by the engine's
 * composition site; each is a thin arrow over engine state or orchestration). */
export type BatchDeps = {
	/** The driver slot's presence + the devChecks switch — R-5's openBatch
	 * guard: with devChecks armed, opening a batch with no driver attached
	 * throws (the documented host contract is "hosts that open batches must
	 * retire them"; the guard catches harnesses that forgot to attach). */
	hasDriver(): boolean;
	devChecksOn(): boolean;
	/** Reclamation's edge into the write path's last-batch cache: clear the
	 * cache iff it names the reclaimed id (the cache stays resident beside
	 * the write path that reads it per write). */
	invalidateBatchCache(id: BatchId): void;
};

export type BatchTable = {
	/** Batch records by id (shared identity: the engine aliases it for its
	 * resident readers — commits, mount fixup, tests). */
	idToBatch: Map<BatchId, Batch>;
	/** The 31-entry recycling slot table (shared identity, as above). */
	slots: BatchSlotMeta[];
	liveBatchCount(): number;
	openBatch(opts?: { action?: boolean; ambient?: boolean; deferred?: boolean }): Batch;
	batchById(id: BatchId): Batch;
	liveBatches(): Batch[];
	internSlot(batch: Batch): BatchSlotMeta;
	releaseSlot(slot: BatchSlotMeta): void;
	rebuildCommittedBits(r: RootState): void;
	/** The ambient default batch for bare (context-free) writes — the id, or
	 * undefined while none is live (retirement clears it). */
	ambient(): BatchId | undefined;
	setAmbient(id: BatchId): void;
	/** True iff any open render's mask names the slot (retirement's deferred
	 * release + the render-close re-evaluation share the one predicate). */
	slotRetainedByOpenMask(slot: BatchSlot): boolean;
	/** Retirement (public operation) + the settlement edge of an async action. */
	retire(batchId: BatchId): void;
	settleAction(batchId: BatchId): void;
	/** The retirement fold itself (render-commit's retire-at-commit calls it
	 * inside the commit's own operation frame). */
	retireInternal(batch: Batch): void;
	/** Mid-episode batch reclamation re-check (render close lapses mask retention). */
	maybeReclaimBatch(t: Batch): void;
	/** The compaction→batch edge: a compacted log entry stops pinning its
	 * batch record (live-entry decrement + reclaim re-check). */
	releaseLogEntry(batch: BatchId): void;
};

export function createBatch(core: EngineCore, deps: BatchDeps): BatchTable {
	// Stable resident containers, aliased once (identity-shared).
	const roots = core.roots;
	const rootToOpenRender = core.rootToOpenRender;

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
	 * ALLOCATION-ONLY envelope (the driver's allocator calls this from
	 * React's batch-creation site, which can sit mid-render, mid-commit, or
	 * inside protocol listeners — i.e. at opDepth > 0): bookkeeping only —
	 * counter, registry map, quiet recompute, probes/trace records. No
	 * operation epilogue, no drains, no kernel mutation, no user code.
	 *
	 * R-5: with devChecks armed, opening a batch with NO driver attached
	 * throws — the documented host contract is "hosts that open batches
	 * must retire them", and a devChecks harness must attach its driver
	 * before opening engine batches. */
	function openBatch(opts?: { action?: boolean; ambient?: boolean; deferred?: boolean }): Batch {
		if (deps.devChecksOn() && !deps.hasDriver()) {
			throw new ScheduleError('openBatch with no driver attached — hosts that open batches must retire them; attach a driver first (devChecks)');
		}
		if (liveBatchCount >= SLOT_COUNT) {
			throw new ScheduleError('at most 31 batches may be live at once (one per React lane)');
		}
		const parked = opts?.action ?? false;
		probes.batches++; // One Core probe (referee surface)
		const batch: Batch = {
			id: nextBatchId++,
			action: opts?.action ?? false,
			parked, // async-action batches park (cannot retire) until their promise settles
			deferred: opts?.deferred ?? false, // driver-owned annotation (see Batch.deferred)
			state: 'live', slot: undefined,
			retiredSeq: undefined, lastWriteSeq: 0, atomsTouched: [], liveLogEntries: 0,
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
	function batchById(id: BatchId): Batch {
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
				const ra = batchById(a.tenant!).retiredSeq ?? 0;
				const rb = batchById(b.tenant!).retiredSeq ?? 0;
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
		// its root's membership bits gain the slot NOW so the committed world's
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
		const tenant = slot.tenant === undefined ? undefined : batchById(slot.tenant);
		if (tenant !== undefined) {
			tenant.slot = undefined; // identity release; log entries keep their denormalized slot
			const tr = core.trace;
			if (tr !== undefined) tr.slotReleased(slot.id, tenant.id);
		}
		slot.tenant = undefined;
		slot.releasePending = false;
		if (tenant !== undefined) maybeReclaimBatch(tenant); // identity gone; mask/log-entry gates re-check
	}

	function rebuildCommittedBits(r: RootState): void {
		let bits = 0;
		for (const tid of r.committedBatches) {
			const batch = idToBatch.get(tid);
			if (batch !== undefined && batch.slot !== undefined) bits |= 1 << batch.slot;
		}
		r.committedBits = bits;
	}

	function slotRetainedByOpenMask(slot: BatchSlot): boolean {
		for (const p of rootToOpenRender.values()) {
			if ((p.maskBits >>> slot) & 1) return true;
		}
		return false;
	}

	function batchMaskedByOpenRender(id: BatchId): boolean {
		for (const p of rootToOpenRender.values()) {
			if (p.maskBatches.has(id)) return true;
		}
		return false;
	}

	/**
	 * Mid-episode batch reclamation: a batch record is reclaimable once it
	 * is retired, its slot identity is fully released (not deferred), no
	 * open render's mask names it, and none of its log entries remain
	 * un-compacted (write logs reference batches by id, so a batch must outlive
	 * its log entries). Touched bits/lists are untouched — they are
	 * tenant-agnostic conservative dirt (keep-the-dirt discipline).
	 */
	function maybeReclaimBatch(t: Batch): void {
		if (t.state !== 'retired') return;
		if (t.slot !== undefined) return; // identity still held (deferred release keeps tenant)
		if (t.liveLogEntries > 0) return;
		if (t.id === ambientBatch) return;
		if (batchMaskedByOpenRender(t.id)) return;
		idToBatch.delete(t.id);
		deps.invalidateBatchCache(t.id); // the write path's last-batch cache must not outlive the record
	}

	/** The compaction→batch edge (WriteLog.ts's `releaseLogEntry` dep): a
	 * compacted log entry stops pinning its batch record. */
	function releaseLogEntry(batchId: BatchId): void {
		const batch = idToBatch.get(batchId);
		if (batch !== undefined) {
			batch.liveLogEntries--;
			if (batch.liveLogEntries === 0) maybeReclaimBatch(batch);
		}
	}

	// ---------------------------------------------------------- retirement

	/** Retirement fires exactly once per batch; parked async actions retire
	 * only at settlement (their pending state must stay pending until then). */
	function retire(batchId: BatchId): void {
		const t = batchById(batchId);
		if (t.state === 'retired') throw new ScheduleError('retirement fires exactly once per batch');
		if (t.parked) throw new ScheduleError('parked action batches retire only at settlement');
		core.opDepth++; // NF2 S-A: public-operation frame (see the engine's write)
		try {
			retireInternal(t);
			// EF2 boundary: retirement is a guaranteed flush point for every root
			// (a write-free retirement still flushes pending member-write flips).
			core.revalidateCommittedSubs(undefined);
			core.endOp();
		} finally {
			core.opDepth--;
		}
		core.arenaOpEpilogue();
	}

	/** The async action's promise settled; the protocol host then retires the batch. */
	function settleAction(batchId: BatchId): void {
		const t = batchById(batchId);
		if (!t.action) throw new ScheduleError('settle targets an action batch');
		if (!t.parked || t.state !== 'live') throw new ScheduleError('action already settled');
		core.opDepth++; // NF2 S-A: public-operation frame (see the engine's write)
		try {
			t.parked = false;
			const tr = core.trace;
			if (tr !== undefined) tr.batchSettle(t);
			retireInternal(t);
			core.revalidateCommittedSubs(undefined); // EF2 boundary: settlement is a guaranteed flush point
			core.endOp();
		} finally {
			core.opDepth--;
		}
		core.arenaOpEpilogue();
	}

	/**
	 * Retirement — the batch's writes become permanent history visible to
	 * every world. The internal order matters: stamp log entries, fold
	 * (compaction), retirement stamps + committed-advance, durable drains,
	 * clear per-root rows (the retired clause now subsumes membership), and
	 * only then release the slot (deferred if an open render's render mask
	 * still names it). Retirement is disposition-blind: a batch React
	 * abandoned retires through this same path — whether writes persist
	 * never depends on who was subscribed (the bindings record the
	 * committed/abandoned report diagnostically at its source; see
	 * TraceHooks.batchDisposition).
	 */
	function retireInternal(batch: Batch): void {
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
			const batches = log.batches;
			const retired = log.retired;
			let hit = false;
			for (let j = log.start; j < log.n; j++) {
				if (batches[j] === batch.id && retired[j] === 0) {
					retired[j] = retiredSeq;
					hit = true;
				}
			}
			if (hit) {
				// Create the retirement stamp per touched atom (visibility of its
				// history changed; fingerprints must reflect that).
				n.retirementStamp = retiredSeq;
				touchedAny = true;
			}
		}
		if (touchedAny) core.advanceCommitted();
		// Fold/compaction (see WriteLog.ts compactAll for the two-clause predicate).
		core.compactAll();
		// NF2 S-A flip site (a): retirement — after stamps + committedAdvance + compaction,
		// BEFORE the drain loop (§4.3's ordering joint: mutate → fan → drain),
		// fan the retiring batch's touched atoms into EVERY committed arena.
		if (touchedAny) core.fanAtomsToCommittedArenas(batch.atomsTouched);
		{
			const tr = core.trace;
			if (tr !== undefined) tr.retired(batch.id, retiredSeq);
		}
		// Durable drains, per root, gated exactly as before (flipped slot or
		// member-write drift or restaled leftovers): candidates come from
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
			// NF2 S-A: boundary mark decay — unconsumed marks on unwatched
			// nodes drop to cold instead of re-appending forever (§4.3).
			for (const a of core.rootToArena.values()) core.arenaDecay(a);
		}
		// Clear per-root rows (the retired clause subsumes membership now),
		// THEN release the slot unless an open render mask names it.
		for (const r of roots.values()) {
			if (r.committedBatches.delete(batch.id)) rebuildCommittedBits(r);
		}
		if (batch.slot !== undefined) {
			const slot = slots[batch.slot]!;
			if (slotRetainedByOpenMask(slot.id)) {
				slot.releasePending = true; // re-evaluated at every render end
				const tr = core.trace;
				if (tr !== undefined) tr.slotReleaseDeferred(slot.id, batch.id);
			} else {
				releaseSlot(slot);
			}
		}
		if (ambientBatch === batch.id) ambientBatch = undefined;
		maybeReclaimBatch(batch);
		core.recomputeQuiet(); // the LAST retirement (with every write log compacted) re-arms quiet
	}

	return {
		idToBatch,
		slots,
		liveBatchCount: () => liveBatchCount,
		openBatch,
		batchById,
		liveBatches,
		internSlot,
		releaseSlot,
		rebuildCommittedBits,
		ambient: () => ambientBatch,
		setAmbient: (id) => {
			ambientBatch = id;
		},
		slotRetainedByOpenMask,
		retire,
		settleAction,
		retireInternal,
		maybeReclaimBatch,
		releaseLogEntry,
	};
}
