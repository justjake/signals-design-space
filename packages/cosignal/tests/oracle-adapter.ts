/**
 * The oracle's EngineAdapter implemented over the LOGGED bridge
 * (packages/cosignal-oracle/src/adapter.ts — "a future engine plugs into the
 * fuzz harness by implementing this surface"). The oracle package is imported
 * by relative path: it is a dev-side referee, deliberately NOT a package
 * dependency of cosignal (no lockfile entry; the shipped entries never
 * reference it).
 *
 * `applyEngineOp` mirrors the oracle's `applyOneOp` op-for-op — including the
 * entity indexing (creation order over the live maps), the write-kind
 * coercions, and the `${events}.${seq}.${epoch}` uniq naming — but resolves
 * everything against the ENGINE's state and treats `BridgeScheduleError` as
 * the skip signal, so legality decisions are computed independently on each
 * side and then diffed.
 */

import {
	__newBridgeForTest,
	BridgeScheduleError,
	type AtomNode,
	type CosignalBridge,
	type Op,
} from '../src/logged.js';
import {
	comparableEvents,
	snapshotModel,
	type DiffResult,
	type EngineAdapter,
} from '../../cosignal-oracle/src/adapter.js';
import { CosignalModel, type ModelEvent } from '../../cosignal-oracle/src/model.js';
import { applyOneOp, buildTopology, type ScheduleOp, type WriteKind } from '../../cosignal-oracle/src/schedule.js';

/** The oracle's fixed fuzz topology (schedule.ts buildTopology), on the engine. */
export function buildEngineTopology(b: CosignalBridge) {
	const flag = b.atom('flag', 0);
	const a = b.atom('a', 0);
	const bb = b.atom('b', 0);
	const r = b.reducerAtom('r', (s, act) => {
		if (act === 'inc') return (s as number) + 1;
		if (act === 'noop') return s;
		return (s as number) * 2;
	}, 0);
	const cFlip = b.computed('cFlip', (read) => (read(flag) ? read(a) : read(bb)));
	const cSum = b.computed('cSum', (read) => (read(a) as number) + (read(bb) as number) + (read(r) as number));
	const cChain = b.computed('cChain', (read) => (read(cFlip) as number) + 10);
	const cMix = b.computed('cMix', (read, untracked) => (read(bb) as number) + (untracked(a) as number));
	return { atoms: [flag, a, bb, r], computeds: [cFlip, cSum, cChain, cMix] };
}

