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
 *  - protocol events -> bridge: onRenderPassStart(includedBatches) ->
 *    renderStart; yield/resume -> renderYield/renderResume;
 *    onRenderPassEnd(committed) -> renderEnd('commit') at the moment the
 *    render commits — before that commit's per-root report and before any
 *    retirement, which is what lets the bridge snapshot committed state as
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
 *  - bridge listeners -> React: the shim registers direct listeners on the
 *    bridge (onDelivery / onMountCorrective / onCorrection);
 *    the bridge invokes them at each operation's end, and the shim turns
 *    deliveries and mount correctives into setStates via unstable_runInBatch,
 *    so each corrective re-render is scheduled in the lane of the batch that
 *    caused it and the whole update renders and commits together. Deliveries
 *    are value-blind: the bridge decides who must re-render, the shim only
 *    schedules. Batches with no live protocol counterpart take
 *    unstable_runInBatch's discrete-urgent fallback. The protocol permits
 *    scheduling updates from its yield and commit callbacks, so listening
 *    at those points is legal (writes during render are not, and throw).
 *    The bridge's TraceEvent LOG is a referee/tracing surface only: it does
 *    not create unless a referee retains it or a tracer attaches.
 *  - batch identity (protocol v2) — ONE id space, no translation: the shim
 *    registers a BATCH-ID ALLOCATOR on the protocol
 *    (unstable_registerBatchIdAllocator). At every React batch's creation
 *    the fork calls it with the batch's deferred classification; the
 *    allocator opens an engine batch (recording `deferred` on it) and
 *    returns the engine BatchId, which React stores as THE batch's identity
 *    for its whole life. Every protocol surface — getCurrentWriteBatch,
 *    runInBatch, the retirement and per-root commit reports, render-pass
 *    included-batch lists — speaks engine BatchIds directly; the old
 *    reactBatch<->engineBatch mapping tables are gone. BATCH_NONE (0),
 *    named on both sides, is the "no batch context" sentinel.
 *  - write classification — the rule: a write belongs to the batch context
 *    in which it executes. The CORE's public Atom.set/update (dispatch is a
 *    thin layer over update) capture host-attributable writes as WHOLE
 *    operations (worlds replay log entries, so a functional update must reach
 *    the engine unfolded) and
 *    hand them to the classifier this shim installs on the bridge
 *    (`bridge.writeClassifier`). The batch is read from the protocol's
 *    write-context API (unstable_getCurrentWriteBatch — the engine BatchId
 *    itself, allocator-opened at the batch's creation); BATCH_NONE (no
 *    provider registered) is unreachable
 *    once a renderer has loaded — with dev checks armed
 *    (BridgeOptions.devChecks) it throws as a protocol violation, and
 *    without them it falls through to the engine's ordinary no-context
 *    write (quiet fold, else the ambient batch). Raw `.state` reads
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
import { Atom, BATCH_NONE, SuspendedRead, type ComputedCtx } from 'cosignal';
import type {
	AnyNode,
	AtomNode,
	CosignalBridge,
	WriteKind,
	RenderPass,
	RootId,
	BatchId,
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
	/** The open bridge render pass mirroring the protocol host's in-progress render, if any. */
	renderPass: RenderPass | undefined;
	/** Watcher ids created during the current/most recent render, for the orphan sweep. */
	created: Set<number>;
};

