/**
 * Worlds: speculative state for concurrent React, layered over the canonical
 * graph in core.ts.
 *
 * A write issued inside a transition never touches canonical state. It is
 * recorded in a Batch as a *write intent* — either a value or a function of
 * the previous value. A render pass pins a Snapshot: the canonical world at a
 * fixed epoch plus the ordered batches that pass is rendering. Reading an
 * atom through a snapshot replays its intents onto the pinned base; reading a
 * computed evaluates it inside the snapshot with per-snapshot memoization, so
 * every component in one pass sees one self-consistent world.
 *
 * Commit is a fold: when React retires a batch, each touched atom folds its
 * intents onto the *current* canonical value and writes the result. Because
 * function intents re-execute against that fresh base, a transition that
 * doubled a counter lands doubled on top of any urgent writes that committed
 * meanwhile — the rebase is the replay.
 */
import {
	Atom,
	Computed,
	type Epoch,
	type ReadRedirect,
	type SourceNode,
	UNSET,
	currentCause,
	currentEpoch,
	emitTrace,
	endBatch,
	isThenable,
	releasePin,
	retainPin,
	setCurrentCause,
	setReadRedirect,
	startBatch,
} from './core.ts';

/** Identity of a transition batch; the React bindings map fork batch tokens
 * onto these. */
export type BatchId = number;

export type WriteIntent =
	| { kind: 'set'; value: unknown }
	| { kind: 'fn'; fn: (prev: unknown) => unknown };

export type BatchStatus = 'open' | 'committed' | 'discarded';

let nextBatchId: BatchId = 1;

export class Batch {
	id: BatchId = nextBatchId++;
	status: BatchStatus = 'open';
	/** Atoms this batch wrote (the intents live in per-atom rebase logs). */
	touched = new Set<Atom<unknown>>();
	/** Trace event that opened the batch (causal parent for its writes). */
	traceId: number | undefined;

	record(atom: Atom<unknown>, op: WriteIntent): void {
		this.touched.add(atom);
		logEntry(atom, op, this);
		notifyDraftListeners(atom, this);
	}
}

/**
 * Per-atom rebase log: React updater-queue arithmetic. While any transition
 * batch holds intents for an atom, EVERY write to it — urgent or transition
 * — appends here in call order. A world's value for the atom replays the log
 * from the episode's base, keeping the entries whose owner that world can
 * see (urgent entries plus its own batches). Retirement replays urgent +
 * retired-batch entries and installs the result canonically, so a transition
 * that added 2 under an urgent doubling lands as (base+2)*2 — replay, never
 * reorder.
 */
interface RebaseEntry {
	op: WriteIntent;
	/** null = urgent (canonically applied when recorded). */
	owner: Batch | null;
	/** Epoch when recorded; snapshots exclude urgent entries newer than
	 * their pin. */
	epoch: Epoch;
}
interface RebaseLog {
	base: unknown;
	baseEpoch: Epoch;
	entries: RebaseEntry[];
}
const rebaseLogs = new Map<Atom<unknown>, RebaseLog>();

function logEntry(atom: Atom<unknown>, op: WriteIntent, owner: Batch | null): void {
	let log = rebaseLogs.get(atom);
	if (log === undefined) {
		log = { base: atom.peek(), baseEpoch: currentEpoch(), entries: [] };
		rebaseLogs.set(atom, log);
	}
	log.entries.push({ op, owner, epoch: currentEpoch() });
}

/** Replay the log for the world that sees `batches` (plus urgent entries at
 * or before `atEpoch`). */
function replayLog(
	log: RebaseLog,
	batches: readonly Batch[] | 'committed',
	atEpoch: Epoch,
): unknown {
	let v = log.base;
	for (const e of log.entries) {
		let visible: boolean;
		if (e.owner === null) {
			visible = e.epoch <= atEpoch;
		} else if (batches === 'committed') {
			visible = e.owner.status === 'committed';
		} else {
			// A world sees retired batches (already canonical) plus its own
			// open batches, in one call-order replay.
			visible =
				e.owner.status === 'committed' ||
				(e.owner.status === 'open' && batches.includes(e.owner));
		}
		if (!visible) continue;
		v = e.op.kind === 'set' ? e.op.value : e.op.fn(v);
	}
	return v;
}

