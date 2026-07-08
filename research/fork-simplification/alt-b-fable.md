# Fork simplification for cosignals-alt-b alone (fable)

Question: if `vendor/react` (fork over upstream base `e71a6393e6`) only had to
support `packages/cosignals-alt-b`, how small could the patch get? Everything
below is measured from `git diff e71a6393e6..HEAD` inside `vendor/react`
(**20 files, 5,016 insertions, 1 deletion**; the prompt's "+5,012/19" is the
same diff before the last polish commit) and from what alt-b actually imports.
alt-b consumes the fork through exactly one adapter, `ReactFork`
(packages/cosignals-alt-b/src/react.ts:471-663), one engine listener
(src/engine.ts:3803-3884), and one bindings listener (src/react.ts:77-109);
its behavioral contract is pinned by test/react-real.test.tsx (954 lines, RTL
against the real build — alt-b links `vendor/react/build/oss-experimental`).

Baseline decomposition of the 5,016 inserted lines:

| file | +LoC | code / comment (measured) |
|---|---|---|
| react-reconciler/ReactFiberBatchRegistry.js (new) | 564 | 297 / 240 |
| react-reconciler/ReactFiberExternalRuntime.js (new) | 204 | 103 / 88 |
| react-reconciler/ReactFiberWorkLoop.js | +291 | 137 / 140 |
| react-reconciler/ReactFiberRootScheduler.js | +33 | 15 / 15 |
| react/src/ReactExternalRuntime.js (new) | 334 | 145 / 171 |
| react/src/ReactClient.js | +17 | — |
| react/src/ReactSharedInternalsClient.js | +5 | — |
| react/index*.js (7 channel entrypoints) | +49 | — |
| react-noop-renderer/createReactNoop.js | +13 | — |
| scripts/error-codes/codes.json | +4 | — |
| **source subtotal** | **1,514** | ~772 code |
| 4 fork test files (BatchRegistry/Commit/Pass/RunInBatch) | 3,502 | — |
| **total** | **5,016** | |

Headline: the source patch drops from **1,514 → ~1,230 LoC (−19%)** with zero
loss against alt-b's RTL suite, to **~1,170** with one protocol change
(allocator inversion), and the fork test suite can be pruned roughly in half.
The two headline redesign candidates — switching alt-b to alt-a's monotonic
gate, and removing `runInBatch` — save **approximately zero fork lines** and
are rejected with measurements below. Zero-fork React kills every guarantee
the package exists for (§4).

---

## 1. Inventory: fork patch → alt-b feature → RTL pin

### 1.1 Surface alt-b consumes

