# EXIT CASE — design loop conclusion (2026-07-04)

Prepared by the monitor at the 5-round budget cap, per LOOP.md. The loop's
exit criteria were **not fully met** (no two consecutive dry rounds; two
architecture-relevant empirical items open), so this presents **best-so-far
with open items priced**, and asks for Jake's decisions.

## Recommendation, in one paragraph

Adopt the round-5 champion (`rounds/round-05/synthesis.md`, over the
round-4 and round-3 bases — see O26) as the **design-complete baseline**,
apply the **scope cuts** below (removing the parity-exceeding machinery the
loop gold-plated), cross-check the result against the independently-written
lean rebuild (`monitor-design/DESIGN.md` + its two reviews) and treat the
**intersection** as the implementation spec, then **move to implementation
starting with the randomized oracle and the fork test suite** — the
remaining defect class (repairs minting seam bugs) is precisely what
executable verification catches and paper review has stopped catching
efficiently.

## What the loop produced

| round | shape | judge: new blockers vs champion | scores (corr/mech/seam/perf/expl) | champion mechanisms |
|---|---|---|---|---|
| 1 | 4 fresh designs (3 fable + 1 codex) | 8 (incl. codex addendum) | 7/8/8/8/9 | 10 |
| 2 | harden + cost-attack + codex challenger | **0** | 9/7/8/8/7 | 10 |
| 3 | exit-candidate + codex breaker | 2 (minted by merged armor) | 6/5/8/8/7 | 10 |
| 4 | consolidation ×2 (no new mechanisms) | 2 (minted by own repairs) | 5/6/8/7/7 | 9 |
| 5 | surgical ×2 (budget cap) | **0** | 8/6/8/7/5 | 9 |

Plus: **5 conformance-gated benchmark spikes** (host-boundary free /
storage 5–12%; hook + read-branch taxes → twin builds; async carrier
feasible-but-see-cuts), a genome of **57 invariants, 23 decisions, 43
scars** — every one carrying a walked failure schedule or a measurement —
and the two adversarial reviews + re-judgment that seeded it all.

The judge's final verdict: "evaluator versions now ride the receipt
visibility rule verbatim … my independent re-walk breaks nothing — but the
round is not dry … best-so-far, not exit."

## Exit-criteria assessment (honest)

1. **Battery pass:** YES — the judge re-walked all 17 cases against the
   round-5 champion and confirmed zero blockers (also true at round 2).
2. **Two consecutive dry rounds:** NO — rounds 3–5 each confirmed findings
   against drafts; rounds 3–4 minted seam bugs from their own repairs. The
   oscillation diagnosis: wide paper edits create seams faster than paper
   review retires them. This is an argument for implementation-phase
   verification, not for round 6.
3. **No open architecture-relevant items:** NO — O19 (the quiet-React read
   tax measured 2.4–3.8% against a frozen ≤2% requirement; SPK-L on an
   idle machine decides, monitor pre-authorized to renegotiate to ≤3% or
   adopt the mitigation ladder) and the SPK-N1/G8 gate family (fan-out and
   held-transition costs — designed fallbacks exist, unmeasured).

## Scope cuts proposed for ratification (each = machinery deleted)

The loop's incentives rewarded "handle it" over "declare it out of scope";
these cuts remove guarantees **React itself does not provide**. Reviewer
evidence: the lean rebuild adopted all of them and both its reviewers
attacked them — the cuts themselves held; its failures were elsewhere.

