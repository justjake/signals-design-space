/**
 * Twin-driver helpers: the battery/scars/flags specs in this directory run
 * VERBATIM against `concurrent()` from this module — every call fans out to the
 * reference model (`cosignal-oracle`) AND the CONCURRENT engine, legality
 * decisions must agree, every value read is asserted equal on both sides,
 * and the full event stream + counters are compared after every mutation.
 * The test bodies' own `expect`s therefore assert the reference model's
 * required outcomes while the twin asserts engine ≡ model at every step.
 * `selfCheck` additionally runs the reference model's invariant battery on
 * BOTH sides (the engine through its model view — tests/model-view.ts) plus
 * one engine-only check ("K0 parity"): the kernel's newest value must equal
 * folding the atom's base value through its receipts.
 */
import { expect } from 'vitest';
import { snapshotModel } from '../../cosignal-oracle/src/adapter.js';
import { checkInvariants } from '../../cosignal-oracle/src/invariants.js';
import {
	CosignalModel,
	ScheduleError,
	type AnyNode,
	type AtomNode,
	type CoreEffect,
	type Equals,
	type ModelEvent,
	type Op,
	type Pass,
	type ReactEffect,
	type Token,
	type Value,
	type Watcher,
} from '../../cosignal-oracle/src/model.js';
import {
	__newBridgeForTest,
	BridgeScheduleError,
	type AnyNode as ENode,
	type AtomNode as EAtomNode,
	type CosignalBridge,
	type Op as EOp,
	type Pass as EPass,
	type Subscription as ESubscription,
	type World as EWorld,
} from '../src/concurrent.js';
import { effect, type Atom } from '../src/index.js';
import { modelView, RefereeMirror } from './model-view.js';

/** Scenario annotation only: the specs name each batch's React lane priority
 * for the reader; neither the engine nor the model consults it (the model's
 * Priority dimension was deleted — the annotation survives so the ~230
 * transcribed scenarios keep reading like the React schedules they mirror). */
type Priority = 'urgent' | 'default' | 'deferred';

type Thrown = { threw: false; value: unknown } | { threw: true; error: unknown };

/**
 * Delivery-decision events (the documented engine-diff tolerance surface).
 * mount-corrective joins them: the engine draws the corrective population
 * from the per-node touched set, while the model derives it from its
 * eagerly refreshed union closure — the same union-conservative
 * over-approximation as deliveries. The "at least what correctness
 * requires" floor for correctives is enforced in-engine: an internal audit
 * throws BridgeInvariantViolation whenever divergence hidden by the mount
 * fast-out is not exactly covered by a corrective.
 */
function isDeliveryish(e: ModelEvent): boolean {
	return e.type === 'delivery' || e.type === 'suppressed' || e.type === 'mount-corrective';
}

/** Delivery-DECISION counts, pooled across the family's three modes per
 * (watcher, token, slot): "fewer decisions, never more" (plan §4.8 S-B).
 * Current-structure routing shifts modes WITHIN the family — a mount join
 * the accumulated model schedules as a corrective (arming its dedup, so
 * its later write logs 'suppressed') may not exist in any live arena; the
 * engine's write-time walk is then the FIRST notification and logs
 * 'delivery'. One notification either way. */
function deliveryCounts(events: ModelEvent[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const e of events) {
		if (!isDeliveryish(e)) continue;
		const d = e as unknown as { watcher: string; token: number; slot: number };
		const key = `${d.watcher}|${d.token}|${d.slot}`;
		out.set(key, (out.get(key) ?? 0) + 1);
	}
	return out;
}

function capture(fn: () => unknown): Thrown {
	try {
		return { threw: false, value: fn() };
	} catch (error) {
		return { threw: true, error };
	}
}

// ---- referee effect constructors (test-side compositions over the REAL
// mechanism: mountCommittedObserver + a `body` + captureRun; the body path is
// the engine's inline-run + event-mint machinery lockstep compares) ----------

/** Referee configuration — a single-node body (the engine twin of the
 * model's mountReactEffect). */
export function mountEngineReactEffect(b: CosignalBridge, rootId: string, node: ENode, name: string): ESubscription {
	const e = b.mountCommittedObserver(rootId, name);
	e.body = () => void b.captureRead(node);
	b.captureRun(e.id, e.body);
	return e;
}

/** Referee configuration — a body that re-chooses deps CAUSALLY:
 * captureRead(sel) ? captureRead(a) : captureRead(b). */
