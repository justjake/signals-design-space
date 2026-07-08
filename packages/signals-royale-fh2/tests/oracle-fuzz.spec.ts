/**
 * Randomized oracle fuzz: the engine against the naive model, over random
 * schedules of urgent and draft writes, functional updates, batch
 * lifecycle, world reads, and computed rederivation.
 *
 * Seeds are env-tunable: ORACLE_SEEDS (default 300) x ORACLE_STEPS
 * (default 90). A failure prints its seed and a shrunk schedule (greedy
 * op-removal) so it can be replayed and pinned as a regression.
 */
import { describe, expect, test } from 'vitest';
import {
	__resetEngine,
	atom,
	batch as graphBatch,
	computed,
	discardBatch,
	isPending,
	latest,
	openBatch,
	quiescent,
	read,
	readInWorld,
	retireBatch,
	set,
	setInBatch,
	subscribe,
	update,
	updateInBatch,
	type Atom,
	type Batch,
	type Computed,
} from '../src/index';
import { Model, rng, type ModelOp } from './oracle';

declare const process: { env: Record<string, string | undefined> };

const SEEDS = Number(process.env.ORACLE_SEEDS ?? 300);
const STEPS = Number(process.env.ORACLE_STEPS ?? 90);

const N_ATOMS = 6;
const UPDATE_FNS: Array<[(x: number) => number, string]> = [
	[(x) => x + 1, '+1'],
	[(x) => x * 2, '*2'],
	[(x) => x - 3, '-3'],
	[(x) => x, 'id'],
];

type Step =
	| { kind: 'set'; atom: number; value: number; batch: number }
	| { kind: 'update'; atom: number; fn: number; batch: number }
	| { kind: 'open' }
	| { kind: 'retire'; pick: number }
	| { kind: 'discard'; pick: number }
	| { kind: 'graphBatch'; writes: Array<{ atom: number; value: number }> }
	| { kind: 'check' };

interface Run {
	failure: string | null;
}

/** Replays a schedule against a fresh engine + model; returns the first
 * divergence (or throw) as a string, or null. */
function runSchedule(seed: number, steps: Step[]): Run {
	__resetEngine();
	const model = new Model();
	const atoms: Array<Atom<number>> = [];
	for (let i = 0; i < N_ATOMS; i++) {
		// atom0 exercises the custom-equality code path. The relation must be
		// an equality proper (not a tolerance like |a-b|<2): the graph applies
		// it two-phase (per staged write, then value-vs-staged at the flush
		// boundary), so a non-transitive relation yields values that differ
		// only up to declared equivalence — unobservable by design, but not
		// bit-comparable by a naive model.
		const equals = i === 0 ? (a: number, b: number) => a === b : undefined;
		model.addAtom(i, equals);
		atoms.push(atom(i, equals ? { equals } : undefined));
	}
	// Computeds: a static sum, a conditional (dynamic deps), and a chain.
	const sum = computed(() => read(atoms[0]!) + read(atoms[1]!) + read(atoms[2]!));
	const cond = computed(() => (read(atoms[3]!) % 2 === 0 ? read(atoms[4]!) : read(atoms[5]!)));
	const chain = computed(() => read(sum) * 10 + read(cond));
	const modelSum = (v: (i: number) => number) => v(0) + v(1) + v(2);
	const modelCond = (v: (i: number) => number) => (v(3) % 2 === 0 ? v(4) : v(5));
	const modelChain = (v: (i: number) => number) => modelSum(v) * 10 + modelCond(v);

	// A live subscriber so watcher delivery paths run under fuzz too.
	const sub = subscribe(sum, () => {});

	const engineBatches = new Map<number, Batch>();
	const liveModelBatches: number[] = [];

	const check = (): string | null => {
		for (let i = 0; i < N_ATOMS; i++) {
			const got = read(atoms[i]!);
			const want = model.canonical(i);
			if (!Object.is(got, want)) {
				return `read(atom${i}) = ${got}, model ${want}`;
			}
			const gotLatest = latest(atoms[i]!);
			const wantLatest = model.latest(i);
			if (!Object.is(gotLatest, wantLatest)) {
				return `latest(atom${i}) = ${gotLatest}, model ${wantLatest}`;
			}
			const gotPending = isPending(atoms[i]!);
			const wantPending = model.isPending(i);
			if (gotPending !== wantPending) {
				return `isPending(atom${i}) = ${gotPending}, model ${wantPending}`;
			}
		}
		const canonicalView = (i: number) => model.canonical(i);
		for (const [c, f, name] of [
			[sum, modelSum, 'sum'],
			[cond, modelCond, 'cond'],
			[chain, modelChain, 'chain'],
		] as Array<[Computed<number>, (v: (i: number) => number) => number, string]>) {
			const got = read(c);
			const want = f(canonicalView);
			if (!Object.is(got, want)) {
				return `read(${name}) = ${got}, model ${want}`;
			}
		}
		// A random world: every open batch (== latest world) checked per
		// computed; single-batch worlds checked through the model fold.
		for (const id of liveModelBatches) {
			if (!model.open.has(id)) {
				continue;
			}
			const eb = engineBatches.get(id)!;
			const view = (i: number) => model.valueIn(i, new Set([id]));
			for (let i = 0; i < N_ATOMS; i++) {
				const got = readInWorld(atoms[i]!, [eb]);
				const want = view(i);
				if (!Object.is(got, want)) {
					return `world[${id}](atom${i}) = ${got}, model ${want}`;
				}
			}
			const gotChain = readInWorld(chain, [eb]);
			const wantChain = modelChain(view);
			if (!Object.is(gotChain, wantChain)) {
				return `world[${id}](chain) = ${gotChain}, model ${wantChain}`;
			}
		}
		return null;
	};

	let failure: string | null = null;
	try {
		for (const step of steps) {
			switch (step.kind) {
				case 'open': {
					const id = model.openBatch();
					engineBatches.set(id, openBatch());
					liveModelBatches.push(id);
					break;
				}
				case 'retire': {
					const openIds = liveModelBatches.filter((id) => model.open.has(id));
					if (openIds.length === 0) {
						break;
					}
					const id = openIds[step.pick % openIds.length]!;
					model.retire(id);
					retireBatch(engineBatches.get(id)!);
					break;
				}
				case 'discard': {
					const openIds = liveModelBatches.filter((id) => model.open.has(id));
					if (openIds.length === 0) {
						break;
					}
					const id = openIds[step.pick % openIds.length]!;
					model.discard(id);
					discardBatch(engineBatches.get(id)!);
					break;
				}
				case 'set': {
					if (step.batch === 0) {
						model.write({ atom: step.atom, batch: 0, set: step.value });
						set(atoms[step.atom]!, step.value);
					} else {
						const openIds = liveModelBatches.filter((id) => model.open.has(id));
						if (openIds.length === 0) {
							break;
						}
						const id = openIds[step.batch % openIds.length]!;
						model.write({ atom: step.atom, batch: id, set: step.value });
						setInBatch(engineBatches.get(id)!, atoms[step.atom]!, step.value);
					}
					break;
				}
				case 'update': {
					const [fn] = UPDATE_FNS[step.fn % UPDATE_FNS.length]!;
					if (step.batch === 0) {
						model.write({ atom: step.atom, batch: 0, update: fn });
						update(atoms[step.atom]!, fn);
					} else {
						const openIds = liveModelBatches.filter((id) => model.open.has(id));
						if (openIds.length === 0) {
							break;
						}
						const id = openIds[step.batch % openIds.length]!;
						model.write({ atom: step.atom, batch: id, update: fn });
						updateInBatch(engineBatches.get(id)!, atoms[step.atom]!, fn);
					}
					break;
				}
				case 'graphBatch': {
					graphBatch(() => {
						for (const w of step.writes) {
							model.write({ atom: w.atom, batch: 0, set: w.value });
							set(atoms[w.atom]!, w.value);
						}
					});
					break;
				}
				case 'check': {
					failure = check();
					break;
				}
			}
			if (failure === null && step.kind !== 'check') {
				failure = check();
			}
			if (failure !== null) {
				break;
			}
		}
		if (failure === null) {
			// Converge: retire everything, expect canonical == full fold and
			// full quiescence (all episodic state reclaimed).
			for (const id of liveModelBatches) {
				if (model.open.has(id)) {
					model.retire(id);
					retireBatch(engineBatches.get(id)!);
				}
			}
			failure = check();
			if (failure === null && !quiescent()) {
				failure = 'engine not quiescent after all batches retired';
			}
		}
	} catch (e) {
		failure = `threw: ${String(e)}`;
	} finally {
		sub.dispose();
	}
	return { failure };
}

