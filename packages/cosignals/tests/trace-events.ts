/**
 * The referee's packed-trace decoder. Since W5 ("tracer packed data is the
 * only form of events") the engine creates NO event objects: every
 * instrumentation site writes a fixed-size record into the attached tracer,
 * and everything that used to read the retained TraceEvent log — the twin
 * driver's lockstep comparison, the oracle adapter, specs — attaches a
 * LOSSLESS SESSION tracer at bridge birth and decodes records back into
 * `TraceEvent` objects (the decoded shape, still declared in
 * src/concurrent.ts because the package entry re-exports it) on demand here.
 *
 * The mapping is the exact inverse of the engine sites' packing, minus
 * trace-only enrichments (a write's op, a suppression's reason, a
 * root-commit's generation) and minus trace-only kinds (batch open/settle,
 * render start/yield/resume/end, evals, mount-fixup dispositions, deferred
 * releases, clock-sync, truncation): the decoded stream contains exactly the
 * TraceEvent vocabulary, in create order, with the FIELD ORDER the reference
 * model's own event literals use — the twin and the oracle differ compare
 * streams by JSON, so key order is load-bearing.
 *
 * Ref-ring sizing is load-bearing too: correction from/to values, effect
 * values, and react-effect dep snapshots live in the tracer's ref ring, and
 * lockstep re-reads the WHOLE session's stream after every op — an
 * overwritten ref would decode as REF_DROPPED and fail the comparison
 * loudly. `attachRefereeStream` therefore attaches with a large ref
 * capacity (2^16) instead of the diagnostic default (256).
 */
import type { TraceEvent, CosignalEngine, Value } from '../src/concurrent.js';
import { attachTracer, Tracer, type TraceRecord, type TracerOptions } from '../src/trace.js';
import { engineEpoch } from '../src/graph.js';
import type { ModelEvent } from '../../cosignals-oracle/src/model.js';

// ---- TraceEvent ≡ ModelEvent pin -------------------------------------------
// The decoded-engine-event union and the reference model's event union are
// maintained BY HAND in two deliberately-independent packages (importing
// would weaken the oracle as a referee) and the lockstep differ compares
// them by JSON — so drift used to surface only as a fuzz diff. This converts
// it into a typecheck failure, and it lives beside the decoder because the
// decoder is now the ONLY producer of the engine-side shape. Non-distributive
// form on purpose: the WHOLE union must assign in both directions.
type _EventStreamPin = [
	[TraceEvent] extends [ModelEvent] ? true : never,
	[ModelEvent] extends [TraceEvent] ? true : never,
];
const _eventStreamPin: _EventStreamPin = [true, true];
void _eventStreamPin;

/**
 * One decoded trace event → the TraceEvent it stands for, or undefined for
 * trace-only kinds. Field order matches the reference model's literals.
 */
export function decodeTraceEvent(e: TraceRecord): TraceEvent | undefined {
	const d = e.data;
	switch (e.kind) {
		case 'write': // the log-entry-borne record; `op` is a trace-only enrichment
			return { type: 'write', node: d['node'] as string, batch: d['batch'] as number, slot: d['slot'] as number, seq: d['seq'] as number };
		case 'write-dropped':
			return { type: 'write-dropped', node: d['node'] as string, batch: d['batch'] as number };
		case 'quiet-write':
			return { type: 'quiet-write', node: d['node'] as string, seq: d['seq'] as number };
		case 'delivery':
			return { type: 'delivery', watcher: d['watcher'] as string, batch: d['batch'] as number, slot: d['slot'] as number, seq: d['seq'] as number, mode: d['mode'] as 'fresh' | 'interleaved' };
		case 'suppressed': // `reason` is a trace-only enrichment
			return { type: 'suppressed', watcher: d['watcher'] as string, batch: d['batch'] as number, slot: d['slot'] as number, seq: d['seq'] as number };
		case 'core-effect-run':
			return { type: 'core-effect-run', effect: d['effect'] as string, value: d['value'] };
		case 'react-effect-run':
			// `values` decodes only from recordings that captured it (ARG1≠0);
			// the referee stream always does — [] appears only for pre-capture
			// recordings or refCapacity 0, neither of which lockstep uses.
			return { type: 'react-effect-run', effect: d['effect'] as string, root: d['root'] as string, value: d['value'], values: (d['values'] ?? []) as Value[] };
		case 'react-effect-cleanup':
			return { type: 'react-effect-cleanup', effect: d['effect'] as string, root: d['root'] as string };
		case 'reconcile-correction':
			return { type: 'reconcile-correction', watcher: d['watcher'] as string, root: d['root'] as string, from: d['from'], to: d['to'], cause: d['cause'] as 'retirement' | 'per-root-commit' };
		case 'mount-corrective':
			return { type: 'mount-corrective', watcher: d['watcher'] as string, batch: d['batch'] as number, slot: d['slot'] as number };
		case 'mount-correction':
			return { type: 'mount-urgent-correction', watcher: d['watcher'] as string, from: d['from'], to: d['to'] };
		case 'root-commit': // `commitGen` is a trace-only enrichment
			return { type: 'per-root-commit', root: d['root'] as string, batch: d['batch'] as number };
		case 'batch-retire':
			return { type: 'retired', batch: d['batch'] as number, retiredSeq: d['retiredSeq'] as number };
		case 'slot-claim':
			return { type: 'slot-claimed', slot: d['slot'] as number, batch: d['batch'] as number };
		case 'slot-release':
			return { type: 'slot-released', slot: d['slot'] as number, batch: d['batch'] as number };
		case 'slot-backstop-release':
			return { type: 'slot-backstop-released', slot: d['slot'] as number, batch: d['batch'] as number };
		case 'render-committed':
			return { type: 'render-committed', renderPass: d['renderPass'] as number, root: d['root'] as string };
		case 'render-discarded':
			return { type: 'render-discarded', renderPass: d['renderPass'] as number, root: d['root'] as string };
		case 'epoch-reset':
			return { type: 'epoch-reset', epoch: d['epoch'] as number };
		// trace-only kinds: no TraceEvent counterpart ('batch-disposition' is
		// the bindings-created committed/abandoned report — the model has no
		// twin because neither side's retirement consumes the flag)
		case 'batch-open':
		case 'batch-settle':
		case 'batch-disposition':
		case 'slot-release-deferred':
		case 'render-start':
		case 'render-yield':
		case 'render-resume':
		case 'render-end':
		case 'eval':
		case 'mount-fixup':
		case 'clock-sync':
		case 'truncation':
			return undefined;
	}
}

