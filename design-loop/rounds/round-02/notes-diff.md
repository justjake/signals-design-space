# Proposed notes diff — round 2 (synthesis)

Every line carries its evidence class: [WALK <where>] = walked schedule,
[BOTH <ids>] = independent confirmation by both reviewers (of one design,
or cross-model across designs), [MEASURE <key>] = measurement. The monitor
applies or rejects per line.

## INVARIANTS.md — proposed additions

- **I21. Monotone max-of-seqs fingerprints are not injective over
  visibility flips.** An OLDER entry becoming visible beneath an
  already-visible newer one (retirement's retired clause, or per-root
  lock-in growth) changes the fold without moving
  `max(newest-visible seq, baseSeq, …)`; effect snapshots silently skip
  re-runs and thenable prefixes replay stale-world fetches. Every validity
  fingerprint needs a visibility-flip stamp: per-atom `visStamp` minted at
  every retirement fold touching the atom AND at every per-root lock-in of
  a slot holding its entries (over-invalidation only, safe direction).
  [BOTH harden-claude F1 (two schedules) + harden-codex 2 (C3-shaped
  variant); repaired construction synthesis §8/R1, re-walked C16-B1′ and
  C15′ step 5]
- **I22. Evaluator identity is world-scoped state.** A hook-supplied
  fn/deps/reducer swap is a render-phase mutation; one shared mutable
  evaluator cannot serve concurrent passes (either the urgent or the
  deferred render observes the other's closure), leaks uncommitted
  closures into NEWEST reads and committed-world effect evaluations after
  discards, and goes stale across same-pass render restarts. Stage per
  pass; promote at the hook's own commit effect (hook grain, never pass
  grain); NEWEST/committed evaluations use the committed evaluator.
  [BOTH harden-claude F2 + harden-codex 1 + cost-codex 1 + lean-codex 4 —
  four schedules, two models, three designs; repaired construction
  synthesis §11.1′/R2, walks C1-T11, C14′]
- **I23. Mark/flag propagation on edge-add is insufficient without
  retroactive lane-scoped delivery.** A K1 edge recorded after a write
  (world evaluation discovering a divergent dep) must replay every
  still-live source receipt's delivery to watchers through the new edge
  (`runInBatch` per slot bit), or a later single-lane render commits a
  torn frame corrected only post-retirement (the S2 one-frame-late
  signature). Flags route reads; they do not schedule React. [WALK
  harden-codex 3, re-derived and repaired as synthesis C1-T10; positive
  construction = cost-hardened §7.1(3) propagate-with-queued-deliveries,
  verified held by BOTH cost-hardened reviewers]
