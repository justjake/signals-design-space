/**
 * Randomized oracle: a naive model of this engine's semantics (per-atom
 * write history, memo-free rederivation, world folds) fuzzed against the
 * real engine. Failures print the seed and a shrunk schedule.
 *
 * Seed count: ORACLE_SEEDS env (default 300), ~90 steps per seed.
 */
import { describe, expect, test } from 'vitest';
import {
	atom,
	computed,
	effect,
	createBatch,
	retireBatch,
	abortBatch,
	runInWriteBatch,
	withWorld,
	subscribeNode,
	latest,
	resetForTest,
	openBatchCount,
	type Atom,
	type Computed,
	type WorldBatch,
} from '../src/index';

// -- deterministic PRNG ------------------------------------------------------

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// -- schedule ops (pure data, so schedules replay and shrink) ----------------

type Op =
	| { op: 'atom'; value: number }
	| { op: 'computed'; srcA: number; srcB: number; kind: number }
	| { op: 'set'; node: number; value: number; batch: number } // batch -1 = urgent
	| { op: 'update'; node: number; delta: number; batch: number }
	| { op: 'open' }
	| { op: 'retire'; batch: number }
	| { op: 'abort'; batch: number }
	| { op: 'sub'; node: number }
	| { op: 'unsub'; node: number };

function generate(rand: () => number, steps: number): Op[] {
	const ops: Op[] = [{ op: 'atom', value: 0 }];
	for (let i = 0; i < steps; i++) {
		const r = rand();
		const node = Math.floor(rand() * 40);
		const batch = Math.floor(rand() * 6);
		if (r < 0.12) ops.push({ op: 'atom', value: Math.floor(rand() * 100) });
		else if (r < 0.24)
			ops.push({
				op: 'computed',
				srcA: node,
				srcB: Math.floor(rand() * 40),
				kind: Math.floor(rand() * 3),
			});
		else if (r < 0.42) ops.push({ op: 'set', node, value: Math.floor(rand() * 100), batch: -1 });
		else if (r < 0.52) ops.push({ op: 'update', node, delta: 1 + Math.floor(rand() * 5), batch: -1 });
		else if (r < 0.62) ops.push({ op: 'set', node, value: Math.floor(rand() * 100), batch });
		else if (r < 0.72) ops.push({ op: 'update', node, delta: 1 + Math.floor(rand() * 5), batch });
		else if (r < 0.79) ops.push({ op: 'open' });
		else if (r < 0.86) ops.push({ op: 'retire', batch });
		else if (r < 0.9) ops.push({ op: 'abort', batch });
		else if (r < 0.96) ops.push({ op: 'sub', node });
		else ops.push({ op: 'unsub', node });
	}
	return ops;
}

// -- the naive model ---------------------------------------------------------

/** batch: null = urgent op; number = deferred batch id. */
type ModelOp = { batch: number | null } & ({ set: number } | { add: number });

type ModelNode =
	| { kind: 'atom'; base: number; queue: ModelOp[] }
	| { kind: 'computed'; srcA: number; srcB: number; fnKind: number };

interface Model {
	nodes: ModelNode[];
	openBatches: number[]; // model batch ids in creation order
}

/**
 * Memo-free rederivation. Atom value in a world = base folded through the
 * dispatch-ordered queue, keeping urgent ops plus the world's batches
 * (world 'all' = every op: the latest() fold).
 */
function modelValue(m: Model, i: number, world: number[] | 'all'): number {
	const n = m.nodes[i];
	if (n.kind === 'atom') {
		let v = n.base;
		for (const op of n.queue) {
			if (world !== 'all' && op.batch !== null && !world.includes(op.batch)) continue;
			v = 'set' in op ? op.set : v + op.add;
		}
		return v;
	}
	const a = modelValue(m, n.srcA, world);
	const b = modelValue(m, n.srcB, world);
	return n.fnKind === 0 ? a + b : n.fnKind === 1 ? a * 2 - b : Math.max(a, b);
}

// -- run one schedule against engine + model ---------------------------------

