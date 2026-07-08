/**
 * Core reactive graph: atoms (writable sources), computeds (lazy cached
 * derivations), effects (sinks), scopes, batching, and tracking.
 *
 * The graph is pull-validated and push-scheduled:
 * - Writes push a stale wave through the *live* subgraph (nodes with a
 *   subscriber chain ending in an effect or watcher) so sinks know to
 *   schedule; nothing recomputes during the wave.
 * - Consumers validate by polling: each dependency edge remembers what the
 *   consumer last saw (the value for an atom, the version for a computed).
 *   A consumer only re-runs when a poll finds a real difference, so writes
 *   that revert inside a batch — and computed chains whose intermediate
 *   values come out equal — never propagate.
 *
 * Worlds (see worlds.ts) layer speculative overlays on top of this canonical
 * graph: canonical state lives here; draft state is a replay of write intents.
 */

/** Bumps every time a node's value actually changes (per node). */
export type NodeVersion = number;
/** Global counter, bumps on every canonical write; validation shortcut. */
export type Epoch = number;
/** Tracer event id; events chain causally through these. */
export type TraceId = number;

export const UNSET: unique symbol = Symbol('unset');

export type SourceNode = Atom<unknown> | Computed<unknown>;
export type LiveConsumer = Computed<unknown> | EffectNode | Watcher;

let epoch: Epoch = 1;
export function currentEpoch(): Epoch {
	return epoch;
}
export function bumpEpoch(): void {
	epoch++;
}

/** The consumer currently evaluating; reads report themselves to it. */
interface TrackingFrame {
	consumer: LiveConsumer;
	deps: SourceNode[];
	seen: unknown[]; // parallel to deps: atom value / computed version at read
	set: Set<SourceNode>;
}
let activeFrame: TrackingFrame | null = null;

let batchDepth = 0;
const sinkQueue: (EffectNode | Watcher)[] = [];
let flushing = false;

/** Tracer hook: installed by tracer.ts; one branch per emit site when detached. */
export let emitTrace:
	| ((kind: string, cause: TraceId | undefined, detail?: Record<string, unknown>) => TraceId)
	| null = null;
export function setTraceEmitter(fn: typeof emitTrace): void {
	emitTrace = fn;
}
/** Cause id of the write/settlement currently propagating (tracer). */
export let currentCause: TraceId | undefined;
export function setCurrentCause(c: TraceId | undefined): TraceId | undefined {
	const prev = currentCause;
	currentCause = c;
	return prev;
}
/** Emit a trace event chained to the ambient cause (no-op when detached). */
export function traceEvent(
	kind: string,
	detail?: Record<string, unknown>,
	cause: TraceId | undefined = currentCause,
): TraceId | undefined {
	return emitTrace !== null ? emitTrace(kind, cause, detail) : undefined;
}

// ---------------------------------------------------------------------------
// Dependency recording

/** Record a read of `source` into the active frame (value/version captured at
 * read time, so a consumer that writes its own dependency mid-run notices). */
function recordRead(source: SourceNode, seenNow: unknown): void {
	const frame = activeFrame;
	if (frame === null || frame.set.has(source)) return;
	frame.set.add(source);
	frame.deps.push(source);
	frame.seen.push(seenNow);
}

/** Run `fn` for `consumer`, collecting its dependency set, then swap links. */
function trackedRun<R>(consumer: LiveConsumer, live: boolean, fn: () => R): R {
	const frame: TrackingFrame = { consumer, deps: [], seen: [], set: new Set() };
	const prev = activeFrame;
	activeFrame = frame;
	try {
		return fn();
	} finally {
		activeFrame = prev;
		if (live) {
			for (const old of consumer.deps) {
				if (!frame.set.has(old)) unlink(old, consumer);
			}
			for (const d of frame.deps) link(d, consumer);
		}
		consumer.deps = frame.deps;
		consumer.seen = frame.seen;
	}
}

