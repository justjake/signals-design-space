# signals-royale-fh1 — entry report

## 1. Design summary

Every write is a version-stamped record and every reader is a visibility
predicate evaluated over small per-signal write histories. An atom keeps one
canonical value plus, only while a concurrent episode is in flight, an
interleaved log of updaters (batch, seq, fn); a "world" is nothing but a
predicate — a cutoff sequence plus a list of deferred batches — folded over
that log on demand, so there are no world tables and no overlay stores.
Retirement refolds the whole log in sequence order (React updater-queue
replay: a transition `+2` under a later urgent `*2` lands as `(base+2)*2`),
and per-root committed views are just cutoffs latched at each root's commits.
The React fork shrinks to a 167-line "signal seam": raw lane facts (pass
start, root updated, commit, a DOM-mutation bracket), two queries (current
write lane, current render container), and one control (a pinned transition
lane for corrective updates that must commit inside a pending batch) — every
batch/world/store concept lives in the library. At quiescence every history,
log, world cache, and draft edge is reclaimed; the steady state holds
nothing.

## 2. Gates

| Gate | Command | Result |
|---|---|---|
| Typecheck (engine) | `pnpm typecheck` in packages/signals-royale-fh1 | PASS (clean) |
| Typecheck (react) | `pnpm typecheck` in packages/react-signals-royale-fh1 | PASS (clean) |
| Conformance | `npx vitest run tests/conformance.spec.ts` | PASS — **179/179** |
| Oracle fuzz (default) | `npx vitest run tests/oracle.spec.ts` | PASS — 300 seeds x 90 steps |
| Oracle fuzz (deep) | `ROYALE_FUZZ_SEEDS=1200 npx vitest run tests/oracle.spec.ts` | PASS — 1200 seeds |
| Engine suites (all) | `pnpm test` in signals-royale-fh1 | PASS — 206 tests (conformance + concurrent + fuzz + pins + gc) |
| Leak audit | `npx vitest run tests/gc-leaks.spec.ts` (forks pool, --expose-gc) | PASS — 7 tests |
| Real-React gate | `pnpm test` in react-signals-royale-fh1 | PASS — 19 tests over the 18 scenarios |
| Fork protocol suites | `yarn test --no-watchman ReactFiberSignalSeam ReactDOMSignalSeamMutation` | PASS — 2 suites, 9 tests |
| Upstream adjacent | `yarn test --no-watchman ReactAsyncActions ReactBatching ReactFlushSync ReactIncrementalScheduling ReactIncrementalUpdates ReactInterleavedUpdates ReactSchedulerIntegration ReactTransition ReactUpdatePriority ReactDefaultTransitionIndicator` | PASS — 13 suites, 121 passed, 1 skipped (pre-existing gate skip) |
| Flow | `yarn flow dom-node` | PASS ("Flow passed for the dom-node renderer") |
| Shared battery | `pnpm test` in royale/verify-kit/battery (ADAPTER -> this entry) | PASS — **25/25** |

Output snippets (verbatim):

```
 Tests  179 passed (179)                              # conformance
 ✓ oracle fuzz (1200 seeds x 90 steps) > engine matches the naive fold model 131ms
 Tests  206 passed (206)                              # engine package full run
 Tests  19 passed (19)                                # real-React gate
Test Suites: 2 passed, 2 total / Tests: 9 passed      # fork protocol suites
Test Suites: 13 passed / Tests: 1 skipped, 121 passed # upstream adjacent
 Tests  25 passed (25)                                # shared battery
```

The fuzz oracle found one real engine bug during bring-up (a discarded batch
left world caches validated against a stale fold); it is pinned as
"seed 207: discarding a batch invalidates world caches that listed it" in
tests/concurrent.spec.ts.

## 3. LOC self-count

`node royale/verify-kit/count-loc.mjs --fork vendor/react --base
e71a6393e66b0d2add46ba2b2c5db563a0563828 --head royale/fh1-react --lib
packages/signals-royale-fh1 --lib packages/react-signals-royale-fh1`:

