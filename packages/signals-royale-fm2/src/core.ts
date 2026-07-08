/**
 * signals-royale-fm2 core: a push-pull reactive graph with a "world overlay".
 *
 * Canonical state (what effects and plain reads see) lives directly on each
 * node: atoms hold a base value, computeds hold a cached evaluation validated
 * by version stamps. Concurrent drafts (React transitions) never touch that
 * state. Instead each pending batch keeps a patch list per atom, and readers
 * that belong to a batch's "world" fold those patches over the base on
 * demand. Retiring a batch replays its patches onto the base as ordinary
 * writes; aborting it just drops them and re-notifies whoever saw the draft.
 *
 * The design goal: the canonical path is a plain synchronous signal graph
 * (fast, no world bookkeeping), and all concurrency cost is carried by the
 * readers who opt into a world.
 */

import { emitTrace, emitAndRun, withCause, currentCauseId } from './tracer';

declare const queueMicrotask: (fn: () => void) => void;
declare const console: { error(...args: unknown[]): void };

// ---------------------------------------------------------------------------
// Named number types
// ---------------------------------------------------------------------------

/** Monotonic stamp bumped on every canonical change anywhere in the graph. */
export type GlobalVersion = number;
/** Per-producer stamp bumped when that producer's canonical value changes. */
export type NodeVersion = number;
/** Identity of a concurrent write batch (a "world" ingredient). */
export type BatchId = number;
/** Stamp bumped when a batch gains ops or one of its suspensions settles. */
export type BatchVersion = number;

export type Equals<T> = (a: T, b: T) => boolean;
const defaultEquals: Equals<unknown> = (a, b) => Object.is(a, b);

// ---------------------------------------------------------------------------
// Graph protocol
// ---------------------------------------------------------------------------

const enum Flags {
	None = 0,
	/** A dependency definitely changed; recompute without validating. */
	Dirty = 1 << 0,
	/** A transitive dependency may have changed; validate before recompute. */
	Check = 1 << 1,
	/** Node participates in push notification (has live subscribers). */
	Live = 1 << 2,
	/** Effect is queued for the next flush. */
	Queued = 1 << 3,
	Disposed = 1 << 4,
	/** Currently evaluating (cycle guard). */
	Running = 1 << 5,
}

interface Consumer {
	deps: Producer[];
	depVersions: NodeVersion[];
	/** Atom dep values as read, for net-change validation (revert = no-op). */
	depValues: unknown[];
	flags: Flags;
	/** Push notification from a dependency. `dirty` = definite change. */
	notify(dirty: boolean): void;
}

interface Producer {
	version: NodeVersion;
	subs: Set<Consumer>;
	addSub(c: Consumer): void;
	removeSub(c: Consumer): void;
	/** Bring the canonical value up to date (no-op for atoms). */
	settleCanonical(): void;
}

let globalVersion: GlobalVersion = 1;
export function bumpGlobalVersion(): void {
	globalVersion++;
}
export function readGlobalVersion(): GlobalVersion {
	return globalVersion;
}

let currentConsumer: Consumer | null = null;
/** During tracked evaluation: dependencies recorded in read order. */
let trackDeps: Producer[] | null = null;
/** Dep versions captured at read time (a same-evaluation write must dirty). */
let trackVersions: NodeVersion[] | null = null;
/** Atom dep values captured at read time (for net-change validation). */
let trackValues: unknown[] | null = null;

function recordDep(p: Producer): void {
	if (trackDeps !== null && trackDeps[trackDeps.length - 1] !== p) {
		trackDeps.push(p);
		trackVersions!.push(p.version);
		trackValues!.push(p instanceof AtomNode ? p.baseValue() : undefined);
	}
}

/** Run `fn` recording its dependency reads, then reconcile edge subscriptions. */
function trackedEvaluate<T>(consumer: Consumer, fn: () => T): T {
	const prevConsumer = currentConsumer;
	const prevDeps = trackDeps;
	const prevVersions = trackVersions;
	const prevValues = trackValues;
	currentConsumer = consumer;
	trackDeps = [];
	trackVersions = [];
	trackValues = [];
	consumer.flags |= Flags.Running;
	try {
		return fn();
	} finally {
		consumer.flags &= ~Flags.Running;
		const newDeps = trackDeps!;
		const newVersions = trackVersions!;
		const newValues = trackValues!;
		currentConsumer = prevConsumer;
		trackDeps = prevDeps;
		trackVersions = prevVersions;
		trackValues = prevValues;
		reconcileDeps(consumer, newDeps, newVersions, newValues);
	}
}

function reconcileDeps(
	consumer: Consumer,
	newDeps: Producer[],
	newVersions: NodeVersion[],
	newValues: unknown[],
): void {
	const live = (consumer.flags & Flags.Live) !== 0;
	const old = consumer.deps;
	if (live) {
		for (const p of newDeps) p.addSub(consumer);
		for (const p of old) if (!newDeps.includes(p)) p.removeSub(consumer);
	}
	consumer.deps = newDeps;
	consumer.depVersions = newVersions;
	consumer.depValues = newValues;
}

/**
 * Validate a consumer's recorded deps; true if any canonical value moved.
 * Version-stamp mismatches on atoms fall back to a value comparison so a
 * write that reverts within a batch counts as no net change.
 */
function depsChanged(consumer: Consumer): boolean {
	const { deps, depVersions, depValues } = consumer;
	for (let i = 0; i < deps.length; i++) {
		const d = deps[i];
		d.settleCanonical();
		if (d.version !== depVersions[i]) {
			if (d instanceof AtomNode && d.sameValue(depValues[i])) {
				depVersions[i] = d.version;
				continue;
			}
			return true;
		}
	}
	return false;
}