/** Every TraceEvent decodable from `tr`, oldest first (a one-shot decode;
 * specs driving their own tracer use this — referees use RefereeStream). */
export function decodedTraceEvents(tr: Tracer): TraceEvent[] {
	const out: TraceEvent[] = [];
	for (const te of tr.events()) {
		const be = decodeTraceEvent(te);
		if (be !== undefined) out.push(be);
	}
	return out;
}

/**
 * The referee's view of one bridge's event stream: a lossless session tracer
 * plus an incrementally-maintained decode of its TraceEvent-mapped records
 * (session records are immutable and ids are dense, so decoding forward from
 * a cursor is sound and each record decodes exactly once). Presents the
 * surface the retained log used to: `events`, `eventsOfType`, `eventsSince`,
 * `cursor()` — marks index the DECODED stream, as before.
 */
export class RefereeStream {
	readonly tracer: Tracer;
	private decoded: TraceEvent[] = [];
	private nextId = 0;

	constructor(tracer: Tracer) {
		this.tracer = tracer;
	}

	/** All decoded events so far, oldest first (syncs, then returns the cache). */
	get events(): TraceEvent[] {
		const head = this.tracer.stats().recorded;
		for (let id = this.nextId; id < head; id++) {
			const te = this.tracer.decode(id);
			if (te === undefined) continue; // unreachable while the session stays lossless
			const be = decodeTraceEvent(te);
			if (be !== undefined) this.decoded.push(be);
		}
		this.nextId = head;
		return this.decoded;
	}

	eventsOfType<T extends TraceEvent['type']>(type: T): Extract<TraceEvent, { type: T }>[] {
		return this.events.filter((e): e is Extract<TraceEvent, { type: T }> => e.type === type);
	}

	/** Cursor into the decoded stream (a mark for eventsSince). */
	cursor(): number {
		return this.events.length;
	}

	/** Events decoded after a caller-captured mark. */
	eventsSince(mark: number): TraceEvent[] {
		return this.events.slice(mark);
	}
}

const streams = new WeakMap<CosignalEngine, { epoch: number; stream: RefereeStream }>();

/**
 * Attach the referee's lossless session tracer to a fresh bridge and return
 * its decoded stream (registered per bridge so shared drivers can find it —
 * `refereeStreamOf`). Attach before the bridge's first operation: session
 * completeness is what makes the decoded stream comparable from event 0.
 */
export function attachRefereeStream(b: CosignalEngine, opts?: TracerOptions): RefereeStream {
	const s = new RefereeStream(attachTracer(b, { mode: 'session', refCapacity: 1 << 16, ...opts }));
	streams.set(b, { epoch: engineEpoch, stream: s });
	return s;
}

/** The stream attached to `b` THIS EPOCH, or throw (attachRefereeStream
 * after every `__resetEngineForTest`). */
export function refereeStreamOf(b: CosignalEngine): RefereeStream {
	const s = streams.get(b);
	if (s === undefined || s.epoch !== engineEpoch) throw new Error('no referee stream attached to this engine composition (call attachRefereeStream after the reset)');
	return s.stream;
}
