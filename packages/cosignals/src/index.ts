/**
 * cosignals — the package entry: the policy layer over the kernel, the
 * public surface, and the re-export point for the concurrent engine (which
 * composes at module initialization — see "One core, one entry" below).
 * Both live in CosignalEngine.ts, whose header lists its sections in
 * reading order; errors.ts, Tracer.ts, and graphviz.ts are self-contained.
 *
 * ## Vocabulary (in reading order; used throughout this package)
 *
 * **The kernel** is the dependency-tracking engine (CosignalEngine.ts): it
 * stores every signal, computed, effect, and dependency edge as a
 * fixed-size integer record in shared arrays, and runs the reactive
 * algorithm — writes push staleness marks down the graph, reads lazily
 * pull recomputation — as index arithmetic over those records. It compares
 * values by reference identity only; errors and async are policy, not kernel.
 *
 * **The policy layer** is everything user-facing in this file — the
 * Atom / ReducerAtom / Computed classes, effect(), configure(), the
 * re-exported batch()/untracked(). "Policy" means a user-visible behavior
 * decided outside the kernel: custom equality, error and async-read
 * handling, purity rules. The split keeps the kernel's hot paths small
 * monomorphic integer code; changeable rules live in cold JavaScript around it.
 *
 * Kernel storage terms:
 * - **The arena** is the one shared Int32Array holding every record. A
 *   **record** is {@link ArenaShape.STRIDE} consecutive Int32 slots; node
 *   records (signals/computeds/effects/scopes) and link records (one
 *   dependency edge each) share the arena and one allocator.
 * - A record's id is **premultiplied** — it is the arena index of the
 *   record's first field — so every field access is plain addition
 *   (memory[id + NodeField.FLAGS]), no multiply anywhere.
 * - JavaScript values and functions cannot live in an Int32Array; they sit
 *   in ordinary arrays running parallel to the arena — the **side columns**
 *   {@link values} and {@link fns} — indexed by shifting the same id.
 *
 * Mechanics the whole package relies on (implemented in CosignalEngine.ts):
 * - An **operation boundary** is a moment when no evaluation, effect run,
 *   or graph walk is anywhere on the call stack. Deferred work — growing
 *   the arena, freeing disposed records — runs only at boundaries, because
 *   in-flight work holds direct references to the buffers.
 * - **Closure rebuild** is how capacity grows: the kernel's functions come
 *   from one factory and capture the arena as a closure constant (V8 folds
 *   the buffer reference into compiled code), so growth allocates a
 *   doubled arena, copies the records, and re-runs the factory — fresh
 *   functions over the new buffer, swapped in only at an operation boundary.
 * - A **fold** applies a user's updater or reducer to a value to produce
 *   the next value. The concurrent engine reconstructs alternative views
 *   of the state — **worlds** — by re-applying recorded folds over a base
 *   value; that only works if folds are pure, so signal reads and writes
 *   inside an updater or reducer throw on every path ({@link runFold}).
 * - A computed's function can fail to produce a value: it can throw, or
 *   read async data that isn't ready yet (`ctx.use` on a pending promise —
 *   a **suspension**). The kernel stores the raw payload where the value
 *   would go and marks the outcome in flags; reading that slot throws —
 *   the original error, or a stable `SuspendedRead` "still loading" marker.
 *
 * ## One core, one entry
 *
 * Every public operation routes through {@link E} — the module-level
 * binding of the kernel op table, the one object whose function fields are
 * the kernel's operations — re-linked only by closure rebuild. The
 * concurrent engine composes at module initialization (no installation
 * step), and the public methods dispatch into it directly at the cost of
 * two module booleans: writes test {@link standaloneQuiet} (the engine is
 * quiet — no live batches, open renders, or pending write records — and no
 * host driver is attached via `attachDriver`); reads test
 * {@link routingActive} (a routing context — a world evaluation or ambient
 * world — could answer) beside {@link activeSub}. Sync-only apps keep both
 * fast arms forever: zero recorded writes, batches, or worlds are created.
 *
 * ## Deviations
 *
 * The kernel re-expresses alien-signals v3.2.1's push-pull algorithm over
 * arena records (semantics pinned by a 179-case conformance suite). The
 * departures, each at a cold site off the hot walks (measured ≈parity):
 *
 *   D1. A {@link NodeField.LIFECYCLE} per-link refcount feeds the observed-
 *       lifecycle option ({@link AtomOptions.effect}) from kernel liveness.
 *   D2. Reading a computed during its own evaluation throws `CycleError` (a
 *       dependency cycle) instead of serving the stale cache as upstream does.
 *   D3. Computed getters take the evaluation context as their one argument
 *       (upstream passes `previousValue`); eval sites store thrown values
 *       and pending thenables via a cold hook, never corrupting graph state.
 *   D4. A computed's spare value-column slot stays empty: policy state is
 *       id-keyed outside the kernel, so a dropped handle's record stays reclaimable.
 *   D5. The op table gains cold policy ops: invalidateComputed,
 *       markLifecycle, activeIsComputed.
 *   D6. Capacity is configurable: the COSIGNAL_INITIAL_RECORDS env var and
 *       configure({initialRecords}) feed the same growth machinery.
 *   D7. The public API is the class layer rather than upstream's closure
 *       handles; effect/effectScope/batch/untracked stay thin wrappers.
 *
 * Reclamation — deferred free of disposed records, plus FinalizationRegistry
 * recovery of records whose handles were garbage-collected — is kernel-wide
 * behavior, documented at its implementation sites in CosignalEngine.ts.
 */

