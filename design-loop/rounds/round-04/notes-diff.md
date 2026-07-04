# Round 4 proposed notes diff

Evidence classes used: [WALK …] = walked schedule (cite), [BOTH …] = both
reviewers independently, [MEASURE …] = measurement. Round-4 artifacts:
designs `design-consolidate-{a,b}.md`, reviews
`review-consolidate-{a,b}-{claude,codex}.md`, synthesis `synthesis.md`
(all under `rounds/round-04/`).

---

## INVARIANTS.md — append under "## Round 4"

- **I44. Render-re-arm-only per-(watcher, slot) delivery dedup loses
  same-slot post-pin writes.** A set bit may suppress only writes that
  scheduled-but-unstarted work will fold; once a pass on the watcher's
  root has captured a pin below the write's seq (started, yielded, or
  completed-uncommitted), delivery must fire again — React's
  interleaved-update restart supplies the follow-up render (fork test
  32). Otherwise a later same-token watermark advance commits the write
  with no scheduled work for the watcher → torn committed DOM for an
  io-gated duration. The round-3 champion carries the identical rule.
  [BOTH: a-codex 2 ≡ b-codex 2 (same schedule, two designs); synthesis R2
  re-derivation + repaired construction]
- **I45. Committed-evaluator visibility is pin-scoped state, symmetric
  with receipts; promotion delivery must be value-blind.** F2's discard
  fact protects same-root passes only; promotion is global-committed, so
  a pass folding under a live-sampled committed evaluator tears
  intra-pass when a cross-root F9 promotion lands mid-yield. Effective
  evaluator = staged-in-this-pass else the committed version with
  greatest promotedAtSeq ≤ pass pin; superseded versions retained
  pin-gated (tape-compaction discipline). Equality-gating promotion
  notification on NEWEST is the S14 class: a NEWEST-equal promotion
  (r1(r1-fold) == r0-fold) still flips every non-newest world. Computed
  promotions need the same walk (K0-dirty alone notifies nobody).
  [BOTH: a-claude F1 ≡ a-codex 1 (two independent schedules); synthesis
  R1 + re-walk]
- **I46. Stage visibility must span the whole pass, not begin at the
  owner hook's execution.** Hook-time staging leaves tree-order-earlier
  consumers on the old evaluator → one commit, two evaluator worlds (the
  S23 residue). Sound shape: seed passStages from the lineage stage
  cache at pass start; treat any mid-pass stage-set change (mint,
  adoption, or contradiction-with-seed) as a divergence event that walks
  the node's cone delivering own-lane updates to watchers already
  rendered in this pass (queued to the yield/end drain → React's
  pre-commit interleaved restart); write the lineage cache through on
  committed-selection so restarts terminate. Applies to BOTH round-4
  designs (consolidate-a's C1-X1 walked only after-stager siblings).
  [BOTH: b-claude F1 ≡ b-codex 4; synthesis R3 + coverage/termination
  constructions]
- **I47 (extends I14/I34). Every committed-visibility flip's durable
  drain must reconcile watchers, not only effects — at retirement AND at
  every per-root lock-in/watermark advance.** A dependency edge
  discovered by a pinned pass after its writer retired has no live-token
  delivery path; the advance that exposes the write is the only
  pre-retirement correction point (global retirement can be io-gated).
  Coverage is closed: flips occur only at drains; touchedList[t]
  membership is guaranteed for any node whose committed fold t can flip,
  because bits flow through write walks and edge-adds while t is
  live-or-retired-unswept, and a swept/force-cleared token has no future
  flips (compaction is pin-gated; lock records cleared at full
  retirement; force-clear targets fully-retired slots only).
  [WALK: b-codex 3, re-instantiated against consolidate-a's
  effects-only advance drains; synthesis R4 construction + re-walk]
- **I48. One fold, one reference: per-(atom, world) fold results must be
  memoized, and the committed value installed at commit must be the
  committing world's memoized reference** (prefix equality holds by I25
  watermark = committing pass pin). Re-invoking updater/reducer ops per
  read yields `a.state !== a.state` within one render and
  reconcile/fixup correction ping-pong. Fresh references across
  *different* worlds are React's own rebase behavior (C3) and stay
  legal. [WALK: b-codex 1; synthesis R9]