function generate(seed: number): Step[] {
	const rand = rng(seed);
	const steps: Step[] = [];
	const int = (n: number) => Math.floor(rand() * n);
	for (let i = 0; i < STEPS; i++) {
		const roll = rand();
		if (roll < 0.3) {
			steps.push({ kind: 'set', atom: int(N_ATOMS), value: int(12), batch: rand() < 0.5 ? 0 : 1 + int(4) });
		} else if (roll < 0.5) {
			steps.push({ kind: 'update', atom: int(N_ATOMS), fn: int(UPDATE_FNS.length), batch: rand() < 0.5 ? 0 : 1 + int(4) });
		} else if (roll < 0.62) {
			steps.push({ kind: 'open' });
		} else if (roll < 0.74) {
			steps.push({ kind: 'retire', pick: int(8) });
		} else if (roll < 0.82) {
			steps.push({ kind: 'discard', pick: int(8) });
		} else if (roll < 0.92) {
			const writes = Array.from({ length: 1 + int(3) }, () => ({ atom: int(N_ATOMS), value: int(12) }));
			steps.push({ kind: 'graphBatch', writes });
		} else {
			steps.push({ kind: 'check' });
		}
	}
	return steps;
}

/** Greedy shrink: drop each step if the schedule still fails without it. */
function shrink(seed: number, steps: Step[]): Step[] {
	let current = steps;
	let changed = true;
	while (changed) {
		changed = false;
		for (let i = 0; i < current.length; i++) {
			const candidate = current.slice(0, i).concat(current.slice(i + 1));
			if (runSchedule(seed, candidate).failure !== null) {
				current = candidate;
				changed = true;
				break;
			}
		}
	}
	return current;
}

describe(`oracle fuzz (${SEEDS} seeds x ${STEPS} steps)`, () => {
	test('engine matches the naive model on every seed', () => {
		const failures: string[] = [];
		for (let seed = 1; seed <= SEEDS; seed++) {
			const steps = generate(seed);
			const { failure } = runSchedule(seed, steps);
			if (failure !== null) {
				const minimal = shrink(seed, steps);
				const replay = runSchedule(seed, minimal);
				failures.push(
					`seed ${seed}: ${failure}\n  shrunk to ${minimal.length} steps: ${JSON.stringify(minimal)}\n  shrunk failure: ${replay.failure}`,
				);
				if (failures.length >= 3) {
					break;
				}
			}
		}
		expect(failures, failures.join('\n\n')).toEqual([]);
	}, 120000);
});
