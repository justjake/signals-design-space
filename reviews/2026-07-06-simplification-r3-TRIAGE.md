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

Every item below needs an owner decision, a benchmark, or a coordinated multi-package change — nothing here is safe to land mechanically. Each item was re-verified against the code at HEAD (after the SAFE batch, commit aa1ccb4); where that batch already changed part of an item, the item says so. W-numbers preserve the panel's convergence-times-leverage ranking; the theme headings only group siblings.

**The cast, once — every item uses these words in these senses.** The **kernel** (`packages/cosignal/src/index.ts`) is the fast core signal engine: signals, computed values, and their dependency links live in packed integer arrays, and each signal holds exactly one "current" value. The **bridge** (`src/concurrent.ts`) makes that kernel safe under React's interruptible ("concurrent") rendering: it records every write as a **receipt** (a log entry tagged with the update batch it belongs to) and answers reads from named **worlds** — points of view such as "newest state", "what this in-progress render is allowed to see", or "what this React root has committed to the screen". Render-pass and committed worlds are served from **shadow arenas**: a second packed-array copy of the dependency graph, one per world. A **token** identifies one update batch; a **slot** is one of at most 31 recycled small integers naming a live batch, so a set of batches fits in the bits of one integer. A **pass** is one render pass of a React root; a **watcher** is the bridge's record for one component that subscribed to a signal and may need re-rendering. The **shim** (`packages/cosignal-react`) is the React adapter: it listens to a patched React build's protocol events (render pass started/ended, batch retired, root committed) and translates them into bridge calls. The **oracle** or **reference model** (`packages/cosignal-oracle`) is a second, deliberately slow implementation of the same rules in plain objects; **lockstep** tests feed one script of operations to both engine and model and compare state and event logs after every step, and the **fuzz corpus** is thousands of such scripts generated from fixed random seeds, so every failure replays exactly.

### Two representations of one thing

#### W1 — Slot sets are stored twice: as JavaScript Sets and as bit masks (flagged by 3 of 5 reviewers)
- **What exists today:** Because at most 31 batches are ever live, "a set of slots" fits in one integer, and the engine's hot visibility checks already use that form. But each pass record carries the same membership twice — `maskSlots`/`capturedCommittedSlots` as Set objects and `maskBits`/`includedBits` as integers — every watcher's mount snapshot copies the Set forms, the mount-reconciliation world carries a Set, and two helpers (`includedSet`, `committedSlotsNow`) allocate fresh Sets on demand.
- **What's awkward:** One fact, two live representations to keep in sync; every pass start, mount, and re-render allocates Set copies of data the integers already encode.
- **The proposed change:** Make the integer form the only one inside the engine (~8 fields/methods deleted; snapshot copies become two integer assignments). The oracle keeps its Sets.
- **The cost or risk:** The change crosses the referee surface: the test harness includes a translation layer (`tests/model-view.ts`) that presents engine internals in the same shape as the reference model so lockstep can compare them field-by-field, and that layer consumes the Set-form accessors — engine, translation layer, and hand-built snapshot tests must move in one coordinated change. No behavior change expected; allocations go down.
- **The decision being asked:** Approve one coordinated engine + test-harness change making bit masks the only in-engine slot-set representation?

#### W5 — Diagnostics speak two languages: event objects and packed trace records (2 reviewers)
- **What exists today:** The bridge reports what it does as `BridgeEvent` objects (`{type: 'write', node, token, …}`), consumed by tests and the lockstep referee. The production tracer (`src/trace.ts`) is a separate diagnostics recorder that stores fixed-size integer records and whose header advertises "recording an event allocates nothing". The tracer is fed from the object stream: attaching it switches event minting on, so each event site allocates an object, and an 18-arm switch in the tracer re-packs each object into integers (4 of the arms exist only to discard events the tracer receives again via richer dedicated hooks).
- **What's awkward:** Two vocabularies for one stream plus a translation switch between them — and attaching the tracer causes exactly the per-event allocation its own header rules out.
- **The proposed change:** One scalar (numbers/strings, no object) event vocabulary; the tracer packs directly, and object events are materialized only when tests ask for them.
- **The cost or risk:** A substantial trace + test-adapter rewrite; one reviewer prices the current two-channel design as deliberately cheaper than instrumenting every site twice, so this is a judgment call, not a bug fix.
- **The decision being asked:** Retire the object-event channel (big rewrite), or accept and document the allocate-while-tracing exception?

