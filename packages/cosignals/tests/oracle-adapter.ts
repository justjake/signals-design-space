/**
 * The adapter that drives the CONCURRENT engine and the reference model
 * (`cosignals-oracle`) in lockstep: it implements the reference model's
 * `EngineAdapter` surface (its adapter.ts — "an engine plugs into the fuzz
 * harness by implementing this surface") over the engine, so the model's
 * differ can replay one schedule into both and compare every observable
 * after every step. The reference model package is imported by relative
 * path: it is a dev-side referee, deliberately NOT a package dependency of
 * cosignals (no lockfile entry; the shipped entries never reference it).
 *
 * `applyEngineOp` mirrors the reference model's `applyOneOp` op-for-op —
 * including the entity indexing (creation order over the live maps), the
 * write-kind coercions, and the `${events}.${seq}.${epoch}` uniq naming —
 * but resolves everything against the ENGINE's state and treats
 * `ScheduleError` as the skip signal, so legality decisions are
 * computed independently on each side and then diffed.
 */

import {
	attachDriver,
	engine,
	BATCH_NONE,
	ScheduleError,
	__TEST__resetEngine,
	type AtomInternals,
	type CosignalEngine,
} from '../src/CosignalEngine.js';
import { __TEST__peekNextBatchId } from '../src/CosignalEngine.js';
import { __TEST__eachInternals, __TEST__internalsById } from '../src/CosignalEngine.js';
import { engineEpoch } from '../src/CosignalEngine.js';
import { armArenaCheck } from './arena-checker.js';
import {
	comparableEvents,
	snapshotModel,
	type DiffResult,
	type EngineAdapter,
} from '../../cosignals-oracle/src/adapter.js';
import { CosignalModel, type ModelEvent } from '../../cosignals-oracle/src/model.js';
import { applyOneOp, buildTopology, Q_EQUALS, type ScheduleOp, type WriteKind } from '../../cosignals-oracle/src/schedule.js';
import { mountEngineCoreEffect, mountEngineReactEffect, mountEngineReactEffectPick } from './helpers.js';
import { attachRefereeStream } from './trace-events.js';

// (The TraceEvent ≡ ModelEvent type-parity pin moved to trace-events.ts,
// beside the decoder — the only producer of the engine-side shape now.)

/** The reference model's fixed fuzz topology (buildTopology in its schedule.ts), rebuilt on the engine. */
export function buildEngineTopology(b: CosignalEngine) {
	const flag = b.atom('flag', 0);
	const a = b.atom('a', 0);
	const bb = b.atom('b', 0);
	const r = b.atom('r', 0);
	const cFlip = b.computed('cFlip', (read) => (read(flag) ? read(a) : read(bb)));
	const cSum = b.computed('cSum', (read) => (read(a) as number) + (read(bb) as number) + (read(r) as number));
	const cChain = b.computed('cChain', (read) => (read(cFlip) as number) + 10);
	const cMix = b.computed('cMix', (read, untracked) => (read(bb) as number) + (untracked(a) as number));
	// Appended AFTER the core eight (the op-index slices stay stable):
	// q = the custom-equals member, out1/out2 = the disjoint
	// effect-output subset writing core effects target.
	const q = b.atom('q', 0, Q_EQUALS);
	const out1 = b.atom('out1', 0);
	const out2 = b.atom('out2', 0);
	return { atoms: [flag, a, bb, r], computeds: [cFlip, cSum, cChain, cMix], q, outs: [out1, out2] };
}

/**
 * Adapter-side entity registries. The MODEL retains dead batch/render records
 * until quiescence, and schedule ops resolve entities by index over those
 * maps; the engine reclaims dead records mid-episode (keeping them all
 * would grow memory with the episode), so the adapter mirrors the model's
 * population itself to keep op resolution identical on both sides. Purely
 * an indexing-fidelity shim — no tolerance.
 */
type EntityRegistry = { batches: number[]; renderPasses: number[]; outWriters: Set<string> };

/** Keyed by ENGINE EPOCH (one schedule = one reset = one epoch): the engine
 * surface is a singleton, so object keying would leak the previous
 * schedule's registry into the next. */
const registries = new Map<number, EntityRegistry>();

