# React fork bring-up plan (cosignal v1)

Assessment date: 2026-07-05. Spec: `spec/cosignal-v1.md` §4 (fork protocol),
§4.4 (28-test list), §8 (fork tests before bindings), §9 (build order step 2),
Appendix B flag 3. Charter: `design-loop/SEEDS/fork-charter.md` (the
"minimal patch" constraint is lifted; scored on size, maintainability, seam
stability — not shallowness).

Strategy in one line: **port the react-signals-fable fork forward, then build
the five missing capabilities on top of it** — the prior fork already
implements ~3.5 of the seven facts as a clean, additive, edge-triggered,
tested patch, and its base is 2 commits behind upstream HEAD with zero drift
in any touched file.

---

## 1. What exists (prior-generation inventory)

### 1.1 The fork itself — `~/src/react-signals-fable/vendor/react`, branch `react-signals-patch`

(My memory called this repo `react-signals-fable-v2`; on disk it is
`react-signals-fable`. Read-only — do not modify it.)

- Base: upstream `facebook/react` main `7ce677d40659` (2026-07-02, version
  19.3.0 canary line).
- Patch: 9 commits, **+1043 lines, 0 deletions**, 14 files:

| file | Δ | role |
|---|---|---|
| `packages/react-reconciler/src/ReactFiberBatchRegistry.js` | 296 (new) | token slots (31, one per lane), mint/pending/backfill/finish/close/park/retire edges, per-root `committedRoots` lock-in, `batchTokensForRender` |
| `packages/react-reconciler/src/ReactFiberExternalRuntime.js` | 116 (new) | reconciler side of the channel; pass start/end pairing (WeakSet, implicit end on restart), mutation-window emits |
| `packages/react-reconciler/src/ReactFiberWorkLoop.js` | +106 | provider (`getRenderContext` / `isCurrentWriteDeferred` / `getCurrentWriteBatch`, lines 878–931); pending edge in `markRootUpdated` (1836); passStart in `prepareFreshStack` (2356); passEnd in `renderRootSync` (2839) + `renderRootConcurrent` (3126); finish edge in `commitRoot` (3849); mutation window in `flushMutationEffects` (4117/4131) |
| `packages/react-reconciler/src/ReactFiberRootScheduler.js` | +12 | backfill per scheduled root + close edge at end of scheduling microtask |
| `packages/react/src/ReactExternalRuntime.js` | 174 (new) | isomorphic listener registry on `ReactSharedInternals.E` (the `S`/`onStartTransitionFinish` pattern); listener errors → `reportGlobalError`; inert until first subscriber (`hasListeners`) |
| `packages/react/src/ReactClient.js` +11, `ReactSharedInternalsClient.js` +5, 6× `packages/react/index*.js` +4 | 40 | `unstable_subscribeToExternalRuntime`, `unstable_getCurrentWriteBatch`, `unstable_isCurrentWriteDeferred`, `unstable_getRenderContext` |
| `packages/react-reconciler/src/__tests__/ReactFiberBatchRegistry-test.js` | 299 (new) | 7 reconciler-level tests, noop renderer + `internal-test-utils` |

The 9 commits (`git log 7ce677d406..react-signals-patch` in the sibling):
`cffc6eabe4` channel → `b982edd03a` batch-token registry → `97369f100a`
isCurrentWriteDeferred → `53daea89a7`+`87653c5b79` surface trims (**dropped
`onCommit` and `renderLanes`** — fact 3's per-root reporting must come back) →
`9ad3111a53` async parking + per-root lock-in → `5166228d71` test suite →
`3e699f794f` committed-vs-pruned roots → `e5e2e13e93` backfill repair.

### 1.2 The consumer side (for reference; stays in the sibling)

- `packages/cosignal/src/react/instrumentedReact.ts` (68 lines) — presence
  feature-detection, throws on stock React (no version number — see fact 7).
- `packages/cosignal/src/react/runtime.ts` (139 lines) — worlds-by-container,
  observability gate before minting, retire-on-`onBatchRetired`.
- `packages/cosignal/test/patch-contract.test.tsx` (12 tests) +
  `mutation-observer.test.tsx` — consumer-side contract; the recipe to copy
  when this repo's bindings land.
- `DESIGN.md` §6 — the prior fork's protocol doc (hook-site invariants,
  mutation-window scope exceptions: layout-phase `<img src>`, suspensey-CSS
  `<link>`, Float preload/preinit, VT name attributes, user effects).

