/**
 * THE ARMED DIVERGENCE CHECKER + STRUCTURAL VALIDATOR (test-side
 * machinery — the engine keeps only the narrow `__checkerInternals`
 * window and the fold-truth frame discipline). Armed by the test harness — the lockstep driver, the fuzz-corpus
 * adapter, and the arena suites — via `armArenaCheck`; production installs
 * nothing and pays one undefined test per operation epilogue.
 *
 * The check: for every live arena, serve every
 * shadow from the arena (its own walks — the arena side runs first, pinning
 * the discipline that a stale shadow must not be refreshed by the reference
 * side) and compare against fold-truth — a naive, cache-free re-derivation
 * of the same node in the same world (atoms fold their write logs; computed fns
 * re-run over naive readers; memoized per check pass, since fold-truth
 * depends only on write log/membership state the serves never mutate). ANY
 * divergence throws — a lockstep test failure, the stage's STOP condition.
 * The newest world is pinned separately (K0 parity in the twin's verify).
 */
import {
	InvariantViolation,
	type AnyInternals,
	type ArenaCheckerInternals,
	type CosignalEngine,
	type Reader,
	type WorldArena,
	type Value,
	type World,
} from '../src/concurrent.js';
import { SuspendedRead } from '../src/index.js';
import { engineEpoch } from '../src/CosignalEngine.js';

/** One memoized naive outcome (thrown outcomes memoize and rethrow,
 * identity-stable — same payload object every consult within a check). */
type NaiveOutcome = { threw: boolean; v: Value };

/** Per-composition checker state, held OUTSIDE the engine. */
type CheckerState = {
	readonly bridge: CosignalEngine;
	readonly views: ArenaCheckerInternals;
	/** The engine epoch this state was built against — `__resetEngineForTest`
	 * re-composes the engine, so cached internals (the old core's brackets)
	 * must rebuild when the epoch moves. */
	readonly epoch: number;
	/** Re-entry latch (one check at a time; a serve inside the check can
	 * run user fns, and nothing they reach may start a nested check). */
	checking: boolean;
	/** Naive-evaluation stack for per-check cycle detection. Keyed by node
	 * OBJECT: NodeIds are kernel record ids and recycle, so a dead tenant's
	 * fn (reachable through a stale reference) must not collide with the
	 * record's new tenant. */
	readonly naiveStack: Set<AnyInternals>;
};

const states = new WeakMap<CosignalEngine, CheckerState>();

function stateFor(b: CosignalEngine): CheckerState {
	let st = states.get(b);
	if (st === undefined || st.epoch !== engineEpoch) {
		st = { bridge: b, views: b.__checkerInternals(), epoch: engineEpoch, checking: false, naiveStack: new Set() };
		states.set(b, st);
	}
	return st;
}

/**
 * Arm the S-A dual-bookkeeping divergence check on a bridge: every public
 * operation's epilogue (after its settlement fixed point) runs one full
 * check pass. Idempotent; stays armed for the bridge's life.
 */
export function armArenaCheck(b: CosignalEngine): void {
	const st = stateFor(b);
	st.views.armEpilogueCheck(() => runCheck(st));
}

/** One immediate check pass (the twin driver's per-op referee call site).
 * A no-op inside an open evaluation frame or fold callback, exactly like
 * the armed epilogue form. */
export function checkArenas(b: CosignalEngine): void {
	runCheck(stateFor(b));
}

