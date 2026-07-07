/**
 * cosignal — the concurrent-worlds engine riding the KERNEL. The kernel is
 * the dependency-tracking engine (index.ts, whose header defines its terms): it
 * stores every signal, computed, effect, and dependency edge as fixed-size
 * integer records in shared arrays — and it holds exactly ONE current value
 * per atom. React's concurrent rendering needs several views of the state
 * to coexist (a paused background render must keep seeing the state it
 * started from while urgent updates land and commit — the README tells the
 * full story), so this module records every write and reconstructs the
 * other views on demand.
 *
 * ONE CORE: this module is internal machinery of the single `cosignal`
 * entry — index.ts imports and re-exports it, and nothing here runs until
 * `registerReactBridge()` attaches the bridge to the kernel through the
 * HOST SEAMS index.ts defines (`__setHostWrite` / `__setHostRead`): the
 * public Atom methods branch to the hooks below when (and only when) a
 * bridge is registered and, for reads, a routing context is live. A
 * never-registered process keeps the hooks undefined and this module inert
 * (tests/one-core.spec.ts asserts zero log entries/batches/worlds/events under
 * heavy sync-only traffic).
 *
 * Vocabulary, in reading order (see also the package README):
 *
 *   - A WRITE-LOG ENTRY records one write: the operation (set / functional update —
 *     a ReducerAtom dispatch records as an update whose closure captures
 *     the action), the batch it belongs to, and its position (`seq`) on
 *     one global timeline. Log entries append to the written atom's WRITE LOG — the
 *     per-atom history (class `WriteLog`). A FOLD replays, in timeline
 *     order, the log entries a given view may see over the atom's BASE (the
 *     permanent history, already collapsed to a single value); a WORLD is
 *     one self-consistent assignment of values to every atom, produced by
 *     such a fold. Ops are stored whole (not pre-folded) so updaters and
 *     reducers replay per world — which is why they must be pure (the
 *     FOLD-PURITY guard: signal reads/writes inside them throw).
 *   - A BATCH is the group of writes belonging to one UI update (one event
 *     handler, one transition, one async action); a Batch record (keyed by
 *     its BatchId) is the batch's identity. React schedules each batch on one of its 31 LANES
 *     (a lane is React's internal unit of scheduling priority; work in one
 *     lane renders and commits together), so at most 31 batches are ever
 *     live at once. Each live batch that has written occupies a SLOT — one
 *     entry of a 31-entry recycling table — so "which batches affect X"
 *     fits in one 31-bit integer word (a BatchSlotSet). INTERNING is claiming a
 *     free slot for a batch at its first write; the slot's current batch is
 *     its TENANT, and a released slot is recycled to the next claimant.
 *   - A RENDER PASS is one render of one root. Its PIN is the timeline
 *     position frozen at render start — the render folds nothing written after
 *     its pin, so a paused-and-resumed render never drifts. Its MASK is the
 *     set of live batches (and their slots) the render is rendering.
 *   - RETIREMENT ends a batch: its log entries become permanent history
 *     visible to every world, and once no world can tell the difference
 *     they COMPACT — fold into the atom's base and are reclaimed. `committedAdvance` is
 *     the committed-advance counter, bumped whenever committed truth moves
 *     (a per-root commit, or a retirement that changed history).
 *   - A WATCHER is one subscribed component instance; a DELIVERY is the
 *     notification that schedules a watcher's re-render after a write.
 *     Deliveries are VALUE-BLIND: a delivery announces "a write in this
 *     batch may affect you", never a value — whether the value changed
 *     depends on the world doing the asking, so the receiving render folds
 *     its own world. A DRAIN is the sweep run when committed truth moves:
 *     re-check every observer the change could reach against committed
 *     state and correct the stale ones.
 *   - The engine keeps two dependency graphs. K0 is the kernel's own graph
 *     (the packed records in index.ts), which only knows newest values. The
 *     other is the per-world WORLD ARENAS (NF2, plans/2026-07-06 §4): one
 *     packed record plane per render world and per committed-for-root world,
 *     holding a SHADOW (value + flags) per consumed node and the strong and
 *     weak-flagged LINKS the world's own evaluations actually took. Arenas
 *     are the routing AND serving authority for render/committed worlds:
 *     write-time deliveries walk arena strong links, durable drains seed
 *     from arena dirty lists, and world reads serve from arena walks.
 *     Committed-truth flips FAN OUT marks into the arenas at four sites
 *     (§4.3): retirement, per-root lock-in, committed-member write, and
 *     quiet fold — plus L4 resource settlement.
 *   - NEWEST COMPUTED SERVING is the kernel's (S-C: one computed). Every
 *     bridge computed rides a kernel `Computed` record: the kernel's own
 *     dep links, staleness marks, and value cache serve the newest world,
 *     so a computed re-derives only when a TRACKED dependency changed —
 *     untracked reads are point-in-time samples taken at those
 *     re-derivations [ruling 2026-07-06: untracked sampling]. Kernel atoms
 *     serve newest directly (the eager-apply invariant); everything else
 *     folds.
 *   - An EPISODE is the stretch between QUIESCENCE points — moments when
 *     nothing is in flight (no live batches, no open renders, no PARKED
 *     actions — async actions kept pending until their promise settles).
 *     At quiescence zero-consumer committed arenas reclaim; populated
 *     arenas PERSIST — their links are current structure, not an episode
 *     log (§4.1) — and the kernel's newest caches persist the same way
 *     (nothing newest-visible changes at quiescence). Sequence values are
 *     NEVER rewritten: the global counter climbs monotonically for the
 *     process's life (exact to 2^53 — see the bound note at `quiesce`).
 *
 * What lives here (full stories at the implementation sites):
 *   - log entries: every write appends {op, slot, seq, retiredSeq} to the
 *     written atom's write log.
 *   - kernel riding: every recorded write also applies to the kernel eagerly
 *     with stepwise equality (each step keeps the previous reference when
 *     the atom's equals function says nothing changed) — bridge atoms are
 *     kernel-backed `Atom` handles, and the newest world is read straight
 *     off the kernel. The engine-vs-reference-model diff verifies kernel
 *     value ≡ fold(base, log entries) at every step of the test corpus.
 *   - arena routing (NF2 S-B): write-time delivery reachability runs from
 *     the written atom over every live arena's STRONG links (weak links are
 *     tested and skipped — untracked reads never notify); kernel (K0)
 *     subscribers are served by the eager kernel apply. Deliveries stay
 *     value-blind and may be FEWER than the model's union-conservative set
 *     (never more): a cone reachable only through structure no live arena
 *     holds lane-degrades to a drain correction (§4.4.5, pinned S-NF2-D1).
 *   - worlds as pure folds with the two-clause visibility rule (see
 *     `visible`), the committed-for-root world, and the fast-forwarded
 *     mount-fixup world (see `mountFixup`).
 *   - per-write value-blind synchronous delivery in the writer's stack with
 *     render-aware suppression, per-(watcher, slot) dedup, and dedup clear at
 *     slot re-intern.
 *   - the slot lifecycle: a retiring tenant stamps its log entries before its
 *     slot releases; a re-claimed slot gets a fresh claim sequence, and a
 *     render's pin/seq checks always postdate the claim; release is deferred
 *     while any open render mask names the slot and re-evaluated at every
 *     render end; disposal keeps conservative touched bits until no live pin
 *     can still need them; a loud release-anyway backstop prevents deadlock.
 *   - retirement ordering stamp → fold → drain → clear-rows → release, with
 *     pin-gated prefix compaction of write logs, and per-root commit lock-in (a
 *     root that committed UI from a still-live batch must keep agreeing
 *     with its own screen).
 *   - MOUNT FIXUP (see `mountFixup`): the commit-edge reconciliation for a
 *     freshly mounted component — contract clause RT6, decided conditions
 *     first. A component can mount while other updates are in flight, and
 *     its subscription only activates at commit, so writes could slip by
 *     unobserved between its render and its commit; fixup joins it to the
 *     pending batches it missed (from write metadata alone), then a
 *     four-condition test decides whether anything committed or retired in
 *     the window — only a failing condition triggers the fast-forwarded
 *     re-evaluation and urgent pre-paint correction. One subtle rule: the
 *     write-clock condition quantifies over the committing render's member
 *     batches at commit time (a batch whose first write landed mid-render
 *     is invisible to the earlier-captured slot set).
 *   - subscriptions (see the Subscription type): the ONE `run`-action
 *     consumer record — committed subscriptions, the PROMOTED production
 *     useSignalEffect mechanism. (Core `effect()`s are NOT bridge records:
 *     they are real kernel effects, flushed by the eager kernel apply —
 *     see logCoreEffectRun.) Committed subscriptions
 *     hold a dep snapshot captured by `captureRun` under committed-for-root
 *     and re-check value-gated at RCC-EF2's amended BOUNDARIES (per-root
 *     commit, retirement, settlement, quiet fold): once per boundary
 *     operation, at the boundary value, never while the subscription's own
 *     root has an open render-pass frame; cleanup guaranteed at removal.
 *     Their dep snapshots also join the RCC-OL1 observation union (one
 *     retain per snapshot node through the obsShift observation index).
 *   - episodes / quiescence (epoch reset), as defined above.
 *
 * The bridge surface consumes the external-runtime protocol's event shapes
 * (batch open/retire, render begin/yield/resume/end with per-root commits,
 * settlements) — the events a patched React build emits about its own
 * scheduling. The React bindings (`cosignal-react`) drive it from a real
 * protocol build; the test suite drives it in lockstep with the reference
 * model (`cosignal-oracle`).
 *
 * Deliberately deferred, marked at each site:
 *   TODO(perf): a "provably quiet" world-read fast path (serve a shared
 *     cache instead of the arena walk when nothing pending can reach the
 *     node). CORRECTNESS CONSTRAINT (fable N-4, §4.4.8): the cold in-arena
 *     fn run is what RECORDS the strong and weak links the whole routing
 *     coverage argument stands on — a re-entry may value-serve ONLY when
 *     the arena already holds the node's links; structure recording may
 *     never be skipped. The B1 read-before-pending pin is the tripwire.
 */

import { Atom, Computed, CycleError, LinkField, NodeField, SuspendedRead, untracked, __assertHostWritable, __ctxUse, __hostApplySet, __hostDisposeComputed, __hostReadNewest, __hostMarkComputedOwned, __hostWrapComputedFn, __kernelBuffer, __kernelComputedRead, __setHostWrite, __setRecordFreeHook, __setSettleTap, __HOST_MISS, type ComputedCtx, type WriteKind as KernelWriteKind } from './index.js';
import { InvariantViolation, ScheduleError, mustGet } from './errors.js';
import { createConcurrentEngine, probes, type WriteKind } from './engine.js';
import type { DeliverTable, NotifyState } from './deliver.js';
import type { ObservationTable } from './observation.js';
import { WriteLog, type CompactionTable, type WriteLogEntry } from './WriteLog.js';
import { BATCH_NONE, type Batch, type BatchId, type BatchSlot, type BatchSlotMeta, type BatchSlotSet, type BatchTable } from './Batch.js';
import { NEWEST, type EngineCore, type World } from './World.js';
import { WorldArena, arenaCheckerLayout, arenaRenumberMarks, kernelNodeIndexOf } from './WorldArena.js';
import type { Subscription } from './Subscription.js';
import { Watcher, type RenderPass, type RenderPassTable } from './RenderPass.js';

// ---- error carriers (errors.ts; re-exported — they are public surface) -----------

export { InvariantViolation, ScheduleError } from './errors.js';

// ---- bridge-surface types (structurally mirror the reference model's) ------------

export type Value = unknown;
/** THE node identity, package-wide: the premultiplied KERNEL record id (the
 * Int32 arena index of the record's field 0 — index.ts vocabulary; also
 * `Atom._id`/`Computed._id`). One id space: the engine allocates no ids of
 * its own. Never dense over nodes — node and link records share the kernel's
 * one allocator — so dense per-node columns key by NodeIndex instead. */
export type NodeId = number;
/** Dense per-node column key: the record's NodeField.NODE_INDEX, assigned by
 * the kernel allocator and RECYCLED with the record slot (a reused record
 * inherits its slot's index — the record-free scrub is what makes that
 * sound). A packing detail, never an identity. */
type NodeIndex = number;
// Batch identity, slots, and slot sets live in Batch.ts (the batch
// MECHANISM module); re-exported here — they are bridge surface.
export { BATCH_NONE } from './Batch.js';
export type { Batch, BatchId, BatchSlot, BatchSlotMeta, BatchSlotSet } from './Batch.js';
export type RootId = string;
export type RenderPassId = number;
export type WatcherId = number;
export type EffectId = number;
/** A point on the one global sequence line (log-entry seqs, pins, retirement
 * stamps, write clocks, the committed-advance counter). */
export type Seq = number;
/** Episode counter: bumped at quiescence when the engine's per-node-id tables bulk-reset. */
export type Epoch = number;
/** A root's commit generation (bumped at every per-root commit). */
export type CommitGen = number;
/** Per-walk visited generation (walk termination without Set allocations). */
type WalkGen = number;
/** Top-level world-evaluation generation (per-world cycle detection marks). */
type EvalGen = number;

// The per-atom write log and its compaction mechanism live in WriteLog.ts;
// re-exported here — the class and the entry shape are bridge surface.
export { WriteLog } from './WriteLog.js';
export type { WriteLogEntry } from './WriteLog.js';

// Write-kind tags — `const enum WriteKind` (0 = set, 1 = update) — live in
// engine.ts (the composition root; the engine merge collapses the kernel's
// same-encoding twin into it). Re-exported TYPE-ONLY: this module's write
// path (like World.ts applyOp and WriteLog.ts) compares the shared bare
// 0/1 codes directly with a naming comment — cross-module const enum
// access does not survive per-file transforms.
export type { WriteKind } from './engine.js';

