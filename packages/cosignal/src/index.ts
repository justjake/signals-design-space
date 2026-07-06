/**
 * cosignal — the kernel and policy layer of the one `cosignal` entry.
 *
 * ─── VOCABULARY (in reading order; used throughout this file) ────────────────
 *
 * THE KERNEL is the dependency-tracking engine that fills the middle of this
 * file. It stores every signal, computed, effect, and dependency edge as a
 * fixed-size integer record in shared arrays, and runs the reactive
 * algorithm — writes push staleness marks down the graph, reads lazily pull
 * recomputation — as index arithmetic over those records. The kernel knows
 * nothing about user options: it compares values by reference identity only,
 * has no error handling of its own, and no async story.
 *
 * THE POLICY LAYER is everything user-facing at the bottom of the file — the
 * Atom / ReducerAtom / Computed classes, effect(), batch(), untracked(),
 * configure(). "Policy" in this file always means a user-visible behavior
 * decided outside the kernel: custom equality, what thrown errors and
 * pending async reads do, the purity rules. The split exists so the kernel's
 * hot paths stay small monomorphic integer code while every rule that could
 * change lives in ordinary cold JavaScript around it.
 *
 * Kernel storage terms:
 * - THE PLANE is the one shared Int32Array (`M` in createEngine) holding
 *   every record; error messages call it the arena (a preallocated block
 *   that records are carved out of). A RECORD is Plane.STRIDE (8)
 *   consecutive Int32 slots; node records (signals/computeds/effects/scopes)
 *   and link records (one dependency edge each) share the plane, the stride,
 *   and one allocator.
 * - A record's id is PREMULTIPLIED: it is the plane index of the record's
 *   first field (record ordinal × Plane.STRIDE), so every field access is
 *   plain addition — M[id + NodeField.FLAGS] — with no multiply anywhere.
 * - JavaScript values and functions cannot live in an Int32Array, so they
 *   sit in ordinary arrays running parallel to the plane — the SIDE COLUMNS
 *   `values` and `fns` — indexed by shifting the same premultiplied id (see
 *   the Plane const enum).
 *
 * Mechanics the whole file relies on:
 * - OPERATION BOUNDARY: a moment when no evaluation, effect run, or graph
 *   walk is anywhere on the call stack (`enterDepth === 0`). Deferred work —
 *   growing the plane, freeing disposed records — runs only at boundaries,
 *   because in-flight work holds direct references to the buffers.
 * - CLOSURE REBUILD: the kernel's functions are created by one factory
 *   (`createEngine`) and capture the plane as a closure constant — which is
 *   what lets V8 fold the buffer reference into compiled code. The cost of
 *   that choice: the buffer cannot be swapped under a live function. So to
 *   grow, the module allocates a doubled plane, copies the records over, and
 *   calls the factory again, producing a fresh set of functions closed over
 *   the new buffer. That wholesale re-creation is a "closure rebuild"; it
 *   happens only at operation boundaries. Scalar counters live at module
 *   level (not in the closure) precisely so a rebuilt engine resumes where
 *   the old one stopped.
 * - FOLD: applying a user's updater or reducer function to a value to
 *   produce the next value. The name comes from the concurrent engine
 *   (`./logged.ts`, part of this same entry), which reconstructs
 *   alternative views of the state ("worlds", see the README) by
 *   re-applying — folding — recorded write operations over a base value;
 *   that only works if updaters and reducers are pure. They therefore run
 *   under the same FOLD-PURITY guard whether or not a bridge is registered:
 *   signal reads and writes inside an updater or reducer throw (see
 *   runFold).
 *
 * With that vocabulary, the file's four layers, top to bottom:
 *
 *   1. Sentinels (SuspendedRead, CycleError). A computed's function can fail
 *      to produce a value: it can throw, or it can read async data that
 *      isn't ready yet (`ctx.use` on a pending promise — a SUSPENSION).
 *      Rather than make every caller handle those cases, the engine stores
 *      the RAW payload of what happened — the thrown value, or the pending
 *      thenable — in the slot where the value would have gone, and marks the
 *      outcome in the node's flags (HAS_BOX, plus BOX_SUSPENDED for
 *      suspensions). The cutoff treats "same payload + same outcome bits" as
 *      no change, so a re-thrown identical error causes no downstream churn,
 *      while an outcome FLIP propagates even when the payloads are
 *      identity-equal (throw undefined → return undefined). A read that hits
 *      an exceptional slot doesn't return it: it throws — the original error,
 *      or a SuspendedRead marker (stable per thenable) that tells the caller
 *      (e.g. React's Suspense machinery) "this value is still loading".
 *   2. The evaluation context — the ONE `ctx` object every computed function
 *      receives (`ctx.previous`, `ctx.use`). Its members are getters that
 *      resolve "which computed is evaluating right now" from kernel state,
 *      so passing it costs zero per-recompute setup.
 *   3. The kernel — alien-signals v3.2.1's push-pull algorithm, re-expressed
 *      over plane records instead of linked JavaScript objects. Upstream's
 *      walk structure and flag transitions are preserved (plus a
 *      link/linkInsert hot/slow split, see linkInsert); buffers are closure
 *      constants; walks use persistent scratch stacks (module-level
 *      Int32Array stacks reused across walks, replacing upstream's per-walk
 *      linked-list allocations); capacity grows by closure rebuild over
 *      doubled buffers at operation boundaries. Validated against a 179-case
 *      conformance suite (179/179) for alien-signals-compatible semantics.
 *      Deviations from a plain transliteration of upstream are enumerated
 *      below (D1–D7).
 *   4. The policy layer — the classes and functions named above; custom
 *      equality by wrapper-returns-old-reference; errors/suspensions as
 *      sentinel boxes; the observed lifecycle (AtomOptions.effect — the
 *      "first subscriber attached / last one detached" callback, counted
 *      over the union of kernel subscribers and bridge watchers) with
 *      microtask flap damping; the fold-purity and writes-in-computeds
 *      disciplines.
 *
 * ─── ONE CORE, ONE ENTRY ─────────────────────────────────────────────────────
 *
 * The `Engine` record returned by `createEngine` is the engine's OPERATION
 * TABLE: the one object whose function fields are the kernel's operations.
 * Every public operation routes through the module-level binding `E`
 * (`E.read`, `E.write`, `E.computedRead`, …), and `E` is only ever replaced
 * at an operation boundary via closure rebuild — growth (`boundaryWork` →
 * `createEngine(records, carry)`) and nothing else. All shared mutable state
 * a rebuilt table needs (scalar heads, side columns, queue, scratch stacks)
 * lives at module level for exactly this reason.
 *
 * There is exactly ONE build of this library. The concurrent-worlds engine
 * (`./logged.ts`, re-exported at the bottom of this file: `registerReactBridge`,
 * `CosignalBridge`, the bridge types) attaches to this kernel through the
 * HOST SEAMS — two nullable module hooks consulted FIRST in the public
 * read/write methods (see "the host seams" section below). Sync-only apps
 * that never register a bridge keep both hooks undefined forever: the whole
 * concurrency feature costs one predictable `!== undefined` branch per
 * public read/write, and zero receipts, tokens, worlds, or bridge events are
 * ever created (tests/one-core.spec.ts asserts this behaviorally with engine
 * probes). The only other swapped table is POISON (fold purity, below) —
 * reachable exclusively by erroring code.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Kernel deviations from a plain transliteration of upstream alien-signals
 * (each is policy plumbing at a cold site — code off the hot read/write
 * paths, reached rarely; the hot walks are untouched — measured ≈parity on
 * benchmark workloads):
 *
 *   D1. Node field 6 (otherwise a spare pad field) is `NodeField.LIFECYCLE`: a 0/1
 *       flag set at creation for atoms carrying an observed-lifecycle
 *       effect, so the kernel's own liveness transitions can feed the
 *       observed-lifecycle option (AtomOptions.effect) — one consumer kind
 *       of the observation union (bridge watchers are the other; see the
 *       observed-lifecycle section). Checked only in linkInsert's
 *       first-subscriber branch and in unwatched()'s signal branch; cleared
 *       in freeNode.
 *   D2. computedRead throws CycleError when the computed is re-entered
 *       during its own evaluation: reading a computed while its own
 *       evaluation frame is open is a dependency cycle, and throwing beats
 *       silently serving the stale cache (upstream alien-signals serves the
 *       stale value). Cost: one test on the already-loaded flags word.
 *   D3. Computed getters in `fns` take the policy evaluation context as their
 *       one argument (upstream passes `previousValue`; `ctx.previous` now
 *       reads the cache live via `activeSub`, so plain computeds pay ZERO
 *       policy instructions per recompute), and the two kernel eval sites
 *       (updateComputed, computedRead's first-eval branch) store exceptions
 *       via the cold `storeThrown` catch hook — a throwing getter never
 *       corrupts graph state; the kernel value slot then holds the RAW
 *       thrown value / pending thenable (flagged HAS_BOX, + BOX_SUSPENDED
 *       for suspensions; unwrapped by the cold boxedRead read tail).
 *       computedRead is split hot/slow the same way link/linkInsert is: the
 *       D2+D3 additions pushed the monolith past V8's 460-byte inline cliff,
 *       and the outlined form measures FASTER than the un-split form on
 *       read-heavy workloads.
 *   D4. A computed's aux value slot — `values[(id >> 2) + 1]`, the "signal
 *       pending value OR effect cleanup" column, unused for computeds —
 *       holds the owning `Computed` instance (policy state for boxes and
 *       the ctx.use key cache; same packed side column, no extra map).
 *   D5. Engine gains cold policy ops the policy layer needs:
 *       invalidateComputed (settlement-invalidate), markLifecycle (D1),
 *       activeIsComputed (backs the forbidWritesInComputeds check).
 *   D6. Capacity is configurable: the COSIGNAL_INITIAL_RECORDS env var sizes
 *       the plane before first import, and configure({initialRecords})
 *       feeds the same growth machinery through `desiredRecords`.
 *   D7. The public API is the class layer (Atom/Computed) rather than
 *       upstream's closure handles (signal()/computed());
 *       effect/effectScope/batch/untracked stay thin function wrappers over
 *       the kernel ops.
 *
 * Everything else — GROWTH (closure rebuild over doubled buffers, swap at
 * operation boundaries only) and RECLAMATION (deferred free of disposed
 * effect/scope records; signal/computed records are owned by their handles
 * and are not reclaimed) — is kernel-wide behavior, bridge registered or
 * not, documented at its implementation sites below.
 */

// ---- sentinels ----------------------------------------------------------------

/**
 * Thrown when a read observes a pending suspension: by `ctx.use` inside a
 * computed evaluation, and by read sites whose computed's cached result is a
 * suspended box. Carries the pending thenable. (The React bindings
 * (`cosignal-react`) catch it at render read sites and forward it to
 * Suspense.)
 */
export class SuspendedRead {
	readonly thenable: PromiseLike<unknown>;
	constructor(thenable: PromiseLike<unknown>) {
		this.thenable = thenable;
	}
}

/**
 * Thrown when a computed is read while its own evaluation frame is open —
 * that read is a dependency cycle. cosignal fails loudly instead of serving
 * the stale cached value (which is what upstream alien-signals does).
 */
export class CycleError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CycleError';
	}
}

// Exceptional-outcome detection never uses `instanceof` on a hot path
// (measured ~9ns per `instanceof` there — 2.4× on read-heavy workloads).
// Reads route on the kernel's HAS_BOX flag; the policy-side filters
// (ctx.previous, the isEqual wrapper) test the same flag bits, which the
// eval-start rewrite deliberately PRESERVES while the getter runs so the
// residual slot payload can be told apart from a plain previous value.