export function untracked<T>(fn: () => T): T {
	const prevConsumer = currentConsumer;
	const prevDeps = trackDeps;
	currentConsumer = null;
	trackDeps = null;
	try {
		return fn();
	} finally {
		currentConsumer = prevConsumer;
		trackDeps = prevDeps;
	}
}

// ---------------------------------------------------------------------------
// Batching (synchronous coalescing) and the effect queue
// ---------------------------------------------------------------------------

let batchDepth = 0;
const effectQueue: EffectNode[] = [];

export function startBatch(): void {
	batchDepth++;
}

export function endBatch(): void {
	if (--batchDepth === 0) flushEffects();
}

export function batch<T>(fn: () => T): T {
	startBatch();
	try {
		return fn();
	} finally {
		endBatch();
	}
}

let flushing = false;
function flushEffects(): void {
	if (flushing) return;
	flushing = true;
	try {
		// Effects appended during the flush run in the same pass.
		for (let i = 0; i < effectQueue.length; i++) {
			const e = effectQueue[i];
			e.flags &= ~Flags.Queued;
			if ((e.flags & Flags.Disposed) === 0) e.maybeRun();
		}
	} finally {
		effectQueue.length = 0;
		flushing = false;
	}
}

function scheduleEffect(e: EffectNode): void {
	if (e.flags & (Flags.Queued | Flags.Disposed)) return;
	e.flags |= Flags.Queued;
	effectQueue.push(e);
	if (batchDepth === 0 && !flushing) flushEffects();
}

// ---------------------------------------------------------------------------
// Concurrent write batches and worlds
// ---------------------------------------------------------------------------

/** One draft op recorded against an atom inside a batch. */
type DraftOp<T> = { set: T } | { fn: (prev: T) => T };

export interface WorldBatch {
	id: BatchId;
	/** True for transition/deferred batches (React lane classification). */
	deferred: boolean;
	version: BatchVersion;
	status: 'open' | 'retired' | 'aborted';
	label?: string;
	/** Atoms this batch drafted (patch cleanup + rollback notification). */
	touched: Set<AtomNode<unknown>>;
	/** Nodes holding world caches keyed under this batch (purge list). */
	cacheHolders: Set<WorldCacheHolder>;
	/** Trace event id of the batch-open event (causal parent for its writes). */
	traceId: number;
}

interface WorldCacheHolder {
	purgeWorldCaches(batch: WorldBatch): void;
}

/** A world = the ordered set of open batches a reader is allowed to see. */
export type World = readonly WorldBatch[];

let nextBatchId: BatchId = 1;
const openBatches = new Map<BatchId, WorldBatch>();

/** The world the current evaluation context resolves reads against. */
let currentWorld: World | null = null;
/** The batch that classifies writes issued right now (null = canonical). */
let currentWriteBatch: WorldBatch | null = null;

export function createBatch(deferred: boolean, label?: string): WorldBatch {
	const b: WorldBatch = {
		id: nextBatchId++,
		deferred,
		version: 1,
		status: 'open',
		label,
		touched: new Set(),
		cacheHolders: new Set(),
		traceId: emitTrace('batch-open', currentCauseId(), { batch: nextBatchId - 1, deferred, label }),
	};
	openBatches.set(b.id, b);
	return b;
}

export function getBatch(id: BatchId): WorldBatch | undefined {
	return openBatches.get(id);
}

export function openBatchCount(): number {
	return openBatches.size;
}

export function runInWriteBatch<T>(b: WorldBatch | null, fn: () => T): T {
	const prev = currentWriteBatch;
	currentWriteBatch = b;
	startBatch();
	try {
		return fn();
	} finally {
		currentWriteBatch = prev;
		endBatch();
	}
}

export function currentWriteBatchId(): BatchId | null {
	return currentWriteBatch === null ? null : currentWriteBatch.id;
}

export function withWorld<T>(world: World | null, fn: () => T): T {
	const prev = currentWorld;
	currentWorld = world;
	try {
		return fn();
	} finally {
		currentWorld = prev;
	}
}

/** Bindings set the render pass's world for the duration of a render slice. */
export function setAmbientWorld(world: World | null): World | null {
	const prev = currentWorld;
	currentWorld = world;
	return prev;
}

export function getAmbientWorld(): World | null {
	return currentWorld;
}

function worldKey(world: World): string {
	let k = '';
	for (const b of world) k += b.id + ',';
	return k;
}

/** Stamp identifying a world's state: canonical clock + each batch clock. */
function worldStamp(world: World): string {
	let s = globalVersion + '|';
	for (const b of world) s += b.version + ',';
	return s;
}

/**
 * Replay a retired batch's drafts onto canonical state, in draft order.
 * Update ops re-execute against the atom's current base (rebase semantics:
 * an urgent increment that landed first is respected by the replayed fn).
 */
export function retireBatch(b: WorldBatch): void {
	if (b.status !== 'open') return;
	b.status = 'retired';
	openBatches.delete(b.id);
	emitTrace('batch-retire', b.traceId, { batch: b.id, disposition: 'committed' });
	withCause(b.traceId, () => {
		batch(() => {
			for (const a of b.touched) a.replayBatch(b);
		});
	});
	purgeBatch(b);
}

/** Drop a batch's drafts without applying them, re-notifying draft readers. */
export function abortBatch(b: WorldBatch): void {
	if (b.status !== 'open') return;
	b.status = 'aborted';
	openBatches.delete(b.id);
	emitTrace('batch-retire', b.traceId, { batch: b.id, disposition: 'aborted' });
	withCause(b.traceId, () => {
		batch(() => {
			for (const a of b.touched) a.dropBatch(b);
		});
	});
	purgeBatch(b);
}

