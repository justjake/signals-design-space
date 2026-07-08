# Judgement scorecard: sh1

**Verdict: clean (after fix round; originally issues)** · re-judged fork LOC 94 · re-judged lib LOC 1217 · fork LOC 91 · lib LOC 1208

## Gates (claimed vs observed)

| Gate | Claimed | Observed |
| --- | --- | --- |
| Engine typecheck | PASS | PASS, `tsc --noEmit` exit 0 |
| React pkg typecheck | PASS | PASS, `tsc --noEmit` exit 0 |
| Engine full suite / conformance | 190/190; 179/179 | 190/190 (4 files); conformance.spec.ts 179 tests green |
| Oracle default | 3/3, 300x90 | 3/3, "300 seeds x 90 steps" 20ms |
| Oracle deep | 3/3, 1200x90 | 3/3 (ORACLE_SEEDS=1200) |
| Leak audit | 2/2 | 2/2 under real `--expose-gc` (vitest forks pool execArgv); WeakRef.deref() asserted undefined, test throws if gc unexposed |
| Fork protocol | 3/3 | 3/3 ReactSignalsRuntime-test.js on branch royale/sh1-react |
| Adjacent upstream React | 62 pass, 1 skip, 6 suites | 62 passed, 1 skipped, 6 suites, 1.7s |
| Real-React gate | 15/15 | 15/15 real-react.spec.tsx (295ms), links to fork build |
| Pristine patch/build | 3 patches to e71a6393e6 | PASS — worktree + `git am` 3 patches + rollup build; "Built: 19.3.0 (e9b811b58a)" (hash differs from claim because git am recreates commits; expected) |
| Shared battery | 25/25 | 25/25 against the pristine rebuild |
| Diff hygiene | clean | `git diff --check` clean in both repos; working trees committed |
| Fork LOC | 91 | 91 (exact command) |
| Lib LOC | 1208 | 1208 = 891 engine + 317 binding (count-loc.mjs) |
| milomg focused sanity | 4 pass / 76 skip | 4 passed / 76 skipped (full 79/80 claim and bench numbers not re-run — benchmark not in required gate list) |

## Shared battery

25/25 observed (994ms, vitest 4.1.10), re-run against a freshly rebuilt fork from the pristine patch series. Tamper check CLEAN: battery.spec.tsx, royale-types.ts, and vitest.config.ts are byte-identical to the canonical kit. package.json differs only in allowed link rewiring (drops the canonical's cosignals-alt-b link, adds react-signals-royale-sh1; react/react-dom/scheduler still point at the entry's fork build). ADAPTER.ts is a one-line re-export of the entrant's royale/adapter.ts. Scenario 14 also passes in isolation (2 passed | 23 skipped).

## Red flags

Two adapter-layer concerns, neither battery tampering: (1) The required "write-during-render fails loudly" semantic (RULES line 145, scenario 10) is implemented ONLY in the entrant's royale/adapter.ts — `set`/`update` check `protocol.world() !== null` and throw. The engine's write() and the binding src have no such guard, so a library user calling atom.set() in a render body writes silently; both battery scenario 10 and the entrant's own real-react test pass solely via the adapter's guard, which also keeps those ~4 lines out of the counted lib LOC. Beyond "wiring" per the adapter contract. (2) The adapter's flushSync wraps react-dom's flushSync in the library's exported rebaseDeferredOverUrgent(), so the claimed flushSync rebase ordering only holds for callers using the entrant's composite, not plain react-dom flushSync. Milder — it composes public library API — but same pattern of semantics injected at the verification seam. Everything else clean: shared battery spec files byte-identical to canonical, no imports from cosignals/alt-a/alt-b/concurrent-solid-react anywhere in the entry packages, no verbatim incumbent code found, leak tests use real forced GC, fork diff is honestly formatted (no line-cramming; only added test file is excluded by rule and nothing imports it).

## Notes

