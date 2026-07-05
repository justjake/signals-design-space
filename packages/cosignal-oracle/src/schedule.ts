/**
 * Seeded random schedule generator + runner (spec §8: "driven by randomized
 * schedules — interleaved batches, yields, retirements, mounts, forced-small
 * counters"). Hand-rolled PRNG with explicit seed logging; shrinking by
 * op-removal replay.
 *
 * Ops reference entities by creation index, so a shrunk op list replays
 * meaningfully: an op whose referent is missing or illegal at replay time is
 * skipped (the model's guard clauses throw ScheduleError before mutating).
 */

import { checkInvariants } from './invariants.js';
import {
	CosignalModel,
	InvariantViolation,
	ScheduleError,
	type AtomNode,
	type Op,
	type Priority,
	type Value,
} from './model.js';

/** mulberry32 — small, fast, seedable. */
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

export type WriteKind = 'set' | 'inc' | 'double' | 'equalNewest' | 'dispatch';

export type ScheduleOp =
	| { t: 'open'; priority: Priority; action: boolean }
	| { t: 'write'; token: number; atom: number; kind: WriteKind; value: number }
	| { t: 'bareWrite'; atom: number; kind: WriteKind; value: number }
	| { t: 'scopeWrite'; token: number; atom: number; value: number }
	| { t: 'settle'; token: number; committed: boolean }
	| { t: 'retire'; token: number; committed: boolean }
	| { t: 'passStart'; root: string; include: number[] }
	| { t: 'yield'; pass: number }
	| { t: 'resume'; pass: number }
	| { t: 'end'; pass: number; kind: 'commit' | 'discard'; retireAtCommit: number[] }
	| { t: 'mount'; pass: number; node: number }
	| { t: 'render'; pass: number; watcher: number }
	| { t: 'reactEffect'; root: string; node: number }
	| { t: 'coreEffect'; node: number }
	| { t: 'discardAllWip' }
	| { t: 'quiesce' };

const ROOTS = ['A', 'B'];

/**
 * The fixed topology every schedule runs over: the world-divergent flag-flip
 * family (§6 case 1), a diamond, a chain, an untracked mix, and a reducer.
 */
export function buildTopology(m: CosignalModel) {
	const flag = m.atom('flag', 0);
	const a = m.atom('a', 0);
	const b = m.atom('b', 0);
	const r = m.reducerAtom('r', (s, act) => {
		if (act === 'inc') return (s as number) + 1;
		if (act === 'noop') return s;
		return (s as number) * 2;
	}, 0);
	const cFlip = m.computed('cFlip', (read) => (read(flag) ? read(a) : read(b)));
	const cSum = m.computed('cSum', (read) => (read(a) as number) + (read(b) as number) + (read(r) as number));
	const cChain = m.computed('cChain', (read) => (read(cFlip) as number) + 10);
	const cMix = m.computed('cMix', (read, untracked) => (read(b) as number) + (untracked(a) as number));
	return { atoms: [flag, a, b, r], computeds: [cFlip, cSum, cChain, cMix] };
}

export type RunResult = {
	model: CosignalModel;
	/** Ops actually applied (illegal proposals are skipped). */
	applied: ScheduleOp[];
	/** Set when an InvariantViolation (or unexpected error) fired; schedule errors are skips, not failures. */
	failure: { error: Error; step: number } | undefined;
};

/**
 * Apply ONE schedule op to a model already holding the fixed topology.
 * Returns true if applied, false if the op was illegal in the current state
 * (ScheduleError — a skip, never a failure). Any other error propagates.
 * Exported for the engine-adapter harness (src/adapter.ts).
 */