export type Equals = (a: Value, b: Value) => boolean;

export class AtomNode {
	readonly kind = 'atom' as const;
	readonly id: NodeId;
	/** Cached NodeField.NODE_INDEX of `id`'s record: object-carrying paths pay
	 * one property read; raw id-driven walks read it from kernel memory. Stable
	 * for the node's life (the index moves only when the record slot re-tenants,
	 * which this node does not survive). @internal */
	readonly ix: NodeIndex;
	name: string;
	/** The folded floor of the write log: retired, compacted history every world sees. */
	base: Value;
	baseSeq: Seq = 0;
	/** Packed log entry columns (the engine truth; tests/diagnostics materialize
	 * them via `log.materialize()`; the referee's model-shaped view lives in
	 * tests/model-view.ts). */
	log = new WriteLog();
	equals: Equals;
	/** True iff `equals` is the default Object.is — eqAtom's branch: the
	 * default compares bare, a custom comparator runs under the fold-purity
	 * guard. */
	eqIsDefault: boolean;
	/** Per-atom retirement stamp, created at every retirement fold touching it.
	 * Sole remaining consumer: retireInternal's duplicate-touch dedup (the
	 * memo ladder that read it as a fingerprint clock is deleted — S-C/S-D). */
	retirementStamp: Seq = 0;
	/** The kernel-backed newest-world storage this overlay rides. */
	handle: Atom<Value>;
	/** Last batch id that appended here (dedupe for batch.atomsTouched). */
	lastTouchBatch: BatchId = 0;

	constructor(id: NodeId, ix: NodeIndex, name: string, initial: Value, equals: Equals, eqIsDefault: boolean, handle: Atom<Value>) {
		this.id = id;
		this.ix = ix;
		this.name = name;
		this.base = initial;
		this.equals = equals;
		this.eqIsDefault = eqIsDefault;
		this.handle = handle;
	}
}

export type Reader = (node: AnyNode) => Value;
export type ComputedFn = (read: Reader, untracked: Reader) => Value;

/**
 * The bridge's computed node record (S-C: one computed — no overlay
 * representation). Every bridge computed RIDES a kernel `Computed` record:
 * the kernel serves the newest world (links, marks, value cache — the
 * sampled-untracked rule falls out of kernel semantics), and the bridge
 * evaluates `fn` under render/committed worlds through the arena walks. For
 * bridge-created computeds `fn` is the authored (read, untracked) function;
 * for adopted public `Computed` handles it is the bridge's ctx adapter
 * (committed `previous` cell, `use` over the handle's own `_useCache`,
 * background-suspension fold) around the handle's raw fn.
 */
export type ComputedNode = {
	kind: 'computed';
	id: NodeId;
	/** Cached NodeField.NODE_INDEX of `id`'s record (see AtomNode.ix). @internal */
	ix: NodeIndex;
	name: string;
	/** The WORLD evaluation function (arena refolds, mount-fix folds). */
	fn: ComputedFn;
	/** The kernel record this node rides (newest serving + kernel links). */
	handle: Computed<unknown>;
	/** True for adopted public handles (ctx-shaped raw fns): their world fn
	 * is the bridge's ctx adapter, and background newest reads fold pending
	 * suspensions to sentinel values (the old React-bindings wrapper translation). */
	ctxShaped: boolean;
	/** §4.5.3 retention: the policy comparator (HEAD order `isEqual(prev,
	 * next)`), applied by arena refolds against the ARENA-local previous
	 * value; undefined = default equality (Object.is). */
	isEqual: Equals | undefined;
	/** ctx.previous cell for adopted ctx-shaped fns: the node's last
	 * COMMITTED value (a best-effort hint; may be stale or undefined),
	 * updated at render commits from the watchers that rendered it. */
	prevCell: { value: Value };
};

export type AnyNode = AtomNode | ComputedNode;

// (The `Batch` record and `BatchSlotMeta` slot-table entry types live in
// Batch.ts with the batch mechanism; re-exported above. The `RenderPass`
// record, the `Watcher` class, and the watcher snapshot live in
// RenderPass.ts with the render lifecycle; re-exported here — they are
// bridge surface.)

export { Watcher } from './RenderPass.js';
export type { RenderPass, RenderPassState, WatcherSnapshot } from './RenderPass.js';

export type RootState = {
	id: RootId;
	/** Per-root lock-in rows: batches this root has committed but that are
	 * still live elsewhere (cleared at retirement, when the retired clause
	 * subsumes membership). */
	committedBatches: Set<BatchId>;
	commitGen: CommitGen;
	/** The root's CURRENT committed-slot set (live committed batches' slots)
	 * — maintained at per-root commit, late slot intern, and retirement. */
	committedBits: BatchSlotSet;
	/** Member slots written since the last drain. A write into a slot that is
	 * already a committed member changes committed truth immediately, so the
	 * next durable drain must reconcile everything downstream of it (the
	 * reference model's full observer scan catches this at any
	 * retirement/commit; the engine keeps the precise dirty set instead). */
	committedDirtySlots: BatchSlotSet;
};

// The committed `run`-action Subscription record and its whole lifecycle
// (registration, capture frame, removal, replay, boundary revalidation)
// live in Subscription.ts; the type is re-exported here — it is bridge
// surface. The `World` type — one self-consistent assignment of values to
// all atoms — and the fold/evaluation/read-routing machinery live in
// World.ts, beside the one shared engine-core record the strongly-connected
// mechanism factories are wired through.
export type { Subscription } from './Subscription.js';
export type { World } from './World.js';

/** The DECODED shape of the engine's observable events (same shapes as the
 * reference model's events, so the two can be compared entry by entry). The
 * engine constructs these objects NOWHERE: instrumentation sites create packed
 * trace records directly (see TraceHooks below), and the test-side decoder
 * (tests/trace-events.ts) reconstructs this shape from an attached tracer's
 * records for lockstep/referee comparison. The type stays declared and
 * exported here because the package entry re-exports it (type-only) and the
 * decoder/oracle parity pin is written against it. */
export type TraceEvent =
	| { type: 'write'; node: string; batch: BatchId; slot: BatchSlot; seq: Seq }
	| { type: 'write-dropped'; node: string; batch: BatchId }
	/** A quiet-mode fold: the whole write while nothing was pending — no
	 * batch, no log entry, no slot; `seq` is the fold's created sequence (the
	 * atom's new baseSeq and the committed-advance clock). */
	| { type: 'quiet-write'; node: string; seq: Seq }
	| { type: 'delivery'; watcher: string; batch: BatchId; slot: BatchSlot; seq: Seq; mode: 'fresh' | 'interleaved' }
	| { type: 'suppressed'; watcher: string; batch: BatchId; slot: BatchSlot; seq: Seq }
	| { type: 'core-effect-run'; effect: string; value: Value }
	| { type: 'react-effect-run'; effect: string; root: RootId; value: Value; values: Value[] }
	| { type: 'react-effect-cleanup'; effect: string; root: RootId }
	| { type: 'reconcile-correction'; watcher: string; root: RootId; from: Value; to: Value; cause: 'retirement' | 'per-root-commit' }
	| { type: 'mount-corrective'; watcher: string; batch: BatchId; slot: BatchSlot }
	| { type: 'mount-urgent-correction'; watcher: string; from: Value; to: Value }
	| { type: 'per-root-commit'; root: RootId; batch: BatchId }
	| { type: 'retired'; batch: BatchId; retiredSeq: Seq }
	| { type: 'slot-claimed'; slot: BatchSlot; batch: BatchId }
	| { type: 'slot-released'; slot: BatchSlot; batch: BatchId }
	| { type: 'slot-backstop-released'; slot: BatchSlot; batch: BatchId }
	| { type: 'render-committed'; renderPass: RenderPassId; root: RootId }
	| { type: 'render-discarded'; renderPass: RenderPassId; root: RootId }
	| { type: 'epoch-reset'; epoch: Epoch };

/**
 * The trace seam. The concurrent engine's semantic events flow to an OPTIONAL
 * hook object held in `CosignalBridge.trace` — `undefined` unless
 * `cosignal/trace` (a lazily loaded, runtime-import-free entry) has attached
 * a recorder. Discipline, asserted by tests/trace-off.spec.ts:
 *
 *  - this module NEVER imports the trace module (the module graph gains
 *    tracing only when the app imports `cosignal/trace`);
 *  - every hook site is guarded by exactly one nullable-slot check
 *    (`const tr = this.trace; if (tr !== undefined) ...`) — that one check
 *    is the entire cost when no tracer is attached;
 *  - hooks receive the engine's own live objects and integers; they must not
 *    mutate them, and the recorder must not allocate per event (one
 *    documented exception: `reactEffectRun`'s dep-values array, built by its
 *    site only under the guard — the lockstep referee compares it).
 *
 * ONE channel: the packed trace stream. Every instrumentation site creates its
 * record directly through a typed hook — scalars and live engine objects in,
 * one fixed-size record out; no intermediate event object exists anywhere.
 * The hook set covers the observable event vocabulary (`TraceEvent`, decoded
 * test-side) plus trace-only semantics: batch open/settle, render
 * start/yield/resume/end (fired BEFORE the end's consequences, unlike the
 * post-consequence renderCommitted/renderDiscarded markers), per-log-entry ops,
 * world evaluations, deferred slot release, and the mount fixup disposition
 * (fast-out vs compare vs correction). `opEnd()` marks the close of each
 * compound public operation so the recorder can scope causality (see
 * trace.ts `CAUSE`).
 */
export type TraceHooks = {
	/** A log entry was created — THE write record (carries op/batch/slot/seq). */
	logEntry(node: AtomNode, entry: WriteLogEntry): void;
	/** A write dropped without a log entry (empty write log + equal against base). */
	writeDropped(node: AtomNode, batch: BatchId): void;
	/** A quiet-mode fold accepted (no batch, no log entry; seq = the fold's clock). */
	quietWrite(node: AtomNode, seq: Seq): void;
	/** A batch was created. */
	batchOpen(t: Batch): void;
	/** An async-action batch settled (its retirement follows). */
	batchSettle(t: Batch): void;
	/** The external runtime's committed/abandoned report for a batch. Created
	 * by the BINDINGS' protocol handler — the site where the fact is born —
	 * never by the engine: retirement itself is disposition-blind (recorded
	 * writes never revert either way), so the flag exists only as this
	 * source-side diagnostic record. */
	batchDisposition(batch: BatchId, committed: boolean): void;
	/** RenderPass edges (end fires before retirements/commits/fixups). */
	renderStart(p: RenderPass): void;
	renderYield(p: RenderPass): void;
	renderResume(p: RenderPass): void;
	renderEnd(p: RenderPass, kind: 'commit' | 'discard'): void;
	/** Post-consequence referee markers: every retirement fold / lock-in /
	 * drain / fixup of the render end has landed (the reference model's stream
	 * position for its render events). */
	renderCommitted(p: RenderPass): void;
	renderDiscarded(p: RenderPass): void;
	/** A value-blind delivery reached a live watcher. */
	delivery(w: Watcher, batch: BatchId, slot: BatchSlot, seq: Seq, interleaved: boolean): void;
	/** Delivery skipped: scheduled-but-unstarted work will fold the write. */
	suppressed(w: Watcher, batch: BatchId, slot: BatchSlot, seq: Seq): void;
	/** A core effect's value-gated run (via the bridge's logCoreEffectRun seam). */
	coreEffectRun(effect: string, value: Value): void;
	/** A committed-world observer ran; `values` is its dep snapshot (the one
	 * per-event array a site builds, tracer-attached only — referee-compared). */
	reactEffectRun(effect: string, root: RootId, value: Value, values: Value[]): void;
	/** A committed-world observer's cleanup ran (pre-re-run or removal). */
	reactEffectCleanup(effect: string, root: RootId): void;
	/** A drain moved this watcher's on-screen value to follow committed truth. */
	reconcileCorrection(w: Watcher, root: RootId, from: Value, to: Value, perRootCommit: boolean): void;
	/** Mount catch-up: a corrective re-render joined a live batch's lane. */
	mountCorrective(w: Watcher, batch: BatchId, slot: BatchSlot): void;
	/** The urgent pre-paint mount-window fix. */
	mountCorrection(w: Watcher, from: Value, to: Value): void;
	/** A root locked a batch in; commitGen is the root's (just-bumped) generation. */
	perRootCommit(root: RootId, batch: BatchId, commitGen: CommitGen): void;
	/** The batch retired: its writes became permanent history. */
	retired(batch: BatchId, retiredSeq: Seq): void;
	/** Slot lifecycle (claim / identity release / loud backstop eviction). */
	slotClaimed(slot: BatchSlot, batch: BatchId): void;
	slotReleased(slot: BatchSlot, batch: BatchId): void;
	slotBackstopReleased(slot: BatchSlot, batch: BatchId): void;
	/** A computed evaluation in a world opened/closed (paired; end fires on throw too). */
	evalStart(node: ComputedNode, world: World): void;
	evalEnd(): void;
	/** A retired tenant's release was deferred (an open render mask names the slot). */
	slotReleaseDeferred(slot: BatchSlot, batch: BatchId): void;
	/** One per mount: how fixup resolved, and how many correctives were scheduled. */
	mountFixup(
		w: Watcher,
		disposition: 'fast-out' | 'compare-clean' | 'corrected',
		correctives: number,
	): void;
	/** Quiescence reset the engine's per-episode state. */
	epochReset(epoch: Epoch): void;
	/** A compound public operation (write / renderEnd / retire / settle / quiesce) finished. */
	opEnd(): void;
};

