/**
 * Worlds — evaluation, folds, and read routing. A world is one
 * self-consistent assignment of values to every atom, produced by replaying
 * exactly the log entries that world may see, in timeline order (the full
 * vocabulary — write log, batch, render pass, arena — is defined at the top
 * of concurrent.ts). This module owns:
 *
 *  - the `World` type and `isVisibleAt`, the two-clause visibility rule;
 *  - `foldAtom` / `applyOp` / `isAtomValueEqual` — the fold family (one op-application
 *    rule, one equality rule) and the fold-purity bracket (`runInFoldCallback`);
 *  - `evaluate` — world evaluation (arena-served render/committed worlds,
 *    kernel-served newest, memo-free fold-throughs for mountFix worlds) with
 *    per-world cycle detection;
 *  - read routing: the resolution order (fold-purity throw → evaluation
 *    world on stack → open capture frame → the driver's ambient provider),
 *    the routed read bodies (`routedAtomRead` / `routedComputedRead` — the
 *    public `.state` getters call them directly when `routingActive` is
 *    set), and the one-flag arming (`syncReadRouting` maintains CosignalEngine.ts's
 *    `routingActive` boolean at every world/capture/provider transition —
 *    one flag covers every routing source).
 *
 * The shared engine core record (`EngineCore`) is declared here: the one
 * deps/table record the strongly-connected mechanisms — World, WorldArena,
 * settlement (and the subscription manager's boundary revalidation) — are wired
 * through. `createEngineCore` builds it at the composition site with the
 * resident-state edges filled and every factory slot stubbed; each factory
 * then assigns its operation table onto the record, and every cross-module
 * call reads its slot at call time (late binding — never an import-time
 * reference), which is what closes the evaluate → arenaServe → foldAtom and
 * settlement → arenas → worlds → corrections cycles. Shared mutable scalars
 * (the evaluation-frame state, the routing state, the operation depth) live
 * as fields on the record: hot functions load the record once into a local
 * and keep the one-property-load access shape the class fields had.
 */

import { CycleError, SuspendedRead, type Atom, type Computed } from './index.js';
import { E, foldGuardRestore, foldGuardSwap, __setRoutingActive } from './CosignalEngine.js';
import type { Clock } from './CosignalEngine.js';
import { ScheduleError } from './errors.js';
import { probes, type ConcurrentEngineHost } from './ConcurrentEngine.js';
import { FOLD_TRUTH, type WorldArena } from './CosignalEngine.js';
import type { Batch, BatchManager, BatchSlot, BatchSlotMeta, BatchSlotSet } from './Batch.js';
import type { AnyInternals, ArenaInitInts, AtomInternals, ComputedInternals, NodeId, NodeIndex, Reader, RenderPass, RenderPassId, RootId, RootState, Seq, SubscriptionId, TraceHooks, Value, Watcher, WatcherId, WriteKind } from './concurrent.js';
import type { ObservationIndex } from './ObservationIndex.js';
import type { CaptureFrame, Subscription } from './CosignalEngine.js';
import type { EpisodeLifecycle } from './WriteLog.js';
import type { NotificationQueue, NotifyState } from './NotificationQueue.js';

/** Top-level world-evaluation generation (per-world cycle detection marks). */
type EvalGen = number;

/** A world: one self-consistent assignment of values to all atoms, computed
 * by replaying exactly the log entries that world may see, in timeline order. */
export type World =
	| { kind: 'newest' }
	| { kind: 'render'; render: RenderPass }
	| { kind: 'committed'; root: RootId }
	| { kind: 'mountFix'; maskBits: BatchSlotSet; pin: Seq; root: RootId };

/** The one newest-world singleton (hot paths never allocate world objects). */
export const NEWEST: World = { kind: 'newest' };

/** Declined-read sentinel: a routed read returns it to mean "no routing
 * context answered — take the plain kernel path". Package-internal (the
 * public `.state` getters compare against it); never observable. */
export const NOT_ROUTED: { readonly notRouted: true } = { notRouted: true };

/**
 * The shared engine core record — deps and table in one (see the module
 * header). Three sections:
 *  - resident-provided deps: stable containers aliased by identity plus thin
 *    arrows over resident orchestration, filled by `createEngineCore`;
 *  - shared mutable state: the scalars more than one mechanism (or the
 *    resident orchestration) reads/writes — each field's home mechanism is
 *    noted;
 *  - late-bound operation slots: assigned by createWorld / createWorldArena /
 *    createSettlement (and the subscription manager factory for its one boundary
 *    slot), read at call time.
 */