export function runSchedule(ops: Op[]): string | null {
	resetForTest();
	const m: Model = { nodes: [], openBatches: [] };
	const engineNodes: Array<Atom<number> | Computed<number>> = [];
	const engineBatches = new Map<number, WorldBatch>();
	const unsubs = new Map<number, () => void>();
	const effectSeen = new Map<number, number>();
	const disposers: Array<() => void> = [];
	let nextModelBatch = 0;

	const nodeAt = (i: number) => (engineNodes.length === 0 ? -1 : i % engineNodes.length);
	const batchAt = (i: number) =>
		m.openBatches.length === 0 ? -1 : m.openBatches[i % m.openBatches.length];

	try {
		for (const step of ops) {
			switch (step.op) {
				case 'atom': {
					m.nodes.push({ kind: 'atom', base: step.value, queue: [] });
					engineNodes.push(atom(step.value));
					break;
				}
				case 'computed': {
					if (engineNodes.length === 0) break;
					const srcA = nodeAt(step.srcA);
					const srcB = nodeAt(step.srcB);
					m.nodes.push({ kind: 'computed', srcA, srcB, fnKind: step.kind });
					const ea = engineNodes[srcA];
					const eb = engineNodes[srcB];
					const k = step.kind;
					engineNodes.push(
						computed(() =>
							k === 0 ? ea.get() + eb.get() : k === 1 ? ea.get() * 2 - eb.get() : Math.max(ea.get(), eb.get()),
						),
					);
					break;
				}
				case 'set':
				case 'update': {
					const i = nodeAt(step.node);
					if (i < 0) break;
					const n = m.nodes[i];
					if (n.kind !== 'atom') break;
					const en = engineNodes[i] as Atom<number>;
					const bid = step.batch < 0 ? -1 : batchAt(step.batch);
					const apply = () =>
						step.op === 'set' ? en.set(step.value) : en.update((x) => x + step.delta);
					const idx = m.nodes.indexOf(n);
					if (bid < 0) {
						apply();
						if (step.op === 'set' && modelValue(m, idx, []) === step.value) break; // equal drop
						n.queue.push(
							step.op === 'set' ? { batch: null, set: step.value } : { batch: null, add: step.delta },
						);
					} else {
						runInWriteBatch(engineBatches.get(bid)!, apply);
						// Equal-value set drafts drop (compared in the batch's own world).
						if (step.op === 'set' && modelValue(m, idx, [bid]) === step.value) break;
						n.queue.push(
							step.op === 'set' ? { batch: bid, set: step.value } : { batch: bid, add: step.delta },
						);
					}
					break;
				}
				case 'open': {
					const id = nextModelBatch++;
					m.openBatches.push(id);
					engineBatches.set(id, createBatch(true, `b${id}`));
					break;
				}
				case 'retire':
				case 'abort': {
					const bid = batchAt(step.batch);
					if (bid < 0) break;
					m.openBatches = m.openBatches.filter((x) => x !== bid);
					const eb = engineBatches.get(bid)!;
					if (step.op === 'retire') {
						retireBatch(eb);
						// Retired ops become committed ops in place: dispatch order
						// is preserved relative to still-open batches' drafts.
						for (const n of m.nodes) {
							if (n.kind !== 'atom') continue;
							for (const op of n.queue) if (op.batch === bid) op.batch = null;
						}
					} else {
						abortBatch(eb);
						for (const n of m.nodes) {
							if (n.kind !== 'atom') continue;
							n.queue = n.queue.filter((op) => op.batch !== bid);
						}
					}
					engineBatches.delete(bid);
					break;
				}
				case 'sub': {
					const i = nodeAt(step.node);
					if (i < 0 || unsubs.has(i)) break;
					unsubs.set(i, subscribeNode(engineNodes[i], () => {}));
					const idx = i;
					disposers.push(
					effect(() => {
						effectSeen.set(idx, engineNodes[idx].get());
					}),
				);
					break;
				}
				case 'unsub': {
					const i = nodeAt(step.node);
					const u = i < 0 ? undefined : unsubs.get(i);
					if (u) {
						u();
						unsubs.delete(i);
					}
					break;
				}
			}

			// -- verify every node against the model, in every view --------------
			for (let i = 0; i < engineNodes.length; i++) {
				const canonical = engineNodes[i].get();
				const expectCanonical = modelValue(m, i, []);
				if (canonical !== expectCanonical)
					return `node ${i} canonical: engine ${canonical} != model ${expectCanonical}`;
				const lat = latest(engineNodes[i]);
				const expectLatest = modelValue(m, i, 'all');
				if (lat !== expectLatest) return `node ${i} latest: engine ${lat} != model ${expectLatest}`;
				for (const bid of m.openBatches) {
					const eb = engineBatches.get(bid)!;
					const got = withWorld([eb], () => engineNodes[i].get());
					const want = modelValue(m, i, [bid]);
					if (got !== want) return `node ${i} world[b${bid}]: engine ${got} != model ${want}`;
				}
			}
			// Effects track canonical values exactly.
			for (const [i, seen] of effectSeen) {
				const want = modelValue(m, i, []);
				if (seen !== want) return `effect on node ${i}: saw ${seen} != model ${want}`;
			}
		}
		if (m.openBatches.length === 0 && openBatchCount() !== 0)
			return `quiescence: ${openBatchCount()} batches still open`;
		return null;
	} catch (e) {
		return `threw: ${String(e)}`;
	} finally {
		for (const d of disposers) d();
		for (const u of unsubs.values()) u();
		resetForTest();
	}
}

/** Greedy shrink: drop ops while the failure reproduces. */
function shrink(ops: Op[]): Op[] {
	let current = ops.slice();
	let changed = true;
	while (changed) {
		changed = false;
		for (let i = current.length - 1; i >= 0; i--) {
			const candidate = current.slice(0, i).concat(current.slice(i + 1));
			if (runSchedule(candidate) !== null) {
				current = candidate;
				changed = true;
			}
		}
	}
	return current;
}

const SEEDS = Number(process.env.ORACLE_SEEDS ?? 300);
const STEPS = 90;

describe(`oracle fuzz (${SEEDS} seeds x ${STEPS} steps)`, () => {
	test('engine matches the naive model on every seed', () => {
		for (let seed = 1; seed <= SEEDS; seed++) {
			const ops = generate(mulberry32(seed), STEPS);
			const failure = runSchedule(ops);
			if (failure !== null) {
				const small = shrink(ops);
				expect.fail(
					`seed ${seed}: ${failure}\nshrunk schedule (${small.length} ops):\n` +
						small.map((o) => JSON.stringify(o)).join('\n'),
				);
			}
		}
	});
});
