/**
 * cosignal-react — the fork shim (spec §4 consumed; fork/S4-REPORT.md
 * "Handoff notes" is the API contract). One Shim instance couples one
 * CosignalBridge to the linked React fork:
 *
 *  - handshake: assert protocol version 1 / capabilities 511 on both sides
 *    (S4 note 1); refuse stock or degraded React loudly.
 *  - fork listener -> bridge: onRenderPassStart(includedBatches, lineageId)
 *    -> passStart; yield/resume -> passYield/passResume; onRenderPassEnd
 *    (committed) -> passEnd('commit') AT the end(commit) edge — the pinned
 *    baseline-capture site (S4 note 4: it precedes the same commit's table
 *    update and folds); onRenderPassEnd(discarded) -> passEnd('discard');
 *    onBatchRetired -> retire/settleAction; onRootCommitted -> per-root
 *    re-report reconciliation (idempotent, S4 note 3 flush-split rule) +
 *    effect revalidation.
 *  - bridge event log -> React: after every bridge call the shim drains the
 *    events it appended and translates deliveries / mount correctives /
 *    urgent corrections into setStates via unstable_runInBatch (value-blind
 *    entanglement in the write's own batch; retired/unknown tokens take the
 *    documented discrete-urgent fallback). Yield-edge and commit-listener
 *    delivery are pinned legal (S4 note 2).
 *  - write classification (§3.5: a write belongs to the batch context in
 *    which it executes): adopted atoms' set/update/dispatch route through
 *    bridge.write with WHOLE ops (replay fidelity — public Atom.update/
 *    dispatch reach the logged table pre-folded, so the shim intercepts at
 *    the method level), classified by unstable_getCurrentWriteBatch /
 *    unstable_isCurrentWriteDeferred; token 0 (no provider) falls back to
 *    the bridge's ambient default batch.
 *  - Suspense capsules (§5.8 / battery case 15): ctx.use inside bound
 *    computeds keys thenables on (node × position) matched by value-prefix —
 *    a value-carried reading of the lineage rule (a retry under the same
 *    lineage folds the same values and reuses the capsule; a moved world
 *    refetches). Chosen over raw lineage-id buckets because this bridge
 *    evaluates every world (fold-everything, SPK-R deferred): world-blind
 *    value identity is what keeps canonical evaluations from re-fetching.
 */

import * as React from 'react';
import { Atom, ReducerAtom, SuspendedRead } from 'cosignal/logged';
import type {
	AnyNode,
	AtomNode,
	BridgeEvent,
	ComputedNode,
	CosignalBridge,
	Op,
	Pass,
	Reader,
	RootId,
	TokenId,
	Value,
	Watcher,
} from 'cosignal/logged';

// ---- handshake -------------------------------------------------------------------

export const REQUIRED_PROTOCOL_VERSION = 1;
export const REQUIRED_CAPABILITIES = 511; // bits 0..8, fork/S4-REPORT.md

export function assertForkProtocol(): void {
	const proto = React.unstable_externalRuntimeProtocol;
	if (proto === undefined) {
		throw new Error('cosignal-react: this React has no external-runtime protocol — run against the linked fork (pnpm fork:build).');
	}
	if (proto.version !== REQUIRED_PROTOCOL_VERSION || proto.capabilities !== REQUIRED_CAPABILITIES) {
		throw new Error(
			`cosignal-react: protocol mismatch (version ${proto.version}, capabilities ${proto.capabilities}; ` +
				`need ${REQUIRED_PROTOCOL_VERSION}/${REQUIRED_CAPABILITIES}) — someone needs fork:build.`,
		);
	}
	const providers = proto.providerProtocols;
	if (providers.length === 0) {
		throw new Error('cosignal-react: no renderer registered an external-runtime provider — load react-dom/client (fork build) before registering.');
	}
	for (const p of providers) {
		if (p.version !== REQUIRED_PROTOCOL_VERSION || p.capabilities !== REQUIRED_CAPABILITIES) {
			throw new Error(`cosignal-react: renderer protocol mismatch (${p.version}/${p.capabilities}).`);
		}
	}
}

// ---- shim types ------------------------------------------------------------------

/** A live delivery target: one subscribed hook instance. */
export type WatcherTarget = {
	/** Schedules a re-render of the owning component (a setState bump). */
	bump: () => void;
	live: boolean;
};

type RootRec = {
	id: RootId;
	container: unknown;
	/** The open bridge pass mirroring the fork's WIP pass frame, if any. */
	pass: Pass | undefined;
	/** Lineage id the open pass reported at passStart (fact 5). */
	lineageId: number;
	/** Watcher ids minted during the current/most recent pass, for the orphan sweep. */
	minted: Set<number>;
	lastCommitGeneration: number;
};

