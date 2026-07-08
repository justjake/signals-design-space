# Fork-simplification synthesis: one fork, two engines

Adjudication of `alt-a-fable.md`, `alt-b-fable.md`, `alt-a-codex.md`, `alt-b-codex.md`
under `CONSTRAINTS.md`. Every disputed claim below was re-verified against the working
tree (vendor/react diff vs `e71a6393e6`, both bridges, both engines, both RTL suites);
citations are to files I read, LoC figures are counted from `git diff --numstat` /
line ranges unless marked *est.* The product being sized is **one fork serving both
alt-a and alt-b** — not either single-consumer fork the four reports priced.

## Executive verdict (ten lines)

1. The honest floor for the two-engine fork is **≈ 900–950 added source LoC as-documented
   (≈ 650–700 doc-trimmed), only ≈ 200 in upstream-owned files, zero public React exports** —
   not fable-alt-a's 500/210, not fable-alt-b's 1,230, not codex's 380–535: each of those is a
   single-consumer number under a different doc/transport policy, and the gaps are policy, not fact.
2. The registry stays fork-side whole (fable-alt-b is right): backfill, re-pend lock-ins, and
   async-action parking are verified load-bearing for both engines (ReactFiberBatchRegistry.js:242-255,
   :335-350, :434-441) and CONSTRAINTS-pinned; fable-alt-a's F2 registry-in-bridge dies on 2× duplication.
3. The transport dies (both codex reports are right): `__CLIENT_INTERNALS…` is already exported
   (ReactClient.js:119), so the 334-line isomorphic channel + 71 export lines collapse to one
   private host object (~45–70 LoC) — the single biggest cut fable-alt-b missed (−~405).
4. Yield/resume events stay: alt-a consumes them (engine.ts:2901-2909) with only a one-way heal
   (engine.ts:1557-1564); both alt-b reports' D3 deletion is wrong for the shared fork.
5. The mutation window stays per CONSTRAINTS, as direct consumer callbacks (~25 LoC, not ~59).
6. The allocator stays as a `consumer.allocate(deferred)` field (it is alt-b's open edge and
   live-set recorder, react.ts:488-494); only the registration machinery, fallback counter, and
   error 606 die (−~50). Full inversion (fable T1/R2, codex-alt-a) is superseded.
7. `runInBatch` + the RootScheduler lane pin are the keystone (unanimous, CONSTRAINTS §2); both
   engines verified deferred-only callers (alt-a engine.ts:2165, alt-b engine.ts:2569) — only the
   live-urgent branch dies (~4).
8. Step zero is real and verified: the alt-a bridge's probe mints urgent batches on ambient reads
   (bridge.ts:156-159 violating engine.ts:1578-1580 "a read must never mint"); fix = read
   `internals.T`, the mint-free pattern alt-b already ships (react.ts:592-598).
9. Tests: prune the 3,502-line fork suite to ~1,500–2,000 (keep registry/runInBatch/mutation/
   yield-pairing families); **commit the untracked 228-line ReactDOMUseUrgentActStall-test.js now**.
