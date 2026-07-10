/**
 * `cosignals/trace` — the lazily loaded diagnostics entry: a zero-allocation
 * event recorder for the concurrent engine. It answers
 * "why did this component re-render / this effect run / this value change?"
 * without perturbing the engine it observes. The disciplines it holds:
 *
 *  - when no tracer is attached, the engine's entire tracing cost is one
 *    nullable-field check per event site (asserted over the source by
 *    tests/trace-off.spec.ts);
 *  - recording an event allocates nothing: instrumentation sites pass
 *    scalars straight into typed record methods, which write fixed-size
 *    integer records into preallocated buffers (one documented exception:
 *    a react-effect-run's dep-values array is built by its emit site — only
 *    while a tracer is attached — because the model-comparison suites
 *    compare it);
 *  - two capture modes — a ring (flight recorder) and a session (lossless
 *    capture up to a byte budget);
 *  - every record names the event that provoked it, so causality is
 *    queryable after the fact.
 *
 * ## Loading and cost
 * This module imports the engine as types only — its runtime module graph is
 * exactly {Tracer.ts}, and the engine module never imports it back, so neither
 * entry pulls the other into a bundle. Until `attachTracer(engine)` runs,
 * the engine's only tracing artifact is its `trace` slot, `undefined`
 * forever, checked once per emit site (tests/trace-off.spec.ts asserts the
 * discipline; the kernel itself contains no tracing instructions at all).
 * `tracer.stop()` detaches at runtime; attaching again later
 * records a fresh capture.
 *
 * ## The recorder
 * Trace events are fixed-size integer records (stride 8 × Int32Array):
 * `[KIND|flags, CAUSE, SUBJECT, WORLD, DT, ARG0, ARG1, ARG2]`. The emit path
 * performs integer stores plus one clock read — no per-event allocation —
 * so tracing an engine that itself avoids allocation does not manufacture
 * GC pressure on its behalf. Strings never enter records: labels
 * (node/watcher/effect names, roots) intern once into
 * a label table; rare object payloads (correction from/to values, effect
 * values) go to a bounded ref-ring that may extend object lifetimes until
 * overwritten (capacity configurable, 0 disables capture — events still
 * record, payloads decode as REF_DROPPED). Event ids are dense and monotonic
 * from 0: an id names an event and locates it (`id & (capacity-1)` in RING;
 * `chunks[id >> log2(chunkSize)]` in SESSION), so losslessness is provable,
 * not promised (`verifyComplete()`).
 *
 * Two modes, one emit path (the mode branch is taken only at chunk/ring
 * boundaries):
 *  - RING(capacity): the flight recorder — one buffer, oldest overwritten;
 *    loss is expected and counted (`stats().dropped`). Default 2^16 records.
 *  - SESSION(chunkSize, maxBytes): the lossless capture — a filled chunk is
 *    sealed (immutable) and a new fixed-size chunk is appended; nothing is
 *    ever copied. If the next chunk would cross `maxBytes`, a loud
 *    `truncation` event records the boundary and the recorder degrades to
 *    RING behavior over the final chunk; `stats().truncated` flips. To trace
 *    a whole boot losslessly, attach before the engine's first operation.
 *
 * ## Event vocabulary (kind → decoded `data` fields, in format order)
 * Terms as in the package README: a *log entry* records one write on the
 * written atom's history; a *batch* (identified by a BatchId) groups the
 * writes of one UI update; a *slot* is one of 31 tracking entries a written
 * batch occupies while its writes can still matter (31 because React
 * schedules work on 31 "lanes" — its internal units of priority; slots are
 * recycled); a *render pass* is one render of one root,
 * whose *pin* is the timeline position it froze at start; a *watcher* is
 * one mounted UI subscription; *retirement* makes a batch's writes
 * permanent history; a *world* is one self-consistent view of all values.
 *
 *  write                {node, op, batch, slot, seq}         a write was recorded: a log entry joined the atom's history
 *  quiet-write          {node, seq}                          a quiet-mode fold: nothing was pending, so the write folded straight into committed state (no batch, no log entry)
 *  write-dropped        {node, batch}                        dropped without a log entry: the atom had no pending log entries and the op produced a value equal to the current one
 *  batch-open           {batch, action, ambient}             a batch opened (action = async action; ambient = engine-opened batch adopting writes made outside any explicit batch)
 *  batch-settle         {batch}                              an async action's promise settled; its retirement follows
 *  batch-retire         {batch, retiredSeq}                  the batch retired: its writes became permanent history visible to every world
 *  batch-disposition    {batch, committed}                   the React bindings' report, recorded at its source (the protocol handler):
 *                       React committed (true) or abandoned (false) the batch. Diagnostic only — retirement behavior is identical
 *                       either way. The engine never creates this kind. (A batch-settle / batch-retire record may also carry the
 *                       flag as a KIND-field bit; the decoder ignores it there.)
 *  slot-claim           {slot, batch}                        a batch's first write claimed a slot
 *  slot-release         {slot, batch}
 *  slot-release-deferred{slot, batch}                        release waited: an open render's mask still names the slot
 *  slot-backstop-release{slot, batch}                        slot table full: the oldest deferred slot was released anyway, loudly
 *  render-start           {renderPass, root, pin, maskSize}    a render pass began; mask = the batches it may see
 *  render-yield           {renderPass, root}                   the render paused (concurrent rendering runs in interruptible slices)
 *  render-resume          {renderPass, root}
 *  render-end             {renderPass, root, disposition}      commit | discard; fires before its consequences
 *  root-commit          {root, batch, commitGen}             the root locked in a batch: its committed world now includes those writes
 *  delivery             {watcher, batch, slot, seq, mode}    a write told this watcher to re-render (deliveries are value-blind; fresh | interleaved, see below)
 *  suppressed           {watcher, batch, slot, seq, reason}  delivery skipped: a scheduled-but-unstarted re-render will fold this write anyway ('dedup-pending-fold')
 *  eval                 {node, world, durationUs, depth}     one computed evaluation in one world (newest | render:N | committed:root | mount-fix:root)
 *  mount-corrective     {watcher, batch, slot}               at mount, a corrective re-render was scheduled for a live batch the mounting render did not include
 *  mount-fixup          {watcher, root, disposition, correctives}  how the mount-window check resolved:
 *                       fast-out (provably nothing moved; drift, if any, is exactly the live-batch writes
 *                       already covered by scheduled correctives) | compare-clean (values agree) |
 *                       corrected (urgent fix applied). The decoder also accepts a fourth disposition,
 *                       'fast-out-covered', which no engine emit site produces.
 *  mount-correction     {watcher, from, to}                  the urgent pre-paint fix: committed truth moved while the mounting render was in flight
 *  reconcile-correction {watcher, root, from, to, cause}     a retirement or root commit moved committed truth; this watcher's on-screen value had to follow
 *  core-effect-run      {effect, value}                      a core effect ran (core effects observe the newest world)
 *  react-effect-run     {effect, root, value, values?}       a committed SignalEffect ran; values = trace-only reads from that run
 *  react-effect-cleanup {effect, root}                       a committed-world observer's cleanup ran (before a re-run, or at removal)
 *  render-committed       {renderPass, root}                   checkpoint marker: the commit's consequences (retirement folds, lock-ins, drains, fixups) have all landed
 *  render-discarded       {renderPass, root}                   checkpoint marker: the discard's consequences have all landed
 *  epoch-reset          {epoch}                              quiescence: nothing in flight, so the engine reset its per-episode state
 *  clock-sync           {absoluteUs}                         emitted when DT saturates
 *  truncation           {boundaryId}                         SESSION budget crossed
 *
 * A delivery is `interleaved` when a re-render for that (watcher, slot) was
 * already pending but the root's in-progress render froze (pinned) before
 * this write — that render's world cannot show the write, so the watcher
 * must be told again; `suppressed` is the safe case where pending work will
 * pick the write up.
 *
 * ## CAUSALITY
 * Every record's CAUSE names the event that provoked it (walk with
 * `causeChain`). The engine emits through hooks rather than tracking causes
 * itself, so the tracer keeps the causality register: provoking kinds
 * (write, write-dropped, batch-settle, batch-retire,
 * render-start/yield/resume/end, root-commit, epoch-reset) record the old
 * register as their CAUSE and then claim it; consequence kinds (deliveries,
 * suppressions, slot transitions, evals, corrections, effect runs…) record
 * it untouched; the engine's `opEnd` hook clears it whenever a compound
 * public operation (a write, a render end, a retirement, a settlement, a
 * quiesce) finishes, so unrelated operations never chain. Chains are real
 * call chains: delivery ← its write; batch-retire inside a commit ← that
 * render-end; reconcile-correction ← its root-commit or retirement.
 *
 * ## Reading a trace
 * `tracer.events()` returns decoded `{id, kind, dt, cause, data}` objects
 * (the structured form for tools — a lazy view over the packed records,
 * never a second recorder); `decode(id)` one event; `formatTraceRecord(e)` /
 * `formatTrace(events)` the stable human form
 * `#id +Δµs kind(subject) k=v … [<- #cause]`. Queries: `causeChain(id)`,
 * `whyDelivered(watcher)`, `whyEffectRan(effect)`, `effectRunCount(effect)`.
 * Renderers live in `cosignals/graphviz` (`traceToDot`,
 * `dependencyGraphToDot`) — that entry imports only types from this one.
 * Note: engine sequence numbers are never rewritten (they climb for the
 * process's life, exact to 2^53), but trace records pack them into Int32
 * fields — so seq fields in records decode faithfully only below 2^31-1
 * created sequences. A diagnostics-fidelity bound, not an engine one.
 */

