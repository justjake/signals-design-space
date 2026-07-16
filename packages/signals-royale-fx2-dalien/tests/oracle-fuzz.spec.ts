/**
 * Randomized oracle: a naive, memo-free model of the engine's semantics —
 * per-atom intent history (urgent and drafted, in dispatch order), worlds
 * as replay folds, computeds as pure rederivation — fuzzed against the
 * real engine. Failures print the seed and a shrunk schedule; found bugs
 * get pinned as named regression tests in oracle-regressions.spec.ts.
 *
 * Seed count: ROYALE_FX2_SEEDS (default 300) x ~90 steps.
 */
import { describe, expect, test } from 'vitest'
import {
	Flag,
	createComputed,
	effect,
	isPending,
	latest,
	nodeOf,
	read,
	resetEngineForTest,
	createAtom,
	batch,
	type Atom,
	type Computed,
} from '../src/index.ts'
import {
	discardDraft,
	draftsAffecting,
	isLiveDraft,
	openDraft,
	resolveState,
	retireDraft,
	runWithDraftWrites,
	worldOf,
	type Draft,
	type DraftId,
} from '../src/worlds.ts'
import { observeNode } from '../src/graph.ts'

/**
 * The engine touch points the sabotage canaries below override, so the
 * oracle is proven to catch a broken engine rather than a broken harness.
 */
interface EngineSeams {
	retire(draft: Draft): void
	/**
	 * The draft-lane reducer channel: every wake a scoped subscriber receives
	 * (write-time pokes and attach-time joins alike) flows through here.
	 */
	deliverWake(join: (id: DraftId) => void, id: DraftId): void
}

const realSeams: EngineSeams = {
	retire: (draft) => retireDraft(draft.id),
	deliverWake: (join, id) => join(id),
}

// ---------------------------------------------------------------------------
// Deterministic PRNG
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a |= 0
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

// ---------------------------------------------------------------------------
// Oracle model: plain data predicting what the engine should resolve.
// ---------------------------------------------------------------------------

type ModelIntent = {
	kind: 'set' | 'update'
	payload: number | ((p: number) => number)
	draft: number | null
}
type ModelAtom = { init: number; intents: ModelIntent[] }
type DraftState = 'live' | 'retired' | 'discarded'

interface Model {
	atoms: ModelAtom[]
	drafts: Map<number, DraftState>
}

function modelValue(
	m: Model,
	atomIx: number,
	worldIds: readonly number[] | 'latest' | null,
): number {
	const atom = m.atoms[atomIx]
	const live = (id: number) => m.drafts.get(id) === 'live'
	let v = atom.init
	// Array order is dispatch order; retirement flips visibility, never
	// position (mirrors the engine's rebase log exactly).
	for (const it of atom.intents) {
		const included =
			it.draft === null ||
			m.drafts.get(it.draft) === 'retired' ||
			(worldIds === 'latest'
				? live(it.draft)
				: worldIds !== null && worldIds.includes(it.draft) && live(it.draft))
		if (!included) {
			continue
		}
		v = it.kind === 'set' ? (it.payload as number) : (it.payload as (p: number) => number)(v)
	}
	return v
}

// Computed shapes: pure expressions over atoms and earlier computeds.
type Expr =
	| { op: 'sum'; args: Ref[] }
	| { op: 'mul'; args: Ref[] }
	| { op: 'pick'; cond: Ref; then: Ref; else: Ref }
type Ref = { atom: number } | { computed: number }

