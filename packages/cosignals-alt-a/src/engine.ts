/**
 * cosignals-alt-a engine — variant A (monotonic write-gate activation) of the
 * react-concurrent-signals-arena-alt-a spec, milestones M1–M3.
 *
 * M1: the canonical kernel is a port of the proven arena engine at
 * libs/arena/src/index.ts (alien-signals v3.2.1 semantics on interleaved
 * Int32Array records), extended with the spec's five overlay-support
 * mechanisms (§8.7): broadcast list, notify walk, mark repair on new edges,
 * invalidate, and log-plane allocation.
 * M2: tape mechanics — monotonic activation (§9.1), batch-slot interning
 * (§9.2), appendLog with mark-on-creation and the equality/receipt rule
 * (§9.3), applied/unapplied writes (§9.4), notify walk + token-grouped
 * drain (§9.8).
 * M3: worlds — visibility (§10.2–10.3), plane W world memos + certificates
 * + slot chains (§10.5), drain re-validation (§9.8), post-eval re-check
 * (§10.4), retirement/absorption (§9.5), sweep/truncation (§9.6),
 * coalescing (§9.3), quiescence + epoch bump (§9.7).
 *
 * Coordinator-adopted resolutions (see SPEC-RESOLUTIONS.md): urgent drains
 * decide in W0 PLUS every live deferred world (1,3); applied logged writes
 * always queue a token-0 walk (2); truncation re-notifies its batch's lane
 * (4); overlay frames always recurse via overlayEvaluate (5); one
 * retire-time ticket per retirement (7a); missing-world broadcast baseline
 * is the current W0 value, with subscription-time seeding of live deferred
 * worlds (7b). Grouped drains use one walk ticket PER TOKEN GROUP;
 * re-validation runs BEFORE broadcast decisions; re-validation snapshots
 * the old memo value before re-evaluating.
 *
 * Deviations this pass (perf work deferred; documented in the final report):
 * planes are `let` bindings grown in place by doubling (the spec's
 * const-closure rebuild is a measured perf design, not a semantic one);
 * the W certificate region is a separate Int32Array rather than the tail
 * half of plane W; constants are a hand-written same-file const enum
 * structured for the §15 codegen to take over later.
 */

// #region GENERATED — layout v2 (from tools/schema.ts; run pnpm gen) — DO NOT EDIT
const enum C {
	// ---- node record (plane M, stride 8): main plane: nodes and links interleaved (ids pre-multiplied by 8; record 0 burned) ----
	/** state machine + kind bits [flags; owner: alloc writes; free zeroes] */
	FLAGS = 0,
	/** first link of my dependency list; doubles as free-list next for freed node records [LinkId; owner: link/unlink; free threads] */
	DEPS = 1,
	/** last confirmed dependency link (the re-run cursor) [LinkId; owner: link/purgeDeps] */
	DEPS_TAIL = 2,
	/** first link of my subscriber list [LinkId; owner: linkInsert/unlink] */
	SUBS = 3,
	/** last subscriber link [LinkId; owner: linkInsert/unlink] */
	SUBS_TAIL = 4,
	/** generation counter, bumped on free; stale disposers no-op [u31; owner: freeNode bumps] */
	GEN = 5,
	/** atoms: first log record id in plane G (0 = no log). Aliased as OVERLAY_STAMP on non-atoms. [LogId; owner: appendLog creates; sweep clears] */
	LOG_HEAD = 6,
	/** atoms: last log record id. Aliased as MEMO_KEY on computeds. [LogId; owner: appendLog/sweep] */
	LOG_TAIL = 7,
	/** non-atoms: the walk ticket of the last notify walk that visited me (alias of LOG_HEAD) */
	OVERLAY_STAMP = 6,
	/** computeds: the first memo record's world key (alias of LOG_TAIL) */
	MEMO_KEY = 7,
	// ---- link record (plane M, stride 8): main plane: nodes and links interleaved (ids pre-multiplied by 8; record 0 burned) ----
	/** evaluation-cycle stamp: intra-run duplicate-read dedup [u31; owner: link stamps] */
	VERSION = 0,
	/** producer node id [NodeId; owner: linkInsert] */
	DEP = 1,
	/** consumer node id [NodeId; owner: linkInsert] */
	SUB = 2,
	/** position in the producer's subscriber list [LinkId; owner: linkInsert/unlink] */
	PREV_SUB = 3,
	/** position in the producer's subscriber list [LinkId; owner: linkInsert/unlink] */
	NEXT_SUB = 4,
	/** position in the consumer's dependency list [LinkId; owner: linkInsert/unlink] */
	PREV_DEP = 5,
	/** position in the consumer's dependency list; doubles as free-list next for freed link records [LinkId; owner: linkInsert/unlink; free threads] */
	NEXT_DEP = 6,
	// ---- log record (plane G, stride 4): log plane: write-log entries (ids pre-multiplied by 4; record 0 burned; bulk-reset at quiescence) ----
	/** next entry in this atom's log (append order = seq order); 0 = tail; doubles as free-list next [LogId; owner: appendLog/sweep; free threads] */
	L_NEXT = 0,
	/** packed: bits 0-1 OP, bit 2 APPLIED, bit 3 RETIRED, bits 4-8 BATCH_SLOT, bit 9 PSEUDO [flags; owner: appendLog writes; retirement stamps RETIRED] */
	L_META = 1,
	/** take-a-number ticket at append time [seq; owner: appendLog/coalesce] */
	L_SEQ = 2,
	/** 0 while the batch is pending; one fresh ticket stamped per retirement [seq; owner: retirement stamps] */
	L_RETIRED_SEQ = 3,
	// ---- memo record (plane W, stride 8): world-memo plane: overlay memo records (certificate region lives in a companion array; bulk-reset at quiescence) ----
	/** world key: newest 0; pass (serial<<2)|1; writer (token<<2)|2 [u31; owner: overlayEvaluate] */
	W_KEY = 0,
	/** overlayEpoch at evaluation time; 0 is the tombstone value (epochs start at 1) [u31; owner: overlayEvaluate; re-memoization tombstones] */
	W_EPOCH = 1,
	/** owning computed node id (drain re-validation + stale-head guard) [NodeId; owner: overlayEvaluate] */
	W_NODE = 2,
	/** index into the memoVals side array holding the memoized value [u31; owner: overlayEvaluate; tombstone clears the slot] */
	W_VAL = 3,
	/** next memo record for the same node (the node's memo chain) [MemoId; owner: overlayEvaluate prepends] */
	W_NEXT_MEMO = 4,
	/** writer's-world records only: next record in the batch slot's memo chain; 0 on other keys [MemoId; owner: overlayEvaluate; slot release clears heads] */
	W_SLOT_NEXT = 5,
	/** number of certificate pairs [u31; owner: overlayEvaluate] */
	W_NDEPS = 6,
	/** offset of this memo's certificate run in the certificate region [CertOff; owner: overlayEvaluate] */
	W_CERT = 7,
	// ---- flags (one 4-byte load carries state + kind) ----
	/** can produce new values (atoms, computeds) */
	MUTABLE = 1,
	/** wants notification when possibly stale (effects, watchers) */
	WATCHING = 2,
	/** currently evaluating (re-entrancy guard) */
	RECURSED_CHECK = 4,
	/** re-entrant write reached me during my own run */
	RECURSED = 8,
	/** definitely stale */
	DIRTY = 16,
	/** possibly stale - verify by pulling before recomputing */
	PENDING = 32,
	/** my dep list contains child effects/scopes (slow-path cleanup) */
	HAS_CHILD_EFFECT = 64,
	/** atoms only: LOG_HEAD !== 0. The read gate. */
	LOGGED = 128,
	/** watchers only: notify synchronously via the broadcast list instead of the effect queue */
	IMMEDIATE = 256,
	/** RESERVED: superseded by the liveCount side-column refcount (§8.6 conversion); bit kept for layout stability */
	LIVE = 512,
	/** kind bit: atom */
	K_ATOM = 1024,
	/** kind bit: computed */
	K_COMPUTED = 2048,
	/** kind bit: effect */
	K_EFFECT = 4096,
	/** kind bit: effect scope */
	K_SCOPE = 8192,
	/** kind bit: watcher (React hook subscription) */
	K_WATCHER = 16384,
	/** union of the kind bits; a freed record has FLAGS 0 */
	KIND_MASK = K_ATOM | K_COMPUTED | K_EFFECT | K_SCOPE | K_WATCHER,
	// ---- log META packing: bits 0-1 OP, bit 2 APPLIED, bit 3 RETIRED, bits 4-8 BATCH_SLOT, bit 9 PSEUDO (slot-exhaustion fallback) ----
	/** base record: the snapshot replays start from */
	OP_BASE = 0,
	/** SET: payload replaces the accumulator */
	OP_SET = 1,
	/** UPDATE: stored function applies to the accumulator */
	OP_UPDATE = 2,
	/** DISPATCH: the atom's reducer applies the stored action */
	OP_DISPATCH = 3,
	/** mask for the op bits */
	OP_MASK = 3,
	/** already written through the kernel (urgent writes) */
	M_APPLIED = 4,
	/** the entry's batch retired */
	M_RETIRED = 8,
	/** batch slot starts at bit 4 */
	SLOT_SHIFT = 4,
	/** 5 bits: 32 slots */
	SLOT_MASK = 31,
	/** always-included pseudo-batch fallback (degrades toward urgent) */
	M_PSEUDO = 512,
	// ---- read contexts: per-read ambient context (a module scalar, kept correct by fork edges) ----
	/** default: everything visible (Wn) */
	CTX_NEWEST = 1,
	/** while React executes render code: the pass world (Wp) */
	CTX_RENDER = 2,
	/** useSignalEffect callbacks and SSR: committed views */
	CTX_COMMITTED = 3,
	// ---- world kinds: internal world-descriptor discriminants ----
	/** the canonical world (committed + applied) the kernel maintains */
	WK_W0 = 0,
	/** every write visible */
	WK_NEWEST = 1,
	/** a render pass: pin + include mask */
	WK_PASS = 2,
	/** a batch's writer world: retired + applied + own entries */
	WK_WRITER = 3,
	/** committed views: retired-only, per-root refined by pin + lock-in mask */
	WK_COMMITTED = 4,
	// ---- write modes: the §9.1 monotonic gate ----
	/** pure kernel writes (pre-activation, servers) */
	MODE_DIRECT = 0,
	/** every write is logged - permanently after first root registration */
	MODE_LOGGED = 1,
	// ---- named constants ----
	/** infinity for pin comparisons */
	MAX_SEQ = 0x7fffffff,
}
// #endregion GENERATED layout v2

import type { Container, ExternalRuntimeListener, ForkAdapter } from './fork-double';
export type { Container } from './fork-double';
import type { Tracer } from './tracing';
import { TraceKind } from './tracing';

// ---- public types -----------------------------------------------------------

export type Equality<T> = (a: T, b: T) => boolean;

export type AtomHandle<T> = {
	readonly kind: 'atom';
	readonly id: number;
	readonly state: T;
	peek(): T;
	set(next: T): void;
	update(fn: (current: T) => T): void;
};

export type ReducerAtomHandle<S, A> = {
	readonly kind: 'reducerAtom';
	readonly id: number;
	readonly state: S;
	peek(): S;
	dispatch(action: A): void;
};

export type ComputedHandle<T> = {
	readonly kind: 'computed';
	readonly id: number;
	readonly state: T;
};

export type SignalHandle = { readonly id: number };

export type WatcherHandle = {
	readonly id: number;
	dispose(): void;
};

export type BroadcastEvent = {
	watcherId: number;
	/** Batch token whose lane the setState was scheduled into; 0 = urgent. */
	token: number;
	/** The value the watched node had in the decision world. */
	value: unknown;
	/** Token the fork reported as current write batch inside the callback —
	 * lane-parity evidence for tests (equals `token` when entangled). */
	forkBatchDuringCallback: number;
};

export type WorldSelector =
	| { kind: 'w0' }
	| { kind: 'newest' }
	| { kind: 'committed' }
	| { kind: 'committedOn'; container: Container }
	| { kind: 'writer'; token: number }
	| { kind: 'pass' }
	| { kind: 'rendered'; pin: number; tokens: readonly number[] };

export type EngineOptions = {
	initialRecords?: number; // main-plane records (default 8192)
	initialLogRecords?: number; // log-plane records (default 1024)
	initialMemoRecords?: number; // memo-plane records (default 1024)
	/** §14.2: register atom/computed handles with a FinalizationRegistry that
	 * reclaims their records when the handles are garbage-collected.
	 * ON BY DEFAULT ("we should never leak"). Pass `false` to opt out for
	 * zero FR overhead, accepting the bounded leak: each dropped unwatched
	 * handle then pins exactly its own record + side slots, forever.
	 * CAVEAT (inherent to JS, both modes): a computed whose fn closure was
	 * created in a scope that also captures the handle keeps the handle
	 * reachable through the shared closure context — create the fn in its
	 * own scope (e.g. a factory function) if you rely on GC reclamation. */
	finalization?: boolean;
};

type WorldDesc = {
	k: number; // C.WK_*
	key: number; // memo key (§10.5); -1 = not memoized
	token: number; // writer worlds
	slot: number; // writer worlds
	pin: number; // pass worlds
	mask: number; // pass worlds
};

type NodeMeta = {
	label?: string;
	isEqual?: Equality<unknown>;
	reducer?: (state: unknown, action: unknown) => unknown;
	rawFn?: () => unknown;
	lastBroadcast?: Map<number, unknown>;
	watchedId?: number;
	onBroadcast?: (ev: BroadcastEvent) => void;
	observeEffect?: (ctx: {
		peek(): unknown;
		set(v: unknown): void;
		update(f: (x: unknown) => unknown): void;
	}) => (() => void) | void;
};

