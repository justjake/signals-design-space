/**
 * cosignals-alt-b engine: M1 kernel + M2 tapes/write gate + M3 world overlay
 * + M4 policy extras, in one module so the layout `const enum` inlines
 * everywhere (spec §15.1; the enum block is generated from tools/schema.ts).
 *
 * Kernel: adapted from the proven donor at libs/arena/src/index.ts
 * (alien-signals v3.2.1 semantics on interleaved Int32Array records), with the
 * five overlay-support mechanisms of spec §8.7: broadcast list, notify walk,
 * mark repair in linkInsert, invalidate, and log-plane allocation.
 *
 * Growth follows §14.1: all plane-touching code lives in createEngineCore's
 * closure over const buffers; allocators flag growth at plane watermarks and
 * boundary() rebuilds the closure over doubled buffers only at operation
 * boundaries (enterDepth === 0), swapping the single module-level `E`.
 *
 * Documented deviations from the spec (reported in the milestone summary):
 * - Certificates live in their own Int32Array (CERT) with a bump pointer
 *   rather than the tail half of plane W (§7.4). Same lifecycle (bulk reset at
 *   quiescence), simpler bounds math.
 * - Urgent-drain broadcast evaluation uses the W0 world (retired ∪ applied)
 *   per §10.6's writer's-world rule, expanded across every live deferred
 *   writer's world per §17.2's oracle rule; the two spec sections contradict
 *   ("newest world") and the expansion resolves it (oracle-validated).
 * - Re-memoization reuses the (node, key) record in place instead of
 *   tombstone-and-prepend (§10.5's "appends a fresh record") — chain growth
 *   per re-evaluation turned drain re-validation quadratic (measured, G-7 at
 *   30-40x); the W_SLOT_NEXT = -1 sentinel late-links records whose token had
 *   no slot at first evaluation.
 */

import type { Container, ForkLike } from './fork'

// ---- layout constants (generated from tools/schema.ts) --------------------------
// #region GENERATED — layout v1 (from tools/schema.ts; run `pnpm gen`) — DO NOT EDIT
const enum C {
	// node record (plane M, stride 8; ids pre-multiplied: id = record * 8).
	FLAGS = 0, // state machine + kind bits
	DEPS = 1, // first dependency link; free-list next when freed
	DEPS_TAIL = 2, // last confirmed dependency link (re-run cursor)
	SUBS = 3, // first subscriber link
	SUBS_TAIL = 4, // last subscriber link
	GEN = 5, // generation counter; bumped on free, defuses stale disposers
	LOG_HEAD = 6, // atoms: first log record id in plane G (0 = no log)
	OVERLAY_STAMP = 6, // computeds/effects/watchers: last notify-walk ticket; marked iff > eraFloor
	LOG_TAIL = 7, // atoms: last log record id
	MEMO_KEY = 7, // computeds: world key of the head memo record (fast hit check)

	// link record (plane M, stride 8; ids pre-multiplied: id = record * 8).
	VERSION = 0, // evaluation-cycle stamp: intra-run duplicate-read dedup
	DEP = 1, // producer node id
	SUB = 2, // consumer node id
	PREV_SUB = 3, // previous link in the producer's subscriber list
	NEXT_SUB = 4, // next link in the producer's subscriber list
	PREV_DEP = 5, // previous link in the consumer's dependency list
	NEXT_DEP = 6, // next link in the consumer's dependency list; free-list next when freed

	// log record (plane G, stride 4; ids pre-multiplied: id = record * 4).
	L_NEXT = 0, // next entry in this atom's log (append = seq order); 0 = tail; free-list next when freed
	L_META = 1, // packed: OP (bits 0-1), APPLIED (2), RETIRED (3), BATCH_SLOT (4-8), PSEUDO (9)
	L_SEQ = 2, // take-a-number ticket at append time
	L_RETIRED_SEQ = 3, // 0 while pending; a fresh ticket stamped at retirement

	// memo record (plane W, stride 8; ids pre-multiplied: id = record * 8).
	W_KEY = 0, // world key (0 newest; (passSerial<<2)|1; (token<<2)|2)
	W_EPOCH = 1, // overlayEpoch at evaluation; 0 is the tombstone value
	W_NODE = 2, // owning computed (drain re-validation + stale-head guard)
	W_VAL = 3, // index into the memoVals side array (GC-visible value/box)
	W_NEXT_MEMO = 4, // next memo record on the same node's chain
	W_SLOT_NEXT = 5, // writer's-world records only: next record on the batch slot's chain
	W_NDEPS = 6, // number of certificate pairs
	W_CERT = 7, // offset of this memo's certificate run in the certificate region

	// node FLAGS word (spec §7.2).
	MUTABLE = 1, // can produce new values (atoms, computeds)
	WATCHING = 2, // wants notification when possibly stale (effects, watchers)
	RECURSED_CHECK = 4, // currently evaluating (re-entrancy guard)
	RECURSED = 8, // re-entrant write reached me during my own run
	DIRTY = 16, // definitely stale
	PENDING = 32, // possibly stale — verify by pulling before recomputing
	HAS_CHILD_EFFECT = 64, // dep list contains child effects/scopes (slow-path cleanup)
	LOGGED = 128, // atoms only: LOG_HEAD !== 0 — the read gate
	IMMEDIATE = 256, // watchers only: notify via the broadcast list, not the effect queue
	K_ATOM = 1024, // kind: writable atom
	K_COMPUTED = 2048, // kind: computed
	K_EFFECT = 4096, // kind: effect
	K_SCOPE = 8192, // kind: effect scope
	K_WATCHER = 16384, // kind: React watcher (broadcast-notified)
	KIND_MASK = 31744, // K_ATOM | K_COMPUTED | K_EFFECT | K_SCOPE | K_WATCHER

	// log L_META packing (spec §7.3).
	OP_MASK = 3, // L_META bits 0-1: operation
	OP_BASE = 0, // base record (tape-creation snapshot)
	OP_SET = 1, // SET: payload replaces the accumulator
	OP_UPDATE = 2, // UPDATE: payload fn applies to the accumulator
	OP_DISPATCH = 3, // DISPATCH: the atom's reducer applies the action
	F_APPLIED = 4, // already written through the kernel (urgent writes, §9.4)
	F_RETIRED = 8, // batch retired; visibility runs on L_RETIRED_SEQ
	SLOT_SHIFT = 4, // L_META bits 4-8: batch slot (0-31)
	SLOT_MASK = 496, // 31 << SLOT_SHIFT
	F_PSEUDO = 512, // slot-exhaustion fallback entry (§9.2), counted outside slots

	REC_SLACK = 1280, // min free main-plane records guaranteed at each op boundary
}
// #endregion GENERATED layout

// Read contexts (spec §10.1).
const enum Ctx {
	NEWEST = 0,
	RENDER = 1,
	COMMITTED = 2,
}

// World kinds for overlay resolution (spec §10.2).
const enum WK {
	NEWEST = 0,
	PASS = 1,
	WRITER = 2, // deferred writer's world: RETIRED | APPLIED | own batch
	COMMITTED = 3, // global form: RETIRED only
	W0 = 4, // retired | applied — the canonical world; urgent broadcast world
	CROOT = 5, // per-root committed view (§13.4): retired ≤ root pin, plus lock-ins
	FIXUP = 6, // §13.2 fixup world: all retired history, plus remembered includes ≤ pin
}

type World = {
	kind: WK
	/** memo key; -1 = not memoizable (COMMITTED, W0) */
	key: number
	pin: number
	mask: number
	slot: number
	token: number
}

const WORLD_NEWEST: World = { kind: WK.NEWEST, key: 0, pin: 0, mask: 0, slot: -1, token: 0 }
const WORLD_COMMITTED: World = { kind: WK.COMMITTED, key: -1, pin: 0, mask: 0, slot: -1, token: 0 }
const WORLD_W0: World = { kind: WK.W0, key: -1, pin: 0, mask: 0, slot: -1, token: 0 }

// Sentinel boxes (spec §11.3) — policy vocabulary, opaque to the kernel.
export type ErrorBox = { kind: 'error'; error: unknown }
export type SuspendedBox = {
	kind: 'suspended'
	thenable: PromiseLike<unknown>
	/** The node's latest SETTLED value (undefined = uninitialized): pending
	 * forwards downstream while the last good value stays available. */
	latest?: unknown
}
export function isErrorBox(v: unknown): v is ErrorBox {
	return typeof v === 'object' && v !== null && (v as ErrorBox).kind === 'error' && 'error' in v
}
export function isSuspendedBox(v: unknown): v is SuspendedBox {
	return (
		typeof v === 'object' &&
		v !== null &&
		(v as SuspendedBox).kind === 'suspended' &&
		'thenable' in v
	)
}
// Ambient evaluation frame: the FIRST unresolved thenable this evaluation
// encountered (via ctx.use or a pending dep read). Never thrown — evaluation
// continues so every dep registers (parallel fetches, no waterfalls); the
// wrapper folds it into a PENDING result at frame exit. Saved/restored like
// activeSub for nesting.
let evalPending: PromiseLike<unknown> | undefined

/** Is a computed evaluation frame active (canonical or overlay)? Pending dep
 * reads forward inside frames; top-level consumers get the throw/suspend. */
/** §lazy-init: the not-yet-materialized marker occupying a lazy atom's value
 * slots. A unique module singleton: one identity compare on the atom-value
 * base accessors is the entire hot-path cost. */
const LAZY_UNMATERIALIZED: unique symbol = Symbol('cosignals-alt-b.lazy')

let initDepth = 0

/** Run a lazy atom's initializer ONCE: untracked (no dep links), graph-pure
 * (writes rejected in debug), render-safe (a pure slot fill — no write path,
 * no propagation, no watchers; nothing can have observed the atom yet). Both
 * value slots fill with the result, so it is the CANONICAL base state — a
 * draft-world first touch (createTape's base snapshot reads through here)
 * bases the tape on the initializer result, never on draft-scoped state. */
function materializeAtom(a: number): unknown {
	const m = metaCol[a >> 3]
	const init = m?.lazyInit
	if (init === undefined) {
		const v = values[a >> 2]
		if (v === LAZY_UNMATERIALIZED) {
			// Only reachable when the initializer reads its own atom.
			throw new Error('cosignals-alt-b: cyclic lazy initializer (reads its own atom)')
		}
		return v // already materialized (or SSR install landed first)
	}
	m!.lazyInit = undefined // once-only (cleared BEFORE running: cycle guard above)
	const prevSub = activeSub
	activeSub = 0 // untracked: the initializer's own reads link nothing
	++initDepth
	let v: unknown
	try {
		v = init()
	} catch (err) {
		m!.lazyInit = init // a throwing initializer re-runs on the next read (React retry semantics)
		throw err
	} finally {
		--initDepth
		activeSub = prevSub
	}
	values[a >> 2] = v
	values[(a >> 2) + 1] = v
	return v
}

function inEvalFrame(): boolean {
	return ovDepth !== 0 || (activeSub !== 0 && (E.nodeFlags(activeSub) & 2048) !== 0) // C.K_COMPUTED
}

/** Fold an evaluation's outcome with the ambient pending frame: pending is a
 * RESULT (a node-held box carrying the latest settled value), never control
 * flow. Box identity is stable while the thenable and latest are unchanged —
 * that is what React use() retries key on. */
function foldEvalResult(
	prev: unknown,
	next: unknown,
	pend: PromiseLike<unknown> | undefined,
): unknown {
	if (pend !== undefined) {
		const latest = isSuspendedBox(prev) ? prev.latest : isErrorBox(prev) ? undefined : prev
		if (isSuspendedBox(prev) && prev.thenable === pend && Object.is(prev.latest, latest)) {
			return prev
		}
		return { kind: 'suspended', thenable: pend, latest } as SuspendedBox
	}
	return next
}

export type AtomCtx<T> = {
	/** Read current value without registering a dependency. */
	peek(): T
	set(next: T): void
	update(fn: (current: T) => T): void
}

type NodeMeta = {
	label?: string
	isEqual?: (a: unknown, b: unknown) => boolean
	reducer?: (s: unknown, a: unknown) => unknown
	rawFn?: (ctx: ComputedCtxImpl) => unknown
	/** refresh() generation for this node (ctx.refreshEpoch). */
	refreshEpoch?: number
	/** fn declares a ctx parameter (arity > 0): build the ComputedCtx. */
	wantsCtx?: boolean
	/** Lazy state initializer (§lazy-init): pending until first
	 * materialization; cleared once run (or skipped by SSR install). */
	lazyInit?: () => unknown
	// atom observed-lifecycle (§12.4):
	observeEffect?: (ctx: AtomCtx<unknown>) => (() => void) | void
	observeMounted?: boolean
	observeCleanup?: (() => void) | undefined
	observeScheduled?: boolean
	// watchers:
	cb?: (token: number) => void
	watched?: number
	lastBroadcast?: Map<number, unknown>
	seed?: unknown
}

export type ComputedCtxImpl = {
	use<U>(thenable: PromiseLike<U>): U
	previous: unknown
	/** Bumped by refresh(); resource fns key their request cache on
	 * (params, refreshEpoch) so a refresh mints a fresh thenable. */
	refreshEpoch: number
}

// ---- mutable module state (reset by __resetEngineForTests) --------------------

let recNext = 8
let nodeFreeHead = 0
let linkFreeHead = 0

let gNext = 4 // record 0 burned (stride 4)
let gFreeHead = 0

let wNext = 8 // record 0 burned (stride 8)
let certNext = 0

let cycle = 0
let runDepth = 0
let batchDepth = 0
let notifyIndex = 0
let queuedLength = 0
let activeSub = 0
let queued: number[] = []
let pendingFree: number[] = []

let values: unknown[] = [undefined, undefined]
let fns: (Function | undefined)[] = [undefined]
let metaCol: (NodeMeta | undefined)[] = [undefined]
let memoHeads: number[] = [0]
let logVals: unknown[] = [undefined]
let memoVals: unknown[] = []
// Certificate validation cache (parallel to memoVals): the tapeStamp value at
// the memo's last successful validation. tapeStamp increments on EVERY tape
// mutation anywhere (create/append/coalesce/sweep/truncate); if it has not
// moved since a memo's last validation, no certificate pair can have moved
// either, so the scan is skipped — this is the whole cost of a hot read loop
// over a marked cone while a transition is merely HELD OPEN (G-8).
let memoStamp: number[] = []
let tapeStamp = 1
// Fused world-state stamp: increments with EVERY tape mutation AND every
// overlayEpoch bump. A NEWEST-world memo validated at worldStamp X stays the
// right answer while worldStamp === X (nothing that could change any world's
// value has happened). newestStamp[c >> 3] records a computed's last such
// validation; the validated value is cached in the computed's (unused)
// second value slot — one load + one compare + one load for the G-8 loop.
let worldStamp = 1
let newestStamp: number[] = [0]
// Per-atom count of UNAPPLIED tape entries (id >> 3), maintained alongside
// the global unappliedEntries; per-node walk-ticket stamp meaning "an atom
// with unapplied entries is below me" (fresh iff > eraFloor). Newest-world
// reads of a cone with NO unapplied entries below keep the kernel's
// exact-pull-count path — the §17.5(b) invisibility property: an unrelated
// live deferred batch must not change this cone's evaluation counts.
let unappliedCount: number[] = [0]
let unappliedStamp: number[] = [0]
// §8.6 liveness as a per-node LIVE-SUBSCRIBER REFCOUNT (Preact pattern),
// kept OUT of the kernel-rewritten flags word (dispose zeroes flags; a bit
// there dies with them). live(n) := liveCount > 0 || born-live kind
// (effect/scope/watcher). Cascades run ONLY on 0-crossings.
let liveCount: number[] = [0]

let propStack = new Int32Array(4096)
let propSp = 0
let checkStack = new Int32Array(4096)
let checkSp = 0
let certStack = new Int32Array(4096)
let certSp = 0

// Overlay scalars (spec §7.6).
let batchTokenTab = new Int32Array(32)
let batchEntryCount = new Int32Array(32)
let slotRetired = new Int32Array(32)
let slotMemoHead = new Int32Array(32)
let liveSlotMask = 0
let liveDeferredMask = 0
let unappliedEntries = 0
let loggedAtomCount = 0
let seqCounter = 1
let walkCounter = 0
let eraFloor = 0
let overlayEpoch = 1
let lastToken = 0
let lastSlot = -1
let pseudoFallbacks = 0

const enum Mode {
	DIRECT = 0,
	LOGGED = 1,
}
let writeMode: Mode = Mode.DIRECT

// Pass set.
let passOpen = 0
let passSerial = 0
let passPin = 0
let passIncludeMask = 0
let passContainer: Container = undefined
let passLineage = 0
let currentCtx: Ctx = Ctx.NEWEST

let loggedAtoms: number[] = []
// Node registry for the walk-counter wrap safety valve and the invariant
// verifier. A record allocated as a node is never reused as a link (separate
// free lists), so this list stays accurate; freed nodes have FLAGS 0 and are
// skipped.
let nodeIds: number[] = []
let broadcastQueue: number[] = [] // stride-2 (watcherId, token)
let broadcastLen = 0
let bcScratch: number[] = [] // drain-local copy (persistent, alloc-free)
let pendingWalks: number[] = [] // stride-2 (atomId, token)
let drainUrgent = false
let drainDirtySlots = 0
let drainDepth = 0

// Overlay evaluation context.
let ovWorld: World | undefined
let ovDepth = 0

// ---- tracer slot (§16.1) -------------------------------------------------------
// `cosignal/tracing` installs a packed recorder here; unloaded cost is one
// `tracer !== undefined` check per emit site. Kinds are a same-file const
// enum (§15.1); KIND_NAMES is the decoder's runtime mirror.

const enum TK {
	ATOM_WRITE = 1,
	LOG_APPEND = 2,
	LOG_COALESCE = 3,
	TRUNCATE = 4,
	BATCH_RETIRED = 5,
	ABSORB = 6,
	COMPUTED_EVAL = 7,
	NOTIFY_WALK = 8,
	BROADCAST = 9,
	PASS_START = 10,
	PASS_END = 11,
	QUIESCENCE = 12,
	TRUNCATION_MARKER = 13,
	CLOCK_SYNC = 14,
}

export const KIND_NAMES: Record<number, string> = {
	1: 'atom-write',
	2: 'log-append',
	3: 'log-coalesce',
	4: 'truncate',
	5: 'batch-retired',
	6: 'absorb',
	7: 'computed-eval',
	8: 'notify-walk',
	9: 'broadcast',
	10: 'render-pass-start',
	11: 'render-pass-end',
	12: 'quiescence',
	13: 'truncation-marker',
	14: 'clock-sync',
}

export type Tracer = {
	emit(
		kind: number,
		cause: number,
		node: number,
		world: number,
		a0: number,
		a1: number,
		a2: number,
	): number
}

let tracer: Tracer | undefined
let currentCause = 0

export function __setTracer(t: Tracer | undefined): void {
	tracer = t
	currentCause = 0
}

// Per-root committed view scope (§13.4), set by the bindings around reads
// and effect runs; refines Ctx.COMMITTED resolution.
let rootCommittedActive = false
let rootCommittedPin = 0
let rootCommittedMask = 0
// Read capture for useSignalEffect dependency tracking (bindings-only).
let captureList: number[] | undefined

/** True iff render code is executing RIGHT NOW. The real fork parks
 * suspended work with its pass frame open and emits NO yield event (a §6.3
 * deviation of the build we ship against), so an open pass alone does not
 * mean rendering: consult the fork's render context, but only when the
 * event-driven scalar says RENDER (zero cost otherwise). */
function forkRenderingNow(): boolean {
	return fork === undefined || fork.getRenderContext() !== undefined
}

/** The effective read context: RENDER downgraded to NEWEST inside the real
 * fork's suspension gaps (open pass, not executing). */
function ctxNow(): Ctx {
	if (currentCtx === Ctx.RENDER && !forkRenderingNow()) {
		return Ctx.NEWEST
	}
	return currentCtx
}

// Optional drain trace (debugging aid; see __debug.startTrace).
let traceLog: string[] | undefined

function trace(msg: string): void {
	if (traceLog !== undefined) {
		traceLog.push(msg)
	}
}