function purgeBatch(b: WorldBatch): void {
	for (const h of b.cacheHolders) h.purgeWorldCaches(b);
	b.cacheHolders.clear();
	b.touched.clear();
}

// ---------------------------------------------------------------------------
// Atoms (writable signals)
// ---------------------------------------------------------------------------

/** Placeholder for a lazy initializer that has not materialized yet. */
const UNSET: unique symbol = Symbol('unset');

export interface AtomOptions<T> {
	equals?: Equals<T>;
	label?: string;
	/**
	 * Lifetime effect: runs when the atom gains its first subscriber of any
	 * kind (effect, live computed chain, or React component) and its cleanup
	 * runs when the last one leaves. Flaps within a tick coalesce.
	 */
	effect?: (ctx: { get(): T; set(v: T): void }) => void | (() => void);
}

export class AtomNode<T> implements Producer {
	version: NodeVersion = 1;
	subs = new Set<Consumer>();
	label?: string;

	private base: T | typeof UNSET;
	private init: (() => T) | null;
	private equals: Equals<T>;

	/** Draft patches per open batch, in write order. */
	private patches: Map<BatchId, { ops: DraftOp<T>[]; batch: WorldBatch }> | null = null;
	/** Folded world values, keyed by world, stamped for invalidation. */
	private worldCache: Map<string, { stamp: string; value: T }> | null = null;

	/** Lifetime-effect bookkeeping (see observed.ts helpers below). */
	lifetime: LifetimeState<T> | null = null;

	constructor(initial: T | (() => T), opts?: AtomOptions<T>) {
		if (typeof initial === 'function') {
			this.base = UNSET;
			this.init = initial as () => T;
		} else {
			this.base = initial;
			this.init = null;
		}
		this.equals = opts?.equals ?? (defaultEquals as Equals<T>);
		this.label = opts?.label;
		if (opts?.effect) this.lifetime = new LifetimeState(this, opts.effect);
	}

	settleCanonical(): void {}

	/** Run the lazy initializer if it hasn't run. Untracked; writes forbidden. */
	materialize(): T {
		if (this.base === UNSET) {
			const init = this.init!;
			this.init = null;
			initializerDepth++;
			try {
				this.base = untracked(init);
			} finally {
				initializerDepth--;
			}
		}
		return this.base as T;
	}

	/** Canonical value: committed state plus applied urgent writes. */
	baseValue(): T {
		return this.materialize();
	}

	/** Tracked read resolving the ambient world. */
	read(): T {
		if (currentConsumer !== null) recordDep(this);
		return this.valueIn(currentWorld);
	}

	/** The atom's value as seen from `world` (null = canonical). */
	valueIn(world: World | null): T {
		if (currentCommittedRead !== null) {
			const p = currentCommittedRead.pending;
			if (p.has(this as AtomNode<unknown>)) return p.get(this as AtomNode<unknown>) as T;
		}
		const base = this.materialize();
		if (world === null || world.length === 0 || this.patches === null) return base;
		let relevant = false;
		for (const b of world) if (this.patches.has(b.id)) relevant = true;
		if (!relevant) return base;
		const key = worldKey(world);
		const stamp = worldStamp(world);
		let cache = this.worldCache;
		if (cache === null) cache = this.worldCache = new Map();
		const hit = cache.get(key);
		if (hit !== undefined && hit.stamp === stamp) return hit.value;
		let v = base;
		for (const b of world) {
			const p = this.patches.get(b.id);
			if (p === undefined) continue;
			for (const op of p.ops) v = 'set' in op ? op.set : op.fn(v);
			b.cacheHolders.add(this);
		}
		cache.set(key, { stamp, value: v });
		return v;
	}

	/** Newest intent: canonical folded through every open batch that drafted. */
	latestValue(): T {
		if (this.patches === null || this.patches.size === 0) return this.materialize();
		const world = [...this.patches.values()].map((p) => p.batch).sort((a, b) => a.id - b.id);
		return this.valueIn(world);
	}

	write(op: DraftOp<T>): void {
		if (initializerDepth > 0) {
			throw new Error('signals-royale-fm2: lazy initializers must not write to atoms');
		}
		if (writeGuard !== null) writeGuard(this);
		const b = currentWriteBatch;
		if (b !== null && b.deferred) {
			this.draft(b, op);
			return;
		}
		// Canonical (urgent) write: applies to base immediately.
		const prev = this.materialize();
		const next = 'set' in op ? op.set : op.fn(prev);
		if (this.equals(prev, next)) return;
		// Per-root committed views: the value on screen is `prev` until each
		// root's next commit, so capture it before the base moves.
		for (const view of committedViews) {
			if (!view.pending.has(this as AtomNode<unknown>)) {
				view.pending.set(this as AtomNode<unknown>, prev);
			}
		}
		this.base = next;
		this.version++;
		globalVersion++;
		emitTrace('write', currentCauseId(), {
			atom: this.label ?? 'atom',
			batch: b === null ? 0 : b.id,
			node: this,
		});
		startBatch();
		try {
			// Check, not Dirty: consumers validate net change at flush time, so
			// a write that reverts within a batch triggers nothing downstream.
			for (const c of [...this.subs]) c.notify(false);
		} finally {
			endBatch();
		}
	}

