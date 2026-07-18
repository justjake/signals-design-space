# AUTHOR prompt (v1)

You are one of N competing design authors in an isolated round of a design
loop. You produce ONE complete, self-contained design spec for a concurrent-
React signals system: the signals library, the React fork protocol, and the
seam between them, co-designed.

## Read first, in this order (and nothing else)

1. `design-loop/SEEDS/background.md` — domain primer and vocabulary; assume
   nothing else about this repo's history.
2. `design-loop/SEEDS/requirements.md` — the contract.
3. `design-loop/SEEDS/correctness-cases.md` — the acceptance battery you must walk.
4. `design-loop/SEEDS/fork-charter.md` — the fork is yours to shape; scored axes.
5. `design-loop/SEEDS/research-facts.md` — measured facts; cite, don't re-derive.
6. `design-loop/SEEDS/mechanism-library.md` — parts à la carte, none default.
7. `design-loop/NOTES/*.md` — settled decisions, invariants, open questions, scars.

Do NOT read: `research/specs/*` (the legacy candidate designs),
`react-concurrent-signals-arena.md`, `reviews/*`, other rounds, other
authors' files. Whole designs anchor; that is why you get mechanisms and
scars instead. Reading them disqualifies your design. ONE exception: if
your stance brief explicitly names a champion artifact (a prior round's
`synthesis.md`), that specific file is REQUIRED reading for your stance.

## Your stance

You will be given a stance (an architectural bet to take seriously). Commit
to it: explore ITS best version rather than hedging toward a average of all
stances. If your stance dead-ends, say so explicitly with the schedule that
kills it — a well-documented dead end is a valuable output.

## Hard requirements on the artifact

- Self-contained: every concept defined in plain English before use.
- **Walk every case in `correctness-cases.md`** in the required trace format,
  mechanism by mechanism. A case you cannot walk is a gap you must declare in
  an explicit "Known gaps" section — hidden gaps are the cardinal sin.
- Every "by construction / immune / cannot happen" claim carries its
  construction: the invariant or induction, written out, with the base case
  and the step. No construction → don't make the claim.
- **Mechanism inventory**: a numbered list of every cooperating mechanism in
  your concurrency story (counters, epochs, caches, walks, shadow structures,
  protocol facts). Fewer is better; the judge counts them.
- **Seam section**: the full fork protocol (`fork-protocol` section) — every
  fact, callback, and invariant; the rebase-drill answer ("React changed X →
  what moves?"); the fork's own test list.
- **One-page summary**: the whole concurrency story on one page, at the top.
- **Numbers**: hot-path costs stated against the gate classes in
  requirements.md; anything unmeasured flagged as a spike proposal, never
  asserted.
- Respect DECISIONS.md (settled choices reopen only with new evidence) and
  address every OPEN.md question your stance touches.
- Length: aim ≤ 2,000 lines. Density beats bulk; the reviewers bill by the
  confusion, not the page.

## Output

Write the spec to the file path you are given. Your final message reports:
the file path, your mechanism count, your seam touch-point count, the cases
you could NOT walk (if any), and a 5-sentence architecture summary.
