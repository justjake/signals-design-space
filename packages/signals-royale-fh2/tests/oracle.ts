/**
 * The oracle: a naive, memo-free model of this engine's semantics.
 *
 * Atoms are write histories: one global insertion-ordered log of
 * operations, each owned by a draft batch or canonical (urgent). A value in
 * any world is a pure fold of the log: include canonical operations plus
 * the operations of the world's batches; a retired batch's operations are
 * canonical; a discarded batch's operations vanish. Computeds are formulas
 * re-derived from scratch on every question. Equality drops replicate the
 * engine's write-time rule (a set equal to its own world's current fold is
 * dropped) so the histories stay aligned.
 */

export type ModelOp = {
	atom: number;
	batch: number; // 0 = canonical (urgent)
	set?: number;
	update?: (prev: number) => number;
};

export interface ModelAtom {
	initial: number;
	equals: (a: number, b: number) => boolean;
}

export class Model {
	atoms: ModelAtom[] = [];
	log: ModelOp[] = [];
	open = new Set<number>();
	retired = new Set<number>();
	discarded = new Set<number>();
	nextBatch = 1;

	addAtom(initial: number, equals?: (a: number, b: number) => boolean): number {
		this.atoms.push({ initial, equals: equals ?? Object.is });
		return this.atoms.length - 1;
	}

	openBatch(): number {
		const id = this.nextBatch++;
		this.open.add(id);
		return id;
	}

	retire(id: number): void {
		this.open.delete(id);
		this.retired.add(id);
	}

	discard(id: number): void {
		this.open.delete(id);
		this.discarded.add(id);
		this.log = this.log.filter((op) => op.batch !== id);
	}

	/** The fold of atom `i` visible to `batches` (plus canonical). Steps are
	 * equality-gated exactly like the engine's canonical writes. */
	valueIn(i: number, batches: ReadonlySet<number>): number {
		const equals = this.atoms[i]!.equals;
		let v = this.atoms[i]!.initial;
		for (const op of this.log) {
			if (op.atom !== i) {
				continue;
			}
			if (op.batch === 0 || this.retired.has(op.batch) || batches.has(op.batch)) {
				const next = op.update !== undefined ? op.update(v) : op.set!;
				if (!equals(v, next)) {
					v = next;
				}
			}
		}
		return v;
	}

	canonical(i: number): number {
		return this.valueIn(i, EMPTY);
	}

	latest(i: number): number {
		return this.valueIn(i, this.open);
	}

	isPending(i: number): boolean {
		for (const op of this.log) {
			if (op.atom === i && op.batch !== 0 && this.open.has(op.batch)) {
				return true;
			}
		}
		return false;
	}

	/** Mirrors the engine's write-time equality drop, then records. */
	write(op: ModelOp): void {
		if (op.update === undefined) {
			const world = op.batch === 0 ? EMPTY : new Set([op.batch]);
			const current = this.valueIn(op.atom, world);
			if (this.atoms[op.atom]!.equals(current, op.set!)) {
				return; // dropped
			}
		}
		this.log.push(op);
	}
}

const EMPTY: ReadonlySet<number> = new Set();

/** mulberry32: a tiny deterministic PRNG for reproducible schedules. */
export function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