// Bridge / config.
let fork: ForkLike | undefined
let unsubscribeFork: (() => void) | undefined
let strictLanes = false
let forbidWritesInComputeds = false
// §12.2 purity contract: >0 while an updater/reducer replays; debug builds
// trip on any signal read inside that window.
let replayDepth = 0
let debugChecks = true
// §14.2 FinalizationRegistry — ON BY DEFAULT ("we should never leak"):
// dropped atom/computed handles are reclaimed once GC proves them
// unreachable. configure({ finalization: false }) opts out (zero FR
// overhead, accepting the bounded per-record leak for dropped handles).
// heldValue is the packed number gen * 2^32 + id (exact while gen < 2^21);
// the allocating {id, gen} form is the overflow fallback.
let finalizationEnabled = true
let finalizationRegistry: FinalizationRegistry<number | { id: number; gen: number }> | undefined
// GC-driven reclaims that hit a guard (live subscribers / live tape) are
// recorded here and retried when the blocking reference drops — the
// registry fires exactly once per handle, so a skipped callback would
// otherwise leak the record forever. id → gen.
const finalizeSkipped = new Map<number, number>()
// ids whose blocking condition just cleared; drained at boundary().
const finalizeRetry: number[] = []
// Live watcher registry: lastBroadcast baselines are keyed by batch token
// and tokens are minted fresh per batch — prune dead-token keys at
// retirement/quiescence or a long-lived watcher's Map grows (pinning one
// value) per batch forever.
const liveWatcherIds = new Set<number>()

let cfgInitialRecords = 8192
let cfgInitialLogRecords = 1024
let cfgInitialMemoRecords = 1024

// Thenable protocol state (module-level: survives engine rebuilds).
type ThenableState = {
	status: 'pending' | 'fulfilled' | 'rejected'
	value?: unknown
	reason?: unknown
	waiters: Set<number>
}
const thenableStates = new WeakMap<PromiseLike<unknown>, ThenableState>()