export function mountEngineReactEffectPick(b: CosignalBridge, rootId: string, sel: ENode, a: ENode, bb: ENode, name: string): ESubscription {
	const e = b.mountCommittedObserver(rootId, name);
	e.body = () => void (b.captureRead(sel) ? b.captureRead(a) : b.captureRead(bb));
	b.captureRun(e.id, e.body);
	return e;
}

/** The record `mountEngineCoreEffect` returns — the model CoreEffect's
 * engine twin (specs read `runs`/`lastValue`; the referee reads the stream). */
export type EngineCoreEffect = {
	name: string;
	runs: number;
	lastValue: Value;
	dispose: () => void;
};

/** Per-bridge core-effect mount ordinal (never reset — mirrors the model's
 * `coreEffectMounts`; both sides tick once per mount in lockstep, so minted
 * names agree). */
const coreEffectMounts = new WeakMap<CosignalBridge, number>();

/**
 * Mount a core effect: a REAL kernel `effect()` whose body does a plain
 * tracked kernel read of the node's public handle (host world-routing is
 * bypassed inside a kernel frame — `activeSub !== 0`), so the kernel's own
 * propagation over its subscriber links re-runs it at exactly the writes
 * that advance the newest fold (the eager kernel apply). The mount run
 * baselines silently; later runs value-gate on `Object.is` and report
 * through the bridge's `logCoreEffectRun` referee seam.
 *
 * Names take a per-mount ordinal suffix (`#k`): sibling core-effect firing
 * order under one operation is implementation-defined (owner ruling
 * 2026-07-06), so the lockstep differ compares same-step runs as a multiset
 * sorted on (effect, value) — duplicate names (two mounts with no
 * intervening event/seq used to mint the same `CE${events}.${seq}.${epoch}`
 * uniq) would make that comparison ambiguous.
 */
export function mountEngineCoreEffect(b: CosignalBridge, node: ENode, name: string): EngineCoreEffect {
	const ordinal = coreEffectMounts.get(b) ?? 0;
	coreEffectMounts.set(b, ordinal + 1);
	const rec: EngineCoreEffect = { name: `${name}#${ordinal}`, runs: 0, lastValue: undefined, dispose: () => {} };
	let mounted = false;
	rec.dispose = effect(() => {
		const value: Value = node.handle.state; // tracked kernel read (newest world)
		if (!mounted) {
			mounted = true;
			rec.lastValue = value; // silent baseline (the model seeds lastValue the same way)
			return;
		}
		if (Object.is(value, rec.lastValue)) return; // value gate
		rec.lastValue = value;
		rec.runs++;
		b.logCoreEffectRun(rec.name, value);
	});
	return rec;
}

export class TwinDriver {
	readonly model = new CosignalModel();
	readonly engine: CosignalBridge = __newBridgeForTest();
	/** Full-history mirror (archives via onCompact + origins) — the referee
	 * retains it OUTSIDE the engine; see tests/model-view.ts. */
	readonly mirror = new RefereeMirror();
	/** The engine presented in the model's shape for the oracle's checkers. */
	private readonly view = modelView(this.engine, this.mirror) as unknown as CosignalModel;
	private nodeMap = new Map<AnyNode, ENode>();
	private passMap = new Map<number, EPass>();
	/** Model react-effect id → engine subscription id. The id spaces diverge
	 * once a core effect mounts: the model's `nextEffect` ticks for BOTH
	 * effect kinds, the engine's only for committed observers (core effects
	 * are kernel `effect()`s, not bridge records). */
	private effectMap = new Map<number, number>();

	constructor() {
		// The reference model's retention invariant (checkRetention in
		// invariants.ts) shadow-folds over the full history; the engine
		// retains none of it — the mirror archives each receipt as compaction
		// folds it out (retaining in-engine would grow without bound under a
		// workload that never quiesces).
		this.mirror.attach(this.engine);
		// NF2 S-A dual bookkeeping: after every twin op, the engine serves
		// every live arena's shadows FROM THE ARENA and compares against the
		// memo-served values (plus the structural validator). ANY divergence
		// throws — the stage's STOP condition.
		this.engine.__setArenaCheck(true);
	}

