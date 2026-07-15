/**
 * Seeded random schedule generator + runner: randomized interleavings of
 * batches, writes, render passes, yields, retirements, and mounts — the
 * schedules concurrent rendering can actually produce, including the ones
 * no hand-written test would think of. Hand-rolled PRNG with explicit seed
 * logging (a failure is reproducible from its seed alone); shrinking by
 * op-removal replay reduces a failure to a minimal schedule.
 *
 * Ops reference entities by creation index, so a shrunk op list replays
 * meaningfully: an op whose referent is missing or illegal at replay time is
 * skipped (the model's guard clauses throw ScheduleError before mutating).
 */

import { checkInvariants } from './invariants.js'
import {
	CosignalModel,
	InvariantViolation,
	ScheduleError,
	type AtomNode,
	type Op,
	type Value,
} from './model.js'

/** mulberry32 — small, fast, seedable. */
export function rng(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a |= 0
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

export type WriteKind = 'set' | 'inc' | 'double' | 'equalNewest'

export type ScheduleOp =
	| { t: 'open'; action: boolean }
	| { t: 'write'; batch: number; atom: number; kind: WriteKind; value: number }
	| { t: 'bareWrite'; atom: number; kind: WriteKind; value: number }
	/**
	 * R-2 corpus coverage: writes targeting the CUSTOM-EQUALS topology
	 * member `q` (asymmetric comparator) — without them, equality order is
	 * lockstep-invisible (no other corpus atom carries custom equality).
	 */
	| { t: 'writeQ'; batch: number; kind: WriteKind; value: number }
	| { t: 'bareWriteQ'; kind: WriteKind; value: number }
	| { t: 'settle'; batch: number }
	| { t: 'retire'; batch: number }
	| { t: 'renderStart'; root: string; include: number[] }
	| { t: 'yield'; renderPass: number }
	| { t: 'resume'; renderPass: number }
	| { t: 'end'; renderPass: number; kind: 'commit' | 'discard'; retireAtCommit: number[] }
	| { t: 'mount'; renderPass: number; node: number }
	| { t: 'render'; renderPass: number; watcher: number }
	| { t: 'reactEffect'; root: string; node: number }
	/**
	 * A committed observer whose body re-chooses deps CAUSALLY:
	 * read(sel) ? read(a) : read(b) — the dep-flip family.
	 */
	| { t: 'reactEffectPick'; root: string; sel: number; a: number; b: number }
	| { t: 'removeReactEffect'; effect: number }
	/** StrictMode-style replay: cleanup + unconditional re-run + recapture. */
	| { t: 'replayReactEffect'; effect: number }
	| { t: 'coreEffect'; node: number }
	/**
	 * R-3 corpus coverage: a WRITING core effect — mounts on a core node and
	 * writes the `out`-indexed effect-output atom per value-gated run (the
	 * write classifies normally: ambient batch while pending, quiet fold at
	 * rest — refereed against the engine's fused-apply effect writes).
	 */
	| { t: 'coreEffectWrite'; node: number; out: number }
	/**
	 * [SANCTIONED CO-EVOLUTION: converged-terminal referee, review finding #8]
	 * The converged-terminal band. `tap`/`sig`/`sib` are a DISJOINT atom
	 * cluster (below), touched only by these ops, so the terminal scenarios
	 * stay acyclic and order-free like out1/out2:
	 *  - mountTermReader: a terminal reading `sig` (dep 0) or `sib` (dep 1);
	 *  - mountTapCore: a core effect reading `tap`, writing `sig` — bug 1's
	 *    cause (a core/quiet-path write to a terminal's dependency);
	 *  - mountSibWriter: a terminal reading `tap`, writing `sib` — bug 2's
	 *    cause (a terminal body writing a sibling terminal's dependency);
	 *  - writeTap: the trigger — a quiet-only bare write to `tap` (the quiet
	 *    write path where the converged terminal's boundary drain lives).
	 */
	| { t: 'mountTermReader'; root: string; dep: number }
	| { t: 'mountTapCore' }
	| { t: 'mountSibWriter'; root: string }
	| { t: 'writeTap'; value: number }
	| { t: 'discardAllWip' }
	| { t: 'quiesce' }

const ROOTS = ['A', 'B']

/**
 * The fixed topology every schedule runs over: a flag-flip computed whose
 * dependency set differs between worlds (the shape most likely to expose
 * cross-world bugs — acceptance scenario case 1), a diamond, a chain, and
 * an untracked-read mix.
 */
/**
 * The custom-equals topology member's comparator (R-2 corpus coverage):
 * ASYMMETRIC on purpose — values are also "equal" when the INCOMING value
 * is exactly current + 10 — so any site invoking it with flipped arguments
 * makes observably different drop/accept decisions, which lockstep then
 * catches. Pure and deterministic (both sides construct their own copy; a
 * STATEFUL counting comparator would be lockstep-illegal — the model
 * re-folds eagerly everywhere while the engine memoizes, so invocation
 * counts legitimately differ across the fold sites; count is pinned by the
 * engine's hand matrix instead — tests/equality-semantics.spec.ts).
 */
export const Q_EQUALS = (a: Value, b: Value): boolean =>
	Object.is(a, b) || (typeof a === 'number' && typeof b === 'number' && b === a + 10)

export function buildTopology(m: CosignalModel) {
	const flag = m.atom('flag', 0)
	const a = m.atom('a', 0)
	const b = m.atom('b', 0)
	const r = m.atom('r', 0)
	const cFlip = m.computed('cFlip', (read) => (read(flag) ? read(a) : read(b)))
	const cSum = m.computed(
		'cSum',
		(read) => (read(a) as number) + (read(b) as number) + (read(r) as number),
	)
	const cChain = m.computed('cChain', (read) => (read(cFlip) as number) + 10)
	const cMix = m.computed(
		'cMix',
		(read, untracked) => (read(b) as number) + (untracked(a) as number),
	)
	// Appended AFTER the core eight so the historical op-index slices
	// (atoms 0..4, nodes 0..8) keep resolving exactly as before:
	//  - q: THE custom-equals member (targeted only by writeQ/bareWriteQ);
	//  - out1/out2: the DISJOINT effect-output subset (written only by
	//    writing core effects; read by nothing in the corpus).
	const q = m.atom('q', 0, Q_EQUALS)
	const out1 = m.atom('out1', 0)
	const out2 = m.atom('out2', 0)
	// [SANCTIONED CO-EVOLUTION: converged-terminal referee, review finding #8]
	// The converged-terminal cluster, appended LAST so every historical
	// op-index slice (atoms 0..4, nodes 0..8, then q/out1/out2) resolves
	// exactly as before. DISJOINT — read/written only by the terminal band's
	// ops — so the scenarios stay acyclic and order-free:
	//  - tap: the trigger; written by writeTap, read by the bug-1 core and the
	//    bug-2 writing terminal;
	//  - sig: the bug-1 terminal dep; written by the bug-1 core, read by a
	//    terminal — the core/quiet-path write to a terminal's dependency;
	//  - sib: the bug-2 sibling dep; written by the bug-2 terminal's body, read
	//    by a terminal — a terminal body writing a sibling's dependency.
	const tap = m.atom('tap', 0)
	const sig = m.atom('sig', 0)
	const sib = m.atom('sib', 0)
	return {
		atoms: [flag, a, b, r],
		computeds: [cFlip, cSum, cChain, cMix],
		q,
		outs: [out1, out2],
		tap,
		sig,
		sib,
	}
}

export type RunResult = {
	model: CosignalModel
	/** Ops actually applied (illegal proposals are skipped). */
	applied: ScheduleOp[]
	/** Set when an InvariantViolation (or unexpected error) fired; schedule errors are skips, not failures. */
	failure: { error: Error; step: number } | undefined
}

/**
 * Apply ONE schedule op to a model already holding the fixed topology.
 * Returns true if applied, false if the op was illegal in the current state
 * (ScheduleError — a skip, never a failure). Any other error propagates.
 * Exported for the engine-adapter harness (src/adapter.ts).
 */
export function applyOneOp(m: CosignalModel, op: ScheduleOp): boolean {
	const allNodes = [...m.idToNode.values()]
	const atoms = allNodes.filter((n): n is AtomNode => n.kind === 'atom').slice(0, 4)
	const nodes = allNodes.slice(0, 8)
	const writeOp = (kind: WriteKind, value: number, atomIdx: number): Op => {
		switch (kind) {
			case 'set':
				return { kind: 'set', value }
			case 'inc':
				return { kind: 'update', fn: (p) => (p as number) + 1 }
			case 'double':
				return { kind: 'update', fn: (p) => (p as number) * 2 }
			case 'equalNewest':
				return { kind: 'set', value: m.newestValue(atoms[atomIdx]) }
		}
	}
	const uniq = `${m.events.length}.${m.seq}.${m.epoch}`
	try {
		const atomNamed = (name: string): AtomNode =>
			allNodes.find((n): n is AtomNode => n.kind === 'atom' && n.name === name)!
		const writeOpFor = (kind: WriteKind, value: number, atom: AtomNode): Op => {
			switch (kind) {
				case 'set':
					return { kind: 'set', value }
				case 'inc':
					return { kind: 'update', fn: (p) => (p as number) + 1 }
				case 'double':
					return { kind: 'update', fn: (p) => (p as number) * 2 }
				case 'equalNewest':
					return { kind: 'set', value: m.newestValue(atom) }
			}
		}
		switch (op.t) {
			case 'open':
				m.openBatch({ action: op.action })
				break
			case 'write': {
				const atom = atoms[op.atom % atoms.length]
				m.write(batchAt(m, op.batch), atom, writeOp(op.kind, op.value, op.atom % atoms.length))
				break
			}
			case 'bareWrite': {
				const atom = atoms[op.atom % atoms.length]
				m.bareWrite(atom, writeOp(op.kind, op.value, op.atom % atoms.length))
				break
			}
			case 'writeQ': {
				const q = atomNamed('q')
				m.write(batchAt(m, op.batch), q, writeOpFor(op.kind, op.value, q))
				break
			}
			case 'bareWriteQ': {
				const q = atomNamed('q')
				m.bareWrite(q, writeOpFor(op.kind, op.value, q))
				break
			}
			case 'settle':
				m.settleAction(batchAt(m, op.batch))
				break
			case 'retire':
				m.retire(batchAt(m, op.batch))
				break
			case 'renderStart':
				m.renderStart(
					op.root,
					op.include.map((i) => batchAt(m, i)),
				)
				break
			case 'yield':
				m.renderYield(renderPassAt(m, op.renderPass))
				break
			case 'resume':
				m.renderResume(renderPassAt(m, op.renderPass))
				break
			case 'end':
				m.renderEnd(renderPassAt(m, op.renderPass), op.kind, {
					retireAtCommit: op.retireAtCommit.map((i) => batchAt(m, i)),
				})
				break
			case 'mount':
				m.mountWatcher(renderPassAt(m, op.renderPass), nodes[op.node % nodes.length], `W${uniq}`)
				break
			case 'render':
				m.renderWatcher(renderPassAt(m, op.renderPass), watcherAt(m, op.watcher))
				break
			case 'reactEffect':
				m.mountReactEffect(op.root, nodes[op.node % nodes.length], `E${uniq}`)
				break
			case 'reactEffectPick':
				m.mountReactEffectPick(
					op.root,
					nodes[op.sel % nodes.length],
					nodes[op.a % nodes.length],
					nodes[op.b % nodes.length],
					`E${uniq}`,
				)
				break
			case 'removeReactEffect':
				m.removeReactEffect(effectAt(m, op.effect))
				break
			case 'replayReactEffect':
				m.replayReactEffect(effectAt(m, op.effect))
				break
			case 'coreEffect':
				m.mountCoreEffect(nodes[op.node % nodes.length], `CE${uniq}`)
				break
			case 'coreEffectWrite': {
				const out = atomNamed(op.out % 2 === 0 ? 'out1' : 'out2')
				// ONE WRITER PER OUTPUT ATOM (acyclic AND order-free by
				// construction): sibling core-effect firing order is
				// implementation-defined, so two writers sharing an output
				// would make its final value order-dependent — the op is
				// illegal (a skip) once the output has a writer, identically
				// on both sides.
				for (const e of m.coreEffects.values()) {
					if (e.writeTo === out) {
						throw new ScheduleError(`output atom ${out.name} already has a writing effect`)
					}
				}
				m.mountCoreEffect(nodes[op.node % nodes.length], `CE${uniq}`, out)
				break
			}
			// [SANCTIONED CO-EVOLUTION: converged-terminal referee, review finding #8]
			case 'mountTermReader': {
				// A committed terminal whose body reads `sig` (dep 0) or `sib`
				// (dep 1) — the downstream side of bugs 1 and 2 respectively. The
				// `#T${k}` ordinal keeps names unique when mounted at rest.
				const dep = atomNamed(op.dep % 2 === 0 ? 'sig' : 'sib')
				m.mountReactEffect(op.root, dep, `E${uniq}#T${m.terminalReactMounts++}`)
				break
			}
			case 'mountTapCore': {
				// A core effect reading `tap`, writing `sig`: the bug-1 cause (a
				// core/quiet-path write to a terminal's dependency). One writer
				// per `sig` (order-freedom), identically to the out1/out2 rule.
				const sig = atomNamed('sig')
				for (const e of m.coreEffects.values()) {
					if (e.writeTo === sig) {
						throw new ScheduleError('sig already has a writing effect')
					}
				}
				m.mountCoreEffect(atomNamed('tap'), `CE${uniq}`, sig)
				break
			}
			case 'mountSibWriter':
				// A terminal reading `tap`, writing `sib`: the bug-2 cause (a
				// terminal body writing a sibling terminal's dependency). Many
				// writers are order-free — each writes min(tap,3), the same value.
				// QUIET-ONLY (like writeTap): mounting while pending would run the
				// body's sib write into a batch, taking the whole scenario off the
				// quiet write path the converged terminal's drain lives on.
				if (!m.isQuiet()) {
					throw new ScheduleError('the writing terminal mounts only on the quiet path')
				}
				m.mountReactEffectWrite(
					op.root,
					atomNamed('tap'),
					atomNamed('sib'),
					`E${uniq}#T${m.terminalReactMounts++}`,
				)
				break
			case 'writeTap': {
				// The trigger — QUIET-ONLY (the converged terminal's boundary
				// drain is the quiet write path; legality decided by isQuiet on
				// both sides). Distinct small values re-fire both families.
				if (!m.isQuiet()) {
					throw new ScheduleError('tap writes only on the quiet path')
				}
				m.bareWrite(atomNamed('tap'), { kind: 'set', value: op.value })
				break
			}
			case 'discardAllWip':
				m.discardAllWip()
				break
			case 'quiesce':
				m.quiesce()
				break
		}
		return true
	} catch (err) {
		if (err instanceof ScheduleError) {
			return false
		}
		throw err
	}
}

/** Replay a concrete op list. Invariants run after every applied step when `check` is set. */
export function runSchedule(ops: ScheduleOp[], check: boolean): RunResult {
	const m = new CosignalModel()
	buildTopology(m)
	const applied: ScheduleOp[] = []
	for (let step = 0; step < ops.length; step++) {
		const op = ops[step]
		try {
			if (applyOneOp(m, op)) {
				applied.push(op)
				if (check) {
					checkInvariants(m)
				}
			}
		} catch (err) {
			return { model: m, applied, failure: { error: err as Error, step } }
		}
	}
	return { model: m, applied, failure: undefined }
}

/**
 * Pick the index-th entity id (mod population) from a model map, or throw
 * the skip signal — the one lookup shape every entity kind shares.
 */
function pickId<K>(map: Map<K, unknown>, index: number, what: string): K {
	const ids = [...map.keys()]
	if (ids.length === 0) {
		throw new ScheduleError(`no ${what} yet`)
	}
	return ids[index % ids.length]
}

const batchAt = (m: CosignalModel, index: number): number => pickId(m.idToBatch, index, 'batches')
const renderPassAt = (m: CosignalModel, index: number): number =>
	pickId(m.idToRenderPass, index, 'render passes')
const watcherAt = (m: CosignalModel, index: number): number => pickId(m.watchers, index, 'watchers')
const effectAt = (m: CosignalModel, index: number): number =>
	pickId(m.reactEffects, index, 'react effects')

/** Generate a schedule for a seed. Purely a function of (seed, steps). */
export function generateSchedule(seed: number, steps: number): ScheduleOp[] {
	const rand = rng(seed)
	const pick = (n: number) => Math.floor(rand() * n)
	const bool = (p: number) => rand() < p
	const ops: ScheduleOp[] = []
	const kinds: WriteKind[] = ['set', 'set', 'inc', 'double', 'equalNewest']
	for (let i = 0; i < steps; i++) {
		const roll = rand()
		if (roll < 0.08) {
			pick(3) // discarded draw — preserves the historical seed stream byte-for-byte (the Priority dimension it fed is deleted; the model never consulted it)
			ops.push({ t: 'open', action: bool(0.25) })
		} else if (roll < 0.34) {
			const batch = pick(34)
			ops.push({
				t: 'write',
				batch,
				atom: pick(4),
				kind: kinds[pick(kinds.length)],
				value: pick(10),
			})
			// same-batch bursts exercise the per-(watcher, slot) dedup and the
			// render-aware suppression rule far more often than uniform picks
			while (bool(0.4)) {
				ops.push({
					t: 'write',
					batch,
					atom: pick(4),
					kind: kinds[pick(kinds.length)],
					value: pick(10),
				})
			}
		} else if (roll < 0.375) {
			ops.push({ t: 'bareWrite', atom: pick(4), kind: kinds[pick(kinds.length)], value: pick(10) })
		}
		// R-2 corpus band: writes targeting the custom-equals member q — the
		// asymmetric comparator's drop/accept decisions referee equality ORDER
		// at every aligned site (added freely post-freeze: the named finding
		// seeds are stored literal schedules now; generator changes cannot
		// touch them).
		else if (roll < 0.38) {
			if (bool(0.6)) {
				ops.push({
					t: 'writeQ',
					batch: pick(34),
					kind: kinds[pick(kinds.length)],
					value: pick(10),
				})
			} else {
				ops.push({ t: 'bareWriteQ', kind: kinds[pick(kinds.length)], value: pick(10) })
			}
		}
		// This band emitted the deleted scope-write op (the action-scope write
		// channel is gone: writes attributed to an action's batch are ordinary
		// writes now). Same three draws, now feeding an ordinary write with
		// the old op's fixed payload shape (kind pinned to 'set') — the seed
		// stream stays byte-for-byte identical, so every other op in every
		// historical schedule is unchanged. Replay legality widens by design:
		// the old op skipped on non-action batches; a write applies to any live
		// batch — both sides of the lockstep harness widen together.
		else if (roll < 0.41) {
			ops.push({ t: 'write', batch: pick(34), atom: pick(4), kind: 'set', value: pick(10) })
		} else if (roll < 0.45) {
			const batch = pick(34)
			bool(0.7) // discarded draw — preserves the historical seed stream byte-for-byte (it fed the deleted settle committed flag; the model never branched on it)
			ops.push({ t: 'settle', batch })
		} else if (roll < 0.55) {
			const batch = pick(34)
			bool(0.7) // discarded draw — same seed-stream preservation for the deleted retire committed flag
			ops.push({ t: 'retire', batch })
		} else if (roll < 0.64) {
			const include: number[] = []
			const n = pick(3)
			for (let k = 0; k < n; k++) {
				include.push(pick(34))
			}
			// the interleaved-delivery shape: arm the (watcher, slot) dedup bit
			// pre-pin, open a render including that slot, then write post-pin —
			// the started render cannot fold the write, so it must re-deliver
			if (include.length > 0 && bool(0.5)) {
				ops.push({ t: 'write', batch: include[0], atom: pick(4), kind: 'set', value: pick(10) })
				ops.push({ t: 'renderStart', root: ROOTS[pick(2)], include })
				ops.push({ t: 'write', batch: include[0], atom: pick(4), kind: 'set', value: pick(10) })
			} else {
				ops.push({ t: 'renderStart', root: ROOTS[pick(2)], include })
			}
		} else if (roll < 0.68) {
			ops.push({ t: 'yield', renderPass: pick(20) })
		} else if (roll < 0.72) {
			ops.push({ t: 'resume', renderPass: pick(20) })
		} else if (roll < 0.82) {
			const retireAtCommit: number[] = []
			if (bool(0.3)) {
				retireAtCommit.push(pick(34))
			}
			ops.push({
				t: 'end',
				renderPass: pick(20),
				kind: bool(0.75) ? 'commit' : 'discard',
				retireAtCommit,
			})
		} else if (roll < 0.88) {
			ops.push({ t: 'mount', renderPass: pick(20), node: pick(8) })
			if (bool(0.5)) {
				ops.push({ t: 'render', renderPass: pick(20), watcher: pick(10) })
			}
		} else if (roll < 0.91) {
			ops.push({ t: 'render', renderPass: pick(20), watcher: pick(10) })
		} else if (roll < 0.94) {
			// Committed observers: single-node bodies and causally dep-choosing
			// (pick) bodies, with occasional removal / StrictMode replay so the
			// snapshot lifecycle (recapture, cleanup, OL2 no-run-after-removal)
			// fuzzes under every interleaving.
			if (bool(0.5)) {
				ops.push({ t: 'reactEffect', root: ROOTS[pick(2)], node: pick(8) })
			} else {
				ops.push({
					t: 'reactEffectPick',
					root: ROOTS[pick(2)],
					sel: pick(8),
					a: pick(8),
					b: pick(8),
				})
			}
			if (bool(0.25)) {
				ops.push({ t: bool(0.5) ? 'removeReactEffect' : 'replayReactEffect', effect: pick(10) })
			}
		} else if (roll < 0.95) {
			ops.push({ t: 'coreEffect', node: pick(8) })
		}
		// R-3 corpus band: writing core effects (effect writes classify
		// normally — the fused-apply fix's referee vocabulary).
		else if (roll < 0.96) {
			ops.push({ t: 'coreEffectWrite', node: pick(8), out: pick(2) })
		}
		// [SANCTIONED CO-EVOLUTION: converged-terminal referee, review finding #8]
		// The converged-terminal band, APPENDED after the historical bands (all
		// thresholds below 0.96 keep their exact seed stream). Mount a terminal
		// or its cause, then trigger via quiet tap writes — the two wave-1
		// scenarios: bug 1 (a core/quiet-path write to a terminal's dependency)
		// and bug 2 (a terminal body writing a sibling terminal's dependency).
		else if (roll < 0.972) {
			const root = ROOTS[pick(2)]
			const which = pick(4)
			if (which === 0) {
				ops.push({ t: 'mountTermReader', root, dep: 0 })
			} // reads sig (bug 1 downstream)
			else if (which === 1) {
				ops.push({ t: 'mountTapCore' })
			} // core writes sig (bug 1 cause)
			else if (which === 2) {
				ops.push({ t: 'mountTermReader', root, dep: 1 })
			} // reads sib (bug 2 downstream)
			else {
				ops.push({ t: 'mountSibWriter', root })
			} // terminal writes sib (bug 2 cause)
			// Trigger burst: quiet-only tap writes with distinct small values, so
			// the core's sig payload (min(runs,3)) and the writer's sib payload
			// (min(tap,3)) actually change and re-fire the reading terminals.
			while (bool(0.6)) {
				ops.push({ t: 'writeTap', value: pick(4) })
			}
		} else if (roll < 0.985) {
			ops.push({ t: 'discardAllWip' })
		} else {
			ops.push({ t: 'quiesce' })
		}
	}
	// Close out: retire everything then quiesce, so residue/epoch-reset rules run on most seeds.
	for (let batchIdx = 0; batchIdx < 34; batchIdx++) {
		ops.push({ t: 'discardAllWip' })
		ops.push({ t: 'settle', batch: batchIdx })
		bool(0.5) // discarded draw — the deleted retire committed flag (seed-stream preservation; the settle above drew nothing, matching its old constant)
		ops.push({ t: 'retire', batch: batchIdx })
	}
	ops.push({ t: 'quiesce' })
	return ops
}

/** Deterministic fingerprint of everything observable (for the double-run determinism check). */
export function fingerprint(result: RunResult): string {
	const m = result.model
	const values: Record<string, Value> = {}
	for (const n of m.idToNode.values()) {
		values[`newest:${n.name}`] = m.newestValue(n)
		for (const root of m.roots.keys()) {
			values[`committed:${root}:${n.name}`] = m.committedValue(n, root)
		}
	}
	return JSON.stringify({ events: m.events, values })
}

export type FuzzOutcome = {
	seed: number
	failure: { error: Error; step: number; shrunk: ScheduleOp[] } | undefined
}

/** Run one seed with invariants after every step; shrink on failure. */
export function fuzzSeed(seed: number, steps: number): FuzzOutcome {
	const ops = generateSchedule(seed, steps)
	const result = runSchedule(ops, true)
	if (result.failure === undefined) {
		return { seed, failure: undefined }
	}
	const shrunk = shrink(ops, (candidate) => runSchedule(candidate, true).failure !== undefined)
	return { seed, failure: { ...result.failure, shrunk } }
}

/** Greedy op-removal shrinking: keep removing ops while the failure reproduces. */
export function shrink(ops: ScheduleOp[], failing: (ops: ScheduleOp[]) => boolean): ScheduleOp[] {
	let current = ops
	let progress = true
	while (progress) {
		progress = false
		// Try halves first (fast), then single removals.
		for (const chunk of [Math.ceil(current.length / 2), Math.ceil(current.length / 4), 1]) {
			for (let i = 0; i + chunk <= current.length; i += chunk) {
				const candidate = [...current.slice(0, i), ...current.slice(i + chunk)]
				if (candidate.length < current.length && failing(candidate)) {
					current = candidate
					progress = true
					break
				}
			}
			if (progress) {
				break
			}
		}
	}
	return current
}

/** Assertion helper for tests: fail loudly with the seed and shrunk schedule. */
export function expectSeedClean(seed: number, steps: number): void {
	const outcome = fuzzSeed(seed, steps)
	if (outcome.failure !== undefined) {
		const { error, shrunk } = outcome.failure
		throw new InvariantViolation(
			`seed ${seed} failed: ${error.message}\nshrunk schedule (${shrunk.length} ops):\n${JSON.stringify(shrunk)}`,
		)
	}
}
