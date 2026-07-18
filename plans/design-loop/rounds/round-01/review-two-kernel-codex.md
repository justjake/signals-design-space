# Review: TWO-KERNEL

## Findings

### 1. BLOCKER — local fix — retirement stamps and pass pins are incomparable

Setup: keep transition `T` live, perform 100 writes to an unrelated atom without retiring a batch, so `globalSeq=100` while `retireSeq=0`.

1. Pass `P` starts with `pin=100`, reads `x=0`, and yields.
2. Click batch `C` writes `x=1` at `globalSeq=101`.
3. `C` retires and stamps its entry with `retiredSeq=1`.
4. The visibility test evaluates `1 <= pin(100)`, so `P` includes `C` even though the write happened after its pin.
5. The compaction test can likewise treat the entry as safe because `retiredSeq <= min(live pins)`.

Wrong outcome: resumed `P` reads `x=1`, violating C7’s frozen-world requirement. The design’s C7 walk assumes `r > p`, but `r` and `p` come from unrelated counters; retirement must advance the same event clock used by pins.

### 2. BLOCKER — architectural — suspension settlement is absent from memo validity

Setup: in world `wk`, computed `c` calls `ctx.use(th)` while `th` is pending.

1. `worldMemoRead(c,wk)` stores a suspension sentinel with `seq=s` and `epoch=e`.
2. No signal writes or retirements occur.
3. `th` fulfills and React retries the same batch-set under the same lineage.
4. `globalSeq`, `worldMemoEpoch`, mask, and pin are unchanged, so the same `worldKey` is used and §7.2 declares the memo valid.
5. §7.1 rethrows the cached sentinel before `ctx.use` or its positional cache can observe that `th` settled.

Wrong outcome: every retry suspends again; `k` never commits. The same defect exists for a suspension sentinel cached in K0. The “writes, retirement, or nothing else” validity construction is false because thenable settlement is a third invalidation source; sentinel-bearing K0 values and world memos need a settlement generation or explicit dirtying path.

### 3. BLOCKER — architectural — the world-sensitive invariant is established only after an unsafe K0 evaluation

Setup: `a=0`, `b=0`, and an existing `useComputed` node has function `mode ? a : b`; initially `mode=false`, so K0 records only `b→c`.

1. Transition `T` writes `a=1`. Since no `a→c` edge exists, the walk flags `a` but not `c`.
2. An urgent React-only update changes `mode=true` and bumps `c.fnVersion`; the urgent pass excludes `T`.
3. `read(c)` sees `flag(c)=0` and takes the native `k0.pull(c)` fast path.
4. K0 recomputes the new function against its canonical newest plane and reads `a=1`.
5. Only after that computation does `afterRetrack(c)` discover the flagged dependency and set `flag(c)=1`.

Wrong outcome: the urgent pass returns `1` although its world excludes `T` and must return `0`. Routing K0’s internal read through the urgent world would merely invert the failure by caching `0` as K0’s newest value; the design has no evaluate-then-recheck step. The proof of invariant F covers the state after edge insertion but not the evaluation that inserts the edge, and `afterRetrack` also fails to propagate a newly raised flag through existing downstream edges.

### 4. BLOCKER — architectural — a batch can retire before a not-yet-registered watcher can observe it

Setup: batch `k` writes `a=1`; root A has an existing watcher, while root B is concurrently mounting its first reader of `a`.

1. B’s pass excludes `k`, renders `a=0`, and yields before the watcher’s commit effect.
2. A commits `k`; because B has no registered watcher, B is not an involved root. `k` retires and the reconcile walk cannot see B’s future watcher.
3. B resumes its pre-retirement pinned world and commits `0`.
4. The layout fixup enumerates only currently live tokens. Since `k` is already absent, it never calls `runInBatch(k)`, so its advertised dead-token fallback is unreachable.
5. If B’s own token happens to remain live and catches the changed committed value, correction requires a second commit; the first-correct-render guarantee for a fresh mount is still lost.

Wrong outcome: depending on commit bookkeeping order, B either remains stale indefinitely or exposes a stale commit before a corrective commit. The hook must retain a render-time generation/token snapshot and compare against the current committed-for-root value even when no relevant token remains; attach-at-commit plus live-token enumeration is insufficient.

### 5. BLOCKER — local fix — singleton subscription checks miss multi-batch interactions

Setup: `a=false`, `b=false`, `c=a && b`; live batch `j` sets `a=true`, live batch `k` sets `b=true`, and watcher W mounts after both writes.

1. W’s urgent mount excludes both batches and renders `c=false`.
2. The layout fixup checks world `{j}`: `true && false = false`, matching the rendered value.
3. It checks world `{k}`: `false && true = false`, also matching.
4. No corrective update is installed in either batch.
5. React renders `{j,k}` jointly for other work. A memoized subtree containing W can bail out because W has no update in either lane.
6. Siblings commit the joint world while W’s DOM remains `false`; `c` in that world is `true`.

Wrong outcome: a torn joint-batch commit. Any retirement backstop is one commit late. Fixup must at least install a correction in every live token unconditionally, or operate on actual pass batch-sets rather than testing only singleton worlds.

### 6. BLOCKER — local fix — per-root lock-in bits survive slot recycling

Setup: another token `h` remains live to prevent quiescence.