function registryOf(_b: CosignalEngine): EntityRegistry {
	let r = registries.get(engineEpoch);
	if (r === undefined) {
		r = { batches: [], renderPasses: [], outWriters: new Set() };
		registries.set(engineEpoch, r);
	}
	return r;
}

function batchAt(b: CosignalEngine, index: number): number | undefined {
	const ids = registryOf(b).batches;
	if (ids.length === 0) throw new ScheduleError('no batches yet');
	return ids[index % ids.length];
}

function renderPassAt(b: CosignalEngine, index: number): number {
	const ids = registryOf(b).renderPasses;
	if (ids.length === 0) throw new ScheduleError('no render passes yet');
	return ids[index % ids.length]!;
}

function watcherAt(b: CosignalEngine, index: number): number {
	const ids = [...b.watchers.keys()];
	if (ids.length === 0) throw new ScheduleError('no watchers yet');
	return ids[index % ids.length]!;
}

/** Mirrors the model's `effectAt`: index over react-effect ids in creation
 * order (the engine's SignalEffect store holds ONLY committed observers — core
 * effects are kernel `effect()`s, not engine records — so its key sequence
 * is exactly the model's reactEffects key sequence, by INDEX; the id VALUES
 * diverge once a core effect mounts, which is why resolution is positional). */
function effectAt(b: CosignalEngine, index: number): number {
	const ids: number[] = [];
	for (const effect of b.idToSignalEffect.values()) ids.push(effect.id);
	if (ids.length === 0) throw new ScheduleError('no react effects yet');
	return ids[index % ids.length]!;
}

/** Per-engine count of applyEngineOp calls: the tracer-independent uniq
 * component that replaced the retained log's `b.events.length` when the
 * object channel died. Only per-engine uniqueness and run-to-run determinism
 * matter here — when NAME PARITY with the model matters (lockstep), the
 * differ supplies the model's own event count as `namingEvents`. */
const appliedOps = new Map<number, number>();

/** Apply ONE schedule op to an engine holding the fixed topology (applyOneOp twin).
 * `namingEvents` (when given) replaces the engine's own op count in the
 * `${events}.${seq}.${epoch}` uniq: the model creates names off ITS stream
 * length, and since S-B the engine legitimately delivers FEWER deliveryish
 * events (the ⊆ bound — lane degradation is a correction, not a delivery),
 * so name parity requires the MODEL's count — the differ supplies it. */
