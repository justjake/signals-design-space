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
	type EngineAdapter,
} from '../../cosignal-oracle/src/adapter.js';
import type { CosignalModel, ModelEvent } from '../../cosignal-oracle/src/model.js';
import type { ScheduleOp, WriteKind } from '../../cosignal-oracle/src/schedule.js';

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

function tokenAt(b: CosignalBridge, index: number): number | undefined {
	const ids = [...b.tokens.keys()];
	if (ids.length === 0) throw new BridgeScheduleError('no tokens yet');
	return ids[index % ids.length];
}

function passAt(b: CosignalBridge, index: number): number {
	const ids = [...b.passes.keys()];
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
	try {
		switch (op.t) {
			case 'open': b.openBatch(op.priority, { action: op.action }); break;
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
			case 'passStart': b.passStart(op.root, op.include.map((i) => tokenAt(b, i)!)); break;
			case 'yield': b.passYield(passAt(b, op.pass)); break;
			case 'resume': b.passResume(passAt(b, op.pass)); break;
			case 'end': b.passEnd(passAt(b, op.pass), op.kind, { retireAtCommit: op.retireAtCommit.map((i) => tokenAt(b, i)!) }); break;
			case 'mount': b.mountWatcher(passAt(b, op.pass), nodes[op.node % nodes.length]!, `W${uniq}`); break;
			case 'render': b.renderWatcher(passAt(b, op.pass), watcherAt(b, op.watcher)); break;
			case 'reactEffect': b.mountReactEffect(op.root, nodes[op.node % nodes.length]!, `E${uniq}`); break;
			case 'coreEffect': b.mountCoreEffect(nodes[op.node % nodes.length]!, `CE${uniq}`); break;
			case 'discardAllWip': b.discardAllWip(); break;
			case 'quiesce': b.quiesce(); break;
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