| fork surface (patch site) | alt-b consumer | feature | RTL test that fails without it |
|---|---|---|---|
| `unstable_registerBatchIdAllocator` (ReactExternalRuntime.js:273-296; called from ReactFiberBatchRegistry.js:168-190 `getOrCreateBatchId`) | react.ts:489-493 — mints `(serial<<1)\|deferred`, records the live set, emits the internal `onBatchOpened` edge → engine.ts:3812-3814 DIRECT→LOGGED flip | batch identity in ONE number space; deferred classification via bit 0 (engine.ts:2289); gate mint edge | every transition test: react-real.test.tsx:79 (lockstep), :100 (held-open rebase), :147 (mount-during-transition), :831 (strictLanes parity) |
| `unstable_getCurrentWriteBatch` (provider, ReactFiberWorkLoop.js ~900-923: classification cascade mirroring `requestUpdateLane`; `ensureScheduleIsScheduled` for the close edge) | engine.ts:2288 (every LOGGED write's attribution), react.ts:573-585 (also captures `(T → token)` for the ambient probe), react.ts:650 (`startTransition` token capture) | write→batch attribution; lazy minting | react-real.test.tsx:79, :100, :588-711 (ambient-W0 family) |
| `unstable_getRenderContext` (provider, WorkLoop ~885-899) | engine.ts:453 `forkRenderingNow` (per-read suspension-gap downgrade RENDER→NEWEST), engine.ts:2228 (write-in-render guard), react.ts:600, :643, :932-934 (useSignalEffect root capture) | per-callstack "is React rendering", container identity | react-real.test.tsx:100 (reads in suspension gaps must see NEWEST), :933 (effect root) |
| `onRenderPassStart(container, includedBatches)` (ReactFiberExternalRuntime.js:94-118 + prepareFreshStack hook WorkLoop +2483; `batchIdsForRender` ReactFiberBatchRegistry.js:533-564 incl. entangled expansion + committed-root lock-ins; `batchRegistryOnRenderStart` :129-134 render-time stash) | engine.ts:3815-3838 (pass frame: pin = seq counter at start, include mask, RENDER ctx); react.ts:78-84 (`currentPass` → `renderingDeferredPass`, react.ts:364-366) | render-world resolution: a pass reads retired history + included batches' pre-pin entries | react-real.test.tsx:135 (urgent pass EXCLUDES the pending draft: `v:2` not 4), :147 (transition pass INCLUDES it: `late:7`), :430/:507 (two-level suspense rule (a) needs pass deferredness) |
| `onRenderPassEnd(container, committed)` (notifyRenderPassCommitted ReactFiberExternalRuntime.js:171-183 + implicit-end in notifyRenderPassStart:100-106 + commitRoot hook WorkLoop +4020) | engine.ts:3846-3861 (close frame, `sweepTapes`, `maybeQuiesce` → LOGGED→DIRECT flip at engine.ts:2934); react.ts:85-87. The `committed` param is ignored (react.ts:524) | pass-frame close; quiescence boundary | react-real.test.tsx:811 (`__debug.isDirect()` true when idle), all convergence assertions |
| `onBatchRetired(token, committed)` (retireSlot ReactFiberBatchRegistry.js:474-487; finish edge :295-406; close edge :422-443; parking :445-472) | engine.ts:3866-3874 → `E.onRetired` (fold tape entries into canonical state); react.ts:527-529 (live map); react.ts:98-108 (lock-in clear) | the promotion edge — pending worlds become committed state | react-real.test.tsx:143 (`v:4` rebase result), :633-638 (settle order), every final-value assertion |
| `onRootCommitted(container, committedBatches, generation)` (emit in finish edge, ReactFiberBatchRegistry.js:392-399) | react.ts:88-97, :531-534 — per-root views: pin bump, lock-ins, effect flush. `generation` is **ignored** | per-root committed views for `useSignalEffect`/`readRootCommitted`; multi-root lock-in | react-real.test.tsx:933 (effects see committed values), :857 (two roots) |
| `unstable_runInBatch` (runInBatchImpl WorkLoop ~967-1019 + lane pin ReactFiberRootScheduler.js:710-736 + `lookupLiveBatchSlot` registry:200-212 + error 605) | engine.ts:2543 (deferred broadcast groups → setStates in the batch's own lane), engine.ts:2568-2576 (urgent drains decide in every live deferred world — bailout avoidance), react.ts:190 (SignalHook fixup-pending) | late work joins a pending batch's lane; THE entanglement primitive | react-real.test.tsx:176 (signal-only transition must re-render at all), :100 (settle commit must not bail out past the urgent correction), :422 (probe flip held with the transition, never painted early) |
| `unstable_resetBatchRegistryForTest` (registry:503-515 + plumbing) | react-real.test.tsx:41, :55 only | test isolation | the RTL harness itself |
| `ReactSharedInternals.E` (+5, ReactSharedInternalsClient.js) | transport for all of the above (renderer↔isomorphic, same pattern as `S`) | — | — |
| `ReactSharedInternals.T` (**upstream, zero patch lines**) | react.ts:564-571 (`getAmbientReadToken` scope identity, consumed at engine.ts:1752-1761), react.ts:635-641 (`hasOpenWork` pre-mint probe, consumed at engine.ts:2250) | read-your-own-draft; quiescence-gate probe under lazy minting | react-real.test.tsx:652-711 (write-then-read in scope = 5, outside = 0), :811-829 (loose gate) |

Registry internals that look optional but are load-bearing for the above:
`batchRegistryOnRootUpdated` pending edge (registry:218-227, WorkLoop +1964),
`batchRegistryBackfillRoot` (registry:242-255, RootScheduler:320-324 — the
`startTransition(() => { setState(x); store.write(y) })` line-order repair),
close edge + async-action parking (registry:422-472, RootScheduler:357-359 —
without it a store-only transition never retires and the engine's
`maybeQuiesce` never flips back to DIRECT), `renderedLanesByRoot` +
`rependedLanes` (registry:111-134, :306-350, WorkLoop +3992 — the mid-render
re-pend / lock-in distinction pinned by fork test 26).

### 1.2 Surface alt-b does NOT consume (dead weight in an alt-b-only fork)

| dead surface | evidence | patch lines |
|---|---|---|
| `unstable_discardAllWip` (+ error 604, `getRootsWithOpenPassFrames`) | absent from alt-b's `ReactRuntime` type (react.ts:448-469); zero references in src/ or test/ | ~86 |
| `onBeforeMutation` / `onAfterMutation` (§6.6 mutation window) | `ReactFork` forwards them (react.ts:536-537) but **no listener subscribes** — engine listener (engine.ts:3811-3875) and bindings listener (react.ts:77-109) omit them | ~43 |
| `onRenderPassYield` / `onRenderPassResume` | engine.ts:447-463 documents that this build parks suspended work with NO yield event, so the engine already **polls** `getRenderContext()` per RENDER-ctx read (`ctxNow`, engine.ts:458-463) and per write (engine.ts:2228). The event-driven `currentCtx` flip (engine.ts:3840-3845) is a shadow of the poll | ~90 |
| `rootCommitGeneration` (3rd arg of onRootCommitted) | dropped on the floor at react.ts:531 | ~19 |
| `committed` param of `onRenderPassEnd` | `void committed` react.ts:524 | (included above) |
| `isCurrentWriteDeferred` as an API | already deleted from the fork (commit 30ca859c); alt-b derives from bit 0 | 0 |
| render lineage | already deleted (commit 30ca859c); `ForkLike` keeps a vestigial arg fed constant 0 (react.ts:507) | 0 (fork), ~6 (alt-b vestige) |
| non-experimental channel exports | alt-b links `build/oss-experimental` only (node_modules/react symlink) | ~36 of the 49 index lines |
| react-noop-renderer `canceled` fix (+13) | supports the fork's own noop-driven test suite, not alt-b | 13 (coupled to which fork tests survive) |
| the 4 fork test files | pin the multi-client protocol (all 4 channels, www gates, noop yields) | 3,502 |

---

## 2. The minimal protocol (full fidelity to alt-b's RTL suite)

Keep, verbatim: the batch registry (slots, claim/mint via allocator, pending
edge, backfill, finish edge with render-time stash + re-pend lock-ins, close
edge with async-action parking, retire), the pass frame (start with
`batchIdsForRender`, end at commit/implicit discard), `onRootCommitted`,
`getCurrentWriteBatch`'s classification cascade, `getRenderContext`,
`runInBatch` + the RootScheduler lane pin, `resetBatchRegistryForTest`, and
the `ReactSharedInternals.E` transport.

Delete (per-patch LoC from the diff, §1.2 evidence):

| cut | fork LoC | fidelity price |
|---|---|---|
| D1 `discardAllWip`: WorkLoop fn+doc 43 + provider line + import (45), FiberExternalRuntime `getRootsWithOpenPassFrames` + strong-set rationale (17), ReactExternalRuntime type+wrapper (14), ReactClient (2), index (7), error 604 (1) | **−86** | none — never called |
| D2 mutation window: WorkLoop flushMutationEffects brackets (9), notifyBefore/AfterMutation (20), isomorphic type+emits (14) | **−43** | none for alt-b; a future MutationObserver integration would use DOM heuristics instead (that was its only client story) |
| D3 yield/resume: WorkLoop call sites (21), FiberExternalRuntime yielded-set + two notifiers (~50), isomorphic type+emits (~19) | **−90** | none — the engine's poll (engine.ts:453, :458-463, :2228) already carries gap semantics on this build; time-slicing gaps degrade from event-driven to polled, which is the already-shipping behavior for suspension gaps. alt-b may then delete the dead adapter wiring (react.ts:509-518) and the engine's yield/resume listener arms (engine.ts:3840-3845) — the ForkDouble keeps them for unit-test scripting only |
| D4 `rootCommitGeneration` WeakMap + emit arg (registry:105-111, :301-304, :397) and the `committed` param of pass-end | **−19** | none — both ignored |
| D7 noop-renderer fix | **−13** | only if the noop-driven fork tests go too (they exercise pending-commit cancellation, which alt-b observes only as a pass-end) |
| D8 channel trim: export the API from index.experimental*.js only | **−36** | alt-b builds one channel; other channels simply lack the API |

Retained after D1-D8: **~1,230 source LoC** (≈630 executable). Per file:
BatchRegistry 549 (allocator kept, generation cut), FiberExternalRuntime ~117,
WorkLoop ~216, RootScheduler 33, ReactExternalRuntime ~287, ReactClient 15,
SharedInternals 5, index ~6, codes.json 3.

Upstream-mechanism replacements audited for the retained core — none survive:

- **`ReactSharedInternals.T` reads** (already used by alt-b, zero patch lines)
  give "a transition scope is open" and scope identity, but NOT batch
  identity, retirement, included-batches, or lane joining. They cannot
  replace the registry.
- **Public `startTransition` + `useTransition`** cannot join an EXISTING lane
  (each event mints its own) — no substitute for `runInBatch`.
- **`useSyncExternalStore`** is the zero-fork fallback; its updates are
  always synchronous even inside `startTransition` (the documented caveat) —
  it replaces nothing while preserving nothing (§4).
- **Polling `getRenderContext`** replaces yield/resume (taken, D3) but cannot
  replace `onRenderPassStart`: the engine must capture its own seq-counter
  pin at the pass-start *moment* (engine.ts:3819) — a pull at first read
  would move the pin later and let mid-pass writes leak into the pass world.
  Pass start/end are the irreducible event pair.

---

## 3. Tandem alt-b redesigns

### R1 — THE BIG ONE: adopt alt-a's monotonic gate. **Rejected: saves ~0 fork LoC.**

The premise was that alt-b's extra fork dependencies (per-write
`fork.hasOpenWork()` probe engine.ts:2250, pre-mint scope detection via
shared-internals `T` react.ts:635-641, `getAmbientReadToken` react.ts:592-598,
lazy-mint interplay) cost fork patch lines that a monotonic gate would delete.
Measured against the diff, they cost **zero**: all three are adapter-side
compositions over surfaces the minimal fork retains for other reasons —
the allocator/retire events (live set), pass events (`passContainer`),
`unstable_getRenderContext`, and the **upstream** `T` slot. There is no
`hasOpenWork` patch in vendor/react to delete.

What the switch would cost alt-b:

- **The loose contract's measured win dies.** G-6a (test/perf.test.ts:88-120,
  run on this machine): idle-stream DIRECT **190 ns/write** vs always-logged
  **750 ns/write** = **3.9×**; tape-create era across cone 10/100/1000:
  **5.5× / 4.6× / 3.5×** (test/perf.test.ts:122-148). Every timer/socket/
  store write in an idle app pays this forever — exactly the tax
  react-concurrent-signals-arena-alt-b.md:1310-1333 documents accepting the
  loose contract to avoid.
