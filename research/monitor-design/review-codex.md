# Adversarial correctness review: `research/monitor-design/DESIGN.md`

## Findings

### 1. BLOCKER — architectural — A dependency discovered after a write receives no retrospective notification

This repeats scar S35 and defeats §7’s claim that no reconcile/refresh mechanism is needed.

Setup: `flag=false, a=0, b=0`, `c = flag ? a : b`, with watcher W. K0 and the initial K1 topology contain `flag→c` and `b→c`, but not `a→c`.

1. Deferred K writes `flag=true`; W is scheduled through the existing `flag→c` edge.
2. Pass P starts with pin p and includes K, then yields before W evaluates `c`.
3. Default batch D writes `a=1` after p. Neither K0 nor K1 yet has `a→c`, so D cannot reach W.
4. D retires. K0 folds `a=1`; D’s touched-list flush runs while W still has no dependency on `a`.
5. P resumes. Its pin excludes D, so its pass memo evaluates `c=0` through `a=0`, discovering the dependency only inside the pass.
6. P commits and locks K into root R. R’s committed world now includes retired D plus K, so its correct value is `c=1`, while the committed subtree contains `c=0`.

The dependency was learned after every D notification point had passed, and pass memos are not delivery topology. Repair requires commit-time watcher reconciliation or another durable per-world reach mechanism; K1 alone cannot fix it.

### 2. BLOCKER — architectural — K1 represents HEAD, not arbitrary pass masks

The first-divergence induction compares BASE with HEAD only. It provides no construction for PASS worlds or per-root committed subsets, despite claiming that two kernels cover the entire divergent-dependency family.

Setup is the same branch computed.

1. T1 writes `flag=true`; before any head evaluation, T2 writes `flag=false`.
2. BASE and HEAD both take the `b` branch, so neither K0 nor K1 contains `a→c`.
3. Pass P renders mask `{T1}`. It sees `flag=true`, reads `a=0`, and finishes W with `c=0`. The dependency exists only in P’s memo.
4. Before P commits, urgent U writes `a=1`. Even assuming U is correctly mirrored into K1, neither engine has an `a→c` edge, so W receives no U update.
5. U retires and P commits while T2 remains excluded.
6. The root’s committed world is retired U plus T1: `flag=true, a=1, c=1`; its DOM contains `c=0`.

This attacks C1-T7 beyond mere value replay: replay calculates subset values, but no engine represents the subset’s notification topology. Effects evaluated in `committed-for-root` subsets have the same uncovered dependency problem.

### 3. BLOCKER — architectural — Ambient post-`await` writes still violate C12

The battery’s scope rule permits reliably detected runtime rejection, not silently assigning the write different commit timing. This design repeats scar S21.

Setup: `a=0`, no subscribers.

1. Run `startTransition(async () => { a.set(1); await ready; a.set(2); await hold; })`.
2. T owns `set(1)` and remains parked on the outer promise.
3. After `ready`, §1 classifies `set(2)` into ambient default batch D.
4. D retires while `hold` remains pending. Its receipt folds `a=2` into K0 because T’s unretired receipt is excluded.
5. Canonical/committed reads now observe `2` before the action settles.

C12 explicitly requires the async action’s writes not to commit before settlement. `ActionScope.run` only fixes rewritten user code; satisfying the frozen case requires continuation attribution or reliable rejection of the unsupported composition.

### 4. BLOCKER — architectural — Immutable evaluators delete required R2/R3 semantics

The four-row validity table closes only because the design removes two requirements.

Reducer schedule:

1. Mount `useReducer` and `useReducerAtom` with state `0` and reducer `r1(s) = s + 1`.
2. Commit a prop change supplying `r10(s) = s + 10`.
3. Dispatch the same action to both hooks.
4. React processes it with the current reducer and produces `10`; §1 keeps the original reducer and produces `1`.

`ctx.previous` schedule:

1. Evaluate `c = (ctx.previous ?? 0) + delta.state` with `delta=1`; the result is `1`.
2. Set `delta=2` and recompute; the required API supplies previous value `1`, producing `3`.
3. This design does not expose `ctx.previous`, so the required program cannot compile or execute.

Restoring reducer parity removes the “no evaluator change source” premise and requires versioned reducer replay, publication ordering, and cache invalidation. These are contract failures, not legitimate optional cuts.

### 5. BLOCKER — architectural — Fresh-node adoption and reclamation have no valid construction

The claim that pass-owned arena nodes are “freed wholesale on discard” is incompatible with a shared bump arena and pass-level lifecycle alone.

1. Pass P allocates fresh node nP at bump position 100 and yields.
2. Another root’s pass Q allocates nQ at 101 and commits it.
3. P is discarded.
4. Resetting the bump pointer to reclaim nP invalidates committed nQ; leaving the pointer untouched leaks nP.
5. Repeating this schedule exhausts the plane or corrupts a committed node.

A same-pass variant is worse: a component allocates a node and throws to an error boundary, while the pass commits the fallback. The pass was not discarded, but the node’s hook was, so a pass-owned list cannot decide what to adopt.

The six-fact fork exposes pass completion, not hook/subtree commit or abandonment. A sound design needs a staging allocator or reclaimable records plus commit-grained adoption; an allocation list is not that construction.

### 6. BLOCKER — local fix — Suspense deliberately repeats the S31 refetch scar

