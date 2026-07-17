## judge packages/signals-royale-fh1

> Historical naming: `signals-royale-fx2` is now named `cosignals`.
score out of 10: 8.5
favorite thing: Worlds are nothing but visibility predicates (a cutoff seq plus a deferred-batch list) folded over per-signal write histories, so there are no world tables or overlay stores to reclaim.
least favorite thing: The judge had to catch `latest()` being flatly wrong in two whole contexts (canonical computed evaluations and render bodies) after section 5 had already claimed it done.
something you learned: Retirement that refolds the entire log in sequence order gives you React updater-queue rebase arithmetic without ever reordering an operation.

## judge packages/signals-royale-fm1
score out of 10: 8
favorite thing: The forensic writeup of the suppression-flag regression — including a re-entry audit of every path that runs user code synchronously under `set()` — is the most honest debugging narrative in the field.
least favorite thing: The first judgement fix introduced that regression because a module-global boolean was used for a per-atom, one-shot concern, and it took a re-judge to find it.
something you learned: Value-aware edge polling where each edge remembers what its consumer last saw makes write-then-revert batches propagate nothing, for free.

## judge packages/signals-royale-fm2
score out of 10: 8.5
favorite thing: The 48-line inert host protocol plus hooks that hold only a bump counter and re-read the engine in the render body — values never live in React state at all.
least favorite thing: A root unmounted with a parked transition leaves its engine batch open, a disclosed but real reclamation hole that a leak-is-a-bug posture shouldn't ship.
something you learned: Recording per-root committed views from layout effects is correct by construction because layout effects only run for renders that actually commit — zero write-path cost.

## judge packages/signals-royale-fx1
score out of 10: 8
favorite thing: Pinning the claimed lane on the transition object itself (`transition._signalLane`) so original re-renders, mid-transition corrective joins, and owned async settlements all land in one commit.
least favorite thing: Both judgement defects — the `latest()` render-body tear and the silently swallowed in-transition `refresh()` — were features claimed done with zero test coverage behind them.
something you learned: Making refresh marks part of "what a world touches" (`Frame.touches`) lets the transition's own render evaluate the node and own the new fetch generation cleanly.

## judge packages/signals-royale-fx2
score out of 10: 9
favorite thing: The 11-line fork with a per-line "why this cannot be userland" ledger, made possible by dispatching draft ids through React's own reducer update queues so lanes, rebasing, and replay come free.
least favorite thing: `latest()` in a pass where no fx2 hook rendered earlier resolves the previous pass's world — a live correctness corner closed by documentation rather than mechanism.
something you learned: A FinalizationRegistry armed on scope-owned effect disposers can GC-kill live effects under heap pressure; ownership, not creation, should decide who arms reclamation.

## judge packages/signals-royale-sh1
score out of 10: 6.5
favorite thing: The smallest library in the field (~1.2k lines, essentially one readable STM file) still clears the full 25/25 battery.
least favorite thing: The judgement round revealed battery-facing behaviors (the render-write guard, flushSync composition) living in the verification adapter instead of the shipped library.
something you learned: One stable joined thenable per world revision is a compact way to satisfy Suspense retry identity across parallel pending reads.

## judge packages/signals-royale-sh2
score out of 10: 6.5
favorite thing: The typed-array slab plus intrusive edge slab is the only genuinely data-oriented engine in the field, and it wins raw signal creation outright (0.35x alien).
least favorite thing: A batch scheduled on a root that never commits has no prune edge, so the report itself concedes the rollback/quiescence contract is unproven — an open leak class.
something you learned: Handing the benchmark adapter numeric cell IDs makes the harness measure the slab itself rather than one wrapper object per cell.

## judge packages/signals-royale-sm1
score out of 10: 5.5
favorite thing: The patch replay audit that proves the replayed tree hash equals the fork tree hash is verification discipline I'd steal.
least favorite thing: Round 2 shipped a false "battery typecheck passed" claim over 24 real TS errors, on top of 6.55x alien performance and the field's second-largest fork (320 lines).
something you learned: A single sequence-ordered operation log where retirement merely stamps visibility — never moving an op past later urgent work — makes updater-queue parity nearly definitional.

## judge packages/signals-royale-sm2
score out of 10: 6.5
favorite thing: Voluntarily rewriting the incumbent-derived 1510-line fork into a 186-line lane-fact protocol mid-tournament, keeping the old branch around for the record.
least favorite thing: The post-rewrite React seam numbers lose to the plain uSES store on all three scenarios (mount 95ms vs 60ms) with core at 2.99x alien.
something you learned: The bundled alien benchmark adapter retains only its most recent scope disposer — a reference-side leak asymmetry worth disclosing rather than silently patching.

## judge packages/signals-royale-sx1
score out of 10: 5
favorite thing: Unflinching honesty — reporting cellx and the dynamic suites as NOT MEASURED after a 15-minute CPU spin instead of substituting a friendlier statistic.
least favorite thing: 476 fork lines, the largest in the field, buying a global-fold engine that cannot finish cellx at all.
something you learned: Forcing a canonical reevaluation after any contextual render is a blunt but sound way to guarantee a draft cache can never poison ordinary reads.

## judge packages/signals-royale-sx2
score out of 10: 6
favorite thing: "Every value is an async cell" collapses pending, error, stale-refresh, and transition drafts into one record with settled-sync as the compact fast path — the most unified data model in the field.
least favorite thing: That unification puts concurrency freight on every hot path: 20x alien on createSignals and 4.4x overall, with the CPU time-slicing scenario only proven via the shared battery.
something you learned: Making a computed's first observation precede its initial evaluation stops shared lazy DAGs from exponentially revalidating unobserved ancestors.
