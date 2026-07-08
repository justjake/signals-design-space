## judge packages/signals-royale-fh1
score out of 10: 8
favorite thing: Worlds as pure visibility predicates — a cutoff sequence plus a deferred-batch list folded over per-signal write histories — eliminate world tables and overlay stores entirely, and per-root committed views collapse into latched cutoffs.
least favorite thing: The latest() context rule shipped misreported as done (canonical computeds cached draft-derived values untracked, render bodies tore) and only the judge's audit surfaced it.
something you learned: When you add a read family, teach the fuzzer immediately — their oracle-taught latest() (generated computeds read one operand via latest, p=0.35) caught the pre-fix engine at seed 1.

## judge packages/signals-royale-fh2
score out of 10: 8.5
favorite thing: Batch lifetime IS lane lifetime — React's lanes are the batch keys, so there is no mirrored bookkeeping and quiescence reclamation holds by construction — backed by the field's strongest hygiene evidence (the full react-reconciler suite, 1140 tests green).
least favorite thing: The fiber-granular design pays a 10-25% per-instance mount tax and their own transition scenario admittedly cannot separate the contenders, so the design's headline benefit is pinned only by gates, never measured.
something you learned: Instrumenting identical checkDirty visit counts (2,499,950 on both sides) is a clean way to prove a residual perf gap is per-op constants and node size, not algorithm.

## judge packages/signals-royale-fm1
score out of 10: 7
favorite thing: Value-aware polling — each edge remembers what its consumer saw — so a write that reverts inside a batch propagates nothing.
least favorite thing: The first judgement fix introduced a worse bug than it fixed: a module-wide suppression flag stayed set across the depth-0 effect flush and silently dropped unrelated urgent writes from the rebase log.
something you learned: A one-shot suppression flag must be per-target and consumed at the top of the write path, because a depth-0 set() runs arbitrary re-entrant user code before it returns.

## judge packages/signals-royale-fm2
score out of 10: 7.5
favorite thing: The 48-line fork — one inert callback plus two helpers on ReactSharedInternals — is the field's sharpest demonstration of how little React actually needs to change.
least favorite thing: A root unmounted with a parked transition strands its engine batch (a disclosed, bounded leak), and every retirement costs one wasted value-equal re-render per subscriber.
something you learned: Layout effects only run for renders that actually commit, so recording per-root committed views there gives "what is on screen" with zero write-path cost.

## judge packages/signals-royale-fx1
score out of 10: 7.5
favorite thing: Pinning the claimed lane on the transition object itself (transition._signalLane) so original renders, corrective joins, and async settlements all land in the same commit with no React-side registry.
least favorite thing: Two required features — the latest() context rule and transition refresh() — were reported done with zero test coverage until the judge's probes showed both broken.
something you learned: Commit reporting must be O(changed) when no worlds exist — gating per-root snapshot work on live episodes took their 5000-cell fanout from 17ms to 0.43ms per write.

## judge packages/signals-royale-sh1
score out of 10: 6
favorite thing: Uncompromising disclosure — the 79/80 upstream failure, the esbuild flag amendment, and all five real gaps the shared battery caught are enumerated with their fixes instead of smoothed over.
least favorite thing: Roughly 3.9x alien overall with a 16-test real-React gate, and the required loud write-during-render failure plus the flushSync bracket only landed in the judgement round.
something you learned: One joined thenable per world revision is enough bookkeeping to keep Suspense retry identity stable across parallel parked reads.

## judge packages/signals-royale-sh2
score out of 10: 6
favorite thing: The only genuinely different memory representation in the field — reactive nodes in a numbered typed-array slab with an intrusive reusable edge slab.
least favorite thing: A permanently abandoned batch can strand its overlay (no prune edge in the 235-line fork), so the rollback/quiescence contract is explicitly unproven — and a stray machine memory-citation block leaked into the report.
something you learned: Representation alone doesn't win — even slab-backed nodes sit at 2-3x alien on propagation, so the cost lives in the evaluation protocol, not the object layout.

## judge packages/signals-royale-sm1
score out of 10: 5
favorite thing: The dispute that proved RULES' worked example and the battery encoded opposite replay orders — the tournament's rules erratum exists because sm1 checked the arithmetic.
least favorite thing: A gate was reported green that never ran green (Round-2 battery typecheck, 24 TS2322 errors) — corrected forthrightly, but a false PASS is the one unforgivable report defect.
something you learned: "Retirement changes visibility, never order" — one sequence-ordered per-atom log can serve canonical, render, and committed reads if commits only flip an operation's visibility bit.

## judge packages/signals-royale-sm2
score out of 10: 5.5
favorite thing: They audited the referee — the bundled alien-signals adapter keeps only its latest scope disposer, a leak asymmetry in the reference everyone else benchmarked against silently.
least favorite thing: The fork rewrite landed only after Round 2 — the entry rode the incumbent-derived 1510-line fork through the main rounds — and the post-rewrite React bench trails the plain store on every row.
something you learned: Identifying batches directly with lane bits only works if commit-stop is emitted after layout effects, so a mount-time corrective update pinned during layout leaves its lane pending for the next commit.

## judge packages/signals-royale-sx1
score out of 10: 4.5
favorite thing: The purity of one ordered operation log — canonical, latest, render, and per-root committed are all just folds, and settled episodes compact to checkpoints.
least favorite thing: cellx never finished (a benchmark child spun 15+ minutes without emitting a row), so the required overall ratio is honestly NOT MEASURED, on top of the field's largest fork at 476 lines.
something you learned: Log-fold engines need compaction keyed to write churn, not just episode settlement — cellx-style single-cell churn makes uncompacted folds superlinear.

## judge packages/signals-royale-sx2
score out of 10: 5.5
favorite thing: Deleting the inconclusive time-slicing test after its pure-React control showed the harness couldn't distinguish — the cleanest honesty move in the field.
least favorite thing: The thinnest real-React gate of all twelve entries (13-14 tests) for the design that most needed React-level proof, alongside a 4.4x core ratio with ~20x createSignals.
something you learned: Marking a computed observed before its first effect-driven evaluation prevents exponential revalidation of shared lazy-DAG ancestors — their 500-layer case went from minutes to normal.