import type {
	AtomInternals,
	CommitGen,
	ComputedInternals,
	CosignalEngine,
	Epoch,
	RenderPass,
	WriteLogEntry,
	RootId,
	Seq,
	BatchSlot,
	Batch,
	BatchId,
	TraceHooks,
	Value,
	Watcher,
	World,
} from './CosignalEngine.js'

// ---- record layout ---------------------------------------------------------------
// Same-file const enums: esbuild-based toolchains inline the members as
// literals within one file, so the emit path indexes records with constants
// rather than variable loads.

// ---- semantic number types (plain aliases; zero runtime cost) ----
/** Dense, monotonic trace event id (from 0; also locates the record). */
type TraceEventId = number
/** A kind code — one of the `K` values (the low 6 bits of the KIND field). */
type TraceKindCode = number
/** A record's full KIND field: TraceKindCode | KindBits flag bits. */
type KindWord = number
/** Interned label-table id (0 reserved = no label). */
type LabelId = number
/** Absolute ref-ring index for a captured object payload (-1 = capture disabled). */
type RefId = number
/** A microsecond clock reading or duration. */
type Microseconds = number
/** The packed world encoding for eval records (see WorldPack). */
type PackedWorld = number

/** Field offsets within one packed trace record. */
const enum TraceField {
	KIND = 0, // kind code (low 6 bits) | kind-specific flags (bits 6..7)
	CAUSE = 1, // provoking event id + 1 (0 = operation root)
	SUBJECT = 2, // label id or entity id, per kind
	WORLD = 3, // world code, batch id, or root label, per kind
	DT = 4, // µs since the previous record (saturating; see clock-sync)
	ARG0 = 5,
	ARG1 = 6,
	ARG2 = 7,
}

