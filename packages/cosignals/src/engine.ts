/**
 * THE COMPOSITION ROOT of the concurrent engine. Every mechanism module in
 * this package is a FACTORY in the kernel's own style (graph.ts
 * `createEngine`): it closes over its state and returns/assigns its
 * operation table. `createConcurrentEngine` is the one place they compose:
 * it builds the shared engine core record (World.ts `EngineCore`) with the
 * resident-state edges filled, runs every factory in dependency order, and
 * wires the late-bound slots — the cycles between worlds, arenas,
 * settlement, batches, drains, and the render lifecycle all resolve here,
 * by reading core slots at call time, never at import time.
 *
 * Composition order (each step's factory may capture what earlier steps
 * assigned; later slots are read late):
 *   1. deliver's queue + the observation index (no core yet — their deps
 *      are arrows over host state and the core binding, called post-build);
 *   2. the core record (resident containers + clock/quiet edges in);
 *   3. World, WorldArena, settlement — the strongly-connected trio;
 *   4. Batch (mechanism + retirement — captures core);
 *   5. compaction (its fold deps are World's now-assigned slots; its batch
 *      edge is the batch table's releaseLogEntry);
 *   6. deliver's walk orchestration, then RenderPass (each assigns its
 *      late-bound slots);
 *   7. Subscription (its boundary revalidation joins the core table).
 *
 * The QUIET derivation lives here: quiet ⇔ zero live batches AND zero open
 * renders AND every write log compacted — recomputed only at pipeline
 * transitions (batch open/retire, render start/end, driver attach). The
 * flags themselves stay module lets in concurrent.ts (the write path's hot
 * reads); this module owns the rule.
 *
 * concurrent.ts calls this factory ONCE at module initialization (THE one
 * composition call — always-concurrent) and aliases the hot table entries
 * as module bindings (callers keep one-load call shapes);
 * `__resetEngineForTest` re-runs it — every mechanism factory re-runs at a
 * reset, while GROWTH re-runs only the kernel's graph factory.
 */

import { createDeliver, createDeliverWalks, type DeliverTable } from './deliver.js';
import { createObservation, type ObservationTable } from './observation.js';
import { createCompaction, type CompactionTable, type WriteLogEntry } from './WriteLog.js';
import { createBatch, type BatchId, type BatchTable } from './Batch.js';
import { createEngineCore, createWorld, type EngineCore } from './World.js';
import { createWorldArena } from './WorldArena.js';
import { createSettlement } from './settlement.js';
import { createSubscription, type SubscriptionTable } from './Subscription.js';
import { createRenderPass, type RenderPass, type RenderPassTable, type Watcher } from './RenderPass.js';
import type { Atom, Computed } from './index.js';
import type { AnyNode, AtomNode, ComputedNode, EngineResetOptions, Reader, RenderPassId, RootId, RootState, Seq, Value, WatcherId } from './concurrent.js';

/** Write-kind tags: the packed log entry column AND the write surface's kind
 * argument (`write`/`bareWrite`) — 0 = set, 1 = update, the same codes
 * index.ts's public write dispatch carries end to end (its public
 * `WriteKind` type alias names the same 0/1 encoding by construction;
 * 0/1 literals are assignable, so cross-module callers never need this
 * type's name). Const enum, exported TYPE-ONLY in effect: the write
 * path's hot comparisons (concurrent.ts, World.ts applyOp) use the shared
 * bare 0/1 codes with a naming comment — cross-module const enum access
 * does not survive per-file transforms. */
export const enum WriteKind {
	SET = 0,
	UPDATE = 1,
}

/**
 * Engine-activity probes (test surface): one module-wide counter record
 * proving the zero-cost promise behaviorally — with no driver attached and
 * no batch open, heavy signal traffic must leave every field at its baseline
 * (tests/one-core.spec.ts). Engine logic never reads the counters; each
 * mutation site lives beside the machinery it counts (log-entry appends in
 * WriteLog.ts, batch creation in Batch.ts, world evaluations in World.ts,
 * engine composition below), and the snapshot reader is `__coreProbes()` in
 * concurrent.ts.
 */
export const probes = { logEntries: 0, batches: 0, worldEvals: 0, bridges: 0 };

