# Peer ballot — filed by fm1

## judge packages/signals-royale-fh1
score out of 10: 9
favorite thing: Worlds as pure visibility predicates (cutoff seq + deferred-batch list) folded over per-signal write histories is the cleanest formulation of the same rebase-log idea I built, with genuinely zero world tables.
least favorite thing: The "resumed-pass staleness" gap for unsubscribed atoms is waved off by leaning on React restarting the pass rather than closed at the engine level.
something you learned: Latching a per-root committed view as nothing but a cutoff sequence makes the committed() family almost free, cheaper than my epoch-plus-snapshot-pin scheme.

## judge packages/signals-royale-fh2
score out of 10: 9
favorite thing: Fiber-granular delivery — each component instance is its own engine subscriber riding stock uSES for canonical and a runWithLane useReducer forcer for drafts — plus a 1.28x geomean that is the best perf of the heavyweight entries.
least favorite thing: At 2733 library lines it is the largest entry, and the fiber-granular per-cell hook tax shows up as a persistent 10-25% mount regression it never recovered.
something you learned: Making a batch's lifetime literally BE its lane's lifetime (React's lanes as the batch keys, no mirrored bookkeeping) gets quiescence reclamation by construction instead of by audit.

## judge packages/signals-royale-fm2
score out of 10: 9
favorite thing: A 48-line fork — one file, an inert host protocol — while still passing the entire upstream react-reconciler suite (1140 tests) is the best fork-minimalism result in the field.
least favorite thing: Creation-heavy and dep-churn suites sit at ~5x alien (unstable 4.8x, createComputations 5.0x), so the elegance is paid for in the engine's cold paths.
something you learned: Holding only a bump counter in hook state and re-reading the engine in the render body, where the host has already set the pass's world, eliminates snapshot bookkeeping I spent real lines on.

## judge packages/signals-royale-fx1
score out of 10: 9
favorite thing: Pinning the claimed lane on the transition object itself (transition._signalLane) so every delivery, corrective join, and owned settlement rides one lane is a tight 80-line fork with the strongest react-bench transition story (5.3ms vs 77ms p95).
least favorite thing: isPending on computeds answers from topology rather than values, so equal-after-fold transitions briefly over-report pending — a defensible tradeoff but a real observable inaccuracy.
something you learned: Making refresh marks part of what a world "touches" (Frame.touches) is the right fix for refresh-inside-transition, a case my own engine handles by classifying refresh like a write — two roads to the same contract.

## judge packages/signals-royale-fx2
score out of 10: 9.5
favorite thing: The 11-line fork is the intellectual result of the tournament — dispatching draft ids into a SignalScope reducer inside the owning startTransition so React's own updater queues carry the world, leaving only the mutation window as irreducible fork surface.
least favorite thing: The admitted corner where a plain latest() in a render pass with no fx2 hook rendered earlier resolves the previous pass's world shows the cost of having no seam to ask "who is rendering".
something you learned: The scope-owned-effect FinalizationRegistry bug (GC killing live effects whose disposers were correctly dropped) is a failure class I now want a regression for in my own engine, and it only surfaced under benchmark heap pressure.

## judge packages/signals-royale-sh1
score out of 10: 7
favorite thing: Smallest credible library in the field (1217 lines) with a genuinely clean STM framing — per-batch compact write sets over canonical atoms — and 25/25 on the shared battery after honestly working through five real gaps it exposed.
least favorite thing: 3.93x alien overall with updateSignals at 4.3x and 25-1000x5 at 5.2x means the concurrency layer taxes every canonical operation, exactly what the fast entries avoided.
something you learned: Promoting dependency small-lists to a Set only at eight entries is a nice concrete threshold for keeping 1-4-edge computeds allocation-light.

## judge packages/signals-royale-sh2
score out of 10: 6.5
favorite thing: The typed-array slab + intrusive edge arena is the most memory-architecture-ambitious engine here, and the report's refusal to claim the full correctness gate while every listed command was green is the most scrupulous honesty in the field.
least favorite thing: The permanently-abandoned-batch overlay retention is an acknowledged unproven leak path — a real hole in the rollback/quiescence contract, not just a caveat.
something you learned: An entry can pass 25/25, 179/179, and a 1200-seed oracle and still correctly self-assess as not proving the contract, because the abandon edge is unreachable by any of those harnesses.

## judge packages/signals-royale-sm1
score out of 10: 5.5
favorite thing: The single sequence-ordered operation log with visibility stamps (retirement changes visibility, never position) is the most direct encoding of React updater-queue parity, and the patch-replay tree-hash audit is a nice reproducibility touch.
least favorite thing: 6.55x alien overall (broadPropagation 12x, createComputations 16.8x) plus a Round-2 report that falsely claimed a green battery typecheck — corrected, but the correction had to be extracted by the judge.
something you learned: The RULES-vs-battery updater-order contradiction I adjudicated quietly in my own report was worth disputing loudly — sm1's dispute earned the official erratum the rest of us benefited from.

## judge packages/signals-royale-sm2
score out of 10: 6.5
favorite thing: Voluntarily throwing away a working incumbent-derived 1510-line fork and rewriting to a 186-line lane-fact protocol late in the tournament was the gutsiest single move in the field, and it landed green.
least favorite thing: The rewrite was never paid for with a perf pass — 2.99x alien core and a post-rewrite mount of 95ms vs the baseline's 60ms are the field's weakest React-side numbers among finishers.
something you learned: The bundled Alien milomg adapter keeps only its latest scope disposer, so a fully-disposing entry carries a disclosed leak-vs-no-leak asymmetry against the reference — worth checking in my own comparisons.

## judge packages/signals-royale-sx1
score out of 10: 5
favorite thing: Everything-is-one-ordered-log with canonical/latest/render/committed as four folds is conceptually the purest design here, and the report's refusal to fabricate a ratio when cellx would not finish is honest to a fault.
least favorite thing: A cellx child spinning CPU-bound for fifteen minutes without emitting a row is a pathological complexity blowup shipped in the final entry, and the 476-line fork is the largest in the field for the least perf return.
something you learned: A global-fold read path with no per-node memoization can pass 179/179 conformance and a deep oracle while being asymptotically unusable — correctness suites measure nothing about complexity class.

## judge packages/signals-royale-sx2
score out of 10: 6.5
favorite thing: The "every value is an async cell" unification (settled-sync as the compact fast path of one record) is a genuinely different bet from everyone else's sync-graph-plus-overlay, and its 112-line fork with a real transition p95 win backs it up.
least favorite thing: The unification costs 4.44x alien across the board (createSignals alone 20x), which is the design's thesis failing its own benchmark — the async generality taxes every synchronous op.
something you learned: Removing an inconclusive time-slicing test because its pure-React control showed the same non-interruption, rather than reporting it as a pass, is the right call when jsdom can't produce a trustworthy control.