/** Drop a log once no open batch still owns entries in it. */
function pruneLog(atom: Atom<unknown>): void {
	const log = rebaseLogs.get(atom);
	if (log === undefined) return;
	if (log.entries.some((e) => e.owner !== null && e.owner.status === 'open')) return;
	rebaseLogs.delete(atom);
}

/** True when a rebase episode is live for this atom. */
export function hasRebaseLog(atom: Atom<unknown>): boolean {
	return rebaseLogs.has(atom);
}

const openBatches: Batch[] = [];

export function openBatch(): Batch {
	const b = new Batch();
	openBatches.push(b);
	if (emitTrace !== null) {
		b.traceId = emitTrace('batch-open', currentCause, { batch: b.id });
	}
	return b;
}

export function listOpenBatches(): readonly Batch[] {
	return openBatches;
}

function dropOpen(b: Batch): void {
	const i = openBatches.indexOf(b);
	if (i >= 0) openBatches.splice(i, 1);
}

/** Retire a batch canonically: fold every touched atom onto the current
 * canonical base inside one flush scope. */
export function commitBatch(b: Batch): void {
	if (b.status !== 'open') return;
	b.status = 'committed';
	dropOpen(b);
	const prevCause = setCurrentCause(
		emitTrace !== null ? emitTrace('batch-commit', b.traceId, { batch: b.id }) : undefined,
	);
	startBatch();
	try {
		for (const atom of b.touched) {
			const log = rebaseLogs.get(atom);
			if (log !== undefined) {
				atom.set(replayLog(log, 'committed', currentEpoch()));
			}
			pruneLog(atom);
		}
	} finally {
		endBatch();
		setCurrentCause(prevCause);
	}
}

/** Abandon a batch: nothing canonical happened, but anyone who rendered its
 * drafts must hear about the rollback. */
export function discardBatch(b: Batch): void {
	if (b.status !== 'open') return;
	b.status = 'discarded';
	dropOpen(b);
	if (emitTrace !== null) emitTrace('batch-discard', b.traceId, { batch: b.id });
	for (const atom of b.touched) {
		const log = rebaseLogs.get(atom);
		if (log !== undefined) {
			log.entries = log.entries.filter((e) => e.owner !== b);
		}
		pruneLog(atom);
		notifyDraftListeners(atom, b);
	}
}

// ---------------------------------------------------------------------------
// Ambient batch (write classification)

let ambientBatch: Batch | null = null;

export function currentAmbientBatch(): Batch | null {
	return ambientBatch;
}

/** Run `fn` with writes classified into `batch` (a transition scope). */
export function withAmbientBatch<T>(batch: Batch | null, fn: () => T): T {
	const prev = ambientBatch;
	ambientBatch = batch;
	try {
		return fn();
	} finally {
		ambientBatch = prev;
	}
}

/** Classified write: urgent writes hit canonical state now; transition writes
 * are recorded as intents in the ambient batch. */
export function write<T>(atom: Atom<T>, v: T): void {
	if (ambientBatch !== null && ambientBatch.status === 'open') {
		ambientBatch.record(atom as Atom<unknown>, { kind: 'set', value: v });
	} else {
		if (rebaseLogs.has(atom as Atom<unknown>)) {
			logEntry(atom as Atom<unknown>, { kind: 'set', value: v }, null);
		}
		atom.set(v);
	}
}

/** Functional update that replays: in a transition the function is stored and
 * re-executes against whatever base the batch finally folds onto. */
export function update<T>(atom: Atom<T>, fn: (prev: T) => T): void {
	if (ambientBatch !== null && ambientBatch.status === 'open') {
		ambientBatch.record(atom as Atom<unknown>, { kind: 'fn', fn: fn as (p: unknown) => unknown });
	} else {
		if (rebaseLogs.has(atom as Atom<unknown>)) {
			logEntry(atom as Atom<unknown>, { kind: 'fn', fn: fn as (p: unknown) => unknown }, null);
		}
		atom.set(fn(atom.peek()));
	}
}

// ---------------------------------------------------------------------------
// Draft listeners (bindings subscribe to hear about speculative writes and
// rollbacks; effects never do)

type DraftListener = (atom: Atom<unknown>, batch: Batch) => void;
const draftListeners = new Set<DraftListener>();

export function onDraftWrite(listener: DraftListener): () => void {
	draftListeners.add(listener);
	return () => draftListeners.delete(listener);
}

function notifyDraftListeners(atom: Atom<unknown>, batch: Batch): void {
	draftListeners.forEach((l) => l(atom, batch));
}