type EffectRec = {
	id: number;
	root: RootId;
	/** (node, committed-for-root fingerprint) pairs — §5.11 effect snapshot. */
	deps: Array<{ node: AnyNode; value: Value }>;
	/** Snapshot header {root commit generation} (§5.11). */
	rootCommitGen: number;
	/** Re-fires the user effect (cleanup + run + re-track). */
	refire: () => void;
	live: boolean;
};

type Capsule = {
	thenable: PromiseLike<unknown>;
	/** Stable sentinel: background walks fold a pending capsule to THIS object. */
	sr: SuspendedRead;
	state: 'pending' | 'fulfilled' | 'rejected';
	value: unknown;
	reason: unknown;
	/** The use() position within the node's evaluation. */
	position: number;
	/** The owning useComputed's deps at mint (closure-input identity). */
	deps: readonly unknown[];
	/** (nodeId, value) pairs read before the use() site at mint (§5.8 prefix). */
	prefix: Array<[number, unknown]>;
};

/** Per bridge-evaluation frame bookkeeping for reads + ctx.use (§5.8). */
type EvalFrame = {
	read: Reader;
	untracked: Reader;
	node: ComputedNode;
	/** Capsule identity components stable across suspended-mount retries. */
	fnSrc: string;
	deps: readonly unknown[];
	useIndex: number;
	readLog: Array<[number, unknown]>;
};

const BOUND: unique symbol = Symbol('cosignal-react.bound');
/** Marks the shim's un-routed twin handles (the bridge's kernel-apply path). */
const TWIN: unique symbol = Symbol('cosignal-react.twin');
type BoundState = { shim: Shim; node: AtomNode };
type PatchableAtom = Atom<unknown> & { [BOUND]?: BoundState; [TWIN]?: boolean };

const originalStateGet = Object.getOwnPropertyDescriptor(Atom.prototype, 'state')!.get as (this: unknown) => unknown;
const originalSet = Atom.prototype.set;
const originalUpdate = Atom.prototype.update;
const originalDispatch = ReducerAtom.prototype.dispatch;

let nextRootSerial = 1;
let nextEffectSerial = 1;

/** The one active shim (module registry; hooks.ts manages activation). */
let activeShim: Shim | undefined;

export function setActiveShim(shim: Shim | undefined): void {
	activeShim = shim;
}

export function getActiveShim(): Shim | undefined {
	return activeShim !== undefined && !activeShim.disposed ? activeShim : undefined;
}

/**
 * Prototype-level routing (installed once at module load — importing
 * cosignal-react opts the process into LOGGED bindings; the DIRECT entry's
 * module graph never reaches this file, so the twin-build promise holds).
 * With no active shim, or on twin handles, every member is the original.
 */
function installPrototypeRouting(): void {
	Object.defineProperty(Atom.prototype, 'state', {
		configurable: true,
		get(this: PatchableAtom): unknown {
			const shim = this[TWIN] === true ? undefined : getActiveShim();
			if (shim === undefined) return originalStateGet.call(this);
			return shim.readState(this);
		},
	});
	Atom.prototype.set = function (this: PatchableAtom, value: unknown): void {
		const shim = this[TWIN] === true ? undefined : getActiveShim();
		if (shim === undefined) originalSet.call(this, value);
		else shim.classifyWrite(shim.nodeForAtom(this), { kind: 'set', value });
	};
	Atom.prototype.update = function (this: PatchableAtom, fn: (v: unknown) => unknown): void {
		const shim = this[TWIN] === true ? undefined : getActiveShim();
		if (shim === undefined) originalUpdate.call(this, fn);
		else shim.classifyWrite(shim.nodeForAtom(this), { kind: 'update', fn });
	};
	ReducerAtom.prototype.dispatch = function (this: PatchableAtom, action: unknown): void {
		const shim = this[TWIN] === true ? undefined : getActiveShim();
		if (shim === undefined) originalDispatch.call(this as ReducerAtom<unknown, unknown>, action);
		else shim.classifyWrite(shim.nodeForAtom(this), { kind: 'dispatch', action });
	};
}
installPrototypeRouting();

// ---- the shim --------------------------------------------------------------------

export class Shim {
	readonly bridge: CosignalBridge;
	disposed = false;
	/** Listener/translation errors (recorded, not thrown across React's commit). */
	errors: unknown[] = [];
	/** Dev warnings surfaced (shim heuristics + bridge events; once per message). */
	devWarnings: string[] = [];
	private warned = new Set<string>();

