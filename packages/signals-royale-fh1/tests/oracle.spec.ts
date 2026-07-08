/**
 * Randomized oracle: a naive, memo-free model of THIS engine's semantics.
 *
 * The model keeps, per atom, the full ordered list of write operations with
 * their batch attribution, plus the retired/discarded status of every batch.
 * Every read family member is a fold over that list:
 *
 * - canonical  = ops where batch is urgent-or-retired, in order;
 * - latest     = ops where batch is not discarded, in order;
 * - a world    = ops visible under (creation snapshot, listed batches);
 * - computeds  = rederived from scratch against the model's atom values;
 * - effects    = must always have last observed the canonical value.
 *
 * Seeds are env-tunable: ROYALE_FUZZ_SEEDS (default 300), ~90 steps each.
 * A failure prints the seed and a greedily shrunk schedule, ready to pin.
 */
import { describe, expect, test } from 'vitest';
import {
	__resetEngine,
	atom,
	computed,
	createBatch,
	effect,
	isPending,
	latest,
	makeWorld,
	readInWorld,
	type Atom,
	type Batch,
	type Computed,
	type World,
} from '../src/index';

const SEEDS = Number(process.env.ROYALE_FUZZ_SEEDS ?? 300);
const STEPS = 90;

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ---- schedule ops (data, so schedules can be replayed and shrunk) -------------

type Op =
	| { kind: 'newAtom'; init: number }
	| { kind: 'newBatch' }
	| { kind: 'set'; atom: number; value: number; batch: number } // batch -1 = urgent
	| { kind: 'update'; atom: number; delta: number; mul: boolean; batch: number }
	| { kind: 'retire'; batch: number }
	| { kind: 'discard'; batch: number }
	| { kind: 'newComputed'; a: number; b: number }
	| { kind: 'newEffect'; target: number } // over atom index
	| { kind: 'disposeEffect'; effect: number }
	| { kind: 'newWorld'; batches: number[] }
	| { kind: 'dropWorld'; world: number }
	| { kind: 'check' };

function generate(rand: () => number, steps: number): Op[] {
	const ops: Op[] = [{ kind: 'newAtom', init: 1 }];
	let atoms = 1;
	let batches = 0;
	let computeds = 0;
	let effects = 0;
	let worlds = 0;
	const pick = (n: number) => Math.floor(rand() * n);
	for (let i = 0; i < steps; i++) {
		const r = rand();
		if (r < 0.08) {
			ops.push({ kind: 'newAtom', init: pick(10) });
			atoms++;
		} else if (r < 0.14) {
			ops.push({ kind: 'newBatch' });
			batches++;
		} else if (r < 0.34) {
			ops.push({
				kind: 'set',
				atom: pick(atoms),
				value: pick(20),
				batch: batches > 0 && rand() < 0.5 ? pick(batches) : -1,
			});
		} else if (r < 0.52) {
			ops.push({
				kind: 'update',
				atom: pick(atoms),
				delta: 1 + pick(3),
				mul: rand() < 0.3,
				batch: batches > 0 && rand() < 0.5 ? pick(batches) : -1,
			});
		} else if (r < 0.6 && batches > 0) {
			ops.push({ kind: 'retire', batch: pick(batches) });
		} else if (r < 0.65 && batches > 0) {
			ops.push({ kind: 'discard', batch: pick(batches) });
		} else if (r < 0.73) {
			ops.push({ kind: 'newComputed', a: pick(atoms), b: pick(atoms + computeds) });
			computeds++;
		} else if (r < 0.79) {
			ops.push({ kind: 'newEffect', target: pick(atoms) });
			effects++;
		} else if (r < 0.82 && effects > 0) {
			ops.push({ kind: 'disposeEffect', effect: pick(effects) });
		} else if (r < 0.88 && batches > 0) {
			const listed: number[] = [];
			for (let b = 0; b < batches; b++) if (rand() < 0.4) listed.push(b);
			ops.push({ kind: 'newWorld', batches: listed });
			worlds++;
		} else if (r < 0.9 && worlds > 0) {
			ops.push({ kind: 'dropWorld', world: pick(worlds) });
		} else {
			ops.push({ kind: 'check' });
		}
	}
	ops.push({ kind: 'check' });
	return ops;
}

// ---- the model -----------------------------------------------------------------

interface MOp {
	id: number;
	batch: number; // -1 urgent
	apply: (v: number) => number;
}

interface MAtom {
	init: number;
	ops: MOp[];
}

interface MWorld {
	listed: number[];
	/** Op ids present and batches retired when the world latched. */
	present: Set<number>;
	retiredAt: Set<number>;
}

class Model {
	atoms: MAtom[] = [];
	retired = new Set<number>();
	discarded = new Set<number>();
	nextOp = 1;

