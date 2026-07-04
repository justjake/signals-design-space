# Round 3 synthesis — two-kernel champion, review-repaired (NOT exit-ready)

Inputs: `design-exit-candidate.md` (claude: 1 blocker/1 high, repairable;
codex: 7 blockers, architecturally-unsound) and `design-breaker.md` (claude:
2 blockers/1 high, repairable; codex: 5 blockers/1 high, architecturally-
unsound), four reviews, all SEEDS, all NOTES.

**Round verdict up front.** Both artifacts are the same architecture class
(D8/D12: K0 donor + tape + K1 + clocks + value-blind delivery + co-designed
fork). That class survived again: no confirmed finding invalidates K0/K1,
the tape, the visibility math, or the seam. But this was supposed to be the
dry-check exit round, and instead **25 findings CONFIRMED** (several
cross-design, several both-model). Exit criteria are NOT met. This document
adjudicates every finding, picks the exit candidate as the base, transplants
the breaker's armor with its invariants, applies repairs **R1–R17**, and
re-walks the battery. Round 4 must re-review the new math.

**Winner: the exit candidate's artifact, breaker-armored.** One sentence
why: the exit candidate is the only complete exit-grade artifact and every
confirmed finding against it carried an in-architecture repair, while the
breaker's genuinely new mechanisms (F9 publication, immutable lock views,
ActionScope, corrected G-R comparator, cone-carry refresh) transplant
cleanly with their invariants — so the strongest design is the merge, not
either input.

---

## Part I — Adjudication of every review finding

Verdicts: CONFIRMED (re-derived, repair keyed), REFUTED (mechanism the
reviewer missed, shown), NEEDS-MEASUREMENT (none this round — every
disagreement resolved by a walk). 28 findings; 25 confirmed, 3 refuted, 0
needs-measurement. Duplicates adjudicated once, counted per raise.