	private unsubscribe: () => void;
	private rootsByContainer = new Map<unknown, RootRec>();
	private rootsById = new Map<RootId, RootRec>();
	private bridgeTokenByFork = new Map<number, TokenId>();
	private forkTokenByBridge = new Map<TokenId, number>();
	/** watcher id -> delivery target (registered at render, claimed at layout). */
	targets = new Map<number, WatcherTarget>();
	/** watcher id -> claimed by a committed layout effect (StrictMode orphan sweep). */
	claimed = new Set<number>();
	effects = new Map<number, EffectRec>();
	/**
	 * ctx.use capsules keyed by the computed's SOURCE (fn text + deps), matched
	 * by (position, value-prefix): the same inputs serve the same thenable in
	 * EVERY world and across every retry (§5.8 / battery case 15 rows 2/3/5).
	 * Node identity is deliberately NOT the key — a suspended MOUNT discards
	 * hook state, so the retry re-creates the node (§3.3 pass-owned churn), and
	 * node-keyed capsules refetch forever (the pinned livelock scar). The
	 * world's identity is carried by the values its fold produced: a retry
	 * under the same lineage folds the same values and reuses the capsule; a
	 * rebased or retirement-moved world folds different values and refetches.
	 * Content-neutral flips REUSE rather than refetch — v1 accepts duplicate
	 * fetches, never stale data, and value matching is strictly tighter.
	 */
	private capsules = new Map<string, Capsule[]>();
	/** The bridge evaluation frames opened by bound computeds (innermost last). */
	private evalStack: EvalFrame[] = [];
	/** Set while an effect fire is tracking committed-for-root reads. */
	private effectCapture: { root: RootId; deps: Array<{ node: AnyNode; value: Value }> } | undefined;

	constructor(bridge: CosignalBridge) {
		this.bridge = bridge;
		assertForkProtocol();
		this.unsubscribe = React.unstable_subscribeToExternalRuntime({
			onRenderPassStart: (container, includedBatches, lineageId) =>
				this.guard(() => this.handlePassStart(container, includedBatches, lineageId)),
			onRenderPassYield: (container) => this.guard(() => this.handleYield(container)),
			onRenderPassResume: (container) => this.guard(() => this.handleResume(container)),
			onRenderPassEnd: (container, committed) => this.guard(() => this.handlePassEnd(container, committed)),
			onBatchRetired: (token, committed) => this.guard(() => this.handleBatchRetired(token, committed)),
			onRootCommitted: (container, committedBatches, generation) =>
				this.guard(() => this.handleRootCommitted(container, committedBatches, generation)),
		});
	}

	dispose(): void {
		this.disposed = true;
		this.unsubscribe();
		this.targets.clear();
		this.effects.clear();
		this.capsules.clear();
	}

	/** Listener bodies never throw across React's commit; failures are recorded. */
	private guard(fn: () => void): void {
		if (this.disposed) return;
		try {
			fn();
		} catch (error) {
			this.errors.push(error);
		}
	}

	/** Errors recorded since the last call (tests assert this stays empty). */
	takeErrors(): unknown[] {
		const out = this.errors;
		this.errors = [];
		return out;
	}

	private devWarn(message: string): void {
		this.devWarnings.push(message);
		if (!this.warned.has(message)) {
			this.warned.add(message);
			// eslint-disable-next-line no-console
			console.warn(`cosignal: ${message}`);
		}
	}

	// ---- roots and tokens ----------------------------------------------------

	rootRec(container: unknown): RootRec {
		let rec = this.rootsByContainer.get(container);
		if (rec === undefined) {
			rec = {
				id: `root-${nextRootSerial++}`,
				container,
				pass: undefined,
				lineageId: 0,
				minted: new Set(),
				lastCommitGeneration: 0,
			};
			this.rootsByContainer.set(container, rec);
			this.rootsById.set(rec.id, rec);
			this.bridge.root(rec.id); // materialize the per-root committed table
		}
		return rec;
	}

	/** Bridge token mirroring a fork token (minted on first sight). */
	bridgeTokenFor(forkToken: number, opts?: { action?: boolean }): TokenId {
		const existing = this.bridgeTokenByFork.get(forkToken);
		if (existing !== undefined) {
			if (opts?.action === true) {
				// Same-event transitions share one fork token (S4 item 4): upgrade
				// the shared token to action semantics (parks until settlement).
				const t = this.bridge.tokens.get(existing);
				if (t !== undefined && t.state === 'live') {
					t.action = true;
					t.parked = true;
				}
			}
			return existing;
		}
		const deferred = (forkToken & 1) === 1;
		const token = this.bridge.openBatch(deferred ? 'deferred' : 'urgent', {
			action: opts?.action ?? false,
		});
		this.bridgeTokenByFork.set(forkToken, token.id);
		this.forkTokenByBridge.set(token.id, forkToken);
		return token.id;
	}

	forkTokenOf(bridgeToken: TokenId): number | undefined {
		return this.forkTokenByBridge.get(bridgeToken);
	}

	/** The shim's view of the pass currently rendering (per callstack, fact 2). */
	renderingRoot(): RootRec | undefined {
		const ctx = React.unstable_getRenderContext();
		if (ctx === null) return undefined;
		return this.rootsByContainer.get(ctx.container);
	}

	// ---- fork listener -> bridge ----------------------------------------------