10. Rejected with prices: gate unification (−3.9× idle writes), runInBatch removal (lockstep dies),
    bridge-synthesized pass-end (alt-b quiescence delays + cross-root close hazard), Context carrier
    (100–180 LoC floor remains, write-path profile inverts alt-b's DIRECT goal), zero-fork (both necrologies stand).

---

## 0. Baseline accounting (reconciled)

All four reports' baselines are correct under their stated scopes — verified by running both counts:

- `git diff --numstat e71a6393e6..HEAD -- packages` = **5,012 added / 19 files** (fable-alt-a, both codex).
- Full-repo diff = **5,016 added, 1 deleted / 20 files** — adds `scripts/error-codes/codes.json` +4
  (errors 601, 604, 605, 606) (fable-alt-b).
- Source split: 1,510 product (+4 codes.json) + 3,502 tests (4 reconciler test files: Pass 1,025,
  RunInBatch 929, Commit 891, BatchRegistry 657).
- Registry comment density verified by full read: **~297 code / ~240 comment of 564** — fable-alt-b's
  measurement is exact.
- `packages/react-dom/src/__tests__/ReactDOMUseUrgentActStall-test.js` (228 lines) is **untracked**,
  in no count, and pins that the downstream "urgent act stall" is upstream behavior, not a fork
  regression (its header, lines 13-42, and the wedge pin at lines 196-227).

Upstream-owned-file exposure today (the real rebase cost): WorkLoop 291 + RootScheduler 33 +
ReactClient 17 + SharedInternalsClient 5 + 7 index files 49 + noop 13 (+codes 4) = **~412**. New
files (registry 564, FiberExternalRuntime 204, ReactExternalRuntime 334 = 1,102) rebase trivially.

---

## 1. The floor dispute, adjudicated

The four floors — fable-alt-a **~500 (F1) / ~210 (F2)**, fable-alt-b **~1,230**, codex-alt-a
**430–535**, codex-alt-b **380–460** — differ on five disputed patches plus two policies
(documentation density; public vs private transport). Per patch, for a fork serving **both** alts:

### 1.1 The batch registry (564): fork-side and near-whole. fable-alt-b is right; fable-alt-a's F2 is wrong for this product.

Verified: every registry mechanism except three is consumed by **both** engines through their
bridges — identity/merge (`getOrCreateBatchId` :168-190, `lookupLiveBatchSlot` :200-212), pending
edge (:218-227), backfill (:242-255, called from RootScheduler's microtask **before** the close
edge, RootScheduler hunk +317-324), finish edge with per-root report, re-pend refinement and
committed-root lock-ins (:295-406, fed by the render-time stash :113-134), close edge +
async-action parking with stale-settlement self-invalidation (:422-472), retire (:474-487),
`batchIdsForRender` with entangled expansion + lock-in inclusion (:533-564). The three exceptions
(generation WeakMap :105-111/:301-304/:397; fallback id counter :100-103/:177; retire/pass-end
dispositions) are consumed by neither engine (alt-a bridge.ts:141,146-152 + engine.ts:2576-2581;
alt-b react.ts:519-535) — delete, ~35 LoC.

- **fable-alt-a F1** (registry kept, trimmed) is compatible with this verdict; its **F2/T6**
  (export raw lane facts, re-implement slots/merge/lock-in/parking in the bridge) is **rejected**:
  with two engines the subtle logic would live twice (or in a third shared userspace package),
  lane bitmasks cross the boundary twice, and the fork's registry test suite would be rewritten
  per consumer. *What dies if F2 were taken anyway and a re-implementation drifted*: a backfill bug
  leaks pending drafts into ambient W0 pre-commit (alt-b react-real.test.tsx:100-145 family; alt-a
  real-react.spec.tsx:648-713); a lock-in bug lets an urgent pass tear against a root's own DOM
  (alt-a :199, alt-b :147); a parking bug exposes a store-only async action's writes mid-action.
  CONSTRAINTS §3 makes these preserve-or-price; F2 preserves only by duplicating.
- **codex-alt-b's 185–235 registry rewrite** is directionally fine but over-aggressive: the shipping
  code is proven by 657 lines of tests and two seam bugs were *discovered* in exactly these edges
  (fable-alt-b §non-goals). Delete surgically; do not rewrite.
- *What dies if fable-alt-b's whole-hog conservatism were wrong the other way*: nothing — its error
  is only carrying the dead transport (next item).

### 1.2 The isomorphic channel + exports (334 + 71): delete. Both codex reports are right; fable-alt-b missed the biggest cut.

Verified: React already exports the shared-internals object as
`__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE` (ReactClient.js:119, upstream
line), the reconciler reads the same object (`ReactSharedInternals.E`,
ReactFiberExternalRuntime.js:34-39), and **alt-b already reaches through this exact export today**
for its `T` probes (react.ts:564-571, :635-643). A private host object on that carrier replaces:
listener `Set` + string-dispatch emit + error isolation (ReactExternalRuntime.js:174-190),
provider slot + allocator registration (:262-296), 7 public `unstable_*` names × 7 entry points
(ReactClient.js:131-138 + index*.js 49), for ~45–70 LoC. fable-alt-a's slimmed-channel (~70
retained) is close but keeps public names; fable-alt-b's D8 (−36, experimental-channel-only) keeps
~350 lines of dead generality. *What dies if wrong (i.e., if the private property breaks)*:
nothing silently — both bridges already throw loudly on protocol absence (bridge.ts:74-86,
react.ts:481-487); this is a pinned fork, not an upstreamable API, and both codex reports say to
keep it loud.