	private draft(b: WorldBatch, op: DraftOp<T>): void {
		// The equality contract compares against the drafted world's current
		// value, so a lazy base must exist before the first draft lands.
		const before = this.valueIn([b]);
		const after = 'set' in op ? op.set : op.fn(before);
		if (this.equals(before, after) && 'set' in op) return;
		let patches = this.patches;
		if (patches === null) patches = this.patches = new Map();
		let p = patches.get(b.id);
		if (p === undefined) {
			p = { ops: [], batch: b };
			patches.set(b.id, p);
			b.touched.add(this as AtomNode<unknown>);
		}
		p.ops.push(op);
		b.version++;
		emitTrace('write', currentCauseId(), {
			atom: this.label ?? 'atom',
			batch: b.id,
			deferred: true,
			node: this,
		});
		notifyExternal(this, b);
	}

	/** Retired batch: replay its ops as canonical writes, in order. */
	replayBatch(b: WorldBatch): void {
		const p = this.patches?.get(b.id);
		if (p === undefined) return;
		this.patches!.delete(b.id);
		for (const op of p.ops) this.write(op);
	}

	/** Aborted batch: drop drafts and re-notify anyone who saw them. */
	dropBatch(b: WorldBatch): void {
		const p = this.patches?.get(b.id);
		if (p === undefined) return;
		this.patches!.delete(b.id);
		notifyExternal(this, b);
	}

	purgeWorldCaches(b: WorldBatch): void {
		if (this.worldCache !== null) {
			for (const key of [...this.worldCache.keys()]) {
				if (key.includes(b.id + ',')) this.worldCache.delete(key);
			}
		}
	}

	addSub(c: Consumer): void {
		this.materialize();
		this.subs.add(c);
		this.lifetime?.retain();
	}
	removeSub(c: Consumer): void {
		if (this.subs.delete(c)) this.lifetime?.release();
	}

	/** True while any open deferred batch holds drafts against this atom. */
	hasOpenDrafts(): boolean {
		return this.patches !== null && this.patches.size > 0;
	}

	/** Net-change probe: does the current base equal a recorded read value? */
	sameValue(recorded: unknown): boolean {
		return this.base !== UNSET && this.equals(this.base as T, recorded as T);
	}

	/** Install a server-serialized value: cancels the lazy initializer and
	 * replaces the base without write semantics (no equality, no notify). */
	install(value: T): void {
		this.base = value;
		this.init = null;
	}

	get(): T {
		return this.read();
	}
	set(value: T): void {
		this.write({ set: value });
	}
	update(fn: (prev: T) => T): void {
		this.write({ fn });
	}
}

/** Nonzero while a lazy initializer runs (writes are forbidden inside). */
let initializerDepth = 0;

/** Bindings install this to fail loudly on write-during-render. */
let writeGuard: ((atom: { label?: string }) => void) | null = null;
export function setWriteGuard(g: typeof writeGuard): void {
	writeGuard = g;
}

// ---------------------------------------------------------------------------
// Async: suspensions and the keyed thenable cache
// ---------------------------------------------------------------------------

/**
 * Thrown (or forwarded) when an evaluation touched unresolved thenables.
 * Reference-stable for one pending episode: React can rethrow it across
 * Suspense retries without triggering new fetches. `then` makes it usable
 * directly as the thenable handed to React.
 */
export class Suspension {
	thenables: PromiseLike<unknown>[] = [];
	then(onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown): PromiseLike<unknown> {
		return Promise.race(this.thenables).then(onFulfilled, onRejected);
	}
}

export function isSuspension(e: unknown): e is Suspension {
	return e instanceof Suspension;
}

type ThenableStatus = 'pending' | 'value' | 'error';
interface ThenableEntry {
	t: PromiseLike<unknown>;
	status: ThenableStatus;
	result: unknown;
	epoch: number;
	/** Marked each evaluation that used this key, for trimming. */
	used: boolean;
}

/** The async-read helper passed to computed functions. */
export interface UseFn {
	<U>(t: PromiseLike<U>): U;
	<U>(key: unknown, factory: () => PromiseLike<U>): U;
}

interface Evaluation {
	/** Suspensions of pending deps forwarded into this evaluation. */
	forwarded: Suspension | null;
	node: ComputedNode<unknown>;
	world: World | null;
}

let currentEvaluation: Evaluation | null = null;

// ---------------------------------------------------------------------------
// Computeds
// ---------------------------------------------------------------------------

type Settled<T> = { kind: 'value'; value: T } | { kind: 'error'; error: unknown };

interface WorldEntry<T> {
	stamp: string;
	settled: Settled<T> | null;
	pending: Suspension | null;
	usedKeys: Set<unknown>;
}

export interface ComputedOptions<T> {
	equals?: Equals<T>;
	label?: string;
}

export class ComputedNode<T> implements Producer, Consumer {
	version: NodeVersion = 1;
	subs = new Set<Consumer>();
	deps: Producer[] = [];
	depVersions: NodeVersion[] = [];
	depValues: unknown[] = [];
	flags = Flags.Dirty;
	label?: string;

	private fn: (use: UseFn) => T;
	private equals: Equals<T>;

	/** Last settled canonical outcome; keeps serving while a refetch runs. */
	private settled: Settled<T> | null = null;
	/** Non-null while the canonical evaluation waits on thenables. */
	private pendingSusp: Suspension | null = null;
	private lastGV: GlobalVersion = 0;

	/** Async refetch generation: entries older than this refetch on next use. */
	epoch = 0;
	/** Refresh issued inside a transition: settlements belong to that batch. */
	refreshOwner: WorldBatch | null = null;
	private thenables: Map<unknown, ThenableEntry & { owner: WorldBatch | null }> | null = null;
	private canonicalKeys = new Set<unknown>();

	private worlds: Map<string, WorldEntry<T>> | null = null;

	private useFn: UseFn;

	constructor(fn: (use: UseFn) => T, opts?: ComputedOptions<T>) {
		this.fn = fn;
		this.equals = opts?.equals ?? (defaultEquals as Equals<T>);
		this.label = opts?.label;
		this.useFn = this.makeUse();
	}

