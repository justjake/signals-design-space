/**
 * The naive reference model ("oracle") for the cosignals package's concurrent semantics.
 *
 * The behavioral contract it implements is stated in prose in README.md;
 * every rule here carries its rationale in a comment at the point it is
 * enforced.
 *
 * Authority comes from SIMPLICITY: plain objects, no cleverness, and no
 * caches except the one the untracked-read contract itself requires
 * (`ComputedNode.newestSample` — a point-in-time sample taken in the past
 * cannot be recomputed from present state, so it must be remembered).
 * Worlds (self-consistent views of all atom values) are pure folds — a fold
 * replays the log entries a world may see, in timeline order, over the atom's
 * base value (README vocabulary); computeds are memo-free recursive
 * evaluation in a given world; the React host is simulated as explicit
 * batch/render/retirement bookkeeping. Where the engine has optimizations
 * (dirty marking, memo tables, fast paths) the model simply recomputes
 * everything, so any engine behavior those optimizations change is a bug
 * in the engine, not in the model.
 */

export type Value = unknown
export type NodeId = number
export type BatchId = number
export type BatchSlot = number
export type RootId = string
export type RenderPassId = number
export type WatcherId = number
export type EffectId = number

/**
 * The write vocabulary: set/update. A reducer-style write records as an
 * update whose closure captures the reducer and the action.
 */
export type Op = { kind: 'set'; value: Value } | { kind: 'update'; fn: (prev: Value) => Value }

/**
 * A log entry records one write: {op, slot, seq} appended to the written
 * atom's write log. retiredSeq is stamped when the writing batch retires. The
 * batch is carried for invariant checking and event logs only: folds
 * resolve visibility through slot+seq alone, exactly as the contract's
 * visibility rules do — so the aliasing hazards of slot recycling (two
 * batches sharing a slot number across time) are exercised honestly
 * rather than papered over by batch identity.
 */
export type WriteLogEntry = {
	op: Op
	batch: BatchId
	slot: BatchSlot
	seq: number
	retiredSeq: number | undefined
}

export type Equals = (a: Value, b: Value) => boolean

export type AtomNode = {
	kind: 'atom'
	id: NodeId
	name: string
	/** The folded floor of the write log: committed history already compacted in. */
	base: Value
	baseSeq: number
	log: WriteLogEntry[]
	/**
	 * Full history for invariant 4 (log-entry retention soundness): compacted
	 * log entries move here, and quiet folds append their log-entry-shaped ledger
	 * entries here directly (see quietWrite — the fold IS already-retired
	 * history the moment it lands, and every write log is empty at that moment,
	 * so appending keeps the archive in sequence order).
	 */
	archive: WriteLogEntry[]
	/** The value the atom was created with (shadow-fold origin). */
	origin: Value
	equals: Equals
	/** Per-atom retirement stamp, created at every retirement that touched this atom. */
	retirementStamp: number
}

/** Reader passed to computed functions; tracked reads record dependency edges, untracked reads do not. */
export type Reader = (node: AnyNode) => Value
export type ComputedFn = (read: Reader, untracked: Reader) => Value

/**
 * One newest-world derivation of a computed: the direct TRACKED deps with
 * the values they had (the tracked fingerprint) and the derived value.
 */
export type NewestSample = { deps: { node: AnyNode; value: Value }[]; value: Value }

export type ComputedNode = {
	kind: 'computed'
	id: NodeId
	name: string
	/**
	 * Immutable for the node's whole life: pending worlds replay evaluation,
	 * so a swapped function would let one world see another closure's output.
	 * "Changing" a computed means creating a fresh node.
	 */
	fn: ComputedFn
	/**
	 * The newest world's SAMPLED-UNTRACKED computed cache [ruling 2026-07-06:
	 * untracked sampling] — this node's semantic state, so it lives on the
	 * node record. Newest values of computeds follow KERNEL semantics:
	 * a computed re-derives only when a TRACKED dependency's newest value
	 * changed; untracked reads are point-in-time samples taken at those
	 * re-derivations and never invalidate on their own (the base library's
	 * untracked contract, value face). The record holds the direct TRACKED
	 * deps of the last newest derivation with the values they had — the
	 * trackedFingerprint — and the derived value; validation re-checks each
	 * recorded dep's CURRENT sampled-newest value by identity, recursively
	 * (the kernel's checkDirty shape). Consulted ONLY by `newestValue` (and
	 * the newest-policy effect flush, which observes newest values): world
	 * folds are UNCHANGED — render/committed/mountFix evaluations refold at
	 * their boundaries per the existing contract, so untracked deps stay
	 * fresh in every world-side revalidation. Deliberately NOT cleared at
	 * quiescence: the staleness is a property of the value contract, not of
	 * the episode (the kernel's cache persists the same way).
	 */
	newestSample?: NewestSample
	/**
	 * Per-derivation cycle guard for the sampled evaluations: set while this
	 * node's sampled derivation frame is on the stack (evaluation is strictly
	 * nested, so a per-node bit states exactly what stack membership did).
	 */
	sampling?: boolean
}

export type AnyNode = AtomNode | ComputedNode

export type Batch = {
	id: BatchId
	/** Async action: the batch parks and retires only when the action settles. */
	action: boolean
	parked: boolean
	state: 'live' | 'retired'
	slot: BatchSlot | undefined
	retiredSeq: number | undefined
	/**
	 * Sequence of this batch's last log entry (0 = none) — the mount fixup's
	 * fast-path clock check reads it (the engine twin is the same scalar).
	 */
	lastWriteSeq: number
	/** True for the model's auto-created ambient default batch (home of context-free writes). */
	ambient: boolean
}

/**
 * One entry of the 31-slot batch identity table. Slots recycle: safety
 * rests on ordering (a claim is sequenced after the previous tenant's
 * retirement, so folds tell tenants apart by seq alone).
 */
export type BatchSlotMeta = {
	id: BatchSlot
	tenant: BatchId | undefined
	/** seq created at claim — the anchor of the tenant-ordering argument above. */
	claimSeq: number
	/** Write clock: seq of the slot's last write. Zeroed when a new tenant claims the slot. */
	writeClock: number
	/** Retirement done but release deferred because an open render's render mask names the slot. */
	releasePending: boolean
}

export type RenderPassState = 'open' | 'yielded' | 'ended'

export type RenderPass = {
	id: RenderPassId
	root: RootId
	/**
	 * The pin: the global sequence position frozen at render start and observed
	 * forever, across yields — a paused-and-resumed render must never see a
	 * write that landed during the pause (that would be a tear inside one render).
	 */
	pin: number
	/** Render mask: the live batches this render renders, captured at render start. */
	maskBatches: Set<BatchId>
	maskSlots: Set<BatchSlot>
	/** The root's committed-batch slot set, snapshotted at render start. */
	capturedCommittedSlots: Set<BatchSlot>
	state: RenderPassState
	endKind: 'commit' | 'discard' | undefined
	/**
	 * Watchers first mounted by this render (they subscribe + reconcile at its commit).
	 * Disjoint from `rendered`.
	 */
	mounted: WatcherId[]
	/**
	 * Existing watchers re-rendered by this render (lastRenderedValue updates at
	 * commit only) — re-renders ONLY, disjoint from `mounted`.
	 */
	rendered: Set<WatcherId>
}

export type RootState = {
	id: RootId
	/** Per-root commit ("lock-in") table: rows exist for live batches only (cleared at retirement). */
	committedBatches: Set<BatchId>
	/** Root commit generation; bumped at every per-root commit. */
	commitGen: number
}

/** The watcher's rendered-world snapshot: what its last committed render was allowed to see. */
export type WatcherSnapshot = {
	renderPassId: RenderPassId
	pin: number
	maskSlots: Set<BatchSlot>
	includedSlots: Set<BatchSlot>
	rootCommitGen: number
}

export type Watcher = {
	id: WatcherId
	name: string
	root: RootId
	node: NodeId
	/** Subscribed at its mounting render's commit (React: in the layout phase, before paint). */
	live: boolean
	lastRenderedValue: Value
	/**
	 * lastValidatedAt — the watched node's per-(root, node) accepted-change
	 * counter at the last moment the screen was known to agree with
	 * committed truth [SANCTIONED MODEL CO-EVOLUTION, owner ruling: observer
	 * re-fires are at-least-once]. Advances at a committed render whose
	 * rendered value matched committed-now, and at an urgent correction;
	 * 0 = never (a re-staled commit resets it, forcing the next drain's
	 * correction). Drains outside the committing render's own window gate on
	 * this stamp alone — counter movement means correct, no value
	 * comparison.
	 */
	lastSeen: number
	snapshot: WatcherSnapshot
	/** Per-(watcher, slot) delivery dedup bits — see deliver() for the suppression rule. */
	dedup: Set<BatchSlot>
}

/**
 * A useSignalEffect-shaped observer: a committed-for-root dep-snapshot
 * subscription (the promoted production mechanism — effects unification,
 * 2026-07-06). Side effects must track what the user actually sees; a
 * pending update may still be discarded. The BODY is the real thing being
 * modeled: each run re-reads under committed-for-root capture and re-chooses
 * its dependencies causally (a flag-flip body reads different atoms on
 * different runs); `deps` is the (node, value) snapshot of the last run, and
 * re-checks are value-gated over it. Re-check timing is RCC-EF2's amended
 * BOUNDARY semantics: once per boundary operation (per-root commit,
 * retirement, settlement), at the boundary value, never while the effect's
 * own root has an open render-pass frame (deferred to that frame's close);
 * cleanup runs before every re-fire and at removal, and nothing runs after
 * removal (RCC-OL2).
 */
export type ReactEffect = {
	id: EffectId
	name: string
	root: RootId
	/** The effect body: run under committed-for-root read capture. */
	body: (read: Reader) => void
	/**
	 * Dep snapshot: the last run's reads, in read order. `value` is a
	 * capture artifact (the run event's values array); `lastSeen` is the
	 * dep's lastValidatedAt — the per-(root, node) accepted-change counter
	 * at the read [sanctioned co-evolution: re-checks gate on counter
	 * movement since the read, never on values].
	 */
	deps: { node: AnyNode; value: Value; lastSeen: number }[]
	/** Convenience comparand (tests): the last captured value of the last run. */
	lastValue: Value
	runs: number
	cleanups: number
	/**
	 * [SANCTIONED CO-EVOLUTION: converged-terminal referee, review finding #8]
	 * A WRITING terminal (bug-2 shape): its body writes a sibling's dependency.
	 * Force-REPLAY (StrictMode double-invoke) of a writer is scoped out of the
	 * referee — see replayReactEffect.
	 */
	writes?: boolean
}

/**
 * A core effect() observer: it sees the newest world (every write applied).
 * A WRITING core effect (R-3 vocabulary) additionally writes its dedicated
 * effect-output atom on every value-gated run — the payload derives from
 * its own run count under an equality cutoff (min(runs, 3)), so each
 * trigger produces a bounded number of effective writes, then drops. The
 * output subset is DISJOINT: no core effect (and no corpus computed) reads
 * an effect-output atom, so the write fan is acyclic by construction.
 */
