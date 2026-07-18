# Fork S3 report — pass lifecycle: yield/resume, end disposition, discardAllWip (2026-07-05)

Branch `cosignal-fork` tip: `b6da053b10fcf4fda26c6ae961ae14c394b19d6d`.

## What S3 shipped

**1. Yield/resume edges (spec fact 2, tests 7–8).**
`onRenderPassYield(container)` fires where either render loop exits with
the tree unfinished (time-slicing or awaited suspension);
`onRenderPassResume(container)` fires on the same-root-same-lanes
continuation entry of both loops. Strictly alternating, at most one yield
per gap; double-fire is structurally unemittable (WeakSet membership
guards; a stack the caller just prepared takes the continuation path but
never yielded, so pairing stays exact).

**2. End disposition — the frame-semantics change (tests 21, 22, 24, 28).**
The pass frame no longer closes at render completion. It closes exactly
once, at `onRenderPassEnd(container, committed)`: `committed=true` inside
`commitRoot` after `markRootFinished` and **before** that commit's
`onRootCommitted` (no committed-view advance is observable while a
same-root frame is open — now by construction); `committed=false` at
discard (a restart's implicit end, a NoLanes reset of an interrupted
suspended render, a canceled pending commit, discardAllWip). Per-container
event grammar pinned by a state-machine invariant checker run over every
scenario's full log: `start (yield resume)* end`, with each
`rootCommitted` consuming the `end(commit)` that closed its frame.
Per-callstack truth pinned: a yield-gap handler sees
`getRenderContext() === null` and its writes join the ambient batch
(tests 9/10; test 10 also pinned that default priority does not preempt a
yielded transition — the open pass commits its write set unpolluted, the
gap batch commits separately after).

**3. `discardAllWip` (test 27).**
`React.unstable_discardAllWip()` synchronously abandons every WIP pass on
every root — including completed-but-uncommitted trees with
suspended/throttled commits. Every open frame emits `end(discard)` before
it returns; nothing new starts; batches stay live; React re-schedules and
each retry is a fresh pass over the same tokens. Mechanism per root:
`prepareFreshStack(root, NoLanes)` (fatal-error reset idiom) +
`markRootPinged(root, suspendedLanes)` (wakes lanes a canceled commit
would strand) + `ensureRootIsScheduled`. Throws error **604** if called
during render/commit. Answers PLAN Q3: no schedule-microtask flush needed
— the synchronous unwind releases render-minted hook state.

**Capability bits claimed: `1<<4`** (yield/resume + end disposition) and
**`1<<8`** (discardAllWip), in both baked-in copies. Bits 5/6/7 remain
reserved and unset. Constant renamed `IMPLEMENTED_CAPABILITIES`
(grow-only rule documented).

## www-channel resolution + the seam bug it exposed

Added the five S1 exports (and `unstable_discardAllWip`) to
`packages/react/index.fb.js` — the mechanical fix. Posture: **all four
channels (default/experimental, www-modern, www-classic, stable) are now
suite gates.**

**Real seam bug found and fixed:** www test runs have
`enableParallelTransitions === true`, so sibling transitions render on
single lanes and reach the tree via _entanglement_ — and the S1 registry
under-reported: included-batches missed the entangled batch, and the
finish edge retired it `committed=false` while its write was visibly
committed. Fixed by mirroring React's own bookkeeping:
`batchTokensForRender` and `commitRoot`'s finish edge expand with
`getEntangledLanes` (captured before `markRootFinished` clears
entanglements; lanes whose updates stayed pending self-filter via
`remainingLanes`). The same shape is reachable on OSS channels via a
suspended sibling transition — the new Commit-test pins it on every
channel and fails on www without the fix.

## S2 tests deliberately updated (all pre-marked in S2)

- **Pass test 24**: the pre-marked assertion flipped — no `passEnd`
  during the suspended-commit window (frame stays open); added the
  discard-disposition close at insertion and the commit-disposition close
  at resolution time.
