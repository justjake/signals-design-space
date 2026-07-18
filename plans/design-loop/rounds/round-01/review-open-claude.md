# Review: design-open.md (exact projection worlds) — Claude reviewer, round 1

Scope: adversarial correctness review per `SEEDS/prompts/reviewer-claude.md`.
I re-walked C1–C17 against the design's own mechanisms, attacked every
written construction (15.1–15.4, 6.3, 7.2), and probed mechanism-pair seams.
Findings ranked most-severe first. Section references are to design-open.md.

---

## F1 — BLOCKER (local fix): retirement kills the liveness of equality-retained
divergent topology; a later write to the new branch's dep is never delivered

**Mechanisms defeated:** M4 liveness rules (§6.3) × M2 retirement
canonicalization (§5.2) × M1 head-alias topology maintenance (§4.2). The §7.2
induction's inductive step ("after every reached write, the after-world's
actual links are retained") holds only while the writing batch is live;
nothing transfers the corrected topology to anything that stays walkable
after retirement.

**Failing schedule** (wrong committed value, missed re-render, no recovery):

1. Committed: `flag=true, a=0, b=0, z=0`; `c = flag ? a : b`; mounted watcher
   W on `c`. W last mounted via a head-equivalent pass, so W's "current
   graph" is the head alias; head links for `c` are `{flag, a}`.
2. Batch D (default-priority, unrelated) writes `z=1` and stays live
   (pending render). Head applies it. This is only needed to make later
   projection pulls non-head-equal.
3. Transition k writes `flag=false`. Step-1 head walk from `flag` reaches W
   via the old `flag→c` link. Writer pair: `before` = committed (`flag=true,
   a=0` → c=0) vs `after` = committed+k (`flag=false, b=0` → c=0) — **equal,
   setState correctly suppressed**. Per §7.1(4) the after graph is retained
   as frontier F with real edges `{flag→c, b→c}`, owner `{k}`. Crucially,
   the after-world selection (committed+k) **excludes D's receipt** and is
   therefore not head-equal, so this pull is a pure sparse evaluation: the
   head's links for `c` remain the stale `{flag, a}` (head `c` is marked
   possibly-stale but never recomputed — nobody reads head `c`).
4. k retires with no W render (its only projection compared equal). §5.2
   canonicalization removes k from F's owner set → owner set empty. Per
   §6.3, F is now live for **no** reason: it is not any watcher's current
   graph (W's current graph updates only at layout publication, and W never
   re-rendered), no open pass owns it, no live batch owns it, no layout
   check holds it. The new committed world is `flag=false` (c's true
   dependency cone is now `{flag, b}`), and its graph — the canonicalized F
   — is unreachable by notification walks.
5. Urgent U writes `b=7`. Step-1 head walk from `b`: head links for `c` are
   still `{flag, a}` — no `b→c` edge — W not reached. Step-3 sparse walk:
   the only graph with a `b→c` edge is F, which is not live. **No candidate
   is found.** No setState, no frontier, no entry in U's touched list.
6. U retires (no-work); §9.4 reconciliation iterates U's touched list —
   empty. D later retires — W untouched by D. Committed world is now
   `c = 7`; W's committed DOM shows `c = 0` indefinitely. Only a future
   write to `flag` or `a` (atoms in the stale link set) can ever repair it.

**Wrong observable outcome:** stale committed frame (missed re-render) that
persists after *all* batches retire — the exact symptom class of S2/S3,
reproduced here not by missing per-world edges (the design has them) but by
a lifetime rule that expires them at retirement. `useSignalEffect` and
render consumers are reached by the same walks and inherit the same hole
(an effect whose queueing write is equality-suppressed-but-branch-changing,
followed by retirement, then a write to the new branch dep, never runs).

**Why the design's own defenses don't fire:** (a) the head-equal-pull
rescue — when k is the *only* live batch, the after pull aliases the head
cache and retracks head links — is defeated by any second live batch
(step 2); (b) §9.4 retirement reconciliation compares *values* of touched
watchers, not topology, and W's values were equal at retirement; (c) §5.2's
"memo records may be referenced by an alias" gives the new committed world
correct *records* but no *liveness*.

**Judgment: local fix** — the machinery all exists; the missing rule is at
the M2/M4/M6 seam. Two candidate repairs, either sufficient: (1) make the
current committed world's graph a first-class live walk root, and at
retirement rebind each touched watcher's / effect's current graph to the
canonicalized committed graph (touched lists already exist); or (2) at
retirement canonicalization, eagerly re-pull every dirty head node covered
by a canonicalized frontier so head links retrack (the head fold and the
new committed world select the same dependency structure here). Whichever
is chosen must be added to §7.2's induction as the retirement step — the
induction is currently silent across retirement, which is exactly where it
breaks.

