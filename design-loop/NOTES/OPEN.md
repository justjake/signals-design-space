# OPEN — live questions

Closed in round 1: O2, O4, O5, O6, O8, O9, O10 (see DECISIONS/INVARIANTS).
Closed in round 2: O11 (fixup = touchedSlots ∩ live written tokens —
structural answer verified held by both reviewers; residual = G-F harness
numbers), O13 (constructions landed: saturation renumber+hard-throw, token
live-skip, K1 tag wrap-clear, epoch mint from globalSeq), O14 (D15), O15
(D14), O16/O17 (D16). Round-1's 8-blocker docket: fully repaired in the
round-2 champion; judge sustained with zero confirmed blockers.

- **O1 (narrowed).** Per-world dependency knowledge lives in K1 as real
  recorded edges (D8/D12). Compensated single kernel remains the named
  fallback only on SPK-* gate failure.
- **O3.** SP2 queued: E-PRESERVE dev validator cost; >10% dev overhead →
  sampled validation.
- **O7 (narrowed).** Per-root lock-in (now watermarked, I25) lives in the
  bindings' root registry. REMAINING RISK: fork-side per-root facts have
  no current-generation existence proof — fork tests on the critical path.
- **O12 (sharpened).** Value-blind fan-out cost: SPK-N1 grid + held-batch ×
  writes/frame row; fallback restricted by D13 to per-slot-mark dedup only.
- **O18.** Restart-heavy held-transition revalidation: pin-in-worldKey
  re-evaluates the flagged region per interruption; pinless keys are dead
  as defaults (S18). SPK-G8 gains the typeahead row; fallback = the
  specced pinless-frontier hybrid (epoch-keyed frontier memo + pass-local
  scratch), adopted only on gate failure.
- **O19.** G-Q's ≤2% vs the measured 2.4–3.8% branch floor [SPKHQ]:
  SPK-L (idle machine) decides; pre-registered monitor renegotiation to
  ≤3% or the mitigation ladder. A requirements decision, not a defect.
- **O20 — CLOSED (SP-F8 → I30/S22).** Carrier FEASIBLE: bundler twin-build,
  ≈0% unarmed, <0.5% gate passed; prerequisite moves host→build (transform
  + loud boot self-test + AsyncContext feature-detect ladder + support-
  matrix line). Degraded dev-throw mode not needed as default. The
  champion must integrate the build-prerequisite surface (round-3 builder).
- **O21 (extended).** Flattened-prefix length on deep suspense chains +
  I35's re-fold revalidation cost + the evaluator-stamp vector length:
  all measured inside SPK-G8; fallback = whole-mask clock vector (coarser
  refetch, flagged).
- **O22 (new).** Scheduler-shim coverage matrix (I36): which registrars
  are shimmed per host, registration cost while armed, dev-warn
  false-positive rate in busy apps. Decision rule: any measurable unarmed
  cost ⇒ shim install moves entirely behind the carrier-armed path.
- **O23 (new).** F9's fork-side existence proof joins O7's risk line: the
  hook-becomes-current publication edge (hidden Offscreen, error
  abandonment, alternates) has no current-generation React existence
  proof; fork tests 20–23 on the critical path with O7's 15–17.

## Round-3 outcome

The dry-check FAILED its premise: 28 findings adjudicated, 25 CONFIRMED
(several cross-design), 3 REFUTED (the loop's first), 0 needs-measurement;
the judge then confirmed 2 NEW blockers minted by the round's own merged
repairs (taint non-propagation through tracked serves; mount-fixup
suppression contradicting its own retire-race walk) and scored mechanisms
5 — a complexity-accretion signal. Exit criteria NOT met. Champion updated
to `rounds/round-03/synthesis.md` (D12 amendment).

## Round-4 docket (consolidation: repair-only, NO new mechanisms)

Repair the judge's 2 blockers + adversarially re-derive the round-3 NEW
math, each with its attack: taint routing conjunct (I33 — taint set/clear
races across yield gaps; DIRECT→LOGGED transition caches; propagation
through tracked serves, the judge's blocker), walkGen termination (I32 —
reentrant walks from edge-add deliveries inside a walk), immutable lock
views + lockTerm fp (I34 — view re-mint vs yielded same-root passes; fp
cost), lineage-stable stamps (I40 — deps oscillation within one lineage;
cross-lineage reuse), value-revalidated prefixes (I35 — revalidation
through staged evaluators; deep-prefix fold cost), F9 ordering + reducer
re-fold (I38/I41 — multi-root commits with pending receipts both sides;
promotion during saturation), scheduler shims + retired-token fallback
(I36/I37 — shim liveness races; nested registrations; MessageChannel),
saturation spillover (I39 — force-clear during an open walk; fastPath
flag vs RENDER_NEWEST), mount-fixup skip rule (I43 — the judge's second
blocker). HARD CONSTRAINT: no new mechanisms; every repair reuses or
DELETES machinery — the mechanisms score must recover, not fall. If round
4 comes back dry, round 5 does not exist: the budget (5) reserves it, but
a dry round 4 = second-dry after re-review of all new math → prepare the
exit case.

## Spike queue

| id | question | decision rule | status |
| --- | --- | --- | --- |
| SP1/SP1b | host tax | — | DONE (I11) |
| SP1c | closed protocol + packed columns | ≤2% ⇒ unblocks refactors | deprioritized |
| SP2 | E-PRESERVE validator, promoted to CI fuzz gate (strong reading) | >10% dev → sampled validation | queued |
| SPK-H | dormant hook tax | >1% → out of DIRECT | DONE — TRIGGERED (remedy shipped in champion: twin builds) |
| SPK-Q | read-routing branch | >2% → behind LOGGED rebuild | DONE — TRIGGERED (remedy shipped; O19 renegotiation pending SPK-L) |
| SPK-L | LOGGED-quiet residual + activation cost (idle machine) | >2% confirmed → renegotiate ≤3% or mitigation ladder | queued (needs idle machine) |
| SPK-N1 | value-blind fan-out grid + held-batch row + breaker W1 workload + walkGen pricing | >2× DIRECT propagate or >1 spurious render/(watcher,batch) → per-slot-mark dedup (D13) | queued |
| SPK-G8 | held-open bursts + typeahead restarts (breaker W3) + prefix/stamp-vector length + I35 re-fold cost | fail → pinless-frontier hybrid (O18) / whole-mask clock vector (O21) | queued |
| SPK-W | logged-write price + walkGen stamp | >2× DIRECT → inline-2 receipts / tape pooling | queued |
| SPK-R | dense retirement (breaker W5 A/B) under the corrected SPLIT comparator: G-R-core vs DIRECT batch(), G-R-react vs useState — old render-relative gate DELETED (zero-denominator defect, breaker B4) | per comparator | queued |
| SP-F8 | continuation-carrier feasibility + overhead | <0.5% event overhead or platform prerequisite | **DONE — FEASIBLE** (twin-build carrier, I30/S22) |
