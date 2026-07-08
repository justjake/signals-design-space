/**
 * signals-royale-fh1 engine core.
 *
 * The one idea: every write is a version-stamped record and every reader is a
 * visibility predicate evaluated over small per-signal write histories.
 *
 * - Canonical readers (plain `.get()`, effects) see the maintained canonical
 *   value: committed state plus urgent writes, applied in place, no folding.
 * - Deferred (transition) writes are draft records `(batch, seq, updater)`
 *   parked on the signal they target. They stay invisible to canonical readers
 *   until their batch retires, at which point each updater replays against the
 *   canonical value of that moment — so an urgent write that landed meanwhile
 *   is rebased under the drafts, never clobbered by them.
 * - A render pass reads through a World: a cutoff sequence latched when the
 *   pass started plus the list of deferred batches the host says the pass is
 *   rendering. The value it sees is a fold of the signal's history under that
 *   predicate, so sibling readers and replayed renders always agree.
 * - A per-root committed view is nothing but another predicate: the cutoff of
 *   the last render pass that root committed. No world tables, no overlay
 *   stores — worlds are functions of (batch, seq), and histories exist only
 *   while a concurrent episode is in flight. At quiescence everything folds
 *   back into the plain canonical value and the bookkeeping is released.
 */
import { emit, tracing, withCause, setCause, type EventId } from './tracer';

// ---- named number types -----------------------------------------------------

/** Global write counter; every canonical change gets one. Doubles as the
 * global "anything changed" version used to short-circuit poll validation. */
export type WriteSeq = number;
/** Identifies a deferred (transition) batch. 0 means "urgent / no batch". */
export type BatchId = number;

export const URGENT: BatchId = 0;

/** Reactive node validity: CLEAN certain, CHECK possibly stale, DIRTY certainly stale. */
const CLEAN = 0,
	CHECK = 1,
	DIRTY = 2;
type NodeState = 0 | 1 | 2;

const UNSET: unique symbol = Symbol('unset');
type Unset = typeof UNSET;

export type AnyAtom = Atom<unknown>;
export type AnyComputed = Computed<unknown>;
/* eslint-disable @typescript-eslint/no-explicit-any */
/** Public parameter type: any atom or computed, whatever its value type. */
export type Node<T = any> = Atom<T> | Computed<T>;
type Source = AnyAtom | AnyComputed;
type Observer = AnyComputed | Effect;

// ---- module state -----------------------------------------------------------

let writeSeq: WriteSeq = 1;
export function currentSeq(): WriteSeq {
	return writeSeq;
}

/** The observer currently collecting dependencies (canonical evaluation only). */
let activeSub: Observer | null = null;
/** Owner for effects created right now (an effect run or an effect scope). */
let activeOwner: Effect | EffectScope | null = null;
/** Non-null while a lazy initializer runs; writes are forbidden inside it. */
let initializing: AnyAtom | null = null;
/** Non-null while reads resolve against a speculative world instead of canon. */
let activeWorld: World | null = null;
/** The world-cache entry currently being evaluated (world dep recording). */
let activeWorldEntry: WorldEntry | null = null;

let batchDepth = 0;
const effectQueue: Effect[] = [];
let flushing = false;

/** Signals that grew episode bookkeeping (history/drafts), for reclamation. */
const logged = new Set<AnyAtom>();
/** Live deferred batches by id. */
export const liveBatches = new Map<BatchId, Batch>();
/** Open worlds (render passes in flight). Guides history retention. */
let openWorlds = 0;

/** Batch id override while `Batch.run` executes. */
let ambientBatch: Batch | null = null;

/** Resolves the batch a write issued right now belongs to. Installed by hosts
 * (React bindings); the default classifies everything as urgent. */
let stampProvider: () => Batch | null = () => null;
export function setStampProvider(fn: (() => Batch | null) | null): void {
	stampProvider = fn ?? (() => null);
}

/** Guard installed by hosts: called on every write so a host can reject
 * writes issued while it renders. */
let writeGuard: (() => void) | null = null;
export function setWriteGuard(fn: (() => void) | null): void {
	writeGuard = fn;
}

function writeBatch(): Batch | null {
	if (ambientBatch !== null && ambientBatch.state === 0) return ambientBatch;
	return stampProvider();
}

// ---- deferred batches ---------------------------------------------------------

let nextBatchId: BatchId = 1;

/** A deferred batch: the engine-level identity of one transition. Writes made
 * inside it are drafts; `retire()` replays them onto canonical state and
 * `discard()` drops them. Hosts map their own scheduling units onto batches. */
export class Batch {
	readonly id: BatchId;
	/** 0 live, 1 retired, 2 discarded. */
	state: 0 | 1 | 2 = 0;
	/** Atoms holding drafts of this batch. */
	atoms = new Set<AnyAtom>();
	/** Host-side identity (a React lane); opaque to the engine. */
	meta: unknown = null;
	openEv: EventId = 0;

	constructor() {
		this.id = nextBatchId++;
		liveBatches.set(this.id, this);
		if (tracing) this.openEv = emit('batch-open', `B${this.id}`);
	}

	/** Run `fn` with writes classified into this batch. */
	run<T>(fn: () => T): T {
		const prev = ambientBatch;
		ambientBatch = this;
		try {
			return fn();
		} finally {
			ambientBatch = prev;
		}
	}

	/** Replay this batch's drafts onto canonical state, oldest first. */
	retire(): void {
		if (this.state !== 0) return;
		this.state = 1;
		const retireEv = tracing ? emit('batch-retire', `B${this.id}`) : 0;
		const prevCause = setCause(retireEv);
		startBatch();
		try {
			for (const a of this.atoms) retireAtomBatch(a, this.id);
		} finally {
			this.atoms.clear();
			liveBatches.delete(this.id);
			setCause(prevCause);
			endBatch();
			maybeQuiesce();
		}
	}

	/** Drop this batch's drafts and re-notify anyone who saw them. */
	discard(): void {
		if (this.state !== 0) return;
		this.state = 2;
		// Discard is a visibility change: worlds listing this batch fold
		// differently now, so their caches must revalidate.
		writeSeq++;
		const ev = tracing ? emit('batch-discard', `B${this.id}`) : 0;
		const prevCause = setCause(ev);
		try {
			for (const a of this.atoms) {
				if (a.log !== null) {
					a.log = a.log.filter((r) => r.batch !== this.id);
				}
				pokeHooks(a, this.id, ev);
			}
		} finally {
			this.atoms.clear();
			liveBatches.delete(this.id);
			setCause(prevCause);
			maybeQuiesce();
		}
	}
}

export function createBatch(): Batch {
	return new Batch();
}

function episodeActive(): boolean {
	return liveBatches.size > 0 || openWorlds > 0;
}

/** Release per-episode bookkeeping once nothing speculative is in flight. */
function maybeQuiesce(): void {
	if (episodeActive()) return;
	for (const a of logged) {
		a.hist = null;
		a.log = null;
		a.episodeBase = undefined;
		a.episodeBaseSeq = 0;
	}
	logged.clear();
	for (const s of draftEdgeSources) {
		if (s.draftSubs !== null) pokeTargets -= s.draftSubs.size;
		s.draftSubs = null;
	}
	draftEdgeSources.clear();
}

