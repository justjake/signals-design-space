/**
 * The composition root of the concurrent engine. Every mechanism module in
 * this package is a factory in the kernel's own style (CosignalEngine.ts
 * `createKernel`): it closes over its state and returns/assigns its
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
 *   5. the episode lifecycle (its fold deps are World's now-assigned slots;
 *      its close sweeps the batch manager's record registry);
 *   6. deliver's walk orchestration, then the render-pass manager (each
 *      assigns its late-bound slots);
 *   7. the committed observers (the engine module's observer section — its
 *      whole operation table, the subscription store included, joins the
 *      core record).
 *
 * The quiet derivation lives here: quiet ⇔ zero live batches and zero open
 * renders and no episode write records held — recomputed only at pipeline
 * transitions (batch open/retire, render start/end, driver attach). The
 * flags themselves stay module lets in concurrent.ts (the write path's hot
 * reads); this module owns the rule.
 *
 * concurrent.ts calls this factory once at module initialization (the one
 * composition call — always-concurrent) and aliases the hot table entries
 * as module bindings (callers keep one-load call shapes);
 * `__resetEngineForTest` re-runs it — every mechanism factory re-runs at a
 * reset, while kernel growth (the closure rebuild) re-runs only createKernel.
 */

import { createNotificationQueue, createDeliveryWalks, type NotificationQueue } from './NotificationQueue.js';
import { createObservationIndex, type ObservationIndex } from './ObservationIndex.js';
import { createEpisodeLifecycle, type EpisodeLifecycle, type WriteLogEntry } from './WriteLog.js';
import { createBatchManager, type BatchId, type BatchManager } from './Batch.js';
import { createEngineCore, createWorld, type EngineCore } from './World.js';
import { createCommittedObservers, createRenderPassManager, createWorldArena, WORLD_ARENA_INIT_INTS, type RenderPass, type RenderPassManager, type Watcher } from './CosignalEngine.js';
import { createSettlement } from './settlement.js';
import type { Atom, Computed } from './index.js';
import type { AnyInternals, AtomInternals, ComputedInternals, EngineResetOptions, Reader, RenderPassId, RootId, RootState, Seq, Value, WatcherId } from './concurrent.js';

/** Write-kind tags: the packed log entry column and the write surface's kind
 * argument (`write`/`bareWrite`) — 0 = set, 1 = update, the same codes
 * index.ts's public write dispatch carries end to end (its public
 * `WriteKind` type alias names the same 0/1 encoding by construction;
 * 0/1 literals are assignable, so cross-module callers never need this
 * type's name). Const enum, exported type-only in effect: the write
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
	/** The node registry: nodes by nodeIndex (dense; bare record ids resolve
	 * through the record's live NODE_INDEX — see concurrent.ts). */
	nodeIndexToInternals: (AnyInternals | undefined)[];
	nodeToWatchers: (Watcher[] | undefined)[];
	lastWalk: number[];
	watchers: Map<WatcherId, Watcher>;
	idToRenderPass: Map<RenderPassId, RenderPass>;
	rootToOpenRender: Map<RootId, RenderPass>;
	roots: Map<RootId, RootState>;
	root(id: RootId): RootState;
	/** Handle resolution (content allocation on first participation). */
	internalsForAtom(atom: Atom<unknown>): AtomInternals;
	internalsForComputed(c: Computed<unknown>): ComputedInternals;
	getKernelStrongDeps(node: ComputedInternals): AnyInternals[];
	readKernelValue(dep: AnyInternals): Value;
	/** The untracked kernel newest read of one atom (the episode close's
	 * durable handoff adopts it — untracked so a close reached from inside a
	 * kernel effect frame records no link). */
	readNewestUntracked(atom: AtomInternals): Value;
	/** The optional log-entry drop observer slot (the engine's public
	 * `onLogEntryDrop` — fired per entry as it leaves a write log, at
	 * fold-valve folds and the episode drop). */
	getOnLogEntryDrop(): ((atom: AtomInternals, entry: WriteLogEntry) => void) | undefined;
	/** The driver slot's presence + the devChecks switch (openBatch's
	 * dev-time guard reads both). */
	isDriverAttached(): boolean;
	isDevChecksEnabled(): boolean;
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
	notify: NotificationQueue;
	obs: ObservationIndex;
	episode: EpisodeLifecycle;
	batch: BatchManager;
	render: RenderPassManager;
	/** The quiet derivation (composition-owned; see the module header). */
	recomputeQuiet(): void;
	/** Kernel-frame tracked reader (engine-created computeds' newest runs):
	 * the shared kernel read plus the pre-dedup observation capture — built
	 * here so the closure captures the core record directly (the
	 * capture-list read stays one load). */
	kernelTrackedReader: Reader;
};

