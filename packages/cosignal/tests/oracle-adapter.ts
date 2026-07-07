/**
 * The adapter that drives the CONCURRENT engine and the reference model
 * (`cosignal-oracle`) in lockstep: it implements the reference model's
 * `EngineAdapter` surface (its adapter.ts — "an engine plugs into the fuzz
 * harness by implementing this surface") over the bridge, so the model's
 * differ can replay one schedule into both and compare every observable
 * after every step. The reference model package is imported by relative
 * path: it is a dev-side referee, deliberately NOT a package dependency of
 * cosignal (no lockfile entry; the shipped entries never reference it).
 *
 * `applyEngineOp` mirrors the reference model's `applyOneOp` op-for-op —
 * including the entity indexing (creation order over the live maps), the
 * write-kind coercions, and the `${events}.${seq}.${epoch}` uniq naming —
 * but resolves everything against the ENGINE's state and treats
 * `BridgeScheduleError` as the skip signal, so legality decisions are
 * computed independently on each side and then diffed.
 */

import {
	__newBridgeForTest,
	BridgeScheduleError,
	type AtomNode,
	type CosignalBridge,
} from '../src/concurrent.js';
import { armArenaCheck } from './arena-checker.js';
import {
	comparableEvents,
	snapshotModel,
	type DiffResult,
	type EngineAdapter,
} from '../../cosignal-oracle/src/adapter.js';
import { CosignalModel, type ModelEvent } from '../../cosignal-oracle/src/model.js';
import { applyOneOp, buildTopology, type ScheduleOp, type WriteKind } from '../../cosignal-oracle/src/schedule.js';
import { mountEngineCoreEffect, mountEngineReactEffect, mountEngineReactEffectPick } from './helpers.js';
import { attachRefereeStream } from './trace-events.js';

// (The BridgeEvent ≡ ModelEvent type-parity pin moved to trace-events.ts,
// beside the decoder — the only producer of the engine-side shape now.)

/** The reference model's fixed fuzz topology (buildTopology in its schedule.ts), rebuilt on the engine. */
export function buildEngineTopology(b: CosignalBridge) {
	const flag = b.atom('flag', 0);
	const a = b.atom('a', 0);
	const bb = b.atom('b', 0);
	const r = b.atom('r', 0);
	const cFlip = b.computed('cFlip', (read) => (read(flag) ? read(a) : read(bb)));
	const cSum = b.computed('cSum', (read) => (read(a) as number) + (read(bb) as number) + (read(r) as number));
	const cChain = b.computed('cChain', (read) => (read(cFlip) as number) + 10);
	const cMix = b.computed('cMix', (read, untracked) => (read(bb) as number) + (untracked(a) as number));
	return { atoms: [flag, a, bb, r], computeds: [cFlip, cSum, cChain, cMix] };
}

/**
 * Adapter-side entity registries. The MODEL retains dead token/pass records
 * until quiescence, and schedule ops resolve entities by index over those
 * maps; the engine reclaims dead records mid-episode (keeping them all
 * would grow memory with the episode), so the adapter mirrors the model's
 * population itself to keep op resolution identical on both sides. Purely
 * an indexing-fidelity shim — no tolerance.
 */
type EntityRegistry = { tokens: number[]; passes: number[] };

const registries = new WeakMap<CosignalBridge, EntityRegistry>();

function registryOf(b: CosignalBridge): EntityRegistry {
	let r = registries.get(b);
	if (r === undefined) {
		r = { tokens: [], passes: [] };
		registries.set(b, r);
	}
	return r;
}

function tokenAt(b: CosignalBridge, index: number): number | undefined {
	const ids = registryOf(b).tokens;
	if (ids.length === 0) throw new BridgeScheduleError('no tokens yet');
	return ids[index % ids.length];
}

function passAt(b: CosignalBridge, index: number): number {
	const ids = registryOf(b).passes;
	if (ids.length === 0) throw new BridgeScheduleError('no passes yet');
	return ids[index % ids.length]!;
}

function watcherAt(b: CosignalBridge, index: number): number {
	const ids = [...b.watchers.keys()];
	if (ids.length === 0) throw new BridgeScheduleError('no watchers yet');
	return ids[index % ids.length]!;
}

/** Mirrors the model's `effectAt`: index over react-effect ids in creation
 * order (the engine's subs store holds ONLY committed observers — core
 * effects are kernel `effect()`s, not bridge records — so its key sequence
 * is exactly the model's reactEffects key sequence, by INDEX; the id VALUES
 * diverge once a core effect mounts, which is why resolution is positional). */
function effectAt(b: CosignalBridge, index: number): number {
	const ids: number[] = [];
	for (const s of b.subs.values()) ids.push(s.id);
	if (ids.length === 0) throw new BridgeScheduleError('no react effects yet');
	return ids[index % ids.length]!;
}