- Nothing is bought on the semantics side either: alt-b already ships the
  monotonic behavior as `configure({ strictLanes: true })`
  (engine.ts:3808-3810, :2934) and runs the whole RTL family in both modes.
- `getAmbientReadToken` would NOT become deletable — ambient-W0
  read-your-own-draft (SPEC-RESOLUTIONS.md §ambient-W0) is orthogonal to the
  gate. Note alt-a's own real-React bridge implements the same probe worse:
  `isCurrentWriteDeferred()` = `unstable_getCurrentWriteBatch() & 1`
  (cosignals-alt-a/src/react/bridge.ts:156-159) **mints a spurious urgent
  batch on ambient reads** taken while a deferred batch is live
  (cosignals-alt-a/src/engine.ts:1573-1585 calls it under exactly that
  guard); alt-b's `(T === lastScopeT)` identity probe is mint-free.

Price if taken anyway: alt-b −~40 LoC (gate branch engine.ts:2243-2254,
`hasOpenWork` react.ts:627-644, `onBatchOpened` arm), fork −0, semantics
risk none (strictLanes is already the pinned twin) — but −3.9× idle writes.
**Do not take.**

### R2 — Allocator inversion-of-inversion: fork mints `(serial<<1)|deferred` natively. **Optional, net −~59.**