```
forkLoc: 167     (incumbent: 1510 — 9.0x smaller)
libLoc:  1957    (alt-a 4689, alt-b 4909 — 2.4x smaller)
  engine.ts 1324, tracer.ts 110, index.ts 70
  hooks.ts 169, seam.ts 263, index.ts 21
```

(Re-measured after the judgement fixes. Earlier revisions of this report said
1876 — a stale number: the Round-2 perf commit added 65 counted lines and the
report was not re-counted. The judgement-round latest() fix adds 16 more.)

Fork metric cross-check: `git -C vendor/react diff --numstat e71a6393e6..HEAD
-- packages/ ':!packages/*/src/__tests__*' | awk '{a+=$1+$2} END {print a}'`
= 167 (ReactFiberSignalSeam.js 107, ReactFiberWorkLoop.js 53,
ReactFiberRootScheduler.js 7).

## 4. Benchmarks

### milomg js-reactivity-benchmark (isolated runner)

`node dist/isolated.js --rounds 3 "Royale FH1" "Alien Signals"` — ratios
Royale/Alien (lower is better; no leaks — graphs built in an effectScope and
disposed in `cleanup()`):

```
createSignals 2.94x   createComputations 3.25x  updateSignals 2.15x
avoidableProp 1.79x   broadProp 2.48x           deepProp 2.51x
diamond 1.72x         mux 1.88x                 repeatedObservers 1.25x
triangle 1.88x        unstable 4.21x            molBench 0.95x
cellx1000 3.47x       cellx2500 4.06x           kairo lazy80% 1.98x
kairo 10x10dyn 1.40x  kairo 1000x12dyn 1.19x    kairo 25-1000x5 0.88x
kairo 3-5x500 1.76x   kairo 100x15dyn 1.25x
geometric mean: 1.95x alien-signals
```

Pull counts verified (`testPullCounts: true`, adapter sanity 4/4 green; the
one red test in that runner is the pre-existing upstream `x-reactivity`
adapter, untouched by this entry).

### React seam benchmark (`node bench/react-bench.mjs`)

jsdom, real timers, real createRoot from this fork build, one child process
per scenario; baseline is a ~35-line plain-store useSyncExternalStore
adapter with identical component shapes. Urgent updates are issued at
discrete-input priority (flushSync), because React deliberately parks
DefaultLane timer updates behind transition renders for both contenders.

```
scenario,contender,stat,ms
fanout,royale-fh1,median-write-to-commit,1.655
fanout,baseline-uses,median-write-to-commit,1.783
transition,royale-fh1,p95-urgent-during-transition,5.808
transition,baseline-uses,p95-urgent-during-transition,403.267
mount,royale-fh1,median-mount,46.383
mount,baseline-uses,median-mount,42.929
```

The transition row is the reason the fork exists: 70x lower p95 urgent
latency while a 2000-cell transition renders, with the transition still
completing. Fanout beats the baseline; mount pays ~8% over stock.

## 5. Feature coverage

- Writable signals, custom equality, labels — done.
- Lazy initializers (first-touch, set-before-read, install-not-write) — done.
- Functional updates that replay (updater-queue arithmetic) — done.
- Computeds: lazy, cached, equality cutoff, dynamic deps with trimming,
  exact pull counts — done (conformance 179/179).
- Effects/effect scopes with cleanup; canonical-only observation — done.
- batch/startBatch/endBatch, untracked — done.
- Lifetime effects (union of kinds, microtask coalescing, StrictMode nets
  one) — done.
- Write classification urgent vs transition; drafts invisible until
  commit — done.
- Render-pass consistency (worlds; sibling tear checks) — done.
- Urgent-during-transition with rebased retirement — done.
- Per-root committed views — done (cutoff predicates).
- flushSync excludes deferred work — done.
- Quiescence reclamation — done (leak audit asserts it).
- Read family: read/committed/isPending/refresh — done. latest() was
  misreported as done here in earlier revisions: it violated the context
  rule in canonical computed evaluations and in render bodies (fixed in the
  judgement round — see "Judgement fixes" for what was wrong and what
  changed).