	// ---- state the test bodies read directly (model side; engine compared per op)
	get events(): ModelEvent[] { return this.model.events; }
	get tokens(): CosignalModel['tokens'] { return this.model.tokens; }
	get slots(): CosignalModel['slots'] { return this.model.slots; }
	get passes(): CosignalModel['passes'] { return this.model.passes; }
	get roots(): CosignalModel['roots'] { return this.model.roots; }
	get nodes(): CosignalModel['nodes'] { return this.model.nodes; }
	get watchers(): CosignalModel['watchers'] { return this.model.watchers; }
	get seq(): number { return this.model.seq; }
	get epoch(): number { return this.model.epoch; }
	get ambientToken(): number | undefined { return this.model.ambientToken; }

	private toEngine(node: AnyNode): ENode {
		const e = this.nodeMap.get(node);
		if (e === undefined) throw new Error(`twin: node ${node.name} was not created through the driver`);
		return e;
	}

	private toEngineWorldPass(pass: Pass): EPass {
		const p = this.passMap.get(pass.id);
		if (p === undefined) throw new Error(`twin: pass ${pass.id} was not created through the driver`);
		return p;
	}

	private toEngineEffect(modelId: number): number {
		const id = this.effectMap.get(modelId);
		if (id === undefined) throw new Error(`twin: react effect ${modelId} was not created through the driver`);
		return id;
	}

	/** Run a mutation on both sides; legality must agree; model's outcome wins. */
	private both<T>(label: string, onModel: () => T, onEngine: () => unknown): T {
		const m = capture(onModel);
		const e = capture(onEngine);
		if (m.threw !== e.threw) {
			const detail = m.threw ? `model threw ${(m as { error: unknown }).error}` : `engine threw ${(e as { error: unknown }).error}`;
			expect.fail(`twin ${label}: legality diverged (${detail})`);
		}
		if (m.threw && e.threw) {
			const mSched = (m.error as object) instanceof ScheduleError;
			const eSched = (e.error as object) instanceof BridgeScheduleError;
			if (mSched !== eSched) {
				expect.fail(`twin ${label}: error class diverged (model ${String(m.error)}, engine ${String(e.error)})`);
			}
			throw m.error;
		}
		this.compareStreams(label);
		return (m as { value: T }).value;
	}

	/**
	 * Event stream, sequence counters, and cas must agree after every op.
	 *
	 * Delivery tolerance (the relaxation documented in the reference
	 * model's README, `cosignal-oracle`): the model's delivery reachability
	 * recomputes the union graph eagerly at every write, while the engine —
	 * for speed — discovers edges at evaluation sites and replays live
	 * slots when an edge is added, so delivery/suppressed decisions may lag
	 * the model's or drop when a never-materialized union path was the only
	 * route. Comparator: 'delivery'/'suppressed' events are checked as
	 * "engine ⊆ model, cumulatively, keyed by (type, watcher, token, slot)"
	 * (mode/seq excluded: a replayed delivery carries the replay sequence);
	 * every other event type must match exactly, in order. The "at least
	 * what correctness requires" floor is enforced indirectly: observable
	 * snapshots, reconcile corrections, effect runs, and counters stay
	 * exact.
	 */
	private compareStreams(label: string): void {
		this.engine.__checkArenas(); // NF2 S-A divergence check (throws on ANY arena↔memo mismatch)
		expect(this.engine.seq, `twin ${label}: seq diverged`).toBe(this.model.seq);
		expect(this.engine.cas, `twin ${label}: cas diverged`).toBe(this.model.cas);
		expect(this.engine.epoch, `twin ${label}: epoch diverged`).toBe(this.model.epoch);
		const mRest = this.model.events.filter((e) => !isDeliveryish(e));
		const eRest = (this.engine.events as ModelEvent[]).filter((e) => !isDeliveryish(e));
		const me = JSON.stringify(mRest);
		const ee = JSON.stringify(eRest);
		if (me !== ee) {
			expect.fail(`twin ${label}: event streams diverged\nmodel  ${me}\nengine ${ee}`);
		}
		const pool = deliveryCounts(this.model.events);
		const engineCounts = deliveryCounts(this.engine.events as ModelEvent[]);
		for (const [key, n] of engineCounts) {
			const avail = pool.get(key) ?? 0;
			if (n > avail) {
				expect.fail(`twin ${label}: engine over-delivered beyond the union-conservative bound: ${key} ×${n} vs model ×${avail}`);
			}
		}
	}

	// ------------------------------------------------------------- surface

	registerBridge(): void {
		this.both('registerBridge', () => this.model.registerBridge(), () => this.engine.registerBridge());
	}

