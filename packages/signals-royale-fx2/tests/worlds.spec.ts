/** Engine-level world semantics: drafts, replay order, fold, views. */
import { describe, expect, test } from 'vitest'
import {
	Flag,
	computed,
	effect,
	isPending,
	latest,
	committed,
	nodeOf,
	read,
	reducerAtom,
	setRenderWorldProvider,
	signal,
	untracked,
	type Computed,
	type Signal,
} from '../src/index.ts'
import {
	discardDraft,
	liveDraftCount,
	openDraft,
	rebaseLogIntentCount,
	resolveState,
	retireDraft,
	runInDraft,
	sealDraft,
	setCommittedWorld,
	worldOf,
	type DraftId,
} from '../src/worlds.ts'
import { observeNode, type CellNode } from '../src/graph.ts'

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

function inDraft(fn: () => void): DraftId {
	const d = openDraft()
	runInDraft(d, fn)
	sealDraft(d)
	return d.id
}

/** Resolve a handle's state as seen by the world of these draft ids. */
function stateIn(x: Signal<any> | Computed<any>, ids: readonly DraftId[]): unknown {
	return resolveState(nodeOf(x), worldOf(ids))
}

/** A drafted world's memo record for a plain value (the DerivedState shape:
 * async flag bits clear, no throwable). */
function valueState(value: unknown): { flags: number; value: unknown; throwable: null } {
	return { flags: 0, value, throwable: null }
}

describe('draft visibility', () => {
	test('draft writes are invisible to base-state readers until retirement', () => {
		const a = signal(0)
		const id = inDraft(() => a.set(1))
		expect(read(a)).toBe(0)
		expect(latest(a)).toBe(1)
		expect(stateIn(a, [id])).toEqual(valueState(1))
		retireDraft(id)
		expect(read(a)).toBe(1)
		expect(latest(a)).toBe(1)
	})

	test('retirement folds through the write path: effects run once per fold', () => {
		const a = signal(0)
		const b = signal(0)
		let runs = 0
		effect(() => {
			a.get()
			b.get()
			runs++
		})
		const id = inDraft(() => {
			a.set(1)
			b.set(2)
		})
		expect(runs).toBe(1) // drafts do not touch effects
		retireDraft(id)
		expect(runs).toBe(2) // one batched fold
	})

	test('discard rolls back: base state unchanged, latest reverts', () => {
		const a = signal(5)
		const id = inDraft(() => a.update((x) => x + 10))
		expect(latest(a)).toBe(15)
		discardDraft(id)
		expect(latest(a)).toBe(5)
		expect(read(a)).toBe(5)
	})

	test('fold loudness is per subscriber: rendered-world resolutions decide who re-renders', () => {
		// There is no global silent/loud fold state: at retire, the fold's
		// writes notify subscribers, and each re-renders only if resolving its
		// OWN rendered world now differs from what it rendered (the bindings'
		// notify predicate). This pins the engine half of that contract: a
		// carrier's world resolves the SAME value before and after the fold
		// (retired ids normalize out), while the base world's resolution moves.
		const a = signal(1)
		const id = inDraft(() => a.set(9))
		// Before the fold: the carrier rendered 9 from its world; base shows 1.
		expect(resolveState(nodeOf(a), worldOf([id])).value).toBe(9)
		expect(resolveState(nodeOf(a), worldOf([])).value).toBe(1)
		retireDraft(id)
		expect(read(a)).toBe(9) // the fold landed in base state
		// Carrier's world still resolves 9 — equal to what it rendered: silent.
		expect(resolveState(nodeOf(a), worldOf([id])).value).toBe(9)
		// The base world resolves 9 ≠ the 1 an unaware subscriber rendered:
		// that subscriber is owed a repair render.
		expect(resolveState(nodeOf(a), worldOf([])).value).toBe(9)
	})
})

