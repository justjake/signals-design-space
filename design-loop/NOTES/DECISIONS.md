# DECISIONS — settled choices with their proof cases

Reopening requires new evidence (a schedule or a measurement), not
preference. Curated by the monitor only.

- **D1. Always-log while React bindings are active; DIRECT mode otherwise.**
  Proof: I1/C2. Activation is monotonic on bridge registration — never
  keyed to watcher count (proof: the first-transition leak schedule, SCARS
  S6). DIRECT (non-React) mode executes zero concurrency instructions
  (requirements P3).
- **D2. Committed-false batches fold; writes are never dropped on
  retirement.** Proof: C12; whether a write persists must not depend on who
  is subscribed. (Killed candidate C's drop-on-abort; SCARS S4.)
- **D3. The visibility/rebase SEMANTICS are React's** — what a render for a
  given batch set may observe, and replay-in-write-order rebasing (I2), are
  fixed by parity (proof: C2/C3 walks; they map clause-for-clause onto
  React's hook-queue lane filtering). Any mechanism is acceptable if it
  provably produces these answers; no particular log/tape/queue
  representation is mandated.
- **D4. The canonical kernel stays closed and monomorphic**, with
  CI-enforced bytecode budgets; no per-link world state in the primary hot
  walks. Proof: measured facts (research-facts.md: link-split, inline
  budgets, pollution); candidate B's judged kernel invasion. World state in
  a SEPARATE structure (second kernel, overlay plane) is not excluded.
- **D5. Watcher notification = setState synchronously in the writer's
  context** (lane inheritance from React); grouped delivery must preserve
  per-write batch context (C6) — via per-write delivery or fork
  lane-scoped scheduling.
- **D6. Process apparatus is inherited, not redesigned**: oracle built
  before the machinery it checks; frozen-kernel contract suite; numeric
  gates re-run per milestone; pre-registered experiments; schema/codegen
  with regenerate-and-diff. Proof: survived both adversarial reviews of the
  synthesis untouched.
- **D7. The fork is co-designed, not minimal-by-decree.** Scored axes in
  `fork-charter.md`. Proof: the 2026-07-04 re-judgment showed all four
  legacy candidates were anchored on a fixed observation-only fork, and two
  known blockers (yield edges, lane-scoped grouped delivery) are pure fork
  facts.

## Round 1 (2026-07-04)

- **D8. Architecture: the two-kernel class** — closed canonical donor
  kernel K0 + K1 carrying REAL per-world edges (add-only to quiescence) +
  always-log tape with the seed visibility math + per-slot-clock memo
  validity + per-write full-reach walk with per-(watcher, slot) dedup — as
  repaired in `rounds/round-01/synthesis.md` (the reigning champion
  artifact). Proof: only round-1 design with zero confirmed defects in its
  load-bearing mechanisms; competitors' central bets each took a kill-class
  hit (S10–S13); judge re-walked the battery at full depth and sustained.
  STANDING CAVEAT: 8 confirmed local blockers remain against the champion
  (judge B1 + codex addendum: the I16 validity-source family, I17 reach
  propagation, I18 mount fallback, I19 mask lifecycle, I20 thenable
  content-validity, async-action attribution) — round 2's docket; the
  lifecycle/validity stratum needs round-1-routing-grade rigor.
- **D9. World-value validity = per-slot write clocks + epoch bumps (+
  optional dep-version recheck for recompute avoidance); NO per-read
  certificates.** Clocks are S5-immune with no completeness obligation and
  leave `untracked()` intact by construction; certificate stacks acquired
  two new obligations in-round. Proof: [WALK review-two-kernel-claude
  "clock validity attacked, held"] vs [WALK review-compensated-overlay
  F1/F4]. Settles O9. (I16 extends the clock predicate with the closed
  change-source set — clocks alone are necessary, not sufficient.)
- **D10. Watcher delivery is per-write and synchronous in the writer's
  stack; engine `batch()` defers core-effect flushing only; NO implicit
  grouping exists anywhere.** All four designs independently converged on
  this C6 resolution and each walked it; the cost (no grouped coalescing)
  is priced under the fan-out gates. Settles O6.
- **D11. The suspense/world cache key is a fork-minted render-lineage id**
  (per root × batch-set, stable across restarts/replays, dead at
  commit/abandon) — never a live-token set, mask∪locked, or passSerial.
  Mask keys drift on unrelated commits; live-set ids churn on spanning
  urgent traffic; passSerial re-fetches forever. Settles O8. (I20 adds the
  content-validity conjunct on top of the identity key.)

## Round 2 (2026-07-04)

- **D12. Round-2 champion: the repaired harden design**
  (`rounds/round-02/synthesis.md`) — architecture class D8 unchanged;
  repairs R1–R15 + T8-N within the audit-table discipline. Proof: the only
  round-2 design whose confirmed defects all carried in-architecture
  repairs endorsed by both its reviewers, while each competitor's new
  load-bearing mechanism took a kill-class schedule (S16–S19); **judge
  sustained with ZERO confirmed blockers on a full-battery re-walk**
  (scores 9/7/8/8/7). Standing caveat: SP-F8 (continuation-carrier browser
  feasibility, O20) is the one open architecture-relevant spike.
- **D13. Delivery suppression by value is dead; delivery stays value-blind
  with per-(watcher, slot) dedup (extends D10).** Value cutoffs cannot see
  finished-but-uncommitted React work; cross-write elision state strands
  re-deliveries. The only admissible fan-out fallback is per-slot-mark
  delivery dedup per render cycle — never an equality cutoff. Proof:
  [WALK cost-codex 2] + [BOTH CH-1/CH-2 ≡ cost-codex 6].
- **D14. O15 settled: signal reads/writes inside `update(fn)`/reducer
  folds throw in ALL builds** (read-before-dispatch is the legal
  composition). Proof: I28; the dev-throw/prod-untracked split died.
- **D15. O14 settled: fork fact F8 = continuation carrier + parked
  retirement, with the loud host self-test** (I26). Post-await signal
  writes belong to the action; C12 walks verbatim. Priced consequence:
  per-root lock-in gains watermarks (I25). Feasibility spike SP-F8 gates
  exit.
- **D16. O16/O17 settled.** Reducer identity: constructor reducers
  immutable; hook reducers stage per pass, promote at the hook's commit
  effect (I22); differential-tested at stable-reducer scope, dev-warn on
  swap-with-pending-receipts. `ctx.previous`: exposed, three-way rule
  (donor-global at NEWEST — conformance-pinned; per-(node, worldKey) in
  world evals; R-guarded K0 seed else undefined). `ctx.use` gains a lazy
  factory form; eager form guarantees identity stability only. Proof:
  [WALK cost-codex 5 + lean-codex 5/7], synthesis §13/§9.1′.

## Round 3 (2026-07-04)


- **D12 amendment (champion pointer).** Round-3 champion:
  `rounds/round-03/synthesis.md` — architecture class D8 unchanged;
  repairs R1–R17; breaker transplants adopted WITH invariants: F9
  hook-publication (I41), immutable per-root lock views (I34), full-cone
  refresh carry (I42), corrected split G-R comparator (breaker B4),
  ActionScope + realm affinity, breaker W1/W2/W3/W5 spike workloads.
  Proof: adjudication table Part I — every confirmed finding carries an
  in-architecture repair endorsed-shaped by its own reviewer's judgment;
  no confirmed finding invalidates K0/K1/tape/visibility/seam.
- **D16 amendment (reducer identity).** "Dev-warn on swap with pending
  receipts" is insufficient alone; the settled semantics are I38's:
  promotion-visible folds (re-fold NEWEST at promotion; publication before
  same-commit folds), always-append for stageable reducer atoms, and the
  differential battery extended to swap-with-pending rows. Proof:
  [WALK breaker-codex 1/2], synthesis C3-R.
- **D17 (new). F8's boundary contract is settled and closed against
  re-litigation absent new evidence:** at carrier rung 2, raw post-await
  signal writes in uncompiled code misattribute to their ambient batch —
  sound, bounded, dev-warned, boot-tested per I30/O20/D15; this is a
  declared build-prerequisite support boundary, not a preamble
  runtime-restriction move, so "no reliable rejection ⇒ blocker" does not
  apply. The supported escape hatch for opaque boundaries is explicit
  ActionScope.set/dispatch; scheduler shims (I36) shrink the in-app
  class; rung 1 erases it. Proof: [REFUTED-WALK exit-codex 2 ≡
  breaker-codex 5 — both re-raised I30's own recorded schedule with no
  new evidence; synthesis Part I #10].
- **D18 (new). useSignalEffect evaluator identity rides React's native
  deps re-fire; no staging/F9 path for effects.** A deps change re-runs
  the effect at its own commit, which re-tracks and re-subscribes;
  routing effect fn changes through staged publication leaves the new
  dependency edge-less forever. Proof: [WALK breaker-codex 3], synthesis
  C16-D.

