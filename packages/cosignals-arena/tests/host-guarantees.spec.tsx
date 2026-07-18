// @vitest-environment jsdom
/** Host guarantees: loud registration, unmount reclamation, quiescence. */
import { describe, expect, test } from "vitest"
import * as React from "react"
import { createRoot } from "react-dom/client"
import { act } from "./helpers.tsx"
import { createAtom, createEffect, flushScheduledEffects, type Atom } from "cosignals-arena"
import { nodeOf } from "cosignals-arena/unstable"
import { discardDraft, liveDraftCount, openDraft, runWithDraftWrites } from "../src/worlds.ts"
import {
  registerReactSignals,
  resetReactSignalsForTest,
  CosignalsProvider,
  startSignalTransition,
  useSignal,
} from "cosignals-arena/react"
import {
  broadcastDraft,
  registerEffectHost,
  registerRootConnection,
  REPAIR_WAKE,
} from "../src/react/host.ts"
import {
  EMPTY_WORLD,
  ReactRootConnectionContext,
  worldsReducer,
} from "../src/react/CosignalsProvider.ts"
import { makeHarness, text, tick } from "./helpers.tsx"
import { nextSubscriber } from "../src/graph.ts"

function subCount(x: Atom<number>): number {
  let n = 0
  for (let l = nodeOf(x).subs; l !== undefined; l = nextSubscriber(l)) {
    n++
  }
  return n
}

