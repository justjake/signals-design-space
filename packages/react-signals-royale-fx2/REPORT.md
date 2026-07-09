# signals-royale-fx2 — REPORT

Entry: `packages/signals-royale-fx2` (engine) + `packages/react-signals-royale-fx2`
(bindings) + an 11-line React patch (`patches/`, one commit over
`e71a6393e6`). All numbers below were produced by fresh runs in the final
verification session; command lines are verbatim.

## 1. Design summary

React is the world clock. The engine keeps canonical state in a conventional
signal graph and layers concurrency as a replay overlay: transition writes
become drafts (ordered intent logs), and a reader resolves values in a world
= canonical + a specific draft set. Which passes see which drafts is decided
by React itself: draft ids are dispatched into each root's `SignalScope`
reducer inside the owning `startTransition`, so React's own update queues
carry the world — urgent passes skip it, the transition's passes include it,
rebased retries recompute it, and functional updates replay against each
world's base (the (1+1)x2=4 arithmetic falls out of replay order, not custom
lane bookkeeping). The `useSyncExternalStore` snapshot is a subscription
epoch — never a value — so drafts never look like store mutations and
React's transition machinery (holding, time slicing, interruption) keeps
working with no sync-fallback de-opt. A draft retires when every root that
received it commits it; retirement folds intents through the ordinary write
path (effects fire once) and quiescence drops every per-episode structure.
Async is graph state: computeds evaluate-to-pending with one stable episode
promise per span, so Suspense retries never refetch. The only thing stock
React cannot do is the DOM mutation window, so the fork is exactly that: 11
lines.

## 2. The fork: 11 lines, with per-line justification

`git -C vendor/react diff --numstat e71a6393e6..HEAD -- packages/ ':!packages/*/src/__tests__*'`
→ **11** insertions, 0 deletions, one file (`react-reconciler/src/ReactFiberWorkLoop.js`),
plus one jest test file (excluded by the metric). Ledger:

| Lines | What | Why it cannot be userland |
|---|---|---|
| 5 (comment x3 + hook read + start call) at `flushMutationEffects` entry | emit window-start per commit | Stock React exposes no signal at mutation-phase entry: `getSnapshotBeforeUpdate` fires only on class fibers with pending updates (a commit caused by unrelated state bypasses any fixed component); insertion/layout effects run per-fiber inside/after the phase with no phase-entry ordering guarantee; a `MutationObserver` reports asynchronously after the fact — too late to disconnect; patching DOM prototypes observes mutations but cannot attribute them to React vs third parties, which is the entire contract. Bracketing requires standing inside the commit. |
| 2 (blank + stop call) after the mutation loop | emit window-stop before layout effects | Same argument, exit edge: the contract is an exact bracket (user/layout/passive effects outside the window), so the stop must fire after the last host mutation and before the layout phase — a point only the reconciler reaches. |
| 4 (blank + comment x2 + assignment) at EOF | `__FX2_REACT_PROTOCOL__ = 1` handshake | RULES requires registration to fail loudly on a stock build. Userland cannot decide whether a build will call the hook except by triggering a real commit and waiting — that is not failing loudly at registration time. One marker line makes the capability detectable (see §8 for the markerless alternative and why the marker stays). |

The window dispatch reads `globalThis.__FX2_MUTATION_WINDOW__` per commit —
uninstalled cost is one null check; stock behavior is unchanged (pinned by a
fork test).

## 3. Gates (all run fresh in this session)

