/**
 * cosignal v1 — LOGGED overlay (spec/cosignal-v1.md §5): the concurrent-worlds
 * engine riding the DIRECT kernel. This module is the TWIN entry of spec §7:
 * it is never imported by `./index.ts` (the DIRECT bundle's module graph stops
 * at index.ts — asserted by tests/twin-build.spec.ts), and it attaches through
 * the one seam index.ts anticipates: `__installTwinTable` re-points the
 * operation-table factory at the logged table and rebuilds `E` exactly once
 * over the carried buffers.
 *
 * What lives here (each section cites its spec rule):
 *   - receipts: always-log write receipts {op, slot, seq, retiredSeq} on
 *     per-atom tapes (§5.3); ops are stored whole so updaters/reducers replay
 *     per world under the fold-purity guard.
 *   - K0 riding (§5.2): every logged write applies to the kernel eagerly with
 *     stepwise equality — bridge atoms are kernel-backed `Atom` handles, and
 *     the newest world is read straight off the kernel plane. The
 *     engine-vs-oracle diff proves kernel value ≡ fold(base, receipts) at
 *     every step of the corpus.
 *   - K1 / the union edge plane (§5.5): world evaluations record real
 *     dependency edges, add-only within an episode, bulk-reset at quiescence.
 *     Delivery reachability runs over the episode-accumulated K0∪K1 union —
 *     the oracle's documented conservative semantics.
 *   - worlds as pure folds with the two-clause visibility rule (§5.3), the
 *     committed-for-root world, and §5.10's fast-forwarded mount-fixup world.
 *   - per-write value-blind synchronous delivery in the writer's stack with
 *     pass-aware suppression, per-(watcher, slot) dedup, and dedup clear at
 *     slot re-intern (§5.9).
 *   - the verified slot lifecycle (§5.4): stamp-before-release,
 *     claim-after-release, pin/seq-after-claim; deferred release re-evaluated
 *     at every pass end; keep-the-dirt disposal; release-anyway backstop.
 *   - retirement ordering stamp → fold → drain → clear-rows → release (§5.3),
 *     pin-gated prefix compaction (§5.3), per-root commit lock-in.
 *   - mount fixup per §5.10 INCLUDING the normative oracle errata
 *     (2026-07-05): the clock conjunct quantifies over the committing pass's
 *     mask TOKENS at commit time, and fast-out-suppressed divergence must be
 *     exactly corrective-covered (asserted on every mount).
 *   - effects per §5.11: core effects observe the newest world and flush
 *     after the write's walk; useSignalEffect-shaped observers evaluate in
 *     committed-for-root and revalidate at every durable flip.
 *   - episodes / quiescence / renumbering (§5.12).
 *
 * The bridge surface consumes fork-shaped events (batch open/retire, pass
 * begin/yield/resume/end with per-root commits, settlements) — simulated by
 * the oracle adapter for now; the real fork wiring is a later package.
 *
 * Deliberately deferred to the perf pass, marked at each site:
 *   TODO(gate:SPK-W)  int-packed receipt columns + tape pooling (write gate).
 *   TODO(gate:SPK-N1) touched-word marking + touched-list drains instead of
 *                     recomputed union reachability / observer scans.
 *   TODO(gate:SPK-R)  §5.6 read routing (kernel fast path + taint) and the
 *                     §5.7 memo ladder — non-newest folds currently always
 *                     evaluate, exactly like the oracle.
 */

import { Atom, __installTwinTable, type EngineTable } from './index.js';

// ---- error carriers -------------------------------------------------------------

/**
 * An operation that is illegal in the current fork state (the oracle's
 * ScheduleError analog): callers simulating the fork treat it as "skipped".
 */
export class BridgeScheduleError extends Error {}

/** An engine self-check failed — always a bug; never catch this. */
export class BridgeInvariantViolation extends Error {}

// ---- bridge-surface types (structurally mirror the oracle model's) --------------

export type Value = unknown;
export type NodeId = number;
export type TokenId = number;
export type SlotId = number;
export type RootId = string;
export type PassId = number;
export type WatcherId = number;
export type EffectId = number;

export type Priority = 'urgent' | 'default' | 'deferred';

/** §3.1 — set/update on atoms, dispatch on reducer atoms. */
export type Op =
	| { kind: 'set'; value: Value }
	| { kind: 'update'; fn: (prev: Value) => Value }
	| { kind: 'dispatch'; action: Value };

/**
 * §2 "receipt": {op, slot, seq} appended per write; retiredSeq stamped at the
 * batch's retirement. Receipts denormalize their slot at mint (§5.4 tenancy
 * lemma); the token is carried for invariants/event logs only.
 * Gate SPK-W landed: receipts live int-packed in per-atom `Tape` columns
 * ({kind, slot, seq, retiredSeq, token} parallel number columns + one
 * unknown[] payload side column); this materialized object shape is the
 * test/trace surface (`atom.tape` getter, trace `receipt` hook).
 */
export type Receipt = {
	op: Op;
	token: TokenId;
	slot: SlotId;
	seq: number;
	retiredSeq: number | undefined;
};

/** Op-kind tags for the packed column (SPK-W). */
const OP_SET = 0;
const OP_UPDATE = 1;
const OP_DISPATCH = 2;

/**
 * SPK-W int-packed receipt columns. Plain number arrays stay SMI-packed and
 * grow in place; `drop(cut)` compacts in place via copyWithin (tape pooling:
 * the arrays themselves are the pool — no per-receipt objects ever exist on
 * the hot path).
 */
export class Tape {
	/** Live window: entries [start, n). Compaction advances `start`; the
	 * arrays rebase (fresh packed slices) only when the dead prefix crosses
	 * the amortization threshold — never a per-retirement memmove (SPK-W
	 * tape pooling; shrink-in-place cycling drops V8 arrays to dictionary
	 * elements and was measured at ~10µs per drop). */
	start = 0;
	n = 0;
	kinds: number[] = [];
	slots: number[] = [];
	seqs: number[] = [];
	/** 0 = unretired (sequences start at 1). */
	retired: number[] = [];
	tokens: number[] = [];
	payloads: unknown[] = [];

	get length(): number {
		return this.n - this.start;
	}

	push(kind: number, slot: SlotId, seq: number, token: TokenId, payload: unknown): void {
		this.kinds.push(kind);
		this.slots.push(slot);
		this.seqs.push(seq);
		this.retired.push(0);
		this.tokens.push(token);
		this.payloads.push(payload);
		this.n++;
	}

	opAt(i: number): Op {
		const k = this.kinds[i]!;
		if (k === OP_SET) return { kind: 'set', value: this.payloads[i] };
		if (k === OP_UPDATE) return { kind: 'update', fn: this.payloads[i] as (prev: Value) => Value };
		return { kind: 'dispatch', action: this.payloads[i] };
	}

	entryAt(i: number): Receipt {
		const r = this.retired[i]!;
		return { op: this.opAt(i), token: this.tokens[i]!, slot: this.slots[i]!, seq: this.seqs[i]!, retiredSeq: r === 0 ? undefined : r };
	}

	materialize(): Receipt[] {
		const out: Receipt[] = [];
		for (let i = this.start; i < this.n; i++) out.push(this.entryAt(i));
		return out;
	}

	/** Drop the compacted prefix (advance the window; rebase amortized). */
	drop(cut: number): void {
		this.start += cut;
		if (this.start >= 1024 && this.start >= this.n - this.start) {
			const from = this.start;
			this.kinds = this.kinds.slice(from);
			this.slots = this.slots.slice(from);
			this.seqs = this.seqs.slice(from);
			this.retired = this.retired.slice(from);
			this.tokens = this.tokens.slice(from);
			this.payloads = this.payloads.slice(from);
			this.n -= from;
			this.start = 0;
		} else if (this.start === this.n) {
			// Empty window: reset cheaply (length-0 keeps the packed kind).
			this.kinds.length = 0;
			this.slots.length = 0;
			this.seqs.length = 0;
			this.retired.length = 0;
			this.tokens.length = 0;
			this.payloads.length = 0;
			this.n = 0;
			this.start = 0;
		}
	}
}

export type Equals = (a: Value, b: Value) => boolean;
export type Reducer = (state: Value, action: Value) => Value;

export class AtomNode {
	readonly kind = 'atom' as const;
	readonly id: NodeId;
	name: string;
	/** §2 "base": the folded floor of the tape (committed + compacted). */
	base: Value;
	baseSeq = 0;
	/** SPK-W packed receipt columns (the engine truth). */
	tp = new Tape();
	/** Full-history retention (invariant surface): materialized compacted receipts, kept only when `bridge.retainArchive`. */
	archiveStore: Receipt[] = [];
	origin: Value;
	equals: Equals;
	/** True iff `equals` is the default Object.is (write fast path). */
	eqIsDefault: boolean;
	reducer: Reducer | undefined = undefined;
	/** §5.7 — per-atom retirement stamp, minted at every retirement fold touching it. */
	retirementStamp = 0;
	/** §5.2 — the kernel-backed newest-world storage this overlay rides. */
	handle: Atom<Value>;
	/** Last token id that appended here (dedupe for token.atomsTouched). */
	lastTouchToken = 0;

	constructor(id: NodeId, name: string, initial: Value, equals: Equals, eqIsDefault: boolean, handle: Atom<Value>) {
		this.id = id;
		this.name = name;
		this.base = initial;
		this.origin = initial;
		this.equals = equals;
		this.eqIsDefault = eqIsDefault;
		this.handle = handle;
	}

	/** Test/diagnostic surface: the tape as materialized Receipt objects. */
	get tape(): Receipt[] {
		return this.tp.materialize();
	}

	get archive(): Receipt[] {
		return this.archiveStore;
	}
}

export type Reader = (node: AnyNode) => Value;
export type ComputedFn = (read: Reader, untracked: Reader) => Value;

export type ComputedNode = {
	kind: 'computed';
	id: NodeId;
	name: string;
	fn: ComputedFn;
};

export type AnyNode = AtomNode | ComputedNode;

export type Token = {
	id: TokenId;
	priority: Priority;
	action: boolean;
	parked: boolean;
	state: 'live' | 'retired';
	committedFlag: boolean | undefined;
	slot: SlotId | undefined;
	retiredSeq: number | undefined;
	/** Sequence of this token's last receipt (0 = none); §5.10 errata-1 clock conjunct. */
	lastWriteSeq: number;
	/** Atoms this token appended to (may hold benign duplicates; deduped at retirement). */
	atomsTouched: AtomNode[];
	/** Un-compacted receipts still on tapes (SPK-K1 reclamation gate). */
	liveReceipts: number;
	ambient: boolean;
};

/** §5.7 — one world memo: value + evaluation seq + per-atom-dep fingerprints. */
export type WorldMemo = {
	value: Value;
	/** Evaluation/re-stamp sequence (ladder step 2 compares write clocks to it). */
	seq: number;
	/** Root commit generation at (re-)stamp (committed worlds only). */
	gen: number;
	epoch: number;
	/** seq value at last validation (any state change mints a seq — cheap dedup). */
	checkedOp: number;
	/** Re-entrancy guard: stale cross-linked dep lists must refuse, not recurse. */
	validating: boolean;
	/** Direct atom deps (recorded during evaluation) + their fingerprints. */
	atoms: AtomNode[];
	fps: number[];
	/** Direct computed deps + the values they had (identity revalidation). */
	comps: ComputedNode[];
	compValues: Value[];
};

/** §5.4 — one of the 31 interning-table entries. */
export type SlotMeta = {
	id: SlotId;
	tenant: TokenId | undefined;
	claimSeq: number;
	/** §2 "write clock", in sequence units; zeroed at re-intern (§5.4). */
	writeClock: number;
	/** §5.4 disposal — carried dirt watermark (renumber duty, §5.12). */
	carriedMaxRetiredSeq: number;
	releasePending: boolean;
};

export type PassState = 'open' | 'yielded' | 'ended';

export type Pass = {
	id: PassId;
	root: RootId;
	/** §2 "pin" — frozen at pass start; observed forever, across yields. */
	pin: number;
	maskTokens: Set<TokenId>;
	maskSlots: Set<SlotId>;
	capturedCommittedSlots: Set<SlotId>;
	/** Bit forms of the slot sets (SlotId < 31), fixed at pass start. */
	maskBits: number;
	includedBits: number;
	state: PassState;
	endKind: 'commit' | 'discard' | undefined;
	mounted: WatcherId[];
	rendered: Set<WatcherId>;
	/** §5.7 pass-world memo plane — dies with the pass record. */
	memos: Map<NodeId, WorldMemo>;
	/** §5.9 edge-add deliveries discovered inside a render slice, queued to yield/end. */
	pendingEdgeDeliveries: { nodeId: NodeId; bits: number }[];
};

export type RootState = {
	id: RootId;
	/** §5.3 per-root lock-in rows: live tokens only (cleared at retirement). */
	committedTokens: Set<TokenId>;
	commitGen: number;
	/** Bit form of committedSlotsNow (maintained at commit/retire). */
	committedBits: number;
	/** Member slots written since the last drain (§5.3 write-set closure: the
	 * write is committed-visible immediately; the next durable drain must
	 * reconcile its cone — the model's full scan catches it at any
	 * retirement/commit). */
	committedDirtySlots: number;
	/** §5.7 committed-for-root memo plane (re-keyed by commitGen). */
	memos: Map<NodeId, WorldMemo>;
};

/** §5.10 — the watcher's rendered-world snapshot w_r. */
export type WatcherSnapshot = {
	passId: PassId;
	pin: number;
	maskSlots: Set<SlotId>;
	includedSlots: Set<SlotId>;
	rootCommitGen: number;
};

export class Watcher {
	readonly id: WatcherId;
	name: string;
	readonly root: RootId;
	readonly node: NodeId;
	live = false;
	lastRenderedValue: Value;
	snapshot: WatcherSnapshot;
	/** §5.9 — per-(watcher, slot) delivery dedup bits, one int word. */
	dedupBits = 0;

	constructor(id: WatcherId, name: string, root: RootId, node: NodeId, value: Value, snapshot: WatcherSnapshot) {
		this.id = id;
		this.name = name;
		this.root = root;
		this.node = node;
		this.lastRenderedValue = value;
		this.snapshot = snapshot;
	}

	/** Test surface: the dedup bits as a Set of slot ids. */
	get dedup(): Set<SlotId> {
		const out = new Set<SlotId>();
		for (let s = 0; s < SLOT_COUNT; s++) if ((this.dedupBits >>> s) & 1) out.add(s);
		return out;
	}
}

export type ReactEffect = {
	id: EffectId;
	name: string;
	root: RootId;
	node: NodeId;
	lastValue: Value;
	runs: number;
};