export type CoreEffect = {
	id: EffectId
	name: string
	node: NodeId
	lastValue: Value
	runs: number
	/** The effect-output atom this effect writes per run (writing effects only). */
	writeTo?: AtomNode
}

/** A world: one self-consistent assignment of values to all atoms. */
export type World =
	| { kind: 'newest' }
	| { kind: 'render'; render: RenderPass }
	| { kind: 'committed'; root: RootId }
	/**
	 * The mount reconciliation's fast-forwarded world: the mounting render's
	 * own included writes up to its pin, plus committed truth as of NOW
	 * (see mountFixup and tests/FLAGS.md).
	 */
	| { kind: 'mountFix'; maskSlots: Set<BatchSlot>; pin: number; root: RootId }

/** The observable surface — what an engine must reproduce (see the README's adapter contract). */
export type ModelEvent =
	| { type: 'write'; node: string; batch: BatchId; slot: BatchSlot; seq: number }
	| { type: 'write-dropped'; node: string; batch: BatchId }
	/**
	 * A quiet-mode fold: a bare write while nothing was pending folded
	 * straight into base — no batch, no log entry, no slot; `seq` is the
	 * fold's created sequence (the atom's new baseSeq and the committedAdvance clock).
	 */
	| { type: 'quiet-write'; node: string; seq: number }
	| {
			type: 'delivery'
			watcher: string
			batch: BatchId
			slot: BatchSlot
			seq: number
			mode: 'fresh' | 'interleaved'
	  }
	| { type: 'suppressed'; watcher: string; batch: BatchId; slot: BatchSlot; seq: number }
	| { type: 'core-effect-run'; effect: string; value: Value }
	| { type: 'react-effect-run'; effect: string; root: RootId; value: Value; values: Value[] }
	| { type: 'react-effect-cleanup'; effect: string; root: RootId }
	| {
			type: 'reconcile-correction'
			watcher: string
			root: RootId
			from: Value
			to: Value
			cause: 'retirement' | 'per-root-commit'
	  }
	| { type: 'mount-corrective'; watcher: string; batch: BatchId; slot: BatchSlot }
	| { type: 'mount-urgent-correction'; watcher: string; from: Value; to: Value }
	| { type: 'per-root-commit'; root: RootId; batch: BatchId }
	| { type: 'retired'; batch: BatchId; retiredSeq: number }
	| { type: 'slot-claimed'; slot: BatchSlot; batch: BatchId }
	| { type: 'slot-released'; slot: BatchSlot; batch: BatchId }
	| { type: 'slot-backstop-released'; slot: BatchSlot; batch: BatchId }
	| { type: 'render-committed'; renderPass: RenderPassId; root: RootId }
	| { type: 'render-discarded'; renderPass: RenderPassId; root: RootId }
	| { type: 'epoch-reset'; epoch: number }

/** An op the schedule proposed that is illegal in the current state (generator skips these). */
export class ScheduleError extends Error {}
/** A model self-check failed — always a bug (in the model or in the contract as stated). */
export class InvariantViolation extends Error {}

const SLOT_COUNT = 31 // At most 31 live batches — one per React priority lane (React tracks lanes as bits of a 31-bit mask).

/**
 * What the visibility rule reads from its host: the two set-valued lookups
 * the render and committed clauses are defined over. `CosignalModel` is its
 * own host (its `visible` method); an engine-side adapter that answers the
 * same two lookups can host the rule too, instead of restating it.
 */
export type VisibilityHost = {
	/** The render's included set: the batches it renders plus the root's committed set at its start. */
	includedSet(render: RenderPass): Set<BatchSlot>
	/** The root's CURRENT committed-slot set (live committed batches' slots). */
	committedSlotsNow(root: RootId): Set<BatchSlot>
}

/**
 * THE visibility rule: which log entries each kind of world replays.
 *
 * - RenderPass world, two clauses: (1) log entries whose batch retired at or
 *   before the render's pin — already permanent history when the render
 *   started; (2) log entries of included batches (rendered or already
 *   committed into the root at render start), up to the pin. The pin cap
 *   is what keeps a paused-and-resumed render from drifting.
 * - Committed-for-root: every retired log entry, plus log entries of batches
 *   currently committed into the root (membership) — a root must keep
 *   agreeing with UI it already committed, even before those batches
 *   retire globally.
 * - Newest: everything (the engine applies writes to its core eagerly).
 * - Mount reconciliation: the mounting render's own inclusions at its
 *   pin, plus committed truth as of NOW — the mount's view
 *   fast-forwarded to what actually committed during its mount window.
 *
 * Exported standalone so the rule has exactly one WriteLogEntry-shaped statement:
 * the model folds through it, and an engine's test-side model view may call
 * it directly rather than keeping a copy.
 */
export function visible(host: VisibilityHost, e: WriteLogEntry, world: World): boolean {
	switch (world.kind) {
		case 'newest':
			return true
		case 'render': {
			const w = world.render
			if (e.retiredSeq !== undefined && e.retiredSeq <= w.pin) {
				return true
			} // clause 1: retired by my pin
			return host.includedSet(w).has(e.slot) && e.seq <= w.pin // clause 2: included, up to my pin
		}
		case 'committed': {
			if (e.retiredSeq !== undefined) {
				return true
			} // committed truth at now
			return host.committedSlotsNow(world.root).has(e.slot) // membership
		}
		case 'mountFix': {
			if (world.maskSlots.has(e.slot) && e.seq <= world.pin) {
				return true
			} // the render's own inclusions, at its pin
			if (e.retiredSeq !== undefined) {
				return true
			} // committed truth at NOW
			return host.committedSlotsNow(world.root).has(e.slot) // the root's CURRENT committed set
		}
	}
}

export class CosignalModel {
	idToNode = new Map<NodeId, AnyNode>()
	idToBatch = new Map<BatchId, Batch>()
	slots: BatchSlotMeta[] = []
	idToRenderPass = new Map<RenderPassId, RenderPass>()
	roots = new Map<RootId, RootState>()
	watchers = new Map<WatcherId, Watcher>()
	reactEffects = new Map<EffectId, ReactEffect>()
	coreEffects = new Map<EffectId, CoreEffect>()
	events: ModelEvent[] = []

	/** The one global sequence line every log entry, pin, and stamp lives on. */
	seq = 0
	/** Committed-advance counter, in sequence units: seq of the last change to any committed view. */
	committedAdvance = 0
	/** Episode counter — bumped at quiescence, when all per-episode bookkeeping resets. */
	epoch = 0
	/**
	 * Dependency edges accumulated this episode, across ALL worlds (add-only;
	 * reset at quiescence). Notification reachability runs over this union —
	 * deliberately conservative: a dependency that exists in any world must
	 * notify, and over-notification costs a render, never correctness.
	 */
	episodeEdges = new Map<NodeId, Set<NodeId>>() // dep -> dependents

	/**
	 * Per-(root, node) committed fold cache with accepted-change counters
	 * [SANCTIONED MODEL CO-EVOLUTION, owner ruling: observer re-fires are
	 * at-least-once]. This is the model's twin of the engine's per-root
	 * committed clocks: a record holds the node's last committed-for-root
	 * fold outcome and a counter that moves exactly when a refresh derives a
	 * CHANGED outcome (identity over values and thrown payloads — the
	 * engine's refold gates; a first fold counts as changed). Refreshes run
	 * ONLY inside observer-machinery committed evaluations — the watcher
	 * drains and quiet scans, the effect boundary re-check, the effect
	 * capture, and the commit populator — which mirror the engine's lazy
	 * arena refold consults one-to-one at value-changing events: between
	 * boundaries committed folds are fixed, so plain reads move nothing on
	 * either side, and a refresh at an unchanged value is invisible.
	 * Deliberately NOT reset at quiescence (the engine's committed arenas
	 * and their clocks persist the same way).
	 */
	private committedFold = new Map<
		RootId,
		Map<NodeId, { threw: boolean; v: Value; counter: number }>
	>()

	/**
	 * Refresh one (root, node) committed fold cache row: evaluate
	 * committed-for-root, bump the counter iff the outcome changed. Returns
	 * the row (callers gate on `counter`; a thrown outcome is conveyed, not
	 * re-thrown — the model's committed evaluations do not throw today, and
	 * the engine mirror skips a throwing dep without gating).
	 */
	private refreshCommitted(
		rootId: RootId,
		node: AnyNode,
	): { threw: boolean; v: Value; counter: number } {
		let byNode = this.committedFold.get(rootId)
		if (byNode === undefined) {
			byNode = new Map()
			this.committedFold.set(rootId, byNode)
		}
		let v: Value
		try {
			v = this.evaluate(node, { kind: 'committed', root: rootId })
		} catch (err) {
			// A THROWING evaluation never settles the chain (the engine's
			// consult sites skip a throwing dep without touching its stamp or
			// register): convey the outcome, leave the cache untouched — the
			// settle transition back to a value decides against the
			// pre-throw register, so an unchanged round trip stays quiet.
			return { threw: true, v: err, counter: byNode.get(node.id)?.counter ?? 0 }
		}
		let rec = byNode.get(node.id)
		if (rec === undefined) {
			rec = { threw: false, v, counter: 1 } // a first fold counts as changed (the engine's never-consulted marker)
			byNode.set(node.id, rec)
		} else if (!Object.is(rec.v, v)) {
			rec.v = v
			rec.counter++
		}
		return rec
	}

	/**
	 * The render currently COMMITTING (the span of renderEnd's commit half):
	 * the watcher correction gate's cross-world discriminant — see
	 * drainCommittedObservers [sanctioned co-evolution].
	 */
	private committingRender: RenderPass | undefined

	/** Ambient default batch: the home of bare (context-free) writes. */
	ambientBatch: BatchId | undefined

	/**
	 * [SANCTIONED CO-EVOLUTION: converged-terminal referee, review finding #8]
	 * The committed SignalEffect terminal's boundary-deferred drain — the
	 * engine's quietBoundaryOwed / quietBoundaryActive / drainQuietBoundary
	 * twin (now-fixed semantics, wave 1). A quiet write marks committed truth,
	 * but the terminal re-check (and the watcher reconcile it rides with) must
	 * run at the OUTERMOST operation boundary — never inside a core-effect
	 * flush (coreFlushDepth > 0) or a running terminal body (activeReactEffect
	 * set). A naive inline re-run there would nest terminals ("runs do not
	 * nest", bug 2) or run a terminal inside the kernel effect frame where its
	 * routed reads record no dependency links (bug 1). The drain is owed and
	 * run now if we are at a true boundary, else the enclosing outermost quiet
	 * write drains it; the active-loop re-drains when a body write re-owes it,
	 * so a sibling terminal newly dirtied by that write runs at THIS boundary.
	 */
	private quietBoundaryOwed = false
	private quietBoundaryActive = false
	/**
	 * >0 while a core-effect flush is on stack (the kernel effect frame twin):
	 * a core body's nested quiet write owes the drain instead of running it.
	 */
	private coreFlushDepth = 0
	/**
	 * The terminal whose body is currently running (the engine's
	 * activeSignalEffect twin): a body's nested quiet write owes the drain.
	 */
	private activeReactEffect: ReactEffect | undefined
	/**
	 * Monotonic per-episode ordinal for the converged-terminal band's
	 * react-effect mounts. Terminals mounted at REST (quiet — no seq/event/epoch
	 * advance between two mounts) would otherwise share an `E${events}.${seq}.${epoch}`
	 * name; this ordinal disambiguates them, exactly as coreEffectMounts does
	 * for core effects. Ticked in lockstep with the engine adapter's twin
	 * (per terminal-band mount op, same order); never reset, so a multi-episode
	 * schedule keeps names unique across quiescence.
	 */
	terminalReactMounts = 0

