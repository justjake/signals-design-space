# Adversarial correctness review: COMPENSATED OVERLAY

## Findings

### 1. BLOCKER — architectural — `(node, mask)` does not identify a world

The design defines a world as `(mask, pin)` but keys memos only by `(node, mask)`. Neither L1 nor the tail-only L2 certificate safely distinguishes pins.

**Schedule A — a later-pin memo tears an older pass**

1. Deferred async batch T writes `a=1@seq1`.
2. Root A starts a T-pass at `pin=1`; component X reads computed `c=a`, producing `c=1`, then the pass yields.
3. T’s async continuation writes `a=2@seq2`. M3 schedules rework, but no fork invariant says the old attempt executes no more components before being discarded.
4. Root B starts a T-pass at `pin=2` and publishes memo `(c,{T})=2` with a stamp covering `writeClock[T]=2`.
5. Root A resumes its still-pinned attempt and component Y reads `c`. L1 accepts the shared memo because its stamp is current; there is no pin comparison.
6. X rendered `1` while Y renders `2` in the same pass, although A’s pin makes only `seq1` visible.

Discarding the pass later does not repair its violated whole-pass consistency invariant.

**Schedule B — `visibleTailSeq` misses an inserted older receipt**

1. Start with `a=1`. Deferred R logs `+1@seq1`; deferred K logs `×10@seq2`.
2. Urgent U logs `g(x)=x<5?0:x @seq3`, then retires. K0 is `g(1)=0`.
3. A K-pass excludes R and computes `a = g(1×10)=10`; memo `c=a` records certificate `(a,3)`.
4. R retires. Canonical replay excluding live K is `g(1+1)=0`, equal to K0, so §9 performs no fold-walk.
5. A new K-pass should compute `g((1+1)×10)=20`. L1 fails on `retirementClock`, but L2 still sees newest visible receipt `seq3`, accepts `(a,3)`, restamps the memo, and returns `10`.

A tail identifies the last receipt, not the complete visible prefix that updater replay depends on. Correctness requires pin/version identity or a certificate that detects every visibility-set change; either changes M5/M6 and their cost model.

### 2. BLOCKER — architectural — replay callbacks form an unrecorded dependency channel

The proof says atoms “read nothing,” but R1 updater functions and R3 reducers are retained and executed during folds. The API neither forbids those callbacks from reading signals nor gives atom fold memos certificates to preserve such dependencies.

**Schedule**

1. Start with `a=0`, `b=1`; T logs `a.update(x => x + b.state)`.
2. Root A’s T-pass folds `a`, executing the callback against `b=1`, and caches `(a,{T})=1`. Any `b` read can enter A’s outer watcher certificate, but the atom memo itself has no certificate.
3. Root B then reads `a` from that atom memo. Its certificate records only `(a, tailT)` because the callback is not replayed and there is no atom certificate to flatten. It renders `1` and yields before commit.
4. Urgent U writes and commits `b=2`. There is no canonical edge `b→a→W`, and Root B’s certificate has no `b` entry, so M3 and `bucket[b]` cannot reach its watcher.
5. Root B commits `a=1`. When T retires, replay executes the updater against `b=2`, producing canonical `a=2`, and only then schedules a correction.

This is the fifth read channel §16 says kills the stance. The design must either detect and reject signal reads during updater/reducer replay, with the required legal-composition contract, or make atom folds certified dependency-bearing evaluations.

### 3. BLOCKER — architectural — async-action parking does not preserve write attribution

Keeping a token live until a promise settles does not make that token observable from continuations after `await`.

**Schedule**

1. T1 starts `async () => { a.set(1); await p; a.set(2); await r; }`.
2. T2 starts an analogous action and also suspends. Both synchronous transition scopes return.
3. `p` resolves. The continuation calling `a.set(2)` has no render context and no synchronous transition scope.
4. The only classification surface is `currentBatchToken()`. The protocol supplies no continuation/action identity, and two parked tokens make a global “current parked token” ambiguous.
5. The write is therefore assigned to a default/new token or to the wrong action. If default-classified, K0 exposes `2` while T1 is still waiting on `r`; if misassigned, T1’s retirement omits its second receipt.

`onRetire` parking controls lifetime only. Plain `startTransition(async …)` parity needs a specified async-context mechanism or an explicit continuation-scoped protocol surface; merely asserting “same token across await” has no construction and is automatically blocking.

### 4. BLOCKER — local fix — the thenable cache reuses stale resources after same-mask writes

Stable mask identity is not stable world identity when the batch receives another write.

**Schedule**

1. T writes `key=1`; computed `c` evaluates `ctx.use(load(key.state))`.
2. The T-pass stores pending `load(1)` at `(c,{T},position=0)` and suspends.
3. While T remains live, its async continuation writes `key=2`. M3 invalidates `c`’s value memo.
4. The retry has the same mask `{T}` but a later pin. It evaluates `load(2)`, yet M11 finds the still-live positional entry `(c,{T},0)` and reuses `load(1)`.
5. When that promise settles, the retry produces data for key `1` while its signal world contains key `2`.

The cache needs pin/dependency identity or write-driven invalidation. “Same mask implies same thenable” attacks the wrong construction.