export type CoreEffect = {
	id: EffectId;
	name: string;
	node: NodeId;
	lastValue: Value;
	runs: number;
	/** Delivery-walk enqueue dedup generation (§5.11). */
	queuedWalk: number;
};

/** §2 "world" — one self-consistent assignment of values to all atoms. */
export type World =
	| { kind: 'newest' }
	| { kind: 'pass'; pass: Pass }
	| { kind: 'committed'; root: RootId }
	| { kind: 'mountFix'; maskSlots: Set<SlotId>; maskBits?: number; pin: number; root: RootId; excludeLiveTokens?: Set<TokenId> };

/** The one newest-world singleton (hot paths never allocate world objects). */
const NEWEST: World = { kind: 'newest' };
/** Touched-word masks (§5.5): bits 0–30 slots, bit 31 taint. */
const SLOT_MASK = 0x7fffffff;
const TAINT = -2147483648; // 1 << 31

/** The observable event stream (same shapes as the oracle's ModelEvent). */
export type BridgeEvent =
	| { type: 'write'; node: string; token: TokenId; slot: SlotId; seq: number }
	| { type: 'write-dropped'; node: string; token: TokenId }
	| { type: 'delivery'; watcher: string; token: TokenId; slot: SlotId; seq: number; mode: 'fresh' | 'interleaved' }
	| { type: 'suppressed'; watcher: string; token: TokenId; slot: SlotId; seq: number }
	| { type: 'core-effect-run'; effect: string; value: Value }
	| { type: 'react-effect-run'; effect: string; root: RootId; value: Value }
	| { type: 'reconcile-correction'; watcher: string; root: RootId; from: Value; to: Value; cause: 'retirement' | 'per-root-commit' }
	| { type: 'mount-corrective'; watcher: string; token: TokenId; slot: SlotId }
	| { type: 'mount-urgent-correction'; watcher: string; from: Value; to: Value }
	| { type: 'per-root-commit'; root: RootId; token: TokenId }
	| { type: 'retired'; token: TokenId; committed: boolean; retiredSeq: number }
	| { type: 'slot-claimed'; slot: SlotId; token: TokenId }
	| { type: 'slot-released'; slot: SlotId; token: TokenId }
	| { type: 'slot-backstop-released'; slot: SlotId; token: TokenId }
	| { type: 'pass-committed'; pass: PassId; root: RootId }
	| { type: 'pass-discarded'; pass: PassId; root: RootId }
	| { type: 'dev-warning'; message: string }
	| { type: 'epoch-reset'; epoch: number };

/**
 * R11 trace seam (§5.13 "Tracing"). The LOGGED engine's semantic events flow
 * to an OPTIONAL hook object held in `CosignalBridge.trace` — `undefined`
 * unless `cosignal/trace` (a lazily loaded, runtime-import-free entry) has
 * attached a recorder. Discipline, asserted by tests/trace-off.spec.ts:
 *
 *  - this module NEVER imports the trace module (lazy-loadability: the twin
 *    graph gains tracing only when the app imports `cosignal/trace`);
 *  - every hook site is guarded by exactly one nullable-slot check
 *    (`const tr = this.trace; if (tr !== undefined) ...`) — the whole
 *    untraced cost, per R11 ("untraced cost = one slot check per site");
 *  - hooks receive the engine's own live objects and integers; they must not
 *    mutate them, and the recorder must not allocate per event.
 *
 * Two channels: `event(e)` re-uses the always-allocated BridgeEvent stream at
 * its single `log()` waist (receipts/deliveries/retirements/commits/slots/
 * corrections/effects), and dedicated hooks cover semantics the oracle-shaped
 * stream does not carry: batch open/settle, pass start/yield/resume/end
 * (fired BEFORE the end's consequences, unlike the pass-committed event),
 * per-receipt ops, world evaluations, deferred slot release, and the mount
 * fixup disposition (§5.10 fast-out vs compare vs correction). `opEnd()`
 * marks the close of each compound public operation so the recorder can
 * scope causality (see trace.ts `CAUSE`).
 */
export type TraceHooks = {
	/** Every BridgeEvent, from the one `log()` waist. */
	event(e: BridgeEvent): void;
	/** §5.3 — a receipt was minted (fires with the 'write' event; carries the op). */
	receipt(node: AtomNode, r: Receipt): void;
	/** §4.1 fact 1 — a batch token was minted. */
	batchOpen(t: Token): void;
	/** §3.5 — an action token settled (its retirement follows). */
	batchSettle(t: Token, committed: boolean): void;
	/** §4.1 fact 2 — pass edges (end fires before retirements/commits/fixups). */
	passStart(p: Pass): void;
	passYield(p: Pass): void;
	passResume(p: Pass): void;
	passEnd(p: Pass, kind: 'commit' | 'discard'): void;
	/** §5.5/§5.6 — a computed evaluation in a world opened/closed (paired; end fires on throw too). */
	evalStart(node: ComputedNode, world: World): void;
	evalEnd(): void;
	/** §5.4 — a retired tenant's release was deferred (open render mask names the slot). */
	slotReleaseDeferred(slot: SlotId, token: TokenId): void;
	/** §5.10 — one per mount: how fixup resolved, and how many correctives were scheduled. */
	mountFixup(
		w: Watcher,
		disposition: 'fast-out' | 'fast-out-covered' | 'compare-clean' | 'corrected',
		correctives: number,
	): void;
	/** A compound public operation (write / passEnd / retire / settle / quiesce) finished. */
	opEnd(): void;
};

const SLOT_COUNT = 31; // §2 "token": at most 31 live batches (one per React lane).

// ---- module state + the logged operation table ----------------------------------

/** The bridge whose registered atoms the logged table routes for (one active). */
let activeBridge: CosignalBridge | undefined;
/** True while the bridge itself is applying a logged write to the kernel. */
let bridgeApplying = false;
/** The seam swap happened (module-once; separate from the public once-rule). */
let tableInstalled = false;
/** The public registerReactBridge() has been consumed (spec §3.2: once). */
let publiclyRegistered = false;

// SPK-L routing words — the armed-quiet seam pays one module-int check per
// read and one check + one bit test per write (the SPKHQ kernel-integrated
// floor), instead of closure property loads + a Map probe per op.
/**
 * Read routing mode: 0 = quiet (straight kernel), 1 = an overlay world fold
 * is on stack (registered reads serve the world fold), 2 = a bridge kernel
 * evaluation is on stack (registered reads serve the kernel AND record the
 * K0-acquired dep into K1 — the §5.5 mirror for raw-handle reads inside
 * computed fns, which the bridge readers never see).
 */
let routeReads = 0;
/** Nonzero when logged-mode write classification is armed (mode==='logged' && !bridgeApplying). */
let routeWrites = 0;
/** One bit per kernel record (id is a multiple of 8): 1 = registered atom. */
let regBits = new Int32Array(64);

function setRegistered(kernelId: number): void {
	const idx = kernelId >>> 3;
	const word = idx >>> 5;
	if (word >= regBits.length) {
		const grown = new Int32Array(Math.max(word + 1, regBits.length * 2));
		grown.set(regBits);
		regBits = grown;
	}
	regBits[word]! |= 1 << (idx & 31);
}

/**
 * The logged operation table: the DIRECT table plus (a) classification of
 * public writes to REGISTERED atoms into the ambient default batch (§3.5 —
 * a write belongs to the batch context in which it executes; no fork context
 * exists yet, so ambient is the only classification), and (b) world routing
 * for public reads of registered atoms while an overlay world evaluation is
 * on stack (§5.6's world path; the kernel fast path + taint machinery is
 * TODO(gate:SPK-R)). Unregistered nodes take the DIRECT paths untouched —
 * the LOGGED-quiet promise (§7 twin-build) is one map probe per op.
 *
 * NOTE for the bindings stage: public `Atom.update`/`dispatch` reach this
 * table with the updater already folded (index.ts computes the value under
 * the fold guard), so ambient receipts minted HERE carry `set(value)` ops.
 * Bindings must route update/dispatch through `bridge.write` (op-preserving)
 * for replay fidelity; the bridge surface already takes whole ops.
 */
function makeLoggedFactory(
	direct: (records: number, carry?: Int32Array) => EngineTable,
): (records: number, carry?: Int32Array) => EngineTable {
	return (records: number, carry?: Int32Array): EngineTable => {
		const inner = direct(records, carry);
		const innerRead = inner.read;
		const innerWrite = inner.write;
		return {
			...inner,
			read(s: number): unknown {
				if (routeReads !== 0) {
					const idx = s >>> 3;
					if ((regBits[idx >>> 5]! >>> (idx & 31)) & 1) {
						const b = activeBridge;
						if (b !== undefined && b.activeWorld !== undefined) {
							const la = b.byKernelId.get(s);
							if (la !== undefined) return b.routedRead(la);
						}
					}
				}
				return innerRead(s);
			},
			write(s: number, value: unknown): boolean {
				if (routeWrites !== 0) {
					const idx = s >>> 3;
					if ((regBits[idx >>> 5]! >>> (idx & 31)) & 1) {
						const b = activeBridge;
						if (b !== undefined) {
							const la = b.byKernelId.get(s);
							if (la !== undefined) {
								b.bareWrite(la, { kind: 'set', value });
								return false; // the bridge's own kernel apply already flushed
							}
						}
					}
				}
				return innerWrite(s, value);
			},
		};
	};
}

function armTableOnce(): void {
	if (!tableInstalled) {
		__installTwinTable(makeLoggedFactory);
		tableInstalled = true;
	}
}

/**
 * Activates the LOGGED build (spec §5.1): swaps the operation-table binding
 * at an operation boundary via closure rebuild, exactly once per process, and
 * returns the bridge the (simulated) fork drives. Throws inside any open
 * evaluation/fold frame and on re-registration (§3.2/§3.6).
 */
export function registerReactBridge(): CosignalBridge {
	if (publiclyRegistered) {
		throw new Error('cosignal: registerReactBridge may only be called once (spec §3.2).');
	}
	const bridge = new CosignalBridge();
	bridge.registerBridge(); // arms the seam + flips the bridge to LOGGED
	publiclyRegistered = true;
	return bridge;
}

/**
 * Test-only: a fresh, unregistered bridge instance (the per-schedule "fresh
 * model" analog — the module seam still arms only once per process; kernel
 * records of abandoned bridges are inert). @internal
 */
export function __newBridgeForTest(): CosignalBridge {
	return new CosignalBridge();
}

// ---- the bridge -----------------------------------------------------------------

/**
 * The concurrent-worlds engine. Method-for-method it exposes the surface the
 * (simulated) fork drives — the same surface the oracle model verifies — and
 * every rule cites its spec section. Internal fold/visibility/slot logic is
 * the oracle's normative reading; the kernel integration points are:
 * `AtomNode.handle` (K0 newest storage, eager stepwise apply on every logged
 * write) and the module-level logged table (public-write classification +
 * world read routing).
 */
export class CosignalBridge {
	nodes = new Map<NodeId, AnyNode>();
	tokens = new Map<TokenId, Token>();
	slots: SlotMeta[] = [];
	passes = new Map<PassId, Pass>();
	roots = new Map<RootId, RootState>();
	watchers = new Map<WatcherId, Watcher>();
	reactEffects = new Map<EffectId, ReactEffect>();
	coreEffects = new Map<EffectId, CoreEffect>();
	events: BridgeEvent[] = [];

	/**
	 * R11 — the trace recorder slot (§5.13). `undefined` (the permanent state
	 * unless `cosignal/trace` attaches): every site pays one check, nothing
	 * else. Assigned only by `attachTracer`/`Tracer.stop` over there.
	 */
	trace: TraceHooks | undefined = undefined;

	/** §5.1 — DIRECT until registerBridge(); direct writes leave no receipts. */
	mode: 'direct' | 'logged' = 'direct';
	/** The one global sequence line (§2). */
	seq = 0;
	/** §2 committed-advance counter, in sequence units. */
	cas = 0;
	/** §2 episode/epoch. */
	epoch = 0;

	// ---- §5.5 planes (SPK-N1): the K1 union graph + the touched word ----
	/** K1 out-edge membership per dep node id (dedupe for recordEdge). */
	private outSets: (Set<NodeId> | undefined)[] = [];
	/** K1 out-edge adjacency (iteration order = record order). */
	private outList: (NodeId[] | undefined)[] = [];
	/** Reverse adjacency (mount-fixup dependency closures). */
	private inList: (NodeId[] | undefined)[] = [];
	/** The touched word: bits 0–30 = slots, bit 31 = taint (§5.5). */
	private touched: number[] = [0];
	/** Per-walk visited generation column (§5.9 walk termination). */
	private lastWalk: number[] = [0];
	private walkGen = 0;
	/** Per-slot touched lists (node ids), reset at the keep-the-dirt sweep (§5.4). */
	private slotTouched: NodeId[][] = [];
	/** Nodes by id (dense array twin of `nodes`). */
	private nodesArr: (AnyNode | undefined)[] = [undefined];
	private watchersByNode: (Watcher[] | undefined)[] = [];
	private reactEffectsByNode: (ReactEffect[] | undefined)[] = [];
	private coreEffectsByNode: (CoreEffect[] | undefined)[] = [];
	/** Per-write core-effect queue (§5.11: flush after the walk returns). */
	private effectQueue: CoreEffect[] = [];
	/** Atoms with a non-empty tape (compaction candidates). */
	private dirtyAtoms = new Set<AtomNode>();
	/** The one open (non-ended) pass per root (§4.1 fact 2). */
	private openPassByRoot = new Map<RootId, Pass>();
	private liveTokenCount = 0;
	private parkedCount = 0;
	/** Last-token cache (windowed writes hit one token repeatedly). */
	private lastTokenId = 0;
	private lastTokenRef: Token | undefined = undefined;
	/** Kernel-eval frame taint accumulator (§5.5 taint input), valid while kernelEvalNode ≠ 0. */
	private kernelEvalNode: NodeId = 0;
	private kernelEvalTaint = false;
	/** Retention-invariant archive (tests opt in; unbounded under soak otherwise — SPK-K1). */
	retainArchive = false;
	/** Event-stream base offset (SPK-K1 cursor/ring; 0 unless a capacity drops old events). */
	private eventsBase = 0;
	/** Optional event-stream capacity (SPK-K1): oldest events drop past ~2× this. */
	private eventCapacity: number | undefined = undefined;

	/**
	 * §5.5 diagnostic surface: the K1 union plane as dep → dependents
	 * (materialized from the adjacency columns; graphviz + soak metrics).
	 */
	get episodeEdges(): Map<NodeId, Set<NodeId>> {
		const out = new Map<NodeId, Set<NodeId>>();
		for (let id = 0; id < this.outList.length; id++) {
			const l = this.outList[id];
			if (l !== undefined && l.length > 0) out.set(id, new Set(l));
		}
		return out;
	}

