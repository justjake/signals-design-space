/**
 * The per-atom WRITE LOG (the episode tape) and the EPISODE LIFECYCLE. A
 * WRITE-LOG ENTRY records one write — {op, slot, seq}, with retiredSeq
 * stamped at the batch's retirement; entries live int-packed in fixed-size
 * chunks on the written atom's `WriteLog` (the full vocabulary is defined at
 * the top of concurrent.ts).
 *
 * ## The episode lifecycle
 *
 * An EPISODE runs from the first pending durable work (a batch opens, an
 * action parks, a render starts — never inferred from writes or call depth)
 * to full quiescence (every batch retired, every world closed). Episode-
 * lifetime state — write records, batch bookkeeping — is dropped WHOLESALE
 * at that boundary, never maintained per entry:
 *
 *  - Each touched atom's write log carries the atom's episode-start `base`
 *    (immutable while the episode runs, except by the log's own sealed-chunk
 *    folds below) plus its entries; every world folds from that base.
 *  - DURABLE HANDOFF at the close: with every batch retired and every render
 *    closed, each world's fold over the whole log equals the kernel's newest
 *    value (the eager-apply invariant, referee-verified), so the close
 *    adopts kernel newest as the new base BY IDENTITY — zero op replays,
 *    zero equality re-invocations — and the log drops whole. Retired batch
 *    records drop in the same sweep (write records reference batches by id,
 *    so the records outlive the entries by construction).
 *  - BOUNDED MEMORY under held-open episodes (a parked action can hold an
 *    episode open indefinitely): entries live in fixed-size chunks; every
 *    non-tail chunk is full (SEALED) by construction, and a sealed prefix
 *    chunk whose entries are all retired and below every live render pin
 *    folds into base and drops WHOLE — appends stay cheap, and no
 *    per-entry bookkeeping (batch pin counts, window rebases) exists.
 *
 * `createEpisodeLifecycle` is a factory in the kernel's own style (index.ts
 * `createKernel`): it closes over `holds` (the episode's touched-atom
 * membership — atoms whose write log holds entries) and `sealedLogs` (the
 * fold valve's candidates) and returns its operation table; both sets are
 * exposed by identity so the engine's write path keeps its one-branch
 * membership adds and the quiet derivation its size check. `holds` is also
 * a reclamation guard row: membership blocks record reclaim, and the
 * episode drop is the row's retry trigger (reclaimRetryAllSkipped at the
 * close; a mid-episode fold that empties one log files the per-atom retry).
 */

import { probes, type ConcurrentEngineHost } from './ConcurrentEngine.js';
import { noteReclaimRetry, reclaimRetryAllSkipped, reclaimSkippedN } from './CosignalEngine.js';
import type { BatchManager, BatchId, BatchSlot } from './Batch.js';
import type { EngineCore } from './World.js';
import type { AtomInternals, Seq, Value, WriteKind } from './concurrent.js';

/**
 * A log entry: one recorded write — {op, slot, seq} appended at the write,
 * retiredSeq stamped at the batch's retirement. Log entries denormalize their
 * slot at creation: slots are recycled identities, so visibility checks must read
 * the slot the write happened under, not the batch's current slot (which may
 * already be released); the batch id is carried for invariants and event
 * logs only. Log entries live int-packed in per-atom `WriteLog` chunks ({kind,
 * slot, seq, retiredSeq, batch} parallel number columns + one unknown[]
 * payload side column); this materialized object shape — including the
 * object-shaped `op` (a write operation: set/update; a ReducerAtom dispatch
 * records as an update whose closure captures the reducer and the action) —
 * is the test/trace surface only (`WriteLog.materialize()`, trace `logEntry`
 * hook). The write path itself carries the (kind, payload) scalar pair end
 * to end and never builds it.
 */
export type WriteLogEntry = {
	op: { kind: 'set'; value: Value } | { kind: 'update'; fn: (prev: Value) => Value };
	batch: BatchId;
	slot: BatchSlot;
	seq: Seq;
	retiredSeq: Seq | undefined;
};

/**
 * The chunk capacity — how many entries a write-log chunk holds before it
 * seals and appends continue into a fresh chunk. A power of two: the write
 * path detects the seal transition with one mask (`length &
 * (TAPE_CHUNK_ENTRIES - 1)`), which is exact because every non-tail chunk
 * is full by construction (chunks seal only by filling; folds remove whole
 * prefix chunks), so the live length is congruent to the tail's fill.
 */
