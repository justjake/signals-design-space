# INVARIANTS — facts with provenance

Admission rule: a measurement (linked), a walked schedule (linked), or
independent confirmation by both reviewers. Curated by the monitor only.

- **I1. Always-log in React mode.** A world excluded from a render (C2
  flushSync/default) is reconstructible only if *every* write — urgent
  included — left a receipt; no "is anything concurrent live?" predicate can
  rescue skipping (the excluding render can arrive later in the same event).
  Provenance: walked schedule C2; independently derived in the A-synthesis
  §9.1 and confirmed by both 2026-07-04 reviews.
- **I2. Replay-in-write-order over the pre-batch base is the only
  React-parity fold.** Apply-and-discard urgent updaters folds 3 (or worse)
  where React commits 4. Provenance: C3 walk; candidate B's kill, verified
  against B's own worked example (extraction 2026-07-04).
- **I3. Canonical-topology-only invalidation/notification is unsound under
  world-divergent dependencies.** A pending world's read set can include
  atoms with no canonical edge to the reader; walks from those atoms reach
  nothing. Provenance: C1 walk; killed candidate C (verified architectural,
  extraction 2026-07-04); present-but-compensable in synthesized A (both
  reviews).
- **I4. First-divergence induction** (usable construction): a node's world-w
  evaluation and canonical evaluation read identical atom prefixes up to the
  first atom whose w-value differs from canonical; that atom IS a canonical
  dependency, so canonical-cone walks always catch the *first* divergence.
  Compensating mechanisms need only cover *subsequent* divergent-dep writes
  (nodes already evaluated-in-w). Requires computed purity. Provenance:
  derivation in review 2026-07-04T08-52 (F2), re-verified in re-judgment.
- **I5. Once-per-staleness notification dedup loses batch granularity.**
  Marks that stop walks / an armed-bit cleared until re-run cannot deliver a
  second batch's setState in that batch's lane (C4). Per-(watcher, batch)
  state or a per-write walk is required. Provenance: C4 walk; found
  independently in synthesized A (review F-family) and candidate D (ARMED
  gap, re-judgment).
- **I6. Passes span yields and event handlers run in the gaps.** Any
  "in-render" state scoped [pass-start, pass-end] misclassifies reads/writes
  during yields (C7). The fork must expose yield/resume edges or equivalent
  callstack truth. Provenance: React scheduler behavior + walked C7; both
  reviews of the synthesis concurred (writes-throw crash).
- **I7. Write-time equality drops are safe only with empty history.** With
  any pending entries, worlds disagree about the accumulator, so an
  equal-vs-newest (or equal-vs-any-single-world) drop loses a load-bearing
  receipt (C8). With empty history the drop is safe even for
  functional/reducer ops (the dropped op would hold the lowest seq in every
  fold — evaluate once against base). Provenance: C8 schedules (codex review
  finding 4 + claude review F5 refinement, mutually confirmed).
- **I8. Every counter reset needs a paired epoch/generation guard** on every
  structure that retained old counter values, or cross-episode collisions
  falsely validate stale state (C13). Provenance: claude review F8 (seq
  reset vs surviving memos) + D's k1Epoch pattern as the positive example.
- **I9. Kernel/layout facts** — see `SEEDS/research-facts.md` (measured;
  that file is itself invariant-grade and is not duplicated here).
- **I10. ≤31 live batches (one per React lane)** — slot/mask encodings are
  sound iff slot recycling is gated on zero *unswept* entries, not zero
  live entries. Provenance: fork registry design + A-synthesis §9.2 slot
  audit (verified held in review 08-52).
- **I11. The closed-kernel *protocol boundary* is free; the *storage
  change* is what costs 5–12%** (SP1 + SP1b, measured 2026-07-04, both
  conformance-gated: 179/179 + growth stress + exact pull counts before any
  benchmarking). SP1: a closed kernel with values/dispatch moved to a
  handle-indexed entity-object table runs deep 1.06–1.07×, broad
  1.05–1.09×, reads 1.09–1.12×, create 1.08–1.09× vs the donor (diamond
  ~1.0–1.02×, within noise). SP1b three-way isolation (donor / host /
  fused-dispatch): the call-boundary component is **0.99–1.02× on every
  shape** (a const-bound four-callback host protocol costs the same as
  same-closure calls), while the storage component carries the **full tax**
  (deep 1.08, broad 1.06, reads 1.11, create 1.08 min ratios).
  Implications: (a) closed-kernel/host-protocol designs are NOT blocked by
  the protocol itself; (b) what must stay packed is the kernel-adjacent
  value/fn side columns, index-aligned to the plane — moving them into
  policy objects costs 5–12% regardless of fusion; (c) codegen fusion of
  the dispatch buys nothing. SP1c (closed protocol + packed side columns
  kept in-plane-aligned, predicted ≈donor) is the queued validation.
  Provenance: `research/experiments/sp1-host-callback-tax.md`,
  `research/experiments/sp1b-fusion-isolation.md`; `libs/arena-host`,
  `libs/arena-host-fused`.