	canonical(i: number): number {
		const a = this.atoms[i];
		let v = a.init;
		for (const op of a.ops) {
			if (op.batch === -1 || this.retired.has(op.batch)) v = op.apply(v);
		}
		return v;
	}

	latest(i: number): number {
		const a = this.atoms[i];
		let v = a.init;
		for (const op of a.ops) {
			if (!this.discarded.has(op.batch)) v = op.apply(v);
		}
		return v;
	}

	pending(i: number): boolean {
		return this.atoms[i].ops.some(
			(op) => op.batch !== -1 && !this.retired.has(op.batch) && !this.discarded.has(op.batch),
		);
	}

	world(i: number, w: MWorld): number {
		const a = this.atoms[i];
		let v = a.init;
		for (const op of a.ops) {
			const visible =
				op.batch === -1
					? w.present.has(op.id)
					: (w.listed.includes(op.batch) && !this.discarded.has(op.batch)) ||
						(w.retiredAt.has(op.batch) && w.present.has(op.id));
			if (visible) v = op.apply(v);
		}
		return v;
	}

	snapshotWorld(listed: number[]): MWorld {
		const present = new Set<number>();
		for (const a of this.atoms) for (const op of a.ops) present.add(op.id);
		return { listed, present, retiredAt: new Set(this.retired) };
	}
}

// ---- run one schedule ------------------------------------------------------------

interface Failure {
	step: number;
	detail: string;
}

