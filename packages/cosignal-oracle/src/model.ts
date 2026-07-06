/**
 * The naive reference model ("oracle") for cosignal's concurrent semantics.
 *
 * The behavioral contract it implements is stated in prose in README.md;
 * every rule here carries its rationale in a comment at the point it is
 * enforced.
 *
 * Authority comes from SIMPLICITY: plain objects, no caches, no cleverness.
 * Worlds (self-consistent views of all atom values) are pure folds — a fold
 * replays the receipts a world may see, in timeline order, over the atom's
 * base value (README vocabulary); computeds are memo-free recursive
 * evaluation in a given world; the React host is simulated as explicit
 * token/pass/retirement bookkeeping. Where the engine has optimizations
 * (dirty marking, memo tables, fast paths) the model simply recomputes
 * everything, so any engine behavior those optimizations change is a bug
 * in the engine, not in the model.
 */

export type Value = unknown;
export type NodeId = number;
export type TokenId = number;
export type SlotId = number;
export type RootId = string;
export type PassId = number;
export type WatcherId = number;
export type EffectId = number;


/** The write vocabulary: set/update. A reducer-style write records as an
 * update whose closure captures the reducer and the action. */
export type Op =
	| { kind: 'set'; value: Value }
	| { kind: 'update'; fn: (prev: Value) => Value };

/**
 * A receipt records one write: {op, slot, seq} appended to the written
 * atom's tape. retiredSeq is stamped when the writing batch retires. The
 * token is carried for invariant checking and event logs only: folds
 * resolve visibility through slot+seq alone, exactly as the contract's
 * visibility rules do — so the aliasing hazards of slot recycling (two
 * batches sharing a slot number across time) are exercised honestly
 * rather than papered over by token identity.
 */
export type Receipt = {
	op: Op;
	token: TokenId;
	slot: SlotId;
	seq: number;
	retiredSeq: number | undefined;
};

export type Equals = (a: Value, b: Value) => boolean;

export type AtomNode = {
	kind: 'atom';
	id: NodeId;
	name: string;
	/** The folded floor of the tape: committed history already compacted in. */
	base: Value;
	baseSeq: number;
	tape: Receipt[];
	/** Full history for invariant 4 (receipt-retention soundness): compacted receipts move here. */
	archive: Receipt[];
	/** The value the atom was created with (shadow-fold origin). */
	origin: Value;
	equals: Equals;
	/** Per-atom retirement stamp, minted at every retirement that touched this atom. */
	retirementStamp: number;
};

/** Reader passed to computed functions; tracked reads record dependency edges, untracked reads do not. */
export type Reader = (node: AnyNode) => Value;
export type ComputedFn = (read: Reader, untracked: Reader) => Value;

export type ComputedNode = {
	kind: 'computed';
	id: NodeId;
	name: string;
	/**
	 * Immutable for the node's whole life: pending worlds replay evaluation,
	 * so a swapped function would let one world see another closure's output.
	 * "Changing" a computed means creating a fresh node.
	 */
	fn: ComputedFn;
};

export type AnyNode = AtomNode | ComputedNode;

export type Token = {
	id: TokenId;
	/** Async action: the token parks and retires only when the action settles. */
	action: boolean;
	parked: boolean;
	state: 'live' | 'retired';
	slot: SlotId | undefined;
	retiredSeq: number | undefined;
	/** Sequence of this token's last receipt (0 = none) — the mount fixup's
	 * fast-path clock check reads it (the engine twin is the same scalar). */
	lastWriteSeq: number;
	/** True for the model's auto-minted ambient default batch (home of context-free writes). */
	ambient: boolean;
};

/**
 * One entry of the 31-slot batch identity table. Slots recycle: safety
 * rests on ordering (a claim is sequenced after the previous tenant's
 * retirement, so folds tell tenants apart by seq alone).
 */
export type SlotMeta = {
	id: SlotId;
	tenant: TokenId | undefined;
	/** seq minted at claim — the anchor of the tenant-ordering argument above. */
	claimSeq: number;
	/** Write clock: seq of the slot's last write. Zeroed when a new tenant claims the slot. */
	writeClock: number;
	/** Retirement done but release deferred because an open pass's render mask names the slot. */
	releasePending: boolean;
};

export type PassState = 'open' | 'yielded' | 'ended';

export type Pass = {
	id: PassId;
	root: RootId;
	/**
	 * The pin: the global sequence position frozen at pass start and observed
	 * forever, across yields — a paused-and-resumed render must never see a
	 * write that landed during the pause (that would be a tear inside one render).
	 */
	pin: number;
	/** Render mask: the live batches this pass renders, captured at pass start. */
	maskTokens: Set<TokenId>;
	maskSlots: Set<SlotId>;
	/** The root's committed-batch slot set, snapshotted at pass start. */
	capturedCommittedSlots: Set<SlotId>;
	state: PassState;
	endKind: 'commit' | 'discard' | undefined;
	/** Watchers first mounted by this pass (they subscribe + reconcile at its commit). */
	mounted: WatcherId[];
	/** Existing watchers re-rendered by this pass (lastRenderedValue updates at commit only). */
	rendered: Set<WatcherId>;
};

export type RootState = {
	id: RootId;
	/** Per-root commit ("lock-in") table: rows exist for live tokens only (cleared at retirement). */
	committedTokens: Set<TokenId>;
	/** Root commit generation; bumped at every per-root commit. */
	commitGen: number;
};

/** The watcher's rendered-world snapshot: what its last committed render was allowed to see. */
export type WatcherSnapshot = {
	passId: PassId;
	pin: number;
	maskSlots: Set<SlotId>;
	includedSlots: Set<SlotId>;
	rootCommitGen: number;
};

export type Watcher = {
	id: WatcherId;
	name: string;
	root: RootId;
	node: NodeId;
	/** Subscribed at its mounting pass's commit (React: in the layout phase, before paint). */
	live: boolean;
	lastRenderedValue: Value;
	snapshot: WatcherSnapshot;
	/** Per-(watcher, slot) delivery dedup bits — see deliver() for the suppression rule. */
	dedup: Set<SlotId>;
};

/**
 * A useSignalEffect-shaped observer: a committed-for-root dep-snapshot
 * subscription (the promoted production mechanism — effects unification,
 * 2026-07-06). Side effects must track what the user actually sees; a
 * pending update may still be discarded. The BODY is the real thing being
 * modeled: each run re-reads under committed-for-root capture and re-chooses
 * its dependencies causally (a flag-flip body reads different atoms on
 * different runs); `deps` is the (node, value) snapshot of the last run, and
 * re-checks are value-gated over it. Re-check timing is RCC-EF2's amended
 * BOUNDARY semantics: once per boundary operation (per-root commit,
 * retirement, settlement), at the boundary value, never while the effect's
 * own root has an open render-pass frame (deferred to that frame's close);
 * cleanup runs before every re-fire and at removal, and nothing runs after
 * removal (RCC-OL2).
 */
export type ReactEffect = {
	id: EffectId;
	name: string;
	root: RootId;
	/** The effect body: run under committed-for-root read capture. */
	body: (read: Reader) => void;
	/** Dep snapshot: (node, value) pairs the last run captured, in read order. */
	deps: { node: AnyNode; value: Value }[];
	/** Convenience comparand (tests): the last captured value of the last run. */
	lastValue: Value;
	runs: number;
	cleanups: number;
};

/** A core effect() observer: it sees the newest world (every write applied). */
export type CoreEffect = {
	id: EffectId;
	name: string;
	node: NodeId;
	lastValue: Value;
	runs: number;
};

/** A world: one self-consistent assignment of values to all atoms. */
export type World =
	| { kind: 'newest' }
	| { kind: 'pass'; pass: Pass }
	| { kind: 'committed'; root: RootId }
	/**
	 * The mount reconciliation's fast-forwarded world: the mounting render's
	 * own included writes up to its pin, plus committed truth as of NOW.
	 * `excludeLiveTokens` is the model's audit instrument for the fast-path
	 * soundness invariant: receipts of those (live) tokens stay visible only
	 * through the mask clause, subtracting exactly the divergence the
	 * per-token corrective loop already scheduled corrections for (see
	 * mountFixup and tests/FLAGS.md).
	 */
	| { kind: 'mountFix'; maskSlots: Set<SlotId>; pin: number; root: RootId; excludeLiveTokens?: Set<TokenId> };

