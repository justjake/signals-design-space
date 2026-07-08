/**
 * The concurrent engine: atoms, computed values, batches (draft overlays for
 * pending React transitions), worlds (a base plus an ordered set of
 * batches), the five-member read family, async evaluation, per-root
 * committed views, lifetime observation, and SSR state install.
 *
 * Layering: graph.ts owns canonical reactivity (dependency edges, equality
 * cutoff, effect scheduling). This module owns everything concurrent. A
 * draft write never touches canonical caches — it appends an operation to
 * its batch and wakes subscribers; readers fold batch operations over the
 * canonical base on demand. Batch retirement replays the operations as
 * ordinary canonical writes, which is what makes rebase arithmetic hold:
 * a transition's functional updates re-execute against the canonical value
 * at retirement time, urgent writes included.
 */
import {
	type AtomNode,
	type ComputedNode,
	type EffectNode,
	type Equality,
	type ReactiveNode,
	NodeKind,
	batch as graphBatch,
	canonicalAtomValue,
	collectWatchers,
	createAtomNode,
	createComputedNode,
	createEffect,
	createScope,
	disposeEffect,
	getActiveSub,
	graphQuiescent,
	invalidateComputed,
	readAtom,
	readComputed,
	setActiveSub,
	startBatch,
	endBatch,
	untracked,
	worldHooks,
	writeAtom,
} from './graph';
import { ambientCause, emit, tracing, withCause } from './tracer';

// ---------------------------------------------------------------------------
// Public handle types (opaque brands over internal records).
// ---------------------------------------------------------------------------

declare const valueBrand: unique symbol;
export interface Atom<T> {
	readonly [valueBrand]?: ['atom', T];
}
export interface Computed<T> {
	readonly [valueBrand]?: ['computed', T];
}
export type Readable<T> = Atom<T> | Computed<T>;

/** Reads a settled thenable's value inside a computed; an unresolved
 * thenable registers for settlement and poisons the evaluation to pending.
 * The two-argument form keys an engine-cached thenable factory so the
 * factory runs once per key per evaluation lineage. */
export interface Use {
	<U>(thenable: PromiseLike<U>): U;
	<U>(key: string | number, factory: () => PromiseLike<U>): U;
}

export interface AtomOptions<T> {
	equals?: (a: T, b: T) => boolean;
	label?: string;
	/** Lifetime effect: runs when the atom gains its first subscriber of any
	 * kind; the returned cleanup runs when the last subscriber is gone.
	 * Observe/unobserve flaps within a tick coalesce (microtask debounce). */
	effect?: (ctx: { get(): T; set(v: T): void }) => void | (() => void);
}

export interface ComputedOptions<T> {
	equals?: (a: T, b: T) => boolean;
	label?: string;
}

const defaultEquals: Equality = (a, b) => Object.is(a, b);

type BatchId = number;
type Epoch = number;
type RecId = number;

type Op = { set: unknown; update?: undefined } | { update: (prev: unknown) => unknown; set?: undefined };

interface AtomRec {
	t: 0;
	id: RecId;
	node: AtomNode;
	label: string | undefined;
	/** Lazy initializer; cleared once run. */
	init: (() => unknown) | undefined;
	observed: ((ctx: { get(): unknown; set(v: unknown): void }) => void | (() => void)) | undefined;
	/** Active observation cleanup, when the lifetime effect has run. */
	obsCleanup: (() => void) | void | undefined;
	obsActive: boolean;
	obsScheduled: boolean;
	/** Subscription refcounts per root view (drives pre-image capture). */
	subRoots: Map<RootView, number> | undefined;
}

interface ComputedRec {
	t: 1;
	id: RecId;
	node: ComputedNode;
	userFn: (use: Use) => unknown;
	equals: Equality;
	label: string | undefined;
	/** Stable pending sentinel for this node (reference-stable across
	 * evaluations so pending-to-pending never counts as a change). */
	pendingBox: PendingBox | undefined;
	lastSettled: unknown;
	hasSettled: boolean;
	canonicalEntry: AsyncEntry | undefined;
	/** Set by settlement so the triggered re-evaluation keeps its slots. */
	reuseEntry: AsyncEntry | undefined;
	/** In-flight refresh: the stale value keeps serving until this settles. */
	refreshing: AsyncEntry | undefined;
}

type Rec = AtomRec | ComputedRec;

/** The reference-stable value a pending async computed evaluates to. */
export interface PendingBox {
	readonly pending: true;
	/** The owning computed's id (diagnostics only). */
	readonly of: RecId;
}

export function isPendingValue(v: unknown): v is PendingBox {
	return typeof v === 'object' && v !== null && (v as PendingBox).pending === true && typeof (v as PendingBox).of === 'number';
}

/** The reference-stable box an async rejection becomes; read sites throw it. */
export class AsyncError extends Error {
	readonly reason: unknown;
	constructor(reason: unknown) {
		super(`async computed rejected: ${String(reason)}`);
		this.reason = reason;
	}
}

interface Slot {
	key: unknown; // user key or the thenable itself
	thenable: PromiseLike<unknown>;
	status: 0 | 1 | 2; // pending | fulfilled | rejected
	value: unknown;
	errorBox: AsyncError | undefined;
	/** Sweep mark: evaluations stamp slots they touched. */
	stamp: number;
	/** Entries sharing this slot (seeding shares settled and in-flight
	 * fetches across worlds); settlement notifies each. */
	owners: Set<AsyncEntry>;
}

interface AsyncEntry {
	rec: ComputedRec;
	slots: Map<unknown, Slot>;
	/** null = canonical; otherwise the owning world cache. Promotion at batch
	 * retirement re-parents a draft entry to canonical. */
	world: WorldCache | null;
	/** Refresh entries settle into the node instead of replacing it live. */
	refresh: boolean;
	/** Retry promise for the current pending generation (what React awaits). */
	retry: Promise<void> | null;
	resolveRetry: (() => void) | null;
	/** Nested computeds whose pending state this entry's last evaluation
	 * forwarded; their settlement is this entry's progress too. */
	pendingInner: ComputedRec[];
	evalStamp: number;
	dead: boolean;
}

function bumpPending(): void {
	pendingEpochCounter++;
	for (const cb of pendingListeners) {
		cb();
	}
}

const pendingListeners = new Set<() => void>();