## Round 1 (2026-07-04): rounds/round-01/ — walked-schedule provenance per line

- **I12. A mark/flag fast-path routing gate is sound only with a freshness
  conjunct**: serve the canonical kernel to a non-newest world only if the
  node is unflagged AND its cached value can be served without recompute. A
  lazy pull / first evaluation is a fresh newest-basis evaluation that can
  acquire a receipted atom through an edge no plane has recorded;
  reachability-derived flags cannot see a path the pull itself creates.
  Provenance: [WALK review-two-kernel-claude F1] + [WALK
  review-compensated-overlay-claude F1]; codex independently re-derived the
  class (TKC-3A) — both-model. Repaired construction: synthesis §5.3
  invariant R (judge re-walked, held).
- **I13. Equality-filtered per-token correction cannot witness joint
  multi-batch divergence**; late-join/mount corrections must be reach-based
  (schedule into every live batch that could reach the node; over-render is
  the price). Adversarial f diverges only on rendered subsets; subset
  enumeration is exponential. Provenance: [WALK review-open-claude F2] +
  [WALK review-two-kernel-claude F2]; both-model (codex TKC-5 duplicate).
- **I14. Retirement and per-root lock-in edges need their own notification
  path to committed-world observers** (write-time queue entries get consumed
  by earlier flushes; urgent-applied retirement folds are value-no-ops;
  store-only batches never commit on any root). Provenance: [WALK
  review-compensated-overlay-claude F3] + [WALK review-fork-native-claude
  F4]. Positive construction: synthesis §10.4 three-trigger inventory.
- **I15. Every retirement stamp/pin comparison must live on one monotone
  number line with write seqs** — a private retire counter vs a global-seq
  pin admits retiredSeq(1) ≤ pin(100) for a post-pin retirement (C7 drift);
  dropping the `retired ≤ pin` clause fails from the other side. The seed
  visibility rule's two pins are load-bearing, verbatim. Provenance: [WALK
  review-two-kernel-claude F3] + [WALK review-fork-native-claude F2].
- **I16. World-cache validity must enumerate a CLOSED set of change sources
  for world-visible outcomes.** Writes and retirement epochs are not
  enough: retirement *compaction* collapses version fingerprints (judge
  B1), thenable *settlement* changes a sentinel memo's correct outcome
  (TKC-2), and *evaluation-function identity* changes the value with no
  signal write (TKC-8). Three independent holes in one predicate family —
  repair as a single change-source enumeration, and audit it as a table.
  Provenance: three walked schedules; two models + judge independently.
- **I17. Node-local fixup at an edge-creation site is insufficient for a
  path-transitive invariant**: a reach/sensitivity flag raised at re-track
  must propagate through existing out-edges, because equality cutoff can
  leave downstream nodes CLEAN and unflagged while genuinely
  world-divergent. Provenance: [WALK addendum A2 / codex TKC-3B,
  re-derived against the repaired design].
- **I18. Mount/subscribe fixups must not rely solely on enumerating LIVE
  tokens**: a batch can retire inside the render→layout-effect window,
  making every per-token corrective unreachable; the fallback trigger must
  be a value/version compare against the current committed-for-root world.
  Provenance: [WALK addendum A3 / codex TKC-4].
- **I19 (extends I8). Every mask/bit column needs a stated clear site
  paired with the identity-recycle it outlives** (lock-in masks at slot
  recycle; notification columns; observed/ref counts) — retainer tables
  must include mask, seq, and allocator retainers and be checked by schema
  sweep, not prose. Provenance: [WALK addendum A4 / codex TKC-6] + judge
  C13 inventory gap.