/** Trace record geometry. */
const enum TraceRec {
	/** Int32 fields per record: (id & capMask) * STRIDE is the record's base index. */
	STRIDE = 8,
	/** Bytes per Int32 field (record bytes = records × STRIDE × BYTES_PER_FIELD). */
	BYTES_PER_FIELD = 4,
}

/** Bit layout of the KIND field. */
const enum KindBits {
	/** Low 6 bits: the kind code. */
	KIND_MASK = 63,
	/** Per kind: committed? | interleaved? | action? | mount-fix world? | per-root-commit cause? */
	FLAG_A = 64,
	/** Per kind: ambient? */
	FLAG_B = 128,
}

/** The packed world encoding for eval records (see worldCode). */
const enum WorldPack {
	/** Bit 0: this eval ran in a mount-fixup world. */
	MOUNT_FIX_BIT = 1,
	/** code >> PAYLOAD_SHIFT: 0 = newest | +renderPassId | −(rootLabel+1). */
	PAYLOAD_SHIFT = 1,
}

const MAX_I32 = 0x7fffffff

/** Kind codes (record form). Public decoded events carry the NAME, not the
 * code. Codes are append-only — existing recordings decode forever, and the
 * decoder accepts every listed code, including any the current engine never
 * emits. */
const K = {
	write: 1,
	writeDropped: 2,
	batchOpen: 3,
	batchSettle: 4,
	batchRetire: 5,
	slotClaim: 6,
	slotRelease: 7,
	slotReleaseDeferred: 8,
	slotBackstop: 9,
	renderStart: 10,
	renderYield: 11,
	renderResume: 12,
	renderEnd: 13,
	rootCommit: 14,
	delivery: 15,
	suppressed: 16,
	evalDone: 17,
	mountCorrective: 18,
	runMountFixup: 19,
	mountCorrection: 20,
	reconcileCorrection: 21,
	coreEffectRun: 22,
	reactEffectRun: 23,
	epochReset: 24,
	clockSync: 25,
	truncation: 26,
	quietWrite: 27,
	reactEffectCleanup: 28,
	renderCommitted: 29,
	renderDiscarded: 30,
	batchDisposition: 31,
} as const

const KIND_NAMES = [
	'',
	'write',
	'write-dropped',
	'batch-open',
	'batch-settle',
	'batch-retire',
	'slot-claim',
	'slot-release',
	'slot-release-deferred',
	'slot-backstop-release',
	'render-start',
	'render-yield',
	'render-resume',
	'render-end',
	'root-commit',
	'delivery',
	'suppressed',
	'eval',
	'mount-corrective',
	'mount-fixup',
	'mount-correction',
	'reconcile-correction',
	'core-effect-run',
	'react-effect-run',
	'epoch-reset',
	'clock-sync',
	'truncation',
	'quiet-write',
	'react-effect-cleanup',
	'render-committed',
	'render-discarded',
	'batch-disposition',
] as const

export type TraceKind = Exclude<(typeof KIND_NAMES)[number], ''>

/** Kinds that claim the causality register (operation provokers). */
const CAUSE_SETTING = new Set<TraceKindCode>([
	K.write,
	K.writeDropped,
	K.batchSettle,
	K.batchRetire,
	K.renderStart,
	K.renderYield,
	K.renderResume,
	K.renderEnd,
	K.rootCommit,
	K.epochReset,
])

const OP_NAMES = ['set', 'update'] as const
/** Index 1 ('fast-out-covered') is decode-only: no engine emit site
 * produces it; recordings that contain it still decode. */
const DISPOSITION_NAMES = ['fast-out', 'fast-out-covered', 'compare-clean', 'corrected'] as const

/** Decoded payload placeholder for a ref-ring value that was overwritten (or capture disabled). */
export const REF_DROPPED: unique symbol = Symbol('cosignals.trace.ref-dropped')

// ---- public types ----------------------------------------------------------------

export type TracerOptions = {
	/** 'ring' (flight recorder, default) or 'session' (lossless up to maxBytes). */
	mode?: 'ring' | 'session'
	/** RING record capacity; rounded up to a power of two. Default 2^16 (2 MiB). */
	capacity?: number
	/** SESSION records per chunk; rounded up to a power of two. Default 2^14. */
	chunkSize?: number
	/** SESSION lossless budget in bytes of record storage. Default 128 MiB. */
	maxBytes?: number
	/** Ref-ring capacity for object payloads; 0 disables capture. Default 256. */
	refCapacity?: number
	/** Microsecond clock; injectable for deterministic tests. Default performance.now()·1000. */
	now?: () => number
}

/** The structured (tool-facing) event: a lazy decode of one packed record. */
export type TraceRecord = {
	id: TraceEventId
	kind: TraceKind
	/** µs since the previous recorded event (0 for the first). */
	dt: number
	/** Provoking event id (walkable while retained), or undefined for operation roots. */
	cause: TraceEventId | undefined
	/** Kind-specific fields; see the vocabulary table in the module doc. */
	data: Record<string, unknown>
}

export type TraceStats = {
	mode: 'ring' | 'session'
	attached: boolean
	/** Total events ever recorded (the next id). */
	recorded: number
	/** Events currently decodable. */
	retained: number
	/** Lowest decodable id (0 iff nothing has been lost). */
	firstRetained: number
	/** recorded − retained (ring overwrites; session pre-truncation history is never dropped). */
	dropped: number
	/** SESSION only: the maxBytes budget was crossed (capture marked partial). */
	truncated: boolean
	chunks: number
	/** Record-storage bytes allocated. */
	bytes: number
	refsCaptured: number
}

/** Floor for the pow2-rounded capacities (ring, session chunk, ref ring). */
const POW2_CAPACITY_FLOOR = 8

