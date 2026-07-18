# Proposed notes diff — round 1 (synthesis)

Evidence-class key per line: [WALK <where>] = walked schedule (link),
[MEAS <key>] = measurement, [XDESIGN] = the same defect/lesson derived
independently against two or more different designs this round (this round
ran ONE reviewer per design, so no "both reviewers of one design" class
exists; XDESIGN is offered as the analogous independence signal — monitor
may downgrade any XDESIGN line to OPEN if the class is judged too weak).

## INVARIANTS.md — proposed additions

- **I12. A mark/flag fast-path routing gate is sound only with a freshness
  conjunct: serve K0 to a non-newest world only if the node is unflagged AND
  its cached value can be served without recompute.** A lazy pull/first
  evaluation is a fresh newest-basis evaluation that can acquire a receipted
  atom through an edge no plane has recorded; reachability-derived flags
  cannot see a path the pull itself creates. Provenance: [WALK
  review-two-kernel-claude.md F1 (cross-episode stale serve)] + [WALK
  review-compensated-overlay-claude.md F1 (lazy canonical cache creation)]
  [XDESIGN — same hole found independently in both single-fast-path designs];
  repaired construction: synthesis §5.3 invariant R.
- **I13. Equality-filtered per-token correction cannot witness joint
  multi-batch divergence; late-join/mount corrections must be reach-based**
  (schedule into every live batch that could reach the node; over-render is
  the price). For any fixed comparison set an adversary picks f with
  f(base+ti)=f(base) per checked world but f(base+S)≠f(base) for a rendered
  subset S; subset enumeration is exponential. Provenance: [WALK
  review-open-claude.md F2 (x1&x2, and x1&x2&!x3 vs all-live check)] + [WALK
  review-two-kernel-claude.md F2 (a&&b joint bailout tear)] [XDESIGN].
- **I14. Retirement and per-root lock-in edges need their own notification
  path to committed-world observers.** Write-time queue entries are consumed
  by earlier unrelated flushes; retirement folds of urgent-applied batches
  are value-no-ops vs K0 and deliver nothing; commits may never happen on a
  root (store-only transitions). Provenance: [WALK
  review-compensated-overlay-claude.md F3 (C16 walked to the end)] + [WALK
  review-fork-native-claude.md F4 (store-only retire, effect never re-runs)]
  [XDESIGN]; positive construction: synthesis §10.4 three-trigger inventory.
- **I15. Every retirement stamp/pin comparison must live on one monotone
  number line with write seqs.** A private retire counter compared against
  globalSeq pins admits `retiredSeq(1) ≤ pin(100)` for a post-pin retirement
  → pinned-pass drift (C7 broken as literally specified). Provenance: [WALK
  review-two-kernel-claude.md F3]; same lesson from the opposite direction:
  dropping the `retired ≤ pin` clause entirely lets a mid-pass retirement
  drift a pinned world [WALK review-fork-native-claude.md F2]. Both reduce
  to: the seed visibility rule's two pins are load-bearing, verbatim.

## DECISIONS.md — proposed additions

- **D8. Round-1 architecture: two-kernel class** — K0 closed canonical donor
  kernel + K1 real world edges (add-only to quiescence) + always-log tape
  with the seed visibility math + per-slot-clock memo validity + per-write
  full-reach walk with per-(watcher,slot) dedup — as repaired in
  rounds/round-01/synthesis.md (invariant R routing; reach-based mount
  fixup; shared seq line; intern-zeroed clocks). Proof: the only round-1
  design whose review confirmed zero defects in its load-bearing mechanisms
  (review-two-kernel-claude.md "verified held" list); all four findings
  seam-local with reviewer-prevalidated repairs; competitors' central bets
  each took a confirmed kill-class hit (S9/S11–S13). Subject to the judge's
  independent re-walk.
- **D9. World-value validity = per-slot write clocks + epoch bumps (+
  optional dep-version recheck ladder for recompute avoidance); no per-read
  certificates.** Clocks are S5-immune with no completeness obligation and
  leave the `untracked()` contract intact by construction; certificate
  stacks acquired two new obligations this round (a fourth MARK maintenance
  site; untracked-entry over-notification). Proof: [WALK
  review-two-kernel-claude.md "§7.2 clock validity is genuinely S5-immune"
  (attacked, held)] vs [WALK review-compensated-overlay-claude.md F1, F4].
  Settles O9.
