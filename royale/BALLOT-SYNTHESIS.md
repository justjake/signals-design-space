All 12 ballots and the candidate lookup are read and parsed — 132 score lines, all complete. Here is the synthesis.

---

# Signals Royale — Peer Ballot Synthesis

## 1. Score matrix

Rows = judged entry (ranked by mean), columns = judge. 12 judges × 11 ballots = 132 scores; each judge skipped their own entry (—).

| Rank | Entry | fh1 | fh2 | fm1 | fm2 | fx1 | fx2 | sh1 | sh2 | sm1 | sm2 | sx1 | sx2 | **Mean** | Median | Min | Max |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **fh2** (fiber-granular subs) | 9 | — | 9 | 9 | 7.5 | 8.5 | 8.8 | 9.3 | 9.1 | 9.0 | 9.4 | 9.3 | **8.90** | 9.0 | 7.5 | 9.4 |
| 2 | **fx2** (zero-fork ceiling, 11-line fork) | 9 | 9 | 9.5 | 9 | 9 | — | 8.2 | 8.9 | 8.6 | 7.6 | 8.7 | 8.7 | **8.75** | 8.9 | 7.6 | 9.5 |
| 3 | **fh1** (version-stamp predicates) | — | 8.5 | 9 | 8.5 | 8 | 8 | 8.7 | 9.1 | 9.3 | 8.8 | 9.1 | 9.1 | **8.74** | 8.8 | 8.0 | 9.3 |
| 4 | **fx1** (inverted scheduler) | 8 | 8 | 9 | 8 | — | 7.5 | 8.8 | 9.1 | 9.4 | 9.2 | 9.0 | 9.1 | **8.65** | 9.0 | 7.5 | 9.4 |
| 5 | **fm2** (minimal host, 48-line fork) | 8.5 | 8.5 | 9 | — | 8 | 7.5 | 8.1 | 8.7 | 8.9 | 7.1 | 8.8 | 8.9 | **8.36** | 8.5 | 7.1 | 9.0 |
| 6 | **fm1** (snapshot worlds / rebase logs) | 7.5 | 8 | — | 7.5 | 7.5 | 7 | 8.3 | 8.5 | 8.7 | 8.3 | 8.6 | 8.8 | **8.06** | 8.3 | 7.0 | 8.8 |
| 7 | **sh1** (STM transactions) | 6 | 6.5 | 7 | 6.5 | 7 | 6 | — | 8.3 | 8.0 | 6.5 | 7.8 | 9.0 | **7.15** | 7.0 | 6.0 | 9.0 |
| 8 | **sm2** (batch capsules, fork rewrite) | 6 | 6.5 | 6.5 | 6 | 6 | 5.5 | 7.8 | 8.1 | 7.4 | — | 7.4 | 8.5 | **6.88** | 6.5 | 5.5 | 8.5 |
| 9 | **sx2** (async-first cells) | 6 | 6 | 6.5 | 5.5 | 6 | 5.5 | 7.4 | 7.9 | 7.0 | 7.3 | 8.0 | — | **6.65** | 6.5 | 5.5 | 8.0 |
| 10 | **sh2** (bitmask slab) | 6.5 | 6.5 | 6.5 | 6 | 5.5 | 6 | 6.5 | — | 7.0 | 5.9 | 6.9 | 7.5 | **6.44** | 6.5 | 5.5 | 7.5 |
| 11 | **sm1** (commit-boundary repair) | 5.5 | 5.5 | 5.5 | 5.5 | 5 | 5 | 6.7 | 7.2 | — | 6.7 | 7.2 | 7.4 | **6.11** | 5.5 | 5.0 | 7.4 |
| 12 | **sx1** (event-sourced log) | 5 | 5 | 5 | 5 | 5 | 4.5 | 6.2 | 6.6 | 6.1 | 5.2 | — | 6.8 | **5.49** | 5.0 | 4.5 | 6.8 |
| | **Mean given by judge** | 7.00 | 7.09 | 7.50 | 6.95 | 6.77 | 6.45 | 7.77 | 8.34 | 8.14 | 7.42 | 8.26 | 8.46 | **7.51** | | | |

