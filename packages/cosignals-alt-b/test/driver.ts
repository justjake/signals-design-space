// Shared fuzz driver for the §17.2 oracle: op vocabulary, executor,
// schedule generator, and shrinker. Imported by oracle.test.ts and usable
// for replaying exact shrunk scripts while debugging.
import {
	Atom,
	Computed,
	ForkDouble,
	ReducerAtom,
	__debug,
	__resetEngineForTests,
	attachFork,
	batch,
	createWatcher,
} from '../src/index';
import { Oracle, UPDATE_FNS } from './oracle';
import type { NodeDef } from './oracle';

// ---- op vocabulary (concrete, replayable, shrinkable) --------------------------

export type WriteSpec = {
	batch: number;
	node: number;
	op: 'set' | 'update' | 'dispatch';
	v: number;
	/** indexed pure update fn (UPDATE_FNS) instead of (+v) */
	uf?: number;
};

export type Op =
	| { t: 'atom'; v: number }
	| { t: 'reducer'; v: number }
	| { t: 'sum'; deps: number[] }
	| { t: 'branch'; cond: number; ifTrue: number; ifFalse: number }
	| { t: 'chain'; dep: number }
	| { t: 'watcher'; node: number }
	| { t: 'open'; deferred: boolean }
	| { t: 'write'; w: WriteSpec } // w.batch === -1 → DIRECT (quiescent only)
	| { t: 'urgentWrite'; w: Omit<WriteSpec, 'batch'> } // ambient urgent event batch
	| { t: 'closeEvent' } // retire the ambient urgent batch (§6.2 close edge)
	| { t: 'group'; writes: WriteSpec[] }
	| { t: 'retire'; batch: number; committed: boolean }
	| { t: 'truncate'; batch: number }
	| { t: 'startPass'; batches: number[] }
	| { t: 'yield' }
	| { t: 'resume' }
	| { t: 'endPass' }
	| { t: 'read'; node: number; ctx: 'newest' | 'committed' | 'render' | 'writer'; batch?: number }
	| { t: 'sweep' };

// ---- deterministic PRNG ----------------------------------------------------------

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ---- script executor ---------------------------------------------------------------

type Handle = Atom<number> | ReducerAtom<number, number> | Computed<number>;

type RunState = {
	fork: ForkDouble;
	oracle: Oracle;
	handles: Handle[];
	defs: NodeDef[];
	batches: Array<{ token: number; deferred: boolean; retired: boolean }>;
	/** index into batches of the ambient urgent event batch; -1 = none live */
	ambient: number;
	pass: { yielded: boolean; pin: number; tokens: number[] } | undefined;
	engineNotifs: Array<[number, number]>;
	watcherCount: number;
};

function isAtomNode(def: NodeDef): boolean {
	return def.type === 'atom' || def.type === 'reducer';
}

function liveDeferredTokens(s: RunState): number[] {
	return s.batches.filter((b) => !b.retired && b.deferred).map((b) => b.token);
}

function passExecuting(s: RunState): boolean {
	return s.pass !== undefined && !s.pass.yielded;
}

function sortPairs(pairs: Array<[number, number]>): string {
	return pairs
		.map(([a, b]) => `${a}:${b}`)
		.sort()
		.join(',');
}

function nodeValue(s: RunState, node: number): number {
	return (s.handles[node] as { state: number }).state;
}

/** Execute one op against engine + oracle. Returns false if preconditions
 * fail (op skipped — keeps shrinking simple). Throws on divergence. */
