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
 * There is exactly ONE build of this library, and ONE ENGINE — the
 * concurrent-worlds machinery (`./concurrent.ts`, re-exported at the bottom
 * of this file: `attachDriver`, the `engine` surface, the engine types)
 * composes at module initialization (always-concurrent: no installation
 * step exists). The public read/write methods dispatch into its paths
 * DIRECTLY: writes test ONE module boolean (`standaloneQuiet` — quiet and
 * driver-less) and take the plain kernel path on the fast arm; reads test
 * ONE module boolean (`routingActive`) beside `activeSub` and take the
 * plain kernel read unless a routing context could answer. Sync-only apps
 * that never attach a driver and never open a batch keep both fast arms
 * forever: zero log entries, batches, or worlds are ever created
 * (tests/one-core.spec.ts asserts this behaviorally with engine probes).
 * The only other swapped table is POISON (fold purity — graph.ts, swapped
 * through runFold below) — reachable exclusively by erroring code.
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
 * effect/scope records, plus FinalizationRegistry-driven recovery of
 * atom/computed records whose handles were garbage-collected — the guard
 * table, retry triggers, and two-phase free path live in graph.ts's
 * reclamation section per plans/2026-07-07-signal-reclamation.md) — is
 * kernel-wide behavior, bridge registered or not, documented at its
 * implementation sites in graph.ts.
 */

import { E, MIN_INITIAL_RECORDS, NodeField, NodeFlag, RecordGeom, activeSub, batchDepth, flush, fns, foldGuardRestore, foldGuardSwap, maybeBoundary, requestCapacity, routingActive, untracked, values, writeAtom } from './graph.js';
import { __resetLifecycleForTest } from './lifecycle.js';
import { NOT_ROUTED } from './World.js';
import { engineWrite, __engineAtomNodeById, __engineWriteNode, __routedAtomRead, __routedComputedRead } from './concurrent.js';
import type { AtomNode, ComputedNode } from './concurrent.js';
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







// ---- the engine dispatch ----------------------------------------------------------
// ONE ENGINE, ALWAYS-CONCURRENT: the concurrent-worlds machinery
// (`./concurrent.ts`, re-exported at the bottom of this file) composes at
// module initialization, and the public methods below call its paths
// DIRECTLY — no nullable hooks, no arming, no registration step. The costs
// on the plain paths are exactly two module-boolean checks: writes test
// `standaloneQuiet` (quiet AND no driver — the fast arm), reads test
// `routingActive` (a routing context could answer) beside `activeSub`.
// A process that never attaches a driver and never opens a batch keeps both
// flags in their fast states forever, and zero log-entry/world work ever
// runs (asserted behaviorally by tests/one-core.spec.ts).

/** Whole-op codes for the engine write dispatch (0 = set, 1 = update).
 * Shares the 0/1 encoding with engine.ts's `const enum WriteKind` by
 * construction (the two collapse conceptually; this alias is the public
 * type name). @internal */
export type WriteKind = 0 | 1;

/** @internal Test seam (leak audit): a record's side-column slots. freeNode
 * must clear all three, or freed records pin dead values/closures for the
 * arena's life; tests/leak-audit.spec.ts probes exactly that. Read-only. */
export function __kernelSideColumnsForTest(id: NodeId): { value: unknown; aux: unknown; fn: Function | undefined } {
	const v: ValueIndex = id >> RecordGeom.ID_TO_VALUE_SHIFT;
	return { value: values[v], aux: values[v + RecordGeom.AUX_VALUE_OFFSET], fn: fns[id >> RecordGeom.ID_TO_FN_SHIFT] };
}

/**
 * The plain-path write tail shared by the standalone fast arm and the
 * engine's node-less arm: fold the op (updaters under the fold-purity
 * guard), then `writeAtom` — which applies the R-2 policy equality ONCE
 * (kernel order: `isEqual(current, incoming)`) at the acceptance decision
 * and takes the kernel write + flush. @internal
 */