/** Per-bridge count of applyEngineOp calls: the tracer-independent uniq
 * component that replaced the retained log's `b.events.length` when the
 * object channel died. Only per-bridge uniqueness and run-to-run determinism
 * matter here — when NAME PARITY with the model matters (lockstep), the
 * differ supplies the model's own event count as `namingEvents`. */
const appliedOps = new WeakMap<CosignalBridge, number>();

/** Apply ONE schedule op to a bridge holding the fixed topology (applyOneOp twin).
 * `namingEvents` (when given) replaces the engine's own op count in the
 * `${events}.${seq}.${epoch}` uniq: the model mints names off ITS stream
 * length, and since S-B the engine legitimately delivers FEWER deliveryish
 * events (the ⊆ bound — lane degradation is a correction, not a delivery),
 * so name parity requires the MODEL's count — the differ supplies it. */
export function applyEngineOp(b: CosignalBridge, op: ScheduleOp, namingEvents?: number): boolean {
	const allNodes = [...b.nodes.values()];
	const atoms = allNodes.filter((n): n is AtomNode => n.kind === 'atom').slice(0, 4);
	const nodes = allNodes.slice(0, 8);
	/** The schedule's write vocabulary → the engine's scalar (kind, payload)
	 * pair (0 = set, 1 = update) — the adapter's op-literal twin of the
	 * model-side writeOp in the oracle's schedule.ts. */
	const writeScalars = (kind: WriteKind, value: number, atomIdx: number): [0 | 1, unknown] => {
		switch (kind) {
			case 'set': return [0, value];
			case 'inc': return [1, (p: unknown) => (p as number) + 1];
			case 'double': return [1, (p: unknown) => (p as number) * 2];
			case 'equalNewest': return [0, b.newestValue(atoms[atomIdx]!)];
		}
	};
	const opIndex = (appliedOps.get(b) ?? 0) + 1;
	appliedOps.set(b, opIndex);
	const uniq = `${namingEvents ?? opIndex}.${b.seq}.${b.epoch}`;
	const reg = registryOf(b);
	/** bareWrite may mint the ambient token — mirror the model's map growth. */
	const syncAmbient = (): void => {
		const amb = b.ambientToken;
		if (amb !== undefined && reg.tokens[reg.tokens.length - 1] !== amb && !reg.tokens.includes(amb)) {
			reg.tokens.push(amb);
		}
	};
	try {
		switch (op.t) {
			case 'open': reg.tokens.push(b.openBatch({ action: op.action }).id); break;
			case 'write': {
				const atom = atoms[op.atom % atoms.length]!;
				b.write(tokenAt(b, op.token), atom, ...writeScalars(op.kind, op.value, op.atom % atoms.length));
				break;
			}
			case 'bareWrite': {
				const atom = atoms[op.atom % atoms.length]!;
				b.bareWrite(atom, ...writeScalars(op.kind, op.value, op.atom % atoms.length));
				syncAmbient();
				break;
			}
			case 'settle': b.settleAction(tokenAt(b, op.token)!); break;
			case 'retire': b.retire(tokenAt(b, op.token)!); break;
			case 'passStart': reg.passes.push(b.passStart(op.root, op.include.map((i) => tokenAt(b, i)!)).id); break;
			case 'yield': b.passYield(passAt(b, op.pass)); break;
			case 'resume': b.passResume(passAt(b, op.pass)); break;
			case 'end': b.passEnd(passAt(b, op.pass), op.kind, { retireAtCommit: op.retireAtCommit.map((i) => tokenAt(b, i)!) }); break;
			case 'mount': b.mountWatcher(passAt(b, op.pass), nodes[op.node % nodes.length]!, `W${uniq}`); break;
			case 'render': b.renderWatcher(passAt(b, op.pass), watcherAt(b, op.watcher)); break;
			case 'reactEffect': mountEngineReactEffect(b, op.root, nodes[op.node % nodes.length]!, `E${uniq}`); break;
			case 'reactEffectPick':
				mountEngineReactEffectPick(
					b, op.root,
					nodes[op.sel % nodes.length]!, nodes[op.a % nodes.length]!, nodes[op.b % nodes.length]!,
					`E${uniq}`,
				);
				break;
			case 'removeReactEffect': b.removeSubscription(effectAt(b, op.effect)); break;
			case 'replayReactEffect': b.replayReactEffect(effectAt(b, op.effect)); break;
			case 'coreEffect': mountEngineCoreEffect(b, nodes[op.node % nodes.length]!, `CE${uniq}`); break;
			case 'discardAllWip': b.discardAllWip(); break;
			case 'quiesce':
				b.quiesce();
				// The model drops every retired token and ended pass here; at
				// quiescence that is all of them (no live tokens/passes remain).
				reg.tokens.length = 0;
				reg.passes.length = 0;
				break;
		}
		return true;
	} catch (err) {
		if (err instanceof BridgeScheduleError) return false;
		throw err;
	}
}