function applyOp(s: RunState, op: Op): boolean {
	const o = s.oracle;
	switch (op.t) {
		case 'atom': {
			s.defs.push({ type: 'atom', initial: op.v });
			o.addNode({ type: 'atom', initial: op.v });
			s.handles.push(new Atom({ state: op.v }));
			return true;
		}
		case 'reducer': {
			s.defs.push({ type: 'reducer', initial: op.v });
			o.addNode({ type: 'reducer', initial: op.v });
			s.handles.push(
				new ReducerAtom<number, number>({ state: op.v, reducer: (st, a) => st + a }),
			);
			return true;
		}
		case 'sum': {
			if (op.deps.some((d) => d >= s.handles.length)) {
				return false;
			}
			const deps = op.deps;
			s.defs.push({ type: 'sum', deps });
			o.addNode({ type: 'sum', deps });
			const handles = s.handles;
			s.handles.push(
				new Computed<number>({
					fn: () => {
						let total = 0;
						for (const d of deps) {
							total += (handles[d] as { state: number }).state;
						}
						return total;
					},
				}),
			);
			return true;
		}
		case 'branch': {
			if (
				op.cond >= s.handles.length
				|| op.ifTrue >= s.handles.length
				|| op.ifFalse >= s.handles.length
			) {
				return false;
			}
			const { cond, ifTrue, ifFalse } = op;
			s.defs.push({ type: 'branch', cond, ifTrue, ifFalse });
			o.addNode({ type: 'branch', cond, ifTrue, ifFalse });
			const handles = s.handles;
			s.handles.push(
				new Computed<number>({
					fn: () =>
						(handles[cond] as { state: number }).state % 2 === 1
							? (handles[ifTrue] as { state: number }).state
							: (handles[ifFalse] as { state: number }).state,
				}),
			);
			return true;
		}
		case 'chain': {
			if (op.dep >= s.handles.length) {
				return false;
			}
			const dep = op.dep;
			s.defs.push({ type: 'chain', dep });
			o.addNode({ type: 'chain', dep });
			const handles = s.handles;
			s.handles.push(
				new Computed<number>({
					fn: () => (handles[dep] as { state: number }).state + 1,
				}),
			);
			return true;
		}
		case 'urgentWrite': {
			if (
				passExecuting(s)
				|| op.w.node >= s.handles.length
				|| !isAtomNode(s.defs[op.w.node])
				|| !opMatchesNode(s.defs[op.w.node], op.w.op)
			) {
				return false;
			}
			if (s.ambient === -1 || s.batches[s.ambient].retired) {
				const token = s.fork.openBatch(false);
				s.batches.push({ token, deferred: false, retired: false });
				s.ambient = s.batches.length - 1;
			}
			const w: WriteSpec = { ...op.w, batch: s.ambient };
			engineWrite(s, w);
			o.loggedWrite(w.node, w.op, w.v, s.batches[w.batch].token, w.uf);
			checkBroadcasts(s, affectedFor(s, [w]));
			return true;
		}
		case 'closeEvent': {
			if (s.ambient === -1 || s.batches[s.ambient].retired) {
				return false;
			}
			const bi = s.ambient;
			s.ambient = -1;
			return applyOp(s, { t: 'retire', batch: bi, committed: false });
		}
		case 'watcher': {
			if (op.node >= s.handles.length || passExecuting(s)) {
				return false;
			}
			const wi = s.watcherCount++;
			o.addWatcher(op.node, liveDeferredTokens(s));
			createWatcher(s.handles[op.node], (token) => {
				s.engineNotifs.push([wi, token]);
			});
			return true;
		}
		case 'open': {
			if (s.batches.filter((b) => !b.retired).length >= 12) {
				return false;
			}
			const token = s.fork.openBatch(op.deferred);
			s.batches.push({ token, deferred: op.deferred, retired: false });
			return true;
		}
		case 'write':
			return applyWrites(s, [op.w]);
		case 'group': {
			const valid = op.writes.filter(
				(w) =>
					w.batch >= 0
					&& w.batch < s.batches.length
					&& !s.batches[w.batch].retired
					&& w.node < s.handles.length
					&& isAtomNode(s.defs[w.node])
					&& opMatchesNode(s.defs[w.node], w.op),
			);
			if (valid.length === 0 || passExecuting(s)) {
				return false;
			}
			batch(() => {
				for (const w of valid) {
					engineWrite(s, w);
				}
			});
			for (const w of valid) {
				o.loggedWrite(w.node, w.op, w.v, s.batches[w.batch].token, w.uf);
			}
			checkBroadcasts(s, affectedFor(s, valid));
			return true;
		}
		case 'retire': {
			if (op.batch >= s.batches.length || s.batches[op.batch].retired) {
				return false;
			}
			const b = s.batches[op.batch];
			b.retired = true;
			s.fork.retireBatch(b.token, op.committed);
			o.retire(b.token);
			checkBroadcasts(s, [0, ...liveDeferredTokens(s)]);
			// §17.2: at every retirement, the absorbed kernel value equals the
			// oracle's fold.
			for (let i = 0; i < s.defs.length; ++i) {
				if (isAtomNode(s.defs[i])) {
					const kernel = __debug.kernelValue(s.handles[i] as { id: number });
					const fold = o.value(i, { kind: 'w0' });
					if (!Object.is(kernel, fold)) {
						throw new Error(`retire: kernel value of node ${i} is ${kernel}, oracle W0 fold ${fold}`);
					}
				}
			}
			maybeAssertQuiescent(s);
			return true;
		}
		case 'truncate': {
			if (
				op.batch >= s.batches.length
				|| s.batches[op.batch].retired
				|| !s.batches[op.batch].deferred
			) {
				return false;
			}
			__debug.truncateToken(s.batches[op.batch].token);
			o.truncate(s.batches[op.batch].token);
			// Rollback re-notifies the truncated batch's own world (§9.6).
			checkBroadcasts(s, [s.batches[op.batch].token]);
			return true;
		}
		case 'startPass': {
			if (s.pass !== undefined) {
				return false;
			}
			const tokens = op.batches
				.filter((bi) => bi < s.batches.length && !s.batches[bi].retired)
				.map((bi) => s.batches[bi].token);
			s.pass = { yielded: false, pin: o.currentTick(), tokens };
			s.fork.startRenderPass('root', tokens);
			return true;
		}
		case 'yield': {
			if (s.pass === undefined || s.pass.yielded) {
				return false;
			}
			s.pass.yielded = true;
			s.fork.yieldPass();
			return true;
		}
		case 'resume': {
			if (s.pass === undefined || !s.pass.yielded) {
				return false;
			}
			s.pass.yielded = false;
			s.fork.resumePass();
			return true;
		}
		case 'endPass': {
			if (s.pass === undefined) {
				return false;
			}
			s.pass = undefined;
			s.fork.endRenderPass();
			maybeAssertQuiescent(s);
			return true;
		}
		case 'read': {
			if (op.node >= s.handles.length) {
				return false;
			}
			let engineV: number;
			let oracleV: number;
			switch (op.ctx) {
				case 'newest': {
					if (passExecuting(s)) {
						return false;
					}
					engineV = nodeValue(s, op.node);
					oracleV = s.oracle.value(op.node, { kind: 'newest' });
					break;
				}
				case 'committed': {
					if (passExecuting(s)) {
						return false;
					}
					engineV = __debug.committed(() => nodeValue(s, op.node));
					oracleV = s.oracle.value(op.node, { kind: 'committed' });
					break;
				}
				case 'render': {
					if (!passExecuting(s)) {
						return false;
					}
					engineV = nodeValue(s, op.node);
					oracleV = s.oracle.value(op.node, {
						kind: 'pass',
						pin: s.pass!.pin,
						tokens: new Set(s.pass!.tokens),
					});
					break;
				}
				case 'writer': {
					if (
						op.batch === undefined
						|| op.batch >= s.batches.length
						|| s.batches[op.batch].retired
					) {
						return false;
					}
					const token = s.batches[op.batch].token;
					engineV = __debug.readInWorld(s.handles[op.node] as { id: number }, {
						kind: 'writer',
						token,
					}) as number;
					oracleV = s.oracle.value(op.node, { kind: 'writer', token });
					break;
				}
			}
			if (!Object.is(engineV, oracleV)) {
				throw new Error(
					`read ${op.ctx} of node ${op.node}: engine ${engineV}, oracle ${oracleV}`,
				);
			}
			checkBroadcasts(s, []); // reads never broadcast
			return true;
		}
		case 'sweep': {
			__debug.sweep();
			checkBroadcasts(s, []);
			return true;
		}
	}
}

