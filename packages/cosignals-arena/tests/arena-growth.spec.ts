/**
 * Arena growth (docs/arena-growth.md): automatic doubling below the
 * quarter-capacity gap, explicit growCapacity(), and the in-place
 * migration — node region verbatim, link region relocated by delta.
 *
 * Every test shrinks the arena to a few hundred records first so growth
 * is reachable without allocating millions of nodes.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import {
  batch,
  createAtom,
  createComputed,
  createEffect,
  endBatch,
  flushScheduledEffects,
  growCapacity,
  startBatch,
} from "../src/core.ts"
import { arenaStats, setArenaCapacityForTesting } from "../src/testing.ts"
import { resetGraphForBenchmark } from "../src/signals.ts"
import { nodeOf } from "../src/unstable.ts"
import {
  discardDraft,
  openDraft,
  resolveState,
  runWithDraftWrites,
  worldOf,
} from "../src/worlds.ts"

const DEFAULT_CAPACITY = 2_097_152
const microtasks = () => Promise.resolve()

// The node bump pointer never rewinds while handles live, so each test
// starts from a rewound arena — shrinking requires the live regions to fit.
beforeEach(() => {
  resetGraphForBenchmark()
})

afterEach(() => {
  setArenaCapacityForTesting(DEFAULT_CAPACITY)
})

describe("automatic growth", () => {
  test("doubles capacity once the free gap falls below a quarter", async () => {
    setArenaCapacityForTesting(1024)
    const cells = Array.from({ length: 170 }, (_, i) => createAtom(i))
    const sums = cells.map((c) => createComputed(() => c.get() + 1))
    const stops = sums.map((s) => createEffect(s, () => {}))
    // ~850 of 1024 records used: past the 768-record trigger, growth is
    // scheduled but must not have applied synchronously.
    expect(arenaStats().capacityRecords).toBe(1024)
    await microtasks()
    expect(arenaStats().capacityRecords).toBe(2048)
    // The migrated graph still propagates: relocated subs/deps chains work.
    cells[0].set(100)
    expect(sums[0].get()).toBe(101)
    for (const stop of stops) {
      stop()
    }
  })

  test("keeps growing across repeated bursts", async () => {
    setArenaCapacityForTesting(256)
    const cells: Array<ReturnType<typeof createAtom<number>>> = []
    const stops: Array<() => void> = []
    const seen: number[] = []
    // Each round fits inside the quarter headroom that remains after the
    // trigger fires, so no round outruns its growth microtask.
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 20; i++) {
        const a = createAtom(0)
        cells.push(a)
        const c = createComputed(() => a.get() * 2)
        stops.push(
          createEffect(c, (v) => {
            if (v !== 0) {
              seen.push(v)
            }
          }),
        )
      }
      await microtasks()
    }
    // 80 triples ≈ 400 records; 256 must have doubled at least twice.
    expect(arenaStats().capacityRecords).toBeGreaterThanOrEqual(1024)
    // The very first subscription predates every migration and still hears
    // its cell: its links were relocated correctly each time.
    cells[0]!.set(41)
    cells[cells.length - 1]!.set(42)
    expect(seen).toEqual([82, 84])
    for (const stop of stops) {
      stop()
    }
  })

  test("a synchronous burst through the whole remaining arena still throws", () => {
    setArenaCapacityForTesting(64)
    expect(() => {
      for (let i = 0; i < 100; i++) {
        const a = createAtom(i)
        const c = createComputed(() => a.get())
        createEffect(c, () => {})
      }
    }).toThrow(RangeError)
  })
})

describe("growCapacity", () => {
  test("applies at the next microtask on a touched arena", async () => {
    setArenaCapacityForTesting(1024)
    const a = createAtom(1)
    const c = createComputed(() => a.get() * 2)
    const stop = createEffect(c, () => {})
    growCapacity(4096)
    expect(arenaStats().capacityRecords).toBe(1024)
    await microtasks()
    expect(arenaStats().capacityRecords).toBe(4096)
    a.set(5)
    expect(c.get()).toBe(10)
    stop()
  })

  test("applies immediately on an untouched arena", () => {
    resetGraphForBenchmark()
    setArenaCapacityForTesting(1024)
    growCapacity(4096)
    expect(arenaStats().capacityRecords).toBe(4096)
  })

  test("requests at or below current capacity are no-ops", async () => {
    setArenaCapacityForTesting(4096)
    growCapacity(4096)
    growCapacity(100)
    await microtasks()
    expect(arenaStats().capacityRecords).toBe(4096)
  })

  test("defers while a batch is held across await, applies when it closes", async () => {
    setArenaCapacityForTesting(1024)
    const a = createAtom(0)
    createComputed(() => a.get()).get() // touch the arena
    startBatch()
    growCapacity(8192)
    await microtasks()
    expect(arenaStats().capacityRecords).toBe(1024)
    endBatch()
    await microtasks()
    expect(arenaStats().capacityRecords).toBe(8192)
  })

  test("rejects requests past the record ceiling", () => {
    expect(() => growCapacity(2 ** 27 + 1)).toThrow(RangeError)
    expect(() => growCapacity(0)).toThrow(TypeError)
    expect(() => growCapacity(Number.NaN)).toThrow(TypeError)
  })
})

describe("migration correctness", () => {
  test("freed links relocate with the free stack and are reusable", async () => {
    setArenaCapacityForTesting(1024)
    const a = createAtom(1)
    const b = createAtom(2)
    const flag = createAtom(true)
    const c = createComputed(() => (flag.get() ? a.get() : b.get()))
    const seen: number[] = []
    const stop = createEffect(c, (v) => {
      seen.push(v)
    })
    expect(seen).toEqual([1])
    flag.set(false) // retrack drops the a-edge onto the free-link stack
    expect(seen).toEqual([1, 2])
    growCapacity(4096)
    await microtasks()
    expect(arenaStats().capacityRecords).toBe(4096)
    flag.set(true) // reuses the relocated freed link
    expect(seen).toEqual([1, 2, 1])
    a.set(10)
    expect(seen).toEqual([1, 2, 1, 10])
    stop()
    // Disposal after migration walks relocated dep and subs chains.
    b.set(20)
    expect(c.get()).toBe(10)
  })

  test("queued deferred-lane effects survive a migration", async () => {
    setArenaCapacityForTesting(1024)
    const a = createAtom(0)
    const seen: number[] = []
    const stop = createEffect(
      a,
      (v) => {
        seen.push(v)
      },
      { schedule: "useEffect" },
    )
    expect(seen).toEqual([0])
    a.set(1) // enqueued as an (id, generation) pair for the deferred drain
    growCapacity(4096)
    await microtasks()
    expect(arenaStats().capacityRecords).toBe(4096)
    flushScheduledEffects()
    expect(seen).toEqual([0, 1])
    stop()
  })

  test("captures created before growth reach the successor generation", async () => {
    setArenaCapacityForTesting(1024)
    // A lifetime ctx the setup retains past its call, and a disposer — both
    // captured from the pre-growth generation.
    let storedSet: ((v: number) => void) | undefined
    const a = createAtom(0, {
      onObserved: (ctx) => {
        storedSet = ctx.set
      },
    })
    const seen: number[] = []
    const stop = createEffect(a, (v) => {
      seen.push(v)
    })
    flushScheduledEffects() // settle the observation lifetime
    expect(storedSet).toBeDefined()
    growCapacity(4096)
    await microtasks()
    expect(arenaStats().capacityRecords).toBe(4096)
    storedSet!(7) // pre-growth ctx.set writes through the current generation
    expect(seen).toEqual([0, 7])
    stop() // pre-growth disposer disposes through the current generation
    storedSet!(9)
    expect(seen).toEqual([0, 7])
  })

  test("benchmark reset after growth keeps the grown capacity", async () => {
    setArenaCapacityForTesting(1024)
    const a = createAtom(1)
    createComputed(() => a.get()).get()
    growCapacity(4096)
    await microtasks()
    expect(arenaStats().capacityRecords).toBe(4096)
    resetGraphForBenchmark()
    expect(arenaStats().capacityRecords).toBe(4096)
    // The rewound arena is untouched again, so growCapacity applies now.
    growCapacity(8192)
    expect(arenaStats().capacityRecords).toBe(8192)
  })

  test("growth preserves draft worlds and parked async computeds", async () => {
    setArenaCapacityForTesting(1024)
    const cell = createAtom(1)
    let settle!: (v: number) => void
    const thenable = new Promise<number>((r) => {
      settle = r
    })
    const loader = createComputed((use) => use(thenable) + cell.get())
    // First load: no settled history, so the read suspends on the stable
    // pending promise.
    let thrown: unknown
    try {
      loader.get()
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(Promise)

    const draft = openDraft()
    try {
      runWithDraftWrites(draft, () => cell.set(5))
      const world = worldOf([draft.id])
      expect(resolveState(nodeOf(cell), world).value).toBe(5)
      growCapacity(arenaStats().capacityRecords * 2)
      await microtasks()
      // The drafted overlay and the untouched base value both survive: memo
      // certificates compare clock readings, and migration copies the clocks.
      expect(resolveState(nodeOf(cell), world).value).toBe(5)
      expect(cell.peek()).toBe(1)
    } finally {
      discardDraft(draft.id)
    }

    // Settlement invalidates the parked computed through its migrated record.
    settle(41)
    await thenable
    expect(loader.get()).toBe(42)
  })

  test("a churned graph stays correct through growth", async () => {
    setArenaCapacityForTesting(256)
    const width = 40
    const cells = Array.from({ length: width }, (_, i) => createAtom(i))
    const mids = cells.map((c, i) =>
      createComputed(() => c.get() + cells[(i + 1) % width]!.get()),
    )
    const top = createComputed(() => {
      let sum = 0
      for (const m of mids) {
        sum += m.get()
      }
      return sum
    })
    let delivered = -1
    const stop = createEffect(top, (v) => {
      delivered = v
    })
    const expected = () => {
      let sum = 0
      for (let i = 0; i < width; i++) {
        sum += 2 * i
      }
      return sum
    }
    expect(delivered).toBe(expected())
    await microtasks() // growth from the initial burst applies here
    expect(arenaStats().capacityRecords).toBeGreaterThan(256)
    batch(() => {
      for (const c of cells) {
        c.set(c.get() + 1)
      }
    })
    expect(delivered).toBe(expected() + 2 * width)
    stop()
  })
})