	private handlePassStart(container: unknown, includedBatches: readonly number[], lineageId: number): void {
		const rec = this.rootRec(container);
		if (rec.pass !== undefined && rec.pass.state !== 'ended') {
			// Defensive: the fork ends frames before restarting them; a stale open
			// pass here is a seam desync — discard it loudly via the error log.
			this.bridge.passEnd(rec.pass.id, 'discard');
			this.errors.push(new Error(`cosignal-react: stale open pass on ${rec.id} at passStart`));
		}
		const known: TokenId[] = [];
		for (const forkToken of includedBatches) {
			// Only fork batches carrying cosignal writes have bridge tokens; a
			// pure-React batch has no receipts, so excluding it from the mask
			// cannot change any fold (§5.3 visibility is receipt-driven).
			const mapped = this.bridgeTokenByFork.get(forkToken);
			if (mapped !== undefined && this.bridge.tokens.get(mapped)?.state === 'live') known.push(mapped);
		}
		rec.pass = this.bridge.passStart(rec.id, known);
		rec.lineageId = lineageId;
		rec.minted = new Set();
	}

	private handleYield(container: unknown): void {
		const rec = this.rootsByContainer.get(container);
		if (rec?.pass === undefined || rec.pass.state === 'ended') return;
		this.withBridge(() => this.bridge.passYield(rec.pass!.id));
	}

	private handleResume(container: unknown): void {
		const rec = this.rootsByContainer.get(container);
		if (rec?.pass === undefined || rec.pass.state === 'ended') return;
		this.withBridge(() => this.bridge.passResume(rec.pass!.id));
	}

	private handlePassEnd(container: unknown, committed: boolean): void {
		const rec = this.rootsByContainer.get(container);
		if (rec?.pass === undefined || rec.pass.state === 'ended') return;
		const pass = rec.pass;
		if (!committed) {
			// Discard: pass-owned mounts die in the bridge; drop their targets too.
			this.withBridge(() => this.bridge.passEnd(pass.id, 'discard'));
			for (const wid of rec.minted) {
				if (!this.claimed.has(wid)) this.targets.delete(wid);
			}
			rec.minted = new Set();
			rec.pass = undefined;
			return;
		}
		// end(commit) IS the baseline-capture site (S4 note 4): bridge.passEnd
		// snapshots {cas, rootCommitGen} at entry, before its own lock-ins and
		// before the fork's onRootCommitted/onBatchRetired arrive. Mount fixups
		// (§5.10) run inside; their correctives translate below via withBridge.
		this.withBridge(() => this.bridge.passEnd(pass.id, 'commit'));
		rec.pass = undefined;
		// ctx.previous cells hold the last COMMITTED value (§3.4): update from
		// every watcher this commit rendered or mounted.
		for (const wid of [...pass.rendered, ...pass.mounted]) {
			const w = this.bridge.watchers.get(wid);
			if (w !== undefined && !(w.lastRenderedValue instanceof SuspendedRead)) {
				this.previousCell(w.node).value = w.lastRenderedValue;
			}
		}
		// Orphan sweep (StrictMode replay / render-phase double-invoke): watchers
		// minted by this pass that no committed layout effect claims are dead by
		// the time microtasks run (React's layout effects run before microtasks
		// can be interleaved with user events).
		const minted = rec.minted;
		rec.minted = new Set();
		queueMicrotask(() => {
			if (this.disposed) return;
			for (const wid of minted) {
				if (this.claimed.has(wid)) continue;
				const w = this.bridge.watchers.get(wid);
				if (w !== undefined) {
					w.live = false;
					this.bridge.watchers.delete(wid);
				}
				this.targets.delete(wid);
			}
		});
	}

	private handleBatchRetired(forkToken: number, committed: boolean): void {
		const mapped = this.bridgeTokenByFork.get(forkToken);
		if (mapped === undefined) return; // no cosignal writes rode this batch
		const t = this.bridge.tokens.get(mapped);
		if (t === undefined || t.state !== 'live') return;
		this.withBridge(() => {
			if (t.parked) this.bridge.settleAction(mapped, committed); // §3.5 settlement
			else this.bridge.retire(mapped, committed); // §4.1 fact 3
		});
		this.bridgeTokenByFork.delete(forkToken);
		this.forkTokenByBridge.delete(mapped);
		this.revalidateEffects(); // §5.11 retirement + settlement re-checks
	}