| Gate | Command | Result |
|---|---|---|
| Typecheck engine | `pnpm typecheck` (packages/signals-royale-fx2) | pass (tsc --noEmit, strict) |
| Typecheck react | `pnpm typecheck` (packages/react-signals-royale-fx2) | pass |
| Conformance | `pnpm exec vitest run tests/conformance.spec.ts` | **179 passed (179)** |
| Engine suite | `pnpm test` (engine) | **224 passed (224)** — includes oracle default + leak audit |
| Oracle default | in suite | `oracle fuzz (300 seeds x 90 steps)` + 2 sabotage canaries, pass |
| Oracle deep sweep | `ROYALE_FX2_SEEDS=1200 pnpm exec vitest run tests/oracle-fuzz.spec.ts` | `oracle fuzz (1200 seeds x 90 steps) > engine matches the naive model on every seed` pass |
| Leak audit | `vitest run tests/gc-leaks.spec.ts` (forks pool, --expose-gc) | 6 passed (6) |
| Real-React gate | `pnpm test` (react pkg; raw createRoot + act, jsdom, own fork build) | **31 passed (31)** — scenarios 1–18 + host guarantees |
| Fork protocol | `cd vendor/react && yarn test --no-watchman ReactDOMFx2MutationWindow` | `Tests: 6 passed, 6 total` |
| Adjacent upstream | `yarn test --no-watchman ReactDOMRoot ReactFlushSync ReactTransition` | `70 passed, 1 skipped` (skip is upstream's) |
| Pristine patches | `git am patches/*` onto `e71a6393e6` in a fresh worktree | patched tree `6d72a7a9…` == fork branch tree (bit-identical); `./build.sh` builds (`Built: 19.3.0`); gate re-run green on the fresh build |
| Shared battery | `pnpm test` in `royale/verify-kit/battery` (ADAPTER → my `royale/adapter.ts`, links → my fork build) | **25 passed (25)** |

Verbatim tails:

```
Tests  179 passed (179)          # conformance
Tests  224 passed (224)          # engine suite
Tests  31 passed (31)            # real-React gate
Tests: 6 passed, 6 total         # fork protocol (jest)
Tests  25 passed (25)            # shared battery
✓ oracle fuzz (1200 seeds x 90 steps) > engine matches the naive model on every seed
```

## 4. LOC self-count

```
node royale/verify/count-loc.mjs --fork vendor/react --base e71a6393e66b0d2add46ba2b2c5db563a0563828 \
  --head royale/fx2-react --lib packages/signals-royale-fx2 --lib packages/react-signals-royale-fx2
forkLoc: 11
libLoc: 2239
```

- **Fork: 11** (incumbent: 1510 — 137x smaller; below the 200–520 estimate).
- **Library: 2239** — engine 1838 (graph 747, worlds 412, index 364, asyncs
  171, tracer 96, lifetime 48) + react 401 (host 196, hooks 93, scope 66,
  transitions 30, index 16). Incumbents ≈ 4700–5000.
- At the judged commit the count was 11 / 2194 (an earlier revision of this
  section misquoted 2193); the +45 since is the judgement fixes (§10), all
  library-side.

## 5. Benchmarks

### milomg js-reactivity-benchmark (isolated runner, 3 rounds, median)

`node dist/isolated.js --rounds 3 "Royale FX2" "Alien Signals"` after
registering per ROUND2 (adapter sanity: 4/4 including exact pull counts).

| test | Royale FX2 | Alien Signals | ratio |
|---|---|---|---|
| createSignals | 1.30 | 1.43 | 0.91 |
| createComputations | 58.60 | 90.57 | 0.65 |
| updateSignals | 310.23 | 260.19 | 1.19 |
| avoidablePropagation | 147.37 | 95.04 | 1.55 |
| broadPropagation | 98.24 | 77.45 | 1.27 |
| deepPropagation | 40.90 | 30.42 | 1.34 |
| diamond | 113.53 | 79.21 | 1.43 |
| mux | 91.51 | 74.03 | 1.24 |
| repeatedObservers | 18.74 | 18.28 | 1.03 |
| triangle | 33.97 | 22.34 | 1.52 |
| unstable | 53.93 | 18.22 | 2.96 |
| molBench | 14.89 | 14.35 | 1.04 |
| cellx1000 / cellx2500 | 5.24 / 14.31 | 3.28 / 9.42 | 1.60 / 1.52 |
| 2-10x5 lazy80% | 216.97 | 144.88 | 1.50 |
| 6-10x10 dyn25% lazy80% | 115.22 | 99.99 | 1.15 |
| 4-1000x12 dyn5% | 320.75 | 265.45 | 1.21 |
| 25-1000x5 | 382.33 | 335.19 | 1.14 |
| 3-5x500 | 94.87 | 73.58 | 1.29 |
| 6-100x15 dyn50% | 172.90 | 150.36 | 1.15 |

**Geomean ratio 1.278** (total-time ratio 1.237) vs Alien Signals. Zero
benchmark assertion failures (`node dist/index.js "Royale FX2" | grep -c
"Assertion failed"` → 0). Leak disclosure: no leaks on either side of the
comparison — `withBuild` wraps each graph in an effect scope and `cleanup()`
disposes it deterministically; the bench's dropped per-effect disposers are
scope-owned and exempt from finalizer reclamation (see §7.2). Machine note:
a sibling entrant's benchmark ran concurrently for part of the window; the
interleaved-rounds + median design is built for that drift, but treat ±10%
as noise. The clone's pre-existing `x-reactivity` sanity failure (pull count
51 vs 41) is upstream of my registration (fails with my changes stashed;
my lockfile diff is only the added `file:` dep).