export type EngineCore = {
	// ---- resident-provided deps (filled at creation) ----
	/** The node registry: nodes by nodeIndex (identity alias of the engine's
	 * dense column; bare ids resolve via the record's live NODE_INDEX). */
	nodeIndexToInternals: (AnyInternals | undefined)[];
	/** Watchers by nodeIndex (identity alias — the routing walks' collection rows). */
	nodeToWatchers: (Watcher[] | undefined)[];
	/** Per-node visited/collection stamps (identity alias — see concurrent.ts). */
	lastWalk: number[];
	/** Observed-consumer refcount column (identity alias of ObservationIndex.ts's). */
	obsRefs: number[];
	/** The observation index's dep-snapshot re-pointer (ObservationIndex.ts). */
	syncObservedDeps: ObservationIndex['syncObservedDeps'];
	/** Watchers by id (identity alias). */
	watchers: Map<WatcherId, Watcher>;
	/** RenderPass records by id (identity alias — RenderPass.ts owns every
	 * transition; the resident quiescence sweep reads it in place). */
	idToRenderPass: Map<RenderPassId, RenderPass>;
	/** The one open render per root (identity alias). */
	rootToOpenRender: Map<RootId, RenderPass>;
	/** Root records by id (identity alias; getArena only probes it — creation goes through `root`). */
	roots: Map<RootId, RootState>;
	/** The notification queue mechanism (NotificationQueue.ts table + its live scalars). */
	notify: NotificationQueue;
	notifyState: NotifyState;
	/** Root record lookup-or-create (the engine host's — resident: the
	 * committed/mountFix
	 * membership consults materialize the root record — reference-model parity). */
	root: ConcurrentEngineHost['root'];
	/** Public-handle resolution (the engine host's — content allocation: a
	 * handle with
	 * no engine content gets its node record on first participation; base
	 * seeds from kernel-current, which is its full committed history by the
	 * quiet invariant). */
	internalsForAtom: ConcurrentEngineHost['internalsForAtom'];
	internalsForComputed: ConcurrentEngineHost['internalsForComputed'];
	/** Quiet-state recompute at pipeline transitions (the composition-owned
	 * derivation — batch open/retire, render start/end). */
	recomputeQuiet(): void;
	/** The one global sequence clock (the engine host's module fields):
	 * increment-and-read, plain read (render pins),
	 * the committed-advance read (mount-fixup baselines), and the
	 * committed-advance bump (per-root commits, history-changing retirements). */
	nextSeq: ConcurrentEngineHost['nextSeq'];
	getSeq: ConcurrentEngineHost['getSeq'];
	getCommittedAdvance: ConcurrentEngineHost['getCommittedAdvance'];
	advanceCommitted: ConcurrentEngineHost['advanceCommitted'];
	/** Initial arena buffer size in ints (EngineResetOptions knob; the
	 * composition site fills the generous default — arenas grow by copy
	 * past it). */
	arenaInitInts: ArenaInitInts;

	// ---- composition-assigned tables (assigned by the composition site right
	// after their factories run — before any operation can call them; they are
	// not creation deps because their factories take the core record) ----
	/** The batch manager (Batch.ts — the render-close
	 * orchestration and the resident write path reach it here). */
	batch: BatchManager;
	/** The episode lifecycle's boundary pair (WriteLog.ts): the bounded-
	 * memory fold valve over sealed write-log chunks (retirement's fold step
	 * and the render-close pin release) and the quiescence close (durable
	 * handoff + wholesale episode drop). */
	foldSealedChunks: EpisodeLifecycle['foldSealedChunks'];
	maybeCloseEpisode: EpisodeLifecycle['maybeCloseEpisode'];

	// ---- shared mutable state ----
	/** The trace recorder slot — the engine's only instrumentation output
	 * (one nullable slot; the `engine` surface exposes accessor delegates
	 * over it for `cosignals/trace`). */
	trace: TraceHooks | undefined;
	/** The world an open evaluation frame is folding in (World). */
	activeWorld: World | undefined;
	/** The nodeIndex whose fold-through evaluation frame is open (raw-handle
	 * reads gate their observation capture on it; the untracked reader
	 * clears it around the dep — sink 0 ⇔ weak; index 0 is burned). (World) */
	currentSink: NodeIndex;
	/** Strong-dep capture list of the innermost evaluation frame, undefined
	 * unless that frame's node is observed — the one field unwatched
	 * evaluations pay for (a check per recorded edge). (World frame state;
	 * arena refolds and the resident kernel getters open/close it too.) */
	obsCapture: AnyInternals[] | undefined;
	/** >0 while a world evaluation is on stack (renders must not write). (World) */
	evalDepth: number;
	/** True inside an updater/reducer/equals callback (reads+writes throw). (World) */
	inFoldCallback: boolean;
	/** The core capture frame `captureRun` opens (committed-observer state;
	 * the routing resolution consults it per routed read — see the engine's
	 * committed-observers section). */
	captureFrame: CaptureFrame | undefined;
	/** >0 while a hook-initiated evaluation may legally suspend the render
	 * (the bindings' `evaluateSuspending` bumps it via the class accessor);
	 * background evaluations of ctx-shaped computeds fold pending
	 * suspensions to sentinel values. (World) */
	suspendDepth: number;
	/** The serve-override slot — the one override the routed-read path tests
	 * (setters bracket save/restore, so the
	 * innermost override wins). Occupants: a WorldArena (arena-refold
	 * routing — raw-handle reads inside arena fn runs serve from that arena)
	 * or FOLD_TRUTH (the armed checker's naive reads — atom reads fold plain
	 * in the frame's world: no arenas, no memos, no caches; test-armed only).
	 * undefined ⇔ no override, the production steady state. (WorldArena) */
	serveOverride: WorldArena | typeof FOLD_TRUTH | undefined;
	/** Global count of box-suspended shadows (tap fast-out). (WorldArena) */
	suspendedCount: number;
	/** The armed divergence-check hook: the test-side structural checker lives
	 * in tests/arena-checker.ts and installs itself here through
	 * `__checkerInternals().armEpilogueCheck`. Fired at every public
	 * operation's epilogue after the settlement fixed point; any mismatch it
	 * finds throws — a test failure. Production never installs one,
	 * so the epilogue pays one undefined test. (settlement consumes it.) */
	epilogueCheck: (() => void) | undefined;
	/** Public-operation nesting (the settlement firing-context discriminant). */
	opDepth: number;
	/** The render currently COMMITTING (set for the span of renderEnd's
	 * commit half, cleared in its finally): the watcher correction gate's
	 * cross-world discriminant — a candidate re-rendered/mounted by this
	 * very render compares its just-reset rendered register against
	 * committed truth by value (the fixup-class render↔committed question
	 * per-root clocks cannot express); every other candidate gates on
	 * clocks alone. (RenderPass sets it; the delivery walks read it.) */
	committingRender: RenderPass | undefined;
	/** Per-walk visited generation source (delivery walk, drains, closures). */
	walkGen: number;
	/** Live subscription count (fast bail on the boundary-scan paths — owned
	 * by the subscription manager; resident/settlement pre-checks read it). */
	committedSubCount: number;
	// ---- direct listeners (the bindings' consumption surface — assigned
	// through the class accessor pair; the delivery/fixup/correction sites
	// read the fields off the captured core record, one load) ----
	/** A value-blind delivery reached a live watcher (fresh or interleaved). */
	onDelivery: ((w: Watcher, batch: Batch, slot: BatchSlot) => void) | undefined;
	/** Mount fixup scheduled a corrective re-render into a live batch's lane. */
	onMountCorrective: ((w: Watcher, batch: Batch, slot: BatchSlot) => void) | undefined;
	/** An urgent pre-paint correction (mount window / committed-truth drift). */
	onCorrection: ((w: Watcher) => void) | undefined;

	// ---- core-created shared columns ----
	/** Mark column (by nodeIndex) + generation for per-world cycle detection
	 * (no Set allocs) — World-owned; the resident registry's gap-fill and the
	 * record-free scrub maintain rows (the class aliases it). */
	evalMark: EvalGen[];
	/** Committed arenas, by root (WorldArena-owned; resident orchestration
	 * reads it in place through the class alias). */
	rootToArena: Map<RootId, WorldArena>;
	/** Pooled released arena shells (WorldArena-owned; test seam reads it). */
	arenaPool: WorldArena[];
	/** Watchers re-staled by their own commit, per root (RenderPass.ts's
	 * re-staled loop writes; the durable drain consumes; retirement and the
	 * commit lock-in read the size as their drain gate). */
	restaled: Map<RootId, Set<Watcher>>;

	// ---- late-bound: World ----
	evaluate(node: AnyInternals, world: World): Value;
	foldAtom(atom: AtomInternals, world: World): Value;
	applyOp(atom: AtomInternals, kind: WriteKind, payload: unknown, prev: Value): Value;
	isAtomValueEqual(atom: AtomInternals, a: Value, b: Value): boolean;
	isValueChanged(node: AnyInternals, prev: Value, next: Value): boolean;
	runInFoldCallback<T>(fn: () => T): T;
	createCycleError(name: string): ScheduleError;
	setWorld(w: World | undefined): void;
	syncReadRouting(): void;
	setWorldProvider(provider: (() => World | undefined) | undefined): void;
	/** Assigns the capture frame and re-syncs the read-routing arming (the
	 * two-step every captureRun edge performs — the subscription manager's
	 * one writer). */
	setCaptureFrame(f: CaptureFrame | undefined): void;
	routedRead(atom: AtomInternals, world: World): Value;
	/** The public `.state` routed-read bodies (index.ts calls the module
	 * trampolines in ConcurrentEngine.ts, which read these slots): NOT_ROUTED declines
	 * to the plain kernel path. */
	routedAtomRead(atom: Atom<unknown>): unknown;
	routedComputedRead(c: Computed<unknown>): unknown;

	// ---- late-bound: WorldArena ----
	claimArena(kind: 'render' | 'committed', world: World, root: RootId): WorldArena;
	/** Settle a node's per-root committed clock after an observer consult
	 * (the one clock-advance site — see the engine's settleObserverClock). */
	settleObserverClock(a: WorldArena, node: AnyInternals): Clock;
	/** The capture sites' dep stamp (resolve arena + settle; 0 = no arena). */
	committedDepStamp(rootId: RootId, node: AnyInternals): Clock;
	releaseArena(a: WorldArena): void;
	getArena(world: World): WorldArena | undefined;
	eachArena(fn: (a: WorldArena) => void): void;
	arenaServe(a: WorldArena, node: AnyInternals): Value;
	fanAtomsToArena(a: WorldArena, atoms: AtomInternals[], fromSettlement: boolean): void;
	fanAtomsToCommittedArenas(atoms: AtomInternals[]): void;
	getSingleAtomBuffer(atom: AtomInternals): AtomInternals[];
	arenaDecay(a: WorldArena): void;
	purgeNodeFromArenas(ix: NodeIndex): void;
	arenaInvalidateSettled(a: WorldArena, suspendSentinel: SuspendedRead): boolean;
	walkArenaStrong(a: WorldArena, from: NodeIndex, kGen: number, gen: number, found: Watcher[]): void;
	collectWatchersAt(nid: NodeIndex, found: Watcher[]): void;
	arenaCollectDrainCandidates(a: WorldArena, gen: number, rootId: RootId, ws: Watcher[]): void;
	collectArenaClosure(a: WorldArena, node: AnyInternals, closure: Set<NodeId>): void;
	runInFoldTruthFrame<T>(world: World, fn: () => T): T;
	dependencyEdges(): Map<NodeId, Set<NodeId>>;
	__arenaLinkMode(rootId: RootId, dep: AnyInternals, sub: AnyInternals): 'strong' | 'weak' | undefined;
	__arenaLinkIdForTest(rootId: RootId, dep: AnyInternals, sub: AnyInternals): number;
	__arenaLinkNextDepForTest(rootId: RootId, linkId: number): number;

	// ---- late-bound: settlement ----
	settleTap(t: PromiseLike<unknown>): void;
	runOperationEpilogue(): void;
	endOperation(): void;
	setSettleCap(n: number): void;
	getPendingSettleCount(): number;

	// ---- late-bound: committed observers (the engine's observer section) ----
	/** The committed `run`-action subscription store (factory-owned; the
	 * engine surface and the resident readers — quiesce sweep, tests — alias
	 * it by identity). */
	idToSubscription: Map<SubscriptionId, Subscription>;
	mountCommittedObserver(rootId: RootId, name: string, refire?: () => void): Subscription;
	captureRun(id: SubscriptionId, body: () => void): void;
	captureRead(node: AnyInternals): Value;
	removeSubscription(id: SubscriptionId): void;
	replayReactEffect(id: SubscriptionId): void;
	revalidateCommittedSubscriptions(rootFilter: RootId | undefined): void;

	// ---- late-bound: deliver (the walk orchestration) ----
	/** The one urgent pre-paint watcher correction (NotificationQueue.ts). */
	correctWatcher(w: Watcher, wInternals: AnyInternals, now: Value, cause: 'retirement' | 'per-root-commit' | 'quiet' | 'mount'): boolean;
	quietDrain(): void;
	drainCommittedObservers(rootId: RootId, cause: 'retirement' | 'per-root-commit'): void;
	deliveryWalk(from: AtomInternals, batch: Batch, slot: BatchSlotMeta, seq: Seq): void;

	// ---- late-bound: RenderPass ----
	/** The watcher→node resolution (RenderPass.ts — generation-checked). */
	resolveWatcherInternals(w: Watcher): AnyInternals | undefined;
	/** The minimum live render pin (the sealed-chunk fold valve's pin
	 * clause floor). */
	getMinLivePin(): Seq;
};