export function createConcurrentEngine(host: ConcurrentEngineHost, options?: EngineResetOptions): ConcurrentEngine {
	probes.bridges++; // engine-activity counter: counts compositions (module init + resets; tests/one-core.spec.ts)
	// Stable resident containers, aliased once (identity-shared).
	const nodeIndexToInternals = host.nodeIndexToInternals;
	const rootToOpenRender = host.rootToOpenRender;
	// The core binding the pre-core factories' arrows close over (assigned
	// below, read only at call time — every caller runs post-composition).
	let core!: EngineCore;
	// ---- the composition: build the mechanism tables in dependency order
	// (each factory closes over its own state — the kernel's createKernel
	// pattern — and receives its resident-state edges as thin arrows), then
	// the class shell aliases the shared columns its resident hot paths and
	// the tests read in place.
	const notify = createNotificationQueue({
		// The queue composes before the core record exists; the getter reads
		// the binding assigned below (every flush runs post-composition).
		getCore: () => core,
	});
	const obs = createObservationIndex({ host });
	/**
	 * The armed quiet-state derivation — quiet ⇔ zero live batches and zero
	 * open renders and no episode write records held (the episode close
	 * empties `holds` at exactly the transition the first two clauses
	 * detect, so the third is a belt matching the reference model's
	 * derivation shape) — recomputed only at state
	 * transitions (batch open/retire, render start/end, driver attach); the
	 * booleans the write path branches on stay module lets (host.setQuiet
	 * maintains both `quiet` and `standaloneQuiet`). There is no registered
	 * clause: the engine is always live (a batch cannot exist before
	 * something opens it, and openBatch precedes any classified write).
	 */
	function recomputeQuiet(): void {
		host.setQuiet(
			batchOps.getLiveBatchCount() === 0
			&& rootToOpenRender.size === 0
			&& episode.holds.size === 0,
		);
	}
	// ---- One shared core record. It is created with the resident-state
	// edges filled and every operation slot stubbed; createWorld /
	// createWorldArena / createSettlement (and the later factories) assign
	// their tables onto it (cycles resolve by reading the late-bound slots
	// at call time, never at import time).
	core = createEngineCore({
		nodeIndexToInternals,
		nodeToWatchers: host.nodeToWatchers,
		lastWalk: host.lastWalk,
		obsRefs: obs.refs,
		syncObservedDeps: obs.syncObservedDeps,
		watchers: host.watchers,
		idToRenderPass: host.idToRenderPass,
		rootToOpenRender,
		roots: host.roots,
		notify,
		notifyState: notify.state,
		root: host.root,
		// Handle resolution (content allocation on first participation —
		// record reuse can never serve a dead tenant: disposal and the
		// record-free scrub clear the handle link and the rows, so a reused
		// id resolves fresh).
		internalsForAtom: host.internalsForAtom,
		internalsForComputed: host.internalsForComputed,
		// The quiet derivation is composition-owned (above); the sequence
		// clocks are module lets in concurrent.ts (thin arrows — every one
		// is a transition/boundary call, never a per-read hot path).
		recomputeQuiet,
		nextSeq: host.nextSeq,
		getSeq: host.getSeq,
		getCommittedAdvance: host.getCommittedAdvance,
		advanceCommitted: host.advanceCommitted,
		arenaInitInts: options?.arenaInitInts ?? WORLD_ARENA_INIT_INTS,
	});
	createWorld(core);
	createWorldArena(core);
	createSettlement(core);
	// ---- the batch manager + retirement (the batch lifecycle owns its
	// terminal transition; the fan reads the core's late-bound slots). The
	// host slice carries the driver/devChecks probes and the write path's
	// last-batch cache clear (the cache must not outlive a reclaimed record).
	const batchOps = createBatchManager(core, { host });
	core.batch = batchOps;
	// ---- the episode lifecycle (after createWorld: its fold deps are the
	// core's now-assigned World slots; its close sweeps the batch manager's
	// record registry).
	const episode = createEpisodeLifecycle({ core, host, batch: batchOps });
	core.runFoldValve = episode.runFoldValve;
	core.maybeCloseEpisode = episode.maybeCloseEpisode;
	// ---- the walk orchestration (NotificationQueue.ts) + render lifecycle
	// (the engine module's render-integration section) — each assigns its
	// late-bound core slots.
	createDeliveryWalks(core);
	const render = createRenderPassManager(core, { observation: obs });
	// Kernel-frame tracked reader: captures `core` directly (see the
	// ConcurrentEngine declaration comment).
	const kernelTrackedReader: Reader = (dep) => {
		const oc = core.obsCapture;
		if (oc !== undefined) oc.push(dep);
		return host.readKernelValue(dep);
	};
	// ---- the committed observers (the engine module's observer section —
	// no manager object: the factory assigns its whole operation table, the
	// subscription store included, onto the core record; the orchestration
	// and the settlement drain reach the boundary revalidation as table
	// calls). The factory binds the stable operations once and reads the
	// mutable core fields (trace, captureFrame, guards, the live count) in
	// place.
	createCommittedObservers(core, obs);
	return { core, notify, obs, episode, batch: batchOps, render, recomputeQuiet, kernelTrackedReader };
}
