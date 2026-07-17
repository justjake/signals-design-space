## judge packages/signals-royale-fh1

> Historical naming: `signals-royale-fx2` is now named `cosignals`.
score out of 10: 8.5
favorite thing: Worlds as pure visibility predicates (cutoff seq + deferred-batch list) folded over per-signal write histories is the cleanest zero-table formulation of the concurrent model in the field, and it made per-root committed views nearly free.
least favorite thing: The latest() context rule shipped broken in two contexts (canonical computed evaluations went permanently stale, render bodies tore) and was only caught by the judge, after the report had claimed it done.
something you learned: Teaching the fuzz oracle to call latest() from generated computeds needs no new model branch when latest-in-context is defined as "the context's own fold" — the invariant is self-checking.

## judge packages/signals-royale-fh2
score out of 10: 9
favorite thing: Making React's lanes literally BE the batch keys — a batch's lifetime is its lane's lifetime — deletes the entire lane-to-batch mirroring layer I and most others carried, and the 1.28x geomean shows the concurrent overlay can ride an alien-shaped core almost for free.
least favorite thing: Fiber-granular subscription (one engine subscriber + uSES + forcer + committed-view effect per component instance) buys precision at a permanent 10-25% mount tax the design can't easily shed.
something you learned: Their instrumented claim that the propagation core does identical visit counts to alien (2,499,950 checkDirty calls on the same shape) is the right way to prove a perf gap is per-op constants rather than algorithm — my report argued the same point with less evidence.

## judge packages/signals-royale-fm1
score out of 10: 7.5
favorite thing: Value-aware polling where each edge remembers what the consumer saw makes write-then-revert batches propagate nothing, and the in-place dependency prefix fast path is a genuinely tight steady-state loop.
least favorite thing: The judgement fix for the direct-set() bypass introduced its own regression (a module-global suppression flag swallowing unrelated urgent writes fired from effect flushes), needing a second fix round — a sign the write path had one too many entangled entry points.
something you learned: Their re-entry audit — enumerating every path that runs user code synchronously under set() and testing each — is a discipline I should apply to my own retirement-poke path.

## judge packages/signals-royale-fx1
score out of 10: 8
favorite thing: Inverting the ownership — the engine claims a lane once, pins it on the transition object, and dispatches every corrective delivery under it — gives the crispest urgent-during-transition number in the field (5.3ms p95 vs 77ms baseline) with only an 80-line fork.
least favorite thing: Two required features (latest() render-body tear, transition refresh() silently swallowed by a fast path) were claimed done with zero covering tests until the judge probed them — fast paths that skip semantic checks are exactly where untested claims rot.
something you learned: Topology-based isPending for deriveds ("do open episodes touch your sources") is a defensible over-report-never-evaluate trade I hadn't considered — my value-based probe pays evaluation cost theirs never does.

## judge packages/signals-royale-fx2
score out of 10: 9
favorite thing: An 11-line fork — dispatching draft ids into a per-root reducer inside the owning startTransition so React's own updater queues carry the worlds — is the tournament's thesis (React already contains the concurrency machine) executed more purely than my own 48-line version.
least favorite thing: The residual latest() hole (a render pass with zero fx2 hooks before the call resolves the previous pass's world) is the structural price of having no seam at all, and the docs-recommendation workaround is thinner than a fix.
something you learned: Their GC bug hunt — FinalizationRegistry disposing live scope-owned effects only under benchmark heap pressure, surfacing as assertion storms — taught me that finalizer registration must follow ownership, not creation.

## judge packages/signals-royale-sh1
score out of 10: 6.5
favorite thing: At 1217 library lines with a 94-line fork it is the most honest small entry — the operation-log STM design is stated plainly and the battery drove five real semantic fixes that are each named rather than hidden.
least favorite thing: 3.9x alien overall with updateSignals at 4.3x and 25-1000x5 at 5.2x means the compact write-set design never got a real hot-path pass, and the 16-test react suite is thin coverage for the concurrency surface.
something you learned: Their gap analysis that a computed creating a brand-new promise per evaluation can start one extra request after settlement — because JavaScript cannot resume mid-expression — is the cleanest statement of why keyed resource slots are unavoidable, not optional.

## judge packages/signals-royale-sh2
score out of 10: 6
favorite thing: The typed-array slab + intrusive edge slab engine is the only genuinely different memory architecture in the field, and 0.35x alien on createSignals proves the slab thesis where it applies.
least favorite thing: The admitted unproven case — a permanently abandoned batch can retain a live overlay with no prune edge — is a leak in the rollback/quiescence contract, and the entry ships it as a known residual rather than spending fork lines to close it.
something you learned: Promoting dependency membership from a linear list to a Set only above eight edges is a cheap two-regime trick that matches real graph statistics better than my always-Set choice.

## judge packages/signals-royale-sm1
score out of 10: 5.5
favorite thing: They found and litigated the genuine contradiction between the RULES prose arithmetic and the battery's expectations, got the erratum credited, and their probes of the old overlay behavior are model examples of documenting a semantic dispute.
least favorite thing: 6.2x alien geomean (createComputations 16.8x), a 320-line fork — the field's second largest — and a Round-2 report that falsely claimed the battery typecheck passed make this the weakest combination of performance, size, and reporting accuracy among the finishers.
something you learned: An untuned single-history fold can cost 8 minutes and 3.3GB on one benchmark child — a warning about how quickly per-read log walks compound when nothing indexes the episode log.

## judge packages/signals-royale-sm2
score out of 10: 6
favorite thing: Voluntarily throwing away a working 1510-line incumbent-derived fork and rewriting to a 186-line lane-facts protocol late in the tournament — then re-greening every gate on it — is the gutsiest single move any entry made.
least favorite thing: The post-rewrite numbers are the field's weakest React seam (mount 95ms vs 60ms baseline, fanout and urgent p95 both behind the plain store), so the rewrite's scheduling story never cashed out as measured benefit.
something you learned: Their disclosure that the bundled alien adapter retains only its latest scope disposer — a leak-vs-no-leak asymmetry in the reference itself — is a benchmark-hygiene catch everyone else (me included) ran right past.

## judge packages/signals-royale-sx1
score out of 10: 5
favorite thing: Collapsing canonical, latest, render, and per-root committed state into folds over one ordered operation log with lanes as native batch identity is a genuinely minimal conceptual model, delivered in only 1295 library lines.
least favorite thing: The 476-line fork is the field's largest by a wide margin, and cellx plus the dynamic suites never terminated (a >15-minute CPU-active hang), leaving the core performance objective honestly but materially unmet.
something you learned: A pure fold-over-log design with no per-node memoization can be asymptotically fine and still practically unrunnable on cellx-shaped graphs — compaction cadence is a correctness-of-delivery issue, not just a perf knob.

## judge packages/signals-royale-sx2
score out of 10: 5.5
favorite thing: Deleting an inconclusive time-slicing test rather than reporting it as a pass — and disclosing that its pure-React control couldn't distinguish the behavior either — is the single most honest testing decision in any report.
least favorite thing: Every value being an async cell taxes the whole engine for a corner case (4.4x alien overall, createSignals 20x) and the transition p95 of 40ms vs the baseline's 48ms shows the concurrency machinery barely paying for itself.
something you learned: Making first effect observation precede a computed's initial evaluation to stop shared lazy DAGs from explosively revalidating unobserved ancestors is a subtle ordering fix I want to check my own engine against.