/** Notifies whenever pending-ness may have flipped anywhere (batch
 * lifecycle, settlement, refresh) — the isPending probe's wake-up. */
export function onPendingFlip(cb: () => void): () => void {
	pendingListeners.add(cb);
	return () => {
		pendingListeners.delete(cb);
	};
}

let nextRecId = 1;
let evalStampCounter = 1;

/** Bumped on every canonical change; world caches fingerprint against it. */
let graphEpoch: Epoch = 1;
/** Bumped whenever pending-ness may have flipped anywhere (batch lifecycle,
 * settlement, refresh); cheap probe for isPending subscribers. */
let pendingEpochCounter = 0;

export function currentPendingEpoch(): number {
	return pendingEpochCounter;
}
export function currentGraphEpoch(): Epoch {
	return graphEpoch;
}

// ---------------------------------------------------------------------------
// Host seams: the React bindings (or any host) install these.
// ---------------------------------------------------------------------------

export interface HostSeams {
	/** Classify a write: return the draft batch that owns it, or null for
	 * canonical (urgent). Consulted on every set/update/refresh. */
	classify: (() => Batch | null) | null;
	/** Throw to reject a write in a forbidden context (render phase). */
	assertCanWrite: (() => void) | null;
	/** The ambient world of the current render pass, if one is on the stack:
	 * top-level reads inside a render resolve this world. */
	renderWorld: (() => Batch[] | null) | null;
}

export const host: HostSeams = { classify: null, assertCanWrite: null, renderWorld: null };

// ---------------------------------------------------------------------------
// Batches: draft overlays owning classified writes.
// ---------------------------------------------------------------------------

export interface Batch {
	id: BatchId;
	/** Host key (a React lane); unique among open batches. */
	key: unknown;
	ops: Map<AtomRec, Op[]>;
	refreshes: Set<ComputedRec>;
	version: number;
	open: boolean;
	/** Watcher subscriptions that saw a draft delivery from this batch;
	 * discard re-notifies them. */
	deliveredTo: Set<SubscriptionRec>;
}

let nextBatchId = 1;
const openBatchesByKey = new Map<unknown, Batch>();

export function openBatch(key?: unknown): Batch {
	const id = nextBatchId++;
	const b: Batch = {
		id,
		key: key ?? id,
		ops: new Map(),
		refreshes: new Set(),
		version: 0,
		open: true,
		deliveredTo: new Set(),
	};
	openBatchesByKey.set(b.key, b);
	bumpPending();
	if (tracing()) {
		emit('batch-open', { batch: id, key: String(b.key) });
	}
	return b;
}

/** The open batch for a host key, creating one on first use. */
export function batchForKey(key: unknown): Batch {
	return openBatchesByKey.get(key) ?? openBatch(key);
}

export function openBatchForKey(key: unknown): Batch | undefined {
	return openBatchesByKey.get(key);
}

export function openBatches(): Batch[] {
	return [...openBatchesByKey.values()];
}

/**
 * Retires a batch: replays its operations as canonical writes (in creation
 * order), applies its refreshes, promotes its single-batch world's async
 * entries to canonical, and drops every world cache that folded it. Runs
 * inside one graph batch so effects flush once at the boundary.
 */
export function retireBatch(b: Batch): void {
	if (!b.open) {
		return;
	}
	b.open = false;
	openBatchesByKey.delete(b.key);
	const retireEvent = tracing() ? emit('batch-retire', { batch: b.id }) : 0;
	// Promote the exact-[b] world's async entries before folding: the fold
	// makes canonical equal that world, so its settled fetches carry over
	// (no refetch after commit).
	const soloKey = String(b.id);
	const solo = worldCaches.get(soloKey);
	if (solo !== undefined) {
		for (const [rec, entry] of solo.entries) {
			entry.world = null;
			if (entry.refresh) {
				if (rec.refreshing === entry || rec.refreshing === undefined) {
					adoptRefreshEntry(rec, entry);
				}
			} else {
				killEntry(rec.canonicalEntry);
				rec.canonicalEntry = entry;
				rec.reuseEntry = entry;
			}
		}
		solo.entries.clear();
	}
	pruneWorldsWith(b);
	withCause(retireEvent, () => {
		startBatch();
		try {
			for (const [rec, ops] of b.ops) {
				for (const op of ops) {
					applyCanonicalWrite(rec, op.update === undefined ? op.set : op.update(canonicalAtomValue(rec.node)));
				}
			}
			for (const rec of b.refreshes) {
				refreshCanonical(rec);
			}
		} finally {
			endBatch();
		}
	});
	b.ops.clear();
	b.refreshes.clear();
	b.deliveredTo.clear();
	bumpPending();
	maybeQuiesce();
}

/**
 * Discards a batch without folding: its drafts are rolled back and every
 * subscriber that saw a delivery from it is re-notified so stale draft
 * renders get corrected.
 */
export function discardBatch(b: Batch): void {
	if (!b.open) {
		return;
	}
	b.open = false;
	openBatchesByKey.delete(b.key);
	const ev = tracing() ? emit('batch-discard', { batch: b.id }) : 0;
	pruneWorldsWith(b);
	const seen = [...b.deliveredTo];
	b.ops.clear();
	b.refreshes.clear();
	b.deliveredTo.clear();
	withCause(ev, () => {
		for (const sub of seen) {
			if (!sub.disposed) {
				deliver(sub, null);
			}
		}
	});
	bumpPending();
	maybeQuiesce();
}

// ---------------------------------------------------------------------------
// Worlds: canonical base + an ordered batch set, with per-world caches.
// ---------------------------------------------------------------------------

interface WorldCache {
	key: string;
	batches: Batch[];
	fingerprint: string;
	/** Memoized computed values for the current fingerprint. */
	values: Map<ComputedRec, unknown>;
	/** Read index for draft delivery: which computeds read a record here. */
	reads: Map<Rec, Set<ComputedRec>>;
	/** Async entries persist across fingerprint resets: thenable identity
	 * must survive re-renders of the same draft world. */
	entries: Map<ComputedRec, AsyncEntry>;
}

const worldCaches = new Map<string, WorldCache>();

function worldFingerprint(batches: Batch[]): string {
	let fp = String(graphEpoch);
	for (const b of batches) {
		fp += ':' + b.version;
	}
	return fp;
}

