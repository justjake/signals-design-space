# signals-royale-fx2 — REPORT

Entry: `packages/signals-royale-fx2` — engine at the root export, React
bindings at the `./react` subpath (consolidated from the former
`packages/react-signals-royale-fx2` in §14; earlier sections name the two
packages as they were in those rounds and are kept as history). **As of the
Production round (§11) the entry is FORKLESS: zero React patches, fork LOC
0** — the earlier 11-line mutation-window patch and its surface were removed
by owner ruling; §§2–10 describe prior rounds and are kept as history.
Numbers in each section were produced by fresh runs in that round's
verification session; command lines are verbatim.

## 1. Design summary

React is the world clock. The engine keeps canonical state in a conventional
signal graph and layers concurrency as a replay overlay: transition writes
become drafts (ordered intent logs), and a reader resolves values in a world
= canonical + a specific draft set. Which passes see which drafts is decided
by React itself: draft ids are dispatched into each root's `SignalsFrameworkProvider`
reducer inside the owning `startTransition`, so React's own update queues
carry the world — urgent passes skip it, the transition's passes include it,
rebased retries recompute it, and functional updates replay against each
world's base (the (1+1)x2=4 arithmetic falls out of replay order, not custom
lane bookkeeping). The `useSyncExternalStore` snapshot is a subscription
epoch — never a value — so drafts never look like store mutations and
React's transition machinery (holding, time slicing, interruption) keeps
working with no sync-fallback de-opt. A draft retires when every root that
received it commits it; retirement folds intents through the ordinary write
path (effects fire once) and quiescence drops every per-suspension structure.
Async is graph state: computeds evaluate-to-pending with one stable suspension
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
~25% later and ~18% fanout/mount overhead vs the plain store.

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
- Read family: get/latest/committed/isPending — done, including the
  adjudicated latest() context rule (§7.1). (`refresh` shipped here
  originally; removed by owner ruling — §16.)
- Async/Suspense: evaluate-to-pending, parallel parks, stable thenables,
  error boxes, two-level suspend-vs-stale, settlement-as-write with world
  attribution — done.