	// -- graph protocol ------------------------------------------------------

	addSub(c: Consumer): void {
		if (this.subs.size === 0) {
			// Becoming live: settle so recorded deps are current, then hold
			// push edges up the graph.
			this.flags |= Flags.Live;
			this.settleCanonical();
			for (const d of this.deps) d.addSub(this);
		}
		this.subs.add(c);
	}

	removeSub(c: Consumer): void {
		if (this.subs.delete(c) && this.subs.size === 0) {
			this.flags &= ~Flags.Live;
			for (const d of this.deps) d.removeSub(this);
		}
	}

	notify(dirty: boolean): void {
		const had = this.flags & (Flags.Dirty | Flags.Check);
		this.flags |= dirty ? Flags.Dirty : Flags.Check;
		if (had === 0) {
			for (const c of [...this.subs]) c.notify(false);
		}
	}

	// -- canonical evaluation --------------------------------------------------

	settleCanonical(): void {
		if (this.flags & Flags.Running) {
			throw new Error('signals-royale-fm2: cycle detected in computed evaluation');
		}
		if ((this.flags & (Flags.Dirty | Flags.Check)) === 0) {
			if (this.lastGV === globalVersion) return;
			if (this.lastGV !== 0) {
				// Nothing pushed at us; validate dep versions before recomputing.
				if (!depsChanged(this)) {
					this.lastGV = globalVersion;
					return;
				}
			}
		} else if ((this.flags & Flags.Dirty) === 0 && this.lastGV !== 0) {
			if (!depsChanged(this)) {
				this.flags &= ~Flags.Check;
				this.lastGV = globalVersion;
				return;
			}
		}
		// Capture the clock before evaluating: a write issued inside the
		// evaluation leaves lastGV behind, so the next read revalidates.
		const gv: GlobalVersion = globalVersion;
		this.recompute();
		this.flags &= ~(Flags.Dirty | Flags.Check);
		this.lastGV = gv;
	}

	private recompute(): void {
		const prevEval = currentEvaluation;
		const ev: Evaluation = { forwarded: null, node: this as ComputedNode<unknown>, world: null };
		currentEvaluation = ev;
		this.canonicalKeys = new Set();
		let outcome: Settled<T> | null = null;
		let pending: Suspension | null = null;
		try {
			const value = withWorld(null, () => trackedEvaluate(this, () => this.fn(this.useFn)));
			outcome = { kind: 'value', value };
			pending = ev.forwarded;
		} catch (e) {
			if (isSuspension(e)) {
				pending = e;
			} else {
				outcome = { kind: 'error', error: e };
			}
		} finally {
			currentEvaluation = prevEval;
		}
		this.pendingSusp = pending;
		if (outcome !== null) {
			const prev = this.settled;
			const changed =
				prev === null ||
				prev.kind !== outcome.kind ||
				(outcome.kind === 'value' &&
					prev.kind === 'value' &&
					!this.equals(prev.value, outcome.value)) ||
				(outcome.kind === 'error' && prev.kind === 'error' && prev.error !== outcome.error);
			if (changed) {
				this.settled = outcome;
				this.version++;
			}
		}
		this.trimThenables();
	}

	/** Unwrap an outcome at a read site, forwarding pending to the caller. */
	private deliver(settled: Settled<T> | null, pending: Suspension | null): T {
		if (pending !== null && currentEvaluation !== null) {
			const fw = (currentEvaluation.forwarded ??= new Suspension());
			for (const t of pending.thenables) {
				if (!fw.thenables.includes(t)) fw.thenables.push(t);
			}
		}
		if (settled === null) {
			if (pending !== null) throw pending;
			throw new Error('signals-royale-fm2: computed has no value');
		}
		if (settled.kind === 'error') throw settled.error;
		return settled.value;
	}

	read(): T {
		if (currentCommittedRead !== null) return this.committedEvaluate();
		const w = currentWorld;
		if (w !== null && w.length !== 0) {
			if (currentConsumer !== null) recordDep(this);
			return this.worldRead(w);
		}
		// Settle before recording the dep edge so the recorded version stamp
		// reflects the value the reader actually observed.
		this.settleCanonical();
		if (currentConsumer !== null) recordDep(this);
		return this.deliver(this.settled, this.pendingSusp);
	}

	/**
	 * Evaluate against a per-root committed view: atoms resolve through the
	 * view's pre-write snapshots, nothing is cached, nothing subscribes.
	 * A pending evaluation serves the last settled value when one exists.
	 */
	private committedEvaluate(): T {
		const prevEval = currentEvaluation;
		const ev: Evaluation = { forwarded: null, node: this as ComputedNode<unknown>, world: null };
		currentEvaluation = ev;
		try {
			const value = untracked(() => this.fn(this.useFn));
			if (ev.forwarded !== null) throw ev.forwarded;
			return value;
		} catch (e) {
			if (isSuspension(e) && this.settled?.kind === 'value') return this.settled.value;
			throw e;
		} finally {
			currentEvaluation = prevEval;
		}
	}

	/** Canonical pending probe (own pending or any dep's, transitively). */
	pendingIn(world: World | null): boolean {
		try {
			if (world !== null && world.length !== 0) {
				const entry = this.worldEntry(world);
				if (entry.pending !== null) return true;
			} else {
				this.settleCanonical();
				if (this.pendingSusp !== null) return true;
			}
		} catch {
			return true;
		}
		for (const d of this.deps) {
			if (d instanceof ComputedNode && d.pendingIn(world)) return true;
			if (d instanceof AtomNode && world === null && d.hasOpenDrafts()) return true;
		}
		return false;
	}