- **Pass test 22**: added disposition asserts and the exact tail
  `yield → end(discard) → start → end(commit) → rootCommitted`.
- **Pass test 28**: behavior unchanged; header comment updated (invariant
  now holds by construction).
- **Pass file header**: rewritten for the new frame semantics.
- **BatchRegistry handshake test**: capabilities constant grown.

## Gate table

| Gate                                                                                                                                               | Result                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Fork suite default (experimental)                                                                                                                  | **23/23** (10 BatchRegistry + 5 Commit + 8 Pass), stable ×3 runs; re-verified by supervisor |
| Fork suite www-modern / www-classic / stable                                                                                                       | **23/23 each**                                                                              |
| Upstream suites (S2's set + FlushSyncNoAggregateError, IncrementalUpdatesMinimalism, TransitionTracing, SuspenseyCommitPhase, SiblingPrerendering) | **15 suites, 145 passed, 1 pre-existing skip**                                              |
| `yarn linc` / `yarn flow dom-node` / `yarn prettier-check`                                                                                         | pass                                                                                        |
| `yarn extract-errors`                                                                                                                              | code **604** assigned                                                                       |
| `fork/build-react.sh`                                                                                                                              | builds ~13s — `Built: 19.3.0 (b6da053b10)`                                                  |

## Commits (65a8d89a97 → b6da053b10)

1. `d7b95440ec` www entry: export the external-runtime surface from index.fb.js
2. `754de13e02` Batch reporting is entanglement-aware: report the write set the pass consumed
3. `0d6423b4a3` Pass frames: yield/resume edges, close at commit/discard with disposition
4. `b6da053b10` discardAllWip: synchronously abandon every WIP pass on every root

## Handoff notes for S4+

1. **www flag reality**: default www test runs have
   `enableParallelTransitions=true` — transitions don't group;
   entanglement carries sibling batches. S4's `runInBatch` should
   schedule on the token's own lane and let entanglement do the rest; the
   registry's entangled expansion now reports it correctly either way.
2. **Default doesn't preempt transitions** (`getNextLanes` keeps the WIP
   when next=DefaultLane and wip is a transition) — pinned by test 10;
   use flushSync/discrete when a test needs a genuine same-root
   interrupt (as tests 22/28 do).
3. **discardAllWip throws during render/commit** (error 604). If the
   engine's §5.12 renumber protocol ever needs effect-phase calls,
   revisit (auto-defer is the alternative); bindings should defer to a
   microtask.
4. The frame registry is now a **strong Set** (enumeration for
   discardAllWip) — leak reasoning documented in
   `ReactFiberExternalRuntime.js`; membership ends at every
   commit/discard.
5. `notifyRenderPassCommitted` is membership-guarded: exotic commit paths
   without an open frame degrade gracefully; the Pass-file invariant
   checker (`checkFrameInvariants`) flags a `rootCommitted` without a
   preceding `end(commit)` — reuse it in S4+ tests; it's the cheapest
   double-fire/ordering net.
6. **act()/waitFor mechanics**: each `waitFor` boundary produces exactly
   one yield edge; plain act flushes produced no spurious yield/resume
   pairs in any scenario here — but prefer the invariant checker over
   exact sequences where scheduler cadence could vary.
7. A `prepareFreshStack(root, NoLanes)` reset occurs naturally in the
   suspensey-commit flow (observed on both channels) — it is a discard
   edge when a frame is open; that's the "interrupted suspended render"
   discard cause, already covered.
8. Key files: `packages/react/src/ReactExternalRuntime.js` (protocol +
   bit table), `packages/react-reconciler/src/ReactFiberExternalRuntime.js`
   (frame state machine), `ReactFiberWorkLoop.js` (edges at
   renderRootSync/renderRootConcurrent entry+exit, commitRoot,
   `discardAllWorkInProgress`), `ReactFiberBatchRegistry.js` (entangled
   expansion), tests in `__tests__/ReactFiberExternalRuntime{Pass,Commit}-test.js`
   and `ReactFiberBatchRegistry-test.js`.
