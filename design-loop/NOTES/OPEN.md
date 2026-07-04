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
- **O20.** Browser continuation-carrier feasibility/overhead (bundled
  promise-reaction host hook) — SP-F8. Rule: if the hook cannot be built
  at <0.5% event overhead, the platform prerequisite stands (loud
  self-test), documented as a support-matrix line; monitor decides whether
  a dev-throw-on-post-await-write degraded mode ships instead. **The one
  architecture-relevant open spike (gates exit).**
- **O21.** Flattened-prefix length on deep suspense chains: measured
  inside SPK-G8; fallback = whole-mask clock vector (coarser refetch,
  flagged).

## Round-3 docket

No confirmed blockers stand against the round-2 champion. Round 3 waits on
SP-F8 (O20), then: builder integrates SP-F8's outcome + judge nits
(explainability 7 — the one-pager lags the repairs); cost adversary
re-runs W1/W2/W3/W5 against the repaired mechanisms; challenger seeded on
the lock-in/carrier stratum (multi-root × async × watermarks — the least
battle-tested new math) only if SP-F8 or the adversary opens a hole.

## Spike queue

| id | question | decision rule | status |
| --- | --- | --- | --- |
| SP1/SP1b | host tax | — | DONE (I11) |
| SP1c | closed protocol + packed columns | ≤2% ⇒ unblocks refactors | deprioritized |
| SP2 | E-PRESERVE validator cost | >10% dev → sampled validation | queued |
| SPK-H | dormant hook tax | >1% → out of DIRECT | DONE — TRIGGERED (remedy shipped in champion: twin builds) |
| SPK-Q | read-routing branch | >2% → behind LOGGED rebuild | DONE — TRIGGERED (remedy shipped; O19 renegotiation pending SPK-L) |
| SPK-L | LOGGED-quiet residual + activation cost (idle machine) | >2% confirmed → renegotiate ≤3% or mitigation ladder | queued (needs idle machine) |
| SPK-N1 | value-blind fan-out grid + held-batch row | >2× DIRECT propagate or >1 spurious render/(watcher,batch) → per-slot-mark dedup (D13) | queued |
| SPK-G8 | held-open bursts + typeahead restarts + prefix length | fail → pinless-frontier hybrid (O18) / whole-mask clock vector (O21) | queued |
| SPK-W | logged-write price | >2× DIRECT → inline-2 receipts / tape pooling | queued |
| SPK-R | retirement reconcile + targeted effect flush (10k atoms × 5k effects) | >2× the batch's own render → segmented folds | queued |
| SP-F8 | continuation-carrier feasibility + overhead | <0.5% event overhead or platform prerequisite + degraded-mode decision | **running** |