// (SLOT_COUNT — the 31-slot table bound — lives in Batch.ts with the slot table.)

// ---- module state + the concurrent operation table ------------------------------

/** The bridge whose registered atoms the host hooks route for (one active). */
let activeBridge: CosignalBridge | undefined;
/** True while the bridge itself is applying a recorded write to the kernel
 * (the host write hook's recursion guard: the apply re-enters `Atom.set`). */
let bridgeApplying = false;
/** The public registerReactBridge() has been consumed (it may run only once). */
let publiclyRegistered = false;

// ---- One Core probes (referee surface) --------------------------------------------
// The counter record lives in probes.ts (its mutation sites now span
// WriteLog.ts, Batch.ts, and this file — see the probes.ts header); engine
// logic never reads it. (The old bridgeEvents probe died with the
// object-event channel: events are packed trace records now, created only
// behind each site's tracer guard — with no tracer attached there is no
// event machinery left to count.)

/** Referee surface — a snapshot of the engine-activity counters for the zero-cost test. @internal */
export function __coreProbes(): { logEntries: number; batches: number; worldEvals: number; bridges: number } {
	return { ...probes };
}

// ---- the host-hook implementations (installed into index.ts's public methods) -----

/**
 * The host write interceptor: a public write is attributable to a batch when
 * a bridge is registered and the write is not the bridge's own kernel apply.
 * The bindings' classifier (when installed) owns classification — batch
 * context, adoption-on-first-write, render guard; without bindings, writes to
 * REGISTERED atoms classify into the ambient default batch and everything
 * else takes the plain kernel path. The public method's scalar
 * (kind, payload) pair passes through unchanged — no op object exists on
 * this path (KernelWriteKind and WriteKind share the 0/1 encoding by construction).
 */
function hostWriteImpl(atom: Atom<unknown>, kind: KernelWriteKind, payload: unknown): boolean {
	const b = activeBridge;
	if (b === undefined || bridgeApplying) {
		return false; // no host / the host's own kernel apply: plain path
	}
	// Policy first, capture second: a write the policy layer rejects
	// (forbidWritesInComputeds) must throw BEFORE any log entry can land.
	__assertHostWritable();
	const classify = b.writeClassifier;
	if (classify !== undefined) {
		classify(atom, kind, payload);
		return true;
	}
	const node = b.nodeFor(atom); // the ONE stamp-validate + registry-probe rule
	if (node === undefined) {
		return false; // unregistered and no adopter: exactly base semantics
	}
	if (b.quiet) {
		// Quiet mode: nothing is pending, so the whole write is one fold —
		// no ambient batch, no log entry, no walk (Phase 1b).
		b.__quietWrite(node, kind, payload);
		return true;
	}
	b.bareWrite(node, kind, payload);
	return true;
}

/** The host read router (armed only while a routing context is live). */
function hostReadImpl(atom: Atom<unknown>): unknown {
	return activeBridge === undefined ? __HOST_MISS : activeBridge.hostRead(atom);
}

/** The host COMPUTED read router (S-C twin of hostReadImpl; armed together). */
function hostComputedReadImpl(c: Computed<unknown>): unknown {
	return activeBridge === undefined ? __HOST_MISS : activeBridge.hostComputedRead(c);
}

/** NF2 S-A: the settle-tap router (ONE closure per process; the kernel's
 * shared listener consults it at fire time — §4.5.4). */
function settleTapImpl(t: PromiseLike<unknown>): void {
	const b = activeBridge;
	if (b !== undefined) b.__settleTap(t);
}

/** The record-free router (ONE closure per process, kernel-registered at
 * bridge registration): the kernel's boundary sweep reports every freed node
 * record; the active bridge scrubs its nodeIndex-keyed rows so the slot's
 * next tenant (which inherits the index) starts clean. Abandoned test
 * bridges keep stale rows — they never run again. */
function recordFreeImpl(recordId: NodeId, nodeIndex: number): void {
	const b = activeBridge;
	if (b !== undefined) b.__onRecordFree(recordId, nodeIndex);
}

// (kernelGenOf / kernelNodeIndexOf — the live kernel-memory tenancy/index
// reads — live in WorldArena.ts beside their hottest consumers, imported
// above for the registry and the resident walks.)

/** An arena buffer capacity, counted in Int32 slots (stride-8 records: one
 * node shadow or one dependency link per record). */
export type ArenaInitInts = number;

/** Construction-time bridge tuning (the bridge-level analog of the kernel's
 * `configure()`). */
export type BridgeOptions = {
	/**
	 * Every claimed world arena's buffer starts at this capacity and grows
	 * in place when its records outgrow it (default 8192 ints). Shrinking it
	 * makes even small graphs exercise mid-operation growth, which is how the
	 * arena suites pin every growth path.
	 */
	arenaInitInts?: ArenaInitInts;
	/**
	 * Arms development-time checks in the bindings driving this bridge:
	 * protocol-edge states the host integration contract makes unreachable
	 * (a write with no batch context, a render pass starting over a
	 * still-open one, a transition with no batch context) throw instead of
	 * taking their defined fall-through, and dev-only diagnostics (the
	 * post-await orphan-write warning) run. The engine itself never branches
	 * on it — it lives here so hosts and bindings share one switch. Default
	 * off: each guarded site then costs one boolean branch and allocates
	 * nothing. Test harnesses arm it so suites exercise the throws.
	 */
	devChecks?: boolean;
};

/**
 * Activates the concurrent engine: arms the kernel's host seams
 * (`__setHostWrite` / read routing), exactly once per process, and returns
 * the bridge that the React bindings (or a test driver simulating them)
 * drive with protocol events. Throws inside any open evaluation/fold frame
 * (the seams must not arm under a live kernel frame) and on
 * re-registration.
 */
export function registerReactBridge(options?: BridgeOptions): CosignalBridge {
	if (publiclyRegistered) {
		throw new Error('cosignal: registerReactBridge may only be called once per process.');
	}
	const bridge = new CosignalBridge(options);
	bridge.registerBridge(); // arms the seam + marks the bridge registered
	publiclyRegistered = true;
	return bridge;
}

/**
 * Test-only: a fresh, unregistered bridge instance (the per-schedule "fresh
 * model" analog — the module seam still arms only once per process; kernel
 * records of abandoned bridges are inert). Referees that need the event
 * stream attach a lossless session tracer themselves (tests/trace-events.ts)
 * — observation via the tracer does not perturb: the bridge keeps PRODUCTION
 * write semantics (quiet folds while nothing is pending), and the oracle
 * mirrors them, so lockstep referees the real default write path. @internal
 */
export function __newBridgeForTest(options?: BridgeOptions): CosignalBridge {
	return new CosignalBridge(options);
}

// ---- NF2: per-world world arenas (plans/2026-07-06 §4) ---------------------------
// The WorldArena record class, its same-file layout const enums, the
// transliterated walk family, and the whole serving/lifecycle layer
// (serve/refold, claim/release/pool, fanout, decay, the routing walks) live
// in WorldArena.ts; the FOLD_TRUTH serve-override marker and the world
// fold/evaluation/read-routing layer live in World.ts. Both are composed by
// engine.ts (createConcurrentEngine, called by the constructor below)
// through ONE shared engine-core record (World.ts
// `EngineCore`): each factory assigns its operation table onto the record,
// and every cross-module call reads its late-bound slot at call time — the
// wiring that closes the evaluate → arenaServe → foldAtom recursion. The
// class re-exports the arena class (bridge surface) and keeps own-field
// aliases of the hot table entries so resident callers keep their one-load
// call shapes.
export { WorldArena } from './WorldArena.js';

/**
 * The armed checker's window into the engine (W3) — returned by
 * `CosignalBridge.__checkerInternals`, consumed only by the test-side
 * referee (tests/arena-checker.ts: the divergence check and the structural
 * validator). Readonly-shaped: live state getters plus bracket methods
 * that keep every mutation's save/restore discipline engine-side.
 * @internal
 */
export type ArenaCheckerInternals = {
	/** Arena record layout as plain numbers, restricted to the fields the
	 * structural validator reads. The engine's ArenaField/ArenaLinkField/
	 * ArenaFlag/ArenaGeom are same-file const enums: the OWNER inlines the
	 * values into this object at construction, so the view is in sync by
	 * construction — a layout change here flows through automatically, unlike
	 * a hand-copied declaration. Data-passing stays (deliberate): the arena
	 * layout is bridge-internal with ONE external reader (the test referee),
	 * and exporting the enums for it would widen the module surface without
	 * deleting any drift risk. (Contrast the KERNEL's layout, which has
	 * independent walkers and is therefore exported from index.ts —
	 * NodeField/LinkField/NodeFlag.) ArenaField/ArenaLinkField entries are
	 * Int32 word offsets within a record; ArenaFlag entries are FLAGS bits;
	 * ArenaLinkMode entries are MODE bits; ArenaGeom.ID_TO_COLUMN_SHIFT
	 * converts a record id to its side-column index; ArenaGeom.CLOCK_LIMIT is
	 * the Int32 clock-wrap renumber ceiling (readClock/cycle). */
	readonly layout: {
		readonly ArenaGeom: { readonly ID_TO_COLUMN_SHIFT: number; readonly CLOCK_LIMIT: number };
		readonly ArenaField: {
			readonly NODE: number;
			readonly MARK: number;
			readonly FLAGS: number;
			readonly DEPS: number;
			readonly SUBS: number;
		};
		readonly ArenaLinkField: {
			readonly DEP: number;
			readonly SUB: number;
			readonly PREV_DEP: number;
			readonly NEXT_DEP: number;
			readonly NEXT_SUB: number;
			readonly MODE: number;
		};
		readonly ArenaLinkMode: { readonly WEAK: number };
		readonly ArenaFlag: { readonly DIRTY: number; readonly BOX_SUSPENDED: number };
	};
	/** Open world-evaluation frames — the checker must not run inside one
	 * (an epilogue can fire from a nested context; the check waits for the
	 * next top-level boundary). */
	readonly evalDepth: number;
	/** An updater/reducer/equals fold callback is on the stack (same bar). */
	readonly inFoldCallback: boolean;
	/** Every LIVE arena: committed arenas by root, then open-render arenas —
	 * the check's iteration domain (the stores are private). */
	eachArena(fn: (a: WorldArena) => void): void;
	/** The dense node row by NODE INDEX (the arenas' NODE-column key), or
	 * undefined for a disposed index (an arena's nodeToShadow rows can
	 * outlive their node — the checker skips those). */
	nodeAt(ix: number): AnyNode | undefined;
	/** `arenaServe` — THE arena serving entry (values, walks, refolds). The
	 * checker serves the arena side FIRST, pinning the discipline that a
	 * stale shadow is never refreshed by the reference side before the
	 * comparison reads it. */
	serve(a: WorldArena, node: AnyNode): Value;
	/** One fold-truth fn run (see `foldTruthFrame`): world pinned, serve
	 * override at FOLD_TRUTH, capture/sink closed, eval depth bumped —
	 * everything restored on the way out. */
	foldTruthFrame<T>(world: World, fn: () => T): T;
	/** The bridge's ONE cycle-error construction — the naive side's cycle
	 * throws must compare string-equal to the arena side's. */
	cycleError(name: string): ScheduleError;
	/** The fold-purity bracket: the checker runs user equality comparators
	 * under it, exactly like every other comparator call site. */
	inCallback<T>(fn: () => T): T;
	/** Op-depth bracket around one whole check pass: settle taps landing
	 * mid-check enqueue for the epilogue's drain instead of draining
	 * re-entrantly (the discipline the in-class check kept via opDepth). */
	holdOp<T>(fn: () => T): T;
	/** Install (or clear) the armed epilogue hook — fired after every
	 * public operation's settlement fixed point. */
	armEpilogueCheck(check: (() => void) | undefined): void;
};

// ---- the bridge -----------------------------------------------------------------

/**
 * The concurrent-worlds engine. Method-for-method it exposes the surface the
 * external-runtime protocol drives (batches, renders, commits, retirements) —
 * the same surface the reference model (`cosignal-oracle`) implements, so the
 * two can run any schedule in lockstep. The kernel integration points are:
 * `AtomNode.handle` (kernel-backed newest storage, eager stepwise apply on
 * every recorded write) and the module-level concurrent table (public-write
 * classification + world read routing).
 *
 * Referee surface: the twin tests run the oracle's `checkInvariants` /
 * `snapshotModel` against a MODEL VIEW of this class (tests/model-view.ts)
 * that materializes the model's shape — write logs, archives, origins, dedup
 * sets — from packed engine state plus a driver-side mirror fed by the
 * `onCompact` hook, so the production class carries no mirror members. The
 * few remaining "Referee surface" tags mark counters/knobs the engine
 * creates but never reads.
 */
