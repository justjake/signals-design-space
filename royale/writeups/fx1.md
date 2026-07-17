# fx1 — Store claims lanes, owns episodes

## How it works

One canonical base per atom plus a tagged update queue; each write is an op stamped with a global writeSeq and an episode (null = urgent). Classification happens at write time by reading ReactSharedInternals.T: a non-null transition token maps to an engine episode, and the runtime calls the fork's claimTransitionLane (requestTransitionLane(null)) once, pinning it on token.\_signalLane. Deliveries wrap the hook's setState bump in internals.T = episode.token, so React routes it to the pinned lane — the fork's only behavioral change is requestTransitionLane honoring the pin; its other lines just report facts (onPassStart, onCommit, mutation window, getWorkInProgress/isRendering). Renders read through an MVCC frame — base pinned at a writeSeq plus the episodes whose lanes React reported at pass start — replaying ops in scheduling order (urgent ×2 over pending +2 on 1 shows 2, then 6). Episodes retire when every delivered root commits, or by engine microtask if never delivered; retirement rebases ops onto today's base and drops the log.

## Advantage

The fork is 80 lines against the incumbent's 1510 — the field's standout ratio — because lane grouping is an identity property, not a protocol: anything dispatched under the token, whenever, lands in the episode's commit. Corrective joins for mid-transition mounts, async settlements the episode owns, and interleaved React setState in the same scope cohere with no extra machinery; tear-freedom falls out of frame pinning. Judge-flagged steals: episode auto-retire, value-stamped edges (write-then-revert nets to nothing), adopt-world-contexts-at-retirement (commits never refetch).

## Disadvantage

Worst: every read funnels through frame/fold machinery and node construction carries episode bookkeeping — creation suites run 4–7x alien. Second: complexity concentrates defects at fast-path × rare-feature intersections; both judged bugs (latest() tear, transition refresh() no-op) lived exactly there, and a latent retirement edge still does. Third: it leans on private surface — swapping ReactSharedInternals.T plus a \_signalLane expando — and inherits the 15-lane pool, so a long-lived episode can entangle with a later transition's commit.

## Room for optimization

CI shows 1.426x alien overall (self-reported geomean 1.58x). Several suites already at parity, so the gap is concentrated: createComputations 6.97x, cellx2500 6.12x (construction), propagation 1.3–1.8x. Levers: (1) cheap computed/effect construction — defer ctx/slot/edge materialization until first episode or async use, attacking the 7x suites directly; (2) collapse the poll-then-eval double graph walk and effect-queue bookkeeping (entrant's own profile: next ~30%); (3) a no-episode fast path — with cellsWithQueues empty, a read should be a bare base load, skipping foldQueue.

## Bugginess

Final verdict clean after the fix round. Round 1 found two confirmed feature violations no shared test covered (latest() render-body tear; transition refresh() silently swallowed); fixes verified failing pre-fix, +6 regressions. Judge re-ran everything green: engine 198/198, React 29/29, shared battery 25/25, fork protocol 8/8, upstream-adjacent 121 passed/1 upstream skip, leak audits 6/6, 1200-seed oracle sweep. One latent engine-API-only retirement edge remains, unreachable through the shipped React surface. Confidence: high on the seam; watch the async fine print.