// §14.1 growth machinery: allocators inside the engine closure flag
// growPending when a bump pointer crosses its plane's watermark; boundary()
// rebuilds the closure over doubled buffers only when no engine frame that
// captured the old buffers is live (enterDepth === 0).
let growPending = false
let enterDepth = 0
// ==== §14.1: the engine core — one closure over const plane buffers ============
// TurboFan-friendly growth (donor discipline): buffers are closure constants;
// growth rebuilds this closure over doubled buffers at an operation boundary
// and swaps the single module-level `E` reference. Allocators flag growth at
// the watermark and throw if a single operation out-allocates the slack.
function createEngineCore(M: Int32Array, G: Int32Array, W: Int32Array, CERT: Int32Array) {
	const WM_M = Math.min(M.length >> 1, M.length - C.REC_SLACK * 8)
	const WM_G = Math.min(G.length >> 1, G.length - 256 * 4)
	const WM_W = Math.min(W.length >> 1, W.length - 256 * 8)
	const WM_CERT = Math.min(CERT.length >> 1, CERT.length - 4096)
	if (recNext > WM_M || gNext > WM_G || wNext > WM_W || certNext > WM_CERT) {
		growPending = true
	}

	// ---- allocation -----------------------------------------------------------------

	function allocNode(flags: number): number {
		let id: number
		if (nodeFreeHead !== 0) {
			id = nodeFreeHead
			nodeFreeHead = M[id + C.DEPS]
			M[id + C.DEPS] = 0
		} else {
			if (recNext >= M.length) {
				throw new Error('cosignals-alt-b: main plane exhausted mid-operation; raise initialRecords')
			}
			id = recNext
			recNext = id + 8
			nodeIds.push(id)
			if (recNext > WM_M) {
				growPending = true
			}
		}
		M[id + C.FLAGS] = flags
		const v = id >> 2
		while (values.length <= v + 1) {
			values.push(undefined)
		}
		const r = id >> 3
		while (fns.length <= r) {
			fns.push(undefined)
		}
		while (metaCol.length <= r) {
			metaCol.push(undefined)
		}
		while (memoHeads.length <= r) {
			memoHeads.push(0)
		}
		while (newestStamp.length <= r) {
			newestStamp.push(0)
		}
		while (unappliedCount.length <= r) {
			unappliedCount.push(0)
		}
		while (unappliedStamp.length <= r) {
			unappliedStamp.push(0)
		}
		while (liveCount.length <= r) {
			liveCount.push(0)
		}
		return id
	}

	function freeNode(id: number): void {
		M[id + C.FLAGS] = 0
		M[id + C.DEPS_TAIL] = 0
		M[id + C.SUBS] = 0
		M[id + C.SUBS_TAIL] = 0
		M[id + C.LOG_HEAD] = 0
		M[id + C.LOG_TAIL] = 0
		++M[id + C.GEN]
		const v = id >> 2
		values[v] = undefined
		values[v + 1] = undefined
		fns[id >> 3] = undefined
		metaCol[id >> 3] = undefined
		// Tombstone the node's world memos BEFORE dropping the chain head: slot
		// chains still reference these records (skipped once epoch is 0), and
		// their memoVals slots must not pin the dead node's values until the
		// next quiescence reset.
		let mrec = memoHeads[id >> 3]
		while (mrec !== 0 && mrec < wNext && W[mrec + C.W_NODE] === id) {
			W[mrec + C.W_EPOCH] = 0
			memoVals[W[mrec + C.W_VAL]] = undefined
			mrec = W[mrec + C.W_NEXT_MEMO]
		}
		memoHeads[id >> 3] = 0
		newestStamp[id >> 3] = 0
		unappliedCount[id >> 3] = 0
		unappliedStamp[id >> 3] = 0
		liveCount[id >> 3] = 0
		if (finalizeSkipped.size !== 0) {
			finalizeSkipped.delete(id)
		}
		M[id + C.DEPS] = nodeFreeHead
		nodeFreeHead = id
	}

	function sweepPendingFree(): void {
		if (queuedLength !== 0 || notifyIndex !== 0) {
			return // queue may still hold ids
		}
		for (let i = 0; i < pendingFree.length; ++i) {
			freeNode(pendingFree[i])
		}
		pendingFree.length = 0
	}

	function allocLink(): number {
		let id: number
		if (linkFreeHead !== 0) {
			id = linkFreeHead
			linkFreeHead = M[id + C.NEXT_DEP]
		} else {
			if (recNext >= M.length) {
				throw new Error('cosignals-alt-b: main plane exhausted mid-operation; raise initialRecords')
			}
			id = recNext
			recNext = id + 8
			if (recNext > WM_M) {
				growPending = true
			}
		}
		return id
	}

	function freeLink(id: number): void {
		M[id + C.NEXT_DEP] = linkFreeHead
		linkFreeHead = id
	}

	/** Log-plane allocation (§8.7.5). */
	function allocLog(): number {
		let id: number
		if (gFreeHead !== 0) {
			id = gFreeHead
			gFreeHead = G[id + C.L_NEXT]
		} else {
			if (gNext >= G.length) {
				throw new Error(
					'cosignals-alt-b: log plane exhausted mid-operation; raise initialLogRecords',
				)
			}
			id = gNext
			gNext = id + 4
			if (gNext > WM_G) {
				growPending = true
			}
		}
		G[id + C.L_NEXT] = 0
		const r = id >> 2
		while (logVals.length <= r) {
			logVals.push(undefined)
		}
		return id
	}

	function freeLogRec(id: number): void {
		logVals[id >> 2] = undefined
		G[id + C.L_META] = 0
		G[id + C.L_SEQ] = 0
		G[id + C.L_RETIRED_SEQ] = 0
		G[id + C.L_NEXT] = gFreeHead
		gFreeHead = id
	}

	function allocMemo(): number {
		if (wNext >= W.length) {
			throw new Error(
				'cosignals-alt-b: memo plane exhausted mid-operation; raise initialMemoRecords',
			)
		}
		const id = wNext
		wNext = id + 8
		if (wNext > WM_W) {
			growPending = true
		}
		return id
	}

	// ---- kernel: topology (donor transliteration + §8.7.3 mark repair) --------------

	function link(dep: number, sub: number, version: number): void {
		const prevDep = M[sub + C.DEPS_TAIL]
		if (prevDep !== 0 && M[prevDep + C.DEP] === dep) {
			return
		}
		const nextDep = prevDep !== 0 ? M[prevDep + C.NEXT_DEP] : M[sub + C.DEPS]
		if (nextDep !== 0 && M[nextDep + C.DEP] === dep) {
			M[nextDep + C.VERSION] = version
			M[sub + C.DEPS_TAIL] = nextDep
			return
		}
		linkInsert(dep, sub, version, prevDep, nextDep)
	}

	// Out-of-line insertion tail (donor discipline). The overlay's mark repair
	// (§8.7.3) lives HERE, never in link().
	function linkInsert(
		dep: number,
		sub: number,
		version: number,
		prevDep: number,
		nextDep: number,
	): void {
		const prevSub = M[dep + C.SUBS_TAIL]
		if (prevSub !== 0 && M[prevSub + C.VERSION] === version && M[prevSub + C.SUB] === sub) {
			return
		}
		const newLink = allocLink()
		M[sub + C.DEPS_TAIL] = newLink
		M[dep + C.SUBS_TAIL] = newLink
		M[newLink + C.VERSION] = version
		M[newLink + C.DEP] = dep
		M[newLink + C.SUB] = sub
		M[newLink + C.PREV_DEP] = prevDep
		M[newLink + C.NEXT_DEP] = nextDep
		M[newLink + C.PREV_SUB] = prevSub
		M[newLink + C.NEXT_SUB] = 0
		if (nextDep !== 0) {
			M[nextDep + C.PREV_DEP] = newLink
		}
		if (prevDep !== 0) {
			M[prevDep + C.NEXT_DEP] = newLink
		} else {
			M[sub + C.DEPS] = newLink
		}
		if (prevSub !== 0) {
			M[prevSub + C.NEXT_SUB] = newLink
		} else {
			M[dep + C.SUBS] = newLink
		}
		// Liveness (§8.6): a new edge from a live consumer retains the producer;
		// the cascade below runs only on the producer's own 0→1 crossing.
		if (isLiveNode(sub)) {
			liveRetain(dep)
		}
		// Mark repair (§8.7.3): if the overlay is live and the new producer is
		// marked (or is a LOGGED atom), stamp the consumer's cone with the current
		// walk ticket so the mark invariant holds for mid-era new edges.
		if (loggedAtomCount !== 0) {
			const depFlags = M[dep + C.FLAGS]
			const isAtom = (depFlags & C.K_ATOM) !== 0
			const depMarked =
				(depFlags & C.LOGGED) !== 0 || (!isAtom && M[dep + C.OVERLAY_STAMP] > eraFloor)
			const depUnapplied = isAtom
				? unappliedCount[dep >> 3] > 0
				: unappliedStamp[dep >> 3] > eraFloor
			if (
				(depMarked && M[sub + C.OVERLAY_STAMP] <= eraFloor) ||
				(depUnapplied && unappliedStamp[sub >> 3] <= eraFloor)
			) {
				markCone(sub, walkCounter === eraFloor ? ++walkCounter : walkCounter, depUnapplied)
			}
		}
	}

	/** §8.6 — liveness refcount. Born-live kinds (effects, scopes, watchers)
	 * never cross; everything else is live iff some live subscriber holds it. */
	function isLiveNode(n: number): boolean {
		return liveCount[n >> 3] > 0 || (M[n + C.FLAGS] & (C.K_EFFECT | C.K_SCOPE | C.K_WATCHER)) !== 0
	}

	/** A live subscriber attached to `start`: increment, cascade on 0→1. */
	function liveRetain(start: number): void {
		const stackBase = propSp
		let n = start
		do {
			if (
				++liveCount[n >> 3] === 1 &&
				(M[n + C.FLAGS] & (C.K_EFFECT | C.K_SCOPE | C.K_WATCHER)) === 0
			) {
				onLiveChanged(n)
				let l = M[n + C.DEPS]
				while (l !== 0) {
					if (propSp === propStack.length) {
						const bigger = new Int32Array(propStack.length * 2)
						bigger.set(propStack)
						propStack = bigger
					}
					propStack[propSp++] = M[l + C.DEP]
					l = M[l + C.NEXT_DEP]
				}
			}
			n = propSp > stackBase ? propStack[--propSp] : 0
		} while (n !== 0)
		propSp = stackBase
	}

	/** A live subscriber detached from `start`: decrement, cascade on 1→0. */
	function liveRelease(start: number): void {
		const stackBase = propSp
		let n = start
		do {
			if (
				--liveCount[n >> 3] === 0 &&
				(M[n + C.FLAGS] & (C.K_EFFECT | C.K_SCOPE | C.K_WATCHER)) === 0
			) {
				onLiveChanged(n)
				let l = M[n + C.DEPS]
				while (l !== 0) {
					if (propSp === propStack.length) {
						const bigger = new Int32Array(propStack.length * 2)
						bigger.set(propStack)
						propStack = bigger
					}
					propStack[propSp++] = M[l + C.DEP]
					l = M[l + C.NEXT_DEP]
				}
			}
			n = propSp > stackBase ? propStack[--propSp] : 0
		} while (n !== 0)
		propSp = stackBase
	}

	/** §12.4 — atom observed-lifecycle: LIVE transitions on atoms carrying an
	 * observeEffect schedule a microtask-debounced reconcile, so an
	 * observe/unobserve flap within one tick nets to no churn. */
	function onLiveChanged(node: number): void {
		const m = metaCol[node >> 3]
		if (m !== undefined && m.observeEffect !== undefined) {
			scheduleObserveReconcile(node, m)
		}
	}

	/** Stamp `node` and its transitive subscribers with `ticket` (mark-only);
	 * optionally flow the unapplied-cone stamp too (§17.5(b) precision). */
	function markCone(node: number, ticket: number, unapplied = false): void {
		const stackBase = propSp
		let cur = node
		do {
			if (
				(M[cur + C.OVERLAY_STAMP] !== ticket ||
					(unapplied && unappliedStamp[cur >> 3] !== ticket)) &&
				(M[cur + C.FLAGS] & C.K_ATOM) === 0
			) {
				M[cur + C.OVERLAY_STAMP] = ticket
				if (unapplied) {
					unappliedStamp[cur >> 3] = ticket
				}
				let l = M[cur + C.SUBS]
				while (l !== 0) {
					if (propSp === propStack.length) {
						const bigger = new Int32Array(propStack.length * 2)
						bigger.set(propStack)
						propStack = bigger
					}
					propStack[propSp++] = M[l + C.SUB]
					l = M[l + C.NEXT_SUB]
				}
			}
			cur = propSp > stackBase ? propStack[--propSp] : 0
		} while (cur !== 0)
		propSp = stackBase
	}

	function unlink(id: number, sub = M[id + C.SUB], subLive = isLiveNode(sub)): number {
		const dep = M[id + C.DEP]
		const prevDep = M[id + C.PREV_DEP]
		const nextDep = M[id + C.NEXT_DEP]
		const nextSub = M[id + C.NEXT_SUB]
		const prevSub = M[id + C.PREV_SUB]
		if (nextDep !== 0) {
			M[nextDep + C.PREV_DEP] = prevDep
		} else {
			M[sub + C.DEPS_TAIL] = prevDep
		}
		if (prevDep !== 0) {
			M[prevDep + C.NEXT_DEP] = nextDep
		} else {
			M[sub + C.DEPS] = nextDep
		}
		if (nextSub !== 0) {
			M[nextSub + C.PREV_SUB] = prevSub
		} else {
			M[dep + C.SUBS_TAIL] = prevSub
		}
		freeLink(id)
		// Liveness (§8.6): release BEFORE unwatched can restructure dep's lists.
		if (subLive) {
			liveRelease(dep)
		}
		if (prevSub !== 0) {
			M[prevSub + C.NEXT_SUB] = nextSub
		} else if ((M[dep + C.SUBS] = nextSub) === 0) {
			unwatched(dep)
		}
		return nextDep
	}

	// ---- kernel: traversals ----------------------------------------------------------

	function pushBroadcast(watcher: number, token: number): void {
		if (broadcastLen + 2 > broadcastQueue.length) {
			broadcastQueue.length = broadcastLen + 2
		}
		broadcastQueue[broadcastLen] = watcher
		broadcastQueue[broadcastLen + 1] = token
		broadcastLen += 2
	}

	function propagate(startLink: number, innerWrite: boolean): void {
		let cur = startLink
		let next = M[cur + C.NEXT_SUB]
		const stackBase = propSp

		top: do {
			const sub = M[cur + C.SUB]
			let flags = M[sub + C.FLAGS]

			if (!(flags & (C.RECURSED_CHECK | C.RECURSED | C.DIRTY | C.PENDING))) {
				M[sub + C.FLAGS] = flags | C.PENDING
				if (innerWrite) {
					M[sub + C.FLAGS] |= C.RECURSED
				}
			} else if (!(flags & (C.RECURSED_CHECK | C.RECURSED))) {
				flags = 0
			} else if (!(flags & C.RECURSED_CHECK)) {
				M[sub + C.FLAGS] = (flags & ~C.RECURSED) | C.PENDING
			} else if (!(flags & (C.DIRTY | C.PENDING)) && isValidLink(cur, sub)) {
				M[sub + C.FLAGS] = flags | (C.RECURSED | C.PENDING)
				flags &= C.MUTABLE
			} else {
				flags = 0
			}

			if (flags & C.WATCHING) {
				if (flags & C.IMMEDIATE) {
					pushBroadcast(sub, 0) // §8.7.1: propagate pushes token 0 (urgent)
				} else {
					notify(sub)
				}
			}

			if (flags & C.MUTABLE) {
				const subSubs = M[sub + C.SUBS]
				if (subSubs !== 0) {
					cur = subSubs
					const nextSub = M[cur + C.NEXT_SUB]
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
				next = M[cur + C.NEXT_SUB]
				continue
			}

			while (propSp > stackBase) {
				cur = propStack[--propSp]
				if (cur !== 0) {
					next = M[cur + C.NEXT_SUB]
					continue top
				}
			}

			break
		} while (true)
	}

	function checkDirty(startLink: number, startSub: number): boolean {
		let cur = startLink
		let sub = startSub
		const stackBase = checkSp
		let checkDepth = 0
		let dirty = false

		try {
			top: do {
				const dep = M[cur + C.DEP]
				const depFlags = M[dep + C.FLAGS]

				if (M[sub + C.FLAGS] & C.DIRTY) {
					dirty = true
				} else if ((depFlags & (C.MUTABLE | C.DIRTY)) === (C.MUTABLE | C.DIRTY)) {
					const depSubs = M[dep + C.SUBS]
					if (update(dep)) {
						if (M[depSubs + C.NEXT_SUB] !== 0) {
							shallowPropagate(depSubs)
						}
						dirty = true
					}
				} else if ((depFlags & (C.MUTABLE | C.PENDING)) === (C.MUTABLE | C.PENDING)) {
					if (checkSp === checkStack.length) {
						const bigger = new Int32Array(checkStack.length * 2)
						bigger.set(checkStack)
						checkStack = bigger
					}
					checkStack[checkSp++] = cur
					cur = M[dep + C.DEPS]
					sub = dep
					++checkDepth
					continue
				}

				if (!dirty) {
					const nextDep = M[cur + C.NEXT_DEP]
					if (nextDep !== 0) {
						cur = nextDep
						continue
					}
				}

				while (checkDepth--) {
					cur = checkStack[--checkSp]
					if (dirty) {
						const subSubs = M[sub + C.SUBS]
						if (update(sub)) {
							if (M[subSubs + C.NEXT_SUB] !== 0) {
								shallowPropagate(subSubs)
							}
							sub = M[cur + C.SUB]
							continue
						}
						dirty = false
					} else {
						M[sub + C.FLAGS] &= ~C.PENDING
					}
					sub = M[cur + C.SUB]
					const nextDep = M[cur + C.NEXT_DEP]
					if (nextDep !== 0) {
						cur = nextDep
						continue top
					}
				}

				return dirty && M[sub + C.FLAGS] !== 0
			} while (true)
		} finally {
			checkSp = stackBase
		}
	}

	function shallowPropagate(startLink: number): void {
		let cur = startLink
		do {
			const sub = M[cur + C.SUB]
			const flags = M[sub + C.FLAGS]
			if ((flags & (C.PENDING | C.DIRTY)) === C.PENDING) {
				M[sub + C.FLAGS] = flags | C.DIRTY
				if ((flags & (C.WATCHING | C.RECURSED_CHECK)) === C.WATCHING) {
					if (flags & C.IMMEDIATE) {
						pushBroadcast(sub, 0)
					} else {
						notify(sub)
					}
				}
			}
		} while ((cur = M[cur + C.NEXT_SUB]) !== 0)
	}

	function isValidLink(checkLink: number, sub: number): boolean {
		let cur = M[sub + C.DEPS_TAIL]
		while (cur !== 0) {
			if (cur === checkLink) {
				return true
			}
			cur = M[cur + C.PREV_DEP]
		}
		return false
	}

	/** §8.7.2 — notify walk: stamp overlay marks; optionally collect IMMEDIATE
	 * watchers onto the broadcast queue tagged with the write's token. */
	function notifyWalk(atom: number, ticket: number, token: number, collect: boolean): void {
		if (tracer !== undefined) {
			tracer.emit(TK.NOTIFY_WALK, currentCause, atom, token, ticket, collect ? 1 : 0, 0)
		}
		// Deferred (unapplied) writes additionally stamp the unapplied-cone mark:
		// only cones below unapplied entries need overlay resolution for NEWEST.
		const unapplied = (token & 1) === 1
		const stackBase = propSp
		let l = M[atom + C.SUBS]
		while (l !== 0) {
			if (propSp === propStack.length) {
				const bigger = new Int32Array(propStack.length * 2)
				bigger.set(propStack)
				propStack = bigger
			}
			propStack[propSp++] = M[l + C.SUB]
			l = M[l + C.NEXT_SUB]
		}
		while (propSp > stackBase) {
			const node = propStack[--propSp]
			if (
				M[node + C.OVERLAY_STAMP] === ticket &&
				(!unapplied || unappliedStamp[node >> 3] === ticket)
			) {
				continue // already visited by THIS walk (diamond dedup)
			}
			M[node + C.OVERLAY_STAMP] = ticket
			if (unapplied) {
				unappliedStamp[node >> 3] = ticket
			}
			const flags = M[node + C.FLAGS]
			if (collect && flags & C.IMMEDIATE) {
				pushBroadcast(node, token)
			}
			let sl = M[node + C.SUBS]
			while (sl !== 0) {
				if (propSp === propStack.length) {
					const bigger = new Int32Array(propStack.length * 2)
					bigger.set(propStack)
					propStack = bigger
				}
				propStack[propSp++] = M[sl + C.SUB]
				sl = M[sl + C.NEXT_SUB]
			}
		}
		propSp = stackBase
	}

	// ---- kernel: scheduling, update, dispose -----------------------------------------

	function update(node: number): boolean {
		const flags = M[node + C.FLAGS]
		if (flags & C.K_COMPUTED) {
			return updateComputed(node)
		}
		if (flags & C.K_ATOM) {
			return updateAtom(node)
		}
		M[node + C.FLAGS] = (flags & C.KIND_MASK) | C.MUTABLE
		return true
	}

	function notify(e: number): void {
		let insertIndex = queuedLength
		const firstInsertedIndex = insertIndex

		do {
			queued[insertIndex++] = e
			M[e + C.FLAGS] &= ~C.WATCHING
			const subs = M[e + C.SUBS]
			e = subs !== 0 ? M[subs + C.SUB] : 0
			if (e === 0 || !(M[e + C.FLAGS] & C.WATCHING) || M[e + C.FLAGS] & C.IMMEDIATE) {
				break
			}
		} while (true)

		queuedLength = insertIndex

		let left = firstInsertedIndex
		while (left < --insertIndex) {
			const tmp = queued[left]
			queued[left++] = queued[insertIndex]
			queued[insertIndex] = tmp
		}
	}

	function unwatched(node: number): void {
		const flags = M[node + C.FLAGS]
		if (flags & C.K_COMPUTED) {
			if (M[node + C.DEPS_TAIL] !== 0) {
				M[node + C.FLAGS] = C.K_COMPUTED | C.MUTABLE | C.DIRTY
				disposeAllDepsInReverse(node)
			}
			noteReclaimRetry(node) // last subscriber gone: retry a GC-skipped reclaim
		} else if (flags & C.K_ATOM) {
			noteReclaimRetry(node) // last subscriber gone: retry a GC-skipped reclaim
		} else if (flags & (C.K_EFFECT | C.K_SCOPE)) {
			dispose(node)
		}
	}

	function unlinkChildEffects(sub: number): void {
		let cur = M[sub + C.DEPS_TAIL]
		while (cur !== 0) {
			const prev = M[cur + C.PREV_DEP]
			const dep = M[cur + C.DEP]
			if (!(M[dep + C.FLAGS] & (C.K_COMPUTED | C.K_ATOM))) {
				unlink(cur, sub)
			}
			cur = prev
		}
	}

	function updateComputed(c: number): boolean {
		if (M[c + C.FLAGS] & C.HAS_CHILD_EFFECT) {
			unlinkChildEffects(c)
		}
		M[c + C.DEPS_TAIL] = 0
		const stamp = M[c + C.OVERLAY_STAMP]
		M[c + C.FLAGS] = C.K_COMPUTED | C.MUTABLE | C.RECURSED_CHECK
		M[c + C.OVERLAY_STAMP] = stamp
		const prevSub = activeSub
		activeSub = c
		++enterDepth // user fn below: no closure rebuild while this frame lives
		try {
			++cycle
			const v = c >> 2
			const oldValue = values[v]
			return (
				oldValue !== (values[v] = (fns[c >> 3] as (previousValue?: unknown) => unknown)(oldValue))
			)
		} finally {
			--enterDepth
			activeSub = prevSub
			M[c + C.FLAGS] &= ~C.RECURSED_CHECK
			purgeDeps(c)
		}
	}

	function updateAtom(s: number): boolean {
		const flags = M[s + C.FLAGS]
		M[s + C.FLAGS] = flags & ~(C.DIRTY | C.PENDING)
		const v = s >> 2
		return values[v] !== (values[v] = values[v + 1])
	}

	function run(e: number): void {
		const flags = M[e + C.FLAGS]
		if (flags & C.DIRTY || (flags & C.PENDING && checkDirty(M[e + C.DEPS], e))) {
			if (flags & C.HAS_CHILD_EFFECT) {
				unlinkChildEffects(e)
			}
			const cv = (e >> 2) + 1
			if (values[cv]) {
				runCleanup(e)
				if (M[e + C.FLAGS] === 0) {
					return // disposed by its own cleanup
				}
			}
			M[e + C.DEPS_TAIL] = 0
			const stamp = M[e + C.OVERLAY_STAMP]
			M[e + C.FLAGS] = C.K_EFFECT | C.WATCHING | C.RECURSED_CHECK
			M[e + C.OVERLAY_STAMP] = stamp
			const prevSub = activeSub
			activeSub = e
			++enterDepth
			try {
				++cycle
				++runDepth
				values[cv] = (fns[e >> 3] as () => (() => void) | void)()
			} finally {
				--enterDepth
				--runDepth
				activeSub = prevSub
				M[e + C.FLAGS] &= ~C.RECURSED_CHECK
				purgeDeps(e)
			}
		} else if (M[e + C.DEPS] !== 0) {
			M[e + C.FLAGS] = C.K_EFFECT | C.WATCHING | (flags & C.HAS_CHILD_EFFECT)
		}
	}

	function requeueAbort(e: number): void {
		if (M[e + C.FLAGS] & C.KIND_MASK) {
			M[e + C.FLAGS] |= C.WATCHING | C.RECURSED
		}
	}

	function runCleanup(e: number): void {
		const cv = (e >> 2) + 1
		const cleanup = values[cv] as () => void
		values[cv] = undefined
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

	function dispose(e: number): void {
		const flags = M[e + C.FLAGS]
		if (!(flags & C.KIND_MASK)) {
			return
		}
		if (flags & C.K_WATCHER) {
			liveWatcherIds.delete(e)
		}
		// Capture liveness from the still-valid flags: zeroing them first (the
		// donor's re-entrancy defense) would otherwise make every disposing
		// effect/watcher look dead and leak its deps' refcounts.
		const wasLive = liveCount[e >> 3] > 0 || (flags & (C.K_EFFECT | C.K_SCOPE | C.K_WATCHER)) !== 0
		M[e + C.FLAGS] = 0
		disposeAllDepsInReverse(e, wasLive)
		const sub = M[e + C.SUBS]
		if (sub !== 0) {
			unlink(sub)
		}
		if (flags & C.K_EFFECT && values[(e >> 2) + 1]) {
			runCleanup(e)
		}
		pendingFree.push(e)
	}

	function disposeAllDepsInReverse(sub: number, subLive = isLiveNode(sub)): void {
		let cur = M[sub + C.DEPS_TAIL]
		while (cur !== 0) {
			const prev = M[cur + C.PREV_DEP]
			unlink(cur, sub, subLive)
			cur = prev
		}
	}

	function purgeDeps(sub: number): void {
		const depsTail = M[sub + C.DEPS_TAIL]
		let dep = depsTail !== 0 ? M[depsTail + C.NEXT_DEP] : M[sub + C.DEPS]
		while (dep !== 0) {
			dep = unlink(dep, sub)
		}
	}

	function flush(): void {
		sweepPendingFree()
		try {
			while (notifyIndex < queuedLength) {
				const e = queued[notifyIndex]
				queued[notifyIndex++] = 0
				run(e)
			}
		} finally {
			while (notifyIndex < queuedLength) {
				const e = queued[notifyIndex]
				queued[notifyIndex++] = 0
				requeueAbort(e)
			}
			notifyIndex = 0
			queuedLength = 0
		}
	}

	/** §8.7.4 — invalidate: set DIRTY, propagate, queue notifications. */
	function invalidate(id: number): void {
		M[id + C.FLAGS] |= C.DIRTY
		const subs = M[id + C.SUBS]
		if (subs !== 0) {
			propagate(subs, runDepth !== 0)
		}
	}

	// ---- M2: seq tickets, batch slots, tape lifecycle (spec §9) ----------------------

	function ticket(): number {
		return ++seqCounter
	}

	/** §9.2 — intern a fork token into a batch slot (0-31); -1 = exhausted. */
	function internSlot(token: number): number {
		if (token === lastToken && lastSlot >= 0 && batchTokenTab[lastSlot] === token) {
			return lastSlot
		}
		for (let s = 0; s < 32; ++s) {
			if (batchTokenTab[s] === token) {
				lastToken = token
				lastSlot = s
				return s
			}
		}
		for (let s = 0; s < 32; ++s) {
			if (batchTokenTab[s] === 0) {
				batchTokenTab[s] = token
				batchEntryCount[s] = 0
				slotRetired[s] = 0
				slotMemoHead[s] = 0
				liveSlotMask |= 1 << s
				if (token & 1) {
					liveDeferredMask |= 1 << s
				}
				lastToken = token
				lastSlot = s
				return s
			}
		}
		++pseudoFallbacks // §9.2 defensive fallback
		return -1
	}

	function slotOfToken(token: number): number {
		for (let s = 0; s < 32; ++s) {
			if (batchTokenTab[s] === token) {
				return s
			}
		}
		return -1
	}

	function releaseSlot(s: number): void {
		// Drop writer's-world memos whose key names the dead batch (§9.6).
		let rec = slotMemoHead[s]
		while (rec > 0) {
			const next = W[rec + C.W_SLOT_NEXT]
			W[rec + C.W_EPOCH] = 0
			memoVals[W[rec + C.W_VAL]] = undefined
			W[rec + C.W_SLOT_NEXT] = -1
			rec = next
		}
		slotMemoHead[s] = 0
		batchTokenTab[s] = 0
		batchEntryCount[s] = 0
		slotRetired[s] = 0
		liveSlotMask &= ~(1 << s)
		liveDeferredMask &= ~(1 << s)
		if (lastSlot === s) {
			lastToken = 0
			lastSlot = -1
		}
	}

	/** §9.3 — first entry: create the tape (base record) and mark the cone,
	 * flowing the unapplied-cone stamp when the creating write is deferred. */
	function createTape(a: number, unapplied: boolean): void {
		const base = allocLog()
		const t = ticket()
		G[base + C.L_META] = C.OP_BASE | C.F_RETIRED
		G[base + C.L_SEQ] = t
		G[base + C.L_RETIRED_SEQ] = t
		logVals[base >> 2] = pendingAtomValue(a) // snapshot newest kernel value (no promotion)
		M[a + C.LOG_HEAD] = base
		M[a + C.LOG_TAIL] = base
		M[a + C.FLAGS] |= C.LOGGED
		++tapeStamp
		++worldStamp
		loggedAtoms.push(a)
		++loggedAtomCount
		// Mark-only walk, unconditionally, whatever the write's classification;
		// token bit 0 carries the unapplied flow (no collection either way).
		notifyWalk(a, ++walkCounter, unapplied ? 1 : 0, false)
	}

	function appendLogRec(
		a: number,
		op: number,
		slot: number,
		payload: unknown,
		applied: boolean,
	): number {
		const rec = allocLog()
		let meta = op | (applied ? C.F_APPLIED : 0)
		if (slot >= 0) {
			meta |= slot << C.SLOT_SHIFT
		} else {
			// Slot exhaustion (§9.2): degrade toward urgent — applied + immediately
			// retired pseudo-batch entry, visible everywhere new, no slot count.
			meta |= C.F_PSEUDO | C.F_APPLIED | C.F_RETIRED
		}
		G[rec + C.L_META] = meta
		const t = ticket()
		G[rec + C.L_SEQ] = t
		G[rec + C.L_RETIRED_SEQ] = slot >= 0 ? 0 : t
		logVals[rec >> 2] = payload
		const tail = M[a + C.LOG_TAIL]
		G[tail + C.L_NEXT] = rec
		M[a + C.LOG_TAIL] = rec
		++tapeStamp
		++worldStamp
		if (slot >= 0) {
			++batchEntryCount[slot]
			if (!applied) {
				++unappliedEntries
				++unappliedCount[a >> 3]
			}
		}
		if (tracer !== undefined) {
			tracer.emit(TK.LOG_APPEND, currentCause, a, slot, rec, t, 0)
		}
		return rec
	}

	// ---- policy value application (ops over accumulators) ----------------------------

	function applyOp(a: number, op: number, payload: unknown, acc: unknown): unknown {
		if (op === C.OP_SET) {
			return payload
		}
		// §12.2 purity contract: updaters and reducers replay once per world and
		// once more at absorption; reading signals inside one would observe
		// whatever world happens to be live at replay time. Debug builds trip on
		// any read inside this window (see readAtomPublic / readComputedPublic).
		++replayDepth
		++enterDepth
		try {
			if (op === C.OP_UPDATE) {
				return (payload as (v: unknown) => unknown)(acc)
			}
			// OP_DISPATCH
			const reducer = metaCol[a >> 3]?.reducer
			if (reducer === undefined) {
				throw new Error('cosignals-alt-b: DISPATCH on an atom with no reducer')
			}
			return reducer(acc, payload)
		} finally {
			--replayDepth
			--enterDepth
		}
	}

	function applyLogRec(a: number, rec: number, acc: unknown): unknown {
		return applyOp(a, G[rec + C.L_META] & C.OP_MASK, logVals[rec >> 2], acc)
	}

	function isEqualPolicy(node: number, x: unknown, y: unknown): boolean {
		if (Object.is(x, y)) {
			return true
		}
		const eq = metaCol[node >> 3]?.isEqual
		return eq !== undefined && eq(x, y)
	}

	// ---- kernel value access ----------------------------------------------------------

	/** The atom's newest kernel value WITHOUT promoting it: the pending slot is
	 * authoritative after any unflushed write. Write paths must use this, never
	 * kernelAtomValue — promotion mid-batch runs updateAtom + shallowPropagate,
	 * which upgrades subscribers to DIRTY and destroys the donor's settle-back
	 * cutoff (batch { set(5); set(0) } must recompute NOTHING — conformance
	 * #123/#132/#147). */
	function pendingAtomValue(a: number): unknown {
		const v = values[(a >> 2) + 1]
		return v === LAZY_UNMATERIALIZED ? materializeAtom(a) : v
	}

	/** Canonical atom value (promotes a pending kernel write), no tracking. */
	function kernelAtomValue(a: number): unknown {
		if (M[a + C.FLAGS] & C.DIRTY) {
			if (updateAtom(a)) {
				const subs = M[a + C.SUBS]
				if (subs !== 0) {
					shallowPropagate(subs)
				}
			}
		}
		const v = values[a >> 2]
		return v === LAZY_UNMATERIALIZED ? materializeAtom(a) : v
	}

	/** Donor kernel write: set pending value, mark DIRTY, propagate. */
	function kernelWrite(a: number, value: unknown): boolean {
		const p = (a >> 2) + 1
		if (values[p] !== (values[p] = value)) {
			M[a + C.FLAGS] |= C.DIRTY
			const subs = M[a + C.SUBS]
			if (subs !== 0) {
				propagate(subs, runDepth !== 0)
				return true
			}
		}
		return false
	}

	/** Donor computedRead (canonical/W0), with optional dependency tracking. */
	function kernelComputedRead(c: number, track: boolean): unknown {
		const flags = M[c + C.FLAGS]
		if (
			flags & C.DIRTY ||
			(flags & C.PENDING &&
				(checkDirty(M[c + C.DEPS], c) || ((M[c + C.FLAGS] = flags & ~C.PENDING), false)))
		) {
			if (updateComputed(c)) {
				const subs = M[c + C.SUBS]
				if (subs !== 0) {
					shallowPropagate(subs)
				}
			}
		} else if (flags === C.K_COMPUTED) {
			// never evaluated (donor `!flags` shape: kind bit only)
			firstEvalComputed(c)
		}
		if (track && activeSub !== 0) {
			link(c, activeSub, cycle)
		}
		return values[c >> 2]
	}

	function firstEvalComputed(c: number): void {
		const stamp = M[c + C.OVERLAY_STAMP]
		M[c + C.FLAGS] = C.K_COMPUTED | C.MUTABLE | C.RECURSED_CHECK
		M[c + C.OVERLAY_STAMP] = stamp
		const prevSub = activeSub
		activeSub = c
		++enterDepth
		try {
			++cycle
			values[c >> 2] = (fns[c >> 3] as (prev?: unknown) => unknown)(undefined)
		} finally {
			--enterDepth
			activeSub = prevSub
			M[c + C.FLAGS] &= ~C.RECURSED_CHECK
		}
	}

	// ---- M3: visibility and world resolution (spec §10) --------------------------------

	/** §10.2 — is log entry `rec` visible in `world`? */
	function visibleIn(rec: number, world: World): boolean {
		const meta = G[rec + C.L_META]
		switch (world.kind) {
			case WK.NEWEST:
				return true
			case WK.COMMITTED:
				return (meta & C.F_RETIRED) !== 0
			case WK.W0:
				return (meta & (C.F_RETIRED | C.F_APPLIED)) !== 0
			case WK.PASS: {
				if (meta & C.F_RETIRED && G[rec + C.L_RETIRED_SEQ] <= world.pin) {
					return true
				}
				if (meta & C.F_PSEUDO) {
					return false // pseudo entries are only reachable via the retired clause
				}
				const slot = (meta & C.SLOT_MASK) >> C.SLOT_SHIFT
				return ((world.mask >>> slot) & 1) !== 0 && G[rec + C.L_SEQ] <= world.pin
			}
			case WK.WRITER: {
				if (meta & (C.F_RETIRED | C.F_APPLIED)) {
					return true
				}
				if (meta & C.F_PSEUDO) {
					return false
				}
				return (meta & C.SLOT_MASK) >> C.SLOT_SHIFT === world.slot
			}
			case WK.CROOT: {
				// Per-root committed view (§13.4): entries retired at or below the
				// root's last-commit ticket, plus entries of batches this root has
				// committed while they remain pending elsewhere (the lock-in set —
				// hiding them would tear the root against its own DOM).
				if (meta & C.F_RETIRED && G[rec + C.L_RETIRED_SEQ] <= world.pin) {
					return true
				}
				if (meta & C.F_PSEUDO) {
					return false
				}
				return ((world.mask >>> ((meta & C.SLOT_MASK) >> C.SLOT_SHIFT)) & 1) !== 0
			}
			case WK.FIXUP: {
				// §13.2 fixup comparison world: everything retired (any time — a
				// post-render urgent commit must fire the correction), plus the
				// remembered pass's included batches' pre-pin entries (so a mount
				// inside a still-pending transition compares against what it
				// actually rendered — never a spurious committed-vs-rendered diff).
				if (meta & C.F_RETIRED) {
					return true
				}
				if (meta & C.F_PSEUDO) {
					return false
				}
				return (
					((world.mask >>> ((meta & C.SLOT_MASK) >> C.SLOT_SHIFT)) & 1) !== 0 &&
					G[rec + C.L_SEQ] <= world.pin
				)
			}
		}
	}

	/** §10.3 — replay an atom's tape for a world. Fold starts at the base
	 * snapshot; equality folds preserve reference stability. */
	function foldTape(a: number, world: World): unknown {
		const head = M[a + C.LOG_HEAD]
		let acc = logVals[head >> 2]
		let rec = G[head + C.L_NEXT]
		while (rec !== 0) {
			if (visibleIn(rec, world)) {
				const next = applyLogRec(a, rec, acc)
				acc = isEqualPolicy(a, acc, next) ? acc : next
			}
			rec = G[rec + C.L_NEXT]
		}
		return acc
	}

	/** Resolve an atom's value in a world (kernel value when unlogged). */
	function atomValueInWorld(a: number, world: World): unknown {
		if ((M[a + C.FLAGS] & C.LOGGED) === 0) {
			return kernelAtomValue(a)
		}
		if (world.kind === WK.W0) {
			return kernelAtomValue(a) // W0 invariant (§9.4)
		}
		return foldTape(a, world)
	}

	function passWorld(): World {
		return {
			kind: WK.PASS,
			key: (passSerial << 2) | 1,
			pin: passPin,
			mask: passIncludeMask,
			slot: -1,
			token: 0,
		}
	}

	function writerWorld(token: number): World {
		return {
			kind: WK.WRITER,
			key: (token << 2) | 2,
			pin: 0,
			mask: 0,
			slot: slotOfToken(token),
			token,
		}
	}

	function worldOfCtx(ctx: Ctx): World {
		if (ctx === Ctx.RENDER) {
			return passWorld()
		}
		if (ctx === Ctx.COMMITTED) {
			// The bindings refine COMMITTED into a per-root view while a root
			// scope is active (§13.4); SSR and rootless reads use the global form.
			if (rootCommittedActive) {
				return {
					kind: WK.CROOT,
					key: -1,
					pin: rootCommittedPin,
					mask: rootCommittedMask,
					slot: -1,
					token: 0,
				}
			}
			return WORLD_COMMITTED
		}
		// AMBIENT (SPEC-RESOLUTIONS §ambient-W0, owner-approved semantics change;
		// mainline cosignal keeps NEWEST-ambient): top-level/handler reads see W0
		// — committed + applied urgent; pending DEFERRED drafts are invisible
		// outside their own context until commit. Inside a deferred batch's own
		// synchronous write scope, reads see that batch's world (read-your-own-
		// draft). The explicit Wn read (drafts included) is latest().
		if (fork !== undefined && fork.getAmbientReadToken !== undefined) {
			const t = fork.getAmbientReadToken()
			if ((t & 1) === 1) {
				const w = writerWorld(t)
				if (w.slot >= 0) {
					return w // the scope's own draft world
				}
				// scope open but no writes logged yet: writer ≡ W0
			}
		}
		return WORLD_W0
	}

	// ---- M3: world memos and certificates (spec §10.5) ---------------------------------

	function certPush(atomId: number, seqOrZero: number): void {
		if (certSp + 2 > certStack.length) {
			const bigger = new Int32Array(certStack.length * 2)
			bigger.set(certStack)
			certStack = bigger
		}
		certStack[certSp] = atomId
		certStack[certSp + 1] = seqOrZero
		certSp += 2
	}

	function atomTailSeqOrZero(a: number): number {
		return M[a + C.FLAGS] & C.LOGGED ? G[M[a + C.LOG_TAIL] + C.L_SEQ] : 0
	}

	/** Overlay atom read: fold in ovWorld, record the certificate pair. */
	function overlayReadAtom(a: number): unknown {
		certPush(a, atomTailSeqOrZero(a))
		return atomValueInWorld(a, ovWorld as World)
	}

	/** Find a live memo record for (node, key); lazily zeroes stale heads (§7.4). */
	function memoLookup(c: number, key: number): number {
		let rec = memoHeads[c >> 3]
		if (rec !== 0 && (rec >= wNext || W[rec + C.W_NODE] !== c)) {
			memoHeads[c >> 3] = 0 // dangling head after a plane reset
			M[c + C.MEMO_KEY] = 0
			return 0
		}
		// Per-record NODE guard: the chain is cut at the first record this node
		// does not own (stale-reference defense, §7.4).
		while (rec !== 0 && rec < wNext && W[rec + C.W_NODE] === c) {
			if (W[rec + C.W_EPOCH] !== 0 && W[rec + C.W_KEY] === key) {
				return rec
			}
			rec = W[rec + C.W_NEXT_MEMO]
		}
		return 0
	}

	/** Certificate scan (§10.5): every pair must still hold. The tapeStamp cache
	 * skips the scan entirely when no tape anywhere has mutated since this
	 * record's last successful validation (see memoStamp above). */
	function certValid(rec: number): boolean {
		const vi = W[rec + C.W_VAL]
		if (memoStamp[vi] === tapeStamp) {
			return true
		}
		const n = W[rec + C.W_NDEPS]
		const end = W[rec + C.W_CERT] + n * 2
		for (let p = W[rec + C.W_CERT]; p < end; p += 2) {
			const aid = CERT[p]
			const seq = M[aid + C.FLAGS] & C.LOGGED ? G[M[aid + C.LOG_TAIL] + C.L_SEQ] : 0
			if (seq !== CERT[p + 1]) {
				return false
			}
		}
		memoStamp[vi] = tapeStamp
		return true
	}

	function copyCertRun(rec: number): void {
		const n = W[rec + C.W_NDEPS]
		const base = W[rec + C.W_CERT]
		for (let i = 0; i < n; ++i) {
			certPush(CERT[base + i * 2], CERT[base + i * 2 + 1])
		}
	}

	function writeMemoRecord(c: number, world: World, val: unknown, certBase: number): number {
		const nPairs = (certSp - certBase) >> 1
		if (certNext + nPairs * 2 > CERT.length) {
			throw new Error(
				'cosignals-alt-b: certificate region exhausted mid-operation; raise initialMemoRecords',
			)
		}
		// Re-memoization REUSES the superseded (node, key) record in place: a hot
		// held-open transition re-evaluates its cone once per drain, and a
		// tombstone-and-prepend discipline would grow the node chain and the slot
		// chain by one record per re-evaluation — turning every later chain walk
		// quadratic (measured: G-7 at 30-40x before this). The record keeps its
		// memoVals slot and its chain positions; only the certificate run is
		// re-appended (reclaimed by the quiescence reset like all cert bytes).
		const old = memoLookup(c, world.key)
		if (old !== 0) {
			// Reuse the record's existing certificate run when the new run fits:
			// no other record aliases it, and a held-open transition's hot
			// write→re-validate loop must not bump-allocate a fresh run per
			// re-evaluation (certNext resets only at quiescence, so that growth
			// was per-operation and unbounded while any batch stayed open).
			if (nPairs <= W[old + C.W_NDEPS]) {
				CERT.set(certStack.subarray(certBase, certSp), W[old + C.W_CERT])
			} else {
				CERT.set(certStack.subarray(certBase, certSp), certNext)
				W[old + C.W_CERT] = certNext
				certNext += nPairs * 2
				if (certNext > WM_CERT) {
					growPending = true
				}
			}
			W[old + C.W_EPOCH] = overlayEpoch
			memoVals[W[old + C.W_VAL]] = val
			W[old + C.W_NDEPS] = nPairs
			memoStamp[W[old + C.W_VAL]] = tapeStamp
			M[c + C.MEMO_KEY] = world.key
			// Late slot-chain link: the record may have been created while the
			// token had NO slot yet (a write-less batch — e.g. watcher-creation
			// seeding evaluates every live deferred world). W_SLOT_NEXT = -1 is
			// the unchained sentinel; once the batch writes and gains a slot, the
			// next re-memoization links the record so drain re-validation can
			// find it (a hole the §17.2 oracle caught).
			if (world.kind === WK.WRITER && world.slot >= 0 && W[old + C.W_SLOT_NEXT] === -1) {
				W[old + C.W_SLOT_NEXT] = slotMemoHead[world.slot]
				slotMemoHead[world.slot] = old
			}
			return old
		}
		const rec = allocMemo()
		CERT.set(certStack.subarray(certBase, certSp), certNext)
		W[rec + C.W_KEY] = world.key
		W[rec + C.W_EPOCH] = overlayEpoch
		W[rec + C.W_NODE] = c
		const vi = memoVals.length
		memoVals.push(val)
		memoStamp.push(tapeStamp)
		W[rec + C.W_VAL] = vi
		W[rec + C.W_NDEPS] = nPairs
		W[rec + C.W_CERT] = certNext
		certNext += nPairs * 2
		if (certNext > WM_CERT) {
			growPending = true
		}
		// Node chain (head in the memos side column, key mirrored on the node).
		const head = memoHeads[c >> 3]
		W[rec + C.W_NEXT_MEMO] = head !== 0 && rec !== head && W[head + C.W_NODE] === c ? head : 0
		memoHeads[c >> 3] = rec
		M[c + C.MEMO_KEY] = world.key
		// Slot memo chain: writer's-world records only (§10.5, §9.8).
		// 0 = chained tail; -1 = not chained (non-writer keys, and writer keys
		// evaluated before their token had a slot — late-linked on reuse above).
		if (world.kind === WK.WRITER && world.slot >= 0) {
			W[rec + C.W_SLOT_NEXT] = slotMemoHead[world.slot]
			slotMemoHead[world.slot] = rec
		} else {
			W[rec + C.W_SLOT_NEXT] = -1
		}
		return rec
	}

	/** §10.5 — overlay evaluation of computed `c` in `world`, memoized. */
	function overlayEvaluate(c: number, world: World): unknown {
		if (world.key !== -1) {
			// Fused head-hit fast path: the hot shape is one world reading one
			// node repeatedly, so the wanted record is the chain head. One guard
			// chain, W_VAL loaded once, the tapeStamp compare instead of the
			// certificate scan (G-8's inner loop).
			const head = memoHeads[c >> 3]
			if (
				head !== 0 &&
				head < wNext &&
				W[head + C.W_NODE] === c &&
				W[head + C.W_KEY] === world.key &&
				W[head + C.W_EPOCH] === overlayEpoch
			) {
				const vi = W[head + C.W_VAL]
				if (world.kind === WK.PASS || memoStamp[vi] === tapeStamp || certValid(head)) {
					if (ovDepth !== 0) {
						copyCertRun(head) // memo hit inside a collection frame flattens
					}
					if (tracer !== undefined) {
						tracer.emit(TK.COMPUTED_EVAL, currentCause, c, world.key, 1, 0, 0)
					}
					const hv = memoVals[vi]
					if (world.key === 0) {
						newestStamp[c >> 3] = worldStamp
						values[(c >> 2) + 1] = hv
					}
					return hv
				}
			} else {
				const rec = memoLookup(c, world.key)
				if (
					rec !== 0 &&
					W[rec + C.W_EPOCH] === overlayEpoch &&
					(world.kind === WK.PASS || certValid(rec))
				) {
					if (ovDepth !== 0) {
						copyCertRun(rec) // memo hit inside a collection frame flattens
					}
					if (tracer !== undefined) {
						tracer.emit(TK.COMPUTED_EVAL, currentCause, c, world.key, 1, 0, 0)
					}
					const rv = memoVals[W[rec + C.W_VAL]]
					if (world.key === 0) {
						newestStamp[c >> 3] = worldStamp
						values[(c >> 2) + 1] = rv
					}
					return rv
				}
			}
		}
		const certBase = certSp
		const prevWorld = ovWorld
		ovWorld = world
		++ovDepth
		const prevSub = activeSub
		activeSub = 0 // overlay evaluation never tracks (§10.5)
		let prevVal: unknown
		if (world.key !== -1) {
			const oldRec = memoLookup(c, world.key)
			prevVal = oldRec !== 0 ? memoVals[W[oldRec + C.W_VAL]] : undefined
		}
		if (prevVal === undefined) {
			// No world history (fresh or evicted memo): seed prev from the
			// canonical slot — worlds fork FROM canonical, so it is the node's
			// genuine previous almost everywhere it matters. Without this, a
			// pending eval in a diverged world folds `latest = undefined` and a
			// refresh presents as a FIRST LOAD there (fallback flash in
			// transition renders; per-world isPending misreads).
			prevVal = values[c >> 2]
		}
		let val: unknown
		try {
			val = runComputedFn(c, prevVal)
		} finally {
			--ovDepth
			ovWorld = prevWorld
			activeSub = prevSub
		}
		if (prevVal !== undefined && isEqualPolicy(c, prevVal, val)) {
			val = prevVal // reference stability (§11.2)
		}
		if (tracer !== undefined) {
			tracer.emit(TK.COMPUTED_EVAL, currentCause, c, world.key, 0, (certSp - certBase) >> 1, 0)
		}
		if (world.key !== -1) {
			writeMemoRecord(c, world, val, certBase)
			if (world.key === 0) {
				newestStamp[c >> 3] = worldStamp
				values[(c >> 2) + 1] = val
			}
		}
		if (ovDepth === 0) {
			certSp = 0
		}
		return val
	}

	/** Resolve a computed's value in a world (read gate + post-eval re-check, §10.4). */
	function resolveComputed(c: number, world: World, track: boolean): unknown {
		if (world.kind === WK.W0) {
			return kernelComputedRead(c, track)
		}
		if (loggedAtomCount === 0 || M[c + C.OVERLAY_STAMP] <= eraFloor) {
			const v = kernelComputedRead(c, track)
			const worldSensitive = world.kind !== WK.NEWEST || unappliedEntries !== 0
			if (worldSensitive && M[c + C.OVERLAY_STAMP] > eraFloor) {
				// Post-eval re-check: this evaluation's own linking just marked c
				// (fresh node, or a new branch into a logged atom, §10.4).
				if (world.kind === WK.NEWEST && unappliedStamp[c >> 3] <= eraFloor) {
					// Marked mid-eval, but nothing unapplied below: the kernel
					// value IS the newest value (Wn(c) ≡ W0(c)); re-evaluating
					// through the overlay would double-run side-effecting fns
					// (conformance #179).
					return v
				}
				return overlayEvaluate(c, world)
			}
			return v
		}
		if (world.kind === WK.NEWEST) {
			if (unappliedEntries === 0) {
				return kernelComputedRead(c, track)
			}
			if (newestStamp[c >> 3] === worldStamp) {
				return values[(c >> 2) + 1] // validated this world-state (see above)
			}
			if (unappliedStamp[c >> 3] <= eraFloor) {
				// No unapplied entry below this node: Wn(c) ≡ W0(c). Keep the
				// kernel's exact-pull-count path — an unrelated live deferred
				// batch must be invisible to this cone (§17.5(b)); re-check the
				// stamp after evaluation (a new edge may have flowed it, §10.4).
				const v = kernelComputedRead(c, track)
				if (unappliedStamp[c >> 3] > eraFloor) {
					return overlayEvaluate(c, world)
				}
				return v
			}
		}
		return overlayEvaluate(c, world)
	}

	/** Resolve any node in a world (broadcast decisions, oracle comparisons). */
	function resolveNode(node: number, world: World): unknown {
		if (M[node + C.FLAGS] & C.K_ATOM) {
			return atomValueInWorld(node, world)
		}
		return resolveComputed(node, world, false)
	}

	// ---- computed evaluation wrapper (policy; §11.2/§11.3/§12.3) ----------------------

	function stampThenable(t: PromiseLike<unknown>, waiter: number): ThenableState {
		let st = thenableStates.get(t)
		if (st === undefined) {
			const state: ThenableState = { status: 'pending', waiters: new Set() }
			thenableStates.set(t, state)
			st = state
			t.then(
				(v) => {
					state.status = 'fulfilled'
					state.value = v
					settleTrampoline(t, state)
				},
				(r) => {
					state.status = 'rejected'
					state.reason = r
					settleTrampoline(t, state)
				},
			)
		}
		st.waiters.add(waiter)
		return st
	}

	function onThenableSettled(t: PromiseLike<unknown>, st: ThenableState): void {
		// §12.3: settlement of a thenable while the overlay is live bumps the epoch
		// (nothing else would invalidate a writer's-world memo holding the box).
		// Gate on LIVE SLOTS too, not just logged atoms: broadcast decisions mint
		// world memos in slotted write-less worlds (a pass-interned batch with no
		// entries), and a stale memo would keep serving the pending box after the
		// settled value landed (found by the §17.2 oracle, seed 368).
		if (loggedAtomCount !== 0 || liveSlotMask !== 0) {
			++overlayEpoch
			++worldStamp
		}
		// Settlement is a GLOBAL write: a waiter may hold t only in a diverged
		// world's box while its canonical value is settled or pending on a
		// DIFFERENT origin (e.g. a branch whose cond differs per world), so no
		// canonical-box guard is sound. Shape it exactly like an urgent write
		// from each waiter: canonical invalidation + a token-0 collecting walk,
		// with drainUrgent expanding re-validation to every live writer's world.
		// With no logged entries and no slots every world ≡ W0 — kernel
		// propagation alone decides, and skipping the walk keeps the planes at
		// baseline (nothing would prune marks laid down while fully quiescent).
		const overlayLive = loggedAtomCount !== 0 || liveSlotMask !== 0
		for (const c of st.waiters) {
			if ((M[c + C.FLAGS] & C.KIND_MASK) === 0) {
				continue // freed since it waited
			}
			invalidate(c)
			if (overlayLive) {
				drainUrgent = true
				pendingWalks.push(c, 0)
			}
		}
		// MATERIALIZE (Solid's _blocked-rerun equivalent): evaluate each waiter
		// canonically NOW, observed or not. Without this an unobserved node's
		// settled value never lands in its slot, and the next re-pend
		// (refresh/param change) would fold `latest = undefined` — presenting a
		// refresh as a first load. This is also what starts a chained refetch.
		for (const c of st.waiters) {
			if ((M[c + C.FLAGS] & C.KIND_MASK) !== 0) {
				resolveNode(c, WORLD_W0)
			}
		}
		st.waiters.clear()
		flush()
		drainAll()
	}

	/** Run a computed's user fn; returns a value or a sentinel box. Boxes are
	 * reference-stable while the state is unchanged (§11.2). */
	function runComputedFn(c: number, prev: unknown): unknown {
		const m = metaCol[c >> 3]
		const rawFn = m?.rawFn
		if (rawFn === undefined) {
			throw new Error('cosignals-alt-b: computed has no fn')
		}
		const savedPending = evalPending
		evalPending = undefined
		let next: unknown
		++enterDepth
		try {
			if (m!.wantsCtx !== true) {
				next = (rawFn as unknown as () => unknown)()
			} else {
				const ctx: ComputedCtxImpl = {
					previous: isErrorBox(prev) || isSuspendedBox(prev) ? undefined : prev,
					refreshEpoch: m!.refreshEpoch ?? 0,
					use<U>(thenable: PromiseLike<U>): U {
						// No positional cache and no thrown promise: register the
						// thenable (all use() calls in one eval register before
						// pending surfaces — parallel fetches, no waterfalls) and
						// keep evaluating. The box built at frame exit holds it ON
						// THE NODE; React retries re-read that same box.
						const st = stampThenable(thenable, c)
						if (st.status === 'fulfilled') {
							return st.value as U
						}
						if (st.status === 'rejected') {
							throw st.reason
						}
						if (evalPending === undefined) {
							evalPending = thenable
						}
						return undefined as U
					},
				}
				next = rawFn(ctx)
			}
		} catch (err) {
			evalPending = savedPending
			if (isErrorBox(prev) && Object.is(prev.error, err)) {
				return prev
			}
			return { kind: 'error', error: err } as ErrorBox
		} finally {
			--enterDepth
		}
		const pend = evalPending
		evalPending = savedPending
		const result = foldEvalResult(prev, next, pend)
		if (
			result === next &&
			prev !== undefined &&
			!isErrorBox(prev) &&
			!isSuspendedBox(prev) &&
			!isErrorBox(next) &&
			!isSuspendedBox(next) &&
			isEqualPolicy(c, prev, next)
		) {
			return prev
		}
		return result
	}

	function broadcastEqual(node: number, a: unknown, b: unknown): boolean {
		if (Object.is(a, b)) {
			return true
		}
		// Status boxes compare STRUCTURALLY: evaluations in different worlds (or
		// after memo eviction) mint distinct box objects for the same pending
		// state, and a broadcast decision must track state, not allocation. The
		// state IS the thenable: `latest` cannot really change while a world stays
		// continuously pending (foldEvalResult freezes it through prev; a real
		// change requires exiting pending, which broadcasts on its own), so latest
		// differences between boxes are prev-eviction artifacts, never news.
		if (isSuspendedBox(a) || isSuspendedBox(b)) {
			return isSuspendedBox(a) && isSuspendedBox(b) && a.thenable === b.thenable
		}
		if (isErrorBox(a) || isErrorBox(b)) {
			return isErrorBox(a) && isErrorBox(b) && Object.is(a.error, b.error)
		}
		return isEqualPolicy(node, a, b)
	}

	// ---- the write path (§9.1 gate, §9.3 append, §9.4 applied, §9.8 notify) ----------

	function atomWrite(a: number, op: number, payload: unknown): void {
		if (currentCtx === Ctx.RENDER && forkRenderingNow()) {
			throw new Error('cosignals-alt-b: writes during render are forbidden (§10.8)')
		}
		if (initDepth !== 0 && debugChecks) {
			throw new Error(
				'cosignals-alt-b: writes inside a lazy state initializer are forbidden (§lazy-init: initializers are graph-pure)',
			)
		}
		if (
			forbidWritesInComputeds &&
			activeSub !== 0 &&
			(M[activeSub + C.FLAGS] & C.K_COMPUTED) !== 0
		) {
			throw new Error('cosignals-alt-b: writes inside computeds are forbidden (configure)')
		}
		if (writeMode === Mode.DIRECT) {
			// §9.1 gate, per-write probe: protocol v2 mints batches lazily at the
			// first getCurrentWriteBatch call — which only the LOGGED path makes —
			// so a fresh transition's FIRST write has no preceding batch-open
			// edge. When the fork reports open work (a live batch, an open pass,
			// or an unminted transition scope), flip and log; a truly idle write
			// pays one fork call and stays DIRECT (the loose contract).
			if (fork !== undefined && fork.hasOpenWork()) {
				writeMode = Mode.LOGGED
				atomWriteLogged(a, op, payload)
				return
			}
			// DIRECT: the proven kernel write, zero overlay instructions (§9.1).
			const cur = pendingAtomValue(a)
			const next = applyOp(a, op, payload, cur)
			if (isEqualPolicy(a, cur, next)) {
				return
			}
			// No emit here: DIRECT writes are the pure kernel path, and the
			// production kernel carries zero tracing instructions (§16.5) — the
			// tracer's choke points are tape append and overlay read resolution
			// (§16.2), which do not exist in DIRECT mode. Kernel-internal detail
			// belongs to the traced-kernel stamp, not per-site checks.
			// Donor discipline: flush/drain only when the write actually
			// propagated (kernelWrite returns false for subscriber-less atoms —
			// the unobserved-write fast path).
			if (kernelWrite(a, next) && batchDepth === 0) {
				flush()
				drainAll()
			}
			return
		}
		atomWriteLogged(a, op, payload)
	}

	// Out-of-line slow half (§18.3 discipline: the DIRECT fast path above stays
	// under the inline budget; this half runs only in LOGGED mode).
	function atomWriteLogged(a: number, op: number, payload: unknown): void {
		// LOGGED: every write is logged (§9.1 always-log rule).
		const f = fork
		if (f === undefined) {
			throw new Error('cosignals-alt-b: LOGGED mode without a fork attached')
		}
		// Token bit 0 IS the deferred classification (§6.2 encoding) in both
		// fork implementations — one protocol call per write, not two.
		const token = f.getCurrentWriteBatch()
		const deferred = (token & 1) === 1
		const slot = internSlot(token)
		const applied = !deferred || slot < 0 // slot exhaustion degrades to urgent
		if (tracer !== undefined) {
			currentCause = tracer.emit(TK.ATOM_WRITE, 0, a, token, op, applied ? 1 : 0, 0)
		}
		let coalesced = false
		if (M[a + C.LOG_HEAD] === 0) {
			// Equality drop — provably safe only while tapeless (§9.3): evaluate
			// once against the base-to-be value (the pending slot: no promotion).
			const cur = pendingAtomValue(a)
			const next = applyOp(a, op, payload, cur)
			if (isEqualPolicy(a, cur, next)) {
				return
			}
			createTape(a, !applied)
		} else if (passOpen === 0 && slot >= 0 && metaCol[a >> 3]?.isEqual === undefined) {
			// Same-batch coalescing (§9.3): only when no render pass is open (a
			// pass may be pinned between the writes) AND the atom uses identity
			// equality. With custom isEqual, coalescing is unsound at the
			// raw-value level (alt-a's finding, adopted): each world's fold keeps
			// the EARLIER reference when isEqual holds (`acc = isEqual(acc, next)
			// ? acc : next`), so replacing SET v1 with SET v2 in place changes
			// which reference a world settles on — an observable identity change.
			// Under Object.is the kept reference IS the same value, so in-place
			// replacement is invisible.
			const tail = M[a + C.LOG_TAIL]
			const tmeta = G[tail + C.L_META]
			const tailOp = tmeta & C.OP_MASK
			if (
				tailOp !== C.OP_BASE &&
				(tmeta & (C.F_RETIRED | C.F_PSEUDO)) === 0 &&
				(tmeta & C.SLOT_MASK) >> C.SLOT_SHIFT === slot &&
				((tmeta & C.F_APPLIED) !== 0) === applied
			) {
				if (op === C.OP_SET) {
					logVals[tail >> 2] = payload
					G[tail + C.L_SEQ] = ticket()
					G[tail + C.L_META] = (tmeta & ~C.OP_MASK) | C.OP_SET
					++tapeStamp
					++worldStamp
					coalesced = true
					if (tracer !== undefined) {
						tracer.emit(TK.LOG_COALESCE, currentCause, a, slot, tail, 0, 0)
					}
				} else if (tailOp !== C.OP_SET) {
					// UPDATE/DISPATCH compose onto a same-batch UPDATE/DISPATCH
					// tail once the batch's run on this tape exceeds the threshold
					// (default 8): composition is input-independent, so it is
					// always sound; the threshold bounds closure allocation (§9.3).
					let run = 0
					let rec = G[M[a + C.LOG_HEAD] + C.L_NEXT]
					while (rec !== 0) {
						const m = G[rec + C.L_META]
						if ((m & C.F_PSEUDO) === 0 && (m & C.SLOT_MASK) >> C.SLOT_SHIFT === slot) {
							++run
						}
						rec = G[rec + C.L_NEXT]
					}
					if (run >= 8) {
						const oldOp = tailOp
						const oldPayload = logVals[tail >> 2]
						const newOp = op
						const newPayload = payload
						const reducer = metaCol[a >> 3]?.reducer
						logVals[tail >> 2] = (acc: unknown): unknown => {
							const mid =
								oldOp === C.OP_UPDATE
									? (oldPayload as (x: unknown) => unknown)(acc)
									: reducer!(acc, oldPayload)
							return newOp === C.OP_UPDATE
								? (newPayload as (x: unknown) => unknown)(mid)
								: reducer!(mid, newPayload)
						}
						G[tail + C.L_SEQ] = ticket()
						G[tail + C.L_META] = (tmeta & ~C.OP_MASK) | C.OP_UPDATE
						++tapeStamp
						++worldStamp
						coalesced = true
						if (tracer !== undefined) {
							tracer.emit(TK.LOG_COALESCE, currentCause, a, slot, tail, 1, 0)
						}
					}
				}
			}
		}
		if (!coalesced) {
			appendLogRec(a, op, slot, payload, applied)
		}
		if (applied) {
			// Urgent: logged AND applied through the kernel (§9.4).
			const cur = pendingAtomValue(a)
			const next = applyOp(a, op, payload, cur)
			if (!isEqualPolicy(a, cur, next)) {
				kernelWrite(a, next)
			}
			drainUrgent = true // applied entries change pending worlds too (§9.8)
			// Always collect this atom's watcher cone with a token-0 walk. The
			// spec's "urgent writes skip the walk; propagate reaches watchers"
			// (§9.8) is unsound for an equal-value urgent write onto a tape: the
			// kernel value does not move (no propagation), yet the applied entry
			// lands with a later seq in every pending world and can change THEIR
			// folds. §17.2's generator includes equal-value writes onto logged
			// atoms precisely to catch this. Decisions dedup the overlap with
			// kernel propagation via the per-world cutoff.
			pendingWalks.push(a, 0)
		} else {
			pendingWalks.push(a, token)
			if (slot >= 0) {
				drainDirtySlots |= 1 << slot
			}
			if (batchDepth !== 0 || drainDepth !== 0) {
				// The collecting walk is deferred to the drain (§9.8 grouping),
				// but user code inside this batch/drain can read NEWEST before
				// then: flow the unapplied-cone stamp immediately (mark-only) so
				// those reads route through the overlay and see this entry.
				notifyWalk(a, ++walkCounter, 1, false)
			}
		}
		if (batchDepth === 0) {
			drainAll()
		}
	}

	// ---- the drain (§9.8): walks, broadcasts, slot-chain re-validation -----------------

	function unretiredDeferredMask(): number {
		let mask = 0
		for (let s = 0; s < 32; ++s) {
			if (batchTokenTab[s] !== 0 && slotRetired[s] === 0 && (batchTokenTab[s] & 1) === 1) {
				mask |= 1 << s
			}
		}
		return mask
	}

	function drainAll(): void {
		if (drainDepth !== 0) {
			return
		}
		drainDepth = 1
		try {
			let guard = 0
			while (
				pendingWalks.length !== 0 ||
				notifyIndex < queuedLength ||
				broadcastLen !== 0 ||
				drainUrgent ||
				drainDirtySlots !== 0
			) {
				if (++guard > 100000) {
					throw new Error('cosignals-alt-b: drain did not settle (write storm?)')
				}
				// 1. Deferred notify walks — one walk ticket per TOKEN per drain
				// (§9.8). Same-token writes over one region dedup against the
				// shared ticket; different tokens must re-walk, because watcher
				// collection is per (watcher, token) — one shared ticket across
				// tokens would silently drop the second batch's notifications.
				if (pendingWalks.length !== 0) {
					const walks = pendingWalks
					pendingWalks = []
					// Fast path: one token for the whole group (the overwhelmingly
					// common drain shape) — no Map, one ticket.
					let uniform = true
					const t0 = walks[1]
					for (let i = 3; i < walks.length; i += 2) {
						if (walks[i] !== t0) {
							uniform = false
							break
						}
					}
					if (uniform) {
						const t = ++walkCounter
						for (let i = 0; i < walks.length; i += 2) {
							notifyWalk(walks[i], t, t0, true)
						}
					} else {
						const byToken = new Map<number, number[]>()
						for (let i = 0; i < walks.length; i += 2) {
							let atoms = byToken.get(walks[i + 1])
							if (atoms === undefined) {
								atoms = []
								byToken.set(walks[i + 1], atoms)
							}
							atoms.push(walks[i])
						}
						for (const [token, atoms] of byToken) {
							const t = ++walkCounter
							for (const a of atoms) {
								notifyWalk(a, t, token, true)
							}
						}
					}
				}
				// 2. Kernel effects (urgent writes queued them).
				flush()
				// 3. Slot-chain re-validation (§9.8) — BEFORE the broadcast
				// decisions: the decisions' own world evaluations re-memoize the
				// marked subgraph, and if they ran first, phase 1 of the
				// re-validation would see only fresh records and miss the value
				// changes of intermediate nodes whose watchers the walk did not
				// collect (found by the §17.2 oracle).
				const urgent = drainUrgent
				drainUrgent = false
				let slots = drainDirtySlots
				drainDirtySlots = 0
				if (urgent) {
					slots = unretiredDeferredMask()
				}
				trace(`drain-iter urgent=${urgent} slots=${slots.toString(2)} bq=${broadcastLen}`)
				if (slots !== 0) {
					processRevalidations(slots)
				}
				// 4. Broadcasts, grouped by token; deferred groups entangled (§9.8).
				processBroadcasts()
			}
		} finally {
			drainDepth = 0
			currentCause = 0
		}
	}

	function processBroadcasts(): void {
		if (broadcastLen === 0) {
			return
		}
		const n = broadcastLen
		// Copy into a persistent scratch (re-entrant pushes go to the live queue).
		if (bcScratch.length < n) {
			bcScratch.length = n
		}
		for (let i = 0; i < n; ++i) {
			bcScratch[i] = broadcastQueue[i]
		}
		broadcastLen = 0
		// Group by token; dedup (w, token) by a linear scan of the (short) group —
		// no string keys, no Set allocation.
		const groups = new Map<number, number[]>()
		for (let i = 0; i < n; i += 2) {
			const w = bcScratch[i]
			const t = bcScratch[i + 1]
			let g = groups.get(t)
			if (g === undefined) {
				g = []
				groups.set(t, g)
			}
			if (!g.includes(w)) {
				g.push(w)
			}
		}
		for (const [token, ws] of groups) {
			if (token !== 0 && (token & 1) === 1 && fork !== undefined) {
				// Deferred group: setStates must land in the batch's own lanes even
				// when the drain runs after the writer's scope closed (§9.8).
				const ok = fork.runInBatch(token, () => {
					for (const w of ws) {
						broadcastDecide(w, token)
					}
				})
				if (!ok) {
					// Token retired between write and drain: urgent fallback — its
					// values are already absorbed into canonical state.
					for (const w of ws) {
						broadcastDecide(w, 0)
					}
				}
			} else {
				for (const w of ws) {
					broadcastDecide(w, 0)
				}
				// Urgent drains decide in every live deferred writer's world too
				// (§17.2's oracle rule): an applied entry is visible in every
				// writer's world, and it can CAUSE first divergence for a pending
				// world (e.g. flip a branch onto that world's entries) — a case
				// the slot chains cannot cover because no memo exists yet. These
				// decisions also create those memos. Iterate the fork's live
				// tokens, not slots: a live batch with no writes has no slot but
				// its writer's world still moves when entries retire into it.
				if (fork !== undefined) {
					for (const token of fork.liveTokens()) {
						if ((token & 1) === 1) {
							fork.runInBatch(token, () => {
								for (const w of ws) {
									broadcastDecide(w, token)
								}
							})
						}
					}
				}
			}
		}
	}

	/** §10.6 — per-watcher cutoff: broadcast iff the watched node's value in the
	 * writer's world differs from the last value broadcast for that world. */
	function broadcastDecide(w: number, token: number): void {
		if ((M[w + C.FLAGS] & C.K_WATCHER) === 0) {
			return // disposed since enqueue
		}
		M[w + C.FLAGS] &= ~(C.PENDING | C.DIRTY | C.RECURSED)
		const m = metaCol[w >> 3]
		if (m === undefined || m.watched === undefined) {
			return
		}
		const node = m.watched
		// A writer's world for a token with NO slot (a write-less batch) is
		// exactly RETIRED|APPLIED = W0: decide through the kernel path instead of
		// spinning up an overlay evaluation whose memo can never diverge.
		let world = token === 0 ? WORLD_W0 : writerWorld(token)
		if (world.kind === WK.WRITER && world.slot < 0) {
			world = WORLD_W0
		}
		const key = token === 0 ? 0 : (token << 2) | 2
		const v = resolveNode(node, world)
		// Default for a world this watcher has never decided in: the node's
		// CURRENT W0 value — "what the committed/urgent path will show". A batch
		// opened after subscription starts identical to W0; the first genuine
		// divergence differs from W0 and fires.
		const last = m.lastBroadcast!.has(key)
			? m.lastBroadcast!.get(key)
			: token === 0
				? undefined // key 0 is always seeded at creation
				: resolveNode(node, WORLD_W0)
		trace(`decide w=${w} node=${node} token=${token} v=${String(v)} last=${String(last)}`)
		const changed = !broadcastEqual(node, last, v)
		if (tracer !== undefined) {
			tracer.emit(TK.BROADCAST, currentCause, w, token, changed ? 0 : 1, node, 0)
		}
		if (changed) {
			m.lastBroadcast!.set(key, v)
			++enterDepth
			try {
				m.cb!(token)
			} finally {
				--enterDepth
			}
		}
	}

	function processRevalidations(slotsMask: number): void {
		for (let s = 0; s < 32; ++s) {
			if (((slotsMask >>> s) & 1) === 0) {
				continue
			}
			const token = batchTokenTab[s]
			if (token === 0 || slotRetired[s] !== 0) {
				continue
			}
			const world = writerWorld(token)
			// Phase 1 — snapshot the chain's live stale records BEFORE evaluating
			// anything: a re-evaluation nests into downstream computeds and
			// re-memoizes them, tombstoning their own chain records; a single-pass
			// walk would then skip those records as tombstones and lose their
			// value-change notifications (found by the §17.2 oracle).
			const staleNodes: number[] = []
			const staleOldVals: unknown[] = []
			let rec = slotMemoHead[s]
			let prevRec = 0
			while (rec > 0) {
				const next = W[rec + C.W_SLOT_NEXT]
				if (W[rec + C.W_EPOCH] !== 0) {
					const node = W[rec + C.W_NODE]
					if (W[rec + C.W_EPOCH] !== overlayEpoch || !certValid(rec)) {
						staleNodes.push(node)
						staleOldVals.push(memoVals[W[rec + C.W_VAL]])
					}
					prevRec = rec
				} else {
					// Opportunistic chain trim (§9.6): splice tombstones out while
					// we are walking anyway — garbage hygiene, not correctness.
					const spliced = next <= 0 ? 0 : next
					if (prevRec === 0) {
						slotMemoHead[s] = spliced
					} else {
						W[prevRec + C.W_SLOT_NEXT] = spliced
					}
					W[rec + C.W_SLOT_NEXT] = -1
				}
				rec = next
			}
			// Phase 2 — re-evaluate (memo hits make shared subgraphs cheap) and
			// compare against the snapshot.
			const toNotify: number[] = []
			for (let i = 0; i < staleNodes.length; ++i) {
				const node = staleNodes[i]
				const newVal = overlayEvaluate(node, world) // re-memoizes
				trace(
					`revalidate slot=${s} token=${token} node=${node} old=${String(staleOldVals[i])} new=${String(newVal)}`,
				)
				if (!broadcastEqual(node, staleOldVals[i], newVal)) {
					toNotify.push(node)
				}
			}
			for (const node of toNotify) {
				let l = M[node + C.SUBS]
				while (l !== 0) {
					const sub = M[l + C.SUB]
					if (M[sub + C.FLAGS] & C.IMMEDIATE) {
						pushBroadcast(sub, token) // grouped + entangled next iteration
					}
					l = M[l + C.NEXT_SUB]
				}
			}
		}
	}

	// ---- retirement, absorption, sweep, truncation, quiescence (§9.5-§9.7) ------------

	function onRetired(token: number): void {
		const slot = slotOfToken(token)
		if (tracer !== undefined) {
			currentCause = tracer.emit(TK.BATCH_RETIRED, 0, 0, token, slot, 0, 0)
		}
		++overlayEpoch
		++worldStamp // §10.5: retirement changes world values without moving tails
		if (slot >= 0) {
			slotRetired[slot] = 1
			const rseq = ticket()
			++batchDepth
			try {
				const atoms = loggedAtoms.slice()
				for (const a of atoms) {
					const head = M[a + C.LOG_HEAD]
					if (head === 0) {
						continue
					}
					let touched = false
					let rec = G[head + C.L_NEXT]
					while (rec !== 0) {
						const meta = G[rec + C.L_META]
						if (
							(meta & (C.F_PSEUDO | C.F_RETIRED)) === 0 &&
							(meta & C.SLOT_MASK) >> C.SLOT_SHIFT === slot
						) {
							G[rec + C.L_META] = meta | C.F_RETIRED
							G[rec + C.L_RETIRED_SEQ] = rseq
							if ((meta & C.F_APPLIED) === 0) {
								--unappliedEntries
								--unappliedCount[a >> 3]
							}
							touched = true
						}
						rec = G[rec + C.L_NEXT]
					}
					if (touched) {
						// Absorb (§9.5): replay the W0 fold; committed=false batches
						// fold identically (the writes are real).
						const fold = foldTape(a, WORLD_W0)
						const cur = pendingAtomValue(a)
						const changed = !isEqualPolicy(a, cur, fold)
						if (changed) {
							kernelWrite(a, fold)
						}
						if (tracer !== undefined) {
							tracer.emit(TK.ABSORB, currentCause, a, token, changed ? 1 : 0, 0, 0)
						}
						// Even when the fold is a W0 no-op, the newly-RETIRED entries
						// just became visible in every OTHER pending writer's world
						// (they can land under or over that world's own entries in
						// seq order). Kernel propagation only runs on W0 change, so
						// queue a token-0 walk: its group-0 decisions expand across
						// every live deferred world (§17.2's urgent-drain rule).
						pendingWalks.push(a, 0)
					}
				}
			} finally {
				--batchDepth
			}
			drainUrgent = true // newly-retired entries are visible in other writer's worlds
			drainAll()
		}
		sweepTapes()
		// Retired token → its per-watcher baselines are dead; drop them (and any
		// straggler keys from earlier retirements' fallback decisions).
		pruneWatcherBaselines()
		maybeQuiesce()
		processFinalizeRetries() // reclaims the sweep just unblocked
	}

	function anyUnretiredSlot(): boolean {
		for (let s = 0; s < 32; ++s) {
			if (batchTokenTab[s] !== 0 && slotRetired[s] === 0) {
				return true
			}
		}
		return false
	}

	/** §9.6 — fold each tape's leading run of dead entries into its base record;
	 * free base-only tapes once no live batch could still write. */
	function sweepTapes(): void {
		++tapeStamp
		++worldStamp // folds move base seqs and can free tapes (clearing LOGGED)
		const minPin = passOpen !== 0 ? passPin : 0x7fffffff
		const pendingBatches = anyUnretiredSlot()
		for (let i = loggedAtoms.length - 1; i >= 0; --i) {
			const a = loggedAtoms[i]
			const base = M[a + C.LOG_HEAD]
			let cur = G[base + C.L_NEXT]
			while (cur !== 0) {
				const meta = G[cur + C.L_META]
				if ((meta & C.F_RETIRED) === 0 || G[cur + C.L_RETIRED_SEQ] > minPin) {
					break
				}
				const folded = applyLogRec(a, cur, logVals[base >> 2])
				if (!isEqualPolicy(a, logVals[base >> 2], folded)) {
					logVals[base >> 2] = folded
				}
				G[base + C.L_SEQ] = G[cur + C.L_RETIRED_SEQ]
				G[base + C.L_RETIRED_SEQ] = G[cur + C.L_RETIRED_SEQ]
				const next = G[cur + C.L_NEXT]
				if ((meta & C.F_PSEUDO) === 0) {
					--batchEntryCount[(meta & C.SLOT_MASK) >> C.SLOT_SHIFT]
				}
				freeLogRec(cur)
				cur = next
			}
			G[base + C.L_NEXT] = cur
			if (cur === 0) {
				M[a + C.LOG_TAIL] = base
				if (!pendingBatches) {
					freeLogRec(base)
					M[a + C.LOG_HEAD] = 0
					M[a + C.LOG_TAIL] = 0
					M[a + C.FLAGS] &= ~C.LOGGED
					--loggedAtomCount
					loggedAtoms.splice(i, 1)
					noteReclaimRetry(a) // tape gone: retry a GC-skipped reclaim
				}
			}
		}
		for (let s = 0; s < 32; ++s) {
			if (batchTokenTab[s] !== 0 && slotRetired[s] !== 0 && batchEntryCount[s] === 0) {
				releaseSlot(s)
			}
		}
	}

	/** §9.6 — truncation: unlink a batch's unretired entries without folding.
	 * The truncated batch's watchers are re-notified (its world's values just
	 * rolled back — an optimistic rollback that never rebroadcast would leave
	 * that lane's UI stale until an unrelated drain exposed it). */
	function truncateBatchBySlot(s: number): void {
		++overlayEpoch
		++worldStamp
		++tapeStamp
		++worldStamp
		const token = batchTokenTab[s]
		if (tracer !== undefined) {
			currentCause = tracer.emit(TK.TRUNCATE, 0, 0, token, s, 0, 0)
		}
		const touchedApplied: number[] = []
		for (const a of loggedAtoms) {
			let prev = M[a + C.LOG_HEAD]
			let cur = G[prev + C.L_NEXT]
			let touched = false
			while (cur !== 0) {
				const meta = G[cur + C.L_META]
				const next = G[cur + C.L_NEXT]
				if (
					(meta & (C.F_PSEUDO | C.F_RETIRED)) === 0 &&
					(meta & C.SLOT_MASK) >> C.SLOT_SHIFT === s
				) {
					G[prev + C.L_NEXT] = next
					if (M[a + C.LOG_TAIL] === cur) {
						M[a + C.LOG_TAIL] = prev
					}
					if ((meta & C.F_APPLIED) === 0) {
						--unappliedEntries
						--unappliedCount[a >> 3]
					} else {
						touched = true
					}
					--batchEntryCount[s]
					freeLogRec(cur)
					// Re-notify this atom's cone in the truncated batch's world.
					if (token !== 0 && slotRetired[s] === 0) {
						pendingWalks.push(a, token)
						drainDirtySlots |= 1 << s
					}
				} else {
					prev = cur
				}
				cur = next
			}
			if (touched) {
				touchedApplied.push(a)
			}
		}
		// Truncating applied entries moves W0: restore the invariant.
		for (const a of touchedApplied) {
			const fold = foldTape(a, WORLD_W0)
			const cur = pendingAtomValue(a)
			if (!isEqualPolicy(a, cur, fold)) {
				kernelWrite(a, fold)
			}
			drainUrgent = true
		}
		flush()
		drainAll()
	}

	/** §9.7 — quiescence: the O(1)-ish bulk reset. */
	function maybeQuiesce(): void {
		if (
			loggedAtomCount !== 0 ||
			passOpen !== 0 ||
			liveSlotMask !== 0 ||
			pendingWalks.length !== 0 ||
			broadcastLen !== 0
		) {
			return
		}
		gNext = 4
		gFreeHead = 0
		logVals = [undefined]
		// Zero the used W region so stale node memo heads (§7.4 hazard) can never
		// false-positive the NODE guard against a coincidentally-matching record
		// from the dead era.
		W.fill(0, 0, wNext)
		wNext = 8
		certNext = 0
		memoVals = []
		memoStamp = []
		slotMemoHead.fill(0)
		eraFloor = walkCounter // every mark goes stale in O(1)
		++overlayEpoch
		++worldStamp // cross-era invalidator (seqs repeat across eras)
		seqCounter = 1
		pruneWatcherBaselines() // all slots empty: only the W0 baseline survives
		if (walkCounter > 1 << 30) {
			// Safety valve: zero every node's OVERLAY_STAMP at an idle moment.
			for (let i = 0; i < nodeIds.length; ++i) {
				const id = nodeIds[i]
				const flags = M[id + C.FLAGS]
				if (flags & C.KIND_MASK && (flags & C.K_ATOM) === 0) {
					M[id + C.OVERLAY_STAMP] = 0
				}
			}
			walkCounter = 0
			eraFloor = 0
		}
		if (tracer !== undefined) {
			tracer.emit(TK.QUIESCENCE, 0, 0, 0, overlayEpoch, walkCounter, 0)
		}
		if (!strictLanes && (fork === undefined || fork.isQuiescent())) {
			writeMode = Mode.DIRECT // the LOGGED→DIRECT flip lives here and only here
		}
	}

	// ---- public read paths ---------------------------------------------------------------

	function readAtomPublic(a: number): unknown {
		if ((replayDepth | ovDepth) !== 0 || captureList !== undefined) {
			return readAtomCold(a)
		}
		if (activeSub !== 0) {
			if ((M[activeSub + C.FLAGS] & C.K_COMPUTED) !== 0) {
				// Canonical evaluation reads W0 by construction (§10.1) and tracks.
				const v = kernelAtomValue(a)
				link(a, activeSub, cycle)
				return v
			}
			if (ctxNow() !== Ctx.RENDER) {
				link(a, activeSub, cycle)
			}
		}
		if ((M[a + C.FLAGS] & C.LOGGED) === 0) {
			return kernelAtomValue(a) // the fast path
		}
		{
			const world = worldOfCtx(ctxNow())
			// Ambient-W0: the kernel value IS the W0 fold (applied entries only).
			return world.kind === WK.W0 ? kernelAtomValue(a) : foldTape(a, world)
		}
	}

	function readAtomCold(a: number): unknown {
		if (replayDepth !== 0 && debugChecks) {
			throw new Error(
				'cosignals-alt-b: signal read inside an updater/reducer replay — updaters must be pure functions of their arguments (§12.2; capture values before the write instead)',
			)
		}
		if (captureList !== undefined) {
			captureList.push(a)
		}
		if (ovDepth !== 0) {
			return overlayReadAtom(a) // overlay evaluation: world fold + certificate
		}
		if (activeSub !== 0 && (M[activeSub + C.FLAGS] & C.K_COMPUTED) !== 0) {
			const v = kernelAtomValue(a)
			link(a, activeSub, cycle)
			return v
		}
		const flags = M[a + C.FLAGS]
		if ((flags & C.LOGGED) === 0) {
			const v = kernelAtomValue(a)
			if (activeSub !== 0 && ctxNow() !== Ctx.RENDER) {
				link(a, activeSub, cycle)
			}
			return v
		}
		if (activeSub !== 0 && ctxNow() !== Ctx.RENDER) {
			link(a, activeSub, cycle)
		}
		{
			const world = worldOfCtx(ctxNow())
			return world.kind === WK.W0 ? kernelAtomValue(a) : foldTape(a, world)
		}
	}

	function readComputedPublic(c: number): unknown {
		// One fused guard for the three cold dispatches (replay trap, capture,
		// overlay recursion): all zero/undefined on the hot path.
		if ((replayDepth | ovDepth) !== 0 || captureList !== undefined) {
			return readComputedCold(c)
		}
		if (activeSub !== 0 && (M[activeSub + C.FLAGS] & C.K_COMPUTED) !== 0) {
			return kernelComputedRead(c, true) // canonical nesting: W0
		}
		if (loggedAtomCount === 0 && currentCtx === Ctx.NEWEST) {
			return kernelComputedRead(c, true)
		}
		const ctx = ctxNow()
		const track = ctx !== Ctx.RENDER
		const world = worldOfCtx(ctx)
		if (world.kind === WK.W0) {
			// Ambient-W0 fast path: the kernel state IS W0 (committed + applied
			// urgent) — no overlay resolution for ambient reads under live
			// deferred batches (the big fast-path win of the semantics change).
			return kernelComputedRead(c, track)
		}
		return resolveComputed(c, world, track)
	}

	function readComputedCold(c: number): unknown {
		if (replayDepth !== 0 && debugChecks) {
			throw new Error(
				'cosignals-alt-b: signal read inside an updater/reducer replay — updaters must be pure functions of their arguments (§12.2; capture values before the write instead)',
			)
		}
		if (captureList !== undefined) {
			captureList.push(c)
		}
		if (ovDepth !== 0) {
			// Nested overlay read: recurse in the same world so the parent's
			// certificate contains the child's (possibly still-unlogged) sources.
			// See report: spec §10.4/§10.5 leave the unmarked-child-with-
			// divergent-parent case underdetermined; always recursing is sound.
			return overlayEvaluate(c, ovWorld as World)
		}
		if (activeSub !== 0 && (M[activeSub + C.FLAGS] & C.K_COMPUTED) !== 0) {
			return kernelComputedRead(c, true) // canonical nesting: W0
		}
		if (loggedAtomCount === 0 && currentCtx === Ctx.NEWEST) {
			return kernelComputedRead(c, true) // quiescent fast path (the read gate)
		}
		const ctx = ctxNow()
		const track = ctx !== Ctx.RENDER // render never mutates topology (§10.3)
		return resolveComputed(c, worldOfCtx(ctx), track)
	}

	function worldFromSpec(spec: WorldSpec): World {
		switch (spec.kind) {
			case 'newest':
				return WORLD_NEWEST
			case 'committed':
				return WORLD_COMMITTED
			case 'w0':
				return WORLD_W0
			case 'writer':
				return writerWorld(spec.token)
			case 'pass': {
				return {
					kind: WK.PASS,
					key: -1,
					pin: spec.pin,
					mask: tokensToMask(spec.tokens),
					slot: -1,
					token: 0,
				}
			}
			case 'committedRoot': {
				return {
					kind: WK.CROOT,
					key: -1,
					pin: spec.pin,
					mask: tokensToMask(spec.tokens),
					slot: -1,
					token: 0,
				}
			}
			case 'fixup': {
				return {
					kind: WK.FIXUP,
					key: -1,
					pin: spec.pin,
					mask: tokensToMask(spec.tokens),
					slot: -1,
					token: 0,
				}
			}
		}
	}

	function tokensToMask(tokens: readonly number[]): number {
		let mask = 0
		for (const t of tokens) {
			const s = slotOfToken(t)
			if (s >= 0) {
				mask |= 1 << s
			}
		}
		return mask
	}

	function verifyIntegrity(): void {
		if (eraFloor > walkCounter) {
			throw new Error(`verify: eraFloor ${eraFloor} > walkCounter ${walkCounter}`)
		}
		if (propSp !== 0 || checkSp !== 0) {
			throw new Error('verify: traversal scratch stacks not at base at boundary')
		}
		if (ovDepth === 0 && certSp !== 0) {
			throw new Error('verify: certificate collector not at base at boundary')
		}
		// Link topology coherence for every live node.
		for (const id of nodeIds) {
			const flags = M[id + C.FLAGS]
			if ((flags & C.KIND_MASK) === 0) {
				continue // freed
			}
			if ((flags & C.K_ATOM) === 0 && M[id + C.OVERLAY_STAMP] > walkCounter) {
				throw new Error(`verify: node ${id} stamp exceeds walkCounter`)
			}
			let l = M[id + C.DEPS]
			let prev = 0
			let steps = 0
			while (l !== 0) {
				if (++steps > 1_000_000) {
					throw new Error(`verify: dep list of ${id} does not terminate`)
				}
				if (M[l + C.SUB] !== id) {
					throw new Error(`verify: link ${l} in dep list of ${id} has SUB ${M[l + C.SUB]}`)
				}
				if (M[l + C.PREV_DEP] !== prev) {
					throw new Error(`verify: link ${l} PREV_DEP incoherent`)
				}
				prev = l
				l = M[l + C.NEXT_DEP]
			}
			l = M[id + C.SUBS]
			prev = 0
			steps = 0
			while (l !== 0) {
				if (++steps > 1_000_000) {
					throw new Error(`verify: sub list of ${id} does not terminate`)
				}
				if (M[l + C.DEP] !== id) {
					throw new Error(`verify: link ${l} in sub list of ${id} has DEP ${M[l + C.DEP]}`)
				}
				if (M[l + C.PREV_SUB] !== prev) {
					throw new Error(`verify: link ${l} PREV_SUB incoherent`)
				}
				prev = l
				l = M[l + C.NEXT_SUB]
			}
			if (M[id + C.SUBS_TAIL] !== prev) {
				throw new Error(`verify: SUBS_TAIL of ${id} incoherent`)
			}
		}
		// Liveness refcount invariant (§8.6): every node's count equals the
		// number of its subscriber links whose consumer is live.
		for (const id of nodeIds) {
			if ((M[id + C.FLAGS] & C.KIND_MASK) === 0) {
				continue
			}
			if (liveCount[id >> 3] < 0) {
				throw new Error(`verify: node ${id} liveCount underflow`)
			}
			let expectedLive = 0
			let ll = M[id + C.SUBS]
			while (ll !== 0) {
				if (isLiveNode(M[ll + C.SUB])) {
					++expectedLive
				}
				ll = M[ll + C.NEXT_SUB]
			}
			if (liveCount[id >> 3] !== expectedLive) {
				throw new Error(
					`verify: node ${id} liveCount ${liveCount[id >> 3]} != live subscribers ${expectedLive}`,
				)
			}
		}
		// Tapes: LOGGED flag ⇔ LOG_HEAD, chain seq monotone, counts consistent.
		const perSlot = new Int32Array(32)
		let logged = 0
		for (const a of loggedAtoms) {
			if ((M[a + C.FLAGS] & C.LOGGED) === 0 || M[a + C.LOG_HEAD] === 0) {
				throw new Error(`verify: loggedAtoms entry ${a} has no tape`)
			}
			++logged
			let rec = M[a + C.LOG_HEAD]
			let lastSeq = 0
			let steps = 0
			let sawTail = false
			let isBase = true
			while (rec !== 0) {
				if (++steps > 1_000_000) {
					throw new Error(`verify: tape of ${a} does not terminate`)
				}
				const seq = G[rec + C.L_SEQ]
				// The base record's seq moves to the folded run's retire stamp
				// at sweep (§9.6) and may legitimately exceed live entries' seqs;
				// monotonicity applies to non-base entries only.
				if (!isBase && seq < lastSeq) {
					throw new Error(`verify: tape of ${a} seq not monotone`)
				}
				if (!isBase) {
					lastSeq = seq
				}
				isBase = false
				const meta = G[rec + C.L_META]
				if ((meta & C.OP_MASK) !== C.OP_BASE && (meta & C.F_PSEUDO) === 0) {
					++perSlot[(meta & C.SLOT_MASK) >> C.SLOT_SHIFT]
				}
				if (rec === M[a + C.LOG_TAIL]) {
					sawTail = true
				}
				rec = G[rec + C.L_NEXT]
			}
			if (!sawTail) {
				throw new Error(`verify: LOG_TAIL of ${a} not on its chain`)
			}
		}
		if (logged !== loggedAtomCount) {
			throw new Error(`verify: loggedAtomCount ${loggedAtomCount} != ${logged}`)
		}
		for (let s = 0; s < 32; ++s) {
			if (batchTokenTab[s] !== 0 && perSlot[s] !== batchEntryCount[s]) {
				throw new Error(
					`verify: slot ${s} entry count ${batchEntryCount[s]} != counted ${perSlot[s]}`,
				)
			}
			if (batchTokenTab[s] === 0 && perSlot[s] !== 0) {
				throw new Error(`verify: entries name a free slot ${s}`)
			}
			if (batchTokenTab[s] === 0 && slotMemoHead[s] !== 0) {
				throw new Error(`verify: free slot ${s} has a memo chain`)
			}
		}
		// Memo plane: slot chains carry writer keys; cert runs in bounds.
		for (let rec = 8; rec < wNext; rec += 8) {
			if (W[rec + C.W_EPOCH] === 0) {
				continue
			}
			const nd = W[rec + C.W_NDEPS]
			const cb = W[rec + C.W_CERT]
			if (cb < 0 || cb + nd * 2 > certNext) {
				throw new Error(`verify: memo ${rec} certificate run out of bounds`)
			}
			if (W[rec + C.W_SLOT_NEXT] > 0 && (W[rec + C.W_KEY] & 3) !== 2) {
				throw new Error(`verify: memo ${rec} slot-chained but not a writer's-world key`)
			}
		}
		// Quiescent residue (§8.8, §14.3).
		if (loggedAtomCount === 0 && passOpen === 0 && liveSlotMask === 0) {
			if (gNext !== 4 || wNext !== 8 || certNext !== 0) {
				throw new Error('verify: quiescent overlay has plane residue')
			}
			if (seqCounter !== 1) {
				throw new Error(`verify: quiescent seqCounter ${seqCounter} != 1`)
			}
		}
	}

	// ---- factory-internal cores for the module-level API --------------------------

	function makeEffect(fn: () => void | (() => void)): { id: number; gen: number } {
		const e = allocNode(C.K_EFFECT | C.WATCHING | C.RECURSED_CHECK)
		fns[e >> 3] = fn
		const prevSub = activeSub
		activeSub = e
		if (prevSub !== 0) {
			link(e, prevSub, 0)
			M[prevSub + C.FLAGS] |= C.HAS_CHILD_EFFECT
		}
		++enterDepth
		try {
			++runDepth
			values[(e >> 2) + 1] = fn()
		} finally {
			--enterDepth
			--runDepth
			activeSub = prevSub
			M[e + C.FLAGS] &= ~C.RECURSED_CHECK
		}
		return { id: e, gen: M[e + C.GEN] }
	}

	function makeScope(fn: () => void): { id: number; gen: number } {
		const e = allocNode(C.K_SCOPE | C.MUTABLE)
		const prevSub = activeSub
		activeSub = e
		if (prevSub !== 0) {
			link(e, prevSub, 0)
			M[prevSub + C.FLAGS] |= C.HAS_CHILD_EFFECT
		}
		++enterDepth
		try {
			fn()
		} finally {
			--enterDepth
			activeSub = prevSub
		}
		return { id: e, gen: M[e + C.GEN] }
	}

	/** §13.1 watcher core: kind K_WATCHER, WATCHING|IMMEDIATE|LIVE, subscription-
	 * time world seeding (see createWatcher docs). */
	function makeWatcher(watched: number, cb: (token: number) => void): { id: number; gen: number } {
		const w = allocNode(C.K_WATCHER | C.WATCHING | C.IMMEDIATE)
		const lastBroadcast = new Map<number, unknown>()
		lastBroadcast.set(0, resolveNode(watched, WORLD_W0))
		if (fork !== undefined) {
			for (const token of fork.liveTokens()) {
				if ((token & 1) === 1) {
					lastBroadcast.set((token << 2) | 2, resolveNode(watched, writerWorld(token)))
				}
			}
		}
		metaCol[w >> 3] = { cb, watched, lastBroadcast }
		liveWatcherIds.add(w)
		link(watched, w, 0)
		return { id: w, gen: M[w + C.GEN] }
	}

	/** Drop per-watcher broadcast baselines whose batch token is dead: keys are
	 * minted per batch, so without this a long-lived watcher's lastBroadcast Map
	 * grows by one pinned value per broadcast-reaching batch, forever. Key 0
	 * (the W0 baseline) is permanent; a key survives while its token still
	 * occupies a slot (including retired-but-unswept) or is live on the fork. */
	function pruneWatcherBaselines(): void {
		if (liveWatcherIds.size === 0) {
			return
		}
		for (const w of liveWatcherIds) {
			const lb = metaCol[w >> 3]?.lastBroadcast
			if (lb === undefined || lb.size <= 1) {
				continue
			}
			for (const key of lb.keys()) {
				if (key === 0) {
					continue
				}
				const token = key >> 2
				if (slotOfToken(token) < 0 && (fork === undefined || !fork.isBatchLive(token))) {
					lb.delete(key)
				}
			}
		}
	}

	/** §14.2 registration. The handle instances here are LEAN (an id field;
	 * methods live on the prototype), so registering the instance directly is
	 * as cheap as V8 FR registration gets — V8's weak-target processing of a
	 * dying registered object scales with the target's shape (closure-rich
	 * targets cost ~2.5x more; alt-a registers a handle-owned token for that
	 * reason). heldValue: SMI `id` for fresh records (gen 0, the common case),
	 * packed gen * 2^32 + id while gen < 2^21, and the allocating {id, gen}
	 * form beyond — correctness never rides on the packing range.
	 *
	 * Registration is IMMEDIATE on purpose: deferring register calls into a
	 * batched microtask flush was measured SLOWER for create-and-drop bursts
	 * (+15ns vs +12.8ns per handle) — the queue's strong pin makes burst
	 * handles survive scavenges they would otherwise die young in, costing
	 * more than the saved register calls. */
	function registerHandle(handle: object, id: number): void {
		if (!finalizationEnabled) {
			return
		}
		if (finalizationRegistry === undefined) {
			finalizationRegistry = new FinalizationRegistry(finalizeTrampoline)
		}
		const gen = M[id + C.GEN]
		finalizationRegistry.register(
			handle,
			gen === 0 ? id : gen < 0x200000 ? gen * 0x100000000 + id : { id, gen },
		)
	}

	/** Free a handle-owned record once its handle is unreachable. Skips records
	 * that are still subscribed-to or carry a live tape; the GEN check defuses
	 * stale finalizations. `retryIfBusy` marks GC-driven calls (the handle is
	 * provably unreachable): a guarded skip is recorded and retried when the
	 * blocking reference drops (last subscriber unlinks / tape sweeps away) —
	 * the registry fires once per handle, so a skipped callback would otherwise
	 * leak the record forever. Deterministic disposeSignal() never registers a
	 * retry: its caller may legitimately keep using the handle after a skip. */
	function finalizeRecord(held: { id: number; gen: number }, retryIfBusy = false): void {
		const { id, gen } = held
		if (M[id + C.GEN] !== gen) {
			finalizeSkipped.delete(id)
			return // already freed and possibly reused
		}
		const flags = M[id + C.FLAGS]
		if ((flags & (C.K_ATOM | C.K_COMPUTED)) === 0) {
			finalizeSkipped.delete(id)
			return
		}
		if (M[id + C.SUBS] !== 0 || (flags & C.LOGGED) !== 0) {
			if (retryIfBusy) {
				finalizeSkipped.set(id, gen)
			}
			return // graph edges or a live tape still reference it: leak-safe skip
		}
		finalizeSkipped.delete(id)
		disposeAllDepsInReverse(id)
		pendingFree.push(id)
		sweepPendingFree()
	}

	/** A guard that blocked a GC-driven reclaim just cleared: queue the retry. */
	function noteReclaimRetry(id: number): void {
		if (finalizeSkipped.size !== 0 && finalizeSkipped.has(id)) {
			finalizeRetry.push(id)
		}
	}

	function processFinalizeRetries(): void {
		while (finalizeRetry.length !== 0) {
			const batch = finalizeRetry.splice(0, finalizeRetry.length)
			for (const id of batch) {
				const gen = finalizeSkipped.get(id)
				if (gen !== undefined) {
					finalizeRecord({ id, gen }, true)
				}
			}
		}
	}

	return {
		buffers: () => ({ m: M, g: G, w: W, cert: CERT }),
		allocNode,
		gen: (id: number) => M[id + C.GEN],
		dispose,
		sweepPendingFree,
		processFinalizeRetries,
		atomWrite,
		readAtomPublic,
		readComputedPublic,
		runComputedFn,
		resolveNode,
		readInWorld: (id: number, spec: WorldSpec) => resolveNode(id, worldFromSpec(spec)),
		makeEffect,
		makeScope,
		makeWatcher,
		registerHandle,
		finalizeRecord,
		flush,
		drainAll,
		sweepTapes,
		maybeQuiesce,
		onRetired,
		truncateToken: (token: number) => {
			const s = slotOfToken(token)
			if (s >= 0) {
				truncateBatchBySlot(s)
			}
		},
		internSlot,
		tokensToMask,
		kernelAtomValue,
		kernelSet: (id: number, value: unknown) => {
			// SSR install: an ordinary kernel SET before hydration (§13.8).
			const m = metaCol[id >> 3]
			if (m?.lazyInit !== undefined) {
				// §lazy-init: install IS the materialization — the initializer
				// is skipped. Nothing can have observed the atom (any read
				// would have materialized it): a direct slot fill is sound.
				m.lazyInit = undefined
				values[id >> 2] = value
				values[(id >> 2) + 1] = value
				return
			}
			const cur = pendingAtomValue(id)
			if (!isEqualPolicy(id, cur, value)) {
				if (loggedAtomCount !== 0) {
					// Bypasses the tape machinery: wholesale-invalidate any
					// live memos that read this (unlogged) atom's value.
					++overlayEpoch
					++worldStamp
				}
				kernelWrite(id, value)
				flush()
				drainAll()
			}
		},
		onThenableSettled,
		ctxNow: () => ctxNow(),
		/** §7 refresh: write-like invalidation of ONE computed — forces its fn
		 * to re-run (ctx.use re-registers fresh thenables) without touching
		 * upstream. Shaped like the settlement write: worlds re-derive, and
		 * with live overlay state every writer's world re-decides. prev is
		 * threaded through the ordinary eval path, so a re-run that lands
		 * pending folds the last settled value into box.latest
		 * (= refresh-pending, never uninitialized). No-op on atoms. */
		refreshNode: (id: number) => {
			if ((M[id + C.FLAGS] & C.K_COMPUTED) === 0) {
				return
			}
			const m = metaCol[id >> 3]
			if (m !== undefined) {
				m.refreshEpoch = (m.refreshEpoch ?? 0) + 1
			}
			if (loggedAtomCount !== 0 || liveSlotMask !== 0) {
				++overlayEpoch
				++worldStamp
			}
			invalidate(id)
			if (loggedAtomCount !== 0 || liveSlotMask !== 0) {
				drainUrgent = true
				pendingWalks.push(id, 0)
			}
			// Kick the refetch NOW (Solid: refresh marks dirty + schedules;
			// our synchronous drain is the schedule): the canonical eval
			// re-runs the fn — ctx.use registers the fresh request — and
			// folds the pre-refresh value into box.latest (refresh-pending).
			resolveNode(id, WORLD_W0)
			flush()
			drainAll()
		},
		observeWanted: (node: number) => (M[node + C.FLAGS] & C.KIND_MASK) !== 0 && isLiveNode(node),
		isLive: isLiveNode,
		nodeFlags: (id: number) => M[id + C.FLAGS],
		liveMemos: () => {
			let n = 0
			for (let rec = 8; rec < wNext; rec += 8) {
				if (W[rec + C.W_EPOCH] !== 0) {
					++n
				}
			}
			return n
		},
		verify: verifyIntegrity,
	}
}

type EngineCore = ReturnType<typeof createEngineCore>

// ---- §14.1 boundary machinery and late-bound entry wrappers ------------------------

let E: EngineCore = createEngineCore(...createBuffers())
// Hot-path function refs hoisted out of the E object (one var load instead of
// a method-property load per read/write); rebound at every rebuild.
let hotReadAtom = E.readAtomPublic
let hotReadComputed = E.readComputedPublic
let hotAtomWrite = E.atomWrite

function rebindHotPaths(): void {
	hotReadAtom = E.readAtomPublic
	hotReadComputed = E.readComputedPublic
	hotAtomWrite = E.atomWrite
}

function createBuffers(): [Int32Array, Int32Array, Int32Array, Int32Array] {
	return [
		new Int32Array(cfgInitialRecords * 8),
		new Int32Array(cfgInitialLogRecords * 4),
		new Int32Array(cfgInitialMemoRecords * 8),
		new Int32Array(cfgInitialMemoRecords * 8),
	]
}

function growBuf(buf: Int32Array, bump: number, slackUnits: number): Int32Array {
	let len = buf.length
	while (bump > Math.min(len >> 1, len - slackUnits)) {
		len *= 2
	}
	if (len === buf.length) {
		return buf
	}
	const bigger = new Int32Array(len)
	bigger.set(buf)
	return bigger
}

/** Rebuild the engine closure over doubled buffers. Runs only at a true
 * operation boundary (enterDepth === 0): no live engine frame captured the
 * old buffers, so ids (plain indices) survive the copy unchanged (§14.1). */
function boundaryWork(): void {
	growPending = false
	const b = E.buffers()
	const m = growBuf(b.m, recNext, C.REC_SLACK * 8)
	const g = growBuf(b.g, gNext, 256 * 4)
	const w = growBuf(b.w, wNext, 256 * 8)
	const cert = growBuf(b.cert, certNext, 4096)
	if (m !== b.m || g !== b.g || w !== b.w || cert !== b.cert) {
		E = createEngineCore(m, g, w, cert)
		rebindHotPaths()
	}
}

function boundary(): void {
	if (enterDepth === 0) {
		if (finalizeRetry.length !== 0 && drainDepth === 0) {
			E.processFinalizeRetries()
		}
		if (growPending) {
			boundaryWork()
		}
	}
}

/** Sweep dispose()d records into the free list at a true operation boundary.
 * Without this, a create→dispose loop that never writes (nothing calls
 * flush) grows the main plane and pendingFree forever: dispose() only
 * queues the record, and the queue was drained solely at flush time. */
function reclaimBoundary(): void {
	if (enterDepth === 0 && drainDepth === 0) {
		E.sweepPendingFree()
	}
}

function enter<T>(fn: () => T): T {
	++enterDepth
	try {
		return fn()
	} finally {
		--enterDepth
	}
}

// The enterDepth growth guard lives INSIDE the engine core at every site
// that invokes user code (updateComputed/run/makeEffect/applyOp/...): only
// frames that can reach a constructor's boundary() need guarding, so these
// entry wrappers stay call-free on the hot path (donor discipline).
function atomWriteEntry(node: number, op: number, payload: unknown): void {
	boundary()
	hotAtomWrite(node, op, payload)
	boundary()
}

function peekEntry(node: number): unknown {
	const prevSub = activeSub
	activeSub = 0
	try {
		return hotReadAtom(node)
	} finally {
		activeSub = prevSub
	}
}

/** Thenable settlement runs at microtask time, possibly after a rebuild:
 * always route through the CURRENT engine closure. */
function settleTrampoline(t: PromiseLike<unknown>, st: ThenableState): void {
	++enterDepth
	try {
		E.onThenableSettled(t, st)
	} finally {
		--enterDepth
	}
	boundary()
}

/** FinalizationRegistry callbacks fire at GC time: late-bind through E.
 * held is the packed number gen * 2^32 + id (object form past the packing
 * range — see registerToken). */
function finalizeTrampoline(held: number | { id: number; gen: number }): void {
	++enterDepth
	try {
		if (typeof held === 'number') {
			E.finalizeRecord(
				{ id: held % 0x100000000, gen: Math.floor(held / 0x100000000) },
				true, // GC-driven: retry a guarded skip later
			)
		} else {
			E.finalizeRecord(held, true)
		}
	} finally {
		--enterDepth
	}
	boundary()
}

/** §12.4 microtask-debounced observed-lifecycle reconcile (module-level so
 * the deferred callback never captures a stale engine closure). */
function scheduleObserveReconcile(node: number, m: NodeMeta): void {
	if (m.observeScheduled === true || m.observeEffect === undefined) {
		return
	}
	const observeEffect = m.observeEffect
	m.observeScheduled = true
	void Promise.resolve().then(() => {
		m.observeScheduled = false
		const want = E.observeWanted(node)
		if (want && m.observeMounted !== true) {
			m.observeMounted = true
			const ctx: AtomCtx<unknown> = {
				peek: () => peekEntry(node),
				set: (v: unknown) => atomWriteEntry(node, C.OP_SET, v),
				update: (fn: (v: unknown) => unknown) => atomWriteEntry(node, C.OP_UPDATE, fn),
			}
			const cleanup = observeEffect(ctx)
			m.observeCleanup = typeof cleanup === 'function' ? cleanup : undefined
		} else if (!want && m.observeMounted === true) {
			m.observeMounted = false
			const cleanup = m.observeCleanup
			m.observeCleanup = undefined
			if (cleanup !== undefined) {
				cleanup()
			}
		}
	})
}

/** Full engine reset for test isolation. Optionally reconfigures sizes. */
export function __resetEngineForTests(options?: {
	initialRecords?: number
	initialLogRecords?: number
	initialMemoRecords?: number
}): void {
	if (unsubscribeFork !== undefined) {
		unsubscribeFork()
		unsubscribeFork = undefined
	}
	fork = undefined
	strictLanes = false
	forbidWritesInComputeds = false
	replayDepth = 0
	debugChecks = true
	finalizationEnabled = true // the default: never leak dropped handles
	finalizationRegistry = undefined
	finalizeSkipped.clear()
	finalizeRetry.length = 0
	liveWatcherIds.clear()
	cfgInitialRecords = options?.initialRecords ?? 8192
	cfgInitialLogRecords = options?.initialLogRecords ?? 1024
	cfgInitialMemoRecords = options?.initialMemoRecords ?? 1024
	recNext = 8
	nodeFreeHead = 0
	linkFreeHead = 0
	gNext = 4
	gFreeHead = 0
	wNext = 8
	certNext = 0
	growPending = false
	enterDepth = 0
	cycle = 0
	runDepth = 0
	batchDepth = 0
	notifyIndex = 0
	queuedLength = 0
	activeSub = 0
	queued = []
	pendingFree = []
	values = [undefined, undefined]
	fns = [undefined]
	metaCol = [undefined]
	memoHeads = [0]
	logVals = [undefined]
	memoVals = []
	memoStamp = []
	tapeStamp = 1
	worldStamp = 1
	newestStamp = [0]
	unappliedCount = [0]
	unappliedStamp = [0]
	liveCount = [0]
	propStack = new Int32Array(4096)
	propSp = 0
	checkStack = new Int32Array(4096)
	checkSp = 0
	certStack = new Int32Array(4096)
	certSp = 0
	batchTokenTab = new Int32Array(32)
	batchEntryCount = new Int32Array(32)
	slotRetired = new Int32Array(32)
	slotMemoHead = new Int32Array(32)
	liveSlotMask = 0
	liveDeferredMask = 0
	unappliedEntries = 0
	loggedAtomCount = 0
	seqCounter = 1
	walkCounter = 0
	eraFloor = 0
	overlayEpoch = 1
	lastToken = 0
	lastSlot = -1
	pseudoFallbacks = 0
	writeMode = Mode.DIRECT
	nodeIds = []
	passOpen = 0
	passSerial = 0
	passPin = 0
	passIncludeMask = 0
	passContainer = undefined
	passLineage = 0
	currentCtx = Ctx.NEWEST
	loggedAtoms = []
	broadcastQueue = []
	broadcastLen = 0
	bcScratch = []
	pendingWalks = []
	drainUrgent = false
	drainDirtySlots = 0
	drainDepth = 0
	ovWorld = undefined
	ovDepth = 0
	rootCommittedActive = false
	rootCommittedPin = 0
	rootCommittedMask = 0
	captureList = undefined
	E = createEngineCore(...createBuffers())
	rebindHotPaths()
}
// ---- the bridge (§13 preamble, driven by the fork double) --------------------------

export function attachFork(f: ForkLike): void {
	if (fork !== undefined) {
		throw new Error('cosignals-alt-b: a fork is already attached')
	}
	fork = f
	if (strictLanes) {
		writeMode = Mode.LOGGED // pinned once bindings register (§9.1)
	}
	unsubscribeFork = f.subscribeToExternalRuntime({
		onBatchOpened() {
			writeMode = Mode.LOGGED // DIRECT→LOGGED rides the claim/mint edge (§9.1)
		},
		onRenderPassStart(container, tokens, lineage) {
			writeMode = Mode.LOGGED
			passOpen = 1
			++passSerial
			passPin = seqCounter
			let mask = 0
			++enterDepth
			try {
				for (const t of tokens) {
					const s = E.internSlot(t)
					if (s >= 0) {
						mask |= 1 << s
					}
				}
			} finally {
				--enterDepth
			}
			passIncludeMask = mask
			passContainer = container
			passLineage = lineage
			currentCtx = Ctx.RENDER
			if (tracer !== undefined) {
				tracer.emit(TK.PASS_START, 0, 0, mask, passPin, lineage, 0)
			}
		},
		onRenderPassYield() {
			currentCtx = Ctx.NEWEST // gap code reads newest, writes legally (§10.1)
		},
		onRenderPassResume() {
			currentCtx = Ctx.RENDER
		},
		onRenderPassEnd() {
			if (tracer !== undefined) {
				tracer.emit(TK.PASS_END, 0, 0, passIncludeMask, passPin, passLineage, 0)
			}
			passOpen = 0
			passContainer = undefined
			currentCtx = Ctx.NEWEST
			++enterDepth
			try {
				E.sweepTapes()
				E.maybeQuiesce()
			} finally {
				--enterDepth
			}
			boundary()
		},
		onBatchCommitted() {
			// Per-root committed views are M5 (deferred this pass); the global
			// retired-only COMMITTED form is what reads use (§10.2).
		},
		onBatchRetired(token) {
			++enterDepth
			try {
				E.onRetired(token)
			} finally {
				--enterDepth
			}
			boundary()
		},
	})
}

export function detachFork(): void {
	if (unsubscribeFork !== undefined) {
		unsubscribeFork()
		unsubscribeFork = undefined
	}
	fork = undefined
}

export function configure(options: {
	forbidWritesInComputeds?: boolean
	strictLanes?: boolean
	/** Debug assertions (default true): the §12.2 replay-purity check. */
	debugChecks?: boolean
	/** Reclaim Atom/Computed records when their handles are GC'd (§14.2).
	 * ON BY DEFAULT ("we should never leak"); pass `false` to opt out for
	 * zero FinalizationRegistry overhead, accepting the bounded leak: each
	 * dropped unwatched handle then pins exactly its own record + side
	 * slots, forever. Applies to handles created after the call.
	 * CAVEAT (inherent to JS, both modes): a computed whose fn closure was
	 * created in a scope that also captures the handle keeps the handle
	 * reachable through the shared closure context — create the fn in its
	 * own scope (e.g. a factory function) if you rely on GC reclamation. */
	finalization?: boolean
	initialRecords?: number
	initialLogRecords?: number
	initialMemoRecords?: number
}): void {
	if (options.forbidWritesInComputeds !== undefined) {
		forbidWritesInComputeds = options.forbidWritesInComputeds
	}
	if (options.debugChecks !== undefined) {
		debugChecks = options.debugChecks
	}
	if (options.finalization !== undefined) {
		finalizationEnabled = options.finalization
	}
	if (options.strictLanes !== undefined) {
		strictLanes = options.strictLanes
		if (strictLanes && fork !== undefined) {
			writeMode = Mode.LOGGED
		}
	}
	// Sizing options take effect on the next reset (module singleton).
	if (options.initialRecords !== undefined) {
		cfgInitialRecords = options.initialRecords
	}
	if (options.initialLogRecords !== undefined) {
		cfgInitialLogRecords = options.initialLogRecords
	}
	if (options.initialMemoRecords !== undefined) {
		cfgInitialMemoRecords = options.initialMemoRecords
	}
}

// ---- policy classes (§4, §12) ----------------------------------------------------------

export type AtomOptions<T> = {
	/**
	 * Initial state, or a LAZY INITIALIZER (§lazy-init, React useState
	 * convention): a function-valued `state` is evaluated ONCE, untracked, at
	 * first materialization (first read/write/watch — not at construction).
	 * To store a function AS state, wrap it: `state: () => fn`.
	 *
	 * Recipe — SSR-safe environment probe:
	 * ```ts
	 * const documentVisible = new Atom({
	 *   state: () => document.visibilityState === 'visible',
	 * });
	 * // Module-scope construction never touches `document`; the first client
	 * // read materializes it. On the server, installState(documentVisible,
	 * // true) installs the hydrated value and the initializer never runs.
	 * ```
	 */
	state: T | (() => T)
	/** Observed-lifecycle hook (§12.4): runs when the atom becomes observed
	 * (transitively LIVE); the returned cleanup runs when it no longer is.
	 * Delivery is debounced to a microtask. */
	effect?: (ctx: AtomCtx<T>) => (() => void) | void
	isEqual?: (a: T, b: T) => boolean
	label?: string
}

export class Atom<T> {
	readonly id: number
	constructor(options: AtomOptions<T>) {
		boundary()
		const id = E.allocNode(C.K_ATOM | C.MUTABLE)
		this.id = id
		const lazy = typeof options.state === 'function'
		if (lazy) {
			values[id >> 2] = LAZY_UNMATERIALIZED
			values[(id >> 2) + 1] = LAZY_UNMATERIALIZED
		} else {
			values[id >> 2] = options.state
			values[(id >> 2) + 1] = options.state
		}
		if (
			lazy ||
			options.isEqual !== undefined ||
			options.label !== undefined ||
			options.effect !== undefined
		) {
			metaCol[id >> 3] = {
				isEqual: options.isEqual as ((a: unknown, b: unknown) => boolean) | undefined,
				label: options.label,
				lazyInit: lazy ? (options.state as () => unknown) : undefined,
				observeEffect: options.effect as
					| ((ctx: AtomCtx<unknown>) => (() => void) | void)
					| undefined,
			}
		}
		E.registerHandle(this, id)
	}
	get state(): T {
		return hotReadAtom(this.id) as T
	}
	peek(): T {
		return peekEntry(this.id) as T
	}
	set(next: T): void {
		atomWriteEntry(this.id, C.OP_SET, next)
	}
	update(fn: (current: T) => T): void {
		atomWriteEntry(this.id, C.OP_UPDATE, fn)
	}
}

export type ReducerAtomOptions<S, A> = {
	/** Initial state, or a lazy initializer (function-valued; §lazy-init —
	 * wrap function states as `() => fn`). */
	state: S | (() => S)
	reducer: (state: S, action: A) => S
	isEqual?: (a: S, b: S) => boolean
	label?: string
}

export class ReducerAtom<S, A> {
	readonly id: number
	constructor(options: ReducerAtomOptions<S, A>) {
		boundary()
		const id = E.allocNode(C.K_ATOM | C.MUTABLE)
		this.id = id
		const lazy = typeof options.state === 'function'
		if (lazy) {
			values[id >> 2] = LAZY_UNMATERIALIZED
			values[(id >> 2) + 1] = LAZY_UNMATERIALIZED
		} else {
			values[id >> 2] = options.state
			values[(id >> 2) + 1] = options.state
		}
		metaCol[id >> 3] = {
			isEqual: options.isEqual as ((a: unknown, b: unknown) => boolean) | undefined,
			reducer: options.reducer as (s: unknown, a: unknown) => unknown,
			label: options.label,
			lazyInit: lazy ? (options.state as () => unknown) : undefined,
		}
		E.registerHandle(this, id)
	}
	get state(): S {
		return hotReadAtom(this.id) as S
	}
	peek(): S {
		return peekEntry(this.id) as S
	}
	dispatch(action: A): void {
		atomWriteEntry(this.id, C.OP_DISPATCH, action)
	}
}

export type ComputedCtx<T> = {
	use<U>(thenable: PromiseLike<U>): U
	previous: T | undefined
	/** Bumped by refresh(); key request caches on (params, refreshEpoch). */
	refreshEpoch: number
}

export type ComputedOptions<T> = {
	fn: (ctx: ComputedCtx<T>) => T
	isEqual?: (a: T, b: T) => boolean
	label?: string
}

export class Computed<T> {
	readonly id: number
	constructor(options: ComputedOptions<T>) {
		boundary()
		const id = E.allocNode(C.K_COMPUTED)
		this.id = id
		metaCol[id >> 3] = {
			rawFn: options.fn as unknown as (ctx: ComputedCtxImpl) => unknown,
			// Arity-gated ctx: fns that do not declare a ctx parameter (the
			// overwhelmingly common case) evaluate with zero per-run
			// allocation — no ctx object, no `use` closure.
			wantsCtx: options.fn.length > 0,
			isEqual: options.isEqual as ((a: unknown, b: unknown) => boolean) | undefined,
			label: options.label,
		}
		if (options.fn.length === 0 && options.isEqual === undefined) {
			// Slim kernel wrapper for the hot case (no ctx, identity
			// equality): one call frame over the user fn; only §11.3 error
			// boxing remains, and only on the throw path. The kernel's own
			// identity compare IS the §11.2 contract here, and the callers
			// (updateComputed/firstEvalComputed) already hold the enterDepth
			// growth guard. Touches no plane buffers: rebuild-safe.
			const raw = options.fn as unknown as () => unknown
			fns[id >> 3] = (prev: unknown): unknown => {
				const saved = evalPending
				evalPending = undefined
				try {
					const next = raw()
					const pend = evalPending
					if (pend !== undefined) {
						return foldEvalResult(prev, next, pend)
					}
					return prev !== undefined && Object.is(prev, next) ? prev : next
				} catch (err) {
					if (isErrorBox(prev) && Object.is(prev.error, err)) {
						return prev
					}
					return { kind: 'error', error: err } as ErrorBox
				} finally {
					evalPending = saved
				}
			}
		} else {
			// Late-bound through E so the closure survives engine rebuilds.
			fns[id >> 3] = (prev: unknown) => E.runComputedFn(id, prev)
		}
		E.registerHandle(this, id)
	}
	/** Inside an evaluation frame, pending/error FORWARD (status is graph
	 * state: the reader notes the dep's thenable and continues over the
	 * dep's latest settled value). Top-level: rethrows cached errors, throws
	 * the thenable while suspended (§11.3). */
	get state(): T {
		const v = hotReadComputed(this.id)
		if (isErrorBox(v)) {
			throw v.error
		}
		if (isSuspendedBox(v)) {
			if (inEvalFrame()) {
				if (evalPending === undefined) {
					evalPending = v.thenable
				}
				return v.latest as T
			}
			throw v.thenable
		}
		return v as T
	}
}

/** Synchronous reactive effect over canonical state (§4.4). */
export function effect(fn: () => void | (() => void)): () => void {
	boundary()
	const h = E.makeEffect(fn)
	return () => {
		if (E.gen(h.id) !== h.gen) {
			return
		}
		E.dispose(h.id)
		reclaimBoundary()
		boundary()
	}
}

export function effectScope(fn: () => void): () => void {
	boundary()
	const h = E.makeScope(fn)
	return () => {
		if (E.gen(h.id) !== h.gen) {
			return
		}
		E.dispose(h.id)
		reclaimBoundary()
		boundary()
	}
}

// ---- Solid-2.0 async API set (isPending / refresh / latest; policy only) ----------
//
// UNINITIALIZED-clears-at-COMMIT (recorded rule): Solid clears the
// STATUS_UNINITIALIZED bit when the first real value COMMITS at flush, not
// when the promise resolves. Our equivalent: "uninitialized" is
// `box.latest === undefined`, and it disappears exactly when the settlement
// WRITE replaces the box with the value in the drain (onThenableSettled →
// invalidate → re-eval) — commit-time, not resolve-time. Any later re-pend
// folds the settled value into the next box's `latest` (foldEvalResult), so
// a once-settled node presents as refresh-pending from then on.

const pendingProbes = new WeakMap<SignalLike, Computed<boolean>>()

/** Lazily-created cached probe computed over the node's box SHAPE. Boolean
 * equality is the flip-only cutoff: upstream value churn re-evaluates the
 * probe but only pending↔settled transitions propagate to its observers.
 * Raw reads keep the probe from suspending or registering pending itself
 * (Solid's "probes never refetch/suspend" stance, §2.3 adapted). */
export function pendingComputedOf(signal: SignalLike): Computed<boolean> {
	let probe = pendingProbes.get(signal)
	if (probe === undefined) {
		probe = new Computed<boolean>({
			fn: () => {
				const v = readById(signal.id)
				// First load (uninitialized: latest === undefined) is NOT
				// pending — "pending" strictly means stale data exists while
				// newer data loads (§3 computePendingState).
				return isSuspendedBox(v) && v.latest !== undefined
			},
		})
		pendingProbes.set(signal, probe)
	}
	return probe
}

/** §7 isPending: reactive boolean — is `signal` showing stale data while a
 * refetch is in flight? Reactive when read from a tracked scope (it is an
 * ordinary computed read); per-world correct (the probe evaluates in the
 * ambient world like any node). False on first load and on errors. */
export function isPending(signal: SignalLike): boolean {
	return pendingComputedOf(signal).state as boolean
}

/** §7 refresh: re-run a computed's fn so ctx.use re-registers (a resource-
 * style fn mints a fresh thenable → refresh-pending with latest preserved).
 * Latest-wins under races: a superseded settlement re-runs the fn, which
 * registers the CURRENT thenable again. No-op on atoms/plain signals. */
export function refresh(signal: SignalLike): void {
	boundary()
	enter(() => E.refreshNode(signal.id))
}

/** §7 latest: read current-or-stale — never suspends, never registers
 * pending (raw read; no evalPending touch). Errors rethrow.
 *
 * Per-context world choice (documented contract):
 * - top level (events, gap code, engine effects): ambient = NEWEST — the
 *   in-flight world, so latest(upstreamAtom) sees a deferred batch's staged
 *   write (Solid's staged-read asymmetry, via world reads instead of a
 *   staged buffer);
 * - inside a computed/overlay eval: that eval's world (world consistency is
 *   load-bearing for memo certificates — sampling NEWEST here would poison
 *   per-world memos);
 * - inside a render pass: the pass's world Wp (render purity/replay; a
 *   committed-pass component wanting in-flight signals should use
 *   isPending/useIsPending, not a torn NEWEST sample);
 * - inside withRootCommitted (useSignalEffect bodies): the root's committed
 *   view.
 * For the async node itself, pending unwraps to box.latest (the last value
 * that settled in the reading world); uninitialized reads as undefined. */
export function latest<T>(signal: SignalLike & { state: T }): T | undefined {
	// Under ambient-W0 semantics latest() is THE explicit Wn read — drafts
	// included (see the per-context table in SPEC-RESOLUTIONS §ambient-W0):
	// - plain top level / handlers / engine effects: Wn INCLUDING unapplied
	//   deferred drafts (this is where latest() and .state now diverge);
	// - inside a computed/overlay eval: that eval's world (certificates);
	// - inside a render pass: the pass's world Wp (replay purity);
	// - inside withRootCommitted: the root's committed view.
	// Everywhere it unwraps pending to box.latest and never suspends.
	const raw =
		inEvalFrame() || E.ctxNow() !== Ctx.NEWEST
			? readById(signal.id)
			: enter(() => E.readInWorld(signal.id, { kind: 'newest' }))
	if (isErrorBox(raw)) {
		throw raw.error
	}
	if (isSuspendedBox(raw)) {
		return raw.latest as T | undefined
	}
	return raw as T
}

/** §ambient-W0 companion: read the COMMITTED world explicitly (per-root view
 * inside withRootCommitted, global otherwise). Box handling mirrors .state
 * with the two-level rule: errors throw; refresh-pending serves latest;
 * never-settled throws the thenable. */
export function committed<T>(signal: SignalLike & { state: T }): T {
	// Inside withRootCommitted the ambient ctx is already the (root-refined)
	// committed view — the plain read IS the per-root committed read.
	const raw =
		E.ctxNow() === Ctx.COMMITTED
			? readById(signal.id)
			: enter(() => E.readInWorld(signal.id, { kind: 'committed' }))
	if (isErrorBox(raw)) {
		throw raw.error
	}
	if (isSuspendedBox(raw)) {
		if (raw.latest !== undefined) {
			return raw.latest as T
		}
		throw raw.thenable
	}
	return raw as T
}

/** Coalesce writes: one flush + one drain (one walk ticket) at close (§9.8). */
export function batch<T>(fn: () => T): T {
	++batchDepth
	try {
		return fn()
	} finally {
		if (--batchDepth === 0) {
			E.flush()
			E.drainAll()
			boundary()
		}
	}
}

/** Low-level batch surface (adapter/bindings plumbing; prefer batch()). */
export function startBatch(): void {
	++batchDepth
}

export function endBatch(): void {
	if (--batchDepth === 0) {
		E.flush()
		E.drainAll()
		boundary()
	}
}

export function untracked<T>(fn: () => T): T {
	const prevSub = activeSub
	activeSub = 0
	try {
		return fn()
	} finally {
		activeSub = prevSub
	}
}

/** §13.6 — startTransition + engine batch(): N writes in the scope coalesce
 * to one notify walk and one drain. Returns the batch token (double-driven).
 * Not required for correctness — a throughput helper. */
export function startSignalTransition(scope: () => void): number {
	const f = fork
	if (f === undefined) {
		throw new Error('cosignals-alt-b: startSignalTransition requires an attached fork')
	}
	let token = 0
	batch(() => {
		token = f.startTransition(scope)
	})
	return token
}

// ---- watchers (the M0-M3 stand-in for mounted useSignal hooks, §13.1) ----------------

export type SignalLike = { id: number }

export type WatcherHandle = {
	id: number
	dispose(): void
}

/**
 * A watcher node (kind K_WATCHER, WATCHING|IMMEDIATE): notified synchronously
 * in the writer's stack via the broadcast list, with the §10.6 world-value
 * cutoff. `cb(token)` simulates the hook's setState; deferred tokens arrive
 * inside the fork's runInBatch scope (assert via the double's entangleLog).
 * Subscription seeds lastBroadcast per live deferred world (the engine-level
 * analogue of §13.2's post-subscribe fixup) and registers the memos that make
 * slot-chain re-validation complete for late subscribers.
 */
export function createWatcher(signal: SignalLike, cb: (token: number) => void): WatcherHandle {
	boundary()
	const h = E.makeWatcher(signal.id, cb)
	return {
		id: h.id,
		dispose() {
			if (E.gen(h.id) !== h.gen) {
				return
			}
			E.dispose(h.id)
			reclaimBoundary()
			boundary()
		},
	}
}

// ---- debug surface (verifyArena-lite + oracle hooks; §16.6, §17.2) --------------------

export type WorldSpec =
	| { kind: 'newest' }
	| { kind: 'committed' }
	| { kind: 'w0' }
	| { kind: 'writer'; token: number }
	| { kind: 'pass'; pin: number; tokens: readonly number[] }
	| { kind: 'committedRoot'; pin: number; tokens: readonly number[] }
	| { kind: 'fixup'; pin: number; tokens: readonly number[] }

// ---- bindings support surface (used by src/react.ts; not general API) ----------------

/** Run fn with Ctx.COMMITTED reads refined to a per-root committed view
 * (§13.4): pin + lock-in tokens supplied by the bindings' root table. */
export function withRootCommitted<T>(pin: number, tokens: readonly number[], fn: () => T): T {
	const prevActive = rootCommittedActive
	const prevPin = rootCommittedPin
	const prevMask = rootCommittedMask
	rootCommittedActive = true
	rootCommittedPin = pin
	rootCommittedMask = enter(() => E.tokensToMask(tokens))
	const prevCtx = currentCtx
	currentCtx = Ctx.COMMITTED
	try {
		return fn()
	} finally {
		currentCtx = prevCtx
		rootCommittedActive = prevActive
		rootCommittedPin = prevPin
		rootCommittedMask = prevMask
	}
}

/** Tracked read by node id (bindings' effect-tracker bodies): dispatches on
 * the node's kind through the ordinary read paths, so an enclosing engine
 * effect links real dependencies. */
export function readById(id: number): unknown {
	return (M_kindIsAtom(id) ? hotReadAtom : hotReadComputed)(id)
}

function M_kindIsAtom(id: number): boolean {
	return (E.nodeFlags(id) & 1024) !== 0 // C.K_ATOM
}

/** Record which signals fn reads (useSignalEffect dependency tracking). */
export function captureReads<T>(fn: () => T): { result: T; reads: number[] } {
	const prev = captureList
	const list: number[] = []
	captureList = list
	try {
		const result = fn()
		return { result, reads: [...new Set(list)] }
	} finally {
		captureList = prev
	}
}

/** Deterministic disposal for component-owned atoms/computeds (§13.5): frees
 * the record unless graph edges or a live tape still reference it. */
export function disposeSignal(signal: SignalLike): void {
	enter(() => E.finalizeRecord({ id: signal.id, gen: E.gen(signal.id) }))
	boundary()
}

/** SSR hydration install (§13.8): write a serialized committed value into an
 * atom before hydration. An ordinary kernel write; must run before any pass. */
export function installState(signal: SignalLike, value: unknown): void {
	boundary()
	enter(() => E.kernelSet(signal.id, value))
	boundary()
}

export const __debug = {
	/** Run fn with reads resolving in COMMITTED context (per §10.1;
	 * useSignalEffect's context — the global retired-only form). */
	committed<T>(fn: () => T): T {
		const prev = currentCtx
		currentCtx = Ctx.COMMITTED
		try {
			return fn()
		} finally {
			currentCtx = prev
		}
	},
	/** Resolve a node's value in an explicit world (oracle comparisons). */
	readInWorld(signal: SignalLike, spec: WorldSpec): unknown {
		return enter(() => E.readInWorld(signal.id, spec))
	},
	/** Current seq counter (pass pins for explicit pass-world reads). */
	seqCounter(): number {
		return seqCounter
	},
	/** The atom's canonical (W0) kernel value. */
	kernelValue(signal: SignalLike): unknown {
		return enter(() => E.kernelAtomValue(signal.id))
	},
	isDirect(): boolean {
		return writeMode === Mode.DIRECT
	},
	truncateToken(token: number): void {
		enter(() => E.truncateToken(token))
		boundary()
	},
	sweep(): void {
		enter(() => {
			E.sweepTapes()
			E.maybeQuiesce()
		})
		boundary()
	},
	stats() {
		return {
			gNext,
			wNext,
			certNext,
			liveSlotMask,
			loggedAtomCount,
			seqCounter,
			walkCounter,
			eraFloor,
			overlayEpoch,
			unappliedEntries,
			writeMode: writeMode === Mode.DIRECT ? 'DIRECT' : 'LOGGED',
			pseudoFallbacks,
			liveMemos: enter(() => E.liveMemos()),
			recNext,
			pendingFreeLen: pendingFree.length,
			finalizePending: finalizeSkipped.size,
			liveWatcherCount: liveWatcherIds.size,
			memoValsLen: memoVals.length,
			planeBytes: (() => {
				const b = E.buffers()
				return (b.m.length + b.g.length + b.w.length + b.cert.length) * 4
			})(),
		}
	},
	/** Run the finalization path for a handle's record as the GC would
	 * (FinalizationRegistry timing is untestable without --expose-gc).
	 * Like the GC path, a guarded skip registers the reclaim retry. */
	simulateFinalize(signal: SignalLike, gen?: number): void {
		enter(() => E.finalizeRecord({ id: signal.id, gen: gen ?? E.gen(signal.id) }, true))
		boundary()
	},
	/** Number of per-world baseline entries a watcher holds (leak tests:
	 * must not grow with retired batches). */
	watcherBaselineCount(watcher: { id: number }): number {
		return metaCol[watcher.id >> 3]?.lastBroadcast?.size ?? 0
	},
	/** Positional thenable caches no longer exist (the node-held pending box
	 * is the only holder); always empty — kept for leak-test source compat. */
	thenableLineageKeys(_signal: SignalLike): number[] {
		return []
	},
	/** Is the node currently LIVE (transitively watched)? */
	isLive(signal: SignalLike): boolean {
		return E.isLive(signal.id)
	},
	/** Capture drain-internal decisions for debugging. */
	startTrace(): void {
		traceLog = []
	},
	takeTrace(): string[] {
		const t = traceLog ?? []
		traceLog = undefined
		return t
	},
	/** Force counter values (wrap-around unit tests, §17.2 pinned list). */
	forceCounters(opts: { walkCounter?: number; seqCounter?: number }): void {
		if (opts.walkCounter !== undefined) {
			walkCounter = opts.walkCounter
			if (eraFloor > walkCounter) {
				eraFloor = walkCounter
			}
		}
		if (opts.seqCounter !== undefined) {
			seqCounter = opts.seqCounter
		}
	},
	/** Invariant sweeper (verifyArena-lite): throws on the first violation
	 * with a description; run by the oracle after every step. */
	verify(): void {
		enter(() => E.verify())
	},
}
