/**
 * Twin-driver helpers: the battery/scars/flags specs in this directory run
 * VERBATIM against `concurrent()` from this module — every call fans out to the
 * reference model (`cosignals-oracle`) AND the CONCURRENT engine, legality
 * decisions must agree, every value read is asserted equal on both sides,
 * and the full event stream + counters are compared after every mutation.
 * The test bodies' own `expect`s therefore assert the reference model's
 * required outcomes while the lockstep harness asserts engine ≡ model at every step.
 * `selfCheck` additionally runs the reference model's invariant battery on
 * BOTH sides (the engine through its model view — tests/model-view.ts) plus
 * one engine-only check ("K0 parity"): the kernel's newest value must equal
 * folding the atom's base value through its log entries.
 */
import { expect } from 'vitest'
import { snapshotModel } from '../../cosignals-oracle/src/adapter.js'
import { checkInvariants } from '../../cosignals-oracle/src/invariants.js'
import {
	CosignalModel,
	ScheduleError,
	type AnyNode,
	type AtomNode,
	type CoreEffect,
	type Equals,
	type ModelEvent,
	type Op,
	type RenderPass,
	type ReactEffect,
	type Batch,
	type Value,
	type Watcher,
} from '../../cosignals-oracle/src/model.js'
import {
	attachDriver,
	engine,
	BATCH_NONE,
	__TEST__resetEngine,
	ScheduleError as EScheduleError,
	type AnyInternals as EInternals,
	type AtomInternals as EAtomInternals,
	type CosignalEngine,
	type RenderPass as ERenderPass,
	type SignalEffect as ESignalEffect,
	type World as EWorld,
} from '../src/CosignalEngine.js'
import { __TEST__peekNextBatchId } from '../src/CosignalEngine.js'
import { engineEpoch } from '../src/CosignalEngine.js'
import { armArenaCheck, checkArenas } from './arena-checker.js'
import { effect, type Atom } from '../src/index.js'
import { modelView, RefereeMirror } from './model-view.js'
import { attachRefereeStream } from './trace-events.js'

/** Scenario annotation only: the specs name each batch's React lane priority
 * for the reader; neither the engine nor the model consults it (the model's
 * Priority dimension was deleted — the annotation survives so the ~230
 * transcribed scenarios keep reading like the React schedules they mirror). */
type Priority = 'urgent' | 'default' | 'deferred'

type Thrown = { threw: false; value: unknown } | { threw: true; error: unknown }

/**
 * Delivery-decision events (the documented engine-diff tolerance surface).
 * mount-corrective joins them: the engine draws the corrective population
 * from the per-node touched set, while the model derives it from its
 * eagerly refreshed union closure — the same union-conservative
 * over-approximation as deliveries. The "at least what correctness
 * requires" floor for correctives is enforced in-engine: an internal audit
 * throws InvariantViolation whenever divergence hidden by the mount
 * fast-out is not exactly covered by a corrective.
 */
function isDeliveryish(e: ModelEvent): boolean {
	return e.type === 'delivery' || e.type === 'suppressed' || e.type === 'mount-corrective'
}

/** Delivery-DECISION counts, pooled across the family's three modes per
 * (watcher, batch, slot): "fewer decisions, never more".
 * Current-structure routing shifts modes within the family — a mount join
 * the accumulated model schedules as a corrective (arming its dedup, so
 * its later write logs 'suppressed') may not exist in any live arena; the
 * engine's write-time walk is then the first notification and logs
 * 'delivery'. One notification either way. */
function deliveryCounts(events: ModelEvent[]): Map<string, number> {
	const out = new Map<string, number>()
	for (const e of events) {
		if (!isDeliveryish(e)) {
			continue
		}
		const d = e as unknown as { watcher: string; batch: number; slot: number }
		const key = `${d.watcher}|${d.batch}|${d.slot}`
		out.set(key, (out.get(key) ?? 0) + 1)
	}
	return out
}

function capture(fn: () => unknown): Thrown {
	try {
		return { threw: false, value: fn() }
	} catch (error) {
		return { threw: true, error }
	}
}

// ---- effect constructors (test-side compositions over the real
// mechanism: mountSignalEffect + a `body` + captureSignalEffectRun; the body path is
// the engine's inline-run + event-creation machinery lockstep compares) ----------

