import { expect, test } from "vitest"
import * as rootApi from "cosignals-arena"
import * as coreApi from "cosignals-arena/core"
import * as reactApi from "cosignals-arena/react"

test("the root entry combines the core and React APIs", () => {
  expect(rootApi.createAtom).toBe(coreApi.createAtom)
  expect(rootApi.useSignal).toBe(reactApi.useSignal)
  expect(rootApi.CosignalsProvider).toBe(reactApi.CosignalsProvider)
})

test("the core entry does not export React bindings", () => {
  expect("useSignal" in coreApi).toBe(false)
  expect("CosignalsProvider" in coreApi).toBe(false)
  expect("unregisterReactSignals" in coreApi).toBe(false)
})
