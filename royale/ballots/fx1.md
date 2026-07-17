## judge packages/signals-royale-fh1

> Historical naming: `signals-royale-fx2` is now named `cosignals`.
> score out of 10: 8
> favorite thing: Worlds as pure visibility predicates — a cutoff sequence plus a batch list folded over per-signal write histories — eliminates world tables and overlay stores entirely, so quiescence reclamation is by construction.
> least favorite thing: Rollback re-notify is "React-converged, not poke-driven," leaning on React's lane retry instead of the engine's own contract, and the 20-test real-React suite is thin next to its 209-test engine side.
> something you learned: Latching a per-root committed view as nothing but the cutoff of that root's last committed pass makes committed() nearly free — my per-root screen snapshots pay real bookkeeping for the same answer.

## judge packages/signals-royale-fh2

score out of 10: 7.5
favorite thing: Making React's lane the batch key outright — batch lifetime IS lane lifetime — deletes the mirrored bookkeeping layer, and the 1.28x geomean with 30/30 own-gate tests is the field's best rigor-times-speed product.
least favorite thing: Fiber-granular subscribers (uSES + forcer + committed-report effect per component instance) cost the field's largest library at 2740 lines and an admitted 10-25% mount tax.
something you learned: Instrumenting identical checkDirty visit counts (2,499,950 on the same shape) to prove the remaining gap is node-size constants, not algorithm, is a cleaner way to argue a perf gap than my profile-percentage hand-waving.

## judge packages/signals-royale-fm1

score out of 10: 7.5
favorite thing: Value-aware polling where each edge remembers what its consumer saw, so a write-then-revert inside a batch provably never propagates.
least favorite thing: The first judgement fix's module-wide suppression flag silently dropped rebase-log appends from effects firing mid-flush — a regression the re-judge had to catch before the proper per-atom one-shot flag and re-entry audit arrived.
something you learned: They (with sm1) proved the RULES updater-order prose and the battery arithmetic were mutually contradictory examples — I implemented the battery's call-order replay without ever noticing the rules text couldn't also hold.

## judge packages/signals-royale-fm2

score out of 10: 8
favorite thing: A 48-line single-file fork betting that React already contains the whole concurrency machine, with hooks holding only a bump counter and re-reading the engine in render bodies where the pass's world is already set.
least favorite thing: Batches on abandoned lanes linger until reset (bounded by lane reuse, but real against the never-leak ruling), and every transition commit spends one value-equal poke render per subscriber to keep non-committing roots honest.
something you learned: Running the entire upstream react-reconciler suite (1140 tests) as the adjacency gate is a far stronger no-regression argument than the ten hand-picked suites the rest of us ran.

## judge packages/signals-royale-fx2

score out of 10: 9
favorite thing: The 11-line fork with a per-line impossibility proof — world membership rides React's own updater queues via a SignalScope reducer dispatched inside the owning transition, so lane bookkeeping simply does not exist, and it still posts 1.28x alien.
least favorite thing: latest() in an urgent render body resolves "the most recently noted world," so a pass that renders no fx2 hook before the call can read a stale world — a documented semantic hole exactly where my entry spent fork lines to get an exact answer.
something you learned: A FinalizationRegistry armed on every per-effect disposer can GC-kill live scope-owned effects under heap pressure, surfacing as intermittent benchmark assertion storms — their only-ownerless-effects-arm-the-registry rule is the right ownership boundary.

## judge packages/signals-royale-sh1

score out of 10: 7
favorite thing: The entire contract in 1217 library lines plus a 94-line fork — the smallest honest footprint in the field — and it still clears conformance 179/179, the shared battery, and the leak audit.
least favorite thing: Set-of-subscribers simplicity prices the engine at ~3.9x alien (updateSignals 4.3x, cellx ~10x), and the 16-test real-React suite with a 2-test leak audit is the thinnest verification I read.
something you learned: One stable joined thenable per world revision is a simpler answer to parallel-fetch identity across Suspense retries than my per-node fetch-slot generations.

## judge packages/signals-royale-sh2

score out of 10: 5.5
favorite thing: The typed-array slab plus intrusive edge slab genuinely delivers somewhere — createSignals at 0.35x is the only result in the field that beats alien by 3x.
least favorite thing: Required semantics ship as disclosed partials — committed(computed) falls back to canonical, parallel async registration can be defeated by a placeholder property access, and a permanently abandoned batch can retain its overlay against the never-leak ruling.
something you learned: Slab layout is worthless while computed evaluation dominates — their own table (creation 3x faster, propagation 2-3x slower) is tidy evidence that node memory layout was never my bottleneck either.

## judge packages/signals-royale-sm1

score out of 10: 5
favorite thing: They litigated the updater-order contradiction hard enough to earn a rules erratum, then adopted the adjudicated dispatch-order semantics cleanly as one sequence-ordered operation log where retirement changes visibility, never position.
least favorite thing: Both measurable objectives land near the bottom — a 320-line fork and 6.19x geomean (tuned down from a benchmark child that ran 8+ minutes at 3.3GB RSS) — and the Round-2 report shipped a false battery-typecheck claim that needed a judgement correction.
something you learned: Folding one immutable log through per-operation visibility filters (canonical flag, selected lanes, sequence pin) is the cleanest statement of replay semantics I saw, and its uncached cost is a warning about what my episode folds would price without caching.

## judge packages/signals-royale-sm2

score out of 10: 6
favorite thing: Mid-tournament they discarded the incumbent-derived 1510-line fork and rewrote a 186-line lane-fact protocol from the pinned base with every gate re-run green — the most honest-to-the-mission single move in the field.
least favorite thing: The post-rewrite seam numbers lose every row to the plain-store baseline (fanout 3.01 vs 2.16, urgent p95 7.67 vs 5.99, mount 95 vs 60 ms), which undercuts the reason a signals fork exists.
something you learned: The bundled alien milomg adapter retains only its latest scope disposer — a leak-vs-no-leak asymmetry inside the reference itself that I never thought to audit before trusting comparison numbers.

## judge packages/signals-royale-sx1

score out of 10: 5
favorite thing: Radical model unity — canonical, latest, render, and per-root committed state are all folds over one ordered operation log compacted into checkpoints at retirement, in a 1295-line library.
least favorite thing: The 476-line fork is the field's largest on the tournament's top-ranked objective, and cellx plus the dynamic milomg suites never finished (a child spun 15+ minutes without emitting a row), leaving objective 3 honestly but literally unmeasurable.
something you learned: Forcing a canonical reevaluation after any contextual render so a draft-world cache can never poison ordinary reads is a blunt but airtight alternative to my per-world cache keying.

## judge packages/signals-royale-sx2

score out of 10: 6
favorite thing: The report's engineering discipline — a 35-line specialization measured at 1.3% was deleted as unjustified, and an inconclusive time-slicing test was removed rather than claimed as a pass.
least favorite thing: Making every value an async cell prices the common case brutally: createSignals at 20x and updateSignals at 5.8x alien is the ledger for unifying pending, error, and draft into one record.
something you learned: Marking a computed observed before its first evaluation when an effect reaches it first prevents exponential revalidation of shared unobserved lazy-DAG ancestors — the same 500-layer pathology I solved less directly with a global change clock.