describe('dispatch-order replay (React updater-queue arithmetic)', () => {
	test('custom equality is applied after every visible intent', () => {
		const base = { value: 1, source: 'base' }
		const equal = { value: 1, source: 'equal-set' }
		const a = signal(base, { equals: (left, right) => left.value === right.value })
		const id = inDraft(() => {
			a.set(equal)
			a.update((previous) => ({
				value: previous === base ? 2 : 3,
				source: previous.source,
			}))
		})
		expect(stateIn(a, [id])).toEqual(valueState({ value: 2, source: 'base' }))
		retireDraft(id)
		expect(a.get()).toEqual({ value: 2, source: 'base' })
	})

	test('a drafted updater cannot read a signal when replayed', () => {
		const source = signal(10)
		const target = signal(1)
		const id = inDraft(() => target.update((value) => value + source.get()))
		expect(() => stateIn(target, [id])).toThrow(/reads are not allowed/)
		expect(target.get()).toBe(1)
		discardDraft(id)
	})

	test('a rejected urgent updater does not append to an existing rebase log', () => {
		const source = signal(10)
		const target = signal(1)
		const id = inDraft(() => target.set(2))
		expect(() => target.update((value) => value + source.get())).toThrow(/reads are not allowed/)
		expect(target.get()).toBe(1)
		expect(stateIn(target, [id])).toEqual(valueState(2))
		discardDraft(id)
	})

	test('ReducerAtom dispatches replay in intent order', () => {
		const count = reducerAtom((state: number, action: number) => state + action, 1)
		const id = inDraft(() => count.dispatch(2))
		count.dispatch(10)
		expect(count.get()).toBe(11)
		expect(stateIn(count, [id])).toEqual(valueState(13))
		retireDraft(id)
		expect(count.get()).toBe(13)
	})

	test('transition +1 then urgent *2: urgent shows 2, world shows (1+1)*2', () => {
		const a = signal(1)
		const id = inDraft(() => a.update((x) => x + 1))
		a.update((x) => x * 2)
		expect(read(a)).toBe(2) // urgent skipped the draft, applied *2 to base 1
		expect(stateIn(a, [id])).toEqual(valueState(4)) // (1+1)*2
		retireDraft(id)
		expect(read(a)).toBe(4)
	})

	test('transition +2 then urgent *2: urgent shows 2, lands at 6 — replay, not reorder', () => {
		const a = signal(1)
		const id = inDraft(() => a.update((x) => x + 2))
		a.update((x) => x * 2)
		expect(read(a)).toBe(2)
		expect(stateIn(a, [id])).toEqual(valueState(6)) // (1+2)*2
		retireDraft(id)
		expect(read(a)).toBe(6)
	})

	test('[falsify-first, oracle catch seed 5] an urgent equality-cutoff write on a drafted cell re-wakes the draft audience', () => {
		// An urgent intent on a drafted cell rebases the pending worlds even
		// when the base-state write cuts off on equality: replaying …+1 gives
		// 6, but …+1…set(5) gives 5. No wave runs (base state never moved), so without
		// an explicit poke-and-wake the draft's audience keeps the pre-rebase
		// value and the transition would commit it.
		const a = signal(5)
		const d = openDraft()
		const wakes: number[] = []
		const unsub = observeNode(
			nodeOf(a),
			() => {},
			(id) => wakes.push(id),
		)
		runInDraft(d, () => a.update((x) => x + 1))
		expect(wakes).toEqual([d.id])
		expect(stateIn(a, [d.id])).toEqual(valueState(6))
		a.set(5) // equality cutoff: base state stays 5, no propagation
		expect(stateIn(a, [d.id])).toEqual(valueState(5)) // ...but the replay rebased
		expect(wakes).toEqual([d.id, d.id]) // and the audience heard about it
		retireDraft(d.id)
		expect(read(a)).toBe(5)
		unsub()
	})

	test('[oracle seed 653] base movement after draft open disables the producer cutoff', () => {
		const a = signal(7)
		const ids: DraftId[] = []
		let view = a.get()
		const render = () => {
			view = resolveState(nodeOf(a), worldOf(ids)).value as number
		}
		const off = observeNode(nodeOf(a), render, (id) => {
			ids.push(id)
			render()
		})
		const d = openDraft()

		a.set(18)
		expect(latest(a)).toBe(18) // seeds the draft-world memo at 18
		a.set(14)
		a.update((value) => value + 2)
		expect(view).toBe(16) // urgent delivery advanced the subscriber, not that memo

		runInDraft(d, () => a.update((value) => value + 2))
		expect(view).toBe(18) // the draft wake must not cut off against stale 18

		discardDraft(d.id)
		off()
	})

	test('two drafts interleaved with urgent writes replay in dispatch order', () => {
		const a = signal(1)
		const d1 = inDraft(() => a.update((x) => x + 1)) // seq1
		a.update((x) => x * 10) // seq2 urgent
		const d2 = inDraft(() => a.update((x) => x + 3)) // seq3
		expect(read(a)).toBe(10)
		expect(stateIn(a, [d1])).toEqual(valueState(20)) // (1+1)*10
		expect(stateIn(a, [d2])).toEqual(valueState(13)) // 1*10+3
		expect(stateIn(a, [d1, d2])).toEqual(valueState(23)) // (1+1)*10+3
		retireDraft(d1)
		expect(read(a)).toBe(20)
		// d2's world resolves the same values before and after d1's fold.
		expect(stateIn(a, [d1, d2])).toEqual(valueState(23))
		expect(stateIn(a, [d2])).toEqual(valueState(23))
		retireDraft(d2)
		expect(read(a)).toBe(23)
	})
})

