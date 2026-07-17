// @vitest-environment jsdom
/**
 * Scheduling semantics of the notification design: a base write
 * re-renders with exactly useState's urgency, because the wake is itself
 * a reducer dispatch made in the write's context. These tests observe
 * real scheduling (no act), so the act environment flag is turned off per
 * test and restored after.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { act, makeHarness, text, tick, React, type Harness } from "./helpers.tsx"
import { createAtom } from "cosignals"
import { useSignal } from "cosignals/react"

let h: Harness
let prevActEnv: boolean | undefined
beforeEach(() => {
  h = makeHarness()
  prevActEnv = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
})
afterEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = prevActEnv
  await h.cleanup()
})

const drainMicrotasks = async () => {
  // A handful of microtask turns with no task-queue progress.
  for (let i = 0; i < 8; i++) {
    await Promise.resolve()
  }
}

/**
 * Wait (macrotasks) until the condition holds, so scheduler-task renders
 * can land; bounded so a genuine failure still fails fast.
 */
const settleUntil = async (cond: () => boolean) => {
  for (let i = 0; i < 20 && !cond(); i++) {
    await tick()
  }
}

describe("base writes behave like useState", () => {
  test("a timeout-origin write renders at default priority: not in the microtask window", async () => {
    const a = createAtom(0)
    function App() {
      return <span>{useSignal(a)}</span>
    }
    const { container } = await h.mount(<App />)
    expect(text(container)).toBe("0")
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false

    await new Promise<void>((res) =>
      setTimeout(() => {
        a.set(1)
        res()
      }, 0),
    )
    // This timing separates the lanes: a sync-lane update (what useSyncExternalStore
    // forced for every store change) flushes in the microtask window; a
    // default-lane update waits for a scheduler task. useState semantics =
    // the latter.
    await drainMicrotasks()
    expect(text(container)).toBe("0")
    await settleUntil(() => text(container) === "1")
    expect(text(container)).toBe("1")
  })

  test("a click-origin write renders synchronously before the microtask window closes", async () => {
    const a = createAtom(0)
    function App() {
      return (
        <button onClick={() => a.set(1)}>
          <span>{useSignal(a)}</span>
        </button>
      )
    }
    const { container } = await h.mount(<App />)
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false

    container
      .querySelector("button")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    await drainMicrotasks()
    // Discrete-event context = sync lane: flushed before any task ran.
    expect(text(container)).toBe("1")
  })

  test("a signal write and a setState in one async callback commit as ONE render", async () => {
    const a = createAtom(0)
    let renders = 0
    let setSt: (v: number) => void
    function App() {
      renders++
      const [st, set] = React.useState(0)
      setSt = set
      return (
        <span>
          {useSignal(a)},{st}
        </span>
      )
    }
    const { container } = await h.mount(<App />)
    const before = renders
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false

    await new Promise<void>((res) =>
      setTimeout(() => {
        // Under useSyncExternalStore the signal write forced a sync-lane
        // render while the setState stayed default-lane: two renders and a
        // frame where the pair could be observed torn. One channel = one
        // lane = one render.
        a.set(1)
        setSt!(1)
        res()
      }, 0),
    )
    await settleUntil(() => text(container) === "1,1")
    expect(text(container)).toBe("1,1")
    expect(renders).toBe(before + 1)
  })

  test("a write burst from one callback costs one render", async () => {
    const a = createAtom(0)
    let renders = 0
    function App() {
      renders++
      return <span>{useSignal(a)}</span>
    }
    const { container } = await h.mount(<App />)
    const before = renders
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false

    await new Promise<void>((res) =>
      setTimeout(() => {
        for (let i = 1; i <= 100; i++) {
          a.set(i)
        }
        res()
      }, 0),
    )
    await settleUntil(() => text(container) === "100")
    expect(text(container)).toBe("100")
    expect(renders).toBe(before + 1)
  })
})

describe("the render→attach gap", () => {
  test("a layout-effect write landing before the passive subscription is repaired at attach", async () => {
    // Mount order: both components render, then layout effects run (the
    // write), then passive effects attach subscriptions. The reader
    // rendered 0 but the store says 9 by the time it subscribes — the
    // commit-time repair must re-render it. Hydration is this same gap at
    // its widest.
    const a = createAtom(0)
    let readerRenders = 0
    function Reader() {
      readerRenders++
      return <span>{useSignal(a)}</span>
    }
    function LayoutWriter() {
      React.useLayoutEffect(() => {
        a.set(9)
      }, [])
      return null
    }
    const { container } = await act(async () =>
      h.mount(
        <>
          <Reader />
          <LayoutWriter />
        </>,
      ),
    )
    expect(text(container)).toBe("9")
    expect(readerRenders).toBe(2) // initial render + exactly one repair
  })
})
