import { CycleError, InvariantViolation, ScheduleError, getOrThrow } from './errors.js'

export type UseKey = string | number | boolean | null | readonly UseKey[]
export type ComputedCtx<T> = {
	readonly previous: T | undefined
	use<V>(source: PromiseLike<V>): V
	use<V>(key: UseKey, factory: () => PromiseLike<V>): V
}
export type AtomCtx<T> = {
	readonly state: T
	set(value: T): void
	update(fn: (current: T) => T): void
}
export type AtomOptions<T> = {
	effect?: (ctx: AtomCtx<T>) => void | (() => void)
	isEqual?: (a: T, b: T) => boolean
	label?: string
}
export type ComputedOptions<T> = { isEqual?: (a: T, b: T) => boolean; label?: string }
export type ConfigureOptions = { forbidWritesInComputeds?: boolean; initialRecords?: number }
export type CreateCosignalsOptions = {
	/** Initial world-arena buffer reservation, in Int32 slots (see EngineResetOptions). */
	arenaInitInts?: number
	/** Arms development-time checks (see EngineResetOptions). */
	devChecks?: boolean
	/**
	 * Initial kernel-arena capacity floor, in units (one node plus two dependency
	 * edges each). Defaults SMALL — the arena grows on demand (grow-by-copy), so
	 * a server creating one instance per request does not reserve the maximum up
	 * front. Raise it before building a large graph to avoid growth pauses; the
	 * arena never shrinks. `configure({ initialRecords })` and the
	 * COSIGNAL_INITIAL_RECORDS env var raise it too.
	 */
	initialRecords?: number
}

// ---- semantic number types ------------------------------------------------------
// Leniently branded id types, zero runtime cost: the brand is an optional
// unique-symbol property, erased at emit, so plain numbers assign freely in
// (arena arithmetic needs no casts) while distinct brands conflict by payload
// — a NodeId handed where a LinkId belongs is a compile error. Every brand
// shares the one `IdOf` key; per-module keys would be silently mutually assignable.

declare const IdOf: unique symbol

type IdBrand<P extends string> = { [IdOf]?: P }

/**
 * Premultiplied node record id: the Int32 arena index of the record's field 0
 * (id = record ordinal × ArenaShape.STRIDE). 0 = "none" (record 0 is burned).
 */
export type NodeId = number & IdBrand<'node'>
/** Premultiplied link record id (links share the arena and stride with nodes). 0 = "none". */
type LinkId = number & IdBrand<'link'>
/**
 * A premultiplied record id of either kind: nodes and links draw from one
 * bump pointer (`recNext`); {@link allocNode}/allocLink cast into an id space.
 */
type RecordId = NodeId | LinkId
/**
 * Dense per-node ordinal ({@link NodeField.NODE_INDEX}): assigned to a slot
 * once, kept across tenants, never an identity. Dense per-node side tables
 * key by it — record-id keys would go holey (links share the allocator).
 */
type NodeIndex = number & IdBrand<'nodeIndex'>
/** An updated-at clock stamp: an instance-monotone float64 from {@link clockSource} (see the UpdatedAt clocks section); 0 = "never". */
type Clock = number & IdBrand<'clock'>
/** A node's FLAGS field value: a bitwise OR of NodeFlag members. */
type NodeFlags = number
/** The global evaluation cycle counter, stamped into link VERSION fields on re-track. */
type Version = number
/** A node's GEN field value: bumped on free so disposers can defuse stale ids. */
type Generation = number
/** A count of fixed-stride records (nodes and links draw from one shared pool). */
type RecordCount = number
/** Index into the `values` side column (two slots per record; see ArenaShape). */
export type ValueIndex = number & IdBrand<'valueIndex'>

// ---- the record layout --------------------------------------------------------
// Field/flag/shape enums for both record domains (kernel here, world-arena
// further down), with the column-coherence functions beside them. Maintenance
// rule: a layout edit — new field, flag bit, column, or record family —
// updates the matching grow, scrub, and reset functions in the SAME edit, or
// a freed slot's next tenant observes the dead tenant's state.
/**
 * Field offsets within a node arena record. A NodeId points at the record's
 * field 0; a field read is plain addition: `memory[nodeId + NodeField.DEPS]`.
 * `const enum` members inline as number literals the JIT can constant-fold —
 * bundlers can demote module consts to `var`, blocking that folding (measured
 * 15-21% on benchmark workloads). Exported for diagnostics and structural
 * tests; the engine's own hot paths are all same-file.
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
	 * 1 iff the node is an atom with an observed-lifecycle effect
	 * (AtomOptions.effect: a callback runs at its first observer, a cleanup at
	 * its last); gates the per-link retain/release in {@link linkInsert}/unlink.
	 * A field, not a FLAGS bit: preserving a bit turns write()'s constant flag
	 * store into a read-modify-write — measured +0.2 ns per bare write, +3-4%
	 * on write-storm composites — and stride-8 records make the field free.
	 */
	LIFECYCLE = 6,
	/**
	 * The record's {@link NodeIndex}. freeNode threads the free list through
	 * DEPS and leaves this field untouched, so a slot keeps its index across
	 * tenants. Node records only — link records use slot 7 as FREE_NEXT.
	 */
	NODE_INDEX = 7,
}

/** Field offsets within a link arena record (links share the arena, stride, and premultiplied ids with nodes; access pattern and rationale on {@link NodeField}). */
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
	 * every real field intact: walks deliberately read stale nextDep/nextSub
	 * off links unlinked earlier in the same walk (conformance case 203;
	 * tests/freelist.spec.ts), and those must name former neighbors.
	 */
	FREE_NEXT = 7,
}

/**
 * Field offsets within a component WATCHER record. It has no kernel links;
 * slots 1/5/7 retain their allocator meanings.
 */
const enum ObserverField {
	/** Kind + observer-state bits (NodeFlag.K_WATCHER, NodeFlag.OBSERVER_LIVE). */
	FLAGS = 0,
	/** Allocator-owned: the node free list threads here while the record is freed (0 while live — observer records hold no dependency links). */
	FREE_NEXT = 1,
	/** Watcher: the watched node record id (the component reads this node). */
	NODE = 2,
	/** Watcher: the watched record's tenancy generation (kernel GEN) at mount: record ids recycle, so every watcher→node resolution generation-checks this stamp and skips loudly on mismatch. */
	NODE_GEN = 3,
	/** Watcher: per-(watcher, slot) delivery dedup bits, one int word (bit i = batch slot i): a second write in the same slot delivers again only if no scheduled-but-unstarted render will fold it anyway. */
	DEDUP_BITS = 4,
	/** Allocator-owned tenancy generation (shared meaning with NodeField.GEN): bumped when the record frees. */
	GEN = 5,
	/** Watcher: the watched record's NODE_INDEX, cached at mount. Slot-tied like every node index (a record slot keeps its index across tenants), so the cache never goes stale — the NODE_GEN stamp is what decides whether the watched TENANCY is still alive. */
	NODE_IX = 6,
	/** Allocator-owned dense per-record ordinal (shared meaning with NodeField.NODE_INDEX); observer records consume ordinals but no dense column stores rows for them. */
	NODE_INDEX = 7,
}

/**
 * Kernel observer record backing one committed SignalEffect terminal. Its
 * dependency links live canonically on the root arena's terminal shadow.
 */
const enum SignalEffectField {
	FLAGS = 0,
	FREE_NEXT = 1,
	GEN = 5,
	NODE_INDEX = 7,
}

/** Bit values of a node's FLAGS field (upstream ReactiveFlags + HasChildEffect + kind bits); a flags word is an OR of these. */
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
	 * The computed's cached value is an exceptional outcome — the raw thrown
	 * value (HAS_BOX alone) or the pending thenable (HAS_BOX | BOX_SUSPENDED).
	 * Set only at the kernel's two catch sites, cleared only by a successful
	 * evaluation; every other flag site ORs bits or forces a recompute, so a
	 * stale clear never serves a payload unwrapped.
	 */
	HAS_BOX = 0b00000100000000000,
	/** Refines HAS_BOX (never set without it): the payload is a pending thenable, not a thrown error. */
	BOX_SUSPENDED = 0b00001000000000000,
	/**
	 * Marks engine-created reader records (the markMachineryOwned op; never
	 * user nodes). Observed-lifecycle refcounts follow kernel dependency
	 * links, but the engine itself reads user atoms as bookkeeping (world
	 * folds, committed-world validation, tests) — a websocket-connecting effect
	 * must not fire because a render folded its atom. Refcount sites skip
	 * marked readers; real consumers report through the observation index. Every flag-word rewrite preserves the bit.
	 */
	MACHINERY_OWNED = 0b00010000000000000,
	/**
	 * Engine observer records: K_WATCHER is one component watcher;
	 * K_SIGNAL_EFFECT is one committed effect terminal.
	 * Outside KIND_MASK: the kernel's kind dispatch never sees observer records.
	 */
	K_WATCHER = 0b00100000000000000,
	K_SIGNAL_EFFECT = 0b01000000000000000,
	/**
	 * Observer records only: subscribed for delivery. A watcher holds one
	 * observed-consumer ref; a SignalEffect uses this as its teardown gate.
	 */
	OBSERVER_LIVE = 0b10000000000000000,
	/** The kind bits together (exactly one is set on a live kernel record). */
	KIND_MASK = K_SIGNAL | K_COMPUTED | K_EFFECT | K_SCOPE, // 0b00000011110000000
}

/** Kernel arena shape: the strides, shifts, and offsets that address a record's fields and side-column slots from its premultiplied id. */
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
	 * empty: nothing kernel-side may pin the public handle, or a dropped
	 * handle's record could never be reclaimed.
	 */
	AUX_VALUE_OFFSET = 1,
	/** length >> HALF_ARENA_SHIFT: the "keep at least half the arena free" watermark term. */
	HALF_ARENA_SHIFT = 1,
	/** Records budgeted per configured capacity unit: one node + two links. */
	RECORDS_PER_UNIT = 3,
	/**
	 * Min free records guaranteed at each op boundary: the sum of per-kind
	 * floors (256 node + 1024 link records), so any allocation pattern that
	 * fit those floors separately still fits the merged slack.
	 */
	REC_SLACK = 1280,
}

/**
 * Thrown when a read observes a pending suspension. Carries the pending
 * thenable; the React bindings (`cosignals-react`) catch it at render read
 * sites and forward it to Suspense.
 *
 * Defined once at module scope and shared by every {@link createCosignals}
 * instance: it is a stateless marker, so a single class lets the exported
 * `err instanceof SuspendedRead` check succeed for suspensions raised by any
 * instance. A per-instance class (as an inner class of the factory would be)
 * would make that check silently fail for handles created by
 * `createCosignals()`. The sibling error classes ({@link CycleError},
 * {@link ScheduleError}, {@link InvariantViolation}) are already module-level
 * in `errors.ts` for the same reason.
 */
class SuspendedRead {
	readonly thenable: PromiseLike<unknown>
	constructor(thenable: PromiseLike<unknown>) {
		this.thenable = thenable
	}
}

/**
 * Cross-instance handle brands, carried on the Atom/Computed class prototypes
 * (global-registry symbols so the value is identical across module copies).
 * Every {@link createCosignals} call defines its own Atom/Computed classes, so
 * `x instanceof Atom` from one instance rejects another instance's handles;
 * these brands let {@link isAtom}/{@link isComputed} — and the React bindings —
 * recognize a handle's TYPE regardless of which instance created it. WHICH
 * instance owns a handle is the separate `_engine` field, asserted at the
 * engine surface (see the ownership guards).
 */
const ATOM_BRAND: unique symbol = Symbol.for('cosignals.handle.atom')
const COMPUTED_BRAND: unique symbol = Symbol.for('cosignals.handle.computed')

// Kernel-arena capacity floors, in configured units (one node + two dependency
// edges each). The arena grows by rebuild on demand, so a floor is a starting
// reservation, never a ceiling.
/** Smallest legal floor; the option/env/configure() paths all enforce it. */
const MIN_INITIAL_RECORDS = 2
/**
 * The DEFAULT browser instance's floor — the historical reservation, kept so
 * its behavior is unchanged. `createCosignals()` for user code defaults SMALL
 * instead (see {@link SMALL_INITIAL_RECORDS}).
 */
const DEFAULT_INITIAL_RECORDS = 1 << 20
/**
 * `createCosignals()`'s default floor: small enough that many instances (e.g.
 * one per server request) cost kilobytes each, not the ~120MB the max reserves;
 * still above the op-boundary slack watermark so a fresh instance does not grow
 * on its first write.
 */
const SMALL_INITIAL_RECORDS = 1 << 10

/** COSIGNAL_INITIAL_RECORDS parsed to units, or undefined when unset/invalid. */
function readEnvInitialRecords(): number | undefined {
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
		?.env?.COSIGNAL_INITIAL_RECORDS
	const n = env !== undefined ? Number(env) : NaN
	return Number.isFinite(n) && n >= MIN_INITIAL_RECORDS ? Math.ceil(n) : undefined
}

export function createCosignals(options?: CreateCosignalsOptions) {
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
			return ctxPrevious()
		},
		use<V>(sourceOrKey: PromiseLike<V> | UseKey, factory?: () => PromiseLike<V>): V {
			return ctxUse(sourceOrKey, factory) as V
		},
	}

	/**
	 * Scrub a freed record's side columns on the node allocator's free path
	 * (every family it serves; new columns join this scrub): the next tenant
	 * must never observe dead values, closures, or clock stamps. The clock
	 * buffer is closure-owned, so the caller passes it.
	 */
	function scrubNodeColumnsOnFree(id: NodeId, clocks: Float64Array): void {
		const base: ValueIndex = id >> ArenaShape.ID_TO_VALUE_SHIFT
		values[base] = undefined // current/computed value; watcher records use it for last rendered value
		values[base + ArenaShape.AUX_VALUE_OFFSET] = undefined // signal pending value or effect cleanup fn (computeds and observer records: empty on purpose)
		fns[id >> ArenaShape.ID_TO_FN_SHIFT] = undefined // computed getter / effect fn / an atom's dormant lifecycle callback
		extras[id >> ArenaShape.ID_TO_EXTRAS_SHIFT] = undefined // cold oddments for nodes and observer records
		clocks[id >> ArenaShape.ID_TO_CLOCK_SHIFT] = 0 // signal/computed: updatedAt; watcher: lastValidatedAt
	}

	/**
	 * Scrub a freed link record's side columns on the link allocator's free
	 * path (new columns join this scrub) — {@link scrubNodeColumnsOnFree}'s link twin.
	 */
	function scrubLinkColumnsOnFree(id: LinkId, clocks: Float64Array): void {
		clocks[id >> ArenaShape.ID_TO_CLOCK_SHIFT] = 0
	}

	/**
	 * Grow the kernel's grown-together side columns to cover one record id (new
	 * grow-array columns join this loop); record-buffer columns are
	 * factory-carried and grow by kernel rebuild instead.
	 */
	function growNodeSideColumns(id: RecordId): void {
		while (values.length <= (id >> ArenaShape.ID_TO_VALUE_SHIFT) + ArenaShape.AUX_VALUE_OFFSET) {
			values.push(undefined)
		}
		while (fns.length <= id >> ArenaShape.ID_TO_FN_SHIFT) {
			fns.push(undefined)
		}
		while (extras.length <= id >> ArenaShape.ID_TO_EXTRAS_SHIFT) {
			extras.push(undefined)
		}
	}

	/**
	 * Reset every kernel side column to its record-zero seed (the test reset's
	 * column half): grow-arrays truncate; record buffers zero-fill in place.
	 */
	function resetSideColumns(clocks: Float64Array): void {
		values.length = 2
		values[0] = undefined
		values[1] = undefined
		fns.length = 1
		fns[0] = undefined
		extras.length = 1
		extras[0] = undefined
		clocks.fill(0)
	}

	/**
	 * World-arena shadow-record fields. A shadow record is a world's stand-in
	 * for one kernel node (keyed by node index, stamped with the node's GEN);
	 * shadow and link records share a stride-8 pool, and FLAGS bits are
	 * {@link ArenaFlag}. Names keep the kernel's numbering so arena walks read
	 * beside the kernel family, but nothing couples the layouts. Module-local:
	 * hot walks are same-file; the test checker reads via arenaCheckerLayout().
	 */
	const enum ArenaField {
		FLAGS = 0,
		/** First dependency link; doubles as the dead-shadow free-list next pointer. */
		DEPS = 1,
		DEPS_TAIL = 2,
		/** First STRONG subscriber link (the weak list lives in the weakSubs side column). */
		SUBS = 3,
		SUBS_TAIL = 4,
		/** The nodeIndex this record shadows (dense column key; identity is the kernel record id). */
		NODE = 5,
		/** Id-tenancy stamp: the node's kernel-record GEN observed at recording — dead-GEN shadows never serve. */
		NODE_GEN = 6,
		/** Fanout read-clock dedup stamp (a marked cone nothing re-validated is not re-walked). */
		MARK = 7,
	}

	/**
	 * World-arena link-record fields: {@link LinkField} meanings over shadow
	 * record ids (subscriber lists are per-mode), plus MODE. Links share
	 * ArenaField's pool and stride; offsets overlay the shadow-record fields.
	 */
	const enum ArenaLinkField {
		VERSION = 0,
		DEP = 1,
		SUB = 2,
		PREV_SUB = 3,
		NEXT_SUB = 4,
		PREV_DEP = 5,
		NEXT_DEP = 6,
		/** ArenaLinkMode bits (strong/weak — see the weak-link rules at the arena walks). */
		MODE = 7,
		/**
		 * The free list aliases VERSION (the kernel {@link LinkField.FREE_NEXT}
		 * discipline: freed links keep every field a walk still reads — arena
		 * walks read NEXT_DEP/NEXT_SUB off mid-walk-freed links). VERSION is dead
		 * on freed links: every allocation path rewrites it before any read.
		 * Pinned by tests/arena-freelist.spec.ts.
		 */
		FREE_NEXT = 0,
	}

	const enum ArenaLinkMode {
		/** 1 = weak (untracked-read) link — never delivers; lives on the segregated weak subs list. */
		WEAK = 0b1,
	}

	/**
	 * Shadow flag bits: kernel {@link NodeFlag} meanings over shadows (names
	 * keep its numbering); VALID and BOX_THROWN are arena-only.
	 */
	const enum ArenaFlag {
		/** Can produce new values (evaluated at least once for computeds). */
		MUTABLE = 0b000000000000001,
		/** Currently refolding (re-entrancy guard; a read under it is a dependency cycle). */
		RECURSED_CHECK = 0b000000000000100,
		RECURSED = 0b000000000001000,
		/** Definitely stale (listed on the arena dirty list — the DIRTY ⇒ listed contract). */
		DIRTY = 0b000000000010000,
		PENDING = 0b000000000100000,
		K_SIGNAL = 0b000000010000000,
		K_COMPUTED = 0b000000100000000,
		/** Kind: committed SignalEffect terminal. */
		K_EFFECT = 0b000001000000000,
		/** Value column holds an exceptional payload (thrown error, or sentinel). */
		HAS_BOX = 0b000100000000000,
		/** Refines HAS_BOX: payload is the thenable's stable SuspendedRead. */
		BOX_SUSPENDED = 0b001000000000000,
		/** The value column holds a folded value (cold shadow when unset). */
		VALID = 0b010000000000000,
		/**
		 * Refines HAS_BOX: the payload was thrown by the fn (render-path
		 * suspension or plain error) — serving rethrows it. Clear means a returned
		 * sentinel (background suspensions fold to it), served as a value. No
		 * kernel NodeFlag counterpart.
		 */
		BOX_THROWN = 0b100000000000000,
	}

	/** World-arena geometry (same-file const enum: reads inside hot arena walks must inline as literals). */
	const enum ArenaGeom {
		/** Int32 fields per record; ids are premultiplied by this (id = record ordinal × STRIDE). */
		STRIDE = 8,
		/** record id >> ID_TO_COLUMN_SHIFT = the record's slot in every per-record side column (one slot per record). */
		ID_TO_COLUMN_SHIFT = 3,
		/**
		 * Int32 stamp ceiling: `readClock`/`cycle` stamps store into Int32Array
		 * fields, which truncate past 2^31-1 — a wrapped store could collide with
		 * a live stamp and false-positive a dedup (a skipped propagation: the
		 * dangerous direction). The bump helpers renumber before any store can
		 * wrap: stamps reset to 0 (= stale) and the next walk conservatively re-marks.
		 */
		CLOCK_LIMIT = 2147418112,
		/**
		 * 2^26 — the default initial per-arena reservation (64MiB of Int32: 2M
		 * stride-8 records plus a float64 clock slot each): zeroed pages are
		 * demand-paged, so resident memory tracks only records actually touched.
		 * Not a ceiling — {@link growWorldArenaBuffers} doubles past it; EngineResetOptions.arenaInitInts
		 * overrides. Fixed-length views only: resizable-buffer views measured a +56% walk regression.
		 */
		INIT_BUFFER_BYTES = 67108864,
	}

	/**
	 * Grow one world arena's record store and every record-keyed buffer column
	 * by doubling copy (new record-keyed columns join this growth; exhaustion is
	 * never fatal). Safe mid-operation — only the buffer OBJECTS change, record
	 * ids and every structure holding them stay stable, and replacements are
	 * zeroed past the copied prefix — provided every site that can allocate
	 * re-reads `a.memory` afterward; each allocating site notes this where it re-reads.
	 */
	function growWorldArenaBuffers(a: WorldArena, needInts: number): void {
		let len = a.memory.length
		while (len < needInts) {
			len *= 2
		}
		if (len === a.memory.length) {
			return
		}
		if (a.storage === 'arena') {
			const memory = new Int32Array(len)
			memory.set(a.memory)
			a.memory = memory
			const clocks = new Float64Array(len >> ArenaGeom.ID_TO_COLUMN_SHIFT)
			clocks.set(a.clocks)
			a.clocks = clocks
		} else {
			const memory = a.memory as number[]
			const oldMemoryLength = memory.length
			memory.length = len
			memory.fill(0, oldMemoryLength)
			const clocks = a.clocks as number[]
			const oldClockLength = clocks.length
			clocks.length = len >> ArenaGeom.ID_TO_COLUMN_SHIFT
			clocks.fill(0, oldClockLength)
		}
	}

	/**
	 * Grow the world arena's grown-together per-record columns to cover one
	 * column index (new grow-array columns join this loop); record-buffer
	 * columns grow with the record store in {@link growWorldArenaBuffers}.
	 */
	function growWorldArenaColumns(a: WorldArena, columnIndex: number): void {
		while (a.vals.length <= columnIndex) {
			a.vals.push(undefined)
			a.suspIdx.push(0)
			a.walk.push(0)
			a.weakSubs.push(0)
			a.weakSubsTail.push(0)
			a.cutoffVals.push(undefined)
			a.signalEffects.push(undefined)
		}
	}

	/**
	 * Scrub an evicted shadow record's column slots (new columns join this
	 * scrub): no dead value or clock stamp for the next tenant. List-coupled
	 * columns clear through their list operations; walk stamps are inert by generation monotonicity.
	 */
	function scrubWorldShadowColumnsOnEvict(a: WorldArena, sh: number): void {
		const vi = sh >> ArenaGeom.ID_TO_COLUMN_SHIFT
		a.vals[vi] = undefined
		a.clocks[vi] = 0
		a.cutoffVals[vi] = undefined
		a.signalEffects[vi] = undefined
	}

	/**
	 * Scrub a freed world-arena link record's column slots (new columns join
	 * this scrub): only SignalEffect dependency links write clocks, but every
	 * free path scrubs, so a reused link never carries a dead tenancy's stamp.
	 */
	function scrubWorldLinkColumnsOnFree(a: WorldArena, id: number): void {
		a.clocks[id >> ArenaGeom.ID_TO_COLUMN_SHIFT] = 0
	}

	/**
	 * Reset every world-arena side column at pool release, keeping each
	 * column's CAPACITY across tenancies (truncating to 0 forced re-pushing
	 * every element per claim — ~2k pushes per cold render): fill() releases
	 * value refs, stale ids read as "none", clocks zero their written prefix.
	 */
	function resetWorldArenaColumnsOnRelease(a: WorldArena): void {
		a.nodeToShadow.fill(0)
		a.vals.fill(undefined)
		a.suspIdx.fill(0)
		a.walk.fill(0)
		a.weakSubs.fill(0)
		a.weakSubsTail.fill(0)
		a.clocks.fill(0, 0, a.next >> ArenaGeom.ID_TO_COLUMN_SHIFT)
		a.cutoffVals.fill(undefined)
		a.signalEffects.fill(undefined)
	}

	/**
	 * Mass-teardown bounds for the boundary sweep. Free lists are LIFO: a huge
	 * teardown hands ids back highest-first and the next build scatters across the
	 * arena; a batch crossing both bounds pays a sort to restore ascending reuse.
	 */
	const enum MassTeardown {
		/** Pending node frees must exceed this count (absolute floor). */
		MIN_BATCH = 4096,
		/** …and batch × this must reach `recNext`: only a batch ≥ 1/64 of the arena's used extent qualifies. */
		MIN_ARENA_FRACTION = 64,
	}

	// ---- shared mutable state (survives closure rebuilds) ------------------------
	// Scalar heads/counters resume across kernel rebuilds; only the buffer
	// bindings live in the factory closure.
	let recNext: RecordId = ArenaShape.STRIDE // bump pointer, shared by nodes and links (record 0 burned)
	let nextNodeIndex = 1 // next NodeField.NODE_INDEX for a never-yet-node slot (0 burned: consumers use it as "none")
	let nodeFreeHead: NodeId = 0 // free list threaded through memory[id + NodeField.DEPS]
	let linkFreeHead: LinkId = 0 // free list threaded through memory[id + LinkField.FREE_NEXT] (spare field 7: freed links keep NEXT_DEP/NEXT_SUB intact for mid-walk stale reads)
	let growPending = false

	let cycle: Version = 0
	let runDepth = 0
	let batchDepth = 0
	let notifyIndex = 0
	let queuedLength = 0
	let activeSub: NodeId = 0
	let enterDepth = 0 // live kernel frames that captured memory; 0 = op boundary (the test reset's idle precondition)

	/**
	 * Read routing, armed: true while the concurrent machinery has a context
	 * that could answer a public read — an evaluation world on stack or an
	 * attached driver's ambient-world provider. The public
	 * `.state` getters take the routed read path only when it is set;
	 * the worlds section's syncReadRouting is the only writer.
	 */
	let routingActive = false

	/**
	 * The reset epoch: bumped once per `__TEST__resetEngine`, never in
	 * production. Cross-reset microtasks capture it at schedule time and no-op
	 * if it moved — a dead test's microtask must never touch the next test's
	 * state. Reclamation keys its per-epoch registry by it.
	 */
	let engineEpoch = 0

	const queued: NodeId[] = []
	const pendingFree: NodeId[] = [] // disposed effect/scope records awaiting the sweep (batch-freed at the next operation boundary)

	// Side columns, indexed off the id: values[id >> 2] = current/computed value,
	// values[(id >> 2) + 1] = pending value or effect cleanup (computeds: empty —
	// nothing kernel-side may pin the public handle), fns[id >> 3] = getter or
	// effect fn. Push-grown plain arrays stay packed; the policy layer reads them directly.
	const values: unknown[] = [undefined, undefined]
	const fns: (Function | undefined)[] = [undefined]
	/** General per-record object column (extras[id >> 3]): cold oddments without a dedicated column; read only by this module's observer accessors. */
	const extras: unknown[] = [undefined]

	/** Seed capacity (entries) of the walk scratch stacks below (they double on demand). */
	const WALK_STACK_SEED = 4096

	// Persistent scratch stacks reused by every graph walk (upstream allocates a
	// linked-list stack per walk); re-entrant walks push above the caller's base.
	let propStack = new Int32Array(WALK_STACK_SEED)
	let propSp = 0
	let checkStack = new Int32Array(WALK_STACK_SEED)
	let checkSp = 0

	// ---- the kernel op table -----------------------------------------------------

	/**
	 * The kernel op table: its function fields are the kernel's operations.
	 * Consumers dispatch through the instance-local slot {@link E}, re-linked
	 * to a fresh table only at growth boundaries ({@link createKernel}).
	 */
	interface Kernel {
		records: RecordCount
		buffer(): Int32Array
		/**
		 * The clock column (see {@link clockSource}): growth carry + cold
		 * consumers only — hot code uses the factory's closure constant.
		 */
		clocks(): Float64Array
		newSignal(value: unknown, target: object): NodeId
		newComputed(getter: (ctx: unknown) => unknown, target: object): NodeId
		newEffect(fn: () => (() => void) | void): NodeId
		newScope(fn: () => void): NodeId
		/**
		 * Allocate an observer record (see {@link ObserverField}): no kernel
		 * links, no reclamation registration; freed via {@link Kernel.disposeObserver}.
		 */
		newObserver(flags: NodeFlags): NodeId
		/**
		 * Dispose an observer record: flags zero at once (probes read it dead);
		 * the free defers to the boundary sweep ({@link Kernel.sweepPendingFree}).
		 */
		disposeObserver(id: NodeId): void
		gen(id: NodeId): Generation
		/** Read an atom record (computeds go through {@link computedRead}). */
		readAtom(s: NodeId): unknown
		write(s: NodeId, value: unknown): boolean
		computedRead(c: NodeId): unknown
		run(e: NodeId): void
		requeueAbort(e: NodeId): void
		/** Dispose an effect or effect scope (see {@link disposeEffect}). */
		disposeEffect(e: NodeId): void
		sweepPendingFree(): void
		/** Reclamation's structural phase (see {@link reclaimStructureOp}). */
		reclaimStructure(id: NodeId): void
		// Cold policy ops (never called from the hot walks).
		/** Marks a computed stale and propagates to its subs (settlement-invalidate). */
		invalidateComputed(c: NodeId): boolean
		/** Dispose a computed record (deps unlinked, subs detached, free deferred). */
		disposeComputed(c: NodeId): void
		/** Flag a computed machinery-owned (see {@link markMachineryOwnedOp}). */
		markMachineryOwned(c: NodeId): void
		/** Flags the node for observed-lifecycle delivery (NodeField.LIFECYCLE). */
		markLifecycle(id: NodeId): void
		/** True iff the currently-evaluating subscriber is a computed. */
		activeIsComputed(): boolean
	}

	/**
	 * Builds the kernel op table over a fresh arena of `records` records,
	 * optionally carrying the old arena's contents — growth is
	 * `E = createKernel(records * 2, E.buffer(), E.clocks())`; the instance
	 * header's "Closure rebuild" note covers what rebuilds vs. what survives.
	 */
	function createKernel(
		records: RecordCount,
		carry?: Int32Array,
		clockCarry?: Float64Array,
	): Kernel {
		const memory = new Int32Array(records * ArenaShape.STRIDE)
		// The clock column rides the arena's rebuild discipline (a push-grown
		// array would put a capacity check in the link allocator's hot path).
		const clocks = new Float64Array(records)
		// Function-scope aliases: bundlers demote module-scope const to var (no
		// TurboFan constant-folding); a closure const folds like `memory`.
		const vals = values
		const fnTab = fns
		const queue = queued
		const evalCtx = POLICY_CTX
		if (carry !== undefined) {
			memory.set(carry)
		}
		if (clockCarry !== undefined) {
			clocks.set(clockCarry)
		}
		// Allocators flag growth once the bump pointer crosses the watermark —
		// the fill level that keeps REC_SLACK records and half the arena free.
		const watermark = Math.min(
			memory.length >> ArenaShape.HALF_ARENA_SHIFT,
			memory.length - ArenaShape.REC_SLACK * ArenaShape.STRIDE,
		)
		if (recNext > watermark) {
			growPending = true
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
				memory[id + NodeField.FLAGS] = 0
				pendingFree.push(id)
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
				memory[id + NodeField.LIFECYCLE] = 1
			},
			activeIsComputed: () =>
				activeSub !== 0 && (memory[activeSub + NodeField.FLAGS] & NodeFlag.K_COMPUTED) !== 0,
		}

		// ---- allocation ----------------------------------------------------------

		function allocNode(flags: NodeFlags): NodeId {
			let id: NodeId
			if (nodeFreeHead !== 0) {
				// A reused slot keeps its NODE_INDEX — the new tenant inherits it,
				// which bounds index-keyed side tables by peak node count.
				id = nodeFreeHead
				nodeFreeHead = memory[id + NodeField.DEPS]
				memory[id + NodeField.DEPS] = 0
			} else {
				id = recNext as NodeId // the allocator's decision point: this record becomes a node
				if (id >= memory.length) {
					throw new Error(
						'cosignals: arena exhausted mid-operation; raise COSIGNAL_INITIAL_RECORDS',
					)
				}
				recNext = id + ArenaShape.STRIDE
				if (recNext > watermark) {
					growPending = true
				}
				memory[id + NodeField.NODE_INDEX] = nextNodeIndex++ // a never-yet-node slot gets a fresh index
			}
			memory[id + NodeField.FLAGS] = flags
			growNodeSideColumns(id) // every grown-together column covers the record (the layout region's coherence set)
			return id
		}

		function freeNode(id: NodeId): void {
			memory[id + NodeField.FLAGS] = 0
			memory[id + NodeField.LIFECYCLE] = 0
			memory[id + NodeField.DEPS_TAIL] = 0
			memory[id + NodeField.SUBS] = 0
			memory[id + NodeField.SUBS_TAIL] = 0
			++memory[id + NodeField.GEN]
			scrubNodeColumnsOnFree(id, clocks) // every declared column clears (the layout region's coherence set)
			memory[id + NodeField.DEPS] = nodeFreeHead // NODE_INDEX (field 7) deliberately survives — see NodeField
			nodeFreeHead = id
			// Hosts keying dense side tables by NODE_INDEX scrub the freed record's
			// rows here (after the GEN bump), before the slot's next tenant.
			__onRecordFree(id, memory[id + NodeField.NODE_INDEX])
		}

		/**
		 * Threads every pending disposed record onto the node free list (the
		 * boundary sweep's free phase; cold). A batch crossing both
		 * {@link MassTeardown} bounds frees in descending id order so pops come
		 * off ascending — dense reuse (measured: a 2M-node rebuild went from ~30s
		 * to build-from-fresh speed) — then {@link sortLinkFreeList} runs.
		 */
		function sweepPendingFree(): void {
			const n = pendingFree.length
			if (n > MassTeardown.MIN_BATCH && n * MassTeardown.MIN_ARENA_FRACTION >= recNext) {
				const batch = new Int32Array(n)
				for (let i = 0; i < n; ++i) {
					batch[i] = pendingFree[i]
				}
				batch.sort() // TypedArray sort is numeric ascending
				for (let i = n - 1; i >= 0; --i) {
					freeNode(batch[i])
				}
				sortLinkFreeList()
			} else {
				for (let i = 0; i < n; ++i) {
					freeNode(pendingFree[i])
				}
			}
			pendingFree.length = 0
		}

		/**
		 * Rethreads the link free list into ascending order after a mass teardown
		 * (cold; {@link sweepPendingFree}'s sorted branch only). One pass marks
		 * members in a bitmap; an ascending bitmap scan rethreads FREE_NEXT — no
		 * comparison sort, and the scan and stores ascend for hardware prefetch.
		 */
		function sortLinkFreeList(): void {
			let n = 0
			const words = new Uint32Array(((recNext >> ArenaShape.ID_TO_ORDINAL_SHIFT) + 32) >> 5)
			for (let id = linkFreeHead; id !== 0; id = memory[id + LinkField.FREE_NEXT]) {
				const rec = id >> ArenaShape.ID_TO_ORDINAL_SHIFT
				words[rec >> 5] |= 1 << (rec & 31)
				++n
			}
			if (n <= MassTeardown.MIN_BATCH) {
				return // below the mass bound: keep LIFO order, drop the bitmap
			}
			let head: LinkId = 0
			let tail: LinkId = 0 // last rethreaded id; 0 until the first member
			for (let w = 0; w < words.length; ++w) {
				let bits = words[w]
				while (bits !== 0) {
					const bit = bits & -bits
					bits ^= bit
					const id: LinkId = ((w << 5) + (31 - Math.clz32(bit))) << ArenaShape.ID_TO_ORDINAL_SHIFT
					if (tail === 0) {
						head = id
					} else {
						memory[tail + LinkField.FREE_NEXT] = id
					}
					tail = id
				}
			}
			memory[tail + LinkField.FREE_NEXT] = 0
			linkFreeHead = head
		}

		function allocLink(): LinkId {
			let id: LinkId
			if (linkFreeHead !== 0) {
				id = linkFreeHead
				linkFreeHead = memory[id + LinkField.FREE_NEXT]
			} else {
				id = recNext as LinkId // the allocator's decision point: this record becomes a link
				if (id >= memory.length) {
					throw new Error(
						'cosignals: arena exhausted mid-operation; raise COSIGNAL_INITIAL_RECORDS',
					)
				}
				recNext = id + ArenaShape.STRIDE
				if (recNext > watermark) {
					growPending = true
				}
			}
			return id
		}

		function freeLink(id: LinkId): void {
			scrubLinkColumnsOnFree(id, clocks) // a reused link must not carry the old tenant's clock stamp
			memory[id + LinkField.FREE_NEXT] = linkFreeHead
			linkFreeHead = id
		}

		// ---- upstream system.ts, transliterated -------------------------------------
		// "Upstream" throughout this file means alien-signals
		// (https://github.com/stackblitz/alien-signals): this kernel is its
		// push-pull algorithm re-expressed over arena records, and comments cite
		// its symbol names (ReactiveFlags, link(), Recursed, …) as the reference.
		// The world-arena sections re-derive these walks over their own layout on
		// purpose; suites, not prose, keep the twins in step — port rules, not text.

		/**
		 * Registers `sub`'s dependency on `dep` for this evaluation cycle. On
		 * re-track over unchanged deps this stays fast: the DEPS_TAIL cursor sits
		 * on `dep`, or its successor names `dep` and one write re-validates it.
		 * Link creation is out of line ({@link linkInsert}) to keep this body
		 * under V8's inlining bytecode budget; deps rarely change.
		 */
		function link(dep: NodeId, sub: NodeId, version: Version): void {
			const prevDep = memory[sub + NodeField.DEPS_TAIL]
			if (prevDep !== 0 && memory[prevDep + LinkField.DEP] === dep) {
				return
			}
			const nextDep =
				prevDep !== 0 ? memory[prevDep + LinkField.NEXT_DEP] : memory[sub + NodeField.DEPS]
			if (nextDep !== 0 && memory[nextDep + LinkField.DEP] === dep) {
				memory[nextDep + LinkField.VERSION] = version
				memory[sub + NodeField.DEPS_TAIL] = nextDep
				return
			}
			linkInsert(dep, sub, version, prevDep, nextDep)
		}

		/**
		 * Insertion tail of {@link link}: splices a new link record into the
		 * sub's dep list and the dep's subscriber list; out of line so the
		 * re-track fast path stays inlinable (upstream's monolithic link() was
		 * 475 bytecodes — never inlined into the read paths). The opening probe
		 * asks a different question than link: same dep read twice this run?
		 */
		function linkInsert(
			dep: NodeId,
			sub: NodeId,
			version: Version,
			prevDep: LinkId,
			nextDep: LinkId,
		): void {
			const prevSub = memory[dep + NodeField.SUBS_TAIL]
			if (
				prevSub !== 0 &&
				memory[prevSub + LinkField.VERSION] === version &&
				memory[prevSub + LinkField.SUB] === sub
			) {
				return
			}
			const newLink = allocLink()
			memory[sub + NodeField.DEPS_TAIL] = newLink
			memory[dep + NodeField.SUBS_TAIL] = newLink
			memory[newLink + LinkField.VERSION] = version
			memory[newLink + LinkField.DEP] = dep
			memory[newLink + LinkField.SUB] = sub
			memory[newLink + LinkField.PREV_DEP] = prevDep
			memory[newLink + LinkField.NEXT_DEP] = nextDep
			memory[newLink + LinkField.PREV_SUB] = prevSub
			memory[newLink + LinkField.NEXT_SUB] = 0
			if (nextDep !== 0) {
				memory[nextDep + LinkField.PREV_DEP] = newLink
			}
			if (prevDep !== 0) {
				memory[prevDep + LinkField.NEXT_DEP] = newLink
			} else {
				memory[sub + NodeField.DEPS] = newLink
			}
			if (prevSub !== 0) {
				memory[prevSub + LinkField.NEXT_SUB] = newLink
			} else {
				memory[dep + NodeField.SUBS] = newLink
			}
			// A new link to a lifecycle-flagged dep retains one observed-lifecycle
			// ref ({@link retainLifecycle}) unless the sub is machinery-owned.
			if (
				memory[dep + NodeField.LIFECYCLE] !== 0 &&
				!(memory[sub + NodeField.FLAGS] & NodeFlag.MACHINERY_OWNED)
			) {
				retainLifecycle(dep)
			}
		}

		/**
		 * Removes one link record from both lists it threads and frees it;
		 * returns the next dep link so purge loops can walk while unlinking. A
		 * dep losing its last subscriber runs {@link unwatched}; a lifecycle dep
		 * releases one ref per removed non-machinery link ({@link releaseLifecycle}).
		 */
		function unlink(id: LinkId, sub: NodeId = memory[id + LinkField.SUB]): LinkId {
			const dep = memory[id + LinkField.DEP]
			const prevDep = memory[id + LinkField.PREV_DEP]
			const nextDep = memory[id + LinkField.NEXT_DEP]
			const nextSub = memory[id + LinkField.NEXT_SUB]
			const prevSub = memory[id + LinkField.PREV_SUB]
			if (
				memory[dep + NodeField.LIFECYCLE] !== 0 &&
				!(memory[sub + NodeField.FLAGS] & NodeFlag.MACHINERY_OWNED)
			) {
				releaseLifecycle(dep)
			}
			if (nextDep !== 0) {
				memory[nextDep + LinkField.PREV_DEP] = prevDep
			} else {
				memory[sub + NodeField.DEPS_TAIL] = prevDep
			}
			if (prevDep !== 0) {
				memory[prevDep + LinkField.NEXT_DEP] = nextDep
			} else {
				memory[sub + NodeField.DEPS] = nextDep
			}
			if (nextSub !== 0) {
				memory[nextSub + LinkField.PREV_SUB] = prevSub
			} else {
				memory[dep + NodeField.SUBS_TAIL] = prevSub
			}
			freeLink(id)
			if (prevSub !== 0) {
				memory[prevSub + LinkField.NEXT_SUB] = nextSub
			} else if ((memory[dep + NodeField.SUBS] = nextSub) === 0) {
				unwatched(dep)
			}
			return nextDep
		}

		/**
		 * Pushes staleness down a written node's subscriber list: subscribers go
		 * Pending (checkDirty later verifies and upgrades to Dirty), watching
		 * effects queue via {@link notify}, mutable subscribers with their own
		 * subscribers descend on the scratch stack; `innerWrite` marks writes made
		 * during an effect run (upstream's Recursed). No try/finally: notify only
		 * queues, so nothing here can throw.
		 */
		function propagate(startLink: LinkId, innerWrite: boolean): void {
			let cur = startLink
			let next = memory[cur + LinkField.NEXT_SUB]
			const stackBase = propSp

			top: do {
				const sub = memory[cur + LinkField.SUB]
				let flags = memory[sub + NodeField.FLAGS]

				if (
					!(
						flags &
						(NodeFlag.RECURSED_CHECK | NodeFlag.RECURSED | NodeFlag.DIRTY | NodeFlag.PENDING)
					)
				) {
					memory[sub + NodeField.FLAGS] = flags | NodeFlag.PENDING
					if (innerWrite) {
						memory[sub + NodeField.FLAGS] |= NodeFlag.RECURSED
					}
				} else if (!(flags & (NodeFlag.RECURSED_CHECK | NodeFlag.RECURSED))) {
					flags = 0
				} else if (!(flags & NodeFlag.RECURSED_CHECK)) {
					memory[sub + NodeField.FLAGS] = (flags & ~NodeFlag.RECURSED) | NodeFlag.PENDING
				} else if (!(flags & (NodeFlag.DIRTY | NodeFlag.PENDING)) && isValidLink(cur, sub)) {
					memory[sub + NodeField.FLAGS] = flags | (NodeFlag.RECURSED | NodeFlag.PENDING)
					flags &= NodeFlag.MUTABLE
				} else {
					flags = 0
				}

				if (flags & NodeFlag.WATCHING) {
					notify(sub)
				}

				if (flags & NodeFlag.MUTABLE) {
					const subSubs = memory[sub + NodeField.SUBS]
					if (subSubs !== 0) {
						cur = subSubs
						const nextSub = memory[cur + LinkField.NEXT_SUB]
						if (nextSub !== 0) {
							if (propSp === propStack.length) {
								const bigger = new Int32Array(propStack.length * 2)
								bigger.set(propStack)
								propStack = bigger
							}
							propStack[propSp++] = next
							next = nextSub
						}
						continue
					}
				}

				if ((cur = next) !== 0) {
					next = memory[cur + LinkField.NEXT_SUB]
					continue
				}

				while (propSp > stackBase) {
					cur = propStack[--propSp]
					if (cur !== 0) {
						next = memory[cur + LinkField.NEXT_SUB]
						continue top
					}
				}

				break
			} while (true)
		}

		/**
		 * Answers "is this Pending sub actually stale?" by descending dep links
		 * and recomputing directly-dirty deps found (lazy pull). Entry wrapper:
		 * owns the scratch-stack restore (user getters can throw mid-walk) and
		 * the shallow/two-level/chain fast paths; {@link checkDirtyLoop} is the
		 * general walk. Split to keep each piece under V8's 460-bytecode inlining
		 * budget (the monolith was 537; small cones went 1.05-1.3x → 0.9-1.1x).
		 */
		function checkDirty(startLink: LinkId, startSub: NodeId): boolean {
			// Shallow fast path: the sub is already dirty, or its first dep is a
			// directly-dirty mutable (an effect one link from a written signal).
			if (memory[startSub + NodeField.FLAGS] & NodeFlag.DIRTY) {
				return true
			}
			const dep = memory[startLink + LinkField.DEP]
			const depFlags = memory[dep + NodeField.FLAGS]
			let tryChain = true
			if (
				(depFlags & (NodeFlag.MUTABLE | NodeFlag.DIRTY)) ===
				(NodeFlag.MUTABLE | NodeFlag.DIRTY)
			) {
				if (updateAndShallow(dep, memory[dep + NodeField.SUBS])) {
					// update() may run user code that disposes the sub mid-walk.
					return memory[startSub + NodeField.FLAGS] !== 0
				}
				const nextDep = memory[startLink + LinkField.NEXT_DEP]
				if (nextDep === 0) {
					return false
				}
				startLink = nextDep
			} else if (
				(depFlags & (NodeFlag.MUTABLE | NodeFlag.PENDING)) ===
				(NodeFlag.MUTABLE | NodeFlag.PENDING)
			) {
				const innerLink = memory[dep + NodeField.DEPS]
				if (memory[innerLink + LinkField.NEXT_DEP] !== 0) {
					// A diamond join (branching inner deps): only the general loop resolves it.
					tryChain = false
				} else {
					// Two-level case: the pending dep's sole dep is directly dirty.
					// Update the inner node, then recompute the dep or clear Pending.
					const inner = memory[innerLink + LinkField.DEP]
					if (
						(memory[inner + NodeField.FLAGS] & (NodeFlag.MUTABLE | NodeFlag.DIRTY)) ===
						(NodeFlag.MUTABLE | NodeFlag.DIRTY)
					) {
						if (updateAndShallow(inner, memory[inner + NodeField.SUBS])) {
							if (updateAndShallow(dep, memory[dep + NodeField.SUBS])) {
								return memory[startSub + NodeField.FLAGS] !== 0
							}
						} else {
							memory[dep + NodeField.FLAGS] &= ~NodeFlag.PENDING
						}
						const nextDep = memory[startLink + LinkField.NEXT_DEP]
						if (nextDep === 0) {
							return false
						}
						startLink = nextDep
					}
					// A single non-dirty inner link may still head a chain.
				}
			}
			// Unbranched single-dep/single-sub runs resolve stackless ({@link chainCheck}).
			if (tryChain && memory[startLink + LinkField.NEXT_DEP] === 0) {
				const r = chainCheck(startLink)
				if (r >= 0) {
					return r !== 0 && memory[startSub + NodeField.FLAGS] !== 0
				}
			}
			const stackBase = checkSp
			try {
				return checkDirtyLoop(startLink, startSub)
			} finally {
				checkSp = stackBase
			}
		}

		/**
		 * update() plus the sibling Pending→Dirty upgrade. `subs` is captured
		 * before update() runs: re-track may rebuild the subscriber list mid-call.
		 */
		function updateAndShallow(node: NodeId, subs: LinkId): boolean {
			if (update(node)) {
				if (memory[subs + LinkField.NEXT_SUB] !== 0) {
					shallowPropagate(subs)
				}
				return true
			}
			return false
		}

		/**
		 * Stackless {@link checkDirty} walk for pure chains — nodes with exactly
		 * one dep and one subscriber each. Descend while that holds; on finding a
		 * directly-dirty base, update back up by climbing each node's unique
		 * subscriber link. Returns 1 (dirty), 0 (resolved clean), -1 (not a
		 * chain; nothing mutated — the caller falls to the general loop).
		 */
		function chainCheck(startLink: LinkId): number {
			let link = startLink
			let depth = 0
			let dep = 0
			while (true) {
				dep = memory[link + LinkField.DEP]
				const flags = memory[dep + NodeField.FLAGS]
				if ((flags & (NodeFlag.MUTABLE | NodeFlag.DIRTY)) === (NodeFlag.MUTABLE | NodeFlag.DIRTY)) {
					break // dirty base found
				}
				if (
					(flags & (NodeFlag.MUTABLE | NodeFlag.PENDING)) !==
					(NodeFlag.MUTABLE | NodeFlag.PENDING)
				) {
					return -1 // clean or non-mutable dep: not a resolvable chain
				}
				const depDeps = memory[dep + NodeField.DEPS]
				if (depDeps === 0 || memory[depDeps + LinkField.NEXT_DEP] !== 0) {
					return -1 // branching deps
				}
				const depSubs = memory[dep + NodeField.SUBS]
				if (depSubs === 0 || memory[depSubs + LinkField.NEXT_SUB] !== 0) {
					return -1 // shared node: the climb needs a unique subscriber
				}
				link = depDeps
				++depth
			}
			if (depth === 0) {
				return -1 // directly-dirty first dep: the shallow paths own this
			}
			let changed = updateAndShallow(dep, memory[dep + NodeField.SUBS])
			let node = dep
			while (depth--) {
				const up = memory[node + NodeField.SUBS]
				const sub = memory[up + LinkField.SUB]
				if (changed) {
					changed = updateAndShallow(sub, memory[sub + NodeField.SUBS])
				} else {
					memory[sub + NodeField.FLAGS] &= ~NodeFlag.PENDING
				}
				node = sub
			}
			return changed ? 1 : 0
		}

		/**
		 * The general {@link checkDirty} walk, out of line (the wrapper owns the
		 * checkSp restore, so a throwing getter unwinds through it).
		 */
		function checkDirtyLoop(cur: LinkId, sub: NodeId): boolean {
			let checkDepth = 0
			let dirty = false

			top: do {
				const dep = memory[cur + LinkField.DEP]
				const depFlags = memory[dep + NodeField.FLAGS]

				if (memory[sub + NodeField.FLAGS] & NodeFlag.DIRTY) {
					dirty = true
				} else if (
					(depFlags & (NodeFlag.MUTABLE | NodeFlag.DIRTY)) ===
					(NodeFlag.MUTABLE | NodeFlag.DIRTY)
				) {
					if (updateAndShallow(dep, memory[dep + NodeField.SUBS])) {
						dirty = true
					}
				} else if (
					(depFlags & (NodeFlag.MUTABLE | NodeFlag.PENDING)) ===
					(NodeFlag.MUTABLE | NodeFlag.PENDING)
				) {
					if (checkSp === checkStack.length) {
						const bigger = new Int32Array(checkStack.length * 2)
						bigger.set(checkStack)
						checkStack = bigger
					}
					checkStack[checkSp++] = cur
					cur = memory[dep + NodeField.DEPS]
					sub = dep
					++checkDepth
					continue
				}

				if (!dirty) {
					const nextDep = memory[cur + LinkField.NEXT_DEP]
					if (nextDep !== 0) {
						cur = nextDep
						continue
					}
				}

				while (checkDepth--) {
					cur = checkStack[--checkSp]
					if (dirty) {
						if (updateAndShallow(sub, memory[sub + NodeField.SUBS])) {
							sub = memory[cur + LinkField.SUB]
							continue
						}
						dirty = false
					} else {
						memory[sub + NodeField.FLAGS] &= ~NodeFlag.PENDING
					}
					sub = memory[cur + LinkField.SUB]
					const nextDep = memory[cur + LinkField.NEXT_DEP]
					if (nextDep !== 0) {
						cur = nextDep
						continue top
					}
				}

				// Upstream `dirty && !!sub.flags`: flags reads 0 only if user code
				// inside update() disposed the sub mid-walk.
				return dirty && memory[sub + NodeField.FLAGS] !== 0
			} while (true)
		}

		/**
		 * One-level Pending→Dirty upgrade along a subscriber list after a node's
		 * value actually changed; watching subscribers queue via {@link notify}.
		 */
		function shallowPropagate(startLink: LinkId): void {
			let cur = startLink
			do {
				const sub = memory[cur + LinkField.SUB]
				const flags = memory[sub + NodeField.FLAGS]
				if ((flags & (NodeFlag.PENDING | NodeFlag.DIRTY)) === NodeFlag.PENDING) {
					memory[sub + NodeField.FLAGS] = flags | NodeFlag.DIRTY
					if ((flags & (NodeFlag.WATCHING | NodeFlag.RECURSED_CHECK)) === NodeFlag.WATCHING) {
						notify(sub)
					}
				}
			} while ((cur = memory[cur + LinkField.NEXT_SUB]) !== 0)
		}

		/**
		 * True iff `checkLink` still sits on `sub`'s dep list (propagate's guard
		 * against acting on a link a re-track already replaced).
		 */
		function isValidLink(checkLink: LinkId, sub: NodeId): boolean {
			let cur = memory[sub + NodeField.DEPS_TAIL]
			while (cur !== 0) {
				if (cur === checkLink) {
					return true
				}
				cur = memory[cur + LinkField.PREV_DEP]
			}
			return false
		}

		// ---- node update dispatch -----------------------------------------------------

		/** Recomputes a stale node by kind; returns true iff its value changed. */
		function update(node: NodeId): boolean {
			const flags = memory[node + NodeField.FLAGS]
			if (flags & NodeFlag.K_COMPUTED) {
				return updateComputed(node)
			}
			if (flags & NodeFlag.K_SIGNAL) {
				return updateSignal(node)
			}
			memory[node + NodeField.FLAGS] = (flags & NodeFlag.KIND_MASK) | NodeFlag.MUTABLE
			return true
		}

		/**
		 * Queues a watching effect and its still-watching ancestor chain for the
		 * next flush; the inserted segment reverses so outer effects run first.
		 */
		function notify(e: NodeId): void {
			let insertIndex = queuedLength
			const firstInsertedIndex = insertIndex

			do {
				queue[insertIndex++] = e
				memory[e + NodeField.FLAGS] &= ~NodeFlag.WATCHING
				const subs = memory[e + NodeField.SUBS]
				e = subs !== 0 ? memory[subs + LinkField.SUB] : 0
				if (e === 0 || !(memory[e + NodeField.FLAGS] & NodeFlag.WATCHING)) {
					break
				}
			} while (true)

			queuedLength = insertIndex

			let left = firstInsertedIndex
			while (left < --insertIndex) {
				const tmp = queue[left]
				queue[left++] = queue[insertIndex]
				queue[insertIndex] = tmp
			}
		}

		/**
		 * A node just lost its last subscriber: computeds strip (deps disposed,
		 * marked dirty — an unobserved cache is dead weight), signals re-poke a
		 * skipped reclamation ({@link noteReclaimRetry}), effects/scopes dispose.
		 * A mid-evaluation record (RECURSED_CHECK) never strips: DEPS_TAIL is its
		 * live re-track cursor, and freeing that link cycles the dep list (a hung
		 * walk); a truly-dead record strips at its next unwatched edge instead.
		 */
		function unwatched(node: NodeId): void {
			const flags = memory[node + NodeField.FLAGS]
			if (flags & NodeFlag.K_COMPUTED) {
				if (memory[node + NodeField.DEPS_TAIL] !== 0 && !(flags & NodeFlag.RECURSED_CHECK)) {
					memory[node + NodeField.FLAGS] =
						NodeFlag.K_COMPUTED |
						NodeFlag.MUTABLE |
						NodeFlag.DIRTY |
						(flags & NodeFlag.MACHINERY_OWNED) // ownership survives the rewrite
					disposeAllDepsInReverse(node)
				}
				// A guard-skipped reclaim re-attempts once its last subscriber unlinks.
				if (reclaimSkippedN !== 0) {
					noteReclaimRetry(node)
				}
			} else if (flags & NodeFlag.K_SIGNAL) {
				if (reclaimSkippedN !== 0) {
					noteReclaimRetry(node)
				}
			} else if (flags & (NodeFlag.K_EFFECT | NodeFlag.K_SCOPE)) {
				disposeEffect(node)
			}
		}

		/**
		 * Upstream's HasChildEffect slow path in updateComputed/run: unlink every
		 * dep that is not a signal/computed (i.e. child effects/scopes), in reverse.
		 */
		function unlinkChildEffects(sub: NodeId): void {
			let cur = memory[sub + NodeField.DEPS_TAIL]
			while (cur !== 0) {
				const prev = memory[cur + LinkField.PREV_DEP]
				const dep = memory[cur + LinkField.DEP]
				if (!(memory[dep + NodeField.FLAGS] & (NodeFlag.K_COMPUTED | NodeFlag.K_SIGNAL))) {
					unlink(cur, sub)
				}
				cur = prev
			}
		}

		/**
		 * Re-runs a computed's getter with tracking; returns true iff the cached
		 * outcome changed. The getter receives {@link POLICY_CTX}; a throw never
		 * corrupts graph state — the raw thrown value or pending thenable becomes
		 * the cached payload via the cold {@link storeThrown} hook.
		 */
		function updateComputed(c: NodeId): boolean {
			const oldFlags = memory[c + NodeField.FLAGS]
			if (oldFlags & NodeFlag.HAS_CHILD_EFFECT) {
				unlinkChildEffects(c)
			}
			memory[c + NodeField.DEPS_TAIL] = 0
			// Preserve the exceptional bits: the value slot holds the previous
			// outcome while the getter runs, and ctx.previous classifies it by them.
			memory[c + NodeField.FLAGS] =
				NodeFlag.K_COMPUTED |
				NodeFlag.MUTABLE |
				NodeFlag.RECURSED_CHECK |
				(oldFlags & (NodeFlag.HAS_BOX | NodeFlag.BOX_SUSPENDED | NodeFlag.MACHINERY_OWNED))
			const prevSub = activeSub
			activeSub = c
			++enterDepth
			const v: ValueIndex = c >> ArenaShape.ID_TO_VALUE_SHIFT
			const oldValue = vals[v]
			const oldExc: NodeFlags = oldFlags & (NodeFlag.HAS_BOX | NodeFlag.BOX_SUSPENDED)
			// Success clears the exceptional bits (folded into the finally's
			// RECURSED_CHECK clear); the catch overrides with the new outcome's bits.
			let keep = ~(NodeFlag.RECURSED_CHECK | NodeFlag.HAS_BOX | NodeFlag.BOX_SUSPENDED)
			try {
				++cycle
				// An outcome-bit delta is a change: threw undefined → returned
				// undefined must propagate, and a changed outcome moves the clock.
				if (
					oldValue !==
						(vals[v] = (fnTab[c >> ArenaShape.ID_TO_FN_SHIFT] as (ctx: unknown) => unknown)(
							evalCtx,
						)) ||
					oldExc !== 0
				) {
					clocks[c >> ArenaShape.ID_TO_CLOCK_SHIFT] = ++clockSource
					return true
				}
				return false
			} catch (e) {
				const bits = storeThrown(c, e, oldValue, oldExc)
				memory[c + NodeField.FLAGS] =
					(memory[c + NodeField.FLAGS] & ~(NodeFlag.HAS_BOX | NodeFlag.BOX_SUSPENDED)) | bits
				keep = ~NodeFlag.RECURSED_CHECK
				if (oldExc !== bits || oldValue !== vals[v]) {
					clocks[c >> ArenaShape.ID_TO_CLOCK_SHIFT] = ++clockSource
					return true
				}
				return false
			} finally {
				--enterDepth
				activeSub = prevSub
				memory[c + NodeField.FLAGS] &= keep
				purgeDeps(c)
			}
		}

		/**
		 * Promotes a dirty signal's pending value to current; returns true iff
		 * it differs. The flag store is the constant signal word — a live
		 * signal's flags are exactly K_SIGNAL|MUTABLE (±DIRTY) — no load needed.
		 */
		function updateSignal(s: NodeId): boolean {
			memory[s + NodeField.FLAGS] = NodeFlag.K_SIGNAL | NodeFlag.MUTABLE
			const v: ValueIndex = s >> ArenaShape.ID_TO_VALUE_SHIFT
			return vals[v] !== (vals[v] = vals[v + ArenaShape.AUX_VALUE_OFFSET])
		}

		/**
		 * Runs a queued effect if actually stale ({@link checkDirty} verifies
		 * Pending), re-arming its Watching bit either way; prior cleanup runs first.
		 */
		function run(e: NodeId): void {
			const flags = memory[e + NodeField.FLAGS]
			if (
				flags & NodeFlag.DIRTY ||
				(flags & NodeFlag.PENDING && checkDirty(memory[e + NodeField.DEPS], e))
			) {
				if (flags & NodeFlag.HAS_CHILD_EFFECT) {
					unlinkChildEffects(e)
				}
				const cv: ValueIndex = (e >> ArenaShape.ID_TO_VALUE_SHIFT) + ArenaShape.AUX_VALUE_OFFSET
				if (vals[cv]) {
					runCleanup(e)
					if (memory[e + NodeField.FLAGS] === 0) {
						return // disposed by its own cleanup
					}
				}
				memory[e + NodeField.DEPS_TAIL] = 0
				memory[e + NodeField.FLAGS] =
					NodeFlag.K_EFFECT | NodeFlag.WATCHING | NodeFlag.RECURSED_CHECK
				const prevSub = activeSub
				activeSub = e
				++enterDepth
				try {
					++cycle
					++runDepth
					vals[cv] = (fnTab[e >> ArenaShape.ID_TO_FN_SHIFT] as () => (() => void) | void)()
				} finally {
					--runDepth
					--enterDepth
					activeSub = prevSub
					memory[e + NodeField.FLAGS] &= ~NodeFlag.RECURSED_CHECK
					purgeDeps(e)
				}
			} else if (memory[e + NodeField.DEPS] !== 0) {
				memory[e + NodeField.FLAGS] =
					NodeFlag.K_EFFECT | NodeFlag.WATCHING | (flags & NodeFlag.HAS_CHILD_EFFECT)
			}
		}

		/** flush() abort path: re-arms effects still queued after a throw. */
		function requeueAbort(e: NodeId): void {
			if (memory[e + NodeField.FLAGS] & NodeFlag.KIND_MASK) {
				memory[e + NodeField.FLAGS] |= NodeFlag.WATCHING | NodeFlag.RECURSED
			}
		}

		/** Runs an effect's stored cleanup outside any tracking frame. */
		function runCleanup(e: NodeId): void {
			const cv: ValueIndex = (e >> ArenaShape.ID_TO_VALUE_SHIFT) + ArenaShape.AUX_VALUE_OFFSET
			const cleanup = vals[cv] as () => void
			vals[cv] = undefined
			const prevSub = activeSub
			activeSub = 0
			++enterDepth
			try {
				cleanup()
			} finally {
				--enterDepth
				activeSub = prevSub
			}
		}

		/**
		 * Disposes an effect or effect scope: deps unlink in reverse, the parent
		 * edge detaches (one unlink suffices — effects are unreadable, so SUBS
		 * holds at most that edge), pending cleanup runs, and the free defers to
		 * the boundary sweep.
		 */
		function disposeEffect(e: NodeId): void {
			const flags = memory[e + NodeField.FLAGS]
			if (!(flags & NodeFlag.KIND_MASK)) {
				return // already disposed
			}
			memory[e + NodeField.FLAGS] = 0
			disposeAllDepsInReverse(e)
			const sub = memory[e + NodeField.SUBS]
			if (sub !== 0) {
				unlink(sub)
			}
			if (
				flags & NodeFlag.K_EFFECT &&
				vals[(e >> ArenaShape.ID_TO_VALUE_SHIFT) + ArenaShape.AUX_VALUE_OFFSET]
			) {
				runCleanup(e)
			}
			// The queue or an in-flight walk may still hold this id: free at the sweep.
			pendingFree.push(e)
		}

		/** Unlinks every dep of `sub`, newest first (children before elders). */
		function disposeAllDepsInReverse(sub: NodeId): void {
			let cur = memory[sub + NodeField.DEPS_TAIL]
			while (cur !== 0) {
				const prev = memory[cur + LinkField.PREV_DEP]
				unlink(cur, sub)
				cur = prev
			}
		}

		/**
		 * Evaluation epilogue: unlinks every dep the re-track did not re-visit
		 * (everything past the DEPS_TAIL cursor is last run's leftovers).
		 */
		function purgeDeps(sub: NodeId): void {
			const depsTail = memory[sub + NodeField.DEPS_TAIL]
			let dep =
				depsTail !== 0 ? memory[depsTail + LinkField.NEXT_DEP] : memory[sub + NodeField.DEPS]
			while (dep !== 0) {
				dep = unlink(dep, sub)
			}
		}

		// ---- operations dispatched from the public wrappers ------------------------

		/**
		 * Registers a public handle with the reclamation registry so its record
		 * can be recovered if the handle is garbage-collected ({@link reclaimNode});
		 * the heldValue packs id and generation per {@link HeldValue}.
		 */
		function registerReclaim(target: object, id: NodeId): void {
			const reg = reclaimRegistry
			if (reg !== undefined) {
				const gen: Generation = memory[id + NodeField.GEN]
				reg.register(
					target,
					gen === 0
						? id
						: gen > 0 && gen < HeldValue.MAX_PACKED_GEN
							? gen * HeldValue.ID_SPAN + id
							: { id, gen },
				)
			}
		}

		function newSignal(value: unknown, target: object): NodeId {
			const id = allocNode(NodeFlag.K_SIGNAL | NodeFlag.MUTABLE)
			const v: ValueIndex = id >> ArenaShape.ID_TO_VALUE_SHIFT
			vals[v] = value // currentValue
			vals[v + ArenaShape.AUX_VALUE_OFFSET] = value // pendingValue
			registerReclaim(target, id)
			return id
		}

		function newComputed(getter: (ctx: unknown) => unknown, target: object): NodeId {
			const id = allocNode(NodeFlag.K_COMPUTED)
			fnTab[id >> ArenaShape.ID_TO_FN_SHIFT] = getter
			registerReclaim(target, id)
			return id
		}

		/**
		 * Creates an effect record and runs `fn` at once with tracking; an open
		 * parent frame gains the child-ownership edge (the effect links as its dep).
		 */
		function newEffect(fn: () => (() => void) | void): NodeId {
			const e = allocNode(NodeFlag.K_EFFECT | NodeFlag.WATCHING | NodeFlag.RECURSED_CHECK)
			fnTab[e >> ArenaShape.ID_TO_FN_SHIFT] = fn
			const prevSub = activeSub
			activeSub = e
			if (prevSub !== 0) {
				link(e, prevSub, 0)
				memory[prevSub + NodeField.FLAGS] |= NodeFlag.HAS_CHILD_EFFECT
			}
			++enterDepth
			try {
				++runDepth
				vals[(e >> ArenaShape.ID_TO_VALUE_SHIFT) + ArenaShape.AUX_VALUE_OFFSET] = fn()
			} finally {
				--runDepth
				--enterDepth
				activeSub = prevSub
				memory[e + NodeField.FLAGS] &= ~NodeFlag.RECURSED_CHECK
			}
			return e
		}

		/**
		 * Creates an effect-scope record and runs `fn` inside it, so effects
		 * created during the call link as the scope's deps and dispose with it.
		 */
		function newScope(fn: () => void): NodeId {
			const e = allocNode(NodeFlag.K_SCOPE | NodeFlag.MUTABLE)
			const prevSub = activeSub
			activeSub = e
			if (prevSub !== 0) {
				link(e, prevSub, 0)
				memory[prevSub + NodeField.FLAGS] |= NodeFlag.HAS_CHILD_EFFECT
			}
			++enterDepth
			try {
				fn()
			} finally {
				--enterDepth
				activeSub = prevSub
			}
			return e
		}

		/**
		 * Reads an atom record: promote a dirty pending value, register the
		 * dependency link when a tracking frame is open, serve the value slot.
		 */
		function readAtom(s: NodeId): unknown {
			if (memory[s + NodeField.FLAGS] & NodeFlag.DIRTY) {
				if (updateSignal(s)) {
					const subs = memory[s + NodeField.SUBS]
					if (subs !== 0) {
						shallowPropagate(subs)
					}
				}
			}
			if (activeSub !== 0) {
				link(s, activeSub, cycle)
			}
			return vals[s >> ArenaShape.ID_TO_VALUE_SHIFT]
		}

		/**
		 * Writes an atom record's pending value and propagates staleness; returns
		 * true iff subscribers were notified (the wrapper then flushes, so growth
		 * can run between queued effects; upstream flushes inline here). The flag
		 * store is the constant signal word ({@link updateSignal}'s rule).
		 */
		function write(s: NodeId, value: unknown): boolean {
			const p: ValueIndex = (s >> ArenaShape.ID_TO_VALUE_SHIFT) + ArenaShape.AUX_VALUE_OFFSET
			if (vals[p] !== (vals[p] = value)) {
				memory[s + NodeField.FLAGS] = NodeFlag.K_SIGNAL | NodeFlag.MUTABLE | NodeFlag.DIRTY
				// The clock moves at acceptance, not at pending→current promotion:
				// the node stays DIRTY until promoted; observers never clock-skip a dirty producer.
				clocks[s >> ArenaShape.ID_TO_CLOCK_SHIFT] = ++clockSource
				const subs = memory[s + NodeField.SUBS]
				if (subs !== 0) {
					propagate(subs, runDepth !== 0)
					return true
				}
			}
			return false
		}

		/**
		 * Reads a computed record — the clean-read fast path, split like
		 * {@link link}/{@link linkInsert}: the monolith sat past V8's 460-bytecode
		 * inline cliff (measured ~2.5ns extra per clean read). One mask test
		 * routes every non-trivial case to {@link computedReadSlow}.
		 */
		function computedRead(c: NodeId): unknown {
			const flags = memory[c + NodeField.FLAGS]
			if (
				flags & (NodeFlag.RECURSED_CHECK | NodeFlag.DIRTY | NodeFlag.PENDING | NodeFlag.HAS_BOX) ||
				!(flags & NodeFlag.MUTABLE) // never evaluated (upstream `!flags`; exact-compare broke when the ownership bit joined the word)
			) {
				return computedReadSlow(c, flags)
			}
			if (activeSub !== 0) {
				link(c, activeSub, cycle)
			}
			return vals[c >> ArenaShape.ID_TO_VALUE_SHIFT]
		}

		/**
		 * The full computedRead decision ladder, out of line — five stages marked
		 * below: cycle, staleness, first evaluation, linking, boxed unwrap.
		 */
		function computedReadSlow(c: NodeId, flags: NodeFlags): unknown {
			// Stage 1 — cycle fast-out (upstream returns the stale cache instead).
			if (flags & NodeFlag.RECURSED_CHECK) {
				throw new CycleError(
					'cosignals: computed read during its own evaluation (dependency cycle).',
				)
			}
			// Stage 2 — staleness: dirty recomputes; Pending verifies via checkDirty.
			if (
				flags & NodeFlag.DIRTY ||
				(flags & NodeFlag.PENDING &&
					(checkDirty(memory[c + NodeField.DEPS], c) ||
						((memory[c + NodeField.FLAGS] = flags & ~NodeFlag.PENDING), false)))
			) {
				if (updateComputed(c)) {
					const subs = memory[c + NodeField.SUBS]
					if (subs !== 0) {
						shallowPropagate(subs)
					}
				}
			} else if (!(flags & NodeFlag.MUTABLE)) {
				// Stage 3 — first evaluation: run the getter with tracking; a throw
				// stores the raw payload as the cached outcome (cold catch).
				memory[c + NodeField.FLAGS] =
					NodeFlag.K_COMPUTED |
					NodeFlag.MUTABLE |
					NodeFlag.RECURSED_CHECK |
					(flags & NodeFlag.MACHINERY_OWNED)
				const prevSub = activeSub
				activeSub = c
				++enterDepth
				try {
					vals[c >> ArenaShape.ID_TO_VALUE_SHIFT] = (
						fnTab[c >> ArenaShape.ID_TO_FN_SHIFT] as (ctx: unknown) => unknown
					)(evalCtx)
				} catch (e) {
					memory[c + NodeField.FLAGS] |= storeThrown(c, e, undefined, 0)
				} finally {
					--enterDepth
					activeSub = prevSub
					memory[c + NodeField.FLAGS] &= ~NodeFlag.RECURSED_CHECK
				}
				// A first evaluation is a fresh outcome: the clock moves from 0 ("never").
				clocks[c >> ArenaShape.ID_TO_CLOCK_SHIFT] = ++clockSource
			}
			// Stage 4 — link before any rethrow, so recovery re-notifies the observer.
			const sub = activeSub
			if (sub !== 0) {
				link(c, sub, cycle)
			}
			// Stage 5 — boxed unwrap ({@link boxedRead}): rethrow / self-heal / SuspendedRead.
			const f = memory[c + NodeField.FLAGS]
			if (f & NodeFlag.HAS_BOX) {
				return boxedRead(c, f)
			}
			return vals[c >> ArenaShape.ID_TO_VALUE_SHIFT]
		}

		/**
		 * Settlement-invalidate: marks the computed stale exactly as a dep write
		 * would and propagates; the wrapper flushes. Cold.
		 */
		function invalidateComputed(c: NodeId): boolean {
			const flags = memory[c + NodeField.FLAGS]
			if (!(flags & NodeFlag.K_COMPUTED)) {
				return false
			}
			memory[c + NodeField.FLAGS] = flags | NodeFlag.DIRTY
			const subs = memory[c + NodeField.SUBS]
			if (subs !== 0) {
				propagate(subs, runDepth !== 0)
				return true
			}
			return false
		}

		/**
		 * Flags a computed {@link NodeFlag.MACHINERY_OWNED} and settles the
		 * books: links made before the flag each retained a lifecycle ref at
		 * insert, and their eventual unlinks will skip the release (the flag
		 * reads at unlink time) — so release those refs here, once.
		 */
		function markMachineryOwnedOp(c: NodeId): void {
			const flags = memory[c + NodeField.FLAGS]
			if (!(flags & NodeFlag.K_COMPUTED) || flags & NodeFlag.MACHINERY_OWNED) {
				return
			}
			memory[c + NodeField.FLAGS] = flags | NodeFlag.MACHINERY_OWNED
			let l = memory[c + NodeField.DEPS]
			while (l !== 0) {
				const dep = memory[l + LinkField.DEP]
				if (memory[dep + NodeField.LIFECYCLE] !== 0) {
					releaseLifecycle(dep)
				}
				l = memory[l + LinkField.NEXT_DEP]
			}
		}

		/**
		 * Reclamation's structural phase: the caller ({@link reclaimNode})
		 * verified epoch, tenancy generation, every guard, and that no kernel
		 * frame is open. Flags zero first (dead before any unlink probe sees the
		 * record); a computed's deps dispose and residual subs detach defensively
		 * (signals own no outgoing structure — their links live on subscribers).
		 */
		function reclaimStructureOp(id: NodeId): void {
			const flags = memory[id + NodeField.FLAGS]
			memory[id + NodeField.FLAGS] = 0
			if (flags & NodeFlag.K_COMPUTED) {
				disposeAllDepsInReverse(id)
				let l = memory[id + NodeField.SUBS]
				while (l !== 0) {
					const next = memory[l + LinkField.NEXT_SUB]
					unlink(l)
					l = next
				}
			}
		}

		/**
		 * Computed disposal (the useComputed deps-change path; cold). Flags zero
		 * first so the last unlink's {@link unwatched} probe sees a dead record;
		 * remaining subscriber links detach (their subs simply lose the dep — the
		 * caller guarantees the node is superseded); the free defers to the
		 * boundary sweep, where freeNode bumps GEN.
		 */
		function disposeComputedOp(c: NodeId): void {
			if (!(memory[c + NodeField.FLAGS] & NodeFlag.K_COMPUTED)) {
				return // not a computed / already disposed
			}
			memory[c + NodeField.FLAGS] = 0
			disposeAllDepsInReverse(c)
			let l = memory[c + NodeField.SUBS]
			while (l !== 0) {
				const next = memory[l + LinkField.NEXT_SUB]
				unlink(l)
				l = next
			}
			pendingFree.push(c)
		}
	}

	// ---- UpdatedAt clocks ----------------------------------------------------------
	// Every record owns one {@link Clock} slot in the `clocks` column: a fast
	// negative guard for observers, never a dirty-state or value substitute. A
	// signal/computed slot is its durable updatedAt: it moves on an accepted atom
	// write and on an evaluation whose tagged outcome — value, thrown, or
	// suspended — changed (including the first evaluation; an error-to-value flip
	// with an identity-equal payload counts). A watcher/SignalEffect slot
	// (observer records, later) is its lastValidatedAt; link slots stay unused.
	//
	// An observer may skip a clean producer whose per-root committed clock,
	// settled at consult time by {@link settleObserverClock}, still matches the
	// observer's lastValidatedAt; a settled clock that differs re-fires with no
	// value comparison — at-least-once by design (a net-no-change run settled
	// midway by another consult re-fires spuriously).

	/**
	 * The clock counter: the last stamp drawn; bump sites store `++clockSource`.
	 * Module-level so a rebuilt kernel resumes the sequence. Float64 in its own
	 * column: an observer can hold a stamp for the whole process, so a wrapping
	 * u32 would collide; not FLAGS bits, whose hot stores must stay constants.
	 */
	let clockSource: Clock = 0

	// ---- the live op table + growth ------------------------------------------------

	// Capacity floor resolution (constants + env parse are module-level):
	//   1. an explicit `initialRecords` option wins;
	//   2. else the COSIGNAL_INITIAL_RECORDS env override;
	//   3. else SMALL — the arena grows on demand, so a fresh instance stays
	//      tiny. The DEFAULT browser instance passes DEFAULT_INITIAL_RECORDS
	//      explicitly (see `createCosignals({ initialRecords: ... })` at the
	//      default-instance construction), keeping its behavior unchanged.
	const initialRecords = (() => {
		const explicit = options?.initialRecords
		if (explicit !== undefined) {
			return Number.isFinite(explicit) && explicit >= MIN_INITIAL_RECORDS
				? Math.ceil(explicit)
				: SMALL_INITIAL_RECORDS
		}
		return readEnvInitialRecords() ?? SMALL_INITIAL_RECORDS
	})()

	// A configured unit budgets one node + two link records; configure({initialRecords}) raises this floor.
	let desiredRecords: RecordCount = initialRecords * ArenaShape.RECORDS_PER_UNIT

	/**
	 * The fold-purity table: every op throws the fold error ({@link throwFold});
	 * requeueAbort no-ops so {@link flush}'s finally can never mask one. Its shape
	 * is deliberately distinct from {@link createKernel}'s: the live table must
	 * stay the sole instance of its V8 hidden class (V8's layout record) so `E.op`
	 * call targets stay constant and inlined — sharing one class cost +15-25% on
	 * recompute/read-heavy workloads; only erroring folds ever dispatch through it.
	 */
	const POISON: Kernel = {
		records: 2,
		buffer: foldPoisonOp,
		clocks: foldPoisonOp,
		newSignal: foldPoisonOp,
		newComputed: foldPoisonOp,
		newEffect: foldPoisonOp,
		newScope: foldPoisonOp,
		newObserver: foldPoisonOp,
		disposeObserver: foldPoisonOp,
		gen: foldPoisonOp,
		readAtom: foldPoisonOp,
		write: foldPoisonOp,
		computedRead: foldPoisonOp,
		run: foldPoisonOp,
		requeueAbort: foldNoop,
		disposeEffect: foldPoisonOp,
		sweepPendingFree: foldPoisonOp,
		reclaimStructure: foldPoisonOp,
		invalidateComputed: foldPoisonOp,
		disposeComputed: foldPoisonOp,
		markMachineryOwned: foldPoisonOp,
		markLifecycle: foldPoisonOp,
		activeIsComputed: foldPoisonOp,
	}

	/**
	 * The kernel op table — the one mutable slot every consumer dispatches
	 * through; re-linked only by {@link boundaryWork}'s growth and the fold-guard pair.
	 */
	let E: Kernel = createKernel(initialRecords * ArenaShape.RECORDS_PER_UNIT)

	/** Runs {@link boundaryWork} iff at an operation boundary with deferred work queued. */
	function maybeBoundary(): void {
		if (
			enterDepth === 0 &&
			(growPending || pendingFree.length !== 0 || reclaimWorkPending === true)
		) {
			boundaryWork()
		}
	}

	/**
	 * The plain kernel write: the tail of every public write path whose atom has
	 * no concurrent content. `isEqual(current, incoming)` decides acceptance once,
	 * here: this path has no write history, so a write equal to the atom's pending
	 * value drops (atoms with concurrent content take {@link writeAtomConcurrent}). @internal
	 */
	function writeAtom(
		id: NodeId,
		isEqual: ((a: unknown, b: unknown) => boolean) | undefined,
		value: unknown,
	): void {
		if (
			isEqual !== undefined &&
			isEqual(values[(id >> ArenaShape.ID_TO_VALUE_SHIFT) + ArenaShape.AUX_VALUE_OFFSET], value)
		) {
			return
		}
		maybeBoundary()
		if (E.write(id, value) && batchDepth === 0) {
			flush()
		}
	}

	/**
	 * The operation-boundary work: reclamation drain, the pending-free sweep,
	 * then growth by closure rebuild. Only {@link maybeBoundary} calls this.
	 */
	function boundaryWork(): void {
		// Reclamation first: each drained entry ends with its record's free-list
		// insertion, so the sweep below frees everything this boundary produced.
		if (reclaimWorkPending === true) {
			drainReclaimWork()
		}
		// Sweep only while no effects are queued: freeing a record a stale queue
		// entry still references would let a new tenant of the id be run() by it.
		if (pendingFree.length !== 0 && queuedLength === 0) {
			E.sweepPendingFree()
		}
		if (growPending) {
			growPending = false
			let records = E.records
			while (
				records < desiredRecords ||
				recNext >
					Math.min(
						(records * ArenaShape.STRIDE) >> ArenaShape.HALF_ARENA_SHIFT,
						(records - ArenaShape.REC_SLACK) * ArenaShape.STRIDE,
					)
			) {
				records *= 2
			}
			if (records !== E.records) {
				E = createKernel(records, E.buffer(), E.clocks())
			}
		}
	}

	/**
	 * Drains the effect queue ({@link queued}), running each entry through the
	 * op table; a throw re-arms the rest via requeueAbort so no entry is lost.
	 * Deferred work runs only before the loop: user code inside holds enterDepth
	 * >= 1, so E cannot swap mid-loop (the `kernel` alias is sound), and the
	 * watermark leaves {@link ArenaShape.REC_SLACK} (1280) free records at start
	 * (cascades measure ~tens of new records; overrunning the arena throws in the allocator).
	 */
	function flush(): void {
		maybeBoundary()
		const kernel = E
		const queue = queued // function-scope alias survives bundling (see createKernel note)
		try {
			while (notifyIndex < queuedLength) {
				const e = queue[notifyIndex]
				queue[notifyIndex++] = 0
				kernel.run(e)
			}
		} finally {
			while (notifyIndex < queuedLength) {
				const e = queue[notifyIndex]
				queue[notifyIndex++] = 0
				E.requeueAbort(e)
			}
			notifyIndex = 0
			queuedLength = 0
		}
		// A core effect run here may have issued a quiet write that owed the
		// committed-world boundary drain (it could not run inline inside the
		// kernel frame). Now that the outermost flush's frames have closed
		// (enterDepth back to 0), run it — but only when this flush is NOT nested
		// inside a public write operation (opDepth 0): that operation's own tail
		// owns the drain and runs it after ITS committed-truth fan, so draining
		// here first would scan before that fan lands. drainQuietBoundary's own
		// enterDepth check makes re-entrant (mid-effect) flushes no-op.
		if (opDepth === 0) {
			drainQuietBoundary()
		}
	}

	function throwFold(): never {
		throw new Error(
			'cosignals: signal reads and writes are not allowed inside an update() updater or a reducer — read before dispatch instead.',
		)
	}

	function foldPoisonOp(): never {
		throwFold()
	}

	function foldNoop(): void {}

	/**
	 * A batch groups the writes of one logical update: effects flush once, when
	 * the outermost batch closes. Nothing else in the library groups implicitly.
	 */
	function batch<T>(fn: () => T): T {
		++batchDepth
		try {
			return fn()
		} finally {
			if (!--batchDepth && notifyIndex < queuedLength) {
				flush()
			}
		}
	}

	/** Low-level batch surface for adapter/bindings plumbing; prefer {@link batch}. */
	function startBatch(): void {
		++batchDepth
	}

	function endBatch(): void {
		if (!--batchDepth && notifyIndex < queuedLength) {
			flush()
		}
	}

	/** Reads inside `fn` register no dependency edges. */
	let worldUntrackedDepth = 0
	let worldUntrackedShadow = 0

	function untracked<T>(fn: () => T): T {
		const prevSub = activeSub
		const prevShadow = worldUntrackedShadow
		activeSub = 0
		worldUntrackedDepth++
		worldUntrackedShadow = arenaFrameShadow
		try {
			return fn()
		} finally {
			worldUntrackedShadow = prevShadow
			worldUntrackedDepth--
			activeSub = prevSub
		}
	}

	// ---- mechanism halves of runFold and configure ------------------------------------

	/**
	 * Swaps {@link E} to {@link POISON} for runFold's bracket; returns
	 * the live table for the paired {@link foldGuardRestore}.
	 */
	function foldGuardSwap(): Kernel {
		const saved = E
		E = POISON
		return saved
	}

	function foldGuardRestore(saved: Kernel): void {
		E = saved
	}

	/**
	 * Raises the capacity floor to `units` configured units and schedules growth
	 * at the next operation boundary — configure's kernel half. Never shrinks.
	 */
	function requestCapacity(units: RecordCount): void {
		const target = units * ArenaShape.RECORDS_PER_UNIT
		if (target > desiredRecords) {
			desiredRecords = target
		}
		if (E.records < desiredRecords) {
			growPending = true
			maybeBoundary()
		}
	}

	/**
	 * The concurrent machinery's equality-free write tail: its callers already
	 * decided acceptance, and re-running `isEqual` would double-invoke it.
	 */
	function writeNewest(id: NodeId, value: unknown): void {
		maybeBoundary()
		if (E.write(id, value) && batchDepth === 0) {
			flush()
		}
	}

	// ---- the computed evaluation policy (exceptions and suspense) --------------------

	/**
	 * A computed getter can throw, or it can SUSPEND: read async data that is
	 * not ready yet (`ctx.use` on a pending thenable). Rather than make every
	 * caller handle both, the engine boxes the outcome — the raw payload (the
	 * thrown value, or the pending thenable) goes in the node's {@link values}
	 * slot, marked by NodeFlag.HAS_BOX plus BOX_SUSPENDED for suspensions.
	 * This section writes the box, reads it back, wakes suspended computeds on
	 * settlement, and implements {@link POLICY_CTX}'s two members. All of it
	 * is cold: reads route on HAS_BOX — never `instanceof` on a hot path
	 * (measured ~9ns each; 2.4× on read-heavy workloads) — and a computed
	 * that never throws or suspends never reaches this section.
	 */

	// SuspendedRead is a module-level class (see its definition above
	// createCosignals): one shared marker so `instanceof SuspendedRead` works
	// for suspensions from any instance.

	type InstrumentedThenable = PromiseLike<unknown> & {
		status?: 'pending' | 'fulfilled' | 'rejected'
		value?: unknown
		reason?: unknown
		/**
		 * The thenable's stable {@link SuspendedRead}, created lazily at first
		 * pending read: every site throws this one instance (dedupe by identity).
		 */
		suspendSentinel?: SuspendedRead
	}

	/**
	 * `ctx.previous`: the evaluating computed's previous cached value. While
	 * the getter runs, the value slot still holds it and any boxed-outcome bits
	 * stay set ({@link updateComputed}'s eval-start rewrite), so one flag test
	 * filters both "not a computed" and "residual boxed payload" as undefined.
	 */
	function ctxPrevious(): unknown {
		const c = activeSub
		if (c === 0) {
			return undefined
		}
		if (
			(E.buffer()[c + NodeField.FLAGS] & (NodeFlag.K_COMPUTED | NodeFlag.HAS_BOX)) !==
			NodeFlag.K_COMPUTED
		) {
			return undefined
		}
		return values[c >> ArenaShape.ID_TO_VALUE_SHIFT]
	}

	/**
	 * The thenable protocol (mirrors React's trackUsedThenable): instrument
	 * `status`/`value`/`reason` onto the thenable itself, once. Settled
	 * thenables return their value or throw their reason synchronously;
	 * pending ones throw the thenable's stable {@link SuspendedRead}.
	 */
	function unwrapThenable(t: InstrumentedThenable): unknown {
		switch (t.status) {
			case 'fulfilled':
				return t.value
			case 'rejected':
				throw t.reason
			case 'pending':
				throw (t.suspendSentinel ??= new SuspendedRead(t))
			default: {
				t.status = 'pending'
				t.then(
					(v: unknown) => {
						if (t.status === 'pending') {
							t.status = 'fulfilled'
							t.value = v
							// settleTap (the settlement section's hook) runs at fire
							// time over current engine state, so a thenable that
							// outlives an engine reset notifies the current engine.
							settleTap(t)
						}
					},
					(e: unknown) => {
						if (t.status === 'pending') {
							t.status = 'rejected'
							t.reason = e
							settleTap(t)
						}
					},
				)
				throw (t.suspendSentinel ??= new SuspendedRead(t))
			}
		}
	}

	/**
	 * Stable serialization of a `ctx.use` key: scalars serialize with a type
	 * discriminant (`1` vs `'1'` stay distinct), arrays recurse; anything else throws.
	 */
	function serializeUseKey(key: unknown): string {
		if (typeof key === 'string') {
			return JSON.stringify(key)
		}
		if (typeof key === 'number' || typeof key === 'boolean' || key === null) {
			return String(key)
		}
		if (Array.isArray(key)) {
			let out = '['
			for (let i = 0; i < key.length; i++) {
				if (i !== 0) {
					out += ','
				}
				out += serializeUseKey(key[i])
			}
			return out + ']'
		}
		throw new Error(
			'cosignals: ctx.use keys must be strings, numbers, booleans, null, or arrays of those — ' +
				`got ${typeof key}. Put the serializable inputs in the key and close over the rest in the factory.`,
		)
	}

	/**
	 * The ctx.use request caches, keyed by node index — never by handle, so
	 * nothing here pins one — and scrubbed at record free so a slot's next
	 * tenant never sees its predecessor's requests. A Map deliberately:
	 * ctx.use is cold, and the map's delete is the scrub.
	 */
	const useCaches = new Map<number, Map<string, PromiseLike<unknown>>>()

	/** The record-free scrub's suspense half: drop the freed record's request cache. @internal */
	function __clearUseCacheForIndex(nodeIndex: number): void {
		useCaches.delete(nodeIndex)
	}

	/** Test-only (`__TEST__resetEngine`): every request cache drops. @internal */
	function __TEST__resetSuspense(): void {
		useCaches.clear()
	}

	/** Test seam: a record's ctx.use request cache, by node index. @internal */
	function __TEST__useCache(nodeIndex: number): Map<string, PromiseLike<unknown>> | undefined {
		return useCaches.get(nodeIndex)
	}

	/**
	 * The one ctx.use implementation (contract: {@link ComputedCtx.use}):
	 * unwrap a thenable directly, or cache the factory's thenable per key.
	 * World evaluation contexts share it, passing their node's index. The cache
	 * is monotone — same key ⇒ same thenable for the record's life — safe
	 * across worlds because the key carries the world-varying inputs. @internal
	 */
	function ctxUseKeyed(
		nodeIndex: number,
		sourceOrKey: unknown,
		factory: (() => PromiseLike<unknown>) | undefined,
	): unknown {
		if (factory === undefined) {
			const t = sourceOrKey as InstrumentedThenable
			if (
				t === null ||
				(typeof t !== 'object' && typeof t !== 'function') ||
				typeof t.then !== 'function'
			) {
				throw new Error(
					typeof sourceOrKey === 'function'
						? 'cosignals: the bare factory form ctx.use(fn) was removed — pass ctx.use(key, factory) so the request is cached per key, or cache the promise yourself and pass ctx.use(promise).'
						: 'cosignals: ctx.use takes a thenable, or (key, factory).',
				)
			}
			return unwrapThenable(t)
		}
		if (typeof factory !== 'function') {
			throw new Error('cosignals: ctx.use(key, factory) requires a factory function.')
		}
		const k = serializeUseKey(sourceOrKey)
		let cache = useCaches.get(nodeIndex)
		if (cache === undefined) {
			cache = new Map()
			useCaches.set(nodeIndex, cache)
		}
		let t = cache.get(k)
		if (t === undefined) {
			t = factory()
			if (
				t === null ||
				(typeof t !== 'object' && typeof t !== 'function') ||
				typeof t.then !== 'function'
			) {
				throw new Error('cosignals: the ctx.use factory must return a thenable.')
			}
			cache.set(k, t)
		}
		return unwrapThenable(t)
	}

	// Test-only export: suites drive the request cache directly.
	const __TEST__ctxUse = ctxUseKeyed

	/**
	 * `ctx.use`: resolve the evaluating computed from the kernel's `activeSub`
	 * and dispatch on its node index. The cache dies with the record — a
	 * recreated computed refetches; callers needing dedup beyond that cache the
	 * promise in their data layer and pass it via the one-arg form.
	 */
	function ctxUse(
		sourceOrKey: unknown,
		factory: (() => PromiseLike<unknown>) | undefined,
	): unknown {
		const c = activeSub
		if (c === 0 || (E.buffer()[c + NodeField.FLAGS] & NodeFlag.K_COMPUTED) === 0) {
			throw new Error('cosignals: ctx.use may only be called during a computed evaluation.')
		}
		return ctxUseKeyed(E.buffer()[c + NodeField.NODE_INDEX], sourceOrKey, factory)
	}

	/**
	 * The kernel's exception hook (cold): store what the evaluation threw —
	 * the thrown value, or a suspension's pending thenable — as the raw cached
	 * payload, and return the outcome's flag bits for the caller to fold into
	 * the node's flags and change cutoff. A settle listener attaches only on
	 * transition, so re-suspending on the same pending thenable never stacks listeners.
	 */
	function storeThrown(c: NodeId, e: unknown, oldValue: unknown, oldExc: NodeFlags): NodeFlags {
		const v: ValueIndex = c >> ArenaShape.ID_TO_VALUE_SHIFT
		if (e instanceof SuspendedRead) {
			const t = e.thenable as InstrumentedThenable
			values[v] = t
			if ((oldExc & NodeFlag.BOX_SUSPENDED) === 0 || oldValue !== t) {
				attachSettleListener(c, t)
			}
			return NodeFlag.HAS_BOX | NodeFlag.BOX_SUSPENDED
		}
		values[v] = e
		return NodeFlag.HAS_BOX
	}

	/**
	 * When a suspended computed's pending thenable settles, mark the computed
	 * stale and propagate, so watchers re-run and readers recompute. The
	 * listener is stale-guarded: unless the node still caches this exact
	 * thenable as a suspension, a late settlement of superseded work is inert.
	 */
	function attachSettleListener(c: NodeId, t: InstrumentedThenable): void {
		// Capture the engine epoch: a settlement delivered after a test's engine
		// reset must not touch the scrubbed arena (ids may have new tenants).
		const epoch = engineEpoch
		const onSettle = (): void => {
			if (epoch !== engineEpoch) {
				return // a dead test's settlement — the engine it targeted is gone
			}
			if (
				(E.buffer()[c + NodeField.FLAGS] & NodeFlag.BOX_SUSPENDED) === 0 ||
				values[c >> ArenaShape.ID_TO_VALUE_SHIFT] !== t
			) {
				return
			}
			try {
				maybeBoundary()
				E.invalidateComputed(c)
				if (batchDepth === 0) {
					flush()
				}
			} catch (err) {
				// Effects that throw during the settle flush surface as unhandled
				// errors, not rejections of the settled chain. Epoch-guarded: after
				// a reset the erroring engine is gone; rethrowing would misattribute.
				queueMicrotask(() => {
					if (epoch !== engineEpoch) {
						return
					}
					throw err
				})
			}
		}
		t.then(onSettle, onSettle)
	}

	/**
	 * The kernel's read tail when HAS_BOX is set: the cached value is a raw
	 * boxed payload. Errors rethrow it; pending suspensions throw the thenable's
	 * stable {@link SuspendedRead}; settled suspensions self-heal (invalidate +
	 * recompute) so a read after `await` is deterministic even before the settle
	 * listener's microtask runs. The self-heal recurses at most once: settlement
	 * cannot occur mid-frame, so a re-stored payload is pending and throws.
	 */
	function boxedRead(c: NodeId, flags: NodeFlags): unknown {
		const v: ValueIndex = c >> ArenaShape.ID_TO_VALUE_SHIFT
		if ((flags & NodeFlag.BOX_SUSPENDED) === 0) {
			throw values[v]
		}
		const t = values[v] as InstrumentedThenable
		if (t.status === undefined || t.status === 'pending') {
			throw (t.suspendSentinel ??= new SuspendedRead(t))
		}
		E.invalidateComputed(c)
		const next = E.computedRead(c)
		if (batchDepth === 0) {
			flush()
		}
		return next
	}

	// ---- the observed lifecycle (AtomOptions.effect) ---------------------------------

	/**
	 * An atom constructed with AtomOptions.effect carries an observed-lifecycle
	 * callback: it runs when the atom gains its first consumer, and its
	 * returned cleanup runs when the last one leaves. Consumers are counted as
	 * one union refcount: kernel subscribers (live computed chains and core
	 * effects), committed SignalEffect edges, and live UI watchers. Transitions apply through a microtask
	 * queue, so observe/unobserve flaps within one tick (StrictMode
	 * double-mounts, remounts) coalesce to nothing.
	 *
	 * All state is id-keyed and handle-free, so reclamation (the last section)
	 * can free records whose public handles were garbage-collected. A dormant
	 * atom (unwatched, nothing pending) owns no map entry: its callback sits in
	 * the record's otherwise-unused `fns` slot, and hot paths gate on
	 * {@link NodeField.LIFECYCLE}, so atoms without the option pay nothing. The
	 * first retain rehydrates an active {@link LifecycleState} from that slot,
	 * held strongly until cleanup runs and nothing is pending (an active effect
	 * must clean up at unmount regardless of handle reachability).
	 */

	type LifecycleState = {
		/** The atom's record id (the map key, carried for the dormancy delete). */
		id: NodeId
		effect: (ctx: AtomCtx<unknown>) => void | (() => void)
		ctx: AtomCtx<unknown>
		cleanup: (() => void) | undefined
		/** Union refcount: live non-machinery kernel links + live watchers. */
		refs: number
		/** Desired state as of the last union transition (refs > 0). */
		wantMounted: boolean
		/** Actual state (effect has run and not been cleaned up). */
		isMounted: boolean
		scheduled: boolean
	}

	/** Active records by id: present while watched or a transition is pending. */
	const lifecycleStates = new Map<NodeId, LifecycleState>()
	let lifecycleQueue: LifecycleState[] = []
	let lifecycleFlushScheduled = false

	/** Test-only ({@link __TEST__resetEngine}): drop active records and the queue. @internal */
	function __TEST__resetLifecycle(): void {
		lifecycleStates.clear()
		lifecycleQueue = []
		// A pending flush clears lifecycleFlushScheduled itself and bails on its epoch guard.
	}

	function scheduleLifecycleFlush(): void {
		if (lifecycleFlushScheduled) {
			return
		}
		lifecycleFlushScheduled = true
		// Epoch guard: a dead test's flush must not run user effects into the next test's engine.
		const epoch = engineEpoch
		queueMicrotask(() => {
			lifecycleFlushScheduled = false
			if (epoch !== engineEpoch) {
				return
			}
			const queue = lifecycleQueue
			lifecycleQueue = []
			for (const state of queue) {
				state.scheduled = false
				if (state.wantMounted === state.isMounted) {
					maybeDropDormant(state)
					continue // flap coalesced within one tick
				}
				if (state.wantMounted) {
					state.isMounted = true
					const result = state.effect(state.ctx)
					state.cleanup = typeof result === 'function' ? result : undefined
				} else {
					state.isMounted = false
					const cleanup = state.cleanup
					state.cleanup = undefined
					if (cleanup !== undefined) {
						cleanup()
					}
					maybeDropDormant(state)
				}
			}
		})
	}

	/**
	 * Dormancy: no refs, not mounted, nothing scheduled — the active record
	 * deletes; only the fns-slot callback remains.
	 */
	function maybeDropDormant(state: LifecycleState): void {
		if (state.refs <= 0 && !state.isMounted && !state.scheduled) {
			lifecycleStates.delete(state.id)
			// This deletion is reclamation's retry trigger for lifecycle atoms.
			if (reclaimSkippedN !== 0) {
				noteReclaimRetry(state.id)
			}
		}
	}

	/**
	 * Dispatch one context write through the same policy path as the public
	 * methods, over the id-resolved node.
	 */
	function dispatchLifecycleWrite(id: NodeId, kind: 0 | 1, payload: unknown): void {
		__lifecycleWrite(id, kind, payload)
	}

	/** Build the active context at rehydration — id-keyed, never holding a handle. */
	function createLifecycleContext(id: NodeId): AtomCtx<unknown> {
		return {
			get state(): unknown {
				return untracked(() => E.readAtom(id))
			},
			set(value: unknown): void {
				dispatchLifecycleWrite(id, 0, value)
			},
			update(fn: (current: unknown) => unknown): void {
				dispatchLifecycleWrite(id, 1, fn)
			},
		}
	}

	function shiftLifecycleCount(id: NodeId, delta: -1 | 1): void {
		let state = lifecycleStates.get(id)
		if (state === undefined) {
			if (delta < 0) {
				return // release without an active record: dormant already
			}
			// Rehydration — gate on LIFECYCLE first: computeds keep their getter
			// in the same fns column, so a getter could masquerade as a callback.
			if (E.buffer()[id + NodeField.LIFECYCLE] === 0) {
				return // no lifecycle effect on this record
			}
			const fn = fns[id >> ArenaShape.ID_TO_FN_SHIFT]
			if (typeof fn !== 'function') {
				return // dormant owner already cleared (record freed mid-flight)
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
			}
			lifecycleStates.set(id, state)
		}
		state.refs += delta
		const wantMounted = state.refs > 0
		if (state.wantMounted === wantMounted) {
			if (!wantMounted) {
				maybeDropDormant(state)
			}
			return // interior transition (1↔2, …): the union's edge did not move
		}
		state.wantMounted = wantMounted
		if (!state.scheduled) {
			state.scheduled = true
			lifecycleQueue.push(state)
			scheduleLifecycleFlush()
		}
	}

	/**
	 * The retain/release pair feeding the union refcount — once per non-machinery
	 * kernel link ({@link linkInsert}/{@link unlink}), once per live watcher.
	 */
	function retainLifecycle(id: NodeId): void {
		shiftLifecycleCount(id, 1)
	}

	function releaseLifecycle(id: NodeId): void {
		shiftLifecycleCount(id, -1)
	}

	// ═══════════════════════════════════════════════════════════════════════════════
	// The concurrent machinery
	// ═══════════════════════════════════════════════════════════════════════════════

	/**
	 * The concurrent-worlds machinery. The kernel above holds exactly one
	 * current value per atom, but React's concurrent rendering needs several
	 * views of state to coexist — a paused background render keeps seeing the
	 * state it started from while urgent updates land and commit — so this
	 * machinery records every write and reconstructs other views on demand.
	 * It is composed once per {@link createCosignals} instance;
	 * writes and reads keep fast arms (`standaloneQuiet`, `routingActive`)
	 * until a host attaches a driver ({@link attachDriver}) or opens a batch —
	 * tests/one-core.spec.ts asserts zero log entries, batches, or worlds
	 * under heavy sync-only traffic.
	 *
	 * ## Vocabulary
	 *
	 * - A **write-log entry** records one write (a set or a functional update),
	 *   its batch, and its position (`seq`) on one global timeline; entries
	 *   append to the written atom's **write log** ({@link WriteLog}). The
	 *   atom's **base** is its permanent history collapsed to one value; a
	 *   **fold** replays over base, in order, the entries a given view may see;
	 *   a **world** is one self-consistent value assignment for every atom,
	 *   produced by such folds. Ops replay per world, so they must be pure.
	 * - A **batch** groups the writes of one UI update (an event handler, a
	 *   transition, an async action). React schedules batches on its 31
	 *   **lanes** (its unit of scheduling priority), so at most 31 are live;
	 *   a batch **interns** into a **slot** of a 31-entry recycling table at
	 *   its first write — the slot's current batch is its **tenant** — so
	 *   "which batches affect X" fits one 31-bit word (a BatchSlotSet).
	 *   **Retirement** ends a batch: its entries become permanent history.
	 * - A **render pass** is one render of one root. Its **pin** is the
	 *   timeline position frozen at render start (it folds nothing written
	 *   later); its **mask** is the set of live batches it is rendering.
	 * - A **watcher** is one subscribed component instance; a **delivery**
	 *   schedules its re-render after a write. Deliveries are **value-blind**
	 *   ("this batch may affect you", never a value): what changed depends on
	 *   the asking world. A **drain** re-checks every observer a move of
	 *   **committed truth** (a per-root commit, or a retirement that changed
	 *   history) could reach; `committedAdvance` counts those moves.
	 * - **World arenas** are the second dependency graph: one packed arena per
	 *   render world and per committed-for-root world, holding a **shadow**
	 *   (value + flags) per consumed node plus the strong and weak-flagged
	 *   links that world's own evaluations took; arenas route and serve
	 *   render/committed reads. The kernel's own graph serves only newest:
	 *   writes apply to it eagerly (the eager-apply invariant) and untracked
	 *   reads sample at re-derivation time (the untracked-sampling rule).
	 * - An **episode** runs from the first pending durable work (a batch opens,
	 *   an async action **parks** until its promise settles, a render starts)
	 *   to **quiescence**: every batch retired, every render closed. Newest then
	 *   becomes each touched atom's base and write records drop wholesale;
	 *   observer records, committed routing, and kernel caches persist. Seqs
	 *   never rewrite (exact to 2^53 — see {@link quiesce}).
	 *
	 * A patched React build drives this surface with its scheduling events via
	 * `cosignals-react`; tests drive it in lockstep with `cosignals-oracle`.
	 *
	 * TODO(perf): serve a shared cache for provably-quiet world reads. The cold
	 * in-arena run records the links the routing coverage argument stands on —
	 * value-serve only when the arena already holds the node's links.
	 */

	// ---- engine-surface types (structurally mirror the reference model's) ------------

	type Value = unknown
	type RootId = string
	type RenderPassId = number
	/**
	 * An observer's monotone mount/registration order within its role — never
	 * a kernel record id (records recycle; these ids never do).
	 */
	type ObserverId = number
	type WatcherId = number
	/** Branded so SignalEffect ids cannot cross the kernel id spaces. */
	type SignalEffectId = number & IdBrand<'signalEffect'>
	/** A point on the one global sequence line (log-entry seqs, pins, stamps, clocks). */
	type Seq = number
	/** Episode counter: bumped at quiescence when the engine's per-node-id tables bulk-reset. */
	type Epoch = number
	/** A root's commit generation (bumped at every per-root commit). */
	type CommitGen = number

	type Equals = (a: Value, b: Value) => boolean

	class AtomInternals {
		readonly kind = 'atom' as const
		readonly id: NodeId
		/** Cached {@link NodeField.NODE_INDEX} of `id`'s record; stable for the node's life. @internal */
		readonly ix: NodeIndex
		name: string
		/** The floor every world folds from (advanced by quiet folds, fold-valve folds, the episode close). */
		base: Value
		baseSeq: Seq = 0
		/** The atom's write log, stored as packed entry columns. */
		log = new WriteLog()
		equals: Equals
		/** True iff `equals` is the default Object.is (a custom comparator runs under the fold-purity guard). */
		eqIsDefault: boolean
		/** Stamp of the last retirement fold touching this atom (dedups duplicate touches). */
		retirementStamp: Seq = 0
		/**
		 * The public handle — strong for engine-created nodes, a WeakRef for
		 * handle-resolved ones ({@link internalsForAtom}): the handle pins the node,
		 * never the reverse, or the record could never free. Warm paths use the
		 * `id` copy; cold consumers go through the `handle` getter. @internal
		 */
		_h: Atom<Value> | WeakRef<Atom<Value>>
		/** Last batch id that appended here (dedupe for batch.atomsTouched). */
		lastTouchBatch: BatchId = 0

		/** The public handle (cold accessor; callers that can see a dead handle use `_h` directly). */
		get handle(): Atom<Value> {
			const h = this._h
			return h instanceof WeakRef ? (h.deref() as Atom<Value>) : h
		}

		constructor(
			id: NodeId,
			ix: NodeIndex,
			name: string,
			initial: Value,
			equals: Equals,
			eqIsDefault: boolean,
			h: Atom<Value> | WeakRef<Atom<Value>>,
		) {
			this.id = id
			this.ix = ix
			this.name = name
			this.base = initial
			this.equals = equals
			this.eqIsDefault = eqIsDefault
			this._h = h
		}
	}

	type Reader = (node: AnyInternals) => Value
	type ComputedFn = (read: Reader, untracked: Reader) => Value

	/**
	 * The engine's computed node record. Every engine computed rides a kernel
	 * `Computed` record: the kernel serves the newest world; the engine
	 * evaluates `fn` under render/committed worlds through the arena walks.
	 */
	class ComputedInternals {
		readonly kind = 'computed' as const
		id: NodeId
		/** Cached NodeField.NODE_INDEX of `id`'s record (see AtomInternals.ix). @internal */
		ix: NodeIndex
		name: string
		/** The world evaluation function (arena refolds, mount-fix folds). */
		fn: ComputedFn
		/**
		 * The public handle — strong for engine-created computeds, a WeakRef for
		 * resolved ones; same reclamation rule as {@link AtomInternals._h}. @internal
		 */
		_h: Computed<unknown> | WeakRef<Computed<unknown>>
		/** True for handle-resolved public computeds: `fn` is the engine's ctx adapter around the raw fn. */
		ctxShaped: boolean
		/**
		 * The policy comparator `isEqual(prev, next)`, applied by arena refolds
		 * against the arena-local previous value; undefined = Object.is.
		 */
		isEqual: Equals | undefined
		/** ctx.previous: the node's last committed value (a best-effort hint), updated at render commits. */
		prevCommitted: Value = undefined

		/** The public handle (cold accessor — see `_h`). */
		get handle(): Computed<unknown> {
			const h = this._h
			return h instanceof WeakRef ? (h.deref() as Computed<unknown>) : h
		}

		constructor(
			id: NodeId,
			ix: NodeIndex,
			name: string,
			fn: ComputedFn,
			h: Computed<unknown> | WeakRef<Computed<unknown>>,
			ctxShaped: boolean,
			isEqual: Equals | undefined,
		) {
			this.id = id
			this.ix = ix
			this.name = name
			this.fn = fn
			this._h = h
			this.ctxShaped = ctxShaped
			this.isEqual = isEqual
		}
	}

	type AnyInternals = AtomInternals | ComputedInternals

	type RootState = {
		id: RootId
		/**
		 * Batches this root has committed that are still live elsewhere (cleared
		 * at retirement, when the retired clause subsumes membership).
		 */
		committedBatches: Set<BatchId>
		commitGen: CommitGen
		/** Slots of the root's live committed batches (maintained at commit, late intern, retirement). */
		committedBits: BatchSlotSet
		/**
		 * Member slots written since the last drain: such a write changes committed
		 * truth immediately — the next durable drain reconciles downstream of it.
		 */
		committedDirtySlots: BatchSlotSet
	}

	/**
	 * Write-kind tags — the packed log entry column and the write surface's
	 * kind argument: 0 = set, 1 = update, the same codes the public
	 * write dispatch carries end to end. Same-file const enum (inlines to 0/1).
	 */
	const enum WriteKind {
		SET = 0,
		UPDATE = 1,
	}

	/**
	 * Engine-activity counters (test surface): with no driver attached and no
	 * batch open, heavy signal traffic must leave every field at its baseline.
	 * Engine logic never reads them; `__TEST__coreProbes()` snapshots them.
	 */
	const probes = { logEntries: 0, batches: 0, worldEvals: 0, compositions: 0 }

	/**
	 * The decoded shape of the engine's observable events. The engine never
	 * constructs these objects: instrumentation sites create packed trace
	 * records ({@link TraceHooks}); a test-side decoder rebuilds this shape.
	 */
	type TraceEvent =
		| { type: 'write'; node: string; batch: BatchId; slot: BatchSlot; seq: Seq }
		| { type: 'write-dropped'; node: string; batch: BatchId }
		/** A quiet-mode fold: a whole write while nothing was pending — no batch, no log entry, no slot. */
		| { type: 'quiet-write'; node: string; seq: Seq }
		| {
				type: 'delivery'
				watcher: string
				batch: BatchId
				slot: BatchSlot
				seq: Seq
				mode: 'fresh' | 'interleaved'
		  }
		| { type: 'suppressed'; watcher: string; batch: BatchId; slot: BatchSlot; seq: Seq }
		| { type: 'core-effect-run'; effect: string; value: Value }
		| { type: 'react-effect-run'; effect: string; root: RootId; value: Value; values: Value[] }
		| { type: 'react-effect-cleanup'; effect: string; root: RootId }
		| {
				type: 'reconcile-correction'
				watcher: string
				root: RootId
				from: Value
				to: Value
				cause: 'retirement' | 'per-root-commit'
		  }
		| { type: 'mount-corrective'; watcher: string; batch: BatchId; slot: BatchSlot }
		| { type: 'mount-urgent-correction'; watcher: string; from: Value; to: Value }
		| { type: 'per-root-commit'; root: RootId; batch: BatchId }
		| { type: 'retired'; batch: BatchId; retiredSeq: Seq }
		| { type: 'slot-claimed'; slot: BatchSlot; batch: BatchId }
		| { type: 'slot-released'; slot: BatchSlot; batch: BatchId }
		| { type: 'slot-backstop-released'; slot: BatchSlot; batch: BatchId }
		| { type: 'render-committed'; renderPass: RenderPassId; root: RootId }
		| { type: 'render-discarded'; renderPass: RenderPassId; root: RootId }
		| { type: 'epoch-reset'; epoch: Epoch }

	/**
	 * The trace seam: an optional hook record (the `engine.trace` accessor
	 * pair), `undefined` unless `cosignals/trace` has attached a recorder. This
	 * engine never imports the trace module; every hook site pays exactly one
	 * nullable-slot check when no tracer is attached; hooks receive live engine
	 * objects and must not mutate them or allocate per event (one exception:
	 * `reactEffectRun`'s dep-values array). Covers {@link TraceEvent} plus trace-only events.
	 */
	type TraceHooks = {
		logEntry(node: AtomInternals, entry: WriteLogEntry): void
		/** A write dropped without a log entry (empty write log + equal against base). */
		writeDropped(node: AtomInternals, batch: BatchId): void
		quietWrite(node: AtomInternals, seq: Seq): void
		batchOpen(t: Batch): void
		/** An async-action batch settled (its retirement follows). */
		batchSettle(t: Batch): void
		/**
		 * The host's committed/abandoned report for a batch (diagnostic only:
		 * retirement is disposition-blind — recorded writes never revert).
		 */
		batchDisposition(batch: BatchId, committed: boolean): void
		/** RenderPass edges (end fires before retirements/commits/fixups). */
		renderStart(p: RenderPass): void
		renderYield(p: RenderPass): void
		renderResume(p: RenderPass): void
		renderEnd(p: RenderPass, kind: 'commit' | 'discard'): void
		/** Post-consequence markers: every retirement fold / lock-in / drain / fixup of the render end has landed. */
		renderCommitted(p: RenderPass): void
		renderDiscarded(p: RenderPass): void
		delivery(w: Watcher, batch: BatchId, slot: BatchSlot, seq: Seq, interleaved: boolean): void
		/** Delivery skipped: scheduled-but-unstarted work will fold the write. */
		suppressed(w: Watcher, batch: BatchId, slot: BatchSlot, seq: Seq): void
		coreEffectRun(effect: string, value: Value): void
		/** A committed SignalEffect ran; `values` is a trace-only read snapshot. */
		reactEffectRun(effect: string, root: RootId, value: Value, values: Value[]): void
		reactEffectCleanup(effect: string, root: RootId): void
		/** A drain moved this watcher's on-screen value to follow committed truth. */
		reconcileCorrection(
			w: Watcher,
			root: RootId,
			from: Value,
			to: Value,
			perRootCommit: boolean,
		): void
		/** Mount catch-up: a corrective re-render joined a live batch's lane. */
		mountCorrective(w: Watcher, batch: BatchId, slot: BatchSlot): void
		/** The urgent pre-paint mount-window fix. */
		mountCorrection(w: Watcher, from: Value, to: Value): void
		/** A root locked a batch in; commitGen is the root's (just-bumped) generation. */
		perRootCommit(root: RootId, batch: BatchId, commitGen: CommitGen): void
		retired(batch: BatchId, retiredSeq: Seq): void
		/** Slot lifecycle (claim / identity release / loud backstop eviction). */
		slotClaimed(slot: BatchSlot, batch: BatchId): void
		slotReleased(slot: BatchSlot, batch: BatchId): void
		slotBackstopReleased(slot: BatchSlot, batch: BatchId): void
		/** A computed evaluation in a world opened/closed (paired; end fires on throw too). */
		evalStart(node: ComputedInternals, world: World): void
		evalEnd(): void
		/** A retired tenant's release was deferred (an open render mask names the slot). */
		slotReleaseDeferred(slot: BatchSlot, batch: BatchId): void
		/** One per mount: how fixup resolved, and how many correctives were scheduled. */
		runMountFixup(
			w: Watcher,
			disposition: 'fast-out' | 'compare-clean' | 'corrected',
			correctives: number,
		): void
		epochReset(epoch: Epoch): void
		/** A compound public operation (write / renderEnd / retire / settle / quiesce) finished. */
		opEnd(): void
	}

	// ---- instance state ---------------------------------------------------------------
	// `composeEngine` initializes every field here for this factory instance and
	// again after a test reset.

	/** The attached driver, or undefined (host-agnostic embedding / tests). */
	let driver: EngineDriver | undefined

	/**
	 * The one boolean the write path branches on, recomputed only at pipeline
	 * transitions: quiet ⇔ no live batches, no open renders, no episode write
	 * records held. A quiet context-free write folds directly ({@link quietWrite}).
	 */
	let quiet = true
	// (quiet with no driver = the public fast-arm flag `standaloneQuiet`.)

	// ---- engine-activity probes (test surface) -----------------------------------------

	/** Test surface — a snapshot of the engine-activity counters for the zero-cost test. @internal */
	function __TEST__coreProbes(): {
		logEntries: number
		batches: number
		worldEvals: number
		compositions: number
	} {
		return { ...probes }
	}

	// ---- the public write dispatch ----------------------------------------------------

	/**
	 * The concurrent write dispatch (everything after the public policy assert
	 * and its standalone fast arm). A driver's batch context wins: a recorded
	 * write into that batch. Otherwise, context-free arms: while quiet, the
	 * plain graph write (no engine content) or the quiet fold; else the
	 * ambient default batch ({@link bareWrite}).
	 */
	function writeAtomConcurrent(atom: Atom<unknown>, kind: WriteKind, payload: unknown): void {
		const d = driver
		if (d !== undefined) {
			const batchId = d.currentBatch()
			if (batchId !== BATCH_NONE) {
				writeInBatch(batchId, internalsForAtom(atom), kind, payload)
				return
			}
		}
		if (quiet) {
			const node = atom._internals
			if (node === undefined) {
				// No engine content ⇒ no world consumer can see this atom except
				// through newest: the plain graph write is the whole quiet fold.
				__plainAtomWrite(atom, kind, payload)
				return
			}
			quietWrite(node, kind, payload)
			return
		}
		bareWrite(internalsForAtom(atom), kind, payload)
	}

	/**
	 * The id-resolved atom node, if it has engine content (the lifecycle write
	 * path's handle-free resolution). @internal
	 */
	function __engineAtomInternalsById(id: NodeId): AtomInternals | undefined {
		const hit = getResidentInternals(id)
		return hit !== undefined && hit.kind === 'atom' ? hit : undefined
	}

	/**
	 * The one id→node path: the dense row by the record's live kernel
	 * NODE_INDEX. Safe as the only registry: the record-free scrub
	 * ({@link __onRecordFree}) clears a freed record's row, and id and index are
	 * slot-tied — staleness-sensitive consumers add GEN checks, and callers
	 * with unproven ids must identity-check `hit.id === id`.
	 */
	function getResidentInternals(id: NodeId): AnyInternals | undefined {
		const ix = getKernelNodeIndex(id)
		return ix < nodeIndexToInternals.length ? nodeIndexToInternals[ix] : undefined
	}

	/** Test seam: resolve a node id exactly as {@link getResidentInternals} does. @internal */
	function __TEST__internalsById(id: NodeId): AnyInternals | undefined {
		return getResidentInternals(id)
	}

	/** Test seam: every resident internals record, in NodeIndex order. @internal */
	function __TEST__eachInternals(): AnyInternals[] {
		const out: AnyInternals[] = []
		for (const node of nodeIndexToInternals) {
			if (node !== undefined) {
				out.push(node)
			}
		}
		return out
	}

	/** The classified dispatch over an already-resolved node (same arms as {@link writeAtomConcurrent}). @internal */
	function __engineWriteNode(node: AtomInternals, kind: WriteKind, payload: unknown): void {
		const d = driver
		if (d !== undefined) {
			const batchId = d.currentBatch()
			if (batchId !== BATCH_NONE) {
				writeInBatch(batchId, node, kind, payload)
				return
			}
		}
		if (quiet) {
			quietWrite(node, kind, payload)
			return
		}
		bareWrite(node, kind, payload)
	}

	/** An arena buffer capacity, counted in Int32 slots (growth doubling starts from it). */
	type ArenaInitInts = number

	/** Engine tuning, accepted by `__TEST__resetEngine`; production runs the defaults. */
	type EngineResetOptions = {
		/**
		 * The world arenas' initial buffer reservation — default 64MiB of records
		 * (zero-fill demand-paged: untouched records cost no resident memory). An
		 * arena that outgrows it doubles its buffers by copy; never fatal.
		 */
		arenaInitInts?: ArenaInitInts
		/**
		 * Arms development-time checks: protocol-edge states the host contract
		 * makes unreachable throw instead of taking their defined fall-through,
		 * and dev-only diagnostics run. Default off: one branch per guarded site.
		 */
		devChecks?: boolean
	}

	/**
	 * The driver seam — the one attachment record a host integration installs
	 * ({@link attachDriver}): `currentBatch` answers the batch context once per
	 * classified write (BATCH_NONE → the context-free arms); `worldFor` answers
	 * the ambient world for routed reads; the listeners fire at operation
	 * boundaries, never mid-operation. Hosts that open batches must retire
	 * them; the driver only carries context and listeners.
	 */
	type EngineDriver = {
		/** The host's batch context for the write executing now (BATCH_NONE = none). */
		currentBatch(): BatchId
		/** The ambient world for routed reads (undefined = newest). */
		worldFor(): World | undefined
		/** A value-blind delivery reached a live watcher (fresh or interleaved). */
		onDelivery?: (w: Watcher, batch: Batch, slot: BatchSlot) => void
		/** Mount fixup scheduled a corrective re-render into a live batch's lane. */
		onMountCorrective?: (w: Watcher, batch: Batch, slot: BatchSlot) => void
		/** An urgent pre-paint correction (mount window / committed-truth drift). */
		onCorrection?: (w: Watcher) => void
		/** A committed SignalEffect requested its stable host runner. */
		onSignalEffect?: (effect: SignalEffect) => void
		/** Test-only: reset the host's protocol registry (invoked first by `__TEST__resetEngine`). */
		protocolReset?: () => void
	}

	/**
	 * Installs the driver, exactly once per engine instance (a second attach throws;
	 * test reset clears the slot). Throws inside an open evaluation/fold frame.
	 */
	function attachDriver(d: EngineDriver): void {
		if (evalDepth > 0 || inFoldCallback) {
			throw new ScheduleError(
				'attachDriver called inside an open evaluation/fold frame; it may only run at an operation boundary',
			)
		}
		if (driver !== undefined) {
			throw new ScheduleError(
				'a driver is already attached — attachDriver may be called once (reset the engine first in tests)',
			)
		}
		driver = d
		onDelivery = d.onDelivery
		onMountCorrective = d.onMountCorrective
		onCorrection = d.onCorrection
		onSignalEffect = d.onSignalEffect
		setWorldProvider(() => d.worldFor())
		recomputeQuiet() // re-derives quiet and standaloneQuiet (now false: every write makes the one foreign call)
	}

	/**
	 * The armed checker's window into the engine (`__TEST__checkerInternals()`,
	 * test-side only): live state getters plus bracket methods that keep every
	 * mutation's save/restore discipline engine-side. @internal
	 */
	type ArenaCheckerInternals = {
		/**
		 * Arena record layout as plain numbers, restricted to the fields the
		 * structural validator reads. The layout enums are same-file const enums,
		 * inlined into this object at construction, so the view stays in sync
		 * automatically. Field entries are Int32 word offsets; flags/modes are bits.
		 */
		readonly layout: {
			readonly ArenaGeom: { readonly ID_TO_COLUMN_SHIFT: number; readonly CLOCK_LIMIT: number }
			readonly ArenaField: {
				readonly NODE: number
				readonly MARK: number
				readonly FLAGS: number
				readonly DEPS: number
				readonly SUBS: number
			}
			readonly ArenaLinkField: {
				readonly DEP: number
				readonly SUB: number
				readonly PREV_DEP: number
				readonly NEXT_DEP: number
				readonly NEXT_SUB: number
				readonly MODE: number
			}
			readonly ArenaLinkMode: { readonly WEAK: number }
			readonly ArenaFlag: { readonly DIRTY: number; readonly BOX_SUSPENDED: number }
		}
		/** Open world-evaluation frames — the checker waits for the next top-level boundary. */
		readonly evalDepth: number
		/** An updater/reducer/equals fold callback is on the stack (same bar). */
		readonly inFoldCallback: boolean
		/** Every live arena: committed arenas by root, then open-render arenas. */
		eachArena(fn: (a: WorldArena) => void): void
		/** The dense node row by NODE_INDEX, or undefined for a disposed index (skipped). */
		internalsAt(ix: number): AnyInternals | undefined
		/**
		 * `arenaServe` — the arena serving entry. The checker serves the arena side
		 * before its naive recomputation, so a stale shadow is never refreshed first.
		 */
		serve(a: WorldArena, node: AnyInternals): Value
		/**
		 * One fold-truth fn run ({@link runInFoldTruthFrame}): world pinned, serve
		 * override at FOLD_TRUTH, everything restored on the way out.
		 */
		runInFoldTruthFrame<T>(world: World, fn: () => T): T
		/** The engine's one cycle-error construction (both sides' throws must compare string-equal). */
		createCycleError(name: string): ScheduleError
		/** The fold-purity bracket, as every comparator call site uses it. */
		runInFoldCallback<T>(fn: () => T): T
		/**
		 * Op-depth bracket around one whole checker run: settle taps landing
		 * mid-check enqueue for the epilogue's drain instead of draining re-entrantly.
		 */
		holdOp<T>(fn: () => T): T
		/** Install (or clear) the armed epilogue hook — fired after each operation's settlement. */
		armEpilogueCheck(check: (() => void) | undefined): void
	}

	// ---- concurrent instance state ----------------------------------------------------
	// One declaration per field; composeEngine assigns each fresh per reset.
	// The batch-id counter deliberately survives test resets within an instance.

	/** Render-pass records by id (the render-integration section owns every transition). */
	let idToRenderPass: Map<RenderPassId, RenderPass>
	/** Root records by id ({@link root} is the lookup-or-create). */
	let roots: Map<RootId, RootState>
	/** Watchers by id (deliveries and drains fire in id order). */
	let watchers: Map<WatcherId, Watcher>
	/** The one open render per root (React renders one tree per root at a time). */
	let rootToOpenRender: Map<RootId, RenderPass>

	// ---- dense per-node columns (routing walk scratch + the registry) ----
	// Keyed by nodeIndex, never NodeId (nodes and links share one allocator, so
	// id keying would go holey). A freed record's rows clear in __onRecordFree;
	// columns gap-fill at content allocation ({@link indexInternals}).
	/**
	 * Per-node visited generation, shared by the routing walks (delivery and
	 * drain dedup); arena traversal termination uses the per-arena `walk` column.
	 */
	let lastWalk: WalkGen[]
	/**
	 * The internals registry by nodeIndex — dense, gap-filled, scrubbed at
	 * record free. Nodes appear on first content, never at handle creation.
	 */
	let nodeIndexToInternals: (AnyInternals | undefined)[]
	/** Watchers by nodeIndex (the routing walks' collection rows). */
	let nodeToWatchers: (Watcher[] | undefined)[]
	/** Per-node cycle-detection marks (top-level evaluation generation; no Set allocations). */
	let evalMark: EvalGen[]
	/** Top-level world-evaluation generation (per-world cycle detection marks). */
	type EvalGen = number
	/** Per-walk visited generation (walk termination without Set allocations). */
	type WalkGen = number

	/** The one global sequence line every log entry/pin/stamp is a point on. */
	let seq: Seq = 0
	/** Bumped whenever committed truth moves (per-root commit, or a retirement that changed history). */
	let committedAdvance: Seq = 0
	/** Episode counter; bumped at quiescence when the engine's per-node-id tables bulk-reset. */
	let epoch: Epoch = 0
	/** Development-time checks switch (EngineResetOptions.devChecks). */
	let devChecks = false
	/** The world arenas' initial buffer reservation ({@link EngineResetOptions} knob). */
	let arenaInitInts: ArenaInitInts = 0
	/**
	 * Optional log-entry drop observer (test/diagnostics seam): called once per
	 * entry as it leaves the write log. Production leaves it undefined.
	 */
	let onLogEntryDrop: ((atom: AtomInternals, entry: WriteLogEntry) => void) | undefined = undefined

	// ---- shared evaluation/operation state ----
	// The scalars more than one section reads or writes; each field's home section is noted.
	/** The trace recorder slot — the engine's only instrumentation output. */
	let trace: TraceHooks | undefined
	/** The world an open evaluation frame is folding in. (worlds) */
	let activeWorld: World | undefined
	/**
	 * The nodeIndex whose fold-through evaluation frame is open (sink 0 ⇔ weak;
	 * the untracked reader clears it around the dep; index 0 is burned). (worlds)
	 */
	let currentSink: NodeIndex = 0
	/**
	 * Strong-dep capture list of the innermost evaluation frame, undefined
	 * unless that frame's node is observed. (worlds; kernel getters open it too)
	 */
	let obsCapture: AnyInternals[] | undefined
	/** >0 while a world evaluation is on stack (renders must not write). (worlds) */
	let evalDepth = 0
	/** True inside an updater/reducer/equals callback (reads+writes throw). (worlds) */
	let inFoldCallback = false
	/** SignalEffect whose body is currently retracking in its committed world. */
	let activeSignalEffect: SignalEffect | undefined
	/**
	 * >0 while a hook-initiated evaluation may legally suspend the render;
	 * background evaluations fold pending suspensions to sentinels instead. (worlds)
	 */
	let suspendDepth = 0
	/**
	 * The one override the routed-read path tests (setters bracket
	 * save/restore; innermost wins): a WorldArena (its fn runs serve from it),
	 * FOLD_TRUTH (the armed checker's plain folds), or undefined. (world arenas)
	 */
	let serveOverride: WorldArena | typeof FOLD_TRUTH | undefined
	/** Global count of box-suspended shadows (settle-tap fast-out). (world arenas) */
	let suspendedCount = 0
	/**
	 * The armed divergence-check hook (test-installed): fired at every public
	 * operation's epilogue after the settlement fixed point; production pays one undefined test.
	 */
	let epilogueCheck: (() => void) | undefined
	/** Public-operation nesting (the settlement firing-context discriminant). */
	let opDepth = 0
	/**
	 * The render currently COMMITTING (renderEnd's commit half): a correction
	 * candidate this render just re-rendered compares against committed truth
	 * by value — a question per-root clocks cannot express. (render integration)
	 */
	let committingRender: RenderPass | undefined
	/** Per-walk visited generation source (delivery walk, drains, closures). */
	let walkGen = 0
	/** Live SignalEffect count (fast bail on dirty-cone collection). */
	let signalEffectCount = 0
	/**
	 * A quiet write marked committed truth but could not run the committed-world
	 * boundary drain inline — it happened inside a kernel effect frame
	 * (enterDepth > 0) or a running SignalEffect body (activeSignalEffect set),
	 * where the SignalEffect runner's routed reads would record no dependency
	 * links. The drain is owed at the next true boundary ({@link drainQuietBoundary}).
	 */
	let quietBoundaryOwed = false
	/**
	 * Re-entrancy guard for {@link drainQuietBoundary}: a SignalEffect body run
	 * inside the drain may itself write, re-owing the drain; the active loop
	 * picks that up rather than nesting.
	 */
	let quietBoundaryActive = false
	// ---- direct listeners (attachDriver copies them off the driver record; the
	// delivery/fixup/correction sites read one direct slot each) ----
	let onDelivery: ((w: Watcher, batch: Batch, slot: BatchSlot) => void) | undefined
	let onMountCorrective: ((w: Watcher, batch: Batch, slot: BatchSlot) => void) | undefined
	let onCorrection: ((w: Watcher) => void) | undefined
	/** A committed SignalEffect terminal requested its stable adapter runner. */
	let onSignalEffect: ((effect: SignalEffect) => void) | undefined

	// ---- handle resolution + the registry (content allocation on first participation) ----

	/**
	 * Resolve a public Atom handle to its engine internals, allocating content
	 * on first participation. Base seeds from kernel-current — the atom's full
	 * committed history, since every accepted write of a content-less atom was
	 * a quiet fold, visible to every world by construction.
	 */
	function internalsForAtom(atom: Atom<unknown>): AtomInternals {
		const hit = atom._internals
		if (hit !== undefined) {
			return hit
		}
		const id = atom._id
		const current = untracked(() => E.readAtom(id)) // non-linking newest read
		const node = new AtomInternals(
			id,
			getKernelNodeIndex(id),
			atom.label ?? `atom#${id}`,
			current,
			atom._isEqual ?? Object.is,
			atom._isEqual === undefined,
			// Weak handle slot: content must not pin the public handle (see AtomInternals._h).
			new WeakRef(atom),
		)
		atom._internals = node
		indexInternals(node)
		return node
	}

	/** The next point on the one global sequence line. */
	function nextSeq(): Seq {
		return ++seq
	}

	/**
	 * Indexes a node into the dense side columns (keyed by nodeIndex); gap-fill
	 * keeps columns packed (a write past a plain array's length would go holey).
	 */
	function indexInternals(node: AnyInternals): void {
		const ix = node.ix
		while (nodeIndexToInternals.length <= ix) {
			nodeIndexToInternals.push(undefined)
			lastWalk.push(0)
			evalMark.push(0)
			obsRefs.push(0)
			obsDeps.push(undefined)
			nodeToWatchers.push(undefined)
		}
		nodeIndexToInternals[ix] = node
		lastWalk[ix] = 0
		evalMark[ix] = 0
		obsRefs[ix] = 0
		// Any row here is a dead tenant's; this keeps the columns sound even if a free was missed.
		obsDeps[ix] = undefined
		nodeToWatchers[ix] = undefined
	}

	/** Embedding/test constructor: a named engine atom — public handle plus engine content in one step. */
	function atom(name: string, initial: Value, equals?: Equals): AtomInternals {
		const handle = new Atom<Value>(initial, equals === undefined ? undefined : { isEqual: equals })
		const node = new AtomInternals(
			handle._id,
			getKernelNodeIndex(handle._id),
			name,
			initial,
			equals ?? Object.is,
			equals === undefined,
			handle,
		)
		handle._internals = node
		indexInternals(node)
		return node
	}

	/**
	 * Embedding/test constructor: an engine computed riding a fresh kernel
	 * `Computed` record — the kernel getter runs the authored fn with the kernel
	 * readers under the engine's guards; world evaluations use the arena readers.
	 */
	function computed(name: string, fn: ComputedFn, equals?: Equals): ComputedInternals {
		// id/ix land after the kernel record exists (the getter closure needs the internals object first).
		const node = new ComputedInternals(0, 0, name, fn, undefined as never, false, equals)
		const handle = new Computed<unknown>(
			makeKernelGetter(node),
			equals === undefined ? { label: name } : { label: name, isEqual: equals },
		)
		node._h = handle
		node.id = handle._id
		node.ix = getKernelNodeIndex(node.id)
		handle._internals = node
		E.markMachineryOwned(node.id) // its links add no lifecycle union refs — the obs index is its arm
		indexInternals(node)
		return node
	}

	/**
	 * Resolve a public `Computed` handle to its engine internals, allocating
	 * content on first participation: the kernel record keeps serving the
	 * newest world; allocation wraps its kernel getter with the engine epilogue
	 * (observation re-pointing per re-run) and builds the ctx-shaped world fn
	 * (ctx.previous, the id-keyed ctx.use cache, background-suspension folding).
	 */
	function internalsForComputed(c: Computed<unknown>): ComputedInternals {
		const hit = c._internals
		if (hit !== undefined) {
			return hit
		}
		const name = c.label ?? `computed#${c._id}`
		// Weak handle slot: the world fn closes over the raw fn and this node, never the handle.
		const node = new ComputedInternals(
			c._id,
			getKernelNodeIndex(c._id),
			name,
			undefined as never,
			new WeakRef(c),
			true,
			c._isEqual,
		)
		// The world evaluation fn (readers unused: the raw fn reads through the routed `.state` seams).
		{
			const rawFn = c._fn
			const ctx: ComputedCtx<unknown> = {
				get previous(): Value {
					return node.prevCommitted
				},
				use: <V>(sourceOrKey: unknown, factory?: () => PromiseLike<V>): V =>
					ctxUseKeyed(node.ix, sourceOrKey, factory) as V,
			}
			node.fn = () => {
				try {
					return rawFn(ctx)
				} catch (err) {
					// A pending suspension folds to its stable SuspendedRead sentinel
					// value; hook-initiated evaluations rethrow so React can suspend.
					if (err instanceof SuspendedRead && suspendDepth === 0) {
						return err
					}
					throw err
				}
			}
		}
		// Wrap the kernel getter with the engine epilogue: run the original, then
		// re-point the observed closure at the freshly re-tracked kernel links.
		{
			const fnIx = c._id >> ArenaShape.ID_TO_FN_SHIFT
			const inner = fns[fnIx] as (ctx: unknown) => unknown
			fns[fnIx] = (ctxArg: unknown): unknown => {
				evalDepth++ // writes during a newest evaluation throw, as in every world
				const tr = trace
				if (tr !== undefined) {
					tr.evalStart(node, NEWEST)
				}
				try {
					return inner(ctxArg)
				} finally {
					evalDepth--
					if (tr !== undefined) {
						tr.evalEnd()
					}
					if (obsRefs[node.ix] > 0) {
						syncObservationAfterKernelRun(node, getKernelStrongDeps(node))
					}
				}
			}
		}
		E.markMachineryOwned(c._id) // retro-releases any lifecycle refs its links held (the obs index is its arm now)
		c._internals = node
		indexInternals(node)
		return node
	}

	/**
	 * Dispose a superseded computed: its kernel record frees and its id becomes
	 * reusable (live watchers here throw). Order matters for id tenancy:
	 * engine-side teardown first — arena shadows purge, the registry row
	 * clears — then the kernel record disposes, firing the record-free scrub
	 * ({@link __onRecordFree}) before the slot's index can be re-inherited.
	 */
	function disposeComputed(handle: Computed<unknown>): void {
		// `handle._internals === node` is the identity/liveness test (a re-tenanted id resolves elsewhere).
		const node = getResidentInternals(handle._id)
		if (node !== undefined && node.kind === 'computed' && handle._internals === node) {
			const ix = node.ix
			const ws = nodeToWatchers[ix]
			if (ws !== undefined) {
				for (const watcher of ws) {
					if (watcher.live) {
						throw new ScheduleError(
							`disposeComputed(${node.name}): live watchers still subscribe — re-key them to the replacement first`,
						)
					}
				}
			}
			if (obsRefs[ix] > 0) {
				exitObservation(node)
			} // release any retained closure (defensive)
			purgeNodeFromArenas(ix)
			nodeIndexToInternals[ix] = undefined
			handle._internals = undefined
		}
		// Kernel: deps unlink, subs detach, deferred free at the boundary sweep.
		maybeBoundary()
		E.disposeComputed(handle._id)
		maybeBoundary() // sweep now when possible, so the id-tenancy GEN moves at this boundary
	}
	/**
	 * The record-free scrub (registered kernel-side): a freed node record
	 * surrenders its slot — and NODE_INDEX — to a future tenant, so every
	 * nodeIndex-keyed row clears immediately. Covers everything
	 * {@link disposeComputed} does not (dormant rows, observation refs). @internal
	 */
	function __onRecordFree(recordId: NodeId, ix: NodeIndex): void {
		if (ix < nodeIndexToInternals.length) {
			// The row is the dying tenant's node (no staleness window): release
			// its observation retains and clear a still-live handle's backlink.
			const resident = nodeIndexToInternals[ix]
			if (resident !== undefined) {
				if (obsRefs[ix] > 0) {
					exitObservation(resident)
				}
				clearHandleBacklink(resident)
			}
			nodeIndexToInternals[ix] = undefined
			lastWalk[ix] = 0
			evalMark[ix] = 0
			obsRefs[ix] = 0
			obsDeps[ix] = undefined
			nodeToWatchers[ix] = undefined
		}
		__clearUseCacheForIndex(ix) // the id-keyed ctx.use request cache (the engine's evaluation-policy section)
		purgeNodeFromArenas(ix)
	}

	/**
	 * Clear a freed record's `_internals` backlink while the handle is still
	 * alive: a stale cached node would write through a re-tenanted id.
	 */
	function clearHandleBacklink(node: AnyInternals): void {
		const h = node._h
		const live = h instanceof WeakRef ? h.deref() : h
		if (live !== undefined) {
			live._internals = undefined
		}
	}

	/**
	 * Engine-side reclaim guards (installed kernel-side per composition): a
	 * record must not free while it has watcher-index membership, observation
	 * retains (obsRefs > 0), episode membership (its write log holds entries),
	 * membership in an open render's arena, or membership in any arena's
	 * suspended list. Cold: runs once per finalizer fire / retry.
	 */
	function reclaimGuards(id: NodeId, ix: NodeIndex): boolean {
		if (ix < nodeToWatchers.length) {
			const ws = nodeToWatchers[ix]
			if (ws !== undefined && ws.length !== 0) {
				return true
			}
			if (obsRefs[ix] > 0) {
				return true
			}
		}
		// reclaimNode verified the GEN stamp, so the dense row is this record's node.
		const node = ix < nodeIndexToInternals.length ? nodeIndexToInternals[ix] : undefined
		if (node !== undefined && node.kind === 'atom' && episodeHolds.has(node)) {
			return true
		}
		for (const p of rootToOpenRender.values()) {
			const a = p.arena
			if (a !== undefined && arenaHasShadow(a, ix)) {
				return true
			}
		}
		let suspended = false
		eachArena((a) => {
			if (!suspended && arenaHoldsSuspended(a, ix)) {
				suspended = true
			}
		})
		return suspended
	}

	/**
	 * The kernel getter of an engine-created computed (see `computed`). The
	 * returned closure reads the current core at call time (reset-safe).
	 */
	function makeKernelGetter(node: ComputedInternals): () => Value {
		return () => {
			const savedCapture = obsCapture
			obsCapture = obsRefs[node.ix] > 0 ? [] : undefined
			evalDepth++ // writes during a newest evaluation throw, as in every world
			const tr = trace
			if (tr !== undefined) {
				tr.evalStart(node, NEWEST)
			}
			try {
				return node.fn(kernelTrackedReader, kernelUntrackedReader)
			} finally {
				evalDepth--
				const captured = obsCapture
				obsCapture = savedCapture
				if (tr !== undefined) {
					tr.evalEnd()
				}
				if (captured !== undefined) {
					syncObservationAfterKernelRun(node, captured)
				}
			}
		}
	}

	/**
	 * The dep read both kernel-frame readers share: plain kernel reads (which
	 * link the dep to any open kernel frame); kernel CycleErrors translate to the engine's.
	 */
	function readKernelValue(dep: AnyInternals): Value {
		if (dep.kind === 'atom') {
			return E.readAtom(dep.id)
		}
		try {
			return E.computedRead(dep.id)
		} catch (err) {
			if (err instanceof CycleError) {
				throw createCycleError(dep.name)
			}
			throw err
		}
	}

	/**
	 * Kernel-frame untracked reader: kernel `untracked()` clears the frame, so
	 * the dep still serves (recompute-if-stale) but no link is ever recorded.
	 */
	const kernelUntrackedReader: Reader = (dep) => untracked(() => readKernelValue(dep))

	/**
	 * Observation re-point after a kernel re-run, inside the still-open kernel
	 * frame: discovery reads must not link into it — `untracked()` clears it.
	 */
	function syncObservationAfterKernelRun(node: AnyInternals, captured: AnyInternals[]): void {
		untracked(() => syncObservedDeps(node, captured))
	}

	/**
	 * The engine internals among a computed's current kernel deps (tracked-only
	 * by construction: untracked reads leave no kernel link).
	 */
	function getKernelStrongDeps(node: ComputedInternals): AnyInternals[] {
		const memory = E.buffer()
		const out: AnyInternals[] = []
		let l = memory[node.id + NodeField.DEPS]
		while (l !== 0) {
			// Dep ids come off live kernel links: the dense row is the dep's node, or undefined (no engine content).
			const depIx = memory[memory[l + LinkField.DEP] + NodeField.NODE_INDEX]
			const dep = depIx < nodeIndexToInternals.length ? nodeIndexToInternals[depIx] : undefined
			if (dep !== undefined) {
				out.push(dep)
			}
			l = memory[l + LinkField.NEXT_DEP]!
		}
		return out
	}

	/** Root record lookup-or-create. */
	function root(id: RootId): RootState {
		let r = roots.get(id)
		if (r === undefined) {
			r = {
				id,
				committedBatches: new Set(),
				commitGen: 0,
				committedBits: 0,
				committedDirtySlots: 0,
			}
			roots.set(id, r)
		}
		return r
	}

	// ---- the observation index -----------------------------------------------------------
	// A node is OBSERVED while a live watcher consumes it — directly, or
	// transitively through the strong (tracked) dep edges of observed
	// computeds. The two dense nodeIndex columns below hold that closure; hot
	// paths only probe `obsRefs[ix] > 0`, while every membership transition
	// routes through the functions here. Observation is a property of live
	// watchers, not of the episode, so the index survives quiescence.

	/**
	 * Observed-consumer refcount per nodeIndex: +1 per live watcher on the
	 * node, +1 per observed computed currently holding it in {@link obsDeps}.
	 */
	let obsRefs: number[]
	/**
	 * Per observed computed (by nodeIndex): the retained direct strong-dep set
	 * as of its last fn run; undefined while unobserved. Sets hold node OBJECTS
	 * so {@link shiftObservedCount}'s identity guard can spot stale entries.
	 */
	let obsDeps: (Set<AnyInternals> | undefined)[]

	/**
	 * Shift a node's observed-consumer refcount; {@link enterObservation} and
	 * {@link exitObservation} fire on the 0↔1 edges only, so shared consumers
	 * hold one membership. Identity-guarded: record slots recycle, so a stale
	 * shift (its dense row re-tenanted after a free) must not move the new
	 * tenant's count — and stale is forever, so skipped shifts pair up.
	 */
	function shiftObservedCount(node: AnyInternals, delta: 1 | -1): void {
		const ix = node.ix
		if (nodeIndexToInternals[ix] !== node) {
			return
		}
		const refs = obsRefs[ix] + delta
		obsRefs[ix] = refs
		if (refs === 1 && delta === 1) {
			enterObservation(node)
		} else if (refs === 0 && delta === -1) {
			exitObservation(node)
			// obsRefs > 0 blocks reclamation, so a release to zero retries skipped frees.
			if (reclaimSkippedN !== 0) {
				noteReclaimRetry(node.id)
			}
		}
	}

	/**
	 * A node joined the observed closure. An atom retains its observed
	 * lifecycle; a computed retains its current kernel dep links, forced to
	 * exist by one {@link untracked} read (entry can fire inside an open kernel
	 * evaluation frame, where a stray link would corrupt the frame's dep list).
	 * A throwing getter still throws at reads; its partial deps are retained.
	 */
	function enterObservation(node: AnyInternals): void {
		if (node.kind === 'atom') {
			retainLifecycle(node.id)
			return
		}
		try {
			untracked(() => E.computedRead(node.id))
		} catch {
			// partial dep prefix retained below
		}
		syncObservedDeps(node, getKernelStrongDeps(node))
	}

	/**
	 * The last observed consumer left: release the whole retained closure.
	 * {@link obsDeps} clears before the child shifts so a cyclic dep record
	 * (possible only via throwing getters) cannot re-release. The kernel record
	 * keeps its links and cache: stripping them would force an eager untracked
	 * re-sample — exactly what the untracked-sampling rule forbids.
	 */
	function exitObservation(node: AnyInternals): void {
		if (node.kind === 'atom') {
			releaseLifecycle(node.id)
			return
		}
		const held = obsDeps[node.ix]
		if (held === undefined) {
			return
		}
		obsDeps[node.ix] = undefined
		for (const dep of held) {
			shiftObservedCount(dep, -1)
		}
	}

	/**
	 * Re-point retains: retain-new before release-old, so deps present in both
	 * sets never shift. Consumes `prev` destructively (callers replace it).
	 */
	function repointRetains(prev: Set<AnyInternals> | undefined, next: Set<AnyInternals>): void {
		for (const dep of next) {
			if (prev === undefined || !prev.delete(dep)) {
				shiftObservedCount(dep, 1)
			}
		}
		if (prev !== undefined) {
			for (const dep of prev) {
				shiftObservedCount(dep, -1)
			}
		}
	}

	/**
	 * An observed computed's fn just ran (fully, or up to a throw): re-point
	 * its retains at the strong deps this evaluation recorded. Skipped if
	 * observation left mid-evaluation — installing a retained set now would leak.
	 */
	function syncObservedDeps(node: AnyInternals, list: AnyInternals[]): void {
		if (obsRefs[node.ix] === 0) {
			return
		}
		const prev = obsDeps[node.ix]
		const next = new Set<AnyInternals>()
		for (const dep of list) {
			next.add(dep)
		}
		obsDeps[node.ix] = next
		repointRetains(prev, next)
	}

	// ---- the write log + the episode lifecycle --------------------------------------------
	// Write-log storage is deliberately simple: one plain array of plain records
	// per atom — one allocation per logged write, appends only, removal wholesale.
	//
	// History leaves a log two ways. At the episode close, the durable handoff:
	// once every batch is retired and every render closed, a fold over the whole
	// log equals the kernel's newest value (the eager-apply invariant), so each
	// touched atom adopts kernel newest as its new base by identity and its log
	// drops whole. Mid-episode, the bounded-memory fold valve: a parked action
	// can hold an episode open while writes keep landing, so a log's retired,
	// unpinned prefix folds into base at {@link FOLD_VALVE_THRESHOLD} entries.

	/**
	 * A log entry's materialized face, built on demand for the test/trace
	 * surface ({@link WriteLog.materialize}, the trace `logEntry` hook,
	 * {@link onLogEntryDrop}); storage keeps the scalar {@link WriteRecord}.
	 */
	type WriteLogEntry = {
		op: { kind: 'set'; value: Value } | { kind: 'update'; fn: (prev: Value) => Value }
		batch: BatchId
		slot: BatchSlot
		seq: Seq
		retiredSeq: Seq | undefined
	}

	/**
	 * One stored write record. `kind`/`payload` are the scalar op pair (a SET's
	 * payload is the value, an UPDATE's the updater); `retiredSeq` is stamped at
	 * the batch's retirement. `slot` is denormalized at creation: slots recycle,
	 * so visibility checks read the slot the write happened under, not the
	 * batch's current one.
	 */
	type WriteRecord = {
		kind: WriteKind
		payload: unknown
		batch: BatchId
		slot: BatchSlot
		seq: Seq
		retiredSeq: Seq | undefined
	}

	/**
	 * Fold-valve trigger: big enough that episodes which quiesce normally never
	 * fold, small enough that a held-open episode's residue stays modest. The
	 * write path files an atom with {@link foldCandidates} at exactly this length.
	 */
	const FOLD_VALVE_THRESHOLD = 1024

	/** Build one stored record's {@link WriteLogEntry} face. */
	function materializeRecord(e: WriteRecord): WriteLogEntry {
		const op: WriteLogEntry['op'] =
			e.kind === WriteKind.SET
				? { kind: 'set', value: e.payload }
				: { kind: 'update', fn: e.payload as (prev: Value) => Value }
		return { op, batch: e.batch, slot: e.slot, seq: e.seq, retiredSeq: e.retiredSeq }
	}

	/** The per-atom write log: stored records, oldest first, in sequence order. */
	class WriteLog {
		entries: WriteRecord[] = []
		/** Count of live entries not yet retirement-stamped. */
		unretired = 0
		/**
		 * Newest retirement stamp over live entries — monotone, so stamping
		 * assigns plainly; a valve fold recomputes it over the survivors.
		 */
		maxRetiredSeq: Seq = 0

		/** Live entry count. */
		get length(): number {
			return this.entries.length
		}

		push(kind: WriteKind, slot: BatchSlot, seq: Seq, batch: BatchId, payload: unknown): void {
			probes.logEntries++ // engine-activity counter (tests/one-core.spec.ts's zero-cost check)
			this.entries.push({ kind, payload, batch, slot, seq, retiredSeq: undefined })
			this.unretired++
		}

		/** The just-appended entry, materialized for the trace `logEntry` hook. */
		tailEntry(): WriteLogEntry {
			return materializeRecord(this.entries[this.entries.length - 1])
		}

		materialize(): WriteLogEntry[] {
			const out: WriteLogEntry[] = []
			for (const entry of this.entries) {
				out.push(materializeRecord(entry))
			}
			return out
		}

		/**
		 * Drop every entry (the episode close). Log identity is preserved:
		 * holders keep a valid, empty log.
		 */
		reset(): void {
			this.entries = []
			this.unretired = 0
			this.maxRetiredSeq = 0
		}
	}

	/**
	 * Atoms whose write log currently holds entries — the episode's touched-atom
	 * membership. Membership also blocks a member's record reclamation, so every
	 * path that empties a log files a reclamation retry.
	 */
	let episodeHolds: Set<AtomInternals>
	/**
	 * The fold valve's candidates. Invariant: every atom whose log holds at
	 * least {@link FOLD_VALVE_THRESHOLD} entries is a member — filed at each
	 * threshold crossing, removed only once its log is back under, cleared at
	 * the episode close. Usually empty, which keeps the valve one size check.
	 */
	let foldCandidates: Set<AtomInternals>

	/**
	 * The fold valve, run at retirement and render close — the two transitions
	 * that can make a prefix foldable (stamps land, pins lapse).
	 */
	function runFoldValve(): void {
		if (foldCandidates.size === 0) {
			return
		}
		const minPin = getMinLivePin()
		for (const atom of foldCandidates) {
			foldRetiredPrefix(atom, minPin)
		}
	}

	/**
	 * Fold one atom's foldable prefix into base at {@link FOLD_VALVE_THRESHOLD},
	 * then drop it in one splice. Foldable: the leading run of retired entries
	 * (out-of-order folds would change replay results) stamped at or below every
	 * live render pin (base must never move past a pin a render folds from).
	 */
	function foldRetiredPrefix(atom: AtomInternals, minPin: Seq): void {
		const log = atom.log
		const entries = log.entries
		let n = 0
		while (n < entries.length) {
			const r = entries[n].retiredSeq
			if (r === undefined || r > minPin) {
				break
			}
			n++
		}
		if (n >= FOLD_VALVE_THRESHOLD) {
			const onDrop = onLogEntryDrop
			for (let i = 0; i < n; i++) {
				const e = entries[i]
				const next = applyOp(atom, e.kind, e.payload, atom.base)
				// Stepwise equality per replayed entry, order isEqual(current, incoming).
				if (!isAtomValueEqual(atom, atom.base, next)) {
					atom.base = next
				}
				atom.baseSeq = e.seq
				if (onDrop !== undefined) {
					onDrop(atom, materializeRecord(e))
				}
			}
			entries.splice(0, n) // the folded prefix drops in one splice
			// The stamp max may have lived in the folded prefix: recompute.
			let max: Seq = 0
			for (let i = 0; i < entries.length; i++) {
				const r = entries[i].retiredSeq
				if (r !== undefined && r > max) {
					max = r
				}
			}
			log.maxRetiredSeq = max
		}
		if (entries.length < FOLD_VALVE_THRESHOLD) {
			foldCandidates.delete(atom)
		}
		if (entries.length === 0) {
			episodeHolds.delete(atom)
			// Log emptied mid-episode: membership cleared, so retry skipped reclaims.
			if (reclaimSkippedN !== 0) {
				noteReclaimRetry(atom.id)
			}
		}
	}

	/**
	 * The episode close, run at every retirement and render-close boundary; a
	 * no-op until quiescence (every batch retired, parked actions included,
	 * every render closed). Teardown order: durable handoff per held atom, then
	 * membership sets and retired batch records drop, then reclamation retries.
	 */
	function maybeCloseEpisode(): void {
		if (liveBatchCount !== 0 || rootToOpenRender.size !== 0) {
			return
		}
		if (episodeHolds.size !== 0) {
			const onDrop = onLogEntryDrop
			for (const atom of episodeHolds) {
				const log = atom.log
				const entries = log.entries
				if (onDrop !== undefined) {
					for (let i = 0; i < entries.length; i++) {
						onDrop(atom, materializeRecord(entries[i]))
					}
				}
				// The durable handoff (see the section header): adopt kernel newest by identity.
				atom.base = untracked(() => E.readAtom(atom.id)) // untracked: a close reached from inside a kernel effect frame records no link
				atom.baseSeq = entries[entries.length - 1].seq
				log.reset()
			}
			episodeHolds.clear()
			foldCandidates.clear()
		}
		// Retired batch records drop in one sweep — none can be live past the
		// quiescence guard — each with its write-path batch-cache entry.
		for (const [id, t] of idToBatch) {
			if (t.state === 'retired') {
				idToBatch.delete(id)
				invalidateBatchCache(id)
			}
		}
		// Membership rows just cleared: every skipped reclaim re-attempts.
		reclaimRetryAllSkipped()
	}

	// ---- batches + retirement --------------------------------------------------------------
	// A batch, in the concurrent machinery, is the group of writes belonging to
	// one UI update — one event handler, one transition, one async action — the
	// unit the host schedules, renders, and commits together. (Distinct from the
	// kernel's {@link batch} function, which only defers effect flushes within
	// one synchronous call.) Each batch is one `Batch` record in the `idToBatch`
	// registry, keyed by a never-reused `BatchId`; a written batch occupies a
	// slot in a 31-entry recycling table (`slots` — 31 so a set of slots fits
	// one int as a bit mask) from its first write until the slot's release
	// after retirement, the batch's terminal transition ({@link retireInner}).
	// Batch records are episode-lifetime: write-log entries reference batches by
	// id, so a retired record persists until the episode close drops it
	// wholesale.

	// Leniently branded batch scalars (see `IdBrand` above): plain numbers
	// assign in cast-free, but the brands are mutually exclusive — a slot
	// ordinal handed where a slot-set bit mask belongs is a compile error.

	type BatchId = number & IdBrand<'batch'>
	/**
	 * The reserved "no batch context" BatchId, never allocated (ids start at 1):
	 * a write resolving to it joins no batch (React names the same sentinel).
	 */
	const BATCH_NONE: BatchId = 0
	/** A slot ordinal (0–30): the batch's position in the recycling table. */
	type BatchSlot = number & IdBrand<'batchSlot'>
	/** A 31-bit slot set: bit i = slot i. */
	type BatchSlotSet = number & IdBrand<'batchSlotSet'>

	type Batch = {
		id: BatchId
		action: boolean
		parked: boolean
		/**
		 * React-side classification (true = transition-like), stored here so the
		 * driver needs no side table; the engine never branches on it.
		 */
		deferred: boolean
		state: 'live' | 'retired'
		slot: BatchSlot | undefined
		retiredSeq: Seq | undefined
		/**
		 * Sequence of this batch's last log entry (0 = none) — read by the mount
		 * fixup's fast-path clock check ({@link runMountFixup}).
		 */
		lastWriteSeq: Seq
		/** Atoms this batch appended to (may hold benign duplicates; deduped at retirement). */
		atomsTouched: AtomInternals[]
		ambient: boolean
	}

	/** One entry of the 31-slot recycling table a written batch occupies. */
	type BatchSlotMeta = {
		id: BatchSlot
		tenant: BatchId | undefined
		/**
		 * Claim sequence, created at every intern — the engine never reads it; it
		 * keeps model parity (both sides spend one sequence per claim).
		 */
		claimSeq: Seq
		/**
		 * Sequence of the last write under this slot, zeroed at each new claim
		 * (the mount fixup's clock conjunct compares it against snapshot pins).
		 */
		writeClock: Seq
		releasePending: boolean
	}

	const SLOT_COUNT = 31 // at most 31 live batches — one per React lane, and slot sets fit one int bit mask.

	/**
	 * BatchId source — monotonic for the process's whole life, never reused or
	 * rewound. React stores these ids verbatim, and the counter deliberately
	 * survives `__TEST__resetEngine`: a host can legally hold an id across a
	 * reset, and monotonicity keeps a stale id from colliding with a later batch.
	 */
	let nextBatchId = 1

	/**
	 * The next id the allocator would hand out (test harnesses rebase their
	 * model↔engine batch-id comparison on it across resets). @internal
	 */
	function __TEST__peekNextBatchId(): BatchId {
		return nextBatchId
	}

	/** Batch records by id; the episode close sweeps retired records out. */
	let idToBatch: Map<BatchId, Batch>
	/** The 31-entry recycling slot table. */
	let slots: BatchSlotMeta[]
	/** Live (unretired) batches — {@link recomputeQuiet} and the 31-live guard read it. */
	let liveBatchCount = 0
	/** Ambient default batch for bare (context-free) writes; undefined while none is live. */
	let ambientBatch: BatchId | undefined

	/**
	 * Create a batch — at most 31 live at once (one per React lane; scheduling
	 * itself stays React's). Allocation-only, callable mid-render or mid-commit
	 * (opDepth > 0): bookkeeping, no drains, no kernel mutation, no user code.
	 * With devChecks armed, opening with no driver attached throws — hosts that
	 * open batches must retire them, so a harness must attach its driver first.
	 */
	function openBatch(opts?: { action?: boolean; ambient?: boolean; deferred?: boolean }): Batch {
		if (devChecks && driver === undefined) {
			throw new ScheduleError(
				'openBatch with no driver attached — hosts that open batches must retire them; attach a driver first (devChecks)',
			)
		}
		if (liveBatchCount >= SLOT_COUNT) {
			throw new ScheduleError('at most 31 batches may be live at once (one per React lane)')
		}
		const parked = opts?.action ?? false
		probes.batches++ // engine-activity counter (tests/one-spec.ts's zero-cost check)
		const batch: Batch = {
			id: nextBatchId++,
			action: opts?.action ?? false,
			parked, // async-action batches park (cannot retire) until their promise settles
			deferred: opts?.deferred ?? false, // driver-owned annotation (see Batch.deferred)
			state: 'live',
			slot: undefined,
			retiredSeq: undefined,
			lastWriteSeq: 0,
			atomsTouched: [],
			ambient: opts?.ambient ?? false,
		}
		idToBatch.set(batch.id, batch)
		liveBatchCount++
		recomputeQuiet() // a live batch: the pipeline is armed until the last retirement
		const tr = trace
		if (tr !== undefined) {
			tr.batchOpen(batch)
		}
		return batch
	}

	/** Look up a batch id or throw the schedule error every resolver shares. */
	function getBatchById(id: BatchId): Batch {
		const t = idToBatch.get(id)
		if (t === undefined) {
			throw new ScheduleError(`unknown batch ${id}`)
		}
		return t
	}

	function liveBatches(): Batch[] {
		const out: Batch[] = []
		for (const batch of idToBatch.values()) {
			if (batch.state === 'live') {
				out.push(batch)
			}
		}
		return out
	}

	/** Intern the batch's slot, claiming a free one at its first write. */
	function internSlot(batch: Batch): BatchSlotMeta {
		if (batch.slot !== undefined) {
			return slots[batch.slot]
		}
		let free: BatchSlotMeta | undefined
		for (const slot of slots) {
			if (slot.tenant === undefined) {
				free = slot
				break
			}
		}
		if (free === undefined) {
			// Loud backstop — starving new batches would deadlock the scheduler:
			// evict the oldest retired tenant; paused renders self-correct.
			let victim: BatchSlotMeta | undefined
			let victimRetiredSeq = Infinity
			for (const slot of slots) {
				if (!slot.releasePending) {
					continue
				}
				const retiredSeq = getBatchById(slot.tenant!).retiredSeq ?? 0
				if (retiredSeq < victimRetiredSeq) {
					victim = slot
					victimRetiredSeq = retiredSeq
				}
			}
			if (victim === undefined) {
				throw new ScheduleError(
					'slot table full of live tenants — unreachable under the 31-live-batch guard',
				)
			}
			const tr = trace
			if (tr !== undefined) {
				tr.slotBackstopReleased(victim.id, victim.tenant!)
			}
			releaseSlot(victim)
			free = victim
		}
		free.tenant = batch.id
		free.claimSeq = nextSeq() // claim-after-release gets its own point on the timeline
		free.writeClock = 0
		free.releasePending = false
		batch.slot = free.id
		// A batch can commit before its first write: such a late intern adds the
		// slot to its roots' membership bits so the coming entries stay visible.
		for (const r of roots.values()) {
			if (r.committedBatches.has(batch.id)) {
				r.committedBits |= 1 << free.id
			}
		}
		{
			const clear = ~(1 << free.id)
			for (const w of watchers.values()) {
				w.dedupBits &= clear
			} // dedup clear at re-intern
		}
		{
			const tr = trace
			if (tr !== undefined) {
				tr.slotClaimed(free.id, batch.id)
			}
		}
		return free
	}

	function releaseSlot(slot: BatchSlotMeta): void {
		const tenant = slot.tenant === undefined ? undefined : getBatchById(slot.tenant)
		if (tenant !== undefined) {
			tenant.slot = undefined // identity release; log entries keep their denormalized slot
			const tr = trace
			if (tr !== undefined) {
				tr.slotReleased(slot.id, tenant.id)
			}
		}
		slot.tenant = undefined
		slot.releasePending = false
	}

	function rebuildCommittedBits(r: RootState): void {
		let bits = 0
		for (const tid of r.committedBatches) {
			const batch = idToBatch.get(tid)
			if (batch !== undefined && batch.slot !== undefined) {
				bits |= 1 << batch.slot
			}
		}
		r.committedBits = bits
	}

	function isSlotRetainedByOpenMask(slot: BatchSlot): boolean {
		for (const p of rootToOpenRender.values()) {
			if ((p.maskBits >>> slot) & 1) {
				return true
			}
		}
		return false
	}

	// ---------------------------------------------------------- retirement

	/**
	 * Retirement fires exactly once per batch; parked async actions retire
	 * only at settlement (their pending state must stay pending until then).
	 */
	function retire(batchId: BatchId): void {
		const t = getBatchById(batchId)
		if (t.state === 'retired') {
			throw new ScheduleError('retirement fires exactly once per batch')
		}
		if (t.parked) {
			throw new ScheduleError('parked action batches retire only at settlement')
		}
		opDepth++ // public-operation frame (see the engine's write dispatch)
		try {
			retireInner(t)
			// Boundary rule: retirement is a guaranteed flush point for every root
			// (a write-free retirement still flushes pending member-write flips).
			flushDirtySignalEffects(undefined)
			endOperation()
		} finally {
			opDepth--
		}
		runOperationEpilogue()
	}

	/** The async action's promise settled; the protocol host then retires the batch. */
	function settleAction(batchId: BatchId): void {
		const t = getBatchById(batchId)
		if (!t.action) {
			throw new ScheduleError('settle targets an action batch')
		}
		if (!t.parked || t.state !== 'live') {
			throw new ScheduleError('action already settled')
		}
		opDepth++ // public-operation frame (see the engine's write dispatch)
		try {
			t.parked = false
			const tr = trace
			if (tr !== undefined) {
				tr.batchSettle(t)
			}
			retireInner(t)
			flushDirtySignalEffects(undefined) // boundary rule: settlement is a guaranteed flush point
			endOperation()
		} finally {
			opDepth--
		}
		runOperationEpilogue()
	}

	/**
	 * Retirement: the batch's writes become permanent history visible to every
	 * world. Order matters — stamp log entries, run the fold valve, fan touched
	 * atoms into committed arenas, drain observers, clear per-root membership,
	 * release the slot (deferred while an open render's mask names it), close
	 * the episode. Disposition-blind: a batch React abandoned retires the same
	 * way — whether writes persist never depends on who was subscribed.
	 */
	function retireInner(batch: Batch): void {
		if (batch.state === 'live') {
			liveBatchCount--
		}
		batch.state = 'retired'
		batch.parked = false
		const retiredSeq = nextSeq() // one retirement sequence per retirement event
		batch.retiredSeq = retiredSeq
		// Stamp only the atoms this batch touched — never an all-logs scan.
		let touchedAny = false
		const touchedAtoms = batch.atomsTouched
		for (let i = 0; i < touchedAtoms.length; i++) {
			const n = touchedAtoms[i]
			if (n.retirementStamp === retiredSeq) {
				continue
			} // duplicate touch entry
			const log = n.log
			const entries = log.entries
			let stamped = 0
			for (let j = 0; j < entries.length; j++) {
				const e = entries[j]
				if (e.batch === batch.id && e.retiredSeq === undefined) {
					e.retiredSeq = retiredSeq
					stamped++
				}
			}
			if (stamped !== 0) {
				log.unretired -= stamped
				log.maxRetiredSeq = retiredSeq // stamps are monotone: plain assignment maintains the max
				n.retirementStamp = retiredSeq
				touchedAny = true
			}
		}
		if (touchedAny) {
			advanceCommitted()
		}
		runFoldValve()
		// Committed-truth flip site (mutate → fan → drain): fan before the drains.
		if (touchedAny) {
			fanAtomsToCommittedArenas(batch.atomsTouched)
		}
		{
			const tr = trace
			if (tr !== undefined) {
				tr.retired(batch.id, retiredSeq)
			}
		}
		// Durable drains, per root, gated on a flipped slot, member-write drift,
		// or restaled leftovers (candidates persist on each arena's dirty list).
		{
			const slotBit = batch.slot !== undefined ? 1 << batch.slot : 0
			for (const r of roots.values()) {
				const bits = slotBit | r.committedDirtySlots
				r.committedDirtySlots = 0
				const re = restaled.get(r.id)
				if (bits !== 0 || (re !== undefined && re.size > 0)) {
					drainCommittedObservers(r.id, 'retirement')
				}
			}
			preserveDirtySignalEffects(undefined)
			// Boundary mark decay: unconsumed marks on unwatched nodes stop re-appending.
			for (const a of rootToArena.values()) {
				arenaDecay(a)
			}
		}
		// Retired writes are visible everywhere, so membership rows go; release
		// the slot unless an open render's mask still names it.
		for (const r of roots.values()) {
			if (r.committedBatches.delete(batch.id)) {
				rebuildCommittedBits(r)
			}
		}
		if (batch.slot !== undefined) {
			const slot = slots[batch.slot]
			if (isSlotRetainedByOpenMask(slot.id)) {
				slot.releasePending = true // re-evaluated at every render end
				const tr = trace
				if (tr !== undefined) {
					tr.slotReleaseDeferred(slot.id, batch.id)
				}
			} else {
				releaseSlot(slot)
			}
		}
		if (ambientBatch === batch.id) {
			ambientBatch = undefined
		}
		// Episode close before quiet re-derives: this operation's notification and
		// settlement callbacks must classify their writes against post-episode state.
		maybeCloseEpisode()
		recomputeQuiet() // the last retirement (episode closed) re-arms quiet
	}

	// ---- worlds: folds, evaluation, read routing -------------------------------------------
	// How a world answers a read: {@link isVisible} picks the log entries the
	// world may see, the fold family ({@link foldAtom} / {@link applyOp} /
	// {@link isAtomValueEqual}) replays them, and {@link evaluate} serves node
	// values per world. Read routing decides which world a public `.state` read
	// resolves to, armed through the one {@link routingActive} flag.

	/**
	 * A world: one self-consistent assignment of values to every atom — the
	 * fold, in timeline order, of exactly the log entries {@link isVisible} admits.
	 */
	type World =
		| { kind: 'newest' }
		| { kind: 'render'; render: RenderPass }
		| { kind: 'committed'; root: RootId }
		| { kind: 'mountFix'; maskBits: BatchSlotSet; pin: Seq; root: RootId }

	/** The one newest-world singleton (hot paths never allocate world objects). */
	const NEWEST: World = { kind: 'newest' }

	/**
	 * Declined-read sentinel: a routed read returns it to mean "no routing
	 * context answered — take the plain kernel path". Never user-observable.
	 */
	const NOT_ROUTED: { readonly notRouted: true } = { notRouted: true }

	/** Top-level generation for the per-world cycle-detection marks in {@link evalMark}. */
	let evalGen: EvalGen = 0

	/**
	 * The bindings' ambient-world provider, consulted per routed read when no
	 * evaluation world is on stack: answers the live call context's world (the
	 * render running right now; an effect fire's committed world) or undefined
	 * for "route newest". A callback, not a flag, so a finished-but-uncommitted
	 * render reads newest and interleaved renders each see their own.
	 */
	let worldProvider: (() => World | undefined) | undefined

	/** Installs/clears the ambient-world provider (bindings seam). */
	function setWorldProvider(provider: (() => World | undefined) | undefined): void {
		worldProvider = provider
		syncReadRouting()
	}

	/** Central activeWorld setter — keeps the read-routing seams in sync. */
	function setWorld(w: World | undefined): void {
		activeWorld = w
		syncReadRouting()
	}

	/**
	 * Recomputes {@link routingActive} from the routing sources — reads
	 * on a driver-less quiet engine stay one boolean check.
	 */
	function syncReadRouting(): void {
		routingActive = activeWorld !== undefined || worldProvider !== undefined
	}

	/**
	 * The read-routing resolution order, one copy: the fold-purity throw
	 * (routing would otherwise serve a replayed updater's read silently) → the
	 * evaluation world on stack → the driver's ambient provider.
	 */
	function resolveRoutedWorld(): World | undefined {
		if (inFoldCallback) {
			throw new ScheduleError(
				'signal read inside an updater/reducer fold — updaters and reducers must be pure; read what you need before dispatching',
			)
		}
		const world = activeWorld
		if (world !== undefined) {
			return world
		}
		const p = worldProvider
		return p === undefined ? undefined : p()
	}

	/**
	 * Routes a public `Atom.state` read to the effective world, allocating
	 * engine content on first sight; NOT_ROUTED means "take the plain kernel path".
	 * @internal (reached only through `Atom.state`)
	 */
	function routedAtomRead(atom: Atom<unknown>): unknown {
		const world = resolveRoutedWorld()
		if (world === undefined) {
			return NOT_ROUTED
		}
		const node = internalsForAtom(atom)
		return routedRead(node, world)
	}

	/**
	 * The computed counterpart of {@link routedAtomRead}. Newest resolution
	 * declines (NOT_ROUTED): the plain kernel path is newest serving.
	 * @internal (reached only through `Computed.state`)
	 */
	function routedComputedRead(c: Computed<unknown>): unknown {
		const world = resolveRoutedWorld()
		if (world === undefined || world.kind === 'newest') {
			return NOT_ROUTED // the plain kernel path is newest serving
		}
		const node = internalsForComputed(c)
		// Raw handle reads have no reader hook, so the pre-dedup observation
		// capture (tracked reads only) happens here — mirrors routedRead.
		if (currentSink !== 0) {
			const oc = obsCapture
			if (oc !== undefined) {
				oc.push(node)
			}
		}
		return evaluate(node, world)
	}

	/**
	 * Runs an updater/reducer/equals under the fold-purity guard: these
	 * callbacks replay per world, so signal reads and writes inside them throw.
	 */
	function runInFoldCallback<T>(fn: () => T): T {
		const prev = inFoldCallback
		inFoldCallback = true
		try {
			return fn()
		} finally {
			inFoldCallback = prev
		}
	}

	/**
	 * The fold — replay this atom's visible log entries over base with
	 * stepwise equality (an equal step keeps the old reference); the entry
	 * array is already in sequence order and folds cover whole prefixes.
	 */
	function foldAtom(atom: AtomInternals, world: World): Value {
		const entries = atom.log.entries
		let value = atom.base
		for (let i = 0; i < entries.length; i++) {
			const e = entries[i]
			if (!isVisible(e, world)) {
				continue
			}
			const next = applyOp(atom, e.kind, e.payload, value)
			// isEqual(current, incoming), re-invoked per replayed entry by design.
			if (!isAtomValueEqual(atom, value, next)) {
				value = next
			}
		}
		return value
	}

	/**
	 * The visibility rule — which log entries each world's fold replays.
	 * Newest sees every entry (eager apply lets it read straight off the
	 * kernel). A render sees entries retired at-or-before its pin, plus entries
	 * up to the pin from the batches it includes — a paused-and-resumed render
	 * never sees a later write. Committed-for-root sees retired entries plus
	 * batches this root committed that are still live elsewhere. mountFix adds
	 * the owning render's inclusions at its pin to committed truth (see
	 * {@link runMountFixup}). The reference model's `visible` must mirror this.
	 */
	function isVisible(e: WriteRecord, world: World): boolean {
		switch (world.kind) {
			case 'newest':
				return true
			case 'render': {
				const w = world.render
				const r = e.retiredSeq
				if (r !== undefined && r <= w.pin) {
					return true
				} // clause 1: retired by my pin
				return ((w.includedBits >>> e.slot) & 1) === 1 && e.seq <= w.pin // clause 2
			}
			case 'committed': {
				if (e.retiredSeq !== undefined) {
					return true
				} // committed truth at now
				// `root()` is lookup-or-create, so a map hit equals its answer; only
				// the first consult pays the materializing miss (reference-model parity).
				return (((roots.get(world.root) ?? root(world.root)).committedBits >>> e.slot) & 1) === 1
			}
			case 'mountFix': {
				if (((world.maskBits >>> e.slot) & 1) === 1 && e.seq <= world.pin) {
					return true
				}
				if (e.retiredSeq !== undefined) {
					return true
				} // committed truth as of now
				return (((roots.get(world.root) ?? root(world.root)).committedBits >>> e.slot) & 1) === 1 // hot get + materializing miss arrow (see the committed arm)
			}
		}
	}

	/**
	 * Apply one op over `prev`: a SET's payload is the value, an UPDATE's is
	 * the updater (a ReducerAtom dispatch arrives as an update whose closure
	 * carries the reducer and the captured action).
	 */
	function applyOp(atom: AtomInternals, kind: WriteKind, payload: unknown, prev: Value): Value {
		if (kind === WriteKind.SET) {
			return payload
		}
		return runInFoldCallback(() => {
			// Both fold guards apply: engine (runInFoldCallback) + kernel (POISON).
			const saved = foldGuardSwap()
			try {
				return (payload as (p: Value) => Value)(prev)
			} finally {
				foldGuardRestore(saved)
			}
		})
	}

	/**
	 * How this atom compares two values — the one equality rule, one copy for
	 * every asking site: Object.is for the default, otherwise the atom's custom
	 * comparator under the fold-purity guard (comparators replay per world).
	 */
	function isAtomValueEqual(atom: AtomInternals, a: Value, b: Value): boolean {
		return atom.eqIsDefault ? Object.is(a, b) : runInFoldCallback(() => atom.equals(a, b))
	}

	/**
	 * The value-change gate for compare-and-correct sites: refolding can create
	 * fresh references for comparator-equal values, so a custom-equality computed
	 * asks its policy comparator; sentinels and everything else use identity.
	 */
	function isValueChanged(node: AnyInternals, prev: Value, next: Value): boolean {
		if (
			node.kind === 'computed' &&
			node.isEqual !== undefined &&
			!(prev instanceof SuspendedRead) &&
			!(next instanceof SuspendedRead)
		) {
			const eq = node.isEqual
			return !runInFoldCallback(() => eq(prev, next))
		}
		return !Object.is(prev, next)
	}

	/** The engine's one cycle error — one construction site, so the message never forks. */
	function createCycleError(name: string): ScheduleError {
		return new ScheduleError(
			`cyclic evaluation of ${name} within one world — a computed may not depend on itself`,
		)
	}

	/**
	 * A raw-handle atom read while a world evaluation frame is open: the open
	 * frame's sink gates observation capture, then the read serves in its world.
	 * @internal (called from the concurrent table wrapper)
	 */
	function routedRead(atom: AtomInternals, world: World): Value {
		if (currentSink !== 0) {
			const oc = obsCapture
			if (oc !== undefined) {
				oc.push(atom)
			}
		}
		return readAtomValue(atom, world)
	}

	/**
	 * Atom value in a world: kernel for newest, the world's arena for
	 * render/committed, a plain fold for mountFix and unmaterialized roots.
	 */
	function readAtomValue(atom: AtomInternals, world: World): Value {
		const route = serveOverride // one override test on the routed-read path
		if (route !== undefined) {
			if (route !== FOLD_TRUTH) {
				return arenaServe(route, atom)
			} // arena-refold routing override
			return foldAtom(atom, world) // fold-truth reads (armed checker)
		}
		if (world.kind === 'newest') {
			// The eager-apply invariant: the kernel already holds the newest fold.
			return E.readAtom(atom.id)
		}
		if (world.kind === 'render' || world.kind === 'committed') {
			const a = getArena(world)
			if (a !== undefined) {
				return arenaServe(a, atom)
			}
			// Unmaterialized root: fold plain — a read never creates record or arena.
		}
		return foldAtom(atom, world)
	}

	/**
	 * A node's value in a world. Render/committed worlds serve from the world's
	 * arena — values, invalidation, and routing structure live there, and the
	 * cold in-arena fn run records the links routing coverage stands on. Newest
	 * serves from the kernel: atoms directly, computeds via
	 * {@link readKernelComputed}. mountFix worlds and unmaterialized roots take
	 * the memo-free fold-through below, with per-world cycle detection.
	 */
	function evaluate(node: AnyInternals, world: World): Value {
		probes.worldEvals++ // engine-activity counter (tests/one-spec.ts's zero-cost check)
		if (inFoldCallback) {
			throw new ScheduleError(
				'signal read inside an updater/reducer fold — updaters and reducers must be pure; read what you need before dispatching',
			)
		}
		const route = serveOverride // no-override fast-out is the one hot test; FOLD_TRUTH falls through (fold-truth computeds re-run checker-side, never here)
		if (route !== undefined && route !== FOLD_TRUTH) {
			return arenaServe(route, node)
		} // arena-refold routing override
		if (world.kind === 'render' || world.kind === 'committed') {
			const a = getArena(world)
			if (a !== undefined) {
				return arenaServe(a, node)
			}
		}
		if (node.kind === 'atom') {
			return readAtomValue(node, world)
		}
		if (world.kind === 'newest') {
			return readKernelComputed(node)
		}
		// Fold-through: memo-free recursion in the frame's world; cycle marks
		// carry the current top-level evaluation generation.
		const marks = evalMark
		if (marks[node.ix] === evalGen && evalDepth > 0) {
			throw createCycleError(node.name)
		}
		if (evalDepth === 0) {
			evalGen++
		}
		marks[node.ix] = evalGen
		evalDepth++
		const savedWorld = activeWorld
		setWorld(world)
		const savedSink = currentSink
		const savedObsCapture = obsCapture
		// Observed nodes capture this run's strong deps; others pay one check.
		obsCapture = obsRefs[node.ix] > 0 ? [] : undefined
		currentSink = node.ix
		const tr = trace // paired eval hooks; end fires on throw too
		if (tr !== undefined) {
			tr.evalStart(node, world)
		}
		try {
			return node.fn(trackedReader, untrackedReader)
		} finally {
			const obsCaptured = obsCapture
			obsCapture = savedObsCapture
			currentSink = savedSink
			setWorld(savedWorld)
			evalDepth--
			marks[node.ix] = 0
			if (tr !== undefined) {
				tr.evalEnd()
			}
			// Observed-closure sync after every restore, so the discovery evaluations
			// it may trigger run on a clean frame stack (on a throw: the deps so far).
			if (obsCaptured !== undefined) {
				syncObservedDeps(node, obsCaptured)
			}
		}
	}

	/**
	 * Newest computed serving — the kernel's `computedRead`, with read-site
	 * translations: a kernel CycleError becomes the engine's cycle error; a
	 * PENDING suspension of a ctx-shaped computed rethrows for hook-initiated
	 * reads but serves as its stable sentinel value for background ones; settled
	 * suspensions self-heal kernel-side before this frame ever sees them.
	 */
	function readKernelComputed(node: ComputedInternals): Value {
		try {
			return E.computedRead(node.id)
		} catch (err) {
			if (err instanceof CycleError) {
				throw createCycleError(node.name)
			}
			if (err instanceof SuspendedRead && suspendDepth === 0 && node.ctxShaped) {
				return err // adopted ctx fn, background read: the sentinel serves as a value
			}
			throw err
		}
	}

	/**
	 * The fold-through frames' tracked reader (arena and kernel runs have their
	 * own): capture the observation, then evaluate the dep in the frame's world.
	 */
	const trackedReader: Reader = (dep) => {
		const oc = obsCapture
		if (oc !== undefined) {
			oc.push(dep)
		}
		return evaluate(dep, activeWorld!)
	}

	/**
	 * The fold-through frames' untracked reader: capture-free, not input-free —
	 * the dep still evaluates in the frame's world, but it never joins the
	 * observation capture (strong-only) and no notification fires through it.
	 */
	const untrackedReader: Reader = (dep) => {
		const sink = currentSink
		currentSink = 0
		try {
			return evaluate(dep, activeWorld!)
		} finally {
			currentSink = sink
		}
	}

	// ---- world arenas -----------------------------------------------------------------

	/**
	 * World arenas — the value, invalidation, and routing layer for render and
	 * committed worlds (vocabulary: the concurrent-machinery header above). One
	 * arena per world: stride-8 Int32 records — node shadows + dependency links
	 * in one pool, layout in the record-layout region above — plus side columns,
	 * a dirty list, and a read clock. Arenas serve world reads, route write-time
	 * deliveries over strong links, seed durable drains from their dirty lists,
	 * and carry mount fixup's closure over reverse links. Below: {@link WorldArena}
	 * and walks re-stating the kernel's push-pull algorithm (the correspondence
	 * note at {@link arenaLink}), then serving/lifecycle ({@link arenaServe},
	 * claim/release, fanout, decay, routing walks); cycles resolve by hoisting.
	 */

	/**
	 * A shadow record id: the premultiplied index of a record in one arena's own
	 * buffer — a third id space (arena walks consult kernel memory mid-walk, where
	 * mixing NodeIds would corrupt). Branded; 0 = none; link ids stay plain.
	 */
	type ShadowId = number & IdBrand<'arenaShadow'>

	/**
	 * A node record's tenancy generation, read live from kernel memory (the
	 * buffer is re-fetched per read: growth rebuilds swap it mid-operation).
	 */
	function getKernelGeneration(id: NodeId): Generation {
		return E.buffer()[id + NodeField.GEN]
	}

	/** A node record's NODE_INDEX, read live from kernel memory. */
	function getKernelNodeIndex(id: NodeId): NodeIndex {
		return E.buffer()[id + NodeField.NODE_INDEX]
	}

	// ---- the arena layer --------------------------------------------------------------
	// Pure functions over one arena: record/link maintenance, marks, walks.
	// Newest is never arena-served — every engine computed rides a kernel record
	// whose own dep links carry the newest strong walks. An armed divergence
	// checker (tests/arena-checker.ts) compares every arena serve against a
	// naive cache-free re-fold at each public operation's epilogue and throws.

	/**
	 * Bounds the arena pool: {@link releaseArena} keeps at most this many
	 * scrubbed shells (address space only — untouched pages never commit).
	 */
	const ARENA_POOL_CAP = 8

	/**
	 * Default arena reservation in Int32 slots (see
	 * {@link ArenaGeom.INIT_BUFFER_BYTES}); EngineResetOptions.arenaInitInts overrides.
	 */
	const WORLD_ARENA_INIT_INTS: ArenaInitInts = ArenaGeom.INIT_BUFFER_BYTES >> 2
	const EMPTY_I32 = new Int32Array(0)

	/**
	 * One world's arena: packed records, value/suspension side columns, a dirty
	 * list, and a read clock. Pooled: {@link releaseArena}'s full scrub is what
	 * makes dead-tenancy residue unable to validate; `claimGen` (bumped at claim
	 * and release; float64, so no wrap) is the tenancy diagnostic.
	 */
	class WorldArena {
		kind: 'render' | 'committed'
		storage: 'arena' | 'js'
		/** Owning world (render object or committed root) — folds cite it. */
		world: World
		root: RootId // committed: the root id; render: the render's root (diagnostics)
		alive = true
		/** Pool claim generation (bumped at claim and release). */
		claimGen = 0
		/**
		 * The arena's records: a plain fixed-length Int32Array (resizable-buffer
		 * views measured +56% on cold renders; banned). Starts at the zero-fill
		 * demand-paged reservation {@link ArenaGeom.INIT_BUFFER_BYTES} and grows BY
		 * COPY: record ids never change, and callers re-load cached views after
		 * allocating calls ({@link growWorldArenaBuffers} enumerates the sites).
		 */
		memory: Int32Array | number[]
		/**
		 * Per-world updated-at clock column: one float64 slot per record, grown
		 * beside {@link memory} by {@link growWorldArenaBuffers}.
		 */
		clocks: Float64Array | number[]
		/**
		 * Whether observer consults settle the clock column: committed arenas only
		 * (render-world values are pin-frozen; set per tenancy at claim).
		 */
		bumpsClocks: boolean
		vals: Value[] = []
		/**
		 * The folded value as of the shadow's last observer consult — the compare
		 * basis {@link settleObserverClock} moves the clock against (valid iff the clock is non-zero).
		 */
		cutoffVals: Value[] = []
		/** SignalEffect terminal occupying a shadow slot. */
		signalEffects: (SignalEffect | undefined)[] = []
		/** Per-record suspended-list index + 1 (0 = not suspended; swap-remove compaction). */
		suspIdx: number[] = []
		/**
		 * Per-record walk-generation stamps for the routing walks — termination and
		 * O(V+E) without allocation; scrubbed at release like every side column.
		 */
		walk: number[] = []
		/**
		 * Segregated weak-link subs list (per-shadow second head; same link layout):
		 * a combined-list walk measured 4.9× the write cost under hundreds of weak
		 * links per node. Delivery walks strong only; marks and drains walk both.
		 */
		weakSubs: number[] = []
		weakSubsTail: number[] = []
		next = ArenaGeom.STRIDE // bump pointer (record 0 burned: 0 = null)
		linkFree = 0
		/**
		 * Dead-shadow free list (leak audit), threaded through ArenaField.DEPS of
		 * records {@link purgeNodeFromArenas} orphaned; members join fully zeroed.
		 * Without reuse, useComputed churn grew arenas forever (tests/leak-audit.spec.ts).
		 */
		shadowFree: ShadowId = 0
		links = 0
		/** nodeIndex → shadow record id (0 = none; index 0 is burned). */
		nodeToShadow: ShadowId[] = []
		/** Marked-shadow list (record ids; appended on the DIRTY 0→1 edge). */
		dirty: ShadowId[] = []
		/** Suspended-shadow list (record ids; dense — swap-remove compaction). */
		suspended: ShadowId[] = []
		/** Fanout dedup clock: bumped on every arena consumption. */
		readClock = 0
		/** Per-arena evaluation cycle (link VERSION stamps). */
		cycle = 0

		constructor(
			kind: 'render' | 'committed',
			world: World,
			root: RootId,
			initInts: ArenaInitInts,
			storage: 'arena' | 'js',
		) {
			this.kind = kind
			this.world = world
			this.root = root
			this.storage = storage
			this.bumpsClocks = kind === 'committed'
			if (storage === 'arena') {
				this.memory = new Int32Array(initInts)
				this.clocks = new Float64Array(initInts >> ArenaGeom.ID_TO_COLUMN_SHIFT)
			} else {
				const length = Math.min(initInts, 64)
				this.memory = new Array<number>(length).fill(0)
				this.clocks = new Array<number>(length >> ArenaGeom.ID_TO_COLUMN_SHIFT).fill(0)
			}
		}
	}

	/**
	 * Reclamation guard probe: whether this arena's suspended list holds the
	 * node's shadow. Cold — one probe per arena per finalizer fire/retry.
	 */
	function arenaHoldsSuspended(a: WorldArena, ix: NodeIndex): boolean {
		const sh = ix < a.nodeToShadow.length ? a.nodeToShadow[ix] : 0
		return sh !== 0 && (a.suspIdx[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT] ?? 0) !== 0
	}

	/**
	 * Membership probe: whether this arena holds a shadow for the node index.
	 * Cold — reclamation guards, a render-lifecycle dev assert, diagnostics.
	 */
	function arenaHasShadow(a: WorldArena, ix: NodeIndex): boolean {
		return (ix < a.nodeToShadow.length ? a.nodeToShadow[ix] : 0) !== 0
	}

	/**
	 * Renumber the read clock: MARK → 0 on every live shadow, clock restarts at 0
	 * (quiesce-duty state; PENDING persists). Link records skipped (slot 7 = MODE).
	 */
	function arenaRenumberMarks(a: WorldArena): void {
		for (let sh = ArenaGeom.STRIDE; sh < a.next; sh += ArenaGeom.STRIDE) {
			if (
				(a.memory[sh + ArenaField.NODE] ?? 0) !== 0 &&
				a.nodeToShadow[a.memory[sh + ArenaField.NODE]] === sh
			) {
				a.memory[sh + ArenaField.MARK] = 0
			}
		}
		a.readClock = 0
	}

	function arenaBumpReadClock(a: WorldArena): void {
		if (a.readClock >= ArenaGeom.CLOCK_LIMIT) {
			arenaRenumberMarks(a)
		}
		a.readClock++
	}

	/**
	 * Renumber evaluation-cycle stamps: VERSION → 0 on every live link, cycle
	 * restarts at 0 (a zeroed stamp just reads as stale). Freed links stay
	 * untouched (VERSION aliases FREE_NEXT); open outer frames cannot collide.
	 */
	function arenaRenumberLinkVersions(a: WorldArena): void {
		const memory = a.memory
		for (let sh = ArenaGeom.STRIDE; sh < a.next; sh += ArenaGeom.STRIDE) {
			if (
				(memory[sh + ArenaField.NODE] ?? 0) !== 0 &&
				a.nodeToShadow[memory[sh + ArenaField.NODE]] === sh
			) {
				for (
					let l = memory[sh + ArenaField.DEPS];
					l !== 0;
					l = memory[l + ArenaLinkField.NEXT_DEP]!
				) {
					memory[l + ArenaLinkField.VERSION] = 0
				}
			}
		}
		a.cycle = 0
	}

	function arenaBumpCycle(a: WorldArena): number {
		if (a.cycle >= ArenaGeom.CLOCK_LIMIT) {
			arenaRenumberLinkVersions(a)
		}
		return ++a.cycle
	}

	function arenaAllocShadow(a: WorldArena, ix: NodeIndex, flags: number, gen: number): ShadowId {
		let id = a.shadowFree
		if (id !== 0) {
			// Dead-shadow reuse: zeroed when it joined (see shadowFree) — the fresh-record invariant below holds.
			a.shadowFree = a.memory[id + ArenaField.DEPS]!
			a.memory[id + ArenaField.DEPS] = 0
		} else {
			id = a.next
			const end = id + ArenaGeom.STRIDE
			if (end > a.memory.length) {
				growWorldArenaBuffers(a, end)
			} // may replace the buffers: `memory` caches below this arm only
			a.next = end
		}
		const memory = a.memory
		// Fresh-record invariant: memory[a.next..] is all zero — buffers allocate
		// zeroed, growth zeroes past the copy, releaseArena scrubs the written
		// prefix — so only tenant fields need stores. (Reused LINKs rewrite all fields.)
		memory[id + ArenaField.FLAGS] = flags
		memory[id + ArenaField.NODE] = ix
		memory[id + ArenaField.NODE_GEN] = gen
		growWorldArenaColumns(a, id >> ArenaGeom.ID_TO_COLUMN_SHIFT) // the grown-together columns
		while (a.nodeToShadow.length <= ix) {
			a.nodeToShadow.push(0)
		} // stay packed, never holey
		a.nodeToShadow[ix] = id
		return id
	}

	function arenaAllocLink(a: WorldArena): number {
		let id = a.linkFree
		if (id !== 0) {
			a.linkFree = a.memory[id + ArenaLinkField.FREE_NEXT]!
		} else {
			id = a.next
			const end = id + ArenaGeom.STRIDE
			if (end > a.memory.length) {
				growWorldArenaBuffers(a, end)
			} // may replace the buffers: callers re-load cached views (see its doc)
			a.next = end
		}
		a.links++
		return id
	}

	function arenaFreeLink(a: WorldArena, id: number): void {
		scrubWorldLinkColumnsOnFree(a, id) // a reused link must not carry a dead tenancy's observer stamp
		a.memory[id + ArenaLinkField.FREE_NEXT] = a.linkFree
		a.linkFree = id
		a.links--
	}

	/**
	 * Detach a link from its dep's mode-matching subs list, fixing neighbors and
	 * head/tail only — the link's own prev/next stay stale for mid-walk readers.
	 */
	function arenaSubsDetach(a: WorldArena, id: number): void {
		const memory = a.memory
		const dep = memory[id + ArenaLinkField.DEP]
		const nextSub = memory[id + ArenaLinkField.NEXT_SUB]
		const prevSub = memory[id + ArenaLinkField.PREV_SUB]
		const weak = (memory[id + ArenaLinkField.MODE] & ArenaLinkMode.WEAK) !== 0
		if (nextSub !== 0) {
			memory[nextSub + ArenaLinkField.PREV_SUB] = prevSub
		} else if (weak) {
			a.weakSubsTail[dep >> ArenaGeom.ID_TO_COLUMN_SHIFT] = prevSub
		} else {
			memory[dep + ArenaField.SUBS_TAIL] = prevSub
		}
		if (prevSub !== 0) {
			memory[prevSub + ArenaLinkField.NEXT_SUB] = nextSub
		} else if (weak) {
			a.weakSubs[dep >> ArenaGeom.ID_TO_COLUMN_SHIFT] = nextSub
		} else {
			memory[dep + ArenaField.SUBS] = nextSub
		}
	}

	/** Append a link to its dep's mode-matching subs list tail (sets the link's own prev/next and mode). */
	function arenaSubsAppend(a: WorldArena, id: number, weak: boolean): void {
		const memory = a.memory
		const dep = memory[id + ArenaLinkField.DEP]
		const vi = dep >> ArenaGeom.ID_TO_COLUMN_SHIFT
		const tail = weak ? a.weakSubsTail[vi] : memory[dep + ArenaField.SUBS_TAIL]
		memory[id + ArenaLinkField.MODE] = weak ? ArenaLinkMode.WEAK : 0
		memory[id + ArenaLinkField.PREV_SUB] = tail
		memory[id + ArenaLinkField.NEXT_SUB] = 0
		if (tail !== 0) {
			memory[tail + ArenaLinkField.NEXT_SUB] = id
		} else if (weak) {
			a.weakSubs[vi] = id
		} else {
			memory[dep + ArenaField.SUBS] = id
		}
		if (weak) {
			a.weakSubsTail[vi] = id
		} else {
			memory[dep + ArenaField.SUBS_TAIL] = id
		}
	}

	/** Set a live link's mode; a change moves it between the dep's two subs lists. */
	function arenaSetLinkWeak(a: WorldArena, id: number, weak: boolean): void {
		if (((a.memory[id + ArenaLinkField.MODE] & ArenaLinkMode.WEAK) !== 0) === weak) {
			return
		}
		arenaSubsDetach(a, id)
		arenaSubsAppend(a, id, weak)
	}

	/**
	 * Kernel correspondence, an obligation: these `arena`-prefixed walks
	 * re-state the kernel's push-pull algorithms over the arena layout — two
	 * expressions of one algorithm; a semantic change on either side is
	 * re-derived, never copied, on the other. The one addition, the mode
	 * discipline: a dep's first occurrence in an evaluation sets the link's mode
	 * from that read's kind; later occurrences only upgrade weak→strong, through
	 * {@link arenaSetLinkWeak} (a mode change moves subs lists).
	 */
	function arenaLink(
		a: WorldArena,
		dep: number,
		sub: number,
		version: number,
		weak: boolean,
	): number {
		const memory = a.memory
		const prevDep = memory[sub + ArenaField.DEPS_TAIL]
		if (prevDep !== 0 && memory[prevDep + ArenaLinkField.DEP] === dep) {
			// Duplicate occurrence within this evaluation: strong dominates.
			if (!weak) {
				arenaSetLinkWeak(a, prevDep, false)
			}
			return prevDep
		}
		const nextDep =
			prevDep !== 0 ? memory[prevDep + ArenaLinkField.NEXT_DEP] : memory[sub + ArenaField.DEPS]
		if (nextDep !== 0 && memory[nextDep + ArenaLinkField.DEP] === dep) {
			// In-place reuse: first occurrence this evaluation — reset the mode.
			memory[nextDep + ArenaLinkField.VERSION] = version
			arenaSetLinkWeak(a, nextDep, weak)
			memory[sub + ArenaField.DEPS_TAIL] = nextDep
			return nextDep
		}
		return arenaLinkInsert(a, dep, sub, version, weak, prevDep, nextDep)
	}

	function arenaLinkInsert(
		a: WorldArena,
		dep: number,
		sub: number,
		version: number,
		weak: boolean,
		prevDep: number,
		nextDep: number,
	): number {
		// Nonadjacent same-evaluation duplicate: probe both mode tails; strong dominates.
		const sTail = a.memory[dep + ArenaField.SUBS_TAIL]
		if (
			sTail !== 0 &&
			a.memory[sTail + ArenaLinkField.VERSION] === version &&
			a.memory[sTail + ArenaLinkField.SUB] === sub
		) {
			return sTail // already strong this evaluation
		}
		const wTail = a.weakSubsTail[dep >> ArenaGeom.ID_TO_COLUMN_SHIFT]
		if (
			wTail !== 0 &&
			a.memory[wTail + ArenaLinkField.VERSION] === version &&
			a.memory[wTail + ArenaLinkField.SUB] === sub
		) {
			if (!weak) {
				arenaSetLinkWeak(a, wTail, false)
			} // upgrade weak→strong
			return wTail
		}
		const newLink = arenaAllocLink(a) // may grow the arena: re-load memory after
		const memory = a.memory
		memory[sub + ArenaField.DEPS_TAIL] = newLink
		memory[newLink + ArenaLinkField.VERSION] = version
		memory[newLink + ArenaLinkField.DEP] = dep
		memory[newLink + ArenaLinkField.SUB] = sub
		memory[newLink + ArenaLinkField.PREV_DEP] = prevDep
		memory[newLink + ArenaLinkField.NEXT_DEP] = nextDep
		if (nextDep !== 0) {
			memory[nextDep + ArenaLinkField.PREV_DEP] = newLink
		}
		if (prevDep !== 0) {
			memory[prevDep + ArenaLinkField.NEXT_DEP] = newLink
		} else {
			memory[sub + ArenaField.DEPS] = newLink
		}
		arenaSubsAppend(a, newLink, weak) // subs-side wiring + mode, on the matching list
		// The K_EFFECT-sub bookkeeping (SignalEffect terminal dep counts) can only
		// apply when a SignalEffect exists at all — the bit is set only on terminal
		// shadows. Gate on the scalar count first so every OTHER link op (all
		// render-arena links; every link when no SignalEffect is mounted) skips the
		// flags read entirely.
		if (
			signalEffectCount !== 0 &&
			!weak &&
			(memory[sub + ArenaField.FLAGS] & ArenaFlag.K_EFFECT) !== 0
		) {
			shiftEffectDep(a, dep, 1)
		}
		return newLink
	}

	function arenaUnlink(
		a: WorldArena,
		id: number,
		sub: number = a.memory[id + ArenaLinkField.SUB],
	): number {
		const memory = a.memory
		const dep = memory[id + ArenaLinkField.DEP]
		const prevDep = memory[id + ArenaLinkField.PREV_DEP]
		const nextDep = memory[id + ArenaLinkField.NEXT_DEP]
		// The K_EFFECT-sub teardown mirrors arenaLinkInsert's append bookkeeping.
		// It stays a single flags read (no signalEffectCount prefix): arenaUnlink
		// is at its inline byte budget, and the K_EFFECT bit is set only when a
		// SignalEffect exists, so this already resolves false when none do.
		if (
			(memory[sub + ArenaField.FLAGS] & ArenaFlag.K_EFFECT) !== 0 &&
			(memory[id + ArenaLinkField.MODE] & ArenaLinkMode.WEAK) === 0
		) {
			shiftEffectDep(a, dep, -1)
		}
		if (nextDep !== 0) {
			memory[nextDep + ArenaLinkField.PREV_DEP] = prevDep
		} else {
			memory[sub + ArenaField.DEPS_TAIL] = prevDep
		}
		if (prevDep !== 0) {
			memory[prevDep + ArenaLinkField.NEXT_DEP] = nextDep
		} else {
			memory[sub + ArenaField.DEPS] = nextDep
		}
		arenaSubsDetach(a, id) // mode-matching subs list; the freed link keeps stale pointers for mid-walk readers
		arenaFreeLink(a, id)
		if (
			memory[dep + ArenaField.SUBS] === 0 &&
			a.weakSubs[dep >> ArenaGeom.ID_TO_COLUMN_SHIFT] === 0 &&
			(memory[dep + ArenaField.FLAGS] & ArenaFlag.K_COMPUTED) !== 0
		) {
			// Unwatched computed shadow (both lists empty): mark stale, tear down its deps (acyclic ⇒ terminates).
			if (memory[dep + ArenaField.DEPS_TAIL] !== 0) {
				// DIRTY 0→1 ⇒ dirty-list append (the a.dirty contract) — a torn computed must reach decay via the list.
				if ((memory[dep + ArenaField.FLAGS] & ArenaFlag.DIRTY) === 0) {
					a.dirty.push(dep)
				}
				memory[dep + ArenaField.FLAGS] = memory[dep + ArenaField.FLAGS] | ArenaFlag.DIRTY
				arenaDisposeAllDepsInReverse(a, dep)
			}
		}
		return nextDep
	}

	function arenaDisposeAllDepsInReverse(a: WorldArena, sub: number): void {
		let cur = a.memory[sub + ArenaField.DEPS_TAIL]
		while (cur !== 0) {
			const prev = a.memory[cur + ArenaLinkField.PREV_DEP]
			arenaUnlink(a, cur, sub)
			cur = prev
		}
	}

	/**
	 * Bounds every arena walk's step count — longer can only be a corrupted-list
	 * cycle, so the guards throw. Const enum: must inline as a literal in hot loops.
	 */
	const enum ArenaWalk {
		CYCLE_CAP = 1_000_000,
	}

	/** Purge links not re-tracked by the current evaluation (kernel discipline). */
	function arenaPurgeDeps(a: WorldArena, sub: number): void {
		const depsTail = a.memory[sub + ArenaField.DEPS_TAIL]
		let dep =
			depsTail !== 0
				? a.memory[depsTail + ArenaLinkField.NEXT_DEP]
				: a.memory[sub + ArenaField.DEPS]
		let guard = 0
		while (dep !== 0) {
			if (++guard > ArenaWalk.CYCLE_CAP) {
				throw new InvariantViolation(
					`arenaPurgeDeps: deps chain cycle at link ${dep} (shadow ${sub})`,
				)
			}
			dep = arenaUnlink(a, dep, sub)
		}
	}

	// Arena-walk scratch stacks (instance-owned; the routing walks use walkStack).
	let arenaPropStack = new Int32Array(WALK_STACK_SEED)
	let arenaPropSp = 0
	let arenaCheckStack = new Int32Array(WALK_STACK_SEED)
	let arenaCheckSp = 0

	/** Out-of-line cycle-cap thrower (keeps message-building out of the walks' inline bytecode). */
	function arenaWalkCycle(site: string, cur: number): never {
		throw new InvariantViolation(
			`${site}: walk exceeded ${ArenaWalk.CYCLE_CAP} steps (cycle) at link ${cur}`,
		)
	}

	/**
	 * Propagate PENDING over strong and weak links (only write-time delivery
	 * skips weak); a descended sub's weak head parks as a stack continuation.
	 */
	function arenaPropagate(a: WorldArena, startLink: number): void {
		const memory = a.memory // never allocates: safe to cache
		let cur = startLink
		let next = memory[cur + ArenaLinkField.NEXT_SUB]
		const stackBase = arenaPropSp
		let guard = 0
		top: do {
			if (++guard > ArenaWalk.CYCLE_CAP) {
				arenaWalkCycle('arenaPropagate', cur)
			}
			const sub = memory[cur + ArenaLinkField.SUB]
			let flags = memory[sub + ArenaField.FLAGS]
			if (
				!(
					flags &
					(ArenaFlag.RECURSED_CHECK | ArenaFlag.RECURSED | ArenaFlag.DIRTY | ArenaFlag.PENDING)
				)
			) {
				memory[sub + ArenaField.FLAGS] = flags | ArenaFlag.PENDING
			} else if (!(flags & (ArenaFlag.RECURSED_CHECK | ArenaFlag.RECURSED))) {
				flags = 0
			} else if (!(flags & ArenaFlag.RECURSED_CHECK)) {
				memory[sub + ArenaField.FLAGS] = (flags & ~ArenaFlag.RECURSED) | ArenaFlag.PENDING
			} else if (
				!(flags & (ArenaFlag.DIRTY | ArenaFlag.PENDING)) &&
				arenaIsValidLink(a, cur, sub)
			) {
				memory[sub + ArenaField.FLAGS] = flags | (ArenaFlag.RECURSED | ArenaFlag.PENDING)
				flags &= ArenaFlag.MUTABLE
			} else {
				flags = 0
			}
			if (flags & ArenaFlag.MUTABLE) {
				let subSubs = memory[sub + ArenaField.SUBS]
				const subWeak = a.weakSubs[sub >> ArenaGeom.ID_TO_COLUMN_SHIFT]
				let park = 0 // the weak head, parked when both lists are populated
				if (subWeak !== 0) {
					if (subSubs === 0) {
						subSubs = subWeak
					} // only weak dependents: descend into them
					else {
						park = subWeak
					}
				}
				if (subSubs !== 0) {
					cur = subSubs
					const nextSub = memory[cur + ArenaLinkField.NEXT_SUB]
					if (nextSub !== 0 || park !== 0) {
						if (arenaPropSp + 2 > arenaPropStack.length) {
							const bigger = new Int32Array(arenaPropStack.length * 2)
							bigger.set(arenaPropStack)
							arenaPropStack = bigger
						}
						if (park !== 0) {
							arenaPropStack[arenaPropSp++] = park
						}
						if (nextSub !== 0) {
							arenaPropStack[arenaPropSp++] = next
							next = nextSub
						}
					}
					continue
				}
			}
			if ((cur = next) !== 0) {
				next = memory[cur + ArenaLinkField.NEXT_SUB]!
				continue
			}
			while (arenaPropSp > stackBase) {
				cur = arenaPropStack[--arenaPropSp]!
				if (cur !== 0) {
					next = memory[cur + ArenaLinkField.NEXT_SUB]!
					continue top
				}
			}
			break
		} while (true)
	}

	/**
	 * Head of a shadow's subs list by index: 0 = strong, 1 = weak — where the
	 * `for (list 0..1)` walk sites learn the two lists' homes (hot fanout reads direct).
	 */
	function arenaSubsHead(a: WorldArena, sh: number, list: number): number {
		return list === 0
			? a.memory[sh + ArenaField.SUBS]
			: a.weakSubs[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT]
	}

	/** Seed arenaPropagate over both of a shadow's subs lists (fanout sites). */
	function arenaPropagateBoth(a: WorldArena, sh: number): void {
		const subs = a.memory[sh + ArenaField.SUBS]
		if (subs !== 0) {
			arenaPropagate(a, subs)
		}
		const weak = a.weakSubs[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT]
		if (weak !== 0) {
			arenaPropagate(a, weak)
		}
	}

	function arenaShallowPropagate(a: WorldArena, startLink: number): void {
		const memory = a.memory
		let cur = startLink
		let guard = 0
		do {
			if (++guard > ArenaWalk.CYCLE_CAP) {
				throw new InvariantViolation(`arenaShallowPropagate: subs chain cycle at link ${cur}`)
			}
			const sub = memory[cur + ArenaLinkField.SUB]
			const flags = memory[sub + ArenaField.FLAGS]
			if ((flags & (ArenaFlag.PENDING | ArenaFlag.DIRTY)) === ArenaFlag.PENDING) {
				memory[sub + ArenaField.FLAGS] = flags | ArenaFlag.DIRTY
				// DIRTY 0→1 ⇒ dirty-list append: an upgraded shadow can reach a boundary unconsumed; it must be listed.
				a.dirty.push(sub)
			}
		} while ((cur = memory[cur + ArenaLinkField.NEXT_SUB]!) !== 0)
	}

	/** Shallow-propagate over both subs lists (weak dependents upgrade too). */
	function arenaShallowPropagateBoth(a: WorldArena, sh: number): void {
		const subs = a.memory[sh + ArenaField.SUBS]
		if (subs !== 0) {
			arenaShallowPropagate(a, subs)
		}
		const weak = a.weakSubs[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT]
		if (weak !== 0) {
			arenaShallowPropagate(a, weak)
		}
	}

	function arenaIsValidLink(a: WorldArena, checkLink: number, sub: number): boolean {
		const memory = a.memory
		let cur = memory[sub + ArenaField.DEPS_TAIL]
		let guard = 0
		while (cur !== 0) {
			if (++guard > ArenaWalk.CYCLE_CAP) {
				throw new InvariantViolation(`arenaIsValidLink: prev-dep chain cycle at link ${cur}`)
			}
			if (cur === checkLink) {
				return true
			}
			cur = memory[cur + ArenaLinkField.PREV_DEP]!
		}
		return false
	}

	/**
	 * The serve-override slot's non-arena occupant: while it holds this marker,
	 * routed atom reads fold plain from their write logs — no arena, no kernel
	 * shortcut. Only the armed divergence checker sets it (checker reads must
	 * never consult the state under check); it exists so the routed-read hot
	 * path tests one override slot instead of two.
	 */
	const FOLD_TRUTH = Symbol('cosignals.foldTruth')

	/**
	 * The arena record layout as plain numbers, restricted to what the test-side
	 * validator reads; built beside the enums, in sync by construction.
	 */
	function arenaCheckerLayout(): {
		readonly ArenaGeom: { readonly ID_TO_COLUMN_SHIFT: number; readonly CLOCK_LIMIT: number }
		readonly ArenaField: {
			readonly NODE: number
			readonly MARK: number
			readonly FLAGS: number
			readonly DEPS: number
			readonly SUBS: number
		}
		readonly ArenaLinkField: {
			readonly DEP: number
			readonly SUB: number
			readonly PREV_DEP: number
			readonly NEXT_DEP: number
			readonly NEXT_SUB: number
			readonly MODE: number
		}
		readonly ArenaLinkMode: { readonly WEAK: number }
		readonly ArenaFlag: { readonly DIRTY: number; readonly BOX_SUSPENDED: number }
	} {
		return {
			ArenaGeom: {
				ID_TO_COLUMN_SHIFT: ArenaGeom.ID_TO_COLUMN_SHIFT,
				CLOCK_LIMIT: ArenaGeom.CLOCK_LIMIT,
			},
			ArenaField: {
				NODE: ArenaField.NODE,
				MARK: ArenaField.MARK,
				FLAGS: ArenaField.FLAGS,
				DEPS: ArenaField.DEPS,
				SUBS: ArenaField.SUBS,
			},
			ArenaLinkField: {
				DEP: ArenaLinkField.DEP,
				SUB: ArenaLinkField.SUB,
				PREV_DEP: ArenaLinkField.PREV_DEP,
				NEXT_DEP: ArenaLinkField.NEXT_DEP,
				NEXT_SUB: ArenaLinkField.NEXT_SUB,
				MODE: ArenaLinkField.MODE,
			},
			ArenaLinkMode: { WEAK: ArenaLinkMode.WEAK },
			ArenaFlag: { DIRTY: ArenaFlag.DIRTY, BOX_SUSPENDED: ArenaFlag.BOX_SUSPENDED },
		}
	}

	// ---- the arena serving/lifecycle layer ----
	// World reads served from arenas (refolding when marks or cold bases demand
	// it), claim/release + the shell pool, committed-truth fanout as marks, and
	// the routing walks deliveries and drains traverse.

	/** Committed arenas by root (consumer-populated life; the quiescence sweep releases zero-consumer entries). */
	let rootToArena: Map<RootId, WorldArena>
	/** Pooled released arena shells (capped at {@link ARENA_POOL_CAP}). */
	let arenaPool: WorldArena[]
	/**
	 * Watchers re-staled by their own commit, per root (render lifecycle writes;
	 * durable drains consume; retirement and lock-in gate on the size).
	 */
	let restaled: Map<RootId, Set<Watcher>>

	/**
	 * Open arena evaluation frame: links record into arenaFrame at
	 * arenaFrameCycle; flattened to scalars (a per-evaluation object showed in
	 * the cold-render gate). undefined arena ⇔ no frame.
	 */
	let arenaFrame: WorldArena | undefined = undefined
	let arenaFrameShadow = 0
	let arenaFrameCycle = 0

	function shiftEffectDep(a: WorldArena, dep: ShadowId, delta: 1 | -1): void {
		const ix = a.memory[dep + ArenaField.NODE]
		const node = nodeIndexToInternals[ix]
		if (
			node !== undefined &&
			a.memory[dep + ArenaField.NODE_GEN] === getKernelGeneration(node.id)
		) {
			shiftObservedCount(node, delta)
		}
	}

	function claimArena(kind: 'render' | 'committed', world: World, root: RootId): WorldArena {
		const storage = kind === 'render' ? 'js' : 'arena'
		let a: WorldArena | undefined
		for (let i = arenaPool.length - 1; i >= 0; i--) {
			if (arenaPool[i].storage === storage) {
				a = arenaPool[i]!
				arenaPool.splice(i, 1)
				break
			}
		}
		if (a === undefined) {
			a = new WorldArena(kind, world, root, arenaInitInts, storage)
		} else {
			a.kind = kind
			a.world = world
			a.root = root
			a.bumpsClocks = kind === 'committed' // per-tenancy: the pool mixes kinds
		}
		a.alive = true
		a.claimGen++
		// Pre-size nodeToShadow densely (holey reads cost; resolveShadow probes per read).
		const n = nodeIndexToInternals.length
		for (let i = a.nodeToShadow.length; i < n; i++) {
			a.nodeToShadow.push(0)
		}
		return a
	}

	/**
	 * Release an arena: scrub every column and the written record prefix, then
	 * pool the shell (dirty + suspended cones die unobserved with the tenancy).
	 */
	function releaseArena(a: WorldArena): void {
		for (let i = 0; i < a.suspended.length; i++) {
			suspendedCount--
		}
		a.alive = false
		a.claimGen++
		// Keep the side columns' CAPACITY across tenancies (truncation forced ~2k
		// re-pushes per cold render); fill() scrubs the same residue — value refs
		// release, stale ids read as "none" — while the packed length persists.
		resetWorldArenaColumnsOnRelease(a) // every declared column resets (the layout region's coherence set)
		a.dirty.length = 0
		a.suspended.length = 0
		// Scrub the written prefix so pooled buffers re-claim all-zero (fresh-record invariant; one fill beats per-field zeroing).
		a.memory.fill(0, 0, a.next)
		a.next = ArenaGeom.STRIDE
		a.linkFree = 0
		a.shadowFree = 0 // dead-shadow list dies with the tenancy (threads were zeroed above)
		a.links = 0
		a.readClock = 0
		a.cycle = 0
		if (arenaPool.length < ARENA_POOL_CAP) {
			arenaPool.push(a)
		}
		// Reclamation retry: whole-arena teardown clears every member's guard rows at once. Size-0 bail inside.
		reclaimRetryAllSkipped()
	}

	/**
	 * Settle a node's per-root committed clock after an observer consult — the
	 * arenas' one clock-advance site (drains, the boundary re-check, the commit
	 * populator, capture reads): compare the shadow's current folded value
	 * against the cutoff register with the node's own change rule, move the
	 * clock only on change (a first consult, clock 0, counts as changed).
	 * Consult-driven ON PURPOSE: plain committed reads refold shadows between
	 * boundaries, and a fold-driven clock would let read timing change which
	 * re-fires observers see; the reference model refreshes its counters at the
	 * mirrored sites. Returns the settled clock; render arenas never settle.
	 */
	function settleObserverClock(a: WorldArena, node: AnyInternals): Clock {
		const sh = node.ix < a.nodeToShadow.length ? a.nodeToShadow[node.ix] : 0
		if (sh === 0 || !a.bumpsClocks) {
			return 0
		}
		const vi = sh >> ArenaGeom.ID_TO_COLUMN_SHIFT
		const v = a.vals[vi]
		const clock = a.clocks[vi]
		if (clock !== 0 && !isValueChanged(node, a.cutoffVals[vi], v)) {
			return clock
		}
		a.cutoffVals[vi] = v
		return (a.clocks[vi] = ++clockSource)
	}

	/**
	 * The arena of a world: render arenas ride the render record; committed ones
	 * materialize lazily and persist for the root's consumer-populated life.
	 */
	function getArena(world: World): WorldArena | undefined {
		if (world.kind === 'render') {
			const a = world.render.arena
			if (a !== undefined && !a.alive) {
				throw new InvariantViolation(
					`arena of render ${world.render.id} was reclaimed while still reachable`,
				)
			}
			return a
		}
		if (world.kind !== 'committed') {
			return undefined
		}
		let a = rootToArena.get(world.root)
		if (a === undefined) {
			// Never create the root record on a read.
			if (!roots.has(world.root)) {
				return undefined
			}
			a = claimArena('committed', { kind: 'committed', root: world.root }, world.root)
			rootToArena.set(world.root, a)
		}
		return a
	}

	function eachArena(fn: (a: WorldArena) => void): void {
		for (const a of rootToArena.values()) {
			fn(a)
		}
		for (const p of rootToOpenRender.values()) {
			if (p.arena !== undefined) {
				fn(p.arena)
			}
		}
	}

	/**
	 * Shadow lookup/create with GEN id-tenancy validation: a dead-GEN shadow
	 * never serves — it is reset cold and re-tenanted.
	 */
	function resolveShadow(a: WorldArena, node: AnyInternals, kindFlags: number): number {
		const ix = node.ix
		let sh = ix < a.nodeToShadow.length ? a.nodeToShadow[ix] : 0
		const gen = getKernelGeneration(node.id) // one kernel-memory load per consult (priced by the bench trio)
		if (sh !== 0) {
			if (a.memory[sh + ArenaField.NODE_GEN] === gen) {
				return sh
			}
			// Dead tenancy: evict, purge links both directions, refold under the new tenant — never serve dead state.
			arenaEvictShadow(a, sh)
			a.memory[sh + ArenaField.FLAGS] = kindFlags
			a.memory[sh + ArenaField.NODE_GEN] = gen
			a.memory[sh + ArenaField.MARK] = 0
			return sh
		}
		sh = arenaAllocShadow(a, ix, kindFlags, gen)
		return sh
	}

	/**
	 * Detach a shadow wholesale: deps in reverse, both subs lists, the suspended
	 * set, the cached value. Shared by dead-tenancy re-key and dispose purge.
	 */
	function arenaEvictShadow(a: WorldArena, sh: number): void {
		arenaDisposeAllDepsInReverse(a, sh)
		for (let list = 0; list < 2; list++) {
			let sl = arenaSubsHead(a, sh, list)
			while (sl !== 0) {
				const next = a.memory[sl + ArenaLinkField.NEXT_SUB]
				arenaUnlink(a, sl)
				sl = next
			}
		}
		if ((a.memory[sh + ArenaField.FLAGS] & ArenaFlag.BOX_SUSPENDED) !== 0) {
			arenaUnsuspend(a, sh)
		}
		scrubWorldShadowColumnsOnEvict(a, sh) // value + clock slots clear together
	}

	/**
	 * Arena dep recording (arena fn-reader hook). The pre-dedup observation
	 * capture rides the strong arm only (the observation union is strong-only).
	 */
	function arenaRecordDep(dep: AnyInternals, weak: boolean): void {
		const a = arenaFrame
		if (a === undefined) {
			return
		}
		if (!weak) {
			const oc = obsCapture
			if (oc !== undefined) {
				oc.push(dep)
			}
		}
		const sh =
			dep.kind === 'atom'
				? resolveShadow(a, dep, ArenaFlag.K_SIGNAL | ArenaFlag.MUTABLE)
				: resolveShadow(a, dep, ArenaFlag.K_COMPUTED)
		arenaLink(a, sh, arenaFrameShadow, arenaFrameCycle, weak)
	}

	/**
	 * The arena atom-propagation gate is Object.is over fold outputs: the atom's
	 * own `equals` already ran inside the fold's stepwise equality — a custom
	 * comparator here could suppress propagation the fold performs.
	 */
	function arenaIsValueEqual(prev: Value, next: Value): boolean {
		return Object.is(prev, next)
	}

	/** Suspended-list append on the box-suspended bit's 0→1 (field stores dense index + 1). */
	function arenaSuspend(a: WorldArena, sh: number): void {
		const vi = sh >> ArenaGeom.ID_TO_COLUMN_SHIFT
		if (a.suspIdx[vi] !== 0) {
			return
		} // already a member (value column just swaps sentinels)
		a.suspended.push(sh)
		a.suspIdx[vi] = a.suspended.length // index + 1
		suspendedCount++
	}

	/** Swap-remove at the stored index on the 1→0 clear (the list stays dense). */
	function arenaUnsuspend(a: WorldArena, sh: number): void {
		const vi = sh >> ArenaGeom.ID_TO_COLUMN_SHIFT
		const slot = a.suspIdx[vi]
		if (slot === 0) {
			return
		}
		const last = a.suspended.length - 1
		const moved = a.suspended[last]
		a.suspended[slot - 1] = moved
		a.suspIdx[moved >> ArenaGeom.ID_TO_COLUMN_SHIFT] = slot
		a.suspended.pop()
		a.suspIdx[vi] = 0
		suspendedCount--
		// Reclamation retry: the suspended-list guard clears here, covering every exit path. Size-0 bail first.
		if (reclaimSkippedN !== 0) {
			const node = nodeIndexToInternals[a.memory[sh + ArenaField.NODE]]
			if (node !== undefined) {
				noteReclaimRetry(node.id)
			}
		}
	}

	/**
	 * Exceptional outcome of an arena fn run: cache the thrown payload into the
	 * shadow (BOX_THROWN) — later serves rethrow it; a thrown suspension re-runs
	 * once its thenable settles (the serve-site probe marks it DIRTY).
	 */
	function arenaNoteThrow(a: WorldArena, sh: number, err: unknown): void {
		const memory = a.memory
		const flags = memory[sh + ArenaField.FLAGS]
		const vi = sh >> ArenaGeom.ID_TO_COLUMN_SHIFT
		arenaBumpReadClock(a)
		if (err instanceof SuspendedRead) {
			a.vals[vi] = err
			memory[sh + ArenaField.FLAGS] =
				(flags & ~(ArenaFlag.DIRTY | ArenaFlag.PENDING)) |
				ArenaFlag.VALID |
				ArenaFlag.HAS_BOX |
				ArenaFlag.BOX_SUSPENDED |
				ArenaFlag.BOX_THROWN
			arenaSuspend(a, sh)
			return
		}
		if ((flags & ArenaFlag.BOX_SUSPENDED) !== 0) {
			arenaUnsuspend(a, sh)
		}
		a.vals[vi] = err
		memory[sh + ArenaField.FLAGS] =
			(flags & ~(ArenaFlag.DIRTY | ArenaFlag.PENDING | ArenaFlag.BOX_SUSPENDED)) |
			ArenaFlag.VALID |
			ArenaFlag.HAS_BOX |
			ArenaFlag.BOX_THROWN
	}

	// ---- arena serving (world reads, checks, settlement refolds) ----

	/**
	 * Serve a node from an arena — the render/committed read path — refolding
	 * through the arena's own walks when marks or cold bases demand it. Refolds
	 * run under the arena-only routing override so raw-handle reads route here.
	 */
	function arenaServe(a: WorldArena, node: AnyInternals): Value {
		if (node.kind === 'atom') {
			const sh = resolveShadow(a, node, ArenaFlag.K_SIGNAL | ArenaFlag.MUTABLE)
			const memory = a.memory
			const flags = memory[sh + ArenaField.FLAGS]
			if ((flags & ArenaFlag.VALID) === 0 || (flags & ArenaFlag.DIRTY) !== 0) {
				// A changed refold upgrades PENDING dependents to DIRTY so their re-check refolds them.
				if (arenaUpdateShadow(a, sh)) {
					arenaShallowPropagateBoth(a, sh)
				}
			}
			if (
				arenaFrame === a &&
				(worldUntrackedDepth === 0 || arenaFrameShadow !== worldUntrackedShadow)
			) {
				const link = arenaLink(a, sh, arenaFrameShadow, arenaFrameCycle, false)
				// SignalEffect terminal bookkeeping (the frame's own shadow is a
				// terminal): only reachable when a SignalEffect is mounted, so the
				// scalar gate keeps every OTHER tracked read off the signalEffects
				// column entirely.
				if (signalEffectCount !== 0) {
					const effect = a.signalEffects[arenaFrameShadow >> ArenaGeom.ID_TO_COLUMN_SHIFT]
					if (effect !== undefined) {
						a.clocks[link >> ArenaGeom.ID_TO_COLUMN_SHIFT] = settleObserverClock(a, node)
						effect.lastValue = a.vals[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT]
						effect.traceValues?.push(effect.lastValue)
					}
				}
				const oc = obsCapture
				if (oc !== undefined) {
					oc.push(node)
				}
			}
			return a.vals[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT]
		}
		const sh = resolveShadow(a, node, ArenaFlag.K_COMPUTED)
		const memory = a.memory
		let flags = memory[sh + ArenaField.FLAGS]
		if ((flags & ArenaFlag.RECURSED_CHECK) !== 0) {
			throw createCycleError(node.name)
		}
		// Read-site self-heal (settlement's pull half; mirrors kernel boxedRead): a
		// settled suspension self-invalidates, so a post-`await` read is deterministic.
		if ((flags & ArenaFlag.BOX_SUSPENDED) !== 0) {
			const t = (a.vals[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT] as SuspendedRead).thenable as {
				status?: string
			}
			if (t.status !== undefined && t.status !== 'pending') {
				memory[sh + ArenaField.FLAGS] = flags | ArenaFlag.DIRTY
				flags = memory[sh + ArenaField.FLAGS]!
			}
		}
		if ((flags & ArenaFlag.MUTABLE) === 0) {
			arenaUpdateComputed(a, sh) // never evaluated in this arena: cold fold
		} else if (
			(flags & ArenaFlag.DIRTY) !== 0 ||
			// Evicted-to-cold residue: VALID clear means the value column is
			// evicted — refold on consult (MUTABLE alone says "evaluated once").
			(flags & ArenaFlag.VALID) === 0 ||
			((flags & ArenaFlag.PENDING) !== 0 && arenaCheckDirty(a, a.memory[sh + ArenaField.DEPS], sh))
		) {
			if (arenaUpdateComputed(a, sh)) {
				arenaShallowPropagateBoth(a, sh)
			}
		} else if ((flags & ArenaFlag.PENDING) !== 0) {
			a.memory[sh + ArenaField.FLAGS] = flags & ~ArenaFlag.PENDING
		}
		let effectLink = 0
		let effect: SignalEffect | undefined
		if (
			arenaFrame === a &&
			(worldUntrackedDepth === 0 || arenaFrameShadow !== worldUntrackedShadow)
		) {
			effectLink = arenaLink(a, sh, arenaFrameShadow, arenaFrameCycle, false)
			// Scalar gate (see the atom path): no signalEffects lookup on tracked
			// reads while no SignalEffect is mounted.
			effect =
				signalEffectCount !== 0
					? a.signalEffects[arenaFrameShadow >> ArenaGeom.ID_TO_COLUMN_SHIFT]
					: undefined
			const oc = obsCapture
			if (oc !== undefined) {
				oc.push(node)
			}
		}
		const outFlags = a.memory[sh + ArenaField.FLAGS]
		// boxedRead-style rethrow: thrown payloads rethrow from cache; a returned
		// sentinel serves as a value, by identity (tests/concurrent-battery.spec.ts).
		if (
			(outFlags & ArenaFlag.HAS_BOX) !== 0 &&
			((outFlags & ArenaFlag.BOX_SUSPENDED) === 0 || (outFlags & ArenaFlag.BOX_THROWN) !== 0)
		) {
			throw a.vals[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT]
		}
		const value = a.vals[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT]
		if (effect !== undefined) {
			a.clocks[effectLink >> ArenaGeom.ID_TO_COLUMN_SHIFT] = settleObserverClock(a, node)
			effect.lastValue = value
			effect.traceValues?.push(value)
		}
		return value
	}

	/**
	 * Refold a shadow (atom fold or computed fn run);
	 * returns whether the world's value changed (the value cutoff).
	 */
	function arenaUpdateShadow(a: WorldArena, sh: number): boolean {
		const flags = a.memory[sh + ArenaField.FLAGS]
		if ((flags & ArenaFlag.K_COMPUTED) !== 0) {
			return arenaUpdateComputed(a, sh)
		}
		const nid: NodeIndex = a.memory[sh + ArenaField.NODE]
		const atom = nodeIndexToInternals[nid] as AtomInternals
		// Marked ⇒ refold unconditionally — no fingerprint shortcut.
		const next = foldAtom(atom, a.world)
		const vi = sh >> ArenaGeom.ID_TO_COLUMN_SHIFT
		const prev = a.vals[vi]
		const prevValid = (flags & ArenaFlag.VALID) !== 0
		a.memory[sh + ArenaField.FLAGS] =
			(flags & ~(ArenaFlag.DIRTY | ArenaFlag.PENDING)) | ArenaFlag.VALID
		arenaBumpReadClock(a)
		// The column always stores the fold's own output (arena value ≡ fold, bit for bit); the comparator only gates propagation.
		a.vals[vi] = next
		if (prevValid && arenaIsValueEqual(prev, next)) {
			return false
		}
		return true
	}

	/**
	 * Arena computed refold: the fn runs with the arena readers, the arena-only
	 * routing override, and the world set; observed nodes capture the run's
	 * strong deps and re-point their retains after ({@link syncObservedDeps}).
	 */
	function arenaUpdateComputed(a: WorldArena, sh: number): boolean {
		const nid: NodeIndex = a.memory[sh + ArenaField.NODE]
		const node = nodeIndexToInternals[nid] as ComputedInternals
		a.memory[sh + ArenaField.DEPS_TAIL] = 0
		a.memory[sh + ArenaField.FLAGS] =
			(a.memory[sh + ArenaField.FLAGS] | ArenaFlag.MUTABLE | ArenaFlag.RECURSED_CHECK) &
			~(ArenaFlag.RECURSED | ArenaFlag.DIRTY | ArenaFlag.PENDING)
		const savedFrameArena = arenaFrame
		const savedFrameShadow = arenaFrameShadow
		const savedFrameCycle = arenaFrameCycle
		const savedRoute = serveOverride
		const savedWorld = activeWorld
		const savedSink = currentSink
		const savedObsCapture = obsCapture
		arenaFrame = a
		arenaFrameShadow = sh
		arenaFrameCycle = arenaBumpCycle(a)
		serveOverride = a
		currentSink = 0
		obsCapture = obsRefs[nid] > 0 ? [] : undefined // nid is the nodeIndex (the NODE column)
		setWorld(a.world)
		evalDepth++
		const tr = trace // paired eval hooks; end fires on throw too
		if (tr !== undefined) {
			tr.evalStart(node, a.world)
		}
		try {
			return arenaFoldOutcome(
				a,
				sh,
				node.fn(arenaTrackedReader, arenaUntrackedReader),
				node.isEqual,
			)
		} catch (err) {
			arenaNoteThrow(a, sh, err)
			throw err
		} finally {
			if (tr !== undefined) {
				tr.evalEnd()
			}
			const obsCaptured = obsCapture
			evalDepth--
			setWorld(savedWorld)
			obsCapture = savedObsCapture
			currentSink = savedSink
			serveOverride = savedRoute
			arenaFrame = savedFrameArena
			arenaFrameShadow = savedFrameShadow
			arenaFrameCycle = savedFrameCycle
			a.memory[sh + ArenaField.FLAGS] = a.memory[sh + ArenaField.FLAGS] & ~ArenaFlag.RECURSED_CHECK
			arenaPurgeDeps(a, sh)
			arenaBumpReadClock(a)
			if (obsCaptured !== undefined) {
				arenaSyncObservationAfterRefold(node, obsCaptured)
			}
		}
	}

	/**
	 * Observed-closure sync after an arena refold, out of line (V8 inline
	 * budget); serveOverride clears so discovery evaluations route newest.
	 */
	function arenaSyncObservationAfterRefold(node: AnyInternals, captured: AnyInternals[]): void {
		const so = serveOverride
		serveOverride = undefined
		try {
			syncObservedDeps(node, captured)
		} finally {
			serveOverride = so
		}
	}

	/**
	 * Fold epilogue of an arena computed refold, out of line (keeps the caller
	 * under V8's 460-bytecode inline budget): classify the fn's outcome —
	 * suspension sentinel or plain value — into the value column and outcome
	 * bits; returns the value cutoff. A returned sentinel serves as a value (same
	 * box by identity = unchanged). Custom equality runs `isEqual(prev, next)` —
	 * previous first; comparators need not be symmetric — against the arena-local
	 * previous value; unchanged keeps the previous reference, and equality never
	 * bridges an exceptional boundary (`prevValid` demands a plain value).
	 */
	function arenaFoldOutcome(
		a: WorldArena,
		sh: number,
		value: Value,
		eq: Equals | undefined,
	): boolean {
		const vi = sh >> ArenaGeom.ID_TO_COLUMN_SHIFT
		const flags = a.memory[sh + ArenaField.FLAGS]
		if (value instanceof SuspendedRead) {
			const same =
				(flags & ArenaFlag.BOX_SUSPENDED) !== 0 &&
				(flags & ArenaFlag.BOX_THROWN) === 0 &&
				a.vals[vi] === value
			a.vals[vi] = value
			a.memory[sh + ArenaField.FLAGS] =
				(flags & ~ArenaFlag.BOX_THROWN) |
				ArenaFlag.VALID |
				ArenaFlag.HAS_BOX |
				ArenaFlag.BOX_SUSPENDED
			arenaSuspend(a, sh)
			if (same) {
				return false
			}
			return true // a fresh suspension is a changed outcome (clock movement is consult-driven — settleObserverClock)
		}
		const prevValid = (flags & ArenaFlag.VALID) !== 0 && (flags & ArenaFlag.HAS_BOX) === 0
		const changed = !(
			prevValid &&
			(eq === undefined
				? Object.is(a.vals[vi], value)
				: arenaIsValueEqualCold(eq, a.vals[vi], value))
		)
		if ((flags & ArenaFlag.BOX_SUSPENDED) !== 0) {
			arenaUnsuspend(a, sh)
		}
		if (changed) {
			a.vals[vi] = value
		}
		a.memory[sh + ArenaField.FLAGS] =
			(a.memory[sh + ArenaField.FLAGS] &
				~(ArenaFlag.HAS_BOX | ArenaFlag.BOX_SUSPENDED | ArenaFlag.BOX_THROWN)) |
			ArenaFlag.VALID
		return changed
	}

	/** The custom-equality compare, out of line (cold; keeps arenaFoldOutcome's hot default arm closure-free). */
	function arenaIsValueEqualCold(eq: Equals, prev: Value, next: Value): boolean {
		return runInFoldCallback(() => eq(prev, next))
	}

	function ensureSignalEffectShadow(effect: SignalEffect): ShadowId {
		const a = getArena({ kind: 'committed', root: effect.root })
		if (a === undefined) {
			throw new InvariantViolation(`SignalEffect ${effect.id} has no committed arena`)
		}
		const ix = getKernelNodeIndex(effect.rec)
		const gen = getKernelGeneration(effect.rec)
		let sh = ix < a.nodeToShadow.length ? a.nodeToShadow[ix] : 0
		if (sh === 0) {
			sh = arenaAllocShadow(a, ix, ArenaFlag.K_EFFECT | ArenaFlag.MUTABLE | ArenaFlag.VALID, gen)
		} else if (
			a.memory[sh + ArenaField.NODE_GEN] !== gen ||
			a.signalEffects[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT] !== effect
		) {
			arenaEvictShadow(a, sh)
			a.memory[sh + ArenaField.FLAGS] = ArenaFlag.K_EFFECT | ArenaFlag.MUTABLE | ArenaFlag.VALID
			a.memory[sh + ArenaField.NODE] = ix
			a.memory[sh + ArenaField.NODE_GEN] = gen
			a.memory[sh + ArenaField.MARK] = 0
		}
		a.signalEffects[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT] = effect
		effect.arena = a
		effect.shadow = sh
		return sh
	}

	/**
	 * Retrack one SignalEffect directly into its committed arena. Its links are
	 * the notification state; link clock slots hold the last consult stamp.
	 */
	function runSignalEffectFrame(effect: SignalEffect, body: () => void): void {
		if (activeSignalEffect !== undefined) {
			throw new ScheduleError('SignalEffect runs do not nest')
		}
		const sh = ensureSignalEffectShadow(effect)
		const a = effect.arena!
		a.memory[sh + ArenaField.DEPS_TAIL] = 0
		a.memory[sh + ArenaField.FLAGS] =
			(a.memory[sh + ArenaField.FLAGS] &
				~(ArenaFlag.DIRTY | ArenaFlag.PENDING | ArenaFlag.RECURSED)) |
			ArenaFlag.K_EFFECT |
			ArenaFlag.MUTABLE |
			ArenaFlag.VALID
		effect.lastValue = undefined
		const tr = trace
		effect.traceValues = tr === undefined ? undefined : []
		const savedFrameArena = arenaFrame
		const savedFrameShadow = arenaFrameShadow
		const savedFrameCycle = arenaFrameCycle
		const savedRoute = serveOverride
		const savedWorld = activeWorld
		const savedEffect = activeSignalEffect
		arenaFrame = a
		arenaFrameShadow = sh
		arenaFrameCycle = arenaBumpCycle(a)
		serveOverride = a
		activeSignalEffect = effect
		setWorld(a.world)
		try {
			body()
		} finally {
			setWorld(savedWorld)
			activeSignalEffect = savedEffect
			serveOverride = savedRoute
			arenaFrame = savedFrameArena
			arenaFrameShadow = savedFrameShadow
			arenaFrameCycle = savedFrameCycle
			arenaPurgeDeps(a, sh)
		}
	}

	function removeSignalEffectFrame(effect: SignalEffect): void {
		const a = effect.arena
		const sh = effect.shadow
		if (a === undefined || sh === 0) {
			return
		}
		const ix = a.memory[sh + ArenaField.NODE]
		arenaEvictShadow(a, sh)
		for (let f = 0; f < ArenaGeom.STRIDE; f++) {
			a.memory[sh + f] = 0
		}
		a.nodeToShadow[ix] = 0
		a.memory[sh + ArenaField.DEPS] = a.shadowFree
		a.shadowFree = sh
		effect.arena = undefined
		effect.shadow = 0
	}

	/** Validate the links of a dirty terminal. No parallel snapshot exists. */
	function signalEffectChanged(effect: SignalEffect): boolean {
		const a = effect.arena
		const sh = effect.shadow
		if (a === undefined || sh === 0) {
			return false
		}
		const effectFlags = a.memory[sh + ArenaField.FLAGS]
		if ((effectFlags & (ArenaFlag.DIRTY | ArenaFlag.PENDING)) === 0) {
			return false
		}
		let link = a.memory[sh + ArenaField.DEPS]
		while (link !== 0) {
			const depShadow: number = a.memory[link + ArenaLinkField.DEP]
			const ix = a.memory[depShadow + ArenaField.NODE]
			const node = nodeIndexToInternals[ix]
			if (
				node !== undefined &&
				a.memory[depShadow + ArenaField.NODE_GEN] === getKernelGeneration(node.id)
			) {
				const stamp = a.clocks[link >> ArenaGeom.ID_TO_COLUMN_SHIFT]
				const vi = depShadow >> ArenaGeom.ID_TO_COLUMN_SHIFT
				if (
					!(
						(a.memory[depShadow + ArenaField.FLAGS] &
							(ArenaFlag.VALID | ArenaFlag.DIRTY | ArenaFlag.PENDING | ArenaFlag.HAS_BOX)) ===
							ArenaFlag.VALID &&
						a.clocks[vi] === stamp &&
						Object.is(a.cutoffVals[vi], a.vals[vi])
					)
				) {
					try {
						evaluate(node, a.world)
					} catch (err) {
						if (!(err instanceof SuspendedRead)) {
							throw err
						}
						link = a.memory[link + ArenaLinkField.NEXT_DEP]!
						continue
					}
					if (settleObserverClock(a, node) !== stamp) {
						return true
					}
				}
			}
			link = a.memory[link + ArenaLinkField.NEXT_DEP]!
		}
		a.memory[sh + ArenaField.FLAGS] = effectFlags & ~(ArenaFlag.DIRTY | ArenaFlag.PENDING)
		return false
	}

	/** Traverse the arena's dirty cones and collect terminal effects. */
	function collectDirtySignalEffects(a: WorldArena, gen: WalkGen, effects: SignalEffect[]): void {
		const memory = a.memory
		const walk = a.walk
		const stack = walkStack
		let sp = 0
		for (let i = 0; i < a.dirty.length; i++) {
			const sh = a.dirty[i]
			if (walk[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT] === gen) {
				continue
			}
			walk[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT] = gen
			stack[sp++] = sh
			const effect = a.signalEffects[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT]
			if (effect !== undefined && effect.walkGen !== gen) {
				effect.walkGen = gen
				effects.push(effect)
			}
		}
		while (sp > 0) {
			const sh = stack[--sp]
			for (let list = 0; list < 2; list++) {
				let link = arenaSubsHead(a, sh, list)
				while (link !== 0) {
					const sub = memory[link + ArenaLinkField.SUB]
					if (walk[sub >> ArenaGeom.ID_TO_COLUMN_SHIFT] !== gen) {
						walk[sub >> ArenaGeom.ID_TO_COLUMN_SHIFT] = gen
						stack[sp++] = sub
						const effect = a.signalEffects[sub >> ArenaGeom.ID_TO_COLUMN_SHIFT]
						if (effect !== undefined && effect.walkGen !== gen) {
							effect.walkGen = gen
							effects.push(effect)
						}
					}
					link = memory[link + ArenaLinkField.NEXT_SUB]!
				}
			}
		}
	}

	const arenaTrackedReader: Reader = (dep) => {
		arenaRecordDep(dep, false)
		return arenaServe(arenaFrame!, dep)
	}

	const arenaUntrackedReader: Reader = (dep) => {
		arenaRecordDep(dep, true)
		const a = arenaFrame
		arenaFrame = undefined // untracked: dep's own reads link nowhere new
		try {
			return arenaServe(a!, dep)
		} finally {
			arenaFrame = a
		}
	}

	/**
	 * Kernel `checkDirty` transliteration; refolds can run getters (allocation,
	 * arena growth), so the walk re-loads `a.memory` after every update call.
	 * Entry wrapper owns the scratch-stack base restore (V8 inline budget).
	 */
	function arenaCheckDirty(a: WorldArena, startLink: number, startSub: number): boolean {
		if (startLink === 0) {
			return false
		}
		const stackBase = arenaCheckSp
		try {
			return arenaCheckDirtyLoop(a, startLink, startSub)
		} finally {
			arenaCheckSp = stackBase
		}
	}

	/**
	 * arenaUpdateShadow + sibling PENDING→DIRTY upgrade (both subs lists; heads
	 * captured before the refold, which can rebuild the lists). The kernel's
	 * single-sub skip is unsound under segregated lists — fuzzing found a
	 * weak-side validation stranding a lone strong sub PENDING — so both lists
	 * propagate unconditionally; the walker's own re-upgrade is a no-op.
	 */
	function arenaUpdateAndShallow(a: WorldArena, node: number): boolean {
		const subs = a.memory[node + ArenaField.SUBS]
		const weak = a.weakSubs[node >> ArenaGeom.ID_TO_COLUMN_SHIFT]
		if (arenaUpdateShadow(a, node)) {
			if (subs !== 0) {
				arenaShallowPropagate(a, subs)
			}
			if (weak !== 0) {
				arenaShallowPropagate(a, weak)
			}
			return true
		}
		return false
	}

	/** The general arena walk, out of line (the wrapper owns the arenaCheckSp restore across throwing folds). */
	function arenaCheckDirtyLoop(a: WorldArena, cur: number, sub: number): boolean {
		let checkDepth = 0
		let dirty = false
		let guard = 0
		top: do {
			if (++guard > ArenaWalk.CYCLE_CAP) {
				arenaWalkCycle('arenaCheckDirty', cur)
			}
			const memory = a.memory
			const dep = memory[cur + ArenaLinkField.DEP]
			const depFlags = memory[dep + ArenaField.FLAGS]
			if ((memory[sub + ArenaField.FLAGS] & ArenaFlag.DIRTY) !== 0) {
				dirty = true
			} else if (
				(depFlags & (ArenaFlag.MUTABLE | ArenaFlag.DIRTY)) ===
					(ArenaFlag.MUTABLE | ArenaFlag.DIRTY) ||
				// Cold base (decay evicted the value): nothing to validate against —
				// refold, or a top-first serve stale-serves its cone (tests/arena-sa3.spec.ts).
				(depFlags & (ArenaFlag.MUTABLE | ArenaFlag.VALID)) === ArenaFlag.MUTABLE
			) {
				if (arenaUpdateAndShallow(a, dep)) {
					dirty = true
				}
			} else if (
				(depFlags & (ArenaFlag.MUTABLE | ArenaFlag.PENDING)) ===
				(ArenaFlag.MUTABLE | ArenaFlag.PENDING)
			) {
				if (arenaCheckSp === arenaCheckStack.length) {
					const bigger = new Int32Array(arenaCheckStack.length * 2)
					bigger.set(arenaCheckStack)
					arenaCheckStack = bigger
				}
				arenaCheckStack[arenaCheckSp++] = cur
				cur = memory[dep + ArenaField.DEPS]!
				sub = dep
				++checkDepth
				continue
			}
			if (!dirty) {
				const nextDep = a.memory[cur + ArenaLinkField.NEXT_DEP]
				if (nextDep !== 0) {
					cur = nextDep
					continue
				}
			}
			while (checkDepth--) {
				cur = arenaCheckStack[--arenaCheckSp]!
				if (dirty) {
					if (arenaUpdateAndShallow(a, sub)) {
						sub = a.memory[cur + ArenaLinkField.SUB]!
						continue
					}
					dirty = false
				} else {
					a.memory[sub + ArenaField.FLAGS] = a.memory[sub + ArenaField.FLAGS] & ~ArenaFlag.PENDING
				}
				sub = a.memory[cur + ArenaLinkField.SUB]!
				const nextDep = a.memory[cur + ArenaLinkField.NEXT_DEP]
				if (nextDep !== 0) {
					cur = nextDep
					continue top
				}
			}
			return dirty
		} while (true)
	}

	// ---- fanout at the four flip sites + mark decay ----

	/**
	 * Mark flipped atoms' shadows in one arena, propagating PENDING over strong
	 * and weak links with read-clock dedup (a still-DIRTY shadow marked at the
	 * current clock is already walked). Render arenas are pin-frozen and take no
	 * log-entry fanout (dev-asserted); settlement is the one exemption.
	 */
	function fanAtomsToArena(a: WorldArena, atoms: AtomInternals[], fromSettlement: boolean): void {
		if (a.kind === 'render' && !fromSettlement) {
			throw new InvariantViolation(
				'log-entry-flip fanout reached a render arena — render-world values are pin-frozen',
			)
		}
		const memory = a.memory
		for (let i = 0; i < atoms.length; i++) {
			const sh = a.nodeToShadow[atoms[i].ix] ?? 0
			if (sh === 0) {
				continue
			} // no shadow: nothing consumes this atom here
			const flags = memory[sh + ArenaField.FLAGS]
			if ((flags & ArenaFlag.DIRTY) !== 0 && memory[sh + ArenaField.MARK] === a.readClock) {
				continue
			} // dedup
			if ((flags & ArenaFlag.DIRTY) === 0) {
				memory[sh + ArenaField.FLAGS] = flags | ArenaFlag.DIRTY
				a.dirty.push(sh) // dirty-list append on the mark's 0→1 edge
			}
			memory[sh + ArenaField.MARK] = a.readClock
			arenaPropagateBoth(a, sh) // strong and weak
		}
	}

	/** Reused single-atom buffer for single-write fanout (no per-write alloc). */
	const oneAtom: AtomInternals[] = []
	function getSingleAtomBuffer(atom: AtomInternals): AtomInternals[] {
		oneAtom[0] = atom
		return oneAtom
	}

	/** Fan into every live committed arena (retirement, quiet fold). */
	function fanAtomsToCommittedArenas(atoms: AtomInternals[]): void {
		if (rootToArena.size === 0) {
			return
		} // the one scalar check quiet writes pay
		for (const a of rootToArena.values()) {
			fanAtomsToArena(a, atoms, false)
		}
	}

	/**
	 * Decay-by-eviction: swap the dirty list; an unconsumed entry with no live
	 * consumer MAY drop to cold — the list stays bounded by live consumers' cones.
	 */
	function arenaDecay(a: WorldArena): void {
		if (a.dirty.length === 0) {
			return
		}
		const list = a.dirty
		a.dirty = []
		const memory = a.memory
		for (let i = 0; i < list.length; i++) {
			const sh = list[i]
			const flags = memory[sh + ArenaField.FLAGS]
			if ((flags & ArenaFlag.DIRTY) === 0) {
				continue
			} // consumed by an evaluation: drop the entry
			const nid = memory[sh + ArenaField.NODE]
			const ws = nodeToWatchers[nid]
			// Keep-the-dirt while any live observer can consume the mark (same-root
			// watcher or ANY observation retain): a dropped observed shadow would refold
			// cold — a clock bump with no value change — and re-fire spuriously.
			let watched = (flags & ArenaFlag.K_EFFECT) !== 0 || obsRefs[nid] > 0
			if (!watched && ws !== undefined) {
				for (let j = 0; j < ws.length; j++) {
					const w = ws[j]
					if (w.live && w.root === a.root) {
						watched = true
						break
					}
				}
			}
			if (watched) {
				a.dirty.push(sh) // keep-the-dirt: unconsumed marks survive to the next boundary
			} else {
				// Drop-to-cold: links and MUTABLE stay, so routing coverage survives.
				if ((flags & ArenaFlag.BOX_SUSPENDED) !== 0) {
					arenaUnsuspend(a, sh)
				}
				memory[sh + ArenaField.FLAGS] =
					flags &
					~(
						ArenaFlag.DIRTY |
						ArenaFlag.VALID |
						ArenaFlag.HAS_BOX |
						ArenaFlag.BOX_SUSPENDED |
						ArenaFlag.BOX_THROWN
					)
				a.vals[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT] = undefined
			}
		}
	}

	/**
	 * Purge one nodeIndex's shadow from every arena: evict, zero, unindex, thread
	 * onto the dead-shadow free list. Idempotent (an already-purged index skips).
	 */
	function purgeNodeFromArenas(ix: NodeIndex): void {
		eachArena((a) => {
			const sh = ix < a.nodeToShadow.length ? a.nodeToShadow[ix] : 0
			if (sh === 0) {
				return
			}
			arenaEvictShadow(a, sh)
			// Zero and unindex: dirty-list residue reads an inert record (FLAGS 0).
			for (let f = 0; f < ArenaGeom.STRIDE; f++) {
				a.memory[sh + f] = 0
			}
			a.nodeToShadow[ix] = 0
			// Thread onto the free list (see shadowFree); stale dirty-list entries stay benign (decay re-checks flags).
			a.memory[sh + ArenaField.DEPS] = a.shadowFree
			a.shadowFree = sh
		})
	}

	/**
	 * A settlement's arena half: scan the suspended list for shadows boxing this
	 * sentinel; matches mark DIRTY (listed), stamp the mark clock, and propagate
	 * PENDING over both subs lists (pin-exempt). Returns whether any matched.
	 */
	function arenaInvalidateSettled(a: WorldArena, suspendSentinel: SuspendedRead): boolean {
		const list = a.suspended
		const memory = a.memory
		let matched = false
		for (let j = 0; j < list.length; j++) {
			const sh = list[j]
			if (a.vals[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT] !== suspendSentinel) {
				continue
			}
			const flags = memory[sh + ArenaField.FLAGS]
			if ((flags & ArenaFlag.DIRTY) === 0) {
				memory[sh + ArenaField.FLAGS] = flags | ArenaFlag.DIRTY
				a.dirty.push(sh)
			}
			memory[sh + ArenaField.MARK] = a.readClock
			arenaPropagateBoth(a, sh) // strong and weak; pin-exempt for render arenas
			matched = true
		}
		if (matched) {
			arenaBumpReadClock(a)
		}
		return matched
	}

	// ---- the routing walks (arenas are the routing authority) ----

	/** Reused routing-walk stack (walks are never re-entrant). */
	const walkStack: number[] = []

	/** Collect the live watchers subscribed on one node, by nodeIndex (delivery walk). */
	function collectWatchersAt(nid: NodeIndex, found: Watcher[]): void {
		const ws = nodeToWatchers[nid]
		if (ws !== undefined) {
			for (let i = 0; i < ws.length; i++) {
				const w = ws[i]
				if (w.live) {
					found.push(w)
				}
			}
		}
	}

	/** Collect the live same-root watchers subscribed on one node, by nodeIndex (drains). */
	function collectRootWatchersAt(nid: NodeIndex, rootId: RootId, ws: Watcher[]): void {
		const nw = nodeToWatchers[nid]
		if (nw !== undefined) {
			for (let j = 0; j < nw.length; j++) {
				const w = nw[j]
				if (w.live && w.root === rootId) {
					ws.push(w)
				}
			}
		}
	}

	/**
	 * One arena's half of the delivery walk: DFS over strong subs lists only
	 * (weak never delivers); per-arena stamps terminate, global stamps dedup.
	 */
	function walkArenaStrong(
		a: WorldArena,
		from: NodeIndex,
		kGen: Generation,
		gen: WalkGen,
		found: Watcher[],
		effects: SignalEffect[],
	): void {
		const start = from < a.nodeToShadow.length ? a.nodeToShadow[from] : 0
		if (start === 0) {
			return
		}
		if (a.memory[start + ArenaField.NODE_GEN] !== kGen) {
			return
		}
		const memory = a.memory
		const walk = a.walk
		const stack = walkStack
		let sp = 0
		walk[start >> ArenaGeom.ID_TO_COLUMN_SHIFT] = gen
		stack[sp++] = start
		while (sp > 0) {
			const sh = stack[--sp]
			let l = memory[sh + ArenaField.SUBS]
			while (l !== 0) {
				const sub = memory[l + ArenaLinkField.SUB]
				if (walk[sub >> ArenaGeom.ID_TO_COLUMN_SHIFT] !== gen) {
					walk[sub >> ArenaGeom.ID_TO_COLUMN_SHIFT] = gen
					const effect = a.signalEffects[sub >> ArenaGeom.ID_TO_COLUMN_SHIFT]
					if (effect !== undefined) {
						if (effect.walkGen !== gen) {
							effect.walkGen = gen
							effects.push(effect)
						}
					} else {
						stack[sp++] = sub
						const nid = memory[sub + ArenaField.NODE]
						if (lastWalk[nid] !== gen) {
							lastWalk[nid] = gen
							collectWatchersAt(nid, found)
						}
					}
				}
				l = memory[l + ArenaLinkField.NEXT_SUB]!
			}
		}
	}

	/**
	 * The durable drain's candidate collection: the root arena's dirty list seeds
	 * a walk over ALL links (strong and weak), collecting live same-root watchers
	 * with the global dedup stamps. Never folds or allocates; the drain owns the rest.
	 */
	function arenaCollectDrainCandidates(
		a: WorldArena,
		gen: WalkGen,
		rootId: RootId,
		ws: Watcher[],
	): void {
		const memory = a.memory
		const walk = a.walk
		const stack = walkStack
		let sp = 0
		const list = a.dirty
		for (let i = 0; i < list.length; i++) {
			const sh = list[i]
			if (walk[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT] === gen) {
				continue
			}
			walk[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT] = gen
			stack[sp++] = sh
			const nid = memory[sh + ArenaField.NODE]
			if (lastWalk[nid] !== gen) {
				lastWalk[nid] = gen
				collectRootWatchersAt(nid, rootId, ws)
			}
		}
		while (sp > 0) {
			const sh = stack[--sp]
			// Both subs lists: drains expand over weak links too.
			for (let list = 0; list < 2; list++) {
				let l = arenaSubsHead(a, sh, list)
				while (l !== 0) {
					const sub = memory[l + ArenaLinkField.SUB]
					if (walk[sub >> ArenaGeom.ID_TO_COLUMN_SHIFT] !== gen) {
						walk[sub >> ArenaGeom.ID_TO_COLUMN_SHIFT] = gen
						stack[sp++] = sub
						const nid = memory[sub + ArenaField.NODE]
						if (lastWalk[nid] !== gen) {
							lastWalk[nid] = gen
							collectRootWatchersAt(nid, rootId, ws)
						}
					}
					l = memory[l + ArenaLinkField.NEXT_SUB]!
				}
			}
		}
	}

	/** One arena's reverse-deps half of the fixup closure (strong links); shadows map back to NodeIds via the node row. */
	function collectArenaClosure(a: WorldArena, node: AnyInternals, closure: Set<NodeId>): void {
		const start = node.ix < a.nodeToShadow.length ? a.nodeToShadow[node.ix] : 0
		if (start === 0) {
			return
		}
		if (a.memory[start + ArenaField.NODE_GEN] !== getKernelGeneration(node.id)) {
			return
		} // dead-tenancy residue never routes
		const gen = ++walkGen
		const memory = a.memory
		const walk = a.walk
		const stack = walkStack
		let sp = 0
		walk[start >> ArenaGeom.ID_TO_COLUMN_SHIFT] = gen
		stack[sp++] = start
		while (sp > 0) {
			const sh = stack[--sp]
			let l = memory[sh + ArenaField.DEPS]
			while (l !== 0) {
				if ((memory[l + ArenaLinkField.MODE] & ArenaLinkMode.WEAK) === 0) {
					const dep = memory[l + ArenaLinkField.DEP]
					if (walk[dep >> ArenaGeom.ID_TO_COLUMN_SHIFT] !== gen) {
						walk[dep >> ArenaGeom.ID_TO_COLUMN_SHIFT] = gen
						const depNode = nodeIndexToInternals[memory[dep + ArenaField.NODE]]
						if (depNode !== undefined) {
							closure.add(depNode.id)
						}
						stack[sp++] = dep
					}
				}
				l = memory[l + ArenaLinkField.NEXT_DEP]!
			}
		}
	}

	/**
	 * One fold-truth evaluation frame (the armed checker's naive fn runs): the
	 * serve override becomes FOLD_TRUTH so nothing routes back into the arena
	 * under check, the world pins those folds' visibility, sink and observation
	 * capture close, and the eval depth bumps (writes throw). Restores on exit.
	 */
	function runInFoldTruthFrame<T>(world: World, fn: () => T): T {
		const savedWorld = activeWorld
		const savedRoute = serveOverride
		const savedSink = currentSink
		const savedObsCapture = obsCapture
		setWorld(world)
		serveOverride = FOLD_TRUTH
		currentSink = 0
		obsCapture = undefined
		evalDepth++
		try {
			return fn()
		} finally {
			evalDepth--
			obsCapture = savedObsCapture
			currentSink = savedSink
			serveOverride = savedRoute
			setWorld(savedWorld)
		}
	}

	/**
	 * Diagnostics surface, never consulted by engine logic: dependency edges as
	 * dep → dependents (kernel NodeIds), unioned over every live arena's links.
	 * Read by graphviz, model-comparison tests, soak metrics.
	 */
	function dependencyEdges(): Map<NodeId, Set<NodeId>> {
		const out = new Map<NodeId, Set<NodeId>>()
		eachArena((a) => {
			const memory = a.memory
			for (let ix = 0; ix < a.nodeToShadow.length; ix++) {
				const sh = a.nodeToShadow[ix]
				if (sh === 0) {
					continue
				}
				const depNode = nodeIndexToInternals[ix]
				if (depNode === undefined) {
					continue
				} // dead residue: not part of the live graph
				for (let list = 0; list < 2; list++) {
					let l = arenaSubsHead(a, sh, list)
					while (l !== 0) {
						const sub = memory[l + ArenaLinkField.SUB]
						const subNode = nodeIndexToInternals[memory[sub + ArenaField.NODE]]
						if (subNode !== undefined) {
							let s = out.get(depNode.id)
							if (s === undefined) {
								s = new Set()
								out.set(depNode.id, s)
							}
							s.add(subNode.id)
						}
						l = memory[l + ArenaLinkField.NEXT_SUB]!
					}
				}
			}
		})
		return out
	}

	/**
	 * Test seam: a committed arena's (dep → sub) link mode, or undefined
	 * when no link exists (the mode-transition pins read it). @internal
	 */
	function __TEST__arenaLinkMode(
		rootId: RootId,
		dep: AnyInternals,
		sub: AnyInternals,
	): 'strong' | 'weak' | undefined {
		const a = rootToArena.get(rootId)
		if (a === undefined) {
			return undefined
		}
		const depSh = a.nodeToShadow[dep.ix] ?? 0
		const subSh = a.nodeToShadow[sub.ix] ?? 0
		if (depSh === 0 || subSh === 0) {
			return undefined
		}
		let cur = a.memory[subSh + ArenaField.DEPS]
		while (cur !== 0) {
			if (a.memory[cur + ArenaLinkField.DEP] === depSh) {
				return (a.memory[cur + ArenaLinkField.MODE] & ArenaLinkMode.WEAK) !== 0 ? 'weak' : 'strong'
			}
			cur = a.memory[cur + ArenaLinkField.NEXT_DEP]!
		}
		return undefined
	}

	/**
	 * Test seam: a committed arena's live (dep → sub) link record id, or 0 when
	 * none (freelist-discipline pins capture ids before a teardown). @internal
	 */
	function __TEST__arenaLinkId(rootId: RootId, dep: AnyInternals, sub: AnyInternals): number {
		const a = rootToArena.get(rootId)
		if (a === undefined) {
			return 0
		}
		const depSh = a.nodeToShadow[dep.ix] ?? 0
		const subSh = a.nodeToShadow[sub.ix] ?? 0
		if (depSh === 0 || subSh === 0) {
			return 0
		}
		let cur = a.memory[subSh + ArenaField.DEPS]
		while (cur !== 0) {
			if (a.memory[cur + ArenaLinkField.DEP] === depSh) {
				return cur
			}
			cur = a.memory[cur + ArenaLinkField.NEXT_DEP]!
		}
		return 0
	}

	/**
	 * Test seam: raw NEXT_DEP of an arena link record by id — valid on freed
	 * links too (stale nextDep must name former neighbors, never the free list). @internal
	 */
	function __TEST__arenaLinkNextDep(rootId: RootId, linkId: number): number {
		const a = rootToArena.get(rootId)
		if (a === undefined) {
			return -1
		}
		return a.memory[linkId + ArenaLinkField.NEXT_DEP] ?? -1
	}

	// ---- delivery: the notification queue + the walk orchestration --------------------------
	// A DELIVERY is the notification that schedules a watcher's re-render after
	// a write; a DRAIN is the sweep run when committed truth moves, re-checking
	// every observer the change could reach and correcting the stale ones.
	// Listener callbacks (the onDelivery/onMountCorrective/onCorrection slots
	// attachDriver assigns) queue during an operation's own mutations and run
	// only at the operation boundary, never inside a half-finished operation.

	/** Queued-notification kind codes (same-file const enum; see {@link NodeField}). */
	const enum NotifyKind {
		DELIVERY = 0,
		MOUNT_CORRECTIVE = 1,
		CORRECTION = 2,
		SIGNAL_EFFECT = 3,
	}

	/** The queue's two live scalars: the item count and the mid-flush (re-entrancy) flag. */
	type NotifyState = { n: number; flushing: boolean }

	// Queued-notification columns (reused across operations; no per-notify objects).
	const notifyKinds: number[] = []
	const notifyObservers: (Watcher | undefined)[] = []
	const notifyBatches: (Batch | undefined)[] = []
	const notifySlots: BatchSlot[] = []
	const notifyEffects: (SignalEffect | undefined)[] = []
	const notifyState: NotifyState = { n: 0, flushing: false }

	function queueNotify(
		kind: NotifyKind,
		obs: Watcher | undefined,
		t: Batch | undefined,
		slot: BatchSlot,
		effect?: SignalEffect,
	): void {
		const i = notifyState.n++
		notifyKinds[i] = kind
		notifyObservers[i] = obs
		notifyBatches[i] = t
		notifySlots[i] = slot
		notifyEffects[i] = effect
	}

	/**
	 * Invokes queued listeners at the end of the public operation. A nested
	 * public operation started BY a listener appends behind the live bound
	 * and drains in the same sweep (the flushing flag stops nested sweeps).
	 */
	function flushNotify(): void {
		if (notifyState.n === 0 || notifyState.flushing) {
			return
		}
		// Listener slots are read live per item — detaching mid-flush affects the rest.
		notifyState.flushing = true
		try {
			for (let i = 0; i < notifyState.n; i++) {
				const kind = notifyKinds[i]
				const obs = notifyObservers[i]
				const t = notifyBatches[i]
				const effect = notifyEffects[i]
				notifyObservers[i] = undefined // release object refs eagerly
				notifyBatches[i] = undefined
				notifyEffects[i] = undefined
				if (kind === NotifyKind.DELIVERY) {
					const l = onDelivery
					if (l !== undefined) {
						l(obs!, t!, notifySlots[i])
					}
				} else if (kind === NotifyKind.MOUNT_CORRECTIVE) {
					const l = onMountCorrective
					if (l !== undefined) {
						l(obs!, t!, notifySlots[i])
					}
				} else if (kind === NotifyKind.CORRECTION) {
					const l = onCorrection
					if (l !== undefined) {
						l(obs!)
					}
				} else if (effect !== undefined && effect.live) {
					effect.queuedRun = false
					const listener = onSignalEffect
					if (listener !== undefined) {
						listener(effect)
					}
				}
			}
		} finally {
			notifyState.n = 0
			notifyState.flushing = false
		}
	}

	/** Reused delivery-walk collection buffer (walks are never re-entrant). */
	const walkWatchers: Watcher[] = []
	const walkEffects: SignalEffect[] = []

	/** Reused durable-drain candidate buffer (drains are never re-entrant). */
	const drainWatcherBuf: Watcher[] = []

	/**
	 * The value-blind per-write delivery walk: reachability from the written
	 * atom over every live arena's strong links (weak links never traverse —
	 * untracked reads never notify). It visits structure, never values — the
	 * receiving render folds its own world — so a paused render's pinned view
	 * is untouched. Watchers dedup per node ({@link lastWalk}) and deliver in
	 * id order; dependents no live arena holds fall to the committed-truth drain.
	 */
	function deliveryWalk(from: AtomInternals, batch: Batch, slot: BatchSlotMeta, seq: Seq): void {
		const gen = ++walkGen
		const found = walkWatchers
		const effects = walkEffects
		found.length = 0
		effects.length = 0
		const kGen = getKernelGeneration(from.id) // one read per walk: seeds validate tenancy against it
		lastWalk[from.ix] = gen
		collectWatchersAt(from.ix, found)
		for (const a of rootToArena.values()) {
			walkArenaStrong(a, from.ix, kGen, gen, found, effects)
		}
		for (const p of rootToOpenRender.values()) {
			if (p.arena !== undefined) {
				walkArenaStrong(p.arena, from.ix, kGen, gen, found, effects)
			}
		}
		const bit = 1 << slot.id
		for (let i = 0; i < effects.length; i++) {
			effects[i].pendingSlots |= bit
		}
		if (found.length > 1) {
			found.sort((a, b) => a.id - b.id)
		}
		for (let i = 0; i < found.length; i++) {
			deliver(found[i], batch, slot, seq)
		}
		found.length = 0
		effects.length = 0
	}

	/**
	 * Delivery — per-write, value-blind, in the writer's stack. The
	 * per-(watcher, slot) dedup bit suppresses a repeat delivery only when
	 * scheduled-but-unstarted work will fold the write anyway; otherwise
	 * deliver interleaved so no write can slip between renders unseen.
	 */
	function deliver(w: Watcher, batch: Batch, slot: BatchSlotMeta, seq: Seq): void {
		const tr = trace // one load covers this call's (at most two) record sites
		const bit = 1 << slot.id
		if ((w.dedupBits & bit) === 0) {
			w.dedupBits |= bit
			if (tr !== undefined) {
				tr.delivery(w, batch.id, slot.id, seq, false)
			}
			if (onDelivery !== undefined) {
				queueNotify(NotifyKind.DELIVERY, w, batch, slot.id)
			}
			return
		}
		// Bit set: an open render that froze BEFORE this write (slot in its
		// mask, pin < seq) would fold without it — deliver again; else suppress.
		const p = rootToOpenRender.get(w.root)
		if (p !== undefined && ((p.maskBits >>> slot.id) & 1) === 1 && p.pin < seq) {
			if (tr !== undefined) {
				tr.delivery(w, batch.id, slot.id, seq, true)
			}
			if (onDelivery !== undefined) {
				queueNotify(NotifyKind.DELIVERY, w, batch, slot.id)
			}
		} else {
			if (tr !== undefined) {
				tr.suppressed(w, batch.id, slot.id, seq)
			}
		}
	}

	/**
	 * The one urgent pre-paint watcher correction. Every compare-and-correct
	 * site (settlement/quiet/durable drains, mount fixup) shares this body so
	 * its effect tuple — rendered register, lastValidatedAt stamp, dedup
	 * re-arm, queued notify — never drifts. Returns true iff a correction fired.
	 *
	 * Drain causes gate on clocks: fire iff the watched node's per-root
	 * committed clock differs from the watcher's lastValidatedAt; refolded
	 * flip-flops re-fire spuriously by accepted design. Two cross-world cases
	 * compare values (clocks cannot relate two worlds): 'mount', whose stamp
	 * the commit step after it owns, and watchers the committing render just
	 * reset, whose clock its lock-in bumps for content already on screen.
	 * Quiet corrections record no trace; the fold's quiet-write record covers that.
	 */
	function correctWatcher(
		w: Watcher,
		wInternals: AnyInternals,
		now: Value,
		cause: 'retirement' | 'per-root-commit' | 'quiet' | 'mount',
	): boolean {
		const committing = committingRender
		if (
			cause === 'mount' ||
			(committing !== undefined && w.snapshot.renderPassId === committing.id)
		) {
			// Cross-world gate (the value compare per-root clocks cannot replace).
			if (!isValueChanged(wInternals, w.lastRenderedValue, now)) {
				return false
			}
			if (cause !== 'mount') {
				const a = rootToArena.get(w.root)
				if (a !== undefined) {
					w.lastValidatedAt = committedNodeClock(a, w.nodeIx)
				}
			}
		} else {
			const a = rootToArena.get(w.root)
			const clockNow = a === undefined ? 0 : committedNodeClock(a, w.nodeIx)
			if (clockNow === w.lastValidatedAt) {
				return false
			}
			w.lastValidatedAt = clockNow
		}
		if (cause !== 'quiet') {
			const tr = trace
			if (tr !== undefined) {
				if (cause === 'mount') {
					tr.mountCorrection(w, w.lastRenderedValue, now)
				} else {
					tr.reconcileCorrection(w, w.root, w.lastRenderedValue, now, cause === 'per-root-commit')
				}
			}
		}
		w.lastRenderedValue = now // the urgent pre-paint re-render
		w.dedupBits = 0 // dedup bits re-arm at the watcher's render
		if (onCorrection !== undefined) {
			queueNotify(NotifyKind.CORRECTION, w, undefined, 0)
		}
		return true
	}

	/**
	 * The shared drain consult: resolve the watcher's node (skip if tenancy
	 * moved), evaluate it in `world`, settle the watched node's committed
	 * clock so the correction gate reads settled state, then {@link correctWatcher}.
	 */
	function reconcileWatcher(
		w: Watcher,
		a: WorldArena | undefined,
		world: World,
		cause: 'retirement' | 'per-root-commit' | 'quiet',
	): void {
		const wInternals = resolveWatcherInternals(w)
		if (wInternals === undefined) {
			return
		} // loud skip: record tenancy moved
		const now = evaluate(wInternals, world)
		if (a !== undefined) {
			settleObserverClock(a, wInternals)
		}
		correctWatcher(w, wInternals, now, cause)
	}

	/**
	 * Drain for a quiet fold: committed truth moved for every root and no walk
	 * state scopes candidates, so every live watcher re-checks directly.
	 */
	function quietDrain(): void {
		for (const w of watchers.values()) {
			if (!w.live) {
				continue
			}
			reconcileWatcher(w, rootToArena.get(w.root), { kind: 'committed', root: w.root }, 'quiet')
		}
	}

	/**
	 * The durable drain at a committed-truth flip (retirement or per-root
	 * commit): the root arena's dirty list, expanded over ALL arena links —
	 * weak included, unlike the delivery walk — plus the {@link restaled} set,
	 * reconciled in id order against committed truth. Value compares are legal
	 * here (both sides committed); stale dirty entries seed value-gated no-ops.
	 * SignalEffects validate their graph terminals at the same outer boundary.
	 */
	function drainCommittedObservers(rootId: RootId, cause: 'retirement' | 'per-root-commit'): void {
		const world: World = { kind: 'committed', root: rootId }
		const gen = ++walkGen // per-node collection dedup + per-arena traversal stamps
		const ws = drainWatcherBuf
		ws.length = 0
		const a = rootToArena.get(rootId)
		if (a !== undefined && a.dirty.length !== 0) {
			arenaCollectDrainCandidates(a, gen, rootId, ws)
		}
		{
			const re = restaled.get(rootId)
			if (re !== undefined && re.size > 0) {
				for (const w of re) {
					if (!w.live) {
						continue
					}
					if (lastWalk[w.nodeIx] === gen) {
						continue
					} // its node was already listed (cached index; valid while the gen-checked fire below resolves)
					ws.push(w)
				}
				re.clear()
			}
		}
		if (ws.length > 1) {
			ws.sort((a, b) => a.id - b.id)
		}
		for (let i = 0; i < ws.length; i++) {
			reconcileWatcher(ws[i], a, world, cause)
		}
		ws.length = 0
	}

	// ---- settlement ---------------------------------------------------------------------
	// A settlement is a pending thenable — one a computed suspended on through
	// ctx.use, leaving a {@link SuspendedRead} sentinel in caches — resolving or
	// rejecting. Every world view that cached that sentinel must re-evaluate:
	// {@link settleTap} queues the sentinel; {@link drainSettlements} invalidates
	// the arenas caching it and re-checks their observers.

	/** Queue of settled sentinels awaiting a drain; the set dedupes by identity. */
	let pendingSettle: SuspendedRead[] = []
	const pendingSettleSet = new Set<SuspendedRead>()
	let settleDraining = false
	let settleDrainScheduled = false
	/** Drain iteration cap: a chain synchronously settling ever-new thenables is a user bug, reported on breach. */
	let settleCap = 10_000

	/** Test seam: shrink the settlement-drain iteration cap. @internal */
	function setSettleCap(n: number): void {
		settleCap = n
	}

	/**
	 * Queues a settling thenable's sentinel, then drains now or at the next
	 * boundary. Called by the listener {@link unwrapThenable} installs, after
	 * the status write; creating the sentinel here keeps one identity with the
	 * read-side throw even when a thenable's callbacks run synchronously.
	 */
	function settleTap(t: PromiseLike<unknown>): void {
		const th = t as PromiseLike<unknown> & { suspendSentinel?: SuspendedRead }
		const suspendSentinel = (th.suspendSentinel ??= new SuspendedRead(t))
		if (suspendedCount === 0 && pendingSettle.length === 0) {
			return
		} // no arena suspensions anywhere
		if (pendingSettleSet.has(suspendSentinel)) {
			return
		} // queued bit
		pendingSettleSet.add(suspendSentinel)
		pendingSettle.push(suspendSentinel)
		if (
			settleDraining ||
			notifyState.flushing ||
			opDepth !== 0 ||
			evalDepth !== 0 ||
			inFoldCallback
		) {
			// {@link runOperationEpilogue} (or the running drain) consumes the
			// queue; bare reads never run it, so a microtask drain backstops.
			if (!settleDrainScheduled) {
				settleDrainScheduled = true
				// A drain scheduled before an engine reset must not run after it.
				const epoch = engineEpoch
				queueMicrotask(() => {
					settleDrainScheduled = false
					if (epoch !== engineEpoch) {
						return
					}
					if (
						pendingSettle.length !== 0 &&
						opDepth === 0 &&
						evalDepth === 0 &&
						!settleDraining &&
						!notifyState.flushing
					) {
						drainSettlements()
					}
				})
			}
			return
		}
		// At rest: drain immediately, so delivery never waits for an unrelated operation.
		drainSettlements()
	}

	/**
	 * The only consumer of the settlement queue. {@link flushNotify} runs
	 * inside the loop, so a callback that synchronously settles another
	 * thenable lands in the queue and gets the next iteration; the drain never
	 * returns with a settlement unscanned or a notification unflushed.
	 */
	function drainSettlements(): void {
		if (settleDraining) {
			return
		}
		settleDraining = true
		opDepth++ // taps landing mid-drain enqueue (next iteration)
		try {
			let iter = 0
			while (pendingSettle.length !== 0) {
				if (++iter > settleCap) {
					throw new InvariantViolation(
						`settlement drain exceeded ${settleCap} iterations — a settlement chain is synchronously settling ever-new thenables (user feedback, the effect-loop equivalent)`,
					)
				}
				const taken = pendingSettle
				pendingSettle = []
				for (let i = 0; i < taken.length; i++) {
					pendingSettleSet.delete(taken[i])
				}
				const touchedRoots = new Set<RootId>()
				for (let i = 0; i < taken.length; i++) {
					const suspendSentinel = taken[i]
					eachArena((a) => {
						// Mark shadows caching this sentinel stale; the scan and mark
						// mechanics live in {@link arenaInvalidateSettled}.
						if (arenaInvalidateSettled(a, suspendSentinel) && a.kind === 'committed') {
							touchedRoots.add(a.root)
						}
					})
					// (Kernel-cached suspensions need nothing here: {@link attachSettleListener} invalidates them; {@link boxedRead} self-heals.)
				}
				// Re-check each touched root's live watchers against the fresh
				// marks; roots with an open render frame defer to the frame's close.
				for (const rootId of touchedRoots) {
					if (rootToOpenRender.has(rootId)) {
						continue
					}
					const ra = rootToArena.get(rootId)
					const world: World = { kind: 'committed', root: rootId }
					for (const w of watchers.values()) {
						if (!w.live || w.root !== rootId) {
							continue
						}
						reconcileWatcher(w, ra, world, 'retirement')
					}
				}
				// (Settlement moves world visibility, never newest values, so core effects need nothing here.)
				if (signalEffectCount !== 0) {
					flushDirtySignalEffects(undefined)
				}
				flushNotify()
			}
		} finally {
			opDepth--
			settleDraining = false
		}
		// Suspension state just moved across every arena — retry skipped reclamations.
		reclaimRetryAllSkipped()
	}

	/**
	 * The epilogue every public operation runs on exit: drain queued
	 * settlements to empty, then the divergence check a test armed
	 * ({@link epilogueCheck}) — both only at the outermost exit.
	 */
	function runOperationEpilogue(): void {
		if (opDepth !== 0) {
			return
		} // nested operation: the outer epilogue owns the boundary
		if (pendingSettle.length !== 0 && !settleDraining) {
			drainSettlements()
		}
		// Safety net: consume any quiet-pipeline boundary owed by a write issued
		// from inside a frame that could not drain it (e.g. a SignalEffect body
		// writing during a settlement drain). A no-op when nothing is owed.
		drainQuietBoundary()
		if (epilogueCheck !== undefined) {
			epilogueCheck()
		}
	}

	/**
	 * The last act inside every public operation's frame, shared by every
	 * exit: mark the operation's end for the tracer, then flush notifications.
	 */
	function endOperation(): void {
		const tr = trace
		if (tr !== undefined) {
			tr.opEnd()
		}
		flushNotify()
	}

	/** Queue depth (diagnostics — the engine's __TEST__arenaStats). */
	function getPendingSettleCount(): number {
		return pendingSettle.length
	}

	// ---- observer records --------------------------------------------------------------
	// An observer is the engine's per-consumer record: kernel node-allocator
	// storage plus side-column slots, with the role carried as record data
	// ({@link ObserverField} maps the layout). The handle class below owns two
	// ids and one cached extras reference; every other property is an accessor
	// over the record, so observer state lives in the arena and dies with the
	// record. The role lifecycles live in their own later sections.

	/**
	 * A watcher's rendered-world snapshot: what the mounting render saw (its
	 * slot sets, copied by integer assignment). Stored flattened in the observer
	 * record's extras object; replaced wholesale at mount and committed re-render.
	 */
	type WatcherSnapshot = {
		renderPassId: RenderPassId
		pin: Seq
		maskBits: BatchSlotSet
		includedBits: BatchSlotSet
		rootCommitGen: CommitGen
	}

	/** A watcher's cold fields. The column slot scrubs at record free. */
	type ObserverExtras = {
		name: string
		root: RootId
		// — watcher role: the flattened {@link WatcherSnapshot} fields.
		renderPassId: RenderPassId
		pin: Seq
		maskBits: BatchSlotSet
		includedBits: BatchSlotSet
		rootCommitGen: CommitGen
	}

	/**
	 * One component watcher bound to one node. `id` is monotone mount order
	 * and never recycles; the arena record does.
	 * After {@link Kernel.disposeObserver} frees the record, the accessors
	 * read dead storage, so engine paths resolve through the live stores first.
	 */
	class Watcher {
		readonly id: ObserverId
		/** The observer's arena record ({@link ObserverField} is the layout). @internal */
		readonly rec: NodeId
		/** The cached extras object ({@link ObserverExtras}). @internal */
		private readonly x: ObserverExtras

		constructor(id: ObserverId, name: string, root: RootId) {
			this.id = id
			const rec = E.newObserver(NodeFlag.K_WATCHER)
			this.rec = rec
			const x: ObserverExtras = {
				name,
				root,
				renderPassId: 0,
				pin: 0,
				maskBits: 0,
				includedBits: 0,
				rootCommitGen: 0,
			}
			extras[rec >> ArenaShape.ID_TO_EXTRAS_SHIFT] = x
			this.x = x
		}

		/** Diagnostic label (mutable — watchers are renamed after mount); traces read it. */
		get name(): string {
			return this.x.name
		}
		set name(v: string) {
			this.x.name = v
		}

		/** Owning root: scopes delivery suppression and drains. */
		get root(): RootId {
			return this.x.root
		}

		// ------------------------------------------------------ watcher role

		/** The watched node record id (the component reads this node). */
		get node(): NodeId {
			return E.buffer()[this.rec + ObserverField.NODE]
		}

		/** The watched record's NODE_INDEX, cached at mount (slot-tied — never stale). @internal */
		get nodeIx(): NodeIndex {
			return E.buffer()[this.rec + ObserverField.NODE_IX]
		}

		/**
		 * The watched record's tenancy generation at mount: record ids recycle,
		 * so watcher→node resolutions check this stamp and skip on mismatch.
		 */
		get nodeRecordGen(): Generation {
			return E.buffer()[this.rec + ObserverField.NODE_GEN]
		}

		/**
		 * Per-(watcher, batch-slot) delivery dedup bits, one int word: a second
		 * write in a slot re-delivers only if no scheduled render will fold it.
		 */
		get dedupBits(): BatchSlotSet {
			return E.buffer()[this.rec + ObserverField.DEDUP_BITS]
		}
		set dedupBits(bits: BatchSlotSet) {
			E.buffer()[this.rec + ObserverField.DEDUP_BITS] = bits
		}

		/**
		 * What the committed screen shows for this watcher (the values-column
		 * slot). Never a re-fire gate — corrections are clock-decided; mount
		 * seeding, `ctx.previous`, and correction payloads read it.
		 */
		get lastRenderedValue(): Value {
			return values[this.rec >> ArenaShape.ID_TO_VALUE_SHIFT]
		}
		set lastRenderedValue(v: Value) {
			values[this.rec >> ArenaShape.ID_TO_VALUE_SHIFT] = v
		}

		/**
		 * The watcher's clock-column stamp: the watched node's per-root
		 * committed clock when the screen last agreed with committed truth. A
		 * committed matching render or an urgent correction advances it; 0 means
		 * never (a re-staled commit resets it, forcing the next correction).
		 * Corrections gate on this stamp alone — mismatch means re-fire.
		 */
		get lastValidatedAt(): Clock {
			return E.clocks()[this.rec >> ArenaShape.ID_TO_CLOCK_SHIFT]
		}
		set lastValidatedAt(c: Clock) {
			E.clocks()[this.rec >> ArenaShape.ID_TO_CLOCK_SHIFT] = c
		}

		/**
		 * The rendered-world snapshot ({@link WatcherSnapshot}): the getter is
		 * the extras object itself; the setter rewrites five fields in place.
		 */
		get snapshot(): WatcherSnapshot {
			return this.x
		}
		set snapshot(s: WatcherSnapshot) {
			const x = this.x
			x.renderPassId = s.renderPassId
			x.pin = s.pin
			x.maskBits = s.maskBits
			x.includedBits = s.includedBits
			x.rootCommitGen = s.rootCommitGen
		}

		/**
		 * Subscribed-for-delivery bit ({@link NodeFlag.OBSERVER_LIVE}). A live
		 * watcher holds one observed-consumer retain on its watched node, carried
		 * transitively by the observation index ({@link observerShift}); every
		 * watcher liveness flip routes through this setter.
		 * Edge-filtered, so a dead handle's `live = false` is a safe no-op.
		 */
		get live(): boolean {
			return (E.buffer()[this.rec + ObserverField.FLAGS] & NodeFlag.OBSERVER_LIVE) !== 0
		}
		set live(value: boolean) {
			const memory = E.buffer()
			const flags = memory[this.rec + ObserverField.FLAGS]
			if (((flags & NodeFlag.OBSERVER_LIVE) !== 0) === value) {
				return
			}
			memory[this.rec + ObserverField.FLAGS] = value
				? flags | NodeFlag.OBSERVER_LIVE
				: flags & ~NodeFlag.OBSERVER_LIVE
			observerShift(this, value ? 1 : -1)
		}
	}

	type SignalEffectExtras = {
		name: string
		root: RootId
		nodes: (AnyInternals | undefined)[]
		body: (() => void) | undefined
		lastValue: Value
		runs: number
		cleanups: number
		traceValues: Value[] | undefined
		pendingReactRun: boolean
	}

	/**
	 * A committed graph terminal. Its root-arena shadow owns the canonical
	 * dependency links; this handle owns identity and cold diagnostics.
	 */
	class SignalEffect {
		readonly id: SignalEffectId
		readonly rec: NodeId
		private readonly x: SignalEffectExtras
		arena: WorldArena | undefined
		shadow: ShadowId = 0
		walkGen = 0
		queuedRun = false
		pendingSlots = 0
		pendingReactSlots = 0
		reportPass = 0
		reportIndex = 0

		constructor(
			id: SignalEffectId,
			name: string,
			root: RootId,
			nodes: (AnyInternals | undefined)[],
		) {
			this.id = id
			const rec = E.newObserver(NodeFlag.K_SIGNAL_EFFECT | NodeFlag.OBSERVER_LIVE)
			this.rec = rec
			const x: SignalEffectExtras = {
				name,
				root,
				nodes,
				body: undefined,
				lastValue: undefined,
				runs: 0,
				cleanups: 0,
				traceValues: undefined,
				pendingReactRun: false,
			}
			extras[rec >> ArenaShape.ID_TO_EXTRAS_SHIFT] = x
			this.x = x
		}

		get name(): string {
			return this.x.name
		}

		get root(): RootId {
			return this.x.root
		}

		/** Materializes the canonical graph edges only for diagnostics. */
		get deps(): { node: AnyInternals; value: Value }[] {
			const out: { node: AnyInternals; value: Value }[] = []
			const a = this.arena
			if (a === undefined || this.shadow === 0) {
				return out
			}
			let link = a.memory[this.shadow + ArenaField.DEPS]
			while (link !== 0) {
				const dep = a.memory[link + ArenaLinkField.DEP]
				const node = this.x.nodes[a.memory[dep + ArenaField.NODE]]
				if (
					node !== undefined &&
					a.memory[dep + ArenaField.NODE_GEN] === getKernelGeneration(node.id)
				) {
					out.push({ node, value: a.vals[dep >> ArenaGeom.ID_TO_COLUMN_SHIFT] })
				}
				link = a.memory[link + ArenaLinkField.NEXT_DEP]!
			}
			return out
		}

		get body(): (() => void) | undefined {
			return this.x.body
		}
		set body(value: (() => void) | undefined) {
			this.x.body = value
		}

		get lastValue(): Value {
			return this.x.lastValue
		}
		set lastValue(value: Value) {
			this.x.lastValue = value
		}

		get runs(): number {
			return this.x.runs
		}
		set runs(value: number) {
			this.x.runs = value
		}

		get cleanups(): number {
			return this.x.cleanups
		}
		set cleanups(value: number) {
			this.x.cleanups = value
		}

		get pendingReactRun(): boolean {
			return this.x.pendingReactRun
		}
		set pendingReactRun(value: boolean) {
			this.x.pendingReactRun = value
		}

		get traceValues(): Value[] | undefined {
			return this.x.traceValues
		}
		set traceValues(value: Value[] | undefined) {
			this.x.traceValues = value
		}

		get live(): boolean {
			return (E.buffer()[this.rec + SignalEffectField.FLAGS] & NodeFlag.OBSERVER_LIVE) !== 0
		}
	}

	/** Create a watcher-role observer: bind the watched node, seed value and snapshot. */
	function newWatcher(
		id: ObserverId,
		name: string,
		root: RootId,
		node: AnyInternals,
		value: Value,
		snapshot: WatcherSnapshot,
	): Watcher {
		const w = new Watcher(id, name, root)
		const memory = E.buffer()
		memory[w.rec + ObserverField.NODE] = node.id
		memory[w.rec + ObserverField.NODE_GEN] = getKernelGeneration(node.id)
		memory[w.rec + ObserverField.NODE_IX] = node.ix
		values[w.rec >> ArenaShape.ID_TO_VALUE_SHIFT] = value
		w.snapshot = snapshot
		return w
	}

	// ---- committed SignalEffect terminals ---------------------------------------------

	/**
	 * A node's per-root committed clock by nodeIndex (0 = never consulted).
	 * Reads WITHOUT settling: callers run after a consult already settled it.
	 */
	function committedNodeClock(a: WorldArena, ix: NodeIndex): Clock {
		const sh = ix < a.nodeToShadow.length ? a.nodeToShadow[ix] : 0
		return sh === 0 ? 0 : a.clocks[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT]
	}

	/** Live terminals by id; fresh per composition. */
	let idToSignalEffect: Map<SignalEffectId, SignalEffect>
	const dirtySignalEffects: SignalEffect[] = []
	let nextSignalEffectId = 1

	/**
	 * Register the production `useSignalEffect` terminal. Illegal inside an evaluation/fold frame: the
	 * record is committed-consumer state and must never exist for a discarded
	 * render attempt (the render-stack half of the guard is the adapter's).
	 */
	function mountSignalEffect(rootId: RootId, name: string): SignalEffect {
		if (evalDepth > 0 || inFoldCallback) {
			throw new ScheduleError('effect registration is illegal inside an open evaluation/fold frame')
		}
		const effect = new SignalEffect(nextSignalEffectId++, name, rootId, nodeIndexToInternals)
		root(rootId)
		idToSignalEffect.set(effect.id, effect)
		signalEffectCount++
		return effect
	}

	/** Clear causal slot requests that already became durable for this root. */
	function clearResolvedDeliverySlots(effect: SignalEffect): void {
		let clear = 0
		for (let slotId = 0; slotId < slots.length; slotId++) {
			const bit = 1 << slotId
			if ((effect.pendingSlots & bit) === 0) {
				continue
			}
			const tenant = slots[slotId].tenant
			const batch = tenant === undefined ? undefined : idToBatch.get(tenant)
			if (
				batch === undefined ||
				batch.state === 'retired' ||
				(tenant !== undefined && roots.get(effect.root)?.committedBatches.has(tenant) === true)
			) {
				clear |= bit
			}
		}
		effect.pendingSlots &= ~clear
	}

	function captureSignalEffectRun(id: SignalEffectId, body: () => void): void {
		const effect = idToSignalEffect.get(id)
		if (effect === undefined) {
			throw new ScheduleError(`unknown SignalEffect ${id}`)
		}
		// The body does committed-world routed reads to record its dependency
		// links; those resolve only outside every kernel effect frame (enterDepth
		// 0) and world evaluation (evalDepth 0). Running it inside one would record
		// zero links and silently drop the effect's dependencies — so the engine's
		// own scheduling defers it to a boundary, and a mistimed embedder call
		// throws loudly rather than corrupting.
		if (evalDepth > 0 || enterDepth > 0) {
			throw new ScheduleError(
				'SignalEffect execution is illegal inside an open evaluation/effect frame',
			)
		}
		if (effect.pendingReactRun) {
			effect.pendingSlots &= ~effect.pendingReactSlots
			effect.pendingReactSlots = 0
		} else {
			clearResolvedDeliverySlots(effect)
		}
		effect.pendingReactRun = false
		effect.queuedRun = false
		runSignalEffectFrame(effect, body)
	}

	/** Test helper equivalent of a routed public signal read. */
	function readSignalEffectDep(node: AnyInternals): Value {
		const effect = activeSignalEffect
		if (effect === undefined) {
			throw new ScheduleError('SignalEffect read requires an open execution frame')
		}
		return evaluate(node, { kind: 'committed', root: effect.root })
	}

	/** Remove the terminal and all ordinary edges before freeing its observer record. */
	function removeSignalEffect(id: SignalEffectId): void {
		const effect = idToSignalEffect.get(id)
		if (effect === undefined) {
			throw new ScheduleError(`unknown SignalEffect ${id}`)
		}
		idToSignalEffect.delete(id)
		signalEffectCount--
		effect.cleanups++
		const tr = trace
		if (tr !== undefined) {
			tr.reactEffectCleanup(effect.name, effect.root)
		}
		removeSignalEffectFrame(effect)
		E.disposeObserver(effect.rec)
	}

	/** Test surface — StrictMode-style replay. */
	function replaySignalEffect(id: SignalEffectId): void {
		const effect = idToSignalEffect.get(id)
		if (effect === undefined) {
			throw new ScheduleError(`unknown SignalEffect ${id}`)
		}
		if (rootToOpenRender.has(effect.root)) {
			throw new ScheduleError('replay requires the effect root to have no open render frame')
		}
		runCommittedSignalEffect(effect)
		flushNotify()
	}

	/**
	 * Production queues the adapter's stable runner; model tests run their
	 * inline body through the same graph retracker.
	 */
	function runCommittedSignalEffect(effect: SignalEffect): void {
		if (effect.body === undefined) {
			if (effect.pendingReactRun || effect.queuedRun) {
				return
			}
			effect.queuedRun = true
			queueNotify(NotifyKind.SIGNAL_EFFECT, undefined, undefined, 0, effect)
			return
		}
		effect.cleanups++
		const tr = trace
		if (tr !== undefined) {
			tr.reactEffectCleanup(effect.name, effect.root)
		}
		const body = effect.body
		if (body !== undefined) {
			captureSignalEffectRun(effect.id, body)
		}
		effect.runs++
		if (tr !== undefined) {
			tr.reactEffectRun(effect.name, effect.root, effect.lastValue, effect.traceValues ?? [])
		}
	}

	/**
	 * Preserve PENDING-only terminals across dirty-list decay while their
	 * causal render is still unresolved.
	 */
	function preserveDirtySignalEffects(rootFilter: RootId | undefined): void {
		if (signalEffectCount === 0) {
			return
		}
		const gen = ++walkGen
		const effects = dirtySignalEffects
		effects.length = 0
		if (rootFilter === undefined) {
			for (const a of rootToArena.values()) {
				collectDirtySignalEffects(a, gen, effects)
			}
		} else {
			const a = rootToArena.get(rootFilter)
			if (a !== undefined) {
				collectDirtySignalEffects(a, gen, effects)
			}
		}
		for (let i = 0; i < effects.length; i++) {
			const effect = effects[i]
			const a = effect.arena
			const sh = effect.shadow
			if (
				a !== undefined &&
				sh !== 0 &&
				(a.memory[sh + ArenaField.FLAGS] & (ArenaFlag.DIRTY | ArenaFlag.PENDING)) ===
					ArenaFlag.PENDING
			) {
				a.memory[sh + ArenaField.FLAGS] |= ArenaFlag.DIRTY
				a.dirty.push(sh)
			}
		}
		effects.length = 0
	}

	/**
	 * Walk dirty committed cones, validate canonical terminal links, and
	 * request at most one runner per terminal.
	 */
	function flushDirtySignalEffects(rootFilter: RootId | undefined): void {
		if (signalEffectCount === 0) {
			return
		}
		const gen = ++walkGen
		const effects = dirtySignalEffects
		effects.length = 0
		if (rootFilter === undefined) {
			for (const a of rootToArena.values()) {
				collectDirtySignalEffects(a, gen, effects)
			}
		} else {
			const a = rootToArena.get(rootFilter)
			if (a !== undefined) {
				collectDirtySignalEffects(a, gen, effects)
			}
		}
		if (effects.length > 1) {
			effects.sort((a, b) => a.id - b.id)
		}
		for (let i = 0; i < effects.length; i++) {
			const effect = effects[i]
			if (!effect.live) {
				continue
			}
			if (effect.pendingReactRun || effect.queuedRun || rootToOpenRender.has(effect.root)) {
				const a = effect.arena
				const sh = effect.shadow
				if (
					a !== undefined &&
					sh !== 0 &&
					(a.memory[sh + ArenaField.FLAGS] & (ArenaFlag.DIRTY | ArenaFlag.PENDING)) ===
						ArenaFlag.PENDING
				) {
					a.memory[sh + ArenaField.FLAGS] |= ArenaFlag.DIRTY
					a.dirty.push(sh)
				}
				continue
			}
			if (signalEffectChanged(effect)) {
				runCommittedSignalEffect(effect)
			} else {
				clearResolvedDeliverySlots(effect)
			}
		}
		effects.length = 0
	}

	// ---- render integration ------------------------------------------------------------

	/**
	 * Render passes and watchers — the render lifecycle. This section owns every
	 * pass and watcher transition: render start/yield/resume/end, watcher
	 * mount/defer/reveal/re-render/removal, per-root commit lock-in
	 * ({@link commitBatches}), and mount fixup ({@link runMountFixup}). It reads
	 * and writes world state only through the world-arena section's functions
	 * and probes — never direct arena memory — so that storage can change freely.
	 */

	type RenderPassState = 'open' | 'yielded' | 'ended'

	type RenderPass = {
		id: RenderPassId
		root: RootId
		/** The render's pin, frozen at start and held across yields. */
		pin: Seq
		maskBatches: Set<BatchId>
		/**
		 * Slot sets fixed at render start: maskBits — slots of the mask's written
		 * batches; includedBits — plus the root's committed slots (all it may see).
		 */
		maskBits: BatchSlotSet
		includedBits: BatchSlotSet
		state: RenderPassState
		endKind: 'commit' | 'discard' | undefined
		/**
		 * Watchers whose layout effects (subscribe + fixup) fire at this render's
		 * commit: its own mounts plus adopted reveals. Disjoint from `rendered`.
		 */
		mounted: WatcherId[]
		/** Live watchers re-rendered by this render; disjoint from `mounted`. */
		rendered: Set<WatcherId>
		/** Positive id means React deps will run; negative means unchanged deps. */
		signalEffects: number[]
		/**
		 * The render world's arena, claimed at {@link renderStart} and dropped in
		 * {@link reclaimAfterRenderEnd}.
		 */
		arena?: WorldArena
	}

	/** Render-pass id source (fresh per composition). */
	let nextRenderPassId = 1
	/** Watcher id source (fresh per composition); mount order is delivery/drain firing order. */
	let nextWatcher = 1

	/**
	 * Watcher→node resolutions that missed and were skipped instead of silently
	 * binding a reused record (see {@link resolveWatcherInternals}). Test surface.
	 */
	let staleWatcherSkips = 0

	/**
	 * The one watcher→node resolution: probe the dense row by the watcher's
	 * mount-cached node index, then generation-check it against the watcher's
	 * mount-time stamp. A miss means the node record died and its slot may host
	 * a new tenant: callers skip (counted in {@link staleWatcherSkips}), never
	 * bind. Generations only grow, so a stale stamp never re-validates.
	 */
	function resolveWatcherInternals(w: Watcher): AnyInternals | undefined {
		const node = w.nodeIx < nodeIndexToInternals.length ? nodeIndexToInternals[w.nodeIx] : undefined
		if (node === undefined || getKernelGeneration(w.node) !== w.nodeRecordGen) {
			staleWatcherSkips++
			return undefined
		}
		return node
	}

	/**
	 * The Watcher.live setter's one call: a live watcher holds one observed-consumer
	 * ref on its watched node; stale watchers shift nothing (skips pair up).
	 */
	function observerShift(w: Watcher, delta: 1 | -1): void {
		const node = resolveWatcherInternals(w)
		if (node !== undefined) {
			shiftObservedCount(node, delta)
		}
	}

	function getMinLivePin(): Seq {
		let min = Number.POSITIVE_INFINITY
		for (const p of rootToOpenRender.values()) {
			if (p.pin < min) min = p.pin
		}
		return min
	}

	// ------------------------------------------------------ render lifecycle

	/**
	 * Open a render pass: pin, mask, and committed-set snapshot all fix here, so
	 * pause/resume cannot drift. One open render per root (restart = new render).
	 */
	function renderStart(rootId: RootId, includeBatches: BatchId[]): RenderPass {
		if (rootToOpenRender.has(rootId)) {
			throw new ScheduleError(
				`root ${rootId} already has an open render — one render pass per root at a time`,
			)
		}
		const maskBatches = new Set<BatchId>()
		let maskBits = 0
		for (const id of includeBatches) {
			const t = getBatchById(id)
			if (t.state !== 'live') {
				throw new ScheduleError(
					'mask captures live batches only — a retired batch is already permanent history',
				)
			}
			maskBatches.add(id)
			// A slotless live batch never wrote; later writes postdate this
			// render's pin, so the visibility rule excludes them anyway.
			if (t.slot !== undefined) {
				maskBits |= 1 << t.slot
			}
		}
		// The committed-set capture materializes the root record (reference-model parity).
		const includedBits = maskBits | root(rootId).committedBits
		const render: RenderPass = {
			id: nextRenderPassId++,
			root: rootId,
			pin: seq,
			maskBatches,
			maskBits,
			includedBits,
			state: 'open',
			endKind: undefined,
			mounted: [],
			rendered: new Set(),
			signalEffects: [],
		}
		render.arena = claimArena('render', { kind: 'render', render }, rootId)
		idToRenderPass.set(render.id, render)
		rootToOpenRender.set(rootId, render)
		recomputeQuiet() // an open render: the pipeline is armed until it closes
		const tr = trace
		if (tr !== undefined) {
			tr.renderStart(render)
			tr.opEnd()
		}
		return render
	}

	function getRenderPassById(id: RenderPassId): RenderPass {
		return getOrThrow(idToRenderPass, id, 'render pass')
	}

	/**
	 * Yield/resume edges: while yielded, code that runs in the gap (event
	 * handlers, other renders) is "not in render" for this render.
	 */
	function renderYield(id: RenderPassId): void {
		const p = getRenderPassById(id)
		if (p.state !== 'open') {
			throw new ScheduleError('yield requires an open (running) render')
		}
		p.state = 'yielded'
		const tr = trace
		if (tr !== undefined) {
			tr.renderYield(p)
			tr.opEnd()
		}
	}

	function renderResume(id: RenderPassId): void {
		const p = getRenderPassById(id)
		if (p.state !== 'yielded') {
			throw new ScheduleError('resume requires a yielded render')
		}
		p.state = 'open'
		const tr = trace
		if (tr !== undefined) {
			tr.renderResume(p)
			tr.opEnd()
		}
	}

	/** Mount a new watcher inside an open render; it renders in the render's world. */
	function mountWatcher(renderPassId: RenderPassId, node: AnyInternals, name: string): Watcher {
		const p = getRenderPassById(renderPassId)
		if (p.state === 'ended') {
			throw new ScheduleError('mount requires an open render')
		}
		const value = evaluate(node, { kind: 'render', render: p })
		const watcher = newWatcher(nextWatcher++, name, p.root, node, value, {
			renderPassId: p.id,
			pin: p.pin,
			maskBits: p.maskBits,
			includedBits: p.includedBits,
			rootCommitGen: root(p.root).commitGen,
		})
		watchers.set(watcher.id, watcher)
		let nodeWatchers = nodeToWatchers[node.ix]
		if (nodeWatchers === undefined) {
			nodeWatchers = []
			nodeToWatchers[node.ix] = nodeWatchers
		}
		nodeWatchers.push(watcher)
		p.mounted.push(watcher.id) // mounts never join `rendered` (the collections are disjoint)
		return watcher
	}

	/**
	 * Strike a watcher from every render's mounted list, so no later commit's
	 * layout loop revives it (deferral, reveal adoption, and removal all need this).
	 */
	function unlistMounted(watcherId: WatcherId): void {
		for (const p of idToRenderPass.values()) {
			const i = p.mounted.indexOf(watcherId)
			if (i >= 0) {
				p.mounted.splice(i, 1)
			}
		}
	}

	/**
	 * A reveal (React's Offscreen/Activity): the tree commits hidden, and the
	 * watcher's layout effects (subscribe + fixup) defer to a later, adopting commit.
	 */
	function deferMountEffects(watcherId: WatcherId): void {
		unlistMounted(watcherId)
	}

	function adoptRevealedMount(renderPassId: RenderPassId, watcherId: WatcherId): void {
		const adopter = getRenderPassById(renderPassId)
		if (adopter.state === 'ended') {
			throw new ScheduleError('adopting render must be open')
		}
		const w = getOrThrow(watchers, watcherId, 'watcher')
		if (w.root !== adopter.root) {
			throw new ScheduleError('reveal stays on the watcher root')
		}
		unlistMounted(watcherId)
		adopter.mounted.push(watcherId)
	}

	/**
	 * An existing live watcher re-rendered by a render: dedup bits re-arm at
	 * render (the queued work the bits stood for has now started).
	 */
	function renderWatcher(renderPassId: RenderPassId, watcherId: WatcherId): void {
		const p = getRenderPassById(renderPassId)
		if (p.state === 'ended') {
			throw new ScheduleError('render requires an open render')
		}
		const w = watchers.get(watcherId)
		if (w === undefined || !w.live) {
			throw new ScheduleError('render targets a live watcher')
		}
		if (w.root !== p.root) {
			throw new ScheduleError('watcher belongs to another root')
		}
		w.dedupBits = 0
		p.rendered.add(watcherId)
	}

	function renderSignalEffect(
		renderPassId: RenderPassId,
		signalEffectId: SignalEffectId,
		willRun: boolean,
	): void {
		const p = getRenderPassById(renderPassId)
		if (p.state === 'ended') {
			throw new ScheduleError('signal effect render requires an open render')
		}
		const effect = idToSignalEffect.get(signalEffectId)
		if (effect === undefined || !effect.live) {
			throw new ScheduleError(`unknown SignalEffect ${signalEffectId}`)
		}
		if (effect.root !== p.root) {
			throw new ScheduleError('signal effect rendered in a different root than its registration')
		}
		const report = willRun ? signalEffectId : -signalEffectId
		if (effect.reportPass === p.id) {
			p.signalEffects[effect.reportIndex] = report
		} else {
			effect.reportPass = p.id
			effect.reportIndex = p.signalEffects.length
			p.signalEffects.push(report)
		}
	}

	/**
	 * Full watcher removal — the bindings' unsubscribe surface. Retires the
	 * watcher from both stores — the `watchers` id map and the `nodeToWatchers`
	 * routing index — plus any open render's mounted list; deleting from the id
	 * map alone strands the routing entry (tests/graph-consumers.spec.ts).
	 */
	function removeWatcher(watcherId: WatcherId): void {
		unlistMounted(watcherId)
		dropWatcher(watcherId)
	}

	/**
	 * Unlinks a watcher from the per-node index (discarded mounts) and frees
	 * its arena record.
	 */
	function dropWatcher(wid: WatcherId): void {
		const w = watchers.get(wid)
		if (w === undefined) {
			return
		}
		// Deletion implies non-live: releases the observation retain when a
		// discarded render held an adopted live watcher (no-op otherwise).
		w.live = false
		watchers.delete(wid)
		// The cached index is safe here even when stale: a scrubbed row is
		// undefined, and a re-tenanted row cannot contain this watcher.
		const nodeWatchers = nodeToWatchers[w.nodeIx]
		if (nodeWatchers !== undefined) {
			const i = nodeWatchers.indexOf(w)
			if (i >= 0) {
				nodeWatchers.splice(i, 1)
			}
			// Reclamation defers for rows still holding watchers; the row's LAST
			// entry leaving (every teardown funnels here) retries the skipped work.
			if (reclaimSkippedN !== 0 && nodeWatchers.length === 0) {
				noteReclaimRetry(w.node)
			}
		}
		// Free the record LAST: the free defers to the next boundary sweep, so
		// queued notifications holding the handle still read their own fields.
		E.disposeObserver(w.rec)
	}

	/**
	 * Per-root commit lock-in — the one owner of a root's committed-state
	 * transition; returns whether anything newly locked in. Per still-live,
	 * not-yet-committed batch, one unit moves: committed set + slot bits, commit
	 * generation, committed-advance clock, arena fan-out, durable drain. Other
	 * batches skip — a commit report is a delta, and re-reporting is an
	 * idempotent set-add. {@link renderEnd}'s sweep calls the inner form.
	 */
	function commitBatches(rootId: RootId, batches: Iterable<BatchId>): boolean {
		let changed = false
		opDepth++ // public-operation frame (see the engine's write dispatch)
		try {
			changed = commitBatchesInner(rootId, batches)
			// This call is its own boundary: if committed truth moved, re-check the
			// root's dirty SignalEffects here. No-op calls re-check nothing.
			if (changed) {
				flushDirtySignalEffects(rootId)
			}
			endOperation()
		} finally {
			opDepth--
		}
		runOperationEpilogue()
		return changed
	}

	function commitBatchesInner(rootId: RootId, batches: Iterable<BatchId>): boolean {
		const rootState = root(rootId)
		const tr = trace
		let changed = false
		for (const tid of batches) {
			const t = idToBatch.get(tid)
			if (t === undefined || t.state !== 'live') {
				continue
			} // retired (or reclaimed): the retired clause subsumes membership
			if (rootState.committedBatches.has(t.id)) {
				continue
			} // idempotent set-add: already a member
			rootState.committedBatches.add(t.id)
			if (t.slot !== undefined) {
				rootState.committedBits |= 1 << t.slot
			}
			rootState.commitGen++
			advanceCommitted() // committed-advance: every per-root commit bumps it
			// Committed-truth flip site: fan this batch's touched atoms into this
			// root's arena — after the membership mutation, before the drain.
			{
				const ra = rootToArena.get(rootId)
				if (ra !== undefined) {
					fanAtomsToArena(ra, t.atomsTouched, false)
				}
			}
			if (tr !== undefined) {
				tr.perRootCommit(rootId, t.id, rootState.commitGen)
			}
			// Durable drain, gated the same at every flip site: dirty slots or
			// re-staled leftovers (see markRestaled) mean committed truth moved.
			const bits = (t.slot !== undefined ? 1 << t.slot : 0) | rootState.committedDirtySlots
			rootState.committedDirtySlots = 0
			const re = restaled.get(rootId)
			if (bits !== 0 || (re !== undefined && re.size > 0)) {
				drainCommittedObservers(rootId, 'per-root-commit')
			}
			changed = true
		}
		return changed
	}

	/**
	 * End a render. Commit order — (1) baseline capture, (2) retirement folds
	 * due at this commit + per-root lock-in, (3) durable drains, (4) layout
	 * (subscribe + mount fixup) — matches the order the protocol host performs
	 * the React work, so observers see states in the order the screen does. On
	 * discard, render-owned mounts die. Deferred slot releases re-run either way.
	 */
	function renderEnd(
		id: RenderPassId,
		kind: 'commit' | 'discard',
		opts?: { retireAtCommit?: BatchId[] },
	): void {
		opDepth++ // public-operation frame (see the engine's write dispatch)
		try {
			renderEndInner(id, kind, opts)
		} finally {
			opDepth--
			committingRender = undefined // the cross-world correction window closes with the operation
		}
		runOperationEpilogue()
	}

	function renderEndInner(
		id: RenderPassId,
		kind: 'commit' | 'discard',
		opts?: { retireAtCommit?: BatchId[] },
	): void {
		const render = getRenderPassById(id)
		if (render.state === 'ended') {
			throw new ScheduleError('render already ended')
		}
		if (kind === 'commit') {
			for (const tid of opts?.retireAtCommit ?? []) {
				const t = getBatchById(tid) // throws on unknown ids before any mutation
				if (!render.maskBatches.has(tid)) {
					// A retirement folded into a commit must belong to a batch this
					// commit rendered, or committed truth would pass the screen.
					throw new ScheduleError(
						`batch ${tid} is not rendered by render pass ${render.id}; its retirement cannot be due at this commit`,
					)
				}
				if (t.state !== 'live' || t.parked) {
					throw new ScheduleError(
						`batch ${tid} cannot retire at this commit (already retired, or parked)`,
					)
				}
			}
		}
		// Resolve mask batch records before retirement can reclaim them: the
		// fixup's clock condition reads them at commit time (see runMountFixup).
		const maskBatchRecords: Batch[] = []
		if (kind === 'commit') {
			for (const tid of render.maskBatches) {
				maskBatchRecords.push(getBatchById(tid))
			}
		}
		render.state = 'ended'
		render.endKind = kind
		rootToOpenRender.delete(render.root)
		// The disposition record fires before the end's consequences, so they can
		// cite it as cause; the checkpoint markers below fire after them.
		const tr = trace
		if (tr !== undefined) {
			tr.renderEnd(render, kind)
		}
		if (kind === 'discard') {
			for (const wid of render.mounted) {
				dropWatcher(wid)
			} // never subscribed; the tree died
			if (tr !== undefined) {
				tr.renderDiscarded(render)
			}
			reevaluateDeferredReleases()
			reclaimAfterRenderEnd(render)
			maybeCloseEpisode() // the last open render just closed: the episode may end here
			recomputeQuiet() // render closed (episode possibly ended): quiet may re-arm
			// The frame close flushes SignalEffects deferred
			// while this root's frame was open (the discard itself advances nothing).
			flushDirtySignalEffects(render.root)
			endOperation()
			return
		}
		// The cross-world correction window opens (renderEnd's finally closes it):
		// this commit's own drains gate this render's watchers by value (see correctWatcher).
		committingRender = render
		for (const report of render.signalEffects) {
			if (report < 0) {
				continue
			}
			const effect = idToSignalEffect.get(report)
			if (effect !== undefined && effect.live) {
				const matching = effect.pendingSlots & render.maskBits
				if (matching !== 0) {
					effect.pendingReactSlots |= matching
					effect.pendingReactRun = true
				}
			}
		}
		// (1) Baseline capture at the commit's committed-side entry.
		const baseline = { committedAdvance, rootCommitGen: root(render.root).commitGen }
		// Re-rendered watchers take this render's world values now: the last
		// rendered value is the comparator later drains reconcile against.
		for (const wid of render.rendered) {
			const w = watchers.get(wid)
			if (w === undefined) {
				continue
			} // removed mid-render
			const wInternals = resolveWatcherInternals(w)
			if (wInternals === undefined) {
				continue
			} // loud skip: record tenancy moved mid-render
			w.lastRenderedValue = evaluate(wInternals, { kind: 'render', render })
			w.snapshot = {
				renderPassId: render.id,
				pin: render.pin,
				maskBits: render.maskBits,
				includedBits: render.includedBits,
				rootCommitGen: root(render.root).commitGen,
			}
		}
		// (2) retirement folds due at this commit, then per-root lock-in of every
		// still-live mask batch via commitBatchesInner — including step (3), the drains.
		for (const tid of opts?.retireAtCommit ?? []) {
			retireInner(getBatchById(tid))
		}
		commitBatchesInner(render.root, render.maskBatches)
		// (4) layout: subscribe, then mount fixup (React's layout-effect phase).
		for (const wid of render.mounted) {
			const w = watchers.get(wid)
			if (w === undefined) {
				continue
			}
			// The node record may have died (and been reused) between mount and
			// commit; a stale watcher must never subscribe the record's new tenant.
			const wInternals = resolveWatcherInternals(w)
			if (wInternals === undefined) {
				continue
			} // loud skip (counted)
			w.live = true
			runMountFixup(w, wInternals, render, baseline, maskBatchRecords)
		}
		// The populator domain: every watcher this render re-rendered or mounted.
		// Adopted reveals stay out — their snapshot rides the original hidden render.
		const populated: WatcherId[] = [...render.rendered]
		for (const wid of render.mounted) {
			const w = watchers.get(wid)
			if (w !== undefined && w.snapshot.renderPassId === render.id) {
				populated.push(wid)
			}
		}
		// Re-staled detection doubles as routing population: each committed
		// evaluation writes the watcher's committed dep cone into the root's
		// arena (a fresh mount's sole populator) before renderEnd returns —
		// before any post-commit write needs routing.
		for (const wid of populated) {
			const w = watchers.get(wid)
			if (w === undefined || !w.live) {
				continue
			}
			const wInternals = resolveWatcherInternals(w)
			if (wInternals === undefined) {
				continue
			} // loud skip (live ⇒ alive in practice; belt for binding-side flips)
			const committedNow = evaluate(wInternals, { kind: 'committed', root: render.root })
			// The committed-render stamp rule: settle the watched node's committed
			// clock, then compare. Agreement validates the screen — stamp
			// lastValidatedAt at the settled clock; a difference re-stales — stamp
			// 0 (never-validated), forcing the next drain to correct it either way.
			{
				const ra = rootToArena.get(render.root)
				if (ra !== undefined) {
					settleObserverClock(ra, wInternals)
				}
				if (isValueChanged(wInternals, w.lastRenderedValue, committedNow)) {
					markRestaled(w)
					w.lastValidatedAt = 0
				} else {
					w.lastValidatedAt = ra === undefined ? 0 : committedNodeClock(ra, w.nodeIx)
				}
			}
		}
		// Dev assert: every live watcher this commit re-rendered or mounted now
		// has a shadow in the root's committed arena (the populator ran).
		{
			const ra = rootToArena.get(render.root)
			for (const wid of populated) {
				const w = watchers.get(wid)
				if (w === undefined || !w.live) {
					continue
				}
				if (ra === undefined || !arenaHasShadow(ra, w.nodeIx)) {
					throw new InvariantViolation(
						`watcher-population rule: watcher ${w.name} has no shadow in root ${render.root}'s committed arena after commit`,
					)
				}
			}
		}
		if (tr !== undefined) {
			tr.renderCommitted(render)
		}
		// ctx.previous holds the last committed value (a pending render may still
		// be discarded), so it updates only here, at commit.
		for (const wid of [...render.rendered, ...render.mounted]) {
			const w = watchers.get(wid)
			if (w === undefined || w.lastRenderedValue instanceof SuspendedRead) {
				continue
			}
			const node =
				w.nodeIx < nodeIndexToInternals.length ? nodeIndexToInternals[w.nodeIx] : undefined
			if (node === undefined || getKernelGeneration(w.node) !== w.nodeRecordGen) {
				continue
			} // stale: no hint to update (gen-checked exactly as resolveWatcherInternals; uncounted — not a resolution consumers observe)
			if (node.kind === 'computed') {
				node.prevCommitted = w.lastRenderedValue
			}
		}
		{
			const ra = rootToArena.get(render.root)
			if (ra !== undefined) {
				arenaDecay(ra)
			} // boundary mark decay
		}
		reevaluateDeferredReleases()
		reclaimAfterRenderEnd(render)
		maybeCloseEpisode() // the last open render just closed: the episode may end here
		recomputeQuiet() // render closed (episode possibly ended): quiet may re-arm
		// Validate dirty terminals once per commit; folded retirements widen to all roots.
		flushDirtySignalEffects((opts?.retireAtCommit ?? []).length > 0 ? undefined : render.root)
		endOperation()
	}

	/**
	 * Render-end reclamation: the ended render's record and arena drop at the
	 * attempt's own close. Batch records the mask retained persist — they are
	 * episode-lifetime and drop wholesale at the episode close.
	 */
	function reclaimAfterRenderEnd(p: RenderPass): void {
		idToRenderPass.delete(p.id)
		// Deliberately after mount fixup and the re-staled loop, so both saw the
		// arena (commit and discard drop identically); touching it later throws.
		if (p.arena !== undefined) {
			releaseArena(p.arena)
			p.arena = undefined
		}
	}

	/** Deferred releases re-evaluate at every render end, commit and discard alike. */
	function reevaluateDeferredReleases(): void {
		for (const s of slots) {
			if (!s.releasePending) {
				continue
			}
			if (!isSlotRetainedByOpenMask(s.id)) {
				releaseSlot(s)
			}
		}
		// A render ending releases its pin, which can unlock retired-prefix
		// folds (the bounded-memory valve's pin clause).
		runFoldValve()
	}

	/**
	 * A watcher re-staled by its own commit: lastRenderedValue was reset to a
	 * pin-old value while committed truth had already moved past the pin. The
	 * per-root `restaled` set folds into the next durable drain on its root.
	 */
	function markRestaled(w: Watcher): void {
		let set = restaled.get(w.root)
		if (set === undefined) {
			set = new Set()
			restaled.set(w.root, set)
		}
		set.add(w)
	}

	// ---------------------------------------------------------- mount fixup

	/**
	 * Every slot in `bits` has its last write at or before `pin` (the
	 * fast-out's clock conjunct, quantified over a snapshot's slot bits).
	 */
	function areSlotClocksQuiet(bits: BatchSlotSet, pin: Seq): boolean {
		for (let s = 0; bits !== 0; s++, bits >>>= 1) {
			if ((bits & 1) === 1 && slots[s].writeClock > pin) {
				return false
			}
		}
		return true
	}

	/**
	 * Mount fixup — runs in the mounting component's layout effect (after
	 * commit, before paint), after subscription. A component can mount while
	 * other updates are in flight, and its subscription only activates at
	 * commit, so writes between its render and its commit could slip by
	 * unobserved. Two halves, in order: (1) catch-up, from write metadata
	 * alone — a value-blind corrective re-render joins each live batch that
	 * touched the node outside this render, in that batch's own lane;
	 * (2) urgent correction — a four-condition test (same render, no
	 * committed-truth advance, no per-root commit, quiet clocks) proves the
	 * mount window empty; only a failed condition evaluates the node in the
	 * fast-forwarded mount-fix world and corrects a real difference urgently.
	 */
	function runMountFixup(
		w: Watcher,
		node: AnyInternals,
		committingRender: RenderPass,
		baseline: { committedAdvance: Seq; rootCommitGen: CommitGen },
		maskBatchRecords: Batch[],
	): void {
		const closure = dependencyClosureOf(w.node, committingRender)
		const tr = trace // one load covers the corrective records + the disposition record
		// Catch-up half — a soundness premise of the condition test below: a live
		// committed member can write post-pin without tripping any condition.
		let correctives = 0
		for (const b of idToBatch.values()) {
			if (b.state !== 'live' || b.slot === undefined) {
				continue
			}
			if (!isBatchTouchingClosure(b, closure)) {
				continue
			}
			const slot = slots[b.slot]
			// Fully included (slot ∈ included bits ∧ no post-pin write): skip — never by value.
			if (((w.snapshot.includedBits >>> slot.id) & 1) === 1 && slot.writeClock <= w.snapshot.pin) {
				continue
			}
			if (tr !== undefined) {
				tr.mountCorrective(w, b.id, slot.id)
			}
			correctives++
			w.dedupBits |= 1 << slot.id // the corrective is a state update scheduled into the batch's lane (the protocol's runInBatch)
			if (onMountCorrective !== undefined) {
				queueNotify(NotifyKind.MOUNT_CORRECTIVE, w, b, slot.id)
			}
		}
		// The clock condition checks captured mask slots AND mask batches at
		// commit time: a slot interned mid-render postdates the captured set.
		let clocksQuiet = areSlotClocksQuiet(w.snapshot.maskBits, w.snapshot.pin)
		if (clocksQuiet) {
			for (const batch of maskBatchRecords) {
				if (batch.lastWriteSeq !== 0 && batch.lastWriteSeq > w.snapshot.pin) {
					clocksQuiet = false
					break
				}
			}
		}
		const fastOut =
			w.snapshot.renderPassId === committingRender.id &&
			baseline.committedAdvance <= w.snapshot.pin &&
			baseline.rootCommitGen === w.snapshot.rootCommitGen &&
			clocksQuiet
		if (fastOut) {
			if (tr !== undefined) {
				tr.runMountFixup(w, 'fast-out', correctives)
			}
			return // nothing committed or retired in the window: no evaluation, no comparison
		}
		const vFx = evaluate(node, {
			kind: 'mountFix',
			maskBits: w.snapshot.maskBits,
			pin: w.snapshot.pin,
			root: w.root,
		})
		if (correctWatcher(w, node, vFx, 'mount')) {
			if (tr !== undefined) {
				tr.runMountFixup(w, 'corrected', correctives)
			}
			return
		}
		if (tr !== undefined) {
			tr.runMountFixup(w, 'compare-clean', correctives)
		}
	}

	/**
	 * Transitive dependency closure feeding a node: reverse walks over kernel
	 * ∪ the mounting render's arena ∪ the root's committed arena, strong links
	 * only (weak deps cannot deliver). The closure arms the catch-up dedup
	 * bits, so it must cover every cone the delivery walk can later route — or
	 * a suppression would degrade into an over-delivery.
	 */
	function dependencyClosureOf(nodeId: NodeId, render?: RenderPass): Set<NodeId> {
		const closure = new Set<NodeId>()
		closure.add(nodeId)
		// Diagnostic callers pass ids that are not provably node record ids, so
		// the row resolution carries its own identity check (getResidentInternals).
		const ix = getKernelNodeIndex(nodeId)
		const node = ix < nodeIndexToInternals.length ? nodeIndexToInternals[ix] : undefined
		if (node === undefined || node.id !== nodeId) {
			return closure
		} // unregistered/dead id: nothing routes
		const pa = render?.arena
		if (pa !== undefined) {
			collectArenaClosure(pa, node, closure)
		}
		if (render !== undefined) {
			const ca = rootToArena.get(render.root)
			if (ca !== undefined) {
				collectArenaClosure(ca, node, closure)
			}
		}
		collectKernelClosure(node.id, closure, new Set())
		return closure
	}

	/**
	 * The kernel leg of the fixup closure: a reverse walk over the kernel's own
	 * dep links off the raw arena view. One id space — a record's id is its NodeId.
	 */
	function collectKernelClosure(kernelId: NodeId, closure: Set<NodeId>, seen: Set<NodeId>): void {
		if (seen.has(kernelId)) {
			return
		}
		seen.add(kernelId)
		const memory = E.buffer()
		let l = memory[kernelId + NodeField.DEPS]
		while (l !== 0) {
			const depKernelId = memory[l + LinkField.DEP]
			// Dep ids come off live kernel links: a defined dense row ⇔ engine
			// content. Unregistered intermediates traverse but contribute nothing.
			const depIx = memory[depKernelId + NodeField.NODE_INDEX]
			if (depIx < nodeIndexToInternals.length && nodeIndexToInternals[depIx] !== undefined) {
				closure.add(depKernelId)
			}
			if ((memory[depKernelId + NodeField.FLAGS] & NodeFlag.K_COMPUTED) !== 0) {
				collectKernelClosure(depKernelId, closure, seen)
			}
			l = memory[l + LinkField.NEXT_DEP]!
		}
	}

	function isBatchTouchingClosure(t: Batch, closure: Set<NodeId>): boolean {
		const atoms = t.atomsTouched
		for (let i = 0; i < atoms.length; i++) {
			if (closure.has(atoms[i].id)) {
				return true
			}
		}
		return false
	}

	// ---- the public dispatch + the engine surface --------------------------------------------
	// The engine's operational face: quiescence reclamation, the classified
	// write path, world reads, the test-only engine reset, and this instance's
	// `engine` record.

	/**
	 * Last-batch cache (windowed writes hit one batch repeatedly — one compare
	 * beats a Map probe on the classified write path).
	 */
	let lastBatchId = 0
	let lastBatchRef: Batch | undefined = undefined

	/** Drop the cache entry for a reclaimed batch id (the episode close sweeps its record). */
	function invalidateBatchCache(id: BatchId): void {
		if (lastBatchId === id) {
			lastBatchId = 0
			lastBatchRef = undefined
		}
	}

	// ---- quiescence reclamation + the checker window ----

	/** A root's consumer population: live watchers + live SignalEffects. */
	function getConsumerCount(rootId: RootId): number {
		let n = 0
		for (const w of watchers.values()) {
			if (w.live && w.root === rootId) {
				n++
			}
		}
		for (const effect of idToSignalEffect.values()) {
			if (effect.live && effect.root === rootId) {
				n++
			}
		}
		return n
	}

	/**
	 * Quiescence arena duties, in order: release committed arenas with zero
	 * consumers (the root record stays), then renumber the survivors' read clocks.
	 */
	function arenaQuiesceSweep(): void {
		for (const [rootId, a] of rootToArena) {
			if (getConsumerCount(rootId) === 0) {
				rootToArena.delete(rootId)
				releaseArena(a)
			}
		}
		for (const a of rootToArena.values()) {
			arenaRenumberMarks(a)
		}
	}

	/**
	 * The checker window: the seam feeding tests/arena-checker.ts (the armed
	 * divergence check — arena-served values ≡ fold-truth — and the structural
	 * validator). Bracket methods keep mutation save/restore inside the engine.
	 * Production never calls this; re-arm after a reset. @internal
	 */
	function __TEST__checkerInternals(): ArenaCheckerInternals {
		return {
			layout: arenaCheckerLayout(),
			get evalDepth(): number {
				return evalDepth
			},
			get inFoldCallback(): boolean {
				return inFoldCallback
			},
			eachArena: (fn) => eachArena(fn),
			internalsAt: (ix) => nodeIndexToInternals[ix],
			serve: (a, node) => arenaServe(a, node),
			runInFoldTruthFrame: (world, fn) => runInFoldTruthFrame(world, fn),
			createCycleError: (name) => createCycleError(name),
			runInFoldCallback: (fn) => runInFoldCallback(fn),
			holdOp: (fn) => {
				opDepth++
				try {
					return fn()
				} finally {
					opDepth--
				}
			},
			armEpilogueCheck: (check) => {
				epilogueCheck = check
			},
		}
	}

	/** Test seam: the root's committed arena shell, if materialized (pool/wrap suites). @internal */
	function __TEST__arena(rootId: RootId): WorldArena | undefined {
		return rootToArena.get(rootId)
	}

	/** Test seam: pooled arena shells (the pool reuse/cap pins). @internal */
	function __TEST__arenaPool(): WorldArena[] {
		return arenaPool
	}

	/**
	 * Test seam: the dense nodeIndex-keyed columns (the leak/elements-kind
	 * audits probe row clearing and packedness); identity changes at reset. @internal
	 */
	function __TEST__columns(): {
		nodeIndexToInternals: (AnyInternals | undefined)[]
		lastWalk: number[]
		evalMark: number[]
		obsRefs: number[]
		obsDeps: (Set<AnyInternals> | undefined)[]
		nodeToWatchers: (Watcher[] | undefined)[]
	} {
		return { nodeIndexToInternals, lastWalk, evalMark, obsRefs, obsDeps, nodeToWatchers }
	}

	/**
	 * Test seam: bump a live record's GEN field — arena shadows re-tenant cold
	 * and watcher stamps go stale, exactly as a real free+reuse would. @internal
	 */
	function __TEST__bumpNodeGen(id: NodeId): void {
		E.buffer()[id + NodeField.GEN]++
	}

	/** Arena stats (tests/bench). @internal */
	function __TEST__arenaStats(): {
		committed: number
		renders: number
		pooled: number
		suspended: number
		pendingSettlements: number
		dirty: number
	} {
		let renders = 0
		let dirty = 0
		for (const p of rootToOpenRender.values()) {
			if (p.arena !== undefined) {
				renders++
			}
		}
		eachArena((a) => {
			dirty += a.dirty.length
		})
		return {
			committed: rootToArena.size,
			renders,
			pooled: arenaPool.length,
			suspended: suspendedCount,
			pendingSettlements: getPendingSettleCount(),
			dirty,
		}
	}

	// ------------------------------------------------------ the write path

	/**
	 * The whole write while quiet: fold over committed base (updaters/reducers
	 * under both fold-purity guards), drop on policy equality — `isEqual(current,
	 * incoming)`, invoked once at acceptance — else advance base and the kernel
	 * together, keeping base ≡ kernel newest ≡ every world's value. One sequence
	 * stamps baseSeq and {@link committedAdvance}. No batch, no log entry, no
	 * delivery walk: live observers reconcile value-gated, as a durable drain would.
	 */
	function quietWrite(node: AtomInternals, kind: WriteKind, payload: unknown): void {
		if (evalDepth > 0) {
			throw new ScheduleError(
				'signal write during a world evaluation / render — write from an event handler or effect instead',
			)
		}
		if (inFoldCallback) {
			throw new ScheduleError(
				'signal write inside an updater/reducer fold — updaters and reducers must be pure',
			)
		}
		// Public-operation frame: nested effect writes' settlements enqueue for this fold's epilogue.
		opDepth++
		try {
			quietWriteInner(node, kind, payload)
		} finally {
			opDepth--
		}
		runOperationEpilogue()
	}

	function quietWriteInner(node: AtomInternals, kind: WriteKind, payload: unknown): void {
		const prev = node.base
		// Fast arm: a plain set with default equality drops on one bare
		// Object.is — no applyOp/isAtomValueEqual call layer on the dominant
		// shape (folding into the general arm measured +37%, 12.9 → 17.7 ns).
		let next: Value
		if (kind === WriteKind.SET && node.eqIsDefault) {
			if (Object.is(payload, prev)) {
				return // equality drop against base — the write log is empty by the quiet invariant
			}
			next = payload
		} else {
			next = kind === WriteKind.SET ? payload : applyOp(node, kind, payload, prev)
			if (isAtomValueEqual(node, prev, next)) {
				return // policy equality drop — once, kernel order (current, incoming)
			}
		}
		node.base = next
		node.baseSeq = committedAdvance = ++seq // advance the base + committed-advance clocks together (nextSeq, inlined)
		const tr = trace
		if (tr !== undefined) {
			tr.quietWrite(node, node.baseSeq)
		}
		// Direct kernel apply — a public-method re-entry would re-run the
		// policy comparator. Flushed effects classify normally on re-entry.
		// writeNewest may run core effects (a kernel flush): one of those bodies
		// can issue a nested quiet write, which owes the boundary drain rather
		// than running it inside that kernel frame (see drainQuietBoundary).
		writeNewest(node.id, next)
		// Committed-truth flip site: quiet fold. Always marks — the deferred
		// drain (or this write's own, below) scans from these marks.
		fanAtomsToCommittedArenas(getSingleAtomBuffer(node))
		// The committed-world boundary drain: watcher reconcile, dirty
		// SignalEffect terminals (their runner does committed routed reads that
		// record dependency links), mark decay, notification delivery. It is
		// valid only at a true boundary — outside every kernel effect frame and
		// SignalEffect body — so mark it owed and let drainQuietBoundary run it
		// now if we are at one, or the enclosing outermost operation run it later.
		quietBoundaryOwed = true
		drainQuietBoundary()
	}

	/**
	 * Runs the owed quiet-pipeline boundary drain iff we are at a true
	 * operation boundary: no open kernel effect frame (enterDepth 0) and no
	 * running SignalEffect body (activeSignalEffect undefined), where the
	 * SignalEffect runner's routed reads resolve committed and record links.
	 * Inside such a frame it is a no-op; the frame's outermost caller
	 * ({@link quietWriteInner}'s tail, or {@link flush}) drains once it closes.
	 * The loop re-drains when a SignalEffect body writes and re-owes it, so a
	 * sibling terminal newly dirtied by that write runs at THIS boundary rather
	 * than being dropped to an unrelated one.
	 */
	function drainQuietBoundary(): void {
		if (
			!quietBoundaryOwed ||
			quietBoundaryActive ||
			enterDepth !== 0 ||
			activeSignalEffect !== undefined
		) {
			return
		}
		quietBoundaryActive = true
		try {
			let guard = 0
			while (quietBoundaryOwed) {
				if (++guard > settleCap) {
					throw new InvariantViolation(
						`quiet SignalEffect drain exceeded ${settleCap} iterations — a SignalEffect body is synchronously re-triggering itself`,
					)
				}
				quietBoundaryOwed = false
				if (watchers.size !== 0) {
					quietDrain()
				}
				if (signalEffectCount !== 0) {
					flushDirtySignalEffects(undefined)
				}
				for (const a of rootToArena.values()) {
					arenaDecay(a)
				} // boundary mark decay
				if (notifyState.n !== 0) {
					flushNotify()
				}
			}
		} finally {
			quietBoundaryActive = false
		}
	}

	/**
	 * A bare write (no batch context) joins the ambient default batch, or folds
	 * directly while quiet — no ambient batch opens while nothing is pending.
	 */
	function bareWrite(node: AtomInternals, kind: WriteKind, payload: unknown): void {
		if (quiet) {
			quietWrite(node, kind, payload)
			return
		}
		const ambientId = ambientBatch
		let ambient = ambientId === undefined ? undefined : idToBatch.get(ambientId)
		if (ambient === undefined || ambient.state !== 'live') {
			ambient = openBatch({ ambient: true })
			ambientBatch = ambient.id
		}
		writeInBatch(ambient.id, node, kind, payload)
	}

	/**
	 * The recorded write path (an explicit batch id, or undefined for the
	 * context-free arm). Steps, in order: drop check → intern slot → append log
	 * entry → member-slot fanout → eager kernel apply → delivery walk →
	 * notification flush.
	 */
	function writeInBatch(
		batchId: BatchId | undefined,
		node: AtomInternals,
		kind: WriteKind,
		payload: unknown,
	): void {
		if (evalDepth > 0) {
			throw new ScheduleError(
				'signal write during a world evaluation / render — write from an event handler or effect instead',
			)
		}
		if (inFoldCallback) {
			throw new ScheduleError(
				'signal write inside an updater/reducer fold — updaters and reducers must be pure',
			)
		}
		if (node.kind !== 'atom') {
			throw new ScheduleError('writes target atoms')
		}
		// Public-operation frame: settlements landing anywhere inside drain at the epilogue.
		opDepth++
		try {
			writeInBatchInner(batchId, node, kind, payload)
		} finally {
			opDepth--
		}
		runOperationEpilogue()
	}

	function writeInBatchInner(
		batchId: BatchId | undefined,
		node: AtomInternals,
		kind: WriteKind,
		payload: unknown,
	): void {
		if (batchId === undefined) {
			bareWrite(node, kind, payload)
			return
		}
		let batch: Batch
		if (batchId === lastBatchId && lastBatchRef !== undefined) {
			batch = lastBatchRef
		} else {
			batch = getBatchById(batchId)
			lastBatchId = batchId
			lastBatchRef = batch
		}
		if (batch.state !== 'live') {
			throw new ScheduleError(
				`write into retired batch ${batchId} — a retired batch accepts no new writes`,
			)
		}

		const log = node.log
		// Drop check: a write may be dropped only when every world provably folds
		// this atom to ONE comparable value. Two such states: an empty log (every
		// world sees base), and a fully-retired log below every live render pin
		// (every world sees kernel newest, by the eager-apply invariant).
		if (log.length === 0) {
			if (kind === WriteKind.SET && node.eqIsDefault) {
				// Fast arm, as in the quiet fold (folding this path's two fast arms
				// into their general arms measured +11% bare, +3-6% chain3+watch1).
				if (Object.is(payload, node.base)) {
					const tr = trace
					if (tr !== undefined) {
						tr.writeDropped(node, batchId)
					}
					endOperation()
					return
				}
			} else {
				const evaluated = applyOp(node, kind, payload, node.base)
				if (isAtomValueEqual(node, node.base, evaluated)) {
					// Policy equality — once, kernel order (current, incoming).
					const tr = trace
					if (tr !== undefined) {
						tr.writeDropped(node, batchId)
					}
					endOperation()
					return
				}
			}
		} else if (log.unretired === 0 && log.maxRetiredSeq <= getMinLivePin()) {
			// The second one-value state: compare against kernel newest —
			// untracked, so a write from inside an effect frame records no link.
			const newest = untracked(() => E.readAtom(node.id))
			if (kind === WriteKind.SET && node.eqIsDefault) {
				if (Object.is(payload, newest)) {
					const tr = trace
					if (tr !== undefined) {
						tr.writeDropped(node, batchId)
					}
					endOperation()
					return
				}
			} else {
				const evaluated = applyOp(node, kind, payload, newest)
				if (isAtomValueEqual(node, newest, evaluated)) {
					const tr = trace
					if (tr !== undefined) {
						tr.writeDropped(node, batchId)
					}
					endOperation()
					return
				}
			}
		}

		const slot = batch.slot !== undefined ? slots[batch.slot] : internSlot(batch)
		const writeSeq = nextSeq()
		log.push(kind, slot.id, writeSeq, batch.id, payload)
		batch.lastWriteSeq = writeSeq
		if (node.lastTouchBatch !== batch.id) {
			node.lastTouchBatch = batch.id
			batch.atomsTouched.push(node)
		}
		// The first entry joins the episode; reaching the valve threshold files a fold candidate.
		const logLen = log.length
		if (logLen === 1) {
			episodeHolds.add(node)
		} else if (logLen === FOLD_VALVE_THRESHOLD) {
			foldCandidates.add(node)
		}
		slot.writeClock = writeSeq
		if (roots.size !== 0) {
			// A write into a committed-member slot moves committed truth immediately.
			const bit0 = 1 << slot.id
			for (const r of roots.values()) {
				if ((r.committedBits & bit0) !== 0) {
					r.committedDirtySlots |= bit0
					// Committed-truth flip site: committed-member write (marks only;
					// the effect scan waits for the next boundary).
					const ra = rootToArena.get(r.id)
					if (ra !== undefined) {
						fanAtomsToArena(ra, getSingleAtomBuffer(node), false)
					}
				}
			}
		}
		{
			// One trace record per logged write (the decoder rebuilds the 'write' event from it).
			const tr = trace
			if (tr !== undefined) {
				tr.logEntry(node, log.tailEntry())
			}
		}

		// Eager kernel apply with stepwise equality: the newest world stays
		// directly readable off the kernel. Effect writes during the flush
		// re-enter the public write path (a recursion guard would bypass recording).
		if (kind === WriteKind.SET && node.eqIsDefault) {
			// Fast arm: apply unconditionally — the kernel's own store-compare
			// gates propagation, cheaper than a kernel read + Object.is up front.
			writeNewest(node.id, payload)
		} else {
			const prevNewest = E.readAtom(node.id)
			const nextNewest = applyOp(node, kind, payload, prevNewest)
			if (!isAtomValueEqual(node, prevNewest, nextNewest)) {
				writeNewest(node.id, nextNewest)
			}
		}

		// The value-blind delivery walk, synchronously in the writer's stack.
		deliveryWalk(node, batch, slot, writeSeq)
		endOperation()
	}

	/**
	 * Trace seam for core `effect()` runs — the kernel flushes them itself, so
	 * their wrappers report each value-gated run here. Sibling order is
	 * implementation-defined; values and firing operations are the contract.
	 */
	function logCoreEffectRun(name: string, value: Value): void {
		const tr = trace
		if (tr !== undefined) {
			tr.coreEffectRun(name, value)
		}
	}

	// ------------------------------------------- episodes and quiescence

	/** Synchronously abandons every work-in-progress render. */
	function discardAllWip(): void {
		for (const p of [...rootToOpenRender.values()]) {
			renderEnd(p.id, 'discard')
		}
	}

	function quiescent(): boolean {
		return liveBatchCount === 0 && rootToOpenRender.size === 0
	}

	/**
	 * Quiescence: bump the epoch and reset episode bookkeeping — write logs and
	 * retired batch records are already gone (the episode close ran inside the
	 * transition that reached quiescence). Arenas persist: their links are
	 * current structure, not an episode log, so routing coverage survives.
	 *
	 * ## Why sequences are never renumbered
	 *
	 * Plain JS numbers, exact to 2^53 and only ever compared: correct for ~28
	 * years at a sustained 10M writes/sec, and forcing every seq past SMI range
	 * (2^35) measured ~1% — noise. (`cosignals/trace` packs seqs into Int32, so
	 * trace decode fidelity — not engine correctness — degrades past 2^31-1.)
	 */
	function quiesce(): void {
		if (!quiescent()) {
			throw new ScheduleError('quiescence requires no live batches, pins, or parked actions')
		}
		// Residue check: the episode close already ran, so no atom may still hold entries.
		for (const n of episodeHolds) {
			throw new InvariantViolation(
				`quiescence residue: atom ${n.name} still holds ${n.log.length} log entries`,
			)
		}
		epoch++
		// Kernel caches persist (nothing newest-visible changes); serial counters stay monotone.
		arenaQuiesceSweep()
		// Dead-episode bookkeeping zeroes (bulk-zero at episode reset).
		for (const s of slots) {
			s.writeClock = 0
			s.claimSeq = 0
			s.releasePending = false
		}
		for (const w of watchers.values()) {
			w.dedupBits = 0
		}
		{
			const tr = trace
			if (tr !== undefined) {
				tr.epochReset(epoch)
			}
		}
		recomputeQuiet() // quiescent by definition; re-derive from the new episode's state
		endOperation()
		runOperationEpilogue()
	}

	// ------------------------------------------------------------ world reads

	function committedValue(node: AnyInternals, root: RootId): Value {
		return evaluate(node, { kind: 'committed', root })
	}

	function newestValue(node: AnyInternals): Value {
		return evaluate(node, NEWEST)
	}

	function renderValue(node: AnyInternals, render: RenderPass): Value {
		return evaluate(node, { kind: 'render', render })
	}

	// ------------------------------------------------- the engine reset (test-only)

	/**
	 * Idle preconditions for {@link __TEST__resetEngine}: a reset from inside any
	 * open frame fails the running test loudly instead of corrupting the next one.
	 */
	function assertIdleForReset(): void {
		if (!quiescent()) {
			throw new ScheduleError(
				'__TEST__resetEngine requires quiescence: no live batches (parked actions included) and no open renders',
			)
		}
		if (opDepth !== 0) {
			throw new ScheduleError('__TEST__resetEngine inside a public operation (opDepth !== 0)')
		}
		if (evalDepth !== 0) {
			throw new ScheduleError('__TEST__resetEngine inside a world evaluation (evalDepth !== 0)')
		}
		if (inFoldCallback) {
			throw new ScheduleError('__TEST__resetEngine inside an updater/reducer/equality callback')
		}
		if (activeSignalEffect !== undefined) {
			throw new ScheduleError('__TEST__resetEngine inside an open SignalEffect frame')
		}
		if (serveOverride !== undefined) {
			throw new ScheduleError('__TEST__resetEngine inside an arena evaluation frame')
		}
		if (currentSink !== 0) {
			throw new ScheduleError('__TEST__resetEngine inside a fold-through evaluation frame')
		}
		if (suspendDepth !== 0) {
			throw new ScheduleError('__TEST__resetEngine inside a hook-initiated (suspending) evaluation')
		}
		if (notifyState.flushing) {
			throw new ScheduleError('__TEST__resetEngine inside a notification flush')
		}
		if (notifyState.n !== 0) {
			throw new ScheduleError('__TEST__resetEngine with queued notifications undelivered')
		}
		// (A drain in progress holds opDepth > 0. Queued-but-undrained settlements
		// are legal: the queue dies with the composition, its microtask epoch-guarded.)
	}

	/**
	 * The test-only engine reset — a fresh engine for suites that need one per
	 * test. The driver's protocol reset runs first, so the host drops its slot
	 * tenancy while the engine those ids point into still exists; the kernel
	 * scrub bumps the engine epoch, turning every cross-reset microtask inert;
	 * policy, suspense, and probe state clear; {@link composeEngine} then
	 * re-runs every section's initialization (trace detaches; attach the driver
	 * again after). BatchIds stay monotonic across resets, so a host-held stale
	 * id can never collide with a post-reset batch.
	 */
	function __TEST__resetEngine(options?: EngineResetOptions): void {
		assertIdleForReset()
		const d = driver
		if (d !== undefined && d.protocolReset !== undefined) {
			d.protocolReset()
		}
		resetKernelState() // bumps the engine epoch; scrubs kernel state
		__TEST__resetPolicy()
		__TEST__resetSuspense()
		probes.logEntries = 0
		probes.batches = 0
		probes.worldEvals = 0
		probes.compositions = 0
		composeEngine(options)
	}

	// ---------------------------------------------------- the engine surface

	/**
	 * The engine surface — one record per factory instance, curated against its three consumers
	 * (a member none of them use is engine-internal, not surface): the React
	 * bindings (renders, batches, commits, world reads), the test harnesses
	 * (constructors, registries, the __TEST__ seams), and the diagnostics
	 * tooling (the trace slot, read-only graph views). Every accessor reads the
	 * current composition, so the record stays valid across
	 * {@link __TEST__resetEngine}.
	 */
	const engine = {
		// creation + resolution
		atom,
		computed,
		// Handle-taking surface entries assert instance ownership (see
		// assertOwnHandle/assertOwnInternals): a handle from another
		// createCosignals() instance throws loudly instead of resolving its id
		// against this arena. The internal callers use the raw closures, so the
		// assert never taxes the hot write/read paths.
		internalsForAtom: (atom: Atom<unknown>) => {
			assertOwnHandle(atom)
			return internalsForAtom(atom)
		},
		internalsForComputed: (c: Computed<unknown>) => {
			assertOwnHandle(c)
			return internalsForComputed(c)
		},
		disposeComputed: (c: Computed<unknown>) => {
			assertOwnHandle(c)
			return disposeComputed(c)
		},
		root,
		// batches + writes
		openBatch,
		liveBatches,
		write: (
			batchId: BatchId | undefined,
			node: AtomInternals,
			kind: WriteKind,
			payload: unknown,
		) => {
			assertOwnInternals(node)
			return writeInBatch(batchId, node, kind, payload)
		},
		bareWrite: (node: AtomInternals, kind: WriteKind, payload: unknown) => {
			assertOwnInternals(node)
			return bareWrite(node, kind, payload)
		},
		retire,
		settleAction,
		// renders + watchers
		renderStart,
		renderYield,
		renderResume,
		renderEnd,
		mountWatcher,
		renderWatcher,
		renderSignalEffect,
		deferMountEffects,
		adoptRevealedMount,
		removeWatcher,
		commitBatches,
		// committed SignalEffect terminals
		mountSignalEffect,
		captureSignalEffectRun,
		readSignalEffectDep,
		removeSignalEffect,
		replaySignalEffect,
		// episodes + reads
		discardAllWip,
		quiescent,
		quiesce,
		committedValue,
		newestValue,
		renderValue,
		evaluate,
		foldAtom,
		logCoreEffectRun,
		// test seams
		__TEST__checkerInternals,
		__TEST__arena,
		__TEST__arenaPool,
		__TEST__bumpNodeGen,
		__TEST__arenaStats,
		__TEST__arenaLinkMode,
		__TEST__arenaLinkId,
		__TEST__arenaLinkNextDep,
		__TEST__setSettleCap: setSettleCap,
		__TEST__columns,
		/** @internal bytecode-smoke seams (production never calls these). */
		__TEST__eachArena: eachArena,
		__TEST__fanAtomsToArena: fanAtomsToArena,
		__TEST__arenaServe: arenaServe,
		// state (current composition; identity changes at reset)
		/**
		 * Id-keyed view of the internals registry, materialized per access from
		 * the dense column (the engine itself keys by nodeIndex only). Cold.
		 */
		get idToInternals(): Map<NodeId, AnyInternals> {
			const out = new Map<NodeId, AnyInternals>()
			for (const n of nodeIndexToInternals) {
				if (n !== undefined) {
					out.set(n.id, n)
				}
			}
			return out
		},
		get idToBatch(): Map<BatchId, Batch> {
			return idToBatch
		},
		get slots(): BatchSlotMeta[] {
			return slots
		},
		get idToRenderPass(): Map<RenderPassId, RenderPass> {
			return idToRenderPass
		},
		get roots(): Map<RootId, RootState> {
			return roots
		},
		get watchers(): Map<WatcherId, Watcher> {
			return watchers
		},
		get idToSignalEffect(): Map<SignalEffectId, SignalEffect> {
			return idToSignalEffect
		},
		get seq(): Seq {
			return seq
		},
		get committedAdvance(): Seq {
			return committedAdvance
		},
		get epoch(): Epoch {
			return epoch
		},
		get quiet(): boolean {
			return quiet
		},
		get devChecks(): boolean {
			return devChecks
		},
		get ambientBatch(): BatchId | undefined {
			return ambientBatch
		},
		get suspendDepth(): number {
			return suspendDepth
		},
		set suspendDepth(n: number) {
			suspendDepth = n
		},
		/** The trace recorder slot (attachTracer/Tracer.stop assign it). */
		get trace(): TraceHooks | undefined {
			return trace
		},
		set trace(hooks: TraceHooks | undefined) {
			trace = hooks
		},
		/** Optional log-entry drop observer (test/diagnostics seam). */
		get onLogEntryDrop(): ((atom: AtomInternals, entry: WriteLogEntry) => void) | undefined {
			return onLogEntryDrop
		},
		set onLogEntryDrop(fn: ((atom: AtomInternals, entry: WriteLogEntry) => void) | undefined) {
			onLogEntryDrop = fn
		},
		// direct listeners (attachDriver assigns them too; these accessors are the test face)
		get onDelivery(): ((w: Watcher, batch: Batch, slot: BatchSlot) => void) | undefined {
			return onDelivery
		},
		set onDelivery(fn: ((w: Watcher, batch: Batch, slot: BatchSlot) => void) | undefined) {
			onDelivery = fn
		},
		get onCorrection(): ((w: Watcher) => void) | undefined {
			return onCorrection
		},
		set onCorrection(fn: ((w: Watcher) => void) | undefined) {
			onCorrection = fn
		},
		/**
		 * Recorded dependency edges as dep → dependents (the union of every
		 * live arena's links; graphviz and the suites read it).
		 */
		get dependencyEdges(): Map<NodeId, Set<NodeId>> {
			return dependencyEdges()
		},
		/** Stale-watcher loud skips (the dormant-watcher aliasing pin). @internal */
		get __TEST__staleWatcherSkips(): number {
			return staleWatcherSkips
		},
	}

	/** The engine surface's type (the diagnostics tooling's parameter shape). */
	type CosignalEngine = typeof engine

	// ---- composition ---------------------------------------------------------------------
	// `composeEngine` assigns every resettable section of this factory closure.

	/**
	 * Derives quiet ⇔ zero live batches, zero open renders, zero episode holds.
	 * Recomputed only at pipeline transitions (batch open/retire, render
	 * start/end, driver attach) so write paths read a stored boolean.
	 */
	function recomputeQuiet(): void {
		setQuiet(liveBatchCount === 0 && rootToOpenRender.size === 0 && episodeHolds.size === 0)
	}

	/**
	 * The quiet flags' one writer: `quiet` here and `standaloneQuiet`
	 * (quiet AND no driver attached).
	 */
	function setQuiet(q: boolean): void {
		quiet = q
		__setStandaloneQuiet(q && driver === undefined)
	}

	/** A fresh sequence point per commit or history-changing retirement. */
	function advanceCommitted(): void {
		committedAdvance = nextSeq()
	}

	/** Engine computeds' {@link Reader}: kernel read plus observation capture. */
	const kernelTrackedReader: Reader = (dep) => {
		const oc = obsCapture
		if (oc !== undefined) {
			oc.push(dep)
		}
		return readKernelValue(dep)
	}

	/**
	 * Assignments follow section order. Deliberate survivors: the kernel arena
	 * and counters ({@link resetKernelState} scrubs those first), the batch-id
	 * counter (monotonic, so stale host-held ids can't collide), the reclamation
	 * queues (epoch-defused by that scrub), and the engine-activity probes.
	 */
	function composeEngine(options?: EngineResetOptions): void {
		probes.compositions++ // engine-activity counter (factory init + test resets)
		// section 7 — registries, dense columns, clocks, listeners, shared state
		idToRenderPass = new Map()
		roots = new Map()
		watchers = new Map()
		rootToOpenRender = new Map()
		nodeIndexToInternals = [undefined]
		lastWalk = [0]
		nodeToWatchers = [undefined]
		evalMark = [0]
		seq = 0
		committedAdvance = 0
		epoch = 0
		devChecks = options?.devChecks ?? false
		arenaInitInts = options?.arenaInitInts ?? WORLD_ARENA_INIT_INTS
		onLogEntryDrop = undefined
		driver = undefined
		trace = undefined
		activeWorld = undefined
		currentSink = 0
		obsCapture = undefined
		evalDepth = 0
		inFoldCallback = false
		activeSignalEffect = undefined
		suspendDepth = 0
		serveOverride = undefined
		suspendedCount = 0
		epilogueCheck = undefined
		opDepth = 0
		committingRender = undefined
		walkGen = 0
		signalEffectCount = 0
		onDelivery = undefined
		onMountCorrective = undefined
		onCorrection = undefined
		onSignalEffect = undefined
		// sections 8-10 — observation, episodes, batches (nextBatchId survives)
		obsRefs = [0]
		obsDeps = [undefined]
		episodeHolds = new Set()
		foldCandidates = new Set()
		idToBatch = new Map()
		slots = []
		for (let i = 0; i < SLOT_COUNT; i++) {
			slots.push({ id: i, tenant: undefined, claimSeq: 0, writeClock: 0, releasePending: false })
		}
		liveBatchCount = 0
		ambientBatch = undefined
		// sections 11-12 — worlds; world arenas
		evalGen = 0
		worldProvider = undefined
		rootToArena = new Map()
		arenaPool = []
		restaled = new Map()
		arenaFrame = undefined
		arenaFrameShadow = 0
		arenaFrameCycle = 0
		oneAtom.length = 0
		walkStack.length = 0
		// sections 13-14 — notification queue (empty when resets run), settlement
		notifyState.n = 0
		notifyState.flushing = false
		notifyKinds.length = 0
		notifyObservers.length = 0
		notifyBatches.length = 0
		notifySlots.length = 0
		notifyEffects.length = 0
		walkWatchers.length = 0
		walkEffects.length = 0
		drainWatcherBuf.length = 0
		pendingSettle = []
		pendingSettleSet.clear()
		settleDraining = false
		settleDrainScheduled = false
		settleCap = 10_000
		// sections 16-18 — observers, render integration, last-batch cache
		idToSignalEffect = new Map()
		dirtySignalEffects.length = 0
		nextSignalEffectId = 1
		nextRenderPassId = 1
		nextWatcher = 1
		staleWatcherSkips = 0
		lastBatchId = 0
		lastBatchRef = undefined
		// arm the derived flags from the fresh (empty) state
		syncReadRouting()
		recomputeQuiet()
	}

	// ---- signal reclamation -----------------------------------------------------------
	// FinalizationRegistry-driven recovery of records whose public handles were
	// garbage-collected ({@link registerReclaim} enrolls handles). Phase 1, the
	// finalizer body, verifies the record is dead and tears down structure;
	// phase 2, at an operation boundary, runs deferred user cleanups and frees.
	// A guard is a liveness source that blocks phase 1; blocked reclaims wait
	// as skip tickets until a guard's clearing site re-attempts them.

	/** A skip ticket: the tenancy generation and reset epoch to re-verify on retry. */
	type ReclaimRetryEntry = { gen: Generation; epoch: number }

	/** A reclaimed record's deferred user cleanups; its free queues behind them. */
	type DeferredCleanupEntry = { id: NodeId; gen: Generation; cleanups: (() => void)[] }

	/**
	 * Bounds of the packed finalizer heldValue `gen × ID_SPAN + id` — one
	 * float64 carrying both a record id and its tenancy generation.
	 */
	const enum HeldValue {
		/** 2^32: ids fit below it, so div/mod recover generation and id exactly. */
		ID_SPAN = 0x100000000,
		/**
		 * 2^21 — exclusive generation bound for packing: the largest packed value,
		 * (2^21 − 1) × 2^32 + (2^32 − 1) = 2^53 − 1, is still float64-exact. Larger
		 * or wrapped-negative generations fall back to an {id, gen} object.
		 */
		MAX_PACKED_GEN = 0x200000,
	}

	/**
	 * Finalizer heldValue — {@link registerReclaim} picks among the three
	 * forms; defusing compares generations by raw Int32 equality.
	 */
	type ReclaimHeld = number | { id: NodeId; gen: Generation }

	/**
	 * Blocked reclaims' skip tickets, keyed by id. Never scanned — a clearing
	 * site consults its own id; whole-arena teardowns drain the map.
	 */
	const reclaimSkipped = new Map<NodeId, ReclaimRetryEntry>()

	/**
	 * {@link reclaimSkipped}.size mirrored as a `var`: warm trigger sites bail
	 * on `!== 0` with no Map.size getter call. @internal
	 */
	// eslint-disable-next-line no-var
	var reclaimSkippedN = 0

	/** Ids whose guard just cleared; the boundary drain re-attempts them. */
	const reclaimRetries: NodeId[] = []

	/** Phase-2 input; the drain takes it wholesale (`let`: cold, never read per-call). */
	let deferredCleanups: DeferredCleanupEntry[] = []

	/** The one flag {@link maybeBoundary} tests for both queues (`var`: hot). */
	// eslint-disable-next-line no-var
	var reclaimWorkPending = false

	/** Set while phase 2 runs taken entries; a reentrant boundary skips. */
	// eslint-disable-next-line no-var
	var reclaimDrainGuard = false

	/**
	 * Set while the nudge — a microtask running {@link maybeBoundary} — is
	 * queued, so filed reclaim work drains even when no public operation follows.
	 */
	// eslint-disable-next-line no-var
	var reclaimNudgeScheduled = false

	/**
	 * Builds the per-epoch registry; the reset epoch lives in its closure.
	 * Dropping a registry cancels undelivered callbacks (the test reset's mass
	 * cancellation); an extracted callback no-ops on the epoch compare.
	 */
	function makeReclaimRegistry(): FinalizationRegistry<ReclaimHeld> | undefined {
		if (typeof FinalizationRegistry !== 'function') {
			return undefined // no-FR host: dropped handles keep the documented bounded retention
		}
		const epoch = engineEpoch
		return new FinalizationRegistry<ReclaimHeld>((held) => {
			if (typeof held === 'number') {
				if (held < HeldValue.ID_SPAN) {
					reclaimNode(held, 0, epoch)
				} else {
					const gen = Math.floor(held / HeldValue.ID_SPAN)
					reclaimNode(held - gen * HeldValue.ID_SPAN, gen, epoch)
				}
			} else {
				reclaimNode(held.id, held.gen, epoch)
			}
			// Phase 2 never runs in the GC job; the nudge's boundary runs it.
			scheduleReclaimNudge()
		})
	}

	// eslint-disable-next-line no-var
	var reclaimRegistry = makeReclaimRegistry()

	/**
	 * Handles register through {@link createKernel}'s registerReclaim.
	 * Measured rejects: per-handle unregister keys (+103ns per construction),
	 * WeakRef schemes (+93ns), deferred/batched and lazy registration.
	 * Deterministic dispose never unregisters — gen+epoch defusing covers it.
	 */

	function reclaimFileSkip(id: NodeId, gen: Generation, epoch: number): void {
		if (!reclaimSkipped.has(id)) {
			reclaimSkipped.set(id, { gen, epoch })
			reclaimSkippedN = reclaimSkipped.size
		}
	}

	/**
	 * Drop a skip ticket iff it names this tenancy — a stale finalizer for a
	 * reused id must never cancel the new tenant's pending retry.
	 */
	function reclaimDropSkip(id: NodeId, gen: Generation): void {
		if (reclaimSkippedN !== 0) {
			const e = reclaimSkipped.get(id)
			if (e !== undefined && e.gen === gen && reclaimSkipped.delete(id)) {
				reclaimSkippedN = reclaimSkipped.size
			}
		}
	}

	/**
	 * Per-id retry filing for a guard's clearing site. Only queues — clearing
	 * sites fire mid-walk, where structural teardown is unsafe. @internal
	 */
	function noteReclaimRetry(id: NodeId): void {
		if (reclaimSkippedN === 0 || !reclaimSkipped.has(id)) {
			return
		}
		reclaimRetries.push(id)
		if (reclaimWorkPending === false) {
			reclaimWorkPending = true
		}
		scheduleReclaimNudge()
	}

	/**
	 * Wholesale re-attempt at whole-arena teardowns (render end, settlement
	 * drain, arena release), where many guards clear at once. @internal
	 */
	function reclaimRetryAllSkipped(): void {
		if (reclaimSkippedN === 0) {
			return
		}
		for (const id of reclaimSkipped.keys()) {
			reclaimRetries.push(id)
		}
		if (reclaimWorkPending === false) {
			reclaimWorkPending = true
		}
		scheduleReclaimNudge()
	}

	function scheduleReclaimNudge(): void {
		if (reclaimNudgeScheduled === true) {
			return
		}
		reclaimNudgeScheduled = true
		const epoch = engineEpoch
		queueMicrotask(() => {
			reclaimNudgeScheduled = false
			if (epoch !== engineEpoch) {
				return
			}
			maybeBoundary()
		})
	}

	/** Surfaces a throwing phase-2 cleanup globally so the drain completes. */
	function reportReclaimError(err: unknown): void {
		const report = (globalThis as { reportError?: (e: unknown) => void }).reportError
		if (report !== undefined) {
			report(err)
			return
		}
		const epoch = engineEpoch
		queueMicrotask(() => {
			if (epoch === engineEpoch) {
				throw err
			}
		})
	}

	/**
	 * Phase 1 (the finalizer body; retries and the test seam reuse it): verify
	 * epoch and tenancy generation, verify every guard, then tear down
	 * structure. User code never runs here — owned effects' cleanups defer to
	 * phase 2, and a blocked reclaim files a skip ticket instead.
	 */
	function reclaimNode(id: NodeId, gen: Generation, epoch: number): void {
		if (epoch !== engineEpoch) {
			return // a dead epoch's callback (the belt behind the registry drop)
		}
		const memory = E.buffer()
		if (memory[id + NodeField.GEN] !== gen) {
			reclaimDropSkip(id, gen) // tenancy moved: this reclaim's target is already gone
			return
		}
		const flags: NodeFlags = memory[id + NodeField.FLAGS]
		if ((flags & (NodeFlag.K_SIGNAL | NodeFlag.K_COMPUTED)) === 0) {
			reclaimDropSkip(id, gen) // already disposed (free pending at this gen) — nothing to do
			return
		}
		if (enterDepth !== 0) {
			// Defensive: FR delivery is task-scheduled (kernel-idle); a mid-frame
			// arrival files itself for the boundary.
			reclaimFileSkip(id, gen, epoch)
			reclaimRetries.push(id)
			if (reclaimWorkPending === false) {
				reclaimWorkPending = true
			}
			scheduleReclaimNudge()
			return
		}
		// Guards: kernel subs, an active lifecycle, and the reclaimGuards rows.
		if (
			memory[id + NodeField.SUBS] !== 0 ||
			(lifecycleStates.size !== 0 && lifecycleStates.has(id)) ||
			reclaimGuards(id, memory[id + NodeField.NODE_INDEX])
		) {
			reclaimFileSkip(id, gen, epoch)
			return
		}
		reclaimDropSkip(id, gen)
		if (flags & NodeFlag.K_COMPUTED) {
			// Extract owned cleanups first so the teardown's dispose path finds none.
			const cleanups = collectOwnedCleanups(id)
			E.reclaimStructure(id)
			if (cleanups !== undefined) {
				deferredCleanups.push({ id, gen, cleanups })
				if (reclaimWorkPending === false) {
					reclaimWorkPending = true
				}
				scheduleReclaimNudge()
				return // the free queues behind the entry (phase 2 inserts it)
			}
		} else {
			E.reclaimStructure(id)
		}
		pendingFree.push(id) // swept at the boundary (freeNode: GEN bump + column clears + the record-free scrub)
	}

	/**
	 * Extracts the pending user cleanups of a dying computed's owned effect
	 * subtree (child effects/scopes link as deps of their creator), in the
	 * order deterministic disposal would run them. Undefined when none.
	 */
	function collectOwnedCleanups(id: NodeId): (() => void)[] | undefined {
		let out: (() => void)[] | undefined
		const memory = E.buffer()
		const walk = (node: NodeId): void => {
			let l = memory[node + NodeField.DEPS_TAIL]
			while (l !== 0) {
				const dep = memory[l + LinkField.DEP]
				const depFlags = memory[dep + NodeField.FLAGS]
				if (depFlags & (NodeFlag.K_EFFECT | NodeFlag.K_SCOPE)) {
					walk(dep) // grandchildren first (dispose runs deps before the own cleanup)
					if (depFlags & NodeFlag.K_EFFECT) {
						const cv: ValueIndex =
							(dep >> ArenaShape.ID_TO_VALUE_SHIFT) + ArenaShape.AUX_VALUE_OFFSET
						const cleanup = values[cv]
						if (typeof cleanup === 'function') {
							values[cv] = undefined
							;(out ??= []).push(cleanup as () => void)
						}
					}
				}
				l = memory[l + LinkField.PREV_DEP]
			}
		}
		walk(id)
		return out
	}

	/**
	 * Phase 2 plus retry processing ({@link boundaryWork} calls it): retries
	 * run first, then the cleanup queue is taken wholesale and run isolated;
	 * each record's free queues only after its own cleanups.
	 */
	function drainReclaimWork(): void {
		if (reclaimDrainGuard === true) {
			return // reentrant boundary during a cleanup: the outer drain owns the batch
		}
		reclaimDrainGuard = true
		try {
			reclaimWorkPending = false
			while (reclaimRetries.length !== 0) {
				const id = reclaimRetries.pop()!
				const entry = reclaimSkipped.get(id)
				if (entry !== undefined) {
					reclaimNode(id, entry.gen, entry.epoch)
				}
			}
			if (deferredCleanups.length !== 0) {
				const taken = deferredCleanups
				deferredCleanups = []
				for (let i = 0; i < taken.length; i++) {
					const entry = taken[i]
					const cleanups = entry.cleanups
					for (let k = 0; k < cleanups.length; k++) {
						try {
							cleanups[k]()
						} catch (err) {
							reportReclaimError(err)
						}
					}
					pendingFree.push(entry.id) // free queued last, after this entry's own cleanups
				}
			}
		} finally {
			reclaimDrainGuard = false
		}
		if (reclaimRetries.length !== 0 || deferredCleanups.length !== 0) {
			// Work filed during the drain (reentrant cleanups): next boundary.
			if (reclaimWorkPending === false) {
				reclaimWorkPending = true
			}
		}
	}

	/**
	 * Deterministic reclaim (test-only): defaults simulate a current-tenancy,
	 * current-epoch finalizer; a stale `gen`/`epoch` pins the defusing compares.
	 * Runs the trailing boundary so phase 2 lands synchronously. @internal
	 */
	function __TEST__simulateReclaim(id: NodeId, gen?: Generation, epoch?: number): void {
		reclaimNode(id, gen ?? E.buffer()[id + NodeField.GEN], epoch ?? engineEpoch)
		maybeBoundary()
	}

	/** Reclamation observability (test-only). @internal */
	function __TEST__reclaimStats(): {
		skipped: number
		retryQueue: number
		deferredCleanups: number
		pendingFree: number
		recNext: RecordId
		registryPresent: boolean
	} {
		return {
			skipped: reclaimSkipped.size,
			retryQueue: reclaimRetries.length,
			deferredCleanups: deferredCleanups.length,
			pendingFree: pendingFree.length,
			recNext,
			registryPresent: reclaimRegistry !== undefined,
		}
	}

	// ---- the test reset's kernel half (test-only) -----------------------------------

	/**
	 * Idle preconditions for `__TEST__resetEngine`: a reset inside a live
	 * kernel frame would corrupt the next test, not fail this one. @internal
	 */
	function __assertKernelIdleForReset(): void {
		if (enterDepth !== 0) {
			throw new Error(
				'cosignals: __TEST__resetEngine inside an open kernel frame (enterDepth !== 0)',
			)
		}
		if (batchDepth !== 0) {
			throw new Error('cosignals: __TEST__resetEngine inside batch() (batchDepth !== 0)')
		}
		if (runDepth !== 0) {
			throw new Error('cosignals: __TEST__resetEngine inside an effect run')
		}
		if (queuedLength !== notifyIndex) {
			throw new Error('cosignals: __TEST__resetEngine with queued effects unflushed')
		}
		if (E === POISON) {
			throw new Error('cosignals: __TEST__resetEngine inside a fold-purity frame')
		}
		if (reclaimDrainGuard === true) {
			throw new Error(
				"cosignals: __TEST__resetEngine inside the deferred-cleanup drain (a reclaimed record's user cleanup is on the stack)",
			)
		}
	}

	/**
	 * The kernel scrub (test-only): zero the used arena range, reset allocator
	 * heads/counters, drop side columns to burned seeds — never a reallocation
	 * (the op table's captured buffer stays valid). Bumps the reset epoch. @internal
	 */
	function resetKernelState(): void {
		__assertKernelIdleForReset()
		engineEpoch++
		E.buffer().fill(0, 0, recNext) // watermark-bounded: only the used range holds records
		recNext = ArenaShape.STRIDE // record 0 stays burned
		nextNodeIndex = 1 // index 0 stays burned
		nodeFreeHead = 0
		linkFreeHead = 0
		growPending = false
		cycle = 0
		notifyIndex = 0
		queuedLength = 0
		activeSub = 0
		queued.length = 0
		pendingFree.length = 0
		// Side columns: stale values, closures, and clock stamps must not survive id reuse.
		resetSideColumns(E.clocks())
		clockSource = 0
		// Walk scratch: a reset mid-diagnosis must not leave stale cursors.
		propSp = 0
		checkSp = 0
		// configure({initialRecords}) resets too: back to the process default.
		desiredRecords = initialRecords * ArenaShape.RECORDS_PER_UNIT
		routingActive = false
		// Reclamation scrub: dropping the registry cancels its pending callbacks.
		reclaimRegistry = makeReclaimRegistry()
		reclaimSkipped.clear()
		reclaimSkippedN = 0
		reclaimRetries.length = 0
		deferredCleanups = []
		reclaimWorkPending = false
	}

	// ---- the engine dispatch ----------------------------------------------------------

	/**
	 * @internal Test seam (leak audit): a record's side-column slots, read-only
	 * — freed records must not pin dead values or closures.
	 */
	function __TEST__kernelSideColumns(id: NodeId): {
		value: unknown
		aux: unknown
		fn: Function | undefined
	} {
		const v: ValueIndex = id >> ArenaShape.ID_TO_VALUE_SHIFT
		return {
			value: values[v],
			aux: values[v + ArenaShape.AUX_VALUE_OFFSET],
			fn: fns[id >> ArenaShape.ID_TO_FN_SHIFT],
		}
	}

	/**
	 * Plain-path write tail shared by the public methods' standalone fast arm
	 * and the engine's no-internals dispatch arm: fold the op, then
	 * {@link writeAtom}, which applies policy equality once at acceptance. @internal
	 */
	function __plainAtomWrite(atom: Atom<unknown>, kind: WriteKind, payload: unknown): void {
		const id = atom._id
		const next =
			kind === 0
				? payload
				: runFold(() =>
						(payload as (p: unknown) => unknown)(
							values[(id >> ArenaShape.ID_TO_VALUE_SHIFT) + ArenaShape.AUX_VALUE_OFFSET],
						),
					)
		writeAtom(id, atom._isEqual, next)
	}

	/**
	 * Handle-free write path for the engine's lifecycle contexts, which hold
	 * node ids but no handle reference: the public methods' policy assert, then
	 * the engine dispatch. An atom with no engine internals takes the plain kernel
	 * write with identity equality — its comparator sits on the unreachable handle. @internal
	 */
	function __lifecycleWrite(id: NodeId, kind: WriteKind, payload: unknown): void {
		if (forbidWritesInComputeds === true && E.activeIsComputed()) {
			throw new Error(
				'cosignals: writes inside computeds are forbidden (configure({ forbidWritesInComputeds: true })).',
			)
		}
		const node = __engineAtomInternalsById(id)
		if (node !== undefined) {
			__engineWriteNode(node, kind, payload)
			return
		}
		const next =
			kind === 0
				? payload
				: runFold(() =>
						(payload as (p: unknown) => unknown)(
							values[(id >> ArenaShape.ID_TO_VALUE_SHIFT) + ArenaShape.AUX_VALUE_OFFSET],
						),
					)
		writeAtom(id, undefined, next)
	}

	/**
	 * @internal Test-only policy scrub:
	 * configure() defaults restored; lifecycle map and queued flush dropped.
	 */
	function __TEST__resetPolicy(): void {
		forbidWritesInComputeds = false
		__TEST__resetLifecycle()
	}

	// ════ Policy layer ═══════════════════════════════════════════════════════════

	// ---- policy state -------------------------------------------------------------

	// Both policy flags use `var` to avoid a per-access lexical hole check in
	// optimized code; `=== true` guards use a boolean-singleton pointer compare,
	// cheaper than the generic ToBoolean ladder a truthiness test compiles to.
	// eslint-disable-next-line no-var
	var forbidWritesInComputeds = false

	/**
	 * True while the engine is quiet AND no driver is attached — the public
	 * write path's one fast-arm check.
	 */
	// eslint-disable-next-line no-var
	var standaloneQuiet = true

	/**
	 * @internal Engine seam: lands the engine's quiet-and-driverless derivation.
	 * Cold; stores only on change so the untouched slot stays constant-trackable.
	 */
	function __setStandaloneQuiet(v: boolean): void {
		if (v !== standaloneQuiet) {
			standaloneQuiet = v
		}
	}

	/**
	 * Runs an updater/reducer under the fold-purity guard: `E` swaps to
	 * POISON, the engine's every-op-throws table, so a fold touching any signal
	 * throws at the dispatch site while the hot paths carry zero fold
	 * instructions; open outer frames hold the real table as closure constants.
	 */
	function runFold<T>(fn: () => T): T {
		const saved = foldGuardSwap()
		try {
			return fn()
		} finally {
			foldGuardRestore(saved)
		}
	}

	// ---- the computed evaluation policy --------------------------------------------
	// __TEST__ctxUse: test seam over the engine's ctx.use request cache.

	// ---- public API -----------------------------------------------------------------

	/** Passed to an Atom's `effect` option while the atom is observed. */
	type AtomCtx<T> = {
		/** Current value, read without registering a dependency. */
		readonly state: T
		set(value: T): void
		update(fn: (current: T) => T): void
	}

	type AtomOptions<T> = {
		/**
		 * Observed lifecycle: runs when the atom gains its first subscriber of
		 * any kind — kernel (a live computed chain or core effect), SignalEffect,
		 * or React watcher — and the returned cleanup runs once the last
		 * subscriber of every kind is gone. Delivered in a microtask, so flaps
		 * within one tick coalesce; bare `.state` reads never observe. For remote subscriptions.
		 */
		effect?: (ctx: AtomCtx<T>) => void | (() => void)
		/**
		 * Policy equality for writes: an incoming value equal to the newest is
		 * dropped. While recorded writes are live, different worlds may fold
		 * different values, so the write is kept and equality applies per fold
		 * step. The kernel itself compares reference identity only.
		 */
		isEqual?: (a: T, b: T) => boolean
		/** Debug label. */
		label?: string
	}

	type ComputedOptions<T> = {
		/**
		 * Policy equality for recomputes: an equal result returns the previous
		 * reference, so downstream sees no change. The kernel compares identity only.
		 */
		isEqual?: (a: T, b: T) => boolean
		/** Debug label. */
		label?: string
	}

	/** A writable signal. `.state` reads (tracked inside evaluations), `.set` writes. */
	class Atom<T> {
		/** Kernel record id; consumed by the React bindings (`cosignals-react`). @internal */
		readonly _id: NodeId
		/**
		 * The engine surface that owns this handle. Every handle-taking engine
		 * entry point asserts it, so a handle used with a DIFFERENT
		 * createCosignals() instance throws a clear error instead of silently
		 * resolving its id against the wrong arena. @internal
		 */
		readonly _engine = engine
		/** @internal */
		readonly _isEqual: ((a: unknown, b: unknown) => boolean) | undefined
		/**
		 * Engine internals, allocated lazily at first engine content (a log
		 * entry, a watcher, arena presence, a routed read); undefined until then,
		 * 1:1 with the handle for its life, cleared by the record-free scrub. @internal
		 */
		_internals: AtomInternals | undefined = undefined
		readonly label: string | undefined

		constructor(initialState: T, options?: AtomOptions<T>) {
			maybeBoundary()
			// Reclamation: a dropped handle's record recovers via the finalizer;
			// registration rides the allocation op. The instance stays a flat
			// field record — the shape measured cheapest for the GC to collect.
			const id = E.newSignal(initialState, this)
			this._id = id
			this._isEqual = options?.isEqual as ((a: unknown, b: unknown) => boolean) | undefined
			this.label = options?.label
			const effect = options?.effect
			if (effect !== undefined) {
				E.markLifecycle(id)
				// The callback parks in this atom's own `fns` slot (unused for
				// atoms; record free clears it). The engine's active lifecycle
				// record is id-keyed and never holds a handle reference.
				fns[id >> ArenaShape.ID_TO_FN_SHIFT] = effect
			}
		}

		/**
		 * The atom's current value (a tracked read inside evaluations); with a
		 * routing context live, the engine serves the asking world's value —
		 * except inside kernel frames (`activeSub === 0` guards the routed arm):
		 * kernel caches hold newest-world state, and a world-folded value landing
		 * there would serve later reads with no invalidation. Folds throw on dispatch.
		 */
		get state(): T {
			if (routingActive && activeSub === 0 && enterDepth === 0) {
				const v = routedAtomRead(this)
				if (v !== NOT_ROUTED) {
					return v as T
				}
			}
			return E.readAtom(this._id) as T
		}

		/**
		 * Replaces the atom's value: the standalone fast arm (plain kernel
		 * write) or the engine dispatch.
		 */
		set(value: T): void {
			if (forbidWritesInComputeds === true && E.activeIsComputed()) {
				throw new Error(
					'cosignals: writes inside computeds are forbidden (configure({ forbidWritesInComputeds: true })).',
				)
			}
			if (this._internals === undefined && standaloneQuiet === true) {
				writeAtom(this._id, this._isEqual, value)
				return
			}
			writeAtomConcurrent(this, 0, value)
		}

		/**
		 * Functional update. `fn` must be pure — it runs under the fold-purity
		 * guard, so signal reads and writes inside it throw; read inputs first.
		 * An engine-dispatched update records the whole op for per-world replay.
		 */
		update(fn: (current: T) => T): void {
			if (forbidWritesInComputeds === true && E.activeIsComputed()) {
				throw new Error(
					'cosignals: writes inside computeds are forbidden (configure({ forbidWritesInComputeds: true })).',
				)
			}
			if (this._internals === undefined && standaloneQuiet === true) {
				const id = this._id
				const next = runFold(() =>
					fn(values[(id >> ArenaShape.ID_TO_VALUE_SHIFT) + ArenaShape.AUX_VALUE_OFFSET] as T),
				)
				writeAtom(id, this._isEqual, next)
				return
			}
			writeAtomConcurrent(this, 1, fn)
		}
	}

	type ReducerAtomOptions<S> = AtomOptions<S>

	/**
	 * An atom whose writes go through a reducer, fixed at creation and pure
	 * (it runs under the fold-purity guard). `dispatch(action)` is exactly
	 * `update(s => reduce(s, action))`, replayed per world like any updater.
	 */
	class ReducerAtom<S, A> extends Atom<S> {
		readonly reduce: (state: S, action: A) => S

		constructor(
			reduce: (state: S, action: A) => S,
			initialState: S,
			options?: ReducerAtomOptions<S>,
		) {
			super(initialState, options)
			this.reduce = reduce
		}

		dispatch(action: A): void {
			const reduce = this.reduce
			this.update((s) => reduce(s, action))
		}
	}

	/** A derived signal. `.state` reads; the function re-runs on demand. */
	class Computed<T> {
		/** Kernel record id; consumed by the React bindings (`cosignals-react`). @internal */
		readonly _id: NodeId
		/** The owning engine surface (see {@link Atom._engine}). @internal */
		readonly _engine = engine
		/**
		 * Engine internals, allocated lazily at first engine content (see
		 * {@link Atom._internals}). @internal
		 */
		_internals: ComputedInternals | undefined = undefined
		/**
		 * The raw authored fn, retained on the instance so a reused kernel id
		 * can never serve another tenant's fn; the engine's world evaluations run
		 * it against world-local previous values. @internal
		 */
		readonly _fn: (ctx: ComputedCtx<T>) => T
		/** @internal */
		readonly _isEqual: ((a: unknown, b: unknown) => boolean) | undefined
		readonly label: string | undefined

		constructor(fn: (ctx: ComputedCtx<T>) => T, options?: ComputedOptions<T>) {
			maybeBoundary()
			this._fn = fn
			this.label = options?.label
			const isEqual = options?.isEqual as ((a: unknown, b: unknown) => boolean) | undefined
			this._isEqual = isEqual
			// Reclamation rides the allocation op (see Atom's constructor note).
			const id = E.newComputed(fn as (ctx: unknown) => unknown, this)
			this._id = id
			if (isEqual !== undefined) {
				// Only equality users pay a wrapper: an equal result returns the
				// OLD reference so the kernel's identity compare sees no change.
				// HAS_BOX set means `prev` is a residual error/thenable payload, not comparable.
				const iv: ValueIndex = id >> ArenaShape.ID_TO_VALUE_SHIFT
				fns[id >> ArenaShape.ID_TO_FN_SHIFT] = (ctxArg: unknown): unknown => {
					const prev = values[iv]
					const next = (fn as (ctx: unknown) => unknown)(ctxArg)
					if (prev === undefined || (E.buffer()[id + NodeField.FLAGS] & NodeFlag.HAS_BOX) !== 0) {
						return next
					}
					return isEqual(prev, next) ? prev : next
				}
			}
		}

		/**
		 * The computed's current value: rethrows the evaluation's cached error;
		 * throws `SuspendedRead` while suspended on a pending `ctx.use` thenable.
		 * World routing and the kernel-frame guard match {@link Atom.state};
		 * inside a fold frame the dispatch itself throws.
		 */
		get state(): T {
			if (routingActive && activeSub === 0 && enterDepth === 0) {
				const v = routedComputedRead(this as Computed<unknown>)
				if (v !== NOT_ROUTED) {
					return v as T
				}
			}
			return E.computedRead(this._id) as T
		}
	}

	// Cross-instance TYPE brands on the class prototypes (see the module-level
	// ATOM_BRAND/COMPUTED_BRAND note): every instance's prototype carries the same
	// brand value, so isAtom/isComputed recognize handles from any instance.
	// ReducerAtom extends Atom and inherits the atom brand.
	;(Atom.prototype as unknown as Record<symbol, unknown>)[ATOM_BRAND] = true
	;(Computed.prototype as unknown as Record<symbol, unknown>)[COMPUTED_BRAND] = true

	/**
	 * Assert a public handle belongs to THIS engine instance; the loud
	 * alternative to the silent cross-instance corruption a foreign id would
	 * cause (its `_id` resolved against this arena addresses a different record).
	 */
	function assertOwnHandle(handle: { _engine?: unknown }): void {
		if (handle._engine !== engine) {
			throw new Error('cosignals: handle belongs to a different engine instance')
		}
	}

	/**
	 * Ownership assert for a resolved internals record, reached through its
	 * (possibly weak) handle; a collected handle cannot be re-associated with a
	 * foreign engine, so an unresolvable one passes.
	 */
	function assertOwnInternals(node: AnyInternals): void {
		const h = node._h
		const handle = h instanceof WeakRef ? h.deref() : h
		if (handle !== undefined && (handle as { _engine?: unknown })._engine !== engine) {
			throw new Error('cosignals: handle belongs to a different engine instance')
		}
	}

	/** Either public signal wrapper. */
	type Signal<T> = Atom<T> | Computed<T>

	/**
	 * Runs `fn` immediately with dependency tracking and re-runs it when
	 * tracked signals change; effects always observe the newest world. `fn` may
	 * return a cleanup, run before each re-run and at dispose; returns a disposer.
	 */
	function effect(fn: () => void | (() => void)): () => void {
		maybeBoundary()
		const id = E.newEffect(fn)
		const gen = E.gen(id)
		return () => {
			if (E.gen(id) !== gen) {
				return // record already reclaimed (and possibly reused)
			}
			E.disposeEffect(id)
			maybeBoundary()
		}
	}

	/** Returns a disposer that disposes every effect created inside `fn`. */
	function effectScope(fn: () => void): () => void {
		maybeBoundary()
		const id = E.newScope(fn)
		const gen = E.gen(id)
		return () => {
			if (E.gen(id) !== gen) {
				return
			}
			E.disposeEffect(id)
			maybeBoundary()
		}
	}

	// batch()/startBatch()/endBatch() coalesce synchronous effect runs over the
	// kernel's batch counter (unrelated to the engine's Batch records);
	// untracked() clears the tracking frame.

	type ConfigureOptions = {
		/**
		 * When true, any atom write during a computed evaluation throws. When
		 * false (default), writes inside computeds are tolerated as long as they
		 * do not re-enter the writing computed (evaluation cycles throw
		 * CycleError; self-feedback settles by lazy revalidation).
		 */
		forbidWritesInComputeds?: boolean
		/**
		 * Capacity floor, in records (one node or one link each; the arena holds
		 * 3× this number — one node plus two links per unit). Raising it grows at
		 * the next operation boundary; it never shrinks. Also settable via the
		 * COSIGNAL_INITIAL_RECORDS env var before first import.
		 */
		initialRecords?: number
	}

	function configure(options: ConfigureOptions): void {
		if (options.forbidWritesInComputeds !== undefined) {
			forbidWritesInComputeds = options.forbidWritesInComputeds
		}
		const n = options.initialRecords
		if (n !== undefined) {
			if (!Number.isFinite(n) || n < MIN_INITIAL_RECORDS) {
				throw new Error(
					`cosignals: configure({ initialRecords }) must be a number >= ${MIN_INITIAL_RECORDS}.`,
				)
			}
			requestCapacity(Math.ceil(n)) // CosignalEngine.ts: unit→record scaling + growth scheduling
		}
	}

	function serializeAtomState(
		atoms: Record<string, Atom<unknown> | ReducerAtom<unknown, unknown>>,
		replacer?: (key: string, value: unknown) => unknown,
	): string {
		if (!quiescent()) {
			throw new ScheduleError('serializeAtomState requires no live batch or render')
		}
		const out: Record<string, unknown> = {}
		for (const key in atoms) {
			if (!Object.prototype.hasOwnProperty.call(atoms, key)) {
				continue
			}
			const value = atoms[key].state
			out[key] = replacer === undefined ? value : replacer(key, value)
		}
		return JSON.stringify(out)
	}

	function initializeAtomState(
		json: string,
		atoms: Record<string, Atom<unknown> | ReducerAtom<unknown, unknown>>,
		reviver?: (key: string, value: unknown) => unknown,
	): void {
		if (!quiescent()) {
			throw new ScheduleError('initializeAtomState requires no live batch or render')
		}
		const data = JSON.parse(json) as Record<string, unknown>
		for (const key in data) {
			if (!Object.prototype.hasOwnProperty.call(data, key)) {
				continue
			}
			const atom = atoms[key]
			if (atom === undefined) {
				console.warn(`cosignals: initializeAtomState: unknown key "${key}"`)
				continue
			}
			const value = reviver === undefined ? data[key] : reviver(key, data[key])
			atom.set(value)
		}
	}

	composeEngine(options)
	return {
		Atom,
		ReducerAtom,
		Computed,
		effect,
		effectScope,
		batch,
		startBatch,
		endBatch,
		untracked,
		configure,
		serializeAtomState,
		initializeAtomState,
		SuspendedRead,
		attachDriver,
		engine,
		BATCH_NONE,
		__TEST__resetEngine,
		__TEST__coreProbes,
		__TEST__internalsById,
		__TEST__eachInternals,
		__TEST__kernelSideColumns,
		__TEST__ctxUse,
		__TEST__simulateReclaim,
		__TEST__reclaimStats,
		__TEST__useCache,
		__TEST__peekNextBatchId,
		__TEST__columns,
		get E() {
			return E
		},
		get engineEpoch() {
			return engineEpoch
		},
		maybeBoundary,
		getKernelGeneration,
		getKernelNodeIndex,
	}
}

export type Cosignals = ReturnType<typeof createCosignals>
export type CosignalEngine = Cosignals['engine']
export type EngineDriver = Parameters<Cosignals['attachDriver']>[0]
export type EngineResetOptions = NonNullable<Parameters<Cosignals['__TEST__resetEngine']>[0]>

// The default browser instance keeps the historical large floor (env override
// honored), so its behavior is unchanged; only user `createCosignals()` calls
// default SMALL.
const defaultCosignals = createCosignals({
	initialRecords: readEnvInitialRecords() ?? DEFAULT_INITIAL_RECORDS,
})
export const Atom = defaultCosignals.Atom
export type Atom<T> = InstanceType<typeof defaultCosignals.Atom<T>>
export const ReducerAtom = defaultCosignals.ReducerAtom
export type ReducerAtom<S, A> = InstanceType<typeof defaultCosignals.ReducerAtom<S, A>>
export const Computed = defaultCosignals.Computed
export type Computed<T> = InstanceType<typeof defaultCosignals.Computed<T>>
export type Signal<T> = Atom<T> | Computed<T>
export type ReducerAtomOptions<S> = AtomOptions<S>

/**
 * True for an Atom (or ReducerAtom) handle from ANY createCosignals()
 * instance. Uses a shared prototype brand rather than `instanceof`, which each
 * instance's own class would fail for another instance's handles — the check
 * embedders (and the React bindings) need to accept per-instance handles.
 */
export function isAtom(x: unknown): x is Atom<unknown> {
	return typeof x === 'object' && x !== null && (x as Record<symbol, unknown>)[ATOM_BRAND] === true
}
/** True for a Computed handle from ANY createCosignals() instance (see {@link isAtom}). */
export function isComputed(x: unknown): x is Computed<unknown> {
	return (
		typeof x === 'object' && x !== null && (x as Record<symbol, unknown>)[COMPUTED_BRAND] === true
	)
}
export const effect = defaultCosignals.effect
export const effectScope = defaultCosignals.effectScope
export const batch = defaultCosignals.batch
export const startBatch = defaultCosignals.startBatch
export const endBatch = defaultCosignals.endBatch
export const untracked = defaultCosignals.untracked
export const configure = defaultCosignals.configure
export const serializeAtomState = defaultCosignals.serializeAtomState
export const initializeAtomState = defaultCosignals.initializeAtomState
// SuspendedRead is the module-level class, exported directly at the file tail
// (one shared class across instances — see its definition). Every instance's
// `.SuspendedRead` is this same class.
export const attachDriver = defaultCosignals.attachDriver
export const engine = defaultCosignals.engine
export const BATCH_NONE = defaultCosignals.BATCH_NONE

export let engineEpoch = defaultCosignals.engineEpoch
export function __TEST__resetEngine(options?: EngineResetOptions): void {
	defaultCosignals.__TEST__resetEngine(options)
	engineEpoch = defaultCosignals.engineEpoch
}
export const __TEST__coreProbes = defaultCosignals.__TEST__coreProbes
export const __TEST__internalsById = defaultCosignals.__TEST__internalsById
export const __TEST__eachInternals = defaultCosignals.__TEST__eachInternals
export const __TEST__kernelSideColumns = defaultCosignals.__TEST__kernelSideColumns
export const __TEST__ctxUse = defaultCosignals.__TEST__ctxUse
export const __TEST__simulateReclaim = defaultCosignals.__TEST__simulateReclaim
export const __TEST__reclaimStats = defaultCosignals.__TEST__reclaimStats
export const __TEST__useCache = defaultCosignals.__TEST__useCache
export const __TEST__peekNextBatchId = defaultCosignals.__TEST__peekNextBatchId
export const __TEST__columns = defaultCosignals.__TEST__columns
export const maybeBoundary = defaultCosignals.maybeBoundary
export const getKernelGeneration = defaultCosignals.getKernelGeneration
export const getKernelNodeIndex = defaultCosignals.getKernelNodeIndex
export const E: Cosignals['E'] = new Proxy({} as Cosignals['E'], {
	get(_target, key) {
		return defaultCosignals.E[key as keyof Cosignals['E']]
	},
})

export type AtomInternals = ReturnType<CosignalEngine['atom']>
export type ComputedInternals = ReturnType<CosignalEngine['computed']>
export type AnyInternals = AtomInternals | ComputedInternals
export type Watcher = ReturnType<CosignalEngine['mountWatcher']>
export type SignalEffect = ReturnType<CosignalEngine['mountSignalEffect']>
export type WorldArena = NonNullable<ReturnType<CosignalEngine['__TEST__arena']>>
export type RenderPass = ReturnType<CosignalEngine['renderStart']>
export type Batch = ReturnType<CosignalEngine['openBatch']>
export type WriteLogEntry = ReturnType<AtomInternals['log']['materialize']>[number]
export type World = Parameters<CosignalEngine['evaluate']>[1]
export type Reader = Parameters<Parameters<CosignalEngine['computed']>[1]>[0]
export type Equals = AtomInternals['equals']
export type Value = unknown
export type RootId = Parameters<CosignalEngine['root']>[0]
export type RenderPassId = RenderPass['id']
export type SignalEffectId = SignalEffect['id']
export type BatchId = Batch['id']
export type BatchSlot = NonNullable<Batch['slot']>
export type BatchSlotSet = ReturnType<CosignalEngine['root']>['committedBits']
export type Seq = CosignalEngine['seq']
export type Epoch = CosignalEngine['epoch']
export type CommitGen = ReturnType<CosignalEngine['root']>['commitGen']
export type TraceHooks = NonNullable<CosignalEngine['trace']>
export type ArenaCheckerInternals = ReturnType<CosignalEngine['__TEST__checkerInternals']>

export type TraceEvent =
	| { type: 'write'; node: string; batch: BatchId; slot: BatchSlot; seq: Seq }
	| { type: 'write-dropped'; node: string; batch: BatchId }
	| { type: 'quiet-write'; node: string; seq: Seq }
	| {
			type: 'delivery'
			watcher: string
			batch: BatchId
			slot: BatchSlot
			seq: Seq
			mode: 'fresh' | 'interleaved'
	  }
	| { type: 'suppressed'; watcher: string; batch: BatchId; slot: BatchSlot; seq: Seq }
	| { type: 'core-effect-run'; effect: string; value: Value }
	| { type: 'react-effect-run'; effect: string; root: RootId; value: Value; values: Value[] }
	| { type: 'react-effect-cleanup'; effect: string; root: RootId }
	| {
			type: 'reconcile-correction'
			watcher: string
			root: RootId
			from: Value
			to: Value
			cause: 'retirement' | 'per-root-commit'
	  }
	| { type: 'mount-corrective'; watcher: string; batch: BatchId; slot: BatchSlot }
	| { type: 'mount-urgent-correction'; watcher: string; from: Value; to: Value }
	| { type: 'per-root-commit'; root: RootId; batch: BatchId }
	| { type: 'retired'; batch: BatchId; retiredSeq: Seq }
	| { type: 'slot-claimed'; slot: BatchSlot; batch: BatchId }
	| { type: 'slot-released'; slot: BatchSlot; batch: BatchId }
	| { type: 'slot-backstop-released'; slot: BatchSlot; batch: BatchId }
	| { type: 'render-committed'; renderPass: RenderPassId; root: RootId }
	| { type: 'render-discarded'; renderPass: RenderPassId; root: RootId }
	| { type: 'epoch-reset'; epoch: Epoch }

export { CycleError, InvariantViolation, ScheduleError, SuspendedRead }
