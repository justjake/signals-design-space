# Round 1 — codex review addendum (late adjudication)

Context: the round's synthesis and judge ran without the four codex
cross-model reviews (infrastructure bug, fixed); the codex reviews were
re-run out-of-band. This addendum folds them into the round's record. Every
verdict below is re-derived against the SYNTHESIS's repaired design (not the
original two-kernel draft); "ALREADY-REPAIRED" cites the synthesis section
that closes it, "NEW-CONFIRMED" quotes the step where the repaired design
breaks. Adjudicator: late-review agent, 2026-07-04.

---

## Part I — The winner review (review-two-kernel-codex.md), every finding

| # | codex finding | class | disposition |
|---|---|---|---|
| TKC-1 | retirement stamps vs pins incomparable | **DUPLICATE** of TK-F3 (claude), **ALREADY-REPAIRED** | R3: retirement stamps mint from `++globalSeq` (§4.3 step 1, §12); C7 walk step 5 restated on the shared line. Cross-model independent derivation → the R3 repair now has both-reviewer evidence class. |
| TKC-2 | suspension settlement absent from memo validity | **NEW-CONFIRMED** (blocker, local fix) | Schedule below (A1). §8.2 validity = epoch + slot clocks only; a settled thenable changes a world-visible outcome with no write and no retirement, and §8.1 "memo hit + valid → return (sentinel boxes rethrow)" intercepts the retry before the §8.4 lineage cache is ever consulted. C15 walk step 4 ("cache hit → settled value") asserts an outcome the stated predicate does not produce. Same defect class as judge B1 (see Part III). |
| TKC-3 (leg A) | unflagged `k0.pull` recomputes against newest and serves a non-newest world | **ALREADY-REPAIRED** (duplicate of the TK-F1 class) | R1's routed-serve rule + invariant R (§5.2/§5.3): an unflagged non-CLEAN_TRACKED node is never pulled for a non-newest world — it world-evaluates. Codex's steps 3–4 ("takes the native k0.pull fast path... recomputes against canonical newest") are structurally unreachable in the repaired routing; this is the C1-T8 walk's class. Third independent derivation of the round's central lesson (TK-F1 ≡ CO-F1 ≡ TKC-3A). |
| TKC-3 (leg B) | `afterRetrack` fails to propagate a newly raised flag through existing downstream edges | **NEW-CONFIRMED** (blocker, local fix) | Schedule below (A2). Invariant F is path-transitive but the afterRetrack maintenance site is node-local; with equality cutoff the downstream node stays CLEAN_TRACKED and F=0, and invariant R's proof then serves it wrongly. The judge's construction audit (Part 3.1.i) accepted the three-site enumeration — the sites are the right sites, but this one's fix-up has the wrong reach. |
| TKC-4 | a batch can retire before a not-yet-registered watcher observes it | **NEW-CONFIRMED** (blocker, local fix) | Schedule below (A3). The repaired fixup (§10.2) enumerates "each live deferred token" — a token that retired in the mount window is absent from the enumeration, so `runInBatch` is never called and the advertised dead-token urgent fallback (C10 walk step 5) is unreachable. The §10.3 reconcile backstop ran at retirement, before the watcher existed. |
| TKC-5 | singleton fixup checks miss multi-batch interactions | **DUPLICATE** of TK-F2/OP-F2, **ALREADY-REPAIRED** | R2: reach-based fixup with no equality filter (§10.2, C10 joint variant, gate G-F). Cross-model confirmation → I13's evidence class upgrades. |
| TKC-6 | per-root lock-in bits survive slot recycling | **NEW-CONFIRMED** (blocker, local fix) | Schedule below (A4). No site in §4.3 (retirement steps 1–5) or §12 clears `lockedIn(r)` bits; the slot-recycle row clears the write clock and watcher bit column only, and §12 has no lockedIn row at all. A recycled slot's bit makes every root that ever locked it include the NEW batch's unretired writes. Compounds the judge's C13 inventory gap (see Part III). |
| TKC-7 (a) | `globalSeq` 2^53 saturation has a test but no mechanism | **NEW-CONFIRMED** (spec gap, low practical severity) | The ++ genuinely stops advancing at 2^53 (float64), making `slotWriteSeq == memo.seq` permanently — but reaching it needs ~2^53 writes (centuries at 10^9/s). C13's frozen rule still requires a *named* guard, and a forced-small test cannot even be built without one. Converges with CO-codex-7 and FN-codex-8 (three codex reviews independently flag the same inventory discipline hole). Fix: a stated saturation behavior (assert/forced-quiesce) + token-serial allocator construction. |
| TKC-7 (b) | episodeEpoch tag wrap corrupts K1 | **NEW-CONFIRMED** (corrects a stated claim; local fix) | Schedule below (A5). §7.4/§12 claim "tag-wrap collision = over-notify only" — false: a stale-accepted K1 id points into the bump-reset plane; edges recorded there are destroyed when allocation later mints that slot fresh (init zeroes `firstOutLink`) → **missed notification**, not over-notification. Fix: bulk-clear the column at quiescence, or validate accepted ids against the bump frontier. |
| TKC-8 | fnVersion omitted from formal memo validity | **NEW-CONFIRMED** (high, one-line fix) | The memo record carries `fnVersion` (§3) and §10.1 bumps it, but the §8.2 validity predicate checks epoch + slot clocks only and the key is `(node, worldKey)`. A React-only deps change (no signal write, same mask/pin/epoch) hits and serves fn1's value under fn2. Also carries a residual from TKC-3: an fn swap must mark the K0 record non-CLEAN, or CLEAN_TRACKED serves the stale-fn value on the K0 side too — neither is stated. Same predicate family as TKC-2/B1. |
| TKC-9 | discarded fresh nodes are not GC fodder | **NEW-CONFIRMED** (high — resource exhaustion, needs a small lifecycle design) | §10.1/C14 step 3 call unregistered fresh nodes "GC fodder", but a fresh `useComputed` mints a K0 arena record (bump-allocated Int32 rows); a collected JS wrapper cannot reclaim it, quiescence resets K1 only, and K0 has no stated free/reuse protocol. StrictMode + interrupted mounts make abandoned-mount loops ordinary, so K0 grows without bound. Repair shapes: defer K0 allocation to commit-registration (fresh nodes already world-evaluate pre-registration since they fail CT), or a free-list. |