/** Fallback root id for effects/watchers created outside any tracked render
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
	/** Development-time checks (the bridge's BridgeOptions.devChecks): armed,
	 * protocol-edge states the integration contract makes unreachable throw,
	 * and the post-await orphan-write warning runs; off, each guarded site is
	 * one boolean branch and the defined fall-through. */
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
	 * The React effect-timing shell (the ONE piece of effect machinery that
	 * stays adapter-side): user refire bodies queued by the engine's
	 * per-root-commit boundary scan must NOT run inside onRenderPassEnd —
	 * React captures its re-pend classification before emitting render end, so
	 * a body write there could desync lock-in accounting (plan amendment 2;
	 * codex review finding 1). While `holdingRefires` is set (around
	 * bridge.renderEnd for a COMMIT), refires park here and flush at the
	 * root-commit report (`onRootCommitted` — CR5 orders it right after the
	 * frame close, with no user code in between, so the boundary values are
	 * unchanged). Retirement/settlement refires run at their own operation
	 * boundary, exactly like today's post-`bridge.retire` revalidation did.
	 */
	private holdingRefires = false;
	private heldRefires: (() => void)[] = [];

	constructor(bridge: CosignalBridge) {
		this.bridge = bridge;
		this.devChecks = bridge.devChecks;
		assertForkPresent();
		// The engine's host seams: the core's public Atom methods route
		// host-attributable writes (whole ops) to the classifier, and routed
		// reads to the effective world; the observer feeds effect dependency
		// snapshots.
		bridge.writeClassifier = (atom, kind, payload) => {
			this.classifyWrite(this.nodeForAtom(atom), kind, payload); // the seam's scalar (kind, payload) pair, untouched
		};
		bridge.readAdopter = (atom) => this.nodeForAtom(atom);
		// The ambient-world provider answers from the LIVE call context, per
		// read: a render resolves its own render's world via the protocol's
		// render context (stack-accurate — a COMPLETED-but-uncommitted render is
		// not "in render", and interleaved roots each see their own render);
		// anything else resolves newest (undefined). Effect fires need no arm
		// here: the ENGINE's captureRun frame owns committed-for-root routing
		// and dependency capture (the promoted mechanism), and the engine
		// consults its own frame before this provider.
		bridge.setWorldProvider(() => {
			const rendering = this.renderingRoot();
			if (rendering?.renderPass !== undefined && rendering.renderPass.state !== 'ended') {
				return { kind: 'render', render: rendering.renderPass };
			}
			return undefined;
		});
		// Direct listeners — the load-bearing consumption surface. The bridge's
		// event LOG stays a referee/tracing artifact (it does not create unless a
		// referee retains it or a tracer attaches); scheduling decisions arrive
		// here as live objects, allocation-free. Listener bodies must never
		// throw into the engine mid-operation: failures are recorded.
		// One listener error policy: guard() — which also closes the disposed
		// window the hand-rolled try/catch these replaced lacked (post-dispose
		// bridge callbacks are now no-ops instead of relying on the cleared
		// `targets` map to degrade safely).
		bridge.onDelivery = (w, batch) => this.guard(() => this.bumpInBatch(w.id, batch.id)); // re-render in the write's own batch
		bridge.onMountCorrective = (w, batch) => this.guard(() => this.bumpInBatch(w.id, batch.id)); // join a still-live batch this mount's render missed
		bridge.onCorrection = (w) => this.guard(() => this.bumpInBatch(w.id, undefined)); // urgent pre-paint fix: discrete-urgent fallback lane
		// Protocol v2: the shim IS the batch-id allocator. React calls this at
		// every batch's creation (which can sit mid-render, mid-commit, or
		// inside protocol listeners — the engine's openBatch is allocation-only
		// bookkeeping and legal at all three); the engine batch opens with the
		// fork's deferred classification recorded, and the returned engine
		// BatchId is the identity BOTH sides speak from then on.
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

	dispose(): void {
		this.disposed = true;
		this.unsubscribe();
		this.unregisterAllocator();
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
					`cosignal-react: protocol violation — render pass started on ${rec.id} while its previous render is still open`,
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
		// (ctx.previous cells update inside bridge.renderEnd since S-C — the
		// cells live on the bridge's computed nodes with the ctx adapter.)
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
		// Retirement/settlement ARE effect boundaries now (RCC-EF2 amended):
		// the engine's boundary scan runs inside retire/settleAction and
		// queued refires fire at the operation boundary, inside this call —
		// the same observable point as the old post-retire revalidation.
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
		// commit transition (W11): already-committed batches skip; a live batch
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
		// (React's re-pend classification is behind us; CR5 puts no user code
		// between the frame close and this report, so the boundary values are
		// unchanged). commitBatches is itself an EF2 boundary: when the report
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
	// (Registered in the constructor: deliveries and mount correctives bump in
	// the causing batch's lane; urgent/reconcile corrections take the
	// discrete-urgent fallback. The bridge delivers them at the end of each
	// engine operation — the same timing the old post-op event drain had.
	// Dev warnings are shim-local AND devChecks-gated: the post-await lint
	// lives HERE only, in classifyWrite — the engine and the reference model
	// emit no dev events.)

	/**
	 * Schedules a re-render (a setState bump) in the batch's own lane via
	 * unstable_runInBatch — the engine BatchId IS the protocol id, so it
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

	// ---- write classification -----------------------------------------------------

	/** The single write entry for adopted atoms: records the WHOLE operation
	 * — carried as the host seam's scalar (kind, payload) pair (0 = set with
	 * the value, 1 = update with the updater fn) — classified into the batch
	 * context the write executes in. */
	classifyWrite(node: AtomNode, kind: WriteKind, payload: unknown): void {
		if (React.unstable_getRenderContext() !== null) {
			throw new Error('cosignal: signal write during render — write from an event handler or effect instead');
		}
		// The protocol id IS the engine BatchId: the fork created the batch
		// through this shim's allocator (which opened the engine batch) the
		// first time any write asked for this batch, this call included.
		const batchId = React.unstable_getCurrentWriteBatch();
		// BATCH_NONE is UNREACHABLE in practice: it means "no renderer
		// provider registered" (ReactExternalRuntime returns it only then),
		// and a renderer registers its provider at module load — after that,
		// getCurrentWriteBatch() creates a batch id for EVERY write (any
		// call context) with a guaranteed close edge, so no write in the React
		// path is ever context-free. Dev checks make reaching it explode;
		// without them it falls through to the engine's ordinary no-context
		// write below (quiet fold when nothing is pending, else the ambient
		// batch) — the same defined fall-through a bare non-React write takes.
		if (this.devChecks && batchId === BATCH_NONE) {
			throw new Error(
				'cosignal: protocol violation — signal write with no batch context after registration (the renderer provided no external-runtime write batch)',
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
		this.bridge.write(batchId === BATCH_NONE ? undefined : batchId, node, kind, payload);
		// A write into a batch already locked into some root's committed table
		// moves that root's committed world immediately — but effects are
		// BOUNDARY consumers (RCC-EF2 amended, 2026-07-06): they never re-run
		// mid-write. The engine re-checks their snapshots at the next boundary
		// (retirement, settlement, per-root commit — or this root's frame
		// close if one is open), coalescing every member write before it to
		// one run at the boundary value. Nothing to do here.
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

	/** Register a watcher created during the current render (orphan-sweep set). */
	noteCreated(rootRec: RootRec, watcherId: number): void {
		rootRec.created.add(watcherId);
	}

	// ---- watcher claim / unsubscribe ------------------------------------------------

	/** Layout-effect claim: the committed hook instance owns this watcher. */
	claimWatcher(rec: { node: AnyNode; watcherId: number | undefined; target: WatcherTarget; pendingUnsub: boolean; root: RootId | undefined; lastValue: unknown }): void {
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

	private resubscribeAtLayout(rec: { node: AnyNode; watcherId: number | undefined; target: WatcherTarget; root: RootId | undefined; lastValue: unknown }): void {
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