	private handleRootCommitted(container: unknown, committedBatches: readonly number[], generation: number): void {
		const rec = this.rootRec(container);
		rec.lastCommitGeneration = generation;
		// The bridge already locked in the committing pass's mask tokens at
		// passEnd(commit); the fork's delta re-report (flush-split, S4 note 3)
		// is idempotent set semantics. Reconcile any delta member the mask sweep
		// missed (defensive — mask ⊇ delta for mapped tokens by construction).
		this.withBridge(() => {
			const root = this.bridge.root(rec.id);
			for (const forkToken of committedBatches) {
				const mapped = this.bridgeTokenByFork.get(forkToken);
				if (mapped === undefined) continue;
				const t = this.bridge.tokens.get(mapped);
				if (t === undefined || t.state !== 'live' || root.committedTokens.has(mapped)) continue;
				root.committedTokens.add(mapped);
				root.commitGen++;
			}
		});
		// §5.11: every root commit is an effect flush trigger (the durable drain
		// runs at each report — the re-report case is value-gated to a no-op).
		this.revalidateEffects(rec.id);
	}

	// ---- bridge event log -> React ---------------------------------------------

	/** Runs a bridge operation, then translates the events it appended. */
	withBridge<T>(fn: () => T): T {
		const mark = this.bridge.events.length;
		try {
			return fn();
		} finally {
			this.translate(this.bridge.eventsSince(mark));
		}
	}

	private translate(events: BridgeEvent[]): void {
		for (const e of events) {
			switch (e.type) {
				case 'delivery': // §5.9 value-blind, in the write's own batch
				case 'mount-corrective': { // §5.10 per-token corrective loop
					const w = this.watcherByName(e.watcher);
					if (w === undefined) break;
					this.bumpInBatch(w.id, e.token);
					break;
				}
				case 'mount-urgent-correction': // §5.10 urgent pre-paint compare fix
				case 'reconcile-correction': { // §4.2 step 3 durable drain correction
					const w = this.watcherByName(e.watcher);
					if (w === undefined) break;
					this.bumpInBatch(w.id, undefined); // discrete-urgent fallback lane
					break;
				}
				case 'dev-warning': {
					this.devWarn(e.message);
					break;
				}
				default:
					break;
			}
		}
	}

	private watcherByName(name: string): Watcher | undefined {
		// Watcher names are minted as `w${id}` by the hooks (one map probe).
		const id = Number(name.slice(1));
		return this.bridge.watchers.get(id);
	}

	/**
	 * setState in the batch's own lane via unstable_runInBatch; bridge tokens
	 * without a live fork counterpart (bridge-ambient, retired) take the
	 * documented discrete-urgent fallback (runInBatch with an unknown token).
	 */
	private bumpInBatch(watcherId: number, bridgeToken: TokenId | undefined): void {
		const target = this.targets.get(watcherId);
		if (target === undefined || !target.live) return;
		const forkToken = bridgeToken === undefined ? 0 : (this.forkTokenByBridge.get(bridgeToken) ?? 0);
		React.unstable_runInBatch(forkToken, () => target.bump());
	}

	// ---- write classification (§3.5) --------------------------------------------

	/** The one write entry for adopted atoms: whole ops, batch-context classified. */
	classifyWrite(node: AtomNode, op: Op): void {
		if (React.unstable_getRenderContext() !== null) {
			throw new Error('cosignal: signal write during render (§3.6 — write from an event handler or effect instead)');
		}
		const forkToken = React.unstable_getCurrentWriteBatch();
		this.withBridge(() => {
			if (forkToken === 0) {
				this.bridge.bareWrite(node, op); // pre-provider / non-React context
			} else {
				const tokenId = this.bridgeTokenFor(forkToken);
				// §3.5 dev-warning heuristic: a non-deferred (bare-context-shaped)
				// write while an action is parked. The shipped protocol bit cannot
				// distinguish a discrete handler's token from a timer's ambient
				// default token, so this lint can over-trigger on handler writes
				// during someone's action — documented heuristic imprecision.
				const t = this.bridge.tokens.get(tokenId);
				if (
					t !== undefined &&
					!t.action &&
					(forkToken & 1) === 0 &&
					this.bridge.liveTokens().some((lt) => lt.parked)
				) {
					this.devWarn('a signal write after await landed outside the action — wrap it in startTransition or use the action scope (§3.5)');
				}
				this.bridge.write(tokenId, node, op);
			}
		});
		// §5.11: a write into a token already locked into some root's committed
		// table flips committed-for-root truth immediately (membership clause) —
		// no fork event will follow until much later, so revalidate now.
		const mapped = forkToken === 0 ? undefined : this.bridgeTokenByFork.get(forkToken);
		if (mapped !== undefined) {
			for (const [rootId, root] of this.bridge.roots) {
				if (root.committedTokens.has(mapped)) this.revalidateEffects(rootId);
			}
		}
	}

	/** ActionScope writes (§3.2): classify into the action's token from anywhere. */
	scopeWrite(bridgeToken: TokenId, node: AtomNode, op: Op): void {
		if (React.unstable_getRenderContext() !== null) {
			throw new Error('cosignal: signal write during render (§3.6)');
		}
		this.withBridge(() => this.bridge.scopeWrite(bridgeToken, node, op));
		for (const [rootId, root] of this.bridge.roots) {
			if (root.committedTokens.has(bridgeToken)) this.revalidateEffects(rootId);
		}
	}