// ---- the evaluation context ----------------------------------------------------

/**
 * A `ctx.use(key, factory)` cache key: JSON-ish scalars and arrays thereof.
 * The key must carry every input that varies the request (query strings,
 * ids, page numbers) — the cache is per-key for the node's lifetime, so two
 * calls with the same key share one request. Functions and objects are
 * rejected loudly: they have no stable serialization, and a key that can't
 * serialize can't dedupe.
 */
export type UseKey = string | number | boolean | null | readonly UseKey[];

export type ComputedCtx<T> = {
	/**
	 * The computed's last committed value — a hint only: no identity,
	 * recency, or determinism is guaranteed, and the function must be
	 * correct if `previous` were arbitrarily stale or undefined. For a plain
	 * `Computed`: the cached value, read live; undefined on first evaluation
	 * and while the cache holds an error/suspension outcome. (React-bound
	 * computeds serve the last committed value instead — see cosignal-react.)
	 */
	readonly previous: T | undefined;
	/**
	 * Reads a thenable inside a computed — React's `use()` contract, in two
	 * forms:
	 *
	 * 1. `ctx.use(thenable)` — the CALLER caches the promise (data layer,
	 *    component state). Fulfilled: returns the value. Rejected: throws the
	 *    reason. Pending: suspends the computed — read sites observe a stable
	 *    SuspendedRead until the thenable settles, and settlement invalidates
	 *    the computed. Passing the same (now settled) promise on a later
	 *    evaluation reads the resolved value synchronously; the engine stores
	 *    nothing beyond instrumentation on the thenable itself.
	 * 2. `ctx.use(key, factory)` — the batteries-included form: the node keeps
	 *    a per-key cache for its own lifetime. Same key ⇒ same thenable (the
	 *    factory is not re-invoked; pending work is shared, settled work
	 *    replays); different keys coexist. The key must carry the inputs that
	 *    vary the request. The cache dies with the node.
	 *
	 * The bare positional-factory form (`ctx.use(() => fetch(...))`) was
	 * removed: an unkeyed factory is the "uncached promise" footgun and is
	 * unsound across worlds asking different queries.
	 */
	use<V>(source: PromiseLike<V>): V;
	use<V>(key: UseKey, factory: () => PromiseLike<V>): V;
};

/**
 * The ONE evaluation context, passed by the kernel to every computed getter
 * as its argument (D3). Its members delegate to hoisted policy functions
 * (defined in the policy layer below) that resolve the evaluating node from
 * the kernel's `activeSub`, so no per-recompute state setup exists at all.
 */
const POLICY_CTX: ComputedCtx<unknown> = {
	get previous(): unknown {
		return ctxPrevious();
	},
	use<V>(sourceOrKey: PromiseLike<V> | UseKey, factory?: () => PromiseLike<V>): V {
		return ctxUse(sourceOrKey, factory as (() => PromiseLike<unknown>) | undefined) as V;
	},
};

// ---- semantic number types ------------------------------------------------------
// Plain type aliases — zero runtime cost, no branding, no casts. They name what
// each number MEANS so signatures read as the layout docs above.

/** Premultiplied node record id: the Int32 plane index of the record's field 0
 * (id = record ordinal × Plane.STRIDE). 0 = "none" (record 0 is burned). */
type NodeId = number;
/** Premultiplied link record id (links share the plane and stride with nodes). 0 = "none". */
type LinkId = number;
/** A premultiplied record id of either kind (the shared bump pointer / allocators). */
type RecordId = number;
/** A node's FLAGS field value: a bitwise OR of NodeFlag members. */
type NodeFlags = number;
/** The global evaluation cycle counter, stamped into link VERSION fields on re-track. */
type Version = number;
/** A node's GEN field value: bumped on free so disposers can defuse stale ids. */
type Generation = number;
/** A count of fixed-stride records (nodes and links draw from one shared pool). */
type RecordCount = number;
/** Index into the `values` side column (two slots per record; see Plane). */
type ValueIndex = number;

// ---- record layout + flags as const enums ---------------------------------------
// Const enums (not module-level `const`s) so every consumer toolchain inlines
// the values as literals. Rationale: esbuild BUNDLING demotes module-scope
// `const` to mutable `var` (lazy-init/scope-merge hoisting), which costs
// TurboFan its constant-folding of these hot numbers — measured +15-21% on
// benchmark workloads when bundled. Same-file const enum members are inlined
// as numeric literals by esbuild (transform AND bundle modes), tsx, vitest,
// and tsc alike, so the codegen no longer depends on how the library is
// packaged. They must STAY in this file: esbuild-based tools inline const
// enum members only within one file — a cross-file access becomes a real
// property lookup at runtime.

/** Field offsets within a NODE record (M plane, stride 8; ids are
 * pre-multiplied: id = record ordinal * 8). */
const enum NodeField {
	FLAGS = 0,
	DEPS = 1, // doubles as the free-list next pointer for freed records
	DEPS_TAIL = 2,
	SUBS = 3,
	SUBS_TAIL = 4,
	GEN = 5, // bumped on free; disposers capture it to defuse stale ids
	LIFECYCLE = 6, // D1: 1 iff the node is an atom with an observed-lifecycle effect
	// field 7 spare (pad to one cache line per record)
}

/** Field offsets within a LINK record (link records share the plane, stride,
 * and premultiplied ids with node records). */
const enum LinkField {
	VERSION = 0,
	DEP = 1,
	SUB = 2,
	PREV_SUB = 3,
	NEXT_SUB = 4,
	PREV_DEP = 5,
	NEXT_DEP = 6, // doubles as the free-list next pointer for freed links
	// field 7 spare
}

/** Bit values of a node's FLAGS field (upstream ReactiveFlags + HasChildEffect
 * + kind bits). A flags word is an OR of these (see `type NodeFlags`). */
const enum NodeFlag {
	MUTABLE = 1,
	WATCHING = 2,
	RECURSED_CHECK = 4,
	RECURSED = 8,
	DIRTY = 16,
	PENDING = 32,
	HAS_CHILD_EFFECT = 64,
	K_SIGNAL = 128,
	K_COMPUTED = 256,
	K_EFFECT = 512,
	K_SCOPE = 1024,
	KIND_MASK = K_SIGNAL | K_COMPUTED | K_EFFECT | K_SCOPE,
	// D3: the computed's cached value is an exceptional outcome — the value
	// slot holds the RAW thrown value (HAS_BOX alone) or the pending thenable
	// (HAS_BOX | BOX_SUSPENDED). Set exactly at the two kernel catch sites
	// (with storeThrown); the eval-start flag rewrite in updateComputed
	// PRESERVES the bits while the getter runs (ctx.previous and the isEqual
	// wrapper filter the residual slot payload by them) and a successful
	// evaluation clears them in the finally's flag write — every other flag
	// site either ORs bits or is followed by a forced recompute (unwatched
	// sets DIRTY), so a stale clear can never serve a payload unwrapped.
	HAS_BOX = 2048,
	/** Refines HAS_BOX (never set without it): the payload is a pending
	 * thenable, not a thrown error. */
	BOX_SUSPENDED = 4096,
}

/** Plane geometry: the strides, shifts, and offsets that address a record's
 * fields and its side-column slots from its premultiplied id. */
const enum Plane {
	/** Int32 fields per record; ids are premultiplied by this (id = record ordinal × STRIDE). */
	STRIDE = 8,
	/** id >> ID_TO_VALUE_SHIFT: premultiplied id → the record's base index in
	 * the `values` side column (each record owns 2 value slots: 8 / 4 = 2). */
	ID_TO_VALUE_SHIFT = 2,
	/** id >> ID_TO_FN_SHIFT: premultiplied id → the record's index in the
	 * `fns` side column (one fn slot per record: 8 / 8 = 1). */
	ID_TO_FN_SHIFT = 3,
	/** valueIndex + AUX_VALUE_OFFSET: the record's second value slot — a
	 * signal's pending value, an effect's cleanup fn, or the computed's
	 * owning Computed instance (D4). */
	AUX_VALUE_OFFSET = 1,
	/** length >> HALF_PLANE_SHIFT: half the plane — the "keep at least half
	 * the plane free" watermark term. */
	HALF_PLANE_SHIFT = 1,
	/** Records budgeted per configured capacity unit: one node + two links. */
	RECORDS_PER_UNIT = 3,

	// Min free records guaranteed at each op boundary. Nodes and links draw
	// from one shared pool; the slack is the sum of per-kind floors (256 node
	// + 1024 link records), so any allocation pattern that fit those floors
	// separately still fits the merged slack.
	REC_SLACK = 1280,
}

// ---- shared mutable state (survives engine rebuilds) ------------------------
// Scalar heads/counters live at module level so a rebuilt engine resumes
// exactly where the old one stopped; only the buffer bindings live in the
// engine closure.
let recNext: RecordId = Plane.STRIDE; // bump pointer, shared by nodes and links (record 0 burned)
let nodeFreeHead: NodeId = 0; // free list threaded through M[id + NodeField.DEPS]
let linkFreeHead: LinkId = 0; // free list threaded through M[id + LinkField.NEXT_DEP]
let growPending = false;

let cycle: Version = 0;
let runDepth = 0;
let batchDepth = 0;
let notifyIndex = 0;
let queuedLength = 0;
let activeSub: NodeId = 0;
let enterDepth = 0; // live engine frames that captured M; 0 = op boundary

const queued: NodeId[] = [];
const pendingFree: NodeId[] = []; // disposed effect/scope records awaiting the sweep (batch-freed at the next operation boundary)

// Side columns, indexed off the id: values[id >> 2] = current/computed value,
// values[(id >> 2) + 1] = signal pending value OR effect cleanup fn OR the
// computed's owning Computed instance (D4), fns[id >> 3] = computed getter /
// effect fn. Plain arrays grown by push (stays PACKED; plain-array growth has
// no binding problem). The policy layer reads these columns directly — they
// are shared state like the scalar heads, not operations.
const values: unknown[] = [undefined, undefined];
const fns: (Function | undefined)[] = [undefined];

// Persistent scratch stacks: module-level Int32Arrays reused by every graph
// walk, replacing the linked-list stack upstream allocates per walk.
// Re-entrant walks push above the caller's base and restore it on exit.
let propStack = new Int32Array(4096);
let propSp = 0;
let checkStack = new Int32Array(4096);
let checkSp = 0;

// ---- the engine (the operation table) -----------------------------------------

interface Engine {
	records: RecordCount;
	buffer(): Int32Array;
	newSignal(value: unknown): NodeId;
	newComputed(getter: (ctx: unknown) => unknown): NodeId;
	newEffect(fn: () => (() => void) | void): NodeId;
	newScope(fn: () => void): NodeId;
	gen(id: NodeId): Generation;
	read(s: NodeId): unknown;
	write(s: NodeId, value: unknown): boolean;
	computedRead(c: NodeId): unknown;
	run(e: NodeId): void;
	requeueAbort(e: NodeId): void;
	dispose(e: NodeId): void;
	sweepPendingFree(): void;
	// D5: cold policy ops (never called from the hot walks).
	/** Marks a computed stale and propagates to its subs (settlement-invalidate). */
	invalidateComputed(c: NodeId): boolean;
	/** D1: flags the node for observed-lifecycle delivery. */
	markLifecycle(id: NodeId): void;
	/** True iff the currently-evaluating subscriber is a computed. */
	activeIsComputed(): boolean;
}