/** Effect configuration — a single-node body (the engine counterpart of the
 * model's mountReactEffect). */
export function mountEngineReactEffect(
	b: CosignalEngine,
	rootId: string,
	node: EInternals,
	name: string,
): ESignalEffect {
	const e = b.mountSignalEffect(rootId, name)
	e.body = () => void b.readSignalEffectDep(node)
	b.captureSignalEffectRun(e.id, e.body)
	return e
}

/** Referee configuration — a body that re-chooses deps CAUSALLY:
 * readSignalEffectDep(sel) ? readSignalEffectDep(a) : readSignalEffectDep(b). */
export function mountEngineReactEffectPick(
	b: CosignalEngine,
	rootId: string,
	sel: EInternals,
	a: EInternals,
	bb: EInternals,
	name: string,
): ESignalEffect {
	const e = b.mountSignalEffect(rootId, name)
	e.body = () =>
		void (b.readSignalEffectDep(sel) ? b.readSignalEffectDep(a) : b.readSignalEffectDep(bb))
	b.captureSignalEffectRun(e.id, e.body)
	return e
}

/** [SANCTIONED CO-EVOLUTION: converged-terminal referee, review finding #8]
 * A committed terminal whose BODY WRITES (the engine counterpart of the
 * model's mountReactEffectWrite): it reads `readNode` committed and writes a
 * bounded payload (min(read, 3)) to `writeAtom` through the PUBLIC atom path.
 * That write lands while the terminal is active (activeSignalEffect set), so
 * it must schedule the sibling terminal at the boundary, never nest — bug 2's
 * exact shape, refereed against the model's deferred drain. */
export function mountEngineReactEffectWrite(
	b: CosignalEngine,
	rootId: string,
	readNode: EInternals,
	writeAtom: EAtomInternals,
	name: string,
): ESignalEffect {
	const e = b.mountSignalEffect(rootId, name)
	// Silent baseline on the mount run (mirrors the model's mountReactEffectWrite
	// and the core effect): capture the dep, write only on re-fires (the bug-2
	// path) — so a mount never leaks an owed boundary drain.
	let ran = false
	e.body = () => {
		const v = b.readSignalEffectDep(readNode) as number
		if (!ran) {
			ran = true
			return
		}
		;(writeAtom.handle as Atom<number>).set(Math.min(v, 3))
	}
	b.captureSignalEffectRun(e.id, e.body)
	return e
}

/** The record `mountEngineCoreEffect` returns — the model CoreEffect's
 * engine counterpart (specs read `runs`/`lastValue`; the stream comparison reads the trace). */
export type EngineCoreEffect = {
	name: string
	runs: number
	lastValue: Value
	dispose: () => void
}

/** Per-composition core-effect mount ordinal (keyed by the ENGINE EPOCH —
 * one test = one epoch; mirrors the model's `coreEffectMounts`: both sides
 * tick once per mount in lockstep, so created names agree). */
const coreEffectMounts = new Map<number, number>()

/**
 * Mount a core effect: a REAL kernel `effect()` whose body does a plain
 * tracked kernel read of the node's public handle (host world-routing is
 * bypassed inside a kernel frame — `activeSub !== 0`), so the kernel's own
 * propagation over its subscriber links re-runs it at exactly the writes
 * that advance the newest fold (the eager kernel apply). The mount run
 * baselines silently; later runs value-gate on `Object.is` and report
 * through the engine's `logCoreEffectRun` trace seam.
 *
 * Names take a per-mount ordinal suffix (`#k`): sibling core-effect firing
 * order under one operation is implementation-defined by contract, so the
 * lockstep differ compares same-step runs as a multiset
 * sorted on (effect, value) — duplicate names (two mounts with no
 * intervening event/seq used to create the same `CE${events}.${seq}.${epoch}`
 * uniq) would make that comparison ambiguous.
 */
