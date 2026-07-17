/** Engine-level world semantics: drafts, replay order, fold, views. */
import { describe, expect, test } from "vitest"
import {
  Flag,
  attachTracer,
  createComputed,
  effect,
  isPending,
  latest,
  nodeOf,
  read,
  reducerAtom,
  setRenderWorldProvider,
  createAtom,
  type Computed,
  type Signal,
} from "../src/index.ts"
import {
  BASE_WORLD,
  discardDraft,
  draftsAffecting,
  liveDraftCount,
  openDraft,
  rebaseLogIntentCount,
  resolveState,
  retireDraft,
  runWithDraftWrites,
  worldOf,
  type DraftId,
} from "../src/worlds.ts"
import { observeNode, type CellNode } from "../src/graph.ts"

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
  runWithDraftWrites(d, fn)
  return d.id
}

/** Resolve a handle's state as seen by the world of these draft ids. */
function stateIn(x: Signal<any>, ids: readonly DraftId[]): unknown {
  return resolveState(nodeOf(x), worldOf(ids))
}

/** A drafted world's memo record for a plain value. */
function valueState(value: unknown): { flags: number; value: unknown } {
  return { flags: 0, value }
}

describe("draft visibility", () => {
  test("only async-capable or async states own a throwable payload", () => {
    const atom = createAtom(1)
    const computed = createComputed(() => atom.get())
    expect(Object.hasOwn(resolveState(nodeOf(atom), BASE_WORLD), "throwable")).toBe(false)
    expect(Object.hasOwn(resolveState(nodeOf(computed), BASE_WORLD), "throwable")).toBe(true)

    const draft = openDraft()
    runWithDraftWrites(draft, () => atom.set(2))
    const world = worldOf([draft.id])
    expect(Object.hasOwn(resolveState(nodeOf(atom), world), "throwable")).toBe(false)
    expect(Object.hasOwn(resolveState(nodeOf(computed), world), "throwable")).toBe(false)

    const boom = new Error("boom")
    const failure = createComputed(() => {
      throw boom
    })
    const failed = resolveState(nodeOf(failure), world)
    expect(failed.flags & Flag.AsyncError).toBe(Flag.AsyncError)
    expect(Object.hasOwn(failed, "throwable")).toBe(true)

    const pending = createComputed((use) => use(new Promise<never>(() => {})))
    const suspended = resolveState(nodeOf(pending), world)
    expect(suspended.flags & Flag.AsyncSuspended).toBe(Flag.AsyncSuspended)
    expect(Object.hasOwn(suspended, "throwable")).toBe(true)
    discardDraft(draft.id)
  })

  test("world computation correlates unrelated drafts without inventing one as its cause", () => {
    const source = createAtom(0)
    const unrelated = createAtom(0)
    const computed = createComputed(() => source.get(), { label: "computed" })
    const tracer = attachTracer()
    const sourceDraft = openDraft()
    runWithDraftWrites(sourceDraft, () => source.set(1))
    const unrelatedDraft = openDraft()
    runWithDraftWrites(unrelatedDraft, () => unrelated.set(2))

    expect(stateIn(computed, [sourceDraft.id, unrelatedDraft.id])).toEqual(valueState(1))
    const compute = tracer
      .events()
      .find((event) => event.kind === "compute" && event.label === "computed")!
    expect(compute.cause).toBe(0)
    expect(compute.draftId).toBeUndefined()
    expect(compute.world).toEqual([sourceDraft.id, unrelatedDraft.id])

    tracer.stop()
    discardDraft(unrelatedDraft.id)
    discardDraft(sourceDraft.id)
  })

  test("world computation traces a stable error only when it first becomes the result", () => {
    const boom = new Error("computed boom")
    const source = createAtom(0)
    const computed = createComputed(
      () => {
        source.get()
        throw boom
      },
      { label: "failing computed" },
    )
    const tracer = attachTracer()
    const draft = openDraft()
    runWithDraftWrites(draft, () => source.set(1))
    const world = worldOf([draft.id])

    const first = resolveState(nodeOf(computed), world)
    expect(first.flags & Flag.AsyncError).toBe(Flag.AsyncError)
    const failure = tracer.events().find((event) => event.kind === "compute-error")!
    const firstCompute = tracer.find(failure.cause)!
    expect(firstCompute.kind).toBe("compute")
    expect(failure.error).toBe(boom)
    expect(failure.world).toEqual([draft.id])

    runWithDraftWrites(draft, () => source.set(2))
    expect(resolveState(nodeOf(computed), world)).toBe(first)
    expect(tracer.events().filter((event) => event.kind === "compute-error")).toHaveLength(1)

    tracer.stop()
    discardDraft(draft.id)
  })

  test("a swallowed cutoff replay reports its updater only when an ordinary read propagates it", () => {
    const boom = new Error("updater boom")
    const atom = createAtom(0)
    const computed = createComputed(() => atom.get())
    const stop = effect(
      () => computed.get(),
      () => {},
    )
    const tracer = attachTracer()
    const draft = openDraft()
    runWithDraftWrites(draft, () =>
      atom.update(() => {
        throw boom
      }),
    )
    expect(
      tracer.events().some((event) => event.kind === "callback-error" && event.error === boom),
    ).toBe(false)
    expect(() => stateIn(atom, [draft.id])).toThrow(boom)
    expect(
      tracer.events().some((event) => event.kind === "callback-error" && event.error === boom),
    ).toBe(true)
    tracer.stop()
    stop()
    discardDraft(draft.id)
  })

  test("runWithDraftWrites targets writes only; reads stay in the base world", () => {
    const atom = createAtom(0)
    const draft = openDraft()
    runWithDraftWrites(draft, () => {
      atom.set(1)
      expect(atom.get()).toBe(0)
    })
    expect(stateIn(atom, [draft.id])).toEqual(valueState(1))
    discardDraft(draft.id)
  })

  test("draft writes are invisible to base-state readers until retirement", () => {
    const a = createAtom(0)
    const id = inDraft(() => a.set(1))
    expect(read(a)).toBe(0)
    expect(latest(a)).toBe(1)
    expect(stateIn(a, [id])).toEqual(valueState(1))
    retireDraft(id)
    expect(read(a)).toBe(1)
    expect(latest(a)).toBe(1)
  })

  test("atom.peek reads the current world without creating a graph dependency", () => {
    const atom = createAtom(0)
    const peeked = createComputed(() => atom.peek())
    expect(peeked.get()).toBe(0)
    const draft = openDraft()
    runWithDraftWrites(draft, () => atom.set(1))
    expect(latest(peeked)).toBe(1)
    runWithDraftWrites(draft, () => atom.set(2))
    // The world memo also treats peek as untracked: a later write into the
    // same draft does not invalidate the computed's cached resolution.
    expect(latest(peeked)).toBe(1)
    discardDraft(draft.id)
    atom.set(2)
    // The base computed never subscribed through peek, so its cached base
    // value remains the value from its only tracked evaluation.
    expect(peeked.get()).toBe(0)
  })

  test("retirement folds through the write path: effects run once per fold", () => {
    const a = createAtom(0)
    const b = createAtom(0)
    let runs = 0
    // Fresh tuples never compare equal, so every delivered pull counts.
    effect(
      () => [a.get(), b.get()],
      () => {
        runs++
      },
    )
    const id = inDraft(() => {
      a.set(1)
      b.set(2)
    })
    expect(runs).toBe(1) // drafts do not touch effects
    retireDraft(id)
    expect(runs).toBe(2) // one batched fold
  })

  test("discard rolls back: base state unchanged, latest reverts", () => {
    const a = createAtom(5)
    const id = inDraft(() => a.update((x) => x + 10))
    expect(latest(a)).toBe(15)
    discardDraft(id)
    expect(latest(a)).toBe(5)
    expect(read(a)).toBe(5)
  })

  test("fold loudness is per subscriber: rendered-world resolutions decide who re-renders", () => {
    // There is no global silent/loud fold state: at retire, the fold's
    // writes notify subscribers, and each re-renders only if resolving
    // its own rendered world now differs from what it rendered (the
    // bindings' notify predicate). This pins the engine half of that
    // contract: a carrier's world resolves the same value before and
    // after the fold (retired ids normalize out), while the base world's
    // resolution moves.
    const a = createAtom(1)
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

describe("dispatch-order replay (React updater-queue arithmetic)", () => {
  test("custom equality is applied after every visible intent", () => {
    const base = { value: 1, source: "base" }
    const equal = { value: 1, source: "equal-set" }
    const a = createAtom(base, { equals: (left, right) => left.value === right.value })
    const id = inDraft(() => {
      a.set(equal)
      a.update((previous) => ({
        value: previous === base ? 2 : 3,
        source: previous.source,
      }))
    })
    expect(stateIn(a, [id])).toEqual(valueState({ value: 2, source: "base" }))
    retireDraft(id)
    expect(a.get()).toEqual({ value: 2, source: "base" })
  })

  test("a drafted updater cannot read a signal when replayed", () => {
    const source = createAtom(10)
    const target = createAtom(1)
    const id = inDraft(() => target.update((value) => value + source.get()))
    expect(() => stateIn(target, [id])).toThrow(/reads are not allowed/)
    expect(target.get()).toBe(1)
    discardDraft(id)
  })

  test("a rejected urgent updater does not append to an existing rebase log", () => {
    const source = createAtom(10)
    const target = createAtom(1)
    const id = inDraft(() => target.set(2))
    expect(() => target.update((value) => value + source.get())).toThrow(/reads are not allowed/)
    expect(target.get()).toBe(1)
    expect(stateIn(target, [id])).toEqual(valueState(2))
    discardDraft(id)
  })

  test("ReducerAtom dispatches replay in intent order", () => {
    const count = reducerAtom((state: number, action: number) => state + action, 1)
    const id = inDraft(() => count.dispatch(2))
    count.dispatch(10)
    expect(count.get()).toBe(11)
    expect(stateIn(count, [id])).toEqual(valueState(13))
    retireDraft(id)
    expect(count.get()).toBe(13)
  })

  test("transition +1 then urgent *2: urgent shows 2, world shows (1+1)*2", () => {
    const a = createAtom(1)
    const id = inDraft(() => a.update((x) => x + 1))
    a.update((x) => x * 2)
    expect(read(a)).toBe(2) // urgent skipped the draft, applied *2 to base 1
    expect(stateIn(a, [id])).toEqual(valueState(4)) // (1+1)*2
    retireDraft(id)
    expect(read(a)).toBe(4)
  })

  test("transition +2 then urgent *2: urgent shows 2, lands at 6 — replay, not reorder", () => {
    const a = createAtom(1)
    const id = inDraft(() => a.update((x) => x + 2))
    a.update((x) => x * 2)
    expect(read(a)).toBe(2)
    expect(stateIn(a, [id])).toEqual(valueState(6)) // (1+2)*2
    retireDraft(id)
    expect(read(a)).toBe(6)
  })

  test("[falsify-first, oracle catch seed 5] an urgent equality-cutoff write on a drafted atom re-wakes the draft audience", () => {
    // An urgent intent on a drafted atom rebases the pending worlds even
    // when the base-state write cuts off on equality: replaying …+1 gives
    // 6, but …+1…set(5) gives 5. No wave runs (base state never moved), so without
    // an explicit poke-and-wake the draft's audience keeps the pre-rebase
    // value and the transition would commit it.
    const a = createAtom(5)
    const d = openDraft()
    const wakes: number[] = []
    const unsub = observeNode(
      nodeOf(a),
      () => {},
      (id) => wakes.push(id),
    )
    runWithDraftWrites(d, () => a.update((x) => x + 1))
    expect(wakes).toEqual([d.id])
    expect(stateIn(a, [d.id])).toEqual(valueState(6))
    a.set(5) // equality cutoff: base state stays 5, no propagation
    expect(stateIn(a, [d.id])).toEqual(valueState(5)) // ...but the replay rebased
    expect(wakes).toEqual([d.id, d.id]) // and the audience heard about it
    retireDraft(d.id)
    expect(read(a)).toBe(5)
    unsub()
  })

  test("[oracle seed 653] base movement after draft open disables the producer cutoff", () => {
    const a = createAtom(7)
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

    runWithDraftWrites(d, () => a.update((value) => value + 2))
    expect(view).toBe(18) // the draft wake must not cut off against stale 18

    discardDraft(d.id)
    off()
  })

  test("two drafts interleaved with urgent writes replay in dispatch order", () => {
    const a = createAtom(1)
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

describe("computeds across worlds", () => {
  test("one live draft cuts off equal computed value wakes but still pokes probes", () => {
    const a = createAtom(1)
    const parity = createComputed(() => a.get() & 1)
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

    runWithDraftWrites(d, () => a.set(3))
    expect(wakes).toEqual([]) // parity stayed 1: no value-hook wake
    expect(probes).toBe(1) // pendingness still changed

    runWithDraftWrites(d, () => a.set(2))
    expect(wakes).toEqual([d.id]) // parity changed 1 -> 0
    expect(probes).toBe(2)
    wakes.length = 0
    expect(stateIn(parity, [d.id])).toEqual(valueState(0)) // a held render observed 0

    runWithDraftWrites(d, () => a.set(4))
    expect(wakes).toEqual([]) // repeated append kept the draft-world value at 0
    runWithDraftWrites(d, () => a.set(3))
    expect(wakes).toEqual([d.id]) // returning to 1 must repair the held render

    discardDraft(d.id)
    offProbe()
    offValue()
  })

  test("a draft that ever overlapped retains conservative value wakes", () => {
    const a = createAtom(1)
    const parity = createComputed(() => a.get() & 1)
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

    runWithDraftWrites(first, () => a.set(3))
    expect(wakes).toEqual([first.id]) // cutoff stays disabled after overlap ends

    discardDraft(first.id)
    off()
  })

  test("a draft evaluation receives the last settled canonical value as previous", () => {
    const a = createAtom(1)
    const seen: Array<number | undefined> = []
    const c = createComputed<number>((_use, previous) => {
      seen.push(previous)
      return a.get() * 2
    })
    expect(c.get()).toBe(2)
    const id = inDraft(() => a.set(3))
    expect(stateIn(c, [id])).toEqual(valueState(6))
    expect(seen).toEqual([undefined, 2])
    retireDraft(id)
  })

  test("a draft evaluation cannot read itself through get() or latest()", () => {
    const recurse = createAtom(false)
    let direct!: Computed<number>
    direct = createComputed(() => (recurse.get() ? direct.get() : 1))
    let newest!: Computed<number>
    newest = createComputed(() => (recurse.get() ? latest(newest) : 1))
    expect(direct.get()).toBe(1)
    expect(newest.get()).toBe(1)

    const id = inDraft(() => recurse.set(true))
    expect(() => latest(direct)).toThrow(/cycle detected in computed/)
    expect(() => latest(newest)).toThrow(/cycle detected in computed/)
    discardDraft(id)
  })

  test("writes are also forbidden during draft-world computed evaluation", () => {
    const source = createAtom(0)
    const target = createAtom(0)
    const writer = createComputed(() => {
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

  test("a computed resolves per world, with per-world dependency branches", () => {
    const flag = createAtom(false)
    const left = createAtom("L")
    const right = createAtom("R")
    const pick = createComputed(() => (flag.get() ? right.get() : left.get()))
    expect(read(pick)).toBe("L")
    const id = inDraft(() => flag.set(true))
    expect(read(pick)).toBe("L") // base-state branch untouched
    expect(stateIn(pick, [id])).toEqual(valueState("R"))
    retireDraft(id)
    expect(read(pick)).toBe("R")
  })

  test("world memos keep identity while inputs are stable", () => {
    const a = createAtom({ n: 1 })
    const c = createComputed(() => ({ n: a.get().n + 1 }))
    const id = inDraft(() => a.set({ n: 5 }))
    const state1 = stateIn(c, [id])
    const state2 = stateIn(c, [id])
    expect(state1).toBe(state2) // stable identity for unchanged resolution
    expect((state1 as { value: { n: number } }).value.n).toBe(6)
    retireDraft(id)
  })

  test("cached world membership survives unrelated draft writes", () => {
    const included = openDraft()
    const unrelated = openDraft()
    const ids = [included.id]
    const first = worldOf(ids)
    const atom = createAtom(0)
    try {
      runWithDraftWrites(unrelated, () => atom.set(1))
      expect(worldOf(ids)).toBe(first)
      retireDraft(included.id)
      expect(worldOf(ids).drafts).toEqual([])
    } finally {
      discardDraft(unrelated.id)
      discardDraft(included.id)
    }
  })

  test("world memo certificates ignore unrelated graph and draft activity", () => {
    const source = createAtom(1)
    const unrelated = createAtom(0)
    let runs = 0
    const c = createComputed(() => {
      runs++
      return source.get() * 2
    })
    const draft = openDraft()
    runWithDraftWrites(draft, () => source.set(2))
    expect(stateIn(c, [draft.id])).toEqual(valueState(4))
    expect(runs).toBe(1)

    unrelated.set(1)
    expect(stateIn(c, [draft.id])).toEqual(valueState(4))
    expect(runs).toBe(1)

    const otherDraft = openDraft()
    runWithDraftWrites(otherDraft, () => unrelated.set(2))
    expect(stateIn(c, [draft.id])).toEqual(valueState(4))
    expect(runs).toBe(1)
    discardDraft(otherDraft.id)
    expect(stateIn(c, [draft.id])).toEqual(valueState(4))
    expect(runs).toBe(1)
    discardDraft(draft.id)
  })

  test("a source log revision invalidates only memos that read that source", () => {
    const source = createAtom(1)
    let runs = 0
    const c = createComputed(() => {
      runs++
      return source.get() * 2
    })
    const draft = openDraft()
    runWithDraftWrites(draft, () => source.set(2))
    expect(stateIn(c, [draft.id])).toEqual(valueState(4))
    expect(runs).toBe(1)

    runWithDraftWrites(draft, () => source.set(3))
    expect(stateIn(c, [draft.id])).toEqual(valueState(6))
    expect(runs).toBe(2)

    source.set(10)
    expect(stateIn(c, [draft.id])).toEqual(valueState(20))
    expect(runs).toBe(3)
    discardDraft(draft.id)
  })

  test("an equality-cutoff urgent write still invalidates through the log revision", () => {
    const source = createAtom(5)
    let runs = 0
    const c = createComputed(() => {
      runs++
      return source.get()
    })
    const draft = openDraft()
    runWithDraftWrites(draft, () => source.update((value) => value + 1))
    expect(stateIn(c, [draft.id])).toEqual(valueState(6))
    expect(runs).toBe(1)

    source.set(5) // canonical equality cutoff; only the rebase log changes
    expect(stateIn(c, [draft.id])).toEqual(valueState(5))
    expect(runs).toBe(2)
    discardDraft(draft.id)
  })

  test("nested memo hits flatten their source certificates", () => {
    const enabled = createAtom(false)
    const source = createAtom(0)
    let middleRuns = 0
    let topRuns = 0
    const middle = createComputed(() => {
      middleRuns++
      return source.get() + 1
    })
    const top = createComputed(() => {
      topRuns++
      return enabled.get() ? middle.get() : -1
    })
    expect(top.get()).toBe(-1)
    const draft = openDraft()
    runWithDraftWrites(draft, () => enabled.set(true))
    expect(stateIn(middle, [draft.id])).toEqual(valueState(1))
    expect(stateIn(top, [draft.id])).toEqual(valueState(1))

    runWithDraftWrites(draft, () => source.set(41))
    expect(stateIn(top, [draft.id])).toEqual(valueState(42))
    expect(middleRuns).toBe(2)
    expect(topRuns).toBe(3) // one canonical run plus two draft-world runs
    discardDraft(draft.id)
  })

  test("a canonical previous-value change invalidates its world memo", () => {
    const worldBranch = createAtom(false)
    const canonicalSource = createAtom(1)
    let runs = 0
    const c = createComputed<number>((_use, previous) => {
      runs++
      return worldBranch.get() ? (previous ?? 0) : canonicalSource.get()
    })
    expect(c.get()).toBe(1)
    const draft = openDraft()
    runWithDraftWrites(draft, () => worldBranch.set(true))
    expect(stateIn(c, [draft.id])).toEqual(valueState(1))

    canonicalSource.set(2)
    expect(c.get()).toBe(2)
    expect(stateIn(c, [draft.id])).toEqual(valueState(2))
    expect(runs).toBe(4)
    discardDraft(draft.id)
  })

  test("a settled world suspension invalidates an otherwise unchanged certificate", async () => {
    const gate = deferred<number>()
    const enabled = createAtom(false)
    const c = createComputed((use) => (enabled.get() ? use(gate.promise) : 0))
    expect(c.get()).toBe(0)
    const draft = openDraft()
    runWithDraftWrites(draft, () => enabled.set(true))
    const pending = stateIn(c, [draft.id]) as { flags: number }
    expect(pending.flags & Flag.AsyncSuspended).toBe(Flag.AsyncSuspended)

    gate.resolve(7)
    await tick()
    expect(stateIn(c, [draft.id])).toEqual(valueState(7))
    discardDraft(draft.id)
  })

  test("a world suspension is stable for one pending span and fresh for the next", async () => {
    const firstGate = deferred<number>()
    const secondGate = deferred<number>()
    const phase = createAtom(0)
    let runs = 0
    const c = createComputed((use) => {
      runs++
      return use(phase.get() === 0 ? firstGate.promise : secondGate.promise)
    })
    const draft = openDraft()
    const first = stateIn(c, [draft.id]) as { flags: number; throwable: unknown }
    expect(first.flags & Flag.AsyncSuspended).toBe(Flag.AsyncSuspended)

    runWithDraftWrites(draft, () => phase.set(0))
    const retry = stateIn(c, [draft.id]) as { flags: number; throwable: unknown }
    expect(runs).toBe(2)
    expect(retry).toBe(first)
    expect(retry.throwable).toBe(first.throwable)

    firstGate.resolve(7)
    await tick()
    expect(stateIn(c, [draft.id])).toEqual(valueState(7))

    runWithDraftWrites(draft, () => phase.set(1))
    const next = stateIn(c, [draft.id]) as { flags: number; throwable: unknown }
    expect(next.flags & Flag.AsyncSuspended).toBe(Flag.AsyncSuspended)
    expect(next.throwable).not.toBe(first.throwable)
    discardDraft(draft.id)
  })

  test("isPending flips for drafted atoms and computeds over them", () => {
    const a = createAtom(1)
    const c = createComputed(() => a.get() * 2)
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

  test("isPending is transitive through computeds", () => {
    // A computed over a pending source is itself pending — status
    // forwards through derivation. A drafted atom two levels down must
    // surface at the top of the chain.
    const a = createAtom(1)
    const c1 = createComputed(() => a.get() * 10)
    const c2 = createComputed(() => c1.get() + 1)
    expect(read(c2)).toBe(11) // establish base-state deps a → c1 → c2
    expect(isPending(c2)).toBe(false)
    const id = inDraft(() => a.set(2))
    expect(isPending(c1)).toBe(true) // direct input
    expect(isPending(c2)).toBe(true) // transitive — through the computed
    retireDraft(id)
    expect(isPending(c2)).toBe(false)
  })

  test("isPending follows current dependencies and live intents during overlapping teardown", () => {
    const chooseLeft = createAtom(true)
    const left = createAtom(0)
    const right = createAtom(0)
    const selected = createComputed(() => (chooseLeft.get() ? left.get() : right.get()))
    const flips: boolean[] = []
    const unsub = observeNode(nodeOf(selected), () => flips.push(isPending(selected)))
    expect(read(selected)).toBe(0)

    const leftDraft = inDraft(() => left.set(1))
    expect(isPending(selected)).toBe(true)
    chooseLeft.set(false)
    expect(read(selected)).toBe(0)
    expect(isPending(selected)).toBe(false)

    const firstRightDraft = inDraft(() => right.set(1))
    const secondRightDraft = inDraft(() => right.set(2))
    expect(isPending(selected)).toBe(true)
    discardDraft(firstRightDraft)
    expect(isPending(selected)).toBe(true)

    flips.length = 0
    retireDraft(secondRightDraft)
    // Fold notifications run before releaseDraft removes the retired intent.
    // Pendingness must inspect draft state instead of treating log presence
    // as a live draft.
    expect(flips[flips.length - 1]).toBe(false)
    expect(isPending(selected)).toBe(false)

    discardDraft(leftDraft)
    unsub()
  })

  test("draft discovery dedupes shared dependencies and keeps draft order", () => {
    const a = createAtom(1)
    const b = createAtom(2)
    const unrelated = createAtom(3)
    const left = createComputed(() => a.get() + b.get())
    const right = createComputed(() => b.get() - a.get())
    const root = createComputed(() => left.get() * right.get())
    expect(read(root)).toBe(3)
    const first = inDraft(() => a.set(4))
    const ignored = inDraft(() => unrelated.set(5))
    const second = inDraft(() => b.set(6))

    expect(draftsAffecting(nodeOf(root))).toEqual([first, second])

    discardDraft(second)
    discardDraft(ignored)
    discardDraft(first)
  })

  test("a draft append notifies subscribers of computeds over the atom", () => {
    // Pending probes subscribe to the node they probe, not to its inputs.
    // Draft activity on an input must therefore travel the watched edges
    // down to the subscribers, or a probe over a computed never wakes up —
    // its snapshot would flip (the deps scan sees the drafted atom) but
    // nothing tells it to look.
    const a = createAtom(1)
    const c = createComputed(() => a.get() * 2)
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

describe("the committed view is base state", () => {
  test("ambient reads hide drafts and converge at retirement", () => {
    const a = createAtom(0)
    const id = inDraft(() => a.set(1))
    expect(read(a)).toBe(0) // the draft is invisible
    expect(latest(a)).toBe(1)
    retireDraft(id)
    expect(read(a)).toBe(1) // the fold landed in base state
  })
})

describe("latest() context resolution", () => {
  // latest() means "newest view" only in ambient code. Inside
  // an evaluation context it resolves that context's own world — reading
  // ahead of your world is a tear.

  test("inside a base-state computed evaluation, latest() resolves base state — never a draft", () => {
    const a = createAtom(1)
    const c = createComputed(() => latest(a) * 10)
    const id = inDraft(() => a.set(2))
    expect(read(c)).toBe(10) // base-state evaluation must not read ahead
    expect(stateIn(c, [id])).toEqual(valueState(20)) // its own world
    expect(latest(c)).toBe(20) // ambient: newest intent
    retireDraft(id)
    expect(read(c)).toBe(20)
  })

  test("latest() inside a computed is a tracked dependency — no permanent staleness", () => {
    const a = createAtom(1)
    const c = createComputed(() => latest(a) + 1)
    expect(read(c)).toBe(2)
    a.set(5)
    expect(read(c)).toBe(6)
  })

  test("latest() inside an effect tracks base state: re-runs on folds, never on draft writes", () => {
    const a = createAtom(0)
    const seen: number[] = []
    effect(
      () => latest(a),
      (v) => {
        seen.push(v)
      },
    )
    a.set(1)
    expect(seen).toEqual([0, 1])
    const id = inDraft(() => a.set(9))
    expect(seen).toEqual([0, 1]) // draft writes are invisible to effects
    retireDraft(id)
    expect(seen).toEqual([0, 1, 9]) // the fold is a write: effect re-runs
  })

  test("render-world resolution is scoped by the provider: outside render, latest() is ambient", () => {
    const a = createAtom(0)
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

describe("dead-prefix folding", () => {
  test("retirement folds the dead prefix while preserving a later live draft", () => {
    const a = createAtom(1)
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

  test("discarded intents are skipped while later urgent history folds", () => {
    const a = createAtom(1)
    const first = inDraft(() => a.set(100))
    a.update((value) => value * 10)
    const second = inDraft(() => a.update((value) => value + 3))

    discardDraft(first)
    expect(a.get()).toBe(10)
    expect(stateIn(a, [second])).toEqual(valueState(13))
    expect(rebaseLogIntentCount(nodeOf(a) as CellNode<unknown>)).toBe(1)
    discardDraft(second)
  })

  test("a live leading intent blocks folding of later retired history", () => {
    const a = createAtom(1)
    const first = inDraft(() => a.set(2))
    const second = inDraft(() => a.set(3))

    retireDraft(second)
    expect(rebaseLogIntentCount(nodeOf(a) as CellNode<unknown>)).toBe(2)
    expect(a.get()).toBe(3)
    discardDraft(first)
  })

  test("prefix folding preserves references retained by custom equality", () => {
    const base = { value: 1, source: "base" }
    const equal = { value: 1, source: "equal-set" }
    const a = createAtom(base, { equals: (left, right) => left.value === right.value })
    const first = inDraft(() => a.set(equal))
    const second = inDraft(() =>
      a.update((previous) => ({
        value: previous === base ? 2 : 3,
        source: previous.source,
      })),
    )

    retireDraft(first)
    expect(stateIn(a, [second])).toEqual(valueState({ value: 2, source: "base" }))
    expect(rebaseLogIntentCount(nodeOf(a) as CellNode<unknown>)).toBe(1)
    discardDraft(second)
  })
})

describe("quiescence", () => {
  test("a nested last discard clears logs before the outer retirement notification returns", () => {
    const retiring = createAtom(0)
    const discarded = createAtom(0)
    const retiringDraft = inDraft(() => retiring.set(1))
    const discardedDraft = inDraft(() => discarded.set(1))
    const total = createComputed(() => retiring.get() + discarded.get())
    stateIn(total, [retiringDraft, discardedDraft])
    let retiringLogDuringNotification = -1
    let memosClearedDuringNotification = false
    const unsubscribe = observeNode(nodeOf(retiring), () => {
      discardDraft(discardedDraft)
      retiringLogDuringNotification = rebaseLogIntentCount(nodeOf(retiring) as CellNode<unknown>)
      memosClearedDuringNotification = nodeOf(total).worldMemos === null
    })

    retireDraft(retiringDraft)

    expect(retiringLogDuringNotification).toBe(0)
    expect(memosClearedDuringNotification).toBe(true)
    expect(rebaseLogIntentCount(nodeOf(discarded) as CellNode<unknown>)).toBe(0)
    expect(retiring.get()).toBe(1)
    expect(discarded.get()).toBe(0)
    unsubscribe()
  })

  test("retiring the last draft drops logs and world memos", async () => {
    const a = createAtom(0)
    const c = createComputed(() => a.get() + 1)
    expect(Object.hasOwn(nodeOf(a), "worldMemos")).toBe(true)
    expect(Object.hasOwn(nodeOf(c), "worldMemos")).toBe(true)
    const id = inDraft(() => a.set(1))
    stateIn(c, [id])
    expect(liveDraftCount()).toBe(1)
    retireDraft(id)
    expect(liveDraftCount()).toBe(0)
    expect(nodeOf(c).worldMemos).toBeNull()
    expect(nodeOf(a).worldMemos).toBeNull()
  })
})