describe("registration", () => {
  test("world ids change only when live membership changes", () => {
    resetReactSignalsForTest()
    const first = openDraft()
    const second = openDraft()

    const one = worldsReducer(EMPTY_WORLD, first.id)
    const two = worldsReducer(one, second.id)
    expect(two.ids).toEqual([first.id, second.id])
    expect(two.ids).not.toBe(one.ids)

    const repeated = worldsReducer(two, second.id)
    expect(repeated).not.toBe(two)
    expect(repeated.ids).toBe(two.ids)

    const repaired = worldsReducer(repeated, REPAIR_WAKE)
    expect(repaired).not.toBe(repeated)
    expect(repaired.ids).toBe(repeated.ids)

    discardDraft(first.id)
    const pruned = worldsReducer(repaired, REPAIR_WAKE)
    expect(pruned.ids).toEqual([second.id])
    expect(pruned.ids).not.toBe(repaired.ids)
    discardDraft(second.id)

    const prefixFirst = openDraft()
    const middle = openDraft()
    const prefixThird = openDraft()
    const added = openDraft()
    let three = worldsReducer(EMPTY_WORLD, prefixFirst.id)
    three = worldsReducer(three, middle.id)
    three = worldsReducer(three, prefixThird.id)
    const priorIds = three.ids

    discardDraft(middle.id)
    const prunedAndAdded = worldsReducer(three, added.id)
    expect(three.ids).toBe(priorIds)
    expect(three.ids).toEqual([prefixFirst.id, middle.id, prefixThird.id])
    expect(prunedAndAdded).not.toBe(three)
    expect(prunedAndAdded.ids).not.toBe(three.ids)
    expect(prunedAndAdded.ids).toEqual([prefixFirst.id, prefixThird.id, added.id])

    discardDraft(prefixFirst.id)
    discardDraft(prefixThird.id)
    discardDraft(added.id)
  })

  test("registers on stock React (no build marker) and is idempotent", () => {
    // This suite runs against an unpatched React build; registration must
    // succeed with no global handshake of any kind.
    const g = globalThis as Record<string, unknown>
    expect(g.__FX2_REACT_PROTOCOL__).toBeUndefined()
    expect(g.__FX2_MUTATION_WINDOW__).toBeUndefined()
    const h1 = registerReactSignals()
    const h2 = registerReactSignals()
    expect(h1).toBe(h2)
    expect("errors" in h1).toBe(false)
  })

  test("deferred lanes fall back to built-in pumps with no provider mounted", async () => {
    resetReactSignalsForTest()
    const handle = registerReactSignals()
    const source = createAtom(0)
    const layoutSeen: number[] = []
    const passiveSeen: number[] = []
    const stopA = createEffect(
      () => source.get(),
      (value) => {
        layoutSeen.push(value)
      },
      { schedule: "useLayoutEffect" },
    )
    const stopB = createEffect(
      () => source.get(),
      (value) => {
        passiveSeen.push(value)
      },
      { schedule: "useEffect" },
    )
    try {
      source.set(1)
      expect(layoutSeen).toEqual([0])
      expect(passiveSeen).toEqual([0])
      await Promise.resolve()
      expect(layoutSeen).toEqual([0, 1]) // microtask fallback
      expect(passiveSeen).toEqual([0])
      await tick()
      expect(passiveSeen).toEqual([0, 1]) // task fallback
    } finally {
      stopA()
      stopB()
      handle.dispose()
      resetReactSignalsForTest()
    }
  })

  test("unregistering an effect host re-arms the built-in pumps", async () => {
    resetReactSignalsForTest()
    const handle = registerReactSignals()
    // A host that accepts wake requests but whose commit never comes.
    const unregister = registerEffectHost(() => {})
    const source = createAtom(0)
    const seen: number[] = []
    const stop = createEffect(
      () => source.get(),
      (value) => {
        seen.push(value)
      },
      { schedule: "useLayoutEffect" },
    )
    try {
      source.set(1)
      await tick()
      expect(seen).toEqual([0]) // the host swallowed the request
      unregister()
      await tick()
      expect(seen).toEqual([0, 1])
    } finally {
      stop()
      handle.dispose()
      resetReactSignalsForTest()
    }
  })

  test("a useLayoutEffect handler observes the same pass's committed DOM", async () => {
    const h = makeHarness()
    const a = createAtom(0)
    function App() {
      return <span>{useSignal(a)}</span>
    }
    const { container } = await h.mount(<App />)
    const seen: Array<[value: number, dom: string]> = []
    const stop = createEffect(
      () => a.get(),
      (value) => {
        seen.push([value, text(container)])
      },
      { schedule: "useLayoutEffect" },
    )
    // Outside act, so nothing flushes React early: the write must reach
    // the DOM through React's own microtask pass, the discriminating
    // setting for drain anchoring.
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    g.IS_REACT_ACT_ENVIRONMENT = false
    try {
      a.set(1)
      await tick()
      // The handler ran in the commit's layout phase: the DOM already
      // shows the value the same write rendered. A free-running microtask
      // pump would log [1, '0'] — the effect a frame ahead of React.
      expect(seen).toEqual([
        [0, "0"],
        [1, "1"],
      ])
    } finally {
      g.IS_REACT_ACT_ENVIRONMENT = true
      stop()
      await h.cleanup()
    }
  })

  test("[falsify-first] reset preserves registration until the handle is disposed", async () => {
    resetReactSignalsForTest()
    const handle = registerReactSignals()
    resetReactSignalsForTest()

    const drafted = createAtom(0)
    startSignalTransition(() => drafted.set(1))
    expect(drafted.get()).toBe(0)
    await Promise.resolve()
    expect(drafted.get()).toBe(1)

    handle.dispose()
    resetReactSignalsForTest()
    const urgent = createAtom(0)
    startSignalTransition(() => urgent.set(1))
    expect(urgent.get()).toBe(1)
  })

  test("reset keeps disposal from a pending lifetime cleanup", async () => {
    resetReactSignalsForTest()
    const handle = registerReactSignals()
    let cleaned = false
    const observed = createAtom(0, {
      onObserved: () => () => {
        cleaned = true
        handle.dispose()
      },
    })
    const stop = createEffect(
      () => observed.get(),
      () => {},
    )
    flushScheduledEffects() // settle the onObserved activation now
    stop()

    resetReactSignalsForTest()
    expect(cleaned).toBe(true)
    const urgent = createAtom(0)
    startSignalTransition(() => urgent.set(1))
    expect(urgent.get()).toBe(1)
  })

  test("a detached connection record has no trace-only fields", async () => {
    resetReactSignalsForTest()
    registerReactSignals()
    let connection: React.ContextType<typeof ReactRootConnectionContext> = null
    function Child() {
      connection = React.useContext(ReactRootConnectionContext)
      return null
    }
    const container = document.createElement("div")
    const root = createRoot(container)
    try {
      await act(() => {
        root.render(
          <CosignalsProvider>
            <Child />
          </CosignalsProvider>,
        )
      })
      expect(Object.keys(connection!)).toEqual(["dispatch", "committing"])
    } finally {
      await act(() => root.unmount())
    }
  })

  test("root commit bookkeeping precedes descendant layout effects", async () => {
    resetReactSignalsForTest()
    registerReactSignals()
    const atom = createAtom(0)
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    const seen: Array<[rendered: number, committed: number, liveDrafts: number]> = []
    function Child() {
      const value = useSignal(atom)
      React.useLayoutEffect(() => {
        seen.push([value, atom.get(), liveDraftCount()])
      })
      return null
    }
    try {
      await act(() => {
        root.render(
          <CosignalsProvider>
            <Child />
          </CosignalsProvider>,
        )
      })
      expect(seen).toEqual([[0, 0, 0]])
      await act(() => {
        startSignalTransition(() => atom.set(1))
      })
      // The first-child marker retired the draft before this descendant
      // layout effect ran: the committed view already shows the fold.
      expect(seen).toContainEqual([1, 1, 0])
      expect(seen).not.toContainEqual([1, 0, 1])
    } finally {
      await act(() => root.unmount())
      container.remove()
    }
  })
})

