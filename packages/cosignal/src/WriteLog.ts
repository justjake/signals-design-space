/**
 * The per-atom WRITE LOG and its compaction. A WRITE-LOG ENTRY records one
 * write — {op, slot, seq}, with retiredSeq stamped at the batch's
 * retirement; entries live int-packed in per-atom `WriteLog` columns, and
 * COMPACTION folds the fully-retired, pin-clear prefix into the atom's base
 * so the log stays bounded (the full vocabulary is defined at the top of
 * concurrent.ts).
 *
 * Mechanism only: the batch-state edge of compaction — a compacted entry
 * stops pinning its batch record (the live-entry decrement and the reclaim
 * re-check) — is resident orchestration and comes in through
 * `deps.releaseLogEntry`; this module never imports batch state. The fold
 * machinery a compaction replays (`applyOp`, the atom's equality rule) and
 * the pin floor (`minLivePin`) come in through `deps` the same way.
 *
 * `createCompaction` is a factory in the kernel's own style (index.ts
 * `createEngine`): it closes over `uncompactedAtoms` (the compaction
 * candidates — atoms with a non-empty write log) and returns its operation
 * table; the set is exposed by identity so the engine's write path can keep
 * its one-branch membership add and the quiet derivation its size check.
 */

import { probes } from './engine.js';
import type { BatchId, BatchSlot } from './Batch.js';
import type { AtomNode, Seq, Value, WriteKind } from './concurrent.js';

/**
 * A log entry: one recorded write — {op, slot, seq} appended at the write,
 * retiredSeq stamped at the batch's retirement. Log entries denormalize their
 * slot at creation: slots are recycled identities, so visibility checks must read
 * the slot the write happened under, not the batch's current slot (which may
 * already be released); the batch id is carried for invariants and event
 * logs only. Log entries live int-packed in per-atom `WriteLog` columns ({kind,
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

/** Bounds the dead prefix a WriteLog carries before drop() rebases the arrays
 * (the rebase amortization threshold). */
const WRITE_LOG_REBASE_THRESHOLD = 1024;

/**
 * Int-packed log entry columns: recording a write is a few integer stores, not
 * an object allocation. Plain number arrays stay SMI-packed (V8's fast
 * small-integer array representation) and grow in place; the arrays
 * themselves are the pool — no per-entry objects ever exist on the hot
 * path. (`WriteKind` is concurrent.ts's const enum, imported type-only: its
 * hot comparison sites live there, and this module's one kind branch —
 * `opAt`, the materialized test/trace surface — compares the bare 0/1 codes
 * the two declarations share by construction.)
 */
export class WriteLog {
	/** Live window: entries [start, n). Compaction advances `start`; the
	 * arrays rebase (fresh packed slices) only when the dead prefix crosses
	 * the amortization threshold — never a per-retirement memmove
	 * (shrink-in-place cycling drops V8 arrays into dictionary mode, its
	 * slow hash-map representation; measured at ~10µs per drop). */
	start = 0;
	n = 0;
	kinds: WriteKind[] = [];
	slots: BatchSlot[] = [];
	seqs: Seq[] = [];
	/** 0 = unretired (sequences start at 1). */
	retired: Seq[] = [];
	batches: BatchId[] = [];
	payloads: unknown[] = [];

	get length(): number {
		return this.n - this.start;
	}

	push(kind: WriteKind, slot: BatchSlot, seq: Seq, batch: BatchId, payload: unknown): void {
		probes.logEntries++; // One Core probe (referee surface)
		this.kinds.push(kind);
		this.slots.push(slot);
		this.seqs.push(seq);
		this.retired.push(0);
		this.batches.push(batch);
		this.payloads.push(payload);
		this.n++;
	}

	opAt(i: number): WriteLogEntry['op'] {
		const k = this.kinds[i]!;
		if (k === 0 /* WriteKind.SET */) return { kind: 'set', value: this.payloads[i] };
		return { kind: 'update', fn: this.payloads[i] as (prev: Value) => Value };
	}

	entryAt(i: number): WriteLogEntry {
		const r = this.retired[i]!;
		return { op: this.opAt(i), batch: this.batches[i]!, slot: this.slots[i]!, seq: this.seqs[i]!, retiredSeq: r === 0 ? undefined : r };
	}