function createEngine(records: RecordCount, carry?: Int32Array): Engine {
	const M = new Int32Array(records * Plane.STRIDE);
	// Bundler-proof aliases for the module-level side arrays: esbuild
	// bundling demotes module-scope `const` to mutable `var`, so TurboFan
	// loses their constant-folding at module scope; a function-scope const
	// is preserved verbatim and folds via the same one-closure-cell context
	// specialization that embeds M.
	const vals = values;
	const fnTab = fns;
	const queue = queued;
	const evalCtx = POLICY_CTX;
	if (carry !== undefined) {
		M.set(carry);
	}
	// Allocators flag growth once the bump pointer (the never-yet-used end of
	// the plane; allocation takes a freed record first, else bumps this) crosses
	// the watermark — the fill level that schedules growth. The rule: keep at
	// least Plane.REC_SLACK records AND half the plane free at every boundary.
	const WM = Math.min(M.length >> Plane.HALF_PLANE_SHIFT, M.length - Plane.REC_SLACK * Plane.STRIDE);
	if (recNext > WM) {
		growPending = true;
	}

	return {
		records,
		buffer: () => M,
		newSignal,
		newComputed,
		newEffect,
		newScope,
		gen: (id) => M[id + NodeField.GEN],
		read,
		write,
		computedRead,
		run,
		requeueAbort,
		dispose,
		sweepPendingFree,
		invalidateComputed,
		markLifecycle: (id) => {
			M[id + NodeField.LIFECYCLE] = 1;
		},
		activeIsComputed: () => activeSub !== 0 && (M[activeSub + NodeField.FLAGS] & NodeFlag.K_COMPUTED) !== 0,
	};

	// ---- allocation ----------------------------------------------------------

	function allocNode(flags: NodeFlags): NodeId {
		let id: NodeId;
		if (nodeFreeHead !== 0) {
			id = nodeFreeHead;
			nodeFreeHead = M[id + NodeField.DEPS];
			M[id + NodeField.DEPS] = 0;
		} else {
			id = recNext;
			if (id >= M.length) {
				throw new Error('cosignal: arena exhausted mid-operation; raise COSIGNAL_INITIAL_RECORDS');
			}
			recNext = id + Plane.STRIDE;
			if (recNext > WM) {
				growPending = true;
			}
		}
		M[id + NodeField.FLAGS] = flags;
		const v: ValueIndex = id >> Plane.ID_TO_VALUE_SHIFT;
		while (vals.length <= v + Plane.AUX_VALUE_OFFSET) {
			vals.push(undefined);
		}
		while (fnTab.length <= id >> Plane.ID_TO_FN_SHIFT) {
			fnTab.push(undefined);
		}
		return id;
	}

	function freeNode(id: NodeId): void {
		M[id + NodeField.FLAGS] = 0;
		M[id + NodeField.DEPS_TAIL] = 0;
		M[id + NodeField.SUBS] = 0;
		M[id + NodeField.SUBS_TAIL] = 0;
		M[id + NodeField.LIFECYCLE] = 0; // D1
		++M[id + NodeField.GEN];
		const v: ValueIndex = id >> Plane.ID_TO_VALUE_SHIFT;
		vals[v] = undefined;
		vals[v + Plane.AUX_VALUE_OFFSET] = undefined;
		fnTab[id >> Plane.ID_TO_FN_SHIFT] = undefined;
		M[id + NodeField.DEPS] = nodeFreeHead;
		nodeFreeHead = id;
	}

	function sweepPendingFree(): void {
		for (let i = 0; i < pendingFree.length; ++i) {
			freeNode(pendingFree[i]);
		}
		pendingFree.length = 0;
	}

	function allocLink(): LinkId {
		let id: LinkId;
		if (linkFreeHead !== 0) {
			id = linkFreeHead;
			linkFreeHead = M[id + LinkField.NEXT_DEP];
		} else {
			id = recNext;
			if (id >= M.length) {
				throw new Error('cosignal: arena exhausted mid-operation; raise COSIGNAL_INITIAL_RECORDS');
			}
			recNext = id + Plane.STRIDE;
			if (recNext > WM) {
				growPending = true;
			}
		}
		return id;
	}

	function freeLink(id: LinkId): void {
		M[id + LinkField.NEXT_DEP] = linkFreeHead;
		linkFreeHead = id;
	}

	// ---- system.ts transliteration -------------------------------------------

	function link(dep: NodeId, sub: NodeId, version: Version): void {
		const prevDep = M[sub + NodeField.DEPS_TAIL];
		if (prevDep !== 0 && M[prevDep + LinkField.DEP] === dep) {
			return;
		}
		const nextDep = prevDep !== 0 ? M[prevDep + LinkField.NEXT_DEP] : M[sub + NodeField.DEPS];
		if (nextDep !== 0 && M[nextDep + LinkField.DEP] === dep) {
			M[nextDep + LinkField.VERSION] = version;
			M[sub + NodeField.DEPS_TAIL] = nextDep;
			return;
		}
		linkInsert(dep, sub, version, prevDep, nextDep);
	}

	// Insertion tail of link(): kept out of line so the steady-state re-track
	// fast path above stays under V8's inlining bytecode budget (upstream
	// monolithic link() was 475 bytecodes — kExceedsBytecodeLimit — and never
	// inlined into the read paths despite running on every tracked read).
	function linkInsert(dep: NodeId, sub: NodeId, version: Version, prevDep: LinkId, nextDep: LinkId): void {
		const prevSub = M[dep + NodeField.SUBS_TAIL];
		if (prevSub !== 0 && M[prevSub + LinkField.VERSION] === version && M[prevSub + LinkField.SUB] === sub) {
			return;
		}
		const newLink = allocLink();
		M[sub + NodeField.DEPS_TAIL] = newLink;
		M[dep + NodeField.SUBS_TAIL] = newLink;
		M[newLink + LinkField.VERSION] = version;
		M[newLink + LinkField.DEP] = dep;
		M[newLink + LinkField.SUB] = sub;
		M[newLink + LinkField.PREV_DEP] = prevDep;
		M[newLink + LinkField.NEXT_DEP] = nextDep;
		M[newLink + LinkField.PREV_SUB] = prevSub;
		M[newLink + LinkField.NEXT_SUB] = 0;
		if (nextDep !== 0) {
			M[nextDep + LinkField.PREV_DEP] = newLink;
		}
		if (prevDep !== 0) {
			M[prevDep + LinkField.NEXT_DEP] = newLink;
		} else {
			M[sub + NodeField.DEPS] = newLink;
		}
		if (prevSub !== 0) {
			M[prevSub + LinkField.NEXT_SUB] = newLink;
		} else {
			M[dep + NodeField.SUBS] = newLink;
			// D1: first subscriber attached — the liveness bit flips 0→1.
			if (M[dep + NodeField.LIFECYCLE] !== 0) {
				lifecycleWatched(dep);
			}
		}
	}

	function unlink(id: LinkId, sub: NodeId = M[id + LinkField.SUB]): LinkId {
		const dep = M[id + LinkField.DEP];
		const prevDep = M[id + LinkField.PREV_DEP];
		const nextDep = M[id + LinkField.NEXT_DEP];
		const nextSub = M[id + LinkField.NEXT_SUB];
		const prevSub = M[id + LinkField.PREV_SUB];
		if (nextDep !== 0) {
			M[nextDep + LinkField.PREV_DEP] = prevDep;
		} else {
			M[sub + NodeField.DEPS_TAIL] = prevDep;
		}
		if (prevDep !== 0) {
			M[prevDep + LinkField.NEXT_DEP] = nextDep;
		} else {
			M[sub + NodeField.DEPS] = nextDep;
		}
		if (nextSub !== 0) {
			M[nextSub + LinkField.PREV_SUB] = prevSub;
		} else {
			M[dep + NodeField.SUBS_TAIL] = prevSub;
		}
		freeLink(id);
		if (prevSub !== 0) {
			M[prevSub + LinkField.NEXT_SUB] = nextSub;
		} else if ((M[dep + NodeField.SUBS] = nextSub) === 0) {
			unwatched(dep);
		}
		return nextDep;
	}

	function propagate(startLink: LinkId, innerWrite: boolean): void {
		// No try/finally: propagate never runs user code (notify only queues),
		// so it cannot throw and always drains the stack back to its base.
		let cur = startLink;
		let next = M[cur + LinkField.NEXT_SUB];
		const stackBase = propSp;

		top: do {
			const sub = M[cur + LinkField.SUB];
			let flags = M[sub + NodeField.FLAGS];

			if (!(flags & (NodeFlag.RECURSED_CHECK | NodeFlag.RECURSED | NodeFlag.DIRTY | NodeFlag.PENDING))) {
				M[sub + NodeField.FLAGS] = flags | NodeFlag.PENDING;
				if (innerWrite) {
					M[sub + NodeField.FLAGS] |= NodeFlag.RECURSED;
				}
			} else if (!(flags & (NodeFlag.RECURSED_CHECK | NodeFlag.RECURSED))) {
				flags = 0;
			} else if (!(flags & NodeFlag.RECURSED_CHECK)) {
				M[sub + NodeField.FLAGS] = (flags & ~NodeFlag.RECURSED) | NodeFlag.PENDING;
			} else if (!(flags & (NodeFlag.DIRTY | NodeFlag.PENDING)) && isValidLink(cur, sub)) {
				M[sub + NodeField.FLAGS] = flags | (NodeFlag.RECURSED | NodeFlag.PENDING);
				flags &= NodeFlag.MUTABLE;
			} else {
				flags = 0;
			}

			if (flags & NodeFlag.WATCHING) {
				notify(sub);
			}

			if (flags & NodeFlag.MUTABLE) {
				const subSubs = M[sub + NodeField.SUBS];
				if (subSubs !== 0) {
					cur = subSubs;
					const nextSub = M[cur + LinkField.NEXT_SUB];
					if (nextSub !== 0) {
						if (propSp === propStack.length) {
							const bigger = new Int32Array(propStack.length * 2);
							bigger.set(propStack);
							propStack = bigger;
						}
						propStack[propSp++] = next;
						next = nextSub;
					}
					continue;
				}
			}

			if ((cur = next) !== 0) {
				next = M[cur + LinkField.NEXT_SUB];
				continue;
			}

			while (propSp > stackBase) {
				cur = propStack[--propSp];
				if (cur !== 0) {
					next = M[cur + LinkField.NEXT_SUB];
					continue top;
				}
			}

			break;
		} while (true);
	}

	function checkDirty(startLink: LinkId, startSub: NodeId): boolean {
		let cur = startLink;
		let sub = startSub;
		const stackBase = checkSp;
		let checkDepth = 0;
		let dirty = false;

		try {
			top: do {
				const dep = M[cur + LinkField.DEP];
				const depFlags = M[dep + NodeField.FLAGS];

				if (M[sub + NodeField.FLAGS] & NodeFlag.DIRTY) {
					dirty = true;
				} else if ((depFlags & (NodeFlag.MUTABLE | NodeFlag.DIRTY)) === (NodeFlag.MUTABLE | NodeFlag.DIRTY)) {
					const depSubs = M[dep + NodeField.SUBS];
					if (update(dep)) {
						if (M[depSubs + LinkField.NEXT_SUB] !== 0) {
							shallowPropagate(depSubs);
						}
						dirty = true;
					}
				} else if ((depFlags & (NodeFlag.MUTABLE | NodeFlag.PENDING)) === (NodeFlag.MUTABLE | NodeFlag.PENDING)) {
					if (checkSp === checkStack.length) {
						const bigger = new Int32Array(checkStack.length * 2);
						bigger.set(checkStack);
						checkStack = bigger;
					}
					checkStack[checkSp++] = cur;
					cur = M[dep + NodeField.DEPS];
					sub = dep;
					++checkDepth;
					continue;
				}

				if (!dirty) {
					const nextDep = M[cur + LinkField.NEXT_DEP];
					if (nextDep !== 0) {
						cur = nextDep;
						continue;
					}
				}

				while (checkDepth--) {
					cur = checkStack[--checkSp];
					if (dirty) {
						const subSubs = M[sub + NodeField.SUBS];
						if (update(sub)) {
							if (M[subSubs + LinkField.NEXT_SUB] !== 0) {
								shallowPropagate(subSubs);
							}
							sub = M[cur + LinkField.SUB];
							continue;
						}
						dirty = false;
					} else {
						M[sub + NodeField.FLAGS] &= ~NodeFlag.PENDING;
					}
					sub = M[cur + LinkField.SUB];
					const nextDep = M[cur + LinkField.NEXT_DEP];
					if (nextDep !== 0) {
						cur = nextDep;
						continue top;
					}
				}

				// Upstream: `dirty && !!sub.flags` — a live node always has its
				// kind bits set; flags reads 0 only if sub was disposed (record
				// zeroed) by re-entrant user code during update().
				return dirty && M[sub + NodeField.FLAGS] !== 0;
			} while (true);
		} finally {
			checkSp = stackBase;
		}
	}

	function shallowPropagate(startLink: LinkId): void {
		let cur = startLink;
		do {
			const sub = M[cur + LinkField.SUB];
			const flags = M[sub + NodeField.FLAGS];
			if ((flags & (NodeFlag.PENDING | NodeFlag.DIRTY)) === NodeFlag.PENDING) {
				M[sub + NodeField.FLAGS] = flags | NodeFlag.DIRTY;
				if ((flags & (NodeFlag.WATCHING | NodeFlag.RECURSED_CHECK)) === NodeFlag.WATCHING) {
					notify(sub);
				}
			}
		} while ((cur = M[cur + LinkField.NEXT_SUB]) !== 0);
	}

	function isValidLink(checkLink: LinkId, sub: NodeId): boolean {
		let cur = M[sub + NodeField.DEPS_TAIL];
		while (cur !== 0) {
			if (cur === checkLink) {
				return true;
			}
			cur = M[cur + LinkField.PREV_DEP];
		}
		return false;
	}

	// ---- index.ts transliteration ---------------------------------------------

	function update(node: NodeId): boolean {
		const flags = M[node + NodeField.FLAGS];
		if (flags & NodeFlag.K_COMPUTED) {
			return updateComputed(node);
		}
		if (flags & NodeFlag.K_SIGNAL) {
			return updateSignal(node);
		}
		M[node + NodeField.FLAGS] = (flags & NodeFlag.KIND_MASK) | NodeFlag.MUTABLE;
		return true;
	}

	function notify(e: NodeId): void {
		let insertIndex = queuedLength;
		const firstInsertedIndex = insertIndex;

		do {
			queue[insertIndex++] = e;
			M[e + NodeField.FLAGS] &= ~NodeFlag.WATCHING;
			const subs = M[e + NodeField.SUBS];
			e = subs !== 0 ? M[subs + LinkField.SUB] : 0;
			if (e === 0 || !(M[e + NodeField.FLAGS] & NodeFlag.WATCHING)) {
				break;
			}
		} while (true);

		queuedLength = insertIndex;

		// The parent chain was appended child-first: reverse the inserted
		// segment in place so outer effects run before inner.
		let left = firstInsertedIndex;
		while (left < --insertIndex) {
			const tmp = queue[left];
			queue[left++] = queue[insertIndex];
			queue[insertIndex] = tmp;
		}
	}

	function unwatched(node: NodeId): void {
		const flags = M[node + NodeField.FLAGS];
		if (flags & NodeFlag.K_COMPUTED) {
			if (M[node + NodeField.DEPS_TAIL] !== 0) {
				M[node + NodeField.FLAGS] = NodeFlag.K_COMPUTED | NodeFlag.MUTABLE | NodeFlag.DIRTY;
				disposeAllDepsInReverse(node);
			}
		} else if (flags & NodeFlag.K_SIGNAL) {
			// D1: last subscriber detached — the liveness bit flips 1→0.
			if (M[node + NodeField.LIFECYCLE] !== 0) {
				lifecycleUnwatched(node);
			}
		} else if (flags & (NodeFlag.K_EFFECT | NodeFlag.K_SCOPE)) {
			dispose(node);
		}
	}

	// Upstream's HasChildEffect slow path in updateComputed/run: unlink every
	// dep that is not a signal/computed (i.e. child effects/scopes), in reverse.
	function unlinkChildEffects(sub: NodeId): void {
		let cur = M[sub + NodeField.DEPS_TAIL];
		while (cur !== 0) {
			const prev = M[cur + LinkField.PREV_DEP];
			const dep = M[cur + LinkField.DEP];
			if (!(M[dep + NodeField.FLAGS] & (NodeFlag.K_COMPUTED | NodeFlag.K_SIGNAL))) {
				unlink(cur, sub);
			}
			cur = prev;
		}
	}

	function updateComputed(c: NodeId): boolean {
		const oldFlags = M[c + NodeField.FLAGS];
		if (oldFlags & NodeFlag.HAS_CHILD_EFFECT) {
			unlinkChildEffects(c);
		}
		M[c + NodeField.DEPS_TAIL] = 0;
		// D3: the eval-start rewrite PRESERVES the exceptional bits — while the
		// getter runs, the value slot still holds the PREVIOUS outcome, and
		// ctx.previous / the isEqual wrapper need the bits to tell a residual
		// error/thenable payload from a plain previous value.
		M[c + NodeField.FLAGS] = NodeFlag.K_COMPUTED | NodeFlag.MUTABLE | NodeFlag.RECURSED_CHECK
			| (oldFlags & (NodeFlag.HAS_BOX | NodeFlag.BOX_SUSPENDED));
		const prevSub = activeSub;
		activeSub = c;
		++enterDepth;
		const v: ValueIndex = c >> Plane.ID_TO_VALUE_SHIFT;
		const oldValue = vals[v];
		const oldExc: NodeFlags = oldFlags & (NodeFlag.HAS_BOX | NodeFlag.BOX_SUSPENDED);
		// Success clears the exceptional bits (folded into the finally's
		// RECURSED_CHECK clear); the catch overrides with the new outcome's bits.
		let keep = ~(NodeFlag.RECURSED_CHECK | NodeFlag.HAS_BOX | NodeFlag.BOX_SUSPENDED);
		try {
			++cycle;
			// The cutoff treats an outcome-bit delta as a change: transitioning
			// from an exceptional outcome to a plain value must propagate even
			// when the payloads are identity-equal (threw undefined → returns
			// undefined).
			return oldValue !== (vals[v] = (fnTab[c >> Plane.ID_TO_FN_SHIFT] as (ctx: unknown) => unknown)(evalCtx)) || oldExc !== 0;
		} catch (e) {
			// D3: a throwing getter never corrupts graph state — the raw thrown
			// value / pending thenable becomes the cached payload (cold).
			const bits = storeThrown(c, e, oldValue, oldExc);
			M[c + NodeField.FLAGS] = (M[c + NodeField.FLAGS] & ~(NodeFlag.HAS_BOX | NodeFlag.BOX_SUSPENDED)) | bits;
			keep = ~NodeFlag.RECURSED_CHECK;
			return oldExc !== bits || oldValue !== vals[v];
		} finally {
			--enterDepth;
			activeSub = prevSub;
			M[c + NodeField.FLAGS] &= keep;
			purgeDeps(c);
		}
	}

	function updateSignal(s: NodeId): boolean {
		M[s + NodeField.FLAGS] = NodeFlag.K_SIGNAL | NodeFlag.MUTABLE;
		const v: ValueIndex = s >> Plane.ID_TO_VALUE_SHIFT;
		return vals[v] !== (vals[v] = vals[v + Plane.AUX_VALUE_OFFSET]);
	}

	function run(e: NodeId): void {
		const flags = M[e + NodeField.FLAGS];
		if (
			flags & NodeFlag.DIRTY
			|| (flags & NodeFlag.PENDING && checkDirty(M[e + NodeField.DEPS], e))
		) {
			if (flags & NodeFlag.HAS_CHILD_EFFECT) {
				unlinkChildEffects(e);
			}
			const cv: ValueIndex = (e >> Plane.ID_TO_VALUE_SHIFT) + Plane.AUX_VALUE_OFFSET;
			if (vals[cv]) {
				runCleanup(e);
				if (M[e + NodeField.FLAGS] === 0) {
					return; // disposed by its own cleanup
				}
			}
			M[e + NodeField.DEPS_TAIL] = 0;
			M[e + NodeField.FLAGS] = NodeFlag.K_EFFECT | NodeFlag.WATCHING | NodeFlag.RECURSED_CHECK;
			const prevSub = activeSub;
			activeSub = e;
			++enterDepth;
			try {
				++cycle;
				++runDepth;
				vals[cv] = (fnTab[e >> Plane.ID_TO_FN_SHIFT] as () => (() => void) | void)();
			} finally {
				--runDepth;
				--enterDepth;
				activeSub = prevSub;
				M[e + NodeField.FLAGS] &= ~NodeFlag.RECURSED_CHECK;
				purgeDeps(e);
			}
		} else if (M[e + NodeField.DEPS] !== 0) {
			M[e + NodeField.FLAGS] = NodeFlag.K_EFFECT | NodeFlag.WATCHING | (flags & NodeFlag.HAS_CHILD_EFFECT);
		}
	}

	// flush() abort path: re-arm effects still queue after a throw.
	function requeueAbort(e: NodeId): void {
		if (M[e + NodeField.FLAGS] & NodeFlag.KIND_MASK) {
			M[e + NodeField.FLAGS] |= NodeFlag.WATCHING | NodeFlag.RECURSED;
		}
	}

	function runCleanup(e: NodeId): void {
		const cv: ValueIndex = (e >> Plane.ID_TO_VALUE_SHIFT) + Plane.AUX_VALUE_OFFSET;
		const cleanup = vals[cv] as () => void;
		vals[cv] = undefined;
		const prevSub = activeSub;
		activeSub = 0;
		++enterDepth;
		try {
			cleanup();
		} finally {
			--enterDepth;
			activeSub = prevSub;
		}
	}

	// effectOper + effectScopeOper: dispose an effect (runs cleanup) or scope.
	function dispose(e: NodeId): void {
		const flags = M[e + NodeField.FLAGS];
		if (!(flags & NodeFlag.KIND_MASK)) {
			return; // already disposed
		}
		M[e + NodeField.FLAGS] = 0;
		disposeAllDepsInReverse(e);
		const sub = M[e + NodeField.SUBS];
		if (sub !== 0) {
			unlink(sub);
		}
		if (flags & NodeFlag.K_EFFECT && vals[(e >> Plane.ID_TO_VALUE_SHIFT) + Plane.AUX_VALUE_OFFSET]) {
			runCleanup(e);
		}
		// Deferred reclamation: the queue (or an in-flight walk) may still hold
		// this id; the record is swept back onto the free list at the next
		// operation boundary.
		pendingFree.push(e);
	}

	function disposeAllDepsInReverse(sub: NodeId): void {
		let cur = M[sub + NodeField.DEPS_TAIL];
		while (cur !== 0) {
			const prev = M[cur + LinkField.PREV_DEP];
			unlink(cur, sub);
			cur = prev;
		}
	}

	function purgeDeps(sub: NodeId): void {
		const depsTail = M[sub + NodeField.DEPS_TAIL];
		let dep = depsTail !== 0 ? M[depsTail + LinkField.NEXT_DEP] : M[sub + NodeField.DEPS];
		while (dep !== 0) {
			dep = unlink(dep, sub);
		}
	}

	// ---- operations dispatched from the public wrappers ------------------------

	function newSignal(value: unknown): NodeId {
		const id = allocNode(NodeFlag.K_SIGNAL | NodeFlag.MUTABLE);
		const v: ValueIndex = id >> Plane.ID_TO_VALUE_SHIFT;
		vals[v] = value; // currentValue
		vals[v + Plane.AUX_VALUE_OFFSET] = value; // pendingValue
		return id;
	}

	function newComputed(getter: (ctx: unknown) => unknown): NodeId {
		const id = allocNode(NodeFlag.K_COMPUTED);
		fnTab[id >> Plane.ID_TO_FN_SHIFT] = getter;
		return id;
	}

	function newEffect(fn: () => (() => void) | void): NodeId {
		const e = allocNode(NodeFlag.K_EFFECT | NodeFlag.WATCHING | NodeFlag.RECURSED_CHECK);
		fnTab[e >> Plane.ID_TO_FN_SHIFT] = fn;
		const prevSub = activeSub;
		activeSub = e;
		if (prevSub !== 0) {
			link(e, prevSub, 0);
			M[prevSub + NodeField.FLAGS] |= NodeFlag.HAS_CHILD_EFFECT;
		}
		++enterDepth;
		try {
			++runDepth;
			vals[(e >> Plane.ID_TO_VALUE_SHIFT) + Plane.AUX_VALUE_OFFSET] = fn();
		} finally {
			--runDepth;
			--enterDepth;
			activeSub = prevSub;
			M[e + NodeField.FLAGS] &= ~NodeFlag.RECURSED_CHECK;
		}
		return e;
	}

	function newScope(fn: () => void): NodeId {
		const e = allocNode(NodeFlag.K_SCOPE | NodeFlag.MUTABLE);
		const prevSub = activeSub;
		activeSub = e;
		if (prevSub !== 0) {
			link(e, prevSub, 0);
			M[prevSub + NodeField.FLAGS] |= NodeFlag.HAS_CHILD_EFFECT;
		}
		++enterDepth;
		try {
			fn();
		} finally {
			--enterDepth;
			activeSub = prevSub;
		}
		return e;
	}

	// signalOper read path.
	function read(s: NodeId): unknown {
		if (M[s + NodeField.FLAGS] & NodeFlag.DIRTY) {
			if (updateSignal(s)) {
				const subs = M[s + NodeField.SUBS];
				if (subs !== 0) {
					shallowPropagate(subs);
				}
			}
		}
		if (activeSub !== 0) {
			link(s, activeSub, cycle);
		}
		return vals[s >> Plane.ID_TO_VALUE_SHIFT];
	}

	// signalOper write path; the WRAPPER flushes (iff this returns true), so
	// growth can happen between queue effects at the top level (upstream
	// flushes inline here, only when the changed signal had subscribers).
	function write(s: NodeId, value: unknown): boolean {
		const p: ValueIndex = (s >> Plane.ID_TO_VALUE_SHIFT) + Plane.AUX_VALUE_OFFSET;
		if (vals[p] !== (vals[p] = value)) {
			M[s + NodeField.FLAGS] = NodeFlag.K_SIGNAL | NodeFlag.MUTABLE | NodeFlag.DIRTY;
			const subs = M[s + NodeField.SUBS];
			if (subs !== 0) {
				propagate(subs, runDepth !== 0);
				return true;
			}
		}
		return false;
	}

	// computedOper — clean-read fast path. Split from the recompute cases the
	// same way link/linkInsert is split: the monolithic body plus the D2/D3
	// additions sits at 448+ bytecodes, past V8's 460-byte inline cliff
	// (measured: falling off costs ~2.5ns on every clean read). One combined
	// mask test routes every non-trivial case — mid-evaluation re-entry (D2),
	// dirty/pending revalidation, first evaluation, boxed cache (D3) — to the
	// out-of-line slow path.
	function computedRead(c: NodeId): unknown {
		const flags = M[c + NodeField.FLAGS];
		if (
			flags & (NodeFlag.RECURSED_CHECK | NodeFlag.DIRTY | NodeFlag.PENDING | NodeFlag.HAS_BOX)
			|| flags === NodeFlag.K_COMPUTED
		) {
			return computedReadSlow(c, flags);
		}
		if (activeSub !== 0) {
			link(c, activeSub, cycle);
		}
		return vals[c >> Plane.ID_TO_VALUE_SHIFT];
	}

	// The full computedRead decision chain, out of line (recompute/first-eval/boxed).
	function computedReadSlow(c: NodeId, flags: NodeFlags): unknown {
		// D2: reading a computed while its own evaluation frame is open is a
		// dependency cycle — throw instead of serving the stale cache
		// (upstream alien-signals returns the stale cached value here).
		if (flags & NodeFlag.RECURSED_CHECK) {
			throw new CycleError('cosignal: computed read during its own evaluation (dependency cycle).');
		}
		if (
			flags & NodeFlag.DIRTY
			|| (
				flags & NodeFlag.PENDING
				&& (
					checkDirty(M[c + NodeField.DEPS], c)
					|| (M[c + NodeField.FLAGS] = flags & ~NodeFlag.PENDING, false)
				)
			)
		) {
			if (updateComputed(c)) {
				const subs = M[c + NodeField.SUBS];
				if (subs !== 0) {
					shallowPropagate(subs);
				}
			}
		} else if (flags === NodeFlag.K_COMPUTED) { // upstream `!flags`: never evaluated
			M[c + NodeField.FLAGS] = NodeFlag.K_COMPUTED | NodeFlag.MUTABLE | NodeFlag.RECURSED_CHECK;
			const prevSub = activeSub;
			activeSub = c;
			++enterDepth;
			try {
				vals[c >> Plane.ID_TO_VALUE_SHIFT] = (fnTab[c >> Plane.ID_TO_FN_SHIFT] as (ctx: unknown) => unknown)(evalCtx);
			} catch (e) {
				M[c + NodeField.FLAGS] |= storeThrown(c, e, undefined, 0); // D3 (cold; first eval — no previous outcome)
			} finally {
				--enterDepth;
				activeSub = prevSub;
				M[c + NodeField.FLAGS] &= ~NodeFlag.RECURSED_CHECK;
			}
		}
		const sub = activeSub;
		if (sub !== 0) {
			link(c, sub, cycle);
		}
		// D3: an exceptional cache unwraps on the cold path — errors rethrow,
		// settled suspensions self-heal, pending suspensions throw the
		// thenable's stable SuspendedRead. The link above already registered
		// the subscription, so recovery re-notifies whoever observed the throw.
		const f = M[c + NodeField.FLAGS];
		if (f & NodeFlag.HAS_BOX) {
			return boxedRead(c, f);
		}
		return vals[c >> Plane.ID_TO_VALUE_SHIFT];
	}

	// D5: settlement-invalidate primitive. Marks the computed stale exactly the
	// way a dependency write would have and propagates to its subscribers; the
	// wrapper flushes. Cold: called from settle listeners and read-site
	// self-heal only.
	function invalidateComputed(c: NodeId): boolean {
		const flags = M[c + NodeField.FLAGS];
		if (!(flags & NodeFlag.K_COMPUTED)) {
			return false;
		}
		M[c + NodeField.FLAGS] = flags | NodeFlag.DIRTY;
		const subs = M[c + NodeField.SUBS];
		if (subs !== 0) {
			propagate(subs, runDepth !== 0);
			return true;
		}
		return false;
	}
}

