# Adversarial correctness review — Round 2 HARDEN

## Findings

### 1. BLOCKER — architectural — `fnStamp` invalidates one global evaluator; it does not version evaluators by render world

The S3 construction models the evaluation function as one mutable `node.fn` plus one `node.fnStamp`. Concurrent React renders can require two closures for the same hook instance simultaneously.

**Failing schedule**

1. **Setup:** committed React state is `mode=A`; `c = useComputed(() => mode === A ? a.state : b.state, [mode])`; `a=1`, `b=2`; the committed tree shows `mode=A, c=1`.
2. Deferred T sets `mode=B`. T renders, installs the B closure on `c`, bumps `fnStamp`, reads `c=2`, then yields.
3. Urgent U renders the same component while excluding T, so React supplies committed `mode=A`.
4. If dependency comparison uses React’s committed hook deps, `[A]` appears unchanged and the design leaves the shared B closure installed. U recomputes with B and commits `mode=A, c=2`.
5. If comparison instead uses the globally installed `[B]`, U restores A; when T resumes, its memo fails the `fnStamp` conjunct and recomputes with the now-global A closure, producing `c=1` in T’s B world.

**Wrong outcome:** either the urgent or deferred render observes the other render’s closure and commits a torn React-state/signal frame. Invalidating results cannot select the correct function; the function itself must be stored per React version/pass or logged with batch visibility. The same defect applies to render-selected reducer identities.

### 2. BLOCKER — architectural — the atom fingerprint collides when an older operation becomes visible

`max(newest-visible seq, baseSeq, reducerStamp)` is not a collision-free stamp for an ordered visible-operation set. Adding an older updater underneath an already-visible newer updater can change the value without changing the maximum.

**Failing schedule**

1. **Setup:** `a=1`; a committed-state `useSignalEffect` observes `a`.
2. Deferred T logs `update(+1)` at `s1` and remains pending.
3. Urgent U logs `update(×2)` at `s2`, renders without T, and commits. The committed fold is `1×2=2`; U cannot compact past older unretired T, and the effect records `fp(a)=s2`.
4. T later retires. The committed fold becomes `(1+1)×2=4`; both entries compact and `baseSeq=max(s1,s2)=s2`.
5. Retirement bumps `worldMemoEpoch`, but ladder revalidation computes `fp(a)=max(0,s2,0)=s2`, equal to the snapshot, and restamps it without running the effect.

**Wrong outcome:** committed `a` is 4 while the effect remains based on 2. This attacks the centerpiece validity construction directly: minted constituents do not make their `max` an injective fingerprint.

### 3. BLOCKER — architectural — a K1 edge created after a write does not replay that write’s lane notification

`raiseFlag` repairs routing reachability, but it never schedules watchers for receipts that already existed before the new edge. The full-reach walk only ran against the old graph.

**Failing schedule**

1. **Setup:** `flag=false`, `a=0`, `c=flag ? a : 0`; memoized watcher W shows 0. T1 also carries unrelated React work so it can commit without W.
2. T1 writes `a=1`. Since `a→c` does not exist, `notifyWalk(a,T1)` does not schedule W in T1.
3. T2 writes `flag=true`. The canonical `flag→c` edge schedules W in T2.
4. React begins a joint `{T1,T2}` pass. W evaluates `c=1`, creating K1 edge `a→c`; the pass then suspends or is discarded as allowed by C1-T7. Edge creation calls `raiseFlag`, but no mechanism replays T1’s earlier receipt into W’s queue.
5. React renders and commits T2 alone. W consumes its T2 update and correctly renders 0 because T1 is excluded; T2 retires.
6. T1 later renders. Its unrelated React work keeps the root active, but W has no T1 lane and can bail out. A sibling reads `c=1`; W’s DOM remains 0.

**Wrong outcome:** T1 commits a torn frame. The retirement reconcile can only issue a second, urgent correction after the bad commit. Edge creation needs retroactive, lane-scoped delivery for every still-live source receipt, not only flag propagation.

### 4. BLOCKER — local to the validity/Suspense stratum — computed fingerprints change on every pure retry

A computed dependency’s fingerprint is its world memo’s `valueStamp`, and every newly created world memo receives a fresh stamp even when its value is equal. A retry normally has a new pin/worldKey, so the prefix comparison cannot remain stable.

**Failing schedule**

1. T writes `a=1`; inner computed `d=a.state` is world-sensitive.
2. Outer computed `c` evaluates `ctx.use(load(d.state))` in lineage L and worldKey `(mask T, pin p1)`.
3. `M(d,w1)` is newly created with value 1 and fresh stamp `v1`; the thenable entry stores prefix `[(d,v1)]` and promise P1.
4. P1 settles and React retries L in a new pass. The first pass itself minted stamps after `p1`, so the retry’s pin and worldKey differ.
5. `M(d,w2)` is newly created with the same value 1 but fresh stamp `v2`.
6. Prefix comparison sees `v2≠v1`, drops the settled P1 entry, accepts newly created P2, and suspends again. Every retry repeats with another fresh stamp.

**Wrong outcome:** a pure retry can refetch and re-suspend forever, failing C15. Nested dependency certificates must preserve content identity across worldKey recreation—for example by flattening stable underlying dependency fingerprints—rather than using per-memo creation identity.

### 5. BLOCKER — architectural — F8 deliberately violates frozen C12 for raw post-`await` writes