export const TAPE_CHUNK_ENTRIES = 1024;

/**
 * One fixed-size chunk of int-packed log entry columns: recording a write is
 * a few integer stores, not an object allocation. Plain number arrays stay
 * SMI-packed (V8's fast small-integer array representation) and grow in
 * place up to the chunk capacity; a dropped chunk releases its arrays whole
 * — no memmove, no rebase, no per-entry fix-up ever runs. (`WriteKind` is
 * concurrent.ts's const enum, imported type-only: its hot comparison sites
 * live there, and this module's one kind branch — the materialized
 * test/trace surface — compares the bare 0/1 codes the two declarations
 * share by construction.)
 */
// Exported with the log: `WriteLog.chunks` is part of the log's inspectable
// shape (tests and diagnostics read chunk counts and columns).
export class TapeChunk {
	/** Entries in this chunk (the tail chunk fills to TAPE_CHUNK_ENTRIES and seals). */
	n = 0;
	/** Entries not yet retirement-stamped (all-retired ⇔ 0) — the fold
	 * valve's O(1) prefix clause. */
	unretired = 0;
	/** The chunk's newest retirement stamp — the fold valve's O(1) pin clause
	 * (stamps are monotone, so plain assignment at each stamping maintains it). */
	maxRetiredSeq: Seq = 0;
	kinds: WriteKind[] = [];
	slots: BatchSlot[] = [];
	seqs: Seq[] = [];
	/** 0 = unretired (sequences start at 1). */
	retired: Seq[] = [];
	batches: BatchId[] = [];
	payloads: unknown[] = [];
}

/** The materialized face of one chunk entry (test/trace surface — see
 * WriteLogEntry; the module-level helper so the episode drop and the class
 * share one builder). */
function chunkEntryAt(ch: TapeChunk, i: number): WriteLogEntry {
	const k = ch.kinds[i]!;
	const op: WriteLogEntry['op'] =
		k === 0 /* WriteKind.SET */
			? { kind: 'set', value: ch.payloads[i] }
			: { kind: 'update', fn: ch.payloads[i] as (prev: Value) => Value };
	const r = ch.retired[i]!;
	return { op, batch: ch.batches[i]!, slot: ch.slots[i]!, seq: ch.seqs[i]!, retiredSeq: r === 0 ? undefined : r };
}

/**
 * The per-atom write log: the atom's episode tape. Chunked (see TapeChunk);
 * `chunks[0]` is the oldest live chunk and the only fold candidate — chunks
 * fold strictly in order, because folding out of order would change replay
 * results. Empty for the quiet population (chunks allocate on the first
 * logged write).
 */
export class WriteLog {
	/** Live chunks, oldest first; every non-tail chunk is full (sealed). */
	chunks: TapeChunk[] = [];
	/** Total live entries across chunks (a plain field — the write path's
	 * membership branches and the reclaim/quiet consumers read it directly). */
	length = 0;
	/** Live entries not yet retirement-stamped, whole-log (the write path's
	 * retired-history drop arm reads it — see writeInBatchInner). */
	unretired = 0;
	/** The newest retirement stamp over LIVE entries, whole-log (the drop
	 * arm's pin clause; recomputed when a fold removes a chunk that may have
	 * carried the max). */
	maxRetiredSeq: Seq = 0;

	push(kind: WriteKind, slot: BatchSlot, seq: Seq, batch: BatchId, payload: unknown): void {
		probes.logEntries++; // engine-activity counter (tests/one-core.spec.ts's zero-cost check)
		const chunks = this.chunks;
		let ch = chunks.length === 0 ? undefined : chunks[chunks.length - 1]!;
		if (ch === undefined || ch.n === TAPE_CHUNK_ENTRIES) {
			ch = new TapeChunk();
			chunks.push(ch);
		}
		ch.kinds.push(kind);
		ch.slots.push(slot);
		ch.seqs.push(seq);
		ch.retired.push(0);
		ch.batches.push(batch);
		ch.payloads.push(payload);
		ch.n++;
		ch.unretired++;
		this.length++;
		this.unretired++;
	}

	/** The just-appended entry, materialized (the trace `logEntry` hook's one
	 * consumer — tracer-attached only). */
	tailEntry(): WriteLogEntry {
		const ch = this.chunks[this.chunks.length - 1]!;
		return chunkEntryAt(ch, ch.n - 1);
	}

