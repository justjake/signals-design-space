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
 *   8. World arenas — the per-world value/invalidation/routing layer
 *      (shadow records, arena walks, claim/release, observer clocks).
 *   9. Observer records — watchers and subscriptions as kernel records
 *      with column storage (the handle classes are lean references).
 *  10. Committed observers — the subscription lifecycle and the boundary
 *      re-check (the at-least-once clock rule).
 *  11. Render integration — render passes, the watcher lifecycle, per-root
 *      commit lock-in, and mount fixup.
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

import { CycleError, InvariantViolation, ScheduleError, getOrThrow } from './errors.js';
import type { AtomCtx, ComputedCtx, UseKey } from './index.js';
// Type-only composition imports (erased at emit — the engine never imports
// the policy or machinery modules at runtime): the world-arena and observer
// sections' factories sign themselves against the engine core record and
// the machinery's entity types while those still live in their pre-merge
// modules.
import type { EngineCore, World } from './World.js';
import type { AnyInternals, ArenaInitInts, AtomInternals, ComputedInternals, CommitGen, Equals, Reader, RenderPassId, RootId, Seq, SubscriptionId, Value, WatcherId } from './concurrent.js';
import type { Batch, BatchId, BatchSlotSet } from './Batch.js';
import type { ObservationIndex } from './ObservationIndex.js';

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

// #region GENERATED — layout v5 (from tools/schema.ts; run `pnpm gen`) — DO NOT EDIT
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
 * Field offsets within a WATCHER record — one subscribed component
 * instance, stored as a kernel arena record (allocated by the node
 * allocator: same free list, same GEN tenancy stamp, same side-column
 * scrub — see ALLOCATOR_FAMILIES in tools/schema.ts). A watcher record
 * carries no kernel dependency links, so the kernel walks never reach
 * it; the engine interprets slots 0-4 and 6, while slots 1/5/7 keep
 * their allocator meanings (free-list thread / GEN / NODE_INDEX). The
 * mutable watcher state lives here and in the side columns (values:
 * last rendered value; clocks: lastValidatedAt; extras: name, root, and
 * the rendered-world snapshot); the Watcher handle object holds only
 * the record id and the monotone watcher id (delivery order).
 */
export const enum WatcherField {
	/** Kind + observer-state bits (NodeFlag.K_WATCHER, NodeFlag.OBSERVER_LIVE). */
	FLAGS = 0,
	/** Allocator-owned: the node free list threads here while the record is freed (0 while live — watcher records hold no dependency links). */
	FREE_NEXT = 1,
	/** The watched node record id (the component reads this node). */
	NODE = 2,
	/** The watched record's tenancy generation (kernel GEN) at mount: record ids recycle, so every watcher→node resolution generation-checks this stamp and skips loudly on mismatch. */
	NODE_GEN = 3,
	/** Per-(watcher, slot) delivery dedup bits, one int word (bit i = batch slot i): a second write in the same slot delivers again only if no scheduled-but-unstarted render will fold it anyway. */
	DEDUP_BITS = 4,
	/** Allocator-owned tenancy generation (shared meaning with NodeField.GEN): bumped when the record frees. */
	GEN = 5,
	/** The watched record's NODE_INDEX, cached at mount. Slot-tied like every node index (a record slot keeps its index across tenants), so the cache never goes stale — the NODE_GEN stamp is what decides whether the watched TENANCY is still alive. */
	NODE_IX = 6,
	/** Allocator-owned dense per-record ordinal (shared meaning with NodeField.NODE_INDEX); watcher records consume ordinals but no dense column stores rows for them. */
	NODE_INDEX = 7,
}

/**
 * Field offsets within a SUBSCRIPTION record — one committed observer
 * (the production useSignalEffect mechanism), stored as a kernel arena
 * record by the node allocator exactly like watcher records (see
 * WatcherField). Its dependency snapshot is a chain of world-arena
 * link records in the committed arena of the subscription's root
 * (DEP_HEAD/DEP_TAIL below thread it), each carrying the observer's
 * lastValidatedAt stamp in the arena's per-record clock column. The
 * side columns carry: fns — the adapter-registered refire callback
 * (the dormant-callback pattern); extras — the subscription's cold
 * record object (name, root, the dep-node array in read order, the
 * retained observation set, the test-configured body, the last
 * captured value, and the run/cleanup counters — the counters are
 * tombstone diagnostics the suites may read after removal, so the
 * handle keeps the object reference while the column slot scrubs at
 * free). The values slots stay empty on purpose.
 */
export const enum SubscriptionField {
	/** Kind + observer-state bits (NodeFlag.K_SUBSCRIPTION, NodeFlag.OBSERVER_LIVE). */
	FLAGS = 0,
	/** Allocator-owned: the node free list threads here while the record is freed (0 while live). */
	FREE_NEXT = 1,
	/** First dependency link of the current snapshot — a link record in the root's committed WORLD arena (cross-arena reference: the subscription record lives in the kernel arena, its dep chain in the world arena; 0 = empty snapshot). */
	DEP_HEAD = 2,
	/** Last dependency link of the current snapshot (append cursor; 0 = empty). */
	DEP_TAIL = 3,
	/** Allocator-owned tenancy generation (shared meaning with NodeField.GEN). */
	GEN = 5,
	/** Allocator-owned dense per-record ordinal (shared meaning with NodeField.NODE_INDEX); subscription records consume ordinals but no dense column stores rows for them. */
	NODE_INDEX = 7,
}

/**
 * Bit values of a node's FLAGS field (upstream ReactiveFlags + HasChildEffect
 * + kind bits). A flags word is an OR of these (see `type NodeFlags`).
 */
export const enum NodeFlag {
	/** Can produce new values (signals, computeds). */
	MUTABLE = 0b00000000000000001,
	/** Wants notification when possibly stale (effects, scopes). */
	WATCHING = 0b00000000000000010,
	/** Currently evaluating (re-entrancy guard). */
	RECURSED_CHECK = 0b00000000000000100,
	/** A re-entrant write reached this node during its own run. */
	RECURSED = 0b00000000000001000,
	/** Definitely stale. */
	DIRTY = 0b00000000000010000,
	/** Possibly stale — verify by pulling before recomputing. */
	PENDING = 0b00000000000100000,
	/** Dep list contains child effects/scopes (slow-path cleanup). */
	HAS_CHILD_EFFECT = 0b00000000001000000,
	/** Kind: writable signal record (an Atom or ReducerAtom handle). */
	K_SIGNAL = 0b00000000010000000,
	/** Kind: computed. */
	K_COMPUTED = 0b00000000100000000,
	/** Kind: effect. */
	K_EFFECT = 0b00000001000000000,
	/** Kind: effect scope. */
	K_SCOPE = 0b00000010000000000,
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
	HAS_BOX = 0b00000100000000000,
	/**
	 * Refines HAS_BOX (never set without it): the payload is a pending
	 * thenable, not a thrown error.
	 */
	BOX_SUSPENDED = 0b00001000000000000,
	/**
	 * Serves the observed-lifecycle feature (AtomOptions.effect): an atom
	 * can carry a callback that runs when its FIRST observer arrives and a
	 * cleanup that runs when its LAST observer leaves — say, an atom whose
	 * effect connects a websocket while anyone watches. The lifecycle is
	 * driven by a refcount fed from kernel dependency links: each link into
	 * a lifecycle-carrying atom retains, each unlink releases (the
	 * {@link NodeField.LIFECYCLE}-gated sites in linkInsert/unlink).
	 *
	 * ## The problem this bit solves
	 *
	 * The engine itself reads user atoms as bookkeeping — world folds
	 * evaluating render/committed values, subscription dependency
	 * revalidation, the test surface — and those reads create kernel
	 * dependency links whose READER is an engine-internal record. Unmarked,
	 * they would count as observation: the websocket would connect because
	 * a render pass folded a value, with no component watching at all.
	 *
	 * ## The rule
	 *
	 * The flag is set on engine-created reader records (the
	 * markMachineryOwned op, applied when a computed gains
	 * concurrent-machinery content) and NEVER on user-created nodes. The
	 * lifecycle refcount sites skip links whose reader carries it:
	 * machinery reads do not count as observation. The machinery reports
	 * real consumers into the atom's observation union on its own terms
	 * instead (the observation index), so lifecycle truth follows actual
	 * watchers, never engine plumbing.
	 *
	 * The bit is permanent for the record's life, so every flag-word
	 * rewrite preserves it (the eval-start rewrite, the unwatched reset,
	 * the dirty promotions all mask it through).
	 */
	MACHINERY_OWNED = 0b00010000000000000,
	/**
	 * Kind: watcher record (one subscribed component instance — see
	 * WatcherField). Engine-interpreted: watcher records carry no kernel
	 * dependency links, so no kernel walk ever reads this bit; it makes
	 * the record self-describing for the free path, the debug hydrators,
	 * and the audits. Deliberately outside KIND_MASK — the kernel's
	 * kind dispatch never sees observer records.
	 */
	K_WATCHER = 0b00100000000000000,
	/**
	 * Kind: subscription record (one committed observer — see
	 * SubscriptionField). Engine-interpreted exactly like K_WATCHER;
	 * outside KIND_MASK for the same reason.
	 */
	K_SUBSCRIPTION = 0b01000000000000000,
	/**
	 * Observer records only (K_WATCHER / K_SUBSCRIPTION): the observer
	 * is subscribed for delivery. For a watcher this is the layout-
	 * effect subscription bit — a live watcher holds one observed-
	 * consumer ref on its node, released when the bit clears; for a
	 * subscription it means "not yet removed" — queued refires no-op
	 * once it clears. Observer records never enter kernel walks, so no
	 * kernel flag rewrite can touch it.
	 */
	OBSERVER_LIVE = 0b10000000000000000,
	/** The kind bits together (exactly one is set on a live record). Observer kinds (K_WATCHER/K_SUBSCRIPTION) stay outside: the kernel's kind dispatch never sees observer records. */
	KIND_MASK = K_SIGNAL | K_COMPUTED | K_EFFECT | K_SCOPE, // 0b00000011110000000
}

/**
 * Kernel arena shape: the strides, shifts, and offsets that address a
 * record's fields and its side-column slots from its premultiplied id
 * (see NodeField for the const-enum rationale).
 */
