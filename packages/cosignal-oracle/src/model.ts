/**
 * The naive reference model ("oracle") for cosignal v1.
 *
 * Spec: spec/cosignal-v1.md. Every rule cites its section in a comment.
 *
 * Authority comes from SIMPLICITY: plain objects, no caches, no cleverness.
 * Worlds are pure folds over visibility-filtered receipt tapes (§5.3);
 * computeds are memo-free recursive evaluation in a given world; the fork
 * is simulated as explicit token/pass/retirement bookkeeping (§4). Where
 * the engine has optimizations (touched words, memo ladders, fast paths)
 * the model simply recomputes everything, so any engine behavior those
 * optimizations change is a bug in the engine, not in the model.
 */

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
 * §2 "receipt / tape" — {op, slot, seq} appended per write. retiredSeq is
 * stamped at the batch's retirement (§5.3 retirement step 2). The token is
 * carried for invariant checking and event logs only: folds resolve
 * visibility through slot+seq exactly as the spec's clauses do (§5.3), so
 * slot-recycling aliasing is exercised honestly (§5.4 tenancy lemma).
 */
export type Receipt = {
	op: Op;
	token: TokenId;
	slot: SlotId;
	seq: number;
	retiredSeq: number | undefined;
};

export type Equals = (a: Value, b: Value) => boolean;
export type Reducer = (state: Value, action: Value) => Value;

export type AtomNode = {
	kind: 'atom';
	id: NodeId;
	name: string;
	/** §2 "base": the folded floor of the tape (committed + compacted). */
	base: Value;
	baseSeq: number;
	tape: Receipt[];
	/** Full history for invariant 4 (receipt-retention soundness): compacted receipts move here. */
	archive: Receipt[];
	/** The value the atom was created with (shadow-fold origin). */
	origin: Value;
	equals: Equals;
	/** §5.13 — reducer fixed at creation; undefined for plain atoms. */
	reducer: Reducer | undefined;
	/** §5.7 — per-atom retirement stamp, minted at every retirement fold touching it. */
	retirementStamp: number;
};

/** Reader passed to computed functions; tracked reads record edges, untracked do not (§3.1, §5.5). */
export type Reader = (node: AnyNode) => Value;
export type ComputedFn = (read: Reader, untracked: Reader) => Value;

export type ComputedNode = {
	kind: 'computed';
	id: NodeId;
	name: string;
	/** §3.3 — a node's evaluating function is immutable for the node's whole life. */
	fn: ComputedFn;
};

export type AnyNode = AtomNode | ComputedNode;

export type Token = {
	id: TokenId;
	priority: Priority;
	/** §3.5 — async action; parked tokens retire only at settlement (§4.1 fact 3). */
	action: boolean;
	parked: boolean;
	state: 'live' | 'retired';
	committedFlag: boolean | undefined;
	slot: SlotId | undefined;
	retiredSeq: number | undefined;
	/** seqs of receipts minted by this token (tenancy invariants). */
	writeSeqs: number[];
	/** True for the model's auto-minted ambient default batch (§3.5). */
	ambient: boolean;
};

/** §5.4 — the 31-slot interning table entry. */
export type SlotMeta = {
	id: SlotId;
	tenant: TokenId | undefined;
	/** seq minted at claim — the tenancy lemma's claim(Y) (§5.4). */
	claimSeq: number;
	/** §2 "write clock", in sequence units: seq of the slot's last write. Zeroed at re-intern (§5.4). */
	writeClock: number;
	/** §5.4 disposal — carried max retirement sequence (dirt watermark; renumber duty §5.12). */
	carriedMaxRetiredSeq: number;
	/** Retirement done but release deferred because an open pass's render mask names the slot (§5.4). */
	releasePending: boolean;
};

export type PassState = 'open' | 'yielded' | 'ended';

export type Pass = {
	id: PassId;
	root: RootId;
	/** §2 "pin" — global sequence frozen at pass start; observed forever, across yields. */
	pin: number;
	/** §5.3 — render mask, captured from live tokens at pass start. */
	maskTokens: Set<TokenId>;
	maskSlots: Set<SlotId>;
	/** §5.3 — the root's committed-batch slot set snapshotted at pass start. */
	capturedCommittedSlots: Set<SlotId>;
	state: PassState;
	endKind: 'commit' | 'discard' | undefined;
	/** Watchers first mounted by this pass (subscribe+fixup at its commit, §5.10/§5.11). */
	mounted: WatcherId[];
	/** Existing watchers re-rendered by this pass (lastRenderedValue updates at commit, §5.11). */
	rendered: Set<WatcherId>;
};

export type RootState = {
	id: RootId;
	/** §5.3 per-root commit (lock-in) table: rows exist for live tokens only (cleared at retirement). */
	committedTokens: Set<TokenId>;
	/** §5.3 — root commit generation; bumped at every per-root commit. */
	commitGen: number;
};