function opMatchesNode(def: NodeDef, op: WriteSpec['op']): boolean {
	if (def.type === 'atom') {
		return op === 'set' || op === 'update';
	}
	if (def.type === 'reducer') {
		return op === 'dispatch';
	}
	return false;
}

function engineWrite(s: RunState, w: WriteSpec): void {
	const token = s.batches[w.batch].token;
	const h = s.handles[w.node];
	s.fork.inBatch(token, () => {
		if (w.op === 'set') {
			(h as Atom<number>).set(w.v);
		} else if (w.op === 'update') {
			if (w.uf !== undefined) {
				(h as Atom<number>).update(UPDATE_FNS[w.uf]);
			} else {
				const d = w.v;
				(h as Atom<number>).update((x) => x + d);
			}
		} else {
			(h as ReducerAtom<number, number>).dispatch(w.v);
		}
	});
}

function applyWrites(s: RunState, writes: WriteSpec[]): boolean {
	const w = writes[0];
	if (passExecuting(s) || w.node >= s.handles.length || !isAtomNode(s.defs[w.node])) {
		return false;
	}
	if (!opMatchesNode(s.defs[w.node], w.op)) {
		return false;
	}
	if (w.batch === -1) {
		// DIRECT write: legal only at full quiescence.
		if (s.batches.some((b) => !b.retired) || s.pass !== undefined || !__debug.isDirect()) {
			return false;
		}
		const h = s.handles[w.node];
		if (w.op === 'set') {
			(h as Atom<number>).set(w.v);
		} else if (w.op === 'update') {
			if (w.uf !== undefined) {
				(h as Atom<number>).update(UPDATE_FNS[w.uf]);
			} else {
				const d = w.v;
				(h as Atom<number>).update((x) => x + d);
			}
		} else {
			(h as ReducerAtom<number, number>).dispatch(w.v);
		}
		s.oracle.directWrite(w.node, w.op, w.v, w.uf);
		checkBroadcasts(s, [0]);
		return true;
	}
	if (w.batch >= s.batches.length || s.batches[w.batch].retired) {
		return false;
	}
	engineWrite(s, w);
	s.oracle.loggedWrite(w.node, w.op, w.v, s.batches[w.batch].token, w.uf);
	checkBroadcasts(s, affectedFor(s, [w]));
	return true;
}

