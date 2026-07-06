# dalien-signals → cosignal optimization port study

Date: 2026-07-06. Read-only study; no code changed. Sources: `packages/dalien-signals`
(submodule @ 811c929 — README, src/system.ts, src/index.ts, tests/bytecode.spec.ts,
benchs/, .github/workflows/), `packages/cosignal` (src/index.ts kernel; concurrency
engine src/concurrent.ts — the logged.ts→concurrent.ts rename landed mid-study, all
findings re-verified against the renamed tree), `research/RESEARCH.md`,
`research/experiments/cosignal-gates.md`, parent git log (ca04129 S-A stop, 3ca5f3f
quiet-mode, 19bac95 P1).

Effort scale: S < ½ day, M = 1–2 days, L = multi-day. "Gates" = what polices a
regression: CONF = conformance 179/179 × {cosignal, cosignal-concurrent, arena}
(harness/conformance); PKG = cosignal vitest (232+ incl. logged-battery/-fuzz/-scars,
quiet-mode, one-core probes, oracle lockstep + armed arena-divergence check); SA =
bench/spka-sa-gates.mjs (both gates ≤ 1.4× anchor); SPK = bench/spk*.mjs families;
T0 = harness/bench/shapes.ts tier-0 shapes.

## 1. Per-optimization applicability