	// ---- useSignalEffect machinery (§5.11) ---------------------------------------

	registerEffect(root: RootId, refire: () => void): number {
		const id = nextEffectSerial++;
		this.effects.set(id, { id, root, deps: [], rootCommitGen: this.bridge.root(root).commitGen, refire, live: true });
		return id;
	}

	unregisterEffect(id: number): void {
		const rec = this.effects.get(id);
		if (rec !== undefined) rec.live = false;
		this.effects.delete(id);
	}

	/** Runs an effect body with committed-for-root read capture; stores the snapshot. */
	captureEffectRun(id: number, body: () => void): void {
		const rec = this.effects.get(id);
		if (rec === undefined) return;
		const saved = this.effectCapture;
		this.effectCapture = { root: rec.root, deps: [] };
		try {
			body();
		} finally {
			rec.deps = this.effectCapture.deps;
			rec.rootCommitGen = this.bridge.root(rec.root).commitGen;
			this.effectCapture = saved;
		}
	}

	/** Committed-for-root read during an effect fire (records the dep). */
	private effectRead(node: AnyNode): Value {
		const cap = this.effectCapture!;
		const value = this.bridge.committedValue(node, cap.root);
		cap.deps.push({ node, value });
		return value;
	}

	/** §5.11 flush: revalidate fingerprints (value-compared; re-run on change). */
	revalidateEffects(rootId?: RootId): void {
		for (const rec of [...this.effects.values()]) {
			if (!rec.live || (rootId !== undefined && rec.root !== rootId)) continue;
			const gen = this.bridge.root(rec.root).commitGen;
			const genMoved = gen !== rec.rootCommitGen;
			let changed = false;
			for (const dep of rec.deps) {
				let now: Value;
				try {
					now = this.bridge.committedValue(dep.node, rec.root);
				} catch (err) {
					if (err instanceof SuspendedRead) continue; // pending capsule: not a flip
					throw err;
				}
				if (!Object.is(now, dep.value)) {
					changed = true;
					break;
				}
			}
			if (genMoved) rec.rootCommitGen = gen; // header revalidated (value-gated)
			if (changed && rec.live) rec.refire();
		}
	}

	// ---- adoption + instance patching ---------------------------------------------

	/** The bridge node for a public Atom/ReducerAtom, adopting on first use. */
	nodeForAtom(atom: Atom<unknown>): AtomNode {
		const patchable = atom as PatchableAtom;
		const bound = patchable[BOUND];
		if (bound !== undefined && bound.shim === this) return bound.node;
		const existing = this.bridge.byKernelId.get(atom._id);
		if (existing !== undefined) {
			patchable[BOUND] = { shim: this, node: existing };
			return existing;
		}
		// Adopt through a TWIN handle (prototype routing skips it) so the
		// bridge's own kernel applies (applyToKernel -> handle.set) and kernel
		// reads (kernelValueOf -> handle.state) take the original paths and the
		// logged table's bridgeApplying route — no classify recursion.
		const twin = Object.create(Atom.prototype) as PatchableAtom;
		Object.defineProperty(twin, '_id', { value: atom._id });
		Object.defineProperty(twin, '_isEqual', { value: atom._isEqual });
		twin[TWIN] = true;
		const label = atom.label ?? `atom#${atom._id}`;
		const node = this.bridge.adoptAtom(label, twin, atom._isEqual);
		if (atom instanceof ReducerAtom) {
			node.reducer = (state, action) => (atom.reduce as (s: unknown, a: unknown) => unknown)(state, action);
		}
		patchable[BOUND] = { shim: this, node };
		return node;
	}

	/**
	 * Prototype-routed `.state` read: adopted atoms route through the world
	 * ladder; un-adopted atoms adopt on demand when a routing context (bound
	 * evaluation frame, effect capture, tracked render pass) is active, and
	 * otherwise stay on the original kernel path (LOGGED-quiet).
	 */
	readState(atom: PatchableAtom): unknown {
		const bound = atom[BOUND];
		if (bound !== undefined && bound.shim === this) return this.routeRead(bound.node, atom);
		if (this.bridge.byKernelId.has(atom._id)) return this.routeRead(this.nodeForAtom(atom), atom);
		const inContext =
			this.evalStack.length > 0 || this.effectCapture !== undefined || this.renderingRoot()?.pass !== undefined;
		if (!inContext) return originalStateGet.call(atom);
		return this.routeRead(this.nodeForAtom(atom), atom);
	}

