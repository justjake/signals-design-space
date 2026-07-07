/**
 * cosignal — the package entry: the POLICY LAYER over the kernel, the host
 * seams the concurrent engine attaches through, and the public surface.
 *
 * ─── VOCABULARY (in reading order; used throughout this package) ─────────────
 *
 * THE KERNEL is the dependency-tracking engine (graph.ts). It stores every signal, computed, effect, and dependency edge as a
 * fixed-size integer record in shared arrays, and runs the reactive
 * algorithm — writes push staleness marks down the graph, reads lazily pull
 * recomputation — as index arithmetic over those records. The kernel knows
 * nothing about user options: it compares values by reference identity only,
 * has no error handling of its own, and no async story.
 *
 * THE POLICY LAYER is everything user-facing in this file — the
 * Atom / ReducerAtom / Computed classes, effect(), configure(), plus the
 * re-exported batch()/untracked() (kernel-state mechanisms living with
 * their counters in graph.ts). "Policy" always means a user-visible behavior
 * decided outside the kernel: custom equality, what thrown errors and
 * pending async reads do, the purity rules. The split exists so the kernel's
 * hot paths stay small monomorphic integer code while every rule that could
 * change lives in ordinary cold JavaScript around it.
 *
 * Kernel storage terms:
 * - THE ARENA is the one shared Int32Array (`memory` in createEngine) holding
 *   every record: a preallocated block that records are carved out of
 *   (error messages use the same word). A RECORD is RecordGeom.STRIDE (8)
 *   consecutive Int32 slots; node records (signals/computeds/effects/scopes)
 *   and link records (one dependency edge each) share the arena, the stride,
 *   and one allocator.
 * - A record's id is PREMULTIPLIED: it is the arena index of the record's
 *   first field (record ordinal × RecordGeom.STRIDE), so every field access is
 *   plain addition — memory[id + NodeField.FLAGS] — with no multiply anywhere.
 * - JavaScript values and functions cannot live in an Int32Array, so they
 *   sit in ordinary arrays running parallel to the arena — the SIDE COLUMNS
 *   `values` and `fns` — indexed by shifting the same premultiplied id (see
 *   the RecordGeom const enum).
 *
 * Mechanics the whole package relies on (implementation and full stories in
 * graph.ts):
 * - OPERATION BOUNDARY: a moment when no evaluation, effect run, or graph
 *   walk is anywhere on the call stack (`enterDepth === 0`). Deferred work —
 *   growing the arena, freeing disposed records — runs only at boundaries,
 *   because in-flight work holds direct references to the buffers.
 * - CLOSURE REBUILD: the kernel's functions are created by one factory
 *   (`createEngine`) and capture the arena as a closure constant — which is
 *   what lets V8 fold the buffer reference into compiled code. The cost of
 *   that choice: the buffer cannot be swapped under a live function. So to
 *   grow, the module allocates a doubled arena, copies the records over, and
 *   calls the factory again, producing a fresh set of functions closed over
 *   the new buffer. That wholesale re-creation is a "closure rebuild"; it
 *   happens only at operation boundaries. Scalar counters live at module
 *   level (not in the closure) precisely so a rebuilt engine resumes where
 *   the old one stopped.
 * - FOLD: applying a user's updater or reducer function to a value to
 *   produce the next value. The name comes from the concurrent engine
 *   (`./concurrent.ts`, part of this same entry), which reconstructs
 *   alternative views of the state ("worlds", see the README) by
 *   re-applying — folding — recorded write operations over a base value;
 *   that only works if updaters and reducers are pure. They therefore run
 *   under the same FOLD-PURITY guard whether or not a bridge is registered:
 *   signal reads and writes inside an updater or reducer throw (see
 *   runFold).
 *
 * With that vocabulary, the package's kernel-side layers and their homes:
 *
 *   1. Sentinels (SuspendedRead — suspense.ts; CycleError — below). A
 *      computed's function can fail
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
 *      receives (`ctx.previous`, `ctx.use`; the ComputedCtx type below). Its
 *      members are getters that resolve "which computed is evaluating right
 *      now" from kernel state, so passing it costs zero per-recompute setup
 *      (the object lives in graph.ts beside its capture site; the member
 *      functions and the whole suspension machinery live in suspense.ts).
 *   3. The kernel (graph.ts) — alien-signals v3.2.1's push-pull algorithm, re-expressed
 *      over arena records instead of linked JavaScript objects. Upstream's
 *      walk structure and flag transitions are preserved (plus a
 *      link/linkInsert hot/slow split, see linkInsert); buffers are closure
 *      constants; walks use persistent scratch stacks (module-level
 *      Int32Array stacks reused across walks, replacing upstream's per-walk
 *      linked-list allocations); capacity grows by closure rebuild over
 *      doubled buffers at operation boundaries. Validated against a 179-case
 *      conformance suite (179/179) for alien-signals-compatible semantics.
 *      Deviations from a plain transliteration of upstream are enumerated
 *      below (D1–D7).
 *   4. The policy layer (this file) — the classes and functions named above;
 *      custom equality by wrapper-returns-old-reference; errors/suspensions
 *      as sentinel boxes (suspense.ts); the observed lifecycle
 *      (AtomOptions.effect — the "first subscriber attached / last one
 *      detached" callback, counted over the union of kernel subscribers and
 *      bridge watchers, lifecycle.ts) with microtask flap damping; the
 *      fold-purity and writes-in-computeds disciplines.
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
 * (`./concurrent.ts`, re-exported at the bottom of this file: `registerReactBridge`,
 * `CosignalBridge`, the bridge types) attaches to this kernel through the
 * HOST SEAMS — two nullable module hooks consulted FIRST in the public
 * read/write methods (see "the host seams" section below). Sync-only apps
 * that never register a bridge keep both hooks undefined forever: the whole
 * concurrency feature costs one predictable `!== undefined` branch per
 * public read/write, and zero log entries, batches, worlds, or bridge events are
 * ever created (tests/one-core.spec.ts asserts this behaviorally with engine
 * probes). The only other swapped table is POISON (fold purity — graph.ts,
 * swapped through runFold below) — reachable exclusively by erroring code.
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
 *       of the observation union (bridge watchers and the host observation
 *       index are the other; see the observed-lifecycle section). Since
 *       S-C the kernel arm is a per-LINK refcount (linkInsert +1 /
 *       unlink -1, lifecycle-flagged deps only, HOST_OWNED subscribers
 *       excluded — host computeds carry their own observation arm); the
 *       union's observable edges (effect at 0→1, cleanup at →0) are
 *       unchanged. Cleared in freeNode.
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
 *       the arena before first import, and configure({initialRecords})
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
 * not, documented at its implementation sites in graph.ts.
 */