- **I49. A shared monotone seq line needs a live-episode horizon
  protocol: discard all WIP passes first, then order-preserving rewrite
  + epoch bump.** Quiescence-only renumbering wraps under never-quiescent
  traffic → a post-wrap retirement stamps below a live pin → false
  retired-visibility and false compaction → torn frame. A live rewrite
  without the discard step strands seq-bearing identities held outside
  the library (F9 stage ids on React's WIP hooks) → publication CAS
  rejects the winner or collides. After discarding WIP passes, no
  seq-bearing identity survives outside the library. [WALK: a-codex 5 +
  b-codex 5 (the two horns of one protocol); synthesis R8]
- **I50 (extends I35/I8). Settlement callbacks for reusable capsule
  slots must validate the exact thenable identity (reference), never a
  wrappable generation.** Forced 2-bit gen + in-flight refetches: a
  superseded pending thenable settles after wrap and validates against
  the current occupant → wrong resource consumed / suspension ends
  early. [WALK: b-codex 6; synthesis R10]
- **I51 (extends I39, instance of I16-for-consumers). Force-clear
  compensation must enumerate EVERY consumer of the swept state**: pass
  reads (fastPathDisabled) AND the mount-fixup fast-out (capture the
  flag in the watcher's rendered-world snapshot). `touched==0 ∧ CT` is a
  cache-provenance certificate, not a committed-currency certificate,
  for a pass whose pin the sweep bypassed. [WALK: a-claude F2; synthesis
  R5]
- **I52 (extends I43). The mount-fixup skip bound is per-visibility-
  clause**: mask inclusion is bounded by the render pin; lock inclusion
  by that slot's watermark — skip iff wc[s] ≤ max of the bounds the
  rendered world's clauses actually granted. A single pin bound skips
  entanglement for post-watermark writes of a locked live token.
  [WALK: a-codex 4 (consolidate-b §7.2 shares the defect); synthesis R6]

## DECISIONS.md — append under "## Round 4"

- **D12 amendment (champion pointer).** Round-4 champion:
  `rounds/round-04/synthesis.md`, which incorporates
  `rounds/round-04/design-consolidate-a.md` as normative base text
  (self-contained restatement of the architecture) and amends it with
  repairs R1–R14 + transplants T1–T4. Architecture class D8 unchanged.
  Proof: adjudication Part I — 19 confirmed findings, every one carrying
  an in-architecture repair that reuses or deletes machinery; all four
  reviews' verified-held lists confirm the K0/tape/K1/visibility/seam
  core.
- **D19 (new). Fresh render-allocated arena records are pass-owned:
  commit transfers ownership; discard/lineage-death gen-frees.** This is
  the standing answer to SCAR S15's reclamation demand. Proof: [BOTH
  a-claude F3 ≡ a-codex 3 confirmed the gap in consolidate-a];
  consolidate-b's §11 construction survived both its reviews
  (transplanted with its generation invariant; synthesis R7).
- **D20 (new). lockViewId is the sole lock-visibility version; per-slot
  lockStamps and per-atom lockTerm are deleted.** I34's obligations are
  carried by: immutable per-advance view re-mints, the id in
  committed-for-root worldKeys and every basis/snapshot header, durable
  touchedList drains, and I35 value revalidation on id movement. Proof:
  consolidate-b's construction attacked and held by BOTH its reviewers
  (b-claude verified-held 7, b-codex verified-held lock-view row);
  synthesis T2 consumer audit (memos, snapshots, prefixes, fixup).
- **D21 (new). ActionScope surface is set/dispatch only** (runSync
  deleted — re-enters ambient carrier state with no walked need; D17's
  sanctioned escape is set/dispatch). Proof: no round-4 walk required
  runSync; synthesis T3.

## OPEN.md — updates

- **Round-4 outcome (replace the "Round-4 docket" section when applying):**
  NOT dry. 20 findings adjudicated: 19 CONFIRMED (three cross-design
  classes — I44 dedup, I46 stage-temporal, I47 drain coverage — of which
  I44/I47 are textually inherited by the round-3 champion), 0 REFUTED,
  1 NEEDS-MEASUREMENT. The round-4 docket's own repair targets (taint
  merge, walkGen atomicity, lock views, lineage stamps, I35
  revalidation, F9 ordering, shims, saturation values, mount w_fx) all
  HELD under adversarial re-derivation (both a-reviews' verified-held
  lists); the new blockers came from adjacent strata: evaluator
  visibility (I45), delivery dedup (I44), drain coverage (I47),
  lifecycle horizons (I49/I50), reclamation (D19). Synthesis repaired
  all of them in-architecture; mechanisms held at 9 with a net state
  deletion.
- **Round-5 stance suggestion (final budgeted round):** one builder
  stance `exit-hardening` — adversarially re-derive ONLY the synthesis's
  new math (R1 pin-resolved version chain; R2 pass-aware suppression; R3
  seeding/walk/termination incl. A/B/A; R4 closed drain coverage; R8
  live renumber; R9 reference installation; R12 baseline comparator)
  plus the merged fork-test list; no new mechanisms; judge re-walks the
  full battery. Dry round (zero new confirmed blockers, no score drop) ⇒
  present the exit case per LOOP.md.
- **O24 (new).** D13-fallback obligation: per-slot-mark delivery dedup
  may not be adopted on SPK-N1/SPK-W gate failure without its own walked
  schedule first (S17 re-entry risk: per-node cross-write elision state).
  [a-claude F7]
- **O25 (new).** K1/E-PRESERVE growth without quiescence is a declared
  gap (synthesis G9) with a bounded mid-episode sweep (dead-epoch memos ∧
  no committed observer ∧ no retained live/unswept bits); SPK-K1 measures
  the residual. [a-claude F5]