// ---- history records --------------------------------------------------------

/** One logged write: an updater replayed in sequence order, exactly like a
 * React updater queue. Plain `set(v)` is the constant updater, so rebasing is
 * uniform. Urgent records (batch 0) are already applied to the canonical
 * value; they are logged only while the atom holds deferred drafts, because a
 * retiring batch must refold the WHOLE interleaved sequence — a transition
 * `+2` under an urgent `*2` lands as (base+2)*2, never canonical+2. */
interface LogRec {
	batch: BatchId;
	seq: WriteSeq;
	apply: (base: unknown) => unknown;
	/** Canonical seq this record folded at (0 while a draft is pending; urgent
	 * records use 0 too — their effect is already canonical). A world whose
	 * cutoff is at or past this already sees the fold in canonical history. */
	folded: WriteSeq;
}

/** Canonical timeline entry: the canonical value in effect from `seq` on. */
interface HistRec {
	seq: WriteSeq;
	value: unknown;
}

function valueAt(hist: HistRec[], cutoff: WriteSeq): unknown {
	for (let i = hist.length - 1; i >= 0; i--) {
		if (hist[i].seq <= cutoff) return hist[i].value;
	}
	return hist[0].value;
}

/** Record canonical history for `a` if any world may still need old values. */
function recordHist(a: AnyAtom): void {
	if (!episodeActive()) return;
	if (a.hist === null) {
		a.hist = [{ seq: 0, value: a.v }];
		logged.add(a);
	}
}

// ---- async: thenable records and pending boxes --------------------------------

/** Thrown by read sites while an evaluation waits on unresolved thenables.
 * Reference-stable per thenable, so hosts can key retries on it. */
export class PendingValue extends Error {
	constructor(readonly thenable: PromiseLike<unknown>) {
		super('signal value is pending');
		this.name = 'PendingValue';
	}
}

interface ThenRec {
	status: 0 | 1 | 2;
	value: unknown;
	reason: unknown;
	box: PendingValue;
	/** Batch that owns the evaluation which first touched this thenable. */
	owner: BatchId;
	/** Canonical computeds parked on this thenable. */
	waiters: Set<AnyComputed>;
}

const thenRecs = new WeakMap<PromiseLike<unknown>, ThenRec>();

function thenRecord(t: PromiseLike<unknown>): ThenRec {
	let rec = thenRecs.get(t);
	if (rec === undefined) {
		const owner = activeWorld !== null && activeWorld.batches.length > 0
			? activeWorld.batches[0]
			: (writeBatch()?.id ?? URGENT);
		rec = { status: 0, value: undefined, reason: undefined, box: new PendingValue(t), owner, waiters: new Set() };
		thenRecs.set(t, rec);
		const r = rec;
		t.then(
			(v) => settleThenable(r, 1, v),
			(e) => settleThenable(r, 2, e),
		);
	}
	return rec;
}

/** Settlement behaves as a write: it invalidates parked evaluations and
 * notifies their subscribers, attributed to the batch that owns the fetch. */
function settleThenable(rec: ThenRec, status: 1 | 2, val: unknown): void {
	if (rec.status !== 0) return;
	rec.status = status;
	if (status === 1) rec.value = val;
	else rec.reason = val;
	writeSeq++; // world caches and poll caches revalidate
	const ev = tracing ? emit('settle', undefined, { owner: rec.owner, status }) : 0;
	const prevCause = setCause(ev);
	startBatch();
	try {
		for (const c of rec.waiters) {
			if (c.pend === rec.box) {
				c.state = DIRTY;
				markObs(c, CHECK);
			}
			pokeHooks(c, rec.owner, ev);
		}
	} finally {
		rec.waiters.clear();
		setCause(prevCause);
		endBatch();
	}
}

export type Use = {
	<U>(t: PromiseLike<U>): U;
	<U>(key: unknown, factory: () => PromiseLike<U> | U): U;
};

interface UseEntry {
	thenable: PromiseLike<unknown> | null;
	value: unknown;
	settled: boolean;
}

// ---- worlds -----------------------------------------------------------------

/** A visibility predicate: canonical history up to `cutoff`, plus the drafts
 * of the listed deferred batches replayed on top. */
export class World {
	readonly cutoff: WriteSeq;
	readonly batches: BatchId[];
	/** Computeds holding a cached evaluation for this world, for release. */
	touched: Set<AnyComputed> | null = null;
	released = false;

	constructor(batches: BatchId[], cutoff: WriteSeq = writeSeq) {
		this.cutoff = cutoff;
		this.batches = batches;
		openWorlds++;
	}

	release(): void {
		if (this.released) return;
		this.released = true;
		openWorlds--;
		if (this.touched !== null) {
			for (const c of this.touched) releaseWorldEntry(c, this);
			this.touched = null;
		}
		maybeQuiesce();
	}
}

interface WorldEntry {
	w: World;
	/** Outcome: value, error, or pending. */
	v: unknown;
	err: unknown | Unset;
	pend: PendingValue | null;
	/** Sources this world evaluation read, with the outcome token each
	 * produced, for validity re-checks. */
	deps: Source[];
	depVals: unknown[];
	validAt: WriteSeq;
	uses: UseEntry[] | null;
}

export function inWorld<T>(world: World | null, fn: () => T): T {
	const prevWorld = activeWorld;
	const prevSub = activeSub;
	activeWorld = world;
	activeSub = null;
	try {
		return fn();
	} finally {
		activeWorld = prevWorld;
		activeSub = prevSub;
	}
}

export function getActiveWorld(): World | null {
	return activeWorld;
}

// ---- atoms --------------------------------------------------------------------

export interface AtomOptions<T> {
	equals?: (a: T, b: T) => boolean;
	label?: string;
	/** Observed-lifecycle callback: runs while the atom has at least one
	 * subscriber of any kind; the returned cleanup runs when the last leaves. */
	effect?: (ctx: { get(): T; set(v: T): void }) => void | (() => void);
}

function refEq(a: unknown, b: unknown): boolean {
	return Object.is(a, b);
}

export class Atom<T> {
	readonly k = 0 as const;
	label: string | undefined;
	eq: (a: T, b: T) => boolean;
	/** Canonical value. Meaningless until `inited`. */
	v: T = undefined as T;
	ver = 0;
	inited: boolean;
	init: (() => T) | null;
	hist: HistRec[] | null = null;
	/** Interleaved updater log; non-null exactly while deferred drafts target
	 * this atom (and until quiescence reclaims it). */
	log: LogRec[] | null = null;
	/** Canonical value and seq when the log opened: the replay base. */
	episodeBase: unknown = undefined;
	episodeBaseSeq: WriteSeq = 0;
	obs: Observer[] = [];
	obSlots: number[] = [];
	hookSubs: Set<HookPoke> | null = null;
	draftSubs: Set<AnyComputed> | null = null;
	onObserved: ((ctx: { get(): T; set(v: T): void }) => void | (() => void)) | undefined;
	obCleanup: (() => void) | null = null;
	pokedAt = 0;
	lastDeliveryEv: EventId = 0;