### React seam bench (`bench/react-bench.mjs`, jsdom, real timers, no act)

Contenders: these bindings vs a ~35-line stock `useSyncExternalStore` store,
same component shapes. Urgent input is delivered as real click events
(discrete priority — what a keystroke gets).

| scenario | stat | royale-fx2 | uses-baseline |
|---|---|---|---|
| fanout (5000 cells, 200 writes) | median write→commit | 3.12 ms | 2.64 ms |
| transition (2000-cell rewrite + 60 urgent ticks) | p95 urgent | 10.11 ms | 2.72 ms |
| transition | **max urgent** | **10.28 ms** | **329.05 ms** |
| transition | transition completed after | 1781 ms | 1427 ms |
| mount (5000-cell tree, 5 roots) | median | 57.04 ms | 48.77 ms |

The story is the max column: the stock store degrades the bulk rewrite to a
synchronous blocking render — one 329 ms input freeze — while these bindings
keep the rewrite a real time-sliced transition; the worst urgent tick ever
waits ~10 ms (one slice), at the cost of the transition itself finishing
~25% later and ~18% fanout/mount overhead vs the bare store.

## 6. Feature coverage

- Writable signals + custom equality + labels — done. Lazy initializers
  (first-touch, set-before-read runs it, SSR install does not) — done.
- Functional updates that replay per world — done (battery + gate pin 2→4/2→6).
- Computeds: lazy, cached, equality cutoff, dynamic deps + trimming, exact
  pull counts; per-world dependency sets — done (conformance + milomg counts).
- Effects/scopes with cleanup + disposers; canonical-only — done.
- batch/startBatch/endBatch, untracked — done.
- Lifetime effects (union of subscriber kinds, flap coalescing, StrictMode
  nets one) — done.
- Concurrent model: classification, render-pass consistency, urgent-during-
  transition rebase, rollback re-notify, per-root committed views, flushSync
  exclusion, quiescence — done.
- Read family: get/latest/committed/isPending/refresh — done, including the
  adjudicated latest() context rule (§7.1).
- Async/Suspense: evaluate-to-pending, parallel parks, stable thenables,
  error boxes, two-level suspend-vs-stale, settlement-as-write with world
  attribution — done.
- React bindings: useValue/useComputed/useSignalEffect/useCommitted/
  useIsPending/useAtom, useSignalTransition + startTransitionWrite + plain
  startTransition classification, loud registration, multi-root, write-
  during-render throws, unmount silence — done.
- SSR serialize/initialize/installState — done. Causality tracer (attach/
  detach, causal parents, whyLastDelivery, ring mode + overflow counter) —
  done. Mutation window with real MutationObserver test — done.

## 7. Round 2: what changed this session and why

1. **The latest() context rule (the adjudicated pitfall) — two real bugs
   fixed.** (a) `latest()` inside a *canonical computed evaluation* fell
   through to newest-intent, so a held draft leaked into canonical caches,
   and the read was untracked, so the computed went permanently stale after
   the draft folded. Fix: an active canonical consumer resolves CANONICAL
   and the read registers a tracked dependency. (b) The render-pass world
   was a sticky engine global set by `useValue` and never cleared, so
   *ambient* `latest()` after any render resolved that render's world (a
   canonical last pass hid live drafts). Fix: the seam is now a provider —
   the host answers "what world is rendering right now", gated on React's
   live hook dispatcher, noted by the SignalScope render (top of every
   draft-carrying pass, in tree order) and by every world-reading hook.
   Regression tests at both levels were written first and verified to fail
   pre-fix (engine: worlds.spec `latest() context resolution` x4; React:
   real-react.spec `the latest() context rule`, which pins: urgent bodies
   never see the draft, draft-carrying passes always do, canonical computed
   evaluations stay canonical AND live, ambient sees newest intent even
   right after an urgent pass).
