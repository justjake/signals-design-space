/**
 * cosignal — THE KERNEL (graph.ts): the dependency-tracking engine. It
 * stores every signal, computed, effect, and dependency edge as a
 * fixed-size integer record in shared arrays, and runs the reactive
 * algorithm — writes push staleness marks down the graph, reads lazily pull
 * recomputation — as index arithmetic over those records. The kernel knows
 * nothing about user options: it compares values by reference identity only,
 * has no error handling of its own, and no async story. The policy layer
 * around it — the Atom/ReducerAtom/Computed classes, effect(), configure(),
 * custom equality, error/suspension boxes — lives in index.ts (the package
 * entry, whose header carries the whole-package vocabulary and reading
 * order); the exception/suspension machinery the kernel's two cold catch
 * sites call into (storeThrown, boxedRead) lives in suspense.ts; the
 * observed-lifecycle option's state lives in lifecycle.ts.
 *
 * Storage terms (defined in full in index.ts's header): THE ARENA is the one
 * shared Int32Array (`memory` in createEngine) holding every RECORD
 * (RecordGeom.STRIDE consecutive Int32 slots; node and link records share
 * the arena, the stride, and one allocator); record ids are PREMULTIPLIED
 * (id = record ordinal × STRIDE) so every field access is plain addition;
 * JavaScript values live in the SIDE COLUMNS `values`/`fns`, indexed by
 * shifting the same premultiplied id.
 *
 * Mechanics this module owns:
 * - OPERATION BOUNDARY: a moment when no evaluation, effect run, or graph
 *   walk is anywhere on the call stack (`enterDepth === 0`). Deferred work —
 *   growing the arena, freeing disposed records — runs only at boundaries,
 *   because in-flight work holds direct references to the buffers.
 * - CLOSURE REBUILD: the kernel's functions are created by one factory
 *   (`createEngine`) and capture the arena as a closure constant — which is
 *   what lets V8 fold the buffer reference into compiled code. To grow, the
 *   module allocates a doubled arena, copies the records over, and calls the
 *   factory again; the module-level binding `E` (THE one mutable table slot)
 *   is re-linked at an operation boundary, and every consumer — this module
 *   and the policy layer alike — reads the current slot per call, never a
 *   captured stale table. GROWTH RE-RUNS THIS FACTORY ONLY: scalar counters
 *   live at module level (not in the closure) precisely so a rebuilt engine
 *   resumes where the old one stopped, and no other mechanism's state is
 *   touched by a rebuild.
 * - The FOLD-PURITY table (POISON): index.ts's runFold swaps `E` to it for
 *   the duration of an updater/reducer callback (through the fold-guard
 *   swap pair exported below), so every read/write the fold attempts throws
 *   at the dispatch site — and the hot read/write paths carry zero fold
 *   instructions.
 *
 * The kernel is alien-signals v3.2.1's push-pull algorithm, re-expressed
 * over arena records instead of linked JavaScript objects. Upstream's walk
 * structure and flag transitions are preserved (plus the hot/slow splits
 * documented at each site); walks use persistent scratch stacks; capacity
 * grows by closure rebuild over doubled buffers at operation boundaries.
 * Validated against a 179-case conformance suite for alien-signals-
 * compatible semantics. Deviations from a plain transliteration of upstream
 * are enumerated in index.ts's header (D1–D7) and marked at each site here.
 *
 * SPEED IDENTITY (do not casually restructure): closure-captured `memory`
 * inside a rebuilt op table whose unique hidden class V8 constant-folds;
 * same-file const enums on every hot path (exported copies inline as
 * literals under whole-program tsc emit and esbuild bundling; per-file
 * transforms fall back to enum-object reads only at cold-to-warm consumer
 * sites, never in the kernel's own walks); the V8 hot/slow split families
 * (link/linkInsert, checkDirty/chainCheck/checkDirtyLoop,
 * computedRead/computedReadSlow) pinned by the bytecode budget suite.
 */

import { CycleError } from './index.js';
import { lifecycleUnwatched, lifecycleWatched } from './lifecycle.js';
import { boxedRead, ctxPrevious, ctxUse, storeThrown } from './suspense.js';
import type { ComputedCtx, UseKey } from './index.js';

/**
 * The ONE evaluation context, passed by the kernel to every computed getter
 * as its argument (D3). Its members delegate to hoisted policy functions
 * (suspense.ts ctxPrevious/ctxUse) that resolve the evaluating node from
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

/** Premultiplied node record id: the Int32 arena index of the record's field 0
 * (id = record ordinal × RecordGeom.STRIDE). 0 = "none" (record 0 is burned). */
export type NodeId = number;
/** Premultiplied link record id (links share the arena and stride with nodes). 0 = "none". */
export type LinkId = number;
/** A premultiplied record id of either kind (the shared bump pointer / allocators). */
export type RecordId = number;
/** A node's FLAGS field value: a bitwise OR of NodeFlag members. */
export type NodeFlags = number;
/** The global evaluation cycle counter, stamped into link VERSION fields on re-track. */
export type Version = number;
/** A node's GEN field value: bumped on free so disposers can defuse stale ids. */
export type Generation = number;
/** A count of fixed-stride records (nodes and links draw from one shared pool). */
export type RecordCount = number;
/** Index into the `values` side column (two slots per record; see RecordGeom). */
export type ValueIndex = number;