	constructor(initial: T | (() => T), opts?: AtomOptions<T>) {
		this.eq = opts?.equals ?? refEq;
		this.label = opts?.label;
		this.onObserved = opts?.effect;
		if (typeof initial === 'function') {
			this.init = initial as () => T;
			this.inited = false;
		} else {
			this.v = initial;
			this.init = null;
			this.inited = true;
		}
	}

	get(): T {
		if (activeWorld !== null) return foldAtom(this as AnyAtom, activeWorld) as T;
		materialize(this as AnyAtom);
		trackRead(this as AnyAtom);
		return this.v;
	}

	peek(): T {
		materialize(this as AnyAtom);
		return this.v;
	}

	set(v: T): void {
		writeAtom(this as AnyAtom, null, v);
	}

	update(fn: (prev: T) => T): void {
		writeAtom(this as AnyAtom, fn as (p: unknown) => unknown, undefined);
	}
}

/** Run the lazy initializer at first materialization: first read, write, or
 * subscription — never construction. Untracked, and forbidden from writing. */
function materialize(a: AnyAtom): void {
	if (a.inited) return;
	a.inited = true;
	const init = a.init!;
	a.init = null;
	const prevSub = activeSub;
	const prevInit = initializing;
	activeSub = null;
	initializing = a;
	try {
		a.v = init();
	} finally {
		activeSub = prevSub;
		initializing = prevInit;
	}
}

/** Install a value without running the initializer and without counting as a
 * write: no notification, no history, no equality check (SSR hydration). */
export function installValue<T>(a: Atom<T>, v: T): void {
	a.inited = true;
	a.init = null;
	a.v = v;
}

function writeAtom(a: AnyAtom, fn: ((prev: unknown) => unknown) | null, v: unknown): void {
	if (initializing !== null) {
		throw new Error('a lazy initializer must not write to signals');
	}
	if (writeGuard !== null) writeGuard();
	const b = writeBatch();
	materialize(a);
	const apply = fn === null ? () => v : fn;
	if (b === null) {
		const next = fn === null ? v : fn(a.v);
		if (a.log !== null) {
			// Drafts are pending: log the urgent updater so a retiring batch can
			// replay the whole interleaved sequence on the episode base.
			a.log.push({ batch: URGENT, seq: ++writeSeq, apply, folded: 0 });
			if (a.eq(a.v, next)) {
				// Canonical value unchanged, but batch-bearing worlds now fold
				// differently: revalidate and re-poke them.
				const ev = tracing ? emit('write', a.label, { batch: URGENT }) : 0;
				pokeHooks(a, URGENT, ev);
				return;
			}
		} else if (a.eq(a.v, next)) {
			// Urgent with no episode in flight: equal writes drop entirely.
			return;
		}
		applyCanonical(a, next, URGENT);
		flushEffects();
	} else {
		// Deferred: park a draft; canonical readers and effects see nothing yet.
		if (a.log === null) {
			a.log = [];
			a.episodeBase = a.v;
			a.episodeBaseSeq = writeSeq;
		}
		a.log.push({ batch: b.id, seq: ++writeSeq, apply, folded: 0 });
		b.atoms.add(a);
		logged.add(a);
		const ev = tracing ? emit('write', a.label, { batch: b.id, draft: true }) : 0;
		pokeHooks(a, b.id, ev);
	}
}

/** Apply a canonical change: bump versions, record history, propagate. */
function applyCanonical(a: AnyAtom, next: unknown, stamp: BatchId): void {
	recordHist(a);
	a.v = next;
	a.ver++;
	const seq = ++writeSeq;
	if (a.hist !== null) a.hist.push({ seq, value: next });
	const ev = tracing ? emit('write', a.label, { batch: stamp }) : 0;
	startBatch();
	try {
		markObs(a, CHECK);
		pokeHooks(a, stamp, ev);
	} finally {
		endBatch();
	}
}

/** Retire one batch's records on an atom: mark them folded, then refold the
 * canonical value from the episode base over every canonical-class record in
 * sequence order — React updater-queue replay, so an urgent updater that
 * landed after a draft re-executes on top of the rebased value. Records are
 * kept (marked) so a world latched before the fold still resolves; quiescence
 * reclaims them. */
function retireAtomBatch(a: AnyAtom, bid: BatchId): void {
	const log = a.log;
	if (log === null) return;
	let any = false;
	for (const r of log) {
		if (r.batch === bid && r.folded === 0) {
			r.folded = writeSeq + 1;
			any = true;
		}
	}
	if (!any) return;
	let v = a.episodeBase;
	for (const r of log) {
		if (r.batch === URGENT || r.folded !== 0) v = r.apply(v);
	}
	if (!a.eq(a.v, v)) {
		applyCanonical(a, v, bid);
	} else {
		// Value unchanged: still re-poke so speculative readers re-converge.
		pokeHooks(a, URGENT, 0);
	}
}

/** Newest intent: the full log (drafts included) replayed on the episode base. */
function latestAtom(a: AnyAtom): unknown {
	materialize(a);
	if (a.log === null) return a.v;
	let v = a.episodeBase;
	for (const r of a.log) v = r.apply(v);
	return v;
}

/** Fold an atom under a world's visibility predicate. */
function foldAtom(a: AnyAtom, w: World): unknown {
	materialize(a);
	let v: unknown;
	const log = a.log;
	if (log === null || w.batches.length === 0) {
		// Pure cutoff predicate: a point on the canonical timeline.
		v = a.v;
		if (a.hist !== null && a.hist.length > 0 && a.hist[a.hist.length - 1].seq > w.cutoff) {
			v = valueAt(a.hist, w.cutoff);
		}
	} else if (w.cutoff < a.episodeBaseSeq) {
		// The pass latched before this atom's log opened: canonical value at the
		// cutoff plus the listed batches' drafts on top.
		v = a.hist !== null ? valueAt(a.hist, w.cutoff) : a.episodeBase;
		for (const r of log) {
			if (r.batch !== URGENT && w.batches.indexOf(r.batch) >= 0) v = r.apply(v);
		}
	} else {
		// Interleaved replay from the episode base: urgent records up to the
		// cutoff, plus records of the listed batches (and folds the cutoff saw).
		v = a.episodeBase;
		for (const r of log) {
			const visible =
				r.batch === URGENT
					? r.seq <= w.cutoff
					: (r.folded !== 0 && r.folded <= w.cutoff) || w.batches.indexOf(r.batch) >= 0;
			if (visible) v = r.apply(v);
		}
	}
	if (activeWorldEntry !== null) recordWorldDep(a, v);
	return v;
}

// ---- linking (activation model) -----------------------------------------------
//
// Every evaluation records its forward dependency list (`srcs` + the version it
// saw). Back edges (`obs`) exist only along observed chains — from a source up
// to effects and host subscriptions — so a computed nobody watches holds no
// entry in any signal's observer list and stays collectable. Observed nodes are
// invalidated by pushes; unobserved computeds validate by polling versions.

function isLive(n: Observer): boolean {
	if (n.k === 2) return !n.disposed;
	return n.obs.length > 0 || (n.hookSubs !== null && n.hookSubs.size > 0);
}

