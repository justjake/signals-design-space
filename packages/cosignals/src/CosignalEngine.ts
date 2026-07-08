/**
 * cosignals — the engine (CosignalEngine.ts): one module holding the whole
 * reactive machine, from storage layout to reclamation. It stores every
 * signal, computed, effect, and dependency edge as a fixed-size integer
 * record in shared arrays, and runs the reactive algorithm — writes push
 * staleness marks down the graph, reads lazily pull recomputation — as index
 * arithmetic over those records.
 *
 * The module reads top to bottom with progressive disclosure; its sections,
 * in order:
 *
 *   1. Storage layout — the arena, the generated record layout (from
 *      tools/schema.ts), the side columns, and the shared mutable state that
 *      survives closure rebuilds.
 *   2. The kernel algorithm — allocation, the link/propagate/checkDirty walk
 *      families, update/notify/run/dispose. This layer knows nothing about
 *      user options: it compares values by reference identity only, has no
 *      error handling of its own, and no async story.
 *   3. UpdatedAt clocks — the per-record clock column and its bump rules.
 *   4. The live op table, growth by closure rebuild, the operation-boundary
 *      machinery, the flush queue, and the public write tails.
 *   5. The computed evaluation policy (exceptions and suspense) — the boxed
 *      outcome story, the thenable protocol, and the ctx.use request cache.
 *   6. The observed lifecycle (AtomOptions.effect) — the union refcount and
 *      its flap-damped delivery.
 *   7. Reclamation — FinalizationRegistry-driven recovery of records whose
 *      public handles were garbage-collected, and the test-reset seams.
 *
 * The policy layer around this module — the Atom/ReducerAtom/Computed
 * classes, effect(), configure(), custom equality — lives in index.ts (the
 * package entry, whose header carries the whole-package vocabulary and
 * reading order).
 *
 * ## Storage
 *
 * The arena is the one shared Int32Array (`memory` in {@link createKernel})
 * holding every record: {@link ArenaShape.STRIDE} consecutive Int32 slots
 * each; node and link records share the arena, the stride, and one
 * allocator. Record ids are premultiplied (id = record ordinal × stride) so
 * every field access is plain addition. JavaScript values live in the side
 * columns {@link values}/{@link fns}, and clock stamps in the {@link Clock}
 * buffer, indexed by shifting the same premultiplied id. The layout — field
 * slots, flag bits, shape constants, and the per-column scrub/reset
 * functions — is generated from tools/schema.ts into the marked region
 * below, so free/reset correctness is generated, not hand-maintained.
 *
 * ## Mechanics this module owns
 *
 * - Operation boundary: a moment when no evaluation, effect run, or graph
 *   walk is anywhere on the call stack (`enterDepth === 0`). Deferred work —
 *   growing the arena, freeing disposed records — runs only at boundaries,
 *   because in-flight work holds direct references to the buffers.
 * - Closure rebuild: the kernel's functions are created by one factory
 *   ({@link createKernel}) and capture the arena as a closure constant —
 *   which is what lets V8 fold the buffer reference into compiled code. To
 *   grow, the module allocates doubled buffers, copies the records over, and
 *   calls the factory again; the module-level binding {@link E} (the one
 *   mutable table slot) is re-linked at an operation boundary, and every
 *   consumer reads the current slot per call, never a captured stale table.
 *   Growth re-runs this factory and nothing else: scalar counters live at
 *   module level (not in the closure) precisely so a rebuilt kernel resumes
 *   where the old one stopped.
 * - The fold-purity table ({@link POISON}): index.ts's runFold swaps `E` to
 *   it for the duration of an updater/reducer callback (through the
 *   fold-guard swap pair exported below), so every read/write the fold
 *   attempts throws at the dispatch site — and the hot read/write paths
 *   carry zero fold instructions.
 *
 * ## Lineage
 *
 * The kernel algorithm is alien-signals v3.2.1's push-pull algorithm,
 * re-expressed over arena records instead of linked JavaScript objects.
 * Upstream's walk structure and flag transitions are preserved (plus the
 * hot/slow splits documented at each site); walks use persistent scratch
 * stacks; capacity grows by closure rebuild over doubled buffers at
 * operation boundaries. Semantics are pinned by a 179-case conformance
 * suite. Deviations from a plain transliteration of upstream are enumerated
 * in index.ts's header; each deviation site here explains itself in place.
 *
 * ## Speed identity (do not casually restructure)
 *
 * Closure-captured `memory` inside a rebuilt op table whose unique hidden
 * class V8 constant-folds; same-file const enums on every hot path; the V8
 * hot/slow split families ({@link link}/{@link linkInsert},
 * {@link checkDirty}/{@link chainCheck}/{@link checkDirtyLoop},
 * {@link computedRead}/{@link computedReadSlow}) pinned by the bytecode
 * budget suite.
 */

import { CycleError } from './errors.js';
import type { AtomCtx, ComputedCtx, UseKey } from './index.js';

/**
 * The one evaluation context, passed by the kernel to every computed getter
 * as its argument (upstream passes `previousValue` instead; the ctx form is
 * what carries `ctx.previous` and `ctx.use`). Its members delegate to
 * hoisted policy functions ({@link ctxPrevious}/{@link ctxUse}, in the
 * evaluation-policy section below) that resolve the evaluating node from the
 * kernel's `activeSub`, so no per-recompute state setup exists at all.
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
// Leniently branded id types (zero runtime cost — the brand is an optional
// unique-symbol property, erased at emit): any plain `number` assigns freely
// into a brand, so arena reads and index arithmetic need no casts anywhere
// (`const dep: NodeId = memory[l + LinkField.DEP]` just works) — but the
// brands are mutually exclusive by payload, so a NodeId handed where a
// LinkId belongs is a compile error. One symbol carries every brand in the
// package (`IdBrand` below — the other layout-owning modules build their
// brands from it): brands under one key are exclusive by payload conflict,
// whereas brands under per-module symbols are silently mutually assignable
// (two different optional keys never conflict), which would void exactly the
// cross-layer protection this exists for. The plain aliases below the
// branded group are arithmetic-dominated values (flags, counters) whose
// every use is a mask/compare where a brand adds nothing.

declare const IdOf: unique symbol;

/** The lenient brand carrier: intersect with `number` and a payload naming
 * the id space. Optional key ⇒ plain numbers assign in (no casts anywhere);
 * one shared key ⇒ distinct payloads are mutually exclusive. */
export type IdBrand<P extends string> = { [IdOf]?: P };

/** Premultiplied node record id: the Int32 arena index of the record's field 0
 * (id = record ordinal × ArenaShape.STRIDE). 0 = "none" (record 0 is burned). */
export type NodeId = number & IdBrand<'node'>;
/** Premultiplied link record id (links share the arena and stride with nodes). 0 = "none". */
export type LinkId = number & IdBrand<'link'>;
/** A premultiplied record id of either kind — the shared allocator's
 * currency: both id kinds draw from one bump pointer (`recNext`), so a value
 * that is legitimately "either kind" needs a home. A RecordId only becomes a
 * NodeId or LinkId at the allocator's decision point ({@link allocNode} /
 * allocLink), which cast it into the chosen id space. */
export type RecordId = NodeId | LinkId;
/** The record's dense per-node ordinal (NodeField.NODE_INDEX): assigned once
 * when a slot first hosts a node, inherited by every later tenant of the
 * slot, and never an identity. Dense per-node side tables key by it (node
 * and link records share one allocator, so record-id-keyed tables would go
 * holey where index-keyed ones stay packed). Branded: a NodeIndex is not a
 * NodeId, and mixing them is the package's most plausible silent-corruption
 * class. */
export type NodeIndex = number & IdBrand<'nodeIndex'>;
/** An updated-at clock stamp: a process-monotone float64 drawn from
 * {@link clockSource} (see the UpdatedAt clocks section). 0 = "never". */
export type Clock = number & IdBrand<'clock'>;
/** A node's FLAGS field value: a bitwise OR of NodeFlag members. */
export type NodeFlags = number;
/** The global evaluation cycle counter, stamped into link VERSION fields on re-track. */
export type Version = number;
/** A node's GEN field value: bumped on free so disposers can defuse stale ids. */
export type Generation = number;
/** A count of fixed-stride records (nodes and links draw from one shared pool). */
export type RecordCount = number;
/** Index into the `values` side column (two slots per record; see ArenaShape). */
export type ValueIndex = number & IdBrand<'valueIndex'>;

// #region GENERATED — layout v1 (from tools/schema.ts; run `pnpm gen`) — DO NOT EDIT
/**
 * Field offsets within a node arena record.
 * NodeId is an offset pointer to the first field of the record;
 * to access a field, add its offset to the NodeId:
 *
 *     const depId = memory[nodeId + NodeField.DEPS]
 *
 * ## Why const enum?
 *
 * TypeScript and compliant bundlers inline `const enum` member expressions
 * as number literals. This gives us the best chance the JavaScript JIT
 * will specialize expressions using `const enum`.
 *
 * `export const Foo = { A: 1, ... }` style "enum objects" or even
 * `export const FOO_A = 1` module constant exports can be rewritten by
 * bundlers to less efficient forms the JIT cannot understand. For example,
 * some versions of esbuild demote module-scope `const` to `var`, preventing
 * TurboFan's constant-folding optimizations; this was measured to cost
 * 15-21% on benchmark workloads.
 *
 * ## Why exported?
 *
 * The layout is generated into this file — the engine owns its record
 * layout — and the enums other modules walk engine records with are
 * exported so those consumers import the one definition instead of
 * hand-copying numbers a field reorder would silently orphan. A cross-file
 * member access still inlines under whole-program tsc emit and esbuild
 * bundling; per-file transforms (tsx, vitest) fall back to a property read
 * of the emitted enum object — acceptable at the consumers' cold-to-warm
 * sites, never in the engine's own hot paths (which are all same-file by
 * construction).
 */
export const enum NodeField {
	/** State machine + kind bits (see NodeFlag). */
	FLAGS = 0,
	/** First dependency link; doubles as the free-list next pointer for freed records. */
	DEPS = 1,
	/** Last confirmed dependency link (the re-track cursor during evaluation). */
	DEPS_TAIL = 2,
	/** First subscriber link. */
	SUBS = 3,
	/** Last subscriber link. */
	SUBS_TAIL = 4,
	/** Tenancy generation: bumped on free; disposers and finalizers capture it to defuse stale ids. */
	GEN = 5,
	/**
	 * 1 iff the node is an atom carrying an observed-lifecycle effect
	 * (AtomOptions.effect). Set once at construction by the markLifecycle op;
	 * cleared when the record frees. Gates the per-link lifecycle
	 * retain/release in linkInsert/unlink and the lifecycle rehydration probe —
	 * atoms without the option never pay a lifecycle instruction.
	 *
	 * ## Why a whole field for one bit?
	 *
	 * We tried folding it into FLAGS as a bit. That forces write() and
	 * updateSignal() to preserve the bit, turning their constant flag
	 * stores into read-modify-writes on the hottest write path — measured
	 * +0.2 ns per bare write and +3-4% on write-storm composites. A dedicated
	 * field keeps flag stores constant, and the record is stride-8 either
	 * way, so the field is free.
	 */
	LIFECYCLE = 6,
	/**
	 * The record's node index: a dense per-node ordinal (never an identity)
	 * assigned once when a slot first hosts a node and inherited by every
	 * later tenant of the slot (the node free list threads through DEPS, so
	 * freeNode leaves this field untouched). Consumers key dense per-node
	 * side tables by it: node and link records share one allocator, so
	 * record-id-keyed tables would go holey where index-keyed ones stay
	 * packed. Node records only — link records use slot 7 as FREE_NEXT
	 * (the two record kinds already interpret fields differently).
	 */
	NODE_INDEX = 7,
}

/**
 * Field offsets within a link arena record (link records share the arena,
 * stride, and premultiplied ids with node records; see NodeField for the
 * offset-pointer access pattern and the const-enum rationale).
 */
export const enum LinkField {
	/** Evaluation-cycle stamp: intra-run duplicate-read dedup. */
	VERSION = 0,
	/** Producer node id. */
	DEP = 1,
	/** Consumer node id. */
	SUB = 2,
	/** Previous link in the producer's subscriber list. */
	PREV_SUB = 3,
	/** Next link in the producer's subscriber list. */
	NEXT_SUB = 4,
	/** Previous link in the consumer's dependency list. */
	PREV_DEP = 5,
	/** Next link in the consumer's dependency list. */
	NEXT_DEP = 6,
	/**
	 * The free list threads through the spare field so a freed link keeps
	 * every real field intact: the walks deliberately read stale
	 * nextDep/nextSub off links unlinked earlier in the same walk
	 * (conformance case 203 exercises this; tests/freelist.spec.ts pins it
	 * with a primed free list), and those stale pointers must name former
	 * neighbors — never the free list.
	 */
	FREE_NEXT = 7,
}

/**
 * Bit values of a node's FLAGS field (upstream ReactiveFlags + HasChildEffect
 * + kind bits). A flags word is an OR of these (see `type NodeFlags`).
 */
export const enum NodeFlag {
	/** Can produce new values (signals, computeds). */
	MUTABLE = 0b00000000000001,
	/** Wants notification when possibly stale (effects, scopes). */
	WATCHING = 0b00000000000010,
	/** Currently evaluating (re-entrancy guard). */
	RECURSED_CHECK = 0b00000000000100,
	/** A re-entrant write reached this node during its own run. */
	RECURSED = 0b00000000001000,
	/** Definitely stale. */
	DIRTY = 0b00000000010000,
	/** Possibly stale — verify by pulling before recomputing. */
	PENDING = 0b00000000100000,
	/** Dep list contains child effects/scopes (slow-path cleanup). */
	HAS_CHILD_EFFECT = 0b00000001000000,
	/** Kind: writable signal record (an Atom or ReducerAtom handle). */
	K_SIGNAL = 0b00000010000000,
	/** Kind: computed. */
	K_COMPUTED = 0b00000100000000,
	/** Kind: effect. */
	K_EFFECT = 0b00001000000000,
	/** Kind: effect scope. */
	K_SCOPE = 0b00010000000000,
	/**
	 * The computed's cached value is an exceptional outcome — the value slot
	 * holds the raw thrown value (HAS_BOX alone) or the pending thenable
	 * (HAS_BOX | BOX_SUSPENDED). Set exactly at the two kernel catch sites
	 * (with storeThrown); the eval-start flag rewrite in updateComputed
	 * preserves the bits while the getter runs (ctx.previous and the isEqual
	 * wrapper filter the residual slot payload by them) and a successful
	 * evaluation clears them in the finally's flag write — every other flag
	 * site either ORs bits or is followed by a forced recompute (unwatched
	 * sets DIRTY), so a stale clear can never serve a payload unwrapped.
	 */
	HAS_BOX = 0b00100000000000,
	/**
	 * Refines HAS_BOX (never set without it): the payload is a pending
	 * thenable, not a thrown error.
	 */
	BOX_SUSPENDED = 0b01000000000000,
	/**
	 * Marks kernel records created by the engine's own machinery (world
	 * folds, subscription captures) rather than by a user's handle. Its one
	 * hot job: keep machinery reads from counting toward a user atom's
	 * observed-lifecycle union — the "first subscriber attached / last one
	 * detached" callback (linkInsert/unlink skip the retain/release when the
	 * subscriber carries this bit; the machinery's observation index
	 * contributes to the union on its own terms instead, so a machinery
	 * computed's dep structure never pins an atom's remote subscription past
	 * its last real consumer). Set via the markMachineryOwned op when a
	 * computed gains concurrent-machinery content.
	 */
	MACHINERY_OWNED = 0b10000000000000,
	/** The kind bits together (exactly one is set on a live record). */
	KIND_MASK = K_SIGNAL | K_COMPUTED | K_EFFECT | K_SCOPE, // 0b00011110000000
}

/**
 * Arena shape: the strides, shifts, and offsets that address a record's
 * fields and its side-column slots from its premultiplied id (see
 * NodeField for the const-enum rationale).
 */
export const enum ArenaShape {
	/** Int32 fields per record; ids are premultiplied by this (id = record ordinal × STRIDE). */
	STRIDE = 8,
	/** id >> ID_TO_VALUE_SHIFT: premultiplied id → the record's base slot in the `values` column (2 slots per record). */
	ID_TO_VALUE_SHIFT = 2,
	/** id >> ID_TO_FN_SHIFT: premultiplied id → the record's base slot in the `fns` column (1 slot per record). */
	ID_TO_FN_SHIFT = 3,
	/** id >> ID_TO_CLOCK_SHIFT: premultiplied id → the record's base slot in the `clocks` column (1 slot per record). */
	ID_TO_CLOCK_SHIFT = 3,
	/**
	 * valueIndex + AUX_VALUE_OFFSET: the record's second value slot — a
	 * signal's pending value or an effect's cleanup fn. Computeds leave it
	 * empty on purpose: nothing kernel-side may pin the public handle, or a
	 * dropped handle's record could never be reclaimed.
	 */
	AUX_VALUE_OFFSET = 1,
	/**
	 * length >> HALF_ARENA_SHIFT: half the arena — the "keep at least half
	 * the arena free" watermark term.
	 */
	HALF_ARENA_SHIFT = 1,
	/** Records budgeted per configured capacity unit: one node + two links. */
	RECORDS_PER_UNIT = 3,
	/**
	 * Min free records guaranteed at each op boundary. Nodes and links draw
	 * from one shared pool; the slack is the sum of per-kind floors (256 node
	 * + 1024 link records), so any allocation pattern that fit those floors
	 * separately still fits the merged slack.
	 */
	REC_SLACK = 1280,
}

