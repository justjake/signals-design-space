/**
 * The batch MECHANISM: batch identity (`Batch` records keyed by `BatchId`),
 * the 31-entry recycling slot table (`BatchSlotMeta`), slot interning /
 * release / the loud release-anyway backstop, the committed-bits rebuild,
 * and the live-batch bookkeeping. A BATCH is the group of writes belonging
 * to one UI update; a SLOT is the batch's position in the 31-entry table
 * while it is live-and-written, so "which batches affect X" fits one 31-bit
 * integer word (a `BatchSlotSet`) — the vocabulary is defined in full at the
 * top of concurrent.ts.
 *
 * Mechanism only: batch RETIREMENT and the render-close edge (which fan
 * across write logs, arenas, drains, and per-root state) are orchestration
 * and stay in concurrent.ts; they reach this module through the returned
 * operation table, and the few resident-state edges the mechanism needs
 * (the sequence clock, quiet recompute, slot-claim housekeeping over roots
 * and watchers, batch reclamation) come in through `deps` — this module
 * never reads engine state directly.
 *
 * `createBatch` is a factory in the kernel's own style (index.ts
 * `createEngine`): it closes over its state and returns its operation
 * table; the engine composes one per bridge and keeps `idToBatch`/`slots`
 * aliased for its resident readers (the shared-array pattern the kernel
 * uses for its `values`/`fns` side columns).
 */

import { ScheduleError } from './errors.js';
import { probes } from './probes.js';
import type { AtomNode, RootState, Seq, TraceHooks } from './concurrent.js';

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

/** The resident-state edges the mechanism consumes (provided by the engine's
 * composition site; each is a thin arrow over engine state or orchestration). */
export type BatchDeps = {
	/** The engine's registered latch (openBatch's guard). */
	isRegistered(): boolean;
	/** The one global sequence clock (slot claims spend a sequence). */
	nextSeq(): Seq;
	/** Quiet-state recompute at the batch-open transition. */
	recomputeQuiet(): void;
	/** The engine's trace recorder slot (undefined unless a tracer attached). */
	trace(): TraceHooks | undefined;
	/** Slot-claim housekeeping over resident state, in claim order: the
	 * late-intern committed-bits back-fill over every root, then the
	 * per-(watcher, slot) dedup-bit clear. */
	slotClaimHousekeeping(batch: Batch, slot: BatchSlot): void;
	/** Batch reclamation (resident orchestration: it consults render masks
	 * and the ambient batch) — releaseSlot re-checks the released tenant. */
	maybeReclaimBatch(t: Batch): void;
};

export type BatchTable = {
	/** Batch records by id (shared identity: the engine aliases it for its
	 * resident readers — retirement, commits, mount fixup, tests). */
	idToBatch: Map<BatchId, Batch>;
	/** The 31-entry recycling slot table (shared identity, as above). */
	slots: BatchSlotMeta[];
	liveBatchCount(): number;
	/** Retirement's decrement (the state stays mechanism-owned; the resident
	 * orchestration mutates it through this call). */
	decLiveBatchCount(): void;
	openBatch(opts?: { action?: boolean; ambient?: boolean; deferred?: boolean }): Batch;
	batchById(id: BatchId): Batch;
	liveBatches(): Batch[];
	internSlot(batch: Batch): BatchSlotMeta;
	releaseSlot(slot: BatchSlotMeta): void;
	rebuildCommittedBits(r: RootState): void;
};

export function createBatch(deps: BatchDeps): BatchTable {
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
	/** BatchId source — MONOTONIC for this engine's whole life, never reused
	 * and never rewound (ids start at 1; BATCH_NONE = 0 is never allocated).
	 * With protocol v2 these ids are stored verbatim in React's batch
	 * registry, so monotonicity is what keeps a stale fork-side id from ever
	 * colliding with a later batch. (Surviving `__resetEngineForTest` — ids
	 * monotonic ACROSS engine resets — is the great-refactor S5 rule, noted
	 * here so the reset work keeps it; per-test bridges today get fresh
	 * counters and rely on the fork's test-only registry reset instead.) */
	let nextBatchId = 1;

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
	 * operation epilogue, no drains, no kernel mutation, no user code. */
	function openBatch(opts?: { action?: boolean; ambient?: boolean; deferred?: boolean }): Batch {
		if (!deps.isRegistered()) throw new ScheduleError('batches require a registered bridge — register the React bridge first');
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
		deps.recomputeQuiet(); // a live batch: the pipeline is armed until the last retirement
		const tr = deps.trace();
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
			const tr = deps.trace();
			if (tr !== undefined) tr.slotBackstopReleased(victim.id, victim.tenant!);
			releaseSlot(victim);
			free = victim;
		}
		free.tenant = batch.id;
		free.claimSeq = deps.nextSeq(); // claim-after-release gets its own point on the timeline
		free.writeClock = 0;
		free.releasePending = false;
		batch.slot = free.id;
		// Resident housekeeping, in claim order: the late-intern committed-bits
		// back-fill over every root, then the per-(watcher, slot) dedup clear.
		deps.slotClaimHousekeeping(batch, free.id);
		{
			const tr = deps.trace();
			if (tr !== undefined) tr.slotClaimed(free.id, batch.id);
		}
		return free;
	}

	function releaseSlot(slot: BatchSlotMeta): void {
		const tenant = slot.tenant === undefined ? undefined : batchById(slot.tenant);
		if (tenant !== undefined) {
			tenant.slot = undefined; // identity release; log entries keep their denormalized slot
			const tr = deps.trace();
			if (tr !== undefined) tr.slotReleased(slot.id, tenant.id);
		}
		slot.tenant = undefined;
		slot.releasePending = false;
		if (tenant !== undefined) deps.maybeReclaimBatch(tenant); // identity gone; mask/log-entry gates re-check
	}

	function rebuildCommittedBits(r: RootState): void {
		let bits = 0;
		for (const tid of r.committedBatches) {
			const batch = idToBatch.get(tid);
			if (batch !== undefined && batch.slot !== undefined) bits |= 1 << batch.slot;
		}
		r.committedBits = bits;
	}

	return {
		idToBatch,
		slots,
		liveBatchCount: () => liveBatchCount,
		decLiveBatchCount: () => {
			liveBatchCount--;
		},
		openBatch,
		batchById,
		liveBatches,
		internSlot,
		releaseSlot,
		rebuildCommittedBits,
	};
}
