# Simplification r3 — cross-panel triage

Inputs: the five independent reviews `2026-07-06-simplification-r3-{codex-max,codex-xhigh,fable,opus,sonnet}.md`
(CM / CX / F / O / S below), each verified against the code at HEAD before disposition.
Dispositions: **EXECUTE-NOW** (this batch), **OWNER** (needs a decision, a bench, or a coordinated
change — one plain sentence each), **DROPPED/REJECTED** (with reason).
Ranked by convergence × leverage within each disposition.

## EXECUTE-NOW (the SAFE batch)

| # | Finding | Flagged by | Their verdicts | Merged verdict | Notes from code verification |
|---|---------|-----------|----------------|----------------|------------------------------|
| E1 | The `tr.opEnd(); flushNotify()` tail ×9 → `endOp` (the `runOp` shell half and O4's `runCommittedBoundary` both dropped — see notes) | S2, O4 | SAFE, SAFE | SAFE (scoped) | Two halves of the proposal failed code verification: (a) O4's "identical ×4 committed-boundary epilogue" is semantic variance, not copy-paste (retire/commit run no `directFlushCoreEffects`; decay and drain scopes differ per site); (b) S2's `runOp(() => …)` shell would allocate a closure per recorded write — the write path's no-allocation discipline forbids it, so the four 5-line `opDepth` shells stay inline. The ×9 verbatim tail landed as `endOp`. Write path → spkl A/B: clean. |
| E2 | Compare-and-correct block ×4 → `correctWatcher(w, node, now, cause)` | F2, O5 | SAFE, SAFE | SAFE | Verified byte-level: settlementDrain (cause 'retirement'), quietDrain (no event), drainCommittedObservers (cause param), mountFixup ('mount-urgent-correction' event). Event payloads preserved exactly; helper returns changed for mountFixup's trace arm. |
| E3 | World-resolution preamble ×2 (hostRead/hostComputedRead) + stamp-validate rule ×2 (nodeFor/nodeForComputed) + dead `effectiveWorld` | F6, O6 | SAFE, SAFE | SAFE | `effectiveWorld` confirmed zero call sites → delete. Resolution helper uses a scratch field (no per-read tuple allocation — routed reads are warm). nodeFor is on the write seam → spkl + cold-pass A/B. |
| E4 | `AtomCtx.set/update` re-implement `Atom.set/update` → delegate | F3, CX11 | SAFE, SAFE | SAFE | Bodies verified identical (same hook check, same writeAtom/runFold). Named delta: subclass overrides now honored by the lifecycle ctx — no test pins the bypass. |
| E5a | Shim dead state: `rootsById` map, `RootRec.lineageId`, `RootRec.lastCommitGeneration`, `RootRec.container` | CM11, CX11, F5 | SAFE ×3 | SAFE | All four verified written-never-read (container only via the map key, never the field). Protocol params stay; the stores go. |
| E5b | Oracle dead state: `SlotMeta.carriedMaxRetiredSeq`; `Token.writeSeqs[]` → scalar `lastWriteSeq`; dead `Token.committedFlag` (both sides) | F5 (+CM10 names the dead flag) | SAFE | SAFE | carriedMaxRetiredSeq: init/max/zero, zero reads. writeSeqs: only last element read (mountFixup) — engine twin already scalar. committedFlag: written-never-read in BOTH engine and model (the retired event carries the parameter, not the field) — paired deletion, lockstep referees it. |
| E5c | Oracle `Priority` phantom: Token field, `openBatch` param, `ScheduleOp.open.priority`, generator draw, 2 scar assertions | CM9, F5 | SAFE, SAFE (seed caveat) | SAFE | Model never reads it; engine never had it. Seed-stream preservation: the generator keeps a discarded `pick(3)` draw so every historical seed reproduces its exact schedule (fable's mitigation; no corpus re-baseline). The lockstep `Both` test driver keeps its priority parameter as scenario annotation (~230 spec call sites unchanged, model side discards). |
| E6 | Cycle-error construction ×6 → `cycleError(name)`; kernelTracked/UntrackedReader shared body → `kernelReadOf(dep)` | F7, S6, O5 | SAFE ×3 | SAFE | naiveValue's copy included. Readers on the newest-evaluation path → covered by spkl A/B batch. |
| E7 | `mustGet(map, id, what)` — 3 dedicated + inline lookup-or-throw sites, engine and model independently | S4 | SAFE | SAFE (trivially mechanical) | Map ICs monomorphic regardless of K/V. adoptMount's message gains the id (tests use substring matches). Applied same-shape but independently on both sides of the referee boundary. |
| E8 | `pickId(ids, index, what)` replaces tokenAt/passAt/watcherAt/effectAt in oracle schedule.ts | S3 | SAFE | SAFE (trivially mechanical) | Subsumes fable's tokenAt-return-type small-fry. Engine-side oracle-adapter keeps its OWN copies (different id sources: registry mirrors — not the same shape; left alone). |
| E9 | Shim `onDelivery`/`onMountCorrective`/`onCorrection` re-roll `guard()` and lack its disposed-check | S5 | SAFE + bug fix | SAFE | THE one intended behavior change of the batch (pinned): post-dispose bridge callbacks become no-ops instead of relying on cleared `targets` to degrade safely. |
| E10 | "Both subs lists" idiom: 3 ad-hoc re-derivations beside aPropagateBoth/aShallowBoth | S7 | SAFE | SAFE (scoped) | S's `subHeads` tuple would allocate inside the drain walk, which documents "no allocations in the walk" — executed instead as a non-allocating `aSubsHead(a, sh, list)` used by the three ad-hoc sites (aEvictShadow's twin loops collapse to the for-list form); the two hot Both helpers keep their direct reads. |
| E11 | `readSuspending(() => shim.evaluateSuspending(...))` ×4 → one `shim.hookRead(fn)` | F11 | SAFE | SAFE (trivially mechanical) | Two halves of one concept (depth bump + thenable rethrow) merge; four hook arms become one-liners. |
| E12 | flushNewestSubs / directFlushCoreEffects duplicated per-sub body → shared `runNewestSub` | O10 | SAFE | SAFE (scoped) | The oracle already has the unified shape. Extraction only — the reach-filter vs full-scan candidate policies stay distinct (F14's proposal to delete the reach walk is OWNER, below). Write path when newest subs armed → spkl A/B batch. |
| E13 | Referee-only `mountReactEffect`/`mountReactEffectPick` constructors → test-side helper | O3 | SAFE-split | SAFE (scoped) | O3's wider claim does NOT verify: `Subscription.body`, the body arm of runCommittedSub, `captureRead`, and `replayReactEffect` are the event-minting inline-run mechanism lockstep compares — moving them would erase the engine's react-effect-run events. Only the two 4-line convenience constructors move (callers: tests only, verified). |
| E14 | `BridgeEvent` ≡ `ModelEvent` type-assignability pin in the lockstep harness | F10 (pin half) | SAFE | SAFE | Non-distributive `[A] extends [B]` both ways in tests/oracle-adapter.ts (already imports both). Converts a JSON-diff-only convention into a typecheck failure. |
| E15 | Small-fry sweep: one-member `SlotBits` enum → literal; stale memo-ladder comments (AtomNode.retirementStamp, __quietWrite); `'root-unknown'` sentinel constant ×2; `aEqAtom` unused param; kernel/arena twinning-obligation note (S1's mitigation) | F small-fry, S1 (comment) | SAFE | SAFE (trivially mechanical) | Comments-and-cosmetics only; zero behavior. |

Batch constraints honored: no behavior change except E9's pinned disposed-check; bytecode budgets
re-checked every battery (bytecode.spec is in the suite); spkl quick A/B for E1/E3/E6/E7/E12
(write/read-path touches); cold-pass gate (spka) for E3.

## OWNER (a decision, a bench, or a coordinated change — in plain language)

Ranked by convergence × leverage.

| # | Finding | Flagged by | Verdicts | The trade, in one sentence |
|---|---------|-----------|----------|---------------------------|
| W1 | Slot sets stored as Sets AND bit words through Pass/WatcherSnapshot/mountFix worlds; `includedSet`/`committedSlotsNow` allocate | CM5, CX6, F1 | SAFE, SAFE, TRADE | Collapsing onto the int form deletes ~8 fields/methods and per-pass allocations, but it crosses the referee surface (tests/model-view.ts consumes the Set forms and the bridge types are documented as structurally mirroring the model), so engine + model-view + hand-built snapshot tests must move in one coordinated change. |
| W2 | The mount "fast path" is a second correction policy, not a skip (fastOut checked after the fold; suppresses urgent correction rather than avoiding work) | CM2, CX2 | TRADE, QUESTION | Restating the rule directly could delete cas/commitGen/baseline/audit-world plumbing (~14 mirrored decisions), but sonnet independently verified each conjunct is fuzz-motivated and self-auditing, so this needs the owner to confirm the intended general rule before anyone touches flag-5 seeds 29/173 territory. |
| W3 | Referee machinery inside the production bridge: armed checker + naiveValue (a third evaluator) + aValidate (~350 lines) and the `naiveFold` branch on the hot read path | F9, O2, CX5, CM3 | TRADE, TRADE/SAFE-split, SAFE, TRADE | Moving the checker out (or folding `naiveFold` into the serve-override slot to delete one hot-read branch) trades a wider `__internal` accessor surface for a smaller shipped class, and the hot-branch half needs the cold-pass bench re-run. |
| W4 | Lockstep runs different write semantics than production (quiet writes disabled for referees; attaching a tracer disables quiet mode, contradicting the "without perturbing" claim) | CM3, CX4, CX5 | TRADE, SAFE, SAFE | Modeling the quiet fold in the oracle would let lockstep referee the real production path and make tracing non-perturbing, at the cost of a significant oracle/harness rework and re-baselined event expectations. |
| W5 | BridgeEvent objects vs TraceHooks packed records: tracing allocates the object it then re-packs through an 18-case switch | CM4, CX4 | TRADE, SAFE | A single scalar event vocabulary would honor the zero-allocation claim and delete the translation switch, but it is a trace/test-adapter rewrite and fable prices the current two-channel design as the cheaper-than-double-instrumenting compromise. |
| W6 | One write crosses three representations (scalar pair → `Op` object → packed columns; `applyOp` + `applyOpPacked`) | CX3 | TRADE | Keeping (kind, payload) canonical through the write path deletes an allocation per recorded write and one apply implementation, but `Op` is an exported power-user type so this is an internal API break needing compatibility wrappers. |
| W7 | `eqAtom` equality-dispatch ×5 + writeInner's set-fast-path double arms | F4, F12 | SAFE (bench-gated) | The helper extraction is probably free but the sites are the recorded-write and fold paths, so it needs the SPK write-storm gates run before landing (explicitly bench-gated by the reviewer). |
| W8 | Host-seam checks ×4 on `Atom.state/set/update`/`Computed.state` — the hottest path in the library | S8, CX7 | QUESTION, TRADE | Any merge (including CX7's one-hook-with-kind-code form) sits on every public read/write, and this file's own history shows helper extractions here regress double-digit percents, so benchmark first or leave alone. |
| W9 | Synthetic core effects: the bridge's `newest` subscription variant re-implements `effect()` (mountCoreEffect, reach walk, two flush forms) | CM1, F14 | QUESTION, QUESTION | Deleting the reach walk (or the whole synthetic variant in favor of real `effect()` mounts) removes ~16 conditional sites but changes WHEN untracked sampling happens in corner cases, so it must be tried under the fuzz corpus and the owner must rule whether `mountCoreEffect` is supported API or referee-only. |
| W10 | Kernel-layout constants: AF mirrors NodeField by hand and three kernel-buffer walks depend on the equality | F8, O1-sub | TRADE, SAFE-ish | Exporting shared layout constants (or one shared const-enum module) retires a hand-maintained cross-file invariant but risks the same-file const-enum inlining the kernel's speed identity depends on — needs a bytecode.spec/bundle check before choosing a shape. |
| W11 | Root lock-in has two owners: engine passEnd vs shim's defensive delta reconciliation (which updates only committedTokens/commitGen, leaving committedBits/cas/arena fanout stale if it ever fires) | CX1 | SAFE (per CX) | One idempotent `commitTokens(rootId, tokens)` bridge operation would make the shim's defensive path update ALL the invariant's fields, but it restructures the commit path and needs a new test for the root-report-with-unlocked-live-token shape — not mechanical. |
| W12 | Retirement's `committed` flag threaded through retire/settle/shim/schedule/trace as if semantic (both values behave identically) | CM10 | TRADE | Dropping the parameter chain (the dead FIELD is already deleted in E5b) simplifies a dozen signatures but loses the trace's committed-vs-abandoned distinction unless a diagnostic seam replaces it. |
| W13 | Oracle differ materializes the whole expected run before comparing (`runScheduleStepwise` retains every snapshot) | CM7 | SAFE (per CM) | Interleaving model-step/engine-step/compare drops peak referee memory from O(schedule × snapshot) to O(1) with identical failure reporting, but it restructures the oracle's public diff harness — cheap, just not this batch's mechanical tier. |
| W14 | Oracle newest-state cache lives out-of-band (`newestSamples`/`samplingStack` maps) and the README's "no caches" claim contradicts it | CX8 | SAFE (per CX) | Moving the memo onto ComputedNode and re-documenting it as the semantic cache the untracked contract requires is a clean oracle-side change the oracle's owner should shape (it edits the reference model's stated independence argument). |
| W15 | Dev-warn heuristic allocates on the write path (`liveTokens()` spread+filter per classified write) with no dev-build guard | CX9, F small-fry | TRADE | Either delete the lint or keep it behind a real dev-build condition with a scalar parked-count — the owner owns the DX-vs-write-cost call. |
| W16 | React adapter maintains "unreachable" ambient/defensive modes (classifyWrite token-0 arm, stale-pass repair, optional transition token) | CX10 | QUESTION | CX wants protocol-absence to fail fast (deleting ~9 conditionals) while fable explicitly defends the same branches as correctly-shaped protocol-edge defense — a genuine design disagreement only the owner can settle. |
| W17 | `mode: 'direct'` write arm reachability in production | O13 | QUESTION | If only bare `CosignalBridge` constructions (tests) can reach it, the arm should be documented as referee affordance or deleted — confirm against the harness. |
| W18 | `visibleAt` exists three times (engine packed, oracle, model-view twin) | F10-question half | QUESTION | Exporting the oracle's Receipt-shaped rule for model-view's use would cut 3 copies to 2 without touching the engine — small, but it changes what the referee twin independently re-states. |
| W19 | `rendered ⊇ mounted` forces skip-checks and a double-visit at pass end | F13 | QUESTION | Making the sets disjoint deletes the filter and the concat double-visit but is a contract-shape change that must move engine and oracle together and re-baselines any scar inspecting pass.rendered. |
| W20 | ActionScope duplicates the write classifier (`scope.set/dispatch` reconstruct ops; omits `update`) | CM6, F small-fry | TRADE | `scope.run(fn)` over `unstable_runInBatch` would collapse ~6 conditional sites onto the one classifier but is a breaking public-API change for cosignal-react users. |
| W21 | Cold kernel-deps DFS pair: `closureOverKernel` / `newestReaches` are the same walk ± early-exit | O8-safe half | SAFE (per O) | Mergeable in isolation, but W9 proposes deleting `newestReaches` outright — sequence this after the owner rules on W9 so the merge isn't immediately unwound. |
| W22 | `replayPure` idiom (×3 `inCallback(() => __hostRunFold(...))`) + `writeAtom`/`__assertHostWritable` duplicated policy check | O7-safe half, F small-fry | SAFE (per O) | Both sit on the fold/write hot paths (writeAtom is THE write path), so per this repo's own discipline they are bench/bytecode-gated despite being two-line extractions. |
| W23 | `quiet` falsified directly at 2 sites vs `recomputeQuiet()` at 6 — two writers for one derived flag | F small-fry | SAFE (per F) | Routing all eight through recomputeQuiet gives the flag one writer but asserts the derivation is false at those two sites — verify the invariant before unifying. |
| W24 | `arenaInitInts` ignores the class's own `__setXForTest` convention | S9 | QUESTION | Whether it becomes a configure() production knob or a `__setArenaInitIntsForTest` mutator is a product-surface decision. |
| W25 | `onBeforeMutation`/`onAfterMutation` declared in react-fork.d.ts but never wired | S10 | QUESTION | Either forward-documentation (add a one-line "unused by this driver" note) or dead protocol surface — the fork's owner knows which. |
| W26 | `dispose()` clears the active shim via a `getActiveShim() === undefined` side-effect equivalence | F small-fry | SAFE (per F) | An explicit `unregister(shim)` states "don't clobber a successor" directly — tiny, but it adds shim-registry API, so bundled here rather than in the mechanical batch. |

## DROPPED / REJECTED

| Finding | Flagged by | Reason |
|---------|-----------|--------|
| Full kernel/arena walk unification (~600-800 mirrored lines) | O1, S1, CM8 (checkDirty arms), O9 (box protocol) | REJECTED — every reviewer who priced it leans keep: the mirror is the package's measured performance thesis (closure-constant buffer, same-file const enums, the 4.9× segregated-list A/B, the 460-byte inline cliff), and fable/sonnet both file it under already-minimal. The one drift-catching mitigation (S1's explicit twinning obligation) executes in E15; the layout-constants edge is W10. |
| Eval-frame save/restore ×5 `withEvalFrame` helper | O11 | REJECTED — opus's own verdict: the repetition IS the measured no-allocation frame (a config-object helper reintroduces the allocation the cold-pass gate priced out); priced hot path per the batch rules. |
| Quiet-mode as a parallel write path | O12 | REJECTED — the branch IS the feature (sync-by-default skips receipt machinery); E1 shrinks its tail incidentally. |
| Generic `arenaWalk(a, start, dir, mode, visit)` over the five arena DFSs | O8-hot half | REJECTED — megamorphic-visitor cost on write/commit/mount walks, the exact cost the kernel hand-inlines to avoid; opus leans keep. |
| O4's `runCommittedBoundary` as a single ×4 epilogue | O4 (this half) | DROPPED — verified against the code: the four sites differ in drain scope, decay scope, and newest-flush presence (retire/commit run NO core-effect flush; quiet/settlement do), so the "common tail" is semantic variance, not copy-paste; the verbatim parts land via E1/E2. |
| Fold-purity mechanism unification (POISON table vs inFoldCallback) | O7-trade half | REJECTED — the two mechanisms cover disjoint entry points (raw kernel access vs bridge-routed reads); collapsing either direction opens a gap; both reviewers who studied it say keep. |
| `Subscription.body`/`captureRead`/`replayReactEffect`/body-arm relocation (O3's wider half) | O3 | DROPPED — verified load-bearing: the body arm is what mints the react-effect-cleanup/run events lockstep compares; only the convenience constructors move (E13). F9's naive-checker relocation half is W3. |
| Oracle naivety optimizations (full rescans, memo-free evaluation) | (defended by F, O, S) | REJECTED — the model's authority is its waste; every reviewer independently defends it. |

## Execution outcomes (all 16 items landed; batch complete)

Every item ran against the full cosignal battery (24 files, 314 passed / 1 skipped — includes the
45/45 bytecode budgets and the ARMED lockstep corpus: 300 seeds × 80 steps + 8 × 400 + flag-5 seeds
29/97/173, zero diffs throughout) plus react/oracle batteries when their files changed.

- E1 endOp ×9 — scoped per the notes above (runOp shell + runCommittedBoundary dropped as unverified/allocating).
- E2 correctWatcher ×4 — event payloads byte-identical (drains log with cause; quiet logs nothing, structurally guaranteed and kept explicit; mount logs mount-urgent-correction).
- E3 resolveRoutedWorld (scratch-field form — zero new allocation) + resolveStamped + dead effectiveWorld deleted. Cold-pass gate: 542 → 425–475 ns; wide-mask: parity; checksums identical.
- E4 AtomCtx.set/update delegate to the public methods (subclass-override delta noted in a comment).
- E5a shim: rootsById map, RootRec.{container, lineageId, lastCommitGeneration} deleted (protocol params kept, underscore-named).
- E5b oracle: carriedMaxRetiredSeq (4 sites) deleted; writeSeqs[] → scalar lastWriteSeq (engine-twin shape); dead Token.committedFlag deleted from BOTH engine and model in lockstep.
- E5c Priority deleted end-to-end (model Token/openBatch, ScheduleOp, generator, 115 direct oracle-test call sites, 2 scar assertions → ambient-flag asserts); the generator keeps one discarded pick(3) so the historical seed stream is byte-identical — no corpus re-baseline, flag-5 seeds still reproduce; the lockstep Both driver keeps `_priority` as a documented scenario annotation (~230 spec sites unchanged).
- E6 cycleError (6 sites) + kernelReadOf (2 readers).
- E7 mustGet — engine (5 sites) and model (5 sites), independently.
- E8 pickId — 4 pickers collapsed; tokenAt's lying `| undefined` return type gone with them.
- E9 guard() reuse on onDelivery/onMountCorrective/onCorrection — includes THE batch's one behavior change (pinned): post-dispose bridge callbacks are now no-ops via guard's disposed-check.
- E10 aSubsHead at the 3 ad-hoc both-lists sites (aEvictShadow's twin loops collapsed); sonnet's tuple form rejected (would allocate inside the no-allocation drain walk).
- E11 shim.hookRead — readSuspending + evaluateSuspending merged; 4 hook arms are one-liners.
- E12 runNewestSub shared firing body; reach-filter vs full-scan candidate policies intact.
- E13 mountReactEffect/Pick moved to tests/helpers.ts (mountEngineReactEffect/-Pick); 6 caller files updated; body/captureRead/replayReactEffect stayed in-engine (verified load-bearing for lockstep event minting).
- E14 BridgeEvent ≡ ModelEvent mutual-assignability pin in tests/oracle-adapter.ts — passes today, drift now fails typecheck.
- E15 SlotBits enum → literal (5 sites); retirementStamp/__quietWrite memo-ladder comments re-docced; ROOT_UNKNOWN constant hoisted; aEqAtom's unused param dropped; the kernel/arena twinning obligation written at both walk sites (S1's mitigation).

Net diff: src −49 lines (296 added / 361 deleted across the six source files; concurrent.ts −25,
shim.ts −16, hooks.ts −12, schedule.ts −10, model.ts −6, index.ts +4 counting the new twin note),
tests reshaped for E5c/E13/E14.

## Final verification (post-batch)

- cosignal: 24 files, 314 passed / 1 skipped; tsc clean. Bytecode budgets 45/45. Armed corpus zero diffs.
- cosignal-react: 5 files, 62 passed; tsc clean.
- cosignal-oracle: 4 files, 81 passed / 1 skipped; tsc clean.
- Conformance: FRAMEWORK=cosignal 179/179; cosignal-concurrent 179/179; arena 179/179.
- spkl (PROCS=3) before/after: residuals within the baseline's own run-to-run spread on all four
  shapes (readPoll's % swing is ±0.15 ns on a 2.5 ns op; absolute logged-quiet costs unchanged);
  spka gates: cold-pass 542 → 425–475 ns/computed, wide-mask 182 → 171–189 µs, work checksums
  identical (477600 / 252000).