// ---- record layout + flags as const enums ---------------------------------------
// Const enums (not module-level `const`s) so every consumer toolchain inlines
// the values as literals. Rationale: esbuild BUNDLING demotes module-scope
// `const` to mutable `var` (lazy-init/scope-merge hoisting), which costs
// TurboFan its constant-folding of these hot numbers — measured +15-21% on
// benchmark workloads when bundled. Same-file const enum members are inlined
// as numeric literals by esbuild (transform AND bundle modes), tsx, vitest,
// and tsc alike, so the codegen no longer depends on how the library is
// packaged. The DECLARATIONS stay in this file — the kernel owns its record
// layout — and the enums other modules walk kernel records with (NodeField,
// LinkField, NodeFlag) are EXPORTED so those consumers import the one
// definition instead of hand-copying numbers a kernel field reorder would
// silently orphan. Same-file member accesses still inline as literals under
// every toolchain; a cross-file access inlines under whole-program tsc emit
// and esbuild bundling, and becomes a property read of the emitted enum
// object under per-file transforms (tsx, vitest) — acceptable on the
// bridge's cold-to-warm kernel walks, never in the kernel's own hot paths
// (which are all same-file by construction). RecordGeom (geometry) is
// exported for the policy layer's side-column addressing (index.ts,
// suspense.ts) — cold-to-warm sites under the same rule.

/** Field offsets within a NODE record (memory arena, stride 8; ids are
 * pre-multiplied: id = record ordinal * 8). */
export const enum NodeField {
	FLAGS = 0,
	DEPS = 1, // doubles as the free-list next pointer for freed records
	DEPS_TAIL = 2,
	SUBS = 3,
	SUBS_TAIL = 4,
	GEN = 5, // bumped on free; disposers capture it to defuse stale ids
	LIFECYCLE = 6, // D1: 1 iff the node is an atom with an observed-lifecycle effect
	/** The record's NODE INDEX: a dense per-node ordinal (never an identity)
	 * assigned once when a slot first hosts a node and INHERITED by every
	 * later tenant of the slot (the node free list threads through DEPS, so
	 * freeNode leaves this field untouched). Consumers key dense per-node
	 * side tables by it: node and link records share one allocator, so
	 * record-ID-keyed tables would go holey where index-keyed ones stay
	 * packed. Node records only — link records use field 7 as FREE_NEXT
	 * (the two record kinds already interpret fields differently). */
	NODE_INDEX = 7,
}

/** Field offsets within a LINK record (link records share the arena, stride,
 * and premultiplied ids with node records). */
export const enum LinkField {
	VERSION = 0,
	DEP = 1,
	SUB = 2,
	PREV_SUB = 3,
	NEXT_SUB = 4,
	PREV_DEP = 5,
	NEXT_DEP = 6,
	// The free list threads through the SPARE field so a freed link keeps
	// every real field intact: upstream's walks deliberately read stale
	// nextDep/nextSub off links unlinked earlier in the same walk
	// (conformance #203 exercises this; tests/freelist.spec.ts pins it with
	// a primed free list), and those stale pointers must name former
	// neighbors — never the free list.
	FREE_NEXT = 7,
}

/** Bit values of a node's FLAGS field (upstream ReactiveFlags + HasChildEffect
 * + kind bits). A flags word is an OR of these (see `type NodeFlags`). */
export const enum NodeFlag {
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
	/** S-C: the record is a HOST-owned computed (a bridge computed riding
	 * this kernel record). Its dep links do NOT feed the D1 observed-
	 * lifecycle union — the host's own observation index is its arm (one
	 * retain per strong dep of an OBSERVED computed, re-pointed per run) —
	 * so a host computed's newest structure never pins an atom's remote
	 * subscription past the host's last consumer. Set via the
	 * __hostMarkComputedOwned seam at registration/adoption. */
	HOST_OWNED = 8192,
}

/** Record geometry: the strides, shifts, and offsets that address a record's
 * fields and its side-column slots from its premultiplied id. */