/** Affected worlds for one drain (§17.2): the writing batch's writer's world
 * per deferred token; the W0 world plus every live deferred writer's world
 * when any write was urgent. */
function affectedFor(s: RunState, writes: WriteSpec[]): number[] {
	const affected = new Set<number>();
	let anyUrgent = false;
	for (const w of writes) {
		const b = s.batches[w.batch];
		if (b.deferred) {
			affected.add(b.token);
		} else {
			anyUrgent = true;
		}
	}
	if (anyUrgent) {
		affected.add(0);
		for (const t of liveDeferredTokens(s)) {
			affected.add(t);
		}
	}
	return [...affected];
}

function checkBroadcasts(s: RunState, affectedTokens: number[]): void {
	const expected = s.oracle.expectedBroadcasts(affectedTokens);
	const got = s.engineNotifs;
	s.engineNotifs = [];
	if (sortPairs(got) !== sortPairs(expected)) {
		throw new Error(
			`broadcast drain mismatch: engine fired [${sortPairs(got)}], oracle expects [${sortPairs(expected)}]`,
		);
	}
}

function maybeAssertQuiescent(s: RunState): void {
	if (s.batches.every((b) => b.retired) && s.pass === undefined) {
		const st = __debug.stats();
		if (
			st.gNext !== 4
			|| st.wNext !== 8
			|| st.certNext !== 0
			|| st.seqCounter !== 1
			|| st.loggedAtomCount !== 0
			|| st.liveSlotMask !== 0
			|| st.writeMode !== 'DIRECT'
		) {
			throw new Error(`quiescence residue: ${JSON.stringify(st)}`);
		}
	}
}