**Judge tendencies** (field mean 7.51):
- **Systematically high:** sx2 (8.46, +0.95), sh2 (8.34, +0.82), sx1 (8.26, +0.75), sm1 (8.14, +0.62).
- **Systematically low:** fx2 (6.45, −1.06), fx1 (6.77, −0.74), fm2 (6.95, −0.56), fh1 (7.00, −0.51).
- **Cohort skew is the real signal:** every fable judge averages at/below the field mean (cohort mean 6.96); every sol judge except sm2 averages above it (cohort mean 8.07). The asymmetry is largest toward sol entries: sol judges gave sol entries 7.21 on average vs 5.82 from fable judges (+1.39); the gap on fable entries is only +0.45 (8.78 vs 8.33). Crucially, the bias is in level, not ordering — **both cohorts independently rank all six fable entries above all six sol entries**.
- Fable judges scored in 0.5 steps; sol judges in 0.1 steps (hence 8.7s and 9.3s).

## 2. Peer favorite / peer least favorite per entry

### fh2 — 8.90 (rank 1)
**Favorite:**
- Lanes ARE the batch keys — batch lifetime is lane lifetime, so quiescence reclamation holds by construction with no mirrored lane-to-batch bookkeeping (~7 ballots).
- Best measured perf of the heavyweights (1.28x geomean) riding an untouched alien-v3-shaped canonical graph through the narrow worldHooks seam; strongest rigor overall.
- fm2: *"Making React's lanes literally BE the batch keys — a batch's lifetime is its lane's lifetime — deletes the entire lane-to-batch mirroring layer I and most others carried."*

**Least favorite (unanimous, 11/11):**
- The 2,733–2,740-line library — largest in the field — and the fiber-granular per-component subscription machinery's 10–25% mount tax.
- sh2 adds that its own transition scenario "admittedly cannot separate the contenders," so the headline benefit is pinned only by gates.
- fh1: *"Fiber-granular subscription (uSES + forcer + committed-view effect per component instance) makes it the largest library of the field at 2733 LOC and taxes every mount 10-25%."*

### fx2 — 8.75 (rank 2)
**Favorite:**
- The 11-line fork with a per-line "why this cannot be userland" ledger — all 11 ballots cite it; several call it the tournament's defining result.
- SignalScope reducer dispatch: React's own updater queues carry world membership, so lane bookkeeping doesn't exist in the fork — and it still posts 1.28x alien.
- fm1: *"The 11-line fork is the intellectual result of the tournament — dispatching draft ids into a SignalScope reducer inside the owning startTransition so React's own updater queues carry the world, leaving only the mutation window as irreducible fork surface."*

**Least favorite (unanimous, 11/11):**
- The residual `latest()` tear: a plain `latest()` in a pass where no fx2 hook rendered first resolves the previous pass's world — the structural price of having no seam at all.
- The mutation-window stop lacks a `finally` guard (sh1, sm1).
- fh2: *"a live correctness corner closed by documentation rather than mechanism."*

### fh1 — 8.74 (rank 3)
**Favorite (11/11):**
- Worlds as pure visibility predicates (cutoff seq + deferred-batch list) over per-signal write histories — zero world tables or overlay stores to reclaim; per-root committed views collapse to latched cutoffs, nearly free.
- fm2: *"the cleanest zero-table formulation of the concurrent model in the field."*

**Least favorite:**
- The `latest()` context rule shipped broken in two contexts and was claimed done — caught only by the judge (fh2, fm2).
- The resumed-pass staleness hole for unsubscribed atoms is waved off by leaning on React restarting the pass (~7 ballots).
- fh2: *"The judge had to catch `latest()` being flatly wrong in two whole contexts (canonical computed evaluations and render bodies) after section 5 had already claimed it done."*

