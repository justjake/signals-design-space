# The design loop: co-designing the React fork + signals library

Goal: converge on one design for three coupled artifacts —

- **React fork** — minimize size, maximize maintainability;
- **signals library** — maximize elegance, performance, correctness; minimize size;
- **the seam** — minimize signals-library change when the fork rebases onto new React.

"Elegance" is measured, not felt: fewest cooperating mechanisms that walk every
case in `SEEDS/correctness-cases.md`, smallest seam, one-page-explainable
concurrency story, gates stated as numbers.

## Roles

| role | who | writes |
| --- | --- | --- |
| Author ×N (default 3) | fresh agent per round, one assigned stance each | `rounds/round-NN/design-<stance>.md` |
| Reviewer ×2 per design | one `codex exec` (cross-LLM), one Claude fable/max | `rounds/round-NN/review-<stance>-{codex,claude}.md` |
| Synthesis | fresh agent | `rounds/round-NN/synthesis.md`, `notes-diff.md` |
| Judge | fresh agent, independent of synthesis | `rounds/round-NN/judge.md` |
| Monitor | the interactive Claude session | curates NOTES, commits rounds, tracks convergence, patches prompts, commissions spikes, carries exit to the human |
| Human | Jake | accepts or rejects exit; may interrupt anything |

## Round lifecycle

1. Monitor picks stances for the round from `NOTES/OPEN.md` and invokes
   `round-workflow.js` with `{round, stances}`.
2. Authors write competing designs from **SEEDS + NOTES only** (never prior
   rounds, never the four legacy specs — their mechanisms are in
   `SEEDS/mechanism-library.md` à la carte).
3. Each design gets two adversarial reviews (codex + claude). Findings must
   include a concrete failing schedule; opinions without schedules are noise.
4. Synthesis adjudicates every finding (confirmed / refuted-with-reasoning),
   produces the round's repaired final design + a **proposed** notes diff +
   spike proposals for disagreements that turn on measurable facts.
5. Judge independently re-walks the acceptance battery against the final
   design and scores it. The judge never sees the synthesis's refutation
   arguments as authority — it re-derives.
6. Monitor: validates the notes diff against the evidence rules below, applies
   it, runs/queues any spikes, commits the whole round
   (`design-loop: round NN — <headline>`), posts a summary to the human, and
   decides continue / park.

Isolation rule: nothing crosses rounds except `NOTES/` (curated), `SEEDS/`
(frozen; prompt patches allowed between rounds, recorded in the round
commit), and — once a round has produced a winner — **the champion
artifact** (that round's `synthesis.md`), which converging-phase stances
must be able to repair. A stance's brief says whether it reads the champion
(builders/attackers do; challengers may deliberately not, for
anti-anchoring). Competing drafts, reviews, and judgments still never cross
rounds.

## NOTES evidence rules (the gatekeeping that keeps the genome clean)

- `INVARIANTS.md` — facts. Admission requires a **measurement** (link the
  experiment), a **walked schedule**, or **both reviewers independently
  confirming**. Each entry carries provenance.
- `DECISIONS.md` — settled choices, each with the proof case that settles it.
  Reopening a decision requires new evidence, not new preference.
- `OPEN.md` — live questions; the source of next round's stances.
- `SCARS.md` — dead approaches, recorded as **the failing schedule that
  killed them** (never bare "don't do X" — prohibitions anchor, schedules
  teach).

The monitor is the only writer of `NOTES/`; synthesis only proposes.

## Exit criterion (convergence + human sign-off — never "perfection")

Exit is recommended when ALL of:

1. The acceptance battery passes: every case in `correctness-cases.md` walked
   mechanism-by-mechanism in the final design, every "by construction" claim
   accompanied by its construction, all gates numeric.
2. **Two consecutive dry rounds**: zero new confirmed blockers from either
   reviewer, and no judge-score improvement.
3. No open spike whose outcome could change the architecture.

Then the monitor presents the exit case; **only the human accepts it**.
Hard budget: **5 rounds max**, then the monitor presents best-so-far
regardless. Expected token cost is ~1–2M/round; treat rounds as expensive.

## Spikes

When a disagreement turns on a measurable fact (e.g. host-callback tax,
shadow-sync cost, memo-validation cost), it must not be argued — it gets a
spike in `research/experiments/`, and the number enters `INVARIANTS.md` with
provenance. Standing spike queue lives in `OPEN.md`. Pre-registered before
round 1: the D-style host-protocol tax measurement (extract kernel from
`libs/arena`, measure `host.refresh` indirection on deep/broad/diamond).

## Running a round

```
Workflow({ scriptPath: 'design-loop/round-workflow.js',
           args: { round: 1,
                   stances: [
                     { key: 'two-kernel',   brief: '...' },
                     { key: 'compensated-overlay', brief: '...' },
                     { key: 'fork-native',  brief: '...' } ] } })
```

The workflow writes all round artifacts but never touches `NOTES/` and never
commits — those are monitor duties. Codex reviews run via
`codex exec -s read-only -C <repo> -o <outfile> "<prompt>"`; a stance with
`author: 'codex'` runs the author role through
`codex exec -s workspace-write` for cross-model design diversity (its design
still gets both reviews; the claude review is then the cross-model one).

## Attic (contamination control)

The pre-loop architecture artifacts are **removed from the working tree** so
no loop agent (including codex, which has repo read access) can anchor on
them even by accident: `research/specs/` (four candidate specs + the panel
judgment), `react-concurrent-signals-arena.md` (the synthesized spec),
`reviews/` (its adversarial reviews and the re-judgment), and
`research/IDEAS.md` (ten kernel design sketches). Their verified content was
distilled into `SEEDS/` and `NOTES/` first. They live in git history —
recover any of them with `git show '<attic-commit>^:<path>'` (the removal
commit is titled `attic: remove pre-loop design artifacts`). The monitor may
consult history for provenance checks; loop agents may not.
