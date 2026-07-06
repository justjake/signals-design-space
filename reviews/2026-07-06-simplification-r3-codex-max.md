Read-only review complete. No code changed. The highest-leverage simplifications are in the production bridge’s referee/diagnostic machinery, not its core concurrent-state model.

## Shape of the whole

`cosignal` contains two layers: a compact newest-world reactive kernel in `index.ts`, and a substantially larger concurrent bridge in `concurrent.ts` that records writes, constructs pass/root worlds, tracks subscriptions, and reconciles commits. `cosignal-react` is mostly policy: it translates React’s external-runtime protocol into bridge operations and routes notifications back into React lanes. `cosignal-oracle` independently replays the same semantics using simple collections and full recomputation. That independence is valuable; I would not share evaluator/fold code between engine and oracle. The maintainability problem is where test policy, diagnostics, and optimization-specific state have leaked into the production bridge or the supposedly semantic oracle.

## Findings, ranked by leverage

### 1. The bridge implements a second, synthetic version of core effects

**What:** [`Subscription`](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:561) represents both committed React effects and “newest” core effects. [`mountCoreEffect`](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:4434), [`flushNewestSubs`](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:4153), and [`directFlushCoreEffects`](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:4197) recreate dependency reachability, value gating, and effect flushing already implemented by the real [`effect()`](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/index.ts:2440). No React adapter source calls `mountCoreEffect`; its in-scope users are referee tests and benchmarks.

**Why complex:** One concept—“a core effect sees newest state”—has two mechanisms. The synthetic mechanism forces sentinel states such as `root: ''`, optional bodies/refires, a `policy` discriminator, `newestSubCount`, graph traversal scratch state, and policy filters throughout otherwise committed-only subscription code.

**Simpler form:** Have the engine adapter mount an actual `effect(() => node.handle.state)` and collect runs in the referee. Keep the oracle’s conceptual core-effect model, but compare it against the production kernel mechanism. Delete the bridge’s `newest` subscription variant, both flush implementations, reachability traversal, count, and related call sites. This removes **16 engine conditional sites** outright and simplifies several remaining `policy === 'committed'` predicates.

**Cost:** Tests and benchmarks need a disposer/run counter outside the bridge. Timing differences may surface—but those would be differences in the real implementation currently hidden by the synthetic copy. Removing the exported bridge method is only safe if its “referee shape” comment reflects its actual support status.

**Verdict: QUESTION** — is `CosignalBridge.mountCoreEffect` supported for external low-level consumers, or strictly internal referee API?

### 2. The mount “fast path” is not fast and contaminates the oracle with optimization machinery

**What:** The oracle README says the fast path may skip comparison at [README.md:167](/Users/jitl/src/alien-signals-opt/packages/cosignal-oracle/README.md:167), while also claiming the oracle has no value-computation fast paths at [README.md:271](/Users/jitl/src/alien-signals-opt/packages/cosignal-oracle/README.md:271). Both implementations compute the fixup value before testing `fastOut`: [engine](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:5219), [oracle](/Users/jitl/src/alien-signals-opt/packages/cosignal-oracle/src/model.ts:1342). A passing fast path therefore suppresses correction; it does not skip comparison.

**Why complex:** This suppression rule requires `commitGen`, baseline capture, watcher `rootCommitGen`, mask clocks, token clocks, a second “covered” evaluation world, `excludeLiveTokens`, and four trace dispositions. Optimization-specific proof machinery is duplicated in the reference model.

**Simpler general forms:**

- Semantics-first: always perform the already-existing comparison and correct when changed. Delete all fast-out state and the audit world.
- Performance-first: test `fastOut` before evaluating and return immediately. Delete the audit evaluation, but accept that the soundness argument is no longer checked at runtime.

The semantics-first form removes **10 conditional sites across engine and oracle**, plus eight fast-out predicates and all `rootCommitGen`/baseline plumbing.