export function mountEngineCoreEffect(
	b: CosignalEngine,
	node: EInternals,
	name: string,
	writeTo?: EAtomInternals,
): EngineCoreEffect {
	const ordinal = coreEffectMounts.get(engineEpoch) ?? 0
	coreEffectMounts.set(engineEpoch, ordinal + 1)
	const rec: EngineCoreEffect = {
		name: `${name}#${ordinal}`,
		runs: 0,
		lastValue: undefined,
		dispose: () => {},
	}
	let mounted = false
	rec.dispose = effect(() => {
		const value: Value = node.handle.state // tracked kernel read (newest world)
		if (!mounted) {
			mounted = true
			rec.lastValue = value // silent baseline (the model seeds lastValue the same way)
			return
		}
		if (Object.is(value, rec.lastValue)) {
			return
		} // value gate
		rec.lastValue = value
		rec.runs++
		b.logCoreEffectRun(rec.name, value)
		// R-3: a WRITING core effect — the write goes through the PUBLIC atom
		// path from inside the kernel flush (i.e. during the triggering
		// write's fused eager apply) and must CLASSIFY NORMALLY (ambient
		// batch while pending, quiet fold at rest). Payload = min(runs, 3):
		// the equality cutoff bounds effective writes per trigger.
		if (writeTo !== undefined) {
			;(writeTo.handle as Atom<number>).set(Math.min(rec.runs, 3))
		}
	})
	return rec
}

export class TwinDriver {
	readonly model = new CosignalModel()
	/** THE ONE ENGINE, reset per driver (the fresh-model analog): devChecks
	 * armed — the switch must be engine-inert, and the whole lockstep suite
	 * running with it on proves the flag itself perturbs nothing. A minimal
	 * driver attaches (R-5: devChecks harnesses that open batches must
	 * attach first); its batch context is always BATCH_NONE — the harness
	 * passes explicit batch ids through the engine write surface. */
	readonly engine: CosignalEngine = (() => {
		drainLeftoverEpisode()
		__TEST__resetEngine({ devChecks: true })
		attachDriver({ currentBatch: () => BATCH_NONE, worldFor: () => undefined })
		return engine
	})()
	/** BatchIds are MONOTONIC ACROSS RESETS (the engine counter survives
	 * `__TEST__resetEngine`); the model's restart at 1 — so the harness
	 * rebases: engine id = model id + base, and engine events normalize by
	 * subtracting it before comparison. */
	private readonly batchIdBase = __TEST__peekNextBatchId() - 1
	/** The engine's event stream: a lossless session tracer attached at
	 * engine reset, decoded to TraceEvents on demand (the engine creates no
	 * event objects — tests/trace-events.ts). */
	readonly engineEvents = attachRefereeStream(this.engine)
	/** Full-history mirror (archives via onLogEntryDrop + origins) — the model comparison
	 * retains it OUTSIDE the engine; see tests/model-view.ts. */
	readonly mirror = new RefereeMirror()
	/** The engine presented in the model's shape for the oracle's checkers. */
	private readonly view = modelView(this.engine, this.mirror) as unknown as CosignalModel
	/** THE model→engine node mapping, registered at creation and resolved by
	 * `toEngine` on every op. The two id spaces are unrelated: the model
	 * allocates dense ids; the engine's NodeId is the kernel record id
	 * (sparse — node and link records share one allocator, and freed record
	 * ids recycle). Snapshots/events compare by NAME, never by id. */
	private nodeMap = new Map<AnyNode, EInternals>()
	private idToEngineRenderPass = new Map<number, ERenderPass>()
	/** Model react-effect id → engine SignalEffect id. The id spaces diverge
	 * once a core effect mounts: the model's `nextEffect` ticks for BOTH
	 * effect kinds, the engine's only for committed observers (core effects
	 * are kernel `effect()`s, not engine records). */
	private effectMap = new Map<number, number>()

	constructor() {
		// The reference model's retention invariant (checkRetention in
		// invariants.ts) shadow-folds over the full history; the engine
		// retains none of it — the mirror archives each log entry as it drops
		// from the write log (fold-valve folds, the episode close's drop;
		// retaining in-engine would grow without bound under a workload that
		// never quiesces).
		this.mirror.attach(this.engine)
		// Dual bookkeeping: after every lockstep op, the engine serves
		// every live arena's shadows FROM THE ARENA and compares against the
		// memo-served values (plus the structural validator). ANY divergence
		// throws — the stage's STOP condition.
		armArenaCheck(this.engine)
	}

