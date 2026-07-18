// Field runtime: the id-based interface the pixel graph is built against.
//
// graph.ts and the stress-test component speak one interface:
//   signal(v) -> id      computed(fn) -> id     effect(fn)
//   get(id)              set(id, v)             batch(fn)
//   build(fn)            dispose()
//
// Every library goes through one generic bridge over a benchmark-adapter
// object (the reactivity-benchmark ReactiveFramework shape: static
// methods createSignal/readSignal/writeSignal/createComputed/readComputed/
// effect/withBatch/withBuild/cleanup, generic over the framework's own
// cell representation). Using the benchmark's own adapters means the
// stress test drives exactly the code the benchmarks measure.
import type { ReactiveFramework } from "../../../../milomg-reactivity-benchmark/packages/core/src/util/reactiveFramework"

export interface FieldRuntime {
  build(fn: () => void): void
  signal(v: number): number
  computed(fn: () => number): number
  effect(fn: () => void): void
  get(id: number): number
  set(id: number, v: number): void
  batch(fn: () => void): void
  dispose(): void
}

export function makeRuntime(framework: ReactiveFramework<any>): FieldRuntime {
  // Ids are indexes into an array of the adapter's own opaque cells — the
  // static-method interface never allocates a per-cell wrapper or closure
  // pair. Reads all go through readComputed, which the interface requires
  // to accept signal cells too; writes only ever target signals.
  // Everything the graph owns must be created inside build(fn) — several
  // adapters parent effects to a scope or root opened by withBuild, and
  // cleanup() disposes that scope. Creations outside it would survive
  // cleanup.
  let cells: unknown[] = []
  return {
    build: (fn) => framework.withBuild(fn),
    signal: (v) => cells.push(framework.createSignal(v)) - 1,
    computed: (fn) => cells.push(framework.createComputed(fn)) - 1,
    effect(fn) {
      framework.effect(fn)
    },
    get: (id) => framework.readComputed(cells[id]) as number,
    set: (id, v) => framework.writeSignal(cells[id], v),
    batch: (fn) => framework.withBatch(fn),
    dispose() {
      // Read .cleanup at call time: the solid-style adapters install the
      // real dispose function by replacing that property from inside
      // withBuild. Every adapter's cleanup() is real disposal, so
      // dropping the cell storage afterwards frees the whole graph.
      framework.cleanup()
      cells = []
    },
  }
}