2. **Scope-owned effects could be killed by GC.** Found because the milomg
   run printed assertion storms: `makeEffect` armed the FinalizationRegistry
   on every per-effect disposer, so when a scope owned the effect and the
   caller (correctly) dropped the disposer, a later GC disposed a live
   effect. Intermittent, heap-pressure dependent — surfaced only when the
   benchmark bundle's other frameworks inflated the heap. Fix: ownership
   rule — an effect created inside a scope/effect lives and dies with its
   owner; only ownerless effects arm the reclamation registry. Regression
   test (gc-leaks: `a scope-owned effect survives GC of its unused
   per-effect disposer`) failed pre-fix, passes now; the ownerless-drop
   reclamation tests still pass. Benchmark asserts went from thousands to 0
   — earlier timings were invalid and were re-measured after the fix.
3. **patches/ actually generated** (the directory was empty despite the
   commit message) + proven: applying the series to a pristine base worktree
   reproduces the fork branch tree hash exactly; fork files reformatted
   under React's own prettier (test file only; metric unchanged at 11).
4. **react-bench urgent input switched to real click events** so the urgent
   lane is what user input actually gets (a bare `setState` from a timer
   rides the default lane and queues FIFO behind the scheduler); per-tick
   latency re-anchors to each tick's intended moment.

Nothing in the shared battery is disputed.

## 8. Known gaps and honest risks

- **Plain `latest()` in a render with zero fx2 hooks rendered earlier in
  that pass** (only possible in an urgent pass whose dirtied components use
  no fx2 hook before the call) resolves the most recently noted world — the
  previous pass's. The world is React state read via context, which a plain
  function cannot reach; every judged shape (probes that subscribe, or any
  ancestor that does) is covered. Recommendation in docs: subscribe with
  `useValue` when rendering, peek with `latest` elsewhere.
- **The mutation-window carrier is one global slot.** The fork reads
  `globalThis.__FX2_MUTATION_WINDOW__`; if a bundler ships duplicate copies
  of these bindings, the last `registerReactSignals()` wins the slot and the
  other copy's `onDomMutation` subscribers go quiet (last-writer-wins, no
  error). Registration is process-global by design — one React build, one
  hook — so the mitigation is packaging: dedupe the library.
- **The 3 handshake lines are a convenience, not strictly forced.** A
  markerless registration probe is arguably possible: `flushSync` a probe
  render into a detached root at registration time and observe whether the
  window fires during that commit. The marker stays because the probe turns
  "fail loudly at registration" into "fail after a side-effectful
  experiment" (a real commit, layout/passive effects, timing assumptions on
  the first window dispatch); the trade-off is 3 fork lines that a stricter
  count could argue down to 8.
- milomg `unstable` is 2.96x alien (dynamic-dependency churn re-links
  eagerly); overall geomean 1.278 is behind the alien-parity bar.
- Transition-scenario p95 (10 ms ≈ one slice) is above the baseline's 2.7 ms
  happy path; the baseline's 329 ms max is the failure mode the design
  removes. Fanout/mount carry ~18% overhead vs a bare store.
- Timing numbers were taken on a shared machine (a sibling entrant's run
  overlapped part of the window).
- The benchmark clone's `x-reactivity` sanity failure is pre-existing
  upstream; documented, not mine to fix.

## 9. What I'd do with another day

- Chase `unstable` and the propagation-family gap: the mark wave currently
  re-walks subscriber lists per write; a two-generation mark (alien-style)
  should close most of the 1.3–1.5x.
- Fanout claim path: batch uSES notify fan-out per commit to cut the ~0.5 ms
  fanout delta and mount cost.
- A per-pass world beacon: teach `SignalScope` to re-render at the top of
  urgent passes too (context-selector trick) to close the last latest()
  corner without a fork line.
- Wire the causality tracer into the playground UI (the format is already
  human-readable; a live "why did this re-render" panel is one afternoon).

## 10. Judgement fixes

The judgement round verified the headline (11-line fork bit-identical under
patch replay, gates reproduced, 9/9 probes green) and found two undisclosed
correctness gaps. Both are fixed below; the fork is untouched (tree still
`6d72a7a9…`, patches unchanged).