/**
 * Scrub a freed node record's side-column slots (generated from the
 * column roster): the slot's next tenant must never observe the old
 * tenant's values, closures, or clock stamps. recordBuffer columns are
 * closure-owned, so the caller passes its buffer.
 */
function scrubNodeColumnsOnFree(id: NodeId, clocks: Float64Array): void {
	const base: ValueIndex = id >> ArenaShape.ID_TO_VALUE_SHIFT;
	values[base] = undefined; // current/computed value
	values[base + ArenaShape.AUX_VALUE_OFFSET] = undefined; // signal pending value or effect cleanup fn (computeds: empty on purpose)
	fns[id >> ArenaShape.ID_TO_FN_SHIFT] = undefined; // computed getter / effect fn / an atom's dormant lifecycle callback
	clocks[id >> ArenaShape.ID_TO_CLOCK_SHIFT] = 0; // node: updatedAt (tagged-outcome clock) / link: the observer's lastValidatedAt
}

/**
 * Scrub a freed link record's side-column slots (generated from the
 * column roster): the slot's next tenant must never observe the old
 * tenant's values, closures, or clock stamps. recordBuffer columns are
 * closure-owned, so the caller passes its buffer.
 */
function scrubLinkColumnsOnFree(id: LinkId, clocks: Float64Array): void {
	clocks[id >> ArenaShape.ID_TO_CLOCK_SHIFT] = 0; // node: updatedAt (tagged-outcome clock) / link: the observer's lastValidatedAt
}

/**
 * Reset every side column to its record-zero seed (generated from the
 * column roster; the test reset's column half). Grow-arrays truncate;
 * record buffers zero-fill in place (the arena keeps its capacity).
 */
function resetSideColumnsForTest(clocks: Float64Array): void {
	values.length = 2;
	values[0] = undefined;
	values[1] = undefined;
	fns.length = 1;
	fns[0] = undefined;
	clocks.fill(0);
}
// #endregion GENERATED layout

/**
 * Mass-teardown bounds for the boundary sweep (ported from dalien-signals
 * src/system.ts). Free lists are LIFO, so a huge teardown would otherwise
 * hand ids back highest-first and the next build would scatter across the
 * arena — sparse side columns, no cache adjacency between neighbors. A sweep
 * whose batch crosses both bounds pays a sort to restore ascending reuse;
 * steady churn of small graphs never qualifies and never pays.
 */
const enum MassTeardown {
	/** Pending node frees must exceed this count (absolute floor). */
	MIN_BATCH = 4096,
	/** …and batch × this must reach `recNext`: the batch is at least 1/64 of
	 * the arena's used extent, so only tearing down a sizable fraction of
	 * everything allocated qualifies. */
	MIN_ARENA_FRACTION = 64,
}

// ---- shared mutable state (survives closure rebuilds) ------------------------
// Scalar heads/counters live at module level so a rebuilt kernel resumes
// exactly where the old one stopped; only the buffer bindings live in the
// factory closure.
let recNext: RecordId = ArenaShape.STRIDE; // bump pointer, shared by nodes and links (record 0 burned)
let nextNodeIndex = 1; // next NodeField.NODE_INDEX for a never-yet-node slot (0 burned: consumers use it as "none")
let nodeFreeHead: NodeId = 0; // free list threaded through memory[id + NodeField.DEPS]
let linkFreeHead: LinkId = 0; // free list threaded through memory[id + LinkField.FREE_NEXT] (spare field 7: freed links keep NEXT_DEP/NEXT_SUB intact for mid-walk stale reads)
let growPending = false;

let cycle: Version = 0;
let runDepth = 0;
export let batchDepth = 0; // (read cross-module by the policy write path; assigned only here)
let notifyIndex = 0;
let queuedLength = 0;
export let activeSub: NodeId = 0; // (readers outside this module never assign — ESM enforces it)
export let enterDepth = 0; // live kernel frames that captured memory; 0 = op boundary (exported read-only: the test reset's idle precondition)

/**
 * Read routing, armed: true while the concurrent machinery has a routing
 * context that could answer a public read — an evaluation world on stack, an
 * open capture frame, or an attached driver's ambient-world provider. The
 * public `.state` getters (index.ts) test this one module boolean (beside
 * `activeSub`, their other guard) and take the routed read path only when it
 * is set; everything else is the plain kernel read. World.ts's routing layer
 * is the only writer (through the setter — ESM import bindings are read-only).
 */
export let routingActive = false;

/** World.ts's arming edge (setWorld / capture-frame / driver transitions). @internal */
export function __setRoutingActive(v: boolean): void {
	routingActive = v;
}

/**
 * The reset epoch: bumped once per `__resetEngineForTest`, never in
 * production. Every cross-reset microtask (settle drain, lifecycle flush,
 * thenable settle-invalidate, unhandled rethrow) captures the epoch at
 * schedule time and no-ops if it moved — a microtask scheduled by a dead
 * test must never touch the next test's state. Reclamation consumes the same
 * counter for its per-epoch registry (see the reclamation section below).
 */
export let engineEpoch = 0;

const queued: NodeId[] = [];
const pendingFree: NodeId[] = []; // disposed effect/scope records awaiting the sweep (batch-freed at the next operation boundary)

// Side columns, indexed off the id: values[id >> 2] = current/computed value,
// values[(id >> 2) + 1] = signal pending value or effect cleanup fn (empty
// for computeds — nothing kernel-side may pin the public handle),
// fns[id >> 3] = computed getter / effect fn. Plain arrays grown by push
// (stays packed; plain-array growth has no binding problem). The policy
// layer reads these columns directly — they are shared state like the
// scalar heads, not operations.
export const values: unknown[] = [undefined, undefined];
export const fns: (Function | undefined)[] = [undefined];

/** Seed capacity (entries) of the walk scratch stacks below (they double on demand). */
const WALK_STACK_SEED = 4096;

// Persistent scratch stacks: module-level Int32Arrays reused by every graph
// walk, replacing the linked-list stack upstream allocates per walk.
// Re-entrant walks push above the caller's base and restore it on exit.
let propStack = new Int32Array(WALK_STACK_SEED);
let propSp = 0;
let checkStack = new Int32Array(WALK_STACK_SEED);
let checkSp = 0;

// ---- UpdatedAt clocks ----------------------------------------------------------
// A fast negative guard for observers, never a replacement for dirty-state,
// value baselines, or delivery metadata. Every record owns one float64 clock
// slot (the `clocks` buffer created beside the arena in createKernel; layout
// metadata in the generated region above):
//
//  - A NODE record's slot is its durable updated-at clock: a process-monotone
//    stamp moved when the node's TAGGED OUTCOME changes — value, thrown, or
//    suspended — so a throw-to-return transition with an identity-equal
//    payload still moves the clock (matching the boxed-outcome cutoff).
//    Bump sites: an atom write's acceptance (the kernel's identity gate, or
//    the policy comparator upstream of it — one gate per write, so eager
//    newest application and quiet refolds bump exactly when the newest
//    result changed), and a computed evaluation whose outcome changed
//    (including the first evaluation). Lazy computeds do not bump until
//    someone evaluates them; dirty/pending state is unaffected.
//  - A LINK record's slot is observer state — the last producer clock the
//    owning subscriber validated against. The kernel never reads or writes
//    it (the intra-run dedup stamp stays in the VERSION field); the observer
//    machinery stamps it at validation. The allocators guarantee a fresh or
//    reused link starts at 0 ("never validated") via the generated free
//    scrub.
//
// The skip rule for consumers: an observer may skip re-comparison only when
// the producer is CLEAN and its clock matches the observer's last-validated
// stamp; when the producer is dirty/pending, evaluate first, then compare
// values against the observer's own baseline (`isEqual` may be asymmetric,
// and a write-back-to-the-old-value sequence moves the clock while the
// value-gated contract forbids a re-fire — so clocks gate re-comparison,
// never replace it).
//
// Representation: a process-monotone float64 counter (never a wrapping u32 —
// observers legally survive arbitrarily long; 2^53 stamps cannot exhaust in
// practice), living in its own column, never in the FLAGS word (whose hot
// stores must stay constants).

/** The clock counter: the last stamp drawn. Module-level so a rebuilt kernel
 * resumes the sequence; bump sites store `++clockSource` into the record's
 * clock slot. */
let clockSource: Clock = 0;

// ---- the kernel op table -----------------------------------------------------

/**
 * The kernel op table: the one object whose function fields are the kernel's
 * operations. Consumers dispatch through the module-level slot {@link E}
 * (`E.readAtom(id)`, `E.write(id, v)`, …), which is re-linked to a fresh
 * table only at growth boundaries (see {@link createKernel}).
 */
export interface Kernel {
	records: RecordCount;
	buffer(): Int32Array;
	/** The clock column (one float64 slot per record; see the UpdatedAt clocks
	 * story on {@link clockSource}). Growth carry + cold consumers only — hot
	 * code inside the factory uses the closure constant. */
	clocks(): Float64Array;
	newSignal(value: unknown, target: object): NodeId;
	newComputed(getter: (ctx: unknown) => unknown, target: object): NodeId;
	newEffect(fn: () => (() => void) | void): NodeId;
	newScope(fn: () => void): NodeId;
	gen(id: NodeId): Generation;
	/** Read an atom record (computeds go through {@link computedRead}). */
	readAtom(s: NodeId): unknown;
	write(s: NodeId, value: unknown): boolean;
	computedRead(c: NodeId): unknown;
	run(e: NodeId): void;
	requeueAbort(e: NodeId): void;
	/** Dispose an effect or effect scope (see {@link disposeEffect}). */
	disposeEffect(e: NodeId): void;
	sweepPendingFree(): void;
	/** Reclamation's structural phase (cold):
	 * tear down the record's kernel structure — flags zeroed, a computed's
	 * deps disposed in reverse, residual subs defensively detached — without
	 * freeing the record: the caller owns free ordering (pendingFree now, or
	 * queued behind the record's deferred user cleanups). */
	reclaimStructure(id: NodeId): void;
	// Cold policy ops (never called from the hot walks).
	/** Marks a computed stale and propagates to its subs (settlement-invalidate). */
	invalidateComputed(c: NodeId): boolean;
	/** Dispose a computed record (deps unlinked, subs detached, free deferred). */
	disposeComputed(c: NodeId): void;
	/** Flag a computed MACHINERY_OWNED and retro-release the lifecycle refs
	 * its existing dep links contributed (future links are excluded at the
	 * gate; future unlinks see the flag and skip the release — balanced). */
	markMachineryOwned(c: NodeId): void;
	/** Flags the node for observed-lifecycle delivery (NodeField.LIFECYCLE). */
	markLifecycle(id: NodeId): void;
	/** True iff the currently-evaluating subscriber is a computed. */
	activeIsComputed(): boolean;
}

/**
 * Builds the kernel op table over a fresh arena of `records` records,
 * optionally carrying the old arena's contents (growth):
 *
 *     E = createKernel(records * 2, E.buffer(), E.clocks())
 *
 * ## The closure / module-state split
 *
 * The closure holds what must be rebuilt on growth: the operation functions
 * themselves, which fold the `memory` buffer as a closure constant (V8's
 * context specialization embeds it in compiled code — the reason arena
 * access needs no indirection). Module state is what must survive the
 * rebuild: counters, free-list heads, the effect queue, the side columns,
 * and the scratch stacks. A rebuilt table resumes exactly where the old one
 * stopped because everything positional lives outside the closure.
 */