### fx1 — 8.65 (rank 4)
**Favorite (11/11):**
- The lane claimed once and pinned on the transition object (`transition._signalLane`), so originals, corrective joins, and async settlements share one commit — through only an 80-line fork.
- Best demonstrated urgent-under-transition latency in the field (5.3–5.6ms p95 vs 77–97ms baseline).
- fm1: *"Pinning the claimed lane on the transition object itself (transition._signalLane) so every delivery, corrective join, and owned settlement rides one lane is a tight 80-line fork with the strongest react-bench transition story (5.3ms vs 77ms p95)."*

**Least favorite:**
- Two required features (latest() context rule, in-transition refresh()) claimed done with zero test coverage until judge probes broke both (5 ballots).
- 2,343-line library heavy with episode/frame/async-context machinery; topology-only isPending knowingly over-reports (4 ballots).
- fh2: *"Both judgement defects — the `latest()` render-body tear and the silently swallowed in-transition `refresh()` — were features claimed done with zero test coverage behind them."*

### fm2 — 8.36 (rank 5)
**Favorite (11/11):**
- The 48-line one-file inert host protocol; hooks hold only a bump counter and re-read the engine in the render body; running all 76 upstream react-reconciler suites (1,140 tests) as the adjacency gate.
- fh1: *"a genuinely beautiful minimal seam, and running all 76 react-reconciler suites (1140 tests) as adjacency is the strongest fork-hygiene evidence in the field."*

**Least favorite (10/11):**
- A root unmounted with a parked transition strands its engine batch on a dead lane — a disclosed but real leak against the never-leak rule; plus a value-equal retirement poke render per subscriber per transition.
- sm2 (its lowest score, 7.1): *"Unmounting a root with a parked transition can leave its batch live indefinitely, which violates the tournament's quiescence and no-leak contract."*

### fm1 — 8.06 (rank 6)
**Favorite (10/11 as favorite):**
- Value-aware edge polling — each edge remembers what its consumer saw, so write-then-revert batches provably propagate nothing; plus the most honest debugging narrative in the field (the re-entry audit).
- fh1: *"a semantics win that most engines only approximate with equality cutoffs."*

**Least favorite (~9/11):**
- The judgement fix that shipped its own regression: a module-global suppression flag silently un-logged unrelated urgent writes fired from effect flushes, requiring a second fix round.
- Committed views remain weaker for computeds and long-idle roots (sh1, sm1, sx1).
- fx2: *"The first judgement fix introduced a worse bug than it fixed: a module-wide suppression flag stayed set across the depth-0 effect flush and silently dropped unrelated urgent writes from the rebase log."*

### sh1 — 7.15 (rank 7)
**Favorite:**
- Smallest library in the field (~1,217 LOC) plus a 94-line fork, still clearing the full battery, with a genuinely tidy STM framing and named, honest gap disclosures.
- sm1: *"At 1,217 library lines and 94 fork lines, SH1 covers an astonishing amount of the required surface with readable machinery."*

**Least favorite:**
- Correctness arrived from outside — the battery found five gaps, the judge three more, with semantics (write-during-render guard, flushSync composition) living in the verification adapter instead of the library (3 fable ballots).
- ~3.93x alien with the thin 16-test real-React gate; isPending can evaluate/refetch and fresh inline promises lack stable retry identity (sm1, sm2, sx1).
- fh1: *"Correctness kept arriving from outside — the shared battery found five real gaps and the judge found three more, including semantics (write-during-render, flushSync composition) living in the verification adapter instead of the library."*

### sm2 — 6.88 (rank 8)
**Favorite:**
- The voluntary mid-tournament fork rewrite — discarding the incumbent-derived 1,510-line fork for a 186-line lane-fact protocol and re-greening every gate — repeatedly called the gutsiest move in the field (~6 ballots).
- It audited the referee: disclosed that the bundled alien benchmark adapter retains only its latest scope disposer, a leak asymmetry in the reference itself.
- fm1: *"Voluntarily throwing away a working incumbent-derived 1510-line fork and rewriting to a 186-line lane-fact protocol late in the tournament was the gutsiest single move in the field, and it landed green."*