	// ---- state the test bodies read directly (model side; engine compared per op)
	get events(): ModelEvent[] {
		return this.model.events
	}
	get idToBatch(): CosignalModel['idToBatch'] {
		return this.model.idToBatch
	}
	get slots(): CosignalModel['slots'] {
		return this.model.slots
	}
	get idToRenderPass(): CosignalModel['idToRenderPass'] {
		return this.model.idToRenderPass
	}
	get roots(): CosignalModel['roots'] {
		return this.model.roots
	}
	get idToNode(): CosignalModel['idToNode'] {
		return this.model.idToNode
	}
	get watchers(): CosignalModel['watchers'] {
		return this.model.watchers
	}
	get seq(): number {
		return this.model.seq
	}
	get epoch(): number {
		return this.model.epoch
	}
	get ambientBatch(): number | undefined {
		return this.model.ambientBatch
	}

	private toEngine(node: AnyNode): EInternals {
		const e = this.nodeMap.get(node)
		if (e === undefined) {
			throw new Error(`twin: node ${node.name} was not created through the driver`)
		}
		return e
	}

	private toEngineRenderPass(render: RenderPass): ERenderPass {
		const p = this.idToEngineRenderPass.get(render.id)
		if (p === undefined) {
			throw new Error(`twin: render pass ${render.id} was not created through the driver`)
		}
		return p
	}

	private toEngineEffect(modelId: number): number {
		const id = this.effectMap.get(modelId)
		if (id === undefined) {
			throw new Error(`twin: react effect ${modelId} was not created through the driver`)
		}
		return id
	}

	/** Run a mutation on both sides; legality must agree; model's outcome wins. */
	private both<T>(label: string, onModel: () => T, onEngine: () => unknown): T {
		const m = capture(onModel)
		const e = capture(onEngine)
		if (m.threw !== e.threw) {
			const detail = m.threw
				? `model threw ${(m as { error: unknown }).error}`
				: `engine threw ${(e as { error: unknown }).error}`
			expect.fail(`twin ${label}: legality diverged (${detail})`)
		}
		if (m.threw && e.threw) {
			const mSched = (m.error as object) instanceof ScheduleError
			const eSched = (e.error as object) instanceof EScheduleError
			if (mSched !== eSched) {
				expect.fail(
					`twin ${label}: error class diverged (model ${String(m.error)}, engine ${String(e.error)})`,
				)
			}
			throw m.error
		}
		this.compareStreams(label)
		return (m as { value: T }).value
	}

	/**
	 * Event stream, sequence counters, and committedAdvance must agree after every op.
	 *
	 * Delivery tolerance (the relaxation documented in the reference
	 * model's README, `cosignals-oracle`): the model's delivery reachability
	 * recomputes the union graph eagerly at every write, while the engine —
	 * for speed — discovers edges at evaluation sites and replays live
	 * slots when an edge is added, so delivery/suppressed decisions may lag
	 * the model's or drop when a never-materialized union path was the only
	 * route. Comparator: 'delivery'/'suppressed' events are checked as
	 * "engine ⊆ model, cumulatively, keyed by (type, watcher, batch, slot)"
	 * (mode/seq excluded: a replayed delivery carries the replay sequence);
	 * every other event type must match exactly, in order. The "at least
	 * what correctness requires" floor is enforced indirectly: observable
	 * snapshots, reconcile corrections, effect runs, and counters stay
	 * exact.
	 */
	/** Engine-decoded events with batch ids rebased into the model's space
	 * (BatchIds are monotonic across resets engine-side; see batchIdBase). */
	private normalizedEngineEvents(): ModelEvent[] {
		const base = this.batchIdBase
		const events = this.engineEvents.events as ModelEvent[]
		if (base === 0) {
			return events
		}
		return events.map((e) => {
			const batch = (e as { batch?: number }).batch
			return typeof batch === 'number' && batch > 0
				? ({ ...e, batch: batch - base } as ModelEvent)
				: e
		})
	}