describe('computeds across worlds', () => {
	test('one live draft cuts off equal computed value wakes but still pokes probes', () => {
		const a = signal(1)
		const parity = computed(() => a.get() & 1)
		expect(parity.get()).toBe(1)
		const wakes: DraftId[] = []
		let probes = 0
		const offValue = observeNode(
			nodeOf(parity),
			() => {},
			(id) => wakes.push(id),
		)
		const offProbe = observeNode(nodeOf(parity), () => probes++)
		const d = openDraft()

		runInDraft(d, () => a.set(3))
		expect(wakes).toEqual([]) // parity stayed 1: no value-hook wake
		expect(probes).toBe(1) // pendingness still changed

		runInDraft(d, () => a.set(2))
		expect(wakes).toEqual([d.id]) // parity changed 1 -> 0
		expect(probes).toBe(2)
		wakes.length = 0
		expect(stateIn(parity, [d.id])).toEqual(valueState(0)) // a held render observed 0

		runInDraft(d, () => a.set(4))
		expect(wakes).toEqual([]) // repeated append kept the draft-world value at 0
		runInDraft(d, () => a.set(3))
		expect(wakes).toEqual([d.id]) // returning to 1 must repair the held render

		discardDraft(d.id)
		offProbe()
		offValue()
	})

	test('a draft that ever overlapped retains conservative value wakes', () => {
		const a = signal(1)
		const parity = computed(() => a.get() & 1)
		expect(parity.get()).toBe(1)
		const wakes: DraftId[] = []
		const off = observeNode(
			nodeOf(parity),
			() => {},
			(id) => wakes.push(id),
		)
		const first = openDraft()
		const second = openDraft()
		discardDraft(second.id)

		runInDraft(first, () => a.set(3))
		expect(wakes).toEqual([first.id]) // cutoff stays disabled after overlap ends

		discardDraft(first.id)
		off()
	})

	test('a draft evaluation receives the last settled canonical value as previous', () => {
		const a = signal(1)
		const seen: Array<number | undefined> = []
		const c = computed<number>((_use, previous) => {
			seen.push(previous)
			return a.get() * 2
		})
		expect(c.get()).toBe(2)
		const id = inDraft(() => a.set(3))
		expect(stateIn(c, [id])).toEqual(valueState(6))
		expect(seen).toEqual([undefined, 2])
		retireDraft(id)
	})

	test('a draft evaluation cannot read itself through get() or latest()', () => {
		const recurse = signal(false)
		let direct!: Computed<number>
		direct = computed(() => (recurse.get() ? direct.get() : 1))
		let newest!: Computed<number>
		newest = computed(() => (recurse.get() ? latest(newest) : 1))
		expect(direct.get()).toBe(1)
		expect(newest.get()).toBe(1)

		const id = inDraft(() => recurse.set(true))
		expect(() => latest(direct)).toThrow(/cycle detected in computed/)
		expect(() => latest(newest)).toThrow(/cycle detected in computed/)
		discardDraft(id)
	})

	test('committed() cannot select a root from inside a computed', () => {
		const source = signal(1)
		const root = {}
		const reader = computed(() => committed(source, root))
		expect(() => reader.get()).toThrow(/committed\(\).*inside a computed/)
		const untrackedReader = computed(() => untracked(() => committed(source, root)))
		expect(() => untrackedReader.get()).toThrow(/committed\(\).*inside a computed/)
	})

	test('committed() cannot select a root during a draft evaluation', () => {
		const branch = signal(false)
		const source = signal(1)
		const root = {}
		const reader = computed(() => (branch.get() ? committed(source, root) : source.get()))
		expect(reader.get()).toBe(1)
		const id = inDraft(() => branch.set(true))
		expect(() => latest(reader)).toThrow(/committed\(\).*inside a computed/)
		discardDraft(id)
	})

	test('committed() self-read is a cycle', () => {
		const root = {}
		let self!: Computed<number>
		self = computed(() => committed(self, root))
		expect(() => self.get()).toThrow(/cycle detected in computed/)
	})

	test('a computed cannot read its cached value from another world', () => {
		const branch = signal(false)
		const committedRoot = {}
		let self!: Computed<number>
		self = computed(() => (branch.get() ? committed(self, committedRoot) : 1))
		expect(self.get()).toBe(1)
		const id = inDraft(() => branch.set(true))
		expect(() => latest(self)).toThrow(/cycle detected in computed/)
		discardDraft(id)
	})

	test('writes are also forbidden during draft-world computed evaluation', () => {
		const source = signal(0)
		const target = signal(0)
		const writer = computed(() => {
			source.get()
			target.set(1)
			return 1
		})
		expect(() => writer.get()).toThrow(/writes inside computeds are forbidden/)
		const id = inDraft(() => source.set(1))
		let error: unknown
		try {
			latest(writer)
		} catch (caught) {
			error = caught
		}
		expect(target.get()).toBe(0)
		discardDraft(id)
		expect(error).toBeInstanceOf(Error)
		expect((error as Error).message).toMatch(/writes inside computeds are forbidden/)
	})

	test('a computed resolves per world, with per-world dependency branches', () => {
		const flag = signal(false)
		const left = signal('L')
		const right = signal('R')
		const pick = computed(() => (flag.get() ? right.get() : left.get()))
		expect(read(pick)).toBe('L')
		const id = inDraft(() => flag.set(true))
		expect(read(pick)).toBe('L') // base-state branch untouched
		expect(stateIn(pick, [id])).toEqual(valueState('R'))
		retireDraft(id)
		expect(read(pick)).toBe('R')
	})

	test('world memos keep identity while inputs are stable', () => {
		const a = signal({ n: 1 })
		const c = computed(() => ({ n: a.get().n + 1 }))
		const id = inDraft(() => a.set({ n: 5 }))
		const state1 = stateIn(c, [id])
		const state2 = stateIn(c, [id])
		expect(state1).toBe(state2) // stable identity for unchanged resolution
		expect((state1 as { value: { n: number } }).value.n).toBe(6)
		retireDraft(id)
	})

	test('world memo certificates ignore unrelated graph and draft activity', () => {
		const source = signal(1)
		const unrelated = signal(0)
		let runs = 0
		const c = computed(() => {
			runs++
			return source.get() * 2
		})
		const draft = openDraft()
		runInDraft(draft, () => source.set(2))
		expect(stateIn(c, [draft.id])).toEqual(valueState(4))
		expect(runs).toBe(1)

		unrelated.set(1)
		expect(stateIn(c, [draft.id])).toEqual(valueState(4))
		expect(runs).toBe(1)

		const otherDraft = openDraft()
		runInDraft(otherDraft, () => unrelated.set(2))
		expect(stateIn(c, [draft.id])).toEqual(valueState(4))
		expect(runs).toBe(1)
		discardDraft(otherDraft.id)
		expect(stateIn(c, [draft.id])).toEqual(valueState(4))
		expect(runs).toBe(1)
		discardDraft(draft.id)
	})

	test('a source log revision invalidates only memos that read that source', () => {
		const source = signal(1)
		let runs = 0
		const c = computed(() => {
			runs++
			return source.get() * 2
		})
		const draft = openDraft()
		runInDraft(draft, () => source.set(2))
		expect(stateIn(c, [draft.id])).toEqual(valueState(4))
		expect(runs).toBe(1)

		runInDraft(draft, () => source.set(3))
		expect(stateIn(c, [draft.id])).toEqual(valueState(6))
		expect(runs).toBe(2)

		source.set(10)
		expect(stateIn(c, [draft.id])).toEqual(valueState(20))
		expect(runs).toBe(3)
		discardDraft(draft.id)
	})

	test('an equality-cutoff urgent write still invalidates through the log revision', () => {
		const source = signal(5)
		let runs = 0
		const c = computed(() => {
			runs++
			return source.get()
		})
		const draft = openDraft()
		runInDraft(draft, () => source.update((value) => value + 1))
		expect(stateIn(c, [draft.id])).toEqual(valueState(6))
		expect(runs).toBe(1)

		source.set(5) // canonical equality cutoff; only the rebase log changes
		expect(stateIn(c, [draft.id])).toEqual(valueState(5))
		expect(runs).toBe(2)
		discardDraft(draft.id)
	})

	test('nested memo hits flatten their source certificates', () => {
		const enabled = signal(false)
		const source = signal(0)
		let middleRuns = 0
		let topRuns = 0
		const middle = computed(() => {
			middleRuns++
			return source.get() + 1
		})
		const top = computed(() => {
			topRuns++
			return enabled.get() ? middle.get() : -1
		})
		expect(top.get()).toBe(-1)
		const draft = openDraft()
		runInDraft(draft, () => enabled.set(true))
		expect(stateIn(middle, [draft.id])).toEqual(valueState(1))
		expect(stateIn(top, [draft.id])).toEqual(valueState(1))

		runInDraft(draft, () => source.set(41))
		expect(stateIn(top, [draft.id])).toEqual(valueState(42))
		expect(middleRuns).toBe(2)
		expect(topRuns).toBe(3) // one canonical run plus two draft-world runs
		discardDraft(draft.id)
	})

	test('a canonical previous-value change invalidates its world memo', () => {
		const worldBranch = signal(false)
		const canonicalSource = signal(1)
		let runs = 0
		const c = computed<number>((_use, previous) => {
			runs++
			return worldBranch.get() ? (previous ?? 0) : canonicalSource.get()
		})
		expect(c.get()).toBe(1)
		const draft = openDraft()
		runInDraft(draft, () => worldBranch.set(true))
		expect(stateIn(c, [draft.id])).toEqual(valueState(1))

		canonicalSource.set(2)
		expect(c.get()).toBe(2)
		expect(stateIn(c, [draft.id])).toEqual(valueState(2))
		expect(runs).toBe(4)
		discardDraft(draft.id)
	})

	test('a settled world suspension invalidates an otherwise unchanged certificate', async () => {
		const gate = deferred<number>()
		const enabled = signal(false)
		const c = computed((use) => (enabled.get() ? use(gate.promise) : 0))
		expect(c.get()).toBe(0)
		const draft = openDraft()
		runInDraft(draft, () => enabled.set(true))
		const pending = stateIn(c, [draft.id]) as { flags: number }
		expect(pending.flags & Flag.AsyncSuspended).toBe(Flag.AsyncSuspended)

		gate.resolve(7)
		await tick()
		expect(stateIn(c, [draft.id])).toEqual(valueState(7))
		discardDraft(draft.id)
	})

	test('isPending flips for drafted cells and computeds over them', () => {
		const a = signal(1)
		const c = computed(() => a.get() * 2)
		expect(read(c)).toBe(2) // establish base-state deps
		expect(isPending(a)).toBe(false)
		expect(isPending(c)).toBe(false)
		const id = inDraft(() => a.set(9))
		expect(isPending(a)).toBe(true)
		expect(isPending(c)).toBe(true)
		retireDraft(id)
		expect(isPending(a)).toBe(false)
		expect(isPending(c)).toBe(false)
		expect(read(c)).toBe(18)
	})

	test('isPending is transitive through computeds (Solid 2.0 status forwarding)', () => {
		// Solid 2.0's pending rule: a computed over a pending source is itself
		// pending — status forwards through derivation. A drafted cell two
		// levels down must surface at the top of the chain.
		const a = signal(1)
		const c1 = computed(() => a.get() * 10)
		const c2 = computed(() => c1.get() + 1)
		expect(read(c2)).toBe(11) // establish base-state deps a → c1 → c2
		expect(isPending(c2)).toBe(false)
		const id = inDraft(() => a.set(2))
		expect(isPending(c1)).toBe(true) // direct input
		expect(isPending(c2)).toBe(true) // transitive — through the computed
		retireDraft(id)
		expect(isPending(c2)).toBe(false)
	})

	test('a draft append notifies subscribers of computeds over the cell', () => {
		// Pending probes subscribe to the node they probe, not to its inputs.
		// Draft activity on an input must therefore travel the watched edges
		// down to the subscribers, or a probe over a computed never wakes up —
		// its snapshot would flip (the deps scan sees the drafted cell) but
		// nothing tells it to look.
		const a = signal(1)
		const c = computed(() => a.get() * 2)
		const flips: boolean[] = []
		const unsub = observeNode(nodeOf(c), () => flips.push(isPending(c)))
		expect(read(c)).toBe(2) // establish the watched a -> c edge
		const id = inDraft(() => a.set(9))
		expect(flips).toContain(true) // the append reached the probe
		retireDraft(id)
		expect(flips[flips.length - 1]).toBe(false) // and so did the fold
		expect(read(c)).toBe(18)
		unsub()
	})
})