import { E, MIN_INITIAL_RECORDS, NodeField, NodeFlag, RecordGeom, activeSub, batchDepth, flush, fns, foldGuardRestore, foldGuardSwap, maybeBoundary, requestCapacity, untracked, values } from './graph.js';
import { lifecycleStates } from './lifecycle.js';
import type { NodeId, ValueIndex } from './graph.js';

// ---- sentinels ----------------------------------------------------------------

// SuspendedRead — the stable "this value is still loading" sentinel thrown
// by reads that observe a pending suspension — lives in suspense.ts with the
// rest of the suspension machinery; re-exported here (public surface).
export { SuspendedRead } from './suspense.js';

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

// (The ONE evaluation-context OBJECT the kernel passes every computed getter
// — POLICY_CTX — lives in graph.ts beside its capture site (createEngine
// captures it at factory run, so it must be initialized before the kernel
// builds); its members delegate to suspense.ts's ctxPrevious/ctxUse.)

// ---- THE KERNEL (graph.ts) --------------------------------------------------
// The whole dependency-tracking engine — the record layout const enums
// (NodeField/LinkField/NodeFlag, re-exported below for independent walkers;
// RecordGeom addresses the side columns), allocation, the link/propagate/
// checkDirty walk families, update/notify/run/dispose, the flush queue,
// growth by closure rebuild, the `values`/`fns` side columns, the walk
// scratch stacks, and the fold-purity POISON table — lives in graph.ts. The
// policy layer below reads the CURRENT operation table through the one
// mutable slot `E` (re-linked only at growth boundaries) and the shared
// side columns/scalars through their imported bindings.
export { NodeField, LinkField, NodeFlag } from './graph.js';







