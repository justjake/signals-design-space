/**
 * The per-atom WRITE LOG and the EPISODE LIFECYCLE — the deliberately simple
 * storage: each recorded write is one plain object in one per-atom array
 * that only ever pushes, and every removal is wholesale (the episode close
 * drops the array; the bounded-memory valve slices one prefix). No chunks,
 * no pooling, no packed columns, no index math — one allocation per logged
 * write, and the garbage collector reclaims dropped history.
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
 *    (immutable while the episode runs, except by the log's own valve folds
 *    below) plus its entries; every world folds from that base.
 *  - DURABLE HANDOFF at the close: with every batch retired and every render
 *    closed, each world's fold over the whole log equals the kernel's newest
 *    value (the eager-apply invariant, referee-verified), so the close
 *    adopts kernel newest as the new base BY IDENTITY — zero op replays,
 *    zero equality re-invocations — and the log drops whole. Retired batch
 *    records drop in the same sweep (write records reference batches by id,
 *    so the records outlive the entries by construction).
 *  - BOUNDED MEMORY under held-open episodes (a parked action can hold an
 *    episode open indefinitely while writes keep landing, so the array must
 *    not grow unchecked): when a log's fully-retired-and-unpinned PREFIX
 *    reaches FOLD_VALVE_THRESHOLD entries, the valve folds that prefix into
 *    base and removes it with one splice. The valve is kept — not dropped —
 *    because nothing else bounds a held-open episode's log; the threshold
 *    keeps the fold rare, and each atom's foldable residue stays below one
 *    threshold's worth of entries.
 *
 * `createEpisodeLifecycle` is a factory in the kernel's own style (index.ts
 * `createKernel`): it closes over `holds` (the episode's touched-atom
 * membership — atoms whose write log holds entries) and `foldCandidates`
 * (the valve's candidates) and returns its operation table; both sets are
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
 * A log entry's materialized face — the test/trace surface (`materialize()`,
 * the trace `logEntry` hook, the `onLogEntryDrop` observer). The stored
 * record keeps the scalar (kind, payload) pair the write path carries; the
 * object-shaped `op` (a write operation: set/update; a ReducerAtom dispatch
 * records as an update whose closure captures the reducer and the action)
 * is built only when one of those surfaces asks.
 */
export type WriteLogEntry = {
	op: { kind: 'set'; value: Value } | { kind: 'update'; fn: (prev: Value) => Value };
	batch: BatchId;
	slot: BatchSlot;
	seq: Seq;
	retiredSeq: Seq | undefined;
};

/**
 * One stored write record — a plain object per logged write. `kind`/`payload`
 * are the scalar op pair (a SET's payload is the value; an UPDATE's is the
 * updater); `retiredSeq` starts undefined and is stamped by the batch's
 * retirement. The record denormalizes its slot at creation: slots are
 * recycled identities, so visibility checks must read the slot the write
 * happened under, not the batch's current slot (which may already be
 * released); the batch id is carried for retirement stamping, invariants,
 * and event logs.
 */
export type WriteRecord = {
	kind: WriteKind;
	payload: unknown;
	batch: BatchId;
	slot: BatchSlot;
	seq: Seq;
	retiredSeq: Seq | undefined;
};

/**
 * The bounded-memory valve's trigger: how many foldable prefix entries a
 * log accumulates before the valve folds that prefix into base (the same
 * magnitude as the chunked design's chunk capacity, so the per-atom residue
 * bound is unchanged). The write path files an atom with the valve's
 * candidate set when its log reaches exactly this length — see the
 * candidate-set invariant on `EpisodeLifecycle.foldCandidates`.
 */
export const FOLD_VALVE_THRESHOLD = 1024;

/** Build the materialized face of one stored record (see WriteLogEntry).
 * (`WriteKind` is concurrent.ts's const enum, imported type-only: this one
 * kind branch compares the bare 0/1 codes the two declarations share by
 * construction.) */
function materializeRecord(e: WriteRecord): WriteLogEntry {
	const op: WriteLogEntry['op'] =
		e.kind === 0 /* WriteKind.SET */
			? { kind: 'set', value: e.payload }
			: { kind: 'update', fn: e.payload as (prev: Value) => Value };
	return { op, batch: e.batch, slot: e.slot, seq: e.seq, retiredSeq: e.retiredSeq };
}

/**
 * The per-atom write log: one plain array of stored records, oldest first,
 * always in sequence order (the log only ever appends, and the valve
 * removes only whole prefixes). Empty for the quiet population.
 */
export class WriteLog {
	/** Live entries, oldest first (sequence order). */
	entries: WriteRecord[] = [];
	/** Live entries not yet retirement-stamped (the write path's
	 * retired-history drop arm reads it; Batch.ts decrements at stamping). */
	unretired = 0;
	/** The newest retirement stamp over LIVE entries (stamps are monotone,
	 * so plain assignment at each stamping maintains it; recomputed when a
	 * valve fold removes a prefix that may have carried the max). */
	maxRetiredSeq: Seq = 0;