Stance was STM (transactions with read/write sets, React batches map to transactions, conflicts re-run against new base at commit). Delivered design is recognizably that stance with a documented deviation: an operation-log STM — each Transaction holds per-atom update logs + base snapshots + rebase logs, and reads under a world `fold()` the logs over canonical base, replaying logged functional updates instead of re-running transaction bodies. Genuinely distinct from the incumbents (no arena, no world-copy engine; class-based lazy push-pull graph); no identifier or structural overlap with cosignals/alt-a/alt-b found. Code quality is high: one 928-line engine file plus one 336-line binding, readable throughout. Ideas worth stealing: (1) the entire fork protocol as an `unstable_Signals` object living in ReactSharedInternalsClient with three shared-internals fields (X=runtime, B=current batch, R=render world) and five 1-7 line hooks in ReactFiberWorkLoop — the cleanest 91-LOC seam I have seen, including an `urgent(fn)` escape that nulls both T and B; (2) `fold()` replay with per-transaction rebase lists and a `rebaseOnCanonical` flip gives (1+1)*2=4 urgent/deferred replay ordering with zero world copies; (3) dependency collection as a small array that promotes to a Set at 8 deps; (4) pending thenables keyed by a worldKey string of `id:revision` pairs, giving one stable joined thenable per world revision (stable identity across Suspense retries). Feature spot audit: lifetime effects GENUINE (battery scenario 14 asserts one observation across two React subscribers, engine-effect union, same-tick flap coalescing via microtask-deferred cleanup); mutation window GENUINE (scenario 16 asserts zero leaked React MutationRecords while blinded, third-party records caught after reconnect; fork brackets commitMutationEffects exactly); latest() context rule WEAK on coverage — the engine implements it (a defined currentWorld resolves latest() to that context's world) but no test anywhere (battery, conformance, features, real-react) calls latest() inside a computed/render and asserts context-world resolution; battery line 162 tests only ambient latest. Report honesty is otherwise exemplary: admits 3.93x slower than alien-signals overall, admits unfiltered milomg is 79/80 due to a pre-existing unrelated failure, and documents its esbuild flag fix.


## Re-judgement after fix round

**Verdict: clean** · fork LOC 94 (+3 flushSync hook, disclosed) · lib LOC 1217

### Fixes verified

Fix 1 (render-write guard) VERIFIED-IN-LIBRARY: engine write() in packages/signals-royale-sh1/src/index.ts now throws "Signals cannot be written during render" via a renderProbe installed by the React bindings (setRenderProbe in packages/react-signals-royale-sh1/src/index.ts); adapter.ts set/update are bare pass-throughs with the old protocol.world() checks deleted. I wrote a fresh scratch test (library-only imports: atom from src/index + react-dom/client, no adapter) calling value.set(1) inside a component — it throws as required (1/1 pass; deleted after). Their updated regression also now calls value.set(1) directly. Fix 2 (flushSync ordering) VERIFIED-IN-LIBRARY+FORK: new fork patch 0004-Expose-flushSync-scopes-to-signal-runtimes.patch adds a 3-line hook in react-dom's flushSyncImpl (signalRuntime.flush(true/false) around the flush); the binding's runtime.flush maps it to the engine's urgent-rebase scope (setFlushSync); the old rebaseDeferredOverUrgent export is gone and adapter.flushSync is now the plain react-dom flushSync re-export. Confirmed the hook is present in the built bundle (vendor/react/build/.../react-dom.development.js lines 140-146) and the real-React regression now imports rawFlushSync directly from react-dom and passes. Fix 3 (latest() context tests) VERIFIED: engine test "latest inside a computed resolves the computed world" (features.spec.ts) asserts read(derived)=0 canonically vs 1 under withWorld([transaction]) — genuine context-world assertion; react test "latest inside a render and nested computed resolves that render's world" mounts a Probe during an urgent render while a newer transition world (value=1) is suspended and asserts "0:0" (render world, not ambient newest) then "1:1" after retirement. Engine latest() gained the `|| active !== undefined` branch and binding latest() enters protocol.world().render. Adapter 1:1 wiring CONFIRMED (read full file: pure pass-through/re-export table, no semantics). Suites: engine 191/191, real-React 16/16, both typechecks exit 0.

### Battery

Shared battery re-run: 25/25 PASS (805 ms) via `cd /tmp/royale-sh1/royale/verify-kit/battery && pnpm test`. Fresh tamper check vs /Users/jitl/src/alien-signals-opt/royale/verify/battery: battery.spec.tsx, royale-types.ts, vitest.config.ts, global.d.ts all byte-identical (cmp). ADAPTER.ts differs only as the sanctioned per-entrant shim (re-exports the entry's royale/adapter.ts); package.json differs only in the sanctioned link rewrites (adapter link added, cosignals-alt-b calibration link dropped) — react/react-dom/scheduler still link to vendor/react/build/oss-experimental, i.e. the fork build. No tamper.

### Notes

Fork LOC changed 91 -> 94 (recounted with count-loc.mjs --fork vendor/react --base e71a6393e6): the +3 is exactly the ReactDOMFlushSync.js hook, disclosed in REPORT.md's "Judgement fixes" section, which matches all measured numbers (94/1217; per-file 892 engine + 325 binding). No impossibility argument was needed for fix 2 — they shipped the real fork-hook solution instead. Caveats, none disqualifying: (a) the engine-package guard fires only once the React bindings are imported (renderProbe injection) — "render" doesn't exist without the bindings, and the original order allowed "engine or bindings"; (b) my scratch spec file had to execute from inside the package tests dir because vitest refuses files outside its root, but its content was authored fresh in /tmp/sh1-scratch/render-write.spec.tsx and imports only library entry points, and it was deleted after the run. resetForTest now also zeroes urgentRebaseDepth (hygiene, consistent with the new setFlushSync counter).