// ---- the host seams -------------------------------------------------------------
// ONE CORE: there is exactly one engine and one write/read path. The
// concurrent-worlds machinery (`./concurrent.ts`, re-exported at the bottom of
// this file) is the HOST: it needs whole operations — set(value) vs
// update(fn) — because worlds replay recorded writes, and
// it needs world-routed reads while a world evaluation (or a host-declared
// ambient world, e.g. a render pass) is on stack. Both needs attach HERE, in
// the public methods, through two nullable module hooks: undefined until a
// bridge registers (and, for reads, only while a routing context is live), so
// an app that never attaches a host pays exactly one `!== undefined` test per
// public read/write — the empty-state short-circuit is the FIRST test on each
// path — and zero log entry/world work ever runs (asserted behaviorally by
// tests/one-core.spec.ts).

/** Declined-read sentinel: the host read hook returns it to mean "not mine —
 * take the plain kernel path". @internal */
export const __HOST_MISS: { readonly hostMiss: true } = { hostMiss: true };

/** Whole-op codes for the host write hook (0 = set, 1 = update). @internal */
export type WriteKind = 0 | 1;

/**
 * Host write interceptor. Returns true iff the host consumed the write (the
 * kernel apply then happens through the host's own machinery, re-entering the
 * public method with the hook's recursion guard down). @internal
 */
let hostWrite: ((atom: Atom<unknown>, kind: WriteKind, payload: unknown) => boolean) | undefined;

/**
 * Host read router. Armed (non-undefined) only while the host has a live
 * routing context — a world evaluation or an ambient world; returns
 * __HOST_MISS to decline. @internal
 */
let hostRead: ((atom: Atom<unknown>) => unknown) | undefined;

/**
 * Host COMPUTED read router (S-C: one computed — kernel `Computed` records
 * evaluate under worlds). Armed/disarmed in lockstep with `hostRead`; the
 * same `activeSub === 0` gate applies (kernel-frame reads are never
 * world-routed). Returns __HOST_MISS to decline. @internal
 */
let hostComputedRead: ((c: Computed<unknown>) => unknown) | undefined;

/** @internal */
export function __setHostWrite(fn: ((atom: Atom<unknown>, kind: WriteKind, payload: unknown) => boolean) | undefined): void {
	hostWrite = fn;
}

/** @internal */
export function __setHostRead(fn: ((atom: Atom<unknown>) => unknown) | undefined): void {
	hostRead = fn;
}

/** @internal */
export function __setHostComputedRead(fn: ((c: Computed<unknown>) => unknown) | undefined): void {
	hostComputedRead = fn;
}

// The record-free hook — invoked at the boundary sweep for every freed NODE
// record, so hosts keying dense side tables by NodeField.NODE_INDEX can
// scrub the freed record's rows — lives in graph.ts with freeNode, its one
// caller; the registration seam is re-exported here (host seam surface).
export { __setRecordFreeHook } from './graph.js';

/**
 * The host's fold guard: runs a host-side updater/reducer replay under the
 * same POISON table the base `update()`/`dispatch()` use, so raw kernel
 * reads/writes inside a replayed op throw identically in every mode. @internal
 */
export function __hostRunFold<T>(fn: () => T): T {
	return runFold(fn);
}

/**
 * Policy checks a host must run BEFORE recording a write (a log entry must
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
 * kernel arena regardless of any live routing context without toggling its
 * seams around the call. @internal
 */
export function __hostReadNewest(atom: Atom<unknown>): unknown {
	return E.read(atom._id);
}

/**
 * Raw kernel computed read for the host's own newest serving (S-C): the
 * plain kernel path — recompute-if-stale, kernel links to any open kernel
 * frame, boxed-read unwrap — minus the host-seam interception, so the host
 * serves the newest world off the kernel regardless of any live routing
 * context. @internal
 */
