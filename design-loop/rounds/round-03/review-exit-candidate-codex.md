# Review: Round 3 exit candidate

## 1. F8 does not capture tokens at async-resource creation

**Severity: BLOCKER. Fix class: architectural.**

The transform captures `currentToken` when an async function is invoked, despite claiming capture when the async resource is created ([§12.1](/Users/jitl/src/alien-signals-opt/design-loop/rounds/round-03/design-exit-candidate.md:632)).

**Failing schedule**

Setup: rung 2 is active, the boot probe passes, all application async functions are transformed, `a=0`, and `secondGate` remains pending.

```ts
startTransition(async () => {
  await new Promise<void>(resolve => {
    setTimeout(async () => {
      a.set(1)
      resolve()
    }, 0)
  })
  await secondGate
})
```

1. The timer callback object is created while the outer driver has pushed token T.
2. The specified transform captures nothing at function-object creation.
3. The timer later invokes the callback outside any driver; `currentToken === null` while `armedActions > 0`.
4. Its wrapper chooses `genBody`, but generator instantiation captures `t = null`; the first `gen.next()` therefore also runs with null.
5. `a.set(1)` is classified into ambient default batch D. The outer action remains pending on `secondGate`.
6. D can render and retire, exposing `a=1` before T settles.

**Wrong observable outcome:** an application write performed by a fully transformed async callback commits before its enclosing action settles, violating C12. The written carrier induction is false: creating an async function during a bracketed span does not execute the wrapper or capture its token, and the single-function boot probe cannot detect this composition.

## 2. The shipped mixed boundary knowingly violates the frozen C12 contract

**Severity: BLOCKER. Fix class: architectural.**

The support matrix calls rung 2 “full support” while [§12.5](/Users/jitl/src/alien-signals-opt/design-loop/rounds/round-03/design-exit-candidate.md:732) explicitly permits early commitment.

**Failing schedule**

Setup: transformed application code calls an untransformed vendor function:

```ts
async function vendorSave() {
  await firstGate
  a.set(9)
  await secondGate
}

startTransition(async () => {
  await vendorSave()
})
```

1. T is parked on the outer returned thenable.
2. `vendorSave` resumes after `firstGate` without the carrier and writes under default token D.
3. D retires while `secondGate` keeps T pending.
4. Committed readers and watchers observe `a=9`; the runtime only emits the documented warning.

**Wrong observable outcome:** the action’s write becomes committed before the action settles, exactly the failure forbidden by [C12](/Users/jitl/src/alien-signals-opt/design-loop/SEEDS/correctness-cases.md:213). A warning is neither correctness nor the preamble’s permitted interface restriction, which requires a reliable runtime rejection; the candidate itself concedes that such rejection is impossible at this boundary.

## 3. Compiled continuations can retain a token beyond its retirement

**Severity: BLOCKER. Fix class: architectural.**

The lifecycle inventory clears action state at settlement, but transformed generators can still retain the captured token ([§12.2](/Users/jitl/src/alien-signals-opt/design-loop/rounds/round-03/design-exit-candidate.md:668)).

**Failing schedule**

```ts
async function child() {
  await childGate
  a.set(2)
}

startTransition(async () => {
  void child()
  a.set(1)
})
```

1. `child()` is invoked under T and its generated driver captures T.
2. The outer callback does not await the child and settles.
3. F3 retires T exactly once, folds its receipts, clears its slot bookkeeping, and releases the slot.
4. `childGate` resolves later; the child driver pushes the now-retired T.
5. `a.set(2)` takes T from the carrier and calls `internSlot(T)`.

**Wrong observable outcome:** no specified path can commit this ordinary write. Rejecting the retired token crashes the continuation; re-interning it creates a receipt for a token that will never receive another F3 retirement; resolving it through a recycled slot risks cross-token contamination. The carrier needs an explicit post-settlement policy—liveness fallback, resource refcounting, or a detectable restriction—and corresponding slot-reuse invariants.

## 4. Invariant R cannot represent untracked world sensitivity

**Severity: BLOCKER. Fix class: architectural.**

K1 has only one edge kind, used for routing, invalidation, and notification. An untracked read must not create that dependency, but without an edge the proof in [Invariant R](/Users/jitl/src/alien-signals-opt/design-loop/rounds/round-03/design-exit-candidate.md:351) is false.

**Failing schedule**

Setup: `a=0`, `b=0`, and `c = b.state + untracked(() => a.state)`. K0 has cached `c=0` and only `b→c`.

1. Deferred T writes `a=1`. Because `a` is untracked by `c`, the walk cannot reach `c`; `TS(c)` gains no T bit.
2. U writes `b=1`. U’s render excludes T and world-evaluates `c` as `1 + 0 = 1`.
3. U retires and its slot sweep removes U’s bit from `c`; T remains live.
4. A non-pass NEWEST read pulls K0, producing and caching `c=1+1=2`; `CT(c)` is now true.
5. An unrelated sync render excludes T and reads `c`. Since `TS(c)==0 && CT(c)`, the fast path serves K0’s `2`.
6. That render’s actual world evaluation would produce `b=1`, `a=0`, hence `c=1`.