export function __plainAtomWrite(atom: Atom<unknown>, kind: WriteKind, payload: unknown): void {
	const id = atom._id;
	const next = kind === 0
		? payload
		: runFold(() => (payload as (p: unknown) => unknown)(values[(id >> RecordGeom.ID_TO_VALUE_SHIFT) + RecordGeom.AUX_VALUE_OFFSET]));
	writeAtom(id, atom._isEqual, next);
}

/**
 * Handle-free write path for lifecycle contexts (id-keyed — the lifecycle
 * record deliberately holds no handle reference; see lifecycle.ts). Runs
 * the same policy assert as the public methods, then the engine dispatch
 * over the id-resolved node; an atom with no engine content takes the
 * plain kernel path (its comparator lives on the unreachable handle, so
 * the kernel's identity compare is the only equality — the engine node,
 * once content exists, carries the comparator). @internal
 */
export function __lifecycleWrite(id: NodeId, kind: WriteKind, payload: unknown): void {
	if (forbidWritesInComputeds === true && E.activeIsComputed()) {
		throw new Error('cosignal: writes inside computeds are forbidden (configure({ forbidWritesInComputeds: true })).');
	}
	const node = __engineAtomNodeById(id);
	if (node !== undefined) {
		__engineWriteNode(node, kind, payload);
		return;
	}
	const next = kind === 0
		? payload
		: runFold(() => (payload as (p: unknown) => unknown)(values[(id >> RecordGeom.ID_TO_VALUE_SHIFT) + RecordGeom.AUX_VALUE_OFFSET]));
	writeAtom(id, undefined, next);
}

/** Test-only policy scrub (`__resetEngineForTest`'s index.ts half):
 * configure() state returns to defaults; the lifecycle map, queue, and its
 * scheduled flush drop (the flush microtask is engine-epoch guarded).
 * @internal */
export function __resetPolicyForTest(): void {
	forbidWritesInComputeds = false;
	__resetLifecycleForTest();
}

// (maybeBoundary / boundaryWork / flush — the operation-boundary machinery
// and the effect flush loop — live in graph.ts with the queue and growth
// state they drain; the policy layer imports maybeBoundary/flush directly.)

// ═══════════════════════════════════════════════════════════════════════════════
// Policy layer
// ═══════════════════════════════════════════════════════════════════════════════

// ---- policy state -------------------------------------------------------------

// Hot-guard shape, both policy flags: `var` (a `let` module slot keeps a
// per-access initialization hole-check in optimized code; var never does),
// and guards compare `=== true` (a boolean-singleton pointer compare; a
// truthiness test on module state compiles to the generic ToBoolean ladder
// — smi test, four oddball compares, two map checks — per access).
// eslint-disable-next-line no-var
var forbidWritesInComputeds = false;

/**
 * quiet AND no driver attached — the public write path's ONE fast-arm check
 * (Atom.set/update): with a driver attached every write must make the one
 * foreign call (the driver's batch context can create batch identity on the
 * write itself), so the fast arm requires both. The flag LIVES HERE, in the
 * module that reads it on every write: index and concurrent import each
 * other circularly, and a read through the imported binding of a cyclic
 * module keeps a per-access initialization check that a same-module read
 * doesn't pay. The engine flips it through the setter below on the cold
 * quiet-derivation path (driver attach, batch open/close, log drain).
 *
 * `var`, deliberately: the engine composes during concurrent.ts's MODULE
 * BODY, and when a consumer enters the cycle through this module that body
 * runs before ours — the initial derivation arrives via the setter while a
 * `let` here would still be uninitialized. var's hoisted slot accepts the
 * early write, both evaluation orders converge on `true` (no driver can
 * attach before module evaluation completes), and the per-write read never
 * carries an initialization check.
 */
// eslint-disable-next-line no-var
var standaloneQuiet = true;

/** @internal Engine seam: the quiet derivation (concurrent.ts) lands its
 * `quiet && no driver` result here. Cold — never on a per-write path.
 * Store ONLY on change: a slot that is never re-stored stays constant-
 * trackable, so a process that never attaches a driver keeps a foldable
 * fast-arm guard (the store would de-constify it even with the same
 * value); the first real transition is the usual one-shot respecialization. */