/** Poll a consumer's recorded dependencies in read order; true when any
 * dependency's current value/version differs from what the consumer saw. */
function depsChanged(consumer: LiveConsumer): boolean {
	const { deps, seen } = consumer;
	for (let i = 0; i < deps.length; i++) {
		const d = deps[i];
		if (d instanceof Computed) {
			d.ensure();
			if (d.version !== seen[i]) return true;
		} else {
			d.materialize();
			if (!Object.is(d.value, seen[i])) return true;
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// Atoms

export interface AtomOptions<T> {
	equals?: (a: T, b: T) => boolean;
	label?: string;
	/** Lifetime effect: runs when the atom gains its first subscriber of any
	 * kind; the returned cleanup runs when the last subscriber is gone.
	 * Observe/unobserve flaps within a tick coalesce. */
	onObserved?: (ctx: { get(): T; set(v: T): void }) => void | (() => void);
}

export class Atom<T> {
	value: T | typeof UNSET;
	initializer: (() => T) | null;
	version: NodeVersion = 1;
	/** Live subscribers (computeds with subscribers, effects, watchers). */
	subs = new Set<LiveConsumer>();
	/** Stored bivariantly so Atom<number> flows where Atom<unknown> is read. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	equals: (a: any, b: any) => boolean;
	label: string | undefined;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	onObserved: ((ctx: { get(): any; set(v: any): void }) => void | (() => void)) | undefined;
	observedCleanup: (() => void) | void = undefined;
	observedActive = false;
	observeCheckQueued = false;
	/** Past canonical values kept while render-pass snapshots are pinned:
	 * entries are [epochAtWrite, valueBeforeWrite], newest last. */
	past: [Epoch, T][] | null = null;

	constructor(initial: T | (() => T), opts?: AtomOptions<T>) {
		if (typeof initial === 'function') {
			this.value = UNSET;
			this.initializer = initial as () => T;
		} else {
			this.value = initial;
			this.initializer = null;
		}
		this.equals = opts?.equals ?? Object.is;
		this.label = opts?.label;
		this.onObserved = opts?.onObserved;
	}

	/** Run the lazy initializer if the atom has never held a value.
	 * Untracked; the initializer is forbidden from writing. */
	materialize(): void {
		if (this.value !== UNSET) return;
		const init = this.initializer;
		if (init === null) return;
		this.initializer = null;
		const prevFrame = activeFrame;
		activeFrame = null;
		initializing++;
		try {
			this.value = init();
		} finally {
			initializing--;
			activeFrame = prevFrame;
		}
	}

	/** Set the base value without write semantics (SSR install: no notify,
	 * no initializer run, not a write). */
	install(v: T): void {
		this.initializer = null;
		this.value = v;
	}

	peek(): T {
		this.materialize();
		return this.value as T;
	}

	get(): T {
		if (readRedirect !== null) return readRedirect.readAtom(this);
		this.materialize();
		recordRead(this as Atom<unknown>, this.value);
		return this.value as T;
	}

	set(v: T): void {
		if (initializing > 0) {
			throw new Error('An atom initializer must not write to atoms.');
		}
		if (writeGuard !== null) writeGuard(this as Atom<unknown>);
		this.materialize();
		const prev = this.value as T;
		if (this.equals(prev, v)) return;
		if (pinnedSnapshots > 0) {
			(this.past ??= []).push([epoch, prev]);
			atomsWithPast.add(this as Atom<unknown>);
		}
		this.value = v;
		this.version++;
		epoch++;
		if (emitTrace !== null) {
			currentCause = emitTrace('write', currentCause, { label: this.label, value: v });
		}
		startBatch();
		this.subs.forEach((sub) => sub.markStale());
		endBatch();
	}

	/** Canonical value as of a pinned epoch. */
	valueAt(at: Epoch): T {
		this.materialize();
		if (this.past !== null) {
			// Entries are ordered by epoch; the first entry recorded at or after
			// `at` holds the value that was current at `at`.
			for (let i = 0; i < this.past.length; i++) {
				if (this.past[i][0] >= at) return this.past[i][1];
			}
		}
		return this.value as T;
	}

	subscribed(): void {
		this.scheduleObserveCheck();
	}
	unsubscribed(): void {
		this.scheduleObserveCheck();
	}
	scheduleObserveCheck(): void {
		if (this.onObserved === undefined || this.observeCheckQueued) return;
		this.observeCheckQueued = true;
		microtask(() => {
			this.observeCheckQueued = false;
			const shouldBeActive = this.subs.size > 0 || externalObservers(this as Atom<unknown>) > 0;
			if (shouldBeActive && !this.observedActive) {
				this.observedActive = true;
				this.materialize();
				this.observedCleanup = this.onObserved!({
					get: () => this.peek(),
					set: (v) => this.set(v),
				});
			} else if (!shouldBeActive && this.observedActive) {
				this.observedActive = false;
				const cleanup = this.observedCleanup;
				this.observedCleanup = undefined;
				if (typeof cleanup === 'function') cleanup();
			}
		});
	}
}

let initializing = 0;

/** React bindings count as observers for lifetime effects without holding a
 * graph edge; bindings install the counter. */
let externalObservers: (a: Atom<unknown>) => number = () => 0;
export function setExternalObserverCount(fn: typeof externalObservers): void {
	externalObservers = fn;
}

/** Bindings install a guard that rejects writes during a render pass. */
let writeGuard: ((a: Atom<unknown>) => void) | null = null;
export function setWriteGuard(fn: typeof writeGuard): void {
	writeGuard = fn;
}

/** Environment-independent microtask scheduling (no DOM lib assumed). */
export function microtask(fn: () => void): void {
	void Promise.resolve().then(fn);
}

/** Snapshot pin bookkeeping (worlds.ts pins during render passes). */
let pinnedSnapshots = 0;
const atomsWithPast = new Set<Atom<unknown>>();
export function retainPin(): void {
	pinnedSnapshots++;
}
export function releasePin(): void {
	pinnedSnapshots--;
	if (pinnedSnapshots === 0 && atomsWithPast.size > 0) {
		atomsWithPast.forEach((a) => (a.past = null));
		atomsWithPast.clear();
	}
}
export function pinCount(): number {
	return pinnedSnapshots;
}

// ---------------------------------------------------------------------------
// Read redirection (worlds.ts installs a snapshot reader during render passes
// and draft evaluations; canonical reads bypass it)

export interface ReadRedirect {
	readAtom<T>(a: Atom<T>): T;
	readComputed<T>(c: Computed<T>): T;
}
export let readRedirect: ReadRedirect | null = null;
export function setReadRedirect(ctx: ReadRedirect | null): ReadRedirect | null {
	const prev = readRedirect;
	readRedirect = ctx;
	return prev;
}

// ---------------------------------------------------------------------------
// Async parking (async.ts installs the registry; core stores the boxes)

/** A computed evaluation that touched an unresolved thenable evaluates-to-
 * pending: the box holds a stable promise rethrown at read sites until the
 * evaluation can complete. */
export interface PendingBox {
	promise: Promise<void>;
	/** Settles the park promise when the pending episode ends, so a Suspense
	 * boundary that received it retries. */
	resolve: () => void;
}
/** A computed evaluation that threw: the error is a reference-stable box
 * content rethrown at every read site. */
export interface ErrorBox {
	error: unknown;
}

export function isThenable(x: unknown): x is PromiseLike<unknown> {
	return (
		x !== null &&
		(typeof x === 'object' || typeof x === 'function') &&
		typeof (x as { then?: unknown }).then === 'function'
	);
}

/** async.ts: called when a computed parks on a thenable, so settlement can
 * invalidate it like a write. */
export let onPark: ((c: Computed<unknown>, t: PromiseLike<unknown>) => void) | null = null;
export function setOnPark(fn: typeof onPark): void {
	onPark = fn;
}

// ---------------------------------------------------------------------------
// Computeds

export class Computed<T> {
	fn: (use: <U>(t: PromiseLike<U>) => U) => T;
	value: T | typeof UNSET = UNSET;
	/** Last successfully settled value; serves stale reads while pending. */
	settled: T | typeof UNSET = UNSET;
	pending: PendingBox | null = null;
	errorBox: ErrorBox | null = null;
	version: NodeVersion = 0;
	stale = true;
	checkEpoch: Epoch = 0;
	running = false;
	deps: SourceNode[] = [];
	seen: unknown[] = [];
	subs = new Set<LiveConsumer>();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	equals: (a: any, b: any) => boolean;
	label: string | undefined;
	/** Bumped by refresh(): forces re-evaluation with unchanged inputs. */
	refreshVersion = 0;
	seenRefresh = 0;

	constructor(
		fn: (use: <U>(t: PromiseLike<U>) => U) => T,
		opts?: { equals?: (a: T, b: T) => boolean; label?: string },
	) {
		this.fn = fn;
		this.equals = opts?.equals ?? Object.is;
		this.label = opts?.label;
	}

	get live(): boolean {
		return this.subs.size > 0;
	}

	markStale(): void {
		if (this.stale) return;
		this.stale = true;
		this.subs.forEach((sub) => sub.markStale());
	}

	/** Validate and (if needed) recompute; leaves the node validated at the
	 * current epoch. */
	ensure(): void {
		if (this.running) {
			throw new Error('Cycle detected: computed read during its own evaluation.');
		}
		if (!this.stale && this.checkEpoch === epoch) return;
		if (this.version === 0 || this.refreshVersion !== this.seenRefresh) {
			this.recompute();
		} else if (depsChanged(this as Computed<unknown>)) {
			this.recompute();
		} else {
			this.stale = false;
			this.checkEpoch = epoch;
		}
	}

	recompute(): void {
		// Capture the epoch before running: a consumer that writes its own
		// dependency mid-run must come out still-stale, not freshly validated.
		const epochBefore = epoch;
		this.seenRefresh = this.refreshVersion;
		this.running = true;
		let nextValue: T | typeof UNSET = UNSET;
		let nextError: ErrorBox | null = null;
		let nextPending: PromiseLike<unknown> | null = null;
		try {
			trackedRun(this as Computed<unknown>, this.live, () => {
				nextValue = this.fn(useThenable);
			});
		} catch (e) {
			if (isThenable(e)) nextPending = e;
			else nextError = { error: e };
		} finally {
			this.running = false;
		}
		this.stale = false;
		this.checkEpoch = epoch === epochBefore ? epoch : 0;

		if (nextPending !== null) {
			// Entering (or continuing) a pending episode. Keep the park promise
			// stable across reads so Suspense retries do not refetch.
			if (this.pending === null) {
				let resolve!: () => void;
				const promise = new Promise<void>((r) => {
					resolve = r;
				});
				promise.catch(() => {});
				this.pending = { promise, resolve };
				this.version++;
			}
			this.errorBox = null;
			if (onPark !== null) onPark(this as Computed<unknown>, nextPending);
			return;
		}
		const leftPending = this.pending;
		if (nextError !== null) {
			this.pending = null;
			this.errorBox = nextError;
			this.version++;
			if (leftPending !== null) leftPending.resolve();
			return;
		}
		const prev = this.value;
		const changed =
			prev === UNSET ||
			leftPending !== null ||
			this.errorBox !== null ||
			!this.equals(prev as T, nextValue as T);
		this.pending = null;
		this.errorBox = null;
		this.value = nextValue;
		this.settled = nextValue;
		if (changed) this.version++;
		if (leftPending !== null) leftPending.resolve();
	}

	peek(): T {
		this.ensure();
		if (this.errorBox !== null) throw this.errorBox.error;
		if (this.pending !== null) {
			// Canonical read while a refetch loads behind settled history: serve
			// the stale value (isPending is the indicator); a never-settled
			// computed has nothing to serve, so it suspends.
			if (this.settled !== UNSET) return this.settled;
			throw this.pending.promise;
		}
		return this.value as T;
	}

	get(): T {
		if (readRedirect !== null) return readRedirect.readComputed(this);
		this.ensure();
		recordRead(this as Computed<unknown>, this.version);
		if (this.errorBox !== null) throw this.errorBox.error;
		if (this.pending !== null) {
			if (this.settled !== UNSET) return this.settled;
			throw this.pending.promise;
		}
		return this.value as T;
	}
}

/** `use` passed to computed functions: unwrap a settled thenable or park the
 * evaluation on it (async.ts owns thenable state; core only rethrows). */
export let useThenable: <U>(t: PromiseLike<U>) => U = () => {
	throw new Error('async.ts must install useThenable before computeds run');
};
export function setUseThenable(fn: typeof useThenable): void {
	useThenable = fn;
}

// ---------------------------------------------------------------------------
// Liveness links

/** Attach `sub` as a live subscriber of `source`, cascading liveness upward:
 * a computed that gains its first subscriber links itself to its own deps so
 * write waves reach the whole live subgraph. */
export function link(source: SourceNode, sub: LiveConsumer): void {
	if (source.subs.has(sub)) return;
	source.subs.add(sub);
	if (source instanceof Atom) {
		if (source.subs.size === 1) source.subscribed();
	} else if (source.subs.size === 1) {
		// Becoming live: stale waves were not delivered while dormant, so the
		// next validation must poll dependency values once. checkEpoch (not the
		// stale flag) forces that poll — a raised stale flag would swallow the
		// next write's wave before it reached downstream subscribers.
		source.checkEpoch = 0;
		for (const d of source.deps) link(d, source);
	}
}

export function unlink(source: SourceNode, sub: LiveConsumer): void {
	if (!source.subs.delete(sub)) return;
	if (source instanceof Atom) {
		if (source.subs.size === 0) source.unsubscribed();
	} else if (source.subs.size === 0) {
		for (const d of source.deps) unlink(d, source);
	}
}

// ---------------------------------------------------------------------------
// Owners (effects and scopes form an ownership tree; a parent re-run or
// disposal disposes the children created during its last run)

export interface Owner {
	children: (EffectNode | EffectScope)[] | null;
}
let currentOwner: Owner | null = null;

function adopt(child: EffectNode | EffectScope): void {
	if (currentOwner !== null) (currentOwner.children ??= []).push(child);
}

function disposeChildren(owner: Owner): void {
	const children = owner.children;
	if (children === null) return;
	owner.children = null;
	for (const child of children) child.dispose();
}

// ---------------------------------------------------------------------------
// Effects

export class EffectNode implements Owner {
	fn: () => unknown;
	cleanup: (() => void) | void = undefined;
	deps: SourceNode[] = [];
	seen: unknown[] = [];
	children: (EffectNode | EffectScope)[] | null = null;
	stale = true;
	queued = false;
	disposed = false;

	constructor(fn: () => unknown) {
		this.fn = fn;
		adopt(this);
		this.run();
	}

	markStale(): void {
		if (this.disposed) return;
		this.stale = true;
		if (!this.queued) {
			this.queued = true;
			sinkQueue.push(this);
			if (batchDepth === 0) flushSinks();
		}
	}

	/** Re-validate by polling; run only when a dependency actually changed. */
	flush(): void {
		this.queued = false;
		if (this.disposed || !this.stale) return;
		this.stale = false;
		if (depsChanged(this)) this.run();
	}

	/** Run the cleanup untracked; a throwing cleanup disposes the effect so a
	 * broken teardown cannot re-fire forever. */
	runCleanup(): void {
		const cleanup = this.cleanup;
		this.cleanup = undefined;
		if (typeof cleanup !== 'function') return;
		const prevFrame = activeFrame;
		activeFrame = null;
		try {
			cleanup();
		} catch (e) {
			this.dispose();
			throw e;
		} finally {
			activeFrame = prevFrame;
		}
	}

	run(): void {
		disposeChildren(this);
		this.runCleanup();
		if (this.disposed) return;
		const prevOwner = currentOwner;
		currentOwner = this;
		this.stale = false;
		try {
			if (emitTrace !== null) {
				emitTrace('effect-run', currentCause, {});
			}
			trackedRun(this, true, () => {
				const result = this.fn();
				this.cleanup = typeof result === 'function' ? (result as () => void) : undefined;
			});
		} finally {
			currentOwner = prevOwner;
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		disposeChildren(this);
		try {
			this.runCleanup();
		} finally {
			for (const d of this.deps) unlink(d, this);
			this.deps = [];
			this.seen = [];
		}
	}
}

export class EffectScope implements Owner {
	children: (EffectNode | EffectScope)[] | null = null;
	disposed = false;

	constructor(fn: () => void) {
		adopt(this);
		const prevOwner = currentOwner;
		currentOwner = this;
		try {
			fn();
		} finally {
			currentOwner = prevOwner;
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		disposeChildren(this);
	}
}

// ---------------------------------------------------------------------------
// Watchers (leaf subscribers used by React bindings: fire a callback when a
// node's canonical value changes; never re-run user code themselves)

export class Watcher {
	node: SourceNode;
	cb: () => void;
	deps: SourceNode[];
	seen: unknown[];
	stale = false;
	queued = false;
	disposed = false;

	constructor(node: SourceNode, cb: () => void) {
		this.node = node;
		this.cb = cb;
		this.deps = [node];
		this.seen = [currentSeenOf(node)];
		link(node, this);
	}

	markStale(): void {
		if (this.disposed) return;
		this.stale = true;
		if (!this.queued) {
			this.queued = true;
			sinkQueue.push(this);
			if (batchDepth === 0) flushSinks();
		}
	}

	flush(): void {
		this.queued = false;
		if (this.disposed || !this.stale) return;
		this.stale = false;
		let changed: boolean;
		try {
			changed = depsChanged(this);
		} catch {
			// A throwing node still changed observably; deliver.
			changed = true;
		}
		if (changed) {
			this.seen = [currentSeenOf(this.node)];
			this.cb();
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		unlink(this.node, this);
	}
}

/** The comparison key a consumer would record for `node` right now. */
function currentSeenOf(node: SourceNode): unknown {
	if (node instanceof Computed) {
		try {
			node.ensure();
		} catch {
			// Error and pending states version-bump like values.
		}
		return node.version;
	}
	node.materialize();
	return node.value;
}

// ---------------------------------------------------------------------------
// Batching and flush

export function startBatch(): void {
	batchDepth++;
}

export function endBatch(): void {
	if (--batchDepth === 0) flushSinks();
}

function flushSinks(): void {
	if (flushing) return;
	flushing = true;
	let firstError: unknown = UNSET;
	let iterations = 0;
	try {
		while (sinkQueue.length > 0) {
			if (++iterations > 100_000) {
				throw new Error('Effect flush did not settle after 100000 runs (livelock).');
			}
			const node = sinkQueue.shift()!;
			try {
				node.flush();
			} catch (e) {
				if (firstError === UNSET) firstError = e;
			}
		}
	} finally {
		flushing = false;
	}
	if (firstError !== UNSET) throw firstError;
}

export function untracked<T>(fn: () => T): T {
	const prevFrame = activeFrame;
	activeFrame = null;
	try {
		return fn();
	} finally {
		activeFrame = prevFrame;
	}
}

export function isTracking(): boolean {
	return activeFrame !== null;
}