import { ArenaShape, E, MIN_INITIAL_RECORDS, NodeField, NodeFlag, NOT_ROUTED, activeSub, batchDepth, flush, fns, foldGuardRestore, foldGuardSwap, maybeBoundary, requestCapacity, routingActive, routedAtomRead, routedComputedRead, untracked, values, writeAtom, writeAtomConcurrent, __engineAtomInternalsById, __engineWriteNode, __TEST__resetLifecycle } from './CosignalEngine.js';
import type { AtomInternals, ComputedInternals, NodeId, ValueIndex } from './CosignalEngine.js';

// ---- sentinels ----------------------------------------------------------------

export { SuspendedRead } from './CosignalEngine.js';

export { CycleError } from './errors.js';


// ---- the evaluation context ----------------------------------------------------

/** A `ctx.use(key, factory)` cache key: JSON-ish scalars and arrays thereof,
 * carrying every input that varies the request (same key = one shared request
 * for the node's lifetime). Functions and objects have no stable
 * serialization and are rejected loudly. */
export type UseKey = string | number | boolean | null | readonly UseKey[];

export type ComputedCtx<T> = {
	/** The computed's last committed value — a hint only: the function must
	 * be correct if it were arbitrarily stale or undefined. Undefined on first
	 * evaluation and while the cache holds an error/suspension outcome. */
	readonly previous: T | undefined;
	/** Reads a thenable inside a computed — React's `use()` contract:
	 * fulfilled returns the value, rejected throws the reason, pending
	 * suspends the computed until the thenable settles. `use(thenable)` leaves
	 * caching to the caller; `use(key, factory)` caches per key for the node's
	 * lifetime. No unkeyed-factory form: it would re-request every evaluation. */
	use<V>(source: PromiseLike<V>): V;
	use<V>(key: UseKey, factory: () => PromiseLike<V>): V;
};

// ---- the kernel (CosignalEngine.ts) --------------------------------------------------
// Record-layout enums, re-exported for independent walkers of kernel records.
export { NodeField, LinkField } from './CosignalEngine.js';







// ---- the engine dispatch ----------------------------------------------------------

/** Write-op code for the engine dispatch (0 = set, 1 = update); shares the
 * engine's `const enum WriteKind` encoding by construction. */
type WriteKind = 0 | 1;

/** @internal Test seam (leak audit): a record's side-column slots, read-only
 * — freed records must not pin dead values or closures. */