	/** Ambient default batch for bare (context-free) writes (§3.5). */
	ambientToken: TokenId | undefined;

	/** Registered kernel-backed atoms, by kernel record id (logged-table routing). */
	byKernelId = new Map<number, AtomNode>();
	/** The world an overlay evaluation frame is folding in (logged-table read routing). */
	activeWorld: World | undefined;

	private nextNode = 1;
	private nextToken = 1;
	private nextPass = 1;
	private nextWatcher = 1;
	private nextEffect = 1;

	/** Purity frames (§3.1/§3.6): >0 while a world evaluation is on stack. */
	private evalDepth = 0;
	/** True inside an updater/reducer/equals callback (reads+writes throw). */
	inFoldCallback = false;

	constructor() {
		for (let i = 0; i < SLOT_COUNT; i++) {
			this.slots.push({
				id: i,
				tenant: undefined,
				claimSeq: 0,
				writeClock: 0,
				carriedMaxRetiredSeq: 0,
				releasePending: false,
			});
			this.slotTouched.push([]);
		}
	}

	/** Central activeWorld setter — keeps the module routing word in sync (SPK-L). */
	private setWorld(w: World | undefined): void {
		this.activeWorld = w;
		if (activeBridge === this) routeReads = w === undefined ? 0 : 1;
	}

	private log(e: BridgeEvent): void {
		this.events.push(e);
		const cap = this.eventCapacity;
		if (cap !== undefined && this.events.length >= cap * 2) {
			const drop = this.events.length - cap;
			this.events.splice(0, drop);
			this.eventsBase += drop;
		}
		const tr = this.trace;
		if (tr !== undefined) tr.event(e);
	}

	private mintSeq(): number {
		return ++this.seq;
	}

	// ---- SPK-K1 event-stream cursor/ring ----

	/** Absolute cursor into the event stream (stable across ring drops). */
	eventCursor(): number {
		return this.eventsBase + this.events.length;
	}

	/**
	 * Bound the retained event stream (§5.12 growth honesty): once set, the
	 * oldest events drop in amortized batches past ~2× the capacity and
	 * `eventCursor()`/`eventsSince()` marks stay stable. Unset by default —
	 * tests and diagnostics see the full per-episode stream.
	 */
	setEventCapacity(cap: number | undefined): void {
		this.eventCapacity = cap;
	}

	// ---------------------------------------------------------------- setup

	/** §3.2/§5.1 — activates LOGGED mode, once, monotonically; arms the table seam. */
	registerBridge(): void {
		if (this.evalDepth > 0 || this.inFoldCallback) {
			throw new BridgeScheduleError('registerReactBridge inside an open evaluation/fold frame (§3.6)');
		}
		if (this.mode === 'logged') throw new BridgeScheduleError('bridge already registered (§3.2: once)');
		armTableOnce(); // asserts enterDepth === 0 and rebuilds E over the carried buffers
		this.mode = 'logged';
		activeBridge = this;
		routeWrites = 1;
		routeReads = this.activeWorld === undefined ? 0 : 1;
	}

	/** Registers a node id in the dense side columns. */
	private indexNode(node: AnyNode): void {
		const id = node.id;
		this.nodes.set(id, node);
		this.nodesArr[id] = node;
		this.touched[id] = 0;
		this.lastWalk[id] = 0;
		this.evalMark[id] = 0;
	}

	atom(name: string, initial: Value, equals?: Equals): AtomNode {
		const eq = equals ?? Object.is;
		const handle = new Atom<Value>(initial, equals === undefined ? undefined : { isEqual: equals });
		const node = new AtomNode(this.nextNode++, name, initial, eq, equals === undefined, handle);
		this.indexNode(node);
		this.byKernelId.set(handle._id, node);
		setRegistered(handle._id);
		return node;
	}

	/**
	 * §5.1 activation rule 2 — an existing kernel atom joins the bridge with
	 * its DIRECT-era value as committed-only base state (no receipts existed).
	 */
	adoptAtom(name: string, handle: Atom<Value>, equals?: Equals): AtomNode {
		const current = this.kernelValueOf(handle);
		const node = new AtomNode(this.nextNode++, name, current, equals ?? Object.is, equals === undefined, handle);
		this.indexNode(node);
		this.byKernelId.set(handle._id, node);
		setRegistered(handle._id);
		return node;
	}

	/** §3.1 reducerAtom — the reducer is fixed at creation (§5.13). */
	reducerAtom(name: string, reducer: Reducer, initial: Value): AtomNode {
		const node = this.atom(name, initial);
		node.reducer = reducer;
		return node;
	}

	computed(name: string, fn: ComputedFn): ComputedNode {
		const node: ComputedNode = { kind: 'computed', id: this.nextNode++, name, fn };
		this.indexNode(node);
		return node;
	}

	root(id: RootId): RootState {
		let r = this.roots.get(id);
		if (r === undefined) {
			r = { id, committedTokens: new Set(), commitGen: 0, committedBits: 0, committedDirtySlots: 0, memos: new Map() };
			this.roots.set(id, r);
		}
		return r;
	}

	// ---------------------------------------------------- worlds and folds

	/** §5.3 — the pass's included set = mask ∪ capturedCommitted. */
	includedSet(pass: Pass): Set<SlotId> {
		return new Set([...pass.maskSlots, ...pass.capturedCommittedSlots]);
	}

	/** The root's CURRENT committed-slot set (live committed tokens' slots, §5.3). */
	committedSlotsNow(rootId: RootId): Set<SlotId> {
		const out = new Set<SlotId>();
		for (const t of this.root(rootId).committedTokens) {
			const tok = this.tokens.get(t);
			if (tok !== undefined && tok.slot !== undefined) out.add(tok.slot);
		}
		return out;
	}

	/**
	 * The visibility rule: §5.3's two clauses for pass worlds; retired-at-now
	 * ∨ membership for committed-for-root; everything for newest (K0 applies
	 * writes eagerly, §5.2); §5.10's three clauses for the fixup world w_fx.
	 */
	visible(e: Receipt, world: World): boolean {
		switch (world.kind) {
			case 'newest':
				return true;
			case 'pass': {
				const w = world.pass;
				if (e.retiredSeq !== undefined && e.retiredSeq <= w.pin) return true; // clause 1: retired by my pin
				return this.includedSet(w).has(e.slot) && e.seq <= w.pin; // clause 2: included, up to my pin
			}
			case 'committed': {
				if (e.retiredSeq !== undefined) return true; // committed truth at now
				return this.committedSlotsNow(world.root).has(e.slot); // membership
			}
			case 'mountFix': {
				if (world.maskSlots.has(e.slot) && e.seq <= world.pin) return true; // the render's own inclusions, at its pin
				if (world.excludeLiveTokens?.has(e.token)) return false; // corrective-covered live divergence (errata 2 audit)
				if (e.retiredSeq !== undefined) return true; // committed truth at NOW
				return this.committedSlotsNow(world.root).has(e.slot); // the root's CURRENT committed set
			}
		}
	}

	/** Runs an updater/reducer/equals under the fold-purity guard (§3.1). */
	private inCallback<T>(fn: () => T): T {
		const prev = this.inFoldCallback;
		this.inFoldCallback = true;
		try {
			return fn();
		} finally {
			this.inFoldCallback = prev;
		}
	}

	private applyOp(atom: AtomNode, op: Op, prev: Value): Value {
		switch (op.kind) {
			case 'set':
				return op.value;
			case 'update':
				return this.inCallback(() => op.fn(prev));
			case 'dispatch': {
				const reducer = atom.reducer;
				if (reducer === undefined) throw new BridgeScheduleError(`dispatch on non-reducer atom ${atom.name}`);
				return this.inCallback(() => reducer(prev, op.action));
			}
		}
	}

	/**
	 * §5.3 fold — replay visible entries over base in sequence order with
	 * stepwise equality (an equal step keeps the old reference). Runs over
	 * the packed columns (SPK-W); computes the §5.7 fingerprint
	 * fp = max(newest visible entry seq, baseSeq, retirementStamp) into
	 * `lastFoldFp` during the same scan.
	 */
	lastFoldFp = 0;

	foldAtom(atom: AtomNode, world: World): Value {
		const tp = atom.tp;
		const n = tp.n;
		let value = atom.base;
		let fp = atom.baseSeq > atom.retirementStamp ? atom.baseSeq : atom.retirementStamp;
		const seqs = tp.seqs;
		const retired = tp.retired;
		const slots = tp.slots;
		for (let i = tp.start; i < n; i++) {
			if (!this.visibleAt(atom, i, world, seqs, retired, slots)) continue;
			const s = seqs[i]!;
			if (s > fp) fp = s;
			const next = this.applyOpPacked(atom, tp.kinds[i]!, tp.payloads[i], value);
			if (atom.eqIsDefault) {
				if (!Object.is(next, value)) value = next;
			} else if (!this.inCallback(() => atom.equals(next, value))) {
				value = next;
			}
		}
		this.lastFoldFp = fp;
		return value;
	}

	/** The packed visibility predicate (§5.3 clauses; §5.10 w_fx clauses). */
	private visibleAt(atom: AtomNode, i: number, world: World, seqs: number[], retired: number[], slots: number[]): boolean {
		switch (world.kind) {
			case 'newest':
				return true;
			case 'pass': {
				const w = world.pass;
				const r = retired[i]!;
				if (r !== 0 && r <= w.pin) return true; // clause 1: retired by my pin
				return ((w.includedBits >>> slots[i]!) & 1) === 1 && seqs[i]! <= w.pin; // clause 2
			}
			case 'committed': {
				if (retired[i]! !== 0) return true; // committed truth at now
				// Membership consult materializes the root record (model parity:
				// the naive committedSlotsNow() creates it on first consult).
				return ((this.root(world.root).committedBits >>> slots[i]!) & 1) === 1;
			}
			case 'mountFix': {
				if (world.maskBits !== undefined) {
					if (((world.maskBits >>> slots[i]!) & 1) === 1 && seqs[i]! <= world.pin) return true;
				} else if (world.maskSlots.has(slots[i]!) && seqs[i]! <= world.pin) return true;
				if (world.excludeLiveTokens?.has(atom.tp.tokens[i]!)) return false; // corrective-covered (errata 2 audit)
				if (retired[i]! !== 0) return true; // committed truth at NOW
				return ((this.root(world.root).committedBits >>> slots[i]!) & 1) === 1;
			}
		}
	}

	/** §5.7 fingerprint-only scan (memo revalidation without replaying ops). */
	private scanFp(atom: AtomNode, world: World): number {
		const tp = atom.tp;
		const n = tp.n;
		let fp = atom.baseSeq > atom.retirementStamp ? atom.baseSeq : atom.retirementStamp;
		const seqs = tp.seqs;
		const retired = tp.retired;
		const slots = tp.slots;
		for (let i = tp.start; i < n; i++) {
			if (!this.visibleAt(atom, i, world, seqs, retired, slots)) continue;
			const s = seqs[i]!;
			if (s > fp) fp = s;
		}
		return fp;
	}

	private applyOpPacked(atom: AtomNode, kind: number, payload: unknown, prev: Value): Value {
		if (kind === OP_SET) return payload;
		if (kind === OP_UPDATE) return this.inCallback(() => (payload as (p: Value) => Value)(prev));
		const reducer = atom.reducer;
		if (reducer === undefined) throw new BridgeScheduleError(`dispatch on non-reducer atom ${atom.name}`);
		return this.inCallback(() => reducer(prev, payload));
	}

	/** Retention-invariant helper: the same fold over the FULL history from origin. */
	shadowFoldAtom(atom: AtomNode, world: World): Value {
		let value = atom.origin;
		for (const e of [...atom.archiveStore, ...atom.tp.materialize()]) {
			if (e.retiredSeq === undefined && !this.visible(e, world)) continue;
			if (!this.visible(e, world)) continue;
			const next = this.applyOp(atom, e.op, value);
			if (!this.inCallback(() => atom.equals(next, value))) value = next;
		}
		return value;
	}

	/** The kernel plane read for an atom's newest value (§5.2), hook-proof. */
	private kernelValueOf(handle: Atom<Value>): Value {
		const saved = this.activeWorld;
		this.setWorld(undefined); // never let the world router intercept a kernel-plane read
		try {
			return handle.state;
		} finally {
			this.setWorld(saved);
		}
	}

	/**
	 * §5.6 newest-world evaluation plane. The newest world's computed values
	 * live in their own memo plane validated by the same §5.7 ladder
	 * (fingerprints ground at K0 atom state: fp(a, newest) is O(1) — the last
	 * tape sequence / base sequence / retirement stamp). This IS the "kernel
	 * cache + CT(n)" of §5.6 for overlay computeds: real kernel Computed
	 * records are NOT used because stale cross-evaluation links from
	 * dep-flipping fns form K0 link cycles the frozen kernel's
	 * unwatched-dispose walk cannot traverse (measured hang; the overlay's
	 * union plane is cycle-guarded, the kernel plane must stay acyclic).
	 */
	private newestMemos = new Map<NodeId, WorldMemo>();

	/** Newest-eval taint accumulator (§5.5 taint input), per computed frame. */
	private newestFrameTaint = false;


	// ---- §5.7 memo frames: direct deps of the world evaluation in progress ----
	private frame: WorldMemo | undefined = undefined;
	/** The node id whose evaluation frame is open (raw-handle reads record to it). */
	private currentSink: NodeId = 0;

	private memoPlaneOf(world: World): Map<NodeId, WorldMemo> | undefined {
		if (world.kind === 'newest') return this.newestMemos;
		if (world.kind === 'pass') return world.pass.memos;
		// Never CREATE the root record here — the model materializes roots only
		// at passStart/mountReactEffect, and the observable snapshot iterates
		// them. An unmaterialized root folds plain (empty committed set).
		if (world.kind === 'committed') return this.roots.get(world.root)?.memos;
		return undefined; // mountFix worlds are one-shot
	}

	/** §5.7 ladder step 2 for pass worlds: every included slot's clock ≤ memo.seq. */
	private passClocksQuiet(pass: Pass, memoSeq: number): boolean {
		let bits = pass.includedBits;
		while (bits !== 0) {
			const s = 31 - Math.clz32(bits & -bits);
			if (this.slots[s]!.writeClock > memoSeq) return false;
			bits &= bits - 1;
		}
		return true;
	}