1. Batch `k` uses slot `s`, commits on root A, and sets `lockedIn(A) |= bit(s)`.
2. `k` retires, its tape entries compact, and slot `s` is released.
3. No retirement or recycle step clears `bit(s)` from root A’s lock-in mask.
4. New batch `j` reuses slot `s` and writes `x=2`, but has not committed on A.
5. An urgent pass on A excludes `j`, yet pass derivation unions `lockedIn(A)` and therefore includes slot `s`.

Wrong outcome: A renders `x=2` before `j` commits, contradicting A’s own committed DOM. Root lock-in state must be cleared before slot reuse or carry the token generation rather than a reusable slot bit.

### 7. BLOCKER — local fix — the counter lifecycle has unguarded collisions

First schedule, `globalSeq`:

1. Keep batch `k` live so quiescent reset is impossible; force `globalSeq=Number.MAX_SAFE_INTEGER`.
2. A write advances it to `Q=2^53`; a `k` render stores a memo with `memo.seq=Q`.
3. A second write executes `++globalSeq`, but JavaScript rounds it back to `Q`; `slotWriteSeq[k]` therefore remains equal to the memo sequence.
4. The next pass has the same mask and pin, and §7.2 accepts the stale memo.

Wrong outcome: the second write notified W, but W renders the first value. The promised near-`2^53` test has no corresponding rollover mechanism.

Second schedule, `episodeEpoch`:

1. Episode `E` leaves node `a`’s cold-column mapping tagged `(E,k1Id=q)`.
2. Quiescence resets the K1 plane; correctness relies on the tag mismatch rather than physically clearing every stale mapping.
3. Force the packed epoch tag to wrap back to `E` without touching `a`.
4. Accessing `a` now accepts `q` as current without reserving that K1 record; a later K1 allocation can overwrite its links.
5. A write whose only path to W was that K1 edge misses W or traverses unrelated records.

Wrong outcome: cross-episode missed notification or plane corruption. `episodeEpoch` is itself a finite counter stored in an `Int32` packing, yet it is absent from §11’s lifecycle inventory.

### 8. HIGH — local fix — formal memo validity omits `fnVersion`

Setup: flagged computed `c` has a world memo for `fn1`, with `fnVersion=1`.

1. A React state update in the same batch changes `useComputed`’s dependencies and installs `fn2`; no signal write occurs.
2. The batch mask, `globalSeq`, pin, root variant, and lineage remain unchanged.
3. Section 2 keys the memo by `(node, worldKey)`, while §7.2 checks only epoch and slot clocks.
4. The memo therefore hits and returns `fn1`’s value despite `fnVersion=2`.

Wrong outcome: the restarted pass commits a value calculated from stale props/state. Section 9.1’s prose says memos are “keyed with” `fnVersion`, contradicting the formal key and validity algorithm; `fnVersion` must be an explicit key component or validity predicate.

### 9. HIGH — architectural — discarded fresh nodes are not GC fodder

Setup: repeatedly begin a transition that mounts a fresh `useComputed`, let it evaluate, then urgently abandon the mount before commit.

1. Each attempt needs a library/K0 node id so its dependency can target it in K1; K1’s mapping is explicitly indexed by K0 ids.
2. The world evaluation adds K1 edges, but the commit effect never registers the node.
3. Quiescence drops lineage memos and resets K1.
4. Nothing frees or reuses the corresponding bump-allocated K0 record.
5. Repeating the schedule permanently grows K0 until repeated buffer growth or exhaustion crashes the process.

Wrong outcome: ordinary abandoned mounts leak arena nodes permanently. A collected JavaScript wrapper cannot reclaim an integer record in a bump-allocated plane; the design needs temporary-node storage, a free/reuse protocol, or lineage-keyed reuse before calling these nodes “GC fodder.”

## Verified held

- Always-logging all React-mode writes preserves C2 and C8’s otherwise-lost receipts.
- Seq-order operation replay produces C3’s `2 → 4` updater arithmetic, independent of mask enumeration order.
- For fixed computation functions, an actual pending-world read records the missing K1 edge, and the full per-write walk handles C1, C4, and C5 without canonical-topology-only notification.
- Synchronous per-write `setState` delivery preserves C6’s urgent-versus-transition lane attribution; no grouped drain obscures writer context.
- F2’s yield/resume protocol correctly restores `NEWEST` during yield-gap handlers; C7 fails because of retirement timestamps, not because of the fork’s call-stack scoping.
- E-PRESERVE retains old K0 dependency bases across ordinary K0 retracking, assuming retracking is truly the only K0 edge-removal site.
- Per-root lock-in preserves C11 while a token remains live and its slot has not been recycled.
- Folding `committed=false` retirements independently of watcher presence handles C12’s store-only policy, assuming the fork supplies the specified retirement and async-parking events.
- The protocol seam passes the rebase drill: lane, scheduler, and commit reorganizations can remain fork-local because no Fiber, lane mask, or queue object crosses the boundary.
- Omitting a truncation API avoids C17 without weakening another reviewed mechanism.

## Verdict

This design is not implementation-ready. It is repairable: the real K1 topology, always-log replay, and writer-context delivery survive, but the clock domain, non-write invalidation, routing construction, subscription repair, and slot lifecycle must be rewritten. Until those repairs have executable schedules for C7, C9/C10, C13, and C15, implementation would ship torn commits, permanent suspension, missed notifications, and eventual arena exhaustion.