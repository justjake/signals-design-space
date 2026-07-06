/**
 * cosignal — the concurrent-worlds engine riding the KERNEL. The kernel is
 * the dependency-tracking engine (index.ts, whose header defines its terms): it
 * stores every signal, computed, effect, and dependency edge as fixed-size
 * integer records in shared arrays — and it holds exactly ONE current value
 * per atom. React's concurrent rendering needs several views of the state
 * to coexist (a paused background render must keep seeing the state it
 * started from while urgent updates land and commit — the README tells the
 * full story), so this module records every write and reconstructs the
 * other views on demand.
 *
 * ONE CORE: this module is internal machinery of the single `cosignal`
 * entry — index.ts imports and re-exports it, and nothing here runs until
 * `registerReactBridge()` attaches the bridge to the kernel through the
 * HOST SEAMS index.ts defines (`__setHostWrite` / `__setHostRead`): the
 * public Atom methods branch to the hooks below when (and only when) a
 * bridge is registered and, for reads, a routing context is live. A
 * never-registered process keeps the hooks undefined and this module inert
 * (tests/one-core.spec.ts asserts zero receipts/tokens/worlds/events under
 * heavy sync-only traffic).
 *
 * Vocabulary, in reading order (see also the package README):
 *
 *   - A RECEIPT records one write: the operation (set / functional update —
 *     a ReducerAtom dispatch records as an update whose closure captures
 *     the action), the batch it belongs to, and its position (`seq`) on
 *     one global timeline. Receipts append to the written atom's TAPE — the
 *     per-atom receipt log (class `Tape`). A FOLD replays, in timeline
 *     order, the receipts a given view may see over the atom's BASE (the
 *     permanent history, already collapsed to a single value); a WORLD is
 *     one self-consistent assignment of values to every atom, produced by
 *     such a fold. Ops are stored whole (not pre-folded) so updaters and
 *     reducers replay per world — which is why they must be pure (the
 *     FOLD-PURITY guard: signal reads/writes inside them throw).
 *   - A BATCH is the group of writes belonging to one UI update (one event
 *     handler, one transition, one async action); a TOKEN is a batch's
 *     identity record. React schedules each batch on one of its 31 LANES
 *     (a lane is React's internal unit of scheduling priority; work in one
 *     lane renders and commits together), so at most 31 batches are ever
 *     live at once. Each live batch that has written occupies a SLOT — one
 *     entry of a 31-entry recycling table — so "which batches affect X"
 *     fits in one 31-bit integer word (a SlotSet). INTERNING is claiming a
 *     free slot for a batch at its first write; the slot's current batch is
 *     its TENANT, and a released slot is recycled to the next claimant.
 *   - A PASS is one render pass of one root. Its PIN is the timeline
 *     position frozen at pass start — the pass folds nothing written after
 *     its pin, so a paused-and-resumed render never drifts. Its MASK is the
 *     set of live batches (and their slots) the pass is rendering.
 *   - RETIREMENT ends a batch: its receipts become permanent history
 *     visible to every world, and once no world can tell the difference
 *     they COMPACT — fold into the atom's base and are reclaimed. `cas` is
 *     the committed-advance counter, bumped whenever committed truth moves
 *     (a per-root commit, or a retirement that changed history).
 *   - A WATCHER is one subscribed component instance; a DELIVERY is the
 *     notification that schedules a watcher's re-render after a write.
 *     Deliveries are VALUE-BLIND: a delivery announces "a write in this
 *     batch may affect you", never a value — whether the value changed
 *     depends on the world doing the asking, so the receiving render folds
 *     its own world. A DRAIN is the sweep run when committed truth moves:
 *     re-check every observer the change could reach against committed
 *     state and correct the stale ones.
 *   - The engine keeps two dependency graphs. K0 is the kernel's own graph
 *     (the packed records in index.ts), which only knows newest values. K1
 *     is this module's overlay: a log of the dependency edges world
 *     evaluations ACTUALLY took, recorded as they are observed.
 *     Notification walks run over the K0∪K1 union. Per node, a TOUCHED word
 *     (one SlotSet) remembers which slots' live writes can reach it; bit 31
 *     is the TAINT bit — set when an untracked read observed pending state,
 *     conservatively poisoning the node's fast paths (untracked reads leave
 *     no edge, so the bit is the only trace).
 *   - A MEMO caches one node's value in one world, together with
 *     FINGERPRINTS — per-dependency version stamps (the highest receipt
 *     sequence the world can see for that dependency) — that tell whether
 *     the memo is still current. Each world keeps its memos in its own map,
 *     called that world's MEMO TABLE. The MEMO LADDER is
 *     evaluate()'s ordered chain of attempts, cheapest first: untouched
 *     fast path, then memo validation, then a fresh fold.
 *   - An EPISODE is the stretch between QUIESCENCE points — moments when
 *     nothing is in flight (no live batches, no open passes, no PARKED
 *     actions — async actions kept pending until their promise settles).
 *     At quiescence the K1 overlay bulk-resets, so edge logs never grow
 *     without bound. Sequence values are NEVER rewritten: the global
 *     counter climbs monotonically for the process's life (exact to
 *     2^53 — see the bound note at `quiesce`).
 *
 * What lives here (full stories at the implementation sites):
 *   - receipts: every write appends {op, slot, seq, retiredSeq} to the
 *     written atom's tape.
 *   - kernel riding: every logged write also applies to the kernel eagerly
 *     with stepwise equality (each step keeps the previous reference when
 *     the atom's equals function says nothing changed) — bridge atoms are
 *     kernel-backed `Atom` handles, and the newest world is read straight
 *     off the kernel. The engine-vs-reference-model diff verifies kernel
 *     value ≡ fold(base, receipts) at every step of the test corpus.
 *   - the K1 edge log: add-only within an episode, bulk-reset at
 *     quiescence. Delivery reachability runs over the episode-accumulated
 *     K0∪K1 union — deliveries are deliberately conservative (a superset is
 *     safe; deliveries are value-blind and the receiving render folds its
 *     own world).
 *   - worlds as pure folds with the two-clause visibility rule (see
 *     `visible`), the committed-for-root world, and the fast-forwarded
 *     mount-fixup world (see `mountFixup`).
 *   - per-write value-blind synchronous delivery in the writer's stack with
 *     pass-aware suppression, per-(watcher, slot) dedup, and dedup clear at
 *     slot re-intern.
 *   - the slot lifecycle: a retiring tenant stamps its receipts before its
 *     slot releases; a re-claimed slot gets a fresh claim sequence, and a
 *     pass's pin/seq checks always postdate the claim; release is deferred
 *     while any open render mask names the slot and re-evaluated at every
 *     pass end; disposal keeps conservative touched bits until no live pin
 *     can still need them; a loud release-anyway backstop prevents deadlock.
 *   - retirement ordering stamp → fold → drain → clear-rows → release, with
 *     pin-gated prefix compaction of tapes, and per-root commit lock-in (a
 *     root that committed UI from a still-live batch must keep agreeing
 *     with its own screen).
 *   - MOUNT FIXUP (see `mountFixup`): the commit-edge reconciliation for a
 *     freshly mounted component. A component can mount while other updates
 *     are in flight, and its subscription only activates at commit, so
 *     writes could slip by unobserved between its render and its commit;
 *     fixup joins it to the pending batches it missed and corrects
 *     committed drift before paint. Two subtle rules: the fast-path's
 *     write-clock check quantifies over the committing pass's member tokens
 *     at commit time (a token whose first write landed mid-render is
 *     invisible to the earlier-captured slot set), and any divergence the
 *     fast path suppresses must be exactly covered by the scheduled
 *     corrective re-renders (asserted on every mount).
 *   - subscriptions (see the Subscription type): ONE core record for both
 *     `run`-action consumer kinds. Newest-policy subscriptions observe the
 *     newest world and flush after the write's walk returns. Committed
 *     subscriptions — the PROMOTED production useSignalEffect mechanism —
 *     hold a dep snapshot captured by `captureRun` under committed-for-root
 *     and re-check value-gated at RCC-EF2's amended BOUNDARIES (per-root
 *     commit, retirement, settlement, quiet fold): once per boundary
 *     operation, at the boundary value, never while the subscription's own
 *     root has an open render-pass frame; cleanup guaranteed at removal.
 *     Their dep snapshots also join the RCC-OL1 observation union (one
 *     retain per snapshot node through the obsShift observation index).
 *   - episodes / quiescence (epoch reset), as defined above.
 *
 * The bridge surface consumes the external-runtime protocol's event shapes
 * (batch open/retire, pass begin/yield/resume/end with per-root commits,
 * settlements) — the events a patched React build emits about its own
 * scheduling. The React bindings (`cosignal-react`) drive it from a real
 * protocol build; the test suite drives it in lockstep with the reference
 * model (`cosignal-oracle`).
 *
 * Deliberately deferred, marked at each site:
 *   TODO(perf): route non-newest reads through a kernel fast path keyed on
 *     the touched word (serve the kernel cache when no pending batch touched
 *     anything feeding the node), instead of always consulting the memo
 *     ladder first; worth doing if world-read cost shows up in profiles of
 *     transition-heavy apps.
 */

import { Atom, SuspendedRead, __assertHostWritable, __hostApplySet, __hostReadNewest, __hostRunFold, __lifecycleRelease, __lifecycleRetain, __setHostRead, __setHostWrite, __HOST_MISS, type HostOpKind } from './index.js';

// ---- error carriers -------------------------------------------------------------

/**
 * An operation that is illegal in the engine's current state (a write into a
 * retired batch, a resume of a non-yielded pass, …). Schedule drivers — the
 * React bindings and the test harnesses simulating them — treat it as "this
 * call must not happen here", never as data corruption.
 */
export class BridgeScheduleError extends Error {}

/** An engine self-check failed — always a bug; never catch this. */
export class BridgeInvariantViolation extends Error {}

// ---- bridge-surface types (structurally mirror the reference model's) ------------

export type Value = unknown;
export type NodeId = number;
export type TokenId = number;
export type SlotId = number;
export type RootId = string;
export type PassId = number;
export type WatcherId = number;
export type EffectId = number;
/** A point on the one global sequence line (receipt seqs, pins, retirement
 * stamps, write clocks, the committed-advance counter). */
export type Seq = number;
/** Episode counter: bumped at quiescence when the overlay tables bulk-reset. */
export type Epoch = number;
/** A root's commit generation (bumped at every per-root commit). */
export type CommitGen = number;
/** A 31-bit slot set: bit i = slot i. In per-node touched words bit 31 is
 * the taint bit (see SlotBits). */
export type SlotSet = number;
/** A premultiplied kernel record id — already multiplied by the kernel's
 * record stride so it indexes the kernel's arrays directly (index.ts
 * vocabulary). The base kernel's node id currency (`Atom._id`); distinct
 * from the overlay's dense `NodeId`. */
export type KernelId = number;
/** Per-walk visited generation (walk termination without Set allocations). */
type WalkGen = number;
/** Top-level world-evaluation generation (per-world cycle detection marks). */
type EvalGen = number;

/** A write operation: set/update on atoms. A ReducerAtom dispatch records
 * as an update whose closure captures the reducer and the action. */
export type Op =
	| { kind: 'set'; value: Value }
	| { kind: 'update'; fn: (prev: Value) => Value };

/**
 * A receipt: one recorded write — {op, slot, seq} appended at the write,
 * retiredSeq stamped at the batch's retirement. Receipts denormalize their
 * slot at mint: slots are recycled identities, so visibility checks must read
 * the slot the write happened under, not the token's current slot (which may
 * already be released); the token id is carried for invariants and event
 * logs only. Receipts live int-packed in per-atom `Tape` columns ({kind,
 * slot, seq, retiredSeq, token} parallel number columns + one unknown[]
 * payload side column); this materialized object shape is the test/trace
 * surface (`Tape.materialize()`, trace `receipt` hook).
 */
export type Receipt = {
	op: Op;
	token: TokenId;
	slot: SlotId;
	seq: Seq;
	retiredSeq: Seq | undefined;
};

/** Op-kind tags for the packed receipt column. Same-file const enum so every
 * esbuild-based toolchain inlines the codes as literals. */
const enum OpKind {
	SET = 0,
	UPDATE = 1,
}

/**
 * Int-packed receipt columns: recording a write is a few integer stores, not
 * an object allocation. Plain number arrays stay SMI-packed (V8's fast
 * small-integer array representation) and grow in place; the arrays
 * themselves are the pool — no per-receipt objects ever exist on the hot
 * path.
 */
export class Tape {
	/** Live window: entries [start, n). Compaction advances `start`; the
	 * arrays rebase (fresh packed slices) only when the dead prefix crosses
	 * the amortization threshold — never a per-retirement memmove
	 * (shrink-in-place cycling drops V8 arrays into dictionary mode, its
	 * slow hash-map representation; measured at ~10µs per drop). */
	start = 0;
	n = 0;
	kinds: OpKind[] = [];
	slots: SlotId[] = [];
	seqs: Seq[] = [];
	/** 0 = unretired (sequences start at 1). */
	retired: Seq[] = [];
	tokens: TokenId[] = [];
	payloads: unknown[] = [];

	get length(): number {
		return this.n - this.start;
	}