	private compareStreams(label: string): void {
		checkArenas(this.engine) // NF2 S-A divergence check (throws on ANY arena↔memo mismatch)
		expect(this.engine.seq, `twin ${label}: seq diverged`).toBe(this.model.seq)
		expect(this.engine.committedAdvance, `twin ${label}: committedAdvance diverged`).toBe(
			this.model.committedAdvance,
		)
		expect(this.engine.epoch, `twin ${label}: epoch diverged`).toBe(this.model.epoch)
		// The engine's stream is decoded from its packed trace records (the
		// only event channel); the decode is incremental, so re-reading the
		// cumulative stream after every op stays cheap.
		const engineEvents = this.normalizedEngineEvents()
		const mRest = this.model.events.filter((e) => !isDeliveryish(e))
		const eRest = engineEvents.filter((e) => !isDeliveryish(e))
		const me = JSON.stringify(mRest)
		const ee = JSON.stringify(eRest)
		if (me !== ee) {
			expect.fail(`twin ${label}: event streams diverged\nmodel  ${me}\nengine ${ee}`)
		}
		const pool = deliveryCounts(this.model.events)
		const engineCounts = deliveryCounts(engineEvents)
		void 0
		for (const [key, n] of engineCounts) {
			const avail = pool.get(key) ?? 0
			if (n > avail) {
				expect.fail(
					`twin ${label}: engine over-delivered beyond the union-conservative bound: ${key} ×${n} vs model ×${avail}`,
				)
			}
		}
	}

	// ------------------------------------------------------------- surface

	atom(name: string, initial: Value, equals?: Equals): AtomNode {
		const mNode = this.model.atom(name, initial, equals)
		const eInternals = this.engine.atom(name, initial, equals)
		this.nodeMap.set(mNode, eInternals) // ids live in different spaces — the mapping is the resolution
		this.mirror.setOrigin(eInternals, initial)
		return mNode
	}

	/**
	 * Join a pre-existing PUBLIC kernel atom on both sides (always-concurrent:
	 * the engine resolves any handle by its id — content allocates on first
	 * participation and seeds base from kernel-current, which IS the atom's
	 * full committed history; the model, which has no kernel, mirrors it as
	 * construction-time seeding with that same value). Neither side creates
	 * a log entry, batch, or event.
	 */
	joinAtom(name: string, handle: Atom<unknown>): AtomNode {
		const eInternals = this.engine.internalsForAtom(handle)
		eInternals.name = name // comparison naming: streams compare by name
		const mNode = this.model.atom(name, eInternals.base)
		expect(Object.is(mNode.base, eInternals.base), 'twin joinAtom: seeded base diverged').toBe(true)
		this.nodeMap.set(mNode, eInternals) // ids live in different spaces — the mapping is the resolution
		this.mirror.setOrigin(eInternals, eInternals.base)
		return mNode
	}

	computed(
		name: string,
		fn: (read: (n: AnyNode) => Value, untracked: (n: AnyNode) => Value) => Value,
	) {
		const mNode = this.model.computed(name, fn)
		const eInternals = this.engine.computed(name, (read, untracked) =>
			fn(
				(d) => read(this.toEngine(d)),
				(d) => untracked(this.toEngine(d)),
			),
		)
		this.nodeMap.set(mNode, eInternals) // ids live in different spaces — the mapping is the resolution
		return mNode
	}

	openBatch(_priority: Priority, opts?: { action?: boolean; ambient?: boolean }): Batch {
		let eId: number | undefined
		const t = this.both(
			'openBatch',
			() => this.model.openBatch(opts),
			() => {
				eId = this.engine.openBatch(opts).id // neither side creates a priority — scheduling stays React's (see the Priority annotation type)
			},
		)
		expect(eId! - this.batchIdBase, 'twin openBatch: batch ids diverged').toBe(t.id)
		return t
	}

	write(batchId: number | undefined, node: AtomNode, op: Op): void {
		const mark = this.model.events.length
		this.both(
			'write',
			() => this.model.write(batchId, node, op),
			() =>
				this.engine.write(
					batchId === undefined ? undefined : batchId + this.batchIdBase,
					this.toEngine(node) as never,
					...opScalars(op),
				),
		)
		if (batchId === undefined) {
			this.mirrorQuietFold(node, op, mark)
		}
	}

	bareWrite(node: AtomNode, op: Op): void {
		const mark = this.model.events.length
		this.both(
			'bareWrite',
			() => this.model.bareWrite(node, op),
			() => this.engine.bareWrite(this.toEngine(node) as never, ...opScalars(op)),
		)
		this.mirrorQuietFold(node, op, mark)
	}