function linkBack(src: Source, sub: Observer, i: number): void {
	sub.srcSlots[i] = src.obs.length;
	src.obs.push(sub);
	src.obSlots.push(i);
	if (src.obs.length === 1) {
		if (src.k === 1) activate(src);
		else observedMaybeChanged(src);
	}
}

/** While a re-evaluation is in flight, sources that momentarily lose their
 * last observer wait here: most are re-read (and re-linked) by the same
 * evaluation, so tearing their own subtrees down eagerly would cascade a
 * deactivate/activate wave down every chain on every recompute. */
const deferredStack: Source[] = [];
let deferredDepth = 0;

function unlinkBack(src: Source, sub: Observer, i: number): void {
	const slot = sub.srcSlots[i];
	if (slot < 0) return;
	sub.srcSlots[i] = -1;
	const lastObs = src.obs.pop()!;
	const lastSlot = src.obSlots.pop()!;
	if (slot < src.obs.length) {
		src.obs[slot] = lastObs;
		src.obSlots[slot] = lastSlot;
		lastObs.srcSlots[lastSlot] = slot;
	}
	if (src.obs.length === 0) {
		if (deferredDepth > 0) {
			deferredStack.push(src);
		} else {
			settleUnobserved(src);
		}
	}
}

function settleUnobserved(src: Source): void {
	if (src.obs.length !== 0) return;
	if (src.k === 1) {
		if (src.hookSubs === null || src.hookSubs.size === 0) deactivate(src);
	} else {
		observedMaybeChanged(src);
	}
}

/** A computed gained its first observer: join the push graph. Push marks are
 * trusted only from here on: the node enters CLEAN only when its poll
 * validation is current, otherwise it stays suspect until the next read. */
function activate(c: AnyComputed): void {
	const srcs = c.srcs;
	for (let i = 0; i < srcs.length; i++) linkBack(srcs[i], c, i);
	c.state = c.checked === writeSeq && c.ver !== 0 ? CLEAN : CHECK;
}

/** A computed lost its last observer: leave the push graph, revert to polling. */
function deactivate(c: AnyComputed): void {
	const srcs = c.srcs;
	for (let i = 0; i < srcs.length; i++) unlinkBack(srcs[i], c, i);
	c.checked = 0;
	c.state = CHECK;
}

/** Drop an observer's dependency records (and back edges when present). */
function clearSources(sub: Observer): void {
	const srcs = sub.srcs;
	for (let i = 0; i < srcs.length; i++) {
		if (sub.srcSlots[i] >= 0) unlinkBack(srcs[i], sub, i);
	}
	srcs.length = 0;
	sub.srcVers.length = 0;
	sub.srcSlots.length = 0;
}

/** Record `src` as a dependency of the currently evaluating observer. For an
 * atom the token is its value (a write that reverts inside a batch compares
 * equal and never propagates); for a computed it is the version counter its
 * equality cutoff maintains.
 *
 * Re-evaluations match the previous dependency list positionally: when the
 * i-th read is the same source as last time — the overwhelmingly common case
 * — the existing edge is reused untouched. Only an actual divergence unlinks
 * the stale tail and rebuilds from there. */
function trackRead(src: Source): void {
	const sub = activeSub;
	if (sub === null) return;
	const i = sub.trackCursor;
	const srcs = sub.srcs;
	if (i < srcs.length) {
		if (srcs[i] === src) {
			sub.srcVers[i] = src.k === 0 ? src.v : src.ver;
			sub.trackCursor = i + 1;
			return;
		}
		trimSourcesFrom(sub, i);
	}
	sub.trackCursor = i + 1;
	srcs.push(src);
	sub.srcVers.push(src.k === 0 ? src.v : src.ver);
	sub.srcSlots.push(-1);
	if (sub.k === 2 || isLive(sub)) linkBack(src, sub, i);
}

/** Unlink and drop dependency records from position `from` on. */
function trimSourcesFrom(sub: Observer, from: number): void {
	const srcs = sub.srcs;
	for (let j = from; j < srcs.length; j++) {
		if (sub.srcSlots[j] >= 0) unlinkBack(srcs[j], sub, j);
	}
	srcs.length = from;
	sub.srcVers.length = from;
	sub.srcSlots.length = from;
}

// ---- canonical computed algorithm ----------------------------------------------

export interface ComputedOptions<T> {
	equals?: (a: T, b: T) => boolean;
	label?: string;
}

export class Computed<T> {
	readonly k = 1 as const;
	label: string | undefined;
	fn: (use: Use) => T;
	eq: (a: T, b: T) => boolean;
	v: T | Unset = UNSET;
	ver = 0;
	state: NodeState = DIRTY;
	/** writeSeq at last poll validation (unobserved caching shortcut). */
	checked: WriteSeq = 0;
	srcs: Source[] = [];
	srcVers: unknown[] = [];
	srcSlots: number[] = [];
	trackCursor = 0;
	obs: Observer[] = [];
	obSlots: number[] = [];
	hookSubs: Set<HookPoke> | null = null;
	draftSubs: Set<AnyComputed> | null = null;
	err: unknown | Unset = UNSET;
	pend: PendingValue | null = null;
	/** Last successfully settled value, served by `latest` while pending. */
	settled: T | Unset = UNSET;
	/** Keyed `use` cache, scoped to this node's lifetime and refresh epoch. */
	useCache: Map<number, Map<unknown, UseEntry>> | null = null;
	/** Cached canonical `use` argument (world evaluations build their own). */
	useFn: Use | null = null;
	/** Hidden refresh input: bumping it re-runs the evaluation with cleared
	 * keyed-use entries. Created on first `refresh`. */
	epoch: Atom<number> | null = null;
	epochSeen = 0;
	/** Thenables of refetches started by `refresh`; pruned once settled. */
	refreshing: Set<PromiseLike<unknown>> | null = null;
	wc: WorldEntry[] | null = null;
	computing = false;
	pokedAt = 0;
	lastDeliveryEv: EventId = 0;

	constructor(fn: (use: Use) => T, opts?: ComputedOptions<T>) {
		this.fn = fn;
		this.eq = opts?.equals ?? refEq;
		this.label = opts?.label;
	}

	get(): T {
		const self = this as AnyComputed;
		if (activeWorld !== null) return readComputedInWorld(self, activeWorld) as T;
		if (this.computing) throw new Error('cycle detected: computed reads itself');
		try {
			updateIfNecessary(self);
		} finally {
			trackRead(self);
		}
		if (self.err !== UNSET) throw self.err;
		if (self.pend !== null) throw self.pend;
		return this.v as T;
	}

	peek(): T {
		return untracked(() => this.get());
	}
}

/** True when any recorded source produced a different version than the one this
 * observer saw; pulls computed sources up to date first. */
function sourcesChanged(sub: Observer): boolean {
	const srcs = sub.srcs;
	for (let i = 0; i < srcs.length; i++) {
		const s = srcs[i];
		if (s.k === 0) {
			if (!s.eq(sub.srcVers[i], s.v)) return true;
		} else {
			updateIfNecessary(s);
			if (s.ver !== sub.srcVers[i]) return true;
		}
	}
	return false;
}

