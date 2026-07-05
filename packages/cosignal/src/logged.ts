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
 * TODO(gate:SPK-W): int-pack {slot, seq, retiredSeq} into parallel flat
 * columns; ops stay in one unknown[] side column.
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
	/** Full history for the retention invariant: compacted receipts move here. */
	archive: Receipt[];
	origin: Value;
	equals: Equals;
	reducer: Reducer | undefined;
	/** §5.7 — per-atom retirement stamp, minted at every retirement fold touching it. */
	retirementStamp: number;
	/** §5.2 — the kernel-backed newest-world storage this overlay rides. */
	handle: Atom<Value>;
};

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
	writeSeqs: number[];
	ambient: boolean;
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
	state: PassState;
	endKind: 'commit' | 'discard' | undefined;
	mounted: WatcherId[];
	rendered: Set<WatcherId>;
};

export type RootState = {
	id: RootId;
	/** §5.3 per-root lock-in rows: live tokens only (cleared at retirement). */
	committedTokens: Set<TokenId>;
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
	live: boolean;
	lastRenderedValue: Value;
	snapshot: WatcherSnapshot;
	/** §5.9 — per-(watcher, slot) delivery dedup bits. */
	dedup: Set<SlotId>;
};

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
};

/** §2 "world" — one self-consistent assignment of values to all atoms. */
export type World =
	| { kind: 'newest' }
	| { kind: 'pass'; pass: Pass }
	| { kind: 'committed'; root: RootId }
	| { kind: 'mountFix'; maskSlots: Set<SlotId>; pin: number; root: RootId; excludeLiveTokens?: Set<TokenId> };

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
		return {
			...inner,
			read(s: number): unknown {
				const b = activeBridge;
				if (b !== undefined && b.activeWorld !== undefined) {
					const la = b.byKernelId.get(s);
					if (la !== undefined) {
						return b.foldAtom(la, b.activeWorld);
					}
				}
				return inner.read(s);
			},
			write(s: number, value: unknown): boolean {
				const b = activeBridge;
				if (b !== undefined && !bridgeApplying && b.mode === 'logged') {
					const la = b.byKernelId.get(s);
					if (la !== undefined) {
						b.bareWrite(la, { kind: 'set', value });
						return false; // the bridge's own kernel apply already flushed
					}
				}
				return inner.write(s, value);
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
	/**
	 * §5.5 — the K1 union plane: dependency edges accumulated this episode
	 * (dep → dependents), add-only, bulk-reset at quiescence. Kernel edge
	 * drops need no mirror here because world evaluations re-record the
	 * newest routing on every refresh (the fold-everything form; the
	 * incremental K0-mirror + touched-word walk is TODO(gate:SPK-N1)).
	 */
	episodeEdges = new Map<NodeId, Set<NodeId>>();

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
		}
	}

	private log(e: BridgeEvent): void {
		this.events.push(e);
		const tr = this.trace;
		if (tr !== undefined) tr.event(e);
	}

	private mintSeq(): number {
		return ++this.seq;
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
	}

	atom(name: string, initial: Value, equals?: Equals): AtomNode {
		const eq = equals ?? Object.is;
		const handle = new Atom<Value>(initial, equals === undefined ? undefined : { isEqual: equals });
		const node: AtomNode = {
			kind: 'atom', id: this.nextNode++, name,
			base: initial, baseSeq: 0, tape: [], archive: [], origin: initial,
			equals: eq, reducer: undefined, retirementStamp: 0, handle,
		};
		this.nodes.set(node.id, node);
		this.byKernelId.set(handle._id, node);
		return node;
	}

	/**
	 * §5.1 activation rule 2 — an existing kernel atom joins the bridge with
	 * its DIRECT-era value as committed-only base state (no receipts existed).
	 */
	adoptAtom(name: string, handle: Atom<Value>, equals?: Equals): AtomNode {
		const current = this.kernelValueOf(handle);
		const node: AtomNode = {
			kind: 'atom', id: this.nextNode++, name,
			base: current, baseSeq: 0, tape: [], archive: [], origin: current,
			equals: equals ?? Object.is, reducer: undefined, retirementStamp: 0, handle,
		};
		this.nodes.set(node.id, node);
		this.byKernelId.set(handle._id, node);
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

	/** Retention-invariant helper: the same fold over the FULL history from origin. */
	shadowFoldAtom(atom: AtomNode, world: World): Value {
		let value = atom.origin;
		for (const e of [...atom.archive, ...atom.tape]) {
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
		this.activeWorld = undefined; // never let the world router intercept a kernel-plane read
		try {
			return handle.state;
		} finally {
			this.activeWorld = saved;
		}
	}

	/**
	 * Evaluation of a node in a world. Newest-world atoms read straight off
	 * the kernel plane (K0 holds the newest fold by the eager-apply
	 * invariant); every other world folds the tape. Computeds evaluate
	 * recursively — memo-free for non-newest worlds exactly like the oracle
	 * (the §5.7 memo ladder is TODO(gate:SPK-R)). Tracked reads record real
	 * K1 edges; untracked reads fold in-world, edge-free (§5.5). Reads inside
	 * fold callbacks throw; per-world cycles throw (§3.6).
	 */
	evaluate(node: AnyNode, world: World, stack?: Set<NodeId>): Value {
		if (this.inFoldCallback) throw new BridgeScheduleError('signal read inside an updater/reducer fold (§3.1)');
		if (node.kind === 'atom') {
			return world.kind === 'newest' ? this.kernelValueOf(node.handle) : this.foldAtom(node, world);
		}
		const seen = stack ?? new Set<NodeId>();
		if (seen.has(node.id)) throw new BridgeScheduleError(`cyclic evaluation of ${node.name} within one world (§3.6)`);
		seen.add(node.id);
		this.evalDepth++;
		const savedWorld = this.activeWorld;
		this.activeWorld = world.kind === 'newest' ? undefined : world;
		const tr = this.trace; // R11: paired eval hooks; end fires on throw too
		if (tr !== undefined) tr.evalStart(node, world);
		try {
			const read: Reader = (dep) => {
				this.recordEdge(dep.id, node.id);
				return this.evaluate(dep, world, seen);
			};
			const untrackedRead: Reader = (dep) => this.evaluate(dep, world, seen);
			return node.fn(read, untrackedRead);
		} finally {
			this.activeWorld = savedWorld;
			this.evalDepth--;
			seen.delete(node.id);
			if (tr !== undefined) tr.evalEnd();
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
	 * §5.3 step 4/§5.9 — delivery reachability over the episode-accumulated
	 * K0∪K1 union. Refresh = evaluate every computed in every currently
	 * relevant world, recording real edges (the oracle's normative
	 * conservative semantics; over-notification is priced, never wrong).
	 * TODO(gate:SPK-N1): replace with the touched-word marking walk over
	 * kernel links + K1 records; relax the diff layer to the documented
	 * "engine ⊇ required, ⊆ union-conservative" tolerance when landing it.
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

	/** Nodes reachable from `from` over the union graph (including `from`). */
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
		if (this.mode !== 'logged') throw new BridgeScheduleError('batches exist only in LOGGED mode (§5.1)');
		if (this.liveTokens().length >= SLOT_COUNT) {
			throw new BridgeScheduleError('at most 31 live tokens (§4.1 fact 1 invariant)');
		}
		const token: Token = {
			id: this.nextToken++, priority,
			action: opts?.action ?? false,
			parked: opts?.action ?? false, // §4.1 fact 3: action tokens park until settlement
			state: 'live', committedFlag: undefined, slot: undefined,
			retiredSeq: undefined, writeSeqs: [], ambient: opts?.ambient ?? false,
		};
		this.tokens.set(token.id, token);
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
	 * bits clear (§5.9); the dirt watermark carries forward (keep-the-dirt —
	 * this build recomputes routing, so the watermark's only duty is §5.12
	 * renumbering; the touched-bit sweep gated on it is TODO(gate:SPK-N1)).
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
		free.tenant = token.id;
		free.claimSeq = this.mintSeq(); // §5.4 tenancy: claim-after-release gets its own point on the line
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
			tenant.slot = undefined; // identity release; receipts keep their denormalized slot (§5.4)
			this.log({ type: 'slot-released', slot: slot.id, token: tenant.id });
		}
		slot.tenant = undefined;
		slot.releasePending = false;
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
		if (this.liveTokens().some((t) => t.parked)) {
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
	 * append receipt + write clock → apply to K0 with stepwise equality →
	 * marking/delivery walk → core-effect flush after the walk returns.
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
			this.flushCoreEffects();
			const tr = this.trace;
			if (tr !== undefined) tr.opEnd();
			return;
		}
		if (tokenId === undefined) {
			this.bareWrite(node, op);
			return;
		}
		const token = this.token(tokenId);
		if (token.state !== 'live') throw new BridgeScheduleError(`write into retired token ${tokenId} (§4.1 fact 4 fallback is fork scope)`);

		// §5.3 step 2 — drop check: empty tape AND op evaluates equal against base.
		if (node.tape.length === 0) {
			const evaluated = this.applyOp(node, op, node.base);
			if (this.inCallback(() => node.equals(evaluated, node.base))) {
				this.log({ type: 'write-dropped', node: node.name, token: tokenId });
				const tr = this.trace;
				if (tr !== undefined) tr.opEnd();
				return;
			}
		}

		// §5.3 steps 1/3 — intern slot, append receipt, bump the slot write clock.
		const slot = this.internSlot(token);
		const seq = this.mintSeq();
		const receipt: Receipt = { op, token: token.id, slot: slot.id, seq, retiredSeq: undefined };
		node.tape.push(receipt);
		token.writeSeqs.push(seq);
		slot.writeClock = seq;
		{
			const tr = this.trace;
			if (tr !== undefined) tr.receipt(node, receipt);
		}
		this.log({ type: 'write', node: node.name, token: token.id, slot: slot.id, seq });

		// §5.2/§5.3 step 3 — apply to K0 eagerly with stepwise equality, so the
		// newest world stays directly readable off the kernel plane.
		const prevNewest = this.kernelValueOf(node.handle);
		const nextNewest = this.applyOp(node, op, prevNewest);
		if (!this.inCallback(() => node.equals(nextNewest, prevNewest))) {
			this.applyToKernel(node, nextNewest);
		}

		// §5.3 steps 4–5 — marking + delivery over the K0∪K1 union, value-blind,
		// in the writer's stack; then the core-effect flush drains.
		this.refreshEdgesAllWorlds();
		const reached = this.reachableFrom(node.id);
		for (const w of this.watchers.values()) {
			if (!w.live || !reached.has(w.node)) continue;
			this.deliver(w, token, slot, seq);
		}
		this.flushCoreEffects(reached);
		const tr = this.trace;
		if (tr !== undefined) tr.opEnd();
	}

	/** The one K0 write site: routes through the public policy path (flush included). */
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
	 * §5.9 delivery — per-write, value-blind, in the writer's stack. The
	 * per-(watcher, slot) dedup bit suppresses only when scheduled-but-
	 * unstarted work will fold the write; otherwise deliver interleaved.
	 */
	private deliver(w: Watcher, token: Token, slot: SlotMeta, seq: number): void {
		if (!w.dedup.has(slot.id)) {
			w.dedup.add(slot.id);
			this.log({ type: 'delivery', watcher: w.name, token: token.id, slot: slot.id, seq, mode: 'fresh' });
			return;
		}
		// Bit set: suppress iff NO started-and-uncommitted pass on W's root
		// includes s (render mask) with pin < the write's sequence (§5.9).
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

	/** §5.11 — core effects observe the newest world; flush after the walk returns. */
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
				throw new BridgeScheduleError(`root ${rootId} already has an open pass (§4.1 fact 2)`);
			}
		}
		const maskTokens = new Set<TokenId>();
		const maskSlots = new Set<SlotId>();
		for (const id of includeTokens) {
			const t = this.token(id);
			if (t.state !== 'live') throw new BridgeScheduleError('mask captures live tokens only (§5.4)');
			maskTokens.add(id);
			// A live token with no slot never wrote; later receipts postdate the
			// pin and are clause-2-excluded anyway (§5.4 pin/seq-after-claim).
			if (t.slot !== undefined) maskSlots.add(t.slot);
		}
		const pass: Pass = {
			id: this.nextPass++, root: rootId, pin: this.seq,
			maskTokens, maskSlots,
			capturedCommittedSlots: this.committedSlotsNow(rootId),
			state: 'open', endKind: undefined, mounted: [], rendered: new Set(),
		};
		this.passes.set(pass.id, pass);
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
		p.state = 'ended';
		p.endKind = kind;
		{
			// Trace-only pass-end: fires BEFORE the end's consequences (retirement
			// folds, per-root commits, drains, fixups), unlike the pass-committed/
			// pass-discarded events below, so consequences can cite it as cause.
			const tr = this.trace;
			if (tr !== undefined) tr.passEnd(p, kind);
		}
		if (kind === 'discard') {
			for (const wid of p.mounted) this.watchers.delete(wid); // never subscribed; the tree died
			this.log({ type: 'pass-discarded', pass: p.id, root: p.root });
			this.reevaluateDeferredReleases();
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
		for (const tid of p.maskTokens) {
			const t = this.token(tid);
			if (t.state !== 'live') continue; // fully retired above: the retired clause subsumes membership
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
		const tr = this.trace;
		if (tr !== undefined) tr.opEnd();
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
		for (const p of this.passes.values()) {
			if (p.state !== 'ended' && p.maskSlots.has(slot)) return true;
		}
		return false;
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
		this.compactAll();
		this.log({ type: 'retired', token: t.id, committed, retiredSeq });
		// §5.3 step 4 — durable drains: reconcile watchers and revalidate
		// effects against committed truth. TODO(gate:SPK-N1): enumerate the
		// slot's touched list instead of every observer (value-gated either
		// way, so the fired set is identical).
		for (const rootId of this.roots.keys()) this.drainCommittedObservers(rootId, 'retirement');
		// §5.3 step 5 — clear per-root rows (subsumed by the retired clause),
		// THEN release the slot unless an open render mask names it.
		for (const r of this.roots.values()) r.committedTokens.delete(t.id);
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
			if (e.retiredSeq === undefined) break; // prefix clause: an unretired earlier entry blocks everything after
			if (e.retiredSeq > minPin) break; // pin clause: every live pin already sees e via the retired clause
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
	 * locked in during the window — before paint. Implements the normative
	 * oracle errata (2026-07-05): the clock conjunct quantifies over the
	 * committing pass's mask TOKENS at commit time (errata 1), and fast-out-
	 * suppressed divergence must be exactly corrective-covered (errata 2,
	 * asserted on every mount).
	 */
	private mountFixup(w: Watcher, committingPass: Pass, baseline: { cas: number; rootCommitGen: number }): void {
		const node = this.nodeById(w.node);
		this.refreshEdgesAllWorlds();
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
			w.dedup.add(slot.id); // the corrective is a scheduled setState in t's lane (fork.runInBatch)
		}
		// The four-conjunct fast-out (§5.10). The clock conjunct checks the
		// captured mask slots AND the committing pass's mask tokens at commit
		// time (errata 1: a mask token whose first write interned mid-pass is
		// invisible to the slot-quantified form).
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
			w.dedup.clear();
			if (tr !== undefined) tr.mountFixup(w, 'corrected', correctedLive.size);
			return;
		}
		if (tr !== undefined) tr.mountFixup(w, 'compare-clean', correctedLive.size);
	}

	/** Transitive dependency closure feeding a node, over the union graph. */
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

	/** §4.1 fact 2 — discardAllWip: synchronously abandons every WIP pass. */
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
	 * the K1 union plane bulk-resets (epoch bump) and every retained counter
	 * renumbers, order-preserving. Token/pass serials are a separate,
	 * never-renumbered domain. The kernel plane needs no refresh here: K0
	 * already holds every committed value by the eager-apply invariant, and
	 * the fold-everything world path re-records edges on the next evaluation
	 * (the kernel-pull refresh + cone carry is TODO(gate:SPK-R)).
	 */
	quiesce(): void {
		if (!this.quiescent()) throw new BridgeScheduleError('quiescence requires no live tokens, pins, or parked actions (§5.12)');
		// Residue check: with no live pins, the last retirement compacted every tape.
		for (const n of this.nodes.values()) {
			if (n.kind === 'atom' && n.tape.length > 0) {
				throw new BridgeInvariantViolation(`quiescence residue: atom ${n.name} still holds ${n.tape.length} receipts (§5.12)`);
			}
		}
		this.episodeEdges.clear();
		this.epoch++;
		// Dead-episode records drop before renumbering (§5.12): nothing from a
		// dead episode can validate in a live one; serial counters stay monotone.
		for (const [id, p] of this.passes) {
			if (p.state === 'ended') this.passes.delete(id);
		}
		for (const [id, t] of this.tokens) {
			if (t.state === 'retired') this.tokens.delete(id);
		}
		this.renumber();
		// Dead-episode bookkeeping zeroes (§5.4/§5.9: bulk-zero at episode reset).
		for (const s of this.slots) {
			s.writeClock = 0;
			s.claimSeq = 0;
			s.carriedMaxRetiredSeq = 0;
			s.releasePending = false;
		}
		for (const w of this.watchers.values()) w.dedup.clear();
		this.log({ type: 'epoch-reset', epoch: this.epoch });
		const tr = this.trace;
		if (tr !== undefined) tr.opEnd();
	}

	/**
	 * §5.12 renumber duty list — every retained sequence value rewritten in
	 * an order-preserving pass: base sequences, retirement stamps, the
	 * committed-advance counter, watcher snapshot pins. Tapes are empty at
	 * quiescence; archives belong to the dead episode and clear.
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
			n.archive = []; // per-episode retention comparisons only
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
		return this.evaluate(node, { kind: 'newest' });
	}

	passValue(node: AnyNode, pass: Pass): Value {
		return this.evaluate(node, { kind: 'pass', pass });
	}

	eventsOfType<T extends BridgeEvent['type']>(type: T): Extract<BridgeEvent, { type: T }>[] {
		return this.events.filter((e): e is Extract<BridgeEvent, { type: T }> => e.type === type);
	}

	/** Events appended after a caller-captured watermark (test surface). */
	eventsSince(mark: number): BridgeEvent[] {
		return this.events.slice(mark);
	}
}

// ---- the twin public surface -----------------------------------------------------
// The LOGGED entry re-exports the entire DIRECT API: application code imports
// one path or the other (spec §7 twin builds); only this entry can arm the
// bridge. `registerReactBridge`, the bridge class, and the bridge-surface
// types are the additions.

export * from './index.js';