	/** A quiet fold advances the engine's base with no log entry, so the
	 * mirror's `onLogEntryDrop` feed never sees it. The driver
	 * appends the fold's ledger entry to the mirror archive itself — exactly
	 * what the model's quietWrite does to ITS archive — so the view's
	 * full-history shadow fold (retention invariant) keeps reconstructing
	 * every world. Detection is by the model's own 'quiet-write' event
	 * (compareStreams already proved the engine created the same one). */
	private mirrorQuietFold(node: AtomNode, op: Op, mark: number): void {
		for (const e of this.model.events.slice(mark)) {
			if (e.type !== 'quiet-write') {
				continue
			}
			const eInternals = this.toEngine(node) as EAtomInternals
			this.mirror
				.archiveOf(eInternals)
				.push({ op, batch: 0, slot: -1, seq: e.seq, retiredSeq: e.seq })
		}
	}

	settleAction(batchId: number): void {
		this.both(
			'settleAction',
			() => this.model.settleAction(batchId),
			() => this.engine.settleAction(batchId + this.batchIdBase),
		)
	}

	retire(batchId: number): void {
		this.both(
			'retire',
			() => this.model.retire(batchId),
			() => this.engine.retire(batchId + this.batchIdBase),
		)
	}

	renderStart(root: string, includeBatches: number[]): RenderPass {
		let eRenderPass: ERenderPass | undefined
		const mRenderPass = this.both(
			'renderStart',
			() => this.model.renderStart(root, includeBatches),
			() => {
				eRenderPass = this.engine.renderStart(
					root,
					includeBatches.map((id) => id + this.batchIdBase),
				)
				return eRenderPass
			},
		)
		expect(eRenderPass!.id, 'twin renderStart: render pass ids diverged').toBe(mRenderPass.id)
		expect(eRenderPass!.pin, 'twin renderStart: pins diverged').toBe(mRenderPass.pin)
		this.idToEngineRenderPass.set(mRenderPass.id, eRenderPass!)
		return mRenderPass
	}

	renderYield(id: number): void {
		this.both(
			'renderYield',
			() => this.model.renderYield(id),
			() => this.engine.renderYield(id),
		)
	}

	renderResume(id: number): void {
		this.both(
			'renderResume',
			() => this.model.renderResume(id),
			() => this.engine.renderResume(id),
		)
	}

	renderEnd(id: number, kind: 'commit' | 'discard', opts?: { retireAtCommit?: number[] }): void {
		const eOpts =
			opts?.retireAtCommit === undefined
				? opts
				: { ...opts, retireAtCommit: opts.retireAtCommit.map((b) => b + this.batchIdBase) }
		this.both(
			'renderEnd',
			() => this.model.renderEnd(id, kind, opts),
			() => this.engine.renderEnd(id, kind, eOpts),
		)
	}

	mountWatcher(renderPassId: number, node: AnyNode, name: string): Watcher {
		let eId: number | undefined
		const w = this.both(
			'mountWatcher',
			() => this.model.mountWatcher(renderPassId, node, name),
			() => {
				eId = this.engine.mountWatcher(renderPassId, this.toEngine(node), name).id
			},
		)
		expect(eId, 'twin mountWatcher: watcher ids diverged').toBe(w.id)
		return w
	}

	renderWatcher(renderPassId: number, watcherId: number): void {
		this.both(
			'renderWatcher',
			() => this.model.renderWatcher(renderPassId, watcherId),
			() => this.engine.renderWatcher(renderPassId, watcherId),
		)
	}

	deferMountEffects(watcherId: number): void {
		this.both(
			'deferMountEffects',
			() => this.model.deferMountEffects(watcherId),
			() => this.engine.deferMountEffects(watcherId),
		)
	}

	adoptRevealedMount(renderPassId: number, watcherId: number): void {
		this.both(
			'adoptRevealedMount',
			() => this.model.adoptRevealedMount(renderPassId, watcherId),
			() => this.engine.adoptRevealedMount(renderPassId, watcherId),
		)
	}