### The new failing schedules (against the repaired design)

**A1 — TKC-2, permanent re-suspension (C15 quiet leg):**

```
1 | k-pass P1 (mask {k}, pin p) evaluates c | ctx.use(th) pending → lineage cache[(c,Lk,0)]=th; M(c,wk)={sentinel, seq, epoch}; throw → React suspends
2 | th fulfills; NO writes, NO retirements | globalSeq, worldMemoEpoch, mask, lockedIn unchanged
3 | React retries: pass P2, same lineage Lk | pin = current globalSeq = p → worldKey IDENTICAL
4 | read c: F=1 → worldMemoRead(c, wk) | §8.2: epoch ✓, ∀slot wc ≤ memo.seq ✓ → VALID → §8.1 rethrows the cached sentinel; evaluation never runs, ctx.use/lineage cache never consulted
5 | React suspends on the settled thenable, pings, retries | loop at step 3. k never commits.
```
The breaking step is 4: "writes or retirement are the only invalidation
sources" is false — settlement is a third. (The K0-side sentinel cache has
the same question at NEWEST; donor async semantics need a pin.) Fix: sentinel
memos are never "valid" without a settlement-status probe (or settlement
bumps a generation the predicate checks).

**A2 — TKC-3B, stranded-CLEAN downstream node:**