	materialize(): WriteLogEntry[] {
		const out: WriteLogEntry[] = [];
		for (const ch of this.chunks) {
			for (let i = 0; i < ch.n; i++) out.push(chunkEntryAt(ch, i));
		}
		return out;
	}

	/** Drop every entry (the episode close's durable handoff — base has just
	 * adopted the folded result, so the history is redundant). Object identity
	 * is preserved: holders of the log keep a valid, empty log. */
	reset(): void {
		this.chunks = [];
		this.length = 0;
		this.unretired = 0;
		this.maxRetiredSeq = 0;
	}
}

/** The resident-state edges the episode lifecycle consumes (provided by the
 * engine's composition site), as named slices of the providers' own record
 * types. */
export type EpisodeLifecycleDeps = {
	/** The shared engine core record's slices: the minimum live render pin
	 * (the fold valve's pin clause floor — a LATE-BOUND core slot, read at
	 * call time), one-op application under the fold-purity guards, the
	 * atom's one equality rule (sealed-chunk folds replay stepwise, exactly
	 * like a world fold), and the open-render table (the close's
	 * every-world-closed clause). */
	core: Pick<EngineCore, 'getMinLivePin' | 'applyOp' | 'isAtomValueEqual' | 'rootToOpenRender'>;
	/** The engine host's slice: the untracked kernel newest read (the
	 * handoff's adopted value), the optional drop observer (the engine's
	 * public `onLogEntryDrop` slot), and the write path's last-batch cache
	 * clear (a dropped batch record must not be served from the cache). */
	host: Pick<ConcurrentEngineHost, 'readNewestUntracked' | 'getOnLogEntryDrop' | 'invalidateBatchCache'>;
	/** The batch manager's slice: the record registry the close sweeps
	 * (retired records drop wholesale with the episode) and the live count
	 * (the close's every-batch-retired clause). */
	batch: Pick<BatchManager, 'idToBatch' | 'getLiveBatchCount'>;
};

export type EpisodeLifecycle = {
	/** Atoms whose write log holds entries — the episode's touched-atom
	 * membership (shared identity: the engine aliases it; see the module
	 * header). Doubles as the reclamation guard row: membership blocks
	 * record reclaim; the episode drop is the retry trigger. */
	holds: Set<AtomInternals>;
	/** Atoms whose write log holds at least one sealed chunk — the fold
	 * valve's candidates (shared identity; the write path adds at the seal
	 * transition). Empty in every episode that stays under one chunk per
	 * atom, which keeps the valve one size check at each boundary. */
	sealedLogs: Set<AtomInternals>;
	foldSealedChunks(): void;
	maybeCloseEpisode(): void;
};