function runCheck(st: CheckerState): void {
	const v = st.views;
	if (st.checking || v.evalDepth > 0 || v.inFoldCallback) return;
	st.checking = true;
	try {
		v.holdOp(() => {
			v.eachArena((a) => {
				validateArena(v, a);
				const naiveMemo = new Map<AnyInternals, NaiveOutcome>(); // object-keyed: record ids recycle
				for (let nid = 0; nid < a.nodeToShadow.length; nid++) {
					const sh = a.nodeToShadow[nid] ?? 0;
					if (sh === 0) continue;
					const node = v.internalsAt(nid);
					if (node === undefined) continue;
					// The arena answer is computed BEFORE the fold-truth side runs:
					// folding first could refresh the very state under measurement.
					let aVal: Value;
					let aThrew: unknown;
					let aDidThrow = false;
					try {
						aVal = v.serve(a, node);
					} catch (err) {
						aDidThrow = true;
						aThrew = err;
					}
					let mVal: Value;
					let mThrew: unknown;
					let mDidThrow = false;
					try {
						mVal = naiveValue(st, node, a.world, naiveMemo);
					} catch (err) {
						mDidThrow = true;
						mThrew = err;
					}
					if (aDidThrow !== mDidThrow) {
						throw new InvariantViolation(
							`arena divergence: ${node.name} in ${a.kind} world of ${a.root}: arena ${aDidThrow ? `threw ${String(aThrew)}` : `served ${String(aVal!)}`} but fold-truth ${mDidThrow ? `threw ${String(mThrew)}` : `served ${String(mVal!)}`}`,
						);
					}
					if (aDidThrow) {
						if (String(aThrew) !== String(mThrew)) {
							throw new InvariantViolation(`arena divergence: ${node.name} in ${a.kind} world of ${a.root}: arena threw ${String(aThrew)} but fold-truth threw ${String(mThrew)}`);
						}
					} else {
						// A custom-equality computed's arena slot keeps
						// the previous reference on comparator-equal refolds — correct
						// exactly when the retained value is equal by the node's own
						// comparator to the naive re-fold (the kernel slot keeps old
						// references under the same policy). Default nodes compare by
						// identity, bit for bit.
						const ceq = node.kind === 'computed' && node.isEqual !== undefined
							&& !(aVal instanceof SuspendedRead) && !(mVal instanceof SuspendedRead)
							? node.isEqual : undefined; // sentinels compare by identity (16d), never through user comparators
						const same = ceq === undefined ? Object.is(aVal!, mVal!) : v.runInFoldCallback(() => ceq(aVal!, mVal!));
						if (!same) {
							throw new InvariantViolation(
								`arena divergence: ${node.name} in ${a.kind} world of ${a.root}: arena-served ${String(aVal!)} ≠ fold-truth ${String(mVal!)}`,
							);
						}
					}
				}
				// Deliberately NO list compaction here: consumed entries stay
				// listed until the next boundary's decay — the drain's seed
				// coverage stands on that persistence (compacting at the armed
				// epilogue was tried and cost a drain its candidates: the
				// armed corpus caught the missed correction, seed 173).
			});
		});
	} finally {
		st.checking = false;
	}
}

/**
 * Fold-truth (the check's reference side): a naive, cache-free evaluation —
 * atoms replay their write logs (the bridge's public `foldAtom`, the same fold
 * every world serve is defined against); computed fns re-run with naive
 * readers (tracked ≡ untracked: structure is not being recorded) inside the
 * engine's fold-truth frame, so raw-handle reads inside fns fold plain too
 * and nothing routes back into the arena under check. Thrown outcomes
 * memoize and rethrow (identity-stable).
 */
function naiveValue(st: CheckerState, node: AnyInternals, world: World, memo: Map<AnyInternals, NaiveOutcome>): Value {
	if (node.kind === 'atom') return st.bridge.foldAtom(node, world);
	const hit = memo.get(node);
	if (hit !== undefined) {
		if (hit.threw) throw hit.v;
		return hit.v;
	}
	if (st.naiveStack.has(node)) {
		throw st.views.createCycleError(node.name);
	}
	st.naiveStack.add(node);
	const reader: Reader = (dep) => naiveValue(st, dep, world, memo);
	try {
		const v = st.views.runInFoldTruthFrame(world, () => node.fn(reader, reader));
		memo.set(node, { threw: false, v });
		return v;
	} catch (err) {
		memo.set(node, { threw: true, v: err });
		throw err;
	} finally {
		st.naiveStack.delete(node);
	}
}