**Cost:** The semantics-first form can schedule an urgent correction where current behavior relies on an already-scheduled per-token corrective; that changes render count and trace expectations. It does not add a comparison—the current code already performs it—and it removes the occasional second audit evaluation. The performance-first form preserves intended behavior but discards a valuable invariant check.

**Verdict: TRADE**

### 3. Referee and tracing posture changes runtime semantics

**What:** [`__newBridgeForTest`](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:784) disables quiet writes because the oracle models always-receipt behavior. [`recomputeQuiet`](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:1604) also disables quiet mode whenever events are retained or a tracer is attached. The quiet-mode test explicitly acknowledges that lockstep exercises different semantics at [quiet-mode.spec.ts:10](/Users/jitl/src/alien-signals-opt/packages/cosignal/tests/quiet-mode.spec.ts:10). This conflicts with tracing’s “without perturbing” promise at [README.md:257](/Users/jitl/src/alien-signals-opt/packages/cosignal/README.md:257).

**Why complex:** `quietWrites` and `eventsOn` are diagnostic/test policy flags embedded in the execution mechanism. The main model comparison therefore does not cover the production bare-write path, and observing an application turns receipt-free writes into receipt-producing operations.

**Simpler form:** Model the quiet fold in the oracle. Run production and lockstep bridges with identical write semantics. Event retention and tracing observe whichever path executes; they do not select it. Delete `quietWrites`, `setQuietWrites`, the test setup override, and `!eventsOn` from quiet derivation.

**Branch count:** **0 `if` arms deleted**, but **2 independent semantic gates** collapse out of the engine. The oracle gains one explicit quiet-write branch.

**Cost:** Oracle snapshots/events and tests expecting fabricated receipt events while tracing must change. A trace attached during an idle write will observe a quiet fold rather than forcing a detailed receipt history.

**Verdict: TRADE**

### 4. `BridgeEvent` and `TraceHooks` are parallel diagnostic representations

**What:** The engine defines an object-shaped [`BridgeEvent`](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:607) stream and a second [`TraceHooks`](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:653) interface. [`log`](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:1844) optionally retains the object and forwards it to the tracer, whose [`event` switch](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/trace.ts:455) translates it back into packed scalars.

**Why complex:** Attaching a tracer enables `eventsOn`, so each event site constructs a `BridgeEvent` object before the tracer packs it. That directly contradicts the “recording an event allocates nothing” claim at [trace.ts:10](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/trace.ts:10). The inverse encoding is also reproduced in trace tests.

**Simpler general forms:**

- Allocation-first: one scalar diagnostic sink. The tracer packs directly; a referee sink materializes `ModelEvent` objects only in tests.
- Code-size-first: keep only `BridgeEvent`, remove dedicated hooks, and retract the zero-allocation guarantee.

The first form deletes the **18-case translation switch plus 3 `log` conditionals**. The 22 nullable event-site guards remain, but their object allocations disappear.

**Cost:** The allocation-first form requires a substantial trace/test-adapter rewrite and careful handling of string/value interning. The code-size-first form knowingly adds GC pressure while tracing.

**Verdict: TRADE**

### 5. Pass render state is stored simultaneously as sets and bitsets

**What:** [`Pass`](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:437) carries `maskSlots`, `capturedCommittedSlots`, `maskBits`, and `includedBits`. [`includedSet`](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:2204) reconstructs another set, while watcher snapshots copy both sets at [concurrent.ts:4296](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:4296) and [concurrent.ts:4687](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:4687).

**Why complex:** The same immutable render inclusion is represented three ways. Every mount/re-render allocates and copies sets even though the engine’s visibility and active-pass checks already use the 31-bit words.

**Simpler form:** In the engine, make `maskBits` and `includedBits` canonical. Build `includedBits` directly from `root.committedBits`; snapshots copy two numbers; iterate set bits when clocks must be inspected. Keep the oracle’s `Set` representation—it is clearer there and preserves implementation independence.

**Branch count:** **0**; this is representation and allocation simplification.