Consequence priced: fork-side error isolation dies with the channel. alt-a's bridge already guards
every callback (bridge.ts:115-121); **alt-b's `ReactFork.emit` does not** (react.ts:542-546, bare
loop) — alt-b must add a guard (+~4) *before* the channel is deleted, or a listener throw
propagates into React's commit.

### 1.3 Yield/resume (~90): keep. Both alt-b reports' D3 is wrong for the shared fork.

Ground truth: alt-b's engine treats the events as a shadow of its poll — `ctxNow()` downgrades
RENDER→NEWEST whenever `getRenderContext()` is null (engine.ts:447-463), so its scalar can stay
RENDER for a whole pass; deletion is sound *for alt-b alone*. But alt-a's engine is **edge-driven
with a one-way heal**: yield/resume flip `readCtx` (engine.ts:2901-2909), and `healStaleRenderCtx`
repairs only RENDER→NEWEST (engine.ts:1557-1564) — there is no NEWEST→RENDER heal, so with events
deleted a resumed time-sliced render would read the NEWEST world instead of the pass world unless
every NEWEST read polled the fork, the exact cost fable-alt-a's T7 rejected (accessor layers ~20%
of a kairo tick, reported measurement, not re-verified here). *What dies if D3 were taken*: alt-a's
suspense/interruption family (real-react.spec.tsx:141-197, :258-357) by wrong-world reads, or the
read-path budget. Cost of keeping, after the frame sets stay anyway (§1.4): the yield/resume
notifiers and ~6 WorkLoop call sites, ~50–70 LoC. alt-b keeps its 6-line listener arms
(engine.ts:3840-3845) — harmless.

### 1.4 Pass-frame machinery + pass-end (fork-side, ~60): keep. fable-alt-a's T3 is rejected.

T3 (bridge synthesizes pass-end from next-start + `onRootCommitted`) is safe-ish for alt-a alone
(its own numbers: −62 fork / +10 bridge, sweep delay bounded). For the shared fork it fails twice:
(a) alt-b's pass-end is its quiescence boundary — `sweepTapes` + `maybeQuiesce` → LOGGED→DIRECT
flip (engine.ts:3846-3860, react-real.test.tsx:811 `isDirect()`); synthesizing it from the *next*
render or commit delays the idle-DIRECT flip that is alt-b's defining perf contract, and store-only
retires have no commit to synthesize from; (b) codex-alt-a identified a real hazard the fork's
per-root sets already prevent: a late end for root A closing root B's scalar pass — note alt-b's
`ReactFork` defends by container-filtering (react.ts:519-522) precisely because the fork's truth is
per-root. The exactly-once frame sets (ReactFiberExternalRuntime.js:67-72, ~30 LoC once
`getRootsWithOpenPassFrames` dies with discardAllWip) are cheaper than duplicating pairing in two
bridges. Both sets can become WeakSets after discardAllWip's enumeration need dies (:60-66).

### 1.5 Mutation window (~59 today): keep as direct callbacks (~25). CONSTRAINTS override; codex-alt-a's deletion is void.

Verified unconsumed by both engines (alt-a listener engine.ts:2895-2931 has no handlers; alt-b
engine.ts:3811-3875 and bindings react.ts:77-109 omit them; only react.ts:536-537 forwards) — and
verified correctly placed: the bracket lives in `flushMutationEffects` with the close in `finally`
(WorkLoop ~4290-4319, View-Transition-correct), exactly as codex-alt-b argued. CONSTRAINTS §1
binds. Keep the two WorkLoop call sites (9) + two direct consumer calls (~10) + consumer-type
fields; the generic dispatch dies with the channel. codex-alt-a wrote before CONSTRAINTS existed
(file timestamps: alt-a-codex 12:38, CONSTRAINTS 12:39) — overridden, not wrong on the facts it had.

### 1.6 Remaining dead weight: unanimous deletes, all verified.