/** The resident-provided slice of the core record (what the composition site
 * must supply; everything else is state the record owns or slots the
 * factories assign). */
export type EngineCoreDeps = Pick<
	EngineCore,
	| 'nodeIndexToInternals'
	| 'nodeToWatchers'
	| 'lastWalk'
	| 'obsRefs'
	| 'syncObservedDeps'
	| 'watchers'
	| 'idToRenderPass'
	| 'rootToOpenRender'
	| 'roots'
	| 'notify'
	| 'notifyState'
	| 'root'
	| 'internalsForAtom'
	| 'internalsForComputed'
	| 'recomputeQuiet'
	| 'nextSeq'
	| 'getSeq'
	| 'getCommittedAdvance'
	| 'advanceCommitted'
	| 'arenaInitInts'
>;

/** A late-bound slot's creation stub (every slot is assigned by its factory
 * before anything can call it; an early call fails loudly as a
 * not-a-function TypeError). */
const LATE = undefined as never;

/** Build the shared core record at the composition site: resident deps in,
 * state fields at their initial values, every factory slot stubbed. */
export function createEngineCore(deps: EngineCoreDeps): EngineCore {
	return {
		...deps,
		// composition-assigned tables
		batch: LATE,
		foldSealedChunks: LATE,
		maybeCloseEpisode: LATE,
		// shared mutable state
		trace: undefined,
		activeWorld: undefined,
		currentSink: 0,
		obsCapture: undefined,
		evalDepth: 0,
		inFoldCallback: false,
		captureFrame: undefined,
		suspendDepth: 0,
		serveOverride: undefined,
		suspendedCount: 0,
		epilogueCheck: undefined,
		opDepth: 0,
		committingRender: undefined,
		walkGen: 0,
		committedSubCount: 0,
		onDelivery: undefined,
		onMountCorrective: undefined,
		onCorrection: undefined,
		// core-created shared columns
		evalMark: [0],
		rootToArena: new Map(),
		arenaPool: [],
		restaled: new Map(),
		// late-bound: World
		evaluate: LATE,
		foldAtom: LATE,
		applyOp: LATE,
		isAtomValueEqual: LATE,
		isValueChanged: LATE,
		runInFoldCallback: LATE,
		createCycleError: LATE,
		setWorld: LATE,
		syncReadRouting: LATE,
		setWorldProvider: LATE,
		setCaptureFrame: LATE,
		routedRead: LATE,
		routedAtomRead: LATE,
		routedComputedRead: LATE,
		// late-bound: WorldArena
		claimArena: LATE,
		settleObserverClock: LATE,
		committedDepStamp: LATE,
		releaseArena: LATE,
		getArena: LATE,
		eachArena: LATE,
		arenaServe: LATE,
		fanAtomsToArena: LATE,
		fanAtomsToCommittedArenas: LATE,
		getSingleAtomBuffer: LATE,
		arenaDecay: LATE,
		purgeNodeFromArenas: LATE,
		arenaInvalidateSettled: LATE,
		walkArenaStrong: LATE,
		collectWatchersAt: LATE,
		arenaCollectDrainCandidates: LATE,
		collectArenaClosure: LATE,
		runInFoldTruthFrame: LATE,
		dependencyEdges: LATE,
		__arenaLinkMode: LATE,
		__arenaLinkIdForTest: LATE,
		__arenaLinkNextDepForTest: LATE,
		// late-bound: settlement
		settleTap: LATE,
		runOperationEpilogue: LATE,
		endOperation: LATE,
		setSettleCap: LATE,
		getPendingSettleCount: LATE,
		// late-bound: committed observers
		idToSubscription: LATE,
		mountCommittedObserver: LATE,
		captureRun: LATE,
		captureRead: LATE,
		removeSubscription: LATE,
		replayReactEffect: LATE,
		revalidateCommittedSubscriptions: LATE,
		// late-bound: deliver
		correctWatcher: LATE,
		quietDrain: LATE,
		drainCommittedObservers: LATE,
		deliveryWalk: LATE,
		// late-bound: RenderPass
		resolveWatcherInternals: LATE,
		getMinLivePin: LATE,
	};
}