export class CosignalBridge {
	/** Registered nodes (atoms AND computeds) by NodeId — the kernel record
	 * id, one id space. `disposeComputed` and the record-free scrub clear
	 * rows, so a REUSED record id can never resolve to a dead tenant. */
	idToNode = new Map<NodeId, AnyNode>();
	/** Batch records by id (alias of Batch.ts's registry, by identity — the
	 * resident orchestration and the tests read it in place). */
	idToBatch: Map<BatchId, Batch>;
	/** The 31-entry recycling slot table (alias of Batch.ts's, by identity). */
	slots: BatchSlotMeta[];
	idToRenderPass = new Map<RenderPassId, RenderPass>();
	roots = new Map<RootId, RootState>();
	watchers = new Map<WatcherId, Watcher>();
	/** The committed `run`-action subscription store (alias of
	 * Subscription.ts's, by identity — the resident sweeps and the tests
	 * read it in place; see the Subscription type over there). */
	idToSubscription: Map<EffectId, Subscription>;
	/**
	 * The trace recorder slot — the engine's ONLY instrumentation output.
	 * `undefined` (the permanent state unless `cosignal/trace` attaches):
	 * every instrumentation site pays one load + undefined check, nothing
	 * else. Assigned only by `attachTracer`/`Tracer.stop` over there. Sites
	 * create fixed-size packed records straight through these hooks — no event
	 * objects exist, and the engine retains nothing on the tracer's behalf
	 * (the tracer's ring/session buffers hold the capture; referees decode
	 * records on demand — tests/trace-events.ts). Attaching observes the
	 * write path, it never changes which one runs (deliberately NO quiet
	 * recompute here or in attachTracer). STORAGE lives on the shared engine
	 * core record (the extracted mechanisms read the same one slot); this
	 * accessor pair is the public `bridge.trace` surface over it.
	 */
	get trace(): TraceHooks | undefined {
		return this.core.trace;
	}
	set trace(hooks: TraceHooks | undefined) {
		this.core.trace = hooks;
	}

	// ---- direct listeners (the bindings' consumption surface; no allocation) ----
	// Listener callbacks are DELIVERED AT THE OPERATION BOUNDARY — queued into
	// reusable columns during the walk and invoked after the public operation's
	// own mutations complete (the same timing the bindings' old post-op event
	// drain had), so a listener can never re-enter a half-finished operation.
	// STORAGE lives on the shared engine core record (the deliver walks and
	// the mount fixup read the same one slot each); these accessor pairs are
	// the public assignment surface over it.
	/** A value-blind delivery reached a live watcher (fresh or interleaved). */
	get onDelivery(): ((w: Watcher, batch: Batch, slot: BatchSlot) => void) | undefined {
		return this.core.onDelivery;
	}
	set onDelivery(fn: ((w: Watcher, batch: Batch, slot: BatchSlot) => void) | undefined) {
		this.core.onDelivery = fn;
	}
	/** Mount fixup scheduled a corrective re-render into a live batch's lane. */
	get onMountCorrective(): ((w: Watcher, batch: Batch, slot: BatchSlot) => void) | undefined {
		return this.core.onMountCorrective;
	}
	set onMountCorrective(fn: ((w: Watcher, batch: Batch, slot: BatchSlot) => void) | undefined) {
		this.core.onMountCorrective = fn;
	}
	/** An urgent pre-paint correction (mount window / committed-truth drift). */
	get onCorrection(): ((w: Watcher) => void) | undefined {
		return this.core.onCorrection;
	}
	set onCorrection(fn: ((w: Watcher) => void) | undefined) {
		this.core.onCorrection = fn;
	}

	// The notification queue mechanism (deliver.ts): columns + enqueue/flush,
	// composed per bridge by engine.ts. `notifyState` aliases the
	// table's two live scalars so the resident hot checks (the quiet-write
	// flush guard, the settle tap's flushing guard) stay plain field reads.
	private readonly notify: DeliverTable;
	private readonly notifyState: NotifyState;

	/** Flipped once by registerBridge(). There is no bridge-level
	 * pre-registration era: production writes reach a bridge only through the
	 * kernel write hook, which arms at registration — anything earlier is
	 * plain kernel state that never involves a bridge. The referee-only write
	 * surface therefore throws on an unregistered bridge (fail fast, never limp). */
	private _registered = false;
	/** Has a concurrent host registered this bridge yet? (Read-only; adapters
	 * use it to register an injected bridge exactly once.) */
	get registered(): boolean {
		return this._registered;
	}
	/** The one global sequence line every log entry/pin/stamp is a point on. */
	seq: Seq = 0;
	/** Committed-advance counter, in sequence units: bumped whenever committed
	 * truth moves (per-root commit, or a retirement that changed history). */
	committedAdvance: Seq = 0;
	/** Episode counter; bumped at quiescence when the engine's per-node-id tables bulk-reset. */
	epoch: Epoch = 0;

	// ---- routing walk scratch (arena walks + collection dedup) ----
	// DENSE PER-NODE COLUMNS: keyed by nodeIndex (NodeField.NODE_INDEX — read
	// off kernel record memory; node objects cache it as `.ix`), NEVER by
	// NodeId — node and link records share the kernel's one allocator, so
	// record-id keying would go holey where index keying stays packed. Each
	// column's row for a freed record clears in __onRecordFree (the
	// record-free scrub): indexes recycle with record slots, and the slot's
	// next tenant must never see the old tenant's rows.
	/** Per-NODE visited/collection generation column: one stamp per nodeIndex,
	 * shared by the routing walks (delivery collection dedup across
	 * arenas, drain candidate dedup) — arena TRAVERSAL termination uses the
	 * per-arena `walk` side column instead, because the same node's cone
	 * differs per arena and must be walked in each. */
	private lastWalk: WalkGen[] = [0];
	/** Nodes by nodeIndex (dense array twin of `idToNode`). */
	private nodesArr: (AnyNode | undefined)[] = [undefined];
	// ---- the observed closure (transitive observation retains) ----
	// The observation index — the refcount/retained-dep columns and every
	// closure-membership transition — lives in observation.ts (its module
	// header carries the full story), composed per bridge in the
	// constructor. `obsRefs`/`obsDeps` alias the table's columns BY IDENTITY
	// (the kernel's shared-side-column pattern): the hot evaluation frames
	// probe `obsRefs[ix] > 0` per observed run, and indexNode's gap-fill and
	// the record-free scrub maintain rows in the same loop as the other
	// dense columns.
	private readonly obs: ObservationTable;
	/** The table's dep-snapshot re-pointer, aliased as an own field: the
	 * evaluation-frame epilogues call it (evaluate sits at the V8 inline
	 * cliff — 460 bytecodes — and the two-load `this.obs.syncDeps` chain
	 * pushed it over; the alias keeps the one-load call shape the method
	 * form had). */
	private readonly obsSyncDeps: ObservationTable['syncDeps'];
	/** Observed-consumer refcount per nodeIndex: +1 per live watcher on the
	 * node, +1 per observed computed currently holding it in obsDeps.
	 * (Alias of observation.ts's column — see above.) */
	private readonly obsRefs: number[];
	/** Per OBSERVED computed (by nodeIndex): the retained direct strong-dep
	 * set as of its last fn run (undefined while unobserved — unwatched nodes
	 * store nothing). Sets hold node OBJECTS — see Subscription.obsDeps.
	 * (Alias of observation.ts's column — see above.) */
	private readonly obsDeps: (Set<AnyNode> | undefined)[];
	// (The evaluation-frame strong-dep capture list — obsCapture — is a field
	// on the shared engine core record now: the World/arena evaluation frames
	// and the resident kernel getters open and close the same one list.)
	/** Watchers by nodeIndex (the routing walks' collection rows). */
	private nodeToWatchers: (Watcher[] | undefined)[] = [undefined];
	// (The live-subscription count and the capture frame live on the shared
	// engine core record: Subscription.ts owns every transition, and the
	// resident/settlement pre-checks and the read-routing resolution read
	// them as plain fields.)
	// The write-log compaction mechanism (WriteLog.ts), composed per bridge
	// by engine.ts; the batch-state edge of a compaction is Batch.ts's own
	// releaseLogEntry (the compaction→batch edge lives with the lifecycle).
	private readonly compaction: CompactionTable;
	/** Atoms with a non-empty write log (compaction candidates). (Alias of
	 * WriteLog.ts's set, by identity — the write path's membership add and
	 * the quiet derivation's size check stay plain field reads.) */
	private readonly uncompactedAtoms: Set<AtomNode>;
	/** The one open (non-ended) render per root — React renders one tree per
	 * root at a time; a same-root restart is a new render. */
	private rootToOpenRender = new Map<RootId, RenderPass>();
	// The batch mechanism + retirement lifecycle (Batch.ts), composed per
	// bridge by engine.ts; the write path and the public delegates reach it
	// through this table.
	private readonly batchOps: BatchTable;
	/** Last-batch cache (windowed writes hit one batch repeatedly) — the
	 * write path's cache over the mechanism's registry, so it stays beside
	 * the write path. */
	private lastBatchId = 0;
	private lastBatchRef: Batch | undefined = undefined;
	/** Optional compaction observer (referee/diagnostics seam): called once
	 * per log entry as it folds into base and leaves the write log. The oracle's
	 * retention invariant needs the full history; its archive mirror lives
	 * OUTSIDE the engine (tests/model-view.ts), fed by this hook — keeping
	 * every compacted log entry in-engine would grow without bound. Production
	 * bridges leave it undefined and retain nothing. */
	onCompact: ((atom: AtomNode, entry: WriteLogEntry) => void) | undefined = undefined;

	// ---- quiet mode (Phase 1b) --------------------------------------------------
	/**
	 * The ARMED quiet state — the one boolean the write path branches on,
	 * recomputed only at state transitions (batch open/retire, render
	 * start/end, registration): quiet ⇔ bridge registered AND zero live
	 * batches AND zero open renders AND every write log compacted. While QUIET, an
	 * unclassified write to a registered atom FOLDS DIRECTLY: committed base
	 * and the kernel advance together and no log entry, write log append, batch, or
	 * delivery walk is created (a listening event consumer still gets one
	 * 'quiet-write' event — observation never changes which write path
	 * executes). The concurrency pipeline arms only while something is
	 * actually pending; a transition that starts later begins from committed
	 * base, which the folds already advanced — there is no history to
	 * reconstruct.
	 *
	 * This is the production default write path; the oracle mirrors the same
	 * derivation and fold, so lockstep/twin drivers referee it directly
	 * (tests/quiet-mode.spec.ts pins the arming schedules by hand).
	 * @internal — read by the module-level host write hook; treat as private.
	 */
	quiet = false;

	/** The quiet derivation (engine.ts — the composition owns the rule; the
	 * flag above stays a shell field for the host write hook's one hot read).
	 * Called at every pipeline transition: batch open/retire, render
	 * start/end, registration. */
	private readonly recomputeQuiet: () => void;

	/**
	 * Referee surface — not consulted by engine logic. The recorded
	 * dependency edges as dep → dependents (NodeIds — kernel record ids), materialized
	 * as the union of every live arena's links (strong AND weak-flagged —
	 * the current structure the routing walks consult); read by: graphviz,
	 * twin tests, soak metrics. (Replaced the K1 episode-edge snapshot at
	 * S-B; arena links persist across quiescence with their arenas.)
	 */
	get dependencyEdges(): Map<NodeId, Set<NodeId>> {
		// Materialized in WorldArena.ts (the link walk lives with the layout
		// enums); this getter is the referee-facing surface over it.
		return this.core.dependencyEdges();
	}

	/** Ambient default batch for bare (context-free) writes (Batch.ts state —
	 * this getter is the diagnostics/test surface over the mechanism's slot). */
	get ambientBatch(): BatchId | undefined {
		return this.batchOps.ambient();
	}

	/** The world an overlay evaluation frame is folding in (read routing —
	 * the field lives on the shared engine core record; this accessor pair
	 * is the public surface over it). */
	get activeWorld(): World | undefined {
		return this.core.activeWorld;
	}
	set activeWorld(w: World | undefined) {
		this.core.activeWorld = w;
	}

	/** Installs/clears the ambient-world provider (bindings seam; the
	 * provider and the routing resolution live in World.ts). */
	setWorldProvider(provider: (() => World | undefined) | undefined): void {
		this.core.setWorldProvider(provider);
	}

	// ---- bindings seams (ordinary public slots the React bindings assign) ----
	/**
	 * Write classification for host-attributable public writes. When set, it
	 * owns the WHOLE op (adoption on first write, batch context, render
	 * guard) — received as the public method's scalar (kind, payload) pair,
	 * exactly as the host seam captured it; when unset, registered atoms
	 * classify into the ambient batch.
	 */
	writeClassifier: ((atom: Atom<unknown>, kind: KernelWriteKind, payload: unknown) => void) | undefined;
	/** Adopt-on-demand for routed reads of not-yet-registered atoms. */
	readAdopter: ((atom: Atom<unknown>) => AtomNode) | undefined;
	/** Development-time checks switch (BridgeOptions.devChecks). Read by the
	 * bindings/host adapter driving this bridge — the engine never branches
	 * on it. */
	readonly devChecks: boolean;

	// (The BatchId source — monotonic, never rewound — lives in Batch.ts's
	// closure with the rest of the batch mechanism; the RenderPassId/WatcherId
	// sources live in RenderPass.ts's and the EffectId source in
	// Subscription.ts's the same way.)

	/** True inside an updater/reducer/equals callback (reads+writes throw).
	 * The field — like the evaluation depth — lives on the shared engine
	 * core record (World.ts owns the fold-purity bracket); this accessor is
	 * the public surface over it. */
	get inFoldCallback(): boolean {
		return this.core.inFoldCallback;
	}

