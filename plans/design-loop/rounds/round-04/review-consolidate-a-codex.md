# Adversarial correctness review: Round 4 consolidate-a

## Findings

### 1. F9 promotion can change the reducer halfway through another root’s render

**BLOCKER — architectural.**

The pass’s effective evaluator is “staged in this pass, else the committed evaluator” ([§2](/Users/jitl/src/alien-signals-opt/design-loop/rounds/round-04/design-consolidate-a.md:200)). F9 replaces that committed evaluator globally, while F2 only invalidates open passes on the committing root ([§14 F2](/Users/jitl/src/alien-signals-opt/design-loop/rounds/round-04/design-consolidate-a.md:950)). The evaluator vector detects the change but does not preserve the pass’s original evaluator.

Setup: shared ReducerAtom `ra=0`; live receipts `X: inc`, then `Y: dec`. Reducer `r0` maps them to `+1/-1`; staged reducer `r1` maps them to `+10/-10`. NEWEST is `0` under both reducers, while world `{X}` is respectively `1` or `10`.

| step | actor/mechanism | state and outcome |
|---|---|---|
| 1 | Root B starts pass `P_B` with mask `{X}` under committed `r0` | Sibling B1 reads `ra=1`; the pass yields. |
| 2 | Root A commits a hook staging `r1` | F9 globally installs `r1`. P3 re-folds NEWEST over `{X,Y}` as `0→0`, so its value-gated notification walk does not run ([P3](/Users/jitl/src/alien-signals-opt/design-loop/rounds/round-04/design-consolidate-a.md:743)). Root B is not discarded because this is a cross-root commit. |
| 3 | `P_B` resumes | Its current effective reducer is now committed `r1`. The evaluator-vector check rejects any `r0` memo and B2 folds `{X}` to `10`. |
| 4 | Root B commits | One frame contains B1=`1` and B2=`10`, matching no world or reducer version. |

`committedAdvanceSeq` is only a fast-out and cannot invalidate the open pass. Repair requires either pass-stable evaluator snapshots with versioned history, or a fork guarantee that promotion aborts and reschedules every affected open cross-root pass; ordinary value-gated P3 delivery is insufficient.

### 2. Same-slot dedup loses writes occurring after an included pass’s pin

**BLOCKER — architectural.**

Dedup is one bit per watcher and slot, cleared only when that watcher renders ([§10.1](/Users/jitl/src/alien-signals-opt/design-loop/rounds/round-04/design-consolidate-a.md:664)). A pass includes same-token receipts only through its frozen pin, so the design’s assertion that an already-pending render reads the latest same-slot write is false when that write occurs after pass start.

Setup: mounted watcher W reads atom `a=0`; async transition T remains parked and can resume during yield gaps.

| step | actor/mechanism | state and outcome |
|---|---|---|
| 1 | T writes `a=1` | Receipt `s1`; `(W,T)` dedup becomes set and W receives a T-lane update. |
| 2 | T pass P starts with pin `p ≥ s1`, then yields before W renders | The dedup bit remains set. |
| 3 | A carried T continuation writes `a=2` at `s2 > p` | The write walk reaches W, but the still-set `(W,T)` bit suppresses the only setter. |
| 4 | P resumes and renders W | Visibility admits T entries only where `seq ≤ p` ([§5.2](/Users/jitl/src/alien-signals-opt/design-loop/rounds/round-04/design-consolidate-a.md:334)), so W renders `1`; only now does it re-arm the bit. P commits and locks T through `p`. |
| 5 | T later updates an unrelated memoized sibling Z | A new T pass with pin `p2 ≥ s2` commits, but W has no queued update and bails out. F3 advances the root-wide T watermark to `p2`, making `a=2` committed-for-root while W’s DOM remains `1`. |

The lock-advance walk can schedule a later correction, but it cannot modify the already-completed tree; the design’s own walk-atomicity rule says setters do not synchronously render. A sound repair needs dedup state tied to the maximum write sequence actually covered by scheduled/rendered work, or a pass-end `wc` validation that discards a pass whose included slots advanced beyond its pin.

### 3. Abandoned fresh hooks leak permanent K0 arena nodes

**BLOCKER — architectural.**

The fresh-node walk allocates and evaluates a new K0 node during render ([C9(b)](/Users/jitl/src/alien-signals-opt/design-loop/rounds/round-04/design-consolidate-a.md:1316)). Discard handling reclaims evaluator stages, but neither the lifecycle table nor P4 defines reclamation for the bump-allocated K0 node itself. This repeats the exact dead approach recorded by SCAR S15 ([SCARS](/Users/jitl/src/alien-signals-opt/design-loop/NOTES/SCARS.md:102)).

| step | actor/mechanism | state and outcome |
|---|---|---|
| 1 | An initial mount invokes `useComputed` | A fresh K0 record and associated K1 edges/memo state are allocated during render. |
| 2 | The subtree suspends, is interrupted, or is the discarded StrictMode invocation | No layout subscription or cleanup ever exists; F9 does not publish. |
| 3 | `publicationsComplete`/lineage death runs | It reclaims the unpublished stage only ([P4](/Users/jitl/src/alien-signals-opt/design-loop/rounds/round-04/design-consolidate-a.md:749)); no rule frees or reuses the K0 record. |
| 4 | React retries the uncommitted mount | A new hook/node identity allocates another bump record. |
| 5 | Repeat | K0 grows without bound until arena growth or OOM crashes the process. |

