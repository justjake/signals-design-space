/** createEffect() source overloads (signal / tuple / record) and shallowEquals. */
import { describe, expect, test } from "vitest"
import { createAtom, createComputed, createEffect, shallowEquals, type Atom } from "cosignals-arena"

describe("shallowEquals", () => {
  test("compares arrays element-wise, one level deep", () => {
    expect(shallowEquals([1, "a", NaN], [1, "a", NaN])).toBe(true)
    expect(shallowEquals([1, 2], [1, 3])).toBe(false)
    expect(shallowEquals([1, 2], [1, 2, 3])).toBe(false)
    expect(shallowEquals([{ x: 1 }], [{ x: 1 }])).toBe(false) // one level only
  })

  test("compares plain objects by own keys", () => {
    expect(shallowEquals({ a: 1, b: NaN }, { b: NaN, a: 1 })).toBe(true)
    expect(shallowEquals({ a: 1 }, { a: 2 })).toBe(false)
    expect(shallowEquals({ a: 1 }, { a: 1, b: undefined })).toBe(false)
    expect(shallowEquals({ a: undefined }, {})).toBe(false)
  })

  test("mixed shapes and primitives fall back to Object.is", () => {
    expect(shallowEquals([1], { 0: 1, length: 1 })).toBe(false)
    expect(shallowEquals({ 0: 1 }, [1])).toBe(false)
    expect(shallowEquals(NaN, NaN)).toBe(true)
    expect(shallowEquals(1, "1")).toBe(false)
    expect(shallowEquals(null, {})).toBe(false)
  })
})

describe("effect signal source", () => {
  test("subscribes, delivers (value, previous), cuts on Object.is", () => {
    const a = createAtom(0)
    const seen: Array<[number, number | undefined]> = []
    const stop = createEffect(a, (value, previous) => {
      seen.push([value, previous])
    })
    expect(seen).toEqual([[0, undefined]])
    a.set(1)
    expect(seen).toEqual([
      [0, undefined],
      [1, 0],
    ])
    a.set(1) // Object.is cutoff: no delivery
    expect(seen.length).toBe(2)
    stop()
    a.set(2)
    expect(seen.length).toBe(2)
  })

  test("a computed source rides its own cutoff", () => {
    const a = createAtom(1)
    const parity = createComputed(() => a.get() % 2)
    const seen: number[] = []
    const stop = createEffect(parity, (v) => {
      seen.push(v)
    })
    a.set(3) // parity unchanged: computed cutoff, no delivery
    a.set(4)
    expect(seen).toEqual([1, 0])
    stop()
  })
})

describe("effect tuple source", () => {
  test("delivers a same-shaped tuple with a shallow cutoff", () => {
    const a = createAtom(1)
    const b = createAtom("x")
    const seen: Array<[[number, string], [number, string] | undefined]> = []
    const stop = createEffect([a, b], (values, previous) => {
      seen.push([values, previous])
    })
    expect(seen).toEqual([[[1, "x"], undefined]])
    a.update((n) => n) // no value change anywhere: no delivery
    expect(seen.length).toBe(1)
    b.set("y")
    expect(seen[1]).toEqual([
      [1, "y"],
      [1, "x"],
    ])
    stop()
  })

  test("an explicit equals overrides the shallow default", () => {
    const a = createAtom(1)
    const seen: number[][] = []
    const stop = createEffect(
      [a],
      (values) => {
        seen.push(values)
      },
      { equals: ([x], [y]) => Math.abs(x - y) < 10 },
    )
    a.set(5) // within tolerance: cut
    expect(seen.length).toBe(1)
    a.set(50)
    expect(seen.length).toBe(2)
    stop()
  })
})

describe("effect record source", () => {
  test("delivers a same-shaped record; keys fixed at creation", () => {
    const user = createAtom("ada")
    const theme = createAtom("dark")
    const sources: Record<string, Atom<string>> = { user, theme }
    const seen: Array<Record<string, string>> = []
    const stop = createEffect(sources, (values) => {
      seen.push(values)
    })
    expect(seen).toEqual([{ user: "ada", theme: "dark" }])
    sources.late = createAtom("ignored") // not watched: keys were captured
    theme.set("light")
    expect(seen[1]).toEqual({ user: "ada", theme: "light" })
    expect(seen.length).toBe(2)
    stop()
  })
})

describe("source typing", () => {
  test("handler parameter types follow the source shape", () => {
    const n = createAtom(0)
    const s = createAtom("x")
    const stops = [
      createEffect(n, (value) => {
        value satisfies number
        // @ts-expect-error a number source never delivers strings
        value satisfies string
      }),
      createEffect([n, s], (values) => {
        values satisfies [number, string]
      }),
      createEffect({ n, s }, (values) => {
        values satisfies { n: number; s: string }
      }),
    ]
    for (const stop of stops) {
      stop()
    }
  })
})
