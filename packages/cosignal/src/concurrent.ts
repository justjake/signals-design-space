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
 * ONE CORE, ALWAYS-CONCURRENT: this module is internal machinery of the
 * single `cosignal` entry — index.ts imports and re-exports it — and THE
 * ONE ENGINE composes at module initialization (`composeEngine` below;
 * `__resetEngineForTest` re-runs it, nothing else does). There is no
 * installation step and no registration era: the public Atom/Computed
 * methods dispatch into the engine's paths DIRECTLY — writes through
 * `engineWrite` (behind the `standaloneQuiet` fast arm), reads through the
 * routed-read trampolines (behind the `routingActive` flag) — and a
 * process that never attaches a driver and never opens a batch keeps both
 * fast arms forever (tests/one-core.spec.ts asserts zero log
 * entries/batches/worlds under heavy sync-only traffic). A HOST attaches
 * through `attachDriver` (ONE driver: batch context for writes, the
 * ambient world for reads, the operation-boundary listeners).
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

import { Atom, Computed, CycleError, SuspendedRead, untracked, __plainAtomWrite, __resetPolicyForTest, __setStandaloneQuiet, type ComputedCtx } from './index.js';
import { E, LinkField, NodeField, RecordGeom, fns, maybeBoundary, writeNewest, __resetKernelForTest, engineEpoch } from './graph.js';
import { __clearUseCacheForIndex, __ctxUse, __resetSuspenseForTest, __setSettleTap } from './suspense.js';
import { __setReclaimGuardHook, __setRecordFreeHook } from './graph.js';
import { InvariantViolation, ScheduleError, mustGet } from './errors.js';
import { createConcurrentEngine, probes, type ConcurrentEngine, type WriteKind } from './engine.js';
import type { DeliverTable, NotifyState } from './deliver.js';
import type { ObservationTable } from './observation.js';
import { WriteLog, type CompactionTable, type WriteLogEntry } from './WriteLog.js';
import { BATCH_NONE, type Batch, type BatchId, type BatchSlot, type BatchSlotMeta, type BatchSlotSet, type BatchTable } from './Batch.js';
import { NEWEST, type EngineCore, type World } from './World.js';
import { WorldArena, arenaCheckerLayout, arenaHoldsSuspended, arenaRenumberMarks, kernelNodeIndexOf } from './WorldArena.js';
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
	/** The public handle this overlay rides — STRONG for referee/embedding-
	 * created nodes (engine.atom: the NODE is the public object and owns its
	 * handle), a WEAKREF for handle-resolved nodes (nodeForAtom). RECLAMATION
	 * (plan §1 L2): the engine must never pin a public handle — the handle
	 * pins the node (`Atom._node`), never the reverse — or a content-ful
	 * handle could never become unreachable and its record could never free.
	 * Warm paths never read this slot: they use the `id` copy (identical by
	 * construction); the cold consumers go through the `handle` getter.
	 * @internal */
	_h: Atom<Value> | WeakRef<Atom<Value>>;
	/** Last batch id that appended here (dedupe for batch.atomsTouched). */
	lastTouchBatch: BatchId = 0;

	/** The public handle (cold accessor — see `_h`; typed live: every caller
	 * that can observe a dead handle goes through `_h` directly). */
	get handle(): Atom<Value> {
		const h = this._h;
		return h instanceof WeakRef ? (h.deref() as Atom<Value>) : h;
	}

	constructor(id: NodeId, ix: NodeIndex, name: string, initial: Value, equals: Equals, eqIsDefault: boolean, h: Atom<Value> | WeakRef<Atom<Value>>) {
		this.id = id;
		this.ix = ix;
		this.name = name;
		this.base = initial;
		this.equals = equals;
		this.eqIsDefault = eqIsDefault;
		this._h = h;
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
export class ComputedNode {
	readonly kind = 'computed' as const;
	id: NodeId;
	/** Cached NodeField.NODE_INDEX of `id`'s record (see AtomNode.ix). @internal */
	ix: NodeIndex;
	name: string;
	/** The WORLD evaluation function (arena refolds, mount-fix folds). */
	fn: ComputedFn;
	/** The public handle whose kernel record this node rides — STRONG for
	 * engine-created computeds (`computed()`: the node owns its handle), a
	 * WEAKREF for resolved public handles (nodeForComputed). Same reclamation
	 * rule as AtomNode._h: the engine never pins a public handle; warm paths
	 * read the `id` copy. @internal */
	_h: Computed<unknown> | WeakRef<Computed<unknown>>;
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
	prevCell: { value: Value } = { value: undefined };

	/** The public handle (cold accessor — see `_h`). */
	get handle(): Computed<unknown> {
		const h = this._h;
		return h instanceof WeakRef ? (h.deref() as Computed<unknown>) : h;
	}

	constructor(id: NodeId, ix: NodeIndex, name: string, fn: ComputedFn, h: Computed<unknown> | WeakRef<Computed<unknown>>, ctxShaped: boolean, isEqual: Equals | undefined) {
		this.id = id;
		this.ix = ix;
		this.name = name;
		this.fn = fn;
		this._h = h;
		this.ctxShaped = ctxShaped;
		this.isEqual = isEqual;
	}
}

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
 * hook object held on the engine core record (the `engine.trace`
 * accessor pair) — `undefined` unless
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

// ---- module state: the ONE engine -------------------------------------------------
// There is exactly ONE concurrent engine per process (always-concurrent —
// the composition runs at module initialization, `__resetEngineForTest`
// re-runs it). The bindings the operational surface reads live here as
// module state; `composeEngine` (below the operation functions) re-points
// them at every composition.

/** The attached driver, or undefined (host-agnostic embedding / tests). */
let driver: EngineDriver | undefined;

/**
 * The ARMED quiet state — the one boolean the write path branches on,
 * recomputed only at pipeline transitions (batch open/retire, render
 * start/end, driver attach): quiet ⇔ zero live batches AND zero open renders
 * AND every write log compacted. While QUIET, a context-free write to a
 * node with engine content FOLDS DIRECTLY (see quietWrite); a handle with
 * no engine content takes the plain graph write (the node-less arm — its
 * whole history is quiet folds, so kernel-current IS its committed base).
 */
export let quiet = true;
// (quiet AND no driver — the public fast-arm flag `standaloneQuiet` — lives
// in index.ts beside the write methods that read it every call; the quiet
// derivation lands it there through `__setStandaloneQuiet`.)

// ---- One Core probes (referee surface) --------------------------------------------
// The counter record lives in engine.ts (its mutation sites span
// WriteLog.ts, Batch.ts, World.ts, and engine.ts); engine logic never reads it.

/** Referee surface — a snapshot of the engine-activity counters for the zero-cost test. @internal */
export function __coreProbes(): { logEntries: number; batches: number; worldEvals: number; bridges: number } {
	return { ...probes };
}

// ---- the public write dispatch (called by index.ts's Atom.set/update) -------------

/**
 * THE classified write dispatch — everything after index.ts's policy assert
 * and its standalone fast arm (a contentless handle while `standaloneQuiet`
 * takes the plain graph write without entering this function):
 *
 *   driver attached → one foreign call for the batch context
 *     (`driver.currentBatch()` — protocol v2: the id IS the engine BatchId,
 *     allocator-opened at the batch's creation) → recorded write into it;
 *     BATCH_NONE converges to the context-free arm below.
 *   quiet → the node-less arm (plain graph write) or the quiet fold.
 *   else → the ambient default batch (bareWrite).
 */
export function engineWrite(atom: Atom<unknown>, kind: WriteKind, payload: unknown): void {
	const d = driver;
	if (d !== undefined) {
		const batchId = d.currentBatch();
		if (batchId !== BATCH_NONE) {
			writeInBatch(batchId, nodeForAtom(atom), kind, payload);
			return;
		}
	}
	if (quiet) {
		const node = atom._node;
		if (node === undefined) {
			// The node-less arm: no engine content (no log entries, no
			// watchers, no arena presence) means no world consumer can see
			// this atom except through newest — the plain graph write IS the
			// whole quiet fold (index.ts owns the tail: fold + R-2 policy
			// equality once + kernel write). Content allocation later
			// re-seeds base from kernel-current, which this write is part of.
			__plainAtomWrite(atom, kind, payload);
			return;
		}
		quietWrite(node, kind, payload);
		return;
	}
	bareWrite(nodeForAtom(atom), kind, payload);
}

/** The id-resolved atom node, if it has engine content (the lifecycle
 * write path's handle-free resolution). @internal */
export function __engineAtomNodeById(id: NodeId): AtomNode | undefined {
	const hit = idToNode.get(id);
	return hit !== undefined && hit.kind === 'atom' ? hit : undefined;
}

/** The classified dispatch over an already-resolved node (the handle-free
 * lifecycle write path — same arms as engineWrite). @internal */
export function __engineWriteNode(node: AtomNode, kind: WriteKind, payload: unknown): void {
	const d = driver;
	if (d !== undefined) {
		const batchId = d.currentBatch();
		if (batchId !== BATCH_NONE) {
			writeInBatch(batchId, node, kind, payload);
			return;
		}
	}
	if (quiet) {
		quietWrite(node, kind, payload);
		return;
	}
	bareWrite(node, kind, payload);
}

/** The routed `.state` read trampolines (index.ts's public getters call
 * these when `routingActive` is set; the bodies are World.ts's core slots,
 * read at call time — reset-safe). @internal */
export function __routedAtomRead(a: Atom<unknown>): unknown {
	return core.routedAtomRead(a);
}

export function __routedComputedRead(c: Computed<unknown>): unknown {
	return core.routedComputedRead(c);
}

/** NF2 S-A: the settle-tap target (ONE closure per process; the kernel's
 * shared listener consults it at fire time — §4.5.4). */
function settleTapImpl(t: PromiseLike<unknown>): void {
	core.settleTap(t);
}

/** The record-free target (ONE closure per process, kernel-registered at
 * composition): the kernel's boundary sweep reports every freed node
 * record; the engine scrubs its nodeIndex-keyed rows so the slot's next
 * tenant (which inherits the index) starts clean. */
function recordFreeImpl(recordId: NodeId, nodeIndex: number): void {
	__onRecordFree(recordId, nodeIndex);
}

// (kernelGenOf / kernelNodeIndexOf — the live kernel-memory tenancy/index
// reads — live in WorldArena.ts beside their hottest consumers, imported
// above for the registry and the resident walks.)

/** An arena buffer capacity, counted in Int32 slots (stride-8 records: one
 * node shadow or one dependency link per record). */
export type ArenaInitInts = number;

/** Engine tuning — accepted by `__resetEngineForTest` (per-instance bridge
 * construction died with the class; these are RESET PARAMETERS now, and a
 * never-reset production process runs the defaults). */
export type EngineResetOptions = {
	/**
	 * Every claimed world arena's buffer starts at this capacity and grows
	 * in place when its records outgrow it (default 8192 ints). Shrinking it
	 * makes even small graphs exercise mid-operation growth, which is how the
	 * arena suites pin every growth path.
	 */
	arenaInitInts?: ArenaInitInts;
	/**
	 * Arms development-time checks in the engine and the bindings driving
	 * it: protocol-edge states the host integration contract makes
	 * unreachable (a write with no batch context, a render pass starting
	 * over a still-open one, opening a batch with no driver attached) throw
	 * instead of taking their defined fall-through, and dev-only diagnostics
	 * (the post-await orphan-write warning) run. Default off: each guarded
	 * site then costs one boolean branch and allocates nothing. Test
	 * harnesses arm it so suites exercise the throws.
	 */
	devChecks?: boolean;
};

/**
 * THE DRIVER SEAM — the one attachment surface a host integration installs
 * (the React bindings' shim, or a test harness standing in for them). It
 * replaces the old registration/classifier/adopter/provider seam family:
 * one record, installed once, a second attach throws (reset clears it).
 *
 * THE DRIVER CONTRACT:
 *  - `currentBatch` is consulted once per classified public write (the one
 *    foreign call — protocol v2: the returned id IS the engine BatchId,
 *    because the driver's registered batch-id ALLOCATOR opened the engine
 *    batch at the batch's creation; `openBatch` is the engine half of that
 *    allocator, and its ALLOCATION-ONLY envelope is documented there).
 *    Returning BATCH_NONE means "no batch context": the write converges to
 *    the ordinary context-free arm (quiet fold, else the ambient batch).
 *  - `worldFor` answers the ambient world for routed reads from the LIVE
 *    call context (the render actually on stack; undefined = newest).
 *  - the listeners are delivered at each operation's boundary (never
 *    mid-operation).
 *  - `protocolReset` (test-only) clears the host's protocol registry (the
 *    fork's full slot tenancy); `__resetEngineForTest` invokes it FIRST,
 *    before scrubbing the engine.
 *
 * Hosts that open batches must retire them — `openBatch`/`retire`/
 * `renderStart`/... remain the host-agnostic embedding surface; the driver
 * only carries the write/read context and the consumption listeners.
 */
export type EngineDriver = {
	/** The host's batch context for the write executing NOW (BATCH_NONE = none). */
	currentBatch(): BatchId;
	/** The ambient world for routed reads (undefined = newest). */
	worldFor(): World | undefined;
	/** A value-blind delivery reached a live watcher (fresh or interleaved). */
	onDelivery?: (w: Watcher, batch: Batch, slot: BatchSlot) => void;
	/** Mount fixup scheduled a corrective re-render into a live batch's lane. */
	onMountCorrective?: (w: Watcher, batch: Batch, slot: BatchSlot) => void;
	/** An urgent pre-paint correction (mount window / committed-truth drift). */
	onCorrection?: (w: Watcher) => void;
	/** Test-only: reset the host's protocol registry (invoked FIRST by
	 * `__resetEngineForTest`; never called in production). */
	protocolReset?: () => void;
};

/**
 * Installs the driver, exactly once (the enforcement that replaced the
 * dying once-per-process registration latch): a second attach throws;
 * `__resetEngineForTest` clears the slot. Throws inside any open
 * evaluation/fold frame — the seam must not move under a live frame.
 */
export function attachDriver(d: EngineDriver): void {
	if (core.evalDepth > 0 || core.inFoldCallback) {
		throw new ScheduleError('attachDriver called inside an open evaluation/fold frame; it may only run at an operation boundary');
	}
	if (driver !== undefined) {
		throw new ScheduleError('a driver is already attached — attachDriver may be called once (reset the engine first in tests)');
	}
	driver = d;
	core.onDelivery = d.onDelivery;
	core.onMountCorrective = d.onMountCorrective;
	core.onCorrection = d.onCorrection;
	core.setWorldProvider(() => d.worldFor());
	eng.recomputeQuiet(); // re-derives quiet AND standaloneQuiet (now false: every write makes the one foreign call)
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
 * `__checkerInternals()`, consumed only by the test-side
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

// ---- the one engine's state -------------------------------------------------------

/**
 * The concurrent-worlds engine's operational surface. Function-for-function
 * it exposes what the external-runtime protocol drives (batches, renders,
 * commits, retirements) — the same surface the reference model
 * (`cosignal-oracle`) implements, so the two can run any schedule in
 * lockstep. The kernel integration points are: `AtomNode.handle`
 * (kernel-backed newest storage, eager stepwise apply on every recorded
 * write) and the public methods' direct dispatch (engineWrite + the routed
 * `.state` reads).
 *
 * Referee surface: the twin tests run the oracle's `checkInvariants` /
 * `snapshotModel` against a MODEL VIEW of this engine (tests/model-view.ts)
 * that materializes the model's shape — write logs, archives, origins, dedup
 * sets — from packed engine state plus a driver-side mirror fed by the
 * `onCompact` hook, so the production engine carries no mirror members.
 *
 * STATE THREADING (§3.2 of the great-refactor plan): every binding below is
 * module state re-pointed by `composeEngine` — the ONE composition call,
 * run at module initialization and re-run only by `__resetEngineForTest`.
 * Cross-module reads go through the composition's tables at call time.
 */

/** Registered nodes (atoms AND computeds) by NodeId — the kernel record
 * id, one id space. `disposeComputed` and the record-free scrub clear
 * rows, so a REUSED record id can never resolve to a dead tenant. Nodes
 * appear on first CONTENT (a log entry, a watcher, arena presence, a
 * routed read, a referee construction) — never at handle creation. */
let idToNode: Map<NodeId, AnyNode>;
/** Batch records by id (alias of Batch.ts's registry, by identity). */
let idToBatch: Map<BatchId, Batch>;
/** The 31-entry recycling slot table (alias of Batch.ts's, by identity). */
let slots: BatchSlotMeta[];
let idToRenderPass: Map<RenderPassId, RenderPass>;
let roots: Map<RootId, RootState>;
let watchers: Map<WatcherId, Watcher>;
/** The committed `run`-action subscription store (alias of
 * Subscription.ts's, by identity). */
let idToSubscription: Map<EffectId, Subscription>;
// (The trace recorder slot and the direct listeners live on the shared
// engine core record; the `engine` surface object at the bottom of this
// file exposes accessor pairs over them for the referee/bindings.)

// The notification queue mechanism (deliver.ts): columns + enqueue/flush.
// `notifyState` aliases the table's two live scalars so the resident hot
// checks (the quiet-write flush guard) stay plain field reads.
let notifyOps: DeliverTable;
let notifyState: NotifyState;

/** The one global sequence line every log entry/pin/stamp is a point on. */
let seq: Seq = 0;
/** Committed-advance counter, in sequence units: bumped whenever committed
 * truth moves (per-root commit, or a retirement that changed history). */
let committedAdvance: Seq = 0;
/** Episode counter; bumped at quiescence when the engine's per-node-id tables bulk-reset. */
let epoch: Epoch = 0;
/** Development-time checks switch (EngineResetOptions.devChecks). */
let devChecks = false;

// ---- routing walk scratch (arena walks + collection dedup) ----
// DENSE PER-NODE COLUMNS: keyed by nodeIndex (NodeField.NODE_INDEX — read
// off kernel record memory; node objects cache it as `.ix`), NEVER by
// NodeId — node and link records share the kernel's one allocator, so
// record-id keying would go holey where index keying stays packed. Each
// column's row for a freed record clears in __onRecordFree (the
// record-free scrub): indexes recycle with record slots, and the slot's
// next tenant must never see the old tenant's rows. Columns gap-fill at
// CONTENT allocation (indexNode) — handle creation costs nothing here.
/** Per-NODE visited/collection generation column: one stamp per nodeIndex,
 * shared by the routing walks (delivery collection dedup across
 * arenas, drain candidate dedup) — arena TRAVERSAL termination uses the
 * per-arena `walk` side column instead, because the same node's cone
 * differs per arena and must be walked in each. */
let lastWalk: WalkGen[];
/** Nodes by nodeIndex (dense array twin of `idToNode`). */
let nodesArr: (AnyNode | undefined)[];
// ---- the observed closure (transitive observation retains) ----
// The observation index — the refcount/retained-dep columns and every
// closure-membership transition — lives in observation.ts (its module
// header carries the full story). `obsRefs`/`obsDeps` alias the table's
// columns BY IDENTITY (the kernel's shared-side-column pattern): the hot
// evaluation frames probe `obsRefs[ix] > 0` per observed run, and
// indexNode's gap-fill and the record-free scrub maintain rows in the
// same loop as the other dense columns.
let obs: ObservationTable;
let obsRefs: number[];
let obsDeps: (Set<AnyNode> | undefined)[];
let obsSyncDeps: ObservationTable['syncDeps'];
/** Watchers by nodeIndex (the routing walks' collection rows). */
let nodeToWatchers: (Watcher[] | undefined)[];
// The write-log compaction mechanism (WriteLog.ts); the batch-state edge of
// a compaction is Batch.ts's own releaseLogEntry.
let compaction: CompactionTable;
/** Atoms with a non-empty write log (compaction candidates; identity alias
 * of WriteLog.ts's set). */
let uncompactedAtoms: Set<AtomNode>;
/** The one open (non-ended) render per root — React renders one tree per
 * root at a time; a same-root restart is a new render. */
let rootToOpenRender: Map<RootId, RenderPass>;
// The batch mechanism + retirement lifecycle (Batch.ts).
let batchOps: BatchTable;
/** Last-batch cache (windowed writes hit one batch repeatedly) — the
 * write path's cache over the mechanism's registry. */
let lastBatchId = 0;
let lastBatchRef: Batch | undefined = undefined;
/** Optional compaction observer (referee/diagnostics seam): called once
 * per log entry as it folds into base and leaves the write log. The oracle's
 * retention invariant needs the full history; its archive mirror lives
 * OUTSIDE the engine (tests/model-view.ts), fed by this hook — keeping
 * every compacted log entry in-engine would grow without bound. Production
 * leaves it undefined and retains nothing. */
let onCompact: ((atom: AtomNode, entry: WriteLogEntry) => void) | undefined = undefined;

/** THE shared engine-core record (World.ts `EngineCore`) of the current
 * composition. */
let core: EngineCore;
/** The current composition's tables (engine.ts createConcurrentEngine). */
let eng: ConcurrentEngine;
// ---- module aliases of core-table entries (resident hot shapes) ----
let evaluate: (node: AnyNode, world: World) => Value;
let foldAtomOp: (atom: AtomNode, world: World) => Value;
let applyOp: (atom: AtomNode, kind: WriteKind, payload: unknown, prev: Value) => Value;
let eqAtom: (atom: AtomNode, a: Value, b: Value) => boolean;
let inCallback: <T>(fn: () => T) => T;
let evalMark: EvalGen[];
let rootToArena: Map<RootId, WorldArena>;
let releaseArena: (a: WorldArena) => void;
let eachArena: (fn: (a: WorldArena) => void) => void;
let purgeNodeFromArenas: (ix: NodeIndex) => void;
let fanAtomsToArena: (a: WorldArena, atoms: AtomNode[], fromSettlement: boolean) => void;
let fanAtomsToCommittedArenas: (atoms: AtomNode[]) => void;
let oneAtomBuf: (atom: AtomNode) => AtomNode[];
let arenaDecay: (a: WorldArena) => void;
let deliveryWalk: (from: AtomNode, batch: Batch, slot: BatchSlotMeta, seq: Seq) => void;
let arenaOpEpilogue: () => void;
let endOp: () => void;
let mountCommittedObserver: (rootId: RootId, name: string, refire?: () => void) => Subscription;
let captureRun: (id: EffectId, body: () => void) => void;
let captureRead: (node: AnyNode) => Value;
let removeSubscription: (id: EffectId) => void;
let replayReactEffect: (id: EffectId) => void;
let revalidateCommittedSubs: (rootFilter: RootId | undefined) => void;
let renderOps: RenderPassTable;
let kernelTrackedReader: Reader;

/**
 * THE COMPOSITION CALL — runs every mechanism factory (engine.ts
 * createConcurrentEngine) and re-points the module bindings above. Run once
 * at module initialization; re-run ONLY by `__resetEngineForTest` (§3.2:
 * RESET re-runs all factories; GROWTH re-runs the graph factory only and
 * never touches this). The host record's arrows close over module state.
 */
function composeEngine(options?: EngineResetOptions): void {
	idToNode = new Map<NodeId, AnyNode>();
	idToRenderPass = new Map<RenderPassId, RenderPass>();
	roots = new Map<RootId, RootState>();
	watchers = new Map<WatcherId, Watcher>();
	nodesArr = [undefined];
	lastWalk = [0];
	nodeToWatchers = [undefined];
	rootToOpenRender = new Map<RootId, RenderPass>();
	seq = 0;
	committedAdvance = 0;
	epoch = 0;
	lastBatchId = 0;
	lastBatchRef = undefined;
	onCompact = undefined;
	driver = undefined;
	devChecks = options?.devChecks ?? false;
	eng = createConcurrentEngine({
		idToNode,
		nodesArr,
		nodeToWatchers,
		lastWalk,
		watchers,
		idToRenderPass,
		rootToOpenRender,
		roots,
		root,
		nodeForAtom,
		nodeForComputed,
		kernelStrongDepsOf,
		kernelReadOf,
		onCompact: () => onCompact,
		hasDriver: () => driver !== undefined,
		devChecksOn: () => devChecks,
		setQuiet: (q) => {
			quiet = q;
			__setStandaloneQuiet(q && driver === undefined);
		},
		nextSeq,
		getSeq: () => seq,
		getCommittedAdvance: () => committedAdvance,
		advanceCommitted: () => {
			committedAdvance = nextSeq();
		},
		invalidateBatchCache: (id) => {
			if (lastBatchId === id) {
				lastBatchId = 0;
				lastBatchRef = undefined;
			}
		},
	}, options);
	core = eng.core;
	notifyOps = eng.notify;
	notifyState = eng.notify.state;
	obs = eng.obs;
	obsRefs = eng.obs.refs;
	obsDeps = eng.obs.deps;
	obsSyncDeps = eng.obs.syncDeps;
	compaction = eng.compaction;
	uncompactedAtoms = eng.compaction.uncompactedAtoms;
	batchOps = eng.batch;
	idToBatch = eng.batch.idToBatch;
	slots = eng.batch.slots;
	renderOps = eng.render;
	idToSubscription = eng.subs.idToSubscription;
	mountCommittedObserver = eng.subs.mountCommittedObserver;
	captureRun = eng.subs.captureRun;
	captureRead = eng.subs.captureRead;
	removeSubscription = eng.subs.removeSubscription;
	replayReactEffect = eng.subs.replayReactEffect;
	revalidateCommittedSubs = eng.subs.revalidateCommittedSubs;
	kernelTrackedReader = eng.kernelTrackedReader;
	evaluate = core.evaluate;
	foldAtomOp = core.foldAtom;
	applyOp = core.applyOp;
	eqAtom = core.eqAtom;
	inCallback = core.inCallback;
	evalMark = core.evalMark;
	rootToArena = core.rootToArena;
	releaseArena = core.releaseArena;
	eachArena = core.eachArena;
	purgeNodeFromArenas = core.purgeNodeFromArenas;
	fanAtomsToArena = core.fanAtomsToArena;
	fanAtomsToCommittedArenas = core.fanAtomsToCommittedArenas;
	oneAtomBuf = core.oneAtomBuf;
	arenaDecay = core.arenaDecay;
	deliveryWalk = core.deliveryWalk;
	arenaOpEpilogue = core.arenaOpEpilogue;
	endOp = core.endOp;
	// The kernel seams, armed once per composition: the settlement tap
	// (consulted at thenable-settle FIRE time), the record-free scrub
	// (the boundary sweep reports freed node records so the nodeIndex-keyed
	// columns clear at exactly the reuse boundary), and the reclaim guards
	// (the engine-side rows of the reclamation guard table).
	__setSettleTap(settleTapImpl);
	__setRecordFreeHook(recordFreeImpl);
	__setReclaimGuardHook(reclaimGuardsImpl);
	core.syncReadRouting();
	eng.recomputeQuiet(); // nothing pending at composition: quiet arms here
}

// THE ONE ENGINE: composed at module initialization (always-concurrent — no
// installation step exists), recomposed only by `__resetEngineForTest`.
composeEngine();

/**
 * Resolve a public Atom handle to its engine node, ALLOCATING CONTENT on
 * first participation (a routed read, a classified write, a watcher mount,
 * a capture read — anything that gives the atom world-visible state). Base
 * seeds from kernel-current, which IS the atom's full committed history:
 * a content-less atom's every accepted write was a plain newest apply (the
 * node-less arm), and those are exactly quiet folds — visible to every
 * world by construction. There is no adoption era: a handle exists ⟺ the
 * engine can resolve it, and allocation is an internal packing step.
 */
function nodeForAtom(atom: Atom<unknown>): AtomNode {
	const hit = atom._node;
	if (hit !== undefined) return hit;
	const id = atom._id;
	const current = untracked(() => E.read(id)); // non-linking newest read
	const node = new AtomNode(
		id,
		kernelNodeIndexOf(id),
		atom.label ?? `atom#${id}`,
		current,
		(atom._isEqual as Equals | undefined) ?? Object.is,
		atom._isEqual === undefined,
		// WEAK handle slot (reclamation): content must not pin the public
		// handle — the handle pins the node (atom._node below). One WeakRef
		// per CONTENT allocation (cold, once per participating node — not the
		// rejected per-construction registration scheme).
		new WeakRef(atom as Atom<Value>),
	);
	atom._node = node;
	indexNode(node);
	return node;
}

/** The next point on the one global sequence line. */
function nextSeq(): Seq {
	return ++seq;
}

/** Registers a node in the dense side columns (keyed by its nodeIndex).
 * Gap-fill keeps every column PACKED: kernel nodes without engine content
 * (plain effects/scopes/handles) consume indexes between registrations, and
 * a write past a plain array's length would drop it to a holey kind. */
function indexNode(node: AnyNode): void {
	const ix = node.ix;
	idToNode.set(node.id, node);
	while (nodesArr.length <= ix) {
		nodesArr.push(undefined);
		lastWalk.push(0);
		evalMark.push(0);
		obsRefs.push(0);
		obsDeps.push(undefined);
		nodeToWatchers.push(undefined);
	}
	nodesArr[ix] = node;
	lastWalk[ix] = 0;
	evalMark[ix] = 0;
	obsRefs[ix] = 0;
	// Any row already here is a dead tenant's by construction (a fresh
	// registration means the slot's previous tenant freed) — the record-free
	// scrub normally cleared it already; this keeps the columns sound even
	// if a free was missed.
	obsDeps[ix] = undefined;
	nodeToWatchers[ix] = undefined;
}

/** Referee/embedding constructor: a NAMED engine atom (creates the public
 * handle AND its engine content in one step — the lockstep harness names
 * nodes so streams compare by name). */
export function atom(name: string, initial: Value, equals?: Equals): AtomNode {
	const handle = new Atom<Value>(initial, equals === undefined ? undefined : { isEqual: equals });
	const node = new AtomNode(handle._id, kernelNodeIndexOf(handle._id), name, initial, equals ?? Object.is, equals === undefined, handle);
	(handle as Atom<unknown>)._node = node;
	indexNode(node);
	return node;
}

/**
 * Referee/embedding constructor: an engine computed (S-C: one computed —
 * the node RIDES a fresh kernel `Computed` record). The kernel getter runs
 * the authored (read, untracked) fn with the KERNEL readers — dep reads
 * take the plain kernel paths (linking to this record; untracked reads
 * clear the kernel frame, so they leave no link and never notify) — under
 * the engine's evaluation guards (writes throw; observed runs capture
 * their strong deps; trace hooks fire). World evaluations run the same fn
 * with the ARENA readers through `arenaUpdateComputed`.
 */
export function computed(name: string, fn: ComputedFn, equals?: Equals): ComputedNode {
	// id/ix land after the kernel record exists (the getter closure needs
	// the node object first); nothing reads them in between. The handle slot
	// is STRONG: the referee/embedding node IS the public object and owns
	// its handle for its own lifetime.
	const node = new ComputedNode(0, 0, name, fn, undefined as never, false, equals);
	const handle = new Computed<unknown>(makeKernelGetter(node) as (ctx: ComputedCtx<unknown>) => Value, equals === undefined ? { label: name } : { label: name, isEqual: equals });
	node._h = handle;
	node.id = handle._id;
	node.ix = kernelNodeIndexOf(node.id);
	handle._node = node;
	E.markHostOwned(node.id); // its links carry no D1 lifecycle refs — the obs index is its arm
	indexNode(node);
	return node;
}

/**
 * Resolve a public `Computed` handle to its engine node, allocating content
 * on first participation (S-C): the handle's kernel record keeps serving
 * the newest world exactly as before — allocation only WRAPS its kernel
 * getter with the engine epilogue (observation re-pointing per re-run) and
 * builds the ctx-shaped WORLD fn: reads inside the raw fn are raw `.state`
 * reads, which the routed read seams serve from the evaluating arena;
 * `ctx.previous` serves the node's committed previous cell; `ctx.use` is
 * the id-keyed two-form dispatch (same key ⇒ same thenable for the node's
 * lifetime, across worlds); a background evaluation folds a pending
 * suspension to its stable sentinel VALUE (hook-initiated ones rethrow —
 * `suspendDepth`). Inlined here (the merge): the old makeCtxWorldFn /
 * makeAdoptedKernelGetter single-caller utilities.
 */
export function nodeForComputed(c: Computed<unknown>): ComputedNode {
	const hit = c._node;
	if (hit !== undefined) return hit;
	const name = c.label ?? `computed#${c._id}`;
	// WEAK handle slot (reclamation): see nodeForAtom — content never pins
	// the public handle. The world fn below closes over the RAW authored fn
	// (c._fn) and this node, never the handle itself.
	const node = new ComputedNode(c._id, kernelNodeIndexOf(c._id), name, undefined as never, new WeakRef(c), true, c._isEqual);
	// The (read, untracked)-shaped WORLD evaluation fn of a ctx-shaped
	// public computed (the readers are unused — the raw fn reads through
	// the `.state` seams, which the open arena frame routes and links).
	{
		const rawFn = c._fn as (ctx: ComputedCtx<unknown>) => Value;
		const ctx: ComputedCtx<unknown> = {
			get previous(): Value {
				return node.prevCell.value;
			},
			use: <V>(sourceOrKey: unknown, factory?: () => PromiseLike<V>): V =>
				__ctxUse(node.ix, sourceOrKey, factory as (() => PromiseLike<unknown>) | undefined) as V,
		} as ComputedCtx<unknown>;
		node.fn = () => {
			try {
				return rawFn(ctx);
			} catch (err) {
				// Background world evaluation: a pending suspension folds to its
				// stable SuspendedRead sentinel VALUE (so "still pending" caches
				// and compares like any value); hook-initiated evaluations
				// rethrow so React can suspend the component.
				if (err instanceof SuspendedRead && core.suspendDepth === 0) return err;
				throw err;
			}
		};
	}
	// Wrap the kernel getter with the engine epilogue: run the original
	// (equality wrappers and all), then re-point the observed closure at the
	// kernel links this run just re-tracked (raw `.state` reads inside a
	// kernel frame never reach a routed reader, so the fresh link list IS
	// the capture — full, reuse-proof, tracked-only).
	{
		const fnIx = c._id >> RecordGeom.ID_TO_FN_SHIFT;
		const inner = fns[fnIx] as (ctx: unknown) => unknown;
		fns[fnIx] = (ctxArg: unknown): unknown => {
			core.evalDepth++; // writes during a newest evaluation throw, as in every world
			const tr = core.trace;
			if (tr !== undefined) tr.evalStart(node, NEWEST);
			try {
				return inner(ctxArg);
			} finally {
				core.evalDepth--;
				if (tr !== undefined) tr.evalEnd();
				if (obsRefs[node.ix]! > 0) obsSyncAfterKernelRun(node, kernelStrongDepsOf(node));
			}
		};
	}
	E.markHostOwned(c._id); // retro-releases any lifecycle refs its links held (the obs index is its arm now)
	c._node = node;
	indexNode(node);
	return node;
}

/**
 * Dispose a computed (S-C — the useComputed deps-change reclamation
 * path: the superseded node's kernel record frees and its id becomes
 * reusable). The caller owns the discipline that the node is SUPERSEDED
 * (its watchers re-keyed to the replacement; live watchers here throw).
 * Order matters for id tenancy: the engine-side teardown runs FIRST —
 * every live arena's shadow purges eagerly (walks traverse links without
 * per-hop GEN checks, so links through the dead shadow must go now), the
 * registry row and dense node row clear (a reused record id resolves
 * fresh, never to the dead tenant) — then the kernel record disposes:
 * its GEN bumps at the boundary sweep, which also fires the record-free
 * scrub (__onRecordFree) clearing every remaining nodeIndex-keyed row
 * before the slot's index can be inherited by a new tenant.
 */
export function disposeComputed(handle: Computed<unknown>): void {
	const node = idToNode.get(handle._id);
	if (node !== undefined && node.kind === 'computed' && handle._node === node) {
		const ix = node.ix;
		const ws = nodeToWatchers[ix];
		if (ws !== undefined && ws.some((w) => w.live)) {
			throw new ScheduleError(`disposeComputed(${node.name}): live watchers still subscribe — re-key them to the replacement first`);
		}
		if (obsRefs[ix]! > 0) obs.exit(node); // release any retained closure (defensive)
		purgeNodeFromArenas(ix);
		idToNode.delete(node.id);
		nodesArr[ix] = undefined;
		handle._node = undefined;
	}
	// Kernel: deps unlink, subs detach, deferred free (GEN bump +
	// record-free scrub at the sweep).
	maybeBoundary();
	E.disposeComputed(handle._id);
	maybeBoundary(); // sweep now when possible, so the id-tenancy GEN moves at this boundary
}

	// (purgeNodeFromArenas — the whole-arena shadow purge disposeComputed and
	// the record-free scrub share — lives in WorldArena.ts; aliased above.)

/**
 * THE RECORD-FREE SCRUB (registered kernel-side via __setRecordFreeHook): a
 * node record freed at the kernel's boundary sweep surrenders its slot —
 * and the slot's NODE_INDEX — to a future tenant, so every nodeIndex-keyed
 * row must clear NOW. For engine-disposed computeds this re-runs teardown
 * idempotently; its load-bearing case is everything disposeComputed does
 * not cover — the watcher-index row a dormant mount left behind,
 * observation refs held transitively at free, walk/eval stamps, and node
 * records freed without engine-side teardown. Bound-checked: an index past
 * a column's length has no row, and writing there would drop the column to
 * a holey kind. @internal
 */
function __onRecordFree(recordId: NodeId, ix: NodeIndex): void {
	const resident0 = idToNode.get(recordId);
	if (resident0 !== undefined && resident0.kind === 'atom') clearHandleBacklink(resident0);
	idToNode.delete(recordId);
	if (ix < nodesArr.length) {
		const resident = nodesArr[ix];
		// Un-torn-down engine node (freed without engine disposal): release
		// its outgoing observation retains before the rows clear, so its
		// retained deps do not leak closure membership.
		if (resident !== undefined && obsRefs[ix]! > 0) obs.exit(resident);
		if (resident !== undefined && resident.kind === 'computed') clearHandleBacklink(resident);
		nodesArr[ix] = undefined;
		lastWalk[ix] = 0;
		evalMark[ix] = 0;
		obsRefs[ix] = 0;
		obsDeps[ix] = undefined;
		nodeToWatchers[ix] = undefined;
	}
	__clearUseCacheForIndex(ix); // the id-keyed ctx.use request cache (suspense.ts column)
	purgeNodeFromArenas(ix);
}

/** A freed record's handle backlink (`_node`) must clear when the handle is
 * STILL ALIVE (deterministic disposal, reset orphans): a live handle whose
 * cached node names a re-tenanted record would write through a stale id.
 * Reclamation-freed records have dead handles — the deref is undefined and
 * there is nothing to clear. */
function clearHandleBacklink(node: AnyNode): void {
	const h = node._h;
	const live = h instanceof WeakRef ? h.deref() : h;
	if (live !== undefined) live._node = undefined;
}

/**
 * ENGINE-SIDE RECLAIM GUARDS (registered kernel-side per composition — the
 * signal-reclamation plan's §4 table rows the kernel cannot see): watcher-
 * index membership (covers live, mounted-in-an-open-render, and reveal-
 * deferred watchers uniformly), observation retains (obsRefs > 0), a
 * non-empty write log, membership in any OPEN RENDER's arena, and membership
 * in any arena's suspended list (committed arenas' plain membership is NOT a
 * guard: the record-free scrub purges their shadows). Cold: runs once per
 * finalizer fire / retry.
 */
function reclaimGuardsImpl(id: NodeId, ix: NodeIndex): boolean {
	if (ix < nodeToWatchers.length) {
		const ws = nodeToWatchers[ix];
		if (ws !== undefined && ws.length !== 0) return true;
		if (obsRefs[ix]! > 0) return true;
	}
	const node = idToNode.get(id);
	if (node !== undefined && node.kind === 'atom' && node.log.n !== node.log.start) return true;
	for (const p of rootToOpenRender.values()) {
		const a = p.arena;
		if (a !== undefined && ix < a.nodeToShadow.length && a.nodeToShadow[ix] !== 0) return true;
	}
	let suspended = false;
	eachArena((a) => {
		if (!suspended && arenaHoldsSuspended(a, ix)) suspended = true;
	});
	return suspended;
}

/** The kernel getter of an engine-created computed (see `computed`). The
 * returned closure reads the CURRENT core at call time (reset-safe). */
function makeKernelGetter(node: ComputedNode): () => Value {
	return () => {
		const c = core;
		const savedCapture = c.obsCapture;
		c.obsCapture = obsRefs[node.ix]! > 0 ? [] : undefined;
		c.evalDepth++; // writes during a newest evaluation throw, as in every world
		const tr = c.trace;
		if (tr !== undefined) tr.evalStart(node, NEWEST);
		try {
			return node.fn(kernelTrackedReader, kernelUntrackedReader);
		} finally {
			c.evalDepth--;
			const captured = c.obsCapture;
			c.obsCapture = savedCapture;
			if (tr !== undefined) tr.evalEnd();
			if (captured !== undefined) obsSyncAfterKernelRun(node, captured);
		}
	};
}

/** The kernel-way dep read both kernel-frame readers share: atoms off the
 * kernel arena, computeds via the plain kernel computed read (E.read/
 * E.computedRead link the dep to any open kernel frame), kernel
 * CycleErrors translated to the engine's. */
function kernelReadOf(dep: AnyNode): Value {
	if (dep.kind === 'atom') return E.read(dep.id);
	try {
		return E.computedRead(dep.id);
	} catch (err) {
		if (err instanceof CycleError) throw core.cycleError(dep.name);
		throw err;
	}
}

/** Kernel-frame untracked reader: kernel `untracked()` clears the frame,
 * so the dep's own serving still runs (recompute-if-stale) but no link —
 * and therefore no notification, and no invalidation of this computed —
 * is ever recorded (§4.4.1's value face, the ruling's sampling rule). */
const kernelUntrackedReader: Reader = (dep) => untracked(() => kernelReadOf(dep));

/** Observation re-point after a KERNEL re-run, inside the still-open
 * kernel frame: discovery evaluations (obsEnter forcing dep reads) must
 * not link into that frame — kernel `untracked()` clears it around the
 * sync (the arena twin clears `serveOverride` instead — arenaSyncObsAfterRefold). */
function obsSyncAfterKernelRun(node: AnyNode, captured: AnyNode[]): void {
	untracked(() => obsSyncDeps(node, captured));
}

/** The engine nodes among a computed's CURRENT kernel deps (tracked-only by
 * construction: untracked reads leave no kernel link). Walked off the raw
 * kernel arena with the kernel's own exported layout enums. */
function kernelStrongDepsOf(node: ComputedNode): AnyNode[] {
	const memory = E.buffer();
	const out: AnyNode[] = [];
	let l = memory[node.id + NodeField.DEPS]!;
	while (l !== 0) {
		const dep = idToNode.get(memory[l + LinkField.DEP]!);
		if (dep !== undefined) out.push(dep);
		l = memory[l + LinkField.NEXT_DEP]!;
	}
	return out;
}

/** Root record lookup-or-create. */
export function root(id: RootId): RootState {
	let r = roots.get(id);
	if (r === undefined) {
		r = { id, committedBatches: new Set(), commitGen: 0, committedBits: 0, committedDirtySlots: 0 };
		roots.set(id, r);
	}
	return r;
}

// ---------------------------------------------------- worlds and folds
// The whole fold/evaluation family — the fold-purity bracket (inCallback),
// foldAtom, visibleAt (THE visibility rule), applyOp, eqAtom (THE equality
// rule), evaluate, kernelComputed, the fold-through readers, and the
// read-routing resolution — lives in World.ts; the hot entries are aliased
// as module bindings (see composeEngine). The arena serving/lifecycle layer
// lives in WorldArena.ts; the settlement tap and the operation epilogue
// pair live in settlement.ts.

/** Test seam: shrink the settlement-drain iteration cap. @internal */
export function __setSettleCapForTest(n: number): void {
	core.setSettleCap(n);
}

// ---- NF2 S-A: reclamation (§4.5.8) + the checker window (the divergence
// check and structural validator are TEST machinery and live in
// tests/arena-checker.ts, fed through __checkerInternals below) ----

/** The watcher-population refcount, derived (dev-assertable) form: live
 * watchers of the root + live committed subscriptions of the root. */
function consumerCount(rootId: RootId): number {
	let n = 0;
	for (const w of watchers.values()) {
		if (w.live && w.root === rootId) n++;
	}
	for (const sub of idToSubscription.values()) {
		if (sub.live && sub.root === rootId) n++;
	}
	return n;
}

/** Quiesce duty 1 (§4.5.8): release committed arenas whose consumer
 * population is zero — buffer to the pool (claim gen bumped), columns
 * dropped, lists discarded; the root RECORD stays (no teardown event
 * exists). Then duty 2 (§4.5.7): per-arena read-clock renumber over the
 * SURVIVORS only. */
function arenaQuiesceSweep(): void {
	for (const [rootId, a] of rootToArena) {
		if (consumerCount(rootId) === 0) {
			rootToArena.delete(rootId);
			releaseArena(a);
		}
	}
	for (const a of rootToArena.values()) arenaRenumberMarks(a);
}

/**
 * THE CHECKER WINDOW (W3): the one seam feeding the test-side referee —
 * tests/arena-checker.ts, which owns the armed divergence check
 * (arena-served values ≡ fold-truth) and the structural validator. The
 * views are readonly-shaped: live state getters plus bracket methods
 * that keep every mutation's save/restore discipline inside the engine.
 * Production code never calls this and installs no hook. Reads the CURRENT
 * composition at call time (reset-safe: re-arm after a reset). @internal
 */
export function __checkerInternals(): ArenaCheckerInternals {
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
		eachArena: (fn) => eachArena(fn),
		nodeAt: (ix) => nodesArr[ix],
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
export function __arenaForTest(rootId: RootId): WorldArena | undefined {
	return rootToArena.get(rootId);
}

/** Test seam: pooled arena shells (S-D pool reuse/cap pins). @internal */
export function __arenaPoolForTest(): WorldArena[] {
	return core.arenaPool;
}

/** Test seam: the CURRENT composition's dense nodeIndex-keyed columns (the
 * leak/elements-kind audits probe row clearing and packedness; identity
 * changes at reset). @internal */
export function __columnsForTest(): {
	nodesArr: (AnyNode | undefined)[];
	lastWalk: number[];
	evalMark: number[];
	obsRefs: number[];
	obsDeps: (Set<AnyNode> | undefined)[];
	nodeToWatchers: (Watcher[] | undefined)[];
} {
	return { nodesArr, lastWalk, evalMark, obsRefs, obsDeps, nodeToWatchers };
}

/** Test seam: force an id-tenancy generation bump — the kernel-GEN referee
 * seam. Tenancy IS the kernel record generation since the id-space merge,
 * so the bump writes the LIVE record's GEN field in kernel memory: arena
 * shadows re-tenant cold at their next consult and watcher stamps go
 * stale, exactly as a real free+reuse would move them. @internal */
export function __bumpNodeGenForTest(id: NodeId): void {
	E.buffer()[id + NodeField.GEN]++;
}

/** Arena stats (tests/bench). @internal */
export function __arenaStats(): { committed: number; renders: number; pooled: number; suspended: number; pendingSettlements: number; dirty: number } {
	let renders = 0;
	let dirty = 0;
	for (const p of rootToOpenRender.values()) {
		if (p.arena !== undefined) renders++;
	}
	eachArena((a) => {
		dirty += a.dirty.length;
	});
	return { committed: rootToArena.size, renders, pooled: core.arenaPool.length, suspended: core.suspendedCount, pendingSettlements: core.pendingSettleCount(), dirty };
}

/** Test seam: a committed arena's (dep → sub) link mode, or undefined
 * when no link exists (§4.4.1 mode-transition pin). @internal */
export function __arenaLinkMode(rootId: RootId, dep: AnyNode, sub: AnyNode): 'strong' | 'weak' | undefined {
	return core.__arenaLinkMode(rootId, dep, sub);
}

/** Test seam: a committed arena's live (dep → sub) link record id, or 0
 * when no link exists (freelist-discipline pins capture ids before a
 * teardown). @internal */
export function __arenaLinkIdForTest(rootId: RootId, dep: AnyNode, sub: AnyNode): number {
	return core.__arenaLinkIdForTest(rootId, dep, sub);
}

/** Test seam: raw NEXT_DEP field of an arena link record BY ID — valid
 * on freed links too. The freelist-discipline regression pin asserts a
 * freed link's stale nextDep still names its former neighbor, never the
 * free list: arenaCheckDirty reads NEXT_DEP off links a mid-walk purge
 * freed. @internal */
export function __arenaLinkNextDepForTest(rootId: RootId, linkId: number): number {
	return core.__arenaLinkNextDepForTest(rootId, linkId);
}

// (foldTruthFrame — the armed checker's naive evaluation frame — lives in
// WorldArena.ts with the serve-override state; __checkerInternals wires it.)

// ---- observed-closure maintenance ----
// The observation index — obsShift/obsEnter/obsExit and the two dep-
// snapshot re-pointers — lives in observation.ts (composed as `obs`; the
// columns are aliased above). Consumers call through the table: the watcher
// liveness seam, disposal/record-free teardown, evaluation-frame epilogues,
// and subscription capture.

// ---- the routing walks (arenas route) ----
// The arena-walking halves — walkArenaStrong, the watcher collection rows'
// readers, the drain candidate collection, and the fixup closure's arena
// leg — live in WorldArena.ts (same-file with the layout enums); the
// ORCHESTRATION — the delivery walk, the per-watcher delivery decision, the
// durable/quiet drains, and correctWatcher — lives in deliver.ts
// (createDeliverWalks), reached through the core's late-bound slots (the
// write path keeps its `deliveryWalk` module alias).

// -------------------------------------------------- batches and slots
// The batch MECHANISM — openBatch, batchById, slot interning/release/
// backstop, committed-bits rebuild, live-count bookkeeping — lives in
// Batch.ts (composed as `batchOps`; `idToBatch`/`slots` aliased above).
// Retirement lives with it; the public surface keeps thin delegates.

/** Create a batch (the public/referee surface — see Batch.ts openBatch;
 * R-5: with devChecks armed and no driver attached this throws — hosts
 * that open batches must retire them). */
export function openBatch(opts?: { action?: boolean; ambient?: boolean; deferred?: boolean }): Batch {
	return batchOps.openBatch(opts);
}

export function liveBatches(): Batch[] {
	return batchOps.liveBatches();
}

export function nodeById(id: NodeId): AnyNode {
	return mustGet(idToNode, id, 'node');
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
 * is no batch to attribute a drop to).
 *
 * R-2 equality: `isEqual(current, incoming)` — kernel order — invoked ONCE,
 * at the acceptance decision. The direct kernel apply below runs no policy
 * comparator (the old public-method re-entry double-invoked it).
 */
export function quietWrite(node: AtomNode, kind: WriteKind, payload: unknown): void {
	const c = core; // one load; the frame guards/pre-checks below stay one-property reads
	if (c.evalDepth > 0) throw new ScheduleError('signal write during a world evaluation / render — write from an event handler or effect instead');
	if (c.inFoldCallback) throw new ScheduleError('signal write inside an updater/reducer fold — updaters and reducers must be pure');
	// NF2 S-A: public-operation frame (matches `write`): the fused kernel
	// apply below can run effects whose writes are WHOLE nested operations
	// (R-3) — settlements they tap enqueue for THIS fold's epilogue, and the
	// armed divergence check waits for the top-level boundary.
	c.opDepth++;
	try {
		quietWriteInner(node, kind, payload);
	} finally {
		c.opDepth--;
	}
	arenaOpEpilogue();
}

function quietWriteInner(node: AtomNode, kind: WriteKind, payload: unknown): void {
	const c = core;
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
		next = kind === 0 /* WriteKind.SET */ ? payload : applyOp(node, kind, payload, prev);
		if (eqAtom(node, prev, next)) {
			return; // R-2 equality drop — once, kernel order (current, incoming)
		}
	}
	node.base = next;
	node.baseSeq = committedAdvance = ++seq; // advance the base + committed-advance clocks together (nextSeq, inlined)
	const tr = c.trace;
	if (tr !== undefined) tr.quietWrite(node, node.baseSeq);
	// Direct kernel apply: the plain write tail, no public-method re-entry
	// (policy checked, op folded, acceptance decided — R-2's "once").
	// Effects flushed by it re-enter the public write path and classify
	// normally (R-3). `node.id` IS the kernel record id (never through the
	// handle slot — reclamation keeps it weak for resolved nodes).
	writeNewest(node.id, next);
	// NF2 S-A flip site (d): quiet fold — after the base/committedAdvance advance,
	// before quietDrain and the sub scan (§4.1.2; the rootToArena.size
	// check is the one scalar branch PR1's ledger documents).
	fanAtomsToCommittedArenas(oneAtomBuf(node));
	if (watchers.size !== 0) c.quietDrain();
	// A quiet fold moves committed truth for every root — an EF2 boundary
	// (quiet ⇔ no open renders, so no frame can defer the re-check).
	if (c.committedSubCount !== 0) revalidateCommittedSubs(undefined);
	for (const a of rootToArena.values()) arenaDecay(a); // NF2 S-A boundary decay
	if (notifyState.n !== 0) notifyOps.flushNotify();
}

/** A write belongs to the batch context it executes in; a bare write has
 * none, so it joins the ambient default batch — unless the engine is
 * QUIET, in which case the write folds directly (no ambient batch is
 * created while nothing is pending). */
export function bareWrite(node: AtomNode, kind: WriteKind, payload: unknown): void {
	if (quiet) {
		quietWrite(node, kind, payload);
		return;
	}
	const ambientId = batchOps.ambient();
	let ambient = ambientId === undefined ? undefined : idToBatch.get(ambientId);
	if (ambient === undefined || ambient.state !== 'live') {
		ambient = batchOps.openBatch({ ambient: true });
		batchOps.setAmbient(ambient.id);
	}
	// The post-await dev-warning heuristic lives driver-side only
	// (cosignal-react's currentBatch) — the engine stays lint-free.
	writeInBatch(ambient.id, node, kind, payload);
}

// (endOp — the compound-operation tail every public exit owes — lives in
// settlement.ts with the operation epilogue; aliased above.)

/**
 * The write path (the referee/protocol surface: an explicit batch id, or
 * undefined for the context-free arm). Logged steps, in order: classify
 * (caller) → drop check → intern slot → append packed log entry + write
 * clock → member-slot fanout → apply to the kernel with stepwise equality
 * → arena delivery walk → newest-subscription flush after the walk returns.
 */
export function writeInBatch(batchId: BatchId | undefined, node: AtomNode, kind: WriteKind, payload: unknown): void {
	const c = core; // one load; the frame guards/depth below stay one-property reads
	if (c.evalDepth > 0) throw new ScheduleError('signal write during a world evaluation / render — write from an event handler or effect instead');
	if (c.inFoldCallback) throw new ScheduleError('signal write inside an updater/reducer fold — updaters and reducers must be pure');
	if (node.kind !== 'atom') throw new ScheduleError('writes target atoms');
	// NF2 S-A: public-operation frame — settlements landing anywhere
	// inside (walks, effect bodies, notify callbacks) enqueue and the
	// epilogue drains to empty (§4.5.4's fixed point).
	c.opDepth++;
	try {
		writeInner(batchId, node, kind, payload);
	} finally {
		c.opDepth--;
	}
	arenaOpEpilogue();
}

function writeInner(batchId: BatchId | undefined, node: AtomNode, kind: WriteKind, payload: unknown): void {
	if (batchId === undefined) {
		bareWrite(node, kind, payload);
		return;
	}
	// Windowed writes hit one batch repeatedly — one compare beats a Map probe.
	let batch: Batch;
	if (batchId === lastBatchId && lastBatchRef !== undefined) {
		batch = lastBatchRef;
	} else {
		batch = batchOps.batchById(batchId);
		lastBatchId = batchId;
		lastBatchRef = batch;
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
				const tr = core.trace;
				if (tr !== undefined) tr.writeDropped(node, batchId);
				endOp();
				return;
			}
		} else {
			const evaluated = applyOp(node, kind, payload, node.base);
			if (eqAtom(node, node.base, evaluated)) {
				// R-2 equality drop — kernel order (current, incoming), once at
				// the acceptance decision.
				const tr = core.trace;
				if (tr !== undefined) tr.writeDropped(node, batchId);
				endOp();
				return;
			}
		}
	}

	// Intern slot, append log entry, bump the slot write clock.
	const slot = batch.slot !== undefined ? slots[batch.slot]! : batchOps.internSlot(batch);
	const writeSeq = nextSeq();
	log.push(kind, slot.id, writeSeq, batch.id, payload);
	batch.lastWriteSeq = writeSeq;
	batch.liveLogEntries++;
	if (node.lastTouchBatch !== batch.id) {
		node.lastTouchBatch = batch.id;
		batch.atomsTouched.push(node);
	}
	if (log.n - log.start === 1) uncompactedAtoms.add(node);
	slot.writeClock = writeSeq;
	if (roots.size !== 0) {
		// A write into a committed-member slot moves committed truth NOW;
		// the next durable drain must reconcile its cone.
		const bit0 = 1 << slot.id;
		for (const r of roots.values()) {
			if ((r.committedBits & bit0) !== 0) {
				r.committedDirtySlots |= bit0;
				// NF2 S-A flip site (c): committed-member write — fan the ONE
				// written atom into the member root's arena. Marks only; the
				// effect scan stays at the next boundary (EF2 as amended, §4.0).
				const ra = rootToArena.get(r.id);
				if (ra !== undefined) fanAtomsToArena(ra, oneAtomBuf(node), false);
			}
		}
	}
	{
		// ONE write record: the logEntry hook carries node/op/batch/slot/seq
		// (the old object channel's separate 'write' event was the same
		// instant with less information — sites report once now).
		const tr = core.trace;
		if (tr !== undefined) tr.logEntry(node, log.entryAt(log.n - 1));
	}

	// Apply to the kernel eagerly with stepwise equality, so the newest
	// world stays directly readable off the kernel arena. R-3: the direct
	// apply's effect flush re-enters the public write path, so writes made
	// by core effects during this apply CLASSIFY NORMALLY (the old
	// recursion guard silently bypassed recording — a fixed bug).
	if (kind === 0 /* WriteKind.SET */ && node.eqIsDefault) {
		// Fast arm — bench-pinned, do not fold into the general arm
		// (spkw A/B, 2026-07: folding the two write-path fast arms
		// into their eqAtom general arms cost +11% bare / +3-6%
		// chain3+watch1 per logged write). A plain set with default
		// equality applies unconditionally: the kernel's own
		// store-compare gates propagation, which beats paying
		// kernelValueOf + Object.is up front on every EFFECTIVE write.
		writeNewest(node.id, payload);
	} else {
		const prevNewest = E.read(node.id);
		const nextNewest = applyOp(node, kind, payload, prevNewest);
		if (!eqAtom(node, prevNewest, nextNewest)) {
			// R-2 order: (current, incoming) — the eager-advance site.
			writeNewest(node.id, nextNewest);
		}
	}

	// The value-blind delivery walk (arena strong links), synchronously in
	// the writer's stack. (Core effect()s are kernel subscribers: the
	// eager kernel apply above already flushed them.)
	deliveryWalk(node, batch, slot, writeSeq);
	endOp();
}