export function applyOneOp(m: CosignalModel, op: ScheduleOp): boolean {
	const allNodes = [...m.nodes.values()];
	const atoms = allNodes.filter((n): n is AtomNode => n.kind === 'atom').slice(0, 4);
	const nodes = allNodes.slice(0, 8);
	const writeOp = (kind: WriteKind, value: number, atomIdx: number): Op => {
		switch (kind) {
			case 'set': return { kind: 'set', value };
			case 'inc': return { kind: 'update', fn: (p) => (p as number) + 1 };
			case 'double': return { kind: 'update', fn: (p) => (p as number) * 2 };
			case 'equalNewest': return { kind: 'set', value: m.newestValue(atoms[atomIdx]!) };
			case 'dispatch': return { kind: 'dispatch', action: value % 2 === 0 ? 'inc' : 'noop' };
		}
	};
	const uniq = `${m.events.length}.${m.seq}.${m.epoch}`;
	try {
		switch (op.t) {
			case 'open': m.openBatch(op.priority, { action: op.action }); break;
			case 'write': {
				const atom = atoms[op.atom % atoms.length]!;
				const kind: WriteKind = atom.reducer !== undefined && op.kind !== 'equalNewest' ? 'dispatch' : op.kind === 'dispatch' ? 'set' : op.kind;
				m.write(tokenAt(m, op.token), atom, writeOp(kind, op.value, op.atom % atoms.length));
				break;
			}
			case 'bareWrite': {
				const atom = atoms[op.atom % atoms.length]!;
				const kind: WriteKind = atom.reducer !== undefined ? 'dispatch' : op.kind === 'dispatch' ? 'set' : op.kind;
				m.bareWrite(atom, writeOp(kind, op.value, op.atom % atoms.length));
				break;
			}
			case 'scopeWrite': {
				const atom = atoms[op.atom % atoms.length]!;
				const o: Op = atom.reducer !== undefined ? { kind: 'dispatch', action: 'inc' } : { kind: 'set', value: op.value };
				m.scopeWrite(tokenAt(m, op.token)!, atom, o);
				break;
			}
			case 'settle': m.settleAction(tokenAt(m, op.token)!, op.committed); break;
			case 'retire': m.retire(tokenAt(m, op.token)!, op.committed); break;
			case 'passStart': m.passStart(op.root, op.include.map((i) => tokenAt(m, i)!)); break;
			case 'yield': m.passYield(passAt(m, op.pass)); break;
			case 'resume': m.passResume(passAt(m, op.pass)); break;
			case 'end': m.passEnd(passAt(m, op.pass), op.kind, { retireAtCommit: op.retireAtCommit.map((i) => tokenAt(m, i)!) }); break;
			case 'mount': m.mountWatcher(passAt(m, op.pass), nodes[op.node % nodes.length]!, `W${uniq}`); break;
			case 'render': m.renderWatcher(passAt(m, op.pass), watcherAt(m, op.watcher)); break;
			case 'reactEffect': m.mountReactEffect(op.root, nodes[op.node % nodes.length]!, `E${uniq}`); break;
			case 'coreEffect': m.mountCoreEffect(nodes[op.node % nodes.length]!, `CE${uniq}`); break;
			case 'discardAllWip': m.discardAllWip(); break;
			case 'quiesce': m.quiesce(); break;
		}
		return true;
	} catch (err) {
		if (err instanceof ScheduleError) return false;
		throw err;
	}
}

/** Replay a concrete op list. Invariants run after every applied step when `check` is set. */
export function runSchedule(ops: ScheduleOp[], check: boolean): RunResult {
	const m = new CosignalModel();
	buildTopology(m);
	m.registerBridge();
	const applied: ScheduleOp[] = [];
	for (let step = 0; step < ops.length; step++) {
		const op = ops[step]!;
		try {
			if (applyOneOp(m, op)) {
				applied.push(op);
				if (check) checkInvariants(m);
			}
		} catch (err) {
			return { model: m, applied, failure: { error: err as Error, step } };
		}
	}
	return { model: m, applied, failure: undefined };
}

function tokenAt(m: CosignalModel, index: number): number | undefined {
	const ids = [...m.tokens.keys()];
	if (ids.length === 0) throw new ScheduleError('no tokens yet');
	return ids[index % ids.length];
}

function passAt(m: CosignalModel, index: number): number {
	const ids = [...m.passes.keys()];
	if (ids.length === 0) throw new ScheduleError('no passes yet');
	return ids[index % ids.length]!;
}

function watcherAt(m: CosignalModel, index: number): number {
	const ids = [...m.watchers.keys()];
	if (ids.length === 0) throw new ScheduleError('no watchers yet');
	return ids[index % ids.length]!;
}