export const enum ArenaShape {
	/** Int32 fields per record; ids are premultiplied by this (id = record ordinal × STRIDE). */
	STRIDE = 8,
	/** id >> ID_TO_VALUE_SHIFT: premultiplied id → the record's base slot in the `values` column (2 slots per record). */
	ID_TO_VALUE_SHIFT = 2,
	/** id >> ID_TO_FN_SHIFT: premultiplied id → the record's base slot in the `fns` column (1 slot per record). */
	ID_TO_FN_SHIFT = 3,
	/** id >> ID_TO_EXTRAS_SHIFT: premultiplied id → the record's base slot in the `extras` column (1 slot per record). */
	ID_TO_EXTRAS_SHIFT = 3,
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
 * Scrub a freed record's side-column slots on the node allocator's
 * free path (generated from the column roster; covers every family the
 * allocator serves: node/watcher/subscription records). The slot's next tenant must
 * never observe the old tenant's values, closures, or clock stamps.
 * recordBuffer columns are closure-owned, so the caller passes its
 * buffer.
 */
function scrubNodeColumnsOnFree(id: NodeId, clocks: Float64Array): void {
	const base: ValueIndex = id >> ArenaShape.ID_TO_VALUE_SHIFT;
	values[base] = undefined; // current/computed value — watcher records: the last rendered value (subscriptions keep values in their extras object instead)
	values[base + ArenaShape.AUX_VALUE_OFFSET] = undefined; // signal pending value or effect cleanup fn (computeds and observer records: empty on purpose)
	fns[id >> ArenaShape.ID_TO_FN_SHIFT] = undefined; // computed getter / effect fn / an atom's dormant lifecycle callback / a subscription's refire callback
	extras[id >> ArenaShape.ID_TO_EXTRAS_SHIFT] = undefined; // general per-record object: cold oddments that don't earn a dedicated column (observer records: name/root/snapshot or name/root/deps/observation-retains/body)
	clocks[id >> ArenaShape.ID_TO_CLOCK_SHIFT] = 0; // signal/computed: updatedAt (tagged-outcome clock) / watcher, subscription: the observer's lastValidatedAt / link: reserved (scrubbed on free)
}

/**
 * Scrub a freed record's side-column slots on the link allocator's
 * free path (generated from the column roster; covers every family the
 * allocator serves: link records). The slot's next tenant must
 * never observe the old tenant's values, closures, or clock stamps.
 * recordBuffer columns are closure-owned, so the caller passes its
 * buffer.
 */
function scrubLinkColumnsOnFree(id: LinkId, clocks: Float64Array): void {
	clocks[id >> ArenaShape.ID_TO_CLOCK_SHIFT] = 0; // signal/computed: updatedAt (tagged-outcome clock) / watcher, subscription: the observer's lastValidatedAt / link: reserved (scrubbed on free)
}

/**
 * Grow the kernel's grown-together side columns to cover one record id
 * (generated from the column roster — a new column cannot miss the
 * growth loop). Called by the node allocator for every family it serves
 * (node/watcher/subscription records); record-buffer columns are
 * factory-carried and grow by kernel rebuild instead.
 */
function growNodeSideColumns(id: RecordId): void {
	while (values.length <= (id >> ArenaShape.ID_TO_VALUE_SHIFT) + ArenaShape.AUX_VALUE_OFFSET) {
		values.push(undefined);
	}
	while (fns.length <= id >> ArenaShape.ID_TO_FN_SHIFT) {
		fns.push(undefined);
	}
	while (extras.length <= id >> ArenaShape.ID_TO_EXTRAS_SHIFT) {
		extras.push(undefined);
	}
}

/**
 * Reset every kernel side column to its record-zero seed (generated from
 * the column roster; the test reset's column half). Grow-arrays truncate;
 * record buffers zero-fill in place (the arena keeps its capacity).
 */
function resetSideColumnsForTest(clocks: Float64Array): void {
	values.length = 2;
	values[0] = undefined;
	values[1] = undefined;
	fns.length = 1;
	fns[0] = undefined;
	extras.length = 1;
	extras[0] = undefined;
	clocks.fill(0);
}

/**
 * World-arena shadow-record fields (engine-owned layout — not the
 * kernel's NodeField/LinkField, whose offsets 5-7 mean different things;
 * stride 8; shadow and link records share the pool). Module-local on
 * purpose: every hot arena walk is same-file, and the test-side checker
 * reads the layout through arenaCheckerLayout() (data passing), never
 * through exported enums. The shared field/bit names deliberately keep
 * the kernel's numbering (the arena walks re-state the kernel's
 * propagate/checkDirty family and read best side by side), but nothing
 * couples the two layouts.
 */
const enum ArenaField {
	/** State machine + kind bits (see ArenaFlag). */
	FLAGS = 0,
	/** First dependency link; doubles as the dead-shadow free-list next pointer. */
	DEPS = 1,
	/** Last confirmed dependency link (the re-track cursor during a refold). */
	DEPS_TAIL = 2,
	/** First STRONG subscriber link (the weak list lives in the weakSubs side column). */
	SUBS = 3,
	/** Last strong subscriber link. */
	SUBS_TAIL = 4,
	/** The nodeIndex this record shadows (dense column key; identity is the kernel record id). */
	NODE = 5,
	/** Id-tenancy stamp: the node's kernel-record GEN observed at recording — dead-GEN shadows never serve. */
	NODE_GEN = 6,
	/** Fanout read-clock dedup stamp (a marked cone nothing re-validated is not re-walked). */
	MARK = 7,
}

/**
 * World-arena link-record fields (link records share ArenaField's pool
 * and stride; offsets overlay the shadow-record fields).
 */
const enum ArenaLinkField {
	/** Evaluation-cycle stamp: intra-refold duplicate-read dedup. */
	VERSION = 0,
	/** Producer shadow record id. */
	DEP = 1,
	/** Consumer shadow record id. */
	SUB = 2,
	/** Previous link in the producer's mode-matching subscriber list. */
	PREV_SUB = 3,
	/** Next link in the producer's mode-matching subscriber list. */
	NEXT_SUB = 4,
	/** Previous link in the consumer's dependency list. */
	PREV_DEP = 5,
	/** Next link in the consumer's dependency list. */
	NEXT_DEP = 6,
	/** ArenaLinkMode bits (strong/weak — see the weak-link rules at the arena walks). */
	MODE = 7,
	/**
	 * The free list threads through the VERSION field (FREE_NEXT aliases
	 * it), the same discipline as the kernel's LinkField.FREE_NEXT: a freed
	 * link must keep every field a walk still reads intact. arenaCheckDirty
	 * reads NEXT_DEP (and arenaShallowPropagate NEXT_SUB) off links a
	 * mid-walk purge freed, so those must keep naming former neighbors,
	 * never the free list. VERSION is genuinely dead on freed links: it is
	 * only written at link creation/reuse (arenaLink/arenaLinkInsert) and
	 * only read off live links (the subs-tail dedup probe); every
	 * allocation path rewrites it before any read. Pinned by
	 * tests/arena-freelist.spec.ts.
	 */
	FREE_NEXT = 0,
}

/** MODE field bits. */
const enum ArenaLinkMode {
	/** 1 = weak (untracked-read) link — never delivers; lives on the segregated weak subs list. */
	WEAK = 0b1,
}

/**
 * Shadow flag bits (engine-owned; the shared names keep the kernel
 * NodeFlag numbering for side-by-side reading — see the ArenaField doc).
 */
const enum ArenaFlag {
	/** Can produce new values (evaluated at least once for computeds). */
	MUTABLE = 0b000000000000001,
	/** Currently refolding (re-entrancy guard; a read under it is a dependency cycle). */
	RECURSED_CHECK = 0b000000000000100,
	/** A re-entrant mark reached this shadow during its own refold. */
	RECURSED = 0b000000000001000,
	/** Definitely stale (listed on the arena dirty list — the DIRTY ⇒ listed contract). */
	DIRTY = 0b000000000010000,
	/** Possibly stale — verify by pulling before refolding. */
	PENDING = 0b000000000100000,
	/** Kind: atom shadow. */
	K_SIGNAL = 0b000000010000000,
	/** Kind: computed shadow. */
	K_COMPUTED = 0b000000100000000,
	/** Value column holds an exceptional payload (thrown error, or sentinel). */
	HAS_BOX = 0b000100000000000,
	/** Refines HAS_BOX: payload is the thenable's stable SuspendedRead. */
	BOX_SUSPENDED = 0b001000000000000,
	/** The value column holds a folded value (cold shadow when unset). */
	VALID = 0b010000000000000,
	/**
	 * Refines HAS_BOX: the payload was thrown by the fn (render-path
	 * suspension or plain error) — serves rethrow the cached payload,
	 * boxedRead-style. Clear means a returned sentinel (background
	 * suspensions fold to the sentinel value), which serves as a value.
	 * Arena-local bit with no kernel NodeFlag counterpart (the kernel
	 * encodes the split differently).
	 */
	BOX_THROWN = 0b100000000000000,
}

/**
 * World-arena geometry. Same-file const enum members (not module
 * consts): the reads sit inside the hot arena walks and must inline as
 * literals.
 */
const enum ArenaGeom {
	/** Int32 fields per record; ids are premultiplied by this (id = record ordinal × STRIDE). */
	STRIDE = 8,
	/** record id >> ID_TO_COLUMN_SHIFT = the record's slot in every per-record side column (one slot per record). */
	ID_TO_COLUMN_SHIFT = 3,
	/**
	 * Int32 stamp ceiling: `readClock` and `cycle` are JS numbers, but
	 * their stamps store into Int32Array fields (ArenaField.MARK,
	 * ArenaLinkField.VERSION) which truncate past 2^31-1 — a wrapped store
	 * could collide with a live stamp and false-positive the dedup (a
	 * skipped propagation or a dropped link: the dangerous direction). The
	 * bump helpers (arenaBumpReadClock, arenaBumpCycle) renumber before any
	 * store can wrap: stamps reset to 0 (= stale), the clock restarts, and
	 * the next walk re-marks — at most one conservative re-walk per record
	 * per 2^31 events, amortized zero. (Margin under 2^31-1 is cosmetic
	 * headroom; bumps route through the helpers, so the clocks never reach
	 * the ceiling.)
	 */
	CLOCK_LIMIT = 2147418112,
	/**
	 * 2^26 — the DEFAULT initial per-arena record reservation (64MiB of
	 * Int32: 2M stride-8 records, plus a float64 clock slot per record
	 * beside it), generous ON PURPOSE so growth stays rare. A fresh
	 * zeroed allocation this size is nearly free: the pages are
	 * zero-fill demand-paged, so the reservation costs address space
	 * while resident memory tracks only the records actually touched
	 * (the dalien-signals record-store pattern). NOT a ceiling: an
	 * allocation past the current capacity doubles the buffers by copy,
	 * mid-operation (growWorldArenaBuffers) — exhaustion is never fatal,
	 * by owner ruling. EngineResetOptions.arenaInitInts overrides the
	 * initial size (the arena suites shrink it to force mid-operation
	 * growth). The views stay plain fixed-length typed arrays (full V8
	 * element-access optimization): length-tracking resizable-buffer
	 * views are banned — a measured +56% arena-walk regression.
	 */
	INIT_BUFFER_BYTES = 67108864,
}

/**
 * Grow one world arena's record store and every record-keyed buffer
 * column BY COPY (doubling) to cover `needInts` Int32 slots (generated
 * from the column roster — a new record-buffer column cannot miss the
 * growth; exhaustion is never fatal, by owner ruling). Mid-operation
 * growth is safe through the shell indirection: only the buffer
 * OBJECTS change — record ids, and every structure holding them
 * (observer dep chains included), stay stable — and the replacement
 * buffers are zeroed past the copied prefix, preserving the
 * fresh-record invariant. The price is the reload-after-allocation
 * discipline, confined to the sites enumerated here
 * (generated-or-listed, never folklore):
 *  - arenaAllocShadow / arenaAllocLink:
 *    the ONLY growth triggers (the bump arm doubles before issuing the
 *    id); arenaAllocShadow caches `a.memory` only after that arm,
 *    arenaAllocLink caches nothing.
 *  - arenaLinkInsert:
 *    re-loads `a.memory` after its arenaAllocLink call (the tail probes
 *    before the call read `a.memory` directly).
 *  - buildObserverDepChain:
 *    re-loads `a.memory` after the arenaAllocLink inside its per-dep
 *    loop (link ids threaded so far stay valid — ids never move).
 *  - the refold family:
 *    arenaServe / arenaCheckDirtyLoop / arenaUpdateAndShallow /
 *    arenaUpdateShadow / arenaUpdateComputed / arenaFoldOutcome allocate
 *    TRANSITIVELY (fn runs and comparator calls can record deps): each
 *    reads `a.memory` fresh after any fold/update/fn call instead of
 *    caching across it — the carried kernel-correspondence shape.
 *  - the no-allocation walks:
 *    propagate/fanout/collect/renumber walks and the detach/unlink/
 *    evict/free paths never allocate — free to cache views for the
 *    whole walk (each site notes it where it caches).
 */
function growWorldArenaBuffers(a: WorldArena, needInts: number): void {
	let len = a.memory.length;
	while (len < needInts) len *= 2;
	if (len === a.memory.length) return;
	const memory = new Int32Array(len);
	memory.set(a.memory);
	a.memory = memory;
	const clocks = new Float64Array(len >> ArenaGeom.ID_TO_COLUMN_SHIFT);
	clocks.set(a.clocks);
	a.clocks = clocks;
}

/**
 * Grow the world arena's grown-together per-record columns to cover one
 * column index (generated from the column roster — a new column cannot
 * miss the growth loop). Called by the shadow allocator; record-buffer
 * columns grow with the record store instead (growWorldArenaBuffers).
 */
function growWorldArenaColumns(a: WorldArena, columnIndex: number): void {
	while (a.vals.length <= columnIndex) {
		a.vals.push(undefined);
		a.suspIdx.push(0);
		a.walk.push(0);
		a.weakSubs.push(0);
		a.weakSubsTail.push(0);
		a.cutoffVals.push(undefined);
	}
}

/**
 * Scrub an evicted shadow record's per-record column slots (generated
 * from the column roster): a re-keyed or purged record's next tenant must
 * never observe the dead tenancy's value or clock stamp. List-coupled
 * columns (suspIdx, the weak heads) clear through their list operations
 * instead; walk stamps are inert by generation monotonicity.
 */
function scrubWorldShadowColumnsOnEvict(a: WorldArena, sh: number): void {
	const vi = sh >> ArenaGeom.ID_TO_COLUMN_SHIFT;
	a.vals[vi] = undefined;
	a.clocks[vi] = 0;
	a.cutoffVals[vi] = undefined;
}

/**
 * Scrub a freed world-arena link record's observer-state column slots
 * (generated from the column roster): only subscription dependency links
 * ever write these, but the free-path scrub is unconditional so a reused
 * link record can never carry a dead tenancy's stamp regardless of which
 * path freed it (the kernel freeLink's clock-scrub twin).
 */
function scrubWorldLinkColumnsOnFree(a: WorldArena, id: number): void {
	a.clocks[id >> ArenaGeom.ID_TO_COLUMN_SHIFT] = 0;
}

/**
 * Reset every world-arena side column at release (generated from the
 * column roster; the release scrub's column half). Keeps each column's
 * CAPACITY across pool tenancies (a priced cold-render saving: truncating
 * to 0 forced re-pushing every element on every claim — ~2k pushes per
 * cold render); fill() scrubs the same residue truncation would have
 * dropped, so value refs release and stale ids read as "none" while the
 * packed length persists. The clock buffer zero-fills its written prefix.
 */
function resetWorldArenaColumnsOnRelease(a: WorldArena): void {
	a.nodeToShadow.fill(0);
	a.vals.fill(undefined);
	a.suspIdx.fill(0);
	a.walk.fill(0);
	a.weakSubs.fill(0);
	a.weakSubsTail.fill(0);
	a.clocks.fill(0, 0, a.next >> ArenaGeom.ID_TO_COLUMN_SHIFT);
	a.cutoffVals.fill(undefined);
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
/** The general per-record object side column (extras[id >> 3]): cold
 * oddments that don't earn a dedicated column — see the generated column
 * roster. Module-internal: its only readers are this module's observer
 * record accessors. */
const extras: unknown[] = [undefined];

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
//  - An OBSERVER record's slot (watcher / subscription — see the observer
//    sections at the end of this module) is the observer's lastValidatedAt:
//    the per-root committed clock it last validated against. Kernel LINK
//    slots are reserved-unused (a subscription's per-dep stamps ride its
//    WORLD-ARENA dependency links instead); the kernel never reads or
//    writes them (the intra-run dedup stamp stays in the VERSION field),
//    and the generated free scrub guarantees a fresh or reused record
//    starts at 0 ("never validated").
//
// The skip rule for consumers (owner ruling: observer re-fires are
// AT-LEAST-ONCE): an observer may skip only when the producer is CLEAN and
// its clock matches the observer's last-validated stamp; otherwise it
// evaluates, the consult settles the producer's per-root committed clock
// (settleObserverClock — clocks move only on changed results, with the
// node's own comparator inside the settle), and a settled clock that
// differs from the stamp RE-FIRES — no value comparison at the re-fire
// decision. Net-no-change sequences whose intermediate states other
// consults settled re-fire spuriously by accepted design.
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
	/** Allocate an OBSERVER record (K_WATCHER / K_SUBSCRIPTION — the engine's
	 * watcher and subscription records; see WatcherField). Node-allocator
	 * records with no kernel links and no reclamation registration: the
	 * engine owns their lifetime and frees them through
	 * {@link Kernel.disposeObserver}. */
	newObserver(flags: NodeFlags): NodeId;
	/** Dispose an observer record: the free defers to the next operation
	 * boundary exactly like effect/scope disposal (queued notifications may
	 * still hold the handle object; its own fields stay readable). Observer
	 * records hold no kernel links, so there is nothing to unlink. */
	disposeObserver(id: NodeId): void;
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
		newObserver: (flags) => allocNode(flags),
		disposeObserver: (id) => {
			// Zero the flags now (a disposed observer must read as dead — the
			// OBSERVER_LIVE getter and the kind probes see 0) and defer the
			// free to the boundary sweep, exactly like effect/scope disposal.
			memory[id + NodeField.FLAGS] = 0;
			pendingFree.push(id);
		},
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
		growNodeSideColumns(id); // generated: every grown-together column covers the record, by construction
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
	newObserver: foldPoisonOp as never,
	disposeObserver: foldPoisonOp as never,
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

// ---- world arenas -----------------------------------------------------------------

/**
 * World arenas — the value, invalidation, and routing layer for render and
 * committed worlds. One arena per world: packed stride-8 Int32 records (node
 * shadows + dependency links sharing one pool), value/suspension/walk side
 * columns, a dirty list, and the read clock. Arenas serve real world reads
 * (values + refolds through their own walks), route write-time deliveries
 * over strong links, seed durable drains from their dirty lists, and carry
 * the mount-fixup closure over reverse links. The full vocabulary (world,
 * fold, batch, watcher) is defined at the top of concurrent.ts.
 *
 * Layout discipline: ArenaField/ArenaLinkField/ArenaFlag/ArenaGeom/ArenaWalk
 * are same-file const enums, generated from tools/schema.ts into the marked
 * region above — every hot arena walk lives in this module so the members
 * inline as literals under every esbuild-based toolchain. The test-side
 * checker reads the layout through `arenaCheckerLayout()` (data passing),
 * never through exported enums.
 *
 * Two layers, one section:
 *  - the WorldArena record class and the transliterated walk
 *    family (arenaLink/arenaPropagate/arenaCheckDirty's free half…) — pure
 *    functions over one arena that re-state the kernel's walks (see the
 *    kernel-correspondence note above arenaLink below);
 *  - `createWorldArena`: the engine-facing serving/lifecycle layer (serve,
 *    refold, claim/release, fanout, decay, routing walks) as a factory in
 *    the kernel's own style — it closes over its state and assigns its
 *    operation table onto the one shared engine core record (World.ts
 *    `EngineCore`), whose late-bound slots resolve the World ⇄ arena ⇄
 *    settlement recursion at call time.
 */

/** Per-walk visited generation (walk termination without Set allocations). */
type WalkGen = number;

/** A shadow record id: the premultiplied index of a record inside one world
 * arena's own buffer (this module's third id space — not a kernel NodeId,
 * not a NodeIndex; the arena walks consult kernel memory mid-walk, which is
 * exactly where mixing would silently corrupt). Leniently branded on the
 * kernel's one-symbol IdBrand (CosignalEngine.ts): plain numbers — every
 * `a.memory[...]` read — assign in cast-free; cross-brand assignment
 * errors. 0 = none (record 0 burned). Arena link record ids share the pool
 * and stay plain numbers (the shared-allocator escape hatch, exactly like
 * the kernel's RecordId). */
type ShadowId = number & IdBrand<'arenaShadow'>;

/** A node record's tenancy generation, read live from kernel memory. The
 * buffer is re-fetched per read: kernel growth rebuilds swap it, and engine
 * operations span growth boundaries. */
export function getKernelGeneration(id: NodeId): Generation {
	return E.buffer()[id + NodeField.GEN]!;
}

/** A node record's NODE_INDEX, read live from kernel memory. */
export function getKernelNodeIndex(id: NodeId): NodeIndex {
	return E.buffer()[id + NodeField.NODE_INDEX]!;
}

// ---- the arena layer --------------------------------------------------------------
// The arenas are the value, invalidation,
// and routing layer for render and committed worlds — shadow records +
// strong/weak links recorded by the arena fn-readers, folds into value
// columns, fanout marks at the four committed-truth flip sites, sentinel
// boxes + settlement, consumer-refcount reclamation at quiesce, write-time
// delivery over strong links, drain candidates off the dirty lists, and the
// mount-fixup closure over reverse (deps) links. Newest is not arena-served:
// every engine computed rides a kernel `Computed` record — the
// kernel serves newest, and the kernel's own dep links carry the newest
// strong walks (subscription reach, the fixup closure's kernel leg). When
// the test harness arms the divergence checker (tests/arena-checker.ts, fed
// through `__checkerInternals`), every
// public operation's epilogue serves each live arena's shadows from the
// arena (its own walks) and compares against fold-truth — a
// naive cache-free re-fold — and any divergence throws. ArenaField/ArenaLinkField/
// ArenaFlag below are
// the world arenas' own layout — engine-owned, same-file so the hot arena
// walks (the arenaPropagate/arenaCheckDirty family) inline the members as literals
// under every toolchain. The shared field/bit names deliberately keep the
// kernel's numbering (the walks re-state the kernel's
// propagate/checkDirty family and read best side by side), but nothing
// couples the two layouts: walks over kernel records use the kernel's own
// exported enums (index.ts NodeField/LinkField/NodeFlag — see
// getKernelStrongDeps and collectKernelClosure), and offsets 5-7 here mean
// shadow-specific things the kernel's fields don't.

// (ArenaField/ArenaLinkField/ArenaLinkMode/ArenaFlag/ArenaGeom — the world
// arenas' layout — are generated from tools/schema.ts into the marked
// region above, same-file with these walks so the members inline as
// literals under every toolchain.)

/** Bounds the arena pool: releaseArena keeps at most this many scrubbed
 * shells (further releases drop the shell). Also the pool's address-space
 * bound: each shell holds at least the initial reservation (ArenaGeom.
 * INIT_BUFFER_BYTES + the clock column) and keeps whatever capacity growth
 * gave it, so the parked pool reserves at most ARENA_POOL_CAP × the
 * high-water tenancy — address space, not resident memory (only touched
 * pages commit). */
const ARENA_POOL_CAP = 8;

/** The default world-arena initial reservation in Int32 slots — the
 * ArenaGeom.INIT_BUFFER_BYTES record store, as the composition site's
 * arenaInitInts default (EngineResetOptions.arenaInitInts overrides it;
 * the arena suites shrink it to force real mid-operation growth). */
export const WORLD_ARENA_INIT_INTS: ArenaInitInts = ArenaGeom.INIT_BUFFER_BYTES >> 2;
const EMPTY_I32 = new Int32Array(0);

/**
 * One world's arena: packed records, a value
 * side column, a per-shadow suspended-list index column, a dirty list, and
 * the read clock. Pooled: buffers return to the pool at release, where the
 * full scrub (releaseArena: written prefix + every side column zeroed) is
 * what makes dead-tenancy residue unable to validate; `claimGen` is the
 * tenancy diagnostic (bumped at claim and release, monotone per shell —
 * a float64 counter, exact to 2^53, so it has no wrap surface).
 */
export class WorldArena {
	kind: 'render' | 'committed';
	/** Owning world (render object or committed root) — folds cite it. */
	world: World;
	root: RootId; // committed: the root id; render: the render's root (diagnostics)
	alive = true;
	/** Pool claim generation (bumped at claim and release). */
	claimGen = 0;
	/**
	 * The arena's records: a plain fixed-length Int32Array (full V8
	 * element-access optimization; length-tracking resizable-buffer views
	 * were tried at the schema re-derivation, measured +56% on cold renders
	 * and +18-31% on wide fanout masks, and stay banned). Allocated at the
	 * generous initial reservation — ArenaGeom.INIT_BUFFER_BYTES by
	 * default, EngineResetOptions.arenaInitInts when set — and grown BY
	 * COPY (doubling) whenever an allocation outruns it: exhaustion is
	 * never fatal, by owner ruling. Growth mid-operation is safe through
	 * this shell indirection — growWorldArenaBuffers reassigns the field,
	 * record ids never change (observer dep chains and every other
	 * id-holding structure are untouched), and the sites that cache the
	 * view across an allocating call re-load it after (the discipline is
	 * enumerated in growWorldArenaBuffers' doc, generated-or-listed).
	 * Growth stays RARE by the reservation's generosity: a fresh zeroed
	 * allocation that size is nearly free — the pages are zero-fill
	 * demand-paged, so it costs address space while resident memory tracks
	 * only the records actually touched (the pattern proven in
	 * dalien-signals, which reserves 64MB record stores the same way).
	 */
	memory: Int32Array;
	/** The per-world updated-at clock column: one float64 slot per record,
	 * sized with the {@link memory} record store and grown by copy beside
	 * it (see the schema's world column roster). */
	clocks: Float64Array;
	/** Whether observer consults settle the clock column: committed arenas
	 * only — render-world values are pin-frozen, so a render arena's clocks
	 * never move (the settle gate; set per tenancy at claim). */
	bumpsClocks: boolean;
	vals: Value[] = [];
	/** The observer coalescing register (see the schema's column roster):
	 * the folded value as of the shadow's last observer consult — the
	 * compare basis settleObserverClock moves the clock against. Valid iff
	 * the clock slot is non-zero. */
	cutoffVals: Value[] = [];
	/** Per-record suspended-list slot + 1 (0 = not suspended) — the field is
	 * the set bit and stores the dense index (swap-remove compaction). */
	suspIdx: number[] = [];
	/** Per-record walk-generation stamps (the routing walks: delivery reach,
	 * drain candidate collection, fixup closure) — termination + O(V+E)
	 * without allocation. Compared against the engine's global
	 * walk generation; scrubbed at release like the other side columns. */
	walk: number[] = [];
	/** The segregated weak subs list. Segregation is priced, not cosmetic:
	 * a combined-list walk measured 4.9× the write cost on a write-storm
	 * shape with hundreds of weak links per node — every write
	 * visited-and-skipped them all. Weak-flagged links live on a
	 * per-shadow second subs list (head + tail side columns, record ids;
	 * same link-record layout): the delivery walk traverses the strong list
	 * (ArenaField.SUBS) only and never sees a weak link; mark propagation and drain
	 * candidate collection walk both. The mode transitions (first-
	 * occurrence reset, strong-dominates) move a link between the lists. */
	weakSubs: number[] = [];
	weakSubsTail: number[] = [];
	next = ArenaGeom.STRIDE; // bump pointer (record 0 burned: 0 = null)
	linkFree = 0;
	/** Dead-shadow free list head (leak audit): record ids threaded through
	 * ArenaField.DEPS of records `disposeComputed`'s eager purge orphaned — the one
	 * site that kills a shadow record mid-tenancy (the dead-GEN path re-keys
	 * records in place). Records join FULLY ZEROED (nodeToShadow cleared, links
	 * purged, unsuspended), so nothing can reach one until arenaAllocShadow
	 * re-issues it; without this list the bump pointer grew a live arena by
	 * one record per useComputed recreation, forever
	 * (tests/leak-audit.spec.ts pins the boundedness). */
	shadowFree: ShadowId = 0;
	links = 0;
	/** nodeIndex → shadow record id (0 = none; index 0 is burned). */
	nodeToShadow: ShadowId[] = [];
	/** Marked-shadow list (record ids; appended on the DIRTY 0→1 edge). */
	dirty: ShadowId[] = [];
	/** Suspended-shadow list (record ids; dense — swap-remove compaction). */
	suspended: ShadowId[] = [];
	/** Fanout dedup clock: bumped on every arena consumption. */
	readClock = 0;
	/** Per-arena evaluation cycle (link VERSION stamps). */
	cycle = 0;

	constructor(kind: 'render' | 'committed', world: World, root: RootId, initInts: ArenaInitInts) {
		this.kind = kind;
		this.world = world;
		this.root = root;
		this.bumpsClocks = kind === 'committed';
		// The initial reservation (see the memory field's doc): the record
		// store plus one float64 clock slot per record, grown together by
		// growWorldArenaBuffers when an allocation outruns them.
		this.memory = new Int32Array(initInts);
		this.clocks = new Float64Array(initInts >> ArenaGeom.ID_TO_COLUMN_SHIFT);
	}
}

/** Reclamation guard probe (the suspended-list guard row, engine hook side):
 * whether this arena's suspended list holds the node's shadow. Same-file
 * with the layout enums; cold — one probe per arena per finalizer
 * fire/retry. */
export function arenaHoldsSuspended(a: WorldArena, ix: NodeIndex): boolean {
	const sh = ix < a.nodeToShadow.length ? a.nodeToShadow[ix]! : 0;
	return sh !== 0 && (a.suspIdx[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT] ?? 0) !== 0;
}

/** Membership probe (one of the named world-state queries orchestration
 * and the reclamation guards are confined to — owner ruling: world state
 * is read through the narrow function set, never arena storage directly):
 * whether this arena currently holds a shadow record for the node index.
 * Cold — the reclamation guard's open-render row, the render lifecycle's
 * population dev assert, and diagnostics. */
export function arenaHasShadow(a: WorldArena, ix: NodeIndex): boolean {
	return (ix < a.nodeToShadow.length ? a.nodeToShadow[ix]! : 0) !== 0;
}

/** Renumber the read clock: MARK → 0 on every live shadow record, clock
 * restarts at 0 — the exact quiesce-duty state, where "marks 0 /
 * clock 0" is proven sound: a dedup hit in that state claims an
 * already-marked cone whose PENDING flags persist, and any intervening
 * consumption bumps the clock away from 0. Link records are skipped by the
 * nodeToShadow round-trip guard (their slot 7 is MODE, not MARK). */
export function arenaRenumberMarks(a: WorldArena): void {
	for (let sh = ArenaGeom.STRIDE; sh < a.next; sh += ArenaGeom.STRIDE) {
		if ((a.memory[sh + ArenaField.NODE] ?? 0) !== 0 && a.nodeToShadow[a.memory[sh + ArenaField.NODE]!] === sh) a.memory[sh + ArenaField.MARK] = 0;
	}
	a.readClock = 0;
}

function arenaBumpReadClock(a: WorldArena): void {
	if (a.readClock >= ArenaGeom.CLOCK_LIMIT) arenaRenumberMarks(a);
	a.readClock++;
}

/** Renumber evaluation-cycle stamps: VERSION → 0 on every live link (each
 * lives on exactly one deps chain), cycle restarts at 0. VERSION is only
 * compared for same-evaluation link dedup, so a zeroed stamp just reads as
 * "stale from an old evaluation" — the normal case. Freed links are never
 * touched: their VERSION aliases the free-list thread (FREE_NEXT). An open
 * outer frame keeps stamping its saved (≥ limit) cycle, which post-renumber
 * cycles can never reach again before the next renumber — no collision. */
function arenaRenumberLinkVersions(a: WorldArena): void {
	const memory = a.memory;
	for (let sh = ArenaGeom.STRIDE; sh < a.next; sh += ArenaGeom.STRIDE) {
		if ((memory[sh + ArenaField.NODE] ?? 0) !== 0 && a.nodeToShadow[memory[sh + ArenaField.NODE]!] === sh) {
			for (let l = memory[sh + ArenaField.DEPS]!; l !== 0; l = memory[l + ArenaLinkField.NEXT_DEP]!) memory[l + ArenaLinkField.VERSION] = 0;
		}
	}
	a.cycle = 0;
}

function arenaBumpCycle(a: WorldArena): number {
	if (a.cycle >= ArenaGeom.CLOCK_LIMIT) arenaRenumberLinkVersions(a);
	return ++a.cycle;
}

function arenaAllocShadow(a: WorldArena, ix: NodeIndex, flags: number, gen: number): ShadowId {
	let id = a.shadowFree;
	if (id !== 0) {
		// Reuse a dead-shadow record (see WorldArena.shadowFree): it was
		// zeroed wholesale when it joined the list, its side columns were
		// scrubbed by the evict (vals/suspIdx) and the unlinks (weak heads),
		// and its walk stamp is stale by generation monotonicity — so once
		// the thread field clears, the fresh-record invariant below holds.
		a.shadowFree = a.memory[id + ArenaField.DEPS]!;
		a.memory[id + ArenaField.DEPS] = 0;
	} else {
		id = a.next;
		const end = id + ArenaGeom.STRIDE;
		if (end > a.memory.length) growWorldArenaBuffers(a, end); // may replace the buffers: `memory` caches below this arm only
		a.next = end;
	}
	const memory = a.memory;
	// Fresh-record invariant (a priced cold-render saving): memory[a.next..] is all zero —
	// buffers allocate zeroed (demand-paged), growWorldArenaBuffers'
	// replacements are zeroed past the copied prefix, and releaseArena
	// scrubs the dead tenancy's whole
	// written prefix [0, next) before the buffer pools. So the list heads
	// (DEPS/DEPS_TAIL/SUBS/SUBS_TAIL) and MARK are already 0 here, and the
	// bump allocator never re-issues a record id mid-tenancy — only the
	// tenant fields need stores. (The freelist re-issues LINK records, whose
	// creation paths write every field — tests/arena-freelist.spec.ts.)
	memory[id + ArenaField.FLAGS] = flags;
	memory[id + ArenaField.NODE] = ix;
	memory[id + ArenaField.NODE_GEN] = gen;
	growWorldArenaColumns(a, id >> ArenaGeom.ID_TO_COLUMN_SHIFT); // generated: the grown-together columns
	while (a.nodeToShadow.length <= ix) a.nodeToShadow.push(0); // stay packed, never holey
	a.nodeToShadow[ix] = id;
	return id;
}

function arenaAllocLink(a: WorldArena): number {
	let id = a.linkFree;
	if (id !== 0) {
		a.linkFree = a.memory[id + ArenaLinkField.FREE_NEXT]!;
	} else {
		id = a.next;
		const end = id + ArenaGeom.STRIDE;
		if (end > a.memory.length) growWorldArenaBuffers(a, end); // may replace the buffers: callers re-load cached views (see its doc)
		a.next = end;
	}
	a.links++;
	return id;
}

function arenaFreeLink(a: WorldArena, id: number): void {
	scrubWorldLinkColumnsOnFree(a, id); // generated: a reused link must not carry a dead tenancy's observer stamp
	a.memory[id + ArenaLinkField.FREE_NEXT] = a.linkFree;
	a.linkFree = id;
	a.links--;
}

/** Detach a link from its dep's subs list (the one matching its mode). Fixes
 * neighbors and the head/tail columns only — the link's own prev/next stay
 * stale on purpose: mid-walk readers must keep seeing former neighbors;
 * movers rewrite them in arenaSubsAppend, and freed links never
 * revalidate. */
function arenaSubsDetach(a: WorldArena, id: number): void {
	const memory = a.memory;
	const dep = memory[id + ArenaLinkField.DEP]!;
	const nextSub = memory[id + ArenaLinkField.NEXT_SUB]!;
	const prevSub = memory[id + ArenaLinkField.PREV_SUB]!;
	const weak = (memory[id + ArenaLinkField.MODE]! & ArenaLinkMode.WEAK) !== 0;
	if (nextSub !== 0) memory[nextSub + ArenaLinkField.PREV_SUB] = prevSub;
	else if (weak) a.weakSubsTail[dep >> ArenaGeom.ID_TO_COLUMN_SHIFT] = prevSub;
	else memory[dep + ArenaField.SUBS_TAIL] = prevSub;
	if (prevSub !== 0) memory[prevSub + ArenaLinkField.NEXT_SUB] = nextSub;
	else if (weak) a.weakSubs[dep >> ArenaGeom.ID_TO_COLUMN_SHIFT] = nextSub;
	else memory[dep + ArenaField.SUBS] = nextSub;
}

/** Append a link to its dep's mode-matching subs list tail (sets the
 * link's own prev/next and mode). */
function arenaSubsAppend(a: WorldArena, id: number, weak: boolean): void {
	const memory = a.memory;
	const dep = memory[id + ArenaLinkField.DEP]!;
	const vi = dep >> ArenaGeom.ID_TO_COLUMN_SHIFT;
	const tail = weak ? a.weakSubsTail[vi]! : memory[dep + ArenaField.SUBS_TAIL]!;
	memory[id + ArenaLinkField.MODE] = weak ? ArenaLinkMode.WEAK : 0;
	memory[id + ArenaLinkField.PREV_SUB] = tail;
	memory[id + ArenaLinkField.NEXT_SUB] = 0;
	if (tail !== 0) memory[tail + ArenaLinkField.NEXT_SUB] = id;
	else if (weak) a.weakSubs[vi] = id;
	else memory[dep + ArenaField.SUBS] = id;
	if (weak) a.weakSubsTail[vi] = id;
	else memory[dep + ArenaField.SUBS_TAIL] = id;
}

/** Set a live link's mode; a change moves it between the dep's two subs
 * lists (the mode transitions under the segregated-list scheme). */
function arenaSetLinkWeak(a: WorldArena, id: number, weak: boolean): void {
	if (((a.memory[id + ArenaLinkField.MODE]! & ArenaLinkMode.WEAK) !== 0) === weak) return;
	arenaSubsDetach(a, id);
	arenaSubsAppend(a, id, weak);
}

/**
 * Kernel correspondence, an obligation (the arena half of CosignalEngine.ts's
 * "## Lineage" note): these `arena`-prefixed walks re-state
 * the kernel's push-pull algorithms over the arena layout — two
 * expressions of one algorithm, maintained together. A semantic
 * change on either side must be re-derived — not copied — on the other.
 *
 * Link maintenance follows the kernel's, plus the mode discipline, which
 * the kernel has no counterpart for and may not be transplanted bare:
 * the first occurrence of a dep in an evaluation sets the link's mode from
 * that occurrence's read kind (fresh and reused links alike — the in-place
 * and tail fast paths below perform the write); a later occurrence may only
 * upgrade weak→strong, never downgrade. Mode writes route through arenaSetLinkWeak:
 * under the segregated-list scheme a mode change moves the link between
 * the dep's strong and weak subs lists.
 */
function arenaLink(a: WorldArena, dep: number, sub: number, version: number, weak: boolean): void {
	const memory = a.memory;
	const prevDep = memory[sub + ArenaField.DEPS_TAIL]!;
	if (prevDep !== 0 && memory[prevDep + ArenaLinkField.DEP] === dep) {
		// Duplicate occurrence within this evaluation: strong dominates.
		if (!weak) arenaSetLinkWeak(a, prevDep, false);
		return;
	}
	const nextDep = prevDep !== 0 ? memory[prevDep + ArenaLinkField.NEXT_DEP]! : memory[sub + ArenaField.DEPS]!;
	if (nextDep !== 0 && memory[nextDep + ArenaLinkField.DEP] === dep) {
		// In-place reuse: first occurrence this evaluation — reset the mode.
		memory[nextDep + ArenaLinkField.VERSION] = version;
		arenaSetLinkWeak(a, nextDep, weak);
		memory[sub + ArenaField.DEPS_TAIL] = nextDep;
		return;
	}
	arenaLinkInsert(a, dep, sub, version, weak, prevDep, nextDep);
}

function arenaLinkInsert(a: WorldArena, dep: number, sub: number, version: number, weak: boolean, prevDep: number, nextDep: number): void {
	// Same-evaluation duplicate arriving via the insert path (nonadjacent
	// re-read): probe both mode tails; strong dominates.
	const sTail = a.memory[dep + ArenaField.SUBS_TAIL]!;
	if (sTail !== 0 && a.memory[sTail + ArenaLinkField.VERSION] === version && a.memory[sTail + ArenaLinkField.SUB] === sub) {
		return; // already strong this evaluation
	}
	const wTail = a.weakSubsTail[dep >> ArenaGeom.ID_TO_COLUMN_SHIFT]!;
	if (wTail !== 0 && a.memory[wTail + ArenaLinkField.VERSION] === version && a.memory[wTail + ArenaLinkField.SUB] === sub) {
		if (!weak) arenaSetLinkWeak(a, wTail, false); // upgrade weak→strong
		return;
	}
	const newLink = arenaAllocLink(a); // may grow the arena: re-load memory after
	const memory = a.memory;
	memory[sub + ArenaField.DEPS_TAIL] = newLink;
	memory[newLink + ArenaLinkField.VERSION] = version;
	memory[newLink + ArenaLinkField.DEP] = dep;
	memory[newLink + ArenaLinkField.SUB] = sub;
	memory[newLink + ArenaLinkField.PREV_DEP] = prevDep;
	memory[newLink + ArenaLinkField.NEXT_DEP] = nextDep;
	if (nextDep !== 0) memory[nextDep + ArenaLinkField.PREV_DEP] = newLink;
	if (prevDep !== 0) memory[prevDep + ArenaLinkField.NEXT_DEP] = newLink;
	else memory[sub + ArenaField.DEPS] = newLink;
	arenaSubsAppend(a, newLink, weak); // subs-side wiring + mode, on the matching list
}

function arenaUnlink(a: WorldArena, id: number, sub: number = a.memory[id + ArenaLinkField.SUB]!): number {
	const memory = a.memory;
	const dep = memory[id + ArenaLinkField.DEP]!;
	const prevDep = memory[id + ArenaLinkField.PREV_DEP]!;
	const nextDep = memory[id + ArenaLinkField.NEXT_DEP]!;
	if (nextDep !== 0) memory[nextDep + ArenaLinkField.PREV_DEP] = prevDep;
	else memory[sub + ArenaField.DEPS_TAIL] = prevDep;
	if (prevDep !== 0) memory[prevDep + ArenaLinkField.NEXT_DEP] = nextDep;
	else memory[sub + ArenaField.DEPS] = nextDep;
	arenaSubsDetach(a, id); // mode-matching subs list; the freed link keeps stale pointers for mid-walk readers
	arenaFreeLink(a, id);
	if (memory[dep + ArenaField.SUBS] === 0 && a.weakSubs[dep >> ArenaGeom.ID_TO_COLUMN_SHIFT] === 0 && (memory[dep + ArenaField.FLAGS]! & ArenaFlag.K_COMPUTED) !== 0) {
		// Unwatched computed shadow (both subs lists empty): mark stale, tear
		// down its own deps (in-world cascade — per-view acyclicity makes
		// this terminate).
		if (memory[dep + ArenaField.DEPS_TAIL] !== 0) {
			// Dirty-list append on the mark's 0→1 edge (the a.dirty contract;
			// the armed validator — tests/arena-checker.ts — enforces DIRTY ⇒
			// listed, and decay drops the torn shadow to cold from the list).
			// A last-sub unlink that tears a computed with deps sets DIRTY
			// here, so skipping the append would break the contract at
			// exactly this site.
			if ((memory[dep + ArenaField.FLAGS]! & ArenaFlag.DIRTY) === 0) {
				a.dirty.push(dep);
			}
			memory[dep + ArenaField.FLAGS] = memory[dep + ArenaField.FLAGS]! | ArenaFlag.DIRTY;
			arenaDisposeAllDepsInReverse(a, dep);
		}
	}
	return nextDep;
}

function arenaDisposeAllDepsInReverse(a: WorldArena, sub: number): void {
	let cur = a.memory[sub + ArenaField.DEPS_TAIL]!;
	while (cur !== 0) {
		const prev = a.memory[cur + ArenaLinkField.PREV_DEP]!;
		arenaUnlink(a, cur, sub);
		cur = prev;
	}
}

/** Bounds every arena chain/graph walk's step count — a longer walk can only
 * be a corrupted-list cycle, so the guards throw. Same-file const enum member
 * (not a module const): the comparison sits inside the hot walk loops and
 * must inline as a literal. */
const enum ArenaWalk {
	CYCLE_CAP = 1_000_000,
}

/** Purge links not re-tracked by the current evaluation (kernel discipline). */
function arenaPurgeDeps(a: WorldArena, sub: number): void {
	const depsTail = a.memory[sub + ArenaField.DEPS_TAIL]!;
	let dep = depsTail !== 0 ? a.memory[depsTail + ArenaLinkField.NEXT_DEP]! : a.memory[sub + ArenaField.DEPS]!;
	let guard = 0;
	while (dep !== 0) {
		if (++guard > ArenaWalk.CYCLE_CAP) throw new InvariantViolation(`arenaPurgeDeps: deps chain cycle at link ${dep} (shadow ${sub})`);
		dep = arenaUnlink(a, dep, sub);
	}
}


// Arena-walk scratch stacks (module-owned; the routing walks use the
// factory's own buffers instead).
let arenaPropStack = new Int32Array(WALK_STACK_SEED);
let arenaPropSp = 0;
let arenaCheckStack = new Int32Array(WALK_STACK_SEED);
let arenaCheckSp = 0;

/** Out-of-line cycle-cap thrower (keeps the walk arms' inline bytecode
 * free of the message-building code — cold by definition). */
function arenaWalkCycle(site: string, cur: number): never {
	throw new InvariantViolation(`${site}: walk exceeded ${ArenaWalk.CYCLE_CAP} steps (cycle) at link ${cur}`);
}

/** Propagate PENDING over strong and weak links
 * (weak links participate in mark propagation and drains — only the
 * write-time delivery walk skips them). Under the segregated-list scheme
 * each descended sub contributes two chains: the strong list is walked
 * first and the weak head is pushed as a pending continuation (the same
 * stack mechanism that holds sibling continuations). */
function arenaPropagate(a: WorldArena, startLink: number): void {
	const memory = a.memory; // never allocates: safe to cache
	let cur = startLink;
	let next = memory[cur + ArenaLinkField.NEXT_SUB]!;
	const stackBase = arenaPropSp;
	let guard = 0;
	top: do {
		if (++guard > ArenaWalk.CYCLE_CAP) arenaWalkCycle('arenaPropagate', cur);
		const sub = memory[cur + ArenaLinkField.SUB]!;
		let flags = memory[sub + ArenaField.FLAGS]!;
		if (!(flags & (ArenaFlag.RECURSED_CHECK | ArenaFlag.RECURSED | ArenaFlag.DIRTY | ArenaFlag.PENDING))) {
			memory[sub + ArenaField.FLAGS] = flags | ArenaFlag.PENDING;
		} else if (!(flags & (ArenaFlag.RECURSED_CHECK | ArenaFlag.RECURSED))) {
			flags = 0;
		} else if (!(flags & ArenaFlag.RECURSED_CHECK)) {
			memory[sub + ArenaField.FLAGS] = (flags & ~ArenaFlag.RECURSED) | ArenaFlag.PENDING;
		} else if (!(flags & (ArenaFlag.DIRTY | ArenaFlag.PENDING)) && arenaIsValidLink(a, cur, sub)) {
			memory[sub + ArenaField.FLAGS] = flags | (ArenaFlag.RECURSED | ArenaFlag.PENDING);
			flags &= ArenaFlag.MUTABLE;
		} else {
			flags = 0;
		}
		if (flags & ArenaFlag.MUTABLE) {
			let subSubs = memory[sub + ArenaField.SUBS]!;
			const subWeak = a.weakSubs[sub >> ArenaGeom.ID_TO_COLUMN_SHIFT]!;
			let park = 0; // the weak head, parked when both lists are populated
			if (subWeak !== 0) {
				if (subSubs === 0) subSubs = subWeak; // only weak dependents: descend into them
				else park = subWeak;
			}
			if (subSubs !== 0) {
				cur = subSubs;
				const nextSub = memory[cur + ArenaLinkField.NEXT_SUB]!;
				if (nextSub !== 0 || park !== 0) {
					if (arenaPropSp + 2 > arenaPropStack.length) {
						const bigger = new Int32Array(arenaPropStack.length * 2);
						bigger.set(arenaPropStack);
						arenaPropStack = bigger;
					}
					if (park !== 0) arenaPropStack[arenaPropSp++] = park;
					if (nextSub !== 0) {
						arenaPropStack[arenaPropSp++] = next;
						next = nextSub;
					}
				}
				continue;
			}
		}
		if ((cur = next) !== 0) {
			next = memory[cur + ArenaLinkField.NEXT_SUB]!;
			continue;
		}
		while (arenaPropSp > stackBase) {
			cur = arenaPropStack[--arenaPropSp]!;
			if (cur !== 0) {
				next = memory[cur + ArenaLinkField.NEXT_SUB]!;
				continue top;
			}
		}
		break;
	} while (true);
}

/** Head of a shadow's subs list by index: 0 = strong (arena links), 1 = weak
 * (the side column) — the one place the `for (list 0..1)` walk sites learn
 * where the two lists live. (arenaPropagateBoth/arenaShallowPropagateBoth below read the
 * heads directly: they are the write-fanout hot path.) */
function arenaSubsHead(a: WorldArena, sh: number, list: number): number {
	return list === 0 ? a.memory[sh + ArenaField.SUBS]! : a.weakSubs[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT]!;
}

/** Seed arenaPropagate over both of a shadow's subs lists (fanout sites). */
function arenaPropagateBoth(a: WorldArena, sh: number): void {
	const subs = a.memory[sh + ArenaField.SUBS]!;
	if (subs !== 0) arenaPropagate(a, subs);
	const weak = a.weakSubs[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT]!;
	if (weak !== 0) arenaPropagate(a, weak);
}

function arenaShallowPropagate(a: WorldArena, startLink: number): void {
	const memory = a.memory;
	let cur = startLink;
	let guard = 0;
	do {
		if (++guard > ArenaWalk.CYCLE_CAP) throw new InvariantViolation(`arenaShallowPropagate: subs chain cycle at link ${cur}`);
		const sub = memory[cur + ArenaLinkField.SUB]!;
		const flags = memory[sub + ArenaField.FLAGS]!;
		if ((flags & (ArenaFlag.PENDING | ArenaFlag.DIRTY)) === ArenaFlag.PENDING) {
			memory[sub + ArenaField.FLAGS] = flags | ArenaFlag.DIRTY;
			// Dirty-list append on the DIRTY 0→1 edge (the a.dirty contract:
			// DIRTY ⇒ listed — decay and drain seeding both stand on it).
			// Arenas serve mid-operation, so an upgraded
			// shadow can reach a boundary unconsumed and must be listed.
			a.dirty.push(sub);
		}
	} while ((cur = memory[cur + ArenaLinkField.NEXT_SUB]!) !== 0);
}

/** Shallow-propagate over both of a shadow's subs lists (weak dependents
 * take the PENDING→DIRTY upgrade too — drain validation coverage). */
function arenaShallowPropagateBoth(a: WorldArena, sh: number): void {
	const subs = a.memory[sh + ArenaField.SUBS]!;
	if (subs !== 0) arenaShallowPropagate(a, subs);
	const weak = a.weakSubs[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT]!;
	if (weak !== 0) arenaShallowPropagate(a, weak);
}

function arenaIsValidLink(a: WorldArena, checkLink: number, sub: number): boolean {
	const memory = a.memory;
	let cur = memory[sub + ArenaField.DEPS_TAIL]!;
	let guard = 0;
	while (cur !== 0) {
		if (++guard > ArenaWalk.CYCLE_CAP) throw new InvariantViolation(`arenaIsValidLink: prev-dep chain cycle at link ${cur}`);
		if (cur === checkLink) return true;
		cur = memory[cur + ArenaLinkField.PREV_DEP]!;
	}
	return false;
}

/**
 * The serve-override slot's non-arena occupant: while `serveOverride`
 * holds this marker, routed atom reads fold plain from their write logs in the
 * frame's world — no arena, no kernel shortcut — the armed divergence
 * checker's reference discipline (tests/arena-checker.ts compares arena
 * serves against these folds, so its reads must never consult the state
 * under check). Production never sets it; it exists so the routed-read hot
 * path tests one override slot instead of two.
 */
export const FOLD_TRUTH = Symbol('cosignals.foldTruth');

/** The arena record layout as plain numbers, restricted to the fields the
 * test-side structural validator reads (`ArenaCheckerInternals.layout`
 * — concurrent.ts documents the data-passing decision). Built here, in the
 * enums' own file, so the view is in sync by construction; a fresh object
 * per call, exactly as the in-class construction allocated. */
export function arenaCheckerLayout(): {
	readonly ArenaGeom: { readonly ID_TO_COLUMN_SHIFT: number; readonly CLOCK_LIMIT: number };
	readonly ArenaField: { readonly NODE: number; readonly MARK: number; readonly FLAGS: number; readonly DEPS: number; readonly SUBS: number };
	readonly ArenaLinkField: { readonly DEP: number; readonly SUB: number; readonly PREV_DEP: number; readonly NEXT_DEP: number; readonly NEXT_SUB: number; readonly MODE: number };
	readonly ArenaLinkMode: { readonly WEAK: number };
	readonly ArenaFlag: { readonly DIRTY: number; readonly BOX_SUSPENDED: number };
} {
	return {
		ArenaGeom: { ID_TO_COLUMN_SHIFT: ArenaGeom.ID_TO_COLUMN_SHIFT, CLOCK_LIMIT: ArenaGeom.CLOCK_LIMIT },
		ArenaField: { NODE: ArenaField.NODE, MARK: ArenaField.MARK, FLAGS: ArenaField.FLAGS, DEPS: ArenaField.DEPS, SUBS: ArenaField.SUBS },
		ArenaLinkField: { DEP: ArenaLinkField.DEP, SUB: ArenaLinkField.SUB, PREV_DEP: ArenaLinkField.PREV_DEP, NEXT_DEP: ArenaLinkField.NEXT_DEP, NEXT_SUB: ArenaLinkField.NEXT_SUB, MODE: ArenaLinkField.MODE },
		ArenaLinkMode: { WEAK: ArenaLinkMode.WEAK },
		ArenaFlag: { DIRTY: ArenaFlag.DIRTY, BOX_SUSPENDED: ArenaFlag.BOX_SUSPENDED },
	};
}

/**
 * The arena serving/lifecycle layer — a factory in the kernel's own style:
 * closes over the arena registries (committed arenas by root, the shell
 * pool, the open evaluation frame, the routing-walk scratch) and assigns its
 * operation table onto the shared engine core record. Cross-module calls
 * (the World fold family, the fold-purity bracket, read-routing state) read
 * the core's late-bound slots at call time — never import-time references —
 * which is what closes the evaluate → arenaServe → foldAtom recursion.
 */
export function createWorldArena(core: EngineCore): void {
	// Stable resident columns/registries, aliased once (identity-shared).
	const nodeIndexToInternals = core.nodeIndexToInternals;
	const nodeToWatchers = core.nodeToWatchers;
	const lastWalk = core.lastWalk;
	const obsRefs = core.obsRefs;
	const syncObservedDeps = core.syncObservedDeps;
	const roots = core.roots;
	const rootToOpenRender = core.rootToOpenRender;
	/** Committed arenas, by root (consumer-populated life). */
	const rootToArena = core.rootToArena;
	/** Pooled released arena shells (buffers reused; claimGen bumped per tenancy). */
	const arenaPool = core.arenaPool;
	/** Initial arena size in ints (EngineResetOptions knob; defaults to the
	 * generous WORLD_ARENA_INIT_INTS reservation — tests shrink it to force
	 * mid-operation growth). */
	const arenaInitInts: ArenaInitInts = core.arenaInitInts;

	/** Open arena evaluation frame (piggybacked on the world evaluation or
	 * an arena-only refold): links record into arenaFrame at arenaFrameCycle.
	 * Flattened to scalars — one object per evaluation showed up in the
	 * cold-render gate. undefined arena ⇔ no frame. */
	let arenaFrame: WorldArena | undefined = undefined;
	let arenaFrameShadow = 0;
	let arenaFrameCycle = 0;

	function claimArena(kind: 'render' | 'committed', world: World, root: RootId): WorldArena {
		let a = arenaPool.pop();
		if (a === undefined) {
			a = new WorldArena(kind, world, root, arenaInitInts);
		} else {
			a.kind = kind;
			a.world = world;
			a.root = root;
			a.bumpsClocks = kind === 'committed'; // per-tenancy: the pool mixes kinds
		}
		a.alive = true;
		a.claimGen++;
		// Dense nodeToShadow: pre-size to the node population and keep it packed
		// (holey reads cost on the cold-read hot path; resolveShadow probes this
		// per read). arenaAllocShadow grows it densely past this watermark.
		const n = nodeIndexToInternals.length;
		for (let i = a.nodeToShadow.length; i < n; i++) a.nodeToShadow.push(0);
		return a;
	}

	/** Release an arena: buffer to the pool, claim generation bumped, columns
	 * dropped (payload release), dirty + suspended lists discarded (safe by
	 * the evict-don't-serve argument; nobody observes those cones). */
	function releaseArena(a: WorldArena): void {
		for (let i = 0; i < a.suspended.length; i++) core.suspendedCount--;
		a.alive = false;
		a.claimGen++;
		// Keep the side columns' CAPACITY across pool tenancies (a priced
		// cold-render saving): truncating to 0 forced claimArena + arenaAllocShadow to re-push
		// every element on every claim (~2k pushes per cold render). fill()
		// scrubs the same residue truncation would have dropped — value refs are
		// released (no pooled-arena leak), nodeToShadow reads 0 (= none), suspIdx
		// reads 0 (= not suspended) — while the packed length persists, so
		// the next tenancy's growth loops are no-ops up to this watermark.
		resetWorldArenaColumnsOnRelease(a); // generated: every declared column resets, by construction
		a.dirty.length = 0;
		a.suspended.length = 0;
		// Scrub the written record prefix so pooled buffers re-claim all-zero
		// past the burned record — arenaAllocShadow's fresh-record invariant (one
		// vectorized fill here beats per-field zeroing on every cold alloc,
		// and closes the pooled-residue class wholesale: nothing survives).
		a.memory.fill(0, 0, a.next);
		a.next = ArenaGeom.STRIDE;
		a.linkFree = 0;
		a.shadowFree = 0; // dead-shadow list dies with the tenancy (threads were zeroed above)
		a.links = 0;
		a.readClock = 0;
		a.cycle = 0;
		if (arenaPool.length < ARENA_POOL_CAP) arenaPool.push(a);
		// Reclamation retry trigger — whole-arena teardown clears open-render
		// membership and suspended-list membership for every member at once
		// (render end, arena release, quiesce sweep): re-attempt everything
		// skipped; each retry re-verifies all guards. Size-0 bail inside.
		reclaimRetryAllSkipped();
	}

	/**
	 * Settle a node's per-root committed clock after an OBSERVER CONSULT —
	 * the one clock-advance site of the world arenas (the plan's bump-table
	 * rows for per-root committed clocks, re-expressed consult-driven).
	 * Called by the observer machinery right after its committed evaluation
	 * of the node: the drains, the boundary re-check, the commit populator,
	 * and the capture reads. Compares the shadow's CURRENT folded value
	 * against the cutoff register — the value as of the last consult — with
	 * the node's own change rule (custom isEqual for computeds; sentinel
	 * payloads by identity), and moves the clock only on a change.
	 *
	 * Consult-driven ON PURPOSE, not fold-driven: committed-member writes
	 * are committed-visible immediately, so plain committed reads between
	 * boundaries legitimately refold shadow values. If refolds moved the
	 * clock, an unrelated read could consume a flip-flop's intermediate
	 * state and CHANGE which re-fires observers see — re-fire behavior would
	 * depend on read timing. Against the consult-owned cutoff register, a
	 * multi-write flip-flop within one consult window coalesces to nothing
	 * and one spanning consults re-fires (the at-least-once ruling's
	 * accepted spurious class) — deterministically, whoever reads in
	 * between. The reference model's per-(root, node) accepted-change
	 * counters refresh at exactly the mirrored sites, which is what keeps
	 * lockstep exact.
	 *
	 * A first consult (clock 0 — never consulted; evictions scrub back to 0)
	 * counts as changed. Returns the settled clock. Render arenas never
	 * settle (bumpsClocks — pin-frozen worlds have no committed clock).
	 */
	function settleObserverClock(a: WorldArena, node: AnyInternals): Clock {
		const sh = node.ix < a.nodeToShadow.length ? a.nodeToShadow[node.ix]! : 0;
		if (sh === 0 || !a.bumpsClocks) return 0;
		const vi = sh >> ArenaGeom.ID_TO_COLUMN_SHIFT;
		const v = a.vals[vi];
		const clock = a.clocks[vi]!;
		if (clock !== 0 && !core.isValueChanged(node, a.cutoffVals[vi], v)) return clock;
		a.cutoffVals[vi] = v;
		return (a.clocks[vi] = ++clockSource);
	}

	/** The capture sites' dep stamp: resolve the root's committed arena and
	 * settle the node's clock (a capture read IS an observer consult — the
	 * returned clock seeds the dep's lastValidatedAt). 0 when the root has
	 * no arena (an empty capture — deps imply the arena exists). */
	function committedDepStamp(rootId: RootId, node: AnyInternals): Clock {
		const a = rootToArena.get(rootId);
		return a === undefined ? 0 : settleObserverClock(a, node);
	}

	/** The arena of a world: render arenas ride the render record (claimed at
	 * renderStart; a dev assert below throws on dropped-arena touch);
	 * committed arenas
	 * materialize lazily at the root's first committed evaluation and persist
	 * for the root's consumer-populated life. */
	function getArena(world: World): WorldArena | undefined {
		if (world.kind === 'render') {
			const a = world.render.arena;
			if (a !== undefined && !a.alive) throw new InvariantViolation(`arena of render ${world.render.id} was reclaimed while still reachable`);
			return a;
		}
		if (world.kind !== 'committed') return undefined;
		let a = rootToArena.get(world.root);
		if (a === undefined) {
			// Never create the root record on a read.
			if (!roots.has(world.root)) return undefined;
			a = claimArena('committed', { kind: 'committed', root: world.root }, world.root);
			rootToArena.set(world.root, a);
		}
		return a;
	}

	function eachArena(fn: (a: WorldArena) => void): void {
		for (const a of rootToArena.values()) fn(a);
		for (const p of rootToOpenRender.values()) {
			if (p.arena !== undefined) fn(p.arena);
		}
	}

	/** Shadow lookup/create with the GEN id-tenancy validation (the stamp is
	 * the kernel record generation — one id space, one tenancy stamp): a
	 * dead-GEN shadow never serves — it is reset cold and re-tenanted. */
	function resolveShadow(a: WorldArena, node: AnyInternals, kindFlags: number): number {
		const ix = node.ix;
		let sh = ix < a.nodeToShadow.length ? a.nodeToShadow[ix]! : 0;
		const gen = getKernelGeneration(node.id); // one kernel-memory load per consult (priced by the bench trio)
		if (sh !== 0) {
			if (a.memory[sh + ArenaField.NODE_GEN] === gen) return sh;
			// Dead tenancy: evict, purge links (both directions, both subs
			// lists), refold under the new tenant — never serve the dead
			// node's value or fn.
			arenaEvictShadow(a, sh);
			a.memory[sh + ArenaField.FLAGS] = kindFlags;
			a.memory[sh + ArenaField.NODE_GEN] = gen;
			a.memory[sh + ArenaField.MARK] = 0;
			return sh;
		}
		sh = arenaAllocShadow(a, ix, kindFlags, gen);
		return sh;
	}

	/** Detach a shadow from its arena wholesale: deps in reverse, both subs
	 * lists, the suspended set, the cached value. Shared by resolveShadow's
	 * dead-tenancy re-key and disposeComputed's eager purge. */
	function arenaEvictShadow(a: WorldArena, sh: number): void {
		arenaDisposeAllDepsInReverse(a, sh);
		for (let list = 0; list < 2; list++) {
			let sl = arenaSubsHead(a, sh, list);
			while (sl !== 0) {
				const next = a.memory[sl + ArenaLinkField.NEXT_SUB]!;
				arenaUnlink(a, sl);
				sl = next;
			}
		}
		if ((a.memory[sh + ArenaField.FLAGS]! & ArenaFlag.BOX_SUSPENDED) !== 0) arenaUnsuspend(a, sh);
		scrubWorldShadowColumnsOnEvict(a, sh); // generated: value + clock slots clear together
	}

	/** Arena dep recording (arena fn-reader hook): first-occurrence mode
	 * reset + strong-dominates ride inside arenaLink. The pre-dedup
	 * observation capture rides the strong arm only (the observation union
	 * is strong-only). */
	function arenaRecordDep(dep: AnyInternals, weak: boolean): void {
		const a = arenaFrame;
		if (a === undefined) return;
		if (!weak) {
			const oc = core.obsCapture;
			if (oc !== undefined) oc.push(dep);
		}
		const sh = dep.kind === 'atom'
			? resolveShadow(a, dep, ArenaFlag.K_SIGNAL | ArenaFlag.MUTABLE)
			: resolveShadow(a, dep, ArenaFlag.K_COMPUTED);
		arenaLink(a, sh, arenaFrameShadow, arenaFrameCycle, weak);
	}

	/** The arena atom-propagation gate is Object.is over fold outputs: the
	 * atom's own `equals` already participated in the fold's stepwise
	 * equality, and world serving re-derives consumers on any fold-output
	 * motion — a custom comparator here could suppress propagation the fold
	 * path performs (dual-bookkeeping divergence by construction). The
	 * comparator-order rule — `isEqual(prev, next)`, previous value first,
	 * mirroring the kernel's own compare — binds the custom-equality
	 * computed record (arenaFoldOutcome's comparator arm). */
	function arenaIsValueEqual(prev: Value, next: Value): boolean {
		return Object.is(prev, next);
	}

	/** Suspended-list append on the box-suspended bit's 0→1; the per-shadow
	 * field stores the dense index (swap-remove compaction). */
	function arenaSuspend(a: WorldArena, sh: number): void {
		const vi = sh >> ArenaGeom.ID_TO_COLUMN_SHIFT;
		if (a.suspIdx[vi] !== 0) return; // already a member (value column just swaps sentinels)
		a.suspended.push(sh);
		a.suspIdx[vi] = a.suspended.length; // index + 1
		core.suspendedCount++;
	}

	/** Swap-remove at the stored index on the 1→0 clear: the list stays a
	 * dense set; the moved entry's stored index is updated. */
	function arenaUnsuspend(a: WorldArena, sh: number): void {
		const vi = sh >> ArenaGeom.ID_TO_COLUMN_SHIFT;
		const slot = a.suspIdx[vi]!;
		if (slot === 0) return;
		const last = a.suspended.length - 1;
		const moved = a.suspended[last]!;
		a.suspended[slot - 1] = moved;
		a.suspIdx[moved >> ArenaGeom.ID_TO_COLUMN_SHIFT] = slot;
		a.suspended.pop();
		a.suspIdx[vi] = 0;
		core.suspendedCount--;
		// Reclamation retry trigger — the suspended-list guard row clears at
		// the removal operation itself (unsuspension also happens during
		// ordinary refolds and dirty-list decay; carrying the check here
		// covers every exit path). Size-0 bail first.
		if (reclaimSkippedN !== 0) {
			const node = nodeIndexToInternals[a.memory[sh + ArenaField.NODE]!];
			if (node !== undefined) noteReclaimRetry(node.id);
		}
	}

	/** Exceptional outcome of an arena fn run (arenaUpdateComputed's catch):
	 * cache the thrown payload into the shadow with the BOX_THROWN bit — later
	 * serves rethrow it boxedRead-style (a thrown suspension re-runs once
	 * its thenable settles: the serve-site probe marks it DIRTY). */
	function arenaNoteThrow(a: WorldArena, sh: number, err: unknown): void {
		const memory = a.memory;
		const flags = memory[sh + ArenaField.FLAGS]!;
		const vi = sh >> ArenaGeom.ID_TO_COLUMN_SHIFT;
		arenaBumpReadClock(a);
		// (No clock movement here: the per-root committed clock is
		// consult-driven — see settleObserverClock. A thrown outcome reaches
		// observers only through evaluation paths that skip without settling,
		// so fold-time stamping would be timing-dependent dead weight.)
		if (err instanceof SuspendedRead) {
			a.vals[vi] = err;
			memory[sh + ArenaField.FLAGS] = (flags & ~(ArenaFlag.DIRTY | ArenaFlag.PENDING)) | ArenaFlag.VALID | ArenaFlag.HAS_BOX | ArenaFlag.BOX_SUSPENDED | ArenaFlag.BOX_THROWN;
			arenaSuspend(a, sh);
			return;
		}
		if ((flags & ArenaFlag.BOX_SUSPENDED) !== 0) arenaUnsuspend(a, sh);
		a.vals[vi] = err;
		memory[sh + ArenaField.FLAGS] = (flags & ~(ArenaFlag.DIRTY | ArenaFlag.PENDING | ArenaFlag.BOX_SUSPENDED)) | ArenaFlag.VALID | ArenaFlag.HAS_BOX | ArenaFlag.BOX_THROWN;
	}

	// ---- arena serving (world reads, checks, settlement refolds) ----

	/** Serve a node from an arena — the render/committed read path —
	 * refolding through the arena's own walks when marks or cold bases
	 * demand it. Refolds run under the arena-only routing override so
	 * raw-handle reads inside fns resolve to arena values too; frame-link
	 * sites feed the observation capture (raw reads have no reader hook). */
	function arenaServe(a: WorldArena, node: AnyInternals): Value {
		if (node.kind === 'atom') {
			const sh = resolveShadow(a, node, ArenaFlag.K_SIGNAL | ArenaFlag.MUTABLE);
			const memory = a.memory;
			const flags = memory[sh + ArenaField.FLAGS]!;
			if ((flags & ArenaFlag.VALID) === 0 || (flags & ArenaFlag.DIRTY) !== 0) {
				// Spike wAtomRead: a changed refold upgrades PENDING dependents
				// to DIRTY (shallow propagate, both subs lists) so their
				// re-check refolds them.
				if (arenaUpdateShadow(a, sh)) arenaShallowPropagateBoth(a, sh);
			}
			if (arenaFrame === a) {
				arenaLink(a, sh, arenaFrameShadow, arenaFrameCycle, false);
				const oc = core.obsCapture;
				if (oc !== undefined) oc.push(node);
			}
			return a.vals[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT];
		}
		const sh = resolveShadow(a, node, ArenaFlag.K_COMPUTED);
		const memory = a.memory;
		let flags = memory[sh + ArenaField.FLAGS]!;
		if ((flags & ArenaFlag.RECURSED_CHECK) !== 0) {
			throw core.createCycleError(node.name);
		}
		// Read-site self-heal probe (the pull half of settlement; mirrors
		// the kernel's boxedRead): a settled-but-not-yet-invalidated
		// suspension self-invalidates at the read, so a read after `await` is
		// deterministic even before the settle listener's microtask runs.
		if ((flags & ArenaFlag.BOX_SUSPENDED) !== 0) {
			const t = (a.vals[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT] as SuspendedRead).thenable as { status?: string };
			if (t.status !== undefined && t.status !== 'pending') {
				memory[sh + ArenaField.FLAGS] = flags | ArenaFlag.DIRTY;
				flags = memory[sh + ArenaField.FLAGS]!;
			}
		}
		if ((flags & ArenaFlag.MUTABLE) === 0) {
			arenaUpdateComputed(a, sh); // never evaluated in this arena: cold fold
		} else if (
			(flags & ArenaFlag.DIRTY) !== 0
			// Evicted-to-cold residue (decay / torn-cone dirt): VALID is
			// the "value column holds a folded value" bit — with it clear the
			// slot is evicted and must refold on consult, exactly as the atom
			// branch above does. MUTABLE alone only says "evaluated once".
			|| (flags & ArenaFlag.VALID) === 0
			|| ((flags & ArenaFlag.PENDING) !== 0 && arenaCheckDirty(a, a.memory[sh + ArenaField.DEPS]!, sh))
		) {
			if (arenaUpdateComputed(a, sh)) arenaShallowPropagateBoth(a, sh);
		} else if ((flags & ArenaFlag.PENDING) !== 0) {
			a.memory[sh + ArenaField.FLAGS] = flags & ~ArenaFlag.PENDING;
		}
		if (arenaFrame === a) {
			arenaLink(a, sh, arenaFrameShadow, arenaFrameCycle, false);
			const oc = core.obsCapture;
			if (oc !== undefined) oc.push(node);
		}
		const outFlags = a.memory[sh + ArenaField.FLAGS]!;
		// The boxedRead-style rethrow discipline: a thrown payload — plain
		// error, or a still-pending render-path
		// suspension — rethrows from the cache; a returned sentinel (background
		// suspensions fold to the sentinel value) serves
		// as a value, compared by identity (the still-pending rule, pinned in
		// tests/concurrent-battery.spec.ts).
		if ((outFlags & ArenaFlag.HAS_BOX) !== 0 && ((outFlags & ArenaFlag.BOX_SUSPENDED) === 0 || (outFlags & ArenaFlag.BOX_THROWN) !== 0)) {
			throw a.vals[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT];
		}
		return a.vals[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT];
	}

	/** Refold a shadow (atom fold or computed fn run);
	 * returns whether the world's value changed (the value cutoff). */
	function arenaUpdateShadow(a: WorldArena, sh: number): boolean {
		const flags = a.memory[sh + ArenaField.FLAGS]!;
		if ((flags & ArenaFlag.K_COMPUTED) !== 0) return arenaUpdateComputed(a, sh);
		const nid: NodeIndex = a.memory[sh + ArenaField.NODE]!;
		const atom = nodeIndexToInternals[nid] as AtomInternals;
		// Marked ⇒ refold unconditionally — no fingerprint shortcut.
		const next = core.foldAtom(atom, a.world);
		const vi = sh >> ArenaGeom.ID_TO_COLUMN_SHIFT;
		const prev = a.vals[vi];
		const prevValid = (flags & ArenaFlag.VALID) !== 0;
		a.memory[sh + ArenaField.FLAGS] = (flags & ~(ArenaFlag.DIRTY | ArenaFlag.PENDING)) | ArenaFlag.VALID;
		arenaBumpReadClock(a);
		// The shadow column always stores the fold's own output (dual
		// bookkeeping requires arena value ≡ fold, bit for bit); the
		// comparator gates propagation only. Reference preservation for
		// custom-equality computeds lives in arenaFoldOutcome.
		a.vals[vi] = next;
		if (prevValid && arenaIsValueEqual(prev, next)) {
			return false;
		}
		// (No clock movement here: the per-root committed clock is
		// consult-driven — settleObserverClock compares against the cutoff
		// register at the observer consults, so plain reads that refold this
		// shadow between boundaries cannot perturb observer re-fires.)
		return true;
	}

	/** Arena computed refold: the fn runs with the arena readers and the
	 * arena-only routing override. The evaluating world is
	 * set so raw-handle reads route. Observed nodes capture the strong deps
	 * of this run and re-point their retains afterward (the world-path
	 * retain re-point — see ObservationIndex.ts). */
	function arenaUpdateComputed(a: WorldArena, sh: number): boolean {
		const c = core; // one context load; field accesses below keep the one-load shape
		const nid: NodeIndex = a.memory[sh + ArenaField.NODE]!;
		const node = nodeIndexToInternals[nid] as ComputedInternals;
		a.memory[sh + ArenaField.DEPS_TAIL] = 0;
		a.memory[sh + ArenaField.FLAGS] = (a.memory[sh + ArenaField.FLAGS]! | ArenaFlag.MUTABLE | ArenaFlag.RECURSED_CHECK) & ~(ArenaFlag.RECURSED | ArenaFlag.DIRTY | ArenaFlag.PENDING);
		const savedFrameArena = arenaFrame;
		const savedFrameShadow = arenaFrameShadow;
		const savedFrameCycle = arenaFrameCycle;
		const savedRoute = c.serveOverride;
		const savedWorld = c.activeWorld;
		const savedSink = c.currentSink;
		const savedObsCapture = c.obsCapture;
		arenaFrame = a;
		arenaFrameShadow = sh;
		arenaFrameCycle = arenaBumpCycle(a);
		c.serveOverride = a;
		c.currentSink = 0;
		c.obsCapture = obsRefs[nid]! > 0 ? [] : undefined; // nid is the nodeIndex (the NODE column)
		c.setWorld(a.world);
		c.evalDepth++;
		const tr = c.trace; // paired eval hooks; end fires on throw too
		if (tr !== undefined) tr.evalStart(node, a.world);
		try {
			return arenaFoldOutcome(a, sh, node.fn(arenaTrackedReader, arenaUntrackedReader), node.isEqual);
		} catch (err) {
			arenaNoteThrow(a, sh, err);
			throw err;
		} finally {
			if (tr !== undefined) tr.evalEnd();
			const obsCaptured = c.obsCapture;
			c.evalDepth--;
			c.setWorld(savedWorld);
			c.obsCapture = savedObsCapture;
			c.currentSink = savedSink;
			c.serveOverride = savedRoute;
			arenaFrame = savedFrameArena;
			arenaFrameShadow = savedFrameShadow;
			arenaFrameCycle = savedFrameCycle;
			a.memory[sh + ArenaField.FLAGS] = a.memory[sh + ArenaField.FLAGS]! & ~ArenaFlag.RECURSED_CHECK;
			arenaPurgeDeps(a, sh);
			arenaBumpReadClock(a);
			if (obsCaptured !== undefined) arenaSyncObservationAfterRefold(node, obsCaptured);
		}
	}

	/** Observed-closure sync after an arena refold, out of line (keeps
	 * arenaUpdateComputed under the V8 inline budget; observed nodes only) —
	 * after every restore, so discovery evaluations run on a clean frame
	 * stack. A nested refold (inside an outer walk) has serveOverride
	 * restored to the outer arena; clear it around the sync so discovery's
	 * newest evaluations route newest. */
	function arenaSyncObservationAfterRefold(node: AnyInternals, captured: AnyInternals[]): void {
		const so = core.serveOverride;
		core.serveOverride = undefined;
		try {
			syncObservedDeps(node, captured);
		} finally {
			core.serveOverride = so;
		}
	}

	/** Fold epilogue of an arena computed refold, out of line from
	 * arenaUpdateComputed (a split that keeps the frame save/restore wrapper
	 * under V8's 460-bytecode inline budget): classify the fn's outcome —
	 * suspension sentinel or plain value — into the shadow's value column
	 * and outcome bits; returns the value cutoff. The caller cleared
	 * DIRTY/PENDING at entry, and its call sites own propagation. A returned
	 * sentinel clears the BOX_THROWN bit (it serves as a value; box→same-box by
	 * sentinel identity is unchanged — the still-pending rule).
	 * Custom-equality computeds compare through their policy
	 * comparator against the arena-local previous value — never the kernel
	 * slot — in the argument order `isEqual(prev, next)`, previous first
	 * (mirroring the
	 * kernel's writeAtom compare; comparators need not be equivalence
	 * relations, so the order is load-bearing). On unchanged, the previous
	 * reference is kept (write nothing). Equality never bridges an
	 * exceptional boundary: `prevValid` demands a plain previous value. */
	function arenaFoldOutcome(a: WorldArena, sh: number, value: Value, eq: Equals | undefined): boolean {
		const vi = sh >> ArenaGeom.ID_TO_COLUMN_SHIFT;
		const flags = a.memory[sh + ArenaField.FLAGS]!;
		if (value instanceof SuspendedRead) {
			const same = (flags & ArenaFlag.BOX_SUSPENDED) !== 0 && (flags & ArenaFlag.BOX_THROWN) === 0 && a.vals[vi] === value;
			a.vals[vi] = value;
			a.memory[sh + ArenaField.FLAGS] = (flags & ~ArenaFlag.BOX_THROWN) | ArenaFlag.VALID | ArenaFlag.HAS_BOX | ArenaFlag.BOX_SUSPENDED;
			arenaSuspend(a, sh);
			if (same) {
				return false;
			}
			return true; // a fresh suspension is a changed outcome (clock movement is consult-driven — settleObserverClock)
		}
		const prevValid = (flags & ArenaFlag.VALID) !== 0 && (flags & ArenaFlag.HAS_BOX) === 0;
		const changed = !(prevValid && (eq === undefined
			? Object.is(a.vals[vi], value)
			: arenaIsValueEqualCold(eq, a.vals[vi], value)));
		if ((flags & ArenaFlag.BOX_SUSPENDED) !== 0) arenaUnsuspend(a, sh);
		if (changed) {
			a.vals[vi] = value;
		}
		a.memory[sh + ArenaField.FLAGS] = (a.memory[sh + ArenaField.FLAGS]! & ~(ArenaFlag.HAS_BOX | ArenaFlag.BOX_SUSPENDED | ArenaFlag.BOX_THROWN)) | ArenaFlag.VALID;
		return changed;
	}

	/** The custom-equality compare, out of line (cold — custom-comparator
	 * users only; keeps arenaFoldOutcome's hot default arm closure-free and
	 * under its budget). Argument order: isEqual(prev, next) — see
	 * arenaFoldOutcome. */
	function arenaIsValueEqualCold(eq: Equals, prev: Value, next: Value): boolean {
		return core.runInFoldCallback(() => eq(prev, next));
	}

	const arenaTrackedReader: Reader = (dep) => {
		arenaRecordDep(dep, false);
		return arenaServe(arenaFrame!, dep);
	};

	const arenaUntrackedReader: Reader = (dep) => {
		arenaRecordDep(dep, true);
		const a = arenaFrame;
		arenaFrame = undefined; // untracked: dep's own reads link nowhere new
		try {
			return arenaServe(a!, dep);
		} finally {
			arenaFrame = a;
		}
	};

	/** Kernel `checkDirty` transliteration (arenaUpdateShadow can run getters —
	 * allocations and arena growth included, so the walk re-loads its
	 * `memory` local per iteration and reads `a.memory` fresh after every
	 * update call — the refold-family row of growWorldArenaBuffers'
	 * enumerated discipline). Entry wrapper: owns the scratch-stack base restore around the
	 * out-of-line walk so each piece stays under V8's 460-bytecode inline
	 * budget (the arena counterpart of the kernel checkDirty split). */
	function arenaCheckDirty(a: WorldArena, startLink: number, startSub: number): boolean {
		if (startLink === 0) return false;
		const stackBase = arenaCheckSp;
		try {
			return arenaCheckDirtyLoop(a, startLink, startSub);
		} finally {
			arenaCheckSp = stackBase;
		}
	}

	/** arenaUpdateShadow + sibling Pending->Dirty upgrade, shared by the descend
	 * and unwind arms of arenaCheckDirtyLoop. Heads are captured before the
	 * refold runs (it can rebuild the lists), as in the kernel's
	 * updateAndShallow; both subs lists take the upgrade. The
	 * kernel's single-sub skip ("the only sub is the walker itself") is
	 * unsound under the segregated lists — a validation walk can arrive via
	 * the other list, leaving a lone strong sub PENDING with no refold due
	 * (found by fuzzing: a weak-side validation refolded
	 * the shared dep and the strong-side consumer stale-served) — so both
	 * lists propagate unconditionally; the walker's own re-upgrade is a
	 * flag-guarded no-op. */
	function arenaUpdateAndShallow(a: WorldArena, node: number): boolean {
		const subs = a.memory[node + ArenaField.SUBS]!;
		const weak = a.weakSubs[node >> ArenaGeom.ID_TO_COLUMN_SHIFT]!;
		if (arenaUpdateShadow(a, node)) {
			if (subs !== 0) arenaShallowPropagate(a, subs);
			if (weak !== 0) arenaShallowPropagate(a, weak);
			return true;
		}
		return false;
	}

	/** The general arena walk, out of line (see arenaCheckDirty — the wrapper
	 * owns the arenaCheckSp restore, so a throwing fold unwinds through it). */
	function arenaCheckDirtyLoop(a: WorldArena, cur: number, sub: number): boolean {
		let checkDepth = 0;
		let dirty = false;
		let guard = 0;
		top: do {
			if (++guard > ArenaWalk.CYCLE_CAP) arenaWalkCycle('arenaCheckDirty', cur);
			const memory = a.memory;
			const dep = memory[cur + ArenaLinkField.DEP]!;
			const depFlags = memory[dep + ArenaField.FLAGS]!;
			if ((memory[sub + ArenaField.FLAGS]! & ArenaFlag.DIRTY) !== 0) {
				dirty = true;
			} else if (
				(depFlags & (ArenaFlag.MUTABLE | ArenaFlag.DIRTY)) === (ArenaFlag.MUTABLE | ArenaFlag.DIRTY)
				// Cold base (decay evicted the value: MUTABLE kept, VALID
				// cleared, column dropped) — the walk-side counterpart of
				// arenaServe's
				// evicted-to-cold arm: with no folded value there is nothing to
				// validate against, so a cold dep is dirt and must refold on
				// consult. Without this arm a cold base is invisible (neither
				// DIRTY nor PENDING) and a top-first serve stale-serves its
				// cone (pinned in tests/arena-sa3.spec.ts).
				|| (depFlags & (ArenaFlag.MUTABLE | ArenaFlag.VALID)) === ArenaFlag.MUTABLE
			) {
				if (arenaUpdateAndShallow(a, dep)) {
					dirty = true;
				}
			} else if ((depFlags & (ArenaFlag.MUTABLE | ArenaFlag.PENDING)) === (ArenaFlag.MUTABLE | ArenaFlag.PENDING)) {
				if (arenaCheckSp === arenaCheckStack.length) {
					const bigger = new Int32Array(arenaCheckStack.length * 2);
					bigger.set(arenaCheckStack);
					arenaCheckStack = bigger;
				}
				arenaCheckStack[arenaCheckSp++] = cur;
				cur = memory[dep + ArenaField.DEPS]!;
				sub = dep;
				++checkDepth;
				continue;
			}
			if (!dirty) {
				const nextDep = a.memory[cur + ArenaLinkField.NEXT_DEP]!;
				if (nextDep !== 0) {
					cur = nextDep;
					continue;
				}
			}
			while (checkDepth--) {
				cur = arenaCheckStack[--arenaCheckSp]!;
				if (dirty) {
					if (arenaUpdateAndShallow(a, sub)) {
						sub = a.memory[cur + ArenaLinkField.SUB]!;
						continue;
					}
					dirty = false;
				} else {
					a.memory[sub + ArenaField.FLAGS] = a.memory[sub + ArenaField.FLAGS]! & ~ArenaFlag.PENDING;
				}
				sub = a.memory[cur + ArenaLinkField.SUB]!;
				const nextDep = a.memory[cur + ArenaLinkField.NEXT_DEP]!;
				if (nextDep !== 0) {
					cur = nextDep;
					continue top;
				}
			}
			return dirty;
		} while (true);
	}

	// ---- fanout at the four flip sites + mark decay ----

	/** Mark the flipped atoms' shadows in one arena and propagate PENDING over
	 * strong and weak links, with the read-clock dedup: a still-DIRTY shadow
	 * whose MARK stamp equals the arena's clock has an already-marked cone
	 * that nothing re-validated since — re-propagation would be a no-op walk.
	 * Render arenas receive no log-entry-driven fanout, ever (render-world
	 * values are pin-frozen) — dev-asserted here; the one pin-exempt mark
	 * source is resource settlement (`fromSettlement`). */
	function fanAtomsToArena(a: WorldArena, atoms: AtomInternals[], fromSettlement: boolean): void {
		if (a.kind === 'render' && !fromSettlement) {
			throw new InvariantViolation('log-entry-flip fanout reached a render arena — render-world values are pin-frozen');
		}
		const memory = a.memory;
		for (let i = 0; i < atoms.length; i++) {
			const sh = a.nodeToShadow[atoms[i]!.ix] ?? 0;
			if (sh === 0) continue; // no shadow: nothing consumes this atom here
			const flags = memory[sh + ArenaField.FLAGS]!;
			if ((flags & ArenaFlag.DIRTY) !== 0 && memory[sh + ArenaField.MARK] === a.readClock) continue; // dedup
			if ((flags & ArenaFlag.DIRTY) === 0) {
				memory[sh + ArenaField.FLAGS] = flags | ArenaFlag.DIRTY;
				a.dirty.push(sh); // dirty-list append on the mark's 0→1 edge
			}
			memory[sh + ArenaField.MARK] = a.readClock;
			arenaPropagateBoth(a, sh); // strong and weak
		}
	}

	/** Reused single-atom buffer for single-write fanout (no per-write alloc). */
	const oneAtom: AtomInternals[] = [];
	function getSingleAtomBuffer(atom: AtomInternals): AtomInternals[] {
		oneAtom[0] = atom;
		return oneAtom;
	}

	/** Fan into every live committed arena (retirement, quiet fold). */
	function fanAtomsToCommittedArenas(atoms: AtomInternals[]): void {
		if (rootToArena.size === 0) return; // the one scalar check quiet writes pay
		for (const a of rootToArena.values()) fanAtomsToArena(a, atoms, false);
	}

	/** Decay-by-eviction: swap the dirty list; an entry no evaluation
	 * consumed whose node has no live same-root watcher MAY drop to cold
	 * (evict the value, clear the mark) instead of re-appending — the dirty
	 * list stays bounded by live consumers' cones. A mark never clears
	 * without its refold having run or its value having been evicted. */
	function arenaDecay(a: WorldArena): void {
		if (a.dirty.length === 0) return;
		const list = a.dirty;
		a.dirty = [];
		const memory = a.memory;
		for (let i = 0; i < list.length; i++) {
			const sh = list[i]!;
			const flags = memory[sh + ArenaField.FLAGS]!;
			if ((flags & ArenaFlag.DIRTY) === 0) continue; // consumed by an evaluation: drop the entry
			const nid = memory[sh + ArenaField.NODE]!;
			const ws = nodeToWatchers[nid];
			// Keep-the-dirt while any live observer can still consume the
			// mark: a live same-root watcher on the node, or ANY observation
			// retain (obsRefs — a subscription's dep snapshot and every
			// transitively-retained cone node). The observation clause is
			// load-bearing under at-least-once observers: dropping an
			// observed shadow to cold would make its next refold a cold
			// materialization — a clock bump with no value change — and the
			// observer would re-fire spuriously where the reference model
			// (which retains every value by construction) does not.
			let watched = obsRefs[nid]! > 0;
			if (!watched && ws !== undefined) {
				for (let j = 0; j < ws.length; j++) {
					const w = ws[j]!;
					if (w.live && w.root === a.root) {
						watched = true;
						break;
					}
				}
			}
			if (watched) {
				a.dirty.push(sh); // keep-the-dirt: unconsumed marks survive to the next boundary
			} else {
				// Drop-to-cold: evict the cached value, clear the mark; links and
				// MUTABLE stay so routing coverage survives (arena links are
				// current structure — they persist with the arena).
				if ((flags & ArenaFlag.BOX_SUSPENDED) !== 0) arenaUnsuspend(a, sh);
				memory[sh + ArenaField.FLAGS] = flags & ~(ArenaFlag.DIRTY | ArenaFlag.VALID | ArenaFlag.HAS_BOX | ArenaFlag.BOX_SUSPENDED | ArenaFlag.BOX_THROWN);
				a.vals[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT] = undefined;
			}
		}
	}

	/** Purge one nodeIndex's shadow from every live arena: evict, zero the
	 * record, unindex, and thread it onto the arena's dead-shadow free list.
	 * Shared by disposeComputed's eager teardown (the dispose→sweep window
	 * must not route through the dead shadow) and the record-free scrub
	 * (idempotent — an already-purged index reads shadow 0 and skips). */
	function purgeNodeFromArenas(ix: NodeIndex): void {
		eachArena((a) => {
			const sh = ix < a.nodeToShadow.length ? a.nodeToShadow[ix]! : 0;
			if (sh === 0) return;
			arenaEvictShadow(a, sh);
			// Zero the record and unindex: dirty-list residue reads an inert
			// record (FLAGS 0 — decay drops it); nothing routes here again.
			for (let f = 0; f < ArenaGeom.STRIDE; f++) a.memory[sh + f] = 0;
			a.nodeToShadow[ix] = 0;
			// Leak audit: thread the orphaned record onto the arena's
			// dead-shadow free list so recreation churn (the useComputed
			// dispose→create pattern) reuses it instead of growing a live
			// arena's record storage without bound. Stale dirty-list entries
			// naming it stay benign: pre-reuse they read FLAGS 0 (dropped),
			// post-reuse they alias the new tenant's listed entry (decay
			// re-checks flags per entry; duplicates cannot amplify).
			a.memory[sh + ArenaField.DEPS] = a.shadowFree;
			a.shadowFree = sh;
		});
	}

	/** A settlement's arena half (the settlement drain's per-arena scan —
	 * lives here so the suspended-list scan's flag/mark writes stay same-file
	 * with the layout enums): scan the dense suspended list for shadows whose
	 * box payload is this sentinel; each match marks DIRTY (listed), stamps
	 * the mark clock, and propagates PENDING over both subs lists (pin-exempt
	 * for render arenas — settlement is not a log-entry flip). Returns
	 * whether anything matched (the drain
	 * adds committed roots to its cone set); the read clock bumps once per
	 * matched arena, after the marks, exactly as the in-drain loop did. */
	function arenaInvalidateSettled(a: WorldArena, suspendSentinel: SuspendedRead): boolean {
		const list = a.suspended;
		const memory = a.memory;
		let matched = false;
		for (let j = 0; j < list.length; j++) {
			const sh = list[j]!;
			if (a.vals[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT] !== suspendSentinel) continue;
			const flags = memory[sh + ArenaField.FLAGS]!;
			if ((flags & ArenaFlag.DIRTY) === 0) {
				memory[sh + ArenaField.FLAGS] = flags | ArenaFlag.DIRTY;
				a.dirty.push(sh);
			}
			memory[sh + ArenaField.MARK] = a.readClock;
			arenaPropagateBoth(a, sh); // strong and weak; pin-exempt for render arenas
			matched = true;
		}
		if (matched) arenaBumpReadClock(a);
		return matched;
	}

	// ---- the routing walks (arenas are the routing authority) ----

	/** Reused routing-walk stack (walks are never re-entrant; holds arena
	 * shadow record ids during arena walks). */
	const walkStack: number[] = [];

	/** Collect the live watchers subscribed on one node, by nodeIndex (delivery walk). */
	function collectWatchersAt(nid: NodeIndex, found: Watcher[]): void {
		const ws = nodeToWatchers[nid];
		if (ws !== undefined) {
			for (let i = 0; i < ws.length; i++) {
				const w = ws[i]!;
				if (w.live) found.push(w);
			}
		}
	}

	/** Collect the live same-root watchers subscribed on one node, by nodeIndex (drains). */
	function collectRootWatchersAt(nid: NodeIndex, rootId: RootId, ws: Watcher[]): void {
		const nw = nodeToWatchers[nid];
		if (nw !== undefined) {
			for (let j = 0; j < nw.length; j++) {
				const w = nw[j]!;
				if (w.live && w.root === rootId) ws.push(w);
			}
		}
	}

	/** One arena's half of the delivery walk: DFS over the strong subs lists
	 * (the segregated weak lists are never visited — the untracked-fan
	 * gate's prize) with per-arena shadow stamps for traversal termination
	 * and the global per-node stamps for collection dedup. Dead-GEN residue
	 * never routes. Never allocates or folds: a.memory/a.walk stable. */
	function walkArenaStrong(a: WorldArena, from: NodeIndex, kGen: Generation, gen: WalkGen, found: Watcher[]): void {
		const start = from < a.nodeToShadow.length ? a.nodeToShadow[from]! : 0;
		if (start === 0) return;
		if (a.memory[start + ArenaField.NODE_GEN] !== kGen) return;
		const memory = a.memory;
		const walk = a.walk;
		const stack = walkStack;
		let sp = 0;
		walk[start >> ArenaGeom.ID_TO_COLUMN_SHIFT] = gen;
		stack[sp++] = start;
		while (sp > 0) {
			const sh = stack[--sp]!;
			let l = memory[sh + ArenaField.SUBS]!;
			while (l !== 0) {
				const sub = memory[l + ArenaLinkField.SUB]!;
				if (walk[sub >> ArenaGeom.ID_TO_COLUMN_SHIFT] !== gen) {
					walk[sub >> ArenaGeom.ID_TO_COLUMN_SHIFT] = gen;
					stack[sp++] = sub;
					const nid = memory[sub + ArenaField.NODE]!;
					if (lastWalk[nid] !== gen) {
						lastWalk[nid] = gen;
						collectWatchersAt(nid, found);
					}
				}
				l = memory[l + ArenaLinkField.NEXT_SUB]!;
			}
		}
	}

	/** The durable drain's candidate collection, the arena-walking
	 * half of drainCommittedObservers — same-file with the layout enums: the
	 * root arena's dirty list seeds a walk over all arena links, strong and
	 * weak (drains expand over both; a weak hop's strong dependents
	 * expand past it too, since the walk keeps going), collecting live
	 * same-root watchers on visited nodes with the global per-node stamps
	 * for collection dedup. No folds or allocations run inside the walk, so
	 * a.memory/a.walk are stable to cache. The resident drain owns the gen
	 * bump, the restaled union, the id-order sort, and the correction loop. */
	function arenaCollectDrainCandidates(a: WorldArena, gen: WalkGen, rootId: RootId, ws: Watcher[]): void {
		const memory = a.memory;
		const walk = a.walk;
		const stack = walkStack;
		let sp = 0;
		const list = a.dirty;
		for (let i = 0; i < list.length; i++) {
			const sh = list[i]!;
			if (walk[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT] === gen) continue;
			walk[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT] = gen;
			stack[sp++] = sh;
			const nid = memory[sh + ArenaField.NODE]!;
			if (lastWalk[nid] !== gen) {
				lastWalk[nid] = gen;
				collectRootWatchersAt(nid, rootId, ws);
			}
		}
		while (sp > 0) {
			const sh = stack[--sp]!;
			// Both subs lists: drains expand over weak links too.
			for (let list = 0; list < 2; list++) {
				let l = arenaSubsHead(a, sh, list);
				while (l !== 0) {
					const sub = memory[l + ArenaLinkField.SUB]!;
					if (walk[sub >> ArenaGeom.ID_TO_COLUMN_SHIFT] !== gen) {
						walk[sub >> ArenaGeom.ID_TO_COLUMN_SHIFT] = gen;
						stack[sp++] = sub;
						const nid = memory[sub + ArenaField.NODE]!;
						if (lastWalk[nid] !== gen) {
							lastWalk[nid] = gen;
							collectRootWatchersAt(nid, rootId, ws);
						}
					}
					l = memory[l + ArenaLinkField.NEXT_SUB]!;
				}
			}
		}
	}

	/** One arena's reverse-deps half of the fixup closure (strong links).
	 * The arena's NODE column stores nodeIndexes (dense column keys), so
	 * visited shadows map back to NodeIds through the dense node row. */
	function collectArenaClosure(a: WorldArena, node: AnyInternals, closure: Set<NodeId>): void {
		const start = node.ix < a.nodeToShadow.length ? a.nodeToShadow[node.ix]! : 0;
		if (start === 0) return;
		if (a.memory[start + ArenaField.NODE_GEN] !== getKernelGeneration(node.id)) return; // dead-tenancy residue never routes
		const gen = ++core.walkGen;
		const memory = a.memory;
		const walk = a.walk;
		const stack = walkStack;
		let sp = 0;
		walk[start >> ArenaGeom.ID_TO_COLUMN_SHIFT] = gen;
		stack[sp++] = start;
		while (sp > 0) {
			const sh = stack[--sp]!;
			let l = memory[sh + ArenaField.DEPS]!;
			while (l !== 0) {
				if ((memory[l + ArenaLinkField.MODE]! & ArenaLinkMode.WEAK) === 0) {
					const dep = memory[l + ArenaLinkField.DEP]!;
					if (walk[dep >> ArenaGeom.ID_TO_COLUMN_SHIFT] !== gen) {
						walk[dep >> ArenaGeom.ID_TO_COLUMN_SHIFT] = gen;
						const depNode = nodeIndexToInternals[memory[dep + ArenaField.NODE]!];
						if (depNode !== undefined) closure.add(depNode.id);
						stack[sp++] = dep;
					}
				}
				l = memory[l + ArenaLinkField.NEXT_DEP]!;
			}
		}
	}

	/**
	 * One fold-truth evaluation frame (the armed checker's naive fn runs —
	 * the evaluator itself lives in tests/arena-checker.ts and reaches this
	 * only through `__checkerInternals`): the serve override becomes
	 * FOLD_TRUTH, so routed atom reads inside `fn` fold plain from their
	 * write logs and no arena-refold route survives into the frame — nothing
	 * routes back into the arena under check; the world is pinned for those
	 * folds' visibility; the fold-through sink and observation capture close
	 * (a checker read must never join a capture); the eval depth bumps
	 * (writes inside the frame throw, as in every world). Everything
	 * restores on the way out, throw or return.
	 */
	function runInFoldTruthFrame<T>(world: World, fn: () => T): T {
		const savedWorld = core.activeWorld;
		const savedRoute = core.serveOverride;
		const savedSink = core.currentSink;
		const savedObsCapture = core.obsCapture;
		core.setWorld(world);
		core.serveOverride = FOLD_TRUTH;
		core.currentSink = 0;
		core.obsCapture = undefined;
		core.evalDepth++;
		try {
			return fn();
		} finally {
			core.evalDepth--;
			core.obsCapture = savedObsCapture;
			core.currentSink = savedSink;
			core.serveOverride = savedRoute;
			core.setWorld(savedWorld);
		}
	}

	/**
	 * Diagnostics surface — never consulted by engine logic. The recorded
	 * dependency edges as dep → dependents (NodeIds — kernel record ids), materialized
	 * as the union of every live arena's links (strong and weak-flagged —
	 * the current structure the routing walks consult); read by: graphviz,
	 * the reference-model comparison tests, soak metrics. (Arena links persist across
	 * quiescence with their arenas: the links are current structure, not an
	 * episode log.)
	 */
	function dependencyEdges(): Map<NodeId, Set<NodeId>> {
		const out = new Map<NodeId, Set<NodeId>>();
		eachArena((a) => {
			const memory = a.memory;
			for (let ix = 0; ix < a.nodeToShadow.length; ix++) {
				const sh = a.nodeToShadow[ix]!;
				if (sh === 0) continue;
				const depNode = nodeIndexToInternals[ix];
				if (depNode === undefined) continue; // dead residue: not part of the live graph
				for (let list = 0; list < 2; list++) {
					let l = arenaSubsHead(a, sh, list);
					while (l !== 0) {
						const sub = memory[l + ArenaLinkField.SUB]!;
						const subNode = nodeIndexToInternals[memory[sub + ArenaField.NODE]!];
						if (subNode !== undefined) {
							let s = out.get(depNode.id);
							if (s === undefined) {
								s = new Set();
								out.set(depNode.id, s);
							}
							s.add(subNode.id);
						}
						l = memory[l + ArenaLinkField.NEXT_SUB]!;
					}
				}
			}
		});
		return out;
	}

	/** Test seam: a committed arena's (dep → sub) link mode, or undefined
	 * when no link exists (the mode-transition pins read it). @internal */
	function __arenaLinkMode(rootId: RootId, dep: AnyInternals, sub: AnyInternals): 'strong' | 'weak' | undefined {
		const a = rootToArena.get(rootId);
		if (a === undefined) return undefined;
		const depSh = a.nodeToShadow[dep.ix] ?? 0;
		const subSh = a.nodeToShadow[sub.ix] ?? 0;
		if (depSh === 0 || subSh === 0) return undefined;
		let cur = a.memory[subSh + ArenaField.DEPS]!;
		while (cur !== 0) {
			if (a.memory[cur + ArenaLinkField.DEP] === depSh) return (a.memory[cur + ArenaLinkField.MODE]! & ArenaLinkMode.WEAK) !== 0 ? 'weak' : 'strong';
			cur = a.memory[cur + ArenaLinkField.NEXT_DEP]!;
		}
		return undefined;
	}

	/** Test seam: a committed arena's live (dep → sub) link record id, or 0
	 * when no link exists (freelist-discipline pins capture ids before a
	 * teardown). @internal */
	function __arenaLinkIdForTest(rootId: RootId, dep: AnyInternals, sub: AnyInternals): number {
		const a = rootToArena.get(rootId);
		if (a === undefined) return 0;
		const depSh = a.nodeToShadow[dep.ix] ?? 0;
		const subSh = a.nodeToShadow[sub.ix] ?? 0;
		if (depSh === 0 || subSh === 0) return 0;
		let cur = a.memory[subSh + ArenaField.DEPS]!;
		while (cur !== 0) {
			if (a.memory[cur + ArenaLinkField.DEP] === depSh) return cur;
			cur = a.memory[cur + ArenaLinkField.NEXT_DEP]!;
		}
		return 0;
	}

	/** Test seam: raw NEXT_DEP field of an arena link record by id — valid
	 * on freed links too. The freelist-discipline regression pin asserts a
	 * freed link's stale nextDep still names its former
	 * neighbor, never the free list: arenaCheckDirty reads NEXT_DEP off links
	 * a mid-walk purge freed. @internal */
	function __arenaLinkNextDepForTest(rootId: RootId, linkId: number): number {
		const a = rootToArena.get(rootId);
		if (a === undefined) return -1;
		return a.memory[linkId + ArenaLinkField.NEXT_DEP] ?? -1;
	}

	// ---- the operation table (late-bound onto the shared core record) ----
	core.claimArena = claimArena;
	core.settleObserverClock = settleObserverClock;
	core.committedDepStamp = committedDepStamp;
	core.releaseArena = releaseArena;
	core.getArena = getArena;
	core.eachArena = eachArena;
	core.arenaServe = arenaServe;
	core.fanAtomsToArena = fanAtomsToArena;
	core.fanAtomsToCommittedArenas = fanAtomsToCommittedArenas;
	core.getSingleAtomBuffer = getSingleAtomBuffer;
	core.arenaDecay = arenaDecay;
	core.purgeNodeFromArenas = purgeNodeFromArenas;
	core.arenaInvalidateSettled = arenaInvalidateSettled;
	core.walkArenaStrong = walkArenaStrong;
	core.collectWatchersAt = collectWatchersAt;
	core.arenaCollectDrainCandidates = arenaCollectDrainCandidates;
	core.collectArenaClosure = collectArenaClosure;
	core.runInFoldTruthFrame = runInFoldTruthFrame;
	core.dependencyEdges = dependencyEdges;
	core.__arenaLinkMode = __arenaLinkMode;
	core.__arenaLinkIdForTest = __arenaLinkIdForTest;
	core.__arenaLinkNextDepForTest = __arenaLinkNextDepForTest;
}

// ---- observer records --------------------------------------------------------------
// Watchers (and, in the section below this one, subscriptions) are the
// engine's OBSERVER records: per-consumer state stored as kernel
// node-allocator records plus side-column slots, exactly like signals and
// computeds. A watcher is one subscribed component instance — the record
// carries its watched-node binding, its delivery dedup word, and its
// liveness bit in Int32 fields (WatcherField); its last rendered value in
// the values column; its lastValidatedAt stamp in the clock column; and its
// cold oddments (name, root, the rendered-world snapshot) in the extras
// column. The handle class below is a lean reference: its own fields are
// the two ids, and every other property is an accessor over the record —
// so watcher state lives in arena/column storage while every consumer
// (the render lifecycle, the delivery walks, the bindings, the tests)
// keeps the property surface it always had. The render LIFECYCLE — mount,
// reveal, re-render, removal, commit — lives in the render-integration
// section below; this section owns only the record and its storage
// discipline.

/** The watcher liveness shift, assigned once per composition by the render
 * lifecycle factory (the render-integration section below): a live watcher
 * holds one observed-consumer ref on its watched node, and the assignee
 * carries that ref into the observation index, generation-checked (a stale
 * watcher's flips shift nothing). A module slot so the class needs no
 * per-instance closure and no captured composition state. */
let observerShift: ((w: Watcher, delta: 1 | -1) => void) | undefined;

/** The watcher's rendered-world snapshot: what the mounting render saw
 * (the render's slot sets copied by integer assignment). Stored flattened
 * in the watcher record's extras object; replaced wholesale at mount and at
 * every committed re-render. */
export type WatcherSnapshot = {
	renderPassId: RenderPassId;
	pin: Seq;
	maskBits: BatchSlotSet;
	includedBits: BatchSlotSet;
	rootCommitGen: CommitGen;
};

/** The extras-column object of a watcher record (see the generated column
 * roster): the cold oddments — name, owning root, and the flattened
 * rendered-world snapshot. One object per watcher, created at mount; the
 * snapshot setter rewrites the five snapshot fields in place (monomorphic,
 * allocation-free at commit). */
type WatcherExtras = {
	name: string;
	root: RootId;
	renderPassId: RenderPassId;
	pin: Seq;
	maskBits: BatchSlotSet;
	includedBits: BatchSlotSet;
	rootCommitGen: CommitGen;
};

/**
 * One subscribed component instance, as a handle over its arena record.
 * The two id fields are the only own state:
 *
 *  - `id` is the monotone watcher id (mount order). Deliveries and drains
 *    fire in id order — the reference model's map order — so the id is
 *    causal delivery metadata and never recycles (record ids do).
 *  - `rec` is the watcher's kernel arena record. Every mutable property
 *    below is an accessor over the record's fields and side-column slots,
 *    so the watcher's state lives in the arena and dies with the record
 *    (the free scrubs every column slot, by construction).
 *
 * Lifetime: created by the render lifecycle's mount (the render-integration
 * section's mountWatcher), freed by its drop (unmount, discard, removal) through
 * {@link Kernel.disposeObserver} — after the drop, the handle's accessors
 * read a dead (scrubbed, possibly re-tenanted) record and their answers are
 * unspecified; every engine path resolves watchers through the live stores
 * (the id map, the per-node index) before touching one, and the liveness
 * setter is edge-filtered so a dead handle's `live = false` is a no-op.
 */
export class Watcher {
	readonly id: WatcherId;
	/** The watcher's arena record (kind K_WATCHER — see WatcherField). @internal */
	readonly rec: NodeId;

	constructor(id: WatcherId, name: string, root: RootId, node: NodeId, nodeIx: NodeIndex, nodeRecordGen: Generation, value: Value, snapshot: WatcherSnapshot) {
		this.id = id;
		const rec = E.newObserver(NodeFlag.K_WATCHER);
		this.rec = rec;
		const memory = E.buffer();
		memory[rec + WatcherField.NODE] = node;
		memory[rec + WatcherField.NODE_GEN] = nodeRecordGen;
		memory[rec + WatcherField.NODE_IX] = nodeIx;
		values[rec >> ArenaShape.ID_TO_VALUE_SHIFT] = value;
		extras[rec >> ArenaShape.ID_TO_EXTRAS_SHIFT] = {
			name,
			root,
			renderPassId: snapshot.renderPassId,
			pin: snapshot.pin,
			maskBits: snapshot.maskBits,
			includedBits: snapshot.includedBits,
			rootCommitGen: snapshot.rootCommitGen,
		} satisfies WatcherExtras;
	}

	/** The watcher's extras object (cold oddments; see WatcherExtras). */
	private get x(): WatcherExtras {
		return extras[this.rec >> ArenaShape.ID_TO_EXTRAS_SHIFT] as WatcherExtras;
	}

	/** Diagnostic label (mutable: the bindings rename a watcher after mount —
	 * traces and error messages read it). */
	get name(): string {
		return this.x.name;
	}
	set name(v: string) {
		this.x.name = v;
	}

	/** Owning root (the delivery suppression and drain scoping read it). */
	get root(): RootId {
		return this.x.root;
	}

	/** The watched node record id (the component reads this node). */
	get node(): NodeId {
		return E.buffer()[this.rec + WatcherField.NODE]!;
	}

	/** The watched record's NODE_INDEX, cached at mount (slot-tied, so it
	 * never goes stale; `nodeRecordGen` decides whether the watched TENANCY
	 * is still alive). @internal */
	get nodeIx(): NodeIndex {
		return E.buffer()[this.rec + WatcherField.NODE_IX]!;
	}

	/** The watched record's tenancy generation (kernel GEN) at mount. Bare
	 * ids alias reused records: kernel record ids recycle through the free
	 * list, so every watcher→node resolution generation-checks this stamp
	 * and skips loudly on mismatch — a dormant watcher whose node died must
	 * never bind the record's next tenant. */
	get nodeRecordGen(): Generation {
		return E.buffer()[this.rec + WatcherField.NODE_GEN]!;
	}

	/** Per-(watcher, slot) delivery dedup bits, one int word: a second write
	 * in the same slot delivers again only if no scheduled-but-unstarted
	 * render will fold it anyway. */
	get dedupBits(): BatchSlotSet {
		return E.buffer()[this.rec + WatcherField.DEDUP_BITS]!;
	}
	set dedupBits(bits: BatchSlotSet) {
		E.buffer()[this.rec + WatcherField.DEDUP_BITS] = bits;
	}

	/** What the committed screen shows for this watcher — the rendered-value
	 * register (the record's values-column slot). NOT a re-fire gate: the
	 * at-least-once ruling decides corrections by clocks; this register
	 * survives because non-gating contracts read it — the bindings' mount
	 * value and resubscribe seed, ctx.previous feeding at commits, and the
	 * correction records' from/to payloads. */
	get lastRenderedValue(): Value {
		return values[this.rec >> ArenaShape.ID_TO_VALUE_SHIFT];
	}
	set lastRenderedValue(v: Value) {
		values[this.rec >> ArenaShape.ID_TO_VALUE_SHIFT] = v;
	}

	/** The watcher's lastValidatedAt stamp (the record's clock-column slot):
	 * the per-root committed clock of the watched node at the last moment
	 * the screen was known to agree with committed truth. Advance sites,
	 * per the at-least-once ruling: a committed render whose rendered value
	 * matched committed-now (the populator's cross-world check), and an
	 * urgent correction (the drain just reconciled the screen). 0 = never —
	 * a re-staled commit resets it to 0, which forces the next drain's
	 * correction (a folded shadow's clock is never 0). Corrections outside
	 * the committing render's own window gate on this stamp alone: clock
	 * mismatch means re-fire, no value comparison. */
	get lastValidatedAt(): Clock {
		return E.clocks()[this.rec >> ArenaShape.ID_TO_CLOCK_SHIFT]!;
	}
	set lastValidatedAt(c: Clock) {
		E.clocks()[this.rec >> ArenaShape.ID_TO_CLOCK_SHIFT] = c;
	}

	/** The rendered-world snapshot (see WatcherSnapshot). The getter serves
	 * the extras object itself (a structural superset); the setter rewrites
	 * the five snapshot fields in place — no allocation at commit. */
	get snapshot(): WatcherSnapshot {
		return this.x;
	}
	set snapshot(s: WatcherSnapshot) {
		const x = this.x;
		x.renderPassId = s.renderPassId;
		x.pin = s.pin;
		x.maskBits = s.maskBits;
		x.includedBits = s.includedBits;
		x.rootCommitGen = s.rootCommitGen;
	}

	/**
	 * Subscribed-for-delivery bit (NodeFlag.OBSERVER_LIVE on the record).
	 * The setter is the watcher half of the observation union
	 * (AtomOptions.effect): a live watcher holds one observed-consumer ref
	 * on its node, and the observation index carries that ref transitively —
	 * a watcher over an atom node retains that atom's lifecycle directly; a
	 * watcher over an engine computed retains every atom the computed's
	 * current evaluation (transitively) reads. Every liveness site routes
	 * through here — the commit layout loop and adoptRevealedMount reveals
	 * (engine side), and the reveal resubscribe / StrictMode orphan sweep /
	 * debounce-finalized unsubscribe (the React-bindings side, which flips
	 * this property directly) — so kernel subscribers and watchers count
	 * into one refcount, and same-tick flips coalesce in the kernel's
	 * microtask flush. Edge-filtered: re-asserting the current state is a
	 * no-op (which also makes a dead handle's `live = false` safe — a freed
	 * record's flags word is 0).
	 */
	get live(): boolean {
		return (E.buffer()[this.rec + WatcherField.FLAGS]! & NodeFlag.OBSERVER_LIVE) !== 0;
	}
	set live(value: boolean) {
		const memory = E.buffer();
		const flags = memory[this.rec + WatcherField.FLAGS]!;
		if (((flags & NodeFlag.OBSERVER_LIVE) !== 0) === value) {
			return;
		}
		memory[this.rec + WatcherField.FLAGS] = value ? flags | NodeFlag.OBSERVER_LIVE : flags & ~NodeFlag.OBSERVER_LIVE;
		const shift = observerShift;
		if (shift !== undefined) shift(this, value ? 1 : -1);
	}
}

/** Free a watcher's arena record (the render lifecycle's drop tail —
 * unmount, discard, removal). The free defers to the next operation
 * boundary (queued notifications may still hold the handle; its own id
 * fields stay readable), where the generated column scrub clears every
 * slot the record owned. */
function freeWatcherRecord(w: Watcher): void {
	E.disposeObserver(w.rec);
}

// ---- committed observers (subscriptions) -------------------------------------------
// The one core `run`-action consumer record — committed observers, the
// production useSignalEffect mechanism — and its whole lifecycle:
// registration, the capture frame that snapshots deps under the committed
// world, removal, the test-side replay surface, and the boundary
// revalidation. `deliver`-action consumers (component re-renders) are the
// Watcher records above; only the firing machinery is shared. Core
// `effect()`s hold no Subscription: they are real kernel effects, flushed
// by the eager kernel apply (their trace seam, logCoreEffectRun, lives with
// the engine surface's trace sites).

/** The extras-column object of a subscription record: the observer's cold
 * record state. Held BOTH by the extras column (the storage roster — the
 * slot scrubs at record free) and by the handle (one cached reference, so
 * the run/cleanup counters stay readable after removal — the suites read a
 * removed subscription's counters as tombstone diagnostics). */
type SubscriptionExtras = {
	name: string;
	root: RootId;
	/** Dep snapshot: the routed reads of the last run, in read order. */
	deps: { node: AnyInternals; value: Value }[];
	/** Snapshot nodes currently holding observation retains
	 * (re-pointed per run exactly like watcher obsDeps; see the observation
	 * index's shiftObservedCount).
	 * Node OBJECTS, not ids: a retained node's record can free and re-tenant
	 * while the stale reference lingers, and shiftObservedCount's identity
	 * guard is what keeps the eventual release from touching the new
	 * tenant. */
	obsDeps: Set<AnyInternals> | undefined;
	/** Test-configured body (re-run inline through the capture frame). */
	body: (() => void) | undefined;
	/** Last captured value (the last dep read). */
	lastValue: Value;
	runs: number;
	cleanups: number;
};

/**
 * One committed observer, as a handle over its arena record. A subscription
 * is a registration saying WHO is notified and IN WHICH WORLD its reads
 * resolve; `deps` is the (node, value) snapshot `captureRun` recorded under
 * the committed world of the subscription's root; re-checks are gated over
 * it and fire at the boundary operations (per-root commit, retirement,
 * settlement, quiet fold; one re-check per boundary operation, at the
 * boundary value, never while the subscription's own root has an open
 * render frame — deferred flips flush at that frame's close). `refire`
 * (adapter-registered) rides the operation-boundary notification queue and
 * lives in the fns column (the dormant-callback pattern); test-configured
 * subscriptions store a `body` and re-run it inline through the same
 * capture frame, so the model-comparison suites exercise the real
 * mechanism.
 *
 * Storage: own fields are the monotone subscription id (registration
 * order — the boundary scan's iteration order, i.e. the reference model's
 * map order; never recycles) and the kernel record id (kind
 * K_SUBSCRIPTION — see SubscriptionField). The record carries the liveness
 * bit and the dep-chain cursors; the cold state lives in the extras object
 * (cached on the handle — see SubscriptionExtras for why).
 */
export class Subscription {
	readonly id: SubscriptionId;
	/** The subscription's arena record (kind K_SUBSCRIPTION). @internal */
	readonly rec: NodeId;
	/** The extras object, cached (see SubscriptionExtras). @internal */
	private readonly x: SubscriptionExtras;

	constructor(id: SubscriptionId, name: string, root: RootId, refire: (() => void) | undefined) {
		this.id = id;
		const rec = E.newObserver(NodeFlag.K_SUBSCRIPTION | NodeFlag.OBSERVER_LIVE);
		this.rec = rec;
		fns[rec >> ArenaShape.ID_TO_FN_SHIFT] = refire;
		const x: SubscriptionExtras = {
			name,
			root,
			deps: [],
			obsDeps: undefined,
			body: undefined,
			lastValue: undefined,
			runs: 0,
			cleanups: 0,
		};
		extras[rec >> ArenaShape.ID_TO_EXTRAS_SHIFT] = x;
		this.x = x;
	}

	get name(): string {
		return this.x.name;
	}

	/** Owning root. */
	get root(): RootId {
		return this.x.root;
	}

	/** Dep snapshot: the routed reads of the last run, in read order. */
	get deps(): { node: AnyInternals; value: Value }[] {
		return this.x.deps;
	}
	set deps(v: { node: AnyInternals; value: Value }[]) {
		this.x.deps = v;
	}

	/** Adapter-owned refire (cleanup + body scheduling), queued at the
	 * operation boundary; undefined for test-configured subscriptions. Lives
	 * in the fns column — the dormant-callback pattern. */
	get refire(): (() => void) | undefined {
		return fns[this.rec >> ArenaShape.ID_TO_FN_SHIFT] as (() => void) | undefined;
	}

	/** Test-configured body (re-run inline through the capture frame). */
	get body(): (() => void) | undefined {
		return this.x.body;
	}
	set body(v: (() => void) | undefined) {
		this.x.body = v;
	}

	/** Last captured value (the last dep read). */
	get lastValue(): Value {
		return this.x.lastValue;
	}
	set lastValue(v: Value) {
		this.x.lastValue = v;
	}

	get runs(): number {
		return this.x.runs;
	}
	set runs(n: number) {
		this.x.runs = n;
	}

	get cleanups(): number {
		return this.x.cleanups;
	}
	set cleanups(n: number) {
		this.x.cleanups = n;
	}

	/** Subscribed bit (NodeFlag.OBSERVER_LIVE): flips at removal so queued
	 * refires no-op — nothing runs after teardown. Unlike a watcher's, this
	 * setter shifts no observation (subscription retains ride the dep
	 * snapshot's obsDeps re-point instead). A freed record's flags word is
	 * 0, so a dead handle reads not-live. */
	get live(): boolean {
		return (E.buffer()[this.rec + SubscriptionField.FLAGS]! & NodeFlag.OBSERVER_LIVE) !== 0;
	}
	set live(value: boolean) {
		const memory = E.buffer();
		const flags = memory[this.rec + SubscriptionField.FLAGS]!;
		memory[this.rec + SubscriptionField.FLAGS] = value ? flags | NodeFlag.OBSERVER_LIVE : flags & ~NodeFlag.OBSERVER_LIVE;
	}

	get obsDeps(): Set<AnyInternals> | undefined {
		return this.x.obsDeps;
	}
	set obsDeps(v: Set<AnyInternals> | undefined) {
		this.x.obsDeps = v;
	}
}

/** The core capture frame `captureRun` opens: while set (and no evaluation
 * world is on stack) routed reads resolve committed-for-root and append to
 * the dep snapshot. The FIELD lives on the shared engine core record (the
 * read-routing resolution consults it per routed read); the committed-
 * observers factory below is its one writer, through the core's
 * `setCaptureFrame`. Each entry carries the read's value (a capture
 * artifact: the trace records and `lastValue` serve it — it never gates a
 * re-fire) and the producer's committed clock AT THE READ (`stamp` — the
 * dep's lastValidatedAt seed; read-time, not frame-close-time, because an
 * effect body may WRITE mid-run and the boundary re-check must still see
 * that write as newer than the snapshot). */
export type CaptureFrame = { sub: Subscription; deps: { node: AnyInternals; value: Value; stamp: Clock }[] };

/** A node's per-root committed clock by nodeIndex (0 = never consulted).
 * Exported for the watcher correction gate and the commit populator's stamp
 * rule (the layout enums are same-file here; the consumers live with the
 * delivery walks and the render lifecycle). Reads the clock WITHOUT
 * settling: callers run after a consult site already settled it. */
export function committedNodeClock(a: WorldArena, ix: NodeIndex): Clock {
	const sh = ix < a.nodeToShadow.length ? a.nodeToShadow[ix]! : 0;
	return sh === 0 ? 0 : a.clocks[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT]!;
}

/** Free a subscription's dependency-link chain back to its arena's link
 * pool (recapture replaces the snapshot wholesale; removal tears it down).
 * The generated link scrub clears each link's clock slot on free. */
function freeObserverDepChain(a: WorldArena, sub: Subscription): void {
	const memory = E.buffer();
	let l = memory[sub.rec + SubscriptionField.DEP_HEAD]!;
	while (l !== 0) {
		const next = a.memory[l + ArenaLinkField.NEXT_DEP]!;
		arenaFreeLink(a, l);
		l = next;
	}
	memory[sub.rec + SubscriptionField.DEP_HEAD] = 0;
	memory[sub.rec + SubscriptionField.DEP_TAIL] = 0;
}

/**
 * Build a subscription's dependency chain from a completed capture: one
 * world-arena LINK record per dep read, in read order, threaded through the
 * subscription record's DEP_HEAD/DEP_TAIL cursors. Each link's clock slot
 * carries that dep's lastValidatedAt (the read-time stamp); its DEP field
 * caches the producer's shadow at capture (a diagnostic hint — the re-check
 * resolves the live shadow through nodeToShadow and falls back to
 * evaluation on any mismatch, so a re-keyed shadow can never serve a stale
 * skip). The links are ONE-SIDED on purpose: they live only on this chain,
 * never on any producer's subscriber list, so every existing walk —
 * delivery, mark propagation, drain candidate collection, the fixup
 * closure, the structural checker — sees exactly the structure it saw
 * before subscriptions had records at all (causal routing metadata is
 * untouched; the chain is revalidation state).
 */
function buildObserverDepChain(a: WorldArena, sub: Subscription, deps: { node: AnyInternals; value: Value; stamp: Clock }[]): void {
	freeObserverDepChain(a, sub);
	let head = 0;
	let tail = 0;
	for (let i = 0; i < deps.length; i++) {
		const d = deps[i]!;
		const l = arenaAllocLink(a); // may grow the arena: re-load memory after (ids threaded so far stay valid)
		const am = a.memory;
		am[l + ArenaLinkField.VERSION] = 0;
		am[l + ArenaLinkField.DEP] = d.node.ix < a.nodeToShadow.length ? a.nodeToShadow[d.node.ix]! : 0;
		am[l + ArenaLinkField.SUB] = 0; // one-sided: no subscriber-list membership, no owner shadow
		am[l + ArenaLinkField.PREV_SUB] = 0;
		am[l + ArenaLinkField.NEXT_SUB] = 0;
		am[l + ArenaLinkField.PREV_DEP] = tail;
		am[l + ArenaLinkField.NEXT_DEP] = 0;
		am[l + ArenaLinkField.MODE] = ArenaLinkMode.WEAK;
		a.clocks[l >> ArenaGeom.ID_TO_COLUMN_SHIFT] = d.stamp;
		if (tail !== 0) am[tail + ArenaLinkField.NEXT_DEP] = l;
		else head = l;
		tail = l;
	}
	const memory = E.buffer();
	memory[sub.rec + SubscriptionField.DEP_HEAD] = head;
	memory[sub.rec + SubscriptionField.DEP_TAIL] = tail;
}

/**
 * The committed-observers factory — a factory in the kernel's own style: it
 * closes over the subscription store and assigns its operation table onto
 * the shared engine core record (mount/capture/remove/replay + the boundary
 * revalidation the resident orchestration and the settlement drain reach as
 * table calls). The composition site (ConcurrentEngine.ts) runs it last;
 * `observation` is the observation index's slice (the dep-snapshot
 * re-pointer and the refcount shift that releases a removed snapshot's
 * retains).
 */
export function createCommittedObservers(core: EngineCore, observation: Pick<ObservationIndex, 'syncSubscriptionObservation' | 'shiftObservedCount'>): void {
	// Composition-time locals (the codegen doctrine): every function a warm
	// path calls binds once; mutable core state (trace, captureFrame, the
	// guards, the live count) stays plain field reads off the core record.
	const { evaluate, isValueChanged, root, setCaptureFrame } = core;
	const rootToOpenRender = core.rootToOpenRender;
	const { queueNotify, flushNotify } = core.notify;
	const { syncSubscriptionObservation, shiftObservedCount } = observation;
	const idToSubscription = new Map<SubscriptionId, Subscription>();
	let nextSubscriptionId = 1;

	/**
	 * Register a committed observer (the production `useSignalEffect`
	 * surface). Registration is illegal inside an open evaluation frame —
	 * the record is committed-consumer state; it must never exist for a
	 * discarded render attempt (the render-stack half of the guard is
	 * adapter-enforced, since "on a render call stack" is a host predicate).
	 * The caller then runs `captureRun` from the host's effect phase to take
	 * the first dep snapshot.
	 */
	function mountCommittedObserver(rootId: RootId, name: string, refire?: () => void): Subscription {
		if (core.evalDepth > 0 || core.inFoldCallback) {
			throw new ScheduleError('effect registration is illegal inside an open evaluation/fold frame');
		}
		const sub = new Subscription(nextSubscriptionId++ as SubscriptionId, name, rootId, refire);
		root(rootId);
		idToSubscription.set(sub.id, sub);
		core.committedSubCount += 1;
		return sub;
	}

	// (The test-side convenience constructors mountReactEffect /
	// mountReactEffectPick — 4-line compositions of mountCommittedObserver +
	// a `body` + captureRun — live in tests/helpers.ts. The `body` mechanism
	// itself stays here: it is the inline-run + event-creation path the
	// model-comparison suites drive.)

	/**
	 * Runs a subscription body under the core capture frame: the effective
	 * world becomes committed-for-root, every routed read (raw atom reads
	 * through the routed-read resolution, engine computed reads through
	 * `captureRead`) appends to the dep snapshot, and reads inside a
	 * computed's own evaluation stay the computed's (the evaluation world on
	 * stack outranks the frame). A mid-body throw installs the partial
	 * snapshot: the deps read before the throw are real dependencies. After
	 * the frame closes, the snapshot's observation retains re-point (effect
	 * deps count toward the observation union exactly like watcher closures
	 * — the observation index's shiftObservedCount).
	 */
	function captureRun(id: SubscriptionId, body: () => void): void {
		const sub = idToSubscription.get(id);
		if (sub === undefined) throw new ScheduleError(`unknown committed subscription ${id}`);
		if (core.captureFrame !== undefined) throw new ScheduleError('captureRun frames do not nest — one effect body runs at a time');
		if (core.evalDepth > 0) throw new ScheduleError('captureRun is illegal inside an open evaluation frame');
		const frame: CaptureFrame = { sub, deps: [] };
		setCaptureFrame(frame);
		try {
			body();
		} finally {
			setCaptureFrame(undefined);
			sub.deps = frame.deps;
			sub.lastValue = frame.deps.length === 0 ? undefined : frame.deps[frame.deps.length - 1]!.value;
			// The completed recapture is the ONE stamp-advance site a
			// subscription has: rebuild the dependency-link chain (each
			// link's clock slot = that dep's read-time producer stamp).
			// deps.length > 0 implies the committed arena exists — the
			// capture's own evaluations materialized it.
			const a = core.rootToArena.get(sub.root);
			if (a !== undefined) buildObserverDepChain(a, sub, frame.deps);
			// Observation re-point after the frame closes, so discovery
			// evaluations run on a clean frame stack (same rule as
			// syncObservedDeps).
			syncSubscriptionObservation(sub);
		}
	}

	/** A routed read inside an open capture frame (node form: test-configured
	 * bodies land here; raw kernel atom and computed reads route through the
	 * routed-read seams instead, which push the same dep-snapshot entries). */
	function captureRead(node: AnyInternals): Value {
		const frame = core.captureFrame;
		if (frame === undefined) throw new ScheduleError('captureRead requires an open captureRun frame');
		const v = evaluate(node, { kind: 'committed', root: frame.sub.root });
		frame.deps.push({ node, value: v, stamp: core.committedDepStamp(frame.sub.root, node) });
		return v;
	}

	/**
	 * Remove a subscription (unmount / teardown). Cleanup invocation is the
	 * REGISTRAR's job (the adapter runs the user cleanup; test
	 * configurations count it here) — guaranteed at unmount, while a make-up
	 * fire is not. Nothing may run after teardown: the record's liveness bit
	 * clears with the record (queued refires check it and no-op), the
	 * observation retains release, and the record frees at the next boundary
	 * sweep. The handle's cached extras keep the final counters readable —
	 * a removed subscription's tombstone diagnostics.
	 */
	function removeSubscription(id: SubscriptionId): void {
		const sub = idToSubscription.get(id);
		if (sub === undefined) throw new ScheduleError(`unknown subscription ${id}`);
		idToSubscription.delete(id);
		core.committedSubCount -= 1;
		sub.cleanups++;
		const tr = core.trace;
		if (tr !== undefined) tr.reactEffectCleanup(sub.name, sub.root);
		// Release the snapshot's observation retains.
		const held = sub.obsDeps;
		if (held !== undefined) {
			sub.obsDeps = undefined;
			for (const dep of held) shiftObservedCount(dep, -1);
		}
		// Free the dependency-link chain back to its arena (the arena is
		// alive while the subscription counted as a consumer; defensive
		// probe anyway — a reset tears both down wholesale).
		const a = core.rootToArena.get(sub.root);
		if (a !== undefined) freeObserverDepChain(a, sub);
		// Record free LAST (flags zero immediately — `live` reads false, so
		// queued refires no-op; the free itself defers to the boundary sweep).
		E.disposeObserver(sub.rec);
	}

	/** Test surface — StrictMode-style replay: cleanup + unconditional
	 * re-run + recapture. Illegal while the subscription's root has an open
	 * render frame (React double-invokes effects post-commit, never
	 * mid-render). */
	function replayReactEffect(id: SubscriptionId): void {
		const sub = idToSubscription.get(id);
		if (sub === undefined) throw new ScheduleError(`unknown react effect ${id}`);
		if (rootToOpenRender.has(sub.root)) {
			throw new ScheduleError('replay requires the effect root to have no open render frame');
		}
		runCommittedSubscription(sub);
		flushNotify();
	}

	/** The inline re-fire (test-configured `body` subscriptions): cleanup +
	 * body re-run through the real capture frame + records
	 * (adapter-registered subscriptions instead queue their refire to the
	 * operation boundary — the adapter owns the body run). */
	function runCommittedSubscription(sub: Subscription): void {
		if (sub.refire !== undefined) {
			queueNotify(3, undefined, undefined, 0, sub);
			return;
		}
		sub.cleanups++;
		const tr = core.trace;
		if (tr !== undefined) tr.reactEffectCleanup(sub.name, sub.root);
		const body = sub.body;
		if (body !== undefined) captureRun(sub.id, body);
		sub.runs++;
		// The dep-values array is the one per-record payload a site allocates,
		// and only under the guard: the model-comparison suites compare it
		// entry by entry, so the record must carry the real snapshot.
		if (tr !== undefined) tr.reactEffectRun(sub.name, sub.root, sub.lastValue, sub.deps.map((d) => d.value));
	}

	/**
	 * The boundary re-check: once per boundary OPERATION — per-root commit,
	 * retirement, settlement, quiet fold — over each subscription's dep
	 * snapshot, at the boundary value (multiple member writes coalesce), and
	 * never while the subscription's own root has an open render frame (the
	 * deferred flip flushes at that frame's close — commit or discard). A
	 * retirement re-checks every root (a write-free retirement still flushes
	 * pending member-write flips); a plain commit re-checks its own root.
	 * Runs at the END of the boundary operation, after every committed-side
	 * mutation of the boundary has landed (the same mutate-then-notify
	 * ordering every boundary shares).
	 *
	 * The per-dep decision is the at-least-once clock rule (owner ruling —
	 * no value comparison anywhere in it):
	 *
	 *  1. FAST NEGATIVE GUARD — skip without evaluating when the producer is
	 *     provably unmoved: its shadow is CLEAN (VALID, no DIRTY/PENDING
	 *     marks, no boxed outcome), its tenancy stamp matches the live
	 *     kernel record, the chain link still names it, and its per-root
	 *     committed clock equals the dep's lastValidatedAt. Clean means no
	 *     committed flip has marked the cone since the last refold, so the
	 *     fold — and therefore the clock — cannot have moved.
	 *  2. Otherwise EVALUATE (the arena refold settles the producer's clock;
	 *     a net-equal refold keeps the old value AND the old clock — the
	 *     refold's own equality cutoff, where the node's custom isEqual
	 *     participates, is the only comparison in the pipeline). A
	 *     still-pending suspension thrown by the evaluation is not a flip
	 *     (pinned in tests/concurrent-battery.spec.ts): skip the dep without
	 *     touching its stamp — the settle transition moves the clock later.
	 *  3. RE-FIRE iff the settled clock differs from the dep's
	 *     lastValidatedAt. Net-no-change sequences whose intermediate states
	 *     were refolded (a flip-flop spanning boundaries) re-fire spuriously
	 *     BY ACCEPTED DESIGN; the stamp advances only through the re-fire's
	 *     recapture, never here.
	 */
	function revalidateCommittedSubscriptions(rootFilter: RootId | undefined): void {
		if (core.committedSubCount === 0) return;
		for (const sub of [...idToSubscription.values()]) {
			if (!sub.live) continue;
			if (rootFilter !== undefined && sub.root !== rootFilter) continue;
			if (rootToOpenRender.has(sub.root)) continue; // deferred to the frame's close
			const world: World = { kind: 'committed', root: sub.root };
			const a = core.rootToArena.get(sub.root);
			const memory = E.buffer();
			let changed = false;
			const deps = sub.deps;
			// The chain and the dep array are parallel by construction (both
			// written by the same capture close, one entry per read).
			let l = a === undefined ? 0 : memory[sub.rec + SubscriptionField.DEP_HEAD]!;
			for (let i = 0; i < deps.length && (a === undefined || l !== 0); i++) {
				const d = deps[i]!;
				const stamp = a === undefined ? 0 : a.clocks[l >> ArenaGeom.ID_TO_COLUMN_SHIFT]!;
				if (a !== undefined) {
					const sh = d.node.ix < a.nodeToShadow.length ? a.nodeToShadow[d.node.ix]! : 0;
					const vi = sh >> ArenaGeom.ID_TO_COLUMN_SHIFT;
					if (
						sh !== 0
						&& sh === a.memory[l + ArenaLinkField.DEP]
						&& (a.memory[sh + ArenaField.FLAGS]! & (ArenaFlag.VALID | ArenaFlag.DIRTY | ArenaFlag.PENDING | ArenaFlag.HAS_BOX)) === ArenaFlag.VALID
						&& a.memory[sh + ArenaField.NODE_GEN] === getKernelGeneration(d.node.id)
						&& a.clocks[vi] === stamp
						// The registers must agree: a plain committed read may
						// have refolded the shadow (consuming its marks) between
						// consults — the value drifted while the clock stood
						// still, and only the cutoff register knows. Identity
						// here is conservative: a comparator-equal fresh
						// reference just fails the guard and settles below.
						&& Object.is(a.cutoffVals[vi], a.vals[vi])
					) {
						l = a.memory[l + ArenaLinkField.NEXT_DEP]!;
						continue; // the fast negative guard: no evaluation, no comparison
					}
				}
				try {
					evaluate(d.node, world);
				} catch (err) {
					if (err instanceof SuspendedRead) {
						if (a !== undefined) l = a.memory[l + ArenaLinkField.NEXT_DEP]!;
						continue; // still-pending suspension: not a flip (pinned in tests/concurrent-battery.spec.ts; the clock stays unsettled — the settle transition decides)
					}
					throw err;
				}
				// The consult settles the producer's clock against the cutoff
				// register; re-fire on stamp mismatch.
				if (a !== undefined && core.settleObserverClock(a, d.node) !== stamp) {
					changed = true;
					break;
				}
				if (a !== undefined) l = a.memory[l + ArenaLinkField.NEXT_DEP]!;
			}
			if (changed) runCommittedSubscription(sub);
		}
	}


	// ---- the operation table (late-bound onto the shared core record) ----
	core.idToSubscription = idToSubscription;
	core.mountCommittedObserver = mountCommittedObserver;
	core.captureRun = captureRun;
	core.captureRead = captureRead;
	core.removeSubscription = removeSubscription;
	core.replayReactEffect = replayReactEffect;
	core.revalidateCommittedSubscriptions = revalidateCommittedSubscriptions;
}

// ---- render integration ------------------------------------------------------------

/**
 * Render passes and watchers — the render lifecycle of the concurrent
 * engine. A render pass is one render of one root: its pin is the timeline
 * position frozen at render start (the render folds nothing written after
 * it, so a paused-and-resumed render never drifts) and its mask is the set
 * of live batches the render is rendering. A watcher is one subscribed
 * component instance (the full vocabulary — write log, batch, slot, world,
 * arena — is defined at the top of concurrent.ts). This section owns:
 *
 *  - the `RenderPass` record and its whole lifecycle: start (pin + mask +
 *    arena claim), yield/resume, and end — the commit fan whose order is
 *    load-bearing (baseline capture → retire-at-commit folds → per-root
 *    lock-in with its drains → layout subscribe + mount fixups → the
 *    re-staled populator loop → deferred releases → arena drop → quiet
 *    recompute → subscription revalidation);
 *  - the watcher LIFECYCLE: mount/defer/reveal/re-render/removal, the
 *    rendered-world snapshot, and the one watcher→node resolution
 *    (`resolveWatcherInternals`, generation-checked — a dormant watcher whose
 *    node record died must never bind the record's next tenant). The
 *    Watcher RECORD itself lives in the observer-records section above;
 *  - per-root commit lock-in (`commitBatches`) — the single owner of a
 *    root's committed-state transition;
 *  - mount fixup — the commit-edge reconciliation for freshly mounted
 *    components — with its dependency-closure walks (arena legs through the
 *    core record; the kernel leg walks this module's own kernel layout
 *    enums, same-file).
 *
 * `createRenderPassManager` is a factory in the kernel's own style: it
 * closes over its state (the render/watcher id counters, the stale-skip
 * diagnostic) and reaches every other mechanism through the shared engine
 * core record's late-bound slots at call time (World evaluation, arena
 * claim/decay/fanout, the deliver walks' drains and corrections, Batch
 * retirement). The pass/watcher registries (`idToRenderPass`, `watchers`,
 * `nodeToWatchers`, `rootToOpenRender`) are core-carried shared containers:
 * this section owns every transition; the resident registry's gap-fill,
 * the record-free scrub, and the quiescence sweep read them in place.
 *
 * Per-world state discipline (owner ruling): the orchestration here reads
 * and writes world state ONLY through the narrow function set — the core
 * operation table (claim/release, evaluate, fanout, decay, drains, clock
 * settling, closure collection) and the named probes (committedNodeClock,
 * arenaHasShadow) — never through direct arena-memory access, so the
 * storage implementation behind that set can change without touching the
 * render lifecycle.
 */

export type RenderPassState = 'open' | 'yielded' | 'ended';

export type RenderPass = {
	id: RenderPassId;
	root: RootId;
	/** The pin — the timeline position frozen at render start; observed for the
	 * render's whole life, across yields, so a paused-and-resumed render never
	 * drifts. */
	pin: Seq;
	maskBatches: Set<BatchId>;
	/** The render's slot sets (bit i = slot i; BatchSlot < 31), fixed at render
	 * start: maskBits — slots of the render mask's written batches;
	 * includedBits — maskBits ∪ the root's committed slots captured at start
	 * (every batch this render is allowed to see). */
	maskBits: BatchSlotSet;
	includedBits: BatchSlotSet;
	state: RenderPassState;
	endKind: 'commit' | 'discard' | undefined;
	/** Watchers whose layout effects (subscribe + fixup) fire at this render's
	 * commit: its own mounts plus adopted reveals. Disjoint from `rendered`. */
	mounted: WatcherId[];
	/** Existing live watchers re-rendered by this render — re-renders only
	 * (disjoint from `mounted`; where render-end means the union it writes the
	 * union explicitly). */
	rendered: Set<WatcherId>;
	/** The render world's arena — its value+invalidation+routing
	 * layer (claimed at renderStart, dropped in reclaimAfterRenderEnd —
	 * engine-side only; the reference model has no counterpart). */
	arena?: WorldArena;
};

/** The resident-state edges the render lifecycle consumes (provided by the
 * engine's composition site), as a named slice of the observation index's
 * record type. */
export type RenderPassManagerDeps = {
	/** The observation index (ObservationIndex.ts): its refcount shift — the
	 * watcher liveness seam feeds it, generation-checked. */
	observation: Pick<ObservationIndex, 'shiftObservedCount'>;
};

export type RenderPassManager = {
	renderStart(rootId: RootId, includeBatches: BatchId[]): RenderPass;
	renderYield(id: RenderPassId): void;
	renderResume(id: RenderPassId): void;
	mountWatcher(renderPassId: RenderPassId, node: AnyInternals, name: string): Watcher;
	deferMountEffects(watcherId: WatcherId): void;
	adoptRevealedMount(renderPassId: RenderPassId, watcherId: WatcherId): void;
	renderWatcher(renderPassId: RenderPassId, watcherId: WatcherId): void;
	removeWatcher(watcherId: WatcherId): void;
	commitBatches(rootId: RootId, batches: Iterable<BatchId>): boolean;
	renderEnd(id: RenderPassId, kind: 'commit' | 'discard', opts?: { retireAtCommit?: BatchId[] }): void;
	dependencyClosureOf(nodeId: NodeId, render?: RenderPass): Set<NodeId>;
	/** Stale-watcher loud skips (the dormant-watcher aliasing pin) —
	 * diagnostics/test surface. */
	getStaleWatcherSkips(): number;
};

export function createRenderPassManager(core: EngineCore, deps: RenderPassManagerDeps): RenderPassManager {
	// Stable resident containers and tables, aliased once (identity-shared);
	// the observation shift binds once at composition (the codegen doctrine).
	const { shiftObservedCount } = deps.observation;
	const nodeIndexToInternals = core.nodeIndexToInternals;
	const idToRenderPass = core.idToRenderPass;
	const rootToOpenRender = core.rootToOpenRender;
	const watchers = core.watchers;
	const nodeToWatchers = core.nodeToWatchers;
	const batch = core.batch;
	const idToBatch = batch.idToBatch;
	const slots = batch.slots;
	const notify = core.notify;

	let nextRenderPassId = 1;
	let nextWatcher = 1;

	/** Stale-watcher loud skips (the dormant-watcher aliasing pin): every
	 * watcher→node
	 * resolution that missed — the watcher's record tenancy moved (freed,
	 * possibly reused) — and was skipped instead of silently binding the
	 * record's current tenant. Diagnostics/test surface. */
	let staleWatcherSkips = 0;

	/**
	 * The watcher→node resolution: the dense-row probe (by the watcher's
	 * mount-cached NODE_INDEX — record id and index are slot-tied, so the
	 * row is exactly what an id-keyed probe would have found) plus the
	 * generation check against the watcher's mount-time stamp. Every
	 * consumer site (commit activation, mount fixup, drains, deliveries'
	 * correction loops, observation flips) resolves through here; a miss
	 * means the watcher's node record died (a scrubbed row) — and its slot
	 * may already host a new tenant (the dormant-watcher aliasing case,
	 * which the GEN check catches) — so the site must skip, loudly, never
	 * bind. Tenancy generations only grow, so a stale stamp never
	 * re-validates.
	 */
	function resolveWatcherInternals(w: Watcher): AnyInternals | undefined {
		const node = w.nodeIx < nodeIndexToInternals.length ? nodeIndexToInternals[w.nodeIx] : undefined;
		if (node === undefined || getKernelGeneration(w.node) !== w.nodeRecordGen) {
			staleWatcherSkips++;
			return undefined;
		}
		return node;
	}

	/** The watcher liveness seam (one closure per engine, assigned into the
	 * observer-shift module slot beside the Watcher record — the
	 * Watcher.live setter reaches it there): generation-checked — a stale
	 * watcher's liveness flips shift nothing (skips pair up: tenancy
	 * generations only ever grow, so a stale stamp can never re-validate
	 * between a skipped retain and its release). Re-assigned by every
	 * composition; stale watchers from a dead composition reach the new
	 * shift, whose generation check no-ops them. */
	observerShift = (w: Watcher, delta: 1 | -1): void => {
		const node = resolveWatcherInternals(w);
		if (node !== undefined) shiftObservedCount(node, delta);
	};

	function getMinLivePin(): Seq {
		let min = Number.POSITIVE_INFINITY;
		for (const p of rootToOpenRender.values()) if (p.pin < min) min = p.pin;
		return min;
	}

	// ------------------------------------------------------ render lifecycle

	/**
	 * Open a render pass: pin frozen at start, render mask captured from
	 * live batches, committed set snapshotted — everything the render world
	 * folds is fixed here, so pause/resume cannot drift. One
	 * work-in-progress render per root (a same-root restart is a new render).
	 */
	function renderStart(rootId: RootId, includeBatches: BatchId[]): RenderPass {
		if (rootToOpenRender.has(rootId)) {
			throw new ScheduleError(`root ${rootId} already has an open render — one render pass per root at a time`);
		}
		const maskBatches = new Set<BatchId>();
		let maskBits = 0;
		for (const id of includeBatches) {
			const t = batch.getBatchById(id);
			if (t.state !== 'live') throw new ScheduleError('mask captures live batches only — a retired batch is already permanent history');
			maskBatches.add(id);
			// A live batch with no slot never wrote; if it writes later, those
			// log entries postdate this render's pin and the visibility rule's
			// included-up-to-pin clause excludes them anyway.
			if (t.slot !== undefined) maskBits |= 1 << t.slot;
		}
		// The committed-set capture materializes the root record (reference-model
		// parity: the model's committedSlotsNow() creates it on first consult).
		const includedBits = maskBits | core.root(rootId).committedBits;
		const render: RenderPass = {
			id: nextRenderPassId++, root: rootId, pin: core.getSeq(),
			maskBatches, maskBits, includedBits,
			state: 'open', endKind: undefined, mounted: [], rendered: new Set(),
		};
		// Claim the render's world arena from the pool — the render
		// world's value+invalidation+routing layer.
		render.arena = core.claimArena('render', { kind: 'render', render }, rootId);
		idToRenderPass.set(render.id, render);
		rootToOpenRender.set(rootId, render);
		core.recomputeQuiet(); // an open render: the pipeline is armed until it closes
		const tr = core.trace;
		if (tr !== undefined) {
			tr.renderStart(render);
			tr.opEnd();
		}
		return render;
	}

	function getRenderPassById(id: RenderPassId): RenderPass {
		return getOrThrow(idToRenderPass, id, 'render pass');
	}

	/** Yield/resume edges: while yielded, code that runs in the gap (event
	 * handlers, other renders) is "not in render" for this render. */
	function renderYield(id: RenderPassId): void {
		const p = getRenderPassById(id);
		if (p.state !== 'open') throw new ScheduleError('yield requires an open (running) render');
		p.state = 'yielded';
		const tr = core.trace;
		if (tr !== undefined) {
			tr.renderYield(p);
			tr.opEnd();
		}
	}

	function renderResume(id: RenderPassId): void {
		const p = getRenderPassById(id);
		if (p.state !== 'yielded') throw new ScheduleError('resume requires a yielded render');
		p.state = 'open';
		const tr = core.trace;
		if (tr !== undefined) {
			tr.renderResume(p);
			tr.opEnd();
		}
	}

	/** Mount a new watcher inside an open render; it renders in the render's world. */
	function mountWatcher(renderPassId: RenderPassId, node: AnyInternals, name: string): Watcher {
		const p = getRenderPassById(renderPassId);
		if (p.state === 'ended') throw new ScheduleError('mount requires an open render');
		const value = core.evaluate(node, { kind: 'render', render: p });
		const watcher = new Watcher(nextWatcher++, name, p.root, node.id, node.ix, getKernelGeneration(node.id), value, {
			renderPassId: p.id, pin: p.pin,
			maskBits: p.maskBits, includedBits: p.includedBits,
			rootCommitGen: core.root(p.root).commitGen,
		});
		watchers.set(watcher.id, watcher);
		let nodeWatchers = nodeToWatchers[node.ix];
		if (nodeWatchers === undefined) {
			nodeWatchers = [];
			nodeToWatchers[node.ix] = nodeWatchers;
		}
		nodeWatchers.push(watcher);
		p.mounted.push(watcher.id); // mounts never join `rendered` (the collections are disjoint)
		return watcher;
	}

	/**
	 * Reveal-shaped mounts (React's Offscreen/Activity: a hidden tree is
	 * prepared and committed without attaching its effects): the mounting
	 * render commits but the watcher's layout effects (subscribe + fixup)
	 * defer to a later, adopting commit — the reveal.
	 */
	function deferMountEffects(watcherId: WatcherId): void {
		for (const p of idToRenderPass.values()) {
			const i = p.mounted.indexOf(watcherId);
			if (i >= 0) p.mounted.splice(i, 1);
		}
	}

	function adoptRevealedMount(renderPassId: RenderPassId, watcherId: WatcherId): void {
		const adopter = getRenderPassById(renderPassId);
		if (adopter.state === 'ended') throw new ScheduleError('adopting render must be open');
		const w = getOrThrow(watchers, watcherId, 'watcher');
		if (w.root !== adopter.root) throw new ScheduleError('reveal stays on the watcher root');
		for (const p of idToRenderPass.values()) {
			const i = p.mounted.indexOf(watcherId);
			if (i >= 0) p.mounted.splice(i, 1);
		}
		adopter.mounted.push(watcherId);
	}

	/** An existing live watcher re-rendered by a render: dedup bits re-arm at
	 * render (the queued work the bits stood for has now started). */
	function renderWatcher(renderPassId: RenderPassId, watcherId: WatcherId): void {
		const p = getRenderPassById(renderPassId);
		if (p.state === 'ended') throw new ScheduleError('render requires an open render');
		const w = watchers.get(watcherId);
		if (w === undefined || !w.live) throw new ScheduleError('render targets a live watcher');
		if (w.root !== p.root) throw new ScheduleError('watcher belongs to another root');
		w.dedupBits = 0;
		p.rendered.add(watcherId);
	}

	/**
	 * Full watcher removal — the bindings' unsubscribe surface (debounce-
	 * finalized unsubscription, StrictMode orphan sweeps). The engine keeps
	 * watchers in TWO stores — the `watchers` id map and the `nodeToWatchers`
	 * per-node index the routing walks read (delivery collection, drain
	 * candidate collection, arena mark decay) — and this is the one public
	 * operation that retires a watcher from BOTH, plus any open render's
	 * mounted list (a dead watcher must not be revived by a later commit's
	 * layout loop). Deleting from the public map alone strands the per-node
	 * entry (pinned by tests/graph-consumers.spec.ts). The liveness setter
	 * inside releases the observation-union retain.
	 */
	function removeWatcher(watcherId: WatcherId): void {
		for (const p of idToRenderPass.values()) {
			const i = p.mounted.indexOf(watcherId);
			if (i >= 0) p.mounted.splice(i, 1);
		}
		dropWatcher(watcherId);
	}

	/** Unlinks a watcher from the per-node index (discarded mounts) and frees
	 * its arena record. */
	function dropWatcher(wid: WatcherId): void {
		const w = watchers.get(wid);
		if (w === undefined) return;
		// Deletion implies non-live: normally already false (discarded mounts
		// never subscribed), but if a driver discards a render holding an
		// adopted live watcher, this releases its observation retain
		// (edge-filtered no-op otherwise).
		w.live = false;
		watchers.delete(wid);
		// The cached index is safe here even when stale: a scrubbed row is
		// undefined, and a re-tenanted row cannot contain this watcher.
		const nodeWatchers = nodeToWatchers[w.nodeIx];
		if (nodeWatchers !== undefined) {
			const i = nodeWatchers.indexOf(w);
			if (i >= 0) nodeWatchers.splice(i, 1);
			// Reclamation retry trigger — the watcher-index guard row clears
			// here (removeWatcher, unmount/discard teardown all funnel through
			// this unlink). Edge-triggered: only the row's LAST entry leaving
			// clears the guard. Size-0 bail first.
			if (reclaimSkippedN !== 0 && nodeWatchers.length === 0) noteReclaimRetry(w.node);
		}
		// Record free LAST, after every store unlinked (the free defers to the
		// next boundary sweep, so queued notifications holding the handle
		// still read their own fields; the sweep's generated scrub then clears
		// every column slot the record owned).
		freeWatcherRecord(w);
	}

	/**
	 * Per-root commit lock-in — the single owner of a root's committed-state
	 * transition. For each named batch that is still live and not yet a
	 * committed member of this root, one unit moves together: the committed-
	 * batch set, the same set as a bit mask (`committedBits` — what the committed-world
	 * visibility check reads), the root's commit generation, the committed-
	 * advance clock, this root's arena fan-out of the batch's touched atoms,
	 * and the durable watcher drain. Already-committed, retired/reclaimed, and
	 * unknown batches skip: the protocol's per-root commit report is a delta,
	 * and re-reporting a batch is defined as an idempotent set-add.
	 *
	 * Callers: renderEnd's lock-in sweep (already inside its own operation
	 * frame, via the inner form) and the bindings' root-commit report handler
	 * (this public form — the report can name a live batch the render-end sweep
	 * missed). Returns whether any batch was newly locked in.
	 */
	function commitBatches(rootId: RootId, batches: Iterable<BatchId>): boolean {
		let changed = false;
		core.opDepth++; // public-operation frame (see the engine's write dispatch)
		try {
			changed = commitBatchesInner(rootId, batches);
			// Boundary rule: a per-root commit is a boundary operation. When this
			// call moved committed truth, re-check the root's committed
			// subscriptions at the boundary value (renderEnd's sweep gets the same
			// re-check from renderEnd's own boundary; here the call is the
			// boundary). A no-op call re-checks nothing — the report's common
			// case re-names batches the sweep already locked in.
			if (changed) core.revalidateCommittedSubscriptions(rootId);
			core.endOperation();
		} finally {
			core.opDepth--;
		}
		core.runOperationEpilogue();
		return changed;
	}

	function commitBatchesInner(rootId: RootId, batches: Iterable<BatchId>): boolean {
		const root = core.root(rootId);
		const tr = core.trace;
		let changed = false;
		for (const tid of batches) {
			const t = idToBatch.get(tid);
			if (t === undefined || t.state !== 'live') continue; // retired (or reclaimed): the retired clause subsumes membership
			if (root.committedBatches.has(t.id)) continue; // idempotent set-add: already a member
			root.committedBatches.add(t.id);
			if (t.slot !== undefined) root.committedBits |= 1 << t.slot;
			root.commitGen++;
			core.advanceCommitted(); // committed-advance: every per-root commit bumps it
			// Committed-truth flip site: per-root lock-in — inside the per-batch
			// loop (commits lock in sets of batches), immediately after the
			// membership/gen/committedAdvance mutation and before this batch's drain, fan
			// THAT batch's touched atoms into THIS root's arena.
			{
				const ra = core.rootToArena.get(rootId);
				if (ra !== undefined) core.fanAtomsToArena(ra, t.atomsTouched, false);
			}
			if (tr !== undefined) tr.perRootCommit(rootId, t.id, root.commitGen);
			// Durable drain, gated the same way at every flip site: an advanced slot or
			// member-slot write drift (or restaled leftovers) means the root's
			// committed truth moved — candidates come from the arena's dirty
			// list, which the lock-in fanout just fed.
			const bits = (t.slot !== undefined ? 1 << t.slot : 0) | root.committedDirtySlots;
			root.committedDirtySlots = 0;
			const re = core.restaled.get(rootId);
			if (bits !== 0 || (re !== undefined && re.size > 0)) core.drainCommittedObservers(rootId, 'per-root-commit');
			changed = true;
		}
		return changed;
	}

	/**
	 * End a render. Commit order: (1) baseline capture, (2) retirement folds
	 * due at this commit + per-root table update, (3) durable drains,
	 * (4) layout (subscribe + mount fixups) — the same order the protocol
	 * host performs the corresponding React work, so observers see states in
	 * the order the screen does. Discard: render-owned mounts die (the tree
	 * they rendered into never existed). Deferred slot releases re-evaluate
	 * at every render end, commit and discard alike (the mask retaining a slot
	 * may just have closed).
	 */
	function renderEnd(id: RenderPassId, kind: 'commit' | 'discard', opts?: { retireAtCommit?: BatchId[] }): void {
		core.opDepth++; // public-operation frame (see the engine's write dispatch)
		try {
			renderEndInner(id, kind, opts);
		} finally {
			core.opDepth--;
			core.committingRender = undefined; // the cross-world correction window closes with the operation
		}
		core.runOperationEpilogue();
	}

	function renderEndInner(id: RenderPassId, kind: 'commit' | 'discard', opts?: { retireAtCommit?: BatchId[] }): void {
		const render = getRenderPassById(id);
		if (render.state === 'ended') throw new ScheduleError('render already ended');
		if (kind === 'commit') {
			for (const tid of opts?.retireAtCommit ?? []) {
				const t = batch.getBatchById(tid); // throws on unknown ids before any mutation
				if (!render.maskBatches.has(tid)) {
					// A retirement folded inside a commit must belong to a batch
					// this commit rendered: folding a foreign batch's log entries here
					// would advance committed truth past what this commit actually
					// put on screen. Foreign batches retire at their own closure —
					// the protocol host never sends this shape; guarded anyway.
					throw new ScheduleError(`batch ${tid} is not rendered by render pass ${render.id}; its retirement cannot be due at this commit`);
				}
				if (t.state !== 'live' || t.parked) {
					throw new ScheduleError(`batch ${tid} cannot retire at this commit (already retired, or parked)`);
				}
			}
		}
		// Resolve mask batch records before any retirement can reclaim them:
		// the mount fixup's fast-path clock check quantifies over the
		// committing render's mask batches as they exist at commit time (see
		// runMountFixup for why batches, not captured slots).
		const maskBatchRecords: Batch[] = [];
		if (kind === 'commit') {
			for (const tid of render.maskBatches) maskBatchRecords.push(batch.getBatchById(tid));
		}
		render.state = 'ended';
		render.endKind = kind;
		rootToOpenRender.delete(render.root);
		// One load covers this operation's record sites: the disposition
		// record here fires before the end's consequences (retirement folds,
		// per-root commits, drains, fixups) so consequences can cite it as
		// cause; the renderCommitted/renderDiscarded checkpoint markers below
		// fire after them (the reference model's stream position).
		const tr = core.trace;
		if (tr !== undefined) tr.renderEnd(render, kind);
		if (kind === 'discard') {
			for (const wid of render.mounted) dropWatcher(wid); // never subscribed; the tree died
			if (tr !== undefined) tr.renderDiscarded(render);
			reevaluateDeferredReleases();
			reclaimAfterRenderEnd(render);
			core.maybeCloseEpisode(); // the last open render just closed: the episode may end here
			core.recomputeQuiet(); // render closed (episode possibly ended): quiet may re-arm
			// Boundary rule: the frame close is the deferred flush point for
			// boundaries that occurred while this root's frame was open (the discard
			// itself advances nothing; committed truth may already have moved).
			core.revalidateCommittedSubscriptions(render.root);
			core.endOperation();
			return;
		}
		// The cross-world correction window opens: drains fired by this
		// commit's own retirements and lock-ins gate this render's
		// re-rendered/mounted watchers by VALUE (see correctWatcher — their
		// registers were just reset from the render world); cleared in
		// renderEnd's finally.
		core.committingRender = render;
		// (1) Baseline capture at the commit's committed-side entry.
		const baseline = { committedAdvance: core.getCommittedAdvance(), rootCommitGen: core.root(render.root).commitGen };
		// The committing tree's content: re-rendered watchers take this render's
		// world values now — a watcher's last rendered value updates only at
		// committed renders, and it is the comparator later drains reconcile
		// against.
		for (const wid of render.rendered) {
			const w = watchers.get(wid);
			if (w === undefined) continue; // removed mid-render
			const wInternals = resolveWatcherInternals(w);
			if (wInternals === undefined) continue; // loud skip: record tenancy moved mid-render
			w.lastRenderedValue = core.evaluate(wInternals, { kind: 'render', render });
			w.snapshot = {
				renderPassId: render.id, pin: render.pin, maskBits: render.maskBits,
				includedBits: render.includedBits, rootCommitGen: core.root(render.root).commitGen,
			};
		}
		// (2) retirement folds due at this commit; then the per-root commit
		// (lock-in) of every still-live mask batch: this root now shows those
		// batches' writes, so its committed world must include them. The
		// lock-in — including step (3), each newly committed batch's durable
		// drain — is commitBatchesInner, the single owner of the transition;
		// the bindings' root-commit report handler is its other caller.
		for (const tid of opts?.retireAtCommit ?? []) batch.retireInner(batch.getBatchById(tid));
		commitBatchesInner(render.root, render.maskBatches);
		// (4) layout: subscribe, then mount fixup (matching React's layout-
		// effect phase: after commit, before paint).
		for (const wid of render.mounted) {
			const w = watchers.get(wid);
			if (w === undefined) continue;
			// The dormant-watcher aliasing pin: the watcher was mounted in this
			// render, but its node's record may have died (and been reused)
			// before this commit — the generation stamp decides. A stale
			// watcher never activates: binding it here would subscribe it to
			// the record's new tenant.
			const wInternals = resolveWatcherInternals(w);
			if (wInternals === undefined) continue; // loud skip (counted)
			w.live = true;
			runMountFixup(w, wInternals, render, baseline, maskBatchRecords);
		}
		// The populator domain — the explicit union of this render's
		// re-renders and its own mounts (`rendered` and `mounted` are
		// disjoint). Adopted reveals stay out: their snapshot rides the
		// original hidden render (`snapshot.renderPassId !== render.id` — the same
		// same-render conjunct the mount fixup's fast path tests), and their
		// population keeps its pre-existing timing (a later committed
		// evaluation), not the adopting commit's.
		const populated: WatcherId[] = [...render.rendered];
		for (const wid of render.mounted) {
			const w = watchers.get(wid);
			if (w !== undefined && w.snapshot.renderPassId === render.id) populated.push(wid);
		}
		// Re-staled detection: a re-rendered watcher whose committed value
		// moved past its pin is stale again the moment its commit reset
		// lastRenderedValue; the next durable drain reconciles it (the
		// reference model's full scan does the same, one drain later than
		// the flip). This loop is load-bearing for routing, deliberately:
		// its committed evaluations populate the root's arena with the
		// full committed dep cone (strong + weak) of every watcher this render
		// re-rendered or mounted, before renderEnd returns — i.e., before any
		// post-commit write needs routing. (For a freshly mounted watcher the
		// value check is provably a no-op — runMountFixup just reconciled it —
		// but the evaluation is its cone's one populator: the fixup's
		// fast-out path never evaluates, and mountFix folds are arena-free.)
		for (const wid of populated) {
			const w = watchers.get(wid);
			if (w === undefined || !w.live) continue;
			const wInternals = resolveWatcherInternals(w);
			if (wInternals === undefined) continue; // loud skip (live ⇒ alive in practice; belt for binding-side flips)
			const committedNow = core.evaluate(wInternals, { kind: 'committed', root: render.root });
			// The committed-render stamp rule (the at-least-once ruling's
			// baseline-advance site): the populator's evaluation settled the
			// watched node's per-root committed clock. When the rendered
			// register agrees with committed-now, the screen is VALIDATED —
			// stamp lastValidatedAt at the settled clock; when it differs,
			// the watcher is re-staled — stamp 0 (never-validated), which
			// forces the next durable drain's clock gate to correct it even
			// if committed truth flips back meanwhile (spurious by accepted
			// design; the value compare here is the cross-world render ↔
			// committed commit-integrity check the ruling's survivor clause
			// keeps — per-root clocks cannot express equivalence between two
			// worlds).
			// The populator is an observer consult: settle the watched node's
			// committed clock before the stamp rule reads it.
			{
				const ra = core.rootToArena.get(render.root);
				if (ra !== undefined) core.settleObserverClock(ra, wInternals);
				if (core.isValueChanged(wInternals, w.lastRenderedValue, committedNow)) {
					markRestaled(w);
					w.lastValidatedAt = 0;
				} else {
					w.lastValidatedAt = ra === undefined ? 0 : committedNodeClock(ra, w.nodeIx);
				}
			}
		}
		// The population dev assert: after a commit of render P, every
		// live watcher P re-rendered or mounted has a shadow for its node in
		// the root's committed arena (the populator above ran; a miss here
		// means a future re-ordering broke the routing coverage argument).
		{
			const ra = core.rootToArena.get(render.root);
			for (const wid of populated) {
				const w = watchers.get(wid);
				if (w === undefined || !w.live) continue;
				if (ra === undefined || !arenaHasShadow(ra, w.nodeIx)) {
					throw new InvariantViolation(`watcher-population rule: watcher ${w.name} has no shadow in root ${render.root}'s committed arena after commit`);
				}
			}
		}
		if (tr !== undefined) tr.renderCommitted(render);
		// ctx.previous fields hold the last committed value — a pending
		// render's value must never leak into the hint, because a pending
		// transition may still be discarded — so update them from every
		// watcher this commit re-rendered or mounted: the explicit union of
		// the two disjoint collections, each watcher visited once (the field
		// lives on the engine's computed internals, beside their ctx adapter).
		for (const wid of [...render.rendered, ...render.mounted]) {
			const w = watchers.get(wid);
			if (w === undefined || w.lastRenderedValue instanceof SuspendedRead) continue;
			const node = w.nodeIx < nodeIndexToInternals.length ? nodeIndexToInternals[w.nodeIx] : undefined;
			if (node === undefined || getKernelGeneration(w.node) !== w.nodeRecordGen) continue; // stale: no hint to update (gen-checked exactly as resolveWatcherInternals; uncounted — not a resolution consumers observe)
			if (node.kind === 'computed') node.prevCommitted = w.lastRenderedValue;
		}
		{
			const ra = core.rootToArena.get(render.root);
			if (ra !== undefined) core.arenaDecay(ra); // boundary mark decay
		}
		reevaluateDeferredReleases();
		reclaimAfterRenderEnd(render);
		core.maybeCloseEpisode(); // the last open render just closed: the episode may end here
		core.recomputeQuiet(); // render closed (episode possibly ended): quiet may re-arm
		// Boundary rule: one committed-subscription re-check per commit
		// operation, at the boundary value — a render locking in two batches
		// re-checks once, not per batch.
		// Retirements folded into this commit moved committed truth for every
		// root, so the scan widens (each root still open-frame-deferred).
		core.revalidateCommittedSubscriptions((opts?.retireAtCommit ?? []).length > 0 ? undefined : render.root);
		core.endOperation();
	}

	/**
	 * Render-end reclamation: the ended render record drops
	 * (its memos and mask mappings die with it — nothing from a dead render
	 * can validate later). Render-attempt state is episode-lifetime at most:
	 * the record and its arena go here, at the attempt's own close. (Batch
	 * records the mask retained persist — they are episode-lifetime and drop
	 * wholesale at the episode close.)
	 */
	function reclaimAfterRenderEnd(p: RenderPass): void {
		idToRenderPass.delete(p.id);
		// Drop the render arena (commit and discard drop identically;
		// this site deliberately runs after mount fixup and the re-staled
		// loop, so both saw the arena; touching it later throws).
		if (p.arena !== undefined) {
			core.releaseArena(p.arena);
			p.arena = undefined;
		}
	}

	/** Deferred releases re-evaluate at every render end, commit and discard alike. */
	function reevaluateDeferredReleases(): void {
		for (const s of slots) {
			if (!s.releasePending) continue;
			if (!batch.isSlotRetainedByOpenMask(s.id)) batch.releaseSlot(s);
		}
		// A render ending releases its pin, which can unlock retired-prefix
		// folds (the bounded-memory valve's pin clause).
		core.runFoldValve();
	}

	/**
	 * Watchers re-staled by their own commit: the commit reset
	 * lastRenderedValue to the render world's pin-old value while committed
	 * truth had already moved past the pin. The reference model catches
	 * these at its next full-scan drain; the engine keeps the precise set
	 * (`core.restaled`) and folds it into the next durable drain on the
	 * watcher's root.
	 */
	function markRestaled(w: Watcher): void {
		let set = core.restaled.get(w.root);
		if (set === undefined) {
			set = new Set();
			core.restaled.set(w.root, set);
		}
		set.add(w);
	}

	// ---------------------------------------------------------- mount fixup

	/** Every slot in `bits` has its last write at or before `pin` (the
	 * fast-out's clock conjunct, quantified over a snapshot's slot bits). */
	function areSlotClocksQuiet(bits: BatchSlotSet, pin: Seq): boolean {
		for (let s = 0; bits !== 0; s++, bits >>>= 1) {
			if ((bits & 1) === 1 && slots[s]!.writeClock > pin) return false;
		}
		return true;
	}

	/**
	 * Mount fixup — runs in the mounting component's layout effect (after
	 * commit, before paint), after subscription. Why it exists: a component
	 * can mount while other updates are in flight, and its subscription only
	 * activates at commit, so writes could slip by unobserved between its
	 * render and its commit. Two halves, decided in this order:
	 *  1. catch-up (no evaluation; write metadata only): a value-blind
	 *     corrective re-render joins each live batch that touched the node
	 *     but was not part of this render — the component joins the pending
	 *     update in that batch's own lane instead of revealing it early or
	 *     missing it;
	 *  2. urgent correction: whatever committed or retired during the mount
	 *     window is fixed before paint. The four-condition test decides
	 *     first: when every condition passes, nothing committed or retired
	 *     in the window and any remaining drift is exactly the live-batch
	 *     writes step 1 already scheduled catch-ups for
	 *     (tests/concurrent-scars.spec.ts pins why those must not be
	 *     corrected urgently) — so nothing
	 *     else runs, no evaluation, no comparison. Only when a condition
	 *     fails is the node re-evaluated in the fast-forwarded mount-fix
	 *     world and a real difference corrected urgently.
	 * One subtle rule, asserted by the lockstep tests: the clock condition
	 * quantifies over the committing render's member batches at commit time
	 * (not just the slot set captured at render start — a batch whose first
	 * write landed mid-render interned its slot after the capture, so the
	 * slot-quantified form would miss its writes).
	 */
	function runMountFixup(w: Watcher, node: AnyInternals, committingRender: RenderPass, baseline: { committedAdvance: Seq; rootCommitGen: CommitGen }, maskBatchRecords: Batch[]): void {
		const closure = dependencyClosureOf(w.node, committingRender);
		const tr = core.trace; // one load covers the corrective records + the disposition record
		// Catch-up half — per-batch catch-up loop: every live written batch
		// that touched the node. A premise of the condition test's soundness,
		// not an optimization: a live committed member can write after the pin
		// without tripping any condition (its slot is outside the render
		// mask), and this schedule is what carries such writes.
		let correctives = 0;
		for (const b of idToBatch.values()) {
			if (b.state !== 'live' || b.slot === undefined) continue;
			if (!isBatchTouchingClosure(b, closure)) continue;
			const slot = slots[b.slot]!;
			// Fully included (slot ∈ included bits ∧ no post-pin write): skip — never by value.
			if (((w.snapshot.includedBits >>> slot.id) & 1) === 1 && slot.writeClock <= w.snapshot.pin) continue;
			if (tr !== undefined) tr.mountCorrective(w, b.id, slot.id);
			correctives++;
			w.dedupBits |= 1 << slot.id; // the corrective is a state update scheduled into the batch's lane (the protocol's runInBatch)
			if (core.onMountCorrective !== undefined) notify.queueNotify(1, w, b, slot.id);
		}
		// Urgent-correction half — the four-condition test, decided before any
		// evaluation: same render, no committed-truth advance, no per-root
		// commit, clocks quiet. The clock condition checks the captured mask
		// slots AND the committing render's mask batches at commit time — a mask
		// batch whose first write interned its slot mid-render is invisible to
		// the slot-quantified form, because the slot set was captured at render
		// start, before that slot existed.
		const clocksQuiet =
			areSlotClocksQuiet(w.snapshot.maskBits, w.snapshot.pin) &&
			maskBatchRecords.every((t) => t.lastWriteSeq === 0 || t.lastWriteSeq <= w.snapshot.pin);
		const fastOut =
			w.snapshot.renderPassId === committingRender.id &&
			baseline.committedAdvance <= w.snapshot.pin &&
			baseline.rootCommitGen === w.snapshot.rootCommitGen &&
			clocksQuiet;
		if (fastOut) {
			if (tr !== undefined) tr.runMountFixup(w, 'fast-out', correctives);
			return; // nothing committed or retired in the window: no evaluation, no comparison
		}
		const vFx = core.evaluate(node, {
			kind: 'mountFix', maskBits: w.snapshot.maskBits, pin: w.snapshot.pin, root: w.root,
		});
		if (core.correctWatcher(w, node, vFx, 'mount')) {
			if (tr !== undefined) tr.runMountFixup(w, 'corrected', correctives);
			return;
		}
		if (tr !== undefined) tr.runMountFixup(w, 'compare-clean', correctives);
	}

	/** Transitive dependency closure feeding a node — three
	 * reverse (deps-direction) walks over kernel ∪ the mounting render's arena
	 * ∪ the root's committed arena. The kernel leg walks the kernel's own
	 * dep links (tracked-only by construction, evaluation-lagged
	 * exactly like every other recorded structure), mapping visited kernel
	 * records back to engine internals; unregistered intermediates
	 * are traversed but contribute nothing (only engine-written atoms can
	 * appear in batch touch sets). Strong links only (weak deps never
	 * joined the closure — they can't deliver, so correctives never target
	 * their batches). The render arena is alive here by ordering (fixup
	 * runs before reclaimAfterRenderEnd). The corrective population this
	 * closure
	 * feeds arms the per-(watcher, slot) dedup bits, so it must cover every
	 * cone the delivery walk can later route — render + committed arenas + the
	 * newest structure — or a suppression would degrade into an
	 * over-delivery (the model-comparison corpus's ⊆ delivery bound polices
	 * exactly this). */
	function dependencyClosureOf(nodeId: NodeId, render?: RenderPass): Set<NodeId> {
		const closure = new Set<NodeId>([nodeId]);
		// Public/diagnostic entry: the id is not provably a node record id,
		// so the row resolution carries its own identity check (see
		// concurrent.ts getResidentInternals).
		const ix = getKernelNodeIndex(nodeId);
		const node = ix < nodeIndexToInternals.length ? nodeIndexToInternals[ix] : undefined;
		if (node === undefined || node.id !== nodeId) return closure; // unregistered/dead id: nothing routes
		const pa = render?.arena;
		if (pa !== undefined) core.collectArenaClosure(pa, node, closure);
		if (render !== undefined) {
			const ca = core.rootToArena.get(render.root);
			if (ca !== undefined) core.collectArenaClosure(ca, node, closure);
		}
		collectKernelClosure(node.id, closure, new Set());
		return closure;
	}

	/** The kernel leg of the fixup closure: reverse walk over the
	 * kernel's dep links off the raw arena view (the kernel's own exported
	 * layout enums). One id space: a visited record's id is the NodeId —
	 * registered deps join the closure directly. */
	function collectKernelClosure(kernelId: NodeId, closure: Set<NodeId>, seen: Set<NodeId>): void {
		if (seen.has(kernelId)) return;
		seen.add(kernelId);
		const memory = E.buffer();
		let l = memory[kernelId + NodeField.DEPS]!;
		while (l !== 0) {
			const depKernelId = memory[l + LinkField.DEP]!;
			// Dep ids come off live kernel links, so a defined dense row by
			// the dep's live NODE_INDEX ⇔ the dep has engine content (the
			// registry lockstep).
			const depIx = memory[depKernelId + NodeField.NODE_INDEX]!;
			if (depIx < nodeIndexToInternals.length && nodeIndexToInternals[depIx] !== undefined) closure.add(depKernelId);
			if ((memory[depKernelId + NodeField.FLAGS]! & NodeFlag.K_COMPUTED) !== 0) collectKernelClosure(depKernelId, closure, seen);
			l = memory[l + LinkField.NEXT_DEP]!;
		}
	}

	function isBatchTouchingClosure(t: Batch, closure: Set<NodeId>): boolean {
		const atoms = t.atomsTouched;
		for (let i = 0; i < atoms.length; i++) {
			if (closure.has(atoms[i]!.id)) return true;
		}
		return false;
	}

	// ---- the operation table (late-bound onto the shared core record) ----
	core.resolveWatcherInternals = resolveWatcherInternals;
	core.getMinLivePin = getMinLivePin;

	return {
		renderStart,
		renderYield,
		renderResume,
		mountWatcher,
		deferMountEffects,
		adoptRevealedMount,
		renderWatcher,
		removeWatcher,
		commitBatches,
		renderEnd,
		dependencyClosureOf,
		getStaleWatcherSkips: () => staleWatcherSkips,
	};
}
