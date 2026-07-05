/**
 * cosignal-react — the protocol shim. One Shim instance couples one
 * CosignalBridge (the concurrent engine of `cosignal`) to a React
 * build implementing the cosignal external-runtime protocol, version 1.
 * Stock React never reveals when it starts, pauses, commits, or discards a
 * render pass — which is exactly what an external store must know to stay
 * tear-free — so a patched React build provides those events, and this shim
 * is the adapter between them and the engine. Its jobs:
 *
 *  - handshake: assert protocol version 1 with every version-1 capability,
 *    on React itself and on every renderer provider; refuse stock or
 *    partially patched builds loudly at startup. Degrading silently would
 *    reintroduce tearing (a single rendered frame mixing old and new
 *    state) later, with no error pointing at the cause.
 *  - protocol events -> bridge: onRenderPassStart(includedBatches,
 *    lineageId) -> passStart; yield/resume -> passYield/passResume;
 *    onRenderPassEnd(committed) -> passEnd('commit') at the moment the
 *    pass commits — before that commit's per-root report and before any
 *    retirement, which is what lets the bridge snapshot committed state as
 *    the baseline for mount fixups (the engine's commit-time reconciliation
 *    of freshly mounted components against updates that were in flight
 *    while they mounted); onRenderPassEnd(discarded) -> passEnd('discard');
 *    onBatchRetired -> retire (or settleAction for a parked async action —
 *    one kept pending until its promise settles); onRootCommitted ->
 *    idempotent reconciliation of the root's committed-batch table +
 *    effect re-checks.
 *  - bridge listeners -> React: the shim registers direct listeners on the
 *    bridge (onDelivery / onMountCorrective / onCorrection / onDevWarning);
 *    the bridge invokes them at each operation's end, and the shim turns
 *    deliveries and mount correctives into setStates via unstable_runInBatch,
 *    so each corrective re-render is scheduled in the lane of the batch that
 *    caused it and the whole update renders and commits together. Deliveries
 *    are value-blind: the bridge decides who must re-render, the shim only
 *    schedules. Tokens with no live protocol counterpart take
 *    unstable_runInBatch's discrete-urgent fallback. The protocol permits
 *    scheduling updates from its yield and commit callbacks, so listening
 *    at those points is legal (writes during render are not, and throw).
 *    The bridge's BridgeEvent LOG is a referee/tracing surface only: it does
 *    not mint unless a referee retains it or a tracer attaches.
 *  - write classification — the rule: a write belongs to the batch context
 *    in which it executes. The CORE's public Atom.set/update/dispatch
 *    capture host-attributable writes as WHOLE operations (worlds replay
 *    receipts, so a functional update must reach the engine unfolded) and
 *    hand them to the classifier this shim installs on the bridge
 *    (`bridge.writeClassifier`). The batch is read from the protocol's
 *    write-context API (unstable_getCurrentWriteBatch /
 *    unstable_isCurrentWriteDeferred); token 0 (no context) falls back to
 *    the bridge's ambient default batch (the engine-opened batch that
 *    adopts writes made outside any explicit batch). Raw `.state` reads
 *    route through the core's host read hook into the bridge's effective
 *    world (evaluation world, else the ambient world this shim maintains
 *    around render passes and effect fires) — no prototype patching
 *    anywhere.
 *  - Suspense capsules: a capsule is the shim's cache record for one
 *    ctx.use call — the thenable plus the inputs that produced it, so the
 *    same async work is reused instead of refetched. ctx.use inside bound
 *    computeds keys capsules on the computed's source and deps, matched by
 *    use-site position and by the values read before that site — the same
 *    inputs resolve to the same thenable in every world and across every
 *    render retry, while a world that genuinely sees different inputs
 *    refetches. See the `capsules` field for why value identity (not node
 *    identity, not a per-render bucket) is the key.
 */

import * as React from 'react';
import { Atom, ReducerAtom, SuspendedRead } from 'cosignal';
import type {
	AnyNode,
	AtomNode,
	ComputedNode,
	CosignalBridge,
	Op,
	Pass,
	Reader,
	RootId,
	TokenId,
	Value,
	Watcher,
} from 'cosignal';

// ---- handshake -------------------------------------------------------------------

export const REQUIRED_PROTOCOL_VERSION = 1;
export const REQUIRED_CAPABILITIES = 511; // every version-1 capability bit (bits 0..8) set

