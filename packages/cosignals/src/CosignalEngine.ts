/**
 * cosignals — the engine (CosignalEngine.ts): one module holding the whole
 * reactive machine, from storage layout to reclamation. It stores every
 * signal, computed, effect, and dependency edge as a fixed-size integer
 * record in shared arrays, and runs the reactive algorithm — writes push
 * staleness marks down the graph, reads lazily pull recomputation — as index
 * arithmetic over those records. On top of that kernel it runs the
 * concurrent-worlds machinery React's concurrent rendering needs: every
 * write is recorded, and alternative views of the state ("worlds")
 * reconstruct on demand, so a paused background render keeps seeing the
 * state it started from while urgent updates land and commit.
 *
 * The module reads top to bottom with progressive disclosure; its sections,
 * in order:
 *
 *   1. Storage layout — the arena, the record layout and its
 *      column-coherence functions, the side columns, and the shared mutable
 *      state that survives closure rebuilds.
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
 *   7. The concurrent machinery — its vocabulary (write logs, batches,
 *      worlds, watchers, episodes), the engine's node records
 *      (AtomInternals/ComputedInternals), the trace-hook surface, the
 *      driver seam, the module state every later section shares, and
 *      handle resolution (content allocation on first participation).
 *   8. The observation index — the transitive observation retains live
 *      watchers hold over the dependency closures they consume.
 *   9. The write log and the episode lifecycle — the per-atom write
 *      history, the bounded-memory fold valve, and the quiescence close.
 *  10. Batches — batch identity, the 31-entry recycling slot table, and
 *      retirement (the batch's terminal transition).
 *  11. Worlds — folds, world evaluation, and read routing (the two-clause
 *      visibility rule; the resolution order for routed reads).
 *  12. World arenas — the per-world value/invalidation/routing layer
 *      (shadow records, arena walks, claim/release, observer clocks).
 *  13. Delivery — the operation-boundary notification queue and the walk
 *      orchestration (the value-blind delivery walk, the durable drains,
 *      the one urgent pre-paint correction).
 *  14. Settlement — the resource-settlement tap, its drain loop, and the
 *      compound-operation epilogue.
 *  15. Observer records — watchers and subscriptions as kernel records
 *      with column storage (the handle classes are lean references).
 *  16. Committed observers — the subscription lifecycle and the boundary
 *      re-check (the at-least-once clock rule).
 *  17. Render integration — render passes, the watcher lifecycle, per-root
 *      commit lock-in, and mount fixup.
 *  18. The public dispatch and the engine surface — the classified write
 *      path, world reads, quiescence, the engine reset, and the one
 *      `engine` record.
 *  19. Composition — the one state-initialization function (module
 *      initialization runs it; the test-only engine reset re-runs it).
 *  20. Reclamation — FinalizationRegistry-driven recovery of records whose
 *      public handles were garbage-collected. Last because it unwinds
 *      everything above it; the test-reset seams close the file.
 *
 * Sections wire to each other by direct same-module calls — cycles between
 * them (evaluation ↔ arena serving ↔ folds, settlement ↔ drains ↔
 * corrections) resolve by function hoisting, never by assigning one
 * section's functions into another's state. The only composition act is
 * `composeEngine` (section 19): it initializes every section's module state
 * in one place, at module initialization and at each test reset. The only
 * mutable indirection left is runtime ATTACHMENT: a host installs a driver
 * (attachDriver), a tracer occupies the `trace` slot, tests arm checker
 * hooks — each is a public seam with one documented owner, not module
 * wiring.
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
 * slots, flag bits, shape constants, and the per-column grow/scrub/reset
 * functions — is declared in one region below, whose head note carries the
 * maintenance rule: a layout edit updates the coherence functions together,
 * in the same edit, so free/reset correctness stays one reviewable change.
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
 *   where the old one stopped. The kernel factory is the one factory this
 *   module keeps — it is load-bearing for growth; every other mechanism is
 *   plain module functions over module state.
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
// The policy layer — one runtime import, cyclic by design (index.ts imports
// this module back): the public handle classes the engine resolves, the
// plain write tail of the internals-less arm, the policy scrub the engine
// reset invokes, the lifecycle context's write path, and the standalone
// fast-arm flag's setter. Every name is either a hoisted function or a
// class the engine constructs only at runtime, so both module-evaluation
// orders converge (index.ts's standaloneQuiet note tells the fast-arm half
// of the story).
import { Atom, Computed, __lifecycleWrite, __plainAtomWrite, __resetPolicyForTest, __setStandaloneQuiet } from './index.js';
import type { AtomCtx, ComputedCtx, UseKey } from './index.js';

// The engine's error classes (errors.ts), re-exported: they are engine
// surface — index.ts serves them to consumers, and the suites that drive
// this module directly import them from here.
export { InvariantViolation, ScheduleError } from './errors.js';

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
type LinkId = number & IdBrand<'link'>;
/** A premultiplied record id of either kind — the shared allocator's
 * currency: both id kinds draw from one bump pointer (`recNext`), so a value
 * that is legitimately "either kind" needs a home. A RecordId only becomes a
 * NodeId or LinkId at the allocator's decision point ({@link allocNode} /
 * allocLink), which cast it into the chosen id space. */
type RecordId = NodeId | LinkId;
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
type NodeFlags = number;
/** The global evaluation cycle counter, stamped into link VERSION fields on re-track. */
type Version = number;
/** A node's GEN field value: bumped on free so disposers can defuse stale ids. */
type Generation = number;
/** A count of fixed-stride records (nodes and links draw from one shared pool). */
type RecordCount = number;
/** Index into the `values` side column (two slots per record; see ArenaShape). */
export type ValueIndex = number & IdBrand<'valueIndex'>;

// ---- the record layout --------------------------------------------------------
// One region declares the whole record layout: the field/flag/shape enums
// for both record domains (kernel records here, world-arena records further
// down) and the column-coherence functions beside them. The maintenance
// rule: a layout edit — a new field, flag bit, column, or record family —
// updates the growth, scrub, and reset functions TOGETHER, in the same
// edit, or a freed slot's next tenant observes the dead tenant's state.
// The coherence set, kernel then world arena:
//  - scrubNodeColumnsOnFree / scrubLinkColumnsOnFree — the two allocators'
//    free paths (every side-column slot of a freed record).
//  - growNodeSideColumns — the node allocator's grown-together column loop.
//  - resetSideColumnsForTest — the test reset's column half.
//  - growWorldArenaBuffers — the record store + every record-keyed buffer
//    column, doubled by copy together.
//  - growWorldArenaColumns — the shadow allocator's grown-together loop.
//  - scrubWorldShadowColumnsOnEvict / scrubWorldLinkColumnsOnFree — the
//    evict and link-free scrubs.
//  - resetWorldArenaColumnsOnRelease — the pool-release scrub.
// A new column joins its family's grow, scrub, and reset in one edit; the
// reclaim probes and the leak audit catch a missed scrub, but only for
// state they know to poke — the rule is the contract, the suites are the
// net.
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
 * The layout is declared in this file — the engine owns its record
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
 * scrub — {@link scrubNodeColumnsOnFree} covers every family the node
 * allocator serves). A watcher record
 * carries no kernel dependency links, so the kernel walks never reach
 * it; the engine interprets slots 0-4 and 6, while slots 1/5/7 keep
 * their allocator meanings (free-list thread / GEN / NODE_INDEX). The
 * mutable watcher state lives here and in the side columns (values:
 * last rendered value; clocks: lastValidatedAt; extras: name, root, and
 * the rendered-world snapshot); the Watcher handle object holds only
 * the record id and the monotone watcher id (delivery order).
 */
