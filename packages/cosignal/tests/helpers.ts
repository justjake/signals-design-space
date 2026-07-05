/**
 * Twin-driver helpers: the oracle's battery/scars/flags specs run VERBATIM
 * against `logged()` from this module — every call fans out to the naive
 * model AND the LOGGED engine, legality decisions must agree, every value
 * read is asserted equal on both sides, and the full event stream + counters
 * are compared after every mutation. The spec bodies' own `expect`s therefore
 * assert the model's Required outcomes while the twin asserts engine ≡ model
 * at every step. `selfCheck` additionally runs the oracle's invariant battery
 * on BOTH sides (the bridge is structurally invariant-compatible) plus the
 * engine-only K0 check: kernel newest value ≡ fold(base, receipts).
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
	type Priority,
	type ReactEffect,
	type Reducer,
	type Token,
	type Value,
	type Watcher,
} from '../../cosignal-oracle/src/model.js';
import {
	__newBridgeForTest,
	BridgeScheduleError,
	type AnyNode as ENode,
	type CosignalBridge,
	type Pass as EPass,
	type World as EWorld,
} from '../src/logged.js';

type Thrown = { threw: false; value: unknown } | { threw: true; error: unknown };

/**
 * Delivery-decision events (the documented engine-diff tolerance surface).
 * mount-corrective joins them: §5.10's corrective population is the touched
 * word (`r = touched(n)`), while the model derives it from its eagerly
 * refreshed union closure — same union-conservative over-approximation as
 * deliveries. The engine's ⊇-required floor for correctives is enforced
 * in-engine: the errata-2 audit throws BridgeInvariantViolation whenever
 * fast-out-suppressed divergence is not exactly corrective-covered.
 */
function isDeliveryish(e: ModelEvent): boolean {
	return e.type === 'delivery' || e.type === 'suppressed' || e.type === 'mount-corrective';
}

function deliveryCounts(events: ModelEvent[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const e of events) {
		if (!isDeliveryish(e)) continue;
		const d = e as unknown as { type: string; watcher: string; token: number; slot: number };
		const key = `${d.type}|${d.watcher}|${d.token}|${d.slot}`;
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

export class TwinDriver {
	readonly model = new CosignalModel();
	readonly engine: CosignalBridge = __newBridgeForTest();
	private nodeMap = new Map<AnyNode, ENode>();
	private passMap = new Map<number, EPass>();

	constructor() {
		// The oracle retention invariant (invariants.ts checkRetention) shadow-
		// folds over the full history; the engine keeps its archive only when
		// asked (SPK-K1: unbounded under never-quiescent soak otherwise).
		this.engine.retainArchive = true;
	}

	// ---- state the spec bodies read directly (model side; engine compared per op)
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
	 * Delivery tolerance (the oracle README's FIRST documented relaxation,
	 * activated by the SPK-N1 perf pass): the model's delivery reachability
	 * recomputes the union graph eagerly at every write, while the engine
	 * discovers edges at evaluation sites and replays live slots through
	 * edge-adds (§5.5/§5.9) — so delivery/suppressed decisions may lag the
	 * model's or drop when a never-materialized union path was the only
	 * route. Comparator: 'delivery'/'suppressed' events are checked as
	 * "engine ⊆ model, cumulatively, keyed by (type, watcher, token, slot)"
	 * (mode/seq excluded: a replayed delivery carries the replay sequence);
	 * every other event type must match exactly, in order. The ⊇-required
	 * floor is enforced indirectly: observable snapshots, reconcile
	 * corrections, effect runs, and counters stay exact.
	 */
	private compareStreams(label: string): void {
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
		return mNode;
	}

	reducerAtom(name: string, reducer: Reducer, initial: Value): AtomNode {
		const mNode = this.model.reducerAtom(name, reducer, initial);
		const eNode = this.engine.reducerAtom(name, reducer, initial);
		expect(eNode.id).toBe(mNode.id);
		this.nodeMap.set(mNode, eNode);
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

	openBatch(priority: Priority, opts?: { action?: boolean; ambient?: boolean }): Token {
		let eId: number | undefined;
		const t = this.both('openBatch', () => this.model.openBatch(priority, opts), () => {
			eId = this.engine.openBatch(priority, opts).id;
		});
		expect(eId, 'twin openBatch: token ids diverged').toBe(t.id);
		return t;
	}

	write(tokenId: number | undefined, node: AtomNode, op: Op): void {
		this.both('write', () => this.model.write(tokenId, node, op), () =>
			this.engine.write(tokenId, this.toEngine(node) as never, op));
	}

	bareWrite(node: AtomNode, op: Op): void {
		this.both('bareWrite', () => this.model.bareWrite(node, op), () =>
			this.engine.bareWrite(this.toEngine(node) as never, op));
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
		return this.both('mountReactEffect', () => this.model.mountReactEffect(root, node, name), () =>
			this.engine.mountReactEffect(root, this.toEngine(node), name));
	}

	mountCoreEffect(node: AnyNode, name: string): CoreEffect {
		return this.both('mountCoreEffect', () => this.model.mountCoreEffect(node, name), () =>
			this.engine.mountCoreEffect(this.toEngine(node), name));
	}

	discardAllWip(): void {
		this.both('discardAllWip', () => this.model.discardAllWip(), () => this.engine.discardAllWip());
	}

	quiesce(): void {
		this.both('quiesce', () => this.model.quiesce(), () => this.engine.quiesce());
	}

	livePins(): number[] {
		const m = this.model.livePins();
		expect(this.engine.livePins(), 'twin livePins diverged').toEqual(m);
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
		// the spec bodies' assertions pin the model's Required outcomes.
		return m;
	}

	eventsSince(mark: number): ModelEvent[] {
		// Marks are model-stream positions; deliveryish lag means the engine
		// stream's positions no longer align 1:1. The full-stream comparison
		// in compareStreams (after EVERY op) already pins the non-delivery
		// stream exactly and bounds deliveries cumulatively, so the window
		// compare adds nothing — return the model's window (the spec bodies'
		// Required outcomes).
		return this.model.eventsSince(mark);
	}

	/** Full parity + invariants on both sides + the engine-only K0 check. */
	verify(): void {
		this.compareStreams('verify');
		expect(JSON.stringify(snapshotModel(this.engine as unknown as CosignalModel)), 'twin observable snapshots diverged')
			.toBe(JSON.stringify(snapshotModel(this.model)));
		checkInvariants(this.model);
		checkInvariants(this.engine as unknown as CosignalModel);
		// §5.2 eager-apply invariant: the kernel plane holds the newest fold.
		for (const n of this.engine.nodes.values()) {
			if (n.kind !== 'atom') continue;
			const folded = this.engine.foldAtom(n, { kind: 'newest' } as EWorld);
			const kernel = this.engine.newestValue(n);
			expect(Object.is(folded, kernel), `K0 parity: atom ${n.name} kernel ${String(kernel)} ≠ fold ${String(folded)}`).toBe(true);
		}
	}
}

/** A LOGGED-mode twin (bridge registered during setup, §3.2). */
export function logged(): TwinDriver {
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

export function dispatch(action: unknown): { kind: 'dispatch'; action: unknown } {
	return { kind: 'dispatch', action };
}