	/**
	 * Read routing for a patched atom's `.state` (§5.6's world path, at the
	 * binding level): inside a bound-computed evaluation -> the frame's tracked
	 * reader (K1 edge + world fold); inside an effect fire -> committed-for-root
	 * capture; during a tracked render pass -> the pass's world (§3.2 "routes
	 * the read through the current pass's world"); otherwise the kernel path.
	 */
	routeRead(node: AtomNode, atom: Atom<unknown>): unknown {
		const frame = this.evalStack[this.evalStack.length - 1];
		if (frame !== undefined) {
			const value = frame.read(node);
			frame.readLog.push([node.id, value]);
			return value;
		}
		if (this.effectCapture !== undefined) return this.effectRead(node);
		const rendering = this.renderingRoot();
		if (rendering?.pass !== undefined && rendering.pass.state !== 'ended') {
			return this.bridge.passValue(node, rendering.pass);
		}
		return originalStateGet.call(atom);
	}

	// ---- bound computeds + ctx.use capsules (§3.3/§3.4/§5.8) ----------------------

	/** ctx.previous cells: one per node, last COMMITTED value (§3.4, best-effort). */
	previousCells = new Map<number, { value: unknown }>();
	/** >0 while a hook-initiated evaluation may legally suspend the render. */
	private suspendDepth = 0;

	previousCell(nodeId: number): { value: unknown } {
		let cell = this.previousCells.get(nodeId);
		if (cell === undefined) {
			cell = { value: undefined };
			this.previousCells.set(nodeId, cell);
		}
		return cell;
	}

	/**
	 * Mints a bridge computed whose evaluations open a shim frame: patched-atom
	 * and bound-computed reads inside `fn` route through the frame's tracked
	 * reader (K1 edges + world fold), ctx.previous reads the node's committed
	 * cell, and ctx.use keys capsules on the frame's lineage bucket. In
	 * background walks a pending suspension folds to the capsule's stable
	 * SuspendedRead sentinel instead of unwinding (sentinels are cached values,
	 * §5.8); hook-initiated evaluations rethrow so React can suspend.
	 */
	makeComputedNode<T>(label: string, fn: (ctx: BoundCtx<T>) => T, deps: readonly unknown[] = []): ComputedNode {
		const shim = this;
		const fnSrc = String(fn);
		let node: ComputedNode;
		const wrapper = (read: Reader, untracked: Reader): Value => {
			const frame: EvalFrame = { read, untracked, node, fnSrc, deps, useIndex: 0, readLog: [] };
			shim.evalStack.push(frame);
			try {
				const cell = shim.previousCell(node.id);
				const ctx: BoundCtx<T> = {
					get previous(): T | undefined {
						return cell.value as T | undefined;
					},
					use: <V>(source: PromiseLike<V> | (() => PromiseLike<V>)): V => shim.ctxUse(frame, source) as V,
				};
				return fn(ctx);
			} catch (err) {
				if (err instanceof SuspendedRead && shim.suspendDepth === 0) return err; // stable sentinel value
				throw err;
			} finally {
				shim.evalStack.pop();
			}
		};
		node = this.bridge.computed(label, wrapper);
		return node;
	}

	/** §5.8 — positional capsule with value-prefix identity + revalidation. */
	private ctxUse(frame: EvalFrame, source: PromiseLike<unknown> | (() => PromiseLike<unknown>)): unknown {
		const position = frame.useIndex++;
		let entries = this.capsules.get(frame.fnSrc);
		if (entries === undefined) {
			entries = [];
			this.capsules.set(frame.fnSrc, entries);
		}
		for (const existing of entries) {
			if (
				existing.position !== position ||
				!this.depsMatch(existing.deps, frame.deps) ||
				!this.prefixMatches(existing.prefix, frame.readLog)
			) {
				continue;
			}
			if (existing.state === 'fulfilled') return existing.value;
			if (existing.state === 'rejected') throw existing.reason;
			throw existing.sr; // stable per capsule: retries and folds see one identity
		}
		// Mint (a prefix moved by a retirement/rebase refetches from the moved
		// world — v1 accepts duplicate fetches, never stale data; case 15 row 5).
		// The prefix is the reads BEFORE the use() site (§5.8): capture it before
		// the factory runs, and truncate the factory's own reads from the log —
		// they happen at mint only (the factory is skipped on replay), so they
		// can never participate in capsule identity. Read inputs before ctx.use.
		const prefix = frame.readLog.slice();
		const mark = frame.readLog.length;
		const thenable = typeof source === 'function' ? source() : source;
		frame.readLog.length = mark;
		const capsule: Capsule = {
			thenable,
			sr: new SuspendedRead(thenable),
			state: 'pending',
			value: undefined,
			reason: undefined,
			position,
			deps: frame.deps.slice(),
			prefix,
		};
		entries.push(capsule);
		thenable.then(
			(value) => {
				// Settlement identity: only THIS thenable settles THIS capsule.
				if (capsule.thenable === thenable) {
					capsule.state = 'fulfilled';
					capsule.value = value;
				}
			},
			(reason) => {
				if (capsule.thenable === thenable) {
					capsule.state = 'rejected';
					capsule.reason = reason;
				}
			},
		);
		throw capsule.sr;
	}