// ---- engine instance + growth ------------------------------------------------

const initialRecords = (() => {
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
		.process?.env?.COSIGNAL_INITIAL_RECORDS;
	const n = env !== undefined ? Number(env) : NaN;
	return Number.isFinite(n) && n >= 2 ? Math.ceil(n) : 1 << 20;
})();

// D6: configure({initialRecords}) raises this floor; the growth loop honors it.
let desiredRecords: RecordCount = initialRecords * Plane.RECORDS_PER_UNIT;

/**
 * The fold-purity table (see runFold): every operation throws the fold error
 * (requeueAbort no-ops so flush()'s finally can never mask one). Deliberately
 * its OWN object shape, distinct from createEngine's: V8 groups objects by
 * hidden class (its internal record of an object's layout), and the real
 * engine must stay the only live instance of its hidden class so V8 keeps
 * the table's function fields constant and inlines `E.op` call targets
 * (sharing one hidden class between the two tables measurably killed that:
 * +15-25% on recompute/read-heavy benchmark workloads).
 * Legal code never dispatches through POISON — only fold-purity violations
 * reach it, and those throw — so the polymorphism it could introduce at
 * `E.op` sites is confined to code that is already erroring.
 */
const POISON: Engine = {
	records: 2,
	buffer: foldPoisonOp as never,
	newSignal: foldPoisonOp as never,
	newComputed: foldPoisonOp as never,
	newEffect: foldPoisonOp as never,
	newScope: foldPoisonOp as never,
	gen: foldPoisonOp as never,
	read: foldPoisonOp as never,
	write: foldPoisonOp as never,
	computedRead: foldPoisonOp as never,
	run: foldPoisonOp as never,
	requeueAbort: foldNoop as never,
	dispose: foldPoisonOp as never,
	sweepPendingFree: foldPoisonOp as never,
	invalidateComputed: foldPoisonOp as never,
	markLifecycle: foldPoisonOp as never,
	activeIsComputed: foldPoisonOp as never,
};