/** The cache for a batch set (sorted by batch id — fold order). */
export function worldFor(batches: Batch[]): WorldCache {
	const sorted = [...batches].sort((a, b) => a.id - b.id);
	let key = '';
	for (const b of sorted) {
		key += (key ? ',' : '') + b.id;
	}
	let wc = worldCaches.get(key);
	if (wc === undefined) {
		wc = {
			key,
			batches: sorted,
			fingerprint: worldFingerprint(sorted),
			values: new Map(),
			reads: new Map(),
			entries: new Map(),
		};
		worldCaches.set(key, wc);
	} else {
		const fp = worldFingerprint(sorted);
		if (wc.fingerprint !== fp) {
			wc.fingerprint = fp;
			wc.values.clear();
			wc.reads.clear();
		}
	}
	return wc;
}

function pruneWorldsWith(b: Batch): void {
	for (const [key, wc] of worldCaches) {
		if (wc.batches.includes(b)) {
			for (const entry of wc.entries.values()) {
				killEntry(entry);
			}
			worldCaches.delete(key);
		}
	}
}

function killEntry(entry: AsyncEntry | undefined): void {
	if (entry !== undefined) {
		entry.dead = true;
	}
}

// --- world evaluation ------------------------------------------------------

/** Non-null while evaluating inside a world; graph reads divert here. */
let activeWorld: WorldCache | null = null;
/** The computed currently evaluating in `activeWorld` (read recording). */
let worldEvalStack: ComputedRec[] = [];
/** Non-null while any computed evaluation (canonical or world) runs: `use`
 * resolves against it. */
let activeEval: {
	entry: AsyncEntry;
	pendingSlots: Slot[];
	pendingInner: ComputedRec[];
	stamp: number;
	readonly: boolean;
} | null = null;

function recordRead(rec: Rec): void {
	const wc = activeWorld;
	if (wc !== null && worldEvalStack.length > 0) {
		let readers = wc.reads.get(rec);
		if (readers === undefined) {
			readers = new Set();
			wc.reads.set(rec, readers);
		}
		readers.add(worldEvalStack[worldEvalStack.length - 1]!);
	}
}

/** Folds a world's batch operations over an atom's canonical base. */
function atomValueInWorld(rec: AtomRec, wc: WorldCache): unknown {
	materialize(rec);
	let v = canonicalAtomValue(rec.node);
	for (const b of wc.batches) {
		const ops = b.ops.get(rec);
		if (ops !== undefined) {
			for (const op of ops) {
				v = op.update !== undefined ? op.update(v) : op.set;
			}
		}
	}
	return v;
}

function computedValueInWorld(rec: ComputedRec, wc: WorldCache): unknown {
	if (wc.values.has(rec)) {
		return wc.values.get(rec);
	}
	let entry = wc.entries.get(rec);
	if (entry === undefined) {
		// Seed from canonical fetches (settled and in-flight, shared): a
		// draft world that asks the same question must not refetch it —
		// unless this world's batches refresh the node, which is exactly a
		// demand for fresh fetches.
		const refreshed = wc.batches.some((b) => b.refreshes.has(rec));
		entry = freshEntry(rec, wc, refreshed);
		if (!refreshed && rec.canonicalEntry !== undefined) {
			for (const [k, slot] of rec.canonicalEntry.slots) {
				entry.slots.set(k, slot);
			}
		}
		wc.entries.set(rec, entry);
	}
	worldEvalStack.push(rec);
	const value = runEvaluation(rec, entry, false);
	worldEvalStack.pop();
	wc.values.set(rec, value);
	return value;
}

/** Non-null while a committed() probe evaluates: atom reads resolve the
 * view's pre-images instead of a world fold. */
let committedRead: RootView | null = null;

worldHooks.atomValue = (node) => {
	const rec = recOfAtomNode(node);
	if (committedRead !== null) {
		return committedAtomValue(rec, committedRead);
	}
	recordRead(rec);
	return atomValueInWorld(rec, activeWorld!);
};
worldHooks.computedValue = (node) => {
	const rec = recOfComputedNode(node);
	if (committedRead !== null) {
		return committedComputedValue(rec, committedRead);
	}
	recordRead(rec);
	return computedValueInWorld(rec, activeWorld!);
};

function withWorld<T>(wc: WorldCache, fn: () => T): T {
	const prevWorld = activeWorld;
	const prevActive = worldHooks.active;
	const prevSub = setActiveSub(undefined);
	activeWorld = wc;
	worldHooks.active = true;
	try {
		return fn();
	} finally {
		activeWorld = prevWorld;
		worldHooks.active = prevActive;
		setActiveSub(prevSub);
	}
}

// ---------------------------------------------------------------------------
// Record registry (node -> record) and constructors.
// ---------------------------------------------------------------------------

const atomRecs = new WeakMap<AtomNode, AtomRec>();
const computedRecs = new WeakMap<ComputedNode, ComputedRec>();

function recOfAtomNode(node: AtomNode): AtomRec {
	return atomRecs.get(node)!;
}
function recOfComputedNode(node: ComputedNode): ComputedRec {
	return computedRecs.get(node)!;
}
function recOf(x: Readable<unknown>): Rec {
	return x as unknown as Rec;
}
function asAtomRec(x: Atom<unknown>): AtomRec {
	const rec = x as unknown as Rec;
	if (rec.t !== 0) {
		throw new TypeError('expected a writable atom');
	}
	return rec;
}

export function atom<T>(initial: T | (() => T), options?: AtomOptions<T>): Atom<T> {
	const lazy = typeof initial === 'function';
	const node = createAtomNode(lazy ? undefined : initial, (options?.equals as Equality) ?? defaultEquals);
	const rec: AtomRec = {
		t: 0,
		id: nextRecId++,
		node,
		label: options?.label,
		init: lazy ? (initial as () => unknown) : undefined,
		observed: options?.effect as AtomRec['observed'],
		obsCleanup: undefined,
		obsActive: false,
		obsScheduled: false,
		subRoots: undefined,
	};
	atomRecs.set(node, rec);
	return rec as unknown as Atom<T>;
}

