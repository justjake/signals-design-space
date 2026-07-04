# Review: Round 2 COST-HARDENED design

## Findings

### 1. BLOCKER — architectural: `useComputed` leaks uncommitted React closures into NEWEST reads

Setup: committed React state `p=0`, atom `a=0`, and `c = useComputed(() => p + a.state, [p])`. A committed event handler retains `c`.

1. Transition T sets `p=1`.
2. T’s render updates the single hook node’s evaluator and `fnVersion` to the closure containing `p=1`, then yields.
3. The event handler runs in the yield gap, urgently sets `a=1`, and reads `c.state`.
4. F2 correctly routes the handler to NEWEST, but K0 recomputes the now-dirty node using its only specified evaluator: T’s uncommitted `p=1` closure.
5. The handler observes `2`; the correct newest world is committed `p=0` plus `a=1`, hence `1`.

`fnVersion` distinguishes evaluator revisions but does not associate them with a pass, mask, lineage, or committed React version. The design needs world-scoped evaluator storage and commit/abandon rules; a single mutable node evaluator cannot support concurrent React closures.

### 2. BLOCKER — architectural: cutoff compares against committed output while React may hold a newer uncommitted tree

Setup: at least eight watchers observe `c=a`; committed `a=0`, and their commit-recorded `lastRendered` is `0`.

1. T writes `a=1`; cutoff computes T-world `1`, differs from `lastRendered`, and schedules all watchers in T.
2. A T pass renders `c=1`, re-arms T, and remains uncommitted while T is held open.
3. A later T segment writes `a=0`.
4. The reopened walk reaches `c`; cutoff computes `0`, compares it with commit-recorded `lastRendered=0`, and suppresses every update.
5. React can finish or reuse the already-rendered T subtree containing `1`; no T update tells it that the batch’s signal world returned to `0`.
6. Retirement revocation is too late: `runInBatch` is false once T is dead, and reconcile can only repair after the stale DOM has committed.

`lastRendered` proves equality with the committed tree, not with outstanding finished work. Sound cutoff needs per-pending-render knowledge or must be disabled whenever a watcher has uncommitted work; `suppressedMask` and cross-slot revocation do not encode that fact.

### 3. BLOCKER — architectural: untracked signal reads inside updater/reducer replay create invisible dependencies

Setup: atoms `a=0`, `b=0`; watcher W reads `a`. T executes `a.update(x => x + b.state)`.

1. T logs the updater while `b=0`; its first T render folds `a` to `0` and caches that atom fold.
2. Section 10.7 deliberately evaluates `b.state` untracked, so no edge or dependency entry connects `b` to `a` or W.
3. Store-only urgent batch U writes `b=1` and retires.
4. U’s write walk never reaches `a` or W. Retirement row 2 also considers U irrelevant because `touchedSlots(a)` lacks U, so the cached T fold remains valid.
5. T retires later. Replaying its updater “at the fold’s world” now reads committed `b=1`, making canonical `a=1`, while W’s finished T tree still displays `0`.

This directly breaks §8.5’s “by construction” claim: retirement validity does depend on topology, and untracked updater reads bypass that topology. Either signal reads in replayable operations must be rejected, or their complete dependencies must participate in cache validity and notification.

### 4. BLOCKER — architectural: suspension outcomes have lineage-specific storage but lineage-free memo keys

Setup: eight watchers observe `c = ctx.use(makeRequest(a.state))`, where each `makeRequest` call creates a fresh thenable.

1. T writes `a`, causing cutoff to call `worldMemoRead(c, writerWorld(T))` before any render pass or lineage exists.
2. `ctx.use` requires key `(node, lineageId, position)`, but the writer stack has no `lineageId`. If a synthetic lineage is used, memo `M(c, maskId)` stores its thenable sentinel.
3. Actual lineage L renders and hits that memo, suspending on the synthetic thenable without populating L’s positional cache.
4. The thenable settles; row 3 invalidates the sentinel.
5. L retries, finds no positional entry, calls `makeRequest` again, and suspends on a second thenable.

The promised memo sharing therefore violates C15’s stable identity and duplicates observable async work. Separately, even inside one real lineage, changing `useComputed` dependencies bumps `fnVersion` but does not invalidate the thenable entry’s row-1/row-2-only `foldStamp`; evaluator B can consequently reuse evaluator A’s thenable and commit A’s result. Sentinel memos must be lineage-aware, `foldStamp` must cover evaluator identity, and writer-time cutoff cannot share suspensions as currently specified.