**Cost:** Bit iteration is less immediately readable. Snapshot-oriented tests change. The fixed 31-slot invariant already establishes that one integer word is sufficient. Behavior is unchanged and allocations decrease.

**Verdict: SAFE-SIMPLIFICATION**

### 6. `ActionScope` duplicates the normal write-classification mechanism

**What:** [`ActionScope`](/Users/jitl/src/alien-signals-opt/packages/cosignal-react/src/hooks.ts:339) manually provides `set` and `dispatch`, each constructing an `Op`. The operation then passes through [`Shim.scopeWrite`](/Users/jitl/src/alien-signals-opt/packages/cosignal-react/src/shim.ts:588), [`CosignalBridge.scopeWrite`](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:3959), the oracle equivalent at [model.ts:684](/Users/jitl/src/alien-signals-opt/packages/cosignal-oracle/src/model.ts:684), and a dedicated schedule operation.

**Why complex:** “Run ordinary writes in this batch” is represented as separate methods per write kind. It omits `update`, reconstructs reducer dispatch manually, and threads a special operation through every layer despite the normal classifier already understanding set/update/dispatch.

**Simpler form:** Expose `scope.run(fn)`. Inline the action/live-token checks once, then call [`unstable_runInBatch`](/Users/jitl/src/alien-signals-opt/packages/cosignal-react/types/react-fork.d.ts:36) and let ordinary `atom.set/update/dispatch` use the existing write classifier.

This removes **8 current conditional/switch sites**; two action/liveness checks reappear once in `run`, for a net reduction of **6**.

**Cost:** Breaking API change; users add a callback boundary. There is one `unstable_runInBatch` call per invocation, though several writes can share it. React tests must confirm settled scopes still throw instead of taking the protocol’s urgent fallback.

**Verdict: TRADE**

### 7. The oracle differ materializes the complete expected run before comparing

**What:** [`diffAgainstModel`](/Users/jitl/src/alien-signals-opt/packages/cosignal-oracle/src/adapter.ts:83) calls [`runScheduleStepwise`](/Users/jitl/src/alien-signals-opt/packages/cosignal-oracle/src/adapter.ts:105), which uses `ops.map` to retain every JSON snapshot and event string before running the engine.

**Why complex:** This creates an intermediate representation with peak memory proportional to the entire schedule times snapshot size, although comparison stops at the first divergence.

**Simpler form:** Instantiate the reference model beside the engine, apply one operation to each, and compare the current snapshot/events immediately. Delete `StepRecord`, `runScheduleStepwise`, and the full result array.

**Branch count:** **0**.

**Cost:** None observable. Failure location and messages remain identical; peak memory falls to the current model/engine state plus one comparison.

**Verdict: SAFE-SIMPLIFICATION**

### 8. `checkDirty` duplicates its general algorithm with shape-specific arms

**What:** [`checkDirty`](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/index.ts:766) handles shallow, directly dirty, two-level, and chain shapes before falling through to [`checkDirtyLoop`](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/index.ts:909). [`chainCheck`](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/index.ts:865) is another traversal specialized for one-dependency/one-subscriber chains.

**Why complex:** The maintainer must prove three implementations mutate dirty/pending flags and survive reentrant disposal identically. The comments provide measured rationale, but the permitted validation did not include a benchmark capable of verifying it here.

**Simpler form:** Retain the small `try/finally` wrapper and always call `checkDirtyLoop`; keep `updateAndShallow`, which the general loop genuinely shares. This deletes **18 conditional sites**.

**Cost:** The source claims shallow cones improved from roughly 1.05–1.3× to 0.9–1.1× versus upstream and that splitting preserves V8 inlining. Removing these paths should require equivalent current benchmarks and bytecode-size checks, not just correctness tests.

**Verdict: TRADE**

### 9. Oracle `priority` is a phantom scheduling dimension