	/** Step 2 for committed worlds: cas quiet AND member-slot clocks quiet. */
	private committedClocksQuiet(root: RootState, memoSeq: number): boolean {
		if (this.cas > memoSeq) return false;
		let bits = root.committedBits;
		while (bits !== 0) {
			const s = 31 - Math.clz32(bits & -bits);
			if (this.slots[s]!.writeClock > memoSeq) return false;
			bits &= bits - 1;
		}
		return true;
	}

	/**
	 * §5.7 — validate a memo through the ladder (steps 2–3). Returns true if
	 * the memo may serve (re-stamped when step 3 carried it).
	 */
	private validateMemo(m: WorldMemo, world: World, stack: Set<NodeId> | undefined): boolean {
		if (m.epoch !== this.epoch) return false;
		if (m.checkedOp === this.seq) return true; // nothing minted since last validation ⇒ nothing changed
		if (m.validating) return false; // stale dep lists can cross-link; refuse instead of recursing
		m.validating = true;
		try {
			if (!this.validateMemoInner(m, world, stack)) return false;
		} finally {
			m.validating = false;
		}
		m.checkedOp = this.seq;
		return true;
	}

	private validateMemoInner(m: WorldMemo, world: World, stack: Set<NodeId> | undefined): boolean {
		let quiet = false;
		if (world.kind === 'pass') {
			quiet = this.passClocksQuiet(world.pass, m.seq);
		} else if (world.kind === 'committed') {
			// The root commit generation RE-KEYS committed memos (§5.7 change-
			// source table): a gen mismatch is a dead worldKey — evict, never
			// fp-rescue (a per-root commit is a visibility flip BELOW the
			// visible max: fingerprints cannot see it).
			const root = this.roots.get(world.root);
			if (root === undefined || m.gen !== root.commitGen) return false;
			quiet = this.committedClocksQuiet(root, m.seq);
		}
		if (!quiet) {
			// step 3: fingerprint recheck per recorded atom dep; computed deps
			// revalidate recursively by value identity (grounds at atoms).
			for (let i = 0; i < m.atoms.length; i++) {
				if (this.fpOf(m.atoms[i]!, world) !== m.fps[i]!) return false;
			}
			for (let i = 0; i < m.comps.length; i++) {
				if (!Object.is(this.evaluate(m.comps[i]!, world, stack), m.compValues[i])) return false;
			}
			m.seq = this.seq; // re-stamp
		}
		return true;
	}

	/** fp(a, w) = max(newest w-visible entry seq, baseSeq, retirementStamp) (§5.7). */
	private fpOf(atom: AtomNode, world: World): number {
		if (world.kind === 'newest') {
			// Every entry is newest-visible: O(1) off the packed tail.
			const tp = atom.tp;
			const last = tp.n === tp.start ? 0 : tp.seqs[tp.n - 1]!;
			const floor = atom.baseSeq > atom.retirementStamp ? atom.baseSeq : atom.retirementStamp;
			return last > floor ? last : floor;
		}
		return this.scanFp(atom, world);
	}

	/**
	 * §5.5 raw-handle reads: a registered atom read reached the operation
	 * table while an overlay evaluation frame was open. Record the edge to
	 * the open frame's sink (the K0-mirror for topology the bridge readers
	 * never see) and serve the world value.
	 * @internal (called from the logged table wrapper)
	 */
	routedRead(atom: AtomNode): Value {
		const sink = this.currentSink;
		if (sink !== 0) this.recordEdge(atom.id, sink);
		return this.atomValue(atom, this.activeWorld!);
	}

	/** Atom value in a world: kernel for newest, memoized fold otherwise (§5.3). */
	private atomValue(atom: AtomNode, world: World): Value {
		if (world.kind === 'newest') {
			// K0 holds the newest fold by the eager-apply invariant (§5.2).
			const v = this.kernelValueOf(atom.handle);
			this.captureAtomDep(atom, this.fpOf(atom, world));
			return v;
		}
		const plane = this.memoPlaneOf(world);
		if (plane === undefined) {
			const v = this.foldAtom(atom, world);
			this.captureAtomDep(atom, this.lastFoldFp);
			return v;
		}
		let m = plane.get(atom.id);
		if (m !== undefined && this.validateMemo(m, world, undefined)) {
			this.captureAtomDep(atom, m.fps[0]!);
			return m.value;
		}
		const v = this.foldAtom(atom, world);
		const fp = this.lastFoldFp;
		if (m === undefined) {
			m = {
				value: v, seq: this.seq, gen: 0, epoch: this.epoch, checkedOp: this.seq, validating: false,
				atoms: [atom], fps: [fp], comps: [], compValues: [],
			};
			plane.set(atom.id, m);
		} else {
			m.value = v;
			m.seq = this.seq;
			m.epoch = this.epoch;
			m.checkedOp = this.seq;
			m.fps[0] = fp;
		}
		if (world.kind === 'committed') m.gen = this.roots.get(world.root)?.commitGen ?? 0;
		this.captureAtomDep(atom, fp);
		return v;
	}

	private captureAtomDep(atom: AtomNode, fp: number): void {
		const f = this.frame;
		if (f !== undefined) {
			f.atoms.push(atom);
			f.fps.push(fp);
		}
	}

	private captureCompDep(node: ComputedNode, value: Value): void {
		const f = this.frame;
		if (f !== undefined) {
			f.comps.push(node);
			f.compValues.push(value);
		}
	}

	/**
	 * Evaluation of a node in a world (§5.6 routing). Newest-world atoms read
	 * straight off the kernel plane; newest-world computeds serve from the
	 * newest memo plane (the overlay's K0 cache — "straight kernel pull,
	 * donor semantics: recompute if stale"). Other worlds first try the fast
	 * path (touched(n) == 0 ∧ CT(n): the newest cache is committed-only and
	 * validates — serve it with zero fold), then the §5.7 memo ladder, then a
	 * fresh world evaluation recording real K1 edges. Untracked reads fold
	 * in-world, edge-free (§5.5). Reads inside fold callbacks throw;
	 * per-world cycles throw (§3.6).
	 */
	evaluate(node: AnyNode, world: World, stack?: Set<NodeId>): Value {
		if (this.inFoldCallback) throw new BridgeScheduleError('signal read inside an updater/reducer fold (§3.1)');
		if (node.kind === 'atom') return this.atomValue(node, world);
		const plane = this.memoPlaneOf(world);
		if (world.kind !== 'newest' && world.kind !== 'mountFix') {
			// §5.6 fast path: no slot bits, no taint, valid newest cache.
			const word = this.touched[node.id]!;
			if (word === 0) {
				const nm = this.newestMemos.get(node.id);
				if (nm !== undefined && this.validateMemo(nm, NEWEST, stack)) {
					this.captureCompDep(node, nm.value);
					return nm.value;
				}
			}
		}
		// World path: §5.7 memo ladder.
		if (plane !== undefined) {
			const m = plane.get(node.id);
			if (m !== undefined && this.validateMemo(m, world, stack)) {
				this.captureCompDep(node, m.value);
				return m.value;
			}
		}
		// Per-world cycle detection via the mark column (§3.6): marks carry the
		// current top-level evaluation generation; `stack` remains accepted for
		// surface compat but the column is authoritative.
		const marks = this.evalMark;
		if (marks[node.id] === this.evalGen && this.evalDepth > 0) {
			throw new BridgeScheduleError(`cyclic evaluation of ${node.name} within one world (§3.6)`);
		}
		if (this.evalDepth === 0) this.evalGen++;
		marks[node.id] = this.evalGen;
		this.evalDepth++;
		const savedWorld = this.activeWorld;
		this.setWorld(world);
		const savedSlice = this.renderSlicePass;
		if (world.kind === 'pass') this.renderSlicePass = world.pass; // §5.9 edge-add queueing context
		const savedFrame = this.frame;
		const savedSink = this.currentSink;
		const savedTaint = this.newestFrameTaint;
		this.currentSink = node.id;
		if (world.kind === 'newest') this.newestFrameTaint = false;
		let myFrame: WorldMemo | undefined;
		if (plane !== undefined) {
			myFrame = {
				value: undefined, seq: this.seq, gen: 0, epoch: this.epoch, checkedOp: this.seq, validating: false,
				atoms: [], fps: [], comps: [], compValues: [],
			};
		}
		this.frame = myFrame;
		const tr = this.trace; // R11: paired eval hooks; end fires on throw too
		if (tr !== undefined) tr.evalStart(node, world);
		try {
			const value = node.fn(this.trackedReader, this.untrackedReader);
			if (world.kind === 'newest') {
				// §5.5 taint epilogue: derive bit 31 fresh from this evaluation.
				const word = this.touched[node.id]!;
				if (this.newestFrameTaint) {
					if ((word & TAINT) === 0) this.propagateTaint(node.id);
				} else if ((word & TAINT) !== 0) {
					this.touched[node.id] = word & SLOT_MASK; // own-epilogue clear (§5.5)
				}
			}
			if (myFrame !== undefined) {
				myFrame.value = value;
				myFrame.seq = this.seq;
				if (world.kind === 'committed') myFrame.gen = this.roots.get(world.root)?.commitGen ?? 0;
				plane!.set(node.id, myFrame);
			}
			// The frame captured MY deps; my caller captures me as a computed dep.
			this.frame = savedFrame;
			this.captureCompDep(node, value);
			return value;
		} finally {
			this.frame = savedFrame;
			this.currentSink = savedSink;
			this.newestFrameTaint = savedTaint;
			this.renderSlicePass = savedSlice;
			this.setWorld(savedWorld);
			this.evalDepth--;
			marks[node.id] = 0;
			if (tr !== undefined) tr.evalEnd();
		}
	}

	/** Mark column + generation for per-world cycle detection (no Set allocs). */
	private evalMark: number[] = [0];
	private evalGen = 0;

	/** The persistent tracked reader (§5.5): edges to the open sink; world from the frame. */
	private trackedReader: Reader = (dep) => {
		const sink = this.currentSink;
		this.recordEdge(dep.id, sink);
		if ((this.touched[dep.id]! & TAINT) !== 0) this.newestFrameTaint = true; // §5.5(b): taint on a recorded dep
		return this.evaluate(dep, this.activeWorld!);
	};

	/**
	 * The persistent untracked reader: EDGE-free, not INPUT-free — the dep
	 * still enters the open memo frame's fingerprint set (validation must
	 * observe untracked movement or committed folds would serve stale values
	 * the naive model computes fresh). No edge is recorded (currentSink
	 * drops), so no notification will ever fire through it (§5.5); the WEAK
	 * edge feeds durable-drain candidate collection only (§5.11).
	 */
	private untrackedReader: Reader = (dep) => {
		const sink = this.currentSink;
		this.recordWeakEdge(dep.id, sink);
		const world = this.activeWorld!;
		// §5.5 taint input (a): untracked read hit pending state (newest evals).
		if (world.kind === 'newest') {
			if (dep.kind === 'atom') {
				if (dep.tp.n > dep.tp.start || (this.touched[dep.id]! & TAINT) !== 0) this.newestFrameTaint = true;
			} else if (this.touched[dep.id]! !== 0) {
				this.newestFrameTaint = true;
			}
		}
		this.currentSink = 0;
		try {
			return this.evaluate(dep, world);
		} finally {
			this.currentSink = sink;
		}
	};

	// ---- §5.5 the union plane + walks (SPK-N1) ----

	private recordEdge(dep: NodeId, dependent: NodeId): void {
		let s = this.outSets[dep];
		if (s !== undefined && s.has(dependent)) return;
		if (s === undefined) {
			s = new Set();
			this.outSets[dep] = s;
			this.outList[dep] = [];
		}
		s.add(dependent);
		this.outList[dep]!.push(dependent);
		let ins = this.inList[dependent];
		if (ins === undefined) {
			ins = [];
			this.inList[dependent] = ins;
		}
		ins.push(dep);
		if (++this.edgeCount - this.lastSweepEdges >= 256) this.sweepK1();
		// §5.5 edge-add propagation: the new edge inherits the source's bits...
		const src = this.touched[dep]!;
		const newBits = src & SLOT_MASK & ~this.touched[dependent]!;
		if (newBits !== 0) this.propagateBits(dependent, newBits);
		if ((src & TAINT) !== 0 && (this.touched[dependent]! & TAINT) === 0) this.propagateTaint(dependent);
		// §5.9's edge-add retroactive delivery REPLAY (runInBatch per still-live
		// slot through the new path) is deliberately NOT implemented in this
		// pass: the oracle referee delivers only at writes, so replay events
		// exceed the documented "⊆ union-conservative" tolerance and cannot be
		// validated. The bit propagation above preserves all routing/drain
		// correctness (fast-path refusal, touched-list coverage); the replay's
		// only lost effect is catch-up lane scheduling, which the real fork
		// wiring must revisit (flagged in the P1 report).
	}

	/** The pass whose render slice is evaluating (survives nested newest pulls). */
	private renderSlicePass: Pass | undefined = undefined;

	private edgeCount = 0;
	private lastSweepEdges = 0;

	/**
	 * §5.12 K1 growth honesty — the bounded mid-episode sweep (the
	 * pre-registered SPK-K1 remedy: sampled reachability). Collects only the
	 * provably-safe subset: an edge dep→t drops iff t cannot reach any node
	 * holding a committed watcher / effect-dep snapshot / core-effect
	 * subscription (reverse reachability over K1) AND t carries no retained
	 * touched bits for LIVE slots and no taint. Dirt on the WORDS persists
	 * (keep-the-dirt, §5.4) — only the stranded routing records go. Runs
	 * every 256 recorded edges (amortized O(V+E)).
	 */
	private sweepK1(): void {
		this.lastSweepEdges = this.edgeCount;
		const gen = ++this.walkGen;
		const lastWalk = this.lastWalk;
		const stack = this.walkStack;
		let sp = 0;
		for (let id = 0; id < this.nodesArr.length; id++) {
			const ws = this.watchersByNode[id];
			const re = this.reactEffectsByNode[id];
			const ce = this.coreEffectsByNode[id];
			if ((ws !== undefined && ws.length > 0) || (re !== undefined && re.length > 0) || (ce !== undefined && ce.length > 0)) {
				if (lastWalk[id] !== gen) {
					lastWalk[id] = gen;
					stack[sp++] = id;
				}
			}
		}
		while (sp > 0) {
			const cur = stack[--sp]!;
			const ins = this.inList[cur];
			if (ins === undefined) continue;
			for (let i = 0; i < ins.length; i++) {
				const dep = ins[i]!;
				if (lastWalk[dep] !== gen) {
					lastWalk[dep] = gen;
					stack[sp++] = dep;
				}
			}
		}
		let liveBits = 0;
		for (const slot of this.slots) {
			if (slot.tenant !== undefined) {
				const t = this.tokens.get(slot.tenant);
				if (t !== undefined && t.state === 'live') liveBits |= 1 << slot.id;
			}
		}
		const keepMask = liveBits | TAINT;
		let kept = 0;
		for (let dep = 0; dep < this.outList.length; dep++) {
			const outs = this.outList[dep];
			if (outs === undefined) continue;
			let w = 0;
			for (let i = 0; i < outs.length; i++) {
				const t = outs[i]!;
				if (lastWalk[t] === gen || (this.touched[t]! & keepMask) !== 0) {
					outs[w++] = t;
				} else {
					this.outSets[dep]!.delete(t);
					const ins = this.inList[t];
					if (ins !== undefined) {
						const j = ins.indexOf(dep);
						if (j >= 0) ins.splice(j, 1);
					}
				}
			}
			if (w !== outs.length) outs.length = w;
			kept += w;
		}
		this.edgeCount = kept;
		this.lastSweepEdges = kept;
	}