/** The module-state edges the composition consumes: concurrent.ts's
 * containers (aliased by identity into the core record) and thin arrows
 * over the module state the operation functions own — handle resolution,
 * the sequence clocks, the quiet flag, the write path's last-batch cache,
 * and the driver/devChecks slots. */
export type ConcurrentEngineHost = {
	idToNode: Map<number, AnyNode>;
	nodesArr: (AnyNode | undefined)[];
	nodeToWatchers: (Watcher[] | undefined)[];
	lastWalk: number[];
	watchers: Map<WatcherId, Watcher>;
	idToRenderPass: Map<RenderPassId, RenderPass>;
	rootToOpenRender: Map<RootId, RenderPass>;
	roots: Map<RootId, RootState>;
	root(id: RootId): RootState;
	/** Handle resolution (content allocation on first participation). */
	nodeForAtom(atom: Atom<unknown>): AtomNode;
	nodeForComputed(c: Computed<unknown>): ComputedNode;
	kernelStrongDepsOf(node: ComputedNode): AnyNode[];
	kernelReadOf(dep: AnyNode): Value;
	/** The optional compaction observer slot (the engine's public `onCompact`). */
	onCompact(): ((atom: AtomNode, entry: WriteLogEntry) => void) | undefined;
	/** The driver slot's presence + the devChecks switch (openBatch's
	 * dev-time guard reads both). */
	hasDriver(): boolean;
	devChecksOn(): boolean;
	/** The quiet flag's one writer (the flags stay module lets — the write
	 * path's hot reads; this module owns the rule). */
	setQuiet(quiet: boolean): void;
	/** The sequence clocks (module lets — the quiet fold advances them fused). */
	nextSeq(): Seq;
	getSeq(): Seq;
	getCommittedAdvance(): Seq;
	advanceCommitted(): void;
	/** The write path's last-batch cache clear (reclamation edge). */
	invalidateBatchCache(id: BatchId): void;
};

/** Everything the composition assembles: the shared core record, each
 * mechanism's operation table, and the composition-owned derivations. The
 * class shell aliases the hot entries as own fields. */
export type ConcurrentEngine = {
	core: EngineCore;
	notify: DeliverTable;
	obs: ObservationTable;
	compaction: CompactionTable;
	batch: BatchTable;
	render: RenderPassTable;
	subs: SubscriptionTable;
	/** The quiet derivation (composition-owned; see the module header). */
	recomputeQuiet(): void;
	/** Kernel-frame tracked reader (engine-created computeds' newest runs):
	 * the shared kernel read plus the pre-dedup observation capture — built
	 * here so the closure captures the core record directly (the
	 * capture-list read stays one load). */
	kernelTrackedReader: Reader;
};