	push(kind: OpKind, slot: SlotId, seq: Seq, token: TokenId, payload: unknown): void {
		probes.receipts++; // One Core probe (referee surface)
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
		if (k === OpKind.SET) return { kind: 'set', value: this.payloads[i] };
		return { kind: 'update', fn: this.payloads[i] as (prev: Value) => Value };
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

export class AtomNode {
	readonly kind = 'atom' as const;
	readonly id: NodeId;
	name: string;
	/** The folded floor of the tape: retired, compacted history every world sees. */
	base: Value;
	baseSeq: Seq = 0;
	/** Packed receipt columns (the engine truth; tests/diagnostics materialize
	 * them via `tp.materialize()`; the referee's model-shaped view lives in
	 * tests/model-view.ts). */
	tp = new Tape();
	equals: Equals;
	/** True iff `equals` is the default Object.is (write fast path). */
	eqIsDefault: boolean;
	/** Per-atom retirement stamp, minted at every retirement fold touching it
	 * (a retirement changes visibility without minting new receipts, so memo
	 * fingerprints must incorporate it). */
	retirementStamp: Seq = 0;
	/** The kernel-backed newest-world storage this overlay rides. */
	handle: Atom<Value>;
	/** Last token id that appended here (dedupe for token.atomsTouched). */
	lastTouchToken: TokenId = 0;

	constructor(id: NodeId, name: string, initial: Value, equals: Equals, eqIsDefault: boolean, handle: Atom<Value>) {
		this.id = id;
		this.name = name;
		this.base = initial;
		this.equals = equals;
		this.eqIsDefault = eqIsDefault;
		this.handle = handle;
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
	action: boolean;
	parked: boolean;
	state: 'live' | 'retired';
	committedFlag: boolean | undefined;
	slot: SlotId | undefined;
	retiredSeq: Seq | undefined;
	/** Sequence of this token's last receipt (0 = none). The mount fixup's
	 * fast-path clock check reads this per committing-pass member token,
	 * because a token whose first write landed mid-render has no slot in the
	 * pass's captured slot sets (see mountFixup). */
	lastWriteSeq: Seq;
	/** Atoms this token appended to (may hold benign duplicates; deduped at retirement). */
	atomsTouched: AtomNode[];
	/** Un-compacted receipts still on tapes. Receipts reference tokens by id,
	 * so the token record must outlive them (reclamation gate). */
	liveReceipts: number;
	ambient: boolean;
};

/** One world memo: value + evaluation seq + per-atom-dep fingerprints. */
export type WorldMemo = {
	value: Value;
	/** Evaluation/re-stamp sequence (ladder step 2 compares write clocks to it). */
	seq: Seq;
	/** Root commit generation at (re-)stamp (committed worlds only). */
	gen: CommitGen;
	epoch: Epoch;
	/** seq value at last validation (any state change mints a seq — cheap dedup). */
	checkedOp: Seq;
	/** Re-entrancy guard: stale cross-linked dep lists must refuse, not recurse. */
	validating: boolean;
	/** Direct atom deps (recorded during evaluation) + their fingerprints. */
	atoms: AtomNode[];
	fps: Seq[];
	/** Direct computed deps + the values they had (identity revalidation). */
	comps: ComputedNode[];
	compValues: Value[];
};

/** One entry of the 31-slot recycling table a written batch occupies (see
 * the header's SLOT/INTERN/TENANT definitions). */
export type SlotMeta = {
	id: SlotId;
	tenant: TokenId | undefined;
	/** Claim sequence — a point on the shared timeline minted at every
	 * intern (the mint itself is load-bearing for model parity: both sides
	 * spend one sequence per claim). The engine never reads the stored
	 * value; the oracle's `checkInvariants` tenancy orderings consult it
	 * through the test-side model view. */
	claimSeq: Seq;
	/** Sequence of the last write under this slot; zeroed when a new tenant
	 * claims it (memo validation compares it against evaluation stamps). */
	writeClock: Seq;
	/** Dirt watermark carried across tenants: touched bits for this slot may
	 * only be cleared once every live pin postdates this retirement. */
	carriedMaxRetiredSeq: Seq;
	releasePending: boolean;
};

export type PassState = 'open' | 'yielded' | 'ended';

export type Pass = {
	id: PassId;
	root: RootId;
	/** The pin — the timeline position frozen at pass start; observed for the
	 * pass's whole life, across yields, so a paused-and-resumed render never
	 * drifts. */
	pin: Seq;
	maskTokens: Set<TokenId>;
	maskSlots: Set<SlotId>;
	capturedCommittedSlots: Set<SlotId>;
	/** Bit forms of the slot sets (SlotId < 31), fixed at pass start. */
	maskBits: SlotSet;
	includedBits: SlotSet;
	state: PassState;
	endKind: 'commit' | 'discard' | undefined;
	mounted: WatcherId[];
	rendered: Set<WatcherId>;
	/** Pass-world memo table — dies with the pass record. */
	memos: Map<NodeId, WorldMemo>;
};

export type RootState = {
	id: RootId;
	/** Per-root lock-in rows: batches this root has committed but that are
	 * still live elsewhere (cleared at retirement, when the retired clause
	 * subsumes membership). */
	committedTokens: Set<TokenId>;
	commitGen: CommitGen;
	/** Bit form of committedSlotsNow (maintained at commit/retire). */
	committedBits: SlotSet;
	/** Member slots written since the last drain. A write into a slot that is
	 * already a committed member changes committed truth immediately, so the
	 * next durable drain must reconcile everything downstream of it (the
	 * reference model's full observer scan catches this at any
	 * retirement/commit; the engine keeps the precise dirty set instead). */
	committedDirtySlots: SlotSet;
	/** Committed-for-root memo table (re-keyed by commitGen). */
	memos: Map<NodeId, WorldMemo>;
};

/** The watcher's rendered-world snapshot: what the mounting render saw. */
export type WatcherSnapshot = {
	passId: PassId;
	pin: Seq;
	maskSlots: Set<SlotId>;
	includedSlots: Set<SlotId>;
	rootCommitGen: CommitGen;
};

export class Watcher {
	readonly id: WatcherId;
	name: string;
	readonly root: RootId;
	readonly node: NodeId;
	/** The owning bridge's observed-closure shift (see obsShift): the `live`
	 * setter feeds the watched node's observed-consumer refcount through it,
	 * and the bridge propagates retains transitively over the node's current
	 * strong dep set down to lifecycle-registered atoms. @internal */
	readonly _obs: (node: NodeId, delta: 1 | -1) => void;
	private _live = false;
	lastRenderedValue: Value;
	snapshot: WatcherSnapshot;
	/** Per-(watcher, slot) delivery dedup bits, one int word: a second write
	 * in the same slot delivers again only if no scheduled-but-unstarted
	 * render will fold it anyway. */
	dedupBits: SlotSet = 0;

	constructor(id: WatcherId, name: string, root: RootId, node: NodeId, obs: (node: NodeId, delta: 1 | -1) => void, value: Value, snapshot: WatcherSnapshot) {
		this.id = id;
		this.name = name;
		this.root = root;
		this.node = node;
		this._obs = obs;
		this.lastRenderedValue = value;
		this.snapshot = snapshot;
	}

	/**
	 * Subscribed-for-delivery bit. The setter is the watcher half of the
	 * observation union (AtomOptions.effect): a live watcher holds one
	 * observed-consumer ref on its node, and the bridge's observation
	 * index (obsShift) carries that ref transitively — a watcher over an
	 * atom node retains that atom's lifecycle directly; a watcher over an
	 * overlay computed retains every atom the computed's current evaluation
	 * (transitively) reads. EVERY liveness site routes through here — the
	 * commit layout loop and adoptMount reveals (engine side), and the
	 * reveal resubscribe / StrictMode orphan sweep / debounce-finalized
	 * unsubscribe (shim side, which flips this field directly) — so kernel
	 * subscribers and bridge watchers count into ONE refcount, and same-tick
	 * flips coalesce in the kernel's microtask flush. Edge-filtered:
	 * re-asserting the current state is a no-op.
	 */
	get live(): boolean {
		return this._live;
	}
	set live(value: boolean) {
		if (value === this._live) {
			return;
		}
		this._live = value;
		this._obs(this.node, value ? 1 : -1);
	}
}

/**
 * The ONE core `run`-action subscription record (effects unification by
 * promotion, plans/2026-07-06). A subscription is a registration saying WHO
 * is notified and IN WHICH WORLD its reads resolve; `deliver`-action
 * consumers (component re-renders) remain `Watcher` structurally — their
 * state is untouched, the unification is of the firing machinery — so this
 * record carries the two `run` configurations:
 *
 *  - policy 'committed' — the PROMOTED production `useSignalEffect`
 *    mechanism (previously the adapter's EffectRec): `deps` is the
 *    (node, value) snapshot `captureRun` recorded under the committed world
 *    of the subscription's root; re-checks are value-gated over it and fire
 *    at RCC-EF2's amended BOUNDARIES (per-root commit, retirement,
 *    settlement, quiet fold; one re-check per boundary operation, at the
 *    boundary value, never while the subscription's own root has an open
 *    render-pass frame — deferred flips flush at that frame's close).
 *    `refire` (adapter-registered) rides the operation-boundary notification
 *    queue; referee-configured subscriptions (`mountReactEffect`/
 *    `mountReactEffectPick`) store a `body` and re-run it inline through the
 *    SAME capture frame, so lockstep referees the real mechanism.
 *  - policy 'newest' — the absorbed core-effect configuration: one `node`,
 *    value-gated on its newest value, enqueued by the delivery walk and
 *    flushed after the walk returns.
 */
export type Subscription = {
	id: EffectId;
	name: string;
	policy: 'committed' | 'newest';
	/** Owning root (committed policy; '' for newest). */
	root: RootId;
	/** Subscribed node (newest policy; 0 for committed — `deps` carry nodes). */
	node: NodeId;
	/** Dep snapshot: the routed reads of the last run, in read order. */
	deps: { node: AnyNode; value: Value }[];
	/** Adapter-owned refire (cleanup + body scheduling), queued at the
	 * operation boundary; undefined for referee-configured subscriptions. */
	refire: (() => void) | undefined;
	/** Referee-configured body (re-run inline through the capture frame). */
	body: (() => void) | undefined;
	/** Last captured value (committed: the last dep read; newest: the node). */
	lastValue: Value;
	runs: number;
	cleanups: number;
	/** Delivery-walk enqueue dedup generation (newest policy). */
	queuedWalk: WalkGen;
	live: boolean;
	/** RCC-OL1: snapshot nodes currently holding observation retains
	 * (re-pointed per run exactly like watcher obsDeps; see obsShift). */
	obsDeps: Set<NodeId> | undefined;
};

/** A world: one self-consistent assignment of values to all atoms, computed
 * by replaying exactly the receipts that world may see, in timeline order. */
export type World =
	| { kind: 'newest' }
	| { kind: 'pass'; pass: Pass }
	| { kind: 'committed'; root: RootId }
	| { kind: 'mountFix'; maskSlots: Set<SlotId>; pin: Seq; root: RootId; excludeLiveTokens?: Set<TokenId> };

/** The one newest-world singleton (hot paths never allocate world objects). */
const NEWEST: World = { kind: 'newest' };
/** Bit constants for slot bit-sets (mask/included/committed/dedup words) and
 * per-node touched words: bit i (0–30) = slot i; in touched words bit 31 is
 * the taint bit. Same-file const enum so the masks inline as literals. */
const enum SlotBits {
	/** Mask of all 31 slot bits (bits 0–30): strips the taint bit from a touched word. */
	SLOT_MASK = 0x7fffffff,
	/** The taint bit (bit 31): an untracked read of pending state poisoned the node. */
	TAINT = -2147483648, // 1 << 31
	/** (bits >>> slot) & LOW_BIT isolates the addressed slot's bit. */
	LOW_BIT = 1,
	/** MSB_INDEX − clz32(isolated bit) = the bit's index (31 = an int32's top bit position). */
	MSB_INDEX = 31,
}

/** The observable event stream (same shapes as the reference model's events,
 * so the two can be compared entry by entry). */
export type BridgeEvent =
	| { type: 'write'; node: string; token: TokenId; slot: SlotId; seq: Seq }
	| { type: 'write-dropped'; node: string; token: TokenId }
	| { type: 'delivery'; watcher: string; token: TokenId; slot: SlotId; seq: Seq; mode: 'fresh' | 'interleaved' }
	| { type: 'suppressed'; watcher: string; token: TokenId; slot: SlotId; seq: Seq }
	| { type: 'core-effect-run'; effect: string; value: Value }
	| { type: 'react-effect-run'; effect: string; root: RootId; value: Value; values: Value[] }
	| { type: 'react-effect-cleanup'; effect: string; root: RootId }
	| { type: 'reconcile-correction'; watcher: string; root: RootId; from: Value; to: Value; cause: 'retirement' | 'per-root-commit' }
	| { type: 'mount-corrective'; watcher: string; token: TokenId; slot: SlotId }
	| { type: 'mount-urgent-correction'; watcher: string; from: Value; to: Value }
	| { type: 'per-root-commit'; root: RootId; token: TokenId }
	| { type: 'retired'; token: TokenId; committed: boolean; retiredSeq: Seq }
	| { type: 'slot-claimed'; slot: SlotId; token: TokenId }
	| { type: 'slot-released'; slot: SlotId; token: TokenId }
	| { type: 'slot-backstop-released'; slot: SlotId; token: TokenId }
	| { type: 'pass-committed'; pass: PassId; root: RootId }
	| { type: 'pass-discarded'; pass: PassId; root: RootId }
	| { type: 'epoch-reset'; epoch: Epoch };

/**
 * The trace seam. The concurrent engine's semantic events flow to an OPTIONAL
 * hook object held in `CosignalBridge.trace` — `undefined` unless
 * `cosignal/trace` (a lazily loaded, runtime-import-free entry) has attached
 * a recorder. Discipline, asserted by tests/trace-off.spec.ts:
 *
 *  - this module NEVER imports the trace module (the module graph gains
 *    tracing only when the app imports `cosignal/trace`);
 *  - every hook site is guarded by exactly one nullable-slot check
 *    (`const tr = this.trace; if (tr !== undefined) ...`) — that one check
 *    is the entire cost when no tracer is attached;
 *  - hooks receive the engine's own live objects and integers; they must not
 *    mutate them, and the recorder must not allocate per event.
 *
 * Two channels: `event(e)` re-uses the always-allocated BridgeEvent stream at
 * its single `log()` waist (receipts/deliveries/retirements/commits/slots/
 * corrections/effects), and dedicated hooks cover semantics that stream does
 * not carry: batch open/settle, pass start/yield/resume/end (fired BEFORE
 * the end's consequences, unlike the pass-committed event), per-receipt ops,
 * world evaluations, deferred slot release, and the mount fixup disposition
 * (fast-out vs compare vs correction). `opEnd()` marks the close of each
 * compound public operation so the recorder can scope causality (see
 * trace.ts `CAUSE`).
 */
export type TraceHooks = {
	/** Every BridgeEvent, from the one `log()` waist. */
	event(e: BridgeEvent): void;
	/** A receipt was minted (fires with the 'write' event; carries the op). */
	receipt(node: AtomNode, r: Receipt): void;
	/** A batch token was minted. */
	batchOpen(t: Token): void;
	/** An async-action token settled (its retirement follows). */
	batchSettle(t: Token, committed: boolean): void;
	/** Pass edges (end fires before retirements/commits/fixups). */
	passStart(p: Pass): void;
	passYield(p: Pass): void;
	passResume(p: Pass): void;
	passEnd(p: Pass, kind: 'commit' | 'discard'): void;
	/** A computed evaluation in a world opened/closed (paired; end fires on throw too). */
	evalStart(node: ComputedNode, world: World): void;
	evalEnd(): void;
	/** A retired tenant's release was deferred (an open render mask names the slot). */
	slotReleaseDeferred(slot: SlotId, token: TokenId): void;
	/** One per mount: how fixup resolved, and how many correctives were scheduled. */
	mountFixup(
		w: Watcher,
		disposition: 'fast-out' | 'fast-out-covered' | 'compare-clean' | 'corrected',
		correctives: number,
	): void;
	/** A compound public operation (write / passEnd / retire / settle / quiesce) finished. */
	opEnd(): void;
};

const SLOT_COUNT = 31; // at most 31 live batches — one per React lane, and slot sets fit one int bit mask.

// ---- module state + the logged operation table ----------------------------------

/** The bridge whose registered atoms the host hooks route for (one active). */
let activeBridge: CosignalBridge | undefined;
/** True while the bridge itself is applying a logged write to the kernel
 * (the host write hook's recursion guard: the apply re-enters `Atom.set`). */
let bridgeApplying = false;
/** The public registerReactBridge() has been consumed (it may run only once). */
let publiclyRegistered = false;

// ---- One Core probes (referee surface) --------------------------------------------
// One module-wide counter record proving the zero-cost promise behaviorally:
// with no bridge registered, heavy signal traffic must leave every field at
// its baseline (tests/one-core.spec.ts). Engine logic never reads them.
const probes = { receipts: 0, tokens: 0, worldEvals: 0, bridgeEvents: 0, bridges: 0 };

/** Referee surface — a snapshot of the engine-activity counters for the zero-cost test. @internal */
export function __coreProbes(): { receipts: number; tokens: number; worldEvals: number; bridgeEvents: number; bridges: number } {
	return { ...probes };
}

// ---- the host-hook implementations (installed into index.ts's public methods) -----

/** Rebuild an Op from the public method's scalar (kind, payload) pair. */
function opOf(kind: HostOpKind, payload: unknown): Op {
	if (kind === 0) return { kind: 'set', value: payload };
	return { kind: 'update', fn: payload as (prev: Value) => Value };
}

/**
 * The host write interceptor: a public write is attributable to a batch when
 * a bridge is registered and the write is not the bridge's own kernel apply.
 * The bindings' classifier (when installed) owns classification — batch
 * context, adoption-on-first-write, render guard; without bindings, writes to
 * REGISTERED atoms classify into the ambient default batch and everything
 * else takes the plain kernel path.
 */
function hostWriteImpl(atom: Atom<unknown>, kind: HostOpKind, payload: unknown): boolean {
	const b = activeBridge;
	if (b === undefined || bridgeApplying) {
		return false; // no host / the host's own kernel apply: plain path
	}
	// Policy first, capture second: a write the policy layer rejects
	// (forbidWritesInComputeds) must throw BEFORE any receipt can land.
	__assertHostWritable();
	const classify = b.writeClassifier;
	if (classify !== undefined) {
		classify(atom, opOf(kind, payload));
		return true;
	}
	const node = b.nodeFor(atom); // the ONE stamp-validate + registry-probe rule
	if (node === undefined) {
		return false; // unregistered and no adopter: exactly base semantics
	}
	if (b.quiet) {
		// Quiet mode: nothing is pending, so the whole write is one fold —
		// no Op object, no ambient batch, no receipt, no walk (Phase 1b).
		// HostOpKind and OpKind share the 0/1 encoding by construction.
		b.__quietWrite(node, kind as number as OpKind, payload);
		return true;
	}
	b.bareWrite(node, opOf(kind, payload));
	return true;
}

/** The host read router (armed only while a routing context is live). */
function hostReadImpl(atom: Atom<unknown>): unknown {
	return activeBridge === undefined ? __HOST_MISS : activeBridge.hostRead(atom);
}

/**
 * Activates the concurrent engine: arms the kernel's host seams
 * (`__setHostWrite` / read routing), exactly once per process, and returns
 * the bridge that the React bindings (or a test driver simulating them)
 * drive with protocol events. Throws inside any open evaluation/fold frame
 * (the seams must not arm under a live kernel frame) and on
 * re-registration.
 */
export function registerReactBridge(): CosignalBridge {
	if (publiclyRegistered) {
		throw new Error('cosignal: registerReactBridge may only be called once per process.');
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
	const b = new CosignalBridge();
	b.setRetainEvents(true); // the referee/tests read the event log; production bridges keep it off
	// REFEREE MODE: the oracle models always-receipt semantics, so test/lockstep
	// bridges run with the quiet-mode short-circuit disabled (production
	// bridges from registerReactBridge() default it ON). The dedicated
	// quiet-mode suite re-enables it explicitly.
	b.setQuietWrites(false);
	return b;
}

// ---- the bridge -----------------------------------------------------------------

/**
 * The concurrent-worlds engine. Method-for-method it exposes the surface the
 * external-runtime protocol drives (batches, passes, commits, retirements) —
 * the same surface the reference model (`cosignal-oracle`) implements, so the
 * two can run any schedule in lockstep. The kernel integration points are:
 * `AtomNode.handle` (kernel-backed newest storage, eager stepwise apply on
 * every logged write) and the module-level logged table (public-write
 * classification + world read routing).
 *
 * Referee surface: the twin tests run the oracle's `checkInvariants` /
 * `snapshotModel` against a MODEL VIEW of this class (tests/model-view.ts)
 * that materializes the model's shape — tapes, archives, origins, dedup
 * sets — from packed engine state plus a driver-side mirror fed by the
 * `onCompact` hook, so the production class carries no mirror members. The
 * few remaining "Referee surface" tags mark counters/knobs the engine
 * mints but never reads.
 */
export class CosignalBridge {
	nodes = new Map<NodeId, AnyNode>();
	tokens = new Map<TokenId, Token>();
	slots: SlotMeta[] = [];
	passes = new Map<PassId, Pass>();
	roots = new Map<RootId, RootState>();
	watchers = new Map<WatcherId, Watcher>();
	/** ONE subscription store for both `run` policies (committed committed-
	 * observer scans filter by policy; newest ones also live in subsByNode). */
	subs = new Map<EffectId, Subscription>();
	/** The retained BridgeEvent log. Populated only while a referee retains
	 * events (`setRetainEvents(true)`); a tracer attached without a referee
	 * mints events but consumes them live at the `log()` waist, retaining
	 * nothing here (fixed memory — the tracer's ring/session buffers hold the
	 * capture). */
	events: BridgeEvent[] = [];

	/**
	 * The trace recorder slot. `undefined` (the permanent state unless
	 * `cosignal/trace` attaches): every site pays one check, nothing else.
	 * Assigned only by `attachTracer`/`Tracer.stop` over there; the accessor
	 * keeps `eventsOn` in sync (a live tracer consumes the event stream, so
	 * events must mint while one is attached — consumed at the `log()` waist,
	 * never retained on the tracer's behalf).
	 */
	private _trace: TraceHooks | undefined = undefined;
	get trace(): TraceHooks | undefined {
		return this._trace;
	}
	set trace(v: TraceHooks | undefined) {
		this._trace = v;
		this.eventsOn = this._retainEvents || v !== undefined;
		this.recomputeQuiet(); // an event consumer (dis)arms quiet mode
	}

	/**
	 * EVENT MINTING GATE. The BridgeEvent log is the referee/tracing surface
	 * (oracle lockstep comparisons, tests, devtools); the bindings consume
	 * direct listeners instead (below). Nothing consuming the log means no
	 * event objects mint at all — this was the measured one-object-per-write
	 * allocation floor. True while a referee retains events or a tracer is
	 * attached; every `log()` call site is gated on it.
	 */
	eventsOn = false;
	private _retainEvents = false;

	/** Referee surface — retain the BridgeEvent log (tests/diagnostics). */
	setRetainEvents(on: boolean): void {
		this._retainEvents = on;
		this.eventsOn = on || this._trace !== undefined;
		this.recomputeQuiet(); // an event consumer (dis)arms quiet mode
	}

	// ---- direct listeners (the bindings' consumption surface; no allocation) ----
	// Listener callbacks are DELIVERED AT THE OPERATION BOUNDARY — queued into
	// reusable columns during the walk and invoked after the public operation's
	// own mutations complete (the same timing the bindings' old post-op event
	// drain had), so a listener can never re-enter a half-finished operation.
	/** A value-blind delivery reached a live watcher (fresh or interleaved). */
	onDelivery: ((w: Watcher, token: Token, slot: SlotId) => void) | undefined;
	/** Mount fixup scheduled a corrective re-render into a live batch's lane. */
	onMountCorrective: ((w: Watcher, token: Token, slot: SlotId) => void) | undefined;
	/** An urgent pre-paint correction (mount window / committed-truth drift). */
	onCorrection: ((w: Watcher) => void) | undefined;

	// Queued-notification columns (reused across operations; no per-notify objects).
	private notifyKinds: number[] = []; // 0 delivery, 1 mount-corrective, 2 correction, 3 subscription refire
	private notifyWs: (Watcher | undefined)[] = [];
	private notifyTs: (Token | undefined)[] = [];
	private notifySlots: SlotId[] = [];
	private notifySubs: (Subscription | undefined)[] = [];
	private notifyN = 0;
	private notifyFlushing = false;

	private queueNotify(kind: number, w: Watcher | undefined, t: Token | undefined, slot: SlotId, sub?: Subscription): void {
		const i = this.notifyN++;
		this.notifyKinds[i] = kind;
		this.notifyWs[i] = w;
		this.notifyTs[i] = t;
		this.notifySlots[i] = slot;
		this.notifySubs[i] = sub;
	}

	/** Invokes queued listeners at the end of the public operation. A nested
	 * public operation started BY a listener appends behind the live bound
	 * and drains in the same sweep (the flushing flag stops nested sweeps). */
	private flushNotify(): void {
		if (this.notifyN === 0 || this.notifyFlushing) return;
		this.notifyFlushing = true;
		try {
			for (let i = 0; i < this.notifyN; i++) {
				const kind = this.notifyKinds[i]!;
				const w = this.notifyWs[i];
				const t = this.notifyTs[i];
				const s = this.notifySubs[i];
				this.notifyWs[i] = undefined; // release object refs eagerly
				this.notifyTs[i] = undefined;
				this.notifySubs[i] = undefined;
				if (kind === 0) {
					const l = this.onDelivery;
					if (l !== undefined) l(w!, t!, this.notifySlots[i]!);
				} else if (kind === 1) {
					const l = this.onMountCorrective;
					if (l !== undefined) l(w!, t!, this.notifySlots[i]!);
				} else if (kind === 2) {
					const l = this.onCorrection;
					if (l !== undefined) l(w!);
				} else if (s !== undefined && s.live) {
					// Subscription refire (adapter-registered): the value gate
					// already passed at the boundary scan; the adapter owns the
					// body run (cleanup + fire + re-capture) and any React-phase
					// deferral. Removal flips `live`, so nothing runs after
					// teardown (RCC-OL2).
					const r = s.refire;
					if (r !== undefined) r();
				}
			}
		} finally {
			this.notifyN = 0;
			this.notifyFlushing = false;
		}
	}

	/** Direct (base-like) until registerBridge(); direct writes leave no receipts. */
	mode: 'direct' | 'logged' = 'direct';
	/** The one global sequence line every receipt/pin/stamp is a point on. */
	seq: Seq = 0;
	/** Committed-advance counter, in sequence units: bumped whenever committed
	 * truth moves (per-root commit, or a retirement that changed history). */
	cas: Seq = 0;
	/** Episode counter; bumped at quiescence when the overlay tables bulk-reset. */
	epoch: Epoch = 0;

	// ---- the K1 union graph + the touched word ----
	/** K1 out-edge membership per dep node id (dedupe for recordEdge). */
	private outSets: (Set<NodeId> | undefined)[] = [];
	/** K1 out-edge adjacency (iteration order = record order). */
	private outList: (NodeId[] | undefined)[] = [];
	/** Reverse adjacency (mount-fixup dependency closures). */
	private inList: (NodeId[] | undefined)[] = [];
	/** The touched word per node: bits 0–30 = "a live write in this slot can
	 * reach this node", bit 31 = taint (an untracked read of pending state —
	 * conservatively poisons the fast paths). */
	private touched: SlotSet[] = [0];
	/** Per-walk visited generation column (walk termination without Sets). */
	private lastWalk: WalkGen[] = [0];
	private walkGen: WalkGen = 0;
	/** Per-slot touched lists (node ids). "Dirt" = a slot's conservative
	 * touched bits and lists; the KEEP-THE-DIRT discipline (referenced
	 * wherever dirt could be cleared): dirt may only be cleared once it is
	 * provably irrelevant to every live pin — some paused render may still
	 * depend on the conservative coverage. */
	private slotTouched: NodeId[][] = [];
	/** Nodes by id (dense array twin of `nodes`). */
	private nodesArr: (AnyNode | undefined)[] = [undefined];
	// ---- the observed closure (transitive observation retains) ----
	// A node is OBSERVED while a live watcher consumes it — directly, or
	// transitively through the strong (tracked) dep edges of observed overlay
	// computeds. Observed ATOMS hold exactly one retain on the kernel's
	// observed-lifecycle union (AtomOptions.effect); the kernel's
	// lifecycleShift is a Map-miss no-op for atoms without the option, and
	// these shifts fire only at closure-membership EDGES (never per
	// evaluation), so routing every closure atom through it costs nothing
	// measurable and needs no second has-lifecycle registry here. Unlike the
	// K1 edge log (add-only within an episode, bulk-reset at quiescence),
	// obsDeps snapshots follow the CURRENT edge set — each fn re-run of an
	// observed computed re-points its retains (dep flips move them; the
	// kernel's microtask flush coalesces same-tick flaps) — and the observation index
	// deliberately survives quiescence: the closure is a property of live
	// watchers, not of the episode, so an observed atom sees no
	// unobserve/reobserve flap across the K1 bulk-reset.
	/** Observed-consumer refcount per node id: +1 per live watcher on the
	 * node, +1 per observed computed currently holding it in obsDeps. */
	private obsRefs: number[] = [0];
	/** Per OBSERVED computed: the retained direct strong-dep set as of its
	 * last fn run (undefined while unobserved — unwatched nodes store nothing). */
	private obsDeps: (Set<NodeId> | undefined)[] = [];
	/** Strong-dep capture list of the innermost evaluation frame, undefined
	 * unless that frame's node is observed — the one field unwatched
	 * evaluations pay for (a check per recorded edge). */
	private obsCapture: NodeId[] | undefined = undefined;
	/** The watcher liveness seam (one closure per bridge; Watcher._obs). */
	private watcherObs = (node: NodeId, delta: 1 | -1): void => this.obsShift(node, delta);
	private watchersByNode: (Watcher[] | undefined)[] = [];
	/** Per-node index of NEWEST-policy subscriptions (delivery-walk collection).
	 * Committed-policy subscriptions have no single index key — their re-check
	 * is a per-root value-gated full scan (v1 = production semantics), so the
	 * collection structures are honestly: this index + the `subs` store
	 * scanned per root (plan review M4's restatement). */
	private subsByNode: (Subscription[] | undefined)[] = [];
	/** Per-node count of committed-subscription dep snapshots holding the
	 * node: K1 sweep reachability seeds and quiescence refresh targets — the
	 * snapshot re-check evaluates through the memo ladder, whose touched-word
	 * fast path relies on marks reaching these nodes. */
	private subDepRefs: number[] = [0];
	/** Live counts per policy (fast bails on the write/quiet paths). */
	private committedSubCount = 0;
	private newestSubCount = 0;
	/** The core capture frame `captureRun` opens: while set (and no evaluation
	 * world is on stack) routed reads resolve committed-for-root and append to
	 * the dep snapshot. Replaces the adapter's effectCapture + readObserver
	 * seam + the world provider's committed arm (plan §2.2.2). */
	private captureFrame: { sub: Subscription; deps: { node: AnyNode; value: Value }[] } | undefined = undefined;
	/** Per-write newest-subscription queue (flushed after the delivery walk returns). */
	private effectQueue: Subscription[] = [];
	/** Atoms with a non-empty tape (compaction candidates). */
	private dirtyAtoms = new Set<AtomNode>();
	/** The one open (non-ended) pass per root — React renders one tree per
	 * root at a time; a same-root restart is a new pass. */
	private openPassByRoot = new Map<RootId, Pass>();
	private liveTokenCount = 0;
	/** Last-token cache (windowed writes hit one token repeatedly). */
	private lastTokenId = 0;
	private lastTokenRef: Token | undefined = undefined;
	/** Optional compaction observer (referee/diagnostics seam): called once
	 * per receipt as it folds into base and leaves the tape. The oracle's
	 * retention invariant needs the full history; its archive mirror lives
	 * OUTSIDE the engine (tests/model-view.ts), fed by this hook — keeping
	 * every compacted receipt in-engine would grow without bound. Production
	 * bridges leave it undefined and retain nothing. */
	onCompact: ((atom: AtomNode, entry: Receipt) => void) | undefined = undefined;

	// ---- quiet mode (Phase 1b) --------------------------------------------------
	/**
	 * The quiet-mode SEMANTIC switch (production default ON). While the
	 * bridge is QUIET — nothing pending: no live batch token, no open render
	 * pass, every tape compacted — an unclassified write to a registered atom
	 * FOLDS DIRECTLY: committed base and the kernel advance together and no
	 * receipt, tape append, token, delivery walk, or bridge event is minted.
	 * The concurrency pipeline arms only while something is actually pending;
	 * a transition that starts later begins from committed base, which the
	 * folds already advanced — there is no history to reconstruct.
	 *
	 * Referee surface: the oracle models always-receipt semantics, so
	 * lockstep/twin drivers run the engine with this OFF (see
	 * `__newBridgeForTest`) and the dedicated quiet-mode suite polices the
	 * short-circuit directly (tests/quiet-mode.spec.ts).
	 */
	quietWrites = true;
	/**
	 * The ARMED quiet state — the one boolean the write path branches on,
	 * recomputed only at state transitions (batch open/retire, pass
	 * start/end, registration, event-retention/tracer changes): quiet ⇔
	 * quietWrites AND logged AND zero live tokens AND zero open passes AND
	 * every tape compacted AND no event consumer. Event consumers (a referee
	 * retaining the log, an attached tracer) disarm quiet so their streams
	 * stay complete — production apps have neither.
	 * @internal — read by the module-level host write hook; treat as private.
	 */
	quiet = false;

	/** Referee surface — disables/enables the quiet-mode short-circuit (production defaults ON; lockstep drivers run with it OFF). */
	setQuietWrites(on: boolean): void {
		this.quietWrites = on;
		this.recomputeQuiet();
	}

	private recomputeQuiet(): void {
		this.quiet =
			this.quietWrites
			&& this.mode === 'logged'
			&& this.liveTokenCount === 0
			&& this.openPassByRoot.size === 0
			&& this.dirtyAtoms.size === 0
			&& !this.eventsOn;
	}
	/** Event-stream base offset (0 unless a capacity cap drops old events). */
	private eventsBase = 0;
	/** Optional event-stream capacity: oldest events drop past ~2× this. */
	private eventCapacity: number | undefined = undefined;

	/**
	 * Referee surface — not consulted by engine logic. The K1 union table as
	 * dep → dependents, materialized from the adjacency columns; read by:
	 * graphviz, twin tests, soak metrics.
	 */
	get episodeEdges(): Map<NodeId, Set<NodeId>> {
		const out = new Map<NodeId, Set<NodeId>>();
		for (let id = 0; id < this.outList.length; id++) {
			const l = this.outList[id];
			if (l !== undefined && l.length > 0) out.set(id, new Set(l));
		}
		return out;
	}

	/** Ambient default batch for bare (context-free) writes. */
	ambientToken: TokenId | undefined;

	/** Registered kernel-backed atoms, by kernel record id (logged-table routing). */
	byKernelId = new Map<KernelId, AtomNode>();
	/** The world an overlay evaluation frame is folding in (logged-table read routing). */
	activeWorld: World | undefined;
	/**
	 * The bindings' ambient-world provider: consulted per routed read when no
	 * evaluation world is on stack, and answers from the LIVE call context —
	 * the pass world of the render actually running on the current stack, the
	 * committed world of an effect fire — or undefined for "route newest".
	 * A callback (not a start-to-end flag) deliberately: a pass that has
	 * COMPLETED but not yet committed is not "in render" (the protocol's
	 * render context is null there), so outside-render reads in that window
	 * must resolve newest, and interleaved multi-root renders must each see
	 * their own pass.
	 */
	private worldProvider: (() => World | undefined) | undefined;

	/** Installs/clears the ambient-world provider (bindings seam). */
	setWorldProvider(provider: (() => World | undefined) | undefined): void {
		this.worldProvider = provider;
		this.syncReadRouting();
	}

	// ---- bindings seams (ordinary public slots the React shim assigns) ----
	/**
	 * Write classification for host-attributable public writes. When set, it
	 * owns the WHOLE op (adoption on first write, batch context, render
	 * guard) — received already rebuilt as an `Op`, so exactly one
	 * (kind, payload) → Op site exists (the host seam's `opOf`); when unset,
	 * registered atoms classify into the ambient batch.
	 */
	writeClassifier: ((atom: Atom<unknown>, op: Op) => void) | undefined;
	/** Adopt-on-demand for routed reads of not-yet-registered atoms. */
	readAdopter: ((atom: Atom<unknown>) => AtomNode) | undefined;

	private nextNode = 1;
	private nextToken = 1;
	private nextPass = 1;
	private nextWatcher = 1;
	private nextEffect = 1;

	/** >0 while a world evaluation is on stack (renders must not write). */
	private evalDepth = 0;
	/** True inside an updater/reducer/equals callback (reads+writes throw). */
	inFoldCallback = false;

	constructor() {
		probes.bridges++; // One Core probe (referee surface)
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

	/** Central activeWorld setter — keeps the read-routing seams in sync. */
	private setWorld(w: World | undefined): void {
		this.activeWorld = w;
		this.syncReadRouting();
	}

	/** Arms/disarms the core's host read hook: armed while an evaluation
	 * world is on stack OR a provider could answer — so a provider-less
	 * quiet host costs reads exactly one undefined-check. */
	private syncReadRouting(): void {
		if (activeBridge !== this) return;
		const armed = this.activeWorld !== undefined || this.worldProvider !== undefined || this.captureFrame !== undefined;
		__setHostRead(armed ? hostReadImpl : undefined);
	}

	/** The world a routed read resolves in RIGHT NOW: the evaluation world on
	 * stack, else whatever the provider derives from the live call context. */
	private effectiveWorld(): World | undefined {
		if (this.activeWorld !== undefined) return this.activeWorld;
		const p = this.worldProvider;
		return p === undefined ? undefined : p();
	}

	/**
	 * The host read hook's target: route a public read to the effective
	 * world, adopting unregistered atoms on demand when the bindings provided
	 * an adopter. Returns __HOST_MISS to take the plain kernel path.
	 * @internal (reached only through index.ts's `Atom.state`)
	 */
	hostRead(atom: Atom<unknown>): unknown {
		// Fold purity: replayed updaters/reducers (and equals callbacks) must
		// not read signals — world routing would otherwise serve them silently.
		if (this.inFoldCallback) {
			throw new BridgeScheduleError('signal read inside an updater/reducer fold — updaters and reducers must be pure; read what you need before dispatching');
		}
		// World resolution order: the evaluation world on stack (reads inside a
		// computed's evaluation are the COMPUTED's dependencies — the capture
		// frame never sees them: the suppression rule of plan §2.2.2), then the
		// open capture frame (committed-for-root + dep capture), then the
		// host's ambient provider.
		let world = this.activeWorld;
		let cap: { sub: Subscription; deps: { node: AnyNode; value: Value }[] } | undefined;
		if (world === undefined) {
			cap = this.captureFrame;
			if (cap !== undefined) {
				world = { kind: 'committed', root: cap.sub.root };
			} else {
				const p = this.worldProvider;
				world = p === undefined ? undefined : p();
			}
		}
		if (world === undefined) {
			return __HOST_MISS;
		}
		let node = this.byKernelId.get(atom._id);
		if (node === undefined) {
			const adopt = this.readAdopter;
			if (adopt === undefined) {
				return __HOST_MISS;
			}
			node = adopt(atom);
		}
		const v = this.routedRead(node, world);
		if (cap !== undefined) cap.deps.push({ node, value: v });
		return v;
	}

	private log(e: BridgeEvent): void {
		probes.bridgeEvents++; // One Core probe (referee surface)
		if (this._retainEvents) {
			this.events.push(e);
			const cap = this.eventCapacity;
			if (cap !== undefined && this.events.length >= cap * 2) {
				const drop = this.events.length - cap;
				this.events.splice(0, drop);
				this.eventsBase += drop;
			}
		} else {
			// A tracer alone consumes events LIVE (the hook call below) into its
			// own fixed-size buffers; nothing reads `this.events` later, so
			// retaining here would grow memory for the life of the session.
			// The absolute cursor still advances: a minted-but-unretained event
			// counts as immediately dropped.
			this.eventsBase++;
		}
		const tr = this.trace;
		if (tr !== undefined) tr.event(e);
	}

	private mintSeq(): Seq {
		return ++this.seq;
	}

	// ---- event-stream cursor/ring ----

	/** Absolute cursor into the event stream (stable across ring drops). */
	eventCursor(): number {
		return this.eventsBase + this.events.length;
	}

	/**
	 * Bound the RETAINED event log (the referee's `setRetainEvents(true)`
	 * stream — a tracer-only consumer already retains nothing) so a
	 * long-retaining diagnostic session doesn't grow it without limit: once
	 * set, the oldest events drop in amortized batches past ~2× the capacity
	 * and `eventCursor()`/`eventsSince()` marks stay stable. Unset by default —
	 * lockstep referees need the complete stream. Diagnostics knob; exercised
	 * by the SPK-K1 soak bench (research/experiments/cosignal-gates.md).
	 */
	setEventCapacity(cap: number | undefined): void {
		this.eventCapacity = cap;
	}

	// ---------------------------------------------------------------- setup

	/** Activates logged mode, once, monotonically; arms the table seam. */
	registerBridge(): void {
		if (this.evalDepth > 0 || this.inFoldCallback) {
			throw new BridgeScheduleError('registerReactBridge called inside an open evaluation/fold frame; it may only run at an operation boundary');
		}
		if (this.mode === 'logged') throw new BridgeScheduleError('bridge already registered — registration happens exactly once');
		this.mode = 'logged';
		activeBridge = this;
		__setHostWrite(hostWriteImpl); // whole-op capture in the public methods
		this.syncReadRouting();
		this.recomputeQuiet(); // logged + nothing pending: quiet arms here
	}

	/** Registers a node id in the dense side columns. */
	private indexNode(node: AnyNode): void {
		const id = node.id;
		this.nodes.set(id, node);
		this.nodesArr[id] = node;
		this.touched[id] = 0;
		this.lastWalk[id] = 0;
		this.evalMark[id] = 0;
		this.obsRefs[id] = 0;
		this.subDepRefs[id] = 0;
	}

	atom(name: string, initial: Value, equals?: Equals): AtomNode {
		const eq = equals ?? Object.is;
		const handle = new Atom<Value>(initial, equals === undefined ? undefined : { isEqual: equals });
		const node = new AtomNode(this.nextNode++, name, initial, eq, equals === undefined, handle);
		this.indexNode(node);
		this.byKernelId.set(handle._id, node);
		handle._hostStamp = { b: this, n: node }; // per-write registry fast path
		return node;
	}

	/**
	 * Resolve a public handle to its registered node — the ONE
	 * stamp-validate + registry-probe rule, shared by the host write seam and
	 * the bindings' handle resolution. Adoption stamps `{b, n}` on the
	 * handle, so the steady state is one property load + identity compare;
	 * the Map probe runs only for un-stamped handles (or a stamp from a
	 * replaced bridge — test drivers swap bridges; the stamp validates
	 * against THIS bridge and re-stamps on a registry hit).
	 */
	nodeFor(atom: Atom<unknown>): AtomNode | undefined {
		const stamp = atom._hostStamp;
		if (stamp !== undefined && stamp.b === this) return stamp.n as AtomNode;
		const node = this.byKernelId.get(atom._id);
		if (node !== undefined) atom._hostStamp = { b: this, n: node }; // re-stamp after a bridge swap
		return node;
	}

	/**
	 * An atom created before the bridge was registered joins with its current
	 * value as committed-only base state — no receipts existed for its past
	 * writes, and none are needed: pre-registration history is, by
	 * construction, visible to every world.
	 */
	adoptAtom(name: string, handle: Atom<Value>, equals?: Equals): AtomNode {
		const current = this.kernelValueOf(handle);
		const node = new AtomNode(this.nextNode++, name, current, equals ?? Object.is, equals === undefined, handle);
		this.indexNode(node);
		this.byKernelId.set(handle._id, node);
		handle._hostStamp = { b: this, n: node }; // per-write registry fast path
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

	/** The pass's included set = its render mask ∪ the committed slots it
	 * captured at start: the batches this render is allowed to see. */
	includedSet(pass: Pass): Set<SlotId> {
		return new Set([...pass.maskSlots, ...pass.capturedCommittedSlots]);
	}

	/** The root's CURRENT committed-slot set (live committed tokens' slots). */
	committedSlotsNow(rootId: RootId): Set<SlotId> {
		const out = new Set<SlotId>();
		for (const t of this.root(rootId).committedTokens) {
			const tok = this.tokens.get(t);
			if (tok !== undefined && tok.slot !== undefined) out.add(tok.slot);
		}
		return out;
	}

	/** Runs an updater/reducer/equals under the fold-purity guard: signal
	 * reads and writes inside these callbacks throw, because they are
	 * replayed per world and must stay pure. */
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
				// Replayed updaters run under BOTH fold guards: the bridge's
				// (bridge reads throw) and the kernel's POISON table (raw
				// public reads/writes throw exactly as in the unhosted path).
				// ReducerAtom dispatches arrive here too: the closure carries
				// the reducer and the captured action.
				return this.inCallback(() => __hostRunFold(() => op.fn(prev)));
		}
	}

	/**
	 * The fold — replay visible entries over base in sequence order with
	 * stepwise equality (an equal step keeps the old reference). Runs over
	 * the packed columns; computes the memo fingerprint
	 * fp = max(newest visible entry seq, baseSeq, retirementStamp) into
	 * `lastFoldFp` during the same scan (the fingerprint is the version
	 * stamp memo validation compares against).
	 */
	lastFoldFp: Seq = 0;

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

	/**
	 * The visibility rule — which receipts each world's fold replays (over the
	 * packed columns; no Receipt object). The clauses:
	 *  - newest: every receipt (the kernel applies writes eagerly, so this
	 *    world is also readable straight off the kernel arena);
	 *  - pass: (1) receipts retired at-or-before the pass's pin — permanent
	 *    history the render started from — and (2) receipts from included
	 *    batches up to the pin, so a paused-and-resumed render never sees a
	 *    write that landed after it started;
	 *  - committed-for-root: retired receipts (committed truth at NOW) plus
	 *    receipts from batches this root has committed but that are still
	 *    live elsewhere (membership);
	 *  - mountFix: the mount-fixup world (see mountFixup) — the render's own
	 *    inclusions at its pin, plus committed truth at NOW, minus live
	 *    divergence already covered by scheduled corrective re-renders.
	 * (The referee's Receipt-shaped twin of this rule lives in
	 * tests/model-view.ts and must mirror these clauses.)
	 */
	private visibleAt(atom: AtomNode, i: number, world: World, seqs: Seq[], retired: Seq[], slots: SlotId[]): boolean {
		switch (world.kind) {
			case 'newest':
				return true;
			case 'pass': {
				const w = world.pass;
				const r = retired[i]!;
				if (r !== 0 && r <= w.pin) return true; // clause 1: retired by my pin
				return ((w.includedBits >>> slots[i]!) & SlotBits.LOW_BIT) === 1 && seqs[i]! <= w.pin; // clause 2
			}
			case 'committed': {
				if (retired[i]! !== 0) return true; // committed truth at now
				// Membership consult materializes the root record (reference-model
				// parity: the plain committedSlotsNow() creates it on first consult).
				return ((this.root(world.root).committedBits >>> slots[i]!) & SlotBits.LOW_BIT) === 1;
			}
			case 'mountFix': {
				if (world.maskSlots.has(slots[i]!) && seqs[i]! <= world.pin) return true;
				if (world.excludeLiveTokens?.has(atom.tp.tokens[i]!)) return false; // corrective-covered (audit form)
				if (retired[i]! !== 0) return true; // committed truth at NOW
				return ((this.root(world.root).committedBits >>> slots[i]!) & SlotBits.LOW_BIT) === 1;
			}
		}
	}

	/** Fingerprint-only scan (memo revalidation without replaying ops). */
	private scanFp(atom: AtomNode, world: World): Seq {
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

	private applyOpPacked(atom: AtomNode, kind: OpKind, payload: unknown, prev: Value): Value {
		if (kind === OpKind.SET) return payload;
		return this.inCallback(() => __hostRunFold(() => (payload as (p: Value) => Value)(prev)));
	}

	/** Reads an atom's newest value straight from the kernel — the core's
	 * host-side read seam, which the world-routing hook can never intercept
	 * (no seam toggling around the call). */
	private kernelValueOf(handle: Atom<Value>): Value {
		return __hostReadNewest(handle);
	}

	/**
	 * The newest-world memo table. The newest world's computed values
	 * live in their own memo table validated by the same memo ladder
	 * (fingerprints ground at kernel atom state: fp(a, newest) is O(1) — the
	 * last tape sequence / base sequence / retirement stamp). Real kernel
	 * Computed records are deliberately NOT used for overlay computeds: a
	 * computed whose dependencies flip between evaluations can leave stale
	 * cross-evaluation links that form kernel link cycles the kernel's
	 * unwatched-dispose walk cannot traverse (measured as a hang; the
	 * overlay's union table is cycle-guarded, the kernel arena must stay
	 * acyclic).
	 */
	private newestMemos = new Map<NodeId, WorldMemo>();

	/** Newest-eval taint accumulator, per computed frame. */
	private newestFrameTaint = false;


	// ---- memo frames: direct deps of the world evaluation in progress ----
	private frame: WorldMemo | undefined = undefined;
	/** The node id whose evaluation frame is open (raw-handle reads record to it). */
	private currentSink: NodeId = 0;

	private memoTableOf(world: World): Map<NodeId, WorldMemo> | undefined {
		if (world.kind === 'newest') return this.newestMemos;
		if (world.kind === 'pass') return world.pass.memos;
		// Never CREATE the root record here — the reference model materializes roots only
		// at passStart/mountReactEffect, and the observable snapshot iterates
		// them. An unmaterialized root folds plain (empty committed set).
		if (world.kind === 'committed') return this.roots.get(world.root)?.memos;
		return undefined; // mountFix worlds are one-shot
	}

	/** Quiet check for pass worlds: every included slot's write clock ≤
	 * memo.seq means nothing this world can see was written since the memo. */
	private passClocksQuiet(pass: Pass, memoSeq: Seq): boolean {
		let bits = pass.includedBits;
		while (bits !== 0) {
			const s = SlotBits.MSB_INDEX - Math.clz32(bits & -bits);
			if (this.slots[s]!.writeClock > memoSeq) return false;
			bits &= bits - 1;
		}
		return true;
	}

	/** Quiet check for committed worlds: no committed-truth advance AND no
	 * member-slot write since the memo was stamped. */
	private committedClocksQuiet(root: RootState, memoSeq: Seq): boolean {
		if (this.cas > memoSeq) return false;
		let bits = root.committedBits;
		while (bits !== 0) {
			const s = SlotBits.MSB_INDEX - Math.clz32(bits & -bits);
			if (this.slots[s]!.writeClock > memoSeq) return false;
			bits &= bits - 1;
		}
		return true;
	}

	/**
	 * Validate a memo through the ladder: cheap world-clock quiet checks
	 * first, then per-dependency fingerprint rechecks. Returns true if the
	 * memo may serve (re-stamped when the fingerprint step carried it).
	 */
	private validateMemo(m: WorldMemo, world: World): boolean {
		if (m.epoch !== this.epoch) return false;
		if (m.checkedOp === this.seq) return true; // nothing minted since last validation ⇒ nothing changed
		if (m.validating) return false; // stale dep lists can cross-link; refuse instead of recursing
		m.validating = true;
		try {
			if (!this.validateMemoInner(m, world)) return false;
		} finally {
			m.validating = false;
		}
		m.checkedOp = this.seq;
		return true;
	}

	private validateMemoInner(m: WorldMemo, world: World): boolean {
		let quiet = false;
		if (world.kind === 'pass') {
			quiet = this.passClocksQuiet(world.pass, m.seq);
		} else if (world.kind === 'committed') {
			// The root commit generation RE-KEYS committed memos: a gen
			// mismatch means the memo belongs to a dead world — evict, never
			// fingerprint-rescue. Why: a per-root commit flips visibility of
			// receipts BELOW the visible maximum sequence, and fingerprints
			// only track that maximum, so they cannot detect the flip.
			const root = this.roots.get(world.root);
			if (root === undefined || m.gen !== root.commitGen) return false;
			quiet = this.committedClocksQuiet(root, m.seq);
		}
		if (!quiet) {
			// Fingerprint recheck per recorded atom dep; computed deps
			// revalidate recursively by value identity (grounds at atoms).
			for (let i = 0; i < m.atoms.length; i++) {
				if (this.fpOf(m.atoms[i]!, world) !== m.fps[i]!) return false;
			}
			for (let i = 0; i < m.comps.length; i++) {
				if (!Object.is(this.evaluate(m.comps[i]!, world), m.compValues[i])) return false;
			}
			m.seq = this.seq; // re-stamp
		}
		return true;
	}

	/** fp(a, w) = max(newest w-visible entry seq, baseSeq, retirementStamp). */
	private fpOf(atom: AtomNode, world: World): Seq {
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
	 * Raw-handle reads: a registered atom read reached the operation table
	 * while an overlay evaluation frame was open. Record the edge to the
	 * open frame's sink (mirroring into K1 the topology the bridge readers
	 * never see) and serve the world value.
	 * @internal (called from the logged table wrapper)
	 */
	routedRead(atom: AtomNode, world: World): Value {
		const sink = this.currentSink;
		if (sink !== 0) this.recordEdge(atom.id, sink);
		return this.atomValue(atom, world);
	}

	/** Atom value in a world: kernel for newest, memoized fold otherwise. */
	private atomValue(atom: AtomNode, world: World): Value {
		if (world.kind === 'newest') {
			// The kernel holds the newest fold by the eager-apply invariant.
			const v = this.kernelValueOf(atom.handle);
			this.captureAtomDep(atom, this.fpOf(atom, world));
			return v;
		}
		const table = this.memoTableOf(world);
		if (table === undefined) {
			const v = this.foldAtom(atom, world);
			this.captureAtomDep(atom, this.lastFoldFp);
			return v;
		}
		let m = table.get(atom.id);
		if (m !== undefined && this.validateMemo(m, world)) {
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
			table.set(atom.id, m);
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

	private captureAtomDep(atom: AtomNode, fp: Seq): void {
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
	 * Evaluation of a node in a world. Newest-world atoms read straight off
	 * the kernel arena; newest-world computeds serve from the newest memo
	 * table (recompute if stale, plain signals semantics). Other worlds
	 * first try the fast path — when the node's touched word is 0, no
	 * receipt from any live batch can reach it, so its newest cache is
	 * committed-only state that every world agrees on: serve it with zero
	 * fold once it validates. Then the memo ladder, then a fresh world
	 * evaluation recording real K1 edges. Untracked reads fold in-world,
	 * edge-free. Reads inside fold callbacks throw (updaters/reducers must
	 * be pure); per-world cycles throw instead of recursing.
	 */
	evaluate(node: AnyNode, world: World): Value {
		probes.worldEvals++; // One Core probe (referee surface)
		if (this.inFoldCallback) throw new BridgeScheduleError('signal read inside an updater/reducer fold — updaters and reducers must be pure; read what you need before dispatching');
		if (node.kind === 'atom') return this.atomValue(node, world);
		const table = this.memoTableOf(world);
		if (world.kind !== 'newest' && world.kind !== 'mountFix') {
			// Fast path: no slot bits, no taint, valid newest cache.
			const word = this.touched[node.id]!;
			if (word === 0) {
				const nm = this.newestMemos.get(node.id);
				if (nm !== undefined && this.validateMemo(nm, NEWEST)) {
					this.captureCompDep(node, nm.value);
					return nm.value;
				}
			}
		}
		// World path: the memo ladder.
		if (table !== undefined) {
			const m = table.get(node.id);
			if (m !== undefined && this.validateMemo(m, world)) {
				this.captureCompDep(node, m.value);
				return m.value;
			}
		}
		// Per-world cycle detection via the mark column: marks carry the
		// current top-level evaluation generation.
		const marks = this.evalMark;
		if (marks[node.id] === this.evalGen && this.evalDepth > 0) {
			throw new BridgeScheduleError(`cyclic evaluation of ${node.name} within one world — a computed may not depend on itself`);
		}
		if (this.evalDepth === 0) this.evalGen++;
		marks[node.id] = this.evalGen;
		this.evalDepth++;
		const savedWorld = this.activeWorld;
		this.setWorld(world);
		const savedFrame = this.frame;
		const savedSink = this.currentSink;
		const savedTaint = this.newestFrameTaint;
		const savedObsCapture = this.obsCapture;
		// Observed nodes capture the strong deps of this run (recordEdge
		// pushes); everyone else pays this one check.
		this.obsCapture = this.obsRefs[node.id]! > 0 ? [] : undefined;
		this.currentSink = node.id;
		if (world.kind === 'newest') this.newestFrameTaint = false;
		let myFrame: WorldMemo | undefined;
		if (table !== undefined) {
			myFrame = {
				value: undefined, seq: this.seq, gen: 0, epoch: this.epoch, checkedOp: this.seq, validating: false,
				atoms: [], fps: [], comps: [], compValues: [],
			};
		}
		this.frame = myFrame;
		const tr = this.trace; // paired eval hooks; end fires on throw too
		if (tr !== undefined) tr.evalStart(node, world);
		try {
			const value = node.fn(this.trackedReader, this.untrackedReader);
			if (world.kind === 'newest') {
				// Taint epilogue: derive bit 31 fresh from this evaluation —
				// a node stays tainted only while its own evaluation still
				// touches pending state through untracked reads.
				const word = this.touched[node.id]!;
				if (this.newestFrameTaint) {
					if ((word & SlotBits.TAINT) === 0) this.propagateTaint(node.id);
				} else if ((word & SlotBits.TAINT) !== 0) {
					this.touched[node.id] = word & SlotBits.SLOT_MASK; // own-epilogue clear
				}
			}
			if (myFrame !== undefined) {
				myFrame.value = value;
				myFrame.seq = this.seq;
				if (world.kind === 'committed') myFrame.gen = this.roots.get(world.root)?.commitGen ?? 0;
				table!.set(node.id, myFrame);
			}
			// The frame captured MY deps; my caller captures me as a computed dep.
			this.frame = savedFrame;
			this.captureCompDep(node, value);
			return value;
		} finally {
			const obsCaptured = this.obsCapture;
			this.obsCapture = savedObsCapture;
			this.frame = savedFrame;
			this.currentSink = savedSink;
			this.newestFrameTaint = savedTaint;
			this.setWorld(savedWorld);
			this.evalDepth--;
			marks[node.id] = 0;
			if (tr !== undefined) tr.evalEnd();
			// Observed-closure sync — after every restore, so the discovery
			// evaluations the sync may trigger run on a clean frame stack. On
			// a throw the list holds the deps recorded up to it (see obsEnter
			// for the rule).
			if (obsCaptured !== undefined) this.obsSyncDeps(node.id, obsCaptured);
		}
	}

	/** Mark column + generation for per-world cycle detection (no Set allocs). */
	private evalMark: EvalGen[] = [0];
	private evalGen: EvalGen = 0;

	/** The persistent tracked reader: edges to the open sink; world from the frame. */
	private trackedReader: Reader = (dep) => {
		const sink = this.currentSink;
		this.recordEdge(dep.id, sink);
		if ((this.touched[dep.id]! & SlotBits.TAINT) !== 0) this.newestFrameTaint = true; // taint flows through recorded deps
		return this.evaluate(dep, this.activeWorld!);
	};

	/**
	 * The persistent untracked reader: EDGE-free, not INPUT-free — the dep
	 * still enters the open memo frame's fingerprint set (validation must
	 * observe untracked movement, or committed folds would serve stale
	 * values that the reference model computes fresh). No strong edge is
	 * recorded (currentSink drops), so no notification will ever fire
	 * through it; the WEAK edge feeds durable-drain candidate collection
	 * only.
	 */
	private untrackedReader: Reader = (dep) => {
		const sink = this.currentSink;
		this.recordWeakEdge(dep.id, sink);
		const world = this.activeWorld!;
		// Taint input: an untracked read hit pending state (newest evals).
		if (world.kind === 'newest') {
			if (dep.kind === 'atom') {
				if (dep.tp.n > dep.tp.start || (this.touched[dep.id]! & SlotBits.TAINT) !== 0) this.newestFrameTaint = true;
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

	// ---- the union table + walks ----

	private recordEdge(dep: NodeId, dependent: NodeId): void {
		// Observed-closure capture, BEFORE the episode dedup below: K1 edges
		// record once per episode, but an observed re-evaluation must capture
		// its full current dep list (that list is what moves the retains).
		const oc = this.obsCapture;
		if (oc !== undefined) oc.push(dep);
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
		// Edge-add propagation: the new edge inherits the source's bits...
		const src = this.touched[dep]!;
		const newBits = src & SlotBits.SLOT_MASK & ~this.touched[dependent]!;
		if (newBits !== 0) this.propagateBits(dependent, newBits);
		if ((src & SlotBits.TAINT) !== 0 && (this.touched[dependent]! & SlotBits.TAINT) === 0) this.propagateTaint(dependent);
		// Retroactive delivery REPLAY through a newly added edge (scheduling a
		// re-render per still-live slot whose past writes can now reach a
		// watcher via this path) is deliberately NOT implemented: the
		// reference model delivers only at writes, so replay events could not
		// be validated against it. The bit propagation above preserves all
		// routing/drain correctness (fast-path refusal, touched-list
		// coverage); the replay's only lost effect is catch-up lane
		// scheduling, which the React-runtime wiring must revisit.
	}

	private edgeCount = 0;
	private lastSweepEdges = 0;

	// ---- observed-closure maintenance (see the observation index's fields above) ----

	/** Shift a node's observed-consumer refcount; enter/exit fire on the
	 * 0↔1 edges only, so shared consumers (two watchers on one derived node,
	 * two observed dependents of one dep) hold ONE closure membership. */
	private obsShift(id: NodeId, delta: 1 | -1): void {
		const refs = this.obsRefs[id]! + delta;
		this.obsRefs[id] = refs;
		if (refs === 1 && delta === 1) this.obsEnter(id);
		else if (refs === 0 && delta === -1) this.obsExit(id);
	}

	/**
	 * A node joined the live-watcher closure. Atoms retain their kernel
	 * observed lifecycle (the watcher half of the observation union — the
	 * kernel liveness bit is the other). Computeds must discover their
	 * CURRENT strong dep set: the fn may never have run while observed
	 * (memo-served or evaluated pre-liveness), so force one newest
	 * evaluation — dropping the newest memo guarantees the fn runs and the
	 * evaluate epilogue records and retains the dep set. A getter that
	 * throws keeps its throw-on-demand behavior; the deps it read before
	 * throwing ARE retained (their K1 edges are recorded, so deliveries
	 * reach this node's watchers through them — they have live consumers).
	 */
	private obsEnter(id: NodeId): void {
		const node = this.nodesArr[id]!;
		if (node.kind === 'atom') {
			__lifecycleRetain(node.handle._id);
			return;
		}
		this.newestMemos.delete(id);
		// Frame mask: entry can fire inside an enclosing evaluation's epilogue
		// (a parent's dep sync), and the discovery is not a READ by that
		// parent — its trailing dep capture must not enter the open frame's
		// fingerprint set.
		const savedFrame = this.frame;
		this.frame = undefined;
		try {
			this.evaluate(node, NEWEST);
		} catch {
			// partial dep set already synced by the evaluate epilogue
		} finally {
			this.frame = savedFrame;
		}
	}

	/** The last observed consumer left: release the whole retained closure.
	 * obsDeps clears BEFORE the child shifts so a degenerate cyclic dep
	 * record (possible only via throwing getters) cannot re-release. */
	private obsExit(id: NodeId): void {
		const node = this.nodesArr[id]!;
		if (node.kind === 'atom') {
			__lifecycleRelease(node.handle._id);
			return;
		}
		const deps = this.obsDeps[id];
		if (deps === undefined) return;
		this.obsDeps[id] = undefined;
		for (const dep of deps) this.obsShift(dep, -1);
	}

	/**
	 * An observed computed's fn just ran (fully, or up to a throw): re-point
	 * its retains at the strong deps THIS evaluation recorded. Retain-new
	 * before release-old; deps present in both snapshots never shift, and
	 * an A→B→A flip within one tick nets out in the kernel's microtask
	 * flush. Skipped if observation left mid-evaluation (the exit already
	 * released the old snapshot; installing a new one would leak).
	 */
	private obsSyncDeps(id: NodeId, list: NodeId[]): void {
		if (this.obsRefs[id]! === 0) return;
		const prev = this.obsDeps[id];
		const next = new Set(list);
		this.obsDeps[id] = next;
		for (const dep of next) {
			if (prev === undefined || !prev.delete(dep)) this.obsShift(dep, 1);
		}
		if (prev !== undefined) {
			for (const dep of prev) this.obsShift(dep, -1);
		}
	}

	/**
	 * A committed subscription's run just installed a new dep snapshot:
	 * re-point its observation retains (RCC-OL1 — effect dep snapshots count
	 * toward the observation union exactly like watcher closures: one retain
	 * per snapshot node through the obsShift observation index; an atom retains its
	 * kernel lifecycle, an observed computed retains its current strong deps
	 * transitively) and its routing-coverage counts (subDepRefs: K1 sweep
	 * seeds + quiescence refresh targets). Retain-new before release-old;
	 * same-tick flaps coalesce in the kernel's microtask flush.
	 */
	private syncSubObs(e: Subscription): void {
		const prev = e.obsDeps;
		const next = new Set<NodeId>();
		for (let i = 0; i < e.deps.length; i++) next.add(e.deps[i]!.node.id);
		e.obsDeps = next;
		for (const dep of next) {
			if (prev === undefined || !prev.delete(dep)) {
				this.subDepRefs[dep] = this.subDepRefs[dep]! + 1;
				this.obsShift(dep, 1);
			}
		}
		if (prev !== undefined) {
			for (const dep of prev) {
				this.subDepRefs[dep] = this.subDepRefs[dep]! - 1;
				this.obsShift(dep, -1);
			}
		}
	}

	/**
	 * Bounded mid-episode sweep so K1 cannot grow without limit between
	 * quiescence points. Collects only the provably-safe subset: an edge
	 * dep→t drops iff t cannot reach any node holding a committed watcher /
	 * effect-dep snapshot / core-effect subscription (reverse reachability
	 * over K1) AND t carries no retained touched bits for LIVE slots and no
	 * taint. Dirt on the touched WORDS persists (keep-the-dirt: conservative
	 * bits may only clear when provably irrelevant to every live pin) — only
	 * the stranded routing records go. Runs every 256 recorded edges
	 * (amortized O(V+E)).
	 */
	private sweepK1(): void {
		this.lastSweepEdges = this.edgeCount;
		const gen = ++this.walkGen;
		const lastWalk = this.lastWalk;
		const stack = this.walkStack;
		let sp = 0;
		for (let id = 0; id < this.nodesArr.length; id++) {
			const ws = this.watchersByNode[id];
			const ns = this.subsByNode[id];
			if ((ws !== undefined && ws.length > 0) || (ns !== undefined && ns.length > 0) || this.subDepRefs[id]! > 0) {
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
		const keepMask = liveBits | SlotBits.TAINT;
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

	// The WEAK table: untracked reads record drain-only edges. Never
	// traversed by marking or delivery walks (untracked paths never fire
	// notifications); durable drains expand over them so a committed-truth
	// flip reaching a node only through untracked reads still
	// reconcile-checks its observers (value-gated — the reference model's
	// full-observer scan behavior, scoped to the affected CONE: the set of
	// nodes reachable downstream of the change. "Cone" below always means
	// that downstream reachable set).
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

	/** Marking walk scratch. The walk visits a node only for bits it does not
	 * already have (`newBits & ~touched(n)`); bits only ever turn on within an
	 * episode (monotone), so the walk terminates without a visited set. */
	private markStackN: NodeId[] = [];
	private markStackB: SlotSet[] = [];

	private propagateBits(start: NodeId, startBits: SlotSet): void {
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
	private applyBits(node: NodeId, bits: SlotSet): void {
		this.touched[node] = this.touched[node]! | bits;
		let b = bits;
		while (b !== 0) {
			const s = SlotBits.MSB_INDEX - Math.clz32(b & -b);
			this.slotTouched[s]!.push(node);
			b &= b - 1;
		}
	}

	/** Taint 0→1 propagation over existing out-edges. */
	private propagateTaint(start: NodeId): void {
		const stack = this.markStackN;
		let sp = 0;
		this.touched[start] = this.touched[start]! | SlotBits.TAINT;
		stack[sp++] = start;
		while (sp > 0) {
			const outs = this.outList[stack[--sp]!];
			if (outs === undefined) continue;
			for (let i = 0; i < outs.length; i++) {
				const n = outs[i]!;
				if ((this.touched[n]! & SlotBits.TAINT) === 0) {
					this.touched[n] = this.touched[n]! | SlotBits.TAINT;
					stack[sp++] = n;
				}
			}
		}
	}

	/** Reused delivery-walk buffers (walks are never re-entrant). */
	private walkStack: NodeId[] = [];
	private walkWatchers: Watcher[] = [];

	/**
	 * The value-blind delivery walk over K0∪K1 with the per-walk visited
	 * generation. Value-blind: a delivery announces "a write in this batch
	 * may affect you", never a value — the receiving render folds its own
	 * world, so over-delivery is safe and no fold runs on the write path.
	 * Collects reached watchers (delivered in id order — the reference
	 * model's map order) and enqueues reached core effects.
	 */
	private deliveryWalk(from: NodeId, token: Token, slot: SlotMeta, seq: Seq): void {
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
			const ces = this.subsByNode[cur];
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

	// -------------------------------------------------- batches and slots

	liveTokens(): Token[] {
		return [...this.tokens.values()].filter((t) => t.state === 'live');
	}

	private minLivePin(): Seq {
		let min = Number.POSITIVE_INFINITY;
		for (const p of this.openPassByRoot.values()) if (p.pin < min) min = p.pin;
		return min;
	}

	/** Mint a batch token. At most 31 live at once — React schedules each
	 * batch on one of its 31 lanes, so more can never be in flight. (The
	 * lane/priority itself stays React's: the engine never consults it —
	 * scheduling decisions ride the shim's forkToken map.) */
	openBatch(opts?: { action?: boolean; ambient?: boolean }): Token {
		if (this.mode !== 'logged') throw new BridgeScheduleError('batches exist only in logged mode — register the React bridge first');
		if (this.liveTokenCount >= SLOT_COUNT) {
			throw new BridgeScheduleError('at most 31 batch tokens may be live at once (one per React lane)');
		}
		const parked = opts?.action ?? false;
		probes.tokens++; // One Core probe (referee surface)
		const token: Token = {
			id: this.nextToken++,
			action: opts?.action ?? false,
			parked, // async-action tokens park (cannot retire) until their promise settles
			state: 'live', committedFlag: undefined, slot: undefined,
			retiredSeq: undefined, lastWriteSeq: 0, atomsTouched: [], liveReceipts: 0,
			ambient: opts?.ambient ?? false,
		};
		this.tokens.set(token.id, token);
		this.liveTokenCount++;
		this.quiet = false; // a live batch: the pipeline is armed until the last retirement
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
	 * Intern the token's slot, claiming a free one on its first write.
	 * Claim housekeeping: the write clock zeroes; per-(watcher, slot) dedup
	 * bits clear (the bit now means a different batch); the keep-the-dirt
	 * sweep clears the slot's touched bits via its touched list only when no
	 * excluding pin remains (min live pins ≥ the slot's carried max
	 * retirement sequence) — earlier, some paused render could still need
	 * the conservative dirt.
	 */
	private internSlot(token: Token): SlotMeta {
		if (token.slot !== undefined) return this.slots[token.slot]!;
		let free = this.slots.find((s) => s.tenant === undefined);
		if (free === undefined) {
			// Backstop: release the oldest mask-retained retired slot anyway,
			// loudly — starving new batches would deadlock the scheduler, and
			// the affected paused render self-corrects through drains/fixup.
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
			if (this.eventsOn) this.log({ type: 'slot-backstop-released', slot: victim.id, token: victim.tenant! });
			this.releaseSlot(victim);
			free = victim;
		}
		// Disposal at re-intern: if no excluding pin remains, sweep the slot's
		// bit via its touched list and reset it; otherwise inherit the dirt.
		if (this.minLivePin() >= free.carriedMaxRetiredSeq) {
			const list = this.slotTouched[free.id]!;
			const clear = ~(1 << free.id);
			for (let i = 0; i < list.length; i++) this.touched[list[i]!] = this.touched[list[i]!]! & clear;
			list.length = 0;
		}
		free.tenant = token.id;
		free.claimSeq = this.mintSeq(); // claim-after-release gets its own point on the timeline
		free.writeClock = 0;
		free.releasePending = false;
		token.slot = free.id;
		// A committed-but-slotless token (action scope / late first write)
		// interns here — its root's membership bits gain the slot NOW so the
		// committed world's membership clause sees the coming receipts.
		for (const r of this.roots.values()) {
			if (r.committedTokens.has(token.id)) r.committedBits |= 1 << free.id;
		}
		{
			const clear = ~(1 << free.id);
			for (const w of this.watchers.values()) w.dedupBits &= clear; // dedup clear at re-intern
		}
		if (this.eventsOn) this.log({ type: 'slot-claimed', slot: free.id, token: token.id });
		return free;
	}

	private releaseSlot(slot: SlotMeta): void {
		const tenant = slot.tenant === undefined ? undefined : this.token(slot.tenant);
		if (tenant !== undefined) {
			slot.carriedMaxRetiredSeq = Math.max(slot.carriedMaxRetiredSeq, tenant.retiredSeq ?? 0);
			tenant.slot = undefined; // identity release; receipts keep their denormalized slot
			if (this.eventsOn) this.log({ type: 'slot-released', slot: slot.id, token: tenant.id });
		}
		slot.tenant = undefined;
		slot.releasePending = false;
		if (tenant !== undefined) this.maybeReclaimToken(tenant); // identity gone; mask/receipt gates re-check
	}

	// ------------------------------------------------------ the write path

	/**
	 * Quiet-mode write fold — the whole write while nothing is pending. The
	 * op folds over committed base (updaters/reducers under both fold-purity
	 * guards, exactly as replay would run them), the same equality drop as
	 * the write path's tape-empty drop check applies, and an accepted write
	 * advances base and the kernel TOGETHER — the invariant while
	 * quiet is base ≡ kernel newest ≡ every world's value, so a batch opened
	 * later starts from a base that already contains the quiet history.
	 * Memo coherence: the fold mints one sequence and stamps it into the
	 * atom's baseSeq and the committed-advance clock (cas), so every memo
	 * table revalidates instead of serving pre-fold values. Observers: no
	 * walk machinery is armed, so the small live-observer population is
	 * reconciled value-gated, exactly like a durable drain (corrections for
	 * watchers, re-runs for committed React effects, newest evaluations for
	 * core effects). No receipt, no token, no tape append, no delivery walk,
	 * no bridge event (event consumers disarm quiet). @internal
	 */
	__quietWrite(node: AtomNode, kind: OpKind, payload: unknown): void {
		if (this.evalDepth > 0) throw new BridgeScheduleError('signal write during a world evaluation / render — write from an event handler or effect instead');
		if (this.inFoldCallback) throw new BridgeScheduleError('signal write inside an updater/reducer fold — updaters and reducers must be pure');
		const prev = node.base;
		const next = kind === OpKind.SET ? payload : this.applyOpPacked(node, kind, payload, prev);
		if (node.eqIsDefault ? Object.is(next, prev) : this.inCallback(() => node.equals(next, prev))) {
			return; // equality drop against base — the tape is empty by the quiet invariant
		}
		node.base = next;
		node.baseSeq = this.cas = ++this.seq; // move the memo clocks: fingerprint + committed-advance (mintSeq, inlined)
		// Direct kernel apply: the plain write tail, no public-method re-entry
		// (the host seam already ran — policy checked, op folded).
		__hostApplySet(node.handle, next);
		if (this.watchers.size !== 0) this.quietDrain();
		// A quiet fold moves committed truth for every root — an EF2 boundary
		// (quiet ⇔ no open passes, so no frame can defer the re-check).
		if (this.committedSubCount !== 0) this.revalidateCommittedSubs(undefined);
		if (this.newestSubCount !== 0) this.directFlushCoreEffects();
		if (this.notifyN !== 0) this.flushNotify();
	}

	/** Value-gated watcher reconciliation for a quiet fold: committed truth
	 * moved for every root, and no slot/walk state exists to scope candidates,
	 * so every live watcher re-checks directly — the same compare-and-correct
	 * block as drainCommittedObservers. (Committed subscriptions re-check via
	 * revalidateCommittedSubs at the same boundary.) */
	private quietDrain(): void {
		for (const w of this.watchers.values()) {
			if (!w.live) continue;
			const now = this.evaluate(this.nodeById(w.node), { kind: 'committed', root: w.root });
			if (!Object.is(now, w.lastRenderedValue)) {
				w.lastRenderedValue = now; // the urgent pre-paint re-render
				w.dedupBits = 0; // dedup bits re-arm at the watcher's render
				if (this.onCorrection !== undefined) this.queueNotify(2, w, undefined, 0);
			}
		}
	}

	/** A write belongs to the batch context it executes in; a bare write has
	 * none, so it joins the ambient default batch — unless the bridge is
	 * QUIET, in which case the write folds directly (no ambient batch is
	 * minted while nothing is pending). */
	bareWrite(node: AtomNode, op: Op): void {
		if (this.quiet) {
			this.__quietWrite(
				node,
				op.kind === 'set' ? OpKind.SET : OpKind.UPDATE,
				op.kind === 'set' ? op.value : op.fn,
			);
			return;
		}
		let ambient = this.ambientToken === undefined ? undefined : this.tokens.get(this.ambientToken);
		if (ambient === undefined || ambient.state !== 'live') {
			ambient = this.openBatch({ ambient: true });
			this.ambientToken = ambient.id;
		}
		// The post-await dev-warning heuristic lives adapter-side only
		// (cosignal-react's shim classifyWrite) — the engine stays lint-free.
		this.write(ambient.id, node, op);
	}

	/** Action-scope write: classifies into the action's batch explicitly
	 * (usable after an await); throws once the action has settled. */
	scopeWrite(tokenId: TokenId, node: AtomNode, op: Op): void {
		const t = this.token(tokenId);
		if (!t.action) throw new BridgeScheduleError('scope writes require an action token');
		if (t.state !== 'live') throw new BridgeScheduleError('ActionScope closed — the action already settled');
		this.write(tokenId, node, op);
	}

	/**
	 * The write path. Direct-mode writes mutate committed-only state with no
	 * receipt (pre-registration history is visible to every world by
	 * construction). Logged steps, in order: classify (caller) → drop check
	 * → intern slot → append packed receipt + write clock → apply to the
	 * kernel with stepwise equality → marking walk → delivery walk →
	 * core-effect flush after the walk returns.
	 */
	write(tokenId: TokenId | undefined, node: AtomNode, op: Op): void {
		if (this.evalDepth > 0) throw new BridgeScheduleError('signal write during a world evaluation / render — write from an event handler or effect instead');
		if (this.inFoldCallback) throw new BridgeScheduleError('signal write inside an updater/reducer fold — updaters and reducers must be pure');
		if (node.kind !== 'atom') throw new BridgeScheduleError('writes target atoms');
		if (this.mode === 'direct') {
			const next = this.applyOp(node, op, node.base);
			if (!this.inCallback(() => node.equals(next, node.base))) {
				node.base = next; // pre-registration history is committed-only base state
				this.applyToKernel(node, next);
			}
			this.directFlushCoreEffects();
			const tr = this.trace;
			if (tr !== undefined) tr.opEnd();
			this.flushNotify();
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
		if (token.state !== 'live') throw new BridgeScheduleError(`write into retired token ${tokenId} — a retired batch accepts no new writes`);

		const tp = node.tp;
		// Drop check: only when the tape is empty AND the op evaluates equal
		// against base may a write be dropped — once receipts exist, worlds
		// may fold different previous values, so equality here proves nothing.
		if (tp.n === tp.start) {
			if (op.kind === 'set' && node.eqIsDefault) {
				if (Object.is(op.value, node.base)) {
					if (this.eventsOn) this.log({ type: 'write-dropped', node: node.name, token: tokenId });
					const tr = this.trace;
					if (tr !== undefined) tr.opEnd();
					this.flushNotify();
					return;
				}
			} else {
				const evaluated = this.applyOp(node, op, node.base);
				if (this.inCallback(() => node.equals(evaluated, node.base))) {
					if (this.eventsOn) this.log({ type: 'write-dropped', node: node.name, token: tokenId });
					const tr = this.trace;
					if (tr !== undefined) tr.opEnd();
					this.flushNotify();
					return;
				}
			}
		}

		// Intern slot, append receipt, bump the slot write clock.
		const slot = token.slot !== undefined ? this.slots[token.slot]! : this.internSlot(token);
		const seq = this.mintSeq();
		const kind = op.kind === 'set' ? OpKind.SET : OpKind.UPDATE;
		tp.push(kind, slot.id, seq, token.id, op.kind === 'set' ? op.value : op.fn);
		token.lastWriteSeq = seq;
		token.liveReceipts++;
		if (node.lastTouchToken !== token.id) {
			node.lastTouchToken = token.id;
			token.atomsTouched.push(node);
		}
		if (tp.n - tp.start === 1) this.dirtyAtoms.add(node);
		slot.writeClock = seq;
		if (this.roots.size !== 0) {
			// A write into a committed-member slot moves committed truth NOW;
			// the next durable drain must reconcile its cone.
			const bit0 = 1 << slot.id;
			for (const r of this.roots.values()) {
				if ((r.committedBits & bit0) !== 0) r.committedDirtySlots |= bit0;
			}
		}
		{
			const tr = this.trace;
			if (tr !== undefined) tr.receipt(node, tp.entryAt(tp.n - 1));
		}
		if (this.eventsOn) this.log({ type: 'write', node: node.name, token: token.id, slot: slot.id, seq });

		// Apply to the kernel eagerly with stepwise equality, so the newest
		// world stays directly readable off the kernel arena.
		if (kind === OpKind.SET && node.eqIsDefault) {
			this.applyToKernel(node, (op as { kind: 'set'; value: Value }).value); // kernel stores + propagates only on change
		} else {
			const prevNewest = this.kernelValueOf(node.handle);
			const nextNewest = this.applyOp(node, op, prevNewest);
			if (!this.inCallback(() => node.equals(nextNewest, prevNewest))) {
				this.applyToKernel(node, nextNewest);
			}
		}

		// The marking walk: propagate the slot's bit from the atom through
		// K0∪K1 out-edges with the monotone frontier.
		const bit = 1 << slot.id;
		if ((this.touched[node.id]! & bit) === 0) this.propagateBits(node.id, bit);
		// The value-blind delivery walk, synchronously in the writer's stack;
		// core effects enqueue on the walk and flush after it returns.
		this.deliveryWalk(node.id, token, slot, seq);
		this.flushEffectQueue();
		const tr = this.trace;
		if (tr !== undefined) tr.opEnd();
		this.flushNotify();
	}

	/** The one K0 write site: routes through the core's public write path
	 * (index.ts's policy layer), so equality drop and effect flush apply; the
	 * bridgeApplying guard makes the host write hook wave it through. */
	private applyToKernel(node: AtomNode, value: Value): void {
		const saved = bridgeApplying;
		bridgeApplying = true;
		try {
			node.handle.set(value);
		} finally {
			bridgeApplying = saved;
		}
	}

	/**
	 * Delivery — per-write, value-blind, in the writer's stack. The
	 * per-(watcher, slot) dedup bit suppresses a repeat delivery only when
	 * scheduled-but-unstarted work will fold the write anyway; otherwise
	 * deliver interleaved so no write can slip between renders unseen.
	 */
	private deliver(w: Watcher, token: Token, slot: SlotMeta, seq: Seq): void {
		const bit = 1 << slot.id;
		if ((w.dedupBits & bit) === 0) {
			w.dedupBits |= bit;
			if (this.eventsOn) this.log({ type: 'delivery', watcher: w.name, token: token.id, slot: slot.id, seq, mode: 'fresh' });
			if (this.onDelivery !== undefined) this.queueNotify(0, w, token, slot.id);
			return;
		}
		// Bit set: suppress iff NO started-and-uncommitted pass on the
		// watcher's root includes this slot (render mask) with pin < the
		// write's sequence — such a pass froze BEFORE this write, so it would
		// fold without it and a fresh delivery is still required.
		// One open pass per root ⇒ one registry load + two compares.
		const p = this.openPassByRoot.get(w.root);
		if (p !== undefined && ((p.maskBits >>> slot.id) & SlotBits.LOW_BIT) === 1 && p.pin < seq) {
			if (this.eventsOn) this.log({ type: 'delivery', watcher: w.name, token: token.id, slot: slot.id, seq, mode: 'interleaved' });
			if (this.onDelivery !== undefined) this.queueNotify(0, w, token, slot.id);
		} else {
			if (this.eventsOn) this.log({ type: 'suppressed', watcher: w.name, token: token.id, slot: slot.id, seq });
		}
	}

	/** Newest-policy subscriptions observe the newest world; flush after the walk returns. */
	private flushEffectQueue(): void {
		const q = this.effectQueue;
		if (q.length === 0) return;
		if (q.length > 1) q.sort((a, b) => a.id - b.id); // the reference model's map order
		for (let i = 0; i < q.length; i++) {
			const e = q[i]!;
			const value = this.evaluate(this.nodeById(e.node), NEWEST);
			if (!Object.is(value, e.lastValue)) {
				e.lastValue = value;
				e.runs++;
				if (this.eventsOn) this.log({ type: 'core-effect-run', effect: e.name, value });
			}
		}
		q.length = 0;
	}

	/** Direct-mode/quiet writes flush every newest subscription (no walk exists to scope them). */
	private directFlushCoreEffects(): void {
		for (const e of this.subs.values()) {
			if (e.policy !== 'newest') continue;
			const value = this.evaluate(this.nodeById(e.node), NEWEST);
			if (!Object.is(value, e.lastValue)) {
				e.lastValue = value;
				e.runs++;
				if (this.eventsOn) this.log({ type: 'core-effect-run', effect: e.name, value });
			}
		}
	}

	// ------------------------------------------------------ pass lifecycle

	/**
	 * Open a render pass: pin frozen at start, render mask captured from
	 * live tokens, committed set snapshotted — everything the pass world
	 * folds is fixed here, so pause/resume cannot drift. One
	 * work-in-progress pass per root (a same-root restart is a new pass).
	 */
	passStart(rootId: RootId, includeTokens: TokenId[]): Pass {
		if (this.openPassByRoot.has(rootId)) {
			throw new BridgeScheduleError(`root ${rootId} already has an open pass — one render pass per root at a time`);
		}
		const maskTokens = new Set<TokenId>();
		const maskSlots = new Set<SlotId>();
		let maskBits = 0;
		for (const id of includeTokens) {
			const t = this.token(id);
			if (t.state !== 'live') throw new BridgeScheduleError('mask captures live tokens only — a retired batch is already permanent history');
			maskTokens.add(id);
			// A live token with no slot never wrote; if it writes later, those
			// receipts postdate this pass's pin and the visibility rule's
			// included-up-to-pin clause excludes them anyway.
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
			memos: new Map(),
		};
		this.passes.set(pass.id, pass);
		this.openPassByRoot.set(rootId, pass);
		this.quiet = false; // an open render pass: the pipeline is armed until it closes
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

	/** Yield/resume edges: while yielded, code that runs in the gap (event
	 * handlers, other passes) is "not in render" for this pass. */
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

	/** Mount a new watcher inside an open pass; it renders in the pass's world. */
	mountWatcher(passId: PassId, node: AnyNode, name: string): Watcher {
		const p = this.pass(passId);
		if (p.state === 'ended') throw new BridgeScheduleError('mount requires an open pass');
		const value = this.evaluate(node, { kind: 'pass', pass: p });
		const watcher = new Watcher(this.nextWatcher++, name, p.root, node.id, this.watcherObs, value, {
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
	 * Reveal-shaped mounts (React's Offscreen/Activity: a hidden tree is
	 * prepared and committed without attaching its effects): the mounting
	 * pass commits but the watcher's layout effects (subscribe + fixup)
	 * defer to a later, adopting commit — the reveal.
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

	/** An existing live watcher re-rendered by a pass: dedup bits re-arm at
	 * render (the queued work the bits stood for has now started). */
	renderWatcher(passId: PassId, watcherId: WatcherId): void {
		const p = this.pass(passId);
		if (p.state === 'ended') throw new BridgeScheduleError('render requires an open pass');
		const w = this.watchers.get(watcherId);
		if (w === undefined || !w.live) throw new BridgeScheduleError('render targets a live watcher');
		if (w.root !== p.root) throw new BridgeScheduleError('watcher belongs to another root');
		w.dedupBits = 0;
		p.rendered.add(watcherId);
	}

	/**
	 * Full watcher removal — the bindings' unsubscribe surface (debounce-
	 * finalized unsubscription, StrictMode orphan sweeps). The engine keeps
	 * watchers in TWO stores — the `watchers` id map and the `watchersByNode`
	 * per-node index the walks read (delivery, drains, the K1 sweep's
	 * reachability seeds, quiescence refresh targets) — and this is the one
	 * public operation that retires a watcher from BOTH, plus any open pass's
	 * mounted list (a dead watcher must not be revived by a later commit's
	 * layout loop). Deleting from the public map alone strands the per-node
	 * entry: dead watchers then seed sweep reachability and quiescence
	 * refreshes forever (pinned by tests/graph-consumers.spec.ts). The
	 * liveness setter inside releases the observation-union retain.
	 */
	removeWatcher(watcherId: WatcherId): void {
		for (const p of this.passes.values()) {
			const i = p.mounted.indexOf(watcherId);
			if (i >= 0) p.mounted.splice(i, 1);
		}
		this.dropWatcher(watcherId);
	}

	/** Unlinks a watcher from the per-node index (discarded mounts). */
	private dropWatcher(wid: WatcherId): void {
		const w = this.watchers.get(wid);
		if (w === undefined) return;
		// Deletion implies non-live: normally already false (discarded mounts
		// never subscribed), but if a driver discards a pass holding an
		// adopted live watcher, this releases its observation retain
		// (edge-filtered no-op otherwise).
		w.live = false;
		this.watchers.delete(wid);
		const byNode = this.watchersByNode[w.node];
		if (byNode !== undefined) {
			const i = byNode.indexOf(w);
			if (i >= 0) byNode.splice(i, 1);
		}
	}

	// ------------------------------------------ the subscription mechanism
	// (effects unification by promotion — the adapter's EffectRec, moved into
	// core as THE committed-observer mechanism; see the Subscription type.)

	/**
	 * Register a committed observer (the production `useSignalEffect`
	 * surface). Registration is illegal inside an open evaluation frame —
	 * the record is committed-consumer state; it must never exist for a
	 * discarded render attempt (contract §2 L3; the render-stack half of the
	 * guard is adapter-enforced, since "on a render call stack" is a host
	 * predicate). The caller then runs `captureRun` from the host's effect
	 * phase to take the first dep snapshot.
	 */
	mountCommittedObserver(rootId: RootId, name: string, refire?: () => void): Subscription {
		if (this.evalDepth > 0 || this.inFoldCallback) {
			throw new BridgeScheduleError('effect registration is illegal inside an open evaluation/fold frame');
		}
		const e: Subscription = {
			id: this.nextEffect++, name, policy: 'committed', root: rootId, node: 0,
			deps: [], refire, body: undefined, lastValue: undefined,
			runs: 0, cleanups: 0, queuedWalk: 0, live: true, obsDeps: undefined,
		};
		this.root(rootId);
		this.subs.set(e.id, e);
		this.committedSubCount++;
		return e;
	}

	/** Referee configuration — a single-node body over the REAL mechanism
	 * (twin tests and the lockstep corpus referee the promoted machinery
	 * through this constructor; production uses mountCommittedObserver). */
	mountReactEffect(rootId: RootId, node: AnyNode, name: string): Subscription {
		const e = this.mountCommittedObserver(rootId, name);
		e.body = () => void this.captureRead(node);
		this.captureRun(e.id, e.body);
		return e;
	}

	/** Referee configuration — a body that re-chooses deps CAUSALLY:
	 * captureRead(sel) ? captureRead(a) : captureRead(b). */
	mountReactEffectPick(rootId: RootId, sel: AnyNode, a: AnyNode, b: AnyNode, name: string): Subscription {
		const e = this.mountCommittedObserver(rootId, name);
		e.body = () => void (this.captureRead(sel) ? this.captureRead(a) : this.captureRead(b));
		this.captureRun(e.id, e.body);
		return e;
	}

	/** Newest-policy configuration (the absorbed core-effect referee shape):
	 * one node, value-gated on its newest value, flushed post-delivery-walk. */
	mountCoreEffect(node: AnyNode, name: string): Subscription {
		const e: Subscription = {
			id: this.nextEffect++, name, policy: 'newest', root: '', node: node.id,
			deps: [], refire: undefined, body: undefined,
			lastValue: this.evaluate(node, NEWEST),
			runs: 0, cleanups: 0, queuedWalk: 0, live: true, obsDeps: undefined,
		};
		this.subs.set(e.id, e);
		this.newestSubCount++;
		let byNode = this.subsByNode[node.id];
		if (byNode === undefined) {
			byNode = [];
			this.subsByNode[node.id] = byNode;
		}
		byNode.push(e);
		return e;
	}

	/**
	 * Runs a subscription body under the core capture frame: the effective
	 * world becomes committed-for-root, every routed read (raw atom reads
	 * through the host read hook, bound/overlay computed reads through
	 * `captureRead`) appends to the dep snapshot, and reads INSIDE a
	 * computed's own evaluation stay the computed's (the evaluation world on
	 * stack outranks the frame — the promoted suppression rule). A mid-body
	 * throw installs the partial snapshot: the deps read before the throw are
	 * real dependencies. After the frame closes, the snapshot's observation
	 * retains re-point (RCC-OL1: effect deps count toward the union exactly
	 * like watcher closures — the obsShift observation index).
	 */
	captureRun(id: EffectId, body: () => void): void {
		const e = this.subs.get(id);
		if (e === undefined || e.policy !== 'committed') throw new BridgeScheduleError(`unknown committed subscription ${id}`);
		if (this.captureFrame !== undefined) throw new BridgeScheduleError('captureRun frames do not nest — one effect body runs at a time');
		if (this.evalDepth > 0) throw new BridgeScheduleError('captureRun is illegal inside an open evaluation frame');
		const frame = { sub: e, deps: [] as { node: AnyNode; value: Value }[] };
		this.captureFrame = frame;
		this.syncReadRouting();
		try {
			body();
		} finally {
			this.captureFrame = undefined;
			this.syncReadRouting();
			e.deps = frame.deps;
			e.lastValue = frame.deps.length === 0 ? undefined : frame.deps[frame.deps.length - 1]!.value;
			// Observation re-point AFTER the frame closes, so discovery
			// evaluations run on a clean frame stack (same rule as obsSyncDeps).
			this.syncSubObs(e);
		}
	}

	/** A routed read inside an open capture frame (overlay-node form: the
	 * bindings' BoundComputed reads and referee bodies land here; raw kernel
	 * atom reads route through the host read hook instead). */
	captureRead(node: AnyNode): Value {
		const frame = this.captureFrame;
		if (frame === undefined) throw new BridgeScheduleError('captureRead requires an open captureRun frame');
		const v = this.evaluate(node, { kind: 'committed', root: frame.sub.root });
		frame.deps.push({ node, value: v });
		return v;
	}

	/** True while a captureRun frame is open (bindings' read-routing check). */
	captureActive(): boolean {
		return this.captureFrame !== undefined;
	}

	/**
	 * Remove a subscription (unmount / teardown). Cleanup invocation is the
	 * REGISTRAR's job (the adapter runs the user cleanup; referee
	 * configurations count it here) — guaranteed at unmount, while a make-up
	 * fire is not (RCC-EF2 amended; RCC-OL2 forbids anything after teardown:
	 * `live` flips so queued refires no-op).
	 */
	removeSubscription(id: EffectId): void {
		const e = this.subs.get(id);
		if (e === undefined) throw new BridgeScheduleError(`unknown subscription ${id}`);
		e.live = false;
		this.subs.delete(id);
		if (e.policy === 'newest') {
			this.newestSubCount--;
			const byNode = this.subsByNode[e.node];
			if (byNode !== undefined) {
				const i = byNode.indexOf(e);
				if (i >= 0) byNode.splice(i, 1);
			}
			return;
		}
		this.committedSubCount--;
		e.cleanups++;
		if (this.eventsOn) this.log({ type: 'react-effect-cleanup', effect: e.name, root: e.root });
		// Release the snapshot's observation retains + routing-coverage counts.
		const held = e.obsDeps;
		if (held !== undefined) {
			e.obsDeps = undefined;
			for (const dep of held) {
				this.subDepRefs[dep] = this.subDepRefs[dep]! - 1;
				this.obsShift(dep, -1);
			}
		}
	}

	/** Referee surface — StrictMode-style replay: cleanup + unconditional
	 * re-run + recapture. Illegal while the subscription's root has an open
	 * pass frame (React double-invokes effects post-commit, never mid-render). */
	replayReactEffect(id: EffectId): void {
		const e = this.subs.get(id);
		if (e === undefined || e.policy !== 'committed') throw new BridgeScheduleError(`unknown react effect ${id}`);
		if (this.openPassByRoot.has(e.root)) {
			throw new BridgeScheduleError('replay requires the effect root to have no open pass frame');
		}
		this.runCommittedSub(e);
		this.flushNotify();
	}

	/** The referee re-fire: cleanup + body re-run through the REAL capture
	 * frame + events (adapter-registered subscriptions instead queue their
	 * refire to the operation boundary — the adapter owns the body run). */
	private runCommittedSub(e: Subscription): void {
		if (e.refire !== undefined) {
			this.queueNotify(3, undefined, undefined, 0, e);
			return;
		}
		e.cleanups++;
		if (this.eventsOn) this.log({ type: 'react-effect-cleanup', effect: e.name, root: e.root });
		if (e.body !== undefined) this.captureRun(e.id, e.body);
		e.runs++;
		if (this.eventsOn) {
			this.log({
				type: 'react-effect-run', effect: e.name, root: e.root,
				value: e.lastValue, values: e.deps.map((d) => d.value),
			});
		}
	}

	/**
	 * The RCC-EF2 boundary re-check (amended, 2026-07-06): once per boundary
	 * OPERATION — per-root commit, retirement, settlement, quiet fold —
	 * value-gated over each subscription's dep snapshot, at the boundary
	 * value (multiple member writes coalesce), and NEVER while the
	 * subscription's own root has an open render-pass frame (the deferred
	 * flip flushes at that frame's close — commit or discard). A retirement
	 * re-checks every root (a write-free retirement still flushes pending
	 * member-write flips); a plain commit re-checks its own root. Runs at the
	 * END of the boundary operation, after every committed-side mutation of
	 * the boundary has landed (ordering joint, plan amendment 6).
	 */
	/** Host-initiated boundary re-check (public form of the scan below): the
	 * bindings call it when THEY advance a root's committed table out of band
	 * (the root-commit report's defensive delta reconciliation) — an advance
	 * the engine's own boundary sites never saw. */
	revalidateCommittedObservers(rootId: RootId): void {
		this.revalidateCommittedSubs(rootId);
		this.flushNotify();
	}

	private revalidateCommittedSubs(rootFilter: RootId | undefined): void {
		if (this.committedSubCount === 0) return;
		for (const e of [...this.subs.values()]) {
			if (e.policy !== 'committed' || !e.live) continue;
			if (rootFilter !== undefined && e.root !== rootFilter) continue;
			if (this.openPassByRoot.has(e.root)) continue; // deferred to the frame's close
			const world: World = { kind: 'committed', root: e.root };
			let changed = false;
			for (let i = 0; i < e.deps.length; i++) {
				const d = e.deps[i]!;
				let now: Value;
				try {
					now = this.evaluate(d.node, world);
				} catch (err) {
					if (err instanceof SuspendedRead) continue; // still-pending suspension: not a flip (battery 16d)
					throw err;
				}
				if (!Object.is(now, d.value)) {
					changed = true;
					break;
				}
			}
			if (changed) this.runCommittedSub(e);
		}
	}

	/**
	 * End a pass. Commit order: (1) baseline capture, (2) retirement folds
	 * due at this commit + per-root table update, (3) durable drains,
	 * (4) layout (subscribe + mount fixups) — the same order the protocol
	 * host performs the corresponding React work, so observers see states in
	 * the order the screen does. Discard: pass-owned mounts die (the tree
	 * they rendered into never existed). Deferred slot releases re-evaluate
	 * at EVERY pass end, commit and discard alike (the mask retaining a slot
	 * may just have closed).
	 */
	passEnd(id: PassId, kind: 'commit' | 'discard', opts?: { retireAtCommit?: TokenId[] }): void {
		const p = this.pass(id);
		if (p.state === 'ended') throw new BridgeScheduleError('pass already ended');
		if (kind === 'commit') {
			for (const tid of opts?.retireAtCommit ?? []) {
				const t = this.token(tid); // throws on unknown ids before any mutation
				if (!p.maskTokens.has(tid)) {
					// A retirement folded inside a commit must belong to a batch
					// this commit rendered: folding a foreign batch's receipts here
					// would advance committed truth past what this commit actually
					// put on screen. Foreign batches retire at their own closure —
					// the protocol host never sends this shape; guarded anyway.
					throw new BridgeScheduleError(`token ${tid} is not rendered by pass ${p.id}; its retirement cannot be due at this commit`);
				}
				if (t.state !== 'live' || t.parked) {
					throw new BridgeScheduleError(`token ${tid} cannot retire at this commit (already retired, or parked)`);
				}
			}
		}
		// Resolve mask token records BEFORE any retirement can reclaim them:
		// the mount fixup's fast-path clock check quantifies over the
		// committing pass's mask TOKENS as they exist at commit time (see
		// mountFixup for why tokens, not captured slots).
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
			if (this.eventsOn) this.log({ type: 'pass-discarded', pass: p.id, root: p.root });
			this.reevaluateDeferredReleases();
			this.reclaimAfterPassEnd(p);
			this.recomputeQuiet(); // pass closed (and its pin unblocked compaction): quiet may re-arm
			// EF2: the frame close is the deferred flush point for boundaries
			// that occurred while this root's frame was open (the discard
			// itself advances nothing; committed truth may already have moved).
			this.revalidateCommittedSubs(p.root);
			const tr = this.trace;
			if (tr !== undefined) tr.opEnd();
			this.flushNotify();
			return;
		}
		// (1) Baseline capture at the commit's committed-side entry.
		const baseline = { cas: this.cas, rootCommitGen: this.root(p.root).commitGen };
		// The committing tree's content: re-rendered watchers take this pass's
		// world values NOW — a watcher's last rendered value updates only at
		// committed renders, and it is the comparator later drains reconcile
		// against.
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
		// (lock-in) of every still-live mask token: this root now shows those
		// batches' writes, so its committed world must include them.
		for (const tid of opts?.retireAtCommit ?? []) this.retireInternal(this.token(tid), true);
		for (const t of maskTokenRecords) {
			if (t.state !== 'live') continue; // fully retired above: the retired clause subsumes membership
			const root = this.root(p.root);
			if (!root.committedTokens.has(t.id)) {
				root.committedTokens.add(t.id);
				if (t.slot !== undefined) root.committedBits |= 1 << t.slot;
				root.commitGen++;
				this.cas = this.mintSeq(); // committed-advance: every per-root commit bumps it
				if (this.eventsOn) this.log({ type: 'per-root-commit', root: p.root, token: t.id });
				// (3) durable drain: the advanced slot's touched list plus any
				// member-slot write drift, scoped to this root's committed
				// observers.
				const bits = (t.slot !== undefined ? 1 << t.slot : 0) | root.committedDirtySlots;
				root.committedDirtySlots = 0;
				const re = this.restaled.get(p.root);
				if (bits !== 0 || (re !== undefined && re.size > 0)) this.drainCommittedObservers(p.root, 'per-root-commit', bits);
			}
		}
		// (4) layout: subscribe, then mount fixup (matching React's layout-
		// effect phase: after commit, before paint).
		for (const wid of p.mounted) {
			const w = this.watchers.get(wid);
			if (w === undefined) continue;
			w.live = true;
			this.mountFixup(w, p, baseline, maskTokenRecords);
		}
		// Re-staled detection: a re-rendered watcher whose committed value
		// moved past its pin is stale again the moment its commit reset
		// lastRenderedValue; the NEXT durable drain reconciles it (the
		// reference model's full scan does the same, one drain later than
		// the flip).
		for (const wid of p.rendered) {
			const w = this.watchers.get(wid);
			if (w === undefined || !w.live) continue;
			const committedNow = this.evaluate(this.nodeById(w.node), { kind: 'committed', root: p.root });
			if (!Object.is(committedNow, w.lastRenderedValue)) this.markRestaled(w);
		}
		if (this.eventsOn) this.log({ type: 'pass-committed', pass: p.id, root: p.root });
		this.reevaluateDeferredReleases();
		this.reclaimAfterPassEnd(p);
		this.recomputeQuiet(); // pass closed (and its pin unblocked compaction): quiet may re-arm
		// EF2 boundary: ONE committed-subscription re-check per commit
		// operation, at the boundary value — a pass locking in two tokens
		// re-checks once, not per token (plan amendment 4's dedup rule).
		// Retirements folded into this commit moved committed truth for every
		// root, so the scan widens (each root still open-frame-deferred).
		this.revalidateCommittedSubs((opts?.retireAtCommit ?? []).length > 0 ? undefined : p.root);
		const tr = this.trace;
		if (tr !== undefined) tr.opEnd();
		this.flushNotify();
	}

	/**
	 * Mid-episode reclamation, pass-end site: the ended pass record drops
	 * (its memos and mask mappings die with it — nothing from a dead pass
	 * can validate later), and its mask tokens re-check reclaimability
	 * (the mask retention just lapsed).
	 */
	private reclaimAfterPassEnd(p: Pass): void {
		this.passes.delete(p.id);
		for (const tid of p.maskTokens) {
			const t = this.tokens.get(tid);
			if (t !== undefined) this.maybeReclaimToken(t);
		}
	}

	/** Deferred releases re-evaluate at every pass end, commit and discard alike. */
	private reevaluateDeferredReleases(): void {
		for (const s of this.slots) {
			if (!s.releasePending) continue;
			if (!this.slotRetainedByOpenMask(s.id)) this.releaseSlot(s);
		}
		// A pass ending releases its pin, which can unblock pin-gated compaction.
		this.compactAll();
	}

	private slotRetainedByOpenMask(slot: SlotId): boolean {
		for (const p of this.openPassByRoot.values()) {
			if ((p.maskBits >>> slot) & SlotBits.LOW_BIT) return true;
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
	 * Mid-episode token reclamation: a token record is reclaimable once it
	 * is retired, its slot identity is fully released (not deferred), no
	 * open pass's mask names it, and none of its receipts remain
	 * un-compacted (tapes reference tokens by id, so a token must outlive
	 * its receipts). Touched bits/lists are untouched — they are
	 * tenant-agnostic conservative dirt (keep-the-dirt discipline).
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

	/** Retirement fires exactly once per batch; parked async actions retire
	 * only at settlement (their pending state must stay pending until then). */
	retire(tokenId: TokenId, committed: boolean): void {
		const t = this.token(tokenId);
		if (t.state === 'retired') throw new BridgeScheduleError('retirement fires exactly once per token');
		if (t.parked) throw new BridgeScheduleError('parked action tokens retire only at settlement');
		this.retireInternal(t, committed);
		// EF2 boundary: retirement is a guaranteed flush point for every root
		// (a write-free retirement still flushes pending member-write flips).
		this.revalidateCommittedSubs(undefined);
		const tr = this.trace;
		if (tr !== undefined) tr.opEnd();
		this.flushNotify();
	}

	/** The async action's promise settled; the protocol host then retires the token. */
	settleAction(tokenId: TokenId, committed: boolean): void {
		const t = this.token(tokenId);
		if (!t.action) throw new BridgeScheduleError('settle targets an action token');
		if (!t.parked || t.state !== 'live') throw new BridgeScheduleError('action already settled');
		t.parked = false;
		const tr = this.trace;
		if (tr !== undefined) tr.batchSettle(t, committed);
		this.retireInternal(t, committed);
		this.revalidateCommittedSubs(undefined); // EF2 boundary: settlement is a guaranteed flush point
		if (tr !== undefined) tr.opEnd();
		this.flushNotify();
	}

	/**
	 * Retirement — the batch's writes become permanent history visible to
	 * every world. The internal order matters: stamp receipts, fold
	 * (compaction), retirement stamps + committed-advance, durable drains,
	 * clear per-root rows (the retired clause now subsumes membership), and
	 * only then release the slot (deferred if an open pass's render mask
	 * still names it). committed=false batches retire through this same
	 * path — whether writes persist never depends on who was subscribed.
	 */
	private retireInternal(t: Token, committed: boolean): void {
		if (t.state === 'live') {
			this.liveTokenCount--;
		}
		t.state = 'retired';
		t.committedFlag = committed;
		t.parked = false;
		const retiredSeq = this.mintSeq(); // one retirement sequence per retirement event
		t.retiredSeq = retiredSeq;
		// Stamp only the atoms this token actually touched (the per-token
		// touch list replaces an all-nodes/all-receipts scan).
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
				// Mint the retirement stamp per touched atom (visibility of its
				// history changed; fingerprints must reflect that).
				n.retirementStamp = retiredSeq;
				touchedAny = true;
			}
		}
		if (touchedAny) this.cas = this.mintSeq();
		// Fold/compaction (see compactAll for the two-clause predicate).
		this.compactAll();
		if (this.eventsOn) this.log({ type: 'retired', token: t.id, committed, retiredSeq });
		// Durable drains: enumerate the flipped slot's touched list (never
		// only a consumable write-time queue — entries must survive until a
		// drain actually reconciles them) and reconcile/revalidate that cone
		// against committed truth, for every root.
		{
			const slotBit = t.slot !== undefined ? 1 << t.slot : 0;
			for (const r of this.roots.values()) {
				const bits = slotBit | r.committedDirtySlots;
				r.committedDirtySlots = 0;
				const re = this.restaled.get(r.id);
				if (bits !== 0 || (re !== undefined && re.size > 0)) this.drainCommittedObservers(r.id, 'retirement', bits);
			}
		}
		// Clear per-root rows (the retired clause subsumes membership now),
		// THEN release the slot unless an open render mask names it.
		for (const r of this.roots.values()) {
			if (r.committedTokens.delete(t.id)) this.rebuildCommittedBits(r);
		}
		if (t.slot !== undefined) {
			const slot = this.slots[t.slot]!;
			if (this.slotRetainedByOpenMask(slot.id)) {
				slot.releasePending = true; // re-evaluated at every pass end
				const tr = this.trace;
				if (tr !== undefined) tr.slotReleaseDeferred(slot.id, t.id);
			} else {
				this.releaseSlot(slot);
			}
		}
		if (this.ambientToken === t.id) this.ambientToken = undefined;
		this.maybeReclaimToken(t);
		this.recomputeQuiet(); // the LAST retirement (with every tape compacted) re-arms quiet
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
	 * Compaction consumes a sequence-order prefix of the tape: entry e
	 * compacts iff every entry with seq ≤ e.seq is retired (folding out of
	 * order would change replay results) AND e.retiredSeq ≤ min(live pins)
	 * (a pass pinned earlier still folds from base, so base must not move
	 * past it). Compacted entries fold into base and are reclaimed (kept in
	 * observed by the optional `onCompact` hook).
	 */
	private compactAll(): void {
		if (this.dirtyAtoms.size === 0) return;
		const minPin = this.minLivePin();
		for (const n of this.dirtyAtoms) {
			this.compactAtom(n, minPin);
			if (n.tp.n === n.tp.start) this.dirtyAtoms.delete(n);
		}
	}

	private compactAtom(atom: AtomNode, minPin: Seq): void {
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
		const onCompact = this.onCompact;
		for (let k = 0; k < cut; k++) {
			const i = from + k;
			const next = this.applyOpPacked(atom, tp.kinds[i]!, tp.payloads[i], atom.base);
			if (atom.eqIsDefault) {
				if (!Object.is(next, atom.base)) atom.base = next;
			} else if (!this.inCallback(() => atom.equals(next, atom.base))) {
				atom.base = next;
			}
			atom.baseSeq = tp.seqs[i]!;
			if (onCompact !== undefined) onCompact(atom, tp.entryAt(i));
			// A compacted receipt stops pinning its token record.
			const tok = this.tokens.get(tp.tokens[i]!);
			if (tok !== undefined) {
				tok.liveReceipts--;
				if (tok.liveReceipts === 0) this.maybeReclaimToken(tok);
			}
		}
		tp.drop(cut);
	}

	/**
	 * Durable drain at a committed-truth flip (a retirement or per-root
	 * commit): enumerate the flipped slot's touched list (watcher sets
	 * resolve at drain time), reconcile-check each listed live watcher
	 * (last rendered value vs committed-for-root NOW; urgent pre-paint
	 * correction on real difference — comparing values is legal here
	 * because both sides are committed truth, whereas live-write delivery
	 * must stay value-blind). Candidates fire in id order (the reference
	 * model's map order); the touched lists conservatively contain every
	 * node a slot's writes could reach, so scoping to them reaches every
	 * observer a full scan would, and the value gate makes the outcomes
	 * identical. Committed SUBSCRIPTIONS do not drain here: their re-check
	 * is once per boundary operation (revalidateCommittedSubs) — RCC-EF2's
	 * amended boundary semantics — and needs no candidate collection at all
	 * (per-root full scan, v1 = production cost).
	 */
	private drainWatcherBuf: Watcher[] = [];

	/**
	 * Watchers re-staled by their own commit: the commit reset
	 * lastRenderedValue to the pass world's pin-old value while committed
	 * truth had already moved past the pin. The reference model catches
	 * these at its next full-scan drain; the engine keeps the precise set
	 * and folds it into the next durable drain on the watcher's root.
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

	private drainCommittedObservers(rootId: RootId, cause: 'retirement' | 'per-root-commit', slotBits: SlotSet): void {
		const world: World = { kind: 'committed', root: rootId };
		const gen = ++this.walkGen; // reuse the walk column for per-drain candidate dedup
		const lastWalk = this.lastWalk;
		const ws = this.drainWatcherBuf;
		ws.length = 0;
		// Candidate collection: the flipped slots' touched lists, expanded over
		// WEAK (untracked) out-edges — strong cones are already fully listed.
		const stack = this.walkStack;
		let sp = 0;
		let sb = slotBits;
		while (sb !== 0) {
			const slot = SlotBits.MSB_INDEX - Math.clz32(sb & -sb);
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
		for (let i = 0; i < ws.length; i++) {
			const w = ws[i]!;
			const now = this.evaluate(this.nodeById(w.node), world);
			if (!Object.is(now, w.lastRenderedValue)) {
				if (this.eventsOn) this.log({ type: 'reconcile-correction', watcher: w.name, root: rootId, from: w.lastRenderedValue, to: now, cause });
				w.lastRenderedValue = now; // the urgent pre-paint re-render
				w.dedupBits = 0; // dedup bits re-arm at the watcher's render
				if (this.onCorrection !== undefined) this.queueNotify(2, w, undefined, 0);
			}
		}
		ws.length = 0;
	}

	// ---------------------------------------------------------- mount fixup

	/**
	 * Mount fixup — runs in the mounting component's layout effect (after
	 * commit, before paint), after subscription. Why it exists: a component
	 * can mount while other updates are in flight, and its subscription only
	 * activates at commit, so writes could slip by unobserved between its
	 * render and its commit. Two mechanisms close the window:
	 *  1. value-blind corrective re-renders join each live batch that
	 *     touched the node but was not part of this render — the component
	 *     joins the pending update in that batch's own lane instead of
	 *     revealing it early or missing it;
	 *  2. one comparison against the mount's own world fast-forwarded to
	 *     committed-now catches whatever retired or locked in during the
	 *     window — fixed urgently, before paint.
	 * Two subtle rules, both asserted by the lockstep tests: the fast-path
	 * clock check quantifies over the committing pass's member TOKENS at
	 * commit time (not just the slot set captured at render start — a token
	 * whose first write landed mid-render interned its slot after the
	 * capture, so the slot-quantified form would miss its writes), and any
	 * divergence the fast path suppresses must be exactly covered by the
	 * scheduled correctives (checked on every mount).
	 */
	private mountFixup(w: Watcher, committingPass: Pass, baseline: { cas: Seq; rootCommitGen: CommitGen }, maskTokenRecords: Token[]): void {
		const node = this.nodeById(w.node);
		const closure = this.dependencyClosureOf(w.node);
		// Per-token corrective loop: every LIVE written token that touched the
		// node. A premise of the fast path's soundness, not an optimization:
		// it covers exactly the divergence the fast-out suppresses.
		const correctedLive = new Set<TokenId>();
		for (const t of this.tokens.values()) {
			if (t.state !== 'live' || t.slot === undefined) continue;
			if (!this.tokenTouches(t, closure)) continue;
			const slot = this.slots[t.slot]!;
			// Fully included (slot ∈ includedSet ∧ no post-pin write): skip — never by value.
			if (w.snapshot.includedSlots.has(slot.id) && slot.writeClock <= w.snapshot.pin) continue;
			if (this.eventsOn) this.log({ type: 'mount-corrective', watcher: w.name, token: t.id, slot: slot.id });
			correctedLive.add(t.id);
			w.dedupBits |= 1 << slot.id; // the corrective is a state update scheduled into t's lane (the protocol's runInBatch)
			if (this.onMountCorrective !== undefined) this.queueNotify(1, w, t, slot.id);
		}
		// The four-conjunct fast-out: same pass, no committed-truth advance,
		// no per-root commit, clocks quiet. The clock conjunct checks the
		// captured mask slots AND the committing pass's mask tokens at commit
		// time — a mask token whose first write interned its slot mid-pass is
		// invisible to the slot-quantified form, because the slot set was
		// captured at pass start, before that slot existed.
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
		const tr = this.trace; // one disposition record per mount fixup
		if (fastOut) {
			if (!Object.is(vFx, w.lastRenderedValue)) {
				// Audit: divergence under a passing fast-out must be exactly
				// covered by the scheduled correctives — otherwise the fast
				// path just suppressed a real correction. The audit world
				// keeps what the render itself saw of the excluded tokens:
				// its full included set at its pin.
				const vCovered = this.evaluate(node, {
					kind: 'mountFix', maskSlots: w.snapshot.includedSlots, pin: w.snapshot.pin,
					root: w.root, excludeLiveTokens: correctedLive,
				});
				if (!Object.is(vCovered, w.lastRenderedValue)) {
					throw new BridgeInvariantViolation(
						`fast-out unsound: watcher ${w.name} fast-out held but the fixup value ${String(vFx)} differs from the rendered value ${String(w.lastRenderedValue)} and the residue is not covered by the scheduled correctives`,
					);
				}
				if (tr !== undefined) tr.mountFixup(w, 'fast-out-covered', correctedLive.size);
				return;
			}
			if (tr !== undefined) tr.mountFixup(w, 'fast-out', correctedLive.size);
			return; // zero corrections — value-neutral modulo scheduled correctives
		}
		if (!Object.is(vFx, w.lastRenderedValue)) {
			if (this.eventsOn) this.log({ type: 'mount-urgent-correction', watcher: w.name, from: w.lastRenderedValue, to: vFx });
			w.lastRenderedValue = vFx; // urgent pre-paint correction
			w.dedupBits = 0;
			if (this.onCorrection !== undefined) this.queueNotify(2, w, undefined, 0);
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

	// ------------------------------------------- episodes and quiescence

	/** Synchronously abandons every work-in-progress pass. */
	discardAllWip(): void {
		for (const p of [...this.openPassByRoot.values()]) {
			this.passEnd(p.id, 'discard');
		}
	}

	quiescent(): boolean {
		return this.liveTokenCount === 0 && this.openPassByRoot.size === 0;
	}

	/**
	 * Quiescence (no live tokens, no live pins, no parked actions): the K1
	 * union table bulk-resets (epoch bump), and every K1-touched node holding
	 * a committed watcher or effect-dep snapshot refreshes by a forced kernel
	 * pull into the NEW episode's K1 table — the walks route over K1, so
	 * the coverage those observers rely on must be re-recorded, not lost
	 * with the old table.
	 *
	 * SEQUENCE-WIDTH BOUND (where renumbering used to live). Retained
	 * sequence values (baseSeq, retirement stamps, cas, watcher snapshot
	 * pins) are NOT rewritten at quiescence: sequences are plain JS numbers,
	 * exact for integers to 2^53, they are only ever compared (<, <=, max —
	 * never bit-twiddled), and every storage site is a scalar field or a
	 * plain number array, so the engine stays correct until 2^53 mints —
	 * about 28 years at a sustained 10M writes/sec. Renumbering was measured
	 * (grind batch 4, item C): forcing every seq past SMI range (2^35) on
	 * tape-heavy shapes moved fold/write throughput by ~1% — within noise,
	 * below the 2% keep threshold — so the machinery was deleted. One
	 * diagnostics caveat: `cosignal/trace` packs seqs into Int32 records,
	 * so trace decode fidelity (not engine correctness) degrades past
	 * 2^31-1 minted sequences.
	 */
	quiesce(): void {
		if (!this.quiescent()) throw new BridgeScheduleError('quiescence requires no live tokens, pins, or parked actions');
		// Residue check: with no live pins, the last retirement compacted every tape.
		for (const n of this.nodes.values()) {
			if (n.kind === 'atom' && n.tp.n > n.tp.start) {
				throw new BridgeInvariantViolation(`quiescence residue: atom ${n.name} still holds ${n.tp.n - n.tp.start} receipts`);
			}
		}
		// Collect the refresh targets BEFORE the reset: every K1-touched
		// node holding a committed watcher or effect-dep snapshot.
		const refreshTargets: ComputedNode[] = [];
		for (let id = 0; id < this.nodesArr.length; id++) {
			const n = this.nodesArr[id];
			if (n === undefined || n.kind !== 'computed') continue;
			if (this.outList[id] === undefined && this.inList[id] === undefined) continue; // not K1-touched
			const ws = this.watchersByNode[id];
			if ((ws === undefined || ws.length === 0) && this.subDepRefs[id]! === 0) continue;
			refreshTargets.push(n);
		}
		this.epoch++;
		// K1 bulk-reset + table watermark zeroes.
		this.outSets.length = 0;
		this.outList.length = 0;
		this.inList.length = 0;
		this.edgeCount = 0;
		this.lastSweepEdges = 0;
		this.weakOutSets.length = 0;
		this.weakOutList.length = 0;
		for (let i = 0; i < this.touched.length; i++) this.touched[i] = 0;
		for (const list of this.slotTouched) list.length = 0;
		// Dead-episode records drop at the reset: nothing from a dead
		// episode can validate in a live one; serial counters stay monotone.
		for (const [id, p] of this.passes) {
			if (p.state === 'ended') this.passes.delete(id);
		}
		for (const [id, t] of this.tokens) {
			if (t.state === 'retired') this.tokens.delete(id);
		}
		this.lastTokenId = 0;
		this.lastTokenRef = undefined;
		// Memo tables die by epoch; drop them eagerly (conservative refusal).
		for (const r of this.roots.values()) r.memos.clear();
		this.newestMemos.clear();
		// Kernel-pull refresh, AFTER the reset: a fresh newest evaluation of
		// each target re-records its dependency cone into the NEW episode's
		// K1 table. World evaluations reject writes, so the refresh cannot
		// loop; a pull that throws keeps its sentinel and stays on the
		// demand path.
		for (const n of refreshTargets) {
			try {
				this.evaluate(n, NEWEST);
			} catch {
				// erroring getters keep their throw-on-demand behavior
			}
		}
		// Dead-episode bookkeeping zeroes (bulk-zero at episode reset).
		for (const s of this.slots) {
			s.writeClock = 0;
			s.claimSeq = 0;
			s.carriedMaxRetiredSeq = 0;
			s.releasePending = false;
		}
		for (const w of this.watchers.values()) w.dedupBits = 0;
		if (this.eventsOn) this.log({ type: 'epoch-reset', epoch: this.epoch });
		this.recomputeQuiet(); // quiescent by definition; re-derive from the new episode's state
		const tr = this.trace;
		if (tr !== undefined) tr.opEnd();
		this.flushNotify();
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

	/** Referee surface — read by twin tests and trace.spec; engine logic and
	 * the shim consume `eventsSince`/`eventCursor` instead. */
	eventsOfType<T extends BridgeEvent['type']>(type: T): Extract<BridgeEvent, { type: T }>[] {
		return this.events.filter((e): e is Extract<BridgeEvent, { type: T }> => e.type === type);
	}

	/** Events appended after a caller-captured watermark (absolute cursor; test/shim surface). */
	eventsSince(mark: number): BridgeEvent[] {
		return this.events.slice(Math.max(0, mark - this.eventsBase));
	}
}

// One Core: this module is internal machinery of the single `cosignal` entry
// (src/index.ts imports and re-exports it). It adds `registerReactBridge`,
// the bridge class, and the bridge-surface types to the base API.