	// §5.5/§5.11 — the WEAK plane: untracked reads record drain-only edges.
	// Never traversed by marking or delivery walks ("no notification will
	// ever fire" for untracked paths); durable drains expand over them so a
	// committed-truth flip reaching a node only through untracked reads still
	// reconcile-checks its observers (value-gated — the naive model's
	// full-observer scan behavior, scoped).
	private weakOutSets: (Set<NodeId> | undefined)[] = [];
	private weakOutList: (NodeId[] | undefined)[] = [];

	private recordWeakEdge(dep: NodeId, dependent: NodeId): void {
		let s = this.weakOutSets[dep];
		if (s !== undefined && s.has(dependent)) return;
		if (s === undefined) {
			s = new Set();
			this.weakOutSets[dep] = s;
			this.weakOutList[dep] = [];
		}
		s.add(dependent);
		this.weakOutList[dep]!.push(dependent);
	}

	/** Monotone marking frontier: `newBits & ~touched(n)`, self-terminating (§5.5). */
	private markStackN: number[] = [];
	private markStackB: number[] = [];

	private propagateBits(start: NodeId, startBits: number): void {
		const stackN = this.markStackN;
		const stackB = this.markStackB;
		let sp = 0;
		this.applyBits(start, startBits);
		stackN[sp] = start;
		stackB[sp++] = startBits;
		while (sp > 0) {
			const bitsIn = stackB[--sp]!;
			const outs = this.outList[stackN[sp]!];
			if (outs === undefined) continue;
			for (let i = 0; i < outs.length; i++) {
				const n = outs[i]!;
				const nb = bitsIn & ~this.touched[n]!;
				if (nb !== 0) {
					this.applyBits(n, nb);
					stackN[sp] = n;
					stackB[sp++] = nb;
				}
			}
		}
	}

	/** Set bits on a node and append it to each newly-set slot's touched list. */
	private applyBits(node: NodeId, bits: number): void {
		this.touched[node] = this.touched[node]! | bits;
		let b = bits;
		while (b !== 0) {
			const s = 31 - Math.clz32(b & -b);
			this.slotTouched[s]!.push(node);
			b &= b - 1;
		}
	}

	/** §5.5 taint 0→1 propagation over existing out-edges. */
	private propagateTaint(start: NodeId): void {
		const stack = this.markStackN;
		let sp = 0;
		this.touched[start] = this.touched[start]! | TAINT;
		stack[sp++] = start;
		while (sp > 0) {
			const outs = this.outList[stack[--sp]!];
			if (outs === undefined) continue;
			for (let i = 0; i < outs.length; i++) {
				const n = outs[i]!;
				if ((this.touched[n]! & TAINT) === 0) {
					this.touched[n] = this.touched[n]! | TAINT;
					stack[sp++] = n;
				}
			}
		}
	}

	/** Reused delivery-walk buffers (§5.9 walk atomicity: never re-entrant). */
	private walkStack: number[] = [];
	private walkWatchers: Watcher[] = [];

	/**
	 * §5.9 value-blind delivery walk over K0∪K1 with the per-walk visited
	 * generation. Collects reached watchers (delivered in id order — the
	 * naive model's map order) and enqueues reached core effects.
	 */
	private deliveryWalk(from: NodeId, token: Token, slot: SlotMeta, seq: number): void {
		const gen = ++this.walkGen;
		const lastWalk = this.lastWalk;
		const stack = this.walkStack;
		const found = this.walkWatchers;
		found.length = 0;
		let sp = 0;
		stack[sp++] = from;
		lastWalk[from] = gen;
		while (sp > 0) {
			const cur = stack[--sp]!;
			const ws = this.watchersByNode[cur];
			if (ws !== undefined) {
				for (let i = 0; i < ws.length; i++) {
					const w = ws[i]!;
					if (w.live) found.push(w);
				}
			}
			const ces = this.coreEffectsByNode[cur];
			if (ces !== undefined) {
				for (let i = 0; i < ces.length; i++) {
					const e = ces[i]!;
					if (e.queuedWalk !== gen) {
						e.queuedWalk = gen;
						this.effectQueue.push(e);
					}
				}
			}
			const outs = this.outList[cur];
			if (outs !== undefined) {
				for (let i = 0; i < outs.length; i++) {
					const n = outs[i]!;
					if (lastWalk[n] !== gen) {
						lastWalk[n] = gen;
						stack[sp++] = n;
					}
				}
			}
		}
		if (found.length > 1) found.sort((a, b) => a.id - b.id);
		for (let i = 0; i < found.length; i++) this.deliver(found[i]!, token, slot, seq);
		found.length = 0;
	}

	/** Nodes reachable from `from` over the union graph (including `from`). */
	reachableFrom(from: NodeId): Set<NodeId> {
		const reached = new Set<NodeId>([from]);
		const queue = [from];
		while (queue.length > 0) {
			const cur = queue.pop()!;
			const outs = this.outList[cur];
			if (outs === undefined) continue;
			for (const next of outs) {
				if (!reached.has(next)) {
					reached.add(next);
					queue.push(next);
				}
			}
		}
		return reached;
	}

	// -------------------------------------------------- batches and slots

	liveTokens(): Token[] {
		return [...this.tokens.values()].filter((t) => t.state === 'live');
	}

	livePins(): number[] {
		const pins: number[] = [];
		for (const p of this.openPassByRoot.values()) pins.push(p.pin);
		return pins;
	}

	private minLivePin(): number {
		let min = Number.POSITIVE_INFINITY;
		for (const p of this.openPassByRoot.values()) if (p.pin < min) min = p.pin;
		return min;
	}

	/** §4.1 fact 1 — mint a batch token. At most 31 live (one per React lane). */
	openBatch(priority: Priority, opts?: { action?: boolean; ambient?: boolean }): Token {
		if (this.mode !== 'logged') throw new BridgeScheduleError('batches exist only in LOGGED mode (§5.1)');
		if (this.liveTokenCount >= SLOT_COUNT) {
			throw new BridgeScheduleError('at most 31 live tokens (§4.1 fact 1 invariant)');
		}
		const parked = opts?.action ?? false;
		const token: Token = {
			id: this.nextToken++, priority,
			action: opts?.action ?? false,
			parked, // §4.1 fact 3: action tokens park until settlement
			state: 'live', committedFlag: undefined, slot: undefined,
			retiredSeq: undefined, lastWriteSeq: 0, atomsTouched: [], liveReceipts: 0,
			ambient: opts?.ambient ?? false,
		};
		this.tokens.set(token.id, token);
		this.liveTokenCount++;
		if (parked) this.parkedCount++;
		const tr = this.trace;
		if (tr !== undefined) tr.batchOpen(token);
		return token;
	}

	private token(id: TokenId): Token {
		const t = this.tokens.get(id);
		if (t === undefined) throw new BridgeScheduleError(`unknown token ${id}`);
		return t;
	}

	nodeById(id: NodeId): AnyNode {
		const n = this.nodes.get(id);
		if (n === undefined) throw new BridgeScheduleError(`unknown node ${id}`);
		return n;
	}

	/**
	 * §5.3 write step 1 — intern the token's slot, claiming a free one if new.
	 * Claim housekeeping (§5.4): write clock zeroes; per-(watcher, slot) dedup
	 * bits clear (§5.9); the keep-the-dirt sweep clears bit s via the touched
	 * list only when no excluding pin remains (min live pins ≥ the slot's
	 * carried max retirement sequence).
	 */
	private internSlot(token: Token): SlotMeta {
		if (token.slot !== undefined) return this.slots[token.slot]!;
		let free = this.slots.find((s) => s.tenant === undefined);
		if (free === undefined) {
			// §5.4 backstop: release the oldest mask-retained retired slot anyway, loudly.
			const candidates = this.slots.filter((s) => s.releasePending);
			if (candidates.length === 0) {
				throw new BridgeScheduleError('slot table full of live tenants — unreachable under the 31-live-token guard');
			}
			candidates.sort((a, b) => {
				const ra = this.token(a.tenant!).retiredSeq ?? 0;
				const rb = this.token(b.tenant!).retiredSeq ?? 0;
				return ra - rb;
			});
			const victim = candidates[0]!;
			this.log({ type: 'slot-backstop-released', slot: victim.id, token: victim.tenant! });
			this.releaseSlot(victim);
			free = victim;
		}
		// §5.4 disposal at re-intern: if no excluding pin remains, sweep bit s
		// via the touched list and reset it; otherwise inherit the dirt.
		if (this.minLivePin() >= free.carriedMaxRetiredSeq) {
			const list = this.slotTouched[free.id]!;
			const clear = ~(1 << free.id);
			for (let i = 0; i < list.length; i++) this.touched[list[i]!] = this.touched[list[i]!]! & clear;
			list.length = 0;
		}
		free.tenant = token.id;
		free.claimSeq = this.mintSeq(); // §5.4 tenancy: claim-after-release gets its own point on the line
		free.writeClock = 0;
		free.releasePending = false;
		token.slot = free.id;
		// §5.3 write-set closure: a committed-but-slotless token (ActionScope /
		// late first write) interns here — its root's membership bits gain the
		// slot NOW so the committed clause sees the coming receipts.
		for (const r of this.roots.values()) {
			if (r.committedTokens.has(token.id)) r.committedBits |= 1 << free.id;
		}
		{
			const clear = ~(1 << free.id);
			for (const w of this.watchers.values()) w.dedupBits &= clear; // §5.9 dedup clear at re-intern
		}
		this.log({ type: 'slot-claimed', slot: free.id, token: token.id });
		return free;
	}

	private releaseSlot(slot: SlotMeta): void {
		const tenant = slot.tenant === undefined ? undefined : this.token(slot.tenant);
		if (tenant !== undefined) {
			slot.carriedMaxRetiredSeq = Math.max(slot.carriedMaxRetiredSeq, tenant.retiredSeq ?? 0);
			tenant.slot = undefined; // identity release; receipts keep their denormalized slot (§5.4)
			this.log({ type: 'slot-released', slot: slot.id, token: tenant.id });
		}
		slot.tenant = undefined;
		slot.releasePending = false;
		if (tenant !== undefined) this.maybeReclaimToken(tenant); // SPK-K1: identity gone, mask/receipt gates re-check
	}

	// ------------------------------------------------------ the write path

	/** §3.5 — a write belongs to its batch context; bare writes go ambient. */
	bareWrite(node: AtomNode, op: Op): void {
		let ambient = this.ambientToken === undefined ? undefined : this.tokens.get(this.ambientToken);
		if (ambient === undefined || ambient.state !== 'live') {
			ambient = this.openBatch('default', { ambient: true });
			this.ambientToken = ambient.id;
		}
		// §3.5 dev warning heuristic: bare-context write while an action is pending.
		if (this.parkedCount > 0) {
			this.log({ type: 'dev-warning', message: 'a signal write after await landed outside the action — wrap it in startTransition or use the action scope (§3.5)' });
		}
		this.write(ambient.id, node, op);
	}

	/** §3.2 ActionScope — classifies into the action's token; throws after settlement. */
	scopeWrite(tokenId: TokenId, node: AtomNode, op: Op): void {
		const t = this.token(tokenId);
		if (!t.action) throw new BridgeScheduleError('scope writes require an action token (§3.2)');
		if (t.state !== 'live') throw new BridgeScheduleError('ActionScope closed (§3.6)');
		this.write(tokenId, node, op);
	}