// ---------------------------------------------------------------------------
// Snapshots

interface ComputedMemo {
	value: unknown;
	error: unknown;
	pending: PromiseLike<unknown> | null;
	hasError: boolean;
}

export class Snapshot implements ReadRedirect {
	epoch: Epoch;
	batches: readonly Batch[];
	/** True when rendering a deferred (transition) pass: pending computeds
	 * hand the thenable to React instead of serving stale history. */
	deferred: boolean;
	atomCache = new Map<Atom<unknown>, unknown>();
	memo = new Map<Computed<unknown>, ComputedMemo>();
	pinned = false;

	constructor(batches: readonly Batch[], deferred: boolean, epoch: Epoch = currentEpoch()) {
		this.epoch = epoch;
		this.batches = batches;
		this.deferred = deferred;
	}

	/** Hold canonical history so this snapshot stays readable across writes
	 * (a render pass pins at start, releases at commit/discard). */
	pin(): void {
		if (this.pinned) return;
		this.pinned = true;
		retainPin();
	}
	release(): void {
		if (!this.pinned) return;
		this.pinned = false;
		releasePin();
	}

	hasDrafts(): boolean {
		for (const b of this.batches) {
			if (b.status === 'open' && b.touched.size > 0) return true;
		}
		return false;
	}

	readAtom<T>(a: Atom<T>): T {
		const cached = this.atomCache.get(a as Atom<unknown>);
		if (cached !== undefined || this.atomCache.has(a as Atom<unknown>)) return cached as T;
		let v: unknown;
		const log = rebaseLogs.get(a as Atom<unknown>);
		let sawDraft = false;
		if (log !== undefined) {
			for (const b of this.batches) {
				if (b.status === 'open' && b.touched.has(a as Atom<unknown>)) {
					sawDraft = true;
					break;
				}
			}
		}
		if (log !== undefined && sawDraft) {
			v = replayLog(log, this.batches, this.epoch);
		} else {
			v = a.valueAt(this.epoch);
		}
		this.atomCache.set(a as Atom<unknown>, v);
		return v as T;
	}

	readComputed<T>(c: Computed<T>): T {
		const entry = this.evaluate(c as Computed<unknown>);
		if (entry.hasError) throw entry.error;
		if (entry.pending !== null) {
			// Two-level suspend-vs-stale: a transition pass hands React the
			// thenable (the transition holds); an urgent pass serves settled
			// history when there is any; a never-settled value suspends anywhere.
			if (!this.deferred && c.settled !== UNSET) return c.settled as T;
			throw entry.pending;
		}
		return entry.value as T;
	}

	/** Evaluate `c` inside this snapshot, memoized per snapshot. Snapshot
	 * evaluations never touch the canonical cache or dependency links. */
	evaluate(c: Computed<unknown>): ComputedMemo {
		let entry = this.memo.get(c);
		if (entry !== undefined) return entry;
		// A draft-free snapshot at the current epoch is the canonical world;
		// serve from the canonical cache instead of re-deriving.
		if (!this.hasDrafts() && this.epoch === currentEpoch()) {
			const prev = setReadRedirect(null);
			try {
				entry = { value: undefined, error: undefined, pending: null, hasError: false };
				try {
					c.ensure();
					if (c.errorBox !== null) {
						entry.hasError = true;
						entry.error = c.errorBox.error;
					} else if (c.pending !== null) {
						entry.pending = c.pending.promise;
					} else {
						entry.value = c.value;
					}
				} catch (e) {
					entry.hasError = true;
					entry.error = e;
				}
			} finally {
				setReadRedirect(prev);
			}
			this.memo.set(c, entry);
			return entry;
		}
		const prev = setReadRedirect(this);
		entry = { value: undefined, error: undefined, pending: null, hasError: false };
		// Memoize before running: a cycle through this snapshot would otherwise
		// recurse forever. A cycle read sees the placeholder and errors below.
		this.memo.set(c, entry);
		try {
			entry.value = c.fn(snapshotUseThenable(this));
		} catch (e) {
			if (isThenable(e)) entry.pending = e;
			else {
				entry.hasError = true;
				entry.error = e;
			}
		} finally {
			setReadRedirect(prev);
		}
		return entry;
	}
}

/** async.ts installs the snapshot-scoped `use`; default parks on the raw
 * thenable. */
