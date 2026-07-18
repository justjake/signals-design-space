import assert from "node:assert/strict"
import test from "node:test"
import { createAtom, createComputed } from "cosignals"
import {
  createAtom as createArenaAtom,
  createComputed as createArenaComputed,
} from "cosignals-arena"
import { attachCosignalsDevtools } from "cosignals-devtools/cosignals"
import { attachCosignalsArenaDevtools } from "cosignals-devtools/cosignals-arena"

function verifyEngine(createSignal, createDerived) {
  const count = createSignal(2)
  const doubled = createDerived(() => count.get() * 2)

  assert.equal(doubled.get(), 4)
  count.set(3)
  assert.equal(doubled.get(), 6)
}

test("packed engines execute through their public entry points", () => {
  verifyEngine(createAtom, createComputed)
  verifyEngine(createArenaAtom, createArenaComputed)
})

test("packed devtools adapters load", () => {
  assert.equal(typeof attachCosignalsDevtools, "function")
  assert.equal(typeof attachCosignalsArenaDevtools, "function")
})