	private depsMatch(a: readonly unknown[], b: readonly unknown[]): boolean {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
		return true;
	}

	private prefixMatches(prefix: Array<[number, unknown]>, readLog: Array<[number, unknown]>): boolean {
		if (readLog.length < prefix.length) return false;
		for (let i = 0; i < prefix.length; i++) {
			if (prefix[i]![0] !== readLog[i]![0] || !Object.is(prefix[i]![1], readLog[i]![1])) return false;
		}
		return true;
	}

	/** Hook-initiated evaluation: SuspendedRead propagates (React will suspend). */
	evaluateSuspending(fn: () => Value): Value {
		this.suspendDepth++;
		try {
			return fn();
		} finally {
			this.suspendDepth--;
		}
	}

	/** Read routing for a BoundComputed's `.state` (same ladder as atoms). */
	routeComputedRead(node: ComputedNode): unknown {
		const frame = this.evalStack[this.evalStack.length - 1];
		if (frame !== undefined) {
			const value = frame.read(node);
			frame.readLog.push([node.id, value]);
			return value;
		}
		if (this.effectCapture !== undefined) return this.effectRead(node);
		const rendering = this.renderingRoot();
		if (rendering?.pass !== undefined && rendering.pass.state !== 'ended') {
			return this.evaluateSuspending(() => this.bridge.passValue(node, rendering.pass!));
		}
		return this.bridge.newestValue(node);
	}

	/** Register a watcher minted during the current pass (orphan-sweep set). */
	noteMinted(rootRec: RootRec, watcherId: number): void {
		rootRec.minted.add(watcherId);
	}

	// ---- watcher claim / unsubscribe (§5.11 lifecycle) -----------------------------

	/** Layout-effect claim: the committed hook instance owns this watcher. */
	claimWatcher(rec: { node: AnyNode; watcherId: number | undefined; target: WatcherTarget; pendingUnsub: boolean; root: RootId | undefined; lastValue: unknown }): void {
		rec.pendingUnsub = false;
		const w = rec.watcherId === undefined ? undefined : this.bridge.watchers.get(rec.watcherId);
		if (w === undefined) {
			// Reveal without a re-render (bailout) or a swept subscription: mint a
			// fresh watcher outside any React pass and take §5.10's conservative
			// reveal path — a value compare against committed truth, pre-paint.
			this.resubscribeAtLayout(rec);
			return;
		}
		this.claimed.add(w.id);
		rec.target.live = true;
		this.targets.set(w.id, rec.target);
	}

	private resubscribeAtLayout(rec: { node: AnyNode; watcherId: number | undefined; target: WatcherTarget; root: RootId | undefined; lastValue: unknown }): void {
		const root = rec.root ?? 'root-unknown';
		const pass = this.bridge.passStart(root, []);
		let minted: Watcher | undefined;
		try {
			minted = this.bridge.mountWatcher(pass.id, rec.node, 'w?');
			minted.name = `w${minted.id}`;
			this.bridge.deferMount(minted.id); // keep it out of the degenerate pass
		} finally {
			this.bridge.passEnd(pass.id, 'discard');
		}
		if (minted === undefined) return;
		minted.live = true;
		minted.lastRenderedValue = rec.lastValue; // what the committed DOM shows
		rec.watcherId = minted.id;
		this.claimed.add(minted.id);
		rec.target.live = true;
		this.targets.set(minted.id, rec.target);
		// Conservative reveal compare (§5.10 fall-through population).
		const now = this.bridge.committedValue(rec.node, root);
		if (!Object.is(now, rec.lastValue)) this.bumpInBatch(minted.id, undefined);
	}

	/** Debounce-finalized unsubscription (or immediate teardown for retired recs). */
	finalizeUnsub(rec: { watcherId: number | undefined; target: WatcherTarget; pendingUnsub: boolean }): void {
		rec.pendingUnsub = false;
		rec.target.live = false;
		const wid = rec.watcherId;
		if (wid === undefined) return;
		rec.watcherId = undefined;
		this.claimed.delete(wid);
		this.targets.delete(wid);
		const w = this.bridge.watchers.get(wid);
		if (w !== undefined) {
			w.live = false;
			this.bridge.deferMount(wid); // drop from any open pass's mounted list
			this.bridge.watchers.delete(wid);
		}
	}
}

/** The evaluation context bound computeds receive (§3.1/§3.4/§5.8 subset). */
export type BoundCtx<T> = {
	/** Last committed value of this node — a hint only (§3.4). */
	readonly previous: T | undefined;
	/** Reads a thenable; pending suspends via a lineage-keyed capsule (§5.8). */
	use<V>(source: PromiseLike<V> | (() => PromiseLike<V>)): V;
};