	/** THE shared engine-core record (World.ts `EngineCore`): the one
	 * deps/table record the strongly-connected mechanism factories — World,
	 * WorldArena, settlement (+ the E6 subscription boundary slot) — are
	 * wired through. Created by engine.ts's composition with the resident-state
	 * edges filled; each factory assigns its operation table onto it, and
	 * the hot entries are additionally aliased as own fields below so
	 * resident callers keep their one-load call shapes. */
	private readonly core: EngineCore;
	// ---- own-field aliases of core-table entries (resident hot shapes) ----
	/** Evaluation of a node in a world (World.ts evaluate). */
	readonly evaluate: (node: AnyNode, world: World) => Value;
	/** The fold — replay visible entries over base (World.ts foldAtom). */
	readonly foldAtom: (atom: AtomNode, world: World) => Value;
	/** Raw-handle routed atom read (World.ts routedRead). @internal */
	readonly routedRead: (atom: AtomNode, world: World) => Value;
	/** The host read hook targets (World.ts; reached through the module-level
	 * routers installed by syncReadRouting). @internal */
	readonly hostRead: (atom: Atom<unknown>) => unknown;
	readonly hostComputedRead: (c: Computed<unknown>) => unknown;
	private readonly applyOp: (atom: AtomNode, kind: WriteKind, payload: unknown, prev: Value) => Value;
	private readonly eqAtom: (atom: AtomNode, a: Value, b: Value) => boolean;
	private readonly inCallback: <T>(fn: () => T) => T;
	/** Mark column for per-world cycle detection (alias of the core's — the
	 * registry gap-fill and the record-free scrub maintain rows). */
	private readonly evalMark: EvalGen[];
	/** Committed arenas by root (alias of the core's — WorldArena.ts owns it). */
	private readonly rootToArena: Map<RootId, WorldArena>;
	private readonly claimArena: (kind: 'render' | 'committed', world: World, root: RootId) => WorldArena;
	private readonly releaseArena: (a: WorldArena) => void;
	private readonly eachArena: (fn: (a: WorldArena) => void) => void;
	/** Arena serving (WorldArena.ts arenaServe — the checker window and the
	 * bytecode smoke drive it through this alias). */
	private readonly arenaServe: (a: WorldArena, node: AnyNode) => Value;
	private readonly purgeNodeFromArenas: (ix: NodeIndex) => void;
	private readonly fanAtomsToArena: (a: WorldArena, atoms: AtomNode[], fromSettlement: boolean) => void;
	private readonly fanAtomsToCommittedArenas: (atoms: AtomNode[]) => void;
	private readonly oneAtomBuf: (atom: AtomNode) => AtomNode[];
	private readonly arenaDecay: (a: WorldArena) => void;
	/** The value-blind delivery walk (deliver.ts — the write path's one-load call shape). */
	private readonly deliveryWalk: (from: AtomNode, batch: Batch, slot: BatchSlotMeta, seq: Seq) => void;
	/** The settle tap (settlement.ts; reached through the module-level router). @internal */
	readonly __settleTap: (t: PromiseLike<unknown>) => void;
	private readonly arenaOpEpilogue: () => void;
	private readonly endOp: () => void;
	/** The subscription lifecycle (Subscription.ts operation table). */
	readonly mountCommittedObserver: (rootId: RootId, name: string, refire?: () => void) => Subscription;
	readonly captureRun: (id: EffectId, body: () => void) => void;
	readonly captureRead: (node: AnyNode) => Value;
	readonly removeSubscription: (id: EffectId) => void;
	readonly replayReactEffect: (id: EffectId) => void;
	private readonly revalidateCommittedSubs: (rootFilter: RootId | undefined) => void;
	/** The render lifecycle (RenderPass.ts operation table — the public
	 * render/watcher/commit methods below are thin delegates over it). */
	private readonly renderOps: RenderPassTable;
	/** Kernel-frame tracked reader (bridge-created computeds' newest runs):
	 * the shared kernel read plus the pre-dedup observation capture —
	 * constructor-assigned so the closure captures the core record directly
	 * (the capture-list read stays one load). */
	private readonly kernelTrackedReader: Reader;

	constructor(options?: BridgeOptions) {
		// ---- the composition (engine.ts createConcurrentEngine): the class
		// shell hands over its resident containers plus thin arrows over the
		// state that stays resident until the shell dissolves — the
		// registry/adoption cluster, the sequence clocks, the quiet flag, the
		// write path's last-batch cache — and gets back the shared core
		// record and every mechanism's operation table.
		const eng = createConcurrentEngine({
			idToNode: this.idToNode,
			nodesArr: this.nodesArr,
			nodeToWatchers: this.nodeToWatchers,
			lastWalk: this.lastWalk,
			watchers: this.watchers,
			idToRenderPass: this.idToRenderPass,
			rootToOpenRender: this.rootToOpenRender,
			roots: this.roots,
			root: (id) => this.root(id),
			adoptComputed: (name, handle) => this.adoptComputed(name, handle),
			kernelStrongDepsOf: (node) => this.kernelStrongDepsOf(node),
			kernelReadOf: (dep) => this.kernelReadOf(dep),
			readAdopter: () => this.readAdopter,
			onCompact: () => this.onCompact,
			isRegistered: () => this._registered,
			setQuiet: (quiet) => {
				this.quiet = quiet;
			},
			nextSeq: () => this.nextSeq(),
			getSeq: () => this.seq,
			getCommittedAdvance: () => this.committedAdvance,
			advanceCommitted: () => {
				this.committedAdvance = this.nextSeq();
			},
			invalidateBatchCache: (id) => {
				if (this.lastBatchId === id) {
					this.lastBatchId = 0;
					this.lastBatchRef = undefined;
				}
			},
			hostReadImpl,
			hostComputedReadImpl,
		}, options);
		this.devChecks = eng.devChecks;
		const core = eng.core;
		this.core = core;
		this.recomputeQuiet = eng.recomputeQuiet;
		this.kernelTrackedReader = eng.kernelTrackedReader;
		// ---- aliases of the mechanism tables and their shared columns (the
		// resident hot paths and the tests read them in place) + own-field
		// aliases of the hot core-table entries (resident callers keep the
		// one-load call shapes the methods had).
		this.notify = eng.notify;
		this.notifyState = eng.notify.state;
		this.obs = eng.obs;
		this.obsRefs = eng.obs.refs;
		this.obsDeps = eng.obs.deps;
		this.obsSyncDeps = eng.obs.syncDeps;
		this.compaction = eng.compaction;
		this.uncompactedAtoms = eng.compaction.uncompactedAtoms;
		this.batchOps = eng.batch;
		this.idToBatch = eng.batch.idToBatch;
		this.slots = eng.batch.slots;
		this.renderOps = eng.render;
		this.idToSubscription = eng.subs.idToSubscription;
		this.mountCommittedObserver = eng.subs.mountCommittedObserver;
		this.captureRun = eng.subs.captureRun;
		this.captureRead = eng.subs.captureRead;
		this.removeSubscription = eng.subs.removeSubscription;
		this.replayReactEffect = eng.subs.replayReactEffect;
		this.revalidateCommittedSubs = eng.subs.revalidateCommittedSubs;
		this.evaluate = core.evaluate;
		this.foldAtom = core.foldAtom;
		this.routedRead = core.routedRead;
		this.hostRead = core.hostRead;
		this.hostComputedRead = core.hostComputedRead;
		this.applyOp = core.applyOp;
		this.eqAtom = core.eqAtom;
		this.inCallback = core.inCallback;
		this.evalMark = core.evalMark;
		this.rootToArena = core.rootToArena;
		this.claimArena = core.claimArena;
		this.releaseArena = core.releaseArena;
		this.eachArena = core.eachArena;
		this.arenaServe = core.arenaServe;
		this.purgeNodeFromArenas = core.purgeNodeFromArenas;
		this.fanAtomsToArena = core.fanAtomsToArena;
		this.fanAtomsToCommittedArenas = core.fanAtomsToCommittedArenas;
		this.oneAtomBuf = core.oneAtomBuf;
		this.arenaDecay = core.arenaDecay;
		this.deliveryWalk = core.deliveryWalk;
		this.__settleTap = core.settleTap;
		this.arenaOpEpilogue = core.arenaOpEpilogue;
		this.endOp = core.endOp;
	}

	// (setWorld / syncReadRouting / the routing resolution and the host read
	// hook bodies live in World.ts — see the core record's World section.)

	/**
	 * Resolve a public Computed handle to its registered node, adopting on
	 * first sight — `nodeFor`'s computed face. The resolution body lives in
	 * the composition site's core arrow (the routed computed read path calls
	 * it with no extra frame); this method is the public/test surface over it.
	 */
	nodeForComputed(c: Computed<unknown>): ComputedNode {
		return this.core.nodeForComputed(c);
	}

	private nextSeq(): Seq {
		return ++this.seq;
	}

	// ---------------------------------------------------------------- setup

	/** Activates the concurrent engine, once, monotonically; arms the table seam. */
	registerBridge(): void {
		if (this.core.evalDepth > 0 || this.core.inFoldCallback) {
			throw new ScheduleError('registerReactBridge called inside an open evaluation/fold frame; it may only run at an operation boundary');
		}
		if (this._registered) throw new ScheduleError('bridge already registered — registration happens exactly once');
		this._registered = true;
		// The activeness transition maintains the core's `isActive` mirror
		// (syncReadRouting's one-field guard): demote the previously active
		// bridge, then promote this one — this assignment is the module
		// slot's ONE writer, so mirror and slot can never diverge.
		if (activeBridge !== undefined) activeBridge.core.isActive = false;
		activeBridge = this;
		this.core.isActive = true;
		__setHostWrite(hostWriteImpl); // whole-op capture in the public methods
		// NF2 S-A: arm the settlement tap (ONE closure; consulted at FIRE
		// time, routed to the active bridge — §4.5.4 push half).
		__setSettleTap(settleTapImpl);
		// One id space: the kernel's boundary sweep reports freed node records
		// so the nodeIndex-keyed columns scrub at exactly the reuse boundary.
		__setRecordFreeHook(recordFreeImpl);
		this.core.syncReadRouting();
		this.recomputeQuiet(); // registered + nothing pending: quiet arms here
	}

	/** Registers a node in the dense side columns (keyed by its nodeIndex).
	 * Gap-fill keeps every column PACKED: unregistered kernel nodes (plain
	 * effects/scopes/handles) consume indexes between registrations, and a
	 * write past a plain array's length would drop it to a holey kind. */
	private indexNode(node: AnyNode): void {
		const ix = node.ix;
		this.idToNode.set(node.id, node);
		while (this.nodesArr.length <= ix) {
			this.nodesArr.push(undefined);
			this.lastWalk.push(0);
			this.evalMark.push(0);
			this.obsRefs.push(0);
			this.obsDeps.push(undefined);
			this.nodeToWatchers.push(undefined);
		}
		this.nodesArr[ix] = node;
		this.lastWalk[ix] = 0;
		this.evalMark[ix] = 0;
		this.obsRefs[ix] = 0;
		// Any row already here is a dead tenant's by construction (a fresh
		// registration means the slot's previous tenant freed) — normally the
		// record-free scrub already cleared it; this covers the multi-bridge
		// referee shape where the free was reported to a DIFFERENT active
		// bridge and this one kept operating.
		this.obsDeps[ix] = undefined;
		this.nodeToWatchers[ix] = undefined;
	}

	atom(name: string, initial: Value, equals?: Equals): AtomNode {
		const eq = equals ?? Object.is;
		const handle = new Atom<Value>(initial, equals === undefined ? undefined : { isEqual: equals });
		const node = new AtomNode(handle._id, kernelNodeIndexOf(handle._id), name, initial, eq, equals === undefined, handle);
		this.indexNode(node);
		return node;
	}

	/**
	 * Resolve a public handle to its registered node — the atom face of
	 * handle resolution (see nodeForComputed), shared by the host write seam
	 * and the bindings' handle resolution: one `idToNode` probe by the
	 * handle's kernel record id.
	 */
	nodeFor(atom: Atom<unknown>): AtomNode | undefined {
		const hit = this.idToNode.get(atom._id);
		return hit !== undefined && hit.kind === 'atom' ? hit : undefined;
	}

	/**
	 * An atom created before the bridge was registered joins with its current
	 * value as committed-only base state — no log entries existed for its past
	 * writes, and none are needed: pre-registration history is, by
	 * construction, visible to every world.
	 */
	adoptAtom(name: string, handle: Atom<Value>, equals?: Equals): AtomNode {
		const current = this.kernelValueOf(handle);
		const node = new AtomNode(handle._id, kernelNodeIndexOf(handle._id), name, current, equals ?? Object.is, equals === undefined, handle);
		this.indexNode(node);
		return node;
	}

	/**
	 * Create a bridge computed (S-C: one computed — the node RIDES a fresh
	 * kernel `Computed` record). The kernel getter runs the authored
	 * (read, untracked) fn with the KERNEL readers — dep reads take the
	 * plain kernel paths (linking to this record; untracked reads clear the
	 * kernel frame, so they leave no link and never notify) — under the
	 * bridge's evaluation guards (writes throw; observed runs capture their
	 * strong deps; trace hooks fire). World evaluations run the same fn with
	 * the ARENA readers through `arenaUpdateComputed`.
	 */
	computed(name: string, fn: ComputedFn, equals?: Equals): ComputedNode {
		// id/ix land after the kernel record exists (the getter closure needs
		// the node object first); nothing reads them in between.
		const node: ComputedNode = {
			kind: 'computed', id: 0, ix: 0, name, fn,
			handle: undefined as never, ctxShaped: false, isEqual: equals, prevCell: { value: undefined },
		};
		node.handle = new Computed<unknown>(this.makeKernelGetter(node) as (ctx: ComputedCtx<unknown>) => Value, equals === undefined ? { label: name } : { label: name, isEqual: equals });
		node.id = node.handle._id;
		node.ix = kernelNodeIndexOf(node.id);
		__hostMarkComputedOwned(node.handle); // its links carry no D1 lifecycle refs — the obs index is its arm
		this.indexNode(node);
		return node;
	}