export function __TEST__kernelSideColumns(id: NodeId): { value: unknown; aux: unknown; fn: Function | undefined } {
	const v: ValueIndex = id >> ArenaShape.ID_TO_VALUE_SHIFT;
	return { value: values[v], aux: values[v + ArenaShape.AUX_VALUE_OFFSET], fn: fns[id >> ArenaShape.ID_TO_FN_SHIFT] };
}

/** Plain-path write tail shared by the public methods' standalone fast arm
 * and the engine's no-internals dispatch arm: fold the op, then
 * {@link writeAtom}, which applies policy equality once at acceptance. @internal */
export function __plainAtomWrite(atom: Atom<unknown>, kind: WriteKind, payload: unknown): void {
	const id = atom._id;
	const next = kind === 0
		? payload
		: runFold(() => (payload as (p: unknown) => unknown)(values[(id >> ArenaShape.ID_TO_VALUE_SHIFT) + ArenaShape.AUX_VALUE_OFFSET]));
	writeAtom(id, atom._isEqual, next);
}

/** Handle-free write path for the engine's lifecycle contexts, which hold
 * node ids but no handle reference: the public methods' policy assert, then
 * the engine dispatch. An atom with no engine internals takes the plain kernel
 * write with identity equality — its comparator sits on the unreachable handle. @internal */
export function __lifecycleWrite(id: NodeId, kind: WriteKind, payload: unknown): void {
	if (forbidWritesInComputeds === true && E.activeIsComputed()) {
		throw new Error('cosignals: writes inside computeds are forbidden (configure({ forbidWritesInComputeds: true })).');
	}
	const node = __engineAtomInternalsById(id);
	if (node !== undefined) {
		__engineWriteNode(node, kind, payload);
		return;
	}
	const next = kind === 0
		? payload
		: runFold(() => (payload as (p: unknown) => unknown)(values[(id >> ArenaShape.ID_TO_VALUE_SHIFT) + ArenaShape.AUX_VALUE_OFFSET]));
	writeAtom(id, undefined, next);
}

/** @internal Test-only policy scrub (`__TEST__resetEngine`'s index.ts half):
 * configure() defaults restored; lifecycle map and queued flush dropped. */
export function __TEST__resetPolicy(): void {
	forbidWritesInComputeds = false;
	__TEST__resetLifecycle();
}

// ════ Policy layer ═══════════════════════════════════════════════════════════

// ---- policy state -------------------------------------------------------------

// Both policy flags: `var` (a `let` module slot pays a per-access hole-check
// in optimized code); `=== true` guards (a boolean-singleton pointer compare,
// cheaper than the generic ToBoolean ladder a truthiness test compiles to).
// eslint-disable-next-line no-var
var forbidWritesInComputeds = false;

/** True while the engine is quiet AND no driver is attached — the public
 * write path's one fast-arm check. It lives here because a hot read of a
 * cyclic module's imported binding pays a per-access check a same-module
 * read doesn't. `var`: the engine stores the initial derivation during its
 * own module body, which can run before this one — the hoisted slot accepts
 * that early write, and both evaluation orders converge. */
// eslint-disable-next-line no-var
var standaloneQuiet = true;

/** @internal Engine seam: lands the engine's quiet-and-driverless derivation.
 * Cold; stores only on change so the untouched slot stays constant-trackable. */
export function __setStandaloneQuiet(v: boolean): void {
	if (v !== standaloneQuiet) {
		standaloneQuiet = v;
	}
}

/** Runs an updater/reducer under the fold-purity guard: `E` swaps to
 * POISON, the engine's every-op-throws table, so a fold touching any signal
 * throws at the dispatch site while the hot paths carry zero fold
 * instructions; open outer frames hold the real table as closure constants. */
function runFold<T>(fn: () => T): T {
	const saved = foldGuardSwap();
	try {
		return fn();
	} finally {
		foldGuardRestore(saved);
	}
}

// ---- the computed evaluation policy --------------------------------------------
// __TEST__ctxUse: test seam over the engine's ctx.use request cache.
export { __TEST__ctxUse } from './CosignalEngine.js';