/**
 * Referee seam for core `effect()` runs. Core effects are REAL kernel
 * effects (tests/helpers.ts `mountEngineCoreEffect` over the public
 * `effect()`), flushed by the eager kernel apply itself — the engine
 * holds no record of them. Their wrappers report each value-gated run
 * here so core-effect-run records land in the one packed stream with
 * its causality register. Sibling firing order under one operation is
 * implementation-defined (kernel subscriber-link order); values and the
 * operation each run fires at are the contract.
 */
export function logCoreEffectRun(name: string, value: Value): void {
	const tr = core.trace;
	if (tr !== undefined) tr.coreEffectRun(name, value);
}

// ------------------------------------------------------ render lifecycle
// The whole render lifecycle — renderStart/renderYield/renderResume, the
// watcher mount/defer/reveal/re-render/removal family, the commit fan
// (renderEnd + reclaim + deferred releases + the re-staled populator),
// per-root commit lock-in, and mount fixup with its dependency-closure
// walks — lives in RenderPass.ts; the public functions below are thin
// delegates over its operation table.

/** Open a render pass (see RenderPass.ts renderStart). */
export function renderStart(rootId: RootId, includeBatches: BatchId[]): RenderPass {
	return renderOps.renderStart(rootId, includeBatches);
}

/** Yield/resume edges: while yielded, code that runs in the gap (event
 * handlers, other renders) is "not in render" for this render. */