- **I20. Positional suspense caches need world-CONTENT validity, not just
  batch-set (lineage) identity**: an intra-batch write invalidates the
  value memo, but a lineage-keyed positional cache survives and replays a
  thenable fetched from the stale world. Stable-identity-across-pure-
  retries AND invalidate-on-included-write must both hold. Provenance:
  [WALK codex CO-4, confirmed against the winner's §8.4].

## Round 2 (2026-07-04): rounds/round-02/ — evidence class per line

- **I21. Monotone max-of-seqs fingerprints are not injective over
  visibility flips.** An OLDER entry becoming visible beneath an
  already-visible newer one (retirement's retired clause, per-root lock-in
  growth) changes the fold without moving the max; effect snapshots skip
  re-runs and thenable prefixes replay stale fetches. Every validity
  fingerprint needs a visibility-flip stamp (per-atom visStamp minted at
  every retirement fold touching the atom AND at every per-root lock-in of
  a slot holding its entries; over-invalidation only). [BOTH harden-claude
  F1 + harden-codex 2; repaired: synthesis §8/R1, re-walked]
- **I22. Evaluator identity is world-scoped state.** A hook-supplied
  fn/deps/reducer swap is a render-phase mutation; one shared mutable
  evaluator cannot serve concurrent passes, leaks uncommitted closures
  into NEWEST/committed evaluations after discards, and goes stale across
  restarts. Stage per pass; promote at the hook's OWN commit effect (hook
  grain, never pass grain); NEWEST/committed use the committed evaluator.
  [BOTH — four schedules, two models, three designs; synthesis §11.1′/R2]
- **I23. Mark/flag propagation on edge-add is insufficient without
  retroactive lane-scoped delivery**: a K1 edge recorded after a write
  must replay every still-live receipt's delivery through the new edge
  (runInBatch per slot bit), or a later single-lane render commits a torn
  frame corrected only post-retirement. Flags route reads; they do not
  schedule React. [WALK harden-codex 3; positive construction verified
  held by BOTH cost-hardened reviewers]
- **I24. Suspense content-validity stamps must be retry-stable
  receipt-line facts.** Per-(world-instance) memo-identity stamps re-fetch
  forever; global retirement clocks starve transitions under unrelated
  urgent traffic. Valid stamps: per-atom fingerprints (incl. I21 visStamp)
  and evaluator stamps, flattened across nested evaluations. [BOTH
  harden-codex 4 + lean-claude F1; synthesis §9.2′/R6]
