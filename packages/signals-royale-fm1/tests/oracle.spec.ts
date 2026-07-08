/**
 * Randomized oracle: a naive model of this engine's semantics — per-atom
 * canonical values, per-batch write-intent histories, memo-free rederivation
 * of computeds, and world folds — fuzzed against the real engine.
 *
 * FUZZ_SEEDS tunes the seed count (default 300, ~90 steps each). A failure
 * prints the seed plus a greedily shrunk schedule; pin found bugs as named
 * regression tests at the bottom.
 */
import { describe, expect, test } from 'vitest';
import {
	Batch,
	Snapshot,
	atom,
	commitBatch,
	computed,
	discardBatch,
	effect,
	latest,
	openBatch,
	update,
	withAmbientBatch,
	withSnapshot,
	write,
	type Atom,
	type Computed,
} from '../src/index.ts';

// Deterministic PRNG (mulberry32).
function rng(seed: number): () => number {
	let s = seed | 0;
	return () => {
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const N_ATOMS = 5;
const N_COMPUTED = 6;

type CompDef = { kind: 'add' | 'mul' | 'pick'; a: number; b: number; c: number };

type Step =
	| { op: 'set'; atom: number; value: number }
	| { op: 'update'; atom: number; mult: number; add: number }
	| { op: 'open' }
	| { op: 'bset'; batch: number; atom: number; value: number }
	| { op: 'bupdate'; batch: number; atom: number; mult: number; add: number }
	| { op: 'commit'; batch: number }
	| { op: 'discard'; batch: number };

interface Schedule {
	defs: CompDef[];
	steps: Step[];
	liveComputeds: number[];
}

function genSchedule(rand: () => number, nSteps: number): Schedule {
	const defs: CompDef[] = [];
	for (let i = 0; i < N_COMPUTED; i++) {
		// Sources index atoms [0,N_ATOMS) or earlier computeds [N_ATOMS, N_ATOMS+i).
		const range = N_ATOMS + i;
		const kinds = ['add', 'mul', 'pick'] as const;
		defs.push({
			kind: kinds[Math.floor(rand() * 3)],
			a: Math.floor(rand() * range),
			b: Math.floor(rand() * range),
			c: Math.floor(rand() * range),
		});
	}
	const steps: Step[] = [];
	let batches = 0;
	for (let i = 0; i < nSteps; i++) {
		const r = rand();
		if (r < 0.3) {
			steps.push({ op: 'set', atom: Math.floor(rand() * N_ATOMS), value: Math.floor(rand() * 20) - 5 });
		} else if (r < 0.45) {
			steps.push({
				op: 'update',
				atom: Math.floor(rand() * N_ATOMS),
				mult: rand() < 0.5 ? 2 : 1,
				add: Math.floor(rand() * 5) - 2,
			});
		} else if (r < 0.55) {
			steps.push({ op: 'open' });
			batches++;
		} else if (batches > 0 && r < 0.75) {
			const batch = Math.floor(rand() * batches);
			if (rand() < 0.6) {
				steps.push({ op: 'bset', batch, atom: Math.floor(rand() * N_ATOMS), value: Math.floor(rand() * 20) - 5 });
			} else {
				steps.push({
					op: 'bupdate',
					batch,
					atom: Math.floor(rand() * N_ATOMS),
					mult: rand() < 0.5 ? 2 : 1,
					add: Math.floor(rand() * 5) - 2,
				});
			}
		} else if (batches > 0 && r < 0.85) {
			steps.push({ op: 'commit', batch: Math.floor(rand() * batches) });
		} else if (batches > 0 && r < 0.9) {
			steps.push({ op: 'discard', batch: Math.floor(rand() * batches) });
		} else {
			steps.push({ op: 'set', atom: Math.floor(rand() * N_ATOMS), value: Math.floor(rand() * 20) - 5 });
		}
	}
	const liveComputeds = [N_COMPUTED - 1, Math.floor(rand() * N_COMPUTED)];
	return { defs, steps, liveComputeds };
}

// --- The naive model ------------------------------------------------------

type Intent = { kind: 'set'; value: number } | { kind: 'fn'; mult: number; add: number };
interface ModelEntry {
	op: Intent;
	owner: number | null; // batch index; null = urgent
}
interface ModelLog {
	base: number;
	entries: ModelEntry[];
}
interface ModelBatch {
	status: 'open' | 'committed' | 'discarded';
	touched: Set<number>;
}

function applyOp(v: number, op: Intent): number {
	return op.kind === 'set' ? op.value : v * op.mult + op.add;
}

class Model {
	values: number[] = [];
	batches: ModelBatch[] = [];
	logs = new Map<number, ModelLog>();
	defs: CompDef[];

	constructor(defs: CompDef[]) {
		this.defs = defs;
		for (let i = 0; i < N_ATOMS; i++) this.values.push(i);
	}

	/** Memo-free rederivation of node `i` over a given atom valuation. */
	derive(i: number, atomValues: number[]): number {
		if (i < N_ATOMS) return atomValues[i];
		const def = this.defs[i - N_ATOMS];
		const a = this.derive(def.a, atomValues);
		const b = this.derive(def.b, atomValues);
		const c = this.derive(def.c, atomValues);
		if (def.kind === 'add') return a + b;
		if (def.kind === 'mul') return a * b - c;
		return a > 0 ? b : c;
	}

	log(atom: number): ModelLog {
		let log = this.logs.get(atom);
		if (log === undefined) {
			log = { base: this.values[atom], entries: [] };
			this.logs.set(atom, log);
		}
		return log;
	}

	replay(atom: number, visible: (owner: number | null) => boolean): number {
		const log = this.logs.get(atom);
		if (log === undefined) return this.values[atom];
		let v = log.base;
		for (const e of log.entries) {
			if (visible(e.owner)) v = applyOp(v, e.op);
		}
		return v;
	}

	prune(atom: number): void {
		const log = this.logs.get(atom);
		if (log === undefined) return;
		const hasOpen = log.entries.some(
			(e) => e.owner !== null && this.batches[e.owner].status === 'open',
		);
		if (!hasOpen) this.logs.delete(atom);
	}

	urgent(atom: number, op: Intent): void {
		if (this.logs.has(atom)) this.log(atom).entries.push({ op, owner: null });
		this.values[atom] = applyOp(this.values[atom], op);
	}

	/** Atom valuation a world sees: canonical unless an included open batch
	 * touches the atom, in which case the full call-order replay of urgents,
	 * retired batches, and the included open batches. */
	worldValues(included: (owner: number) => boolean): number[] {
		const out = this.values.slice();
		for (const [atom, log] of this.logs) {
			const touchedByIncluded = log.entries.some(
				(e) =>
					e.owner !== null &&
					this.batches[e.owner].status === 'open' &&
					included(e.owner),
			);
			if (!touchedByIncluded) continue;
			out[atom] = this.replay(
				atom,
				(owner) =>
					owner === null ||
					this.batches[owner].status === 'committed' ||
					(this.batches[owner].status === 'open' && included(owner)),
			);
		}
		return out;
	}

	latestValues(): number[] {
		return this.worldValues(() => true);
	}

	apply(step: Step): void {
		switch (step.op) {
			case 'set':
				this.urgent(step.atom, { kind: 'set', value: step.value });
				break;
			case 'update':
				this.urgent(step.atom, { kind: 'fn', mult: step.mult, add: step.add });
				break;
			case 'open':
				this.batches.push({ status: 'open', touched: new Set() });
				break;
			case 'bset':
			case 'bupdate': {
				const b = this.batches[step.batch];
				if (b === undefined) break;
				const op: Intent =
					step.op === 'bset'
						? { kind: 'set', value: step.value }
						: { kind: 'fn', mult: step.mult, add: step.add };
				if (b.status !== 'open') {
					// A write scoped to a retired batch lands urgently (never drops).
					this.urgent(step.atom, op);
					break;
				}
				b.touched.add(step.atom);
				this.log(step.atom).entries.push({ op, owner: step.batch });
				break;
			}
			case 'commit': {
				const b = this.batches[step.batch];
				if (b === undefined || b.status !== 'open') break;
				b.status = 'committed';
				for (const atom of b.touched) {
					this.values[atom] = this.replay(
						atom,
						(owner) => owner === null || this.batches[owner].status === 'committed',
					);
					this.prune(atom);
				}
				break;
			}
			case 'discard': {
				const b = this.batches[step.batch];
				if (b === undefined || b.status !== 'open') break;
				b.status = 'discarded';
				for (const atom of b.touched) {
					const log = this.logs.get(atom);
					if (log !== undefined) {
						log.entries = log.entries.filter((e) => e.owner !== step.batch);
					}
					this.prune(atom);
				}
				break;
			}
		}
	}
}

// --- Runner ----------------------------------------------------------------

function runSchedule(schedule: Schedule): string | null {
	const { defs, steps, liveComputeds } = schedule;
	const atoms: Atom<number>[] = [];
	for (let i = 0; i < N_ATOMS; i++) atoms.push(atom(i));
	const nodes: (Atom<number> | Computed<number>)[] = [...atoms];
	for (const def of defs) {
		const node = computed<number>(() => {
			const a = (nodes[def.a] as Computed<number>).get();
			const b = (nodes[def.b] as Computed<number>).get();
			const c = (nodes[def.c] as Computed<number>).get();
			if (def.kind === 'add') return a + b;
			if (def.kind === 'mul') return a * b - c;
			return a > 0 ? b : c;
		});
		nodes.push(node);
	}
	const disposers = liveComputeds.map((i) => effect(() => nodes[N_ATOMS + i].get()));

	const model = new Model(defs);
	const batches: Batch[] = [];
	try {
		for (let s = 0; s < steps.length; s++) {
			const step = steps[s];
			// Shrinking may drop an 'open' step; both sides skip dangling refs.
			if ('batch' in step && batches[step.batch] === undefined) continue;
			switch (step.op) {
				case 'set':
					write(atoms[step.atom], step.value);
					break;
				case 'update':
					update(atoms[step.atom], (x) => x * step.mult + step.add);
					break;
				case 'open':
					batches.push(openBatch());
					break;
				case 'bset':
					withAmbientBatch(batches[step.batch], () => write(atoms[step.atom], step.value));
					break;
				case 'bupdate':
					withAmbientBatch(batches[step.batch], () =>
						update(atoms[step.atom], (x) => x * step.mult + step.add),
					);
					break;
				case 'commit':
					commitBatch(batches[step.batch]);
					break;
				case 'discard':
					discardBatch(batches[step.batch]);
					break;
			}
			model.apply(step);

			// Canonical reads: every node matches memo-free rederivation.
			for (let i = 0; i < nodes.length; i++) {
				const got = i < N_ATOMS ? atoms[i].peek() : (nodes[i] as Computed<number>).get();
				const want = model.derive(i, model.values);
				if (!Object.is(got, want)) {
					return `step ${s}: canonical node ${i}: got ${got}, want ${want}`;
				}
			}
			// Latest reads fold every open batch in order.
			const latestVals = model.latestValues();
			for (let i = 0; i < nodes.length; i++) {
				const got = latest(nodes[i]);
				const want = model.derive(i, latestVals);
				if (!Object.is(got, want)) {
					return `step ${s}: latest node ${i}: got ${got}, want ${want}`;
				}
			}
			// A snapshot over each single open batch replays urgents + that batch.
			for (let bi = 0; bi < batches.length; bi++) {
				if (batches[bi].status !== 'open') continue;
				const snap = new Snapshot([batches[bi]], true);
				const world = model.worldValues((owner) => owner === bi);
				for (let i = 0; i < nodes.length; i++) {
					const got = withSnapshot(snap, () => (nodes[i] as Computed<number>).get());
					const want = model.derive(i, world);
					if (!Object.is(got, want)) {
						return `step ${s}: snapshot[batch ${bi}] node ${i}: got ${got}, want ${want}`;
					}
				}
			}
		}
	} finally {
		disposers.forEach((d) => d());
		for (const b of batches) discardBatch(b);
	}
	return null;
}

/** Greedy shrink: drop steps one at a time while the failure reproduces. */
function shrink(schedule: Schedule): Schedule {
	let current = schedule;
	let improved = true;
	while (improved) {
		improved = false;
		for (let i = 0; i < current.steps.length; i++) {
			const candidate: Schedule = {
				...current,
				steps: current.steps.slice(0, i).concat(current.steps.slice(i + 1)),
			};
			if (runSchedule(candidate) !== null) {
				current = candidate;
				improved = true;
				break;
			}
		}
	}
	return current;
}

const SEEDS = Number(process.env.FUZZ_SEEDS ?? 300);
const STEPS = 90;

describe(`oracle fuzz (${SEEDS} seeds x ${STEPS} steps)`, () => {
	test('engine matches the naive model on every schedule', () => {
		for (let seed = 1; seed <= SEEDS; seed++) {
			const schedule = genSchedule(rng(seed), STEPS);
			const failure = runSchedule(schedule);
			if (failure !== null) {
				const small = shrink(schedule);
				const report = [
					`seed ${seed}: ${failure}`,
					`shrunk schedule (${small.steps.length} steps):`,
					JSON.stringify(small.defs),
					JSON.stringify(small.steps),
				].join('\n');
				expect.fail(report);
			}
		}
	});
});
