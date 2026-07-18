import { describe, expect, it } from "vitest"
import { createAtom, createComputed, createEffect } from "cosignals/core"
import { attachCosignalsDevtools } from "../src/cosignals.ts"
import { buildSnapshot, SnapshotBackend } from "../src/extension/snapshot.ts"
import { logRows, nodeRows, inspectorModel } from "../src/panel/viewmodel.ts"

describe("extension bridge: snapshot round-trip", () => {
  it("serializes a live Backend and serves identical queries panel-side", () => {
    const dt = attachCosignalsDevtools()
    try {
      const count = createAtom(1, { label: "count" })
      const doubled = createComputed(() => count.get() * 2, { label: "doubled" })
      createEffect(
        () => doubled.get(),
        () => {},
      )
      count.set(5)

      // Page side: build a snapshot and prove it survives structured clone.
      const snap = buildSnapshot(dt.collector)
      const wire = JSON.parse(JSON.stringify(snap))

      // Panel side: a SnapshotBackend fed the wire snapshot.
      const backend = new SnapshotBackend()
      backend.update(wire)

      // The SAME view-model the inline panel uses works over the bridge.
      const rows = logRows(backend, {}, 100)
      expect(rows.some((r) => r.kind === "set" && r.name === "count")).toBe(true)
      expect(rows.some((r) => r.kind === "compute" && r.name === "doubled")).toBe(true)

      const nrows = nodeRows(backend, "", 100)
      const d = nrows.find((n) => n.name === "doubled")!
      expect(d.kind).toBe("computed")
      expect(d.value).toBe("10")

      const model = inspectorModel(backend, d.id)!
      expect(model.deps.map((x) => x.name)).toContain("count")
      expect(model.why[0].cause).toBe(0)

      // subscribe fires on a new snapshot push.
      let notified = 0
      backend.subscribe(() => notified++)
      backend.update(wire)
      expect(notified).toBe(1)
    } finally {
      dt.detach()
    }
  })
})