	// -- world evaluation ------------------------------------------------------

	private worldEntry(w: World): WorldEntry<T> {
		const key = worldKey(w);
		const stamp = worldStamp(w);
		let worlds = this.worlds;
		if (worlds === null) worlds = this.worlds = new Map();
		const hit = worlds.get(key);
		if (hit !== undefined && hit.stamp === stamp) return hit;
		const prevEval = currentEvaluation;
		const ev: Evaluation = { forwarded: null, node: this as ComputedNode<unknown>, world: w };
		currentEvaluation = ev;
		const usedKeys = new Set<unknown>();
		this.collectKeys = usedKeys;
		let settled: Settled<T> | null = hit?.settled ?? this.settled;
		let pending: Suspension | null = null;
		try {
			const value = withWorld(w, () => untracked(() => this.fn(this.useFn)));
			pending = ev.forwarded;
			const prev = hit?.settled ?? this.settled;
			settled =
				prev !== null && prev.kind === 'value' && this.equals(prev.value, value)
					? prev
					: { kind: 'value', value };
		} catch (e) {
			if (isSuspension(e)) pending = e;
			else settled = { kind: 'error', error: e };
		} finally {
			currentEvaluation = prevEval;
			this.collectKeys = null;
		}
		const entry: WorldEntry<T> = { stamp, settled, pending, usedKeys };
		worlds.set(key, entry);
		for (const b of w) b.cacheHolders.add(this as unknown as AtomNode<unknown>);
		return entry;
	}

	private worldRead(w: World): T {
		const entry = this.worldEntry(w);
		return this.deliver(entry.settled, entry.pending);
	}

	purgeWorldCaches(b: WorldBatch): void {
		if (this.worlds !== null) {
			for (const key of [...this.worlds.keys()]) {
				if (key.includes(b.id + ',')) this.worlds.delete(key);
			}
		}
	}

	// -- async reads -----------------------------------------------------------

	/** Key-use collector for the world entry currently evaluating. */
	private collectKeys: Set<unknown> | null = null;

	private makeUse(): UseFn {
		const use = <U>(keyOrThenable: unknown, factory?: () => PromiseLike<U>): U => {
			const ev = currentEvaluation;
			if (ev === null || ev.node !== (this as ComputedNode<unknown>)) {
				throw new Error(
					'signals-royale-fm2: use() may only be called during its own computed evaluation',
				);
			}
			const key = keyOrThenable;
			const make = factory ?? (() => keyOrThenable as PromiseLike<U>);
			let map = this.thenables;
			if (map === null) map = this.thenables = new Map();
			let entry = map.get(key);
			if (entry === undefined || entry.epoch < this.epoch) {
				const t = make();
				const fresh = {
					t,
					status: 'pending' as ThenableStatus,
					result: undefined as unknown,
					epoch: this.epoch,
					used: true,
					owner: this.refreshOwner ?? ev.world?.[ev.world.length - 1] ?? null,
				};
				// A replaced entry keeps nothing: latest-wins on refresh races.
				map.set(key, fresh);
				entry = fresh;
				t.then(
					(v) => this.onThenableSettled(fresh, 'value', v),
					(e) => this.onThenableSettled(fresh, 'error', e),
				);
			}
			(ev.world === null ? this.canonicalKeys : this.collectKeys)?.add(key);
			if (entry.status === 'value') return entry.result as U;
			if (entry.status === 'error') throw entry.result;
			const susp = (ev.forwarded ??= new Suspension());
			if (!susp.thenables.includes(entry.t)) susp.thenables.push(entry.t);
			throw susp;
		};
		return use as UseFn;
	}

	private onThenableSettled(
		entry: ThenableEntry & { owner: WorldBatch | null },
		status: ThenableStatus,
		result: unknown,
	): void {
		const current = this.thenables?.get
			? [...(this.thenables?.values() ?? [])].includes(entry)
			: false;
		if (!current || entry.status !== 'pending') return; // superseded: latest wins
		entry.status = status;
		entry.result = result;
		const owner = entry.owner !== null && entry.owner.status === 'open' ? entry.owner : null;
		emitTrace('settle', currentCauseId(), {
			computed: this.label ?? 'computed',
			batch: owner?.id ?? 0,
			node: this,
		});
		// Settlement behaves as a write: invalidate and propagate. Check, not
		// Dirty, downstream: equality cutoff still applies after recompute.
		this.flags |= Flags.Dirty;
		globalVersion++;
		startBatch();
		try {
			for (const c of [...this.subs]) c.notify(false);
		} finally {
			endBatch();
		}
		if (owner !== null) owner.version++;
		notifyWorldTouch(this, owner);
	}

	private trimThenables(): void {
		const map = this.thenables;
		if (map === null) return;
		for (const [key, entry] of map) {
			if (this.canonicalKeys.has(key)) continue;
			let usedByWorld = false;
			if (this.worlds !== null) {
				for (const w of this.worlds.values()) {
					if (w.usedKeys.has(key)) usedByWorld = true;
				}
			}
			if (!usedByWorld && entry.status !== 'pending') map.delete(key);
		}
	}

	/** Force refetch with unchanged inputs; the stale value keeps serving. */
	refresh(): void {
		this.epoch++;
		this.refreshOwner =
			currentWriteBatch !== null && currentWriteBatch.deferred ? currentWriteBatch : null;
		this.flags |= Flags.Dirty;
		globalVersion++;
		if (this.refreshOwner !== null) this.refreshOwner.version++;
		emitTrace('write', currentCauseId(), {
			computed: this.label ?? 'computed',
			refresh: true,
			batch: this.refreshOwner?.id ?? 0,
			node: this,
		});
		startBatch();
		try {
			// Check, not Dirty: downstream values are unchanged while the stale
			// value serves, so equality cutoff must keep effects quiet.
			for (const c of [...this.subs]) c.notify(false);
		} finally {
			endBatch();
		}
		notifyWorldTouch(this, this.refreshOwner);
	}