| cut | deletes | user-visible loss |
|---|---|---|
| **C1. Async carrier → React parity** (post-await writes ambient; explicit re-wrap / ActionScope, dev-warn heuristic) | bundler twin-build transform, scheduler shims, boot self-test, AsyncContext ladder, **the build prerequisite**; simplifies watermarked lock-in toward token membership | none vs React — its own docs prescribe the inner `startTransition` |
| **C2. Multi-root → declared degraded scope** (per-root self-consistency kept; spanning-batch atomicity dropped) | lock views, watermark machinery, per-root committed-view complexity (keep the simple per-root table) | cross-root frame simultaneity — which React itself does not have |
| **C3. `useComputed` evaluator swaps → deps-keyed node recreation** (useMemo semantics) | the evaluator staging/promotion/lineage-stamp apparatus (rounds 3–5's biggest bug factory) | closures re-create the node on deps change — the round-1 requirement's original reading | **RATIFIED (Jake, 2026-07-05)** |
| **C4. `ctx.previous` = committed-value HINT** (always the last committed value, read live; documented as an optimization hint with no identity/recency guarantee — the fn must be correct even if previous were stale or undefined) | the entire per-world previous apparatus AND the undefined-in-speculative world check | determinism of previous during speculative evals — deliberately waived by contract | **RATIFIED as amended (Jake, 2026-07-05)** |
| **C5. Slot saturation → RESTRUCTURED AWAY** (retired batches release their identity slot immediately unless a still-open render explicitly included them; a one-compare guard stops old receipts impersonating a recycled slot) | spillover machinery, the loud-degrade fallback, AND the saturation scenario itself — slot demand becomes ≤ React's own live-batch bound | nothing (verified: SOUND-WITH-AMENDMENTS; epoch guard dropped as unnecessary; two further deletions — the world-path-flag machinery and the per-slot unswept-count gate) | **RATIFIED + VERIFIED (2026-07-05)** |
| **C6. Suspense refetch-avoidance (value-revalidation) → v1.1** | stamp-vector/prefix machinery beyond the correctness core | duplicate fetches under stamp churn until v1.1 (correctness unaffected) |

KEEP unchanged: always-log (C2-flushSync is real user-reachable React
behavior and load-bearing), the mid-transition-suspense case (R6 — the
react-concurrent-store known bug), committed=false folding (data loss
otherwise), counter/epoch hygiene (cheap).

## The convergence cross-check

`monitor-design/DESIGN.md` — written in one shot from the genome alone,
with the cuts applied — was reviewed by both models: codex 8 blockers
("architecturally unsound" — its label has fired on every artifact
including two the judge sustained; the schedules are the signal), claude
4 blockers ("repairable — the mechanisms it specifies survive attack at
roughly round-2-champion grade; it over-claims by omission"). Both agree:
the lean core is sound; it omitted two delivery paths the genome already
proved load-bearing. The repaired rebuild and the champion-minus-cuts
converge on **the same ~10-mechanism design from opposite directions** —
the strongest right-sizing evidence this process produced. Implementation
spec = their intersection; divergences = flagged decisions. (Jake's own
one-off artifacts — `design-loop/oneoff-codex/`, `oneoff-plain/` — can
join this comparison on request.)

## Implementation phase (the designed next verifier)

1. **O26 first:** mechanically merge the three-file champion (round-3 base
   + round-4/5 diffs) into ONE document, applying ratified cuts —
   explainability scored 5 because the story is scattered; nobody should
   implement from a diff chain.
2. **Oracle before machinery** (the loop's own testing plan): the naive
   replay model + randomized schedules, then the kernel port, then the
   overlay — every genome scar becomes a pinned regression case.
3. **Fork tests on the critical path** (O7/O23): the per-root facts and
   the hook-publication edge have no current-generation React existence
   proof — build those reconciler tests before the bindings that consume
   them.
4. **Eight queued spikes become milestone gates** (SPK-L idle-machine
   first — it settles O19; then N1/G8/W/R, SP2, SPK-K1, SP1c-if-needed),
   each with its pre-registered decision rule and fallback already specced.

## Process lessons (for the next loop)

- **Add a scope adversary** — an agent scored on requirements deleted.
  Four agents made the design stronger; none made it smaller; the
  mechanisms score fell to 5 before a hard "no new mechanisms" rule
  recovered it.
- **Add regrow rounds** — notes-only authors, scored on invariants made
  vacuous by construction, with lean-rewrite-wins-ties. The freshest
  artifacts (7/9/6 mechanisms) were consistently the leanest; the
  champion-exception (monitor's round-2 amendment) traded that away for
  cheaper rounds. Both effects were real.
- **Refactor the genome periodically** — 57 point-invariants invite
  conjunct-per-invariant designs; consolidated principles (I16, I34)
  invite structure.
- **Calibrate codex's verdict label, keep its schedules** — it found the
  round-1 lifecycle stratum everyone else missed and authored the leanest
  designs; its "architecturally-unsound" stamp fired near-universally.
- Infrastructure: workflow subagents are not re-invoked on background
  completion (round-1 codex-runner loss; fixed with detach+wait-in-turn).

## Cost

≈7.1M measured subagent output tokens (5 rounds ≈ 5.6M, spikes + side
agents ≈ 0.6M, monitor one-off + reviews ≈ 0.9M) plus monitor session and
codex usage. At API list pricing: roughly $500–1,000 all-in; materially
less if this session and codex run on subscriptions.

## Decisions requested from Jake

1. Accept the round-5 champion as the design-complete baseline? (default: yes)
2. Ratify scope cuts C1–C6 individually? (monitor recommends all six)
3. O19: relax the quiet-React read gate to ≤3%, or require the mitigation
   ladder at ≤2%? (SPK-L on an idle machine informs; monitor recommends
   deciding after SPK-L)
4. Approve implementation-phase start (O26 doc merge + oracle + fork
   tests)?