export function createConcurrentEngine(host: ConcurrentEngineHost, options?: EngineResetOptions): ConcurrentEngine {
	probes.bridges++; // engine-activity counter: counts COMPOSITIONS (module init + resets; tests/one-core.spec.ts)
	// Stable resident containers, aliased once (identity-shared).
	const idToNode = host.idToNode;
	const nodesArr = host.nodesArr;
	const rootToOpenRender = host.rootToOpenRender;
	// The core binding the pre-core factories' arrows close over (assigned
	// below, read only at call time — every caller runs post-composition).
	let core!: EngineCore;
	// ---- the composition: build the mechanism tables in dependency order
	// (each factory closes over its own state — the kernel's createEngine
	// pattern — and receives its resident-state edges as thin arrows), then
	// the class shell aliases the shared columns its resident hot paths and
	// the tests read in place.
	const notify = createDeliver({
		onDelivery: () => core.onDelivery,
		onMountCorrective: () => core.onMountCorrective,
		onCorrection: () => core.onCorrection,
	});
	const obs = createObservation({
		nodeAt: (ix) => nodesArr[ix],
		kernelStrongDepsOf: (node) => host.kernelStrongDepsOf(node),
	});
	/**
	 * The ARMED quiet state derivation — quiet ⇔ zero live batches AND zero
	 * open renders AND every write log compacted — recomputed only at state
	 * transitions (batch open/retire, render start/end, driver attach); the
	 * booleans the write path branches on stay module lets (host.setQuiet
	 * maintains both `quiet` and `standaloneQuiet`). There is no registered
	 * clause: the engine is always live (a batch cannot exist before
	 * something opens it, and openBatch precedes any classified write).
	 */
	function recomputeQuiet(): void {
		host.setQuiet(
			batchOps.liveBatchCount() === 0
			&& rootToOpenRender.size === 0
			&& compaction.uncompactedAtoms.size === 0,
		);
	}
	// ---- ONE shared core record. It is created with the resident-state
	// edges filled and every operation slot stubbed; createWorld /
	// createWorldArena / createSettlement (and the later factories) assign
	// their tables onto it (cycles resolve by reading the late-bound slots
	// at call time, never at import time).
	core = createEngineCore({
		idToNode,
		nodesArr,
		nodeToWatchers: host.nodeToWatchers,
		lastWalk: host.lastWalk,
		obsRefs: obs.refs,
		obsSyncDeps: obs.syncDeps,
		watchers: host.watchers,
		idToRenderPass: host.idToRenderPass,
		rootToOpenRender,
		roots: host.roots,
		notify,
		notifyState: notify.state,
		root: (id) => host.root(id),
		// Handle resolution (content allocation on first participation —
		// record reuse can never serve a dead tenant: disposal and the
		// record-free scrub clear the handle link and the rows, so a reused
		// id resolves fresh).
		nodeForAtom: host.nodeForAtom,
		nodeForComputed: host.nodeForComputed,
		// The quiet derivation is composition-owned (above); the sequence
		// clocks are module lets in concurrent.ts (thin arrows — every one
		// is a transition/boundary call, never a per-read hot path).
		recomputeQuiet,
		nextSeq: host.nextSeq,
		getSeq: host.getSeq,
		getCommittedAdvance: host.getCommittedAdvance,
		advanceCommitted: host.advanceCommitted,
		arenaInitInts: options?.arenaInitInts ?? 8192,
	});
	createWorld(core);
	createWorldArena(core);
	createSettlement(core);
	// ---- the batch mechanism + retirement (the batch lifecycle owns its
	// terminal transition; the fan reads the core's late-bound slots).
	const batchOps = createBatch(core, {
		hasDriver: host.hasDriver,
		devChecksOn: host.devChecksOn,
		// The write path's last-batch cache must not outlive a reclaimed
		// record (the cache stays resident beside the write path).
		invalidateBatchCache: host.invalidateBatchCache,
	});
	core.batch = batchOps;
	// ---- write-log compaction (after createWorld: its fold deps are the
	// core's now-assigned World slots; the batch edge is the batch table's).
	const compaction = createCompaction({
		minLivePin: () => core.minLivePin(),
		applyOp: core.applyOp,
		eqAtom: core.eqAtom,
		onCompact: host.onCompact,
		releaseLogEntry: batchOps.releaseLogEntry,
	});
	core.compactAll = compaction.compactAll;
	// ---- the walk orchestration (deliver.ts) + render lifecycle
	// (RenderPass.ts) — each assigns its late-bound core slots.
	createDeliverWalks(core);
	const render = createRenderPass(core, { obsShift: obs.shift });
	// Kernel-frame tracked reader: captures `core` directly (see the
	// ConcurrentEngine declaration comment).
	const kernelTrackedReader: Reader = (dep) => {
		const oc = core.obsCapture;
		if (oc !== undefined) oc.push(dep);
		return host.kernelReadOf(dep);
	};
	// ---- the subscription mechanism (its boundary revalidation joins the
	// core table — the orchestration and the settlement drain reach it as
	// table calls).
	const subs = createSubscription({
		evaluate: core.evaluate,
		changedValue: core.changedValue,
		root: (id) => host.root(id),
		rootToOpenRender,
		notify,
		trace: () => core.trace,
		syncSubObs: obs.syncSubObs,
		obsShift: obs.shift,
		setCaptureFrame: core.setCaptureFrame,
		captureFrame: () => core.captureFrame,
		evalDepth: () => core.evalDepth,
		inFoldCallback: () => core.inFoldCallback,
		subCountShift: (delta) => {
			core.committedSubCount += delta;
		},
		committedSubCount: () => core.committedSubCount,
	});
	core.revalidateCommittedSubs = subs.revalidateCommittedSubs;
	return { core, notify, obs, compaction, batch: batchOps, render, subs, recomputeQuiet, kernelTrackedReader };
}
