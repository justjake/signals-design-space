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
- **O24 (new).** D13-fallback obligation: per-slot-mark delivery dedup may
  not be adopted on SPK-N1/SPK-W gate failure without its own walked
  schedule first (S17 re-entry risk). [a-claude F7]
- **O25 (new).** K1/E-PRESERVE growth without quiescence is a declared gap
  (synthesis G9) with a bounded mid-episode sweep; SPK-K1 measures the
  residual. [a-claude F5]

## Round-3 outcome

The dry-check FAILED its premise: 28 findings adjudicated, 25 CONFIRMED
(several cross-design), 3 REFUTED (the loop's first), 0 needs-measurement;
the judge then confirmed 2 NEW blockers minted by the round's own merged
repairs (taint non-propagation through tracked serves; mount-fixup
suppression contradicting its own retire-race walk) and scored mechanisms
5 — a complexity-accretion signal. Exit criteria NOT met. Champion updated
to `rounds/round-03/synthesis.md` (D12 amendment).

## Round-4 outcome

NOT dry. 20 findings adjudicated: 19 CONFIRMED (three cross-design classes
— I44 dedup, I46 stage-temporal, I47 drain coverage; I44/I47 textually
inherited by the round-3 champion), 0 refuted, 1 needs-measurement. The
round-4 docket's own repair targets ALL HELD under adversarial
re-derivation (taint merge, walkGen atomicity, lock views, lineage stamps,
I35 revalidation, F9 ordering, shims, saturation, mount w_fx); the new
blockers came from ADJACENT strata (evaluator visibility I45, delivery
dedup I44, drain coverage I47, lifecycle horizons I49/I50, reclamation
D19). Judge: 2 new blockers, both minted by the round's own repairs (R12
baseline fast-out; R1 unrouted evaluator versions); mechanisms recovered
5→6 with a net state deletion. Champion: rounds/round-04/synthesis.md.

## Round-5 outcome (FINAL budgeted round)

NOT dry, but the closest yet: 15 findings adjudicated, 13 CONFIRMED (all
repaired in-round), 2 REFUTED; judge's independent re-walk confirmed ZERO
new blockers against the repaired synthesis (scores 8/6/8/7/5); both
surgical drafts held at 9 mechanisms. Champion:
rounds/round-05/synthesis.md. Budget cap reached — loop concludes;
EXIT-CASE.md presents best-so-far + the scope-cut proposals + the
monitor-design convergence analysis for Jake's sign-off. Judge's two open
architecture-relevant empirical items: O19 (SPK-L requirement decision)
and the SPK-N1/G8 gate family. NEW O26: mechanically merge the three-file
champion (round-3 base + round-4 diffs + round-5 diffs) into ONE document
before implementation — explainability scored 5 because the story is
scattered.

## Round-5 docket (as executed — surgical)

One job: adversarially re-derive ONLY the round-4 synthesis's new math —
R1 pin-resolved version chain, R2 pass-aware suppression, R3
seeding/walk/termination (incl. A/B/A), R4 closed drain coverage, R8 live
renumber, R9 reference installation, R12 baseline comparator — plus the
merged fork-test list, repairing the judge's 2 blockers (R12 fast-out;
R1 unrouted evaluator versions) with MINIMAL diffs. NO new mechanisms; no
scope beyond the listed math; every repair ships with the attacking
schedule as a pinned case. Judge re-walks the full battery. Dry ⇒ exit
case per LOOP.md. Not dry ⇒ budget cap: exit case presents best-so-far
with open items documented.

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
| SPK-W | logged-write price + walkGen stamp + staging-walk/restart frequency (R3) + pass-aware dedup check (R2) | >2× DIRECT → inline-2 receipts / tape pooling | queued |
| SPK-R | dense retirement (breaker W5 A/B) + advance-drain watcher reconcile (R4) + promotion walk (R1), under the corrected SPLIT comparator: G-R-core vs DIRECT batch(), G-R-react vs useState — old render-relative gate DELETED (zero-denominator defect, breaker B4) | per comparator | queued |
| SP-F8 | continuation-carrier feasibility + overhead | <0.5% event overhead or platform prerequisite | **DONE — FEASIBLE** (twin-build carrier, I30/S22) |
| SPK-K1 | K1 growth under never-quiescent traffic with the G9 sweep | >1 MB/h steady growth or >5% walk degradation on soak → extend sweep predicate (sampled reachability), else G9 stands documented | queued |
