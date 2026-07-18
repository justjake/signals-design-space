/**
 * Replays harness/bench/child.ts + kairoBench EXACTLY (real case fns imported
 * from the milomg submodule, same bridge, same warmup/bench sequence), but
 * with toggles to isolate which part of the process context inflates a case.
 *
 *   node --expose-gc --import tsx prof/kairo-harness.mjs <lib>
 *
 * env:
 *   WARM=csv    cases to include in the warmup phase (default: all, like kairoBench)
 *   BENCH=csv   cases to actually bench, in order (default: all)
 *   REPORT=csv  cases whose time to print (default: BENCH)
 *
 * <lib>: probe | arena | alien (or a path)
 */
import { fileURLToPath } from "node:url"

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const LIBS = {
  probe: here("../src/index.ts"),
  arena: here("../../arena/src/index.ts"),
  alien: here("../../../vendor/alien-signals/esm/index.mjs"),
}

const libName = process.argv[2] ?? "probe"
const lib = await import(LIBS[libName] ?? libName)

const bench = (p) => here(`../../../milomg-reactivity-benchmark/packages/core/src/${p}`)
const { avoidablePropagation } = await import(bench("benches/kairo/avoidable.ts"))
const { broadPropagation } = await import(bench("benches/kairo/broad.ts"))
const { deepPropagation } = await import(bench("benches/kairo/deep.ts"))
const { diamond } = await import(bench("benches/kairo/diamond.ts"))
const { mux } = await import(bench("benches/kairo/mux.ts"))
const { repeatedObservers } = await import(bench("benches/kairo/repeated.ts"))
const { triangle } = await import(bench("benches/kairo/triangle.ts"))
const { unstable } = await import(bench("benches/kairo/unstable.ts"))
const { mol } = await import(bench("benches/kairo/molBench.ts"))
const { nextTick } = await import(bench("util/asyncUtil.ts"))
const { fastestTest } = await import(bench("util/benchRepeat.ts"))

const ALL = [
  { name: "avoidablePropagation", fn: avoidablePropagation },
  { name: "broadPropagation", fn: broadPropagation },
  { name: "deepPropagation", fn: deepPropagation },
  { name: "diamond", fn: diamond },
  { name: "mux", fn: mux },
  { name: "repeatedObservers", fn: repeatedObservers },
  { name: "triangle", fn: triangle },
  { name: "unstable", fn: unstable },
  { name: "molBench", fn: mol },
]
const pick = (env, dflt) => {
  const v = process.env[env]
  if (!v) {
    return dflt
  }
  const names = v.split(",").map((s) => s.trim())
  return ALL.filter((c) => names.includes(c.name) || names.some((n) => c.name.startsWith(n)))
}
const WARM = pick("WARM", ALL)
const BENCH = pick("BENCH", ALL)
const REPORT = pick("REPORT", BENCH)

// ---- child.ts bridge (verbatim) ----------------------------------------------

let scope = null
const framework = {
  name: libName,
  signal: (initialValue) => {
    const s = lib.signal(initialValue)
    return { read: () => s(), write: (v) => s(v) }
  },
  computed: (fn) => {
    const c = lib.computed(fn)
    return { read: () => c() }
  },
  effect: (fn) => {
    lib.effect(() => {
      fn()
    })
  },
  withBatch: (fn) => {
    lib.startBatch()
    try {
      fn()
    } finally {
      lib.endBatch()
    }
  },
  withBuild: (fn) => {
    let out
    scope = lib.effectScope(() => {
      out = fn()
    })
    return out
  },
  cleanup: () => {
    if (scope) {
      scope()
      scope = null
    }
  },
}

// ---- kairoBench (verbatim, minus multi-framework loop) ------------------------

// warmup
for (const c of WARM) {
  const iter = framework.withBuild(() => c.fn(framework))
  iter()
  iter()
  await nextTick()
  iter()
  framework.cleanup()
}

if (globalThis.gc) {
  ;(globalThis.gc(), globalThis.gc())
}
await nextTick()

// actual benchmark
for (const c of BENCH) {
  const iter = framework.withBuild(() => {
    const iter = c.fn(framework)
    return iter
  })

  iter()
  iter()
  await nextTick()

  iter()
  await nextTick()

  const { time } = await fastestTest(10, () => {
    for (let i = 0; i < 500; i++) {
      iter()
    }
  })

  framework.cleanup()
  if (globalThis.gc) {
    ;(gc(), gc())
  }

  if (REPORT.includes(c)) {
    console.log(`@@ROW ${JSON.stringify({ lib: libName, test: c.name, ms: +time.toFixed(2) })}`)
  }
}