### 10.1 Mixed-root fold staleness (moderate)

A `useValue` subscriber in a root without `SignalScope` went stale when a
transition retired via a scoped root's commit: the silent fold suppresses
the `reactEpoch` snapshot bump, so epoch-snapshot subscribers outside any
scope bailed forever (judge probe E i-b pinned the bare root at `b:1;` with
canonical already 2, repaired only by the next canonical write). Resolution:
converge, not enforce — `SignalScope` is a public export, and a scope-less
root is a legitimate degraded mode (canonical-only view, no transition
worlds). Two parts:

- Engine: every node carries a `canonicalEpoch` companion to `reactEpoch`
  that silent folds still advance. Hooks rendering outside any scope
  (detected by a distinct context-default identity) snapshot the companion;
  scoped subscribers keep `reactEpoch`, so the post-fold repair storm the
  epoch design exists to prevent does not return.
- Bindings: a fold is silent only when every currently mounted scope carried
  the draft. A scope mounted mid-transition never carried it — the same
  staleness class one level up — so its presence makes the retirement loud.

Regression tests, verified failing pre-fix: react `silent folds must repair
subscribers the render-pass worlds never reached` (bare root `b:1;` vs
expected `b:2;`; late-mounted scope `r:1;` vs `r:2;`); engine worlds.spec
`a silent fold keeps the react epoch still but advances the canonical
epoch`. The oracle learned the class: every fuzz schedule now runs bail-style
bare subscribers (subscribe, snapshot the canonical epoch, re-read only on
change) over cell 0 and comp 0, retires are ~50% silent, and a second
sabotage canary (snapshot blinded back to `reactEpoch`) is caught. Re-run
against the judge's pinned probes: 8/9 pass; the one failure is the
pinned-as-observed staleness expectation itself, which now reads `b:2;` —
the value the probe comments call fully correct.

### 10.2 useIsPending during transition-owned refresh (minor)

`refresh(x)` inside a transition with unchanged inputs was correct at engine
level (in-world refetch, stale serves, commits with the transition) but the
rendered `useIsPending` hook never flipped: the draft-side nonce append
poked only the nonce cell's direct leaf observers, and pending probes
subscribe to the computed they probe, not to its hidden input. Fix:
`pokeLeafObservers` now walks watched derived edges down to the leaves, so
draft activity on any input reaches every downstream subscription (draft
appends, folds, discards, and per-root commit pokes all inherit the wave;
effects remain canonical-only and are never poked). Regression tests,
verified failing pre-fix: react `refresh inside a transition, inputs
unchanged: useIsPending flips while stale serves` (`i;d:one` vs expected
`P;d:one`); engine worlds.spec `a draft append notifies leaf observers of
computeds over the cell`. Judge probe B now logs `engine isPending: true
hook rendered: d:one;p:P`.

### 10.3 Report corrections and disclosures

- Fork ledger line-split corrected to 5/2/4 (was 6/2/3; total 11 exact, §2).
- Pristine patched-tree hash corrected to `6d72a7a9…` (was misquoted
  `30b03c73…`, §3).
- Judged-commit libLoc was 2194 (was misquoted 2193, §4).
- Added to §8: the `__FX2_MUTATION_WINDOW__` global-carrier caveat
  (last-writer-wins across duplicate library copies) and the judge's note
  that a markerless flushSync probe-commit detection was arguably possible
  (the 3 marker lines stay; the trade-off is recorded).

### 10.4 Fresh outputs (this session, suites sequential)

```
tsc --noEmit                     # engine and react packages: clean
Tests  224 passed (224)          # engine suite (was 221: +2 worlds, +1 canary)
✓ oracle fuzz (1200 seeds x 90 steps) > engine matches the naive model on every seed
Tests  31 passed (31)            # real-React gate (was 28: +3 regressions)
Tests  25 passed (25)            # shared battery (royale/verify-kit/battery)
probes: 1 failed | 8 passed      # /tmp/fx2-probes: E(i-b) pinned-staleness line, now b:2;
```

LOC delta (`node royale/verify/count-loc.mjs`, same invocation as §4):
forkLoc 11 → **11** (fork untouched); libLoc 2194 → **2239** (+45, all
library-side: graph +20, host +14, hooks +7, index +3, scope +1).