// Plane capacity: 3x initialRecords shared records, budgeted as
// initialRecords node records + 2x initialRecords link records in one plane.
let E: Engine = createEngine(initialRecords * Plane.RECORDS_PER_UNIT);

// ---- the host seams -------------------------------------------------------------
// ONE CORE: there is exactly one engine and one write/read path. The
// concurrent-worlds machinery (`./logged.ts`, re-exported at the bottom of
// this file) is the HOST: it needs whole operations — set(value) vs
// update(fn) — because worlds replay recorded writes, and
// it needs world-routed reads while a world evaluation (or a host-declared
// ambient world, e.g. a render pass) is on stack. Both needs attach HERE, in
// the public methods, through two nullable module hooks: undefined until a
// bridge registers (and, for reads, only while a routing context is live), so
// an app that never attaches a host pays exactly one `!== undefined` test per
// public read/write — the empty-state short-circuit is the FIRST test on each
// path — and zero receipt/world work ever runs (asserted behaviorally by
// tests/one-core.spec.ts).

/** Declined-read sentinel: the host read hook returns it to mean "not mine —
 * take the plain kernel path". @internal */
export const __HOST_MISS: { readonly hostMiss: true } = { hostMiss: true };

/** Whole-op codes for the host write hook (0 = set, 1 = update). @internal */
export type HostOpKind = 0 | 1;

/**
 * Host write interceptor. Returns true iff the host consumed the write (the
 * kernel apply then happens through the host's own machinery, re-entering the
 * public method with the hook's recursion guard down). @internal
 */