	/** Non-suspending read in `world`: a pending evaluation serves the last
	 * settled value when one exists. */
	latestIn(world: World | null): T {
		if (world === null || world.length === 0) {
			this.settleCanonical();
			if (this.pendingSusp !== null && this.settled?.kind === 'value') return this.settled.value;
			return this.deliver(this.settled, this.pendingSusp);
		}
		const entry = this.worldEntry(world);
		if (entry.pending !== null && entry.settled?.kind === 'value') return entry.settled.value;
		return this.deliver(entry.settled, entry.pending);
	}

	get(): T {
		return this.read();
	}
}

/**
 * Newest intent for `x`. Inside a computed evaluation or a render pass it
 * resolves that context's own world; outside any context it folds every open
 * batch over canonical state. Serves the last settled value while an async
 * evaluation is pending, so it never suspends once a value has ever settled.
 */
export function latestOf<T>(x: AtomNode<T> | ComputedNode<T>): T {
	const world: World | null =
		currentEvaluation !== null
			? currentEvaluation.world
			: currentWorld !== null
				? currentWorld
				: [...openBatches.values()].sort((a, b) => a.id - b.id);
	if (x instanceof AtomNode) return untracked(() => x.valueIn(world));
	return untracked(() => x.latestIn(world));
}

/**
 * Cheap pending probe: true while newer data loads (or drafts sit) behind
 * the value canonical readers see. Never refetches, never suspends.
 */
export function isPendingOf(x: AtomNode<unknown> | ComputedNode<unknown>): boolean {
	if (x instanceof AtomNode) return x.hasOpenDrafts();
	return x.pendingIn(currentWorld);
}

// ---------------------------------------------------------------------------
// Effects and effect scopes
// ---------------------------------------------------------------------------

/**
 * An effect runs its function immediately and again whenever a canonical
 * dependency changes. Effects observe canonical state only: transition
 * drafts are invisible to them until the owning batch retires.
 */
/** Anything that can own effects (a scope or an enclosing effect). */
interface EffectOwner {
	children: Set<{ dispose(): void }>;
}

let currentScope: EffectOwner | null = null;

/** Run a cleanup function containing its errors (cleanup must not wedge). */
function runCleanup(cleanup: void | (() => void)): void {
	if (typeof cleanup !== 'function') return;
	try {
		untracked(cleanup);
	} catch (e) {
		// A throwing cleanup must not block disposal or re-runs.
		console.error('signals-royale-fm2: error in effect cleanup', e);
	}
}

export class EffectNode implements Consumer, EffectOwner {
	deps: Producer[] = [];
	depVersions: NodeVersion[] = [];
	depValues: unknown[] = [];
	flags = Flags.Live | Flags.Dirty;
	label?: string;
	/** Effects created during this effect's run; disposed before each re-run. */
	children = new Set<{ dispose(): void }>();

	private fn: () => void | (() => void);
	private cleanup: void | (() => void) = undefined;
	private owner: EffectOwner | null;

	constructor(fn: () => void | (() => void), label?: string) {
		this.fn = fn;
		this.label = label;
		this.owner = currentScope;
		currentScope?.children.add(this);
		this.maybeRun();
	}

	notify(dirty: boolean): void {
		this.flags |= dirty ? Flags.Dirty : Flags.Check;
		scheduleEffect(this);
	}

	/** Flush entry: validate Check-only wakeups before re-running. */
	maybeRun(): void {
		if ((this.flags & Flags.Dirty) === 0) {
			if ((this.flags & Flags.Check) === 0) return;
			if (!depsChanged(this)) {
				this.flags &= ~Flags.Check;
				return;
			}
		}
		// Validation can run arbitrary computeds, which may dispose us.
		if (this.flags & Flags.Disposed) return;
		this.flags &= ~(Flags.Dirty | Flags.Check);
		for (const c of [...this.children]) c.dispose();
		this.children.clear();
		runCleanup(this.cleanup);
		this.cleanup = undefined;
		emitAndRun('effect-run', { effect: this.label ?? 'effect', node: this }, () => {
			const prevScope = currentScope;
			currentScope = this;
			try {
				this.cleanup = withWorld(null, () => trackedEvaluate(this, this.fn));
			} finally {
				currentScope = prevScope;
			}
		});
	}

	dispose(): void {
		if (this.flags & Flags.Disposed) return;
		this.flags |= Flags.Disposed;
		for (const c of [...this.children]) c.dispose();
		this.children.clear();
		runCleanup(this.cleanup);
		this.cleanup = undefined;
		for (const d of this.deps) d.removeSub(this);
		this.deps = [];
		this.depVersions = [];
		this.depValues = [];
		this.owner?.children.delete(this);
		this.owner = null;
	}
}

/** Groups effects (and child scopes) for one-call disposal. */
export class EffectScope implements EffectOwner {
	children = new Set<{ dispose(): void }>();
	private parent: EffectOwner | null;

	constructor() {
		this.parent = currentScope;
		currentScope?.children.add(this);
	}

	run<T>(fn: () => T): T {
		const prev = currentScope;
		currentScope = this;
		try {
			return fn();
		} finally {
			currentScope = prev;
		}
	}

	dispose(): void {
		for (const c of [...this.children]) c.dispose();
		this.children.clear();
		this.parent?.children.delete(this);
		this.parent = null;
	}
}