- **I25. Per-root lock-in is a write-PREFIX, not token membership.** With
  post-await writes attributed to a parked action token, a root that
  committed the token's earlier updates must bound its committed view by a
  watermark (the committed pass's pin), or continuation writes leak into
  committed-for-root views before any commit carries them. [WALK
  lean-codex 1; synthesis §5.2′/R13]
- **I26. Async-action attribution = parking (lifetime) + continuation
  carrier (identity) — separate duties.** Ambient classification of raw
  post-await writes violates C12. Known-good carrier: token captured at
  async-resource creation, pushed per continuation, finally-restored; host
  async-context hook; loud startup self-test on unsupported hosts. [WALK
  harden-codex 5 (violation) + lean §5.1 construction held by BOTH lean
  reviewers; synthesis §12′/R7] Feasibility/overhead: SP-F8.
- **I27. The reach induction needs its basis-edge premise restored at
  every episode boundary.** A watched node whose current basis edges exist
  only in K1 strands after the K1 reset — quiescence must refresh
  (K0-pull at NEWEST) every K1-touched node with a committed watcher or
  effect-dep snapshot before clearing K1; R8-legal write during refresh →
  retry once then exempt-and-carry-forward (else livelock). [WALK
  synthesis T8-N + lean §M3 construction with its livelock schedule]
- **I28. Fold-replayed callbacks must not read signals — throw in all
  builds.** An untracked-at-fold-world read is an invisible dependency (no
  edge, no validity entry, no notification path); replay purity is
  load-bearing for I2 and every world-cache validity argument. [WALK
  cost-codex 3; positive form lean §1.1 held; synthesis §13/R12]
- **I29. World folds must apply custom equality stepwise against the
  view's accumulator** (keep the old reference on equal), exactly as the
  live write path did — post-fold equality cannot pick the right
  representative for both a U-only and a T+U view. [WALK lean-codex 8;
  synthesis §5.2′/R15]
- **I30. The continuation carrier is FEASIBLE at <0.5% event overhead via
  a bundler twin-build** (SP-F8, MEASURED 2026-07-04): each async fn
  compiles to native body + token-carrying generator driver behind a
  one-null-check dispatch; driver runs only while an action token is live.
  Unarmed ≈0% (noise floor); in-action +12 ns/await — cheaper than Node's
  AsyncLocalStorage (+38%) on the same shape; 74/74 correctness incl.
  Promise.all, timers, async generators, catch/finally restore, two
  interleaved actions with zero bleed. TC39 AsyncContext is Stage 4
  (ES2026) but shipped NOWHERE yet — ship the twin build behind an
  AsyncContext feature-detect ladder. THE PREREQUISITE MOVES FROM HOST TO
  BUILD: uncompiled third-party async code writing signals post-await
  inside an action misattributes; the loud boot self-test verifies the
  transform (never silent); support-matrix line: "requires
  bundled/transformed app code (or future AsyncContext)". Provenance:
  `research/experiments/spf8-continuation-carrier.md` + spf8-proto/.

## Round 3 (2026-07-04): rounds/round-03/ — applied from its notes-diff (monitor-validated)


- **I31. Evaluator identity is a fourth world-divergence source with no
  receipt; every routing/validity surface needs an evaluator conjunct.**
  A pass holding a staged evaluator diverges from K0's cache with zero
  receipts: fast-path routing needs a staged-probe conjunct, RENDER_NEWEST
  must demote on staging (not only on writes), memo validity must compare
  a flattened evaluator-stamp vector BEFORE any clock-based serve (nested
  evaluators included), and promotion must dirty the K0 node or the
  pre-promotion cache serves forever. [BOTH exit-claude F1 ≡ exit-codex 5;
  ladder half exit-codex 6; repaired construction synthesis §6.2′/§8′,
  re-walked T11′]
- **I32. K1 is a union across worlds; unions of per-world-acyclic graphs
  cycle. Every value-blind full walk needs per-walk visited state.**
  Monotone-frontier recursions (edge-add `newBits & ~touched`)
  self-terminate; value-blind notification/retirement walks do not — a
  two-flag program (`c = flag ? d : a`, `d = flag ? b : c`) hangs the
  write path. Per-walk generation stamp; cost priced in G-N/G-W; wrap
  lifecycle row required. [BOTH exit-claude F3 ≡ exit-codex 7; synthesis
  T12]
- **I33. Untracked reads license temporal staleness, never world leakage.**
  A K0 cache produced by an evaluation whose untracked read hit a
  receipted atom embeds possibly-pending state; serving it to any
  non-newest world leaks an excluded write (no edge exists to route, and
  recording one would violate untracked semantics). Node-grain taint
  (recomputed per NEWEST evaluation: untracked read hit non-empty tape)
  as a routing conjunct; world evaluations fold untracked reads in-world,
  edge-free. [WALK exit-codex 4; synthesis T13]
- **I34 (extends I21/I14). Every visibility-flip SOURCE needs both a stamp
  minted at every occurrence AND a durable (re-enumerable) flush path.**
  Watermark ADVANCES are flips (they admit entries below an
  already-visible max); consumable write-time queue entries get eaten by
  earlier unrelated flushes. Retirement → per-atom retireVisStamp;
  lock-in AND every advance → per-(root, slot) lockStamp captured in an
  immutable re-minted lock view whose id is part of committed-for-root
  worldKeys; retirement/lock-in flushes enumerate via touchedList, never
  only the queue. Root-scoping the lock term is load-bearing: a global
  lock-side stamp lets root A starve root B. [WALK exit-claude F2 +
  breaker-claude F3 (same family, two designs); root-scoping
  breaker §2.1-B1, held by both its reviewers; synthesis C11-A]
- **I35. Side-effect-bearing caches must value-revalidate before
  re-fetching.** Stamps legitimately over-invalidate (I21); a suspense
  capsule that refetches on every stamp move re-fetches settled resources
  on content-neutral flips (lock→retired handover; equal-value churn) —
  duplicate side effects and starvation under same-atom traffic. On fp
  mismatch: re-fold in this world, equality-stable compare, re-stamp in
  place when equal, refetch only on real change. Validity-by-value is
  legal where delivery-by-value is not (D13 governs delivery only).
  [WALK breaker-codex 4 + breaker-claude F7 (severity resolved by walk);
  synthesis C15-5″]
- **I36. Carrier capture must be registration-time for host-scheduled
  callbacks (AsyncContext parity); invocation-time capture alone strands
  every async callback scheduled inside an action.** The twin-build
  transform captures at generator instantiation; an async function handed
  to setTimeout inside an action instantiates on a bare stack and captures
  null → its writes commit before the action settles. Armed-gated
  registration shims on enumerated schedulers (timeout/interval/microtask/
  rAF/message) close the class; unshimmed registrars are documented
  boundary. Not an S22 repeat: shims cover explicit registration only —
  awaits still ride the transform. Verified against SP-F8: its "timers"
  row tested plain callbacks resolving awaited promises, not async-fn
  callbacks. [WALK exit-codex 1 + MEASURE spf8 artifact re-read;
  synthesis C12-T]
- **I37. A carrier token consulted after its retirement must degrade to
  ambient classification (+ dev warn), uniformly across rungs.** A
  fire-and-forget child continuation can outlive its action; rejecting
  crashes, re-interning creates never-retired receipts, recycling
  contaminates. Ambient fallback is React parity (a late un-awaited
  child's setState lands in its own batch). Per-resource park refcounts
  are NOT admissible: AsyncContext has no resource-creation hook (rung
  asymmetry) and a leaked never-settling child parks a lane forever.
  [WALK exit-codex 3; synthesis C12-F]
- **I38 (refines I7 and D16). Fold-op meaning is world-scoped once
  evaluators can stage.** (a) The empty-history equality drop is legal
  only for ops with world-invariant meaning — plain `set` always;
  updater/reducer only under immutable evaluators; stageable ReducerAtoms
  always append (a dropped "no-op" action replays differently under the
  staged reducer). (b) Reducer promotion with pending receipts must
  re-fold NEWEST under the new committed reducer and notify; (c) within a
  commit, evaluator/reducer publication precedes the retirement folds due
  at that commit, or the fold compacts under the stale reducer while the
  committed tree rendered the new one. [WALK breaker-codex 1 + 2
  (cross-design — exit candidate had the same text); synthesis C3-R]
- **I39. Slot bookkeeping must outlive every pass whose pin excludes the
  slot's entries, and slot demand must be bounded anyway.** Clearing
  touched columns at retirement while a pinned pass lives serves K0 to a
  world that excludes the retired write (torn frame); retaining them
  makes live-plus-retiring slots exceed 31 under an input storm during
  one yielded transition. Retain via the unswept gate (I10) AND define
  saturation: force-clear the oldest fully-retired slot and flip affected
  pinned passes to world-path-only (per-pass flag), with a forced test.
  [WALK breaker-claude F1 (both horns) + F5; synthesis T14]
- **I40. Evaluator stamps inside retry-crossing identity keys must be
  lineage-stable for equal dep values.** A Suspense retry is a new pass;
  per-pass fresh stamps make capsule prefixes mismatch every retry →
  refetch-forever livelock with duplicate side-effectful fetches (the
  S20-adjacent world-instance-identity class). Stage per pass for I22;
  mint per (lineage, hook, deps-values). [WALK breaker-claude F2
  (cross-design — exit candidate §11.1/§9.2 identical); synthesis
  C15-4′/C14]
- **I41. The evaluator promotion edge is "hook becomes current" (fork
  fact), not effect execution.** Hidden Offscreen commits promote with no
  effect firing; error-abandoned subtrees and stale alternates never do
  (generation CAS); publication must precede the same commit's retirement
  folds (I38c) and layout effects. [breaker §2.1-B2 construction, held by
  BOTH breaker reviewers; ordering hole breaker-codex 1-B; synthesis
  §11.1′/F9]
- **I42. Refresh-exemption carry must be the full reverse-reachable K1
  cone.** Reach is path-transitive; carrying only direct in-edges strands
  upstream links (`x→u` of `x→u→w`) and the next episode's write tears.
  Two-strike rank Σ(2−strikes) proves termination for a fixed observed
  set. [breaker §2.1-B3 + termination held by breaker-claude; the
  exit-candidate's in-edge carry killed by the same schedule; synthesis
  T8-N′]
- **I43. Mount-fixup corrective skipping is inclusion+clock, never
  equality.** Skip token t iff slot(t) ∈ the mount's rendered
  mask∪lockView AND wc[slot(t)] ≤ the rendered pass pin — a fully
  included token cannot diverge for that watcher, and a post-pin write
  fails the clock. Unconditional correctives double-render every mount
  inside a live batch's own pass (C9); equality-filtered skipping is S10.
  [WALK breaker-codex 6 (cross-design — exit-candidate C9(a) hand-waved
  "React bails"); synthesis C9′]