The acceptance contract says writes syntactically inside the async action must not commit before that action settles. Section 12 instead assigns a raw post-`await` write to an independent default batch that may retire immediately.

**Failing schedule**

1. Start `startTransition(async () => { a.set(1); await io; a.set(2); await hold; })`, with `hold` unresolved.
2. The first write belongs to parked action token K.
3. After `io`, raw `a.set(2)` receives default token D under F8’s ambient-classification rule.
4. D retires while K remains parked on `hold`; its receipt becomes visible to committed-world renders.
5. An unrelated render before `hold` resolves observes 2.

**Wrong outcome:** action state becomes committed before the action settles, contrary to C12. Meeting the frozen contract requires action attribution across the continuation; documentation or an optional wrapping helper does not repair the required raw form.

### 6. BLOCKER — local fix — mount fixup ignores live default-priority batches

The “live token or retired token” construction in §11.2 actually partitions only live **deferred** tokens versus retired tokens. A live default batch falls into neither corrective path.

**Failing schedule**

1. **Setup:** `a=0`; existing watcher S keeps React work pending; W is not mounted.
2. Default batch D writes `a=1`. S is scheduled in D, so D remains live.
3. Before D renders, `flushSync` mounts W. Its sync pass excludes D, so W renders 0.
4. W’s layout fixup sees `F(a)=1`, but the loop enumerates only live deferred tokens and skips D.
5. The committed-world comparison also returns 0 because D is still unretired, so no urgent correction is scheduled.
6. D later renders S. W has no D update and may bail out, committing beside S with stale 0; retirement reconciliation can only correct it afterward.

**Wrong outcome:** D commits a torn frame. The fixup must cover every live written token that the mounting pass excluded, including urgent-classified default batches.

### 7. HIGH — local fix — pin-blocked retired entries have no compaction trigger when the pin disappears

Compaction is specified only during `onBatchRetired`. `onPassEnd` handles staging eligibility but never revisits entries that retirement could not compact.

**Failing schedule**

1. Pass P starts with pin `p` and yields.
2. A click batch C writes a unique atom and retires with `retiredSeq>p`.
3. C’s retirement cannot compact that entry because P still holds the older pin.
4. P resumes and ends. The entry is now compactable, but no retirement occurs for that atom again.
5. Quiescence requires “tapes compacted” as a precondition, so it cannot perform episode reset or staging reclamation.
6. Repeat with different atoms while short passes hold each retirement open. Each cycle leaves another stranded tape entry; K1, F flags, and abandoned staged nodes accumulate in one never-ending episode.

**Wrong outcome:** memory grows without bound and the engine eventually reaches its non-quiescent sequence horizon despite repeatedly having zero live batches and passes. Advancing/removing the minimum live pin must trigger a deferred-compaction sweep and quiescence recheck.

### 8. HIGH — local fix — `worldMemoEpoch` has no reset, wrap, or saturation construction

The lifecycle table says `worldMemoEpoch` never resets and supplies no width or horizon guard. `episodeEpoch` scopes old records but does not make an incrementing JavaScript number continue changing after its safe-integer horizon.

**Failing schedule**

1. Across forced-small-counter episodes, drive `worldMemoEpoch` to its terminal/colliding value E; globalSeq can renumber independently at each quiescence.
2. Record an effect snapshot at epoch E while `a=0`.
3. T writes `a=1` and then retires.
4. The epoch increment collides back to E—or, for a Number at `2^53`, `E+1===E`.
5. The unified fast predicate sees the snapshot epoch still equal. T is retired and absent from the current mask, so its slot clock is not examined; ladder fingerprint comparison is never entered.

**Wrong outcome:** the effect snapshot validates across a committed value change. Either this epoch must use the guarded global stamp line or it needs its own reset/generation/horizon construction and forced-wrap test.

## Verified held

Conditional on the fork supplying its declared facts:

- C2’s existing-node path held: always logging the default write plus `F∧CT` routing reconstructs both the old atom and computed value in an excluding sync pass.
- C3’s tape fold arithmetic itself held: ordered replay produces urgent 2 and final 4, including the plain-set overwrite variant.
- C4–C6 held when all required edges exist at write time: each write performs a fresh walk, dedup is per slot, and synchronous writer-context delivery preserves lane attribution.
- C7’s execution semantics held: yield clears the pass binding, handler reads/writes use newest ambient context, and the resumed pass’s pin excludes the intervening retirement.
- C8 held: equal newest writes still receive independent receipts.
- C9’s first-read mechanism held: a fresh render-created node is forced through world evaluation rather than a canonical cache.
- C10’s retire-before-layout committed-value comparison held for the deferred/retired race it explicitly covers.
- C11’s value model held: per-root `lockedIn` masks preserve a root’s committed view, and clearing their slot bits before recycle avoids stale-bit aliasing.
- The settlement pending-state belt held against the settle-handler microtask gap for direct atom-prefix Suspense cases.
- The render-write guard, token live-skip allocator, walk-ticket clearing, and K1 tag wrap-clear each had a concrete lifecycle construction that survived their stated schedules.

## Verdict

Verdict: architecturally unsound.  
The tape/rebase core is coherent, but concurrent evaluator identity, notification completeness, atom validity, Suspense identity, and async-action semantics fail concrete schedules.  
The central validity and React-versioning mechanisms require redesign before implementation should begin.