- **I24. Suspense content-validity stamps must be retry-stable
  receipt-line facts.** Stamps derived from per-(world-instance) memo
  identity re-fetch forever (a retry's new pin mints a new worldKey ⇒ new
  memo ⇒ new stamp); stamps containing a GLOBAL retirement clock starve
  transitions under unrelated urgent traffic (one refetch per interaction).
  Valid stamps: per-atom fingerprints (incl. I21's visStamp) and evaluator
  stamps, flattened across nested evaluations. [BOTH harden-codex 4 +
  lean-claude F1 — same class from opposite sides, two models, two
  designs; repaired construction synthesis §9.2′/R6, walked C15′ steps 4–6]
- **I25. Per-root lock-in is a write-prefix, not token membership.** Once
  post-await writes attribute to a parked action token (O14), a root that
  committed the token's earlier updates must bound its committed view by a
  watermark (the committed pass's pin); full-token inclusion lets a
  continuation write leak into committed-for-root views before any commit
  carries it. [WALK lean-codex 1, re-derived; transfers to any design the
  moment continuation attribution lands; repaired construction synthesis
  §5.2′/R13, walked C11-W]
- **I26. Async-action attribution = parking (lifetime) + continuation
  carrier (identity); the two are separate duties.** Ambient
  classification of raw post-await writes violates C12's frozen Required
  ("the writes commit … not before the action settles"); documentation is
  not the preamble's thrown-rejection escape. The carrier construction
  (token captured at async-resource creation, pushed per continuation,
  finally-restored; host async-context hook; loud startup self-test on
  unsupported hosts) is the known-good form. [WALK harden-codex 5
  (violation) + lean §5.1 construction verified held by BOTH lean
  reviewers; synthesis §12′/R7, walked C12′]
- **I27. The reach induction needs its basis-edge premise restored at
  every episode boundary.** At quiescence, a watched node whose current
  basis edges exist only in K1 (world-evaluated, K0-stale) strands after
  the K1 reset: the next episode's write to its real dep reaches nothing
  and the commit tears silently. Quiescence must refresh (K0-pull at
  NEWEST) every K1-touched node with a committed watcher or effect-dep
  snapshot before clearing K1; a refresh that triggers an R8-legal
  computed write retries once then exempts the node and carries its K1
  in-edges forward (else livelock: the reset's fixed point never runs).
  [WALK synthesis T8-N (derived from champion C1-T8's no-read variant);
  refresh construction + its livelock schedule = lean §M3 + lean-claude
  F3/F6, verified held there (held item 3)]
- **I28. Fold-replayed callbacks must not read signals — throw in all
  builds.** An untracked-at-fold-world read is an invisible dependency: no
  edge, no validity entry, no notification path; a later write to it makes
  fold caches stale and committed values wrong. Replay purity is
  load-bearing for I2 and for every world-cache validity argument. [WALK
  cost-codex 3, re-derived (applies to any design with fold caches);
  positive form = lean §1.1, verified held by lean-claude (held 20);
  synthesis §13/R12]
- **I29. World folds must apply the signal's custom equality stepwise
  against the view's accumulator** (keep the old reference on equal),
  exactly as the live write path did — post-fold equality cannot pick the
  right representative for both a U-only view (new ref) and a T+U view
  (stabilized old ref). [WALK lean-codex 8, re-derived; synthesis
  §5.2′/R15, walked C3-E]

## DECISIONS.md — proposed additions

- **D12. Round-2 champion: the repaired harden design**
  (`rounds/round-02/synthesis.md`) — architecture class D8 unchanged;
  repairs R1–R15 + T8-N all cell-level within its audit-table discipline.
  Proof: the only round-2 design whose confirmed defects all carried
  in-architecture repairs endorsed by both its reviewers, while each
  competitor's new load-bearing mechanism took a kill-class schedule
  (S16–S19 below). Judge re-walk pending.
- **D13. Delivery suppression by value is dead; delivery stays value-blind
  with per-(watcher, slot) dedup (extends D10).** Any cutoff comparing a
  writer-world value against commit-recorded rendered values cannot see
  finished-but-uncommitted React work (CX-2), and any cross-write
  delivery-elision state (frontier stamps, suppression masks) strands
  needed re-deliveries (CH-1/CH-2). The only admissible fan-out fallback
  is per-slot-mark delivery DEDUP per render cycle (SPK-N1's rule), never
  an equality cutoff. Proof: [WALK cost-codex 2] + [BOTH CH-1, CH-2 ≡
  cost-codex 6].
- **D14. O15 settled: signal reads and writes inside `update(fn)`/reducer
  folds throw in all builds** (read-before-dispatch is the legal
  composition). Proof: I28's schedule; the dev-throw/prod-untracked split
  died with it.
- **D15. O14 settled: fork fact F8 = continuation carrier + parked
  retirement, with the loud host self-test** (I26). Post-await signal
  writes belong to the action; C12 walked verbatim. Consequence
  immediately priced: per-root lock-in gains watermarks (I25).
- **D16. O16/O17 settled.** Reducer identity: constructor reducers
  immutable; hook reducers stage per pass and promote at the hook's commit
  effect (I22), differential-tested at stable-reducer scope with a
  dev-warn on swap-with-pending-receipts. `ctx.previous`: exposed;
  three-way rule (donor-global at NEWEST/RENDER_NEWEST — documented,
  conformance-pinned; per-(node, worldKey) in world evals; R-guarded K0
  seed else undefined). `ctx.use` gains the lazy factory form; the eager
  form's contract states identity stability only (caller side effects not
  suppressed). Proof: [WALK cost-codex 5 + lean-codex 5/7], synthesis
  §13/§9.1′.

## OPEN.md — proposed changes

- Close: **O11** (fixup narrowed to `touchedSlots ∩ all live written
  tokens` — structural answer adopted from cost-hardened, soundness
  argument verified held by both its reviewers; residual = G-F harness
  numbers only). **O13** (constructions landed: saturation
  renumber+hard-throw, token live-skip, K1 tag wrap-clear, epoch mint from
  globalSeq — HX-8). **O14** (D15). **O15** (D14). **O16/O17** (D16).
- **O12 (kept, sharpened):** value-blind fan-out cost — SPK-N1 grid gains
  the held-batch × writes/frame row (cost-hardened W1); the fallback is
  restricted by D13 to per-slot-mark dedup.
- **O18 (new):** restart-heavy held-transition revalidation (cost-hardened
  W3): pin-in-worldKey re-evaluates the flagged region per interruption;
  pinless keys are dead as defaults (CH-3/CX-5). SPK-G8 gains the
  typeahead row; fallback = the specced pinless-frontier hybrid (shared
  epoch-keyed frontier memo + pass-local scratch). Decision rule: adopt
  the hybrid only on gate failure.
- **O19 (new):** G-Q's ≤2% vs the measured 2.4–3.8% branch floor [SPKHQ]
  — SPK-L (idle machine) decides; pre-registered monitor renegotiation to
  ≤3% or the §4 mitigation ladder. This is a requirements decision, not a
  design defect (cost-claude N-2).
- **O20 (new):** browser continuation-carrier feasibility/overhead
  (bundled promise-reaction host hook) — SP-F8; rule: if the hook cannot
  be built at <0.5% event overhead, the platform prerequisite stands
  (loud self-test failure), documented as a support-matrix line, and the
  monitor decides whether a dev-throw-on-post-await-write degraded mode
  ships instead.
- **O21 (new):** flattened-prefix length on deep suspense chains (R6) —
  measured inside SPK-G8/G-V; fallback = whole-mask clock vector
  (coarser refetch, flagged).
- Round-3 stance suggestion: one **builder** (repair whatever the judge
  confirms against this synthesis), one **cost adversary** re-running
  W1/W2/W3/W5 against the repaired mechanisms (the last one found four
  real gate breaks), and — only if the judge confirms new architectural
  holes — one challenger seeded on the lock-in/carrier stratum (LX-1's
  neighborhood: multi-root × async actions × watermarks is the least
  battle-tested new math).
- Spike queue update: SP1c stays deprioritized; SPK-H/SPK-Q DONE (remedies
  shipped as twin builds); **queued: SPK-L, SPK-N1(+W1 row), SPK-G8(+W3
  row, +prefix length), SPK-W, SPK-R (new: retirement/effect-flush
  targeting, 10k-atom × 5k-effect ≤2× the batch's own render), SP2,
  SP-F8 (new)** — decision rules in synthesis §16.

## SCARS.md — proposed additions

- **S16. Value-based delivery suppression against commit-recorded
  baselines.** Killing schedules: (a) held T renders c=1
  (finished-uncommitted), later T-segment writes a back to 0 → cutoff
  compares T-world 0 == committed lastRendered 0 → suppress → React
  commits the stale finished subtree — parity broken, one-frame-late
  reconcile [WALK cost-codex 2]; (b) suppression state strands: the
  same-slot second write prunes at the stamped written atom and never
  re-reaches the suppressed node → torn committed frame [WALK
  cost-claude CH-1]. Why not local: suppression soundness needs
  per-pending-render knowledge no engine-side record has; delivery must
  stay value-blind (D13).
- **S17. Cross-write delivery-elision state with shared per-node stamps
  (frontier pruning).** Killing schedule: k delivers through c (stamp E1);
  W re-arms k (rearmEra E2); j's walk overwrites the shared stamp (E3);
  k's next write prunes at the root because E3 ≥ E2 → no k delivery → k
  commits stale. One era per node cannot validate 32 bits; per-slot eras
  break the memory budget; clearing sweeps reintroduce the saved cost.
  [BOTH cost-claude CH-2 + cost-codex 6]
- **S18. Pinless shared world memos without enumerated ownership.**
  Killing schedules: (a) quiescence-via-touched-lists cannot reach memos
  on untouched (TS=0) nodes; maskId interns reset to colliding ints;
  optional seq reset inverts the clock window → a previous episode's world
  value validates and commits [WALK cost-claude CH-3]; (b) two live pins
  sharing one memo slot: root B's overwrite feeds root A's resumed pass
  `ctx.previous=3` → one pass reads two values of one pinned world [WALK
  cost-codex 5]. Why not local: multi-version-per-key or ownership
  machinery rebuilds what pin-in-key already buys; survives only as
  O18's measured fallback hybrid.
- **S19. Full-token per-root lock-in and pass-grain publication.** Killing
  schedules: (a) async T locked into root A at first commit; post-await
  write under T leaks into A's committed view before any commit carries it
  [WALK lean-codex 1]; (b) `rootCommit(pass)` publishes staged
  previous/nodes from error-boundary-abandoned subtrees inside the winning
  pass → speculative state observable, retries double-apply [WALK
  lean-codex 2]. Rules: lock-in carries watermarks (I25); publication is
  hook-commit-grain (I22).
- **S20. Global retirement clocks in resource identity keys.** Killing
  schedule: capsule keyed on global retireClock; every unrelated urgent
  retirement re-keys every suspense capsule → refetch + re-suspend per
  interaction → transition starvation with duplicate side-effectful
  fetches [WALK lean-claude F1]. Rule: retirement components of validity
  must be relevance-filtered (touched-atom visStamps — I21/I24).
- **S21. Ambient (context-sampled) classification for post-await action
  writes.** Killing schedule: raw `a.set(2)` after `await` lands in its
  own default batch and retires while the action parks on an unresolved
  promise → committed state moves before the action settles — C12's
  Required violated with no thrown rejection [WALK harden-codex 5]. Rule:
  I26/D15.