	/**
	 * §5.3 — the write path (LOGGED). DIRECT writes mutate committed-only
	 * state with no receipt (§5.1: pre-swap history is legal LOGGED state).
	 * LOGGED steps, in order: classify (caller) → drop check → intern slot →
	 * append packed receipt + write clock → apply to K0 with stepwise
	 * equality → marking walk → delivery walk → core-effect flush after the
	 * walk returns.
	 */
	write(tokenId: TokenId | undefined, node: AtomNode, op: Op): void {
		if (this.evalDepth > 0) throw new BridgeScheduleError('signal write during a world evaluation / render (§3.6)');
		if (this.inFoldCallback) throw new BridgeScheduleError('signal write inside an updater/reducer fold (§3.1)');
		if (node.kind !== 'atom') throw new BridgeScheduleError('writes target atoms');
		if (this.mode === 'direct') {
			const next = this.applyOp(node, op, node.base);
			if (!this.inCallback(() => node.equals(next, node.base))) {
				node.base = next;
				node.origin = next; // pre-LOGGED history is committed-only base state (§5.1)
				this.applyToKernel(node, next);
			}
			this.directFlushCoreEffects();
			const tr = this.trace;
			if (tr !== undefined) tr.opEnd();
			return;
		}
		if (tokenId === undefined) {
			this.bareWrite(node, op);
			return;
		}
		// Windowed writes hit one token repeatedly — one compare beats a Map probe.
		let token: Token;
		if (tokenId === this.lastTokenId && this.lastTokenRef !== undefined) {
			token = this.lastTokenRef;
		} else {
			token = this.token(tokenId);
			this.lastTokenId = tokenId;
			this.lastTokenRef = token;
		}
		if (token.state !== 'live') throw new BridgeScheduleError(`write into retired token ${tokenId} (§4.1 fact 4 fallback is fork scope)`);

		const tp = node.tp;
		// §5.3 step 2 — drop check: empty tape AND op evaluates equal against base.
		if (tp.n === tp.start) {
			if (op.kind === 'set' && node.eqIsDefault) {
				if (Object.is(op.value, node.base)) {
					this.log({ type: 'write-dropped', node: node.name, token: tokenId });
					const tr = this.trace;
					if (tr !== undefined) tr.opEnd();
					return;
				}
			} else {
				const evaluated = this.applyOp(node, op, node.base);
				if (this.inCallback(() => node.equals(evaluated, node.base))) {
					this.log({ type: 'write-dropped', node: node.name, token: tokenId });
					const tr = this.trace;
					if (tr !== undefined) tr.opEnd();
					return;
				}
			}
		}

		// §5.3 steps 1/3 — intern slot, append receipt, bump the slot write clock.
		const slot = token.slot !== undefined ? this.slots[token.slot]! : this.internSlot(token);
		const seq = this.mintSeq();
		const kind = op.kind === 'set' ? OP_SET : op.kind === 'update' ? OP_UPDATE : OP_DISPATCH;
		tp.push(kind, slot.id, seq, token.id, op.kind === 'set' ? op.value : op.kind === 'update' ? op.fn : op.action);
		token.lastWriteSeq = seq;
		token.liveReceipts++;
		if (node.lastTouchToken !== token.id) {
			node.lastTouchToken = token.id;
			token.atomsTouched.push(node);
		}
		if (tp.n - tp.start === 1) this.dirtyAtoms.add(node);
		slot.writeClock = seq;
		if (this.roots.size !== 0) {
			// §5.3 write-set closure: a write into a committed-member slot moves
			// committed truth NOW; the next durable drain reconciles its cone.
			const bit0 = 1 << slot.id;
			for (const r of this.roots.values()) {
				if ((r.committedBits & bit0) !== 0) r.committedDirtySlots |= bit0;
			}
		}
		{
			const tr = this.trace;
			if (tr !== undefined) tr.receipt(node, tp.entryAt(tp.n - 1));
		}
		this.log({ type: 'write', node: node.name, token: token.id, slot: slot.id, seq });

		// §5.2/§5.3 step 3 — apply to K0 eagerly with stepwise equality, so the
		// newest world stays directly readable off the kernel plane.
		if (kind === OP_SET && node.eqIsDefault) {
			this.applyToKernel(node, (op as { kind: 'set'; value: Value }).value); // kernel stores + propagates only on change
		} else {
			const prevNewest = this.kernelValueOf(node.handle);
			const nextNewest = this.applyOp(node, op, prevNewest);
			if (!this.inCallback(() => node.equals(nextNewest, prevNewest))) {
				this.applyToKernel(node, nextNewest);
			}
		}

		// §5.3 step 4 — the marking walk: propagate the slot's bit from the atom
		// through K0∪K1 out-edges with the monotone frontier (§5.5).
		const bit = 1 << slot.id;
		if ((this.touched[node.id]! & bit) === 0) this.propagateBits(node.id, bit);
		// §5.3 step 5 — the value-blind delivery walk (§5.9), in the writer's
		// stack; core effects enqueue on the walk and flush after it returns.
		this.deliveryWalk(node.id, token, slot, seq);
		this.flushEffectQueue();
		const tr = this.trace;
		if (tr !== undefined) tr.opEnd();
	}

	/** The one K0 write site: routes through the public policy path (flush included). */
	private applyToKernel(node: AtomNode, value: Value): void {
		const saved = bridgeApplying;
		const savedRoute = routeWrites;
		bridgeApplying = true;
		routeWrites = 0; // the wrapper must not re-classify the bridge's own kernel apply
		try {
			node.handle.set(value);
		} finally {
			bridgeApplying = saved;
			routeWrites = savedRoute;
		}
	}

	/**
	 * §5.9 delivery — per-write, value-blind, in the writer's stack. The
	 * per-(watcher, slot) dedup bit suppresses only when scheduled-but-
	 * unstarted work will fold the write; otherwise deliver interleaved.
	 */
	private deliver(w: Watcher, token: Token, slot: SlotMeta, seq: number): void {
		const bit = 1 << slot.id;
		if ((w.dedupBits & bit) === 0) {
			w.dedupBits |= bit;
			this.log({ type: 'delivery', watcher: w.name, token: token.id, slot: slot.id, seq, mode: 'fresh' });
			return;
		}
		// Bit set: suppress iff NO started-and-uncommitted pass on W's root
		// includes s (render mask) with pin < the write's sequence (§5.9).
		// One open pass per root (§4.1 fact 2) ⇒ one registry load + two compares.
		const p = this.openPassByRoot.get(w.root);
		if (p !== undefined && ((p.maskBits >>> slot.id) & 1) === 1 && p.pin < seq) {
			this.log({ type: 'delivery', watcher: w.name, token: token.id, slot: slot.id, seq, mode: 'interleaved' });
		} else {
			this.log({ type: 'suppressed', watcher: w.name, token: token.id, slot: slot.id, seq });
		}
	}

	/** §5.11 — core effects observe the newest world; flush after the walk returns. */
	private flushEffectQueue(): void {
		const q = this.effectQueue;
		if (q.length === 0) return;
		if (q.length > 1) q.sort((a, b) => a.id - b.id); // the model's map order
		for (let i = 0; i < q.length; i++) {
			const e = q[i]!;
			const value = this.evaluate(this.nodeById(e.node), NEWEST);
			if (!Object.is(value, e.lastValue)) {
				e.lastValue = value;
				e.runs++;
				this.log({ type: 'core-effect-run', effect: e.name, value });
			}
		}
		q.length = 0;
	}

	/** DIRECT-mode writes flush every core effect (no walk exists to scope them). */
	private directFlushCoreEffects(): void {
		for (const e of this.coreEffects.values()) {
			const value = this.evaluate(this.nodeById(e.node), NEWEST);
			if (!Object.is(value, e.lastValue)) {
				e.lastValue = value;
				e.runs++;
				this.log({ type: 'core-effect-run', effect: e.name, value });
			}
		}
	}

	// ------------------------------------------------------ pass lifecycle

	/**
	 * §4.1 fact 2 / §5.3 — open a render pass: pin frozen at start, render
	 * mask captured from live tokens, committed set snapshotted. One WIP
	 * pass per root (a same-root restart is a new pass).
	 */
	passStart(rootId: RootId, includeTokens: TokenId[]): Pass {
		if (this.openPassByRoot.has(rootId)) {
			throw new BridgeScheduleError(`root ${rootId} already has an open pass (§4.1 fact 2)`);
		}
		const maskTokens = new Set<TokenId>();
		const maskSlots = new Set<SlotId>();
		let maskBits = 0;
		for (const id of includeTokens) {
			const t = this.token(id);
			if (t.state !== 'live') throw new BridgeScheduleError('mask captures live tokens only (§5.4)');
			maskTokens.add(id);
			// A live token with no slot never wrote; later receipts postdate the
			// pin and are clause-2-excluded anyway (§5.4 pin/seq-after-claim).
			if (t.slot !== undefined) {
				maskSlots.add(t.slot);
				maskBits |= 1 << t.slot;
			}
		}
		const capturedCommittedSlots = this.committedSlotsNow(rootId);
		let includedBits = maskBits;
		for (const s of capturedCommittedSlots) includedBits |= 1 << s;
		const pass: Pass = {
			id: this.nextPass++, root: rootId, pin: this.seq,
			maskTokens, maskSlots, capturedCommittedSlots,
			maskBits, includedBits,
			state: 'open', endKind: undefined, mounted: [], rendered: new Set(),
			memos: new Map(), pendingEdgeDeliveries: [],
		};
		this.passes.set(pass.id, pass);
		this.openPassByRoot.set(rootId, pass);
		const tr = this.trace;
		if (tr !== undefined) {
			tr.passStart(pass);
			tr.opEnd();
		}
		return pass;
	}

	private pass(id: PassId): Pass {
		const p = this.passes.get(id);
		if (p === undefined) throw new BridgeScheduleError(`unknown pass ${id}`);
		return p;
	}

	/** §4.1 fact 2 — yield/resume edges; gap handlers are "not in render". */
	passYield(id: PassId): void {
		const p = this.pass(id);
		if (p.state !== 'open') throw new BridgeScheduleError('yield requires an open (running) pass');
		p.state = 'yielded';
		const tr = this.trace;
		if (tr !== undefined) {
			tr.passYield(p);
			tr.opEnd();
		}
	}

	passResume(id: PassId): void {
		const p = this.pass(id);
		if (p.state !== 'yielded') throw new BridgeScheduleError('resume requires a yielded pass');
		p.state = 'open';
		const tr = this.trace;
		if (tr !== undefined) {
			tr.passResume(p);
			tr.opEnd();
		}
	}

	/** §5.10 — mount a new watcher inside an open pass; renders in the pass's world. */
	mountWatcher(passId: PassId, node: AnyNode, name: string): Watcher {
		const p = this.pass(passId);
		if (p.state === 'ended') throw new BridgeScheduleError('mount requires an open pass');
		const value = this.evaluate(node, { kind: 'pass', pass: p });
		const watcher = new Watcher(this.nextWatcher++, name, p.root, node.id, value, {
			passId: p.id, pin: p.pin,
			maskSlots: new Set(p.maskSlots),
			includedSlots: this.includedSet(p),
			rootCommitGen: this.root(p.root).commitGen,
		});
		this.watchers.set(watcher.id, watcher);
		let byNode = this.watchersByNode[node.id];
		if (byNode === undefined) {
			byNode = [];
			this.watchersByNode[node.id] = byNode;
		}
		byNode.push(watcher);
		p.mounted.push(watcher.id);
		p.rendered.add(watcher.id);
		return watcher;
	}

	/**
	 * Reveal-shaped mounts (§5.10 "Offscreen/Activity reveal"): the mounting
	 * pass commits but the watcher's layout effects (subscribe + fixup)
	 * defer to a later, adopting commit.
	 */
	deferMount(watcherId: WatcherId): void {
		for (const p of this.passes.values()) {
			const i = p.mounted.indexOf(watcherId);
			if (i >= 0) p.mounted.splice(i, 1);
		}
	}

	adoptMount(passId: PassId, watcherId: WatcherId): void {
		const adopter = this.pass(passId);
		if (adopter.state === 'ended') throw new BridgeScheduleError('adopting pass must be open');
		const w = this.watchers.get(watcherId);
		if (w === undefined) throw new BridgeScheduleError('unknown watcher');
		if (w.root !== adopter.root) throw new BridgeScheduleError('reveal stays on the watcher root');
		for (const p of this.passes.values()) {
			const i = p.mounted.indexOf(watcherId);
			if (i >= 0) p.mounted.splice(i, 1);
		}
		adopter.mounted.push(watcherId);
	}

	/** An existing live watcher re-rendered by a pass: dedup bits re-arm at render (§5.9). */
	renderWatcher(passId: PassId, watcherId: WatcherId): void {
		const p = this.pass(passId);
		if (p.state === 'ended') throw new BridgeScheduleError('render requires an open pass');
		const w = this.watchers.get(watcherId);
		if (w === undefined || !w.live) throw new BridgeScheduleError('render targets a live watcher');
		if (w.root !== p.root) throw new BridgeScheduleError('watcher belongs to another root');
		w.dedupBits = 0;
		p.rendered.add(watcherId);
	}

	/** Unlinks a watcher from the per-node index (discarded mounts). */
	private dropWatcher(wid: WatcherId): void {
		const w = this.watchers.get(wid);
		if (w === undefined) return;
		this.watchers.delete(wid);
		const byNode = this.watchersByNode[w.node];
		if (byNode !== undefined) {
			const i = byNode.indexOf(w);
			if (i >= 0) byNode.splice(i, 1);
		}
	}

	/** §3.2 useSignalEffect — committed-for-root observer (§5.11). */
	mountReactEffect(rootId: RootId, node: AnyNode, name: string): ReactEffect {
		const e: ReactEffect = {
			id: this.nextEffect++, name, root: rootId, node: node.id,
			lastValue: this.evaluate(node, { kind: 'committed', root: rootId }),
			runs: 0,
		};
		this.root(rootId);
		this.reactEffects.set(e.id, e);
		let byNode = this.reactEffectsByNode[node.id];
		if (byNode === undefined) {
			byNode = [];
			this.reactEffectsByNode[node.id] = byNode;
		}
		byNode.push(e);
		return e;
	}

	/** §3.1 core effect() — newest-world observer (§5.11). */
	mountCoreEffect(node: AnyNode, name: string): CoreEffect {
		const e: CoreEffect = {
			id: this.nextEffect++, name, node: node.id,
			lastValue: this.evaluate(node, NEWEST),
			runs: 0,
			queuedWalk: 0,
		};
		this.coreEffects.set(e.id, e);
		let byNode = this.coreEffectsByNode[node.id];
		if (byNode === undefined) {
			byNode = [];
			this.coreEffectsByNode[node.id] = byNode;
		}
		byNode.push(e);
		return e;
	}