	private nextNode = 1
	private nextBatchId = 1
	private nextRenderPassId = 1
	private nextWatcher = 1
	private nextEffect = 1
	/**
	 * Core-effect mount ordinal, appended to created names (`#k`) so every
	 * core effect's name is unique: sibling firing order under one operation
	 * is implementation-defined [owner ruling 2026-07-06], the lockstep
	 * differ compares same-step runs as a multiset sorted on (effect, value),
	 * and duplicate names would make that comparison ambiguous. Never reset
	 * (core effects survive quiescence); the engine twin's mount helper keeps
	 * the same counter, so lockstep-created names agree.
	 */
	private coreEffectMounts = 0

	/** Purity frames: >0 while a world evaluation or fold is on stack (writes then throw). */
	private evalDepth = 0
	/** True while inside an updater/reducer/equals callback (reads+writes throw). */
	private inFoldCallback = false

	constructor() {
		for (let i = 0; i < SLOT_COUNT; i++) {
			this.slots.push({
				id: i,
				tenant: undefined,
				claimSeq: 0,
				writeClock: 0,
				releasePending: false,
			})
		}
	}

	private log(e: ModelEvent): void {
		this.events.push(e)
	}

	private nextSeq(): number {
		return ++this.seq
	}

	// (There is no registration step: the model — like the engine — is live
	// from construction. ALWAYS-CONCURRENT: the old registered dimension,
	// its guards, and its quiet clause were deleted under the S5 oracle-edit
	// license.)

	atom(name: string, initial: Value, equals?: Equals): AtomNode {
		const node: AtomNode = {
			kind: 'atom',
			id: this.nextNode++,
			name,
			base: initial,
			baseSeq: 0,
			log: [],
			archive: [],
			origin: initial,
			equals: equals ?? Object.is,
			retirementStamp: 0,
		}
		this.idToNode.set(node.id, node)
		return node
	}

	computed(name: string, fn: ComputedFn): ComputedNode {
		const node: ComputedNode = { kind: 'computed', id: this.nextNode++, name, fn }
		this.idToNode.set(node.id, node)
		return node
	}

	root(id: RootId): RootState {
		let r = this.roots.get(id)
		if (r === undefined) {
			r = { id, committedBatches: new Set(), commitGen: 0 }
			this.roots.set(id, r)
		}
		return r
	}

	// ---------------------------------------------------- worlds and folds

	/** The render's included set: the batches it renders plus the root's committed set at its start. */
	includedSet(render: RenderPass): Set<BatchSlot> {
		return new Set([...render.maskSlots, ...render.capturedCommittedSlots])
	}

	/** The root's CURRENT committed-slot set (live committed batches' slots; retired batches' rows are cleared). */
	committedSlotsNow(rootId: RootId): Set<BatchSlot> {
		const out = new Set<BatchSlot>()
		for (const t of this.root(rootId).committedBatches) {
			const batch = this.idToBatch.get(t)
			if (batch !== undefined && batch.slot !== undefined) {
				out.add(batch.slot)
			}
		}
		return out
	}

	/** THE visibility rule (the exported `visible`, above), with this model as its host. */
	visible(e: WriteLogEntry, world: World): boolean {
		return visible(this, e, world)
	}

	/**
	 * Runs a user callback (updater/reducer/equals) under the fold-purity
	 * guard: signal reads and writes inside it throw. These callbacks replay
	 * per world; an impure one would make worlds disagree.
	 */
	private inCallback<T>(fn: () => T): T {
		const prev = this.inFoldCallback
		this.inFoldCallback = true
		try {
			return fn()
		} finally {
			this.inFoldCallback = prev
		}
	}

	private applyOp(atom: AtomNode, op: Op, prev: Value): Value {
		switch (op.kind) {
			case 'set':
				return op.value
			case 'update':
				// Reducer-style writes arrive here too: the closure carries
				// the reducer and the captured action.
				return this.inCallback(() => op.fn(prev))
		}
	}

	/**
	 * The fold: replay the world-visible log entries over the base in sequence
	 * order, applying the atom's equality stepwise (an equal step keeps the
	 * old reference, so equality cutoffs behave identically in every world).
	 */
	foldAtom(atom: AtomNode, world: World): Value {
		let value = atom.base
		for (const e of atom.log) {
			// write log is in seq order by construction
			if (!this.visible(e, world)) {
				continue
			}
			const next = this.applyOp(atom, e.op, value)
			// R-2 order: isEqual(current, incoming) — per replayed entry (folds
			// re-invoke per entry BY DESIGN; "once" is the acceptance decision).
			if (!this.inCallback(() => atom.equals(value, next))) {
				value = next
			}
		}
		return value
	}

	/** Retention-invariant helper: the same fold over the FULL history (archive + write log) from the origin value. */
	shadowFoldAtom(atom: AtomNode, world: World): Value {
		let value = atom.origin
		for (const e of [...atom.archive, ...atom.log]) {
			if (e.retiredSeq === undefined && !this.visible(e, world)) {
				continue
			}
			// Archived (compacted) entries are visible to every live world by the
			// compaction rule (they retired at or below every live pin) — assert via visible() too.
			if (!this.visible(e, world)) {
				continue
			}
			const next = this.applyOp(atom, e.op, value)
			// R-2 order: (current, incoming) — the shadow fold aligns in the same
			// commit as foldAtom (a lag breaks retention for asymmetric comparators).
			if (!this.inCallback(() => atom.equals(value, next))) {
				value = next
			}
		}
		return value
	}

	/**
	 * Memo-free recursive evaluation of a node in a world. Tracked reads
	 * record real dependency edges into the episode's union graph; untracked
	 * reads fold in-world but record no edge — untracked licenses missing a
	 * NOTIFICATION (temporal staleness), never reading another world's value
	 * (world leakage), and in a fold-everything model the in-world fold is
	 * the whole story. Writes during evaluation throw (render must be pure);
	 * a cycle within one world throws rather than looping.
	 */
	evaluate(node: AnyNode, world: World, stack?: Set<NodeId>): Value {
		if (this.inFoldCallback) {
			throw new ScheduleError(
				'signal read inside an updater/reducer fold — updaters and reducers must be pure; read what you need before dispatching',
			)
		}
		if (node.kind === 'atom') {
			return this.foldAtom(node, world)
		}
		const seen = stack ?? new Set<NodeId>()
		if (seen.has(node.id)) {
			throw new ScheduleError(
				`cyclic evaluation of ${node.name} within one world — a computed may not depend on itself`,
			)
		}
		seen.add(node.id)
		this.evalDepth++
		try {
			const read: Reader = (dep) => {
				this.recordEdge(dep.id, node.id)
				return this.evaluate(dep, world, seen)
			}
			const untracked: Reader = (dep) => this.evaluate(dep, world, seen)
			return node.fn(read, untracked)
		} finally {
			this.evalDepth--
			seen.delete(node.id)
		}
	}

	private recordEdge(dep: NodeId, dependent: NodeId): void {
		let outs = this.episodeEdges.get(dep)
		if (outs === undefined) {
			outs = new Set()
			this.episodeEdges.set(dep, outs)
		}
		outs.add(dependent)
	}

	/**
	 * Delivery reachability. A write must notify every watcher that depends
	 * on the written atom IN ANY WORLD — a dependency that exists only in a
	 * pending world (e.g. behind a flag the pending world flipped) still
	 * needs its notification, or the pending render goes stale forever. The
	 * naive form: evaluate every node in every currently relevant world
	 * (recording real edges), then take reachability over the episode's
	 * accumulated union. Deliberately conservative: over-notification costs
	 * a render that folds to an equal value, never a wrong value (pinned by
	 * acceptance scenario case 1 V2).
	 */
	private refreshEdgesAllWorlds(): void {
		const worlds: World[] = [{ kind: 'newest' }]
		for (const p of this.idToRenderPass.values()) {
			if (p.state !== 'ended') {
				worlds.push({ kind: 'render', render: p })
			}
		}
		for (const r of this.roots.keys()) {
			worlds.push({ kind: 'committed', root: r })
		}
		for (const n of this.idToNode.values()) {
			if (n.kind !== 'computed') {
				continue
			}
			for (const w of worlds) {
				this.evaluate(n, w)
			}
		}
	}

	/** Nodes reachable from `from` over the accumulated union graph (including `from`). */
	reachableFrom(from: NodeId): Set<NodeId> {
		const reached = new Set<NodeId>([from])
		const queue = [from]
		while (queue.length > 0) {
			const cur = queue.pop()!
			for (const next of this.episodeEdges.get(cur) ?? []) {
				if (!reached.has(next)) {
					reached.add(next)
					queue.push(next)
				}
			}
		}
		return reached
	}

	// -------------------------------------------------- batches and slots

	liveBatches(): Batch[] {
		return [...this.idToBatch.values()].filter((t) => t.state === 'live')
	}

	livePins(): number[] {
		const pins: number[] = []
		for (const p of this.idToRenderPass.values()) {
			if (p.state !== 'ended') pins.push(p.pin)
		}
		return pins
	}

