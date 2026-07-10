# FX2 simplify-and-performance loop

Give this file to Codex Ultra as the controller for a `/goal` or `/loop`.
Ultra owns orchestration; there is no custom runner.

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
concepts or obscures ownership is outside this loop and requires human review.

## Fixed operating rules

- Work in the repository's primary physical checkout directly on branch
  `main`. Never create a worktree or feature branch for the loop.
- Verify `main` before every round. Never switch branches, stash, reset, or
  discard changes to satisfy the loop. Any ambiguity is `HUMAN_DECISION`.
- At the start of every round, the FX2 package and all measurement inputs must
  be clean. At minimum inspect the package, `harness/`, its FX2 adapter, root
  package-manager config, and lockfiles. Preserve unrelated user changes. If a
  required path is dirty, stop; do not stash, reset, or absorb it into a round.
- Do not trust READMEs, reports, old plans, or old benchmark prose. Verify
  behavior from source, tests, raw measurements, and relevant git history.
- One round tests one causal hypothesis. Do not bundle opportunistic cleanup.
- Benchmarks, adapters, warmups, repetitions, checksums, and test configuration
  are frozen during a library round. Fix instrumentation in a separate round.
- Never push. Commit each accepted candidate separately so its commit becomes
  the next round's baseline.
- Stop for `HUMAN_DECISION` when semantics or an edge case were not settled by
  the locked round plan. Never guess or add speculative machinery.

Working evidence lives at `/tmp/fx2-simplify-loop/<NN>-<slug>/` for the active
round. It is intentionally temporary. The durable record is one concise
`RESULTS.md` row committed after every accepted or rejected round.

## Roles

### Controller: Codex Ultra

Selects candidates, locks the round plan, captures baseline evidence, spawns
agents, independently reruns checks, adjudicates only factual gates, records
results, and commits accepted changes. The controller does not implement the
candidate or override reviewer objections.

### Implementer: Sol xhigh, standard/slow

Use a persistent Sol implementer with xhigh reasoning and the standard/slow
service tier. Give it `prompts/implementer.md`, the locked round plan, and all
review feedback. The same implementer owns repairs so it retains context.
Use Ultra's model-configurable subagent primitive and retain its agent handle
for follow-ups. If Ultra cannot select Sol, xhigh, and standard/slow exactly,
stop with `HUMAN_DECISION`; do not silently substitute.

### Reviewers

Run both reviewers independently and in parallel after controller verification:

- fresh Sol, high reasoning, standard/slow, read-only;
- fresh Claude fable, high effort, invoked through `claude`.

Both receive the same `prompts/reviewer.md`, locked plan, complete diff,
affected source/tests, and raw before/after output. They must not see each
other's review before finishing.

Start the Sol reviewer with a fresh model-configurable subagent in read-only
mode. If those settings are unavailable, stop rather than substituting.

For Claude, compose one prompt file in the round directory, then run:

```sh
claude -p --safe-mode \
  --model fable --effort high \
  --permission-mode plan --tools Read,Glob,Grep \
  --add-dir /tmp/fx2-simplify-loop/<round> \
  --no-session-persistence \
  < /tmp/fx2-simplify-loop/<round>/claude-review-prompt.md \
  > /tmp/fx2-simplify-loop/<round>/review-claude.md
```

Run that command with the repository root as its cwd. The generated prompt must
embed the complete shared rubric, locked round plan, candidate diff, and raw
before/after results rather than merely linking them. `--safe-mode` means do
not rely on Claude configuration, plugins, memory, or `AGENTS.md` discovery.

## Candidate selection

Ultra reads current source, tests, recent FX2 history, and profiles. Prefer:

1. duplicate representations or state owners on a hot path;
2. two queues, waves, or lifecycle records carrying the same intent;
3. translation/synchronization code that can disappear;
4. per-operation closures, arrays, sets, maps, callbacks, or polymorphic
   objects;
5. a generic branch or abstraction with one production mode;
6. naming/file cleanup only when it accompanies deletion of a real mechanism.

Concepts may converge only when identity, lifetime, invariants, invalidation,
and consumers match. Do not replace visible duplication with modes, flags, or
temporal coupling.

Default to separating policy from mechanism when that clarifies ownership.
Hot-path fusion is allowed when removing the boundary eliminates measured
calls, branches, allocations, or translations and the fused invariant remains
local, named, and tested. Do not add callback bags or strategy objects merely
to satisfy a layering ideal.

If no existing benchmark exercises the proposed path, do not optimize it on
intuition. Propose a separate instrumentation round or ask the human.

## One round

### 1. Lock the hypothesis

Copy `templates/round.md` to the round directory and complete it before any
production edit. Include every materially different approach considered.
`LOCKED: yes` means all semantic edge decisions are resolved.

Record the base SHA. The round starts only when the scoped source and
measurement inputs are clean. Archive the complete candidate diff before
review.