	/**
	 * §4.1 fact 2 / §4.2 — end a pass. Commit order per §4.2: (1) baseline
	 * capture, (2) retirement folds due at this commit + per-root table
	 * update, (3) durable drains, (4) layout (subscribe + mount fixups).
	 * Discard: pass-owned mounts die (§3.3); deferred slot releases
	 * re-evaluate at EVERY pass end, commit and discard alike (§5.4).
	 */
	passEnd(id: PassId, kind: 'commit' | 'discard', opts?: { retireAtCommit?: TokenId[] }): void {
		const p = this.pass(id);
		if (p.state === 'ended') throw new BridgeScheduleError('pass already ended');
		if (kind === 'commit') {
			for (const tid of opts?.retireAtCommit ?? []) {
				const t = this.token(tid); // throws on unknown ids before any mutation
				if (!p.maskTokens.has(tid)) {
					// §5.10 errata 3: a retirement folded inside a commit must belong
					// to a batch this commit rendered — foreign batches retire at
					// their own closure (fork tests 22/25 make this unreachable).
					throw new BridgeScheduleError(`token ${tid} is not rendered by pass ${p.id}; its retirement cannot be due at this commit (§4.2)`);
				}
				if (t.state !== 'live' || t.parked) {
					throw new BridgeScheduleError(`token ${tid} cannot retire at this commit (already retired, or parked)`);
				}
			}
		}
		// Resolve mask token records BEFORE any retirement can reclaim them
		// (§5.10 errata 1 quantifies over mask TOKENS at commit time).
		const maskTokenRecords: Token[] = [];
		if (kind === 'commit') {
			for (const tid of p.maskTokens) maskTokenRecords.push(this.token(tid));
		}
		p.state = 'ended';
		p.endKind = kind;
		this.openPassByRoot.delete(p.root);
		{
			// Trace-only pass-end: fires BEFORE the end's consequences (retirement
			// folds, per-root commits, drains, fixups), unlike the pass-committed/
			// pass-discarded events below, so consequences can cite it as cause.
			const tr = this.trace;
			if (tr !== undefined) tr.passEnd(p, kind);
		}
		if (kind === 'discard') {
			for (const wid of p.mounted) this.dropWatcher(wid); // never subscribed; the tree died
			this.log({ type: 'pass-discarded', pass: p.id, root: p.root });
			this.reevaluateDeferredReleases();
			this.reclaimAfterPassEnd(p);
			const tr = this.trace;
			if (tr !== undefined) tr.opEnd();
			return;
		}
		// (1) §4.2 baseline capture at the commit's committed-side entry.
		const baseline = { cas: this.cas, rootCommitGen: this.root(p.root).commitGen };
		// The committing tree's content: re-rendered watchers take this pass's
		// world values NOW — §5.11's "last rendered value updates only at
		// committed renders", the comparator §4.2's drains reconcile against.
		for (const wid of p.rendered) {
			const w = this.watchers.get(wid);
			if (w === undefined || p.mounted.includes(wid)) continue;
			w.lastRenderedValue = this.evaluate(this.nodeById(w.node), { kind: 'pass', pass: p });
			w.snapshot = {
				passId: p.id, pin: p.pin, maskSlots: new Set(p.maskSlots),
				includedSlots: this.includedSet(p), rootCommitGen: this.root(p.root).commitGen,
			};
		}
		// (2) retirement folds due at this commit; then the per-root commit
		// (lock-in) of every still-live mask token (§5.3).
		for (const tid of opts?.retireAtCommit ?? []) this.retireInternal(this.token(tid), true);
		for (const t of maskTokenRecords) {
			if (t.state !== 'live') continue; // fully retired above: the retired clause subsumes membership
			const root = this.root(p.root);
			if (!root.committedTokens.has(t.id)) {
				root.committedTokens.add(t.id);
				if (t.slot !== undefined) root.committedBits |= 1 << t.slot;
				root.commitGen++;
				this.cas = this.mintSeq(); // committed-advance (§2): every per-root commit bumps it
				this.log({ type: 'per-root-commit', root: p.root, token: t.id });
				// (3) durable drain: the advanced slot's touched list plus any
				// member-slot write drift, scoped to this root's committed
				// observers (§5.3/§5.11).
				const bits = (t.slot !== undefined ? 1 << t.slot : 0) | root.committedDirtySlots;
				root.committedDirtySlots = 0;
				const re = this.restaled.get(p.root);
				if (bits !== 0 || (re !== undefined && re.size > 0)) this.drainCommittedObservers(p.root, 'per-root-commit', bits);
			}
		}
		// (4) layout: subscribe, then mount fixup (§5.10/§5.11 lifecycle order).
		for (const wid of p.mounted) {
			const w = this.watchers.get(wid);
			if (w === undefined) continue;
			w.live = true;
			this.mountFixup(w, p, baseline, maskTokenRecords);
		}
		// Re-staled detection (§4.2): a re-rendered watcher whose committed
		// value moved past its pin is stale again the moment its commit reset
		// lastRenderedValue; the NEXT durable drain reconciles it (the naive
		// model's full scan does the same, one drain later than the flip).
		for (const wid of p.rendered) {
			const w = this.watchers.get(wid);
			if (w === undefined || !w.live) continue;
			const committedNow = this.evaluate(this.nodeById(w.node), { kind: 'committed', root: p.root });
			if (!Object.is(committedNow, w.lastRenderedValue)) this.markRestaled(w);
		}
		this.log({ type: 'pass-committed', pass: p.id, root: p.root });
		this.reevaluateDeferredReleases();
		this.reclaimAfterPassEnd(p);
		const tr = this.trace;
		if (tr !== undefined) tr.opEnd();
	}

	/**
	 * SPK-K1 mid-episode reclamation, pass-end site: the ended pass record
	 * drops (its memos and mask mappings die with it — nothing dead can
	 * validate later, §5.12), and its mask tokens re-check reclaimability
	 * (the mask retention just lapsed).
	 */
	private reclaimAfterPassEnd(p: Pass): void {
		this.passes.delete(p.id);
		for (const tid of p.maskTokens) {
			const t = this.tokens.get(tid);
			if (t !== undefined) this.maybeReclaimToken(t);
		}
	}

	/** §5.4 — deferred releases re-evaluate at every pass end, commit and discard alike. */
	private reevaluateDeferredReleases(): void {
		for (const s of this.slots) {
			if (!s.releasePending) continue;
			if (!this.slotRetainedByOpenMask(s.id)) this.releaseSlot(s);
		}
		// A pass ending releases its pin, which can unblock pin-gated compaction (§5.3).
		this.compactAll();
	}

	private slotRetainedByOpenMask(slot: SlotId): boolean {
		for (const p of this.openPassByRoot.values()) {
			if ((p.maskBits >>> slot) & 1) return true;
		}
		return false;
	}

	private tokenMaskedByOpenPass(id: TokenId): boolean {
		for (const p of this.openPassByRoot.values()) {
			if (p.maskTokens.has(id)) return true;
		}
		return false;
	}

	/**
	 * SPK-K1 mid-episode reclamation (the §5.12 sweep-predicate extension,
	 * re-scoped by measurement): a token record is reclaimable once it is
	 * retired, its slot identity is fully released (not deferred), no open
	 * pass's mask names it, and none of its receipts remain un-compacted
	 * (tapes still reference it by id — the retention the tenancy lemma
	 * leans on). Keep-the-dirt discipline: touched bits/lists are untouched
	 * — they are tenant-agnostic conservative dirt (§5.4).
	 */
	private maybeReclaimToken(t: Token): void {
		if (t.state !== 'retired') return;
		if (t.slot !== undefined) return; // identity still held (deferred release keeps tenant)
		if (t.liveReceipts > 0) return;
		if (t.id === this.ambientToken) return;
		if (this.tokenMaskedByOpenPass(t.id)) return;
		this.tokens.delete(t.id);
		if (this.lastTokenId === t.id) {
			this.lastTokenId = 0;
			this.lastTokenRef = undefined;
		}
	}

	// ---------------------------------------------------------- retirement

	/** §4.1 fact 3 — retirement fires exactly once; parked actions retire at settlement. */
	retire(tokenId: TokenId, committed: boolean): void {
		const t = this.token(tokenId);
		if (t.state === 'retired') throw new BridgeScheduleError('retirement fires exactly once per token (§4.1 fact 3)');
		if (t.parked) throw new BridgeScheduleError('parked action tokens retire only at settlement (§4.1 fact 3)');
		this.retireInternal(t, committed);
		const tr = this.trace;
		if (tr !== undefined) tr.opEnd();
	}

	/** §3.5 — the action's thenable settles; the fork then retires the token. */
	settleAction(tokenId: TokenId, committed: boolean): void {
		const t = this.token(tokenId);
		if (!t.action) throw new BridgeScheduleError('settle targets an action token');
		if (!t.parked || t.state !== 'live') throw new BridgeScheduleError('action already settled');
		t.parked = false;
		this.parkedCount--;
		const tr = this.trace;
		if (tr !== undefined) tr.batchSettle(t, committed);
		this.retireInternal(t, committed);
		if (tr !== undefined) tr.opEnd();
	}

	/**
	 * §5.3 retirement — the internal order is normative: stamp, fold
	 * (compaction), retirement stamps + cas, durable drains, clear per-root
	 * rows, and only then release the slot (deferred if an open pass's
	 * render mask names it; §5.4). committed=false batches retire through
	 * this same path — persistence never depends on subscription.
	 */
	private retireInternal(t: Token, committed: boolean): void {
		if (t.state === 'live') {
			this.liveTokenCount--;
			if (t.parked) this.parkedCount--;
		}
		t.state = 'retired';
		t.committedFlag = committed;
		t.parked = false;
		const retiredSeq = this.mintSeq(); // one retirement sequence per retirement event
		t.retiredSeq = retiredSeq;
		// Stamp only the atoms this token actually touched (SPK-W/SPK-N1: the
		// per-token touch list replaces the all-nodes/all-receipts scan).
		let touchedAny = false;
		const touchedAtoms = t.atomsTouched;
		for (let i = 0; i < touchedAtoms.length; i++) {
			const n = touchedAtoms[i]!;
			if (n.retirementStamp === retiredSeq) continue; // duplicate touch entry
			const tp = n.tp;
			const tokens = tp.tokens;
			const retired = tp.retired;
			let hit = false;
			for (let j = tp.start; j < tp.n; j++) {
				if (tokens[j] === t.id && retired[j] === 0) {
					retired[j] = retiredSeq;
					hit = true;
				}
			}
			if (hit) {
				// §5.3 step 3 — mint the retirement stamp per touched atom.
				n.retirementStamp = retiredSeq;
				touchedAny = true;
			}
		}
		if (touchedAny) this.cas = this.mintSeq();
		// Fold/compaction (§5.3 step 2's compaction predicate, both clauses).
		this.compactAll();
		this.log({ type: 'retired', token: t.id, committed, retiredSeq });
		// §5.3 step 4 — durable drains: enumerate the flipped slot's touched
		// list (never only a consumable write-time queue) and reconcile/
		// revalidate that cone against committed truth, for every root (§5.9).
		{
			const slotBit = t.slot !== undefined ? 1 << t.slot : 0;
			for (const r of this.roots.values()) {
				const bits = slotBit | r.committedDirtySlots;
				r.committedDirtySlots = 0;
				const re = this.restaled.get(r.id);
				if (bits !== 0 || (re !== undefined && re.size > 0)) this.drainCommittedObservers(r.id, 'retirement', bits);
			}
		}
		// §5.3 step 5 — clear per-root rows (subsumed by the retired clause),
		// THEN release the slot unless an open render mask names it.
		for (const r of this.roots.values()) {
			if (r.committedTokens.delete(t.id)) this.rebuildCommittedBits(r);
		}
		if (t.slot !== undefined) {
			const slot = this.slots[t.slot]!;
			if (this.slotRetainedByOpenMask(slot.id)) {
				slot.releasePending = true; // re-evaluated at every pass end (§5.4)
				const tr = this.trace;
				if (tr !== undefined) tr.slotReleaseDeferred(slot.id, t.id);
			} else {
				this.releaseSlot(slot);
			}
		}
		if (this.ambientToken === t.id) this.ambientToken = undefined;
		this.maybeReclaimToken(t);
	}

	private rebuildCommittedBits(r: RootState): void {
		let bits = 0;
		for (const tid of r.committedTokens) {
			const tok = this.tokens.get(tid);
			if (tok !== undefined && tok.slot !== undefined) bits |= 1 << tok.slot;
		}
		r.committedBits = bits;
	}

	/**
	 * §5.3 — compaction consumes a sequence-order prefix of the tape: entry e
	 * compacts iff every entry with seq ≤ e.seq is retired AND
	 * e.retiredSeq ≤ min(live pins). Compacted entries fold into base (kept
	 * in the archive only when `retainArchive` — SPK-K1).
	 */
	private compactAll(): void {
		if (this.dirtyAtoms.size === 0) return;
		const minPin = this.minLivePin();
		for (const n of this.dirtyAtoms) {
			this.compactAtom(n, minPin);
			if (n.tp.n === n.tp.start) this.dirtyAtoms.delete(n);
		}
	}

	private compactAtom(atom: AtomNode, minPin: number): void {
		const tp = atom.tp;
		const n = tp.n;
		const retired = tp.retired;
		const from = tp.start;
		let cut = 0;
		while (from + cut < n) {
			const r = retired[from + cut]!;
			if (r === 0) break; // prefix clause: an unretired earlier entry blocks everything after
			if (r > minPin) break; // pin clause: every live pin already sees e via the retired clause
			cut++;
		}
		if (cut === 0) return;
		const keepArchive = this.retainArchive;
		for (let k = 0; k < cut; k++) {
			const i = from + k;
			const next = this.applyOpPacked(atom, tp.kinds[i]!, tp.payloads[i], atom.base);
			if (atom.eqIsDefault) {
				if (!Object.is(next, atom.base)) atom.base = next;
			} else if (!this.inCallback(() => atom.equals(next, atom.base))) {
				atom.base = next;
			}
			atom.baseSeq = tp.seqs[i]!;
			if (keepArchive) atom.archiveStore.push(tp.entryAt(i));
			// SPK-K1: a compacted receipt stops pinning its token record.
			const tok = this.tokens.get(tp.tokens[i]!);
			if (tok !== undefined) {
				tok.liveReceipts--;
				if (tok.liveReceipts === 0) this.maybeReclaimToken(tok);
			}
		}
		tp.drop(cut);
	}

	/**
	 * §5.3/§5.11 — durable drain at a committed-truth flip: enumerate the
	 * flipped slot's touched list (§5.9 durable drains; watcher sets resolve
	 * at drain time), reconcile-check each listed live watcher (last rendered
	 * value vs committed-for-root NOW; urgent pre-paint correction on real
	 * difference — this comparison is against committed truth, which is
	 * legal; live-write delivery is never value-gated), and revalidate the
	 * listed committed effects (re-run on change). Candidates fire in id
	 * order (the naive model's map order); the touched-list scoping is
	 * value-gated-identical to a full observer scan by the §5.9 coverage
	 * construction.
	 */
	private drainWatcherBuf: Watcher[] = [];
	private drainEffectBuf: ReactEffect[] = [];

	/**
	 * Watchers re-staled by their own commit (§4.2): the commit reset
	 * lastRenderedValue to the pass world's pin-old value while committed
	 * truth had already moved past the pin. The naive model catches these at
	 * its next full-scan drain; the engine keeps the precise set and folds it
	 * into the next durable drain on the watcher's root.
	 */
	private restaled = new Map<RootId, Set<Watcher>>();

	private markRestaled(w: Watcher): void {
		let set = this.restaled.get(w.root);
		if (set === undefined) {
			set = new Set();
			this.restaled.set(w.root, set);
		}
		set.add(w);
	}