`discardAllWip` (WorkLoop 1014-1061 + provider line + `getRootsWithOpenPassFrames` + wrappers +
exports + error 604, ~86) — absent from both runtime types (bridge.ts:58-72, react.ts:448-469).
Noop-renderer patch (13) — exists only for discard-driven fork tests. Generation + both
dispositions (~35, §1.1; the only consumer anywhere is alt-a's *tracer* recording the retire bit,
engine.ts:2586 — a debug bit, priced and accepted). Live-urgent `runInBatch` branch (~4) — both
engines verified odd-token-only callers (engine.ts:2165 alt-a; engine.ts:2540, :2569 alt-b).
`resetBatchRegistryForTest`: **keep** as a DEV method on the host object — both RTL harnesses
consume it (alt-b react-real.test.tsx:41,55; alt-a bridge.ts:187), so codex's pure deletion is
overruled at ~10 LoC cost.

### 1.7 Why the four floors differ (fully explained)

| Report | Floor | Policy/architecture deltas vs this synthesis | Verdict |
|---|---:|---|---|
| fable-alt-a F1 | ~500 | all-docs trim (−~250), T3 bridge pass-end (−62), no mutation window (−59, pre-CONSTRAINTS), slim channel kept (+~70 vs host object), single consumer | right method, three wrong cuts for two engines |
| fable-alt-a F2 | ~210 | F1 + registry-in-bridge | rejected (§1.1) |
| fable-alt-b P1 | ~1,230 | keeps isomorphic channel (−~350 missed), keeps all docs, deletes yield/resume (wrong, §1.3), keeps mutation window only implicitly | right on registry irreducibility, missed the transport cut |
| codex-alt-a | 430–535 | private driver (adopted), deletes mutation window (void), deletes yield/resume+getRenderContext (wrong: alt-b consumes `getRenderContext` for root identity, react.ts:600-602, :927-945, engine.ts:453, :2228), estimate not counted | right transport, wrong context design for two engines |
| codex-alt-b | 380–460 | private driver (adopted), registry rewrite (over-aggressive), deletes yield/resume (wrong for alt-a), mutation window kept (right) | closest single-consumer analysis |
| **This synthesis** | **≈ 900–950 as-documented / ≈ 650–700 doc-trimmed; ~200 upstream-owned** | union of both engines' consumed surface + CONSTRAINTS | — |