export function renderYield(id: RenderPassId): void {
	renderOps.renderYield(id);
}

export function renderResume(id: RenderPassId): void {
	renderOps.renderResume(id);
}

/** Mount a new watcher inside an open render; it renders in the render's world. */
export function mountWatcher(renderPassId: RenderPassId, node: AnyNode, name: string): Watcher {
	return renderOps.mountWatcher(renderPassId, node, name);
}

/** Reveal-shaped mounts (React's Offscreen/Activity — see RenderPass.ts). */
export function deferMountEffects(watcherId: WatcherId): void {
	renderOps.deferMountEffects(watcherId);
}

export function adoptRevealedMount(renderPassId: RenderPassId, watcherId: WatcherId): void {
	renderOps.adoptRevealedMount(renderPassId, watcherId);
}

/** An existing live watcher re-rendered by a render (see RenderPass.ts). */
export function renderWatcher(renderPassId: RenderPassId, watcherId: WatcherId): void {
	renderOps.renderWatcher(renderPassId, watcherId);
}

/** Full watcher removal — the bindings' unsubscribe surface (see RenderPass.ts). */
export function removeWatcher(watcherId: WatcherId): void {
	renderOps.removeWatcher(watcherId);
}

/**
 * Per-root commit lock-in — THE single owner of a root's committed-state
 * transition (RenderPass.ts commitBatches; the bindings' root-commit
 * report handler calls this public form). Returns whether any batch was
 * newly locked in.
 */