export function computed<T>(fn: (use: Use) => T, options?: ComputedOptions<T>): Computed<T> {
	const userEquals = (options?.equals as Equality) ?? defaultEquals;
	// Pending and error sentinels compare by identity regardless of the user
	// equality: pending-to-pending is never a change; sentinel-to-value is.
	const equals: Equality = (a, b) =>
		isPendingValue(a) || isPendingValue(b) || a instanceof AsyncError || b instanceof AsyncError
			? Object.is(a, b)
			: userEquals(a, b);
	const node = createComputedNode(() => runEvaluation(rec, canonicalEntryOf(rec), false), equals);
	const rec: ComputedRec = {
		t: 1,
		id: nextRecId++,
		node,
		userFn: fn as (use: Use) => unknown,
		equals,
		label: options?.label,
		pendingBox: undefined,
		lastSettled: undefined,
		hasSettled: false,
		canonicalEntry: undefined,
		reuseEntry: undefined,
		refreshing: undefined,
	};
	computedRecs.set(node, rec);
	return rec as unknown as Computed<T>;
}

/** True while a lazy initializer runs: writes are forbidden inside one. */
let initDepth = 0;

function materialize(rec: AtomRec): void {
	const init = rec.init;
	if (init !== undefined) {
		rec.init = undefined;
		initDepth++;
		try {
			const v = untracked(init);
			rec.node.value = v;
			rec.node.staged = v;
		} finally {
			initDepth--;
		}
	}
}

// ---------------------------------------------------------------------------
// Evaluation: the `use` machinery shared by canonical and world evaluations.
// ---------------------------------------------------------------------------

interface InternalPendingBox extends PendingBox {
	_rec: ComputedRec;
}

function pendingBoxFor(rec: ComputedRec): PendingBox {
	if (rec.pendingBox === undefined) {
		rec.pendingBox = { pending: true, of: rec.id, _rec: rec } as InternalPendingBox;
	}
	return rec.pendingBox;
}

const POISON = undefined as never;
const DUMMY_SLOT: Slot = {
	key: undefined,
	thenable: { then: () => undefined as never },
	status: 0,
	value: undefined,
	errorBox: undefined,
	stamp: 0,
	owners: new Set(),
};

function canonicalEntryOf(rec: ComputedRec): AsyncEntry {
	if (rec.canonicalEntry === undefined || rec.canonicalEntry.dead) {
		rec.canonicalEntry = freshEntry(rec, null, false);
	}
	return rec.canonicalEntry;
}

function freshEntry(rec: ComputedRec, world: WorldCache | null, refresh: boolean): AsyncEntry {
	return {
		rec,
		slots: new Map(),
		world,
		refresh,
		retry: null,
		resolveRetry: null,
		pendingInner: [],
		evalStamp: 0,
		dead: false,
	};
}

const useFn: Use = (<U,>(a: unknown, factory?: () => PromiseLike<U>): U => {
	const ctx = activeEval;
	if (ctx === null) {
		throw new Error('use() is only valid inside a computed evaluation');
	}
	const entry = ctx.entry;
	let slot = entry.slots.get(a);
	if (slot === undefined) {
		if (ctx.readonly) {
			// committed() probes never start fetches; an unknown read is
			// simply pending in that view.
			ctx.pendingSlots.push(DUMMY_SLOT);
			return POISON;
		}
		const thenable = factory !== undefined ? factory() : (a as PromiseLike<unknown>);
		slot = {
			key: a,
			thenable,
			status: 0,
			value: undefined,
			errorBox: undefined,
			stamp: ctx.stamp,
			owners: new Set([entry]),
		};
		entry.slots.set(a, slot);
		attachSlot(slot);
	} else {
		slot.owners.add(entry);
		slot.stamp = ctx.stamp;
	}
	if (slot.status === 1) {
		return slot.value as U;
	}
	if (slot.status === 2) {
		throw slot.errorBox;
	}
	ctx.pendingSlots.push(slot);
	return POISON;
}) as Use;

function attachSlot(slot: Slot): void {
	slot.thenable.then(
		(v) => {
			if (slot.status === 0) {
				slot.status = 1;
				slot.value = v;
				onSlotSettled(slot);
			}
		},
		(e) => {
			if (slot.status === 0) {
				slot.status = 2;
				slot.errorBox = new AsyncError(e);
				onSlotSettled(slot);
			}
		},
	);
}

function runEvaluation(rec: ComputedRec, entry: AsyncEntry, readonly: boolean): unknown {
	const stamp = evalStampCounter++;
	entry.evalStamp = stamp;
	const prev = activeEval;
	activeEval = { entry, pendingSlots: [], pendingInner: [], stamp, readonly };
	let result: unknown;
	let threw = false;
	let error: unknown;
	try {
		result = rec.userFn(useFn);
	} catch (e) {
		threw = true;
		error = e;
	}
	const ctx = activeEval;
	activeEval = prev;
	entry.pendingInner = ctx.pendingInner;
	if (ctx.pendingSlots.length > 0 || ctx.pendingInner.length > 0) {
		// A pending evaluation is pending regardless of what the poisoned
		// tail of the body did; errors thrown past a pending read are moot.
		return pendingBoxFor(rec);
	}
	if (threw) {
		if (error instanceof AsyncError) {
			return error;
		}
		throw error;
	}
	if (!readonly && entry.world === null && !entry.refresh && !isPendingValue(result) && !(result instanceof AsyncError)) {
		rec.lastSettled = result;
		rec.hasSettled = true;
	}
	return result;
}

function onSlotSettled(slot: Slot): void {
	for (const entry of [...slot.owners]) {
		if (entry.dead) {
			slot.owners.delete(entry);
			continue;
		}
		const rec = entry.rec;
		const ev = tracing() ? emit('settle', { tid: rec.id, label: rec.label, ok: slot.status === 1 }) : 0;
		bumpPending();
		const rr = entry.resolveRetry;
		entry.retry = null;
		entry.resolveRetry = null;
		if (rr !== null) {
			rr();
		}
		if (entry.world === null) {
			if (entry.refresh) {
				if (rec.refreshing === entry) {
					probeRefresh(rec, entry);
				}
			} else {
				graphEpoch++;
				withCause(ev, () => invalidateComputed(rec.node));
			}
		} else {
			const wc = entry.world;
			wc.values.clear();
			withCause(ev, () => draftDeliverIn(wc, rec));
		}
	}
}

// ---------------------------------------------------------------------------
// Writes: classification, canonical application, draft operations.
// ---------------------------------------------------------------------------

function guardWrite(): void {
	if (initDepth > 0) {
		throw new Error('a lazy initializer must not write signals');
	}
	if (host.assertCanWrite !== null) {
		host.assertCanWrite();
	}
}

