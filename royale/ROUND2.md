# Signals Royale — Round 2: verify, integrate, tune

You built it; you verify it, you wire it into the benchmarks, and you make it fast —
before any judgement happens. Judgement (independent re-verification, LOC counting,
cross-entrant benchmark runs, peer ballots) starts only after your Round 2.
Everything in RULES.md still applies, including honesty-as-a-gate and the isolation
rules.

## 1. Gates, for real

Re-run every RULES.md gate fresh, in order, and fix what fails:
typecheck (both packages) → 179-case conformance → your fuzz oracle (default seeds,
then one deep sweep: 4× seeds) → leak audit → fork protocol suites → your
real-React gate. Paste the real terminal output of each into REPORT.md (a "Round 2"
section). A gate you cannot make green gets a written analysis instead of a
workaround — failures reported honestly outrank failures papered over.

## 2. Core benchmark: milomg js-reactivity-benchmark

Your clone's `milomg-reactivity-benchmark/` dir is an empty submodule stub. Populate
it from the orchestrator's checkout (read-only source; your copy is yours):

```sh
git clone --local /Users/jitl/src/alien-signals-opt/milomg-reactivity-benchmark milomg-reactivity-benchmark
cd milomg-reactivity-benchmark && pnpm install   # its own workspace; this is allowed
```

Register your library (three touch points, mirroring the existing cosignal entries):

1. `packages/core/src/frameworks/royale-<slug>.ts` — copy your
   `royale/milomg-adapter.ts` here (adjust the import to the package name below).
2. `packages/core/src/frameworksList.ts` — import it and append
   `{ framework: royale<Slug>Framework, testPullCounts: true }` to `frameworkInfo`.
3. `packages/core/package.json` devDependencies —
   `"signals-royale-<slug>": "file:../../../packages/signals-royale-<slug>"`,
   then re-run `pnpm install` in the benchmark clone.

Sanity-gate the adapter, rebuild the runner (it BUNDLES your library — rebuild after
every change), then measure with the isolated runner only:

```sh
pnpm -C packages/core test          # adapter sanity incl. pull counts
cd packages/node && pnpm exec esbuild src/index.ts src/isolated.ts --bundle --format=esm --target=esnext --outdir=dist --sourcemap=external
node dist/isolated.js --rounds 3 "Royale <SLUG>" "Alien Signals"
```

Alien Signals is the bar; the incumbents sit at rough parity with it. Iterate on
your engine, re-running the bundle + isolated runner between changes. Rankings only
count with conformance green (§1) — never trade correctness for a number. Record the
final per-suite table and your overall ratio vs alien in REPORT.md. Flag any
leak-vs-no-leak asymmetry explicitly (your `cleanup()` must dispose the graph).

## 3. React benchmark: the three seam scenarios

Add `bench/react-bench.mjs` to your react package: jsdom + real timers (no `act`),
real `createRoot` from YOUR build, one scenario per child process, stdout CSV
`scenario,contender,stat,ms`. Implement the standard shapes:

- **fanout** — 5000 independent numeric cells, one component reading each; 200
  single-cell writes from outside React; median write→commit latency.
- **transition** — 2000 cells rewritten inside `startTransition` while an unrelated
  urgent `useState` input updates 30 times at ~16 ms intervals; p95 urgent
  update→commit latency. This is the scenario your fork exists for: a plain
  useSyncExternalStore store degrades to blocking renders here.
- **mount** — mount + first commit of the 5000-cell tree, 5 fresh roots; median ms.

Run each scenario for TWO contenders: your bindings, and a ~35-line stock
useSyncExternalStore baseline over a plain store (same component shapes) as the
reference point. Record both in REPORT.md and tune your bindings (subscription
claim, notify fan-out, mount cost) until you're proud of the deltas.

## 4. Shared battery (when it arrives)

The orchestrator delivers a calibrated cross-entrant battery to
`royale/verify-kit/` in your workspace (it may appear while you work — check again
before you finish). When present: follow its README, point its `ADAPTER.ts` shim at
your `royale/adapter.ts`, run it, and fix failures. If you believe a battery test
itself is wrong, do NOT code around it — keep your semantics, and document the
disputed test + your argument in REPORT.md for adjudication.

## 5. Finish

Re-run any gate a tuning change could have touched. Regenerate `patches/`. Commit
everything on your branches. Update REPORT.md with the Round 2 section: gate
outputs, the milomg table + ratio, the react-bench table, the changes you made and
why, and anything you dispute. Machine-sharing etiquette from your dispatch prompt
still applies.
