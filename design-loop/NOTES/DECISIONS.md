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
- **D3. The visibility rule is React's:** entry visible iff (retired ≤ pin)
  ∨ (batch ∈ include-mask ∧ seq ≤ pin); replay in seq order. Proof: C3
  parity walk; clause-for-clause map onto React hook-queue lane filtering.
  Reuse verbatim; do not invent alternative fold semantics.
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
- **D8. Loop meta-rule: "by construction" claims require the construction**
  (invariant/induction written out); reviewers attack constructions; judges
  re-walk. Proof: the prior judgment accepted an unaccompanied immunity
  claim that was false (JUDGING.md G7 vs review 08-52 F2).