describe('per-root committed views', () => {
	test('committed(x, container) tracks each root, then converges after fold', () => {
		const a = signal(0)
		const rootA = {}
		const rootB = {}
		const id = inDraft(() => a.set(1))
		setCommittedWorld(rootA, [id]) // root A committed the transition
		setCommittedWorld(rootB, []) // root B still on base
		expect(committed(a, rootA)).toBe(1)
		expect(committed(a, rootB)).toBe(0)
		expect(committed(a)).toBe(0) // no container: base state
		retireDraft(id)
		expect(committed(a, rootA)).toBe(1)
		expect(committed(a, rootB)).toBe(1) // retired drafts resolve as no-ops
	})
})

describe('latest() context resolution', () => {
	// The rule: latest() means "newest intent" only in AMBIENT code. Inside an
	// evaluation context it resolves that context's own world — reading ahead
	// of your world is a tear.

	test('inside a base-state computed evaluation, latest() resolves base state — never a draft', () => {
		const a = signal(1)
		const c = computed(() => latest(a) * 10)
		const id = inDraft(() => a.set(2))
		expect(read(c)).toBe(10) // base-state evaluation must not read ahead
		expect(stateIn(c, [id])).toEqual(valueState(20)) // its own world
		expect(latest(c)).toBe(20) // ambient: newest intent
		retireDraft(id)
		expect(read(c)).toBe(20)
	})

	test('latest() inside a computed is a tracked dependency — no permanent staleness', () => {
		const a = signal(1)
		const c = computed(() => latest(a) + 1)
		expect(read(c)).toBe(2)
		a.set(5)
		expect(read(c)).toBe(6)
	})

	test('latest() inside an effect tracks base state: re-runs on folds, never on draft writes', () => {
		const a = signal(0)
		const seen: number[] = []
		effect(() => {
			seen.push(latest(a))
		})
		a.set(1)
		expect(seen).toEqual([0, 1])
		const id = inDraft(() => a.set(9))
		expect(seen).toEqual([0, 1]) // draft writes are invisible to effects
		retireDraft(id)
		expect(seen).toEqual([0, 1, 9]) // the fold is a write: effect re-runs
	})

	test('render-world resolution is scoped by the provider: outside render, latest() is ambient', () => {
		const a = signal(0)
		let rendering = true
		setRenderWorldProvider(() => (rendering ? [] : null))
		try {
			const id = inDraft(() => a.set(7))
			expect(latest(a)).toBe(0) // an urgent pass's render body: the pass's world, not the draft
			rendering = false
			expect(latest(a)).toBe(7) // ambient again: newest intent
			retireDraft(id)
		} finally {
			setRenderWorldProvider(null)
		}
	})
})