function roundUpToPowerOfTwo(n: number, min: number): number {
	let c = min
	while (c < n) {
		c *= 2
	}
	return c
}

function defaultNow(): number {
	return performance.now() * 1000
}

/** Depth (entries) of the preallocated eval-pairing stacks — the three stack
 * columns below must stay equal; overflow degrades gracefully. */
const EVAL_STACK_DEPTH = 1024

// ---- the tracer ------------------------------------------------------------------

export class Tracer implements TraceHooks {
	private readonly engine: CosignalEngine
	private readonly mode: 'ring' | 'session'
	private readonly cap: number // ring capacity or session chunk size (records)
	private readonly capMask: number
	private readonly capLog: number
	private readonly maxBytes: number
	private readonly now: () => number
	private chunks: Int32Array[] = []
	private head: TraceEventId = 0 // next event id (dense, monotonic from 0)
	private truncatedFlag = false
	private causeReg = 0 // current cause id + 1; 0 = at an operation boundary
	private lastUs: Microseconds
	// label interning: id 0 reserved (= no label)
	private labels: string[] = ['']
	private labelIds = new Map<string, LabelId>()
	// ref-ring for rare object payloads (absolute indices detect overwrite)
	private readonly refCap: number
	private refs: unknown[]
	private refHead: RefId = 0
	// eval pairing stack (preallocated; overflow degrades gracefully)
	private evalSubj = new Int32Array(EVAL_STACK_DEPTH)
	private evalWorld = new Int32Array(EVAL_STACK_DEPTH)
	private evalT0: Microseconds[] = new Array<number>(EVAL_STACK_DEPTH).fill(0)
	private evalSp = 0
	private evalOverflow = 0

	constructor(engine: CosignalEngine, opts?: TracerOptions) {
		this.engine = engine
		this.mode = opts?.mode ?? 'ring'
		this.cap =
			this.mode === 'ring'
				? roundUpToPowerOfTwo(opts?.capacity ?? 1 << 16, POW2_CAPACITY_FLOOR)
				: roundUpToPowerOfTwo(opts?.chunkSize ?? 1 << 14, POW2_CAPACITY_FLOOR)
		this.capMask = this.cap - 1
		this.capLog = Math.log2(this.cap)
		this.maxBytes = opts?.maxBytes ?? 128 * 1024 * 1024
		this.refCap =
			opts?.refCapacity === undefined
				? 256
				: roundUpToPowerOfTwo(
						Math.max(opts.refCapacity, 0),
						opts.refCapacity === 0 ? 0 : POW2_CAPACITY_FLOOR,
					)
		this.refs = new Array<unknown>(this.refCap)
		this.now = opts?.now ?? defaultNow
		this.lastUs = this.now()
		this.chunks.push(new Int32Array(this.cap * TraceRec.STRIDE))
	}

	/** Detach from the engine: recording stops, the capture stays decodable. */
	stop(): void {
		if (this.engine.trace === this) {
			this.engine.trace = undefined
		}
	}

	get attached(): boolean {
		return this.engine.trace === this
	}

	// ------------------------------------------------------------ emit core

	private label(s: string): LabelId {
		const got = this.labelIds.get(s)
		if (got !== undefined) {
			return got
		}
		const id = this.labels.length
		this.labels.push(s)
		this.labelIds.set(s, id)
		return id
	}

	private ref(v: unknown): RefId {
		if (this.refCap === 0) {
			return -1
		}
		const idx = this.refHead & (this.refCap - 1)
		this.refs[idx] = v
		return this.refHead++
	}

	/**
	 * The record buffer for `id`, allocating/wrapping per mode. The offset is
	 * always `(id & capMask) * TraceRec.STRIDE` — returned buffer only, so the emit
	 * path allocates nothing.
	 */
	private bufFor(id: TraceEventId): Int32Array {
		if (this.mode === 'ring') {
			return this.chunks[0]!
		}
		const chunkIndex = id >> this.capLog
		if (this.truncatedFlag || chunkIndex < this.chunks.length) {
			return this.chunks[this.truncatedFlag ? this.chunks.length - 1 : chunkIndex]!
		}
		// chunk boundary: seal the current chunk, append the next — unless the
		// budget is crossed, in which case degrade to ring over the final chunk.
		const nextBytes =
			(this.chunks.length + 1) * this.cap * TraceRec.STRIDE * TraceRec.BYTES_PER_FIELD
		if (nextBytes > this.maxBytes) {
			this.truncatedFlag = true
			return this.chunks[this.chunks.length - 1]!
		}
		this.chunks.push(new Int32Array(this.cap * TraceRec.STRIDE))
		return this.chunks[this.chunks.length - 1]!
	}

	/** The one write path: id creation, time delta, cause register, 8 integer stores. */
	private rec(
		kindFlags: KindWord,
		subject: number,
		world: number,
		a0: number,
		a1: number,
		a2: number,
	): TraceEventId {
		const t = this.now()
		let dt = Math.round(t - this.lastUs)
		this.lastUs = t
		if (dt > MAX_I32 || dt < 0) {
			dt = 0
			const abs = Math.round(t)
			this.recRaw(K.clockSync, 0, 0, 0, Math.floor(abs / MAX_I32), abs % MAX_I32, 0)
		}
		return this.recRaw(kindFlags, subject, world, dt, a0, a1, a2)
	}