Protocol v2's allocator exists so batch ids live in ONE number space and the
store learns deferredness at creation. With alt-b as the only client, the
encoding can be hard-coded fork-side: `getOrCreateBatchId` mints
`(nextBatchSerial++ << 1) | deferred` itself, and the whole registration
surface goes away — `registerExternalRuntimeBatchIdAllocator` + allocator
field + docs (~54, ReactExternalRuntime.js:75-86, :262-296), the allocator
arm + DEV check in the registry (~15, registry:174-186), client/index export
lines (3), error 606 (1): **−73 gross**.

What alt-b loses and how it's repaired (+~14 fork, +~10 alt-b):

- `ReactFork.live` is currently populated by the allocator callback
  (react.ts:489-493). Its consumers: `liveTokens()` (engine.ts:2568 urgent-
  drain world decisions, engine.ts:3309 watcher baseline seeding),
  `isBatchLive` (react.ts:93, engine.ts:3340), `isQuiescent`/`hasOpenWork`.
  The drain-time iteration MUST see write-less live batches (a setState-only
  transition still needs urgent corrections decided into its world, or its
  pass bails out components past the urgent value — committed-view
  regression). Replacement: one pull, `unstable_getLiveBatchIds()` (~6 lines
  provider iterating the 31 slots + ~6 isomorphic wrapper + 2 export lines).
