/**
 * §17.2 — the randomized replay oracle.
 *
 * The naive model: per atom, a plain array of every write ever
 * (pos, op, payload, token, applied, retired, retiredPos) — no sweeping, no
 * coalescing, no slots, no tapes, no marks, no memos. Reads implement the
 * visibility rule (§10.2) literally: filter, replay in order, equality-fold.
 * Computeds are memo-free recursive functions re-derived from oracle atom
 * reads in the same world every time.
 *
 * Watcher decisions are derived from world values — NEVER from any walk
 * (§17.2): at each drain, for each watcher and each world the drain could
 * affect (the writing batch's writer's world for a deferred drain; every
 * live deferred writer's world PLUS W0 for an urgent drain — coordinator
 * resolutions 1/3), fully replay the watched node's value in that world and
 * compare with the last value recorded as broadcast/rendered for that world
 * (missing world → the current W0 value, resolution 7b). Nodes whose
 * dependency on the written atom exists only in a pending world fall out
 * automatically because the oracle re-derives every computed from scratch.
 *
 * Ordering uses one monotonic position counter (never reset): engine
 * semantics depend only on the ORDER of seqs/pins within an era, and
 * cross-era entries are always swept, so a monotonic mirror preserves every
 * comparison. One position per write and ONE per retirement (resolution 7a).
 */

import { createCosignalEngine, type BroadcastEvent, type CosignalEngine, type SignalHandle } from '../../src/engine';
import { createAPI, isSuspendedBox } from '../../src/api';
import { createForkDouble, type BatchScript, type ForkDouble } from '../../src/fork-double';