	private recRaw(
		kindFlags: KindWord,
		subject: number,
		world: number,
		dt: number,
		a0: number,
		a1: number,
		a2: number,
	): TraceEventId {
		// SESSION truncation boundary: mark loudly before the event that crossed it.
		const preTrunc = this.truncatedFlag
		const id = this.head++
		const buf = this.bufFor(id)
		const at = (id & this.capMask) * TraceRec.STRIDE
		if (this.mode === 'session' && this.truncatedFlag && !preTrunc) {
			// the budget check inside slotFor flipped the flag for THIS id: record
			// the boundary marker here, then re-emit the caller's event after it.
			buf[at] = K.truncation
			buf[at + TraceField.CAUSE] = 0
			buf[at + TraceField.SUBJECT] = 0
			buf[at + TraceField.WORLD] = 0
			buf[at + TraceField.DT] = dt
			buf[at + TraceField.ARG0] = id | 0
			buf[at + TraceField.ARG1] = 0
			buf[at + TraceField.ARG2] = 0
			return this.recRaw(kindFlags, subject, world, 0, a0, a1, a2)
		}
		buf[at] = kindFlags | 0
		buf[at + TraceField.CAUSE] = this.causeReg | 0
		buf[at + TraceField.SUBJECT] = subject | 0
		buf[at + TraceField.WORLD] = world | 0
		buf[at + TraceField.DT] = dt | 0
		buf[at + TraceField.ARG0] = a0 | 0
		buf[at + TraceField.ARG1] = a1 | 0
		buf[at + TraceField.ARG2] = a2 | 0
		if (CAUSE_SETTING.has(kindFlags & KindBits.KIND_MASK)) {
			this.causeReg = id + 1
		}
		return id
	}

	/**
	 * World encoding for eval records, packed allocation-free: bit 0 = mount-fix,
	 * rest = 0 newest | +renderPassId | −(rootLabel+1) for committed/mount-fix worlds.
	 */
	private worldCode(world: World): PackedWorld {
		switch (world.kind) {
			case 'newest':
				return 0
			case 'render':
				return world.render.id << WorldPack.PAYLOAD_SHIFT
			case 'committed':
				return -(this.label(world.root) + 1) << WorldPack.PAYLOAD_SHIFT
			case 'mountFix':
				return (-(this.label(world.root) + 1) << WorldPack.PAYLOAD_SHIFT) | WorldPack.MOUNT_FIX_BIT
		}
	}

	// ------------------------------------------------- TraceHooks (the seam)
	// The engine's instrumentation sites call these DIRECTLY with scalars and
	// live engine objects — there is no intermediate event object and no
	// second channel. Each method is one `rec()` call packing the same field
	// layout the old object→packed re-encoding produced, so recordings stay
	// decode-compatible across the migration.

	writeDropped(node: AtomInternals, batch: BatchId): void {
		this.rec(K.writeDropped, this.label(node.name), batch, 0, 0, 0)
	}

	quietWrite(node: AtomInternals, seq: Seq): void {
		// Packed like a write, minus the batch attribution a quiet fold does
		// not have. Deliberately NOT a cause-claiming kind: the quiet fold's
		// operation does not emit an opEnd, so claiming the register here
		// would chain unrelated later operations to it.
		this.rec(K.quietWrite, this.label(node.name), 0, seq, 0, 0)
	}

	delivery(w: Watcher, batch: BatchId, slot: BatchSlot, seq: Seq, interleaved: boolean): void {
		this.rec(
			K.delivery | (interleaved ? KindBits.FLAG_A : 0),
			this.label(w.name),
			batch,
			slot,
			seq,
			0,
		)
	}

	suppressed(w: Watcher, batch: BatchId, slot: BatchSlot, seq: Seq): void {
		this.rec(K.suppressed, this.label(w.name), batch, slot, seq, 0)
	}

	coreEffectRun(effect: string, value: Value): void {
		this.rec(K.coreEffectRun, this.label(effect), 0, this.ref(value), 0, 0)
	}

	/** ARG1 stores ref(values)+1 — 0 means "not captured", so recordings made
	 * before dep-value capture (ARG1 always 0) decode unchanged. The `values`
	 * array is the one payload an emit site allocates (tracer-attached only):
	 * the model-comparison suites compare it entry by entry. */
	reactEffectRun(effect: string, root: RootId, value: Value, values: Value[]): void {
		this.rec(
			K.reactEffectRun,
			this.label(effect),
			this.label(root),
			this.ref(value),
			this.ref(values) + 1,
			0,
		)
	}

	reactEffectCleanup(effect: string, root: RootId): void {
		this.rec(K.reactEffectCleanup, this.label(effect), this.label(root), 0, 0, 0)
	}

	reconcileCorrection(
		w: Watcher,
		root: RootId,
		from: Value,
		to: Value,
		perRootCommit: boolean,
	): void {
		this.rec(
			K.reconcileCorrection | (perRootCommit ? KindBits.FLAG_A : 0),
			this.label(w.name),
			this.label(root),
			this.ref(from),
			this.ref(to),
			0,
		)
	}

	mountCorrective(w: Watcher, batch: BatchId, slot: BatchSlot): void {
		this.rec(K.mountCorrective, this.label(w.name), batch, slot, 0, 0)
	}

	mountCorrection(w: Watcher, from: Value, to: Value): void {
		this.rec(K.mountCorrection, this.label(w.name), 0, this.ref(from), this.ref(to), 0)
	}

	/** The site passes the root's generation (already bumped) — the tracer no
	 * longer reads engine state to enrich the record. */
	perRootCommit(root: RootId, batch: BatchId, commitGen: CommitGen): void {
		this.rec(K.rootCommit, batch, this.label(root), commitGen, 0, 0)
	}

	retired(batch: BatchId, retiredSeq: Seq): void {
		this.rec(K.batchRetire, batch, 0, retiredSeq, 0, 0)
	}

	slotClaimed(slot: BatchSlot, batch: BatchId): void {
		this.rec(K.slotClaim, slot, batch, 0, 0, 0)
	}