#### W6 — One write crosses three shapes (1 reviewer)
- **What exists today:** A public write leaves the kernel's method as a scalar pair (integer op-kind + payload). The bridge's hook rebuilds it into an `Op` object (`{kind:'set', value}` or `{kind:'update', fn}`), the shim's classifier passes that object through several layers, and recording the write unpacks it again into the per-atom receipt log's packed integer columns. Two apply implementations exist, one per shape (`applyOp` for the object, `applyOpPacked` for the columns).
- **What's awkward:** Each recorded write allocates an Op object exactly where the packed log was built to avoid allocation, and every new op kind must be handled in three shapes. (Quiet-mode writes — the nothing-pending fast fold, see W4 — already bypass the object.)
- **The proposed change:** Keep the scalar (kind, payload) pair canonical through the classifier and write path; materialize an Op object only for diagnostics/compatibility; delete one apply implementation.
- **The cost or risk:** `Op` is an exported power-user type and several bridge/shim methods accept it — an internal API break needing compatibility wrappers; oracle schedules and the transition scope (W20) update mechanically.
- **The decision being asked:** Approve breaking the internal Op-object plumbing (wrappers kept for the exported type)?

#### W10 — The bridge hand-copies the kernel's memory-layout constants (2 reviewers)
- **What exists today:** Kernel node fields live at fixed offsets in one big integer array, named by a const enum. TypeScript const enums inline as literal numbers only within their own file — exporting them costs runtime property lookups — so the kernel doesn't export them, and the bridge declares its own copy (`AF`/`AFlag`) documented as "mirroring" the kernel's numbers. Three bridge functions walk the kernel's own array using the mirror (dependency listing, W9's reach test, the mount-closure walk), so the two enums being equal is load-bearing — enforced only by a test assertion and comments.
- **What's awkward:** A silent cross-file contract: a kernel field reorder keeps the kernel green while corrupting three bridge walks in ways only the fuzz suite might catch.
- **The proposed change:** Export one shared source of truth for just these layout numbers (a tiny plain-const view or a shared const-enum module) and use it at the three walk sites, retiring the hand-maintained mirror obligation.
- **The cost or risk:** Cross-file constants can compile to property loads after bundling — the exact cost the kernel's measured speed identity avoids — so the chosen shape must pass the bytecode-budget test and a bundle check first; the three walks themselves are cold-to-warm.
- **The decision being asked:** Approve a shared layout-constants module, contingent on the bytecode/bundle check showing no inlining loss?

#### W18 — The receipt-visibility rule is written out three times (1 reviewer)
- **What exists today:** "Which recorded writes does world X see?" is the system's central rule. Two copies are intentional: the engine's (packed form, `visibleAt`) and the oracle's (plain-object form, `visible`) — the oracle must stay independent to be a referee. A third copy lives in the test harness's translation layer (`tests/model-view.ts`, see W1), which restates the rule so lockstep can compare engine state to model state.
- **What's awkward:** Three statements of the one load-bearing rule; the third exists only because the oracle's isn't exported.
- **The proposed change:** Export the oracle's object-shaped rule as a standalone function and have the translation layer call it — three copies become two (the intended pair), engine untouched.
- **The cost or risk:** Small, but the translation layer would then share code with the model it compares against, trading away some of its value as an independent restatement. (Related: the SAFE batch's E14 already pinned the engine and model event types to each other at the type level.)
- **The decision being asked:** Should the translation layer reuse the oracle's exported visibility rule (yes) or keep its independent restatement (no)?
### The mount "fast path" — a semantics question, not a refactor

#### W2 — The mount fast path suppresses corrections; it does not skip work (2 reviewers)
- **What exists today:** When a pass commits, each component mounted during it gets a reconciliation step ("mount fixup"): (a) a catch-up re-render is scheduled into the lane of every still-live batch that wrote the component's inputs but wasn't included in its render, and (b) the component's rendered value is compared against a fresh evaluation to decide whether an urgent before-paint correction is also needed. A four-condition "fast path" (same pass; no global committed-truth advance since the render pinned its viewpoint; the root's commit generation unchanged; write clocks quiet) is documented — oracle README and FLAGS.md — as allowed to SKIP the comparison. In the code (engine and model alike), the fresh value is always computed first and the fast path only decides whether a difference triggers the urgent correction; a difference it suppresses triggers a second "audit" evaluation proving the scheduled catch-ups exactly cover it, throwing an invariant violation otherwise. Supporting this proof: a captured baseline, a global commit clock (`cas`), per-root commit generations, per-token write clocks, and a second evaluation world — all mirrored in the model.
- **What's awkward:** The "fast path" skips neither the evaluation nor the comparison, and ~14 mirrored decisions across engine and model encode a correction-timing rule that has never been stated directly.
- **The proposed change:** The owner states the intended general rule (candidate: "newly-locked post-pin writes correct urgently; late writes from foreign or already-committed live batches may wait for their scheduled lane"), then the code says it directly — either always-correct-on-difference (delete the fast-out state and audit world) or genuinely test-before-evaluate (delete the audit, giving up its runtime soundness check).
- **The cost or risk:** The most semantically delicate item on this list: sonnet independently verified every conjunct is motivated by a specific fuzz finding, and any change re-baselines render counts and trace expectations pinned by named fuzz seeds (flag-5 seeds 29/173) and battery cases.
- **The decision being asked:** Will you ratify the intended correction rule so this plumbing can be collapsed against it — or freeze the area as-is?