// ---- public API -----------------------------------------------------------------

/** Passed to an Atom's `effect` option while the atom is observed. */
export type AtomCtx<T> = {
	/** Current value, read without registering a dependency. */
	readonly state: T;
	set(value: T): void;
	update(fn: (current: T) => T): void;
};

export type AtomOptions<T> = {
	/** Observed lifecycle: runs when the atom gains its first subscriber of
	 * any kind — kernel (a live computed chain, an `effect()`) or a React
	 * watcher via the bindings — and the returned cleanup runs once the last
	 * subscriber of every kind is gone. Delivered in a microtask, so flaps
	 * within one tick coalesce; bare `.state` reads never observe. For remote subscriptions. */
	effect?: (ctx: AtomCtx<T>) => void | (() => void);
	/** Policy equality for writes: an incoming value equal to the newest is
	 * dropped. While recorded writes are live, different worlds may fold
	 * different values, so the write is kept and equality applies per fold
	 * step. The kernel itself compares reference identity only. */
	isEqual?: (a: T, b: T) => boolean;
	/** Debug label. */
	label?: string;
};

export type ComputedOptions<T> = {
	/** Policy equality for recomputes: an equal result returns the previous
	 * reference, so downstream sees no change. The kernel compares identity only. */
	isEqual?: (a: T, b: T) => boolean;
	/** Debug label. */
	label?: string;
};

/** A writable signal. `.state` reads (tracked inside evaluations), `.set` writes. */
export class Atom<T> {
	/** Kernel record id; consumed by the React bindings (`cosignals-react`). @internal */
	readonly _id: NodeId;
	/** @internal */
	readonly _isEqual: ((a: unknown, b: unknown) => boolean) | undefined;
	/** Engine internals, allocated lazily at first engine content (a log
	 * entry, a watcher, arena presence, a routed read); undefined until then,
	 * 1:1 with the handle for its life, cleared by the record-free scrub. @internal */
	_internals: AtomInternals | undefined = undefined;
	readonly label: string | undefined;

	constructor(initialState: T, options?: AtomOptions<T>) {
		maybeBoundary();
		// Reclamation: a dropped handle's record recovers via the finalizer;
		// registration rides the allocation op. The instance stays a flat
		// field record — the shape measured cheapest for the GC to collect.
		const id = E.newSignal(initialState, this);
		this._id = id;
		this._isEqual = options?.isEqual as ((a: unknown, b: unknown) => boolean) | undefined;
		this.label = options?.label;
		const effect = options?.effect;
		if (effect !== undefined) {
			E.markLifecycle(id);
			// The callback parks in this atom's own `fns` slot (unused for
			// atoms; record free clears it). The engine's active lifecycle
			// record is id-keyed and never holds a handle reference.
			fns[id >> ArenaShape.ID_TO_FN_SHIFT] = effect as (ctx: AtomCtx<unknown>) => void | (() => void);
		}
	}

	/** The atom's current value (a tracked read inside evaluations); with a
	 * routing context live, the engine serves the asking world's value —
	 * except inside kernel frames (`activeSub === 0` guards the routed arm):
	 * kernel caches hold newest-world state, and a world-folded value landing
	 * there would serve later reads with no invalidation. Folds throw on dispatch. */
	get state(): T {
		if (routingActive && activeSub === 0) {
			const v = routedAtomRead(this as Atom<unknown>);
			if (v !== NOT_ROUTED) {
				return v as T;
			}
		}
		return E.readAtom(this._id) as T;
	}

	/** Replaces the atom's value: the standalone fast arm (plain kernel
	 * write) or the engine dispatch. */
	set(value: T): void {
		if (forbidWritesInComputeds === true && E.activeIsComputed()) {
			throw new Error('cosignals: writes inside computeds are forbidden (configure({ forbidWritesInComputeds: true })).');
		}
		if (this._internals === undefined && standaloneQuiet === true) {
			writeAtom(this._id, this._isEqual, value);
			return;
		}
		writeAtomConcurrent(this as Atom<unknown>, 0, value);
	}