function updateIfNecessary(c: AnyComputed): void {
	if (isLive(c)) {
		if (c.state === CLEAN && !pendSettled(c)) return;
		if (c.state !== DIRTY && c.ver !== 0 && !pendSettled(c) && !sourcesChanged(c)) {
			c.state = CLEAN;
			return;
		}
		const before = writeSeq;
		recompute(c);
		// A write issued by the evaluation itself leaves the node suspect so
		// the next read re-validates against the post-write source values.
		c.state = writeSeq === before ? CLEAN : CHECK;
	} else {
		if (c.state !== DIRTY && c.checked === writeSeq && c.ver !== 0) return;
		if (c.state !== DIRTY && c.ver !== 0 && !pendSettled(c) && !sourcesChanged(c)) {
			c.checked = writeSeq;
			return;
		}
		const before = writeSeq;
		recompute(c);
		c.checked = writeSeq === before ? writeSeq : 0;
		c.state = CHECK;
	}
}

/** A parked evaluation whose thenable settled must re-run on next read even if
 * no tracked source changed (read-site self-heal). */
function pendSettled(c: AnyComputed): boolean {
	return c.pend !== null && thenRecord(c.pend.thenable).status !== 0;
}

function recompute(c: AnyComputed): void {
	const prevSub = activeSub;
	const prevOwner = activeOwner;
	const deferredMark = deferredStack.length;
	deferredDepth++;
	c.trackCursor = 0;
	c.computing = true;
	activeSub = c;
	activeOwner = null;
	const hadValue = c.ver !== 0;
	try {
		let epochVal = 0;
		if (c.epoch !== null) {
			epochVal = c.epoch.get();
			if (epochVal !== c.epochSeen) {
				// A refresh landed canonically: older epochs' keyed fetches are dead.
				if (c.useCache !== null) {
					for (const key of c.useCache.keys()) if (key < epochVal) c.useCache.delete(key);
				}
				c.epochSeen = epochVal;
			}
		}
		activeUseEpoch = epochVal;
		const v = c.fn((c.useFn ??= makeUse(c, null)));
		c.err = UNSET;
		c.pend = null;
		if (!hadValue || c.v === UNSET || !c.eq(c.v, v)) {
			c.v = v;
			c.ver++;
		}
		c.settled = c.v;
	} catch (e) {
		if (e instanceof PendingValue) {
			// Evaluates-to-pending: graph state, not control flow.
			if (c.pend !== e) {
				c.pend = e;
				c.ver++;
			}
			c.err = UNSET;
		} else {
			c.err = e;
			c.pend = null;
			c.ver++;
		}
	} finally {
		c.computing = false;
		activeSub = prevSub;
		activeOwner = prevOwner;
		if (c.trackCursor < c.srcs.length) trimSourcesFrom(c, c.trackCursor);
		deferredDepth--;
		for (let i = deferredStack.length - 1; i >= deferredMark; i--) {
			settleUnobserved(deferredStack[i]);
		}
		deferredStack.length = deferredMark;
	}
}

// ---- effects and scopes ---------------------------------------------------------

let nextEffectSerial = 1;

export class Effect {
	readonly k = 2 as const;
	/** Creation order; notifications fire in this order regardless of how
	 * observer lists were re-packed by earlier unlinks. */
	serial = nextEffectSerial++;
	fn: () => unknown;
	cleanup: (() => void) | null = null;
	state: NodeState = DIRTY;
	srcs: Source[] = [];
	srcVers: unknown[] = [];
	srcSlots: number[] = [];
	trackCursor = 0;
	/** Effects and scopes created during this effect's run; disposed on re-run. */
	kids: (Effect | EffectScope)[] | null = null;
	disposed = false;
	queued = false;
	label: string | undefined;

	constructor(fn: () => unknown, label?: string) {
		this.fn = fn;
		this.label = label;
		if (activeOwner !== null) (activeOwner.kids ??= []).push(this);
		this.run();
	}

	run(): void {
		if (this.disposed) return;
		disposeKids(this);
		const cleanup = this.cleanup;
		this.cleanup = null;
		if (cleanup !== null) runCleanup(cleanup);
		const deferredMark = deferredStack.length;
		deferredDepth++;
		this.trackCursor = 0;
		this.state = CLEAN;
		const prevSub = activeSub;
		const prevOwner = activeOwner;
		activeSub = this;
		activeOwner = this;
		const ev = tracing ? emit('effect-run', this.label) : 0;
		const prevCause = ev !== 0 ? setCause(ev) : -1;
		try {
			const ret = this.fn();
			if (typeof ret === 'function') this.cleanup = ret as () => void;
		} finally {
			activeSub = prevSub;
			activeOwner = prevOwner;
			if (prevCause !== -1) setCause(prevCause);
			if (this.trackCursor < this.srcs.length) trimSourcesFrom(this, this.trackCursor);
			deferredDepth--;
			for (let i = deferredStack.length - 1; i >= deferredMark; i--) {
				settleUnobserved(deferredStack[i]);
			}
			deferredStack.length = deferredMark;
		}
	}

	maybeRun(): void {
		this.queued = false;
		if (this.disposed || this.state === CLEAN) return;
		if (this.state === CHECK && !sourcesChanged(this)) {
			this.state = CLEAN;
			return;
		}
		this.run();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		disposeKids(this);
		const cleanup = this.cleanup;
		this.cleanup = null;
		if (cleanup !== null) {
			// Disposal must complete even when a cleanup throws; the effect is
			// gone either way, and the graph edges below still need releasing.
			try {
				runCleanup(cleanup);
			} catch {
				// Swallowed: there is no live consumer left to route this to.
			}
		}
		clearSources(this);
	}
}

export class EffectScope {
	kids: (Effect | EffectScope)[] | null = null;
	disposed = false;