// ---- deterministic PRNG ---------------------------------------------------------
export function mulberry32(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ---- node universe ---------------------------------------------------------------
export type AtomSpec =
	| { kind: 'atom'; initial: number; eqMod?: number; lazy?: boolean }
	| { kind: 'reducer'; initial: number; lazy?: boolean };

export type ComputedSpec = {
	kind: 'computed';
	// 'asyncgate': pending-as-graph-state (Solid-adapted §12.3) — odd source
	// value ⇒ the node evaluates-to-pending (a never-settling fetch); even ⇒
	// the value passes through. Downstream nodes FORWARD pending.
	type: 'branch' | 'sum' | 'chain' | 'asyncgate';
	srcs: number[]; // node indexes (atoms or lower-index computeds)
	eqMod?: number;
};

/** Oracle pending values carry their SOURCE SET (mirroring the engine's
 * set-keyed joined thenables): `pending:<sorted asyncgate node indexes>`.
 * Engine SuspendedBox ⇔ oracle pending; broadcast equality keys on the set. */
export const PENDING_PREFIX = 'oracle-pending:';
export type OracleValue = number | string;
export function pendingOf(sources: Iterable<number>): string {
	return PENDING_PREFIX + [...sources].sort((a, b) => a - b).join(',');
}
export function isOraclePending(v: unknown): v is string {
	return typeof v === 'string' && v.startsWith(PENDING_PREFIX);
}

export type NodeSpec = AtomSpec | ComputedSpec;

const REDUCER = (s: number, action: number): number => ((s * 31 + action) % 1000 + 1000) % 1000;

function modEq(m: number) {
	return (x: number, y: number): boolean => ((x % m) + m) % m === ((y % m) + m) % m;
}

// The ONE evaluation body both sides share. The read fn returns numbers —
// pending deps read as `undefined` (exactly what the engine's forwarding
// substitutes), with pending-ness carried out of band on each side (the
// engine's evaluation frame; the oracle's sawPending flag).
export function evalComputedSpec(spec: ComputedSpec, read: (idx: number) => number): number {
	switch (spec.type) {
		case 'branch':
			return read(spec.srcs[0]) % 2 !== 0 ? read(spec.srcs[1]) : read(spec.srcs[2]);
		case 'sum':
			return read(spec.srcs[0]) + read(spec.srcs[1]);
		case 'chain':
			return read(spec.srcs[0]) + 1;
		case 'asyncgate':
			return read(spec.srcs[0]); // gating on oddness is applied by each side
	}
}

// Update-fn table (pure, deterministic; shared by engine and oracle).
export const UPDATE_FNS: ReadonlyArray<(x: number) => number> = [
	(x) => x + 1,
	(x) => (x * 2) % 1000,
	(x) => x, // identity — exercises equality folds and cutoffs
	(x) => x - 3,
];

// ---- schedule ops ----------------------------------------------------------------
export type WriteDesc = { batch: number; atom: number; op: 'set' | 'update' | 'dispatch'; v: number };
// batch: -1 = bare urgent (event batch); otherwise index into opened deferred batches.

export type Op =
	| { t: 'openDeferred' }
	| { t: 'openUrgent' } // an explicit urgent batch (distinct from the bare event batch)
	| { t: 'newNode'; spec: NodeSpec } // fresh nodes mid-era/mid-schedule
	| { t: 'write'; w: WriteDesc }
	| { t: 'group'; writes: WriteDesc[] } // engine batch(): grouped drain
	| { t: 'retire'; b: number; committed: boolean }
	| { t: 'closeEvent' }
	| { t: 'truncate'; b: number }
	| { t: 'watch'; n: number }
	| { t: 'refresh'; n: number } // Solid-API refresh: slots cleared + invalidate (value-neutral for never-settling fuzz fetches)
	| { t: 'unwatch'; wi: number }
	| { t: 'passStart'; include: number[] } // indexes into batches (-1 = event batch)
	| { t: 'passYield' }
	| { t: 'passResume' }
	| { t: 'passRestart' }
	| { t: 'passEnd' };

// ---- oracle model ----------------------------------------------------------------
type OWrite = {
	pos: number;
	op: 'set' | 'update' | 'dispatch';
	payload: unknown;
	token: number;
	applied: boolean;
	retired: boolean;
	retiredPos: number;
};

type OWorld =
	| { k: 'w0' }
	| { k: 'newest' }
	| { k: 'committed' }
	| { k: 'writer'; token: number }
	| { k: 'pass'; pin: number; include: ReadonlySet<number> };

export class Oracle {
	pos = 0;
	writes: OWrite[][];
	tokens = new Map<number, { deferred: boolean; retired: boolean; hasWrites: boolean }>();
	watchers = new Map<number, { node: number; lb: Map<number, unknown> }>();
	private watcherSeq = 0;

	constructor(public specs: NodeSpec[]) {
		this.writes = specs.map(() => []);
	}

	addNode(spec: NodeSpec): void {
		this.specs.push(spec);
		this.writes.push([]);
	}

	eqOf(idx: number): ((a: number, b: number) => boolean) | undefined {
		const s = this.specs[idx];
		return 'eqMod' in s && s.eqMod !== undefined ? modEq(s.eqMod) : undefined;
	}

	noteToken(token: number, deferred: boolean): void {
		if (!this.tokens.has(token)) {
			this.tokens.set(token, { deferred, retired: false, hasWrites: false });
		}
	}

	recordWrite(atom: number, op: OWrite['op'], payload: unknown, token: number, deferred: boolean): void {
		this.noteToken(token, deferred);
		this.tokens.get(token)!.hasWrites = true;
		this.writes[atom].push({
			pos: ++this.pos,
			op,
			payload,
			token,
			applied: !deferred,
			retired: false,
			retiredPos: 0,
		});
	}

	retireToken(token: number): void {
		const t = this.tokens.get(token);
		if (t === undefined || t.retired) {
			return;
		}
		t.retired = true;
		const rp = ++this.pos; // ONE retire position per retirement
		for (const list of this.writes) {
			for (const w of list) {
				if (w.token === token && !w.retired) {
					w.retired = true;
					w.retiredPos = rp;
				}
			}
		}
	}

	truncateToken(token: number): void {
		for (let i = 0; i < this.writes.length; ++i) {
			this.writes[i] = this.writes[i].filter(
				(w) => !(w.token === token && !w.retired && !w.applied),
			);
		}
	}

	liveDeferredTokens(): number[] {
		const out: number[] = [];
		for (const [tok, st] of this.tokens) {
			if (st.deferred && !st.retired && st.hasWrites) {
				out.push(tok);
			}
		}
		return out;
	}

	private visible(w: OWrite, world: OWorld): boolean {
		switch (world.k) {
			case 'newest':
				return true;
			case 'committed':
				return w.retired;
			case 'w0':
				return w.retired || w.applied;
			case 'writer':
				return w.retired || w.applied || w.token === world.token;
			case 'pass':
				if (w.retired && w.retiredPos <= world.pin) {
					return true;
				}
				return world.include.has(w.token) && w.pos <= world.pin;
		}
	}

	value(idx: number, world: OWorld): OracleValue {
		const spec = this.specs[idx];
		if (spec.kind === 'computed') {
			// Pending propagation derived from world values (§17.2 extended):
			// evaluate with pending deps substituted by undefined (mirroring
			// the engine's forwarding) and carry pending-ness out of band.
			const sources = new Set<number>();
			const read = (s: number): number => {
				const v = this.value(s, world);
				if (isOraclePending(v)) {
					for (const part of v.slice(PENDING_PREFIX.length).split(',')) {
						sources.add(Number(part));
					}
					return undefined as unknown as number;
				}
				return v as number;
			};
			if (spec.type === 'asyncgate') {
				const src = read(spec.srcs[0]);
				if (sources.size !== 0) {
					return pendingOf(sources);
				}
				return src % 2 !== 0 ? pendingOf([idx]) : src;
			}
			const out = evalComputedSpec(spec, read);
			return sources.size !== 0 ? pendingOf(sources) : out;
		}
		let acc = spec.initial as number;
		const eq = this.eqOf(idx);
		for (const w of this.writes[idx]) {
			if (!this.visible(w, world)) {
				continue;
			}
			const next =
				w.op === 'set'
					? (w.payload as number)
					: w.op === 'update'
						? (w.payload as (x: number) => number)(acc)
						: REDUCER(acc, w.payload as number);
			acc = eq !== undefined && eq(acc, next) ? acc : Object.is(acc, next) ? acc : next;
		}
		return acc;
	}

	addWatcher(node: number): number {
		const id = ++this.watcherSeq;
		const lb = new Map<number, unknown>();
		// Rendered baseline + subscription-time seeding of live deferred
		// worlds (resolution 7b).
		lb.set(0, this.value(node, { k: 'w0' }));
		for (const t of this.liveDeferredTokens()) {
			lb.set(t, this.value(node, { k: 'writer', token: t }));
		}
		this.watchers.set(id, { node, lb });
		return id;
	}

	removeWatcher(id: number): void {
		this.watchers.delete(id);
	}

	/** Derive the expected (watcher, token, value) broadcast set for a drain
	 * whose relevant worlds are `relevantTokens` (0 = W0). Purely value-based. */
	expectedBroadcasts(relevantTokens: number[]): Array<{ watcher: number; token: number; value: unknown }> {
		const out: Array<{ watcher: number; token: number; value: unknown }> = [];
		for (const [id, w] of this.watchers) {
			for (const tok of relevantTokens) {
				const world: OWorld = tok === 0 ? { k: 'w0' } : { k: 'writer', token: tok };
				const v = this.value(w.node, world);
				const baseline = w.lb.has(tok) ? w.lb.get(tok) : this.value(w.node, { k: 'w0' });
				const eq = this.eqOf(w.node);
				// Pending status compares as status (the engine's box equality:
				// same store-held thenable per node×world ⇒ equal).
				const same = isOraclePending(v) || isOraclePending(baseline)
					? v === baseline
					: eq !== undefined
						? eq(baseline as number, v as number)
						: Object.is(baseline, v);
				if (!same) {
					w.lb.set(tok, v);
					out.push({ watcher: id, token: tok, value: v });
				}
			}
		}
		return out;
	}
}

// ---- the runner: engine + oracle in lockstep ---------------------------------------
export type RunResult = { failure?: string };

export function runSchedule(specs: NodeSpec[], ops: Op[], label: string): RunResult {
	const engine = createCosignalEngine({ initialRecords: 16, initialLogRecords: 2, initialMemoRecords: 2 });
	const api = createAPI(engine);
	const fork = createForkDouble();
	engine.attachFork(fork);
	fork.registerRoot('root');
	specs = specs.slice(); // the runner may append mid-schedule nodes
	const oracle = new Oracle(specs);

	// Build the node universe in the engine. Computeds build through the API
	// classes so pending FORWARDS through class `.state` reads inside
	// evaluations (the graph-status model); raw engine handles would hand
	// §11.3 boxes straight into arithmetic.
	const handles: SignalHandle[] = [];
	const classReaders: Array<() => number> = [];
	const reducerHandles = new Map<number, { dispatch(a: number): void }>();
	const atomHandles = new Map<number, { set(v: number): void; update(f: (x: number) => number): void }>();
	// LAZY-INIT atoms (owner feature): built through the API classes with a
	// pure `() => initial` initializer; the MODEL needs no laziness concept
	// (values agree by purity) — the fuzz value is materialization timing:
	// first touch lands at a random op under whatever batches/passes are
	// live. Compares SKIP still-unmaterialized nodes (reading would
	// materialize instantly and erase the timing diversity).
	const lazyInstances = new Map<number, { materialized: boolean }>();
	function isMaterialized(i: number): boolean {
		const inst = lazyInstances.get(i);
		return inst === undefined || inst.materialized;
	}
	function buildNode(i: number): void {
		const s = specs[i];
		if (s.kind === 'atom') {
			if (s.lazy === true) {
				const inst = new api.Atom<number>({
					state: () => s.initial,
					isEqual: s.eqMod !== undefined ? modEq(s.eqMod) : undefined,
				});
				lazyInstances.set(i, inst as unknown as { materialized: boolean });
				// Handle delegate: materializes on first id/state access.
				handles.push({
					get id(): number {
						return inst.handle.id;
					},
					get state(): number {
						return inst.state as number;
					},
				} as unknown as SignalHandle);
				classReaders[handles.length - 1] = () => inst.state as number;
				atomHandles.set(i, {
					set: (v: number) => inst.set(v),
					update: (f: (x: number) => number) => inst.update(f),
				});
			} else {
				const h = engine.atom<number>(s.initial, s.eqMod !== undefined ? { isEqual: modEq(s.eqMod) } : undefined);
				handles.push(h);
				classReaders[handles.length - 1] = () => h.state as number;
				atomHandles.set(i, h);
			}
		} else if (s.kind === 'reducer') {
			if (s.lazy === true) {
				const inst = new api.ReducerAtom<number, number>({
					state: () => s.initial,
					reducer: REDUCER,
				});
				lazyInstances.set(i, inst as unknown as { materialized: boolean });
				handles.push({
					get id(): number {
						return inst.handle.id;
					},
					get state(): number {
						return inst.state as number;
					},
				} as unknown as SignalHandle);
				classReaders[handles.length - 1] = () => inst.state as number;
				reducerHandles.set(i, { dispatch: (a: number) => inst.dispatch(a) });
			} else {
				const h = engine.reducerAtom<number, number>(s.initial, REDUCER);
				handles.push(h);
				classReaders[handles.length - 1] = () => h.state as number;
				reducerHandles.set(i, h);
			}
		} else {
			const spec = s;
			const readIdx = (idx: number): number => classReaders[idx]();
			const never = new Promise<number>(() => undefined); // per-node fetch; never settles
			const c = spec.type === 'asyncgate'
				? new api.Computed<number>({
					fn: (ctx) => {
						const v = readIdx(spec.srcs[0]);
						return v % 2 !== 0 ? ctx.use(never) : v;
					},
					isEqual: spec.eqMod !== undefined ? modEq(spec.eqMod) : undefined,
				})
				: new api.Computed<number>({
					fn: () => evalComputedSpec(spec, readIdx),
					isEqual: spec.eqMod !== undefined ? modEq(spec.eqMod) : undefined,
				});
			handles.push(c.handle as unknown as SignalHandle);
			classReaders[handles.length - 1] = () => c.state;
		}
	}
	for (let i = 0; i < specs.length; ++i) {
		buildNode(i);
	}

	// Harness state.
	const batches: BatchScript[] = [];
	const engineWatchers = new Map<number, { handle: { dispose(): void }; engineId: number }>();
	const engineIdToOracle = new Map<number, number>();
	let pass: ReturnType<ForkDouble['startPass']> | undefined;
	let passPin = 0;
	let passInclude = new Set<number>();

	function fail(step: number, op: Op, msg: string): RunResult {
		return {
			failure: `${label} step ${step} ${JSON.stringify(op)}: ${msg}`,
		};
	}

	function passExecuting(): boolean {
		return fork.getRenderContext() !== undefined;
	}

	function apiRefresh(idx: number): void {
		const spec = specs[idx];
		if (spec === undefined || spec.kind !== 'computed') {
			return;
		}
		api.refresh(handles[idx] as { id: number } as never);
	}

	// latest() invariant under fuzz: when a node's NEWEST value is NOT
	// pending, latest(x) must equal it; when pending, latest is the stale
	// committed value or undefined — checked as "never a box, never throws".
	function checkLatest(step: number, op: Op): RunResult {
		for (let i = 0; i < specs.length; ++i) {
			if (specs[i].kind !== 'computed') {
				continue;
			}
			if (!isMaterialized(i)) {
				continue;
			}
			let l: unknown;
			try {
				l = api.latest(handles[i] as { id: number } as never);
			} catch (err) {
				return fail(step, op, `latest(${i}) threw: ${String(err)}`);
			}
			// Per-context table: inside a pass latest() samples the PASS world
			// (never ahead of the pin); otherwise Wn.
			const newest = passExecuting()
				? oracle.value(i, { k: 'pass', pin: passPin, include: passInclude })
				: oracle.value(i, { k: 'newest' });
			if (!isOraclePending(newest)) {
				if (!Object.is(l, newest)) {
					return fail(step, op, `latest(${i}) = ${String(l)}, newest = ${String(newest)}`);
				}
			} else if (isSuspendedBox(l)) {
				return fail(step, op, `latest(${i}) returned a box`);
			}
		}
		return {};
	}

	function eqCompare(_idx: number, engineV: unknown, oracleV: unknown): boolean {
		if (isOraclePending(oracleV)) {
			return isSuspendedBox(engineV); // status ⇔ status (sets checked via broadcasts)
		}
		return Object.is(engineV, oracleV);
	}

	function compareValues(step: number, op: Op): RunResult {
		// W0 + writer worlds + committed always; newest/pass per context.
		for (let i = 0; i < specs.length; ++i) {
			if (!isMaterialized(i)) {
				continue; // unmaterialized lazy node: reading would materialize
			}
			const h = handles[i];
			const w0e = engine.debug.readWorld(h, { kind: 'w0' });
			const w0o = oracle.value(i, { k: 'w0' });
			if (!eqCompare(i, w0e, w0o)) {
				return fail(step, op, `node ${i} W0: engine=${String(w0e)} oracle=${String(w0o)}`);
			}
			for (const tok of oracle.liveDeferredTokens()) {
				const we = engine.debug.readWorld(h, { kind: 'writer', token: tok });
				const wo = oracle.value(i, { k: 'writer', token: tok });
				if (!eqCompare(i, we, wo)) {
					return fail(step, op, `node ${i} writer(${tok}): engine=${String(we)} oracle=${String(wo)}`);
				}
			}
			if (passExecuting()) {
				const pe = (h as { state?: unknown }).state;
				const po = oracle.value(i, { k: 'pass', pin: passPin, include: passInclude });
				if (!eqCompare(i, pe, po)) {
					return fail(step, op, `node ${i} pass: engine=${String(pe)} oracle=${String(po)}`);
				}
			} else {
				// ALT-FAMILY AMBIENT RULE: outside a pass and outside any
				// deferred scope, `.state` reads W0 — pending deferred batches
				// are invisible (drafts-hidden). Mainline cosignal asserts
				// NEWEST-ambient here; never port that expectation into this
				// suite (SPEC-RESOLUTIONS divergence note).
				const ne = (h as { state?: unknown }).state;
				const no = oracle.value(i, { k: 'w0' });
				if (!eqCompare(i, ne, no)) {
					return fail(step, op, `node ${i} ambient(W0): engine=${String(ne)} oracle=${String(no)}`);
				}
				// Wn fold correctness stays covered via the EXPLICIT selector
				// (the spec'd surface for "intent including drafts").
				const we = engine.debug.readWorld(h, { kind: 'newest' });
				const wo = oracle.value(i, { k: 'newest' });
				if (!eqCompare(i, we, wo)) {
					return fail(step, op, `node ${i} newest: engine=${String(we)} oracle=${String(wo)}`);
				}
				const ce = engine.readCommitted(h);
				const co = oracle.value(i, { k: 'committed' });
				if (!eqCompare(i, ce, co)) {
					return fail(step, op, `node ${i} committed: engine=${String(ce)} oracle=${String(co)}`);
				}
				// Read-your-own-draft: inside each live deferred batch's scope,
				// ambient `.state` sees that batch's writer world.
				for (const b of batches) {
					if (!b.deferred || b.retired || !oracle.liveDeferredTokens().includes(b.token)) {
						continue;
					}
					let se: unknown;
					b.run(() => {
						se = (h as { state?: unknown }).state;
					});
					const so = oracle.value(i, { k: 'writer', token: b.token });
					if (!eqCompare(i, se, so)) {
						return fail(step, op, `node ${i} in-scope(${b.token}): engine=${String(se)} oracle=${String(so)}`);
					}
				}
			}
		}
		return {};
	}

	function compareBroadcasts(step: number, op: Op, relevantTokens: number[]): RunResult {
		const actual = engine.debug.takeBroadcasts().map((ev: BroadcastEvent) => ({
			watcher: engineIdToOracle.get(ev.watcherId) ?? -1,
			token: ev.token,
			value: ev.value,
		}));
		const expected = oracle.expectedBroadcasts(relevantTokens);
		const key = (x: { watcher: number; token: number; value: unknown }): string =>
			`${x.watcher}|${x.token}|${isSuspendedBox(x.value) || isOraclePending(x.value) ? '<pending>' : String(x.value)}`;
		const as = actual.map(key).sort();
		const es = expected.map(key).sort();
		if (as.join(';') !== es.join(';')) {
			return fail(
				step,
				op,
				`broadcast mismatch: engine=[${as.join(' ')}] oracle=[${es.join(' ')}]`,
			);
		}
		return {};
	}

	function resolveWriteToken(w: WriteDesc): { token: number; deferred: boolean; script?: BatchScript } | undefined {
		if (w.batch === -1) {
			const token = fork.getCurrentWriteBatch(); // mints the event batch
			return { token, deferred: false };
		}
		const b = batches[w.batch];
		if (b === undefined || b.retired) {
			return undefined;
		}
		return { token: b.token, deferred: b.deferred, script: b };
	}

	function performEngineWrite(w: WriteDesc, script: BatchScript | undefined): void {
		const doWrite = (): void => {
			if (w.op === 'set') {
				atomHandles.get(w.atom)?.set(w.v);
			} else if (w.op === 'update') {
				atomHandles.get(w.atom)?.update(UPDATE_FNS[w.v % UPDATE_FNS.length]);
			} else {
				reducerHandles.get(w.atom)?.dispatch(w.v);
			}
		};
		if (script !== undefined) {
			script.run(doWrite);
		} else {
			doWrite();
		}
	}

	function recordOracleWrite(w: WriteDesc, token: number, deferred: boolean): void {
		const spec = specs[w.atom];
		if (spec.kind === 'computed') {
			return;
		}
		if (w.op === 'dispatch' && spec.kind !== 'reducer') {
			return;
		}
		if (w.op !== 'dispatch' && spec.kind !== 'atom') {
			return;
		}
		const payload = w.op === 'update' ? UPDATE_FNS[w.v % UPDATE_FNS.length] : w.v;
		oracle.recordWrite(w.atom, w.op, payload, token, deferred);
	}

	function writeIsValid(w: WriteDesc): boolean {
		const spec = specs[w.atom];
		if (spec === undefined || spec.kind === 'computed') {
			return false;
		}
		if (w.op === 'dispatch') {
			return spec.kind === 'reducer';
		}
		return spec.kind === 'atom';
	}

	// Mirror the §9.3 equality drop: sound only on tapeless atoms, and the
	// engine drops the write entirely (no log entry, no slot interning). The
	// drop is value-neutral, but the ORACLE's world/lane bookkeeping must not
	// count a dropped write as batch activity. Tape existence is an engine
	// observable (debug.isLogged); the equality check runs on oracle values.
	function wouldDrop(w: WriteDesc): boolean {
		if (engine.debug.isLogged(handles[w.atom])) {
			return false;
		}
		const cur = oracle.value(w.atom, { k: 'w0' }) as number; // atoms are never PENDING
		const next =
			w.op === 'set'
				? w.v
				: w.op === 'update'
					? UPDATE_FNS[w.v % UPDATE_FNS.length](cur)
					: ((cur * 31 + w.v) % 1000 + 1000) % 1000;
		return Object.is(cur, next);
	}

	// ---- interpret ops (runtime guards make every subsequence legal) --------------
	for (let step = 0; step < ops.length; ++step) {
		const op = ops[step];
		let r: RunResult = {};
		try {
			switch (op.t) {
				case 'openDeferred': {
					const b = fork.openBatch('deferred');
					b.token; // mint eagerly so the harness knows the token
					batches.push(b);
					oracle.noteToken(b.token, true);
					break;
				}
				case 'openUrgent': {
					const b = fork.openBatch('urgent');
					b.token;
					batches.push(b);
					oracle.noteToken(b.token, false);
					break;
				}
				case 'newNode': {
					if (passExecuting()) {
						break; // node creation is not a render-phase act here
					}
					const spec = op.spec;
					if (spec.kind === 'computed' && spec.srcs.some((x) => x >= specs.length || x < 0)) {
						break; // guard: shrinking may have removed a source
					}
					// `specs` IS oracle.specs (shared array): one push only.
					oracle.addNode(spec);
					buildNode(specs.length - 1);
					break;
				}
				case 'write': {
					if (passExecuting() || !writeIsValid(op.w)) {
						break;
					}
					const t = resolveWriteToken(op.w);
					if (t === undefined) {
						break;
					}
					const dropped = wouldDrop(op.w);
					if (!dropped) {
						recordOracleWrite(op.w, t.token, t.deferred);
					}
					performEngineWrite(op.w, t.script);
					if (dropped) {
						break; // no drain happened; the stray check below suffices
					}
					const relevant = t.deferred
						? [t.token]
						: [0, ...oracle.liveDeferredTokens()];
					r = compareBroadcasts(step, op, relevant);
					break;
				}
				case 'group': {
					if (passExecuting()) {
						break;
					}
					const resolved: Array<{ w: WriteDesc; token: number; deferred: boolean; script?: BatchScript }> = [];
					for (const w of op.writes) {
						if (!writeIsValid(w)) {
							continue;
						}
						const t = resolveWriteToken(w);
						if (t !== undefined) {
							resolved.push({ w, ...t });
						}
					}
					if (resolved.length === 0) {
						break;
					}
					// Interleave drop checks with engine writes: an earlier write
					// in the group can create the tape that stops a later equal
					// write from being dropped.
					const kept: typeof resolved = [];
					engine.batch(() => {
						for (const x of resolved) {
							if (!wouldDrop(x.w)) {
								recordOracleWrite(x.w, x.token, x.deferred);
								kept.push(x);
							}
							performEngineWrite(x.w, x.script);
						}
					});
					if (kept.length === 0) {
						break;
					}
					const relevant: number[] = [];
					if (kept.some((x) => !x.deferred)) {
						relevant.push(0, ...oracle.liveDeferredTokens());
					}
					for (const x of kept) {
						if (x.deferred && !relevant.includes(x.token)) {
							relevant.push(x.token);
						}
					}
					r = compareBroadcasts(step, op, relevant);
					break;
				}
				case 'retire': {
					const b = batches[op.b];
					if (b === undefined || b.retired) {
						break;
					}
					if (pass?.open && pass.includedBatches.includes(b.token)) {
						break;
					}
					oracle.retireToken(b.token);
					b.retire(op.committed);
					r = compareBroadcasts(step, op, [0, ...oracle.liveDeferredTokens()]);
					break;
				}
				case 'closeEvent': {
					const eb = fork.currentEventBatch();
					if (eb === undefined || eb.retired) {
						break;
					}
					if (pass?.open && pass.includedBatches.includes(eb.token)) {
						break;
					}
					oracle.retireToken(eb.token);
					fork.closeEvent();
					r = compareBroadcasts(step, op, [0, ...oracle.liveDeferredTokens()]);
					break;
				}
				case 'truncate': {
					const b = batches[op.b];
					if (b === undefined || b.retired) {
						break;
					}
					oracle.truncateToken(b.token);
					engine.truncateBatch(b.token);
					r = compareBroadcasts(step, op, [b.token]);
					break;
				}
				case 'refresh': {
					if (passExecuting() || op.n >= specs.length) {
						break;
					}
					// Value-neutral under fuzz (never-settling per-node fetches
					// re-register identically → same pending source set), but it
					// exercises invalidate/recompute/slot paths under the oracle's
					// full compare + verify.
					apiRefresh(op.n);
					break;
				}
				case 'watch': {
					if (passExecuting() || op.n >= specs.length) {
						break;
					}
					const oid = oracle.addWatcher(op.n);
					const wh = engine.watch(handles[op.n]);
					engineWatchers.set(oid, { handle: wh, engineId: wh.id });
					engineIdToOracle.set(wh.id, oid);
					r = compareBroadcasts(step, op, []); // subscription is silent
					break;
				}
				case 'unwatch': {
					const ids = [...engineWatchers.keys()];
					const oid = ids[op.wi % Math.max(1, ids.length)];
					if (oid === undefined) {
						break;
					}
					engineWatchers.get(oid)!.handle.dispose();
					engineIdToOracle.delete(engineWatchers.get(oid)!.engineId);
					engineWatchers.delete(oid);
					oracle.removeWatcher(oid);
					break;
				}
				case 'passStart': {
					if (pass?.open) {
						break;
					}
					const include: BatchScript[] = [];
					for (const bi of op.include) {
						if (bi === -1) {
							const eb = fork.currentEventBatch();
							if (eb !== undefined && !eb.retired) {
								include.push(eb);
							}
							continue;
						}
						const b = batches[bi];
						if (b !== undefined && !b.retired) {
							include.push(b);
						}
					}
					passPin = oracle.pos;
					passInclude = new Set(include.map((b) => b.token));
					pass = fork.startPass('root', { include });
					break;
				}
				case 'passYield': {
					if (pass?.open && pass.executing) {
						pass.yield();
					}
					break;
				}
				case 'passResume': {
					if (pass?.open && !pass.executing) {
						pass.resume();
					}
					break;
				}
				case 'passRestart': {
					if (pass?.open) {
						if (!pass.executing) {
							pass.resume();
						}
						pass = pass.restart();
						passPin = oracle.pos; // a restarted pass may see newer state
						passInclude = new Set(pass.includedBatches);
					}
					break;
				}
				case 'passEnd': {
					if (pass?.open) {
						pass.end();
						pass = undefined;
					}
					break;
				}
			}
			if (r.failure !== undefined) {
				return r;
			}
			// Residual broadcast check: nothing should fire outside drains.
			const stray = engine.debug.takeBroadcasts();
			if (stray.length > 0) {
				return fail(step, op, `stray broadcasts: ${stray.map((x) => `${x.watcherId}:${x.token}`).join(',')}`);
			}
			const cmp = compareValues(step, op);
			if (cmp.failure !== undefined) {
				return cmp;
			}
			const lat = checkLatest(step, op);
			if (lat.failure !== undefined) {
				return lat;
			}
			engine.debug.verify();
		} catch (err) {
			return fail(step, op, `threw: ${String(err)}`);
		}
	}
	return {};
}

// ---- schedule generator ------------------------------------------------------------
export function generateUniverse(rng: () => number): NodeSpec[] {
	const specs: NodeSpec[] = [];
	// Identity equality only in the fuzz universe: custom equivalence classes
	// make raw values representative-dependent (the engine may legally serve
	// any member of the class — e.g. coalescing changes which fold
	// representative survives — and branch computeds are not congruent under
	// mod-N), so a naive value-comparison oracle cannot adjudicate them.
	// Custom equality is covered by the deterministic unit suites instead.
	const nAtoms = 3 + Math.floor(rng() * 3); // 3–5
	for (let i = 0; i < nAtoms; ++i) {
		const roll = rng();
		if (roll < 0.25) {
			specs.push({ kind: 'reducer', initial: Math.floor(rng() * 10), lazy: rng() < 0.3 ? true : undefined });
		} else {
			specs.push({ kind: 'atom', initial: Math.floor(rng() * 10), lazy: rng() < 0.3 ? true : undefined });
		}
	}
	const nComputeds = 2 + Math.floor(rng() * 3); // 2–4
	for (let i = 0; i < nComputeds; ++i) {
		const idx = specs.length;
		const pick = (): number => Math.floor(rng() * idx);
		const roll = rng();
		if (roll < 0.4) {
			specs.push({ kind: 'computed', type: 'branch', srcs: [pick(), pick(), pick()] });
		} else if (roll < 0.7) {
			specs.push({ kind: 'computed', type: 'sum', srcs: [pick(), pick()] });
		} else if (roll < 0.85) {
			specs.push({ kind: 'computed', type: 'chain', srcs: [pick()] });
		} else {
			specs.push({ kind: 'computed', type: 'asyncgate', srcs: [pick()] });
		}
	}
	return specs;
}

export function generateSchedule(rng: () => number, specs: NodeSpec[], length: number): Op[] {
	const ops: Op[] = [];
	const nNodes = specs.length;
	const atomIdxs = specs.map((s, i) => (s.kind !== 'computed' ? i : -1)).filter((x) => x >= 0);
	let openBatches = 0;
	let passOpen = false;
	let passExecuting = false;
	let watchers = 0;

	const randWrite = (): WriteDesc => {
		const atom = atomIdxs[Math.floor(rng() * atomIdxs.length)];
		const spec = specs[atom];
		const op: WriteDesc['op'] =
			spec.kind === 'reducer' ? 'dispatch' : rng() < 0.6 ? 'set' : 'update';
		const batch = openBatches > 0 && rng() < 0.65 ? Math.floor(rng() * openBatches) : -1;
		// Small value range makes equal-value writes common (equality paths).
		return { batch, atom, op, v: Math.floor(rng() * 6) };
	};

	for (let i = 0; i < length; ++i) {
		const roll = rng();
		if (passOpen && passExecuting && roll < 0.45) {
			// While render executes: yield, restart, or end.
			const r2 = rng();
			if (r2 < 0.5) {
				ops.push({ t: 'passYield' });
				passExecuting = false;
			} else if (r2 < 0.65) {
				ops.push({ t: 'passRestart' });
			} else {
				ops.push({ t: 'passEnd' });
				passOpen = false;
			}
			continue;
		}
		if (passOpen && !passExecuting && roll < 0.3) {
			const r2 = rng();
			if (r2 < 0.6) {
				ops.push({ t: 'passResume' });
				passExecuting = true;
			} else {
				ops.push({ t: 'passEnd' });
				passOpen = false;
			}
			continue;
		}
		if (roll < 0.32) {
			if (!passOpen || !passExecuting) {
				ops.push({ t: 'write', w: randWrite() });
			}
		} else if (roll < 0.42) {
			if (!passOpen || !passExecuting) {
				const n = 2 + Math.floor(rng() * 3);
				ops.push({ t: 'group', writes: Array.from({ length: n }, randWrite) });
			}
		} else if (roll < 0.48) {
			if (openBatches < 6) {
				ops.push({ t: 'openDeferred' });
				++openBatches;
			}
		} else if (roll < 0.5) {
			if (openBatches < 6 && rng() < 0.5) {
				ops.push({ t: 'openUrgent' });
				++openBatches;
			} else {
				const idx = nNodes; // approximate; runner guards src ranges
				const pick = (): number => Math.floor(rng() * (idx + ops.filter((o) => o.t === 'newNode').length));
				ops.push({
					t: 'newNode',
					spec: rng() < 0.6
						? { kind: 'computed', type: 'branch', srcs: [pick(), pick(), pick()] }
						: rng() < 0.5
							? { kind: 'computed', type: 'sum', srcs: [pick(), pick()] }
							: { kind: 'atom', initial: Math.floor(rng() * 10), lazy: rng() < 0.3 ? true : undefined },
				});
			}
		} else if (roll < 0.62) {
			if (openBatches > 0) {
				ops.push({ t: 'retire', b: Math.floor(rng() * openBatches), committed: rng() < 0.7 });
			}
		} else if (roll < 0.67) {
			ops.push({ t: 'closeEvent' });
		} else if (roll < 0.7) {
			if (openBatches > 0) {
				ops.push({ t: 'truncate', b: Math.floor(rng() * openBatches) });
			}
		} else if (roll < 0.72) {
			ops.push({ t: 'refresh', n: Math.floor(rng() * (nNodes + 4)) });
		} else if (roll < 0.8) {
			if (watchers < 4 && (!passOpen || !passExecuting)) {
				ops.push({ t: 'watch', n: Math.floor(rng() * nNodes) });
				++watchers;
			} else if (watchers > 0) {
				ops.push({ t: 'unwatch', wi: Math.floor(rng() * 4) });
				--watchers;
			}
		} else if (roll < 0.93) {
			if (!passOpen) {
				const include: number[] = [];
				for (let b = 0; b < openBatches; ++b) {
					if (rng() < 0.4) {
						include.push(b);
					}
				}
				if (rng() < 0.25) {
					include.push(-1); // the urgent event batch
				}
				ops.push({ t: 'passStart', include });
				passOpen = true;
				passExecuting = true;
			} else {
				ops.push({ t: 'passEnd' });
				passOpen = false;
			}
		} else {
			ops.push({ t: 'closeEvent' });
		}
	}
	ops.push({ t: 'passEnd' });
	return ops;
}

// ---- shrinking (greedy delta debugging over ops; guards keep subsets legal) -------
export function shrink(specs: NodeSpec[], ops: Op[], label: string): Op[] {
	let current = ops.slice();
	let improved = true;
	const fails = (candidate: Op[]): boolean =>
		runSchedule(specs, candidate, label).failure !== undefined;
	while (improved) {
		improved = false;
		// chunk removal, halving sizes
		for (let chunk = Math.max(1, current.length >> 1); chunk >= 1; chunk >>= 1) {
			for (let start = 0; start + chunk <= current.length; ++start) {
				const candidate = current.slice(0, start).concat(current.slice(start + chunk));
				if (candidate.length < current.length && fails(candidate)) {
					current = candidate;
					improved = true;
					break;
				}
			}
			if (improved) {
				break;
			}
		}
	}
	return current;
}