	slotReleased(slot: BatchSlot, batch: BatchId): void {
		this.rec(K.slotRelease, slot, batch, 0, 0, 0)
	}

	slotBackstopReleased(slot: BatchSlot, batch: BatchId): void {
		this.rec(K.slotBackstop, slot, batch, 0, 0, 0)
	}

	/** Post-consequence checkpoint markers (unlike `renderEnd`, which fires before
	 * the end's consequences so they can cite it as cause): these record after
	 * every retirement fold / lock-in / drain / fixup of the render end landed —
	 * the stream position the reference model emits its render events at. */
	renderCommitted(p: RenderPass): void {
		this.rec(K.renderCommitted, p.id, this.label(p.root), 0, 0, 0)
	}

	renderDiscarded(p: RenderPass): void {
		this.rec(K.renderDiscarded, p.id, this.label(p.root), 0, 0, 0)
	}

	epochReset(epoch: Epoch): void {
		this.rec(K.epochReset, epoch, 0, 0, 0, 0)
	}

	logEntry(node: AtomInternals, entry: WriteLogEntry): void {
		const op = OP_NAMES.indexOf(entry.op.kind) // encoder and decoder share OP_NAMES (cold path)
		this.rec(K.write, this.label(node.name), entry.batch, entry.slot, entry.seq, op)
	}

	batchOpen(t: Batch): void {
		this.rec(
			K.batchOpen | (t.action ? KindBits.FLAG_A : 0) | (t.ambient ? KindBits.FLAG_B : 0),
			t.id,
			0,
			0,
			0,
			0,
		)
	}

	batchSettle(t: Batch): void {
		this.rec(K.batchSettle, t.id, 0, 0, 0, 0)
	}

	/** The bindings' committed/abandoned report, created at its source (the
	 * protocol handler that received it) — the engine never calls this hook.
	 * Not a cause-claiming kind: the retirement operation it precedes roots
	 * its own chain, exactly as it did when the flag rode the engine call. */
	batchDisposition(batch: BatchId, committed: boolean): void {
		this.rec(K.batchDisposition | (committed ? KindBits.FLAG_A : 0), batch, 0, 0, 0, 0)
	}

	renderStart(p: RenderPass): void {
		this.rec(K.renderStart, p.id, this.label(p.root), p.pin, p.maskBatches.size, 0)
	}

	renderYield(p: RenderPass): void {
		this.rec(K.renderYield, p.id, this.label(p.root), 0, 0, 0)
	}

	renderResume(p: RenderPass): void {
		this.rec(K.renderResume, p.id, this.label(p.root), 0, 0, 0)
	}

	renderEnd(p: RenderPass, kind: 'commit' | 'discard'): void {
		this.rec(
			K.renderEnd | (kind === 'commit' ? KindBits.FLAG_A : 0),
			p.id,
			this.label(p.root),
			0,
			0,
			0,
		)
	}

	evalStart(node: ComputedInternals, world: World): void {
		if (this.evalSp >= this.evalSubj.length) {
			this.evalOverflow++ // deeper than the preallocated stack: skip, stay paired
			return
		}
		this.evalSubj[this.evalSp] = this.label(node.name)
		this.evalWorld[this.evalSp] = this.worldCode(world)
		this.evalT0[this.evalSp] = this.now()
		this.evalSp++
	}

	evalEnd(): void {
		if (this.evalOverflow > 0) {
			this.evalOverflow--
			return
		}
		if (this.evalSp === 0) {
			return
		} // attached mid-evaluation: nothing to pair
		this.evalSp--
		const packed: PackedWorld = this.evalWorld[this.evalSp]!
		const dur = Math.min(Math.round(this.now() - this.evalT0[this.evalSp]!), MAX_I32)
		this.rec(
			K.evalDone | ((packed & WorldPack.MOUNT_FIX_BIT) !== 0 ? KindBits.FLAG_A : 0),
			this.evalSubj[this.evalSp]!,
			packed >> WorldPack.PAYLOAD_SHIFT,
			dur,
			this.evalSp,
			0,
		)
	}

	slotReleaseDeferred(slot: BatchSlot, batch: BatchId): void {
		this.rec(K.slotReleaseDeferred, slot, batch, 0, 0, 0)
	}

	runMountFixup(
		w: Watcher,
		disposition: 'fast-out' | 'compare-clean' | 'corrected',
		correctives: number,
	): void {
		this.rec(
			K.runMountFixup,
			this.label(w.name),
			this.label(w.root),
			DISPOSITION_NAMES.indexOf(disposition),
			correctives,
			0,
		)
	}

	opEnd(): void {
		this.causeReg = 0
	}

	// -------------------------------------------------- retention and decode

	/** Lowest id still decodable. */
	private firstRetained(): TraceEventId {
		if (this.mode === 'ring') {
			return Math.max(0, this.head - this.cap)
		}
		return 0 // session: the sealed prefix is never dropped
	}

	private isRetained(id: TraceEventId): boolean {
		if (id < 0 || id >= this.head) {
			return false
		}
		if (this.mode === 'ring') {
			return id >= this.head - this.cap
		}
		if (!this.truncatedFlag) {
			return true
		}
		const sealedEnd = (this.chunks.length - 1) * this.cap
		return id < sealedEnd || id >= this.head - this.cap
	}

	/** Read a raw record field without decoding (queries walk records this way). */
	private peek(id: TraceEventId, field: TraceField): number {
		const buf =
			this.mode === 'ring'
				? this.chunks[0]!
				: this.chunks[
						this.truncatedFlag && id >= (this.chunks.length - 1) * this.cap
							? this.chunks.length - 1
							: id >> this.capLog
					]!
		return buf[(id & this.capMask) * TraceRec.STRIDE + field]!
	}