function createKernel(records: RecordCount, carry?: Int32Array, clockCarry?: Float64Array): Kernel {
	const memory = new Int32Array(records * ArenaShape.STRIDE);
	// The clock column rides the same rebuild discipline as the arena: one
	// float64 slot per record, closure-captured by the hot paths, carried on
	// growth (a push-grown plain array would put a capacity check in the link
	// allocator's hot path instead).
	const clocks = new Float64Array(records);
	// Bundler-proof aliases for the module-level side arrays: esbuild
	// bundling demotes module-scope `const` to mutable `var`, so TurboFan
	// loses their constant-folding at module scope; a function-scope const
	// is preserved verbatim and folds via the same one-closure-cell context
	// specialization that embeds memory.
	const vals = values;
	const fnTab = fns;
	const queue = queued;
	const evalCtx = POLICY_CTX;
	if (carry !== undefined) {
		memory.set(carry);
	}
	if (clockCarry !== undefined) {
		clocks.set(clockCarry);
	}
	// Allocators flag growth once the bump pointer (the never-yet-used end of
	// the arena; allocation takes a freed record first, else bumps this) crosses
	// the watermark — the fill level that schedules growth. The rule: keep at
	// least ArenaShape.REC_SLACK records and half the arena free at every boundary.
	const watermark = Math.min(memory.length >> ArenaShape.HALF_ARENA_SHIFT, memory.length - ArenaShape.REC_SLACK * ArenaShape.STRIDE);
	if (recNext > watermark) {
		growPending = true;
	}

	return {
		records,
		buffer: () => memory,
		clocks: () => clocks,
		newSignal,
		newComputed,
		newEffect,
		newScope,
		gen: (id) => memory[id + NodeField.GEN],
		readAtom,
		write,
		computedRead,
		run,
		requeueAbort,
		disposeEffect,
		sweepPendingFree,
		reclaimStructure: reclaimStructureOp,
		invalidateComputed,
		disposeComputed: disposeComputedOp,
		markMachineryOwned: markMachineryOwnedOp,
		markLifecycle: (id) => {
			memory[id + NodeField.LIFECYCLE] = 1;
		},
		activeIsComputed: () => activeSub !== 0 && (memory[activeSub + NodeField.FLAGS] & NodeFlag.K_COMPUTED) !== 0,
	};

	// ---- allocation ----------------------------------------------------------

	function allocNode(flags: NodeFlags): NodeId {
		let id: NodeId;
		if (nodeFreeHead !== 0) {
			// Reused slot: it keeps its NODE_INDEX (freeNode never touches
			// field 7) — the new tenant inherits the slot's index, which is
			// what bounds index-keyed side tables by peak node count.
			id = nodeFreeHead;
			nodeFreeHead = memory[id + NodeField.DEPS];
			memory[id + NodeField.DEPS] = 0;
		} else {
			id = recNext as NodeId; // the allocator's decision point: this record becomes a node
			if (id >= memory.length) {
				throw new Error('cosignals: arena exhausted mid-operation; raise COSIGNAL_INITIAL_RECORDS');
			}
			recNext = id + ArenaShape.STRIDE;
			if (recNext > watermark) {
				growPending = true;
			}
			memory[id + NodeField.NODE_INDEX] = nextNodeIndex++; // a never-yet-node slot gets a fresh index
		}
		memory[id + NodeField.FLAGS] = flags;
		const v: ValueIndex = id >> ArenaShape.ID_TO_VALUE_SHIFT;
		while (vals.length <= v + ArenaShape.AUX_VALUE_OFFSET) {
			vals.push(undefined);
		}
		while (fnTab.length <= id >> ArenaShape.ID_TO_FN_SHIFT) {
			fnTab.push(undefined);
		}
		return id;
	}

	function freeNode(id: NodeId): void {
		memory[id + NodeField.FLAGS] = 0;
		memory[id + NodeField.LIFECYCLE] = 0;
		memory[id + NodeField.DEPS_TAIL] = 0;
		memory[id + NodeField.SUBS] = 0;
		memory[id + NodeField.SUBS_TAIL] = 0;
		++memory[id + NodeField.GEN];
		scrubNodeColumnsOnFree(id, clocks); // generated: every declared column clears, by construction
		memory[id + NodeField.DEPS] = nodeFreeHead; // NODE_INDEX (field 7) deliberately survives — see NodeField
		nodeFreeHead = id;
		// The record-free hook: hosts keying dense side tables by NODE_INDEX
		// scrub the freed record's rows here, so the slot's next tenant (which
		// inherits the index) can never be served the old tenant's rows. Fires
		// only from the boundary sweep (freeNode's one caller), after the GEN
		// bump — the hook may observe the new tenancy generation.
		const hook = recordFreeHook;
		if (hook !== undefined) {
			hook(id, memory[id + NodeField.NODE_INDEX]);
		}
	}

	/**
	 * Threads every pending disposed record onto the node free list (the
	 * boundary sweep's free phase; cold).
	 *
	 * ## Mass teardowns sort first
	 *
	 * Free lists are LIFO, so a mass teardown swept in arbitrary order would
	 * hand ids back scattered and the next build would spread across the
	 * arena: side columns go sparse and neighboring nodes lose cache
	 * adjacency. A batch crossing both {@link MassTeardown} bounds is sorted
	 * ascending and pushed in descending order, so pops come off ascending —
	 * dense, near-sequential reuse (measured in dalien-signals: rebuilding a
	 * 2M-node graph after a full dispose went from ~30s to build-from-fresh
	 * speed). The link free list is rethreaded under the same trigger
	 * ({@link sortLinkFreeList}). Ported from dalien-signals src/system.ts
	 * (sweepPendingFree).
	 */
	function sweepPendingFree(): void {
		const n = pendingFree.length;
		if (n > MassTeardown.MIN_BATCH && n * MassTeardown.MIN_ARENA_FRACTION >= recNext) {
			const batch = new Int32Array(n);
			for (let i = 0; i < n; ++i) {
				batch[i] = pendingFree[i];
			}
			batch.sort(); // TypedArray sort is numeric ascending
			// Push in descending order so pops come off ascending.
			for (let i = n - 1; i >= 0; --i) {
				freeNode(batch[i]);
			}
			sortLinkFreeList();
		} else {
			for (let i = 0; i < n; ++i) {
				freeNode(pendingFree[i]);
			}
		}
		pendingFree.length = 0;
	}

	/**
	 * Rethreads the link free list into ascending address order after a mass
	 * teardown (cold; called only from {@link sweepPendingFree}'s sorted
	 * branch). Ported from dalien-signals src/system.ts (sortLinkFreeList).
	 *
	 * One pass over the LIFO list marks members in a bitmap and counts them;
	 * free-list order never matters again after this, so sorted order is
	 * recovered by scanning the bitmap ascending and rethreading FREE_NEXT —
	 * no second pointer-chase walk over the arena and no comparison sort. The
	 * list walk is unavoidably random-access; the bitmap scan and the
	 * rethreading stores both ascend, so hardware prefetch covers them.
	 */
	function sortLinkFreeList(): void {
		let n = 0;
		const words = new Uint32Array(((recNext >> 3) + 32) >> 5);
		for (let id = linkFreeHead; id !== 0; id = memory[id + LinkField.FREE_NEXT]) {
			const rec = id >> 3;
			words[rec >> 5] |= 1 << (rec & 31);
			++n;
		}
		if (n <= MassTeardown.MIN_BATCH) {
			return; // below the mass bound: keep LIFO order, drop the bitmap
		}
		let head: LinkId = 0;
		let tail: LinkId = 0; // last rethreaded id; 0 until the first member
		for (let w = 0; w < words.length; ++w) {
			let bits = words[w];
			while (bits !== 0) {
				const bit = bits & -bits;
				bits ^= bit;
				const id: LinkId = ((w << 5) + (31 - Math.clz32(bit))) << 3;
				if (tail === 0) {
					head = id;
				} else {
					memory[tail + LinkField.FREE_NEXT] = id;
				}
				tail = id;
			}
		}
		memory[tail + LinkField.FREE_NEXT] = 0;
		linkFreeHead = head;
	}

	function allocLink(): LinkId {
		let id: LinkId;
		if (linkFreeHead !== 0) {
			id = linkFreeHead;
			linkFreeHead = memory[id + LinkField.FREE_NEXT];
		} else {
			id = recNext as LinkId; // the allocator's decision point: this record becomes a link
			if (id >= memory.length) {
				throw new Error('cosignals: arena exhausted mid-operation; raise COSIGNAL_INITIAL_RECORDS');
			}
			recNext = id + ArenaShape.STRIDE;
			if (recNext > watermark) {
				growPending = true;
			}
		}
		return id;
	}

	function freeLink(id: LinkId): void {
		scrubLinkColumnsOnFree(id, clocks); // generated: a reused link must not carry the old tenant's clock stamp
		memory[id + LinkField.FREE_NEXT] = linkFreeHead;
		linkFreeHead = id;
	}

	// ---- upstream system.ts, transliterated -------------------------------------
	// The arena walks in WorldArena.ts re-derive these algorithms over a
	// different record layout on purpose (weak-subs second list, VALID/BOX
	// bits, guard counters — see the header there). Behavioral drift between
	// the twins is caught by the model-comparison fuzz suites and the
	// conformance suite; that enforcement, not this comment, is the
	// guarantee. When changing either side, port the rule, not the text.

	/**
	 * Registers `sub`'s dependency on `dep` for this evaluation cycle.
	 *
	 * On recompute, if we link the same dependencies in the same order as
	 * last time, link takes a fast path and re-uses existing links: the
	 * re-track cursor (DEPS_TAIL) either already sits on `dep` or its
	 * successor names `dep`, and one field write re-validates the link. We
	 * moved the slow link-creation path out of line ({@link linkInsert}) to
	 * keep link under V8's inlining bytecode budget; the slow path only runs
	 * when dependencies change, which is rare.
	 */
	function link(dep: NodeId, sub: NodeId, version: Version): void {
		const prevDep = memory[sub + NodeField.DEPS_TAIL];
		if (prevDep !== 0 && memory[prevDep + LinkField.DEP] === dep) {
			return;
		}
		const nextDep = prevDep !== 0 ? memory[prevDep + LinkField.NEXT_DEP] : memory[sub + NodeField.DEPS];
		if (nextDep !== 0 && memory[nextDep + LinkField.DEP] === dep) {
			memory[nextDep + LinkField.VERSION] = version;
			memory[sub + NodeField.DEPS_TAIL] = nextDep;
			return;
		}
		linkInsert(dep, sub, version, prevDep, nextDep);
	}

	/**
	 * Insertion tail of {@link link}: splices a new link record into both the
	 * sub's dep list and the dep's subscriber list.
	 *
	 * Kept out of line so link's steady-state re-track fast path stays under
	 * V8's inlining bytecode budget (upstream's monolithic link() was 475
	 * bytecodes — kExceedsBytecodeLimit — and never inlined into the read
	 * paths despite running on every tracked read).
	 *
	 * ## The duplicate probe is not link's re-track check
	 *
	 * The opening scan answers a different question over a different list
	 * than {@link link} does: it checks the dep's subscriber tail for a
	 * same-version registration by this sub — "has this sub already
	 * registered on this dep this run?" (the same dep read twice in one
	 * evaluation). link's positional check walks the sub's dep list instead,
	 * asking "is this the same dep list as last run?".
	 */
	function linkInsert(dep: NodeId, sub: NodeId, version: Version, prevDep: LinkId, nextDep: LinkId): void {
		const prevSub = memory[dep + NodeField.SUBS_TAIL];
		if (prevSub !== 0 && memory[prevSub + LinkField.VERSION] === version && memory[prevSub + LinkField.SUB] === sub) {
			return;
		}
		const newLink = allocLink();
		memory[sub + NodeField.DEPS_TAIL] = newLink;
		memory[dep + NodeField.SUBS_TAIL] = newLink;
		memory[newLink + LinkField.VERSION] = version;
		memory[newLink + LinkField.DEP] = dep;
		memory[newLink + LinkField.SUB] = sub;
		memory[newLink + LinkField.PREV_DEP] = prevDep;
		memory[newLink + LinkField.NEXT_DEP] = nextDep;
		memory[newLink + LinkField.PREV_SUB] = prevSub;
		memory[newLink + LinkField.NEXT_SUB] = 0;
		if (nextDep !== 0) {
			memory[nextDep + LinkField.PREV_DEP] = newLink;
		}
		if (prevDep !== 0) {
			memory[prevDep + LinkField.NEXT_DEP] = newLink;
		} else {
			memory[sub + NodeField.DEPS] = newLink;
		}
		if (prevSub !== 0) {
			memory[prevSub + LinkField.NEXT_SUB] = newLink;
		} else {
			memory[dep + NodeField.SUBS] = newLink;
		}
		// Observed-lifecycle retain, per link (the kernel's arm of the union
		// is a refcount, not a bit, so machinery-owned subscribers can be
		// excluded without losing later plain ones): every new link to a
		// lifecycle-flagged dep retains one union ref, unless the subscriber
		// is machinery-owned (the observation index is the machinery's own
		// arm). Balanced by unlink's release.
		if (memory[dep + NodeField.LIFECYCLE] !== 0 && !(memory[sub + NodeField.FLAGS] & NodeFlag.MACHINERY_OWNED)) {
			retainLifecycle(dep);
		}
	}

	/**
	 * Removes one link record from both lists it threads (the sub's dep list
	 * and the dep's subscriber list) and frees it. Returns the next dep link,
	 * so purge loops can walk while unlinking.
	 *
	 * ## Last-subscriber consequences
	 *
	 * When the removed link was the dep's last subscriber, {@link unwatched}
	 * runs: a computed dep is stripped and marked dirty (nothing observes it,
	 * so its cache and links are dead weight), an effect/scope dep is
	 * disposed, and reclamation gets its retry poke. A lifecycle-flagged dep
	 * also releases one observed-lifecycle union ref per removed
	 * non-machinery link ({@link releaseLifecycle} — the union's last release
	 * schedules the user's flap-damped cleanup).
	 */
	function unlink(id: LinkId, sub: NodeId = memory[id + LinkField.SUB]): LinkId {
		const dep = memory[id + LinkField.DEP];
		const prevDep = memory[id + LinkField.PREV_DEP];
		const nextDep = memory[id + LinkField.NEXT_DEP];
		const nextSub = memory[id + LinkField.NEXT_SUB];
		const prevSub = memory[id + LinkField.PREV_SUB];
		// The balancing release for linkInsert's retain (per link):
		// lifecycle-flagged deps release one union ref per removed
		// non-machinery link.
		if (memory[dep + NodeField.LIFECYCLE] !== 0 && !(memory[sub + NodeField.FLAGS] & NodeFlag.MACHINERY_OWNED)) {
			releaseLifecycle(dep);
		}
		if (nextDep !== 0) {
			memory[nextDep + LinkField.PREV_DEP] = prevDep;
		} else {
			memory[sub + NodeField.DEPS_TAIL] = prevDep;
		}
		if (prevDep !== 0) {
			memory[prevDep + LinkField.NEXT_DEP] = nextDep;
		} else {
			memory[sub + NodeField.DEPS] = nextDep;
		}
		if (nextSub !== 0) {
			memory[nextSub + LinkField.PREV_SUB] = prevSub;
		} else {
			memory[dep + NodeField.SUBS_TAIL] = prevSub;
		}
		freeLink(id);
		if (prevSub !== 0) {
			memory[prevSub + LinkField.NEXT_SUB] = nextSub;
		} else if ((memory[dep + NodeField.SUBS] = nextSub) === 0) {
			unwatched(dep);
		}
		return nextDep;
	}

	/**
	 * Pushes staleness marks down the graph from a written node's subscriber
	 * list: subscribers go Pending (Dirty comes later, from checkDirty's
	 * verification), watching effects queue via {@link notify}, and mutable
	 * subscribers with subscribers of their own are descended into using the
	 * persistent scratch stack. `innerWrite` marks writes made during an
	 * effect run (upstream's Recursed handling).
	 *
	 * No try/finally: propagate never runs user code (notify only queues),
	 * so it cannot throw and always drains the stack back to its base.
	 */
	function propagate(startLink: LinkId, innerWrite: boolean): void {
		let cur = startLink;
		let next = memory[cur + LinkField.NEXT_SUB];
		const stackBase = propSp;

		top: do {
			const sub = memory[cur + LinkField.SUB];
			let flags = memory[sub + NodeField.FLAGS];

			if (!(flags & (NodeFlag.RECURSED_CHECK | NodeFlag.RECURSED | NodeFlag.DIRTY | NodeFlag.PENDING))) {
				memory[sub + NodeField.FLAGS] = flags | NodeFlag.PENDING;
				if (innerWrite) {
					memory[sub + NodeField.FLAGS] |= NodeFlag.RECURSED;
				}
			} else if (!(flags & (NodeFlag.RECURSED_CHECK | NodeFlag.RECURSED))) {
				flags = 0;
			} else if (!(flags & NodeFlag.RECURSED_CHECK)) {
				memory[sub + NodeField.FLAGS] = (flags & ~NodeFlag.RECURSED) | NodeFlag.PENDING;
			} else if (!(flags & (NodeFlag.DIRTY | NodeFlag.PENDING)) && isValidLink(cur, sub)) {
				memory[sub + NodeField.FLAGS] = flags | (NodeFlag.RECURSED | NodeFlag.PENDING);
				flags &= NodeFlag.MUTABLE;
			} else {
				flags = 0;
			}

			if (flags & NodeFlag.WATCHING) {
				notify(sub);
			}

			if (flags & NodeFlag.MUTABLE) {
				const subSubs = memory[sub + NodeField.SUBS];
				if (subSubs !== 0) {
					cur = subSubs;
					const nextSub = memory[cur + LinkField.NEXT_SUB];
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
				next = memory[cur + LinkField.NEXT_SUB];
				continue;
			}

			while (propSp > stackBase) {
				cur = propStack[--propSp];
				if (cur !== 0) {
					next = memory[cur + LinkField.NEXT_SUB];
					continue top;
				}
			}

			break;
		} while (true);
	}

	/**
	 * Answers "is this Pending sub actually stale?" by descending its dep
	 * links and recomputing any directly-dirty deps found (lazy pull). Entry
	 * wrapper: owns the scratch-stack base restore (update() runs user
	 * getters, which can throw mid-walk) and the shallow/two-level/chain fast
	 * paths; the general walk lives in {@link checkDirtyLoop}.
	 *
	 * ## Why split?
	 *
	 * Each piece must stay under V8's 460-bytecode inlining budget: the
	 * try/finally plumbing plus the loop was 537 bytecodes, which barred
	 * checkDirty from inlining into {@link run}/{@link computedReadSlow}.
	 * Splitting took small dependency cones from 1.05-1.3x of upstream's
	 * time to 0.9-1.1x. The bytecode budget suite pins all three pieces.
	 */
	function checkDirty(startLink: LinkId, startSub: NodeId): boolean {
		// Shallow fast path mirroring checkDirtyLoop's first iteration: the
		// sub is already dirty, or its first dep is a directly-dirty mutable
		// — the shape of every effect sitting one link away from a written
		// signal's computed. Resolving here skips the loop's stack machinery
		// and the try/finally for the hottest walks; anything deeper falls
		// through to the general loop unchanged.
		if (memory[startSub + NodeField.FLAGS] & NodeFlag.DIRTY) {
			return true;
		}
		const dep = memory[startLink + LinkField.DEP];
		const depFlags = memory[dep + NodeField.FLAGS];
		let tryChain = true;
		if ((depFlags & (NodeFlag.MUTABLE | NodeFlag.DIRTY)) === (NodeFlag.MUTABLE | NodeFlag.DIRTY)) {
			if (updateAndShallow(dep, memory[dep + NodeField.SUBS])) {
				// Same disposed-sub guard as the loop's return: update() may
				// run user code that disposes the sub mid-walk.
				return memory[startSub + NodeField.FLAGS] !== 0;
			}
			const nextDep = memory[startLink + LinkField.NEXT_DEP];
			if (nextDep === 0) {
				return false;
			}
			startLink = nextDep;
		} else if ((depFlags & (NodeFlag.MUTABLE | NodeFlag.PENDING)) === (NodeFlag.MUTABLE | NodeFlag.PENDING)) {
			const innerLink = memory[dep + NodeField.DEPS];
			if (memory[innerLink + LinkField.NEXT_DEP] !== 0) {
				// Branching inner deps (a diamond join): neither the
				// two-level fast path nor a chain can resolve this —
				// chainCheck's first descend provably fails the same
				// single-dep test — so skip straight to the general loop.
				tryChain = false;
			} else {
				// Two-level degenerate case: the pending dep has exactly one
				// dep of its own and it is directly dirty — the shape of
				// every effect one computed away from a written signal. The
				// sequence mirrors the loop's descend-then-unwind for this
				// shape: update the inner node (subs captured first), then
				// either recompute the pending dep or clear its Pending.
				const inner = memory[innerLink + LinkField.DEP];
				if ((memory[inner + NodeField.FLAGS] & (NodeFlag.MUTABLE | NodeFlag.DIRTY)) === (NodeFlag.MUTABLE | NodeFlag.DIRTY)) {
					if (updateAndShallow(inner, memory[inner + NodeField.SUBS])) {
						if (updateAndShallow(dep, memory[dep + NodeField.SUBS])) {
							return memory[startSub + NodeField.FLAGS] !== 0;
						}
					} else {
						memory[dep + NodeField.FLAGS] &= ~NodeFlag.PENDING;
					}
					const nextDep = memory[startLink + LinkField.NEXT_DEP];
					if (nextDep === 0) {
						return false;
					}
					startLink = nextDep;
				}
				// A single non-dirty inner link may still head a chain —
				// leave the chain dispatch on.
			}
			// Anything deeper falls through to the general loop with no
			// state mutated.
		}
		// Chains: a run of single-dep, single-subscriber pending nodes needs
		// no traversal stack — the descent is unbranched, and the unwind path
		// is recoverable by climbing each node's unique subscriber link.
		// deep/grid/island cones are exactly this shape.
		if (tryChain && memory[startLink + LinkField.NEXT_DEP] === 0) {
			const r = chainCheck(startLink);
			if (r >= 0) {
				return r !== 0 && memory[startSub + NodeField.FLAGS] !== 0;
			}
		}
		const stackBase = checkSp;
		try {
			return checkDirtyLoop(startLink, startSub);
		} finally {
			checkSp = stackBase;
		}
	}

	/**
	 * update() + the sibling Pending→Dirty upgrade, shared by the wrapper
	 * fast paths and the descend/unwind arms of {@link checkDirtyLoop}. The
	 * rule: `subs` is captured before update() runs, because the recompute's
	 * re-track may rebuild the subscriber list mid-call and the upgrade must
	 * walk the list as it stood when the node went stale.
	 */
	function updateAndShallow(node: NodeId, subs: LinkId): boolean {
		if (update(node)) {
			if (memory[subs + LinkField.NEXT_SUB] !== 0) {
				shallowPropagate(subs);
			}
			return true;
		}
		return false;
	}

	/**
	 * Stackless {@link checkDirty} walk for pure chains — a run of nodes each
	 * having exactly one dependency and one subscriber. Such a run can be
	 * walked without a stack because the way back up is each node's unique
	 * subscriber link: descend while the pending dep has exactly one dep-link
	 * and one subscriber; on finding a directly-dirty base, update back up by
	 * climbing those subscriber links — the resume state a branching walk
	 * would need a stack for is recoverable from the graph itself.
	 *
	 * Returns 1 (dirty: caller re-checks its sub), 0 (resolved clean), -1
	 * (the shape is not a chain here: fall through to the general loop,
	 * nothing mutated).
	 */
	function chainCheck(startLink: LinkId): number {
		let link = startLink;
		let depth = 0;
		let dep = 0;
		while (true) {
			dep = memory[link + LinkField.DEP];
			const flags = memory[dep + NodeField.FLAGS];
			if ((flags & (NodeFlag.MUTABLE | NodeFlag.DIRTY)) === (NodeFlag.MUTABLE | NodeFlag.DIRTY)) {
				break; // dirty base found
			}
			if ((flags & (NodeFlag.MUTABLE | NodeFlag.PENDING)) !== (NodeFlag.MUTABLE | NodeFlag.PENDING)) {
				return -1; // clean or non-mutable dep: not a resolvable chain
			}
			const depDeps = memory[dep + NodeField.DEPS];
			if (depDeps === 0 || memory[depDeps + LinkField.NEXT_DEP] !== 0) {
				return -1; // branching deps
			}
			const depSubs = memory[dep + NodeField.SUBS];
			if (depSubs === 0 || memory[depSubs + LinkField.NEXT_SUB] !== 0) {
				return -1; // shared node: the climb needs a unique subscriber
			}
			link = depDeps;
			++depth;
		}
		if (depth === 0) {
			return -1; // directly-dirty first dep: the shallow paths own this
		}
		let changed = updateAndShallow(dep, memory[dep + NodeField.SUBS]);
		let node = dep;
		while (depth--) {
			const up = memory[node + NodeField.SUBS];
			const sub = memory[up + LinkField.SUB];
			if (changed) {
				changed = updateAndShallow(sub, memory[sub + NodeField.SUBS]);
			} else {
				memory[sub + NodeField.FLAGS] &= ~NodeFlag.PENDING;
			}
			node = sub;
		}
		return changed ? 1 : 0;
	}

	/** The general {@link checkDirty} walk, out of line (the wrapper owns the
	 * checkSp restore, so a throwing getter unwinds through it). */
	function checkDirtyLoop(cur: LinkId, sub: NodeId): boolean {
		let checkDepth = 0;
		let dirty = false;

		top: do {
			const dep = memory[cur + LinkField.DEP];
			const depFlags = memory[dep + NodeField.FLAGS];

			if (memory[sub + NodeField.FLAGS] & NodeFlag.DIRTY) {
				dirty = true;
			} else if ((depFlags & (NodeFlag.MUTABLE | NodeFlag.DIRTY)) === (NodeFlag.MUTABLE | NodeFlag.DIRTY)) {
				if (updateAndShallow(dep, memory[dep + NodeField.SUBS])) {
					dirty = true;
				}
			} else if ((depFlags & (NodeFlag.MUTABLE | NodeFlag.PENDING)) === (NodeFlag.MUTABLE | NodeFlag.PENDING)) {
				if (checkSp === checkStack.length) {
					const bigger = new Int32Array(checkStack.length * 2);
					bigger.set(checkStack);
					checkStack = bigger;
				}
				checkStack[checkSp++] = cur;
				cur = memory[dep + NodeField.DEPS];
				sub = dep;
				++checkDepth;
				continue;
			}

			if (!dirty) {
				const nextDep = memory[cur + LinkField.NEXT_DEP];
				if (nextDep !== 0) {
					cur = nextDep;
					continue;
				}
			}

			while (checkDepth--) {
				cur = checkStack[--checkSp];
				if (dirty) {
					if (updateAndShallow(sub, memory[sub + NodeField.SUBS])) {
						sub = memory[cur + LinkField.SUB];
						continue;
					}
					dirty = false;
				} else {
					memory[sub + NodeField.FLAGS] &= ~NodeFlag.PENDING;
				}
				sub = memory[cur + LinkField.SUB];
				const nextDep = memory[cur + LinkField.NEXT_DEP];
				if (nextDep !== 0) {
					cur = nextDep;
					continue top;
				}
			}

			// Upstream: `dirty && !!sub.flags` — a live node always has its
			// kind bits set; flags reads 0 only if sub was disposed (record
			// zeroed) by re-entrant user code during update().
			return dirty && memory[sub + NodeField.FLAGS] !== 0;
		} while (true);
	}

	/** One-level Pending→Dirty upgrade along a subscriber list after a node's
	 * value actually changed; watching subscribers queue via {@link notify}. */
	function shallowPropagate(startLink: LinkId): void {
		let cur = startLink;
		do {
			const sub = memory[cur + LinkField.SUB];
			const flags = memory[sub + NodeField.FLAGS];
			if ((flags & (NodeFlag.PENDING | NodeFlag.DIRTY)) === NodeFlag.PENDING) {
				memory[sub + NodeField.FLAGS] = flags | NodeFlag.DIRTY;
				if ((flags & (NodeFlag.WATCHING | NodeFlag.RECURSED_CHECK)) === NodeFlag.WATCHING) {
					notify(sub);
				}
			}
		} while ((cur = memory[cur + LinkField.NEXT_SUB]) !== 0);
	}

	/** True iff `checkLink` still sits on `sub`'s dep list (propagate's guard
	 * against acting on a link a re-track already replaced). */
	function isValidLink(checkLink: LinkId, sub: NodeId): boolean {
		let cur = memory[sub + NodeField.DEPS_TAIL];
		while (cur !== 0) {
			if (cur === checkLink) {
				return true;
			}
			cur = memory[cur + LinkField.PREV_DEP];
		}
		return false;
	}

	// ---- upstream index.ts, transliterated ---------------------------------------

	/** Recomputes a stale node by kind; returns true iff its value changed. */
	function update(node: NodeId): boolean {
		const flags = memory[node + NodeField.FLAGS];
		if (flags & NodeFlag.K_COMPUTED) {
			return updateComputed(node);
		}
		if (flags & NodeFlag.K_SIGNAL) {
			return updateSignal(node);
		}
		memory[node + NodeField.FLAGS] = (flags & NodeFlag.KIND_MASK) | NodeFlag.MUTABLE;
		return true;
	}

	/** Queues a watching effect (and its still-watching ancestor chain) for
	 * the next flush; the inserted segment is reversed in place so outer
	 * effects run before inner. */
	function notify(e: NodeId): void {
		let insertIndex = queuedLength;
		const firstInsertedIndex = insertIndex;

		do {
			queue[insertIndex++] = e;
			memory[e + NodeField.FLAGS] &= ~NodeFlag.WATCHING;
			const subs = memory[e + NodeField.SUBS];
			e = subs !== 0 ? memory[subs + LinkField.SUB] : 0;
			if (e === 0 || !(memory[e + NodeField.FLAGS] & NodeFlag.WATCHING)) {
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

	/**
	 * A node just lost its last subscriber. Computeds are stripped (deps
	 * disposed, marked dirty — nothing observes them, so cache and links are
	 * dead weight) and reclamation gets its retry poke; signals only get the
	 * poke (their lifecycle release happens per link inside {@link unlink});
	 * effects and scopes dispose.
	 *
	 * ## Never strip a mid-evaluation record
	 *
	 * A record with RECURSED_CHECK set has its DEPS_TAIL serving as the live
	 * re-track cursor, and a neighbor's re-track can unlink the last sub of a
	 * node whose own frame is open (the mutual dep-flip shape — x newly reads
	 * y while y stale-depends on x). Stripping would free the cursor link;
	 * the very next insert reuses it as its own neighbor and the dep list
	 * goes cyclic — a hang, since the unwatched walk cannot traverse a link
	 * cycle. The open evaluation owns its list: its epilogue purge trims it,
	 * and a truly-dead record is lazily stripped at its next unwatched edge
	 * (bounded residue).
	 */
	function unwatched(node: NodeId): void {
		const flags = memory[node + NodeField.FLAGS];
		if (flags & NodeFlag.K_COMPUTED) {
			if (memory[node + NodeField.DEPS_TAIL] !== 0 && !(flags & NodeFlag.RECURSED_CHECK)) {
				memory[node + NodeField.FLAGS] = NodeFlag.K_COMPUTED | NodeFlag.MUTABLE | NodeFlag.DIRTY
					| (flags & NodeFlag.MACHINERY_OWNED); // ownership survives the rewrite
				disposeAllDepsInReverse(node);
			}
			// Reclamation retry trigger — the kernel-subs guard's clearing
			// site: a GC-skipped reclaim blocked on "something reads this
			// record" re-attempts when the last subscriber unlinks. Size-0
			// bail on the module var.
			if (reclaimSkippedN !== 0) {
				noteReclaimRetry(node);
			}
		} else if (flags & NodeFlag.K_SIGNAL) {
			// Reclamation retry trigger — the kernel-subs guard for signals.
			if (reclaimSkippedN !== 0) {
				noteReclaimRetry(node);
			}
		} else if (flags & (NodeFlag.K_EFFECT | NodeFlag.K_SCOPE)) {
			disposeEffect(node);
		}
	}

	/** Upstream's HasChildEffect slow path in updateComputed/run: unlink every
	 * dep that is not a signal/computed (i.e. child effects/scopes), in reverse. */
	function unlinkChildEffects(sub: NodeId): void {
		let cur = memory[sub + NodeField.DEPS_TAIL];
		while (cur !== 0) {
			const prev = memory[cur + LinkField.PREV_DEP];
			const dep = memory[cur + LinkField.DEP];
			if (!(memory[dep + NodeField.FLAGS] & (NodeFlag.K_COMPUTED | NodeFlag.K_SIGNAL))) {
				unlink(cur, sub);
			}
			cur = prev;
		}
	}

	/**
	 * Re-runs a computed's getter with tracking; returns true iff the cached
	 * outcome changed. The getter receives the one evaluation context
	 * ({@link POLICY_CTX}); a throwing getter never corrupts graph state —
	 * the raw thrown value / pending thenable becomes the cached payload via
	 * the cold {@link storeThrown} hook.
	 */
	function updateComputed(c: NodeId): boolean {
		const oldFlags = memory[c + NodeField.FLAGS];
		if (oldFlags & NodeFlag.HAS_CHILD_EFFECT) {
			unlinkChildEffects(c);
		}
		memory[c + NodeField.DEPS_TAIL] = 0;
		// The eval-start rewrite preserves the exceptional bits — while the
		// getter runs, the value slot still holds the previous outcome, and
		// ctx.previous / the isEqual wrapper need the bits to tell a residual
		// error/thenable payload from a plain previous value.
		memory[c + NodeField.FLAGS] = NodeFlag.K_COMPUTED | NodeFlag.MUTABLE | NodeFlag.RECURSED_CHECK
			| (oldFlags & (NodeFlag.HAS_BOX | NodeFlag.BOX_SUSPENDED | NodeFlag.MACHINERY_OWNED));
		const prevSub = activeSub;
		activeSub = c;
		++enterDepth;
		const v: ValueIndex = c >> ArenaShape.ID_TO_VALUE_SHIFT;
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
			// undefined). A changed tagged outcome also moves the node's
			// durable clock (the clock is over outcomes, not payloads).
			if (oldValue !== (vals[v] = (fnTab[c >> ArenaShape.ID_TO_FN_SHIFT] as (ctx: unknown) => unknown)(evalCtx)) || oldExc !== 0) {
				clocks[c >> ArenaShape.ID_TO_CLOCK_SHIFT] = ++clockSource;
				return true;
			}
			return false;
		} catch (e) {
			const bits = storeThrown(c, e, oldValue, oldExc);
			memory[c + NodeField.FLAGS] = (memory[c + NodeField.FLAGS] & ~(NodeFlag.HAS_BOX | NodeFlag.BOX_SUSPENDED)) | bits;
			keep = ~NodeFlag.RECURSED_CHECK;
			if (oldExc !== bits || oldValue !== vals[v]) {
				clocks[c >> ArenaShape.ID_TO_CLOCK_SHIFT] = ++clockSource;
				return true;
			}
			return false;
		} finally {
			--enterDepth;
			activeSub = prevSub;
			memory[c + NodeField.FLAGS] &= keep;
			purgeDeps(c);
		}
	}

	/**
	 * Promotes a dirty signal's pending value to current; returns true iff it
	 * differs. The flag write stores the constant signal word — a live
	 * signal's flags are always exactly K_SIGNAL | MUTABLE plus possibly
	 * Dirty, so a constant store (no load) is correct and keeps this path's
	 * flag update a single instruction.
	 */
	function updateSignal(s: NodeId): boolean {
		memory[s + NodeField.FLAGS] = NodeFlag.K_SIGNAL | NodeFlag.MUTABLE;
		const v: ValueIndex = s >> ArenaShape.ID_TO_VALUE_SHIFT;
		return vals[v] !== (vals[v] = vals[v + ArenaShape.AUX_VALUE_OFFSET]);
	}

	/** Runs a queued effect if it is actually stale ({@link checkDirty}
	 * verifies Pending), re-arming its Watching bit either way; runs its
	 * previous cleanup first. */
	function run(e: NodeId): void {
		const flags = memory[e + NodeField.FLAGS];
		if (
			flags & NodeFlag.DIRTY
			|| (flags & NodeFlag.PENDING && checkDirty(memory[e + NodeField.DEPS], e))
		) {
			if (flags & NodeFlag.HAS_CHILD_EFFECT) {
				unlinkChildEffects(e);
			}
			const cv: ValueIndex = (e >> ArenaShape.ID_TO_VALUE_SHIFT) + ArenaShape.AUX_VALUE_OFFSET;
			if (vals[cv]) {
				runCleanup(e);
				if (memory[e + NodeField.FLAGS] === 0) {
					return; // disposed by its own cleanup
				}
			}
			memory[e + NodeField.DEPS_TAIL] = 0;
			memory[e + NodeField.FLAGS] = NodeFlag.K_EFFECT | NodeFlag.WATCHING | NodeFlag.RECURSED_CHECK;
			const prevSub = activeSub;
			activeSub = e;
			++enterDepth;
			try {
				++cycle;
				++runDepth;
				vals[cv] = (fnTab[e >> ArenaShape.ID_TO_FN_SHIFT] as () => (() => void) | void)();
			} finally {
				--runDepth;
				--enterDepth;
				activeSub = prevSub;
				memory[e + NodeField.FLAGS] &= ~NodeFlag.RECURSED_CHECK;
				purgeDeps(e);
			}
		} else if (memory[e + NodeField.DEPS] !== 0) {
			memory[e + NodeField.FLAGS] = NodeFlag.K_EFFECT | NodeFlag.WATCHING | (flags & NodeFlag.HAS_CHILD_EFFECT);
		}
	}

	/** flush() abort path: re-arms effects still queued after a throw. */
	function requeueAbort(e: NodeId): void {
		if (memory[e + NodeField.FLAGS] & NodeFlag.KIND_MASK) {
			memory[e + NodeField.FLAGS] |= NodeFlag.WATCHING | NodeFlag.RECURSED;
		}
	}

	/** Runs an effect's stored cleanup outside any tracking frame. */
	function runCleanup(e: NodeId): void {
		const cv: ValueIndex = (e >> ArenaShape.ID_TO_VALUE_SHIFT) + ArenaShape.AUX_VALUE_OFFSET;
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

	/**
	 * Disposes an effect or effect scope — those two kinds only (atoms have
	 * no disposal; computeds go through {@link disposeComputedOp}): unlinks
	 * its deps in reverse, detaches it from its parent, runs an effect's
	 * pending cleanup, and defers the record free to the boundary sweep.
	 *
	 * The single `unlink(sub)` is complete: an effect's SUBS list holds at
	 * most the one parent-ownership edge, because effects are unreadable —
	 * nothing else can ever subscribe to one.
	 */
	function disposeEffect(e: NodeId): void {
		const flags = memory[e + NodeField.FLAGS];
		if (!(flags & NodeFlag.KIND_MASK)) {
			return; // already disposed
		}
		memory[e + NodeField.FLAGS] = 0;
		disposeAllDepsInReverse(e);
		const sub = memory[e + NodeField.SUBS];
		if (sub !== 0) {
			unlink(sub);
		}
		if (flags & NodeFlag.K_EFFECT && vals[(e >> ArenaShape.ID_TO_VALUE_SHIFT) + ArenaShape.AUX_VALUE_OFFSET]) {
			runCleanup(e);
		}
		// Deferred free: the queue (or an in-flight walk) may still hold this
		// id; the record is swept back onto the free list at the next
		// operation boundary.
		pendingFree.push(e);
	}

	/** Unlinks every dep of `sub`, newest first (disposal order: children
	 * created later tear down before their elders). */
	function disposeAllDepsInReverse(sub: NodeId): void {
		let cur = memory[sub + NodeField.DEPS_TAIL];
		while (cur !== 0) {
			const prev = memory[cur + LinkField.PREV_DEP];
			unlink(cur, sub);
			cur = prev;
		}
	}

	/** Evaluation epilogue: unlinks every dep the re-track did not re-visit
	 * (everything past the DEPS_TAIL cursor is last run's leftovers). */
	function purgeDeps(sub: NodeId): void {
		const depsTail = memory[sub + NodeField.DEPS_TAIL];
		let dep = depsTail !== 0 ? memory[depsTail + LinkField.NEXT_DEP] : memory[sub + NodeField.DEPS];
		while (dep !== 0) {
			dep = unlink(dep, sub);
		}
	}

	// ---- operations dispatched from the public wrappers ------------------------

	/**
	 * Registers a public handle with the reclamation registry so its record
	 * can be recovered if the handle is garbage-collected. Rides the
	 * allocation ops (the handle classes pass themselves as `target`): the
	 * closure owns `memory`, so the gen read is one indexed load on the
	 * record just touched, and this call is the only per-construction
	 * reclamation cost (see {@link reclaimNode}).
	 *
	 * The registered heldValue packs id and generation into one number where
	 * exactness allows (see {@link HeldValue}): the bare id while gen = 0;
	 * gen × HeldValue.ID_SPAN + id while 0 < gen < HeldValue.MAX_PACKED_GEN;
	 * an {id, gen} object beyond — including wrapped (negative) Int32 gens,
	 * which cannot round-trip the packed form.
	 */
	function registerReclaim(target: object, id: NodeId): void {
		const reg = reclaimRegistry;
		if (reg !== undefined) {
			const gen: Generation = memory[id + NodeField.GEN];
			reg.register(target, gen === 0 ? id : gen > 0 && gen < HeldValue.MAX_PACKED_GEN ? gen * HeldValue.ID_SPAN + id : { id, gen });
		}
	}

	function newSignal(value: unknown, target: object): NodeId {
		const id = allocNode(NodeFlag.K_SIGNAL | NodeFlag.MUTABLE);
		const v: ValueIndex = id >> ArenaShape.ID_TO_VALUE_SHIFT;
		vals[v] = value; // currentValue
		vals[v + ArenaShape.AUX_VALUE_OFFSET] = value; // pendingValue
		registerReclaim(target, id);
		return id;
	}

	function newComputed(getter: (ctx: unknown) => unknown, target: object): NodeId {
		const id = allocNode(NodeFlag.K_COMPUTED);
		fnTab[id >> ArenaShape.ID_TO_FN_SHIFT] = getter;
		registerReclaim(target, id);
		return id;
	}

	/** Creates an effect record and runs `fn` at once with tracking; a parent
	 * evaluation frame, if open, gains the child-ownership edge (the effect
	 * links as its parent's dep). */
	function newEffect(fn: () => (() => void) | void): NodeId {
		const e = allocNode(NodeFlag.K_EFFECT | NodeFlag.WATCHING | NodeFlag.RECURSED_CHECK);
		fnTab[e >> ArenaShape.ID_TO_FN_SHIFT] = fn;
		const prevSub = activeSub;
		activeSub = e;
		if (prevSub !== 0) {
			link(e, prevSub, 0);
			memory[prevSub + NodeField.FLAGS] |= NodeFlag.HAS_CHILD_EFFECT;
		}
		++enterDepth;
		try {
			++runDepth;
			vals[(e >> ArenaShape.ID_TO_VALUE_SHIFT) + ArenaShape.AUX_VALUE_OFFSET] = fn();
		} finally {
			--runDepth;
			--enterDepth;
			activeSub = prevSub;
			memory[e + NodeField.FLAGS] &= ~NodeFlag.RECURSED_CHECK;
		}
		return e;
	}

	/** Creates an effect-scope record and runs `fn` inside it, so effects
	 * created during the call link as the scope's deps and dispose with it. */
	function newScope(fn: () => void): NodeId {
		const e = allocNode(NodeFlag.K_SCOPE | NodeFlag.MUTABLE);
		const prevSub = activeSub;
		activeSub = e;
		if (prevSub !== 0) {
			link(e, prevSub, 0);
			memory[prevSub + NodeField.FLAGS] |= NodeFlag.HAS_CHILD_EFFECT;
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

	/** Reads an atom record: promote a dirty pending value, register the
	 * dependency link when a tracking frame is open, serve the value slot. */
	function readAtom(s: NodeId): unknown {
		if (memory[s + NodeField.FLAGS] & NodeFlag.DIRTY) {
			if (updateSignal(s)) {
				const subs = memory[s + NodeField.SUBS];
				if (subs !== 0) {
					shallowPropagate(subs);
				}
			}
		}
		if (activeSub !== 0) {
			link(s, activeSub, cycle);
		}
		return vals[s >> ArenaShape.ID_TO_VALUE_SHIFT];
	}

	/**
	 * Writes an atom record's pending value and propagates staleness; returns
	 * true iff subscribers were notified. The wrapper flushes (iff this
	 * returns true), so growth can happen between queued effects at the top
	 * level (upstream flushes inline here, only when the changed signal had
	 * subscribers).
	 *
	 * The flag write stores the constant signal word (see
	 * {@link updateSignal} — the same rule; the observed-lifecycle mark lives
	 * in its own field precisely so these stores stay constant).
	 */
	function write(s: NodeId, value: unknown): boolean {
		const p: ValueIndex = (s >> ArenaShape.ID_TO_VALUE_SHIFT) + ArenaShape.AUX_VALUE_OFFSET;
		if (vals[p] !== (vals[p] = value)) {
			memory[s + NodeField.FLAGS] = NodeFlag.K_SIGNAL | NodeFlag.MUTABLE | NodeFlag.DIRTY;
			// The durable clock moves at acceptance — this identity gate is the
			// write's last equality gate (the policy comparator, when present,
			// already ran upstream). The later pending→current promotion
			// (updateSignal) does not bump: the node is DIRTY until then, and
			// observers never clock-skip a dirty producer.
			clocks[s >> ArenaShape.ID_TO_CLOCK_SHIFT] = ++clockSource;
			const subs = memory[s + NodeField.SUBS];
			if (subs !== 0) {
				propagate(subs, runDepth !== 0);
				return true;
			}
		}
		return false;
	}

	/**
	 * Reads a computed record — the clean-read fast path. Split from the
	 * recompute cases the same way {@link link}/{@link linkInsert} is split:
	 * the monolithic body sits at 448+ bytecodes, past V8's 460-byte inline
	 * cliff (measured: falling off costs ~2.5ns on every clean read). One
	 * combined mask test routes every non-trivial case — mid-evaluation
	 * re-entry, dirty/pending revalidation, first evaluation, boxed cache —
	 * to the out-of-line slow path.
	 */
	function computedRead(c: NodeId): unknown {
		const flags = memory[c + NodeField.FLAGS];
		if (
			flags & (NodeFlag.RECURSED_CHECK | NodeFlag.DIRTY | NodeFlag.PENDING | NodeFlag.HAS_BOX)
			|| !(flags & NodeFlag.MUTABLE) // never evaluated (upstream `!flags`; exact-compare broke when the ownership bit joined the word)
		) {
			return computedReadSlow(c, flags);
		}
		if (activeSub !== 0) {
			link(c, activeSub, cycle);
		}
		return vals[c >> ArenaShape.ID_TO_VALUE_SHIFT];
	}

	/**
	 * The full computedRead decision ladder, out of line. Its stages, in
	 * order: the cycle fast-out, the dirty/pending descent, first evaluation,
	 * dependency linking, and the boxed-cache unwrap — each marked below.
	 */
	function computedReadSlow(c: NodeId, flags: NodeFlags): unknown {
		// Stage 1 — cycle fast-out: reading a computed while its own
		// evaluation frame is open is a dependency cycle — throw instead of
		// serving the stale cache (upstream alien-signals returns the stale
		// cached value here).
		if (flags & NodeFlag.RECURSED_CHECK) {
			throw new CycleError('cosignals: computed read during its own evaluation (dependency cycle).');
		}
		// Stage 2 — staleness resolution: directly dirty recomputes at once;
		// Pending descends through checkDirty, which either proves staleness
		// (recompute + upgrade one level of subscribers) or clears the bit.
		if (
			flags & NodeFlag.DIRTY
			|| (
				flags & NodeFlag.PENDING
				&& (
					checkDirty(memory[c + NodeField.DEPS], c)
					|| (memory[c + NodeField.FLAGS] = flags & ~NodeFlag.PENDING, false)
				)
			)
		) {
			if (updateComputed(c)) {
				const subs = memory[c + NodeField.SUBS];
				if (subs !== 0) {
					shallowPropagate(subs);
				}
			}
		} else if (!(flags & NodeFlag.MUTABLE)) {
			// Stage 3 — first evaluation (upstream reads this as `!flags`):
			// run the getter with tracking; a throw stores the raw payload as
			// the cached outcome (cold catch — no previous outcome exists).
			memory[c + NodeField.FLAGS] = NodeFlag.K_COMPUTED | NodeFlag.MUTABLE | NodeFlag.RECURSED_CHECK
				| (flags & NodeFlag.MACHINERY_OWNED);
			const prevSub = activeSub;
			activeSub = c;
			++enterDepth;
			try {
				vals[c >> ArenaShape.ID_TO_VALUE_SHIFT] = (fnTab[c >> ArenaShape.ID_TO_FN_SHIFT] as (ctx: unknown) => unknown)(evalCtx);
			} catch (e) {
				memory[c + NodeField.FLAGS] |= storeThrown(c, e, undefined, 0);
			} finally {
				--enterDepth;
				activeSub = prevSub;
				memory[c + NodeField.FLAGS] &= ~NodeFlag.RECURSED_CHECK;
			}
			// First evaluation is a fresh tagged outcome (value or box): the
			// durable clock moves from 0 ("never") unconditionally.
			clocks[c >> ArenaShape.ID_TO_CLOCK_SHIFT] = ++clockSource;
		}
		// Stage 4 — dependency linking, before any rethrow: the subscription
		// must exist even when the read throws, so recovery re-notifies
		// whoever observed the throw.
		const sub = activeSub;
		if (sub !== 0) {
			link(c, sub, cycle);
		}
		// Stage 5 — boxed-cache unwrap ({@link boxedRead}): errors rethrow,
		// settled suspensions self-heal, pending suspensions throw the
		// thenable's stable SuspendedRead.
		const f = memory[c + NodeField.FLAGS];
		if (f & NodeFlag.HAS_BOX) {
			return boxedRead(c, f);
		}
		return vals[c >> ArenaShape.ID_TO_VALUE_SHIFT];
	}

	/**
	 * Settlement-invalidate primitive: marks the computed stale exactly the
	 * way a dependency write would have and propagates to its subscribers;
	 * the wrapper flushes. Cold: called from settle listeners and read-site
	 * self-heal only.
	 */
	function invalidateComputed(c: NodeId): boolean {
		const flags = memory[c + NodeField.FLAGS];
		if (!(flags & NodeFlag.K_COMPUTED)) {
			return false;
		}
		memory[c + NodeField.FLAGS] = flags | NodeFlag.DIRTY;
		const subs = memory[c + NodeField.SUBS];
		if (subs !== 0) {
			propagate(subs, runDepth !== 0);
			return true;
		}
		return false;
	}

	/**
	 * Flags a computed machinery-owned (see {@link NodeFlag.MACHINERY_OWNED})
	 * and settles the books for links created before the computed gained
	 * concurrent-machinery content: each existing link to a lifecycle dep
	 * retained a union ref at insert, and its eventual unlink will skip the
	 * release (the flag reads at unlink time) — so release those refs here,
	 * once.
	 */
	function markMachineryOwnedOp(c: NodeId): void {
		const flags = memory[c + NodeField.FLAGS];
		if (!(flags & NodeFlag.K_COMPUTED) || flags & NodeFlag.MACHINERY_OWNED) {
			return;
		}
		memory[c + NodeField.FLAGS] = flags | NodeFlag.MACHINERY_OWNED;
		let l = memory[c + NodeField.DEPS];
		while (l !== 0) {
			const dep = memory[l + LinkField.DEP];
			if (memory[dep + NodeField.LIFECYCLE] !== 0) {
				releaseLifecycle(dep);
			}
			l = memory[l + LinkField.NEXT_DEP];
		}
	}

	/**
	 * Reclamation's structural phase (see the {@link Kernel} interface doc):
	 * the caller ({@link reclaimNode}, module scope) verified epoch, tenancy
	 * generation, every guard, and that no kernel frame is open. Flags zero
	 * first (mirrors {@link disposeComputedOp}: the record is dead before any
	 * unlink probe can see it); a computed's outgoing deps dispose — a
	 * never-subscribed evaluated computed owns dep structure that must go
	 * with it — and any residual subs detach defensively (the subs guard
	 * makes them unreachable in practice). Signals have no outgoing
	 * structure: their links live on subscriber records, and an empty SUBS
	 * list is one of the guards.
	 */
	function reclaimStructureOp(id: NodeId): void {
		const flags = memory[id + NodeField.FLAGS];
		memory[id + NodeField.FLAGS] = 0;
		if (flags & NodeFlag.K_COMPUTED) {
			disposeAllDepsInReverse(id);
			let l = memory[id + NodeField.SUBS];
			while (l !== 0) {
				const next = memory[l + LinkField.NEXT_SUB];
				unlink(l);
				l = next;
			}
		}
	}

	/**
	 * Computed disposal (the useComputed deps-change path; cold — reached
	 * only through the op table's disposeComputed). Flags zero first so the
	 * last sub unlink's {@link unwatched} probe sees a dead record; remaining
	 * subscriber links detach (their records simply lose the dep — a later
	 * re-track just doesn't see it; the caller owns the discipline that the
	 * node is superseded); the free defers to the next operation boundary
	 * exactly like effect/scope disposal (in-flight walks may still hold the
	 * id), where freeNode bumps GEN — the id-tenancy stamp.
	 */
	function disposeComputedOp(c: NodeId): void {
		if (!(memory[c + NodeField.FLAGS] & NodeFlag.K_COMPUTED)) {
			return; // not a computed / already disposed
		}
		memory[c + NodeField.FLAGS] = 0;
		disposeAllDepsInReverse(c);
		let l = memory[c + NodeField.SUBS];
		while (l !== 0) {
			const next = memory[l + LinkField.NEXT_SUB];
			unlink(l);
			l = next;
		}
		pendingFree.push(c);
	}
}

// ---- the live op table + growth ------------------------------------------------

/** Default capacity floor, in records, when neither the env var nor configure() sets one. */
export const DEFAULT_INITIAL_RECORDS = 1 << 20;
/** Smallest legal capacity floor, in records — the env parse and configure() validation both enforce it. */
export const MIN_INITIAL_RECORDS = 2;

const initialRecords = (() => {
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
		.process?.env?.COSIGNAL_INITIAL_RECORDS;
	const n = env !== undefined ? Number(env) : NaN;
	return Number.isFinite(n) && n >= MIN_INITIAL_RECORDS ? Math.ceil(n) : DEFAULT_INITIAL_RECORDS;
})();

// configure({initialRecords}) raises this floor; the growth loop honors it.
let desiredRecords: RecordCount = initialRecords * ArenaShape.RECORDS_PER_UNIT;

/**
 * The fold-purity table (see runFold): every operation throws the fold error
 * (requeueAbort no-ops so flush()'s finally can never mask one).
 *
 * ## Why its own object shape?
 *
 * Deliberately distinct from {@link createKernel}'s: V8 groups objects by
 * hidden class (its internal record of an object's layout), and the real
 * table must stay the only live instance of its hidden class so V8 keeps the
 * table's function fields constant and inlines `E.op` call targets (sharing
 * one hidden class between the two tables measurably killed that: +15-25% on
 * recompute/read-heavy benchmark workloads). Legal code never dispatches
 * through POISON — only fold-purity violations reach it, and those throw —
 * so the polymorphism it could introduce at `E.op` sites is confined to code
 * that is already erroring.
 */
const POISON: Kernel = {
	records: 2,
	buffer: foldPoisonOp as never,
	clocks: foldPoisonOp as never,
	newSignal: foldPoisonOp as never,
	newComputed: foldPoisonOp as never,
	newEffect: foldPoisonOp as never,
	newScope: foldPoisonOp as never,
	gen: foldPoisonOp as never,
	readAtom: foldPoisonOp as never,
	write: foldPoisonOp as never,
	computedRead: foldPoisonOp as never,
	run: foldPoisonOp as never,
	requeueAbort: foldNoop as never,
	disposeEffect: foldPoisonOp as never,
	sweepPendingFree: foldPoisonOp as never,
	reclaimStructure: foldPoisonOp as never,
	invalidateComputed: foldPoisonOp as never,
	disposeComputed: foldPoisonOp as never,
	markMachineryOwned: foldPoisonOp as never,
	markLifecycle: foldPoisonOp as never,
	activeIsComputed: foldPoisonOp as never,
};

/** The kernel op table — the one mutable slot every consumer dispatches
 * through, re-linked only at growth boundaries ({@link boundaryWork}) and by
 * the fold-guard swap pair. Capacity: 3 × initialRecords shared records,
 * budgeted as one node + two link records per configured unit. */
export let E: Kernel = createKernel(initialRecords * ArenaShape.RECORDS_PER_UNIT);

/**
 * Record-free hook (one hook; see freeNode): invoked at the boundary sweep
 * for every freed node record with (recordId, nodeIndex). Hosts that key
 * dense per-node side tables by NodeField.NODE_INDEX register their scrub
 * here — a freed slot's index is inherited by the slot's next tenant, so
 * every index-keyed row must clear at exactly this boundary. The hook runs
 * at an operation boundary and must not allocate or free kernel records.
 * @internal
 */
let recordFreeHook: ((recordId: NodeId, nodeIndex: NodeIndex) => void) | undefined;

/** Installs/clears the record-free hook (a composition seam). @internal */
export function __setRecordFreeHook(fn: ((recordId: NodeId, nodeIndex: NodeIndex) => void) | undefined): void {
	recordFreeHook = fn;
}

// ---- signal reclamation -----------------------------------------------------------
// FinalizationRegistry-driven recovery of atom/computed records whose public
// handles were garbage-collected. The kernel owns this machinery because its
// hottest trigger site (unwatched's last-subscriber edge) is kernel code: the
// size-0 bail there is a same-module `var` read. Liveness held by the
// concurrent machinery (the watcher index, arenas, observation, write logs)
// is consulted through one registered hook; every clearing site of a guard
// files a per-id retry. Registration cost lives in the Atom/Computed
// constructors — never on read/write paths.

/** A GC-skipped reclaim's retry ticket: the tenancy generation and reset
 * epoch the finalizer carried (re-verified when the guard clears). */
type ReclaimRetryEntry = { gen: Generation; epoch: number };

/** A reclaimed record's deferred user cleanups (owned child effects): run at
 * the next boundary sweep under reportError isolation; the record's free is
 * queued behind the entry (free-list insertion is the last step per entry). */
type DeferredCleanupEntry = { id: NodeId; gen: Generation; cleanups: (() => void)[] };

/**
 * Bounds of the packed finalizer heldValue, `gen × ID_SPAN + id` — one float64
 * carrying both the record id and its tenancy generation (see
 * {@link ReclaimHeld}).
 */
const enum HeldValue {
	/**
	 * 2^32 — the multiplier that shifts the generation above the id: ids are
	 * Int32 arena indexes, so they always fit below 2^32, and
	 * `held % ID_SPAN` / `Math.floor(held / ID_SPAN)` recover the parts
	 * exactly.
	 */
	ID_SPAN = 0x100000000,
	/**
	 * 2^21 — the exclusive generation bound for packing. Float64 represents
	 * every integer up to 2^53 exactly; the largest packed value,
	 * (2^21 − 1) × 2^32 + (2^32 − 1) = 2^53 − 1, is still exact, so any
	 * gen < 2^21 round-trips without precision loss. Generations at or above
	 * this bound (including wrapped negative Int32 values, which cannot
	 * round-trip the packed form at all) fall back to an {id, gen} object.
	 */
	MAX_PACKED_GEN = 0x200000,
}

/** Finalizer heldValue: the bare id while gen = 0; the packed
 * gen × HeldValue.ID_SPAN + id while 0 < gen < HeldValue.MAX_PACKED_GEN; the
 * {id, gen} object beyond — so defusing always compares the raw Int32
 * generation by equality. */
type ReclaimHeld = number | { id: NodeId; gen: Generation };

/**
 * GC-skipped reclaims awaiting their blocking guard to clear, keyed by id.
 * Never globally scanned: each guard's clearing site consults its own id
 * (noteReclaimRetry) or drains the map wholesale at whole-arena teardown
 * (reclaimRetryAllSkipped) — retries re-verify every guard, so a wholesale
 * drain is conservative, never wrong.
 */
const reclaimSkipped = new Map<NodeId, ReclaimRetryEntry>();

/** reclaimSkipped.size mirrored as a module `var`: the size-0 bail every
 * warm trigger site opens with (a `var` read compares `!== 0` — no Map.size
 * getter call, no let-slot hole check on the kernel's unwatched edge).
 * Cross-module trigger sites import the live binding. @internal */
// eslint-disable-next-line no-var
export var reclaimSkippedN = 0;

/** Ids whose blocking guard just cleared (clearing sites push; the boundary
 * drain re-attempts). */
const reclaimRetries: NodeId[] = [];

/** Deferred-cleanup queue (phase 2 input). Swapped wholesale by the drain
 * (take-before-call), so `let` — cold path, never read per-call. */
let deferredCleanups: DeferredCleanupEntry[] = [];

/** The one flag maybeBoundary tests for both queues (`var`: hot module flag). */
// eslint-disable-next-line no-var
var reclaimWorkPending = false;

/** The deferred-cleanup drain guard (take-before-call): set while
 * phase 2 runs taken entries; a reentrant boundary (a cleanup writing an
 * atom) finds it set and does no cleanup work. Joins `__resetEngineForTest`'s
 * assertIdle preconditions. */
// eslint-disable-next-line no-var
var reclaimDrainGuard = false;

/** Coalesced post-trigger nudge: a guard can clear (or a finalizer can file
 * work) with no public operation following — an epoch-guarded microtask runs
 * maybeBoundary so an unreachable, unobserved record frees even at idle. */
// eslint-disable-next-line no-var
var reclaimNudgeScheduled = false;

/** Liveness held by the concurrent machinery, for the reclaim guards
 * (registered per composition by concurrent.ts): watcher-index membership,
 * open-render arena membership, any arena's suspended-list membership,
 * observation retains, and a non-empty write log. */
let reclaimGuardHook: ((id: NodeId, nodeIndex: NodeIndex) => boolean) | undefined;

/** Installs/clears the reclaim guard hook (a composition seam). @internal */
export function __setReclaimGuardHook(fn: ((id: NodeId, nodeIndex: NodeIndex) => boolean) | undefined): void {
	reclaimGuardHook = fn;
}

/**
 * Builds the per-epoch registry: the reset epoch lives in the registry's
 * closure — heldValues carry no epoch. `__resetKernelForTest` drops the
 * registry and constructs a fresh one: an unreachable registry's pending
 * callbacks are never delivered (mass cancellation by dropping one object,
 * no per-handle unregister), and a callback already extracted before the
 * drop no-ops on the closure epoch compare — belt and suspenders. Production
 * never resets: one registry for the process lifetime.
 */
function makeReclaimRegistry(): FinalizationRegistry<ReclaimHeld> | undefined {
	if (typeof FinalizationRegistry !== 'function') {
		return undefined; // no-FR host: dropped handles keep the documented bounded retention
	}
	const epoch = engineEpoch;
	return new FinalizationRegistry<ReclaimHeld>((held) => {
		if (typeof held === 'number') {
			if (held < HeldValue.ID_SPAN) {
				reclaimNode(held, 0, epoch);
			} else {
				const gen = Math.floor(held / HeldValue.ID_SPAN);
				reclaimNode(held - gen * HeldValue.ID_SPAN, gen, epoch);
			}
		} else {
			reclaimNode(held.id, held.gen, epoch);
		}
		// Phase 2 (deferred cleanups + the free sweep) never runs in the GC
		// job: it lands at the nudge microtask's boundary.
		scheduleReclaimNudge();
	});
}

// eslint-disable-next-line no-var
var reclaimRegistry = makeReclaimRegistry();

/**
 * How handles register for reclamation: the Atom/Computed constructors pass
 * `this` to E.newSignal/E.newComputed, and {@link createKernel}'s
 * registerReclaim registers it there (the closure owns the buffer, so the
 * gen read has no op-table indirection) — the priced creation cost;
 * registration never appears on read/write paths.
 *
 * All three classes (Atom, ReducerAtom, Computed) register their lean
 * instances directly: flat field records (methods live on prototypes; user
 * closures are referents, not shape) — the shape measured cheapest for the
 * GC to collect. Measured rejects: per-handle FinalizationRegistry
 * unregister keys (+103ns per construction), WeakRef schemes (+93ns),
 * deferred/batched and lazy registration. Deterministic dispose paths do not
 * unregister — epoch+gen defusing covers their finalizers.
 */

function reclaimFileSkip(id: NodeId, gen: Generation, epoch: number): void {
	if (!reclaimSkipped.has(id)) {
		reclaimSkipped.set(id, { gen, epoch });
		reclaimSkippedN = reclaimSkipped.size;
	}
}

/** Drop a skip ticket iff it names this tenancy — a stale finalizer for a
 * reused id must never cancel the new tenant's pending retry. */
function reclaimDropSkip(id: NodeId, gen: Generation): void {
	if (reclaimSkippedN !== 0) {
		const e = reclaimSkipped.get(id);
		if (e !== undefined && e.gen === gen && reclaimSkipped.delete(id)) {
			reclaimSkippedN = reclaimSkipped.size;
		}
	}
}

/**
 * Per-id retry filing — every guard row's clearing site calls this (after
 * its own `reclaimSkippedN !== 0` bail where the site is warm). Edge work
 * only queues: the re-attempt itself runs at the next operation boundary
 * (clearing sites fire mid-walk, where structural teardown is unsafe).
 * @internal
 */
export function noteReclaimRetry(id: NodeId): void {
	if (reclaimSkippedN === 0 || !reclaimSkipped.has(id)) {
		return;
	}
	reclaimRetries.push(id);
	if (reclaimWorkPending === false) {
		reclaimWorkPending = true;
	}
	scheduleReclaimNudge();
}

/**
 * Wholesale re-attempt of every skipped id — the whole-arena teardown drains
 * (render end, settlement drain, arena release/quiesce), where many
 * memberships clear at once. Conservative by construction: each retry
 * re-verifies all guards and re-files if still blocked. @internal
 */
export function reclaimRetryAllSkipped(): void {
	if (reclaimSkippedN === 0) {
		return;
	}
	for (const id of reclaimSkipped.keys()) {
		reclaimRetries.push(id);
	}
	if (reclaimWorkPending === false) {
		reclaimWorkPending = true;
	}
	scheduleReclaimNudge();
}

function scheduleReclaimNudge(): void {
	if (reclaimNudgeScheduled === true) {
		return;
	}
	reclaimNudgeScheduled = true;
	// Reset-epoch guard (cross-reset microtask discipline).
	const epoch = engineEpoch;
	queueMicrotask(() => {
		reclaimNudgeScheduled = false;
		if (epoch !== engineEpoch) {
			return;
		}
		maybeBoundary();
	});
}

/** reportError isolation for phase-2 cleanups: a throwing cleanup is
 * surfaced globally and the sweep completes. */
function reportReclaimError(err: unknown): void {
	const report = (globalThis as { reportError?: (e: unknown) => void }).reportError;
	if (report !== undefined) {
		report(err);
		return;
	}
	const epoch = engineEpoch;
	queueMicrotask(() => {
		if (epoch === engineEpoch) {
			throw err;
		}
	});
}

/**
 * Phase 1 — the finalizer body (also the retry body and the test seam's):
 * verify epoch (registry-closure carried) and tenancy generation (raw Int32
 * equality — wrap-safe), verify every guard, then tear down structure and
 * dispose owned deps. User code never runs here: owned child effects'
 * pending cleanups are extracted into a deferred-cleanup entry and the
 * record's free queues behind it; guard-blocked reclaims file a per-id retry
 * ticket instead (its guard's clearing site re-attempts).
 */
function reclaimNode(id: NodeId, gen: Generation, epoch: number): void {
	if (epoch !== engineEpoch) {
		return; // a dead epoch's callback (the belt behind the registry drop)
	}
	const memory = E.buffer();
	if (memory[id + NodeField.GEN] !== gen) {
		reclaimDropSkip(id, gen); // tenancy moved: this reclaim's target is already gone
		return;
	}
	const flags: NodeFlags = memory[id + NodeField.FLAGS];
	if ((flags & (NodeFlag.K_SIGNAL | NodeFlag.K_COMPUTED)) === 0) {
		reclaimDropSkip(id, gen); // already disposed (free pending at this gen) — nothing to do
		return;
	}
	if (enterDepth !== 0) {
		// Defensive: real FR delivery is task-scheduled (kernel-idle by
		// construction); a mid-frame arrival files itself for the boundary.
		reclaimFileSkip(id, gen, epoch);
		reclaimRetries.push(id);
		if (reclaimWorkPending === false) {
			reclaimWorkPending = true;
		}
		scheduleReclaimNudge();
		return;
	}
	// The guard table. Kernel subs; lifecycle active (the id-keyed active
	// record — the dormant fns-slot callback is column state, not a guard);
	// the registered hook covers watcher-index membership, open-render arena
	// membership, any arena's suspended list, observation retains, and a
	// non-empty write log. Not guards: outgoing deps (disposed below), the
	// machinery-owned bit, the lifecycle marker bit.
	const hook = reclaimGuardHook;
	if (
		memory[id + NodeField.SUBS] !== 0
		|| (lifecycleStates.size !== 0 && lifecycleStates.has(id))
		|| (hook !== undefined && hook(id, memory[id + NodeField.NODE_INDEX]))
	) {
		reclaimFileSkip(id, gen, epoch);
		return;
	}
	reclaimDropSkip(id, gen);
	if (flags & NodeFlag.K_COMPUTED) {
		// Owned child effects' cleanups defer (extracted before the cascade,
		// so the structural teardown's dispose path finds nothing to run).
		const cleanups = collectOwnedCleanups(id);
		E.reclaimStructure(id);
		if (cleanups !== undefined) {
			deferredCleanups.push({ id, gen, cleanups });
			if (reclaimWorkPending === false) {
				reclaimWorkPending = true;
			}
			scheduleReclaimNudge();
			return; // the free queues behind the entry (phase 2 inserts it)
		}
	} else {
		E.reclaimStructure(id);
	}
	pendingFree.push(id); // swept at the boundary (freeNode: GEN bump + column clears + the record-free scrub)
}

/**
 * Extract the pending user cleanups of a dying computed's owned effect
 * subtree (child effects/scopes link as deps of their creator), depth-first
 * in reverse dep order — the order deterministic disposal would have run
 * them. Extraction clears each aux slot, so the structural cascade's dispose
 * path finds no cleanup to run. Returns undefined when none exist (the
 * common shape: plain computeds free without a deferred entry).
 */
function collectOwnedCleanups(id: NodeId): (() => void)[] | undefined {
	let out: (() => void)[] | undefined;
	const memory = E.buffer();
	const walk = (node: NodeId): void => {
		let l = memory[node + NodeField.DEPS_TAIL];
		while (l !== 0) {
			const dep = memory[l + LinkField.DEP];
			const depFlags = memory[dep + NodeField.FLAGS];
			if (depFlags & (NodeFlag.K_EFFECT | NodeFlag.K_SCOPE)) {
				walk(dep); // grandchildren first (dispose runs deps before the own cleanup)
				if (depFlags & NodeFlag.K_EFFECT) {
					const cv: ValueIndex = (dep >> ArenaShape.ID_TO_VALUE_SHIFT) + ArenaShape.AUX_VALUE_OFFSET;
					const cleanup = values[cv];
					if (typeof cleanup === 'function') {
						values[cv] = undefined;
						(out ??= []).push(cleanup as () => void);
					}
				}
			}
			l = memory[l + LinkField.PREV_DEP];
		}
	};
	walk(id);
	return out;
}

/**
 * The boundary drain (phase 2 + retry processing; called from boundaryWork).
 * Retries first — structural only, and their deferred entries join this
 * take. Then take-before-call: the queue swaps for empty, the drain guard
 * sets, taken entries run under reportError isolation, and each record's
 * free-list insertion is the last step per entry. Reentrant boundaries (a
 * cleanup writing an atom re-enters maybeBoundary) find the guard set and do
 * no cleanup work; entries filed during a cleanup land in the fresh queue
 * for the next boundary.
 */
function drainReclaimWork(): void {
	if (reclaimDrainGuard === true) {
		return; // reentrant boundary during a cleanup: the outer drain owns the batch
	}
	reclaimDrainGuard = true;
	try {
		reclaimWorkPending = false;
		while (reclaimRetries.length !== 0) {
			const id = reclaimRetries.pop()!;
			const entry = reclaimSkipped.get(id);
			if (entry !== undefined) {
				reclaimNode(id, entry.gen, entry.epoch);
			}
		}
		if (deferredCleanups.length !== 0) {
			const taken = deferredCleanups;
			deferredCleanups = [];
			for (let i = 0; i < taken.length; i++) {
				const entry = taken[i]!;
				const cleanups = entry.cleanups;
				for (let k = 0; k < cleanups.length; k++) {
					try {
						cleanups[k]!();
					} catch (err) {
						reportReclaimError(err);
					}
				}
				pendingFree.push(entry.id); // free queued last, after this entry's own cleanups
			}
		}
	} finally {
		reclaimDrainGuard = false;
	}
	if (reclaimRetries.length !== 0 || deferredCleanups.length !== 0) {
		// Work filed during the drain (reentrant cleanups): next boundary.
		if (reclaimWorkPending === false) {
			reclaimWorkPending = true;
		}
	}
}

/**
 * Deterministic reclaim seam (test-only): real GC cannot schedule a stale
 * finalizer deterministically, so the id-reuse and stale-epoch probes drive
 * this instead. Defaults simulate a current-tenancy, current-epoch
 * finalizer; pass a stale `gen` or a stale `epoch` to pin the defusing
 * compares. Runs the trailing boundary so phase 2 lands synchronously.
 * @internal
 */
export function __simulateReclaimForTest(id: NodeId, gen?: Generation, epoch?: number): void {
	reclaimNode(id, gen ?? E.buffer()[id + NodeField.GEN], epoch ?? engineEpoch);
	maybeBoundary();
}

/** Reclamation observability (test-only). @internal */
export function __reclaimStatsForTest(): {
	skipped: number;
	retryQueue: number;
	deferredCleanups: number;
	pendingFree: number;
	recNext: RecordId;
	registryPresent: boolean;
} {
	return {
		skipped: reclaimSkipped.size,
		retryQueue: reclaimRetries.length,
		deferredCleanups: deferredCleanups.length,
		pendingFree: pendingFree.length,
		recNext,
		registryPresent: reclaimRegistry !== undefined,
	};
}

/** Runs {@link boundaryWork} iff the stack is at an operation boundary and
 * any deferred work (growth, pending frees, reclamation) is queued. */
export function maybeBoundary(): void {
	if (enterDepth === 0 && (growPending || pendingFree.length !== 0 || reclaimWorkPending === true)) {
		boundaryWork();
	}
}

/**
 * The plain kernel write: the tail of Atom.set/update's standalone fast arm,
 * the internals-less arm of the concurrent dispatch, and the lifecycle
 * context's handle-free path. Lives here, not in the policy layer: every
 * binding it touches per call — values, maybeBoundary, E, batchDepth,
 * flush — is this module's state, and a hot read of a cyclic module's
 * imported binding pays a per-access cell + initialization check that a
 * same-module read doesn't.
 *
 * ## Policy equality
 *
 * `isEqual(current, incoming)` runs once, in kernel argument order, at the
 * acceptance decision: an atom on this path has no concurrent content, so
 * its write history is empty by construction and a write equal to the
 * current pending value simply drops. (An atom with concurrent content
 * dispatches through {@link writeAtomConcurrent} instead, where the same
 * rule applies only while its write log is empty — once history exists,
 * different worlds may fold different values.) The comparator sees the
 * newest (pending) value; the kernel's own identity compare covers the
 * default. The writes-in-computeds policy is asserted by the callers before
 * dispatching here. @internal
 */
export function writeAtom(id: NodeId, isEqual: ((a: unknown, b: unknown) => boolean) | undefined, value: unknown): void {
	if (isEqual !== undefined && isEqual(values[(id >> ArenaShape.ID_TO_VALUE_SHIFT) + ArenaShape.AUX_VALUE_OFFSET], value)) {
		return;
	}
	maybeBoundary();
	if (E.write(id, value) && batchDepth === 0) {
		flush();
	}
}

/** The operation-boundary work: reclamation drain, the pending-free sweep,
 * then growth by closure rebuild. Only {@link maybeBoundary} calls this. */
function boundaryWork(): void {
	// Reclamation work first (the free-path ordering rule):
	// queued guard-cleared retries run their structural phase (feeding
	// pendingFree / the deferred-cleanup queue), then the deferred user
	// cleanups run under the drain guard — each record's free-list insertion
	// is the last step per entry — so the sweep below frees everything this
	// boundary produced. Reentrant boundaries (a cleanup writing an atom)
	// find the drain guard set and skip.
	if (reclaimWorkPending === true) {
		drainReclaimWork();
	}
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
		while (records < desiredRecords || recNext > Math.min((records * ArenaShape.STRIDE) >> ArenaShape.HALF_ARENA_SHIFT, (records - ArenaShape.REC_SLACK) * ArenaShape.STRIDE)) {
			records *= 2;
		}
		if (records !== E.records) {
			E = createKernel(records, E.buffer(), E.clocks());
		}
	}
}

/**
 * Drains the effect queue, running each queued effect through the op table;
 * a throw re-arms the rest via requeueAbort so no queued effect is lost.
 *
 * Boundary-lite: growth/reclamation runs only before the flush loop, not
 * between effects. Safe because (a) all user code during flush runs at
 * enterDepth >= 1, so E cannot be swapped mid-loop (the `kernel` hoist is
 * sound), and (b) the watermark guarantees at least ArenaShape.REC_SLACK
 * (1280) free records at flush start while cascade re-runs re-track through
 * the link() fast path / free lists (net new records per flush audited at
 * ~tens across the conformance suite and benchmark workloads; a pathological
 * cascade that out-allocates the whole remaining arena throws in the
 * allocator rather than corrupting in-flight walks).
 */
export function flush(): void {
	maybeBoundary();
	const kernel = E;
	const queue = queued; // function-scope alias survives bundling (see createKernel note)
	try {
		while (notifyIndex < queuedLength) {
			const e = queue[notifyIndex];
			queue[notifyIndex++] = 0;
			kernel.run(e);
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

function throwFold(): never {
	throw new Error(
		'cosignals: signal reads and writes are not allowed inside an update() updater or a reducer — read before dispatch instead.',
	);
}

// The poison table's operations (hoisted: referenced when POISON is built at
// module init). Every op throws the fold-purity error; requeueAbort no-ops.
function foldPoisonOp(): never {
	throwFold();
}

function foldNoop(): void {}

/**
 * Defers effect flushing to the batch's close. Nothing else: no implicit
 * grouping of any kind exists anywhere in the library.
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

// ---- mechanism halves of the policy layer's runFold and configure ----------------
// (the policy bodies — the fold-purity rule, the configure validation — stay
// in index.ts; these are the kernel-state mutations they need, exported as
// functions because ESM importers cannot assign another module's bindings.)

/** Swap the operation table to the fold-purity POISON table; returns the
 * live table for the paired restore (index.ts runFold's bracket). */
export function foldGuardSwap(): Kernel {
	const saved = E;
	E = POISON;
	return saved;
}

export function foldGuardRestore(saved: Kernel): void {
	E = saved;
}

/** Raise the capacity floor to `units` configured units (one node + two link
 * records each) and schedule growth at the next operation boundary — the
 * kernel half of configure({ initialRecords }). Never shrinks. */
export function requestCapacity(units: RecordCount): void {
	const target = units * ArenaShape.RECORDS_PER_UNIT;
	if (target > desiredRecords) {
		desiredRecords = target;
	}
	if (E.records < desiredRecords) {
		growPending = true;
		maybeBoundary();
	}
}

/**
 * Direct newest apply — the plain write tail (equality-drop-free: the caller
 * has already made the acceptance decision and folded the operation to a
 * plain value), used by the concurrent machinery's quiet fold and eager
 * apply. The policy comparator does not run here (`isEqual(current,
 * incoming)` is invoked exactly once, at the acceptance decision —
 * re-running it inside the apply would double-invoke it); the kernel's own
 * identity store-compare still gates propagation. Effects flushed here
 * re-enter the public write path and classify normally — there is no
 * recursion guard because this tail never re-enters the public methods
 * itself.
 */
export function writeNewest(id: NodeId, value: unknown): void {
	maybeBoundary();
	if (E.write(id, value) && batchDepth === 0) {
		flush();
	}
}

// ---- the test reset's kernel half (test-only) -----------------------------------

/**
 * Kernel idle preconditions for `__resetEngineForTest` — a reset from inside
 * any live kernel frame would corrupt the next test instead of failing this
 * one. @internal
 */
export function __assertKernelIdleForReset(): void {
	if (enterDepth !== 0) throw new Error('cosignals: __resetEngineForTest inside an open kernel frame (enterDepth !== 0)');
	if (batchDepth !== 0) throw new Error('cosignals: __resetEngineForTest inside batch() (batchDepth !== 0)');
	if (runDepth !== 0) throw new Error('cosignals: __resetEngineForTest inside an effect run');
	if (queuedLength !== notifyIndex) throw new Error('cosignals: __resetEngineForTest with queued effects unflushed');
	if (E === POISON) throw new Error('cosignals: __resetEngineForTest inside a fold-purity frame');
	if (reclaimDrainGuard === true) throw new Error('cosignals: __resetEngineForTest inside the deferred-cleanup drain (a reclaimed record\'s user cleanup is on the stack)');
}

/**
 * The kernel scrub (test-only): zero the used arena range and every
 * allocator head/counter, drop the side columns to their burned seeds —
 * never a reallocation (the arena keeps any grown capacity; the live
 * operation table stays valid because it closes over the same buffer).
 * Bumps the reset epoch, which every cross-reset microtask consults. The
 * caller (`__resetEngineForTest`) owns ordering: driver protocol reset
 * first, then this, then the concurrent machinery's recomposition.
 * @internal
 */
export function __resetKernelForTest(): void {
	__assertKernelIdleForReset();
	engineEpoch++;
	E.buffer().fill(0, 0, recNext); // watermark-bounded: only the used range holds records
	recNext = ArenaShape.STRIDE; // record 0 stays burned
	nextNodeIndex = 1; // index 0 stays burned
	nodeFreeHead = 0;
	linkFreeHead = 0;
	growPending = false;
	cycle = 0;
	notifyIndex = 0;
	queuedLength = 0;
	activeSub = 0;
	queued.length = 0;
	pendingFree.length = 0;
	// Side columns: stale values, wrapper/effect closures, and clock stamps
	// must not survive id reuse (generated — every declared column resets).
	resetSideColumnsForTest(E.clocks());
	clockSource = 0;
	// Walk scratch: stack contents are per-walk, but a reset mid-diagnosis
	// must not leave stale cursors.
	propSp = 0;
	checkSp = 0;
	// configure({initialRecords}) is per-instance tuning, so it resets too:
	// the floor returns to the process default.
	desiredRecords = initialRecords * ArenaShape.RECORDS_PER_UNIT;
	routingActive = false;
	// Reclamation scrub: drop the old per-epoch registry — an unreachable
	// registry's pending callbacks are never delivered (mass cancellation),
	// and any callback extracted before the drop no-ops on its closure epoch
	// compare (bumped above). The skip map, retry queue, and deferred-cleanup
	// queue die with the epoch (their tickets carry it and would defuse
	// anyway).
	reclaimRegistry = makeReclaimRegistry();
	reclaimSkipped.clear();
	reclaimSkippedN = 0;
	reclaimRetries.length = 0;
	deferredCleanups = [];
	reclaimWorkPending = false;
}

// ---- the computed evaluation policy (exceptions and suspense) --------------------

/**
 * SUSPENSE and the computed evaluation policy — what happens when a computed
 * evaluation cannot produce a plain value. A computed's function can throw,
 * or it can read async data that is not ready yet (`ctx.use` on a pending
 * thenable — a SUSPENSION). Rather than make every caller handle those
 * cases, the engine stores the RAW payload of what happened — the thrown
 * value, or the pending thenable — in the slot where the value would have
 * gone (the `values` side column) and marks the outcome in the node's flags
 * (NodeFlag.HAS_BOX, plus BOX_SUSPENDED for suspensions). This section owns
 * both halves of that story:
 *
 *  - the WRITE half, called from the kernel's two cold catch sites:
 *    `storeThrown` (store the payload, return the outcome bits, attach the
 *    settle listener on transition) and `attachSettleListener` (stale-guarded
 *    settlement-invalidate: when the pending thenable settles, the computed
 *    is marked stale exactly the way a dependency write would);
 *  - the READ half: `boxedRead`, the kernel's cold read tail — errors
 *    rethrow, settled suspensions self-heal, pending suspensions throw the
 *    thenable's stable `SuspendedRead` sentinel (declared here);
 *  - the EVALUATION CONTEXT's members: `ctxPrevious` and `ctxUse`, the
 *    hoisted functions behind the one `ctx` object the kernel passes every
 *    computed getter ({@link POLICY_CTX}), with the thenable protocol
 *    (`unwrapThenable`, mirroring React's trackUsedThenable), the per-node
 *    keyed request cache (`__ctxUse`, shared with the concurrent machinery's
 *    ctx-shaped world fns), and the key serialization;
 *  - the settle TAP seam (`__setSettleTap`): the concurrent machinery's hook
 *    into thenable settlement, consulted by the per-thenable shared
 *    listener at fire time.
 *
 * Everything here is COLD by design: reads route on the kernel's HAS_BOX
 * flag (never `instanceof` on a hot path), and a computed that never throws
 * or suspends never reaches this section.
 */

/**
 * Thrown when a read observes a pending suspension: by `ctx.use` inside a
 * computed evaluation, and by read sites whose computed's cached result is a
 * suspended box. Carries the pending thenable. (The React bindings
 * (`cosignals-react`) catch it at render read sites and forward it to
 * Suspense.)
 */
export class SuspendedRead {
	readonly thenable: PromiseLike<unknown>;
	constructor(thenable: PromiseLike<unknown>) {
		this.thenable = thenable;
	}
}

// Exceptional-outcome detection never uses `instanceof` on a hot path
// (measured ~9ns per `instanceof` there — 2.4× on read-heavy workloads).
// Reads route on the kernel's HAS_BOX flag; the policy-side filters
// (ctx.previous, the isEqual wrapper) test the same flag bits, which the
// eval-start rewrite deliberately PRESERVES while the getter runs so the
// residual slot payload can be told apart from a plain previous value.

// ---- the computed evaluation policy --------------------------------------------

type InstrumentedThenable = PromiseLike<unknown> & {
	status?: 'pending' | 'fulfilled' | 'rejected';
	value?: unknown;
	reason?: unknown;
	/** The thenable's stable SuspendedRead, created lazily at the first read
	 * that observes it pending — every read site throws THIS instance while
	 * the thenable is pending, so observers can dedupe by identity. */
	suspendSentinel?: SuspendedRead;
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
export function ctxPrevious(): unknown {
	const c = activeSub;
	if (c === 0) {
		return undefined;
	}
	if ((E.buffer()[c + NodeField.FLAGS]! & (NodeFlag.K_COMPUTED | NodeFlag.HAS_BOX)) !== NodeFlag.K_COMPUTED) {
		return undefined;
	}
	return values[c >> ArenaShape.ID_TO_VALUE_SHIFT];
}

/**
 * The canonical thenable protocol (mirrors React's trackUsedThenable):
 * instrument `status`/`value`/`reason` onto the thenable itself, once.
 * Settled thenables synchronously return their value / throw their reason;
 * pending ones throw the thenable's stable SuspendedRead (a lazy expando on
 * the thenable, so every read site and every re-evaluation observes one
 * "still pending" identity per thenable).
 */
function unwrapThenable(t: InstrumentedThenable): unknown {
	switch (t.status) {
		case 'fulfilled':
			return t.value;
		case 'rejected':
			throw t.reason;
		case 'pending':
			throw (t.suspendSentinel ??= new SuspendedRead(t));
		default: {
			t.status = 'pending';
			t.then(
				(v: unknown) => {
					if (t.status === 'pending') {
						t.status = 'fulfilled';
						t.value = v;
						// Settle tap: consulted at FIRE time, never captured at
						// instrument time — a thenable instrumented under an
						// earlier engine composition still notifies the current
						// one (test resets re-compose the engine).
						const tap = settleTap;
						if (tap !== undefined) tap(t);
					}
				},
				(e: unknown) => {
					if (t.status === 'pending') {
						t.status = 'rejected';
						t.reason = e;
						const tap = settleTap;
						if (tap !== undefined) tap(t);
					}
				},
			);
			throw (t.suspendSentinel ??= new SuspendedRead(t));
		}
	}
}

/**
 * The concurrent engine's settle tap. The kernel's per-thenable shared
 * listener — the pair `unwrapThenable` installs exactly once per thenable —
 * calls it after the status write, so world-only suspensions (arena-cached
 * sentinels the kernel never cached) are notified AT the settlement event
 * itself. One closure per engine composition; distinct-thenable dedup is
 * the instrument-once discipline. The kernel-cached path (`attachSettleListener` →
 * stale-guarded `invalidateComputed`) is untouched and keeps handling
 * KERNEL suspensions precisely.
 */
let settleTap: ((t: PromiseLike<unknown>) => void) | undefined;

/** Installs/clears the settle tap (engine seam, set at composition). @internal */
export function __setSettleTap(fn: ((t: PromiseLike<unknown>) => void) | undefined): void {
	settleTap = fn;
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
		'cosignals: ctx.use keys must be strings, numbers, booleans, null, or arrays of those — '
			+ `got ${typeof key}. Put the serializable inputs in the key and close over the rest in the factory.`,
	);
}

/**
 * The ctx.use request-cache column — id-keyed engine state. The owning
 * `Computed` INSTANCE is stored nowhere kernel-side, so nothing here pins
 * the handle and a dropped handle's record can still reclaim. Keyed by
 * NODE INDEX (the recycled dense key): the record-free scrub clears the
 * freed record's entry (`__clearUseCacheForIndex`), so a slot's next
 * tenant can never be served the previous tenant's requests. A Map (not a
 * dense array) deliberately — ctx.use is a cold path and the map's delete
 * is the scrub.
 */
const useCaches = new Map<number, Map<string, PromiseLike<unknown>>>();

/** The record-free scrub's suspense half (called by the engine's record-free
 * hook): drop the freed record's request cache. @internal */
export function __clearUseCacheForIndex(nodeIndex: number): void {
	useCaches.delete(nodeIndex);
}

/** Test-only (`__resetEngineForTest`): every request cache drops. @internal */
export function __resetSuspenseForTest(): void {
	useCaches.clear();
}

/** Test seam: a record's ctx.use request cache, by node index (the leak
 * audit probes clearing at record free). @internal */
export function __useCacheForTest(nodeIndex: number): Map<string, PromiseLike<unknown>> | undefined {
	return useCaches.get(nodeIndex);
}

/**
 * The two-form ctx.use dispatch over a node-index-keyed request cache — the
 * ONE suspense implementation, shared with the engine's ctx-shaped world
 * fns (which pass their node's index). See ComputedCtx.use for the
 * contract. The keyed cache is monotone per node: same key ⇒ same thenable
 * for the node's lifetime — including across worlds, which is safe exactly
 * because the key carries the world-varying inputs (a request cache never
 * un-learns an answer; a world that asks a different question uses a
 * different key). Entries evaporate at the record's free (the scrub above).
 * @internal — engine seam, not public API.
 */
export function __ctxUse(
	nodeIndex: number,
	sourceOrKey: unknown,
	factory: (() => PromiseLike<unknown>) | undefined,
): unknown {
	if (factory === undefined) {
		const t = sourceOrKey as InstrumentedThenable;
		if (t === null || (typeof t !== 'object' && typeof t !== 'function') || typeof t.then !== 'function') {
			throw new Error(
				typeof sourceOrKey === 'function'
					? 'cosignals: the bare factory form ctx.use(fn) was removed — pass ctx.use(key, factory) so the request is cached per key, or cache the promise yourself and pass ctx.use(promise).'
					: 'cosignals: ctx.use takes a thenable, or (key, factory).',
			);
		}
		return unwrapThenable(t);
	}
	if (typeof factory !== 'function') {
		throw new Error('cosignals: ctx.use(key, factory) requires a factory function.');
	}
	const k = serializeUseKey(sourceOrKey);
	let cache = useCaches.get(nodeIndex);
	if (cache === undefined) {
		cache = new Map();
		useCaches.set(nodeIndex, cache);
	}
	let t = cache.get(k) as InstrumentedThenable | undefined;
	if (t === undefined) {
		t = factory() as InstrumentedThenable;
		if (t === null || (typeof t !== 'object' && typeof t !== 'function') || typeof t.then !== 'function') {
			throw new Error('cosignals: the ctx.use factory must return a thenable.');
		}
		cache.set(k, t);
	}
	return unwrapThenable(t);
}

/**
 * ctx.use (hoisted; called from POLICY_CTX): resolve the evaluating
 * COMPUTED RECORD from the kernel's `activeSub` — id-keyed, no instance
 * lookup (the old aux-slot owner backref died at the merge; nothing pins
 * the handle) — and dispatch on its node index. The per-key cache lives
 * with the record and dies at its free — a recreated node refetches, which
 * is React's own uncached-promise story; callers needing cross-death dedup
 * cache the promise in their data layer and use the one-arg form.
 */
export function ctxUse(sourceOrKey: unknown, factory: (() => PromiseLike<unknown>) | undefined): unknown {
	const c = activeSub;
	if (c === 0 || (E.buffer()[c + NodeField.FLAGS]! & NodeFlag.K_COMPUTED) === 0) {
		throw new Error('cosignals: ctx.use may only be called during a computed evaluation.');
	}
	return __ctxUse(E.buffer()[c + NodeField.NODE_INDEX]!, sourceOrKey, factory);
}

/**
 * The kernel's exception hook, cold: stores whatever a computed
 * evaluation threw as the RAW cached payload — the thrown value for an
 * error, the pending thenable for a suspension — and returns the exceptional
 * flag bits for the outcome. The caller folds the bits into the node's flags
 * and into its change cutoff: same payload + same bits ⇒ no change; any
 * delta ⇒ propagate. The settle listener is attached only on TRANSITION
 * (the previous outcome was not a suspension, or suspended on a different
 * thenable), so re-suspending on the same pending thenable stays
 * listener-stable.
 */
export function storeThrown(c: NodeId, e: unknown, oldValue: unknown, oldExc: NodeFlags): NodeFlags {
	const v: ValueIndex = c >> ArenaShape.ID_TO_VALUE_SHIFT;
	if (e instanceof SuspendedRead) {
		const t = e.thenable as InstrumentedThenable;
		values[v] = t;
		if ((oldExc & NodeFlag.BOX_SUSPENDED) === 0 || oldValue !== t) {
			attachSettleListener(c, t);
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
 * as a suspension (suspended bit set and the slot holds `t`) — so
 * out-of-order settlement of superseded work is inert.
 */
function attachSettleListener(c: NodeId, t: InstrumentedThenable): void {
	// ENGINE-EPOCH GUARD (cross-reset microtask discipline): the listener
	// captures the epoch at attach; a settlement delivered after
	// `__resetEngineForTest` must not touch the scrubbed arena (the record
	// id may already belong to a new tenant). Belt and suspenders: the
	// stale-guard below is ALSO inert post-reset — the scrubbed record's
	// flags read 0 and the values column no longer holds the thenable.
	const epoch = engineEpoch;
	const onSettle = (): void => {
		if (epoch !== engineEpoch) {
			return; // a dead test's settlement — the engine it targeted is gone
		}
		if (
			(E.buffer()[c + NodeField.FLAGS]! & NodeFlag.BOX_SUSPENDED) === 0
			|| values[c >> ArenaShape.ID_TO_VALUE_SHIFT] !== t
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
			// Epoch-guarded like every cross-reset microtask: a reset between
			// the throw and the rethrow swallows it (the erroring test is
			// already over; rethrowing into the next test would misattribute).
			queueMicrotask(() => {
				if (epoch !== engineEpoch) return;
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
 * suspensions throw the thenable's stable SuspendedRead (created lazily on
 * it). The self-heal re-read recurses through the kernel tail at most once
 * more: a payload stored during the recursion necessarily carries a thenable
 * that was pending at creation, which throws — settlement cannot occur inside
 * this synchronous frame.
 */
export function boxedRead(c: NodeId, flags: NodeFlags): unknown {
	const v: ValueIndex = c >> ArenaShape.ID_TO_VALUE_SHIFT;
	if ((flags & NodeFlag.BOX_SUSPENDED) === 0) {
		throw values[v];
	}
	const t = values[v] as InstrumentedThenable;
	if (t.status === undefined || t.status === 'pending') {
		throw (t.suspendSentinel ??= new SuspendedRead(t));
	}
	E.invalidateComputed(c);
	const next = E.computedRead(c);
	if (batchDepth === 0) {
		flush();
	}
	return next;
}

// ---- the observed lifecycle (AtomOptions.effect) ---------------------------------

/**
 * The observed lifecycle (AtomOptions.effect): the "first subscriber
 * attached / last one detached" callback an atom can carry, counted over
 * the union of consumer kinds — kernel subscribers (live computed chains,
 * core effect()s: one ref per non-machinery kernel link to the atom, fed by
 * the kernel's linkInsert/unlink through
 * `retainLifecycle`/`releaseLifecycle`) and watchers (subscribed UI
 * components: one ref per live watcher, fed by the concurrent machinery's
 * observation index through `__lifecycleRetain`/`__lifecycleRelease`). The
 * effect runs on the union's 0→1 transition and the cleanup on its 1→0;
 * both run through a microtask queue so observe/unobserve flaps within one
 * tick coalesce to nothing regardless of which consumer kind produced them
 * (StrictMode double-mount netting, watcher claim/debounced-unsub, remount
 * handoffs). Atoms without the effect option never enter the state map, and
 * the kernel hot paths stay gated on the record's LIFECYCLE field —
 * the plain path pays nothing.
 *
 * Id-keyed and handle-free (so a record whose public handle was
 * garbage-collected can still be reclaimed — see the reclamation section
 * below):
 *  - The dormant owner: the user's callback is stored in the atom's own
 *    record `fns` column slot at construction (index.ts — atoms never use
 *    that slot; it is arena-side memory addressed by id, cleared by the
 *    record-free path like every column). No map entry exists while
 *    dormant.
 *  - Rehydration: a watched transition on a lifecycle-flagged record with
 *    no active entry reads the callback from the fns slot and creates a
 *    fresh active record (this map's entry) — held strongly exactly while
 *    the lifecycle is active (watched, or with a pending flap-damped
 *    shift): an atom with an active lifecycle effect is observable
 *    machinery whose cleanup must run at unmount regardless of handle
 *    reachability.
 *  - Dormancy: when the cleanup has run and no shift is pending, the
 *    active entry deletes — releasing the context and any pending cleanup.
 *    (That deletion site is also reclamation's retry trigger for lifecycle
 *    atoms — see maybeDropDormant.)
 *  - The active context routes state/set/update by id through the policy
 *    write path ({@link lifecycleWritePath}, installed by index.ts at
 *    composition) — no handle reference is ever stored; the callback pins
 *    only what the user's closure captures, exactly as long as the record
 *    lives.
 */

export type LifecycleState = {
	/** The atom's record id (the map key, carried for the dormancy delete). */
	id: NodeId;
	effect: (ctx: AtomCtx<unknown>) => void | (() => void);
	ctx: AtomCtx<unknown>;
	cleanup: (() => void) | undefined;
	/** Union refcount: one per live non-machinery kernel link + one per
	 * live watcher. */
	refs: number;
	/** Desired state as of the last union transition (refs > 0). */
	wantMounted: boolean;
	/** Actual state (effect has run and not been cleaned up). */
	isMounted: boolean;
	scheduled: boolean;
};

/** Active lifecycle records by id (watched, or with a pending shift) — see
 * the module header for the dormant/active/rehydration story. */
export const lifecycleStates = new Map<NodeId, LifecycleState>();
let lifecycleQueue: LifecycleState[] = [];
let lifecycleFlushScheduled = false;

/** Test-only (`__resetEngineForTest`): drop every active record and the
 * queue; the scheduled flush (if any) is engine-epoch guarded and goes
 * inert. @internal */
export function __resetLifecycleForTest(): void {
	lifecycleStates.clear();
	lifecycleQueue = [];
	// lifecycleFlushScheduled stays as-is: the pending microtask (if one is
	// in flight) clears it when it fires and bails on the epoch guard.
}

function scheduleLifecycleFlush(): void {
	if (lifecycleFlushScheduled) {
		return;
	}
	lifecycleFlushScheduled = true;
	// Engine-epoch guard (cross-reset microtask discipline): a flush
	// scheduled by a dead test must not run user effects into the next
	// test's engine.
	const epoch = engineEpoch;
	queueMicrotask(() => {
		lifecycleFlushScheduled = false;
		if (epoch !== engineEpoch) {
			return;
		}
		const queue = lifecycleQueue;
		lifecycleQueue = [];
		for (const state of queue) {
			state.scheduled = false;
			if (state.wantMounted === state.isMounted) {
				maybeDropDormant(state);
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
				maybeDropDormant(state);
			}
		}
	});
}

/** The dormancy transition: cleanup ran (or the flap netted out), nothing
 * pending — the active record deletes; the dormant owner (the fns-slot
 * callback) is all that remains. */
function maybeDropDormant(state: LifecycleState): void {
	if (state.refs <= 0 && !state.isMounted && !state.scheduled) {
		lifecycleStates.delete(state.id);
		// Reclamation retry trigger — the lifecycle-active guard row's
		// clearing site is exactly this deletion (cleanup ran, no pending
		// shift). Size-0 bail first.
		if (reclaimSkippedN !== 0) noteReclaimRetry(state.id);
	}
}

/**
 * The lifecycle context's write path — the policy layer's id-keyed write
 * (policy assert, then the concurrent dispatch or the plain fold + write),
 * installed by index.ts at composition. Late-bound so the engine never
 * imports the policy module at runtime (the write path reads policy state —
 * the writes-in-computeds flag, the engine internals registry — that lives
 * with the policy layer); a composition seam, cold (lifecycle contexts write
 * only inside user lifecycle effects).
 */
let lifecycleWritePath: ((id: NodeId, kind: 0 | 1, payload: unknown) => void) | undefined;

/** Installs the lifecycle write path (index.ts, at module initialization). @internal */
export function __setLifecycleWritePath(fn: (id: NodeId, kind: 0 | 1, payload: unknown) => void): void {
	lifecycleWritePath = fn;
}

/** Dispatch one lifecycle-context write through the installed policy path. */
function dispatchLifecycleWrite(id: NodeId, kind: 0 | 1, payload: unknown): void {
	const write = lifecycleWritePath;
	if (write === undefined) {
		// Unreachable through the public entry (index.ts installs the path in
		// its module body, before any user code can construct an atom).
		throw new Error('cosignals: lifecycle write before the policy layer composed.');
	}
	write(id, kind, payload);
}

/** The active context — built at rehydration, id-keyed, handle-free (see
 * the section header). */
function createLifecycleContext(id: NodeId): AtomCtx<unknown> {
	return {
		get state(): unknown {
			return untracked(() => E.readAtom(id));
		},
		set(value: unknown): void {
			dispatchLifecycleWrite(id, 0, value);
		},
		update(fn: (current: unknown) => unknown): void {
			dispatchLifecycleWrite(id, 1, fn);
		},
	};
}

function shiftLifecycleCount(id: NodeId, delta: -1 | 1): void {
	let state = lifecycleStates.get(id);
	if (state === undefined) {
		if (delta < 0) {
			return; // release without an active record: dormant already
		}
		// Rehydration: read the dormant owner off the record's fns slot. A
		// watched transition can only arrive for a live record (observation
		// is a tracked read, which is handle-mediated). Gate on the record's
		// LIFECYCLE field — only atoms constructed with the effect option
		// carry it, so a computed's getter in the same fns column can never
		// masquerade as a lifecycle callback.
		if (E.buffer()[id + NodeField.LIFECYCLE] === 0) {
			return; // no lifecycle effect on this record
		}
		const fn = fns[id >> ArenaShape.ID_TO_FN_SHIFT];
		if (typeof fn !== 'function') {
			return; // dormant owner already cleared (record freed mid-flight)
		}
		state = {
			id,
			effect: fn as (ctx: AtomCtx<unknown>) => void | (() => void),
			ctx: createLifecycleContext(id),
			cleanup: undefined,
			refs: 0,
			wantMounted: false,
			isMounted: false,
			scheduled: false,
		};
		lifecycleStates.set(id, state);
	}
	state.refs += delta;
	const wantMounted = state.refs > 0;
	if (state.wantMounted === wantMounted) {
		if (!wantMounted) maybeDropDormant(state);
		return; // interior transition (1↔2, …): the union's edge did not move
	}
	state.wantMounted = wantMounted;
	if (!state.scheduled) {
		state.scheduled = true;
		lifecycleQueue.push(state);
		scheduleLifecycleFlush();
	}
}

/**
 * The kernel's arm of the observed-lifecycle union — hoisted function
 * declarations because the kernel calls them from linkInsert/unlink. Each
 * call moves the union refcount by one link's worth: retainLifecycle fires
 * for every new non-machinery link to a lifecycle-flagged dep (the union's
 * 0→1 edge schedules the user's flap-damped effect), releaseLifecycle for
 * every such link removed (the union count hitting zero schedules the
 * flap-damped cleanup).
 */
export function retainLifecycle(id: NodeId): void {
	shiftLifecycleCount(id, 1);
}

export function releaseLifecycle(id: NodeId): void {
	shiftLifecycleCount(id, -1);
}

/**
 * Watcher retain/release — the second consumer kind feeding the
 * observation union (the first is the kernel's per-link arm above). Called
 * by the observation index when a watcher over an atom's node flips live; a
 * no-op for atoms carrying no observed-lifecycle effect. Direct callbacks
 * only — observation transitions are not TraceEvents and never enter the
 * trace stream. @internal
 */
export function __lifecycleRetain(id: NodeId): void {
	shiftLifecycleCount(id, 1);
}

/** @internal */
export function __lifecycleRelease(id: NodeId): void {
	shiftLifecycleCount(id, -1);
}