The reconciling insight (from fable-alt-a §5, generalized): **the maintenance metric is diff inside
upstream-owned files, not total LoC.** New files rebase trivially and their documentation is the
protocol spec (fable-alt-b's non-goal, honored *for new files*); upstream-owned hunks get trimmed
to upstream density.

---

## 2. Traceability table (reconciled inventory)

LoC counted from the diff/file reads; "both" means consumed via both bridges. RTL pins name the
test that fails (or the constraint that binds) if the row is mishandled.

| # | Patch | LoC | Consumer(s) | RTL / constraint pin | Verdict |
|---|---|---:|---|---|---|
| 1 | Registry: slots, `getOrCreateBatchId`, merge rule, `lookupLiveBatchSlot` (BatchRegistry:63-212) | ~150 | both (every write; runInBatch target) | every transition test: a-113, b-79 | **keep** |
| 2 | Pending edge + markRootUpdated hook (:218-227; WorkLoop +1964,4) | ~13 | both (retirement truth) | a-141, b-100 | **keep** |
| 3 | Backfill (:242-255; RootScheduler +317-324) | ~19 | both (setState-before-store line order) | early-retire → drafts leak into W0: a-648ff, b-588ff; CONSTRAINTS §3 | **keep** |
| 4 | Finish edge: per-root report, re-pend refinement, lock-ins (:295-406, :113-134; WorkLoop +3992,19) | ~130 | both (commit truth; `batchIdsForRender` correctness) | a-199, a-400; b-147, b-fork-double react.test.ts:33-90 | **keep** |
| 5 | Close edge + async-action parking (:422-472; RootScheduler +354-359) | ~55 | both (store-only retire; mid-action invisibility) | b quiescence/`isDirect` b-811; CONSTRAINTS §3 | **keep** |
| 6 | Retire (:474-487) | ~14 | both (absorption edge) | a-113, a-648; b-100, b-644 | **keep**, drop `committed` arg (alt-a tracer bit dies, engine.ts:2586) |
| 7 | Commit generation (:105-111, :301-304, :397) | ~15 | none (a-bridge.ts:147-152 drops; b-react.ts:531 drops) | — | **delete** |
| 8 | `batchIdsForRender` + render-time stash (:517-564, :129-134; WorkLoop +2483,5) | ~55 | both (pass world = include mask) | a-288, a-527; b-135-region, b-430 | **keep** |
| 9 | Pass frame sets + start/end notify (FiberExternalRuntime:50-119, :171-183; WorkLoop commit/prepareFreshStack sites) | ~60 | both (pin capture at start; sweep/quiescence at end) | a-199 pin; b-811 DIRECT flip | **keep** fork-side (T3 rejected §1.4); sets→WeakSets; drop end disposition |
| 10 | Yield/resume notifiers + ~6 WorkLoop sites (FiberExternalRuntime:129-160; WorkLoop +2856…+3278) | ~60 | alt-a only (engine.ts:2901-2909); alt-b shadows its poll | a-141-197, a-258-357 (resume-direction reads) | **keep** (D3 overruled §1.3) |
| 11 | Mutation window: bracket + notifiers (WorkLoop +4297,6/+4314,3; FiberExternalRuntime:192-204) | ~25 (from ~59) | none today; owner's MutationObserver use case | CONSTRAINTS §1 | **keep**, direct consumer callbacks; generic dispatch dies |
| 12 | `discardAllWip` + `getRootsWithOpenPassFrames` + error 604 + noop patch | ~99 | none (absent from both runtime types) | — | **delete** |
| 13 | Provider: `getCurrentWriteBatch` cascade + `ensureScheduleIsScheduled` + `getRenderContext` (WorkLoop +876 hunk, ~57) | ~50 | both (write classification; render truth: a-heal engine.ts:1557-1564 + write gate; b-poll engine.ts:453/:2228 + effect-root react.ts:927-945) | every transition test; b-933 | **keep** (codex-alt-a's getRenderContext deletion overruled — alt-b consumes it directly) |
| 14 | `runInBatch` + lane pin + error 605 (WorkLoop 967-1019; RootScheduler +707-735) | ~95 | both, deferred-only (a-2165/2306/2416/3547; b-2543/2570, react.ts:190-197) | a-113, a-199; b-176, b-fork react.test.ts:131-145; CONSTRAINTS §2 | **keep**; delete live-urgent branch (~4); keep always-execute + retired→urgent-fallback contract (a-bridge returns true unconditionally, bridge.ts:166-170; b treats result `!==false`, react.ts:604-613) |
| 15 | Allocator: registration fn, fallback counter, error 606 (ReactExternalRuntime:262-296; registry :100-103, :174-186) | ~64 | callback itself: both mint `(serial<<1)\|deferred` (a-bridge.ts:176-178; b-react.ts:488-494 — also b's open edge + live set) | b gate flip b-811ff; token encoding a-§6.2 | **invert to `consumer.allocate` field** (~10 kept); registration/fallback/606 die (~-50) |
| 16 | Isomorphic channel: Set/emit/error-isolation/provider slot/wrappers (ReactExternalRuntime.js) | 334 | transport only | — | **delete → host object** (~45-70); error isolation moves to bridges (b +4 guard) |
| 17 | Public exports (ReactClient 17 + index 49) | 66 | transport only | — | **delete** (private carrier already exported, ReactClient.js:119) |
| 18 | SharedInternalsClient `E` slot | 5 | carrier | — | **keep** |
| 19 | `resetBatchRegistryForTest` (registry :503-515 + plumbing) | ~25 | both RTL harnesses (b-test:41,55; a-bridge:187) | test isolation | **keep** as DEV host method (~10) |
| 20 | Fork reconciler tests | 3,502 | protocol pins independent of either engine | rebase safety | **prune to ~1,500–2,000**: keep BatchRegistry + RunInBatch near-whole, Commit's per-root/lock-in/re-pend, Pass's pairing/yield + mutation-window families; cut driverless/multi-listener/discard/generation/channel-gate scenarios |
| 21 | `ReactDOMUseUrgentActStall-test.js` | 228 (untracked) | regression gate (upstream-wedge pin, lines 196-227) | itself | **commit it**; run in every gate |
| 22 | codes.json | 4 | errors 605 (+601 unrelated) | — | keep 2 (605, 601); 604/606 die |

Deleted total (counted rows 7, 12, 15-partial, 16, 17, disposition/live-urgent slivers): **~575–620**.
Retained source: **≈ 900–950** as-documented, **≈ 650–700** with new-file docs at upstream density.
Upstream-owned after: WorkLoop ~155–175 + RootScheduler ~30 + SharedInternals 5 + codes 2 ≈ **~200** (vs ~412).

---

## 3. The codex reports' distinctive ideas

| Idea | Source | Ruling | Reason |
|---|---|---|---|
| **Canonical private driver** on `__CLIENT_INTERNALS…` — no public API, no channel file | both codex | **ADOPT** (the plan's step 2) | Verified feasible (ReactClient.js:119 upstream export; alt-b already reads it, react.ts:564-571). Kills 334+66 LoC and the whole public-surface rebase burden. One consumer slot is enough: both packages enforce singleton registration (hooks.ts:28-53; react.ts:686-694), and the two engines are alternatives, not cohabitants — make double-registration throw loudly. |
| `currentBatch(claim: boolean)` non-minting peek | codex-alt-a | **ADAPT → reject the API, take the goal via T-read** | The peek exists to fix the alt-a probe bug, but `internals.T !== null && !T.gesture` fixes it with **zero fork LoC** (mirrors the classifier's own branch, WorkLoop +876 hunk) and is the pattern alt-b already ships mint-free (react.ts:592-598, :640). Same answer in all reachable states (post-await: both give false; in-scope pre-write: both mint only when the world is then requested). |
| Render-exit edge on **every** work-loop return (delete `getRenderContext` + heal) | codex-alt-a | **REJECT the deletion; DEFER the extra emit** | `getRenderContext` is directly consumed by alt-b for per-callstack truth and effect-root identity (react.ts:600-602, :927-945; engine.ts:453, :2227-2230) — it cannot die. Emitting yield on the suspend/complete exit paths (+~6) would make the edge truthful and demote alt-a's heal to an assert; take it later, with a fork test, not as part of the diet. |
| `runInBatch`: store originating Transition in the slot; boolean return; React refuses dead tokens | both codex | **ADAPT partially** | Delete the live-urgent branch (verified dead, §1.6). **Keep** always-execute + retired→urgent fallback: alt-a's bridge depends on it (bridge.ts:166-170) and alt-b's wrapper is compatible (react.ts:607 `!== false`); flipping to refuse-dead would activate alt-b's never-exercised fallback branch and add bridge LoC to alt-a for zero fork savings (~8). Transition-object/DEV-Set reuse: micro-opt, defer. |
| Reduced-feature points (commit-lite, deferred-only, single-root v1, 250–340 test-shaped floor) | both codex | **REJECT** | Product = full contract; codex-alt-a itself flags the RTL suites as too weak to certify the losses. Use its under-asserted-edge list as *test additions* (plan step 1a), not as license to cut. |
| **Context/update-queue carrier** (~100–180 residual fork) | codex-alt-b | **REJECT** (keep its falsification list on file) | Even if the spike passed its 12-case battery (react.ts write path gaining React Update allocations, O(all consumers) Context propagation — inverting alt-b's measured DIRECT contract, perf.test.ts G-6a 190ns vs 750ns/write as reported), the mutation window + lane pin keep a fork alive per CONSTRAINTS, and a second engine (alt-a) would need its own carrier. Strictly dominated for this product. |
| RTL blind-spot inventory (flushSync exclusion untested on DOM; two-root staggering fork-double-only; excluded-pass fixup fork-double-only; no raw async-action RTL; mutation window fork-double-only) | codex-alt-b §1.5 | **ADOPT** as gate hardening | These are exactly the edges the diet touches; add before deleting (plan step 1a). |
| Single-listener/no-error-isolation | all four | **ADOPT with the alt-b guard caveat** (§1.2) | fable-alt-a's "bridge already guards" is true only for alt-a; verified alt-b's emit is unguarded (react.ts:542-546). |

---

## 4. THE PLAN

### 4.1 Target protocol (one private host object, both engines)

Installed by the reconciler on `ReactSharedInternals.E` once a renderer loads; bridges
feature-detect and throw loudly on absence (both already do). Shape (union of both engines'
verified consumption + CONSTRAINTS):

```ts
type CosignalsReactHost = {
  consumer: null | {
    allocate(deferred: boolean): number;                 // mint = the open edge (b's gate; both mint (serial<<1)|deferred)
    onRenderPassStart(container: unknown, included: readonly number[]): void;
    onRenderPassYield(container: unknown): void;         // alt-a's readCtx flip; alt-b ignores
    onRenderPassResume(container: unknown): void;
    onRenderPassEnd(container: unknown): void;           // disposition dropped
    onRootCommitted(container: unknown, batches: readonly number[]): void;  // generation dropped
    onBatchRetired(batch: number): void;                 // disposition dropped
    onBeforeMutation(container: unknown): void;          // CONSTRAINTS §1
    onAfterMutation(container: unknown): void;
  };
  getCurrentWriteBatch(): number;        // minting classifier (writes only)
  getRenderContext(): { container: unknown } | null;    // b polls; a heals
  runInBatch<R>(batch: number, fn: () => R): R;         // always executes; deferred-live pins the lane; retired/unknown = discrete-urgent
  resetBatchRegistryForTest(): void;     // DEV; both RTL harnesses
};
```

Ambient deferred probes are **not** protocol: both bridges read `internals.T`
(zero fork LoC; alt-b unchanged, alt-a fixed in step 0).

### 4.2 Projected LoC (counted-basis estimates)

| Region | Today | After | Notes |
|---|---:|---:|---|
| BatchRegistry.js (new file, docs kept) | 564 | ~500 | −generation 15, −fallback/DEV ~12, −dispositions ~8, −orphaned prose ~30 |
| FiberExternalRuntime.js → pass helper + host install | 204 | ~170 | −`getRootsWithOpenPassFrames` 12, −discard prose, −end-disposition; direct consumer calls replace emit wrappers |
| Host-object module (replaces ReactExternalRuntime.js) | 334 | ~55 | type + creation + reset |
| WorkLoop hunks (upstream-owned, docs trimmed) | 291 | ~160 | −discardAllWip 48, −live-urgent ~4, −disposition args, −~70 doc trim |
| RootScheduler (upstream-owned) | 33 | ~30 | unchanged mechanics |
| ReactClient + 7 index + noop | 79 | 0 | |
| SharedInternalsClient | 5 | 5 | |
| codes.json | 4 | 2 | 605 + 601 stay |
| **Source total** | **1,514** | **≈ 920** (≈ 660 if new-file docs also trimmed) | upstream-owned ≈ 200 (vs ~412) |
| Fork tests | 3,502 | ~1,500–2,000 | per row 20 |
| ActStall regression | 228 (untracked) | 228 (committed) | |
| **Whole fork delta** | 5,016 | **≈ 2,650–3,150** | −37–47% |

### 4.3 Migration steps and gates

**Gate battery** (run at every step): fork jest suite (surviving files) + `ReactDOMUseUrgentActStall-test.js`
+ fork build + alt-a full suite incl. `real-react.spec.tsx` (778) + alt-b full suite incl.
`react-real.test.tsx` (954) in **both** gate modes + alt-b PERF G-6a/6b unchanged.

- **Step 0 — alt-a bridge T-read fix (bug verified, do first).**
  `isCurrentWriteDeferred` (bridge.ts:156-159) mints: `unstable_getCurrentWriteBatch()` →
  provider cascade (WorkLoop +876 hunk) → `getOrCreateBatchId` (registry:168-190) →
  `allocate()` + `ensureScheduleIsScheduled()`, on the ambient-read path where the engine demands
  a non-minting probe (engine.ts:1578-1580, guard `MODE_LOGGED && liveDeferredMask & ~retiredSlotMask`).
  Harmless today only by luck: the empty urgent batch retires `committed=false` at the close edge
  (registry:441) and the engine ignores unknown retires (engine.ts:2578-2581) — but it churns a
  slot + close microtask per probed event and violates the engine's own contract.
  **Fix**: replace the body with an `internals.T !== null && !T.gesture` read (pattern:
  alt-b react.ts:564-571). alt-a Δ ≈ ±4 lines; fork Δ 0.
  **Gate add**: a bridge test asserting the allocator callback count stays 0 across ambient reads
  while a deferred batch is live. Also in step 0: `git add` the ActStall test.
- **Step 1a — harden gates before deleting** (codex-alt-b §1.5 list): add RTL/fork tests for
  state-before-store backfill, excluded-pass late-subscriber fixup, staggered two-root commit,
  raw store-only `startTransition(async …)` parking, deterministic yield-gap write, and the
  mutation bracket incl. `finally`/View-Transition timing (fork-side jest; the window has no
  in-package consumer yet).
- **Step 1b — dead-capability deletion** (no protocol shape change): rows 7, 12, dispositions,
  live-urgent branch, error 604/606-adjacent tests. Bridges: drop ignored params from types
  (a-bridge −4; b-react −3, plus delete dead `isCurrentWriteDeferred`, react.ts:555-557, −3).
- **Step 2 — transport swap** (the big cut): install the host object *alongside* the channel;
  port both bridges to prefer it (alt-b adds the emit try/catch guard, +4); run the full battery
  differentially; then delete ReactExternalRuntime.js, ReactClient exports, 7 index files;
  allocator → `consumer.allocate`; reset → DEV host method (update b-test:34-55, a-bridge:187).
- **Step 3 — doc-trim upstream-owned hunks** (WorkLoop, RootScheduler) to upstream density; move
  evicted protocol prose into the fork test headers. New files keep their spec-density docs.
- **Step 4 — test prune** per row 20; port scenario names before deleting any file.
- **Deferred (post-burn-in, optional)**: suspend-exit yield emit (+~6, demotes alt-a's heal to an
  assert); runInBatch Transition-object reuse; alt-a app-facing mutation forwarding (+~6, exposes
  the CONSTRAINTS capability through the alt-a package like alt-b's react.ts:536-537 already does).
- **Explicitly rejected** (do not revisit without new facts): T3 bridge pass-end, T6/F2
  registry-in-bridge, D3 yield/resume deletion, R1 gate unification (−3.9× idle writes for zero
  fork LoC), R4/T8 runInBatch removal, R5 global-committed effects, Context carrier, zero-fork.

### 4.4 Per-engine changes, priced

| Engine | Change | Δ LoC | Risk |
|---|---|---:|---|
| alt-a | step-0 probe fix | ±4 | none (equivalence argued §3; gated by no-mint test) |
| alt-a | host-object attach; drop dead params | −~15 | mechanical |
| alt-a | tracer loses retire-disposition bit | −1 | debug-only |
| alt-a | (deferred) mutation forwarding | +~6 | none |
| alt-b | host-object attach; drop dead params + dead probe | −~20 | mechanical |
| alt-b | emit guard (error isolation moves bridge-side) | +4 | **must land before step-2 deletion** |
| both | RTL harness reset call sites | ±0 | rename only |

### 4.5 Risks

1. **Transport swap** is the only step touching every event at once — mitigated by the
   dual-path differential window and the loud-failure presence checks both bridges already have.
2. **Test-prune regression debt**: a cut fork test could have been the only pin on a rebase-fragile
   edge — mitigated by step 1a (add before delete) and keeping BatchRegistry/RunInBatch near-whole.
3. **Error isolation ordering** (alt-b guard before channel deletion) — called out in steps.
4. **Single consumer slot**: any future need to run both engines in one process (e.g., a
   head-to-head harness) hits the double-registration throw — acceptable; benchmarks run engines
   in separate processes today.
5. **Unverified perf citations**: alt-a's "~20% accessor share" and alt-b's G-6a ratios were taken
   from the reports, not re-measured; both only *strengthen* keep-decisions already forced by
   consumption facts, so being wrong shifts no verdict.
6. **ActStall test stays untracked** until someone commits it — the single cheapest risk to
   retire; it is the only pin distinguishing "fork regression" from "upstream act misuse wedge"
   (its lines 189-227).