	atom(name: string, initial: Value, equals?: Equals): AtomNode {
		const mNode = this.model.atom(name, initial, equals);
		const eNode = this.engine.atom(name, initial, equals);
		expect(eNode.id, 'twin atom: node ids diverged').toBe(mNode.id);
		this.nodeMap.set(mNode, eNode);
		this.mirror.setOrigin(eNode as EAtomNode, initial);
		return mNode;
	}

	/**
	 * Adopt a pre-existing PUBLIC kernel atom on both sides. The engine reads
	 * the kernel-current value (adoptAtom — pre-registration history is
	 * committed-only base state by construction); the model, which has no
	 * kernel, mirrors adoption as construction-time seeding with that same
	 * value. Neither side mints a receipt, token, or event.
	 */
	adoptAtom(name: string, handle: Atom<unknown>): AtomNode {
		const eNode = this.engine.adoptAtom(name, handle);
		const mNode = this.model.atom(name, eNode.base);
		expect(eNode.id, 'twin adoptAtom: node ids diverged').toBe(mNode.id);
		expect(Object.is(mNode.base, eNode.base), 'twin adoptAtom: seeded base diverged').toBe(true);
		this.nodeMap.set(mNode, eNode);
		this.mirror.setOrigin(eNode, eNode.base);
		return mNode;
	}

	computed(name: string, fn: (read: (n: AnyNode) => Value, untracked: (n: AnyNode) => Value) => Value) {
		const mNode = this.model.computed(name, fn);
		const eNode = this.engine.computed(name, (read, untracked) =>
			fn((d) => read(this.toEngine(d as AnyNode)), (d) => untracked(this.toEngine(d as AnyNode))),
		);
		expect(eNode.id).toBe(mNode.id);
		this.nodeMap.set(mNode, eNode);
		return mNode;
	}

	openBatch(_priority: Priority, opts?: { action?: boolean; ambient?: boolean }): Token {
		let eId: number | undefined;
		const t = this.both('openBatch', () => this.model.openBatch(opts), () => {
			eId = this.engine.openBatch(opts).id; // neither side mints a priority — scheduling stays React's (see the Priority annotation type)
		});
		expect(eId, 'twin openBatch: token ids diverged').toBe(t.id);
		return t;
	}

	write(tokenId: number | undefined, node: AtomNode, op: Op): void {
		const mark = this.model.events.length;
		this.both('write', () => this.model.write(tokenId, node, op), () =>
			this.engine.write(tokenId, this.toEngine(node) as never, op));
		if (tokenId === undefined) this.mirrorQuietFold(node, op, mark);
	}

	bareWrite(node: AtomNode, op: Op): void {
		const mark = this.model.events.length;
		this.both('bareWrite', () => this.model.bareWrite(node, op), () =>
			this.engine.bareWrite(this.toEngine(node) as never, op));
		this.mirrorQuietFold(node, op, mark);
	}

	/** A quiet fold advances the engine's base with no receipt and no
	 * compaction, so the mirror's `onCompact` feed never sees it. The driver
	 * appends the fold's ledger entry to the mirror archive itself — exactly
	 * what the model's quietWrite does to ITS archive — so the view's
	 * full-history shadow fold (retention invariant) keeps reconstructing
	 * every world. Detection is by the model's own 'quiet-write' event
	 * (compareStreams already proved the engine minted the same one). */
	private mirrorQuietFold(node: AtomNode, op: Op, mark: number): void {
		for (const e of this.model.events.slice(mark)) {
			if (e.type !== 'quiet-write') continue;
			const eNode = this.toEngine(node) as EAtomNode;
			this.mirror.archiveOf(eNode).push({ op: op as EOp, token: 0, slot: -1, seq: e.seq, retiredSeq: e.seq });
		}
	}

	scopeWrite(tokenId: number, node: AtomNode, op: Op): void {
		this.both('scopeWrite', () => this.model.scopeWrite(tokenId, node, op), () =>
			this.engine.scopeWrite(tokenId, this.toEngine(node) as never, op));
	}

	settleAction(tokenId: number, committed: boolean): void {
		this.both('settleAction', () => this.model.settleAction(tokenId, committed), () =>
			this.engine.settleAction(tokenId, committed));
	}

	retire(tokenId: number, committed: boolean): void {
		this.both('retire', () => this.model.retire(tokenId, committed), () =>
			this.engine.retire(tokenId, committed));
	}