---

## F2 — HIGH (local fix): layout late-join check tests per-token projections
only; joint multi-token divergence commits a torn frame and is never
reconciled

**Mechanisms defeated:** M6 layout subscription check (§9.2 steps 1–4) ×
React's multi-batch passes (§8.1 onPassBatch; the design's own C1-T7a
accepts passes including several live batches).

**Failing schedule:**

1. Committed `x1=0, x2=0`; `c = x1 & x2` (non-short-circuit; committed deps
   `{x1, x2}`), committed value 0. Transitions t1 and t2 are live: t1 wrote
   `x1=1`, t2 wrote `x2=1`, both **before** W exists. (Any watchers present
   at write time are handled by frontier compounding — see verified-held V3
   — but W is not mounted yet, so no frontier involving W's output exists.)
2. An urgent render mounts W reading `c` in the committed world; rendered
   box = 0. Layout attach (§9.2): step 1, rendered vs committed: 0 = 0.
   Step 2, per live token: project(committed, t1, tail) → `1 & 0 = 0` =
   rendered; project(committed, t2, tail) → `0 & 1 = 0` = rendered. **No
   differing live projection → no runInBatch correction for either token.**
3. React renders t1+t2 together (one pass, both batches included — legal
   and common; suspension of a third batch can force any subset). W has no
   scheduled work in t1 or t2 lanes → React bails out on W. Siblings render
   the pass world `x1=1, x2=1, c=1`; W's fiber keeps `c=0`.
4. The pass commits: **torn committed frame** (siblings show the t1+t2
   world; W shows the committed world for the same logical version). §9.4
   cannot repair it: W is on neither t1's nor t2's touched list (the walks
   ran before W mounted), so retirement reconciliation never compares W.
   Committed world after both retire has `c=1`; W shows 0 until an
   unrelated write happens to reach it.

**Why per-token is insufficient in principle:** for any k live tokens the
adversary needs only f(base+ti) = f(base) for each i but f(base+S) ≠ f(base)
for some subset S React renders together (`x1 & x2 & !x3` defeats even
"also check the all-live-tokens world": singletons and the full set compare
equal while {t1,t2} differs). Exhaustive subset checking is exponential, so
equality-filtered correction cannot be patched by adding more comparisons.

**Judgment: local fix** — replace the equality-filtered per-token check at
attach with a reach-based one: schedule `runInBatch(t, setState)` for every
live token t whose receipt tape intersects the watcher's rendered
dependency read set (the rendered world's real links are already recorded).
This over-renders (a t1-only pass re-renders W to an equal value — harmless
bailout via equality at render) but is sound for every subset, because any
pass including any intersecting token now re-renders W in that pass's exact
world. The C10 walk itself (single token) is correct as written; the gap is
only the multi-token join.

---

## F3 — HIGH (architectural risk, likely repairable with a new argument):
compounding (v, k) frontier retention grows the live-graph family toward
the powerset of live batches; unpriced, and SP-R2's gate mismodels it

**Mechanisms:** M4 frontier retention (§7.1 step 4: retain the after graph
per (v, k)) × §7.2's multi-batch induction (which *relies* on performing
the operation "from every live base world and projection owner").

**Failing schedule (cost/memory blowup, not wrong values):** one watched
computed reads atoms written by n live transitions, writes interleaved
round-robin. Write in t1 over base V0 retains F{t1}. Write in t2 walks V0
and F{t1}, retaining F{t2} and F{t1,t2}. Write in t3 retains F{t3},
F{t1,t3}, F{t2,t3}, F{t1,t2,t3} — the retained family doubles per batch:
**2^n live graphs** (owner-set distinct frontiers are superseded only by
the same (v, k) pair; canonicalization merges only at retirement). Each
subsequent write performs before/after/baseAfter pulls per live graph
(§7.1 steps 3–5). At n=10 that is ~1024 graphs and thousands of projected
pulls per write while all ten stay live; at the architecture's admitted 31
live batches the bound is 2^31, yet §14's SP-R2 tests "1, 2, 8, and 31
live graph references" and gates slope per *graph* — the gate's independent
variable is not bounded by 31 as the table implies, so the gate as designed
cannot certify the worst case. Observable failure: unbounded plane growth
and write-path stalls (jank/OOM) under a plausible dashboard shape
(many concurrent transitions over shared derived state).

**Why it is not merely a test-matrix fix:** §7.2's multi-batch induction
currently *requires* the full owner-set family (each subset is the world
some future pass may render — the same fact that makes F2's exhaustive
check exponential). Capping or merging frontiers therefore needs a new
soundness argument (e.g., one per-watcher union frontier whose edges carry
owner bitmasks, with runInBatch delivery decided per-token from the union —
plausible, since ≤31 batches fit a mask, but it is a redesign of M4's
retention rule with its own proof obligation, not a parameter change).

**Judgment:** architectural pressure on M4's retention rule; the fix looks
containable (owner-mask union frontiers) but must be designed and proved,
and SP-R2 must be re-specified against the true worst case. Without it the
cost model's "v" row and P3/P4 claims are not honest for multi-transition
workloads.

---

## F4 — MEDIUM (local fix): a detached head-equivalent pass can observe two
identities for one logical value within a single pass

**Mechanisms:** M1 head aliasing (§4.2 detach-before-append) × M3 sparse
re-evaluation (§6.2).

**Failing schedule:** pass P (head-equivalent) reads object-valued computed
`c` (default `Object.is` equality) through the head cache → box O1; P
yields; a click writes a dependency of `c` (detach P, append, head later
recomputes `c` to a new box); P resumes and a second component reads `c` →
sparse record miss → re-verification candidate is the head memo, whose
recorded dependency values no longer match P's captured world → verification
fails → re-run in P's world → fresh box O2. O2 is structurally equal to O1
but `O1 !== O2`: one committed frame in which two siblings received
different references for the same signal read (breaks `React.memo` /
context-identity stability inside one commit; React's own state never does
this within a pass). Values are not wrong — this is an identity tear only,
which is why it is MEDIUM.

**Fix:** at detach time the old head is by construction still exactly the
pass's captured selection (§4.2 detaches before any append), and the pass
already records every consumed logical output and its box (§6.3); seed the
captured world's memo records with those boxes at detach. One rule, no new
state.

---

## F5 — MEDIUM (local fix): the render-write guard is specified only for
sparse-world evaluation; head-equivalent pass renders have no defined guard

**Mechanisms:** §4.3 ("Every sparse world evaluation sets a stricter write
guard") vs §4.2 head-aliasing passes; C14 step 2 and C9 assert throws whose
mechanism is defined only on the sparse path.

**Failing schedule:** StrictMode dev, no live batches; initial mount pass is
head-equivalent (aliases head, no sparse evaluation ever runs). A component
body calls `atom.set(1)` (user bug the battery requires rejecting). As
specified, nothing throws: the write runs `claimWrite`, detaches every open
aliasing pass — including the *currently rendering* one, mid-render — then
appends and mutates the head. StrictMode replays the render → a second
receipt for the same logical write (double-fire), plus a pass that silently
stops seeing its own environment. This contradicts the design's own C14
walk ("Sparse-world guard throws before claimWrite") and R8 ("render-world
evaluation always rejects writes").

**Fix:** one sentence — the React-mode write entry throws whenever the
call-stack pass binding is occupied (which also covers head-equivalent
passes and matches C7, where the binding is empty in yield gaps); add the
StrictMode head-equivalent render-write test.

---

## F6 — MEDIUM (local fix): a pending thenable is a retaining ref for its
suspense cell, so one abandoned fetch blocks episode compaction for the
session

**Mechanisms:** M7 cell lifetime (§10: "Cells remain until all lineage,
frontier, pass, and pending-thenable refs release them") × M2 quiescence
(§5.2: compaction requires "no ... pending suspense cell").

**Failing schedule:** transition k suspends `c` on a fetch that never
settles (user navigates away; request abandoned). React discards the pass
and k retires aborted; lineage and frontier refs release. The
pending-thenable ref alone keeps the cell live → the cell holds its exact
world → §5.2's quiescence condition ("no pending suspense cell") is never
met → receipt tapes are never folded into bases for the remainder of the
session; every subsequent write's receipt is retained. Observable: unbounded
tape growth (memory) proportional to total write traffic, triggered by one
hung promise. §19 discusses history pressure for *live* transitions only;
this is a dead batch retaining history.

**Fix:** drop pending-thenable as a retaining ref: release the cell at
lineage/frontier/pass ref-zero regardless of settlement — the
generation-checked late continuation (§10, §12 memo/stage row) already
makes a late settle on a released cell a safe no-op.

---

## Verified held (attacks attempted and failed)

- **V1 — C3 / §15.2 replay parity.** Fold-in-global-write-order over the
  episode base with retirement-pin + cutoff visibility reproduces React's
  skip-and-rebase exactly in my re-walk, including the 4-not-3 arithmetic
  and the replacing-set-after-pending-updater = 5 subcase (I2 satisfied).
- **V2 — C2 flushSync exclusion.** The flushSync pass is provably not
  head-equivalent (D's receipt is in head but not selected), so both the
  atom and the downstream computed evaluate in the same sparse world;
  `{a:0, c:10}` with no canonical-cache fallback path in the walk (I1
  honored: every write logs).
- **V3 — C1 family T1–T7, mounted-watcher joint divergence included.** The
  equality-retained frontier plus owner-set projection catches T4/T5 (the
  after≠baseAfter branch delivers `runInBatch(k)`), and for a *mounted*
  watcher the compounding frontiers catch even the `x1 & x2` joint case
  while both batches are live (t2's write walks F{t1} and schedules t1-lane
  work). The joint gap survives only at layout late-join (F2) and after
  retirement (F1).
- **V4 — C8 / §15.3.** Always-append with equality at fold/notify time
  holds; head-equal suppression of head *propagation* cannot erase the
  receipt another world selects (I7 honored).
- **V5 — C7 / S7.** The call-stack binding maintained by YIELD/RESUME edges
  gives handlers head reads and legally classified writes; the detached
  pass's immutable cutoff excludes the click receipt on resume. I could not
  construct a wall-clock misclassification.
- **V6 — C4 per-write delivery (I5).** Walk tickets are per write; the
  second batch's walk re-reaches the watcher from every live base; no
  ARMED-bit dedup exists to defeat.
- **V7 — C12 / S4.** Retirement persists writes with `committed=false`;
  async parking via the fork action context; no subscription-dependent
  persistence anywhere I could find.
- **V8 — C13 / §12.** The counter table is the strongest lifecycle story in
  the design: every counter I inventoried (including walk tickets, slot
  generations, interner hashes-as-non-identities) has a paired guard and a
  forced-wrap test (I8). I could not construct a cross-episode validation.
- **V9 — S5 avoided.** Re-verification reads the *complete* recorded
  dependency list ("not a list filtered to concurrent atoms"), with
  bottom-up nested verification — the certificate scar does not recur.
- **V10 — S6 avoided.** Activation is monotonic on bridge install
  (prototype swap), not watcher-count-keyed; the first-watcher-mid-
  transition schedule reads correctly.
- **V11 — C15/C9 suspense identity.** The exact-world tuple key plus stable
  cell/stage/position, with lineage as lifetime-not-identity, survives my
  retry/rebase probes: unchanged selection interns the same tuple; an
  unrelated retirement aliases via complete re-verification; a
  signal-visible rebase correctly re-keys. passSerial-refetch-forever and
  single-token approximations are genuinely absent.
- **V12 — Fork honesty.** All facts the library consumes are edge-triggered
  protocol events (8 touch-points); the rebase drill's "library changes:
  none" column is credible because no lane/fiber/queue shape crosses the
  seam; C7's yield truth is native, not sampled.

## Cost-honesty notes (beyond F3)

The design is otherwise honest: always-log gated at ≤2× DIRECT (matches
research-facts), DIRECT executes zero concurrency instructions via
prototype swap (P3), the eager-per-write projection shape is named and
priced as SP-R2 with a rejection clause, SP-R1/SP-R2 are declared
unmeasured rather than asserted, and I11's host-callback tax is avoided by
construction (no host callback on any recompute). F3 is the one place the
stated worst case and the mechanism's actual worst case diverge.

## Verdict

The core architecture — append-only receipts with exact immutable world
selection, per-world real topology, equality-retained frontiers, and
per-write lane-attributed delivery — survived every scar and all of my
direct attacks on the battery's traps, failing only at lifetime seams: what
stays *walkable* after retirement (F1), what the late-join check can *see*
across joint worlds (F2), and how long the frontier family is allowed to
*grow* (F3). All three have plausible repairs inside the existing mechanism
inventory (a retirement rebinding rule, a reach-based join correction, and
an owner-mask union frontier with a new proof), so the design is
**repairable** — not implementation-ready until F1/F2 rules are specified
and F3's retention rule is redesigned and re-gated, but not architecturally
unsound.
