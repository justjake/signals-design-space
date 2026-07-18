# Adversarial correctness review: Lean challenger

## Findings

### 1. BLOCKER — Root lock-in commits future writes from an already-committed token (architectural)

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | setup | Root A has committed `a=0`. Async transition T remains live across an unresolved `await`. |
| 2 | T / M2, M5 | T writes `a=1` at `seq1`; A renders a pass pinned at `seq1`. |
| 3 | root commit / M2, M6 | A commits that pass. `locked[A]` stores the full token T. |
| 4 | async continuation / M8, M2 | After the `await`, the carrier restores T and writes `a=2` at `seq2`. M5 queues A’s second render in T’s lanes, but it has not committed. |
| 5 | urgent render / M4 | An urgent U render excludes T’s pending lanes. The library nevertheless unions `locked[A]`, making T included without a write cutoff. M2 therefore admits both `seq1` and `seq2`; M4 may even select `ACTIVE_NEWEST`. |
| 6 | wrong outcome | U renders or `useSignalEffect` observes `a=2` before A’s second T update commits. The committed-for-A value should still be `1`. |

The root-consistency induction incorrectly treats token membership as an immutable committed prefix. Async continuations make token contents mutable after a root has committed them.

Repair requires per-root `(token, committedWriteSeq)` watermarks taken from the winning frame, separate rules for a locked prefix versus a currently included token, and corresponding changes to view revisions, `ACTIVE_NEWEST`, effects, and retirement. The central M2 visibility equation must change.

### 2. BLOCKER — A winning root pass does not prove every evaluated subtree committed (architectural)

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | render / M4, M7 | Component X reads existing computed `c`, which succeeds with `ctx.previous === undefined` and stages result `1`. X then throws to an error boundary. |
| 2 | boundary recovery | React abandons X, renders the fallback, and completes the same root pass P. |
| 3 | root commit / M6, M7 | `rootCommit(P)` publishes every `stagedPrevious` value from P because P is the named winning frame. |
| 4 | retry | The boundary resets and X is retried after a real invalidation. The same `c` receives speculative `previous=1` and produces `2`. |
| 5 | wrong outcome | X’s first actually committed result is `2`; it should be `1` because the earlier evaluation belonged only to an abandoned subtree. |

The same granularity error promotes fresh staged nodes from suspended or errored subtrees merely because their root pass committed a fallback. Repeating such attempts can also permanently leak arena records.

A pass ID is insufficient commit ownership. Publication and promotion need component/hook-level commit membership or an equivalent staged-read ownership mechanism.

### 3. BLOCKER — Changes after `renderLeave(complete)` are never flushed for provisional watchers (local fix)

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | render / M4 | A fresh component W reads `a=0`. Its watcher is provisional in frame P. |
| 2 | completion / M4 | `renderLeave(complete)` flushes the currently recorded catch-up tokens, which are empty. P remains retained until commit. |
| 3 | pre-commit write / M2, M5 | T writes `a=1`. The retained-frame edge reaches W, but M5 only appends T to P’s `catchupTokens` because W is uncommitted. |
| 4 | commit | No second `renderLeave` occurs, so that token is never dispatched. React commits P’s stale `a=0` DOM. |
| 5 | wrong outcome | M6’s layout fixup causes a second urgent commit, potentially after another layout effect observes the torn DOM. C10 requires the pre-commit update to invalidate P and produce one commit. |

M5 must distinguish open/yielded frames from completed frames. A completed frame’s provisional dispatcher must run immediately through `runInBatch`, with urgent fallback if retirement wins.

### 4. BLOCKER — Once-per-pass memoization is stale across React render-phase rerenders (local fix)

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | first invocation / M4 | Component C has React state `n=0`; `useComputed(() => n, [n])` evaluates to `0`, leaving its node memo `DONE`. |
| 2 | React render-phase update | C calls its own `setN(1)`. React restarts C within the same root render pass P. |
| 3 | second invocation | `useComputed` stages a new closure and deps `[1]`, but M4 promises at most one evaluation per `(pass,node)` and finds the existing `DONE` memo. |
| 4 | wrong outcome | React commits `n=1` while the computed value remains `0`. M5’s commit-time function replacement is too late to repair the rendered frame. |

Memo identity must include the staged function/reducer version, with dependency, resource-position, and staged-previous bookkeeping reset when that version changes inside a pass.

### 5. BLOCKER — `ACTIVE_NEWEST` ignores root/lineage-dependent evaluation inputs (local fix with performance impact)

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | setup | Shared computed `c` evaluates `x + (ctx.previous ?? 0)`. Earlier legal root skew established `previous[A]=1` and `previous[B]=10`. |
| 2 | invalidation | A later atom change makes both roots’ current atom view `x=5` and invalidates `c`. |
| 3 | non-render read / K0 | A core read computes one clean K0 value under M7’s distinguished NEWEST lineage. |
| 4 | root renders / M4 | A and B each start with every live record included and unchanged `eventSeq`. `ACTIVE_NEWEST` copies the same clean K0 box into both frames without evaluating their root-specific `ctx.previous`. |
| 5 | wrong outcome | Correct values are `6` for A and `15` for B; one shared K0 box cannot satisfy both. |