	passStart(root: string, includeTokens: number[]): Pass {
		let ePass: EPass | undefined;
		const mPass = this.both('passStart', () => this.model.passStart(root, includeTokens), () => {
			ePass = this.engine.passStart(root, includeTokens);
			return ePass;
		});
		expect(ePass!.id, 'twin passStart: pass ids diverged').toBe(mPass.id);
		expect(ePass!.pin, 'twin passStart: pins diverged').toBe(mPass.pin);
		this.passMap.set(mPass.id, ePass!);
		return mPass;
	}

	passYield(id: number): void {
		this.both('passYield', () => this.model.passYield(id), () => this.engine.passYield(id));
	}

	passResume(id: number): void {
		this.both('passResume', () => this.model.passResume(id), () => this.engine.passResume(id));
	}

	passEnd(id: number, kind: 'commit' | 'discard', opts?: { retireAtCommit?: number[] }): void {
		this.both('passEnd', () => this.model.passEnd(id, kind, opts), () => this.engine.passEnd(id, kind, opts));
	}

	mountWatcher(passId: number, node: AnyNode, name: string): Watcher {
		let eId: number | undefined;
		const w = this.both('mountWatcher', () => this.model.mountWatcher(passId, node, name), () => {
			eId = this.engine.mountWatcher(passId, this.toEngine(node), name).id;
		});
		expect(eId, 'twin mountWatcher: watcher ids diverged').toBe(w.id);
		return w;
	}

	renderWatcher(passId: number, watcherId: number): void {
		this.both('renderWatcher', () => this.model.renderWatcher(passId, watcherId), () =>
			this.engine.renderWatcher(passId, watcherId));
	}

	deferMount(watcherId: number): void {
		this.both('deferMount', () => this.model.deferMount(watcherId), () => this.engine.deferMount(watcherId));
	}

	adoptMount(passId: number, watcherId: number): void {
		this.both('adoptMount', () => this.model.adoptMount(passId, watcherId), () =>
			this.engine.adoptMount(passId, watcherId));
	}

	mountReactEffect(root: string, node: AnyNode, name: string): ReactEffect {
		let eId: number | undefined;
		const e = this.both('mountReactEffect', () => this.model.mountReactEffect(root, node, name), () => {
			eId = mountEngineReactEffect(this.engine, root, this.toEngine(node), name).id;
		});
		this.effectMap.set(e.id, eId!);
		return e;
	}

	mountReactEffectPick(root: string, sel: AnyNode, a: AnyNode, b: AnyNode, name: string): ReactEffect {
		let eId: number | undefined;
		const e = this.both('mountReactEffectPick',
			() => this.model.mountReactEffectPick(root, sel, a, b, name),
			() => {
				eId = mountEngineReactEffectPick(this.engine, root, this.toEngine(sel), this.toEngine(a), this.toEngine(b), name).id;
			});
		this.effectMap.set(e.id, eId!);
		return e;
	}

	removeReactEffect(id: number): void {
		this.both('removeReactEffect', () => this.model.removeReactEffect(id), () =>
			this.engine.removeSubscription(this.toEngineEffect(id)));
	}

	replayReactEffect(id: number): void {
		this.both('replayReactEffect', () => this.model.replayReactEffect(id), () =>
			this.engine.replayReactEffect(this.toEngineEffect(id)));
	}

	mountCoreEffect(node: AnyNode, name: string): CoreEffect {
		return this.both('mountCoreEffect', () => this.model.mountCoreEffect(node, name), () =>
			mountEngineCoreEffect(this.engine, this.toEngine(node), name));
	}

	discardAllWip(): void {
		this.both('discardAllWip', () => this.model.discardAllWip(), () => this.engine.discardAllWip());
	}

	quiesce(): void {
		this.both('quiesce', () => this.model.quiesce(), () => this.engine.quiesce());
		// Mirror the model's episode reset: archives belong to the dead episode;
		// origins reset to base (engine-side the view folds from these).
		this.mirror.clearArchives();
		this.mirror.originsFromBase(this.engine);
	}

	livePins(): number[] {
		const m = this.model.livePins();
		const e: number[] = [];
		for (const p of this.engine.passes.values()) if (p.state !== 'ended') e.push(p.pin);
		expect(e, 'twin livePins diverged').toEqual(m);
		return m;
	}

	// ------------------------------------------------------- world reads