/** Generate a schedule for a seed. Purely a function of (seed, steps). */
export function generateSchedule(seed: number, steps: number): ScheduleOp[] {
	const rand = rng(seed);
	const pick = (n: number) => Math.floor(rand() * n);
	const bool = (p: number) => rand() < p;
	const ops: ScheduleOp[] = [];
	const priorities: Priority[] = ['urgent', 'default', 'deferred'];
	const kinds: WriteKind[] = ['set', 'set', 'inc', 'double', 'equalNewest', 'dispatch'];
	for (let i = 0; i < steps; i++) {
		const roll = rand();
		if (roll < 0.08) ops.push({ t: 'open', priority: priorities[pick(3)]!, action: bool(0.25) });
		else if (roll < 0.34) {
			const token = pick(34);
			ops.push({ t: 'write', token, atom: pick(4), kind: kinds[pick(kinds.length)]!, value: pick(10) });
			// same-token bursts exercise the per-(watcher, slot) dedup and the
			// pass-aware suppression rule (§5.9) far more often than uniform picks
			while (bool(0.4)) ops.push({ t: 'write', token, atom: pick(4), kind: kinds[pick(kinds.length)]!, value: pick(10) });
		}
		else if (roll < 0.38) ops.push({ t: 'bareWrite', atom: pick(4), kind: kinds[pick(kinds.length)]!, value: pick(10) });
		else if (roll < 0.41) ops.push({ t: 'scopeWrite', token: pick(34), atom: pick(4), value: pick(10) });
		else if (roll < 0.45) ops.push({ t: 'settle', token: pick(34), committed: bool(0.7) });
		else if (roll < 0.55) ops.push({ t: 'retire', token: pick(34), committed: bool(0.7) });
		else if (roll < 0.64) {
			const include: number[] = [];
			const n = pick(3);
			for (let k = 0; k < n; k++) include.push(pick(34));
			// the interleaved-delivery shape (§5.9): arm the (watcher, slot) bit
			// pre-pin, open a pass including that slot, then write post-pin
			if (include.length > 0 && bool(0.5)) {
				ops.push({ t: 'write', token: include[0]!, atom: pick(4), kind: 'set', value: pick(10) });
				ops.push({ t: 'passStart', root: ROOTS[pick(2)]!, include });
				ops.push({ t: 'write', token: include[0]!, atom: pick(4), kind: 'set', value: pick(10) });
			} else {
				ops.push({ t: 'passStart', root: ROOTS[pick(2)]!, include });
			}
		} else if (roll < 0.68) ops.push({ t: 'yield', pass: pick(20) });
		else if (roll < 0.72) ops.push({ t: 'resume', pass: pick(20) });
		else if (roll < 0.82) {
			const retireAtCommit: number[] = [];
			if (bool(0.3)) retireAtCommit.push(pick(34));
			ops.push({ t: 'end', pass: pick(20), kind: bool(0.75) ? 'commit' : 'discard', retireAtCommit });
		} else if (roll < 0.88) {
			ops.push({ t: 'mount', pass: pick(20), node: pick(8) });
			if (bool(0.5)) ops.push({ t: 'render', pass: pick(20), watcher: pick(10) });
		}
		else if (roll < 0.91) ops.push({ t: 'render', pass: pick(20), watcher: pick(10) });
		else if (roll < 0.94) ops.push({ t: 'reactEffect', root: ROOTS[pick(2)]!, node: pick(8) });
		else if (roll < 0.96) ops.push({ t: 'coreEffect', node: pick(8) });
		else if (roll < 0.98) ops.push({ t: 'discardAllWip' });
		else ops.push({ t: 'quiesce' });
	}
	// Close out: retire everything then quiesce, so residue/renumber rules run on most seeds.
	for (let tokenIdx = 0; tokenIdx < 34; tokenIdx++) {
		ops.push({ t: 'discardAllWip' });
		ops.push({ t: 'settle', token: tokenIdx, committed: true });
		ops.push({ t: 'retire', token: tokenIdx, committed: bool(0.5) });
	}
	ops.push({ t: 'quiesce' });
	return ops;
}

/** Deterministic fingerprint of everything observable (for the double-run determinism check). */
export function fingerprint(result: RunResult): string {
	const m = result.model;
	const values: Record<string, Value> = {};
	for (const n of m.nodes.values()) {
		values[`newest:${n.name}`] = m.newestValue(n);
		for (const root of m.roots.keys()) values[`committed:${root}:${n.name}`] = m.committedValue(n, root);
	}
	return JSON.stringify({ events: m.events, values });
}

export type FuzzOutcome = {
	seed: number;
	failure: { error: Error; step: number; shrunk: ScheduleOp[] } | undefined;
};

/** Run one seed with invariants after every step; shrink on failure. */
export function fuzzSeed(seed: number, steps: number): FuzzOutcome {
	const ops = generateSchedule(seed, steps);
	const result = runSchedule(ops, true);
	if (result.failure === undefined) return { seed, failure: undefined };
	const shrunk = shrink(ops, (candidate) => runSchedule(candidate, true).failure !== undefined);
	return { seed, failure: { ...result.failure, shrunk } };
}

/** Greedy op-removal shrinking: keep removing ops while the failure reproduces. */
export function shrink(ops: ScheduleOp[], failing: (ops: ScheduleOp[]) => boolean): ScheduleOp[] {
	let current = ops;
	let progress = true;
	while (progress) {
		progress = false;
		// Try halves first (fast), then single removals.
		for (const chunk of [Math.ceil(current.length / 2), Math.ceil(current.length / 4), 1]) {
			for (let i = 0; i + chunk <= current.length; i += chunk) {
				const candidate = [...current.slice(0, i), ...current.slice(i + chunk)];
				if (candidate.length < current.length && failing(candidate)) {
					current = candidate;
					progress = true;
					break;
				}
			}
			if (progress) break;
		}
	}
	return current;
}

/** Assertion helper for tests: fail loudly with the seed and shrunk schedule. */
export function expectSeedClean(seed: number, steps: number): void {
	const outcome = fuzzSeed(seed, steps);
	if (outcome.failure !== undefined) {
		const { error, shrunk } = outcome.failure;
		throw new InvariantViolation(
			`seed ${seed} failed: ${error.message}\nshrunk schedule (${shrunk.length} ops):\n${JSON.stringify(shrunk)}`,
		);
	}
}
