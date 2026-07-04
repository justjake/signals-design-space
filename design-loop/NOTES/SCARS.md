# SCARS — dead approaches, each recorded as the schedule that killed it

Format: the approach, the killing schedule, why the fix isn't local. Bare
prohibitions anchor; schedules teach. Curated by the monitor only.

- **S1. No-log urgent writes ("urgent goes straight to committed").**
  Killing schedule: C3 — deferred `+1` pending, urgent `×2` applied and
  discarded; fold replays `+1` over the new base → 3; React commits 4. Also
  unrepresentable: C2 (flushSync excluding an applied default batch). Why
  not local: retaining urgent ops IS always-logging; the "no side log"
  identity dies with it. (Candidate B's kill; extraction 2026-07-04.)
- **S2. Read-only canonical topology for all worlds + "marking through
  canonical topology never misses".** Killing schedule: C1 — k writes
  `flag` then `a`; the k-world cache of `c` (`SV_READY`-style) is served
  forever; no walk from `a` reaches `c`; watcher never notified in k's
  lane; torn commit corrected one frame late. Why not local: the design's
  own analysis concedes the repair is per-world dependency tracking, which
  its read-cheapness premise forbids. (Candidate C's kill; verified against
  C §10.4's induction — it covers only mark-then-read-once.)
- **S3. Canonical-only notify walks bolted onto an overlay ("the walk
  reaches everyone who matters").** Killing schedule: C1 again, in the
  synthesized winner: overlay evaluations are untracked, so the divergent
  dep has no edge; the always-walk of §9.8 walks the wrong graph. Why not
  local-as-claimed: the repair needs registries + full certificates + drain
  re-validation (a 4-mechanism compensation stack), or a structural
  mechanism (world edges / second kernel). (Review 2026-07-04T08-52 F2/F3.)
- **S4. Drop-on-abort retirement (committed=false discards writes).**
  Killing schedule: C12 — `startTransition(() => a.set(5))` with no
  subscriber → no React work → committed=false → write silently reverts.
  Local one-branch fix exists (fold instead), so the scar is the *policy*,
  not the machinery: persistence must never depend on subscription.
- **S5. Certificates that record only "atoms with concurrency state at
  evaluation time".** Killing schedule: C1's memo half — `a` is unlogged
  when world-k first reads it, acquires a tape on the later write, and no
  recorded source moves → stale cache validates; the spec's own T1
  justification contradicted its own definition. Rule: validity records
  must cover the COMPLETE read set (sentinel for no-state-yet), and nested
  evaluations must flatten/merge child certificates. (Review F3 + codex
  finding 2, mutually confirmed.)
- **S6. Concurrency machinery keyed to watcher count.** Killing schedule:
  `startTransition(() => { atom.set(1); setShow(true) })` mounting the
  FIRST watcher — the write predates LOGGED mode, no receipt exists, urgent
  renders leak the transition value. Rule: activation is monotonic on
  bridge registration. (Codex finding 3, independently verified.)
- **S7. Wall-clock-scoped render context ([passStart, passEnd] scalar).**
  Killing schedule: C7 — urgent write in a handler during a yielded
  transition render throws "write during render" / reads resolve against
  the pin. Rule: render-context truth is per-callstack; the fork must
  expose yield/resume. (Review F1; applies to every legacy candidate.)
- **S8. Equality-gating writes against the newest world.** Killing
  schedule: C8 — deferred T `set 1`, urgent U `set 1` dropped as equal;
  U's render excludes T and shows 0; truncation variants lose the write
  entirely. Rule: I7 (drop only on empty history; equality lives in
  fold/notify). (Codex finding 4 + review F5.)

## Round 1 (2026-07-04): rounds/round-01/

- **S9. Reachability-derived fast-path routing without a freshness check**
  ("unflagged ⇒ serve canonical to any world"). Killing schedule: quiesce
  with kernel-stale nodes (flags cleared, staleness persists); new
  transition writes an atom with no out-edges yet; an urgent pass reads the
  stale node → the pull freshly evaluates against newest, acquires the
  pending write through a branch no walk ever saw → torn urgent frame.
  Twin: a yield-gap NEWEST read lazily creates a never-evaluated node's
  cache+edges with no mark; the pinned pass serves it. Repair is a routing
  rule (freshness conjunct, I12), not more marking. (TK-F1 + CO-F1.)
- **S10. Equality-filtered per-token late-join correction.** Killing
  schedule: `c = x1 && x2`; t1 writes x1, t2 writes x2, both pre-mount;
  per-token projections all equal committed → no corrective; React renders
  {t1,t2} jointly, bails out on the new component → torn committed frame no
  reconciler path repairs. Subset divergence defeats any fixed comparison
  set; corrections must be reach-based (I13). (OP-F2 + TK-F2.)
- **S11. Commit-gate safety nets keyed to deferred-token liveness and
  single-root commit edges** (fork-native's viable core). Killing
  schedules per missed divergence dimension: (1) edge re-track under a
  live default mask + yield-gap sync write + flushSync exclusion → gate
  fast-out passes, torn commit; (2) fold without a retirement pin +
  mid-pass retirement on another root → one pass renders two worlds; (3)
  spanning batch: skew tag tested against the lagging root's mask and
  cleared at the first root's commit while the hazard lives → torn commit
  on the lagging root. The gate's value was "the trigger list is small";
  the fixes make the trigger list the whole problem. (FN-F1/F2/F3.)
- **S12. Global/shared update queues folded without a retirement
  watermark.** Killing schedule: token retires mid-yield; the resumed
  pass's first read of a not-yet-memoized node satisfies fullyRetired at
  read time → siblings disagree about one atom inside one committed tree.
  React's per-fiber queues never needed the pin; any many-consumer store
  does (I15). (FN-F2.)
- **S13. Per-(world, batch) equality-retained frontier retention.** Killing
  schedule: n live transitions round-robin-writing deps of one watched
  computed retain the powerset — 2^n live graphs, each write paying pulls
  per graph; at the 31-batch bound the worst case is 2^31 while the spike
  gates tested "1, 2, 8, 31 graphs." The multi-batch induction requires the
  family; capping it is a retention-rule redesign with a new proof. (OP-F3.)
- **S14. Canonical-value delivery cutoffs gating world-cache invalidation
  notifications.** Killing schedule: deferred T `update(+1)` rendered and
  finished-uncommitted; urgent `set(3)` equal to canonical → k0Changed
  false → delivery AND the runInBatch corrective both skipped; T's world
  silently moved 4→3; T commits its stale rendered tree. Cutoff decisions
  are per-world; a canonical-only gate must never guard cross-world
  notification. (CO-F2.)
- **S15. "Discarded nodes are GC fodder" over arena-resident records.** A
  collected JS wrapper cannot reclaim a bump-allocated integer record, and
  abandoned fresh-node mounts (StrictMode, interrupted transitions) are
  ordinary, so the leak is unbounded. Killing schedule: repeat
  mount-evaluate-abandon; K0 grows monotonically; K1 reset and lineage
  drops reclaim nothing. Any "harmless discard" claim over arena state must
  name the reclamation or staging protocol. (Codex TKC-9.)

## Round 2 (2026-07-04): rounds/round-02/

- **S16. Value-based delivery suppression against commit-recorded
  baselines.** Killing schedules: (a) held T renders c=1
  (finished-uncommitted); a later T-segment write returns c to 0 → cutoff
  compares T-world 0 == committed lastRendered 0 → suppress → React
  commits the stale finished subtree [WALK cost-codex 2]; (b) suppression
  state strands: a same-slot second write prunes at the stamped atom and
  never re-reaches the suppressed node [WALK cost-claude CH-1].
  Suppression soundness needs per-pending-render knowledge no engine
  record has; delivery stays value-blind (D13).
- **S17. Cross-write delivery-elision state with shared per-node stamps
  (frontier pruning).** Killing schedule: k delivers through c (stamp E1);
  W re-arms k (E2); j's walk overwrites the shared stamp (E3); k's next
  write prunes at the root since E3 ≥ E2 → no delivery → k commits stale.
  One era per node cannot validate 32 bits; per-slot eras break memory;
  clearing sweeps reintroduce the cost. [BOTH CH-2 + cost-codex 6]
- **S18. Pinless shared world memos without enumerated ownership.**
  Killing schedules: (a) quiescence-via-touched-lists misses memos on
  untouched nodes; interned mask ids recycle to collisions; seq reset
  inverts the clock window → a previous episode's world value validates
  and commits [WALK cost-claude CH-3]; (b) two live pins share one memo
  slot: root B's overwrite feeds root A's resumed pass a foreign
  `ctx.previous` [WALK cost-codex 5]. Survives only as O18's measured
  fallback hybrid.
- **S19. Full-token per-root lock-in and pass-grain publication.** Killing
  schedules: (a) async T locked into root A at first commit; a post-await
  write under T leaks into A's committed view before any commit carries it
  [WALK lean-codex 1]; (b) pass-grain publication ships staged state from
  error-boundary-abandoned subtrees inside the winning pass [WALK
  lean-codex 2]. Rules: watermarked lock-in (I25); hook-commit-grain
  publication (I22).
- **S20. Global retirement clocks in resource identity keys.** Killing
  schedule: capsule keyed on a global retireClock; every unrelated urgent
  retirement re-keys every suspense capsule → refetch + re-suspend per
  interaction → transition starvation with duplicate side-effectful
  fetches [WALK lean-claude F1]. Retirement components of validity must be
  relevance-filtered (touched-atom visStamps — I21/I24).
- **S21. Ambient (context-sampled) classification for post-await action
  writes.** Killing schedule: raw `a.set(2)` after `await` lands in its
  own default batch and retires while the action parks → committed state
  moves before the action settles — C12 violated with no thrown rejection
  [WALK harden-codex 5]. Rule: I26/D15.