	constructor(fn: () => void) {
		if (activeOwner !== null) (activeOwner.kids ??= []).push(this);
		const prevOwner = activeOwner;
		const prevSub = activeSub;
		activeOwner = this;
		activeSub = null;
		try {
			fn();
		} finally {
			activeOwner = prevOwner;
			activeSub = prevSub;
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		disposeKids(this);
	}
}

function disposeKids(owner: Effect | EffectScope): void {
	const kids = owner.kids;
	if (kids === null) return;
	owner.kids = null;
	for (const kid of kids) kid.dispose();
}

/** Cleanups run outside every tracking and ownership context. */
function runCleanup(cleanup: () => void): void {
	const prevSub = activeSub;
	const prevOwner = activeOwner;
	activeSub = null;
	activeOwner = null;
	startBatch();
	try {
		cleanup();
	} finally {
		activeSub = prevSub;
		activeOwner = prevOwner;
		endBatch();
	}
}

export function effect(fn: () => unknown, label?: string): () => void {
	const e = new Effect(fn, label);
	return () => e.dispose();
}

export function effectScope(fn: () => void): () => void {
	const s = new EffectScope(fn);
	return () => s.dispose();
}

// ---- propagation ------------------------------------------------------------

/** Mark direct observers at least `state`; deeper suspects get CHECK. */
function markObs(source: Source, state: NodeState): void {
	const obs = source.obs;
	for (let i = 0; i < obs.length; i++) {
		const o = obs[i];
		if (o.k === 2) {
			if (o.state < state) o.state = state;
			if (!o.queued) {
				o.queued = true;
				effectQueue.push(o);
			}
		} else if (o.state < state) {
			const was = o.state;
			o.state = state;
			if (was === CLEAN) markObs(o, CHECK);
		}
	}
}

function flushEffects(): void {
	if (flushing || batchDepth > 0) return;
	flushing = true;
	effectQueue.sort((a, b) => a.serial - b.serial);
	try {
		for (let i = 0; i < effectQueue.length; i++) {
			if (i > 100_000) throw new Error('effect flush did not settle (cyclic writes?)');
			try {
				effectQueue[i].maybeRun();
			} catch (e) {
				// One effect throwing must not starve the rest of the queue.
				reportUncaught(e);
			}
		}
	} finally {
		effectQueue.length = 0;
		flushing = false;
	}
}

let pendingError: unknown | Unset = UNSET;
function reportUncaught(e: unknown): void {
	if (pendingError === UNSET) pendingError = e;
}

export function startBatch(): void {
	batchDepth++;
}

export function endBatch(): void {
	if (--batchDepth === 0) {
		flushEffects();
		if (pendingError !== UNSET) {
			const e = pendingError;
			pendingError = UNSET;
			throw e;
		}
	}
}

export function batch<T>(fn: () => T): T {
	startBatch();
	try {
		return fn();
	} finally {
		endBatch();
	}
}

export function untracked<T>(fn: () => T): T {
	const prev = activeSub;
	activeSub = null;
	try {
		return fn();
	} finally {
		activeSub = prev;
	}
}

// ---- hook subscriptions -----------------------------------------------------

/** A host-level subscription (a React hook). Pokes are delivered synchronously
 * in the writer's calling context so a host setState issued from the callback
 * inherits the write's own scheduling class (urgent stays urgent, a transition
 * write schedules inside the transition). The stamp names the batch whose
 * visibility changed; `ev` is the trace event that caused the delivery. */
export type HookPoke = (stamp: BatchId, ev: EventId) => void;

let pokeEpoch = 0;
/** Total host subscriptions + draft edges; zero means pokes have no possible
 * receiver and the graph walk is skipped entirely. */
let pokeTargets = 0;

/** Walk observer edges plus this-episode draft edges from `origin`, delivering
 * one poke per subscribed node. Draft edges exist because a world evaluation
 * may depend on signals its canonical evaluation does not. */
function pokeHooks(origin: Source, stamp: BatchId, causeEv: EventId): void {
	if (pokeTargets === 0) return;
	const epoch = ++pokeEpoch;
	const prevCause = causeEv !== 0 ? setCause(causeEv) : -1;
	const stack: Source[] = [origin];
	while (stack.length > 0) {
		const n = stack.pop()!;
		if (n.pokedAt === epoch) continue;
		n.pokedAt = epoch;
		if (n.hookSubs !== null && n.hookSubs.size > 0) {
			const ev = tracing ? emit('delivery', n.label, { batch: stamp }) : 0;
			n.lastDeliveryEv = ev;
			const prevCause = ev !== 0 ? setCause(ev) : -1;
			// Copy: a poke may subscribe/unsubscribe reentrantly.
			for (const cb of [...n.hookSubs]) cb(stamp, ev);
			if (prevCause !== -1) setCause(prevCause);
		}
		const obs = n.obs;
		for (let i = 0; i < obs.length; i++) {
			const o = obs[i];
			if (o.k === 1) stack.push(o);
		}
		if (n.draftSubs !== null) {
			for (const c of n.draftSubs) stack.push(c);
		}
	}
	if (prevCause !== -1) setCause(prevCause);
}

/** Subscribe a host callback to change pokes on an atom or computed. Counts as
 * an observation for the observed lifecycle and keeps computed chains live. */
export function subscribeHook(xx: Node, cb: HookPoke): () => void {
	const x = xx as Source;
	const wasLive = x.k === 1 && isLive(x);
	(x.hookSubs ??= new Set()).add(cb);
	pokeTargets++;
	if (x.k === 1) {
		if (!wasLive && x.obs.length === 0) activate(x);
	} else {
		observedMaybeChanged(x);
	}
	return () => {
		if (x.hookSubs === null || !x.hookSubs.has(cb)) return;
		x.hookSubs.delete(cb);
		pokeTargets--;
		if (x.hookSubs.size === 0) {
			if (x.k === 1) {
				if (x.obs.length === 0) deactivate(x);
			} else {
				observedMaybeChanged(x);
			}
		}
	};
}

// ---- observed lifecycle (lifetime effects) ----------------------------------

/** Atoms whose observation count flapped this tick; settled in a microtask so
 * subscribe/unsubscribe churn (StrictMode double-mount) nets out. */
const observedDirty = new Set<AnyAtom>();
let observedScheduled = false;

function observedMaybeChanged(node: Source): void {
	if (node.k !== 0) return;
	if (node.onObserved === undefined) return;
	observedDirty.add(node);
	if (!observedScheduled) {
		observedScheduled = true;
		queueMicrotask(settleObserved);
	}
}

function settleObserved(): void {
	observedScheduled = false;
	for (const a of observedDirty) {
		const wanted = a.obs.length > 0 || (a.hookSubs !== null && a.hookSubs.size > 0);
		if (wanted && a.obCleanup === null) {
			materialize(a);
			const ctx = {
				get: () => untracked(() => a.get()),
				set: (v: unknown) => a.set(v),
			};
			a.obCleanup = a.onObserved!(ctx) ?? noopCleanup;
			if (tracing) emit('observe', a.label);
		} else if (!wanted && a.obCleanup !== null) {
			const cleanup = a.obCleanup;
			a.obCleanup = null;
			if (cleanup !== noopCleanup) cleanup();
			if (tracing) emit('unobserve', a.label);
		}
	}
	observedDirty.clear();
}

function noopCleanup(): void {}

/** Test/host helper: run the debounced observation settlement now. */
export function settleObservationsNow(): void {
	settleObserved();
}

// ---- use(): async reads inside computed evaluations ---------------------------

/** Epoch scope for the keyed `use` cache of the evaluation in flight. */
let activeUseEpoch = 0;

function makeUse(c: AnyComputed, entry: WorldEntry | null): Use {
	return (<U>(a: PromiseLike<U> | unknown, factory?: () => PromiseLike<U> | U): U => {
		const epochVal = activeUseEpoch;
		let t: PromiseLike<unknown>;
		if (factory !== undefined) {
			// Keyed form: the cache entry lives as long as the node (scoped by
			// refresh epoch), so a re-run with the same key reuses the in-flight
			// thenable — fetch counts stay stable across retries — or replays the
			// settled outcome. `refresh` bumps the epoch, so factories re-run.
			const epochCache = (c.useCache ??= new Map());
			let cache = epochCache.get(epochVal);
			if (cache === undefined) {
				cache = new Map();
				epochCache.set(epochVal, cache);
			}
			let ue = cache.get(a);
			if (ue === undefined) {
				const made = untracked(factory);
				if (typeof (made as PromiseLike<U>)?.then !== 'function') {
					ue = { thenable: null, value: made, settled: true };
					cache.set(a, ue);
					return made as U;
				}
				ue = { thenable: made as PromiseLike<unknown>, value: undefined, settled: false };
				cache.set(a, ue);
			}
			if (ue.thenable === null) return ue.value as U;
			t = ue.thenable;
		} else {
			t = a as PromiseLike<unknown>;
		}
		const rec = thenRecord(t);
		if (rec.status === 1) return rec.value as U;
		if (rec.status === 2) throw rec.reason;
		rec.waiters.add(c);
		throw rec.box;
	}) as Use;
}

// ---- world evaluation ---------------------------------------------------------

/** Sources that carry draft edges this episode, for wholesale release. */
const draftEdgeSources = new Set<Source>();

/** The computed whose world entry is currently evaluating. */
let activeWorldConsumer: AnyComputed | null = null;

/** Record `src` as a dependency of the world entry being evaluated, and give
 * `src` a draft edge back to the consumer so pokes route through speculative
 * dependency sets that canonical evaluation does not have. */
function recordWorldDep(src: Source, token: unknown): void {
	const entry = activeWorldEntry!;
	entry.deps.push(src);
	entry.depVals.push(token);
	const consumer = activeWorldConsumer;
	if (consumer !== null && consumer !== src) {
		const subs = (src.draftSubs ??= new Set());
		if (!subs.has(consumer)) {
			subs.add(consumer);
			pokeTargets++;
		}
		draftEdgeSources.add(src);
	}
}

/** Resolve a source's outcome under `w` as a comparable token: the value it
 * produces, or the error/pending box it throws. */
function worldToken(src: Source, w: World): unknown {
	if (src.k === 0) return foldAtom(src, w);
	try {
		return readComputedInWorld(src, w);
	} catch (e) {
		return e;
	}
}

function worldDepsMatch(entry: WorldEntry, w: World): boolean {
	if (entry.validAt < 0) return false;
	if (entry.pend !== null && thenRecord(entry.pend.thenable).status !== 0) return false;
	const prevEntry = activeWorldEntry;
	activeWorldEntry = null;
	try {
		for (let i = 0; i < entry.deps.length; i++) {
			if (!Object.is(worldToken(entry.deps[i], w), entry.depVals[i])) return false;
		}
	} finally {
		activeWorldEntry = prevEntry;
	}
	return true;
}

function readComputedInWorld(c: AnyComputed, w: World): unknown {
	let entry: WorldEntry | undefined;
	if (c.wc !== null) {
		for (const e of c.wc) {
			if (e.w === w) {
				entry = e;
				break;
			}
		}
	}
	if (entry !== undefined && entry.validAt === writeSeq) return worldOutcome(c, entry);
	if (entry !== undefined && worldDepsMatch(entry, w)) {
		entry.validAt = writeSeq;
		return worldOutcome(c, entry);
	}
	if (entry === undefined) {
		entry = {
			w,
			v: undefined,
			err: UNSET,
			pend: null,
			deps: [],
			depVals: [],
			validAt: 0,
			uses: null,
		};
		(c.wc ??= []).push(entry);
		(w.touched ??= new Set()).add(c);
	} else {
		entry.deps.length = 0;
		entry.depVals.length = 0;
		entry.err = UNSET;
		entry.pend = null;
	}
	evaluateWorldEntry(c, w, entry);
	return worldOutcome(c, entry);
}

function evaluateWorldEntry(c: AnyComputed, w: World, entry: WorldEntry): void {
	const prevEntry = activeWorldEntry;
	const prevWorld = activeWorld;
	const prevSub = activeSub;
	const prevConsumer = activeWorldConsumer;
	activeWorldEntry = entry;
	activeWorld = w;
	activeSub = null;
	activeWorldConsumer = c;
	try {
		activeUseEpoch = c.epoch !== null ? (foldAtom(c.epoch as AnyAtom, w) as number) : 0;
		entry.v = c.fn(makeUse(c, entry));
	} catch (e) {
		if (e instanceof PendingValue) entry.pend = e;
		else entry.err = e;
	} finally {
		activeWorldEntry = prevEntry;
		activeWorld = prevWorld;
		activeSub = prevSub;
		activeWorldConsumer = prevConsumer;
		entry.validAt = writeSeq;
	}
}

function worldOutcome(c: AnyComputed, entry: WorldEntry): unknown {
	if (activeWorldEntry !== null) {
		const token = entry.err !== UNSET ? entry.err : entry.pend !== null ? entry.pend : entry.v;
		recordWorldDep(c, token);
	}
	if (entry.err !== UNSET) throw entry.err;
	if (entry.pend !== null) throw entry.pend;
	return entry.v;
}

function releaseWorldEntry(c: AnyComputed, w: World): void {
	if (c.wc === null) return;
	c.wc = c.wc.filter((e) => e.w !== w);
	if (c.wc.length === 0) c.wc = null;
}

/** Read any node under an explicit world (host render passes). */
export function readInWorld(xx: Node, w: World): unknown {
	const x = xx as Source;
	if (x.k === 0) return foldAtom(x, w);
	return readComputedInWorld(x, w);
}

export function makeWorld(batches: BatchId[]): World {
	return new World(batches);
}

// ---- the read family ------------------------------------------------------------

/** Canonical read: committed state plus applied urgent writes; drafts hidden.
 * A pending async computed throws its stable PendingValue box. */
export function read<T>(x: Node<T>): T {
	return x.get();
}

/** Host-installed render-pass world: the world the currently executing render
 * pass reads through, or null outside render. Lets a direct `latest()` call in
 * a component body resolve the pass's own world instead of live drafts. */
let renderWorldProvider: () => World | null = () => null;
export function setRenderWorldProvider(fn: (() => World | null) | null): void {
	renderWorldProvider = fn ?? (() => null);
}

/** Newest intent, including live transition drafts. Never suspends: while an
 * evaluation is pending the last settled value is served. Inside a computed
 * evaluation or a render pass it resolves that context's own world — reading
 * ahead of your own world would be a tear. In a canonical evaluation the
 * context's world IS canon, and the read is tracked like any other so the
 * caller re-runs when the value lands. */
export function latest<T>(x: Node<T>): T;
export function latest(x: Node): unknown {
	return latestImpl(x as Source);
}
function latestImpl(x: Source): unknown {
	// World-scoped evaluation (hook read, inWorld scope, world computed).
	if (activeWorld !== null) return latestInWorld(x, activeWorld);
	// Canonical evaluation (computed or effect): tracked canonical read.
	if (activeSub !== null) {
		try {
			return x.get();
		} catch (e) {
			if (e instanceof PendingValue && x.k === 1 && x.settled !== UNSET) return x.settled;
			throw e;
		}
	}
	// Render pass body outside any hook: the pass's own world.
	const rw = renderWorldProvider();
	if (rw !== null) return latestInWorld(x, rw);
	// Free context: newest intent — every live draft folded in.
	if (x.k === 0) return latestAtom(x);
	if (liveBatches.size === 0) {
		try {
			return untracked(() => x.get());
		} catch (e) {
			if (e instanceof PendingValue && x.settled !== UNSET) return x.settled;
			throw e;
		}
	}
	const w = new World([...liveBatches.keys()]);
	try {
		return latestInWorld(x, w);
	} finally {
		w.release();
	}
}

/** Resolve under a world; a pending computed serves its last settled value. */
function latestInWorld(x: Source, w: World): unknown {
	try {
		return readInWorld(x, w);
	} catch (e) {
		if (e instanceof PendingValue && x.k === 1 && x.settled !== UNSET) return x.settled;
		throw e;
	}
}

/** Host-installed committed cutoff: the write seq as of a root's last commit.
 * Without a host everything is committed the moment it is canonical. */
let committedCutoffProvider: (container?: unknown) => WriteSeq = () => writeSeq;
export function setCommittedCutoffProvider(fn: ((container?: unknown) => WriteSeq) | null): void {
	committedCutoffProvider = fn ?? (() => writeSeq);
}

/** What is on screen: the canonical timeline cut at the container's last
 * commit (or the newest commit anywhere when no container is given). Never
 * subscribes. */
export function committed<T>(x: Node<T>, container?: unknown): T;
export function committed(xx: Node, container?: unknown): unknown {
	const x = xx as Source;
	const cutoff = committedCutoffProvider(container);
	if (cutoff >= writeSeq && liveBatches.size === 0 && x.k === 0) {
		materialize(x);
		return x.v;
	}
	// A committed view is a pure cutoff predicate: no draft batches.
	const w = new World([], cutoff);
	try {
		return readInWorld(x, w);
	} catch (e) {
		if (e instanceof PendingValue && x.k === 1 && x.settled !== UNSET) return x.settled;
		throw e;
	} finally {
		w.release();
	}
}

/** Cheap flip-only probe: is newer data loading behind the value being shown?
 * True while an atom holds unfolded transition drafts or an async computed has
 * a parked evaluation (canonical or in any live world). Never refetches. */
export function isPending(xx: Node): boolean {
	const x = xx as Source;
	if (x.k === 0) {
		if (x.log !== null) {
			for (const r of x.log) if (r.batch !== URGENT && r.folded === 0) return true;
		}
		return false;
	}
	if (x.pend !== null && x.settled !== UNSET && thenRecord(x.pend.thenable).status === 0) {
		return true;
	}
	if (x.refreshing !== null) {
		for (const t of x.refreshing) {
			if (thenRecord(t).status === 0) return true;
			x.refreshing.delete(t);
		}
	}
	if (x.wc !== null) {
		for (const e of x.wc) {
			if (e.pend !== null && thenRecord(e.pend.thenable).status === 0) return true;
		}
	}
	if (x.epoch !== null && isPending(x.epoch as AnyAtom)) return true;
	return false;
}

/** Force refetch with unchanged inputs. The stale value keeps serving via
 * `latest`; a refresh issued inside a transition belongs to that transition
 * and its settlement commits with it. The refetch starts eagerly, so
 * `isPending` flips the moment refresh is called. */
export function refresh(xx: Node): void {
	const x = xx as Source;
	if (x.k === 0) return;
	const c = x;
	const firstRefresh = c.epoch === null;
	if (firstRefresh) c.epoch = new Atom(0, { label: c.label ? `${c.label}.epoch` : 'epoch' });
	const b = writeBatch();
	const ev = tracing ? emit('refresh', c.label, { batch: b?.id ?? URGENT }) : 0;
	c.epoch!.update((n) => n + 1);
	if (firstRefresh) {
		// No evaluation has read the epoch input yet, so invalidate by hand.
		// Re-running the canonical evaluation is value-stable (its world still
		// resolves the old epoch), and it makes the evaluation track the epoch
		// input from now on — retirement folds then invalidate it normally.
		if (c.wc !== null) for (const e of c.wc) e.validAt = -1;
		c.state = DIRTY;
		c.checked = 0;
		startBatch();
		markObs(c, CHECK);
		endBatch();
		pokeHooks(c, b?.id ?? URGENT, ev);
	}
	// Start the refetch now, in the world the refresh belongs to.
	let box: PendingValue | null = null;
	if (b === null) {
		try {
			untracked(() => c.get());
		} catch (e) {
			if (e instanceof PendingValue) box = e;
		}
	} else {
		const w = new World([b.id]);
		try {
			readInWorld(c, w);
		} catch (e) {
			if (e instanceof PendingValue) box = e;
		} finally {
			w.release();
		}
	}
	if (box !== null) {
		(c.refreshing ??= new Set()).add(box.thenable);
	}
	// Poke AFTER the eager refetch so subscribers observe the pending flip.
	pokeHooks(c, b?.id ?? URGENT, ev);
}

// ---- SSR ------------------------------------------------------------------------

/** Serialize the canonical values of app-keyed atoms to JSON. */
export function serializeAtomState(
	atoms: Record<string, Atom<any>>,
	replacer?: (key: string, value: unknown) => unknown,
): string {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(atoms)) {
		const a = atoms[key] as AnyAtom;
		materialize(a);
		out[key] = a.v;
	}
	return JSON.stringify(out, replacer);
}

