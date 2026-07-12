/**
 * Randomized oracle: a naive, memo-free model of THIS engine's semantics —
 * per-atom intent history (urgent and drafted, in dispatch order), worlds as
 * replay folds, computeds as pure rederivation — fuzzed against the real
 * engine. Failures print the seed and a shrunk schedule; found bugs get
 * pinned as named regression tests in oracle-regressions.spec.ts.
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

/** The engine touch points the sabotage canaries below override, so the
 * oracle is proven to catch a broken engine rather than a broken harness. */
interface EngineSeams {
	retire(draft: Draft): void
	/** The draft-lane reducer channel: every wake a scoped subscriber receives
	 * (write-time pokes and attach-time joins alike) flows through here. */
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
// The model
// ---------------------------------------------------------------------------

type ModelIntent = {
	kind: 'set' | 'update'
	payload: number | ((p: number) => number)
	draft: number | null
}
type ModelCell = { init: number; intents: ModelIntent[] }
type DraftState = 'live' | 'retired' | 'discarded'

interface Model {
	cells: ModelCell[]
	drafts: Map<number, DraftState>
}

function modelValue(
	m: Model,
	cellIx: number,
	worldIds: readonly number[] | 'latest' | null,
): number {
	const cell = m.cells[cellIx]
	const live = (id: number) => m.drafts.get(id) === 'live'
	let v = cell.init
	// Array order is dispatch order; retirement flips visibility, never
	// position (mirrors the engine's rebase log exactly).
	for (const it of cell.intents) {
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

// Computed shapes: pure expressions over cells and earlier computeds.
type Expr =
	| { op: 'sum'; args: Ref[] }
	| { op: 'mul'; args: Ref[] }
	| { op: 'pick'; cond: Ref; then: Ref; else: Ref }
type Ref = { cell: number } | { comp: number }

function modelEval(
	m: Model,
	exprs: Expr[],
	ref: Ref,
	world: readonly number[] | 'latest' | null,
): number {
	if ('cell' in ref) {
		return modelValue(m, ref.cell, world)
	}
	const e = exprs[ref.comp]
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
	| { t: 'cell'; init: number }
	| { t: 'comp'; expr: Expr }
	| { t: 'set'; cell: number; v: number }
	| { t: 'update'; cell: number; k: number }
	| { t: 'batchWrites'; writes: Array<{ cell: number; v: number }> }
	| { t: 'open' }
	| { t: 'draftSet'; draft: number; cell: number; v: number }
	| { t: 'draftUpdate'; draft: number; cell: number; k: number }
	| { t: 'retire'; draft: number }
	| { t: 'discard'; draft: number }
	| { t: 'readBase'; ref: Ref }
	| { t: 'readWorld'; ref: Ref; ids: number[] }
	| { t: 'readLatest'; cell: number }
	| { t: 'probePending'; cell: number }

function generate(rand: () => number, steps: number): Step[] {
	const out: Step[] = []
	let cells = 0
	let comps = 0
	let draftIds: number[] = []
	let nextDraft = 0
	const anyRef = (): Ref =>
		comps > 0 && rand() < 0.35
			? { comp: Math.floor(rand() * comps) }
			: { cell: Math.floor(rand() * cells) }
	for (let i = 0; i < steps; i++) {
		const r = rand()
		if (cells === 0 || (r < 0.08 && cells < 8)) {
			out.push({ t: 'cell', init: Math.floor(rand() * 10) })
			cells++
		} else if (r < 0.16 && comps < 8) {
			const op = rand() < 0.4 ? 'sum' : rand() < 0.7 ? 'mul' : 'pick'
			const expr: Expr =
				op === 'pick'
					? { op, cond: anyRef(), then: anyRef(), else: anyRef() }
					: { op, args: [anyRef(), anyRef()] }
			out.push({ t: 'comp', expr })
			comps++
		} else if (r < 0.3) {
			out.push({ t: 'set', cell: Math.floor(rand() * cells), v: Math.floor(rand() * 20) })
		} else if (r < 0.4) {
			out.push({ t: 'update', cell: Math.floor(rand() * cells), k: 1 + Math.floor(rand() * 3) })
		} else if (r < 0.45) {
			const writes = []
			const n = 1 + Math.floor(rand() * 3)
			for (let j = 0; j < n; j++) {
				writes.push({ cell: Math.floor(rand() * cells), v: Math.floor(rand() * 20) })
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
					cell: Math.floor(rand() * cells),
					v: Math.floor(rand() * 20),
				})
			} else {
				out.push({
					t: 'draftUpdate',
					draft: d,
					cell: Math.floor(rand() * cells),
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
			out.push({ t: 'readLatest', cell: Math.floor(rand() * cells) })
		} else {
			out.push({ t: 'probePending', cell: Math.floor(rand() * cells) })
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Execution: engine + model side by side
// ---------------------------------------------------------------------------

function runSchedule(steps: Step[], seams: EngineSeams = realSeams): string | null {
	resetEngineForTest()
	const model: Model = { cells: [], drafts: new Map() }
	const exprs: Expr[] = []
	const engCells: Atom<number>[] = []
	const engComps: Computed<number>[] = []
	const engDrafts = new Map<number, Draft>() // schedule draft ix -> engine draft record (transient: dies with this run)
	const idToIx = new Map<DraftId, number>() // engine draft id -> schedule ix
	const effectLog: number[] = []
	const expectedEffectLog: number[] = []
	let effectRef: Ref | null = null
	let disposeEffect: (() => void) | null = null

	const engRead = (ref: Ref): number =>
		'cell' in ref ? read(engCells[ref.cell]) : read(engComps[ref.comp])

	// Scoped subscribers: the (only) React hook shape. Subscribe with both
	// channels of useValue — the render-notify channel (predicate compare,
	// re-read on change: the useSyncExternalStore bail) and the draft-lane
	// channel (wakes deliver draft ids into a per-subscriber world, exactly
	// like the per-hook reducer; attach-time joins mirror correctSubscription
	// for drafts that wrote before the subscription existed). Their rendered
	// view must match the model's value FOR THEIR WORLD after every rerender —
	// and silent folds keep them converged with base state without any
	// storeVersion bump, because retirement flips a draft's intents from world-only to
	// always-included without moving them ("visibility, never position").
	interface ScopedSub {
		ref: Ref
		/** The reducer world: engine ids of drafts delivered to this sub. */
		ids: Set<DraftId>
		view: unknown
		/** Strong subs additionally carry model-side wake bookkeeping: the
		 * model knows exactly which drafts wrote their cell, so a dropped wake
		 * is a failure, not a smaller world. Cell subscribers are strong (a
		 * cell's poke audience is total); computed subscribers are not (their
		 * watched dep set is the last base-state evaluation's reads, so a draft
		 * write to a branch only a draft world reads legitimately never wakes
		 * them). */
		modelIds: Set<number> | null
		failure: string | null
		unsub: () => void
	}
	const scopedSubs: ScopedSub[] = []
	const attachScoped = (ref: Ref, strong: boolean) => {
		const target = 'cell' in ref ? engCells[ref.cell] : engComps[ref.comp]
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
				// The bindings' notify predicate, mirrored: re-render only when the
				// resolution of THIS sub's world differs from what it shows.
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
			// Strong (cell) subscribers: the model's own wake bookkeeping is the
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
				case 'cell': {
					model.cells.push({ init: s.init, intents: [] })
					engCells.push(createAtom(s.init))
					if (engCells.length === 1) {
						attachScoped({ cell: 0 }, true)
					}
					break
				}
				case 'comp': {
					exprs.push(s.expr)
					const ix = exprs.length - 1
					const e = s.expr
					const engRef = (r: Ref): number =>
						'cell' in r ? engCells[r.cell].get() : engComps[r.comp].get()
					const fn =
						e.op === 'sum'
							? () => e.args.reduce((acc, r) => acc + engRef(r), 0)
							: e.op === 'mul'
								? () => e.args.reduce((acc, r) => acc * engRef(r), 1) % 1000003
								: () => (engRef(e.cond) % 2 === 0 ? engRef(e.then) : engRef(e.else))
					engComps.push(createComputed(fn))
					if (effectRef === null && ix === 0) {
						effectRef = { comp: 0 }
						disposeEffect = effect(() => {
							const v = engComps[0].get()
							if (effectLog.length === 0 || effectLog[effectLog.length - 1] !== v) {
								effectLog.push(v)
							}
						})
						refreshExpectedEffect()
						attachScoped({ comp: 0 }, false)
					}
					break
				}
				case 'set': {
					model.cells[s.cell].intents.push({ kind: 'set', payload: s.v, draft: null })
					engCells[s.cell].set(s.v)
					refreshExpectedEffect()
					break
				}
				case 'update': {
					const k = s.k
					model.cells[s.cell].intents.push({ kind: 'update', payload: (p) => p + k, draft: null })
					engCells[s.cell].update((p) => p + k)
					refreshExpectedEffect()
					break
				}
				case 'batchWrites': {
					batch(() => {
						for (const w of s.writes) {
							model.cells[w.cell].intents.push({ kind: 'set', payload: w.v, draft: null })
							engCells[w.cell].set(w.v)
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
					model.cells[s.cell].intents.push({ kind: 'set', payload: s.v, draft: s.draft })
					for (const sub of scopedSubs) {
						if (sub.modelIds !== null && 'cell' in sub.ref && sub.ref.cell === s.cell) {
							sub.modelIds.add(s.draft)
						}
					}
					runWithDraftWrites(engDrafts.get(s.draft)!, () => engCells[s.cell].set(s.v))
					break
				}
				case 'draftUpdate': {
					if (model.drafts.get(s.draft) !== 'live') {
						break
					}
					const k = s.k
					model.cells[s.cell].intents.push({
						kind: 'update',
						payload: (p) => p + k,
						draft: s.draft,
					})
					for (const sub of scopedSubs) {
						if (sub.modelIds !== null && 'cell' in sub.ref && sub.ref.cell === s.cell) {
							sub.modelIds.add(s.draft)
						}
					}
					runWithDraftWrites(engDrafts.get(s.draft)!, () => engCells[s.cell].update((p) => p + k))
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
					const target = 'cell' in s.ref ? engCells[s.ref.cell] : engComps[s.ref.comp]
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
					const got = latest(engCells[s.cell])
					const want = modelValue(model, s.cell, 'latest')
					if (got !== want) {
						return fail(`latest: engine ${got} != model ${want}`)
					}
					break
				}
				case 'probePending': {
					const got = isPending(engCells[s.cell])
					const want = model.cells[s.cell].intents.some(
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
		for (let cix = 0; cix < engCells.length; cix++) {
			const got = read(engCells[cix])
			const want = modelValue(model, cix, null)
			if (got !== want) {
				return `final sweep cell ${cix}: engine ${got} != model ${want}`
			}
		}
		for (let cix = 0; cix < engComps.length; cix++) {
			const got = read(engComps[cix])
			const want = modelEval(model, exprs, { comp: cix }, null)
			if (got !== want) {
				return `final sweep comp ${cix}: engine ${got} != model ${want}`
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

/** Greedy shrink: drop one step at a time while the failure reproduces.
 * A candidate that THROWS inside runSchedule (dropping a creation step
 * leaves later steps referencing cells or drafts that never exist) is not
 * a valid reproduction of the returned-string failure — treat it as
 * non-reproducing and move on, never crash the shrink loop. */
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
				{ t: 'cell', init: 1 },
				{ t: 'open' },
				{ t: 'draftSet', draft: 0, cell: 0, v: 9 },
				{ t: 'retire', draft: 0 },
				{ t: 'readBase', ref: { cell: 0 } },
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
				{ t: 'cell', init: 1 },
				{ t: 'open' },
				{ t: 'draftSet', draft: 0, cell: 0, v: 9 },
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
