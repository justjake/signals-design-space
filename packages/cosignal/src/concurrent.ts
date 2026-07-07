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
 *     (the packed records in index.ts), which only knows newest values. The
 *     other is the per-world SHADOW ARENAS (NF2, plans/2026-07-06 §4): one
 *     packed record plane per pass world and per committed-for-root world,
 *     holding a SHADOW (value + flags) per consumed node and the strong and
 *     weak-flagged LINKS the world's own evaluations actually took. Arenas
 *     are the routing AND serving authority for pass/committed worlds:
 *     write-time deliveries walk arena strong links, durable drains seed
 *     from arena dirty lists, and world reads serve from arena walks.
 *     Committed-truth flips FAN OUT marks into the arenas at four sites
 *     (§4.3): retirement, per-root lock-in, committed-member write, and
 *     quiet fold — plus L4 resource settlement.
 *   - NEWEST COMPUTED SERVING is the kernel's (S-C: one computed). Every
 *     bridge computed rides a kernel `Computed` record: the kernel's own
 *     dep links, staleness marks, and value cache serve the newest world,
 *     so a computed re-derives only when a TRACKED dependency changed —
 *     untracked reads are point-in-time samples taken at those
 *     re-derivations [ruling 2026-07-06: untracked sampling]. Kernel atoms
 *     serve newest directly (the eager-apply invariant); everything else
 *     folds.
 *   - An EPISODE is the stretch between QUIESCENCE points — moments when
 *     nothing is in flight (no live batches, no open passes, no PARKED
 *     actions — async actions kept pending until their promise settles).
 *     At quiescence zero-consumer committed arenas reclaim; populated
 *     arenas PERSIST — their links are current structure, not an episode
 *     log (§4.1) — and the kernel's newest caches persist the same way
 *     (nothing newest-visible changes at quiescence). Sequence values are
 *     NEVER rewritten: the global counter climbs monotonically for the
 *     process's life (exact to 2^53 — see the bound note at `quiesce`).
 *
 * What lives here (full stories at the implementation sites):
 *   - receipts: every write appends {op, slot, seq, retiredSeq} to the
 *     written atom's tape.
 *   - kernel riding: every recorded write also applies to the kernel eagerly
 *     with stepwise equality (each step keeps the previous reference when
 *     the atom's equals function says nothing changed) — bridge atoms are
 *     kernel-backed `Atom` handles, and the newest world is read straight
 *     off the kernel. The engine-vs-reference-model diff verifies kernel
 *     value ≡ fold(base, receipts) at every step of the test corpus.
 *   - arena routing (NF2 S-B): write-time delivery reachability runs from
 *     the written atom over every live arena's STRONG links (weak links are
 *     tested and skipped — untracked reads never notify); kernel (K0)
 *     subscribers are served by the eager kernel apply. Deliveries stay
 *     value-blind and may be FEWER than the model's union-conservative set
 *     (never more): a cone reachable only through structure no live arena
 *     holds lane-degrades to a drain correction (§4.4.5, pinned S-NF2-D1).
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
 *     freshly mounted component — contract clause RT6, decided conditions
 *     first. A component can mount while other updates are in flight, and
 *     its subscription only activates at commit, so writes could slip by
 *     unobserved between its render and its commit; fixup joins it to the
 *     pending batches it missed (from write metadata alone), then a
 *     four-condition test decides whether anything committed or retired in
 *     the window — only a failing condition triggers the fast-forwarded
 *     re-evaluation and urgent pre-paint correction. One subtle rule: the
 *     write-clock condition quantifies over the committing pass's member
 *     tokens at commit time (a token whose first write landed mid-render
 *     is invisible to the earlier-captured slot set).
 *   - subscriptions (see the Subscription type): the ONE `run`-action
 *     consumer record — committed subscriptions, the PROMOTED production
 *     useSignalEffect mechanism. (Core `effect()`s are NOT bridge records:
 *     they are real kernel effects, flushed by the eager kernel apply —
 *     see logCoreEffectRun.) Committed subscriptions
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
 *   TODO(perf): a "provably quiet" world-read fast path (serve a shared
 *     cache instead of the arena walk when nothing pending can reach the
 *     node). CORRECTNESS CONSTRAINT (fable N-4, §4.4.8): the cold in-arena
 *     fn run is what RECORDS the strong and weak links the whole routing
 *     coverage argument stands on — a re-entry may value-serve ONLY when
 *     the arena already holds the node's links; structure recording may
 *     never be skipped. The B1 read-before-pending pin is the tripwire.
 */

import { Atom, Computed, CycleError, LinkField, NodeField, NodeFlag, SuspendedRead, untracked, __assertHostWritable, __ctxUse, __hostApplySet, __hostDisposeComputed, __hostReadNewest, __hostMarkComputedOwned, __hostRunFold, __hostWrapComputedFn, __kernelBuffer, __kernelComputedRead, __lifecycleRelease, __lifecycleRetain, __setHostComputedRead, __setHostRead, __setHostWrite, __setSettleTap, __HOST_MISS, type ComputedCtx, type HostOpKind } from './index.js';

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
/** A 31-bit slot set: bit i = slot i (mask/included/committed/dedup words). */
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

/**
 * A receipt: one recorded write — {op, slot, seq} appended at the write,
 * retiredSeq stamped at the batch's retirement. Receipts denormalize their
 * slot at mint: slots are recycled identities, so visibility checks must read
 * the slot the write happened under, not the token's current slot (which may
 * already be released); the token id is carried for invariants and event
 * logs only. Receipts live int-packed in per-atom `Tape` columns ({kind,
 * slot, seq, retiredSeq, token} parallel number columns + one unknown[]
 * payload side column); this materialized object shape — including the
 * object-shaped `op` (a write operation: set/update; a ReducerAtom dispatch
 * records as an update whose closure captures the reducer and the action) —
 * is the test/trace surface only (`Tape.materialize()`, trace `receipt`
 * hook). The write path itself carries the (kind, payload) scalar pair end
 * to end and never builds it.
 */
export type Receipt = {
	op: { kind: 'set'; value: Value } | { kind: 'update'; fn: (prev: Value) => Value };
	token: TokenId;
	slot: SlotId;
	seq: Seq;
	retiredSeq: Seq | undefined;
};