const enum WatcherField {
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
const enum SubscriptionField {
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
	/** id >> ID_TO_ORDINAL_SHIFT: premultiplied id → the record ordinal (log2 of STRIDE; a stride change updates both). */
	ID_TO_ORDINAL_SHIFT = 3,
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
 * free path (covers every family the allocator serves:
 * node/watcher/subscription records; a new column joins this scrub — the
 * layout note above). The slot's next tenant must
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
 * free path (covers every family the allocator serves: link records;
 * a new column joins this scrub — the layout note above). The slot's next
 * tenant must
 * never observe the old tenant's values, closures, or clock stamps.
 * recordBuffer columns are closure-owned, so the caller passes its
 * buffer.
 */
function scrubLinkColumnsOnFree(id: LinkId, clocks: Float64Array): void {
	clocks[id >> ArenaShape.ID_TO_CLOCK_SHIFT] = 0; // signal/computed: updatedAt (tagged-outcome clock) / watcher, subscription: the observer's lastValidatedAt / link: reserved (scrubbed on free)
}

/**
 * Grow the kernel's grown-together side columns to cover one record id
 * (a new grow-array column joins this loop — the layout note above).
 * Called by the node allocator for every family it serves
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
 * Reset every kernel side column to its record-zero seed (the test
 * reset's column half; every declared column resets — the layout note
 * above). Grow-arrays truncate;
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
	 * growth replaces it. EngineResetOptions.arenaInitInts overrides the
	 * initial size (the arena suites shrink it to force mid-operation
	 * growth). The views stay plain fixed-length typed arrays (full V8
	 * element-access optimization): length-tracking resizable-buffer
	 * views are banned — a measured +56% arena-walk regression.
	 */
	INIT_BUFFER_BYTES = 67108864,
}

/**
 * Grow one world arena's record store and every record-keyed buffer
 * column BY COPY (doubling) to cover `needInts` Int32 slots (a new
 * record-keyed buffer column joins this growth — the layout note above;
 * exhaustion is never fatal, growth replaces it). Mid-operation
 * growth is safe through the shell indirection: only the buffer
 * OBJECTS change — record ids, and every structure holding them
 * (observer dep chains included), stay stable — and the replacement
 * buffers are zeroed past the copied prefix, preserving the
 * fresh-record invariant. The price is the reload-after-allocation
 * discipline, confined to the sites enumerated here (an allocating site
 * joins this list in the same edit, never folklore):
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
 * column index (a new grow-array column joins this loop — the layout
 * note above). Called by the shadow allocator; record-buffer
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
 * Scrub an evicted shadow record's per-record column slots (a new
 * column joins this scrub — the layout note above): a re-keyed or
 * purged record's next tenant must
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
 * (a new column joins this scrub — the layout note above): only
 * subscription dependency links
 * ever write these, but the free-path scrub is unconditional so a reused
 * link record can never carry a dead tenancy's stamp regardless of which
 * path freed it (the kernel freeLink's clock-scrub twin).
 */
function scrubWorldLinkColumnsOnFree(a: WorldArena, id: number): void {
	a.clocks[id >> ArenaGeom.ID_TO_COLUMN_SHIFT] = 0;
}

/**
 * Reset every world-arena side column at release (the release scrub's
 * column half; every declared column resets — the layout note above).
 * Keeps each column's
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
 * is set; everything else is the plain kernel read. The worlds section's
 * syncReadRouting is the only writer.
 */
export let routingActive = false;


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
 * oddments that don't earn a dedicated column. Module-internal: its only readers are this module's observer
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
		growNodeSideColumns(id); // every grown-together column covers the record (the layout region's coherence set)
		return id;
	}

	function freeNode(id: NodeId): void {
		memory[id + NodeField.FLAGS] = 0;
		memory[id + NodeField.LIFECYCLE] = 0;
		memory[id + NodeField.DEPS_TAIL] = 0;
		memory[id + NodeField.SUBS] = 0;
		memory[id + NodeField.SUBS_TAIL] = 0;
		++memory[id + NodeField.GEN];
		scrubNodeColumnsOnFree(id, clocks); // every declared column clears (the layout region's coherence set)
		memory[id + NodeField.DEPS] = nodeFreeHead; // NODE_INDEX (field 7) deliberately survives — see NodeField
		nodeFreeHead = id;
		// The record-free hook: hosts keying dense side tables by NODE_INDEX
		// scrub the freed record's rows here, so the slot's next tenant (which
		// inherits the index) can never be served the old tenant's rows. Fires
		// only from the boundary sweep (freeNode's one caller), after the GEN
		// bump — the hook may observe the new tenancy generation.
		__onRecordFree(id, memory[id + NodeField.NODE_INDEX]);
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
		const words = new Uint32Array(((recNext >> ArenaShape.ID_TO_ORDINAL_SHIFT) + 32) >> 5);
		for (let id = linkFreeHead; id !== 0; id = memory[id + LinkField.FREE_NEXT]) {
			const rec = id >> ArenaShape.ID_TO_ORDINAL_SHIFT;
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
				const id: LinkId = ((w << 5) + (31 - Math.clz32(bit))) << ArenaShape.ID_TO_ORDINAL_SHIFT;
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
		scrubLinkColumnsOnFree(id, clocks); // a reused link must not carry the old tenant's clock stamp
		memory[id + LinkField.FREE_NEXT] = linkFreeHead;
		linkFreeHead = id;
	}

	// ---- upstream system.ts, transliterated -------------------------------------
	// The arena walks (the world-arena sections below) re-derive these
	// algorithms over a different record layout on purpose (weak-subs second
	// list, VALID/BOX bits, guard counters — see that section's header). Behavioral drift between
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

// ---- UpdatedAt clocks ----------------------------------------------------------
// A fast negative guard for observers, never a replacement for dirty-state,
// value baselines, or delivery metadata. Every record owns one float64 clock
// slot (the `clocks` buffer created beside the arena in createKernel; layout
// constants in the record-layout region above):
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
//    sections later in this module) is the observer's lastValidatedAt:
//    the per-root committed clock it last validated against. Kernel LINK
//    slots are reserved-unused (a subscription's per-dep stamps ride its
//    WORLD-ARENA dependency links instead); the kernel never reads or
//    writes them (the intra-run dedup stamp stays in the VERSION field),
//    and the free-path scrub guarantees a fresh or reused record
//    starts at 0 ("never validated").
//
// The skip rule for consumers (the contract: observer re-fires are
// at-least-once): an observer may skip only when the producer is CLEAN and
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

// ---- the live op table + growth ------------------------------------------------

/** Default capacity floor, in records, when neither the env var nor configure() sets one. */
const DEFAULT_INITIAL_RECORDS = 1 << 20;
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
						settleTap(t);
					}
				},
				(e: unknown) => {
					if (t.status === 'pending') {
						t.status = 'rejected';
						t.reason = e;
						settleTap(t);
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

type LifecycleState = {
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
const lifecycleStates = new Map<NodeId, LifecycleState>();
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

/** Dispatch one lifecycle-context write through the policy layer's
 * handle-free write path (__lifecycleWrite in index.ts: the same policy
 * assert as the public methods, then the engine dispatch over the
 * id-resolved node). A direct cyclic-module call, deliberately: the site is
 * cold (lifecycle contexts write only inside user lifecycle effects), so the
 * imported-binding indirection costs nothing that matters, and index.ts is
 * always initialized before any lifecycle effect can run. */
function dispatchLifecycleWrite(id: NodeId, kind: 0 | 1, payload: unknown): void {
	__lifecycleWrite(id, kind, payload);
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
function retainLifecycle(id: NodeId): void {
	shiftLifecycleCount(id, 1);
}

function releaseLifecycle(id: NodeId): void {
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

// ═══════════════════════════════════════════════════════════════════════════════
// The concurrent machinery
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The concurrent-worlds machinery riding the kernel above (sections 1-6;
 * index.ts's header defines the kernel terms). The kernel is the dependency
 * tracker:
 * it stores every signal, computed, effect, and dependency edge as
 * fixed-size integer records in shared arrays — and it holds exactly one
 * current value per atom. React's concurrent rendering needs several views
 * of the state to coexist (a paused background render must keep seeing the
 * state it started from while urgent updates land and commit — the README
 * tells the full story), so this module records every write and
 * reconstructs the other views on demand.
 *
 * ## One core, always concurrent
 *
 * These sections are internal machinery of the single `cosignals` entry —
 * index.ts imports and re-exports them — and the one engine composes at
 * module initialization ({@link composeEngine}; `__resetEngineForTest`
 * re-runs it, nothing else does). There is no installation step: the public
 * Atom/Computed methods dispatch into the engine's paths directly — writes
 * through {@link writeAtomConcurrent} (behind the `standaloneQuiet` fast
 * arm), reads through the routed-read trampolines (behind the
 * `routingActive` flag) — and a process that never attaches a driver and
 * never opens a batch keeps both fast arms forever (tests/one-core.spec.ts
 * asserts zero log entries/batches/worlds under heavy sync-only traffic).
 * A host attaches through {@link attachDriver} (one driver: batch context
 * for writes, the ambient world for reads, the operation-boundary
 * listeners).
 *
 * ## Vocabulary (in reading order; see also the package README)
 *
 * - A **write-log entry** records one write: the operation (set /
 *   functional update — a ReducerAtom dispatch records as an update whose
 *   closure captures the action), the batch it belongs to, and its position
 *   (`seq`) on one global timeline. Log entries append to the written
 *   atom's **write log** — the per-atom history (class {@link WriteLog}).
 *   A **fold** replays, in timeline order, the log entries a given view may
 *   see over the atom's **base** (the permanent history, already collapsed
 *   to a single value); a **world** is one self-consistent assignment of
 *   values to every atom, produced by such a fold. Ops are stored whole
 *   (not pre-folded) so updaters and reducers replay per world — which is
 *   why they must be pure (the fold-purity guard: signal reads/writes
 *   inside them throw).
 * - A **batch** is the group of writes belonging to one UI update (one
 *   event handler, one transition, one async action); a Batch record
 *   (keyed by its BatchId) is the batch's identity. React schedules each
 *   batch on one of its 31 **lanes** (a lane is React's internal unit of
 *   scheduling priority; work in one lane renders and commits together),
 *   so at most 31 batches are ever live at once. Each live batch that has
 *   written occupies a **slot** — one entry of a 31-entry recycling table —
 *   so "which batches affect X" fits in one 31-bit integer word (a
 *   BatchSlotSet). **Interning** is claiming a free slot for a batch at its
 *   first write; the slot's current batch is its **tenant**, and a released
 *   slot is recycled to the next claimant.
 * - A **render pass** is one render of one root. Its **pin** is the
 *   timeline position frozen at render start — the render folds nothing
 *   written after its pin, so a paused-and-resumed render never drifts.
 *   Its **mask** is the set of live batches (and their slots) the render
 *   is rendering.
 * - **Retirement** ends a batch: its log entries become permanent history
 *   visible to every world. Write records are episode-lifetime — they stay
 *   on the log until the episode closes (below), where the durable handoff
 *   drops them wholesale; only the bounded-memory valve (the write-log
 *   section's retired-prefix fold) ever folds entries into base mid-episode.
 *   `committedAdvance` is the committed-advance counter, bumped whenever
 *   committed truth moves (a per-root commit, or a retirement that changed
 *   history).
 * - A **watcher** is one subscribed component instance; a **delivery** is
 *   the notification that schedules a watcher's re-render after a write.
 *   Deliveries are **value-blind**: a delivery announces "a write in this
 *   batch may affect you", never a value — whether the value changed
 *   depends on the world doing the asking, so the receiving render folds
 *   its own world. A **drain** is the sweep run when committed truth moves:
 *   re-check every observer the change could reach against committed state
 *   and correct the stale ones.
 * - The engine keeps two dependency graphs. One is the kernel's own graph
 *   (the packed records in CosignalEngine.ts), which only knows newest values. The
 *   other is the per-world **world arenas**: one packed record arena per
 *   render world and per committed-for-root world, holding a **shadow**
 *   (value + flags) per consumed node and the strong and weak-flagged
 *   links the world's own evaluations actually took. Arenas are the
 *   routing and serving authority for render/committed worlds: write-time
 *   deliveries walk arena strong links, durable drains seed from arena
 *   dirty lists, and world reads serve from arena walks. Committed-truth
 *   flips fan marks out into the arenas at four sites: retirement,
 *   per-root lock-in, committed-member write, and quiet fold — plus
 *   resource settlement.
 * - Newest computed serving is the kernel's. Every engine computed rides a
 *   kernel `Computed` record: the kernel's own dep links, staleness marks,
 *   and value cache serve the newest world, so a computed re-derives only
 *   when a tracked dependency changed — untracked reads are point-in-time
 *   samples taken at those re-derivations (the untracked-sampling rule).
 *   Kernel atoms serve newest directly (the eager-apply invariant);
 *   everything else folds.
 * - An **episode** runs from the first pending durable work (a batch opens,
 *   an action parks, a render starts — never inferred from writes or call
 *   depth) to full **quiescence** (every batch retired — **parked** async
 *   actions included, kept pending until their promise settles — and every
 *   render closed). Episode-lifetime state — write records, batch
 *   bookkeeping — drops WHOLESALE at that boundary after the durable
 *   handoff (the episode lifecycle: canonical newest becomes each
 *   touched atom's base by identity and the logs vanish). NOT
 *   episode-lifetime: committed-root routing structure (a mounted watcher's
 *   dependency cone is current routing state and persists across
 *   quiescence, exactly as committed arenas do), observer records and their
 *   baselines, and dependency edges anywhere (edges purge and re-link per
 *   evaluating world). The kernel's newest caches persist the same way
 *   (nothing newest-visible changes at quiescence). Sequence values are
 *   never rewritten: the global counter climbs monotonically for the
 *   process's life (exact to 2^53 — see the bound note at `quiesce`).
 *
 * ## What lives here (full stories at the implementation sites)
 *
 * - log entries: every write appends {op, slot, seq, retiredSeq} to the
 *   written atom's write log.
 * - kernel riding: every recorded write also applies to the kernel eagerly
 *   with stepwise equality (each step keeps the previous reference when
 *   the atom's equals function says nothing changed) — engine atoms are
 *   kernel-backed `Atom` handles, and the newest world is read straight
 *   off the kernel. The engine-vs-reference-model diff verifies kernel
 *   value ≡ fold(base, log entries) at every step of the test corpus.
 * - arena routing: write-time delivery reachability runs from the written
 *   atom over every live arena's strong links (weak links are tested and
 *   skipped — untracked reads never notify); kernel subscribers are served
 *   by the eager kernel apply. Deliveries stay value-blind and may be
 *   fewer than the model's union-conservative set (never more): a cone
 *   reachable only through structure no live arena holds degrades to a
 *   drain correction instead of a live delivery.
 * - worlds as pure folds with the two-clause visibility rule (see
 *   {@link isVisible}), the committed-for-root world, and the fast-forwarded
 *   mount-fixup world (see {@link runMountFixup}).
 * - per-write value-blind synchronous delivery in the writer's stack with
 *   render-aware suppression, per-(watcher, slot) dedup, and dedup clear
 *   at slot re-intern.
 * - the slot lifecycle: a retiring tenant stamps its log entries before
 *   its slot releases; a re-claimed slot gets a fresh claim sequence, and
 *   a render's pin/seq checks always postdate the claim; release is
 *   deferred while any open render mask names the slot and re-evaluated at
 *   every render end; disposal keeps conservative touched bits until no
 *   live pin can still need them; a loud release-anyway backstop prevents
 *   deadlock.
 * - retirement ordering stamp → fold valve → drain → clear-rows → release →
 *   episode close (the fold valve and the quiescence handoff live in
 *   the write-log section), and per-root commit lock-in
 *   (a root that committed UI from a still-live batch must keep agreeing
 *   with its own screen).
 * - **mount fixup** (see {@link runMountFixup}): the commit-edge
 *   reconciliation for a freshly mounted component — decided conditions
 *   first. A component can mount while other updates are in flight, and
 *   its subscription only activates at commit, so writes could slip by
 *   unobserved between its render and its commit; fixup joins it to the
 *   pending batches it missed (from write metadata alone), then a
 *   four-condition test decides whether anything committed or retired in
 *   the window — only a failing condition triggers the fast-forwarded
 *   re-evaluation and urgent pre-paint correction. One subtle rule: the
 *   write-clock condition quantifies over the committing render's member
 *   batches at commit time (a batch whose first write landed mid-render
 *   is invisible to the earlier-captured slot set).
 * - subscriptions (see the Subscription type): the one `run`-action
 *   consumer record — committed subscriptions, the production
 *   useSignalEffect mechanism. (Core `effect()`s are not engine records:
 *   they are real kernel effects, flushed by the eager kernel apply — see
 *   {@link logCoreEffectRun}.) Committed subscriptions hold a dep snapshot
 *   captured by `captureRun` under committed-for-root and re-check
 *   value-gated at the boundary operations (per-root commit, retirement,
 *   settlement, quiet fold): once per boundary operation, at the boundary
 *   value, never while the subscription's own root has an open render
 *   frame; cleanup guaranteed at removal. Their dep snapshots also join
 *   the observation union (one retain per snapshot node through the
 *   observation index's shiftObservedCount).
 * - episodes / quiescence (epoch reset), as defined above.
 *
 * The engine surface consumes the external-runtime protocol's event shapes
 * (batch open/retire, render begin/yield/resume/end with per-root commits,
 * settlements) — the events a patched React build emits about its own
 * scheduling. The React bindings (`cosignals-react`) drive it from a real
 * protocol build; the test suite drives it in lockstep with the reference
 * model (`cosignals-oracle`).
 *
 * ## Deliberately deferred (marked at each site)
 *
 * TODO(perf): a "provably quiet" world-read fast path (serve a shared cache
 * instead of the arena walk when nothing pending can reach the node).
 * Correctness constraint: the cold in-arena fn run is what records the
 * strong and weak links the whole routing coverage argument stands on — a
 * re-entry may value-serve only when the arena already holds the node's
 * links; structure recording may never be skipped. The read-before-pending
 * pin is the tripwire.
 */

// ---- engine-surface types (structurally mirror the reference model's) ------------

export type Value = unknown;
export type RootId = string;
export type RenderPassId = number;
export type WatcherId = number;
/** A committed `run`-action subscription's id: the committed-observers
 * section's monotone mount counter (registration order — the boundary
 * scan's iteration order, the reference model's map order) — never a kernel
 * record id (subscription RECORDS recycle; this id never does). Leniently
 * branded (IdBrand above) so the spaces cannot cross. */
export type SubscriptionId = number & IdBrand<'subscription'>;
/** A point on the one global sequence line (log-entry seqs, pins, retirement
 * stamps, write clocks, the committed-advance counter). */
export type Seq = number;
/** Episode counter: bumped at quiescence when the engine's per-node-id tables bulk-reset. */
export type Epoch = number;
/** A root's commit generation (bumped at every per-root commit). */
export type CommitGen = number;


export type Equals = (a: Value, b: Value) => boolean;

export class AtomInternals {
	readonly kind = 'atom' as const;
	readonly id: NodeId;
	/** Cached NodeField.NODE_INDEX of `id`'s record: object-carrying paths pay
	 * one property read; raw id-driven walks read it from kernel memory. Stable
	 * for the node's life (the index moves only when the record slot re-tenants,
	 * which this node does not survive). @internal */
	readonly ix: NodeIndex;
	name: string;
	/** The floor every world folds from: the atom's episode-start value
	 * (advanced only by quiet folds, fold-valve folds, and the episode
	 * close's durable handoff). */
	base: Value;
	baseSeq: Seq = 0;
	/** Packed log entry columns (the engine truth; tests/diagnostics materialize
	 * them via `log.materialize()`; the test-side model-shaped view lives in
	 * tests/model-view.ts). */
	log = new WriteLog();
	equals: Equals;
	/** True iff `equals` is the default Object.is — isAtomValueEqual's branch: the
	 * default compares bare, a custom comparator runs under the fold-purity
	 * guard. */
	eqIsDefault: boolean;
	/** Per-atom retirement stamp, created at every retirement fold touching it.
	 * Sole consumer: retireInner's duplicate-touch dedup. */
	retirementStamp: Seq = 0;
	/** The public handle this node rides — strong for engine-created nodes
	 * (engine.atom: the NODE is the public object and owns its
	 * handle), a WeakRef for handle-resolved nodes ({@link internalsForAtom}).
	 * Reclamation rule: the engine must never pin a public handle — the handle
	 * pins the node (`Atom._internals`), never the reverse — or a content-ful
	 * handle could never become unreachable and its record could never free.
	 * Warm paths never read this slot: they use the `id` copy (identical by
	 * construction); the cold consumers go through the `handle` getter.
	 * @internal */
	_h: Atom<Value> | WeakRef<Atom<Value>>;
	/** Last batch id that appended here (dedupe for batch.atomsTouched). */
	lastTouchBatch: BatchId = 0;

	/** The public handle (cold accessor — see `_h`; typed live: every caller
	 * that can observe a dead handle goes through `_h` directly). */
	get handle(): Atom<Value> {
		const h = this._h;
		return h instanceof WeakRef ? (h.deref() as Atom<Value>) : h;
	}

	constructor(id: NodeId, ix: NodeIndex, name: string, initial: Value, equals: Equals, eqIsDefault: boolean, h: Atom<Value> | WeakRef<Atom<Value>>) {
		this.id = id;
		this.ix = ix;
		this.name = name;
		this.base = initial;
		this.equals = equals;
		this.eqIsDefault = eqIsDefault;
		this._h = h;
	}
}

export type Reader = (node: AnyInternals) => Value;
export type ComputedFn = (read: Reader, untracked: Reader) => Value;

/**
 * The engine's computed node record — one computed representation. Every
 * engine computed rides a kernel `Computed` record:
 * the kernel serves the newest world (links, marks, value cache — the
 * sampled-untracked rule falls out of kernel semantics), and the engine
 * evaluates `fn` under render/committed worlds through the arena walks. For
 * engine-created computeds `fn` is the authored (read, untracked) function;
 * for handle-resolved public `Computed`s it is the engine's ctx adapter
 * (committed `previous` cell, the id-keyed `use` request cache,
 * background-suspension fold) around the handle's raw fn.
 */
export class ComputedInternals {
	readonly kind = 'computed' as const;
	id: NodeId;
	/** Cached NodeField.NODE_INDEX of `id`'s record (see AtomInternals.ix). @internal */
	ix: NodeIndex;
	name: string;
	/** The world evaluation function (arena refolds, mount-fix folds). */
	fn: ComputedFn;
	/** The public handle whose kernel record this node rides — strong for
	 * engine-created computeds (`computed()`: the node owns its handle), a
	 * WeakRef for resolved public handles ({@link internalsForComputed}). Same reclamation
	 * rule as AtomInternals._h: the engine never pins a public handle; warm paths
	 * read the `id` copy. @internal */
	_h: Computed<unknown> | WeakRef<Computed<unknown>>;
	/** True for handle-resolved public computeds (ctx-shaped raw fns): their
	 * world fn is the engine's ctx adapter, and background newest reads fold
	 * pending suspensions to sentinel values. */
	ctxShaped: boolean;
	/** Retention: the policy comparator (argument order `isEqual(prev,
	 * next)`, previous first), applied by arena refolds against the
	 * arena-local previous value; undefined = default equality (Object.is). */
	isEqual: Equals | undefined;
	/** ctx.previous for handle-resolved ctx-shaped fns: the node's last
	 * committed value (a best-effort hint; may be stale or undefined),
	 * updated at render commits from the watchers that rendered it. A plain
	 * field: the readers already hold the node. */
	prevCommitted: Value = undefined;

	/** The public handle (cold accessor — see `_h`). */
	get handle(): Computed<unknown> {
		const h = this._h;
		return h instanceof WeakRef ? (h.deref() as Computed<unknown>) : h;
	}

	constructor(id: NodeId, ix: NodeIndex, name: string, fn: ComputedFn, h: Computed<unknown> | WeakRef<Computed<unknown>>, ctxShaped: boolean, isEqual: Equals | undefined) {
		this.id = id;
		this.ix = ix;
		this.name = name;
		this.fn = fn;
		this._h = h;
		this.ctxShaped = ctxShaped;
		this.isEqual = isEqual;
	}
}

export type AnyInternals = AtomInternals | ComputedInternals;


export type RootState = {
	id: RootId;
	/** Per-root lock-in rows: batches this root has committed but that are
	 * still live elsewhere (cleared at retirement, when the retired clause
	 * subsumes membership). */
	committedBatches: Set<BatchId>;
	commitGen: CommitGen;
	/** The root's current committed-slot set (live committed batches' slots)
	 * — maintained at per-root commit, late slot intern, and retirement. */
	committedBits: BatchSlotSet;
	/** Member slots written since the last drain. A write into a slot that is
	 * already a committed member changes committed truth immediately, so the
	 * next durable drain must reconcile everything downstream of it (the
	 * reference model's full observer scan catches this at any
	 * retirement/commit; the engine keeps the precise dirty set instead). */
	committedDirtySlots: BatchSlotSet;
};

/** Write-kind tags: the packed log entry column and the write surface's kind
 * argument (`write`/`bareWrite`) — 0 = set, 1 = update, the same codes
 * index.ts's public write dispatch carries end to end (its public
 * `WriteKind` type alias names the same 0/1 encoding by construction;
 * 0/1 literals are assignable, so index.ts never needs this type's name).
 * Same-file const enum: the write/fold paths below name the members
 * directly and they inline to the bare 0/1 codes under whole-program emit
 * and per-file transforms alike. */
export const enum WriteKind {
	SET = 0,
	UPDATE = 1,
}

/**
 * Engine-activity probes (test surface): one module-wide counter record
 * proving the zero-cost promise behaviorally — with no driver attached and
 * no batch open, heavy signal traffic must leave every field at its baseline
 * (tests/one-core.spec.ts). Engine logic never reads the counters; each
 * mutation site lives beside the machinery it counts (log-entry appends in
 * the write-log section, batch creation in the batch section, world
 * evaluations in the worlds section, composition in the composition
 * section), and the snapshot reader is `__coreProbes()` in the public-
 * dispatch section.
 */
export const probes = { logEntries: 0, batches: 0, worldEvals: 0, bridges: 0 };

/** The decoded shape of the engine's observable events (same shapes as the
 * reference model's events, so the two can be compared entry by entry). The
 * engine never constructs these objects: instrumentation sites create packed
 * trace records directly (see TraceHooks below), and the test-side decoder
 * (tests/trace-events.ts) reconstructs this shape from an attached tracer's
 * records for model comparison. The type stays declared and
 * exported here because the package entry re-exports it (type-only) and the
 * decoder/model parity pin is written against it. */
export type TraceEvent =
	| { type: 'write'; node: string; batch: BatchId; slot: BatchSlot; seq: Seq }
	| { type: 'write-dropped'; node: string; batch: BatchId }
	/** A quiet-mode fold: the whole write while nothing was pending — no
	 * batch, no log entry, no slot; `seq` is the fold's created sequence (the
	 * atom's new baseSeq and the committed-advance clock). */
	| { type: 'quiet-write'; node: string; seq: Seq }
	| { type: 'delivery'; watcher: string; batch: BatchId; slot: BatchSlot; seq: Seq; mode: 'fresh' | 'interleaved' }
	| { type: 'suppressed'; watcher: string; batch: BatchId; slot: BatchSlot; seq: Seq }
	| { type: 'core-effect-run'; effect: string; value: Value }
	| { type: 'react-effect-run'; effect: string; root: RootId; value: Value; values: Value[] }
	| { type: 'react-effect-cleanup'; effect: string; root: RootId }
	| { type: 'reconcile-correction'; watcher: string; root: RootId; from: Value; to: Value; cause: 'retirement' | 'per-root-commit' }
	| { type: 'mount-corrective'; watcher: string; batch: BatchId; slot: BatchSlot }
	| { type: 'mount-urgent-correction'; watcher: string; from: Value; to: Value }
	| { type: 'per-root-commit'; root: RootId; batch: BatchId }
	| { type: 'retired'; batch: BatchId; retiredSeq: Seq }
	| { type: 'slot-claimed'; slot: BatchSlot; batch: BatchId }
	| { type: 'slot-released'; slot: BatchSlot; batch: BatchId }
	| { type: 'slot-backstop-released'; slot: BatchSlot; batch: BatchId }
	| { type: 'render-committed'; renderPass: RenderPassId; root: RootId }
	| { type: 'render-discarded'; renderPass: RenderPassId; root: RootId }
	| { type: 'epoch-reset'; epoch: Epoch };

/**
 * The trace seam. The concurrent engine's semantic events flow to an optional
 * hook object held on the engine core record (the `engine.trace`
 * accessor pair) — `undefined` unless
 * `cosignals/trace` (a lazily loaded, runtime-import-free entry) has attached
 * a recorder. Discipline, asserted by tests/trace-off.spec.ts:
 *
 *  - this module never imports the trace module (the module graph gains
 *    tracing only when the app imports `cosignals/trace`);
 *  - every hook site is guarded by exactly one nullable-slot check
 *    (`const tr = this.trace; if (tr !== undefined) ...`) — that one check
 *    is the entire cost when no tracer is attached;
 *  - hooks receive the engine's own live objects and integers; they must not
 *    mutate them, and the recorder must not allocate per event (one
 *    documented exception: `reactEffectRun`'s dep-values array, built by its
 *    site only under the guard — the model-comparison suites compare it).
 *
 * One channel: the packed trace stream. Every instrumentation site creates its
 * record directly through a typed hook — scalars and live engine objects in,
 * one fixed-size record out; no intermediate event object exists anywhere.
 * The hook set covers the observable event vocabulary (`TraceEvent`, decoded
 * test-side) plus trace-only semantics: batch open/settle, render
 * start/yield/resume/end (fired before the end's consequences, unlike the
 * post-consequence renderCommitted/renderDiscarded markers), per-log-entry ops,
 * world evaluations, deferred slot release, and the mount fixup disposition
 * (fast-out vs compare vs correction). `opEnd()` marks the close of each
 * compound public operation so the recorder can scope causality (see
 * Tracer.ts `CAUSE`).
 */
export type TraceHooks = {
	/** A log entry was created — the write record (carries op/batch/slot/seq). */
	logEntry(node: AtomInternals, entry: WriteLogEntry): void;
	/** A write dropped without a log entry (empty write log + equal against base). */
	writeDropped(node: AtomInternals, batch: BatchId): void;
	/** A quiet-mode fold accepted (no batch, no log entry; seq = the fold's clock). */
	quietWrite(node: AtomInternals, seq: Seq): void;
	/** A batch was created. */
	batchOpen(t: Batch): void;
	/** An async-action batch settled (its retirement follows). */
	batchSettle(t: Batch): void;
	/** The external runtime's committed/abandoned report for a batch. Created
	 * by the bindings' protocol handler — the site where the fact is born —
	 * never by the engine: retirement itself is disposition-blind (recorded
	 * writes never revert either way), so the flag exists only as this
	 * source-side diagnostic record. */
	batchDisposition(batch: BatchId, committed: boolean): void;
	/** RenderPass edges (end fires before retirements/commits/fixups). */
	renderStart(p: RenderPass): void;
	renderYield(p: RenderPass): void;
	renderResume(p: RenderPass): void;
	renderEnd(p: RenderPass, kind: 'commit' | 'discard'): void;
	/** Post-consequence checkpoint markers: every retirement fold / lock-in /
	 * drain / fixup of the render end has landed (the reference model's stream
	 * position for its render events). */
	renderCommitted(p: RenderPass): void;
	renderDiscarded(p: RenderPass): void;
	/** A value-blind delivery reached a live watcher. */
	delivery(w: Watcher, batch: BatchId, slot: BatchSlot, seq: Seq, interleaved: boolean): void;
	/** Delivery skipped: scheduled-but-unstarted work will fold the write. */
	suppressed(w: Watcher, batch: BatchId, slot: BatchSlot, seq: Seq): void;
	/** A core effect's value-gated run (via the engine's logCoreEffectRun seam). */
	coreEffectRun(effect: string, value: Value): void;
	/** A committed-world observer ran; `values` is its dep snapshot (the one
	 * per-event array a site builds, tracer-attached only — model-compared). */
	reactEffectRun(effect: string, root: RootId, value: Value, values: Value[]): void;
	/** A committed-world observer's cleanup ran (pre-re-run or removal). */
	reactEffectCleanup(effect: string, root: RootId): void;
	/** A drain moved this watcher's on-screen value to follow committed truth. */
	reconcileCorrection(w: Watcher, root: RootId, from: Value, to: Value, perRootCommit: boolean): void;
	/** Mount catch-up: a corrective re-render joined a live batch's lane. */
	mountCorrective(w: Watcher, batch: BatchId, slot: BatchSlot): void;
	/** The urgent pre-paint mount-window fix. */
	mountCorrection(w: Watcher, from: Value, to: Value): void;
	/** A root locked a batch in; commitGen is the root's (just-bumped) generation. */
	perRootCommit(root: RootId, batch: BatchId, commitGen: CommitGen): void;
	/** The batch retired: its writes became permanent history. */
	retired(batch: BatchId, retiredSeq: Seq): void;
	/** Slot lifecycle (claim / identity release / loud backstop eviction). */
	slotClaimed(slot: BatchSlot, batch: BatchId): void;
	slotReleased(slot: BatchSlot, batch: BatchId): void;
	slotBackstopReleased(slot: BatchSlot, batch: BatchId): void;
	/** A computed evaluation in a world opened/closed (paired; end fires on throw too). */
	evalStart(node: ComputedInternals, world: World): void;
	evalEnd(): void;
	/** A retired tenant's release was deferred (an open render mask names the slot). */
	slotReleaseDeferred(slot: BatchSlot, batch: BatchId): void;
	/** One per mount: how fixup resolved, and how many correctives were scheduled. */
	runMountFixup(
		w: Watcher,
		disposition: 'fast-out' | 'compare-clean' | 'corrected',
		correctives: number,
	): void;
	/** Quiescence reset the engine's per-episode state. */
	epochReset(epoch: Epoch): void;
	/** A compound public operation (write / renderEnd / retire / settle / quiesce) finished. */
	opEnd(): void;
};

// (SLOT_COUNT — the 31-slot table bound — lives in Batch.ts with the slot table.)

// ---- module state: the one engine -------------------------------------------------
// There is exactly one concurrent engine per process (always-concurrent —
// the composition runs at module initialization, `__resetEngineForTest`
// re-runs it). The bindings the operational surface reads live here as
// module state; `composeEngine` (the composition section) re-initializes
// every field at each composition.

/** The attached driver, or undefined (host-agnostic embedding / tests). */
let driver: EngineDriver | undefined;

/**
 * The armed quiet state — the one boolean the write path branches on,
 * recomputed only at pipeline transitions (batch open/retire, render
 * start/end, driver attach): quiet ⇔ zero live batches and zero open renders
 * and no episode write records held. While quiet, a context-free write to a
 * node with engine content folds directly (see {@link quietWrite}); a handle with
 * no engine content takes the plain graph write (the internals-less arm — its
 * whole history is quiet folds, so kernel-current is its committed base).
 */
export let quiet = true;
// (quiet and no driver — the public fast-arm flag `standaloneQuiet` — lives
// in index.ts beside the write methods that read it every call; the quiet
// derivation lands it there through `__setStandaloneQuiet`.)

// ---- engine-activity probes (test surface) -----------------------------------------
// (The counter record is declared above with the write-kind codes; engine
// logic never reads it.)

/** Test surface — a snapshot of the engine-activity counters for the zero-cost test. @internal */
export function __coreProbes(): { logEntries: number; batches: number; worldEvals: number; bridges: number } {
	return { ...probes };
}

// ---- the public write dispatch (called by index.ts's Atom.set/update) -------------

/**
 * The concurrent write dispatch — everything after index.ts's policy assert
 * and its standalone fast arm (a contentless handle while `standaloneQuiet`
 * takes the plain graph write without entering this function):
 *
 *   driver attached → one foreign call for the batch context
 *     (`driver.currentBatch()` — protocol v2: the id is the engine BatchId,
 *     allocator-opened at the batch's creation) → recorded write into it;
 *     BATCH_NONE converges to the context-free arm below.
 *   quiet → the internals-less arm (plain graph write) or the quiet fold.
 *   else → the ambient default batch (bareWrite).
 */
export function writeAtomConcurrent(atom: Atom<unknown>, kind: WriteKind, payload: unknown): void {
	const d = driver;
	if (d !== undefined) {
		const batchId = d.currentBatch();
		if (batchId !== BATCH_NONE) {
			writeInBatch(batchId, internalsForAtom(atom), kind, payload);
			return;
		}
	}
	if (quiet) {
		const node = atom._internals;
		if (node === undefined) {
			// The internals-less arm: no engine content (no log entries, no
			// watchers, no arena presence) means no world consumer can see
			// this atom except through newest — the plain graph write is the
			// whole quiet fold (index.ts owns the tail: fold + policy
			// equality once + kernel write). Content allocation later
			// re-seeds base from kernel-current, which this write is part of.
			__plainAtomWrite(atom, kind, payload);
			return;
		}
		quietWrite(node, kind, payload);
		return;
	}
	bareWrite(internalsForAtom(atom), kind, payload);
}

/** The id-resolved atom node, if it has engine content (the lifecycle
 * write path's handle-free resolution; lifecycle records exist for live
 * atoms only, and a freed record's dense row is scrubbed — see
 * getResidentInternals's liveness note). @internal */
export function __engineAtomInternalsById(id: NodeId): AtomInternals | undefined {
	const hit = getResidentInternals(id);
	return hit !== undefined && hit.kind === 'atom' ? hit : undefined;
}

/**
 * The bare-id resolution: dense row by the record's live kernel NODE_INDEX
 * (`nodeIndexToInternals[getKernelNodeIndex(id)]`) — the one id→node path.
 *
 * ## Why the dense row is safe as the only registry
 *
 * Liveness rests on two facts: the record-free scrub clears the row at the
 * free boundary (a dead id resolves to undefined), and both the record id
 * and its NODE_INDEX are slot-tied (a reused id resolves to the slot's new
 * tenant — which is why every staleness-sensitive consumer carries a GEN
 * check on top: Watcher resolution). Callers whose id is not provably a
 * node record id must also identity-check `hit.id === id`: a link record's
 * field 7 is free-list residue, so a garbage id can alias an unrelated row.
 */
function getResidentInternals(id: NodeId): AnyInternals | undefined {
	const ix = getKernelNodeIndex(id);
	return ix < nodeIndexToInternals.length ? nodeIndexToInternals[ix] : undefined;
}

/** Test seam: resolve a node id to its resident internals, exactly as
 * {@link getResidentInternals} does on the warm paths. @internal */
export function __internalsByIdForTest(id: NodeId): AnyInternals | undefined {
	return getResidentInternals(id);
}

/** Test seam: every resident internals record, in NodeIndex order. @internal */
export function __eachInternalsForTest(): AnyInternals[] {
	return nodeIndexToInternals.filter((n): n is AnyInternals => n !== undefined);
}

/** The classified dispatch over an already-resolved node (the handle-free
 * lifecycle write path — same arms as writeAtomConcurrent). @internal */
export function __engineWriteNode(node: AtomInternals, kind: WriteKind, payload: unknown): void {
	const d = driver;
	if (d !== undefined) {
		const batchId = d.currentBatch();
		if (batchId !== BATCH_NONE) {
			writeInBatch(batchId, node, kind, payload);
			return;
		}
	}
	if (quiet) {
		quietWrite(node, kind, payload);
		return;
	}
	bareWrite(node, kind, payload);
}


/** An arena buffer capacity, counted in Int32 slots (stride-8 records: one
 * node shadow or one dependency link per record; positive — the growth
 * doubling starts from it). */
export type ArenaInitInts = number;

/** Engine tuning — accepted by `__resetEngineForTest`; a never-reset
 * production process runs the defaults. */
export type EngineResetOptions = {
	/**
	 * The world arenas' initial buffer reservation. Defaults to the
	 * generous engine reservation (64MiB of records — zero-fill
	 * demand-paged, so untouched records cost no resident memory and
	 * growth stays rare); an arena that outgrows its reservation doubles
	 * its buffers by copy, mid-operation — exhaustion is never fatal. The
	 * arena suites shrink this to force that growth path on every
	 * allocation (tests/arena-sa2.spec.ts, tests/arena-sd.spec.ts).
	 */
	arenaInitInts?: ArenaInitInts;
	/**
	 * Arms development-time checks in the engine and the bindings driving
	 * it: protocol-edge states the host integration contract makes
	 * unreachable (a write with no batch context, a render pass starting
	 * over a still-open one, opening a batch with no driver attached) throw
	 * instead of taking their defined fall-through, and dev-only diagnostics
	 * (the post-await orphan-write warning) run. Default off: each guarded
	 * site then costs one boolean branch and allocates nothing. Test
	 * harnesses arm it so suites exercise the throws.
	 */
	devChecks?: boolean;
};

/**
 * The driver seam — the one attachment surface a host integration installs
 * (the React bindings' shim, or a test harness standing in for them):
 * one record, installed once, a second attach throws (reset clears it).
 *
 * The driver contract:
 *  - `currentBatch` is consulted once per classified public write (the one
 *    foreign call — protocol v2: the returned id is the engine BatchId,
 *    because the driver's registered batch-id allocator opened the engine
 *    batch at the batch's creation; `openBatch` is the engine half of that
 *    allocator, and its allocation-only envelope is documented there).
 *    Returning BATCH_NONE means "no batch context": the write converges to
 *    the ordinary context-free arm (quiet fold, else the ambient batch).
 *  - `worldFor` answers the ambient world for routed reads from the live
 *    call context (the render actually on stack; undefined = newest).
 *  - the listeners are delivered at each operation's boundary (never
 *    mid-operation).
 *  - `protocolReset` (test-only) clears the host's protocol registry (the
 *    fork's full slot tenancy); `__resetEngineForTest` invokes it first,
 *    before scrubbing the engine.
 *
 * Hosts that open batches must retire them — `openBatch`/`retire`/
 * `renderStart`/... remain the host-agnostic embedding surface; the driver
 * only carries the write/read context and the consumption listeners.
 */
export type EngineDriver = {
	/** The host's batch context for the write executing now (BATCH_NONE = none). */
	currentBatch(): BatchId;
	/** The ambient world for routed reads (undefined = newest). */
	worldFor(): World | undefined;
	/** A value-blind delivery reached a live watcher (fresh or interleaved). */
	onDelivery?: (w: Watcher, batch: Batch, slot: BatchSlot) => void;
	/** Mount fixup scheduled a corrective re-render into a live batch's lane. */
	onMountCorrective?: (w: Watcher, batch: Batch, slot: BatchSlot) => void;
	/** An urgent pre-paint correction (mount window / committed-truth drift). */
	onCorrection?: (w: Watcher) => void;
	/** Test-only: reset the host's protocol registry (invoked first by
	 * `__resetEngineForTest`; never called in production). */
	protocolReset?: () => void;
};

/**
 * Installs the driver, exactly once per process: a second attach throws;
 * `__resetEngineForTest` clears the slot. Throws inside any open
 * evaluation/fold frame — the seam must not move under a live frame.
 */
export function attachDriver(d: EngineDriver): void {
	if (evalDepth > 0 || inFoldCallback) {
		throw new ScheduleError('attachDriver called inside an open evaluation/fold frame; it may only run at an operation boundary');
	}
	if (driver !== undefined) {
		throw new ScheduleError('a driver is already attached — attachDriver may be called once (reset the engine first in tests)');
	}
	driver = d;
	onDelivery = d.onDelivery;
	onMountCorrective = d.onMountCorrective;
	onCorrection = d.onCorrection;
	setWorldProvider(() => d.worldFor());
	recomputeQuiet(); // re-derives quiet and standaloneQuiet (now false: every write makes the one foreign call)
}

/**
 * The armed checker's window into the engine — returned by
 * `__checkerInternals()`, consumed only by the test-side
 * checker (tests/arena-checker.ts: the divergence check and the structural
 * validator). Readonly-shaped: live state getters plus bracket methods
 * that keep every mutation's save/restore discipline engine-side.
 * @internal
 */
export type ArenaCheckerInternals = {
	/** Arena record layout as plain numbers, restricted to the fields the
	 * structural validator reads. The engine's ArenaField/ArenaLinkField/
	 * ArenaFlag/ArenaGeom are same-file const enums: the owning module inlines the
	 * values into this object at construction, so the view is in sync by
	 * construction — a layout change here flows through automatically, unlike
	 * a hand-copied declaration. Data-passing stays (deliberate): the arena
	 * layout is engine-internal with one external reader (the test-side
	 * checker), and exporting the enums for it would widen the module surface without
	 * deleting any drift risk. (Contrast the kernel's layout, which has
	 * independent walkers and is therefore exported from index.ts —
	 * NodeField/LinkField/NodeFlag.) ArenaField/ArenaLinkField entries are
	 * Int32 word offsets within a record; ArenaFlag entries are FLAGS bits;
	 * ArenaLinkMode entries are bits of the MODE field; ArenaGeom.ID_TO_COLUMN_SHIFT
	 * converts a record id to its side-column index; ArenaGeom.CLOCK_LIMIT is
	 * the Int32 clock-wrap renumber ceiling (readClock/cycle). */
	readonly layout: {
		readonly ArenaGeom: { readonly ID_TO_COLUMN_SHIFT: number; readonly CLOCK_LIMIT: number };
		readonly ArenaField: {
			readonly NODE: number;
			readonly MARK: number;
			readonly FLAGS: number;
			readonly DEPS: number;
			readonly SUBS: number;
		};
		readonly ArenaLinkField: {
			readonly DEP: number;
			readonly SUB: number;
			readonly PREV_DEP: number;
			readonly NEXT_DEP: number;
			readonly NEXT_SUB: number;
			readonly MODE: number;
		};
		readonly ArenaLinkMode: { readonly WEAK: number };
		readonly ArenaFlag: { readonly DIRTY: number; readonly BOX_SUSPENDED: number };
	};
	/** Open world-evaluation frames — the checker must not run inside one
	 * (an epilogue can fire from a nested context; the check waits for the
	 * next top-level boundary). */
	readonly evalDepth: number;
	/** An updater/reducer/equals fold callback is on the stack (same bar). */
	readonly inFoldCallback: boolean;
	/** Every live arena: committed arenas by root, then open-render arenas —
	 * the check's iteration domain (the stores are private). */
	eachArena(fn: (a: WorldArena) => void): void;
	/** The dense node row by NODE_INDEX (the key in the arenas' NODE column), or
	 * undefined for a disposed index (an arena's nodeToShadow rows can
	 * outlive their node — the checker skips those). */
	internalsAt(ix: number): AnyInternals | undefined;
	/** `arenaServe` — the arena serving entry (values, walks, refolds). The
	 * checker serves the arena side first, pinning the discipline that a
	 * stale shadow is never refreshed by the reference side before the
	 * comparison reads it. */
	serve(a: WorldArena, node: AnyInternals): Value;
	/** One fold-truth fn run (see `runInFoldTruthFrame`): world pinned, serve
	 * override at FOLD_TRUTH, capture/sink closed, eval depth bumped —
	 * everything restored on the way out. */
	runInFoldTruthFrame<T>(world: World, fn: () => T): T;
	/** The engine's one cycle-error construction — the naive side's cycle
	 * throws must compare string-equal to the arena side's. */
	createCycleError(name: string): ScheduleError;
	/** The fold-purity bracket: the checker runs user equality comparators
	 * under it, exactly like every other comparator call site. */
	runInFoldCallback<T>(fn: () => T): T;
	/** Op-depth bracket around one whole checker run: settle taps landing
	 * mid-check enqueue for the epilogue's drain instead of draining
	 * re-entrantly (the settlement fixed point holds across the whole check). */
	holdOp<T>(fn: () => T): T;
	/** Install (or clear) the armed epilogue hook — fired after every
	 * public operation's settlement fixed point. */
	armEpilogueCheck(check: (() => void) | undefined): void;
};

// ---- the one engine's module state -------------------------------------------------
// One declaration per field; `composeEngine` (the composition section)
// assigns every one of these fresh at module initialization and at each
// test reset. Registries and dense columns get fresh identities per
// composition (the column suites pin that); the batch-id counter is the one
// deliberate survivor — see its note in the batch section. Every section
// reads these as same-module bindings, the one-load access shape the
// pre-fusion factory closures had.

/** Render-pass records by id (the render-integration section owns every
 * transition; the quiescence sweep and tests read it in place). */
let idToRenderPass: Map<RenderPassId, RenderPass>;
/** Root records by id (per-root committed-membership rows; `root` below is
 * the lookup-or-create). */
let roots: Map<RootId, RootState>;
/** Watchers by id (deliveries and drains fire in id order — the reference
 * model's map order). */
let watchers: Map<WatcherId, Watcher>;
/** The one open (non-ended) render per root — React renders one tree per
 * root at a time; a same-root restart is a new render. */
let rootToOpenRender: Map<RootId, RenderPass>;

// ---- dense per-node columns (routing walk scratch + the registry) ----
// Keyed by nodeIndex (NodeField.NODE_INDEX — read off kernel record memory;
// internals objects cache it as `.ix`), never by NodeId — node and link
// records share the kernel's one allocator, so record-id keying would go
// holey where index keying stays packed. Each column's row for a freed
// record clears in __onRecordFree (the record-free scrub): indexes recycle
// with record slots, and the slot's next tenant must never see the old
// tenant's rows. Columns gap-fill at content allocation
// ({@link indexInternals}) — handle creation costs nothing here.
/** Per-node visited/collection generation column: one stamp per nodeIndex,
 * shared by the routing walks (delivery collection dedup across
 * arenas, drain candidate dedup) — arena traversal termination uses the
 * per-arena `walk` side column instead, because the same node's cone
 * differs per arena and must be walked in each. */
let lastWalk: WalkGen[];
/** The internals registry: engine internals (atoms and computeds) by nodeIndex —
 * dense, gap-filled, scrubbed at record free (`disposeComputed` and the
 * record-free scrub clear rows, so a reused record id can never resolve to
 * a dead tenant). Nodes appear on first content (a log entry, a watcher,
 * arena presence, a routed read, an engine.atom/engine.computed
 * construction) — never at handle creation. Bare record ids resolve through
 * `getResidentInternals` (one id space; NODE_INDEX is slot-tied). */
let nodeIndexToInternals: (AnyInternals | undefined)[];
/** Watchers by nodeIndex (the routing walks' collection rows). */
let nodeToWatchers: (Watcher[] | undefined)[];
/** Per-world cycle-detection mark column (by nodeIndex) — the worlds
 * section stamps it with the current top-level evaluation generation, so
 * cycle detection allocates no Sets. */
let evalMark: EvalGen[];
/** Top-level world-evaluation generation (per-world cycle detection marks). */
type EvalGen = number;
/** Per-walk visited generation (walk termination without Set allocations). */
type WalkGen = number;

/** The one global sequence line every log entry/pin/stamp is a point on. */
let seq: Seq = 0;
/** Committed-advance counter, in sequence units: bumped whenever committed
 * truth moves (per-root commit, or a retirement that changed history). */
let committedAdvance: Seq = 0;
/** Episode counter; bumped at quiescence when the engine's per-node-id tables bulk-reset. */
let epoch: Epoch = 0;
/** Development-time checks switch (EngineResetOptions.devChecks). */
let devChecks = false;
/** The world arenas' initial buffer reservation, in Int32 slots
 * (EngineResetOptions knob; composeEngine fills the generous default —
 * arenas grow by copy past it). */
let arenaInitInts: ArenaInitInts = 0;
/** Optional log-entry drop observer (test/diagnostics seam): called once
 * per log entry as it leaves the write log — at a fold-valve fold or the
 * episode drop. The reference model's
 * retention invariant needs the full history; its archive mirror lives
 * outside the engine (tests/model-view.ts), fed by this hook — keeping
 * every dropped log entry in-engine would grow without bound. Production
 * leaves it undefined and retains nothing. */
let onLogEntryDrop: ((atom: AtomInternals, entry: WriteLogEntry) => void) | undefined = undefined;

// ---- shared evaluation/operation state ----
// The scalars more than one section reads or writes — each field's home
// section is noted. Module lets so every reader keeps a one-load access
// shape (these were the pre-fusion shared record's fields).
/** The trace recorder slot — the engine's only instrumentation output (one
 * nullable slot; the `engine` surface exposes an accessor pair over it for
 * `cosignals/trace`). */
let trace: TraceHooks | undefined;
/** The world an open evaluation frame is folding in. (worlds) */
let activeWorld: World | undefined;
/** The nodeIndex whose fold-through evaluation frame is open (raw-handle
 * reads gate their observation capture on it; the untracked reader
 * clears it around the dep — sink 0 ⇔ weak; index 0 is burned). (worlds) */
let currentSink: NodeIndex = 0;
/** Strong-dep capture list of the innermost evaluation frame, undefined
 * unless that frame's node is observed — the one field unwatched
 * evaluations pay for (a check per recorded edge). (worlds frame state;
 * arena refolds and the kernel getters open/close it too.) */
let obsCapture: AnyInternals[] | undefined;
/** >0 while a world evaluation is on stack (renders must not write). (worlds) */
let evalDepth = 0;
/** True inside an updater/reducer/equals callback (reads+writes throw). (worlds) */
let inFoldCallback = false;
/** The capture frame `captureRun` opens (committed-observer state; the
 * read-routing resolution consults it per routed read — see the committed-
 * observers section). */
let captureFrame: CaptureFrame | undefined;
/** >0 while a hook-initiated evaluation may legally suspend the render
 * (the bindings bump it through the engine accessor); background
 * evaluations of ctx-shaped computeds fold pending suspensions to sentinel
 * values instead. (worlds) */
let suspendDepth = 0;
/** The serve-override slot — the one override the routed-read path tests
 * (setters bracket save/restore, so the
 * innermost override wins). Occupants: a WorldArena (arena-refold
 * routing — raw-handle reads inside arena fn runs serve from that arena)
 * or FOLD_TRUTH (the armed checker's naive reads — atom reads fold plain
 * in the frame's world: no arenas, no memos, no caches; test-armed only).
 * undefined ⇔ no override, the production steady state. (world arenas) */
let serveOverride: WorldArena | typeof FOLD_TRUTH | undefined;
/** Global count of box-suspended shadows (settle-tap fast-out). (world arenas) */
let suspendedCount = 0;
/** The armed divergence-check hook: the test-side structural checker lives
 * in tests/arena-checker.ts and installs itself here through
 * `__checkerInternals().armEpilogueCheck`. Fired at every public
 * operation's epilogue after the settlement fixed point; any mismatch it
 * finds throws — a test failure. Production never installs one,
 * so the epilogue pays one undefined test. (settlement consumes it.) */
let epilogueCheck: (() => void) | undefined;
/** Public-operation nesting (the settlement firing-context discriminant). */
let opDepth = 0;
/** The render currently COMMITTING (set for the span of renderEnd's
 * commit half, cleared in its finally): the watcher correction gate's
 * cross-world discriminant — a candidate re-rendered/mounted by this
 * very render compares its just-reset rendered register against
 * committed truth by value (the fixup-class render↔committed question
 * per-root clocks cannot express); every other candidate gates on
 * clocks alone. (render integration sets it; the delivery walks read it.) */
let committingRender: RenderPass | undefined;
/** Per-walk visited generation source (delivery walk, drains, closures). */
let walkGen = 0;
/** Live subscription count (fast bail on the boundary-scan paths — owned
 * by the committed-observers section; dispatch/settlement pre-checks read it). */
let committedSubCount = 0;
// ---- direct listeners (the bindings' consumption surface — attachDriver
// assigns them; the delivery/fixup/correction sites read the module lets,
// one load) ----
/** A value-blind delivery reached a live watcher (fresh or interleaved). */
let onDelivery: ((w: Watcher, batch: Batch, slot: BatchSlot) => void) | undefined;
/** Mount fixup scheduled a corrective re-render into a live batch's lane. */
let onMountCorrective: ((w: Watcher, batch: Batch, slot: BatchSlot) => void) | undefined;
/** An urgent pre-paint correction (mount window / committed-truth drift). */
let onCorrection: ((w: Watcher) => void) | undefined;

// ---- handle resolution + the registry (content allocation on first participation) ----

/**
 * Resolve a public Atom handle to its engine internals, allocating content on
 * first participation (a routed read, a classified write, a watcher mount,
 * a capture read — anything that gives the atom world-visible state). Base
 * seeds from kernel-current, which is the atom's full committed history:
 * a content-less atom's every accepted write was a plain newest apply (the
 * internals-less arm), and those are exactly quiet folds — visible to every
 * world by construction. There is no separate registration step: a handle
 * exists ⟺ the
 * engine can resolve it, and allocation is an internal packing step.
 */
function internalsForAtom(atom: Atom<unknown>): AtomInternals {
	const hit = atom._internals;
	if (hit !== undefined) return hit;
	const id = atom._id;
	const current = untracked(() => E.readAtom(id)); // non-linking newest read
	const node = new AtomInternals(
		id,
		getKernelNodeIndex(id),
		atom.label ?? `atom#${id}`,
		current,
		(atom._isEqual as Equals | undefined) ?? Object.is,
		atom._isEqual === undefined,
		// Weak handle slot (reclamation): content must not pin the public
		// handle — the handle pins the node (atom._internals below). One WeakRef
		// per content allocation (cold, once per participating node).
		new WeakRef(atom as Atom<Value>),
	);
	atom._internals = node;
	indexInternals(node);
	return node;
}

/** The next point on the one global sequence line. */
function nextSeq(): Seq {
	return ++seq;
}

/** Indexes a node into the dense side columns (keyed by its nodeIndex).
 * Gap-fill keeps every column packed: kernel nodes without engine content
 * (plain effects/scopes/handles) consume indexes between content
 * allocations, and
 * a write past a plain array's length would drop it to a holey kind. */
function indexInternals(node: AnyInternals): void {
	const ix = node.ix;
	while (nodeIndexToInternals.length <= ix) {
		nodeIndexToInternals.push(undefined);
		lastWalk.push(0);
		evalMark.push(0);
		obsRefs.push(0);
		obsDeps.push(undefined);
		nodeToWatchers.push(undefined);
	}
	nodeIndexToInternals[ix] = node;
	lastWalk[ix] = 0;
	evalMark[ix] = 0;
	obsRefs[ix] = 0;
	// Any row already here is a dead tenant's by construction (a fresh
	// content allocation means the slot's previous tenant freed) — the
	// record-free
	// scrub normally cleared it already; this keeps the columns sound even
	// if a free was missed.
	obsDeps[ix] = undefined;
	nodeToWatchers[ix] = undefined;
}

/** Embedding/test constructor: a named engine atom (creates the public
 * handle and its engine content in one step — the model-comparison harness
 * names nodes so streams compare by name). */
export function atom(name: string, initial: Value, equals?: Equals): AtomInternals {
	const handle = new Atom<Value>(initial, equals === undefined ? undefined : { isEqual: equals });
	const node = new AtomInternals(handle._id, getKernelNodeIndex(handle._id), name, initial, equals ?? Object.is, equals === undefined, handle);
	(handle as Atom<unknown>)._internals = node;
	indexInternals(node);
	return node;
}

/**
 * Embedding/test constructor: an engine computed
 * (the node rides a fresh kernel `Computed` record). The kernel getter runs
 * the authored (read, untracked) fn with the kernel readers — dep reads
 * take the plain kernel paths (linking to this record; untracked reads
 * clear the kernel frame, so they leave no link and never notify) — under
 * the engine's evaluation guards (writes throw; observed runs capture
 * their strong deps; trace hooks fire). World evaluations run the same fn
 * with the arena readers through `arenaUpdateComputed`.
 */
export function computed(name: string, fn: ComputedFn, equals?: Equals): ComputedInternals {
	// id/ix land after the kernel record exists (the getter closure needs
	// the internals object first); nothing reads them in between. The handle
	// slot is strong: an embedding/test-created node is the public object and
	// owns its handle for its own lifetime.
	const node = new ComputedInternals(0, 0, name, fn, undefined as never, false, equals);
	const handle = new Computed<unknown>(makeKernelGetter(node) as (ctx: ComputedCtx<unknown>) => Value, equals === undefined ? { label: name } : { label: name, isEqual: equals });
	node._h = handle;
	node.id = handle._id;
	node.ix = getKernelNodeIndex(node.id);
	handle._internals = node;
	E.markMachineryOwned(node.id); // its links add no lifecycle union refs — the obs index is its arm
	indexInternals(node);
	return node;
}

/**
 * Resolve a public `Computed` handle to its engine internals, allocating
 * content on first participation: the handle's kernel record keeps serving
 * the newest world — allocation only wraps its kernel
 * getter with the engine epilogue (observation re-pointing per re-run) and
 * builds the ctx-shaped world fn: reads inside the raw fn are raw `.state`
 * reads, which the routed read seams serve from the evaluating arena;
 * `ctx.previous` serves the node's committed previous cell; `ctx.use` is
 * the id-keyed two-form dispatch (same key ⇒ same thenable for the node's
 * lifetime, across worlds); a background evaluation folds a pending
 * suspension to its stable sentinel VALUE (hook-initiated ones rethrow —
 * `suspendDepth`).
 */
export function internalsForComputed(c: Computed<unknown>): ComputedInternals {
	const hit = c._internals;
	if (hit !== undefined) return hit;
	const name = c.label ?? `computed#${c._id}`;
	// Weak handle slot (reclamation): see {@link internalsForAtom} — content never
	// pins the public handle. The world fn below closes over the raw authored
	// fn (c._fn) and this node, never the handle itself.
	const node = new ComputedInternals(c._id, getKernelNodeIndex(c._id), name, undefined as never, new WeakRef(c), true, c._isEqual);
	// The (read, untracked)-shaped world evaluation fn of a ctx-shaped
	// public computed (the readers are unused — the raw fn reads through
	// the `.state` seams, which the open arena frame routes and links).
	{
		const rawFn = c._fn as (ctx: ComputedCtx<unknown>) => Value;
		const ctx: ComputedCtx<unknown> = {
			get previous(): Value {
				return node.prevCommitted;
			},
			use: <V>(sourceOrKey: unknown, factory?: () => PromiseLike<V>): V =>
				__ctxUse(node.ix, sourceOrKey, factory as (() => PromiseLike<unknown>) | undefined) as V,
		} as ComputedCtx<unknown>;
		node.fn = () => {
			try {
				return rawFn(ctx);
			} catch (err) {
				// Background world evaluation: a pending suspension folds to its
				// stable SuspendedRead sentinel VALUE (so "still pending" caches
				// and compares like any value); hook-initiated evaluations
				// rethrow so React can suspend the component.
				if (err instanceof SuspendedRead && suspendDepth === 0) return err;
				throw err;
			}
		};
	}
	// Wrap the kernel getter with the engine epilogue: run the original
	// (equality wrappers and all), then re-point the observed closure at the
	// kernel links this run just re-tracked (raw `.state` reads inside a
	// kernel frame never reach a routed reader, so the fresh link list is
	// the capture — full, reuse-proof, tracked-only).
	{
		const fnIx = c._id >> ArenaShape.ID_TO_FN_SHIFT;
		const inner = fns[fnIx] as (ctx: unknown) => unknown;
		fns[fnIx] = (ctxArg: unknown): unknown => {
			evalDepth++; // writes during a newest evaluation throw, as in every world
			const tr = trace;
			if (tr !== undefined) tr.evalStart(node, NEWEST);
			try {
				return inner(ctxArg);
			} finally {
				evalDepth--;
				if (tr !== undefined) tr.evalEnd();
				if (obsRefs[node.ix]! > 0) syncObservationAfterKernelRun(node, getKernelStrongDeps(node));
			}
		};
	}
	E.markMachineryOwned(c._id); // retro-releases any lifecycle refs its links held (the obs index is its arm now)
	c._internals = node;
	indexInternals(node);
	return node;
}

/**
 * Dispose a computed (the useComputed deps-change reclamation
 * path: the superseded node's kernel record frees and its id becomes
 * reusable). The caller owns the discipline that the node is superseded
 * (its watchers re-keyed to the replacement; live watchers here throw).
 * Order matters for id tenancy: the engine-side teardown runs first —
 * every live arena's shadow purges eagerly (walks traverse links without
 * per-hop GEN checks, so links through the dead shadow must go now), the
 * dense registry row clears (a reused record id resolves
 * fresh, never to the dead tenant) — then the kernel record disposes:
 * its GEN bumps at the boundary sweep, which also fires the record-free
 * scrub (__onRecordFree) clearing every remaining nodeIndex-keyed row
 * before the slot's index can be inherited by a new tenant.
 */
export function disposeComputed(handle: Computed<unknown>): void {
	// Row resolution + the handle cross-check: `handle._internals === node` is
	// the identity/liveness test here (a re-tenanted id resolves to the
	// slot's new tenant, which can never be this handle's node).
	const node = getResidentInternals(handle._id);
	if (node !== undefined && node.kind === 'computed' && handle._internals === node) {
		const ix = node.ix;
		const ws = nodeToWatchers[ix];
		if (ws !== undefined && ws.some((w) => w.live)) {
			throw new ScheduleError(`disposeComputed(${node.name}): live watchers still subscribe — re-key them to the replacement first`);
		}
		if (obsRefs[ix]! > 0) exitObservation(node); // release any retained closure (defensive)
		purgeNodeFromArenas(ix);
		nodeIndexToInternals[ix] = undefined;
		handle._internals = undefined;
	}
	// Kernel: deps unlink, subs detach, deferred free (GEN bump +
	// record-free scrub at the sweep).
	maybeBoundary();
	E.disposeComputed(handle._id);
	maybeBoundary(); // sweep now when possible, so the id-tenancy GEN moves at this boundary
}
/**
 * The record-free scrub (registered kernel-side via __setRecordFreeHook): a
 * node record freed at the kernel's boundary sweep surrenders its slot —
 * and the slot's NODE_INDEX — to a future tenant, so every nodeIndex-keyed
 * row must clear immediately. For engine-disposed computeds this re-runs teardown
 * idempotently; its load-bearing case is everything disposeComputed does
 * not cover — the watcher-index row a dormant mount left behind,
 * observation refs held transitively at free, walk/eval stamps, and node
 * records freed without engine-side teardown. Bound-checked: an index past
 * a column's length has no row, and writing there would drop the column to
 * a holey kind. @internal
 */
function __onRecordFree(recordId: NodeId, ix: NodeIndex): void {
	if (ix < nodeIndexToInternals.length) {
		// The row is the dying tenant's node (the kernel hands us the
		// (id, ix) pair at the free boundary itself — no staleness window):
		// release its outgoing observation retains before the rows clear
		// (un-torn-down nodes must not leak closure membership), and clear a
		// still-live handle's backlink for both kinds.
		const resident = nodeIndexToInternals[ix];
		if (resident !== undefined) {
			if (obsRefs[ix]! > 0) exitObservation(resident);
			clearHandleBacklink(resident);
		}
		nodeIndexToInternals[ix] = undefined;
		lastWalk[ix] = 0;
		evalMark[ix] = 0;
		obsRefs[ix] = 0;
		obsDeps[ix] = undefined;
		nodeToWatchers[ix] = undefined;
	}
	__clearUseCacheForIndex(ix); // the id-keyed ctx.use request cache (the engine's evaluation-policy section)
	purgeNodeFromArenas(ix);
}

/** A freed record's handle backlink (`_internals`) must clear when the handle is
 * still alive (deterministic disposal, reset orphans): a live handle whose
 * cached node names a re-tenanted record would write through a stale id.
 * Reclamation-freed records have dead handles — the deref is undefined and
 * there is nothing to clear. */
function clearHandleBacklink(node: AnyInternals): void {
	const h = node._h;
	const live = h instanceof WeakRef ? h.deref() : h;
	if (live !== undefined) live._internals = undefined;
}

/**
 * Engine-side reclaim guards (installed kernel-side per composition — the
 * guard-table rows the kernel cannot see itself): watcher-
 * index membership (covers live, mounted-in-an-open-render, and reveal-
 * deferred watchers uniformly), observation retains (obsRefs > 0), episode
 * membership (the atom's write log holds entries — per-record membership in
 * the episode's `holds` set, whose drop at the episode close is the retry
 * trigger), membership in any open render's arena, and membership
 * in any arena's suspended list (committed arenas' plain membership is not a
 * guard: the record-free scrub purges their shadows). Cold: runs once per
 * finalizer fire / retry.
 */
function reclaimGuards(id: NodeId, ix: NodeIndex): boolean {
	if (ix < nodeToWatchers.length) {
		const ws = nodeToWatchers[ix];
		if (ws !== undefined && ws.length !== 0) return true;
		if (obsRefs[ix]! > 0) return true;
	}
	// The guard runs on the live tenancy (reclaimNode verified the GEN stamp
	// before consulting guards), so the dense row is this record's node.
	const node = ix < nodeIndexToInternals.length ? nodeIndexToInternals[ix] : undefined;
	if (node !== undefined && node.kind === 'atom' && episodeHolds.has(node)) return true;
	for (const p of rootToOpenRender.values()) {
		const a = p.arena;
		if (a !== undefined && arenaHasShadow(a, ix)) return true;
	}
	let suspended = false;
	eachArena((a) => {
		if (!suspended && arenaHoldsSuspended(a, ix)) suspended = true;
	});
	return suspended;
}

/** The kernel getter of an engine-created computed (see `computed`). The
 * returned closure reads the current core at call time (reset-safe). */
function makeKernelGetter(node: ComputedInternals): () => Value {
	return () => {
		const savedCapture = obsCapture;
		obsCapture = obsRefs[node.ix]! > 0 ? [] : undefined;
		evalDepth++; // writes during a newest evaluation throw, as in every world
		const tr = trace;
		if (tr !== undefined) tr.evalStart(node, NEWEST);
		try {
			return node.fn(kernelTrackedReader, kernelUntrackedReader);
		} finally {
			evalDepth--;
			const captured = obsCapture;
			obsCapture = savedCapture;
			if (tr !== undefined) tr.evalEnd();
			if (captured !== undefined) syncObservationAfterKernelRun(node, captured);
		}
	};
}

/** The kernel-way dep read both kernel-frame readers share: atoms off the
 * kernel arena, computeds via the plain kernel computed read (E.readAtom/
 * E.computedRead link the dep to any open kernel frame), kernel
 * CycleErrors translated to the engine's. */
function readKernelValue(dep: AnyInternals): Value {
	if (dep.kind === 'atom') return E.readAtom(dep.id);
	try {
		return E.computedRead(dep.id);
	} catch (err) {
		if (err instanceof CycleError) throw createCycleError(dep.name);
		throw err;
	}
}

/** Kernel-frame untracked reader: kernel `untracked()` clears the frame,
 * so the dep's own serving still runs (recompute-if-stale) but no link —
 * and therefore no notification, and no invalidation of this computed —
 * is ever recorded (the untracked-sampling rule's value face). */
const kernelUntrackedReader: Reader = (dep) => untracked(() => readKernelValue(dep));

/** Observation re-point after a kernel re-run, inside the still-open
 * kernel frame: discovery evaluations (enterObservation forcing dep reads) must
 * not link into that frame — kernel `untracked()` clears it around the
 * sync. The arena-side counterpart, arenaSyncObservationAfterRefold, clears
 * `serveOverride` for the same reason. */
function syncObservationAfterKernelRun(node: AnyInternals, captured: AnyInternals[]): void {
	untracked(() => syncObservedDeps(node, captured));
}

/** The engine internals among a computed's current kernel deps (tracked-only by
 * construction: untracked reads leave no kernel link). Walked off the raw
 * kernel arena with the kernel's own exported layout enums. */
function getKernelStrongDeps(node: ComputedInternals): AnyInternals[] {
	const memory = E.buffer();
	const out: AnyInternals[] = [];
	let l = memory[node.id + NodeField.DEPS]!;
	while (l !== 0) {
		// Dep ids come off live kernel links (this walk runs at the epilogue
		// of the computed's own kernel re-run), so the dense row by the dep's
		// live NODE_INDEX is its node — or undefined for a dep with no engine
		// content, which contributes nothing.
		const depIx = memory[memory[l + LinkField.DEP]! + NodeField.NODE_INDEX]!;
		const dep = depIx < nodeIndexToInternals.length ? nodeIndexToInternals[depIx] : undefined;
		if (dep !== undefined) out.push(dep);
		l = memory[l + LinkField.NEXT_DEP]!;
	}
	return out;
}

/** Root record lookup-or-create. */
export function root(id: RootId): RootState {
	let r = roots.get(id);
	if (r === undefined) {
		r = { id, committedBatches: new Set(), commitGen: 0, committedBits: 0, committedDirtySlots: 0 };
		roots.set(id, r);
	}
	return r;
}

// ---- the observation index -----------------------------------------------------------
// The engine's transitive observation retains. A node is OBSERVED while a
// live watcher consumes it — directly, or transitively through the strong
// (tracked) dep edges of observed computeds. Observed ATOMS hold exactly
// one retain on the kernel's observed-lifecycle union (AtomOptions.effect);
// the lifecycle section's shiftLifecycleCount is a Map-miss no-op for atoms
// without the option, and these shifts fire only at closure-membership
// EDGES (never per evaluation), so routing every closure atom through it
// costs nothing measurable and needs no second has-lifecycle registry here.
// obsDeps snapshots follow the current edge set — each fn re-run of an
// observed computed (newest kernel runs and arena world refolds carry the
// capture) re-points its retains (dep flips move them; the lifecycle
// section's microtask flush coalesces same-tick flaps) — and the
// observation index deliberately survives quiescence: the closure is a
// property of live watchers, not of the episode.
//
// The two dense per-nodeIndex columns are module state (fresh per
// composition): the hot readers probe `obsRefs[ix] > 0` per observed run,
// and indexInternals's gap-fill and the record-free scrub maintain rows in
// the same loop as the other dense columns — while every closure-membership
// TRANSITION routes through the functions here. The kernel retain seams
// (`__lifecycleRetain`/`__lifecycleRelease` in the observed-lifecycle
// section, the forced discovery read) are consumed here, beside their one
// consumer.

/** Observed-consumer refcount per nodeIndex: +1 per live watcher on the
 * node, +1 per observed computed currently holding it in obsDeps. */
let obsRefs: number[];
/** Per OBSERVED computed (by nodeIndex): the retained direct strong-dep
 * set as of its last fn run (undefined while unobserved — unwatched nodes
 * store nothing). Sets hold node OBJECTS — a retained node's record can
 * free and re-tenant while a stale reference lingers, and
 * shiftObservedCount's identity guard is what keeps the eventual release
 * from touching the new tenant. */
let obsDeps: (Set<AnyInternals> | undefined)[];

/** Shift a node's observed-consumer refcount; enter/exit fire on the
 * 0↔1 edges only, so shared consumers (two watchers on one derived node,
 * two observed dependents of one dep) hold one closure membership.
 * IDENTITY-GUARDED: shifts take the node OBJECT and no-op when the dense
 * row no longer holds it — a stale reference (an obsDeps entry naming a
 * freed node whose record — and nodeIndex — a new tenant inherited) must
 * never move the new tenant's count. Skips pair up: once stale, forever
 * stale (rows only move at record free, and re-registration installs a
 * different object). */
function shiftObservedCount(node: AnyInternals, delta: 1 | -1): void {
	const ix = node.ix;
	if (nodeIndexToInternals[ix] !== node) return;
	const refs = obsRefs[ix]! + delta;
	obsRefs[ix] = refs;
	if (refs === 1 && delta === 1) enterObservation(node);
	else if (refs === 0 && delta === -1) {
		exitObservation(node);
		// Reclamation retry trigger — the obsRefs guard row's clearing
		// site is the release-to-zero edge itself, wherever it fires
		// (dependency recapture, subscription teardown, watcher release).
		if (reclaimSkippedN !== 0) noteReclaimRetry(node.id);
	}
}

/**
 * A node joined the live-watcher closure. Atoms retain their kernel
 * observed lifecycle (the watcher half of the observation union — the
 * kernel liveness bit is the other). Computeds must discover their
 * CURRENT strong dep set: that IS the kernel's dep-link list
 * (tracked-only by construction, per-last-evaluation) — force one
 * kernel read so the record has evaluated at least once, then retain
 * the links it holds. The read runs under kernel `untracked()`: entry
 * can fire inside an open kernel evaluation frame (a getter epilogue's
 * dep sync), and the discovery is not a READ by that frame — a link
 * would corrupt its dep list. A getter that throws keeps its
 * throw-on-demand behavior; the deps it read before throwing are
 * retained (the kernel keeps the partial link prefix).
 */
function enterObservation(node: AnyInternals): void {
	if (node.kind === 'atom') {
		__lifecycleRetain(node.id);
		return;
	}
	try {
		untracked(() => E.computedRead(node.id));
	} catch {
		// partial dep prefix retained below
	}
	syncObservedDeps(node, getKernelStrongDeps(node));
}

/** The last observed consumer left: release the whole retained closure.
 * obsDeps clears before the child shifts so a degenerate cyclic dep
 * record (possible only via throwing getters) cannot re-release. (The
 * node's kernel record keeps its links and cache: MACHINERY_OWNED
 * records never feed the observed-lifecycle union, and stripping them
 * would force an untracked re-sample at the next read — an eager refresh
 * the untracked-sampling rule forbids: untracked reads are point-in-time
 * samples taken only at tracked re-derivations.) */
function exitObservation(node: AnyInternals): void {
	if (node.kind === 'atom') {
		__lifecycleRelease(node.id);
		return;
	}
	const held = obsDeps[node.ix];
	if (held === undefined) return;
	obsDeps[node.ix] = undefined;
	for (const dep of held) shiftObservedCount(dep, -1);
}

/**
 * An observed computed's fn just ran (fully, or up to a throw): re-point
 * its retains at the strong deps THIS evaluation recorded. Retain-new
 * before release-old; deps present in both snapshots never shift, and
 * an A→B→A flip within one tick nets out in the kernel's microtask
 * flush. Skipped if observation left mid-evaluation (the exit already
 * released the old snapshot; installing a new one would leak).
 */
function syncObservedDeps(node: AnyInternals, list: AnyInternals[]): void {
	if (obsRefs[node.ix]! === 0) return;
	const prev = obsDeps[node.ix];
	const next = new Set(list);
	obsDeps[node.ix] = next;
	for (const dep of next) {
		if (prev === undefined || !prev.delete(dep)) shiftObservedCount(dep, 1);
	}
	if (prev !== undefined) {
		for (const dep of prev) shiftObservedCount(dep, -1);
	}
}

/**
 * A committed subscription's run just installed a new dep snapshot:
 * re-point its observation retains (effect dep snapshots count
 * toward the observation union exactly like watcher closures: one retain
 * per snapshot node through the observation index's shiftObservedCount; an
 * atom retains its
 * kernel lifecycle, an observed computed retains its current strong deps
 * transitively). Retain-new before release-old; same-tick flaps coalesce
 * in the kernel's microtask flush. (The snapshot's routing coverage
 * needs no counts of its own: the capture's committed evaluations
 * populate the root's arena, whose marks the re-checks validate
 * through.)
 */
function syncSubscriptionObservation(e: Subscription): void {
	const prev = e.obsDeps;
	const next = new Set<AnyInternals>();
	for (let i = 0; i < e.deps.length; i++) next.add(e.deps[i]!.node);
	e.obsDeps = next;
	for (const dep of next) {
		if (prev === undefined || !prev.delete(dep)) shiftObservedCount(dep, 1);
	}
	if (prev !== undefined) {
		for (const dep of prev) shiftObservedCount(dep, -1);
	}
}

// ---- the write log + the episode lifecycle --------------------------------------------
// The per-atom WRITE LOG and the EPISODE LIFECYCLE — the deliberately
// simple storage: each recorded write is one plain object in one per-atom
// array that only ever pushes, and every removal is wholesale (the episode
// close drops the array; the bounded-memory valve slices one prefix). No
// chunks, no pooling, no packed columns, no index math — one allocation per
// logged write, and the garbage collector reclaims dropped history.
//
// An EPISODE runs from the first pending durable work (a batch opens, an
// action parks, a render starts — never inferred from writes or call
// depth) to full quiescence (every batch retired, every world closed).
// Episode-lifetime state — write records, batch bookkeeping — is dropped
// WHOLESALE at that boundary, never maintained per entry:
//
//  - Each touched atom's write log carries the atom's episode-start `base`
//    (immutable while the episode runs, except by the log's own valve folds
//    below) plus its entries; every world folds from that base.
//  - DURABLE HANDOFF at the close: with every batch retired and every render
//    closed, each world's fold over the whole log equals the kernel's newest
//    value (the eager-apply invariant, pinned by the lockstep suites), so the close
//    adopts kernel newest as the new base BY IDENTITY — zero op replays,
//    zero equality re-invocations — and the log drops whole. Retired batch
//    records drop in the same sweep (write records reference batches by id,
//    so the records outlive the entries by construction).
//  - BOUNDED MEMORY under held-open episodes (a parked action can hold an
//    episode open indefinitely while writes keep landing, so the array must
//    not grow unchecked): when a log's fully-retired-and-unpinned PREFIX
//    reaches FOLD_VALVE_THRESHOLD entries, the valve folds that prefix into
//    base and removes it with one splice. The valve is kept — not dropped —
//    because nothing else bounds a held-open episode's log; the threshold
//    keeps the fold rare, and each atom's foldable residue stays below one
//    threshold's worth of entries.

/**
 * A log entry's materialized face — the test/trace surface (`materialize()`,
 * the trace `logEntry` hook, the `onLogEntryDrop` observer). The stored
 * record keeps the scalar (kind, payload) pair the write path carries; the
 * object-shaped `op` (a write operation: set/update; a ReducerAtom dispatch
 * records as an update whose closure captures the reducer and the action)
 * is built only when one of those surfaces asks.
 */
export type WriteLogEntry = {
	op: { kind: 'set'; value: Value } | { kind: 'update'; fn: (prev: Value) => Value };
	batch: BatchId;
	slot: BatchSlot;
	seq: Seq;
	retiredSeq: Seq | undefined;
};

/**
 * One stored write record — a plain object per logged write. `kind`/`payload`
 * are the scalar op pair (a SET's payload is the value; an UPDATE's is the
 * updater); `retiredSeq` starts undefined and is stamped by the batch's
 * retirement. The record denormalizes its slot at creation: slots are
 * recycled identities, so visibility checks must read the slot the write
 * happened under, not the batch's current slot (which may already be
 * released); the batch id is carried for retirement stamping, invariants,
 * and event logs.
 */
export type WriteRecord = {
	kind: WriteKind;
	payload: unknown;
	batch: BatchId;
	slot: BatchSlot;
	seq: Seq;
	retiredSeq: Seq | undefined;
};

/**
 * The bounded-memory valve's trigger: how many foldable prefix entries a
 * log accumulates before the valve folds that prefix into base — large
 * enough that episodes which quiesce normally never fold, small enough
 * that a held-open episode's foldable residue stays modest per atom. The
 * write path files an atom with the valve's
 * candidate set when its log reaches exactly this length — see the
 * candidate-set invariant on `EpisodeLifecycle.foldCandidates`.
 */
export const FOLD_VALVE_THRESHOLD = 1024;

/** Build the materialized face of one stored record (see WriteLogEntry).
 * (`WriteKind` is concurrent.ts's const enum, imported type-only: this one
 * kind branch compares the bare 0/1 codes the two declarations share by
 * construction.) */
function materializeRecord(e: WriteRecord): WriteLogEntry {
	const op: WriteLogEntry['op'] =
		e.kind === 0 /* WriteKind.SET */
			? { kind: 'set', value: e.payload }
			: { kind: 'update', fn: e.payload as (prev: Value) => Value };
	return { op, batch: e.batch, slot: e.slot, seq: e.seq, retiredSeq: e.retiredSeq };
}

/**
 * The per-atom write log: one plain array of stored records, oldest first,
 * always in sequence order (the log only ever appends, and the valve
 * removes only whole prefixes). Empty for the quiet population.
 */
export class WriteLog {
	/** Live entries, oldest first (sequence order). */
	entries: WriteRecord[] = [];
	/** Live entries not yet retirement-stamped (the write path's
	 * retired-history drop arm reads it; Batch.ts decrements at stamping). */
	unretired = 0;
	/** The newest retirement stamp over LIVE entries (stamps are monotone,
	 * so plain assignment at each stamping maintains it; recomputed when a
	 * valve fold removes a prefix that may have carried the max). */
	maxRetiredSeq: Seq = 0;

	/** Live entry count (the write path's membership branches and the
	 * reclaim/quiet consumers read it). */
	get length(): number {
		return this.entries.length;
	}

	push(kind: WriteKind, slot: BatchSlot, seq: Seq, batch: BatchId, payload: unknown): void {
		probes.logEntries++; // engine-activity counter (tests/one-core.spec.ts's zero-cost check)
		this.entries.push({ kind, payload, batch, slot, seq, retiredSeq: undefined });
		this.unretired++;
	}

	/** The just-appended entry, materialized (the trace `logEntry` hook's one
	 * consumer — tracer-attached only). */
	tailEntry(): WriteLogEntry {
		return materializeRecord(this.entries[this.entries.length - 1]!);
	}

	materialize(): WriteLogEntry[] {
		return this.entries.map(materializeRecord);
	}

	/** Drop every entry (the episode close's durable handoff — base has just
	 * adopted the folded result, so the history is redundant). Object identity
	 * is preserved: holders of the log keep a valid, empty log. */
	reset(): void {
		this.entries = [];
		this.unretired = 0;
		this.maxRetiredSeq = 0;
	}
}

/** Atoms whose write log currently holds entries — the episode's
 * touched-atom membership (the write path adds an atom at its first log
 * entry; the quiet derivation reads the size). Doubles as a reclamation
 * guard row: membership blocks record reclaim, and the episode drop is the
 * row's retry trigger (reclaimRetryAllSkipped at the close; a mid-episode
 * fold that empties one log files the per-atom retry). */
let episodeHolds: Set<AtomInternals>;
/** The fold valve's candidates. Invariant: every atom whose log holds at
 * least FOLD_VALVE_THRESHOLD entries is a member — the write path files
 * an atom when its log reaches exactly the threshold (length grows by
 * one per push, so every crossing passes through equality), the valve
 * removes one only when its log is back under the threshold, and the
 * episode close clears the set with the logs. Empty in every episode
 * whose logs stay under the threshold, which keeps the valve one size
 * check at each boundary. */
let foldCandidates: Set<AtomInternals>;

/**
 * The bounded-memory fold valve, run at retirement and render close (the
 * two transitions that can make a prefix foldable: stamps land, pins
 * lapse). A size check unless a candidate exists; see foldRetiredPrefix
 * for the per-atom rule.
 */
function runFoldValve(): void {
	if (foldCandidates.size === 0) return;
	const minPin = getMinLivePin();
	for (const atom of foldCandidates) {
		foldRetiredPrefix(atom, minPin);
	}
}

/**
 * Fold one atom's foldable prefix into base once it reaches the
 * threshold. The foldable prefix is the run of entries that are retired
 * (the prefix clause — an unretired entry blocks everything after it,
 * because folding out of order would change replay results) with stamps
 * at or below every live render pin (the pin clause — a render pinned
 * earlier still folds from base, so base must not move past it). The
 * fold replays the prefix over base stepwise, exactly as a world fold
 * would — replay fidelity, not an acceptance decision (the write path's
 * equality gates already ran at each write) — then removes it with one
 * splice. A candidate blocked below the threshold re-walks its foldable
 * prefix at each boundary until it folds; the walk is O(1) when the head
 * entry itself is blocked.
 */
function foldRetiredPrefix(atom: AtomInternals, minPin: Seq): void {
	const log = atom.log;
	const entries = log.entries;
	let n = 0;
	while (n < entries.length) {
		const r = entries[n]!.retiredSeq;
		if (r === undefined || r > minPin) break;
		n++;
	}
	if (n >= FOLD_VALVE_THRESHOLD) {
		const onDrop = onLogEntryDrop;
		for (let i = 0; i < n; i++) {
			const e = entries[i]!;
			const next = applyOp(atom, e.kind, e.payload, atom.base);
			// Equality order: isEqual(current, incoming) — stepwise, per
			// replayed entry, as in every fold.
			if (!isAtomValueEqual(atom, atom.base, next)) atom.base = next;
			atom.baseSeq = e.seq;
			if (onDrop !== undefined) onDrop(atom, materializeRecord(e));
		}
		entries.splice(0, n); // the folded prefix drops in one splice
		// The whole-log stamp max may have lived in the folded prefix:
		// recompute over the survivors (the valve itself is the rare path).
		let max: Seq = 0;
		for (let i = 0; i < entries.length; i++) {
			const r = entries[i]!.retiredSeq;
			if (r !== undefined && r > max) max = r;
		}
		log.maxRetiredSeq = max;
	}
	if (entries.length < FOLD_VALVE_THRESHOLD) foldCandidates.delete(atom);
	if (entries.length === 0) {
		episodeHolds.delete(atom);
		// Reclamation retry trigger — the membership row clears at this
		// mid-episode emptying (edge-triggered: filed on the transition, so
		// the warm boundary path otherwise pays only the size-0 bail).
		if (reclaimSkippedN !== 0) noteReclaimRetry(atom.id);
	}
}

/**
 * The episode close — runs at every retirement and render-close boundary;
 * a no-op unless the episode just reached quiescence (every batch
 * retired, parked actions included, and every render closed). Teardown
 * order at the drop: durable handoff first (each held atom's base adopts
 * kernel newest by identity and its log drops whole — worlds fold from
 * base alone afterward, value-identically), then the episode references
 * detach (membership sets clear; retired batch records and the write
 * path's batch cache drop), then the wholesale reclamation retry sweep
 * (the drop is the membership guard row's retry trigger). Committed-root
 * routing structure is NOT episode-lifetime and survives untouched: a
 * mounted watcher's dependency cone is current routing state, exactly as
 * the committed arenas persist across quiescence.
 */
function maybeCloseEpisode(): void {
	if (liveBatchCount !== 0 || rootToOpenRender.size !== 0) return;
	if (episodeHolds.size !== 0) {
		const onDrop = onLogEntryDrop;
		for (const atom of episodeHolds) {
			const log = atom.log;
			const entries = log.entries;
			if (onDrop !== undefined) {
				for (let i = 0; i < entries.length; i++) onDrop(atom, materializeRecord(entries[i]!));
			}
			// The durable handoff: with everything retired and no live pins,
			// fold(base, all entries) ≡ kernel newest (the eager-apply
			// invariant), so newest is adopted by identity — the one
			// equality-bearing decision per write already ran at the write.
			atom.base = untracked(() => E.readAtom(atom.id)); // untracked: a close reached from inside a kernel effect frame records no link
			atom.baseSeq = entries[entries.length - 1]!.seq;
			log.reset();
		}
		episodeHolds.clear();
		foldCandidates.clear();
	}
	// Batch bookkeeping is episode-lifetime: retired records drop in one
	// sweep (live records cannot exist here — the close's guard). The
	// write path's last-batch cache clears with each dropped id.
	for (const [id, t] of idToBatch) {
		if (t.state === 'retired') {
			idToBatch.delete(id);
			invalidateBatchCache(id);
		}
	}
	// The wholesale retry sweep at the boundary: every skipped reclaim
	// re-attempts (size-0 bail inside) — membership rows just cleared.
	reclaimRetryAllSkipped();
}

// ---- batches + retirement --------------------------------------------------------------
// A BATCH groups the writes that belong to one UI update — one event
// handler, one transition, one async action. Each batch is identified by a
// `BatchId` (a monotonically increasing integer, never reused) and
// represented by one `Batch` record in the `idToBatch` registry. React
// schedules each batch on one of its 31 lanes — a lane is React's internal
// unit of scheduling priority; work in one lane renders and commits
// together — so at most 31 batches are ever live at once.
//
// That bound is what makes SLOTS work: a slot is one entry of a 31-entry
// recycling table that a batch occupies from its first write until after
// retirement. Because there are at most 31, "which batches affect X" fits
// one 31-bit integer word (a `BatchSlotSet`), and every visibility check is
// bit arithmetic. INTERNING is claiming a free slot for a batch at its
// first write; the slot's current batch is its TENANT; a released slot is
// recycled to the next claimant. Releasing is normally deferred while any
// open render's mask still names the slot — and when every slot is
// simultaneously retained that way, a loud release-anyway backstop evicts
// the oldest retired tenant rather than deadlock the scheduler (the
// affected paused render self-corrects through drains and mount fixup).
//
// RETIREMENT is the batch's terminal transition: its writes become
// permanent history visible to every world. The retirement fan — stamp log
// entries, run the fold valve, fan marks into committed arenas, drain
// observers, clear per-root membership, release the slot, close the episode
// — is `retireInner` below.
//
// Batch records are EPISODE-LIFETIME (see the episode lifecycle above): a
// retired record persists — write-log entries reference batches by id, so
// the record must outlive them — and drops wholesale at the episode close,
// never by per-record bookkeeping. The `nextBatchId` counter survives even
// the test reset: a host's lane table can legally hold an id across a
// reset, and monotonicity guarantees a stale id can never collide with a
// post-reset batch.

// Leniently branded batch scalars (the kernel's one-symbol IdBrand
// above, ported from dalien-signals src/system.ts:525-535): plain
// numbers assign in cast-free (`1 << slot` builds a BatchSlotSet with no
// ceremony), but the brands are mutually exclusive — in particular a slot
// ordinal handed where a slot-set bit mask belongs (or vice versa) is a
// compile error, the exact swap that would otherwise type-check at every
// `1 << slot.id` site.

export type BatchId = number & IdBrand<'batch'>;
/** The reserved "no batch context" BatchId. Never allocated (batch ids start
 * at 1): `driver.currentBatch() === BATCH_NONE` means the write executes in
 * no host batch context, so it has no batch to join.
 * The React fork names the same sentinel on its side (protocol v2 shares one
 * id space between the engine and React, so the sentinel must too). */
export const BATCH_NONE: BatchId = 0;
/** A slot ordinal (0–30): the batch's position in the recycling table. */
export type BatchSlot = number & IdBrand<'batchSlot'>;
/** A 31-bit slot set: bit i = slot i (mask/included/committed/dedup words). */
export type BatchSlotSet = number & IdBrand<'batchSlotSet'>;

export type Batch = {
	id: BatchId;
	action: boolean;
	parked: boolean;
	/** The React-side classification told to the driver's batch-id allocator
	 * at creation (true = transition-like: renders don't block paint and the
	 * batch commits later). A driver-owned annotation stored on the shared
	 * record so the driver needs no side table — the engine itself never
	 * branches on it (scheduling stays React's). False for engine-created
	 * batches (ambient, tests) that no allocator classified. */
	deferred: boolean;
	state: 'live' | 'retired';
	slot: BatchSlot | undefined;
	retiredSeq: Seq | undefined;
	/** Sequence of this batch's last log entry (0 = none). The mount fixup's
	 * fast-path clock check reads this per committing-render member batch,
	 * because a batch whose first write landed mid-render has no slot in the
	 * render's captured slot sets (see runMountFixup). */
	lastWriteSeq: Seq;
	/** Atoms this batch appended to (may hold benign duplicates; deduped at retirement). */
	atomsTouched: AtomInternals[];
	ambient: boolean;
};

/** One entry of the 31-slot recycling table a written batch occupies (see
 * the slot/intern/tenant definitions in concurrent.ts's header). */
export type BatchSlotMeta = {
	id: BatchSlot;
	tenant: BatchId | undefined;
	/** Claim sequence — a point on the shared timeline created at every
	 * intern (the creation itself is load-bearing for model parity: both sides
	 * spend one sequence per claim). The engine never reads the stored
	 * value; the reference model's (`cosignals-oracle`) `checkInvariants`
	 * tenancy orderings consult it through the test-side model view. */
	claimSeq: Seq;
	/** Sequence of the last write under this slot; zeroed when a new tenant
	 * claims it (the mount fixup's clock conjunct compares it against
	 * snapshot pins). */
	writeClock: Seq;
	releasePending: boolean;
};

const SLOT_COUNT = 31; // at most 31 live batches — one per React lane, and slot sets fit one int bit mask.

/** BatchId source — monotonic for the process's whole life, never reused
 * and never rewound (ids start at 1; BATCH_NONE = 0 is never allocated).
 * With protocol v2 these ids are stored verbatim in React's batch registry,
 * so monotonicity is what keeps a stale fork-side id from ever colliding
 * with a later batch. Module-level deliberately: the counter survives
 * `__resetEngineForTest` (which re-runs the factory below) — a host lane
 * table can legally hold an id across an engine reset, and monotonicity
 * guarantees a stale id can never collide with a post-reset batch. */
let nextBatchId = 1;

/** The next id the allocator would hand out (test harnesses rebase their
 * model↔engine batch-id comparison on it across resets). @internal */
export function __peekNextBatchIdForTest(): BatchId {
	return nextBatchId;
}

/** Batch records by id (retirement, commits, mount fixup, and tests read
 * it in place; the episode close sweeps retired records out). */
let idToBatch: Map<BatchId, Batch>;
/** The 31-entry recycling slot table (see the section header). */
let slots: BatchSlotMeta[];
/** Live (unretired) batches right now — the quiet derivation's first
 * clause and the 31-live guard read it. */
let liveBatchCount = 0;
/** The ambient default batch for bare (context-free) writes — undefined
 * while none is live (retirement clears it). */
let ambientBatch: BatchId | undefined;

/** Create a batch. At most 31 live at once — React schedules each
 * batch on one of its 31 lanes, so more can never be in flight. (The
 * lane/priority itself stays React's: the engine never consults it —
 * with protocol v2 the driver's batch-id allocator opens the batch and
 * hands its id straight to React, one shared number space, no map.)
 *
 * Allocation-only envelope (the driver's allocator calls this from
 * React's batch-creation site, which can sit mid-render, mid-commit, or
 * inside protocol listeners — i.e. at opDepth > 0): bookkeeping only —
 * counter, registry map, quiet recompute, probes/trace records. No
 * operation epilogue, no drains, no kernel mutation, no user code.
 *
 * With devChecks armed, opening a batch with no driver attached
 * throws — the documented host contract is "hosts that open batches
 * must retire them", and a devChecks harness must attach its driver
 * before opening engine batches. */
function openBatch(opts?: { action?: boolean; ambient?: boolean; deferred?: boolean }): Batch {
	if (devChecks && driver === undefined) {
		throw new ScheduleError('openBatch with no driver attached — hosts that open batches must retire them; attach a driver first (devChecks)');
	}
	if (liveBatchCount >= SLOT_COUNT) {
		throw new ScheduleError('at most 31 batches may be live at once (one per React lane)');
	}
	const parked = opts?.action ?? false;
	probes.batches++; // engine-activity counter (tests/one-spec.ts's zero-cost check)
	const batch: Batch = {
		id: nextBatchId++,
		action: opts?.action ?? false,
		parked, // async-action batches park (cannot retire) until their promise settles
		deferred: opts?.deferred ?? false, // driver-owned annotation (see Batch.deferred)
		state: 'live', slot: undefined,
		retiredSeq: undefined, lastWriteSeq: 0, atomsTouched: [],
		ambient: opts?.ambient ?? false,
	};
	idToBatch.set(batch.id, batch);
	liveBatchCount++;
	recomputeQuiet(); // a live batch: the pipeline is armed until the last retirement
	const tr = trace;
	if (tr !== undefined) tr.batchOpen(batch);
	return batch;
}

/** Look up a batch id or throw the schedule error every resolver shares. */
function getBatchById(id: BatchId): Batch {
	const t = idToBatch.get(id);
	if (t === undefined) throw new ScheduleError(`unknown batch ${id}`);
	return t;
}

function liveBatches(): Batch[] {
	return [...idToBatch.values()].filter((t) => t.state === 'live');
}

/**
 * Intern the batch's slot, claiming a free one on its first write.
 * Claim housekeeping: the write clock zeroes; per-(watcher, slot) dedup
 * bits clear (the bit now means a different batch).
 */
function internSlot(batch: Batch): BatchSlotMeta {
	if (batch.slot !== undefined) return slots[batch.slot]!;
	let free = slots.find((s) => s.tenant === undefined);
	if (free === undefined) {
		// Backstop: release the oldest mask-retained retired slot anyway,
		// loudly — starving new batches would deadlock the scheduler, and
		// the affected paused render self-corrects through drains/fixup.
		const candidates = slots.filter((s) => s.releasePending);
		if (candidates.length === 0) {
			throw new ScheduleError('slot table full of live tenants — unreachable under the 31-live-batch guard');
		}
		candidates.sort((a, b) => {
			const ra = getBatchById(a.tenant!).retiredSeq ?? 0;
			const rb = getBatchById(b.tenant!).retiredSeq ?? 0;
			return ra - rb;
		});
		const victim = candidates[0]!;
		const tr = trace;
		if (tr !== undefined) tr.slotBackstopReleased(victim.id, victim.tenant!);
		releaseSlot(victim);
		free = victim;
	}
	free.tenant = batch.id;
	free.claimSeq = nextSeq(); // claim-after-release gets its own point on the timeline
	free.writeClock = 0;
	free.releasePending = false;
	batch.slot = free.id;
	// Claim housekeeping over the shared root/watcher stores, in claim
	// order. A committed-but-slotless batch (late first write — e.g. a
	// member write landing after a root committed the batch) interns here —
	// its root's membership bits gain the slot immediately so the committed world's
	// membership clause sees the coming log entries.
	for (const r of roots.values()) {
		if (r.committedBatches.has(batch.id)) r.committedBits |= 1 << free.id;
	}
	{
		const clear = ~(1 << free.id);
		for (const w of watchers.values()) w.dedupBits &= clear; // dedup clear at re-intern
	}
	{
		const tr = trace;
		if (tr !== undefined) tr.slotClaimed(free.id, batch.id);
	}
	return free;
}

function releaseSlot(slot: BatchSlotMeta): void {
	const tenant = slot.tenant === undefined ? undefined : getBatchById(slot.tenant);
	if (tenant !== undefined) {
		tenant.slot = undefined; // identity release; log entries keep their denormalized slot
		const tr = trace;
		if (tr !== undefined) tr.slotReleased(slot.id, tenant.id);
	}
	slot.tenant = undefined;
	slot.releasePending = false;
	// (The released tenant's record persists: batch records are
	// episode-lifetime and drop wholesale at the episode close.)
}

function rebuildCommittedBits(r: RootState): void {
	let bits = 0;
	for (const tid of r.committedBatches) {
		const batch = idToBatch.get(tid);
		if (batch !== undefined && batch.slot !== undefined) bits |= 1 << batch.slot;
	}
	r.committedBits = bits;
}

function isSlotRetainedByOpenMask(slot: BatchSlot): boolean {
	for (const p of rootToOpenRender.values()) {
		if ((p.maskBits >>> slot) & 1) return true;
	}
	return false;
}

// ---------------------------------------------------------- retirement

/** Retirement fires exactly once per batch; parked async actions retire
 * only at settlement (their pending state must stay pending until then). */
function retire(batchId: BatchId): void {
	const t = getBatchById(batchId);
	if (t.state === 'retired') throw new ScheduleError('retirement fires exactly once per batch');
	if (t.parked) throw new ScheduleError('parked action batches retire only at settlement');
	opDepth++; // public-operation frame (see the engine's write dispatch)
	try {
		retireInner(t);
		// Boundary rule: retirement is a guaranteed flush point for every root
		// (a write-free retirement still flushes pending member-write flips).
		revalidateCommittedSubscriptions(undefined);
		endOperation();
	} finally {
		opDepth--;
	}
	runOperationEpilogue();
}

/** The async action's promise settled; the protocol host then retires the batch. */
function settleAction(batchId: BatchId): void {
	const t = getBatchById(batchId);
	if (!t.action) throw new ScheduleError('settle targets an action batch');
	if (!t.parked || t.state !== 'live') throw new ScheduleError('action already settled');
	opDepth++; // public-operation frame (see the engine's write dispatch)
	try {
		t.parked = false;
		const tr = trace;
		if (tr !== undefined) tr.batchSettle(t);
		retireInner(t);
		revalidateCommittedSubscriptions(undefined); // boundary rule: settlement is a guaranteed flush point
		endOperation();
	} finally {
		opDepth--;
	}
	runOperationEpilogue();
}

/**
 * Retirement — the batch's writes become permanent history visible to
 * every world. The internal order matters: stamp log entries, fold what
 * the stamps made foldable (the fold valve), retirement stamps +
 * committed-advance, durable drains, clear per-root rows (the retired
 * clause now subsumes membership), release the slot (deferred if an open
 * render's render mask still names it), and close the episode when this
 * was the last pending durable work. Retirement is disposition-blind: a
 * batch React abandoned retires through this same path — whether writes
 * persist never depends on who was subscribed (the bindings record the
 * committed/abandoned report diagnostically at its source; see
 * TraceHooks.batchDisposition).
 */
function retireInner(batch: Batch): void {
	if (batch.state === 'live') {
		liveBatchCount--;
	}
	batch.state = 'retired';
	batch.parked = false;
	const retiredSeq = nextSeq(); // one retirement sequence per retirement event
	batch.retiredSeq = retiredSeq;
	// Stamp only the atoms this batch actually touched (the per-batch
	// touch list replaces an all-nodes/all-log entries scan).
	let touchedAny = false;
	const touchedAtoms = batch.atomsTouched;
	for (let i = 0; i < touchedAtoms.length; i++) {
		const n = touchedAtoms[i]!;
		if (n.retirementStamp === retiredSeq) continue; // duplicate touch entry
		const log = n.log;
		const entries = log.entries;
		let stamped = 0;
		for (let j = 0; j < entries.length; j++) {
			const e = entries[j]!;
			if (e.batch === batch.id && e.retiredSeq === undefined) {
				e.retiredSeq = retiredSeq;
				stamped++;
			}
		}
		if (stamped !== 0) {
			log.unretired -= stamped;
			log.maxRetiredSeq = retiredSeq; // stamps are monotone: plain assignment maintains the max
			// Create the retirement stamp per touched atom (visibility of its
			// history changed; fingerprints must reflect that).
			n.retirementStamp = retiredSeq;
			touchedAny = true;
		}
	}
	if (touchedAny) advanceCommitted();
	// The bounded-memory fold valve (see WriteLog.ts foldRetiredPrefix for
	// the two-clause predicate) — a size check unless a candidate exists.
	runFoldValve();
	// Committed-truth flip site: retirement — after stamps +
	// committedAdvance + the fold valve, before the drain loop (the
	// ordering joint every flip site shares: mutate → fan → drain), fan
	// the retiring batch's touched atoms into every committed arena.
	if (touchedAny) fanAtomsToCommittedArenas(batch.atomsTouched);
	{
		const tr = trace;
		if (tr !== undefined) tr.retired(batch.id, retiredSeq);
	}
	// Durable drains, per root, gated on a flipped slot, member-write
	// drift, or restaled leftovers: candidates come from
	// each root arena's dirty list — the site-(a) fanout above marked
	// them, and list entries persist until a drain-then-decay boundary
	// consumes them (never a consumable write-time queue).
	{
		const slotBit = batch.slot !== undefined ? 1 << batch.slot : 0;
		for (const r of roots.values()) {
			const bits = slotBit | r.committedDirtySlots;
			r.committedDirtySlots = 0;
			const re = restaled.get(r.id);
			if (bits !== 0 || (re !== undefined && re.size > 0)) drainCommittedObservers(r.id, 'retirement');
		}
		// Boundary mark decay — unconsumed marks on unwatched
		// nodes drop to cold instead of re-appending forever.
		for (const a of rootToArena.values()) arenaDecay(a);
	}
	// Clear per-root rows (the retired clause subsumes membership now),
	// then release the slot unless an open render mask names it.
	for (const r of roots.values()) {
		if (r.committedBatches.delete(batch.id)) rebuildCommittedBits(r);
	}
	if (batch.slot !== undefined) {
		const slot = slots[batch.slot]!;
		if (isSlotRetainedByOpenMask(slot.id)) {
			slot.releasePending = true; // re-evaluated at every render end
			const tr = trace;
			if (tr !== undefined) tr.slotReleaseDeferred(slot.id, batch.id);
		} else {
			releaseSlot(slot);
		}
	}
	if (ambientBatch === batch.id) ambientBatch = undefined;
	// The last retirement with every render closed ends the episode: the
	// durable handoff runs and the episode's records drop wholesale
	// (WriteLog.ts maybeCloseEpisode) — before quiet re-derives below, so
	// notification/settlement callbacks of this same operation classify
	// their writes against the post-episode state, exactly as the
	// reference model's derivation does.
	maybeCloseEpisode();
	recomputeQuiet(); // the last retirement (episode closed) re-arms quiet
}

// ---- worlds: folds, evaluation, read routing -------------------------------------------
// A WORLD is one self-consistent assignment of values to every atom,
// produced by replaying exactly the log entries that world may see, in
// timeline order (a FOLD). This section owns:
//
//  - the `World` type and `isVisible`, the visibility rule deciding which
//    log entries each world's fold replays;
//  - `foldAtom` / `applyOp` / `isAtomValueEqual` — the fold family (one
//    op-application rule, one equality rule) and the fold-purity bracket
//    (`runInFoldCallback`);
//  - `evaluate` — world evaluation (arena-served render/committed worlds,
//    kernel-served newest, memo-free fold-throughs for mountFix worlds)
//    with per-world cycle detection;
//  - read routing: the resolution order (fold-purity throw → evaluation
//    world on stack → open capture frame → the driver's ambient provider),
//    the routed read bodies (`routedAtomRead` / `routedComputedRead` — the
//    public `.state` getters call them directly when `routingActive` is
//    set), and the one-flag arming (`syncReadRouting` maintains the kernel
//    sections' `routingActive` boolean at every world/capture/provider
//    transition — one flag covers every routing source).
//
// The strongly-connected cycles these functions form with the arena and
// settlement sections — evaluate → arenaServe → foldAtom, settlement →
// arenas → worlds → corrections — resolve by plain function hoisting:
// everything is one module, so every cross-section call is a direct
// same-module call, and the shared scalars (the evaluation-frame state,
// the routing state, the operation depth) are the module lets in the
// concurrent machinery's state block above.

/** A world: one self-consistent assignment of values to all atoms, computed
 * by replaying exactly the log entries that world may see, in timeline order. */
export type World =
	| { kind: 'newest' }
	| { kind: 'render'; render: RenderPass }
	| { kind: 'committed'; root: RootId }
	| { kind: 'mountFix'; maskBits: BatchSlotSet; pin: Seq; root: RootId };

/** The one newest-world singleton (hot paths never allocate world objects). */
export const NEWEST: World = { kind: 'newest' };

/** Declined-read sentinel: a routed read returns it to mean "no routing
 * context answered — take the plain kernel path". Package-internal (the
 * public `.state` getters compare against it); never observable. */
export const NOT_ROUTED: { readonly notRouted: true } = { notRouted: true };

/** Top-level world-evaluation generation for the cycle-detection marks
 * (`evalMark` rows carry it; fresh per composition). */
let evalGen: EvalGen = 0;

/**
 * The bindings' ambient-world provider: consulted per routed read when no
 * evaluation world is on stack, and answers from the live call context —
 * the render world of the render actually running on the current stack, the
 * committed world of an effect fire — or undefined for "route newest".
 * A callback (not a start-to-end flag) deliberately: a render that has
 * completed but not yet committed is not "in render" (the protocol's
 * render context is null there), so outside-render reads in that window
 * must resolve newest, and interleaved multi-root renders must each see
 * their own render. Installed by attachDriver through `setWorldProvider`;
 * cleared per composition.
 */
let worldProvider: (() => World | undefined) | undefined;

/** Capture frame that answered the last resolveRoutedWorld call (scratch,
 * consumed immediately by the two routed read bodies — a slot instead of a
 * tuple return so routed reads allocate nothing on the provider path). */
let routedCap: CaptureFrame | undefined;

/** Installs/clears the ambient-world provider (bindings seam). */
function setWorldProvider(provider: (() => World | undefined) | undefined): void {
	worldProvider = provider;
	syncReadRouting();
}

/** Central activeWorld setter — keeps the read-routing seams in sync. */
function setWorld(w: World | undefined): void {
	activeWorld = w;
	syncReadRouting();
}

/** Arms/disarms read routing (the kernel sections' `routingActive` boolean —
 * the public `.state` getters' inline check): armed while an evaluation
 * world is on stack, an open capture frame exists, or a driver's ambient
 * provider could answer — so a driver-less quiet engine costs reads
 * exactly one boolean check. */
function syncReadRouting(): void {
	routingActive = activeWorld !== undefined || worldProvider !== undefined || captureFrame !== undefined;
}

/** Assigns the capture frame and re-syncs the arming (the subscription manager's
 * captureRun edges — both the open and the close perform exactly this pair). */
function setCaptureFrame(f: CaptureFrame | undefined): void {
	captureFrame = f;
	syncReadRouting();
}

/**
 * The read-routing resolution order, one copy: fold-purity throw, then
 * the evaluation world
 * on stack (reads inside a computed's evaluation are the computed's
 * dependencies — the capture frame never sees them), then the open
 * capture frame (committed-for-root; the
 * frame lands in `routedCap` for the caller's dep capture), then the
 * driver's ambient provider.
 */
function resolveRoutedWorld(): World | undefined {
	// Fold purity: replayed updaters/reducers (and equals callbacks) must
	// not read signals — world routing would otherwise serve them silently.
	if (inFoldCallback) {
		throw new ScheduleError('signal read inside an updater/reducer fold — updaters and reducers must be pure; read what you need before dispatching');
	}
	routedCap = undefined;
	const world = activeWorld;
	if (world !== undefined) return world;
	const cap = captureFrame;
	if (cap !== undefined) {
		routedCap = cap;
		return { kind: 'committed', root: cap.sub.root };
	}
	const p = worldProvider;
	return p === undefined ? undefined : p();
}

/**
 * The routed public atom read: route a `.state` read to the effective
 * world; a handle with no engine content gets its node allocated here
 * (world participation is content — the read is about to give it arena
 * presence). Returns NOT_ROUTED to take the plain kernel path.
 * @internal (reached only through index.ts's `Atom.state`)
 */
export function routedAtomRead(atom: Atom<unknown>): unknown {
	const world = resolveRoutedWorld();
	if (world === undefined) {
		return NOT_ROUTED;
	}
	const cap = routedCap;
	const node = internalsForAtom(atom);
	const v = routedRead(node, world);
	if (cap !== undefined) cap.deps.push({ node, value: v, stamp: committedDepStamp(cap.sub.root, node) });
	return v;
}

/**
 * The routed public computed read (the computed counterpart of
 * routedAtomRead): route a
 * `Computed.state` read to the effective world, allocating engine
 * content on first sight. Newest resolution declines (NOT_ROUTED): the
 * plain kernel path is newest serving, seam-free. Reads inside an open
 * capture frame resolve committed-for-root and append to the dep
 * snapshot, exactly like routed atom reads.
 * @internal (reached only through index.ts's `Computed.state`)
 */
export function routedComputedRead(c: Computed<unknown>): unknown {
	const world = resolveRoutedWorld();
	if (world === undefined || world.kind === 'newest') {
		return NOT_ROUTED; // the plain kernel path is newest serving
	}
	const cap = routedCap;
	const node = internalsForComputed(c);
	// The pre-dedup observation capture rides tracked reads;
	// raw handle reads inside world evaluations have no reader hook, so
	// the seam is their capture site (mirrors routedRead's atom half).
	if (currentSink !== 0) {
		const oc = obsCapture;
		if (oc !== undefined) oc.push(node);
	}
	const v = evaluate(node, world);
	if (cap !== undefined) cap.deps.push({ node, value: v, stamp: committedDepStamp(cap.sub.root, node) });
	return v;
}

/** Runs an updater/reducer/equals under the fold-purity guard: signal
 * reads and writes inside these callbacks throw, because they are
 * replayed per world and must stay pure. */
function runInFoldCallback<T>(fn: () => T): T {
	const prev = inFoldCallback;
	inFoldCallback = true;
	try {
		return fn();
	} finally {
		inFoldCallback = prev;
	}
}

/**
 * The fold — replay visible entries over base in sequence order with
 * stepwise equality (an equal step keeps the old reference). Runs over
 * the log's entry array (already in sequence order — the log appends in
 * order and folds only whole prefixes).
 */
function foldAtom(atom: AtomInternals, world: World): Value {
	const entries = atom.log.entries;
	let value = atom.base;
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i]!;
		if (!isVisible(e, world)) continue;
		const next = applyOp(atom, e.kind, e.payload, value);
		// Equality order: isEqual(current, incoming) — per replayed entry
		// (the fold re-invokes per entry by design; "once" is scoped to the
		// write path's acceptance decision).
		if (!isAtomValueEqual(atom, value, next)) value = next;
	}
	return value;
}

/**
 * The visibility rule — which log entries each world's fold replays (over
 * the stored records; no WriteLogEntry materialization). The clauses:
 *  - newest: every log entry (the kernel applies writes eagerly, so this
 *    world is also readable straight off the kernel arena);
 *  - render: (1) log entries retired at-or-before the render's pin — permanent
 *    history the render started from — and (2) log entries from included
 *    batches up to the pin, so a paused-and-resumed render never sees a
 *    write that landed after it started;
 *  - committed-for-root: retired log entries (committed truth as of now) plus
 *    log entries from batches this root has committed but that are still
 *    live elsewhere (membership);
 *  - mountFix: the mount-fixup world (see runMountFixup) — the render's own
 *    inclusions at its pin, plus committed truth as of now.
 * (The reference model exports the same rule in WriteLogEntry-object
 * form — `visible` in cosignals-oracle model.ts; tests/model-view.ts
 * imports it rather than keeping a copy. It must mirror these clauses.)
 * Single-caller but the one visibility rule: kept as a named function
 * deliberately (readability exception, documented here).
 */
function isVisible(e: WriteRecord, world: World): boolean {
	switch (world.kind) {
		case 'newest':
			return true;
		case 'render': {
			const w = world.render;
			const r = e.retiredSeq;
			if (r !== undefined && r <= w.pin) return true; // clause 1: retired by my pin
			return ((w.includedBits >>> e.slot) & 1) === 1 && e.seq <= w.pin; // clause 2
		}
		case 'committed': {
			if (e.retiredSeq !== undefined) return true; // committed truth at now
			// Membership consult materializes the root record (reference-model
			// parity: the model's committedSlotsNow() creates it on first consult).
			// Hot arm reads the aliased map directly — `root()` is
			// lookup-or-create, so a hit is what root() would return; only
			// the first consult takes the materializing miss arrow (a fresh
			// record carries committedBits 0 either way, so the answer is
			// value-identical — the arrow is kept for materialization parity).
			return (((roots.get(world.root) ?? root(world.root)).committedBits >>> e.slot) & 1) === 1;
		}
		case 'mountFix': {
			if (((world.maskBits >>> e.slot) & 1) === 1 && e.seq <= world.pin) return true;
			if (e.retiredSeq !== undefined) return true; // committed truth as of now
			return (((roots.get(world.root) ?? root(world.root)).committedBits >>> e.slot) & 1) === 1; // hot get + materializing miss arrow (see the committed arm)
		}
	}
}

/** Apply one op over `prev`, straight off the scalar (kind, payload) pair
 * (a SET's payload is the value; an UPDATE's is the updater). Replayed
 * updaters run under both fold guards: the engine's (routed reads throw)
 * and the kernel's POISON table (raw public reads/writes throw exactly as
 * in the standalone path). ReducerAtom dispatches arrive here too: the
 * closure carries the reducer and the captured action. (`WriteKind` is
 * concurrent.ts's const enum, imported type-only: this one comparison
 * uses the bare 0/1 codes the two declarations share by construction —
 * the WriteLog.ts pattern.) */
function applyOp(atom: AtomInternals, kind: WriteKind, payload: unknown, prev: Value): Value {
	if (kind === 0 /* WriteKind.SET */) return payload;
	return runInFoldCallback(() => {
		// The kernel's fold-purity POISON table guards the replay exactly
		// like the plain-path update() (CosignalEngine.ts's fold-guard pair).
		const saved = foldGuardSwap();
		try {
			return (payload as (p: Value) => Value)(prev);
		} finally {
			foldGuardRestore(saved);
		}
	});
}

/** How this atom compares two values — the one equality rule, one copy for
 * every site that asks (fold replay, the write path's drop check and
 * eager kernel apply, quiet-mode folds, fold-valve folds): Object.is when
 * the atom carries the default, otherwise the atom's custom comparator
 * under the fold-purity guard (equality callbacks replay per world, so
 * signal reads/writes inside them throw — the updater contract). */
function isAtomValueEqual(atom: AtomInternals, a: Value, b: Value): boolean {
	return atom.eqIsDefault ? Object.is(a, b) : runInFoldCallback(() => atom.equals(a, b));
}

/** The value-change gate for compare-and-correct sites,
 * honoring a custom-equality computed's policy comparator — mountFix
 * fold-throughs (and evicted-then-refolded arena slots) create fresh
 * references for comparator-equal values, which are not changes for a
 * custom-equality node (the kernel wrapper and the arena slot both keep
 * old references under the same policy). Exceptional payloads never
 * cross the gate (sentinels compare by identity — pinned in
 * tests/concurrent-battery.spec.ts).
 * Default-equality nodes compare by identity. */
function isValueChanged(node: AnyInternals, prev: Value, next: Value): boolean {
	if (
		node.kind === 'computed' && node.isEqual !== undefined
		&& !(prev instanceof SuspendedRead) && !(next instanceof SuspendedRead)
	) {
		const eq = node.isEqual;
		return !runInFoldCallback(() => eq(prev, next));
	}
	return !Object.is(prev, next);
}

/** The engine's one cross-world cycle error (every construction site
 * builds it here so the surface message can never fork). */
function createCycleError(name: string): ScheduleError {
	return new ScheduleError(`cyclic evaluation of ${name} within one world — a computed may not depend on itself`);
}

/**
 * Raw-handle reads: an engine atom read reached the operation table
 * while a world evaluation frame was open (newest/mountFix — arena
 * fn runs route through `serveOverride` inside readAtomValue and link at `arenaServe`).
 * The open frame's sink gates the observation capture: the pre-dedup
 * capture rides the tracked read path.
 * @internal (called from the concurrent table wrapper)
 */
function routedRead(atom: AtomInternals, world: World): Value {
	if (currentSink !== 0) {
		const oc = obsCapture;
		if (oc !== undefined) oc.push(atom);
	}
	return readAtomValue(atom, world);
}

/** Atom value in a world: kernel for newest, the world's arena for
 * render/committed, a plain fold for mountFix and unmaterialized roots.
 * (The newest read is the direct kernel read `E.readAtom` — world routing
 * can never intercept it.) */
function readAtomValue(atom: AtomInternals, world: World): Value {
	const route = serveOverride; // one override test on the routed-read path
	if (route !== undefined) {
		if (route !== FOLD_TRUTH) return arenaServe(route, atom); // arena-refold routing override
		return foldAtom(atom, world); // fold-truth reads (armed checker)
	}
	if (world.kind === 'newest') {
		// The kernel holds the newest fold by the eager-apply invariant.
		// (`atom.id` is the record id — never through the handle slot,
		// which reclamation keeps weak for resolved nodes.)
		return E.readAtom(atom.id);
	}
	if (world.kind === 'render' || world.kind === 'committed') {
		const a = getArena(world);
		if (a !== undefined) return arenaServe(a, atom);
		// Unmaterialized root (no record): fold plain — a read never
		// creates the root record or its arena.
	}
	return foldAtom(atom, world);
}

/**
 * Evaluation of a node in a world. Render/committed worlds are
 * arena-served: values, invalidation, and routing structure
 * live in the world's arena, and `arenaServe` refolds through the arena's
 * own walks when marks or cold bases demand it — the cold in-arena fn
 * run is what records the strong and weak links the routing coverage
 * argument stands on (the cold-render bench gate prices it).
 * An unmaterialized root has no arena and folds plain. Newest-world
 * atoms read straight off the kernel arena; newest-world computeds are
 * kernel-served (one computed representation — `readKernelComputed` below
 * carries the rule: stale until a tracked dependency changes; untracked
 * reads are samples taken at re-derivations). mountFix worlds are
 * one-shot fold-throughs. Reads inside fold callbacks throw
 * (updaters/reducers must be pure); per-world cycles throw instead of
 * recursing.
 */
function evaluate(node: AnyInternals, world: World): Value {
	probes.worldEvals++; // engine-activity counter (tests/one-spec.ts's zero-cost check)
	if (inFoldCallback) throw new ScheduleError('signal read inside an updater/reducer fold — updaters and reducers must be pure; read what you need before dispatching');
	const route = serveOverride; // no-override fast-out is the one hot test; FOLD_TRUTH falls through (fold-truth computeds re-run checker-side, never here)
	if (route !== undefined && route !== FOLD_TRUTH) return arenaServe(route, node); // arena-refold routing override
	if (world.kind === 'render' || world.kind === 'committed') {
		const a = getArena(world);
		if (a !== undefined) return arenaServe(a, node);
	}
	if (node.kind === 'atom') return readAtomValue(node, world);
	if (world.kind === 'newest') return readKernelComputed(node);
	// Fold-through evaluation (mountFix worlds + unmaterialized-root
	// committed folds): memo-free recursion in the frame's world.
	// Per-world cycle detection via the mark column: marks carry the
	// current top-level evaluation generation.
	const marks = evalMark;
	if (marks[node.ix] === evalGen && evalDepth > 0) {
		throw createCycleError(node.name);
	}
	if (evalDepth === 0) evalGen++;
	marks[node.ix] = evalGen;
	evalDepth++;
	const savedWorld = activeWorld;
	setWorld(world);
	const savedSink = currentSink;
	const savedObsCapture = obsCapture;
	// Observed nodes capture the strong deps of this run (the readers
	// push); everyone else pays this one check.
	obsCapture = obsRefs[node.ix]! > 0 ? [] : undefined;
	currentSink = node.ix;
	const tr = trace; // paired eval hooks; end fires on throw too
	if (tr !== undefined) tr.evalStart(node, world);
	try {
		return node.fn(trackedReader, untrackedReader);
	} finally {
		const obsCaptured = obsCapture;
		obsCapture = savedObsCapture;
		currentSink = savedSink;
		setWorld(savedWorld);
		evalDepth--;
		marks[node.ix] = 0;
		if (tr !== undefined) tr.evalEnd();
		// Observed-closure sync — after every restore, so the discovery
		// evaluations the sync may trigger run on a clean frame stack. On
		// a throw the list holds the deps recorded up to it (see obsEnter
		// for the rule).
		if (obsCaptured !== undefined) syncObservedDeps(node, obsCaptured);
	}
}

/**
 * Newest computed serving — the kernel's `computedRead`. The
 * untracked-sampling rule: the kernel re-derives only when a
 * tracked dependency changed — kernel links exist for tracked reads
 * only — so untracked reads are point-in-time samples taken at those
 * re-derivations, and a write reaching a computed only through
 * untracked reads changes no newest answer. Read-site translations
 * preserve the engine surface: kernel CycleErrors (fresh or cached)
 * become the engine's cycle error; a PENDING suspension of a
 * ctx-shaped (handle-resolved) computed folds to its stable sentinel,
 * served as a value, for
 * background reads and rethrows for hook-initiated ones; settled
 * suspensions self-heal inside the kernel's boxedRead before this frame
 * ever sees them (read-after-await determinism).
 */
function readKernelComputed(node: ComputedInternals): Value {
	try {
		return E.computedRead(node.id);
	} catch (err) {
		if (err instanceof CycleError) {
			throw createCycleError(node.name);
		}
		if (err instanceof SuspendedRead && suspendDepth === 0 && node.ctxShaped) {
			return err; // adopted ctx fn, background read: the sentinel serves as a value
		}
		throw err;
	}
}

/** The persistent tracked reader (mountFix/plain-fold frames — arena fn
 * runs use arenaTrackedReader; kernel newest runs use kernelTrackedReader):
 * the pre-dedup observation capture rides the tracked read path,
 * then the dep evaluates in the frame's world. */
const trackedReader: Reader = (dep) => {
	const oc = obsCapture;
	if (oc !== undefined) oc.push(dep);
	return evaluate(dep, activeWorld!);
};

/**
 * The persistent untracked reader: capture-free, not input-free — the
 * dep still folds in the frame's world (fold-throughs re-derive
 * everything, so untracked deps stay fresh in these one-shot worlds),
 * but it never joins the observation capture (the observation union is
 * strong-only) and — in arena worlds, where arenaUntrackedReader is the
 * analog — records only a weak link, so no notification ever fires
 * through it.
 */
const untrackedReader: Reader = (dep) => {
	const sink = currentSink;
	currentSink = 0;
	try {
		return evaluate(dep, activeWorld!);
	} finally {
		currentSink = sink;
	}
};

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
 * are same-file const enums declared in the record-layout region above —
 * every hot arena walk lives in this module so the members
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
// arenas' layout — are declared in the record-layout region above,
// same-file with these walks so the members inline as literals under
// every toolchain.)

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
	 * measured +56% on cold renders and +18-31% on wide fanout masks, and
	 * stay banned). Allocated at the
	 * generous initial reservation — ArenaGeom.INIT_BUFFER_BYTES by
	 * default, EngineResetOptions.arenaInitInts when set — and grown BY
	 * COPY (doubling) whenever an allocation outruns it: exhaustion is
	 * never fatal, growth replaces it. Growth mid-operation is safe through
	 * this shell indirection — growWorldArenaBuffers reassigns the field,
	 * record ids never change (observer dep chains and every other
	 * id-holding structure are untouched), and the sites that cache the
	 * view across an allocating call re-load it after (the discipline is
	 * enumerated in growWorldArenaBuffers' doc, kept current there).
	 * Growth stays RARE by the reservation's generosity: a fresh zeroed
	 * allocation that size is nearly free — the pages are zero-fill
	 * demand-paged, so it costs address space while resident memory tracks
	 * only the records actually touched (the pattern proven in
	 * dalien-signals, which reserves 64MB record stores the same way).
	 */
	memory: Int32Array;
	/** The per-world updated-at clock column: one float64 slot per record,
	 * sized with the {@link memory} record store and grown by copy beside
	 * it (growWorldArenaBuffers grows both together). */
	clocks: Float64Array;
	/** Whether observer consults settle the clock column: committed arenas
	 * only — render-world values are pin-frozen, so a render arena's clocks
	 * never move (the settle gate; set per tenancy at claim). */
	bumpsClocks: boolean;
	vals: Value[] = [];
	/** The observer coalescing register:
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
 * and the reclamation guards are confined to — the discipline: world state
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
	growWorldArenaColumns(a, id >> ArenaGeom.ID_TO_COLUMN_SHIFT); // the grown-together columns
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
	scrubWorldLinkColumnsOnFree(a, id); // a reused link must not carry a dead tenancy's observer stamp
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

// ---- the arena serving/lifecycle layer ----
// The functions below serve world reads from arenas (refolding through the
// arena's own walks when marks or cold bases demand it), manage arena
// claim/release and the shell pool, fan committed-truth flips into arenas
// as marks, and run the routing walks deliveries and drains traverse. The
// cycles they form with world evaluation (evaluate → arenaServe → foldAtom)
// resolve by same-module function hoisting.

/** Committed arenas, by root (consumer-populated life; the quiescence
 * sweep releases zero-consumer entries). */
let rootToArena: Map<RootId, WorldArena>;
/** Pooled released arena shells (buffers reused; claimGen bumped per
 * tenancy; capped at ARENA_POOL_CAP). */
let arenaPool: WorldArena[];
/** Watchers re-staled by their own commit, per root (the render
 * lifecycle's re-staled loop writes; the durable drain consumes;
 * retirement and the commit lock-in read the size as their drain gate). */
let restaled: Map<RootId, Set<Watcher>>;

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
	for (let i = 0; i < a.suspended.length; i++) suspendedCount--;
	a.alive = false;
	a.claimGen++;
	// Keep the side columns' CAPACITY across pool tenancies (a priced
	// cold-render saving): truncating to 0 forced claimArena + arenaAllocShadow to re-push
	// every element on every claim (~2k pushes per cold render). fill()
	// scrubs the same residue truncation would have dropped — value refs are
	// released (no pooled-arena leak), nodeToShadow reads 0 (= none), suspIdx
	// reads 0 (= not suspended) — while the packed length persists, so
	// the next tenancy's growth loops are no-ops up to this watermark.
	resetWorldArenaColumnsOnRelease(a); // every declared column resets (the layout region's coherence set)
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
 * Settle a node's per-root committed clock after an observer consult —
 * the one clock-advance site of the world arenas (the bump rule for
 * per-root committed clocks, consult-driven).
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
 * and one spanning consults re-fires (the at-least-once contract's
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
	if (clock !== 0 && !isValueChanged(node, a.cutoffVals[vi], v)) return clock;
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
	scrubWorldShadowColumnsOnEvict(a, sh); // value + clock slots clear together
}

/** Arena dep recording (arena fn-reader hook): first-occurrence mode
 * reset + strong-dominates ride inside arenaLink. The pre-dedup
 * observation capture rides the strong arm only (the observation union
 * is strong-only). */
function arenaRecordDep(dep: AnyInternals, weak: boolean): void {
	const a = arenaFrame;
	if (a === undefined) return;
	if (!weak) {
		const oc = obsCapture;
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
	suspendedCount++;
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
	suspendedCount--;
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
			const oc = obsCapture;
			if (oc !== undefined) oc.push(node);
		}
		return a.vals[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT];
	}
	const sh = resolveShadow(a, node, ArenaFlag.K_COMPUTED);
	const memory = a.memory;
	let flags = memory[sh + ArenaField.FLAGS]!;
	if ((flags & ArenaFlag.RECURSED_CHECK) !== 0) {
		throw createCycleError(node.name);
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
		const oc = obsCapture;
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
	const next = foldAtom(atom, a.world);
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
	const nid: NodeIndex = a.memory[sh + ArenaField.NODE]!;
	const node = nodeIndexToInternals[nid] as ComputedInternals;
	a.memory[sh + ArenaField.DEPS_TAIL] = 0;
	a.memory[sh + ArenaField.FLAGS] = (a.memory[sh + ArenaField.FLAGS]! | ArenaFlag.MUTABLE | ArenaFlag.RECURSED_CHECK) & ~(ArenaFlag.RECURSED | ArenaFlag.DIRTY | ArenaFlag.PENDING);
	const savedFrameArena = arenaFrame;
	const savedFrameShadow = arenaFrameShadow;
	const savedFrameCycle = arenaFrameCycle;
	const savedRoute = serveOverride;
	const savedWorld = activeWorld;
	const savedSink = currentSink;
	const savedObsCapture = obsCapture;
	arenaFrame = a;
	arenaFrameShadow = sh;
	arenaFrameCycle = arenaBumpCycle(a);
	serveOverride = a;
	currentSink = 0;
	obsCapture = obsRefs[nid]! > 0 ? [] : undefined; // nid is the nodeIndex (the NODE column)
	setWorld(a.world);
	evalDepth++;
	const tr = trace; // paired eval hooks; end fires on throw too
	if (tr !== undefined) tr.evalStart(node, a.world);
	try {
		return arenaFoldOutcome(a, sh, node.fn(arenaTrackedReader, arenaUntrackedReader), node.isEqual);
	} catch (err) {
		arenaNoteThrow(a, sh, err);
		throw err;
	} finally {
		if (tr !== undefined) tr.evalEnd();
		const obsCaptured = obsCapture;
		evalDepth--;
		setWorld(savedWorld);
		obsCapture = savedObsCapture;
		currentSink = savedSink;
		serveOverride = savedRoute;
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
	const so = serveOverride;
	serveOverride = undefined;
	try {
		syncObservedDeps(node, captured);
	} finally {
		serveOverride = so;
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
	return runInFoldCallback(() => eq(prev, next));
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
	const gen = ++walkGen;
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
	const savedWorld = activeWorld;
	const savedRoute = serveOverride;
	const savedSink = currentSink;
	const savedObsCapture = obsCapture;
	setWorld(world);
	serveOverride = FOLD_TRUTH;
	currentSink = 0;
	obsCapture = undefined;
	evalDepth++;
	try {
		return fn();
	} finally {
		evalDepth--;
		obsCapture = savedObsCapture;
		currentSink = savedSink;
		serveOverride = savedRoute;
		setWorld(savedWorld);
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

// ---- delivery: the notification queue + the walk orchestration --------------------------
// A DELIVERY is the notification that schedules a watcher's re-render
// after a write; a DRAIN is the sweep run when committed truth moves
// (re-check every observer the change could reach against committed state
// and correct the stale ones). Two layers here:
//
//  - the queue mechanism: listener callbacks queued during a public
//    operation's own mutations and DELIVERED AT THE OPERATION BOUNDARY
//    (queued into reusable columns during the walk and invoked after the
//    operation's mutations complete, so a listener can never re-enter a
//    half-finished operation). The listener slots themselves (`onDelivery`
//    / `onMountCorrective` / `onCorrection` — the bindings' consumption
//    surface) are the module lets in the state block above, assigned by
//    attachDriver and read live per flushed item.
//  - the walk ORCHESTRATION: the value-blind per-write delivery walk
//    (which traverses the arenas' strong links through the walk halves in
//    the arena section), the durable drain at committed-truth flips, the
//    quiet-fold drain, and `correctWatcher`, the one urgent pre-paint
//    correction every compare-and-correct site shares.

/** The queued-notification kinds (the notify columns' kind codes). Same-file
 * const enum with its one consumer, the flush loop; resident enqueue sites
 * pass the bare 0-3 codes (numeric literals are assignable, so cross-module
 * callers never name this type — cross-module const enum access does not
 * survive esbuild). */
const enum NotifyKind {
	DELIVERY = 0,
	MOUNT_CORRECTIVE = 1,
	CORRECTION = 2,
	SUBSCRIPTION_REFIRE = 3,
}

/** The two live queue scalars (shared record — see the module header). */
export type NotifyState = { n: number; flushing: boolean };

// Queued-notification columns (reused across operations; no per-notify objects).
const notifyKinds: number[] = [];
const notifyWs: (Watcher | undefined)[] = [];
const notifyBatches: (Batch | undefined)[] = [];
const notifySlots: BatchSlot[] = [];
const notifySubs: (Subscription | undefined)[] = [];
const notifyState: NotifyState = { n: 0, flushing: false };

function queueNotify(kind: NotifyKind, w: Watcher | undefined, t: Batch | undefined, slot: BatchSlot, sub?: Subscription): void {
	const i = notifyState.n++;
	notifyKinds[i] = kind;
	notifyWs[i] = w;
	notifyBatches[i] = t;
	notifySlots[i] = slot;
	notifySubs[i] = sub;
}

/** Invokes queued listeners at the end of the public operation. A nested
 * public operation started BY a listener appends behind the live bound
 * and drains in the same sweep (the flushing flag stops nested sweeps). */
function flushNotify(): void {
	if (notifyState.n === 0 || notifyState.flushing) return;
	// The listener SLOTS are read per item below (live reads — a listener
	// detaching mid-flush takes effect for the remaining items).
	notifyState.flushing = true;
	try {
		for (let i = 0; i < notifyState.n; i++) {
			const kind = notifyKinds[i]!;
			const w = notifyWs[i];
			const t = notifyBatches[i];
			const s = notifySubs[i];
			notifyWs[i] = undefined; // release object refs eagerly
			notifyBatches[i] = undefined;
			notifySubs[i] = undefined;
			if (kind === NotifyKind.DELIVERY) {
				const l = onDelivery;
				if (l !== undefined) l(w!, t!, notifySlots[i]!);
			} else if (kind === NotifyKind.MOUNT_CORRECTIVE) {
				const l = onMountCorrective;
				if (l !== undefined) l(w!, t!, notifySlots[i]!);
			} else if (kind === NotifyKind.CORRECTION) {
				const l = onCorrection;
				if (l !== undefined) l(w!);
			} else if (s !== undefined && s.live) {
				// Subscription refire (adapter-registered): the value gate
				// already passed at the boundary scan; the adapter owns the
				// body run (cleanup + fire + re-capture) and any React-phase
				// deferral. Removal flips `live`, so nothing runs after
				// teardown.
				const r = s.refire;
				if (r !== undefined) r();
			}
		}
	} finally {
		notifyState.n = 0;
		notifyState.flushing = false;
	}
}

/** Reused delivery-walk collection buffer (walks are never re-entrant). */
const walkWatchers: Watcher[] = [];

/** Reused durable-drain candidate buffer (drains are never re-entrant). */
const drainWatcherBuf: Watcher[] = [];

/**
 * The value-blind delivery walk: reachability from the written
 * atom over EVERY live arena's STRONG links — render arenas included; the
 * walk visits structure, never values or marks, so a render's frozen pin
 * is untouched. The weak bit is tested and weak links are
 * never traversed (untracked reads never notify; the bit test
 * is the walk's whole per-link cost for that rule). Kernel (K0)
 * subscribers are served by the eager kernel apply, not this walk.
 * Value-blind: a
 * delivery announces "a write in this batch may affect you", never a
 * value — the receiving render folds its own world. Collected watchers
 * dedup globally per node (lastWalk) across arenas and deliver in id
 * order (the reference model's map order). Deliveries may be FEWER than
 * the model's union-conservative set, never more: a cone
 * held by no live arena is still corrected — it degrades to the
 * committed-truth drain instead of a live delivery.
 */
function deliveryWalk(from: AtomInternals, batch: Batch, slot: BatchSlotMeta, seq: Seq): void {
	const gen = ++walkGen;
	const found = walkWatchers;
	found.length = 0;
	const kGen = getKernelGeneration(from.id); // one read per walk: seeds validate tenancy against it
	lastWalk[from.ix] = gen;
	collectWatchersAt(from.ix, found);
	for (const a of rootToArena.values()) walkArenaStrong(a, from.ix, kGen, gen, found);
	for (const p of rootToOpenRender.values()) {
		if (p.arena !== undefined) walkArenaStrong(p.arena, from.ix, kGen, gen, found);
	}
	if (found.length > 1) found.sort((a, b) => a.id - b.id);
	for (let i = 0; i < found.length; i++) deliver(found[i]!, batch, slot, seq);
	found.length = 0;
}

/**
 * Delivery — per-write, value-blind, in the writer's stack. The
 * per-(watcher, slot) dedup bit suppresses a repeat delivery only when
 * scheduled-but-unstarted work will fold the write anyway; otherwise
 * deliver interleaved so no write can slip between renders unseen.
 */
function deliver(w: Watcher, batch: Batch, slot: BatchSlotMeta, seq: Seq): void {
	const tr = trace; // one load covers this call's (at most two) record sites
	const bit = 1 << slot.id;
	if ((w.dedupBits & bit) === 0) {
		w.dedupBits |= bit;
		if (tr !== undefined) tr.delivery(w, batch.id, slot.id, seq, false);
		if (onDelivery !== undefined) queueNotify(0, w, batch, slot.id);
		return;
	}
	// Bit set: suppress iff no started-and-uncommitted render on the
	// watcher's root includes this slot (render mask) with pin < the
	// write's sequence — such a render froze BEFORE this write, so it would
	// fold without it and a fresh delivery is still required.
	// One open render per root ⇒ one registry load + two compares.
	const p = rootToOpenRender.get(w.root);
	if (p !== undefined && ((p.maskBits >>> slot.id) & 1) === 1 && p.pin < seq) {
		if (tr !== undefined) tr.delivery(w, batch.id, slot.id, seq, true);
		if (onDelivery !== undefined) queueNotify(0, w, batch, slot.id);
	} else {
		if (tr !== undefined) tr.suppressed(w, batch.id, slot.id, seq);
	}
}

/** The one urgent pre-paint watcher correction (gate → record → resets →
 * notify). A correction must move the rendered register, advance the
 * lastValidatedAt stamp, re-arm the dedup bits, and queue the kind-2
 * notify together — all four correction sites (settlement drain, quiet
 * drain, durable drain, mount fixup) share this body so the tuple can
 * never drift. The gate is split by the at-least-once contract:
 *
 *  - Drain causes (retirement / per-root-commit / quiet) gate on CLOCKS:
 *    the candidate's evaluation just settled the watched node's per-root
 *    committed clock, and a correction fires iff that clock differs from
 *    the watcher's lastValidatedAt — no value comparison. Flip-flops
 *    whose intermediate states were refolded re-fire spuriously by
 *    accepted design; the stamp advances here (the urgent correction is
 *    a validation).
 *  - TWO cross-world cases keep the value compare, because per-root
 *    committed clocks cannot express equivalence between two different
 *    worlds: the mount fixup (cause 'mount' — a mountFix-world value
 *    against the rendered register; it does not stamp — the commit
 *    populator right after it owns the watcher's validation) and
 *    candidates re-rendered or mounted by the CURRENTLY COMMITTING
 *    render (committingRender — their register was just reset from
 *    the render world, and the commit's own lock-in bumps the committed
 *    clock for exactly the content the screen already shows, so a clock
 *    gate would correct every watcher at every commit; a firing
 *    correction here reconciles against committed-now, so it stamps).
 *
 * Records by cause: drains record reconcile-correction; mounts record
 * mount-correction (decoded as 'mount-urgent-correction'); quiet folds
 * record nothing here — the fold's own quiet-write record is the whole
 * quiet stream, and the reference model's mirrored quiet corrections are
 * silent too, so the streams stay comparable. Returns true iff a
 * correction fired. */
function correctWatcher(w: Watcher, wInternals: AnyInternals, now: Value, cause: 'retirement' | 'per-root-commit' | 'quiet' | 'mount'): boolean {
	const committing = committingRender;
	if (cause === 'mount' || (committing !== undefined && w.snapshot.renderPassId === committing.id)) {
		// Cross-world gate (the value compare per-root clocks cannot replace).
		if (!isValueChanged(wInternals, w.lastRenderedValue, now)) return false;
		if (cause !== 'mount') {
			const a = rootToArena.get(w.root);
			if (a !== undefined) w.lastValidatedAt = committedNodeClock(a, w.nodeIx);
		}
	} else {
		const a = rootToArena.get(w.root);
		const clockNow = a === undefined ? 0 : committedNodeClock(a, w.nodeIx);
		if (clockNow === w.lastValidatedAt) return false;
		w.lastValidatedAt = clockNow;
	}
	if (cause !== 'quiet') {
		const tr = trace;
		if (tr !== undefined) {
			if (cause === 'mount') tr.mountCorrection(w, w.lastRenderedValue, now);
			else tr.reconcileCorrection(w, w.root, w.lastRenderedValue, now, cause === 'per-root-commit');
		}
	}
	w.lastRenderedValue = now; // the urgent pre-paint re-render
	w.dedupBits = 0; // dedup bits re-arm at the watcher's render
	if (onCorrection !== undefined) queueNotify(2, w, undefined, 0);
	return true;
}

/** Value-gated watcher reconciliation for a quiet fold: committed truth
 * moved for every root, and no slot/walk state exists to scope candidates,
 * so every live watcher re-checks directly — the same compare-and-correct
 * block as drainCommittedObservers. (Committed subscriptions re-check via
 * revalidateCommittedSubscriptions at the same boundary.) */
function quietDrain(): void {
	for (const w of watchers.values()) {
		if (!w.live) continue;
		const wInternals = resolveWatcherInternals(w);
		if (wInternals === undefined) continue; // loud skip: record tenancy moved
		const now = evaluate(wInternals, { kind: 'committed', root: w.root });
		// The drain is an observer consult: settle the watched node's
		// committed clock before the correction gate reads it.
		const a = rootToArena.get(w.root);
		if (a !== undefined) settleObserverClock(a, wInternals);
		correctWatcher(w, wInternals, now, 'quiet');
	}
}

/**
 * Durable drain at a committed-truth flip (a retirement or per-root
 * commit): the candidate set is the root arena's DIRTY LIST —
 * the fanout sites' marks, whose cones the marks' PENDING propagation
 * already covers — expanded over all arena links, strong and weak
 * (drains expand over both; a weak hop's strong dependents
 * expand past it too, since the walk keeps going), collecting live
 * same-root watchers on visited nodes, unioned with the `restaled` set.
 * Reconcile-check each candidate (last rendered value vs
 * committed-for-root now; urgent pre-paint correction on real
 * difference — comparing values is legal here because both sides are
 * committed truth, whereas live-write delivery must stay value-blind).
 * Candidates fire in id order (the reference model's map order). List
 * entries persist until decay drops them, and consumed marks still seed
 * conservatively — extras are value-gated no-ops, exactly as the old
 * slot touched lists were. Committed SUBSCRIPTIONS do not drain here:
 * their re-check is once per boundary operation
 * (revalidateCommittedSubscriptions).
 */
function drainCommittedObservers(rootId: RootId, cause: 'retirement' | 'per-root-commit'): void {
	const world: World = { kind: 'committed', root: rootId };
	const gen = ++walkGen; // per-node collection dedup + per-arena traversal stamps
	const ws = drainWatcherBuf;
	ws.length = 0;
	// Candidate collection: the root arena's dirty list seeds a
	// walk over all arena links — weak included (the walk itself lives in
	// CosignalEngine.ts's world-arena sections, same-file with the enums).
	const a = rootToArena.get(rootId);
	if (a !== undefined && a.dirty.length !== 0) {
		arenaCollectDrainCandidates(a, gen, rootId, ws);
	}
	{
		const re = restaled.get(rootId);
		if (re !== undefined && re.size > 0) {
			for (const w of re) {
				if (!w.live) continue;
				if (lastWalk[w.nodeIx] === gen) continue; // its node was already listed (cached index; valid while the gen-checked fire below resolves)
				ws.push(w);
			}
			re.clear();
		}
	}
	if (ws.length > 1) ws.sort((a, b) => a.id - b.id);
	for (let i = 0; i < ws.length; i++) {
		const w = ws[i]!;
		const wInternals = resolveWatcherInternals(w);
		if (wInternals === undefined) continue; // loud skip: record tenancy moved
		const now = evaluate(wInternals, world);
		// The drain is an observer consult: settle the watched node's
		// committed clock before the correction gate reads it.
		if (a !== undefined) settleObserverClock(a, wInternals);
		correctWatcher(w, wInternals, now, cause);
	}
	ws.length = 0;
}

// ---- settlement ---------------------------------------------------------------------
// A SETTLEMENT is a suspended thenable resolving: a computed that read a
// pending promise through ctx.use left a suspension sentinel behind, and
// when the promise settles, every world view that cached that sentinel must
// re-evaluate. The kernel's per-thenable shared listener calls the tap
// below; the tap queues the thenable's stable sentinel; the drain
// invalidates every arena shadow boxed on it, reconciles the touched roots'
// committed observers, and re-checks committed subscriptions — the
// settlement boundary. The operation epilogue (`runOperationEpilogue`) is
// what every public operation owes on exit: drain queued settlements to
// empty (the fixed point), then the armed divergence check; `endOperation`
// is the compound-operation tail (trace opEnd mark + the queued-
// notification flush).

/** Pending-settlement queue + the sentinel queued bit (identity dedup). */
let pendingSettle: SuspendedRead[] = [];
const pendingSettleSet = new Set<SuspendedRead>();
let settleDraining = false;
let settleDrainScheduled = false;
/** Drain termination: the settlement drain adopts the engine's flush
 * bound discipline — an iteration cap with a diagnostic on breach; a
 * chain of callbacks that synchronously settles ever-new thenables is
 * user feedback, the effect-loop equivalent. */
let settleCap = 10_000;

/** Test seam: shrink the settlement-drain iteration cap. @internal */
function setSettleCap(n: number): void {
	settleCap = n;
}

/**
 * The settle tap (the push half of settlement): called by the kernel's per-thenable
 * shared listener after the status write. Create-on-tap is the first act —
 * the kernel's own lazy-create expression — so a synchronous custom
 * thenable (whose callbacks fire before `unwrapThenable`'s throw creates
 * `t.suspendSentinel`) still yields one sentinel identity shared with the later throw.
 */
function settleTap(t: PromiseLike<unknown>): void {
	const th = t as PromiseLike<unknown> & { suspendSentinel?: SuspendedRead };
	const suspendSentinel = (th.suspendSentinel ??= new SuspendedRead(t));
	if (suspendedCount === 0 && pendingSettle.length === 0) return; // no arena suspensions anywhere
	if (pendingSettleSet.has(suspendSentinel)) return; // queued bit
	pendingSettleSet.add(suspendSentinel);
	pendingSettle.push(suspendSentinel);
	if (settleDraining || notifyState.flushing || opDepth !== 0 || evalDepth !== 0 || inFoldCallback) {
		// Mid-operation: the enclosing operation's epilogue (or the drain's
		// own next iteration) consumes it. Read-context settlement: an
		// epilogue-less read frame — standalone committedValue/
		// renderValue — has no epilogue, so also schedule one coalesced
		// microtask drain, the kernel's own attachSettleListener discipline
		// (queueMicrotask); it no-ops when an epilogue got there first.
		if (!settleDrainScheduled) {
			settleDrainScheduled = true;
			// Engine-epoch guard (cross-reset microtask discipline): a
			// drain scheduled by a dead test must not run this (dead)
			// composition's queue into the next test's time.
			const epoch = engineEpoch;
			queueMicrotask(() => {
				settleDrainScheduled = false;
				if (epoch !== engineEpoch) return;
				if (pendingSettle.length !== 0 && opDepth === 0 && evalDepth === 0 && !settleDraining && !notifyState.flushing) {
					drainSettlements();
				}
			});
		}
		return;
	}
	// At rest (the kernel's batchDepth === 0 arm): drain immediately — a
	// background-only suspended watcher or effect refires from the
	// settlement event itself; no unrelated operation is ever needed.
	drainSettlements();
}

/**
 * The settlement drain — one queue-owning loop, the only consumer of the
 * pending-settlement queue, identical at every drain site, and it owns
 * the notification flush: `flushNotify` runs inside the loop,
 * so a refire callback that synchronously settles another thenable lands
 * its sentinel in the queue and gets the next iteration. The drain is the
 * settlement boundary; it never returns with a queued settlement
 * unscanned or unflushed.
 */
function drainSettlements(): void {
	if (settleDraining) return;
	settleDraining = true;
	opDepth++; // taps landing mid-drain enqueue (next iteration)
	try {
		let iter = 0;
		while (pendingSettle.length !== 0) {
			if (++iter > settleCap) {
				throw new InvariantViolation(
					`settlement drain exceeded ${settleCap} iterations — a settlement chain is synchronously settling ever-new thenables (user feedback, the effect-loop equivalent)`,
				);
			}
			const taken = pendingSettle;
			pendingSettle = [];
			for (let i = 0; i < taken.length; i++) pendingSettleSet.delete(taken[i]!);
			const touchedRoots = new Set<RootId>();
			for (let i = 0; i < taken.length; i++) {
				const suspendSentinel = taken[i]!;
				eachArena((a) => {
					// Scan the suspended list (dense — O(current suspensions))
					// for shadows whose box payload is this sentinel —
					// the arena half (marks + propagation + the read-clock
					// bump) lives with the layout enums: CosignalEngine.ts
					// arenaInvalidateSettled. The marks are the invalidation
					// (arenas serve world reads); committed roots
					// also join the cone drain below. Open-render arenas keep
					// their marks for the frame's close.
					if (arenaInvalidateSettled(a, suspendSentinel) && a.kind === 'committed') touchedRoots.add(a.root);
				});
				// (Newest suspensions need no eviction here: the
				// kernel's own attachSettleListener listener invalidates kernel-cached
				// suspensions at settlement, and boxedRead self-heals at reads.)
			}
			// Cone drain: value-gated committed re-checks of the touched
			// roots' live watchers (the durable-drain compare; the marks
			// fanned above drive the arena refolds), deferred for roots
			// with an open render frame (their close flushes).
			for (const rootId of touchedRoots) {
				if (rootToOpenRender.has(rootId)) continue;
				const ra = rootToArena.get(rootId);
				for (const w of watchers.values()) {
					if (!w.live || w.root !== rootId) continue;
					const wInternals = resolveWatcherInternals(w);
					if (wInternals === undefined) continue; // loud skip: record tenancy moved
					const now = evaluate(wInternals, { kind: 'committed', root: rootId });
					// The settlement drain is an observer consult: settle the
					// watched node's committed clock before the correction
					// gate reads it.
					if (ra !== undefined) settleObserverClock(ra, wInternals);
					correctWatcher(w, wInternals, now, 'retirement');
				}
			}
			// Boundary subscription scan + the flush the loop owns.
			// (Core effect()s need nothing here: settlements move world
			// visibility, never newest values, so the kernel is untouched.)
			if (committedSubCount !== 0) revalidateCommittedSubscriptions(undefined);
			flushNotify();
		}
	} finally {
		opDepth--;
		settleDraining = false;
	}
	// Reclamation retry trigger — the settlement drain is one of the
	// suspended-row's whole-teardown drains: settlements just moved
	// suspension state across every arena. Size-0 bail inside.
	reclaimRetryAllSkipped();
}

/** Public-operation epilogue: drain queued settlements to empty
 * (the fixed point), then the divergence check when armed. Both halves
 * are top-level-boundary work: a nested operation (an effect's writes
 * during a fused apply run whole write/fold operations inside the outer
 * one) must not drain or check mid-outer — the outer epilogue owes both
 * once its own mutations complete. */
function runOperationEpilogue(): void {
	if (opDepth !== 0) return; // nested operation: the outer epilogue owns the boundary
	if (pendingSettle.length !== 0 && !settleDraining) drainSettlements();
	if (epilogueCheck !== undefined) epilogueCheck();
}

/** The compound-operation tail every public exit owes, in order: the
 * trace's opEnd mark (scopes causality), then the queued-notification
 * flush. One copy — an exit that forgets either desyncs trace causality
 * or strands queued notifies, so every exit calls this instead. */
function endOperation(): void {
	const tr = trace;
	if (tr !== undefined) tr.opEnd();
	flushNotify();
}

/** Queue depth (diagnostics — the engine's __arenaStats). */
function getPendingSettleCount(): number {
	return pendingSettle.length;
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

/** The extras-column object of a watcher record: the cold oddments —
 * name, owning root, and the flattened
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
	 * register (the record's values-column slot). Not a re-fire gate:
	 * corrections are clock-decided (the at-least-once contract); this
	 * register survives because non-gating contracts read it — the bindings' mount
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
	 * per the at-least-once contract: a committed render whose rendered value
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
		observerShift(this, value ? 1 : -1);
	}
}

/** Free a watcher's arena record (the render lifecycle's drop tail —
 * unmount, discard, removal). The free defers to the next operation
 * boundary (queued notifications may still hold the handle; its own id
 * fields stay readable), where {@link scrubNodeColumnsOnFree} clears every
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
 * {@link scrubWorldLinkColumnsOnFree} clears each link's clock slot on free. */
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

// ---- the committed-observer lifecycle ----
// Registration, the capture frame that snapshots deps under the committed
// world, removal, the test-side replay surface, and the boundary
// revalidation. The dep-snapshot re-pointer and the refcount shift that
// releases a removed snapshot's retains are the observation index's
// functions, called directly.

/** The committed `run`-action subscription store (fresh per composition;
 * the engine surface and the quiesce sweep read it in place). */
let idToSubscription: Map<SubscriptionId, Subscription>;
/** Monotone subscription-id source (registration order — the boundary
 * scan's iteration order, the reference model's map order); fresh per
 * composition. */
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
	if (evalDepth > 0 || inFoldCallback) {
		throw new ScheduleError('effect registration is illegal inside an open evaluation/fold frame');
	}
	const sub = new Subscription(nextSubscriptionId++ as SubscriptionId, name, rootId, refire);
	root(rootId);
	idToSubscription.set(sub.id, sub);
	committedSubCount += 1;
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
	if (captureFrame !== undefined) throw new ScheduleError('captureRun frames do not nest — one effect body runs at a time');
	if (evalDepth > 0) throw new ScheduleError('captureRun is illegal inside an open evaluation frame');
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
		const a = rootToArena.get(sub.root);
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
	const frame = captureFrame;
	if (frame === undefined) throw new ScheduleError('captureRead requires an open captureRun frame');
	const v = evaluate(node, { kind: 'committed', root: frame.sub.root });
	frame.deps.push({ node, value: v, stamp: committedDepStamp(frame.sub.root, node) });
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
	committedSubCount -= 1;
	sub.cleanups++;
	const tr = trace;
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
	const a = rootToArena.get(sub.root);
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
	const tr = trace;
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
 * The per-dep decision is the at-least-once clock rule (no value
 * comparison anywhere in it):
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
	if (committedSubCount === 0) return;
	for (const sub of [...idToSubscription.values()]) {
		if (!sub.live) continue;
		if (rootFilter !== undefined && sub.root !== rootFilter) continue;
		if (rootToOpenRender.has(sub.root)) continue; // deferred to the frame's close
		const world: World = { kind: 'committed', root: sub.root };
		const a = rootToArena.get(sub.root);
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
			if (a !== undefined && settleObserverClock(a, d.node) !== stamp) {
				changed = true;
				break;
			}
			if (a !== undefined) l = a.memory[l + ArenaLinkField.NEXT_DEP]!;
		}
		if (changed) runCommittedSubscription(sub);
	}
}

// ---- render integration ------------------------------------------------------------

/**
 * Render passes and watchers — the render lifecycle of the concurrent
 * engine. A render pass is one render of one root: its pin is the timeline
 * position frozen at render start (the render folds nothing written after
 * it, so a paused-and-resumed render never drifts) and its mask is the set
 * of live batches the render is rendering. A watcher is one subscribed
 * component instance (the full vocabulary — write log, batch, slot, world,
 * arena — is defined at the top of the concurrent-machinery section). This
 * section owns:
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
 * The section's own state is the render/watcher id counters and the
 * stale-skip diagnostic (composeEngine re-initializes them per
 * composition); everything else it touches — world evaluation, arena
 * claim/decay/fanout, the delivery walks' drains and corrections, batch
 * retirement — is a direct same-module call. The pass/watcher registries
 * (`idToRenderPass`, `watchers`, `nodeToWatchers`, `rootToOpenRender`) are
 * shared module state: this section owns every transition; the registry's
 * gap-fill, the record-free scrub, and the quiescence sweep read them in
 * place.
 *
 * Per-world state discipline: the orchestration here reads
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

/** Render-pass id source (fresh per composition). */
let nextRenderPassId = 1;
/** Watcher id source (mount order — delivery/drain firing order; fresh per
 * composition). */
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

/** The watcher liveness shift (the Watcher.live setter's one call —
 * beside the record in the observer-records section): a live watcher
 * holds one observed-consumer ref on its watched node, carried into the
 * observation index generation-checked — a stale watcher's liveness
 * flips shift nothing (skips pair up: tenancy generations only ever
 * grow, so a stale stamp can never re-validate between a skipped retain
 * and its release; a stale watcher from a dead composition no-ops the
 * same way). */
function observerShift(w: Watcher, delta: 1 | -1): void {
	const node = resolveWatcherInternals(w);
	if (node !== undefined) shiftObservedCount(node, delta);
}

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
		const t = getBatchById(id);
		if (t.state !== 'live') throw new ScheduleError('mask captures live batches only — a retired batch is already permanent history');
		maskBatches.add(id);
		// A live batch with no slot never wrote; if it writes later, those
		// log entries postdate this render's pin and the visibility rule's
		// included-up-to-pin clause excludes them anyway.
		if (t.slot !== undefined) maskBits |= 1 << t.slot;
	}
	// The committed-set capture materializes the root record (reference-model
	// parity: the model's committedSlotsNow() creates it on first consult).
	const includedBits = maskBits | root(rootId).committedBits;
	const render: RenderPass = {
		id: nextRenderPassId++, root: rootId, pin: seq,
		maskBatches, maskBits, includedBits,
		state: 'open', endKind: undefined, mounted: [], rendered: new Set(),
	};
	// Claim the render's world arena from the pool — the render
	// world's value+invalidation+routing layer.
	render.arena = claimArena('render', { kind: 'render', render }, rootId);
	idToRenderPass.set(render.id, render);
	rootToOpenRender.set(rootId, render);
	recomputeQuiet(); // an open render: the pipeline is armed until it closes
	const tr = trace;
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
	const tr = trace;
	if (tr !== undefined) {
		tr.renderYield(p);
		tr.opEnd();
	}
}

function renderResume(id: RenderPassId): void {
	const p = getRenderPassById(id);
	if (p.state !== 'yielded') throw new ScheduleError('resume requires a yielded render');
	p.state = 'open';
	const tr = trace;
	if (tr !== undefined) {
		tr.renderResume(p);
		tr.opEnd();
	}
}

/** Mount a new watcher inside an open render; it renders in the render's world. */
function mountWatcher(renderPassId: RenderPassId, node: AnyInternals, name: string): Watcher {
	const p = getRenderPassById(renderPassId);
	if (p.state === 'ended') throw new ScheduleError('mount requires an open render');
	const value = evaluate(node, { kind: 'render', render: p });
	const watcher = new Watcher(nextWatcher++, name, p.root, node.id, node.ix, getKernelGeneration(node.id), value, {
		renderPassId: p.id, pin: p.pin,
		maskBits: p.maskBits, includedBits: p.includedBits,
		rootCommitGen: root(p.root).commitGen,
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
	opDepth++; // public-operation frame (see the engine's write dispatch)
	try {
		changed = commitBatchesInner(rootId, batches);
		// Boundary rule: a per-root commit is a boundary operation. When this
		// call moved committed truth, re-check the root's committed
		// subscriptions at the boundary value (renderEnd's sweep gets the same
		// re-check from renderEnd's own boundary; here the call is the
		// boundary). A no-op call re-checks nothing — the report's common
		// case re-names batches the sweep already locked in.
		if (changed) revalidateCommittedSubscriptions(rootId);
		endOperation();
	} finally {
		opDepth--;
	}
	runOperationEpilogue();
	return changed;
}

function commitBatchesInner(rootId: RootId, batches: Iterable<BatchId>): boolean {
	const rootState = root(rootId);
	const tr = trace;
	let changed = false;
	for (const tid of batches) {
		const t = idToBatch.get(tid);
		if (t === undefined || t.state !== 'live') continue; // retired (or reclaimed): the retired clause subsumes membership
		if (rootState.committedBatches.has(t.id)) continue; // idempotent set-add: already a member
		rootState.committedBatches.add(t.id);
		if (t.slot !== undefined) rootState.committedBits |= 1 << t.slot;
		rootState.commitGen++;
		advanceCommitted(); // committed-advance: every per-root commit bumps it
		// Committed-truth flip site: per-root lock-in — inside the per-batch
		// loop (commits lock in sets of batches), immediately after the
		// membership/gen/committedAdvance mutation and before this batch's drain, fan
		// THAT batch's touched atoms into THIS root's arena.
		{
			const ra = rootToArena.get(rootId);
			if (ra !== undefined) fanAtomsToArena(ra, t.atomsTouched, false);
		}
		if (tr !== undefined) tr.perRootCommit(rootId, t.id, rootState.commitGen);
		// Durable drain, gated the same way at every flip site: an advanced slot or
		// member-slot write drift (or restaled leftovers) means the root's
		// committed truth moved — candidates come from the arena's dirty
		// list, which the lock-in fanout just fed.
		const bits = (t.slot !== undefined ? 1 << t.slot : 0) | rootState.committedDirtySlots;
		rootState.committedDirtySlots = 0;
		const re = restaled.get(rootId);
		if (bits !== 0 || (re !== undefined && re.size > 0)) drainCommittedObservers(rootId, 'per-root-commit');
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
	opDepth++; // public-operation frame (see the engine's write dispatch)
	try {
		renderEndInner(id, kind, opts);
	} finally {
		opDepth--;
		committingRender = undefined; // the cross-world correction window closes with the operation
	}
	runOperationEpilogue();
}

function renderEndInner(id: RenderPassId, kind: 'commit' | 'discard', opts?: { retireAtCommit?: BatchId[] }): void {
	const render = getRenderPassById(id);
	if (render.state === 'ended') throw new ScheduleError('render already ended');
	if (kind === 'commit') {
		for (const tid of opts?.retireAtCommit ?? []) {
			const t = getBatchById(tid); // throws on unknown ids before any mutation
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
		for (const tid of render.maskBatches) maskBatchRecords.push(getBatchById(tid));
	}
	render.state = 'ended';
	render.endKind = kind;
	rootToOpenRender.delete(render.root);
	// One load covers this operation's record sites: the disposition
	// record here fires before the end's consequences (retirement folds,
	// per-root commits, drains, fixups) so consequences can cite it as
	// cause; the renderCommitted/renderDiscarded checkpoint markers below
	// fire after them (the reference model's stream position).
	const tr = trace;
	if (tr !== undefined) tr.renderEnd(render, kind);
	if (kind === 'discard') {
		for (const wid of render.mounted) dropWatcher(wid); // never subscribed; the tree died
		if (tr !== undefined) tr.renderDiscarded(render);
		reevaluateDeferredReleases();
		reclaimAfterRenderEnd(render);
		maybeCloseEpisode(); // the last open render just closed: the episode may end here
		recomputeQuiet(); // render closed (episode possibly ended): quiet may re-arm
		// Boundary rule: the frame close is the deferred flush point for
		// boundaries that occurred while this root's frame was open (the discard
		// itself advances nothing; committed truth may already have moved).
		revalidateCommittedSubscriptions(render.root);
		endOperation();
		return;
	}
	// The cross-world correction window opens: drains fired by this
	// commit's own retirements and lock-ins gate this render's
	// re-rendered/mounted watchers by VALUE (see correctWatcher — their
	// registers were just reset from the render world); cleared in
	// renderEnd's finally.
	committingRender = render;
	// (1) Baseline capture at the commit's committed-side entry.
	const baseline = { committedAdvance, rootCommitGen: root(render.root).commitGen };
	// The committing tree's content: re-rendered watchers take this render's
	// world values now — a watcher's last rendered value updates only at
	// committed renders, and it is the comparator later drains reconcile
	// against.
	for (const wid of render.rendered) {
		const w = watchers.get(wid);
		if (w === undefined) continue; // removed mid-render
		const wInternals = resolveWatcherInternals(w);
		if (wInternals === undefined) continue; // loud skip: record tenancy moved mid-render
		w.lastRenderedValue = evaluate(wInternals, { kind: 'render', render });
		w.snapshot = {
			renderPassId: render.id, pin: render.pin, maskBits: render.maskBits,
			includedBits: render.includedBits, rootCommitGen: root(render.root).commitGen,
		};
	}
	// (2) retirement folds due at this commit; then the per-root commit
	// (lock-in) of every still-live mask batch: this root now shows those
	// batches' writes, so its committed world must include them. The
	// lock-in — including step (3), each newly committed batch's durable
	// drain — is commitBatchesInner, the single owner of the transition;
	// the bindings' root-commit report handler is its other caller.
	for (const tid of opts?.retireAtCommit ?? []) retireInner(getBatchById(tid));
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
		const committedNow = evaluate(wInternals, { kind: 'committed', root: render.root });
		// The committed-render stamp rule (the at-least-once contract's
		// baseline-advance site): the populator's evaluation settled the
		// watched node's per-root committed clock. When the rendered
		// register agrees with committed-now, the screen is VALIDATED —
		// stamp lastValidatedAt at the settled clock; when it differs,
		// the watcher is re-staled — stamp 0 (never-validated), which
		// forces the next durable drain's clock gate to correct it even
		// if committed truth flips back meanwhile (spurious by accepted
		// design; the value compare here is the cross-world render ↔
		// committed commit-integrity check clocks cannot replace —
		// per-root clocks cannot express equivalence between two
		// worlds).
		// The populator is an observer consult: settle the watched node's
		// committed clock before the stamp rule reads it.
		{
			const ra = rootToArena.get(render.root);
			if (ra !== undefined) settleObserverClock(ra, wInternals);
			if (isValueChanged(wInternals, w.lastRenderedValue, committedNow)) {
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
		const ra = rootToArena.get(render.root);
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
		const ra = rootToArena.get(render.root);
		if (ra !== undefined) arenaDecay(ra); // boundary mark decay
	}
	reevaluateDeferredReleases();
	reclaimAfterRenderEnd(render);
	maybeCloseEpisode(); // the last open render just closed: the episode may end here
	recomputeQuiet(); // render closed (episode possibly ended): quiet may re-arm
	// Boundary rule: one committed-subscription re-check per commit
	// operation, at the boundary value — a render locking in two batches
	// re-checks once, not per batch.
	// Retirements folded into this commit moved committed truth for every
	// root, so the scan widens (each root still open-frame-deferred).
	revalidateCommittedSubscriptions((opts?.retireAtCommit ?? []).length > 0 ? undefined : render.root);
	endOperation();
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
		releaseArena(p.arena);
		p.arena = undefined;
	}
}

/** Deferred releases re-evaluate at every render end, commit and discard alike. */
function reevaluateDeferredReleases(): void {
	for (const s of slots) {
		if (!s.releasePending) continue;
		if (!isSlotRetainedByOpenMask(s.id)) releaseSlot(s);
	}
	// A render ending releases its pin, which can unlock retired-prefix
	// folds (the bounded-memory valve's pin clause).
	runFoldValve();
}

/**
 * Watchers re-staled by their own commit: the commit reset
 * lastRenderedValue to the render world's pin-old value while committed
 * truth had already moved past the pin. The reference model catches
 * these at its next full-scan drain; the engine keeps the precise set
 * (`restaled`) and folds it into the next durable drain on the
 * watcher's root.
 */
function markRestaled(w: Watcher): void {
	let set = restaled.get(w.root);
	if (set === undefined) {
		set = new Set();
		restaled.set(w.root, set);
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
	const tr = trace; // one load covers the corrective records + the disposition record
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
		if (onMountCorrective !== undefined) queueNotify(1, w, b, slot.id);
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
	const vFx = evaluate(node, {
		kind: 'mountFix', maskBits: w.snapshot.maskBits, pin: w.snapshot.pin, root: w.root,
	});
	if (correctWatcher(w, node, vFx, 'mount')) {
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
	if (pa !== undefined) collectArenaClosure(pa, node, closure);
	if (render !== undefined) {
		const ca = rootToArena.get(render.root);
		if (ca !== undefined) collectArenaClosure(ca, node, closure);
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

// ---- the public dispatch + the engine surface --------------------------------------------
// Everything from here to the composition section is the engine's
// operational face: quiescence reclamation and the checker window, the
// classified write path, world reads, the test-only engine reset, and the
// one `engine` record the harnesses, the diagnostics tooling, and the
// React bindings drive.

/** Last-batch cache (windowed writes hit one batch repeatedly — one compare
 * beats a Map probe on the classified write path). */
let lastBatchId = 0;
let lastBatchRef: Batch | undefined = undefined;

/** Drop the last-batch cache entry for a reclaimed batch id (the episode
 * close calls this per dropped record — the cache must never serve a batch
 * whose record the close swept). */
function invalidateBatchCache(id: BatchId): void {
	if (lastBatchId === id) {
		lastBatchId = 0;
		lastBatchRef = undefined;
	}
}

// ---- quiescence reclamation + the checker window (the divergence
// check and structural validator are test machinery and live in
// tests/arena-checker.ts, fed through __checkerInternals below) ----

/** The watcher-population refcount, derived (dev-assertable) form: live
 * watchers of the root + live committed subscriptions of the root. */
function getConsumerCount(rootId: RootId): number {
	let n = 0;
	for (const w of watchers.values()) {
		if (w.live && w.root === rootId) n++;
	}
	for (const sub of idToSubscription.values()) {
		if (sub.live && sub.root === rootId) n++;
	}
	return n;
}

/** Quiesce duty 1: release committed arenas whose consumer
 * population is zero — buffer to the pool (claim gen bumped), columns
 * dropped, lists discarded; the root record stays (no teardown event
 * exists). Then duty 2: per-arena read-clock renumber over the
 * survivors only. */
function arenaQuiesceSweep(): void {
	for (const [rootId, a] of rootToArena) {
		if (getConsumerCount(rootId) === 0) {
			rootToArena.delete(rootId);
			releaseArena(a);
		}
	}
	for (const a of rootToArena.values()) arenaRenumberMarks(a);
}

/**
 * The checker window: the one seam feeding the test-side checker —
 * tests/arena-checker.ts, which owns the armed divergence check
 * (arena-served values ≡ fold-truth) and the structural validator. The
 * views are readonly-shaped: live state getters plus bracket methods
 * that keep every mutation's save/restore discipline inside the engine.
 * Production code never calls this and installs no hook. Reads the current
 * composition at call time (reset-safe: re-arm after a reset). @internal
 */
export function __checkerInternals(): ArenaCheckerInternals {
	return {
		// The layout view is built by arenaCheckerLayout beside the enums
		// (same-file const enum discipline): in sync by construction.
		layout: arenaCheckerLayout(),
		get evalDepth(): number {
			return evalDepth;
		},
		get inFoldCallback(): boolean {
			return inFoldCallback;
		},
		eachArena: (fn) => eachArena(fn),
		internalsAt: (ix) => nodeIndexToInternals[ix],
		serve: (a, node) => arenaServe(a, node),
		runInFoldTruthFrame: (world, fn) => runInFoldTruthFrame(world, fn),
		createCycleError: (name) => createCycleError(name),
		runInFoldCallback: (fn) => runInFoldCallback(fn),
		holdOp: (fn) => {
			opDepth++;
			try {
				return fn();
			} finally {
				opDepth--;
			}
		},
		armEpilogueCheck: (check) => {
			epilogueCheck = check;
		},
	};
}

/** Test seam: the root's committed arena shell, if materialized — the
 * pool/wrap pins read shell state (claimGen, buffer identity,
 * column capacities) and force the clocks toward the Int32 ceiling.
 * @internal */
export function __arenaForTest(rootId: RootId): WorldArena | undefined {
	return rootToArena.get(rootId);
}

/** Test seam: pooled arena shells (the pool reuse/cap pins). @internal */
export function __arenaPoolForTest(): WorldArena[] {
	return arenaPool;
}

/** Test seam: the current composition's dense nodeIndex-keyed columns (the
 * leak/elements-kind audits probe row clearing and packedness; identity
 * changes at reset). @internal */
export function __columnsForTest(): {
	nodeIndexToInternals: (AnyInternals | undefined)[];
	lastWalk: number[];
	evalMark: number[];
	obsRefs: number[];
	obsDeps: (Set<AnyInternals> | undefined)[];
	nodeToWatchers: (Watcher[] | undefined)[];
} {
	return { nodeIndexToInternals, lastWalk, evalMark, obsRefs, obsDeps, nodeToWatchers };
}

/** Test seam: force an id-tenancy generation bump.
 * Tenancy is the kernel record generation (one id space),
 * so the bump writes the live record's GEN field in kernel memory: arena
 * shadows re-tenant cold at their next consult and watcher stamps go
 * stale, exactly as a real free+reuse would move them. @internal */
export function __bumpNodeGenForTest(id: NodeId): void {
	E.buffer()[id + NodeField.GEN]++;
}

/** Arena stats (tests/bench). @internal */
export function __arenaStats(): { committed: number; renders: number; pooled: number; suspended: number; pendingSettlements: number; dirty: number } {
	let renders = 0;
	let dirty = 0;
	for (const p of rootToOpenRender.values()) {
		if (p.arena !== undefined) renders++;
	}
	eachArena((a) => {
		dirty += a.dirty.length;
	});
	return { committed: rootToArena.size, renders, pooled: arenaPool.length, suspended: suspendedCount, pendingSettlements: getPendingSettleCount(), dirty };
}


// (runInFoldTruthFrame — the armed checker's naive evaluation frame — lives in
// CosignalEngine.ts with the serve-override state; __checkerInternals wires it.)

// ---- observed-closure maintenance ----
// The observation index — shiftObservedCount/enterObservation/
// exitObservation and the two dep-
// snapshot re-pointers — lives in ObservationIndex.ts (composed as `obs`; the

// ------------------------------------------------------ the write path

function internalsById(id: NodeId): AnyInternals {
	// Public surface: the caller's id is not provably a node record id, so
	// the row resolution carries its own identity check (a garbage id —
	// e.g. a link record's — reads free-list residue as its NODE_INDEX and
	// could alias an unrelated row).
	const hit = getResidentInternals(id);
	if (hit === undefined || hit.id !== id) throw new ScheduleError(`unknown node ${id}`);
	return hit;
}

// ------------------------------------------------------ the write path

/**
 * Quiet-mode write fold — the whole write while nothing is pending. The
 * op folds over committed base (updaters/reducers under both fold-purity
 * guards, exactly as replay would run them), the same equality drop as
 * the write path's log-empty drop check applies, and an accepted write
 * advances base and the kernel TOGETHER — the invariant while
 * quiet is base ≡ kernel newest ≡ every world's value, so a batch opened
 * later starts from a base that already contains the quiet history.
 * Clock coherence: the fold creates one sequence and stamps it into the
 * atom's baseSeq (the episode folds + the test-side model view read it) and the
 * committed-advance clock (committedAdvance), so baseline/fast-out checks see the fold. Observers: no
 * walk machinery is armed, so the small live-observer population is
 * reconciled value-gated, exactly like a durable drain (corrections for
 * watchers, re-runs for committed React effects; core effect()s are
 * kernel subscribers — the direct kernel apply itself flushes them).
 * No log entry, no batch, no write log append, no delivery walk. Observation:
 * when a tracer is attached the accepted fold creates one quiet-write
 * record — with no tracer that is one dead branch, and observation never
 * changes which write path executes (equality drops stay silent: there
 * is no batch to attribute a drop to).
 *
 * Policy equality: `isEqual(current, incoming)` — kernel order — invoked
 * once, at the acceptance decision. The direct kernel apply below runs no
 * policy comparator (a public-method re-entry would double-invoke it).
 */
export function quietWrite(node: AtomInternals, kind: WriteKind, payload: unknown): void {
	if (evalDepth > 0) throw new ScheduleError('signal write during a world evaluation / render — write from an event handler or effect instead');
	if (inFoldCallback) throw new ScheduleError('signal write inside an updater/reducer fold — updaters and reducers must be pure');
	// Public-operation frame (matches `write`): the fused kernel
	// apply below can run effects whose writes are whole nested
	// operations — settlements they tap enqueue for this fold's epilogue,
	// and the armed divergence check waits for the top-level boundary.
	opDepth++;
	try {
		quietWriteInner(node, kind, payload);
	} finally {
		opDepth--;
	}
	runOperationEpilogue();
}

function quietWriteInner(node: AtomInternals, kind: WriteKind, payload: unknown): void {
	const prev = node.base;
	// Fast arm — bench-pinned, do not fold into the isAtomValueEqual general arm
	// (A/B-measured: folding cost +37% on the bare quiet fold,
	// 12.9 → 17.7 ns): equality drops on one bare Object.is — no
	// applyOp/isAtomValueEqual call layer on the dominant write shape.
	let next: Value;
	if (kind === 0 /* WriteKind.SET */ && node.eqIsDefault) {
		if (Object.is(payload, prev)) {
			return; // equality drop against base — the write log is empty by the quiet invariant
		}
		next = payload;
	} else {
		next = kind === 0 /* WriteKind.SET */ ? payload : applyOp(node, kind, payload, prev);
		if (isAtomValueEqual(node, prev, next)) {
			return; // policy equality drop — once, kernel order (current, incoming)
		}
	}
	node.base = next;
	node.baseSeq = committedAdvance = ++seq; // advance the base + committed-advance clocks together (nextSeq, inlined)
	const tr = trace;
	if (tr !== undefined) tr.quietWrite(node, node.baseSeq);
	// Direct kernel apply: the plain write tail, no public-method re-entry
	// (policy checked, op folded, acceptance decided — equality's "once").
	// Effects flushed by it re-enter the public write path and classify
	// normally. `node.id` is the kernel record id (never through the
	// handle slot — reclamation keeps it weak for resolved nodes).
	writeNewest(node.id, next);
	// Committed-truth flip site: quiet fold — after the base/committedAdvance
	// advance, before quietDrain and the sub scan (the rootToArena.size
	// check is the one scalar branch consumer-less processes pay).
	fanAtomsToCommittedArenas(getSingleAtomBuffer(node));
	if (watchers.size !== 0) quietDrain();
	// A quiet fold moves committed truth for every root — a boundary
	// operation (quiet ⇔ no open renders, so no frame can defer the re-check).
	if (committedSubCount !== 0) revalidateCommittedSubscriptions(undefined);
	for (const a of rootToArena.values()) arenaDecay(a); // boundary mark decay
	if (notifyState.n !== 0) flushNotify();
}

/** A write belongs to the batch context it executes in; a bare write has
 * none, so it joins the ambient default batch — unless the engine is
 * quiet, in which case the write folds directly (no ambient batch is
 * created while nothing is pending). */
export function bareWrite(node: AtomInternals, kind: WriteKind, payload: unknown): void {
	if (quiet) {
		quietWrite(node, kind, payload);
		return;
	}
	const ambientId = ambientBatch;
	let ambient = ambientId === undefined ? undefined : idToBatch.get(ambientId);
	if (ambient === undefined || ambient.state !== 'live') {
		ambient = openBatch({ ambient: true });
		ambientBatch = ambient.id;
	}
	// The post-await dev-warning heuristic lives driver-side only
	// (cosignals-react's currentBatch) — the engine stays lint-free.
	writeInBatch(ambient.id, node, kind, payload);
}

// (endOperation — the compound-operation tail every public exit owes — lives in
// settlement.ts with the operation epilogue; aliased above.)

/**
 * The write path (the embedding/protocol surface: an explicit batch id, or
 * undefined for the context-free arm). Logged steps, in order: classify
 * (caller) → drop check → intern slot → append packed log entry + write
 * clock → member-slot fanout → apply to the kernel with stepwise equality
 * → arena delivery walk → newest-subscription flush after the walk returns.
 */
function writeInBatch(batchId: BatchId | undefined, node: AtomInternals, kind: WriteKind, payload: unknown): void {
	if (evalDepth > 0) throw new ScheduleError('signal write during a world evaluation / render — write from an event handler or effect instead');
	if (inFoldCallback) throw new ScheduleError('signal write inside an updater/reducer fold — updaters and reducers must be pure');
	if (node.kind !== 'atom') throw new ScheduleError('writes target atoms');
	// Public-operation frame — settlements landing anywhere
	// inside (walks, effect bodies, notify callbacks) enqueue and the
	// epilogue drains to empty (the settlement fixed point).
	opDepth++;
	try {
		writeInBatchInner(batchId, node, kind, payload);
	} finally {
		opDepth--;
	}
	runOperationEpilogue();
}

function writeInBatchInner(batchId: BatchId | undefined, node: AtomInternals, kind: WriteKind, payload: unknown): void {
	if (batchId === undefined) {
		bareWrite(node, kind, payload);
		return;
	}
	// Windowed writes hit one batch repeatedly — one compare beats a Map probe.
	let batch: Batch;
	if (batchId === lastBatchId && lastBatchRef !== undefined) {
		batch = lastBatchRef;
	} else {
		batch = getBatchById(batchId);
		lastBatchId = batchId;
		lastBatchRef = batch;
	}
	if (batch.state !== 'live') throw new ScheduleError(`write into retired batch ${batchId} — a retired batch accepts no new writes`);

	const log = node.log;
	// Drop check: a write may be dropped only when every world provably folds
	// this atom to ONE value the op can be compared against — otherwise
	// worlds may fold different previous values and equality proves nothing.
	// Two such states exist: an empty write log (every world sees base), and
	// a fully-retired log below every live render pin (every world sees the
	// whole history — kernel newest, by the eager-apply invariant). The
	// second state is where the reference model's log is EMPTY (it folds
	// retired pin-clear history into base at every boundary; the engine
	// keeps the entries for the episode's wholesale drop), so the acceptance
	// decision must run there exactly as in the empty case.
	if (log.length === 0) {
		if (kind === 0 /* WriteKind.SET */ && node.eqIsDefault) {
			// Fast arm — bench-pinned, do not fold into the general arm
			// (A/B-measured: folding the two write-path fast arms
			// into their isAtomValueEqual general arms cost +11% bare / +3-6%
			// chain3+watch1 per logged write). A plain set with default
			// equality drops on one bare Object.is — no applyOp/isAtomValueEqual
			// call layer on the dominant write shape.
			if (Object.is(payload, node.base)) {
				const tr = trace;
				if (tr !== undefined) tr.writeDropped(node, batchId);
				endOperation();
				return;
			}
		} else {
			const evaluated = applyOp(node, kind, payload, node.base);
			if (isAtomValueEqual(node, node.base, evaluated)) {
				// Policy equality drop — kernel order (current, incoming), once
				// at the acceptance decision.
				const tr = trace;
				if (tr !== undefined) tr.writeDropped(node, batchId);
				endOperation();
				return;
			}
		}
	} else if (log.unretired === 0 && log.maxRetiredSeq <= getMinLivePin()) {
		// Retired-history drop check (the second one-value state). Kernel
		// newest is the value every world folds to; untracked, so a write
		// issued from inside a kernel effect frame records no link.
		const newest = untracked(() => E.readAtom(node.id));
		if (kind === 0 /* WriteKind.SET */ && node.eqIsDefault) {
			if (Object.is(payload, newest)) {
				const tr = trace;
				if (tr !== undefined) tr.writeDropped(node, batchId);
				endOperation();
				return;
			}
		} else {
			const evaluated = applyOp(node, kind, payload, newest);
			if (isAtomValueEqual(node, newest, evaluated)) {
				const tr = trace;
				if (tr !== undefined) tr.writeDropped(node, batchId);
				endOperation();
				return;
			}
		}
	}

	// Intern slot, append log entry, bump the slot write clock.
	const slot = batch.slot !== undefined ? slots[batch.slot]! : internSlot(batch);
	const writeSeq = nextSeq();
	log.push(kind, slot.id, writeSeq, batch.id, payload);
	batch.lastWriteSeq = writeSeq;
	if (node.lastTouchBatch !== batch.id) {
		node.lastTouchBatch = batch.id;
		batch.atomsTouched.push(node);
	}
	// Episode membership rows: the first entry joins the atom to the episode
	// (holds — also its reclamation guard row); growth to the valve threshold
	// files the atom with the fold valve (equality is exact because length
	// grows by one per push, and the valve removes a candidate only while its
	// log is back under the threshold — the invariant on foldCandidates).
	const logLen = log.length;
	if (logLen === 1) episodeHolds.add(node);
	else if (logLen === FOLD_VALVE_THRESHOLD) foldCandidates.add(node);
	slot.writeClock = writeSeq;
	if (roots.size !== 0) {
		// A write into a committed-member slot moves committed truth immediately;
		// the next durable drain must reconcile its cone.
		const bit0 = 1 << slot.id;
		for (const r of roots.values()) {
			if ((r.committedBits & bit0) !== 0) {
				r.committedDirtySlots |= bit0;
				// Committed-truth flip site: committed-member write — fan the
				// one written atom into the member root's arena. Marks only;
				// the effect scan stays at the next boundary.
				const ra = rootToArena.get(r.id);
				if (ra !== undefined) fanAtomsToArena(ra, getSingleAtomBuffer(node), false);
			}
		}
	}
	{
		// One write record per logged write: the logEntry hook carries
		// node/op/batch/slot/seq — the decoder reconstructs the model-shaped
		// 'write' event from this single record.
		const tr = trace;
		if (tr !== undefined) tr.logEntry(node, log.tailEntry());
	}

	// Apply to the kernel eagerly with stepwise equality, so the newest
	// world stays directly readable off the kernel arena. The direct
	// apply's effect flush re-enters the public write path, so writes made
	// by core effects during this apply classify normally (a recursion
	// guard here would silently bypass recording).
	if (kind === 0 /* WriteKind.SET */ && node.eqIsDefault) {
		// Fast arm — bench-pinned, do not fold into the general arm
		// (A/B-measured: folding the two write-path fast arms
		// into their isAtomValueEqual general arms cost +11% bare / +3-6%
		// chain3+watch1 per logged write). A plain set with default
		// equality applies unconditionally: the kernel's own
		// store-compare gates propagation, which beats paying a
		// kernel read + Object.is up front on every EFFECTIVE write.
		writeNewest(node.id, payload);
	} else {
		const prevNewest = E.readAtom(node.id);
		const nextNewest = applyOp(node, kind, payload, prevNewest);
		if (!isAtomValueEqual(node, prevNewest, nextNewest)) {
			// Equality order: (current, incoming) — the eager-advance site.
			writeNewest(node.id, nextNewest);
		}
	}

	// The value-blind delivery walk (arena strong links), synchronously in
	// the writer's stack. (Core effect()s are kernel subscribers: the
	// eager kernel apply above already flushed them.)
	deliveryWalk(node, batch, slot, writeSeq);
	endOperation();
}

/**
 * Trace seam for core `effect()` runs. Core effects are real kernel
 * effects (tests/helpers.ts `mountEngineCoreEffect` over the public
 * `effect()`), flushed by the eager kernel apply itself — the engine
 * holds no record of them. Their wrappers report each value-gated run
 * here so core-effect-run records land in the one packed stream with
 * its causality register. Sibling firing order under one operation is
 * implementation-defined (kernel subscriber-link order); values and the
 * operation each run fires at are the contract.
 */
export function logCoreEffectRun(name: string, value: Value): void {
	const tr = trace;
	if (tr !== undefined) tr.coreEffectRun(name, value);
}

// ------------------------------------------- episodes and quiescence

/** Synchronously abandons every work-in-progress render. */
export function discardAllWip(): void {
	for (const p of [...rootToOpenRender.values()]) {
		renderEnd(p.id, 'discard');
	}
}

export function quiescent(): boolean {
	return liveBatchCount === 0 && rootToOpenRender.size === 0;
}

/**
 * Quiescence (no live batches, no live pins, no parked actions): the epoch
 * bumps and the arenas persist — their links are current structure, not an
 * episode log, so the routing coverage committed observers rely
 * on survives by persistence (nothing re-records because nothing
 * was lost). The episode's own records are ALREADY gone: the episode close
 * (WriteLog.ts maybeCloseEpisode) ran inside the retirement or render close
 * that reached quiescence, dropping write records and retired batch
 * records wholesale — this operation is the public epoch/bookkeeping reset
 * over what remains. Two arena duties run, in order: the zero-consumer
 * reclamation sweep, then the read-clock renumber over the survivors
 * only.
 *
 * ## Why sequences are never renumbered
 *
 * Retained
 * sequence values (baseSeq, retirement stamps, committedAdvance, watcher snapshot
 * pins) are not rewritten at quiescence: sequences are plain JS numbers,
 * exact for integers to 2^53, they are only ever compared (<, <=, max —
 * never bit-twiddled), and every storage site is a scalar field or a
 * plain number array, so the engine stays correct until 2^53 creates —
 * about 28 years at a sustained 10M writes/sec. Renumbering was
 * A/B-measured: forcing every seq past SMI range (2^35) on
 * log-heavy shapes moved fold/write throughput by ~1% — within noise —
 * so no renumbering machinery exists. One
 * diagnostics caveat: `cosignals/trace` packs seqs into Int32 records,
 * so trace decode fidelity (not engine correctness) degrades past
 * 2^31-1 created sequences.
 */
export function quiesce(): void {
	if (!quiescent()) throw new ScheduleError('quiescence requires no live batches, pins, or parked actions');
	// Residue check: quiescent ⇒ the episode close already ran (it fires
	// inside the transition that emptied the batch/render tables) — so the
	// episode membership (exactly the atoms with a non-empty write log,
	// maintained at append and drop) must be empty.
	for (const n of episodeHolds) {
		throw new InvariantViolation(`quiescence residue: atom ${n.name} still holds ${n.log.length} log entries`);
	}
	epoch++;
	// (Episode records — write logs, retired batch records — dropped at the
	// episode close; ended render records drop at each render end. No
	// newest-side reset either: kernel caches persist — nothing
	// newest-visible changes at quiescence. Serial counters stay monotone.)
	// Arena duties, in order: reclamation sweep, then the
	// read-clock renumber over surviving consumer-populated arenas.
	arenaQuiesceSweep();
	// Dead-episode bookkeeping zeroes (bulk-zero at episode reset).
	for (const s of slots) {
		s.writeClock = 0;
		s.claimSeq = 0;
		s.releasePending = false;
	}
	for (const w of watchers.values()) w.dedupBits = 0;
	{
		const tr = trace;
		if (tr !== undefined) tr.epochReset(epoch);
	}
	recomputeQuiet(); // quiescent by definition; re-derive from the new episode's state
	endOperation();
	runOperationEpilogue();
}

// ------------------------------------------------------------ world reads

/** The value of a node in a named world (adapter/test surface). */
function readWorldValue(node: AnyInternals, world: World): Value {
	return evaluate(node, world);
}

export function committedValue(node: AnyInternals, root: RootId): Value {
	return evaluate(node, { kind: 'committed', root });
}

export function newestValue(node: AnyInternals): Value {
	return evaluate(node, NEWEST);
}

export function renderValue(node: AnyInternals, render: RenderPass): Value {
	return evaluate(node, { kind: 'render', render });
}

// ------------------------------------------------- the engine reset (test-only)

/**
 * Idle preconditions for `__resetEngineForTest`: a reset from inside any
 * open frame or half-finished operation must fail the running test loudly, not
 * corrupt the next one. Asserted, in order: quiescent (no live batches —
 * parked actions included — and no open renders); no public operation, no
 * evaluation frame, no fold callback on the stack; no open capture frame;
 * no arena evaluation frame (serve override / sink); no notify flush or
 * settlement drain in progress; kernel frames closed (enterDepth) and the
 * kernel's synchronous batch()/effect queue empty.
 */
function assertIdleForReset(): void {
	if (!quiescent()) throw new ScheduleError('__resetEngineForTest requires quiescence: no live batches (parked actions included) and no open renders');
	if (opDepth !== 0) throw new ScheduleError('__resetEngineForTest inside a public operation (opDepth !== 0)');
	if (evalDepth !== 0) throw new ScheduleError('__resetEngineForTest inside a world evaluation (evalDepth !== 0)');
	if (inFoldCallback) throw new ScheduleError('__resetEngineForTest inside an updater/reducer/equality callback');
	if (captureFrame !== undefined) throw new ScheduleError('__resetEngineForTest inside an open capture frame');
	if (serveOverride !== undefined) throw new ScheduleError('__resetEngineForTest inside an arena evaluation frame');
	if (currentSink !== 0) throw new ScheduleError('__resetEngineForTest inside a fold-through evaluation frame');
	if (suspendDepth !== 0) throw new ScheduleError('__resetEngineForTest inside a hook-initiated (suspending) evaluation');
	if (notifyState.flushing) throw new ScheduleError('__resetEngineForTest inside a notification flush');
	if (notifyState.n !== 0) throw new ScheduleError('__resetEngineForTest with queued notifications undelivered');
	// (A settlement drain in progress holds opDepth > 0 — covered above.
	// Queued-but-undrained settlements are legal: the queue dies with the
	// composition and the scheduled microtask is engine-epoch guarded.)
}

/**
 * The engine reset (test-only) — the fresh-engine
 * analog for suites that need one engine per test. Order:
 *
 *  1. assertIdle (above) — preconditions, loudly.
 *  2. the driver's protocol reset first (protocol v2's hook): the host's
 *     lane registry drops its full slot tenancy before the engine the ids
 *     point into disappears; then the driver slot clears.
 *  3. the kernel scrub (CosignalEngine.ts __resetKernelForTest): watermark-bounded
 *     memory scrub — never a reallocation — allocator heads, counters,
 *     queued/pendingFree, VALUES/FNS side columns, walk scratch,
 *     desiredRecords; bumps the engine epoch (all cross-reset microtasks —
 *     settle drain, lifecycle flush, thenable settle-invalidate/rethrow —
 *     are epoch-guarded and go inert).
 *  4. the policy scrub (index.ts): configure() state, the lifecycle map,
 *     queue, and its scheduled flush.
 *  5. the suspense scrub: the id-keyed ctx.use request caches.
 *  6. probes to zero (the zero-cost test re-baselines per test).
 *  7. `composeEngine(options)` — every mechanism factory re-runs;
 *     trace detaches (the fresh core's slot is undefined), checker state
 *     disarms, devChecks/arenaInitInts land as reset parameters, and the
 *     driver slot is empty (attach again after the reset).
 *
 * BatchIds stay monotonic across resets (Batch.ts's module-level counter
 * survives the recomposition): a host lane table can legally hold an id
 * across a reset, and monotonicity guarantees a stale id can never collide
 * with a post-reset batch.
 */
export function __resetEngineForTest(options?: EngineResetOptions): void {
	assertIdleForReset();
	const d = driver;
	if (d !== undefined && d.protocolReset !== undefined) d.protocolReset();
	__resetKernelForTest(); // bumps the engine epoch; scrubs kernel state
	__resetPolicyForTest();
	__resetSuspenseForTest();
	probes.logEntries = 0;
	probes.batches = 0;
	probes.worldEvals = 0;
	probes.bridges = 0;
	composeEngine(options);
}

// ---------------------------------------------------- the engine surface

/**
 * The engine surface — the module's operational API grouped as one record
 * (the kernel's own op-table pattern): every function field is the module
 * function above, every accessor reads the current composition's state, so
 * the record stays valid across `__resetEngineForTest`. The test
 * harnesses, the diagnostics tooling, and the React bindings all drive this
 * one object; nothing constructs engines.
 */
export const engine = {
	// creation + resolution
	atom,
	computed,
	internalsForAtom,
	internalsForComputed,
	disposeComputed,
	internalsById,
	root,
	// batches + writes
	openBatch,
	liveBatches,
	write: writeInBatch,
	bareWrite,
	quietWrite,
	retire,
	settleAction,
	// renders + watchers
	renderStart,
	renderYield,
	renderResume,
	renderEnd,
	mountWatcher,
	renderWatcher,
	deferMountEffects,
	adoptRevealedMount,
	removeWatcher,
	commitBatches,
	dependencyClosureOf,
	// subscriptions
	mountCommittedObserver,
	captureRun,
	captureRead,
	removeSubscription,
	replayReactEffect,
	// episodes + reads
	discardAllWip,
	quiescent,
	quiesce,
	read: readWorldValue,
	committedValue,
	newestValue,
	renderValue,
	evaluate,
	foldAtom,
	logCoreEffectRun,
	// test seams
	__coreProbes,
	__checkerInternals,
	__arenaForTest,
	__arenaPoolForTest,
	__bumpNodeGenForTest,
	__arenaStats,
	__arenaLinkMode,
	__arenaLinkIdForTest,
	__arenaLinkNextDepForTest,
	__setSettleCapForTest: setSettleCap,
	__columnsForTest,
	/** @internal bytecode-smoke seams (the smoke must exercise budgeted arena
	 * walk families directly; production never calls these). */
	__eachArenaForTest: eachArena,
	__fanAtomsToArenaForTest: fanAtomsToArena,
	__arenaServeForTest: arenaServe,
	// state (current composition; identity changes at reset)
	/** Diagnostics/test view of the internals registry as id → internals,
	 * materialized per access from the dense column (the engine maintains no
	 * id-keyed map — nodeIndex keying is the one registry; graphviz and the
	 * suites want id-keyed iteration). Cold by construction. */
	get idToInternals(): Map<NodeId, AnyInternals> {
		const out = new Map<NodeId, AnyInternals>();
		for (const n of nodeIndexToInternals) {
			if (n !== undefined) out.set(n.id, n);
		}
		return out;
	},
	get idToBatch(): Map<BatchId, Batch> {
		return idToBatch;
	},
	get slots(): BatchSlotMeta[] {
		return slots;
	},
	get idToRenderPass(): Map<RenderPassId, RenderPass> {
		return idToRenderPass;
	},
	get roots(): Map<RootId, RootState> {
		return roots;
	},
	get watchers(): Map<WatcherId, Watcher> {
		return watchers;
	},
	get idToSubscription(): Map<SubscriptionId, Subscription> {
		return idToSubscription;
	},
	get seq(): Seq {
		return seq;
	},
	get committedAdvance(): Seq {
		return committedAdvance;
	},
	get epoch(): Epoch {
		return epoch;
	},
	get quiet(): boolean {
		return quiet;
	},
	get devChecks(): boolean {
		return devChecks;
	},
	get ambientBatch(): BatchId | undefined {
		return ambientBatch;
	},
	get inFoldCallback(): boolean {
		return inFoldCallback;
	},
	get activeWorld(): World | undefined {
		return activeWorld;
	},
	set activeWorld(w: World | undefined) {
		setWorld(w);
	},
	get suspendDepth(): number {
		return suspendDepth;
	},
	set suspendDepth(n: number) {
		suspendDepth = n;
	},
	/** The trace recorder slot (attachTracer/Tracer.stop assign it). */
	get trace(): TraceHooks | undefined {
		return trace;
	},
	set trace(hooks: TraceHooks | undefined) {
		trace = hooks;
	},
	/** Optional log-entry drop observer (test/diagnostics seam — see the
	 * module-state declaration). */
	get onLogEntryDrop(): ((atom: AtomInternals, entry: WriteLogEntry) => void) | undefined {
		return onLogEntryDrop;
	},
	set onLogEntryDrop(fn: ((atom: AtomInternals, entry: WriteLogEntry) => void) | undefined) {
		onLogEntryDrop = fn;
	},
	// direct listeners (the bindings' consumption surface — attachDriver
	// assigns them too; these accessors are the test/diagnostics face)
	get onDelivery(): ((w: Watcher, batch: Batch, slot: BatchSlot) => void) | undefined {
		return onDelivery;
	},
	set onDelivery(fn: ((w: Watcher, batch: Batch, slot: BatchSlot) => void) | undefined) {
		onDelivery = fn;
	},
	get onMountCorrective(): ((w: Watcher, batch: Batch, slot: BatchSlot) => void) | undefined {
		return onMountCorrective;
	},
	set onMountCorrective(fn: ((w: Watcher, batch: Batch, slot: BatchSlot) => void) | undefined) {
		onMountCorrective = fn;
	},
	get onCorrection(): ((w: Watcher) => void) | undefined {
		return onCorrection;
	},
	set onCorrection(fn: ((w: Watcher) => void) | undefined) {
		onCorrection = fn;
	},
	/** Diagnostics surface — the recorded dependency edges as dep →
	 * dependents (the union of every live arena's links; read by graphviz
	 * and the test suites). */
	get dependencyEdges(): Map<NodeId, Set<NodeId>> {
		return dependencyEdges();
	},
	/** Stale-watcher loud skips (the dormant-watcher aliasing pin). @internal */
	get __staleWatcherSkips(): number {
		return staleWatcherSkips;
	},
};

/** The engine surface's type (the diagnostics tooling's parameter shape). */
export type CosignalEngine = typeof engine;

// One Core: this module is internal machinery of the single `cosignals`
// entry (src/index.ts imports and re-exports it). It adds `attachDriver`,
// the engine surface, and the engine-surface types to the base API.

// ---- composition ---------------------------------------------------------------------
// The one central entrypoint that connects the sections: `composeEngine`
// initializes every section's module state in one place — nothing else in
// this module wires sections together (cross-section calls are direct
// same-module calls; the runtime attachment seams — attachDriver, the
// trace slot, the checker hooks — each have one documented owner). Runs at
// module initialization (the call is the last statement in this file) and
// at each `__resetEngineForTest`.

/** The quiet derivation — quiet ⇔ zero live batches and zero open renders
 * and no episode write records held (the episode close empties
 * `episodeHolds` at exactly the transition the first two clauses detect,
 * so the third is a belt matching the reference model's derivation shape).
 * Recomputed only at pipeline transitions (batch open/retire, render
 * start/end, driver attach); the booleans the write path branches on stay
 * module state (`quiet` here, `standaloneQuiet` in index.ts — the public
 * write path's one fast-arm check). */
function recomputeQuiet(): void {
	setQuiet(liveBatchCount === 0 && rootToOpenRender.size === 0 && episodeHolds.size === 0);
}

/** The quiet flags' one writer: `quiet` (this module's classified-write
 * branch) and index.ts's `standaloneQuiet` (quiet AND driver-less — the
 * public fast arm) move together, through index.ts's store-only-on-change
 * setter. */
function setQuiet(q: boolean): void {
	quiet = q;
	__setStandaloneQuiet(q && driver === undefined);
}

/** Committed-advance bump: one fresh sequence point per committed-truth
 * motion (per-root commits; retirements that changed history — the quiet
 * fold inlines the same pair). */
function advanceCommitted(): void {
	committedAdvance = nextSeq();
}

/** Kernel-frame tracked reader (engine-created computeds' newest runs):
 * the shared kernel read plus the pre-dedup observation capture. */
const kernelTrackedReader: Reader = (dep) => {
	const oc = obsCapture;
	if (oc !== undefined) oc.push(dep);
	return readKernelValue(dep);
};

/**
 * The composition: assign every section's module state fresh. Reading
 * order mirrors the sections. Deliberate survivors (NOT reset here): the
 * kernel arena and its counters (`__resetKernelForTest` owns that scrub —
 * the engine reset runs it first), the batch-id counter (host lane tables
 * legally hold ids across a reset; monotonicity keeps stale ids from
 * colliding), the reclamation queues (epoch-defused by the kernel scrub),
 * and the engine-activity probes (the reset re-baselines them itself).
 */
function composeEngine(options?: EngineResetOptions): void {
	probes.bridges++; // engine-activity counter: counts compositions (module init + resets; tests/one-core.spec.ts)
	// section 7 — registries, dense columns, clocks, listeners, shared state
	idToRenderPass = new Map();
	roots = new Map();
	watchers = new Map();
	rootToOpenRender = new Map();
	nodeIndexToInternals = [undefined];
	lastWalk = [0];
	nodeToWatchers = [undefined];
	evalMark = [0];
	seq = 0;
	committedAdvance = 0;
	epoch = 0;
	devChecks = options?.devChecks ?? false;
	arenaInitInts = options?.arenaInitInts ?? WORLD_ARENA_INIT_INTS;
	onLogEntryDrop = undefined;
	driver = undefined;
	trace = undefined;
	activeWorld = undefined;
	currentSink = 0;
	obsCapture = undefined;
	evalDepth = 0;
	inFoldCallback = false;
	captureFrame = undefined;
	suspendDepth = 0;
	serveOverride = undefined;
	suspendedCount = 0;
	epilogueCheck = undefined;
	opDepth = 0;
	committingRender = undefined;
	walkGen = 0;
	committedSubCount = 0;
	onDelivery = undefined;
	onMountCorrective = undefined;
	onCorrection = undefined;
	// section 8 — the observation index's columns
	obsRefs = [0];
	obsDeps = [undefined];
	// section 9 — episode membership
	episodeHolds = new Set();
	foldCandidates = new Set();
	// section 10 — batches (nextBatchId deliberately survives)
	idToBatch = new Map();
	slots = [];
	for (let i = 0; i < SLOT_COUNT; i++) {
		slots.push({ id: i, tenant: undefined, claimSeq: 0, writeClock: 0, releasePending: false });
	}
	liveBatchCount = 0;
	ambientBatch = undefined;
	// section 11 — worlds
	evalGen = 0;
	worldProvider = undefined;
	routedCap = undefined;
	// section 12 — world arenas
	rootToArena = new Map();
	arenaPool = [];
	restaled = new Map();
	arenaFrame = undefined;
	arenaFrameShadow = 0;
	arenaFrameCycle = 0;
	oneAtom.length = 0;
	walkStack.length = 0;
	// section 13 — the notification queue (reused columns clear; the reset's
	// idle preconditions already guarantee the queue is empty)
	notifyState.n = 0;
	notifyState.flushing = false;
	notifyKinds.length = 0;
	notifyWs.length = 0;
	notifyBatches.length = 0;
	notifySlots.length = 0;
	notifySubs.length = 0;
	walkWatchers.length = 0;
	drainWatcherBuf.length = 0;
	// section 14 — settlement
	pendingSettle = [];
	pendingSettleSet.clear();
	settleDraining = false;
	settleDrainScheduled = false;
	settleCap = 10_000;
	// sections 16-17 — observers + render integration
	idToSubscription = new Map();
	nextSubscriptionId = 1;
	nextRenderPassId = 1;
	nextWatcher = 1;
	staleWatcherSkips = 0;
	// section 18 — the write path's last-batch cache
	lastBatchId = 0;
	lastBatchRef = undefined;
	// arm the derived flags from the fresh (empty) state
	syncReadRouting();
	recomputeQuiet();
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
	if (
		memory[id + NodeField.SUBS] !== 0
		|| (lifecycleStates.size !== 0 && lifecycleStates.has(id))
		|| reclaimGuards(id, memory[id + NodeField.NODE_INDEX])
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

// ---- the test reset's kernel half (test-only) -----------------------------------

/**
 * Kernel idle preconditions for `__resetEngineForTest` — a reset from inside
 * any live kernel frame would corrupt the next test instead of failing this
 * one. @internal
 */
function __assertKernelIdleForReset(): void {
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

// ---- the composition call ----------------------------------------------------------
// Module initialization composes the one engine (always-concurrent; the
// test-only engine reset re-runs composeEngine after the kernel and policy
// scrubs). Last statement in the file: every section's state declarations
// above have initialized by the time it runs.
composeEngine();