	/**
	 * Adopt a public `Computed` handle (S-C): the handle's kernel record
	 * keeps serving the newest world exactly as before adoption — the bridge
	 * only WRAPS its kernel getter with the host epilogue (observation
	 * re-pointing per re-run) and builds the ctx-shaped WORLD fn: reads
	 * inside the raw fn are raw `.state` reads, which the host read seams
	 * route into the evaluating arena; `ctx.previous` serves the node's
	 * committed previous cell; `ctx.use` is the core's two-form dispatch
	 * over the handle's own `_useCache` (same key ⇒ same thenable for the
	 * node's lifetime, across worlds); a background evaluation folds a
	 * pending suspension to its stable sentinel VALUE (hook-initiated ones
	 * rethrow — `suspendDepth`).
	 */
	adoptComputed(name: string, handle: Computed<unknown>): ComputedNode {
		const existing = this.idToNode.get(handle._id);
		if (existing !== undefined && existing.kind === 'computed') return existing;
		const node: ComputedNode = {
			kind: 'computed', id: handle._id, ix: kernelNodeIndexOf(handle._id), name, fn: undefined as never,
			handle, ctxShaped: true, isEqual: handle._isEqual, prevCell: { value: undefined },
		};
		node.fn = this.makeCtxWorldFn(node);
		__hostWrapComputedFn(handle._id, (inner) => this.makeAdoptedKernelGetter(node, inner));
		__hostMarkComputedOwned(handle); // retro-releases any pre-adoption lifecycle refs its links held
		this.indexNode(node);
		return node;
	}

	/**
	 * Dispose a computed (S-C — the useComputed deps-change reclamation
	 * path: the superseded node's kernel record frees and its id becomes
	 * reusable). The caller owns the discipline that the node is SUPERSEDED
	 * (its watchers re-keyed to the replacement; live watchers here throw).
	 * Order matters for id tenancy: the bridge-side teardown runs FIRST —
	 * every live arena's shadow purges eagerly (walks traverse links without
	 * per-hop GEN checks, so links through the dead shadow must go now), the
	 * registry row and dense node row clear (a reused record id resolves
	 * fresh, never to the dead tenant) — then the kernel record disposes:
	 * its GEN bumps at the boundary sweep, which also fires the record-free
	 * scrub (__onRecordFree) clearing every remaining nodeIndex-keyed row
	 * before the slot's index can be inherited by a new tenant.
	 */
	disposeComputed(handle: Computed<unknown>): void {
		const node = this.idToNode.get(handle._id);
		if (node !== undefined && node.kind === 'computed' && node.handle === handle) {
			const ix = node.ix;
			const ws = this.nodeToWatchers[ix];
			if (ws !== undefined && ws.some((w) => w.live)) {
				throw new ScheduleError(`disposeComputed(${node.name}): live watchers still subscribe — re-key them to the replacement first`);
			}
			if (this.obsRefs[ix]! > 0) this.obs.exit(node); // release any retained closure (defensive)
			this.purgeNodeFromArenas(ix);
			this.idToNode.delete(node.id);
			this.nodesArr[ix] = undefined;
		}
		__hostDisposeComputed(handle); // kernel: deps unlink, subs detach, deferred free (GEN bump + record-free scrub at the sweep)
	}

	// (purgeNodeFromArenas — the whole-arena shadow purge disposeComputed and
	// the record-free scrub share — lives in WorldArena.ts; aliased above.)

	/**
	 * THE RECORD-FREE SCRUB (registered kernel-side via __setRecordFreeHook,
	 * routed here for the active bridge): a node record freed at the kernel's
	 * boundary sweep surrenders its slot — and the slot's NODE_INDEX — to a
	 * future tenant, so every nodeIndex-keyed row must clear NOW. For
	 * bridge-disposed computeds this re-runs teardown idempotently; its
	 * load-bearing case is everything disposeComputed does not cover — the
	 * watcher-index row a dormant mount left behind, observation refs held
	 * transitively at free, walk/eval stamps, and node records freed without
	 * bridge-side teardown (a direct __hostDisposeComputed, or a slot whose
	 * tenant was never registered). Bound-checked: an index past a column's
	 * length has no row, and writing there would drop the column to a holey
	 * kind. @internal
	 */
	__onRecordFree(recordId: NodeId, ix: NodeIndex): void {
		this.idToNode.delete(recordId);
		if (ix < this.nodesArr.length) {
			const resident = this.nodesArr[ix];
			// Un-torn-down engine node (freed without bridge disposal): release
			// its outgoing observation retains before the rows clear, so its
			// retained deps do not leak closure membership.
			if (resident !== undefined && this.obsRefs[ix]! > 0) this.obs.exit(resident);
			this.nodesArr[ix] = undefined;
			this.lastWalk[ix] = 0;
			this.evalMark[ix] = 0;
			this.obsRefs[ix] = 0;
			this.obsDeps[ix] = undefined;
			this.nodeToWatchers[ix] = undefined;
		}
		this.purgeNodeFromArenas(ix);
	}

	/** Stale-watcher loud skips (the P1 aliasing pin): every watcher→node
	 * resolution (RenderPass.ts resolveWatcherNode) that MISSED — the
	 * watcher's record tenancy moved (freed, possibly reused) — and was
	 * skipped instead of silently binding the record's current tenant.
	 * Diagnostics/referee surface. @internal */
	get __staleWatcherSkips(): number {
		return this.renderOps.staleWatcherSkips();
	}

	/** >0 while a hook-initiated evaluation may legally suspend the render
	 * (the bindings' `evaluateSuspending` bumps it); background evaluations
	 * of ctx-shaped computeds fold pending suspensions to sentinel values.
	 * The field lives on the shared engine core record (World.ts's
	 * kernelComputed and the ctx world fn read it); this accessor pair is
	 * the public surface the bindings bump. */
	get suspendDepth(): number {
		return this.core.suspendDepth;
	}
	set suspendDepth(n: number) {
		this.core.suspendDepth = n;
	}

	/** The kernel getter of a bridge-created computed (see `computed`). The
	 * returned closure captures the core record directly, so the evaluation-
	 * frame fields keep their one-load access shape. */
	private makeKernelGetter(node: ComputedNode): () => Value {
		const core = this.core;
		return () => {
			const savedCapture = core.obsCapture;
			core.obsCapture = this.obsRefs[node.ix]! > 0 ? [] : undefined;
			core.evalDepth++; // writes during a newest evaluation throw, as in every world
			const tr = this.trace;
			if (tr !== undefined) tr.evalStart(node, NEWEST);
			try {
				return node.fn(this.kernelTrackedReader, this.kernelUntrackedReader);
			} finally {
				core.evalDepth--;
				const captured = core.obsCapture;
				core.obsCapture = savedCapture;
				if (tr !== undefined) tr.evalEnd();
				if (captured !== undefined) this.obsSyncAfterKernelRun(node, captured);
			}
		};
	}

	/** The wrapped kernel getter of an ADOPTED computed: run the original
	 * (equality wrappers and all), then re-point the observed closure at the
	 * kernel links this run just re-tracked (raw `.state` reads inside a
	 * kernel frame never reach a bridge reader, so the fresh link list IS
	 * the capture — full, reuse-proof, tracked-only). */
	private makeAdoptedKernelGetter(node: ComputedNode, inner: (ctx: unknown) => unknown): (ctx: unknown) => unknown {
		const core = this.core;
		return (ctx: unknown) => {
			core.evalDepth++; // writes during a newest evaluation throw, as in every world
			const tr = this.trace;
			if (tr !== undefined) tr.evalStart(node, NEWEST);
			try {
				return inner(ctx);
			} finally {
				core.evalDepth--;
				if (tr !== undefined) tr.evalEnd();
				if (this.obsRefs[node.ix]! > 0) this.obsSyncAfterKernelRun(node, this.kernelStrongDepsOf(node));
			}
		};
	}

	/** The (read, untracked)-shaped WORLD evaluation fn of an adopted
	 * ctx-shaped computed (see `adoptComputed`; the readers are unused — the
	 * raw fn reads through the `.state` seams, which the open arena frame
	 * routes and links). */
	private makeCtxWorldFn(node: ComputedNode): ComputedFn {
		const core = this.core;
		const handle = node.handle;
		const rawFn = handle._fn as (ctx: ComputedCtx<unknown>) => Value;
		const ctx: ComputedCtx<unknown> = {
			get previous(): Value {
				return node.prevCell.value;
			},
			use: <V>(sourceOrKey: unknown, factory?: () => PromiseLike<V>): V =>
				__ctxUse(handle, sourceOrKey, factory as (() => PromiseLike<unknown>) | undefined) as V,
		} as ComputedCtx<unknown>;
		return () => {
			try {
				return rawFn(ctx);
			} catch (err) {
				// Background world evaluation: a pending suspension folds to its
				// stable SuspendedRead sentinel VALUE (so "still pending" caches
				// and compares like any value — battery 16d); hook-initiated
				// evaluations rethrow so React can suspend the component.
				if (err instanceof SuspendedRead && core.suspendDepth === 0) return err;
				throw err;
			}
		};
	}

	// (cycleError — the bridge's ONE cross-world cycle error — lives in
	// World.ts with the per-world cycle detection; the core table carries it.)

	/** The kernel-way dep read both kernel-frame readers share: atoms off the
	 * kernel arena, computeds via the plain kernel computed read (E.read/
	 * E.computedRead link the dep to any open kernel frame), kernel
	 * CycleErrors translated to the bridge's. */
	private kernelReadOf(dep: AnyNode): Value {
		if (dep.kind === 'atom') return this.kernelValueOf(dep.handle);
		try {
			return __kernelComputedRead(dep.handle);
		} catch (err) {
			if (err instanceof CycleError) throw this.core.cycleError(dep.name);
			throw err;
		}
	}

	// (kernelTrackedReader — the kernel-frame tracked reader — is
	// constructor-assigned; see the alias-field declarations.)

	/** Kernel-frame untracked reader: kernel `untracked()` clears the frame,
	 * so the dep's own serving still runs (recompute-if-stale) but no link —
	 * and therefore no notification, and no invalidation of this computed —
	 * is ever recorded (§4.4.1's value face, the ruling's sampling rule). */
	private kernelUntrackedReader: Reader = (dep) => untracked(() => this.kernelReadOf(dep));

	/** Observation re-point after a KERNEL re-run, inside the still-open
	 * kernel frame: discovery evaluations (obsEnter forcing dep reads) must
	 * not link into that frame — kernel `untracked()` clears it around the
	 * sync (the arena twin clears `serveOverride` instead — arenaSyncObsAfterRefold). */
	private obsSyncAfterKernelRun(node: AnyNode, captured: AnyNode[]): void {
		untracked(() => this.obsSyncDeps(node, captured));
	}

	/** The registered bridge nodes among a computed's CURRENT kernel deps
	 * (tracked-only by construction: untracked reads leave no kernel link).
	 * Walked off the raw kernel arena with the kernel's own exported layout
	 * enums — a kernel field reorder flows through the import instead of
	 * silently corrupting this walk. */
	private kernelStrongDepsOf(node: ComputedNode): AnyNode[] {
		const memory = __kernelBuffer();
		const out: AnyNode[] = [];
		let l = memory[node.id + NodeField.DEPS]!;
		while (l !== 0) {
			const dep = this.idToNode.get(memory[l + LinkField.DEP]!);
			if (dep !== undefined) out.push(dep);
			l = memory[l + LinkField.NEXT_DEP]!;
		}
		return out;
	}

	root(id: RootId): RootState {
		let r = this.roots.get(id);
		if (r === undefined) {
			r = { id, committedBatches: new Set(), commitGen: 0, committedBits: 0, committedDirtySlots: 0 };
			this.roots.set(id, r);
		}
		return r;
	}

	// ---------------------------------------------------- worlds and folds
	// The whole fold/evaluation family — the fold-purity bracket
	// (inCallback), foldAtom, visibleAt (THE visibility rule), applyOp,
	// eqAtom (THE equality rule), evaluate, kernelComputed, the fold-through
	// readers, and the read-routing resolution — lives in World.ts; the hot
	// entries are aliased as own fields (see the constructor).

	/** Reads an atom's newest value straight from the kernel — the core's
	 * host-side read seam, which the world-routing hook can never intercept
	 * (no seam toggling around the call). */
	private kernelValueOf(handle: Atom<Value>): Value {
		return __hostReadNewest(handle);
	}

	// ---- NF2: arena state + evaluation (the render/committed authority) ----
	// The whole arena serving/lifecycle layer — claim/release/pool, arenaOf,
	// shadow lookup, dep recording, serve/refold, suspension bookkeeping,
	// fanout, decay, and the routing walks — lives in WorldArena.ts (see the
	// module-level pointer above ArenaCheckerInternals); the resident
	// orchestration reaches it through the core table and the own-field
	// aliases assigned in the constructor.

	// (Arena serving — arenaServe/arenaUpdateShadow/arenaUpdateComputed and
	// the checkDirty family — and the fanout/decay sites live in
	// WorldArena.ts; the settlement tap, its queue + drain loop, and the
	// operation epilogue pair — arenaOpEpilogue/endOp — live in
	// settlement.ts. All are core-table entries; the hot ones are aliased
	// as own fields in the constructor.)

	/** Test seam: shrink the settlement-drain iteration cap. @internal */
	__setSettleCapForTest(n: number): void {
		this.core.setSettleCap(n);
	}

	// ---- NF2 S-A: reclamation (§4.5.8) + the checker window (§4.9 — the
	// divergence check and structural validator are TEST machinery and live
	// in tests/arena-checker.ts, fed through __checkerInternals below) ----