export function set<T>(a: Atom<T>, value: T): void {
	const rec = asAtomRec(a as Atom<unknown>);
	guardWrite();
	materialize(rec);
	const b = host.classify !== null ? host.classify() : null;
	if (b !== null) {
		draftWrite(b, rec, { set: value });
	} else {
		applyCanonicalWrite(rec, value);
	}
}

/** Functional update that replays: the function re-executes against each
 * world's base — a draft batch stores the function and re-applies it over
 * whatever the canonical value is when the batch retires. */
export function update<T>(a: Atom<T>, fn: (prev: T) => T): void {
	const rec = asAtomRec(a as Atom<unknown>);
	guardWrite();
	materialize(rec);
	const b = host.classify !== null ? host.classify() : null;
	if (b !== null) {
		draftWrite(b, rec, { update: fn as (prev: unknown) => unknown });
	} else {
		applyCanonicalWrite(rec, (fn as (prev: unknown) => unknown)(canonicalAtomValue(rec.node)));
	}
}

/** Engine-level attributed write: lands in an explicit batch. */
export function setInBatch<T>(b: Batch, a: Atom<T>, value: T): void {
	const rec = asAtomRec(a as Atom<unknown>);
	guardWrite();
	materialize(rec);
	draftWrite(b, rec, { set: value });
}

export function updateInBatch<T>(b: Batch, a: Atom<T>, fn: (prev: T) => T): void {
	const rec = asAtomRec(a as Atom<unknown>);
	guardWrite();
	materialize(rec);
	draftWrite(b, rec, { update: fn as (prev: unknown) => unknown });
}

function applyCanonicalWrite(rec: AtomRec, value: unknown): void {
	const node = rec.node;
	const current = node.staged;
	if (node.equals(current, value)) {
		if (tracing()) {
			emit('write-dropped', { tid: rec.id, label: rec.label, batch: 0 });
		}
		return;
	}
	capturePreImages(rec);
	graphEpoch++;
	if (tracing()) {
		const w = emit('write', { tid: rec.id, label: rec.label, batch: 0 });
		withCause(w, () => writeAtom(node, value));
	} else {
		writeAtom(node, value);
	}
}

function draftWrite(b: Batch, rec: AtomRec, op: Op): void {
	if (!b.open) {
		throw new Error('write into a retired batch');
	}
	if (op.update === undefined) {
		// Equal writes drop — equality judged in the batch's own world.
		const current = atomValueInWorld(rec, worldFor([b]));
		if (rec.node.equals(current, op.set)) {
			if (tracing()) {
				emit('write-dropped', { tid: rec.id, label: rec.label, batch: b.id });
			}
			return;
		}
	}
	let ops = b.ops.get(rec);
	if (ops === undefined) {
		ops = [];
		b.ops.set(rec, ops);
	}
	ops.push(op);
	b.version++;
	bumpPending();
	if (tracing()) {
		const w = emit('write', { tid: rec.id, label: rec.label, batch: b.id });
		withCause(w, () => draftDeliver(b, rec));
	} else {
		draftDeliver(b, rec);
	}
}

// ---------------------------------------------------------------------------
// Refresh: force refetch with unchanged inputs; stale keeps serving.
// ---------------------------------------------------------------------------

export function refresh(x: Computed<unknown>): void {
	const rec = recOf(x);
	if (rec.t !== 1) {
		throw new TypeError('refresh expects a computed');
	}
	guardWrite();
	const b = host.classify !== null ? host.classify() : null;
	if (tracing()) {
		emit('refresh', { tid: rec.id, label: rec.label, batch: b === null ? 0 : b.id });
	}
	if (b !== null) {
		// A refresh inside a transition belongs to that transition: worlds
		// containing the batch refetch; canonical refetches at retirement.
		b.refreshes.add(rec);
		b.version++;
		for (const wc of worldCaches.values()) {
			if (wc.batches.includes(b)) {
				killEntry(wc.entries.get(rec));
				wc.entries.delete(rec);
			}
		}
		bumpPending();
		draftDeliver(b, rec);
	} else {
		refreshCanonical(rec);
	}
}

function refreshCanonical(rec: ComputedRec): void {
	if (rec.canonicalEntry === undefined) {
		// A synchronous computed: refresh is a plain recompute.
		graphEpoch++;
		invalidateComputed(rec.node);
		return;
	}
	if (rec.refreshing !== undefined) {
		rec.refreshing.dead = true; // latest-wins on refresh races
	}
	const entry = freshEntry(rec, null, true);
	rec.refreshing = entry;
	bumpPending();
	probeRefresh(rec, entry);
}

/** Background evaluation of a refresh entry: adopted the moment it can
 * complete without pending reads. */
function probeRefresh(rec: ComputedRec, entry: AsyncEntry): void {
	let v: unknown;
	try {
		v = untracked(() => runEvaluation(rec, entry, false));
	} catch {
		v = pendingBoxFor(rec); // sync throw during refresh: adopt via canonical re-eval below
		adoptRefreshEntry(rec, entry);
		return;
	}
	if (!isPendingValue(v)) {
		adoptRefreshEntry(rec, entry);
	}
}

function adoptRefreshEntry(rec: ComputedRec, entry: AsyncEntry): void {
	if (rec.refreshing === entry) {
		rec.refreshing = undefined;
	}
	entry.refresh = false;
	killEntry(rec.canonicalEntry);
	rec.canonicalEntry = entry;
	graphEpoch++;
	bumpPending();
	invalidateComputed(rec.node);
}

// ---------------------------------------------------------------------------
// Subscriptions: fiber-granular watchers with draft delivery.
// ---------------------------------------------------------------------------

export interface Delivery {
	/** The draft batch that woke this subscriber, or null for a canonical
	 * change (urgent write, retirement fold, settlement, rollback). */
	batch: Batch | null;
}

export interface SubscriptionHandle {
	dispose(): void;
	/** Tracer id of the delivery that most recently woke this subscriber. */
	lastDeliveryEvent(): number;
}

interface SubscriptionRec {
	effect: EffectNode;
	target: Rec;
	onDeliver: (d: Delivery) => void;
	root: RootView | null;
	disposed: boolean;
	lastDeliverEvent: number;
	label: string | undefined;
}

const subByEffect = new WeakMap<EffectNode, SubscriptionRec>();
/** Listener exceptions never break engine invariants mid-propagation; the
 * host collects them (RoyaleHandle.errors). */