// FUZZ_TINY=1 runs every schedule over minimal planes, forcing closure-rebuild
// growth on every doubling path mid-schedule, including with a pass held open
// (§17.2 growth events).
const tinyPlanes =
	(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
		?.FUZZ_TINY === '1';

export function runScript(script: Op[]): { failed: false } | { failed: true; error: unknown; atOp: number } {
	if (tinyPlanes) {
		__resetEngineForTests({ initialRecords: 8, initialLogRecords: 4, initialMemoRecords: 4 });
	} else {
		__resetEngineForTests();
	}
	const fork = new ForkDouble();
	attachFork(fork);
	const s: RunState = {
		fork,
		oracle: new Oracle(),
		handles: [],
		defs: [],
		batches: [],
		ambient: -1,
		pass: undefined,
		engineNotifs: [],
		watcherCount: 0,
	};
	for (let i = 0; i < script.length; ++i) {
		try {
			applyOp(s, script[i]);
			if (s.pass === undefined && s.engineNotifs.length === 0) {
				__debug.verify();
			} else {
				__debug.verify();
			}
		} catch (error) {
			return { failed: true, error, atOp: i };
		}
	}
	return { failed: false };
}

// ---- schedule generator --------------------------------------------------------------

export function genScript(seed: number, steps: number): Op[] {
	const rnd = mulberry32(seed);
	const pick = (n: number) => Math.floor(rnd() * n);
	const script: Op[] = [];
	// Abstract mirror for generating valid-ish ops (executor re-checks).
	let nodes: Array<'atom' | 'reducer' | 'computed'> = [];
	let batches: Array<{ deferred: boolean; retired: boolean }> = [];
	let passOpen = false;
	let yielded = false;
	let watchers = 0;

	const atomIndices = () =>
		nodes.map((k, i) => [k, i] as const).filter(([k]) => k !== 'computed').map(([, i]) => i);

	const liveBatchIndices = () =>
		batches.map((b, i) => [b, i] as const).filter(([b]) => !b.retired).map(([, i]) => i);

	function writeSpec(): WriteSpec | undefined {
		const atoms = atomIndices();
		const live = liveBatchIndices();
		if (atoms.length === 0 || live.length === 0) {
			return undefined;
		}
		const node = atoms[pick(atoms.length)];
		const kind = nodes[node];
		const op = kind === 'reducer' ? 'dispatch' : rnd() < 0.7 ? 'set' : 'update';
		return { batch: live[pick(live.length)], node, op, v: pick(10) };
	}

	for (let i = 0; i < steps; ++i) {
		const r = rnd();
		if (nodes.length === 0 || r < 0.06) {
			const v = pick(10);
			if (rnd() < 0.75) {
				script.push({ t: 'atom', v });
				nodes.push('atom');
			} else {
				script.push({ t: 'reducer', v });
				nodes.push('reducer');
			}
		} else if (r < 0.14) {
			// computed: branch shapes are the divergence workhorse
			const shape = rnd();
			if (shape < 0.15) {
				script.push({ t: 'chain', dep: pick(nodes.length) });
			} else if (shape < 0.5 && nodes.length >= 1) {
				const deps = [pick(nodes.length)];
				if (rnd() < 0.6) {
					deps.push(pick(nodes.length));
				}
				script.push({ t: 'sum', deps });
			} else {
				script.push({
					t: 'branch',
					cond: pick(nodes.length),
					ifTrue: pick(nodes.length),
					ifFalse: pick(nodes.length),
				});
			}
			nodes.push('computed');
		} else if (r < 0.22 && watchers < 12 && !(passOpen && !yielded)) {
			script.push({ t: 'watcher', node: pick(nodes.length) });
			++watchers;
		} else if (r < 0.3 && liveBatchIndices().length < 8) {
			const deferred = rnd() < 0.75;
			script.push({ t: 'open', deferred });
			batches.push({ deferred, retired: false });
		} else if (r < 0.48 && !(passOpen && !yielded)) {
			const eventish = rnd();
			if (eventish < 0.18 && atomIndices().length > 0) {
				// event-scoped urgent write (ambient batch; §6.2 mint edge)
				const atoms = atomIndices();
				const node = atoms[pick(atoms.length)];
				const op = nodes[node] === 'reducer' ? ('dispatch' as const) : ('set' as const);
				script.push({ t: 'urgentWrite', w: { node, op, v: pick(10) } });
			} else if (eventish < 0.24) {
				script.push({ t: 'closeEvent' });
			} else {
				const w = writeSpec();
				if (w !== undefined) {
					if (w.op === 'update' && rnd() < 0.4) {
						w.uf = pick(4); // indexed pure fns, incl. identity (cutoffs)
					}
					script.push({ t: 'write', w });
				} else if (batches.every((b) => b.retired) && !passOpen && atomIndices().length > 0) {
					const atoms = atomIndices();
					const node = atoms[pick(atoms.length)];
					const op = nodes[node] === 'reducer' ? ('dispatch' as const) : ('set' as const);
					script.push({ t: 'write', w: { batch: -1, node, op, v: pick(10) } });
				}
			}
		} else if (r < 0.53 && !(passOpen && !yielded)) {
			const writes: WriteSpec[] = [];
			const n = 1 + pick(4);
			for (let j = 0; j < n; ++j) {
				const w = writeSpec();
				if (w !== undefined) {
					writes.push(w);
				}
			}
			if (writes.length !== 0) {
				script.push({ t: 'group', writes });
			}
		} else if (r < 0.72) {
			const ctxs = ['newest', 'committed', 'render', 'writer'] as const;
			const ctx = ctxs[pick(4)];
			const live = liveBatchIndices();
			script.push({
				t: 'read',
				node: pick(nodes.length),
				ctx,
				batch: live.length !== 0 ? live[pick(live.length)] : undefined,
			});
		} else if (r < 0.8) {
			const live = liveBatchIndices();
			if (live.length !== 0) {
				const bi = live[pick(live.length)];
				if (rnd() < 0.12 && batches[bi].deferred) {
					script.push({ t: 'truncate', batch: bi });
				} else {
					script.push({ t: 'retire', batch: bi, committed: rnd() < 0.7 });
					batches[bi].retired = true;
				}
			}
		} else if (r < 0.94) {
			// pass lifecycle
			if (!passOpen) {
				const live = liveBatchIndices();
				const included: number[] = [];
				for (const bi of live) {
					if (rnd() < 0.5) {
						included.push(bi);
					}
				}
				script.push({ t: 'startPass', batches: included });
				passOpen = true;
				yielded = false;
			} else if (!yielded && rnd() < 0.5) {
				script.push({ t: 'yield' });
				yielded = true;
			} else if (yielded && rnd() < 0.6) {
				script.push({ t: 'resume' });
				yielded = false;
			} else {
				script.push({ t: 'endPass' });
				passOpen = false;
				yielded = false;
			}
		} else {
			script.push({ t: 'sweep' });
		}
	}
	// Close everything so quiescence assertions run at the end.
	if (passOpen) {
		script.push({ t: 'endPass' });
	}
	script.push({ t: 'closeEvent' });
	for (let bi = 0; bi < batches.length; ++bi) {
		if (!batches[bi].retired) {
			script.push({ t: 'retire', batch: bi, committed: true });
		}
	}
	return script;
}

// ---- shrinking -------------------------------------------------------------------------

export function shrink(script: Op[]): Op[] {
	let current = script;
	let improved = true;
	while (improved) {
		improved = false;
		for (let i = 0; i < current.length; ++i) {
			const candidate = current.slice(0, i).concat(current.slice(i + 1));
			const result = runScript(candidate);
			if (result.failed) {
				current = candidate;
				improved = true;
				break;
			}
		}
	}
	return current;
}