/** §5.10 — the watcher's rendered-world snapshot w_r. */
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
	/** Subscribed at its mounting pass's commit ("subscribe at layout", §5.11). */
	live: boolean;
	lastRenderedValue: Value;
	snapshot: WatcherSnapshot;
	/** §5.9 — per-(watcher, slot) delivery dedup bits. */
	dedup: Set<SlotId>;
};

/** §3.2 useSignalEffect — observes committed-for-root only (§5.11). */
export type ReactEffect = {
	id: EffectId;
	name: string;
	root: RootId;
	node: NodeId;
	lastValue: Value;
	runs: number;
};

/** §3.1 core effect() — observes the newest world (§5.11). */
export type CoreEffect = {
	id: EffectId;
	name: string;
	node: NodeId;
	lastValue: Value;
	runs: number;
};

/** §2 "world" — one self-consistent assignment of values to all atoms. */
export type World =
	| { kind: 'newest' }
	| { kind: 'pass'; pass: Pass }
	| { kind: 'committed'; root: RootId }
	/**
	 * §5.10 — the mount fixup's fast-forwarded world w_fx. `excludeLiveTokens`
	 * is the model's flag-5 audit instrument: receipts of those (live) tokens
	 * stay visible only through the mask clause, subtracting exactly the
	 * divergence the per-token corrective loop already scheduled corrections
	 * for (see mountFixup and tests/FLAGS.md).
	 */
	| { kind: 'mountFix'; maskSlots: Set<SlotId>; pin: number; root: RootId; excludeLiveTokens?: Set<TokenId> };

/** The observable surface — what a future engine must reproduce (README adapter contract). */
export type ModelEvent =
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

/** An op the schedule proposed that is illegal in the current state (generator skips these). */
export class ScheduleError extends Error {}
/** A model self-check failed — always a bug (in the model or in the spec reading). */
export class InvariantViolation extends Error {}