```
setup | ep.1 left c STALE (cross-episode marks persist — the T8 fact); d = g(c), K0 edge c→d; F(c)=F(d)=0; atom a: T live, tape {set 1}, base 0, F(a)=1; c's fn (after a React-only swap, fnVersion bumped) = () => 1 - a.state; old cached c = 0
1 | NEWEST read pulls c | recompute at newest: reads a=1 → c = 0 (equal to cached!) → K0 equality cutoff: d NOT marked, d re-verifies CLEAN; retrack installs edge a→c
2 | afterRetrack(c) | F(c) |= F(a) = 1 — but F(d) stays 0: no site propagates the raised flag through the EXISTING edge c→d
   | invariant F now violated: a (receipted) has K0 path a→c→d with F(d)=0
3 | urgent pass (mask excludes T) reads d | §5.2: F(d)=0, CLEAN_TRACKED ✓ → serves K0 d = g(0)
4 | but d's T-excluded world value | c_w = 1 - fold(a)=1-0 = 1 → d_w = g(1) ≠ g(0) → torn frame
```
The breaking step is 2: invariant R's proof leg "F(n)=0 ⇒ no receipted atom
reaches n" is sound only if F's maintenance is path-closed; the afterRetrack
site fixes the retracked node, not its cone, and the equality cutoff removes
the staleness that would otherwise have routed d to the world path. Fix:
when afterRetrack raises F(n) 0→1, run a flag-propagation walk from n
(recomputes are rare; cost bounded).

**A3 — TKC-4, retire-during-mount race:**

```
1 | deferred k writes a=1 (root A) | tape entry; walk flags a; NO watcher on a on root B yet
2 | root B: pass P mounts W reading a | world (mask∪lockedIn(B), pin p) excludes k → renders 0; yields (or simply: window between render and layout effects)
3 | k retires (A commits / no-work close) | retiredSeq = sr > p; base(a)=1; §10.3 reconcile scans registered watchers — W not registered (registration is at commit effect)
4 | B commits P (DOM: 0); W's layout fixup §10.2 | F(a)=1 → past the fast-out; "for each LIVE deferred token": k is retired → loop empty → needUrgent never set → no corrective
5 | committed world a=1; W shows 0 until some future a-write | stale committed frame, indefinitely
```
The breaking step is 4: the C10-walk's step-5 fallback fires only when
`runInBatch` is *called and returns false*; a token retired before
enumeration is never called. Fix (local): when F(n)=1, also fold-compare the
rendered value against the current committed-for-root world; mismatch →
urgent pre-paint setState — the enumeration covers live tokens, the
fold-compare covers dead ones.

**A4 — TKC-6, lock-in bit outlives its slot:**

```
1 | batch k (slot s) commits on root A | lockedIn(A) |= bit(s)
2 | k retires; entries stamped+compacted; slot s released (unswept=0, token h keeps the episode alive) | §4.3 step 5 zeroes wc[s] and the watcher bit column — lockedIn(A) untouched (no clearing site exists; §12 has no lockedIn row)
3 | new batch j interns slot s; writes x=2; has NOT committed on A |
4 | urgent pass on A | mask {U} ∪ lockedIn(A) ∋ s → fold includes j's unretired entry (slot∈mask ∧ seq≤pin) → renders x=2
```
Root A contradicts its own committed DOM (the exact C11 sin the lock-in
mechanism exists to prevent). Fix: retirement (or slot release) clears
bit(s) from every root's lockedIn — sound because retired entries are
visible through the retired clause and no longer need the mask; or key
lock-in by token generation.

**A5 — TKC-7b, tag-wrap K1 edge loss:**

```
1 | episode E: node a's cold column holds (tag=E, k1Id=q) | quiescence: plane bump-reset (pointer→0); column NOT cleared (§7.4's stated design)
2 | drive the packed tag to wrap back to E without touching a (forced-small build) |
3 | a's entry accepted as current; a world eval records edge a→c into record q — beyond the bump frontier, unreserved |
4 | later K1 allocation reaches slot q, mints it for node z | init zeroes q.firstOutLink → a→c destroyed
5 | write to a whose only path to a watcher was a→c | walk reaches nobody → MISSED notification
```
Step 4 breaks §7.4's "shared record = over-notification at worst" claim.