| # | finding | verdict | repair |
|---|---|---|---|
| 1 | ECC-F1 staged evaluator invisible to routing/RENDER_NEWEST | **CONFIRMED** (both-model, = ECX-5) | R1 |
| 2 | ECC-F2 watermark advance under-observed; consumable effect queue | **CONFIRMED** (cross-design family with BC-F3) | R4 |
| 3 | ECC-F3 K0∪K1 union cycles; walk has no termination | **CONFIRMED** (both-model, = ECX-7) | R3 |
| 4 | ECC-N1 boot self-test async window unstated | CONFIRMED (spec gap) | §12.4′ |
| 5 | ECC-N2 edge-add delivery contexts not exhaustive | CONFIRMED (spec gap) | §6.3′ |
| 6 | ECC-N3 C9 vs §11.2 committed-compare drift | CONFIRMED (ambiguity) | R15 note |
| 7 | ECC-N4 compaction predicate too loose | CONFIRMED (ambiguity) | §5.3′ |
| 8 | ECC-N5 probe proves one bundle pipeline | CONFIRMED (doc) | §12.6′ |
| 9 | ECX-1 transform captures at invocation, not creation | **CONFIRMED** | R5 |
| 10 | ECX-2 mixed boundary violates C12 contract | **REFUTED** as blocker (walk below); residue adopted | R5/ActionScope |
| 11 | ECX-3 retired carrier token has no policy | **CONFIRMED** | R6 |
| 12 | ECX-4 untracked reads unrepresentable in invariant R | **CONFIRMED** | R7 |
| 13 | ECX-5 staged evaluator × RENDER_NEWEST | **CONFIRMED** (dup of #1) | R1 |
| 14 | ECX-6 validity ladder serves before evaluator-stamp check | **CONFIRMED** | R2 |
| 15 | ECX-7 cyclic union walk | **CONFIRMED** (dup of #3) | R3 |
| 16 | BC-F1 K0-serve × retirement column clearing tears a pinned pass | **CONFIRMED** vs breaker; saturation horn latent in exit candidate | R8 |
| 17 | BC-F2 per-pass evaluator stamps livelock suspense retries | **CONFIRMED** (cross-design — exit candidate has the same text) | R9 |
| 18 | BC-F3 effect-queue consume/retain unstated; lock-in trigger lost | **CONFIRMED** (= #2 family) | R4 |
| 19 | BC-F4 E-PRESERVE "required edges" ambiguity | **CONFIRMED** (strong reading required) | R10 |
| 20 | BC-F5 slot-table saturation never walked | **CONFIRMED** (gap) | R8 |
| 21 | BC-F6 G-Q 2.4–3.8% lacks provenance | **REFUTED** (walk below) | cite [SPKHQ→O19] |
| 22 | BC-F7 retireVisStamp cross-root churn refetches | **CONFIRMED** (merged with #26) | R11 |
| 23 | BCX-1 reducer publication diverges K0/tape/committed | **CONFIRMED** (cross-design) | R12 |
| 24 | BCX-2 empty-tape equality drop deletes reducer actions | **CONFIRMED** | R13 |
| 25 | BCX-3 published effect deps never establish edges | **CONFIRMED** vs breaker; exit candidate's shape is the repair | R14 |
| 26 | BCX-4 global retirement stamp recreates unchanged resources | **CONFIRMED** | R11 |
| 27 | BCX-5 U1 not a valid restriction | **REFUTED** as blocker (dup of #10) | — |
| 28 | BCX-6 mount fixup double-renders an included token | **CONFIRMED** (cross-design) | R15 |

### Confirmed findings — the quoted breaking steps

Each confirmed finding, with the step where the design breaks (schedules
quoted from the reviews; re-derived before acceptance):

- **#1/#13 (R1).** Invariant R's premise — "worlds diverge from NEWEST only
  through receipts" — is false under I22. Breaking step: RENDER_NEWEST pass
  stages `f_B`, then "X's read of c: RENDER_NEWEST → K0 serve → f_A's
  cached value… Staging is not a write → no R3 demotion." Committed wrong
  frame, no repair trigger (no receipt, no walk, no backstop). Re-derived:
  routing has only `touchedSlots`/`CT` conjuncts; neither sees fn identity.
- **#14 (R2).** §8.1 lists fnStamp as a conjunct; §8.2 step 2 "pass ⇒
  serve" never compares it. Breaking step: same-pass restart stages `f1`;
  "world key, episode, and slot clocks are unchanged; reading `c` reaches
  DONE; ladder step 2 passes and serves 1." Also holds one level deep: a
  staged/promoted *child* evaluator is invisible to a parent memo whose
  ladder checks only atom fingerprints.
- **#3/#15 (R3).** K1 is a union across worlds; unions of per-world-acyclic
  graphs cycle (`c = flag ? d : a`, `d = flag ? b : c` records `c→d` and
  `d→c` in different worlds). Breaking step: "J writes b. The notification
  walk follows b→d→c→d→c…" — the walk is specified "no pruning, no
  cross-walk marks" and per-(watcher, slot) dedup is not per-visit state.
  Note: the *edge-add/mark* recursions self-terminate (monotone
  `newBits & ~touched` goes to zero on revisit); only the value-blind
  notification and retirement walks lack monotone per-visit state.
- **#2/#18 (R4).** A watermark advance admits entries in
  (oldWatermark, newWatermark] — an I21 visibility flip. Breaking steps:
  "E's queue entry was consumed at step 3 and no write walk re-enqueued
  it… fp moves ONLY if the advance mints vS, which no line states"; and
  BC-F3's lock-in variant: "E revalidates → unmoved → entry consumed; A
  then commits T's pass… but E is no longer queued and nothing at lock
  advance re-enqueues." Same root cause: a flip source (advance/lock-in)
  with neither a stamp on every mint site nor a durable flush enumeration.
- **#9 (R5).** The transform captures `t = currentToken` at generator
  *instantiation* (invocation). Breaking step: "the timer later invokes the
  callback outside any driver; currentToken === null while armedActions >
  0… generator instantiation captures t = null… a.set(1) is classified
  into ambient default batch D," committing before the action settles.
  Verified against the SP-F8 artifact: its "setTimeout" matrix row tested a
  *plain* callback resolving an awaited promise (supported), not an async
  function invoked as the timer callback — the schedule is outside the
  measured 74-matrix. The §12.2 induction's clause "every async resource
  created during a bracketed span captures the bracketed token" is not
  implemented by the spec'd transform.
- **#11 (R6).** Fire-and-forget child continuation resumes after the outer
  thenable settled. Breaking step: "F3 retires T exactly once… childGate
  resolves later; the child driver pushes the now-retired T; a.set(2) takes
  T from the carrier and calls internSlot(T)" — no specified path: reject
  crashes, re-intern makes a never-retired receipt, recycle contaminates.
  The same hole exists at rung 1 (AsyncContext carries the context into the
  late child; no creation hook exists to refcount), so the policy must be
  rung-uniform.
- **#12 (R7).** `c = b.state + untracked(() => a.state)`. Breaking step:
  "a NEWEST read pulls K0, producing and caching c=2; CT(c) is now true…
  since TS(c)==0 && CT(c), the fast path serves K0's 2" to a T-excluding
  sync world whose own evaluation gives 1. Adjudication note: untracked
  licenses *temporal* staleness (old values) — it never licenses *world
  leakage* (a pending, excluded write observable through the cache). The
  served 2 embeds T's pending write in a world that excludes T: a leak,
  not licensed staleness. Codex is also right that recording `a→c` in K1
  is not a repair (it would notify/invalidate, violating untracked
  semantics) — the repair is a node-grain routing taint, not an edge.
- **#16/#20 (R8).** Breaker text clears touched columns at retirement while
  a pinned pass lives. Breaking step: "P resumes… n: clause (b) fires —
  touched==0, K0 clean → serve 11. P renders H: a always folds → 0" — one
  committed frame from two worlds. The exit candidate dodges horn 1 via
  I10's unswept gating (pin-blocked entries hold the slot and its bits),
  but then horn 2 bites both designs: ~31 retiring pin-held slots (input
  storm during one yielded transition) exhaust the 5-bit interning and
  `internSlot` has no stated behavior. Both horns adjudicated real.
- **#17 (R9).** A Suspense retry is a new pass; staging re-compares against
  *committed* deps and mints a fresh stamp. Breaking step: "retry pass P2:
  compare vs committed → still changed → mint fresh stamp S2 ≠ S1 → prefix
  equality FAILS → factory invoked → new thenable X2 → suspends again" —
  refetch-forever. The exit candidate's §11.1/§9.2 have the identical
  text; its C15 step-4 claim "fnStamps… all unmoved" is false whenever a
  staged-evaluator hook computed is upstream of the suspension.
- **#19 (R10).** "Required basis edges" invites a bits-scoped mirror.
  Breaking step (narrow reading): retrack drops `x→c` while `x` has no
  bits; "k2 writes x=5: walk finds no out-edge in K0∪K1 → touchedSlots(c)
  never gets k2's bit → torn k2 frame." The strong reading (mirror every
  K0-removed edge while any live receipt exists anywhere) is required by
  invariant M's edge-removal step; the no-receipts-at-all case is safe
  because resurrecting a displaced branch requires a receipt on the
  branching dep, whose write re-records the edge (walked at C1-T8E′).
- **#22/#26 (R11).** Retirement replaces already-visible lock-visibility
  with retired-visibility: fold unchanged, `retireVisStamp[a]` advances.
  Breaking step: "the positional capsule compares fingerprints, sees the
  new global retirement stamp, discards the now-settled q1, and invokes
  the factory to create q2" — a duplicate side-effectful fetch per
  touching retirement, recurrent under same-atom traffic. Adjudicated with
  BC-F7 as one defect: stamps may over-invalidate (I21), but a
  side-effect-bearing cache must re-validate *content* before re-fetching.
- **#23 (R12).** Hook-reducer promotion changes the meaning of pending
  receipts. Breaking step A: "K0 newest becomes 1 using r0… replaying T's
  tape yields 10… a handler reads NEWEST → 1; a later T-world fold returns
  10" — one logical newest, two values. Breaking step B: "a permitted
  implementation retires T first, folds and compacts A under
  still-committed r0, and installs base 1" while the committed tree shows
  10. The exit candidate's dev-warn (D16) does not close the divergence;
  React's own semantics (queue folded with the rendering closure's
  reducer) require promotion-visible folds.
- **#24 (R13).** Empty-tape equality drop evaluated the action with the
  *committed* reducer. Breaking step: "evaluating the action with committed
  r0 returns the base value… the transition render stages r1, but there is
  no action left to replay" — `useReducer` gives 1, `ReducerAtom` gives 0.
  I7's proof assumed op meaning is world-invariant; staged reducers break
  that premise.
- **#25 (R14).** Breaker routed effect fn/deps changes through F9 staging
  with no re-run rule. Breaking step: "root commit is a flush trigger, but
  only effects reached by touched walks enter the queue. No touched walk
  occurred… later b.set(1) walks K0∪K1; neither graph contains b→effect."
  The exit candidate's shape (useSignalEffect deps ride React's native
  effect re-fire, which re-runs and re-tracks) is the repair; adjudicated
  confirmed against the breaker, adopted normatively for the synthesis.
- **#28 (R15).** Fixup schedules `runInBatch(T, setState)` for a mount
  whose rendered world already included every T write. Breaking step: "its
  loop does not exclude tokens already fully represented by W's rendered
  world… F4 requires work inserted after completion to schedule new work,
  producing another T render" — C9's no-double-render violated. The exit
  candidate's C9(a) walk hand-waved this ("React bails" — a version-bump
  setState never bails).
- **#4–#8** — spec gaps/ambiguities; resolved normatively in the marked
  sections (no schedule fails under the chosen readings; the point is to
  stop an implementer from choosing the other one).

### Refuted findings — the mechanism the reviewers missed

- **#10/#27 (ECX-2/BCX-5) — the U1/mixed-boundary "blocker".** Both codex
  reviewers assert the preamble's restriction rule requires reliable
  runtime rejection, so a documented misattribution bound is illegal. The
  corrected walk: the design is not invoking the preamble's
  *forbid-at-runtime* clause; it is shipping the **build prerequisite the
  loop already settled**: I30 (monitor-curated invariant, measured SP-F8)
  states verbatim "uncompiled third-party async code writing signals
  post-await inside an action misattributes; the loud boot self-test
  verifies the transform (never silent); support-matrix line: 'requires
  bundled/transformed app code (or future AsyncContext)'" — and O20 was
  CLOSED on exactly that basis (D15 fixed F8 = carrier + parking + loud
  self-test). The reviewers' schedules are the same schedule I30 records;
  no new evidence was presented, and DECISIONS reopen only on new
  evidence. Within the declared support matrix, C12 walks verbatim
  (C12/C12-U). REFUTED as a blocker. Adopted residue (the constructive
  part): the breaker's **ActionScope.set/dispatch** makes the vendor
  composition *expressible correctly* without transforming node_modules;
  R5's scheduler capture shrinks the in-app class; the support matrix
  drops the unqualified phrase "full support" and states the boundary in
  the same cell. → notes-diff proposes recording this so it is not
  re-raised a third time.
- **#21 (BC-F6) — G-Q provenance.** The 2.4–3.8% LOGGED-quiet branch floor
  is a real measurement: [SPKHQ] (`research/experiments/
  spkh-spkq-kernel-hook-tax.md`), recorded in NOTES/OPEN.md O19 with the
  pre-registered renegotiation. The breaker's "numbers only from
  research-facts.md" framing mislabeled its citation universe; NOTES are a
  legitimate provenance source (they are monitor-curated). REFUTED; the
  synthesis cites [SPKHQ→O19] explicitly wherever the number appears.

### Rejected from each design (the negative space)

From the **exit candidate**:
- "Promote at the hook's commit effect" as the promotion edge — replaced by
  F9 hook-becomes-current publication (hidden Offscreen commits promote
  with no effect firing; error-abandoned subtrees never do — breaker B2).
- Direct-in-edge-only refresh-exempt carry — non-transitive; loses
  `x→u` of `x→u→w` (breaker B3's schedule); replaced by full
  reverse-reachable cone carry with two-strike termination.
- Per-root visStamp mint at lock-in as a *global per-atom* stamp — root A's
  lock traffic starves root B (breaker B1's schedule); replaced by
  per-(root, slot) lock stamps in immutable lock views + per-atom
  retirement stamps + R11 value-revalidation.
- "≤2× the batch's own render" retirement gate — zero denominator on
  store-only batches (breaker B4); replaced by the split G-R comparator.
- The unqualified "full support" support-matrix phrasing (#10 residue).
- Fresh `++globalSeq` fnStamp per pass staging (BC-F2's livelock) —
  replaced by lineage-stable stamps (R9).

From the **breaker**:
- Retirement-time touched-column clearing while pins live (its BC-F1 tear);
  replaced by I10 unswept gating + R8's saturation spillover.
- Per-async-resource park refcounting (`parkRefs` per continuation) —
  rung-asymmetric (AsyncContext has no resource-creation hook, so rung 1
  cannot implement it), diverges from React's settle-on-returned-thenable
  parity, and a leaked never-settling child parks a lane forever (horizon
  throw on an innocent app). Replaced by R6's rung-uniform liveness
  fallback. (Nested-action token sharing itself is kept.)
- F9-staged `useSignalEffect` evaluators (BCX-3's dead edge); effects ride
  React's native deps re-fire (R14).
- Root-slot lock stamps *instead of* advance mints — kept the lock-view
  mechanism, but every advance mints (R4); B1's starvation is neutralized
  by R11's value-revalidation rather than by not stamping.
- "Numbers only from research-facts.md" provenance framing (#21).

---

## Part II — The repaired design

Base text: `design-exit-candidate.md` (all §-references below are to it
unless marked ′/new). This part specifies exactly what changes; everything
not named here carries forward from the exit candidate verbatim, including
its §2 ground rules, §4 mode protocol, §7 K1 plane layout, §11.5–11.7,
§13 semantics pins, and §21 test plan (amended below).

## 1′. One page: the whole concurrency story (updated)

The bet is unchanged (D8/D12): the fastest known single-world kernel **K0**
stays byte-for-byte for the common case; concurrency lives beside it — a
per-atom **receipt tape** for values, a second edge plane **K1** for
per-world topology. DIRECT build = donor bytes, zero concurrency
instructions; registering the React bridge swaps to LOGGED once,
monotonically.

**One value truth plus receipts.** Every LOGGED write appends {op, slot,
seq} and applies to K0 with stepwise equality. A world's value is a fold:
base + visible receipts replayed in write order. Visibility is React's lane
math verbatim: retired-by-my-pin, in-my-mask-≤-my-pin, or locked-into-my-
root up to that slot's **watermark** — lock state lives in **immutable
per-root lock views** captured per pass, and every lock-in *and every
watermark advance* mints a per-(root, slot) **lockStamp**; retirement mints
a per-atom **retireVisStamp**. All stamps share one monotone counter.

**Worlds route reads; four divergence sources, four conjuncts.** A
non-newest world takes K0's cached answer only when (1) no live batch's
cone touched the node, (2) the cache needs no recompute, (3) the node's
cache is not **tainted** by an untracked read of a receipted atom, and
(4) the current pass holds no **staged evaluator** for it and its pin is
fresh with respect to slot bookkeeping (saturation flag). Everything else
folds atoms and evaluates computeds into per-(node, worldKey) memos whose
REAL dependencies land in K1. Memo validity is a closed enumeration: slot
write clocks, retirement/visibility stamps, **evaluator stamp vectors**
(flattened, like suspense prefixes), thenable settlement, world identity,
episode epochs.

**Evaluators are world-scoped state with a fork-published commit edge.**
Each pass stages its hook's {fn, deps, stamp}; stamps are **lineage-stable**
(equal deps in the same lineage reuse the stamp, so suspense retries
compare equal). The fork's **F9** attaches a publication id to the exact
work-in-progress hook and emits it when that hook becomes current — hidden
Offscreen included, error-abandoned subtrees excluded, stale alternates
CAS-rejected — *before* retirement folds and layout effects. Promotion
dirties the K0 node; reducer promotion with pending receipts re-folds
NEWEST under the new committed reducer and notifies.

**Notification is per-write, in the writer's stack, value-blind**, over
K0∪K1 with a per-walk **visited generation** (the union of per-world
acyclic graphs can cycle). Per-(watcher, slot) dedup re-arms at render. New
edges propagate marks through existing out-edges and retroactively deliver
each still-live slot's setState through the new path. Mount fixup schedules
into every live written token whose bit reaches the node **except tokens
whose writes the mount's own rendered world already fully included**
(inclusion + clock, never equality), then compares against
committed-for-root.

**Suspense** keys thenables by fork lineage and validates by content — the
flattened (atom, fingerprint) + (computed, evaluator-stamp) prefix — and on
a stamp move it **re-folds and compares values before refetching**: flips
that don't change this world's content keep the settled resource.

**Async actions**: parking (F3, settle of the returned thenable) +
continuation identity (carrier). The carrier is AsyncContext when the host
has it; else the measured twin-build transform **plus armed-gated
registration-time capture on host schedulers** (an async callback handed to
setTimeout inside an action carries the action's token — AsyncContext
parity). A carrier token consulted after retirement falls back to ambient
classification with a dev warning. Untransformed vendor code writing
post-await misattributes to its ambient batch — sound, bounded, dev-warned,
boot-tested, support-matrixed — or uses the explicit **ActionScope**
surface, which is precise at any boundary.

**Lifecycle.** Retirement stamps, folds only the all-retired prefix no live
pin excludes, notifies committed observers durably (touchedList
enumeration, never only a consumable queue), and holds slots until their
entries are swept; slot saturation force-clears the oldest retired slot and
flips affected pinned passes to world-path-only (correct, conservative,
tested). Quiescence refreshes every K1-touched committed-observed node into
K0 before K1 resets; twice-writing refresh targets are exempted with their
**full reverse-reachable K1 cone** carried forward (two-strike termination
proof).

**Numbers.** DIRECT = donor ([ARENA]). LOGGED-quiet floor 2.4–3.8%
[SPKHQ→O19] vs the ≤2% gate — pre-registered renegotiation. Carrier ≈0%
unarmed, +12 ns/await armed (I30). Everything else unmeasured is a spike.

## 3′. Concepts — additions and changes

- **lock view** — pooled immutable record per root generation:
  `{slot, slotGen, watermark, lockStamp}[≤31]`, re-minted (new
  `lockViewId`) at every lock-in and watermark advance; a pass captures the
  current view at start and keeps it (F2/F3 serialize same-root advances
  with same-root passes; fork test asserts it).
- **lockStamp(root, slot)** — `++globalSeq` minted at first lock-in AND
  every watermark advance of that slot on that root (R4).
- **retireVisStamp(a)** — per-atom stamp minted at every retirement fold
  touching `a` (unchanged) — no longer minted at lock-in (lock side is
  root-scoped now).
- **fingerprint** — `fp(a, w) = max(newest w-visible entry seq, baseSeq,
  reducerStamp, retireVisStamp(a), lockTerm(a, w))` where `lockTerm` = max
  lockStamp over w's lock-view slots holding a w-visible entry of `a`
  (else 0). Cross-root lock traffic cannot move another root's fp.
- **WORLD_TAINT(n)** (R7) — per-node bit, recomputed at every K0 (NEWEST)
  evaluation of n: set iff, during that evaluation, an untracked signal
  read hit an atom with a non-empty tape. LOGGED-only (the untracked
  wrapper is part of the swapped op-table; DIRECT has no check).
- **staged-evaluator probe** (R1) — O(1) membership test "does the current
  pass frame hold a staged evaluator/reducer for n"; part of routing.
- **lineage stage cache** (R9) — per-lineage map hookNode → {depsValues,
  fn, stamp}; staging consults it before minting; dies at lineage death.
- **walkGen** (R3) — one global per-walk counter + a per-record lastWalk
  column; visited = (lastWalk == walkGen); wrap handled by a renumber
  sweep row in §15.
- **lastRetireSeq / fastPathDisabled(pass)** (R8) — saturation machinery:
  see §6.2′.
- **evaluator-stamp vector** (R2) — per world memo: the flattened
  [(computedId, effectiveStamp)] of evaluators traversed by the
  evaluation (same structure the suspense prefix already records).
- **publication id / F9** — opaque id the bindings attach to the WIP hook
  when a stage is used; the fork emits it when that hook becomes current
  (hidden Offscreen included), before retirement folds and layout
  effects; CAS on (nodeGen, hookSlot, passId, stageStamp); a
  `publicationsComplete(passId)` sweep reclaims unpublished stages.
- **ActionScope** — `startSignalTransition(fn(scope))` passes owner-bound
  `scope.set/dispatch/runSync`; explicit token supply for opaque
  boundaries; throws after settlement ("ActionScope closed").
- **realm affinity** — atoms, tokens, roots, scopes carry an owner-realm
  nonce; foreign tokens throw at `runInBatch`; Atom/ActionScope are not
  structured-cloneable (detectable restriction; ordinary worker promises
  unaffected).

## 5′. Value model — changed rules

**§5.1′ write path** — two changes: (a) the empty-tape equality drop is
legal only for ops with **world-invariant meaning**: plain `set` always;
updater/reducer ops only when the atom's evaluator is immutable
(constructor reducers, plain atoms). Atoms whose fold semantics can stage
(hook ReducerAtoms) always append (R13). (b) `demoteRenderNewestPasses()`
also fires on staging (see §11.1′) — staging is not a write, but it is a
divergence event.

**§5.2′ visibility** — clause 3 reads the pass's captured lock view:
`e.slot ∈ view ∧ e.seq ≤ min(p, view[e.slot].watermark)`. Committed-for-
root(r) worlds use r's *current* view; their worldKey includes
`lockViewId`, so every advance re-keys them (R4's memo half — no stale
committed memo can survive an advance).

**§5.3′ retirement** — step 2 gains the normative compaction predicate
(ECC-N4): compact entry e into base iff `e.retiredSeq ≤ min(live pins)`.
Step 3's committed-observer notification enumerates effects **via
touchedList[slot]** (durable), never only the consumable queue (R4). Step 4
unchanged (clear lock records after retirement stamps exist — the breaker's
injectivity ordering, adopted). New step ordering clause (R12): within a
commit, **F9 publication precedes the retirement folds due at that
commit**, which precede layout effects (fork F3/F9 clause; fork test).
Retirement also bumps **lastRetireSeq** (R8).

**§5.4′ quiescence** — refresh-exempt carry is the **full reverse-reachable
K1 cone** of each exempt target (both endpoints of every encountered K1
edge), not its direct in-edges (R16, breaker B3). Two-strike rank
termination: R = Σ(2 − failures) over non-exempt targets strictly decreases
per failed sweep; a fixed observed set resets within 2N+1 attempts;
unbounded new observed work is the ordinary signal-loop budget's job. An
exemption clears when a later ordinary K0 NEWEST evaluation of the target
completes without writing.

## 6′. Worlds, routing, marks — changed rules

### 6.1′ Bindings

RENDER_NEWEST is **revoked by staging as well as by writes** (R1): the
first staged evaluator in a RENDER_NEWEST pass demotes that pass to its
real (mask, pin) — original pins retained. (Other RENDER_NEWEST passes
demote only on writes, as before: staging is pass-local.)

### 6.2′ Read routing (invariant R, repaired)

A tracked or untracked read of node n under world w ≠ NEWEST:

```
fastPath(n, w, pass) =
      touchedSlots(n) == 0
  ∧  CT(n)                                  // donor-clean, no recompute needed
  ∧  ¬WORLD_TAINT(n)                        // R7: no untracked pending-state embed
  ∧  noStagedEvaluatorFor(n, pass)          // R1: O(1) pass-frame probe
  ∧  ¬fastPathDisabled(pass)                // R8: saturation spillover flag
```

else world path (fold atoms; consult/evaluate M(n, worldKey); world-eval
frame rejects writes; EVALUATING ⇒ cycle throw).

**Invariant R (rewritten construction).** Claim: the fast path never serves
a value world w's own evaluation would not produce. Worlds diverge from
NEWEST through exactly four sources, each excluded by a conjunct:

1. **Receipts reachable through recorded topology.** By first-divergence
   (I4), the first divergent atom x is a newest-basis dependency at the
   divergence point and holds a live receipt in slot s; bit s reached n by
   leg 1 (write walk at write time), leg 2 (edge-add propagation §6.3), or
   leg 3 (E-PRESERVE mirror, §7′ strong reading), so `touchedSlots(n) ∋ s`
   and the fast path refused. Fresh-recompute acquisition (S9) is excluded
   by CT(n) — only cached, no-recompute serves are legal.
2. **Receipts reachable only through untracked reads.** No edge exists by
   design; but any K0 cache that could embed a pending value was produced
   by an evaluation whose untracked read hit a non-empty tape, which set
   WORLD_TAINT(n) — refused. A cache produced when every untracked-read
   atom had an empty tape embeds only committed values: serving it to any
   world is temporal staleness, which untracked licenses (I33). World
   evaluations fold untracked reads in-world (value from w, no edge): the
   licensed staleness stays per-world; the isolation property holds.
3. **Evaluator identity.** A staged evaluator for n exists only in its
   pass's frame (I22); the probe conjunct refuses the fast path there, and
   RENDER_NEWEST demotion (6.1′) removes the direct-K0 binding. Promotion
   dirties the K0 node (§11.1′), so post-promotion NEWEST reads recompute
   — CT(n) is false until they do.
4. **Slot-bookkeeping erasure.** Bits are cleared only at slot recycle,
   gated on swept entries (I10); the one early-clear path (saturation
   spillover) sets fastPathDisabled on every pass whose pin the cleared
   slot's retirement postdates — refused wholesale for those passes.

Base case: episode start — no receipts, no stages, no taint, all worlds ≡
NEWEST. Step: every event kind preserves M (§6.3) and the four conjuncts'
update sites are the events themselves. ∎

### 6.3′ Invariant M — one clarification (ECC-N2)

Edge-add retroactive deliveries fire **immediately in every non-render
context** (writer's stack, effect flush, mount fixup, reconcile backstop —
`runInBatch` is context-establishing); they queue to the pass's yield/end
edge only when discovered inside a render slice. The two-context enumeration
in the base text was not exhaustive; this one is.

### 6.2″ Notification-walk termination (R3)

Every value-blind full walk (per-write notification; retirement
notification) carries `walkGen`: bump one global counter per walk; visiting
a record stamps lastWalk := walkGen; a stamped record is skipped. One int
load+compare+store per visited record per walk, priced into G-W/G-N.
Cross-walk dedup semantics unchanged (per-(watcher, slot) bits; marks never
gate delivery). The mark/edge-add recursions need no walkGen: their
`newBits & ~touched(n)` frontier is monotone and self-terminating. Union
cycles are legal state (per-world graphs stay acyclic; R7's per-world
EVALUATING throw is unchanged). Forced test: the two-flag cycle from ECX-7
plus a randomized union-cycle fuzz row; walkGen wrap row in §15′.

## 7′. K1 — E-PRESERVE strong reading (R10)

E-PRESERVE mirrors **every edge a K0 re-track removes while any live
receipt exists anywhere**, with both endpoints and generation. (The
exit-candidate text already said "while any live receipts exist"; this
section now states the quantifier explicitly and pins BC-F4's narrow-reading
schedule as the regression test.) When no receipt exists anywhere, a
dropped edge is safe: any world that later resurrects the displaced branch
must first hold a receipt on the branching dep, whose write/eval re-records
the path (walk C1-T8E′). The SP2 dev validator is promoted to a CI fuzz
gate (brute-force reach compare on randomized retrack schedules).

## 8′. Validity — the closed table, amended rows

| # | change source | observer (stamp + conjunct) | change |
|---|---|---|---|
| S1 | write in slot s | slot clocks; fingerprint newest-visible term | unchanged |
| S2 | retirement fold/compaction | worldMemoEpoch; baseSeq; **lastRetireSeq** | R8 adds the global stamp |
| S2b | visibility flip below the max | **retireVisStamp(a)** at retire-folds; **lockStamp(root, slot)** at first lock-in AND every advance, carried in immutable lock views; `lockTerm` in fp | R4 + breaker B1 merge |
| S3 | evaluator identity | staged per pass with **lineage-stable stamps** (R9); memos record the **flattened evaluator-stamp vector** and the ladder checks it before any serve (R2); promotion via **F9** dirties K0 (R1) and, for reducers with pending receipts, re-folds NEWEST (R12) | three repairs |
| S3b (new) | **untracked pending-state embed** | WORLD_TAINT(n) conjunct in routing (R7) | new row |
| S4 | thenable settlement | unchanged | — |
| S5 | episode/renumber | unchanged (+ walkGen renumber row) | — |
| S6 | world identity | key = (mask, pin, **lockViewId**, epoch) | R4 |
| S7 | node identity recycle | unchanged | — |

**Ladder (8.2′):** 1. epoch equal? 2. **evaluator-stamp vector pairwise
equal?** (the memo's recorded vector vs current effective stamps —
staged-in-this-pass else committed; int compares) 3. per-slot clocks
∀s ∈ mask: wc[s] ≤ r.seq — pass ⇒ serve. 4. fingerprint re-check per
recorded atom dep — all unmoved ⇒ re-stamp, serve. 5. re-evaluate.
(Step 2 before step 3 closes ECX-6; the vector is bounded by traversed
computeds, same O21 length ownership as the suspense prefix.)

## 9′. Suspense — two changed rules

**9.1′** unchanged (lineage-positional identity, lazy factory).

**9.2′ content validity with value revalidation (R11).** The prefix stores
`(atomId, fp, valueRef)` triples (valueRef = the fold's reference-stable
value) and `(computedId, effectiveStamp)` pairs. Reuse check per position:
pairwise stamps equal ⇒ reuse. On an **fp mismatch only**: re-fold that
atom in w and compare with the atom's equality — equal ⇒ update the stored
fp in place and continue (the flip did not change this world's content —
no refetch, settled resources are consumed); different ⇒ drop positions ≥ p
and refetch (generation-bumped). Evaluator-stamp mismatches never
revalidate by value (a new closure is a content change by definition, and
R9 makes retry stamps equal). Properties: retry-stable (purity + R9);
content-sensitive (included write moves the newest-visible term to a
different fold value; a genuine visibility flip changes the fold);
starvation-free now in both directions — unrelated retirements touch no
prefix atom, and *touching-but-content-neutral* flips (BCX-4's
lock→retired handover, BC-F7's equal-value churn) re-validate to equal and
keep the capsule. Cost: one fold per moved-fp prefix atom per retry —
inside SPK-G8's grid.

## 10′. Notification — walkGen added; otherwise unchanged

(§6.2″.) Delivery remains per-write, writer-context, value-blind,
per-(watcher, slot) dedup with render re-arm; targeted effect enqueue is an
*optimization* — retirement and lock-in triggers enumerate durably via
touchedList (R4).

## 11′. React bindings — changed rules

### 11.1′ Staged evaluator identity (R1, R9, R12; F9)

Per invocation: compare incoming deps against this pass's staged entry,
else **the lineage stage cache**, else the committed evaluator. Equal deps
⇒ reuse the cached {fn, stamp} (useMemo semantics per lineage — a Suspense
retry compares equal and reuses the stamp: BC-F2's livelock dead). Changed
⇒ mint {fn, deps, fnStamp: ++globalSeq}, stage in the pass frame, update
the lineage cache. Staging: (a) demotes a RENDER_NEWEST pass (6.1′);
(b) registers the F9 publication id on the WIP hook.

**Promotion = F9 emission** (hook becomes current — hidden Offscreen
included, error-abandoned excluded, stale alternates CAS-rejected), which:
1. installs the committed evaluator/reducer + stamp;
2. **dirties the K0 node** (commit-phase, render-pure) so NEWEST
   re-evaluates with the promoted closure instead of serving the
   pre-promotion cache (R1);
3. for a ReducerAtom with pending receipts: **re-folds K0 newest** under
   the new committed reducer (stepwise equality), and if the value moved,
   runs the notification walk + reconcile/effect flush via touchedList in
   the committing context (R12) — dev-warn retained (perf note), the
   differential battery gains swap-with-pending rows;
4. `publicationsComplete(passId)` reclaims unpublished stages; discard and
   lineage death reclaim without promotion.

Selection construction (breaker's, adopted): initially every context uses
the committed evaluator; a stage event changes one pass's table; discard
publishes nothing; commit CASes exactly the winning hooks' ids —
error-abandoned slots are not winning, hidden slots are; a stale alternate
cannot satisfy the CAS. Ordering (R12): F9 emission precedes the commit's
retirement folds, which precede layout effects — so a fold triggered by
the same commit replays receipts under the reducer the committed tree
rendered with (BCX-1 schedule B dead).

`useSignalEffect` fn/deps changes take **no F9 path**: they ride React's
native effect re-fire — a deps change re-runs the effect at its own
commit, which re-reads, re-tracks, and re-registers subscriptions (BCX-3
dead; walked at C16-D).

### 11.2′ Mount/subscribe fixup (R15)

```
r = touchedSlots(n); if r == 0 ∧ CT(n) ∧ ¬WORLD_TAINT(n): return
for each LIVE WRITTEN token t, slot s=slot(t) ∈ r:
  if s ∈ renderedWorld.mask ∪ renderedWorld.lockView
     ∧ wc[s] ≤ renderedPassPin:  continue      // R15: already fully included; skip
  fork.runInBatch(t, () => setState(W))
v_now = evaluate(n, committed-for-root(r))      // committed evaluator (I22)
if !isEqual(v_now, v_rendered): setState(W)     // unconditional (ECC-N3 resolved: this form)
```

The skip is inclusion+clock, never value equality (S10/I13 respected: a
token fully included up to the rendered pin cannot have divergence for this
watcher; a post-pin write fails the clock check and still schedules). C9's
mount-inside-own-pass no longer double-renders; C10's late join and both
C10-R races are unchanged.

### 11.4′ Effects

Flush triggers (I14, all durable): commits on the root **including every
per-root lock-in/watermark advance** — enumerated via touchedList[slot] of
the advanced slot; retirements — via touchedList; settlement re-checks. The
write-time touched-effect queue remains a fast path only; consuming an
entry never removes an effect from later touchedList enumerations (R4;
ECC-F2/BC-F3 dead). Snapshot fingerprints include lockTerm, so an advance
moves them.

## 12′. Async actions — carrier completed (R5, R6; ActionScope)

### 12.1′ Transform + scheduler capture (R5)

The twin-build transform is unchanged (I30). Added: **armed-gated
registration-time capture** on host schedulers. At bridge registration (and
only in carrier rung 2), the runtime wraps `setTimeout`, `setInterval`,
`queueMicrotask`, `requestAnimationFrame`, `requestIdleCallback`, and
`MessagePort.postMessage`-delivered callbacks: at *registration*, if
`currentToken !== null`, the callback is bracketed — invoke under
push(tokenAtRegistration)/finally-restore, with the R6 liveness check.
Unarmed or token-null registrations are not wrapped (a concurrent click's
timer stays ambient). This is AsyncContext's registration-time semantics
for exactly these APIs; rung 1 subsumes it natively.

Not a scar repeat: S22 killed promise-patching *as the await carrier*
(`await` never calls a patched `.then`); the transform still carries every
await — the shims cover explicit host registration only. Explicit
`.then(asyncCb)` inside actions and unpatchable third-party schedulers
remain in the documented boundary class (dev-warned).

**Carrier induction (restated).** Base: the token is ambient while the
action's synchronous prefix runs. Step: (i) every resumption of a compiled
async fn passes through its driver's push/restore; (ii) every compiled
async fn *invoked* while the token is ambient instantiates its generator
under it; (iii) every callback *registered* with a shimmed scheduler while
the token is ambient is bracketed at invocation. Residual (documented, not
covered): callbacks registered through unshimmed registrars, and
uncompiled async functions' internal awaits — the §12.5 class. ∎

### 12.2′ Retired-token policy (R6)

`fork.currentBatchToken()` consults the carrier; if the carrier's token is
**not live-parked** (retired/settled), it is treated as null — ambient
classification — with a dev warning naming the composition ("action
continuation outlived its action"). Uniform across rungs (AsyncContext
delivers the same dead token; same fallback). Parking stays keyed to the
returned thenable (React parity: a late un-awaited child's update lands in
its own batch in React too). Pre-settlement child continuations still
attribute to the live parked token. Test rows: fire-and-forget child
writing before and after settlement; interleaved with an unrelated click.

### 12.3′–12.4′ Ladder and boot self-test

Ladder gains rung 2b: **Node AsyncLocalStorage, explicit opt-in only**
(server compatibility; perf note: +38% promise-machinery time, I30 — never
auto-selected). Boot self-test (ECC-N1 resolved): `registerReactBridge()`
arms LOGGED synchronously; the probe verdict lands one microtask later and
**throws async-loud** (unhandled rejection with the support-matrix
message); an action started inside that window is covered by the same
§12.5 bound; the probe now also covers a shimmed-scheduler round-trip and
proves the pipeline **per bundle** (ECC-N5: hybrid second-bundler outputs
are the app's responsibility; matrix says "per bundle pipeline").

### 12.5′ Boundary + ActionScope

The mixed-boundary semantics stand as adjudicated (#10): misattribution is
attribution+timing of the uncompiled write only; never a lost write, torn
frame, stuck world, or lifecycle leak; dev-warned (armedActions>0 ∧ carrier
null). New supported composition (breaker, adopted):
`startSignalTransition(fn(scope))` provides **ActionScope** —
`scope.set(atom, v)` / `scope.dispatch(ra, action)` supply the captured
token explicitly (generation- and liveness-checked); `scope.runSync(fn)`
enters the carrier for the synchronous extent; calls after settlement
throw. Support matrix (wording fixed):

| composition | status |
|---|---|
| AsyncContext host (future) | native carrier; no build requirement; no boundary class |
| bundled app + transform: transformed code awaits anything; only transformed code writes after awaits; async callbacks via shimmed schedulers | supported (C12 verbatim) |
| uncompiled post-await code uses ActionScope.set/dispatch | supported |
| uncompiled code performs raw post-await signal write | **misattributes to its ambient batch** — sound, bounded, dev-warned (§12.5); transform node_modules, use ActionScope, or rung 1 |
| unshimmed registrar hands an async callback across an action | same bounded class, dev-warned |
| raw token/Atom/ActionScope structured clone; foreign-realm token | rejected loudly (realm affinity) |
| unbundled/untransformed, no AsyncContext, no opt-out | boot failure (async-loud) |

## 14′. fork-protocol — now nine facts

F1–F8 as the base text, with: F1 note — the carrier consult includes the
R6 liveness rule; F2 — adds the same-root serialization assertion (no lock
view advances while a same-root pass is open; test); F3 — ordering clause
extended: **F9 publication → retirement folds due at this commit → layout
effects** (R12); F4/F5/F6/F7 unchanged; F8 — adds the scheduler-shim
capability bit and probe row.

**F9 — hook publication (new, from the breaker).** Render attaches an
opaque publication id to an exact WIP hook slot; commit emits ids for
hooks made current — hidden Offscreen included — before retirement folds
and layout effects; then `publicationsComplete(passId)`. Discarded,
error-abandoned, and stale-alternate hooks never publish (generation CAS).
Sites: hook attach, commit walk. Rebase drill: "commit phases or Offscreen
behavior change" re-anchors F9 to the event "hook becomes current before
retirement folds/user layout"; the library moves zero lines.

**Fork test list additions** (base 1–19 kept): 20 hidden-Offscreen commit
publishes before reveal, before folds/layout; 21 error-abandoned child
publishes nothing, sibling CASes; 22 stale alternate/publication generation
cannot overwrite the winner; 23 F9-before-fold ordering (BCX-1 schedule B
shape); 24 same-root lock advance vs open pass serialization; 25
scheduler-shim carrier rows (async callback via setTimeout/queueMicrotask/
rAF inside an action; unshimmed registrar dev-warn); 26 retired-carrier
fallback (fire-and-forget child; ambient + warn); 27 saturation
force-clear + fastPathDisabled (R8).

## 15′. Lifecycle — master table row changes

Changed/new rows (all others carry forward):

| state item | minted/set by | observed by | cleared/reset by | forced test |
|---|---|---|---|---|
| retireVisStamp column | retire-folds touching the atom | fingerprints, prefixes, snapshots | never in-episode; renumber rewrites | C16-B1 |
| lock views {slot, gen, watermark, lockStamp} + lockViewId | F3 lock-in/advance (immutable re-mint) | visibility clause 3, fp lockTerm, worldKeys | record cleared after retirement stamps exist; pooled view retained until last pass drops; id gen-bumped | C11-W advance battery; test 24 |
| WORLD_TAINT bit | K0 NEWEST evaluations (untracked read hits non-empty tape) | routing conjunct | recomputed per K0 eval; bulk zero at episode reset | ECX-4 schedule row |
| walkGen counter + lastWalk column | each notification/retirement walk | per-walk visited skip | renumber sweep at wrap | union-cycle fuzz; wrap row |
| lastRetireSeq | every retirement fold | (available to diagnostics) | renumber rewrites | saturation battery |
| fastPathDisabled(pass) | saturation force-clear | routing conjunct | pass end | test 27 |
| lineage stage cache | staging (deps-changed) | later same-lineage stagings | lineage death | BC-F2 retry row; C14 restart |
| publication ids / stage serials | stage use | F9 CAS | publicationsComplete sweep; discard; lineage death | tests 20–23 |
| scheduler shim wrappers | bridge registration (rung 2) | armed registrations | none (installed once; no-op unarmed) | test 25 |
| realm nonces | construction | runInBatch/scope/clone checks | n/a | clone-rejection tests |

§15.2 renumber duty list gains: lastRetireSeq, lockStamps (inside pooled
views), lineage-cache stamps, walkGen/lastWalk sweep.

## 16′. Gates — corrected and extended

| gate | budget / comparator | status |
|---|---|---|
| G-D | DIRECT ≤ alien v3 tier-0; 179/179 + growth + exact pulls | MEASURED [ARENA]; CI symbol diff |
| G-Q | LOGGED-quiet ≤2%; floor 2.4–3.8% **[SPKHQ→O19]** | AT RISK; SPK-L + pre-registered renegotiation; ledger now includes taint check (one branch per untracked read, LOGGED only), staged-probe (per world-path read), walkGen (per visited record per walk) |
| G-W | logged write ≤2× DIRECT | UNMEASURED → SPK-W (+walkGen stamp cost) |
| G-N | propagate ≤2× DIRECT; ≤1 spurious render per (watcher, slot, cycle) | UNMEASURED → SPK-N1 (breaker W1 workload adopted); walkGen priced here |
| G-F | R-clean mount 0 fixups; flagged ≤ \|touched ∩ live *non-included*\| + 1 committed eval (R15 tightens the bound); 10k mount ≤15% | breaker W2 workload adopted |
| G-E | world-eval ∝ flagged region; restart-heavy typeahead | SPK-G8 (breaker W3 + prefix length + R11 re-fold cost) |
| **G-R-core** | retirement engine overhead ≤2× DIRECT `batch()` on the identical write/effect graph; user callback time reported separately | **repaired comparator (breaker B4)**; SPK-R = breaker W5 A/B |
| **G-R-react** | retirement reconciliation ≤2× equivalent useState render/commit for reached watchers | SPK-R |
| G-M/G-P1 | 0 steady-state allocs; ≤10% re-render; 10k mount ≤15% | harness |
| G-A | carrier: unarmed ≈0%, armed ≤+15 ns/await; boot ≤1 ms class; **shim: unarmed 0 (not installed on the path), armed = one wrap per registration** | MEASURED core (I30); shim rows added to the matrix |

## 19′/20′. Mechanism inventory (10) and rejected list

Inventory (10 — deltas in brackets):
1. K0 donor kernel, twin builds.
2. Tape + base/baseSeq + one globalSeq line + equality-stable watermarked
   folds [+ R13 drop restriction; + R12 promotion re-fold].
3. Tokens/slots/masks/pins + **immutable per-root lock views with
   lockStamps** + closed mask lifecycle [+ R8 saturation policy].
4. Closed change-source validity [+ S3b taint row; + evaluator-stamp
   vectors in the ladder (R2); + R4 stamp/mint sites].
5. World memos + lineage thenable caches [+ R11 value revalidation; + R9
   lineage-stable stamps].
6. K1 + E-PRESERVE (strong reading) + touchedSlots/touchedList + delivering
   edge-add propagation + invariant-R routing (5 conjuncts) +
   RENDER_NEWEST demotion (writes AND staging).
7. Notification walk [+ walkGen termination].
8. Watcher records + mount fixup (**inclusion+clock skip**, R15) +
   reconcile backstop + durable effect-flush triggers (R4) [+ effects ride
   native deps re-fire, R14].
9. Fork/build protocol **F1–F9** + carrier (transform + **scheduler
   capture** + **retired-token fallback** + **ActionScope** + realm
   affinity) [+ tests 20–27].
10. Episode lifecycle [+ **cone-carry** refresh exemption (R16); +
    saturation force-clear; + new counter rows].

Rejected variants: the base text's list, plus this round's (Part I
"Rejected from each design").

Known gaps: base list G1–G11 stand, with G6/G-F re-bounded by R15, G3
(union over-notification) now explicitly bounded by walkGen per walk, and
new G12: shimmed-scheduler coverage is enumerated, not exhaustive —
unshimmed registrars are §12.5-class (dev-warned; erased at rung 1).

---

## Part III — Battery re-walk against the repaired design

Every case re-walked. Unchanged-outcome walks whose mechanisms this round
did not touch are cited to the base text (they were walked in full there
and re-verified here); every case a repair touches is walked in full.
Notation as the base text; `LV` = lock view, `vSr` = retireVisStamp,
`lS` = lockStamp, `WT` = WORLD_TAINT.

### C1 — world-divergent dependency (family, now of 14)

Core, T2–T7, T8-E, T9, T10: as base §18 C1 — re-verified step-by-step;
no repaired rule participates except routing, whose new conjuncts are all
true in those schedules (no stages, no taint, no saturation), so every
step and outcome is identical. Three new members:

**T11′ (staged evaluator — replaces the base T11; R1/R2/F9).**
```
setup | useComputed node c, committed f_A; transition T's render changes deps
1 | T renders X; hook | deps ≠ lineage cache/committed → stage {f_B, fnStamp2} in T's frame; lineage cache updated; F9 id attached; T was RENDER_NEWEST → DEMOTED to (mask{T}, pin) (6.1′)
2 | X reads c | routing: noStagedEvaluatorFor(c, T) FALSE → world path → M(c,wT) evaluated with staged f_B; evaluator-stamp vector records (c, fnStamp2)
3 | sibling Y reads c in the same pass | same pass frame → same probe → world path → same memo → SAME value (torn-frame schedule B dead)
4 | urgent U renders same fiber (committed props) | no stage in U's frame → probe passes; TS/CT/WT govern → f_A value ✓ two passes, two evaluators, zero shared mutation
5 | yield-gap NEWEST read | committed evaluator f_A; K0 cache clean → f_A value ✓
6 | T commits | F9 emits at hook-becomes-current (before folds/layout): committed evaluator := f_B; K0 node DIRTIED → next NEWEST pull re-evaluates with f_B ✓ (schedule A's stale-forever dead); discard variant: no emission, stages reclaimed, lineage cache dies with lineage
7 | same-pass restart (ECX-6 shape) | restart re-compares: deps changed vs lineage cache → NEW stamp → ladder step 2′ (stamp vector) fails → re-eval with new closure ✓; deps equal → reuse stamp+fn (useMemo parity) ✓
outcome: evaluator divergence is excluded by construction at routing, memo validity, and promotion — the three surfaces ECC-F1/ECX-5/ECX-6 broke.
residual: probe cost on world-path reads (G-Q ledger); F9 fork tests 20–23.
```

**T12 (union cycle; R3).**
```
setup | c = flag ? d : a; d = flag ? b : c; world A records d→c, world B records c→d → K0∪K1 has c→d→c
1 | J writes b | walk: walkGen := ++G; visit b (stamp), d (stamp), c (stamp), out-edges of c include d — lastWalk(d)==walkGen → SKIP → walk terminates; deliveries per (watcher, slot) dedup unchanged
2 | second J write | new walkGen → full re-traversal (re-arm semantics preserved — C4 unaffected: dedup is watcher/slot, not visit state)
outcome: termination without pruning semantics; cost one stamp+compare per visited record.
residual: walkGen wrap row (§15′); union-cycle fuzz.
```

**T13 (untracked leak; R7 — ECX-4's schedule).**
```
setup | c = b.state + untracked(() => a.state); K0 cache c=0; edge b→c only
1 | T writes a=1 | no edge from a; TS(c) unchanged (correct — untracked must not notify)
2 | U writes b=1; U render world-evals c | fold b=1 (U), untracked a folds IN-WORLD: a=0 (T ∉ U's world) → c=1 ✓ (in-world untracked fold: no edge, w's value)
3 | U retires; NEWEST read pulls K0 | eval reads b=1, untracked a: tape(a) NON-EMPTY → WT(c) := 1; c=2 cached, CT(c) true
4 | sync render excluding T reads c | routing: WT(c)=1 → fast path REFUSED → world path → M(c, wSync): b=1 (retired), a=0 → c=1 ✓ (the leak served 2 before; dead)
5 | T retires; tape(a) compacts to empty; next NEWEST pull | untracked read hits empty tape → WT(c) := 0 → fast path restored
outcome: pending state never observable through untracked reads in an excluding world; temporal staleness (the licensed kind) preserved per world.
residual: taint is per-K0-eval — a never-re-pulled node stays conservatively tainted (safe); one branch per untracked read in LOGGED (G-Q ledger).
```

**T14 (pinned pass vs retirement bookkeeping; R8 — BC-F1's schedule).**
```
setup | n = a+10 K0-clean; core effect on n; components E (z ? n : 0), H (z ? a : 0) on z only; transition j pass P (pin p) yields
1 | gap click, default D: a.set(1) | receipt s_D > p; TS(a)=TS(n)={D}; no React watcher of a/n → D has no React work
2 | core effect flush | NEWEST read n → 11 (documented NEWEST contract)
3 | D retires | entries pin-blocked (retiredSeq > p ⇒ > min live pins → compaction predicate refuses); slot D UNSWEPT → slot + bits RETAINED (I10); lastRetireSeq := s_r
4 | P resumes; E reads n | TS(n) ∋ D → world path → M(n, wP): fold a at pin p → 0 → n=10; H reads a → 0 ✓ consistent frame (10/0 world-p)
5 | saturation variant: 31 pin-held retiring slots + new write | internSlot exhausted → force-clear oldest fully-retired slot k*: touchedList[k*] sweep zeroes bits; every live pass with pin < retireSeq(k*) gets fastPathDisabled → P's remaining reads ALL world-route (conservative, correct); k* recycles; write proceeds ✓ no crash, no tear
outcome: horn 1 closed by retention (I10, as the exit candidate had it — now stated); horn 2 closed by the spillover policy with its forced test.
residual: spillover frequency unmeasured — the forced test pins correctness; frequency belongs to SPK-N1's held-batch row.
```

### C2 — flushSync excludes a pending default batch (+ C2-M)

As base §18 C2 — unchanged mechanisms (always-log receipt + step-1 walk
marks the cone; TS routes both a and c off the fast path; fixup enumerates
default batches). Re-verified; R15's skip does not fire (the sync mount's
rendered world excluded D — s ∉ mask∪LV → corrective still scheduled ✓).

### C3 — rebase parity (+ C3-E, + C3-R new)

Steps 1–7 as base — re-verified (fold/compaction untouched by repairs
except ordering). New rows:

**C3-R (staged reducer; R12/R13 — BCX-1/BCX-2 schedules).**
```
A | T dispatches act A under committed r0 | receipt {A@s1,T}; K0 newest := r0(0,A)=1
B | urgent React-only render stages r1; commits | F9 emits BEFORE folds: committed reducer := r1, reducerStamp bumps; PENDING receipts exist → re-fold K0 newest with r1: base0 + r1(0,A) = 10; K0 1→10; notification walk from the atom (writer-context = committing context) + reconcile/effect flush via touchedList → NEWEST readers see 10 ✓ (BCX-1 A: one newest, one value)
C | T renders | wT fold with committed r1 (no stage in T's frame for this atom... T's own pass would use its stage if it staged one) → 10 ✓; T retires: fold with r1 → base 10 ✓
D | BCX-1 schedule B ordering | T's pass staged r1, rendered 10; T commits: F9 emission (r1 promoted, re-fold) precedes the retirement fold (F3/F9 clause) → fold replays A under r1 → base 10 = committed tree ✓ (fold-under-r0-then-promote is unrepresentable — fork test 23)
E | BCX-2 empty-tape drop | ReducerAtom is a stageable-evaluator atom → equality drop NEVER applies → receipt appended; transition folds with staged r1 → 1; useReducer differential matches ✓ (plain atoms/constructor reducers keep the drop — world-invariant ops)
outcome: reducer identity changes are promotion events with fold visibility; I2's replay untouched.
residual: swap-with-pending differential rows; dev-warn retained.
```

### C4 / C5 / C6

As base — per-(watcher, slot) dedup, value-blind delivery, per-write
context; no repaired rule participates (walkGen changes traversal
bookkeeping, not delivery semantics — C4's two-lane obligation re-verified
under walkGen: two walks, two gens, both deliver ✓).

### C7 (+ C7-D)

As base — bindings/pins/demotion untouched. Re-verified with R8: the
resumed pass's atom folds honor the pin; fast-path reads additionally
survive because bits are retained (T14). C7-D unchanged (demotion precedes
first receipt); staging-demotion (6.1′) is a second demotion trigger with
the same data ✓.

### C8

As base, with R13's refinement: the empty-history drop now also requires a
world-invariant op — for plain `set` (C8's shape) behavior is identical;
walked rows unchanged ✓.

### C9 — mount mid-transition (existing and fresh nodes)

As base for (a)/(b) reads (world path via TS/¬CT; staging S15). Changed
step — fixup (R15):
```
2′ | layout fixup for a mount rendered inside k's own pass | slot k ∈ renderedWorld.mask ∧ wc[k] ≤ renderedPassPin → SKIP the runInBatch corrective (no second k render — BCX-6 dead); committed compare: v_now(committed) vs v_rendered(k-world) may differ → fires setState ONLY toward committed?? NO — walk: the compare is unconditional (ECC-N3 resolution) but v_rendered was produced in k's world and W holds NO pending k update after the skip…
   re-derivation: W mounted inside k's pass; k's world ⊇ committed except k's own writes; if v_now ≠ v_rendered the difference is exactly k's still-pending writes — a legitimate divergence that k's OWN commit will carry; firing an urgent setState here would tear k. RULE (normative): the committed compare is suppressed when every slot in touchedSlots(n) ∩ live passed the R15 inclusion check (the mount is fully explained by worlds it rendered); it fires otherwise (retire-race, excluded-token divergence).
3′ | retire-race variant (C10-R(i)) | k retired in the window → k not live → inclusion check vacuous → compare FIRES (R11 fold: v_now includes k) → pre-paint correction ✓
outcome: no double render for included tokens; the retire-race fallback intact; the compare's guard is inclusion-based, never value-based (S10 safe: value equality never *suppresses* a correction for a non-included token).
residual: fixup-window battery gains the included-token row and the mixed included/excluded-token row.
```

### C10 (+ C10-R)

As base; R15 changes only the skip (walked above). C10's main schedule: W
mounted in an URGENT pass, k's writes NOT included (k ∉ rendered mask/LV)
→ skip check fails → runInBatch(k) corrective scheduled — identical to
base ✓. Races (i)/(ii) re-verified: (i) via the compare (fires — k not
live); (ii) via walk-then-fixup + F4 obligation ✓.

### C11 — full spanning (+ C11-W, + C11-A new)

Steps 1–6 as base, with lock views: lock-in re-mints A's view (new
lockViewId, lockStamp) — committed-for-A worldKeys re-key ✓. C11-W as
base (watermark = committed pass's pin; advance = max) ✓. New:

**C11-A (watermark advance observers; R4 — ECC-F2's schedule).**
```
1 | action T: a.update(+1)@s1; A commits {T} at p1 | LV_A := {(T, p1, lS1)}; E runs, sees 1; snapshot fp = max(s1, lS1)
2 | post-await: a.update(×2)@s2 (parked) | walk enqueues E (queue fast path)
3 | urgent U: a.update(+100)@s3; U commits+retires on A | vSr(a) minted; committed-for-A fold = (0+1)+100 = 101; retirement flush enumerates touchedList[U] ∋ E → E re-runs → 101; queue entry consumed — irrelevant now
4 | A renders T's s2 at p4; commits | F3 advance: LV_A := {(T, p4, lS2)} (NEW view, NEW stamp — R4 mint-at-advance); fold = ((0+1)×2)+100 = 102; DOM 102
5 | passive flush at this commit | lock-in trigger enumerates via touchedList[T] ∋ E (durable — consumed queue entries don't matter); fp(a): lockTerm moved (lS2 > lS1) → snapshot moved → E re-runs → 102 ✓
6 | committed-for-A memo recorded at step 3 | worldKey contains lockViewId → step-4 re-mint re-keys → old memo unreachable → fresh fold 102 ✓
outcome: every advance is a stamped, durably-flushed visibility flip; both ECC-F2 surfaces closed.
residual: fork test 17 gains this schedule; per-advance view re-mint cost = one pooled record (≤31 entries) per commit-with-lock-change.
```

### C12 (+ C12-U, + C12-T, + C12-F new)

C12 core and C12-U as base (re-verified; the boundary adjudication in
Part I #10). New:

**C12-T (async callback via host scheduler; R5 — ECX-1's schedule).**
```
1 | action T enters; body: await new Promise(res => setTimeout(async () => { a.set(1); res() }, 0)); await secondGate
2 | setTimeout called while currentToken=T | SHIM (registered under non-null token): callback bracketed with T
3 | timer fires on bare stack | shim pushes T (liveness: parked-live ✓); wrapper sees currentToken=T → genBody instantiates capturing T
4 | a.set(1) | carrier → T → receipt {1@s1, T}, PARKED ✓ (was: ambient D, committed early)
5 | secondGate settles → action settles → T retires → fold commits 1 ✓ C12 timing exact
6 | unshimmed-registrar variant (vendor scheduler) | callback runs token-null → ambient + dev warning → §12.5 bound (documented) ✓
outcome: the carrier induction's clause (iii) holds for shimmed registrars; the residual class is enumerated, not silent.
residual: shim coverage matrix (fork/build test 25); rung 1 erases the class.
```

**C12-F (fire-and-forget child; R6 — ECX-3's schedule).**
```
1 | action T: void child(); a.set(1) | child's driver captures T (invoked under T); receipt {1@s1,T} parked
2 | outer settles → F3 retires T | fold commits 1; slot swept per lifecycle
3 | childGate resolves; child driver pushes T | liveness check: T retired → carrier treated as NULL + dev warning ("continuation outlived its action")
4 | child: a.set(2) | ambient classification → default D → receipt {2@s2,D}; ordinary batch; commits at D's retirement ✓ (React parity: a late setState from an un-awaited child lands in its own batch)
5 | pre-settlement variant | child resumes while T parked-live → attributed to T, parked ✓
outcome: retired tokens have a total policy: never intern, never crash, never contaminate; rung-uniform.
residual: test 26; the pre/post-settlement window is a documented semantics line, not a hazard.
```

### C13 — counter/world-id lifecycle

As base, plus the new §15′ rows walked: (6) walkGen wrap → renumber sweep
of lastWalk column ✓; (7) lockViewId/generation — pooled record retained
until last holding pass drops, gen-bumped before reuse; stale view id in a
worldKey ⇒ key mismatch ✓; (8) lineage stage cache dies at lineage death
(stamps are globalSeq values, renumber rewrites) ✓; (9) saturation
force-clear leaves entries (retiredSeq intact) — visibility of retired
entries is slot-free; recycled slot's wc zeroed at intern; fastPathDisabled
dies with the pass ✓; (10) publication serials — CAS + completion sweep
(fork test 22) ✓.

### C14 — StrictMode and replays

As base, with two re-walked rows: (4′) staged evaluator replay — identical
deps hit the **lineage cache** → same stamp (idempotent, now also across
retry passes); (5′) restart with changed deps → new stamp → memo stamp-
vector fails → re-eval ✓ (ECX-6 dead). Thenable identity row unchanged
(lineage-positional) ✓.

### C15 — suspense across worlds

Steps 1–4, 6, 7 as base. Changed steps:

```
4′ | settle → retry (staged evaluator upstream — BC-F2's schedule) | retry pass P2: hook deps equal to lineage cache → SAME stamp S1 → prefix (n, S1) pairwise-equal → SAME entry → settled value consumed ✓ (livelock dead)
5′ | cross-batch retirement between fetch and retry touching prefix atom a | vSr(a) moved → fp mismatch → R11 REVALIDATION: re-fold a in this world — value CHANGED (the retired write is newly visible here) → drop + refetch from the moved world ✓ (I20/I21 preserved)
5″ | content-neutral flip (BCX-4: lock→retired handover; BC-F7: equal-value churn) | fp moved (vSr) → re-fold in this world → isEqual(old, new) TRUE → re-stamp prefix entry in place → SAME entry → settled resource consumed ✓ no duplicate fetch, no starvation
outcome: identity = lineage; validity = receipt-line content with value revalidation; the three trap keys stay excluded; over-invalidation now costs one fold, not one fetch.
residual: prefix length + re-fold cost — SPK-G8 (O21); purity pins determinism (C14).
```

### C16 — effects observe committed state only (+ B1, + C16-D new)

Core and B1 as base (vSr at retire-folds; lock-in variant now via lS —
walked at C11-A). New:

**C16-D (deps-change re-track; R14 — BCX-3's schedule).**
```
1 | committed effect E deps [false], fn reads a | subscription a→E recorded at run
2 | React-only update: deps [true], new fn reads b | React's native effect machinery re-fires E at ITS commit (deps changed — standard useEffect semantics; no F9, no walk needed)
3 | E cleanup + re-run | re-reads: subscribes b, drops a; snapshot [(b, fp)]
4 | later b.set(1) | walk reaches E via its live subscription → enqueued → re-runs ✓
outcome: effect evaluator identity is React's own deps contract; the engine never routes effect fn changes through staging/F9.
residual: conformance row pinning cleanup/re-subscribe order.
```

### C17 — optimistic rollback

Closed by deletion, as base (no truncation surface; public-API snapshot
test forbids accidental export — breaker's row adopted).

### T8-N — quiescence refresh (+ cone carry)

Base walk steps 1–2 unchanged. Step 3′ (R16, breaker B3's schedule):
```
3′ | writing-computed exemption | w fails refresh twice → exempt; carry = FULL reverse-reachable K1 cone of w: traverse K1 in-edges to fixed point (x→u, u→w both copied; mixed K0/K1 paths stay connected because K0 persists); episode resets
4′ | ep2: k writes x | walk follows carried x→u→w → W delivered in k's lane ✓ (in-edge-only carry lost x→u — dead)
5′ | termination | R = Σ(2 − strikes) strictly decreases per failed sweep; fixed set ⇒ ≤2N+1 attempts; unbounded new observed work ⇒ signal-loop budget throws (not a quiescence claim)
outcome: the reach induction's basis premise survives exemption; cone is finite, traced, dev-warned on growth.
residual: cone-size soak test; permanent-writer retention is known gap #10 (breaker), carried.
```

---

## Part IV — spikes and open measurements (nothing unmeasured asserted)

Queued: **SPK-L** (LOGGED-quiet floor on idle machine; O19 renegotiation),
**SPK-N1** (value-blind fan-out; breaker W1 workload + held-batch row;
walkGen priced here), **SPK-G8** (restart-heavy worlds; breaker W3 +
flattened-prefix length + R11 re-fold cost), **SPK-W** (logged write;
+walkGen stamp), **SPK-R** (dense retirement; breaker W5 A/B under the
corrected G-R-core/G-R-react comparators), **SP2** (E-PRESERVE validator —
promoted to CI fuzz gate; >10% dev ⇒ sampled). G-A's measured carrier
numbers stand (I30); the scheduler-shim and boundary-warning rows extend
its matrix (correctness rows, cost at registration only). No new spike is
required by the repairs: every added hot-path instruction (taint branch,
staged probe, walkGen, lockTerm) is enumerated in an existing gate's
ledger and CI-checked there.

*Synthesis complete. 10 mechanisms; 9 fork facts (~16 sites, 27 fork/build
tests); 28 findings adjudicated (25 confirmed → R1–R17, 3 refuted with
walks); battery re-walked in full with 8 new named schedules (T11′–T14,
C3-R, C11-A, C12-T, C12-F, C15-5″, C16-D); exit NOT recommended this
round — round 4 must adversarially re-review the new math (taint routing,
walkGen, lock views, lineage-stable stamps, value-revalidated prefixes,
F9 ordering, scheduler capture, retired-token fallback, saturation
spillover).*
