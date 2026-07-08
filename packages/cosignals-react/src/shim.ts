/**
 * cosignals-react — the protocol shim. One Shim instance couples the one cosignals
 * engine (the module-level concurrent engine `cosignals` exports as `engine`;
 * nothing constructs engines) to a React build implementing the cosignals
 * external-runtime protocol.
 * Stock React never reveals when it starts, pauses, commits, or discards a
 * render pass — which is exactly what an external store must know to stay
 * tear-free — so a patched React build provides those events, and this shim
 * is the adapter between them and the engine. Its jobs:
 *
 *  - fork detection: refuse stock React loudly at startup (the protocol's
 *    entry points simply don't exist there). Degrading silently would
 *    reintroduce tearing (a single rendered frame mixing old and new
 *    state) later, with no error pointing at the cause.
 *  - protocol events -> engine: onRenderPassStart(includedBatches) ->
 *    renderStart; yield/resume -> renderYield/renderResume;
 *    onRenderPassEnd(committed) -> renderEnd('commit') at the moment the
 *    render commits — before that commit's per-root report and before any
 *    retirement, which is what lets the engine snapshot committed state as
 *    the baseline for mount fixups (the engine's commit-time reconciliation
 *    of freshly mounted components against updates that were in flight
 *    while they mounted); onRenderPassEnd(discarded) -> renderEnd('discard');
 *    onBatchRetired -> retire (or settleAction for a parked async action —
 *    one kept pending until its promise settles) — React's committed/
 *    abandoned bit stops in that handler, the site where the fact is born:
 *    retirement is disposition-blind (recorded writes never revert either
 *    way), and the handler records the report as a batch-disposition trace
 *    record when a tracer is attached; onRootCommitted ->
 *    idempotent reconciliation of the root's committed-batch table +
 *    effect re-checks.
 *  - The driver: the constructor builds one EngineDriver record and installs
 *    it with `attachDriver` — the engine's single attachment surface (one
 *    driver per engine composition; a second attach throws; only the
 *    test-only engine reset clears the slot). The record carries:
 *      - currentBatch() — the write context, consulted by the engine once
 *        per classified public write (the core's Atom.set/update — dispatch
 *        is a thin layer over update — capture host-attributable writes as
 *        whole operations, because worlds replay log entries, and the engine
 *        dispatches them internally after this one foreign call). The shim
 *        answers from the protocol's write-context API
 *        (unstable_getCurrentWriteBatch — the engine BatchId itself,
 *        allocator-opened at the batch's creation); a write during render
 *        throws here; see `currentBatch` for the BATCH_NONE edge.
 *      - worldFor() — the ambient world for routed reads. Raw `.state` reads
 *        route through the core's read seams into the engine's effective
 *        world (evaluation world, else this provider's answer, resolved from
 *        the live render context) — no prototype patching anywhere.
 *      - onDelivery / onMountCorrective / onCorrection — the consumption
 *        listeners: the engine invokes them at each operation's end, and the
 *        shim turns deliveries and mount correctives into setStates via
 *        unstable_runInBatch, so each corrective re-render is scheduled in
 *        the lane of the batch that caused it and the whole update renders
 *        and commits together. Deliveries are value-blind: the engine
 *        decides who must re-render, the shim only schedules. Batches with
 *        no live protocol counterpart take unstable_runInBatch's
 *        discrete-urgent fallback. The protocol permits scheduling updates
 *        from its yield and commit callbacks, so listening at those points
 *        is legal (writes during render are not, and throw).
 *      - protocolReset() — test-only: scrubs React's batch registry; the
 *        engine reset invokes it first, before scrubbing engine state, so
 *        no stale protocol slot survives into the next composition.
 *    The engine's TraceEvent stream is a test/tracing surface only: it
 *    does not create unless a test retains it or a tracer attaches.
 *  - batch identity (protocol v2) — one id space, no translation: the shim
 *    registers a BATCH-ID ALLOCATOR on the protocol
 *    (unstable_registerBatchIdAllocator). At every React batch's creation
 *    the fork calls it with the batch's deferred classification; the
 *    allocator opens an engine batch (recording `deferred` on it) and
 *    returns the engine BatchId, which React stores as THE batch's identity
 *    for its whole life. Every protocol surface — getCurrentWriteBatch,
 *    runInBatch, the retirement and per-root commit reports, the render
 *    events' included-batch lists — speaks engine BatchIds directly, with
 *    no mapping tables anywhere. BATCH_NONE (0),
 *    named on both sides, is the "no batch context" sentinel.
 *  - Suspense: the core's `ctx.use` is the ONE implementation (two forms:
 *    caller-cached thenable, and a per-key cache scoped to the living node —
 *    see ComputedCtx.use in cosignals). Bound computeds delegate to it with a
 *    node-scoped cache holder that lives and dies with the node. The shim's
 *    only suspense job is translation: background world evaluations fold a
 *    pending suspension to its stable SuspendedRead sentinel (so "still
 *    pending" caches and compares like any value), while hook-initiated
 *    evaluations let it unwind so the hooks can rethrow the thenable into
 *    React Suspense.
 */