	/** Functional update. `fn` must be pure — it runs under the fold-purity
	 * guard, so signal reads and writes inside it throw; read inputs first.
	 * An engine-dispatched update records the whole op for per-world replay. */
	update(fn: (current: T) => T): void {
		if (forbidWritesInComputeds === true && E.activeIsComputed()) {
			throw new Error('cosignals: writes inside computeds are forbidden (configure({ forbidWritesInComputeds: true })).');
		}
		if (this._internals === undefined && standaloneQuiet === true) {
			const id = this._id;
			const next = runFold(() => fn(values[(id >> ArenaShape.ID_TO_VALUE_SHIFT) + ArenaShape.AUX_VALUE_OFFSET] as T));
			writeAtom(id, this._isEqual, next);
			return;
		}
		writeAtomConcurrent(this as Atom<unknown>, 1, fn);
	}
}

export type ReducerAtomOptions<S> = AtomOptions<S>;

/** An atom whose writes go through a reducer, fixed at creation and pure
 * (it runs under the fold-purity guard). `dispatch(action)` is exactly
 * `update(s => reduce(s, action))`, replayed per world like any updater. */
export class ReducerAtom<S, A> extends Atom<S> {
	readonly reduce: (state: S, action: A) => S;

	constructor(reduce: (state: S, action: A) => S, initialState: S, options?: ReducerAtomOptions<S>) {
		super(initialState, options);
		this.reduce = reduce;
	}

	dispatch(action: A): void {
		const reduce = this.reduce;
		this.update((s) => reduce(s, action));
	}
}

/** A derived signal. `.state` reads; the function re-runs on demand. */
export class Computed<T> {
	/** Kernel record id; consumed by the React bindings (`cosignals-react`). @internal */
	readonly _id: NodeId;
	/** Engine internals, allocated lazily at first engine content (see
	 * {@link Atom._internals}). @internal */
	_internals: ComputedInternals | undefined = undefined;
	/** The raw authored fn, retained on the instance so a reused kernel id
	 * can never serve another tenant's fn; the engine's world evaluations run
	 * it against world-local previous values. @internal */
	readonly _fn: (ctx: ComputedCtx<T>) => T;
	/** @internal */
	readonly _isEqual: ((a: unknown, b: unknown) => boolean) | undefined;
	readonly label: string | undefined;

	constructor(fn: (ctx: ComputedCtx<T>) => T, options?: ComputedOptions<T>) {
		maybeBoundary();
		this._fn = fn;
		this.label = options?.label;
		const isEqual = options?.isEqual as ((a: unknown, b: unknown) => boolean) | undefined;
		this._isEqual = isEqual;
		// Reclamation rides the allocation op (see Atom's constructor note).
		const id = E.newComputed(fn as (ctx: unknown) => unknown, this);
		this._id = id;
		if (isEqual !== undefined) {
			// Only equality users pay a wrapper: an equal result returns the
			// OLD reference so the kernel's identity compare sees no change.
			// HAS_BOX set means `prev` is a residual error/thenable payload, not comparable.
			const iv: ValueIndex = id >> ArenaShape.ID_TO_VALUE_SHIFT;
			fns[id >> ArenaShape.ID_TO_FN_SHIFT] = (ctxArg: unknown): unknown => {
				const prev = values[iv];
				const next = (fn as (ctx: unknown) => unknown)(ctxArg);
				if (prev === undefined || (E.buffer()[id + NodeField.FLAGS]! & NodeFlag.HAS_BOX) !== 0) {
					return next;
				}
				return isEqual(prev, next) ? prev : next;
			};
		}
	}

	/** The computed's current value: rethrows the evaluation's cached error;
	 * throws `SuspendedRead` while suspended on a pending `ctx.use` thenable.
	 * World routing and the kernel-frame guard match {@link Atom.state};
	 * inside a fold frame the dispatch itself throws. */
	get state(): T {
		if (routingActive && activeSub === 0) {
			const v = routedComputedRead(this as Computed<unknown>);
			if (v !== NOT_ROUTED) {
				return v as T;
			}
		}
		return E.computedRead(this._id) as T;
	}
}

