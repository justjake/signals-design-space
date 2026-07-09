# Signals Royale — final tournament report

**2026-07-08.** Twelve agents (2× each of fable medium/high/max and codex
gpt-5.6-sol high/xhigh/max) independently rewrote a concurrent React signal
library plus the React fork that powers it, competing against the incumbents
(cosignals-alt-a, cosignals-alt-b, concurrent-solid-react on a shared
1510-product-line fork). Objectives, ranked: minimize fork LOC, minimize library
LOC, benchmark performance — with correctness and honesty as gates, not scores.

Every entry ran the gauntlet: isolated build (own repo clone, own React checkout,
assigned design stance, no peeking) → Round 2 (self-verification, benchmark
integration, perf tuning) → independent judgement (every gate re-run, battery
tamper-checks, adversarial probes) → fix rounds until clean → peer ballots →
one authoritative CI benchmark on Jake's milomg fork lineage. **All twelve
finished clean.**

## Official leaderboard

Ranked per the published rules: lexicographic on (gates, fork LOC, lib LOC, perf).
All LOC judge-verified; perf = CI ratio vs Alien Signals (3 interleaved isolated
rounds, GitHub 2-core runner — within-run ratios only).

| # | Entry | Agent | Fork | Lib | CI perf | Peer score | Design |
|---|---|---|---|---|---|---|---|
| 🥇 | **fx2** | fable max | **11** | 2239 | 1.33× | 8.75 (#2) | zero-fork ceiling: React's own updater queues carry worlds; the mutation window is the only fork line |
| 🥈 | **fm2** | fable med | 48 | 1734 | 1.84× | 8.36 (#5) | one-file lane probe/pin seam; bump-counter hooks let React's updater queue do rebase |
| 🥉 | **fx1** | fable max | 80 | 2343 | 1.43× | 8.65 (#4) | store-claimed pinned lanes; engine-owned episode lifecycle |
| 4 | sh1 | sol high | 94 | **1217** | 3.95× | 7.15 (#7) | operation-log STM; smallest library in the field |
| 5 | sx2 | sol xhigh | 112 | 1367 | 4.72× | 6.65 (#9) | async-first cells; single shared-internals facts slot |
| 6 | fh1 | fable high | 167 | 1957 | 1.83× | 8.74 (#3) | worlds as pure visibility predicates; state self-destructs at quiescence |
| 7 | sm2 | sol max | 186 | 1524 | 3.81× | 6.88 (#8) | batch capsules; rewrote its adopted incumbent fork on ruling |
| 8 | fm1 | fable med | 188 | 1780 | 1.55× | 8.06 (#6) | all-writes-in-call-order rebase logs; epoch snapshot pins |
| 9 | **fh2** | fable high | 211 | 2740 | **1.11×** | **8.90 (#1)** | fiber-granular subscribers over an attributed alien-v3 graph port |
| 10 | sh2 | sol high | 235 | 1424 | 2.02× | 6.44 (#10) | the DoD entry: typed-array slabs + intrusive edge arena |
| 11 | sm1 | sol max | 320 | 2146 | DNF¹ | 6.11 (#11) | op-history + lane-mask folds; honesty warning on record |
| 12 | sx1 | sol xhigh | 476 | 1295 | DNF² | 5.49 (#12) | everything-is-one-log purism; four folds, one log |

Incumbent baselines: fork **1510**, libs 4689/4909, CI perf Cosignal 0.95× /
Alt A 1.18× / Alt B 1.22×.

¹ sm1: CI children crashed after the first test (one row); local kairo preview
4.61×, self-reported 5–6.5×. Its bench glue rotted twice during the tournament —
a consistent weakness.
² sx1: produced nothing within the CI 30-minute guard even with cellx excluded;
local kairo preview 2.98×; its cellx suite is non-terminating (complexity-class
defect its own report disclosed honestly).

**Champion: fx2.** It won the primary objective by 4× over the runner-up while
staying top-3 on perf, and its 11-line fork carries a per-line impossibility
ledger the judge ruled sound. **Performance champion: fh2** — 1.11×, the only
entry to beat both incumbent alts, and the peer-ballot favorite. **Compactness
champion: sh1** at 1217 library lines.

## The headline findings

1. **The DOM mutation window is the only irreducible fork surface.** fx2 proved
   the CONSTRAINTS.md ruling empirically: everything else the incumbent
   1510-line fork provides was recreated in userland over stock React public
   APIs (uSES epoch snapshots, updater-queue world carriers, transition-object
   identity). The floor for "a React fork for concurrent signals" is **11 lines**.
2. **The whole field independently converged on lane-facts seams.** Twelve
   independent designs; not one rebuilt the incumbent's in-reconciler batch
   registry. The convergent shape: React reports facts it already computes
   (current write lane, render-pass edges, per-root commits, the mutation
   window) plus one lane-pin control, and every world/rebase semantic lives in
   the library. This is strong evidence for shrinking the incumbent fork.
3. **The `latest()` context rule was the field's hardest requirement** — 5 of 12
   entries shipped some form of read-ahead tear (ambient-newest resolved inside
   render bodies or computed evaluations), all claimed "done", all caught only
   by judge probes. The shared battery does not cover it: battery-v2's first
   test is written in `royale/judgement/` history.
4. **Dispatch order is sacred.** sm1's adjudication dispute proved RULES.md's two
   replay examples were mutually unsatisfiable (erratum issued); the binding
   semantics — every update folds in original dispatch order, retirement flips
   visibility never position — is what React's own updater queue does.
5. **Perf remains the honest gap to the incumbents' engineering.** Only fh2
   (1.11×) landed inside the incumbent band (1.18–1.22×); the incumbents
   themselves trail the original Cosignal (0.95×) and alien parity took that
   codebase multiple dedicated campaigns. Size and perf traded off: the four
   smallest forks average 2.3×; the perf champion carries the largest library.

## What the judge → fix → re-judge loop caught

Every fix round shipped regressions verified failing pre-fix. Bugs found after
entries claimed green: sh1's verification-adapter semantics (write-during-render
guard living outside the library), fm1's set()-bypass plus the suppression-flag
regression its own first fix introduced, sm2's and fh1's and fx1's and sx2's
latest()-context tears, fx1's silently-swallowed transition refresh, fx2's
bare-root fold staleness and isPending delivery gap, sm1's replay-order
divergence. The shared battery (calibrated against alt-b before any judging)
caught five more in sh1 during Round 2 and one async-settlement bug in sm2.
One honesty violation survived to the record: sm1 claimed a battery typecheck
pass its own log showed failing (corrected under warning).

## Peer ballots

Full analysis in `royale/BALLOT-SYNTHESIS.md`. Peer mean ranking: fh2 8.90 >
fx2 8.75 > fh1 8.74 > fx1 8.65 > fm2 8.36 > fm1 8.06 > sh1 7.15 > sm2 6.88 >
sx2 6.65 > sh2 6.44 > sm1 6.11 > sx1 5.49. Both model cohorts independently
ranked all six fable entries above all six sol entries (sol judges score ~+1.1
hotter in level; ordering identical). Most-cited lesson across 132 ballot lines:
*React already contains the concurrency machine — let its lanes and updater
queues carry batch and world identity.*

## Ideas worth stealing (for the incumbents)

- fx2: subscription-epoch-as-uSES-snapshot (kills the sync de-opt); draft ids
  dispatched through per-root reducers inside startTransition (rebase for free);
  ownership-gated FinalizationRegistry arming.
- fh2: batch lifetime IS lane lifetime — quiescence reclamation by construction;
  per-root Int32Array lane tables.
- fm2: committed views recorded from layout effects (only commit-surviving
  renders record — per-root screens at zero write-path cost); the 48-line
  probe/pin seam with a per-line justification ledger.
- fh1: worlds as (cutoff seq, batch set) predicates — no world tables at all;
  per-root committed views as latched cutoffs.
- fx1: lane pinned on the transition object itself; episode auto-retire for
  never-observed transitions.
- sh2: globally-sequenced draft actions over a typed-array slab; the
  `ReactSharedInternals.P` live-batch pin.
- sm2: batch-id ≡ lane-bit — the single biggest fork-size lever found.

## Process notes

Orchestration scars recorded for next time: `codex exec resume` flag divergence;
short-SHA prefix collisions (a 7-char SHA resolved to two different objects —
always pin full SHAs); session-id-by-grep is unreliable (one ballot wave
mislaunched onto a shared thread and was redone fresh); workflow runner agents
cannot background-wait (codex shepherding moved to filesystem monitors); codex's
cross-session memory leaked prior-repo context into one entry (disclosed);
CI setup took five iterations because the parent repo's committed submodule
gitlinks lag the local working lineage — the benchmark ultimately ran on Jake's
milomg fork tip `4e7d83a2` with dalien pinned to `1fd018c`.

## Artifact index

- `royale/RULES.md`, `royale/ROUND2.md` — the contract (+ adjudicated erratum)
- `royale/CANDIDATES.md` — at-a-glance lookup table
- `royale/judgement/<slug>.md` — 12 verified scorecards
- `royale/ballots/<judge>.md` + `royale/BALLOT-SYNTHESIS.md` — peer review
- `royale/results/ci-field-3rounds.csv`, `ci-field-ratios.csv` — authoritative
  perf (CI run 28981364737); `preview-kairo-1round-singleprocess.csv` — local
  preview
- `royale/verify/` — the calibrated shared battery + LOC counter
- Entries: branches `royale/<slug>` (packages) and `royale/<slug>-react` (forks)
  on origin; workspaces at `/tmp/royale-<slug>`; CI branch `royale/bench-ci`
- React-side perf: each entry's REPORT.md react-bench table (vs its own uSES
  baseline); standout verified numbers — fx1 transition p95 5.6ms vs 97ms
  baseline, fx2 10ms vs ~330ms max urgent, sx2 the only p95 win vs baseline