| # | Optimization (what it is) | dalien's measured win | cosignal applicability | Effort | Risk / gates |
|---|---|---|---|---|---|
| 1 | **Quiet-epoch clean-read fast path (VSTAMP)** — global f64 write epoch; each computed's node record stores the epoch at last verification in slots 6–7 (read as ONE f64 via a Float64Array view over the same buffer); stamp==epoch ⇒ return cached value, skipping the flags ladder/walk. Entry-captured stamping (stamp the epoch read *before* the body, so a mid-verification write can only force a miss, never a lie); stamps also written on tracked reads (flush-stable epoch turns diamond re-reads into hits); stamp cleared at `unwatched` (alien semantics force unwatched recompute) and at `freeNode`; epoch bumps ONLY on observed writes (`subs !== 0`), so unobserved writes stay stamp-neutral. | Named in RESEARCH.md §8.6 "the cheapest known win absent from alien-signals core" (Preact/Vue 3.6/Svelte/Angular ship the idea); attributed the **dynamic-suite win** in dalien's kairo/dynamic sweep (dalien total 3,989 ms vs alien 4,273 ms Node; dynamic 2,209 vs 2,569). Secondary structural payoff: the growth-retire guard rides free (a zeroed retired arena can never stamp-hit). | **YES, with a layout move.** cosignal node field 6 is `LIFECYCLE` (D1, a 0/1 boolean) and field 7 is spare — move LIFECYCLE into a free NodeFlag bit (bits ≥ 8192 free; it is checked only in linkInsert's first-sub branch and unwatched's signal branch), freeing slots 6–7 for the aligned f64 stamp. Extra cosignal-only interactions: (a) D2 CycleError — clear the node's own stamp at eval start or a re-entrant read stamp-hits stale cache instead of throwing; (b) HAS_BOX — never stamp a boxed outcome (or route stamp-hits through the flags check for HAS_BOX) so raw payloads are never served unwrapped; (c) bump sites = `write` (already has the `subs!==0` branch), `invalidateComputed` (settlement), and clear-at-`storeThrown`; quiet-mode bridge writes already funnel through `E.write` (`__hostApplySet→writeAtom`); world-routed reads never touch kernel slots. cosignal's growth (closure rebuild, same buffer content carried, module-level epoch) is *simpler* than dalien's: no retired-forwarding needed. | M–L | Kernel semantics: CONF, PKG (quiet-mode + one-core branch-budget probes), SA unchanged. Perf: T0 readPoll/diamond, SPK-L. Wrong-stamp bug class = stale serve — fuzz + conformance catch flips; add targeted stamp-invalidation pins. |
| 2 | **freeLink freelist through a SPARE link field** — dalien threads the link free list through field 7 (`FREE_NEXT`), leaving all real fields of a freed link intact, because upstream's walks *deliberately* read stale `nextDep`/`nextSub` off links unlinked earlier in the same walk (conformance #203 exercises it) and those stale pointers must name former neighbors — never the free list. | Correctness fix (latent libs/arena bug dalien fixed); no perf number — it prevents silent spurious recomputes / garbage-directed walks. | **YES — HAZARD PRESENT in cosignal. See audit below.** Kernel link field 7 is spare (`// field 7 spare`), so the dalien fix ports verbatim: `LinkField.FREE_NEXT = 7`, swap the two `NEXT_DEP` touches in `allocLink`/`freeLink` (src/index.ts:552–573). SECOND SITE: concurrent.ts shadow arenas thread `a.linkFree` through `AF.L_NEXT_DEP` too (concurrent.ts:935/946) and field 7 is occupied (`L_MODE`); aCheckDirty (concurrent.ts:2653) + mid-fold `shadowFor` dead-tenancy purges give the same structural mid-walk-free pattern — needs its own spare-field pick (candidate: `L_VER`; freed links never serve a version) + mini-audit. | S (kernel), S–M (shadow arenas) | No semantic change; CONF #203 exercises the path (today it passes only because the free list is usually empty in fresh-graph tests). Add a regression test that pre-populates the free list, then runs the #203 shape and asserts recompute counts. PKG fuzz + armed divergence check police the shadow-arena change. |
| 3 | **Handle-owned getters + FinalizationRegistry reclamation** — computed getters live on the handle closure; the engine's fns column only *borrows* while subscribed (`FN_INSTALLED`, returned at unwatched via deferred `pendingFnClear`); FR (weak target = getter, registered at first eval) frees signal/computed records when handles are dropped; `ORPHANED` defers to last-unlink; `reset()` reclaims generations wholesale. | Leak-free arena; **−47% heap at 10k effects** (RESEARCH.md §7b); registration ~15 ns immediate (batching measured worse — nursery promotion). | **LOW for this campaign — honestly assessed.** cosignal has no FR and *by design* never reclaims signal/computed records ("owned by their handles", index.ts header). Worse, D4 stores the owning `Computed` instance in the aux value column — a strong engine→handle ref, the exact anchor dalien's borrowing dance exists to break; porting FR means unwinding D4 (the box/ctx.use-cache holder) first. It is a memory-posture feature, not a speed win; long-lived apps that churn Computeds leak 32 B records + getters + cached values. Park; consider only if soak-style leak reports arrive. | L | PKG (suspense/ctx.use tests depend on D4 holder), SPK-K1 soak would police the win. |
| 4 | **Anonymous-closure / keepNames lessons** — any *named* closure minted per handle gets `Object.defineProperty(fn,'name',…)`-wrapped by keepNames toolchains (tsx, some esbuild pipelines): dictionary-mode props, **~120 ns per handle** (vs ~3 ns symbol brand); dalien mints handles as anonymous closure literals in argument position (`anon()` identity fn) and does kind checks by sampled `String(fn)` source. | ~120 ns/handle avoided under keepNames; ~3 ns/handle vs symbol brand. | **PARTIAL — harness/audit level.** cosignal's public API is classes (D7): Atom/Computed creation mints no closure. But `effect()`/`effectScope()` return disposer closures and the lifecycle ctx mints closures; and the bench children run under `--import tsx` — the exact toolchain dalien flags. Action: one-off audit that create-heavy paths and bench children aren't paying the defineProperty tax (inspect `fn.name`/`%DebugPrint` in a probe); apply the argument-position trick to disposers if hit. | S | Bench-integrity only; T0/SPK create-heavy shapes. |
| 5 | **computedRead hot/cold split** — dalien: stamp-hit fast path first, `retired` check + flags ladder + out-of-line `coldEvalInstalled`/`coldEvalWith` behind it; twin `computedReadWith` carries the handle-owned getter. | Split keeps the read path inline (≤460 bytecodes); cosignal's own D3 note measured the analogous split **faster on read-heavy workloads** and the inline-cliff fall-off at **~2.5 ns per clean read**. | **Mostly DONE — differences are row 1 and row 3.** cosignal already splits `computedRead` (one combined mask routes RECURSED_CHECK/DIRTY/PENDING/HAS_BOX/never-evaluated to `computedReadSlow`). dalien's remaining deltas: stamp-first ordering (row 1) and the getter-carrying twin (row 3, N/A). No separate work item. | — | — |
| 6 | **Bytecode-budget regression test** — dump `--print-bytecode` of the BUILT output over a smoke fixture, assert per-function budgets ≤ V8's 460-byte inline limit (920 cumulative); budgets pin the propagate/read/flush hot paths; raising one is a deliberate PR act. | Guard, not a win — it *caught* the wins: monolithic link() at 475 never inlined (split measured −8/−10/−13% deep/broad/diamond); checkDirty at 543 couldn't inline into run()/computedRead until split. | **YES — straight port.** cosignal hot-function budget list: kernel `link, linkInsert, unlink, propagate, checkDirty, shallowPropagate, isValidLink, update, updateComputed, updateSignal, notify, run, purgeDeps, unlinkChildEffects, read, write, computedRead, flush, writeAtom`; concurrent-engine hot set `aLink, aUnlink, aPropagate, aShallowPropagate, aCheckDirty, aPurgeDeps, shadowFor, aNoteAtom, foldAtom` + the quiet-write path. NOTE: budgets must run against built/inlined-const-enum output (cosignal ships TS source — measure via tsx-transformed or esbuild-transformed smoke, and pin the Node version). Expect it to immediately flag cosignal's monolithic `checkDirty` (row 10). | S | Test-only; CI Node-version pin to avoid flake. |
| 7 | **Monomorphic-array discipline** — side columns are plain arrays grown by `push` (PACKED, never holey), one packed value column (type-segregation measured a loss), persistent Int32Array scratch stacks, function-scope const aliases of module arrays (esbuild demotes module `const` to `var`; aliases re-fold). | Named "measured loss" avoidance + the +15–21% const-enum/bundling guard. | **PARITY with micro-deltas.** cosignal already does all of it (same comments, same aliases, same const-enum rationale; concurrent.ts byNode kept packed with explicit pre-size). Micro-deltas from dalien: size side columns only in the fresh-record branch of `allocNode` (cosignal runs the while-checks for recycled ids too); `queue` alias in flush already present. Fold into a tidy pass; no dedicated batch. | S | T0 noise-level; CONF. |
| 8 | **Hidden-class / operation-table discipline** — dalien: `bootEngine` of `uninitialized` members so handle call sites only ever see the real engine's hidden class; const-enum-only hot constants. cosignal: POISON fold-purity table deliberately shaped so the live engine stays the only instance of its hidden class at `E.op` sites (sharing measured +15–25%). | dalien: monomorphic ICs at handle sites; cosignal: +15–25% avoided (its own measurement). | **PARITY.** Both apply the same rule through different objects. One residual dalien lesson worth recording in cosignal's growth comment: *every* extra `createEngine` instantiation (first growth) permanently disables V8 function-context specialization process-wide (row 9). | — | — |
| 9 | **Fixed-capacity vs growth trade** — dalien: an arena NEVER moves; system grows by migration (double arena, copy prefix, rebuild engine, retire old with forwarding entry points, quiet-read paths guard-free). Measured: resizable ArrayBuffers / mutable bindings / segment tables cost 1.9–2.3× on hot paths ALWAYS; migration costs ~0 before first growth, then up to **~1.9× on walk-heavy steady state** (function-context specialization lost process-wide); known fix if load-bearing: build-time second copy of createEngine (distinct SharedFunctionInfos per generation). | The trade itself: 26–83% hot-walk tax avoided vs growable-buffer alternatives; +0.4 % suite noise for forwarding guards. | **PARTIAL — posture, not code.** cosignal already grows by closure rebuild at boundaries and — because handles are classes routing through `E`, not closures over `M` — needs *no* retired-forwarding at all (structurally cleaner than dalien). What ports: (a) the awareness that the FIRST growth costs ~1.9× walk-heavy for the rest of the process → keep `COSIGNAL_INITIAL_RECORDS`/`configure({initialRecords})` generous by default (dalien defaults to 256 MB *virtual*, lazily mapped; cosignal defaults to 3·2²⁰ records = 24 MB — consider raising, memory is virtual until touched); (b) measure cosignal's own post-growth tax once (one bench: force a growth, re-run T0); (c) the second-copy-of-createEngine trick, documented as the escape hatch. Keep growth: cosignal is an app library, hard caps are hostile. | S | growth.spec-style pins; T0 pre/post-growth A/B. |
| 10 | **checkDirty split: entry wrapper + shallow fast path + two-level fast path + stackless chainCheck + out-of-line loop** — try/finally + loop was 543 bytecodes (never inlined into run/computedRead); wrapper resolves (a) sub-already-dirty, (b) effect one link from a written signal's computed, (c) effect one *computed* away (two-level descend-then-unwind), (d) unbranched single-dep/single-sub chains without a stack (climb unique subscriber links to unwind). | 40f1911: small cones (3–10 recomputes) 1.05–1.13× → **0.94–1.01× vs upstream**; 82d9aec: 1–3 recomputes ~1.3 → **0.9–1.1** (crossover moved to ~2 recomputes); plus inline eligibility for the whole read/run path. | **YES — cosignal's checkDirty is the monolithic upstream shape** (src/index.ts:725–799: try/finally wrapping the loop) and is near-certainly over the inline limit (row 6 will print the number). Direct transliteration: cosignal's `update()` has no getter param, so it is *simpler* than dalien's port; `updateAndShallow` factors the shared capture-subs-before-update sequence. Biggest pure-kernel perf item on the board. | M | CONF (esp. #203-family, effectLifecycle), PKG fuzz + divergence check, T0 deep/diamond/broad, SPK-L deepPropagate. |
| 11 | **Adaptive call-site seeding (megamorphic insurance)** — seed the engine's user-callback call sites past V8's >4-shape threshold *only when minted callback shapes diversify* (sampled `String(fn)` per family — getters vs effect callbacks — on geometric cadence); single-shape processes keep full speculation (measured 1.15× on a hot chain); diverse processes converge (insurance ratio 1.01). | Avoids **20–35%** mid-run deopt/reopt churn on pull-heavy graphs when workloads share a process; adaptive trigger removed the old always-on tax (1.09–1.26× on crossover families). | **YES for real-app posture.** cosignal has no seeding; React apps funnel many getter shapes through `updateComputed`'s call site, so the deopt-churn scenario is cosignal's *normal* life. Port `maybeSeed` + `seedEngine` (~120 lines) with the same guards (detach activeSub, mask host seams during warmup — cosignal must also mask hostWrite/hostRead + lifecycle). Verify with a phaseTransition.mjs-style probe. | M | PKG one-core probes (no events from warmup), CONF; probe = ported benchs/phaseTransition.mjs. |
| 12 | **link/linkInsert split** — re-track fast path + out-of-line insertion. | −8% deep / −10% broad / −13% diamond (the number cosignal's own comment cites). | **DONE** (cosignal:577–627 is the same split). | — | — |
| 13 | **Everything-parity group** — interleaved node+link single arena (−2% deep/−8% diamond vs split), persistent scratch stacks, notify segment reversal for outer-first order, lazy allocation, const-enum literals. | As noted per item. | **DONE** — cosignal inherited all of these from libs/arena. | — | — |
| 14 | **Microtask maintenance boundary** — dalien drains reclamation/growth in a `queueMicrotask` boundary between tasks (plus synchronous caps at 8192), instead of only at next-operation entry. | Keeps memory bounded when an app goes idle after a dispose burst; no hot-path number. | **PARTIAL, minor.** cosignal's `maybeBoundary` only runs at the next public op; an idle app retains pendingFree until then. Port = ~15 lines. Do opportunistically with row 2. | S | PKG dispose/reclaim pins. |
| 15 | **`reset()` generation lifecycle** — bulk arena teardown; dalien's benchmark adapter calls it in `cleanup()` ("the arena equivalent of what GC-managed graphs get for free"). | Fair-bench enabler; −47% heap figure rides row 3. | **PARTIAL — bench-harness relevance only.** cosignal has no reset; the milomg-harness cosignal adapter can't drop dead graphs between tests, which *penalizes cosignal* in per-process suite runs (arena + side columns keep growing). A test-only `__reset()` (rewind recNext, truncate columns, reset scalars) is cheap and CI-motivated; a public reset drags row-3 questions. | S (test-only) | Harness-only; CONF must not see it. |

### AUDIT: the freelist hazard in cosignal's kernel (row 2 evidence)

**Verdict: hazard PRESENT, latent.** Facts, all re-verified in the current tree:

1. `LinkField.NEXT_DEP = 6, // doubles as the free-list next pointer for freed links`
   (src/index.ts:331); `let linkFreeHead … // free list threaded through
   M[id + LinkField.NEXT_DEP]` (:399); `freeLink` overwrites the freed link's
   NEXT_DEP with the old free head (:570–573); `allocLink` pops through the same
   field (:554–556). Node records' field 7 is spare (`NodeField` ends at
   LIFECYCLE = 6); **link field 7 is spare too** — the dalien fix costs zero layout.
2. The stale-read sites exist: `checkDirty` reads `M[cur + NEXT_DEP]` at :761 and
   :784 *after* `update()` frames that run user getters, and its own return comment
   (:791–794) acknowledges mid-walk disposal by re-entrant user code as a supported
   scenario. `unlink` is not deferred for links (unlike node records, whose free IS
   deferred via pendingFree exactly to protect in-flight walks — the same reasoning
   was never applied to links).
3. Concrete trace = conformance case **#203 "computed disposal with unchanged-value
   sibling computed"** (harness/node_modules/reactive-framework-test-suite/src/
   effectLifecycle.ts:447): during `run(eff)`'s checkDirty, `update(a2)` calls
   `dispose(eff)` → `disposeAllDepsInReverse(eff)` frees the link `eff→b` that is
   sitting on the checkStack; the cascade (`b` unwatched) frees `b→a2`/`b→a` too.
   The unwind then pops the freed `eff→b` as `cur`, reads `sub = M[cur+SUB]` (stale
   but intact) and `nextDep = M[cur+NEXT_DEP]` — **which freeLink has overwritten
   with the prior free head**. On a fresh arena that head is 0 (walk terminates;
   test passes — which is why 179/179 stays green), but in a long-lived process
   with a populated free list the walk continues INTO the free list, treating freed
   records as live links: reads `DEP` off them, calls `update()` on whatever nodes
   those stale ids name → **silent spurious recomputes**, and (worse) `updateAndShallow`
   can shallow-propagate from them. Same-walk stale `nextSub` reads (captured
   `depSubs` freed by a cascade) stay benign in cosignal only because freeLink
   happens to leave NEXT_SUB intact — by luck of field choice, not by design.