function modelEval(
	m: Model,
	exprs: Expr[],
	ref: Ref,
	world: readonly number[] | 'latest' | null,
): number {
	if ('atom' in ref) {
		return modelValue(m, ref.atom, world)
	}
	const e = exprs[ref.computed]
	if (e.op === 'sum') {
		return e.args.reduce((acc, r) => acc + modelEval(m, exprs, r, world), 0)
	}
	if (e.op === 'mul') {
		return e.args.reduce((acc, r) => acc * modelEval(m, exprs, r, world), 1) % 1000003
	}
	return modelEval(m, exprs, e.cond, world) % 2 === 0
		? modelEval(m, exprs, e.then, world)
		: modelEval(m, exprs, e.else, world)
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

type Step =
	| { t: 'atom'; init: number }
	| { t: 'computed'; expr: Expr }
	| { t: 'set'; atom: number; v: number }
	| { t: 'update'; atom: number; k: number }
	| { t: 'batchWrites'; writes: Array<{ atom: number; v: number }> }
	| { t: 'open' }
	| { t: 'draftSet'; draft: number; atom: number; v: number }
	| { t: 'draftUpdate'; draft: number; atom: number; k: number }
	| { t: 'retire'; draft: number }
	| { t: 'discard'; draft: number }
	| { t: 'readBase'; ref: Ref }
	| { t: 'readWorld'; ref: Ref; ids: number[] }
	| { t: 'readLatest'; atom: number }
	| { t: 'probePending'; atom: number }

function generate(rand: () => number, steps: number): Step[] {
	const out: Step[] = []
	let atoms = 0
	let computeds = 0
	let draftIds: number[] = []
	let nextDraft = 0
	const anyRef = (): Ref =>
		computeds > 0 && rand() < 0.35
			? { computed: Math.floor(rand() * computeds) }
			: { atom: Math.floor(rand() * atoms) }
	for (let i = 0; i < steps; i++) {
		const r = rand()
		if (atoms === 0 || (r < 0.08 && atoms < 8)) {
			out.push({ t: 'atom', init: Math.floor(rand() * 10) })
			atoms++
		} else if (r < 0.16 && computeds < 8) {
			const op = rand() < 0.4 ? 'sum' : rand() < 0.7 ? 'mul' : 'pick'
			const expr: Expr =
				op === 'pick'
					? { op, cond: anyRef(), then: anyRef(), else: anyRef() }
					: { op, args: [anyRef(), anyRef()] }
			out.push({ t: 'computed', expr })
			computeds++
		} else if (r < 0.3) {
			out.push({ t: 'set', atom: Math.floor(rand() * atoms), v: Math.floor(rand() * 20) })
		} else if (r < 0.4) {
			out.push({ t: 'update', atom: Math.floor(rand() * atoms), k: 1 + Math.floor(rand() * 3) })
		} else if (r < 0.45) {
			const writes = []
			const n = 1 + Math.floor(rand() * 3)
			for (let j = 0; j < n; j++) {
				writes.push({ atom: Math.floor(rand() * atoms), v: Math.floor(rand() * 20) })
			}
			out.push({ t: 'batchWrites', writes })
		} else if (r < 0.52 && draftIds.length < 4) {
			out.push({ t: 'open' })
			draftIds.push(nextDraft++)
		} else if (r < 0.62 && draftIds.length > 0) {
			const d = draftIds[Math.floor(rand() * draftIds.length)]
			if (rand() < 0.5) {
				out.push({
					t: 'draftSet',
					draft: d,
					atom: Math.floor(rand() * atoms),
					v: Math.floor(rand() * 20),
				})
			} else {
				out.push({
					t: 'draftUpdate',
					draft: d,
					atom: Math.floor(rand() * atoms),
					k: 1 + Math.floor(rand() * 3),
				})
			}
		} else if (r < 0.68 && draftIds.length > 0) {
			const ix = Math.floor(rand() * draftIds.length)
			const d = draftIds[ix]
			draftIds = draftIds.filter((x) => x !== d)
			out.push(rand() < 0.7 ? { t: 'retire', draft: d } : { t: 'discard', draft: d })
		} else if (r < 0.8) {
			out.push({ t: 'readBase', ref: anyRef() })
		} else if (r < 0.9) {
			const ids = draftIds.filter(() => rand() < 0.5)
			out.push({ t: 'readWorld', ref: anyRef(), ids })
		} else if (r < 0.95) {
			out.push({ t: 'readLatest', atom: Math.floor(rand() * atoms) })
		} else {
			out.push({ t: 'probePending', atom: Math.floor(rand() * atoms) })
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Execution: engine + model side by side
// ---------------------------------------------------------------------------

function runSchedule(steps: Step[], seams: EngineSeams = realSeams): string | null {
	resetEngineForTest()
	const model: Model = { atoms: [], drafts: new Map() }
	const exprs: Expr[] = []
	const engAtoms: Atom<number>[] = []
	const engComputeds: Computed<number>[] = []
	const engDrafts = new Map<number, Draft>() // schedule draft ix -> engine draft record (transient: dies with this run)
	const idToIx = new Map<DraftId, number>() // engine draft id -> schedule ix
	const effectLog: number[] = []
	const expectedEffectLog: number[] = []
	let effectRef: Ref | null = null
	let disposeEffect: (() => void) | null = null

	const engRead = (ref: Ref): number =>
		'atom' in ref ? read(engAtoms[ref.atom]) : read(engComputeds[ref.computed])

	// Scoped subscribers mirror the useValue hook shape, with both of its
	// channels: the render-notify channel (predicate compare, re-read on
	// change) and the draft-wake channel (wakes deliver draft ids into a
	// per-subscriber world, exactly like the per-hook reducer; attach-time
	// joins mirror correctSubscription for drafts that wrote before the
	// subscription existed). Each subscriber's rendered view must match the
	// model's value for that subscriber's world after every rerender — and
	// folds keep them converged with base state without any extra renders,
	// because retirement changes which worlds include a draft's intents
	// without moving the intents' positions in the log.
	interface ScopedSub {
		ref: Ref
		/** The reducer world: engine ids of drafts delivered to this sub. */
		ids: Set<DraftId>
		view: unknown
		/**
		 * Strong subs additionally carry model-side wake bookkeeping: the
		 * model knows exactly which drafts wrote their atom, so a dropped wake
		 * is a failure, not a smaller world. Atom subscribers are strong (an
		 * atom's poke audience is total); computed subscribers are not (their
		 * watched dep set is the last base-state evaluation's reads, so a draft
		 * write to a branch only a draft world reads legitimately never wakes
		 * them).
		 */
		modelIds: Set<number> | null
		failure: string | null
		unsub: () => void
	}
	const scopedSubs: ScopedSub[] = []
	const attachScoped = (ref: Ref, strong: boolean) => {
		const target = 'atom' in ref ? engAtoms[ref.atom] : engComputeds[ref.computed]
		const node = nodeOf(target)
		const sub: ScopedSub = {
			ref,
			ids: new Set(),
			view: undefined,
			modelIds: strong ? new Set() : null,
			failure: null,
			unsub: () => {},
		}
		const rerender = () => {
			for (const id of [...sub.ids]) {
				if (!isLiveDraft(id)) {
					sub.ids.delete(id)
				} // the reducer's prune
			}
			const st = resolveState(node, worldOf([...sub.ids]))
			if ((st.flags & Flag.AsyncMask) !== 0) {
				sub.failure ??= `scoped subscriber ${JSON.stringify(ref)}: unexpected async flags ${st.flags}`
				return
			}
			sub.view = st.value
			// Rerender-time agreement: the engine's resolution of this sub's
			// world matches the model's.
			const ixs = [...sub.ids]
				.map((id) => idToIx.get(id)!)
				.filter((ix) => model.drafts.get(ix) === 'live')
			const want = modelEval(model, exprs, ref, ixs)
			if (sub.view !== want) {
				sub.failure ??= `scoped subscriber ${JSON.stringify(ref)}: rerender view ${String(sub.view)} != model ${want} for world [${ixs}]`
			}
		}
		const join = (id: DraftId) => {
			if (!isLiveDraft(id)) {
				return
			}
			sub.ids.add(id)
			rerender()
		}
		sub.unsub = observeNode(
			node,
			() => {
				// The bindings' notify predicate, mirrored: re-render only when
				// the resolution of this sub's own world differs from what it
				// shows.
				const ids = [...sub.ids].filter((id) => isLiveDraft(id))
				const st = resolveState(node, worldOf(ids))
				if ((st.flags & Flag.AsyncMask) !== 0 || !Object.is(st.value, sub.view)) {
					rerender()
				}
			},
			(id) => seams.deliverWake(join, id),
		)
		// The subscription attaches after drafts may already hold intents on
		// this node's sources; join them (correctSubscription's job in the
		// bindings), through the same sabotage seam as write-time wakes.
		for (const id of draftsAffecting(node)) {
			seams.deliverWake(join, id)
		}
		rerender()
		scopedSubs.push(sub)
	}
	const checkScopedSubs = (): string | null => {
		for (const sub of scopedSubs) {
			if (sub.failure !== null) {
				return sub.failure
			}
			if (sub.modelIds === null) {
				continue
			}
			// Strong (atom) subscribers: the model's own wake bookkeeping is the
			// expectation, so a swallowed wake or a missed silent fold surfaces
			// as a stale view here — this is the silent-fold honesty check.
			const liveIxs = [...sub.modelIds].filter((ix) => model.drafts.get(ix) === 'live')
			const want = modelEval(model, exprs, sub.ref, liveIxs)
			if (sub.view !== want) {
				return `scoped subscriber ${JSON.stringify(sub.ref)}: view ${String(sub.view)} != model ${want} for world [${liveIxs}]`
			}
		}
		return null
	}

	const refreshExpectedEffect = () => {
		if (effectRef === null) {
			return
		}
		const v = modelEval(model, exprs, effectRef, null)
		if (expectedEffectLog.length === 0 || expectedEffectLog[expectedEffectLog.length - 1] !== v) {
			expectedEffectLog.push(v)
		}
	}

	try {
		for (let i = 0; i < steps.length; i++) {
			const s = steps[i]
			const fail = (msg: string) => `step ${i} ${JSON.stringify(s)}: ${msg}`
			switch (s.t) {
				case 'atom': {
					model.atoms.push({ init: s.init, intents: [] })
					engAtoms.push(createAtom(s.init))
					if (engAtoms.length === 1) {
						attachScoped({ atom: 0 }, true)
					}
					break
				}
				case 'computed': {
					exprs.push(s.expr)
					const ix = exprs.length - 1
					const e = s.expr
					const engRef = (r: Ref): number =>
						'atom' in r ? engAtoms[r.atom].get() : engComputeds[r.computed].get()
					const fn =
						e.op === 'sum'
							? () => e.args.reduce((acc, r) => acc + engRef(r), 0)
							: e.op === 'mul'
								? () => e.args.reduce((acc, r) => acc * engRef(r), 1) % 1000003
								: () => (engRef(e.cond) % 2 === 0 ? engRef(e.then) : engRef(e.else))
					engComputeds.push(createComputed(fn))
					if (effectRef === null && ix === 0) {
						effectRef = { computed: 0 }
						disposeEffect = effect(
							() => engComputeds[0].get(),
							(v) => {
								if (effectLog.length === 0 || effectLog[effectLog.length - 1] !== v) {
									effectLog.push(v)
								}
							},
						)
						refreshExpectedEffect()
						attachScoped({ computed: 0 }, false)
					}
					break
				}
				case 'set': {
					model.atoms[s.atom].intents.push({ kind: 'set', payload: s.v, draft: null })
					engAtoms[s.atom].set(s.v)
					refreshExpectedEffect()
					break
				}
				case 'update': {
					const k = s.k
					model.atoms[s.atom].intents.push({ kind: 'update', payload: (p) => p + k, draft: null })
					engAtoms[s.atom].update((p) => p + k)
					refreshExpectedEffect()
					break
				}
				case 'batchWrites': {
					batch(() => {
						for (const w of s.writes) {
							model.atoms[w.atom].intents.push({ kind: 'set', payload: w.v, draft: null })
							engAtoms[w.atom].set(w.v)
						}
					})
					refreshExpectedEffect()
					break
				}
				case 'open': {
					const d = openDraft()
					const ix = engDrafts.size
					engDrafts.set(ix, d)
					idToIx.set(d.id, ix)
					model.drafts.set(ix, 'live')
					break
				}
				case 'draftSet': {
					if (model.drafts.get(s.draft) !== 'live') {
						break
					}
					model.atoms[s.atom].intents.push({ kind: 'set', payload: s.v, draft: s.draft })
					for (const sub of scopedSubs) {
						if (sub.modelIds !== null && 'atom' in sub.ref && sub.ref.atom === s.atom) {
							sub.modelIds.add(s.draft)
						}
					}
					runWithDraftWrites(engDrafts.get(s.draft)!, () => engAtoms[s.atom].set(s.v))
					break
				}
				case 'draftUpdate': {
					if (model.drafts.get(s.draft) !== 'live') {
						break
					}
					const k = s.k
					model.atoms[s.atom].intents.push({
						kind: 'update',
						payload: (p) => p + k,
						draft: s.draft,
					})
					for (const sub of scopedSubs) {
						if (sub.modelIds !== null && 'atom' in sub.ref && sub.ref.atom === s.atom) {
							sub.modelIds.add(s.draft)
						}
					}
					runWithDraftWrites(engDrafts.get(s.draft)!, () => engAtoms[s.atom].update((p) => p + k))
					break
				}
				case 'retire': {
					if (model.drafts.get(s.draft) !== 'live') {
						break
					}
					model.drafts.set(s.draft, 'retired')
					seams.retire(engDrafts.get(s.draft)!)
					refreshExpectedEffect()
					break
				}
				case 'discard': {
					if (model.drafts.get(s.draft) !== 'live') {
						break
					}
					model.drafts.set(s.draft, 'discarded')
					discardDraft(engDrafts.get(s.draft)!.id)
					break
				}
				case 'readBase': {
					const got = engRead(s.ref)
					const want = modelEval(model, exprs, s.ref, null)
					if (got !== want) {
						return fail(`base read: engine ${got} != model ${want}`)
					}
					break
				}
				case 'readWorld': {
					const ids = s.ids.filter((ix) => model.drafts.get(ix) === 'live')
					const engIds = ids.map((ix) => engDrafts.get(ix)!.id)
					const target = 'atom' in s.ref ? engAtoms[s.ref.atom] : engComputeds[s.ref.computed]
					const st = resolveState(nodeOf(target), worldOf(engIds))
					if ((st.flags & Flag.AsyncMask) !== 0) {
						return fail(`world read: unexpected flags ${st.flags}`)
					}
					const want = modelEval(model, exprs, s.ref, ids)
					if (st.value !== want) {
						return fail(`world read [${ids}]: engine ${String(st.value)} != model ${want}`)
					}
					break
				}
				case 'readLatest': {
					const got = latest(engAtoms[s.atom])
					const want = modelValue(model, s.atom, 'latest')
					if (got !== want) {
						return fail(`latest: engine ${got} != model ${want}`)
					}
					break
				}
				case 'probePending': {
					const got = isPending(engAtoms[s.atom])
					const want = model.atoms[s.atom].intents.some(
						(it) => it.draft !== null && model.drafts.get(it.draft) === 'live',
					)
					if (got !== want) {
						return fail(`isPending: engine ${got} != model ${want}`)
					}
					break
				}
			}
			// Scoped subscribers converge synchronously (wakes and notifications
			// flush with the walk), so their views are checkable after any step.
			const scoped = checkScopedSubs()
			if (scoped !== null) {
				return fail(scoped)
			}
		}
		// Final base-state sweep + effect-log comparison.
		for (let aix = 0; aix < engAtoms.length; aix++) {
			const got = read(engAtoms[aix])
			const want = modelValue(model, aix, null)
			if (got !== want) {
				return `final sweep atom ${aix}: engine ${got} != model ${want}`
			}
		}
		for (let computedIx = 0; computedIx < engComputeds.length; computedIx++) {
			const got = read(engComputeds[computedIx])
			const want = modelEval(model, exprs, { computed: computedIx }, null)
			if (got !== want) {
				return `final sweep computed ${computedIx}: engine ${got} != model ${want}`
			}
		}
		if (effectLog.join(',') !== expectedEffectLog.join(',')) {
			return `effect log: engine [${effectLog}] != model [${expectedEffectLog}]`
		}
		return null
	} finally {
		disposeEffect?.()
		for (const sub of scopedSubs) {
			sub.unsub()
		}
	}
}

/**
 * Greedy shrink: drop one step at a time while the failure reproduces.
 * A candidate that throws inside runSchedule (dropping a creation step
 * leaves later steps referencing atoms or drafts that never exist) is not
 * a valid reproduction of the returned-string failure — treat it as
 * non-reproducing and move on, never crash the shrink loop.
 */
function reproduces(candidate: Step[]): boolean {
	try {
		return runSchedule(candidate) !== null
	} catch {
		return false
	}
}

function shrink(steps: Step[]): Step[] {
	let current = steps
	let progress = true
	while (progress) {
		progress = false
		for (let i = 0; i < current.length; i++) {
			const candidate = current.slice(0, i).concat(current.slice(i + 1))
			if (candidate.length > 0 && reproduces(candidate)) {
				current = candidate
				progress = true
				break
			}
		}
	}
	return current
}

const SEEDS = Number(process.env.ROYALE_FX2_SEEDS ?? '300')
const STEPS = 90

describe(`oracle fuzz (${SEEDS} seeds x ${STEPS} steps)`, () => {
	test('canary: a sabotaged engine is caught by the oracle', () => {
		const sabotaged: EngineSeams = {
			...realSeams,
			retire: () => {
				/* sabotage: retirement silently dropped */
			},
		}
		try {
			const schedule: Step[] = [
				{ t: 'atom', init: 1 },
				{ t: 'open' },
				{ t: 'draftSet', draft: 0, atom: 0, v: 9 },
				{ t: 'retire', draft: 0 },
				{ t: 'readBase', ref: { atom: 0 } },
			]
			expect(runSchedule(schedule, sabotaged)).not.toBeNull()
		} finally {
			resetEngineForTest()
		}
	})

	test('canary: a scoped subscriber with a sabotaged draft-lane channel is caught (the silent-fold staleness class)', () => {
		// Sabotage: the reducer channel drops every wake. The subscriber's
		// the notify predicate compares in the sub's own world, so the wake
		// channel is its only route to a silently folded draft's values — with
		// wakes dropped it strands on the pre-draft view during the draft's
		// life and stays stranded after the silent fold. The oracle must see
		// both as staleness against its wake bookkeeping.
		const sabotaged: EngineSeams = {
			...realSeams,
			deliverWake: () => {
				/* sabotage: the reducer never hears about the draft */
			},
		}
		try {
			const schedule: Step[] = [
				{ t: 'atom', init: 1 },
				{ t: 'open' },
				{ t: 'draftSet', draft: 0, atom: 0, v: 9 },
				{ t: 'retire', draft: 0 },
			]
			expect(runSchedule(schedule, sabotaged)).not.toBeNull()
		} finally {
			resetEngineForTest()
		}
	})

	test('engine matches the naive model on every seed', () => {
		const failures: string[] = []
		for (let seed = 1; seed <= SEEDS; seed++) {
			const steps = generate(mulberry32(seed), STEPS)
			const failure = runSchedule(steps)
			if (failure !== null) {
				const small = shrink(steps)
				const replay = runSchedule(small)
				failures.push(
					`seed ${seed}: ${failure}\n  shrunk to ${small.length} steps: ${JSON.stringify(small)}\n  shrunk failure: ${replay}`,
				)
				if (failures.length >= 3) {
					break
				}
			}
		}
		expect(failures, failures.join('\n\n')).toEqual([])
	})
})