- Async: pending as graph state, stable thenable identity, stable error
  boxes, parallel fetches via caller-created thenables, keyed
  `use(key, factory)` for refreshable fetches — done.
- Two-level suspend-vs-stale at React boundaries — done.
- Settlement as a write, committing with its owning world — done.
- React hooks: useValue, useComputed, useSignalEffect, useCommitted,
  useIsPending, useAtom, useTransitionWrite/startTransitionWrite — done.
- Loud registration failure on stock React; multiple roots;
  write-during-render throws; unmounted subscribers silent — done.
- SSR serialize/initialize/installState — done.
- Causality debug log (attach/detach, causal parents, ring mode with
  overflow counting, whyLastDelivery formatting) — done.
- DOM mutation window (exact bracket; MutationObserver scenario) — done.

## 6. Known gaps and honest risks

- **Rollback re-notify is React-converged, not poke-driven**: the binding
  ignores retirement/discard pokes for `useValue` (React's own retry of the
  batch's lane converges those roots); pure-engine hosts still receive the
  pokes. If a root somehow held a committed draft without a pending lane,
  it would not be nudged — no such path exists through these bindings.
- **Same-lane merging**: two React transitions assigned the same lane (same
  event, or lane-pool reuse under >15 concurrent transitions) map to one
  engine batch. React itself commits them together, so the observable
  behavior matches, but the causality log then names one batch for both.
- **Repended lanes**: drafts written into a batch after its pass completed
  but before its commit retire with that commit (React would render them in
  a follow-up pass; values agree because retirement refolds the full log).
- **Resumed-pass staleness**: a yielded transition pass that resumes after
  an urgent write to an atom with NO subscribers could read pre-write values
  for the unsubscribed atom (its cutoff protects consistency; React restarts
  the pass whenever any subscriber was poked).
- **Engine perf is ~2x alien-signals geomean** (0.88x–4.2x per suite), not
  parity; worst suites are creation-heavy (constructor width) and cellx.
- The react-bench transition scenario measures discrete-priority urgent
  input; DefaultLane timer updates intentionally wait behind transitions in
  stock React semantics (both contenders measured identically).
- `handle.errors` collects nothing today (no internal error channel routes
  into it); the battery's afterEach only asserts it stays empty.

## 7. With another day

- Close the perf gap: slim the Computed constructor (lazy side-table for
  async/world fields), fuse the sourcesChanged/recompute walk, and add a
  dirty-bit fast path for single-observer chains (cellx, unstable).
- Fuzz the React seam itself: a jsdom scheduler-fuzz driving random
  transitions/urgent writes/mounts against a DOM-consistency oracle.
- A `wide` react-bench scenario sweeping subscriber counts, and a
  leak-vs-no-leak flagged comparison of long-running transition churn.
- Trace polish: per-component labels on delivery events and a
  `whyCommitted(container)` query.

## Round 2 (verification pass)

All gates re-run fresh after the perf work, in order:

1. `pnpm typecheck` both packages — clean.
2. Conformance — 179/179.
3. Oracle default — 300 seeds green; deep sweep `ROYALE_FUZZ_SEEDS=1200` —
   green (verbose line above).
4. Leak audit — 7/7.
5. Fork suites — 9/9; upstream adjacent 121 passed, 1 skipped; flow green.
6. Real-React gate — 19/19.
7. Shared battery (verify-kit) — 25/25.
8. milomg registered (`packages/core/src/frameworks/royale-fh1.ts`,
   frameworksList entry, file: dependency), adapter sanity green with pull
   counts, isolated runner table above (geomean 1.95x alien).
9. react-bench table above.

Round 2 changes: engine perf work only (poke fast-path gate on subscription
count, positional in-place dependency retracking with deferred deactivation,
cached `use` closure) — semantics-neutral, every suite re-run green;
14x on deep-chain shapes, 90x-outlier kairo suites brought to ~1.2x.

Nothing disputed; no battery test coded around.

## Judgement fixes

The judge confirmed one required-feature defect misreported as done, plus a
stale LOC self-count. Both fixed on this branch; the fork is untouched.

### The latest() context-rule violation (was: claimed done in §5)

**What was wrong.** RULES: `latest()` inside a computed evaluation or render
pass resolves THAT context's own world, and tracked callers still subscribe.
The implementation only honored this when `activeWorld` was set (world-scoped
computed evaluations, `inWorld` scopes, hook-mediated reads). Two contexts
fell through to the free-context path ("fold ALL live draft batches,
untracked"):

- **Canonical computed evaluations** — a computed first-evaluated while a
  transition draft was live cached a draft-derived value that canonical
  readers then saw (probe: `read(c)` = 20 while `read(a)` = 1 with a draft
  `a = 2` live). And because the read was untracked, the computed never
  subscribed: after urgent writes and full quiescence it still served its
  original value and watching effects never re-fired (permanent staleness).
- **Render bodies** — a direct `latest()` call in a component body during an
  urgent re-render returned the live draft (2) while `useValue` beside it
  showed 1: a tear inside one pass.

**What changed** (engine `latestImpl`, +16 counted lines):

- A canonical evaluation (`activeSub` set, no active world) now resolves
  `latest()` as a tracked canonical read — the context's world IS canon —
  with the never-suspend fallback (a pending computed serves its last settled
  value). The dependency registers like any other read, so urgent writes
  invalidate the caller and effects re-fire.
- A new host provider (`setRenderWorldProvider`, installed by the seam as
  `currentRenderWorld`) lets a direct `latest()` call in a render body
  resolve the executing pass's own world — the same world `useValue` reads
  through, so the two can never disagree within a pass.
- Free-context calls (event handlers, plain scripts) keep the documented
  "newest intent: every live draft folded in" semantics.

**Regression tests** — all three probe shapes, each verified to FAIL against
the pre-fix engine before landing the fix:

- engine `tests/concurrent.spec.ts` "latest() context rule": canonical
  computed first-evaluated under a live draft caches 10, not 20; urgent
  write after quiescence re-fires a watching effect (tracked); world-scoped
  evaluation still resolves its listed batch.
- react `tests/react-gate.spec.tsx` "2b": urgent re-render beside a held
  transition — every render pass's body `latest(a)` must equal its
  `useValue(a)`; failed pre-fix with latest = 2 against v:1.

**Oracle taught the class**: generated computeds now read one operand via
`latest()` (p = 0.35). Inside an evaluation latest must equal the context's
own fold, so the memo-free model needs no new branch — the existing canonical
and draft-live-world checks cover it. Against the pre-fix engine the taught
oracle fails at seed 1 (`computed5: got 38 want 54`); with the fix, 1200
seeds green.

### Fresh gate outputs (after the fix)

```
pnpm typecheck (signals-royale-fh1)        clean
pnpm typecheck (react-signals-royale-fh1)  clean
 Tests  209 passed (209)                   # engine suite (was 206; +3 regressions)
 ✓ oracle fuzz (1200 seeds x 90 steps) > engine matches the naive fold model 129ms
 Tests  20 passed (20)                     # real-React gate (was 19; +1 regression)
 Tests  25 passed (25)                     # shared battery (royale/verify-kit/battery)
```

### Corrected LOC self-count

`count-loc.mjs` at this commit: **forkLoc 167** (unchanged — no fork edits),
**libLoc 1957** (engine.ts 1324, tracer.ts 110, index.ts 70, hooks.ts 169,
seam.ts 263, index.ts 21). The previous claim of 1876 was stale: the Round-2
perf commit (+65 counted lines) landed before the report commit without a
re-count (HEAD measured 1941 pre-fix); the latest() fix adds 16 more. Every
LOC mention in this report now says 1957.