/**
 * Structural validator: link-list
 * symmetry, suspended-list density/index integrity, dirty-list coverage,
 * GEN tenancy, cycle caps. Throws on corruption. Reads the arena's raw
 * Int32 words through the layout view (the engine's field offsets and flag
 * bits are same-file const enums; the view carries their values as data).
 */
function validateArena(v: ArenaCheckerInternals, a: WorldArena): void {
	const { ArenaGeom, ArenaField, ArenaLinkField, ArenaLinkMode, ArenaFlag } = v.layout;
	const memory = a.memory;
	const CAP = 100_000;
	let suspSeen = 0;
	for (let nid = 0; nid < a.nodeToShadow.length; nid++) {
		const sh = a.nodeToShadow[nid] ?? 0;
		if (sh === 0) continue;
		if (memory[sh + ArenaField.NODE] !== nid) throw new InvariantViolation(`arena ${a.root}: shadow ${sh} NODE column diverged`);
		// A dead-GEN shadow is legal cold residue: the invariant is
		// that it never serves — enforced at resolveShadow (re-tenant on consult),
		// which every serve/link path routes through. No assert here.
		const flags = memory[sh + ArenaField.FLAGS]!;
		if ((flags & ArenaFlag.BOX_SUSPENDED) !== 0) {
			const slot = a.suspIdx[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT]!;
			if (slot === 0 || a.suspended[slot - 1] !== sh) throw new InvariantViolation(`arena ${a.root}: suspended-list index integrity broken for shadow ${sh}`);
			suspSeen++;
		} else if ((a.suspIdx[sh >> ArenaGeom.ID_TO_COLUMN_SHIFT] ?? 0) !== 0) {
			throw new InvariantViolation(`arena ${a.root}: shadow ${sh} holds a suspended index without the bit`);
		}
		if ((flags & ArenaFlag.DIRTY) !== 0 && !a.dirty.includes(sh)) {
			throw new InvariantViolation(`arena ${a.root}: DIRTY shadow ${sh} missing from the dirty list`);
		}
		// deps list symmetry
		let cur = memory[sh + ArenaField.DEPS]!;
		let prev = 0;
		let steps = 0;
		while (cur !== 0) {
			if (++steps > CAP) throw new InvariantViolation(`arena ${a.root}: deps list of shadow ${sh} exceeds ${CAP} steps (cycle)`);
			if (memory[cur + ArenaLinkField.SUB] !== sh) throw new InvariantViolation(`arena ${a.root}: link ${cur} SUB != owner`);
			if (memory[cur + ArenaLinkField.PREV_DEP] !== prev) throw new InvariantViolation(`arena ${a.root}: link ${cur} PREV_DEP broken`);
			const dep = memory[cur + ArenaLinkField.DEP]!;
			// Weak symmetry: the link must sit on its MODE's subs list —
			// a weak-flagged link on the strong list (or vice versa) makes
			// this search miss and throw (the segregated-list invariant).
			let s = (memory[cur + ArenaLinkField.MODE]! & ArenaLinkMode.WEAK) !== 0 ? a.weakSubs[dep >> ArenaGeom.ID_TO_COLUMN_SHIFT]! : memory[dep + ArenaField.SUBS]!;
			let found = false;
			let ssteps = 0;
			while (s !== 0) {
				if (++ssteps > CAP) throw new InvariantViolation(`arena ${a.root}: subs list of shadow ${dep} exceeds ${CAP} steps (cycle)`);
				if (s === cur) {
					found = true;
					break;
				}
				s = memory[s + ArenaLinkField.NEXT_SUB]!;
			}
			if (!found) throw new InvariantViolation(`arena ${a.root}: link ${cur} missing from dep subs list (asymmetry)`);
			prev = cur;
			cur = memory[cur + ArenaLinkField.NEXT_DEP]!;
		}
	}
	if (suspSeen !== a.suspended.length) throw new InvariantViolation(`arena ${a.root}: suspended list holds ${a.suspended.length} entries but ${suspSeen} shadows carry the bit`);
}