/** Op-kind tags: the packed receipt column AND the write surface's kind
 * argument (`write`/`bareWrite`) — 0 = set, 1 = update, the
 * same codes the kernel's host write hook captures (`HostOpKind`; the two
 * share the 0/1 encoding by construction, and 0/1 literals are assignable
 * here, so cross-file callers never name this type). Same-file const enum so
 * every esbuild-based toolchain inlines the codes as literals. */
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

	opAt(i: number): Receipt['op'] {
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
	/** True iff `equals` is the default Object.is — eqAtom's branch: the
	 * default compares bare, a custom comparator runs under the fold-purity
	 * guard. */
	eqIsDefault: boolean;
	/** Per-atom retirement stamp, minted at every retirement fold touching it.
	 * Sole remaining consumer: retireInternal's duplicate-touch dedup (the
	 * memo ladder that read it as a fingerprint clock is deleted — S-C/S-D). */
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

/**
 * The bridge's computed node record (S-C: one computed — no overlay
 * representation). Every bridge computed RIDES a kernel `Computed` record:
 * the kernel serves the newest world (links, marks, value cache — the
 * sampled-untracked rule falls out of kernel semantics), and the bridge
 * evaluates `fn` under pass/committed worlds through the arena walks. For
 * bridge-created computeds `fn` is the authored (read, untracked) function;
 * for adopted public `Computed` handles it is the bridge's ctx adapter
 * (committed `previous` cell, `use` over the handle's own `_useCache`,
 * background-suspension fold) around the handle's raw fn.
 */
export type ComputedNode = {
	kind: 'computed';
	id: NodeId;
	name: string;
	/** The WORLD evaluation function (arena refolds, mount-fix folds). */
	fn: ComputedFn;
	/** The kernel record this node rides (newest serving + kernel links). */
	handle: Computed<unknown>;
	/** True for adopted public handles (ctx-shaped raw fns): their world fn
	 * is the bridge's ctx adapter, and background newest reads fold pending
	 * suspensions to sentinel values (the old shim-wrapper translation). */
	ctxShaped: boolean;
	/** §4.5.3 retention: the policy comparator (HEAD order `isEqual(prev,
	 * next)`), applied by arena refolds against the ARENA-local previous
	 * value; undefined = default equality (Object.is). */
	isEqual: Equals | undefined;
	/** ctx.previous cell for adopted ctx-shaped fns: the node's last
	 * COMMITTED value (a best-effort hint; may be stale or undefined),
	 * updated at pass commits from the watchers that rendered it. */
	prevCell: { value: Value };
};

export type AnyNode = AtomNode | ComputedNode;

export type Token = {
	id: TokenId;
	action: boolean;
	parked: boolean;
	state: 'live' | 'retired';
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
	 * claims it (the mount fixup's clock conjunct compares it against
	 * snapshot pins). */
	writeClock: Seq;
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
	/** The pass's slot sets (bit i = slot i; SlotId < 31), fixed at pass
	 * start: maskBits — slots of the render mask's written tokens;
	 * includedBits — maskBits ∪ the root's committed slots captured at start
	 * (every batch this render is allowed to see). */
	maskBits: SlotSet;
	includedBits: SlotSet;
	state: PassState;
	endKind: 'commit' | 'discard' | undefined;
	/** Watchers whose layout effects (subscribe + fixup) fire at this pass's
	 * commit: its own mounts plus adopted reveals. Disjoint from `rendered`. */
	mounted: WatcherId[];
	/** Existing live watchers re-rendered by this pass — re-renders ONLY
	 * (disjoint from `mounted`; where pass-end means the union it writes the
	 * union explicitly). */
	rendered: Set<WatcherId>;
	/** NF2: the pass world's shadow arena — its value+invalidation+routing
	 * layer (claimed at passStart, dropped in reclaimAfterPassEnd —
	 * engine-side only; the oracle has no twin). */
	arena?: ShadowArena;
};

export type RootState = {
	id: RootId;
	/** Per-root lock-in rows: batches this root has committed but that are
	 * still live elsewhere (cleared at retirement, when the retired clause
	 * subsumes membership). */
	committedTokens: Set<TokenId>;
	commitGen: CommitGen;
	/** The root's CURRENT committed-slot set (live committed tokens' slots)
	 * — maintained at per-root commit, late slot intern, and retirement. */
	committedBits: SlotSet;
	/** Member slots written since the last drain. A write into a slot that is
	 * already a committed member changes committed truth immediately, so the
	 * next durable drain must reconcile everything downstream of it (the
	 * reference model's full observer scan catches this at any
	 * retirement/commit; the engine keeps the precise dirty set instead). */
	committedDirtySlots: SlotSet;
};

/** The watcher's rendered-world snapshot: what the mounting render saw
 * (the pass's slot sets copied by integer assignment — see Pass). */
export type WatcherSnapshot = {
	passId: PassId;
	pin: Seq;
	maskBits: SlotSet;
	includedBits: SlotSet;
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
 * promotion, plans/2026-07-06): the PROMOTED production `useSignalEffect`
 * mechanism (previously the adapter's EffectRec). A subscription is a
 * registration saying WHO is notified and IN WHICH WORLD its reads resolve;
 * `deliver`-action consumers (component re-renders) remain `Watcher`
 * structurally — their state is untouched, the unification is of the firing
 * machinery. `deps` is the (node, value) snapshot `captureRun` recorded
 * under the committed world of the subscription's root; re-checks are
 * value-gated over it and fire at RCC-EF2's amended BOUNDARIES (per-root
 * commit, retirement, settlement, quiet fold; one re-check per boundary
 * operation, at the boundary value, never while the subscription's own root
 * has an open render-pass frame — deferred flips flush at that frame's
 * close). `refire` (adapter-registered) rides the operation-boundary
 * notification queue; referee-configured subscriptions (tests/helpers.ts's
 * mountEngineReactEffect/-Pick) store a `body` and re-run it inline through
 * the SAME capture frame, so lockstep referees the real mechanism.
 *
 * Core `effect()`s hold no Subscription: they are REAL kernel effects,
 * flushed by the eager kernel apply (see logCoreEffectRun).
 */
export type Subscription = {
	id: EffectId;
	name: string;
	/** Owning root. */
	root: RootId;
	/** Dep snapshot: the routed reads of the last run, in read order. */
	deps: { node: AnyNode; value: Value }[];
	/** Adapter-owned refire (cleanup + body scheduling), queued at the
	 * operation boundary; undefined for referee-configured subscriptions. */
	refire: (() => void) | undefined;
	/** Referee-configured body (re-run inline through the capture frame). */
	body: (() => void) | undefined;
	/** Last captured value (the last dep read). */
	lastValue: Value;
	runs: number;
	cleanups: number;
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
	| { kind: 'mountFix'; maskBits: SlotSet; pin: Seq; root: RootId };

/** The one newest-world singleton (hot paths never allocate world objects). */
const NEWEST: World = { kind: 'newest' };

/** The DECODED shape of the engine's observable events (same shapes as the
 * reference model's events, so the two can be compared entry by entry). The
 * engine constructs these objects NOWHERE: instrumentation sites mint packed
 * trace records directly (see TraceHooks below), and the test-side decoder
 * (tests/trace-events.ts) reconstructs this shape from an attached tracer's
 * records for lockstep/referee comparison. The type stays declared and
 * exported here because the package entry re-exports it (type-only) and the
 * decoder/oracle parity pin is written against it. */
export type BridgeEvent =
	| { type: 'write'; node: string; token: TokenId; slot: SlotId; seq: Seq }
	| { type: 'write-dropped'; node: string; token: TokenId }
	/** A quiet-mode fold: the whole write while nothing was pending — no
	 * token, no receipt, no slot; `seq` is the fold's minted sequence (the
	 * atom's new baseSeq and the committed-advance clock). */
	| { type: 'quiet-write'; node: string; seq: Seq }
	| { type: 'delivery'; watcher: string; token: TokenId; slot: SlotId; seq: Seq; mode: 'fresh' | 'interleaved' }
	| { type: 'suppressed'; watcher: string; token: TokenId; slot: SlotId; seq: Seq }
	| { type: 'core-effect-run'; effect: string; value: Value }
	| { type: 'react-effect-run'; effect: string; root: RootId; value: Value; values: Value[] }
	| { type: 'react-effect-cleanup'; effect: string; root: RootId }
	| { type: 'reconcile-correction'; watcher: string; root: RootId; from: Value; to: Value; cause: 'retirement' | 'per-root-commit' }
	| { type: 'mount-corrective'; watcher: string; token: TokenId; slot: SlotId }
	| { type: 'mount-urgent-correction'; watcher: string; from: Value; to: Value }
	| { type: 'per-root-commit'; root: RootId; token: TokenId }
	| { type: 'retired'; token: TokenId; retiredSeq: Seq }
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
 *    mutate them, and the recorder must not allocate per event (one
 *    documented exception: `reactEffectRun`'s dep-values array, built by its
 *    site only under the guard — the lockstep referee compares it).
 *
 * ONE channel: the packed trace stream. Every instrumentation site mints its
 * record directly through a typed hook — scalars and live engine objects in,
 * one fixed-size record out; no intermediate event object exists anywhere.
 * The hook set covers the observable event vocabulary (`BridgeEvent`, decoded
 * test-side) plus trace-only semantics: batch open/settle, pass
 * start/yield/resume/end (fired BEFORE the end's consequences, unlike the
 * post-consequence passCommitted/passDiscarded markers), per-receipt ops,
 * world evaluations, deferred slot release, and the mount fixup disposition
 * (fast-out vs compare vs correction). `opEnd()` marks the close of each
 * compound public operation so the recorder can scope causality (see
 * trace.ts `CAUSE`).
 */
export type TraceHooks = {
	/** A receipt was minted — THE write record (carries op/token/slot/seq). */
	receipt(node: AtomNode, r: Receipt): void;
	/** A write dropped without a receipt (empty tape + equal against base). */
	writeDropped(node: AtomNode, token: TokenId): void;
	/** A quiet-mode fold accepted (no token, no receipt; seq = the fold's clock). */
	quietWrite(node: AtomNode, seq: Seq): void;
	/** A batch token was minted. */
	batchOpen(t: Token): void;
	/** An async-action token settled (its retirement follows). */
	batchSettle(t: Token): void;
	/** The external runtime's committed/abandoned report for a batch. Minted
	 * by the BINDINGS' protocol handler — the site where the fact is born —
	 * never by the engine: retirement itself is disposition-blind (recorded
	 * writes never revert either way), so the flag exists only as this
	 * source-side diagnostic record. */
	batchDisposition(token: TokenId, committed: boolean): void;
	/** Pass edges (end fires before retirements/commits/fixups). */
	passStart(p: Pass): void;
	passYield(p: Pass): void;
	passResume(p: Pass): void;
	passEnd(p: Pass, kind: 'commit' | 'discard'): void;
	/** Post-consequence referee markers: every retirement fold / lock-in /
	 * drain / fixup of the pass end has landed (the reference model's stream
	 * position for its pass events). */
	passCommitted(p: Pass): void;
	passDiscarded(p: Pass): void;
	/** A value-blind delivery reached a live watcher. */
	delivery(w: Watcher, token: TokenId, slot: SlotId, seq: Seq, interleaved: boolean): void;
	/** Delivery skipped: scheduled-but-unstarted work will fold the write. */
	suppressed(w: Watcher, token: TokenId, slot: SlotId, seq: Seq): void;
	/** A core effect's value-gated run (via the bridge's logCoreEffectRun seam). */
	coreEffectRun(effect: string, value: Value): void;
	/** A committed-world observer ran; `values` is its dep snapshot (the one
	 * per-event array a site builds, tracer-attached only — referee-compared). */
	reactEffectRun(effect: string, root: RootId, value: Value, values: Value[]): void;
	/** A committed-world observer's cleanup ran (pre-re-run or removal). */
	reactEffectCleanup(effect: string, root: RootId): void;
	/** A drain moved this watcher's on-screen value to follow committed truth. */
	reconcileCorrection(w: Watcher, root: RootId, from: Value, to: Value, perRootCommit: boolean): void;
	/** Mount catch-up: a corrective re-render joined a live batch's lane. */
	mountCorrective(w: Watcher, token: TokenId, slot: SlotId): void;
	/** The urgent pre-paint mount-window fix. */
	mountCorrection(w: Watcher, from: Value, to: Value): void;
	/** A root locked a batch in; commitGen is the root's (just-bumped) generation. */
	perRootCommit(root: RootId, token: TokenId, commitGen: CommitGen): void;
	/** The batch retired: its writes became permanent history. */
	retired(token: TokenId, retiredSeq: Seq): void;
	/** Slot lifecycle (claim / identity release / loud backstop eviction). */
	slotClaimed(slot: SlotId, token: TokenId): void;
	slotReleased(slot: SlotId, token: TokenId): void;
	slotBackstopReleased(slot: SlotId, token: TokenId): void;
	/** A computed evaluation in a world opened/closed (paired; end fires on throw too). */
	evalStart(node: ComputedNode, world: World): void;
	evalEnd(): void;
	/** A retired tenant's release was deferred (an open render mask names the slot). */
	slotReleaseDeferred(slot: SlotId, token: TokenId): void;
	/** One per mount: how fixup resolved, and how many correctives were scheduled. */
	mountFixup(
		w: Watcher,
		disposition: 'fast-out' | 'compare-clean' | 'corrected',
		correctives: number,
	): void;
	/** Quiescence reset the engine's per-episode state. */
	epochReset(epoch: Epoch): void;
	/** A compound public operation (write / passEnd / retire / settle / quiesce) finished. */
	opEnd(): void;
};

const SLOT_COUNT = 31; // at most 31 live batches — one per React lane, and slot sets fit one int bit mask.

// ---- module state + the concurrent operation table ------------------------------

/** The bridge whose registered atoms the host hooks route for (one active). */
let activeBridge: CosignalBridge | undefined;
/** True while the bridge itself is applying a recorded write to the kernel
 * (the host write hook's recursion guard: the apply re-enters `Atom.set`). */
let bridgeApplying = false;
/** The public registerReactBridge() has been consumed (it may run only once). */
let publiclyRegistered = false;

// ---- One Core probes (referee surface) --------------------------------------------
// One module-wide counter record proving the zero-cost promise behaviorally:
// with no bridge registered, heavy signal traffic must leave every field at
// its baseline (tests/one-core.spec.ts). Engine logic never reads them.
// (The old bridgeEvents probe died with the object-event channel: events are
// packed trace records now, minted only behind each site's tracer guard —
// with no tracer attached there is no event machinery left to count.)
const probes = { receipts: 0, tokens: 0, worldEvals: 0, bridges: 0 };

/** Referee surface — a snapshot of the engine-activity counters for the zero-cost test. @internal */
export function __coreProbes(): { receipts: number; tokens: number; worldEvals: number; bridges: number } {
	return { ...probes };
}

// ---- the host-hook implementations (installed into index.ts's public methods) -----

/**
 * The host write interceptor: a public write is attributable to a batch when
 * a bridge is registered and the write is not the bridge's own kernel apply.
 * The bindings' classifier (when installed) owns classification — batch
 * context, adoption-on-first-write, render guard; without bindings, writes to
 * REGISTERED atoms classify into the ambient default batch and everything
 * else takes the plain kernel path. The public method's scalar
 * (kind, payload) pair passes through unchanged — no op object exists on
 * this path (HostOpKind and OpKind share the 0/1 encoding by construction).
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
		classify(atom, kind, payload);
		return true;
	}
	const node = b.nodeFor(atom); // the ONE stamp-validate + registry-probe rule
	if (node === undefined) {
		return false; // unregistered and no adopter: exactly base semantics
	}
	if (b.quiet) {
		// Quiet mode: nothing is pending, so the whole write is one fold —
		// no ambient batch, no receipt, no walk (Phase 1b).
		b.__quietWrite(node, kind, payload);
		return true;
	}
	b.bareWrite(node, kind, payload);
	return true;
}

/** The host read router (armed only while a routing context is live). */
function hostReadImpl(atom: Atom<unknown>): unknown {
	return activeBridge === undefined ? __HOST_MISS : activeBridge.hostRead(atom);
}

/** The host COMPUTED read router (S-C twin of hostReadImpl; armed together). */
function hostComputedReadImpl(c: Computed<unknown>): unknown {
	return activeBridge === undefined ? __HOST_MISS : activeBridge.hostComputedRead(c);
}

/** NF2 S-A: the settle-tap router (ONE closure per process; the kernel's
 * shared listener consults it at fire time — §4.5.4). */
function settleTapImpl(t: PromiseLike<unknown>): void {
	const b = activeBridge;
	if (b !== undefined) b.__settleTap(t);
}

/** An arena buffer capacity, counted in Int32 slots (stride-8 records: one
 * node shadow or one dependency link per record). */
export type ArenaInitInts = number;

/** Construction-time bridge tuning (the bridge-level analog of the kernel's
 * `configure()`). */
export type BridgeOptions = {
	/**
	 * Every claimed shadow arena's buffer starts at this capacity and grows
	 * in place when its records outgrow it (default 8192 ints). Shrinking it
	 * makes even small graphs exercise mid-operation growth, which is how the
	 * arena suites pin every growth path.
	 */
	arenaInitInts?: ArenaInitInts;
	/**
	 * Arms development-time checks in the bindings driving this bridge:
	 * protocol-edge states the host integration contract makes unreachable
	 * (a write with no batch context, a render pass starting over a
	 * still-open one, a transition with no batch context) throw instead of
	 * taking their defined fall-through, and dev-only diagnostics (the
	 * post-await orphan-write warning) run. The engine itself never branches
	 * on it — it lives here so hosts and bindings share one switch. Default
	 * off: each guarded site then costs one boolean branch and allocates
	 * nothing. Test harnesses arm it so suites exercise the throws.
	 */
	devChecks?: boolean;
};

/**
 * Activates the concurrent engine: arms the kernel's host seams
 * (`__setHostWrite` / read routing), exactly once per process, and returns
 * the bridge that the React bindings (or a test driver simulating them)
 * drive with protocol events. Throws inside any open evaluation/fold frame
 * (the seams must not arm under a live kernel frame) and on
 * re-registration.
 */
export function registerReactBridge(options?: BridgeOptions): CosignalBridge {
	if (publiclyRegistered) {
		throw new Error('cosignal: registerReactBridge may only be called once per process.');
	}
	const bridge = new CosignalBridge(options);
	bridge.registerBridge(); // arms the seam + marks the bridge registered
	publiclyRegistered = true;
	return bridge;
}

/**
 * Test-only: a fresh, unregistered bridge instance (the per-schedule "fresh
 * model" analog — the module seam still arms only once per process; kernel
 * records of abandoned bridges are inert). Referees that need the event
 * stream attach a lossless session tracer themselves (tests/trace-events.ts)
 * — observation via the tracer does not perturb: the bridge keeps PRODUCTION
 * write semantics (quiet folds while nothing is pending), and the oracle
 * mirrors them, so lockstep referees the real default write path. @internal
 */
export function __newBridgeForTest(options?: BridgeOptions): CosignalBridge {
	return new CosignalBridge(options);
}

// ---- NF2: per-world shadow arenas (plans/2026-07-06 §4) ---------------------------
// S-B (routing-authority transfer): the arenas are the value, invalidation,
// AND routing layer for pass and committed worlds — shadow records +
// strong/weak links recorded by the arena fn-readers, folds into value
// columns, fanout marks at the four committed-truth flip sites, sentinel
// boxes + settlement, consumer-refcount reclamation at quiesce, write-time
// delivery over strong links, drain candidates off the dirty lists, and the
// mount-fixup closure over reverse (deps) links. The K1 episode edge log,
// its touched-word machinery, and the separate weak-edge table were DELETED
// at S-B; the newest memo table (the ladder's last arm) died at S-C, when
// every bridge computed re-keyed onto a kernel `Computed` record — the
// kernel serves newest, and the kernel's own dep links carry the newest
// strong walks (subscription reach, the fixup closure's kernel leg). When
// the test harness arms the divergence checker (tests/arena-checker.ts, fed
// through `__checkerInternals`), every
// public operation's epilogue serves each live arena's shadows FROM THE
// ARENA (its own transliterated walks) and compares against FOLD-TRUTH — a
// naive cache-free re-fold — ANY divergence throws. Layouts and walks are
// adapted from the spike prototype
// (research/experiments/world-tagged-links-spike-code/). AF/AFlag below are
// the shadow arenas' OWN layout — bridge-owned, same-file so the hot arena
// walks (the aPropagate/aCheckDirty family) inline the members as literals
// under every toolchain. The shared field/bit names deliberately keep the
// kernel's numbering (the walks are transliterations of the kernel's
// propagate/checkDirty family and read best side by side), but nothing
// couples the two layouts: walks over KERNEL records use the kernel's own
// exported enums (index.ts NodeField/LinkField/NodeFlag — see
// kernelStrongDepsOf and closureOverKernel), and offsets 5-7 here mean
// shadow-specific things the kernel's fields don't.

/** Shadow-arena record fields (bridge-owned layout — NOT the kernel's
 * NodeField/LinkField, whose offsets 5-7 mean different things; stride 8;
 * node-shadow and link records share the pool). */
const enum AF {
	// shadow node record
	FLAGS = 0,
	DEPS = 1,
	DEPS_TAIL = 2,
	SUBS = 3,
	SUBS_TAIL = 4,
	NODE = 5, // the overlay NodeId this shadows
	GEN = 6, // id-tenancy stamp: bridge nodeGen[NODE] observed at recording (§4.5.3)
	MARK = 7, // fanout read-clock dedup stamp (§4.3)
	// link record
	L_VER = 0,
	L_DEP = 1,
	L_SUB = 2,
	L_PREV_SUB = 3,
	L_NEXT_SUB = 4,
	L_PREV_DEP = 5,
	L_NEXT_DEP = 6,
	L_MODE = 7, // bit 0: 1 = weak (untracked-read) link — §4.4.1
	/** The free list threads through the VERSION field (aliases L_VER):
	 * kernel row-2 discipline — a freed link must keep every field a walk
	 * still reads intact. aCheckDirty reads L_NEXT_DEP (and aShallowPropagate
	 * L_NEXT_SUB) off links a mid-walk purge freed, so those must keep naming
	 * former neighbors, never the free list. L_VER is genuinely dead on freed
	 * links: it is only written at link mint/reuse (aLink/aLinkInsert) and
	 * only read off LIVE links (the subs-tail dedup probe); every allocation
	 * path rewrites it before any read. Pinned by tests/arena-freelist.spec.ts. */
	L_FREE_NEXT = 0,
}

/** Shadow flag bits (bridge-owned; the shared names keep the kernel
 * NodeFlag numbering for side-by-side reading — see header note). */
const enum AFlag {
	MUTABLE = 1,
	RECURSED_CHECK = 4,
	RECURSED = 8,
	DIRTY = 16,
	PENDING = 32,
	K_SIGNAL = 128,
	K_COMPUTED = 256,
	/** The value column holds a folded value (cold shadow when unset). */
	VALID = 8192,
	/** Value column holds an exceptional payload (thrown error, or sentinel). */
	HAS_BOX = 2048,
	/** Refines HAS_BOX: payload is the thenable's stable SuspendedRead. */
	BOX_SUSPENDED = 4096,
	/** Refines HAS_BOX: the payload was THROWN by the fn (render-path
	 * suspension or plain error) — serves rethrow the cached payload,
	 * boxedRead-style (§4.5.3; arenas serve real reads at S-B). Clear means
	 * a RETURNED sentinel (the shim wrapper folds background suspensions to
	 * the sentinel VALUE), which serves as a value. Arena-local bit with no
	 * kernel NodeFlag counterpart (the kernel encodes the split differently). */
	BOX_THROWN = 16384,
}

const A_STRIDE = 8;
const A_SHIFT = 3; // record id >> A_SHIFT = value/susp column index
const EMPTY_I32 = new Int32Array(0);

/**
 * One world's shadow arena: packed records (spike plane layout), a value
 * side column, a per-shadow suspended-list index column, a dirty list, and
 * the read clock. Pooled: buffers return to the pool at release, where the
 * FULL SCRUB (releaseArena: written prefix + every side column zeroed) is
 * what makes dead-tenancy residue unable to validate; `claimGen` is the
 * tenancy diagnostic (bumped at claim AND release, monotone per shell —
 * a float64 counter, exact to 2^53, so it has no wrap surface).
 */
export class ShadowArena {
	kind: 'pass' | 'committed';
	/** Owning world (pass object or committed root) — folds cite it. */
	world: World;
	root: RootId; // committed: the root id; pass: the pass's root (diagnostics)
	alive = true;
	/** Pool claim generation (bumped at claim AND release). */
	claimGen = 0;
	W: Int32Array;
	vals: Value[] = [];
	/** Per-record suspended-list slot + 1 (0 = not suspended) — §4.5.4 step-0
	 * compaction: the field IS the set bit and stores the dense index. */
	suspIdx: number[] = [];
	/** Per-record walk-generation stamps (S-B routing walks: delivery reach,
	 * drain candidate collection, fixup closure) — termination + O(V+E)
	 * without allocation, per §4.4.3. Compared against the bridge's global
	 * walk generation; scrubbed at release like the other side columns. */
	walk: number[] = [];
	/** THE SEGREGATED WEAK SUBS LIST (§4.4.1's recorded fallback, DECIDED BY
	 * THE UNTRACKED-FAN GATE at S-B: the combined-list walk measured 4.9× the
	 * head-bridge anchor on the K=100 × R=4 write-storm shape — every write
	 * visited-and-skipped 400 weak links). Weak-flagged links live on a
	 * per-shadow SECOND subs list (head + tail side columns, record ids;
	 * same link-record layout): the delivery walk traverses the STRONG list
	 * (AF.SUBS) only and never sees a weak link; mark propagation and drain
	 * candidate collection walk both. §4.4.1's mode transitions (first-
	 * occurrence reset, strong-dominates) MOVE a link between the lists. */
	weakSubs: number[] = [];
	weakSubsTail: number[] = [];
	next = A_STRIDE; // bump pointer (record 0 burned: 0 = null)
	linkFree = 0;
	/** Dead-SHADOW free list head (leak audit): record ids threaded through
	 * AF.DEPS of records `disposeComputed`'s eager purge orphaned — the one
	 * site that kills a shadow record mid-tenancy (the dead-GEN path re-keys
	 * records in place). Records join FULLY ZEROED (byNode cleared, links
	 * purged, unsuspended), so nothing can reach one until aAllocShadow
	 * re-issues it; without this list the bump pointer grew a LIVE arena by
	 * one record per useComputed recreation, forever
	 * (tests/leak-audit.spec.ts pins the boundedness). */
	shadowFree = 0;
	links = 0;
	/** overlay NodeId → shadow record id (0 = none). */
	byNode: number[] = [];
	/** Marked-shadow list (record ids; appended on the DIRTY 0→1 edge). */
	dirty: number[] = [];
	/** Suspended-shadow list (record ids; dense — swap-remove compaction). */
	suspended: number[] = [];
	/** Fanout dedup clock: bumped on every arena consumption (§4.3). */
	readClock = 0;
	/** Per-arena evaluation cycle (link VERSION stamps). */
	cycle = 0;

	constructor(kind: 'pass' | 'committed', world: World, root: RootId, buf: Int32Array) {
		this.kind = kind;
		this.world = world;
		this.root = root;
		this.W = buf;
	}
}

/**
 * Int32 stamp ceiling (S-D pooling hardening): `readClock` and `cycle` are
 * JS numbers, but their stamps store into Int32Array fields (`AF.MARK`,
 * `AF.L_VER`) which truncate past 2^31-1 — a wrapped store could collide
 * with a live stamp and dedup FALSE-POSITIVE (a skipped propagation or a
 * dropped link: the dangerous direction). The bump helpers below renumber
 * BEFORE any store can wrap: stamps reset to 0 (= stale), the clock
 * restarts, and the next walk re-marks — at most one conservative re-walk
 * per record per 2^31 events, amortized zero. (Margin under 2^31-1 is
 * cosmetic headroom; bumps route through the helpers, so the clocks never
 * reach the ceiling.)
 */
const A_CLOCK_LIMIT = 0x7fff0000;

/** Renumber the read clock: MARK → 0 on every live shadow record, clock
 * restarts at 0 — the exact quiesce-duty state (§4.5.7), where "marks 0 /
 * clock 0" is proven sound: a dedup hit in that state claims an
 * already-marked cone whose PENDING flags persist, and any intervening
 * consumption bumps the clock away from 0. Link records are skipped by the
 * byNode round-trip guard (their slot 7 is L_MODE, not MARK). */
function aRenumberMarks(a: ShadowArena): void {
	for (let sh = A_STRIDE; sh < a.next; sh += A_STRIDE) {
		if ((a.W[sh + AF.NODE] ?? 0) !== 0 && a.byNode[a.W[sh + AF.NODE]!] === sh) a.W[sh + AF.MARK] = 0;
	}
	a.readClock = 0;
}

function aBumpReadClock(a: ShadowArena): void {
	if (a.readClock >= A_CLOCK_LIMIT) aRenumberMarks(a);
	a.readClock++;
}

/** Renumber evaluation-cycle stamps: L_VER → 0 on every LIVE link (each
 * lives on exactly one deps chain), cycle restarts at 0. L_VER is only
 * compared for SAME-evaluation link dedup, so a zeroed stamp just reads as
 * "stale from an old evaluation" — the normal case. Freed links are never
 * touched: their L_VER aliases the free-list thread (L_FREE_NEXT). An open
 * outer frame keeps stamping its saved (≥ limit) cycle, which post-renumber
 * cycles can never reach again before the next renumber — no collision. */
function aRenumberLinkVersions(a: ShadowArena): void {
	const W = a.W;
	for (let sh = A_STRIDE; sh < a.next; sh += A_STRIDE) {
		if ((W[sh + AF.NODE] ?? 0) !== 0 && a.byNode[W[sh + AF.NODE]!] === sh) {
			for (let l = W[sh + AF.DEPS]!; l !== 0; l = W[l + AF.L_NEXT_DEP]!) W[l + AF.L_VER] = 0;
		}
	}
	a.cycle = 0;
}

function aBumpCycle(a: ShadowArena): number {
	if (a.cycle >= A_CLOCK_LIMIT) aRenumberLinkVersions(a);
	return ++a.cycle;
}

function aGrow(a: ShadowArena, need: number): void {
	let len = a.W.length;
	while (len < need) len *= 2;
	if (len !== a.W.length) {
		const bigger = new Int32Array(len);
		bigger.set(a.W);
		a.W = bigger; // growth-mid-op: every allocating call site re-loads a.W (§4.5.9)
	}
}

function aAllocShadow(a: ShadowArena, nodeId: NodeId, flags: number, gen: number): number {
	let id = a.shadowFree;
	if (id !== 0) {
		// Reuse a dead-shadow record (see ShadowArena.shadowFree): it was
		// zeroed wholesale when it joined the list, its side columns were
		// scrubbed by the evict (vals/suspIdx) and the unlinks (weak heads),
		// and its walk stamp is stale by generation monotonicity — so once
		// the thread field clears, the fresh-record invariant below holds.
		a.shadowFree = a.W[id + AF.DEPS]!;
		a.W[id + AF.DEPS] = 0;
	} else {
		id = a.next;
		aGrow(a, id + A_STRIDE);
		a.next = id + A_STRIDE;
	}
	const W = a.W;
	// Fresh-record invariant (B1 cold-pass shave): W[a.next..] is ALL ZERO —
	// a fresh Int32Array is zeroed, aGrow's replacement buffer is zeroed past
	// the copied prefix, and releaseArena scrubs the dead tenancy's whole
	// written prefix [0, next) before the buffer pools. So the list heads
	// (DEPS/DEPS_TAIL/SUBS/SUBS_TAIL) and MARK are already 0 here, and the
	// bump allocator never re-issues a record id mid-tenancy — only the
	// tenant fields need stores. (The freelist re-issues LINK records, whose
	// mint paths write every field — tests/arena-freelist.spec.ts.)
	W[id + AF.FLAGS] = flags;
	W[id + AF.NODE] = nodeId;
	W[id + AF.GEN] = gen;
	const v = id >> A_SHIFT;
	while (a.vals.length <= v) {
		a.vals.push(undefined);
		a.suspIdx.push(0);
		a.walk.push(0);
		a.weakSubs.push(0);
		a.weakSubsTail.push(0);
	}
	while (a.byNode.length <= nodeId) a.byNode.push(0); // stay packed, never holey
	a.byNode[nodeId] = id;
	return id;
}

function aAllocLink(a: ShadowArena): number {
	let id = a.linkFree;
	if (id !== 0) {
		a.linkFree = a.W[id + AF.L_FREE_NEXT]!;
	} else {
		id = a.next;
		aGrow(a, id + A_STRIDE);
		a.next = id + A_STRIDE;
	}
	a.links++;
	return id;
}

function aFreeLink(a: ShadowArena, id: number): void {
	a.W[id + AF.L_FREE_NEXT] = a.linkFree;
	a.linkFree = id;
	a.links--;
}

/** Detach a link from its dep's subs list (the MODE-matching one). Fixes
 * neighbors and the head/tail columns only — the link's OWN prev/next stay
 * stale (row-2 discipline: mid-walk readers must keep seeing former
 * neighbors; movers rewrite them in aSubsAppend, and freed links never
 * revalidate). */
function aSubsDetach(a: ShadowArena, id: number): void {
	const W = a.W;
	const dep = W[id + AF.L_DEP]!;
	const nextSub = W[id + AF.L_NEXT_SUB]!;
	const prevSub = W[id + AF.L_PREV_SUB]!;
	const weak = (W[id + AF.L_MODE]! & 1) !== 0;
	if (nextSub !== 0) W[nextSub + AF.L_PREV_SUB] = prevSub;
	else if (weak) a.weakSubsTail[dep >> A_SHIFT] = prevSub;
	else W[dep + AF.SUBS_TAIL] = prevSub;
	if (prevSub !== 0) W[prevSub + AF.L_NEXT_SUB] = nextSub;
	else if (weak) a.weakSubs[dep >> A_SHIFT] = nextSub;
	else W[dep + AF.SUBS] = nextSub;
}

/** Append a link to its dep's MODE-matching subs list tail (sets the
 * link's own prev/next and mode). */
function aSubsAppend(a: ShadowArena, id: number, weak: boolean): void {
	const W = a.W;
	const dep = W[id + AF.L_DEP]!;
	const vi = dep >> A_SHIFT;
	const tail = weak ? a.weakSubsTail[vi]! : W[dep + AF.SUBS_TAIL]!;
	W[id + AF.L_MODE] = weak ? 1 : 0;
	W[id + AF.L_PREV_SUB] = tail;
	W[id + AF.L_NEXT_SUB] = 0;
	if (tail !== 0) W[tail + AF.L_NEXT_SUB] = id;
	else if (weak) a.weakSubs[vi] = id;
	else W[dep + AF.SUBS] = id;
	if (weak) a.weakSubsTail[vi] = id;
	else W[dep + AF.SUBS_TAIL] = id;
}

/** Set a live link's mode; a change MOVES it between the dep's two subs
 * lists (§4.4.1's transitions under the segregated-list fallback). */
function aSetMode(a: ShadowArena, id: number, weak: boolean): void {
	if (((a.W[id + AF.L_MODE]! & 1) !== 0) === weak) return;
	aSubsDetach(a, id);
	aSubsAppend(a, id, weak);
}

/**
 * TWINNING OBLIGATION (the other half of the note above index.ts's
 * "system.ts transliteration" section): these `a`-prefixed walks re-state
 * the kernel's push-pull algorithms over the arena layout. A semantic
 * change on either side must be re-derived — not copied — on the other.
 *
 * Link maintenance (spike `wLink`, transliterated) PLUS §4.4.1's mode
 * discipline, which the spike form lacked and may not be transplanted bare:
 * the FIRST occurrence of a dep in an evaluation SETS the link's mode from
 * that occurrence's read kind (fresh and REUSED links alike — the in-place
 * and tail fast paths below perform the write); a LATER occurrence may only
 * upgrade weak→strong, never downgrade. Mode writes route through aSetMode:
 * under the segregated-list fallback a mode change moves the link between
 * the dep's strong and weak subs lists.
 */
function aLink(a: ShadowArena, dep: number, sub: number, version: number, weak: boolean): void {
	const W = a.W;
	const prevDep = W[sub + AF.DEPS_TAIL]!;
	if (prevDep !== 0 && W[prevDep + AF.L_DEP] === dep) {
		// Duplicate occurrence within this evaluation: strong dominates.
		if (!weak) aSetMode(a, prevDep, false);
		return;
	}
	const nextDep = prevDep !== 0 ? W[prevDep + AF.L_NEXT_DEP]! : W[sub + AF.DEPS]!;
	if (nextDep !== 0 && W[nextDep + AF.L_DEP] === dep) {
		// In-place reuse: first occurrence this evaluation — reset the mode.
		W[nextDep + AF.L_VER] = version;
		aSetMode(a, nextDep, weak);
		W[sub + AF.DEPS_TAIL] = nextDep;
		return;
	}
	aLinkInsert(a, dep, sub, version, weak, prevDep, nextDep);
}

function aLinkInsert(a: ShadowArena, dep: number, sub: number, version: number, weak: boolean, prevDep: number, nextDep: number): void {
	// Same-evaluation duplicate arriving via the insert path (nonadjacent
	// re-read): probe BOTH mode tails; strong dominates.
	const sTail = a.W[dep + AF.SUBS_TAIL]!;
	if (sTail !== 0 && a.W[sTail + AF.L_VER] === version && a.W[sTail + AF.L_SUB] === sub) {
		return; // already strong this evaluation
	}
	const wTail = a.weakSubsTail[dep >> A_SHIFT]!;
	if (wTail !== 0 && a.W[wTail + AF.L_VER] === version && a.W[wTail + AF.L_SUB] === sub) {
		if (!weak) aSetMode(a, wTail, false); // upgrade weak→strong
		return;
	}
	const newLink = aAllocLink(a); // may grow the arena: re-load W after
	const W = a.W;
	W[sub + AF.DEPS_TAIL] = newLink;
	W[newLink + AF.L_VER] = version;
	W[newLink + AF.L_DEP] = dep;
	W[newLink + AF.L_SUB] = sub;
	W[newLink + AF.L_PREV_DEP] = prevDep;
	W[newLink + AF.L_NEXT_DEP] = nextDep;
	if (nextDep !== 0) W[nextDep + AF.L_PREV_DEP] = newLink;
	if (prevDep !== 0) W[prevDep + AF.L_NEXT_DEP] = newLink;
	else W[sub + AF.DEPS] = newLink;
	aSubsAppend(a, newLink, weak); // subs-side wiring + mode, on the matching list
}

function aUnlink(a: ShadowArena, id: number, sub: number = a.W[id + AF.L_SUB]!): number {
	const W = a.W;
	const dep = W[id + AF.L_DEP]!;
	const prevDep = W[id + AF.L_PREV_DEP]!;
	const nextDep = W[id + AF.L_NEXT_DEP]!;
	if (nextDep !== 0) W[nextDep + AF.L_PREV_DEP] = prevDep;
	else W[sub + AF.DEPS_TAIL] = prevDep;
	if (prevDep !== 0) W[prevDep + AF.L_NEXT_DEP] = nextDep;
	else W[sub + AF.DEPS] = nextDep;
	aSubsDetach(a, id); // mode-matching subs list; the freed link keeps stale pointers (row 2)
	aFreeLink(a, id);
	if (W[dep + AF.SUBS] === 0 && a.weakSubs[dep >> A_SHIFT] === 0 && (W[dep + AF.FLAGS]! & AFlag.K_COMPUTED) !== 0) {
		// Unwatched computed shadow (BOTH subs lists empty): mark stale, tear
		// down its own deps (in-world cascade — per-view acyclicity makes
		// this terminate).
		if (W[dep + AF.DEPS_TAIL] !== 0) {
			// Dirty-LIST append on the mark's 0→1 edge (the a.dirty contract;
			// the armed validator — tests/arena-checker.ts — enforces DIRTY ⇒
			// listed, and decay drops the torn
			// shadow to cold from the list). This was the one DIRTY-setting
			// site that skipped the append — the armed validator catches it
			// the first time a last-sub unlink tears a computed with deps.
			if ((W[dep + AF.FLAGS]! & AFlag.DIRTY) === 0) {
				a.dirty.push(dep);
			}
			W[dep + AF.FLAGS] = W[dep + AF.FLAGS]! | AFlag.DIRTY;
			aDisposeAllDepsInReverse(a, dep);
		}
	}
	return nextDep;
}

function aDisposeAllDepsInReverse(a: ShadowArena, sub: number): void {
	let cur = a.W[sub + AF.DEPS_TAIL]!;
	while (cur !== 0) {
		const prev = a.W[cur + AF.L_PREV_DEP]!;
		aUnlink(a, cur, sub);
		cur = prev;
	}
}

/** Purge links not re-tracked by the current evaluation (kernel discipline). */
function aPurgeDeps(a: ShadowArena, sub: number): void {
	const depsTail = a.W[sub + AF.DEPS_TAIL]!;
	let dep = depsTail !== 0 ? a.W[depsTail + AF.L_NEXT_DEP]! : a.W[sub + AF.DEPS]!;
	let guard = 0;
	while (dep !== 0) {
		if (++guard > 1_000_000) throw new BridgeInvariantViolation(`aPurgeDeps: deps chain cycle at link ${dep} (shadow ${sub})`);
		dep = aUnlink(a, dep, sub);
	}
}

// Arena-walk scratch stacks (module-owned; the routing walks use the
// bridge's own buffers instead).
let aPropStack = new Int32Array(4096);
let aPropSp = 0;
let aCheckStack = new Int32Array(4096);
let aCheckSp = 0;

/** Out-of-line cycle-cap thrower (keeps the walk arms' inline bytecode
 * free of the message-building code — cold by definition). */
function aWalkCycle(site: string, cur: number): never {
	throw new BridgeInvariantViolation(`${site}: walk exceeded 1e6 steps (cycle) at link ${cur}`);
}

/** Propagate PENDING over strong AND weak links (spike `wPropagate`;
 * §4.4.1: weak links participate in mark propagation and drains — only the
 * write-time delivery walk skips them). Under the segregated-list fallback
 * each descended sub contributes TWO chains: the strong list is walked
 * first and the weak head is pushed as a pending continuation (the same
 * stack mechanism that holds sibling continuations). */
function aPropagate(a: ShadowArena, startLink: number): void {
	const W = a.W; // never allocates: safe to cache
	let cur = startLink;
	let next = W[cur + AF.L_NEXT_SUB]!;
	const stackBase = aPropSp;
	let guard = 0;
	top: do {
		if (++guard > 1_000_000) aWalkCycle('aPropagate', cur);
		const sub = W[cur + AF.L_SUB]!;
		let flags = W[sub + AF.FLAGS]!;
		if (!(flags & (AFlag.RECURSED_CHECK | AFlag.RECURSED | AFlag.DIRTY | AFlag.PENDING))) {
			W[sub + AF.FLAGS] = flags | AFlag.PENDING;
		} else if (!(flags & (AFlag.RECURSED_CHECK | AFlag.RECURSED))) {
			flags = 0;
		} else if (!(flags & AFlag.RECURSED_CHECK)) {
			W[sub + AF.FLAGS] = (flags & ~AFlag.RECURSED) | AFlag.PENDING;
		} else if (!(flags & (AFlag.DIRTY | AFlag.PENDING)) && aIsValidLink(a, cur, sub)) {
			W[sub + AF.FLAGS] = flags | (AFlag.RECURSED | AFlag.PENDING);
			flags &= AFlag.MUTABLE;
		} else {
			flags = 0;
		}
		if (flags & AFlag.MUTABLE) {
			let subSubs = W[sub + AF.SUBS]!;
			const subWeak = a.weakSubs[sub >> A_SHIFT]!;
			let park = 0; // the weak head, parked when both lists are populated
			if (subWeak !== 0) {
				if (subSubs === 0) subSubs = subWeak; // only weak dependents: descend into them
				else park = subWeak;
			}
			if (subSubs !== 0) {
				cur = subSubs;
				const nextSub = W[cur + AF.L_NEXT_SUB]!;
				if (nextSub !== 0 || park !== 0) {
					if (aPropSp + 2 > aPropStack.length) {
						const bigger = new Int32Array(aPropStack.length * 2);
						bigger.set(aPropStack);
						aPropStack = bigger;
					}
					if (park !== 0) aPropStack[aPropSp++] = park;
					if (nextSub !== 0) {
						aPropStack[aPropSp++] = next;
						next = nextSub;
					}
				}
				continue;
			}
		}
		if ((cur = next) !== 0) {
			next = W[cur + AF.L_NEXT_SUB]!;
			continue;
		}
		while (aPropSp > stackBase) {
			cur = aPropStack[--aPropSp]!;
			if (cur !== 0) {
				next = W[cur + AF.L_NEXT_SUB]!;
				continue top;
			}
		}
		break;
	} while (true);
}

/** Head of a shadow's subs list by index: 0 = strong (arena links), 1 = weak
 * (the side column) — the one place the `for (list 0..1)` walk sites learn
 * where the two lists live. (aPropagateBoth/aShallowBoth below read the
 * heads directly: they are the write-fanout hot path.) */
function aSubsHead(a: ShadowArena, sh: number, list: number): number {
	return list === 0 ? a.W[sh + AF.SUBS]! : a.weakSubs[sh >> A_SHIFT]!;
}

/** Seed aPropagate over BOTH of a shadow's subs lists (fanout sites). */
function aPropagateBoth(a: ShadowArena, sh: number): void {
	const subs = a.W[sh + AF.SUBS]!;
	if (subs !== 0) aPropagate(a, subs);
	const weak = a.weakSubs[sh >> A_SHIFT]!;
	if (weak !== 0) aPropagate(a, weak);
}

function aShallowPropagate(a: ShadowArena, startLink: number): void {
	const W = a.W;
	let cur = startLink;
	let guard = 0;
	do {
		if (++guard > 1_000_000) throw new BridgeInvariantViolation(`aShallowPropagate: subs chain cycle at link ${cur}`);
		const sub = W[cur + AF.L_SUB]!;
		const flags = W[sub + AF.FLAGS]!;
		if ((flags & (AFlag.PENDING | AFlag.DIRTY)) === AFlag.PENDING) {
			W[sub + AF.FLAGS] = flags | AFlag.DIRTY;
			// Dirty-LIST append on the DIRTY 0→1 edge (the a.dirty contract:
			// DIRTY ⇒ listed — decay and drain seeding both stand on it). At
			// S-A this site's upgrades were always consumed within the same
			// checker pass; S-B serves arenas mid-operation, so an upgraded
			// shadow can reach a boundary unconsumed and MUST be listed.
			a.dirty.push(sub);
		}
	} while ((cur = W[cur + AF.L_NEXT_SUB]!) !== 0);
}

/** Shallow-propagate over BOTH of a shadow's subs lists (weak dependents
 * take the PENDING→DIRTY upgrade too — validation coverage, §4.4.1). */
function aShallowBoth(a: ShadowArena, sh: number): void {
	const subs = a.W[sh + AF.SUBS]!;
	if (subs !== 0) aShallowPropagate(a, subs);
	const weak = a.weakSubs[sh >> A_SHIFT]!;
	if (weak !== 0) aShallowPropagate(a, weak);
}

function aIsValidLink(a: ShadowArena, checkLink: number, sub: number): boolean {
	const W = a.W;
	let cur = W[sub + AF.DEPS_TAIL]!;
	let guard = 0;
	while (cur !== 0) {
		if (++guard > 1_000_000) throw new BridgeInvariantViolation(`aIsValidLink: prev-dep chain cycle at link ${cur}`);
		if (cur === checkLink) return true;
		cur = W[cur + AF.L_PREV_DEP]!;
	}
	return false;
}

/**
 * The serve-override slot's non-arena occupant (W3): while `serveOverride`
 * holds this marker, routed atom reads fold plain from their tapes in the
 * frame's world — no arena, no kernel shortcut — the armed divergence
 * checker's reference discipline (tests/arena-checker.ts compares arena
 * serves against these folds, so its reads must never consult the state
 * under check). Production never sets it; it exists so the routed-read hot
 * path tests ONE override slot instead of two.
 */
const FOLD_TRUTH = Symbol('cosignal.foldTruth');

/**
 * The armed checker's window into the engine (W3) — returned by
 * `CosignalBridge.__checkerInternals`, consumed only by the test-side
 * referee (tests/arena-checker.ts: the divergence check and the structural
 * validator). Readonly-shaped: live state getters plus bracket methods
 * that keep every mutation's save/restore discipline engine-side.
 * @internal
 */
export type ArenaCheckerInternals = {
	/** Arena record layout as plain numbers, restricted to the fields the
	 * structural validator reads. The engine's AF/AFlag are same-file const
	 * enums (A_SHIFT a module const): the OWNER inlines the values into this
	 * object at construction, so the view is in sync by construction — a
	 * layout change here flows through automatically, unlike a hand-copied
	 * declaration. Data-passing stays (deliberate): the shadow layout is
	 * bridge-internal with ONE external reader (the test referee), and
	 * exporting the enums for it would widen the module surface without
	 * deleting any drift risk. (Contrast the KERNEL's layout, which has
	 * independent walkers and is therefore exported from index.ts —
	 * NodeField/LinkField/NodeFlag.) AF entries are Int32 word offsets
	 * within a record; AFlag entries are FLAGS bits; A_SHIFT converts a
	 * record id to its side-column index. */
	readonly layout: {
		readonly A_SHIFT: number;
		readonly AF: {
			readonly NODE: number;
			readonly FLAGS: number;
			readonly DEPS: number;
			readonly SUBS: number;
			readonly L_DEP: number;
			readonly L_SUB: number;
			readonly L_PREV_DEP: number;
			readonly L_NEXT_DEP: number;
			readonly L_NEXT_SUB: number;
			readonly L_MODE: number;
		};
		readonly AFlag: { readonly DIRTY: number; readonly BOX_SUSPENDED: number };
	};
	/** Open world-evaluation frames — the checker must not run inside one
	 * (an epilogue can fire from a nested context; the check waits for the
	 * next top-level boundary). */
	readonly evalDepth: number;
	/** An updater/reducer/equals fold callback is on the stack (same bar). */
	readonly inFoldCallback: boolean;
	/** Every LIVE arena: committed arenas by root, then open-pass arenas —
	 * the check's iteration domain (the stores are private). */
	eachArena(fn: (a: ShadowArena) => void): void;
	/** The node registry row, or undefined for a disposed id (an arena's
	 * byNode rows can outlive their node — the checker skips those). */
	nodeAt(id: NodeId): AnyNode | undefined;
	/** `aServe` — THE arena serving entry (values, walks, refolds). The
	 * checker serves the arena side FIRST, pinning the discipline that a
	 * stale shadow is never refreshed by the reference side before the
	 * comparison reads it. */
	serve(a: ShadowArena, node: AnyNode): Value;
	/** One fold-truth fn run (see `foldTruthFrame`): world pinned, serve
	 * override at FOLD_TRUTH, capture/sink closed, eval depth bumped —
	 * everything restored on the way out. */
	foldTruthFrame<T>(world: World, fn: () => T): T;
	/** The bridge's ONE cycle-error construction — the naive side's cycle
	 * throws must compare string-equal to the arena side's. */
	cycleError(name: string): BridgeScheduleError;
	/** The fold-purity bracket: the checker runs user equality comparators
	 * under it, exactly like every other comparator call site. */
	inCallback<T>(fn: () => T): T;
	/** Op-depth bracket around one whole check pass: settle taps landing
	 * mid-check enqueue for the epilogue's drain instead of draining
	 * re-entrantly (the discipline the in-class check kept via opDepth). */
	holdOp<T>(fn: () => T): T;
	/** Install (or clear) the armed epilogue hook — fired after every
	 * public operation's settlement fixed point. */
	armEpilogueCheck(check: (() => void) | undefined): void;
};

// ---- the bridge -----------------------------------------------------------------

/**
 * The concurrent-worlds engine. Method-for-method it exposes the surface the
 * external-runtime protocol drives (batches, passes, commits, retirements) —
 * the same surface the reference model (`cosignal-oracle`) implements, so the
 * two can run any schedule in lockstep. The kernel integration points are:
 * `AtomNode.handle` (kernel-backed newest storage, eager stepwise apply on
 * every recorded write) and the module-level concurrent table (public-write
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
	/** The committed `run`-action subscription store (see Subscription). */
	subs = new Map<EffectId, Subscription>();
	/**
	 * The trace recorder slot — the engine's ONLY instrumentation output.
	 * `undefined` (the permanent state unless `cosignal/trace` attaches):
	 * every instrumentation site pays one load + undefined check, nothing
	 * else. Assigned only by `attachTracer`/`Tracer.stop` over there. Sites
	 * mint fixed-size packed records straight through these hooks — no event
	 * objects exist, and the engine retains nothing on the tracer's behalf
	 * (the tracer's ring/session buffers hold the capture; referees decode
	 * records on demand — tests/trace-events.ts). Attaching observes the
	 * write path, it never changes which one runs (deliberately NO quiet
	 * recompute here or in attachTracer).
	 */
	trace: TraceHooks | undefined = undefined;

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

	/** Flipped once by registerBridge(). There is no bridge-level
	 * pre-registration era: production writes reach a bridge only through the
	 * kernel write hook, which arms at registration — anything earlier is
	 * plain kernel state that never involves a bridge. The referee-only write
	 * surface therefore throws on an unregistered bridge (fail fast, never limp). */
	private _registered = false;
	/** Has a concurrent host registered this bridge yet? (Read-only; adapters
	 * use it to register an injected bridge exactly once.) */
	get registered(): boolean {
		return this._registered;
	}
	/** The one global sequence line every receipt/pin/stamp is a point on. */
	seq: Seq = 0;
	/** Committed-advance counter, in sequence units: bumped whenever committed
	 * truth moves (per-root commit, or a retirement that changed history). */
	cas: Seq = 0;
	/** Episode counter; bumped at quiescence when the overlay tables bulk-reset. */
	epoch: Epoch = 0;

	// ---- routing walk scratch (arena walks + collection dedup) ----
	/** Per-NODE visited/collection generation column: one stamp per overlay
	 * node id, shared by the routing walks (delivery collection dedup across
	 * arenas, drain candidate dedup) — arena TRAVERSAL termination uses the
	 * per-arena `walk` side column instead, because the same node's cone
	 * differs per arena and must be walked in each. */
	private lastWalk: WalkGen[] = [0];
	private walkGen: WalkGen = 0;
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
	// measurable and needs no second has-lifecycle registry here. obsDeps
	// snapshots follow the CURRENT edge set — each fn re-run of an observed
	// computed (overlay newest runs AND arena world refolds — §4.7/M6 carry
	// the capture into the arena walks) re-points its retains (dep flips
	// move them; the kernel's microtask flush coalesces same-tick flaps) —
	// and the observation index deliberately survives quiescence: the
	// closure is a property of live watchers, not of the episode.
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
	/** Live subscription count (fast bail on the boundary-scan paths). */
	private committedSubCount = 0;
	/** The core capture frame `captureRun` opens: while set (and no evaluation
	 * world is on stack) routed reads resolve committed-for-root and append to
	 * the dep snapshot. Replaces the adapter's effectCapture + readObserver
	 * seam + the world provider's committed arm (plan §2.2.2). */
	private captureFrame: { sub: Subscription; deps: { node: AnyNode; value: Value }[] } | undefined = undefined;
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
	 * The ARMED quiet state — the one boolean the write path branches on,
	 * recomputed only at state transitions (batch open/retire, pass
	 * start/end, registration): quiet ⇔ bridge registered AND zero live
	 * tokens AND zero open passes AND every tape compacted. While QUIET, an
	 * unclassified write to a registered atom FOLDS DIRECTLY: committed base
	 * and the kernel advance together and no receipt, tape append, token, or
	 * delivery walk is minted (a listening event consumer still gets one
	 * 'quiet-write' event — observation never changes which write path
	 * executes). The concurrency pipeline arms only while something is
	 * actually pending; a transition that starts later begins from committed
	 * base, which the folds already advanced — there is no history to
	 * reconstruct.
	 *
	 * This is the production default write path; the oracle mirrors the same
	 * derivation and fold, so lockstep/twin drivers referee it directly
	 * (tests/quiet-mode.spec.ts pins the arming schedules by hand).
	 * @internal — read by the module-level host write hook; treat as private.
	 */
	quiet = false;

	private recomputeQuiet(): void {
		// The registered clause is load-bearing: quiet must never arm on an
		// unregistered test bridge (its write path throws).
		this.quiet =
			this._registered
			&& this.liveTokenCount === 0
			&& this.openPassByRoot.size === 0
			&& this.dirtyAtoms.size === 0;
	}

	/**
	 * Referee surface — not consulted by engine logic. The recorded
	 * dependency edges as dep → dependents (overlay node ids), materialized
	 * as the union of every live arena's links (strong AND weak-flagged —
	 * the current structure the routing walks consult); read by: graphviz,
	 * twin tests, soak metrics. (Replaced the K1 episode-edge snapshot at
	 * S-B; arena links persist across quiescence with their arenas.)
	 */
	get dependencyEdges(): Map<NodeId, Set<NodeId>> {
		const out = new Map<NodeId, Set<NodeId>>();
		this.eachArena((a) => {
			const W = a.W;
			for (let nid = 0; nid < a.byNode.length; nid++) {
				const sh = a.byNode[nid]!;
				if (sh === 0) continue;
				for (let list = 0; list < 2; list++) {
					let l = aSubsHead(a, sh, list);
					while (l !== 0) {
						const sub = W[l + AF.L_SUB]!;
						let s = out.get(nid);
						if (s === undefined) {
							s = new Set();
							out.set(nid, s);
						}
						s.add(W[sub + AF.NODE]!);
						l = W[l + AF.L_NEXT_SUB]!;
					}
				}
			}
		});
		return out;
	}

	/** Ambient default batch for bare (context-free) writes. */
	ambientToken: TokenId | undefined;

	/** Registered kernel-backed nodes (atoms AND computeds since S-C), by
	 * kernel record id (concurrent-table routing + the kernel-link walks'
	 * id mapping). `disposeComputed` clears rows, so a REUSED kernel id can
	 * never resolve to a dead tenant (§4.5.3 id tenancy). */
	byKernelId = new Map<KernelId, AnyNode>();
	/** The world an overlay evaluation frame is folding in (concurrent-table read routing). */
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
	 * guard) — received as the public method's scalar (kind, payload) pair,
	 * exactly as the host seam captured it; when unset, registered atoms
	 * classify into the ambient batch.
	 */
	writeClassifier: ((atom: Atom<unknown>, kind: HostOpKind, payload: unknown) => void) | undefined;
	/** Adopt-on-demand for routed reads of not-yet-registered atoms. */
	readAdopter: ((atom: Atom<unknown>) => AtomNode) | undefined;
	/** Development-time checks switch (BridgeOptions.devChecks). Read by the
	 * bindings/host adapter driving this bridge — the engine never branches
	 * on it. */
	readonly devChecks: boolean;

	private nextNode = 1;
	private nextToken = 1;
	private nextPass = 1;
	private nextWatcher = 1;
	private nextEffect = 1;

	/** >0 while a world evaluation is on stack (renders must not write). */
	private evalDepth = 0;
	/** True inside an updater/reducer/equals callback (reads+writes throw). */
	inFoldCallback = false;

	constructor(options?: BridgeOptions) {
		this.arenaInitInts = options?.arenaInitInts ?? 8192;
		this.devChecks = options?.devChecks ?? false;
		probes.bridges++; // One Core probe (referee surface)
		for (let i = 0; i < SLOT_COUNT; i++) {
			this.slots.push({
				id: i,
				tenant: undefined,
				claimSeq: 0,
				writeClock: 0,
				releasePending: false,
			});
		}
	}

	/** Central activeWorld setter — keeps the read-routing seams in sync. */
	private setWorld(w: World | undefined): void {
		this.activeWorld = w;
		this.syncReadRouting();
	}

	/** Arms/disarms the core's host read hooks (atom + computed — the S-C
	 * computed-read seam arms in lockstep): armed while an evaluation world
	 * is on stack OR a provider could answer — so a provider-less quiet host
	 * costs reads exactly one undefined-check. */
	private syncReadRouting(): void {
		if (activeBridge !== this) return;
		const armed = this.activeWorld !== undefined || this.worldProvider !== undefined || this.captureFrame !== undefined;
		__setHostRead(armed ? hostReadImpl : undefined);
		__setHostComputedRead(armed ? hostComputedReadImpl : undefined);
	}

	/** Capture frame that answered the LAST resolveRoutedWorld call (scratch,
	 * consumed immediately by the two host read hooks — a field instead of a
	 * tuple return so routed reads allocate nothing on the provider path). */
	private routedCap: { sub: Subscription; deps: { node: AnyNode; value: Value }[] } | undefined;

	/**
	 * THE read-routing resolution order, one copy (both host read hooks used
	 * to carry it separately): fold-purity throw, then the evaluation world
	 * on stack (reads inside a computed's evaluation are the COMPUTED's
	 * dependencies — the capture frame never sees them: the suppression rule
	 * of plan §2.2.2), then the open capture frame (committed-for-root; the
	 * frame lands in `routedCap` for the caller's dep capture), then the
	 * host's ambient provider.
	 */
	private resolveRoutedWorld(): World | undefined {
		// Fold purity: replayed updaters/reducers (and equals callbacks) must
		// not read signals — world routing would otherwise serve them silently.
		if (this.inFoldCallback) {
			throw new BridgeScheduleError('signal read inside an updater/reducer fold — updaters and reducers must be pure; read what you need before dispatching');
		}
		this.routedCap = undefined;
		const world = this.activeWorld;
		if (world !== undefined) return world;
		const cap = this.captureFrame;
		if (cap !== undefined) {
			this.routedCap = cap;
			return { kind: 'committed', root: cap.sub.root };
		}
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
		const world = this.resolveRoutedWorld();
		if (world === undefined) {
			return __HOST_MISS;
		}
		const cap = this.routedCap;
		let node = this.byKernelId.get(atom._id);
		if (node === undefined) {
			const adopt = this.readAdopter;
			if (adopt === undefined) {
				return __HOST_MISS;
			}
			node = adopt(atom);
		}
		const v = this.routedRead(node as AtomNode, world);
		if (cap !== undefined) cap.deps.push({ node, value: v });
		return v;
	}

	/**
	 * The computed host read hook's target (S-C computed-read seam): route a
	 * public `Computed.state` read to the effective world, adopting
	 * unregistered handles on demand (adoption is bridge-owned — unlike
	 * atoms, no bindings policy participates). Newest resolution declines
	 * (__HOST_MISS): the plain kernel path IS newest serving, seam-free.
	 * Reads inside an open capture frame resolve committed-for-root and
	 * append to the dep snapshot, exactly like routed atom reads.
	 * @internal (reached only through index.ts's `Computed.state`)
	 */
	hostComputedRead(c: Computed<unknown>): unknown {
		const world = this.resolveRoutedWorld();
		if (world === undefined || world.kind === 'newest') {
			return __HOST_MISS; // the plain kernel path is newest serving
		}
		const cap = this.routedCap;
		const node = this.nodeForComputed(c);
		// The pre-dedup observation capture rides tracked reads (§4.7/M6);
		// raw handle reads inside world evaluations have no reader hook, so
		// the seam is their capture site (mirrors routedRead's atom half).
		if (this.currentSink !== 0) {
			const oc = this.obsCapture;
			if (oc !== undefined) oc.push(node.id);
		}
		const v = this.evaluate(node, world);
		if (cap !== undefined) cap.deps.push({ node, value: v });
		return v;
	}

	/**
	 * Resolve a public Computed handle to its registered node, adopting on
	 * first sight — `resolveStamped`'s computed face.
	 */
	nodeForComputed(c: Computed<unknown>): ComputedNode {
		return (this.resolveStamped(c, 'computed') as ComputedNode | undefined)
			?? this.adoptComputed(c.label ?? `computed#${c._id}`, c);
	}

	/**
	 * The ONE stamp-validate + registry-probe + re-stamp rule behind handle
	 * resolution (`nodeFor` and `nodeForComputed` are its two kind-typed
	 * faces). Adoption stamps `{b, n}` on the handle, so the steady state is
	 * one property load + identity compare; the Map probe runs only for
	 * un-stamped handles (or a stamp from a replaced bridge — test drivers
	 * swap bridges; the stamp validates against THIS bridge and re-stamps on
	 * a registry hit). Kernel id reuse can never serve a dead tenant:
	 * disposal clears the stamp and the byKernelId row (§4.5.3 id tenancy).
	 */
	private resolveStamped(handle: Atom<unknown> | Computed<unknown>, kind: 'atom' | 'computed'): AnyNode | undefined {
		const stamp = handle._hostStamp;
		if (stamp !== undefined && stamp.b === this) return stamp.n as AnyNode;
		const hit = this.byKernelId.get(handle._id);
		if (hit === undefined || hit.kind !== kind) return undefined;
		handle._hostStamp = { b: this, n: hit }; // re-stamp after a bridge swap
		return hit;
	}

	private mintSeq(): Seq {
		return ++this.seq;
	}

	// ---------------------------------------------------------------- setup

	/** Activates the concurrent engine, once, monotonically; arms the table seam. */
	registerBridge(): void {
		if (this.evalDepth > 0 || this.inFoldCallback) {
			throw new BridgeScheduleError('registerReactBridge called inside an open evaluation/fold frame; it may only run at an operation boundary');
		}
		if (this._registered) throw new BridgeScheduleError('bridge already registered — registration happens exactly once');
		this._registered = true;
		activeBridge = this;
		__setHostWrite(hostWriteImpl); // whole-op capture in the public methods
		// NF2 S-A: arm the settlement tap (ONE closure; consulted at FIRE
		// time, routed to the active bridge — §4.5.4 push half).
		__setSettleTap(settleTapImpl);
		this.syncReadRouting();
		this.recomputeQuiet(); // registered + nothing pending: quiet arms here
	}

	/** Registers a node id in the dense side columns. */
	private indexNode(node: AnyNode): void {
		const id = node.id;
		this.nodes.set(id, node);
		this.nodesArr[id] = node;
		this.lastWalk[id] = 0;
		this.evalMark[id] = 0;
		this.obsRefs[id] = 0;
		this.nodeGen[id] = this.nodeGen[id] ?? 0; // dense: shadowFor loads it in-bounds on every probe
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
	 * Resolve a public handle to its registered node — `resolveStamped`'s
	 * atom face, shared by the host write seam and the bindings' handle
	 * resolution.
	 */
	nodeFor(atom: Atom<unknown>): AtomNode | undefined {
		return this.resolveStamped(atom, 'atom') as AtomNode | undefined;
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

	/**
	 * Mint a bridge computed (S-C: one computed — the node RIDES a fresh
	 * kernel `Computed` record). The kernel getter runs the authored
	 * (read, untracked) fn with the KERNEL readers — dep reads take the
	 * plain kernel paths (linking to this record; untracked reads clear the
	 * kernel frame, so they leave no link and never notify) — under the
	 * bridge's evaluation guards (writes throw; observed runs capture their
	 * strong deps; trace hooks fire). World evaluations run the same fn with
	 * the ARENA readers through `aUpdateComputed`.
	 */
	computed(name: string, fn: ComputedFn, equals?: Equals): ComputedNode {
		const node: ComputedNode = {
			kind: 'computed', id: this.nextNode++, name, fn,
			handle: undefined as never, ctxShaped: false, isEqual: equals, prevCell: { value: undefined },
		};
		node.handle = new Computed<unknown>(this.makeKernelGetter(node) as (ctx: ComputedCtx<unknown>) => Value, equals === undefined ? { label: name } : { label: name, isEqual: equals });
		__hostMarkComputedOwned(node.handle); // its links carry no D1 lifecycle refs — the obs index is its arm
		this.indexNode(node);
		this.byKernelId.set(node.handle._id, node);
		node.handle._hostStamp = { b: this, n: node };
		return node;
	}

	/**
	 * Adopt a public `Computed` handle (S-C): the handle's kernel record
	 * keeps serving the newest world exactly as before adoption — the bridge
	 * only WRAPS its kernel getter with the host epilogue (observation
	 * re-pointing per re-run) and builds the ctx-shaped WORLD fn: reads
	 * inside the raw fn are raw `.state` reads, which the host read seams
	 * route into the evaluating arena; `ctx.previous` serves the node's
	 * committed previous cell; `ctx.use` is the core's two-form dispatch
	 * over the handle's own `_useCache` (same key ⇒ same thenable for the
	 * node's lifetime, across worlds); a background evaluation folds a
	 * pending suspension to its stable sentinel VALUE (hook-initiated ones
	 * rethrow — `suspendDepth`).
	 */
	adoptComputed(name: string, handle: Computed<unknown>): ComputedNode {
		const existing = this.byKernelId.get(handle._id);
		if (existing !== undefined && existing.kind === 'computed') return existing;
		const node: ComputedNode = {
			kind: 'computed', id: this.nextNode++, name, fn: undefined as never,
			handle, ctxShaped: true, isEqual: handle._isEqual, prevCell: { value: undefined },
		};
		node.fn = this.makeCtxWorldFn(node);
		__hostWrapComputedFn(handle._id, (inner) => this.makeAdoptedKernelGetter(node, inner));
		__hostMarkComputedOwned(handle); // retro-releases any pre-adoption lifecycle refs its links held
		this.indexNode(node);
		this.byKernelId.set(handle._id, node);
		handle._hostStamp = { b: this, n: node };
		return node;
	}

	/**
	 * Dispose a computed (S-C — the useComputed deps-change reclamation
	 * path: the superseded node's kernel record frees and its id becomes
	 * reusable). The caller owns the discipline that the node is SUPERSEDED
	 * (its watchers re-keyed to the replacement; live watchers here throw).
	 * Order matters for §4.5.3 id tenancy: the bridge-side tenancy moves
	 * FIRST — nodeGen bumps (dead-GEN shadows never serve), every live
	 * arena's shadow purges eagerly (walks traverse links without per-hop
	 * GEN checks, so links through the dead shadow must go now), the
	 * kernel-id row and handle stamp clear (a reused kernel id resolves
	 * fresh, never to the dead tenant) — then the kernel record disposes.
	 */
	disposeComputed(handle: Computed<unknown>): void {
		const node = this.byKernelId.get(handle._id);
		if (node !== undefined && node.kind === 'computed' && node.handle === handle) {
			const nid = node.id;
			const ws = this.watchersByNode[nid];
			if (ws !== undefined && ws.some((w) => w.live)) {
				throw new BridgeScheduleError(`disposeComputed(${node.name}): live watchers still subscribe — re-key them to the replacement first`);
			}
			if (this.obsRefs[nid]! > 0) this.obsExit(nid); // release any retained closure (defensive)
			this.nodeGen[nid] = (this.nodeGen[nid] ?? 0) + 1;
			this.eachArena((a) => {
				const sh = nid < a.byNode.length ? a.byNode[nid]! : 0;
				if (sh === 0) return;
				this.aEvictShadow(a, sh);
				// Zero the record and unindex: dirty-list residue reads an inert
				// record (FLAGS 0 — decay drops it); nothing routes here again.
				for (let f = 0; f < A_STRIDE; f++) a.W[sh + f] = 0;
				a.byNode[nid] = 0;
				// Leak audit: thread the orphaned record onto the arena's
				// dead-shadow free list so recreation churn (the useComputed
				// dispose→create pattern) reuses it instead of growing a live
				// arena's record plane without bound. Stale dirty-list entries
				// naming it stay benign: pre-reuse they read FLAGS 0 (dropped),
				// post-reuse they alias the new tenant's listed entry (decay
				// re-checks flags per entry; duplicates cannot amplify).
				a.W[sh + AF.DEPS] = a.shadowFree;
				a.shadowFree = sh;
			});
			this.byKernelId.delete(handle._id);
			this.nodes.delete(nid);
			this.nodesArr[nid] = undefined;
			handle._hostStamp = undefined;
		}
		__hostDisposeComputed(handle); // kernel: deps unlink, subs detach, deferred free (GEN bump at the sweep)
	}

	/** >0 while a hook-initiated evaluation may legally suspend the render
	 * (the bindings' `evaluateSuspending` bumps it); background evaluations
	 * of ctx-shaped computeds fold pending suspensions to sentinel values. */
	suspendDepth = 0;

	/** The kernel getter of a bridge-created computed (see `computed`). */
	private makeKernelGetter(node: ComputedNode): () => Value {
		return () => {
			const savedCapture = this.obsCapture;
			this.obsCapture = this.obsRefs[node.id]! > 0 ? [] : undefined;
			this.evalDepth++; // writes during a newest evaluation throw, as in every world
			const tr = this.trace;
			if (tr !== undefined) tr.evalStart(node, NEWEST);
			try {
				return node.fn(this.kernelTrackedReader, this.kernelUntrackedReader);
			} finally {
				this.evalDepth--;
				const captured = this.obsCapture;
				this.obsCapture = savedCapture;
				if (tr !== undefined) tr.evalEnd();
				if (captured !== undefined) this.obsSyncAfterKernelRun(node.id, captured);
			}
		};
	}

	/** The wrapped kernel getter of an ADOPTED computed: run the original
	 * (equality wrappers and all), then re-point the observed closure at the
	 * kernel links this run just re-tracked (raw `.state` reads inside a
	 * kernel frame never reach a bridge reader, so the fresh link list IS
	 * the capture — full, reuse-proof, tracked-only). */
	private makeAdoptedKernelGetter(node: ComputedNode, inner: (ctx: unknown) => unknown): (ctx: unknown) => unknown {
		return (ctx: unknown) => {
			this.evalDepth++; // writes during a newest evaluation throw, as in every world
			const tr = this.trace;
			if (tr !== undefined) tr.evalStart(node, NEWEST);
			try {
				return inner(ctx);
			} finally {
				this.evalDepth--;
				if (tr !== undefined) tr.evalEnd();
				if (this.obsRefs[node.id]! > 0) this.obsSyncAfterKernelRun(node.id, this.kernelStrongDepsOf(node));
			}
		};
	}

	/** The (read, untracked)-shaped WORLD evaluation fn of an adopted
	 * ctx-shaped computed (see `adoptComputed`; the readers are unused — the
	 * raw fn reads through the `.state` seams, which the open arena frame
	 * routes and links). */
	private makeCtxWorldFn(node: ComputedNode): ComputedFn {
		const handle = node.handle;
		const rawFn = handle._fn as (ctx: ComputedCtx<unknown>) => Value;
		const ctx: ComputedCtx<unknown> = {
			get previous(): Value {
				return node.prevCell.value;
			},
			use: <V>(sourceOrKey: unknown, factory?: () => PromiseLike<V>): V =>
				__ctxUse(handle, sourceOrKey, factory as (() => PromiseLike<unknown>) | undefined) as V,
		} as ComputedCtx<unknown>;
		return () => {
			try {
				return rawFn(ctx);
			} catch (err) {
				// Background world evaluation: a pending suspension folds to its
				// stable SuspendedRead sentinel VALUE (so "still pending" caches
				// and compares like any value — battery 16d); hook-initiated
				// evaluations rethrow so React can suspend the component.
				if (err instanceof SuspendedRead && this.suspendDepth === 0) return err;
				throw err;
			}
		};
	}

	/** The bridge's ONE cross-world cycle error (every construction site
	 * builds it here so the surface message can never fork). */
	private cycleError(name: string): BridgeScheduleError {
		return new BridgeScheduleError(`cyclic evaluation of ${name} within one world — a computed may not depend on itself`);
	}

	/** The kernel-way dep read both kernel-frame readers share: atoms off the
	 * kernel arena, computeds via the plain kernel computed read (E.read/
	 * E.computedRead link the dep to any open kernel frame), kernel
	 * CycleErrors translated to the bridge's. */
	private kernelReadOf(dep: AnyNode): Value {
		if (dep.kind === 'atom') return this.kernelValueOf(dep.handle);
		try {
			return __kernelComputedRead(dep.handle);
		} catch (err) {
			if (err instanceof CycleError) throw this.cycleError(dep.name);
			throw err;
		}
	}

	/** Kernel-frame tracked reader (bridge-created computeds' newest runs):
	 * the shared kernel read plus the pre-dedup observation capture. */
	private kernelTrackedReader: Reader = (dep) => {
		const oc = this.obsCapture;
		if (oc !== undefined) oc.push(dep.id);
		return this.kernelReadOf(dep);
	};

	/** Kernel-frame untracked reader: kernel `untracked()` clears the frame,
	 * so the dep's own serving still runs (recompute-if-stale) but no link —
	 * and therefore no notification, and no invalidation of this computed —
	 * is ever recorded (§4.4.1's value face, the ruling's sampling rule). */
	private kernelUntrackedReader: Reader = (dep) => untracked(() => this.kernelReadOf(dep));

	/** Observation re-point after a KERNEL re-run, inside the still-open
	 * kernel frame: discovery evaluations (obsEnter forcing dep reads) must
	 * not link into that frame — kernel `untracked()` clears it around the
	 * sync (the arena twin clears `serveOverride` instead — aSyncObsAfterRefold). */
	private obsSyncAfterKernelRun(nid: NodeId, captured: NodeId[]): void {
		untracked(() => this.obsSyncDeps(nid, captured));
	}

	/** The registered bridge nodes among a computed's CURRENT kernel deps
	 * (tracked-only by construction: untracked reads leave no kernel link).
	 * Walked off the raw kernel arena with the kernel's own exported layout
	 * enums — a kernel field reorder flows through the import instead of
	 * silently corrupting this walk. */
	private kernelStrongDepsOf(node: ComputedNode): NodeId[] {
		const M = __kernelBuffer();
		const out: NodeId[] = [];
		let l = M[node.handle._id + NodeField.DEPS]!;
		while (l !== 0) {
			const dep = this.byKernelId.get(M[l + LinkField.DEP]!);
			if (dep !== undefined) out.push(dep.id);
			l = M[l + LinkField.NEXT_DEP]!;
		}
		return out;
	}

	root(id: RootId): RootState {
		let r = this.roots.get(id);
		if (r === undefined) {
			r = { id, committedTokens: new Set(), commitGen: 0, committedBits: 0, committedDirtySlots: 0 };
			this.roots.set(id, r);
		}
		return r;
	}

	// ---------------------------------------------------- worlds and folds

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

	/**
	 * The fold — replay visible entries over base in sequence order with
	 * stepwise equality (an equal step keeps the old reference). Runs over
	 * the packed columns. (The memo-fingerprint side channel `lastFoldFp`
	 * died at S-D: S-C deleted the memo ladder — its last reader.)
	 */
	foldAtom(atom: AtomNode, world: World): Value {
		const tp = atom.tp;
		const n = tp.n;
		let value = atom.base;
		const seqs = tp.seqs;
		const retired = tp.retired;
		const slots = tp.slots;
		for (let i = tp.start; i < n; i++) {
			if (!this.visibleAt(i, world, seqs, retired, slots)) continue;
			const next = this.applyOp(atom, tp.kinds[i]!, tp.payloads[i], value);
			if (!this.eqAtom(atom, next, value)) value = next;
		}
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
	 *    inclusions at its pin, plus committed truth at NOW.
	 * (The Receipt-shaped twin of this rule is the reference model's
	 * exported `visible` — cosignal-oracle model.ts; tests/model-view.ts
	 * imports it rather than keeping a copy. It must mirror these clauses.)
	 */
	private visibleAt(i: number, world: World, seqs: Seq[], retired: Seq[], slots: SlotId[]): boolean {
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
				// Membership consult materializes the root record (reference-model
				// parity: the model's committedSlotsNow() creates it on first consult).
				return ((this.root(world.root).committedBits >>> slots[i]!) & 1) === 1;
			}
			case 'mountFix': {
				if (((world.maskBits >>> slots[i]!) & 1) === 1 && seqs[i]! <= world.pin) return true;
				if (retired[i]! !== 0) return true; // committed truth at NOW
				return ((this.root(world.root).committedBits >>> slots[i]!) & 1) === 1;
			}
		}
	}

	/** Apply one op over `prev`, straight off the scalar (kind, payload) pair
	 * (a SET's payload is the value; an UPDATE's is the updater). Replayed
	 * updaters run under BOTH fold guards: the bridge's (bridge reads throw)
	 * and the kernel's POISON table (raw public reads/writes throw exactly as
	 * in the unhosted path). ReducerAtom dispatches arrive here too: the
	 * closure carries the reducer and the captured action. */
	private applyOp(atom: AtomNode, kind: OpKind, payload: unknown, prev: Value): Value {
		if (kind === OpKind.SET) return payload;
		return this.inCallback(() => __hostRunFold(() => (payload as (p: Value) => Value)(prev)));
	}

	/** How this atom compares two values — THE equality rule, one copy for
	 * every site that asks (fold replay, the write path's drop check and
	 * eager kernel apply, quiet-mode folds, tape compaction): Object.is when
	 * the atom carries the default, otherwise the atom's custom comparator
	 * under the fold-purity guard (equality callbacks replay per world, so
	 * signal reads/writes inside them throw — the updater contract). */
	private eqAtom(atom: AtomNode, a: Value, b: Value): boolean {
		return atom.eqIsDefault ? Object.is(a, b) : this.inCallback(() => atom.equals(a, b));
	}

	/** Reads an atom's newest value straight from the kernel — the core's
	 * host-side read seam, which the world-routing hook can never intercept
	 * (no seam toggling around the call). */
	private kernelValueOf(handle: Atom<Value>): Value {
		return __hostReadNewest(handle);
	}

	// ---- fold-through frame state (mountFix / unmaterialized-root folds) ----
	/** The node id whose fold-through evaluation frame is open (raw-handle
	 * reads gate their observation capture on it; the untracked reader
	 * clears it around the dep — sink 0 ⇔ weak). */
	private currentSink: NodeId = 0;

	/**
	 * Raw-handle reads: a registered atom read reached the operation table
	 * while an overlay evaluation frame was open (newest/mountFix — arena
	 * fn runs route through `serveOverride` inside atomValue and link at `aServe`).
	 * The open frame's sink gates the observation capture — recordEdge's
	 * surviving half (§4.8 S-B): the pre-dedup capture rides the tracked
	 * read path.
	 * @internal (called from the concurrent table wrapper)
	 */
	routedRead(atom: AtomNode, world: World): Value {
		if (this.currentSink !== 0) {
			const oc = this.obsCapture;
			if (oc !== undefined) oc.push(atom.id);
		}
		return this.atomValue(atom, world);
	}

	/** Atom value in a world: kernel for newest, the world's arena for
	 * pass/committed, a plain fold for mountFix and unmaterialized roots. */
	private atomValue(atom: AtomNode, world: World): Value {
		const route = this.serveOverride; // ONE override test on the routed-read path (W3)
		if (route !== undefined) {
			if (route !== FOLD_TRUTH) return this.aServe(route, atom); // arena-refold routing override
			return this.foldAtom(atom, world); // fold-truth reads (armed checker)
		}
		if (world.kind === 'newest') {
			// The kernel holds the newest fold by the eager-apply invariant.
			return this.kernelValueOf(atom.handle);
		}
		if (world.kind === 'pass' || world.kind === 'committed') {
			const a = this.arenaOf(world);
			if (a !== undefined) return this.aServe(a, atom);
			// Unmaterialized root (no record): fold plain — mirrors the old
			// memo-table rule (never CREATE the root record on a read).
		}
		return this.foldAtom(atom, world);
	}

	/**
	 * Evaluation of a node in a world. Pass/committed worlds are
	 * ARENA-SERVED (NF2 S-B): values, invalidation, and routing structure
	 * live in the world's arena, and `aServe` refolds through the arena's
	 * own walks when marks or cold bases demand it — the cold in-arena fn
	 * run is what RECORDS the strong and weak links the routing coverage
	 * argument stands on (fable N-4; the cold-pass bench gate priced it).
	 * An unmaterialized root has no arena and folds plain. Newest-world
	 * atoms read straight off the kernel arena; newest-world computeds are
	 * KERNEL-SERVED (S-C: one computed — `kernelComputed` below carries the
	 * ruling: stale until a TRACKED dependency changes; untracked reads are
	 * samples taken at re-derivations). mountFix worlds are one-shot
	 * fold-throughs. Reads inside fold callbacks throw (updaters/reducers
	 * must be pure); per-world cycles throw instead of recursing.
	 */
	evaluate(node: AnyNode, world: World): Value {
		probes.worldEvals++; // One Core probe (referee surface)
		if (this.inFoldCallback) throw new BridgeScheduleError('signal read inside an updater/reducer fold — updaters and reducers must be pure; read what you need before dispatching');
		const route = this.serveOverride; // no-override fast-out is the ONE hot test; FOLD_TRUTH falls through (fold-truth computeds re-run checker-side, never here)
		if (route !== undefined && route !== FOLD_TRUTH) return this.aServe(route, node); // arena-refold routing override
		if (world.kind === 'pass' || world.kind === 'committed') {
			const a = this.arenaOf(world);
			if (a !== undefined) return this.aServe(a, node);
		}
		if (node.kind === 'atom') return this.atomValue(node, world);
		if (world.kind === 'newest') return this.kernelComputed(node);
		// Fold-through evaluation (mountFix worlds + unmaterialized-root
		// committed folds): memo-free recursion in the frame's world.
		// Per-world cycle detection via the mark column: marks carry the
		// current top-level evaluation generation.
		const marks = this.evalMark;
		if (marks[node.id] === this.evalGen && this.evalDepth > 0) {
			throw this.cycleError(node.name);
		}
		if (this.evalDepth === 0) this.evalGen++;
		marks[node.id] = this.evalGen;
		this.evalDepth++;
		const savedWorld = this.activeWorld;
		this.setWorld(world);
		const savedSink = this.currentSink;
		const savedObsCapture = this.obsCapture;
		// Observed nodes capture the strong deps of this run (the readers
		// push); everyone else pays this one check.
		this.obsCapture = this.obsRefs[node.id]! > 0 ? [] : undefined;
		this.currentSink = node.id;
		const tr = this.trace; // paired eval hooks; end fires on throw too
		if (tr !== undefined) tr.evalStart(node, world);
		try {
			return node.fn(this.trackedReader, this.untrackedReader);
		} finally {
			const obsCaptured = this.obsCapture;
			this.obsCapture = savedObsCapture;
			this.currentSink = savedSink;
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

	/**
	 * Newest computed serving — the kernel's `computedRead` (S-C; [ruling
	 * 2026-07-06: untracked sampling]: the kernel re-derives only when a
	 * TRACKED dependency changed — kernel links exist for tracked reads
	 * only — so untracked reads are point-in-time samples taken at those
	 * re-derivations, and a write reaching a computed only through
	 * untracked reads changes no newest answer). Read-site translations
	 * preserve the bridge surface: kernel CycleErrors (fresh or cached)
	 * become the bridge's cycle error; a PENDING suspension of a
	 * ctx-shaped (adopted) computed folds to its stable sentinel VALUE for
	 * background reads (the shim wrapper's old translation, engine-owned
	 * since S-C) and rethrows for hook-initiated ones; settled suspensions
	 * self-heal inside the kernel's boxedRead before this frame ever sees
	 * them (RCC-SU5's read-after-await determinism).
	 */
	private kernelComputed(node: ComputedNode): Value {
		try {
			return __kernelComputedRead(node.handle);
		} catch (err) {
			if (err instanceof CycleError) {
				throw this.cycleError(node.name);
			}
			if (err instanceof SuspendedRead && this.suspendDepth === 0 && node.ctxShaped) {
				return err; // adopted ctx fn, background read: the sentinel serves as a value
			}
			throw err;
		}
	}

	/** Mark column + generation for per-world cycle detection (no Set allocs). */
	private evalMark: EvalGen[] = [0];
	private evalGen: EvalGen = 0;

	/** The persistent tracked reader (mountFix/plain-fold frames — arena fn
	 * runs use aTrackedReader; kernel newest runs use kernelTrackedReader):
	 * the pre-dedup observation capture rides the tracked read path
	 * (recordEdge's surviving half, §4.8 S-B), then the dep evaluates in
	 * the frame's world. */
	private trackedReader: Reader = (dep) => {
		const oc = this.obsCapture;
		if (oc !== undefined) oc.push(dep.id);
		return this.evaluate(dep, this.activeWorld!);
	};

	/**
	 * The persistent untracked reader: CAPTURE-free, not INPUT-free — the
	 * dep still folds in the frame's world (fold-throughs re-derive
	 * everything, so untracked deps stay fresh in these one-shot worlds),
	 * but it never joins the observation capture (OL1 is strong-only,
	 * §4.4.1) and — in arena worlds, where aUntrackedReader is the analog —
	 * records only a weak link, so no notification ever fires through it.
	 */
	private untrackedReader: Reader = (dep) => {
		const sink = this.currentSink;
		this.currentSink = 0;
		try {
			return this.evaluate(dep, this.activeWorld!);
		} finally {
			this.currentSink = sink;
		}
	};

	// ---- NF2: arena state + evaluation (the pass/committed authority) ----
	// See the module-level S-B header above AF.

	/** Committed arenas, by root (consumer-populated life — §4.1/§4.5.8). */
	private arenaByRoot = new Map<RootId, ShadowArena>();
	/** Pooled released arena shells (buffers reused; claimGen bumped per tenancy). */
	private arenaPool: ShadowArena[] = [];
	/** Initial arena size in ints (BridgeOptions knob; tests shrink it to force mid-op growth — §4.5.9). */
	private readonly arenaInitInts: ArenaInitInts;
	/** Overlay node id-tenancy generations (§4.5.3: overlay ids are never freed
	 * pre-S-C, so these move only via the test seam; shadows stamp + validate). */
	private nodeGen: number[] = [0];
	/** Open arena evaluation frame (piggybacked on the overlay evaluation OR
	 * an arena-only refold): links record into aFrameArena at aFrameCycle.
	 * Flattened to scalars — one object per evaluation showed up in the
	 * cold-pass gate. undefined arena ⇔ no frame. */
	private aFrameArena: ShadowArena | undefined = undefined;
	private aFrameShadow = 0;
	private aFrameCycle = 0;
	/** THE SERVE-OVERRIDE SLOT — the one override the routed-read path tests
	 * (W3 merged the old two-slot pair; setters bracket save/restore, so the
	 * innermost override wins). Occupants: a ShadowArena (arena-refold
	 * routing — raw-handle reads inside arena fn runs serve from that arena)
	 * or FOLD_TRUTH (the armed checker's naive reads — atom reads fold plain
	 * in the frame's world: no arenas, no memos, no caches; test-armed only).
	 * undefined ⇔ no override, the production steady state. */
	private serveOverride: ShadowArena | typeof FOLD_TRUTH | undefined = undefined;
	/** Global count of box-suspended shadows (tap fast-out). */
	private suspendedCount = 0;
	/** The armed divergence-check hook (W3): the referee-grade checker lives
	 * in tests/arena-checker.ts and installs itself here through
	 * `__checkerInternals().armEpilogueCheck`. Fired at every public
	 * operation's epilogue after the settlement fixed point; ANY mismatch it
	 * finds throws — a lockstep test failure. Production never installs one,
	 * so the epilogue pays one undefined test. */
	private epilogueCheck: (() => void) | undefined = undefined;

	private claimArena(kind: 'pass' | 'committed', world: World, root: RootId): ShadowArena {
		let a = this.arenaPool.pop();
		if (a === undefined) {
			a = new ShadowArena(kind, world, root, new Int32Array(this.arenaInitInts));
		} else {
			a.kind = kind;
			a.world = world;
			a.root = root;
		}
		a.alive = true;
		a.claimGen++;
		// Dense byNode: pre-size to the node population and keep it PACKED
		// (holey reads cost on the cold-read hot path; shadowFor probes this
		// per read). aAllocShadow grows it densely past this watermark.
		const n = this.nodesArr.length;
		for (let i = a.byNode.length; i < n; i++) a.byNode.push(0);
		return a;
	}

	/** Release an arena: buffer to the pool, claim generation bumped, columns
	 * dropped (payload release), dirty + suspended lists discarded (§4.5.8 —
	 * safe by the evict-don't-serve argument; nobody observes those cones). */
	private releaseArena(a: ShadowArena): void {
		for (let i = 0; i < a.suspended.length; i++) this.suspendedCount--;
		a.alive = false;
		a.claimGen++;
		// Keep the side columns' CAPACITY across pool tenancies (B1 cold-pass
		// shave): truncating to 0 forced claimArena + aAllocShadow to re-push
		// every element on every claim (~2k pushes per cold pass). fill()
		// scrubs the residue the truncation used to drop — value refs are
		// released (no pooled-arena leak), byNode reads 0 (= none), suspIdx
		// reads 0 (= not suspended) — while the packed length persists, so
		// the next tenancy's growth loops are no-ops up to this watermark.
		a.byNode.fill(0);
		a.vals.fill(undefined);
		a.suspIdx.fill(0);
		a.walk.fill(0);
		a.weakSubs.fill(0);
		a.weakSubsTail.fill(0);
		a.dirty.length = 0;
		a.suspended.length = 0;
		// Scrub the written record prefix so pooled buffers re-claim ALL-ZERO
		// past the burned record — aAllocShadow's fresh-record invariant (one
		// vectorized fill here beats per-field zeroing on every cold alloc,
		// and closes the pooled-residue class wholesale: nothing survives).
		a.W.fill(0, 0, a.next);
		a.next = A_STRIDE;
		a.linkFree = 0;
		a.shadowFree = 0; // dead-shadow list dies with the tenancy (threads were zeroed above)
		a.links = 0;
		a.readClock = 0;
		a.cycle = 0;
		if (this.arenaPool.length < 8) this.arenaPool.push(a);
	}

	/** The arena of a world: pass arenas ride the pass record (claimed at
	 * passStart, m2's dev assert on dropped-arena touch); committed arenas
	 * materialize lazily at the root's first committed evaluation and persist
	 * for the root's consumer-populated life (§4.1). */
	private arenaOf(world: World): ShadowArena | undefined {
		if (world.kind === 'pass') {
			const a = world.pass.arena;
			if (a !== undefined && !a.alive) throw new BridgeInvariantViolation(`arena of pass ${world.pass.id} was reclaimed while still reachable (m2)`);
			return a;
		}
		if (world.kind !== 'committed') return undefined;
		let a = this.arenaByRoot.get(world.root);
		if (a === undefined) {
			// Mirror memoTableOf's rule: never CREATE the root record here.
			if (!this.roots.has(world.root)) return undefined;
			a = this.claimArena('committed', { kind: 'committed', root: world.root }, world.root);
			this.arenaByRoot.set(world.root, a);
		}
		return a;
	}

	private eachArena(fn: (a: ShadowArena) => void): void {
		for (const a of this.arenaByRoot.values()) fn(a);
		for (const p of this.openPassByRoot.values()) {
			if (p.arena !== undefined) fn(p.arena);
		}
	}

	/** Shadow lookup/create with the §4.5.3 GEN id-tenancy validation: a
	 * dead-GEN shadow never serves — it is reset cold and re-tenanted. */
	private shadowFor(a: ShadowArena, nid: NodeId, kindFlags: number): number {
		let sh = nid < a.byNode.length ? a.byNode[nid]! : 0;
		const gen = this.nodeGen[nid]!; // dense (indexNode) — no OOB/?? probe on the hot path
		if (sh !== 0) {
			if (a.W[sh + AF.GEN] === gen) return sh;
			// Dead tenancy: evict, purge links (both directions, both subs
			// lists), refold under the new tenant — never serve the dead
			// node's value or fn.
			this.aEvictShadow(a, sh);
			a.W[sh + AF.FLAGS] = kindFlags;
			a.W[sh + AF.GEN] = gen;
			a.W[sh + AF.MARK] = 0;
			return sh;
		}
		sh = aAllocShadow(a, nid, kindFlags, gen);
		return sh;
	}

	/** Detach a shadow from its arena wholesale: deps in reverse, BOTH subs
	 * lists, the suspended set, the cached value. Shared by shadowFor's
	 * dead-tenancy re-key (§4.5.3) and disposeComputed's eager purge. */
	private aEvictShadow(a: ShadowArena, sh: number): void {
		aDisposeAllDepsInReverse(a, sh);
		for (let list = 0; list < 2; list++) {
			let sl = aSubsHead(a, sh, list);
			while (sl !== 0) {
				const next = a.W[sl + AF.L_NEXT_SUB]!;
				aUnlink(a, sl);
				sl = next;
			}
		}
		if ((a.W[sh + AF.FLAGS]! & AFlag.BOX_SUSPENDED) !== 0) this.aUnsuspend(a, sh);
		a.vals[sh >> A_SHIFT] = undefined;
	}

	/** Arena dep recording (arena fn-reader hook): first-occurrence mode
	 * reset + strong-dominates ride inside aLink (§4.4.1). The pre-dedup
	 * observation capture rides the STRONG arm only (§4.7/M6 — the
	 * discipline carried into the walks; OL1 is strong-only). */
	private aRecordDep(dep: AnyNode, weak: boolean): void {
		const a = this.aFrameArena;
		if (a === undefined) return;
		if (!weak) {
			const oc = this.obsCapture;
			if (oc !== undefined) oc.push(dep.id);
		}
		const sh = dep.kind === 'atom'
			? this.shadowFor(a, dep.id, AFlag.K_SIGNAL | AFlag.MUTABLE)
			: this.shadowFor(a, dep.id, AFlag.K_COMPUTED);
		aLink(a, sh, this.aFrameShadow, this.aFrameCycle, weak);
	}

	/** The arena atom-propagation gate is Object.is over FOLD OUTPUTS: the
	 * atom's own `equals` already participated in the fold's stepwise
	 * equality, and world serving re-derives consumers on any fold-output
	 * motion — a custom comparator here could suppress propagation the fold
	 * path performs (dual-bookkeeping divergence by construction). The
	 * §4.5.3 comparator-order mandate — HEAD's `isEqual(prev, next)`,
	 * mirroring the kernel's `writeAtom` compare — binds the CUSTOM-EQUALITY
	 * COMPUTED record (aFoldOutcome's comparator arm, landed at S-C). */
	private aEqAtom(prev: Value, next: Value): boolean {
		return Object.is(prev, next);
	}

	/** Suspended-list append on the box-suspended bit's 0→1; the per-shadow
	 * field stores the dense index (S-A step 0 compaction — §4.5.4). */
	private aSuspend(a: ShadowArena, sh: number): void {
		const vi = sh >> A_SHIFT;
		if (a.suspIdx[vi] !== 0) return; // already a member (value column just swaps sentinels)
		a.suspended.push(sh);
		a.suspIdx[vi] = a.suspended.length; // index + 1
		this.suspendedCount++;
	}

	/** Swap-remove at the stored index on the 1→0 clear: the list stays a
	 * DENSE set; the moved entry's stored index is updated (S-A step 0). */
	private aUnsuspend(a: ShadowArena, sh: number): void {
		const vi = sh >> A_SHIFT;
		const slot = a.suspIdx[vi]!;
		if (slot === 0) return;
		const last = a.suspended.length - 1;
		const moved = a.suspended[last]!;
		a.suspended[slot - 1] = moved;
		a.suspIdx[moved >> A_SHIFT] = slot;
		a.suspended.pop();
		a.suspIdx[vi] = 0;
		this.suspendedCount--;
	}

	/** Exceptional outcome of an arena fn run (aUpdateComputed's catch):
	 * cache the thrown payload into the shadow with the THROWN bit — later
	 * serves rethrow it boxedRead-style (a thrown suspension re-runs once
	 * its thenable settles: the serve-site probe marks it DIRTY). */
	private aNoteThrow(a: ShadowArena, sh: number, err: unknown): void {
		const W = a.W;
		const flags = W[sh + AF.FLAGS]!;
		const vi = sh >> A_SHIFT;
		aBumpReadClock(a);
		if (err instanceof SuspendedRead) {
			a.vals[vi] = err;
			W[sh + AF.FLAGS] = (flags & ~(AFlag.DIRTY | AFlag.PENDING)) | AFlag.VALID | AFlag.HAS_BOX | AFlag.BOX_SUSPENDED | AFlag.BOX_THROWN;
			this.aSuspend(a, sh);
			return;
		}
		if ((flags & AFlag.BOX_SUSPENDED) !== 0) this.aUnsuspend(a, sh);
		a.vals[vi] = err;
		W[sh + AF.FLAGS] = (flags & ~(AFlag.DIRTY | AFlag.PENDING | AFlag.BOX_SUSPENDED)) | AFlag.VALID | AFlag.HAS_BOX | AFlag.BOX_THROWN;
	}

	// ---- NF2: arena serving (world reads, checks, settlement refolds) ----

	/** Serve a node from an arena — THE pass/committed read path since S-B —
	 * refolding through the arena's own walks when marks or cold bases
	 * demand it. Refolds run under the arena-only routing override so
	 * raw-handle reads inside fns resolve to arena values too; frame-link
	 * sites feed the observation capture (raw reads have no reader hook). */
	private aServe(a: ShadowArena, node: AnyNode): Value {
		if (node.kind === 'atom') {
			const sh = this.shadowFor(a, node.id, AFlag.K_SIGNAL | AFlag.MUTABLE);
			const W = a.W;
			const flags = W[sh + AF.FLAGS]!;
			if ((flags & AFlag.VALID) === 0 || (flags & AFlag.DIRTY) !== 0) {
				// Spike wAtomRead: a changed refold upgrades PENDING dependents
				// to DIRTY (shallow propagate, both subs lists) so their
				// re-check refolds them.
				if (this.aUpdateShadow(a, sh)) aShallowBoth(a, sh);
			}
			if (this.aFrameArena === a) {
				aLink(a, sh, this.aFrameShadow, this.aFrameCycle, false);
				const oc = this.obsCapture;
				if (oc !== undefined) oc.push(node.id);
			}
			return a.vals[sh >> A_SHIFT];
		}
		const sh = this.shadowFor(a, node.id, AFlag.K_COMPUTED);
		const W = a.W;
		let flags = W[sh + AF.FLAGS]!;
		if ((flags & AFlag.RECURSED_CHECK) !== 0) {
			throw this.cycleError(node.name);
		}
		// Read-site self-heal probe (§4.5.4 pull half; mirrored at the memo
		// serve and the kernel's boxedRead): a settled-but-not-yet-invalidated
		// suspension self-invalidates AT THE READ, so a read after `await` is
		// deterministic even before the settle listener's microtask runs.
		if ((flags & AFlag.BOX_SUSPENDED) !== 0) {
			const t = (a.vals[sh >> A_SHIFT] as SuspendedRead).thenable as { status?: string };
			if (t.status !== undefined && t.status !== 'pending') {
				W[sh + AF.FLAGS] = flags | AFlag.DIRTY;
				flags = W[sh + AF.FLAGS]!;
			}
		}
		if ((flags & AFlag.MUTABLE) === 0) {
			this.aUpdateComputed(a, sh); // never evaluated in this arena: cold fold
		} else if (
			(flags & AFlag.DIRTY) !== 0
			// Evicted-to-cold residue (decay §4.3 / torn-cone dirt): VALID is
			// the "value column holds a folded value" bit — with it clear the
			// slot is evicted and must refold on consult, exactly as the atom
			// branch above does. MUTABLE alone only says "evaluated once".
			|| (flags & AFlag.VALID) === 0
			|| ((flags & AFlag.PENDING) !== 0 && this.aCheckDirty(a, a.W[sh + AF.DEPS]!, sh))
		) {
			if (this.aUpdateComputed(a, sh)) aShallowBoth(a, sh);
		} else if ((flags & AFlag.PENDING) !== 0) {
			a.W[sh + AF.FLAGS] = flags & ~AFlag.PENDING;
		}
		if (this.aFrameArena === a) {
			aLink(a, sh, this.aFrameShadow, this.aFrameCycle, false);
			const oc = this.obsCapture;
			if (oc !== undefined) oc.push(node.id);
		}
		const outFlags = a.W[sh + AF.FLAGS]!;
		// The boxedRead-style rethrow discipline (arenas serve real reads at
		// S-B): a THROWN payload — plain error, or a still-pending render-path
		// suspension — rethrows from the cache; a RETURNED sentinel (the shim
		// wrapper folds background suspensions to the sentinel VALUE) serves
		// as a value, compared by identity (battery 16d's still-pending rule).
		if ((outFlags & AFlag.HAS_BOX) !== 0 && ((outFlags & AFlag.BOX_SUSPENDED) === 0 || (outFlags & AFlag.BOX_THROWN) !== 0)) {
			throw a.vals[sh >> A_SHIFT];
		}
		return a.vals[sh >> A_SHIFT];
	}

	/** Spike `wUpdate`: refold a shadow (atom fold or computed fn run);
	 * returns whether the world's value changed (the §4.2 value cutoff). */
	private aUpdateShadow(a: ShadowArena, sh: number): boolean {
		const flags = a.W[sh + AF.FLAGS]!;
		if ((flags & AFlag.K_COMPUTED) !== 0) return this.aUpdateComputed(a, sh);
		const nid = a.W[sh + AF.NODE]!;
		const atom = this.nodesArr[nid] as AtomNode;
		// §4.2 (iii): marked ⇒ REFOLD unconditionally — no fingerprint
		// consulted (the fp side channel was deleted at S-D).
		const next = this.foldAtom(atom, a.world);
		const vi = sh >> A_SHIFT;
		const prev = a.vals[vi];
		const prevValid = (flags & AFlag.VALID) !== 0;
		a.W[sh + AF.FLAGS] = (flags & ~(AFlag.DIRTY | AFlag.PENDING)) | AFlag.VALID;
		aBumpReadClock(a);
		// The shadow column ALWAYS stores the fold's own output (dual
		// bookkeeping requires arena value ≡ fold, bit for bit); the
		// comparator gates PROPAGATION only. Reference preservation for
		// custom-equality COMPUTEDS lives in aFoldOutcome (§4.5.3, S-C).
		a.vals[vi] = next;
		return !(prevValid && this.aEqAtom(prev, next));
	}

	/** Arena computed refold: the fn runs with the ARENA readers and the
	 * arena-only routing override — no memo writes. The evaluating world is
	 * set so raw-handle reads route. OBSERVED nodes capture the strong deps
	 * of this run and re-point their retains afterward (§4.7/M6: the
	 * world-path retain re-point, carried into the arena walks at S-B). */
	private aUpdateComputed(a: ShadowArena, sh: number): boolean {
		const nid = a.W[sh + AF.NODE]!;
		const node = this.nodesArr[nid] as ComputedNode;
		a.W[sh + AF.DEPS_TAIL] = 0;
		a.W[sh + AF.FLAGS] = (a.W[sh + AF.FLAGS]! | AFlag.MUTABLE | AFlag.RECURSED_CHECK) & ~(AFlag.RECURSED | AFlag.DIRTY | AFlag.PENDING);
		const savedFrameArena = this.aFrameArena;
		const savedFrameShadow = this.aFrameShadow;
		const savedFrameCycle = this.aFrameCycle;
		const savedRoute = this.serveOverride;
		const savedWorld = this.activeWorld;
		const savedSink = this.currentSink;
		const savedObsCapture = this.obsCapture;
		this.aFrameArena = a;
		this.aFrameShadow = sh;
		this.aFrameCycle = aBumpCycle(a);
		this.serveOverride = a;
		this.currentSink = 0;
		this.obsCapture = this.obsRefs[nid]! > 0 ? [] : undefined;
		this.setWorld(a.world);
		this.evalDepth++;
		const tr = this.trace; // paired eval hooks; end fires on throw too
		if (tr !== undefined) tr.evalStart(node, a.world);
		try {
			return this.aFoldOutcome(a, sh, node.fn(this.aTrackedReader, this.aUntrackedReader), node.isEqual);
		} catch (err) {
			this.aNoteThrow(a, sh, err);
			throw err;
		} finally {
			if (tr !== undefined) tr.evalEnd();
			const obsCaptured = this.obsCapture;
			this.evalDepth--;
			this.setWorld(savedWorld);
			this.obsCapture = savedObsCapture;
			this.currentSink = savedSink;
			this.serveOverride = savedRoute;
			this.aFrameArena = savedFrameArena;
			this.aFrameShadow = savedFrameShadow;
			this.aFrameCycle = savedFrameCycle;
			a.W[sh + AF.FLAGS] = a.W[sh + AF.FLAGS]! & ~AFlag.RECURSED_CHECK;
			aPurgeDeps(a, sh);
			aBumpReadClock(a);
			if (obsCaptured !== undefined) this.aSyncObsAfterRefold(nid, obsCaptured);
		}
	}

	/** Observed-closure sync after an arena refold, out of line (keeps
	 * aUpdateComputed under the V8 inline budget; observed nodes only) —
	 * after every restore, so discovery evaluations run on a clean frame
	 * stack. A NESTED refold (inside an outer walk) has serveOverride
	 * restored to the OUTER arena; clear it around the sync so discovery's
	 * newest evaluations route newest. */
	private aSyncObsAfterRefold(nid: NodeId, captured: NodeId[]): void {
		const so = this.serveOverride;
		this.serveOverride = undefined;
		try {
			this.obsSyncDeps(nid, captured);
		} finally {
			this.serveOverride = so;
		}
	}

	/** Fold epilogue of an arena computed refold, out of line from
	 * aUpdateComputed (B2 split — the frame save/restore wrapper stays under
	 * V8's 460-bytecode inline budget): classify the fn's outcome —
	 * suspension sentinel or plain value — into the shadow's value column
	 * and outcome bits; returns the §4.2 value cutoff. The caller cleared
	 * DIRTY/PENDING at entry, and its call sites own propagation. A RETURNED
	 * sentinel clears the THROWN bit (it serves as a value; box→same-box by
	 * sentinel identity is UNCHANGED — battery 16d's still-pending rule).
	 * §4.5.3 (S-C): custom-equality computeds compare through their policy
	 * comparator against the ARENA-LOCAL previous value — never the kernel
	 * slot — in HEAD's argument order `isEqual(prev, next)` (mirroring the
	 * kernel's writeAtom compare; comparators need not be equivalence
	 * relations, so the order is load-bearing). On unchanged, the PREVIOUS
	 * reference is kept (write nothing). Equality never bridges an
	 * exceptional boundary: `prevValid` demands a plain previous value. */
	private aFoldOutcome(a: ShadowArena, sh: number, value: Value, eq: Equals | undefined): boolean {
		const vi = sh >> A_SHIFT;
		const flags = a.W[sh + AF.FLAGS]!;
		if (value instanceof SuspendedRead) {
			const same = (flags & AFlag.BOX_SUSPENDED) !== 0 && (flags & AFlag.BOX_THROWN) === 0 && a.vals[vi] === value;
			a.vals[vi] = value;
			a.W[sh + AF.FLAGS] = (flags & ~AFlag.BOX_THROWN) | AFlag.VALID | AFlag.HAS_BOX | AFlag.BOX_SUSPENDED;
			this.aSuspend(a, sh);
			return !same;
		}
		const prevValid = (flags & AFlag.VALID) !== 0 && (flags & AFlag.HAS_BOX) === 0;
		const changed = !(prevValid && (eq === undefined
			? Object.is(a.vals[vi], value)
			: this.aEqCold(eq, a.vals[vi], value)));
		if ((flags & AFlag.BOX_SUSPENDED) !== 0) this.aUnsuspend(a, sh);
		if (changed) a.vals[vi] = value;
		a.W[sh + AF.FLAGS] = (a.W[sh + AF.FLAGS]! & ~(AFlag.HAS_BOX | AFlag.BOX_SUSPENDED | AFlag.BOX_THROWN)) | AFlag.VALID;
		return changed;
	}

	/** The custom-equality compare, out of line (cold — §4.5.3 policy users
	 * only; keeps aFoldOutcome's hot default arm closure-free and under its
	 * budget). HEAD argument order: isEqual(prev, next) — see aFoldOutcome. */
	private aEqCold(eq: Equals, prev: Value, next: Value): boolean {
		return this.inCallback(() => eq(prev, next));
	}

	private aTrackedReader: Reader = (dep) => {
		this.aRecordDep(dep, false);
		return this.aServe(this.aFrameArena!, dep);
	};

	private aUntrackedReader: Reader = (dep) => {
		this.aRecordDep(dep, true);
		const a = this.aFrameArena;
		this.aFrameArena = undefined; // untracked: dep's own reads link nowhere new
		try {
			return this.aServe(a!, dep);
		} finally {
			this.aFrameArena = a;
		}
	};

	/** Spike `wCheckDirty` transliteration (aUpdateShadow can run getters —
	 * allocations, arena growth — so a.W re-loads after every update call).
	 * Entry wrapper: owns the scratch-stack base restore around the
	 * out-of-line walk so each piece stays under V8's 460-bytecode inline
	 * budget (B2 — the arena twin of the kernel checkDirty split). */
	private aCheckDirty(a: ShadowArena, startLink: number, startSub: number): boolean {
		if (startLink === 0) return false;
		const stackBase = aCheckSp;
		try {
			return this.aCheckDirtyLoop(a, startLink, startSub);
		} finally {
			aCheckSp = stackBase;
		}
	}

	/** aUpdateShadow + sibling Pending->Dirty upgrade, shared by the descend
	 * and unwind arms of aCheckDirtyLoop. Heads are captured BEFORE the
	 * refold runs (it can rebuild the lists), as in the kernel's
	 * updateAndShallow; BOTH subs lists take the upgrade (§4.4.1). The
	 * kernel's single-sub skip ("the only sub is the walker itself") is
	 * UNSOUND under the segregated lists — a validation walk can arrive via
	 * the OTHER list, leaving a lone strong sub PENDING with no refold due
	 * (found by the fuzz corpus, seed 40: a weak-side validation refolded
	 * the shared dep and the strong-side consumer stale-served) — so both
	 * lists propagate unconditionally; the walker's own re-upgrade is a
	 * flag-guarded no-op. */
	private aUpdateAndShallow(a: ShadowArena, node: number): boolean {
		const subs = a.W[node + AF.SUBS]!;
		const weak = a.weakSubs[node >> A_SHIFT]!;
		if (this.aUpdateShadow(a, node)) {
			if (subs !== 0) aShallowPropagate(a, subs);
			if (weak !== 0) aShallowPropagate(a, weak);
			return true;
		}
		return false;
	}

	/** The general arena walk, out of line (see aCheckDirty — the wrapper
	 * owns the aCheckSp restore, so a throwing fold unwinds through it). */
	private aCheckDirtyLoop(a: ShadowArena, cur: number, sub: number): boolean {
		let checkDepth = 0;
		let dirty = false;
		let guard = 0;
		top: do {
			if (++guard > 1_000_000) throw new BridgeInvariantViolation(`aCheckDirty: walk exceeded 1e6 steps (cycle) at link ${cur}`);
			const W = a.W;
			const dep = W[cur + AF.L_DEP]!;
			const depFlags = W[dep + AF.FLAGS]!;
			if ((W[sub + AF.FLAGS]! & AFlag.DIRTY) !== 0) {
				dirty = true;
			} else if (
				(depFlags & (AFlag.MUTABLE | AFlag.DIRTY)) === (AFlag.MUTABLE | AFlag.DIRTY)
				// Cold base (decay §4.3 evicted the value: MUTABLE kept, VALID
				// cleared, column dropped) — the walk's twin of aServe's
				// evicted-to-cold arm: with no folded value there is nothing to
				// validate against, so a cold dep IS dirt and must refold on
				// consult. Without this arm a cold base is invisible (neither
				// DIRTY nor PENDING) and a top-first serve stale-serves its
				// cone (the B2-documented S-A bug; pinned in arena-sa3).
				|| (depFlags & (AFlag.MUTABLE | AFlag.VALID)) === AFlag.MUTABLE
			) {
				if (this.aUpdateAndShallow(a, dep)) {
					dirty = true;
				}
			} else if ((depFlags & (AFlag.MUTABLE | AFlag.PENDING)) === (AFlag.MUTABLE | AFlag.PENDING)) {
				if (aCheckSp === aCheckStack.length) {
					const bigger = new Int32Array(aCheckStack.length * 2);
					bigger.set(aCheckStack);
					aCheckStack = bigger;
				}
				aCheckStack[aCheckSp++] = cur;
				cur = W[dep + AF.DEPS]!;
				sub = dep;
				++checkDepth;
				continue;
			}
			if (!dirty) {
				const nextDep = a.W[cur + AF.L_NEXT_DEP]!;
				if (nextDep !== 0) {
					cur = nextDep;
					continue;
				}
			}
			while (checkDepth--) {
				cur = aCheckStack[--aCheckSp]!;
				if (dirty) {
					if (this.aUpdateAndShallow(a, sub)) {
						sub = a.W[cur + AF.L_SUB]!;
						continue;
					}
					dirty = false;
				} else {
					a.W[sub + AF.FLAGS] = a.W[sub + AF.FLAGS]! & ~AFlag.PENDING;
				}
				sub = a.W[cur + AF.L_SUB]!;
				const nextDep = a.W[cur + AF.L_NEXT_DEP]!;
				if (nextDep !== 0) {
					cur = nextDep;
					continue top;
				}
			}
			return dirty;
		} while (true);
	}

	// ---- NF2 S-A: fanout at the four flip sites + mark decay (§4.3) ----

	/** Mark the flipped atoms' shadows in one arena and propagate PENDING over
	 * strong AND weak links, with the read-clock dedup: a still-DIRTY shadow
	 * whose MARK stamp equals the arena's clock has an already-marked cone
	 * that nothing re-validated since — re-propagation would be a no-op walk.
	 * Pass arenas receive NO receipt-driven fanout, ever (the pin proof,
	 * §4.3) — dev-asserted here; the one pin-exempt mark source is L4
	 * resource settlement (`fromSettlement`). */
	private fanAtomsToArena(a: ShadowArena, atoms: AtomNode[], fromSettlement: boolean): void {
		if (a.kind === 'pass' && !fromSettlement) {
			throw new BridgeInvariantViolation('receipt-flip fanout reached a pass arena — pass-world values are pin-frozen (§4.3)');
		}
		const W = a.W;
		for (let i = 0; i < atoms.length; i++) {
			const sh = a.byNode[atoms[i]!.id] ?? 0;
			if (sh === 0) continue; // no shadow: nothing consumes this atom here
			const flags = W[sh + AF.FLAGS]!;
			if ((flags & AFlag.DIRTY) !== 0 && W[sh + AF.MARK] === a.readClock) continue; // dedup
			if ((flags & AFlag.DIRTY) === 0) {
				W[sh + AF.FLAGS] = flags | AFlag.DIRTY;
				a.dirty.push(sh); // dirty-LIST append on the mark's 0→1 edge
			}
			W[sh + AF.MARK] = a.readClock;
			aPropagateBoth(a, sh); // strong AND weak (§4.4.1)
		}
	}

	/** Reused single-atom buffer for site (c)/(d) fanout (no per-write alloc). */
	private oneAtom: AtomNode[] = [];
	private oneAtomBuf(atom: AtomNode): AtomNode[] {
		this.oneAtom[0] = atom;
		return this.oneAtom;
	}

	/** Site (a)/(d) helper: fan into EVERY live committed arena. */
	private fanAtomsToCommittedArenas(atoms: AtomNode[]): void {
		if (this.arenaByRoot.size === 0) return; // the one scalar check quiet writes pay (§4.1.2)
		for (const a of this.arenaByRoot.values()) this.fanAtomsToArena(a, atoms, false);
	}

	/** §4.3 decay-by-eviction: swap the dirty list; an entry no evaluation
	 * consumed whose node has no live same-root watcher MAY drop to cold
	 * (evict the value, clear the mark) instead of re-appending — the dirty
	 * list stays bounded by live consumers' cones. A mark never clears
	 * without its refold having run OR its value having been evicted. */
	private arenaDecay(a: ShadowArena): void {
		if (a.dirty.length === 0) return;
		const list = a.dirty;
		a.dirty = [];
		const W = a.W;
		for (let i = 0; i < list.length; i++) {
			const sh = list[i]!;
			const flags = W[sh + AF.FLAGS]!;
			if ((flags & AFlag.DIRTY) === 0) continue; // consumed by an evaluation: drop the entry
			const nid = W[sh + AF.NODE]!;
			const ws = this.watchersByNode[nid];
			let watched = false;
			if (ws !== undefined) {
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
				// MUTABLE stay so routing coverage survives (§4.1's point).
				if ((flags & AFlag.BOX_SUSPENDED) !== 0) this.aUnsuspend(a, sh);
				W[sh + AF.FLAGS] = flags & ~(AFlag.DIRTY | AFlag.VALID | AFlag.HAS_BOX | AFlag.BOX_SUSPENDED | AFlag.BOX_THROWN);
				a.vals[sh >> A_SHIFT] = undefined;
			}
		}
	}

	// ---- NF2 S-A: settlement tap + queue + drain (§4.5.4, step-0 shapes) ----

	/** Pending-settlement queue + the sentinel queued bit (identity dedup). */
	private pendingSettle: SuspendedRead[] = [];
	private pendingSettleSet = new Set<SuspendedRead>();
	private settleDraining = false;
	private settleDrainScheduled = false;
	/** Public-operation nesting (the settlement firing-context discriminant). */
	private opDepth = 0;
	/** Step-0 termination: the settlement drain adopts the engine's flush
	 * bound discipline — an iteration cap with a diagnostic on breach; a
	 * chain of callbacks that synchronously settles ever-new thenables is
	 * USER feedback, the effect-loop equivalent. */
	private settleCap = 10_000;

	/** Test seam: shrink the settlement-drain iteration cap. @internal */
	__setSettleCapForTest(n: number): void {
		this.settleCap = n;
	}

	/**
	 * The settle tap (§4.5.4 push half): called by the kernel's per-thenable
	 * shared listener after the status write. Mint-on-tap is the FIRST act —
	 * the kernel's own lazy-mint expression — so a synchronous custom
	 * thenable (whose callbacks fire before `unwrapThenable`'s throw mints
	 * `t.sr`) still yields ONE sentinel identity shared with the later throw.
	 */
	__settleTap(t: PromiseLike<unknown>): void {
		const th = t as PromiseLike<unknown> & { sr?: SuspendedRead };
		const sr = (th.sr ??= new SuspendedRead(t));
		if (this.suspendedCount === 0 && this.pendingSettle.length === 0) return; // no arena suspensions anywhere
		if (this.pendingSettleSet.has(sr)) return; // queued bit
		this.pendingSettleSet.add(sr);
		this.pendingSettle.push(sr);
		if (this.settleDraining || this.notifyFlushing || this.opDepth !== 0 || this.evalDepth !== 0 || this.inFoldCallback) {
			// Mid-operation: the enclosing operation's epilogue (or the drain's
			// own next iteration) consumes it. Read-context settlement (S-A
			// step 0): an epilogue-less read frame — standalone committedValue/
			// passValue — has no epilogue, so ALSO schedule ONE coalesced
			// microtask drain, the kernel's own attachSettle discipline
			// (queueMicrotask); it no-ops when an epilogue got there first.
			if (!this.settleDrainScheduled) {
				this.settleDrainScheduled = true;
				queueMicrotask(() => {
					this.settleDrainScheduled = false;
					if (this.pendingSettle.length !== 0 && this.opDepth === 0 && this.evalDepth === 0 && !this.settleDraining && !this.notifyFlushing) {
						this.settlementDrain();
					}
				});
			}
			return;
		}
		// At rest (the kernel's batchDepth === 0 arm): drain NOW — a
		// background-only suspended watcher or effect refires FROM the
		// settlement event itself; no unrelated operation is ever needed.
		this.settlementDrain();
	}

	/**
	 * The settlement drain — ONE queue-owning loop, the only consumer of the
	 * pending-settlement queue, identical at every drain site, and it OWNS
	 * the notification flush (S-A step 0): `flushNotify` is INSIDE the loop,
	 * so a refire callback that synchronously settles another thenable lands
	 * its sentinel in the queue and gets the NEXT iteration. The drain IS the
	 * EF2 settlement boundary; it never returns with a queued settlement
	 * unscanned or unflushed.
	 */
	private settlementDrain(): void {
		if (this.settleDraining) return;
		this.settleDraining = true;
		this.opDepth++; // taps landing mid-drain enqueue (next iteration)
		try {
			let iter = 0;
			while (this.pendingSettle.length !== 0) {
				if (++iter > this.settleCap) {
					throw new BridgeInvariantViolation(
						`settlement drain exceeded ${this.settleCap} iterations — a settlement chain is synchronously settling ever-new thenables (user feedback, the effect-loop equivalent)`,
					);
				}
				const taken = this.pendingSettle;
				this.pendingSettle = [];
				for (let i = 0; i < taken.length; i++) this.pendingSettleSet.delete(taken[i]!);
				const touchedRoots = new Set<RootId>();
				for (let i = 0; i < taken.length; i++) {
					const sr = taken[i]!;
					this.eachArena((a) => {
						// Scan the suspended list (dense — O(current suspensions),
						// §4.5.4) for shadows whose box payload IS this sentinel.
						const list = a.suspended;
						const W = a.W;
						let matched = false;
						for (let j = 0; j < list.length; j++) {
							const sh = list[j]!;
							if (a.vals[sh >> A_SHIFT] !== sr) continue;
							const flags = W[sh + AF.FLAGS]!;
							if ((flags & AFlag.DIRTY) === 0) {
								W[sh + AF.FLAGS] = flags | AFlag.DIRTY;
								a.dirty.push(sh);
							}
							W[sh + AF.MARK] = a.readClock;
							aPropagateBoth(a, sh); // strong AND weak; pin-exempt for pass arenas (§4.3)
							matched = true;
							// The marks above ARE the invalidation (arenas serve
							// world reads since S-B); committed roots also join the
							// cone drain below. Open-pass arenas keep their marks
							// for the frame's close.
							if (a.kind === 'committed') touchedRoots.add(a.root);
						}
						if (matched) aBumpReadClock(a);
					});
					// (Newest suspensions need no eviction here since S-C: the
					// kernel's own attachSettle listener invalidates kernel-cached
					// suspensions at settlement, and boxedRead self-heals at reads.)
				}
				// Cone drain: value-gated committed re-checks of the touched
				// roots' live watchers (the durable-drain compare; the marks
				// fanned above drive the arena refolds), deferred for roots
				// with an open render frame (their close flushes).
				for (const rootId of touchedRoots) {
					if (this.openPassByRoot.has(rootId)) continue;
					for (const w of this.watchers.values()) {
						if (!w.live || w.root !== rootId) continue;
						const wNode = this.nodeById(w.node);
						this.correctWatcher(w, wNode, this.evaluate(wNode, { kind: 'committed', root: rootId }), 'retirement');
					}
				}
				// Boundary subscription scan + the flush the loop OWNS.
				// (Core effect()s need nothing here: settlements move world
				// visibility, never newest values, so the kernel is untouched.)
				if (this.committedSubCount !== 0) this.revalidateCommittedSubs(undefined);
				this.flushNotify();
			}
		} finally {
			this.opDepth--;
			this.settleDraining = false;
		}
	}

	/** Public-operation epilogue (S-A): drain queued settlements to empty
	 * (the fixed point), then the divergence check when armed. */
	private arenaOpEpilogue(): void {
		if (this.pendingSettle.length !== 0 && !this.settleDraining && this.opDepth === 0) this.settlementDrain();
		if (this.epilogueCheck !== undefined) this.epilogueCheck();
	}

	// ---- NF2 S-A: reclamation (§4.5.8) + the checker window (§4.9 — the
	// divergence check and structural validator are TEST machinery and live
	// in tests/arena-checker.ts, fed through __checkerInternals below) ----

	/** The watcher-population refcount, derived (dev-assertable) form: live
	 * watchers of the root + live committed subscriptions of the root. */
	private consumerCount(rootId: RootId): number {
		let n = 0;
		for (const w of this.watchers.values()) {
			if (w.live && w.root === rootId) n++;
		}
		for (const e of this.subs.values()) {
			if (e.live && e.root === rootId) n++;
		}
		return n;
	}

	/** Quiesce duty 1 (§4.5.8): release committed arenas whose consumer
	 * population is zero — buffer to the pool (claim gen bumped), columns
	 * dropped, lists discarded; the root RECORD stays (no teardown event
	 * exists — RUL-6 records the fallback). Then duty 2 (§4.5.7): per-arena
	 * read-clock renumber over the SURVIVORS only. */
	private arenaQuiesceSweep(): void {
		for (const [rootId, a] of this.arenaByRoot) {
			if (this.consumerCount(rootId) === 0) {
				this.arenaByRoot.delete(rootId);
				this.releaseArena(a);
			}
		}
		for (const a of this.arenaByRoot.values()) aRenumberMarks(a);
	}

	/**
	 * THE CHECKER WINDOW (W3): the one seam feeding the test-side referee —
	 * tests/arena-checker.ts, which owns the armed divergence check
	 * (arena-served values ≡ fold-truth) and the structural validator. The
	 * views are readonly-shaped: live state getters plus bracket methods
	 * that keep every mutation's save/restore discipline inside the engine.
	 * Production code never calls this and installs no hook. @internal
	 */
	__checkerInternals(): ArenaCheckerInternals {
		const self = this;
		return {
			layout: {
				A_SHIFT,
				AF: { NODE: AF.NODE, FLAGS: AF.FLAGS, DEPS: AF.DEPS, SUBS: AF.SUBS, L_DEP: AF.L_DEP, L_SUB: AF.L_SUB, L_PREV_DEP: AF.L_PREV_DEP, L_NEXT_DEP: AF.L_NEXT_DEP, L_NEXT_SUB: AF.L_NEXT_SUB, L_MODE: AF.L_MODE },
				AFlag: { DIRTY: AFlag.DIRTY, BOX_SUSPENDED: AFlag.BOX_SUSPENDED },
			},
			get evalDepth(): number {
				return self.evalDepth;
			},
			get inFoldCallback(): boolean {
				return self.inFoldCallback;
			},
			eachArena: (fn) => this.eachArena(fn),
			nodeAt: (id) => this.nodesArr[id],
			serve: (a, node) => this.aServe(a, node),
			foldTruthFrame: (world, fn) => this.foldTruthFrame(world, fn),
			cycleError: (name) => this.cycleError(name),
			inCallback: (fn) => this.inCallback(fn),
			holdOp: (fn) => {
				this.opDepth++;
				try {
					return fn();
				} finally {
					this.opDepth--;
				}
			},
			armEpilogueCheck: (check) => {
				this.epilogueCheck = check;
			},
		};
	}

	/** Test seam: the root's committed arena shell, if materialized — the
	 * S-D pool/wrap pins read shell state (claimGen, buffer identity,
	 * column capacities) and force the clocks toward the Int32 ceiling.
	 * @internal */
	__arenaForTest(rootId: RootId): ShadowArena | undefined {
		return this.arenaByRoot.get(rootId);
	}

	/** Test seam: pooled arena shells (S-D pool reuse/cap pins). @internal */
	__arenaPoolForTest(): ShadowArena[] {
		return this.arenaPool;
	}

	/** Test seam: force an id-tenancy generation bump (§4.5.3 GEN pin). @internal */
	__bumpNodeGenForTest(id: NodeId): void {
		this.nodeGen[id] = (this.nodeGen[id] ?? 0) + 1;
	}

	/** Arena stats (tests/bench). @internal */
	__arenaStats(): { committed: number; pass: number; pooled: number; suspended: number; pendingSettlements: number; dirty: number } {
		let pass = 0;
		let dirty = 0;
		for (const p of this.openPassByRoot.values()) {
			if (p.arena !== undefined) pass++;
		}
		this.eachArena((a) => {
			dirty += a.dirty.length;
		});
		return { committed: this.arenaByRoot.size, pass, pooled: this.arenaPool.length, suspended: this.suspendedCount, pendingSettlements: this.pendingSettle.length, dirty };
	}

	/** Test seam: a committed arena's (dep → sub) link mode, or undefined
	 * when no link exists (§4.4.1 mode-transition pin). @internal */
	__arenaLinkMode(rootId: RootId, dep: AnyNode, sub: AnyNode): 'strong' | 'weak' | undefined {
		const a = this.arenaByRoot.get(rootId);
		if (a === undefined) return undefined;
		const depSh = a.byNode[dep.id] ?? 0;
		const subSh = a.byNode[sub.id] ?? 0;
		if (depSh === 0 || subSh === 0) return undefined;
		let cur = a.W[subSh + AF.DEPS]!;
		while (cur !== 0) {
			if (a.W[cur + AF.L_DEP] === depSh) return (a.W[cur + AF.L_MODE]! & 1) !== 0 ? 'weak' : 'strong';
			cur = a.W[cur + AF.L_NEXT_DEP]!;
		}
		return undefined;
	}

	/** Test seam: a committed arena's live (dep → sub) link record id, or 0
	 * when no link exists (freelist-discipline pins capture ids before a
	 * teardown). @internal */
	__arenaLinkIdForTest(rootId: RootId, dep: AnyNode, sub: AnyNode): number {
		const a = this.arenaByRoot.get(rootId);
		if (a === undefined) return 0;
		const depSh = a.byNode[dep.id] ?? 0;
		const subSh = a.byNode[sub.id] ?? 0;
		if (depSh === 0 || subSh === 0) return 0;
		let cur = a.W[subSh + AF.DEPS]!;
		while (cur !== 0) {
			if (a.W[cur + AF.L_DEP] === depSh) return cur;
			cur = a.W[cur + AF.L_NEXT_DEP]!;
		}
		return 0;
	}

	/** Test seam: raw L_NEXT_DEP field of an arena link record BY ID — valid
	 * on freed links too. The freelist-discipline regression pin (dalien row
	 * 2 twin) asserts a freed link's stale nextDep still names its former
	 * neighbor, never the free list: aCheckDirty reads L_NEXT_DEP off links
	 * a mid-walk purge freed. @internal */
	__arenaLinkNextDepForTest(rootId: RootId, linkId: number): number {
		const a = this.arenaByRoot.get(rootId);
		if (a === undefined) return -1;
		return a.W[linkId + AF.L_NEXT_DEP] ?? -1;
	}

	/**
	 * One fold-truth evaluation frame (the armed checker's naive fn runs —
	 * the evaluator itself lives in tests/arena-checker.ts and reaches this
	 * only through `__checkerInternals`): the serve override becomes
	 * FOLD_TRUTH, so routed atom reads inside `fn` fold plain from their
	 * tapes and no arena-refold route survives into the frame — nothing
	 * routes back into the arena under check; the world is pinned for those
	 * folds' visibility; the fold-through sink and observation capture close
	 * (a checker read must never join a capture); the eval depth bumps
	 * (writes inside the frame throw, as in every world). Everything
	 * restores on the way out, throw or return.
	 */
	private foldTruthFrame<T>(world: World, fn: () => T): T {
		const savedWorld = this.activeWorld;
		const savedRoute = this.serveOverride;
		const savedSink = this.currentSink;
		const savedObsCapture = this.obsCapture;
		this.setWorld(world);
		this.serveOverride = FOLD_TRUTH;
		this.currentSink = 0;
		this.obsCapture = undefined;
		this.evalDepth++;
		try {
			return fn();
		} finally {
			this.evalDepth--;
			this.obsCapture = savedObsCapture;
			this.currentSink = savedSink;
			this.serveOverride = savedRoute;
			this.setWorld(savedWorld);
		}
	}

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
	 * CURRENT strong dep set: since S-C that IS the kernel's dep-link list
	 * (tracked-only by construction, per-last-evaluation) — force one
	 * kernel read so the record has evaluated at least once, then retain
	 * the links it holds. The read runs under kernel `untracked()`: entry
	 * can fire inside an open kernel evaluation frame (a getter epilogue's
	 * dep sync), and the discovery is not a READ by that frame — a link
	 * would corrupt its dep list. A getter that throws keeps its
	 * throw-on-demand behavior; the deps it read before throwing ARE
	 * retained (the kernel keeps the partial link prefix).
	 */
	private obsEnter(id: NodeId): void {
		const node = this.nodesArr[id]!;
		if (node.kind === 'atom') {
			__lifecycleRetain(node.handle._id);
			return;
		}
		try {
			untracked(() => __kernelComputedRead(node.handle));
		} catch {
			// partial dep prefix retained below
		}
		this.obsSyncDeps(id, this.kernelStrongDepsOf(node));
	}

	/** The last observed consumer left: release the whole retained closure.
	 * obsDeps clears BEFORE the child shifts so a degenerate cyclic dep
	 * record (possible only via throwing getters) cannot re-release. (The
	 * node's kernel record keeps its links and cache: HOST_OWNED records
	 * never feed the D1 lifecycle union, and stripping them would force an
	 * untracked re-sample at the next read — an eager refresh the ruling
	 * forbids [2026-07-06].) */
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
	 * transitively). Retain-new before release-old; same-tick flaps coalesce
	 * in the kernel's microtask flush. (The snapshot's routing coverage
	 * needs no counts since S-B: the capture's committed evaluations
	 * populate the root's arena, whose marks the re-checks validate
	 * through — §4.0's subDepRefs dissolution.)
	 */
	private syncSubObs(e: Subscription): void {
		const prev = e.obsDeps;
		const next = new Set<NodeId>();
		for (let i = 0; i < e.deps.length; i++) next.add(e.deps[i]!.node.id);
		e.obsDeps = next;
		for (const dep of next) {
			if (prev === undefined || !prev.delete(dep)) this.obsShift(dep, 1);
		}
		if (prev !== undefined) {
			for (const dep of prev) this.obsShift(dep, -1);
		}
	}

	// ---- the routing walks (S-B: arenas route; §4.4.3/§4.4.6/§4.4.7) ----

	/** Reused routing-walk buffers (walks are never re-entrant; the stack
	 * holds arena shadow RECORD ids during arena walks). */
	private walkStack: NodeId[] = [];
	private walkWatchers: Watcher[] = [];

	/** Collect the live watchers subscribed on one node (delivery walk). */
	private collectWatchersAt(nid: NodeId, found: Watcher[]): void {
		const ws = this.watchersByNode[nid];
		if (ws !== undefined) {
			for (let i = 0; i < ws.length; i++) {
				const w = ws[i]!;
				if (w.live) found.push(w);
			}
		}
	}

	/**
	 * The value-blind delivery walk (§4.4.3): reachability from the written
	 * atom over EVERY live arena's STRONG links — pass arenas included; the
	 * walk visits structure, never values or marks, so the §4.3 pin
	 * invariant is untouched. The weak bit is tested and weak links are
	 * never traversed (untracked reads never notify — §4.4.1; the bit test
	 * is the cost the untracked-fan gate prices). Kernel (K0) subscribers
	 * are served by the eager kernel apply, not this walk. Value-blind: a
	 * delivery announces "a write in this batch may affect you", never a
	 * value — the receiving render folds its own world. Collected watchers
	 * dedup globally per node (lastWalk) across arenas and deliver in id
	 * order (the reference model's map order). Deliveries may be FEWER than
	 * the model's union-conservative set, never more (the ⊆ bound): a cone
	 * held by no live arena lane-degrades to a drain correction (§4.4.5,
	 * S-NF2-D1).
	 */
	private deliveryWalk(from: NodeId, token: Token, slot: SlotMeta, seq: Seq): void {
		const gen = ++this.walkGen;
		const found = this.walkWatchers;
		found.length = 0;
		this.lastWalk[from] = gen;
		this.collectWatchersAt(from, found);
		for (const a of this.arenaByRoot.values()) this.walkArenaStrong(a, from, gen, found);
		for (const p of this.openPassByRoot.values()) {
			if (p.arena !== undefined) this.walkArenaStrong(p.arena, from, gen, found);
		}
		if (found.length > 1) found.sort((a, b) => a.id - b.id);
		for (let i = 0; i < found.length; i++) this.deliver(found[i]!, token, slot, seq);
		found.length = 0;
	}

	/** One arena's half of the delivery walk: DFS over the STRONG subs lists
	 * (the segregated weak lists are never visited — the untracked-fan
	 * gate's prize) with per-arena shadow stamps for traversal termination
	 * and the global per-node stamps for collection dedup. Dead-GEN residue
	 * never routes (§4.5.3). Never allocates or folds: a.W/a.walk stable. */
	private walkArenaStrong(a: ShadowArena, from: NodeId, gen: WalkGen, found: Watcher[]): void {
		const start = from < a.byNode.length ? a.byNode[from]! : 0;
		if (start === 0) return;
		if (a.W[start + AF.GEN] !== this.nodeGen[from]!) return;
		const W = a.W;
		const walk = a.walk;
		const lastWalk = this.lastWalk;
		const stack = this.walkStack;
		let sp = 0;
		walk[start >> A_SHIFT] = gen;
		stack[sp++] = start;
		while (sp > 0) {
			const sh = stack[--sp]!;
			let l = W[sh + AF.SUBS]!;
			while (l !== 0) {
				const sub = W[l + AF.L_SUB]!;
				if (walk[sub >> A_SHIFT] !== gen) {
					walk[sub >> A_SHIFT] = gen;
					stack[sp++] = sub;
					const nid = W[sub + AF.NODE]!;
					if (lastWalk[nid] !== gen) {
						lastWalk[nid] = gen;
						this.collectWatchersAt(nid, found);
					}
				}
				l = W[l + AF.L_NEXT_SUB]!;
			}
		}
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
		if (!this._registered) throw new BridgeScheduleError('batches require a registered bridge — register the React bridge first');
		if (this.liveTokenCount >= SLOT_COUNT) {
			throw new BridgeScheduleError('at most 31 batch tokens may be live at once (one per React lane)');
		}
		const parked = opts?.action ?? false;
		probes.tokens++; // One Core probe (referee surface)
		const token: Token = {
			id: this.nextToken++,
			action: opts?.action ?? false,
			parked, // async-action tokens park (cannot retire) until their promise settles
			state: 'live', slot: undefined,
			retiredSeq: undefined, lastWriteSeq: 0, atomsTouched: [], liveReceipts: 0,
			ambient: opts?.ambient ?? false,
		};
		this.tokens.set(token.id, token);
		this.liveTokenCount++;
		this.recomputeQuiet(); // a live batch: the pipeline is armed until the last retirement
		const tr = this.trace;
		if (tr !== undefined) tr.batchOpen(token);
		return token;
	}

	/** Look up an id or throw the schedule error every resolver shares. */
	private mustGet<K, V>(map: Map<K, V>, id: K, what: string): V {
		const v = map.get(id);
		if (v === undefined) throw new BridgeScheduleError(`unknown ${what} ${id}`);
		return v;
	}

	private token(id: TokenId): Token {
		return this.mustGet(this.tokens, id, 'token');
	}

	nodeById(id: NodeId): AnyNode {
		return this.mustGet(this.nodes, id, 'node');
	}

	/**
	 * Intern the token's slot, claiming a free one on its first write.
	 * Claim housekeeping: the write clock zeroes; per-(watcher, slot) dedup
	 * bits clear (the bit now means a different batch).
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
			const tr = this.trace;
			if (tr !== undefined) tr.slotBackstopReleased(victim.id, victim.tenant!);
			this.releaseSlot(victim);
			free = victim;
		}
		free.tenant = token.id;
		free.claimSeq = this.mintSeq(); // claim-after-release gets its own point on the timeline
		free.writeClock = 0;
		free.releasePending = false;
		token.slot = free.id;
		// A committed-but-slotless token (late first write — e.g. a member
		// write landing after a root committed the token) interns here — its
		// root's membership bits gain the slot NOW so the committed world's
		// membership clause sees the coming receipts.
		for (const r of this.roots.values()) {
			if (r.committedTokens.has(token.id)) r.committedBits |= 1 << free.id;
		}
		{
			const clear = ~(1 << free.id);
			for (const w of this.watchers.values()) w.dedupBits &= clear; // dedup clear at re-intern
		}
		{
			const tr = this.trace;
			if (tr !== undefined) tr.slotClaimed(free.id, token.id);
		}
		return free;
	}

	private releaseSlot(slot: SlotMeta): void {
		const tenant = slot.tenant === undefined ? undefined : this.token(slot.tenant);
		if (tenant !== undefined) {
			tenant.slot = undefined; // identity release; receipts keep their denormalized slot
			const tr = this.trace;
			if (tr !== undefined) tr.slotReleased(slot.id, tenant.id);
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
	 * Clock coherence: the fold mints one sequence and stamps it into the
	 * atom's baseSeq (compaction + the referee's model view read it) and the
	 * committed-advance clock (cas), so baseline/fast-out checks see the fold. Observers: no
	 * walk machinery is armed, so the small live-observer population is
	 * reconciled value-gated, exactly like a durable drain (corrections for
	 * watchers, re-runs for committed React effects; core effect()s are
	 * kernel subscribers — the direct kernel apply itself flushes them).
	 * No receipt, no token, no tape append, no delivery walk. Observation:
	 * when a tracer is attached the accepted fold mints ONE quiet-write
	 * record — with no tracer that is one dead branch, and observation never
	 * changes which write path executes (equality drops stay silent: there
	 * is no token to attribute a drop to). @internal
	 */
	__quietWrite(node: AtomNode, kind: OpKind, payload: unknown): void {
		if (this.evalDepth > 0) throw new BridgeScheduleError('signal write during a world evaluation / render — write from an event handler or effect instead');
		if (this.inFoldCallback) throw new BridgeScheduleError('signal write inside an updater/reducer fold — updaters and reducers must be pure');
		const prev = node.base;
		// Fast arm — bench-pinned, do not fold into the eqAtom general arm
		// (spkw-quiet A/B, 2026-07: folding cost +37% on the bare quiet fold,
		// 12.9 → 17.7 ns): equality drops on one bare Object.is — no
		// applyOp/eqAtom call layer on the dominant write shape.
		let next: Value;
		if (kind === OpKind.SET && node.eqIsDefault) {
			if (Object.is(payload, prev)) {
				return; // equality drop against base — the tape is empty by the quiet invariant
			}
			next = payload;
		} else {
			next = kind === OpKind.SET ? payload : this.applyOp(node, kind, payload, prev);
			if (this.eqAtom(node, next, prev)) {
				return; // equality drop against base — the tape is empty by the quiet invariant
			}
		}
		node.base = next;
		node.baseSeq = this.cas = ++this.seq; // advance the base + committed-advance clocks together (mintSeq, inlined)
		const tr = this.trace;
		if (tr !== undefined) tr.quietWrite(node, node.baseSeq);
		// Direct kernel apply: the plain write tail, no public-method re-entry
		// (the host seam already ran — policy checked, op folded).
		__hostApplySet(node.handle, next);
		// NF2 S-A flip site (d): quiet fold — after the base/cas advance,
		// before quietDrain and the sub scan (§4.1.2; the arenaByRoot.size
		// check is the one scalar branch PR1's ledger documents).
		this.fanAtomsToCommittedArenas(this.oneAtomBuf(node));
		if (this.watchers.size !== 0) this.quietDrain();
		// A quiet fold moves committed truth for every root — an EF2 boundary
		// (quiet ⇔ no open passes, so no frame can defer the re-check).
		if (this.committedSubCount !== 0) this.revalidateCommittedSubs(undefined);
		for (const a of this.arenaByRoot.values()) this.arenaDecay(a); // NF2 S-A boundary decay
		if (this.notifyN !== 0) this.flushNotify();
		this.arenaOpEpilogue();
	}

	/** Value-gated watcher reconciliation for a quiet fold: committed truth
	 * moved for every root, and no slot/walk state exists to scope candidates,
	 * so every live watcher re-checks directly — the same compare-and-correct
	 * block as drainCommittedObservers. (Committed subscriptions re-check via
	 * revalidateCommittedSubs at the same boundary.) */
	private quietDrain(): void {
		for (const w of this.watchers.values()) {
			if (!w.live) continue;
			const wNode = this.nodeById(w.node);
			this.correctWatcher(w, wNode, this.evaluate(wNode, { kind: 'committed', root: w.root }), 'quiet');
		}
	}

	/** A write belongs to the batch context it executes in; a bare write has
	 * none, so it joins the ambient default batch — unless the bridge is
	 * QUIET, in which case the write folds directly (no ambient batch is
	 * minted while nothing is pending). */
	bareWrite(node: AtomNode, kind: OpKind, payload: unknown): void {
		if (this.quiet) {
			this.__quietWrite(node, kind, payload);
			return;
		}
		let ambient = this.ambientToken === undefined ? undefined : this.tokens.get(this.ambientToken);
		if (ambient === undefined || ambient.state !== 'live') {
			ambient = this.openBatch({ ambient: true });
			this.ambientToken = ambient.id;
		}
		// The post-await dev-warning heuristic lives adapter-side only
		// (cosignal-react's shim classifyWrite) — the engine stays lint-free.
		this.write(ambient.id, node, kind, payload);
	}

	/** The compound-operation tail every public exit owes, in order: the
	 * trace's opEnd mark (scopes causality), then the queued-notification
	 * flush. One copy — an exit that forgets either desyncs trace causality
	 * or strands queued notifies, so every exit calls this instead. */
	private endOp(): void {
		const tr = this.trace;
		if (tr !== undefined) tr.opEnd();
		this.flushNotify();
	}

	/**
	 * The write path (registered bridges only — an unregistered bridge
	 * throws: production writes reach a bridge only through the kernel write
	 * hook, which arms at registration, so anything earlier is plain kernel
	 * state that never involves a bridge; see adoptAtom for how such state
	 * joins). Logged steps, in order: classify (caller) → drop check
	 * → intern slot → append packed receipt + write clock → member-slot
	 * fanout → apply to the kernel with stepwise equality → arena delivery
	 * walk → newest-subscription flush after the walk returns.
	 */
	write(tokenId: TokenId | undefined, node: AtomNode, kind: OpKind, payload: unknown): void {
		if (this.evalDepth > 0) throw new BridgeScheduleError('signal write during a world evaluation / render — write from an event handler or effect instead');
		if (this.inFoldCallback) throw new BridgeScheduleError('signal write inside an updater/reducer fold — updaters and reducers must be pure');
		if (node.kind !== 'atom') throw new BridgeScheduleError('writes target atoms');
		// NF2 S-A: public-operation frame — settlements landing anywhere
		// inside (walks, effect bodies, notify callbacks) enqueue and the
		// epilogue drains to empty (§4.5.4's fixed point).
		this.opDepth++;
		try {
			this.writeInner(tokenId, node, kind, payload);
		} finally {
			this.opDepth--;
		}
		this.arenaOpEpilogue();
	}

	private writeInner(tokenId: TokenId | undefined, node: AtomNode, kind: OpKind, payload: unknown): void {
		if (!this._registered) throw new BridgeScheduleError('writes require a registered bridge — before registration, writes are plain kernel state and never reach a bridge');
		if (tokenId === undefined) {
			this.bareWrite(node, kind, payload);
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
			if (kind === OpKind.SET && node.eqIsDefault) {
				// Fast arm — bench-pinned, do not fold into the general arm
				// (spkw A/B, 2026-07: folding the two write-path fast arms
				// into their eqAtom general arms cost +11% bare / +3-6%
				// chain3+watch1 per logged write). A plain set with default
				// equality drops on one bare Object.is — no applyOp/eqAtom
				// call layer on the dominant write shape.
				if (Object.is(payload, node.base)) {
					const tr = this.trace;
					if (tr !== undefined) tr.writeDropped(node, tokenId);
					this.endOp();
					return;
				}
			} else {
				const evaluated = this.applyOp(node, kind, payload, node.base);
				if (this.eqAtom(node, evaluated, node.base)) {
					const tr = this.trace;
					if (tr !== undefined) tr.writeDropped(node, tokenId);
					this.endOp();
					return;
				}
			}
		}

		// Intern slot, append receipt, bump the slot write clock.
		const slot = token.slot !== undefined ? this.slots[token.slot]! : this.internSlot(token);
		const seq = this.mintSeq();
		tp.push(kind, slot.id, seq, token.id, payload);
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
				if ((r.committedBits & bit0) !== 0) {
					r.committedDirtySlots |= bit0;
					// NF2 S-A flip site (c): committed-member write — fan the ONE
					// written atom into the member root's arena. Marks only; the
					// effect scan stays at the next boundary (EF2 as amended, §4.0).
					const ra = this.arenaByRoot.get(r.id);
					if (ra !== undefined) this.fanAtomsToArena(ra, this.oneAtomBuf(node), false);
				}
			}
		}
		{
			// ONE write record: the receipt hook carries node/op/token/slot/seq
			// (the old object channel's separate 'write' event was the same
			// instant with less information — sites report once now).
			const tr = this.trace;
			if (tr !== undefined) tr.receipt(node, tp.entryAt(tp.n - 1));
		}

		// Apply to the kernel eagerly with stepwise equality, so the newest
		// world stays directly readable off the kernel arena.
		if (kind === OpKind.SET && node.eqIsDefault) {
			// Fast arm — bench-pinned, do not fold into the general arm
			// (spkw A/B, 2026-07: folding the two write-path fast arms
			// into their eqAtom general arms cost +11% bare / +3-6%
			// chain3+watch1 per logged write). A plain set with default
			// equality applies unconditionally: the kernel's own
			// store-compare gates propagation, which beats paying
			// kernelValueOf + Object.is up front on every EFFECTIVE write.
			this.applyToKernel(node, payload);
		} else {
			const prevNewest = this.kernelValueOf(node.handle);
			const nextNewest = this.applyOp(node, kind, payload, prevNewest);
			if (!this.eqAtom(node, nextNewest, prevNewest)) {
				this.applyToKernel(node, nextNewest);
			}
		}

		// The value-blind delivery walk (arena strong links), synchronously in
		// the writer's stack. (Core effect()s are kernel subscribers: the
		// eager kernel apply above already flushed them.)
		this.deliveryWalk(node.id, token, slot, seq);
		this.endOp();
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
		const tr = this.trace; // one load covers this call's (at most two) record sites
		const bit = 1 << slot.id;
		if ((w.dedupBits & bit) === 0) {
			w.dedupBits |= bit;
			if (tr !== undefined) tr.delivery(w, token.id, slot.id, seq, false);
			if (this.onDelivery !== undefined) this.queueNotify(0, w, token, slot.id);
			return;
		}
		// Bit set: suppress iff NO started-and-uncommitted pass on the
		// watcher's root includes this slot (render mask) with pin < the
		// write's sequence — such a pass froze BEFORE this write, so it would
		// fold without it and a fresh delivery is still required.
		// One open pass per root ⇒ one registry load + two compares.
		const p = this.openPassByRoot.get(w.root);
		if (p !== undefined && ((p.maskBits >>> slot.id) & 1) === 1 && p.pin < seq) {
			if (tr !== undefined) tr.delivery(w, token.id, slot.id, seq, true);
			if (this.onDelivery !== undefined) this.queueNotify(0, w, token, slot.id);
		} else {
			if (tr !== undefined) tr.suppressed(w, token.id, slot.id, seq);
		}
	}

	/**
	 * Referee seam for core `effect()` runs. Core effects are REAL kernel
	 * effects (tests/helpers.ts `mountEngineCoreEffect` over the public
	 * `effect()`), flushed by the eager kernel apply itself — the bridge
	 * holds no record of them. Their wrappers report each value-gated run
	 * here so core-effect-run records land in the one packed stream with
	 * its causality register. Sibling firing order under one operation is
	 * implementation-defined (kernel subscriber-link order — owner ruling
	 * 2026-07-06); values and the operation each run fires at are the
	 * contract (RCC-EF4).
	 */
	logCoreEffectRun(name: string, value: Value): void {
		const tr = this.trace;
		if (tr !== undefined) tr.coreEffectRun(name, value);
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
		let maskBits = 0;
		for (const id of includeTokens) {
			const t = this.token(id);
			if (t.state !== 'live') throw new BridgeScheduleError('mask captures live tokens only — a retired batch is already permanent history');
			maskTokens.add(id);
			// A live token with no slot never wrote; if it writes later, those
			// receipts postdate this pass's pin and the visibility rule's
			// included-up-to-pin clause excludes them anyway.
			if (t.slot !== undefined) maskBits |= 1 << t.slot;
		}
		// The committed-set capture materializes the root record (reference-model
		// parity: the model's committedSlotsNow() creates it on first consult).
		const includedBits = maskBits | this.root(rootId).committedBits;
		const pass: Pass = {
			id: this.nextPass++, root: rootId, pin: this.seq,
			maskTokens, maskBits, includedBits,
			state: 'open', endKind: undefined, mounted: [], rendered: new Set(),
		};
		// NF2: claim the pass world's arena from the pool (§4.1) — the pass
		// world's value+invalidation+routing layer.
		pass.arena = this.claimArena('pass', { kind: 'pass', pass }, rootId);
		this.passes.set(pass.id, pass);
		this.openPassByRoot.set(rootId, pass);
		this.recomputeQuiet(); // an open render pass: the pipeline is armed until it closes
		const tr = this.trace;
		if (tr !== undefined) {
			tr.passStart(pass);
			tr.opEnd();
		}
		return pass;
	}

	private pass(id: PassId): Pass {
		return this.mustGet(this.passes, id, 'pass');
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
			maskBits: p.maskBits, includedBits: p.includedBits,
			rootCommitGen: this.root(p.root).commitGen,
		});
		this.watchers.set(watcher.id, watcher);
		let byNode = this.watchersByNode[node.id];
		if (byNode === undefined) {
			byNode = [];
			this.watchersByNode[node.id] = byNode;
		}
		byNode.push(watcher);
		p.mounted.push(watcher.id); // mounts never join `rendered` (the collections are disjoint)
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
		const w = this.mustGet(this.watchers, watcherId, 'watcher');
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
	 * per-node index the routing walks read (delivery collection, drain
	 * candidate collection, arena mark decay) — and this is the one public
	 * operation that retires a watcher from BOTH, plus any open pass's
	 * mounted list (a dead watcher must not be revived by a later commit's
	 * layout loop). Deleting from the public map alone strands the per-node
	 * entry (pinned by tests/graph-consumers.spec.ts). The liveness setter
	 * inside releases the observation-union retain.
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
			id: this.nextEffect++, name, root: rootId,
			deps: [], refire, body: undefined, lastValue: undefined,
			runs: 0, cleanups: 0, live: true, obsDeps: undefined,
		};
		this.root(rootId);
		this.subs.set(e.id, e);
		this.committedSubCount++;
		return e;
	}

	// (The referee convenience constructors mountReactEffect /
	// mountReactEffectPick — 4-line compositions of mountCommittedObserver +
	// a `body` + captureRun — live test-side now: tests/helpers.ts. The
	// `body` mechanism itself stays here: it is the inline-run + event-mint
	// path the lockstep referee compares.)

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
		if (e === undefined) throw new BridgeScheduleError(`unknown committed subscription ${id}`);
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

	/** A routed read inside an open capture frame (bridge-node form: referee
	 * bodies land here; raw kernel atom AND computed reads route through the
	 * host read seams instead, which push the same dep-snapshot entries). */
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
		const e = this.mustGet(this.subs, id, 'subscription');
		e.live = false;
		this.subs.delete(id);
		this.committedSubCount--;
		e.cleanups++;
		const tr = this.trace;
		if (tr !== undefined) tr.reactEffectCleanup(e.name, e.root);
		// Release the snapshot's observation retains.
		const held = e.obsDeps;
		if (held !== undefined) {
			e.obsDeps = undefined;
			for (const dep of held) this.obsShift(dep, -1);
		}
	}

	/** Referee surface — StrictMode-style replay: cleanup + unconditional
	 * re-run + recapture. Illegal while the subscription's root has an open
	 * pass frame (React double-invokes effects post-commit, never mid-render). */
	replayReactEffect(id: EffectId): void {
		const e = this.subs.get(id);
		if (e === undefined) throw new BridgeScheduleError(`unknown react effect ${id}`);
		if (this.openPassByRoot.has(e.root)) {
			throw new BridgeScheduleError('replay requires the effect root to have no open pass frame');
		}
		this.runCommittedSub(e);
		this.flushNotify();
	}

	/** The referee re-fire: cleanup + body re-run through the REAL capture
	 * frame + records (adapter-registered subscriptions instead queue their
	 * refire to the operation boundary — the adapter owns the body run). */
	private runCommittedSub(e: Subscription): void {
		if (e.refire !== undefined) {
			this.queueNotify(3, undefined, undefined, 0, e);
			return;
		}
		e.cleanups++;
		const tr = this.trace;
		if (tr !== undefined) tr.reactEffectCleanup(e.name, e.root);
		if (e.body !== undefined) this.captureRun(e.id, e.body);
		e.runs++;
		// The dep-values array is the ONE per-record payload a site allocates,
		// and only under the guard: the lockstep referee compares it entry by
		// entry, so the record must carry the real snapshot.
		if (tr !== undefined) tr.reactEffectRun(e.name, e.root, e.lastValue, e.deps.map((d) => d.value));
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
	private revalidateCommittedSubs(rootFilter: RootId | undefined): void {
		if (this.committedSubCount === 0) return;
		for (const e of [...this.subs.values()]) {
			if (!e.live) continue;
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
				if (this.changedValue(d.node, d.value, now)) {
					changed = true;
					break;
				}
			}
			if (changed) this.runCommittedSub(e);
		}
	}

	/**
	 * Per-root commit lock-in — THE single owner of a root's committed-state
	 * transition (W11). For each named token that is still live and not yet a
	 * committed member of this root, one unit moves TOGETHER: the committed-
	 * token set, its bit-mask twin (`committedBits` — what the committed-world
	 * visibility check reads), the root's commit generation, the committed-
	 * advance clock, this root's arena fan-out of the token's touched atoms,
	 * and the durable watcher drain. Already-committed, retired/reclaimed, and
	 * unknown tokens skip: the protocol's per-root commit report is a delta,
	 * and re-reporting a batch is defined as an idempotent set-add.
	 *
	 * Callers: passEnd's lock-in sweep (already inside its own operation
	 * frame, via the inner form) and the bindings' root-commit report handler
	 * (this public form — the report can name a live batch the pass-end sweep
	 * missed). Returns whether any token was newly locked in.
	 */
	commitTokens(rootId: RootId, tokens: Iterable<TokenId>): boolean {
		let changed = false;
		this.opDepth++; // NF2 S-A: public-operation frame (see write)
		try {
			changed = this.commitTokensInner(rootId, tokens);
			// EF2 boundary: a per-root commit is a boundary operation. When this
			// call moved committed truth, re-check the root's committed
			// subscriptions at the boundary value (passEnd's sweep gets the same
			// re-check from passEnd's own boundary; here the call IS the
			// boundary). A no-op call re-checks nothing — the report's common
			// case re-names tokens the sweep already locked in.
			if (changed) this.revalidateCommittedSubs(rootId);
			this.endOp();
		} finally {
			this.opDepth--;
		}
		this.arenaOpEpilogue();
		return changed;
	}

	private commitTokensInner(rootId: RootId, tokens: Iterable<TokenId>): boolean {
		const root = this.root(rootId);
		const tr = this.trace;
		let changed = false;
		for (const tid of tokens) {
			const t = this.tokens.get(tid);
			if (t === undefined || t.state !== 'live') continue; // retired (or reclaimed): the retired clause subsumes membership
			if (root.committedTokens.has(t.id)) continue; // idempotent set-add: already a member
			root.committedTokens.add(t.id);
			if (t.slot !== undefined) root.committedBits |= 1 << t.slot;
			root.commitGen++;
			this.cas = this.mintSeq(); // committed-advance: every per-root commit bumps it
			// NF2 S-A flip site (b): per-root lock-in — inside the per-token
			// loop (m4: commits lock in SETS of tokens), immediately after the
			// membership/gen/cas mutation and before this token's drain, fan
			// THAT token's touched atoms into THIS root's arena.
			{
				const ra = this.arenaByRoot.get(rootId);
				if (ra !== undefined) this.fanAtomsToArena(ra, t.atomsTouched, false);
			}
			if (tr !== undefined) tr.perRootCommit(rootId, t.id, root.commitGen);
			// Durable drain, gated exactly as before: an advanced slot or
			// member-slot write drift (or restaled leftovers) means the root's
			// committed truth moved — candidates come from the arena's dirty
			// list, which site-(b)/(c) fanout just fed.
			const bits = (t.slot !== undefined ? 1 << t.slot : 0) | root.committedDirtySlots;
			root.committedDirtySlots = 0;
			const re = this.restaled.get(rootId);
			if (bits !== 0 || (re !== undefined && re.size > 0)) this.drainCommittedObservers(rootId, 'per-root-commit');
			changed = true;
		}
		return changed;
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
		this.opDepth++; // NF2 S-A: public-operation frame (see write)
		try {
			this.passEndInner(id, kind, opts);
		} finally {
			this.opDepth--;
		}
		this.arenaOpEpilogue();
	}

	private passEndInner(id: PassId, kind: 'commit' | 'discard', opts?: { retireAtCommit?: TokenId[] }): void {
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
		// One load covers this operation's record sites: the disposition
		// record here fires BEFORE the end's consequences (retirement folds,
		// per-root commits, drains, fixups) so consequences can cite it as
		// cause; the passCommitted/passDiscarded referee markers below fire
		// AFTER them (the reference model's stream position).
		const tr = this.trace;
		if (tr !== undefined) tr.passEnd(p, kind);
		if (kind === 'discard') {
			for (const wid of p.mounted) this.dropWatcher(wid); // never subscribed; the tree died
			if (tr !== undefined) tr.passDiscarded(p);
			this.reevaluateDeferredReleases();
			this.reclaimAfterPassEnd(p);
			this.recomputeQuiet(); // pass closed (and its pin unblocked compaction): quiet may re-arm
			// EF2: the frame close is the deferred flush point for boundaries
			// that occurred while this root's frame was open (the discard
			// itself advances nothing; committed truth may already have moved).
			this.revalidateCommittedSubs(p.root);
			this.endOp();
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
			if (w === undefined) continue; // removed mid-pass
			w.lastRenderedValue = this.evaluate(this.nodeById(w.node), { kind: 'pass', pass: p });
			w.snapshot = {
				passId: p.id, pin: p.pin, maskBits: p.maskBits,
				includedBits: p.includedBits, rootCommitGen: this.root(p.root).commitGen,
			};
		}
		// (2) retirement folds due at this commit; then the per-root commit
		// (lock-in) of every still-live mask token: this root now shows those
		// batches' writes, so its committed world must include them. The
		// lock-in — including step (3), each newly committed token's durable
		// drain — is commitTokensInner, THE single owner of the transition
		// (W11); the bindings' root-commit report handler is its other caller.
		for (const tid of opts?.retireAtCommit ?? []) this.retireInternal(this.token(tid));
		this.commitTokensInner(p.root, p.maskTokens);
		// (4) layout: subscribe, then mount fixup (matching React's layout-
		// effect phase: after commit, before paint).
		for (const wid of p.mounted) {
			const w = this.watchers.get(wid);
			if (w === undefined) continue;
			w.live = true;
			this.mountFixup(w, p, baseline, maskTokenRecords);
		}
		// The §4.4.2 populator domain — the EXPLICIT union of this pass's
		// re-renders and its OWN mounts (`rendered` and `mounted` are
		// disjoint). Adopted reveals stay out: their snapshot rides the
		// original hidden pass (`snapshot.passId !== p.id` — the same
		// same-pass conjunct the mount fixup's fast path tests), and their
		// population keeps its pre-existing timing (a later committed
		// evaluation), not the adopting commit's.
		const populated: WatcherId[] = [...p.rendered];
		for (const wid of p.mounted) {
			const w = this.watchers.get(wid);
			if (w !== undefined && w.snapshot.passId === p.id) populated.push(wid);
		}
		// Re-staled detection: a re-rendered watcher whose committed value
		// moved past its pin is stale again the moment its commit reset
		// lastRenderedValue; the NEXT durable drain reconciles it (the
		// reference model's full scan does the same, one drain later than
		// the flip). This loop is DECLARED LOAD-BEARING FOR ROUTING (§4.4.2,
		// M1): its committed evaluations populate the root's arena with the
		// full committed dep cone (strong + weak) of every watcher this pass
		// re-rendered or mounted, before passEnd returns — i.e., before any
		// post-commit write needs routing. (For a freshly mounted watcher the
		// value check is provably a no-op — mountFixup just reconciled it —
		// but the evaluation is its cone's one populator: the fixup's
		// fast-out path never evaluates, and mountFix folds are arena-free.)
		for (const wid of populated) {
			const w = this.watchers.get(wid);
			if (w === undefined || !w.live) continue;
			const wNode = this.nodeById(w.node);
			const committedNow = this.evaluate(wNode, { kind: 'committed', root: p.root });
			if (this.changedValue(wNode, w.lastRenderedValue, committedNow)) this.markRestaled(w);
		}
		// §4.4.2's population dev assert: after a commit of pass P, every
		// live watcher P re-rendered or mounted has a shadow for its node in
		// the root's committed arena (the populator above ran; a miss here
		// means a future re-ordering broke the routing coverage argument).
		{
			const ra = this.arenaByRoot.get(p.root);
			for (const wid of populated) {
				const w = this.watchers.get(wid);
				if (w === undefined || !w.live) continue;
				if (ra === undefined || (w.node < ra.byNode.length ? ra.byNode[w.node]! : 0) === 0) {
					throw new BridgeInvariantViolation(`population rule (§4.4.2): watcher ${w.name} has no shadow in root ${p.root}'s committed arena after commit`);
				}
			}
		}
		if (tr !== undefined) tr.passCommitted(p);
		// ctx.previous cells hold the last COMMITTED value — a pending
		// render's value must never leak into the hint, because a pending
		// transition may still be discarded — so update them from every
		// watcher this commit re-rendered or mounted: the explicit union of
		// the two disjoint collections, each watcher visited once (S-C: the
		// cells moved from the shim onto the bridge computed nodes with the
		// ctx adapter).
		for (const wid of [...p.rendered, ...p.mounted]) {
			const w = this.watchers.get(wid);
			if (w === undefined || w.lastRenderedValue instanceof SuspendedRead) continue;
			const node = this.nodesArr[w.node];
			if (node !== undefined && node.kind === 'computed') node.prevCell.value = w.lastRenderedValue;
		}
		{
			const ra = this.arenaByRoot.get(p.root);
			if (ra !== undefined) this.arenaDecay(ra); // NF2 S-A boundary decay
		}
		this.reevaluateDeferredReleases();
		this.reclaimAfterPassEnd(p);
		this.recomputeQuiet(); // pass closed (and its pin unblocked compaction): quiet may re-arm
		// EF2 boundary: ONE committed-subscription re-check per commit
		// operation, at the boundary value — a pass locking in two tokens
		// re-checks once, not per token (plan amendment 4's dedup rule).
		// Retirements folded into this commit moved committed truth for every
		// root, so the scan widens (each root still open-frame-deferred).
		this.revalidateCommittedSubs((opts?.retireAtCommit ?? []).length > 0 ? undefined : p.root);
		this.endOp();
	}

	/**
	 * Mid-episode reclamation, pass-end site: the ended pass record drops
	 * (its memos and mask mappings die with it — nothing from a dead pass
	 * can validate later), and its mask tokens re-check reclaimability
	 * (the mask retention just lapsed).
	 */
	private reclaimAfterPassEnd(p: Pass): void {
		this.passes.delete(p.id);
		// NF2 S-A: drop the pass arena (commit and discard drop identically;
		// this site already runs AFTER mount fixup and the re-staled loop —
		// m2's ordering — so both saw the arena; touching it later throws).
		if (p.arena !== undefined) {
			this.releaseArena(p.arena);
			p.arena = undefined;
		}
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
	retire(tokenId: TokenId): void {
		const t = this.token(tokenId);
		if (t.state === 'retired') throw new BridgeScheduleError('retirement fires exactly once per token');
		if (t.parked) throw new BridgeScheduleError('parked action tokens retire only at settlement');
		this.opDepth++; // NF2 S-A: public-operation frame (see write)
		try {
			this.retireInternal(t);
			// EF2 boundary: retirement is a guaranteed flush point for every root
			// (a write-free retirement still flushes pending member-write flips).
			this.revalidateCommittedSubs(undefined);
			this.endOp();
		} finally {
			this.opDepth--;
		}
		this.arenaOpEpilogue();
	}

	/** The async action's promise settled; the protocol host then retires the token. */
	settleAction(tokenId: TokenId): void {
		const t = this.token(tokenId);
		if (!t.action) throw new BridgeScheduleError('settle targets an action token');
		if (!t.parked || t.state !== 'live') throw new BridgeScheduleError('action already settled');
		this.opDepth++; // NF2 S-A: public-operation frame (see write)
		try {
			t.parked = false;
			const tr = this.trace;
			if (tr !== undefined) tr.batchSettle(t);
			this.retireInternal(t);
			this.revalidateCommittedSubs(undefined); // EF2 boundary: settlement is a guaranteed flush point
			this.endOp();
		} finally {
			this.opDepth--;
		}
		this.arenaOpEpilogue();
	}

	/**
	 * Retirement — the batch's writes become permanent history visible to
	 * every world. The internal order matters: stamp receipts, fold
	 * (compaction), retirement stamps + committed-advance, durable drains,
	 * clear per-root rows (the retired clause now subsumes membership), and
	 * only then release the slot (deferred if an open pass's render mask
	 * still names it). Retirement is disposition-blind: a batch React
	 * abandoned retires through this same path — whether writes persist
	 * never depends on who was subscribed (the bindings record the
	 * committed/abandoned report diagnostically at its source; see
	 * TraceHooks.batchDisposition).
	 */
	private retireInternal(t: Token): void {
		if (t.state === 'live') {
			this.liveTokenCount--;
		}
		t.state = 'retired';
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
		// NF2 S-A flip site (a): retirement — after stamps + cas + compaction,
		// BEFORE the drain loop (§4.3's ordering joint: mutate → fan → drain),
		// fan the retiring token's touched atoms into EVERY committed arena.
		if (touchedAny) this.fanAtomsToCommittedArenas(t.atomsTouched);
		{
			const tr = this.trace;
			if (tr !== undefined) tr.retired(t.id, retiredSeq);
		}
		// Durable drains, per root, gated exactly as before (flipped slot or
		// member-write drift or restaled leftovers): candidates come from
		// each root arena's dirty list — the site-(a) fanout above marked
		// them, and list entries persist until a drain-then-decay boundary
		// consumes them (never a consumable write-time queue).
		{
			const slotBit = t.slot !== undefined ? 1 << t.slot : 0;
			for (const r of this.roots.values()) {
				const bits = slotBit | r.committedDirtySlots;
				r.committedDirtySlots = 0;
				const re = this.restaled.get(r.id);
				if (bits !== 0 || (re !== undefined && re.size > 0)) this.drainCommittedObservers(r.id, 'retirement');
			}
			// NF2 S-A: boundary mark decay — unconsumed marks on unwatched
			// nodes drop to cold instead of re-appending forever (§4.3).
			for (const a of this.arenaByRoot.values()) this.arenaDecay(a);
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
			const next = this.applyOp(atom, tp.kinds[i]!, tp.payloads[i], atom.base);
			if (!this.eqAtom(atom, next, atom.base)) atom.base = next;
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
	 * commit), §4.4.6: the candidate set is the root arena's DIRTY LIST —
	 * the fanout sites' marks, whose cones the marks' PENDING propagation
	 * already covers — expanded over ALL arena links, strong AND weak
	 * (§4.4.1: drains expand over both; a weak hop's strong dependents
	 * expand past it too, since the walk keeps going), collecting live
	 * same-root watchers on visited nodes, unioned with the `restaled` set.
	 * Reconcile-check each candidate (last rendered value vs
	 * committed-for-root NOW; urgent pre-paint correction on real
	 * difference — comparing values is legal here because both sides are
	 * committed truth, whereas live-write delivery must stay value-blind).
	 * Candidates fire in id order (the reference model's map order). List
	 * entries persist until decay drops them, and consumed marks still seed
	 * conservatively — extras are value-gated no-ops, exactly as the old
	 * slot touched lists were. Committed SUBSCRIPTIONS do not drain here:
	 * their re-check is once per boundary operation
	 * (revalidateCommittedSubs) — RCC-EF2's amended boundary semantics.
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

	/** Collect the live same-root watchers subscribed on one node (drains). */
	private collectRootWatchersAt(nid: NodeId, rootId: RootId, ws: Watcher[]): void {
		const nw = this.watchersByNode[nid];
		if (nw !== undefined) {
			for (let j = 0; j < nw.length; j++) {
				const w = nw[j]!;
				if (w.live && w.root === rootId) ws.push(w);
			}
		}
	}

	/** The ONE urgent pre-paint watcher correction (compare → record → resets →
	 * notify). A correction must move `lastRenderedValue` AND re-arm the dedup
	 * bits AND queue the kind-2 notify together — all four correction sites
	 * (settlement drain, quiet drain, durable drain, mount fixup) share this
	 * body so the triple can never drift. Records by cause: drains record
	 * reconcile-correction; mounts record mount-correction (decoded as
	 * 'mount-urgent-correction'); quiet folds record nothing here — the fold's
	 * own quiet-write record is the whole quiet stream, and the oracle's
	 * mirrored quiet corrections are silent too, so the streams stay
	 * comparable. Returns true iff a correction fired. */
	private correctWatcher(w: Watcher, wNode: AnyNode, now: Value, cause: 'retirement' | 'per-root-commit' | 'quiet' | 'mount'): boolean {
		if (!this.changedValue(wNode, w.lastRenderedValue, now)) return false;
		if (cause !== 'quiet') {
			const tr = this.trace;
			if (tr !== undefined) {
				if (cause === 'mount') tr.mountCorrection(w, w.lastRenderedValue, now);
				else tr.reconcileCorrection(w, w.root, w.lastRenderedValue, now, cause === 'per-root-commit');
			}
		}
		w.lastRenderedValue = now; // the urgent pre-paint re-render
		w.dedupBits = 0; // dedup bits re-arm at the watcher's render
		if (this.onCorrection !== undefined) this.queueNotify(2, w, undefined, 0);
		return true;
	}

	private drainCommittedObservers(rootId: RootId, cause: 'retirement' | 'per-root-commit'): void {
		const world: World = { kind: 'committed', root: rootId };
		const gen = ++this.walkGen; // per-node collection dedup + per-arena traversal stamps
		const lastWalk = this.lastWalk;
		const ws = this.drainWatcherBuf;
		ws.length = 0;
		// Candidate collection (§4.4.6): the root arena's dirty list seeds a
		// walk over ALL arena links — weak included. No folds or allocations
		// run inside the walk, so a.W/a.walk are stable to cache.
		const a = this.arenaByRoot.get(rootId);
		if (a !== undefined && a.dirty.length !== 0) {
			const W = a.W;
			const walk = a.walk;
			const stack = this.walkStack;
			let sp = 0;
			const list = a.dirty;
			for (let i = 0; i < list.length; i++) {
				const sh = list[i]!;
				if (walk[sh >> A_SHIFT] === gen) continue;
				walk[sh >> A_SHIFT] = gen;
				stack[sp++] = sh;
				const nid = W[sh + AF.NODE]!;
				if (lastWalk[nid] !== gen) {
					lastWalk[nid] = gen;
					this.collectRootWatchersAt(nid, rootId, ws);
				}
			}
			while (sp > 0) {
				const sh = stack[--sp]!;
				// BOTH subs lists: drains expand over weak links too (§4.4.1).
				for (let list = 0; list < 2; list++) {
					let l = aSubsHead(a, sh, list);
					while (l !== 0) {
						const sub = W[l + AF.L_SUB]!;
						if (walk[sub >> A_SHIFT] !== gen) {
							walk[sub >> A_SHIFT] = gen;
							stack[sp++] = sub;
							const nid = W[sub + AF.NODE]!;
							if (lastWalk[nid] !== gen) {
								lastWalk[nid] = gen;
								this.collectRootWatchersAt(nid, rootId, ws);
							}
						}
						l = W[l + AF.L_NEXT_SUB]!;
					}
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
			const wNode = this.nodeById(w.node);
			this.correctWatcher(w, wNode, this.evaluate(wNode, world), cause);
		}
		ws.length = 0;
	}

	// ---------------------------------------------------------- mount fixup

	/** Every slot in `bits` has its last write at or before `pin` (the
	 * fast-out's clock conjunct, quantified over a snapshot's slot bits). */
	private slotClocksQuiet(bits: SlotSet, pin: Seq): boolean {
		for (let s = 0; bits !== 0; s++, bits >>>= 1) {
			if ((bits & 1) === 1 && this.slots[s]!.writeClock > pin) return false;
		}
		return true;
	}

	/**
	 * Mount fixup — runs in the mounting component's layout effect (after
	 * commit, before paint), after subscription. Why it exists: a component
	 * can mount while other updates are in flight, and its subscription only
	 * activates at commit, so writes could slip by unobserved between its
	 * render and its commit. This is contract clause RT6
	 * (spec/react-compliance-contract.md §3.1) made mechanical — its two
	 * halves, decided in this order:
	 *  1. catch-up (no evaluation; write metadata only): a value-blind
	 *     corrective re-render joins each live batch that touched the node
	 *     but was not part of this render — the component joins the pending
	 *     update in that batch's own lane instead of revealing it early or
	 *     missing it;
	 *  2. urgent correction: whatever committed or retired during the mount
	 *     window is fixed before paint. The four-condition test decides
	 *     FIRST: when every condition passes, nothing committed or retired
	 *     in the window and any remaining drift is exactly the live-batch
	 *     writes step 1 already scheduled catch-ups for (concurrent-scars
	 *     S43 pins why those must NOT be corrected urgently) — so nothing
	 *     else runs, no evaluation, no comparison. Only when a condition
	 *     fails is the node re-evaluated in the fast-forwarded mount-fix
	 *     world and a real difference corrected urgently.
	 * One subtle rule, asserted by the lockstep tests: the clock condition
	 * quantifies over the committing pass's member TOKENS at commit time
	 * (not just the slot set captured at render start — a token whose first
	 * write landed mid-render interned its slot after the capture, so the
	 * slot-quantified form would miss its writes).
	 */
	private mountFixup(w: Watcher, committingPass: Pass, baseline: { cas: Seq; rootCommitGen: CommitGen }, maskTokenRecords: Token[]): void {
		const node = this.nodeById(w.node);
		const closure = this.dependencyClosureOf(w.node, committingPass);
		const tr = this.trace; // one load covers the corrective records + the disposition record
		// RT6 first half — per-token catch-up loop: every LIVE written token
		// that touched the node. A premise of the condition test's soundness,
		// not an optimization: a live committed member can write after the pin
		// without tripping any condition (its slot is outside the render
		// mask), and this schedule is what carries such writes.
		let correctives = 0;
		for (const t of this.tokens.values()) {
			if (t.state !== 'live' || t.slot === undefined) continue;
			if (!this.tokenTouches(t, closure)) continue;
			const slot = this.slots[t.slot]!;
			// Fully included (slot ∈ included bits ∧ no post-pin write): skip — never by value.
			if (((w.snapshot.includedBits >>> slot.id) & 1) === 1 && slot.writeClock <= w.snapshot.pin) continue;
			if (tr !== undefined) tr.mountCorrective(w, t.id, slot.id);
			correctives++;
			w.dedupBits |= 1 << slot.id; // the corrective is a state update scheduled into t's lane (the protocol's runInBatch)
			if (this.onMountCorrective !== undefined) this.queueNotify(1, w, t, slot.id);
		}
		// RT6 second half — the four-condition test, decided before any
		// evaluation: same pass, no committed-truth advance, no per-root
		// commit, clocks quiet. The clock condition checks the captured mask
		// slots AND the committing pass's mask tokens at commit time — a mask
		// token whose first write interned its slot mid-pass is invisible to
		// the slot-quantified form, because the slot set was captured at pass
		// start, before that slot existed.
		const clocksQuiet =
			this.slotClocksQuiet(w.snapshot.maskBits, w.snapshot.pin) &&
			maskTokenRecords.every((t) => t.lastWriteSeq === 0 || t.lastWriteSeq <= w.snapshot.pin);
		const fastOut =
			w.snapshot.passId === committingPass.id &&
			baseline.cas <= w.snapshot.pin &&
			baseline.rootCommitGen === w.snapshot.rootCommitGen &&
			clocksQuiet;
		if (fastOut) {
			if (tr !== undefined) tr.mountFixup(w, 'fast-out', correctives);
			return; // nothing committed or retired in the window: no evaluation, no comparison
		}
		const vFx = this.evaluate(node, {
			kind: 'mountFix', maskBits: w.snapshot.maskBits, pin: w.snapshot.pin, root: w.root,
		});
		if (this.correctWatcher(w, node, vFx, 'mount')) {
			if (tr !== undefined) tr.mountFixup(w, 'corrected', correctives);
			return;
		}
		if (tr !== undefined) tr.mountFixup(w, 'compare-clean', correctives);
	}

	/** Transitive dependency closure feeding a node — §4.4.7's triple: three
	 * reverse (deps-direction) walks over kernel ∪ the mounting pass's arena
	 * ∪ the root's committed arena. The kernel leg walks the KERNEL's own
	 * dep links (S-C — tracked-only by construction, evaluation-lagged
	 * exactly like every other recorded structure), mapping visited kernel
	 * records back to registered bridge nodes; unregistered intermediates
	 * are traversed but contribute nothing (only bridge-written atoms can
	 * appear in token touch sets). STRONG links only (weak deps never
	 * joined the closure — they can't deliver, so correctives never target
	 * their batches). The pass arena is alive here by m2's ordering (fixup
	 * runs before reclaimAfterPassEnd); dead foreign cones are excluded by
	 * the discriminant argument. The corrective population this closure
	 * feeds arms the per-(watcher, slot) dedup bits, so it must cover every
	 * cone the delivery walk can later route — pass + committed arenas + the
	 * newest structure — or a suppression would degrade into an
	 * over-delivery (the lockstep corpus's ⊆ delivery bound polices exactly
	 * this). */
	dependencyClosureOf(nodeId: NodeId, pass?: Pass): Set<NodeId> {
		const closure = new Set<NodeId>([nodeId]);
		const pa = pass?.arena;
		if (pa !== undefined) this.closureOverArena(pa, nodeId, closure);
		if (pass !== undefined) {
			const ca = this.arenaByRoot.get(pass.root);
			if (ca !== undefined) this.closureOverArena(ca, nodeId, closure);
		}
		const node = this.nodesArr[nodeId];
		if (node !== undefined) this.closureOverKernel(node.handle._id, closure, new Set());
		return closure;
	}

	/** The kernel leg of the fixup closure (S-C): reverse walk over the
	 * kernel's dep links off the raw arena view (the kernel's own exported
	 * layout enums). */
	private closureOverKernel(kid: KernelId, closure: Set<NodeId>, seen: Set<KernelId>): void {
		if (seen.has(kid)) return;
		seen.add(kid);
		const M = __kernelBuffer();
		let l = M[kid + NodeField.DEPS]!;
		while (l !== 0) {
			const depKid = M[l + LinkField.DEP]!;
			const dep = this.byKernelId.get(depKid);
			if (dep !== undefined) closure.add(dep.id);
			if ((M[depKid + NodeField.FLAGS]! & NodeFlag.K_COMPUTED) !== 0) this.closureOverKernel(depKid, closure, seen);
			l = M[l + LinkField.NEXT_DEP]!;
		}
	}

	/** One arena's reverse-deps half of the fixup closure (strong links). */
	private closureOverArena(a: ShadowArena, nodeId: NodeId, closure: Set<NodeId>): void {
		const start = nodeId < a.byNode.length ? a.byNode[nodeId]! : 0;
		if (start === 0) return;
		if (a.W[start + AF.GEN] !== this.nodeGen[nodeId]!) return; // dead-tenancy residue never routes
		const gen = ++this.walkGen;
		const W = a.W;
		const walk = a.walk;
		const stack = this.walkStack;
		let sp = 0;
		walk[start >> A_SHIFT] = gen;
		stack[sp++] = start;
		while (sp > 0) {
			const sh = stack[--sp]!;
			let l = W[sh + AF.DEPS]!;
			while (l !== 0) {
				if ((W[l + AF.L_MODE]! & 1) === 0) {
					const dep = W[l + AF.L_DEP]!;
					if (walk[dep >> A_SHIFT] !== gen) {
						walk[dep >> A_SHIFT] = gen;
						closure.add(W[dep + AF.NODE]!);
						stack[sp++] = dep;
					}
				}
				l = W[l + AF.L_NEXT_DEP]!;
			}
		}
	}

	/** §4.5.3 (S-C): the value-change gate for compare-and-correct sites,
	 * honoring a custom-equality computed's policy comparator — mountFix
	 * fold-throughs (and evicted-then-refolded arena slots) mint FRESH
	 * references for comparator-equal values, which are NOT changes for a
	 * custom-equality node (the kernel wrapper and the arena slot both keep
	 * old references under the same policy). Exceptional payloads never
	 * bridge the gate (sentinels compare by identity — battery 16d).
	 * Default-equality nodes compare by identity, exactly as before. */
	private changedValue(node: AnyNode, prev: Value, next: Value): boolean {
		if (
			node.kind === 'computed' && node.isEqual !== undefined
			&& !(prev instanceof SuspendedRead) && !(next instanceof SuspendedRead)
		) {
			const eq = node.isEqual;
			return !this.inCallback(() => eq(prev, next));
		}
		return !Object.is(prev, next);
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
	 * Quiescence (no live tokens, no live pins, no parked actions): the
	 * epoch bumps, dead episode records drop, and
	 * the ARENAS PERSIST — their links are current structure, not an
	 * episode log (§4.1), so the routing coverage committed observers rely
	 * on survives by persistence (the old K1 bulk-reset + kernel-pull
	 * refresh dissolved with K1 at S-B; nothing re-records because nothing
	 * was lost). Two arena duties run, in order: the zero-consumer
	 * reclamation sweep, then the read-clock renumber over the survivors
	 * only (§4.5.8, §4.5.7).
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
		this.epoch++;
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
		// (No newest-side reset since S-C: kernel caches persist — nothing
		// newest-visible changes at quiescence.)
		// Arena duties (§4.5.8 then §4.5.7): reclamation sweep, then the
		// read-clock renumber over surviving consumer-populated arenas.
		this.arenaQuiesceSweep();
		// Dead-episode bookkeeping zeroes (bulk-zero at episode reset).
		for (const s of this.slots) {
			s.writeClock = 0;
			s.claimSeq = 0;
			s.releasePending = false;
		}
		for (const w of this.watchers.values()) w.dedupBits = 0;
		{
			const tr = this.trace;
			if (tr !== undefined) tr.epochReset(this.epoch);
		}
		this.recomputeQuiet(); // quiescent by definition; re-derive from the new episode's state
		this.endOp();
		this.arenaOpEpilogue();
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
}

// One Core: this module is internal machinery of the single `cosignal` entry
// (src/index.ts imports and re-exports it). It adds `registerReactBridge`,
// the bridge class, and the bridge-surface types to the base API.