---

## Part II — Transfers and quarry from the three non-winner codex reviews

### Findings that ALSO apply to the synthesis's final design

- **CO-codex-4 — lineage-keyed positional thenable cache reuses a stale
  resource after an intra-batch write.** **NEW-CONFIRMED** (blocker, local
  fix). Against §8.4: T writes `key=1`; c suspends, cache[(c,L,0)]=load(1);
  T's async continuation writes `key=2` (same token, same batch-set → SAME
  lineage); wc[T] bumps → world memo invalid → retry re-evaluates c ✓ — but
  ctx.use position 0 hits the still-live entry and returns load(1) for a
  world whose key is 2. §8.4's lifetime is commit/abandon only; nothing
  invalidates positional entries on included-slot writes. Fix: tie the
  positional cache's generation to the memo that created it (drop entries
  when the world memo invalidates), keeping identity stable across
  *pure* retries per C15.
- **CO-codex-3 — async-action continuation write attribution has no
  construction.** **NEW-CONFIRMED** (blocker, seam-level). The synthesis
  asserts C12 walk step 3 "one token across the await (fork parks)" —
  parking (F3) controls retirement lifetime only. F1
  `getCurrentBatchToken()` during a post-await continuation is undefined;
  with two parked actions, any global "current parked token" is ambiguous
  and a misclassified `a.set(2)` either leaks into NEWEST mid-action or
  folds under the wrong token. Needs a named protocol fact (fork-side
  async-scope/continuation identity) + fork test; "same token across await"
  is currently exactly the kind of unaccompanied assertion the seeds ban.
- **OP-codex-6 — ReducerAtom has no reducer-version semantics.**
  CONFIRMED spec gap (high). §4.2 "actions as ops" records actions only;
  which reducer replays them when the reducer closure changes across
  renders (captured props) is unstated, and React's own choice (queued
  actions replay through the *rendered* reducer) is what the C3 useReducer
  differential will assert. Fix: stage reducer identity per render/lineage
  in the fold, or document-and-test latest-reducer semantics matching React.
- **CO-codex-2 — updater/reducer callbacks reading signals during folds are
  an unrecorded dependency channel.** CONFIRMED contract gap (medium).
  Winner folds execute `update(fn)` ops at fold/retire time; an fn reading
  `b.state` resolves at NEWEST regardless of the folding world, and no edge
  or validity entry records it. React's parity answer is that updaters must
  be pure; the design must *state and enforce* it (throw or untracked-with-
  documented-caveat at fold time), per the seeds' restrict-the-interface
  rule.
- **CO-codex-7 / FN-codex-8 / OP-codex-7 — counter constructions** (seq
  saturation mid-episode, token-serial wrap allocator, retirement that
  cannot refuse after an irreversible commit): all converge with TKC-7a.
  One theme: §12 answers "what makes reuse safe" per structure but not
  "what happens at the horizon" per counter; the token-serial allocator has
  no live-skip construction and no §12 row. Folded into proposed note N7.

### Not transferring — where the winner's structure dissolves the attack (validating)

- CO-codex-1 (mask-only memo keys): winner keys memos by worldKey including
  the pin. CO-codex-5 (no root context for ordinary passive effects): the
  winner's K0-newest value model means NEWEST already contains every
  committed-on-this-root write; C11's requirement holds without root
  context for ordinary effects. CO-codex-6 (equal-canonical retirement
  changes a pending world silently): the winner has no `k0Changed` delivery
  gate, the K1 edge from the pending world's own evaluation carries the
  cross-batch write, and the retirement epoch bump kills every memo —
  re-walked, closed. CO-codex-8 (half-folded retirement visible to sync
  core effects): winner folds move base bookkeeping only; K0 newest was
  final at write time; the §4.3 step ordering puts all folds before any
  flush.