- **D10. Watcher delivery is per-write and synchronous in the writer's
  stack; engine `batch()` defers core-effect flushing only; no implicit
  grouping exists anywhere.** All four round-1 designs independently
  converged on this resolution of C6 ("handle it") and each walked it; the
  known cost (no grouped coalescing) is priced under the fan-out gates.
  Proof: C6 walks in all four designs + review confirmations (none
  attacked successfully). Settles O6.
- **D11. The suspense/world cache key is the fork-minted render-lineage id
  (per root × batch-set, stable across restarts/replays, dead at
  commit/abandon) — never a live-token set, mask∪locked, or passSerial.**
  Mask-composed keys drift on unrelated commits [WALK
  review-compensated-overlay-claude.md F5]; live-set worldIds churn on
  spanning urgent traffic [WALK review-fork-native-claude.md F8];
  passSerial re-fetches forever (seed). Settles O8.

## OPEN.md — proposed edits

- **O1** — NARROWED to answered-pending-judge: per-world dependency
  knowledge lives in K1 as real recorded edges (D8). The compensated single
  kernel remains the named fallback if K1 costs disqualify (walk structure
  and delivery dedup survive that swap); revisit only on SPK-* gate failure.
- **O2** — CLOSE: I11 measured the boundary free / storage 5–12%; the
  winning design keeps values in-plane and uses two per-recompute hooks
  (SPK-H gates the residue). SP1c deprioritize: no current design depends
  on it.
- **O3** — UNBLOCKED: architecture picked; run SP2 (E-PRESERVE dev
  validator; >10% dev overhead → sampled validation).
- **O4** — CLOSE with scar S11 + the §12 maximalist kill (fork-native
  round): React-owned queues fail on fiber-grain cutoff loss, no-fiber
  consumers (R13), creation cost, and global-queue retirement pins.
