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