A clean K0 suspension box has the analogous problem: copying it bypasses the render lineage’s M7 identity. The closed change-source audit names committed `previous` and resource status as inputs, but the K0 fast-path predicate checks neither.

Nodes that consume `ctx.previous` or `ctx.use` must be excluded from this fast path or carry a proven lineage-independent cache flag. That restriction must be re-run through the quiet-render performance gate.

### 6. BLOCKER — A late thenable settlement can target a reclaimed M7 record (local fix)

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | resource revision r1 / M7 | Pending promise `p1` owns arena record S. |
| 2 | new revision | An included write creates r2. Once no frame references r1, M7 explicitly reclaims S and its payload even though `p1` is unresolved. |
| 3 | reuse | The arena reuses S for revision r3. |
| 4 | late settlement | `p1` settles. Its callback must record `settledAt`, status, and result, but the design gives that callback no generation or exact-identity guard. |
| 5 | wrong outcome | The callback overwrites r3, returns `p1`’s result for the wrong world, or dereferences reclaimed payload state. |

The counter inventory protects staged/promoted wrapper handles, not M7 settlement handles. Either pending records must remain unrecycled until settlement or callbacks must carry and validate a resource generation/key before touching the arena.

### 7. BLOCKER — Positional caching cannot prevent eager thenable creation on the settlement retry (architectural API issue)

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | first evaluation | `fn(ctx) { return ctx.use(countedFetch()); }` evaluates `countedFetch()` first, creating `p1`; M7 stores it and suspends. |
| 2 | settlement | `p1` settles. |
| 3 | required retry / M7 | M7 re-invokes `fn` once to finish the computation. JavaScript evaluates `countedFetch()` before calling `ctx.use`, creating `p2`. |
| 4 | wrong outcome | M7 can return `p1`’s settled result, but it cannot undo `p2`’s second request or prevent a later unhandled rejection. The claimed “cannot initiate another fetch” property is false. |

The API must accept a lazy factory/resource key, or explicitly require callers to supply externally cached thenables and withdraw the no-refetch guarantee.

### 8. HIGH — Replay does not define custom equality per view (local fix)

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | setup | `a=A(group=0,id=A)` with equality by `group`. |
| 2 | T write | T sets `B(group=1,id=B)`; B becomes K0’s stable value. |
| 3 | U write | U sets `C(group=1,id=C)`, equal to K0’s B. The receipt is correctly retained. |
| 4 | U-only view / M2 | Starting from A, C is unequal and must become the value, so this view should return C. |
| 5 | T+U view / M2 | After applying B, C compares equal and must retain stable B, matching K0. |
| 6 | wrong outcome | M2’s stated “set replaces the accumulator” returns C for T+U. Storing K0’s stabilized B instead would return B incorrectly for U-only. Applying equality only after the fold cannot recover both representatives. |

Each replayed set, updater result, and reducer result must apply the signal’s equality against that view’s current accumulator while retaining the raw operation payload.

### 9. MEDIUM — Discarded-pass K1 edges observably change later render counts (architectural)

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | speculative pass / M3 | With `c = flag ? a : b`, a pass reads the `flag=true` branch and inserts K1 edge `a→c`, then is discarded. |
| 2 | convergence | Later writes leave every extant view at `flag=false`; K0 retracks to `flag,b`. An unrelated live token prevents episode reset, so the discarded K1 edge remains. |
| 3 | irrelevant write / M5 | A later write to `a` traverses the stale K1 edge and synchronously calls W’s setter even though no live view uses `a`. |
| 4 | wrong outcome | W executes an extra render solely because a discarded render mutated K1. This contradicts C14 and the claim that retained K1 over-reach does not affect observed counts. |

This does not corrupt values, but it makes speculative graph mutation observable. Fixing it requires pass ownership/removal for K1 edges or weakening the stated C14 guarantee.

## Verified held

- I could not break C1’s divergent-dependency delivery once the non-newest evaluation has inserted its K1 edges; union traversal avoids the canonical-topology scars.
- With default equality and immutable token contents, always-logged receipts plus write/retirement pins correctly handle C2, C3, and C8.
- Fresh M5 walk tickets correctly prevent C4/C5’s once-stale notification loss.
- Synchronous writer-context setter calls preserve C6’s nested batch/transition attribution.
- Explicit yield leave/resume edges correctly handle C7’s event-handler gap; the pass view remains pinned while handlers use newest state.
- `committed=false` retirement persists store-only writes, so the S4/C12 drop-on-abort failure is absent.
- Full token identities and retirement-before-lock-removal avoid recyclable lane-mask aliasing.
- Conditional on receiving complete protocol facts, lane bits, fibers, and update queues remain behind the fork boundary, so ordinary lane or work-loop refactors would remain adapter-only changes.

## Verdict

This design is not implementation-ready. The root lock-in and pass-wide publication models omit committed-content and committed-subtree facts, so the current visibility equation and fork seam permit torn commits and publication of speculative state. Because repairing them changes the central M2/M4/M6/M7 protocol—and the remaining blockers still require semantic repairs—the design is architecturally unsound in its present form.