/**
 * Verifies the external-runtime handshake: React.unstable_externalRuntimeProtocol
 * must report protocol version 1 with every version-1 capability, both on React
 * itself and on at least one registered renderer provider (load react-dom/client
 * before registering, or no provider exists yet). Throws on stock React or on a
 * stale patched build. Failing fast is deliberate: without the full protocol the
 * bindings could only fall back to a single current value, which is exactly the
 * tearing this package exists to prevent — one descriptive startup error beats
 * silently wrong frames later.
 */
export function assertForkProtocol(): void {
	const proto = React.unstable_externalRuntimeProtocol;
	if (proto === undefined) {
		throw new Error('cosignal-react: this React build has no external-runtime protocol — cosignal-react requires a React build with external-runtime support.');
	}
	if (proto.version !== REQUIRED_PROTOCOL_VERSION || proto.capabilities !== REQUIRED_CAPABILITIES) {
		throw new Error(
			`cosignal-react: protocol mismatch (version ${proto.version}, capabilities ${proto.capabilities}; ` +
				`need ${REQUIRED_PROTOCOL_VERSION}/${REQUIRED_CAPABILITIES}) — rebuild React and react-dom with matching external-runtime support.`,
		);
	}
	const providers = proto.providerProtocols;
	if (providers.length === 0) {
		throw new Error('cosignal-react: no renderer registered an external-runtime provider — load a react-dom/client build with external-runtime support before registering.');
	}
	for (const p of providers) {
		if (p.version !== REQUIRED_PROTOCOL_VERSION || p.capabilities !== REQUIRED_CAPABILITIES) {
			throw new Error(`cosignal-react: renderer protocol mismatch (${p.version}/${p.capabilities}).`);
		}
	}
}

// ---- shim types ------------------------------------------------------------------

/** A live delivery target: the shim-side handle for one watcher (the
 * engine's record of one subscribed component instance) that can re-render
 * the owning component. */
export type WatcherTarget = {
	/** Schedules a re-render of the owning component (a setState bump). */
	bump: () => void;
	live: boolean;
};

type RootRec = {
	id: RootId;
	container: unknown;
	/** The open bridge pass mirroring the protocol host's in-progress render pass, if any. */
	pass: Pass | undefined;
	/** Lineage id reported at pass start (stable per root × included-batch set). */
	lineageId: number;
	/** Watcher ids minted during the current/most recent pass, for the orphan sweep. */
	minted: Set<number>;
	lastCommitGeneration: number;
};

type EffectRec = {
	id: number;
	root: RootId;
	/** (node, value) pairs read during the last run, in the committed world of the effect's root. */
	deps: Array<{ node: AnyNode; value: Value }>;
	/** The root's commit generation when the snapshot was taken. */
	rootCommitGen: number;
	/** Re-fires the user effect (cleanup + run + re-track). */
	refire: () => void;
	live: boolean;
};

type Capsule = {
	thenable: PromiseLike<unknown>;
	/** Stable sentinel: background evaluations fold a pending capsule to THIS one object, so every world and retry sees a single "still pending" identity. */
	sr: SuspendedRead;
	state: 'pending' | 'fulfilled' | 'rejected';
	value: unknown;
	reason: unknown;
	/** The use() position within the node's evaluation. */
	position: number;
	/** The owning useComputed's deps at mint (closure-input identity). */
	deps: readonly unknown[];
	/** (nodeId, value) pairs read before the use() site at mint — the world-identity prefix. */
	prefix: Array<[number, unknown]>;
};

/** Bookkeeping for one bound-computed evaluation: read routing plus ctx.use state. */
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
type BoundState = { shim: Shim; node: AtomNode };
type BindableAtom = Atom<unknown> & { [BOUND]?: BoundState };

/** Whole-op codes shared with the engine's host write seam. */
type HostOpKind = 0 | 1 | 2;