### Test machinery living inside the shipped engine

#### W3 — A referee-grade divergence checker ships inside the production bridge (4 reviewers)
- **What exists today:** Compiled into every production build of the bridge class: an armed self-check (`__checkArenas` — off by default, switched on by the test harness) that after each operation re-derives every value naively and compares it against the engine's own answers; the naive evaluator behind it (`naiveValue` — a third evaluator besides the engine's and the oracle's); and a structural arena validator (`aValidate`). Roughly 350 lines including their test seams. One piece taxes the hot path: every routed read checks the checker's routing override (`naiveFold !== undefined`) even though production never sets it. (The SAFE batch's E13 already moved the referee-only effect constructors out to the tests; this is what remains.)
- **What's awkward:** The class is simultaneously the engine and its own test harness — its public surface needs "referee" comments to be readable — and production reads pay an always-false branch for a checker they never arm.
- **The proposed change:** Two independent steps: (1) fold `naiveFold` into the existing serve-override slot (the two are never both set), deleting the hot-read branch; (2) move checker + naive evaluator + validator into a test-side module fed through one `__internal` accessor (~180 lines leave the shipped file).
- **The cost or risk:** Step 1 touches the most-audited read path, so the cold-pass benchmark gate must be re-run; step 2 widens the internal accessor surface while shrinking the class, and the checker's discipline (arena answers computed BEFORE comparing) must survive the move. The retained-event log stays either way — it is the tracer's channel.
- **The decision being asked:** Approve moving the checker out of the shipped class (and the hot-branch fold-in, benchmark permitting)?

#### W4 — Lockstep referees different write semantics than production runs (2 reviewers, 3 findings)
- **What exists today:** In production, while nothing is pending, a write takes "quiet mode": one direct fold into committed state — no token, no receipt, no event (the package's sync-by-default posture). The oracle models always-receipt behavior, so test bridges are constructed with quiet mode force-disabled; the main lockstep corpus therefore never exercises the default production write path (a dedicated spec pins quiet-mode arming separately, and says so in its header). Quiet mode also requires "no event consumer", so attaching the production tracer converts quiet writes into full receipt-producing writes — contradicting the README's "observes … without perturbing what it measures".
- **What's awkward:** The strongest correctness harness doesn't test the production default, and observing an application changes its execution mode.
- **The proposed change:** Model the quiet fold in the oracle; run lockstep under production semantics; give quiet writes their own trace record so tracing stops disarming quiet mode; delete the `quietWrites` test flag.
- **The cost or risk:** A significant oracle + harness rework — event expectations re-baseline, and schedule generation may need to open batches deliberately to keep exercising the receipt machinery.
- **The decision being asked:** Fund the rework so lockstep referees the real production write path — now, later, or accept the documented gap?
#### W9 — The bridge carries a second, synthetic implementation of core effects (2 reviewers)
- **What exists today:** The kernel already has a real `effect()` (run a function now and again whenever its dependencies change). The bridge nevertheless implements a parallel "newest-policy subscription" variant used only by tests and benchmarks: `mountCoreEffect` creates a subscription that re-runs when newest state changes (distinct from the 'committed' policy real React effects use); a per-write recursive reach test (`newestReaches`, walking the kernel's dependency links) decides which such subscriptions a write might affect; and a full-scan flush covers boundaries where reach isn't computable. Verified at HEAD: no React adapter code calls it — its callers are the lockstep harness, the oracle's schedule vocabulary, and tests. (The SAFE batch's E12 already merged the two flushes' duplicated firing body into one `runNewestSub`; the two candidate-selection policies and the reach walk remain.)
- **What's awkward:** One concept — "a core effect sees newest state" — has two mechanisms, forcing sentinel fields, a policy discriminator, a subscription counter, and graph-walk scratch state (~16 conditional sites) through otherwise committed-only subscription code.
- **The proposed change:** Either delete just the reach walk (evaluate value-gated on every write — an unaffected computed's read is a cheap cached read), or delete the whole synthetic variant and let tests mount real kernel effects.
- **The cost or risk:** Changes WHEN corner-case untracked sampling happens (a computed stale for an unrelated reason would re-derive at this write instead of at the next boundary), so it must be trialed under the full fuzz corpus; and `mountCoreEffect`'s API status must be ruled on first.
- **The decision being asked:** Is `mountCoreEffect` supported public API or referee-only — and may we trial the deletion under the fuzz corpus?

#### W21 — Two copies of one cold dependency walk (1 reviewer)
- **What exists today:** `closureOverKernel` (collect everything a node transitively depends on, used for mount reconciliation) and `newestReaches` (W9's "does this write feed that subscription?" test) are the same depth-first walk over the kernel's dependency links — one collects every node, the other early-exits on a target.
- **What's awkward:** Two hand-maintained copies of one traversal, both leaning on W10's mirrored layout constants.
- **The proposed change:** One walk with an optional stop predicate — cold paths, mechanical.
- **The cost or risk:** None by itself, but W9 proposes deleting `newestReaches` outright, which would immediately unwind the merge.
- **The decision being asked:** Sequence this after the W9 ruling (merge only if the reach walk survives) — agreed?

#### W17 — The bridge's pre-registration "direct" write mode looks unreachable in production (1 reviewer)
- **What exists today:** A bridge starts in mode 'direct' and flips permanently to 'concurrent' when registered; the write path keeps a full direct-mode arm (mutate base state, no receipts, no tokens). Verified at HEAD: the only public constructor path (`registerReactBridge()`) constructs and registers in one call, and the kernel hook that routes public writes into the bridge is armed only at registration — so only tests that hand-construct an unregistered bridge can execute the arm.
- **What's awkward:** A production-looking write mode that production can apparently never reach, maintained without a statement of its status.
- **The proposed change:** Document the arm as a referee affordance, or delete it and route pre-registration writes through the kernel directly.
- **The cost or risk:** Low; needs one confirmation pass over the test harness that no supported embedding constructs an unregistered bridge.
- **The decision being asked:** Confirm direct mode is referee-only, then: document it or delete it?

#### W24 — One test knob ignores the class's own test-knob convention (1 reviewer)
- **What exists today:** `arenaInitInts` (the initial size of a shadow arena's integer buffer) is a bare public mutable field doc-commented "tests shrink it to force mid-op growth". Every other test lever on the class is either private with a `__setXForTest()` mutator or `__`-prefixed and marked internal, while production tuning knobs live in `configure({...})` (the kernel's `initialRecords` option is the exact analog).
- **What's awkward:** A reader of the public surface can't tell a supported tuning knob from a test-only lever.
- **The proposed change:** Promote it to a `configure()`-style production option, or make it private behind `__setArenaInitIntsForTest()`.
- **The cost or risk:** None — naming and visibility only.
- **The decision being asked:** Is arena sizing a supported product knob (promote) or test-only (hide)?

### Hot-path merges that need benchmarks first

#### W7 — Atom equality dispatch hand-expanded at five sites, twice with fast/general double arms (1 reviewer, two findings; bench-gated)
- **What exists today:** "How does this atom compare two values?" (default equality: `Object.is`; custom comparator: run it under the purity guard that forbids signal reads inside comparators) is written out five times — in the fold replay, the quiet write, the write path's drop check, the write path's eager kernel apply, and tape compaction. The two write-path sites additionally each split into a fast arm (plain `set` with default equality skips the op-apply dispatch) and a general arm that already covers the fast case.
- **What's awkward:** One policy, five hand-expansions; the write-drop rule reads as four branches where it is one sentence.
- **The proposed change:** One `eqAtom(atom, a, b)` helper at all five sites; optionally fold each fast arm into its general arm.
- **The cost or risk:** These are the recorded-write and fold paths — the reviewer explicitly gated landing on the repo's write-storm benchmark suite; keep the fast arms if they measurably matter.
- **The decision being asked:** Run the write benchmarks and land whatever stays flat — approved?

#### W8 — The four public read/write entry points each restate the host-hook check — the hottest lines in the library (2 reviewers)
- **What exists today:** `Atom.state`, `Atom.set`, `Atom.update`, and `Computed.state` each open with the same 3–6 line shape: "if a bridge hook is armed, offer it the operation; fall through to the kernel if it declines or none is armed." That check is how the whole concurrent layer costs nothing when unused. Every public signal read and write in every app runs one of these four bodies.
- **What's awkward:** Four copies of one idea — in a file whose own history documents double-digit-percent regressions from helper extraction on exactly these paths (V8 inlining cliffs), and no current benchmark covers this precise spot.
- **The proposed change:** One reviewer sketches a single hook taking a signal-kind code; the other declines to sketch anything without a measurement.
- **The cost or risk:** Any merge sits on every read and write in every application; the downside is a headline performance regression for a ~15-line win.
- **The decision being asked:** Authorize a benchmark-first exploration, or leave it alone?

#### W22 — Two two-line hot-path dedups, bench-gated by house rules (2 reviewers)
- **What exists today:** (a) The "replay an updater purely" idiom — set the bridge's no-reads flag, then run the user function under the kernel's fold guard — appears verbatim in both op-apply implementations. Correction to the original triage row: 2 sites, not 3 — the quiet write already delegated to the packed apply before the SAFE batch. (b) The "writes forbidden inside computeds" policy check and its error message exist twice in the kernel: in the host seam's assert and again in `writeAtom` itself.
- **What's awkward:** Textbook two-line extractions — except `writeAtom` IS the write path and the applies run once per recorded write, and this repo's discipline says hot-path extractions get measured, not assumed free.
- **The proposed change:** A `replayPure(fn)` helper for (a); `writeAtom` calls the seam assert for (b).
- **The cost or risk:** Near-zero expected; both need the write benchmark and the bytecode budgets re-checked.
- **The decision being asked:** Land both behind the standard benchmark/bytecode gates?

### One invariant, two writers

#### W11 — Root commit lock-in has two owners, and the backup owner does half the job (1 reviewer)
- **What exists today:** When a root's pass commits, the engine's pass-end updates the root's "these batches are committed" state as one unit: the committed-token set, its bit-mask twin (the form the committed-world visibility check actually reads), the commit-generation counter, the global commit clock, arena fan-out, and the watcher drains. The shim ALSO defensively reconciles React's per-root commit report (the report is a delta, and re-reporting a batch is defined as an idempotent set-add): any reported batch the pass-end sweep missed gets added to the token set and the generation bumped — but not the bit mask, not the clock, and no arena fan-out.
- **What's awkward:** One invariant, two writers — and if the defensive path ever fires for a token that has a slot, committed-world reads still exclude that token's writes, because the backup writer maintains only a subset of the invariant's fields.
- **The proposed change:** One idempotent bridge operation (`commitTokens(rootId, tokens)`) owning the complete state transition, called by both pass-end and the shim's report handler; delete the shim's partial mutation.
- **The cost or risk:** No intended behavior change, but it restructures the commit path and needs a new test for the "report names a live token pass-end didn't lock in" shape — not mechanical.
- **The decision being asked:** Approve the single-owner commit operation plus its new test?

#### W23 — The quiet flag has one derivation and two side-door writers (1 reviewer)
- **What exists today:** `quiet` ("may writes take the no-bookkeeping fast fold?") is a derived flag recomputed from five conditions by `recomputeQuiet()`, called at several sites — but two sites (opening a batch, starting a pass) set `quiet = false` directly instead.
- **What's awkward:** Two writers for one derived value; the direct stores silently assert the derivation would be false at those points, and nothing checks that.
- **The proposed change:** Route all sites through `recomputeQuiet()` so the flag has one writer.
- **The cost or risk:** Trivial code — but first verify the derivation really is false at both direct sites; if it isn't, this is a bug find, not a cleanup.
- **The decision being asked:** Verify and unify — go ahead?

### Diagnostics that tax the runtime

#### W12 — Retirement's committed/abandoned flag rides a dozen signatures but changes nothing (1 reviewer)
- **What exists today:** When React finishes a batch it reports "committed" or "abandoned", and that boolean rides the whole chain — protocol event → shim → `bridge.retire(tokenId, committed)` / `settleAction` → internal retirement → the 'retired' event → one flag bit in the trace encoding — mirrored end-to-end in the oracle and its schedule vocabulary. Retirement behaves identically for both values (recorded writes never revert); diagnostics are the only consumer. (The SAFE batch's E5b already deleted the write-only Token FIELD on both sides; this item is the surviving parameter chain.)
- **What's awkward:** A diagnostic fact dressed as a semantic parameter across engine, shim, model, schedule, and trace — inviting a future branch that would wrongly make abandoned writes revert.
- **The proposed change:** Retirement becomes `retire(tokenId)`; if the committed-vs-abandoned distinction stays useful, carry it at the adapter/trace boundary as an explicitly diagnostic seam.
- **The cost or risk:** Loses the trace's committed-vs-abandoned distinction unless the seam replaces it; oracle vocabulary and lockstep event expectations re-baseline.
- **The decision being asked:** Drop the parameter chain — and if so, with or without a replacement diagnostic seam?

#### W15 — A dev-only warning allocates on the production write path (2 reviewers)
- **What exists today:** The shim warns when a write after an `await` lands outside a pending async action (usually the author meant the write to join the action). To detect this, every qualifying classified write calls `bridge.liveTokens()` — which allocates a fresh array via spread + filter — and scans it for a parked action. The warning list and the scan ship in every build; there is no development-build guard.
- **What's awkward:** An admittedly imprecise lint adds an allocation plus a full token scan to ordinary production writes.
- **The proposed change:** Delete the heuristic — or keep it behind a real dev-build condition and answer the question with a maintained scalar parked-action counter instead of the array scan.
- **The cost or risk:** Deleting loses developer guidance only; keeping adds counter bookkeeping and a build-mode convention these packages don't currently have.
- **The decision being asked:** Is this warning worth a dev-build mechanism (gate it) or not (delete it)?
### Oracle-side cleanups (the reference model's owner should shape these)

#### W13 — The lockstep differ materializes the entire expected run before comparing (1 reviewer)
- **What exists today:** The oracle's diff harness first replays the WHOLE operation script through the model, storing a JSON snapshot plus an event string per step, and only then steps the engine and compares — peak memory proportional to schedule length × snapshot size, even though comparison stops at the first divergence.
- **What's awkward:** Pure waste in the referee's inner loop, which runs thousands of fuzz schedules.
- **The proposed change:** Run model and engine side by side, one operation at a time, comparing immediately — identical failure reporting, O(1) retained state.
- **The cost or risk:** None observable; it restructures the oracle's public diff harness, which is the only reason it wasn't in the mechanical batch.
- **The decision being asked:** Approve as a small oracle-package change?

#### W14 — The model's one real cache lives off to the side, and its README denies it exists (1 reviewer)
- **What exists today:** The model's README claims "plain objects, no caches" and "no memos … it always replays". But the untracked-read contract (an untracked read observes a point-in-time sample) genuinely requires memoizing sampled values, so the model keeps a `newestSamples` map plus a cycle-guard set in two registries OFF the node records; a dated ruling comment at the call site already labels it "the sampled-untracked cache".
- **What's awkward:** A computed's semantic state is split between its node and two global maps, and the model's stated independence argument overclaims.
- **The proposed change:** Move the optional sample state onto `ComputedNode`, delete the two side maps, and correct the README: this is the semantic cache the untracked contract requires, while replay stays cache-free for pass/committed worlds.
- **The cost or risk:** No intended behavior change, but it edits the reference model's stated authority argument — its owner should shape the wording; re-run the untracked/cycle/equality-cutoff/core-effect suites.
- **The decision being asked:** Approve the model-internal restructuring plus the README correction?

### React adapter surface decisions

#### W16 — The adapter maintains defenses for protocol states it declares unreachable (1 reviewer for, 1 against)
- **What exists today:** Three defense clusters in the React adapter: (1) the write classifier keeps a full "no batch context" arm — routing the write into an engine-minted ambient batch, plus a retire-that-batch-when-idle policy re-checked after every event that could close its pending window — under a comment saying the no-context case is unreachable once a renderer registers; (2) pass-start repairs a "previous pass still open" state the comment says the protocol prevents (discard plus a loud error-log entry); (3) the transition scope's methods each guard "no batch context" and throw. About nine conditionals in total.
- **What's awkward:** The adapter is simultaneously fail-fast (the README's stated posture) and fail-soft (working fallbacks) about the same protocol violations — and the panel genuinely split: one reviewer wants the fallbacks deleted, another independently defends every one as correctly-shaped, documented protocol-edge armor.
- **The proposed change:** The fail-fast version: treat protocol absence or desynchronization as an error and delete the ~9 conditionals; ambient batching remains only in the host-agnostic engine.
- **The cost or risk:** Setup mistakes (e.g. writes before the renderer registers) would throw instead of limping along in ambient mode — a support-policy call only the owner can make.
- **The decision being asked:** For protocol-edge states: fail fast (delete the fallbacks) or keep the documented defenses?

#### W20 — The transition scope re-implements the write classifier (2 reviewers)
- **What exists today:** `startSignalTransition(fn)` hands `fn` an ActionScope whose `set`/`dispatch` methods hand-build Op objects (dispatch re-derives the reducer-as-update closure that `ReducerAtom.dispatch` already encodes; there is no `update` method) and thread them through a dedicated scope-write channel in the shim, the bridge, the model, AND the fuzz schedule vocabulary — parallel to the ordinary write classifier, which already understands set/update/dispatch.
- **What's awkward:** "Run ordinary writes attributed to this batch" is represented as one bespoke method per write kind across four layers (~6 net conditional sites), and the surface is incomplete.
- **The proposed change:** Replace with `scope.run(fn)`: enter the action's batch via the protocol's run-in-batch primitive, and let ordinary `atom.set/update/dispatch` classify normally.
- **The cost or risk:** A breaking public-API change for cosignal-react users (a callback boundary replaces the scope methods); React tests must confirm settled scopes still throw rather than silently falling back to urgent.
- **The decision being asked:** Approve the breaking ActionScope → `scope.run(fn)` API change — and if so, when?

#### W25 — Two protocol hooks are declared but never wired (1 reviewer)
- **What exists today:** The type declarations for the patched React build's protocol include optional `onBeforeMutation`/`onAfterMutation` listeners; the shim subscribes to the other six protocol events and never these two.
- **What's awkward:** A reader can't tell forward-documentation of the host protocol from dead surface.
- **The proposed change:** A one-line "declared by the protocol, unused by this driver" note — or delete the two declarations.
- **The cost or risk:** None either way; the React fork's owner knows which is true.
- **The decision being asked:** Are these hooks planned (document) or dead (delete)?

#### W26 — Un-registering the adapter works by coincidence, not by statement (1 reviewer)
- **What exists today:** One shim is "active" at a time, held in a module-level slot. The dispose path runs `shim.dispose()` and then clears the slot only if `getActiveShim()` now returns undefined — which is true only because that getter happens to filter out disposed shims. The intended rule is "clear the slot only if it still points at me; never clobber a successor."
- **What's awkward:** The invariant holds through a getter's side behavior rather than being stated.
- **The proposed change:** An explicit `unregister(shim)` in the shim module that compares identity.
- **The cost or risk:** Tiny, but it adds a shim-registry API — the only reason it wasn't in the mechanical batch.
- **The decision being asked:** Add `unregister(shim)`?
### Pass bookkeeping contract change

#### W19 — "Rendered" contains "mounted", forcing skip-checks and a double visit (1 reviewer)
- **What exists today:** A pass tracks two watcher collections: `mounted` (watchers created during this pass) and `rendered` (watchers that rendered during this pass) — and mounting adds the watcher to BOTH, even though the model's own field comment describes `rendered` as "existing watchers re-rendered by this pass". Pass-end must therefore filter mounted watchers back out of its rendered loop (a linear array-membership test per rendered watcher), and a later loop iterates the concatenation of both collections, visiting every mounted watcher twice (harmless only because that loop body happens to be idempotent). The oracle mirrors the same overlap.
- **What's awkward:** Every consumer of the two collections must re-decide which subset it actually means.
- **The proposed change:** Make the sets disjoint (`rendered` = re-renders only) and write an explicit union at the one place a union is meant, deleting the filter and the double visit.
- **The cost or risk:** A contract-shape change: engine and oracle must move together, and pinned regression tests that inspect `pass.rendered` re-baseline.
- **The decision being asked:** Approve as a coordinated engine + oracle change the next time this area is open — or now?

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