4. The shadow arenas in concurrent.ts replicate the pattern (aFreeLink → L_NEXT_DEP,
   :946; aCheckDirty :2653; `shadowFor`'s dead-tenancy purge can free links from
   inside a fold running under aCheckDirty). Field 7 there is `L_MODE`, so the fix
   needs a different spare (candidate `L_VER`) and a 30-minute walk audit of which
   stale fields the a-walks read.

Fix shape (kernel): add `FREE_NEXT = 7` to LinkField, use it in allocLink/freeLink —
freed links then keep NEXT_DEP/NEXT_SUB/DEP/SUB naming former neighbors, exactly the
contract upstream's algorithm assumes of GC'd-but-referenced Link objects. Plus one
regression test that primes the free list (create/dispose a batch of edges) before
running the #203 schedule and asserts eval counts.

## 2. CI benchmarking

**How dalien runs benches.** Two workflows. `test.yml`: build + typecheck + vitest
(includes the bytecode budgets) on push/PR. `benchmark.yml` (the model to port):
- Harness = pinned milomg js-reactivity-benchmark clone + `benchs/ci/milomg-fork.patch`
  (median-of-N per test instead of fastest-of-N — the minimum estimator hides GC/deopt
  /finalizer amortized costs; `isolated.ts` = **one child process per framework**,
  frameworks interleaved round-robin within a round; adapters incl. dalien's `reset()`
  cleanup). The patch already carries **cosignal-family adapters** — dalien's workflow
  stubs them ("the parent repo's benchmark workflow is where cosignal is actually
  measured") — so the parent repo port is expected by construction.
- **Sharding rule: never shard frameworks or suites across runners** (cross-machine
  times aren't comparable); shard ROUNDS instead — matrix = {runtime: node,bun} ×
  {round: 1,2,3}, each round job = a complete interleaved pass on ONE runner (a
  same-machine block); the aggregate job downloads round CSVs and takes per-test
  medians across blocks (`merge-rounds.mjs`: machine speed shifts a whole block
  together, so cross-framework *ratios* stay honest).
- Noise discipline on hosted runners: treat <~5% run-over-run as weather; the
  meaningful number is framework-vs-framework *within* one run. Concurrency group
  keyed by trigger (a doc push must not cancel a long dispatch). Dispatch inputs:
  framework list (default = contested cluster), shard count ("more shards = tighter
  medians at same wall-clock"), runner label (`vars.BENCH_RUNNER` for a self-hosted
  fleet — all shards same label). Artifacts: per-round CSV → merged CSV + SVG→PNG
  (headless Chrome) + job-summary totals table; `pull-run.mjs` syncs a green run's
  artifacts + README chart blocks back into the repo.

**Porting proposal for cosignal** (`.github/workflows/benchmark.yml` in the parent repo):

1. *Job family A — suite comparison (milomg)*: checkout parent repo (has
   `milomg-reactivity-benchmark/` conventions already; otherwise clone pinned SHA +
   apply `packages/dalien-signals/benchs/ci/milomg-fork.patch` — no cosignal stubs
   needed here, the real packages are present). Matrix {runtime} × {round 1..3};
   default frameworks `"Cosignal" "Cosignal Concurrent" "Alien Signals" "Dalien
   Signals" "Reactively"`; each round = one runner, interleaved, `--rounds 1`;
   aggregate job = merge-rounds medians + chart + summary. This is the
   one-process-per-measurement methodology dropped onto runners unchanged.
2. *Job family B — cosignal gate benches*: `packages/cosignal/bench/*.mjs` parents
   are already spawn-per-config drivers (util.mjs: `node --expose-gc --import tsx`,
   cwd=harness, medians AND [min..max] across ≥5 children, checksums vs DCE, @@ROW
   jsonl). Matrix = one runner per gate family: {spkl, spkw+spkw-quiet, spkn1,
   spkr-core, spkg8, spka-sa-gates} (spkk1 soak nightly-only, 120 s × PROCS). The
   DIRECT vs LOGGED/quiet A/B stays same-runner *by construction* (one parent spawns
   both configs interleaved). For HEAD-vs-anchor A/B (the spka-sa-gates pattern):
   checkout both refs into two directories on the SAME runner and run the dual-tree
   `COSIGNAL_ROOT=` protocol; report ratios, never cross-job absolute ns.
   Each job appends its gate table to `$GITHUB_STEP_SUMMARY` and uploads the jsonl
   rows as artifacts; a final job concatenates them into one
   `cosignal-gates-<sha>.md` artifact mirroring research/experiments/cosignal-gates.md.
3. *Noise discipline*: medians + ranges everywhere (util.mjs already emits both);
   flag PASS/FAIL only on ratio gates with same-runner denominators (≤1.4× S-A, ≤2×
   SPK budgets, O19 residual); annotate every summary with `uname -m`, Node version,
   and runner label; pin Node 24.x; `timeout-minutes` generous (S-A + spkl ≈ minutes,
   full family A dispatch = hours); BENCH_RUNNER repo variable for a quieter fleet.
4. *Regression anchoring*: run family B on PRs touching packages/cosignal/src with
   HEAD-vs-merge-base dual-tree A/B; family A on push to main + manual dispatch.

## 3. Ranked campaign proposal

Ordering metric: (win × confidence) / effort; correctness and campaign-unblockers
outrank raw ns.

- **B0 — guard rails (S, do first, ~1 day total).**
  (a) Row 2 kernel freelist fix (FREE_NEXT=7) + primed-freelist #203 regression test —
  correctness, confidence 1.0, also de-risks every measurement after it.
  (b) Row 6 bytecode-budget spec — records baselines (will flag checkDirty), locks
  the inline wins B2 will land. (c) CI workflow family B skeleton (§2.2) so every
  later batch has same-runner A/B numbers; family A (milomg) can follow.
- **B1 — S-A cold-pass shave (S–M): `shadowFor` probe fusion + `aNoteAtom` epilogue
  inlining** (concurrent.ts:2342/:2395). The P2 S-A stage is STOPPED at the cold-pass
  gate breach — 669.6 ns vs 465.0 anchor = 1.440× vs the 1.4× budget (ca04129); the
  shave needed is ~3%. aNoteAtom's epilogue calls shadowFor (byNode probe + nodeGen
  load + GEN compare) then re-loads flags; fusing the probe into the caller and
  inlining the epilogue into the fn-reader removes a call frame + duplicate loads on
  exactly the per-cold-read path the gate prices. Gate-clearing binary win; unblocks
  the active design-loop stage. Policed by SA (both gates), PKG divergence check.
- **B2 — checkDirty family (M): row 10** (wrapper + shallow + two-level + chainCheck
  + out-of-line loop) under B0(b)'s budgets. dalien-measured small-cone win
  (1.05–1.3× → 0.9–1.1× vs upstream) + inline eligibility for run/computedReadSlow.
- **B3 — quiet-epoch VSTAMP (M–L): row 1** (LIFECYCLE→flags bit; f64 stamp view;
  D2/HAS_BOX/settlement interactions as listed). Read-heavy/dynamic-shape win;
  measure on T0 readPoll/diamond + SPK-L before/after.
- **B4 — parked seam items (M/L, owner input on the second).**
  (a) watch1 quiet-write overhead **+13.2%** (3ca5f3f; +12.1% at re-baseline, vs the
  ~10% criterion) — profile the quiet fold path (stamp check → fold → equality →
  apply → observer reconcile) and shave the excess; medium confidence until profiled.
  (b) bare-write **~7 ns seam floor** (≈4 ns pre-existing host-seam + ≈3 ns fold on a
  4.8 ns kernel write; +148.7% relative, small absolute) — the named fix is
  compiling the routing check INTO the kernel operation table / a build-tier split
  ("held for Jake", P1 §SPK-L note); a design decision, not a micro-patch. Also
  covers the armed-idle broadIsolate residual (+18%).
- **B5 — insurance & polish (S–M each, schedule opportunistically):** row 11 adaptive
  seeding (+phaseTransition probe); row 4 keepNames audit; row 9 growth-posture
  measurements + default-capacity decision; row 14 microtask maintenance; row 7
  alloc micro-tidy; row 15 test-only `__reset()` for harness fairness.
- **Parked:** row 3 FR lifecycle (memory feature, D4 anchor conflict, no speed win);
  row 2's shadow-arena freelist twin lands with B1's concurrent.ts work if its
  mini-audit confirms reachability (it is the same pattern, so default-assume yes).

## B3 outcome (2026-07-06): quiet-epoch port REJECTED BY MEASUREMENT

Ported completely (three subtleties pinned + mutation-tested; full
battery green; 290+1 tests) and measured net-negative on EVERY gate
shape: reads +3.1% (the designated 0.67x winner!), isolate +9.2%,
write +1.5%, deepPropagate +7.9%. Structural root cause: a stamp hit
can only occur when flags are also clean, so the stamp is a strictly
redundant second certificate over cosignal one-load flags fast path —
the D3 hot/cold split already banked the win dalien bought with its
heavier pre-stamp ladder (retired check, getter carry, FN_INSTALLED).
Ceiling argument: even the record-0 epoch-slot lever caps at ~parity
on the winners. Reverted per gate discipline; port + pins archived at
research/experiments/b3-quiet-epoch-rejected/ (383-line patch +
222-line spec). Do not retry without invalidating the ceiling
argument.