export const subscriberErrors: unknown[] = [];

function deliver(sub: SubscriptionRec, batch: Batch | null): void {
	if (sub.disposed) {
		return;
	}
	if (tracing()) {
		sub.lastDeliverEvent = emit('deliver', {
			tid: sub.target.id,
			label: sub.label ?? sub.target.label,
			batch: batch === null ? 0 : batch.id,
		});
	}
	try {
		sub.onDeliver({ batch });
	} catch (e) {
		subscriberErrors.push(e);
	}
}

export function subscribe(
	x: Readable<unknown>,
	onDeliver: (d: Delivery) => void,
	opts?: { root?: unknown; label?: string },
): SubscriptionHandle {
	const rec = recOf(x);
	if (rec.t === 0) {
		materialize(rec);
	}
	const sub: SubscriptionRec = {
		effect: undefined as unknown as EffectNode,
		target: rec,
		onDeliver,
		root: opts?.root !== undefined ? rootViewFor(opts.root) : null,
		disposed: false,
		lastDeliverEvent: 0,
		label: opts?.label,
	};
	const prevSub = setActiveSub(undefined); // never nest under an ambient effect
	try {
		sub.effect = createEffect(
			() => {
				try {
					if (rec.t === 0) {
						readAtom(rec.node);
					} else {
						readComputed(rec.node);
					}
				} catch {
					// A throwing target still subscribes: the value is the error.
				}
			},
			{ draftNotify: () => deliver(sub, null) },
		);
	} finally {
		setActiveSub(prevSub);
	}
	subByEffect.set(sub.effect, sub);
	if (sub.root !== null) {
		sub.root.subCount++;
	}
	return {
		dispose() {
			if (sub.disposed) {
				return;
			}
			sub.disposed = true;
			if (sub.root !== null && --sub.root.subCount === 0 && sub.root !== globalView) {
				rootViews.delete(sub.root.key);
			}
			disposeEffect(sub.effect);
		},
		lastDeliveryEvent: () => sub.lastDeliverEvent,
	};
}

/** Wakes every subscriber that can observe `rec` in a world containing `b`:
 * canonical graph reach plus the world's own recorded (possibly divergent)
 * dependency sets. */
function draftDeliver(b: Batch, rec: Rec): void {
	const found = new Set<EffectNode>();
	collectWatchers(rec.node, found);
	for (const wc of worldCaches.values()) {
		if (wc.batches.includes(b)) {
			chaseWorldReads(wc, rec, found);
		}
	}
	notifyFound(found, b);
}

function draftDeliverIn(wc: WorldCache, rec: Rec): void {
	const found = new Set<EffectNode>();
	collectWatchers(rec.node, found);
	chaseWorldReads(wc, rec, found);
	notifyFound(found, wc.batches[wc.batches.length - 1] ?? null);
}

function chaseWorldReads(wc: WorldCache, rec: Rec, found: Set<EffectNode>): void {
	const stack: Rec[] = [rec];
	const seen = new Set<Rec>([rec]);
	while (stack.length > 0) {
		const r = stack.pop()!;
		const readers = wc.reads.get(r);
		if (readers === undefined) {
			continue;
		}
		for (const reader of readers) {
			if (!seen.has(reader)) {
				seen.add(reader);
				collectWatchers(reader.node, found);
				stack.push(reader);
			}
		}
	}
}

function notifyFound(found: Set<EffectNode>, b: Batch | null): void {
	for (const e of found) {
		const sub = subByEffect.get(e);
		if (sub !== undefined && !sub.disposed) {
			if (b !== null) {
				b.deliveredTo.add(sub);
			}
			deliver(sub, b);
		}
	}
}

// ---------------------------------------------------------------------------
// Lifetime observation: an atom's `effect` option runs while observed.
// ---------------------------------------------------------------------------

worldHooks.onWatched = (node) => {
	const rec = atomRecs.get(node as AtomNode);
	if (rec !== undefined) {
		materialize(rec); // subscription is a materialization point
		if (rec.observed !== undefined) {
			scheduleObservation(rec);
		}
	}
};
worldHooks.onUnwatched = (node) => {
	const rec = atomRecs.get(node as AtomNode);
	if (rec !== undefined && rec.observed !== undefined) {
		scheduleObservation(rec);
	}
};

const microtask: Promise<void> = Promise.resolve();

function scheduleObservation(rec: AtomRec): void {
	if (rec.obsScheduled) {
		return;
	}
	rec.obsScheduled = true;
	// Microtask debounce: observe/unobserve flaps within a tick (StrictMode
	// double-mounts, subscription handoffs) net out before anything runs.
	microtask.then(() => settleObservation(rec));
}

function settleObservation(rec: AtomRec): void {
	rec.obsScheduled = false;
	const shouldBeActive = rec.node.subs !== undefined;
	if (shouldBeActive === rec.obsActive) {
		return;
	}
	if (shouldBeActive) {
		rec.obsActive = true;
		materialize(rec);
		rec.obsCleanup = rec.observed!({
			get: () => untracked(() => canonicalAtomValue(rec.node)),
			set: (v) => applyCanonicalWrite(rec, v),
		});
	} else {
		rec.obsActive = false;
		const cleanup = rec.obsCleanup;
		rec.obsCleanup = undefined;
		if (typeof cleanup === 'function') {
			cleanup();
		}
	}
}

// ---------------------------------------------------------------------------
// Per-root committed views: what is on screen, per root.
// ---------------------------------------------------------------------------

interface RootView {
	key: unknown;
	/** Pre-images: the value each atom showed at this root's last commit,
	 * captured at the first post-commit canonical change. */
	map: Map<AtomRec, { value: unknown; epoch: Epoch }>;
	subCount: number;
}

const rootViews = new Map<unknown, RootView>();
/** Container-less committed(): cleared at every root's commit. */
const globalView: RootView = { key: undefined, map: new Map(), subCount: 0 };

function rootViewFor(key: unknown): RootView {
	let v = rootViews.get(key);
	if (v === undefined) {
		v = { key, map: new Map(), subCount: 0 };
		rootViews.set(key, v);
	}
	return v;
}

export function registerRoot(key: unknown): void {
	rootViewFor(key);
}

export function unregisterRoot(key: unknown): void {
	rootViews.delete(key);
}