export function applyEngineOp(b: CosignalEngine, op: ScheduleOp, namingEvents?: number): boolean {
	const allNodes = __TEST__eachInternals();
	const atoms = allNodes.filter((n): n is AtomInternals => n.kind === 'atom').slice(0, 4);
	const nodes = allNodes.slice(0, 8);
	/** The schedule's write vocabulary → the engine's scalar (kind, payload)
	 * pair (0 = set, 1 = update) — the adapter's op-literal twin of the
	 * model-side writeOp in the oracle's schedule.ts. */
	const writeScalarsFor = (kind: WriteKind, value: number): [0 | 1, unknown] => {
		switch (kind) {
			case 'set': return [0, value];
			case 'inc': return [1, (p: unknown) => (p as number) + 1];
			case 'double': return [1, (p: unknown) => (p as number) * 2];
			case 'equalNewest': return [0, value]; // resolved by the caller against the target atom
		}
	};
	const writeScalars = (kind: WriteKind, value: number, atomIdx: number): [0 | 1, unknown] => {
		switch (kind) {
			case 'set': return [0, value];
			case 'inc': return [1, (p: unknown) => (p as number) + 1];
			case 'double': return [1, (p: unknown) => (p as number) * 2];
			case 'equalNewest': return [0, b.newestValue(atoms[atomIdx]!)];
		}
	};
	const opIndex = (appliedOps.get(engineEpoch) ?? 0) + 1;
	appliedOps.set(engineEpoch, opIndex);
	const uniq = `${namingEvents ?? opIndex}.${b.seq}.${b.epoch}`;
	const reg = registryOf(b);
	/** bareWrite may create the ambient batch — mirror the model's map growth. */
	const syncAmbient = (): void => {
		const amb = b.ambientBatch;
		if (amb !== undefined && reg.batches[reg.batches.length - 1] !== amb && !reg.batches.includes(amb)) {
			reg.batches.push(amb);
		}
	};
	try {
		switch (op.t) {
			case 'open': reg.batches.push(b.openBatch({ action: op.action }).id); break;
			case 'write': {
				const atom = atoms[op.atom % atoms.length]!;
				b.write(batchAt(b, op.batch), atom, ...writeScalars(op.kind, op.value, op.atom % atoms.length));
				syncAmbient(); // a writing core effect's nested bare write can create the ambient batch
				break;
			}
			case 'bareWrite': {
				const atom = atoms[op.atom % atoms.length]!;
				b.bareWrite(atom, ...writeScalars(op.kind, op.value, op.atom % atoms.length));
				syncAmbient();
				break;
			}
			case 'writeQ': {
				const q = allNodes.find((n): n is AtomInternals => n.kind === 'atom' && n.name === 'q')!;
				b.write(batchAt(b, op.batch), q, ...(op.kind === 'equalNewest' ? ([0, b.newestValue(q)] as [0, unknown]) : writeScalarsFor(op.kind, op.value)));
				syncAmbient(); // a writing core effect's nested bare write can create the ambient batch
				break;
			}
			case 'bareWriteQ': {
				const q = allNodes.find((n): n is AtomInternals => n.kind === 'atom' && n.name === 'q')!;
				b.bareWrite(q, ...(op.kind === 'equalNewest' ? [0, b.newestValue(q)] as [0, unknown] : writeScalarsFor(op.kind, op.value)));
				syncAmbient();
				break;
			}
			case 'settle': b.settleAction(batchAt(b, op.batch)!); break;
			case 'retire': b.retire(batchAt(b, op.batch)!); break;
			case 'renderStart': reg.renderPasses.push(b.renderStart(op.root, op.include.map((i) => batchAt(b, i)!)).id); break;
			case 'yield': b.renderYield(renderPassAt(b, op.renderPass)); break;
			case 'resume': b.renderResume(renderPassAt(b, op.renderPass)); break;
			case 'end': b.renderEnd(renderPassAt(b, op.renderPass), op.kind, { retireAtCommit: op.retireAtCommit.map((i) => batchAt(b, i)!) }); break;
			case 'mount': b.mountWatcher(renderPassAt(b, op.renderPass), nodes[op.node % nodes.length]!, `W${uniq}`); break;
			case 'render': b.renderWatcher(renderPassAt(b, op.renderPass), watcherAt(b, op.watcher)); break;
			case 'reactEffect': mountEngineReactEffect(b, op.root, nodes[op.node % nodes.length]!, `E${uniq}`); break;
			case 'reactEffectPick':
				mountEngineReactEffectPick(
					b, op.root,
					nodes[op.sel % nodes.length]!, nodes[op.a % nodes.length]!, nodes[op.b % nodes.length]!,
					`E${uniq}`,
				);
				break;
			case 'removeReactEffect': b.removeSignalEffect(effectAt(b, op.effect)); break;
			case 'replayReactEffect': b.replaySignalEffect(effectAt(b, op.effect)); break;
			case 'coreEffect': mountEngineCoreEffect(b, nodes[op.node % nodes.length]!, `CE${uniq}`); break;
			case 'coreEffectWrite': {
				const outName = op.out % 2 === 0 ? 'out1' : 'out2';
				// One writer per output atom (mirrors the model's legality —
				// sibling firing order is implementation-defined, so a shared
				// output's final value would be order-dependent).
				if (reg.outWriters.has(outName)) throw new ScheduleError(`output atom ${outName} already has a writing effect`);
				const out = allNodes.find((n): n is AtomInternals => n.kind === 'atom' && n.name === outName)!;
				mountEngineCoreEffect(b, nodes[op.node % nodes.length]!, `CE${uniq}`, out);
				reg.outWriters.add(outName);
				break;
			}
			case 'discardAllWip': b.discardAllWip(); break;
			case 'quiesce':
				b.quiesce();
				// The model drops every retired batch and ended render here; at
				// quiescence that is all of them (no live batches/renders remain).
				reg.batches.length = 0;
				reg.renderPasses.length = 0;
				break;
		}
		return true;
	} catch (err) {
		if (err instanceof ScheduleError) return false;
		throw err;
	}
}