	private refValue(refId: RefId): unknown {
		if (refId < 0 || this.refHead - refId > this.refCap) {
			return REF_DROPPED
		}
		return this.refs[refId & (this.refCap - 1)]
	}

	private labelOf(id: LabelId): string {
		return this.labels[id] ?? `?label:${id}`
	}

	private worldName(code: number, mountFix: boolean): string {
		if (code === 0) {
			return 'newest'
		}
		if (code > 0) {
			return `render:${code}`
		}
		const root = this.labelOf(-code - 1)
		return mountFix ? `mount-fix:${root}` : `committed:${root}`
	}

	/** Decode one event; undefined once overwritten (RING) or never recorded. */
	decode(id: TraceEventId): TraceRecord | undefined {
		if (!this.isRetained(id)) {
			return undefined
		}
		const kf = this.peek(id, TraceField.KIND)
		const kind: TraceKindCode = kf & KindBits.KIND_MASK
		const a = (kf & KindBits.FLAG_A) !== 0
		const b = (kf & KindBits.FLAG_B) !== 0
		const cause = this.peek(id, TraceField.CAUSE)
		const subject = this.peek(id, TraceField.SUBJECT)
		const world = this.peek(id, TraceField.WORLD)
		const a0 = this.peek(id, TraceField.ARG0)
		const a1 = this.peek(id, TraceField.ARG1)
		const a2 = this.peek(id, TraceField.ARG2)
		let data: Record<string, unknown>
		switch (kind) {
			case K.write:
				data = { node: this.labelOf(subject), op: OP_NAMES[a2], batch: world, slot: a0, seq: a1 }
				break
			case K.writeDropped:
				data = { node: this.labelOf(subject), batch: world }
				break
			case K.quietWrite:
				data = { node: this.labelOf(subject), seq: a0 }
				break
			case K.batchOpen:
				data = { batch: subject, action: a, ambient: b }
				break
			case K.batchSettle:
				// (a FLAG_A bit here is a legacy committed flag from older
				// recordings — ignored; see batch-disposition.)
				data = { batch: subject }
				break
			case K.batchRetire:
				data = { batch: subject, retiredSeq: a0 } // legacy FLAG_A ignored, as above
				break
			case K.batchDisposition:
				data = { batch: subject, committed: a }
				break
			case K.slotClaim:
			case K.slotRelease:
			case K.slotReleaseDeferred:
			case K.slotBackstop:
				data = { slot: subject, batch: world }
				break
			case K.renderStart:
				data = { renderPass: subject, root: this.labelOf(world), pin: a0, maskSize: a1 }
				break
			case K.renderYield:
			case K.renderResume:
				data = { renderPass: subject, root: this.labelOf(world) }
				break
			case K.renderEnd:
				data = {
					renderPass: subject,
					root: this.labelOf(world),
					disposition: a ? 'commit' : 'discard',
				}
				break
			case K.rootCommit:
				data = { root: this.labelOf(world), batch: subject, commitGen: a0 }
				break
			case K.delivery:
				data = {
					watcher: this.labelOf(subject),
					batch: world,
					slot: a0,
					seq: a1,
					mode: a ? 'interleaved' : 'fresh',
				}
				break
			case K.suppressed:
				data = {
					watcher: this.labelOf(subject),
					batch: world,
					slot: a0,
					seq: a1,
					reason: 'dedup-pending-fold',
				}
				break
			case K.evalDone:
				data = {
					node: this.labelOf(subject),
					world: this.worldName(world, a),
					durationUs: a0,
					depth: a1,
				}
				break
			case K.mountCorrective:
				data = { watcher: this.labelOf(subject), batch: world, slot: a0 }
				break
			case K.runMountFixup:
				data = {
					watcher: this.labelOf(subject),
					root: this.labelOf(world),
					disposition: DISPOSITION_NAMES[a0],
					correctives: a1,
				}
				break
			case K.mountCorrection:
				data = { watcher: this.labelOf(subject), from: this.refValue(a0), to: this.refValue(a1) }
				break
			case K.reconcileCorrection:
				data = {
					watcher: this.labelOf(subject),
					root: this.labelOf(world),
					from: this.refValue(a0),
					to: this.refValue(a1),
					cause: a ? 'per-root-commit' : 'retirement',
				}
				break
			case K.coreEffectRun:
				data = { effect: this.labelOf(subject), value: this.refValue(a0) }
				break
			case K.reactEffectRun:
				data = {
					effect: this.labelOf(subject),
					root: this.labelOf(world),
					value: this.refValue(a0),
				}
				if (a1 !== 0) {
					data['values'] = this.refValue(a1 - 1)
				} // 0 = recorded before dep-value capture
				break
			case K.reactEffectCleanup:
				data = { effect: this.labelOf(subject), root: this.labelOf(world) }
				break
			case K.renderCommitted:
			case K.renderDiscarded:
				data = { renderPass: subject, root: this.labelOf(world) }
				break
			case K.epochReset:
				data = { epoch: subject }
				break
			case K.clockSync:
				data = { absoluteUs: a0 * MAX_I32 + a1 }
				break
			case K.truncation:
				data = { boundaryId: a0 }
				break
			default:
				return undefined
		}
		return {
			id,
			kind: KIND_NAMES[kind] as TraceKind,
			dt: this.peek(id, TraceField.DT),
			cause: cause === 0 ? undefined : cause - 1,
			data,
		}
	}

	/** All retained events, oldest first (optionally one kind). The tool-facing view. */
	events(kind?: TraceKind): TraceRecord[] {
		const out: TraceRecord[] = []
		for (let id = this.firstRetained(); id < this.head; id++) {
			if (!this.isRetained(id)) {
				continue
			}
			if (
				kind !== undefined &&
				KIND_NAMES[this.peek(id, TraceField.KIND) & KindBits.KIND_MASK] !== kind
			) {
				continue
			}
			const e = this.decode(id)
			if (e !== undefined) {
				out.push(e)
			}
		}
		return out
	}