export function __setStandaloneQuiet(v: boolean): void {
	if (v !== standaloneQuiet) {
		standaloneQuiet = v;
	}
}

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
// (writeAtom lives in graph.ts: every binding it touches per call — values,
// maybeBoundary, E, batchDepth, flush — is graph state, and a hot read of a
// CYCLIC module's imported binding pays a per-access cell + initialization
// check that a same-module read doesn't. Imported above with the rest.)

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
	/** The engine node, once this handle has ENGINE CONTENT (a log entry, a
	 * watcher, arena presence, a routed read) — undefined until then. The
	 * handle-node link is 1:1 for the handle's life; the record-free scrub
	 * clears it. Creation is ONE STEP: the constructor makes the kernel
	 * record, and the engine resolves the handle by its id — content
	 * allocates lazily, never through a user-facing adoption step. @internal */
	_node: AtomNode | undefined = undefined;
	readonly label: string | undefined;

	constructor(initialState: T, options?: AtomOptions<T>) {
		maybeBoundary();
		// RECLAMATION (plans/2026-07-07-signal-reclamation.md): a dropped
		// handle's record recovers via the finalizer; registration rides the
		// allocation op. Direct lean-instance registration — Atom (and
		// ReducerAtom, which registers here through super() and completes
		// its shape with one post-constructor field — flagged for the
		// per-class creation profile) is a flat field record, the
		// donor-measured cheap GC-death shape. Constructor-only cost.
		const id = E.newSignal(initialState, this);
		this._id = id;
		this._isEqual = options?.isEqual as ((a: unknown, b: unknown) => boolean) | undefined;
		this.label = options?.label;
		const effect = options?.effect;
		if (effect !== undefined) {
			E.markLifecycle(id);
			// THE DORMANT OWNER (reclamation plan §2): the user's callback
			// lives in the atom's own record `fns` slot — atoms never use
			// that column, it is engine memory addressed by id, and the
			// record-free path clears it like every column. The ACTIVE
			// lifecycle record (ctx, cleanup, refcount) is created id-keyed
			// at the first watched transition (lifecycle.ts REHYDRATION) and
			// deleted at dormancy — the engine never stores a handle
			// reference of its own (the ctx routes set/update BY ID through
			// the engine write path).
			fns[id >> RecordGeom.ID_TO_FN_SHIFT] = effect as (ctx: AtomCtx<unknown>) => void | (() => void);
		}
	}

	/**
	 * The atom's current value (registers a dependency inside evaluations).
	 * With a routing context live (world evaluation / ambient world), the
	 * engine serves the value of the world doing the asking. Inside a fold
	 * frame the dispatch itself throws (POISON table).
	 *
	 * KERNEL-FRAME READS ARE NEVER WORLD-ROUTED (`activeSub === 0` guards the
	 * routed arm): a read inside an open kernel evaluation (a `Computed`
	 * getter, an `effect()` body) creates a K0 dependency link and its
	 * result lands in a K0 cache slot, and K0 state is newest-world state by
	 * the eager-apply invariant — serving a world-folded value there would
	 * poison the kernel cache (a later newest read of the computed would
	 * serve another world's value with no invalidation: tearing). World
	 * routing belongs to overlay evaluations and render/effect call
	 * contexts, all of which run with no kernel frame open. (Known pinhole,
	 * same shape as the documented forbidWritesInComputeds one:
	 * `untracked()` inside a kernel getter clears activeSub, so a routed
	 * read there can still reach the getter's return value; untracked reads
	 * leave no K0 link, but the cache slot still absorbs the result.)
	 * Pinned by tests/graph-consumers.spec.ts.
	 */
	get state(): T {
		if (routingActive && activeSub === 0) {
			const v = __routedAtomRead(this as Atom<unknown>);
			if (v !== NOT_ROUTED) {
				return v as T;
			}
		}
		return E.read(this._id) as T;
	}

	/** Replaces the atom's value. Policy asserts first; then the standalone
	 * fast arm (no engine content, quiet, no driver — the plain kernel
	 * write, R-2 equality once) or the engine dispatch (driver batch
	 * context / quiet fold / ambient batch). */
	set(value: T): void {
		if (forbidWritesInComputeds === true && E.activeIsComputed()) {
			throw new Error('cosignal: writes inside computeds are forbidden (configure({ forbidWritesInComputeds: true })).');
		}
		if (this._node === undefined && standaloneQuiet === true) {
			writeAtom(this._id, this._isEqual, value);
			return;
		}
		engineWrite(this as Atom<unknown>, 0, value);
	}

	/**
	 * Functional update. `fn` must be pure: it runs under the fold-purity
	 * guard, so signal reads and writes inside it throw — read what you need
	 * first, then update. An engine-dispatched update records the WHOLE op
	 * (the updater itself, replayed per world); the standalone fast arm
	 * folds and applies immediately.
	 */
	update(fn: (current: T) => T): void {
		if (forbidWritesInComputeds === true && E.activeIsComputed()) {
			throw new Error('cosignal: writes inside computeds are forbidden (configure({ forbidWritesInComputeds: true })).');
		}
		if (this._node === undefined && standaloneQuiet === true) {
			const id = this._id;
			const next = runFold(() => fn(values[(id >> RecordGeom.ID_TO_VALUE_SHIFT) + RecordGeom.AUX_VALUE_OFFSET] as T));
			writeAtom(id, this._isEqual, next);
			return;
		}
		engineWrite(this as Atom<unknown>, 1, fn);
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
	/** The engine node, once this handle has ENGINE CONTENT (see Atom._node —
	 * same one-step-creation, content-lazy rule). @internal */
	_node: ComputedNode | undefined = undefined;
	/** Retention columns (S-C): the RAW authored fn and the policy
	 * comparator, kept on the owning instance (GC-owned, so a reused kernel
	 * id can never serve another tenant's fn/comparator) — the engine's
	 * world evaluations run the raw fn against WORLD-local previous values;
	 * the kernel's own equality wrapper stays kernel-slot-scoped. @internal */
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
		// RECLAMATION: direct lean-instance registration, riding the
		// allocation op (see Atom's note). The instance's fields REFER to
		// user closures (_fn) but the dying target's own shape stays flat —
		// the cheap GC-death shape.
		const id = E.newComputed(fn as (ctx: unknown) => unknown, this);
		this._id = id;
		// (The old D4 aux-slot instance backref died at the merge: ctx.use
		// owner resolution is ID-KEYED now — suspense.ts resolves the
		// evaluating record straight from `activeSub`, and the per-key
		// request cache is a nodeIndex-keyed engine column scrubbed at
		// record free. The aux slot stays empty for computeds; nothing pins
		// the handle — the reclamation plan's L3 prerequisite.)
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
		if (routingActive && activeSub === 0) {
			const v = __routedComputedRead(this as Computed<unknown>);
			if (v !== NOT_ROUTED) {
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

// ---- the concurrent-worlds engine ---------------------------------------------------
// ONE public entry: the batch/world machinery lives in ./concurrent.ts and is
// re-exported here — `attachDriver()`, the `engine` surface, the engine
// surface types (Seq, BatchSlotSet, WriteLogEntry, TraceEvent, …). The engine
// composes at module initialization (always-concurrent); a process that never
// attaches a driver and never opens a batch keeps the plain read/write fast
// paths forever. CURATED (no `export *`): the engine's internals — the packed
// WriteLog class, node/watcher class VALUES, module seams — stay importable
// only from './concurrent.js' inside this package; consumers get the driver
// seam, the engine surface, its error classes, the test seams the sibling
// packages' suites drive, and the engine-surface TYPES.
export {
	attachDriver,
	engine,
	ScheduleError,
	InvariantViolation,
	// The reserved "no batch context" BatchId (0). The React bindings and the
	// patched React build name the same sentinel — protocol v2 shares ONE
	// batch-id space, so the sentinel is shared too.
	BATCH_NONE,
	// @internal test seams (the suites reset the one engine per test and
	// one-core.spec proves the zero-cost promise through the probes):
	__resetEngineForTest,
	__coreProbes,
} from './concurrent.js';
export type {
	// the driver seam + the engine surface's type + reset options
	EngineDriver,
	CosignalEngine,
	EngineResetOptions,
	// entities (type-only: the classes construct nowhere outside the engine)
	AtomNode,
	Watcher,
	WorldArena,
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