export function __kernelComputedRead(c: Computed<unknown>): unknown {
	return E.computedRead(c._id);
}

/** @internal Test seam (leak audit): a record's side-column slots. freeNode
 * must clear all three, or freed records pin dead values/closures for the
 * arena's life; tests/leak-audit.spec.ts probes exactly that. Read-only. */
export function __kernelSideColumnsForTest(id: NodeId): { value: unknown; aux: unknown; fn: Function | undefined } {
	const v: ValueIndex = id >> RecordGeom.ID_TO_VALUE_SHIFT;
	return { value: values[v], aux: values[v + RecordGeom.AUX_VALUE_OFFSET], fn: fns[id >> RecordGeom.ID_TO_FN_SHIFT] };
}

/**
 * Raw arena view for the host's kernel-link strong walks (S-C: newest
 * subscription reach + the mount-fixup closure's kernel leg ride the
 * kernel's own dep links). The buffer is valid only until the next growth
 * boundary — hosts must re-fetch per walk and never retain it across public
 * operations. Field offsets are the host's mirrored constants (asserted
 * stable by the suite). @internal
 */
export function __kernelBuffer(): Int32Array {
	return E.buffer();
}

/**
 * Dispose a computed record (S-C — the useComputed deps-change reclamation
 * path): unlink its deps in reverse, detach every remaining subscriber
 * link, and defer the free to the next operation boundary (GEN bumps at the
 * sweep; the freed id is then reusable). The caller owns the discipline
 * that no live consumer still reads the handle — a disposed handle's reads
 * serve garbage, exactly like a use-after-dispose anywhere else. @internal
 */
export function __hostDisposeComputed(c: Computed<unknown>): void {
	maybeBoundary();
	E.disposeComputed(c._id);
	maybeBoundary(); // sweep now when possible, so the id-tenancy GEN moves at this boundary
}

/**
 * Flag a computed record HOST-owned (S-C): its kernel dep links stop
 * feeding the D1 observed-lifecycle union — the host's observation index
 * is its arm. See NodeFlag.HOST_OWNED and the engine op. @internal
 */
export function __hostMarkComputedOwned(c: Computed<unknown>): void {
	E.markHostOwned(c._id);
}

/**
 * Wrap a computed's kernel getter with a host epilogue (S-C: the bridge's
 * observation re-pointing rides every kernel re-run of an adopted computed,
 * and bridge-created computeds get their world-fn adapters this way).
 * Policy wrappers (custom equality) stay INSIDE the wrap — the host sees the
 * same fn the kernel would have run. @internal
 */
export function __hostWrapComputedFn(id: NodeId, wrap: (inner: (ctx: unknown) => unknown) => (ctx: unknown) => unknown): void {
	fns[id >> RecordGeom.ID_TO_FN_SHIFT] = wrap(fns[id >> RecordGeom.ID_TO_FN_SHIFT] as (ctx: unknown) => unknown);
}

// (maybeBoundary / boundaryWork / flush — the operation-boundary machinery
// and the effect flush loop — live in graph.ts with the queue and growth
// state they drain; the policy layer imports maybeBoundary/flush directly.)

// ═══════════════════════════════════════════════════════════════════════════════
// Policy layer
// ═══════════════════════════════════════════════════════════════════════════════

// ---- policy state -------------------------------------------------------------

let forbidWritesInComputeds = false;

// (throwFold / the POISON table's operations live in graph.ts with the
// table; runFold below swaps through graph.ts's fold-guard pair.)