- The gate's `onBatchOpened` edge dies; engine.ts:2250's per-write
  `hasOpenWork()` probe already covers the lazy-mint hole (that is why it
  exists — engine.ts:2244-2249), so the edge was belt-and-braces.

Risks: `liveTokens()` becomes an allocating pull on drain paths (small,
measurable); the fork owns id policy (fine — one client). Verdict: sound,
take it only if the ~59 lines matter more than the churn; it is the one cut
that changes protocol shape rather than deleting dead weight.

### R3 — Pass-event collapse. **Partially taken (D3); further collapse rejected.**

Yield/resume: deleted (D3, −90) — the poll is already authoritative on this
build. Start/end cannot merge or move (pin capture, §2). Folding
`onRootCommitted` into pass-end fails on ordering: the frame must close
*before* the committed-view advance (WorkLoop +4020-4035, and the bindings
rely on commit reports arriving frameless), and store-only batches retire
with no pass at all.

### R4 — Restructure `runInBatch` away. **Rejected.**

The common case doesn't need it: alt-b drains broadcasts synchronously inside
the writer's scope, where `ReactSharedInternals.T` is ambient and setStates
join the transition lane natively. But three consumers run *outside* the
scope with no upstream equivalent: post-scope drains (engine.ts:2540-2554),
urgent drains deciding in every live deferred world (engine.ts:2568-2576 —
the anti-bailout corrections), and commit-phase fixups
(react.ts:181-197). Without it: react-real.test.tsx:176 fails outright (a
signal-only `useSignalTransition` schedules no React work in the transition
lane at all), :422's "the '!' never paints early" fails (probe flip falls
back to urgent = early paint), :147's raced-mount corrections leak pending
values into urgent commits. Cost of keeping: ~130 source LoC (runInBatchImpl
92 incl. docs, RootScheduler pin 21, lookupLiveBatchSlot ~13, error 605).
This plus write attribution IS the product; it stays.

### R5 — Drop `onRootCommitted`, go global-committed. **Reduced-fidelity option, −~35.**

Delete the event emission + `committedBatchIds` assembly (registry:314-399
emit parts, isomorphic type+emit ~25 total) — the `committedRoots` lock-in
sets must STAY (they feed `batchIdsForRender`'s render correctness,
registry:548-562). alt-b deletes `rootViews`/lock-ins (react.ts:50-113,
~−60 LoC) and rebases `useSignalEffect` on the engine's global COMMITTED
world + its existing kernel tracker (react.ts:233-237, which already handles
DIRECT-mode commits). Price: on multi-root apps an effect on root A can
observe a batch committed on root B before A's own commit (bounded,
convergent; RTL :933 and :857 still pass — the per-root *timing* precision
is unpinned). Take only if per-root effect views are declared out of scope.

---

## 4. The capability/LoC curve

| point | fork source LoC | fork tests | what dies vs current |
|---|---|---|---|
| P0 — current fork | 1,514 | 3,502 | — |
| **P1 — alt-b-only minimal (D1-D4, D7, D8)** | **~1,230** | ~1,800-2,400 pruned (drop discard/mutation/yield scenarios + non-experimental channel gates) | nothing alt-b's RTL pins |
| P1b — P1 + R2 allocator inversion | ~1,170 | ~same | nothing pinned; protocol churn |
| P2 — P1b + R5 global-committed effects | ~1,135 | ~same | multi-root per-root effect timing |
| P3 — "batch ledger only": registry + getCurrentWriteBatch + retire/close edges; NO pass events, NO runInBatch, NO onRootCommitted | ~850-900 | small | render-world resolution dies (react-real :135 leaks the draft into urgent renders, :147 tears) and entanglement dies (:176, :422) — alt-b degrades to "attributed writes that fold at retirement". Not a useful product point |
| P4 — zero fork (stock React) | 0 | 0 | see below |

Zero-fork necrology (each item names the RTL pin that dies):