/**
 * The world evaluation/fold/routing layer — a factory in the kernel's own
 * style: closes over its state (the eval marks, the routing scratch, the
 * ambient-world provider) and assigns its operation table onto the shared
 * core record (see the module header for the late-binding rule).
 */
export function createWorld(core: EngineCore): void {
	// Stable resident containers, aliased once (identity-shared).
	const roots = core.roots;
	const obsRefs = core.obsRefs;
	const syncObservedDeps = core.syncObservedDeps;
	/** Mark column (by nodeIndex) + generation for per-world cycle detection (no Set allocs). */
	const evalMark = core.evalMark;
	let evalGen: EvalGen = 0;

	/**
	 * The bindings' ambient-world provider: consulted per routed read when no
	 * evaluation world is on stack, and answers from the live call context —
	 * the render world of the render actually running on the current stack, the
	 * committed world of an effect fire — or undefined for "route newest".
	 * A callback (not a start-to-end flag) deliberately: a render that has
	 * completed but not yet committed is not "in render" (the protocol's
	 * render context is null there), so outside-render reads in that window
	 * must resolve newest, and interleaved multi-root renders must each see
	 * their own render.
	 */
	let worldProvider: (() => World | undefined) | undefined;

	/** Capture frame that answered the last resolveRoutedWorld call (scratch,
	 * consumed immediately by the two routed read bodies — a slot instead of a
	 * tuple return so routed reads allocate nothing on the provider path). */
	let routedCap: CaptureFrame | undefined;

	/** Installs/clears the ambient-world provider (bindings seam). */
	function setWorldProvider(provider: (() => World | undefined) | undefined): void {
		worldProvider = provider;
		syncReadRouting();
	}

	/** Central activeWorld setter — keeps the read-routing seams in sync. */
	function setWorld(w: World | undefined): void {
		core.activeWorld = w;
		syncReadRouting();
	}

	/** Arms/disarms read routing (CosignalEngine.ts's one `routingActive` boolean —
	 * the public `.state` getters' inline check): armed while an evaluation
	 * world is on stack, an open capture frame exists, or a driver's ambient
	 * provider could answer — so a driver-less quiet engine costs reads
	 * exactly one boolean check. */
	function syncReadRouting(): void {
		const c = core; // one context load; field accesses below keep the one-load shape
		__setRoutingActive(c.activeWorld !== undefined || worldProvider !== undefined || c.captureFrame !== undefined);
	}

	/** Assigns the capture frame and re-syncs the arming (the subscription manager's
	 * captureRun edges — both the open and the close perform exactly this pair). */
	function setCaptureFrame(f: CaptureFrame | undefined): void {
		core.captureFrame = f;
		syncReadRouting();
	}

	/**
	 * The read-routing resolution order, one copy: fold-purity throw, then
	 * the evaluation world
	 * on stack (reads inside a computed's evaluation are the computed's
	 * dependencies — the capture frame never sees them), then the open
	 * capture frame (committed-for-root; the
	 * frame lands in `routedCap` for the caller's dep capture), then the
	 * driver's ambient provider.
	 */
	function resolveRoutedWorld(): World | undefined {
		const c = core; // one context load; field accesses below keep the one-load shape
		// Fold purity: replayed updaters/reducers (and equals callbacks) must
		// not read signals — world routing would otherwise serve them silently.
		if (c.inFoldCallback) {
			throw new ScheduleError('signal read inside an updater/reducer fold — updaters and reducers must be pure; read what you need before dispatching');
		}
		routedCap = undefined;
		const world = c.activeWorld;
		if (world !== undefined) return world;
		const cap = c.captureFrame;
		if (cap !== undefined) {
			routedCap = cap;
			return { kind: 'committed', root: cap.sub.root };
		}
		const p = worldProvider;
		return p === undefined ? undefined : p();
	}

	/**
	 * The routed public atom read: route a `.state` read to the effective
	 * world; a handle with no engine content gets its node allocated here
	 * (world participation is content — the read is about to give it arena
	 * presence). Returns NOT_ROUTED to take the plain kernel path.
	 * @internal (reached only through index.ts's `Atom.state`)
	 */
	function routedAtomRead(atom: Atom<unknown>): unknown {
		const world = resolveRoutedWorld();
		if (world === undefined) {
			return NOT_ROUTED;
		}
		const cap = routedCap;
		const node = core.internalsForAtom(atom);
		const v = routedRead(node, world);
		if (cap !== undefined) cap.deps.push({ node, value: v, stamp: core.committedDepStamp(cap.sub.root, node) });
		return v;
	}

	/**
	 * The routed public computed read (the computed counterpart of
	 * routedAtomRead): route a
	 * `Computed.state` read to the effective world, allocating engine
	 * content on first sight. Newest resolution declines (NOT_ROUTED): the
	 * plain kernel path is newest serving, seam-free. Reads inside an open
	 * capture frame resolve committed-for-root and append to the dep
	 * snapshot, exactly like routed atom reads.
	 * @internal (reached only through index.ts's `Computed.state`)
	 */
	function routedComputedRead(c: Computed<unknown>): unknown {
		const world = resolveRoutedWorld();
		if (world === undefined || world.kind === 'newest') {
			return NOT_ROUTED; // the plain kernel path is newest serving
		}
		const cap = routedCap;
		const node = core.internalsForComputed(c);
		// The pre-dedup observation capture rides tracked reads;
		// raw handle reads inside world evaluations have no reader hook, so
		// the seam is their capture site (mirrors routedRead's atom half).
		if (core.currentSink !== 0) {
			const oc = core.obsCapture;
			if (oc !== undefined) oc.push(node);
		}
		const v = evaluate(node, world);
		if (cap !== undefined) cap.deps.push({ node, value: v, stamp: core.committedDepStamp(cap.sub.root, node) });
		return v;
	}

	/** Runs an updater/reducer/equals under the fold-purity guard: signal
	 * reads and writes inside these callbacks throw, because they are
	 * replayed per world and must stay pure. */
	function runInFoldCallback<T>(fn: () => T): T {
		const prev = core.inFoldCallback;
		core.inFoldCallback = true;
		try {
			return fn();
		} finally {
			core.inFoldCallback = prev;
		}
	}

	/**
	 * The fold — replay visible entries over base in sequence order with
	 * stepwise equality (an equal step keeps the old reference). Runs over
	 * the packed chunk columns (chunks are already in sequence order — the
	 * log appends in order and folds only whole prefixes).
	 */
	function foldAtom(atom: AtomInternals, world: World): Value {
		const chunks = atom.log.chunks;
		let value = atom.base;
		for (let c = 0; c < chunks.length; c++) {
			const ch = chunks[c]!;
			const n = ch.n;
			const seqs = ch.seqs;
			const retired = ch.retired;
			const slots = ch.slots;
			for (let i = 0; i < n; i++) {
				if (!isVisibleAt(i, world, seqs, retired, slots)) continue;
				const next = applyOp(atom, ch.kinds[i]!, ch.payloads[i], value);
				// Equality order: isEqual(current, incoming) — per replayed entry
				// (the fold re-invokes per entry by design; "once" is scoped to the
				// write path's acceptance decision).
				if (!isAtomValueEqual(atom, value, next)) value = next;
			}
		}
		return value;
	}

	/**
	 * The visibility rule — which log entries each world's fold replays (over the
	 * packed columns; no WriteLogEntry object). The clauses:
	 *  - newest: every log entry (the kernel applies writes eagerly, so this
	 *    world is also readable straight off the kernel arena);
	 *  - render: (1) log entries retired at-or-before the render's pin — permanent
	 *    history the render started from — and (2) log entries from included
	 *    batches up to the pin, so a paused-and-resumed render never sees a
	 *    write that landed after it started;
	 *  - committed-for-root: retired log entries (committed truth as of now) plus
	 *    log entries from batches this root has committed but that are still
	 *    live elsewhere (membership);
	 *  - mountFix: the mount-fixup world (see runMountFixup) — the render's own
	 *    inclusions at its pin, plus committed truth as of now.
	 * (The reference model exports the same rule in WriteLogEntry-object
	 * form — `visible` in cosignals-oracle model.ts; tests/model-view.ts
	 * imports it rather than keeping a copy. It must mirror these clauses.)
	 * Single-caller but the one visibility rule: kept as a named function
	 * deliberately (readability exception, documented here).
	 */
	function isVisibleAt(i: number, world: World, seqs: Seq[], retired: Seq[], slots: BatchSlot[]): boolean {
		switch (world.kind) {
			case 'newest':
				return true;
			case 'render': {
				const w = world.render;
				const r = retired[i]!;
				if (r !== 0 && r <= w.pin) return true; // clause 1: retired by my pin
				return ((w.includedBits >>> slots[i]!) & 1) === 1 && seqs[i]! <= w.pin; // clause 2
			}
			case 'committed': {
				if (retired[i]! !== 0) return true; // committed truth at now
				// Membership consult materializes the root record (reference-model
				// parity: the model's committedSlotsNow() creates it on first consult).
				// Hot arm reads the aliased map directly — `root()` is
				// lookup-or-create, so a hit is what root() would return; only
				// the first consult takes the materializing miss arrow (a fresh
				// record carries committedBits 0 either way, so the answer is
				// value-identical — the arrow is kept for materialization parity).
				return (((roots.get(world.root) ?? core.root(world.root)).committedBits >>> slots[i]!) & 1) === 1;
			}
			case 'mountFix': {
				if (((world.maskBits >>> slots[i]!) & 1) === 1 && seqs[i]! <= world.pin) return true;
				if (retired[i]! !== 0) return true; // committed truth as of now
				return (((roots.get(world.root) ?? core.root(world.root)).committedBits >>> slots[i]!) & 1) === 1; // hot get + materializing miss arrow (see the committed arm)
			}
		}
	}

	/** Apply one op over `prev`, straight off the scalar (kind, payload) pair
	 * (a SET's payload is the value; an UPDATE's is the updater). Replayed
	 * updaters run under both fold guards: the engine's (routed reads throw)
	 * and the kernel's POISON table (raw public reads/writes throw exactly as
	 * in the standalone path). ReducerAtom dispatches arrive here too: the
	 * closure carries the reducer and the captured action. (`WriteKind` is
	 * concurrent.ts's const enum, imported type-only: this one comparison
	 * uses the bare 0/1 codes the two declarations share by construction —
	 * the WriteLog.ts pattern.) */
	function applyOp(atom: AtomInternals, kind: WriteKind, payload: unknown, prev: Value): Value {
		if (kind === 0 /* WriteKind.SET */) return payload;
		return runInFoldCallback(() => {
			// The kernel's fold-purity POISON table guards the replay exactly
			// like the plain-path update() (CosignalEngine.ts's fold-guard pair).
			const saved = foldGuardSwap();
			try {
				return (payload as (p: Value) => Value)(prev);
			} finally {
				foldGuardRestore(saved);
			}
		});
	}

	/** How this atom compares two values — the one equality rule, one copy for
	 * every site that asks (fold replay, the write path's drop check and
	 * eager kernel apply, quiet-mode folds, sealed-chunk folds): Object.is when
	 * the atom carries the default, otherwise the atom's custom comparator
	 * under the fold-purity guard (equality callbacks replay per world, so
	 * signal reads/writes inside them throw — the updater contract). */
	function isAtomValueEqual(atom: AtomInternals, a: Value, b: Value): boolean {
		return atom.eqIsDefault ? Object.is(a, b) : runInFoldCallback(() => atom.equals(a, b));
	}

	/** The value-change gate for compare-and-correct sites,
	 * honoring a custom-equality computed's policy comparator — mountFix
	 * fold-throughs (and evicted-then-refolded arena slots) create fresh
	 * references for comparator-equal values, which are not changes for a
	 * custom-equality node (the kernel wrapper and the arena slot both keep
	 * old references under the same policy). Exceptional payloads never
	 * cross the gate (sentinels compare by identity — pinned in
	 * tests/concurrent-battery.spec.ts).
	 * Default-equality nodes compare by identity. */
	function isValueChanged(node: AnyInternals, prev: Value, next: Value): boolean {
		if (
			node.kind === 'computed' && node.isEqual !== undefined
			&& !(prev instanceof SuspendedRead) && !(next instanceof SuspendedRead)
		) {
			const eq = node.isEqual;
			return !runInFoldCallback(() => eq(prev, next));
		}
		return !Object.is(prev, next);
	}

	/** The engine's one cross-world cycle error (every construction site
	 * builds it here so the surface message can never fork). */
	function createCycleError(name: string): ScheduleError {
		return new ScheduleError(`cyclic evaluation of ${name} within one world — a computed may not depend on itself`);
	}

	/**
	 * Raw-handle reads: an engine atom read reached the operation table
	 * while a world evaluation frame was open (newest/mountFix — arena
	 * fn runs route through `serveOverride` inside readAtomValue and link at `arenaServe`).
	 * The open frame's sink gates the observation capture: the pre-dedup
	 * capture rides the tracked read path.
	 * @internal (called from the concurrent table wrapper)
	 */
	function routedRead(atom: AtomInternals, world: World): Value {
		if (core.currentSink !== 0) {
			const oc = core.obsCapture;
			if (oc !== undefined) oc.push(atom);
		}
		return readAtomValue(atom, world);
	}

	/** Atom value in a world: kernel for newest, the world's arena for
	 * render/committed, a plain fold for mountFix and unmaterialized roots.
	 * (The newest read is the direct kernel read `E.readAtom` — world routing
	 * can never intercept it.) */
	function readAtomValue(atom: AtomInternals, world: World): Value {
		const c = core; // one context load; field accesses below keep the one-load shape
		const route = c.serveOverride; // one override test on the routed-read path
		if (route !== undefined) {
			if (route !== FOLD_TRUTH) return c.arenaServe(route, atom); // arena-refold routing override
			return foldAtom(atom, world); // fold-truth reads (armed checker)
		}
		if (world.kind === 'newest') {
			// The kernel holds the newest fold by the eager-apply invariant.
			// (`atom.id` is the record id — never through the handle slot,
			// which reclamation keeps weak for resolved nodes.)
			return E.readAtom(atom.id);
		}
		if (world.kind === 'render' || world.kind === 'committed') {
			const a = c.getArena(world);
			if (a !== undefined) return c.arenaServe(a, atom);
			// Unmaterialized root (no record): fold plain — a read never
			// creates the root record or its arena.
		}
		return foldAtom(atom, world);
	}

	/**
	 * Evaluation of a node in a world. Render/committed worlds are
	 * arena-served: values, invalidation, and routing structure
	 * live in the world's arena, and `arenaServe` refolds through the arena's
	 * own walks when marks or cold bases demand it — the cold in-arena fn
	 * run is what records the strong and weak links the routing coverage
	 * argument stands on (the cold-render bench gate prices it).
	 * An unmaterialized root has no arena and folds plain. Newest-world
	 * atoms read straight off the kernel arena; newest-world computeds are
	 * kernel-served (one computed representation — `readKernelComputed` below
	 * carries the rule: stale until a tracked dependency changes; untracked
	 * reads are samples taken at re-derivations). mountFix worlds are
	 * one-shot fold-throughs. Reads inside fold callbacks throw
	 * (updaters/reducers must be pure); per-world cycles throw instead of
	 * recursing.
	 */
	function evaluate(node: AnyInternals, world: World): Value {
		const c = core; // one context load; field accesses below keep the one-load shape
		probes.worldEvals++; // engine-activity counter (tests/one-core.spec.ts's zero-cost check)
		if (c.inFoldCallback) throw new ScheduleError('signal read inside an updater/reducer fold — updaters and reducers must be pure; read what you need before dispatching');
		const route = c.serveOverride; // no-override fast-out is the one hot test; FOLD_TRUTH falls through (fold-truth computeds re-run checker-side, never here)
		if (route !== undefined && route !== FOLD_TRUTH) return c.arenaServe(route, node); // arena-refold routing override
		if (world.kind === 'render' || world.kind === 'committed') {
			const a = c.getArena(world);
			if (a !== undefined) return c.arenaServe(a, node);
		}
		if (node.kind === 'atom') return readAtomValue(node, world);
		if (world.kind === 'newest') return readKernelComputed(node);
		// Fold-through evaluation (mountFix worlds + unmaterialized-root
		// committed folds): memo-free recursion in the frame's world.
		// Per-world cycle detection via the mark column: marks carry the
		// current top-level evaluation generation.
		const marks = evalMark;
		if (marks[node.ix] === evalGen && c.evalDepth > 0) {
			throw createCycleError(node.name);
		}
		if (c.evalDepth === 0) evalGen++;
		marks[node.ix] = evalGen;
		c.evalDepth++;
		const savedWorld = c.activeWorld;
		setWorld(world);
		const savedSink = c.currentSink;
		const savedObsCapture = c.obsCapture;
		// Observed nodes capture the strong deps of this run (the readers
		// push); everyone else pays this one check.
		c.obsCapture = obsRefs[node.ix]! > 0 ? [] : undefined;
		c.currentSink = node.ix;
		const tr = c.trace; // paired eval hooks; end fires on throw too
		if (tr !== undefined) tr.evalStart(node, world);
		try {
			return node.fn(trackedReader, untrackedReader);
		} finally {
			const obsCaptured = c.obsCapture;
			c.obsCapture = savedObsCapture;
			c.currentSink = savedSink;
			setWorld(savedWorld);
			c.evalDepth--;
			marks[node.ix] = 0;
			if (tr !== undefined) tr.evalEnd();
			// Observed-closure sync — after every restore, so the discovery
			// evaluations the sync may trigger run on a clean frame stack. On
			// a throw the list holds the deps recorded up to it (see obsEnter
			// for the rule).
			if (obsCaptured !== undefined) syncObservedDeps(node, obsCaptured);
		}
	}

	/**
	 * Newest computed serving — the kernel's `computedRead`. The
	 * untracked-sampling rule: the kernel re-derives only when a
	 * tracked dependency changed — kernel links exist for tracked reads
	 * only — so untracked reads are point-in-time samples taken at those
	 * re-derivations, and a write reaching a computed only through
	 * untracked reads changes no newest answer. Read-site translations
	 * preserve the engine surface: kernel CycleErrors (fresh or cached)
	 * become the engine's cycle error; a PENDING suspension of a
	 * ctx-shaped (handle-resolved) computed folds to its stable sentinel,
	 * served as a value, for
	 * background reads and rethrows for hook-initiated ones; settled
	 * suspensions self-heal inside the kernel's boxedRead before this frame
	 * ever sees them (read-after-await determinism).
	 */
	function readKernelComputed(node: ComputedInternals): Value {
		try {
			return E.computedRead(node.id);
		} catch (err) {
			if (err instanceof CycleError) {
				throw createCycleError(node.name);
			}
			if (err instanceof SuspendedRead && core.suspendDepth === 0 && node.ctxShaped) {
				return err; // adopted ctx fn, background read: the sentinel serves as a value
			}
			throw err;
		}
	}

	/** The persistent tracked reader (mountFix/plain-fold frames — arena fn
	 * runs use arenaTrackedReader; kernel newest runs use kernelTrackedReader):
	 * the pre-dedup observation capture rides the tracked read path,
	 * then the dep evaluates in the frame's world. */
	const trackedReader: Reader = (dep) => {
		const oc = core.obsCapture;
		if (oc !== undefined) oc.push(dep);
		return evaluate(dep, core.activeWorld!);
	};

	/**
	 * The persistent untracked reader: capture-free, not input-free — the
	 * dep still folds in the frame's world (fold-throughs re-derive
	 * everything, so untracked deps stay fresh in these one-shot worlds),
	 * but it never joins the observation capture (the observation union is
	 * strong-only) and — in arena worlds, where arenaUntrackedReader is the
	 * analog — records only a weak link, so no notification ever fires
	 * through it.
	 */
	const untrackedReader: Reader = (dep) => {
		const sink = core.currentSink;
		core.currentSink = 0;
		try {
			return evaluate(dep, core.activeWorld!);
		} finally {
			core.currentSink = sink;
		}
	};

	// ---- the operation table (late-bound onto the shared core record) ----
	core.evaluate = evaluate;
	core.foldAtom = foldAtom;
	core.applyOp = applyOp;
	core.isAtomValueEqual = isAtomValueEqual;
	core.isValueChanged = isValueChanged;
	core.runInFoldCallback = runInFoldCallback;
	core.createCycleError = createCycleError;
	core.setWorld = setWorld;
	core.syncReadRouting = syncReadRouting;
	core.setWorldProvider = setWorldProvider;
	core.setCaptureFrame = setCaptureFrame;
	core.routedRead = routedRead;
	core.routedAtomRead = routedAtomRead;
	core.routedComputedRead = routedComputedRead;
}