export function commitBatches(rootId: RootId, batches: Iterable<BatchId>): boolean {
	return renderOps.commitBatches(rootId, batches);
}

/**
 * End a render (RenderPass.ts renderEnd — the commit fan's ordering
 * story lives there).
 */
export function renderEnd(id: RenderPassId, kind: 'commit' | 'discard', opts?: { retireAtCommit?: BatchId[] }): void {
	renderOps.renderEnd(id, kind, opts);
}

// ---------------------------------------------------------- retirement
// Retirement — the batch's terminal transition and its cross-module fan
// (stamp → compact → fan → drain → clear-membership → release) — lives in
// Batch.ts with the rest of the batch lifecycle; these delegates are the
// public/protocol surface.

/** Retirement fires exactly once per batch; parked async actions retire
 * only at settlement (see Batch.ts retire). */
export function retire(batchId: BatchId): void {
	batchOps.retire(batchId);
}

/** The async action's promise settled; the protocol host then retires the
 * batch (see Batch.ts settleAction). */
export function settleAction(batchId: BatchId): void {
	batchOps.settleAction(batchId);
}

/** Transitive dependency closure feeding a node (RenderPass.ts — the
 * triple walk; public referee/diagnostics surface). */
export function dependencyClosureOf(nodeId: NodeId, render?: RenderPass): Set<NodeId> {
	return renderOps.dependencyClosureOf(nodeId, render);
}

