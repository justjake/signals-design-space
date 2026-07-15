# FX2 simplify-and-performance loop

Give this file to Codex Ultra as the controller for a `/goal` or `/loop`. Ultra
keeps the loop moving; it does not choose the changes.

## Goal

Repeatedly improve `packages/signals-royale-fx2` through a virtuous cycle:

```text
remove code or collapse a duplicate concept
  -> fewer states, branches, calls, allocations, and instructions
  -> a smaller program for people and the JIT
  -> equal or better performance
  -> repeat
```

The ideal change is simpler and faster for the same causal reason. Benchmark
parity may admit a material simplification. A speed-only change that adds
concepts or obscures ownership requires human review outside this loop.

## Roles

### Implementers: Sol xhigh, standard/slow

Up to two persistent implementers may work concurrently in isolated worktrees.
Each reads the package, tests, profiles, history, and results ledger; chooses
the most promising change within its assigned non-overlapping area; captures a
baseline; implements it; and iterates until focused correctness passes and
performance is equal or better.

Unless the human prioritizes an item, the controller must not supply a
candidate, shortlist, or locked design. An implementer may be ambitious:
package-wide redesigns, object/layout changes, concept convergence, renaming,
and data-oriented designs are in scope. Bound a round by one coherent causal
story, not by diff size.

Give each implementer `prompts/implementer.md`, `BACKLOG.md`, `RESULTS.md`, and
applicable review feedback. Retain its agent handle across rounds and
revisions. If Ultra cannot select Sol xhigh with the standard/slow tier
exactly, stop rather than substitute.

### Reviewers

After handoff, run both reviewers independently and in parallel:

- fresh Sol, high reasoning, standard/slow, read-only;
- fresh Claude fable, high effort, read-only through `claude`.

They are the loop's drag: both must approve correctness, approachability,
genuine simplification, and honest equal-or-better performance. They reject
pointless motion, fake convergence, unexplained cleverness, and reward hacking.
Give each the same `prompts/reviewer.md`, candidate record, complete diff,
affected source/tests, and raw measurements. Hide each review from the other.

Start Sol with a fresh model-configurable subagent. For Claude, embed the full
rubric, candidate record, diff, and raw results into the input file and run from
the repository root:

```sh
claude -p --safe-mode \
  --model fable --effort high \
  --permission-mode plan --tools Read,Glob,Grep \
  --add-dir /tmp/fx2-simplify-loop/<round> \
  --no-session-persistence \
  < /tmp/fx2-simplify-loop/<round>/claude-review-prompt.md \
  > /tmp/fx2-simplify-loop/<round>/review-claude.md
```

Do not silently substitute reviewer settings.

### Controller: Codex Ultra

Ultra operates the loop rather than directing the technical work. It checks
repository hygiene, starts/resumes agents, mechanically reproduces tests and
measurements, routes complete feedback, records outcomes, commits accepted
changes, and starts the next round.

Do not pre-approve, narrow, or replace a candidate because Ultra would have
chosen differently. Intervene when integrity or momentum is failing: the work
loses one causal story, measurements are gamed, feedback is ignored, revisions
cycle, or the implementer thinks useful autonomous progress is exhausted.

After every performance-positive `REVISE` or `REJECT`, immediately add or update
the `RESULTS.md` near-miss entry with the measured benefit, rejection reason,
reusable mechanism, and retry condition. Keep it even if a later revision is
approved. Pass the ledger to the implementer every round. Ultra remembers the
lead; the implementer decides whether and how to reuse it.

If the implementer finds no promising work, ask it to revisit near misses and
make one broader search. If that also produces no honest opportunity, summarize
the frontier and stop for the human. Ultra must not invent a candidate merely
to continue.

## Operating rules

- The controller owns worktree creation, cleanup, and integration. Give each
  concurrent implementation track a dedicated worktree and feature branch from
  the same accepted baseline. Implementers must not create worktrees, switch
  branches, merge, commit, push, stash, or reset.
- Keep at most two implementation tracks active. Assign disjoint source areas
  and measurement inputs so their implementation and evidence cannot race.
- Review and verify each track independently in its worktree. Integrate accepted
  tracks into `main` one at a time. After each integration, rebase the remaining
  track; if the earlier change affects its source, hot path, probe, compiler
  inputs, or runtime dependencies, re-emit, remeasure, re-review, and rerun the
  final gate before integrating it.
- Before each round, verify `main` and record the starting diff. Candidate files
  and the exact inputs used by its probe must be stable and attributable.
  Unrelated dirty paths do not block the loop; preserve them.
- Treat READMEs and old reports as leads, not authority. Verify source, tests,
  measurements, and relevant history.
- Freeze benchmarks, adapters, warmups, repetitions, checksums, and test config
  during a library round. Freeze the probe source and compiler config too.
  Measurement work must be a separate reviewed round.
- Never invent unresolved semantics. Prefer another candidate; ask the human
  only when the decision blocks further worthwhile work.
- Commit each accepted candidate separately; it becomes the next baseline.