/**
 * Adapter-side entity registries. The MODEL retains dead token/pass records
 * until quiescence, and schedule ops resolve entities by index over those
 * maps; the engine now reclaims dead records mid-episode (SPK-K1), so the
 * adapter mirrors the model's population itself to keep op resolution
 * identical on both sides. Purely an indexing-fidelity shim — no tolerance.
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

/** Apply ONE schedule op to a bridge holding the fixed topology (applyOneOp twin). */
export function applyEngineOp(b: CosignalBridge, op: ScheduleOp): boolean {
	const allNodes = [...b.nodes.values()];
	const atoms = allNodes.filter((n): n is AtomNode => n.kind === 'atom').slice(0, 4);
	const nodes = allNodes.slice(0, 8);
	const writeOp = (kind: WriteKind, value: number, atomIdx: number): Op => {
		switch (kind) {
			case 'set': return { kind: 'set', value };
			case 'inc': return { kind: 'update', fn: (p) => (p as number) + 1 };
			case 'double': return { kind: 'update', fn: (p) => (p as number) * 2 };
			case 'equalNewest': return { kind: 'set', value: b.newestValue(atoms[atomIdx]!) };
			case 'dispatch': return { kind: 'dispatch', action: value % 2 === 0 ? 'inc' : 'noop' };
		}
	};
	const uniq = `${b.events.length}.${b.seq}.${b.epoch}`;
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
			case 'open': reg.tokens.push(b.openBatch(op.priority, { action: op.action }).id); break;
			case 'write': {
				const atom = atoms[op.atom % atoms.length]!;
				const kind: WriteKind = atom.reducer !== undefined && op.kind !== 'equalNewest' ? 'dispatch' : op.kind === 'dispatch' ? 'set' : op.kind;
				b.write(tokenAt(b, op.token), atom, writeOp(kind, op.value, op.atom % atoms.length));
				break;
			}
			case 'bareWrite': {
				const atom = atoms[op.atom % atoms.length]!;
				const kind: WriteKind = atom.reducer !== undefined ? 'dispatch' : op.kind === 'dispatch' ? 'set' : op.kind;
				b.bareWrite(atom, writeOp(kind, op.value, op.atom % atoms.length));
				syncAmbient();
				break;
			}
			case 'scopeWrite': {
				const atom = atoms[op.atom % atoms.length]!;
				const o: Op = atom.reducer !== undefined ? { kind: 'dispatch', action: 'inc' } : { kind: 'set', value: op.value };
				b.scopeWrite(tokenAt(b, op.token)!, atom, o);
				break;
			}
			case 'settle': b.settleAction(tokenAt(b, op.token)!, op.committed); break;
			case 'retire': b.retire(tokenAt(b, op.token)!, op.committed); break;
			case 'passStart': reg.passes.push(b.passStart(op.root, op.include.map((i) => tokenAt(b, i)!)).id); break;
			case 'yield': b.passYield(passAt(b, op.pass)); break;
			case 'resume': b.passResume(passAt(b, op.pass)); break;
			case 'end': b.passEnd(passAt(b, op.pass), op.kind, { retireAtCommit: op.retireAtCommit.map((i) => tokenAt(b, i)!) }); break;
			case 'mount': b.mountWatcher(passAt(b, op.pass), nodes[op.node % nodes.length]!, `W${uniq}`); break;
			case 'render': b.renderWatcher(passAt(b, op.pass), watcherAt(b, op.watcher)); break;
			case 'reactEffect': b.mountReactEffect(op.root, nodes[op.node % nodes.length]!, `E${uniq}`); break;
			case 'coreEffect': b.mountCoreEffect(nodes[op.node % nodes.length]!, `CE${uniq}`); break;
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
 * A fresh LOGGED engine presented through the oracle's EngineAdapter surface
 * (the `modelAsEngine` template with the model replaced by the real engine).
 * The bridge is structurally snapshot-compatible with the model, so the
 * oracle's own `snapshotModel` reads the engine's observables — engine
 * internals (kernel plane, union edges, memos) are never compared.
 */
export function engineAsAdapter(): EngineAdapter & { bridge: CosignalBridge } {
	const b = __newBridgeForTest();
	buildEngineTopology(b);
	b.registerBridge();
	let drained = 0;
	return {
		bridge: b,
		apply: (op) => (applyEngineOp(b, op) ? 'applied' : 'skipped'),
		snapshot: () => snapshotModel(b as unknown as CosignalModel),
		drainEvents() {
			const out = comparableEvents(b.events.slice(drained) as ModelEvent[]);
			drained = b.events.length;
			return out;
		},
	};
}

// ---- the tolerant differ (perf pass P1) -------------------------------------
//
// The oracle's own `diffAgainstModel` compares the comparable event stream
// EXACTLY per step. The SPK-N1 machinery discovers union edges at evaluation
// sites and replays live slots at edge-adds (§5.5/§5.9), so delivery-decision
// timing may lag the model's eager per-write union refresh — the oracle
// README's documented engine-diff tolerance ("engine ⊇ required, ⊆
// union-conservative"). This differ keeps every other comparison EXACT:
//   - op legality per step (exact);
//   - the full observable snapshot per step (exact — values never relax);
//   - non-delivery comparable events per step (exact, in order);
//   - delivery-decision events ('delivery'/'suppressed'/'mount-corrective'):
//     cumulative multiset ⊆ the model's, keyed (type, watcher, token, slot)
//     — mode/seq excluded (an edge-add replay carries the replay sequence).
// The ⊇-required floor is enforced indirectly: exact snapshots, exact
// value-gated corrections/effect-runs, and the engine's in-engine §5.10
// errata-2 audit (BridgeInvariantViolation on uncovered fast-outs).

const DELIVERYISH = new Set<ModelEvent['type']>(['delivery', 'suppressed', 'mount-corrective']);

function deliveryKeyCounts(events: ModelEvent[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const e of events) {
		if (!DELIVERYISH.has(e.type)) continue;
		const d = e as unknown as { type: string; watcher: string; token: number; slot: number };
		const key = `${d.type}|${d.watcher}|${d.token}|${d.slot}`;
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
	for (let step = 0; step < ops.length; step++) {
		const ok = applyOneOp(m, ops[step]!);
		const mEvents = comparableEvents(m.events.slice(drained));
		drained = m.events.length;
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
		const mRest = JSON.stringify(mEvents.filter((e) => !DELIVERYISH.has(e.type)));
		const eRest = JSON.stringify(eEvents.filter((e) => !DELIVERYISH.has(e.type)));
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
	}
	return undefined;
}
