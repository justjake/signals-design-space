# sh1 — operation-log STM, minimal seam

## How it works

Canonical state lives in `Atom.base`. Each React batch is a `Transaction` holding per-atom write logs, base snapshots, and rebase logs — operations, never copied values. `write()` classifies by ambient `currentTransaction.deferred`: deferred writes append to the log (equality-cut against a single-transaction fold); urgent writes mutate `base`, notify, and append rebase entries to every open transaction touching that atom (`flushSync` flips `rebaseOnCanonical`). Visibility is a `currentWorld` transaction list: `Atom.get()` returns `base`, or `fold()` replays logs over base in order. Computeds keep a memoized lazy push-pull graph for canonical reads but evaluate world reads uncached. At retirement a landed transaction replays its logged functional updates over the newest base — (1+1)\*2=4 without rerunning user code. The 94-line fork adds `unstable_Signals` (fields X=runtime, B=batch, R=render world) with one-to-seven-line hooks at requestUpdateLane, scheduleUpdateOnFiber, render entry, commitRoot, mutation phase, flushSync. Hooks subscribe per-cell and rerender inside `protocol.run(txId)` so React attributes lanes.

## Advantage

Worlds are free: a world is an array of live transactions, so N concurrent transitions cost O(their writes) — no per-atom copies, no versioned storage — and quiescence returns memory to zero. Rebase ordering (urgent-over-deferred, functional-update replay) falls out of log structure rather than dedicated machinery. The seam is the prize: three shared-internals fields plus an `urgent(fn)` that nulls both T and B, judged the cleanest fork; 1217 total lines is readable in one sitting.

## Disadvantage

Worst: world reads have zero memoization — `evaluateWorld()` re-runs the full computed chain on every render-world read, so a transition render pays O(graph) per `useValue`, and `fold()` costs O(open transactions × log length) per atom read. Canonical path is allocation-heavy: Set subscribers, `[...subscribers]` copy per notify, `depValues` rebuilt by re-getting every dep after each run. Every urgent write scans the global transactions array.

## Room for optimization

The 3.95x CI ratio (14252ms vs alien 3604ms) is mostly canonical-graph bookkeeping, not STM: cellx1000 runs 10x slower (35.85 vs 3.62ms) with no transactions involved. Levers: (1) intrusive linked dependency edges plus version stamps replacing Set subscribers and depValues snapshot-compare — hits updateSignals (4.3x) and every propagation suite; (2) memoize world evaluations keyed by the `worldKey()` id:revision string already computed for thenable identity; (3) eliminate the per-notify subscriber copy and post-run dep re-gets.

## Bugginess

Judged clean after one fix round. Original flags: render-write guard and flushSync ordering lived only in the verification adapter; both moved into library/fork (+3 disclosed fork LOC), judge-verified with a fresh scratch test. Final gates: 191/191 engine, 179/179 conformance, 1200-seed oracle, 25/25 shared battery, 16/16 real-React, 2/2 leak audit under real GC. Residual: inline promise factories can double-fetch after settlement (documented); the render-write guard activates only once bindings load. High shipping confidence for the size.