**Least favorite:**
- Post-rewrite React numbers lose every row to the plain uSES store baseline (~8 ballots); it rode the incumbent-derived fork through the main rounds (fm2, fx2).
- Capsules overwrite rather than compose across overlapping batches (sm1, sx1).
- fx1: *"The post-rewrite seam numbers lose every row to the plain-store baseline (fanout 3.01 vs 2.16, urgent p95 7.67 vs 5.99, mount 95 vs 60 ms), which undercuts the reason a signals fork exists."*

### sx2 — 6.65 (rank 9)
**Favorite:**
- "Every value is an async cell" — pending, error, stale-refresh, and drafts unified in one record with a settled-sync fast path; the only entry to win transition p95 vs baseline, via a 112-line fork.
- Testing honesty: deleted an inconclusive time-slicing test after its pure-React control failed the same way (4 ballots single this out).
- fh2: *"'Every value is an async cell' collapses pending, error, stale-refresh, and transition drafts into one record with settled-sync as the compact fast path — the most unified data model in the field."*

**Least favorite:**
- The unification taxes every hot path: 4.44x alien overall, createSignals ~20x (~9 ballots); plus the thinnest real-React gate of all twelve entries (13–14 tests).
- fm1: *"which is the design's thesis failing its own benchmark — the async generality taxes every synchronous op."*

### sh2 — 6.44 (rank 10)
**Favorite:**
- The only genuinely different memory architecture: typed-array node slab + intrusive edge arena (effectively 11/11); the only entry to beat alien anywhere (createSignals 0.35x).
- Exemplary honesty — the self-graded PARTIAL on its own leak audit (fh1, fm1).
- fh1: *"the report's self-graded PARTIAL on its own leak audit is the most honest single cell in any gate table I read."*

**Least favorite (effectively 11/11):**
- A permanently abandoned batch can retain its overlay forever — the rollback/quiescence contract is explicitly unproven; plus disclosed partials (committed(computed) canonical fallback, async transform gaps). fx2 also caught "a stray machine memory-citation block" leaked into the report.
- fh1: *"which in my book is a leak, not a caveat."*

### sm1 — 6.11 (rank 11)
**Favorite (~8/11):**
- The RULES dispute — proving the two updater-order examples contradicted each other with arithmetic, earning the tournament's erratum; the single sequence-ordered op log where retirement flips visibility, never position.
- fh1: *"disputed it with arithmetic instead of coding around the battery, and earned the tournament's erratum — the best adjudication work in the field."*

**Least favorite:**
- The false green claim: Round 2 reported the battery typecheck passing over 24 real TS errors — all six fable judges cite it; several as the deciding factor.
- 6.2–6.55x alien plus the field's second-largest fork (320 lines) — the weakest perf/size/accuracy combination among finishers.
- fx2: *"A gate was reported green that never ran green (Round-2 battery typecheck, 24 TS2322 errors) — corrected forthrightly, but a false PASS is the one unforgivable report defect."*

### sx1 — 5.49 (rank 12)
**Favorite:**
- Radical model unity — canonical, latest, render, and committed as four folds over ONE ordered op log (~9 ballots); and its refusal to fabricate a ratio when cellx wouldn't finish.
- fm1: *"conceptually the purest design here, and the report's refusal to fabricate a ratio when cellx would not finish is honest to a fault."*

**Least favorite (11/11 on cellx; 10/11 on fork size):**
- cellx and the dynamic suites never finished — a child spun CPU-flat for 15+ minutes — so the required overall performance ratio does not exist; and the 476-line fork is the field's largest on the tournament's top-ranked objective.
- fh1: *"the required overall performance ratio simply does not exist, and the fork is the field's largest at 476 lines."*

## 3. Cross-cutting: the tournament's five organic lessons

Tallied across all 132 "something you learned" lines:

1. **React already contains the concurrency machine — let its lanes and updater queues carry batch/world identity** (14 lines, split across the fh2 and fx2 sections). All six sol judges took the fx2 lesson that reducer state/context can transport world membership; fable judges took the fh2 lesson that lane lifetime = batch lifetime kills retirement bookkeeping. fh1: *"episodic reclamation happens by construction with no engine-side retirement bookkeeping to leak."*
2. **Layout effects are free ground truth for committed views** (8 lines, all about fm2) — they only run for renders that actually commit, so per-root committed-view recording is correct by construction at zero write-path cost. (fh2, fx2, sh1, sh2, sm1, sm2, sx1, sx2.)
3. **A world is a cutoff plus a visible-batch predicate, not a materialized table** (8 lines, all about fh1) — committed() becomes a latched cutoff over per-signal history rather than a copied store. (fm1, fx1, sh1, sh2, sm1, sm2, sx1, sx2.)
4. **Re-entrancy discipline: replay-suppression flags must be per-atom, one-shot, and consumed before synchronous user code can re-enter** (7 lines, all about fm1's regression) — because a depth-0 set() runs arbitrary effects before it returns.
5. **Global dispatch order is sacred: retirement may flip visibility, never position** (7 lines, about sm1/fh1) — sh1's inverse phrasing: *"Keeping urgent and deferred operations in separate groups silently destroys global updater-queue order even when each group is internally ordered."*

Near-misses worth recording: observed-before-first-evaluation prevents exponential lazy-DAG revalidation (6, about sx2); FinalizationRegistry must be armed by ownership, not creation, or GC kills live effects (5 — all five other fable judges took this from fx2); commit-stop must follow layout effects (5, about sm2); slab layout makes creation cheap but never makes propagation fast (5, about sh2); correctness suites measure nothing about complexity class (4, about sx1); audit the referee — the bundled alien adapter has its own disposer leak (4, about sm2).

## 4. Disagreements worth reading

1. **sh1 — spread 3.0** (6.0 from fh1/fx2 vs 9.0 from sx2): the judges split on whether the field-smallest 1,217-line full-coverage library is the achievement (sol judges) or whether correctness that had to be dragged out of it by the battery and judge — with semantics living in the verification adapter — hollows the compactness out (all six fable judges scored 6–7).
2. **sm2 — spread 3.0** (5.5 from fx2 vs 8.5 from sx2): the mid-tournament fork rewrite is read as either redemption (an honest architectural correction that re-greened every gate) or indictment (it rode an incumbent-derived 1,510-line fork through the main rounds, and the rewrite never cashed out — losing every react-bench row).
3. **sx2 — spread 2.5** (5.5 from fm2/fx2 vs 8.0 from sx1): the async-cell unification is either the most coherent data model in the field with the only transition-p95 win, or a thesis that "failed its own benchmark" at 4.44x/20x with the thinnest real-React gate.

Runner-up: **sm1 — spread 2.4** (5.0 from fx1/fx2 vs 7.4 from sx2) — fable judges treated the false-green typecheck claim as near-disqualifying; sol judges scored the corrected final model on its merits.

## 5. Ballot hygiene

Overall very clean:
- **Complete:** all 12 ballots contain exactly 11 sections with all four fields; 132/132 score lines parsed; no missing entries.
- **No self-judging:** every ballot correctly omits its own entry.
- **All scores in range:** observed span 4.5–9.5; no values outside 0–10.
- **One format deviation:** `fm1.md` is the only ballot with an extra title header (`# Peer ballot — filed by fm1`), making it 67 lines vs everyone else's 65. Trivial.
- **Systematic skew, not violation:** the fable-vs-sol cohort scoring gap (Section 1) — sol judges run +1.1 hotter on average and +1.39 hotter specifically on sol entries — is worth a note in the final report, though both cohorts produce the same fable-over-sol ordering, so no entry's rank hinges on it.

Source files: `/Users/jitl/src/alien-signals-opt/royale/ballots/{fh1,fh2,fm1,fm2,fx1,fx2,sh1,sh2,sm1,sm2,sx1,sx2}.md`, context from `/Users/jitl/src/alien-signals-opt/royale/CANDIDATES.md`.