K1 episode resets do not reclaim K0. This needs a render-local node staging protocol or a generation-safe arena reclamation scheme; ordinary hook cleanup cannot repair a subtree that never committed.

### 4. Mount fixup mistakes lock membership for full-prefix inclusion

**BLOCKER — local fix.**

The fixup skips a live token whenever its slot is in either the rendered mask or lock view and `wc[s] ≤ renderPin` ([§11.2](/Users/jitl/src/alien-signals-opt/design-loop/rounds/round-04/design-consolidate-a.md:762)). Lock visibility is actually bounded by the lock’s watermark, not the render pin.

Setup: parked transition T writes `a=1`; root R commits that prefix and records watermark `p1`. T then writes `a=2` at `s2>p1` before W mounts.

| step | actor/mechanism | state and outcome |
|---|---|---|
| 1 | An unrelated pass U starts after `s2` and mounts W | Its pin `p3>s2`, mask excludes T, and captured lock view contains T only through `p1`; W correctly renders `1`. |
| 2 | Layout fixup examines T | T is live, its slot is in the lock view, and `wc[T]=s2≤p3`; the union predicate skips `runInBatch(T, setStateW)`. |
| 3 | `w_fx` comparison runs or fast-outs | `w_fx` uses the same T watermark `p1`, so it also reads `1`; no committed-side correction fires. |
| 4 | A later T pass, driven by another subtree, advances R’s watermark through `s2` | W has no T-lane update and can bail out. The commit exposes `a=2` to R while W’s DOM remains `1`; any lock-advance correction occurs only afterward. |

The skip threshold must be computed separately: mask inclusion is bounded by `w_r.pin`, while lock inclusion is bounded by `LV[slot].watermark`. Equivalently, skip only when `wc[s]` is no greater than the maximum visibility bound actually supplied by those two clauses.

### 5. `globalSeq` has no live-episode rollover protocol

**BLOCKER — architectural.**

All writes, pins, retirement stamps, and evaluator stamps share one monotone counter ([§2](/Users/jitl/src/alien-signals-opt/design-loop/rounds/round-04/design-consolidate-a.md:158)), but it is renumbered only at full quiescence ([§5.5](/Users/jitl/src/alien-signals-opt/design-loop/rounds/round-04/design-consolidate-a.md:404)). The claimed C13 forced-wrap coverage never explains rollover while a pin prevents quiescence.

Under the required forced-small-counter test, let the counter wrap at 8:

| step | actor/mechanism | state and outcome |
|---|---|---|
| 1 | Pass P starts at pin `6` and renders fresh sibling A reading atom `a=0` | P yields before fresh sibling B renders; neither has mounted a watcher yet. |
| 2 | Yield-gap store-only operations advance `globalSeq` through wrap | P’s live pin prevents episode reset and renumbering. |
| 3 | Excluded batch D writes `a=1` at wrapped sequence `0` and retires at stamp `1` | Plain numeric ordering now says `retiredSeq=1 ≤ pin=6`, although D happened after P started. The same false comparison also allows pin-gated compaction into base. |
| 4 | P resumes and sibling B reads `a` | The retired clause or prematurely advanced base yields `1`; sibling A remains `0`. |
| 5 | P commits | The frame is torn solely because the sequence order wrapped inside a live episode. |

An epoch changed only at quiescence cannot distinguish these values. The design needs a live rollover/era protocol, non-wrapping representation with an explicit enforced horizon, or an atomic renumbering construction that rewrites live pins, receipts, stamps, watermarks, and memo thresholds.

## Verified held

- I could not break C2’s atom/computed pairing: always-log plus downstream touched propagation forces both reads through the excluding world.
- C3’s `+1`/`×2` rebase arithmetic holds because compaction cannot cross an unretired earlier receipt and folds remain sequence ordered.
- The merged TAINT bit survives the tracked-serve and equality-cutoff attacks: 0→1 propagation reaches already-clean downstream nodes, while pin-gated compaction prevents a live excluding pass from being stranded by a clear.
- Saturation preserves values: force-clear removes slot bits but retains entries, and `fastPathDisabled` keeps older pinned passes off K0.
- Receipt lock views themselves remain stable across cross-root commits: immutable per-root views and watermarks prevent post-await writes from leaking before a later root commit. This does not rescue the separate evaluator-publication or mount-fixup failures above.
- The walk-reentrancy proof holds under the stated fork behavior: walks invoke no signal-capable user callback, setters only enqueue, and effect execution begins after the walk returns.
- Suspense validation correctly catches a staged reducer through its effective stamp, while fingerprint-only movement re-folds before discarding a settled resource.
- Shimmed scheduler continuation capture and retired-token liveness fallback survive the timer, nested-registration, and fire-and-forget schedules within the declared support matrix.

## Verdict

Architecturally unsound in its present form. The receipt/fold core, taint propagation, saturation handling, and basic rebase arithmetic are promising, but evaluator publication, notification coverage, fresh-node lifecycle, and counter rollover do not preserve the design’s claimed invariants. Do not implement until the four architectural blockers and the lock-watermark predicate are repaired and the combined schedules above are re-walked.