/**
 * A fresh CONCURRENT engine presented through the reference model's
 * EngineAdapter surface (its `modelAsEngine` template with the model
 * replaced by the real engine). The bridge is structurally
 * snapshot-compatible with the model, so the reference model's own
 * `snapshotModel` reads the engine's observables — engine internals
 * (kernel arena, union edges, memos) are never compared.
 */
export function engineAsAdapter(): EngineAdapter & { bridge: CosignalBridge; __syncNamingEvents(n: number): void } {
	const b = __newBridgeForTest();
	// The engine's event stream: a lossless session tracer decoded on demand
	// (the packed records are the only event channel; tests/trace-events.ts).
	const stream = attachRefereeStream(b);
	// PRODUCTION write semantics: the bridge quiet-folds bare writes at rest
	// and the model mirrors the same derivation and fold, so the corpus
	// referees the real default write path ('quiet-write' is a compared
	// event; tests/quiet-mode.spec.ts pins the arming schedules by hand).
	// ARMED S-B divergence check: every public operation's epilogue serves
	// every live arena's shadows from the arena's own walks and compares
	// against fold-truth (plus the structural validator) — the corpus runs
	// with the referee that owns the stage's STOP condition.
	armArenaCheck(b);
	buildEngineTopology(b);
	b.registerBridge();
	let drained = 0;
	let namingEvents: number | undefined;
	return {
		bridge: b,
		/** Name parity under the ⊆ delivery bound: the differ reports the
		 * model's pre-op event count so `${events}.…` names match its. */
		__syncNamingEvents(n: number): void {
			namingEvents = n;
		},
		apply: (op) => (applyEngineOp(b, op, namingEvents) ? 'applied' : 'skipped'),
		snapshot: () => snapshotModel(b as unknown as CosignalModel),
		drainEvents() {
			const events = stream.events;
			const out = comparableEvents(events.slice(drained) as ModelEvent[]);
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
//     implementation-defined [owner ruling 2026-07-06]; see
//     canonicalizeCoreEffectBlocks);
//   - delivery-decision events ('delivery'/'suppressed'/'mount-corrective'):
//     cumulative multiset ⊆ the model's, keyed (type, watcher, token, slot)
//     — mode/seq excluded (an edge-add replay carries the replay sequence).
// The ⊇-required floor is enforced indirectly: exact snapshots, exact
// value-gated corrections/effect-runs, and an audit inside the engine that
// throws BridgeInvariantViolation whenever divergence hidden by a mount
// fast-out is not covered by correctives.

const DELIVERYISH = new Set<ModelEvent['type']>(['delivery', 'suppressed', 'mount-corrective']);

/**
 * Sibling core-effect firing order is implementation-defined (owner ruling,
 * 2026-07-06, panel item W9): the engine's core effects are real kernel
 * `effect()`s flushed in the kernel's propagation order over its
 * subscriber-link lists (a link-creation *and relink* history), while the
 * model flushes its coreEffects map in mount order. The contractual
 * guarantees are each effect's observed VALUES and the operation each run
 * fires at (RCC-EF4) — so within one step, maximal contiguous blocks of
 * `core-effect-run` events are canonicalized by sorting on (effect, value)
 * on BOTH streams before the exact comparison. Effect names carry a
 * per-mount ordinal (helpers.ts mountEngineCoreEffect / the model's
 * mountCoreEffect), so names are unique and the multiset comparison is
 * unambiguous. Nothing else about the comparison changes: block boundaries
 * (any non-core-effect event) still pin placement, and values never relax.
 */
function canonicalizeCoreEffectBlocks(events: ModelEvent[]): ModelEvent[] {
	const out = events.slice();
	let i = 0;
	while (i < out.length) {
		if (out[i]!.type !== 'core-effect-run') {
			i++;
			continue;
		}
		let j = i + 1;
		while (j < out.length && out[j]!.type === 'core-effect-run') j++;
		if (j - i > 1) {
			const block = out.slice(i, j) as Extract<ModelEvent, { type: 'core-effect-run' }>[];
			block.sort((a, b) =>
				a.effect < b.effect ? -1 : a.effect > b.effect ? 1 :
				String(a.value) < String(b.value) ? -1 : String(a.value) > String(b.value) ? 1 : 0);
			for (let k = i; k < j; k++) out[k] = block[k - i]!;
		}
		i = j;
	}
	return out;
}

/** Delivery-DECISION counts, pooled across the family's three modes per
 * (watcher, token, slot). The bound is "fewer decisions, never more"
 * (plan §4.8 S-B): current-structure routing legitimately shifts modes
 * WITHIN the family — a mount join the accumulated model schedules as a
 * corrective (arming its dedup, so its write logs 'suppressed') may not
 * exist in any live arena, in which case the engine's write-time walk is
 * the FIRST notification and logs 'delivery'. One notification either way;
 * pooling keys the invariant on the decision, not its mode. */
function deliveryKeyCounts(events: ModelEvent[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const e of events) {
		if (!DELIVERYISH.has(e.type)) continue;
		const d = e as unknown as { watcher: string; token: number; slot: number };
		const key = `${d.watcher}|${d.token}|${d.slot}`;
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
	m.registerBridge();
	let drained = 0;
	const modelPool = new Map<string, number>();
	const engineUsed = new Map<string, number>();
	const namedEngine = engine as EngineAdapter & { __syncNamingEvents?(n: number): void; bridge?: CosignalBridge };
	const dpc = namedEngine.bridge !== undefined ? new DeliveryPrecedesCorrection(namedEngine.bridge) : undefined;
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

// ---- the m3-scoped delivery-precedes-correction fuzz invariant ---------------
//
// Plan §4.4.6/§4.9.3: a reconcile-correction caused by member-slot writes
// NEWER than the watcher's last render must have been PRECEDED by a
// notification (delivery / suppression / mount-corrective) since that
// render — otherwise S-B's routing silently stopped notifying. Scoped per
// m3 to the class it can police, excluding its counterexamples:
//   - quiet-mode corrections (a quiet fold's corrections mint no
//     'reconcile-correction' event — the fold's own 'quiet-write' event is
//     its whole stream — so DPC never sees them; and quiet requires zero
//     live tokens, so no retire/settle boundary observes a quiet window);
//   - mount-window repairs ('mount-urgent-correction' is a different type);
//   - older-write visibility flips (the causing token's lastWriteSeq must
//     POSTDATE the watcher's window for the assert to arm);
//   - the S-NF2-D1 family (any discard, parked token, or second boundary
//     inside the window disarms the assert — dead-arena lane degradation
//     is legal and pinned separately in arena-sb.spec.ts);
//   - §4.4.1's designed no-notification class (untracked-only reach):
//     watchers on the topology's untracked consumer (cMix) are excluded —
//     weak links never notify, BY DESIGN, so their corrections arrive bare.
// Windows reset at render/mount/commit/discard/quiesce boundaries (renders
// re-arm dedup; commits re-baseline lastRenderedValue) and after each
// correction (which also resets the engine's dedup bits).

type DpcMark = { seq: number; notified: boolean; disarmed: boolean; boundaries: number };

class DeliveryPrecedesCorrection {
	private marks = new Map<string, DpcMark>();
	private preOpTokenWriteSeq = 0;

	constructor(private bridge: CosignalBridge) {}

	private resetAll(): void {
		this.marks.clear();
	}

	private markOf(name: string): DpcMark {
		let mk = this.marks.get(name);
		if (mk === undefined) {
			mk = { seq: this.bridge.seq, notified: false, disarmed: false, boundaries: 0 };
			this.marks.set(name, mk);
		}
		return mk;
	}

	/** Resolve the retiring token's last write seq BEFORE the op applies
	 * (retirement can reclaim the record). */
	beforeOp(op: ScheduleOp): void {
		this.preOpTokenWriteSeq = 0;
		if (op.t === 'retire' || op.t === 'settle') {
			try {
				const id = tokenAt(this.bridge, op.token);
				this.preOpTokenWriteSeq = (id !== undefined ? this.bridge.tokens.get(id)?.lastWriteSeq : 0) ?? 0;
			} catch {
				// no tokens yet: the op will skip
			}
		}
	}

	afterOp(op: ScheduleOp, events: ModelEvent[]): string | undefined {
		const b = this.bridge;
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
				const node = w !== undefined ? b.nodes.get(w.node) : undefined;
				const untrackedConsumer = node !== undefined && node.name === 'cMix';
				if (
					singleBoundary &&
					!mk.disarmed &&
					mk.boundaries === 0 &&
					!untrackedConsumer &&
					this.preOpTokenWriteSeq > mk.seq &&
					!mk.notified
				) {
					return `delivery-precedes-correction violated: ${name} corrected at ${op.t} (token wrote at seq ${this.preOpTokenWriteSeq} > window ${mk.seq}) with no delivery/suppression/corrective since its window opened`;
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
		// A live parked token anywhere in the window disarms (D1 exclusion).
		let parked = false;
		for (const tok of b.tokens.values()) {
			if (tok.parked) {
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