function opOf(kind: HostOpKind, payload: unknown): Op {
	if (kind === 0) return { kind: 'set', value: payload };
	if (kind === 1) return { kind: 'update', fn: payload as (prev: Value) => Value };
	return { kind: 'dispatch', action: payload };
}

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
	 * EVERY world and across every retry. Node identity is deliberately NOT
	 * the key — when a mount suspends, React discards the in-progress
	 * component and retries it from scratch, so the retry re-creates the hook
	 * state and with it the computed node; node-keyed capsules would miss on
	 * every retry and refetch forever, never settling. Instead a world's
	 * identity is carried by the values its replay produced: a retry of the
	 * same render replays the same values and reuses the capsule; a world
	 * moved by a retirement or a different batch set replays different values
	 * and refetches. Two worlds that replay identical inputs share one
	 * capsule rather than refetching — sound, because worlds are pure replays,
	 * so identical inputs mean observationally identical evaluations. The
	 * trade: an occasional duplicate fetch is accepted; stale data never is.
	 */
	private capsules = new Map<string, Capsule[]>();
	/** The bridge evaluation frames opened by bound computeds (innermost last). */
	private evalStack: EvalFrame[] = [];
	/** Set while an effect fire is tracking committed-for-root reads. */
	private effectCapture: { root: RootId; deps: Array<{ node: AnyNode; value: Value }> } | undefined;

	constructor(bridge: CosignalBridge) {
		this.bridge = bridge;
		assertForkProtocol();
		// The engine's host seams: the core's public Atom methods route
		// host-attributable writes (whole ops) to the classifier, and routed
		// reads to the effective world; the observer feeds evaluation read
		// logs (capsule identity) and effect dependency snapshots.
		bridge.writeClassifier = (atom, kind, payload) => {
			this.classifyWrite(this.nodeForAtom(atom), opOf(kind as HostOpKind, payload));
		};
		bridge.readAdopter = (atom) => this.nodeForAtom(atom);
		// The ambient-world provider answers from the LIVE call context, per
		// read: an effect fire resolves committed-for-root; a render resolves
		// its own pass's world via the protocol's render context (stack-
		// accurate — a COMPLETED-but-uncommitted pass is not "in render", and
		// interleaved roots each see their own pass); anything else resolves
		// newest (undefined).
		bridge.setWorldProvider(() => {
			const cap = this.effectCapture;
			if (cap !== undefined) return { kind: 'committed', root: cap.root };
			const rendering = this.renderingRoot();
			if (rendering?.pass !== undefined && rendering.pass.state !== 'ended') {
				return { kind: 'pass', pass: rendering.pass };
			}
			return undefined;
		});
		bridge.readObserver = (node, value) => {
			const frame = this.evalStack[this.evalStack.length - 1];
			if (frame !== undefined) {
				frame.readLog.push([node.id, value]);
				return;
			}
			this.effectCapture?.deps.push({ node, value });
		};
		// Direct listeners — the load-bearing consumption surface. The bridge's
		// event LOG stays a referee/tracing artifact (it does not mint unless a
		// referee retains it or a tracer attaches); scheduling decisions arrive
		// here as live objects, allocation-free. Listener bodies must never
		// throw into the engine mid-operation: failures are recorded.
		bridge.onDelivery = (w, token) => {
			try {
				this.bumpInBatch(w.id, token.id); // re-render in the write's own batch
			} catch (error) {
				this.errors.push(error);
			}
		};
		bridge.onMountCorrective = (w, token) => {
			try {
				this.bumpInBatch(w.id, token.id); // join a still-live batch this mount's render missed
			} catch (error) {
				this.errors.push(error);
			}
		};
		bridge.onCorrection = (w) => {
			try {
				this.bumpInBatch(w.id, undefined); // urgent pre-paint fix: discrete-urgent fallback lane
			} catch (error) {
				this.errors.push(error);
			}
		};
		bridge.onDevWarning = (message) => {
			try {
				this.devWarn(message);
			} catch (error) {
				this.errors.push(error);
			}
		};
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
		this.bridge.writeClassifier = undefined;
		this.bridge.readAdopter = undefined;
		this.bridge.readObserver = undefined;
		this.bridge.onDelivery = undefined;
		this.bridge.onMountCorrective = undefined;
		this.bridge.onCorrection = undefined;
		this.bridge.onDevWarning = undefined;
		this.bridge.setWorldProvider(undefined);
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

	/** The bridge batch token mirroring a protocol batch token (minted on first sight). */
	bridgeTokenFor(forkToken: number, opts?: { action?: boolean }): TokenId {
		const existing = this.bridgeTokenByFork.get(forkToken);
		if (existing !== undefined) {
			if (opts?.action === true) {
				// Every transition started inside one event shares one protocol
				// batch token, so the token may already exist when an action
				// starts: upgrade it in place to action semantics (parked — kept
				// pending — until the action settles).
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

	/** The root whose pass is currently rendering, if any. The protocol resolves the render context from the current call stack, so this is only meaningful synchronously during a render. */
	renderingRoot(): RootRec | undefined {
		const ctx = React.unstable_getRenderContext();
		if (ctx === null) return undefined;
		return this.rootsByContainer.get(ctx.container);
	}

	// ---- protocol listener -> bridge --------------------------------------------

	private handlePassStart(container: unknown, includedBatches: readonly number[], lineageId: number): void {
		const rec = this.rootRec(container);
		if (rec.pass !== undefined && rec.pass.state !== 'ended') {
			// Defensive: the protocol host ends a pass frame before restarting it,
			// so a still-open pass here means the two sides desynced — discard it
			// and record the failure loudly in the error log.
			this.bridge.passEnd(rec.pass.id, 'discard');
			this.errors.push(new Error(`cosignal-react: stale open pass on ${rec.id} at passStart`));
		}
		const known: TokenId[] = [];
		for (const forkToken of includedBatches) {
			// Only protocol batches carrying cosignal writes have bridge tokens.
			// A pure-React batch contributed no receipts, and a world is computed
			// purely by replaying receipts, so leaving that batch out of the
			// pass's batch set cannot change any value the pass observes.
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
		this.bridge.passYield(rec.pass.id);
	}

	private handleResume(container: unknown): void {
		const rec = this.rootsByContainer.get(container);
		if (rec?.pass === undefined || rec.pass.state === 'ended') return;
		this.bridge.passResume(rec.pass.id);
	}

	private handlePassEnd(container: unknown, committed: boolean): void {
		const rec = this.rootsByContainer.get(container);
		if (rec?.pass === undefined || rec.pass.state === 'ended') return;
		const pass = rec.pass;
		if (!committed) {
			// Discard: pass-owned mounts die in the bridge; drop their targets too.
			this.bridge.passEnd(pass.id, 'discard');
			for (const wid of rec.minted) {
				if (!this.claimed.has(wid)) this.targets.delete(wid);
			}
			rec.minted = new Set();
			rec.pass = undefined;
			return;
		}
		// The end(commit) event is where the bridge captures its baseline:
		// bridge.passEnd snapshots committed state and the root's commit
		// generation on entry — before it locks this pass's batches into the
		// root's committed table, and before the protocol's onRootCommitted /
		// onBatchRetired events for the same commit arrive. The mount fixup
		// for watchers minted this pass runs inside passEnd; the corrective
		// re-renders it emits reach React through the direct listeners
		// (delivered at the operation boundary, inside this call).
		this.bridge.passEnd(pass.id, 'commit');
		rec.pass = undefined;
		// ctx.previous cells must hold the last COMMITTED value — a pending
		// render's value must never leak into the hint, because a pending
		// transition may still be discarded — so update the cells from every
		// watcher this commit rendered or mounted.
		for (const wid of [...pass.rendered, ...pass.mounted]) {
			const w = this.bridge.watchers.get(wid);
			if (w !== undefined && !(w.lastRenderedValue instanceof SuspendedRead)) {
				this.previousCell(w.node).value = w.lastRenderedValue;
			}
		}
		// Orphan sweep. In development StrictMode React invokes render twice to
		// surface impure renders, so even a committed pass can mint watchers
		// whose hook instance was thrown away and will never be claimed. Layout
		// effects run synchronously inside the commit, so by the time this
		// microtask runs every claim has happened — any watcher minted by this
		// pass and still unclaimed is dead.
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
		if (t.parked) this.bridge.settleAction(mapped, committed); // async action reached settlement
		else this.bridge.retire(mapped, committed); // batch done everywhere: its writes become permanent history
		this.bridgeTokenByFork.delete(forkToken);
		this.forkTokenByBridge.delete(mapped);
		this.revalidateEffects(); // retirement/settlement can move committed values: re-check effects
	}

	private handleRootCommitted(container: unknown, committedBatches: readonly number[], generation: number): void {
		const rec = this.rootRec(container);
		rec.lastCommitGeneration = generation;
		// The bridge already locked the committing pass's batch set into the
		// root's committed table at passEnd(commit). The protocol's per-root
		// commit report is a delta (one batch's work can reach the screen
		// across more than one flush), and re-reporting a batch is defined as
		// idempotent set-add — so reconcile any reported batch the passEnd
		// sweep missed. Defensive: for batches with bridge tokens the pass's
		// set already covers the delta by construction.
		const root = this.bridge.root(rec.id);
		for (const forkToken of committedBatches) {
			const mapped = this.bridgeTokenByFork.get(forkToken);
			if (mapped === undefined) continue;
			const t = this.bridge.tokens.get(mapped);
			if (t === undefined || t.state !== 'live' || root.committedTokens.has(mapped)) continue;
			root.committedTokens.add(mapped);
			root.commitGen++;
		}
		// Every root commit is an effect re-check trigger. The re-check compares
		// values, so a commit that moved nothing an effect read is a no-op.
		this.revalidateEffects(rec.id);
	}

	// ---- direct listeners -> React ---------------------------------------------
	// (Registered in the constructor: deliveries and mount correctives bump in
	// the causing batch's lane; urgent/reconcile corrections take the
	// discrete-urgent fallback; dev warnings surface once per message. The
	// bridge delivers them at the end of each engine operation — the same
	// timing the old post-op event drain had.)

	/**
	 * Schedules a re-render (a setState bump) in the batch's own lane via
	 * unstable_runInBatch, so the re-render renders and commits together with
	 * the batch that caused it. Bridge tokens without a live protocol
	 * counterpart (the bridge's ambient default batch, or an already-retired
	 * batch) pass token 0, which unstable_runInBatch defines as a
	 * discrete-urgent fallback.
	 */
	private bumpInBatch(watcherId: number, bridgeToken: TokenId | undefined): void {
		const target = this.targets.get(watcherId);
		if (target === undefined || !target.live) return;
		const forkToken = bridgeToken === undefined ? 0 : (this.forkTokenByBridge.get(bridgeToken) ?? 0);
		React.unstable_runInBatch(forkToken, () => target.bump());
	}

	// ---- write classification -----------------------------------------------------

	/** The single write entry for adopted atoms: records the WHOLE operation, classified into the batch context the write executes in. */
	classifyWrite(node: AtomNode, op: Op): void {
		if (React.unstable_getRenderContext() !== null) {
			throw new Error('cosignal: signal write during render — write from an event handler or effect instead');
		}
		const forkToken = React.unstable_getCurrentWriteBatch();
		if (forkToken === 0) {
			this.bridge.bareWrite(node, op); // pre-provider / non-React context
		} else {
			const tokenId = this.bridgeTokenFor(forkToken);
			// Dev-warning heuristic. After an await, code runs on a fresh call
			// stack with no ambient transition context, so a bare write lands
			// urgent — while an async action is pending that is usually a bug
			// (the author meant the write to join the action; the fix is the
			// action scope or a fresh startTransition). Warn on a non-deferred
			// write while any action is parked. The protocol exposes only one
			// bit (deferred or not), which cannot distinguish a discrete
			// handler's token from a timer's ambient token, so this lint can
			// over-trigger on genuine handler writes during someone else's
			// action — accepted imprecision for a dev-only warning.
			const t = this.bridge.tokens.get(tokenId);
			if (
				t !== undefined &&
				!t.action &&
				(forkToken & 1) === 0 &&
				this.bridge.liveTokens().some((lt) => lt.parked)
			) {
				this.devWarn('a signal write after await landed outside the action — wrap it in startTransition or use the action scope');
			}
			this.bridge.write(tokenId, node, op);
		}
		// A write into a batch already locked into some root's committed table
		// changes that root's committed world immediately: committed state is
		// "replay every committed batch's receipts", and this batch just gained
		// a receipt. No protocol event will announce it (the batch already
		// committed), so re-check effects now.
		const mapped = forkToken === 0 ? undefined : this.bridgeTokenByFork.get(forkToken);
		if (mapped !== undefined) {
			for (const [rootId, root] of this.bridge.roots) {
				if (root.committedTokens.has(mapped)) this.revalidateEffects(rootId);
			}
		}
	}

	/** Action-scope writes: classify into the action's batch explicitly, from anywhere — including after an await. */
	scopeWrite(bridgeToken: TokenId, node: AtomNode, op: Op): void {
		if (React.unstable_getRenderContext() !== null) {
			throw new Error('cosignal: signal write during render — write from an event handler or effect instead');
		}
		this.bridge.scopeWrite(bridgeToken, node, op);
		for (const [rootId, root] of this.bridge.roots) {
			if (root.committedTokens.has(bridgeToken)) this.revalidateEffects(rootId);
		}
	}

	// ---- useSignalEffect machinery -------------------------------------------------

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
		// While set, the world provider resolves raw atom reads committed-for-
		// root, and the read observer lands them in the dependency snapshot.
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

	/** Re-checks effect snapshots against the committed world of each effect's root (value-compared; re-fires on change). */
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
			if (genMoved) rec.rootCommitGen = gen; // generation caught up; re-firing stays value-gated
			if (changed && rec.live) rec.refire();
		}
	}

	// ---- adoption + instance patching ---------------------------------------------

	/**
	 * The bridge node for a public Atom/ReducerAtom, adopting on first use.
	 * The original handle IS the bridge's kernel handle: the engine's own
	 * kernel applies/reads re-enter the public methods with the host hooks'
	 * recursion guard down, so no shadow handle is needed.
	 */
	nodeForAtom(atom: Atom<unknown>): AtomNode {
		const bindable = atom as BindableAtom;
		const bound = bindable[BOUND];
		if (bound !== undefined && bound.shim === this) return bound.node;
		const existing = this.bridge.byKernelId.get(atom._id);
		if (existing !== undefined) {
			bindable[BOUND] = { shim: this, node: existing };
			return existing;
		}
		const label = atom.label ?? `atom#${atom._id}`;
		const node = this.bridge.adoptAtom(label, atom as Atom<Value>, atom._isEqual);
		if (atom instanceof ReducerAtom) {
			node.reducer = (state, action) => (atom.reduce as (s: unknown, a: unknown) => unknown)(state, action);
		}
		bindable[BOUND] = { shim: this, node };
		return node;
	}

	// ---- bound computeds + ctx.use capsules -----------------------------------------

	/** ctx.previous cells: one per node, holding the last COMMITTED value (a best-effort hint; may be stale or undefined). */
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
	 * reader (dependency edges in the kernel, values folded in the evaluating
	 * world), ctx.previous reads the node's last-committed cell, and ctx.use
	 * resolves capsules against the frame's identity (source, deps, use-site
	 * position, value prefix). When the engine evaluates the node in the
	 * background — no component rendering — a pending suspension folds to the
	 * capsule's stable SuspendedRead sentinel instead of unwinding, so "still
	 * pending" caches like any other value; hook-initiated evaluations rethrow
	 * it so React can suspend the component.
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

	/** ctx.use: capsule lookup by (source, deps, use-site position, value prefix); mints a capsule and suspends on miss. */
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
		// Miss: mint a fresh capsule. A prefix moved by a retirement or a
		// changed batch set means this world genuinely sees different inputs,
		// so it refetches (a duplicate fetch is acceptable; stale data is not).
		// The identity prefix is the reads BEFORE the use() site: capture it
		// before the factory runs, then truncate the factory's own reads from
		// the log — the factory runs at mint only (an evaluation that matches
		// an existing capsule never re-runs it), so reads inside it can never
		// participate in capsule identity. Read your inputs before ctx.use.
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

	/** Read routing for a BoundComputed's `.state` (same routing order as routeRead). */
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

	// ---- watcher claim / unsubscribe ------------------------------------------------

	/** Layout-effect claim: the committed hook instance owns this watcher. */
	claimWatcher(rec: { node: AnyNode; watcherId: number | undefined; target: WatcherTarget; pendingUnsub: boolean; root: RootId | undefined; lastValue: unknown }): void {
		rec.pendingUnsub = false;
		const w = rec.watcherId === undefined ? undefined : this.bridge.watchers.get(rec.watcherId);
		if (w === undefined) {
			// Reveal without a re-render (React bailed out) or a swept
			// subscription: mint a fresh watcher outside any React pass and take
			// the conservative reveal path — compare what the committed DOM shows
			// against committed truth, and fix urgently, before paint.
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
		// Conservative reveal compare: fix any drift urgently, pre-paint.
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

/** The evaluation context bound computed functions receive. */
export type BoundCtx<T> = {
	/** Last committed value of this node — a hint only: it may be stale or undefined, and the function must be correct without it. */
	readonly previous: T | undefined;
	/** Reads a thenable; while pending the read suspends via a capsule keyed to this evaluation's inputs, and settlement re-evaluates. */
	use<V>(source: PromiseLike<V> | (() => PromiseLike<V>)): V;
};