/** The observable surface — what an engine must reproduce (see the README's adapter contract). */
export type ModelEvent =
	| { type: 'write'; node: string; token: TokenId; slot: SlotId; seq: number }
	| { type: 'write-dropped'; node: string; token: TokenId }
	| { type: 'delivery'; watcher: string; token: TokenId; slot: SlotId; seq: number; mode: 'fresh' | 'interleaved' }
	| { type: 'suppressed'; watcher: string; token: TokenId; slot: SlotId; seq: number }
	| { type: 'core-effect-run'; effect: string; value: Value }
	| { type: 'react-effect-run'; effect: string; root: RootId; value: Value; values: Value[] }
	| { type: 'react-effect-cleanup'; effect: string; root: RootId }
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
	| { type: 'epoch-reset'; epoch: number };

/** An op the schedule proposed that is illegal in the current state (generator skips these). */
export class ScheduleError extends Error {}
/** A model self-check failed — always a bug (in the model or in the contract as stated). */
export class InvariantViolation extends Error {}

const SLOT_COUNT = 31; // At most 31 live batches — one per React priority lane (React tracks lanes as bits of a 31-bit mask).

/**
 * What the visibility rule reads from its host: the two set-valued lookups
 * the pass and committed clauses are defined over. `CosignalModel` is its
 * own host (its `visible` method); an engine-side adapter that answers the
 * same two lookups can host the rule too, instead of restating it.
 */
export type VisibilityHost = {
	/** The pass's included set: the batches it renders plus the root's committed set at its start. */
	includedSet(pass: Pass): Set<SlotId>;
	/** The root's CURRENT committed-slot set (live committed tokens' slots). */
	committedSlotsNow(root: RootId): Set<SlotId>;
};

/**
 * THE visibility rule: which receipts each kind of world replays.
 *
 * - Pass world, two clauses: (1) receipts whose batch retired at or
 *   before the pass's pin — already permanent history when the render
 *   started; (2) receipts of included batches (rendered or already
 *   committed into the root at pass start), up to the pin. The pin cap
 *   is what keeps a paused-and-resumed render from drifting.
 * - Committed-for-root: every retired receipt, plus receipts of batches
 *   currently committed into the root (membership) — a root must keep
 *   agreeing with UI it already committed, even before those batches
 *   retire globally.
 * - Newest: everything (the engine applies writes to its core eagerly).
 * - Mount reconciliation: the mounting render's own inclusions at its
 *   pin, plus committed truth as of NOW — the mount's view
 *   fast-forwarded to what actually committed during its mount window.
 *
 * Exported standalone so the rule has exactly one Receipt-shaped statement:
 * the model folds through it, and an engine's test-side model view may call
 * it directly rather than keeping a copy.
 */
export function visible(host: VisibilityHost, e: Receipt, world: World): boolean {
	switch (world.kind) {
		case 'newest':
			return true;
		case 'pass': {
			const w = world.pass;
			if (e.retiredSeq !== undefined && e.retiredSeq <= w.pin) return true; // clause 1: retired by my pin
			return host.includedSet(w).has(e.slot) && e.seq <= w.pin; // clause 2: included, up to my pin
		}
		case 'committed': {
			if (e.retiredSeq !== undefined) return true; // committed truth at now
			return host.committedSlotsNow(world.root).has(e.slot); // membership
		}
		case 'mountFix': {
			if (world.maskSlots.has(e.slot) && e.seq <= world.pin) return true; // the render's own inclusions, at its pin
			if (world.excludeLiveTokens?.has(e.token)) return false; // corrective-covered live divergence (audit only)
			if (e.retiredSeq !== undefined) return true; // committed truth at NOW
			return host.committedSlotsNow(world.root).has(e.slot); // the root's CURRENT committed set
		}
	}
}

export class CosignalModel {
	nodes = new Map<NodeId, AnyNode>();
	tokens = new Map<TokenId, Token>();
	slots: SlotMeta[] = [];
	passes = new Map<PassId, Pass>();
	roots = new Map<RootId, RootState>();
	watchers = new Map<WatcherId, Watcher>();
	reactEffects = new Map<EffectId, ReactEffect>();
	coreEffects = new Map<EffectId, CoreEffect>();
	events: ModelEvent[] = [];

	/** Flipped once by registerBridge(). There is no pre-registration write
	 * mode: in the real system, writes reach a bridge only through the kernel
	 * write hook, which arms at registration — earlier writes are plain
	 * kernel state that never involves a bridge, so the model cannot express
	 * them (they throw, mirroring the engine). */
	private registered = false;
	/** The one global sequence line every receipt, pin, and stamp lives on. */
	seq = 0;
	/** Committed-advance counter, in sequence units: seq of the last change to any committed view. */
	cas = 0;
	/** Episode counter — bumped at quiescence, when all per-episode bookkeeping resets. */
	epoch = 0;
	/**
	 * Dependency edges accumulated this episode, across ALL worlds (add-only;
	 * reset at quiescence). Notification reachability runs over this union —
	 * deliberately conservative: a dependency that exists in any world must
	 * notify, and over-notification costs a render, never correctness.
	 */
	episodeEdges = new Map<NodeId, Set<NodeId>>(); // dep -> dependents

	/** Ambient default batch: the home of bare (context-free) writes. */
	ambientToken: TokenId | undefined;

	private nextNode = 1;
	private nextToken = 1;
	private nextPass = 1;
	private nextWatcher = 1;
	private nextEffect = 1;

	/** Purity frames: >0 while a world evaluation or fold is on stack (writes then throw). */
	private evalDepth = 0;
	/** True while inside an updater/reducer/equals callback (reads+writes throw). */
	private inFoldCallback = false;

	/**
	 * The newest world's SAMPLED-UNTRACKED computed cache [ruling 2026-07-06:
	 * untracked sampling]. Newest values of computeds follow KERNEL semantics:
	 * a computed re-derives only when a TRACKED dependency's newest value
	 * changed; untracked reads are point-in-time samples taken at those
	 * re-derivations and never invalidate on their own (the base library's
	 * untracked contract, value face). Each entry records the direct TRACKED
	 * deps of the last newest derivation with the values they had — the
	 * trackedFingerprint — and the derived value; validation re-checks each
	 * recorded dep's CURRENT sampled-newest value by identity, recursively
	 * (the kernel's checkDirty shape). Consulted ONLY by `newestValue` (and
	 * the newest-policy effect flush, which observes newest values): world
	 * folds are UNCHANGED — pass/committed/mountFix evaluations refold at
	 * their boundaries per the existing contract, so untracked deps stay
	 * fresh in every world-side revalidation. Deliberately NOT cleared at
	 * quiescence: the staleness is a property of the value contract, not of
	 * the episode (the kernel's cache persists the same way).
	 */
	private newestSamples = new Map<NodeId, { deps: { node: AnyNode; value: Value }[]; value: Value }>();
	/** Per-derivation cycle guard for the sampled evaluations. */
	private samplingStack = new Set<NodeId>();