// ------------------------------------------- episodes and quiescence

/** Synchronously abandons every work-in-progress render. */
export function discardAllWip(): void {
	for (const p of [...rootToOpenRender.values()]) {
		renderEnd(p.id, 'discard');
	}
}

export function quiescent(): boolean {
	return batchOps.liveBatchCount() === 0 && rootToOpenRender.size === 0;
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
export function quiesce(): void {
	if (!quiescent()) throw new ScheduleError('quiescence requires no live batches, pins, or parked actions');
	// Residue check: with no live pins, the last retirement compacted every write log.
	for (const n of idToNode.values()) {
		if (n.kind === 'atom' && n.log.n > n.log.start) {
			throw new InvariantViolation(`quiescence residue: atom ${n.name} still holds ${n.log.n - n.log.start} log entries`);
		}
	}
	epoch++;
	// Dead-episode records drop at the reset: nothing from a dead
	// episode can validate in a live one; serial counters stay monotone.
	for (const [id, p] of idToRenderPass) {
		if (p.state === 'ended') idToRenderPass.delete(id);
	}
	for (const [id, t] of idToBatch) {
		if (t.state === 'retired') idToBatch.delete(id);
	}
	lastBatchId = 0;
	lastBatchRef = undefined;
	// (No newest-side reset since S-C: kernel caches persist — nothing
	// newest-visible changes at quiescence.)
	// Arena duties (§4.5.8 then §4.5.7): reclamation sweep, then the
	// read-clock renumber over surviving consumer-populated arenas.
	arenaQuiesceSweep();
	// Dead-episode bookkeeping zeroes (bulk-zero at episode reset).
	for (const s of slots) {
		s.writeClock = 0;
		s.claimSeq = 0;
		s.releasePending = false;
	}
	for (const w of watchers.values()) w.dedupBits = 0;
	{
		const tr = core.trace;
		if (tr !== undefined) tr.epochReset(epoch);
	}
	eng.recomputeQuiet(); // quiescent by definition; re-derive from the new episode's state
	endOp();
	arenaOpEpilogue();
}

// ------------------------------------------------------------ world reads

/** The value of a node in a named world (adapter/test surface). */
export function readWorldValue(node: AnyNode, world: World): Value {
	return evaluate(node, world);
}

export function committedValue(node: AnyNode, root: RootId): Value {
	return evaluate(node, { kind: 'committed', root });
}

export function newestValue(node: AnyNode): Value {
	return evaluate(node, NEWEST);
}

export function renderValue(node: AnyNode, render: RenderPass): Value {
	return evaluate(node, { kind: 'render', render });
}

// ------------------------------------------------- the engine reset (R-6)

/**
 * Idle preconditions for `__resetEngineForTest`: a reset from inside any
 * open frame or half-finished operation must fail THIS test loudly, not
 * corrupt the next one. Asserted, in order: quiescent (no live batches —
 * parked actions included — and no open renders); no public operation, no
 * evaluation frame, no fold callback on the stack; no open capture frame;
 * no arena evaluation frame (serve override / sink); no notify flush or
 * settlement drain in progress; kernel frames closed (enterDepth) and the
 * kernel's synchronous batch()/effect queue empty.
 */
function assertIdleForReset(): void {
	if (!quiescent()) throw new ScheduleError('__resetEngineForTest requires quiescence: no live batches (parked actions included) and no open renders');
	if (core.opDepth !== 0) throw new ScheduleError('__resetEngineForTest inside a public operation (opDepth !== 0)');
	if (core.evalDepth !== 0) throw new ScheduleError('__resetEngineForTest inside a world evaluation (evalDepth !== 0)');
	if (core.inFoldCallback) throw new ScheduleError('__resetEngineForTest inside an updater/reducer/equality callback');
	if (core.captureFrame !== undefined) throw new ScheduleError('__resetEngineForTest inside an open capture frame');
	if (core.serveOverride !== undefined) throw new ScheduleError('__resetEngineForTest inside an arena evaluation frame');
	if (core.currentSink !== 0) throw new ScheduleError('__resetEngineForTest inside a fold-through evaluation frame');
	if (core.suspendDepth !== 0) throw new ScheduleError('__resetEngineForTest inside a hook-initiated (suspending) evaluation');
	if (notifyState.flushing) throw new ScheduleError('__resetEngineForTest inside a notification flush');
	if (notifyState.n !== 0) throw new ScheduleError('__resetEngineForTest with queued notifications undelivered');
	// (A settlement drain in progress holds opDepth > 0 — covered above.
	// Queued-but-undrained settlements are legal: the queue dies with the
	// composition and the scheduled microtask is engine-epoch guarded.)
}

/**
 * THE ENGINE RESET (test-only; great-refactor R-6) — the fresh-engine
 * analog that replaced per-test bridge construction. Order:
 *
 *  1. assertIdle (above) — preconditions, loudly.
 *  2. the driver's protocol reset FIRST (protocol v2's hook): the host's
 *     lane registry drops its full slot tenancy before the engine the ids
 *     point into disappears; then the driver slot clears.
 *  3. the kernel scrub (graph.ts __resetKernelForTest): watermark-bounded
 *     memory scrub — never a reallocation — allocator heads, counters,
 *     queued/pendingFree, VALUES/FNS side columns, walk scratch,
 *     desiredRecords; bumps THE ENGINE EPOCH (all cross-reset microtasks —
 *     settle drain, lifecycle flush, thenable settle-invalidate/rethrow —
 *     are epoch-guarded and go inert).
 *  4. the policy scrub (index.ts): configure() state, the lifecycle map,
 *     queue, and its scheduled flush.
 *  5. the suspense scrub: the id-keyed ctx.use request caches.
 *  6. probes to zero (the zero-cost referee re-baselines per test).
 *  7. `composeEngine(options)` — EVERY mechanism factory re-runs (§3.2);
 *     trace detaches (the fresh core's slot is undefined), checker state
 *     disarms, devChecks/arenaInitInts land as reset parameters, and the
 *     driver slot is empty (attach again after the reset).
 *
 * BatchIds are MONOTONIC ACROSS RESETS (Batch.ts's module-level counter
 * survives the recomposition): a host lane table can legally hold an id
 * across a reset, and monotonicity guarantees a stale id can never collide
 * with a post-reset batch.
 */
export function __resetEngineForTest(options?: EngineResetOptions): void {
	assertIdleForReset();
	const d = driver;
	if (d !== undefined && d.protocolReset !== undefined) d.protocolReset();
	__resetKernelForTest(); // bumps the engine epoch; scrubs kernel state
	__resetPolicyForTest();
	__resetSuspenseForTest();
	probes.logEntries = 0;
	probes.batches = 0;
	probes.worldEvals = 0;
	probes.bridges = 0;
	composeEngine(options);
}

// ---------------------------------------------------- the engine surface

/**
 * THE ENGINE SURFACE — the module's operational API grouped as one record
 * (the kernel's own op-table pattern): every function field is the module
 * function above, every accessor reads the CURRENT composition's state, so
 * the record stays valid across `__resetEngineForTest`. The lockstep
 * harness, the referee tooling, and the React bindings all drive this one
 * object; nothing constructs engines.
 */
export const engine = {
	// creation + resolution
	atom,
	computed,
	nodeForAtom,
	nodeForComputed,
	disposeComputed,
	nodeById,
	root,
	// batches + writes
	openBatch,
	liveBatches,
	write: writeInBatch,
	bareWrite,
	quietWrite,
	retire,
	settleAction,
	// renders + watchers
	renderStart,
	renderYield,
	renderResume,
	renderEnd,
	mountWatcher,
	renderWatcher,
	deferMountEffects,
	adoptRevealedMount,
	removeWatcher,
	commitBatches,
	dependencyClosureOf,
	// subscriptions (composition-owned tables; late-bound via arrows)
	mountCommittedObserver: (rootId: RootId, name: string, refire?: () => void): Subscription => mountCommittedObserver(rootId, name, refire),
	captureRun: (id: EffectId, body: () => void): void => captureRun(id, body),
	captureRead: (node: AnyNode): Value => captureRead(node),
	removeSubscription: (id: EffectId): void => removeSubscription(id),
	replayReactEffect: (id: EffectId): void => replayReactEffect(id),
	// episodes + reads
	discardAllWip,
	quiescent,
	quiesce,
	read: readWorldValue,
	committedValue,
	newestValue,
	renderValue,
	evaluate: (node: AnyNode, world: World): Value => evaluate(node, world),
	foldAtom: (node: AtomNode, world: World): Value => foldAtomOp(node, world),
	logCoreEffectRun,
	// referee seams
	__coreProbes,
	__checkerInternals,
	__arenaForTest,
	__arenaPoolForTest,
	__bumpNodeGenForTest,
	__arenaStats,
	__arenaLinkMode,
	__arenaLinkIdForTest,
	__arenaLinkNextDepForTest,
	__setSettleCapForTest,
	__columnsForTest,
	/** @internal bytecode-smoke seams (the smoke must exercise budgeted arena
	 * walk families directly; production never calls these). */
	__eachArenaForTest: (fn: (a: WorldArena) => void): void => eachArena(fn),
	__fanAtomsToArenaForTest: (a: WorldArena, atoms: AtomNode[], fromSettlement: boolean): void => fanAtomsToArena(a, atoms, fromSettlement),
	__arenaServeForTest: (a: WorldArena, node: AnyNode): Value => core.arenaServe(a, node),
	// state (current composition; identity changes at reset)
	get idToNode(): Map<NodeId, AnyNode> {
		return idToNode;
	},
	get idToBatch(): Map<BatchId, Batch> {
		return idToBatch;
	},
	get slots(): BatchSlotMeta[] {
		return slots;
	},
	get idToRenderPass(): Map<RenderPassId, RenderPass> {
		return idToRenderPass;
	},
	get roots(): Map<RootId, RootState> {
		return roots;
	},
	get watchers(): Map<WatcherId, Watcher> {
		return watchers;
	},
	get idToSubscription(): Map<EffectId, Subscription> {
		return idToSubscription;
	},
	get seq(): Seq {
		return seq;
	},
	get committedAdvance(): Seq {
		return committedAdvance;
	},
	get epoch(): Epoch {
		return epoch;
	},
	get quiet(): boolean {
		return quiet;
	},
	get devChecks(): boolean {
		return devChecks;
	},
	get ambientBatch(): BatchId | undefined {
		return batchOps.ambient();
	},
	get inFoldCallback(): boolean {
		return core.inFoldCallback;
	},
	get activeWorld(): World | undefined {
		return core.activeWorld;
	},
	set activeWorld(w: World | undefined) {
		core.setWorld(w);
	},
	get suspendDepth(): number {
		return core.suspendDepth;
	},
	set suspendDepth(n: number) {
		core.suspendDepth = n;
	},
	/** The trace recorder slot (attachTracer/Tracer.stop assign it). */
	get trace(): TraceHooks | undefined {
		return core.trace;
	},
	set trace(hooks: TraceHooks | undefined) {
		core.trace = hooks;
	},
	/** Optional compaction observer (referee/diagnostics seam — see the
	 * module-state declaration). */
	get onCompact(): ((atom: AtomNode, entry: WriteLogEntry) => void) | undefined {
		return onCompact;
	},
	set onCompact(fn: ((atom: AtomNode, entry: WriteLogEntry) => void) | undefined) {
		onCompact = fn;
	},
	// direct listeners (the bindings' consumption surface — attachDriver
	// assigns them too; these accessors are the referee/diagnostics face)
	get onDelivery(): ((w: Watcher, batch: Batch, slot: BatchSlot) => void) | undefined {
		return core.onDelivery;
	},
	set onDelivery(fn: ((w: Watcher, batch: Batch, slot: BatchSlot) => void) | undefined) {
		core.onDelivery = fn;
	},
	get onMountCorrective(): ((w: Watcher, batch: Batch, slot: BatchSlot) => void) | undefined {
		return core.onMountCorrective;
	},
	set onMountCorrective(fn: ((w: Watcher, batch: Batch, slot: BatchSlot) => void) | undefined) {
		core.onMountCorrective = fn;
	},
	get onCorrection(): ((w: Watcher) => void) | undefined {
		return core.onCorrection;
	},
	set onCorrection(fn: ((w: Watcher) => void) | undefined) {
		core.onCorrection = fn;
	},
	/** Referee surface — the recorded dependency edges as dep → dependents
	 * (the union of every live arena's links; read by graphviz/twin/soak). */
	get dependencyEdges(): Map<NodeId, Set<NodeId>> {
		return core.dependencyEdges();
	},
	/** Stale-watcher loud skips (the P1 aliasing pin). @internal */
	get __staleWatcherSkips(): number {
		return renderOps.staleWatcherSkips();
	},
};

/** The engine surface's type (the referee tooling's parameter shape). */
export type CosignalEngine = typeof engine;

// One Core: this module is internal machinery of the single `cosignal`
// entry (src/index.ts imports and re-exports it). It adds `attachDriver`,
// the engine surface, and the engine-surface types to the base API.