let hostWrite: ((atom: Atom<unknown>, kind: HostOpKind, payload: unknown) => boolean) | undefined;

/**
 * Host read router. Armed (non-undefined) only while the host has a live
 * routing context — a world evaluation or an ambient world; returns
 * __HOST_MISS to decline. @internal
 */
let hostRead: ((atom: Atom<unknown>) => unknown) | undefined;

/** @internal */
export function __setHostWrite(fn: ((atom: Atom<unknown>, kind: HostOpKind, payload: unknown) => boolean) | undefined): void {
	hostWrite = fn;
}

/** @internal */
export function __setHostRead(fn: ((atom: Atom<unknown>) => unknown) | undefined): void {
	hostRead = fn;
}

/**
 * The host's fold guard: runs a host-side updater/reducer replay under the
 * same POISON table the base `update()`/`dispatch()` use, so raw kernel
 * reads/writes inside a replayed op throw identically in every mode. @internal
 */
export function __hostRunFold<T>(fn: () => T): T {
	return runFold(fn);
}

/**
 * Policy checks a host must run BEFORE recording a write (a receipt must
 * never land for a write the policy layer would have rejected). @internal
 */
export function __assertHostWritable(): void {
	if (forbidWritesInComputeds && E.activeIsComputed()) {
		throw new Error('cosignal: writes inside computeds are forbidden (configure({ forbidWritesInComputeds: true })).');
	}
}

/**
 * Direct kernel apply for the host's quiet-mode fold: the plain-path write
 * tail (`writeAtom` — equality drop, propagation, flush), skipping the
 * public method and its host-seam re-entry. The caller has already run the
 * host-writable policy check and folded the operation to a plain value.
 * @internal
 */
export function __hostApplySet(atom: Atom<unknown>, value: unknown): void {
	writeAtom(atom._id, atom._isEqual, value);
}

/**
 * Newest-value read for the host's own folds and eager applies: the plain
 * kernel read path (`E.read` — dependency tracking included, exactly the
 * public getter minus the host-seam interception), so the host can read the
 * kernel plane regardless of any live routing context without toggling its
 * seams around the call. @internal
 */
export function __hostReadNewest(atom: Atom<unknown>): unknown {
	return E.read(atom._id);
}

function maybeBoundary(): void {
	if (enterDepth === 0 && (growPending || pendingFree.length !== 0)) {
		boundaryWork();
	}
}

function boundaryWork(): void {
	// Sweep only while the effect queue is empty: an un-flushed queue (e.g. a
	// read's shallowPropagate notified an effect after the last flush) may
	// still reference a disposed record, and freeing it here would let a new
	// node reuse the id and be run() by the stale queue entry.
	if (pendingFree.length !== 0 && queuedLength === 0) {
		E.sweepPendingFree();
	}
	if (growPending) {
		growPending = false;
		let records = E.records;
		while (records < desiredRecords || recNext > Math.min((records * Plane.STRIDE) >> Plane.HALF_PLANE_SHIFT, (records - Plane.REC_SLACK) * Plane.STRIDE)) {
			records *= 2;
		}
		if (records !== E.records) {
			E = createEngine(records, E.buffer());
		}
	}
}

function flush(): void {
	// Boundary-lite: growth/reclamation only BEFORE the flush loop, not between
	// effects. Safe because (a) all user code during flush runs at
	// enterDepth >= 1, so E cannot be swapped mid-loop (the `engine` hoist is
	// sound), and (b) the watermark guarantees >= Plane.REC_SLACK (1280) free records
	// at flush start while cascade re-runs re-track through the link() fast
	// path / free lists (net new records per flush audited at ~tens across the
	// conformance suite and benchmark workloads; a pathological cascade that
	// out-allocates the whole remaining plane throws in the allocator rather
	// than corrupting in-flight walks).
	maybeBoundary();
	const engine = E;
	const queue = queued; // function-scope alias survives bundling (see createEngine note)
	try {
		while (notifyIndex < queuedLength) {
			const e = queue[notifyIndex];
			queue[notifyIndex++] = 0;
			engine.run(e);
		}
	} finally {
		while (notifyIndex < queuedLength) {
			const e = queue[notifyIndex];
			queue[notifyIndex++] = 0;
			E.requeueAbort(e);
		}
		notifyIndex = 0;
		queuedLength = 0;
	}
}

// ═══════════════════════════════════════════════════════════════════════════════
// Policy layer
// ═══════════════════════════════════════════════════════════════════════════════

// ---- policy state -------------------------------------------------------------

let forbidWritesInComputeds = false;

function throwFold(): never {
	throw new Error(
		'cosignal: signal reads and writes are not allowed inside an update() updater or a reducer — read before dispatch instead.',
	);
}

// The poison table's operations (hoisted: referenced when POISON is built at
// module init). Every op throws the fold-purity error; requeueAbort no-ops.
function foldPoisonOp(): never {
	throwFold();
}

function foldNoop(): void {}

// ---- observed lifecycle (AtomOptions.effect) -----------------------------------
// Observation is ONE state per registered atom, counted over the UNION of
// consumer kinds. Two kinds feed the refcount:
//   - the kernel liveness bit, contributing exactly 0/1: linkInsert's
//     first-subscriber branch and unwatched()'s signal branch call the two
//     hooks below (guarded by the node's NodeField.LIFECYCLE field, D1);
//   - bridge watchers (the engine's record of one subscribed React
//     component), one ref per live watcher: the watcher liveness setter in
//     ./logged.ts calls __lifecycleRetain/__lifecycleRelease.
// The effect runs on the union's 0→1 transition and the cleanup on its 1→0;
// both run through a microtask queue so observe/unobserve flaps within one
// tick coalesce to nothing REGARDLESS of which consumer kind produced them
// (StrictMode double-mount netting, watcher claim/debounced-unsub, remount
// handoffs). Atoms without the effect option never enter this map, and the
// kernel hot paths stay gated on the LIFECYCLE field — the unregistered path
// pays nothing.

type LifecycleState = {
	effect: (ctx: AtomCtx<unknown>) => void | (() => void);
	ctx: AtomCtx<unknown>;
	cleanup: (() => void) | undefined;
	/** Union refcount: kernel liveness bit (0/1) + one per live bridge watcher. */
	refs: number;
	/** Desired state as of the last union transition (refs > 0). */
	wantMounted: boolean;
	/** Actual state (effect has run and not been cleaned up). */
	isMounted: boolean;
	scheduled: boolean;
};

const lifecycleStates = new Map<NodeId, LifecycleState>();
let lifecycleQueue: LifecycleState[] = [];
let lifecycleFlushScheduled = false;

function scheduleLifecycleFlush(): void {
	if (lifecycleFlushScheduled) {
		return;
	}
	lifecycleFlushScheduled = true;
	queueMicrotask(() => {
		lifecycleFlushScheduled = false;
		const queue = lifecycleQueue;
		lifecycleQueue = [];
		for (const state of queue) {
			state.scheduled = false;
			if (state.wantMounted === state.isMounted) {
				continue; // flap coalesced within one tick
			}
			if (state.wantMounted) {
				state.isMounted = true;
				const result = state.effect(state.ctx);
				state.cleanup = typeof result === 'function' ? result : undefined;
			} else {
				state.isMounted = false;
				const cleanup = state.cleanup;
				state.cleanup = undefined;
				if (cleanup !== undefined) {
					cleanup();
				}
			}
		}
	});
}

function lifecycleShift(id: NodeId, delta: -1 | 1): void {
	const state = lifecycleStates.get(id);
	if (state === undefined) {
		return;
	}
	state.refs += delta;
	const wantMounted = state.refs > 0;
	if (state.wantMounted === wantMounted) {
		return; // interior transition (1↔2, …): the union's edge did not move
	}
	state.wantMounted = wantMounted;
	if (!state.scheduled) {
		state.scheduled = true;
		lifecycleQueue.push(state);
		scheduleLifecycleFlush();
	}
}

// Hoisted function declarations: the kernel calls these from linkInsert /
// unwatched, which are defined earlier in the module. Each is a strict edge
// of the liveness bit (SUBS empty↔non-empty), so the kernel's contribution
// to the union refcount is exactly 0 or 1.
function lifecycleWatched(id: NodeId): void {
	lifecycleShift(id, 1);
}

function lifecycleUnwatched(id: NodeId): void {
	lifecycleShift(id, -1);
}

/**
 * Bridge watcher retain/release — the second consumer kind feeding the
 * observation union (the first is the kernel liveness bit). Called by the
 * engine's watcher plane (./logged.ts) when a watcher over a registered
 * atom's node flips live; a no-op for atoms carrying no observed-lifecycle
 * effect. Direct callbacks only — observation transitions are NOT
 * BridgeEvents and never enter the engine's event/lockstep stream. @internal
 */
export function __lifecycleRetain(id: NodeId): void {
	lifecycleShift(id, 1);
}

/** @internal */
export function __lifecycleRelease(id: NodeId): void {
	lifecycleShift(id, -1);
}

// ---- writes (shared by Atom.set / update / dispatch / lifecycle ctx) -----------

function writeAtom(id: NodeId, isEqual: ((a: unknown, b: unknown) => boolean) | undefined, value: unknown): void {
	// Writes-in-computeds: tolerated by default (upstream alien-signals
	// semantics, conformance-pinned — a write that feeds the evaluating
	// computed simply marks it pending again through the kernel's RECURSED
	// flag transitions in propagate() and settles by lazy revalidation).
	// Evaluation *cycles* —
	// re-entrant reads — throw in computedRead (D2). The configure flag
	// rejects every in-evaluation write. (Known pinhole: a write wrapped in
	// untracked() clears the kernel's activeSub, so the flag cannot see it.)
	if (forbidWritesInComputeds && E.activeIsComputed()) {
		throw new Error('cosignal: writes inside computeds are forbidden (configure({ forbidWritesInComputeds: true })).');
	}
	// Equality drop: with no bridge registered an atom's write history is
	// always empty, so a write equal to the current pending value is simply
	// dropped — this short-circuit is the whole rule. (Under a registered
	// bridge the same drop applies only while the atom has no un-retired
	// receipts: once history exists, different worlds may fold different
	// values.) Policy equality
	// against the newest (pending) value here; the kernel's own identity
	// compare covers the default.
	if (isEqual !== undefined && isEqual(values[(id >> Plane.ID_TO_VALUE_SHIFT) + Plane.AUX_VALUE_OFFSET], value)) {
		return;
	}
	maybeBoundary();
	if (E.write(id, value) && batchDepth === 0) {
		flush();
	}
}

/**
 * Runs a reducer/updater under the fold-purity guard. The rule: updaters and
 * reducers must be pure — a registered bridge stores and replays them per
 * world — so signal reads and writes inside them always throw.
 * Mechanism: the operation table is swapped to the POISON table for the
 * duration, so every read/write/creation the fold attempts throws at the
 * dispatch site — and the hot read/write paths carry zero fold instructions.
 * Folds are synchronous and never open kernel frames of their own; open
 * outer frames hold the real table's buffers as closure constants and are
 * unaffected by the swap.
 */
function runFold<T>(fn: () => T): T {
	const saved = E;
	E = POISON;
	try {
		return fn();
	} finally {
		E = saved;
	}
}

// ---- the computed evaluation policy --------------------------------------------

type InstrumentedThenable = PromiseLike<unknown> & {
	status?: 'pending' | 'fulfilled' | 'rejected';
	value?: unknown;
	reason?: unknown;
	/** The thenable's stable SuspendedRead, minted lazily at the first read
	 * that observes it pending — every read site throws THIS instance while
	 * the thenable is pending, so observers can dedupe by identity. */
	sr?: SuspendedRead;
};

