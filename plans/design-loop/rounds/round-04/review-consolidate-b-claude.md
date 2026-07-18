# Review — design-consolidate-b (round 4) — Claude reviewer

Design: `design-loop/rounds/round-04/design-consolidate-b.md`
Method: full battery re-walk (C1–C17), attack on every written construction,
seam enumeration between the six mechanisms, lifecycle audit, fork-honesty
audit, cost-honesty audit. Findings ranked most-severe first. Every finding
carries a concrete failing schedule.

---

## F1 — BLOCKER — The coarse gate's stage conjunct is temporally incomplete: same-pass reads that precede the owner hook's staging are served the old evaluator's value, and no mechanism repairs the frame before commit

**Mechanisms defeated:** §6.1 render read gate (`passStages is empty` →
K0), §8.1 stage selection ("puts it in `passStages` before any read of the
node"), §6.1 world-isolation invariant (its stage step), §7.3 reconcile
backstop, §8.2 publication ordering.

**The hole.** `passStages` becomes nonempty only when the owning hook
*executes* (§8.1 selection happens on "incoming deps", which exist only at
hook run time). Any component rendered earlier in tree order that reads the
stageable node in the same pass reads it *before* the stage exists. The
world-isolation induction's stage step — "the pass table becomes nonempty
before the staged evaluator is read" — quantifies over reads *of the staged
record*, but the pass's world is defined at pass grain: once the stage is
selected, the pass's world value for node `n` is the staged evaluator's
value for the *whole* pass. Pre-stage reads of `n` violated the invariant's
conclusion retroactively, and the induction never covers them. This is the
surviving half of the S23 scar family ("the staging component **and a
sibling** are served f_A's K0 cache"): this design repairs the staging
component's own reads and the post-stage reads, and leaves the
tree-order-earlier sibling exposed.

**Failing schedule (zero receipts — the S23 flavor).**
Setup: root R; App holds `dep=0`; children in tree order S then O. O owns
`n = useComputed(fn, [dep])`, committed evaluator record E0 (f_A over
dep=0), K0 caches `n = v_A`. S subscribes to `n` (same root — legal per
§1.3; also legal via any computed over `n`). All tapes empty
(`receiptCount == 0`).

1. `startTransition(() => setDep(1))` — React state only, token t, **no
   receipt is ever minted** (writes never happen; staging mints no receipt
   per §8.2 — only promoted ReducerAtoms with pending receipts touch tapes).
2. Pass P renders S (it has pending work from App's re-render/props): S
   reads `n` → gate: `receiptCount == 0 && passStages(P) empty` → **K0
   serve, v_A**.
3. P renders O: deps `[1] ≠ [0]` → mint stage record E1 (f_B), put in
   `passStages(P)`; O's read of `n` → world path → **v_B**. Staging is
   render-phase: no `setState` is or can be issued for S (setState during
   another component's render is illegal React).
4. P completes with S showing v_A-derived output and O showing v_B-derived
   output — two evaluator worlds in one candidate frame.
5. Now every branch of the design's own machinery fails to produce a
   correct commit:
   - **§7.3 reconcile reads S's claimed world as a stage-free snapshot** →
     v_A == v_A → check passes → **torn committed frame** (S: old world,
     O: new world). The §8.2 step-2 publication walk then delivers S's
     correction *during/after the commit* — "commit and repair a torn
     frame later", which §7.3 itself forbids.
   - **§7.3 reconcile reads S's claimed world as the pass world (with
     stage)** → v_B ≠ v_A → restart. The restarted pass has
     `passStages = ∅` again (selection is hook-time), S has no pending
     lanes → React **bails S out**; S's watcher now claims its *old
     committed* world, which evaluates with committed f_A → v_A → match →
     **torn committed frame on attempt 2**. If instead the reconcile
     mismatch schedules `setState(S)` in t (late update) and S re-renders,
     S renders before O again, reads K0/committed-f_A v_A again →
     mismatch again → **restart livelock**.
   - The only convergent order — publish f_B first, then let the
     publication walk's setStates force a restart that re-reads the
     now-committed f_B — is not the design's stated order and is
     incoherent with §8.2/§10.3 as written (see F2): reconcile sits
     *after* retirement folds, where "restart that work" is impossible.
6. Variant with `receiptCount > 0` (any unrelated pending receipt): S's
   step-2 read takes the world path but `passStages` is still empty, so
   the effective evaluator for `n` is the committed record f_A → same
   tear. So this is **not** rescued by the receipt half of the gate; the
   world's "effective evaluator" mutates mid-pass and every earlier read
   used the old one. (Aside: the §6.2 memo key omits stage state; only the
   §6.3 stage-id compare in basis validation makes the post-stage read
   recompute — which is what manufactures the intra-pass disagreement.)
7. Variant without S in the pass at all: if S has no pending lanes and
   never re-renders in P, the commit is torn outright (S's committed DOM
   from the old world beside O's new world), corrected one frame late by
   the §8.2 step-2 publication walk — the exact "torn commit corrected one
   frame late" outcome that killed S2.

**Wrong observable:** torn committed frame (or restart livelock) for the
completely ordinary composition "component earlier in tree order reads a
useComputed owned by a later component, during a React-state-only
transition that changes the hook's deps."

**Severity: BLOCKER** (scar family S23 re-opened through a temporal hole;
torn committed frame).

**Judgment: local fix, but it needs real design work, not a sentence.** The
architecture (receipts/worlds/K1/basis) is untouched; the repair is a rule
change inside mechanisms 4–6, e.g.: seed `passStages` at pass start from
the lineage's current noncommitted records (retries then converge), plus a
staging-time tripwire — staging a node the pass has already served (world
memo pinned by this pass, or any K0 serve occurred: one per-pass bit,
since K0 serves are otherwise unrecorded) forces the late-update/restart
path — plus a precise reconcile rule for staged nodes. Each piece needs
its own oscillation (A/B/A) and StrictMode re-walk; the fix interacts with
§8.1 rule 2 lineage reuse.

---

## F2 — HIGH — The commit-order spec contradicts itself: the reconcile backstop is placed after retirement folds and lock publication, where "restart before commit" is impossible

**Mechanisms defeated:** §7.3 reconcile backstop vs §8.2 commit order vs
§10.3 fork invariant vs F3 retirement semantics.

§7.3 promises: "A late update inserted after completed work makes React
restart that work; it is not allowed to commit and repair a torn frame
later," and calls the check "pre-mutation." But §8.2 orders one commit as
(1) publish F9 records, (2) dirty + publication delivery walk, (3) reducer
re-fold, (4) install root lock view, (5) retirements/folds, (6) reconcile
checks, then layout; §10.3 repeats "F9 emission, root lock publication,
retirement folds, reconcile, and layout occur in that order."

**Failing schedule.** Any schedule where the check must fire — e.g. F1
step 5, or C10 step 6's "edge created after k write" racing the commit:
1. Pass completes; commit sequence runs steps 1–5: F9 publishes, the lock
   view swaps, and token t **retires** (its receipts stamped, slot
   released).
2. Step 6 reconcile finds a watcher whose rendered value mismatches its
   claimed world (late edge-add delivery landed after that fiber
   completed).
3. "Restart that work": the work being restarted was t's render, but t
   retired at step 5 (F3: retirement is exactly-once and final; `runInBatch`
   on t now returns `RETIRED`), the lock view already published, and F9
   records are "committed ownership." There is no coherent state to
   restart into: either the restart runs against a token that no longer
   exists (crash/undefined), or the implementation lets the commit proceed
   → **torn committed frame repaired later**, violating §7.3's own
   invariant.

Fork test 14 pins "updates inserted after completed work force restart
before commit," which is unimplementable from step 6's position. Either
the backstop is actually React's pre-commit interleaved-update check
(before step 1) — in which case the F1 analysis shows publication-walk
setStates land after it and torn frames commit — or it is the §7.1
equality-retention compare (which cannot restart anything). The design
leans on this backstop in C10 step 6, §7.3, and (implicitly) every
mid-pass cross-root divergence, and never walks a single
reconcile-triggered restart.

**Severity: HIGH.** **Judgment: local fix** (specify the check's position,
its evaluation world — claimed-world snapshot vs pass world reference —
its coverage of bailed-out-but-subscribed watchers, and the restart
semantics relative to steps 1–5; then walk one restart end-to-end). It is
load-bearing enough that leaving it ambiguous forfeits several of the
design's other defenses.

---

## F3 — HIGH — Cross-root mid-pass divergence from owner-root publication relies entirely on the F2-ambiguous backstop; the single-owner check is subscription-grain and misses indirect reads

**Mechanisms defeated:** §1.3 owner-root restriction, §8.2 publication,
§6.1 world-isolation induction (its promotion step covers same-root only),
F2's same-root-only discard.

The owner-root check throws only "at subscription time" (§1.3, §8.3). A
root-B computed `c_B = g(n)` over root-A-owned stageable `n`, with a
root-B watcher on `c_B`, is legal — the check never sees the tracked read.
The committed evaluator/reducer pointer is global (one committed record
per node), so root A's commit flips it for root B's evaluations
mid-flight. F2 discards *same-root* resumable passes before publication;
root B's pass survives.

**Failing schedule.**
Setup: hook ReducerAtom RA (or useComputed n) owned by root A, committed
reducer r0; root B computed `c_B` over it with a root-B watcher; spanning
transition T dispatched actions on RA (`receiptCount > 0`).
1. Root B pass Q starts (pin q), renders some components; their reads fold
   RA's visible receipts under committed r0; Q yields.
2. Root A commits: F9 publishes staged r1, re-folds RA's pending receipts
   under r1, delivery walk runs (§8.2 steps 1–3).
3. Q resumes. Q's later reads fold the *same* receipts under the new
   committed pointer r1 (the basis reducer-stage-id fact moved, so pinned
   memos invalidate and re-fold) → values disagree with Q's pre-yield
   slices. One pass, two reducers.
4. Q completes. Correctness now depends entirely on the §7.3 backstop
   catching every stale-rendered watcher: under F2's step-6 placement it
   cannot restart (tokens already retiring); under the "rendered by the
   candidate commit" wording, a bailed-out subtree that rendered r0 values
   in an *earlier* commit escapes the comparison; if it does catch, the
   cost is a full cross-root restart per owner-root publication —
   unpriced (no gate row covers cross-root restart storms under
   publication traffic).

Wrong observable in the uncaught branches: root B commits a frame mixing
r0-fold and r1-fold values — torn frame. Same schedule with zero receipts
and a staged computed evaluator (pure `setDep` transition on A; B's
in-flight pass K0-reads n before promotion, K0-reads a dirtied dependent
after) tears the same way.

**Severity: HIGH** (schedule is concrete; the outcome ranges from torn
frame to unpriced restart storm depending on how F2 is resolved).
**Judgment: local fix.** Either extend the owner check to evaluation grain
— a world evaluation whose `world.rootId ≠ ownerRoot(n)` throws on reading
a stageable node (detectable at the read; then walk which cross-root
compositions remain legal per the preamble rule) — or specify the backstop
per F2 and add a cross-root publication row to the gate table.

---

## F4 — MEDIUM — `renderCycle` is a lifecycle-bearing counter missing from the §11 table

Watcher delivery dedup is keyed `(watcher, s, slotGen, renderCycle)` (§5,
§7.1). The §11 table — which the design itself declares complete ("every
reusable number is paired with…", C13 step 9 "run all counters at 2- or
3-bit horizons") — has no `renderCycle` row: nothing states who mints it,
what retains it, or its wrap/collision defense. C13 requires every counter
enumerated with its guard.

**Failing schedule (if implemented as a small per-watcher counter, as the
name suggests):** watcher W long-lived; render cycles advance until
`renderCycle` wraps to a value for which W's `(slot, slotGen)` bit from an
un-cleared prior cycle is still set (slot recycled through gen g back to a
colliding pair while W never rendered in the interim — forced-small
horizons make this cheap); a new write in that token then finds the dedup
bit already set → delivery skipped with no scheduled React work → **missed
re-render / stale committed frame**. Whether this is reachable depends on
unstated clear sites — which is exactly the C13 discipline violation.

**Severity: MEDIUM.** **Judgment: local fix** (add the row: mint/clear
sites, retention, wrap defense; add the forced-wrap test).

---

## F5 — MEDIUM — §7.4's effect trigger "a root commit containing a reached token" is ambiguous across roots; the own-root reading leaves committed effects stale for an io-gated duration (S26-adjacent)

Committed evaluator/reducer promotion is global (one committed record),
happens at the *owner* root's commit, and can change committed-for-B
evaluations with no receipt and no lock-view change on B. The promotion
walk stamps reach and touched lists in the committing batch context, so
the durable machinery can drain B's reached effects at A's commit — but
only under the "any root's commit" reading of trigger 1. Under the
own-root reading nothing fires for B until the token's *global*
retirement, which waits on async-action parking (F3/F8).

**Failing schedule:** spanning transition T (parked on io); root A commits
and promotes r1, re-folding RA; root-B `useSignalEffect` whose basis
includes an RA-derived value: no B commit occurs, B's lock view unchanged,
T's retirement is io-gated → the effect observes r0-derived state for the
full parked duration despite the committed pointer having moved — the
consumable-trigger staleness class S26 was minted for, here caused by
scoping rather than consumption. **Wrong observable:** committed effect
reads stale committed state, unbounded (io-gated) delay.

**Severity: MEDIUM.** **Judgment: local fix** — one sentence scoping
trigger 1 globally (drain all reached effects at any root commit of the
token), which the durable touched lists already support.

---

## Verified held (attacked and survived)

1. **The receipt half of the coarse gate (the round's central bet) held
   everything I threw at it.** A1's schedule plus my extensions:
   append-precedes-K0-mutation means no callback observes changed K0 at
   `receiptCount == 0`; tracked parents over untracked children need no
   propagation (any embedded pending value implies count > 0 globally);
   DIRECT→LOGGED activation at import (S6-proof, monotonic); yield-gap
   NEWEST reads creating fresh K0 caches cannot be served to any pinned
   pass while history exists; count can reach zero only after compaction,
   at which point every foldable value is committed-for-every-pass — the
   round-3 taint blocker (I33) is genuinely deleted, not patched.
2. **Pin-gated compaction + immediate slot release (I10/I39 replacement)
   held.** A8 re-walked plus: post-pin retirement fails the compaction
   predicate (retiredSeq and pins share the `globalSeq` line, I15);
   recycled `(slot, slotGen)` cannot fold into an old pass because clause
   2/3 seq-vs-pin comparisons exclude post-pin writes even under forced
   slotGen wrap-around with a live old pass; wc/mask/dedup consumers all
   carry generations. The saturation machine's deletion is sound because
   reach bits no longer authorize any render read.
3. **C2/C3/C8 (always-log, rebase parity, equality-drop rule).** Fold
   clauses reproduce React's lane-filtered queue; the empty-tape drop is
   world-invariant-op-only (I38a: stageable reducers always append);
   compaction preserves replay order across skipped entries.
4. **walkGen non-nesting (A2) held**: full walks run no user code
   (equality/reducers run before the walk; setState only enqueues),
   edge-add carries are monotone-frontier and their deliveries drain
   deferred — `walkDepth ≤ 1` stands, pinned by fork test 14 and the dev
   throw.
5. **E-PRESERVE strong reading held, including the evaluator-retrack
   variant**: a retrack with `receiptCount == 0` can only be caused by
   publication-dirty, and post-publication no reachable world can evaluate
   the old evaluator, so dropping removed edges is safe; write-caused
   retracks always follow an append.
6. **Mount fixup (A9/C9/C10) held**: skip is inclusion+clock (I43), the
   unconditional committed compare is equality-based fallback exactly as
   I18 prescribes (re-ran S10's two-token schedule — corrections are
   per-live-reached-token, unconditional, so subset divergence cannot hide);
   fresh nodes acquire reach via edge-add carry before commit; the
   RETIRED race returns to the urgent fallback; own-pass mounts compare
   equal because lock-in precedes layout.
7. **Immutable lock views (A3) held**: same-root discard-before-swap plus
   root-scoped ids reproduce I34's two stamps; retirement orders
   stamp → view-removal → durable drain → clear, so the TL is intact at
   every consumer; watermark advances re-mint the id (I21 flips covered by
   `retireVisStamp` + `lockViewId`); post-await writes stay watermark-capped
   (I25) and retirement waits for all root work, so clause-1 widening at
   retirement cannot contradict a root's DOM.
8. **Basis change-source enumeration is closed per I16**: writes (visible
   seq), compaction (base seq), retirement flips (retireVisStamp), lock
   flips (header lockViewId), settlement (settlementVersion), evaluator
   identity (stageId), episode/generations. Capsule revalidation is
   value-first (I35), lineage-stable ids (I40) survive pure retries and
   A/B/A oscillation (A4), owning-evaluator moves refetch (correctly
   conservative).
9. **Memo records keyed by pin with per-pass pinning** cannot reproduce
   S13's powerset retention (records die with their passes) or S18's
   cross-pass sharing (no two passes share a key); the restart
   revalidation cost is honestly routed to O18's typeahead gate.
10. **Async boundary (C12/A7)** conforms to I26/I30/I36/I37/D17: liveness
    checked at every continuation entry, nested capture stack-correct,
    MessagePort boundary exact, no runSync surface.
11. **Cost honesty**: every hot mechanism has a gate row; the coarse-gate
    cost and O19's quiet floor are declared at-risk rather than assumed;
    unmeasured rows are release-blocking; no measured fact is contradicted.

---

## Verdict

The consolidation's receipt arithmetic is the strongest version of this
architecture yet — the coarse `receiptCount` gate, pin-gated compaction,
and immediate slot release survived every schedule I constructed,
including the round-3 blockers they were built to delete. But the stage
half of the same gate has a temporal hole (F1) that re-opens the S23 scar
family with a torn committed frame in an ordinary composition, and the
design's only escape hatch — the reconcile backstop — is specified in a
self-contradictory order (F2) and silently carries all cross-root
publication consistency (F3). **Verdict: repairable** — the fixes are rule
changes inside existing mechanisms (stage seeding/restart discipline, a
precisely placed and walked backstop, read-grain owner enforcement), not
new planes, but F1 must be repaired and re-walked before this is
implementation-ready.