Setup: transition lineage L remains pending behind another gate; its resource capsule has settled `fetch("A")` and records atom `key="A"`.

1. Default batch U writes `key="B"` and then `key="A"`.
2. U’s final visible value is unchanged, but retirement moves `visStamp[key]`.
3. L retries. Its fingerprint differs, so the stated v1 policy discards the settled capsule and invokes `fetch("A")` again.
4. Repeat net-zero U batches while the other gate remains pending.
5. Every retirement launches another side-effecting fetch and re-suspends L; the transition can starve indefinitely.

The design explicitly calls this “accepted,” but SCARS marks stamp-change-implies-refetch as dead. It needs value revalidation before replacing or invoking the resource capsule.

### 7. BLOCKER — local fix — C13 omits live counter collision rules

The per-walk generation counter alone has a direct missed-notification schedule.

1. Force a two-bit walk generation. A walk with generation `1` traverses `a→c→W`, leaving `visited[c]=1`.
2. Run three walks over a disjoint graph, advancing generations through `2,3,0` without touching c.
3. Write a; the new walk receives generation `1`.
4. Its visited test finds `visited[c]===1`, treats c as already visited, and skips c and W.
5. W is not scheduled and may commit its previous value.

K1’s epoch does not help while one long-lived episode remains open. The design also gives no wrap/rewrite policy for `slotClock`, `visStamp`, settlement slots, lineage IDs, or delivery sequence records, despite C13 requiring every counter and horizon to be enumerated.

### 8. BLOCKER — architectural — Saturation frees history before it can prove pinned passes dead

A queued corrective update is not an acknowledgement that the old pass has been discarded.

1. Batch X writes `x=1`; pass P starts with a mask excluding X, reads `x=0`, and yields.
2. X retires after P’s pin. K0 becomes `1`, but X’s receipt must remain so P can continue excluding it.
3. Retired-but-unswept slots accumulate until another batch needs a slot.
4. The saturation rule recycles X’s slot/history and merely “pokes” P through `runInBatch` or an urgent fallback.
5. Before a replacement pass is confirmed, P resumes and reads another occurrence of x. With the exclusion receipt gone, it obtains folded K0 value `1`.
6. P now contains `0` and `1` for the same pinned world.

The fork protocol has no synchronous `discardPassAndAcknowledge` operation, and `runInBatch(X)` returns false once X is retired. The design needs retained spillover bookkeeping or an explicit discard-before-recycle protocol.

### 9. HIGH — local fix — The normative write path does not mirror urgent operations into K1

Section 5 says urgent writes apply through K0, while the battery walk later asserts they are mirrored into both engines.

1. Begin with `a=1`.
2. Deferred T applies `+1`; K1 HEAD is `2`, while K0 remains `1`.
3. Urgent U applies `×2`. Following §5, K0 becomes `2` and K1 remains `2`.
4. With T live, an event-handler NEWEST read uses K1 and returns `2`.
5. Receipt-order replay says HEAD must be `(1+1)×2 = 4`.

The repair is small but must be normative: apply every urgent operation to K1 in receipt order while forked, propagate through both relevant topologies, and specify its interaction with equality and delivery.

### 10. HIGH — architectural — The design explicitly fails the frozen P3 gate

1. Register the React bridge, leave no batch live, and run the required one-framework-per-process quiet tier-0 workload.
2. Every read executes the REACT routing branch.
3. The design cites that branch at 2.4–3.8% overhead.
4. P3 requires React-mounted-but-quiet overhead of at most 2%; §10 instead attempts to renegotiate the target to 3%, still below the cited worst case.

A pending idle-machine run is not a mechanism or passing gate. The current design must either remove enough quiet-path work or acknowledge that it fails a frozen requirement.

## Verified held

I attacked the following mechanisms and did not find a failure, subject to the reachability gaps above:

- C2’s always-log plus pin/mask replay reconstructs both the direct atom and downstream computed for a `flushSync` pass excluding D.
- C3’s receipt-order replay preserves React’s `4`, not `3`, and a later plain `set` correctly overwrites preceding updater results.
- The per-write, writer-stack delivery rule preserves lane attribution for C6. Its per-slot dedup also handles C4 and the same-slot post-pin case once the watcher is reachable from an engine.
- Yield/resume edges correctly separate handler NEWEST reads from a paused pass’s pinned reads in C7.
- Empty-tape equality dropping is sound for fixed, pure operations because all worlds share the same pre-write accumulator; non-empty history is retained as C8 requires.
- C10’s reach-based live-token correctives avoid the subset-equality trap, and its retired-token value comparison provides the required urgent race fallback.
- Folding `committed=false` identically preserves synchronous store-only writes independently of subscriptions.
- Monotonic React-mode activation avoids losing the first transition’s receipts.
- Removing optimistic truncation cleanly deletes C17 rather than leaving a partial rollback protocol.

## Verdict

This design is architecturally unsound as written and is not implementation-ready. The receipt, pin, visibility, and rebase core is promising, but two kernels do not cover late or subset-specific dependencies, while several simplifying cuts violate the frozen product contract or depend on allocator and fork mechanisms that do not exist. Repair requires a complete correction mechanism for non-HEAD worlds, compliant async and reducer semantics, commit-grained adoption, safe saturation, and exhaustive lifecycle rules before implementation.