/** Either public signal wrapper. */
export type Signal<T> = Atom<T> | Computed<T>;

/** Runs `fn` immediately with dependency tracking and re-runs it when
 * tracked signals change; effects always observe the newest world. `fn` may
 * return a cleanup, run before each re-run and at dispose; returns a disposer. */
export function effect(fn: () => void | (() => void)): () => void {
	maybeBoundary();
	const id = E.newEffect(fn);
	const gen = E.gen(id);
	return () => {
		if (E.gen(id) !== gen) {
			return; // record already reclaimed (and possibly reused)
		}
		E.disposeEffect(id);
		maybeBoundary();
	};
}

/** Returns a disposer that disposes every effect created inside `fn`. */
export function effectScope(fn: () => void): () => void {
	maybeBoundary();
	const id = E.newScope(fn);
	const gen = E.gen(id);
	return () => {
		if (E.gen(id) !== gen) {
			return;
		}
		E.disposeEffect(id);
		maybeBoundary();
	};
}

// batch()/startBatch()/endBatch() coalesce synchronous effect runs over the
// kernel's batch counter (unrelated to the engine's Batch records);
// untracked() clears the tracking frame.
export { batch, startBatch, endBatch, untracked } from './CosignalEngine.js';

export type ConfigureOptions = {
	/** When true, any atom write during a computed evaluation throws. When
	 * false (default), writes inside computeds are tolerated as long as they
	 * do not re-enter the writing computed (evaluation cycles throw
	 * CycleError; self-feedback settles by lazy revalidation). */
	forbidWritesInComputeds?: boolean;
	/** Capacity floor, in records (one node or one link each; the arena holds
	 * 3× this number — one node plus two links per unit). Raising it grows at
	 * the next operation boundary; it never shrinks. Also settable via the
	 * COSIGNAL_INITIAL_RECORDS env var before first import. */
	initialRecords?: number;
};

export function configure(options: ConfigureOptions): void {
	if (options.forbidWritesInComputeds !== undefined) {
		forbidWritesInComputeds = options.forbidWritesInComputeds;
	}
	const n = options.initialRecords;
	if (n !== undefined) {
		if (!Number.isFinite(n) || n < MIN_INITIAL_RECORDS) {
			throw new Error(`cosignals: configure({ initialRecords }) must be a number >= ${MIN_INITIAL_RECORDS}.`);
		}
		requestCapacity(Math.ceil(n)); // CosignalEngine.ts: unit→record scaling + growth scheduling
	}
}

// ---- the concurrent-worlds engine ---------------------------------------------------
// The engine surface, re-exported: attachDriver(), `engine`, error classes,
// test seams, and surface types. Curated (no `export *`): engine internals
// stay importable only from './CosignalEngine.js'.
export { ScheduleError, InvariantViolation } from './errors.js';
export {
	attachDriver,
	engine,
	// The reserved "no batch context" BatchId (0); the React bindings and the
	// patched React build name the same sentinel in one shared batch-id space.
	BATCH_NONE,
	// @internal test seams (per-test engine reset; fast-path probes):
	__TEST__resetEngine,
	__TEST__coreProbes,
	__TEST__internalsById,
	__TEST__eachInternals,
} from './CosignalEngine.js';
export type {
	// the driver seam + the engine surface's type + reset options
	EngineDriver,
	CosignalEngine,
	EngineResetOptions,
	// entities (type-only: the classes construct nowhere outside the engine)
	AtomInternals,
	Watcher,
	WorldArena,
	ComputedInternals,
	AnyInternals,
	RenderPass,
	Subscription,
	// operations and worlds (tracing hook types stay on the `cosignals/trace`
	// side of the seam; this entry never names them)
	WriteLogEntry,
	World,
	TraceEvent,
	Reader,
	Equals,
	// scalar brands
	Value,
	BatchId,
	BatchSlot,
	RootId,
	RenderPassId,
	Seq,
	BatchSlotSet,
} from './CosignalEngine.js';