### 5. BLOCKER — local fix: pinless memo replacement corrupts `ctx.previous`

Setup: global `c = (ctx.previous ?? 0) + x.state`; committed `x=0`. Root B already watches `c`; root A is mounting new readers in the same spanning transition T.

1. T writes `x=1`. Root A pass P starts at pin p1; its first reader evaluates `c=1`, storing `M(c,T)={outcome:1,pin:p1}`, then yields.
2. T writes `x=2`. Root B renders at p2 and invalidates the memo via row 1.
3. Root B evaluates using `previous=1`, producing `3`, and overwrites the single `(c, maskId)` memo.
4. P resumes at p1. The pin-window check correctly rejects the p2 memo, but reevaluation receives its outcome `3` as `ctx.previous`.
5. P computes `3+1=4`; its first sibling already rendered `1`.

One render pass has now read two values from the same pinned world. Row 7’s assertion that `previous` is self-contained is false when a pinless memo is overwritten non-monotonically; nodes that access `ctx.previous` need pass/pin-specific immutable prior state.

### 6. BLOCKER — local fix: one `deliveredEra` cannot validate multiple bits in `deliveredMask`

Setup: W watches `c` over `a`; T1 and T2 are live.

1. T1 writes `a`; the walk sets T1’s delivered bit and stamps `deliveredEra(c)=E1`.
2. W renders T1, clears its T1 notification bit, and sets `rearmEra[T1]=E2`.
3. T2 writes `a`; delivery ORs T2 into `deliveredMask(c)` and overwrites the single scalar `deliveredEra(c)` with an era at least E2.
4. T1 writes again before another T1 render.
5. The prune test sees T1’s old bit and the newer scalar era, concludes `deliveredEra(c) >= rearmEra[T1]`, and prunes despite no T1 delivery since W re-armed.
6. W has no T1 notification pending, so T1 can commit its earlier rendered value.

The wrap procedure has the same defect: it zeros `deliveredEra` and `rearmEra` but retains delivered bits, making `0 >= 0` immediately prune. Store an era per represented slot, retain only the bit belonging to the scalar stamp, or clear delivered bits whenever their shared stamp loses meaning.

### 7. HIGH — local fix: `globalSeq` has no safe behavior when quiescence never arrives

Setup: use a forced-small sequence width and keep one async transition live indefinitely.

1. Drive `globalSeq` to the design’s saturation threshold.
2. The guard requests episode closure only at the next quiescence-eligible point.
3. Continue writes while the held transition prevents quiescence.
4. If writes continue, sequence values eventually collide or lose integer precision; an old pass can classify a future receipt as `seq <= pin`, and clock/window checks can no longer distinguish the writes.
5. If the “prod assert” throws instead, an otherwise valid long-lived action crashes.

The reserved headroom delays the failure but does not establish a bound. The design must specify a correctness-preserving hard-stop or a non-reusing wider identity before precision is exhausted, and the forced-small test must exercise a non-quiescent episode.

## Verified held

- Always-logging plus shared sequence-order replay survives C2, C3, and C8: excluded default writes remain reconstructible, functional updates replay in order, and equal-to-newest writes retain receipts.
- K1 world edges plus recursive propagate-on-new-edge survive the core C1 divergent-dependency schedule and T9’s equality-stranded new-edge schedule when frontier pruning is excluded.
- The exact two-slot suppress/suppress `x1 && x2` attack is repaired: the second slot’s arrival revokes the first suppression and leaves a lane update for the joint render.
- Per-write synchronous delivery and per-token `runInBatch` preserve C6 lane attribution; no grouped drain silently merges urgent and deferred writes.
- F2’s yield/resume routing preserves C7 for ordinary pure computeds without `ctx.previous`: gap handlers use NEWEST, while resumed passes retain their pin.
- Touched-slot mount narrowing plus the unconditional committed-version comparison survives C9/C10’s ordinary late-mount and retirement-window schedules.
- `baseSeq` preserves dependency versions through compaction, so C16’s committed-effect rerun is not lost merely because a tape became empty.
- Folding store-only synchronous transitions independently of subscribers survives the non-async half of C12.

## Verdict

Verdict: repairable, but not implementation-ready. The tape and world-edge core survives, but evaluator identity, replay-callback dependencies, cutoff safety, `ctx.previous`, and suspense lineage handling require redesign before implementation. After those repairs, frontier epochs and sequence saturation need forced lifecycle proofs before the performance gates are meaningful.