	mountReactEffect(root: string, node: AnyNode, name: string): ReactEffect {
		let eId: number | undefined
		const e = this.both(
			'mountReactEffect',
			() => this.model.mountReactEffect(root, node, name),
			() => {
				eId = mountEngineReactEffect(this.engine, root, this.toEngine(node), name).id
			},
		)
		this.effectMap.set(e.id, eId!)
		return e
	}

	mountReactEffectPick(
		root: string,
		sel: AnyNode,
		a: AnyNode,
		b: AnyNode,
		name: string,
	): ReactEffect {
		let eId: number | undefined
		const e = this.both(
			'mountReactEffectPick',
			() => this.model.mountReactEffectPick(root, sel, a, b, name),
			() => {
				eId = mountEngineReactEffectPick(
					this.engine,
					root,
					this.toEngine(sel),
					this.toEngine(a),
					this.toEngine(b),
					name,
				).id
			},
		)
		this.effectMap.set(e.id, eId!)
		return e
	}

	removeReactEffect(id: number): void {
		this.both(
			'removeReactEffect',
			() => this.model.removeReactEffect(id),
			() => this.engine.removeSignalEffect(this.toEngineEffect(id)),
		)
	}

	replayReactEffect(id: number): void {
		this.both(
			'replayReactEffect',
			() => this.model.replayReactEffect(id),
			() => this.engine.replaySignalEffect(this.toEngineEffect(id)),
		)
	}

	mountCoreEffect(node: AnyNode, name: string, writeTo?: AtomNode): CoreEffect {
		return this.both(
			'mountCoreEffect',
			() => this.model.mountCoreEffect(node, name, writeTo),
			() =>
				mountEngineCoreEffect(
					this.engine,
					this.toEngine(node),
					name,
					writeTo === undefined ? undefined : (this.toEngine(writeTo) as EAtomInternals),
				),
		)
	}

	discardAllWip(): void {
		this.both(
			'discardAllWip',
			() => this.model.discardAllWip(),
			() => this.engine.discardAllWip(),
		)
	}

	quiesce(): void {
		this.both(
			'quiesce',
			() => this.model.quiesce(),
			() => this.engine.quiesce(),
		)
		// Mirror the model's episode reset: archives belong to the dead episode;
		// origins reset to base (engine-side the view folds from these).
		this.mirror.clearArchives()
		this.mirror.originsFromBase(this.engine)
	}

	livePins(): number[] {
		const m = this.model.livePins()
		const e: number[] = []
		for (const p of this.engine.idToRenderPass.values()) {
			if (p.state !== 'ended') e.push(p.pin)
		}
		expect(e, 'twin livePins diverged').toEqual(m)
		return m
	}

	// ------------------------------------------------------- world reads

	newestValue(node: AnyNode): Value {
		const m = this.model.newestValue(node)
		const e = this.engine.newestValue(this.toEngine(node))
		expect(
			Object.is(m, e),
			`twin newestValue(${node.name}): model ${String(m)} ≠ engine ${String(e)}`,
		).toBe(true)
		return m
	}

	committedValue(node: AnyNode, root: string): Value {
		const m = this.model.committedValue(node, root)
		const e = this.engine.committedValue(this.toEngine(node), root)
		expect(
			Object.is(m, e),
			`twin committedValue(${node.name}, ${root}): model ${String(m)} ≠ engine ${String(e)}`,
		).toBe(true)
		return m
	}

	renderValue(node: AnyNode, render: RenderPass): Value {
		const m = this.model.renderValue(node, render)
		const e = this.engine.renderValue(this.toEngine(node), this.toEngineRenderPass(render))
		expect(
			Object.is(m, e),
			`twin renderValue(${node.name}, render pass ${render.id}): model ${String(m)} ≠ engine ${String(e)}`,
		).toBe(true)
		return m
	}

	eventsOfType<T extends ModelEvent['type']>(type: T): Extract<ModelEvent, { type: T }>[] {
		const m = this.model.eventsOfType(type)
		if (type !== 'delivery' && type !== 'suppressed' && type !== 'mount-corrective') {
			const e = this.normalizedEngineEvents().filter((ev) => ev.type === type)
			expect(JSON.stringify(e), `twin eventsOfType(${type}) diverged`).toBe(JSON.stringify(m))
		}
		// deliveryish types: covered cumulatively by compareStreams' ⊆ bound;
		// the test bodies' assertions pin the reference model's required outcomes.
		return m
	}