	/** The watcher-population refcount, derived (dev-assertable) form: live
	 * watchers of the root + live committed subscriptions of the root. */
	private consumerCount(rootId: RootId): number {
		let n = 0;
		for (const w of this.watchers.values()) {
			if (w.live && w.root === rootId) n++;
		}
		for (const sub of this.idToSubscription.values()) {
			if (sub.live && sub.root === rootId) n++;
		}
		return n;
	}

	/** Quiesce duty 1 (§4.5.8): release committed arenas whose consumer
	 * population is zero — buffer to the pool (claim gen bumped), columns
	 * dropped, lists discarded; the root RECORD stays (no teardown event
	 * exists — RUL-6 records the fallback). Then duty 2 (§4.5.7): per-arena
	 * read-clock renumber over the SURVIVORS only. */
	private arenaQuiesceSweep(): void {
		for (const [rootId, a] of this.rootToArena) {
			if (this.consumerCount(rootId) === 0) {
				this.rootToArena.delete(rootId);
				this.releaseArena(a);
			}
		}
		for (const a of this.rootToArena.values()) arenaRenumberMarks(a);
	}

	/**
	 * THE CHECKER WINDOW (W3): the one seam feeding the test-side referee —
	 * tests/arena-checker.ts, which owns the armed divergence check
	 * (arena-served values ≡ fold-truth) and the structural validator. The
	 * views are readonly-shaped: live state getters plus bracket methods
	 * that keep every mutation's save/restore discipline inside the engine.
	 * Production code never calls this and installs no hook. @internal
	 */
	__checkerInternals(): ArenaCheckerInternals {
		const core = this.core;
		return {
			// The layout view is built in WorldArena.ts, the enums' own file
			// (same-file const enum discipline): in sync by construction.
			layout: arenaCheckerLayout(),
			get evalDepth(): number {
				return core.evalDepth;
			},
			get inFoldCallback(): boolean {
				return core.inFoldCallback;
			},
			eachArena: (fn) => this.eachArena(fn),
			nodeAt: (ix) => this.nodesArr[ix],
			serve: (a, node) => core.arenaServe(a, node),
			foldTruthFrame: (world, fn) => core.foldTruthFrame(world, fn),
			cycleError: (name) => core.cycleError(name),
			inCallback: (fn) => core.inCallback(fn),
			holdOp: (fn) => {
				core.opDepth++;
				try {
					return fn();
				} finally {
					core.opDepth--;
				}
			},
			armEpilogueCheck: (check) => {
				core.epilogueCheck = check;
			},
		};
	}

	/** Test seam: the root's committed arena shell, if materialized — the
	 * S-D pool/wrap pins read shell state (claimGen, buffer identity,
	 * column capacities) and force the clocks toward the Int32 ceiling.
	 * @internal */
	__arenaForTest(rootId: RootId): WorldArena | undefined {
		return this.rootToArena.get(rootId);
	}

	/** Test seam: pooled arena shells (S-D pool reuse/cap pins). @internal */
	__arenaPoolForTest(): WorldArena[] {
		return this.core.arenaPool;
	}

	/** Test seam: force an id-tenancy generation bump — the kernel-GEN referee
	 * seam. Tenancy IS the kernel record generation since the id-space merge,
	 * so the bump writes the LIVE record's GEN field in kernel memory: arena
	 * shadows re-tenant cold at their next consult and watcher stamps go
	 * stale, exactly as a real free+reuse would move them. @internal */
	__bumpNodeGenForTest(id: NodeId): void {
		__kernelBuffer()[id + NodeField.GEN]++;
	}

	/** Arena stats (tests/bench). @internal */
	__arenaStats(): { committed: number; renders: number; pooled: number; suspended: number; pendingSettlements: number; dirty: number } {
		let renders = 0;
		let dirty = 0;
		for (const p of this.rootToOpenRender.values()) {
			if (p.arena !== undefined) renders++;
		}
		this.eachArena((a) => {
			dirty += a.dirty.length;
		});
		return { committed: this.rootToArena.size, renders, pooled: this.core.arenaPool.length, suspended: this.core.suspendedCount, pendingSettlements: this.core.pendingSettleCount(), dirty };
	}

	/** Test seam: a committed arena's (dep → sub) link mode, or undefined
	 * when no link exists (§4.4.1 mode-transition pin). @internal */
	__arenaLinkMode(rootId: RootId, dep: AnyNode, sub: AnyNode): 'strong' | 'weak' | undefined {
		return this.core.__arenaLinkMode(rootId, dep, sub);
	}

	/** Test seam: a committed arena's live (dep → sub) link record id, or 0
	 * when no link exists (freelist-discipline pins capture ids before a
	 * teardown). @internal */
	__arenaLinkIdForTest(rootId: RootId, dep: AnyNode, sub: AnyNode): number {
		return this.core.__arenaLinkIdForTest(rootId, dep, sub);
	}

	/** Test seam: raw NEXT_DEP field of an arena link record BY ID — valid
	 * on freed links too. The freelist-discipline regression pin (dalien row
	 * 2 twin) asserts a freed link's stale nextDep still names its former
	 * neighbor, never the free list: arenaCheckDirty reads NEXT_DEP off links
	 * a mid-walk purge freed. @internal */
	__arenaLinkNextDepForTest(rootId: RootId, linkId: number): number {
		return this.core.__arenaLinkNextDepForTest(rootId, linkId);
	}

	// (foldTruthFrame — the armed checker's naive evaluation frame — lives in
	// WorldArena.ts with the serve-override state; __checkerInternals wires it.)

	// ---- observed-closure maintenance ----
	// The observation index — obsShift/obsEnter/obsExit and the two dep-
	// snapshot re-pointers — lives in observation.ts (composed as `this.obs`;
	// the columns are aliased above). Resident consumers call through the
	// table: the watcher liveness seam, disposal/record-free teardown,
	// evaluation-frame epilogues, and subscription capture.

	// ---- the routing walks (S-B: arenas route; §4.4.3/§4.4.6/§4.4.7) ----
	// The arena-walking halves — walkArenaStrong, the watcher collection
	// rows' readers, the drain candidate collection, and the fixup closure's
	// arena leg — live in WorldArena.ts (same-file with the layout enums);
	// the ORCHESTRATION — the delivery walk, the per-watcher delivery
	// decision, the durable/quiet drains, and correctWatcher — lives in
	// deliver.ts (createDeliverWalks), reached through the core's late-bound
	// slots (the write path keeps its `deliveryWalk` own-field alias).

	// -------------------------------------------------- batches and slots
	// The batch MECHANISM — openBatch, batchById, slot interning/release/
	// backstop, committed-bits rebuild, live-count bookkeeping — lives in
	// Batch.ts (composed as `this.batchOps`; `idToBatch`/`slots` aliased
	// above). Retirement and the render-close orchestration stay here and
	// call through the table. The public surface keeps thin delegates.

	/** Create a batch (the public/referee surface — see Batch.ts openBatch). */
	openBatch(opts?: { action?: boolean; ambient?: boolean; deferred?: boolean }): Batch {
		return this.batchOps.openBatch(opts);
	}

	liveBatches(): Batch[] {
		return this.batchOps.liveBatches();
	}

	nodeById(id: NodeId): AnyNode {
		return mustGet(this.idToNode, id, 'node');
	}

	// ------------------------------------------------------ the write path

	/**
	 * Quiet-mode write fold — the whole write while nothing is pending. The
	 * op folds over committed base (updaters/reducers under both fold-purity
	 * guards, exactly as replay would run them), the same equality drop as
	 * the write path's log-empty drop check applies, and an accepted write
	 * advances base and the kernel TOGETHER — the invariant while
	 * quiet is base ≡ kernel newest ≡ every world's value, so a batch opened
	 * later starts from a base that already contains the quiet history.
	 * Clock coherence: the fold creates one sequence and stamps it into the
	 * atom's baseSeq (compaction + the referee's model view read it) and the
	 * committed-advance clock (committedAdvance), so baseline/fast-out checks see the fold. Observers: no
	 * walk machinery is armed, so the small live-observer population is
	 * reconciled value-gated, exactly like a durable drain (corrections for
	 * watchers, re-runs for committed React effects; core effect()s are
	 * kernel subscribers — the direct kernel apply itself flushes them).
	 * No log entry, no batch, no write log append, no delivery walk. Observation:
	 * when a tracer is attached the accepted fold creates ONE quiet-write
	 * record — with no tracer that is one dead branch, and observation never
	 * changes which write path executes (equality drops stay silent: there
	 * is no batch to attribute a drop to). @internal
	 */
	__quietWrite(node: AtomNode, kind: WriteKind, payload: unknown): void {
		const core = this.core; // one load; the frame guards/pre-checks below stay one-property reads
		if (core.evalDepth > 0) throw new ScheduleError('signal write during a world evaluation / render — write from an event handler or effect instead');
		if (core.inFoldCallback) throw new ScheduleError('signal write inside an updater/reducer fold — updaters and reducers must be pure');
		const prev = node.base;
		// Fast arm — bench-pinned, do not fold into the eqAtom general arm
		// (spkw-quiet A/B, 2026-07: folding cost +37% on the bare quiet fold,
		// 12.9 → 17.7 ns): equality drops on one bare Object.is — no
		// applyOp/eqAtom call layer on the dominant write shape.
		let next: Value;
		if (kind === 0 /* WriteKind.SET */ && node.eqIsDefault) {
			if (Object.is(payload, prev)) {
				return; // equality drop against base — the write log is empty by the quiet invariant
			}
			next = payload;
		} else {
			next = kind === 0 /* WriteKind.SET */ ? payload : this.applyOp(node, kind, payload, prev);
			if (this.eqAtom(node, next, prev)) {
				return; // equality drop against base — the write log is empty by the quiet invariant
			}
		}
		node.base = next;
		node.baseSeq = this.committedAdvance = ++this.seq; // advance the base + committed-advance clocks together (nextSeq, inlined)
		const tr = this.trace;
		if (tr !== undefined) tr.quietWrite(node, node.baseSeq);
		// Direct kernel apply: the plain write tail, no public-method re-entry
		// (the host seam already ran — policy checked, op folded).
		__hostApplySet(node.handle, next);
		// NF2 S-A flip site (d): quiet fold — after the base/committedAdvance advance,
		// before quietDrain and the sub scan (§4.1.2; the rootToArena.size
		// check is the one scalar branch PR1's ledger documents).
		this.fanAtomsToCommittedArenas(this.oneAtomBuf(node));
		if (this.watchers.size !== 0) core.quietDrain();
		// A quiet fold moves committed truth for every root — an EF2 boundary
		// (quiet ⇔ no open renders, so no frame can defer the re-check).
		if (core.committedSubCount !== 0) this.revalidateCommittedSubs(undefined);
		for (const a of this.rootToArena.values()) this.arenaDecay(a); // NF2 S-A boundary decay
		if (this.notifyState.n !== 0) this.notify.flushNotify();
		this.arenaOpEpilogue();
	}

	/** A write belongs to the batch context it executes in; a bare write has
	 * none, so it joins the ambient default batch — unless the bridge is
	 * QUIET, in which case the write folds directly (no ambient batch is
	 * created while nothing is pending). */
	bareWrite(node: AtomNode, kind: WriteKind, payload: unknown): void {
		if (this.quiet) {
			this.__quietWrite(node, kind, payload);
			return;
		}
		const ambientId = this.batchOps.ambient();
		let ambient = ambientId === undefined ? undefined : this.idToBatch.get(ambientId);
		if (ambient === undefined || ambient.state !== 'live') {
			ambient = this.batchOps.openBatch({ ambient: true });
			this.batchOps.setAmbient(ambient.id);
		}
		// The post-await dev-warning heuristic lives adapter-side only
		// (cosignal-react's classifyWrite) — the engine stays lint-free.
		this.write(ambient.id, node, kind, payload);
	}

	// (endOp — the compound-operation tail every public exit owes — lives in
	// settlement.ts with the operation epilogue; aliased above.)

	/**
	 * The write path (registered bridges only — an unregistered bridge
	 * throws: production writes reach a bridge only through the kernel write
	 * hook, which arms at registration, so anything earlier is plain kernel
	 * state that never involves a bridge; see adoptAtom for how such state
	 * joins). Logged steps, in order: classify (caller) → drop check
	 * → intern slot → append packed log entry + write clock → member-slot
	 * fanout → apply to the kernel with stepwise equality → arena delivery
	 * walk → newest-subscription flush after the walk returns.
	 */
	write(batchId: BatchId | undefined, node: AtomNode, kind: WriteKind, payload: unknown): void {
		const core = this.core; // one load; the frame guards/depth below stay one-property reads
		if (core.evalDepth > 0) throw new ScheduleError('signal write during a world evaluation / render — write from an event handler or effect instead');
		if (core.inFoldCallback) throw new ScheduleError('signal write inside an updater/reducer fold — updaters and reducers must be pure');
		if (node.kind !== 'atom') throw new ScheduleError('writes target atoms');
		// NF2 S-A: public-operation frame — settlements landing anywhere
		// inside (walks, effect bodies, notify callbacks) enqueue and the
		// epilogue drains to empty (§4.5.4's fixed point).
		core.opDepth++;
		try {
			this.writeInner(batchId, node, kind, payload);
		} finally {
			core.opDepth--;
		}
		this.arenaOpEpilogue();
	}