- **O5** — CLOSE: both shapes used together — F2 edge events maintain
  engine state; `getCurrentPassId()` is one flag read; reads/writes pay one
  engine-local load (D8's design; no successful attack).
- **O6** — CLOSE per D10. **O8** — CLOSE per D11. **O9** — CLOSE per D9.
- **O7** — NARROW: per-root lock-in table lives in the bindings' root
  registry, consumed by pass-world derivation, effect flush, and fixup
  worlds; REMAINING RISK: the fork-side per-root facts have no
  current-generation existence proof (synthesis gap G4) — fork tests 2/3/4
  are on the critical path.
- **O10** — CLOSE: coalescing declined by all four designs (legality
  preconditions exceed the win; compaction at retirement covers growth).
- **NEW O11.** Mount-fixup over-render under many live transitions:
  reach-based correctives cost ≤ live-deferred-count renders per flagged
  mount (G-F). Is the constant acceptable at 10k-mount scale, or does the
  fixup need a cheaper reach test (per-slot touched-cone bloom)? Measure in
  the react-concurrent-store harness before optimizing.
- **NEW O12.** Value-blind delivery fan-out (FN-F9 class, adopted-by-choice
  in D8's walk): SPK-N1 grid decides whether `notifyCutoff:'evaluate'`
  ships default-on above a fan-out threshold. This is the round's single
  NEEDS-MEASUREMENT adjudication.

### Spike queue (replace table rows)

| id | question | method | decision rule | status |
| --- | --- | --- | --- | --- |
| SP1/SP1b | host tax | — | — | DONE (I11) |
| SP1c | closed protocol + packed columns ≈ donor? | as specified | ≤2% ⇒ unblocks closed-kernel refactors | queued, DEPRIORITIZED (no design depends on it) |
| SP2 | O3 validator cost | brute-force K1-edge cross-check, synthetic forked topologies | >10% dev overhead → sampled validation | UNBLOCKED (architecture picked) |
| SPK-H | K0 two-hook recompute tax | donor vs hooked; tier-0 + kairo; one-framework/process; bundled child | >1% → hooks compiled out of DIRECT; re-measure LOGGED | new |
| SPK-W | logged-write price | set-heavy isolated writes | >2× DIRECT → inline-2 receipts / tape pooling | new |
| SPK-N1 | O12 fan-out grid (incl. suppressed-write × watchers 10/100/10k) | adversarial cone 1k, 100 writes/frame | >2× DIRECT propagate class or >1 spurious render/(watcher,batch) → per-slot-marks fallback or default-on evaluate-cutoff | new (the FN-F9 adjudication) |
| SPK-G8 | held-open read bursts (+ R1 first-touch routing) | kairo-scale held transition, mixed read/write | fail → per-(atom, worldKey) fold cache | new |
| SPK-Q | quiet-React read tax | donor + NEWEST branch, tier-0 | >2% → branch behind LOGGED closure rebuild only | new |

Next-round stance suggestions (if the judge sustains D8): (a) a
cost-attack round — same architecture, authors assigned to break G-N/G-E/
G-F with adversarial workloads and to design the §15-R1 fallback in full;
(b) a fork-depth round — implement-spec the 7 facts against the actual
reconciler and re-price goal-1/2 numbers (G4 retirement); (c) keep one
contrarian stance (compensated-overlay repaired per its review) alive only
if the judge scores the synthesis below round-exit quality.

## SCARS.md — proposed additions

- **S9. Reachability-derived fast-path routing without a freshness check
  ("unflagged/unmarked ⇒ serve canonical to any world").** Killing schedule:
  quiesce with K0-stale nodes (flags cleared, kernel staleness persists);
  new transition writes an atom with no out-edges yet; an urgent
  pass reads the stale node → the pull *freshly evaluates* against newest,
  acquires the pending write through a branch no walk ever saw → torn
  urgent frame (committed sibling reads folded base). Twin schedule: a
  yield-gap NEWEST read lazily creates a never-evaluated node's canonical
  cache+edges with no mark, then the pinned pass serves it. Why not local
  as originally claimed: the flag/mark invariant itself survives — it is
  the *consequence* drawn from it that is false; the repair is a routing
  rule (freshness conjunct, I12), not more marking. (TK-F1 + CO-F1.)
- **S10. Equality-filtered per-token late-join correction.** Killing
  schedule: `c = x1 && x2`; t1 writes x1, t2 writes x2, both pre-mount;
  mount-time per-token projections all equal committed → no corrective;
  React renders {t1,t2} jointly, bails out on the new component → torn
  committed frame no reconciler path repairs. Why not local: subset
  divergence defeats any fixed comparison set (`x1&x2&!x3` beats adding the
  all-live check); enumeration is exponential → corrections must be
  reach-based (I13). (OP-F2 + TK-F2.)
- **S11. Commit-gate safety nets keyed to deferred-token liveness and
  single-root commit edges** (fork-native's viable core). Killing
  schedules, one per divergence dimension the taxonomy missed: (1) edge
  re-track under a live default mask + yield-gap sync write + flushSync
  exclusion → gate fast-out passes, torn commit; (2) fold without a
  retirement pin + mid-pass retirement on another root → one pass renders
  two worlds, gate blind; (3) spanning batch: skew tag tested against the
  lagging root's mask (equals fully-retired → no tag) and cleared at the
  first root's commit while the hazard lives to global retire → torn
  commit on the lagging root. Why not local: the gate's value was "the
  trigger list is small"; the fixes make the trigger list the whole
  problem. A commit-time watcher-agreement check survives only as test
  apparatus (fork test 12). (FN-F1/F2/F3.)
- **S12. Global/shared update queues folded without a retirement
  watermark.** Killing schedule: token retires mid-yield (no-work close or
  other-root commit); the resumed pass's first read of a not-yet-memoized
  node satisfies `fullyRetired` at read time → siblings disagree about one
  atom inside one committed tree. Rule: React's per-fiber queues never
  needed the pin; any many-consumer store does — the seed visibility
  rule's `retired ≤ pin` clause is load-bearing (I15). (FN-F2.)
- **S13. Per-(world, batch) equality-retained frontier retention.** Killing
  schedule: n live transitions round-robin-writing deps of one watched
  computed retain the powerset — 2^n live graphs, each subsequent write
  paying before/after/baseAfter pulls per graph; at the architecture's own
  31-batch bound the worst case is 2^31 while its spike gates "1,2,8,31
  graphs." Why not local: the design's multi-batch induction *requires*
  the family; capping it is a retention-rule redesign with a new proof.
  (OP-F3.)
- **S14. Canonical-value delivery cutoffs gating world-cache invalidation
  notifications.** Killing schedule: deferred T `update(+1)` rendered and
  finished-uncommitted; urgent `set(3)` equal to canonical → k0Changed
  false → bucket-hit delivery AND the runInBatch corrective both skipped;
  T's world silently moved 4→3; T commits its stale rendered tree. Rule:
  cutoff decisions are per-world; a canonical-only gate must never guard
  cross-world notification. (CO-F2.)

*end of proposed diff*