// ---------------------------------------------------------------------------
// Lifetime effects (observed lifecycle)
// ---------------------------------------------------------------------------

const pendingLifetimes = new Set<{ sync(): void }>();
let lifetimeFlushQueued = false;

/**
 * Apply queued observe/unobserve transitions now. Called from a microtask by
 * default so flaps within a tick (StrictMode double-mount) coalesce to
 * nothing; bindings and tests may call it directly for determinism.
 */
export function flushLifetimeEffects(): void {
	for (const l of [...pendingLifetimes]) l.sync();
}

/**
 * One observation across the union of subscriber kinds: the atom's `effect`
 * option runs when the first subscriber of any kind arrives and its cleanup
 * runs when the last one leaves.
 */
export class LifetimeState<T> {
	private count = 0;
	private active = false;
	private cleanup: void | (() => void) = undefined;

	constructor(
		private atom: AtomNode<T>,
		private fx: (ctx: { get(): T; set(v: T): void }) => void | (() => void),
	) {}

	retain(): void {
		this.count++;
		this.schedule();
	}

	release(): void {
		this.count--;
		this.schedule();
	}

	private schedule(): void {
		pendingLifetimes.add(this);
		if (!lifetimeFlushQueued) {
			lifetimeFlushQueued = true;
			queueMicrotask(() => {
				lifetimeFlushQueued = false;
				flushLifetimeEffects();
			});
		}
	}

	sync(): void {
		pendingLifetimes.delete(this);
		const want = this.count > 0;
		if (want === this.active) return;
		this.active = want;
		if (want) {
			const a = this.atom;
			emitAndRun('observe', { atom: a.label ?? 'atom', node: a }, () => {
				this.cleanup = untracked(() =>
					this.fx({ get: () => a.baseValue(), set: (v) => a.write({ set: v }) }),
				);
			});
		} else {
			const prior = this.cleanup;
			this.cleanup = undefined;
			emitAndRun('unobserve', { atom: this.atom.label ?? 'atom', node: this.atom }, () => {
				if (typeof prior === 'function') untracked(prior);
			});
		}
	}
}

// ---------------------------------------------------------------------------
// External subscriptions (React bindings and other hosts)
// ---------------------------------------------------------------------------

/** `batch` is null for canonical changes, the drafting batch for world pokes. */
export type ExternalListener = (batch: WorldBatch | null) => void;

/**
 * A leaf consumer that forwards graph notifications to a host callback. It
 * participates in the subscriber graph like an effect (so computed chains
 * go live and lifetime effects see it), but never evaluates anything.
 */
export class ExternalSub implements Consumer {
	deps: Producer[];
	depVersions: NodeVersion[];
	depValues: unknown[] = [];
	flags = Flags.Live;

	constructor(
		private target: Producer,
		private listener: ExternalListener,
	) {
		this.deps = [target];
		this.depVersions = [target.version];
	}

	notify(_dirty: boolean): void {
		this.deliver(null);
	}

	deliver(batch: WorldBatch | null): void {
		this.listener(batch);
	}

	dispose(): void {
		if (this.flags & Flags.Disposed) return;
		this.flags |= Flags.Disposed;
		this.target.removeSub(this);
	}
}

/** Subscribe a host callback to a node; returns a disposer. */
export function subscribeNode(p: Producer, listener: ExternalListener): () => void {
	const s = new ExternalSub(p, listener);
	p.addSub(s);
	return () => s.dispose();
}

/**
 * Draft writes never touch the canonical graph, so world changes reach
 * hosts by walking the live subscriber graph from the touched node and
 * poking every external subscriber under it.
 */
function notifyExternal(node: Producer, batch: WorldBatch | null): void {
	if (batch === null) return; // canonical deliveries ride the subscriber graph
	worldPoke(node, batch, new Set());
}

function notifyWorldTouch(node: Producer, batch: WorldBatch | null): void {
	notifyExternal(node, batch);
}

function worldPoke(node: Producer, batch: WorldBatch, seen: Set<Producer>): void {
	if (seen.has(node)) return;
	seen.add(node);
	for (const c of [...node.subs]) {
		if (c instanceof ExternalSub) c.deliver(batch);
		else if (c instanceof ComputedNode) worldPoke(c, batch, seen);
	}
}

// ---------------------------------------------------------------------------
// Per-root committed views
// ---------------------------------------------------------------------------

/**
 * "What is on screen" for one React root. Canonical writes capture their
 * pre-write value into every registered view; a root's commit clears its
 * view, at which point the screen agrees with canonical state again.
 */
export class CommittedView {
	/** Atom -> the value the root's screen still shows. */
	pending = new Map<object, unknown>();

	commit(): void {
		this.pending.clear();
	}

	dispose(): void {
		committedViews.delete(this);
	}
}

const committedViews = new Set<CommittedView>();

export function createCommittedView(): CommittedView {
	const view = new CommittedView();
	committedViews.add(view);
	return view;
}

/** Set while a committed() read evaluates: atoms resolve through the view. */
let currentCommittedRead: CommittedView | null = null;

export function committedRead<T>(
	node: { read(): T },
	view: CommittedView | null,
): T {
	const prev = currentCommittedRead;
	currentCommittedRead = view;
	try {
		return untracked(() => node.read());
	} finally {
		currentCommittedRead = prev;
	}
}

// ---------------------------------------------------------------------------
// Test support
// ---------------------------------------------------------------------------

/** Drop all per-episode global state (open batches, queues, views). */
export function resetForTest(): void {
	for (const b of [...openBatches.values()]) abortBatch(b);
	effectQueue.length = 0;
	batchDepth = 0;
	committedViews.clear();
	pendingLifetimes.clear();
	setWriteGuard(null);
}