	private writeInner(batchId: BatchId | undefined, node: AtomNode, kind: WriteKind, payload: unknown): void {
		if (!this._registered) throw new ScheduleError('writes require a registered bridge — before registration, writes are plain kernel state and never reach a bridge');
		if (batchId === undefined) {
			this.bareWrite(node, kind, payload);
			return;
		}
		// Windowed writes hit one batch repeatedly — one compare beats a Map probe.
		let batch: Batch;
		if (batchId === this.lastBatchId && this.lastBatchRef !== undefined) {
			batch = this.lastBatchRef;
		} else {
			batch = this.batchOps.batchById(batchId);
			this.lastBatchId = batchId;
			this.lastBatchRef = batch;
		}
		if (batch.state !== 'live') throw new ScheduleError(`write into retired batch ${batchId} — a retired batch accepts no new writes`);

		const log = node.log;
		// Drop check: only when the write log is empty AND the op evaluates equal
		// against base may a write be dropped — once log entries exist, worlds
		// may fold different previous values, so equality here proves nothing.
		if (log.n === log.start) {
			if (kind === 0 /* WriteKind.SET */ && node.eqIsDefault) {
				// Fast arm — bench-pinned, do not fold into the general arm
				// (spkw A/B, 2026-07: folding the two write-path fast arms
				// into their eqAtom general arms cost +11% bare / +3-6%
				// chain3+watch1 per logged write). A plain set with default
				// equality drops on one bare Object.is — no applyOp/eqAtom
				// call layer on the dominant write shape.
				if (Object.is(payload, node.base)) {
					const tr = this.trace;
					if (tr !== undefined) tr.writeDropped(node, batchId);
					this.endOp();
					return;
				}
			} else {
				const evaluated = this.applyOp(node, kind, payload, node.base);
				if (this.eqAtom(node, evaluated, node.base)) {
					const tr = this.trace;
					if (tr !== undefined) tr.writeDropped(node, batchId);
					this.endOp();
					return;
				}
			}
		}

		// Intern slot, append log entry, bump the slot write clock.
		const slot = batch.slot !== undefined ? this.slots[batch.slot]! : this.batchOps.internSlot(batch);
		const seq = this.nextSeq();
		log.push(kind, slot.id, seq, batch.id, payload);
		batch.lastWriteSeq = seq;
		batch.liveLogEntries++;
		if (node.lastTouchBatch !== batch.id) {
			node.lastTouchBatch = batch.id;
			batch.atomsTouched.push(node);
		}
		if (log.n - log.start === 1) this.uncompactedAtoms.add(node);
		slot.writeClock = seq;
		if (this.roots.size !== 0) {
			// A write into a committed-member slot moves committed truth NOW;
			// the next durable drain must reconcile its cone.
			const bit0 = 1 << slot.id;
			for (const r of this.roots.values()) {
				if ((r.committedBits & bit0) !== 0) {
					r.committedDirtySlots |= bit0;
					// NF2 S-A flip site (c): committed-member write — fan the ONE
					// written atom into the member root's arena. Marks only; the
					// effect scan stays at the next boundary (EF2 as amended, §4.0).
					const ra = this.rootToArena.get(r.id);
					if (ra !== undefined) this.fanAtomsToArena(ra, this.oneAtomBuf(node), false);
				}
			}
		}
		{
			// ONE write record: the logEntry hook carries node/op/batch/slot/seq
			// (the old object channel's separate 'write' event was the same
			// instant with less information — sites report once now).
			const tr = this.trace;
			if (tr !== undefined) tr.logEntry(node, log.entryAt(log.n - 1));
		}

		// Apply to the kernel eagerly with stepwise equality, so the newest
		// world stays directly readable off the kernel arena.
		if (kind === 0 /* WriteKind.SET */ && node.eqIsDefault) {
			// Fast arm — bench-pinned, do not fold into the general arm
			// (spkw A/B, 2026-07: folding the two write-path fast arms
			// into their eqAtom general arms cost +11% bare / +3-6%
			// chain3+watch1 per logged write). A plain set with default
			// equality applies unconditionally: the kernel's own
			// store-compare gates propagation, which beats paying
			// kernelValueOf + Object.is up front on every EFFECTIVE write.
			this.applyToKernel(node, payload);
		} else {
			const prevNewest = this.kernelValueOf(node.handle);
			const nextNewest = this.applyOp(node, kind, payload, prevNewest);
			if (!this.eqAtom(node, nextNewest, prevNewest)) {
				this.applyToKernel(node, nextNewest);
			}
		}

		// The value-blind delivery walk (arena strong links), synchronously in
		// the writer's stack. (Core effect()s are kernel subscribers: the
		// eager kernel apply above already flushed them.)
		this.deliveryWalk(node, batch, slot, seq);
		this.endOp();
	}

	/** The one K0 write site: routes through the core's public write path
	 * (index.ts's policy layer), so equality drop and effect flush apply; the
	 * bridgeApplying guard makes the host write hook wave it through. */
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
	 * Referee seam for core `effect()` runs. Core effects are REAL kernel
	 * effects (tests/helpers.ts `mountEngineCoreEffect` over the public
	 * `effect()`), flushed by the eager kernel apply itself — the bridge
	 * holds no record of them. Their wrappers report each value-gated run
	 * here so core-effect-run records land in the one packed stream with
	 * its causality register. Sibling firing order under one operation is
	 * implementation-defined (kernel subscriber-link order — owner ruling
	 * 2026-07-06); values and the operation each run fires at are the
	 * contract (RCC-EF4).
	 */
	logCoreEffectRun(name: string, value: Value): void {
		const tr = this.trace;
		if (tr !== undefined) tr.coreEffectRun(name, value);
	}

	// ------------------------------------------------------ render lifecycle
	// The whole render lifecycle — renderStart/renderYield/renderResume, the
	// watcher mount/defer/reveal/re-render/removal family, the commit fan
	// (renderEnd + reclaim + deferred releases + the re-staled populator),
	// per-root commit lock-in, and mount fixup with its dependency-closure
	// walks — lives in RenderPass.ts (composed as `this.renderOps`); the
	// public methods below are thin delegates over its operation table.

	/** Open a render pass (see RenderPass.ts renderStart). */
	renderStart(rootId: RootId, includeBatches: BatchId[]): RenderPass {
		return this.renderOps.renderStart(rootId, includeBatches);
	}

	/** Yield/resume edges: while yielded, code that runs in the gap (event
	 * handlers, other renders) is "not in render" for this render. */
	renderYield(id: RenderPassId): void {
		this.renderOps.renderYield(id);
	}

	renderResume(id: RenderPassId): void {
		this.renderOps.renderResume(id);
	}

	/** Mount a new watcher inside an open render; it renders in the render's world. */
	mountWatcher(renderPassId: RenderPassId, node: AnyNode, name: string): Watcher {
		return this.renderOps.mountWatcher(renderPassId, node, name);
	}

	/** Reveal-shaped mounts (React's Offscreen/Activity — see RenderPass.ts). */
	deferMountEffects(watcherId: WatcherId): void {
		this.renderOps.deferMountEffects(watcherId);
	}

	adoptRevealedMount(renderPassId: RenderPassId, watcherId: WatcherId): void {
		this.renderOps.adoptRevealedMount(renderPassId, watcherId);
	}

	/** An existing live watcher re-rendered by a render (see RenderPass.ts). */
	renderWatcher(renderPassId: RenderPassId, watcherId: WatcherId): void {
		this.renderOps.renderWatcher(renderPassId, watcherId);
	}

	/** Full watcher removal — the bindings' unsubscribe surface (see RenderPass.ts). */
	removeWatcher(watcherId: WatcherId): void {
		this.renderOps.removeWatcher(watcherId);
	}

	// ------------------------------------------ the subscription mechanism
	// (effects unification by promotion — the adapter's EffectRec, moved into
	// core as THE committed-observer mechanism.) The whole lifecycle —
	// mountCommittedObserver, the captureRun/captureRead capture frame,
	// removeSubscription, the replay referee surface, and the RCC-EF2
	// boundary revalidation — lives in Subscription.ts, composed in the
	// constructor; the public operations are own-field aliases of its table,
	// and the boundary revalidation joins the shared core record so the
	// resident orchestration (retirement, render end, quiet fold) and the
	// settlement drain reach it as table calls.


	/**
	 * Per-root commit lock-in — THE single owner of a root's committed-state
	 * transition (RenderPass.ts commitBatches; the bindings' root-commit
	 * report handler calls this public form). Returns whether any batch was
	 * newly locked in.
	 */
	commitBatches(rootId: RootId, batches: Iterable<BatchId>): boolean {
		return this.renderOps.commitBatches(rootId, batches);
	}

	/**
	 * End a render (RenderPass.ts renderEnd — the commit fan's ordering
	 * story lives there).
	 */
	renderEnd(id: RenderPassId, kind: 'commit' | 'discard', opts?: { retireAtCommit?: BatchId[] }): void {
		this.renderOps.renderEnd(id, kind, opts);
	}

	// ---------------------------------------------------------- retirement
	// Retirement — the batch's terminal transition and its cross-module fan
	// (stamp → compact → fan → drain → clear-membership → release) — lives in
	// Batch.ts with the rest of the batch lifecycle; these delegates are the
	// public/protocol surface. Mount fixup, the dependency closure, and the
	// re-staled bookkeeping live in RenderPass.ts; the drains and the one
	// urgent correction live in deliver.ts.

	/** Retirement fires exactly once per batch; parked async actions retire
	 * only at settlement (see Batch.ts retire). */
	retire(batchId: BatchId): void {
		this.batchOps.retire(batchId);
	}

	/** The async action's promise settled; the protocol host then retires the
	 * batch (see Batch.ts settleAction). */
	settleAction(batchId: BatchId): void {
		this.batchOps.settleAction(batchId);
	}

	/** Transitive dependency closure feeding a node (RenderPass.ts — §4.4.7's
	 * triple walk; public referee/diagnostics surface). */
	dependencyClosureOf(nodeId: NodeId, render?: RenderPass): Set<NodeId> {
		return this.renderOps.dependencyClosureOf(nodeId, render);
	}


	// ------------------------------------------- episodes and quiescence

	/** Synchronously abandons every work-in-progress render. */
	discardAllWip(): void {
		for (const p of [...this.rootToOpenRender.values()]) {
			this.renderEnd(p.id, 'discard');
		}
	}

	quiescent(): boolean {
		return this.batchOps.liveBatchCount() === 0 && this.rootToOpenRender.size === 0;
	}

	/**
	 * Quiescence (no live batches, no live pins, no parked actions): the
	 * epoch bumps, dead episode records drop, and
	 * the ARENAS PERSIST — their links are current structure, not an
	 * episode log (§4.1), so the routing coverage committed observers rely
	 * on survives by persistence (the old K1 bulk-reset + kernel-pull
	 * refresh dissolved with K1 at S-B; nothing re-records because nothing
	 * was lost). Two arena duties run, in order: the zero-consumer
	 * reclamation sweep, then the read-clock renumber over the survivors
	 * only (§4.5.8, §4.5.7).
	 *
	 * SEQUENCE-WIDTH BOUND (where renumbering used to live). Retained
	 * sequence values (baseSeq, retirement stamps, committedAdvance, watcher snapshot
	 * pins) are NOT rewritten at quiescence: sequences are plain JS numbers,
	 * exact for integers to 2^53, they are only ever compared (<, <=, max —
	 * never bit-twiddled), and every storage site is a scalar field or a
	 * plain number array, so the engine stays correct until 2^53 creates —
	 * about 28 years at a sustained 10M writes/sec. Renumbering was measured
	 * (grind batch 4, item C): forcing every seq past SMI range (2^35) on
	 * log-heavy shapes moved fold/write throughput by ~1% — within noise,
	 * below the 2% keep threshold — so the machinery was deleted. One
	 * diagnostics caveat: `cosignal/trace` packs seqs into Int32 records,
	 * so trace decode fidelity (not engine correctness) degrades past
	 * 2^31-1 created sequences.
	 */
	quiesce(): void {
		if (!this.quiescent()) throw new ScheduleError('quiescence requires no live batches, pins, or parked actions');
		// Residue check: with no live pins, the last retirement compacted every write log.
		for (const n of this.idToNode.values()) {
			if (n.kind === 'atom' && n.log.n > n.log.start) {
				throw new InvariantViolation(`quiescence residue: atom ${n.name} still holds ${n.log.n - n.log.start} log entries`);
			}
		}
		this.epoch++;
		// Dead-episode records drop at the reset: nothing from a dead
		// episode can validate in a live one; serial counters stay monotone.
		for (const [id, p] of this.idToRenderPass) {
			if (p.state === 'ended') this.idToRenderPass.delete(id);
		}
		for (const [id, t] of this.idToBatch) {
			if (t.state === 'retired') this.idToBatch.delete(id);
		}
		this.lastBatchId = 0;
		this.lastBatchRef = undefined;
		// (No newest-side reset since S-C: kernel caches persist — nothing
		// newest-visible changes at quiescence.)
		// Arena duties (§4.5.8 then §4.5.7): reclamation sweep, then the
		// read-clock renumber over surviving consumer-populated arenas.
		this.arenaQuiesceSweep();
		// Dead-episode bookkeeping zeroes (bulk-zero at episode reset).
		for (const s of this.slots) {
			s.writeClock = 0;
			s.claimSeq = 0;
			s.releasePending = false;
		}
		for (const w of this.watchers.values()) w.dedupBits = 0;
		{
			const tr = this.trace;
			if (tr !== undefined) tr.epochReset(this.epoch);
		}
		this.recomputeQuiet(); // quiescent by definition; re-derive from the new episode's state
		this.endOp();
		this.arenaOpEpilogue();
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
		return this.evaluate(node, NEWEST);
	}

	renderValue(node: AnyNode, render: RenderPass): Value {
		return this.evaluate(node, { kind: 'render', render });
	}
}

// One Core: this module is internal machinery of the single `cosignal` entry
// (src/index.ts imports and re-exports it). It adds `registerReactBridge`,
// the bridge class, and the bridge-surface types to the base API.