### 1.3 Older generations (context only)

- `~/src/react-signals` (gen 1): different approach — versioned
  `unstable_reconcilerRuntime` off the reconciler factory (`version === 1`
  handshake precedent), 177 insertions across 9 files incl. CommitWork/
  Hooks/Throw. Superseded, but its **explicit version field** is the
  handshake precedent fact 7 wants.
- `~/src/react-signals-2`, `~/src/react-signals-fable-dead-end-second-attempt`:
  historical; nothing to port.

---

## 2. Target React version

- Upstream HEAD today: `e71a6393e66b` = npm `19.3.0-canary-e71a6393-20260702`
  = `0.0.0-experimental-e71a6393-20260702`. Latest stable: `react@19.2.7`.
- Prior fork base `7ce677d40659` is **2 commits behind** `e71a6393e66b`;
  the gap touches only `ReactPerformanceTrack-test.js` and devtools — **zero
  drift in fork-touched files** (verified via GitHub compare API).
- **Target: `e71a6393e66b`** — it is HEAD *and* has published canary +
  experimental npm builds, so the handshake version string can name an
  auditable upstream artifact. Track main on future rebases; the fork test
  suite is the rebase gate (§4.3 drill).

## 3. Rebase risk

Near zero today; structural risk is concentrated in one file. The 9 commits
are pure additions; 10 of 14 files are new files or export lists that
auto-merge. The only real churn surface is `ReactFiberWorkLoop.js` (~4900
lines, the reconciler's highest-velocity file — View Transitions and Suspense
work land there continuously), where the fork occupies 8 small, well-anchored
sites; all are edge-triggered from bookkeeping mutations that have been stable
anchors for years (`prepareFreshStack`, `markRootUpdated`, `commitRoot` after
`markRootFinished`, `flushMutationEffects`, `processRootScheduleInMicrotask`).
The new work in this plan adds sites in the same file (yield/resume,
`discardAllWip`, lineage) plus `ReactFiberLane.js` adjacency for `runInBatch`,
which roughly doubles the WorkLoop-site count — that is the ongoing rebase
tax, and the reconciler test suite re-run per rebase is the mitigation the
spec already mandates.

---

## 4. The seven facts: exists / partial / new