**What:** Tokens store a [`Priority`](/Users/jitl/src/alien-signals-opt/packages/cosignal-oracle/src/model.ts:28), schedules generate it at [schedule.ts:207](/Users/jitl/src/alien-signals-opt/packages/cosignal-oracle/src/schedule.ts:207), but the engine adapter explicitly discards it at [oracle-adapter.ts:126](/Users/jitl/src/alien-signals-opt/packages/cosignal/tests/oracle-adapter.ts:126). Nothing in the model reads it after token construction.

**Why complex:** It makes generated schedules appear to test priority semantics that neither engine nor model implements. Actual lane policy belongs to the React protocol token.

**Simpler form:** Remove `Priority`, `Token.priority`, the `openBatch` parameter, schedule field, generator choice, and the lone metadata assertion.

**Branch count:** **0**.

**Cost:** The fuzz corpus loses a dimension that currently has no effect.

**Verdict: SAFE-SIMPLIFICATION**

### 10. Retirement’s `committed` flag is diagnostic metadata threaded as engine policy

**What:** [`Token.committedFlag`](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:401) is assigned but never read. The boolean is passed through the React callback, shim, `retire`, `settleAction`, `retireInternal`, oracle schedule/model, `BridgeEvent`, and trace encoding. Both boolean values execute identical retirement semantics.

**Why complex:** A host-reported diagnostic fact looks like a semantic choice at every layer, inviting future branches that would incorrectly make abandoned writes revert.

**Simpler form:** Engine/model retirement is simply `retire(tokenId)`. If the React outcome remains useful, keep it at the adapter/diagnostic boundary instead of storing it on tokens and threading it through semantic methods.

**Branch count:** **0 semantic branches**; deleting the trace flag removes **1 conditional expression**. Roughly a dozen fields/parameters/call arguments disappear.

**Cost:** Dropping it entirely removes the trace distinction between “committed work” and “no React work.” Preserving that distinction requires a small adapter-side diagnostic seam.

**Verdict: TRADE**

### 11. The React shim stores protocol state it never consults

**What:** `RootRec.lineageId`, `RootRec.lastCommitGeneration`, and `rootsById` are declared at [shim.ts:114](/Users/jitl/src/alien-signals-opt/packages/cosignal-react/src/shim.ts:114) and [shim.ts:146](/Users/jitl/src/alien-signals-opt/packages/cosignal-react/src/shim.ts:146), then only assigned at [shim.ts:349](/Users/jitl/src/alien-signals-opt/packages/cosignal-react/src/shim.ts:349) and [shim.ts:469](/Users/jitl/src/alien-signals-opt/packages/cosignal-react/src/shim.ts:469).

**Why complex:** They imply lineage/generation-based decisions that do not exist and maintain a second root index beside `rootByContainer`.

**Simpler form:** Ignore the two extra callback arguments, remove both fields and their assignments, and remove the write-only `rootsById` map.

**Branch count:** **0**; three pieces of state and two parameter hops disappear.

**Cost:** None in current behavior. All state is private and unread.

**Verdict: SAFE-SIMPLIFICATION**

## Already minimal

- The packed kernel record layout and in-place traversal loops are purposeful; replacing them with object graphs or array combinators would worsen allocation and locality.
- The single host-write classifier in [`Shim.classifyWrite`](/Users/jitl/src/alien-signals-opt/packages/cosignal-react/src/shim.ts:537) is the right policy boundary. `ActionScope` is the exception that should converge onto it.
- Direct bridge listeners for delivery/correction avoid making the React adapter consume diagnostic objects; that separation should remain.
- The oracle’s independent full recomputation is useful duplication. Sharing engine caches, arena code, or visibility implementations would weaken it as a referee.
- `graphviz.ts`, the public barrel files, and the basic Atom/Computed/Reducer wrappers are already small and direct.

## Validation

All permitted checks passed:

- `cosignal`: 314 passed, 1 skipped.
- `cosignal-react`: 62 passed.
- `cosignal-oracle`: 81 passed, 1 skipped.
- TypeScript `--noEmit`: all three packages passed.
- Harness conformance: 179 passed for `cosignal`; 179 passed for `cosignal-concurrent`.