	newestValue(node: AnyNode): Value {
		const m = this.model.newestValue(node);
		const e = this.engine.newestValue(this.toEngine(node));
		expect(Object.is(m, e), `twin newestValue(${node.name}): model ${String(m)} ≠ engine ${String(e)}`).toBe(true);
		return m;
	}

	committedValue(node: AnyNode, root: string): Value {
		const m = this.model.committedValue(node, root);
		const e = this.engine.committedValue(this.toEngine(node), root);
		expect(Object.is(m, e), `twin committedValue(${node.name}, ${root}): model ${String(m)} ≠ engine ${String(e)}`).toBe(true);
		return m;
	}

	passValue(node: AnyNode, pass: Pass): Value {
		const m = this.model.passValue(node, pass);
		const e = this.engine.passValue(this.toEngine(node), this.toEngineWorldPass(pass));
		expect(Object.is(m, e), `twin passValue(${node.name}, pass ${pass.id}): model ${String(m)} ≠ engine ${String(e)}`).toBe(true);
		return m;
	}

	eventsOfType<T extends ModelEvent['type']>(type: T): Extract<ModelEvent, { type: T }>[] {
		const m = this.model.eventsOfType(type);
		if (type !== 'delivery' && type !== 'suppressed' && type !== 'mount-corrective') {
			const e = this.engine.eventsOfType(type as never);
			expect(JSON.stringify(e), `twin eventsOfType(${type}) diverged`).toBe(JSON.stringify(m));
		}
		// deliveryish types: covered cumulatively by compareStreams' ⊆ bound;
		// the test bodies' assertions pin the reference model's required outcomes.
		return m;
	}

	eventsSince(mark: number): ModelEvent[] {
		// Marks are model-stream positions; deliveryish lag means the engine
		// stream's positions no longer align 1:1. The full-stream comparison
		// in compareStreams (after EVERY op) already pins the non-delivery
		// stream exactly and bounds deliveries cumulatively, so the window
		// compare adds nothing — return the model's window (the required
		// outcomes the test bodies assert).
		return this.model.eventsSince(mark);
	}

	/** Full parity + invariants on both sides + the engine-only "K0 parity" check. */
	verify(): void {
		this.compareStreams('verify');
		expect(JSON.stringify(snapshotModel(this.view)), 'twin observable snapshots diverged')
			.toBe(JSON.stringify(snapshotModel(this.model)));
		checkInvariants(this.model);
		checkInvariants(this.view);
		// Eager-apply invariant: writes land in the kernel immediately, so the
		// kernel's newest value must equal replaying the receipts over the base.
		for (const n of this.engine.nodes.values()) {
			if (n.kind !== 'atom') continue;
			const folded = this.engine.foldAtom(n, { kind: 'newest' } as EWorld);
			const kernel = this.engine.newestValue(n);
			expect(Object.is(folded, kernel), `K0 parity: atom ${n.name} kernel ${String(kernel)} ≠ fold ${String(folded)}`).toBe(true);
		}
	}
}

/** A twin with the bridge registered on both sides during setup. */
export function concurrent(): TwinDriver {
	const t = new TwinDriver();
	t.registerBridge();
	return t;
}

/** Mount a watcher on `node` via a clean committed render on `root`. */
export function mountCommitted(m: TwinDriver, root: string, node: AnyNode, name: string): Watcher {
	const p = m.passStart(root, []);
	const w = m.mountWatcher(p.id, node, name);
	m.passEnd(p.id, 'commit');
	return w;
}

/** Render `token`'s pass on `root` (watchers re-rendered), commit, retire the token. */
export function commitAndRetire(m: TwinDriver, root: string, token: Token, watchers: Watcher[] = []): void {
	const p = m.passStart(root, [token.id]);
	for (const w of watchers) m.renderWatcher(p.id, w.id);
	m.passEnd(p.id, 'commit', { retireAtCommit: [token.id] });
}

/** Open a pass including the given tokens. */
export function pass(m: TwinDriver, root: string, tokens: Token[]): Pass {
	return m.passStart(root, tokens.map((t) => t.id));
}

/** Full twin verification (events, snapshots, invariants both sides, K0 parity). */
export function selfCheck(m: TwinDriver): void {
	m.verify();
}

export function set(value: unknown): { kind: 'set'; value: unknown } {
	return { kind: 'set', value };
}

export function update(fn: (p: unknown) => unknown): { kind: 'update'; fn: (p: unknown) => unknown } {
	return { kind: 'update', fn };
}