import * as React from 'react';
import { Atom, BATCH_NONE, SuspendedRead, attachDriver, engine, type ComputedCtx } from 'cosignals';
import type {
	AnyInternals,
	AtomInternals,
	CosignalEngine,
	EngineDriver,
	RenderPass,
	RootId,
	BatchId,
	Value,
	Watcher,
} from 'cosignals';

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
			'cosignals-react: this React build has no external-runtime support — cosignals-react requires a React build with external-runtime support (stock React has none).',
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
	/** The open engine render mirroring the protocol host's in-progress render, if any. */
	renderPass: RenderPass | undefined;
	/** Watcher ids created during the current/most recent render, for the orphan sweep. */
	created: Set<number>;
};

/** Fallback root id for effects/watchers created outside any tracked
 * render (defensive paths; both packages name it through this one
 * constant). */
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
	/** THE engine surface (`cosignals`'s one module-level engine; the field
	 * keeps the bindings' historical name to spare every call site). */
	readonly bridge: CosignalEngine;
	/** Development-time checks (the engine's EngineResetOptions.devChecks,
	 * snapshotted at registration): armed, protocol-edge states the
	 * integration contract makes unreachable throw, and the post-await
	 * orphan-write warning runs; off, each guarded site is one boolean branch
	 * and the defined fall-through. */
	readonly devChecks: boolean;
	disposed = false;
	/** Listener/translation errors (recorded, not thrown across React's commit). */
	errors: unknown[] = [];
	/** Dev warnings surfaced (shim-local heuristics; console-warned once per message). */
	devWarnings: string[] = [];
	private warned = new Set<string>();

	private unsubscribe: () => void;
	private unregisterAllocator: () => void;
	private rootsByContainer = new Map<unknown, RootRec>();
	/** watcher id -> delivery target (registered at render, claimed at layout). */
	targets = new Map<number, WatcherTarget>();
	/** watcher id -> claimed by a committed layout effect (StrictMode orphan sweep). */
	claimed = new Set<number>();
	/**
	 * The React effect-timing shell (the one piece of effect machinery that
	 * stays adapter-side): user refire bodies queued by the engine's
	 * per-root-commit boundary scan must not run inside onRenderPassEnd —
	 * React captures its re-pend classification before emitting render end,
	 * so a body write there could desync lock-in accounting. While
	 * `holdingRefires` is set (around
	 * bridge.renderEnd for a COMMIT), refires park here and flush at the
	 * root-commit report. THE PROTOCOL'S ORDERING GUARANTEE makes that safe:
	 * the fork emits `onRootCommitted` immediately after the render frame
	 * closes, in the same synchronous commit sequence, with no user code
	 * (effects, event handlers, timers) able to run between the two events —
	 * so the boundary values the engine's scan captured are still the values
	 * when the refires flush. Retirement/settlement refires run at their own
	 * operation boundary.
	 */
	private holdingRefires = false;
	private heldRefires: (() => void)[] = [];

	constructor() {
		this.bridge = engine;
		this.devChecks = engine.devChecks;
		assertForkPresent();
		// THE DRIVER RECORD — the engine's one attachment surface (see the
		// module header). Installed before any React-side registration, so a
		// second registration fails cleanly here (attachDriver throws: one
		// driver per composition) with no protocol listeners left behind.
		const driver: EngineDriver = {
			// The write context — the one foreign call the engine makes per
			// classified public write (dispatch is engine-internal after it).
			currentBatch: () => this.currentBatch(),
			// The ambient-world provider answers from the live call context, per
			// read: a render resolves its own render's world via the protocol's
			// render context (stack-accurate — a COMPLETED-but-uncommitted render
			// is not "in render", and interleaved roots each see their own
			// render); anything else resolves newest (undefined). Effect fires
			// need no arm here: the ENGINE's captureRun frame owns
			// committed-for-root routing and dependency capture (the promoted
			// mechanism), and the engine consults its own frame before this
			// provider.
			worldFor: () => {
				const rendering = this.renderingRoot();
				if (rendering?.renderPass !== undefined && rendering.renderPass.state !== 'ended') {
					return { kind: 'render', render: rendering.renderPass };
				}
				return undefined;
			},
			// Direct listeners — the load-bearing consumption surface. The
			// engine's trace stream stays a test/tracing artifact (it does not
			// create unless a test retains it or a tracer attaches);
			// scheduling decisions arrive here as live objects, allocation-free.
			// Listener bodies must never throw into the engine mid-operation:
			// failures are recorded. One listener error policy: guard() — which
			// also closes the disposed window (the driver record outlives the
			// shim, so post-dispose engine callbacks must be no-ops rather than
			// relying on the cleared `targets` map to degrade safely).
			onDelivery: (w, batch) => this.guard(() => this.bumpInBatch(w.id, batch.id)), // re-render in the write's own batch
			onMountCorrective: (w, batch) => this.guard(() => this.bumpInBatch(w.id, batch.id)), // join a still-live batch this mount's render missed
			onCorrection: (w) => this.guard(() => this.bumpInBatch(w.id, undefined)), // urgent pre-paint fix: discrete-urgent fallback lane
			// Test-only: the engine reset invokes this first, before scrubbing
			// engine state, so React's batch registry drops its slot tenancy
			// while the engine composition those ids point into still exists.
			protocolReset: () => React.unstable_resetBatchRegistryForTest(),
		};
		attachDriver(driver);
		// Protocol v2: the shim is the batch-id allocator. React calls this at
		// every batch's creation (which can sit mid-render, mid-commit, or
		// inside protocol listeners — the engine's openBatch is allocation-only
		// bookkeeping and legal at all three); the engine batch opens with the
		// fork's deferred classification recorded, and the returned engine
		// BatchId is the identity both sides speak from then on.
		this.unregisterAllocator = React.unstable_registerBatchIdAllocator(
			(deferred: boolean) => this.bridge.openBatch({ deferred }).id,
		);
		this.unsubscribe = React.unstable_subscribeToExternalRuntime({
			onRenderPassStart: (container, includedBatches) =>
				this.guard(() => this.handleRenderStart(container, includedBatches)),
			onRenderPassYield: (container) => this.guard(() => this.handleYield(container)),
			onRenderPassResume: (container) => this.guard(() => this.handleResume(container)),
			onRenderPassEnd: (container, committed) => this.guard(() => this.handleRenderEnd(container, committed)),
			onBatchRetired: (batch, committed) => this.guard(() => this.handleBatchRetired(batch, committed)),
			onRootCommitted: (container, committedBatches, generation) =>
				this.guard(() => this.handleRootCommitted(container, committedBatches, generation)),
		});
	}

	/**
	 * Releases every React-side registration (the protocol listeners, the
	 * batch-id allocator) and drops the shim's delivery targets. The DRIVER
	 * RECORD stays attached: the engine owns that slot and only the test-only
	 * engine reset clears it (there is deliberately no detach — one driver
	 * per composition). A disposed shim's driver is harmless: its listeners
	 * no-op through guard(), and its write context only reads protocol state.
	 */
	dispose(): void {
		this.disposed = true;
		this.unsubscribe();
		this.unregisterAllocator();
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
			console.warn(`cosignals: ${message}`);
		}
	}

	// ---- roots and batches ----------------------------------------------------

	rootRec(container: unknown): RootRec {
		let rec = this.rootsByContainer.get(container);
		if (rec === undefined) {
			rec = {
				id: `root-${nextRootSerial++}`,
				renderPass: undefined,
				created: new Set(),
			};
			this.rootsByContainer.set(container, rec);
			this.bridge.root(rec.id); // materialize the per-root committed table
		}
		return rec;
	}

	/**
	 * Upgrades a live batch to async-action semantics in place (parked — kept
	 * pending — until the action settles). The batch already exists: with
	 * protocol v2 every React batch is engine-opened at creation by this
	 * shim's allocator, and every transition started inside one event shares
	 * one batch, so an action start never creates — it only marks. Ids with
	 * no live engine batch (already retired; foreign) are ignored.
	 */
	upgradeToAction(batchId: BatchId): void {
		const t = this.bridge.idToBatch.get(batchId);
		if (t !== undefined && t.state === 'live') {
			t.action = true;
			t.parked = true;
		}
	}

	/** The root whose render is currently rendering, if any. The protocol resolves the render context from the current call stack, so this is only meaningful synchronously during a render. */
	renderingRoot(): RootRec | undefined {
		const ctx = React.unstable_getRenderContext();
		if (ctx === null) return undefined;
		return this.rootsByContainer.get(ctx.container);
	}

	// ---- protocol listener -> bridge --------------------------------------------

	private handleRenderStart(container: unknown, includedBatches: readonly number[]): void {
		const rec = this.rootRec(container);
		if (rec.renderPass !== undefined && rec.renderPass.state !== 'ended') {
			// The protocol host closes a render frame (onRenderPassEnd) before
			// restarting the root, so a still-open render here means the two
			// sides desynced.
			if (this.devChecks) {
				throw new Error(
					`cosignals-react: protocol violation — render pass started on ${rec.id} while its previous render is still open`,
				);
			}
			// Defined fall-through: discard the stale render. A discarded render
			// contributes nothing to committed truth (its batch set never locks
			// into the root's committed table; render-owned mounts die), so this
			// cannot double-account — while leaving it open would pin the
			// engine's pending window forever.
			this.bridge.renderEnd(rec.renderPass.id, 'discard');
		}
		const known: BatchId[] = [];
		for (const batchId of includedBatches) {
			// The protocol speaks engine BatchIds directly (this shim's allocator
			// opened every one at its React batch's creation). The liveness
			// filter is defensive: a batch can retire between React capturing
			// the included list and this listener running only in exotic
			// schedules, and stale ids (a test registry that missed its reset)
			// must never enter a render's batch set.
			if (this.bridge.idToBatch.get(batchId)?.state === 'live') known.push(batchId);
		}
		rec.renderPass = this.bridge.renderStart(rec.id, known);
		rec.created = new Set();
	}

	private handleYield(container: unknown): void {
		const rec = this.rootsByContainer.get(container);
		if (rec?.renderPass === undefined || rec.renderPass.state === 'ended') return;
		this.bridge.renderYield(rec.renderPass.id);
	}

	private handleResume(container: unknown): void {
		const rec = this.rootsByContainer.get(container);
		if (rec?.renderPass === undefined || rec.renderPass.state === 'ended') return;
		this.bridge.renderResume(rec.renderPass.id);
	}

	private handleRenderEnd(container: unknown, committed: boolean): void {
		const rec = this.rootsByContainer.get(container);
		if (rec?.renderPass === undefined || rec.renderPass.state === 'ended') return;
		const render = rec.renderPass;
		if (!committed) {
			// Discard: render-owned mounts die in the bridge; drop their targets too.
			this.bridge.renderEnd(render.id, 'discard');
			for (const wid of rec.created) {
				if (!this.claimed.has(wid)) this.targets.delete(wid);
			}
			rec.created = new Set();
			rec.renderPass = undefined;
			return;
		}
		// The end(commit) event is where the bridge captures its baseline:
		// bridge.renderEnd snapshots committed state and the root's commit
		// generation on entry — before it locks this render's batches into the
		// root's committed table, and before the protocol's onRootCommitted /
		// onBatchRetired events for the same commit arrive. The mount fixup
		// for watchers created this render runs inside renderEnd; the corrective
		// re-renders it emits reach React through the direct listeners
		// (delivered at the operation boundary, inside this call). Effect
		// REFIRES the commit's boundary scan queues are HELD here and flushed
		// at the root-commit report (see holdingRefires) — render-end precedes
		// React's re-pend classification, the report follows it.
		this.holdingRefires = true;
		try {
			this.bridge.renderEnd(render.id, 'commit');
		} finally {
			this.holdingRefires = false;
		}
		rec.renderPass = undefined;
		// (ctx.previous cells update inside bridge.renderEnd — the
		// cells live on the engine's computed nodes, beside their ctx adapter.)
		// Orphan sweep. In development StrictMode React invokes render twice to
		// surface impure renders, so even a committed render can create watchers
		// whose hook instance was thrown away and will never be claimed. Layout
		// effects run synchronously inside the commit, so by the time this
		// microtask runs every claim has happened — any watcher created by this
		// render and still unclaimed is dead.
		const created = rec.created;
		rec.created = new Set();
		queueMicrotask(() => {
			if (this.disposed) return;
			for (const wid of created) {
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

	private handleBatchRetired(batchId: BatchId, committed: boolean): void {
		this.flushHeldRefires(); // defensive: nothing stays parked past its commit's own events
		const t = this.bridge.idToBatch.get(batchId);
		if (t === undefined || t.state !== 'live') return; // already retired, or a stale/foreign id — nothing to do
		// The committed/abandoned fact is BORN here — React's own report about
		// its batch. Retirement is disposition-blind (recorded writes never
		// revert either way), so the flag goes no further than this diagnostic
		// record, created straight into the bridge's tracer when one is
		// attached. Batches with no protocol report (the engine-side ambient
		// batch) create none.
		const tr = this.bridge.trace;
		if (tr !== undefined) tr.batchDisposition(batchId, committed);
		// Retirement/settlement are effect boundaries:
		// the engine's boundary scan runs inside retire/settleAction and
		// queued refires fire at the operation boundary, inside this call.
		if (t.parked) this.bridge.settleAction(batchId); // async action reached settlement
		else this.bridge.retire(batchId); // batch done everywhere: its writes become permanent history
	}

	private handleRootCommitted(container: unknown, committedBatches: readonly number[], _generation: number): void {
		const rec = this.rootRec(container);
		// The bridge already locked the committing render's batch set into the
		// root's committed table at renderEnd(commit). The protocol's per-root
		// commit report is a delta (one batch's work can reach the screen
		// across more than one flush), and re-reporting a batch is defined as
		// idempotent set-add — so hand every reported batch with an engine
		// batch to the engine's commitBatches, THE single owner of the per-root
		// commit transition: already-committed batches skip; a live batch
		// the renderEnd sweep missed locks in COMPLETELY (batch set, committed
		// bit mask, generation, commit clock, arena fan-out, drain — never a
		// partial table write from here). Defensive: for React batches with
		// engine batches the render's set already covers the delta by construction.
		const reported: BatchId[] = [];
		for (const batchId of committedBatches) {
			// Engine BatchIds directly; the liveness filter mirrors v1's
			// mapping check (the mapping was deleted at retirement, so a
			// retired batch never re-entered commitBatches from here).
			if (this.bridge.idToBatch.get(batchId)?.state === 'live') reported.push(batchId);
		}
		if (reported.length !== 0) this.bridge.commitBatches(rec.id, reported);
		// The root-commit REPORT is where the commit's effect refires run
		// (React's re-pend classification is behind us; the protocol's
		// ordering guarantee puts no user code
		// between the frame close and this report, so the boundary values are
		// unchanged — see holdingRefires). commitBatches is itself a boundary
		// operation: when the report
		// actually moved committed truth, the engine re-checked that root's
		// committed observers inside the call.
		this.flushHeldRefires();
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
	// (Installed through the constructor's driver record: deliveries and mount
	// correctives bump in the causing batch's lane; urgent/reconcile
	// corrections take the discrete-urgent fallback. The engine delivers them
	// at the end of each engine operation.
	// Dev warnings are shim-local and devChecks-gated: the post-await lint
	// lives HERE only, in currentBatch — the engine and the reference model
	// emit no dev events.)

	/**
	 * Schedules a re-render (a setState bump) in the batch's own lane via
	 * unstable_runInBatch — the engine BatchId is the protocol id, so it
	 * passes straight through. Batches React no longer (or never) holds —
	 * an already-retired batch, an engine-created batch such as the ambient
	 * one, or BATCH_NONE for no batch at all — take unstable_runInBatch's
	 * documented discrete-urgent fallback.
	 */
	private bumpInBatch(watcherId: number, batchId: BatchId | undefined): void {
		const target = this.targets.get(watcherId);
		if (target === undefined || !target.live) return;
		React.unstable_runInBatch(batchId ?? BATCH_NONE, () => target.bump());
	}

	// ---- the write context ----------------------------------------------------

	/** The batch context for the public write executing NOW — the driver's
	 * `currentBatch`, consulted by the engine once per classified write (the
	 * write itself — whole (kind, payload) operations for worlds to replay —
	 * is dispatched engine-internally after this answer). Returns the engine
	 * BatchId, BATCH_NONE included: the engine converges BATCH_NONE to its
	 * ordinary no-context write (quiet fold when nothing is pending, else the
	 * ambient batch) — the same defined fall-through a bare non-React write
	 * takes. Effects stay BOUNDARY consumers of such writes: the engine
	 * re-checks their snapshots at the next boundary (retirement, settlement,
	 * per-root commit), never mid-write. */
	currentBatch(): BatchId {
		if (React.unstable_getRenderContext() !== null) {
			throw new Error('cosignals: signal write during render — write from an event handler or effect instead');
		}
		// The protocol id is the engine BatchId: the fork created the batch
		// through this shim's allocator (which opened the engine batch) the
		// first time any write asked for this batch, this call included.
		const batchId = React.unstable_getCurrentWriteBatch();
		// BATCH_NONE is UNREACHABLE in practice: it means "no renderer
		// provider registered" (ReactExternalRuntime returns it only then),
		// and a renderer registers its provider at module load — after that,
		// getCurrentWriteBatch() creates a batch id for every write (any
		// call context) with a guaranteed close edge, so no write in the React
		// path is ever context-free. Dev checks make reaching it explode;
		// without them it returns to the engine's no-context arm.
		if (this.devChecks && batchId === BATCH_NONE) {
			throw new Error(
				'cosignals: protocol violation — signal write with no batch context after registration (the renderer provided no external-runtime write batch)',
			);
		}
		if (this.devChecks) {
			// Dev-warning heuristic. After an await, code runs on a fresh call
			// stack with no ambient transition context, so a bare write lands
			// urgent — while an async action is pending that is usually a bug
			// (the author meant the write to join the action; the fix is a
			// fresh startTransition). Warn on a non-deferred write while any
			// action is parked. Deferredness is the classification the fork
			// told the allocator at the batch's creation, stored on the engine
			// batch record; one bit cannot distinguish a discrete handler's
			// batch from a timer's ambient one, so this lint can over-trigger
			// on genuine handler writes during someone else's action —
			// accepted imprecision for a dev-only warning.
			const t = this.bridge.idToBatch.get(batchId);
			if (
				t !== undefined &&
				!t.action &&
				!t.deferred &&
				this.bridge.liveBatches().some((lt) => lt.parked)
			) {
				this.devWarn('a signal write after await landed outside the action — wrap it in startTransition');
			}
		}
		return batchId;
	}

	// ---- useSignalEffect timing shell -------------------------------------------------
	// The MECHANISM (registration, capture frame, dep snapshots, value-gated
	// boundary re-checks, observation retains) lives in the engine
	// (mountCommittedObserver / captureRun / removeSubscription). What stays
	// here is exactly the React-phase knowledge: refires queued during a
	// COMMIT's render-end hold until the root-commit report (holdingRefires).

	registerEffect(root: RootId, refire: () => void): number {
		this.bridge.root(root); // materialize the per-root committed table (as before)
		const sub = this.bridge.mountCommittedObserver(root, `effect@${root}`, () => {
			// Invoked by the engine at the boundary operation's end. Inside a
			// commit's render-end: park until the root-commit report. Everywhere
			// else (retirement, settlement, quiet fold, frame-close flush of a
			// deferred flip): run now — the engine op has fully completed.
			if (this.holdingRefires) this.heldRefires.push(refire);
			else refire();
		});
		return sub.id;
	}

	unregisterEffect(id: number): void {
		if (this.bridge.idToSubscription.has(id)) this.bridge.removeSubscription(id);
	}

	/** Runs an effect body under the ENGINE's committed-for-root capture
	 * frame (the promoted mechanism); the engine stores the dep snapshot. */
	captureEffectRun(id: number, body: () => void): void {
		if (!this.bridge.idToSubscription.has(id)) return; // torn down between queue and run
		this.bridge.captureRun(id, body);
	}

	// ---- node resolution --------------------------------------------------------

	/**
	 * The engine internals for a public Atom/ReducerAtom — a delegate to the
	 * engine's own resolution, which allocates content on the atom's first
	 * engine participation (seeding base from kernel-current — the atom's
	 * full committed history — and carrying the handle's own equality).
	 * Kept as a method so the hooks and the suites name one resolution point.
	 */
	internalsForAtom(atom: Atom<unknown>): AtomInternals {
		return this.bridge.internalsForAtom(atom);
	}

	// ---- suspense translation ----------------------------------------------------------
	// (Kernel `Computed` handles are the supported derived type,
	// world-routed through the core's .state read seams, and
	// the engine owns the ctx adapter, the committed previous cells, and the
	// background-suspension fold. What stays here is exactly the React-phase
	// knowledge: hook-initiated evaluations may legally suspend the render.)

	/** Hook-initiated evaluation — the one "a hook read may legally suspend"
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

	/** Register a watcher created during the current render (orphan-sweep set). */
	noteCreated(rootRec: RootRec, watcherId: number): void {
		rootRec.created.add(watcherId);
	}

	// ---- watcher claim / unsubscribe ------------------------------------------------

	/** Layout-effect claim: the committed hook instance owns this watcher. */
	claimWatcher(rec: { node: AnyInternals; watcherId: number | undefined; target: WatcherTarget; pendingUnsub: boolean; root: RootId | undefined; lastValue: unknown }): void {
		rec.pendingUnsub = false;
		const w = rec.watcherId === undefined ? undefined : this.bridge.watchers.get(rec.watcherId);
		if (w === undefined) {
			// Reveal without a re-render (React bailed out) or a swept
			// subscription: create a fresh watcher outside any React render and take
			// the conservative reveal path — compare what the committed DOM shows
			// against committed truth, and fix urgently, before paint.
			this.resubscribeAtLayout(rec);
			return;
		}
		this.claimed.add(w.id);
		rec.target.live = true;
		this.targets.set(w.id, rec.target);
	}

	private resubscribeAtLayout(rec: { node: AnyInternals; watcherId: number | undefined; target: WatcherTarget; root: RootId | undefined; lastValue: unknown }): void {
		const root = rec.root ?? ROOT_UNKNOWN;
		const render = this.bridge.renderStart(root, []);
		let created: Watcher | undefined;
		try {
			created = this.bridge.mountWatcher(render.id, rec.node, 'w?');
			created.name = `w${created.id}`;
			this.bridge.deferMountEffects(created.id); // keep it out of the degenerate render
		} finally {
			this.bridge.renderEnd(render.id, 'discard');
		}
		if (created === undefined) return;
		created.live = true;
		created.lastRenderedValue = rec.lastValue; // what the committed DOM shows
		rec.watcherId = created.id;
		this.claimed.add(created.id);
		rec.target.live = true;
		this.targets.set(created.id, rec.target);
		// Conservative reveal compare: fix any drift urgently, pre-paint.
		const now = this.bridge.committedValue(rec.node, root);
		if (!Object.is(now, rec.lastValue)) this.bumpInBatch(created.id, undefined);
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
		// One engine call retires the watcher from every store it lives in
		// (liveness/observation retain, id map, per-node walk index, open
		// mounted lists) — see the engine's removeWatcher.
		this.bridge.removeWatcher(wid);
	}
}

/** The evaluation context bound computed functions receive — the core's
 * ComputedCtx verbatim (`previous` hint + the two-form `ctx.use`), served
 * over the bound node's own state. */
export type BoundCtx<T> = ComputedCtx<T>;