describe('dead-prefix folding', () => {
	test('retirement folds the dead prefix while preserving a later live draft', () => {
		const a = signal(1)
		const first = inDraft(() => a.set(2))
		a.update((value) => value * 10)
		const second = inDraft(() => a.update((value) => value + 3))
		expect(rebaseLogIntentCount(nodeOf(a) as CellNode<unknown>)).toBe(3)

		retireDraft(first)
		expect(a.get()).toBe(20)
		expect(stateIn(a, [second])).toEqual(valueState(23))
		expect(rebaseLogIntentCount(nodeOf(a) as CellNode<unknown>)).toBe(1)

		retireDraft(second)
		expect(rebaseLogIntentCount(nodeOf(a) as CellNode<unknown>)).toBe(0)
	})

	test('discarded intents are skipped while later urgent history folds', () => {
		const a = signal(1)
		const first = inDraft(() => a.set(100))
		a.update((value) => value * 10)
		const second = inDraft(() => a.update((value) => value + 3))

		discardDraft(first)
		expect(a.get()).toBe(10)
		expect(stateIn(a, [second])).toEqual(valueState(13))
		expect(rebaseLogIntentCount(nodeOf(a) as CellNode<unknown>)).toBe(1)
		discardDraft(second)
	})

	test('a live leading intent blocks folding of later retired history', () => {
		const a = signal(1)
		const first = inDraft(() => a.set(2))
		const second = inDraft(() => a.set(3))

		retireDraft(second)
		expect(rebaseLogIntentCount(nodeOf(a) as CellNode<unknown>)).toBe(2)
		expect(a.get()).toBe(3)
		discardDraft(first)
	})

	test('prefix folding preserves references retained by custom equality', () => {
		const base = { value: 1, source: 'base' }
		const equal = { value: 1, source: 'equal-set' }
		const a = signal(base, { equals: (left, right) => left.value === right.value })
		const first = inDraft(() => a.set(equal))
		const second = inDraft(() =>
			a.update((previous) => ({
				value: previous === base ? 2 : 3,
				source: previous.source,
			})),
		)

		retireDraft(first)
		expect(stateIn(a, [second])).toEqual(valueState({ value: 2, source: 'base' }))
		expect(rebaseLogIntentCount(nodeOf(a) as CellNode<unknown>)).toBe(1)
		discardDraft(second)
	})
})

describe('quiescence', () => {
	test('retiring the last draft drops logs and world memos', async () => {
		const a = signal(0)
		const c = computed(() => a.get() + 1)
		const id = inDraft(() => a.set(1))
		stateIn(c, [id])
		expect(liveDraftCount()).toBe(1)
		retireDraft(id)
		expect(liveDraftCount()).toBe(0)
		expect(nodeOf(c).worldMemos).toBeNull()
		expect(nodeOf(a).worldMemos).toBeNull()
	})
})