/**
 * A fresh CONCURRENT engine presented through the reference model's
 * EngineAdapter surface (its `modelAsEngine` template with the model
 * replaced by the real engine). The adapter is structurally
 * snapshot-compatible with the model, so the reference model's own
 * `snapshotModel` reads the engine's observables — engine internals
 * (kernel arena, union edges, memos) are never compared.
 */
export function engineAsAdapter(): EngineAdapter & { engine: CosignalEngine; __syncNamingEvents(n: number): void } {
	// THE ONE ENGINE, reset per schedule (the fresh-model analog). A test
	// may legitimately end mid-episode; close it out before the reset's
	// idle preconditions run (the helpers.ts drain, inlined).
	engine.discardAllWip();
	for (const t of engine.liveBatches()) {
		if (t.parked) engine.settleAction(t.id);
		else engine.retire(t.id);
	}
	// devChecks armed (an engine-inert switch): the corpus referees the
	// engine with it on, proving the flag perturbs no engine semantics.
	// R-5: devChecks harnesses that open batches attach a driver first —
	// the minimal context-free driver (explicit ids drive the writes).
	__TEST__resetEngine({ devChecks: true });
	attachDriver({ currentBatch: () => BATCH_NONE, worldFor: () => undefined });
	const b = engine;
	// BatchIds are monotonic across resets; the model restarts at 1 — the
	// adapter rebases engine event batch ids into the model's space.
	const batchIdBase = __TEST__peekNextBatchId() - 1;
	// The engine's event stream: a lossless session tracer decoded on demand
	// (the packed records are the only event channel; tests/trace-events.ts).
	const stream = attachRefereeStream(b);
	// PRODUCTION write semantics: the engine quiet-folds bare writes at rest
	// and the model mirrors the same derivation and fold, so the corpus
	// referees the real default write path ('quiet-write' is a compared
	// event; tests/quiet-mode.spec.ts pins the arming schedules by hand).
	// ARMED S-B divergence check: every public operation's epilogue serves
	// every live arena's shadows from the arena's own walks and compares
	// against fold-truth (plus the structural validator) — the corpus runs
	// with the referee that owns the stage's STOP condition.
	armArenaCheck(b);
	buildEngineTopology(b);
	let drained = 0;
	let namingEvents: number | undefined;
	return {
		engine: b,
		/** Name parity under the ⊆ delivery bound: the differ reports the
		 * model's pre-op event count so `${events}.…` names match its. */
		__syncNamingEvents(n: number): void {
			namingEvents = n;
		},
		apply: (op) => (applyEngineOp(b, op, namingEvents) ? 'applied' : 'skipped'),
		// snapshotModel reads the model shape structurally (idToNode, roots,
		// value accessors). The engine surface satisfies all of it except the
		// id map (deleted with the engine's Map registry), so delegate to the
		// surface and overlay a Map built from the internals enumeration seam.
		snapshot: () =>
			snapshotModel(
				Object.assign(Object.create(b as object), {
					idToNode: new Map(__TEST__eachInternals().map((n) => [n.id, n])),
				}) as unknown as CosignalModel,
			),
		drainEvents() {
			const events = stream.events;
			const out = comparableEvents(events.slice(drained) as ModelEvent[]).map((e) => {
				const batch = (e as { batch?: number }).batch;
				return typeof batch === 'number' && batch > 0 ? ({ ...e, batch: batch - batchIdBase } as ModelEvent) : e;
			});
			drained = events.length;
			return out;
		},
	};
}

// ---- the tolerant differ ----------------------------------------------------
//
// The reference model's own `diffAgainstModel` compares the comparable event
// stream EXACTLY per step. The engine — for speed — discovers union edges at
// evaluation sites and replays live slots when an edge is added, so
// delivery-decision timing may lag the model's eager per-write union
// refresh; this is the engine-diff tolerance documented in the reference
// model's README ("engine ⊇ required, ⊆ union-conservative"). This differ
// keeps every other comparison EXACT:
//   - op legality per step (exact);
//   - the full observable snapshot per step (exact — values never relax);
//   - non-delivery comparable events per step (exact, in order — with ONE
//     canonicalization: same-step contiguous core-effect-run blocks compare
//     as a multiset, because sibling core-effect firing order is
//     implementation-defined by contract; see
//     canonicalizeCoreEffectBlocks);
//   - delivery-decision events ('delivery'/'suppressed'/'mount-corrective'):
//     cumulative multiset ⊆ the model's, keyed (type, watcher, batch, slot)
//     — mode/seq excluded (an edge-add replay carries the replay sequence).
// The ⊇-required floor is enforced indirectly: exact snapshots, exact
// value-gated corrections/effect-runs, and an audit inside the engine that
// throws InvariantViolation whenever divergence hidden by a mount
// fast-out is not covered by correctives.