export function createCosignalEngine(options?: EngineOptions) {
	// ---- planes ---------------------------------------------------------------
	let M = new Int32Array((options?.initialRecords ?? 8192) * 8);
	let G = new Int32Array((options?.initialLogRecords ?? 1024) * 4);
	let W = new Int32Array((options?.initialMemoRecords ?? 1024) * 8);
	let WC = new Int32Array((options?.initialMemoRecords ?? 1024) * 8); // certificate region

	// Bump pointers (record 0 burned in every plane) and free lists.
	let recNext = 8;
	let nodeFreeHead = 0;
	let linkFreeHead = 0;
	let gNext = 4;
	let logFreeHead = 0;
	let wNext = 8;
	let certNext = 2; // offset 0 burned so CERT=0 can mean "none"

	// ---- side columns -----------------------------------------------------------
	const values: unknown[] = [undefined, undefined];
	const fns: (Function | undefined)[] = [undefined];
	const memos: number[] = [0]; // node memo-chain heads (guarded by W_NODE check)
	// Era-scoped "some atom below me holds UNAPPLIED entries" stamps (walk
	// tickets, valid while > eraFloor). This is what lets NEWEST reads keep
	// the kernel path when only unrelated cones carry pending deferred writes
	// (the §17.5(b) invisibility requirement) — the global unappliedEntries
	// gate of §10.4 alone would degrade every marked cone.
	const unappliedStamp: number[] = [0];
	const atomUnapplied = new Map<number, number>(); // atomId → unapplied entry count
	const metas: (NodeMeta | undefined)[] = [undefined];
	const logVals: unknown[] = [undefined];
	const memoVals: unknown[] = [];
	const memoCheckedAt: number[] = [0]; // per memo record: certGen at last validation
	const newestValidAt: number[] = [0]; // per node: certGen when values[+1] cached a NEWEST value
	// §8.6 as a REFCOUNT (owner-approved conversion): per-node count of LIVE
	// direct subscribers, in a side column (plane M has no spare slot and the
	// count must stay out of the kernel-rewritten flags word).
	// LIVE(node) := liveCount > 0 || intrinsically live (effect/scope/watcher).
	const liveCount: number[] = [0];

	// ---- kernel scalars -----------------------------------------------------------
	let cycle = 0;
	let runDepth = 0;
	let batchDepth = 0;
	let notifyIndex = 0;
	let queuedLength = 0;
	let activeSub = 0;
	let enterDepth = 0;
	const queued: number[] = [];
	const pendingFree: number[] = [];

	// ---- overlay scalars -----------------------------------------------------------
	let writeMode: number = C.MODE_DIRECT;
	let seqCounter = 1; // ticket() pre-increments; resets to 1 at quiescence
	let walkCounter = 0;
	let eraFloor = 0;
	let overlayEpoch = 1;
	// certGen: bumped by EVERY event that can move any certificate input
	// (append/coalesce/tape-create, sweep fold/free, truncation, quiescence).
	// A memo validated at the current certGen is valid without a scan — the
	// O(1) shortcut that makes marked-cone memo hits approach DIRECT reads.
	let certGen = 1;
	let loggedAtomCount = 0;
	let unappliedEntries = 0;
	let quiescenceCount = 0;
	const loggedAtoms: number[] = [];
	const allNodes: number[] = []; // for the walk-counter safety valve + verify

	const batchToken = new Int32Array(32);
	const batchEntryCount = new Int32Array(32);
	const slotMemoHead = new Int32Array(32);
	let liveSlotMask = 0;
	let liveDeferredMask = 0;
	let retiredSlotMask = 0; // token retired, entries not yet fully swept
	let slotChainMask = 0; // slots whose writer's-world memo chain is nonempty
	let slotOccupiedMask = 0; // slots holding any token (live or retired-unswept)
	let lastToken = 0;
	let lastSlot = -1;

	// Pass set (§10.1). One pass at a time (§6.3).
	let passOpen = 0;
	let passExecuting = 0;
	let passSerial = 0;
	let passPin = 0;
	let passIncludeMask = 0;
	let passIncludePseudo = 0;
	let passContainer: Container = undefined;
	let passLineage = 0;
	let readCtx: number = C.CTX_NEWEST;

	// Evaluation-mode tracking.
	let canonicalEvalDepth = 0; // inside kernel updateComputed / first-eval
	let untrackedDepth = 0; // inside untracked(): reads record no certificate pairs
	// Overlay evaluation frames (world stack); certStack is the collector.
	const frameWorlds: WorldDesc[] = [];
	let certStack = new Int32Array(4096);
	let certSp = 0;

	// Pending notify-walk requests: flat (atomId, token) pairs awaiting drain.
	const pendingWalks: number[] = [];
	const fastCollect: number[] = []; // reusable drain fast-path collector
	let sweepNeeded = false; // set at retirement/truncation/pass-end; consumed by settle
	// Kernel broadcast queue (watcher ids; kernel propagate pushes token 0).
	const kernelBroadcasts: number[] = [];
	let drainDepth = 0;
	// Observable drain output, consumed by debug.takeBroadcasts(). Bounded:
	// production callers observe via onBroadcast callbacks and never drain
	// this log, so an uncapped log would pin one event (value included) per
	// broadcast forever. Oldest events drop past the cap; the drop count is
	// visible in debug.stats().
	const broadcastLog: BroadcastEvent[] = [];
	const BROADCAST_LOG_CAP = 16384;
	let broadcastLogDropped = 0;

	// Policy configuration (§4.4 configure).
	let forbidWritesInComputeds = false;
	// Observed-lifecycle (§12.4): microtask-debounced LIVE-transition delivery.
	const lifecyclePending = new Map<number, boolean>(); // atomId → latest LIVE state
	const lifecycleDelivered = new Map<number, { cleanup?: () => void }>();
	let lifecycleScheduled = false;

	// §13.4 per-root committed views: container → {pin, mask}.
	const rootViews = new Map<Container, { pin: number; mask: number }>();
	const commitListeners = new Set<(container: Container) => void>();

	// §16.1 the tracer slot: one `tracer !== undefined` check per emit site.
	let tracer: Tracer | undefined;

	// §14.2: reclaim an unreachable (or deterministically disposed) atom or
	// computed record. Conservative guards: never reclaim a node that still
	// has subscribers (a live closure would have kept the handle reachable)
	// or an atom with a live tape (the sweep owns that lifecycle).
	//
	// `fromFinalizer` marks GC-driven reclaims (the handle is provably
	// unreachable): a guarded skip is recorded in `finalizeSkipped` and
	// retried when the blocking reference drops (last subscriber unlinks /
	// tape sweeps away). Without the retry, a FinalizationRegistry callback
	// that lost the race fires exactly once and the record leaks forever.
	// Deterministic `reclaim()` calls never register a retry: the caller may
	// legitimately keep using the handle after a guarded skip.
	function reclaimNode(id: number, gen: number, fromFinalizer = false): void {
		if (M[id + C.GEN] !== gen || (M[id + C.FLAGS] & (C.K_ATOM | C.K_COMPUTED)) === 0) {
			finalizeSkipped.delete(id);
			return;
		}
		if (M[id + C.SUBS] !== 0 || (M[id + C.FLAGS] & C.LOGGED) !== 0) {
			if (fromFinalizer) {
				finalizeSkipped.set(id, gen);
			}
			return;
		}
		finalizeSkipped.delete(id);
		disposeAllDepsInReverse(id);
		M[id + C.FLAGS] = 0;
		pendingFree.push(id);
		maybeBoundary();
	}

	// GC-skipped reclaims awaiting their blocking reference to drop.
	const finalizeSkipped = new Map<number, number>(); // id → gen
	// Trigger queue: ids whose blocking condition JUST cleared (mid-operation
	// sites push here; maybeBoundary retries at a safe boundary).
	const finalizeRetry: number[] = [];

	function noteReclaimRetry(id: number): void {
		if (finalizeSkipped.size !== 0 && finalizeSkipped.has(id)) {
			finalizeRetry.push(id);
		}
	}

	function processFinalizeRetries(): void {
		while (finalizeRetry.length !== 0) {
			const batch = finalizeRetry.splice(0, finalizeRetry.length);
			for (const id of batch) {
				const gen = finalizeSkipped.get(id);
				if (gen !== undefined) {
					reclaimNode(id, gen, true);
				}
			}
		}
	}

	// §14.2 — ON BY DEFAULT ("we should never leak"): dropped atom/computed
	// handles are reclaimed via FinalizationRegistry. Pass
	// `finalization: false` to opt out (zero FR overhead, accepting the
	// bounded per-record leak for dropped never-watched handles).
	const finalizationEnabled = options?.finalization !== false;
	const finalizer = finalizationEnabled && typeof FinalizationRegistry !== 'undefined'
		? new FinalizationRegistry<number | { id: number; gen: number }>((held) => {
			// Packed number heldValue: gen * 2^32 + id — exact while
			// gen < 2^21; the (allocating) object form is the overflow
			// fallback, so correctness never rides on the packing range.
			if (typeof held === 'number') {
				reclaimNode(held % 0x100000000, Math.floor(held / 0x100000000), true);
			} else {
				reclaimNode(held.id, held.gen, true);
			}
		})
		: undefined;

	// Register a tiny token object OWNED by the handle instead of the handle
	// itself: the token dies in the same GC cycle as its handle (the handle
	// holds the token's only strong reference), and registering a slot-free
	// {} is much cheaper than registering the closure-rich handle — V8's
	// weak-target processing of a dying registered object scales with the
	// target's shape (measured: +41ns/handle direct vs +16.5ns via token,
	// token allocation included). The token rides in the handle literal so
	// handle shapes stay monomorphic.
	function newFinToken(id: number): object | undefined {
		if (finalizer === undefined) {
			return undefined;
		}
		const token = {};
		const gen = M[id + C.GEN];
		// SMI heldValue for fresh records (gen 0, the common case) — a packed
		// HeapNumber (and the rare {id, gen} overflow form) costs an extra
		// young-gen allocation per registration.
		finalizer.register(token, gen === 0 ? id : gen < 0x200000 ? gen * 0x100000000 + id : { id, gen });
		return token;
	}

	// Fork wiring.
	let fork: ForkAdapter | undefined;
	let unsubscribeFork: (() => void) | undefined;

	// Persistent traversal scratch (saved-base discipline).
	let propStack = new Int32Array(4096);
	let propSp = 0;
	let checkStack = new Int32Array(4096);
	let checkSp = 0;

	// ---- plane growth (in-place doubling; see header deviation note) -----------
	function growM(): void {
		const bigger = new Int32Array(M.length * 2);
		bigger.set(M);
		M = bigger;
	}
	function growG(): void {
		const bigger = new Int32Array(G.length * 2);
		bigger.set(G);
		G = bigger;
	}
	function growW(): void {
		const bigger = new Int32Array(W.length * 2);
		bigger.set(W);
		W = bigger;
	}
	function growWC(): void {
		const bigger = new Int32Array(WC.length * 2);
		bigger.set(WC);
		WC = bigger;
	}
	function growCertStack(): void {
		const bigger = new Int32Array(certStack.length * 2);
		bigger.set(certStack);
		certStack = bigger;
	}

	// ---- allocation ---------------------------------------------------------------
	function allocNode(flags: number): number {
		let id: number;
		if (nodeFreeHead !== 0) {
			id = nodeFreeHead;
			nodeFreeHead = M[id + C.DEPS];
			M[id + C.DEPS] = 0;
		} else {
			id = recNext;
			if (id >= M.length) {
				growM();
			}
			recNext = id + 8;
			allNodes.push(id);
		}
		M[id + C.FLAGS] = flags;
		const v = id >> 2;
		while (values.length <= v + 1) {
			values.push(undefined);
		}
		while (fns.length <= id >> 3) {
			fns.push(undefined);
			memos.push(0);
			metas.push(undefined);
			unappliedStamp.push(0);
			newestValidAt.push(0);
			liveCount.push(0);
		}
		return id;
	}

	function freeNode(id: number): void {
		M[id + C.FLAGS] = 0;
		M[id + C.DEPS_TAIL] = 0;
		M[id + C.SUBS] = 0;
		M[id + C.SUBS_TAIL] = 0;
		M[id + C.LOG_HEAD] = 0;
		M[id + C.LOG_TAIL] = 0;
		++M[id + C.GEN];
		liveCount[id >> 3] = 0;
		const v = id >> 2;
		values[v] = undefined;
		values[v + 1] = undefined;
		fns[id >> 3] = undefined;
		// Tombstone this node's world memos BEFORE dropping the chain head:
		// slot-chain re-validation skips epoch-0 records, and the memoVals
		// slots must not pin the dead node's values until quiescence.
		let mrec = memos[id >> 3];
		while (mrec !== 0 && mrec < wNext && W[mrec + C.W_NODE] === id) {
			W[mrec + C.W_EPOCH] = 0;
			memoVals[W[mrec + C.W_VAL]] = undefined;
			mrec = W[mrec + C.W_NEXT_MEMO];
		}
		memos[id >> 3] = 0;
		metas[id >> 3] = undefined;
		// Side-array hygiene at the free site: a recycled record must not
		// inherit the previous occupant's unapplied stamp or NEWEST-cache
		// validation (a stale newestValidAt equal to the current certGen would
		// serve the cleared values[+1] slot as a valid cached value).
		unappliedStamp[id >> 3] = 0;
		newestValidAt[id >> 3] = 0;
		if (finalizeSkipped.size !== 0) {
			finalizeSkipped.delete(id);
		}
		M[id + C.DEPS] = nodeFreeHead;
		nodeFreeHead = id;
	}

	function sweepPendingFree(): void {
		for (let i = 0; i < pendingFree.length; ++i) {
			freeNode(pendingFree[i]);
		}
		pendingFree.length = 0;
	}

	function allocLink(): number {
		let id: number;
		if (linkFreeHead !== 0) {
			id = linkFreeHead;
			linkFreeHead = M[id + C.NEXT_DEP];
		} else {
			id = recNext;
			if (id >= M.length) {
				growM();
			}
			recNext = id + 8;
		}
		return id;
	}

	function freeLink(id: number): void {
		M[id + C.NEXT_DEP] = linkFreeHead;
		linkFreeHead = id;
	}

	function allocLog(): number {
		let gid: number;
		if (logFreeHead !== 0) {
			gid = logFreeHead;
			logFreeHead = G[gid + C.L_NEXT];
		} else {
			gid = gNext;
			if (gid >= G.length) {
				growG();
			}
			gNext = gid + 4;
		}
		G[gid + C.L_NEXT] = 0;
		while (logVals.length <= gid >> 2) {
			logVals.push(undefined);
		}
		return gid;
	}

	function freeLog(gid: number): void {
		logVals[gid >> 2] = undefined;
		G[gid + C.L_NEXT] = logFreeHead;
		logFreeHead = gid;
	}

	function allocMemo(): number {
		const wid = wNext;
		if (wid >= W.length) {
			growW();
		}
		wNext = wid + 8;
		while (memoCheckedAt.length <= wid >> 3) {
			memoCheckedAt.push(0);
		}
		return wid;
	}

	// ---- kernel: topology (arena transliteration) --------------------------------
	function link(dep: number, sub: number, version: number): void {
		const prevDep = M[sub + C.DEPS_TAIL];
		if (prevDep !== 0 && M[prevDep + C.DEP] === dep) {
			return;
		}
		const nextDep = prevDep !== 0 ? M[prevDep + C.NEXT_DEP] : M[sub + C.DEPS];
		if (nextDep !== 0 && M[nextDep + C.DEP] === dep) {
			M[nextDep + C.VERSION] = version;
			M[sub + C.DEPS_TAIL] = nextDep;
			return;
		}
		linkInsert(dep, sub, version, prevDep, nextDep);
	}

	// Out-of-line insertion tail (kept split per §8.2/§18.3). The overlay's
	// mark repair (§8.7.3) lives here — never in link().
	function linkInsert(dep: number, sub: number, version: number, prevDep: number, nextDep: number): void {
		const prevSub = M[dep + C.SUBS_TAIL];
		if (prevSub !== 0 && M[prevSub + C.VERSION] === version && M[prevSub + C.SUB] === sub) {
			return;
		}
		const newLink = allocLink();
		M[sub + C.DEPS_TAIL] = newLink;
		M[dep + C.SUBS_TAIL] = newLink;
		M[newLink + C.VERSION] = version;
		M[newLink + C.DEP] = dep;
		M[newLink + C.SUB] = sub;
		M[newLink + C.PREV_DEP] = prevDep;
		M[newLink + C.NEXT_DEP] = nextDep;
		M[newLink + C.PREV_SUB] = prevSub;
		M[newLink + C.NEXT_SUB] = 0;
		if (nextDep !== 0) {
			M[nextDep + C.PREV_DEP] = newLink;
		}
		if (prevDep !== 0) {
			M[prevDep + C.NEXT_DEP] = newLink;
		} else {
			M[sub + C.DEPS] = newLink;
		}
		if (prevSub !== 0) {
			M[prevSub + C.NEXT_SUB] = newLink;
		} else {
			M[dep + C.SUBS] = newLink;
		}
		// §8.6: a live consumer's new edge contributes one live subscriber to
		// the producer (cascades only on the producer's 0-crossing).
		if (isLiveNode(sub)) {
			incLive(dep);
		}
		// Overlay mark repair (§8.7.3): a canonical evaluation just picked up a
		// logged/marked producer mid-era — stamp the consumer's cone so
		// world-sensitive readers stop trusting kernel caches below it.
		if (loggedAtomCount !== 0) {
			const df = M[dep + C.FLAGS];
			const producerMarked =
				(df & C.LOGGED) !== 0
				|| ((df & C.K_ATOM) === 0 && M[dep + C.OVERLAY_STAMP] > eraFloor);
			if (producerMarked) {
				const producerUnapplied = (df & C.K_ATOM) !== 0
					? (atomUnapplied.get(dep) ?? 0) > 0
					: unappliedStamp[dep >> 3] > eraFloor;
				// A FRESH ticket, not the current counter: an earlier walk in
				// this very drain may have stamped the consumer with the current
				// ticket, and stampCone's dedup would then skip the repair —
				// dropping the unapplied stamp this new edge must propagate.
				stampCone(sub, ++walkCounter, false, producerUnapplied);
			}
		}
	}

	// ---- §8.6 liveness: LIVE flows down dependency lists when the boundary moves ----
	function onAtomLiveChange(a: number, live: boolean): void {
		if (metas[a >> 3]?.observeEffect !== undefined) {
			lifecyclePending.set(a, live);
			if (!lifecycleScheduled) {
				lifecycleScheduled = true;
				queueMicrotask(drainLifecycle);
			}
		}
	}

	function drainLifecycle(): void {
		lifecycleScheduled = false;
		const work = [...lifecyclePending];
		lifecyclePending.clear();
		for (const [a, live] of work) {
			const meta = metas[a >> 3];
			const delivered = lifecycleDelivered.get(a);
			if (live && delivered === undefined) {
				const observe = meta?.observeEffect;
				if (observe === undefined) {
					continue;
				}
				const ctx = {
					peek: () => pendingValueOf(a),
					set: (v: unknown) => writeOp(a, C.OP_SET, v),
					update: (f: (x: unknown) => unknown) => writeOp(a, C.OP_UPDATE, f),
				};
				const cleanup = observe(ctx) as (() => void) | void;
				lifecycleDelivered.set(a, { cleanup: cleanup ?? undefined });
			} else if (!live && delivered !== undefined) {
				lifecycleDelivered.delete(a);
				delivered.cleanup?.();
			}
			// A flap within one tick nets to no delivery (§12.4 debounce).
		}
	}

	function isLiveNode(id: number): boolean {
		return liveCount[id >> 3] > 0
			|| (M[id + C.FLAGS] & (C.K_EFFECT | C.K_SCOPE | C.K_WATCHER)) !== 0;
	}

	// Refcount transitions cascade ONLY on 0-crossings, and only for nodes
	// whose liveness the count actually determines (intrinsically live
	// effects/scopes/watchers never change liveness from count movement).
	function incLive(dep: number): void {
		if (++liveCount[dep >> 3] === 1) {
			const flags = M[dep + C.FLAGS];
			if ((flags & (C.K_EFFECT | C.K_SCOPE | C.K_WATCHER)) !== 0) {
				return; // intrinsic: no liveness change
			}
			if ((flags & C.K_ATOM) !== 0) {
				onAtomLiveChange(dep, true);
				return;
			}
			// The node became live: it now counts as a live subscriber of each
			// of its own dependencies.
			let lnk = M[dep + C.DEPS];
			while (lnk !== 0) {
				incLive(M[lnk + C.DEP]);
				lnk = M[lnk + C.NEXT_DEP];
			}
		}
	}

	function decLive(dep: number): void {
		if (--liveCount[dep >> 3] === 0) {
			const flags = M[dep + C.FLAGS];
			if ((flags & (C.K_EFFECT | C.K_SCOPE | C.K_WATCHER)) !== 0) {
				return;
			}
			if ((flags & C.K_ATOM) !== 0) {
				onAtomLiveChange(dep, false);
				return;
			}
			let lnk = M[dep + C.DEPS];
			while (lnk !== 0) {
				decLive(M[lnk + C.DEP]);
				lnk = M[lnk + C.NEXT_DEP];
			}
		}
	}

	function unlink(id: number, sub = M[id + C.SUB]): number {
		const dep = M[id + C.DEP];
		const prevDep = M[id + C.PREV_DEP];
		const nextDep = M[id + C.NEXT_DEP];
		const nextSub = M[id + C.NEXT_SUB];
		const prevSub = M[id + C.PREV_SUB];
		if (nextDep !== 0) {
			M[nextDep + C.PREV_DEP] = prevDep;
		} else {
			M[sub + C.DEPS_TAIL] = prevDep;
		}
		if (prevDep !== 0) {
			M[prevDep + C.NEXT_DEP] = nextDep;
		} else {
			M[sub + C.DEPS] = nextDep;
		}
		if (nextSub !== 0) {
			M[nextSub + C.PREV_SUB] = prevSub;
		} else {
			M[dep + C.SUBS_TAIL] = prevSub;
		}
		freeLink(id);
		if (prevSub !== 0) {
			M[prevSub + C.NEXT_SUB] = nextSub;
		} else if ((M[dep + C.SUBS] = nextSub) === 0) {
			unwatched(dep);
		}
		// §8.6: a live subscriber's departure releases its contribution.
		// Exact pairing note: dispose() cascades its own departure BEFORE
		// zeroing flags/unlinking, so a disposed sub reads not-live here and
		// is never double-decremented.
		if (isLiveNode(sub)) {
			decLive(dep);
		}
		return nextDep;
	}

	// ---- kernel: traversals ---------------------------------------------------
	function propagate(startLink: number, innerWrite: boolean): void {
		let cur = startLink;
		let next = M[cur + C.NEXT_SUB];
		const stackBase = propSp;

		top: do {
			const sub = M[cur + C.SUB];
			let flags = M[sub + C.FLAGS];

			if (!(flags & (C.RECURSED_CHECK | C.RECURSED | C.DIRTY | C.PENDING))) {
				M[sub + C.FLAGS] = flags | C.PENDING;
				if (innerWrite) {
					M[sub + C.FLAGS] |= C.RECURSED;
				}
			} else if (!(flags & (C.RECURSED_CHECK | C.RECURSED))) {
				flags = 0;
			} else if (!(flags & C.RECURSED_CHECK)) {
				M[sub + C.FLAGS] = (flags & ~C.RECURSED) | C.PENDING;
			} else if (!(flags & (C.DIRTY | C.PENDING)) && isValidLink(cur, sub)) {
				M[sub + C.FLAGS] = flags | (C.RECURSED | C.PENDING);
				flags &= C.MUTABLE;
			} else {
				flags = 0;
			}

			if (flags & C.WATCHING) {
				// Overlay-support #1 (§8.7.1): IMMEDIATE watchers route to the
				// broadcast list (token 0 — urgent) instead of the effect queue.
				if (M[sub + C.FLAGS] & C.IMMEDIATE) {
					kernelBroadcasts.push(sub);
				} else {
					notify(sub);
				}
			}

			if (flags & C.MUTABLE) {
				const subSubs = M[sub + C.SUBS];
				if (subSubs !== 0) {
					cur = subSubs;
					const nextSub = M[cur + C.NEXT_SUB];
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
				next = M[cur + C.NEXT_SUB];
				continue;
			}

			while (propSp > stackBase) {
				cur = propStack[--propSp];
				if (cur !== 0) {
					next = M[cur + C.NEXT_SUB];
					continue top;
				}
			}

			break;
		} while (true);
	}

	function checkDirty(startLink: number, startSub: number): boolean {
		let cur = startLink;
		let sub = startSub;
		const stackBase = checkSp;
		let checkDepth = 0;
		let dirty = false;

		try {
			top: do {
				const dep = M[cur + C.DEP];
				const depFlags = M[dep + C.FLAGS];

				if (M[sub + C.FLAGS] & C.DIRTY) {
					dirty = true;
				} else if ((depFlags & (C.MUTABLE | C.DIRTY)) === (C.MUTABLE | C.DIRTY)) {
					const depSubs = M[dep + C.SUBS];
					if (update(dep)) {
						if (M[depSubs + C.NEXT_SUB] !== 0) {
							shallowPropagate(depSubs);
						}
						dirty = true;
					}
				} else if ((depFlags & (C.MUTABLE | C.PENDING)) === (C.MUTABLE | C.PENDING)) {
					if (checkSp === checkStack.length) {
						const bigger = new Int32Array(checkStack.length * 2);
						bigger.set(checkStack);
						checkStack = bigger;
					}
					checkStack[checkSp++] = cur;
					cur = M[dep + C.DEPS];
					sub = dep;
					++checkDepth;
					continue;
				}

				if (!dirty) {
					const nextDep = M[cur + C.NEXT_DEP];
					if (nextDep !== 0) {
						cur = nextDep;
						continue;
					}
				}

				while (checkDepth--) {
					cur = checkStack[--checkSp];
					if (dirty) {
						const subSubs = M[sub + C.SUBS];
						if (update(sub)) {
							if (M[subSubs + C.NEXT_SUB] !== 0) {
								shallowPropagate(subSubs);
							}
							sub = M[cur + C.SUB];
							continue;
						}
						dirty = false;
					} else {
						M[sub + C.FLAGS] &= ~C.PENDING;
					}
					sub = M[cur + C.SUB];
					const nextDep = M[cur + C.NEXT_DEP];
					if (nextDep !== 0) {
						cur = nextDep;
						continue top;
					}
				}

				return dirty && M[sub + C.FLAGS] !== 0;
			} while (true);
		} finally {
			checkSp = stackBase;
		}
	}

	function shallowPropagate(startLink: number): void {
		let cur = startLink;
		do {
			const sub = M[cur + C.SUB];
			const flags = M[sub + C.FLAGS];
			if ((flags & (C.PENDING | C.DIRTY)) === C.PENDING) {
				M[sub + C.FLAGS] = flags | C.DIRTY;
				if ((flags & (C.WATCHING | C.RECURSED_CHECK)) === C.WATCHING) {
					if (flags & C.IMMEDIATE) {
						kernelBroadcasts.push(sub);
					} else {
						notify(sub);
					}
				}
			}
		} while ((cur = M[cur + C.NEXT_SUB]) !== 0);
	}

	function isValidLink(checkLink: number, sub: number): boolean {
		let cur = M[sub + C.DEPS_TAIL];
		while (cur !== 0) {
			if (cur === checkLink) {
				return true;
			}
			cur = M[cur + C.PREV_DEP];
		}
		return false;
	}

	// ---- kernel: kind dispatch and scheduling ----------------------------------
	function update(node: number): boolean {
		const flags = M[node + C.FLAGS];
		if (flags & C.K_COMPUTED) {
			return updateComputed(node);
		}
		if (flags & C.K_ATOM) {
			return updateAtom(node);
		}
		M[node + C.FLAGS] = (flags & (C.KIND_MASK | C.IMMEDIATE)) | C.MUTABLE;
		return true;
	}

	function notify(e: number): void {
		let insertIndex = queuedLength;
		const firstInsertedIndex = insertIndex;

		do {
			queued[insertIndex++] = e;
			M[e + C.FLAGS] &= ~C.WATCHING;
			const subs = M[e + C.SUBS];
			e = subs !== 0 ? M[subs + C.SUB] : 0;
			if (e === 0 || !(M[e + C.FLAGS] & C.WATCHING) || M[e + C.FLAGS] & C.IMMEDIATE) {
				break;
			}
		} while (true);

		queuedLength = insertIndex;

		let left = firstInsertedIndex;
		while (left < --insertIndex) {
			const tmp = queued[left];
			queued[left++] = queued[insertIndex];
			queued[insertIndex] = tmp;
		}
	}

	function unwatched(node: number): void {
		const flags = M[node + C.FLAGS];
		if (flags & C.K_COMPUTED) {
			if (M[node + C.DEPS_TAIL] !== 0) {
				M[node + C.FLAGS] = C.K_COMPUTED | C.MUTABLE | C.DIRTY | (flags & C.LOGGED);
				disposeAllDepsInReverse(node);
			}
			noteReclaimRetry(node); // last subscriber gone: retry a GC-skipped reclaim
		} else if (flags & C.K_ATOM) {
			noteReclaimRetry(node); // last subscriber gone: retry a GC-skipped reclaim
		} else if (flags & (C.K_EFFECT | C.K_SCOPE | C.K_WATCHER)) {
			dispose(node);
		}
	}

	function unlinkChildEffects(sub: number): void {
		let cur = M[sub + C.DEPS_TAIL];
		while (cur !== 0) {
			const prev = M[cur + C.PREV_DEP];
			const dep = M[cur + C.DEP];
			if (!(M[dep + C.FLAGS] & (C.K_COMPUTED | C.K_ATOM))) {
				unlink(cur, sub);
			}
			cur = prev;
		}
	}

	function updateComputed(c: number): boolean {
		if (M[c + C.FLAGS] & C.HAS_CHILD_EFFECT) {
			unlinkChildEffects(c);
		}
		M[c + C.DEPS_TAIL] = 0;
		M[c + C.FLAGS] = C.K_COMPUTED | C.MUTABLE | C.RECURSED_CHECK;
		const prevSub = activeSub;
		activeSub = c;
		++enterDepth;
		++canonicalEvalDepth;
		try {
			++cycle;
			const v = c >> 2;
			const oldValue = values[v];
			return oldValue !== (values[v] = (fns[c >> 3] as (previousValue?: unknown) => unknown)(oldValue));
		} finally {
			--canonicalEvalDepth;
			--enterDepth;
			activeSub = prevSub;
			M[c + C.FLAGS] &= ~C.RECURSED_CHECK;
			purgeDeps(c);
		}
	}

	function updateAtom(s: number): boolean {
		M[s + C.FLAGS] = (M[s + C.FLAGS] & C.LOGGED) | C.K_ATOM | C.MUTABLE;
		const v = s >> 2;
		return values[v] !== (values[v] = values[v + 1]);
	}

	function run(e: number): void {
		const flags = M[e + C.FLAGS];
		if (
			flags & C.DIRTY
			|| (flags & C.PENDING && checkDirty(M[e + C.DEPS], e))
		) {
			if (flags & C.HAS_CHILD_EFFECT) {
				unlinkChildEffects(e);
			}
			const cv = (e >> 2) + 1;
			if (values[cv]) {
				runCleanup(e);
				if (M[e + C.FLAGS] === 0) {
					return;
				}
			}
			M[e + C.DEPS_TAIL] = 0;
			M[e + C.FLAGS] = C.K_EFFECT | C.WATCHING | C.RECURSED_CHECK;
			const prevSub = activeSub;
			activeSub = e;
			++enterDepth;
			try {
				++cycle;
				++runDepth;
				values[cv] = (fns[e >> 3] as () => (() => void) | void)();
			} finally {
				--runDepth;
				--enterDepth;
				activeSub = prevSub;
				M[e + C.FLAGS] &= ~C.RECURSED_CHECK;
				purgeDeps(e);
			}
		} else if (M[e + C.DEPS] !== 0) {
			M[e + C.FLAGS] = C.K_EFFECT | C.WATCHING | (flags & C.HAS_CHILD_EFFECT);
		}
	}

	function requeueAbort(e: number): void {
		if (M[e + C.FLAGS] & C.KIND_MASK) {
			M[e + C.FLAGS] |= C.WATCHING | C.RECURSED;
		}
	}

	function runCleanup(e: number): void {
		const cv = (e >> 2) + 1;
		const cleanup = values[cv] as () => void;
		values[cv] = undefined;
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

	function dispose(e: number): void {
		const flags = M[e + C.FLAGS];
		if (!(flags & C.KIND_MASK)) {
			return;
		}
		if (flags & C.K_WATCHER) {
			liveWatchers.delete(e);
		}
		// §8.6 refcount pairing: this node's liveness contribution departs NOW,
		// while its kind bits and dep links are still intact; the unlinks below
		// then see it as not-live (flags zeroed) and do not double-decrement.
		if (isLiveNode(e)) {
			let lnk = M[e + C.DEPS];
			while (lnk !== 0) {
				decLive(M[lnk + C.DEP]);
				lnk = M[lnk + C.NEXT_DEP];
			}
		}
		M[e + C.FLAGS] = 0;
		disposeAllDepsInReverse(e);
		const sub = M[e + C.SUBS];
		if (sub !== 0) {
			unlink(sub);
		}
		if (flags & C.K_EFFECT && values[(e >> 2) + 1]) {
			runCleanup(e);
		}
		pendingFree.push(e);
	}

	function disposeAllDepsInReverse(sub: number): void {
		let cur = M[sub + C.DEPS_TAIL];
		while (cur !== 0) {
			const prev = M[cur + C.PREV_DEP];
			unlink(cur, sub);
			cur = prev;
		}
	}

	function purgeDeps(sub: number): void {
		const depsTail = M[sub + C.DEPS_TAIL];
		let dep = depsTail !== 0 ? M[depsTail + C.NEXT_DEP] : M[sub + C.DEPS];
		while (dep !== 0) {
			dep = unlink(dep, sub);
		}
	}

	function maybeBoundary(): void {
		if (enterDepth === 0 && queuedLength === 0) {
			if (finalizeRetry.length !== 0 && drainDepth === 0) {
				processFinalizeRetries();
			}
			if (pendingFree.length !== 0) {
				sweepPendingFree();
			}
		}
	}

	function flush(): void {
		maybeBoundary();
		try {
			while (notifyIndex < queuedLength) {
				const e = queued[notifyIndex];
				queued[notifyIndex++] = 0;
				run(e);
			}
		} finally {
			while (notifyIndex < queuedLength) {
				const e = queued[notifyIndex];
				queued[notifyIndex++] = 0;
				requeueAbort(e);
			}
			notifyIndex = 0;
			queuedLength = 0;
		}
	}

	// ---- kernel: read/write ------------------------------------------------------
	// The atom's newest kernel-side value WITHOUT resolving pending state: the
	// pending slot always holds the latest applied write. Write-path equality
	// gates must use this — resolving mid-batch (kernelPeekAtom) would fold
	// pending -> current early and break the batch-revert cutoff (the
	// conformance suite's dep-reverts cases).
	function pendingValueOf(s: number): unknown {
		return values[(s >> 2) + 1];
	}

	// Resolve a possibly-pending atom value without linking (W0 peek).
	function kernelPeekAtom(s: number): unknown {
		if (M[s + C.FLAGS] & C.DIRTY) {
			if (updateAtom(s)) {
				const subs = M[s + C.SUBS];
				if (subs !== 0) {
					shallowPropagate(subs);
				}
			}
		}
		return values[s >> 2];
	}

	function kernelReadAtom(s: number): unknown {
		const v = kernelPeekAtom(s);
		if (activeSub !== 0) {
			link(s, activeSub, cycle);
		}
		return v;
	}

	// Kernel write: pending value + propagate. Returns true if effects queued.
	function kernelWriteAtom(s: number, value: unknown): boolean {
		const p = (s >> 2) + 1;
		if (values[p] !== (values[p] = value)) {
			M[s + C.FLAGS] |= C.DIRTY;
			const subs = M[s + C.SUBS];
			if (subs !== 0) {
				propagate(subs, runDepth !== 0);
				return true;
			}
		}
		return false;
	}

	function kernelComputedRead(c: number): unknown {
		const flags = M[c + C.FLAGS];
		if (
			flags & C.DIRTY
			|| (
				flags & C.PENDING
				&& (
					checkDirty(M[c + C.DEPS], c)
					|| (M[c + C.FLAGS] = flags & ~C.PENDING, false)
				)
			)
		) {
			if (updateComputed(c)) {
				const subs = M[c + C.SUBS];
				if (subs !== 0) {
					shallowPropagate(subs);
				}
			}
		} else if (!(flags & C.MUTABLE) && !(flags & C.DIRTY)) {
			// never evaluated (fresh computed): first canonical evaluation
			M[c + C.FLAGS] |= C.MUTABLE | C.RECURSED_CHECK;
			const prevSub = activeSub;
			activeSub = c;
			++enterDepth;
			++canonicalEvalDepth;
			try {
				values[c >> 2] = (fns[c >> 3] as (previousValue?: unknown) => unknown)(undefined);
			} finally {
				--canonicalEvalDepth;
				--enterDepth;
				activeSub = prevSub;
				M[c + C.FLAGS] &= ~C.RECURSED_CHECK;
			}
		}
		const sub = activeSub;
		if (sub !== 0) {
			link(c, sub, cycle);
		}
		return values[c >> 2];
	}

	function kernelComputedReadUntracked(c: number): unknown {
		const prevSub = activeSub;
		activeSub = 0;
		try {
			return kernelComputedRead(c);
		} finally {
			activeSub = prevSub;
		}
	}

	// Overlay-support #4 (§8.7.4): invalidate — DIRTY + propagate + queue.
	function invalidate(id: number): void {
		M[id + C.FLAGS] |= C.DIRTY;
		const subs = M[id + C.SUBS];
		if (subs !== 0) {
			propagate(subs, runDepth !== 0);
		}
	}

	// ---- overlay-support #2 (§8.7.2): the notify walk -----------------------------
	// Walk the subscriber cone of `node`'s subscribers, stamping OVERLAY_STAMP
	// with `ticket` (dedup per ticket). With `collect`, IMMEDIATE watchers are
	// pushed into `collectInto`. Pure integer traversal; runs no user code.
	function stampCone(startNode: number, ticket: number, collect: boolean, unapplied: boolean, collectInto?: number[]): void {
		const stackBase = propSp;
		let node = startNode;
		let nextLink = 0;
		do {
			const flags = M[node + C.FLAGS];
			if (!(flags & C.K_ATOM) && M[node + C.OVERLAY_STAMP] !== ticket) {
				M[node + C.OVERLAY_STAMP] = ticket;
				if (unapplied) {
					unappliedStamp[node >> 3] = ticket;
				}
				if (collect && (flags & C.IMMEDIATE) && (flags & C.K_WATCHER) && collectInto !== undefined) {
					collectInto.push(node);
				}
				const subs = M[node + C.SUBS];
				if (subs !== 0) {
					if (nextLink !== 0) {
						if (propSp === propStack.length) {
							const bigger = new Int32Array(propStack.length * 2);
							bigger.set(propStack);
							propStack = bigger;
						}
						propStack[propSp++] = nextLink;
					}
					nextLink = subs;
				}
			}
			// advance
			if (nextLink !== 0) {
				node = M[nextLink + C.SUB];
				nextLink = M[nextLink + C.NEXT_SUB];
				continue;
			}
			if (propSp > stackBase) {
				nextLink = propStack[--propSp];
				node = M[nextLink + C.SUB];
				nextLink = M[nextLink + C.NEXT_SUB];
				continue;
			}
			break;
		} while (true);
	}

	function notifyWalkFromAtom(atom: number, ticket: number, collect: boolean, collectInto?: number[], unapplied = false): void {
		let lnk = M[atom + C.SUBS];
		while (lnk !== 0) {
			stampCone(M[lnk + C.SUB], ticket, collect, unapplied, collectInto);
			lnk = M[lnk + C.NEXT_SUB];
		}
	}

	// ---- overlay: tickets, equality, slots ---------------------------------------
	function ticket(): number {
		return ++seqCounter;
	}

	function valEq(eq: Equality<unknown> | undefined, a: unknown, b: unknown): boolean {
		return eq !== undefined ? eq(a, b) : Object.is(a, b);
	}

	function equalityOf(id: number): Equality<unknown> | undefined {
		return metas[id >> 3]?.isEqual;
	}

	function findLiveSlot(token: number): number {
		if (token === 0) {
			return -1;
		}
		if (token === lastToken && lastSlot >= 0 && batchToken[lastSlot] === token) {
			return lastSlot;
		}
		// Mask-driven: iterate only occupied slots (the linear 32-scan showed
		// up in the idle-write profile).
		let m = slotOccupiedMask;
		while (m !== 0) {
			const bit = m & -m;
			const s = 31 - Math.clz32(bit);
			if (batchToken[s] === token) {
				lastToken = token;
				lastSlot = s;
				return s;
			}
			m &= m - 1;
		}
		return -1;
	}

	// §9.2: intern a token to a slot; -1 = exhausted (pseudo fallback).
	function internSlot(token: number): number {
		// One-entry cache inline (the profiled steady-write path).
		if (token === lastToken && lastSlot >= 0 && batchToken[lastSlot] === token) {
			return lastSlot;
		}
		const found = findLiveSlot(token);
		if (found >= 0) {
			return found;
		}
		const free = ~slotOccupiedMask;
		if (free !== 0) {
			const bit = free & -free;
			const s = 31 - Math.clz32(bit);
			if (s < 32 && s >= 0) {
				batchToken[s] = token;
				batchEntryCount[s] = 0;
				slotMemoHead[s] = 0;
				slotOccupiedMask |= 1 << s;
				liveSlotMask |= 1 << s;
				retiredSlotMask &= ~(1 << s);
				if (token & 1) {
					liveDeferredMask |= 1 << s;
				}
				lastToken = token;
				lastSlot = s;
				return s;
			}
		}
		return -1;
	}

	function releaseSlotIfDone(slot: number): void {
		if (((retiredSlotMask >> slot) & 1) !== 0 && batchEntryCount[slot] === 0) {
			// Tombstone the dead batch's writer's-world memos and release their
			// memoVals slots NOW: the token never resolves again, and waiting
			// for quiescence would pin those values for as long as any OTHER
			// transition stays open (unbounded across overlapping batches).
			let rec = slotMemoHead[slot];
			while (rec > 0) {
				const next = W[rec + C.W_SLOT_NEXT];
				W[rec + C.W_EPOCH] = 0;
				memoVals[W[rec + C.W_VAL]] = undefined;
				W[rec + C.W_SLOT_NEXT] = -1;
				rec = next;
			}
			batchToken[slot] = 0;
			slotOccupiedMask &= ~(1 << slot);
			liveSlotMask &= ~(1 << slot);
			liveDeferredMask &= ~(1 << slot);
			retiredSlotMask &= ~(1 << slot);
			slotMemoHead[slot] = 0;
			slotChainMask &= ~(1 << slot);
			if (lastSlot === slot) {
				lastToken = 0;
				lastSlot = -1;
			}
		}
	}

	function liveDeferredTokens(): number[] {
		const out: number[] = [];
		for (let s = 0; s < 32; ++s) {
			if (((liveDeferredMask >> s) & 1) !== 0 && ((retiredSlotMask >> s) & 1) === 0) {
				out.push(batchToken[s]);
			}
		}
		return out;
	}

	// ---- world descriptors ---------------------------------------------------------
	const W0_WORLD: WorldDesc = { k: C.WK_W0, key: -1, token: 0, slot: -1, pin: 0, mask: 0 };
	const NEWEST_WORLD: WorldDesc = { k: C.WK_NEWEST, key: 0, token: 0, slot: -1, pin: 0, mask: 0 };
	// Global committed form (§10.2): every retired entry. Per-root views
	// (§13.4) refine pin+mask per container.
	const COMMITTED_WORLD: WorldDesc = { k: C.WK_COMMITTED, key: -1, token: 0, slot: -1, pin: C.MAX_SEQ, mask: 0 };
	let passWorld: WorldDesc = { k: C.WK_PASS, key: 1, token: 0, slot: -1, pin: 0, mask: 0 };

	function writerWorld(token: number): WorldDesc {
		return {
			k: C.WK_WRITER,
			key: ((token << 2) | 2) | 0,
			token,
			slot: findLiveSlot(token),
			pin: 0,
			mask: 0,
		};
	}

	// GAP DEGRADATION (real fork): the patched build emits no yield edge when
	// a render pass exits by SUSPENDING, so the engine's edge-tracked context
	// would stay RENDER into the gap where handlers run. When the engine
	// believes a pass is executing but the fork's stack-accurate render
	// context says otherwise, synthesize the missed yield (§10.1's edges,
	// self-healed). Consulted only on the already-marked-RENDER paths — the
	// steady NEWEST hot paths never ask the fork.
	function healStaleRenderCtx(): boolean {
		if (fork !== undefined && fork.getRenderContext() === undefined) {
			passExecuting = 0;
			readCtx = C.CTX_NEWEST;
			return true;
		}
		return false;
	}

	function ambientWorld(): WorldDesc {
		if (readCtx === C.CTX_RENDER) {
			if (healStaleRenderCtx()) {
				return NEWEST_WORLD;
			}
			return passWorld;
		}
		if (readCtx === C.CTX_COMMITTED) {
			return COMMITTED_WORLD;
		}
		return NEWEST_WORLD;
	}

	function worldSensitive(world: WorldDesc): boolean {
		return (
			world.k === C.WK_PASS
			|| world.k === C.WK_WRITER
			|| world.k === C.WK_COMMITTED
			|| (world.k === C.WK_NEWEST && unappliedEntries > 0)
		);
	}

	// ---- tape append (§9.3) --------------------------------------------------------
	function appendLog(a: number, op: number, payload: unknown, applied: boolean, slot: number, pseudo: boolean): void {
		++certGen; // every append/coalesce moves some certificate input
		let head = M[a + C.LOG_HEAD];
		if (head === 0) {
			// First entry: create the tape. Base snapshots the canonical value
			// BEFORE this write applies; replays start here (§9.3).
			const base = allocLog();
			G[base + C.L_META] = C.OP_BASE | C.M_RETIRED;
			const t = ticket();
			G[base + C.L_SEQ] = t;
			G[base + C.L_RETIRED_SEQ] = t;
			logVals[base >> 2] = pendingValueOf(a); // W0 value, no mid-batch resolve
			M[a + C.LOG_HEAD] = base;
			M[a + C.LOG_TAIL] = base;
			M[a + C.FLAGS] |= C.LOGGED;
			loggedAtoms.push(a);
			++loggedAtomCount;
			// Tape creation marks the cone, for every write classification (§9.3):
			// mark-only walk (collect off), once per atom per era.
			notifyWalkFromAtom(a, ++walkCounter, false);
			head = base;
		} else if (passOpen === 0 && !pseudo) {
			// Same-batch coalescing (§9.3): tail entry of the same batch,
			// unretired, and no render pass open (a pass may be pinned between
			// the two writes). SET replaces in place; UPDATE/DISPATCH composes
			// once the batch's tape run exceeds the threshold (default 8).
			const tail = M[a + C.LOG_TAIL];
			const tm = G[tail + C.L_META];
			const tailOp = tm & C.OP_MASK;
			const tailSlot = (tm >> C.SLOT_SHIFT) & C.SLOT_MASK;
			const tailApplied = (tm & C.M_APPLIED) !== 0;
			if (
				tailOp !== C.OP_BASE
				&& (tm & (C.M_RETIRED | C.M_PSEUDO)) === 0
				&& tailSlot === slot
				&& tailApplied === applied
			) {
				if (op === C.OP_SET) {
					logVals[tail >> 2] = payload;
					G[tail + C.L_SEQ] = ++seqCounter; // new seq: pins + certs must see movement
					if (tailOp !== C.OP_SET) {
						G[tail + C.L_META] = (tm & ~C.OP_MASK) | C.OP_SET;
					}
					if (tracer !== undefined) {
						tracer.emit(TraceKind.LOG_COALESCE, a, slot, tail);
					}
					return;
				}
				if ((op === C.OP_UPDATE || op === C.OP_DISPATCH) && tailOp !== C.OP_SET) {
					let run = 0;
					let rec = G[head + C.L_NEXT];
					while (rec !== 0) {
						const m = G[rec + C.L_META];
						if (((m >> C.SLOT_SHIFT) & C.SLOT_MASK) === slot && (m & C.M_PSEUDO) === 0) {
							++run;
						}
						rec = G[rec + C.L_NEXT];
					}
					if (run >= 8) {
						// Compose into an UPDATE closure applying old-then-new.
						const oldOp = tailOp;
						const oldPayload = logVals[tail >> 2];
						const reducer = metas[a >> 3]?.reducer;
						const newOp = op;
						const newPayload = payload;
						logVals[tail >> 2] = (acc: unknown): unknown => {
							const mid = oldOp === C.OP_UPDATE
								? (oldPayload as (x: unknown) => unknown)(acc)
								: reducer!(acc, oldPayload);
							return newOp === C.OP_UPDATE
								? (newPayload as (x: unknown) => unknown)(mid)
								: reducer!(mid, newPayload);
						};
						G[tail + C.L_SEQ] = ticket();
						G[tail + C.L_META] = (tm & ~C.OP_MASK) | C.OP_UPDATE;
						return;
					}
				}
			}
		}
		const rec = allocLog();
		let meta = op | (slot << C.SLOT_SHIFT) | (applied ? C.M_APPLIED : 0);
		const t = ticket();
		G[rec + C.L_SEQ] = t;
		if (pseudo) {
			// §9.2 slot-exhaustion fallback: an always-included pseudo-batch —
			// applied + retired at append, degraded toward "urgent".
			meta |= C.M_PSEUDO | C.M_APPLIED | C.M_RETIRED;
			G[rec + C.L_RETIRED_SEQ] = t;
		} else {
			G[rec + C.L_RETIRED_SEQ] = 0;
			++batchEntryCount[slot];
			if (!applied) {
				++unappliedEntries;
				atomUnapplied.set(a, (atomUnapplied.get(a) ?? 0) + 1);
			}
		}
		G[rec + C.L_META] = meta;
		logVals[rec >> 2] = payload;
		G[M[a + C.LOG_TAIL] + C.L_NEXT] = rec;
		M[a + C.LOG_TAIL] = rec;
		if (tracer !== undefined) {
			tracer.emit(TraceKind.LOG_APPEND, a, slot, rec, t, meta);
		}
	}

	// ---- visibility (§10.2) ----------------------------------------------------------
	function visibleEntry(rec: number, world: WorldDesc): boolean {
		const meta = G[rec + C.L_META];
		switch (world.k) {
			case C.WK_NEWEST:
				return true;
			case C.WK_COMMITTED: {
				if ((meta & C.M_RETIRED) !== 0 && G[rec + C.L_RETIRED_SEQ] <= world.pin) {
					return true;
				}
				// §13.4: batches this root committed while pending elsewhere.
				const slot = (meta >> C.SLOT_SHIFT) & C.SLOT_MASK;
				return (meta & C.M_PSEUDO) === 0 && ((world.mask >> slot) & 1) !== 0;
			}
			case C.WK_W0:
				return (meta & (C.M_RETIRED | C.M_APPLIED)) !== 0;
			case C.WK_PASS: {
				if ((meta & C.M_RETIRED) !== 0 && G[rec + C.L_RETIRED_SEQ] <= world.pin) {
					return true;
				}
				if ((meta & C.M_PSEUDO) !== 0) {
					return false; // pseudo entries are retired-at-append; clause 1 governs
				}
				const slot = (meta >> C.SLOT_SHIFT) & C.SLOT_MASK;
				return ((world.mask >> slot) & 1) !== 0 && G[rec + C.L_SEQ] <= world.pin;
			}
			case C.WK_WRITER: {
				if ((meta & (C.M_RETIRED | C.M_APPLIED)) !== 0) {
					return true;
				}
				const slot = (meta >> C.SLOT_SHIFT) & C.SLOT_MASK;
				// `mask` extends the single-slot form to a token SET — the §13.2
				// fixup re-resolves "committed + applied + the batches the
				// component rendered with" as one world.
				return (meta & C.M_PSEUDO) === 0
					&& (slot === world.slot || ((world.mask >> slot) & 1) !== 0);
			}
		}
		return false;
	}

	function applyLogOp(a: number, rec: number, acc: unknown): unknown {
		const op = G[rec + C.L_META] & C.OP_MASK;
		if (op === C.OP_SET) {
			return logVals[rec >> 2];
		}
		if (op === C.OP_UPDATE) {
			return (logVals[rec >> 2] as (x: unknown) => unknown)(acc);
		}
		return metas[a >> 3]!.reducer!(acc, logVals[rec >> 2]);
	}

	function foldTape(a: number, world: WorldDesc): unknown {
		const head = M[a + C.LOG_HEAD];
		const eq = equalityOf(a);
		let acc = logVals[head >> 2];
		let rec = G[head + C.L_NEXT];
		while (rec !== 0) {
			if (visibleEntry(rec, world)) {
				const next = applyLogOp(a, rec, acc);
				acc = valEq(eq, acc, next) ? acc : next; // equality inside the fold (§9.3)
			}
			rec = G[rec + C.L_NEXT];
		}
		return acc;
	}

	function allVisibleAndApplied(a: number, world: WorldDesc): boolean {
		const head = M[a + C.LOG_HEAD];
		let rec = G[head + C.L_NEXT];
		while (rec !== 0) {
			const meta = G[rec + C.L_META];
			if ((meta & (C.M_APPLIED | C.M_RETIRED)) === 0 || !visibleEntry(rec, world)) {
				return false;
			}
			rec = G[rec + C.L_NEXT];
		}
		return true;
	}

	function resolveAtomInWorld(a: number, world: WorldDesc): unknown {
		if ((M[a + C.FLAGS] & C.LOGGED) === 0 || world.k === C.WK_W0) {
			return kernelPeekAtom(a);
		}
		if (world.k === C.WK_NEWEST && (unappliedEntries === 0 || (atomUnapplied.get(a) ?? 0) === 0)) {
			return kernelPeekAtom(a);
		}
		if (allVisibleAndApplied(a, world)) {
			return kernelPeekAtom(a); // §10.3 shortcut: the kernel value IS the answer
		}
		return foldTape(a, world);
	}

	// ---- world memos (§10.5) ---------------------------------------------------------
	function memoHeadOf(c: number): number {
		let head = memos[c >> 3];
		if (head !== 0 && (head >= wNext || W[head + C.W_NODE] !== c)) {
			// Stale head after a plane reset (§7.4 guard): lazily zero.
			memos[c >> 3] = 0;
			head = 0;
		}
		return head;
	}

	function certValid(rec: number): boolean {
		const n = W[rec + C.W_NDEPS];
		let off = W[rec + C.W_CERT];
		for (let i = 0; i < n; ++i, off += 2) {
			const aid = WC[off];
			const expected = WC[off + 1];
			const cur = (M[aid + C.FLAGS] & C.LOGGED) !== 0 ? G[M[aid + C.LOG_TAIL] + C.L_SEQ] : 0;
			if (cur !== expected) {
				return false;
			}
		}
		return true;
	}

	function memoLookup(c: number, world: WorldDesc): number {
		if (world.key < 0) {
			return 0;
		}
		let rec = memoHeadOf(c);
		while (rec !== 0) {
			if (W[rec + C.W_KEY] === world.key && W[rec + C.W_EPOCH] === overlayEpoch) {
				// Pass worlds: key + epoch suffice (pins freeze the world, §10.5).
				if (world.k === C.WK_PASS) {
					return rec;
				}
				// O(1) validity: nothing that could move a certificate input has
				// happened since this record was last validated.
				if (memoCheckedAt[rec >> 3] === certGen) {
					return rec;
				}
				if (certValid(rec)) {
					memoCheckedAt[rec >> 3] = certGen;
					return rec;
				}
			}
			rec = W[rec + C.W_NEXT_MEMO];
		}
		return 0;
	}

	function certPush(aid: number, seq: number): void {
		if (certSp + 2 > certStack.length) {
			growCertStack();
		}
		certStack[certSp++] = aid;
		certStack[certSp++] = seq;
	}

	function overlayReadAtom(a: number): unknown {
		const world = frameWorlds[frameWorlds.length - 1];
		const flags = M[a + C.FLAGS];
		let tailSeq = 0;
		let v: unknown;
		if ((flags & C.LOGGED) !== 0) {
			tailSeq = G[M[a + C.LOG_TAIL] + C.L_SEQ];
			v = world.k === C.WK_W0 ? kernelPeekAtom(a) : resolveAtomInWorld(a, world);
		} else {
			v = kernelPeekAtom(a);
		}
		// Certificates record EVERY atom read — unlogged ones as zeros (§10.5).
		certPush(a, tailSeq);
		return v;
	}

	// §10.5 overlay evaluation. Untracked; nested computed reads ALWAYS recurse
	// here (coordinator resolution #5 — never the kernel path inside a frame,
	// else unlogged grandchild sources escape the parent's certificate).
	function overlayEvaluate(c: number, world: WorldDesc): unknown {
		const hit = memoLookup(c, world);
		if (hit !== 0) {
			if (tracer !== undefined) {
				tracer.emit(TraceKind.COMPUTED_EVAL, c, world.key, 0, 0, 1); // memo hit
			}
			if (frameWorlds.length > 0) {
				// Flattening on memo hits: copy the child's certificate run into
				// every open collector frame (§10.5).
				const n = W[hit + C.W_NDEPS];
				let off = W[hit + C.W_CERT];
				for (let i = 0; i < n; ++i, off += 2) {
					certPush(WC[off], WC[off + 1]);
				}
			}
			return memoVals[W[hit + C.W_VAL]];
		}
		// Previous same-world value, for reference-stable equality (§11.2).
		let prev: unknown;
		let hasPrev = false;
		if (world.key >= 0) {
			let rec = memoHeadOf(c);
			while (rec !== 0) {
				if (W[rec + C.W_KEY] === world.key && W[rec + C.W_EPOCH] !== 0) {
					prev = memoVals[W[rec + C.W_VAL]];
					hasPrev = true;
					break;
				}
				rec = W[rec + C.W_NEXT_MEMO];
			}
		}
		const frameBase = certSp;
		frameWorlds.push(world);
		const prevSub = activeSub;
		activeSub = 0; // render/overlay evaluation never mutates topology (§10.3)
		let v: unknown;
		try {
			v = (metas[c >> 3]!.rawFn as () => unknown)();
		} finally {
			activeSub = prevSub;
			frameWorlds.pop();
		}
		if (hasPrev && valEq(equalityOf(c), prev, v)) {
			v = prev;
		}
		if (world.key >= 0) {
			// Re-memoization updates the (node, key) record IN PLACE: chains
			// (node chain and slot chain) keep exactly one record per key, so
			// lookup and re-validation stay O(live keys) — a held-open
			// transition's hot loop must not grow them per evaluation. (The
			// spec's tombstone+append lifecycle relied on opportunistic sweep
			// trimming; in-place reuse achieves the same bound determinately.)
			let rec = 0;
			for (let old = memoHeadOf(c); old !== 0; old = W[old + C.W_NEXT_MEMO]) {
				if (W[old + C.W_KEY] === world.key) {
					rec = old;
					break;
				}
			}
			// Pack the certificate run: [frameBase, certSp) — includes every
			// nested frame's reads beneath this frame's base (flattening).
			// Re-memoization REUSES the record's existing run when the new run
			// fits: nobody else aliases it, and a held-open transition's hot
			// write→re-validate loop must not bump-allocate a fresh run per
			// re-evaluation (certNext only resets at quiescence — that growth
			// was per-operation and unbounded while any batch stayed open).
			const pairs = (certSp - frameBase) >> 1;
			let off: number;
			if (rec !== 0 && pairs <= W[rec + C.W_NDEPS]) {
				off = W[rec + C.W_CERT];
			} else {
				while (certNext + pairs * 2 > WC.length) {
					growWC();
				}
				off = certNext;
				certNext = off + pairs * 2;
			}
			for (let i = 0; i < pairs * 2; ++i) {
				WC[off + i] = certStack[frameBase + i];
			}
			if (rec !== 0) {
				W[rec + C.W_EPOCH] = overlayEpoch;
				memoVals[W[rec + C.W_VAL]] = v;
				W[rec + C.W_NDEPS] = pairs;
				W[rec + C.W_CERT] = off;
				memoCheckedAt[rec >> 3] = certGen;
				// Late-linking (the slot-less registration hole): a writer-key
				// record created while its token had no slot carries the -1
				// sentinel; if the slot exists NOW, register it so drain
				// re-validation can reach it.
				if (
					world.k === C.WK_WRITER
					&& world.slot >= 0
					&& W[rec + C.W_SLOT_NEXT] === -1
				) {
					W[rec + C.W_SLOT_NEXT] = slotMemoHead[world.slot];
					slotMemoHead[world.slot] = rec;
					slotChainMask |= 1 << world.slot;
				}
			} else {
				rec = allocMemo();
				W[rec + C.W_KEY] = world.key;
				W[rec + C.W_EPOCH] = overlayEpoch;
				W[rec + C.W_NODE] = c;
				memoVals.push(v);
				W[rec + C.W_VAL] = memoVals.length - 1;
				W[rec + C.W_NEXT_MEMO] = memoHeadOf(c);
				W[rec + C.W_NDEPS] = pairs;
				W[rec + C.W_CERT] = off;
				memoCheckedAt[rec >> 3] = certGen;
				memos[c >> 3] = rec;
				M[c + C.MEMO_KEY] = world.key;
				if (world.k === C.WK_WRITER && world.slot >= 0) {
					// Writer's-world records register on the slot memo chain — the
					// drain re-validation registry (§9.8, §10.5).
					W[rec + C.W_SLOT_NEXT] = slotMemoHead[world.slot];
					slotMemoHead[world.slot] = rec;
					slotChainMask |= 1 << world.slot;
				} else {
					// -1 = writer-key record not on any slot chain (0 would be
					// ambiguous with chain tail); 0 for non-writer keys.
					W[rec + C.W_SLOT_NEXT] = world.k === C.WK_WRITER ? -1 : 0;
				}
			}
		}
		if (frameWorlds.length === 0) {
			certSp = 0;
		}
		if (tracer !== undefined) {
			tracer.emit(TraceKind.COMPUTED_EVAL, c, world.key, 0, 0, 0); // evaluated
		}
		return v;
	}

	// §10.4: the computed read gate + post-eval re-check. The NEWEST world
	// carries a per-node validated-value cache (values[+1], unused on
	// computeds): valid while certGen is unchanged — the hot marked-cone read
	// becomes one array load + compare + value load.
	function resolveComputedInWorld(c: number, world: WorldDesc): unknown {
		if (world.k === C.WK_NEWEST && writeMode === C.MODE_LOGGED) {
			if (newestValidAt[c >> 3] === certGen) {
				return values[(c >> 2) + 1];
			}
			// Stamp with the PRE-resolution generation: an evaluation that
			// mutates the world itself (writes inside computeds) must leave the
			// cache invalid so the pending recompute is observed (conformance
			// #179).
			const genBefore = certGen;
			const v = resolveComputedInWorldInner(c, world);
			values[(c >> 2) + 1] = v;
			newestValidAt[c >> 3] = genBefore;
			return v;
		}
		return resolveComputedInWorldInner(c, world);
	}

	function resolveComputedInWorldInner(c: number, world: WorldDesc): unknown {
		if (world.k === C.WK_W0) {
			return kernelComputedReadUntracked(c);
		}
		if (loggedAtomCount === 0 || M[c + C.OVERLAY_STAMP] <= eraFloor) {
			const v = kernelComputedReadUntracked(c);
			// Post-eval re-check: did this evaluation's own dependency linking
			// just mark c (§8.7.3)? Only possible if the kernel path recomputed.
			if (worldSensitive(world) && M[c + C.OVERLAY_STAMP] > eraFloor) {
				if (world.k !== C.WK_NEWEST || unappliedStamp[c >> 3] > eraFloor) {
					return overlayEvaluate(c, world);
				}
			}
			return v;
		}
		if (
			world.k === C.WK_NEWEST
			&& (unappliedEntries === 0 || unappliedStamp[c >> 3] <= eraFloor)
		) {
			// Wn == W0 for this cone: nothing unapplied below it (the per-cone
			// refinement of §10.4's global gate; see §17.5(b)). The kernel path
			// may reveal a new unapplied producer via mark repair — re-check.
			const v = kernelComputedReadUntracked(c);
			if (unappliedEntries !== 0 && unappliedStamp[c >> 3] > eraFloor) {
				return overlayEvaluate(c, world);
			}
			return v;
		}
		// Head-record memo peek: the common steady shape is one world reading
		// one node repeatedly, whose memo is the chain head. overlayEvaluate is
		// far over the inline budget, so hitting here saves two call frames on
		// the hot marked-cone read (the G-8 inner loop).
		{
			const head = memos[c >> 3];
			if (
				head !== 0
				&& head < wNext
				&& W[head + C.W_NODE] === c
				&& W[head + C.W_KEY] === world.key
				&& W[head + C.W_EPOCH] === overlayEpoch
				&& (world.k === C.WK_PASS || memoCheckedAt[head >> 3] === certGen)
				&& frameWorlds.length === 0
			) {
				return memoVals[W[head + C.W_VAL]];
			}
		}
		return overlayEvaluate(c, world);
	}

	function worldValueOf(id: number, world: WorldDesc): unknown {
		return (M[id + C.FLAGS] & C.K_ATOM) !== 0
			? resolveAtomInWorld(id, world)
			: resolveComputedInWorld(id, world);
	}

	// ---- broadcast decisions (§10.6 + coordinator resolutions 1/3/7b) -------------
	function requestWalk(atom: number, token: number): void {
		pendingWalks.push(atom, token);
	}

	// Live watcher registry: lastBroadcast baselines are keyed by batch token,
	// and tokens are minted fresh per batch — without pruning, a long-lived
	// watcher's baseline Map grows by one entry (pinning one value) per
	// broadcast-reaching batch, forever. Prune at retirement/quiescence: a
	// key is dead once its token no longer occupies a slot (token 0, the W0
	// baseline, is permanent).
	const liveWatchers = new Set<number>();

	function pruneWatcherBaselines(): void {
		if (liveWatchers.size === 0) {
			return;
		}
		for (const w of liveWatchers) {
			const lb = metas[w >> 3]?.lastBroadcast;
			if (lb === undefined || lb.size <= 1) {
				continue;
			}
			for (const key of lb.keys()) {
				if (key !== 0 && findLiveSlot(key) < 0) {
					lb.delete(key);
				}
			}
		}
	}

	function decide(w: number, token: number, entangled: boolean): void {
		const meta = metas[w >> 3];
		if (meta === undefined || meta.watchedId === undefined || (M[w + C.FLAGS] & C.K_WATCHER) === 0) {
			return; // disposed mid-drain
		}
		const nodeId = meta.watchedId;
		const world = token === 0 ? W0_WORLD : writerWorld(token);
		const v = worldValueOf(nodeId, world);
		const lb = meta.lastBroadcast!;
		// Missing-world baseline: the current W0 value (resolution 7b). A
		// suppressed decision records nothing — decisions stay purely
		// value-derived, so they are independent of how often a watcher is
		// collected (and match the oracle's derivation rule, §17.2).
		const baseline = lb.has(token) ? lb.get(token) : worldValueOf(nodeId, W0_WORLD);
		if (!valEq(equalityOf(nodeId), baseline, v)) {
			lb.set(token, v);
			const ev: BroadcastEvent = {
				watcherId: w,
				token,
				value: v,
				forkBatchDuringCallback: entangled && fork !== undefined ? fork.getCurrentWriteBatch() : 0,
			};
			if (tracer !== undefined) {
				tracer.emit(TraceKind.BROADCAST, w, token);
			}
			if (broadcastLog.length >= BROADCAST_LOG_CAP) {
				broadcastLogDropped += broadcastLog.length >> 1;
				broadcastLog.splice(0, broadcastLog.length >> 1); // drop oldest half
			}
			broadcastLog.push(ev);
			meta.onBroadcast?.(ev);
		}
	}

	// Schedule a decision into a deferred batch's own lanes via the fork's
	// entanglement API (§9.8/§6.5); retired token → plain urgent fallback.
	function decideEntangled(w: number, token: number): void {
		if (fork !== undefined && (token & 1) === 1) {
			if (!fork.runInBatch(token, () => decide(w, token, true))) {
				decide(w, token, false);
			}
		} else {
			decide(w, token, false);
		}
	}

	function clearWatcherStale(w: number): void {
		if ((M[w + C.FLAGS] & C.K_WATCHER) !== 0) {
			M[w + C.FLAGS] &= ~(C.DIRTY | C.PENDING | C.RECURSED);
		}
	}

	// §9.8 drain re-validation: walk a slot's writer's-world memo chain; for
	// each invalidated record, snapshot-then-re-evaluate and run the §10.6
	// cutoff for the node's IMMEDIATE watchers, entangled into the batch.
	function revalidateSlotChain(slot: number): void {
		const token = batchToken[slot];
		if (token === 0 || slotMemoHead[slot] === 0) {
			return; // nothing registered: allocation-free exit
		}
		const world = writerWorld(token);
		// Precompute validity AND snapshots for the WHOLE chain before any
		// re-evaluation runs (coordinator pitfall, sharpened by in-place
		// re-memoization): re-evaluating an earlier record can refresh a later
		// record in place, and a late validity check or snapshot would then
		// read the fresh state and silently skip its watcher decisions.
		const entries: Array<{ node: number; wasValid: boolean; snapshot: unknown }> = [];
		for (let rec = slotMemoHead[slot]; rec !== 0; rec = W[rec + C.W_SLOT_NEXT]) {
			const node = W[rec + C.W_NODE];
			if (node === 0 || (M[node + C.FLAGS] & C.K_COMPUTED) === 0 || W[rec + C.W_EPOCH] === 0) {
				continue;
			}
			entries.push({
				node,
				wasValid:
					W[rec + C.W_EPOCH] === overlayEpoch
					&& (memoCheckedAt[rec >> 3] === certGen || certValid(rec)),
				snapshot: memoVals[W[rec + C.W_VAL]],
			});
		}
		const seen = new Set<number>();
		for (const { node, wasValid, snapshot } of entries) {
			if (seen.has(node)) {
				continue;
			}
			seen.add(node);
			if (wasValid) {
				continue; // still valid → this world's value unchanged
			}
			const fresh = resolveComputedInWorld(node, world);
			if (!valEq(equalityOf(node), snapshot, fresh)) {
				let lnk = M[node + C.SUBS];
				while (lnk !== 0) {
					const sub = M[lnk + C.SUB];
					if ((M[sub + C.FLAGS] & (C.IMMEDIATE | C.K_WATCHER)) === (C.IMMEDIATE | C.K_WATCHER)) {
						decideEntangled(sub, token);
					}
					lnk = M[lnk + C.NEXT_SUB];
				}
			}
		}
	}

	// ---- the drain (§9.8 + resolutions 1/2/3; re-validation BEFORE decisions;
	// one walk ticket PER TOKEN GROUP) ------------------------------------------------
	function revalidateLiveDeferredChains(): void {
		// O(registered slots): one mask AND, then set-bit iteration.
		let m = liveDeferredMask & ~retiredSlotMask & slotChainMask;
		while (m !== 0) {
			const bit = m & -m;
			revalidateSlotChain(31 - Math.clz32(bit));
			m &= m - 1;
		}
	}

	function drainAll(fullRevalidation: boolean): void {
		if (drainDepth > 0) {
			return; // the outer drain loop picks up newly queued work
		}
		// FAST PATH (profiled: drainAll was 46% of the steady-logged-write
		// tick, almost all of it per-drain Map/Set/array allocations): the
		// overwhelmingly common drain is ONE write's walk with no kernel
		// broadcasts. Handle it with reused scratch and integer loops;
		// anything it uncovers (cascades, new walks) falls through to the
		// general loop below.
		// Force-only drains (retirement/truncation with nothing queued): the
		// mask-guarded re-validation is the whole obligation — allocation-free.
		if (fullRevalidation && kernelBroadcasts.length === 0 && pendingWalks.length === 0) {
			++drainDepth;
			try {
				revalidateLiveDeferredChains();
			} finally {
				--drainDepth;
			}
			if (pendingWalks.length === 0 && kernelBroadcasts.length === 0) {
				return;
			}
			fullRevalidation = false; // done; fall through for the new work
		}
		if (!fullRevalidation && kernelBroadcasts.length === 0 && pendingWalks.length === 2) {
			const atom = pendingWalks[0];
			const token = pendingWalks[1];
			pendingWalks.length = 0;
			++drainDepth;
			try {
				fastCollect.length = 0;
				notifyWalkFromAtom(atom, ++walkCounter, true, fastCollect);
				if (tracer !== undefined) {
					tracer.emit(TraceKind.NOTIFY_WALK, atom, token, walkCounter, 1, fastCollect.length);
				}
				// Re-validation, ordered BEFORE decisions (unchanged semantics).
				if (token === 0) {
					revalidateLiveDeferredChains();
				} else if ((token & 1) === 1) {
					const s2 = findLiveSlot(token);
					if (s2 >= 0) {
						revalidateSlotChain(s2);
					}
				}
				if (fastCollect.length !== 0) {
					if (token === 0) {
						const expansion = liveDeferredTokens();
						for (let i = 0; i < fastCollect.length; ++i) {
							const w = fastCollect[i];
							decide(w, 0, false);
							for (const t of expansion) {
								decideEntangled(w, t);
							}
							clearWatcherStale(w);
						}
					} else if ((token & 1) === 1 && fork !== undefined) {
						const ws = fastCollect.slice();
						const group = (): void => {
							for (const w of ws) {
								decide(w, token, true);
								clearWatcherStale(w);
							}
						};
						if (!fork.runInBatch(token, group)) {
							for (const w of ws) {
								decide(w, token, false);
								clearWatcherStale(w);
							}
						}
					} else {
						for (let i = 0; i < fastCollect.length; ++i) {
							decide(fastCollect[i], token, false);
							clearWatcherStale(fastCollect[i]);
						}
					}
				}
			} finally {
				--drainDepth;
			}
			if (pendingWalks.length === 0 && kernelBroadcasts.length === 0) {
				return;
			}
			// Cascade work appeared: continue into the general loop.
		}
		++drainDepth;
		try {
			let force = fullRevalidation;
			do {
				const collected = new Map<number, number[]>();
				let any = false;
				if (kernelBroadcasts.length !== 0) {
					any = true;
					const zero: number[] = [];
					for (const w of kernelBroadcasts) {
						if (!zero.includes(w)) {
							zero.push(w);
						}
					}
					kernelBroadcasts.length = 0;
					collected.set(0, zero);
				}
				if (pendingWalks.length !== 0) {
					any = true;
					const walks = pendingWalks.splice(0, pendingWalks.length);
					const groups = new Map<number, number[]>();
					for (let i = 0; i < walks.length; i += 2) {
						let g = groups.get(walks[i + 1]);
						if (g === undefined) {
							groups.set(walks[i + 1], (g = []));
						}
						g.push(walks[i]);
					}
					for (const [token, atoms] of groups) {
						const t = ++walkCounter; // one ticket per token group
						let into = collected.get(token);
						if (into === undefined) {
							collected.set(token, (into = []));
						}
						for (const a of atoms) {
							notifyWalkFromAtom(a, t, true, into);
						}
						if (tracer !== undefined) {
							tracer.emit(TraceKind.NOTIFY_WALK, atoms[0] ?? 0, token, t, atoms.length, into.length);
						}
					}
				}
				if (!any && !force) {
					break;
				}
				// --- re-validation, ordered BEFORE broadcast decisions ---
				const urgentPresent = collected.has(0) || force;
				force = false;
				const revalidated = new Set<number>();
				if (urgentPresent) {
					// Urgent drains re-validate EVERY live deferred world's chain:
					// applied entries are visible in every writer's world
					// (resolutions 1/3).
					for (let s = 0; s < 32; ++s) {
						if (((liveDeferredMask >> s) & 1) !== 0 && ((retiredSlotMask >> s) & 1) === 0) {
							revalidateSlotChain(s);
							revalidated.add(s);
						}
					}
				}
				for (const token of collected.keys()) {
					if (token !== 0 && (token & 1) === 1) {
						const s = findLiveSlot(token);
						if (s >= 0 && !revalidated.has(s)) {
							revalidateSlotChain(s);
							revalidated.add(s);
						}
					}
				}
				// --- broadcast decisions, grouped per token (§9.8) ---
				const expansion = urgentPresent ? liveDeferredTokens() : [];
				for (const [token, watchers] of collected) {
					if (token === 0) {
						for (const w of watchers) {
							decide(w, 0, false);
							// W0 decisions PLUS per-live-deferred-world expansion
							// (resolutions 1/3).
							for (const t of expansion) {
								decideEntangled(w, t);
							}
							clearWatcherStale(w);
						}
					} else if ((token & 1) === 1 && fork !== undefined) {
						const group = (): void => {
							for (const w of watchers) {
								decide(w, token, true);
								clearWatcherStale(w);
							}
						};
						if (!fork.runInBatch(token, group)) {
							// Retired between write and drain: urgent fallback (§9.8).
							for (const w of watchers) {
								decide(w, token, false);
								clearWatcherStale(w);
							}
						}
					} else {
						for (const w of watchers) {
							decide(w, token, false);
							clearWatcherStale(w);
						}
					}
				}
			} while (pendingWalks.length !== 0 || kernelBroadcasts.length !== 0);
		} finally {
			--drainDepth;
		}
	}

	// ---- writes (§9.1 gate, §9.3 append, §9.4 apply, §10.8 render purity) ----------
	function evalOp(a: number, op: number, payload: unknown, cur: unknown): unknown {
		if (op === C.OP_SET) {
			return payload;
		}
		if (op === C.OP_UPDATE) {
			return (payload as (x: unknown) => unknown)(cur);
		}
		return metas[a >> 3]!.reducer!(cur, payload);
	}

	function writeOp(a: number, op: number, payload: unknown): void {
		if (readCtx === C.CTX_RENDER && passExecuting !== 0 && !healStaleRenderCtx()) {
			throw new Error('cosignal: writes during render are not allowed (§10.8)');
		}
		if (
			frameWorlds.length > 0
			&& frameWorlds[frameWorlds.length - 1].k === C.WK_PASS
		) {
			// Render-world evaluation always rejects writes (§10.8/§12.5).
			throw new Error('cosignal: writes during render-world evaluation are not allowed (§10.8)');
		}
		if (forbidWritesInComputeds && canonicalEvalDepth > 0) {
			throw new Error('cosignal: writes inside computeds are forbidden (configure.forbidWritesInComputeds, §12.5)');
		}
		if (writeMode === C.MODE_DIRECT) {
			const cur = pendingValueOf(a);
			const next = evalOp(a, op, payload, cur);
			if (valEq(equalityOf(a), cur, next)) {
				return;
			}
			if (kernelWriteAtom(a, next) && batchDepth === 0) {
				flush();
			}
			topLevelSettle();
			return;
		}
		// LOGGED mode: every write is logged (§9.1).
		const f = fork;
		if (f === undefined) {
			throw new Error('cosignal: LOGGED mode without an attached fork');
		}
		// One fork call, not two: bit 0 of the token IS the deferred bit
		// (§6.2 encoding), so isCurrentWriteDeferred() is redundant here.
		const token = f.getCurrentWriteBatch();
		const deferred = (token & 1) === 1;
		if (M[a + C.LOG_HEAD] === 0) {
			// Equality drop — provably safe only on tapeless atoms (§9.3).
			const cur = pendingValueOf(a);
			const next = op === C.OP_SET ? payload : evalOp(a, op, payload, cur);
			if (valEq(equalityOf(a), cur, next)) {
				return;
			}
		}
		let slot: number;
		let pseudo = false;
		let applied = !deferred;
		if (token === 0) {
			// BATCH_NONE: no batch context exists (real-fork edge; unreachable
			// once a renderer registered its provider). Degrade to the §9.2
			// pseudo shape: applied + retired-at-append, no slot, no retirement
			// to wait for.
			pseudo = true;
			applied = true;
			slot = 0;
		} else {
			slot = internSlot(token);
			if (slot < 0) {
				pseudo = true;
				applied = true;
				slot = 0;
			}
		}
		appendLog(a, op, payload, applied, slot, pseudo);
		if (tracer !== undefined) {
			tracer.emit(TraceKind.ATOM_WRITE, a, token, op, applied ? 1 : 0, seqCounter);
		}
		if (applied) {
			// Urgent: logged AND applied through the kernel (§9.4).
			const cur = pendingValueOf(a);
			const next = op === C.OP_SET ? payload : evalOp(a, op, payload, cur);
			if (!valEq(equalityOf(a), cur, next)) {
				if (kernelWriteAtom(a, next) && batchDepth === 0) {
					flush();
				}
			}
			// Resolution 2: applied logged writes ALWAYS queue a token-0 walk —
			// an equal-value urgent write never propagates via the kernel yet
			// shifts every pending world's fold. PROVABLE NO-OP ELISION: with no
			// canonical subscribers there is no watcher in this atom's cone, and
			// with no registered writer's-world memo chains no divergent-only
			// dependent exists either (subscription-time seeding guarantees any
			// watched divergent node has its memo registered) — the drain would
			// decide nothing, so skip queueing it.
			if (M[a + C.SUBS] !== 0 || (liveDeferredMask & ~retiredSlotMask & slotChainMask) !== 0) {
				requestWalk(a, 0);
			}
		} else {
			// Stamp the unapplied cone before the write returns: grouped drains
			// run at batch close, and an in-batch NEWEST read must already know
			// this cone can differ from W0.
			notifyWalkFromAtom(a, ++walkCounter, false, undefined, true);
			// Same no-op elision as the urgent branch, scoped to this token's
			// own chain (a deferred write can only shift its own writer world).
			if (M[a + C.SUBS] !== 0 || slotMemoHead[slot] !== 0) {
				requestWalk(a, token);
			}
		}
		topLevelSettle();
	}

	// Top-of-stack settlement: grouped drains happen at batch() close; plain
	// writes drain in their own call stack (§9.8 grouping rule).
	function topLevelSettle(): void {
		if (batchDepth !== 0 || canonicalEvalDepth !== 0 || runDepth !== 0 || drainDepth !== 0) {
			return;
		}
		if (queuedLength > notifyIndex) {
			flush();
		}
		if (pendingWalks.length !== 0 || kernelBroadcasts.length !== 0) {
			drainAll(false);
		}
		if (enterDepth === 0) {
			// Sweeping folds RETIRED entries; only retirement, truncation, and
			// pass-end (pin release) create foldable work — steady writes never
			// do, so the per-write settle skips the sweep walk entirely.
			if (sweepNeeded) {
				sweepNeeded = false;
				sweepLogs();
				tryQuiescence();
			}
			maybeBoundary();
		}
	}

	// ---- retirement + absorption (§9.5; resolution 7a; W0-no-op pitfall) -----------
	function onBatchRetiredEdge(token: number, _committed: boolean): void {
		// `committed=false` folds identically — the writes are real (§9.5).
		const slot = findLiveSlot(token);
		if (slot < 0) {
			return; // batch carried no external writes — unknown, ignored
		}
		++overlayEpoch; // world values changed with no tape-tail movement (§10.5)
		++certGen; // fused worldStamp: epoch bumps invalidate cached world values
		const rt = ticket(); // ONE retire ticket per retirement (resolution 7a)
		if (tracer !== undefined) {
			tracer.emit(TraceKind.BATCH_RETIRED, 0, token, rt, _committed ? 1 : 0);
		}
		++batchDepth;
		try {
			for (let i = 0; i < loggedAtoms.length; ++i) {
				const a = loggedAtoms[i];
				let touched = false;
				let rec = G[M[a + C.LOG_HEAD] + C.L_NEXT];
				while (rec !== 0) {
					const m = G[rec + C.L_META];
					if (
						((m >> C.SLOT_SHIFT) & C.SLOT_MASK) === slot
						&& (m & (C.M_PSEUDO | C.M_RETIRED)) === 0
					) {
						G[rec + C.L_META] = m | C.M_RETIRED;
						G[rec + C.L_RETIRED_SEQ] = rt;
						if ((m & C.M_APPLIED) === 0) {
							--unappliedEntries;
							const n = (atomUnapplied.get(a) ?? 0) - 1;
							if (n <= 0) {
								atomUnapplied.delete(a);
							} else {
								atomUnapplied.set(a, n);
							}
						}
						touched = true;
					}
					rec = G[rec + C.L_NEXT];
				}
				if (touched) {
					// Absorb: replay the W0 fold; write through the kernel iff the
					// committed value moved (policy equality, §11.2).
					const fold = foldTape(a, W0_WORLD);
					if (!valEq(equalityOf(a), pendingValueOf(a), fold)) {
						kernelWriteAtom(a, fold);
						if (tracer !== undefined) {
							tracer.emit(TraceKind.ABSORB, a, token, 1);
						}
					} else if (tracer !== undefined) {
						tracer.emit(TraceKind.ABSORB, a, token, 0);
					}
					// Even a W0-no-op retirement makes this batch's entries visible
					// in every OTHER writer's world (coordinator pitfall): queue a
					// token-0 walk so the drain's expansion re-decides watchers in
					// each live deferred world — same shape as resolution 2 (and
					// the same provable no-op elision applies).
					if (M[a + C.SUBS] !== 0 || (liveDeferredMask & ~retiredSlotMask & slotChainMask) !== 0) {
						requestWalk(a, 0);
					}
				}
			}
		} finally {
			--batchDepth;
		}
		if (batchDepth === 0) {
			flush(); // one effect flush for the whole absorption (§9.5)
		}
		retiredSlotMask |= 1 << slot;
		liveDeferredMask &= ~(1 << slot);
		// §13.4: when a token retires everywhere, roots that had locked it in
		// clear the slot bit and advance their pin past the retirement ticket —
		// the view's CONTENTS are unchanged by this bookkeeping step.
		if (rootViews.size !== 0)
		for (const view of rootViews.values()) {
			if (((view.mask >> slot) & 1) !== 0) {
				view.mask &= ~(1 << slot);
				if (view.pin < rt) {
					view.pin = rt;
				}
			}
		}
		releaseSlotIfDone(slot);
		sweepNeeded = true;
		// Post-retirement drain with full re-validation: a retirement that
		// leaves W0 unchanged still shifts every OTHER pending world (retired
		// entries become visible in their writer's worlds) — coordinator
		// pitfall "W0-no-op retirement".
		drainAll(true);
		sweepLogs();
		// Retired token → its per-watcher baselines are dead; drop them (and
		// any straggler keys from earlier retirements' fallback decisions).
		pruneWatcherBaselines();
		tryQuiescence();
		maybeBoundary(); // process reclaim retries the sweep just unblocked
	}

	// ---- truncation (§9.6 + resolution 4) ---------------------------------------------
	function truncateBatch(token: number): void {
		const slot = findLiveSlot(token);
		if (slot < 0) {
			return;
		}
		++overlayEpoch; // mid-tape unlinks move no tail seq — memos must re-check
		++certGen;
		if (tracer !== undefined) {
			tracer.emit(TraceKind.TRUNCATE, 0, token);
		}
		for (let i = 0; i < loggedAtoms.length; ++i) {
			const a = loggedAtoms[i];
			const head = M[a + C.LOG_HEAD];
			let prev = head;
			let rec = G[head + C.L_NEXT];
			let touched = false;
			while (rec !== 0) {
				const m = G[rec + C.L_META];
				const next = G[rec + C.L_NEXT];
				if (
					((m >> C.SLOT_SHIFT) & C.SLOT_MASK) === slot
					&& (m & (C.M_PSEUDO | C.M_RETIRED | C.M_APPLIED)) === 0
				) {
					G[prev + C.L_NEXT] = next;
					if (M[a + C.LOG_TAIL] === rec) {
						M[a + C.LOG_TAIL] = prev;
					}
					--unappliedEntries;
					{
						const n = (atomUnapplied.get(a) ?? 0) - 1;
						if (n <= 0) {
							atomUnapplied.delete(a);
						} else {
							atomUnapplied.set(a, n);
						}
					}
					--batchEntryCount[slot];
					freeLog(rec);
					touched = true;
				} else {
					prev = rec;
				}
				rec = next;
			}
			if (touched) {
				// Resolution 4: re-notify the rolled-back batch's lane — watchers
				// directly on this atom see the reverted world value.
				requestWalk(a, token);
			}
		}
		releaseSlotIfDone(slot);
		sweepNeeded = true;
		// Resolution 4: re-notify the rolled-back batch's lane, else its
		// components stay stale until an unrelated drain.
		if (batchToken[slot] === token) {
			revalidateSlotChain(slot);
		}
		drainAll(false);
		if (enterDepth === 0 && drainDepth === 0) {
			sweepLogs();
			tryQuiescence();
		}
		maybeBoundary(); // process reclaim retries the sweep just unblocked
	}

	// ---- sweep (§9.6) ---------------------------------------------------------------
	function sweepLogs(): void {
		let moved = false;
		const minPin = passOpen !== 0 ? passPin : C.MAX_SEQ;
		for (let i = loggedAtoms.length - 1; i >= 0; --i) {
			const a = loggedAtoms[i];
			const head = M[a + C.LOG_HEAD];
			const eq = equalityOf(a);
			let rec = G[head + C.L_NEXT];
			while (rec !== 0) {
				const m = G[rec + C.L_META];
				if ((m & C.M_RETIRED) === 0 || G[rec + C.L_RETIRED_SEQ] > minPin) {
					break; // only the leading dead run folds (§9.6)
				}
				const folded = applyLogOp(a, rec, logVals[head >> 2]);
				if (!valEq(eq, logVals[head >> 2], folded)) {
					logVals[head >> 2] = folded;
				}
				G[head + C.L_SEQ] = G[rec + C.L_RETIRED_SEQ];
				G[head + C.L_RETIRED_SEQ] = G[rec + C.L_RETIRED_SEQ];
				if ((m & C.M_PSEUDO) === 0) {
					const slot = (m >> C.SLOT_SHIFT) & C.SLOT_MASK;
					--batchEntryCount[slot];
					releaseSlotIfDone(slot);
				}
				const next = G[rec + C.L_NEXT];
				freeLog(rec);
				G[head + C.L_NEXT] = next;
				if (next === 0) {
					M[a + C.LOG_TAIL] = head;
				}
				moved = true;
				rec = next;
			}
			// Free the tape: base-only, and no live unretired batch could still
			// write (conservative form — see final report).
			if (G[head + C.L_NEXT] === 0 && (liveSlotMask & ~retiredSlotMask) === 0 && passOpen === 0) {
				freeLog(head);
				M[a + C.LOG_HEAD] = 0;
				M[a + C.LOG_TAIL] = 0;
				M[a + C.FLAGS] &= ~C.LOGGED;
				// swap-pop (splice allocates its removed-elements array)
				loggedAtoms[i] = loggedAtoms[loggedAtoms.length - 1];
				loggedAtoms.pop();
				--loggedAtomCount;
				noteReclaimRetry(a); // tape gone: retry a GC-skipped reclaim
				moved = true;
			}
		}
		if (moved) {
			++certGen; // folds/frees moved tape tails or LOGGED bits
		}
	}

	// ---- quiescence (§9.7) -------------------------------------------------------------
	function tryQuiescence(): void {
		if (
			loggedAtomCount !== 0
			|| passOpen !== 0
			|| liveSlotMask !== 0
			|| pendingWalks.length !== 0
			|| kernelBroadcasts.length !== 0
			|| drainDepth !== 0
			|| enterDepth !== 0
		) {
			return;
		}
		gNext = 4;
		logFreeHead = 0;
		if (wNext !== 8) {
			wNext = 8;
			certNext = 2;
			memoVals.length = 0;
			slotMemoHead.fill(0);
		}
		slotChainMask = 0;
		eraFloor = walkCounter; // every mark (and unapplied stamp) goes stale in O(1)
		if (atomUnapplied.size !== 0) {
			atomUnapplied.clear();
		}
		if (rootViews.size !== 0) {
			for (const view of rootViews.values()) {
				view.pin = 0; // seqs restart; committed history lives in the kernel now
				view.mask = 0;
			}
		}
		++overlayEpoch; // the cross-era invalidator (§9.7): seqs repeat, epochs don't
		seqCounter = 1;
		++certGen; // recycled record offsets must not inherit stale validations
		++quiescenceCount;
		pruneWatcherBaselines(); // all slots are empty: only the W0 baseline survives
		if (tracer !== undefined) {
			tracer.emit(TraceKind.QUIESCENCE, 0, 0, quiescenceCount);
		}
		// Walk-counter safety valve (§9.7): only at quiescence, nothing pinned.
		if (walkCounter > 1 << 30) {
			for (let i = 0; i < allNodes.length; ++i) {
				const id = allNodes[i];
				if ((M[id + C.FLAGS] & (C.K_COMPUTED | C.K_EFFECT | C.K_SCOPE | C.K_WATCHER)) !== 0) {
					M[id + C.OVERLAY_STAMP] = 0;
					unappliedStamp[id >> 3] = 0;
				}
			}
			walkCounter = 0;
			eraFloor = 0;
		}
	}

	// ---- bridge (§13 subset: pass lifecycle, activation, retirement) ----------------
	function onPassStartEdge(container: Container, tokens: readonly number[], lineage: number): void {
		passOpen = 1;
		passExecuting = 1;
		++passSerial;
		passPin = seqCounter; // ticket() pre-increments: existing seqs <= pin
		let mask = 0;
		for (const t of tokens) {
			const s = findLiveSlot(t);
			if (s >= 0) {
				mask |= 1 << s;
			}
			// Tokens with no external writes are unknown and ignored (§6.3).
		}
		passIncludeMask = mask;
		passContainer = container;
		passLineage = lineage;
		passWorld = {
			k: C.WK_PASS,
			key: ((passSerial << 2) | 1) | 0,
			token: 0,
			slot: -1,
			pin: passPin,
			mask,
		};
		readCtx = C.CTX_RENDER;
		if (tracer !== undefined) {
			tracer.emit(TraceKind.RENDER_PASS_START, 0, mask, passPin, lineage);
		}
	}

	function onPassEndEdge(): void {
		if (tracer !== undefined) {
			tracer.emit(TraceKind.RENDER_PASS_END, 0, passIncludeMask);
		}
		passOpen = 0;
		passExecuting = 0;
		passContainer = undefined;
		readCtx = C.CTX_NEWEST;
		sweepNeeded = true;
		sweepLogs(); // §9.6: sweep runs at pass end (pin release folds entries)
		tryQuiescence();
	}

	function attachFork(f: ForkAdapter): () => void {
		if (fork !== undefined) {
			throw new Error('cosignal: fork already attached');
		}
		fork = f;
		const listener: ExternalRuntimeListener = {
			onRootRegistered: () => {
				// §9.1 monotonic activation: DIRECT → LOGGED, permanently.
				writeMode = C.MODE_LOGGED;
			},
			onRenderPassStart: (c, tokens, lineage) => onPassStartEdge(c, tokens, lineage),
			onRenderPassYield: () => {
				// §10.1: code in yield gaps is not render code.
				passExecuting = 0;
				readCtx = C.CTX_NEWEST;
			},
			onRenderPassResume: () => {
				passExecuting = 1;
				readCtx = C.CTX_RENDER;
			},
			onRenderPassEnd: () => onPassEndEdge(),
			onBatchCommitted: (container, token) => {
				// §13.4: refresh this root's committed view. Entries retired at
				// or below the fresh pin are in the view; a batch committed here
				// while pending elsewhere locks in via the mask.
				let view = rootViews.get(container);
				if (view === undefined) {
					rootViews.set(container, (view = { pin: 0, mask: 0 }));
				}
				view.pin = ticket();
				const slot = findLiveSlot(token);
				if (slot >= 0) {
					view.mask |= 1 << slot;
				}
				for (const cb of commitListeners) {
					cb(container);
				}
			},
			onBatchRetired: (token, committed) => onBatchRetiredEdge(token, committed),
			// onBatchOpened (coordinator resolution 6): variant A's monotonic
			// gate does not consume it.
		};
		unsubscribeFork = f.subscribeToExternalRuntime(listener);
		return () => {
			unsubscribeFork?.();
			unsubscribeFork = undefined;
			fork = undefined;
		};
	}

	// ---- public reads -----------------------------------------------------------------
	// The hot read is deliberately tiny (inline-budget shaped, §18.3): the
	// accessor-call layers were ~20% of the kairo-broad tick because the
	// public dispatchers were too big to inline into the handle getters.
	function readAtomPublic(a: number): unknown {
		// Canonical-eval reads (W0) and untainted non-render reads share this
		// exact shape: resolve DIRTY if pending, link if tracked.
		if (
			frameWorlds.length === 0
			&& (M[a + C.FLAGS] & (C.LOGGED | C.DIRTY)) === 0
			&& (canonicalEvalDepth > 0 || readCtx !== C.CTX_RENDER || healStaleRenderCtx())
		) {
			if (activeSub !== 0) {
				link(a, activeSub, cycle);
			}
			return values[a >> 2];
		}
		return readAtomSlow(a);
	}

	function readAtomSlow(a: number): unknown {
		if (canonicalEvalDepth > 0) {
			return kernelReadAtom(a); // kernel-internal context: W0 by construction
		}
		if (frameWorlds.length > 0) {
			return overlayReadAtom(a);
		}
		if ((M[a + C.FLAGS] & C.LOGGED) === 0 && readCtx !== C.CTX_RENDER) {
			return kernelReadAtom(a);
		}
		const v = resolveAtomInWorld(a, ambientWorld());
		if (activeSub !== 0 && readCtx !== C.CTX_RENDER) {
			link(a, activeSub, cycle); // §10.3: render never mutates topology
		}
		return v;
	}

	function readComputedPublic(c: number): unknown {
		// Inline-budget fast dispatch; one real call in the common case.
		if (
			frameWorlds.length === 0
			&& (canonicalEvalDepth > 0 || (loggedAtomCount === 0 && readCtx !== C.CTX_RENDER))
		) {
			return kernelComputedRead(c);
		}
		return readComputedSlow(c);
	}

	function readComputedSlow(c: number): unknown {
		if (frameWorlds.length > 0) {
			// Resolution 5: inside an overlay frame, ALWAYS recurse via
			// overlayEvaluate — never the kernel path (unless canonical
			// evaluation is live above the frame, which cannot happen: frames
			// never invoke kernel evaluation).
			return overlayEvaluate(c, frameWorlds[frameWorlds.length - 1]);
		}
		const v = resolveComputedInWorld(c, ambientWorld());
		if (activeSub !== 0 && readCtx !== C.CTX_RENDER) {
			link(c, activeSub, cycle);
		}
		return v;
	}

	// ---- node constructors ---------------------------------------------------------
	function newEffectNode(fn: () => (() => void) | void): number {
		const e = allocNode(C.K_EFFECT | C.WATCHING | C.RECURSED_CHECK);
		fns[e >> 3] = fn;
		const prevSub = activeSub;
		activeSub = e;
		if (prevSub !== 0) {
			link(e, prevSub, 0);
			M[prevSub + C.FLAGS] |= C.HAS_CHILD_EFFECT;
		}
		++enterDepth;
		try {
			++runDepth;
			values[(e >> 2) + 1] = fn();
		} finally {
			--runDepth;
			--enterDepth;
			activeSub = prevSub;
			M[e + C.FLAGS] &= ~C.RECURSED_CHECK;
		}
		return e;
	}

	function newScopeNode(fn: () => void): number {
		const e = allocNode(C.K_SCOPE | C.MUTABLE);
		const prevSub = activeSub;
		activeSub = e;
		if (prevSub !== 0) {
			link(e, prevSub, 0);
			M[prevSub + C.FLAGS] |= C.HAS_CHILD_EFFECT;
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

	// ---- public API ---------------------------------------------------------------
	function atom<T>(
		initial: T,
		opts?: {
			isEqual?: Equality<T>;
			label?: string;
			observeEffect?: (ctx: {
				peek(): unknown;
				set(v: unknown): void;
				update(f: (x: unknown) => unknown): void;
			}) => (() => void) | void;
		},
	): AtomHandle<T> {
		maybeBoundary();
		const id = allocNode(C.K_ATOM | C.MUTABLE);
		const v = id >> 2;
		values[v] = initial;
		values[v + 1] = initial;
		if (opts?.isEqual !== undefined || opts?.label !== undefined || opts?.observeEffect !== undefined) {
			metas[id >> 3] = {
				isEqual: opts?.isEqual as Equality<unknown> | undefined,
				label: opts?.label,
				observeEffect: opts?.observeEffect,
			};
		}
		const handle = {
			kind: 'atom',
			id,
			fin: newFinToken(id), // §14.2 reclamation token, dies with the handle
			get state(): T {
				return readAtomPublic(id) as T;
			},
			peek(): T {
				const s = activeSub;
				activeSub = 0;
				try {
					return resolveAtomInWorld(id, ambientWorld()) as T;
				} finally {
					activeSub = s;
				}
			},
			set(next: T): void {
				writeOp(id, C.OP_SET, next);
			},
			update(fn: (current: T) => T): void {
				writeOp(id, C.OP_UPDATE, fn);
			},
		} as const;
		return handle as AtomHandle<T>;
	}

	function reducerAtom<S, A>(
		initial: S,
		reducer: (state: S, action: A) => S,
		opts?: { isEqual?: Equality<S>; label?: string },
	): ReducerAtomHandle<S, A> {
		maybeBoundary();
		const id = allocNode(C.K_ATOM | C.MUTABLE);
		const v = id >> 2;
		values[v] = initial;
		values[v + 1] = initial;
		metas[id >> 3] = {
			isEqual: opts?.isEqual as Equality<unknown> | undefined,
			label: opts?.label,
			reducer: reducer as (state: unknown, action: unknown) => unknown,
		};
		const handle = {
			kind: 'reducerAtom',
			id,
			fin: newFinToken(id), // §14.2 reclamation token, dies with the handle
			get state(): S {
				return readAtomPublic(id) as S;
			},
			peek(): S {
				const s = activeSub;
				activeSub = 0;
				try {
					return resolveAtomInWorld(id, ambientWorld()) as S;
				} finally {
					activeSub = s;
				}
			},
			dispatch(action: A): void {
				writeOp(id, C.OP_DISPATCH, action);
			},
		} as const;
		return handle as ReducerAtomHandle<S, A>;
	}

	function computed<T>(
		fn: () => T,
		opts?: {
			isEqual?: Equality<T>;
			label?: string;
			/** Policy-supplied fused kernel wrapper (§11.2): receives the
			 * previous cached value and owns equality/box stability itself —
			 * saves a call frame per recomputation. `fn` remains the raw
			 * overlay-evaluation function. */
			kernelFn?: (prev?: unknown) => unknown;
		},
	): ComputedHandle<T> {
		maybeBoundary();
		const id = allocNode(C.K_COMPUTED);
		const isEqual = opts?.isEqual as Equality<unknown> | undefined;
		metas[id >> 3] = { isEqual, label: opts?.label, rawFn: fn as () => unknown };
		// Kernel wrapper (§11.2): custom equality returns the previous
		// reference so the kernel's identity compare reports "unchanged".
		fns[id >> 3] = opts?.kernelFn !== undefined
			? opts.kernelFn
			: isEqual === undefined
				? (fn as (prev?: unknown) => unknown)
				: (prev?: unknown): unknown => {
					const next = (fn as () => unknown)();
					return prev !== undefined && isEqual(prev, next) ? prev : next;
				};
		const handle = {
			kind: 'computed',
			id,
			fin: newFinToken(id), // §14.2 reclamation token, dies with the handle
			get state(): T {
				return readComputedPublic(id) as T;
			},
		} as const;
		return handle as ComputedHandle<T>;
	}

	function watch(target: SignalHandle, onBroadcast?: (ev: BroadcastEvent) => void): WatcherHandle {
		maybeBoundary();
		const targetId = target.id;
		const w = allocNode(C.K_WATCHER | C.WATCHING | C.IMMEDIATE);
		const meta: NodeMeta = { watchedId: targetId, lastBroadcast: new Map(), onBroadcast };
		metas[w >> 3] = meta;
		liveWatchers.add(w);
		link(targetId, w, 0);
		// Baseline: the watcher "rendered" the current canonical value.
		meta.lastBroadcast!.set(0, worldValueOf(targetId, W0_WORLD));
		// Subscription-time seeding of live deferred worlds (resolution 7b) —
		// evaluating here also creates the writer's-world memos that register
		// the node on the slot chains (first-divergence coverage).
		for (const t of liveDeferredTokens()) {
			meta.lastBroadcast!.set(t, worldValueOf(targetId, writerWorld(t)));
		}
		const gen = M[w + C.GEN];
		return {
			id: w,
			dispose(): void {
				if (M[w + C.GEN] === gen) {
					dispose(w);
					maybeBoundary();
				}
			},
		};
	}

	function effect(fn: () => void | (() => void)): () => void {
		maybeBoundary();
		const id = newEffectNode(fn);
		const gen = M[id + C.GEN];
		topLevelSettle();
		return () => {
			if (M[id + C.GEN] !== gen) {
				return;
			}
			dispose(id);
			maybeBoundary();
		};
	}

	function effectScope(fn: () => void): () => void {
		maybeBoundary();
		const id = newScopeNode(fn);
		const gen = M[id + C.GEN];
		topLevelSettle();
		return () => {
			if (M[id + C.GEN] !== gen) {
				return;
			}
			dispose(id);
			maybeBoundary();
		};
	}

	function batch<T>(fn: () => T): T {
		++batchDepth;
		try {
			return fn();
		} finally {
			if (--batchDepth === 0) {
				topLevelSettle(); // grouped drain at batch close (§9.8)
			}
		}
	}

	/** Low-level batch surface (adapter/bindings plumbing; prefer batch()). */
	function startBatch(): void {
		++batchDepth;
	}

	function endBatch(): void {
		if (--batchDepth === 0) {
			topLevelSettle(); // grouped drain at batch close (§9.8)
		}
	}

	function untracked<T>(fn: () => T): T {
		const prevSub = activeSub;
		activeSub = 0;
		++untrackedDepth;
		const certBase = certSp;
		try {
			return fn();
		} finally {
			activeSub = prevSub;
			--untrackedDepth;
			// Untracked reads are not dependencies in ANY world: roll back
			// certificate pairs recorded inside (kernel parity of
			// untracked-staleness — conformance #76 — extended to worlds).
			certSp = certBase;
		}
	}

	function committedWorldFor(container?: Container): WorldDesc {
		if (container === undefined) {
			return COMMITTED_WORLD;
		}
		const view = rootViews.get(container);
		if (view === undefined) {
			// A root that never committed: nothing retired is on its screen yet
			// beyond what quiescence folded into the kernel.
			return { k: C.WK_COMMITTED, key: -1, token: 0, slot: -1, pin: 0, mask: 0 };
		}
		return { k: C.WK_COMMITTED, key: -1, token: 0, slot: -1, pin: view.pin, mask: view.mask };
	}

	function readCommitted<T>(target: SignalHandle, container?: Container): T {
		const prevCtx = readCtx;
		readCtx = C.CTX_COMMITTED;
		try {
			const id = target.id;
			const world = committedWorldFor(container);
			return ((M[id + C.FLAGS] & C.K_ATOM) !== 0
				? resolveAtomInWorld(id, world)
				: resolveComputedInWorld(id, world)) as T;
		} finally {
			readCtx = prevCtx;
		}
	}

	function worldFromSelector(sel: WorldSelector): WorldDesc {
		switch (sel.kind) {
			case 'w0':
				return W0_WORLD;
			case 'newest':
				return NEWEST_WORLD;
			case 'committed':
				return COMMITTED_WORLD;
			case 'committedOn':
				return committedWorldFor(sel.container);
			case 'writer':
				return writerWorld(sel.token);
			case 'pass':
				return passWorld;
			case 'rendered': {
				// The §13.2 fixup's re-resolution of a remembered render world,
				// NOW: committed (retired) + applied + the remembered include
				// set. The render pin served render stability only — everything
				// retired/applied since the pin is exactly what the component
				// missed. Retired include-tokens degrade gracefully into the
				// RETIRED clause. key -1 = never memoized.
				let mask = 0;
				for (const t of sel.tokens) {
					const slot = findLiveSlot(t);
					if (slot >= 0) {
						mask |= 1 << slot;
					}
				}
				return { k: C.WK_WRITER, key: -1, token: 0, slot: -1, pin: sel.pin, mask };
			}
		}
	}

	// ---- verifyArena-lite (§16.6 subset) ----------------------------------------------
	function verify(): void {
		const problems: string[] = [];
		if (propSp !== 0) problems.push(`propSp=${propSp} (expected 0 at boundary)`);
		if (checkSp !== 0) problems.push(`checkSp=${checkSp}`);
		if (frameWorlds.length !== 0) problems.push(`frameWorlds=${frameWorlds.length}`);
		if (certSp !== 0) problems.push(`certSp=${certSp}`);
		if (eraFloor > walkCounter) problems.push(`eraFloor ${eraFloor} > walkCounter ${walkCounter}`);
		for (let i = 0; i < 8; ++i) {
			if (M[i] !== 0) problems.push(`main-plane record 0 corrupted at +${i}`);
			if (i < 4 && G[i] !== 0) problems.push(`log-plane record 0 corrupted at +${i}`);
			if (W[i] !== 0) problems.push(`memo-plane record 0 corrupted at +${i}`);
		}
		let counted = 0;
		for (const a of loggedAtoms) {
			if ((M[a + C.FLAGS] & C.LOGGED) === 0) problems.push(`loggedAtoms holds unlogged ${a}`);
			if (M[a + C.LOG_HEAD] === 0) problems.push(`logged atom ${a} has no tape`);
			// tape chain acyclic + tail coherent
			let rec = M[a + C.LOG_HEAD];
			let steps = 0;
			let last = rec;
			while (rec !== 0 && steps < 1_000_000) {
				last = rec;
				rec = G[rec + C.L_NEXT];
				++steps;
			}
			if (rec !== 0) problems.push(`tape of ${a} appears cyclic`);
			if (M[a + C.LOG_TAIL] !== last) problems.push(`LOG_TAIL of ${a} incoherent`);
			++counted;
		}
		if (counted !== loggedAtomCount) problems.push(`loggedAtomCount ${loggedAtomCount} != list ${counted}`);
		for (let s = 0; s < 32; ++s) {
			if (batchEntryCount[s] < 0) problems.push(`batchEntryCount[${s}] negative`);
			if (batchToken[s] === 0 && ((liveSlotMask >> s) & 1) !== 0) problems.push(`liveSlotMask bit ${s} without token`);
			if (batchToken[s] !== 0 && ((liveSlotMask >> s) & 1) === 0) problems.push(`token in slot ${s} without mask bit`);
			// slot memo chains acyclic + writer-key + slot-coherent
			let rec = slotMemoHead[s];
			let steps = 0;
			while (rec !== 0 && steps < 1_000_000) {
				if ((W[rec + C.W_KEY] & 3) !== 2) problems.push(`slot ${s} chain holds non-writer key`);
				rec = W[rec + C.W_SLOT_NEXT];
				++steps;
			}
			if (rec !== 0) problems.push(`slot ${s} memo chain cyclic`);
		}
		// §8.6 refcount invariant: every node's liveCount equals the number of
		// its subscriber links whose consumer is live (count > 0 or intrinsic).
		for (const id of allNodes) {
			if ((M[id + C.FLAGS] & C.KIND_MASK) === 0) {
				continue; // freed
			}
			let n = 0;
			let lnk = M[id + C.SUBS];
			let steps = 0;
			while (lnk !== 0 && steps < 1_000_000) {
				if (isLiveNode(M[lnk + C.SUB])) {
					++n;
				}
				lnk = M[lnk + C.NEXT_SUB];
				++steps;
			}
			if (liveCount[id >> 3] !== n) {
				problems.push(`liveCount[${id}] = ${liveCount[id >> 3]}, recount = ${n}`);
			}
		}
		if (loggedAtomCount === 0 && passOpen === 0 && liveSlotMask === 0 && pendingWalks.length === 0) {
			// Quiescence postconditions (§8.8/§9.7/§14.3).
			if (gNext !== 4) problems.push(`quiescent but gNext=${gNext}`);
			if (wNext !== 8) problems.push(`quiescent but wNext=${wNext}`);
			if (certNext !== 2) problems.push(`quiescent but certNext=${certNext}`);
			if (memoVals.length !== 0) problems.push(`quiescent but memoVals=${memoVals.length}`);
			if (seqCounter !== 1) problems.push(`quiescent but seqCounter=${seqCounter}`);
			for (let s = 0; s < 32; ++s) {
				if (slotMemoHead[s] !== 0) problems.push(`quiescent but slotMemoHead[${s}]!=0`);
			}
			for (const id of allNodes) {
				const f = M[id + C.FLAGS];
				if ((f & (C.K_COMPUTED | C.K_EFFECT | C.K_SCOPE | C.K_WATCHER)) !== 0 && M[id + C.OVERLAY_STAMP] > eraFloor) {
					problems.push(`quiescent but node ${id} still marked`);
				}
			}
		}
		if (problems.length > 0) {
			throw new Error('verifyArena: ' + problems.join('; '));
		}
	}

	// §13.4: run `fn` reading in a root's committed world, collecting the
	// leaf atoms it (transitively) read — the committedEffect dependency set.
	function trackCommitted<T>(container: Container | undefined, fn: () => T): { value: T; reads: number[] } {
		const world = committedWorldFor(container);
		const prevCtx = readCtx;
		readCtx = C.CTX_COMMITTED;
		const base = certSp;
		frameWorlds.push(world);
		const prevSub = activeSub;
		activeSub = 0;
		try {
			const value = fn();
			const reads: number[] = [];
			for (let i = base; i < certSp; i += 2) {
				if (!reads.includes(certStack[i])) {
					reads.push(certStack[i]);
				}
			}
			return { value, reads };
		} finally {
			activeSub = prevSub;
			frameWorlds.pop();
			certSp = base;
			readCtx = prevCtx;
		}
	}

	function committedValueById(id: number, container: Container | undefined): unknown {
		return worldValueOf(id, committedWorldFor(container));
	}

	// §13.4 `useSignalEffect` analogue: a passive watcher over COMMITTED state,
	// re-run in a microtask after the owning root's commit when the committed
	// value of anything it tracked changed. Cleanup supported.
	function committedEffect(container: Container | undefined, fn: () => void | (() => void)): () => void {
		let disposed = false;
		let cleanup: (() => void) | undefined;
		let deps = new Map<number, unknown>();

		const runOnce = (): void => {
			cleanup?.();
			cleanup = undefined;
			const { value, reads } = trackCommitted(container, fn);
			cleanup = (value as (() => void) | undefined) ?? undefined;
			deps = new Map(reads.map((id) => [id, committedValueById(id, container)]));
		};

		const recheck = (): void => {
			if (disposed) {
				return;
			}
			for (const [id, last] of deps) {
				const cur = committedValueById(id, container);
				if (!valEq(equalityOf(id), last, cur)) {
					runOnce();
					return;
				}
			}
		};

		const onCommit = (c: Container): void => {
			if (container === undefined || c === container) {
				queueMicrotask(recheck); // "after commit" — matching useEffect's contract
			}
		};
		commitListeners.add(onCommit);
		runOnce();
		return () => {
			disposed = true;
			commitListeners.delete(onCommit);
			cleanup?.();
			cleanup = undefined;
		};
	}

	// §13.2: the world-aware post-subscribe fixup. `rendered` remembers the
	// world (pin + included tokens) and value the component rendered with.
	function subscribeWithFixup(
		target: SignalHandle,
		rendered: { pin: number; tokens: readonly number[]; value: unknown; container?: Container },
		onSetState: (token: number, value: unknown) => void,
	): WatcherHandle {
		const handle = watch(target, (ev) => onSetState(ev.token, ev.value));
		const meta = metas[handle.id >> 3]!;
		const lb = meta.lastBroadcast!;
		const eq = equalityOf(target.id);
		// The watcher's W0 baseline is what it RENDERED, not the current W0 —
		// a gap write must fire the correction.
		lb.set(0, rendered.value);
		// Check 1: did this component's own world move? Re-resolve the
		// remembered rendered world NOW (committed + applied + its include
		// set — retired include-tokens degrade into the committed clause, the
		// spec's degenerate form).
		const nowValue = worldValueOf(
			target.id,
			worldFromSelector({ kind: 'rendered', pin: rendered.pin, tokens: rendered.tokens }),
		);
		if (!valEq(eq, nowValue, rendered.value)) {
			// Pre-paint urgent correction in the layout effect's own context.
			lb.set(0, nowValue);
			onSetState(0, nowValue);
		}
		// Check 2: did a pending world this component missed move? Entangle the
		// corrective update into that batch's own lanes (§6.5) so it renders
		// and commits WITH the batch — never a separate transition.
		for (const t of liveDeferredTokens()) {
			const v = worldValueOf(target.id, writerWorld(t));
			if (!valEq(eq, v, rendered.value)) {
				lb.set(t, v);
				if (fork === undefined || !fork.runInBatch(t, () => onSetState(t, v))) {
					// Retired between check and call: absorbed values are covered
					// by the committed/check-1 path — issue the urgent form.
					const fallback = readCommitted(target, rendered.container);
					if (!valEq(eq, fallback, rendered.value)) {
						lb.set(0, fallback);
						onSetState(0, fallback);
					}
				}
			} else {
				lb.set(t, v);
			}
		}
		return handle;
	}

	function configure(opts: { forbidWritesInComputeds?: boolean }): void {
		if (opts.forbidWritesInComputeds !== undefined) {
			forbidWritesInComputeds = opts.forbidWritesInComputeds;
		}
	}

	return {
		atom,
		reducerAtom,
		computed,
		watch,
		effect,
		effectScope,
		batch,
		startBatch,
		endBatch,
		untracked,
		readCommitted,
		truncateBatch,
		attachFork,
		configure,
		// Flat by-id reads for the policy classes: the class getter → handle
		// getter chain was ~28% of the effect-heavy kairo tick.
		readAtomById: readAtomPublic,
		readComputedById: readComputedPublic,
		/** Raw box-shape read for the isPending probe: tracked like any read
		 * (canonical link inside kernel evals, world-resolved in overlay
		 * frames), but the caller receives the box unforwarded. */
		readComputedRaw(id: number): unknown {
			if (canonicalEvalDepth > 0) {
				return kernelComputedRead(id);
			}
			if (frameWorlds.length > 0) {
				return overlayEvaluate(id, frameWorlds[frameWorlds.length - 1]);
			}
			return readComputedPublic(id);
		},
		/** Solid's latest(): sample the NEWEST world (Wn — every write
		 * visible, our staged-value analog) without pending registration;
		 * tracked callers still subscribe. */
		latestValue(id: number): unknown {
			const v = worldValueOf(id, NEWEST_WORLD);
			if (activeSub !== 0 && readCtx !== C.CTX_RENDER) {
				link(id, activeSub, cycle);
			}
			return v;
		},
		trackCommitted,
		committedEffect,
		subscribeWithFixup,
		/** The open pass's fixup-relevant identity: pin + included tokens
		 * (interned slots only — never-interned tokens carry no entries and
		 * cannot affect any re-resolution). undefined outside passes. */
		renderInfo(): { pin: number; tokens: number[]; container: Container } | undefined {
			if (passOpen === 0) {
				return undefined;
			}
			const tokens: number[] = [];
			for (let s2 = 0; s2 < 32; ++s2) {
				if (((passIncludeMask >> s2) & 1) !== 0 && batchToken[s2] !== 0) {
					tokens.push(batchToken[s2]);
				}
			}
			return { pin: passPin, tokens, container: passContainer };
		},
		/** §14.2 deterministic disposal of an atom/computed record (the same
		 * path the FinalizationRegistry takes for collected handles). */
		reclaim(h: SignalHandle): void {
			reclaimNode(h.id, M[h.id + C.GEN]);
		},
		setTracer(t: Tracer | undefined): void {
			tracer = t;
		},
		onCommit(cb: (container: Container) => void): () => void {
			commitListeners.add(cb);
			return () => {
				commitListeners.delete(cb);
			};
		},
		// Policy hooks (§12.3 suspense wiring; consumed by src/api.ts only).
		policy: {
			invalidate(h: SignalHandle): void {
				invalidate(h.id);
				if (batchDepth === 0 && canonicalEvalDepth === 0 && runDepth === 0 && drainDepth === 0) {
					flush();
					drainAll(false);
				}
			},
			bumpOverlayEpoch(): void {
				++overlayEpoch;
				++certGen; // fused worldStamp (settlements change world values)
			},
			canonicalValue(h: SignalHandle): unknown {
				return values[h.id >> 2];
			},
			/** The §12.3 (Solid-adapted) thenable-slot key: node×WORLD identity.
			 * Canonical evaluations share one key; pass-world evaluations key on
			 * the pass's INCLUDE MASK — the stable identity across restarts and
			 * Suspense retries of one logical work (two interleaved works on one
			 * root differ in batch sets, so they never alias; identical batch
			 * sets ARE the same world, where sharing is correct). */
			useCacheKey(): string {
				if (frameWorlds.length === 0) {
					return 'canon';
				}
				const w = frameWorlds[frameWorlds.length - 1];
				switch (w.k) {
					case C.WK_PASS:
						return w.key >= 0 ? 'p' + w.mask : 'x';
					case C.WK_WRITER:
						return w.token !== 0 ? 'w' + w.token : 'x';
					case C.WK_NEWEST:
						return 'n';
					default:
						return 'x';
				}
			},
			isLive(h: SignalHandle): boolean {
				return isLiveNode(h.id);
			},
		},
		debug: {
			verify,
			mode: (): 'DIRECT' | 'LOGGED' => (writeMode === C.MODE_LOGGED ? 'LOGGED' : 'DIRECT'),
			seqCounter: (): number => seqCounter,
			epoch: (): number => overlayEpoch,
			era: (): number => quiescenceCount,
			loggedAtomCount: (): number => loggedAtomCount,
			unappliedEntries: (): number => unappliedEntries,
			liveSlotMask: (): number => liveSlotMask,
			walkCounter: (): number => walkCounter,
			eraFloor: (): number => eraFloor,
			isLogged: (h: SignalHandle): boolean => (M[h.id + C.FLAGS] & C.LOGGED) !== 0,
			isMarked: (h: SignalHandle): boolean =>
				(M[h.id + C.FLAGS] & C.K_ATOM) === 0 && M[h.id + C.OVERLAY_STAMP] > eraFloor,
			readWorld: (h: SignalHandle, sel: WorldSelector): unknown =>
				worldValueOf(h.id, worldFromSelector(sel)),
			takeBroadcasts: (): BroadcastEvent[] => broadcastLog.splice(0, broadcastLog.length),
			quiescent: (): boolean =>
				loggedAtomCount === 0 && passOpen === 0 && liveSlotMask === 0,
			planeResidue: (): { g: boolean; w: boolean } => ({
				g: gNext === 4 && logFreeHead === 0,
				w: wNext === 8 && certNext === 2 && memoVals.length === 0,
			}),
			forceWalkCounter: (n: number): void => {
				walkCounter = n;
				if (eraFloor > n) {
					eraFloor = n;
				}
			},
			forceSeqCounter: (n: number): void => {
				seqCounter = n;
			},
			/** Run the GC finalization path for a handle's record — the same
			 * call the FinalizationRegistry makes (deterministic stand-in for
			 * GC timing; a guarded skip registers the reclaim retry). */
			simulateFinalize: (h: SignalHandle): void => {
				reclaimNode(h.id, M[h.id + C.GEN], true);
			},
			/** Number of per-world baseline entries a watcher holds (leak
			 * tests: must not grow with retired batches). */
			watcherBaselineCount: (h: { id: number }): number =>
				metas[h.id >> 3]?.lastBroadcast?.size ?? 0,
			stats: (): Record<string, number> => ({
				recNext,
				gNext,
				wNext,
				certNext,
				loggedAtomCount,
				liveSlotMask,
				liveDeferredMask,
				retiredSlotMask,
				walkCounter,
				eraFloor,
				overlayEpoch,
				seqCounter,
				passOpen,
				unappliedEntries,
				broadcastLogSize: broadcastLog.length,
				broadcastLogDropped,
				finalizePending: finalizeSkipped.size,
				liveWatcherCount: liveWatchers.size,
				memoValsLen: memoVals.length,
				pendingFreeLen: pendingFree.length,
			}),
		},
	};
}

export type CosignalEngine = ReturnType<typeof createCosignalEngine>;