	eventsSince(mark: number): ModelEvent[] {
		// Marks are model-stream positions; deliveryish lag means the engine
		// stream's positions no longer align 1:1. The full-stream comparison
		// in compareStreams (after EVERY op) already pins the non-delivery
		// stream exactly and bounds deliveries cumulatively, so the window
		// compare adds nothing — return the model's window (the required
		// outcomes the test bodies assert).
		return this.model.eventsSince(mark)
	}

	/** Full parity + invariants on both sides + the engine-only "K0 parity" check. */
	verify(): void {
		this.compareStreams('verify')
		expect(JSON.stringify(snapshotModel(this.view)), 'twin observable snapshots diverged').toBe(
			JSON.stringify(snapshotModel(this.model)),
		)
		checkInvariants(this.model)
		checkInvariants(this.view)
		// Eager-apply invariant: writes land in the kernel immediately, so the
		// kernel's newest value must equal replaying the log entries over the base.
		for (const n of this.engine.idToInternals.values()) {
			if (n.kind !== 'atom') {
				continue
			}
			const folded = this.engine.foldAtom(n, { kind: 'newest' })
			const kernel = this.engine.newestValue(n)
			expect(
				Object.is(folded, kernel),
				`K0 parity: atom ${n.name} kernel ${String(kernel)} ≠ fold ${String(folded)}`,
			).toBe(true)
		}
	}
}

/**
 * Finish the PREVIOUS test's leftover episode so the reset's idle
 * preconditions hold (the fresh-model analog: a test may legitimately end
 * mid-episode — the old per-test engines were simply abandoned; the one
 * engine instead closes the episode out, exactly as the schedule
 * generator's close-out does). The reset preconditions still fail loudly
 * for a reset attempted INSIDE any frame — that stays a bug to fix.
 */
function drainLeftoverEpisode(): void {
	engine.discardAllWip()
	for (const t of engine.liveBatches()) {
		if (t.parked) {
			engine.settleAction(t.id)
		} else {
			engine.retire(t.id)
		}
	}
}

/** A fresh lockstep harness (always-concurrent: construction is activation — the
 * engine resets and re-attaches its minimal driver; the model is live from
 * construction). */
export function concurrent(): TwinDriver {
	return new TwinDriver()
}

/** Mount a watcher on `node` via a clean committed render on `root`. */
export function mountCommitted(m: TwinDriver, root: string, node: AnyNode, name: string): Watcher {
	const p = m.renderStart(root, [])
	const w = m.mountWatcher(p.id, node, name)
	m.renderEnd(p.id, 'commit')
	return w
}

/** Render `batch` on `root` (watchers re-rendered), commit, retire the batch. */
export function commitAndRetire(
	m: TwinDriver,
	root: string,
	batch: Batch,
	watchers: Watcher[] = [],
): void {
	const p = m.renderStart(root, [batch.id])
	for (const w of watchers) {
		m.renderWatcher(p.id, w.id)
	}
	m.renderEnd(p.id, 'commit', { retireAtCommit: [batch.id] })
}

/** Open a render pass including the given batches. */
export function openRender(m: TwinDriver, root: string, batches: Batch[]): RenderPass {
	return m.renderStart(
		root,
		batches.map((t) => t.id),
	)
}

/** Full lockstep verification (events, snapshots, invariants both sides, kernel-value parity). */
export function selfCheck(m: TwinDriver): void {
	m.verify()
}

export function set(value: unknown): { kind: 'set'; value: unknown } {
	return { kind: 'set', value }
}

export function update(fn: (p: unknown) => unknown): {
	kind: 'update'
	fn: (p: unknown) => unknown
} {
	return { kind: 'update', fn }
}

/** The comparison boundary's op conversion: specs and the model speak op
 * literals (`set`/`update` above — the reference model's vocabulary); the
 * ENGINE's write surface takes the scalar (kind, payload) pair (0 = set,
 * 1 = update), so the harness converts exactly here, at the engine dispatch. */
export function opScalars(op: Op): [0 | 1, unknown] {
	return op.kind === 'set' ? [0, op.value] : [1, op.fn]
}