export function createEpisodeLifecycle(deps: EpisodeLifecycleDeps): EpisodeLifecycle {
	// Composition-time locals (the codegen doctrine): the per-entry fold
	// calls bind once (applyOp/isAtomValueEqual are assigned before this
	// factory runs, as is the batch table); `getMinLivePin` is a late-bound
	// core slot (assigned by the render-pass factory, which composes after
	// this one), so it stays a call-time read off the aliased core record.
	const core = deps.core;
	const { applyOp, isAtomValueEqual } = core;
	const rootToOpenRender = core.rootToOpenRender;
	const { readNewestUntracked, getOnLogEntryDrop, invalidateBatchCache } = deps.host;
	const idToBatch = deps.batch.idToBatch;
	const getLiveBatchCount = deps.batch.getLiveBatchCount;
	const holds = new Set<AtomInternals>();
	const sealedLogs = new Set<AtomInternals>();

	/**
	 * The bounded-memory fold valve, run at retirement and render close (the
	 * two transitions that can make a chunk foldable: stamps land, pins
	 * lapse). A sealed prefix chunk folds into base and drops WHOLE when its
	 * entries are all retired (the prefix clause — an unretired earlier
	 * entry blocks everything after, because folding out of order would
	 * change replay results) and its newest stamp is at or below every live
	 * render pin (the pin clause — a render pinned earlier still folds from
	 * base, so base must not move past it). The fold replays the chunk's
	 * entries over base stepwise, exactly as a world fold would — replay
	 * fidelity, not an acceptance decision (the write path's equality gates
	 * already ran at each write).
	 */
	function foldSealedChunks(): void {
		if (sealedLogs.size === 0) return;
		const minPin = core.getMinLivePin();
		for (const atom of sealedLogs) {
			foldAtomSealedChunks(atom, minPin);
		}
	}

	function foldAtomSealedChunks(atom: AtomInternals, minPin: Seq): void {
		const log = atom.log;
		const chunks = log.chunks;
		const onDrop = getOnLogEntryDrop();
		while (chunks.length !== 0) {
			const ch = chunks[0]!;
			if (ch.n !== TAPE_CHUNK_ENTRIES) break; // tail chunk: never folds mid-episode (the close drops it)
			if (ch.unretired !== 0) break; // prefix clause
			if (ch.maxRetiredSeq > minPin) break; // pin clause
			for (let i = 0; i < ch.n; i++) {
				const next = applyOp(atom, ch.kinds[i]!, ch.payloads[i], atom.base);
				// Equality order: isEqual(current, incoming) — stepwise, per
				// replayed entry, as in every fold.
				if (!isAtomValueEqual(atom, atom.base, next)) atom.base = next;
				atom.baseSeq = ch.seqs[i]!;
				if (onDrop !== undefined) onDrop(atom, chunkEntryAt(ch, i));
			}
			chunks.shift(); // the chunk drops WHOLE (its packed arrays release together)
			log.length -= ch.n;
		}
		// The whole-log stamp max may have lived in a dropped chunk: recompute
		// over the survivors (few chunks; the valve itself is the rare path).
		let max = 0;
		for (let c = 0; c < chunks.length; c++) {
			if (chunks[c]!.maxRetiredSeq > max) max = chunks[c]!.maxRetiredSeq;
		}
		log.maxRetiredSeq = max;
		if (chunks.length === 0 || chunks[0]!.n !== TAPE_CHUNK_ENTRIES) sealedLogs.delete(atom);
		if (log.length === 0) {
			holds.delete(atom);
			// Reclamation retry trigger — the membership row clears at this
			// mid-episode emptying (edge-triggered: filed on the transition, so
			// the warm boundary path otherwise pays only the size-0 bail).
			if (reclaimSkippedN !== 0) noteReclaimRetry(atom.id);
		}
	}

	/**
	 * The episode close — runs at every retirement and render-close boundary;
	 * a no-op unless the episode just reached quiescence (every batch
	 * retired, parked actions included, and every render closed). Teardown
	 * order at the drop: durable handoff first (each held atom's base adopts
	 * kernel newest by identity and its log drops whole — worlds fold from
	 * base alone afterward, value-identically), then the episode references
	 * detach (membership sets clear; retired batch records and the write
	 * path's batch cache drop), then the wholesale reclamation retry sweep
	 * (the drop is the membership guard row's retry trigger). Committed-root
	 * routing structure is NOT episode-lifetime and survives untouched: a
	 * mounted watcher's dependency cone is current routing state, exactly as
	 * the committed arenas persist across quiescence.
	 */
	function maybeCloseEpisode(): void {
		if (getLiveBatchCount() !== 0 || rootToOpenRender.size !== 0) return;
		if (holds.size !== 0) {
			const onDrop = getOnLogEntryDrop();
			for (const atom of holds) {
				const log = atom.log;
				const chunks = log.chunks;
				if (onDrop !== undefined) {
					for (const ch of chunks) {
						for (let i = 0; i < ch.n; i++) onDrop(atom, chunkEntryAt(ch, i));
					}
				}
				// The durable handoff: with everything retired and no live pins,
				// fold(base, all entries) ≡ kernel newest (the eager-apply
				// invariant), so newest is adopted by identity — the one
				// equality-bearing decision per write already ran at the write.
				atom.base = readNewestUntracked(atom);
				const tail = chunks[chunks.length - 1]!;
				atom.baseSeq = tail.seqs[tail.n - 1]!;
				log.reset();
			}
			holds.clear();
			sealedLogs.clear();
		}
		// Batch bookkeeping is episode-lifetime: retired records drop in one
		// sweep (live records cannot exist here — the close's guard). The
		// write path's last-batch cache clears with each dropped id.
		for (const [id, t] of idToBatch) {
			if (t.state === 'retired') {
				idToBatch.delete(id);
				invalidateBatchCache(id);
			}
		}
		// The wholesale retry sweep at the boundary: every skipped reclaim
		// re-attempts (size-0 bail inside) — membership rows just cleared.
		reclaimRetryAllSkipped();
	}

	return { holds, sealedLogs, foldSealedChunks, maybeCloseEpisode };
}
