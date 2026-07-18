# Correctness review — round-05 `design-surgical-b`

## 1. BLOCKER — architectural: pin-only evaluator visibility tears a lagging root

Receipt visibility depends on the pass mask, pin, and per-root lock view ([design:72](/Users/jitl/src/alien-signals-opt/design-loop/rounds/round-05/design-surgical-b.md:72)). Evaluator visibility instead uses only `promotedAtSeq <= world.pin`, and committed-for-root reads always use the latest version ([design:90](/Users/jitl/src/alien-signals-opt/design-loop/rounds/round-05/design-surgical-b.md:90)). A pin orders events but does not prove that a pass includes the batch that produced an evaluator promotion.

Setup: shared stageable computed `c`; evaluator `e0` returns `1`, evaluator `e1` returns `10`. Root A owns the hook; root B has existing watcher `W_old` showing `1`. Transition T changes A to `e1` and spans both roots.

| step | actor/mechanism | state touched |
|---:|---|---|
| 1 | T renders A | `e1` is staged; R3/promotion delivery queues `W_old` in T |
| 2 | root A commits before B | F9 publishes `e1` at `s`; A locks T, but B’s lock view still excludes T; `W_old` remains DOM `1` |
| 3 | urgent U renders root B before its T work | U excludes T; its pin `q > s`; U mounts fresh watcher `W_new` while memoized `W_old` skips its pending T update |
| 4 | `W_new` reads `c` | no B-local stage exists, so `effectiveStamp` selects globally published `e1` solely because `s <= q`; K0 or world evaluation returns `10` |
| 5 | U commits B | `W_old=1`, `W_new=10`; both display the same shared computed in one committed root |
| 6 | mount fixup | `W_new` already equals latest `committedForRoot(B)=10`, so fixup schedules nothing; queued T delivery repairs `W_old` only later |

Outcome: root B paints a torn frame. This violates the required per-root self-consistency while exercising the design’s declared full-spanning scope. The design explicitly permits publication delivery to happen later ([design:173](/Users/jitl/src/alien-signals-opt/design-loop/rounds/round-05/design-surgical-b.md:173)), so the delivery walk is not a barrier against this schedule.

Repair requires evaluator versions to carry batch/root visibility and be selected using the pass mask and root lock watermark, not chronology alone. Prior versions must also remain retained while any consuming root has not admitted the promotion. Add an integration test combining cross-root F9 publication, a lagging root, and an urgent mount that excludes the spanning transition.

## 2. BLOCKER — local specification fix: the submitted normative design is outside the review boundary

The artifact declares that its complete normative design is the round-4 synthesis ([design:3](/Users/jitl/src/alien-signals-opt/design-loop/rounds/round-05/design-surgical-b.md:3)), which the reviewer prompt explicitly forbids reading. Its C1–C17 closure is only a table of “unchanged” assertions ([design:428](/Users/jitl/src/alien-signals-opt/design-loop/rounds/round-05/design-surgical-b.md:428)), despite the acceptance battery requiring every case to be walked mechanism-by-mechanism ([correctness-cases:3](/Users/jitl/src/alien-signals-opt/design-loop/SEEDS/correctness-cases.md:3)).

Concrete C2 schedule demonstrating the missing normative branch:

| step | actor/mechanism | state touched |
|---:|---|---|
| 1 | default D writes `a=1` | receipt logged; newest K0 may hold `a=1`, `c=a+10=11` |
| 2 | `flushSync` pass S starts | S excludes D; atom folding reconstructs `a=0` |
| 3 | S reads plain computed `c` | its evaluator basis is empty, so new `EB0` is vacuously true |
| 4 | K0 routing | correctness now depends entirely on the undefined “inherited K0 gates” |
| 5 | wrong branch not excluded by this artifact | serving K0 yields `c=11` beside `a=0` |

Outcome: the submitted text contains no reviewable mechanism that rules out the C2 torn frame. The external base may contain such a gate, but incorporating that complete normative text is required before this artifact can receive correctness credit. This is locally repairable by supplying a merged, self-contained design rather than changing the architecture.

## Verified held

Within the mechanisms actually specified here, I attacked and could not break:

- S5-R1-A’s original old-pass leak: after K0 is recomputed under a post-pin evaluator, exact flattened-basis comparison correctly routes the old pass to its pinned version.
- Nested evaluator bases and equal-output promotions: flattening propagates the relevant stamp, and stamp comparison does not incorrectly disappear behind value equality.
- S5-R12-A’s stated retirement window: once execution reaches committed-side fixup, deleting `commitBaseline` forces the final comparison and repairs that schedule.
- R2’s same-slot post-pin continuation write: retained started/uncommitted pass metadata prevents suppression and preserves the later T update.
- R3’s same-root earlier-consumer and A/B/A schedules: stage-change walks plus lineage seeding force finite restarts for stable selections.
- R4’s stated late-edge schedule: K’s original walk puts W on `touchedList[K]`; retained D bits propagate through the later K1 edge, and K’s lock advance reconciles W.
- R8’s stated single-boundary rewrite: discarding WIP before a monotone rewrite preserves comparisons in the enumerated schedule.
- R9’s repeated same-world atom reads: the fold memo returns one reference and installs that reference when the committing prefix matches.
- C7’s yield-gap callstack distinction: F2 yield/resume facts keep event-handler reads and writes out of the paused pass world.

## Verdict

The design is architecturally unsound as submitted. The exact-basis gate repairs the old-pass K0 leak and deleting `commitBaseline` repairs its stated mount race, but pin-only evaluator promotion still permits a torn committed frame on a lagging root. Implementation should not begin until evaluator visibility is batch- and root-aware and the complete C1–C17 normative design is supplied in the reviewable artifact.