- **Spike queue table changes:** add row `SPK-K1 | K1 growth under
  never-quiescent traffic with the G9 sweep | >1 MB/h steady growth or
  >5% walk degradation on the soak workload → extend sweep predicate
  (sampled reachability), else G9 stands documented | queued`. Amend
  SPK-W row: “+ staging-walk/restart frequency (R3) + pass-aware dedup
  check (R2)”. Amend SPK-R row: “+ advance-drain watcher reconcile (R4)
  + promotion walk (R1)”. Amend G-F/W2 note: “+ 10k in-commit mounts +
  cross-root commit traffic (R12) + live-updater reference
  over-correction bound (R9)”.

## SCARS.md — append under "## Round 4"

- **S32. Live-sampled committed evaluators for pass folds ("staged, else
  committed" with no pin clause).** Killing schedule: shared ReducerAtom,
  receipts {X:inc, Y:dec}; r0=±1, r1=±10 (NEWEST 0 under both); root-B
  pass folds X-world = 1 under r0 and yields; root A commits a staged r1
  → P3 re-folds NEWEST 0→0, equality gate suppresses the walk; B resumes
  → sibling folds X-world under now-committed r1 = 10; one committed
  frame holds 1 and 10, matching no reducer version. Why not local: the
  fold rule, memo ladder, RENDER_NEWEST classification, and promotion
  delivery all sample "committed" — the repair is a visibility rule
  (pin-scoped versions, I45) plus value-blind promotion delivery, not
  added checks. (a-claude F1 ≡ a-codex 1; synthesis R1.)
- **S33. Delivery dedup re-armed only at watcher render.** Killing
  schedule: T writes a=1 (bit set, setState delivered); T's pass pins and
  yields before the watcher renders; a carried continuation writes a=2
  post-pin → bit suppresses the only setState; the pass renders 1 and
  commits (watermark = pin); a later unrelated T-lane commit advances the
  watermark past s2 while the watcher bails out → committed-for-root 2
  beside committed DOM 1 until the parked token's io-gated retirement.
  (a-codex 2 ≡ b-codex 2; rule I44; synthesis R2.)
- **S34. Hook-time-only stage gating.** Killing schedule: components S
  before O in tree order; a React-state-only transition changes O's
  useComputed deps; S reads the node pre-stage (committed f_A serve), O
  stages f_B and renders f_B output → commit mixes evaluator worlds; the
  naive restart re-runs S before O with an empty stage table → f_A again
  → livelock or torn attempt 2. (b-claude F1 ≡ b-codex 4; rule I46;
  synthesis R3.)
- **S35. Watcher reconcile at retirement only (advances drain effects
  only).** Killing schedule: c = flag ? a : b, W mounted; parked K writes
  flag=true (walk reaches W); K's pass pins, yields; store-only default D
  writes a (no edge to c) and retires; the resumed pass evaluates c=0
  (correct for its world), records the a→c edge too late for D, and
  commits, locking K → committed-for-root c=1 beside committed DOM c=0
  with no correction until K's io-gated retirement. (b-codex 3
  instantiated against consolidate-a; rule I47; synthesis R4.)
- **S36. Immediate slot release at retirement (clear reach bits, free the
  slot, keep only receipts).** Same schedule as S35 built on
  consolidate-b: the retired writer's bits are gone, so the
  late-discovered K1 edge carries nothing and the commit-time reconcile
  (against the pass's claimed world) passes → committed tear with no
  correction point at all. Retention (I10/I39) is load-bearing for I47's
  coverage construction. (b-codex 3; rejected in synthesis Part II.)
- **S37. The coarse receipt-count read gate as sole routing rule ("any
  unswept receipt anywhere ⇒ every render read world-routes").** Died on
  its own declared terms, not on a tear: the gate routes all render reads
  through world memos during exactly the traffic P1 measures, re-accepts
  O18's scarred restart-revalidation cost, and its author declared no
  fallback admissible ("a failed numeric gate rejects the design", b
  §13); its replacement math independently took the S34 stage hole and
  the I48 value-identity blocker. Future simplification attempts start
  from this price. (synthesis Part II; b §13/§13.1.)
- **S38. Quiescence-only counter renumbering — and live rewrites that do
  not first discard WIP passes.** Killing schedules: (a) forced-small
  horizon with a live pin: a post-wrap retirement stamps retiredSeq=1 ≤
  pin=6 → false retired-visibility and false compaction → torn resumed
  frame [a-codex 5]; (b) live rewrite renumbers the library's stage
  records while React's WIP hook holds the old F9 integer → CAS rejects
  the winning publication or collides with a fresh stage [b-codex 5].
  Rule: I49 (discard-WIP-first, then rewrite). (synthesis R8.)
- **S39. Generation-only guards on settlement of reusable capsule
  slots.** Killing schedule: 2-bit capsuleGen; five refetches while q0
  pends; gen wraps to 0; q0 settles late, passes the gen check, and
  poisons q4's capsule (wrong resource / early unsuspend). Rule: I50
  (exact thenable identity). (b-codex 6; synthesis R10.)