	/** Live entry count (the write path's membership branches and the
	 * reclaim/quiet consumers read it). */
	get length(): number {
		return this.entries.length;
	}

	push(kind: WriteKind, slot: BatchSlot, seq: Seq, batch: BatchId, payload: unknown): void {
		probes.logEntries++; // engine-activity counter (tests/one-core.spec.ts's zero-cost check)
		this.entries.push({ kind, payload, batch, slot, seq, retiredSeq: undefined });
		this.unretired++;
	}

	/** The just-appended entry, materialized (the trace `logEntry` hook's one
	 * consumer — tracer-attached only). */
	tailEntry(): WriteLogEntry {
		return materializeRecord(this.entries[this.entries.length - 1]!);
	}

	materialize(): WriteLogEntry[] {
		return this.entries.map(materializeRecord);
	}

	/** Drop every entry (the episode close's durable handoff — base has just
	 * adopted the folded result, so the history is redundant). Object identity
	 * is preserved: holders of the log keep a valid, empty log. */
	reset(): void {
		this.entries = [];
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
	 * atom's one equality rule (valve folds replay stepwise, exactly like a
	 * world fold), and the open-render table (the close's every-world-closed
	 * clause). */
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
	/** The fold valve's candidates. Invariant: every atom whose log holds at
	 * least FOLD_VALVE_THRESHOLD entries is a member — the write path files
	 * an atom when its log reaches exactly the threshold (length grows by
	 * one per push, so every crossing passes through equality), the valve
	 * removes one only when its log is back under the threshold, and the
	 * episode close clears the set with the logs. Empty in every episode
	 * whose logs stay under the threshold, which keeps the valve one size
	 * check at each boundary. */
	foldCandidates: Set<AtomInternals>;
	runFoldValve(): void;
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
	const foldCandidates = new Set<AtomInternals>();

	/**
	 * The bounded-memory fold valve, run at retirement and render close (the
	 * two transitions that can make a prefix foldable: stamps land, pins
	 * lapse). A size check unless a candidate exists; see foldRetiredPrefix
	 * for the per-atom rule.
	 */
	function runFoldValve(): void {
		if (foldCandidates.size === 0) return;
		const minPin = core.getMinLivePin();
		for (const atom of foldCandidates) {
			foldRetiredPrefix(atom, minPin);
		}
	}

	/**
	 * Fold one atom's foldable prefix into base once it reaches the
	 * threshold. The foldable prefix is the run of entries that are retired
	 * (the prefix clause — an unretired entry blocks everything after it,
	 * because folding out of order would change replay results) with stamps
	 * at or below every live render pin (the pin clause — a render pinned
	 * earlier still folds from base, so base must not move past it). The
	 * fold replays the prefix over base stepwise, exactly as a world fold
	 * would — replay fidelity, not an acceptance decision (the write path's
	 * equality gates already ran at each write) — then removes it with one
	 * splice. A candidate blocked below the threshold re-walks its foldable
	 * prefix at each boundary until it folds; the walk is O(1) when the head
	 * entry itself is blocked.
	 */
	function foldRetiredPrefix(atom: AtomInternals, minPin: Seq): void {
		const log = atom.log;
		const entries = log.entries;
		let n = 0;
		while (n < entries.length) {
			const r = entries[n]!.retiredSeq;
			if (r === undefined || r > minPin) break;
			n++;
		}
		if (n >= FOLD_VALVE_THRESHOLD) {
			const onDrop = getOnLogEntryDrop();
			for (let i = 0; i < n; i++) {
				const e = entries[i]!;
				const next = applyOp(atom, e.kind, e.payload, atom.base);
				// Equality order: isEqual(current, incoming) — stepwise, per
				// replayed entry, as in every fold.
				if (!isAtomValueEqual(atom, atom.base, next)) atom.base = next;
				atom.baseSeq = e.seq;
				if (onDrop !== undefined) onDrop(atom, materializeRecord(e));
			}
			entries.splice(0, n); // the folded prefix drops in one splice
			// The whole-log stamp max may have lived in the folded prefix:
			// recompute over the survivors (the valve itself is the rare path).
			let max: Seq = 0;
			for (let i = 0; i < entries.length; i++) {
				const r = entries[i]!.retiredSeq;
				if (r !== undefined && r > max) max = r;
			}
			log.maxRetiredSeq = max;
		}
		if (entries.length < FOLD_VALVE_THRESHOLD) foldCandidates.delete(atom);
		if (entries.length === 0) {
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
				const entries = log.entries;
				if (onDrop !== undefined) {
					for (let i = 0; i < entries.length; i++) onDrop(atom, materializeRecord(entries[i]!));
				}
				// The durable handoff: with everything retired and no live pins,
				// fold(base, all entries) ≡ kernel newest (the eager-apply
				// invariant), so newest is adopted by identity — the one
				// equality-bearing decision per write already ran at the write.
				atom.base = readNewestUntracked(atom);
				atom.baseSeq = entries[entries.length - 1]!.seq;
				log.reset();
			}
			holds.clear();
			foldCandidates.clear();
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

	return { holds, foldCandidates, runFoldValve, maybeCloseEpisode };
}