/**
 * ctx.previous (hoisted; called from POLICY_CTX). The evaluating node is the
 * kernel's activeSub; its value slot still holds the previous cached value
 * during the evaluation (updateComputed assigns after the getter returns),
 * and the eval-start rewrite preserved the exceptional bits, so one flag
 * test filters both "not a computed" and "residual error/thenable payload"
 * (which reads as undefined). Leaked-ctx calls outside a computed evaluation
 * fall under `previous`'s license to be arbitrarily stale or undefined.
 */
function ctxPrevious(): unknown {
	const c = activeSub;
	if (c === 0) {
		return undefined;
	}
	if ((E.buffer()[c + NodeField.FLAGS]! & (NodeFlag.K_COMPUTED | NodeFlag.HAS_BOX)) !== NodeFlag.K_COMPUTED) {
		return undefined;
	}
	return values[c >> Plane.ID_TO_VALUE_SHIFT];
}

/**
 * The canonical thenable protocol (mirrors React's trackUsedThenable):
 * instrument `status`/`value`/`reason` onto the thenable itself, once.
 * Settled thenables synchronously return their value / throw their reason;
 * pending ones throw the thenable's stable SuspendedRead (a lazy expando on
 * the thenable, so every read site and every re-evaluation observes ONE
 * "still pending" identity per thenable).
 */
function unwrapThenable(t: InstrumentedThenable): unknown {
	switch (t.status) {
		case 'fulfilled':
			return t.value;
		case 'rejected':
			throw t.reason;
		case 'pending':
			throw (t.sr ??= new SuspendedRead(t));
		default: {
			t.status = 'pending';
			t.then(
				(v: unknown) => {
					if (t.status === 'pending') {
						t.status = 'fulfilled';
						t.value = v;
					}
				},
				(e: unknown) => {
					if (t.status === 'pending') {
						t.status = 'rejected';
						t.reason = e;
					}
				},
			);
			throw (t.sr ??= new SuspendedRead(t));
		}
	}
}

/**
 * Stable serialization of a `ctx.use` key. Scalars serialize with a type
 * discriminant (strings JSON-escape, so `1`, `'1'`, `true`, `'true'`, `null`,
 * `'null'`, `NaN` all stay distinct); arrays serialize recursively. Anything
 * else — functions, objects, undefined, symbols — is rejected loudly.
 */
function serializeUseKey(key: unknown): string {
	if (typeof key === 'string') {
		return JSON.stringify(key);
	}
	if (typeof key === 'number' || typeof key === 'boolean' || key === null) {
		return String(key);
	}
	if (Array.isArray(key)) {
		let out = '[';
		for (let i = 0; i < key.length; i++) {
			if (i !== 0) {
				out += ',';
			}
			out += serializeUseKey(key[i]);
		}
		return out + ']';
	}
	throw new Error(
		'cosignal: ctx.use keys must be strings, numbers, booleans, null, or arrays of those — '
			+ `got ${typeof key}. Put the serializable inputs in the key and close over the rest in the factory.`,
	);
}

/**
 * The two-form ctx.use dispatch over a node-scoped key cache — the ONE
 * suspense implementation, shared with the React bindings' bound computeds
 * (which pass their own per-node holder). See ComputedCtx.use for the
 * contract. The keyed cache is monotone per node: same key ⇒ same thenable
 * for the holder's lifetime — including across worlds, which is safe exactly
 * because the key carries the world-varying inputs (a request cache never
 * un-learns an answer; a world that asks a different question uses a
 * different key). Entries evaporate with the holder (node disposal).
 * @internal — bindings seam, not public API.
 */
export function __ctxUse(
	holder: { _useCache: Map<string, PromiseLike<unknown>> | undefined },
	sourceOrKey: unknown,
	factory: (() => PromiseLike<unknown>) | undefined,
): unknown {
	if (factory === undefined) {
		const t = sourceOrKey as InstrumentedThenable;
		if (t === null || (typeof t !== 'object' && typeof t !== 'function') || typeof t.then !== 'function') {
			throw new Error(
				typeof sourceOrKey === 'function'
					? 'cosignal: the bare factory form ctx.use(fn) was removed — pass ctx.use(key, factory) so the request is cached per key, or cache the promise yourself and pass ctx.use(promise).'
					: 'cosignal: ctx.use takes a thenable, or (key, factory).',
			);
		}
		return unwrapThenable(t);
	}
	if (typeof factory !== 'function') {
		throw new Error('cosignal: ctx.use(key, factory) requires a factory function.');
	}
	const k = serializeUseKey(sourceOrKey);
	const cache = (holder._useCache ??= new Map());
	let t = cache.get(k) as InstrumentedThenable | undefined;
	if (t === undefined) {
		t = factory() as InstrumentedThenable;
		if (t === null || (typeof t !== 'object' && typeof t !== 'function') || typeof t.then !== 'function') {
			throw new Error('cosignal: the ctx.use factory must return a thenable.');
		}
		cache.set(k, t);
	}
	return unwrapThenable(t);
}

/**
 * ctx.use (hoisted; called from POLICY_CTX): resolve the evaluating node's
 * owning Computed (the per-key cache holder) and dispatch. The per-key cache
 * lives on the living node and dies with it — a recreated node refetches,
 * which is React's own uncached-promise story; callers needing cross-death
 * dedup cache the promise in their data layer and use the one-arg form.
 */
function ctxUse(sourceOrKey: unknown, factory: (() => PromiseLike<unknown>) | undefined): unknown {
	const c = activeSub;
	const owner = c !== 0 ? values[(c >> Plane.ID_TO_VALUE_SHIFT) + Plane.AUX_VALUE_OFFSET] : undefined;
	if (!(owner instanceof Computed)) {
		throw new Error('cosignal: ctx.use may only be called during a computed evaluation.');
	}
	return __ctxUse(owner, sourceOrKey, factory);
}

/**
 * The kernel's exception hook (D3), cold: stores whatever a computed
 * evaluation threw as the RAW cached payload — the thrown value for an
 * error, the pending thenable for a suspension — and returns the exceptional
 * flag bits for the outcome. The caller folds the bits into the node's flags
 * and into its change cutoff: same payload + same bits ⇒ no change; any
 * delta ⇒ propagate. The settle listener is attached only on TRANSITION
 * (the previous outcome was not a suspension, or suspended on a different
 * thenable), so re-suspending on the same pending thenable stays
 * listener-stable.
 */
function storeThrown(c: NodeId, e: unknown, oldValue: unknown, oldExc: NodeFlags): NodeFlags {
	const v: ValueIndex = c >> Plane.ID_TO_VALUE_SHIFT;
	if (e instanceof SuspendedRead) {
		const t = e.thenable as InstrumentedThenable;
		values[v] = t;
		if ((oldExc & NodeFlag.BOX_SUSPENDED) === 0 || oldValue !== t) {
			attachSettle(c, t);
		}
		return NodeFlag.HAS_BOX | NodeFlag.BOX_SUSPENDED;
	}
	values[v] = e;
	return NodeFlag.HAS_BOX;
}

/**
 * Settlement-invalidate: when the pending thenable of a suspended computed
 * settles, mark the computed stale and propagate so watchers re-run and
 * readers recompute. Stale-guarded — the node must still cache THIS thenable
 * as a suspension (suspended bit set AND the slot holds `t`) — so
 * out-of-order settlement of superseded work is inert.
 */
function attachSettle(c: NodeId, t: InstrumentedThenable): void {
	const onSettle = (): void => {
		if (
			(E.buffer()[c + NodeField.FLAGS]! & NodeFlag.BOX_SUSPENDED) === 0
			|| values[c >> Plane.ID_TO_VALUE_SHIFT] !== t
		) {
			return;
		}
		try {
			maybeBoundary();
			E.invalidateComputed(c);
			if (batchDepth === 0) {
				flush();
			}
		} catch (err) {
			// Effects that throw during the settle flush surface like any other
			// unhandled error rather than rejecting the settled promise chain.
			queueMicrotask(() => {
				throw err;
			});
		}
	};
	t.then(onSettle, onSettle);
}

/**
 * Cold read tail (hoisted; called from the kernel's computedRead when the
 * HAS_BOX flag is set): the cached value is a raw exceptional payload.
 * Errors rethrow the payload directly. Suspensions whose thenable already
 * settled self-heal (invalidate + recompute) so a read after `await` is
 * deterministic even before the settle listener's microtask runs; pending
 * suspensions throw the thenable's stable SuspendedRead (minted lazily on
 * it). The self-heal re-read recurses through the kernel tail at most once
 * more: a payload stored during the recursion necessarily carries a thenable
 * that was pending at mint, which throws — settlement cannot occur inside
 * this synchronous frame.
 */
function boxedRead(c: NodeId, flags: NodeFlags): unknown {
	const v: ValueIndex = c >> Plane.ID_TO_VALUE_SHIFT;
	if ((flags & NodeFlag.BOX_SUSPENDED) === 0) {
		throw values[v];
	}
	const t = values[v] as InstrumentedThenable;
	if (t.status === undefined || t.status === 'pending') {
		throw (t.sr ??= new SuspendedRead(t));
	}
	E.invalidateComputed(c);
	const next = E.computedRead(c);
	if (batchDepth === 0) {
		flush();
	}
	return next;
}

// ---- public API -----------------------------------------------------------------

/** Passed to an Atom's `effect` option while the atom is observed. */
export type AtomCtx<T> = {
	/** Current value, read without registering a dependency. */
	readonly state: T;
	set(value: T): void;
	update(fn: (current: T) => T): void;
};

export type AtomOptions<T> = {
	/**
	 * Observed lifecycle: runs when the atom gains its first subscriber of
	 * ANY kind — a kernel subscriber (a live computed chain, a core
	 * `effect()`) or a React component subscribed through the bindings (a
	 * bridge watcher; `useSignal`) — and the returned cleanup runs once the
	 * last subscriber of every kind is gone. One observation state over the
	 * union: an atom held by both kinds at once observes exactly once. Both
	 * transitions are delivered in a microtask so observe/unobserve flaps
	 * within one tick coalesce. Bare `.state` reads are not subscriptions and
	 * do not observe. Intended for remote subscriptions.
	 */
	effect?: (ctx: AtomCtx<T>) => void | (() => void);
	/**
	 * Policy equality for writes: an incoming value equal to the newest value
	 * is dropped (unconditionally with no bridge registered; under a bridge,
	 * only while the atom's write history holds no un-retired receipts). The
	 * kernel itself compares reference identity only; keep values
	 * reference-stable rather than relying on deep equality.
	 */
	isEqual?: (a: T, b: T) => boolean;
	/** Debug label. */
	label?: string;
};

export type ComputedOptions<T> = {
	/**
	 * Policy equality for recomputes: an equal result returns the previous
	 * reference, so downstream sees no change (equality cutoff). The kernel
	 * compares identity only.
	 */
	isEqual?: (a: T, b: T) => boolean;
	/** Debug label. */
	label?: string;
};

/** A writable signal. `.state` reads (tracked inside evaluations), `.set` writes. */
export class Atom<T> {
	/** Kernel record id; consumed by the React bindings (`cosignal-react`). @internal */
	readonly _id: NodeId;
	/** @internal */
	readonly _isEqual: ((a: unknown, b: unknown) => boolean) | undefined;
	/** Host adoption stamp — `{ b: theBridge, n: itsAtomNode }`, written by the
	 * host at registration/adoption so the per-write registry lookup is one
	 * property load + identity compare instead of a Map probe. Declared here
	 * (and initialized) so every Atom shares one hidden class. @internal */
	_hostStamp: { b: unknown; n: unknown } | undefined;
	readonly label: string | undefined;

