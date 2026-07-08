# Judgement scorecard: sx1

**Verdict: clean** · fork LOC 476 · lib LOC 1295

## Gates (claimed vs observed)

| Gate | Claimed | Observed (my run) |
|---|---|---|
| Engine typecheck | PASS | PASS — `tsc --noEmit` clean |
| React typecheck | PASS | PASS — `tsc --noEmit` clean |
| Conformance | 179/179 | PASS — 179 passed (179), 210ms; wiring matches prescribed shape, `untracked` implemented |
| Oracle default | 300×90 | PASS — 300 seeds × 90 steps, 63ms; env-tunable, prefix-shrink prints seed+schedule |
| Oracle deep | 1200×90 | PASS — ORACLE_SEEDS=1200, 218ms |
| Full engine suite | 190/190 | PASS — 4 files, 190 passed |
| Leak audit | 3/3 | PASS — 3/3; genuine: WeakRef + forced gc, pool forks + --expose-gc, throws if gc missing |
| Fork protocol + adjacent | 47 passed / 1 skipped | PASS — 5 suites, 47 passed, 1 skipped, 1.6s |
| Pristine fork build | PASS | PASS — worktree at base e71a6393e6 + `git am` 3 patches + rollup NODE_DEV/PROD; "Built pristine React patch series at a25c16920d" |
| Real-React entrant suite | 17/17 | PASS — 17/17, re-verified AGAIN on the pristine patch-built artifacts |
| Shared battery typecheck | PASS | PASS |
| Shared battery | 25/25 | PASS — 25/25 (609ms), re-verified on pristine patch-built fork (25/25) |
| milomg adapter sanity | 8/8 | PASS — 8 passed incl. pull counts |
| milomg table | 3.58x slower than Alien (sBench+Kairo); cellx/dynamic NOT MEASURED (hang) | Not re-run in full (shared machine); my unfiltered 1-round attempt emitted nothing before I killed it, corroborating the reported cellx hang. Claim is self-damaging; fabrication risk low |
| react-bench | fanout 0.307 vs 0.378; transition p95 2.600 vs 2.049; mount 71.1 vs 38.0 | Reproduced: fanout,sx1,0.327 vs uSES 0.358; transition p95 sx1 0.998 vs uSES 1.216 (sx1 FASTER in my run — they disclosed noise and claimed their worse run); mount sx1 46.5 vs 36.8 |
| Fork LOC | 476 | 476 confirmed (`git diff --numstat` base..HEAD, __tests__ excluded); diff purely additive, all inside packages/, nothing outside packages/, 126 test lines correctly excluded |
| Lib LOC | 1295 | 1295 confirmed via canonical count-loc.mjs (runtime.ts 1053 + react index.ts 241 + index.ts 1) |

## Shared battery

25/25 PASS, run twice — once on the pre-existing build and once after rebuilding React from the patch series in a pristine worktree. Tamper check CLEAN: battery.spec.tsx, royale-types.ts, vitest.config.ts, global.d.ts all byte-identical to the canonical kit; tsconfig.json identical; ADAPTER.ts is a one-line re-export of the entry's adapter; package.json diff is wiring-only (swaps the incumbent placeholder link for react-signals-royale-sx1). The entry's royale/adapter.ts is a thin pass-through of engine/bindings exports with no battery-specific special-casing.

## Red flags

No disqualifying flags. Minor items: (1) Scenario 12 (time slicing): Round 2 added NO entrant-side interruption test (tests diff between Round 1 and Round 2 commits is empty); the Round 2 gates table says "Real React PASS, 17/17" without repeating Round 1's honest "interruption not pinned" caveat. Mitigation: the shared battery's scenario-12 test is a GENUINE interruption proof (real scheduler outside act, asserts 3 <= itemRenders < 24 mid-flight, urgent flushSync commits with the list still at n:0, transition lands later) and sx1 passes it including on the pristine patch-built fork — so the behavior is now verified, just not by their own suite. Judged honest overall with a presentation ding: the bare PASS mildly overstates their own suite, but they never claimed to have added an interruption test and the Round 1 gap text remains in the report. (2) "Loud stock-React mismatch" listed among done/tested features: the throw exists in register() but no test exercises it. (3) The fuzz oracle models atoms only (read/latest/committed folds over 4 atoms); no memo-free computed rederivation as RULES prescribe — narrower than the prescribed pattern. (4) Their claimed transition-p95 regression (2.60 vs 2.05) did not reproduce (my run: 0.998 vs 1.216, sx1 faster); they disclosed the noise and claimed the number worse for themselves — conservative, not gaming. Isolation: clean — no imports of cosignals/alt-a/alt-b/concurrent-solid-react anywhere in the entry packages; no identifier overlap with incumbent sources (afterDraft, withWorld, rootBatches, fold etc. appear nowhere in incumbents); milomg clone roster limited to Alien + own entry to respect isolation.

## Notes

Originality: high and true to the declared stance. The engine really is an event-sourced single log — writes append Operations to one ordered array; canonical/latest/committed are one fold() parameterized by mode with a world-scoped applies() filter; retirement compacts into per-atom checkpoints so the log is empty at quiescence (GC-tested). Lanes-as-batch-identity is real: the bindings create a BatchToken per React lane on demand and retire it off onCommit's remainingLanes with a microtask ticket + per-token root set — no parallel id space or translation table. Nothing resembles the incumbents' code. The causality QUERY surface exists beyond the log: trace() returns a bounded ring with counted overflow, events() with causal parents, and whyLastDelivery() walking cause links into a formatted chain ("delivery#7 -> write#3"); verified by battery scenario 15 (urgent chain to write, post-retirement chain through retirement, structural parent validity) and entrant tests. It is keyed by signal per the adapter contract, formatting is terse, and the admitted gap is real: render-pass-end carries no commit-vs-discard label. Feature spot audit: lifetime effects GENUINE (union across React + engine effect kinds, same-tick flap coalescing, StrictMode nets one — battery + entrant engine tests); latest() context rule IMPLEMENTED (world-aware applies; in-context latest resolves the ambient world) but WEAK direct coverage — no test reads latest() inside a computed/render context; mutation window GENUINE (real MutationObserver disconnect/reconnect, zero React records, third-party childList seen, in both suites). Code quality: excellent readability, no line-golfing; named id types, engineering-rationale comments; the fork seam is a beautifully documented generic "external runtime introspection channel" (ReactExternalRuntime.js, 182 lines) that any state library could use. Ideas worth stealing: (1) the 476-line purely-additive fork seam — provider registration via ReactSharedInternals.E mirroring the S/onStartTransitionFinish pattern, exposing getCurrentUpdateLane/getRenderContext/onCommit(remainingLanes)/mutation bracket + a 15-line runInLane correction primitive that pins post-subscribe fixup re-renders to the owning transition lane; (2) mode-parameterized fold with three-phase operation ordering (pre-draft urgent, drafts, afterDraft urgent) that yields the React updater-queue rebase arithmetic for free; (3) lane-keyed batch tokens with ticketed microtask retirement keyed on remainingLanes. Weak spots for scoring: benchmark story is the entry's honest liability (3.6x slower than Alien on completed suites, cellx/dynamic hang unmeasured, mount ~1.3-1.9x slower than a stock uSES baseline); oracle narrower than prescribed; entrant suite covers 17 of 18 scenarios (scenario 12 delegated to the shared battery, which it passes).