- FN-codex-1 (pin-free retired-visibility) = FN-F2, repaired verbatim
  (both pins in the visibility math). FN-codex-2 (default pass poisons
  canonical graph) = FN-F1 class; winner never re-tracks K0 from world
  evaluations. FN-codex-3 (one canonical cache vs per-root committed
  worlds): winner's committed-for-root is a fold with rootLockInVariant in
  the worldKey. FN-codex-4 (gate misses later-minted tokens): re-walked
  against the winner — the T1-transplanted retirement fold-walk (§4.3 step
  4) walks K0∪K1 from every base-moved atom at each retirement, and K1
  edges persist to quiescence, so the late token's divergence is delivered
  at its own retirement; closed, and it validates making the retire-edge
  flush an explicit mechanism. FN-codex-5 (core effects miss divergent-dep
  writes): winner core effects observe NEWEST over an eagerly-current K0;
  staleness marks + coalesced flush close the interleaving. FN-codex-6
  (read sets destroyed before adoption): winner memos/K1 persist to
  quiescence; nothing is adopted from pass memos. FN-codex-7 = FN-F10 (T4).
- OP-codex-2 = OP-F2 (R2). OP-codex-3 = OP-F5 (T5). OP-codex-4 (frontier
  ownership) — winner K1 is add-only, ownerless. OP-codex-9 (hung thenable
  blocks quiescence) — already closed by T6, independently confirming it.

### Quarry (novel mechanisms/schedules worth the notes)

- **OP-codex-1 — `ctx.previous` as an unrecorded world input.** The winner
  never mentions a previous-value computed API, but the donor (alien-style)
  exposes one; if it survives into the public computed signature, "which
  previous does world w see" becomes a memo-validity input exactly as the
  rebase schedule shows (T's correct value changes when U commits, with no
  recorded dep moving). Must be answered (expose-with-semantics or drop) in
  round 2.
- **OP-codex-5 — head/world suspension-cache boundary.** In the winner: a
  RENDER_NEWEST pass suspends through K0's sentinel cache; a later
  live-excluded retry of the same batch-set takes the world path with an
  empty lineage cache → one duplicate fetch and one thenable-identity flip
  before converging. Bounded, but pin with a test alongside the TKC-2 fix
  (K0-side settlement semantics are donor territory and currently
  unpinned).
- **OP-codex-10 — observed-count/refcount wrap.** The winner's
  microtask-debounced observed lifecycle carries implicit counts with no
  §12 rows; same inventory theme as N7.
- **FN-codex-1's mount shape** (two fresh siblings, no registered watcher,
  retirement between their first reads) is a good additional test vector
  for the TKC-4 repair — same race, different entry point.

---

## Part III — Interaction with the judge's confirmed blocker (B1)

Yes — same root cause, three independent holes in one predicate family.
Judge B1: the effect-flush version fingerprint (`seq of newest visible
entry, else 0`) is not monotone across retirement compaction. TKC-2:
thenable settlement is an invalidation source absent from §8.2. TKC-8:
evaluation-function identity is absent from §8.2. All three are instances
of "the validity/version story enumerates change sources incompletely
(writes, epochs) while world-visible outcomes also change via compaction,
settlement, and fn swaps." They should be repaired as ONE pass — define a
persistent per-atom version (B1's fix) and a closed change-source
enumeration for memo validity — not three point patches; B1's own repair
adds a new seq-retainer that §12 must row (the judge said this), and TKC-6
shows §12 is also missing an entire *mask*-retainer class (lockedIn), on
top of the judge's two missing seq-retainers (effect dep versions,
lastRenderSeq). Compounding, not contradictory: the architecture's
load-bearing structures (K0/K1, tape, walk, routing) survived both
reviewers; the lifecycle/validity bookkeeping layer is where every
confirmed defect now lives.

---