- **Single-commit lockstep** of signal + setState in one transition
  (:79) — writes apply immediately; a `new:0`/`old:1` frame can paint. This
  is the uSES sync-update caveat the whole design exists to remove.
- **Pending-world isolation + rebase** (:100-145) — no draft worlds: the
  transition's `+1` lands in committed state instantly; the urgent `*2`
  computes over the draft; React's updater-queue arithmetic `(1+1)*2=4`
  after interruption is unreproducible.
- **Mount-during-transition consistency** (:147) — the marquee frame
  stock-React userland provably tears on.
- **Ambient-W0 + read-your-own-draft** (:588-711) — no drafts exist to hide.
- **Two-level suspense rule's transition arm** (:430, :507) —
  `renderingDeferredPass` (react.ts:364-366) is unobservable; signals-side
  and React-side waiters of one promise can commit separately.
- **flushSync/strictLanes parity family** (:783-854) — no lanes to be strict
  about.
- **Per-root committed effect views + multi-root lock-ins** (:857, :933).

What survives at P4: the sync engine (permanently DIRECT — ironically its
fastest configuration), node-held suspense boxes with stable retry identity
(:204-223 basics still pass via thrown thenables/`use()`), stale-through
refetch in urgent renders (rule (b)), `isPending`/`latest`/`refresh` API
shapes with degraded meaning (`latest ≡ state`), lazy init, SSR helpers,
StrictMode holder patterns — i.e., exactly the feature set of every existing
uSES-based signals library. The fork is not an optimization; it is the
difference between that list and the necrology above.

---

## 5. Recommendation and migration sketch

**Adopt P1 (~1,230 source LoC, −19%), take R2 opportunistically (→ ~1,170,
−23%), decline R1/R4, hold R5 unless multi-root effect precision is formally
descoped.** Prune the fork test suite to the retained surface on the
experimental channel (~−1,100-1,700 test lines); alt-b's own
react-real.test.tsx stays the end-to-end gate. Expected total fork insertions
after migration: **~2,900-3,400 vs 5,016 today** (source ~1,200, tests
~1,700-2,200).

Order of operations (each step green before the next; gates = pruned fork
suite + alt-b `pnpm test` incl. react-real + both gate modes + PERF=1 G-6a/6b
unchanged):

1. **D1 discardAllWip** — pure deletion (WorkLoop, FiberExternalRuntime,
   isomorphic wrappers, exports, error 604, its test block in
   ReactFiberExternalRuntimePass-test.js). No alt-b change.
2. **D2 mutation window** — pure deletion + drop the two forwarding lines
   react.ts:536-537 and the `ExternalRuntimeListener` fields (fork.ts:75-76).
3. **D3 yield/resume** — fork deletion; alt-b: delete react.ts:509-518 and
   engine.ts:3840-3845 (keep the ForkDouble scripting ops and the double-only
   unit tests — they pin engine gap semantics that now ride the poll);
   re-run the suspension-gap RTL tests (:100, :279) to confirm the poll
   carries them (it already does on this build).
4. **D4 + D8 + D7** — drop `generation`/`committed` params (adjust
   react.ts:519-534 signatures), trim non-experimental index exports, delete
   the noop fix together with the noop-driven scenarios cut in test pruning.
5. **(optional) R2** — fork mints `(serial<<1)|deferred`, add
   `unstable_getLiveBatchIds()`; alt-b: delete the allocator registration
   (react.ts:489-493), source `live` from the pull + retire events, keep
   `getAmbientReadToken` capture at `getCurrentWriteBatch` (react.ts:577-584,
   unchanged). Re-run the full RTL matrix plus gc-leaks (watcher baseline
   pruning consults `isBatchLive`, engine.ts:3340).
6. **Test prune** — keep BatchRegistry-test and RunInBatch-test nearly whole,
   keep Commit-test's per-root/lock-in/entanglement families, cut Pass-test's
   yield/mutation/discard families; single channel.

Non-goals, recorded: do not chase the ~630-line executable floor by stripping
comments (the patch is 50% documentation and that documentation is the
protocol spec); do not fold `ReactFiberExternalRuntime` into the registry for
~20 lines of imports; do not touch `renderedLanesByRoot`/`rependedLanes`/
backfill/parking — they are the subtle half of the finish/close edges, they
cost ~60 lines total, and two of them (mid-render delivery, entanglement
under parallel transitions) were discovered as real seam bugs by the fork's
own suite.