	private minLivePin(): number {
		const pins = this.livePins()
		return pins.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...pins)
	}

	/**
	 * Create a batch. At most 31 live at once — one per React priority
	 * lane. (Lane priority itself stays React's: neither the model nor the
	 * engine ever consults it — the Priority dimension was deleted.)
	 */
	openBatch(opts?: { action?: boolean; ambient?: boolean }): Batch {
		if (this.liveBatches().length >= SLOT_COUNT) {
			throw new ScheduleError('at most 31 batches may be live at once (one per React lane)')
		}
		const batch: Batch = {
			id: this.nextBatchId++,
			action: opts?.action ?? false,
			parked: opts?.action ?? false, // action batches park until their async action settles
			state: 'live',
			slot: undefined,
			retiredSeq: undefined,
			lastWriteSeq: 0,
			ambient: opts?.ambient ?? false,
		}
		this.idToBatch.set(batch.id, batch)
		return batch
	}

	/**
	 * Look up an id or throw the schedule error every resolver shares (the
	 * same hygiene fix as the engine's mustGet — applied independently; the
	 * two implementations stay unshared by design).
	 */
	private mustGet<K, V>(map: Map<K, V>, id: K, what: string): V {
		const v = map.get(id)
		if (v === undefined) {
			throw new ScheduleError(`unknown ${what} ${id}`)
		}
		return v
	}

	private batchById(id: BatchId): Batch {
		return this.mustGet(this.idToBatch, id, 'batch')
	}

	nodeById(id: NodeId): AnyNode {
		return this.mustGet(this.idToNode, id, 'node')
	}

	/**
	 * A batch's first write interns its slot, claiming a free one. Claim
	 * housekeeping: the write clock zeroes and every per-(watcher, slot)
	 * dedup bit clears, so nothing from the previous tenant can suppress or
	 * satisfy the new tenant's deliveries; the retirement watermark carries
	 * forward across tenants within an episode (the model has no cached
	 * routing state to preserve — it recomputes routing) and zeroes at the
	 * episode reset.
	 */
	private internSlot(batch: Batch): BatchSlotMeta {
		if (batch.slot !== undefined) {
			return this.slots[batch.slot]
		}
		let free = this.slots.find((s) => s.tenant === undefined)
		if (free === undefined) {
			// Backstop: all 31 slots held ⇒ release the oldest retired-but-mask-retained slot anyway, loudly.
			// Safe because log entries keep their slot fields (see tests/FLAGS.md, flag 7).
			const candidates = this.slots.filter((s) => s.releasePending)
			if (candidates.length === 0) {
				throw new ScheduleError(
					'slot table full of live tenants — unreachable under the 31-live-batch guard',
				)
			}
			candidates.sort((a, b) => {
				const ra = this.batchById(a.tenant!).retiredSeq ?? 0
				const rb = this.batchById(b.tenant!).retiredSeq ?? 0
				return ra - rb
			})
			const victim = candidates[0]
			this.log({ type: 'slot-backstop-released', slot: victim.id, batch: victim.tenant! })
			this.releaseSlot(victim)
			free = victim
		}
		free.tenant = batch.id
		free.claimSeq = this.nextSeq() // tenancy ordering: every claim gets its own point on the line, after the previous tenant's retirement
		free.writeClock = 0
		free.releasePending = false
		batch.slot = free.id
		for (const w of this.watchers.values()) {
			w.dedup.delete(free.id)
		} // dedup bits clear at re-intern (stale bits must not suppress the new tenant)
		this.log({ type: 'slot-claimed', slot: free.id, batch: batch.id })
		return free
	}

	private releaseSlot(slot: BatchSlotMeta): void {
		const tenant = slot.tenant === undefined ? undefined : this.batchById(slot.tenant)
		if (tenant !== undefined) {
			tenant.slot = undefined // identity release only; log entries keep their denormalized slot field forever
			this.log({ type: 'slot-released', slot: slot.id, batch: tenant.id })
		}
		slot.tenant = undefined
		slot.releasePending = false
	}

	// ------------------------------------------------------ the write path

	/**
	 * The quiet state, derived on demand (the model recomputes everything;
	 * the engine keeps the same derivation as a recomputed boolean): zero
	 * live batches AND zero open renders AND every write log compacted.
	 * While quiet, a bare write is one direct fold — see quietWrite.
	 */
	private quietNow(): boolean {
		if (this.liveBatches().length > 0) {
			return false
		}
		if (this.livePins().length > 0) {
			return false
		}
		for (const n of this.idToNode.values()) {
			if (n.kind === 'atom' && n.log.length > 0) {
				return false
			}
		}
		return true
	}

	/**
	 * The quiet-mode fold (mirrors the engine's __quietWrite): while NOTHING
	 * is pending, a bare write folds directly into base — no batch, no
	 * log entry, no delivery walk. The op folds over base under the fold-purity
	 * guards, the same equality drop as the write path's empty-log drop
	 * applies (silently — there is no batch to attribute a drop to), and an
	 * accepted fold advances base, baseSeq, and the committed-advance clock
	 * together on one created sequence, then emits ONE 'quiet-write' event.
	 * Observers reconcile value-gated at the fold (it is a committed-truth
	 * boundary for every root): core effects flush over the refreshed union
	 * reachability, live watchers correct SILENTLY (the engine's quiet
	 * corrections create no event either), and committed effects re-check once,
	 * as at any boundary operation. The fold also appends a log-entry-shaped
	 * entry to the atom's ARCHIVE (retiredSeq = seq: the fold is permanent
	 * history the moment it lands) so invariant 4's full-history shadow fold
	 * keeps reconstructing every world; batch/slot carry the reserved 0/-1 —
	 * archived retired history resolves visibility through retiredSeq alone.
	 */
	private quietWrite(node: AtomNode, op: Op): void {
		if (this.evalDepth > 0) {
			throw new ScheduleError(
				'signal write during a world evaluation / render — write from an event handler or effect instead',
			)
		}
		if (this.inFoldCallback) {
			throw new ScheduleError(
				'signal write inside an updater/reducer fold — updaters and reducers must be pure',
			)
		}
		const prev = node.base
		const next = this.applyOp(node, op, prev)
		if (this.inCallback(() => node.equals(prev, next))) {
			return // R-2 equality drop — once, kernel order (current, incoming); the write log is empty by the quiet invariant
		}
		node.base = next
		node.baseSeq = this.committedAdvance = this.nextSeq()
		node.archive.push({ op, batch: 0, slot: -1, seq: node.baseSeq, retiredSeq: node.baseSeq })
		this.log({ type: 'quiet-write', node: node.name, seq: node.baseSeq })
		// Core effects observe the newest world, which the fold just advanced;
		// same union-reachability flush as the write path's. A writing core
		// body's nested quiet write owes the drain (coreFlushDepth > 0) rather
		// than running it inside that flush.
		this.refreshEdgesAllWorlds()
		this.flushCoreEffects(this.reachableFrom(node.id))
		// [SANCTIONED CO-EVOLUTION: converged-terminal referee, review finding
		// #8] The committed-world boundary drain (watcher reconcile + terminal
		// re-check) is owed. Run it now iff we are at a true operation boundary;
		// inside a core-effect flush or a terminal body it is a no-op, and the
		// enclosing outermost quiet write drains it once that frame closes.
		this.quietBoundaryOwed = true
		this.drainQuietBoundary()
	}

	/**
	 * [SANCTIONED CO-EVOLUTION: converged-terminal referee, review finding #8]
	 * Counter-gated watcher reconciliation against committed truth (which a
	 * quiet fold moved for every root) [correct on accepted-change-counter
	 * movement since the watcher's last validation, never on values]. Silent by
	 * exact mirroring: the engine's quiet corrections create no event.
	 */
	private reconcileWatchersToCommitted(): void {
		for (const w of this.watchers.values()) {
			if (!w.live) {
				continue
			}
			const rec = this.refreshCommitted(w.root, this.nodeById(w.node))
			if (rec.counter !== w.lastSeen) {
				w.lastSeen = rec.counter // the urgent correction validates
				w.lastRenderedValue = rec.v // the urgent pre-paint re-render
				w.dedup.clear() // dedup bits re-arm at the watcher's render
			}
		}
	}

	/**
	 * [SANCTIONED CO-EVOLUTION: converged-terminal referee, review finding #8]
	 * The owed quiet-pipeline boundary drain (the engine's drainQuietBoundary
	 * twin). Runs iff we are at a true operation boundary — outside every
	 * core-effect flush (coreFlushDepth 0) and terminal body (activeReactEffect
	 * undefined), where the terminal runner's committed reads record real
	 * dependency links. Inside such a frame it is a no-op; the outermost quiet
	 * write drains once the frame closes. The loop re-drains when a terminal
	 * body writes and re-owes it, so a sibling terminal newly dirtied by that
	 * write runs at THIS boundary rather than being dropped or nested.
	 */
	private drainQuietBoundary(): void {
		if (
			!this.quietBoundaryOwed ||
			this.quietBoundaryActive ||
			this.coreFlushDepth !== 0 ||
			this.activeReactEffect !== undefined
		) {
			return
		}
		this.quietBoundaryActive = true
		try {
			let guard = 0
			while (this.quietBoundaryOwed) {
				if (++guard > 10000) {
					throw new InvariantViolation(
						'quiet terminal drain exceeded 10000 iterations — a terminal body is synchronously re-triggering itself',
					)
				}
				this.quietBoundaryOwed = false
				this.reconcileWatchersToCommitted()
				// EF2 boundary: a quiet fold moves committed truth for every root
				// (quiet ⇔ no open renders, so no frame can defer the re-check).
				this.revalidateReactEffects()
			}
		} finally {
			this.quietBoundaryActive = false
		}
	}

	/**
	 * A write belongs to the batch context in which it executes; a bare
	 * (context-free) write goes to the ambient default batch — unless the
	 * model is QUIET, in which case the write folds directly (no ambient
	 * batch is created while nothing is pending). This is the same rule
	 * React's own transitions have — an async continuation runs on
	 * a fresh stack with no ambient transition context.
	 */
	bareWrite(node: AtomNode, op: Op): void {
		if (this.quietNow()) {
			this.quietWrite(node, op)
			return
		}
		let ambient =
			this.ambientBatch === undefined ? undefined : this.idToBatch.get(this.ambientBatch)
		if (ambient === undefined || ambient.state !== 'live') {
			ambient = this.openBatch({ ambient: true })
			this.ambientBatch = ambient.id
		}
		// The post-await dev-warning heuristic is adapter-only (cosignals-react's
		// shim) — the model, like the engine, emits no dev events.
		this.write(ambient.id, node, op)
	}

	/**
	 * The write path (an explicit batch id, or undefined for the
	 * context-free arm — quiet fold, else the ambient batch).
	 */
	write(batchId: BatchId | undefined, node: AtomNode, op: Op): void {
		if (this.evalDepth > 0) {
			throw new ScheduleError(
				'signal write during a world evaluation / render — write from an event handler or effect instead',
			)
		}
		if (this.inFoldCallback) {
			throw new ScheduleError(
				'signal write inside an updater/reducer fold — updaters and reducers must be pure',
			)
		}
		if (node.kind !== 'atom') {
			throw new ScheduleError('writes target atoms')
		}
		if (batchId === undefined) {
			this.bareWrite(node, op)
			return
		}
		const batch = this.batchById(batchId)
		if (batch.state !== 'live') {
			throw new ScheduleError(
				`write into retired batch ${batchId} — a retired batch accepts no new writes`,
			)
		}

		// Drop check — the ONLY legal equality drop: empty write log AND the op
		// evaluates equal against the base. With pending history present, a
		// "no-op" write could still change some world's fold, so it must append.
		if (node.log.length === 0) {
			const evaluated = this.applyOp(node, op, node.base)
			if (this.inCallback(() => node.equals(node.base, evaluated))) {
				this.log({ type: 'write-dropped', node: node.name, batch: batchId })
				return
			}
		}

		// The stepwise-equality gate of the engine's EAGER KERNEL APPLY: the
		// kernel stores + propagates a write only when it advances the atom's
		// newest fold, and core effect()s are kernel subscribers — so they
		// flush at exactly the newest-advancing writes (below), value-gated.
		const prevNewest = this.newestValue(node)
		const nextNewest = this.applyOp(node, op, prevNewest)
		const advancesNewest = !this.inCallback(() => node.equals(prevNewest, nextNewest)) // R-2 order: (current, incoming)

		// Record the write: intern the slot, append the log entry, bump the slot's write clock.
		const slot = this.internSlot(batch)
		const seq = this.nextSeq()
		node.log.push({ op, batch: batch.id, slot: slot.id, seq, retiredSeq: undefined })
		batch.lastWriteSeq = seq
		slot.writeClock = seq
		this.log({ type: 'write', node: node.name, batch: batch.id, slot: slot.id, seq })

		// Notify. The model recomputes the union dependency graph (edges are
		// recorded by evaluation) and reaches every affected watcher/effect.
		// Core effects flush BEFORE the delivery loop: in the engine the
		// kernel apply (which runs kernel effects) precedes the arena walk.
		this.refreshEdgesAllWorlds()
		const reached = this.reachableFrom(node.id)
		if (advancesNewest) {
			this.flushCoreEffects(reached)
		}
		for (const w of this.watchers.values()) {
			if (!w.live || !reached.has(w.node)) {
				continue
			}
			this.deliver(w, batch, slot, seq)
		}
	}

	/**
	 * Delivery — per write, value-blind, in the writer's stack; the watcher's
	 * re-render is scheduled into the WRITING batch's lane. Value-blind
	 * because whether a write changes a watcher's output depends on the world
	 * doing the asking; any single comparison at delivery time would compare
	 * across worlds. The per-(watcher, slot) dedup bit suppresses a repeat
	 * only when scheduled-but-unstarted work will fold the write; otherwise
	 * (a render already pinned before the write) the write is delivered as an
	 * interleaved update, because the running render cannot see it.
	 */
	private deliver(w: Watcher, batch: Batch, slot: BatchSlotMeta, seq: number): void {
		if (!w.dedup.has(slot.id)) {
			w.dedup.add(slot.id)
			this.log({
				type: 'delivery',
				watcher: w.name,
				batch: batch.id,
				slot: slot.id,
				seq,
				mode: 'fresh',
			})
			return
		}
		// Bit already set: suppress iff NO started-and-uncommitted render on W's
		// root renders this slot with a pin below the write's sequence — such
		// a render has already read past the write and will not fold it.
		let mustDeliver = false
		for (const p of this.idToRenderPass.values()) {
			if (p.state === 'ended') {
				continue
			} // "open" includes yielded and completed-but-uncommitted
			if (p.root !== w.root) {
				continue
			}
			if (p.maskSlots.has(slot.id) && p.pin < seq) {
				mustDeliver = true
				break
			}
		}
		if (mustDeliver) {
			this.log({
				type: 'delivery',
				watcher: w.name,
				batch: batch.id,
				slot: slot.id,
				seq,
				mode: 'interleaved',
			})
		} else {
			this.log({ type: 'suppressed', watcher: w.name, batch: batch.id, slot: slot.id, seq })
		}
	}

	/**
	 * Core effects observe the newest world — through `newestValue`, so the
	 * values they compare carry the sampled-untracked rule [ruling 2026-07-06]
	 * exactly as the engine's kernel-served flush does. They flush only when
	 * a write advances the atom's newest fold, before the delivery loop —
	 * mirroring the engine, where core effects are real kernel `effect()`s
	 * flushed by the eager kernel apply itself. Iteration is mount order;
	 * the ORDER of sibling runs under one operation is implementation-defined
	 * [owner ruling 2026-07-06] and the lockstep differ compares same-step
	 * runs as a multiset on (effect, value).
	 */
	private flushCoreEffects(reached?: Set<NodeId>): void {
		// [SANCTIONED CO-EVOLUTION: converged-terminal referee, review finding
		// #8] Mark the kernel-effect-frame twin: a writing core body's nested
		// quiet write owes the terminal drain rather than running it here (bug
		// 1 — a terminal must not run inside the core-effect flush).
		this.coreFlushDepth++
		try {
			for (const e of this.coreEffects.values()) {
				if (reached !== undefined && !reached.has(e.node)) {
					continue
				}
				const value = this.newestValue(this.nodeById(e.node))
				if (!Object.is(value, e.lastValue)) {
					e.lastValue = value
					e.runs++
					this.log({ type: 'core-effect-run', effect: e.name, value })
					// R-3: a writing core effect's write CLASSIFIES NORMALLY — it
					// takes the ordinary context-free arm (the ambient batch while
					// anything is pending, the quiet fold otherwise), exactly like
					// the engine's effect writes during the eager kernel apply.
					// Payload = min(runs, 3): the equality cutoff bounds effective
					// writes per trigger. A writer targeting an effect-output atom
					// (out1/out2) is acyclic; one targeting `sig` (the converged
					// terminal's dep) drives bug 1's re-check at the drain below.
					if (e.writeTo !== undefined) {
						this.bareWrite(e.writeTo, { kind: 'set', value: Math.min(e.runs, 3) })
					}
				}
			}
		} finally {
			this.coreFlushDepth--
		}
	}

	// ------------------------------------------------------ render lifecycle

	/**
	 * Open a render pass: the pin freezes at start, the render mask is
	 * captured from live batches, and the root's committed set is
	 * snapshotted. One work-in-progress render per root — a same-root restart
	 * is a NEW render at a fresh pin, which is how React picks up interleaved
	 * writes it could not fold mid-render.
	 */
	renderStart(rootId: RootId, includeBatches: BatchId[]): RenderPass {
		for (const p of this.idToRenderPass.values()) {
			if (p.state !== 'ended' && p.root === rootId) {
				throw new ScheduleError(
					`root ${rootId} already has an open render — one render pass per root at a time`,
				)
			}
		}
		const maskBatches = new Set<BatchId>()
		const maskSlots = new Set<BatchSlot>()
		for (const id of includeBatches) {
			const t = this.batchById(id)
			if (t.state !== 'live') {
				throw new ScheduleError(
					'mask captures live batches only — a retired batch is already permanent history',
				)
			}
			maskBatches.add(id)
			// A live batch with no slot never wrote; its later log entries postdate the
			// pin and are excluded by the pin cap anyway (claims are sequenced, so
			// any future slot's writes sit above this render's pin).
			if (t.slot !== undefined) {
				maskSlots.add(t.slot)
			}
		}
		const render: RenderPass = {
			id: this.nextRenderPassId++,
			root: rootId,
			pin: this.seq,
			maskBatches,
			maskSlots,
			capturedCommittedSlots: this.committedSlotsNow(rootId),
			state: 'open',
			endKind: undefined,
			mounted: [],
			rendered: new Set(),
		}
		this.idToRenderPass.set(render.id, render)
		return render
	}

	private renderPassById(id: RenderPassId): RenderPass {
		return this.mustGet(this.idToRenderPass, id, 'render pass')
	}

	/**
	 * Yield/resume edges of a render. Code running in the gap (event handlers,
	 * timers) is NOT "in render" — being in render is a property of the call
	 * stack, not of wall-clock time between a render's slices — so gap code
	 * reads the newest world and may write freely into its own batches.
	 */
	renderYield(id: RenderPassId): void {
		const p = this.renderPassById(id)
		if (p.state !== 'open') {
			throw new ScheduleError('yield requires an open (running) render')
		}
		p.state = 'yielded'
	}

	renderResume(id: RenderPassId): void {
		const p = this.renderPassById(id)
		if (p.state !== 'yielded') {
			throw new ScheduleError('resume requires a yielded render')
		}
		p.state = 'open'
	}

	/** Mount a new watcher inside an open render; its first render reads the render's world. */
	mountWatcher(renderPassId: RenderPassId, node: AnyNode, name: string): Watcher {
		const p = this.renderPassById(renderPassId)
		if (p.state === 'ended') {
			throw new ScheduleError('mount requires an open render')
		}
		const value = this.evaluate(node, { kind: 'render', render: p })
		const watcher: Watcher = {
			id: this.nextWatcher++,
			name,
			root: p.root,
			node: node.id,
			live: false, // subscribes at layout, i.e. at this render's commit
			lastRenderedValue: value,
			lastSeen: 0, // validated for the first time at its commit's populator
			snapshot: {
				renderPassId: p.id,
				pin: p.pin,
				maskSlots: new Set(p.maskSlots),
				includedSlots: this.includedSet(p),
				rootCommitGen: this.root(p.root).commitGen,
			},
			dedup: new Set(),
		}
		this.watchers.set(watcher.id, watcher)
		p.mounted.push(watcher.id) // mounts never join `rendered` (the collections are disjoint)
		return watcher
	}

	/**
	 * Reveal-shaped mounts (React Offscreen/Activity: a subtree is
	 * pre-rendered hidden, then revealed later): a watcher rendered by an
	 * older render whose layout effects fire inside a DIFFERENT render's commit.
	 * The adopting commit runs the reconciliation; the watcher's snapshot
	 * keeps its original rendered world, so the fast path's same-render
	 * condition fails and the conservative comparison runs — which is the
	 * point, since arbitrary time passed between render and reveal.
	 */
	/**
	 * The hidden half of a reveal: the mounting render commits but the watcher's
	 * layout effects (subscribe + reconcile) defer — an Offscreen/Activity subtree.
	 */
	deferMountEffects(watcherId: WatcherId): void {
		for (const p of this.idToRenderPass.values()) {
			const i = p.mounted.indexOf(watcherId)
			if (i >= 0) {
				p.mounted.splice(i, 1)
			}
		}
	}

	adoptRevealedMount(renderPassId: RenderPassId, watcherId: WatcherId): void {
		const adopter = this.renderPassById(renderPassId)
		if (adopter.state === 'ended') {
			throw new ScheduleError('adopting render must be open')
		}
		const w = this.mustGet(this.watchers, watcherId, 'watcher')
		if (w.root !== adopter.root) {
			throw new ScheduleError('reveal stays on the watcher root')
		}
		for (const p of this.idToRenderPass.values()) {
			const i = p.mounted.indexOf(watcherId)
			if (i >= 0) {
				p.mounted.splice(i, 1)
			}
		}
		adopter.mounted.push(watcherId)
	}

	/** An existing live watcher re-rendered by a render: its dedup bits re-arm at render. */
	renderWatcher(renderPassId: RenderPassId, watcherId: WatcherId): void {
		const p = this.renderPassById(renderPassId)
		if (p.state === 'ended') {
			throw new ScheduleError('render requires an open render')
		}
		const w = this.watchers.get(watcherId)
		if (w === undefined || !w.live) {
			throw new ScheduleError('render targets a live watcher')
		}
		if (w.root !== p.root) {
			throw new ScheduleError('watcher belongs to another root')
		}
		w.dedup.clear()
		p.rendered.add(watcherId)
	}

	/** Mount a useSignalEffect-shaped observer with a single-node body. */
	mountReactEffect(rootId: RootId, node: AnyNode, name: string): ReactEffect {
		return this.mountCommittedObserver(rootId, name, (read) => void read(node))
	}

	/**
	 * Mount a committed observer whose body re-chooses deps CAUSALLY: it
	 * reads `sel` and, on its truthiness, reads `a` or `b` — the dep-flip
	 * family where snapshot mechanisms rot (plan amendment 4).
	 */
	mountReactEffectPick(
		rootId: RootId,
		sel: AnyNode,
		a: AnyNode,
		b: AnyNode,
		name: string,
	): ReactEffect {
		return this.mountCommittedObserver(rootId, name, (read) => void (read(sel) ? read(a) : read(b)))
	}

	/**
	 * [SANCTIONED CO-EVOLUTION: converged-terminal referee, review finding #8]
	 * Mount a committed terminal whose BODY WRITES — it reads `readNode` and
	 * writes `writeAtom` a bounded payload (min(read, 3)). This is bug 2's
	 * shape: a terminal body writing a SIBLING terminal's dependency. The
	 * write must schedule the sibling's run at the boundary, never nest — the
	 * activeReactEffect guard defers it, and the drain loop runs the sibling
	 * once this body closes. The payload is bounded so the chain terminates
	 * (the writer never reads `writeAtom`, so it cannot re-trigger itself).
	 */
	mountReactEffectWrite(
		rootId: RootId,
		readNode: AnyNode,
		writeAtom: AtomNode,
		name: string,
	): ReactEffect {
		// The MOUNT run captures the dep but does NOT write (a silent baseline,
		// like the core effect's first run) — so a mount can never leak an owed
		// drain past its op. The body writes only on RE-FIRES, which is the
		// bug-2 path: a re-fire's write schedules the sibling at the boundary.
		let ran = false
		const e = this.mountCommittedObserver(rootId, name, (read) => {
			const v = read(readNode)
			if (!ran) {
				ran = true
				return
			}
			this.bareWrite(writeAtom, { kind: 'set', value: Math.min(v as number, 3) })
		})
		e.writes = true
		return e
	}

	/**
	 * The registration surface the constructors above configure. The initial
	 * run captures the first dep snapshot (runs stays 0 — the mount run is
	 * React's own effect invocation, not a re-fire).
	 */
	mountCommittedObserver(rootId: RootId, name: string, body: (read: Reader) => void): ReactEffect {
		if (this.evalDepth > 0 || this.inFoldCallback) {
			throw new ScheduleError('effect registration is illegal inside an open evaluation/fold frame')
		}
		const e: ReactEffect = {
			id: this.nextEffect++,
			name,
			root: rootId,
			body,
			deps: [],
			lastValue: undefined,
			runs: 0,
			cleanups: 0,
		}
		this.root(rootId)
		this.captureReactEffectRun(e)
		this.reactEffects.set(e.id, e)
		return e
	}

	/** Removal (unmount): cleanup is GUARANTEED; nothing runs after (RCC-OL2). */
	removeReactEffect(id: EffectId): void {
		const e = this.mustGet(this.reactEffects, id, 'react effect')
		e.cleanups++
		this.log({ type: 'react-effect-cleanup', effect: e.name, root: e.root })
		this.reactEffects.delete(id)
	}

	/**
	 * StrictMode-style replay: cleanup + unconditional re-run (not value-
	 * gated), recapturing deps. Illegal while the effect's root has an open
	 * render frame (React double-invokes effects post-commit, never mid-render).
	 */
	replayReactEffect(id: EffectId): void {
		const e = this.mustGet(this.reactEffects, id, 'react effect')
		// [SANCTIONED CO-EVOLUTION: converged-terminal referee, review finding
		// #8] A WRITING terminal under StrictMode force-replay is scoped OUT of
		// the referee (symmetric on both sides — the engine adapter skips the
		// same op). The engine's replay is a TEST surface (replaySignalEffect +
		// the readSignalEffectDep test read); combined with committed-arena
		// materialization it pollutes the run's trace-only `values` snapshot
		// with arena reads, while this naive model traces only real deps. It is
		// TRACE-ONLY — the terminal's dependency links stay clean (no spurious
		// re-fire), and the bug-2 body-write semantics are refereed on the
		// normal re-fire path (writeTap), not replay. See the final report.
		if (e.writes) {
			throw new ScheduleError(
				'writing terminals are not force-replayable in the referee (test-surface replay pollutes the trace-only values snapshot; scoped out)',
			)
		}
		for (const p of this.idToRenderPass.values()) {
			if (p.state !== 'ended' && p.root === e.root) {
				throw new ScheduleError('replay requires the effect root to have no open render frame')
			}
		}
		this.runReactEffect(e)
	}

	/**
	 * Runs the body under committed-for-root read capture; installs the new
	 * dep snapshot. Reads inside a computed's own evaluation belong to the
	 * computed, not the effect (suppression is by construction: only the
	 * body's TOP-LEVEL reads reach this reader).
	 */
	private captureReactEffectRun(e: ReactEffect): void {
		const deps: { node: AnyNode; value: Value; lastSeen: number }[] = []
		const read: Reader = (n) => {
			// The refresh IS the committed evaluation (one derivation per
			// read, exactly as before); the dep entry stamps the counter AT
			// THE READ — an effect body may write mid-run, and the boundary
			// re-check must still see that write as newer than the snapshot.
			const rec = this.refreshCommitted(e.root, n)
			deps.push({ node: n, value: rec.v, lastSeen: rec.counter })
			return rec.v
		}
		// [SANCTIONED CO-EVOLUTION: converged-terminal referee, review finding
		// #8] Mark the running terminal (the engine's activeSignalEffect twin):
		// a body write's nested quiet fold owes the boundary drain rather than
		// running a sibling terminal inline ("runs do not nest", bug 2).
		const savedActive = this.activeReactEffect
		this.activeReactEffect = e
		try {
			e.body(read)
		} finally {
			this.activeReactEffect = savedActive
			// A mid-body throw keeps the partial snapshot (the deps read before
			// the throw are real dependencies — same rule as the engine frame).
			e.deps = deps
			e.lastValue = deps.length === 0 ? undefined : deps[deps.length - 1].value
		}
	}

	/** Cleanup + re-run + recapture (the re-fire): logs both halves. */
	private runReactEffect(e: ReactEffect): void {
		e.cleanups++
		this.log({ type: 'react-effect-cleanup', effect: e.name, root: e.root })
		this.captureReactEffectRun(e)
		e.runs++
		this.log({
			type: 'react-effect-run',
			effect: e.name,
			root: e.root,
			value: e.lastValue,
			values: e.deps.map((d) => d.value),
		})
	}

	/**
	 * The EF2 boundary re-check: once per boundary OPERATION (never per
	 * locked-in batch — one render committing two batches re-checks once, at
	 * the boundary value), value-gated over each effect's dep snapshot,
	 * SKIPPING effects whose root has an open render frame (an effect never
	 * runs ahead of its own root's screen; the deferred flip flushes when
	 * that frame closes). Runs at the END of the boundary operation.
	 */
	private revalidateReactEffects(rootFilter?: RootId): void {
		for (const e of [...this.reactEffects.values()]) {
			if (rootFilter !== undefined && e.root !== rootFilter) {
				continue
			}
			let open = false
			for (const p of this.idToRenderPass.values()) {
				if (p.state !== 'ended' && p.root === e.root) {
					open = true
					break
				}
			}
			if (open) {
				continue
			} // deferred to the frame's close
			let changed = false
			for (const d of e.deps) {
				// At-least-once [sanctioned co-evolution]: re-fire iff the
				// dep's accepted-change counter moved since the read that
				// captured it — no value comparison. A thrown outcome is
				// conveyed, never gated (the engine mirror skips a
				// still-pending suspension without touching its stamp).
				const rec = this.refreshCommitted(e.root, d.node)
				if (rec.threw) {
					continue
				}
				if (rec.counter !== d.lastSeen) {
					changed = true
					break
				}
			}
			if (changed) {
				this.runReactEffect(e)
			}
		}
	}

	/**
	 * Mount a core effect() observer: it reads the newest world (sampled —
	 * the same value face `newestValue` serves). The mount evaluation is the
	 * silent baseline; names take the per-mount ordinal suffix (see
	 * `coreEffectMounts`).
	 */
	mountCoreEffect(node: AnyNode, name: string, writeTo?: AtomNode): CoreEffect {
		const e: CoreEffect = {
			id: this.nextEffect++,
			name: `${name}#${this.coreEffectMounts++}`,
			node: node.id,
			lastValue: this.newestValue(node),
			runs: 0,
		}
		if (writeTo !== undefined) {
			e.writeTo = writeTo
		}
		this.coreEffects.set(e.id, e)
		return e
	}

	/**
	 * End a render. The commit order is normative: (1) baseline capture (the
	 * committed-side counters the mount fast path compares against),
	 * (2) retirements due at this commit + the per-root commit table update,
	 * (3) notification of committed-state observers, (4) layout (newly
	 * mounted watchers subscribe, then reconcile). On discard, render-owned
	 * mounts die with the discarded tree. Deferred slot releases re-evaluate
	 * at EVERY render end, commit and discard alike — the render that retained
	 * them is what just ended.
	 */
	renderEnd(
		id: RenderPassId,
		kind: 'commit' | 'discard',
		opts?: { retireAtCommit?: BatchId[] },
	): void {
		const render = this.renderPassById(id)
		if (render.state === 'ended') {
			throw new ScheduleError('render already ended')
		}
		if (kind === 'commit') {
			for (const tid of opts?.retireAtCommit ?? []) {
				const t = this.batchById(tid) // throws on unknown ids before any mutation
				if (!render.maskBatches.has(tid)) {
					throw new ScheduleError(
						`batch ${tid} is not rendered by render pass ${render.id}; its retirement cannot be due at this commit`,
					)
				}
				if (t.state !== 'live' || t.parked) {
					throw new ScheduleError(
						`batch ${tid} cannot retire at this commit (already retired, or parked)`,
					)
				}
			}
		}
		render.state = 'ended'
		render.endKind = kind
		if (kind === 'discard') {
			for (const wid of render.mounted) {
				this.watchers.delete(wid)
			} // never subscribed; the tree died
			this.log({ type: 'render-discarded', renderPass: render.id, root: render.root })
			this.reevaluateDeferredReleases()
			// EF2: the frame close is the deferred flush point for boundaries
			// that occurred while this root's frame was open (committed truth
			// may already have moved via member writes / retirements the open
			// frame deferred) — the discard itself advances nothing.
			this.revalidateReactEffects(render.root)
			return
		}
		// The cross-world correction window opens (see drainCommittedObservers)
		// [sanctioned co-evolution]; closed after the populator below.
		this.committingRender = render
		// (1) Baseline capture at the commit's committed-side entry: the mount
		// fast path later asks "did committed truth move after my pin?" against
		// exactly these values.
		const baseline = {
			committedAdvance: this.committedAdvance,
			rootCommitGen: this.root(render.root).commitGen,
		}
		// The committing tree's content: re-rendered watchers take this render's
		// world values NOW — a watcher's "last rendered value" updates only at
		// committed renders, and it is the comparand every later
		// committed-truth reconciliation checks against.
		for (const wid of render.rendered) {
			const w = this.watchers.get(wid)
			if (w === undefined) {
				continue
			} // removed mid-render
			w.lastRenderedValue = this.evaluate(this.nodeById(w.node), { kind: 'render', render })
			w.snapshot = {
				renderPassId: render.id,
				pin: render.pin,
				maskSlots: new Set(render.maskSlots),
				includedSlots: this.includedSet(render),
				rootCommitGen: this.root(render.root).commitGen,
			}
		}
		// (2) Retirements due at this commit; then the per-root commit
		// (lock-in) of every still-live rendered batch. A retirement is "due
		// at this commit" only for batches this render rendered (validated
		// above): a foreign batch retires at its own closure, never inside
		// another render's commit — folding it here would land AFTER this
		// commit's baseline capture and silently break the mount fast path's
		// accounting (see tests/FLAGS.md, the legality rule under flag 5).
		for (const tid of opts?.retireAtCommit ?? []) {
			this.retireInternal(this.batchById(tid))
		}
		for (const tid of render.maskBatches) {
			const t = this.batchById(tid)
			if (t.state !== 'live') {
				continue
			} // fully retired above (or earlier): the retired clause subsumes membership
			const root = this.root(render.root)
			if (!root.committedBatches.has(tid)) {
				root.committedBatches.add(tid)
				root.commitGen++
				this.committedAdvance = this.nextSeq() // committed-advance: every per-root commit moves committed truth
				this.log({ type: 'per-root-commit', root: render.root, batch: tid })
				// (3) Committed truth moved: reconcile this root's committed observers now.
				this.drainCommittedObservers(render.root, 'per-root-commit')
			}
		}
		// (4) Layout: newly mounted watchers subscribe, then reconcile — before paint.
		for (const wid of render.mounted) {
			const w = this.watchers.get(wid)
			if (w === undefined) {
				continue
			}
			w.live = true
			this.mountFixup(w, render, baseline)
		}
		// The committed-render stamp rule [sanctioned co-evolution — the
		// at-least-once ruling's baseline-advance site; the engine's commit
		// populator twin]: for every watcher this commit re-rendered or
		// mounted (adopted reveals excluded — their snapshot rides the
		// original hidden render), derive committed-now; a rendered register
		// that agrees is VALIDATED (stamp := the counter now), one that
		// differs is re-staled (stamp := 0 — never-validated, so the next
		// drain corrects it even if committed truth flips back meanwhile;
		// the engine's full-scan drains catch its restaled set the same
		// way). The value compare is the cross-world render ↔ committed
		// commit-integrity check the ruling's survivor clause keeps.
		for (const wid of [...render.rendered, ...render.mounted]) {
			const w = this.watchers.get(wid)
			if (w === undefined || !w.live) {
				continue
			}
			if (w.snapshot.renderPassId !== render.id) {
				continue
			} // adopted reveal: population keeps its own timing
			const rec = this.refreshCommitted(render.root, this.nodeById(w.node))
			w.lastSeen = Object.is(rec.v, w.lastRenderedValue) ? rec.counter : 0
		}
		this.committingRender = undefined // the cross-world window closes with the commit fan
		this.log({ type: 'render-committed', renderPass: render.id, root: render.root })
		this.reevaluateDeferredReleases()
		// EF2 boundary: ONE effect re-check per commit operation, at the
		// boundary value — a render locking in two batches re-checks once, not
		// per batch (amendment 4's dedup rule). With retirements folded into
		// this commit, committed truth moved for every root, so the scan
		// widens to all roots (each still open-frame-deferred individually).
		this.revalidateReactEffects((opts?.retireAtCommit ?? []).length > 0 ? undefined : render.root)
	}

	/** A deferred slot release re-evaluates at every render end, commit and discard alike. */
	private reevaluateDeferredReleases(): void {
		for (const s of this.slots) {
			if (!s.releasePending) {
				continue
			}
			if (!this.slotRetainedByOpenMask(s.id)) {
				this.releaseSlot(s)
			}
		}
		// A render ending releases its pin, which can unblock pin-gated compaction.
		this.compactAll()
	}

	private slotRetainedByOpenMask(slot: BatchSlot): boolean {
		for (const p of this.idToRenderPass.values()) {
			if (p.state !== 'ended' && p.maskSlots.has(slot)) {
				return true
			}
		}
		return false
	}

	// ---------------------------------------------------------- retirement

	/** Retirement fires exactly once per batch; parked action batches retire only at settlement. */
	retire(batchId: BatchId): void {
		const t = this.batchById(batchId)
		if (t.state === 'retired') {
			throw new ScheduleError('retirement fires exactly once per batch')
		}
		if (t.parked) {
			throw new ScheduleError('parked action batches retire only at settlement')
		}
		this.retireInternal(t)
		// EF2 boundary: retirement is a guaranteed flush point for every root
		// (a write-free retirement still flushes pending member-write flips).
		this.revalidateReactEffects()
	}

	/** The async action's thenable settles; the host then retires the batch. */
	settleAction(batchId: BatchId): void {
		const t = this.batchById(batchId)
		if (!t.action) {
			throw new ScheduleError('settle targets an action batch')
		}
		if (!t.parked || t.state !== 'live') {
			throw new ScheduleError('action already settled')
		}
		t.parked = false
		this.retireInternal(t)
		this.revalidateReactEffects() // EF2 boundary: settlement is a guaranteed flush point
	}

	/**
	 * Retirement — the internal order is normative: stamp the log entries, fold
	 * (compaction), create per-atom retirement stamps + advance the committed
	 * counter, reconcile committed observers, clear per-root membership
	 * rows, and only then release the slot (deferred if an open render's
	 * render mask names it). The row-clear-before-release order guarantees a
	 * recycled slot can never impersonate a committed member. Retirement is
	 * disposition-blind: a batch the host abandoned retires through the same
	 * path — writes never silently revert, and persistence never depends on
	 * having subscribers. (The host's committed/abandoned report is a
	 * bindings-side diagnostic, recorded at its source; neither the model nor
	 * the engine ever consumes it.)
	 */
	private retireInternal(batch: Batch): void {
		batch.state = 'retired'
		batch.parked = false
		const retiredSeq = this.nextSeq() // one retirement sequence per retirement event
		batch.retiredSeq = retiredSeq
		const touched: AtomNode[] = []
		for (const n of this.idToNode.values()) {
			if (n.kind !== 'atom') {
				continue
			}
			let hit = false
			for (const e of n.log) {
				if (e.batch === batch.id) {
					e.retiredSeq = retiredSeq
					hit = true
				}
			}
			if (hit) {
				touched.push(n)
			}
		}
		// Create the retirement stamp per touched atom; advance the committed counter.
		for (const n of touched) {
			n.retirementStamp = retiredSeq
		}
		if (touched.length > 0) {
			this.committedAdvance = this.nextSeq()
		}
		// Fold/compaction. Naive form: try every atom — a retirement can
		// unblock compactable prefixes anywhere.
		this.compactAll()
		this.log({ type: 'retired', batch: batch.id, retiredSeq })
		// Committed truth flipped: reconcile watchers and revalidate effects
		// against it. The engine enumerates only the observers the slot
		// touched; the naive model checks every observer — corrections are
		// value-gated, so the fired set is identical (touched ⊇ changed).
		for (const rootId of this.roots.keys()) {
			this.drainCommittedObservers(rootId, 'retirement')
		}
		// Clear per-root committed-table rows (the retired-history rule now
		// subsumes membership), THEN release the slot unless an open render
		// mask names it — this order is what keeps recycled slots honest.
		for (const r of this.roots.values()) {
			r.committedBatches.delete(batch.id)
		}
		if (batch.slot !== undefined) {
			const slot = this.slots[batch.slot]
			if (this.slotRetainedByOpenMask(slot.id)) {
				slot.releasePending = true // re-evaluated at every render end
			} else {
				this.releaseSlot(slot)
			}
		}
		if (this.ambientBatch === batch.id) {
			this.ambientBatch = undefined
		}
	}

	/**
	 * Compaction consumes a sequence-order prefix of the write log: entry e
	 * compacts iff every entry with seq ≤ e.seq is retired AND
	 * e.retiredSeq ≤ min(live pins) — i.e. every live world already sees the
	 * prefix via the retired-history rule, so folding it into the base can
	 * change no live world's answer. Compacted entries move to the archive
	 * so the retention invariant can re-derive every fold from full history.
	 */
	private compactAll(): void {
		for (const n of this.idToNode.values()) {
			if (n.kind === 'atom') {
				this.compactAtom(n)
			}
		}
	}

	private compactAtom(atom: AtomNode): void {
		const minPin = this.minLivePin()
		let cut = 0
		for (const e of atom.log) {
			if (e.retiredSeq === undefined) {
				break
			} // prefix clause: an unretired earlier entry blocks everything after it
			if (e.retiredSeq > minPin) {
				break
			} // pin clause: every live pin must already see e via the retired clause
			cut++
		}
		if (cut === 0) {
			return
		}
		const folded = atom.log.slice(0, cut)
		for (const e of folded) {
			const next = this.applyOp(atom, e.op, atom.base)
			// R-2 order: (current, incoming) — per compacted entry BY DESIGN.
			if (!this.inCallback(() => atom.equals(atom.base, next))) {
				atom.base = next
			}
			atom.baseSeq = e.seq
			atom.archive.push(e)
		}
		atom.log = atom.log.slice(cut)
	}

	/**
	 * Reconciliation at a committed-truth flip (a retirement or a per-root
	 * commit): compare each live watcher's last rendered value against
	 * committed-for-root NOW and correct urgently, pre-paint, on a real
	 * difference. Comparing values is legal HERE — both sides are committed
	 * truth, one world — unlike live-write delivery, which is never
	 * value-gated because it would compare across worlds. Committed EFFECTS
	 * do NOT drain here: their re-check is once per boundary operation
	 * (revalidateReactEffects), not per flip — RCC-EF2's amended boundary
	 * semantics.
	 */
	private drainCommittedObservers(rootId: RootId, cause: 'retirement' | 'per-root-commit'): void {
		for (const w of this.watchers.values()) {
			if (!w.live || w.root !== rootId) {
				continue
			}
			const rec = this.refreshCommitted(rootId, this.nodeById(w.node))
			// The correction gate [sanctioned co-evolution — at-least-once]:
			// counter movement since the watcher's last validation corrects,
			// no value comparison — EXCEPT watchers re-rendered/mounted by
			// the render currently committing, whose rendered register was
			// just reset from the RENDER world: the commit's own lock-in
			// moves committed truth by exactly the content their screen
			// already shows, so a counter gate would correct every watcher
			// at every commit. Their reconciliation stays the cross-world
			// value compare (the ruling's survivor clause — per-root
			// counters cannot express render ↔ committed equivalence).
			const committing = this.committingRender
			if (committing !== undefined && w.snapshot.renderPassId === committing.id) {
				if (!Object.is(rec.v, w.lastRenderedValue)) {
					this.log({
						type: 'reconcile-correction',
						watcher: w.name,
						root: rootId,
						from: w.lastRenderedValue,
						to: rec.v,
						cause,
					})
					w.lastSeen = rec.counter // the urgent correction validates
					w.lastRenderedValue = rec.v // the urgent pre-paint re-render
					w.dedup.clear() // dedup bits re-arm at the watcher's render
				}
				continue
			}
			if (rec.counter !== w.lastSeen) {
				this.log({
					type: 'reconcile-correction',
					watcher: w.name,
					root: rootId,
					from: w.lastRenderedValue,
					to: rec.v,
					cause,
				})
				w.lastSeen = rec.counter
				w.lastRenderedValue = rec.v // the urgent pre-paint re-render
				w.dedup.clear() // dedup bits re-arm at the watcher's render
			}
		}
	}

	// ---------------------------------------------------------- mount fixup

	/**
	 * Mount reconciliation — runs in the mounting component's layout effect
	 * (after subscription, before paint). A component can mount while other
	 * updates are in flight, and its subscription activates only now, so
	 * writes could have slipped by between its render and this moment. The
	 * mount-correction rule, decided in this order: value-blind correctives
	 * (from write metadata alone; no evaluation) join the mount to each live
	 * non-included batch that touched its node, so it rides those pending
	 * updates rather than missing or revealing them; then a four-condition
	 * test decides whether anything retired or locked in during the window —
	 * only a failing condition triggers the fast-forwarded re-evaluation and
	 * the urgent pre-paint correction.
	 */
	private mountFixup(
		w: Watcher,
		committingRender: RenderPass,
		baseline: { committedAdvance: number; rootCommitGen: number },
	): void {
		const node = this.nodeById(w.node)
		this.refreshEdgesAllWorlds()
		const closure = this.dependencyClosureOf(w.node)
		// Per-batch corrective loop: every LIVE written batch that touched the
		// node. A premise of the condition test's soundness, not an
		// optimization (tests/FLAGS.md, flag 5 finding 3): a live batch
		// already committed into this root can write after the render pinned —
		// no condition observes that write, and this schedule is what carries
		// it to the watcher, in the batch's own lane.
		for (const t of this.idToBatch.values()) {
			if (t.state !== 'live' || t.slot === undefined) {
				continue
			}
			if (!this.batchTouches(t, closure)) {
				continue
			}
			const slot = this.slots[t.slot]
			// Fully included (slot in the render's included set AND no post-pin
			// write in it): the render already folded everything — skip. The skip
			// is by inclusion + clocks, never by comparing values.
			if (w.snapshot.includedSlots.has(slot.id) && slot.writeClock <= w.snapshot.pin) {
				continue
			}
			this.log({ type: 'mount-corrective', watcher: w.name, batch: t.id, slot: slot.id })
			w.dedup.add(slot.id) // the corrective is a re-render scheduled into t's own lane
		}
		// The four-condition test, decided before any evaluation: skip the
		// re-evaluation and comparison entirely when the conditions show the
		// mount window was quiet — (0) the mounting render is the committing
		// render, (1) no committed-side advance since the pin, (2) the root's
		// commit generation is unchanged, (3) no included batch wrote after
		// the pin. When all hold, nothing retired or locked in during the
		// window, and any drift the fast-forwarded world would show is
		// exactly the live-batch writes the corrective loop above already
		// scheduled re-renders for. Over-firing (comparing unnecessarily) is
		// safe; under-firing would be a missed correction, i.e. a tear.
		//
		// SUBTLE (found by fuzzing; explained in tests/FLAGS.md under flag 5,
		// finding 2): condition (3) must NOT quantify only over the slot set
		// captured at render start. A rendered batch whose FIRST write lands
		// mid-render interned its slot after that capture, making the captured
		// check vacuous for it — yet this commit locks the batch in and the
		// fast-forwarded world folds the post-pin write. The model therefore
		// also checks the committing render's rendered BATCHES at commit time
		// (their latest write seq vs the pin).
		const clocksQuiet =
			[...w.snapshot.maskSlots].every((s) => this.slots[s].writeClock <= w.snapshot.pin) &&
			[...committingRender.maskBatches].every((tid) => {
				const t = this.batchById(tid)
				return t.lastWriteSeq === 0 || t.lastWriteSeq <= w.snapshot.pin
			})
		const fastOut =
			w.snapshot.renderPassId === committingRender.id &&
			baseline.committedAdvance <= w.snapshot.pin &&
			baseline.rootCommitGen === w.snapshot.rootCommitGen &&
			clocksQuiet
		if (fastOut) {
			return
		} // the window was quiet: no evaluation, no comparison
		const vFx = this.evaluate(node, {
			kind: 'mountFix',
			maskSlots: w.snapshot.maskSlots,
			pin: w.snapshot.pin,
			root: w.root,
		})
		if (!Object.is(vFx, w.lastRenderedValue)) {
			this.log({
				type: 'mount-urgent-correction',
				watcher: w.name,
				from: w.lastRenderedValue,
				to: vFx,
			})
			w.lastRenderedValue = vFx // urgent pre-paint correction
			w.dedup.clear()
		}
	}

	/** Transitive dependency closure (atoms + computeds) feeding a node, over the accumulated union graph. */
	dependencyClosureOf(nodeId: NodeId): Set<NodeId> {
		const closure = new Set<NodeId>([nodeId])
		let grew = true
		while (grew) {
			grew = false
			for (const [dep, outs] of this.episodeEdges) {
				if (closure.has(dep)) {
					continue
				}
				for (const out of outs) {
					if (closure.has(out)) {
						closure.add(dep)
						grew = true
						break
					}
				}
			}
		}
		return closure
	}

	private batchTouches(t: Batch, closure: Set<NodeId>): boolean {
		for (const n of this.idToNode.values()) {
			if (n.kind !== 'atom' || !closure.has(n.id)) {
				continue
			}
			for (const e of n.log) {
				if (e.batch === t.id) return true
			}
		}
		return false
	}

	// ------------------------------------------- episodes and quiescence

	/** Synchronously abandons every work-in-progress render on every root (a host capability). */
	discardAllWip(): void {
		for (const p of this.idToRenderPass.values()) {
			if (p.state !== 'ended') {
				this.renderEnd(p.id, 'discard')
			}
		}
	}

	quiescent(): boolean {
		return this.liveBatches().length === 0 && this.livePins().length === 0
	}

	/**
	 * [SANCTIONED CO-EVOLUTION: converged-terminal referee, review finding #8]
	 * The engine's `quiet` predicate (its quiet-fold precondition: no live
	 * batches, no live pins/open renders, no pending write log). Exposed so the
	 * terminal-trigger band writes `tap` only on the quiet path — the write
	 * path where the converged terminal's boundary drain lives (bugs 1 & 2) —
	 * with legality decided identically on both sides of the lockstep harness.
	 */
	isQuiet(): boolean {
		return this.quietNow()
	}

	/**
	 * Quiescence (no live batches, no live pins, no parked actions): the
	 * per-episode dependency edges bulk-reset (epoch bump). Retained
	 * sequence values are NOT rewritten — sequences are plain JS numbers,
	 * exact to 2^53, and only ever compared, so the counter simply keeps
	 * climbing across episodes (renumbering was measured within noise on
	 * log-heavy shapes and deleted; grind batch 4, item C). Batch serials
	 * were always a separate, never-renumbered domain. The model has no
	 * caches to refresh afterward — delivery reachability is recomputed from
	 * scratch at every write, which is the refreshed state by construction.
	 */
	quiesce(): void {
		if (!this.quiescent()) {
			throw new ScheduleError('quiescence requires no live batches, pins, or parked actions')
		}
		// Residue check: with no live pins, the last retirement compacted every write log.
		for (const n of this.idToNode.values()) {
			if (n.kind === 'atom' && n.log.length > 0) {
				throw new InvariantViolation(
					`quiescence residue: atom ${n.name} still holds ${n.log.length} log entries`,
				)
			}
		}
		this.episodeEdges.clear()
		this.epoch++
		// Dead-episode records drop at the reset: ended renders and retired
		// batches belong to the dead episode, and nothing from a dead episode
		// may validate anything in a live one. Id counters stay monotone
		// across episodes.
		for (const [id, p] of this.idToRenderPass) {
			if (p.state === 'ended') {
				this.idToRenderPass.delete(id)
			}
		}
		for (const [id, t] of this.idToBatch) {
			if (t.state === 'retired') {
				this.idToBatch.delete(id)
			}
		}
		for (const n of this.idToNode.values()) {
			if (n.kind !== 'atom') {
				continue
			}
			// The archive belongs to the dead episode; it exists only for the
			// retention invariant, whose comparisons are per-episode. Clear it.
			n.archive = []
			n.origin = n.base
		}
		// Dead-episode bookkeeping bulk-zeroes at the episode reset.
		for (const s of this.slots) {
			s.writeClock = 0
			s.claimSeq = 0
			s.releasePending = false
		}
		for (const w of this.watchers.values()) {
			w.dedup.clear()
		}
		this.log({ type: 'epoch-reset', epoch: this.epoch })
	}

	// ------------------------------------------------------------ helpers

	/** Convenience: the value of a node in a named world (test surface). */
	read(node: AnyNode, world: World): Value {
		return this.evaluate(node, world)
	}

	committedValue(node: AnyNode, root: RootId): Value {
		return this.evaluate(node, { kind: 'committed', root })
	}

	/**
	 * The newest value: atoms fold; computeds serve the sampled-untracked
	 * cache [ruling 2026-07-06: untracked sampling] — see
	 * `ComputedNode.newestSample`.
	 */
	newestValue(node: AnyNode): Value {
		if (node.kind === 'atom') {
			return this.evaluate(node, { kind: 'newest' })
		}
		return this.sampledNewest(node)
	}

	/**
	 * Serve-or-derive under the sampling rule. Validation is value identity
	 * over the recorded tracked deps, each resolved at ITS sampled-newest
	 * value (recursion mirrors the kernel's checkDirty descent, including the
	 * equality-cutoff behavior: a tracked dep whose own re-derivation folded
	 * back to an identical value invalidates nothing above it). A derivation
	 * runs the fn once with readers that resolve BOTH read kinds at
	 * sampled-newest values — the untracked reads ARE the point-in-time
	 * samples; only tracked reads enter the fingerprint (and the episode's
	 * union edge graph, as every model evaluation's tracked reads do).
	 */
	private sampledNewest(node: ComputedNode): Value {
		const cached = node.newestSample
		if (cached !== undefined) {
			let valid = true
			for (const d of cached.deps) {
				if (!Object.is(this.newestValue(d.node), d.value)) {
					valid = false
					break
				}
			}
			if (valid) {
				return cached.value
			}
		}
		if (this.inFoldCallback) {
			throw new ScheduleError(
				'signal read inside an updater/reducer fold — updaters and reducers must be pure; read what you need before dispatching',
			)
		}
		if (node.sampling === true) {
			throw new ScheduleError(
				`cyclic evaluation of ${node.name} within one world — a computed may not depend on itself`,
			)
		}
		node.sampling = true
		this.evalDepth++
		const deps: { node: AnyNode; value: Value }[] = []
		try {
			const read: Reader = (dep) => {
				this.recordEdge(dep.id, node.id)
				const v = this.newestValue(dep)
				deps.push({ node: dep, value: v })
				return v
			}
			const untracked: Reader = (dep) => this.newestValue(dep)
			const value = node.fn(read, untracked)
			node.newestSample = { deps, value }
			return value
		} finally {
			this.evalDepth--
			node.sampling = false
		}
	}

	renderValue(node: AnyNode, render: RenderPass): Value {
		return this.evaluate(node, { kind: 'render', render })
	}

	eventsOfType<T extends ModelEvent['type']>(type: T): Extract<ModelEvent, { type: T }>[] {
		return this.events.filter((e): e is Extract<ModelEvent, { type: T }> => e.type === type)
	}

	/** Events appended after a caller-captured watermark (test surface). */
	eventsSince(mark: number): ModelEvent[] {
		return this.events.slice(mark)
	}
}