## Part IV — Tally

**New confirmed blockers against the final (repaired) design: 7.**

1. **TKC-2** — sentinel world-memos stay "valid" after thenable settlement
   → permanent re-suspension; C15's quiet leg never commits (schedule A1).
2. **TKC-3B** — afterRetrack raises F node-locally; equality cutoff strands
   a CLEAN downstream node → invariant-R serve of a world-divergent value,
   torn frame (schedule A2).
3. **TKC-4** — batch retires inside the mount window → fixup's live-token
   enumeration is empty, dead-token fallback unreachable → indefinitely
   stale committed frame (schedule A3).
4. **TKC-6** — lockedIn bits never cleared at slot recycle → a root renders
   a new batch's uncommitted writes, contradicting its own DOM (schedule A4).
5. **TKC-8** — fnVersion stored in the memo but absent from the §8.2
   validity predicate (and fn swaps don't dirty K0 CT) → stale-function
   value committed.
6. **CO-codex-4 (transfers)** — lineage-keyed positional thenable cache
   survives intra-batch writes → retry renders data fetched from a stale
   world.
7. **CO-codex-3 (transfers)** — post-await write attribution for async
   actions has no protocol construction; two parked actions are ambiguous
   → wrong-world exposure or wrong-token fold.

**Additional new confirmed non-blockers:** TKC-7b (K1 tag-wrap causes
*missed* notification, refuting §7.4's "over-notify only" claim; forced-wrap
only), TKC-9 (abandoned fresh nodes leak K0 arena records permanently — the
"GC fodder" claim has no construction), TKC-7a + convergents (counter
horizon/allocator constructions unstated; low practical severity, C13
letter unmet), OP-codex-6 (reducer-version semantics), CO-codex-2
(updater-purity contract unstated), OP-codex-1 (ctx.previous question).

**Coverage of the winner's codex review by the claude-only synthesis:** of 9
findings, 2 were exact duplicates of claude findings already repaired
(TKC-1=TK-F3→R3, TKC-5=TK-F2→R2) and 1 was half-covered (TKC-3A = the
TK-F1 class → R1); 6.5 survived the repairs. The codex reviews *validate*
every structural repair (R1–R4, per-write walk, persistent K1, retirement
fold-walk, lineage keys — several now carry both-reviewer evidence) while
finding a complementary defect stratum the claude column largely missed:
lifecycle predicates, cache-validity change-source enumeration, and
protocol facts asserted without construction. The non-winner codex reviews
are ~80% dissolved by the winner's structure (10+ items re-walked closed,
each validating a specific synthesis choice) with 4 transferring items.

**Verdict on the winner:** the two-kernel architecture still stands — no
new finding touches K0/K1/tape/clock/walk/routing, all seven blockers have
local or seam-local repair shapes, and three of them (TKC-2/TKC-8/judge-B1)
share one root cause that should be fixed as a single validity-predicate
redesign. But "4 seam repairs" undersold the round: the true round-1 defect
count against the final design is 8 blockers (7 here + judge B1), and round
2 must treat the lifecycle/validity layer with the same rigor the round
gave the routing layer.

---

## PROPOSED-NOTES (monitor applies or rejects each)

### INVARIANTS (proposed)

- **N1 (I-class).** World-cache validity must enumerate a CLOSED set of
  change sources for world-visible outcomes. Writes and retirement epochs
  are not enough: retirement *compaction* collapses version fingerprints
  (judge B1), thenable *settlement* changes a sentinel memo's correct
  outcome (TKC-2/A1), and *evaluation-function identity* changes the value
  with no signal write (TKC-8). Evidence: three walked schedules, two
  models + judge independently (both-reviewer class for the family).
- **N2 (I-class).** Node-local fix-up at an edge-creation site is
  insufficient for a path-transitive invariant: raising a reach/sensitivity
  flag at `afterRetrack` must propagate through the node's existing
  out-edges, because equality cutoff can leave downstream nodes CLEAN and
  unflagged while genuinely world-divergent. Evidence: walked schedule A2
  (codex TKC-3B, re-derived against the repaired design).
