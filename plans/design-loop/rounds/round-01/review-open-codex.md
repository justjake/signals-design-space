# Adversarial review: exact projection worlds

## Findings

### 1. `ctx.previous` is absent from memo validity

**Severity:** BLOCKER  
**Fix:** architectural

Schedule:

1. Let `c = x.state + (ctx.previous ?? 0)`. In committed world V0, `x=0`; reading `c` produces `0`.
2. Deferred T sets `x=1`. T’s base is V0, so its correct `c` is `1`; M3 caches a T-world memo whose only recorded dependency is `x=1`.
3. Urgent U also sets `x=1`. Its U-only world excludes T, so its `c` is also `1`; U commits and the committed base now has `c=1`.
4. T rebases. Its fold remains `x=1`, but its base world is now U’s committed world, so `ctx.previous=1` and the correct T value is `2`.
5. M3 re-verifies the old T memo. Its recorded dependency `x` is still boxed as `1`, so section 6.2 aliases the old output box `1` without running the function.

The rebased T render returns `1` instead of `2`. The “complete dependency list” construction is incomplete because `ctx.previous` is an unrecorded semantic input; it must participate in memo validity and retirement-driven projection reconciliation.

### 2. Late subscription checks only singleton batches

**Severity:** BLOCKER  
**Fix:** architectural

Schedule:

1. Committed state is `a=false`, `b=false`; `c = a && b`. W is not mounted.
2. T1 sets `a=true`; T2 sets `b=true`. Both also carry React work elsewhere, so both tokens remain live. With no W or render consumer, neither write creates a frontier for W.
3. An urgent render mounts W while excluding T1 and T2. W renders `c=false`.
4. M6’s layout check evaluates each live token independently: base+T1 is `false`, and base+T2 is `false`. It therefore enqueues W in neither batch.
5. React later renders T1 and T2 together, which C1/T7 explicitly permits. Other fibers carry both lanes, but W has no update in either lane and may be reused without rendering.
6. The combined world has `a=true`, `b=true`, so `c=true`, while W’s committed DOM remains `false`.

This is a torn combined-batch commit. Checking one token at a time cannot detect interactions that appear only in an included-token set; M6 needs the actual live owner/include sets or a sound conservative entanglement rule.

### 3. Head-equivalent React evaluation permits render-phase writes

**Severity:** BLOCKER  
**Fix:** local fix

Schedule:

1. Set `configure({forbidWritesInComputeds:false})`.
2. With no pending receipts, a React pass is head-equivalent and reads a previously unevaluated global `Computed`.
3. M1 routes it through the canonical head kernel.
4. Its function executes `b.update(x => x + 1)`. Section 4.3 permits writes in head evaluation; only sparse-world evaluation installs the strict render-write guard.
5. M2 claims a batch, appends a receipt, and mutates the head. React then discards or StrictMode-replays the render.

The discarded render permanently changes `b`, and replay can repeat the write. The speculative-purity construction and C14 walk cover only the sparse path; head-alias evaluation must also reject writes before `claimWrite`.

### 4. Equality frontiers lose their only live owner at retirement

**Severity:** BLOCKER  
**Fix:** local fix

Schedule:

1. Cache `c = flag ? a : b` in the committed head with `flag=false`, `a=b=0`; W’s current topology contains `b -> c`.
2. T sets `flag=true`. M4 evaluates and retains an equal after-frontier containing `a -> c`, but correctly sends no `setState`.
3. T retires without W rendering. M3 removes T from the frontier’s owner set. Retirement reconciliation sees W’s rendered value still equals `0`, so it schedules nothing.
4. No rule promotes the ownerless after-frontier to W’s current committed graph. Under section 6.3 it is no longer live: no pass, live batch, layout check, or watcher owns it.
5. U sets `a=1`. The lazy head still has its old `b` topology, and W’s published graph also has only `b`; the released frontier was the only `a -> c` path.

W is not scheduled although committed `c=1`. The induction in section 7.2 covers writes but omits the retirement step that must transfer an equality-suppressed frontier into the watcher’s committed topology.

### 5. Head aliasing bypasses React’s positional Suspense cell

**Severity:** BLOCKER  
**Fix:** architectural

Schedule:

1. A global `Computed` reads a stable atom and calls `ctx.use(P1)`, where each fresh evaluation creates a new thenable.
2. An initial React pass is head-equivalent. Section 4.2 evaluates the existing computed through the canonical cache, so it suspends using the distinct non-React head cache described in section 10.
3. An unrelated transition D writes another atom and remains live. A retry of the first pass excludes D and is therefore non-head.
4. `P1` settles and pings React. The retry now enters M7’s sparse world, but no exact-world positional cell or lineage reference was created for `P1`.
5. The sparse evaluation calls the function again and obtains `P2`. If `P2` never settles, the component remains suspended despite `P1` having completed.

The head optimization contradicts the statement that a committed React world does not probe the head suspension cache. React reads may alias synchronous canonical results, but suspensions must be promoted into, or initially evaluated through, M7’s world/lineage cell.

### 6. `useReducerAtom` has no reducer-version semantics

**Severity:** BLOCKER  
**Fix:** architectural

Schedule:

1. Mount `useReducerAtom((state, action) => state + action * factor, 1)` with `factor=1`.
2. Deferred T dispatches action `1`.
3. Before T commits, urgent React work changes `factor` to `10` and commits.
4. T rebases. Side-by-side `useReducer` processes the queued action with the reducer supplied by the rebased render, producing `11`.
5. The design records only the action. Sections 5.1, 6.4, and 11.1 define no reducer stage/version in the receipt fold or world-record key.

Keeping the original reducer produces `2`; mutating one global reducer makes already-cached immutable worlds change meaning without changing their key. Reducer configuration must be staged per render lineage and included in fold/memo identity, or the API must explicitly forbid reducer changes—which would not provide the promised `useReducer` parity.

### 7. Retirement-ticket exhaustion occurs after an irreversible commit

**Severity:** BLOCKER  
**Fix:** architectural

Schedule:

1. Use the required forced-small counter build and keep a suspended lineage alive so the episode cannot reset.
2. Retire enough batches to exhaust the `(era,low)` retirement-ticket space.
3. Batch K then renders and commits its signal value to the DOM.
4. After mutation and layout, the fork invokes `onBatchRetire(K)`.
5. Section 12 requires retirement to refuse before changing visibility because an old world remains open.
6. React has nevertheless completed K and will no longer include its token. The receipt has no retirement sequence, so a subsequent pass that does not include K reads the pre-K value.

The DOM and signal committed world now disagree, or the commit path crashes after mutation. Retirement capacity must be reserved before React crosses the commit boundary, or retirement identifiers must have a non-failing extension path.

### 8. Settlement does not invalidate every aliased suspended memo

**Severity:** HIGH  
**Fix:** local fix

Schedule:

1. World W1 evaluates `c`, suspends on P, and publishes suspended memo M1.
2. An unrelated retirement creates W2. All recorded dependencies of `c` are equal, so M3 aliases M1’s cell and suspension box into memo M2.
3. Both lineages remain live.
4. P settles. Section 10 marks “the sparse memo” retryable and retries every owning lineage.
5. If only M1 is marked, W2’s retry hits still-suspended M2 and rethrows its cached suspension instead of running through the settled cell.

A shared cell needs an intrusive list of every aliased suspended memo, or every cache hit must consult shared settlement state. Retrying all lineages is insufficient if their memo records remain cached as suspended.

### 9. An abandoned never-settling thenable prevents quiescence forever

**Severity:** HIGH  
**Fix:** local fix

Schedule:

1. A speculative transition creates a sparse Suspense cell for a promise that never settles.
2. React discards the pass and lineage, and its token retires. No watcher or projection frontier refers to the cell.
3. Section 10 nevertheless retains the cell until its “pending-thenable ref” releases.
4. Because the promise never settles, section 5.2’s quiescence condition is never reached.
5. Receipts and sequences accumulate indefinitely; eventually an arena or semantic counter exhausts and a later write fails.

The registered continuation already carries a generation check, so the cell should be reclaimable when its last pass/lineage/frontier owner disappears; a later settlement can safely become a no-op.

### 10. The observed-count counter has no wrap rule

**Severity:** MEDIUM  
**Fix:** local fix

Schedule:

1. Compile the required forced-small-counter configuration with a three-bit observed count.
2. Mount eight committed watchers on one atom before its lifecycle microtask runs.
3. The integer observed count wraps to zero.
4. The microtask compares zero with the stopped resource state and does not run `options.effect`.

The atom is observed but its resource never starts. Section 12 claims to inventory every semantic counter, yet omits observed counts; the same audit should cover reference counts and attachment generations.

## Verified held

- Exact receipt visibility handles C2’s default-batch exclusion without falling back to the head computed cache.
- Global write-order replay preserves C3’s `4`, replacing-set behavior, and independent equal receipts in C8.
- While a frontier remains live, real per-world edges handle C1’s divergent dependency and C5’s equal first write followed by an effective same-batch write.
- Per-write delivery avoids C4’s persistent-staleness dedup failure and preserves C6’s urgent/deferred attribution.
- The call-stack pass binding, paired `YIELD`/`RESUME`, and detach-before-append rule satisfy C7.
- Active-world routing for fresh staged nodes satisfies C9 on the first render.
- M6’s single-token late-join path satisfies C10, including the retired-token pre-paint fallback; finding 2 is specifically the unhandled multi-token interaction.
- Loud second-root rejection satisfies the declared C11 scope without leaking lane or Fiber internals across the seam.
- Always-persistent retirement, including `committed=false` and async parking, satisfies C12.
- Exact multi-token world tuples avoid the single-token and pass-serial key failures in C15 when evaluation begins on the sparse path.
- Token-scoped committed effect queues satisfy C16’s applied-but-uncommitted exclusion.
- Omitting truncation cleanly resolves C17.
- Hash identity is verified field-by-field, and the receipt/world episode fields prevent ordinary hash or slot reuse from establishing false identity.

## Verdict

This design is repairable, but it is not implementation-ready. The receipt fold, per-world topology, and yield-scoped protocol are strong, yet the current cache inputs, late-join rule, head alias, frontier ownership, and retirement lifecycle admit wrong values, torn commits, persistent render writes, and post-commit failure. M3, M6, M7, and the fork retirement contract need revised invariants before implementation begins.