export const enum RecordGeom {
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
	/** length >> HALF_ARENA_SHIFT: half the arena — the "keep at least half
	 * the arena free" watermark term. */
	HALF_ARENA_SHIFT = 1,
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
let recNext: RecordId = RecordGeom.STRIDE; // bump pointer, shared by nodes and links (record 0 burned)
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
export let enterDepth = 0; // live engine frames that captured memory; 0 = op boundary (exported read-only: the engine reset's idle precondition)

/**
 * READ ROUTING, armed: true while the concurrent engine has a routing
 * context that could answer a public read — an evaluation world on stack, an
 * open capture frame, or an attached driver's ambient-world provider. The
 * public `.state` getters (index.ts) test this ONE module boolean (beside
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
 * THE ENGINE EPOCH (great-refactor R-6): bumped once per
 * `__resetEngineForTest`, never in production. Every cross-reset microtask
 * (settle drain, lifecycle flush, thenable settle-invalidate, unhandled
 * rethrow) captures the epoch at schedule time and no-ops if it moved — a
 * microtask scheduled by a dead test must never touch the next test's
 * engine. Reclamation (plans/2026-07-07-signal-reclamation.md) consumes the
 * same counter for its per-epoch registry.
 */
export let engineEpoch = 0;

const queued: NodeId[] = [];
const pendingFree: NodeId[] = []; // disposed effect/scope records awaiting the sweep (batch-freed at the next operation boundary)

// Side columns, indexed off the id: values[id >> 2] = current/computed value,
// values[(id >> 2) + 1] = signal pending value OR effect cleanup fn OR the
// computed's owning Computed instance (D4), fns[id >> 3] = computed getter /
// effect fn. Plain arrays grown by push (stays PACKED; plain-array growth has
// no binding problem). The policy layer reads these columns directly — they
// are shared state like the scalar heads, not operations.
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

// ---- the engine (the operation table) -----------------------------------------

export interface Engine {
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
	/** S-C: dispose a computed record (deps unlinked, subs detached, free deferred). */
	disposeComputed(c: NodeId): void;
	/** S-C: flag a computed HOST_OWNED and retro-release the lifecycle refs
	 * its EXISTING dep links contributed (future links are excluded at the
	 * gate; future unlinks see the flag and skip the -1 — balanced). */
	markHostOwned(c: NodeId): void;
	/** D1: flags the node for observed-lifecycle delivery. */
	markLifecycle(id: NodeId): void;
	/** True iff the currently-evaluating subscriber is a computed. */
	activeIsComputed(): boolean;
}

function createEngine(records: RecordCount, carry?: Int32Array): Engine {
	const memory = new Int32Array(records * RecordGeom.STRIDE);
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
	// Allocators flag growth once the bump pointer (the never-yet-used end of
	// the arena; allocation takes a freed record first, else bumps this) crosses
	// the watermark — the fill level that schedules growth. The rule: keep at
	// least RecordGeom.REC_SLACK records AND half the arena free at every boundary.
	const watermark = Math.min(memory.length >> RecordGeom.HALF_ARENA_SHIFT, memory.length - RecordGeom.REC_SLACK * RecordGeom.STRIDE);
	if (recNext > watermark) {
		growPending = true;
	}

	return {
		records,
		buffer: () => memory,
		newSignal,
		newComputed,
		newEffect,
		newScope,
		gen: (id) => memory[id + NodeField.GEN],
		read,
		write,
		computedRead,
		run,
		requeueAbort,
		dispose,
		sweepPendingFree,
		invalidateComputed,
		disposeComputed: disposeComputedOp,
		markHostOwned: markHostOwnedOp,
		markLifecycle: (id) => {
			memory[id + NodeField.LIFECYCLE] = 1;
		},
		activeIsComputed: () => activeSub !== 0 && (memory[activeSub + NodeField.FLAGS] & NodeFlag.K_COMPUTED) !== 0,
	};

	// ---- allocation ----------------------------------------------------------

	function allocNode(flags: NodeFlags): NodeId {
		let id: NodeId;
		if (nodeFreeHead !== 0) {
			// Reused slot: it KEEPS its NODE_INDEX (freeNode never touches
			// field 7) — the new tenant inherits the slot's index, which is
			// what bounds index-keyed side tables by peak node count.
			id = nodeFreeHead;
			nodeFreeHead = memory[id + NodeField.DEPS];
			memory[id + NodeField.DEPS] = 0;
		} else {
			id = recNext;
			if (id >= memory.length) {
				throw new Error('cosignal: arena exhausted mid-operation; raise COSIGNAL_INITIAL_RECORDS');
			}
			recNext = id + RecordGeom.STRIDE;
			if (recNext > watermark) {
				growPending = true;
			}
			memory[id + NodeField.NODE_INDEX] = nextNodeIndex++; // a never-yet-node slot gets a fresh index
		}
		memory[id + NodeField.FLAGS] = flags;
		const v: ValueIndex = id >> RecordGeom.ID_TO_VALUE_SHIFT;
		while (vals.length <= v + RecordGeom.AUX_VALUE_OFFSET) {
			vals.push(undefined);
		}
		while (fnTab.length <= id >> RecordGeom.ID_TO_FN_SHIFT) {
			fnTab.push(undefined);
		}
		return id;
	}

	function freeNode(id: NodeId): void {
		memory[id + NodeField.FLAGS] = 0;
		memory[id + NodeField.DEPS_TAIL] = 0;
		memory[id + NodeField.SUBS] = 0;
		memory[id + NodeField.SUBS_TAIL] = 0;
		memory[id + NodeField.LIFECYCLE] = 0; // D1
		++memory[id + NodeField.GEN];
		const v: ValueIndex = id >> RecordGeom.ID_TO_VALUE_SHIFT;
		vals[v] = undefined;
		vals[v + RecordGeom.AUX_VALUE_OFFSET] = undefined;
		fnTab[id >> RecordGeom.ID_TO_FN_SHIFT] = undefined;
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
			linkFreeHead = memory[id + LinkField.FREE_NEXT];
		} else {
			id = recNext;
			if (id >= memory.length) {
				throw new Error('cosignal: arena exhausted mid-operation; raise COSIGNAL_INITIAL_RECORDS');
			}
			recNext = id + RecordGeom.STRIDE;
			if (recNext > watermark) {
				growPending = true;
			}
		}
		return id;
	}

	function freeLink(id: LinkId): void {
		memory[id + LinkField.FREE_NEXT] = linkFreeHead;
		linkFreeHead = id;
	}

	// ---- system.ts transliteration -------------------------------------------
	// TWINNING OBLIGATION: the world arenas in concurrent.ts re-state these
	// walks over their own layout (arenaLink/arenaUnlink/arenaPropagate/arenaShallowPropagate/
	// arenaIsValidLink/arenaCheckDirty*, deliberately — see the header there). Any
	// semantic change to {link, linkInsert, unlink, propagate, checkDirty*,
	// chainCheck, shallowPropagate, isValidLink, purgeDeps} must be re-derived
	// in the `arena`-prefixed twin (and vice versa); the twins diverge for real,
	// argued reasons (weak-subs second list, VALID/BOX bits, guard counters),
	// so port the RULE, not the text. Drift here has already produced a real
	// bug caught only by fuzz seed 40 (arenaUpdateAndShallow's comment).

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

	// Insertion tail of link(): kept out of line so the steady-state re-track
	// fast path above stays under V8's inlining bytecode budget (upstream
	// monolithic link() was 475 bytecodes — kExceedsBytecodeLimit — and never
	// inlined into the read paths despite running on every tracked read).
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
		// D1 (per-LINK since S-C — the kernel arm is a refcount, not a bit,
		// so host-owned subscribers can be excluded without losing later
		// non-host ones): every NEW link to a lifecycle-flagged dep shifts
		// the union +1, unless the subscriber is a HOST-owned computed (the
		// host's own observation index is its arm). Balanced by unlink's -1.
		if (memory[dep + NodeField.LIFECYCLE] !== 0 && !(memory[sub + NodeField.FLAGS] & NodeFlag.HOST_OWNED)) {
			lifecycleWatched(dep);
		}
	}

	function unlink(id: LinkId, sub: NodeId = memory[id + LinkField.SUB]): LinkId {
		const dep = memory[id + LinkField.DEP];
		const prevDep = memory[id + LinkField.PREV_DEP];
		const nextDep = memory[id + LinkField.NEXT_DEP];
		const nextSub = memory[id + LinkField.NEXT_SUB];
		const prevSub = memory[id + LinkField.PREV_SUB];
		// D1's balancing -1 (per-link; see linkInsert): lifecycle-flagged
		// deps release one union ref per removed non-host link.
		if (memory[dep + NodeField.LIFECYCLE] !== 0 && !(memory[sub + NodeField.FLAGS] & NodeFlag.HOST_OWNED)) {
			lifecycleUnwatched(dep);
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

	function propagate(startLink: LinkId, innerWrite: boolean): void {
		// No try/finally: propagate never runs user code (notify only queues),
		// so it cannot throw and always drains the stack back to its base.
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

	// Entry wrapper (dalien port study row 10): owns the scratch-stack base
	// restore (update() runs user getters, which can throw mid-walk) and the
	// shallow/two-level/chain fast paths. Kept apart from the loop so each
	// piece stays under V8's 460-bytecode inlining budget — try/finally
	// plumbing plus the loop was 537 bytecodes, which barred checkDirty from
	// inlining into run()/computedReadSlow() (the bytecode budget test pins
	// this; dalien measured small cones 1.05-1.3x -> 0.9-1.1x vs upstream).
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

	// update() + sibling Pending->Dirty upgrade, shared by the wrapper fast
	// paths and the descend/unwind arms of checkDirtyLoop. `subs` is captured
	// BEFORE update() runs (the re-track may rebuild the list), exactly as
	// upstream.
	function updateAndShallow(node: NodeId, subs: LinkId): boolean {
		if (update(node)) {
			if (memory[subs + LinkField.NEXT_SUB] !== 0) {
				shallowPropagate(subs);
			}
			return true;
		}
		return false;
	}

	// Stackless walk for pure chains (see checkDirty). Descends while the
	// pending dep has exactly one dep-link and one subscriber; on finding a
	// directly-dirty base, updates back UP by climbing the unique subscriber
	// links — the resume state a branching walk would need a stack for is
	// recoverable from the graph itself. Returns 1 (dirty: caller re-checks
	// its sub), 0 (resolved clean), -1 (shape is not a chain here: fall
	// through to the general loop, nothing mutated).
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

	// The general walk, out of line (see checkDirty — the wrapper owns the
	// checkSp restore, so a throwing getter unwinds through it).
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

	// ---- index.ts transliteration ---------------------------------------------

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

	function unwatched(node: NodeId): void {
		const flags = memory[node + NodeField.FLAGS];
		if (flags & NodeFlag.K_COMPUTED) {
			// NEVER strip a MID-EVALUATION record (RECURSED_CHECK): its
			// DEPS_TAIL is the live re-track cursor, and a neighbor's re-track
			// can unlink the last sub of a node whose own frame is open (the
			// mutual dep-flip shape — x newly reads y while y stale-depends on
			// x). Stripping then frees the cursor link, the very next insert
			// reuses it AS ITS OWN NEIGHBOR, and the dep list goes cyclic —
			// the S-C union-cycle hang (historically "kernel link cycles the
			// unwatched walk cannot traverse", measured as a hang when world
			// evaluations rode kernel records). The open evaluation owns its
			// list: its epilogue purge trims it, and a truly-dead record is
			// lazily stripped at its NEXT unwatched edge (bounded residue,
			// base-kernel-acceptable).
			if (memory[node + NodeField.DEPS_TAIL] !== 0 && !(flags & NodeFlag.RECURSED_CHECK)) {
				memory[node + NodeField.FLAGS] = NodeFlag.K_COMPUTED | NodeFlag.MUTABLE | NodeFlag.DIRTY
					| (flags & NodeFlag.HOST_OWNED); // ownership survives the rewrite (S-C)
				disposeAllDepsInReverse(node);
			}
		} else if (flags & NodeFlag.K_SIGNAL) {
			// (D1 releases per-link inside unlink since S-C — nothing left to
			// do at the subs-empty edge for signals.)
		} else if (flags & (NodeFlag.K_EFFECT | NodeFlag.K_SCOPE)) {
			dispose(node);
		}
	}

	// Upstream's HasChildEffect slow path in updateComputed/run: unlink every
	// dep that is not a signal/computed (i.e. child effects/scopes), in reverse.
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

	function updateComputed(c: NodeId): boolean {
		const oldFlags = memory[c + NodeField.FLAGS];
		if (oldFlags & NodeFlag.HAS_CHILD_EFFECT) {
			unlinkChildEffects(c);
		}
		memory[c + NodeField.DEPS_TAIL] = 0;
		// D3: the eval-start rewrite PRESERVES the exceptional bits — while the
		// getter runs, the value slot still holds the PREVIOUS outcome, and
		// ctx.previous / the isEqual wrapper need the bits to tell a residual
		// error/thenable payload from a plain previous value.
		memory[c + NodeField.FLAGS] = NodeFlag.K_COMPUTED | NodeFlag.MUTABLE | NodeFlag.RECURSED_CHECK
			| (oldFlags & (NodeFlag.HAS_BOX | NodeFlag.BOX_SUSPENDED | NodeFlag.HOST_OWNED));
		const prevSub = activeSub;
		activeSub = c;
		++enterDepth;
		const v: ValueIndex = c >> RecordGeom.ID_TO_VALUE_SHIFT;
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
			return oldValue !== (vals[v] = (fnTab[c >> RecordGeom.ID_TO_FN_SHIFT] as (ctx: unknown) => unknown)(evalCtx)) || oldExc !== 0;
		} catch (e) {
			// D3: a throwing getter never corrupts graph state — the raw thrown
			// value / pending thenable becomes the cached payload (cold).
			const bits = storeThrown(c, e, oldValue, oldExc);
			memory[c + NodeField.FLAGS] = (memory[c + NodeField.FLAGS] & ~(NodeFlag.HAS_BOX | NodeFlag.BOX_SUSPENDED)) | bits;
			keep = ~NodeFlag.RECURSED_CHECK;
			return oldExc !== bits || oldValue !== vals[v];
		} finally {
			--enterDepth;
			activeSub = prevSub;
			memory[c + NodeField.FLAGS] &= keep;
			purgeDeps(c);
		}
	}

	function updateSignal(s: NodeId): boolean {
		memory[s + NodeField.FLAGS] = NodeFlag.K_SIGNAL | NodeFlag.MUTABLE;
		const v: ValueIndex = s >> RecordGeom.ID_TO_VALUE_SHIFT;
		return vals[v] !== (vals[v] = vals[v + RecordGeom.AUX_VALUE_OFFSET]);
	}

	function run(e: NodeId): void {
		const flags = memory[e + NodeField.FLAGS];
		if (
			flags & NodeFlag.DIRTY
			|| (flags & NodeFlag.PENDING && checkDirty(memory[e + NodeField.DEPS], e))
		) {
			if (flags & NodeFlag.HAS_CHILD_EFFECT) {
				unlinkChildEffects(e);
			}
			const cv: ValueIndex = (e >> RecordGeom.ID_TO_VALUE_SHIFT) + RecordGeom.AUX_VALUE_OFFSET;
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
				vals[cv] = (fnTab[e >> RecordGeom.ID_TO_FN_SHIFT] as () => (() => void) | void)();
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

	// flush() abort path: re-arm effects still queue after a throw.
	function requeueAbort(e: NodeId): void {
		if (memory[e + NodeField.FLAGS] & NodeFlag.KIND_MASK) {
			memory[e + NodeField.FLAGS] |= NodeFlag.WATCHING | NodeFlag.RECURSED;
		}
	}

	function runCleanup(e: NodeId): void {
		const cv: ValueIndex = (e >> RecordGeom.ID_TO_VALUE_SHIFT) + RecordGeom.AUX_VALUE_OFFSET;
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
		if (flags & NodeFlag.K_EFFECT && vals[(e >> RecordGeom.ID_TO_VALUE_SHIFT) + RecordGeom.AUX_VALUE_OFFSET]) {
			runCleanup(e);
		}
		// Deferred reclamation: the queue (or an in-flight walk) may still hold
		// this id; the record is swept back onto the free list at the next
		// operation boundary.
		pendingFree.push(e);
	}

	function disposeAllDepsInReverse(sub: NodeId): void {
		let cur = memory[sub + NodeField.DEPS_TAIL];
		while (cur !== 0) {
			const prev = memory[cur + LinkField.PREV_DEP];
			unlink(cur, sub);
			cur = prev;
		}
	}

	function purgeDeps(sub: NodeId): void {
		const depsTail = memory[sub + NodeField.DEPS_TAIL];
		let dep = depsTail !== 0 ? memory[depsTail + LinkField.NEXT_DEP] : memory[sub + NodeField.DEPS];
		while (dep !== 0) {
			dep = unlink(dep, sub);
		}
	}

	// ---- operations dispatched from the public wrappers ------------------------

	function newSignal(value: unknown): NodeId {
		const id = allocNode(NodeFlag.K_SIGNAL | NodeFlag.MUTABLE);
		const v: ValueIndex = id >> RecordGeom.ID_TO_VALUE_SHIFT;
		vals[v] = value; // currentValue
		vals[v + RecordGeom.AUX_VALUE_OFFSET] = value; // pendingValue
		return id;
	}

	function newComputed(getter: (ctx: unknown) => unknown): NodeId {
		const id = allocNode(NodeFlag.K_COMPUTED);
		fnTab[id >> RecordGeom.ID_TO_FN_SHIFT] = getter;
		return id;
	}

	function newEffect(fn: () => (() => void) | void): NodeId {
		const e = allocNode(NodeFlag.K_EFFECT | NodeFlag.WATCHING | NodeFlag.RECURSED_CHECK);
		fnTab[e >> RecordGeom.ID_TO_FN_SHIFT] = fn;
		const prevSub = activeSub;
		activeSub = e;
		if (prevSub !== 0) {
			link(e, prevSub, 0);
			memory[prevSub + NodeField.FLAGS] |= NodeFlag.HAS_CHILD_EFFECT;
		}
		++enterDepth;
		try {
			++runDepth;
			vals[(e >> RecordGeom.ID_TO_VALUE_SHIFT) + RecordGeom.AUX_VALUE_OFFSET] = fn();
		} finally {
			--runDepth;
			--enterDepth;
			activeSub = prevSub;
			memory[e + NodeField.FLAGS] &= ~NodeFlag.RECURSED_CHECK;
		}
		return e;
	}

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

	// signalOper read path.
	function read(s: NodeId): unknown {
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
		return vals[s >> RecordGeom.ID_TO_VALUE_SHIFT];
	}

	// signalOper write path; the WRAPPER flushes (iff this returns true), so
	// growth can happen between queue effects at the top level (upstream
	// flushes inline here, only when the changed signal had subscribers).
	function write(s: NodeId, value: unknown): boolean {
		const p: ValueIndex = (s >> RecordGeom.ID_TO_VALUE_SHIFT) + RecordGeom.AUX_VALUE_OFFSET;
		if (vals[p] !== (vals[p] = value)) {
			memory[s + NodeField.FLAGS] = NodeFlag.K_SIGNAL | NodeFlag.MUTABLE | NodeFlag.DIRTY;
			const subs = memory[s + NodeField.SUBS];
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
		const flags = memory[c + NodeField.FLAGS];
		if (
			flags & (NodeFlag.RECURSED_CHECK | NodeFlag.DIRTY | NodeFlag.PENDING | NodeFlag.HAS_BOX)
			|| !(flags & NodeFlag.MUTABLE) // never evaluated (upstream `!flags`; exact-compare broke when HOST_OWNED joined the word)
		) {
			return computedReadSlow(c, flags);
		}
		if (activeSub !== 0) {
			link(c, activeSub, cycle);
		}
		return vals[c >> RecordGeom.ID_TO_VALUE_SHIFT];
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
		} else if (!(flags & NodeFlag.MUTABLE)) { // upstream `!flags`: never evaluated
			memory[c + NodeField.FLAGS] = NodeFlag.K_COMPUTED | NodeFlag.MUTABLE | NodeFlag.RECURSED_CHECK
				| (flags & NodeFlag.HOST_OWNED);
			const prevSub = activeSub;
			activeSub = c;
			++enterDepth;
			try {
				vals[c >> RecordGeom.ID_TO_VALUE_SHIFT] = (fnTab[c >> RecordGeom.ID_TO_FN_SHIFT] as (ctx: unknown) => unknown)(evalCtx);
			} catch (e) {
				memory[c + NodeField.FLAGS] |= storeThrown(c, e, undefined, 0); // D3 (cold; first eval — no previous outcome)
			} finally {
				--enterDepth;
				activeSub = prevSub;
				memory[c + NodeField.FLAGS] &= ~NodeFlag.RECURSED_CHECK;
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
		const f = memory[c + NodeField.FLAGS];
		if (f & NodeFlag.HAS_BOX) {
			return boxedRead(c, f);
		}
		return vals[c >> RecordGeom.ID_TO_VALUE_SHIFT];
	}

	// D5: settlement-invalidate primitive. Marks the computed stale exactly the
	// way a dependency write would have and propagates to its subscribers; the
	// wrapper flushes. Cold: called from settle listeners and read-site
	// self-heal only.
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

	// S-C: flag a computed HOST_OWNED (see NodeFlag.HOST_OWNED) and settle the
	// books for links created BEFORE adoption: each existing link to a
	// lifecycle dep fired +1 at insert, and its eventual unlink will skip the
	// -1 (the flag reads at unlink time) — so release those refs here, once.
	function markHostOwnedOp(c: NodeId): void {
		const flags = memory[c + NodeField.FLAGS];
		if (!(flags & NodeFlag.K_COMPUTED) || flags & NodeFlag.HOST_OWNED) {
			return;
		}
		memory[c + NodeField.FLAGS] = flags | NodeFlag.HOST_OWNED;
		let l = memory[c + NodeField.DEPS];
		while (l !== 0) {
			const dep = memory[l + LinkField.DEP];
			if (memory[dep + NodeField.LIFECYCLE] !== 0) {
				lifecycleUnwatched(dep);
			}
			l = memory[l + LinkField.NEXT_DEP];
		}
	}

	// S-C: computed disposal (the useComputed deps-change reclamation path;
	// cold — reached only through the __hostDisposeComputed seam). Flags zero
	// FIRST so the last sub unlink's unwatched() probe sees a dead record;
	// remaining subscriber links detach (their records simply lose the dep —
	// a later re-track just doesn't see it; the caller owns the discipline
	// that the node is superseded); the free defers to the next operation
	// boundary exactly like effect/scope disposal (in-flight walks may still
	// hold the id), where freeNode bumps GEN — the id-tenancy stamp (§4.5.3).
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

// ---- engine instance + growth ------------------------------------------------

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

// D6: configure({initialRecords}) raises this floor; the growth loop honors it.
let desiredRecords: RecordCount = initialRecords * RecordGeom.RECORDS_PER_UNIT;

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
	disposeComputed: foldPoisonOp as never,
	markHostOwned: foldPoisonOp as never,
	markLifecycle: foldPoisonOp as never,
	activeIsComputed: foldPoisonOp as never,
};

// RecordGeom capacity: 3x initialRecords shared records, budgeted as
// initialRecords node records + 2x initialRecords link records in one arena.
export let E: Engine = createEngine(initialRecords * RecordGeom.RECORDS_PER_UNIT);

/**
 * Record-free hook (one hook; see freeNode): invoked at the boundary sweep
 * for every freed NODE record with (recordId, nodeIndex). Hosts that key
 * dense per-node side tables by NodeField.NODE_INDEX register their scrub
 * here — a freed slot's index is inherited by the slot's next tenant, so
 * every index-keyed row must clear at exactly this boundary. The hook runs
 * at an operation boundary and must not allocate or free kernel records.
 * @internal
 */
let recordFreeHook: ((recordId: NodeId, nodeIndex: number) => void) | undefined;

/** Registers/clears the record-free hook (host seam). @internal */
export function __setRecordFreeHook(fn: ((recordId: NodeId, nodeIndex: number) => void) | undefined): void {
	recordFreeHook = fn;
}

export function maybeBoundary(): void {
	if (enterDepth === 0 && (growPending || pendingFree.length !== 0)) {
		boundaryWork();
	}
}

/**
 * The plain kernel write (no engine content): the tail of Atom.set/update's
 * standalone fast arm, the engine's node-less arm, and the lifecycle
 * context's handle-free path. Lives HERE, not in the policy layer: every
 * binding it touches per call — values, maybeBoundary, E, batchDepth,
 * flush — is this module's state, and a hot read of a cyclic module's
 * imported binding pays a per-access cell + initialization check that a
 * same-module read doesn't.
 *
 * R-2 equality drop — `isEqual(current, incoming)`, kernel order, ONCE, at
 * the acceptance decision: an atom on this path has no engine content, so
 * its write history is empty by construction and a write equal to the
 * current pending value simply drops. (An atom WITH engine content
 * dispatches through the engine, where the same rule applies only while its
 * write log is empty — once history exists, different worlds may fold
 * different values.) Policy equality against the newest (pending) value;
 * the kernel's own identity compare covers the default. The
 * writes-in-computeds policy is asserted by the CALLERS before dispatching
 * here. @internal
 */
export function writeAtom(id: NodeId, isEqual: ((a: unknown, b: unknown) => boolean) | undefined, value: unknown): void {
	if (isEqual !== undefined && isEqual(values[(id >> RecordGeom.ID_TO_VALUE_SHIFT) + RecordGeom.AUX_VALUE_OFFSET], value)) {
		return;
	}
	maybeBoundary();
	if (E.write(id, value) && batchDepth === 0) {
		flush();
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
		while (records < desiredRecords || recNext > Math.min((records * RecordGeom.STRIDE) >> RecordGeom.HALF_ARENA_SHIFT, (records - RecordGeom.REC_SLACK) * RecordGeom.STRIDE)) {
			records *= 2;
		}
		if (records !== E.records) {
			E = createEngine(records, E.buffer());
		}
	}
}

export function flush(): void {
	// Boundary-lite: growth/reclamation only BEFORE the flush loop, not between
	// effects. Safe because (a) all user code during flush runs at
	// enterDepth >= 1, so E cannot be swapped mid-loop (the `engine` hoist is
	// sound), and (b) the watermark guarantees >= RecordGeom.REC_SLACK (1280) free records
	// at flush start while cascade re-runs re-track through the link() fast
	// path / free lists (net new records per flush audited at ~tens across the
	// conformance suite and benchmark workloads; a pathological cascade that
	// out-allocates the whole remaining arena throws in the allocator rather
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

// ---- mechanism halves of the policy layer's runFold and configure ----------------
// (the POLICY bodies — the fold-purity rule, the configure validation — stay
// in index.ts; these are the kernel-state mutations they need, exported as
// functions because ESM importers cannot assign another module's bindings.)

/** Swap the operation table to the fold-purity POISON table; returns the
 * live table for the paired restore (index.ts runFold's bracket). */
export function foldGuardSwap(): Engine {
	const saved = E;
	E = POISON;
	return saved;
}

export function foldGuardRestore(saved: Engine): void {
	E = saved;
}

/** Raise the capacity floor to `units` configured units (one node + two link
 * records each) and schedule growth at the next operation boundary — the
 * kernel half of configure({ initialRecords }) (D6). Never shrinks. */
export function requestCapacity(units: RecordCount): void {
	const target = units * RecordGeom.RECORDS_PER_UNIT;
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
 * plain value), used by the concurrent engine's quiet fold and eager apply.
 * The policy comparator does NOT run here (R-2: `isEqual(current, incoming)`
 * is invoked exactly once, at the acceptance decision — re-running it inside
 * the apply was the old double invocation); the kernel's own identity
 * store-compare still gates propagation. Effects flushed here re-enter the
 * public write path and CLASSIFY NORMALLY (R-3) — there is no recursion
 * guard because this tail never re-enters the public methods itself.
 */
export function writeNewest(id: NodeId, value: unknown): void {
	maybeBoundary();
	if (E.write(id, value) && batchDepth === 0) {
		flush();
	}
}

// ---- the engine reset's kernel half (test-only; great-refactor R-6) --------------

/**
 * Kernel idle preconditions for `__resetEngineForTest` — a reset from inside
 * any live kernel frame would corrupt the next test instead of failing this
 * one. @internal
 */
export function __assertKernelIdleForReset(): void {
	if (enterDepth !== 0) throw new Error('cosignal: __resetEngineForTest inside an open kernel frame (enterDepth !== 0)');
	if (batchDepth !== 0) throw new Error('cosignal: __resetEngineForTest inside batch() (batchDepth !== 0)');
	if (runDepth !== 0) throw new Error('cosignal: __resetEngineForTest inside an effect run');
	if (queuedLength !== notifyIndex) throw new Error('cosignal: __resetEngineForTest with queued effects unflushed');
	if (E === POISON) throw new Error('cosignal: __resetEngineForTest inside a fold-purity frame');
}

/**
 * THE KERNEL SCRUB (test-only; great-refactor R-6): a watermark-bounded
 * scrub — zero the used arena range and every allocator head/counter, drop
 * the side columns to their burned seeds — never a reallocation (the arena
 * keeps any grown capacity; the live operation table stays valid because it
 * closes over the same buffer). Bumps THE ENGINE EPOCH, which every
 * cross-reset microtask consults. The caller (`__resetEngineForTest`) owns
 * ordering: driver protocol reset first, then this, then the engine
 * recomposition. @internal
 */
export function __resetKernelForTest(): void {
	__assertKernelIdleForReset();
	engineEpoch++;
	E.buffer().fill(0, 0, recNext); // watermark-bounded: only the used range holds records
	recNext = RecordGeom.STRIDE; // record 0 stays burned
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
	// Side columns: stale values and wrapper/effect closures must not survive
	// id reuse (the reset checklist's VALUES/FNS clause).
	values.length = 2;
	values[0] = undefined;
	values[1] = undefined;
	fns.length = 1;
	fns[0] = undefined;
	// Walk scratch: stack contents are per-walk, but a reset mid-diagnosis
	// must not leave stale cursors.
	propSp = 0;
	checkSp = 0;
	// configure({initialRecords}) is per-instance tuning → a reset parameter
	// now: the floor returns to the process default (the checklist's
	// DESIREDRECORDS clause).
	desiredRecords = initialRecords * RecordGeom.RECORDS_PER_UNIT;
	routingActive = false;
}