### 2. Capture one focused baseline

Choose the smallest existing probe that exercises the predicted hot path. Run
the exact command and fixed repetition count before editing, saving all raw
output. Examples:

```sh
# Core graph/JIT work
pnpm -C harness exec tsx bench/shapes.ts \
  --frameworks alien-v3,fx2 \
  --shapes deep,broad,diamond,dynamic,create,write,reads,isolate \
  --reps 10

# React seam work
pnpm --dir packages/signals-royale-fx2 bench

# Retained-memory work
pnpm -C harness memory --frameworks alien-v3,fx2

# Queue-allocation work
node --expose-gc --import tsx \
  packages/signals-royale-fx2/bench/queue-probe.mts
```

Use one primary probe, not the entire benchmark matrix. Default to three
independent invocations and lock the count in the round plan. Save every raw
sample, command, environment, and current load. Do not choose the probe or
sample count after seeing the candidate.

### 3. Implement and iterate locally

Spawn the implementer. It may iterate on the one hypothesis using focused tests
and the locked probe. It must aim to delete first, preserve observable
semantics, and keep the before/after mental model explicit.

The implementer returns only when focused checks pass and the raw probe looks
equal or better. It may not edit measurement inputs, commit, push, switch
branches, or broaden the hypothesis.

### 4. Controller verification

Ultra—not the implementer—reruns:

- `git diff --check`;
- focused semantic tests named in the round plan;
- package typecheck;
- the exact locked probe with the same repetitions and environment.

Save every result. Run exactly the same fixed number of candidate invocations
as baseline invocations. Compare medians and all raw samples. For core timing,
changes within 3% are parity; use 5% for React and memory. Because the loop has
no baseline worktree, there is no post-edit baseline confirmation: if load,
controls, or variance make the result ambiguous, mark it inconclusive and
reject or ask the human. Never sample again until the result becomes favorable.

Reject immediately if the package resolves from a stale installed copy, work
moved outside the timed user operation, observable work was skipped, or code
detects benchmark names/inputs/environment.

### 5. Adversarial review

Run both reviewers on the controller-verified candidate. Acceptance requires
both to return `APPROVE` and specifically confirm:

- semantics and React concurrency behavior remain correct;
- a real concept, representation, owner, translation, or hot-path operation
  disappeared;
- a newcomer trace is shorter and ownership is clearer;
- the performance mechanism is causally plausible;
- raw baseline/candidate evidence is comparable and unmanipulated;
- no meaningful metric or control regressed.

`REJECT` is a veto. `HUMAN_DECISION` pauses the loop. `REVISE` returns both
complete reviews to the same implementer.

Allow at most three total implementation passes for one candidate. After each
repair, repeat controller verification and both independent reviews. If the
hypothesis must change, reject this round and start a new one.

Any repairable controller-verification failure also consumes an implementation
pass and returns its complete output to the same implementer. A correctness or
performance failure that cannot be repaired without changing the locked
hypothesis rejects the round.

### 6. Final correctness gate

After both reviewers approve, run once:

```sh
pnpm --dir packages/signals-royale-fx2 typecheck
pnpm --dir packages/signals-royale-fx2 test
ROYALE_FX2_SEEDS=1200 pnpm --dir packages/signals-royale-fx2 fuzz
FRAMEWORK=fx2 pnpm -C harness conformance
pnpm -C harness typecheck
git diff --check
```

The package test already contains the package-local Daishi conformance suite;
the explicit harness command runs the same semantic suite through the shared
FX2 registry adapter. Keep both because they exercise different wiring.

Any production, test, dependency, or configuration edit after this gate
invalidates it. Writing the evidence-only `RESULTS.md` row does not.
If the gate fails and the round still has an implementation pass available,
return the failure to the same implementer, then repeat controller verification,
both reviews, and the final gate. Otherwise reject the round.

### 7. Accept or discard

Accept only when correctness, approachability, and focused performance all
pass conjunctively. Commit only the scoped source/tests plus the concise
`RESULTS.md` entry. Do not push.

For rejection, keep the temporary evidence until the durable result is written.
Reverse only the exact recorded candidate patch after confirming no one else
changed those files; otherwise stop for the human. Append the concrete failure
to `RESULTS.md` and make a small rejection-record commit so the branch is clean
before the next round. Raw `/tmp` artifacts may then be discarded.

## Stop conditions

Continue while there is a small, well-supported deletion/convergence candidate.
Stop and report to the human when:

- no candidate has a clear semantic contract and existing performance probe;
- two consecutive candidates are rejected;
- a semantic decision is required;
- benchmark noise prevents an honest equality judgment;
- the next speed win requires adding conceptual machinery;
- the user stops the loop.

Before declaring the overall goal complete, summarize accepted commits,
rejected hypotheses, concepts/state owners removed, and the focused performance
evidence. Recommend any broader benchmark sweep separately; do not put it in
every inner iteration.