describe("hosted draft lifetime", () => {
  test("a draft with no providers retires after its writing callback", async () => {
    resetReactSignalsForTest()
    const a = createAtom(0)
    const draft = openDraft()
    broadcastDraft(draft)
    runWithDraftWrites(draft, () => a.set(1))
    expect(liveDraftCount()).toBe(1)
    await Promise.resolve()
    expect(liveDraftCount()).toBe(0)
    expect(a.get()).toBe(1)
  })

  test("unregistering the last recipient retires its live drafts", () => {
    resetReactSignalsForTest()
    const delivered: number[] = []
    const unregister = registerRootConnection({
      committing: false,
      dispatch: (id) => delivered.push(id),
    })
    const a = createAtom(0)
    const draft = openDraft()
    broadcastDraft(draft)
    runWithDraftWrites(draft, () => a.set(2))
    expect(delivered).toEqual([draft.id])
    expect(liveDraftCount()).toBe(1)
    unregister()
    expect(liveDraftCount()).toBe(0)
    expect(a.get()).toBe(2)
  })
})

describe("unmount reclamation", () => {
  test("50 readers unmount back to zero subscriptions; transitions quiesce", async () => {
    const h = makeHarness()
    const a = createAtom(0)
    function Many() {
      const kids = []
      for (let i = 0; i < 50; i++) {
        kids.push(<Item key={i} />)
      }
      return <>{kids}</>
    }
    function Item() {
      return <i>{useSignal(a)}</i>
    }
    const { root, container } = await h.mount(<Many />)
    expect(subCount(a)).toBe(50)
    await act(() => {
      startSignalTransition(() => a.set(1))
    })
    await act(async () => {})
    expect(text(container)).toContain("1")
    expect(liveDraftCount()).toBe(0) // retired at commit: quiescent
    expect(nodeOf(a).worldMemos).toBeNull()
    await act(() => {
      root.render(null)
    })
    expect(subCount(a)).toBe(0) // deterministic unsubscription at unmount
    await h.cleanup()
    expect(a.get()).toBe(1)
  })

  test("a full mount/write/transition/unmount cycle leaves no live drafts", async () => {
    const h = makeHarness()
    const a = createAtom(0)
    function App() {
      return <span>{useSignal(a)}</span>
    }
    const m1 = await h.mount(<App />)
    const m2 = await h.mount(<App />)
    await act(() => {
      startSignalTransition(() => a.set(5))
    })
    await act(async () => {})
    expect(text(m1.container)).toBe("5")
    expect(text(m2.container)).toBe("5")
    expect(liveDraftCount()).toBe(0)
    await h.cleanup()
    expect(liveDraftCount()).toBe(0)
  })
})