	private drainCommittedObservers(rootId: RootId, cause: 'retirement' | 'per-root-commit', slotBits: number): void {
		const world: World = { kind: 'committed', root: rootId };
		const gen = ++this.walkGen; // reuse the walk column for per-drain candidate dedup
		const lastWalk = this.lastWalk;
		const ws = this.drainWatcherBuf;
		const es = this.drainEffectBuf;
		ws.length = 0;
		es.length = 0;
		// Candidate collection: the flipped slots' touched lists, expanded over
		// WEAK (untracked) out-edges — strong cones are already fully listed.
		const stack = this.walkStack;
		let sp = 0;
		let sb = slotBits;
		while (sb !== 0) {
			const slot = 31 - Math.clz32(sb & -sb);
			sb &= sb - 1;
			const list = this.slotTouched[slot]!;
			for (let i = 0; i < list.length; i++) {
				const nid = list[i]!;
				if (lastWalk[nid] === gen) continue;
				lastWalk[nid] = gen;
				stack[sp++] = nid;
			}
		}
		const candidates: NodeId[] = [];
		while (sp > 0) {
			const nid = stack[--sp]!;
			candidates.push(nid);
			const weak = this.weakOutList[nid];
			if (weak !== undefined) {
				for (let i = 0; i < weak.length; i++) {
					const wn = weak[i]!;
					if (lastWalk[wn] !== gen) {
						lastWalk[wn] = gen;
						stack[sp++] = wn;
					}
				}
			}
			// A weak hop lands on a node whose STRONG dependents also embed it
			// (tracked reads of an untracked-reading computed): expand strong
			// outs past a weak hop too, so transitive observers reconcile.
			const outs = this.outList[nid];
			if (outs !== undefined) {
				for (let i = 0; i < outs.length; i++) {
					const on = outs[i]!;
					if (lastWalk[on] !== gen) {
						lastWalk[on] = gen;
						stack[sp++] = on;
					}
				}
			}
		}
		for (let c = 0; c < candidates.length; c++) {
			const nid = candidates[c]!;
			const nw = this.watchersByNode[nid];
			if (nw !== undefined) {
				for (let j = 0; j < nw.length; j++) {
					const w = nw[j]!;
					if (w.live && w.root === rootId) ws.push(w);
				}
			}
			const ne = this.reactEffectsByNode[nid];
			if (ne !== undefined) {
				for (let j = 0; j < ne.length; j++) {
					const e = ne[j]!;
					if (e.root === rootId) es.push(e);
				}
			}
		}
		{
			const re = this.restaled.get(rootId);
			if (re !== undefined && re.size > 0) {
				for (const w of re) {
					if (!w.live) continue;
					if (lastWalk[w.node] === gen) continue; // its node was already listed
					ws.push(w);
				}
				re.clear();
			}
		}
		if (ws.length > 1) ws.sort((a, b) => a.id - b.id);
		if (es.length > 1) es.sort((a, b) => a.id - b.id);
		for (let i = 0; i < ws.length; i++) {
			const w = ws[i]!;
			const now = this.evaluate(this.nodeById(w.node), world);
			if (!Object.is(now, w.lastRenderedValue)) {
				this.log({ type: 'reconcile-correction', watcher: w.name, root: rootId, from: w.lastRenderedValue, to: now, cause });
				w.lastRenderedValue = now; // the urgent pre-paint re-render
				w.dedupBits = 0; // dedup bits re-arm at the watcher's render (§5.9)
			}
		}
		for (let i = 0; i < es.length; i++) {
			const e = es[i]!;
			const now = this.evaluate(this.nodeById(e.node), world);
			if (!Object.is(now, e.lastValue)) {
				e.lastValue = now;
				e.runs++;
				this.log({ type: 'react-effect-run', effect: e.name, root: rootId, value: now });
			}
		}
		ws.length = 0;
		es.length = 0;
	}

	// ---------------------------------------------------------- mount fixup

	/**
	 * §5.10 — runs in the mounting component's layout effect, after
	 * subscription. Value-blind correctives join each live non-included
	 * batch that touched the node; then one comparison against the mount's
	 * own world fast-forwarded to committed-now catches whatever retired or
	 * locked in during the window — before paint. Implements the normative
	 * oracle errata (2026-07-05): the clock conjunct quantifies over the
	 * committing pass's mask TOKENS at commit time (errata 1), and fast-out-
	 * suppressed divergence must be exactly corrective-covered (errata 2,
	 * asserted on every mount).
	 */
	private mountFixup(w: Watcher, committingPass: Pass, baseline: { cas: number; rootCommitGen: number }, maskTokenRecords: Token[]): void {
		const node = this.nodeById(w.node);
		const closure = this.dependencyClosureOf(w.node);
		// Per-token corrective loop: every LIVE written token that touched the
		// node. A premise of the population argument, not an optimization
		// (errata 2): it covers exactly the divergence the fast-out suppresses.
		const correctedLive = new Set<TokenId>();
		for (const t of this.tokens.values()) {
			if (t.state !== 'live' || t.slot === undefined) continue;
			if (!this.tokenTouches(t, closure)) continue;
			const slot = this.slots[t.slot]!;
			// Fully included (slot ∈ includedSet ∧ no post-pin write): skip — never by value.
			if (w.snapshot.includedSlots.has(slot.id) && slot.writeClock <= w.snapshot.pin) continue;
			this.log({ type: 'mount-corrective', watcher: w.name, token: t.id, slot: slot.id });
			correctedLive.add(t.id);
			w.dedupBits |= 1 << slot.id; // the corrective is a scheduled setState in t's lane (fork.runInBatch)
		}
		// The four-conjunct fast-out (§5.10). The clock conjunct checks the
		// captured mask slots AND the committing pass's mask tokens at commit
		// time (errata 1: a mask token whose first write interned mid-pass is
		// invisible to the slot-quantified form).
		const clocksQuiet =
			[...w.snapshot.maskSlots].every((s) => this.slots[s]!.writeClock <= w.snapshot.pin) &&
			maskTokenRecords.every((t) => t.lastWriteSeq === 0 || t.lastWriteSeq <= w.snapshot.pin);
		const fastOut =
			w.snapshot.passId === committingPass.id &&
			baseline.cas <= w.snapshot.pin &&
			baseline.rootCommitGen === w.snapshot.rootCommitGen &&
			clocksQuiet;
		const vFx = this.evaluate(node, {
			kind: 'mountFix', maskSlots: w.snapshot.maskSlots, pin: w.snapshot.pin, root: w.root,
		});
		const tr = this.trace; // R11: one disposition record per mount fixup (§5.10)
		if (fastOut) {
			if (!Object.is(vFx, w.lastRenderedValue)) {
				// Errata 2 audit: fast-out divergence must be exactly corrective-
				// covered. The audit world keeps what w_r itself saw of the
				// excluded tokens: its full included set at its pin.
				const vCovered = this.evaluate(node, {
					kind: 'mountFix', maskSlots: w.snapshot.includedSlots, pin: w.snapshot.pin,
					root: w.root, excludeLiveTokens: correctedLive,
				});
				if (!Object.is(vCovered, w.lastRenderedValue)) {
					throw new BridgeInvariantViolation(
						`fast-out unsound: watcher ${w.name} fast-out held but v_fx=${String(vFx)} ≠ v_r=${String(w.lastRenderedValue)} and the residue is not corrective-covered (§5.10 errata 2)`,
					);
				}
				if (tr !== undefined) tr.mountFixup(w, 'fast-out-covered', correctedLive.size);
				return;
			}
			if (tr !== undefined) tr.mountFixup(w, 'fast-out', correctedLive.size);
			return; // zero corrections — value-neutral modulo scheduled correctives
		}
		if (!Object.is(vFx, w.lastRenderedValue)) {
			this.log({ type: 'mount-urgent-correction', watcher: w.name, from: w.lastRenderedValue, to: vFx });
			w.lastRenderedValue = vFx; // urgent pre-paint correction
			w.dedupBits = 0;
			if (tr !== undefined) tr.mountFixup(w, 'corrected', correctedLive.size);
			return;
		}
		if (tr !== undefined) tr.mountFixup(w, 'compare-clean', correctedLive.size);
	}

	/** Transitive dependency closure feeding a node (reverse BFS over K0∪K1). */
	dependencyClosureOf(nodeId: NodeId): Set<NodeId> {
		const closure = new Set<NodeId>([nodeId]);
		const queue = [nodeId];
		while (queue.length > 0) {
			const cur = queue.pop()!;
			const ins = this.inList[cur];
			if (ins === undefined) continue;
			for (const dep of ins) {
				if (!closure.has(dep)) {
					closure.add(dep);
					queue.push(dep);
				}
			}
		}
		return closure;
	}

	private tokenTouches(t: Token, closure: Set<NodeId>): boolean {
		const atoms = t.atomsTouched;
		for (let i = 0; i < atoms.length; i++) {
			if (closure.has(atoms[i]!.id)) return true;
		}
		return false;
	}

	// ------------------------------------------- episodes and renumbering

	/** §4.1 fact 2 — discardAllWip: synchronously abandons every WIP pass. */
	discardAllWip(): void {
		for (const p of [...this.openPassByRoot.values()]) {
			this.passEnd(p.id, 'discard');
		}
	}

	quiescent(): boolean {
		return this.liveTokenCount === 0 && this.openPassByRoot.size === 0;
	}

	/**
	 * §5.12 — quiescence (no live tokens, no live pins, no parked actions):
	 * the K1 union plane bulk-resets (epoch bump), every retained counter
	 * renumbers (order-preserving), and every K1-touched node holding a
	 * committed watcher or effect-dep snapshot refreshes by a forced kernel
	 * pull into the NEW episode's K1 plane (the walks route over the K1
	 * mirror, so coverage must be re-recorded — the cone-carry outcome).
	 */
	quiesce(): void {
		if (!this.quiescent()) throw new BridgeScheduleError('quiescence requires no live tokens, pins, or parked actions (§5.12)');
		// Residue check: with no live pins, the last retirement compacted every tape.
		for (const n of this.nodes.values()) {
			if (n.kind === 'atom' && n.tp.n > n.tp.start) {
				throw new BridgeInvariantViolation(`quiescence residue: atom ${n.name} still holds ${n.tp.n - n.tp.start} receipts (§5.12)`);
			}
		}
		// Collect the §5.12 refresh targets BEFORE the reset: every K1-touched
		// node holding a committed watcher or effect-dep snapshot.
		const refreshTargets: ComputedNode[] = [];
		for (let id = 0; id < this.nodesArr.length; id++) {
			const n = this.nodesArr[id];
			if (n === undefined || n.kind !== 'computed') continue;
			if (this.outList[id] === undefined && this.inList[id] === undefined) continue; // not K1-touched
			const ws = this.watchersByNode[id];
			const es = this.reactEffectsByNode[id];
			if ((ws === undefined || ws.length === 0) && (es === undefined || es.length === 0)) continue;
			refreshTargets.push(n);
		}
		this.epoch++;
		// K1 bulk-reset + plane watermark zeroes (§5.12).
		this.outSets.length = 0;
		this.outList.length = 0;
		this.inList.length = 0;
		this.edgeCount = 0;
		this.lastSweepEdges = 0;
		this.weakOutSets.length = 0;
		this.weakOutList.length = 0;
		for (let i = 0; i < this.touched.length; i++) this.touched[i] = 0;
		for (const list of this.slotTouched) list.length = 0;
		// Dead-episode records drop before renumbering (§5.12): nothing from a
		// dead episode can validate in a live one; serial counters stay monotone.
		for (const [id, p] of this.passes) {
			if (p.state === 'ended') this.passes.delete(id);
		}
		for (const [id, t] of this.tokens) {
			if (t.state === 'retired') this.tokens.delete(id);
		}
		this.lastTokenId = 0;
		this.lastTokenRef = undefined;
		// Memo planes die by epoch; drop them eagerly (conservative refusal).
		for (const r of this.roots.values()) r.memos.clear();
		this.newestMemos.clear();
		// §5.12 kernel-pull refresh, AFTER the reset: a fresh newest evaluation
		// of each target re-records its cone into the NEW episode's K1 plane
		// (the cone-carry outcome, supplementary walk §6). World evaluations
		// reject writes, so the refresh cannot loop; a pull that throws keeps
		// its sentinel and stays on the demand path.
		for (const n of refreshTargets) {
			try {
				this.evaluate(n, NEWEST);
			} catch {
				// erroring getters keep their throw-on-demand behavior (§5.8)
			}
		}
		this.renumber();
		// Dead-episode bookkeeping zeroes (§5.4/§5.9: bulk-zero at episode reset).
		for (const s of this.slots) {
			s.writeClock = 0;
			s.claimSeq = 0;
			s.carriedMaxRetiredSeq = 0;
			s.releasePending = false;
		}
		for (const w of this.watchers.values()) w.dedupBits = 0;
		this.log({ type: 'epoch-reset', epoch: this.epoch });
		const tr = this.trace;
		if (tr !== undefined) tr.opEnd();
	}

	/**
	 * §5.12 renumber duty list — every retained sequence value rewritten in
	 * an order-preserving pass: base sequences, retirement stamps, the
	 * committed-advance counter, watcher snapshot pins. Tapes are empty at
	 * quiescence; archives belong to the dead episode and clear; memo
	 * planes were dropped (nothing retains a stale sequence).
	 */
	private renumber(): void {
		const retained = new Set<number>([0]);
		for (const n of this.nodes.values()) {
			if (n.kind !== 'atom') continue;
			retained.add(n.baseSeq);
			retained.add(n.retirementStamp);
		}
		retained.add(this.cas);
		for (const w of this.watchers.values()) retained.add(w.snapshot.pin);
		const sorted = [...retained].sort((a, b) => a - b);
		const map = new Map<number, number>();
		sorted.forEach((v, i) => map.set(v, i));
		const rw = (v: number): number => map.get(v)!;
		for (const n of this.nodes.values()) {
			if (n.kind !== 'atom') continue;
			n.baseSeq = rw(n.baseSeq);
			n.retirementStamp = rw(n.retirementStamp);
			n.archiveStore = []; // per-episode retention comparisons only
			n.origin = n.base;
		}
		this.cas = rw(this.cas);
		for (const w of this.watchers.values()) w.snapshot.pin = rw(w.snapshot.pin);
		this.seq = sorted.length; // restart the counter above the rewritten range (§5.12)
	}

	// ------------------------------------------------------------ helpers

	/** The value of a node in a named world (adapter/test surface). */
	read(node: AnyNode, world: World): Value {
		return this.evaluate(node, world);
	}

	committedValue(node: AnyNode, root: RootId): Value {
		return this.evaluate(node, { kind: 'committed', root });
	}

	newestValue(node: AnyNode): Value {
		return this.evaluate(node, NEWEST);
	}

	passValue(node: AnyNode, pass: Pass): Value {
		return this.evaluate(node, { kind: 'pass', pass });
	}

	eventsOfType<T extends BridgeEvent['type']>(type: T): Extract<BridgeEvent, { type: T }>[] {
		return this.events.filter((e): e is Extract<BridgeEvent, { type: T }> => e.type === type);
	}

	/** Events appended after a caller-captured watermark (absolute cursor; test/shim surface). */
	eventsSince(mark: number): BridgeEvent[] {
		return this.events.slice(Math.max(0, mark - this.eventsBase));
	}
}

// ---- the twin public surface -----------------------------------------------------
// The LOGGED entry re-exports the entire DIRECT API: application code imports
// one path or the other (spec §7 twin builds); only this entry can arm the
// bridge. `registerReactBridge`, the bridge class, and the bridge-surface
// types are the additions.

export * from './index.js';
