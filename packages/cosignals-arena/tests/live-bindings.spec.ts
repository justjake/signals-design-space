import { expect, test } from "vitest"
import * as graph from "../src/graph.ts"
import * as publicApi from "../src/index.ts"
import * as worlds from "../src/worlds.ts"

test("internal live bindings do not widen the public entry point", () => {
  expect("activeConsumer" in publicApi).toBe(false)
  expect("currentWorld" in publicApi).toBe(false)
  expect("currentPark" in publicApi).toBe(false)
  expect("serializeAtomState" in publicApi).toBe(false)
  expect("initializeAtomState" in publicApi).toBe(false)
  expect("installState" in publicApi).toBe(false)
  expect(publicApi.getActiveTracer).toBeTypeOf("function")
})

test("[falsify-first] canonical ambient owners expose live internal bindings", () => {
  // The engine core lives in one closure, so the ambient consumer is read
  // through an accessor rather than a module binding; the world and park
  // owners live in worlds.ts.
  const worldState = worlds as typeof worlds & {
    readonly currentPark: unknown
  }

  expect(graph.getActiveConsumer()).toBeNull()
  expect(worlds.getCurrentWorld()).toBeNull()
  expect(worldState.currentPark).toBeNull()

  const source = publicApi.createAtom(1)
  let seenConsumer: unknown
  const computed = publicApi.createComputed(() => {
    seenConsumer = graph.getActiveConsumer()
    return source.get()
  })
  expect(computed.get()).toBe(1)
  expect(seenConsumer).toBe(publicApi.nodeOf(computed))
  expect(graph.getActiveConsumer()).toBeNull()

  worlds.withWorld(worlds.BASE_WORLD, () => {
    expect(worlds.getCurrentWorld()).toBe(worlds.BASE_WORLD)
    worlds.withWorld(null, () => {
      expect(worlds.getCurrentWorld()).toBeNull()
    })
    expect(worlds.getCurrentWorld()).toBe(worlds.BASE_WORLD)
  })
  expect(worlds.getCurrentWorld()).toBeNull()

  const draft = worlds.openDraft()
  try {
    worlds.runWithDraftWrites(draft, () => source.set(2))
    const world = worlds.worldOf([draft.id])
    let seenWorld: unknown
    let seenPark: unknown
    const worldComputed = publicApi.createComputed(() => {
      seenWorld = worlds.getCurrentWorld()
      seenPark = worldState.currentPark
      return source.get()
    })
    expect(worlds.resolveState(publicApi.nodeOf(worldComputed), world)).toEqual({
      flags: 0,
      value: 2,
    })
    expect(seenWorld).toBe(world)
    expect(seenPark).toBeTypeOf("function")
    expect(worlds.getCurrentWorld()).toBeNull()
    expect(worldState.currentPark).toBeNull()
  } finally {
    worlds.discardDraft(draft.id)
  }
})