Keep working evidence in `/tmp/fx2-simplify-loop/<NN>-<slug>/`. `RESULTS.md` is
the durable memory.

## Performance probe protocol

For each actor and source revision, one package-local NodeNext `tsc` program
compiles the live FX2 source and frozen `.mts` probe together into a fresh
immutable directory. Every repetition runs that same emitted artifact with
plain Node. Never run measured code through `tsx`, esbuild, Bun, live `.ts`
imports, or a reused output directory.

Record the TypeScript version and hashes for its launcher and resolved compiler
binary, plus the compiler host Node path/version/hash and the sampler Node
path/version/hash captured by the sampler itself. Record the compiler config,
probe, source manifest, runtime dependency state, and full artifact manifest.
Copy the resolved React,
ReactDOM, and Scheduler packages into the artifact before hashing and making it
read-only; never link live runtime code. Verify the full manifest after
sampling. Baseline and candidate use separate outputs but identical non-source
inputs. Compilation, import, setup, validation, and output stay outside timing.
The exact preparation and run commands live in `templates/round.md`.

## One round

### 1. Discover and implement

Start or resume each implementer without proposing a candidate unless the human
has prioritized one. Before editing production code, it records only its chosen
direction, base SHA, causal performance hypothesis, probe and repetitions, raw
baseline, and measurement integrity boundary in `templates/round.md`, including
the compiler/runtime and baseline emission record above. It completes the
explanatory parts before handoff. This is an audit trail, not approval or a
design lock.

The implementer then iterates with focused tests and the identical probe. It
may replace its approach while pursuing the same coherent goal. It returns when
the design is coherent, focused checks pass, and the fixed sample set meets the
parity/improvement threshold below. It reports every sample and explains any
outlier. It may not edit measurement inputs, commit, push, or switch branches.

If the path has no honest probe, the implementer may choose separate
measurement work or a different opportunity; Ultra does not choose for it.

### 2. Reproduce mechanically

Ultra saves the complete diff and independently runs:

- `git diff --check`;
- focused semantic tests named by the implementer;
- package typecheck;
- a fresh controller emit from the frozen compiler config and probe;
- plain Node over that immutable artifact for the same number of samples.

Compare the saved baseline with every candidate sample. Treat timing within 3%
as parity for core benchmarks and within 5% for React or memory. With no
baseline worktree, noisy or load-skewed evidence is inconclusive; never add
samples until the result becomes favorable.

An unchanged control outside its threshold makes the performance evidence
inconclusive; it does not attribute that movement to the candidate. Do not let
that control alone reject a supported-surface correctness fix with a focused
falsifier. Land the fix without a performance claim when its changed paths stay
within their thresholds and the full correctness gate passes.

Reject stale or reused output, live-TypeScript runtime imports, implicit
transforms, compiler/config/probe drift, linked or changed runtime dependencies,
shifted timing boundaries, skipped observable work, benchmark detection, or
benchmark/config edits.

### 3. Review and revise

Run both reviewers. Acceptance requires two `APPROVE` verdicts. `REVISE` sends
both complete reviews to the persistent implementer, which decides whether to
repair, simplify further, salvage the fast core in a clearer design, or abandon
the candidate. Any edit requires fresh mechanical verification and two fresh
reviews. `REJECT` ends the candidate.

There is no fixed pass count. Let productive revisions continue. Ultra steps in
when the same objection repeats without new evidence, the causal story keeps
changing, or the diff grows faster than the concept shrinks. It then asks for a
coherent salvage or ends the round. `HUMAN_DECISION` pauses only when different
work cannot avoid the unresolved issue.

### 4. Run the final gate

After approval, run once:

```sh
pnpm --dir packages/signals-royale-fx2 typecheck
pnpm --dir packages/signals-royale-fx2 test
ROYALE_FX2_SEEDS=1200 pnpm --dir packages/signals-royale-fx2 fuzz
FRAMEWORK=fx2 pnpm -C harness conformance
pnpm -C harness typecheck
git diff --check
```

The package test contains package-local Daishi conformance; the harness command
exercises the same suite through the shared FX2 adapter. Any source, test,
dependency, or config edit invalidates this gate and requires verification and
fresh reviews.

### 5. Record and continue

For acceptance, append a concise results row, retain near misses from discarded
intermediate revisions, and commit the scoped source/tests plus those records.
Start the next round from that commit.

For rejection, record the lesson and ensure every measured win is in the
near-miss ledger. Preserve the mechanism without recommending the rejected
design. Safely reverse only the candidate patch, commit the durable record, and
continue with the same implementer.

## Stop conditions

Rejection is input, not a stop condition. Stop for the human only when:

- unresolved semantics block all worthwhile candidates;
- noise prevents honest equality judgments across useful work;
- the implementer has searched source/profiles and revisited near misses but
  finds no further simplification with equal-or-better performance;
- the next speed win necessarily adds conceptual machinery;
- the user stops the loop.

Before stopping, summarize accepted commits, rejected candidates, retained
near-miss mechanisms, concepts/state owners removed, and raw performance.