/** Install serialized state onto a fresh engine's atoms. Install is not a
 * write: no notifications, no history, and lazy initializers do not run. */
export function initializeAtomState(
	json: string,
	atoms: Record<string, Atom<any>>,
	reviver?: (key: string, value: unknown) => unknown,
): void {
	const data = JSON.parse(json, reviver) as Record<string, unknown>;
	installState(atoms, data);
}

export function installState(
	atoms: Record<string, Atom<any>>,
	values: Record<string, unknown>,
): void {
	for (const key of Object.keys(values)) {
		const a = atoms[key] as AnyAtom | undefined;
		if (a !== undefined) installValue(a, values[key]);
	}
}

// ---- test reset -------------------------------------------------------------------

/** Reset module-level engine state between tests. Nodes owned by the caller
 * are theirs to drop; this clears cross-cutting registries only. */
export function __resetEngine(): void {
	for (const b of [...liveBatches.values()]) b.discard();
	liveBatches.clear();
	logged.clear();
	draftEdgeSources.clear();
	effectQueue.length = 0;
	observedDirty.clear();
	observedScheduled = false;
	batchDepth = 0;
	flushing = false;
	openWorlds = 0;
	ambientBatch = null;
	activeSub = null;
	activeOwner = null;
	activeWorld = null;
	activeWorldEntry = null;
	activeWorldConsumer = null;
	initializing = null;
	pendingError = UNSET;
	stampProvider = () => null;
	writeGuard = null;
	committedCutoffProvider = () => writeSeq;
	renderWorldProvider = () => null;
	pokeTargets = 0;
	deferredStack.length = 0;
	deferredDepth = 0;
}

// ---- host helpers ---------------------------------------------------------------

/** Whether an async computed has ever settled (hosts use this to decide
 * stale-serve vs suspend at their own boundaries). */
export function hasSettled(xx: Node): boolean {
	const x = xx as Source;
	return x.k === 1 && x.settled !== UNSET;
}

/** The last settled value of an async computed. Only meaningful when
 * `hasSettled(x)` is true. */
export function lastSettled(xx: Node): unknown {
	const x = xx as Source;
	return x.k === 1 && x.settled !== UNSET ? x.settled : undefined;
}

/** Trace id of the newest delivery event for a node's host subscriptions. */
export function lastDeliveryEvent(xx: Node): EventId {
	const x = xx as Source;
	return x.lastDeliveryEv;
}
