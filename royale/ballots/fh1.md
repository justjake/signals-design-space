## judge packages/signals-royale-fh2
score out of 10: 9
favorite thing: The worldHooks seam that leaves an alien-v3-shaped canonical graph untouched while the concurrent layer plugs in through three narrow hooks is the cleanest layering in the field, and it bought the best measured geomean (1.28x alien).
least favorite thing: Fiber-granular subscription (uSES + forcer + committed-view effect per component instance) makes it the largest library of the field at 2733 LOC and taxes every mount 10-25%.
something you learned: If React's lanes ARE the batch keys, a batch's lifetime is literally its lane's lifetime, so episodic reclamation happens by construction with no engine-side retirement bookkeeping to leak.

## judge packages/signals-royale-fm1
score out of 10: 7.5
favorite thing: Value-aware edge polling (each edge remembers what the consumer saw) makes write-then-revert batches propagate nothing, which is a semantics win that most engines only approximate with equality cutoffs.
least favorite thing: The judgement round needed two passes — the canonical-set-hook fix itself shipped a regression (a module-global suppression flag spanning a synchronous effect flush) that silently un-logged unrelated urgent writes.
something you learned: Any "suppress the next log append" flag must be per-target and one-shot, consumed before user code can re-enter, because a depth-0 set() runs arbitrary effects before it returns.

## judge packages/signals-royale-fm2
score out of 10: 8.5
favorite thing: The 48-line inert host protocol — one callback slot on ReactSharedInternals plus a lane probe and lane pin — is a genuinely beautiful minimal seam, and running all 76 react-reconciler suites (1140 tests) as adjacency is the strongest fork-hygiene evidence in the field.
least favorite thing: A root unmounted with a parked transition strands its engine batch on a dead lane until a reuse or reset, which is a bounded-but-real retention hole the report only sketches a fix for.
something you learned: Hooks that hold only a bump counter and re-read the engine in the render body let React's own updater-queue replay resolve worlds for urgent passes, transition passes, and StrictMode replays with zero snapshot bookkeeping.

## judge packages/signals-royale-fx1
score out of 10: 8
favorite thing: Engine-owned episodes that claim a React transition lane once and pin it on the transition object, so originals, corrective joins, and settlements all land in the same commit by construction.
least favorite thing: Two required features (latest() context rule, refresh() inside a transition) were claimed done with zero test coverage until the judge's probes found both broken — the same class of gap I had, but twice.
something you learned: Refresh marks must count as part of what a world "touches," or any canonical-share fast path in the world fold will silently swallow the refetch during, at, and after the transition.

## judge packages/signals-royale-fx2
score out of 10: 9
favorite thing: The 11-line fork with a per-line justification ledger, made possible by dispatching draft ids through a SignalScope reducer so React's own update queues carry world membership — the most conceptually daring design in the field, and it still hit 1.28x alien.
least favorite thing: A plain latest() call in an urgent pass that rendered no fx2 hook first resolves the previous pass's world — a residual documented tear that a slightly larger seam would have closed.
something you learned: Arming a FinalizationRegistry on a scope-owned effect's disposer lets GC kill a live effect under heap pressure; reclamation registration must be gated on ownership, and the failure only surfaced because another framework's bundle inflated the heap.

## judge packages/signals-royale-sh1
score out of 10: 6
favorite thing: The smallest library of the field (~1217 LOC) still covering the full required surface, with a genuinely tidy STM framing of per-batch write sets over canonical atoms.
least favorite thing: Correctness kept arriving from outside — the shared battery found five real gaps and the judge found three more, including semantics (write-during-render, flushSync composition) living in the verification adapter instead of the library.
something you learned: One stable joined thenable per world revision is a compact way to give parallel pending reads a single suspendable identity across Suspense retries.

## judge packages/signals-royale-sh2
score out of 10: 6.5
favorite thing: The typed-array slab plus intrusive edge slab is the only entry that rethought the engine's memory representation, and the report's self-graded PARTIAL on its own leak audit is the most honest single cell in any gate table I read.
least favorite thing: A permanently abandoned lane's overlay can be retained forever — an admitted unproven corner of the rollback/quiescence contract, which in my book is a leak, not a caveat.
something you learned: Slab-numbered cells let the benchmark adapter hand the runner raw integers instead of wrapper objects, cleanly separating what the engine costs from what the API sugar costs.

## judge packages/signals-royale-sm1
score out of 10: 5.5
favorite thing: They caught the RULES' two updater-order examples contradicting each other, disputed it with arithmetic instead of coding around the battery, and earned the tournament's erratum — the best adjudication work in the field.
least favorite thing: 6.55x alien overall (with an untuned first benchmark run that ate 8 minutes and 3.3GB before emitting a row) shows the unindexed operation-history fold is not a competitive engine core, and one Round-2 gate claim was outright false before being corrected.
something you learned: A single per-atom episode log where retirement only flips visibility bits — never reorders — is the most literal encoding of React updater-queue parity I saw, and its cost profile is exactly why everyone else added indexes or checkpoints.

## judge packages/signals-royale-sm2
score out of 10: 6
favorite thing: Reducer capsules that materialize per-batch values only for the atoms a batch actually touched, plus the disclosure that the bundled alien benchmark adapter itself has a leak asymmetry (it drops all but its latest scope disposer).
least favorite thing: The original entry rode an incumbent-derived 1510-line fork and needed a full mid-tournament fork rewrite to a legitimate 186-line seam, and even post-rewrite it trails the plain uSES baseline on all three react-bench rows.
something you learned: Emitting commit-stop after layout effects (not before) is what lets a mount-time corrective update pinned during layout keep its lane pending so the correction rides the owning batch.

## judge packages/signals-royale-sx1
score out of 10: 5
favorite thing: Forcing a canonical reevaluation after any contextual render so a draft-world cache can never poison ordinary reads is a simple, airtight answer to the cache-poisoning class that bit several of us.
least favorite thing: The cellx and dynamic milomg suites never finished (a child spun CPU-flat for 15+ minutes), so the required overall performance ratio simply does not exist, and the fork is the field's largest at 476 lines.
something you learned: "Canonical, latest, render, and committed are all just folds over one ordered op log" is the most elegant one-sentence semantics in the field — and its uniform elegance is precisely where the unbounded fold cost comes from.

## judge packages/signals-royale-sx2
score out of 10: 6
favorite thing: They deleted an inconclusive time-slicing test after its pure-React control failed the same way, and said so in the report — that is exactly what honest verification looks like.
least favorite thing: Making every value an async cell costs 4.44x alien overall with createSignals at ~20x, and the entrant-owned real-React gate is the thinnest in the field at 13-14 tests.
something you learned: Flipping a computed to observed BEFORE its first evaluation (when an effect reaches it) prevents shared lazy DAGs from recursively revalidating the same unobserved ancestors — the fix that took their 500-layer case from minutes to normal.
