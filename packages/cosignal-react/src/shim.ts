/**
 * cosignal-react — the protocol shim. One Shim instance couples one
 * CosignalBridge (the concurrent engine of `cosignal`) to a React
 * build implementing the cosignal external-runtime protocol.
 * Stock React never reveals when it starts, pauses, commits, or discards a
 * render pass — which is exactly what an external store must know to stay
 * tear-free — so a patched React build provides those events, and this shim
 * is the adapter between them and the engine. Its jobs:
 *
 *  - fork detection: refuse stock React loudly at startup (the protocol's
 *    entry points simply don't exist there). Degrading silently would
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
 *    one kept pending until its promise settles) — React's committed/
 *    abandoned bit stops in that handler, the site where the fact is born:
 *    retirement is disposition-blind (recorded writes never revert either
 *    way), and the handler records the report as a batch-disposition trace
 *    record when a tracer is attached; onRootCommitted ->
 *    idempotent reconciliation of the root's committed-batch table +
 *    effect re-checks.
 *  - bridge listeners -> React: the shim registers direct listeners on the
 *    bridge (onDelivery / onMountCorrective / onCorrection);
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
 *    in which it executes. The CORE's public Atom.set/update (dispatch is a
 *    thin layer over update) capture host-attributable writes as WHOLE
 *    operations (worlds replay receipts, so a functional update must reach
 *    the engine unfolded) and
 *    hand them to the classifier this shim installs on the bridge
 *    (`bridge.writeClassifier`). The batch is read from the protocol's
 *    write-context API (unstable_getCurrentWriteBatch, whose low bit is
 *    the deferred flag); token 0 (no provider registered) is unreachable
 *    once a renderer has loaded and defensively falls back to the bridge's
 *    ambient default batch (retired by the shim's own policy). Raw `.state` reads
 *    route through the core's host read hook into the bridge's effective
 *    world (evaluation world, else the ambient world this shim maintains
 *    around render passes and effect fires) — no prototype patching
 *    anywhere.
 *  - Suspense: the core's `ctx.use` is the ONE implementation (two forms:
 *    caller-cached thenable, and a per-key cache scoped to the living node —
 *    see ComputedCtx.use in cosignal). Bound computeds delegate to it with a
 *    node-scoped cache holder that lives and dies with the node. The shim's
 *    only suspense job is translation: background world evaluations fold a
 *    pending suspension to its stable SuspendedRead sentinel (so "still
 *    pending" caches and compares like any value), while hook-initiated
 *    evaluations let it unwind so the hooks can rethrow the thenable into
 *    React Suspense.
 */

import * as React from 'react';
import { Atom, SuspendedRead, type ComputedCtx } from 'cosignal';
import type {
	AnyNode,
	AtomNode,
	CosignalBridge,
	Op,
	Pass,
	RootId,
	TokenId,
	Value,
	Watcher,
} from 'cosignal';

// ---- fork detection --------------------------------------------------------------

/**
 * Asserts the loaded React build implements the external-runtime protocol
 * (feature detection: the entry points simply do not exist on stock React).
 * Failing fast is deliberate: without the protocol the bindings could only
 * fall back to a single current value, which is exactly the tearing this
 * package exists to prevent — one descriptive startup error beats silently
 * wrong frames later.
 */