const SLOT_COUNT = 31; // §2 "token": at most 31 live batches (one per React lane).

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

	/** §5.1 — DIRECT until registerReactBridge(); direct writes leave no receipts. */
	mode: 'direct' | 'logged' = 'direct';
	/** The one global sequence line (§2). */
	seq = 0;
	/** §2 committed-advance counter, in sequence units (seq of last committed-side advance). */
	cas = 0;
	/** §2 episode/epoch. */
	epoch = 0;
	/** §5.5 — accumulated dependency edges this episode (K0∪K1 union, add-only; reset at quiescence). */
	episodeEdges = new Map<NodeId, Set<NodeId>>(); // dep -> dependents

	/** Ambient default batch for bare (context-free) writes (§3.5). */
	ambientToken: TokenId | undefined;

	private nextNode = 1;
	private nextToken = 1;
	private nextPass = 1;
	private nextWatcher = 1;
	private nextEffect = 1;

	/** Purity frames (§3.1/§3.6): >0 while a world evaluation or fold is on stack. */
	private evalDepth = 0;
	/** True while inside an updater/reducer/equals callback (reads+writes throw). */
	private inFoldCallback = false;

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
		}
	}

	private log(e: ModelEvent): void {
		this.events.push(e);
	}

	private mintSeq(): number {
		return ++this.seq;
	}

	// ---------------------------------------------------------------- setup

	/** §3.2/§5.1 — activates LOGGED mode, once, monotonically; throws inside open frames. */
	registerBridge(): void {
		if (this.evalDepth > 0 || this.inFoldCallback) {
			throw new ScheduleError('registerReactBridge inside an open evaluation/fold frame (§3.6)');
		}
		if (this.mode === 'logged') throw new ScheduleError('bridge already registered (§3.2: once)');
		this.mode = 'logged';
	}

	atom(name: string, initial: Value, equals?: Equals): AtomNode {
		const node: AtomNode = {
			kind: 'atom', id: this.nextNode++, name,
			base: initial, baseSeq: 0, tape: [], archive: [], origin: initial,
			equals: equals ?? Object.is, reducer: undefined, retirementStamp: 0,
		};
		this.nodes.set(node.id, node);
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

	/** §5.3 — the pass's included set = mask ∪ capturedCommitted. */
	includedSet(pass: Pass): Set<SlotId> {
		return new Set([...pass.maskSlots, ...pass.capturedCommittedSlots]);
	}

	/** The root's CURRENT committed-slot set (live committed tokens' slots; retired rows cleared, §5.3). */
	committedSlotsNow(rootId: RootId): Set<SlotId> {
		const out = new Set<SlotId>();
		for (const t of this.root(rootId).committedTokens) {
			const tok = this.tokens.get(t);
			if (tok !== undefined && tok.slot !== undefined) out.add(tok.slot);
		}
		return out;
	}

	/**
	 * The visibility rule. Pass worlds: §5.3's two clauses. Committed-for-root:
	 * retired-at-now ∨ membership. Newest: everything (K0 applies writes
	 * eagerly, §5.2). Mount fixup world w_fx: §5.10's three clauses.
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
				if (world.excludeLiveTokens?.has(e.token)) return false; // corrective-covered live divergence (audit only)
				if (e.retiredSeq !== undefined) return true; // committed truth at NOW
				return this.committedSlotsNow(world.root).has(e.slot); // the root's CURRENT committed set
			}
		}
	}

	/** Runs a user callback (updater/reducer/equals) under the fold-purity guard (§3.1: reads/writes throw). */
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
				if (reducer === undefined) throw new ScheduleError(`dispatch on non-reducer atom ${atom.name}`);
				return this.inCallback(() => reducer(prev, op.action));
			}
		}
	}

	/**
	 * §5.3 fold — replay visible entries over base in sequence order with
	 * stepwise equality (an equal step keeps the old reference).
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

	/** Invariant 4 helper: the same fold over the FULL history (archive + tape) from the origin value. */
	shadowFoldAtom(atom: AtomNode, world: World): Value {
		let value = atom.origin;
		for (const e of [...atom.archive, ...atom.tape]) {
			if (e.retiredSeq === undefined && !this.visible(e, world)) continue;
			// Archived (compacted) entries are visible to every live world by the
			// compaction predicate (§5.3: retiredSeq ≤ min live pins) — assert via visible() too.
			if (!this.visible(e, world)) continue;
			const next = this.applyOp(atom, e.op, value);
			if (!this.inCallback(() => atom.equals(next, value))) value = next;
		}
		return value;
	}

	/**
	 * Memo-free recursive evaluation of a node in a world. Tracked reads
	 * record real dependency edges (the model's K0∪K1 union plane, §5.5);
	 * untracked reads fold in-world, edge-free (§5.5: temporal staleness is
	 * licensed, world leakage is not — in a fold-everything model the
	 * in-world fold is the whole story). Writes throw (§5.6); per-world
	 * cycles throw (§3.6).
	 */
	evaluate(node: AnyNode, world: World, stack?: Set<NodeId>): Value {
		if (this.inFoldCallback) throw new ScheduleError('signal read inside an updater/reducer fold (§3.1)');
		if (node.kind === 'atom') return this.foldAtom(node, world);
		const seen = stack ?? new Set<NodeId>();
		if (seen.has(node.id)) throw new ScheduleError(`cyclic evaluation of ${node.name} within one world (§3.6)`);
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
	 * Delivery reachability (§5.3 step 5, §5.9): the engine walks K0∪K1 —
	 * newest-basis edges plus every world-recorded edge (add-only within an
	 * episode; kernel edge drops are mirrored while receipts live, §5.5).
	 * The naive equivalent: evaluate every node in every currently relevant
	 * world (recording real edges), then take reachability over the
	 * episode-accumulated union. Conservative in exactly the way the spec's
	 * union graph is (over-notification is priced, never wrong — case 1 V2).
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

	/** §4.1 fact 1 — mint a batch token. At most 31 live (one per React lane). */
	openBatch(priority: Priority, opts?: { action?: boolean; ambient?: boolean }): Token {
		if (this.mode !== 'logged') throw new ScheduleError('batches exist only in LOGGED mode (§5.1)');
		if (this.liveTokens().length >= SLOT_COUNT) {
			throw new ScheduleError('at most 31 live tokens (§4.1 fact 1 invariant)');
		}
		const token: Token = {
			id: this.nextToken++, priority,
			action: opts?.action ?? false,
			parked: opts?.action ?? false, // §4.1 fact 3: action tokens park until settlement
			state: 'live', committedFlag: undefined, slot: undefined,
			retiredSeq: undefined, writeSeqs: [], ambient: opts?.ambient ?? false,
		};
		this.tokens.set(token.id, token);
		return token;
	}

	private token(id: TokenId): Token {
		const t = this.tokens.get(id);
		if (t === undefined) throw new ScheduleError(`unknown token ${id}`);
		return t;
	}

	nodeById(id: NodeId): AnyNode {
		const n = this.nodes.get(id);
		if (n === undefined) throw new ScheduleError(`unknown node ${id}`);
		return n;
	}

	/**
	 * §5.3 write step 1 — intern the token's slot, claiming a free one if new.
	 * Claim housekeeping (§5.4): write clock zeroes; per-(watcher, slot) dedup
	 * bits clear (§5.9); dirt watermark carries forward (the model has no
	 * dirt — routing is recomputed — but the watermark is kept because it is
	 * on the renumber duty list, §5.12).
	 */
	private internSlot(token: Token): SlotMeta {
		if (token.slot !== undefined) return this.slots[token.slot]!;
		let free = this.slots.find((s) => s.tenant === undefined);
		if (free === undefined) {
			// §5.4 backstop: release the oldest mask-retained retired slot anyway, loudly.
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
		free.claimSeq = this.mintSeq(); // tenancy ordering: claim-after-release gets its own point on the line (§5.4)
		free.writeClock = 0;
		free.releasePending = false;
		token.slot = free.id;
		for (const w of this.watchers.values()) w.dedup.delete(free.id); // §5.9 dedup clear at re-intern
		this.log({ type: 'slot-claimed', slot: free.id, token: token.id });
		return free;
	}

	private releaseSlot(slot: SlotMeta): void {
		const tenant = slot.tenant === undefined ? undefined : this.token(slot.tenant);
		if (tenant !== undefined) {
			slot.carriedMaxRetiredSeq = Math.max(slot.carriedMaxRetiredSeq, tenant.retiredSeq ?? 0);
			tenant.slot = undefined; // identity release; receipts keep their denormalized slot field (§5.4)
			this.log({ type: 'slot-released', slot: slot.id, token: tenant.id });
		}
		slot.tenant = undefined;
		slot.releasePending = false;
	}

	// ------------------------------------------------------ the write path

	/** §3.5 — a write belongs to the batch context in which it executes; bare writes go ambient (default). */
	bareWrite(node: AtomNode, op: Op): void {
		let ambient = this.ambientToken === undefined ? undefined : this.tokens.get(this.ambientToken);
		if (ambient === undefined || ambient.state !== 'live') {
			ambient = this.openBatch('default', { ambient: true });
			this.ambientToken = ambient.id;
		}
		// §3.5 dev warning heuristic: bare-context write while at least one action is pending.
		if (this.liveTokens().some((t) => t.parked)) {
			this.log({ type: 'dev-warning', message: 'a signal write after await landed outside the action — wrap it in startTransition or use the action scope (§3.5)' });
		}
		this.write(ambient.id, node, op);
	}

	/** §3.2 ActionScope — classifies into the action's token explicitly; throws after settlement. */
	scopeWrite(tokenId: TokenId, node: AtomNode, op: Op): void {
		const t = this.token(tokenId);
		if (!t.action) throw new ScheduleError('scope writes require an action token (§3.2)');
		if (t.state !== 'live') throw new ScheduleError('ActionScope closed (§3.6)');
		this.write(tokenId, node, op);
	}

	/**
	 * §5.3 — the write path (LOGGED). DIRECT writes mutate the base with no
	 * receipt (§5.1: DIRECT-era state is legal committed-only LOGGED state).
	 */
	write(tokenId: TokenId | undefined, node: AtomNode, op: Op): void {
		if (this.evalDepth > 0) throw new ScheduleError('signal write during a world evaluation / render (§3.6)');
		if (this.inFoldCallback) throw new ScheduleError('signal write inside an updater/reducer fold (§3.1)');
		if (node.kind !== 'atom') throw new ScheduleError('writes target atoms');
		if (this.mode === 'direct') {
			const next = this.applyOp(node, op, node.base);
			if (!this.inCallback(() => node.equals(next, node.base))) {
				node.base = next;
				node.origin = next; // pre-LOGGED history is the base case: committed-only state (§5.1)
			}
			this.flushCoreEffects();
			return;
		}
		if (tokenId === undefined) {
			this.bareWrite(node, op);
			return;
		}
		const token = this.token(tokenId);
		if (token.state !== 'live') throw new ScheduleError(`write into retired token ${tokenId} (§4.1 fact 4 fallback is fork scope)`);

		// §5.3 step 2 — drop check: empty tape AND op evaluates equal against base.
		if (node.tape.length === 0) {
			const evaluated = this.applyOp(node, op, node.base);
			if (this.inCallback(() => node.equals(evaluated, node.base))) {
				this.log({ type: 'write-dropped', node: node.name, token: tokenId });
				return;
			}
		}

		// §5.3 step 1/3 — intern slot, append receipt, bump the slot write clock.
		const slot = this.internSlot(token);
		const seq = this.mintSeq();
		node.tape.push({ op, token: token.id, slot: slot.id, seq, retiredSeq: undefined });
		token.writeSeqs.push(seq);
		slot.writeClock = seq;
		this.log({ type: 'write', node: node.name, token: token.id, slot: slot.id, seq });

		// §5.3 steps 4–5 — marking + delivery. The model recomputes the union
		// graph (edges recorded by evaluation) and reaches watchers/effects.
		this.refreshEdgesAllWorlds();
		const reached = this.reachableFrom(node.id);
		for (const w of this.watchers.values()) {
			if (!w.live || !reached.has(w.node)) continue;
			this.deliver(w, token, slot, seq);
		}
		this.flushCoreEffects(reached);
	}

	/**
	 * §5.9 delivery — per-write, value-blind, in the writer's stack. The
	 * per-(watcher, slot) dedup bit suppresses only when scheduled-but-
	 * unstarted work will fold the write; pass-aware rule otherwise delivers
	 * an interleaved update.
	 */
	private deliver(w: Watcher, token: Token, slot: SlotMeta, seq: number): void {
		if (!w.dedup.has(slot.id)) {
			w.dedup.add(slot.id);
			this.log({ type: 'delivery', watcher: w.name, token: token.id, slot: slot.id, seq, mode: 'fresh' });
			return;
		}
		// Bit already set: suppress iff NO started-and-uncommitted pass on W's
		// root includes s (render mask) with pin < the write's sequence (§5.9).
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

	/** §5.11 — core effects observe the newest world; flush after the write's walk returns. */
	private flushCoreEffects(reached?: Set<NodeId>): void {
		for (const e of this.coreEffects.values()) {
			if (reached !== undefined && !reached.has(e.node)) continue;
			const value = this.evaluate(this.nodeById(e.node), { kind: 'newest' });
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
		for (const p of this.passes.values()) {
			if (p.state !== 'ended' && p.root === rootId) {
				throw new ScheduleError(`root ${rootId} already has an open pass (§4.1 fact 2)`);
			}
		}
		const maskTokens = new Set<TokenId>();
		const maskSlots = new Set<SlotId>();
		for (const id of includeTokens) {
			const t = this.token(id);
			if (t.state !== 'live') throw new ScheduleError('mask captures live tokens only (§5.4)');
			maskTokens.add(id);
			// A live token with no slot never wrote; its later receipts postdate the pin
			// and are clause-2-excluded anyway (§5.4 pin/seq-after-claim).
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
		const p = this.passes.get(id);
		if (p === undefined) throw new ScheduleError(`unknown pass ${id}`);
		return p;
	}

	/** §4.1 fact 2 — yield/resume edges; handlers in the gap are "not in render" (per-callstack truth). */
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

	/** §5.10 — mount a new watcher inside an open pass; renders in the pass's world. */
	mountWatcher(passId: PassId, node: AnyNode, name: string): Watcher {
		const p = this.pass(passId);
		if (p.state === 'ended') throw new ScheduleError('mount requires an open pass');
		const value = this.evaluate(node, { kind: 'pass', pass: p });
		const watcher: Watcher = {
			id: this.nextWatcher++, name, root: p.root, node: node.id,
			live: false, // subscribes at layout, i.e. at this pass's commit (§5.11)
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
	 * Reveal-shaped mounts (§5.10 "Offscreen/Activity reveal", scar S42): a
	 * watcher rendered by an older pass whose layout effects fire inside a
	 * DIFFERENT pass's commit. The adopting commit runs the fixup; the
	 * watcher's snapshot keeps its original rendered world, so the fast-out's
	 * pass-id conjunct fails and the conservative compare runs.
	 */
	/** The hidden half of a reveal: the mounting pass commits but the watcher's
	 * layout effects (subscribe + fixup) defer — an Offscreen/Activity subtree. */
	deferMount(watcherId: WatcherId): void {
		for (const p of this.passes.values()) {
			const i = p.mounted.indexOf(watcherId);
			if (i >= 0) p.mounted.splice(i, 1);
		}
	}

	adoptMount(passId: PassId, watcherId: WatcherId): void {
		const adopter = this.pass(passId);
		if (adopter.state === 'ended') throw new ScheduleError('adopting pass must be open');
		const w = this.watchers.get(watcherId);
		if (w === undefined) throw new ScheduleError('unknown watcher');
		if (w.root !== adopter.root) throw new ScheduleError('reveal stays on the watcher root');
		for (const p of this.passes.values()) {
			const i = p.mounted.indexOf(watcherId);
			if (i >= 0) p.mounted.splice(i, 1);
		}
		adopter.mounted.push(watcherId);
	}

	/** An existing live watcher re-rendered by a pass: dedup bits re-arm at render (§5.9). */
	renderWatcher(passId: PassId, watcherId: WatcherId): void {
		const p = this.pass(passId);
		if (p.state === 'ended') throw new ScheduleError('render requires an open pass');
		const w = this.watchers.get(watcherId);
		if (w === undefined || !w.live) throw new ScheduleError('render targets a live watcher');
		if (w.root !== p.root) throw new ScheduleError('watcher belongs to another root');
		w.dedup.clear();
		p.rendered.add(watcherId);
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
		return e;
	}

	/** §3.1 core effect() — newest-world observer (§5.11). */
	mountCoreEffect(node: AnyNode, name: string): CoreEffect {
		const e: CoreEffect = {
			id: this.nextEffect++, name, node: node.id,
			lastValue: this.evaluate(node, { kind: 'newest' }),
			runs: 0,
		};
		this.coreEffects.set(e.id, e);
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
		if (p.state === 'ended') throw new ScheduleError('pass already ended');
		if (kind === 'commit') {
			for (const tid of opts?.retireAtCommit ?? []) {
				const t = this.token(tid); // throws on unknown ids before any mutation
				if (!p.maskTokens.has(tid)) {
					throw new ScheduleError(`token ${tid} is not rendered by pass ${p.id}; its retirement cannot be due at this commit (§4.2)`);
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
			return;
		}
		// (1) §4.2 baseline capture at the commit's committed-side entry.
		const baseline = { cas: this.cas, rootCommitGen: this.root(p.root).commitGen };
		// The committing tree's content: re-rendered watchers take this pass's
		// world values NOW — §5.11's "last rendered value updates only at
		// committed renders", and the comparator §4.2's drains reconcile against.
		for (const wid of p.rendered) {
			const w = this.watchers.get(wid);
			if (w === undefined || p.mounted.includes(wid)) continue;
			w.lastRenderedValue = this.evaluate(this.nodeById(w.node), { kind: 'pass', pass: p });
			w.snapshot = {
				passId: p.id, pin: p.pin, maskSlots: new Set(p.maskSlots),
				includedSlots: this.includedSet(p), rootCommitGen: this.root(p.root).commitGen,
			};
		}
		// (2) retirement folds due at this commit; then the per-root commit (lock-in)
		// of every still-live mask token (§5.3 per-root commit). A retirement is
		// "due at this commit" only for batches this pass rendered (validated
		// above, §4.2 step 2 + fork test 25's write-set closure): a foreign batch
		// retires at its own closure — the mid-pass shape of case 9(c) — never
		// inside another pass's commit, where it would bypass the baseline.
		for (const tid of opts?.retireAtCommit ?? []) this.retireInternal(this.token(tid), true);
		for (const tid of p.maskTokens) {
			const t = this.token(tid);
			if (t.state !== 'live') continue; // fully retired above (or earlier): the retired clause subsumes membership
			const root = this.root(p.root);
			if (!root.committedTokens.has(tid)) {
				root.committedTokens.add(tid);
				root.commitGen++;
				this.cas = this.mintSeq(); // committed-advance (§2): every per-root commit bumps it
				this.log({ type: 'per-root-commit', root: p.root, token: tid });
				// (3) durable drain scoped to this root's committed observers (§5.3).
				this.drainCommittedObservers(p.root, 'per-root-commit');
			}
		}
		// (4) layout: subscribe, then mount fixup (§5.10/§5.11 lifecycle order).
		for (const wid of p.mounted) {
			const w = this.watchers.get(wid);
			if (w === undefined) continue;
			w.live = true;
			this.mountFixup(w, p, baseline);
		}
		this.log({ type: 'pass-committed', pass: p.id, root: p.root });
		this.reevaluateDeferredReleases();
	}

	/** §5.4 — a deferred release re-evaluates at every pass end, commit and discard alike. */
	private reevaluateDeferredReleases(): void {
		for (const s of this.slots) {
			if (!s.releasePending) continue;
			if (!this.slotRetainedByOpenMask(s.id)) this.releaseSlot(s);
		}
		// A pass ending releases its pin, which can unblock pin-gated compaction (§5.3).
		this.compactAll();
	}

	private slotRetainedByOpenMask(slot: SlotId): boolean {
		for (const p of this.passes.values()) {
			if (p.state !== 'ended' && p.maskSlots.has(slot)) return true;
		}
		return false;
	}

	// ---------------------------------------------------------- retirement

	/** §4.1 fact 3 — retirement fires exactly once per token; parked actions retire at settlement. */
	retire(tokenId: TokenId, committed: boolean): void {
		const t = this.token(tokenId);
		if (t.state === 'retired') throw new ScheduleError('retirement fires exactly once per token (§4.1 fact 3)');
		if (t.parked) throw new ScheduleError('parked action tokens retire only at settlement (§4.1 fact 3)');
		this.retireInternal(t, committed);
	}

	/** §3.5 — the action's thenable settles; the fork then retires the token. */
	settleAction(tokenId: TokenId, committed: boolean): void {
		const t = this.token(tokenId);
		if (!t.action) throw new ScheduleError('settle targets an action token');
		if (!t.parked || t.state !== 'live') throw new ScheduleError('action already settled');
		t.parked = false;
		this.retireInternal(t, committed);
	}

	/**
	 * §5.3 retirement — the internal order is normative: stamp, fold
	 * (compaction), retirement stamps + cas, durable drains, clear per-root
	 * rows, and only then release the slot (deferred if an open pass's
	 * render mask names it; §5.4). committed=false batches (no React work)
	 * retire through the same path — persistence never depends on
	 * subscription (§5.3 step 6).
	 */
	private retireInternal(t: Token, committed: boolean): void {
		t.state = 'retired';
		t.committedFlag = committed;
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
		// §5.3 step 3 — mint the retirement stamp per touched atom; bump cas.
		for (const n of touched) n.retirementStamp = retiredSeq;
		if (touched.length > 0) this.cas = this.mintSeq();
		// Fold/compaction (§5.3 step 2's compaction predicate, both clauses).
		// Naive form: try every atom — a retirement can unblock prefixes anywhere.
		this.compactAll();
		this.log({ type: 'retired', token: t.id, committed, retiredSeq });
		// §5.3 step 4 — durable drains: reconcile watchers and revalidate effects
		// against committed truth. The engine enumerates the slot's touched list;
		// the naive model checks every observer — corrections are value-gated, so
		// the fired set is identical (touched list ⊇ changed observers).
		for (const rootId of this.roots.keys()) this.drainCommittedObservers(rootId, 'retirement');
		// §5.3 step 5 — clear per-root committed-table rows (subsumed by the
		// retired clause), THEN release the slot unless an open render mask names it.
		for (const r of this.roots.values()) r.committedTokens.delete(t.id);
		if (t.slot !== undefined) {
			const slot = this.slots[t.slot]!;
			if (this.slotRetainedByOpenMask(slot.id)) {
				slot.releasePending = true; // re-evaluated at every pass end (§5.4)
			} else {
				this.releaseSlot(slot);
			}
		}
		if (this.ambientToken === t.id) this.ambientToken = undefined;
	}

	/**
	 * §5.3 — compaction consumes a sequence-order prefix of the tape: entry e
	 * compacts iff every entry with seq ≤ e.seq is retired AND
	 * e.retiredSeq ≤ min(live pins). Compacted entries fold into base (kept
	 * in the archive for the retention invariant).
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
	 * §5.3/§5.11 — durable drain at a committed-truth flip: reconcile-check
	 * each live watcher (last rendered value vs committed-for-root NOW;
	 * urgent pre-paint correction on real difference — this comparison is
	 * against committed truth, which is legal; live-write delivery is never
	 * value-gated), and revalidate committed effects (re-run on change).
	 */
	private drainCommittedObservers(rootId: RootId, cause: 'retirement' | 'per-root-commit'): void {
		const world: World = { kind: 'committed', root: rootId };
		for (const w of this.watchers.values()) {
			if (!w.live || w.root !== rootId) continue;
			const now = this.evaluate(this.nodeById(w.node), world);
			if (!Object.is(now, w.lastRenderedValue)) {
				this.log({ type: 'reconcile-correction', watcher: w.name, root: rootId, from: w.lastRenderedValue, to: now, cause });
				w.lastRenderedValue = now; // the urgent pre-paint re-render
				w.dedup.clear(); // dedup bits re-arm at the watcher's render (§5.9)
			}
		}
		for (const e of this.reactEffects.values()) {
			if (e.root !== rootId) continue;
			const now = this.evaluate(this.nodeById(e.node), world);
			if (!Object.is(now, e.lastValue)) {
				e.lastValue = now;
				e.runs++;
				this.log({ type: 'react-effect-run', effect: e.name, root: rootId, value: now });
			}
		}
	}

	// ---------------------------------------------------------- mount fixup

	/**
	 * §5.10 — runs in the mounting component's layout effect, after
	 * subscription. Value-blind correctives join each live non-included
	 * batch that touched the node; then one comparison against the mount's
	 * own world fast-forwarded to committed-now catches whatever retired or
	 * locked in during the window — before paint.
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
			// Fully included (slot ∈ includedSet ∧ no post-pin write in it): skip — never by value.
			if (w.snapshot.includedSlots.has(slot.id) && slot.writeClock <= w.snapshot.pin) continue;
			this.log({ type: 'mount-corrective', watcher: w.name, token: t.id, slot: slot.id });
			correctedLive.add(t.id);
			w.dedup.add(slot.id); // the corrective is a scheduled setState in t's lane (fork.runInBatch)
		}
		// The four-conjunct fast-out (§5.10). Over-firing is safe; under-firing
		// is excluded by the case split — asserted here (appendix B flag 5).
		//
		// FLAG-5 DISCREPANCY (found by fuzzing; recorded in tests/FLAGS.md): the
		// spec's clock conjunct quantifies over w_r.mask — the slot set captured
		// at pass START. A mask token whose FIRST write lands mid-pass interned
		// its slot after capture, so the conjunct is vacuous for it; yet the own
		// commit locks that token in and w_fx's committed clause folds the
		// post-pin write ⇒ the fast-out as written returns with v_fx ≠ v_r. The
		// model therefore also checks the committing pass's mask TOKENS at
		// commit time (their write clocks in sequence units), which restores the
		// population argument and leaves every spec-walked row unchanged.
		const clocksQuiet =
			[...w.snapshot.maskSlots].every((s) => this.slots[s]!.writeClock <= w.snapshot.pin) &&
			[...committingPass.maskTokens].every((tid) => {
				const t = this.token(tid);
				return t.writeSeqs.length === 0 || t.writeSeqs[t.writeSeqs.length - 1]! <= w.snapshot.pin;
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
				// FLAG-5 AUDIT (second fuzz finding, tests/FLAGS.md): a live token
				// already committed into this root can take its FIRST write after
				// the pass pinned (the flag-3 ActionScope surface). No conjunct
				// observes that write (cas/gen/clocks are all silent), so v_fx
				// moves under a held fast-out. It is NOT a tear only because the
				// corrective loop above scheduled that token's runInBatch setState.
				// The sound invariant is therefore: fast-out divergence must be
				// exactly corrective-covered. The audit world keeps what w_r itself
				// saw of the excluded tokens: its full included set at its pin
				// (widening the mask clause to includedSlots is inert for everyone
				// else — captured-committed receipts are already retired- or
				// membership-visible, and a recycled slot's new tenant post-dates
				// the pin by the tenancy lemma).
				const vCovered = this.evaluate(node, {
					kind: 'mountFix', maskSlots: w.snapshot.includedSlots, pin: w.snapshot.pin,
					root: w.root, excludeLiveTokens: correctedLive,
				});
				if (!Object.is(vCovered, w.lastRenderedValue)) {
					throw new InvariantViolation(
						`flag-5 fast-out unsound: watcher ${w.name} fast-out held but v_fx=${String(vFx)} ≠ v_r=${String(w.lastRenderedValue)} and the residue is not corrective-covered (§5.10)`,
					);
				}
			}
			return; // zero corrections — the fast-out population is value-neutral modulo scheduled correctives
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

	// ------------------------------------------- episodes and renumbering

	/** §4.1 fact 2 — discardAllWip: synchronously abandons every WIP pass on every root. */
	discardAllWip(): void {
		for (const p of this.passes.values()) {
			if (p.state !== 'ended') this.passEnd(p.id, 'discard');
		}
	}

	quiescent(): boolean {
		return this.liveTokens().length === 0 && this.livePins().length === 0;
	}

	/**
	 * §5.12 — quiescence (no live tokens, no live pins, no parked actions):
	 * K1 bulk-reset (epoch bump) and every counter renumbers under epoch
	 * guards, order-preserving per the renumber duty list. Token serials are
	 * a separate, never-renumbered domain. The model has no kernel caches to
	 * refresh, so the refresh/cone-carry step is a no-op here (delivery
	 * reachability is recomputed from scratch every write, which is the
	 * refreshed state by construction).
	 */
	quiesce(): void {
		if (!this.quiescent()) throw new ScheduleError('quiescence requires no live tokens, pins, or parked actions (§5.12)');
		// Residue check: with no live pins, the last retirement compacted every tape.
		for (const n of this.nodes.values()) {
			if (n.kind === 'atom' && n.tape.length > 0) {
				throw new InvariantViolation(`quiescence residue: atom ${n.name} still holds ${n.tape.length} receipts (§5.12)`);
			}
		}
		this.episodeEdges.clear();
		this.epoch++;
		// Dead-episode records drop before renumbering: ended passes and retired
		// tokens hold the only remaining stale sequence values (§5.12: nothing
		// from a dead episode can validate in a live one; token serials are a
		// separate, never-renumbered domain — the id counter stays monotone).
		for (const [id, p] of this.passes) {
			if (p.state === 'ended') this.passes.delete(id);
		}
		for (const [id, t] of this.tokens) {
			if (t.state === 'retired') this.tokens.delete(id);
		}
		this.renumber();
		// Dead-episode bookkeeping zeroes (§5.4/§5.9: everything bulk-zeroes at episode reset).
		for (const s of this.slots) {
			s.writeClock = 0;
			s.claimSeq = 0;
			s.carriedMaxRetiredSeq = 0;
			s.releasePending = false;
		}
		for (const w of this.watchers.values()) w.dedup.clear();
		this.log({ type: 'epoch-reset', epoch: this.epoch });
	}

	/**
	 * §5.12 renumber duty list — every retained sequence value rewritten in
	 * an order-preserving pass: base sequences, retirement stamps, the
	 * committed-advance counter, slot watermarks/claims. (Tape and memo
	 * sequences: tapes are empty at quiescence and the model holds no memos.
	 * Watcher snapshot pins belong to dead passes and are rewritten too so
	 * no stale sequence survives anywhere.)
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
			// The archive belongs to the dead episode; it exists only for the
			// retention invariant, whose comparisons are per-episode. Clear it.
			n.archive = [];
			n.origin = n.base;
		}
		this.cas = rw(this.cas);
		for (const w of this.watchers.values()) w.snapshot.pin = rw(w.snapshot.pin);
		this.seq = sorted.length; // restart the counter above the rewritten range (§5.12)
	}

	// ------------------------------------------------------------ helpers

	/** Convenience: the value of a node in a named world (test surface). */
	read(node: AnyNode, world: World): Value {
		return this.evaluate(node, world);
	}

	committedValue(node: AnyNode, root: RootId): Value {
		return this.evaluate(node, { kind: 'committed', root });
	}

	newestValue(node: AnyNode): Value {
		return this.evaluate(node, { kind: 'newest' });
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