### 5. BLOCKER — architectural — full multi-root support lacks root context for ordinary passive effects

M10 handles only renders and the library’s special `useSignalEffect` flush. The fork protocol supplies no root identity during ordinary React effects or event handlers.

**Schedule**

1. Spanning batch k sets `a=1` for roots A and B.
2. A commits first. `locked[A]` includes k and A’s DOM displays `1`; B remains pending, so k cannot retire and K0 still contains `a=0`.
3. React runs an ordinary passive effect in A: `useEffect(() => { seen = a.state })`.
4. `renderContext()` is undefined, and §6.4 installs a committed-root world only for `useSignalEffect`. `currentWorld()` therefore returns NEWEST/K0.
5. The passive effect records `0`, contradicting A’s committed DOM and C11’s explicit requirement that A’s passive effects observe k.

A click handler in A has the same problem. Full spanning support requires root-scoped post-commit execution context or an explicit restriction; the current eight-surface seam cannot implement its declared scope.

### 6. BLOCKER — local fix — equal canonical retirement can change another world without notifying it

M9 performs its fold-walk only when K0’s value changes. Retirement can instead change a pending world while leaving K0 equal.

**Schedule**

1. Canonical state is `flag=false,a=0,b=0`, with `c=flag?a:b`; therefore K0 has no `a→c` edge.
2. T1 on root A writes `flag=true` and `a=1`. W completes a T1 render with `c=1`, but its commit is delayed.
3. Later T2 on root B writes `a=0` and has unrelated React work ensuring T2 commits.
4. T2’s write cannot reach W: the canonical cone from `a` omits `c`, and `bucket[a]` ignores W’s `{T1}` certificate because it does not contain T2.
5. T2 retires. Canonical replay skips live T1 and applies T2’s `set(0)`, leaving K0 at `0`; §9 therefore performs no fold-walk or bucket invalidation.
6. A rebased T1 world should replay `T1:set(1)` followed by retired `T2:set(0)` and render `c=0`. No update invalidates A’s completed work, so it commits `c=1`.

Retirement must process affected certificates and schedule pending worlds even when equality suppresses the K0 write.

### 7. BLOCKER — architectural — sequence overflow cannot force quiescence

The stated mid-episode remedy is not implementable through the protocol and has no construction.

**Schedule**

1. In a forced-small-counter test, park async batch T and keep a T-pass yielded at `pin=6`.
2. Writes advance a three-bit `globalSeq` to `7`.
3. Another T write needs a sequence number. Normal `episodeReset()` is illegal because T is live and its pass is open.
4. The proposed “forced quiescence flush” cannot settle the user’s promise or retire/discard React work; none of the eight fork surfaces provides that control.
5. If the counter wraps to `0`, the post-pin receipt satisfies `seq<=pin` and becomes visible to the old pass, violating its pin and tape ordering. Refusing the write instead makes an ordinary update crash or hang.

The same audit also omits a wrap construction for `worldEpoch` and the token serial. A wider horizon does not satisfy C13’s forced-wraparound requirement.

### 8. HIGH — local fix — multi-atom retirement exposes a half-folded canonical batch

M9 applies written atoms one at a time without specifying a core-effect flush barrier.

**Schedule**

1. Configure synchronous core effects as required by R13. Effect E records `[x.state,y.state]`; initially it records `[0,0]`.
2. Store-only deferred T writes `x=1` and `y=1`.
3. T retires. M9 first calls normal `K0.writeCanonical(x,1)`, whose dirty propagation flushes E.
4. E observes `[1,0]`.
5. M9 then applies `y=1`, and E observes `[1,1]`.

`[1,0]` is not any batch world. Retirement must defer core-effect flushing until every atom in the token has been folded.

## Verified held

- The exact C2 schedule holds: always-logging reconstructs the Sync-only atom value, and the synchronous canonical-cone mark routes the computed away from K0.
- The main C1 late-dependency schedule holds for ordinary atom reads: tail-zero certificate entries plus flattened watcher certificates let `bucket[a]` reach the pending watcher.
- Direct atom folding in C3 preserves write order and produces `2 → 4`, including the plain-set overwrite variant.
- C4’s different-batch notification survives because M3 walks per write and delivery dedup is per slot rather than per stale region.
- C7’s yield-gap behavior holds under the stated fork invariant: per-callstack `renderContext()` distinguishes resumed render work from handlers running while the pass is paused.
- C8 preserves equal-write receipts; the direct U-world and overlapping-equal-transition folds remain reconstructible.
- C9 routes fresh nodes through world evaluation before the mark fast path can leak K0.
- C10’s one-commit correction holds if `runInBatch` provides exactly the entanglement guarantee stated by fork invariant 5.
- C12’s synchronous store-only transition persists because `committed=false` still folds its receipts.
- C17 cleanly avoids truncation rather than leaving a partial rollback mechanism.

## Verdict

This design is not implementation-ready: its cache certificates and keys do not identify the world they validate, and the fork protocol does not provide all of the execution context the library assumes. The retirement-notification and atomic-fold defects are locally repairable, but async attribution, hidden fold dependencies, multi-root read context, and counter lifecycle require changes to core invariants and the seam. Verdict: architecturally unsound.