// ---- observed lifecycle (AtomOptions.effect) -----------------------------------
// The observed-lifecycle option — the per-atom state map, the union
// refcount, and the flap-damped microtask flush — lives in lifecycle.ts
// (its header carries the full story). The Atom constructor below registers
// each lifecycle-carrying atom into `lifecycleStates`; the kernel arm feeds
// the refcount from linkInsert/unlink; the bridge-watcher arm enters
// through these re-exported seams (host seam surface, called by the
// concurrent engine's observation index).
export { __lifecycleRetain, __lifecycleRelease } from './lifecycle.js';

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
	// log entries: once history exists, different worlds may fold different
	// values.) Policy equality
	// against the newest (pending) value here; the kernel's own identity
	// compare covers the default.
	if (isEqual !== undefined && isEqual(values[(id >> RecordGeom.ID_TO_VALUE_SHIFT) + RecordGeom.AUX_VALUE_OFFSET], value)) {
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
 * duration (graph.ts's fold-guard pair), so every read/write/creation the fold attempts throws at the
 * dispatch site — and the hot read/write paths carry zero fold instructions.
 * Folds are synchronous and never open kernel frames of their own; open
 * outer frames hold the real table's buffers as closure constants and are
 * unaffected by the swap.
 */
function runFold<T>(fn: () => T): T {
	const saved = foldGuardSwap();
	try {
		return fn();
	} finally {
		foldGuardRestore(saved);
	}
}

// ---- the computed evaluation policy (suspense.ts) --------------------------------
// The suspension/exception machinery — the thenable protocol, the ctx.use
// request cache, the kernel's storeThrown/boxedRead cold hooks, and the
// settle tap — lives in suspense.ts (its header carries the full story);
// the two seams below are re-exported (bindings/bridge surface).
export { __setSettleTap, __ctxUse } from './suspense.js';










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
	 * only while the atom's write history holds no un-retired log entries). The
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
	readonly label: string | undefined;

	constructor(initialState: T, options?: AtomOptions<T>) {
		maybeBoundary();
		const id = E.newSignal(initialState);
		this._id = id;
		this._isEqual = options?.isEqual as ((a: unknown, b: unknown) => boolean) | undefined;
		this.label = options?.label;
		const effect = options?.effect;
		if (effect !== undefined) {
			E.markLifecycle(id);
			const self = this as Atom<unknown>;
			lifecycleStates.set(id, {
				effect: effect as (ctx: AtomCtx<unknown>) => void | (() => void),
				// ctx.set/update delegate to the public methods — they ARE the
				// one write path (host-seam interception, fold-purity guard and
				// equality policy live there, never re-implemented here).
				ctx: {
					get state(): unknown {
						return untracked(() => E.read(id));
					},
					set(value: unknown): void {
						self.set(value);
					},
					update(fn: (current: unknown) => unknown): void {
						self.update(fn);
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
		const next = runFold(() => fn(values[(id >> RecordGeom.ID_TO_VALUE_SHIFT) + RecordGeom.AUX_VALUE_OFFSET] as T));
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
	/** §4.5.3 retention columns (S-C): the RAW authored fn and the policy
	 * comparator, kept on the owning instance (GC-owned, so a reused kernel
	 * id can never serve another tenant's fn/comparator) — the host's world
	 * evaluations run the raw fn against WORLD-local previous values; the
	 * kernel's own equality wrapper stays kernel-slot-scoped. @internal */
	readonly _fn: (ctx: ComputedCtx<T>) => T;
	/** @internal */
	readonly _isEqual: ((a: unknown, b: unknown) => boolean) | undefined;
	readonly label: string | undefined;

	constructor(fn: (ctx: ComputedCtx<T>) => T, options?: ComputedOptions<T>) {
		maybeBoundary();
		this._useCache = undefined;
		this._fn = fn;
		this.label = options?.label;
		const isEqual = options?.isEqual as ((a: unknown, b: unknown) => boolean) | undefined;
		this._isEqual = isEqual;
		const id = E.newComputed(fn as (ctx: unknown) => unknown);
		this._id = id;
		// D4: the aux value slot carries the owning instance (policy state).
		values[(id >> RecordGeom.ID_TO_VALUE_SHIFT) + RecordGeom.AUX_VALUE_OFFSET] = this;
		if (isEqual !== undefined) {
			// Only equality users pay a wrapper: an equal result returns the
			// OLD reference so the kernel's identity compare sees no change.
			// The wrapper runs inside the evaluation, where the eval-start
			// rewrite preserved the exceptional bits — HAS_BOX set means `prev`
			// is a residual error/thenable payload, not a comparable value.
			const iv: ValueIndex = id >> RecordGeom.ID_TO_VALUE_SHIFT;
			fns[id >> RecordGeom.ID_TO_FN_SHIFT] = (ctxArg: unknown): unknown => {
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
	 *
	 * With a host routing context live (world evaluation / ambient world),
	 * the host serves the value of the world doing the asking — the S-C
	 * computed-read seam, the exact twin of Atom.state's: armed only while a
	 * routing context exists, gated on `activeSub === 0` (KERNEL-FRAME READS
	 * ARE NEVER WORLD-ROUTED — see Atom.state for the poisoning argument).
	 */
	get state(): T {
		const hr = hostComputedRead;
		if (hr !== undefined && activeSub === 0) {
			const v = hr(this as Computed<unknown>);
			if (v !== __HOST_MISS) {
				return v as T;
			}
		}
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

// batch()/startBatch()/endBatch() (synchronous effect coalescing over the
// kernel's batchDepth counter — unrelated to the concurrent engine's Batch
// records) and untracked() (clears the tracking frame) are kernel-state
// mechanisms and live in graph.ts with the counters they move; re-exported
// here — they are public surface.
export { batch, startBatch, endBatch, untracked } from './graph.js';

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
	 * dependency link each; the arena holds 3× this number — budgeted as one
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
		if (!Number.isFinite(n) || n < MIN_INITIAL_RECORDS) {
			throw new Error(`cosignal: configure({ initialRecords }) must be a number >= ${MIN_INITIAL_RECORDS}.`);
		}
		requestCapacity(Math.ceil(n)); // graph.ts: unit→record scaling + growth scheduling (D6)
	}
}

// ---- the concurrent-worlds engine (the host) --------------------------------------
// ONE public entry: the batch/world machinery lives in ./concurrent.ts and is
// re-exported here — `registerReactBridge()`, `CosignalBridge`, the bridge
// surface types (Seq, BatchSlotSet, WriteLogEntry, TraceEvent, …). Until
// registerReactBridge() runs, none of it executes: the host seams above stay
// undefined and every read/write short-circuits into the plain kernel path.
// CURATED (no `export *`): the engine's internals — the packed WriteLog class,
// node/watcher class VALUES, module seams — stay importable only from
// './concurrent.js' inside this package; consumers get the activation function,
// the bridge, its error classes, the two @internal test seams the sibling
// packages' suites drive, and the bridge-surface TYPES.
export {
	registerReactBridge,
	CosignalBridge,
	ScheduleError,
	InvariantViolation,
	// The reserved "no batch context" BatchId (0). The React bindings and the
	// patched React build name the same sentinel — protocol v2 shares ONE
	// batch-id space, so the sentinel is shared too.
	BATCH_NONE,
	// @internal test seams (cosignal-react's suite constructs per-test bridges
	// and one-core.spec proves the zero-cost promise through these):
	__newBridgeForTest,
	__coreProbes,
} from './concurrent.js';
export type {
	// entities (type-only: the classes construct nowhere outside the engine)
	AtomNode,
	Watcher,
	ComputedNode,
	AnyNode,
	Batch,
	RenderPass,
	RenderPassState,
	RootState,
	BatchSlotMeta,
	WatcherSnapshot,
	Subscription,
	// operations and worlds (the tracing hook types stay on the
	// `cosignal/trace` side of the seam; this entry never names them.
	// Write ops travel as (kind, payload) scalars — WriteKind above is the
	// kind's name; the object shape survives only inside WriteLogEntry, the
	// materialized test/trace surface)
	WriteLogEntry,
	World,
	TraceEvent,
	Reader,
	ComputedFn,
	Equals,
	// scalar brands
	Value,
	NodeId,
	BatchId,
	BatchSlot,
	RootId,
	RenderPassId,
	WatcherId,
	EffectId,
	Seq,
	Epoch,
	CommitGen,
	BatchSlotSet,
} from './concurrent.js';