const DELIVERYISH = new Set<ModelEvent['type']>(['delivery', 'suppressed', 'mount-corrective']);

/**
 * Sibling core-effect firing order is implementation-defined (owner
 * ruling): the engine's core effects are real kernel
 * `effect()`s flushed in the kernel's propagation order over its
 * subscriber-link lists (a link-creation *and relink* history), while the
 * model flushes its coreEffects map in mount order. The contractual
 * guarantees are each effect's observed values and the operation each run
 * fires at — so within one step, maximal contiguous blocks of
 * `core-effect-run` events are canonicalized by sorting on (effect, value)
 * on BOTH streams before the exact comparison. Effect names carry a
 * per-mount ordinal (helpers.ts mountEngineCoreEffect / the model's
 * mountCoreEffect), so names are unique and the multiset comparison is
 * unambiguous. Nothing else about the comparison changes: block boundaries
 * (any non-core-effect event) still pin placement, and values never relax.
 */
function canonicalizeCoreEffectBlocks(events: ModelEvent[]): ModelEvent[] {
	// R-3 extension: a WRITING core effect's write lands in the sibling
	// block too — as a 'quiet-write' on an effect-output atom when the
	// engine/model are at rest (the ambient-batch case's 'write' events are
	// not compared events). The write travels WITH its effect's run (the
	// unit), units sort by (effect, value) — the ruling's mechanical form —
	// and the quiet-write SEQS renumber positionally within the block:
	// sibling order is implementation-defined, so seq assignment within the
	// sibling block is a quotient of the same ruling.
	const isOutWrite = (e: ModelEvent): boolean =>
		e.type === 'quiet-write' && ((e as { node?: string }).node === 'out1' || (e as { node?: string }).node === 'out2');
	const inBlock = (e: ModelEvent): boolean => e.type === 'core-effect-run' || isOutWrite(e);
	const out = events.slice();
	let i = 0;
	while (i < out.length) {
		if (out[i]!.type !== 'core-effect-run') {
			i++;
			continue;
		}
		let j = i + 1;
		while (j < out.length && inBlock(out[j]!)) j++;
		// Trim trailing non-run events only if the block contains ≥2 runs or
		// any out-write (a lone run needs no canonicalization).
		const block = out.slice(i, j);
		const runCount = block.filter((e) => e.type === 'core-effect-run').length;
		if (runCount > 1 || (runCount === 1 && block.length > 1)) {
			// Group into units: one run + its following out-writes.
			type Unit = { key: [string, string]; events: ModelEvent[] };
			const units: Unit[] = [];
			for (const e of block) {
				if (e.type === 'core-effect-run') {
					const r = e as Extract<ModelEvent, { type: 'core-effect-run' }>;
					units.push({ key: [r.effect, String(r.value)], events: [e] });
				} else {
					units[units.length - 1]!.events.push(e); // an out-write always follows its run
				}
			}
			units.sort((a, b) =>
				a.key[0] < b.key[0] ? -1 : a.key[0] > b.key[0] ? 1 :
				a.key[1] < b.key[1] ? -1 : a.key[1] > b.key[1] ? 1 : 0);
			// Renumber the block's quiet-write seqs positionally (ascending
			// pool, canonical order) — clone events, never mutate the stream.
			const seqPool = block
				.filter(isOutWrite)
				.map((e) => (e as { seq: number }).seq)
				.sort((a, b) => a - b);
			let seqIx = 0;
			const flat: ModelEvent[] = [];
			for (const u of units) {
				for (const e of u.events) {
					flat.push(isOutWrite(e) ? ({ ...e, seq: seqPool[seqIx++]! } as ModelEvent) : e);
				}
			}
			for (let k = i; k < j; k++) out[k] = flat[k - i]!;
		}
		i = j;
	}
	return out;
}