function capturePreImages(rec: AtomRec): void {
	if (rootViews.size === 0 || rec.node.subs === undefined) {
		return; // nothing is on any screen
	}
	const pre = rec.node.value;
	if (!globalView.map.has(rec)) {
		globalView.map.set(rec, { value: pre, epoch: graphEpoch });
	}
	for (const view of rootViews.values()) {
		if (!view.map.has(rec)) {
			view.map.set(rec, { value: pre, epoch: graphEpoch });
		}
	}
}

/**
 * A root committed: entries captured before the committing pass began are
 * now on screen canonically, so they clear. Entries captured mid-pass (a
 * write racing the render) survive until the corrective commit.
 */
export function rootCommitted(key: unknown, passStartEpoch?: Epoch): void {
	const clear = (view: RootView) => {
		if (passStartEpoch === undefined) {
			view.map.clear();
			return;
		}
		for (const [rec, e] of view.map) {
			if (e.epoch <= passStartEpoch) {
				view.map.delete(rec);
			}
		}
	};
	const v = rootViews.get(key);
	if (v !== undefined) {
		clear(v);
	}
	clear(globalView);
	maybeQuiesce();
}

function committedAtomValue(rec: AtomRec, view: RootView): unknown {
	materialize(rec);
	const e = view.map.get(rec);
	return e !== undefined ? e.value : canonicalAtomValue(rec.node);
}

function committedComputedValue(rec: ComputedRec, view: RootView): unknown {
	// A read-only probe over the view: no subscription, no fetch, no cache.
	const prevCommitted = committedRead;
	const prevActive = worldHooks.active;
	const prevSub = setActiveSub(undefined);
	committedRead = view;
	worldHooks.active = true;
	try {
		return runEvaluation(rec, rec.canonicalEntry ?? freshEntry(rec, null, false), true);
	} finally {
		committedRead = prevCommitted;
		worldHooks.active = prevActive;
		setActiveSub(prevSub);
	}
}

// ---------------------------------------------------------------------------
// The read family.
// ---------------------------------------------------------------------------

function resolveRead(rec: Rec, v: unknown): unknown {
	if (activeEval !== null && isPendingValue(v)) {
		// Forward pending: the enclosing evaluation parks on this node too.
		activeEval.pendingInner.push((v as InternalPendingBox)._rec);
		return POISON;
	}
	if (v instanceof AsyncError) {
		throw v;
	}
	return v;
}

/** Canonical read: committed plus applied urgent writes; drafts hidden.
 * Inside a render pass or world evaluation it resolves that context's own
 * world instead — a pass must read one self-consistent world. */
export function read<T>(x: Readable<T>): T {
	const rec = recOf(x);
	if (!worldHooks.active && activeEval === null && host.renderWorld !== null) {
		const rw = host.renderWorld();
		if (rw !== null && rw.length > 0) {
			return resolveRead(rec, readInWorld(x, rw)) as T;
		}
	}
	let v: unknown;
	if (rec.t === 0) {
		if (rec.init !== undefined) {
			materialize(rec);
		}
		v = readAtom(rec.node);
	} else {
		v = readComputed(rec.node);
	}
	return resolveRead(rec, v) as T;
}

/** Raw world read: returns pending/error boxes unboxed (host bindings
 * apply their own boundary policy). Empty batch set = canonical, untracked. */
export function readInWorld<T>(x: Readable<T>, batches: Batch[]): T {
	const rec = recOf(x);
	if (batches.length === 0) {
		return untracked(() =>
			rec.t === 0 ? ((rec.init !== undefined ? materialize(rec) : undefined), canonicalAtomValue(rec.node)) : readComputed(rec.node),
		) as T;
	}
	const wc = worldFor(batches);
	return withWorld(wc, () => (rec.t === 0 ? atomValueInWorld(rec, wc) : computedValueInWorld(rec, wc))) as T;
}

/** Newest intent: every open batch folded over canonical. Inside a render
 * pass or evaluation it resolves that context's own world. Never suspends:
 * a pending computed with settled history serves the stale value. */
export function latest<T>(x: Readable<T>): T {
	const rec = recOf(x);
	if (worldHooks.active || activeEval !== null) {
		return read(x);
	}
	if (host.renderWorld !== null && host.renderWorld() !== null) {
		return read(x);
	}
	// Track canonically (an effect using latest() re-runs on canonical
	// change), then fold the open batches for the returned value.
	let v: unknown;
	if (rec.t === 0) {
		if (rec.init !== undefined) {
			materialize(rec);
		}
		v = readAtom(rec.node);
	} else {
		v = readComputed(rec.node);
	}
	const open = openBatchesByKey.size > 0 ? [...openBatchesByKey.values()] : null;
	if (open !== null) {
		v = readInWorld(x, open);
	}
	if (isPendingValue(v) && rec.t === 1 && rec.hasSettled) {
		return rec.lastSettled as T;
	}
	if (v instanceof AsyncError) {
		throw v;
	}
	return v as T;
}

/** What is on screen: per-root when a container key is given, otherwise the
 * most recent commit anywhere. Never subscribes. */
export function committed<T>(x: Readable<T>, container?: unknown): T {
	const rec = recOf(x);
	const view = container !== undefined ? (rootViews.get(container) ?? globalView) : globalView;
	const v = rec.t === 0 ? committedAtomValue(rec, view) : committedComputedValue(rec, view);
	if (isPendingValue(v) && rec.t === 1 && rec.hasSettled) {
		return rec.lastSettled as T;
	}
	if (v instanceof AsyncError) {
		throw v;
	}
	return v as T;
}

/** Cheap flip-only probe: true while newer data loads behind stale — an
 * open batch touches the value, a fetch is in flight, or a refresh is
 * outstanding. Never refetches, never suspends. */