	// ------------------------------------------------------ causality queries

	/** The event and its provokers, event first, walking CAUSE to the operation root. */
	causeChain(id: TraceEventId): TraceRecord[] {
		const out: TraceRecord[] = []
		let cur: number | undefined = id
		while (cur !== undefined) {
			const e = this.decode(cur)
			if (e === undefined) {
				break
			} // fell off the retained window
			out.push(e)
			cur = e.cause
		}
		return out
	}

	/** Newest retained event of `kind` whose subject label is `name` (packed scan). */
	private lastBySubject(kinds: TraceKindCode[], name: string): TraceEventId | undefined {
		const label = this.labelIds.get(name)
		if (label === undefined) {
			return undefined
		}
		for (let id = this.head - 1; id >= this.firstRetained(); id--) {
			if (!this.isRetained(id)) {
				continue
			}
			if (
				kinds.includes(this.peek(id, TraceField.KIND) & KindBits.KIND_MASK) &&
				this.peek(id, TraceField.SUBJECT) === label
			) {
				return id
			}
		}
		return undefined
	}

	/** Why did this watcher last re-render (or get suppressed/corrected)? The cause chain. */
	whyDelivered(watcher: string): TraceRecord[] {
		const id = this.lastBySubject(
			[K.delivery, K.suppressed, K.mountCorrective, K.mountCorrection, K.reconcileCorrection],
			watcher,
		)
		return id === undefined ? [] : this.causeChain(id)
	}

	/** Why did this effect last run? The cause chain. */
	whyEffectRan(effect: string): TraceRecord[] {
		const id = this.lastBySubject([K.coreEffectRun, K.reactEffectRun], effect)
		return id === undefined ? [] : this.causeChain(id)
	}

	/** Retained run count for an effect label (packed scan; decodes nothing). */
	effectRunCount(effect: string): number {
		const label = this.labelIds.get(effect)
		if (label === undefined) {
			return 0
		}
		let n = 0
		for (let id = this.firstRetained(); id < this.head; id++) {
			if (!this.isRetained(id)) {
				continue
			}
			const k = this.peek(id, TraceField.KIND) & KindBits.KIND_MASK
			if (
				(k === K.coreEffectRun || k === K.reactEffectRun) &&
				this.peek(id, TraceField.SUBJECT) === label
			) {
				n++
			}
		}
		return n
	}

	// ---------------------------------------------------------------- stats

	/** SESSION losslessness proof: dense ids from 0 with no truncation marker. */
	verifyComplete(): { complete: boolean; from: number; to: number } {
		const from = this.firstRetained()
		return { complete: from === 0 && !this.truncatedFlag, from, to: this.head - 1 }
	}

	stats(): TraceStats {
		const retained =
			this.mode === 'ring'
				? Math.min(this.head, this.cap)
				: this.truncatedFlag
					? (this.chunks.length - 1) * this.cap +
						Math.min(this.head - (this.chunks.length - 1) * this.cap, this.cap)
					: this.head
		return {
			mode: this.mode,
			attached: this.attached,
			recorded: this.head,
			retained,
			firstRetained: this.firstRetained(),
			dropped: this.head - retained,
			truncated: this.truncatedFlag,
			chunks: this.chunks.length,
			bytes: this.chunks.length * this.cap * TraceRec.STRIDE * TraceRec.BYTES_PER_FIELD,
			refsCaptured: Math.min(this.refHead, this.refCap),
		}
	}
}

// ---- attach / detach ---------------------------------------------------------------

/**
 * Attach a recorder to the engine (fills its `trace` slot). One tracer
 * per engine; `tracer.stop()` detaches at runtime and freezes the capture for
 * decoding. To capture a provably complete SESSION, attach before the
 * engine's first operation.
 */
export function attachTracer(engine: CosignalEngine, opts?: TracerOptions): Tracer {
	if (engine.trace !== undefined) {
		throw new Error(
			'cosignals/trace: a tracer is already attached to this engine (stop() it first)',
		)
	}
	const tracer = new Tracer(engine, opts)
	engine.trace = tracer
	return tracer
}

// ---- human formatting ---------------------------------------------------------------

/** One value formatter, two faces: subjects render unquoted (they are
 * labels); data values quote strings that would not scan as one word. */
function formatValue(v: unknown, subject = false): string {
	if (v === REF_DROPPED) {
		return '«dropped»'
	}
	if (typeof v === 'string') {
		return subject || /^[\w:.-]+$/.test(v) ? v : JSON.stringify(v)
	}
	return String(v)
}

/**
 * The stable one-line human form: `#id +Δµs kind(subject) k=v … [<- #cause]`.
 * The grammar and per-kind field order are fixed (asserted by tests); only
 * Δt varies run to run under the real clock.
 */
export function formatTraceRecord(e: TraceRecord): string {
	const entries = Object.entries(e.data)
	// the first field is the subject, rendered inside the parens
	const head = entries.length > 0 ? formatValue(entries[0]![1], true) : ''
	const rest = entries
		.slice(1)
		.map(([k, v]) => `${k}=${formatValue(v)}`)
		.join(' ')
	const cause = e.cause === undefined ? '' : ` <- #${e.cause}`
	return `#${e.id} +${e.dt}µs ${e.kind}(${head})${rest.length > 0 ? ` ${rest}` : ''}${cause}`
}

/** The whole capture (or any decoded slice), one line per event. */
export function formatTrace(events: TraceRecord[]): string {
	return events.map(formatTraceRecord).join('\n')
}