export function assertForkPresent(): void {
	if (typeof React.unstable_subscribeToExternalRuntime !== 'function') {
		throw new Error(
			'cosignal-react: this React build has no external-runtime support — cosignal-react requires a React build with external-runtime support (stock React has none).',
		);
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
	/** The open bridge pass mirroring the protocol host's in-progress render pass, if any. */
	pass: Pass | undefined;
	/** Watcher ids minted during the current/most recent pass, for the orphan sweep. */
	minted: Set<number>;
};

/** Fallback root id for effects/watchers minted outside any tracked render
 * pass (defensive paths; both packages name it through this one constant). */
export const ROOT_UNKNOWN: RootId = 'root-unknown';

let nextRootSerial = 1;

/** The one active shim (module registry; hooks.ts manages activation). */
let activeShim: Shim | undefined;

export function setActiveShim(shim: Shim): void {
	activeShim = shim;
}

/** Clears the active-shim slot only if it still points at `shim` — a
 * disposed predecessor's late unregister must never clobber a successor's
 * registration. */
export function unregisterShim(shim: Shim): void {
	if (activeShim === shim) activeShim = undefined;
}

/** The active shim if it is still live. (A shim disposed directly — without
 * its handle's dispose, which unregisters it — can linger in the slot; the
 * liveness filter keeps it from being served or from blocking re-registration.) */
export function getActiveShim(): Shim | undefined {
	return activeShim !== undefined && !activeShim.disposed ? activeShim : undefined;
}

// ---- the shim --------------------------------------------------------------------

export class Shim {
	readonly bridge: CosignalBridge;
	disposed = false;
	/** Listener/translation errors (recorded, not thrown across React's commit). */
	errors: unknown[] = [];
	/** Dev warnings surfaced (shim-local heuristics; console-warned once per message). */
	devWarnings: string[] = [];
	private warned = new Set<string>();

	private unsubscribe: () => void;
	private rootsByContainer = new Map<unknown, RootRec>();
	private bridgeTokenByFork = new Map<number, TokenId>();
	private forkTokenByBridge = new Map<TokenId, number>();
	/** watcher id -> delivery target (registered at render, claimed at layout). */
	targets = new Map<number, WatcherTarget>();
	/** watcher id -> claimed by a committed layout effect (StrictMode orphan sweep). */
	claimed = new Set<number>();
	/**
	 * The React effect-timing shell (the ONE piece of effect machinery that
	 * stays adapter-side): user refire bodies queued by the engine's
	 * per-root-commit boundary scan must NOT run inside onRenderPassEnd —
	 * React captures its re-pend classification before emitting pass end, so
	 * a body write there could desync lock-in accounting (plan amendment 2;
	 * codex review finding 1). While `holdingRefires` is set (around
	 * bridge.passEnd for a COMMIT), refires park here and flush at the
	 * root-commit report (`onRootCommitted` — CR5 orders it right after the
	 * frame close, with no user code in between, so the boundary values are
	 * unchanged). Retirement/settlement refires run at their own operation
	 * boundary, exactly like today's post-`bridge.retire` revalidation did.
	 */
	private holdingRefires = false;
	private heldRefires: (() => void)[] = [];

	constructor(bridge: CosignalBridge) {
		this.bridge = bridge;
		assertForkPresent();
		// The engine's host seams: the core's public Atom methods route
		// host-attributable writes (whole ops) to the classifier, and routed
		// reads to the effective world; the observer feeds effect dependency
		// snapshots.
		bridge.writeClassifier = (atom, op) => {
			this.classifyWrite(this.nodeForAtom(atom), op); // the seam already rebuilt the whole Op
		};
		bridge.readAdopter = (atom) => this.nodeForAtom(atom);
		// The ambient-world provider answers from the LIVE call context, per
		// read: a render resolves its own pass's world via the protocol's
		// render context (stack-accurate — a COMPLETED-but-uncommitted pass is
		// not "in render", and interleaved roots each see their own pass);
		// anything else resolves newest (undefined). Effect fires need no arm
		// here: the ENGINE's captureRun frame owns committed-for-root routing
		// and dependency capture (the promoted mechanism), and the engine
		// consults its own frame before this provider.
		bridge.setWorldProvider(() => {
			const rendering = this.renderingRoot();
			if (rendering?.pass !== undefined && rendering.pass.state !== 'ended') {
				return { kind: 'pass', pass: rendering.pass };
			}
			return undefined;
		});
		// Direct listeners — the load-bearing consumption surface. The bridge's
		// event LOG stays a referee/tracing artifact (it does not mint unless a
		// referee retains it or a tracer attaches); scheduling decisions arrive
		// here as live objects, allocation-free. Listener bodies must never
		// throw into the engine mid-operation: failures are recorded.
		// One listener error policy: guard() — which also closes the disposed
		// window the hand-rolled try/catch these replaced lacked (post-dispose
		// bridge callbacks are now no-ops instead of relying on the cleared
		// `targets` map to degrade safely).
		bridge.onDelivery = (w, token) => this.guard(() => this.bumpInBatch(w.id, token.id)); // re-render in the write's own batch
		bridge.onMountCorrective = (w, token) => this.guard(() => this.bumpInBatch(w.id, token.id)); // join a still-live batch this mount's render missed
		bridge.onCorrection = (w) => this.guard(() => this.bumpInBatch(w.id, undefined)); // urgent pre-paint fix: discrete-urgent fallback lane
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
		this.bridge.onDelivery = undefined;
		this.bridge.onMountCorrective = undefined;
		this.bridge.onCorrection = undefined;
		this.bridge.setWorldProvider(undefined);
		this.targets.clear();
		this.heldRefires.length = 0;
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
				pass: undefined,
				minted: new Set(),
			};
			this.rootsByContainer.set(container, rec);
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
		const token = this.bridge.openBatch({
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

	private handlePassStart(container: unknown, includedBatches: readonly number[], _lineageId: number): void {
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
			this.maybeRetireAmbient(); // the closing pass may have been the last thing keeping ambient pending
			return;
		}
		// The end(commit) event is where the bridge captures its baseline:
		// bridge.passEnd snapshots committed state and the root's commit
		// generation on entry — before it locks this pass's batches into the
		// root's committed table, and before the protocol's onRootCommitted /
		// onBatchRetired events for the same commit arrive. The mount fixup
		// for watchers minted this pass runs inside passEnd; the corrective
		// re-renders it emits reach React through the direct listeners
		// (delivered at the operation boundary, inside this call). Effect
		// REFIRES the commit's boundary scan queues are HELD here and flushed
		// at the root-commit report (see holdingRefires) — pass-end precedes
		// React's re-pend classification, the report follows it.
		this.holdingRefires = true;
		try {
			this.bridge.passEnd(pass.id, 'commit');
		} finally {
			this.holdingRefires = false;
		}
		rec.pass = undefined;
		this.maybeRetireAmbient(); // the closing pass may have been the last thing keeping ambient pending
		// (ctx.previous cells update inside bridge.passEnd since S-C — the
		// cells live on the bridge's computed nodes with the ctx adapter.)
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
				// removeWatcher, never a bare watchers.delete: the engine keeps a
				// per-node watcher index next to the id map, and a map-only delete
				// strands the index entry (dead watchers then seed the engine's
				// sweeps and quiescence refreshes forever).
				this.bridge.removeWatcher(wid);
				this.targets.delete(wid);
			}
		});
	}

	private handleBatchRetired(forkToken: number, committed: boolean): void {
		this.flushHeldRefires(); // defensive: nothing stays parked past its commit's own events
		const mapped = this.bridgeTokenByFork.get(forkToken);
		if (mapped === undefined) return; // no cosignal writes rode this batch
		const t = this.bridge.tokens.get(mapped);
		if (t === undefined || t.state !== 'live') return;
		// The committed/abandoned fact is BORN here — React's own report about
		// its batch. Retirement is disposition-blind (recorded writes never
		// revert either way), so the flag goes no further than this diagnostic
		// record, minted straight into the bridge's tracer when one is
		// attached. Batches with no protocol report (the ambient batch below)
		// mint none.
		const tr = this.bridge.trace;
		if (tr !== undefined) tr.batchDisposition(mapped, committed);
		// Retirement/settlement ARE effect boundaries now (RCC-EF2 amended):
		// the engine's boundary scan runs inside retire/settleAction and
		// queued refires fire at the operation boundary, inside this call —
		// the same observable point as the old post-retire revalidation.
		if (t.parked) this.bridge.settleAction(mapped); // async action reached settlement
		else this.bridge.retire(mapped); // batch done everywhere: its writes become permanent history
		this.bridgeTokenByFork.delete(forkToken);
		this.forkTokenByBridge.delete(mapped);
		this.maybeRetireAmbient(); // the last protocol retirement may close the ambient batch's pending window
	}

	/**
	 * Ambient-batch retirement policy — the shim owns it because no protocol
	 * batch mirrors the engine's ambient default batch (it is minted engine-
	 * side for context-free writes), so no `onBatchRetired` will ever name it.
	 * Ambient content is sync-committed by definition — a context-free write
	 * is urgent truth the moment it lands — so the batch retires as soon as
	 * nothing else is in flight: no live non-ambient token and no open pass.
	 * Checked after every event that can close that window (a bare write
	 * itself, a protocol batch retirement, a pass end). Leaving it live
	 * would permanently block quiet-mode re-arming, tape compaction, and
	 * quiescence, and keep ambient writes out of every committed world.
	 */
	private maybeRetireAmbient(): void {
		const b = this.bridge;
		const ambientId = b.ambientToken;
		if (ambientId === undefined) return;
		const ambient = b.tokens.get(ambientId);
		if (ambient === undefined || ambient.state !== 'live') return;
		for (const t of b.tokens.values()) {
			if (t.state === 'live' && !t.ambient) return; // the pending window is still open
		}
		for (const p of b.passes.values()) {
			if (p.state !== 'ended') return; // an open render still folds pre-retirement state
		}
		b.retire(ambientId); // sync-committed content locks into every committed world
	}

	private handleRootCommitted(container: unknown, committedBatches: readonly number[], _generation: number): void {
		const rec = this.rootRec(container);
		// The bridge already locked the committing pass's batch set into the
		// root's committed table at passEnd(commit). The protocol's per-root
		// commit report is a delta (one batch's work can reach the screen
		// across more than one flush), and re-reporting a batch is defined as
		// idempotent set-add — so reconcile any reported batch the passEnd
		// sweep missed. Defensive: for batches with bridge tokens the pass's
		// set already covers the delta by construction.
		const root = this.bridge.root(rec.id);
		let reconciled = false;
		for (const forkToken of committedBatches) {
			const mapped = this.bridgeTokenByFork.get(forkToken);
			if (mapped === undefined) continue;
			const t = this.bridge.tokens.get(mapped);
			if (t === undefined || t.state !== 'live' || root.committedTokens.has(mapped)) continue;
			root.committedTokens.add(mapped);
			root.commitGen++;
			reconciled = true;
		}
		// The root-commit REPORT is where the commit's effect refires run
		// (React's re-pend classification is behind us; CR5 puts no user code
		// between the frame close and this report, so the boundary values are
		// unchanged). The defensive reconciliation above is itself a
		// committed-truth advance the engine's own boundary scan never saw —
		// re-check that root if it actually added anything.
		this.flushHeldRefires();
		if (reconciled) this.bridge.revalidateCommittedObservers(rec.id);
	}

	/** Runs commit-held effect refires (see holdingRefires). */
	private flushHeldRefires(): void {
		if (this.heldRefires.length === 0) return;
		const held = this.heldRefires.splice(0);
		for (const run of held) {
			try {
				run();
			} catch (error) {
				this.errors.push(error);
			}
		}
	}

	// ---- direct listeners -> React ---------------------------------------------
	// (Registered in the constructor: deliveries and mount correctives bump in
	// the causing batch's lane; urgent/reconcile corrections take the
	// discrete-urgent fallback. The bridge delivers them at the end of each
	// engine operation — the same timing the old post-op event drain had.
	// Dev warnings are shim-local: the post-await lint lives HERE only, in
	// classifyWrite — the engine and the reference model emit no dev events.)

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
			// Defensively retained; UNREACHABLE in practice. Token 0 means
			// "no renderer provider registered" (ReactExternalRuntime returns 0
			// only then), and a renderer registers its provider at module load —
			// after that, getCurrentWriteBatch() mints a token for EVERY write
			// (any call context) with a guaranteed close edge, so no write in
			// the React path is ever context-free. Pinned by the ambient-
			// retirement battery test.
			this.bridge.bareWrite(node, op);
			// If a bare write does land (a future build regression), the ambient
			// batch it minted has no protocol counterpart to close it: retire it
			// one-shot when nothing else is pending.
			this.maybeRetireAmbient();
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
		// moves that root's committed world immediately — but effects are
		// BOUNDARY consumers (RCC-EF2 amended, 2026-07-06): they never re-run
		// mid-write. The engine re-checks their snapshots at the next boundary
		// (retirement, settlement, per-root commit — or this root's frame
		// close if one is open), coalescing every member write before it to
		// one run at the boundary value. Nothing to do here.
	}

	/** Action-scope writes: classify into the action's batch explicitly, from anywhere — including after an await. */
	scopeWrite(bridgeToken: TokenId, node: AtomNode, op: Op): void {
		if (React.unstable_getRenderContext() !== null) {
			throw new Error('cosignal: signal write during render — write from an event handler or effect instead');
		}
		// Member-write effect timing: see classifyWrite — boundary semantics.
		this.bridge.scopeWrite(bridgeToken, node, op);
	}

	// ---- useSignalEffect timing shell -------------------------------------------------
	// The MECHANISM (registration, capture frame, dep snapshots, value-gated
	// boundary re-checks, observation retains) lives in the engine
	// (mountCommittedObserver / captureRun / removeSubscription). What stays
	// here is exactly the React-phase knowledge: refires queued during a
	// COMMIT's pass-end hold until the root-commit report (holdingRefires).

	registerEffect(root: RootId, refire: () => void): number {
		this.bridge.root(root); // materialize the per-root committed table (as before)
		const sub = this.bridge.mountCommittedObserver(root, `effect@${root}`, () => {
			// Invoked by the engine at the boundary operation's end. Inside a
			// commit's pass-end: park until the root-commit report. Everywhere
			// else (retirement, settlement, quiet fold, frame-close flush of a
			// deferred flip): run now — the engine op has fully completed.
			if (this.holdingRefires) this.heldRefires.push(refire);
			else refire();
		});
		return sub.id;
	}

	unregisterEffect(id: number): void {
		if (this.bridge.subs.has(id)) this.bridge.removeSubscription(id);
	}

	/** Runs an effect body under the ENGINE's committed-for-root capture
	 * frame (the promoted mechanism); the engine stores the dep snapshot. */
	captureEffectRun(id: number, body: () => void): void {
		if (!this.bridge.subs.has(id)) return; // torn down between queue and run
		this.bridge.captureRun(id, body);
	}

	// ---- adoption -------------------------------------------------------------------

	/**
	 * The bridge node for a public Atom/ReducerAtom, adopting on first use.
	 * Resolution IS the engine's `bridge.nodeFor` (the one stamp-validate +
	 * registry-probe rule, shared with the host write seam) — this method
	 * only adds adopt-on-miss. The original handle IS the bridge's kernel
	 * handle: the engine's own kernel applies/reads re-enter the public
	 * methods with the host hooks' recursion guard down, so no shadow handle
	 * is needed. Adoption itself is entirely the engine's job (a ReducerAtom
	 * needs no wiring: its dispatch records as an update closure).
	 */
	nodeForAtom(atom: Atom<unknown>): AtomNode {
		return (
			this.bridge.nodeFor(atom) // the engine's one stamp-validate + registry-probe rule
			?? this.bridge.adoptAtom(atom.label ?? `atom#${atom._id}`, atom as Atom<Value>, atom._isEqual)
		);
	}

	// ---- suspense translation ----------------------------------------------------------
	// (The bound-computed machinery — per-fn wrappers, previous cells, the
	// shim evaluation frames — died at S-C: kernel `Computed` handles are the
	// supported type, world-routed through the core's .state read seams, and
	// the engine owns the ctx adapter, the committed previous cells, and the
	// background-suspension fold. What stays here is exactly the React-phase
	// knowledge: hook-initiated evaluations may legally suspend the render.)

	/** Hook-initiated evaluation — the ONE "a hook read may legally suspend"
	 * translation (both halves): the bridge counter tells the engine's ctx
	 * adapter and newest read tail to RETHROW a pending suspension instead of
	 * folding it to a sentinel value, and a SuspendedRead carrier unwraps to
	 * its thenable so React suspends the component. */
	hookRead(fn: () => Value): Value {
		this.bridge.suspendDepth++;
		try {
			return fn();
		} catch (err) {
			if (err instanceof SuspendedRead) throw err.thenable;
			throw err;
		} finally {
			this.bridge.suspendDepth--;
		}
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
		const root = rec.root ?? ROOT_UNKNOWN;
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
		// One engine call retires the watcher from EVERY store it lives in
		// (liveness/observation retain, id map, per-node walk index, open
		// mounted lists) — see CosignalBridge.removeWatcher.
		this.bridge.removeWatcher(wid);
	}
}

/** The evaluation context bound computed functions receive — the core's
 * ComputedCtx verbatim (`previous` hint + the two-form `ctx.use`), served
 * over the bound node's own state. */
export type BoundCtx<T> = ComputedCtx<T>;