| # | fact (spec §4.1) | status | prior-fork evidence | gap → new work |
|---|---|---|---|---|
| 1 | write classification: `currentBatchToken(): int`, deferred bit, 0=none | **EXISTS** (shape delta) | `getCurrentWriteBatch()` provider (WorkLoop 878–931) → `getOrMintBatchToken` (BatchRegistry); `isCurrentWriteDeferred()` mint-free; lazy per-batch minting; ≤31 live (one slot/lane); merge-on-lane-reuse documented | token is an object `{deferred, id}`; spec wants an **integer** with the deferred bit in it. Convert: `token = id << 1 | deferred`, 0 reserved for "none" |
| 2 | pass lifecycle **with yield/resume edges**, end disposition, per-callstack truth, `discardAllWip()` | **PARTIAL** | `onRenderPassStart(container, includedBatches)` from `prepareFreshStack` (implicit end on restart via WeakSet; NoLanes = reset); `onRenderPassEnd` at both render-loop completions; per-callstack "not in render" already true via `getRenderContext()` (`executionContext & RenderContext`) | **NEW: `passYield`/`passResume` events** (yield: `renderRootConcurrent` returns `RootInProgress`, WorkLoop ~3111 / `performWorkOnRoot` ~1249; resume: re-entry with `root === workInProgressRoot && lanes === workInProgressRootRenderLanes`, i.e. the no-`prepareFreshStack` path); **NEW: `passEnd(commit\|discard)` disposition**; **NEW: `discardAllWip()`** (only one WIP root exists at a time — reset it via the existing NoLanes reset path + reschedule); pin claim delivered at the start edge |
| 3 | retirement exactly once + committed flag + parking; **per-root commit reported** + baseline-capture ordering (§4.2) | **PARTIAL** | exactly-once: `retireSlot` (token nulled first); committed both ways (close edge retires `committed=false`; unmount-pruned work retires through an empty commit); parking: `parkUntilActionSettles` on `peekEntangledActionThenable`; per-root lock-in **internal**: `committedRoots` set + `batchTokensForRender` + fork test 7 | **NEW: per-root commit event** — `onRootCommitted(container, committedTokens, rootCommitGeneration)` (re-adding what commit `87653c5b79` dropped, now with the spec's per-root table/generation semantics); **NEW: baseline-capture ordering guarantee** (§4.2 step 1 before folds/table/drains; test 26) |
| 4 | `runInBatch(token, cb)`: updates join the token's lanes; retired → urgent fallback | **NEW** | nothing — no API schedules *into* an existing batch | reconciler-side: resolve token → slot → lane; for deferred tokens run `cb` under a transition pinned to that lane (override `currentEventTransitionLane` / `ReactSharedInternals.T` for the callback's extent); urgent tokens: run at the token's event priority; retired token: plain urgent run. Insertion-after-completion restart is stock React behavior — pin it (test 24) |
| 5 | render-lineage id: stable per (root × batch-set) across restarts/replays/Suspense retries; dead at commit/abandon | **NEW** | nothing — passes deliver token arrays only; every restart re-derives them | mint in `prepareFreshStack` keyed by (root, canonicalized live-token set of the render lanes); deliver with `passStart`; kill at commit or when the set's lanes leave `root.pendingLanes` uncommitted; a restart that picks up an extra batch is a **different** batch-set ⇒ new lineage (per spec: single tokens, mask unions, pass serials are all wrong keys) |
| 6 | DOM mutation window | **EXISTS** | `notifyBeforeMutation`/`notifyAfterMutation` inside `flushMutationEffects` (WorkLoop 4117, 4131-in-`finally`), View-Transition-correct placement, fires only when mutations apply | port as-is; add the missing reconciler-level test (consumer-side `mutation-observer.test.tsx` exists in the sibling) |
| 7 | versioned handshake: version + capability bits; refuse degraded modes | **NEW** (weak precedent) | presence-detection only (`instrumentedReact.ts` throws if `unstable_getCurrentWriteBatch` missing); `ReactSharedInternals.E === null` on renderer/isomorphic version skew is **tolerated by no-oping** — a silently-degraded mode the spec forbids | `unstable_externalRuntimeProtocol: {version: 1, capabilities: bits}` exported from `react` AND echoed by the reconciler provider; bindings assert both sides and fail loudly (gen-1's `version === 1` check is the precedent). Capability bits cover the post-port additions so a stale fork build fails loudly too |

**Appendix B flag 3 — answered from prior-fork code.** "What token does the
fork assign re-wrapped async continuations?" — `requestTransitionLane`
(RootScheduler) consults `peekEntangledActionLane()`: while an async action is
pending, **any** later `startTransition` (including the re-wrapped
continuation after `await`) claims the action's lane, so
`getOrMintBatchToken(lane)` lands in the same slot and returns **the same
token** (the registry's documented explicit-merge rule). Consequences: (a) the
parked action token *is* the re-wrap token — the write-set-closure late-write
surface in spec 5.3 (urgent-corrected behavior) is exactly the ActionScope +
re-wrap set, no third case; (b) needs a pinning test (new test alongside
11–13) because no prior test asserts it; (c) bare (un-wrapped) continuations
report no transition ⇒ ambient default, matching spec battery case 12.

---

## 5. Patch surface in the new fork, file by file

Port (P) = re-apply from the sibling, adapt names; New (N) = build here.

| file | work |
|---|---|
| `packages/react-reconciler/src/ReactFiberBatchRegistry.js` | P: whole file. N: int-token mint (`id<<1\|deferred`); per-root commit generation counter + `onRootCommitted` emit from the finish edge; retired-token lookup for `runInBatch`; flag-3 doc note |
| `packages/react-reconciler/src/ReactFiberExternalRuntime.js` | P: whole file. N: `emitRenderPassYield/Resume`, end disposition arg, `emitRootCommitted`, protocol version/capability echo |
| `packages/react-reconciler/src/ReactFiberWorkLoop.js` | P: 8 existing sites (see §9 excerpts). N: yield edge where `renderRootConcurrent` returns `RootInProgress` (~3111) / `performWorkOnRoot` continuation (~1249); resume edge on re-entry without `prepareFreshStack`; `discardAllWip()` export (reset WIP via the NoLanes path + `ensureRootIsScheduled`); lineage mint in `prepareFreshStack`; commit-vs-discard disposition at the existing end/implicit-end sites |
| `packages/react-reconciler/src/ReactFiberRootScheduler.js` | P: backfill + close edge. N: `runInBatch` lane-pinning helper (needs `currentEventTransitionLane` access, so it lives here or in a sibling module) |
| `packages/react-reconciler/src/ReactFiberLane.js` | N (likely): tiny helpers for `runInBatch` lane resolution — keep additive |
| `packages/react/src/ReactExternalRuntime.js` | P: whole file. N: new listener methods, `version`/`capabilities`, `runInBatch` + `discardAllWip` isomorphic entry points delegating to the provider |
| `packages/react/src/ReactClient.js`, `ReactSharedInternalsClient.js`, `index*.js` | P + N: export the grown surface (`unstable_runInBatch`, `unstable_discardAllWip`, `unstable_externalRuntimeProtocol`) |
| `packages/react-reconciler/src/__tests__/` | P: `ReactFiberBatchRegistry-test.js` (7 tests). N: split into `…BatchRegistry-test.js`, `…ExternalRuntimePass-test.js` (yield/lineage/discard), `…ExternalRuntimeCommit-test.js` (per-root/ordering/mutation), `…RunInBatch-test.js` — the 28-row list below |

Estimated end-state patch: ~1.6–2.1k lines added (prior 1043 + roughly
600–1000 for the five new capabilities and their tests), still additive-only.

---

## 6. The 28 fork tests (spec §4.4) — exists / port / new

Prior-fork tests (sibling `ReactFiberBatchRegistry-test.js`) by name:
T1 mint-stable/distinct-across-events; T2 classify-without-mint; T3
commit-retires-once-committed; T4 backfill (scheduled-before-mint); T5
passes-report-included-batches + urgent-excludes-pending-transition; T6
async-action parking; T7 multi-root committed lock-in.

| spec test | status | source / note |
|---|---|---|
| 1 event classification | **new** | discrete handler ⇒ urgent token |
| 2 transition classification | **port** | T1 (+ int-token assert) |
| 3 timer/network default | **new** | ambient default classification |
| 4 inside `flushSync` | **new** | |
| 5 nested scopes | **new** | transition-in-event, event-in-transition-scope |
| 6 engine-batch close preserves per-write context | **new** | fork side of the library `batch()` contract |
| 7 yield edge observed | **new** | fact-2 build |
| 8 resume edge observed | **new** | |
| 9 handler in yield gap ⇒ not-in-render | **new** | `getRenderContext()` already answers; test is new |
| 10 wall-clock-scope regression scar | **new** | |
| 11 retire exactly once | **port** | T3 |
| 12 committed flag both ways | **port** | T1 (uncommitted close) + T3 (committed) |
| 13 async parking | **port** | T6; **add flag-3 pin: re-wrapped continuation gets the same token** |
| 14 per-root committed table updates per commit | **new** | needs `onRootCommitted`; T7 proves the internal lock-in only |
| 15 per-root facts, two roots, spanning transition | **partial→new** | T7 is the seed (two `createRoot`s, suspended second root, lock-in + exactly-once) but asserts no per-root commit *event*; **existence proof — first** |
| 16–17 remaining multi-root schedules | **new** | **existence proofs — first** |
| 18 `runInBatch` joins lanes | **new** | fact 4 |
| 19 `runInBatch` retired ⇒ urgent fallback | **new** | fact 4 |
| 20 lineage stable across restart/replay/retry, dead at commit/abandon | **new** | fact 5 |
| 21 discarded pass never commits | **new** | implicit in pairing WeakSet today; assert it |
| 22 same-root urgent commit discards older yielded pass first | **new** | **existence proof — first** |
| 23 root ids stable; portals report parent root | **new** | `containerInfo` is stable; portal case untested |
| 24 insertion after completed-but-uncommitted ⇒ pre-commit restart | **new** | stock React behavior, pinned through the channel; **existence proof — first** |
| 25 write-set closure at commit | **new** | **existence proof — first** |
| 26 baseline capture precedes folds/table | **new** | intra-commit ordering (§4.2) |
| 27 `discardAllWip` synchronous; fresh pass/pin after | **new** | fact 2 |
| 28 no committed-view advance while same-root pass open | **new** | **existence proof — first** |

Score: 5 port (2, 11, 12, 13, and 15's skeleton), 23 new. The prior suite
stays green as-is during the port — it is the port-correctness gate.

## 7. Existence proofs FIRST (spec §8, §4.4 note on 15–17)

The spec names exactly two fact-clusters with **no current-generation React
existence proof**, and orders them before any bindings work:

1. **Per-root commit facts under multi-root schedules** — tests 15–17 + 25.
   First concrete test: **test 15** (two `createRoot`s, one transition
   spanning both, per-root commit *reported* with generation while the token
   stays live). Builds directly on prior T7's harness.
2. **Serialization/insertion facts** — tests 22, 24, 28. First concrete
   test: **test 28** (open a yielded same-root transition pass, fire an
   urgent same-root commit, assert the pass-end(discard) edge precedes any
   committed-view advance), with 22 and 24 as its two neighbors.

These two run in the first post-port session; if either fact turns out not to
hold in the current reconciler (e.g. a commit path that advances committed
state while a pass frame is technically open), that is a spec-level finding to
escalate **before** any binding code exists to be wrong.

---

## 8. Build and link plan (this repo)

1. **Vendoring** (not done yet — per the bring-up instruction): push a fork
   of `facebook/react` to `github.com/justjake/react`, branch `cosignal-fork`
   from `e71a6393e66b`; add here as a submodule at `vendor/react` (matches
   this repo's existing submodule pattern, cf. `packages/dalien-signals` →
   `justjake/alien-signals`). Then re-apply the 9 sibling commits:
   `git -C ~/src/react-signals-fable/vendor/react format-patch 7ce677d406..react-signals-patch --stdout > /tmp/fable-fork.patch`
   and `git am` onto `cosignal-fork` (expected clean: zero upstream drift in
   touched files).
2. **Build script**: copy `~/src/react-signals-fable/scripts/build-react.sh`
   → `fork/build-react.sh` (adjust `cd` path). It drives
   `scripts/rollup/build.js` directly (~13s; avoids the minutes-long
   `yarn build` all-channels path and its ReactVersion placeholder),
   `RELEASE_CHANNEL=experimental`, entries
   `react/index,react/jsx,react/compiler-runtime,react-dom/index,react-dom/client,react-dom/test-utils,scheduler`,
   `--type=NODE_DEV,NODE_PROD`; renames `build/node_modules` →
   `build/oss-experimental`; symlinks `node_modules/{react,react-dom,scheduler}`
   inside it so the built `react-dom` resolves its peers.
3. **Link**: root `package.json` gains
   ```json
   "pnpm": { "overrides": {
     "react":     "link:vendor/react/build/oss-experimental/react",
     "react-dom": "link:vendor/react/build/oss-experimental/react-dom",
     "scheduler": "link:vendor/react/build/oss-experimental/scheduler"
   }}
   ```
   (`link:` means rebuilds are picked up with no re-install). Add a
   `libs/cosignal` (or `libs/…`) workspace package when bindings start;
   `pnpm-workspace.yaml` already globs `libs/*`.
4. **Fork test run**: reconciler tests run inside `vendor/react` with React's
   own jest (`yarn test packages/react-reconciler/src/__tests__/ReactFiberBatchRegistry-test.js`
   using the `.nvmrc` node via mise, as build-react.sh does). Wire a
   `fork:test` script at the root; it is the rebase drill's executable half.
5. **Rebase procedure** (recorded for later): fetch upstream main, branch,
   `git rebase --onto`, re-run fork tests + `fork/build-react.sh` + the
   handshake version bump. Gen-1's `REACT_FORK.md` has the fuller checklist
   prose to crib.

## 9. Effort estimate (agent-sessions)

| session | content | exit gate |
|---|---|---|
| S1 | vendor + `git am` the 9 commits + build script + pnpm override + prior 7 tests green in-tree | `fork/build-react.sh` artifact loads; 7/7 |
| S2 | existence proofs: `onRootCommitted` minimal event, tests 15–17 + 25; serialization trio 22/24/28 | proofs green or a written spec-escalation |
| S3 | fact 2: yield/resume edges, end disposition, `discardAllWip`; tests 7–10, 21, 27 | |
| S4 | fact 4: `runInBatch` + tests 18–19 (+ 24 interplay re-run) | |
| S5 | fact 5: lineage id + tests 20, 23 | |
| S6 | fact 7 handshake + int-token conversion + classification tests 1–6 + flag-3 pin + ordering test 26 | 28/28 + handshake |
| S7 | slack: multi-root scheduling flakes, `act()` semantics at yield edges, doc pass (`fork/PROTOCOL.md` v1) | suite stable across 3 runs |

**Estimate: 7 agent-sessions (6 if S2 finds no surprises; 8–9 if an
existence proof fails and forces reconciler archaeology).** S1 is
low-risk (zero drift); S2 carries the real uncertainty and is deliberately
second, not last.

---

## 10. Critical hook-site excerpts (so the port isn't archaeology)

All citations: `~/src/react-signals-fable/vendor/react`, branch
`react-signals-patch`.

**Fact 1 — the provider, mirroring `requestUpdateLane`'s cascade**
(`packages/react-reconciler/src/ReactFiberWorkLoop.js:878–931`):

```js
registerExternalRuntimeProvider({
  getRenderContext(): null | {container: mixed} {
    if ((executionContext & RenderContext) !== NoContext &&
        workInProgressRoot !== null && workInProgressRootRenderLanes !== NoLanes) {
      return {container: workInProgressRoot.containerInfo};
    }
    return null;
  },
  isCurrentWriteDeferred(): boolean { /* classification only — no minting */ … },
  getCurrentWriteBatch(): mixed {
    let lane; let deferred = false;
    if ((executionContext & RenderContext) !== NoContext &&
        workInProgressRootRenderLanes !== NoLanes) {
      lane = pickArbitraryLane(workInProgressRootRenderLanes);
      deferred = laneIsTransitionLane(lane);
    } else {
      const transition = requestCurrentTransition();
      if (transition !== null && !transition.gesture) {
        lane = requestTransitionLane(transition); deferred = true;
      } else {
        lane = eventPriorityToLane(resolveUpdatePriority());
      }
    }
    const token = getOrMintBatchToken(lane, deferred);
    // Minting a token must guarantee a close edge even if the batch never
    // schedules React work: make sure the scheduling microtask runs.
    ensureScheduleIsScheduled();
    return token;
  },
});
```

**Fact 3 — the four registry edges** (`ReactFiberWorkLoop.js:1836, 3849`;
`ReactFiberRootScheduler.js:~320, ~357`):

```js
// pending edge — inside markRootUpdated(root, updatedLanes):
batchRegistryOnRootUpdated(root, updatedLanes);   // WorkLoop:1836

// finish edge — in commitRoot, immediately after markRootFinished:
batchRegistryOnRootFinished(root, lanes, root.pendingLanes);   // WorkLoop:3849

// backfill — processRootScheduleInMicrotask, per root still holding work,
// BEFORE the close edge (repairs setState-before-store-write ordering):
batchRegistryBackfillRoot(root);                  // RootScheduler:~320

// close edge — end of processRootScheduleInMicrotask, after
// currentEventTransitionLane resets:
batchRegistryOnEventClosed();                     // RootScheduler:~357
```

Finish-edge core (`ReactFiberBatchRegistry.js:155–190`): a token retires when
its last pending root is done; `committed = (finishedLanes & lane) !== 0`;
committed-here-pending-elsewhere roots go into `slot.committedRoots` (per-root
lock-in) and `batchTokensForRender` unions those into every later pass on that
root — this is the internal half of fact 3 that the new `onRootCommitted`
event must surface.

**Parking** (`ReactFiberBatchRegistry.js:199–244`): at the close edge, a
store-only deferred slot whose lane `=== peekEntangledActionLane()` parks on
`peekEntangledActionThenable()`; on settle, retire only if still store-only.

**Fact 2 (existing half) — pass brackets**
(`ReactFiberExternalRuntime.js:49–96`, called from `ReactFiberWorkLoop.js:2356,
2839, 3126`): `prepareFreshStack` → `notifyRenderPassStart(root, lanes)`
(implicitly ends any active pass on that root first — restart = discard;
`lanes === NoLanes` = pure reset); both render loops call
`notifyRenderPassEnd(root)` when the tree completes. The WeakSet pairing is
what the new `passEnd(commit|discard)` disposition and yield/resume edges
extend. Yield-edge anchor for the port: `renderRootConcurrent` returns
`RootInProgress` at `ReactFiberWorkLoop.js:3111` (and `performWorkOnRoot`'s
`exitStatus === RootInProgress` continuation at :1249); resume-edge anchor:
the `renderRootConcurrent` entry path that *skips* `prepareFreshStack`
(`root === workInProgressRoot && lanes === workInProgressRootRenderLanes`).

**Fact 6 — mutation window** (`ReactFiberWorkLoop.js:4117/4131`): inside
`flushMutationEffects`, `notifyBeforeMutation(root)` before
`commitMutationEffects`, `notifyAfterMutation(root)` in the `finally` —
placed there (not `commitRoot`) so View-Transition commits, whose mutation
phase runs inside the browser's `startViewTransition` callback, are bracketed
too.

**Flag 3 mechanism** (`ReactFiberRootScheduler.js`, `requestTransitionLane`):

```js
if (currentEventTransitionLane === NoLane) {
  const actionScopeLane = peekEntangledActionLane();
  currentEventTransitionLane =
    actionScopeLane !== NoLane
      ? actionScopeLane            // inside an async action scope: REUSE the lane
      : claimNextTransitionUpdateLane();
}
return currentEventTransitionLane;
```

Same lane ⇒ same slot ⇒ `getOrMintBatchToken` returns the existing token:
re-wrapped continuations of a pending action share the parked token.

## 11. Open questions carried into S1/S2

1. Integer tokens can't carry consumer WeakMap state the way the prior
   object tokens could — cosignal interns to 5-bit slots anyway (spec §5.4),
   but the fork test harness loses `token.deferred`; expose
   `unstable_isBatchTokenDeferred(int)`-style helpers or just document
   `token & 1`.
2. `passStart(root, mask, pinClaim)` in spec §4.1 uses library vocabulary
   (mask/pin are binding-side per §2 and §5.4); the fork delivers
   `(container, includedTokens[, lineageId])` and the binding claims the pin
   at that edge — confirm during binding design that nothing needs the pin
   claimed inside the reconciler callback itself.
3. Whether `discardAllWip` must also flush the root-schedule microtask to
   satisfy "returns only when no WIP hook retains render-minted identity"
   (spec §4.1 fact 2) — decide against test 27.
4. `onRootCommitted` payload: committed token list vs (token, generation)
   pairs; §4.2's baseline capture may want the generation in the same event.