let snapshotUseThenable: (s: Snapshot) => <U>(t: PromiseLike<U>) => U = () => {
	return <U>(t: PromiseLike<U>): U => {
		throw t;
	};
};
export function setSnapshotUseThenable(fn: typeof snapshotUseThenable): void {
	snapshotUseThenable = fn;
}

/** Run `fn` reading through `snapshot` (render passes, latest()). */
export function withSnapshot<T>(snapshot: Snapshot | null, fn: () => T): T {
	const prev = setReadRedirect(snapshot);
	try {
		return fn();
	} finally {
		setReadRedirect(prev);
	}
}

// ---------------------------------------------------------------------------
// The read family

export type Readable<T> = Atom<T> | Computed<T>;

/** Canonical read outside any snapshot: committed state plus applied urgent
 * writes; drafts hidden. */
export function readCanonical<T>(x: Readable<T>): T {
	return withSnapshot(null, () => (x instanceof Atom ? x.peek() : x.peek()));
}

/** Newest intent, including open transition drafts. Inside a computed
 * evaluation or render pass it resolves that context's own world (reading
 * ahead of your world would be a tear). Never suspends: a never-settled
 * pending value reads as undefined. */
export function latest<T>(x: Readable<T>): T | undefined {
	const active = currentRedirect();
	const snapshot = active ?? new Snapshot(openBatches.slice(), false);
	try {
		if (x instanceof Atom) return snapshot.readAtom(x);
		const entry = snapshot.evaluate(x as Computed<unknown>);
		if (entry.hasError) throw entry.error;
		if (entry.pending !== null) {
			return x.settled === UNSET ? undefined : (x.settled as T);
		}
		return entry.value as T;
	} finally {
		// Ephemeral snapshots hold no pins and are dropped here.
	}
}

import { readRedirect } from './core.ts';
function currentRedirect(): Snapshot | null {
	return readRedirect instanceof Snapshot ? readRedirect : null;
}

/** Per-root committed views: bindings record the canonical epoch each root
 * last committed at; a root's view of an atom is the canonical value as of
 * that epoch (exact while any render pass pins history — a root can only lag
 * canonical while another root's pass is in flight — and identical to
 * canonical at quiescence). */
export type CommittedViewLookup = (container: unknown) => Epoch | null;
let committedViewLookup: CommittedViewLookup = () => null;
export function setCommittedViewLookup(fn: CommittedViewLookup): void {
	committedViewLookup = fn;
}

export function committed<T>(x: Readable<T>, container?: unknown): T | undefined {
	if (container !== undefined) {
		const epochAt = committedViewLookup(container);
		if (epochAt !== null && x instanceof Atom) {
			return x.valueAt(epochAt);
		}
	}
	if (x instanceof Atom) return x.peek();
	const c = x as Computed<T>;
	c.ensure();
	if (c.pending !== null || c.errorBox !== null) {
		return c.settled === UNSET ? undefined : (c.settled as T);
	}
	return c.value as T;
}

/** Cheap flip-only probe: true while newer data loads behind stale — an open
 * batch touches the value, or an async recompute is in flight. Never
 * refetches, never suspends. */
export function isPending<T>(x: Readable<T>): boolean {
	if (x instanceof Atom) return anyOpenBatchTouches(x as Atom<unknown>);
	const c = x as Computed<unknown>;
	if (c.pending !== null) return true;
	// Probe transitively through the recorded dependency sets without forcing
	// a recompute.
	const seen = new Set<SourceNode>();
	const stack: SourceNode[] = [c];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (seen.has(node)) continue;
		seen.add(node);
		if (node instanceof Atom) {
			if (anyOpenBatchTouches(node)) return true;
		} else {
			if (node.pending !== null) return true;
			for (const d of node.deps) stack.push(d);
		}
	}
	return false;
}

function anyOpenBatchTouches(a: Atom<unknown>): boolean {
	for (const b of openBatches) {
		if (b.status === 'open' && b.touched.has(a)) return true;
	}
	return false;
}

/** Force a refetch with unchanged inputs. The stale value keeps serving while
 * the new evaluation loads; inside a transition the refetch belongs to that
 * transition's batch. */
export function refresh<T>(x: Readable<T>): void {
	if (x instanceof Atom) return;
	const c = x as Computed<unknown>;
	c.refreshVersion++;
	startBatch();
	try {
		c.markStale();
		// Kick the re-evaluation now so fetches start immediately rather than
		// at the next read.
		c.ensure();
	} finally {
		endBatch();
	}
}