- React bindings: useValue/useComputed/useSignalEffect/useSignalLayoutEffect/useCommitted/
  useIsPending/useAtom, useSignalTransition + startSignalTransition + plain
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
   live hook dispatcher, noted by the SignalsFrameworkProvider render (top of every
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
   lane is what user input actually gets (a plain `setState` from a timer
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
  removes. Fanout/mount carry ~18% overhead vs a plain store.
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
- A per-pass world beacon: teach `SignalsFrameworkProvider` to re-render at the top of
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

A `useValue` subscriber in a root without `SignalsFrameworkProvider` went stale when a
transition retired via a scoped root's commit: the silent fold suppresses
the `reactEpoch` snapshot bump, so epoch-snapshot subscribers outside any
scope bailed forever (judge probe E i-b pinned the unscoped root at `b:1;` with
canonical already 2, repaired only by the next canonical write). Resolution:
converge, not enforce — `SignalsFrameworkProvider` is a public export, and a scope-less
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
subscribers the render-pass worlds never reached` (unscoped root `b:1;` vs
expected `b:2;`; late-mounted scope `r:1;` vs `r:2;`); engine worlds.spec
`a silent fold keeps the react epoch still but advances the canonical
epoch`. The oracle learned the class: every fuzz schedule now runs bail-style
unscoped subscribers (subscribe, snapshot the canonical epoch, re-read only on
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

## 11. Production round: forkless, tear-closed, targeted wakes

Owner-ruled directives, all landed this session. Everything below runs on
STOCK React: `vendor/react` checked out at the base commit
`e71a6393e66b0d2add46ba2b2c5db563a0563828` (no fork commit), stock artifacts
built via `./fork/build-react.sh` — the same commit the npm canary
`19.3.0-canary-e71a6393-20260702` is cut from, chosen over the npm tarball
so the exact bits are reproducible offline. The built `react-dom` contains
zero `FX2` symbols (grep-verified). The fork branch `royale/fx2-react`
stays in git history only.

### 11.1 Fork removal

- `onDomMutation` deleted from the bindings and from the RoyaleAdapter;
  `__FX2_MUTATION_WINDOW__` / `__FX2_REACT_PROTOCOL__` consumption deleted;
  `registerReactSignals()` succeeds on stock React (pinned by a test that
  asserts no global marker exists).
- `patches/` and `build.sh` removed from the react package.
- The mutation-window test became a README statement: DOM-mutation
  attribution needs reconciler cooperation and is out of scope. The shared
  battery's scenario 16 is exempt by owner ruling — run expecting exactly
  that one failure (`TypeError: adapter.onDomMutation is not a function`).
- §8's `__FX2_MUTATION_WINDOW__` global-carrier and markerless-handshake
  caveats are obsolete: the surface no longer exists.
- Fork LOC: **0** (`count-loc.mjs --head HEAD`, diff base..base is empty).

### 11.2 The latest() no-hook tear, closed in userland

The old ambient render-world note was a sticky module global gated only on
"a hooks dispatcher is live": any pass that did not itself re-note could
consume another pass's world. Now the note is VALIDITY-GATED:

- per-scope: the note carries the writing scope's identity-stable record;
  any fx2 hook rendering under a different scope kills it (foreign roots
  never inherit);
- per-window: a note carrying live drafts expires at the end of the
  synchronous window that wrote it — a microtask covers every stack unwind
  (event handlers, urgent flushes between slices), and an immediate-priority
  `scheduler` task covers same-stack handoffs between work-loop tasks (a
  fast-suspending pass followed by another root's render in one flush);
- fallback: a render with no valid note resolves CANONICAL (per ruling,
  wrong-toward-canonical is acceptable; stale worlds and drafts-in-urgent
  never are). Ambient (non-render) reads still see newest intent.

Regression tests, each verified failing pre-fix with the draft value where
canonical was required (`expected [2] to deeply equal [1]`):
urgent pass over an unrelated subtree while a transition is held; two roots
back-to-back (unscoped second root); interleaved `flushSync` while a transition
pass is mid-flight; StrictMode double render. Residual corner, disclosed:
within one synchronous chunk, a second pass that renders ZERO fx2 hooks or
scopes before a plain `latest()` call can still consume the first pass's
note if the scheduler ran it before the expiry task (only possible for a
starved, already-expired task) — no known reachable shape on stock React's
scheduler, and every judged shape is covered by the tests above.

### 11.3 The transition broad-wake, killed

Before: every draft dispatch changed the WorldContext value (`{ids, rev}`),
re-rendering EVERY `useValue` consumer in the transition pass — renders
scaled with subscriber count. Now:

- ReactRootConnectionContext's value is the scope's identity-stable record (never
  replaced), so the scope re-renders alone and React bails out below it;
  world membership travels through the scope's note and per-hook state.
- Each `useValue` owns a draft-lane channel: a second `useReducer` next to
  the epoch-snapshot `useSyncExternalStore`. Draft writes never bump the
  uSES snapshot (snapshot world-independence is what prevents the
  sync-fallback de-opt); they dispatch the draft id into the reducers of
  exactly the written cell's subscribers (walking watched computed edges),
  at write time — where React's ambient `.T` is already the transition —
  so the updates ride the owning lanes.
- Corrections after the fact (components mounting mid-transition, appends
  delivered from plain contexts) set-and-restore `ReactSharedInternals.T`
  to the owning transition object around the dispatch (technique proven in
  the fx1 entry), gated on the draft's scope audience: a hook inside a root
  that carried the draft joins it; a root that never carried it stays on
  the committed world and converges through the loud fold (stock parity —
  a new root never holds another root's pending updates).
- Late appends to a live rendered draft re-dispatch per written cell only;
  the scope's reducer still confirms per-root commits and drives fold
  loudness (draftAudience unchanged).

Measured wake counts (the required proof, render-count assertions on all
N): 8 subscribers, transition drafts 1 cell → renders `[1,1,1,2,1,1,1,1]`
(pre-fix: `[2,2,2,2,2,2,2,2]`), committed text correct, retirement still a
silent fold (no post-commit renders). Late-append test: untouched
subscribers stay at their mount count through first write, append, and
commit, and the committed DOM never shows a partial batch (pre-fix the
append leaked `1;2;…` into a committed frame through the sync lane).
Preserved and re-proven by the suite: urgent passes exclude drafts, rebase
retries recompute, unscoped-root canonicalEpoch convergence, StrictMode
double-dispatch netting, interleaved transitions keep distinct audiences
(T1's wakes never render T2's subscribers; commits entangle only through
the shared scope queue, stock updater rules).

react-bench deltas (same harness as §5, stock React, medians of 3 runs):

| scenario | stat | royale-fx2 | uses-baseline | prior round (fx2/base) |
|---|---|---|---|---|
| fanout | median write→commit | 3.62 ms | 3.15 ms | 3.12 / 2.64 |
| transition | p95 urgent | 10.06 ms | 3.61 ms | 10.11 / 2.72 |
| transition | **max urgent** | **10.12 ms** | **330.48 ms** | 10.28 / 329.05 |
| transition | completed after | 1759 ms | 1423 ms | 1781 / 1427 |
| mount | median 5000-cell | 52.8 ms | 50.3 ms | 57.04 / 48.77 |

Mount overhead dropped from ~17% to ~5% (context-value churn gone; the
scope never re-renders its subtree). Fanout stays ~17%: it is a pure
urgent-path scenario (no transitions), so it never exercised the broad
wake — its delta is the engine's write→notify machinery vs a plain array
store, unchanged this round. The transition columns are unchanged by
design: that scenario drafts EVERY cell, so the audience is everyone; the
targeted-wake win shows in the wake-count test (1 of N) and in mount.
Honest note: React's dev build prints a "large number of updates inside
startTransition" advisory during the 2000-cell rewrite (one reducer
dispatch per affected subscriber); it is a dev-only heuristic, absent in
production builds, and the measured time-slicing (10 ms max urgent) shows
no de-opt.

### 11.4 Fresh gates (this session, suites sequential, stock React)

```
tsc --noEmit                     # engine and react packages: clean
Tests  179 passed (179)          # conformance
Tests  224 passed (224)          # engine suite (oracle default + leak audit)
✓ oracle fuzz (1200 seeds x 90 steps) > engine matches the naive model on every seed
Tests  38 passed (38)            # real-React gate (31 − scenario 16 − protocol test
                                 #   + stock-registration + 8 production regressions)
Tests  1 failed | 24 passed (25) # shared battery: the one failure is scenario 16,
                                 #   TypeError: adapter.onDomMutation is not a function (exempt)
forkLoc: 0                       # count-loc.mjs, --head HEAD at base commit
libLoc: 2339                     # engine 1895 (graph 773, worlds 438, index 369,
                                 #   asyncs 171, tracer 96, lifetime 48)
                                 # react 444 (host 236, hooks 113, scope 54,
                                 #   transitions 30, index 11); was 2239 (+100)
```

All seven production regressions were run before the fix and failed with
the exact tear/broad-wake symptoms quoted above; the suite output is
reproducible by checking out the spec alone onto the prior commit.

## 12. Draft-wake dedup + fused intent-append walk

Two costs in the write path of a transition, both removed this session:

- **Per-write re-dispatch.** Every drafted write re-dispatched the draft id
  to every downstream subscriber hook (`appendDraftIntent` → leaf
  `onDraftWake` → the hook's reducer), and `worldsReducer` returns a fresh
  state object by design, so React could never bail: a transition writing
  one cell 100× sent 100 identical dispatches per hook. Fixed at the hook
  layer — the engine walk stays dumb. Each `useValue` keeps a ref'd Set of
  draft ids delivered since its last render; the wake closure skips ids
  already in the set. The set is cleared UNCONDITIONALLY in the render
  body: the dispatch is scheduling-only, so a skipped id is one already
  sitting undelivered in this hook's queue and the pass that consumes it
  resolves the world live — but once a pass has consumed the draft, a new
  intent must re-dispatch or React bails out and the transition commits a
  stale frame. Over-clearing (abandoned pass, StrictMode double render)
  only permits a redundant dispatch — the pre-change behavior. Writes
  during render throw, so no delivery can race the clear. The commit-time
  correction path (`correctSubscription`) now routes through the same
  delivered-set, so a correction delivery also suppresses later duplicate
  write-time wakes. The scope path needed nothing: `broadcastDraft` was
  already once-per-draft-per-scope (confirmed — the scope's dispatch is
  called only there; late appends reach it through nothing but the hooks).
- **Double traversal.** `appendDraftIntent` ran two identical walks
  back-to-back (`pokeLeafObservers`, then `wakeLeafDraftSubscribers`) over
  the same watched-derived frontier. Fused into one walk
  (`pokeAndWakeLeafObservers`) that schedules the notify leaves, flushes,
  then delivers the draft id — flush first because the wave's own effects
  may dispose subscriptions, and a disposed leaf must not receive the id.
  `pokeLeafObservers` survives for the retire/discard paths, which poke
  without waking.

Falsify evidence (regression run against the pre-change tree):

```
× wake: … > a same-cell write burst dispatches one draft-lane wake per
  subscriber, not one per write
  AssertionError: expected 400 to be 4 // Object.is equality
```

(4 subscribers × 100 writes = 400 reducer dispatches before the transition
pass rendered; now 4 — one per hook, counted through a test-only seam on
`dispatchDraftWake`.) The two guard tests — late append to a cell the
transition pass already rendered (exactly one additional transition render,
appended value commits), and the StrictMode double-render-then-append
variant — pass both before and after the change; they pin the
clear-on-render contract that keeps dedup from swallowing late appends.
The wake-count test (8 subscribers, renders `[1,1,1,2,1,1,1,1]`) stays
green, as do all prior suites.

react-bench (medians of 3 runs per side, same harness as §5):

| scenario | stat | before | after |
|---|---|---|---|
| transition | p95 urgent | 9.99 ms | 9.88 ms |
| transition | max urgent | 10.68 ms | 10.38 ms |
| transition | completed after | 1745 ms | 1755 ms |
| fanout | median write→commit | 2.85 ms | 2.47 ms |
| mount | median 5000-cell | 51.8 ms | 53.9 ms |

Neutral within noise, by design: the bench's transition scenario writes
each cell once, so dedup never engages there and the fused walk saves one
short traversal per write. The win is the burst shape (N×writes → 1
dispatch per hook), pinned by the regression test rather than a bench.
Dev-build advisory (probed via `bench/advisory-probe.mjs`): the "large
number of updates inside startTransition" warning counts DISTINCT fibers
(`_updatedFibers` is a Set), not dispatches — so dedup cannot change it. A
same-cell burst over ≤10 subscribers stays silent (before and after); over
>10 subscribers it still fires (11+ fibers genuinely update once each), as
does the 2000-cell rewrite. Dev-only heuristic, absent in production
builds.

Gates fresh this session: engine `tsc` clean + 224 passed; oracle fuzz 1200
seeds × 90 steps green; react `tsc` clean + 41 passed (38 + the burst
regression + 2 append guards); battery 24 passed / 1 failed (scenario 16,
exempt).

## 13. Node type moved into the flags word (refactor-parity)

Preparation for the two-tier watched/unwatched graph rebuild, which needs
more flag bits than a scalar staleness enum leaves room for:

- `Flags` is now a bitmask word with explicit binary literals and the full
  layout documented at the definition (`graph.ts`): type bits
  `Cell`/`Derived`/`Watcher` (`0b1`/`0b10`/`0b100`), staleness bits
  `Check`/`Dirty` (`0b1000`/`0b1_0000`), `0b10_0000` and up reserved for
  the tier bits.
- The `kind` string discriminant is deleted from node records; every node
  kind check in both packages is a bit test with an explicit cast at the
  test site (alien-signals style). The react package needed no changes —
  its `.kind` reads are Envelope fields, a different record.
- The staleness machine is unchanged: Check and Dirty stay exclusive,
  both-clear is Clean, and staleness writes clear the field before setting,
  so single-bit tests read exact states.

No behavior change expected, none observed; the gates are the evidence.
Gates fresh this session: engine `tsc` clean + 224 passed; deep oracle
`oracle fuzz (1200 seeds x 90 steps) > engine matches the naive model on
every seed` green; react `tsc` clean + 41 passed; battery 24 passed / 1
failed (scenario 16, exempt). Residue grep for `'cell'|'derived'|'watcher'`
string literals over both `src/` trees: zero hits.

## 14. Package consolidation (refactor-parity)

The two packages became one: `packages/react-signals-royale-fx2` is deleted
and the bindings live at `signals-royale-fx2/react`.

- Layout: bindings source moved (git mv, history preserved) to
  `src/react/` (`index`, `host`, `scope`, `hooks`, `transitions`,
  `scheduler.d.ts`); bindings imports of the engine became relative
  (`../index.ts`). React specs moved into `tests/` and keep their
  `@vitest-environment jsdom` docblocks (engine specs stay node); one merged
  vitest config, forks pool + `--expose-gc` retained for the leak suite.
  The React bench scripts moved under `bench/`; the shared-surface adapters
  moved into `royale/`.
- Exports map: `{ ".": "./src/index.ts", "./react": "./src/react/index.ts" }`.
  Tests import both specifiers by package name (Node/Vite self-reference
  through the exports map), so the map itself is exercised by the suite —
  resolution verified by running, not assumed.
- React dependency: the `link:` deps on the local vendor build are replaced
  by the published npm canary cut from the same pinned commit —
  `react`/`react-dom` `19.3.0-canary-e71a6393-20260702`,
  `scheduler` `0.28.0-canary-e71a6393-20260702` (existence verified with
  `npm view`; installed versions confirmed at runtime). `react` +
  `react-dom` `>=19.0.0` are peerDependencies. `host.ts` now carries a
  triple-slash reference to `scheduler.d.ts` so external programs that pull
  in the bindings without the whole `src/` tree still see the ambient
  `scheduler` declaration.
- Shared battery: its adapter shim and dep repointed at the consolidated
  package and reinstalled; `battery.spec.tsx` untouched.
- READMEs merged into one npm-standalone document (engine first, bindings
  section after). This REPORT absorbed the bindings package's REPORT with
  history intact (git mv; §§1–13 unchanged).

No behavior change expected, none observed; the gates are the evidence,
all run fresh against the npm-canary React:

```
Tests  265 passed (265)          # merged suite (224 engine + 41 react), tsc clean
Tests  3 passed (3)              # oracle default (300 seeds x 90 steps)
Tests  3 passed (3)              # oracle deep (ROYALE_FX2_SEEDS=1200)
Tests  1 failed | 24 passed (25) # shared battery — scenario 16 only (exempt)
```

LOC self-count (consolidated package, same counter and rules as §4):

```
node royale/verify-kit/count-loc.mjs --lib packages/signals-royale-fx2
→ libLoc 2362  (engine 1909 + react bindings 453)
```

## 15. Two-tier graph rebuild + DerivedState merge

The watched tier now runs the full alien-signals edge discipline; the
unwatched tier keeps stamp-pull validation. Design and as-built deltas:
`docs/two-tier-graph.md` (authoritative — mechanics, invariants, the three
deviations found while landing, and the §11 DerivedState merge). Summary:

- **Promote validates** (fixes two verified defects): the first observer's
  cascade links the dep closure depth-first and stamp-validates every edge
  (`version` match AND dep Clean post-promote); a Clean node with any invalid
  edge is seeded Check. Falsify-first: `expected 2 to be 4` (stale-value
  serve through the watched fast path), `expected 20 to be 30` (transitive),
  both captured pre-change.
- **Late-subscriber staleness delivery** (fixes a missed notify,
  `expected +0 to be 1` pre-change): `observeNode` onto a stale,
  previously-computed node applies the wave's visit rules to the new leaf —
  one wake at the subscribe-time flush, pull re-arms. Never-computed nodes
  (`version === 0`) are exempt: born Dirty, no dep edges, no missed edge.
- **Demote seeds the unwatched tier**: back-edges cascade-unlink,
  `validatedEpoch = writeEpoch` when Clean (next quiet read is O(1)) or `0`
  when stale; the old unconditional Check seeding is gone — flag distrust
  lives at the two tier crossings only.
- **Iterative propagate** in alien's stack shape (Check-only marks,
  causeEvent, once-per-wave epoch bumps, watcher scheduling preserved):
  falsify-first deep-chain test overflowed the recursive wave at depth
  150 000 pre-change (`RangeError: Maximum call stack size exceeded`),
  completes now. Pull-side recursion consciously retained (benchmark-gated).
- **trackRead case-3 dedup** kills duplicate watched edges on non-adjacent
  same-pass re-reads (`expected 2 to be 1` pre-change). Its soundness needs
  never-reused eval stamps, so new stamps come from a monotonic counter
  (`stampCounter`) behind the pass-scoped `evalStamp` — the restore
  discipline recycled values, and a recycled stamp could have made the probe
  return a dead pass's edge and truncate a genuinely-read dependency.
- **Flags**: `Watched` 0b0010_0000 (mirror of `observerCount > 0` for
  cells/deriveds, creation-to-dispose for watchers; one-bit tier test in
  trackRead/ensureFresh); `DerivedError`/`DerivedSuspended`
  0b0100_0000/0b1000_0000 form the exclusive async field (`ASYNC_MASK`).
  Link layout unchanged; `prevDep` stays omitted (all deps mutations are
  forward-only; justification in the doc §2).
- **DerivedState merge** (owner amendment): `node.asyncState` and the
  per-read Envelope allocation are gone. Nodes carry `throwable`
  (ErrorBox | Suspension | null, initialized on every node kind) and the
  async flag bits; `resolveState` returns THE NODE for canonical worlds
  (zero-alloc reads) and reshaped memo records for drafted worlds; stale is
  derived (`value !== UNINITIALIZED`). Suspension-identity, sameError box
  reuse, and settlement-as-write are preserved; React's committed snapshot
  returns the identity-stable ErrorBox instead of allocating a marker per
  `getSnapshot` call (a uSES identity hazard). `Envelope` export replaced by
  `DerivedState` + protocol exports; all importers converted, no alias.
- **Leak story**: demote removes every back-edge promote installed; the
  leak audit gained two tests (promote/demote cycling leaves zero subs
  entries + dropped chain collects; a dropped watched subscription handle
  reclaims the closure through the registry). 8/8 with `--expose-gc`.

Perf (5-run medians vs same-session stash of pre-change `src/`, coarse
floors): quiet reads parity (4.28 vs 4.18 ms/1e6), deep-chain 1k write+pull
−13% (7.44 vs 8.51 ms/200), fanout-200 writes −10% (18.66 vs 20.74 ms/2000),
promote/demote churn parity (35.7 vs 36.6 ms/2e5); react-bench in line with
§12 (transition p95 ~10.0 ms, mount-5000 57 ms vs baseline 69 ms).

Gates, all fresh in the landing session:

```
tsc --noEmit                     # clean
Tests  278 passed (278)          # 265 prior + 11 graph-tiers + 2 gc-leaks
Tests  3 passed (3)              # oracle deep (ROYALE_FX2_SEEDS=1200), canaries intact
Tests  1 failed | 24 passed (25) # battery — scenario 16 DOM-mutation only (exempt)
```

LOC self-count (same counter and rules as §4):

```
node royale/verify-kit/count-loc.mjs --lib packages/signals-royale-fx2
→ libLoc 2437  (engine 1973 + react bindings 464)
```

## 16. refresh() removed (deletion round, owner ruling)

`refresh(x)` and its machinery are gone: the export, the hidden per-computed
nonce cell (`refreshNonce` + `ensureRefreshNonce`), the recompute pre-read,
`adoptDepLink` (its only creation site for non-evaluation edges), and the
`makeCell` lazy opt-out (only the nonce passed it, as a no-op). The
userspace replacement is a version signal the computed reads — same
classification behavior, zero engine surface; the README's "Refetching"
section is the recipe. §10.2's regression test left with the API; the
settlement-in-transition and stale-serve tests were rewritten to drive their
refetches with a user nonce and pass unchanged against both the pre- and
post-deletion engine. Structural dividend: evaluation is now the only source
of dependency edges, so "a derived's deps list is exactly what its last
evaluation read, in read order" is unconditional — a dev-gated assertion
after every trim enforces it (docs/two-tier-graph.md), and the stamp-0
adopted-edge class exits the dedup probe's domain. Gates: tsc clean;
274 passed (278 − 4 refresh-only tests); oracle 3 passed at 1200 seeds;
battery 23 passed / 2 failed — scenario 16 DOM-mutation (pre-existing
exemption) plus scenario 11's refresh test (`adapter.refresh is not a
function`, the expected hole for a deleted API; battery.spec.tsx is shared
and stays untouched).

## 17. Two indirections dissolved (refactor round, owner rulings)

`reactIntegration` is gone. The ~30-member object existed as a privacy wall
between the engine and `src/react/`, but the react directory is part of the
library — there is nothing to wall off. The bindings now import what they
use directly from graph.ts, worlds.ts, tracer.ts, and index.ts, and unwrap
user handles at their own boundary: hooks call `nodeOf(x)` once and work
with `ReactiveNode` records (subscriptions are `observeNode(node, …)`, epoch
snapshots are field reads), and the ambient classifier keys Draft RECORDS
by transition object (`WeakMap<transition, Draft>`), deleting the per-
drafted-write id→record lookup the old seam paid. Two engine members the
object had privatized are exported from where they live: index.ts's
`setRenderWorldProvider` and `isPendingPassive`. One rule
survives the wall's demolition because it is a leak rule, not a privacy
rule: long-lived React state (reducer worlds, committed id sets) holds draft
IDS, never Draft records — a record captured in a committed reducer state
that never updates again would be retained forever; a stale id is inert. A
gc-leaks test pins it (retired draft's id held in a long-lived array; the
Draft record and its logged payload are WeakRef-collectible). The
lifetime-effect hook ceremony went with it: lifetime.ts folded into graph.ts
verbatim, the promote/demote sites call `noteLifetimeTransition` directly,
and `GraphHooks` shrank to `classifyWrite` + `trace` — `observation` and
`installLifetimeHook` deleted, and `afterPropagate` deleted after verifying
zero installers across all 281 revisions (the two-stage flush itself —
effects before leaf notifies — is load-bearing and stays). The oracle's
sabotage canaries, which monkey-patched object members, now inject their
sabotage through an explicit seams parameter of `runSchedule`. Gates: tsc
clean; 275 passed (274 + the new leak pin); oracle 3 passed at 1200 seeds;
gc-leaks 9; battery at the pinned 23 passed / 2 failed / 1 unhandled error
(scenario 11 `adapter.refresh`, scenario 16 `adapter.onDomMutation`, both
owner-exempt; the unhandled error is the same refresh TypeError).

## 18. Type/constant hygiene (weak brands, const enums, dead seams)

Three moves, refactor-parity, one commit. **Weak branded number types**: a
shared `Brand<T, B>` helper in graph.ts (declared-never-created unique
symbol, optional property — purely type-level) brands every named counter:
`WriteEpoch`, `NodeVersion`, `TraceEventId`, `EvalStamp` (new name for the
previously plain eval-stamp numbers: `evalStamp`, `stampCounter`,
`Link.stamp`), `ReactEpoch`/`CanonicalEpoch` (the two subscription epochs),
`Flags` (the stored word), and worlds.ts's `DraftId`, `WorldEpoch`, `OpSeq`.
Weak means creation and increment stay cast-free while cross-brand
assignments and parameter passes are type errors. The migration surfaced
ZERO cross-brand errors in the existing code; that null result was verified
positively with a temporary `@ts-expect-error` probe file exercising all ten
cross-brand flows (every suppression was required — the brands bite — then
the probe was deleted). Ripple typing fixes in the same spirit:
`WorldMemo.writeEpoch` is a `WriteEpoch` (was plain `number`), and the
draft-wake seam (`onDraftWake`, `pokeAndWakeLeafObservers`, `observeNode`'s
`draftWake`) takes `DraftId` via a type-only worlds.ts import (erased; the
graph stays runtime-dependency-free). **Const enums**: the flag bits are now
`const enum Flag` with `StaleMask = Check | Dirty` and `AsyncMask =
DerivedError | DerivedSuspended` as members (the former `STALE_MASK` /
`ASYNC_MASK` consts); `Flag` is one bit, `Flags` stays the branded stored
word (TS5 would force a cast on every `|=` if fields carried the enum type).
The flush guard ceiling (`Limit.FlushRuns` = 100 000) and the tracer's ring
constants (`Limit.MinCapacity`/`DefaultCapacity`/`MaxChainWalk`) join
per-file `Limit` enums. `NO_EVENT` and `REPAIR_WAKE` deliberately stay
branded const sentinels, not one-member enums — each is a sentinel of an
existing branded type (`TraceEventId`, `DraftId`) and reads better where it
lives. This reverses §13's erasable-syntax choice on purpose: the toolchain
compiles TS everywhere (vitest/esbuild; no `erasableSyntaxOnly`, nothing
runs Node strip-types — empirically confirmed strip-only mode rejects
enums), esbuild inlines members same-file and compiles cross-file consumers
to object lookups (same cost as the const object), and README's
type-stripping claim is updated accordingly. **Dead seams**: worlds.ts's
`getDraft` deleted (zero callers — its last ones died with
`reactIntegration`); `GraphHooks.classifyWrite` deleted (never installed,
never called; the live classifier is worlds.ts's `classifyWrite` invoked
directly from index.ts write paths, and the hook's doc comment contradicted
its own boolean type), which left `trace` as the interface's only member —
so the `GraphHooks` interface and `hooks` object are gone entirely,
replaced by a `traceHook` module binding + `setTraceHook` setter (matching
`useImpl`/`setUseImpl`), keeping the detached fast path at one null check
per emit site. Public API rename: `Flags`-the-const-object and `ASYNC_MASK`
are replaced by `Flag` (tests updated; the shared battery adapter never
touched them). Gates: tsc clean; 275 passed; oracle 3 passed at 1200 seeds;
battery at the pinned 23 passed / 2 failed / 1 unhandled error (scenario 11
`adapter.refresh`, scenario 16 `adapter.onDomMutation`, both owner-exempt;
the unhandled error is the same refresh TypeError).

## 19. Queue storage discipline (retained capacity, nulled slots)

The flush path's module-scope queues no longer clear with `.length = 0`
(V8 right-trims the backing store on a length reset, so every wave re-grew
capacity from zero — O(log n) reallocations plus copies, garbage
proportional to peak wave width) and the leaf drain no longer
splice-snapshots (one fresh array per wave). `watcherQueue` clears by
logical length (`watcherCount`), keeping the `queueHead` cursor and the
`w.disposed` drain-time tombstone (append-then-fully-drain queue, no
mid-queue removal, so no compaction machinery — deliberately); the catch
path gets the same discipline (unconsumed `[queueHead, count)` slots
nulled, cursors reset, scheduled/staleness cleared exactly as before).
`markedLeaves` is double-buffered with logical lengths: delivery iterates
the wave's buffer while `onNotify` re-marks land in the spare, preserving
the snapshot rule exactly — a wave's iteration never sees entries added
during delivery; a doubly-nested delivery (onNotify inside onNotify) finds
the spare checked out and takes a fresh array, paying the old per-wave
allocation for that rare frame rather than clobbering a live iteration.
The correctness price of retained capacity is total slot hygiene: every
consumed slot is nulled at drain (drain loop, catch path, leaf finally —
also on a throwing notify), because a soft-cleared slot must not pin a
disposed watcher. Two-stage flush ordering (effects settle before any leaf
notify) is untouched. `host.ts`'s `handle.errors.length = 0` in
`resetReactSignalsForTest` stays, per audit exemption (test seam, cold).
Tests: three `[guard]` gc-leaks tests (disposed effect / disposed leaf /
catch-path-preempted effect all collect despite retained capacity;
WeakRef-asserted) and two delivery re-entrancy tests (Q1: a leaf marked
during delivery rides the nested wave, not the current iteration; Q2:
doubly-nested delivery keeps undelivered snapshot entries intact). All five
pass pre- AND post-change (the splice semantics already matched — verified
by running them against the pre-change engine, so guard-labeled, not
falsify-first), and each was proven to bite: skipping the slot nulling
fails all three gc guards; a strict-swap sabotage that reuses a checked-out
buffer fails Q2 with the exact clobbering failure mode. Memory evidence
(bench/queue-probe.mts, --expose-gc, per-wave heapUsed delta after forced
GC, 2000 subscribers x 50 waves, seconds of runtime): leaf-notify burst
244,280 -> 256 B/wave median (mean 209,668 -> 857); effect burst 68,056 ->
256 B/wave median (mean 68,236 -> 524); baseline reproduced on a second
pre-change run. Gates: tsc clean; 280 passed (275 + the 5 new); oracle 3
passed at ROYALE_FX2_SEEDS=1200 (title-verified 1200 seeds x 90 steps);
battery at the pinned 23 passed / 2 failed / 1 unhandled error (scenario 11
`adapter.refresh`, scenario 16 `adapter.onDomMutation`, both owner-exempt;
the unhandled error is the same refresh TypeError).

## 20. Walk modernization (mandatory SignalsFrameworkProvider, unified poke walk, flag table)

Owner-specified in full; two commits (the WaveFrame amortization is the
second, separately revertable).

- **Mandatory SignalsFrameworkProvider.** The unscoped hook mode is deleted: every
  scope-consuming hook (`useValue`, `useComputed`, `useIsPending`,
  `useCommitted`) throws without a scope, naming `wrapCreateRoot` and
  `<SignalsFrameworkProvider>` as the fixes (falsify-first: the throw test rendered fine
  pre-change). `canonicalEpoch` is deleted entirely; `reactEpoch` is renamed
  `storeEpoch` — THE useSyncExternalStore snapshot; bump = subscribers
  re-render. Fold loudness is unchanged: loud folds bump it, silent folds
  suppress it, and the audience decision stays in `confirmRootCommit`. The
  unscoped-convergence tests died with the contract they tested.
- **Oracle model swap + coverage delta.** The scope-less subscriber model
  class and its canary modeled the deleted contract and are gone. Replacing
  them, every fuzz schedule now runs SCOPED subscribers over cell 0 and
  comp 0: both channels of `useValue` (storeEpoch snapshot with bail, plus a
  draft-lane world fed by `onDraftWake` wakes and `draftsAffecting`
  attach-time joins), pruned like the reducer, resolved through
  `resolveState`. The cell subscriber is strong — the model keeps its own
  wake bookkeeping, so a dropped wake or missed silent fold fails after any
  step; the computed subscriber asserts rerender-time agreement only (its
  watched dep set is the last canonical evaluation's reads, so a draft write
  to a world-only branch legitimately never wakes it). Lost coverage: none
  that the surviving engine has (canonicalEpoch had no remaining consumer).
  Gained: the draft-lane wake channel and attach-time repair are fuzzed for
  the first time. Bonus catch (seed 5, pinned falsify-first in worlds.spec):
  an urgent equality-cutoff write on a drafted cell appended its intent but
  poked and woke nobody — every pending world's replay changed with no
  notification, so a held transition would commit the pre-rebase value.
  Fixed engine-side: `pokeRebasedCell` pokes-and-wakes each live draft's
  audience exactly on the cutoff path (the changed path needs nothing:
  the wave re-renders urgently and React restarts in-progress transition
  work after an interleaved urgent commit).
- **Unified iterative poke walk.** `pokeLeafObservers` +
  `pokeAndWakeLeafObservers` are ONE `pokeDraftWatchers(node, cause, wake?)`
  sharing the wave's cursor + frame-stack skeleton; dedup is a per-node poke
  stamp against a monotonic per-walk serial (zero allocation, no clearing —
  the EvalStamp discipline). Falsify-first: the drafted twin of T11 (150k
  watched chain) blew the JS stack (`RangeError: Maximum call stack size
  exceeded` in the recursive walk). The dead marking split is gone: pokes
  now mark `StaleCheck` like the wave — the choice is arbitrary and
  documented (render-notify watchers are never validated; flush clears
  staleness unconditionally pre-delivery). `causeEvent` threads through the
  poke like the wave.
- **Flag reorganization.** Kinds (`KindCell`, `KindDerived`, `Watching`),
  creation-fixed capabilities (`WatchRender`, `WatchRunEffect`,
  `WatchDraft`), staleness (`StaleCheck`, `StaleDirty`), async (`AsyncError`,
  `AsyncSuspended`), state (`Watched`, `Scheduled`, `Computing`). Dispatch
  routes on capability bits, never callback presence. The
  `scheduled`/`computing` bools became bits (render-notify drain and the
  catch path fold Scheduled+StaleMask into one masked store; the effect
  drain clears Scheduled alone because validation still reads StaleCheck);
  `disposed` is deleted — disposal = Watching set, Watched clear (the
  Watched double role is documented in the layout comment). Dead
  `CellNode.lifetimePending` deleted.
- **Walk colocation + smalls.** The four walk entry points sit in one
  graph.ts section under a contract-matrix comment. Settlement and discard
  bump epochs through one helper (`bumpStoreEpochLoud`) whose comment states
  why they bypass suppression. The write-only intent `seq` field, `nextSeq`
  and `OpSeq` are deleted; both push sites carry the invariant: array order
  is dispatch order; retirement flips visibility, never position.

## 21. The final unit: reducer-only notifications + watermark validation

Built as one unit per the owner's order, implemented directly by the
orchestrator after repeated workflow-agent infrastructure stalls. Change A:
`useSyncExternalStore` deleted; every wake is a reducer dispatch, so
re-renders get exactly `useState`'s lanes (owner ruling), with
`useIsPending`'s flip dispatched outside ambient transitions (the
`useTransition` precedent) and the notify predicate targeting the COMMITTED
tree (fold silence is per-subscriber comparison now — the suppression flag,
`retireDraft({silent})`, and `confirmRootCommit`'s loudness decision are all
deleted). Change B: `NodeVersion`/`link.version` deleted; validation is
`dep.changedAtGraphChange > sub.validAtGraphChange` under three named
ordering invariants (tick-then-stamp, real-changes-only + net-revert
restore, freshen-then-stamp); links carry no validation state; promote
skips history validation on `Computing` nodes (the one job edge stamps did
that watermarks cannot — caught by T12). Falsified pre-change: the lane
discriminator (timeout-origin write rendered in the microtask window under
uSES: "expected '1' to be '0'"). Guards: mixed signal+setState atomicity
(one render), burst = one render, render→attach layout-write repair,
lazy-chain/cutoff/net-revert watermark pins. The net-revert restoration was
later removed after a mid-batch read proved that moving an atom's reading
backward could preserve an intermediate computed cache. Full design argument in
docs/final-unit.md. Gates: tsc clean; 290 tests; 1200-seed oracle twice
(deterministic-green, subscriber model mirrors the notify predicate);
battery at the pinned 23/2/1.