function run(ops: Op[]): Failure | null {
	__resetEngine();
	const model = new Model();
	const eAtoms: Atom<number>[] = [];
	const eBatches: Batch[] = [];
	const eComputeds: Computed<number>[] = [];
	/** Node refs frozen at creation: ['a', i] an atom, ['c', i] a computed. */
	const mComputeds: Array<{ a: ['a' | 'c', number]; b: ['a' | 'c', number] }> = [];
	const eEffects: Array<{ dispose: () => void; last: () => number; target: number; live: boolean }> =
		[];
	const eWorlds: Array<{ w: World; m: MWorld; live: boolean }> = [];

	const mRefValue = (ref: ['a' | 'c', number], worldOf?: MWorld): number => {
		if (ref[0] === 'a') return worldOf ? model.world(ref[1], worldOf) : model.canonical(ref[1]);
		const c = mComputeds[ref[1]];
		return mRefValue(c.a, worldOf) + mRefValue(c.b, worldOf);
	};

	const check = (step: number): Failure | null => {
		for (let i = 0; i < eAtoms.length; i++) {
			const got = eAtoms[i].peek();
			const want = model.canonical(i);
			if (got !== want) return { step, detail: `atom${i} canonical: got ${got} want ${want}` };
			const gotLatest = latest(eAtoms[i]);
			const wantLatest = model.latest(i);
			if (gotLatest !== wantLatest) {
				return { step, detail: `atom${i} latest: got ${gotLatest} want ${wantLatest}` };
			}
			if (isPending(eAtoms[i]) !== model.pending(i)) {
				return { step, detail: `atom${i} isPending: got ${isPending(eAtoms[i])}` };
			}
		}
		for (let ci = 0; ci < eComputeds.length; ci++) {
			const got = eComputeds[ci].peek();
			const want = mRefValue(['c', ci]);
			if (got !== want) return { step, detail: `computed${ci}: got ${got} want ${want}` };
		}
		for (const ew of eWorlds) {
			if (!ew.live) continue;
			for (let i = 0; i < eAtoms.length; i++) {
				const got = readInWorld(eAtoms[i], ew.w) as number;
				const want = model.world(i, ew.m);
				if (got !== want) {
					return {
						step,
						detail: `atom${i} world[${ew.m.listed.join(',')}]: got ${got} want ${want}`,
					};
				}
			}
			for (let ci = 0; ci < eComputeds.length; ci++) {
				const got = readInWorld(eComputeds[ci], ew.w) as number;
				const want = mRefValue(['c', ci], ew.m);
				if (got !== want) {
					return { step, detail: `computed${ci} in world: got ${got} want ${want}` };
				}
			}
		}
		for (const ee of eEffects) {
			if (!ee.live) continue;
			const want = model.canonical(ee.target);
			if (ee.last() !== want) {
				return { step, detail: `effect over atom${ee.target}: saw ${ee.last()} want ${want}` };
			}
		}
		return null;
	};

	for (let step = 0; step < ops.length; step++) {
		const op = ops[step];
		try {
			switch (op.kind) {
				case 'newAtom': {
					eAtoms.push(atom(op.init));
					model.atoms.push({ init: op.init, ops: [] });
					break;
				}
				case 'newBatch': {
					eBatches.push(createBatch());
					break;
				}
				case 'set':
				case 'update': {
					if (op.atom >= eAtoms.length) break;
					const apply =
						op.kind === 'set'
							? () => (op as { value: number }).value
							: op.mul
								? (v: number) => v * (op as { delta: number }).delta
								: (v: number) => v + (op as { delta: number }).delta;
					const doWrite = () => {
						if (op.kind === 'set') eAtoms[op.atom].set(op.value);
						else eAtoms[op.atom].update(apply);
					};
					if (op.batch >= 0 && op.batch < eBatches.length) {
						const b = eBatches[op.batch];
						if (b.state === 0) {
							b.run(doWrite);
							model.atoms[op.atom].ops.push({ id: model.nextOp++, batch: op.batch, apply });
							break;
						}
					}
					doWrite();
					model.atoms[op.atom].ops.push({ id: model.nextOp++, batch: -1, apply });
					break;
				}
				case 'retire': {
					if (op.batch >= eBatches.length) break;
					const b = eBatches[op.batch];
					if (b.state !== 0) break;
					b.retire();
					model.retired.add(op.batch);
					break;
				}
				case 'discard': {
					if (op.batch >= eBatches.length) break;
					const b = eBatches[op.batch];
					if (b.state !== 0) break;
					b.discard();
					model.discarded.add(op.batch);
					break;
				}
				case 'newComputed': {
					const aIdx = Math.min(op.a, eAtoms.length - 1);
					const bTotal = eAtoms.length + eComputeds.length;
					const bIdx = Math.min(op.b, bTotal - 1);
					const aRef: ['a' | 'c', number] = ['a', aIdx];
					const bRef: ['a' | 'c', number] =
						bIdx < eAtoms.length ? ['a', bIdx] : ['c', bIdx - eAtoms.length];
					const aNode = eAtoms[aIdx];
					const bNode = bRef[0] === 'a' ? eAtoms[bRef[1]] : eComputeds[bRef[1]];
					const c = computed(() => (aNode.get() as number) + (bNode.get() as number));
					eComputeds.push(c);
					mComputeds.push({ a: aRef, b: bRef });
					break;
				}
				case 'newEffect': {
					if (op.target >= eAtoms.length) break;
					let last = NaN;
					const dispose = effect(() => {
						last = eAtoms[op.target].get();
					});
					eEffects.push({ dispose, last: () => last, target: op.target, live: true });
					break;
				}
				case 'disposeEffect': {
					const e = eEffects[op.effect];
					if (e !== undefined && e.live) {
						e.dispose();
						e.live = false;
					}
					break;
				}
				case 'newWorld': {
					const ids = op.batches
						.filter((b) => b < eBatches.length && eBatches[b].state === 0)
						.map((b) => eBatches[b].id);
					const listed = op.batches.filter((b) => b < eBatches.length && eBatches[b].state === 0);
					eWorlds.push({ w: makeWorld(ids), m: model.snapshotWorld(listed), live: true });
					break;
				}
				case 'dropWorld': {
					const ew = eWorlds[op.world];
					if (ew !== undefined && ew.live) {
						ew.w.release();
						ew.live = false;
					}
					break;
				}
				case 'check': {
					const f = check(step);
					if (f !== null) return f;
					break;
				}
			}
		} catch (e) {
			return { step, detail: `threw at ${op.kind}: ${String(e)}` };
		}
	}
	return null;
}

/** Greedy shrink: drop ops one at a time while the schedule still fails. */
function shrink(ops: Op[]): Op[] {
	let cur = ops;
	let changed = true;
	while (changed) {
		changed = false;
		for (let i = cur.length - 1; i >= 0; i--) {
			if (cur[i].kind === 'check') continue;
			const candidate = cur.slice(0, i).concat(cur.slice(i + 1));
			const f = run(candidate);
			if (f !== null && !f.detail.startsWith('threw')) {
				cur = candidate;
				changed = true;
			}
		}
	}
	return cur;
}

describe(`oracle fuzz (${SEEDS} seeds x ${STEPS} steps)`, () => {
	test('engine matches the naive fold model', () => {
		for (let seed = 1; seed <= SEEDS; seed++) {
			const ops = generate(mulberry32(seed), STEPS);
			const failure = run(ops);
			if (failure !== null) {
				const small = shrink(ops);
				const rerun = run(small);
				throw new Error(
					`seed ${seed} failed at step ${failure.step}: ${failure.detail}\n` +
						`shrunk schedule (${small.length} ops, fails with: ${rerun?.detail}):\n` +
						JSON.stringify(small),
				);
			}
		}
		__resetEngine();
		expect(true).toBe(true);
	});
});