export function isPending(x: Readable<unknown>): boolean {
	const rec = recOf(x);
	if (rec.t === 0) {
		for (const b of openBatchesByKey.values()) {
			if (b.ops.has(rec)) {
				return true;
			}
		}
		return false;
	}
	if (rec.refreshing !== undefined) {
		return true;
	}
	const v = untracked(() => readComputed(rec.node));
	if (isPendingValue(v)) {
		return true;
	}
	// Transitive scan over canonical dependency edges: a draft write or
	// refresh upstream means newer data is on the way here.
	const seen = new Set<ReactiveNode>();
	const stack: ReactiveNode[] = [rec.node];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (seen.has(node)) {
			continue;
		}
		seen.add(node);
		for (let l = node.deps; l !== undefined; l = l.nextDep) {
			const dep = l.dep;
			if (dep.kind === NodeKind.Atom) {
				const depRec = atomRecs.get(dep as AtomNode);
				if (depRec !== undefined) {
					for (const b of openBatchesByKey.values()) {
						if (b.ops.has(depRec)) {
							return true;
						}
					}
				}
			} else if (dep.kind === NodeKind.Computed) {
				const depRec = computedRecs.get(dep as ComputedNode);
				if (depRec !== undefined) {
					if (depRec.refreshing !== undefined) {
						return true;
					}
					for (const b of openBatchesByKey.values()) {
						if (b.refreshes.has(depRec)) {
							return true;
						}
					}
				}
				stack.push(dep);
			}
		}
	}
	for (const b of openBatchesByKey.values()) {
		if (rec.t === 1 && b.refreshes.has(rec)) {
			return true;
		}
	}
	return false;
}

/** The thenable a suspending host boundary should await for a pending
 * computed in the given world (canonical when empty): resolves at the next
 * settlement that can advance the evaluation. */
export function retryThenable(x: Readable<unknown>, batches: Batch[]): Promise<void> {
	const rec = recOf(x);
	if (rec.t !== 1) {
		return Promise.resolve();
	}
	const wc = batches.length > 0 ? worldFor(batches) : null;
	return entryRetry(rec, wc, new Set());
}

function entryRetry(rec: ComputedRec, wc: WorldCache | null, seen: Set<ComputedRec>): Promise<void> {
	seen.add(rec);
	const entry = wc !== null ? wc.entries.get(rec) : rec.canonicalEntry;
	const waits: Promise<void>[] = [];
	if (entry !== undefined) {
		let hasPending = false;
		for (const slot of entry.slots.values()) {
			if (slot.status === 0) {
				hasPending = true;
				break;
			}
		}
		if (hasPending) {
			if (entry.retry === null) {
				entry.retry = new Promise<void>((r) => {
					entry.resolveRetry = r;
				});
			}
			waits.push(entry.retry);
		}
		for (const inner of entry.pendingInner) {
			if (!seen.has(inner)) {
				waits.push(entryRetry(inner, wc, seen));
			}
		}
	}
	if (waits.length === 0) {
		return Promise.resolve();
	}
	return Promise.race(waits).then(() => undefined);
}

/** Last settled value of an async computed (stale-serving boundaries). */
export function settledHistory(x: Readable<unknown>): { has: boolean; value: unknown } {
	const rec = recOf(x);
	if (rec.t !== 1) {
		return { has: false, value: undefined };
	}
	return { has: rec.hasSettled, value: rec.lastSettled };
}

// ---------------------------------------------------------------------------
// Effects (public wrappers over graph nodes, traced).
// ---------------------------------------------------------------------------

export function effect(fn: () => void | (() => void)): () => void {
	const wrapped = () => {
		if (tracing()) {
			const ev = emit('effect-run', {});
			return withCause(ev, fn);
		}
		return fn();
	};
	const e = createEffect(wrapped);
	return () => disposeEffect(e);
}

export function effectScope(fn: () => void): () => void {
	const e = createScope(fn);
	return () => disposeEffect(e);
}

// ---------------------------------------------------------------------------
// SSR: serialize and install state; install is not a write.
// ---------------------------------------------------------------------------

function ssrKey(rec: AtomRec, i: number): string {
	return rec.label ?? String(i);
}

export function serializeAtomState(
	atoms: Array<Atom<unknown>>,
	replacer?: (key: string, value: unknown) => unknown,
): string {
	const out: Record<string, unknown> = {};
	atoms.forEach((a, i) => {
		const rec = asAtomRec(a);
		materialize(rec);
		out[ssrKey(rec, i)] = canonicalAtomValue(rec.node);
	});
	return JSON.stringify(out, replacer);
}

export function initializeAtomState(
	json: string,
	atoms: Array<Atom<unknown>>,
	reviver?: (key: string, value: unknown) => unknown,
): void {
	const data = JSON.parse(json, reviver) as Record<string, unknown>;
	atoms.forEach((a, i) => {
		const rec = asAtomRec(a);
		const key = ssrKey(rec, i);
		if (Object.prototype.hasOwnProperty.call(data, key)) {
			installState(a, data[key]);
		}
	});
}

/** Installs a value without running the lazy initializer and without
 * counting as a write: no propagation, no equality, no lifetime effect. */
export function installState<T>(a: Atom<T>, value: T): void {
	const rec = asAtomRec(a as Atom<unknown>);
	rec.init = undefined;
	rec.node.value = value;
	rec.node.staged = value;
	graphEpoch++; // world caches folding over this base must not reuse
	if (tracing()) {
		emit('install', { tid: rec.id, label: rec.label });
	}
}

// ---------------------------------------------------------------------------
// Quiescence and test seams.
// ---------------------------------------------------------------------------

function maybeQuiesce(): void {
	if (openBatchesByKey.size === 0 && worldCaches.size > 0) {
		for (const wc of worldCaches.values()) {
			for (const entry of wc.entries.values()) {
				killEntry(entry);
			}
		}
		worldCaches.clear();
	}
}

/** True when no per-episode state is held: no open batches, no world
 * caches, no queued effects. */
export function quiescent(): boolean {
	return openBatchesByKey.size === 0 && worldCaches.size === 0 && graphQuiescent();
}

/** Test seam: sizes of every episodic structure (leak audits). */
export function __internals(): {
	openBatches: number;
	worldCaches: number;
	rootViews: number;
	viewEntries: number;
	pendingListeners: number;
} {
	let viewEntries = globalView.map.size;
	for (const v of rootViews.values()) {
		viewEntries += v.map.size;
	}
	return {
		openBatches: openBatchesByKey.size,
		worldCaches: worldCaches.size,
		rootViews: rootViews.size,
		viewEntries,
		pendingListeners: pendingListeners.size,
	};
}

/** Test seam: full engine reset between test files/cases. */
export function __resetEngine(): void {
	openBatchesByKey.clear();
	worldCaches.clear();
	rootViews.clear();
	globalView.map.clear();
	pendingListeners.clear();
	subscriberErrors.length = 0;
	host.classify = null;
	host.assertCanWrite = null;
	host.renderWorld = null;
}