	constructor(initialState: T, options?: AtomOptions<T>) {
		maybeBoundary();
		const id = E.newSignal(initialState);
		this._id = id;
		this._isEqual = options?.isEqual as ((a: unknown, b: unknown) => boolean) | undefined;
		this._hostStamp = undefined;
		this.label = options?.label;
		const effect = options?.effect;
		if (effect !== undefined) {
			E.markLifecycle(id);
			const isEqual = this._isEqual;
			const self = this as Atom<unknown>;
			lifecycleStates.set(id, {
				effect: effect as (ctx: AtomCtx<unknown>) => void | (() => void),
				ctx: {
					get state(): unknown {
						return untracked(() => E.read(id));
					},
					set(value: unknown): void {
						if (hostWrite !== undefined && hostWrite(self, 0, value)) {
							return;
						}
						writeAtom(id, isEqual, value);
					},
					update(fn: (current: unknown) => unknown): void {
						if (hostWrite !== undefined && hostWrite(self, 1, fn)) {
							return;
						}
						const next = runFold(() => fn(values[(id >> Plane.ID_TO_VALUE_SHIFT) + Plane.AUX_VALUE_OFFSET]));
						writeAtom(id, isEqual, next);
					},
				},
				cleanup: undefined,
				refs: 0,
				wantMounted: false,
				isMounted: false,
				scheduled: false,
			});
		}
	}

	/**
	 * The atom's current value (registers a dependency inside evaluations).
	 * With a host routing context live (world evaluation / ambient world),
	 * the host serves the value of the world doing the asking. Inside a fold
	 * frame the dispatch itself throws (POISON table).
	 *
	 * KERNEL-FRAME READS ARE NEVER WORLD-ROUTED (`activeSub === 0` guards the
	 * seam): a read inside an open kernel evaluation (a `Computed` getter, an
	 * `effect()` body) creates a K0 dependency link and its result lands in a
	 * K0 cache slot, and K0 state is newest-world state by the eager-apply
	 * invariant — serving a world-folded value there would poison the kernel
	 * cache (a later newest read of the computed would serve another world's
	 * value with no invalidation: tearing). World routing belongs to overlay
	 * evaluations and render/effect call contexts, all of which run with no
	 * kernel frame open. (Known pinhole, same shape as the documented
	 * forbidWritesInComputeds one: `untracked()` inside a kernel getter
	 * clears activeSub, so a routed read there can still reach the getter's
	 * return value; untracked reads leave no K0 link, but the cache slot
	 * still absorbs the result.) Pinned by tests/graph-consumers.spec.ts.
	 */
	get state(): T {
		const hr = hostRead;
		if (hr !== undefined && activeSub === 0) {
			const v = hr(this as Atom<unknown>);
			if (v !== __HOST_MISS) {
				return v as T;
			}
		}
		return E.read(this._id) as T;
	}

	/** Replaces the atom's value. A host-attributable write is recorded whole. */
	set(value: T): void {
		if (hostWrite !== undefined && hostWrite(this as Atom<unknown>, 0, value)) {
			return;
		}
		writeAtom(this._id, this._isEqual, value);
	}

	/**
	 * Functional update. `fn` must be pure: it runs under the fold-purity
	 * guard, so signal reads and writes inside it throw — read what you need
	 * first, then update. A host-attributable update records the WHOLE op
	 * (the updater itself, replayed per world); otherwise it applies
	 * immediately.
	 */
	update(fn: (current: T) => T): void {
		if (hostWrite !== undefined && hostWrite(this as Atom<unknown>, 1, fn)) {
			return;
		}
		const id = this._id;
		const next = runFold(() => fn(values[(id >> Plane.ID_TO_VALUE_SHIFT) + Plane.AUX_VALUE_OFFSET] as T));
		writeAtom(id, this._isEqual, next);
	}
}

export type ReducerAtomOptions<S> = AtomOptions<S>;

/**
 * An atom whose writes go through a reducer. The reducer is fixed at
 * creation and must be pure — it runs under the fold-purity guard.
 * A thin layer over `update`: dispatch(action) is exactly
 * `update(s => reduce(s, action))`, so with a bridge registered the
 * recorded op is an UPDATE whose closure carries the reducer and the
 * action — replayed per world like any other updater.
 */
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
	/** Kernel record id; consumed by the React bindings (`cosignal-react`). @internal */
	readonly _id: NodeId;
	/** ctx.use(key, factory) cache, scoped to this living node (lazily
	 * created; dies with the node). Same key ⇒ same thenable for the node's
	 * lifetime. @internal */
	_useCache: Map<string, PromiseLike<unknown>> | undefined;
	readonly label: string | undefined;

	constructor(fn: (ctx: ComputedCtx<T>) => T, options?: ComputedOptions<T>) {
		maybeBoundary();
		this._useCache = undefined;
		this.label = options?.label;
		const isEqual = options?.isEqual as ((a: unknown, b: unknown) => boolean) | undefined;
		const id = E.newComputed(fn as (ctx: unknown) => unknown);
		this._id = id;
		// D4: the aux value slot carries the owning instance (policy state).
		values[(id >> Plane.ID_TO_VALUE_SHIFT) + Plane.AUX_VALUE_OFFSET] = this;
		if (isEqual !== undefined) {
			// Only equality users pay a wrapper: an equal result returns the
			// OLD reference so the kernel's identity compare sees no change.
			// The wrapper runs inside the evaluation, where the eval-start
			// rewrite preserved the exceptional bits — HAS_BOX set means `prev`
			// is a residual error/thenable payload, not a comparable value.
			const iv: ValueIndex = id >> Plane.ID_TO_VALUE_SHIFT;
			fns[id >> Plane.ID_TO_FN_SHIFT] = (ctxArg: unknown): unknown => {
				const prev = values[iv];
				const next = (fn as (ctx: unknown) => unknown)(ctxArg);
				if (prev === undefined || (E.buffer()[id + NodeField.FLAGS]! & NodeFlag.HAS_BOX) !== 0) {
					return next;
				}
				return isEqual(prev, next) ? prev : next;
			};
		}
	}

	/**
	 * The computed's current value. Rethrows the evaluation's cached error;
	 * throws SuspendedRead while suspended on a pending `ctx.use` thenable
	 * (the kernel's boxed-read tail, D3). Inside a fold frame the dispatch
	 * itself throws (POISON table).
	 */
	get state(): T {
		return E.computedRead(this._id) as T;
	}
}

/** Either public signal wrapper. */
export type Signal<T> = Atom<T> | Computed<T>;

/**
 * Runs `fn` immediately with dependency tracking and re-runs it when tracked
 * signals change. Effects always observe the newest world (every write
 * applied) — with no bridge registered, simply the current values. `fn` may
 * return a cleanup run before each re-run and at dispose. Returns a disposer.
 */
export function effect(fn: () => void | (() => void)): () => void {
	maybeBoundary();
	const id = E.newEffect(fn);
	const gen = E.gen(id);
	return () => {
		if (E.gen(id) !== gen) {
			return; // record already reclaimed (and possibly reused)
		}
		E.dispose(id);
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
		E.dispose(id);
		maybeBoundary();
	};
}

/**
 * Defers effect flushing to the batch's close. Nothing else: no implicit
 * grouping of any kind exists anywhere in the engine.
 */
export function batch<T>(fn: () => T): T {
	++batchDepth;
	try {
		return fn();
	} finally {
		if (!--batchDepth && notifyIndex < queuedLength) {
			flush();
		}
	}
}

/** Low-level batch surface (adapter/bindings plumbing; prefer batch()). */
export function startBatch(): void {
	++batchDepth;
}

export function endBatch(): void {
	if (!--batchDepth && notifyIndex < queuedLength) {
		flush();
	}
}

/** Reads inside `fn` register no dependency edges. */
export function untracked<T>(fn: () => T): T {
	const prevSub = activeSub;
	activeSub = 0;
	try {
		return fn();
	} finally {
		activeSub = prevSub;
	}
}

export type ConfigureOptions = {
	/**
	 * When true, any atom write during a computed evaluation throws. When
	 * false (default), writes inside computeds are tolerated as long as they
	 * do not re-enter the writing computed (evaluation cycles throw
	 * CycleError; self-feedback writes settle by lazy revalidation,
	 * alien-signals semantics).
	 */
	forbidWritesInComputeds?: boolean;
	/**
	 * Capacity floor, in records (one signal/computed/effect node or one
	 * dependency link each; the plane holds 3× this number — budgeted as one
	 * node plus two links per unit). Raising it triggers growth at the next
	 * operation boundary; it never shrinks. Also settable via the
	 * COSIGNAL_INITIAL_RECORDS env var before first import.
	 */
	initialRecords?: number;
};

export function configure(options: ConfigureOptions): void {
	if (options.forbidWritesInComputeds !== undefined) {
		forbidWritesInComputeds = options.forbidWritesInComputeds;
	}
	const n = options.initialRecords;
	if (n !== undefined) {
		if (!Number.isFinite(n) || n < 2) {
			throw new Error('cosignal: configure({ initialRecords }) must be a number >= 2.');
		}
		const target = Math.ceil(n) * Plane.RECORDS_PER_UNIT;
		if (target > desiredRecords) {
			desiredRecords = target;
		}
		if (E.records < desiredRecords) {
			growPending = true;
			maybeBoundary();
		}
	}
}

// ---- the concurrent-worlds engine (the host) --------------------------------------
// ONE public entry: the batch/world machinery lives in ./logged.ts and is
// re-exported here — `registerReactBridge()`, `CosignalBridge`, the bridge
// surface types (Seq, SlotSet, Receipt, BridgeEvent, …). Until
// registerReactBridge() runs, none of it executes: the host seams above stay
// undefined and every read/write short-circuits into the plain kernel path.
// CURATED (no `export *`): the engine's internals — the packed Tape class,
// node/watcher class VALUES, module seams — stay importable only from
// './logged.js' inside this package; consumers get the activation function,
// the bridge, its error classes, the two @internal test seams the sibling
// packages' suites drive, and the bridge-surface TYPES.
export {
	registerReactBridge,
	CosignalBridge,
	BridgeScheduleError,
	BridgeInvariantViolation,
	// @internal test seams (cosignal-react's suite constructs per-test bridges
	// and one-core.spec proves the zero-cost promise through these):
	__newBridgeForTest,
	__coreProbes,
} from './logged.js';
export type {
	// entities (type-only: the classes construct nowhere outside the engine)
	AtomNode,
	Watcher,
	ComputedNode,
	AnyNode,
	Token,
	Pass,
	PassState,
	RootState,
	SlotMeta,
	WatcherSnapshot,
	ReactEffect,
	CoreEffect,
	// operations and worlds (the tracing hook types stay on the
	// `cosignal/trace` side of the seam; this entry never names them)
	Op,
	Receipt,
	World,
	BridgeEvent,
	Reader,
	ComputedFn,
	Equals,
	// scalar brands
	Value,
	NodeId,
	TokenId,
	SlotId,
	RootId,
	PassId,
	WatcherId,
	EffectId,
	Seq,
	Epoch,
	CommitGen,
	SlotSet,
	KernelId,
} from './logged.js';