	materialize(): WriteLogEntry[] {
		const out: WriteLogEntry[] = [];
		for (let i = this.start; i < this.n; i++) out.push(this.entryAt(i));
		return out;
	}

	/** Drop the compacted prefix (advance the window; rebase amortized). */
	drop(cut: number): void {
		this.start += cut;
		if (this.start >= WRITE_LOG_REBASE_THRESHOLD && this.start >= this.n - this.start) {
			const from = this.start;
			this.kinds = this.kinds.slice(from);
			this.slots = this.slots.slice(from);
			this.seqs = this.seqs.slice(from);
			this.retired = this.retired.slice(from);
			this.batches = this.batches.slice(from);
			this.payloads = this.payloads.slice(from);
			this.n -= from;
			this.start = 0;
		} else if (this.start === this.n) {
			// Empty window: reset cheaply (length-0 keeps the packed kind).
			this.kinds.length = 0;
			this.slots.length = 0;
			this.seqs.length = 0;
			this.retired.length = 0;
			this.batches.length = 0;
			this.payloads.length = 0;
			this.n = 0;
			this.start = 0;
		}
	}
}

/** The resident-state edges compaction consumes (provided by the engine's
 * composition site; each is a thin arrow over engine state or orchestration). */
export type CompactionDeps = {
	/** The minimum live render pin (compaction's pin clause floor). */
	minLivePin(): Seq;
	/** Apply one op over `prev` under the fold-purity guards (concurrent.ts's
	 * one op-application rule). */
	applyOp(atom: AtomNode, kind: WriteKind, payload: unknown, prev: Value): Value;
	/** The atom's one equality rule (concurrent.ts's eqAtom). */
	eqAtom(atom: AtomNode, a: Value, b: Value): boolean;
	/** The optional compaction observer (the engine's public `onCompact` slot). */
	onCompact(): ((atom: AtomNode, entry: WriteLogEntry) => void) | undefined;
	/** The batch-state edge, resident orchestration (a compacted log entry
	 * stops pinning its batch record: live-entry decrement + reclaim
	 * re-check) — this module never imports batch state. */
	releaseLogEntry(batch: BatchId): void;
};

export type CompactionTable = {
	/** Atoms with a non-empty write log (compaction candidates — shared
	 * identity: the engine aliases it; see the module header). */
	uncompactedAtoms: Set<AtomNode>;
	compactAll(): void;
};

export function createCompaction(deps: CompactionDeps): CompactionTable {
	const uncompactedAtoms = new Set<AtomNode>();

	/**
	 * Compaction consumes a sequence-order prefix of the write log: entry e
	 * compacts iff every entry with seq ≤ e.seq is retired (folding out of
	 * order would change replay results) AND e.retiredSeq ≤ min(live pins)
	 * (a render pinned earlier still folds from base, so base must not move
	 * past it). Compacted entries fold into base and are reclaimed (kept in
	 * observed by the optional `onCompact` hook).
	 */
	function compactAll(): void {
		if (uncompactedAtoms.size === 0) return;
		const minPin = deps.minLivePin();
		for (const n of uncompactedAtoms) {
			compactAtom(n, minPin);
			if (n.log.n === n.log.start) uncompactedAtoms.delete(n);
		}
	}

	function compactAtom(atom: AtomNode, minPin: Seq): void {
		const log = atom.log;
		const n = log.n;
		const retired = log.retired;
		const from = log.start;
		let cut = 0;
		while (from + cut < n) {
			const r = retired[from + cut]!;
			if (r === 0) break; // prefix clause: an unretired earlier entry blocks everything after
			if (r > minPin) break; // pin clause: every live pin already sees e via the retired clause
			cut++;
		}
		if (cut === 0) return;
		const onCompact = deps.onCompact();
		for (let k = 0; k < cut; k++) {
			const i = from + k;
			const next = deps.applyOp(atom, log.kinds[i]!, log.payloads[i], atom.base);
			// R-2 order: isEqual(current, incoming) — per compacted entry
			// (compaction re-invokes per entry BY DESIGN).
			if (!deps.eqAtom(atom, atom.base, next)) atom.base = next;
			atom.baseSeq = log.seqs[i]!;
			if (onCompact !== undefined) onCompact(atom, log.entryAt(i));
			// A compacted log entry stops pinning its batch record.
			deps.releaseLogEntry(log.batches[i]!);
		}
		log.drop(cut);
	}

	return { uncompactedAtoms, compactAll };
}