**Wrong observable outcome:** the sync frame receives `c=2` for a world where `c=1`. Recording `a→c` in K1 instead is not a repair: writes to `a` would then notify and invalidate `c`, violating the definition of an untracked read. A distinct routing-sensitivity representation is required.

## 5. Staged evaluators are incompatible with the RENDER_NEWEST direct path

**Severity: BLOCKER. Fix class: local fix.**

[§6.1](/Users/jitl/src/alien-signals-opt/design-loop/rounds/round-03/design-exit-candidate.md:335) says RENDER_NEWEST reads directly from K0, while [§11.1](/Users/jitl/src/alien-signals-opt/design-loop/rounds/round-03/design-exit-candidate.md:535) says a pass must use its staged evaluator.

**Failing schedule**

Setup: no receipts are live; K0 has a clean cached `c=0` under committed evaluator `fA`; React state selects a new evaluator `fB` that returns `1`.

1. A React-only update starts a pass, classified RENDER_NEWEST because no receipts exist.
2. `useComputed` stages `fB` without changing K0’s committed evaluator or cache.
3. The component reads `c`.
4. The stated RENDER_NEWEST path serves clean K0 state, evaluating neither `fB` nor a per-pass memo.

**Wrong observable outcome:** the update renders and can commit `0` instead of `1`. Evaluating K0 with `fB` is also unsound because it publishes an uncommitted closure, topology, and value that survive interruption or discard; staged nodes need an explicit per-pass path even when their value-world equals NEWEST.

## 6. The validity ladder returns before checking evaluator identity

**Severity: BLOCKER. Fix class: local fix.**

The validity table calls `fnStamp` a conjunct, but [§8.2](/Users/jitl/src/alien-signals-opt/design-loop/rounds/round-03/design-exit-candidate.md:464) says successful slot-clock checks immediately serve the memo.

**Failing schedule**

Setup: T has touched computed `c`, so pass P uses `M(c,wP)`; `c` computes `x + localState`.

1. P evaluates with `localState=0`, stages `f0`, and stores `M(c,wP)=1`.
2. A render-phase state update causes React’s same-pass hook rerender.
3. The hook stages `f1` with a new `fnStamp`; no signal write or retirement occurs.
4. The world key, episode, and slot clocks are unchanged.
5. Reading `c` reaches DONE; ladder step 2 passes and serves `1` without comparing `fnStamp`.
6. `f1` should produce `2`.

**Wrong observable outcome:** the same pass commits a value from its discarded closure, contradicting the candidate’s C14 walk. Effective evaluator stamps, including relevant nested evaluators, must be checked before any clock-based early return.

## 7. K0∪K1 can be cyclic, but full notification walks have no termination mechanism

**Severity: BLOCKER. Fix class: local fix.**

The design specifies value-blind full-reach walks with no pruning or cross-walk marks ([§10](/Users/jitl/src/alien-signals-opt/design-loop/rounds/round-03/design-exit-candidate.md:507)); the closed state inventory contains no per-walk visitation state.

**Failing schedule**

Setup:

```ts
c = flag ? d : a
d = flag ? b : c
```

1. With `flag=false`, evaluating `d` records `a→c→d`; this world is acyclic.
2. T makes `flag=true`; evaluating `c` records `b→d→c`; this world is also acyclic.
3. K1 is union/add-only, while the old `c→d` edge remains in K0 or is mirrored by E-PRESERVE. Consequently K0∪K1 contains `c→d→c`.
4. J writes `b`. The notification walk follows `b→d→c→d→c…`.

**Wrong observable outcome:** the write loops or overflows before notification completes. The slot bit cannot double as visitation state because later writes in the same slot must traverse already-touched nodes after watcher re-arm; a per-write visited generation or equivalent is required, including allocation cost and wraparound lifecycle tests.

## Verified held

- Always-logging plus downstream touched bits correctly handles C2’s atom/computed flushSync tear.
- Stepwise receipt replay preserves C3’s `4`, plain-set overwrite behavior, and per-world custom-equality representatives.
- For tracked dependencies and acyclic union graphs, K1 edge recording, slot clocks, and retroactive edge-add delivery close C1 and the HX-3 bailout schedule.
- Yield-time binding pop/resume plus RENDER_NEWEST demotion preserves C7’s pinned pass values.
- Pin-blocked compaction and watermarked per-root lock-in preserve the value-level C11 and C11-W schedules, assuming writes are first attributed to the correct live token.
- `visStamp` closes the older-entry-below-newer-max invalidation hole in committed effect snapshots and suspense prefixes.
- Lineage identity plus flattened content prefixes survived retries, unrelated retirements, settlement races, and multi-batch/single-batch Suspense views.
- The late-subscription `runInBatch` correction and committed compare cover the stated C10 render-to-layout races, assuming F4’s fork obligation.

## Verdict

This candidate is architecturally unsound as written. The receipt/rebase and per-root visibility core is promising, but the async carrier and untracked-read model violate frozen correctness contracts, while the traversal and evaluator defects independently permit hangs or wrong committed values. It should not enter implementation until those representations and lifecycle rules are redesigned and every schedule above is added to the battery.