/** Delivery-DECISION counts, pooled across the family's three modes per
 * (watcher, batch, slot). The bound is "fewer decisions, never more":
 * current-structure routing legitimately shifts modes
 * within the family — a mount join the accumulated model schedules as a
 * corrective (arming its dedup, so its write logs 'suppressed') may not
 * exist in any live arena, in which case the engine's write-time walk is
 * the first notification and logs 'delivery'. One notification either way;
 * pooling keys the invariant on the decision, not its mode. */
function deliveryKeyCounts(events: ModelEvent[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const e of events) {
		if (!DELIVERYISH.has(e.type)) continue;
		const d = e as unknown as { watcher: string; batch: number; slot: number };
		const key = `${d.watcher}|${d.batch}|${d.slot}`;
		out.set(key, (out.get(key) ?? 0) + 1);
	}
	return out;
}

export function diffAgainstModelTolerant(
	engine: EngineAdapter,
	ops: ScheduleOp[],
	seed?: number,
): DiffResult {
	const m = new CosignalModel();
	buildTopology(m);
	let drained = 0;
	const modelPool = new Map<string, number>();
	const engineUsed = new Map<string, number>();
	const namedEngine = engine as EngineAdapter & { __syncNamingEvents?(n: number): void; engine?: CosignalEngine };
	const dpc = namedEngine.engine !== undefined ? new DeliveryPrecedesCorrection(namedEngine.engine) : undefined;
	for (let step = 0; step < ops.length; step++) {
		const namingEvents = m.events.length; // the model's pre-op count — its uniq naming input
		const ok = applyOneOp(m, ops[step]!);
		const mEvents = comparableEvents(m.events.slice(drained));
		drained = m.events.length;
		namedEngine.__syncNamingEvents?.(namingEvents);
		dpc?.beforeOp(ops[step]!);
		const applied = engine.apply(ops[step]!);
		if (applied !== (ok ? 'applied' : 'skipped')) {
			return { seed, step, message: `legality diverged: engine ${applied}, model ${ok ? 'applied' : 'skipped'}` };
		}
		const snap = JSON.stringify(engine.snapshot());
		const expectedSnap = JSON.stringify(snapshotModel(m));
		if (snap !== expectedSnap) {
			return { seed, step, message: `snapshot diverged:\nengine ${snap}\nmodel  ${expectedSnap}` };
		}
		const eEvents = engine.drainEvents();
		// Same-step core-effect-run blocks compare as a multiset (the ruling's
		// mechanical form — see canonicalizeCoreEffectBlocks).
		const mRest = JSON.stringify(canonicalizeCoreEffectBlocks(mEvents.filter((e) => !DELIVERYISH.has(e.type))));
		const eRest = JSON.stringify(canonicalizeCoreEffectBlocks(eEvents.filter((e) => !DELIVERYISH.has(e.type))));
		if (mRest !== eRest) {
			return { seed, step, message: `events diverged:\nengine ${eRest}\nmodel  ${mRest}` };
		}
		for (const [key, n] of deliveryKeyCounts(mEvents)) modelPool.set(key, (modelPool.get(key) ?? 0) + n);
		for (const [key, n] of deliveryKeyCounts(eEvents)) {
			const used = (engineUsed.get(key) ?? 0) + n;
			engineUsed.set(key, used);
			if (used > (modelPool.get(key) ?? 0)) {
				return {
					seed, step,
					message: `delivery decisions exceeded the union-conservative bound: ${key} engine ×${used} vs model ×${modelPool.get(key) ?? 0}`,
				};
			}
		}
		const dpcFail = dpc?.afterOp(ops[step]!, eEvents);
		if (dpcFail !== undefined) return { seed, step, message: dpcFail };
	}
	return undefined;
}