- **N3 (I-class).** Mount/subscribe fixups must not rely solely on
  enumerating *live* tokens: a batch can retire inside the mount window
  (render → layout effect), making any per-token corrective unreachable;
  the fallback trigger must be a value/version compare against the current
  committed-for-root world. Evidence: walked schedule A3 (codex TKC-4);
  the C10 seed's own race clause demands the fallback the enumeration
  cannot reach.
- **N4 (I-class, extends I8).** I8's epoch rule generalizes beyond
  counters: every *mask/bit column* needs a stated clear site paired with
  the identity-recycle it outlives (lockedIn masks at slot recycle —
  walked schedule A4; NM columns; observed/ref counts). A §12-style table
  must include mask retainers, seq retainers (judge: effect dep versions,
  lastRenderSeq), and allocator constructions, and be checked by schema
  sweep, not prose.
- **N5 (I-class).** Positional suspense caches need world-content validity,
  not just batch-set (lineage) identity: an intra-batch write invalidates
  the value memo but a lineage-keyed positional cache survives and replays
  a thenable fetched from the stale world (CO-codex-4 schedule, confirmed
  against the winner's §8.4). Stable-identity-across-pure-retries and
  invalidate-on-included-write must both hold.

### SCARS (proposed)

- **N6 (S-class).** "Discarded nodes are GC fodder" is false for
  arena-resident records: a collected JS wrapper cannot reclaim a
  bump-allocated integer record, and abandoned fresh-node mounts
  (StrictMode, interrupted transitions) are ordinary, so the leak is
  unbounded. Killing schedule: codex TKC-9 (repeat mount-evaluate-abandon;
  K0 grows monotonically; K1 reset and lineage drops reclaim nothing). Rule:
  any "harmless discard" claim over arena state must name the reclamation
  or staging protocol. Why not local-as-written: needs an allocation-
  lifecycle design (commit-deferred allocation or free-list), though small.

### OPEN (proposed)

- **N7 (O-class).** Counter horizons and allocators: state the mid-episode
  behavior at `globalSeq` saturation (physically remote; C13's letter still
  requires a named guard and a forced-small build cannot exist without
  one), the token-serial live-skip allocator construction, and the K1
  tag-width/clear policy (tag-wrap is missed-notification, NOT over-notify
  — schedule A5 refutes §7.4's claim). Three codex reviews converged here
  (TKC-7, CO-codex-7, FN-codex-8).
- **N8 (O-class).** Async-action continuation identity: F1's answer during
  a post-await continuation is unconstructed; parking (F3) is lifetime
  only. Needs a fork async-scope fact + fork test (two concurrent parked
  actions, interleaved settlements, differential vs React 19 action
  semantics). Evidence: CO-codex-3, transfers verbatim to the winner's C12
  walk step 3.
- **N9 (O-class).** Fold-callback purity: do `update(fn)`/reducer callbacks
  reading signals throw, read-untracked-at-fold-world, or record deps?
  Pick and enforce (React parity suggests: throw in dev). Evidence:
  CO-codex-2.
- **N10 (O-class).** Reducer identity in ReducerAtom folds: which reducer
  version replays queued actions after a rebase (React uses the rendered
  one)? Stage per lineage or document-and-differential-test. Evidence:
  OP-codex-6.
- **N11 (O-class).** Does the public computed API expose the previous value
  (donor does)? If yes, it is a world-eval input that memo validity and
  rebase must cover (OP-codex-1's schedule); if no, say so and pin with a
  conformance note. Also pin donor K0 sentinel-settlement semantics at
  NEWEST and the RENDER_NEWEST↔world suspension boundary (one duplicate
  fetch, one identity flip — OP-codex-5 shape).

*End of addendum. Not committed; monitor applies or rejects each proposed note.*
