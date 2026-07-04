# Harness: conformance + benchmarks + memory for the lab libraries

Shared infrastructure for comparing signal-library implementations against
upstream alien-signals v3.2.1 (`alien-v3`). Registered frameworks:
`alien-v3`, `control`, `sweep`, `arrayd`, `arena`.

## If you are an implementation agent, read this first

You may ONLY touch these two places (everything else is shared):

1. `libs/<your-name>/src/` — your library. Entry point must stay
   `libs/<your-name>/src/index.ts`; add as many other files under `src/` as
   you like.
2. `harness/adapters/<your-name>.ts` — your adapter. It already works if you
   implement the standard API below; customize it only if your library's
   surface differs.

### Required public API (same shape as upstream alien-signals index.ts)

```ts
signal(initial?)         // callable: s() reads, s(v) writes
computed(getter)         // callable: c() reads
effect(fn)               // returns disposer; fn may return a cleanup function
effectScope(fn)          // returns disposer (disposes effects created inside)
startBatch(); endBatch()
untracked(fn)            // OPTIONAL — unlocks the untracked conformance section
```

### Required semantics (the conformance suite is the arbiter)

- Lazy computeds: never compute unless read directly or via a live effect chain.
- Dynamic dependencies re-discovered each run.
- Equality cutoff (`!==`) stops propagation.
- Glitch freedom.
- Nested effects: outer-before-inner execution, hierarchical disposal.
- Effect cleanup functions run before rerun and on dispose.
- Batching (`startBatch`/`endBatch`, re-entrant safe) and re-entrant writes.

### Hard rules

- Zero runtime dependencies. TypeScript source is consumed directly (no
  build step) — keep `package.json` `exports` pointing at `src/index.ts`.
- Never use `Date.now`/`Math.random` in library hot paths for logic.
- Conformance must be green before you report any benchmark number.
- Report failing tests as failing, with analysis. Never paper over.

## Commands (run from the repo root; all are non-interactive and terminate)

```sh
# Conformance: full reactive-framework-test-suite against one framework.
FRAMEWORK=arrayd pnpm -C harness conformance      # default FRAMEWORK=alien-v3

# Benchmarks: one child process per framework (per-process methodology —
# same-process rankings are biased up to 3x, see research/RESEARCH.md §1.8).
pnpm -C harness bench --frameworks arrayd --suites kairo,sbench
pnpm -C harness bench                              # all frameworks x all suites (slow!)
#   suites: kairo (incl. molBench), sbench, cellx, dynamic
#   --timeout <ms> caps each child (default 15 min)

# Memory probe: retained heap for 10k signals / 10k computeds / 10k effects
# and a 100x100 grid, per framework in its own --expose-gc child process.
pnpm -C harness memory --frameworks arrayd

# Typecheck harness + adapters + the submodule bench code they import.
pnpm -C harness typecheck
```

Tips:
- During development, run single suites (`--suites kairo`) — a full
  `bench` for one framework takes several minutes; `sbench` and `dynamic`
  are the slow ones.
- Results land in `harness/results/<timestamp>-<framework>.{json,csv}` and
  `<timestamp>-memory-<framework>.{json,csv}`. The alien-v3 baseline files
  recorded at harness-creation time are the ones dated 2026-07-03.

## What green looks like

- **Conformance**: `FRAMEWORK=<you> pnpm -C harness conformance` exits 0 with
  **179 passed** (the suite has 179 cases; alien-v3 passes all 179 — verified
  at harness creation). If your library does not export `untracked`, the 7
  "Untracked / Unsampled Reads" cases still *pass* (they self-skip via
  `SkipTest`) — implementing `untracked` makes them real. The
  "Behavior Differences" section is part of the run and alien-v3 passes it;
  match alien's behavior.
- **Bench**: every suite completes without thrown errors, the child exits 0,
  and no `console.assert` failures appear in the output (cellx checks exact
  values; dynamic checks sums and — with `testPullCounts: true` — the exact
  number of computed evaluations; kairo cases assert internally). An
  assertion message in the log means WRONG RESULTS: fix the library, do not
  report the number.
- **Memory**: prints four rows of KB numbers and exits 0.

## Layout

```
harness/
  adapters/types.ts        # THE shared adapter type (FrameworkAdapter)
  adapters/index.ts        # name -> lazy loader registry (dynamic import per
                           #   adapter, so one broken lib can't break others)
  adapters/alien-v3.ts     # upstream reference adapter
  adapters/{control,sweep,arrayd,arena}.ts   # owned by implementation agents
  conformance/conformance.spec.ts  # vitest; env FRAMEWORK selects adapter
  bench/run.ts             # parent: spawns bench/child.ts per framework
  bench/child.ts           # child: milomg ReactiveFramework wrapper + suites
  memory/run.ts            # parent: spawns memory/child.ts per framework
  memory/child.ts          # child: upstream memoryUsage.mjs port, bug fixed
  util/cli.ts              # flag parsing, child spawn protocol, results IO
  results/                 # JSON + CSV outputs (baselines recorded here)
```

The bench child imports suite code directly from
`milomg-reactivity-benchmark/packages/core/src/` (TypeScript source; the
bench modules only import `util/` and `config.ts`, never framework
packages). Do not modify the submodule.

## Methodology notes (do not skip)

- One (framework, suite) pair per child process, sequential — never compare
  numbers from a shared process. Suites pollute each other's heap: measured
  cellx1000 was ~9x slower when run after sbench in the same process.
- Bench/memory children are esbuild-BUNDLED (keepNames off) and run under
  plain `node --expose-gc` — NOT the tsx loader. tsx transpiles with esbuild
  `keepNames: true`, whose `Object.defineProperty(fn, 'name', ...)` wrapper
  puts every named closure into dictionary-mode properties (~500 B extra per
  closure and a creation-time tax, both measured: 10k adapter-wrapped
  signals 8.06 MB -> 3.06 MB, sbench createSignals 38 ms -> 3.9 ms). Since
  the lab libraries ship TS source while alien-v3 ships prebuilt .mjs, the
  loader would tax only the labs. Bundling gives every framework identical
  runtime treatment.
- Run benchmarks on an otherwise-idle machine and repeat runs. Under
  background load, identical back-to-back children varied 2-3x on sbench;
  external interference only ever adds time, so the minimum across repeated
  runs is the honest estimator. (The 2026-07-03 alien-v3 baseline was
  recorded at load average ~7; see the JSON metadata.)
- The milomg harness reports **fastest-of-N**, which hides GC cost. When
  comparing arena/allocation designs, also look at run-to-run spread and
  consider `node --jitless` passes (see research/RESEARCH.md §1.8).
- Memory numbers are measured **through the shared adapter**, so every
  signal/computed carries an extra `{read, write}` wrapper. Overhead is
  uniform across frameworks: compare frameworks relatively; do not compare
  against upstream's `benchs/memoryUsage.mjs` output.
- The memory probe intentionally keeps upstream's odd grid shape (effects
  close over the column's mutable `last` binding); only the
  effect-returns-a-number bug is fixed.