// ---- the scoped delivery-precedes-correction fuzz invariant ------------------
//
// A reconcile-correction caused by member-slot writes
// newer than the watcher's last render must have been preceded by a
// notification (delivery / suppression / mount-corrective) since that
// render — otherwise arena routing silently stopped notifying. Scoped
// to the class it can police, excluding its counterexamples:
//   - quiet-mode corrections (a quiet fold's corrections create no
//     'reconcile-correction' event — the fold's own 'quiet-write' event is
//     its whole stream — so DPC never sees them; and quiet requires zero
//     live batches, so no retire/settle boundary observes a quiet window);
//   - mount-window repairs ('mount-urgent-correction' is a different type);
//   - older-write visibility flips (the causing batch's lastWriteSeq must
//     POSTDATE the watcher's window for the assert to arm);
//   - the dead-arena retreat family (any discard, parked batch, or second
//     boundary inside the window disarms the assert — dead-arena lane
//     degradation is legal and pinned separately in arena-sb.spec.ts);
//   - the designed no-notification class (untracked-only reach):
//     watchers on the topology's untracked consumer (cMix) are excluded —
//     weak links never notify, by design, so their corrections arrive bare.
// Windows reset at render/mount/commit/discard/quiesce boundaries (renders
// re-arm dedup; commits re-baseline lastRenderedValue) and after each
// correction (which also resets the engine's dedup bits).

type DpcMark = { seq: number; notified: boolean; disarmed: boolean; boundaries: number };

class DeliveryPrecedesCorrection {
	private marks = new Map<string, DpcMark>();
	private preOpBatchWriteSeq = 0;

	constructor(private engine: CosignalEngine) {}

	private resetAll(): void {
		this.marks.clear();
	}

	private markOf(name: string): DpcMark {
		let mk = this.marks.get(name);
		if (mk === undefined) {
			mk = { seq: this.engine.seq, notified: false, disarmed: false, boundaries: 0 };
			this.marks.set(name, mk);
		}
		return mk;
	}

	/** Resolve the retiring batch's last write seq BEFORE the op applies
	 * (retirement can reclaim the record). */
	beforeOp(op: ScheduleOp): void {
		this.preOpBatchWriteSeq = 0;
		if (op.t === 'retire' || op.t === 'settle') {
			try {
				const id = batchAt(this.engine, op.batch);
				this.preOpBatchWriteSeq = (id !== undefined ? this.engine.idToBatch.get(id)?.lastWriteSeq : 0) ?? 0;
			} catch {
				// no batches yet: the op will skip
			}
		}
	}

	afterOp(op: ScheduleOp, events: ModelEvent[]): string | undefined {
		const b = this.engine;
		const singleBoundary = op.t === 'retire' || op.t === 'settle';
		for (const e of events) {
			const t = e.type;
			if (t === 'delivery' || t === 'suppressed' || t === 'mount-corrective') {
				this.markOf((e as unknown as { watcher: string }).watcher).notified = true;
			} else if (t === 'reconcile-correction') {
				const name = (e as unknown as { watcher: string }).watcher;
				const mk = this.marks.get(name);
				if (mk === undefined) {
					this.markOf(name); // unknown window: initialize, skip
					continue;
				}
				const w = [...b.watchers.values()].find((x) => x.name === name);
				const node = w !== undefined ? __TEST__internalsById(w.node) : undefined;
				const untrackedConsumer = node !== undefined && node.name === 'cMix';
				if (
					singleBoundary &&
					!mk.disarmed &&
					mk.boundaries === 0 &&
					!untrackedConsumer &&
					this.preOpBatchWriteSeq > mk.seq &&
					!mk.notified
				) {
					return `delivery-precedes-correction violated: ${name} corrected at ${op.t} (batch wrote at seq ${this.preOpBatchWriteSeq} > window ${mk.seq}) with no delivery/suppression/corrective since its window opened`;
				}
				// A correction resets the engine's dedup bits: fresh window.
				this.marks.set(name, { seq: b.seq, notified: false, disarmed: false, boundaries: 0 });
			}
		}
		// Window maintenance from the op stream.
		if (op.t === 'end' || op.t === 'discardAllWip' || op.t === 'quiesce' || op.t === 'mount' || op.t === 'render') {
			this.resetAll(); // commits/discards re-baseline; renders re-arm dedup; conservative wholesale reset
		} else if (singleBoundary) {
			for (const mk of this.marks.values()) mk.boundaries++;
		}
		// A live parked batch anywhere in the window disarms (dead-arena-retreat exclusion).
		let parked = false;
		for (const batch of b.idToBatch.values()) {
			if (batch.parked) {
				parked = true;
				break;
			}
		}
		if (parked) {
			for (const mk of this.marks.values()) mk.disarmed = true;
		}
		return undefined;
	}
}