	constructor() {
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

	private log(e: ModelEvent): void {
		this.events.push(e);
	}

	private mintSeq(): number {
		return ++this.seq;
	}

	// ---------------------------------------------------------------- setup

	/** Activates the bridge: once, monotonically; illegal inside open evaluation frames. */
	registerBridge(): void {
		if (this.evalDepth > 0 || this.inFoldCallback) {
			throw new ScheduleError('registerReactBridge called inside an open evaluation/fold frame; it may only run at an operation boundary');
		}
		if (this.registered) throw new ScheduleError('bridge already registered — registration happens exactly once');
		this.registered = true;
	}

	atom(name: string, initial: Value, equals?: Equals): AtomNode {
		const node: AtomNode = {
			kind: 'atom', id: this.nextNode++, name,
			base: initial, baseSeq: 0, tape: [], archive: [], origin: initial,
			equals: equals ?? Object.is, retirementStamp: 0,
		};
		this.nodes.set(node.id, node);
		return node;
	}

	computed(name: string, fn: ComputedFn): ComputedNode {
		const node: ComputedNode = { kind: 'computed', id: this.nextNode++, name, fn };
		this.nodes.set(node.id, node);
		return node;
	}

	root(id: RootId): RootState {
		let r = this.roots.get(id);
		if (r === undefined) {
			r = { id, committedTokens: new Set(), commitGen: 0 };
			this.roots.set(id, r);
		}
		return r;
	}

	// ---------------------------------------------------- worlds and folds

	/** The pass's included set: the batches it renders plus the root's committed set at its start. */
	includedSet(pass: Pass): Set<SlotId> {
		return new Set([...pass.maskSlots, ...pass.capturedCommittedSlots]);
	}

	/** The root's CURRENT committed-slot set (live committed tokens' slots; retired tokens' rows are cleared). */
	committedSlotsNow(rootId: RootId): Set<SlotId> {
		const out = new Set<SlotId>();
		for (const t of this.root(rootId).committedTokens) {
			const tok = this.tokens.get(t);
			if (tok !== undefined && tok.slot !== undefined) out.add(tok.slot);
		}
		return out;
	}

	/** THE visibility rule (the exported `visible`, above), with this model as its host. */
	visible(e: Receipt, world: World): boolean {
		return visible(this, e, world);
	}

	/**
	 * Runs a user callback (updater/reducer/equals) under the fold-purity
	 * guard: signal reads and writes inside it throw. These callbacks replay
	 * per world; an impure one would make worlds disagree.
	 */
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
				// Reducer-style writes arrive here too: the closure carries
				// the reducer and the captured action.
				return this.inCallback(() => op.fn(prev));
		}
	}

	/**
	 * The fold: replay the world-visible receipts over the base in sequence
	 * order, applying the atom's equality stepwise (an equal step keeps the
	 * old reference, so equality cutoffs behave identically in every world).
	 */
	foldAtom(atom: AtomNode, world: World): Value {
		let value = atom.base;
		for (const e of atom.tape) { // tape is in seq order by construction
			if (!this.visible(e, world)) continue;
			const next = this.applyOp(atom, e.op, value);
			if (!this.inCallback(() => atom.equals(next, value))) value = next;
		}
		return value;
	}

	/** Retention-invariant helper: the same fold over the FULL history (archive + tape) from the origin value. */
	shadowFoldAtom(atom: AtomNode, world: World): Value {
		let value = atom.origin;
		for (const e of [...atom.archive, ...atom.tape]) {
			if (e.retiredSeq === undefined && !this.visible(e, world)) continue;
			// Archived (compacted) entries are visible to every live world by the
			// compaction rule (they retired at or below every live pin) — assert via visible() too.
			if (!this.visible(e, world)) continue;
			const next = this.applyOp(atom, e.op, value);
			if (!this.inCallback(() => atom.equals(next, value))) value = next;
		}
		return value;
	}

	/**
	 * Memo-free recursive evaluation of a node in a world. Tracked reads
	 * record real dependency edges into the episode's union graph; untracked
	 * reads fold in-world but record no edge — untracked licenses missing a
	 * NOTIFICATION (temporal staleness), never reading another world's value
	 * (world leakage), and in a fold-everything model the in-world fold is
	 * the whole story. Writes during evaluation throw (render must be pure);
	 * a cycle within one world throws rather than looping.
	 */
	evaluate(node: AnyNode, world: World, stack?: Set<NodeId>): Value {
		if (this.inFoldCallback) throw new ScheduleError('signal read inside an updater/reducer fold — updaters and reducers must be pure; read what you need before dispatching');
		if (node.kind === 'atom') return this.foldAtom(node, world);
		const seen = stack ?? new Set<NodeId>();
		if (seen.has(node.id)) throw new ScheduleError(`cyclic evaluation of ${node.name} within one world — a computed may not depend on itself`);
		seen.add(node.id);
		this.evalDepth++;
		try {
			const read: Reader = (dep) => {
				this.recordEdge(dep.id, node.id);
				return this.evaluate(dep, world, seen);
			};
			const untracked: Reader = (dep) => this.evaluate(dep, world, seen);
			return node.fn(read, untracked);
		} finally {
			this.evalDepth--;
			seen.delete(node.id);
		}
	}

	private recordEdge(dep: NodeId, dependent: NodeId): void {
		let outs = this.episodeEdges.get(dep);
		if (outs === undefined) {
			outs = new Set();
			this.episodeEdges.set(dep, outs);
		}
		outs.add(dependent);
	}

	/**
	 * Delivery reachability. A write must notify every watcher that depends
	 * on the written atom IN ANY WORLD — a dependency that exists only in a
	 * pending world (e.g. behind a flag the pending world flipped) still
	 * needs its notification, or the pending render goes stale forever. The
	 * naive form: evaluate every node in every currently relevant world
	 * (recording real edges), then take reachability over the episode's
	 * accumulated union. Deliberately conservative: over-notification costs
	 * a render that folds to an equal value, never a wrong value (pinned by
	 * acceptance scenario case 1 V2).
	 */
	private refreshEdgesAllWorlds(): void {
		const worlds: World[] = [{ kind: 'newest' }];
		for (const p of this.passes.values()) {
			if (p.state !== 'ended') worlds.push({ kind: 'pass', pass: p });
		}
		for (const r of this.roots.keys()) worlds.push({ kind: 'committed', root: r });
		for (const n of this.nodes.values()) {
			if (n.kind !== 'computed') continue;
			for (const w of worlds) this.evaluate(n, w);
		}
	}

	/** Nodes reachable from `from` over the accumulated union graph (including `from`). */
	reachableFrom(from: NodeId): Set<NodeId> {
		const reached = new Set<NodeId>([from]);
		const queue = [from];
		while (queue.length > 0) {
			const cur = queue.pop()!;
			for (const next of this.episodeEdges.get(cur) ?? []) {
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
		for (const p of this.passes.values()) if (p.state !== 'ended') pins.push(p.pin);
		return pins;
	}

	private minLivePin(): number {
		const pins = this.livePins();
		return pins.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...pins);
	}

	/** Mint a batch token. At most 31 live at once — one per React priority
	 * lane. (Lane priority itself stays React's: neither the model nor the
	 * engine ever consults it — the Priority dimension was deleted.) */
	openBatch(opts?: { action?: boolean; ambient?: boolean }): Token {
		if (!this.registered) throw new ScheduleError('batches require a registered bridge — register the React bridge first');
		if (this.liveTokens().length >= SLOT_COUNT) {
			throw new ScheduleError('at most 31 batch tokens may be live at once (one per React lane)');
		}
		const token: Token = {
			id: this.nextToken++,
			action: opts?.action ?? false,
			parked: opts?.action ?? false, // action tokens park until their async action settles
			state: 'live', slot: undefined,
			retiredSeq: undefined, lastWriteSeq: 0, ambient: opts?.ambient ?? false,
		};
		this.tokens.set(token.id, token);
		return token;
	}

	/** Look up an id or throw the schedule error every resolver shares (the
	 * same hygiene fix as the engine's mustGet — applied independently; the
	 * two implementations stay unshared by design). */
	private mustGet<K, V>(map: Map<K, V>, id: K, what: string): V {
		const v = map.get(id);
		if (v === undefined) throw new ScheduleError(`unknown ${what} ${id}`);
		return v;
	}

	private token(id: TokenId): Token {
		return this.mustGet(this.tokens, id, 'token');
	}

	nodeById(id: NodeId): AnyNode {
		return this.mustGet(this.nodes, id, 'node');
	}

	/**
	 * A batch's first write interns its slot, claiming a free one. Claim
	 * housekeeping: the write clock zeroes and every per-(watcher, slot)
	 * dedup bit clears, so nothing from the previous tenant can suppress or
	 * satisfy the new tenant's deliveries; the retirement watermark carries
	 * forward across tenants within an episode (the model has no cached
	 * routing state to preserve — it recomputes routing) and zeroes at the
	 * episode reset.
	 */
	private internSlot(token: Token): SlotMeta {
		if (token.slot !== undefined) return this.slots[token.slot]!;
		let free = this.slots.find((s) => s.tenant === undefined);
		if (free === undefined) {
			// Backstop: all 31 slots held ⇒ release the oldest retired-but-mask-retained slot anyway, loudly.
			// Safe because receipts keep their slot fields (see tests/FLAGS.md, flag 7).
			const candidates = this.slots.filter((s) => s.releasePending);
			if (candidates.length === 0) {
				throw new ScheduleError('slot table full of live tenants — unreachable under the 31-live-token guard');
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
		free.tenant = token.id;
		free.claimSeq = this.mintSeq(); // tenancy ordering: every claim gets its own point on the line, after the previous tenant's retirement
		free.writeClock = 0;
		free.releasePending = false;
		token.slot = free.id;
		for (const w of this.watchers.values()) w.dedup.delete(free.id); // dedup bits clear at re-intern (stale bits must not suppress the new tenant)
		this.log({ type: 'slot-claimed', slot: free.id, token: token.id });
		return free;
	}

	private releaseSlot(slot: SlotMeta): void {
		const tenant = slot.tenant === undefined ? undefined : this.token(slot.tenant);
		if (tenant !== undefined) {
			tenant.slot = undefined; // identity release only; receipts keep their denormalized slot field forever
			this.log({ type: 'slot-released', slot: slot.id, token: tenant.id });
		}
		slot.tenant = undefined;
		slot.releasePending = false;
	}

	// ------------------------------------------------------ the write path

	/**
	 * A write belongs to the batch context in which it executes; a bare
	 * (context-free) write goes to the ambient default batch. This is the
	 * same rule React's own transitions have — an async continuation runs on
	 * a fresh stack with no ambient transition context.
	 */
	bareWrite(node: AtomNode, op: Op): void {
		let ambient = this.ambientToken === undefined ? undefined : this.tokens.get(this.ambientToken);
		if (ambient === undefined || ambient.state !== 'live') {
			ambient = this.openBatch({ ambient: true });
			this.ambientToken = ambient.id;
		}
		// The post-await dev-warning heuristic is adapter-only (cosignal-react's
		// shim) — the model, like the engine, emits no dev events.
		this.write(ambient.id, node, op);
	}

	/** Action-scope write: classifies into the action's token explicitly (works after await); throws once settled. */
	scopeWrite(tokenId: TokenId, node: AtomNode, op: Op): void {
		const t = this.token(tokenId);
		if (!t.action) throw new ScheduleError('scope writes require an action token');
		if (t.state !== 'live') throw new ScheduleError('ActionScope closed — the action already settled');
		this.write(tokenId, node, op);
	}

	/**
	 * The write path (registered bridges only — an unregistered model
	 * throws, mirroring the engine: pre-registration writes are plain kernel
	 * state that never reaches a bridge, so they cannot be expressed here).
	 */
	write(tokenId: TokenId | undefined, node: AtomNode, op: Op): void {
		if (this.evalDepth > 0) throw new ScheduleError('signal write during a world evaluation / render — write from an event handler or effect instead');
		if (this.inFoldCallback) throw new ScheduleError('signal write inside an updater/reducer fold — updaters and reducers must be pure');
		if (node.kind !== 'atom') throw new ScheduleError('writes target atoms');
		if (!this.registered) throw new ScheduleError('writes require a registered bridge — before registration, writes are plain kernel state and never reach a bridge');
		if (tokenId === undefined) {
			this.bareWrite(node, op);
			return;
		}
		const token = this.token(tokenId);
		if (token.state !== 'live') throw new ScheduleError(`write into retired token ${tokenId} — a retired batch accepts no new writes`);

		// Drop check — the ONLY legal equality drop: empty tape AND the op
		// evaluates equal against the base. With pending history present, a
		// "no-op" write could still change some world's fold, so it must append.
		if (node.tape.length === 0) {
			const evaluated = this.applyOp(node, op, node.base);
			if (this.inCallback(() => node.equals(evaluated, node.base))) {
				this.log({ type: 'write-dropped', node: node.name, token: tokenId });
				return;
			}
		}

		// Record the write: intern the slot, append the receipt, bump the slot's write clock.
		const slot = this.internSlot(token);
		const seq = this.mintSeq();
		node.tape.push({ op, token: token.id, slot: slot.id, seq, retiredSeq: undefined });
		token.lastWriteSeq = seq;
		slot.writeClock = seq;
		this.log({ type: 'write', node: node.name, token: token.id, slot: slot.id, seq });

		// Notify. The model recomputes the union dependency graph (edges are
		// recorded by evaluation) and reaches every affected watcher/effect.
		this.refreshEdgesAllWorlds();
		const reached = this.reachableFrom(node.id);
		for (const w of this.watchers.values()) {
			if (!w.live || !reached.has(w.node)) continue;
			this.deliver(w, token, slot, seq);
		}
		this.flushCoreEffects(reached);
	}

	/**
	 * Delivery — per write, value-blind, in the writer's stack; the watcher's
	 * re-render is scheduled into the WRITING batch's lane. Value-blind
	 * because whether a write changes a watcher's output depends on the world
	 * doing the asking; any single comparison at delivery time would compare
	 * across worlds. The per-(watcher, slot) dedup bit suppresses a repeat
	 * only when scheduled-but-unstarted work will fold the write; otherwise
	 * (a render already pinned before the write) the write is delivered as an
	 * interleaved update, because the running render cannot see it.
	 */
	private deliver(w: Watcher, token: Token, slot: SlotMeta, seq: number): void {
		if (!w.dedup.has(slot.id)) {
			w.dedup.add(slot.id);
			this.log({ type: 'delivery', watcher: w.name, token: token.id, slot: slot.id, seq, mode: 'fresh' });
			return;
		}
		// Bit already set: suppress iff NO started-and-uncommitted pass on W's
		// root renders this slot with a pin below the write's sequence — such
		// a pass has already read past the write and will not fold it.
		let mustDeliver = false;
		for (const p of this.passes.values()) {
			if (p.state === 'ended') continue; // "open" includes yielded and completed-but-uncommitted
			if (p.root !== w.root) continue;
			if (p.maskSlots.has(slot.id) && p.pin < seq) {
				mustDeliver = true;
				break;
			}
		}
		if (mustDeliver) {
			this.log({ type: 'delivery', watcher: w.name, token: token.id, slot: slot.id, seq, mode: 'interleaved' });
		} else {
			this.log({ type: 'suppressed', watcher: w.name, token: token.id, slot: slot.id, seq });
		}
	}

	/** Core effects observe the newest world — through `newestValue`, so the
	 * values they compare carry the sampled-untracked rule [ruling 2026-07-06]
	 * exactly as the engine's kernel-served flush does; they flush after the
	 * write's notification walk returns. */
	private flushCoreEffects(reached?: Set<NodeId>): void {
		for (const e of this.coreEffects.values()) {
			if (reached !== undefined && !reached.has(e.node)) continue;
			const value = this.newestValue(this.nodeById(e.node));
			if (!Object.is(value, e.lastValue)) {
				e.lastValue = value;
				e.runs++;
				this.log({ type: 'core-effect-run', effect: e.name, value });
			}
		}
	}

	// ------------------------------------------------------ pass lifecycle

	/**
	 * Open a render pass: the pin freezes at start, the render mask is
	 * captured from live tokens, and the root's committed set is
	 * snapshotted. One work-in-progress pass per root — a same-root restart
	 * is a NEW pass at a fresh pin, which is how React picks up interleaved
	 * writes it could not fold mid-render.
	 */
	passStart(rootId: RootId, includeTokens: TokenId[]): Pass {
		for (const p of this.passes.values()) {
			if (p.state !== 'ended' && p.root === rootId) {
				throw new ScheduleError(`root ${rootId} already has an open pass — one render pass per root at a time`);
			}
		}
		const maskTokens = new Set<TokenId>();
		const maskSlots = new Set<SlotId>();
		for (const id of includeTokens) {
			const t = this.token(id);
			if (t.state !== 'live') throw new ScheduleError('mask captures live tokens only — a retired batch is already permanent history');
			maskTokens.add(id);
			// A live token with no slot never wrote; its later receipts postdate the
			// pin and are excluded by the pin cap anyway (claims are sequenced, so
			// any future slot's writes sit above this pass's pin).
			if (t.slot !== undefined) maskSlots.add(t.slot);
		}
		const pass: Pass = {
			id: this.nextPass++, root: rootId, pin: this.seq,
			maskTokens, maskSlots,
			capturedCommittedSlots: this.committedSlotsNow(rootId),
			state: 'open', endKind: undefined, mounted: [], rendered: new Set(),
		};
		this.passes.set(pass.id, pass);
		return pass;
	}

	private pass(id: PassId): Pass {
		return this.mustGet(this.passes, id, 'pass');
	}

	/**
	 * Yield/resume edges of a pass. Code running in the gap (event handlers,
	 * timers) is NOT "in render" — being in render is a property of the call
	 * stack, not of wall-clock time between a pass's slices — so gap code
	 * reads the newest world and may write freely into its own batches.
	 */
	passYield(id: PassId): void {
		const p = this.pass(id);
		if (p.state !== 'open') throw new ScheduleError('yield requires an open (running) pass');
		p.state = 'yielded';
	}

	passResume(id: PassId): void {
		const p = this.pass(id);
		if (p.state !== 'yielded') throw new ScheduleError('resume requires a yielded pass');
		p.state = 'open';
	}

	/** Mount a new watcher inside an open pass; its first render reads the pass's world. */
	mountWatcher(passId: PassId, node: AnyNode, name: string): Watcher {
		const p = this.pass(passId);
		if (p.state === 'ended') throw new ScheduleError('mount requires an open pass');
		const value = this.evaluate(node, { kind: 'pass', pass: p });
		const watcher: Watcher = {
			id: this.nextWatcher++, name, root: p.root, node: node.id,
			live: false, // subscribes at layout, i.e. at this pass's commit
			lastRenderedValue: value,
			snapshot: {
				passId: p.id, pin: p.pin,
				maskSlots: new Set(p.maskSlots),
				includedSlots: this.includedSet(p),
				rootCommitGen: this.root(p.root).commitGen,
			},
			dedup: new Set(),
		};
		this.watchers.set(watcher.id, watcher);
		p.mounted.push(watcher.id);
		p.rendered.add(watcher.id);
		return watcher;
	}

	/**
	 * Reveal-shaped mounts (React Offscreen/Activity: a subtree is
	 * pre-rendered hidden, then revealed later): a watcher rendered by an
	 * older pass whose layout effects fire inside a DIFFERENT pass's commit.
	 * The adopting commit runs the reconciliation; the watcher's snapshot
	 * keeps its original rendered world, so the fast path's same-pass
	 * condition fails and the conservative comparison runs — which is the
	 * point, since arbitrary time passed between render and reveal.
	 */
	/** The hidden half of a reveal: the mounting pass commits but the watcher's
	 * layout effects (subscribe + reconcile) defer — an Offscreen/Activity subtree. */
	deferMount(watcherId: WatcherId): void {
		for (const p of this.passes.values()) {
			const i = p.mounted.indexOf(watcherId);
			if (i >= 0) p.mounted.splice(i, 1);
		}
	}

	adoptMount(passId: PassId, watcherId: WatcherId): void {
		const adopter = this.pass(passId);
		if (adopter.state === 'ended') throw new ScheduleError('adopting pass must be open');
		const w = this.mustGet(this.watchers, watcherId, 'watcher');
		if (w.root !== adopter.root) throw new ScheduleError('reveal stays on the watcher root');
		for (const p of this.passes.values()) {
			const i = p.mounted.indexOf(watcherId);
			if (i >= 0) p.mounted.splice(i, 1);
		}
		adopter.mounted.push(watcherId);
	}

	/** An existing live watcher re-rendered by a pass: its dedup bits re-arm at render. */
	renderWatcher(passId: PassId, watcherId: WatcherId): void {
		const p = this.pass(passId);
		if (p.state === 'ended') throw new ScheduleError('render requires an open pass');
		const w = this.watchers.get(watcherId);
		if (w === undefined || !w.live) throw new ScheduleError('render targets a live watcher');
		if (w.root !== p.root) throw new ScheduleError('watcher belongs to another root');
		w.dedup.clear();
		p.rendered.add(watcherId);
	}

	/** Mount a useSignalEffect-shaped observer with a single-node body. */
	mountReactEffect(rootId: RootId, node: AnyNode, name: string): ReactEffect {
		return this.mountCommittedObserver(rootId, name, (read) => void read(node));
	}

	/** Mount a committed observer whose body re-chooses deps CAUSALLY: it
	 * reads `sel` and, on its truthiness, reads `a` or `b` — the dep-flip
	 * family where snapshot mechanisms rot (plan amendment 4). */
	mountReactEffectPick(rootId: RootId, sel: AnyNode, a: AnyNode, b: AnyNode, name: string): ReactEffect {
		return this.mountCommittedObserver(rootId, name, (read) => void (read(sel) ? read(a) : read(b)));
	}

	/** The registration surface the constructors above configure. The initial
	 * run captures the first dep snapshot (runs stays 0 — the mount run is
	 * React's own effect invocation, not a re-fire). */
	mountCommittedObserver(rootId: RootId, name: string, body: (read: Reader) => void): ReactEffect {
		if (this.evalDepth > 0 || this.inFoldCallback) {
			throw new ScheduleError('effect registration is illegal inside an open evaluation/fold frame');
		}
		const e: ReactEffect = {
			id: this.nextEffect++, name, root: rootId, body,
			deps: [], lastValue: undefined, runs: 0, cleanups: 0,
		};
		this.root(rootId);
		this.captureReactEffectRun(e);
		this.reactEffects.set(e.id, e);
		return e;
	}

	/** Removal (unmount): cleanup is GUARANTEED; nothing runs after (RCC-OL2). */
	removeReactEffect(id: EffectId): void {
		const e = this.mustGet(this.reactEffects, id, 'react effect');
		e.cleanups++;
		this.log({ type: 'react-effect-cleanup', effect: e.name, root: e.root });
		this.reactEffects.delete(id);
	}

	/** StrictMode-style replay: cleanup + unconditional re-run (not value-
	 * gated), recapturing deps. Illegal while the effect's root has an open
	 * pass frame (React double-invokes effects post-commit, never mid-render). */
	replayReactEffect(id: EffectId): void {
		const e = this.mustGet(this.reactEffects, id, 'react effect');
		for (const p of this.passes.values()) {
			if (p.state !== 'ended' && p.root === e.root) {
				throw new ScheduleError('replay requires the effect root to have no open pass frame');
			}
		}
		this.runReactEffect(e);
	}

	/** Runs the body under committed-for-root read capture; installs the new
	 * dep snapshot. Reads inside a computed's own evaluation belong to the
	 * computed, not the effect (suppression is by construction: only the
	 * body's TOP-LEVEL reads reach this reader). */
	private captureReactEffectRun(e: ReactEffect): void {
		const deps: { node: AnyNode; value: Value }[] = [];
		const read: Reader = (n) => {
			const v = this.evaluate(n, { kind: 'committed', root: e.root });
			deps.push({ node: n, value: v });
			return v;
		};
		try {
			e.body(read);
		} finally {
			// A mid-body throw keeps the partial snapshot (the deps read before
			// the throw are real dependencies — same rule as the engine frame).
			e.deps = deps;
			e.lastValue = deps.length === 0 ? undefined : deps[deps.length - 1]!.value;
		}
	}

	/** Cleanup + re-run + recapture (the re-fire): logs both halves. */
	private runReactEffect(e: ReactEffect): void {
		e.cleanups++;
		this.log({ type: 'react-effect-cleanup', effect: e.name, root: e.root });
		this.captureReactEffectRun(e);
		e.runs++;
		this.log({
			type: 'react-effect-run', effect: e.name, root: e.root,
			value: e.lastValue, values: e.deps.map((d) => d.value),
		});
	}

	/**
	 * The EF2 boundary re-check: once per boundary OPERATION (never per
	 * locked-in token — one pass committing two batches re-checks once, at
	 * the boundary value), value-gated over each effect's dep snapshot,
	 * SKIPPING effects whose root has an open pass frame (an effect never
	 * runs ahead of its own root's screen; the deferred flip flushes when
	 * that frame closes). Runs at the END of the boundary operation.
	 */
	private revalidateReactEffects(rootFilter?: RootId): void {
		for (const e of [...this.reactEffects.values()]) {
			if (rootFilter !== undefined && e.root !== rootFilter) continue;
			let open = false;
			for (const p of this.passes.values()) {
				if (p.state !== 'ended' && p.root === e.root) { open = true; break; }
			}
			if (open) continue; // deferred to the frame's close
			let changed = false;
			for (const d of e.deps) {
				if (!Object.is(this.evaluate(d.node, { kind: 'committed', root: e.root }), d.value)) {
					changed = true;
					break;
				}
			}
			if (changed) this.runReactEffect(e);
		}
	}

	/** Mount a core effect() observer: it reads the newest world (sampled —
	 * the same value face `newestValue` serves). */
	mountCoreEffect(node: AnyNode, name: string): CoreEffect {
		const e: CoreEffect = {
			id: this.nextEffect++, name, node: node.id,
			lastValue: this.newestValue(node),
			runs: 0,
		};
		this.coreEffects.set(e.id, e);
		return e;
	}

	/**
	 * End a pass. The commit order is normative: (1) baseline capture (the
	 * committed-side counters the mount fast path compares against),
	 * (2) retirements due at this commit + the per-root commit table update,
	 * (3) notification of committed-state observers, (4) layout (newly
	 * mounted watchers subscribe, then reconcile). On discard, pass-owned
	 * mounts die with the discarded tree. Deferred slot releases re-evaluate
	 * at EVERY pass end, commit and discard alike — the pass that retained
	 * them is what just ended.
	 */
	passEnd(id: PassId, kind: 'commit' | 'discard', opts?: { retireAtCommit?: TokenId[] }): void {
		const p = this.pass(id);
		if (p.state === 'ended') throw new ScheduleError('pass already ended');
		if (kind === 'commit') {
			for (const tid of opts?.retireAtCommit ?? []) {
				const t = this.token(tid); // throws on unknown ids before any mutation
				if (!p.maskTokens.has(tid)) {
					throw new ScheduleError(`token ${tid} is not rendered by pass ${p.id}; its retirement cannot be due at this commit`);
				}
				if (t.state !== 'live' || t.parked) {
					throw new ScheduleError(`token ${tid} cannot retire at this commit (already retired, or parked)`);
				}
			}
		}
		p.state = 'ended';
		p.endKind = kind;
		if (kind === 'discard') {
			for (const wid of p.mounted) this.watchers.delete(wid); // never subscribed; the tree died
			this.log({ type: 'pass-discarded', pass: p.id, root: p.root });
			this.reevaluateDeferredReleases();
			// EF2: the frame close is the deferred flush point for boundaries
			// that occurred while this root's frame was open (committed truth
			// may already have moved via member writes / retirements the open
			// frame deferred) — the discard itself advances nothing.
			this.revalidateReactEffects(p.root);
			return;
		}
		// (1) Baseline capture at the commit's committed-side entry: the mount
		// fast path later asks "did committed truth move after my pin?" against
		// exactly these values.
		const baseline = { cas: this.cas, rootCommitGen: this.root(p.root).commitGen };
		// The committing tree's content: re-rendered watchers take this pass's
		// world values NOW — a watcher's "last rendered value" updates only at
		// committed renders, and it is the comparand every later
		// committed-truth reconciliation checks against.
		for (const wid of p.rendered) {
			const w = this.watchers.get(wid);
			if (w === undefined || p.mounted.includes(wid)) continue;
			w.lastRenderedValue = this.evaluate(this.nodeById(w.node), { kind: 'pass', pass: p });
			w.snapshot = {
				passId: p.id, pin: p.pin, maskSlots: new Set(p.maskSlots),
				includedSlots: this.includedSet(p), rootCommitGen: this.root(p.root).commitGen,
			};
		}
		// (2) Retirements due at this commit; then the per-root commit
		// (lock-in) of every still-live rendered token. A retirement is "due
		// at this commit" only for batches this pass rendered (validated
		// above): a foreign batch retires at its own closure, never inside
		// another pass's commit — folding it here would land AFTER this
		// commit's baseline capture and silently break the mount fast path's
		// accounting (see tests/FLAGS.md, the legality rule under flag 5).
		for (const tid of opts?.retireAtCommit ?? []) this.retireInternal(this.token(tid), true);
		for (const tid of p.maskTokens) {
			const t = this.token(tid);
			if (t.state !== 'live') continue; // fully retired above (or earlier): the retired clause subsumes membership
			const root = this.root(p.root);
			if (!root.committedTokens.has(tid)) {
				root.committedTokens.add(tid);
				root.commitGen++;
				this.cas = this.mintSeq(); // committed-advance: every per-root commit moves committed truth
				this.log({ type: 'per-root-commit', root: p.root, token: tid });
				// (3) Committed truth moved: reconcile this root's committed observers now.
				this.drainCommittedObservers(p.root, 'per-root-commit');
			}
		}
		// (4) Layout: newly mounted watchers subscribe, then reconcile — before paint.
		for (const wid of p.mounted) {
			const w = this.watchers.get(wid);
			if (w === undefined) continue;
			w.live = true;
			this.mountFixup(w, p, baseline);
		}
		this.log({ type: 'pass-committed', pass: p.id, root: p.root });
		this.reevaluateDeferredReleases();
		// EF2 boundary: ONE effect re-check per commit operation, at the
		// boundary value — a pass locking in two tokens re-checks once, not
		// per token (amendment 4's dedup rule). With retirements folded into
		// this commit, committed truth moved for every root, so the scan
		// widens to all roots (each still open-frame-deferred individually).
		this.revalidateReactEffects((opts?.retireAtCommit ?? []).length > 0 ? undefined : p.root);
	}

	/** A deferred slot release re-evaluates at every pass end, commit and discard alike. */
	private reevaluateDeferredReleases(): void {
		for (const s of this.slots) {
			if (!s.releasePending) continue;
			if (!this.slotRetainedByOpenMask(s.id)) this.releaseSlot(s);
		}
		// A pass ending releases its pin, which can unblock pin-gated compaction.
		this.compactAll();
	}

	private slotRetainedByOpenMask(slot: SlotId): boolean {
		for (const p of this.passes.values()) {
			if (p.state !== 'ended' && p.maskSlots.has(slot)) return true;
		}
		return false;
	}

	// ---------------------------------------------------------- retirement

	/** Retirement fires exactly once per token; parked action tokens retire only at settlement. */
	retire(tokenId: TokenId, committed: boolean): void {
		const t = this.token(tokenId);
		if (t.state === 'retired') throw new ScheduleError('retirement fires exactly once per token');
		if (t.parked) throw new ScheduleError('parked action tokens retire only at settlement');
		this.retireInternal(t, committed);
		// EF2 boundary: retirement is a guaranteed flush point for every root
		// (a write-free retirement still flushes pending member-write flips).
		this.revalidateReactEffects();
	}

	/** The async action's thenable settles; the host then retires the token. */
	settleAction(tokenId: TokenId, committed: boolean): void {
		const t = this.token(tokenId);
		if (!t.action) throw new ScheduleError('settle targets an action token');
		if (!t.parked || t.state !== 'live') throw new ScheduleError('action already settled');
		t.parked = false;
		this.retireInternal(t, committed);
		this.revalidateReactEffects(); // EF2 boundary: settlement is a guaranteed flush point
	}

	/**
	 * Retirement — the internal order is normative: stamp the receipts, fold
	 * (compaction), mint per-atom retirement stamps + advance the committed
	 * counter, reconcile committed observers, clear per-root membership
	 * rows, and only then release the slot (deferred if an open pass's
	 * render mask names it). The row-clear-before-release order guarantees a
	 * recycled slot can never impersonate a committed member. Abandoned
	 * (committed=false) batches retire through the same path — writes never
	 * silently revert, and persistence never depends on having subscribers.
	 */
	private retireInternal(t: Token, committed: boolean): void {
		t.state = 'retired';
		t.parked = false;
		const retiredSeq = this.mintSeq(); // one retirement sequence per retirement event
		t.retiredSeq = retiredSeq;
		const touched: AtomNode[] = [];
		for (const n of this.nodes.values()) {
			if (n.kind !== 'atom') continue;
			let hit = false;
			for (const e of n.tape) {
				if (e.token === t.id) {
					e.retiredSeq = retiredSeq;
					hit = true;
				}
			}
			if (hit) touched.push(n);
		}
		// Mint the retirement stamp per touched atom; advance the committed counter.
		for (const n of touched) n.retirementStamp = retiredSeq;
		if (touched.length > 0) this.cas = this.mintSeq();
		// Fold/compaction. Naive form: try every atom — a retirement can
		// unblock compactable prefixes anywhere.
		this.compactAll();
		this.log({ type: 'retired', token: t.id, committed, retiredSeq });
		// Committed truth flipped: reconcile watchers and revalidate effects
		// against it. The engine enumerates only the observers the slot
		// touched; the naive model checks every observer — corrections are
		// value-gated, so the fired set is identical (touched ⊇ changed).
		for (const rootId of this.roots.keys()) this.drainCommittedObservers(rootId, 'retirement');
		// Clear per-root committed-table rows (the retired-history rule now
		// subsumes membership), THEN release the slot unless an open render
		// mask names it — this order is what keeps recycled slots honest.
		for (const r of this.roots.values()) r.committedTokens.delete(t.id);
		if (t.slot !== undefined) {
			const slot = this.slots[t.slot]!;
			if (this.slotRetainedByOpenMask(slot.id)) {
				slot.releasePending = true; // re-evaluated at every pass end
			} else {
				this.releaseSlot(slot);
			}
		}
		if (this.ambientToken === t.id) this.ambientToken = undefined;
	}

	/**
	 * Compaction consumes a sequence-order prefix of the tape: entry e
	 * compacts iff every entry with seq ≤ e.seq is retired AND
	 * e.retiredSeq ≤ min(live pins) — i.e. every live world already sees the
	 * prefix via the retired-history rule, so folding it into the base can
	 * change no live world's answer. Compacted entries move to the archive
	 * so the retention invariant can re-derive every fold from full history.
	 */
	private compactAll(): void {
		for (const n of this.nodes.values()) {
			if (n.kind === 'atom') this.compactAtom(n);
		}
	}

	private compactAtom(atom: AtomNode): void {
		const minPin = this.minLivePin();
		let cut = 0;
		for (const e of atom.tape) {
			if (e.retiredSeq === undefined) break; // prefix clause: an unretired earlier entry blocks everything after it
			if (e.retiredSeq > minPin) break; // pin clause: every live pin must already see e via the retired clause
			cut++;
		}
		if (cut === 0) return;
		const folded = atom.tape.slice(0, cut);
		for (const e of folded) {
			const next = this.applyOp(atom, e.op, atom.base);
			if (!this.inCallback(() => atom.equals(next, atom.base))) atom.base = next;
			atom.baseSeq = e.seq;
			atom.archive.push(e);
		}
		atom.tape = atom.tape.slice(cut);
	}

	/**
	 * Reconciliation at a committed-truth flip (a retirement or a per-root
	 * commit): compare each live watcher's last rendered value against
	 * committed-for-root NOW and correct urgently, pre-paint, on a real
	 * difference. Comparing values is legal HERE — both sides are committed
	 * truth, one world — unlike live-write delivery, which is never
	 * value-gated because it would compare across worlds. Committed EFFECTS
	 * do NOT drain here: their re-check is once per boundary operation
	 * (revalidateReactEffects), not per flip — RCC-EF2's amended boundary
	 * semantics.
	 */
	private drainCommittedObservers(rootId: RootId, cause: 'retirement' | 'per-root-commit'): void {
		const world: World = { kind: 'committed', root: rootId };
		for (const w of this.watchers.values()) {
			if (!w.live || w.root !== rootId) continue;
			const now = this.evaluate(this.nodeById(w.node), world);
			if (!Object.is(now, w.lastRenderedValue)) {
				this.log({ type: 'reconcile-correction', watcher: w.name, root: rootId, from: w.lastRenderedValue, to: now, cause });
				w.lastRenderedValue = now; // the urgent pre-paint re-render
				w.dedup.clear(); // dedup bits re-arm at the watcher's render
			}
		}
	}

	// ---------------------------------------------------------- mount fixup

	/**
	 * Mount reconciliation — runs in the mounting component's layout effect
	 * (after subscription, before paint). A component can mount while other
	 * updates are in flight, and its subscription activates only now, so
	 * writes could have slipped by between its render and this moment. Two
	 * mechanisms close the window: value-blind correctives join the mount to
	 * each live non-included batch that touched its node (so it rides those
	 * pending updates rather than missing or revealing them), and one
	 * comparison against the mount's own world fast-forwarded to
	 * committed-now catches whatever retired or locked in during the window.
	 */
	private mountFixup(w: Watcher, committingPass: Pass, baseline: { cas: number; rootCommitGen: number }): void {
		const node = this.nodeById(w.node);
		this.refreshEdgesAllWorlds();
		const closure = this.dependencyClosureOf(w.node);
		// Per-token corrective loop: every LIVE written token that touched the node.
		const correctedLive = new Set<TokenId>();
		for (const t of this.tokens.values()) {
			if (t.state !== 'live' || t.slot === undefined) continue;
			if (!this.tokenTouches(t, closure)) continue;
			const slot = this.slots[t.slot]!;
			// Fully included (slot in the render's included set AND no post-pin
			// write in it): the render already folded everything — skip. The skip
			// is by inclusion + clocks, never by comparing values.
			if (w.snapshot.includedSlots.has(slot.id) && slot.writeClock <= w.snapshot.pin) continue;
			this.log({ type: 'mount-corrective', watcher: w.name, token: t.id, slot: slot.id });
			correctedLive.add(t.id);
			w.dedup.add(slot.id); // the corrective is a re-render scheduled into t's own lane
		}
		// The fast path: skip the comparison when four conditions show the
		// mount window was quiet — (0) the mounting pass is the committing
		// pass, (1) no committed-side advance since the pin, (2) the root's
		// commit generation is unchanged, (3) no included batch wrote after
		// the pin. Over-firing (comparing unnecessarily) is safe;
		// under-firing would be a missed correction, i.e. a tear.
		//
		// SUBTLE (found by fuzzing; explained in tests/FLAGS.md under flag 5,
		// finding 2): condition (3) must NOT quantify only over the slot set
		// captured at pass start. A rendered batch whose FIRST write lands
		// mid-pass interned its slot after that capture, making the captured
		// check vacuous for it — yet this commit locks the batch in and the
		// fast-forwarded world folds the post-pin write. The model therefore
		// also checks the committing pass's rendered TOKENS at commit time
		// (their latest write seq vs the pin).
		const clocksQuiet =
			[...w.snapshot.maskSlots].every((s) => this.slots[s]!.writeClock <= w.snapshot.pin) &&
			[...committingPass.maskTokens].every((tid) => {
				const t = this.token(tid);
				return t.lastWriteSeq === 0 || t.lastWriteSeq <= w.snapshot.pin;
			});
		const fastOut =
			w.snapshot.passId === committingPass.id &&
			baseline.cas <= w.snapshot.pin &&
			baseline.rootCommitGen === w.snapshot.rootCommitGen &&
			clocksQuiet;
		const vFx = this.evaluate(node, {
			kind: 'mountFix', maskSlots: w.snapshot.maskSlots, pin: w.snapshot.pin, root: w.root,
		});
		if (fastOut) {
			if (!Object.is(vFx, w.lastRenderedValue)) {
				// SOUNDNESS AUDIT (tests/FLAGS.md, flag 5 finding 3): a live token
				// already committed into this root can write after the pass
				// pinned (an async action's late scoped write). No fast-path
				// condition observes that write — committed-advance, commit
				// generation, and mask clocks are all silent — so the
				// fast-forwarded value moves while the fast path holds. It is
				// NOT a tear only because the corrective loop above scheduled
				// that token's re-render in its own lane. The sound invariant,
				// asserted here on every mount: divergence hidden by the fast
				// path must be exactly covered by scheduled correctives. The
				// audit world keeps what the render itself saw of the excluded
				// tokens: its full included set at its pin (widening the mask
				// set to includedSlots is inert for everyone else —
				// captured-committed receipts are already visible as retired
				// history or by membership, and a recycled slot's new tenant
				// postdates the pin by the claim-ordering rule).
				const vCovered = this.evaluate(node, {
					kind: 'mountFix', maskSlots: w.snapshot.includedSlots, pin: w.snapshot.pin,
					root: w.root, excludeLiveTokens: correctedLive,
				});
				if (!Object.is(vCovered, w.lastRenderedValue)) {
					throw new InvariantViolation(
						`fast-out unsound: watcher ${w.name} fast-out held but the fixup value ${String(vFx)} differs from the rendered value ${String(w.lastRenderedValue)} and the residue is not covered by the scheduled correctives`,
					);
				}
			}
			return; // zero corrections — anything the fast path hides is already corrective-covered
		}
		if (!Object.is(vFx, w.lastRenderedValue)) {
			this.log({ type: 'mount-urgent-correction', watcher: w.name, from: w.lastRenderedValue, to: vFx });
			w.lastRenderedValue = vFx; // urgent pre-paint correction
			w.dedup.clear();
		}
	}

	/** Transitive dependency closure (atoms + computeds) feeding a node, over the accumulated union graph. */
	dependencyClosureOf(nodeId: NodeId): Set<NodeId> {
		const closure = new Set<NodeId>([nodeId]);
		let grew = true;
		while (grew) {
			grew = false;
			for (const [dep, outs] of this.episodeEdges) {
				if (closure.has(dep)) continue;
				for (const out of outs) {
					if (closure.has(out)) {
						closure.add(dep);
						grew = true;
						break;
					}
				}
			}
		}
		return closure;
	}

	private tokenTouches(t: Token, closure: Set<NodeId>): boolean {
		for (const n of this.nodes.values()) {
			if (n.kind !== 'atom' || !closure.has(n.id)) continue;
			for (const e of n.tape) if (e.token === t.id) return true;
		}
		return false;
	}

	// ------------------------------------------- episodes and quiescence

	/** Synchronously abandons every work-in-progress pass on every root (a host capability). */
	discardAllWip(): void {
		for (const p of this.passes.values()) {
			if (p.state !== 'ended') this.passEnd(p.id, 'discard');
		}
	}

	quiescent(): boolean {
		return this.liveTokens().length === 0 && this.livePins().length === 0;
	}

	/**
	 * Quiescence (no live tokens, no live pins, no parked actions): the
	 * per-episode dependency edges bulk-reset (epoch bump). Retained
	 * sequence values are NOT rewritten — sequences are plain JS numbers,
	 * exact to 2^53, and only ever compared, so the counter simply keeps
	 * climbing across episodes (renumbering was measured within noise on
	 * tape-heavy shapes and deleted; grind batch 4, item C). Token serials
	 * were always a separate, never-renumbered domain. The model has no
	 * caches to refresh afterward — delivery reachability is recomputed from
	 * scratch at every write, which is the refreshed state by construction.
	 */
	quiesce(): void {
		if (!this.quiescent()) throw new ScheduleError('quiescence requires no live tokens, pins, or parked actions');
		// Residue check: with no live pins, the last retirement compacted every tape.
		for (const n of this.nodes.values()) {
			if (n.kind === 'atom' && n.tape.length > 0) {
				throw new InvariantViolation(`quiescence residue: atom ${n.name} still holds ${n.tape.length} receipts`);
			}
		}
		this.episodeEdges.clear();
		this.epoch++;
		// Dead-episode records drop at the reset: ended passes and retired
		// tokens belong to the dead episode, and nothing from a dead episode
		// may validate anything in a live one. Id counters stay monotone
		// across episodes.
		for (const [id, p] of this.passes) {
			if (p.state === 'ended') this.passes.delete(id);
		}
		for (const [id, t] of this.tokens) {
			if (t.state === 'retired') this.tokens.delete(id);
		}
		for (const n of this.nodes.values()) {
			if (n.kind !== 'atom') continue;
			// The archive belongs to the dead episode; it exists only for the
			// retention invariant, whose comparisons are per-episode. Clear it.
			n.archive = [];
			n.origin = n.base;
		}
		// Dead-episode bookkeeping bulk-zeroes at the episode reset.
		for (const s of this.slots) {
			s.writeClock = 0;
			s.claimSeq = 0;
			s.releasePending = false;
		}
		for (const w of this.watchers.values()) w.dedup.clear();
		this.log({ type: 'epoch-reset', epoch: this.epoch });
	}

	// ------------------------------------------------------------ helpers

	/** Convenience: the value of a node in a named world (test surface). */
	read(node: AnyNode, world: World): Value {
		return this.evaluate(node, world);
	}

	committedValue(node: AnyNode, root: RootId): Value {
		return this.evaluate(node, { kind: 'committed', root });
	}

	/** The newest value: atoms fold; computeds serve the sampled-untracked
	 * cache [ruling 2026-07-06: untracked sampling] — see `newestSamples`. */
	newestValue(node: AnyNode): Value {
		if (node.kind === 'atom') return this.evaluate(node, { kind: 'newest' });
		return this.sampledNewest(node);
	}

	/**
	 * Serve-or-derive under the sampling rule. Validation is value identity
	 * over the recorded tracked deps, each resolved at ITS sampled-newest
	 * value (recursion mirrors the kernel's checkDirty descent, including the
	 * equality-cutoff behavior: a tracked dep whose own re-derivation folded
	 * back to an identical value invalidates nothing above it). A derivation
	 * runs the fn once with readers that resolve BOTH read kinds at
	 * sampled-newest values — the untracked reads ARE the point-in-time
	 * samples; only tracked reads enter the fingerprint (and the episode's
	 * union edge graph, as every model evaluation's tracked reads do).
	 */
	private sampledNewest(node: ComputedNode): Value {
		const cached = this.newestSamples.get(node.id);
		if (cached !== undefined) {
			let valid = true;
			for (const d of cached.deps) {
				if (!Object.is(this.newestValue(d.node), d.value)) {
					valid = false;
					break;
				}
			}
			if (valid) return cached.value;
		}
		if (this.inFoldCallback) throw new ScheduleError('signal read inside an updater/reducer fold — updaters and reducers must be pure; read what you need before dispatching');
		if (this.samplingStack.has(node.id)) {
			throw new ScheduleError(`cyclic evaluation of ${node.name} within one world — a computed may not depend on itself`);
		}
		this.samplingStack.add(node.id);
		this.evalDepth++;
		const deps: { node: AnyNode; value: Value }[] = [];
		try {
			const read: Reader = (dep) => {
				this.recordEdge(dep.id, node.id);
				const v = this.newestValue(dep);
				deps.push({ node: dep, value: v });
				return v;
			};
			const untracked: Reader = (dep) => this.newestValue(dep);
			const value = node.fn(read, untracked);
			this.newestSamples.set(node.id, { deps, value });
			return value;
		} finally {
			this.evalDepth--;
			this.samplingStack.delete(node.id);
		}
	}

	passValue(node: AnyNode, pass: Pass): Value {
		return this.evaluate(node, { kind: 'pass', pass });
	}

	eventsOfType<T extends ModelEvent['type']>(type: T): Extract<ModelEvent, { type: T }>[] {
		return this.events.filter((e): e is Extract<ModelEvent, { type: T }> => e.type === type);
	}

	/** Events appended after a caller-captured watermark (test surface). */
	eventsSince(mark: number): ModelEvent[] {
		return this.events.slice(mark);
	}
}
