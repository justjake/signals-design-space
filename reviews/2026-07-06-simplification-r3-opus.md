# cosignal simplification review — r3 (opus)

Date: 2026-07-06
Scope reviewed (top to bottom, READMEs + sources): `packages/cosignal`
(`index.ts` 2600, `concurrent.ts` 5473, `trace.ts` 866, `graphviz.ts` 88),
`packages/cosignal-react` (`index.ts`, `hooks.ts` 381, `shim.ts` 732,
`types/react-fork.d.ts`), `packages/cosignal-oracle` (`model.ts` 1554,
`adapter.ts`, `invariants.ts`, `schedule.ts`). Also read the in-scope test
boundary files `tests/model-view.ts` and `tests/oracle-adapter.ts` (they
define the engine↔model seam). Nothing changed; nothing committed.

Verified at baseline: `packages/cosignal` vitest **314 passed / 1 skipped
(24 files)**; oracle suite running. Documented harness commands
(`FRAMEWORK=cosignal` / `cosignal-concurrent`, package `tsc`) were not all
re-run — findings below name the tests each change would touch.

This review is deliberately skeptical of the asserted rationales in the
doc-comments; where a rationale holds, I say so and mark the finding TRADE or
QUESTION rather than SAFE.

---

## Shape of the whole

These three packages are one reactive engine expressed in layers. At the
bottom is a packed-array **push-pull kernel** (`index.ts`) that stores every
signal/computed/effect/edge as fixed-stride `Int32Array` records and holds
exactly one value per atom. Riding it is the **concurrent-worlds engine**
(`concurrent.ts`): it records each write as a receipt on a per-atom tape and
reconstructs alternative *worlds* (newest / pass / committed-for-root /
mount-fix) so React's interruptible renders each see a self-consistent view;
those worlds are served by **shadow arenas** — a *second* packed-array graph,
one plane per world. `cosignal-react` translates a patched-React protocol
into bridge calls; `cosignal-oracle` re-specifies the same behavioral
contract naively for lockstep fuzzing.

The single dominant structural fact is that **the alien-signals push-pull
graph algorithm is implemented twice** — once in the kernel over a
closure-captured buffer (`M`, `NodeField`/`LinkField`/`NodeFlag`) and once in
the shadow arena over an explicitly-passed buffer (`a.W`, `AF`/`AFlag`) with
byte-compatible field/flag layouts "asserted stable by the suite." Around
that core sit a cluster of *concept pairs that are one idea in two
mechanisms* (fold-purity as a POISON operation-table **and** an
`inFoldCallback` flag; exceptional-value boxing in the kernel **and** the
arena; newest-vs-world serving), a *family of near-identical graph walks*
(delivery / drain / mount-closure / newest-reach), a recurring
*committed-boundary epilogue* copied across four call sites, and a
substantial body of *test-only machinery living inside the shipped runtime*
(an armed divergence checker with its own naive evaluator, plus referee-only
effect constructors). The kernel and the diagnostics leaves (`trace.ts`,
`graphviz.ts`) are genuinely minimal; the concentration of collapsible
duplication is in `concurrent.ts`, which is also where the engine grew its
special cases. The good news: almost none of the duplication is accidental —
each copy has a rationale — so the review's job is to separate the copies the
rationale actually requires (TRADE/QUESTION) from the ones it does not
(SAFE).

---

## Findings, ranked by leverage

### 1. Two hand-mirrored implementations of the push-pull algorithm — QUESTION (+ a SAFE sub-part)

**What.** The kernel (`index.ts`) and the shadow arena (`concurrent.ts`)
each implement the same alien-signals walk:

| kernel (`index.ts`) | arena (`concurrent.ts`) |
|---|---|
| `link`/`linkInsert` (602-656) | `aLink`/`aLinkInsert` (1127-1170) |
| `unlink` (658-691) | `aUnlink` (1172-1201) |
| `propagate` (693-757) | `aPropagate` (1242-1303) |
| `shallowPropagate` (970-982) | `aShallowPropagate` (1313-1331) |
| `checkDirty`+`checkDirtyLoop`+`chainCheck` (766-968) | `aCheckDirty`+`aCheckDirtyLoop` (2946-3044) |
| `isValidLink` (984-993) | `aIsValidLink` (1342-1352) |
| `purgeDeps`/`disposeAllDepsInReverse` (1206-1221) | `aPurgeDeps`/`aDisposeAllDepsInReverse` (1203-1221) |
| `NodeField`/`LinkField`/`NodeFlag` (314-380) | `AF`/`AFlag` (823-875) |

**Why complex.** ~600-800 lines of mirrored walk logic that must be kept
bit-compatible by hand. The coupling is not hypothetical: `concurrent.ts`
walks the *kernel's own* buffer using the `AF` constants —
`kernelStrongDepsOf` (2179-2189), `newestReaches` (4178-4191),
`closureOverKernel` (5293-5305) all index `M[... + AF.DEPS]`,
`M[... + AF.L_DEP]`, `M[... + AFlag.K_COMPUTED]`. So `AF.DEPS===NodeField.DEPS`,
`AF.L_DEP===LinkField.DEP`, `AFlag.K_COMPUTED===NodeFlag.K_COMPUTED`, etc. are
already load-bearing equalities between two separate `const enum`s — the
layouts are unified in practice, just not in source. Every algorithm fix (the
row-2 freed-link discipline, the `checkDirty` hot/slow split for V8's
460-bytecode budget, the chain fast path) is made and re-argued twice.

**Simpler general form.** Two tiers, very different risk:
- (sub-part, SAFE-ish) One shared `const enum` module for the field/flag
  numbers both files already require to be equal, replacing the "asserted
  stable by the suite" hand-coupling with a single source of truth. Deletes
  one of the two enum blocks (~35 lines) and the stability test's reason to
  exist.
- (full, QUESTION) Extract the walk as one implementation parameterized by a
  graph backend (buffer accessor + flag constants + notify hook); kernel
  supplies closure-captured `M`, arena supplies `a.W` + the weak-list
  extension. Deletes ~400+ lines.

**Cost.** The full merge collides head-on with two *documented, measured*
optimizations: the kernel's speed identity is "`M` is a closure constant V8
folds into codegen" (index.ts 42-51) and "same-file `const enum` members
inline as literals; cross-file access becomes a runtime property lookup"
(index.ts 300-310, +15-21% when bundled). The arena already pays the
explicit-buffer cost (passes `a`), so a shared core can only be the *arena's*
slower shape — merging upward would regress the kernel's hot read/write
paths. Named perf risk: +15-25% on read/recompute-heavy workloads (their own
hidden-class/const-enum measurements). Tests: `bytecode.spec` (pins the
inline budget), `arena-*.spec`, the 179-case conformance.

**Verdict: QUESTION** for the full merge — is bit-level layout mirroring
across two hand-maintained copies worth the perf isolation, given the layouts
are *already* coupled by the `AF`-walks-`M` code? The perf notes argue
"keep." **The `const enum` unification sub-part is a defensible
SAFE-SIMPLIFICATION** if a single shared same-file re-export can preserve the
inlining (needs a `bytecode.spec` check); it removes a hand-maintained
invariant without touching a hot path.

### 2. A test-only divergence checker (with its own naive evaluator) ships in the runtime module, on a hot-path branch — TRADE / SAFE-split

**What.** `concurrent.ts` carries an armed dual-bookkeeping checker that only
tests enable (`__setArenaCheck(true)`, via `oracle-adapter.ts`): `arenaCheckOn`
/`inArenaCheck` (2518-2520), `__checkArenas` (3454-3522, ~68 lines),
`naiveValue`/`naiveStack`/`naiveFold` (2513-2515, 3530-3571, a *second, full
evaluator*), and `aValidate` (3308-3359, ~52 lines). Reached only from
`arenaOpEpilogue` (3270-3273). Crucially, `naiveFold` also adds a branch to
the **hot read path**: `atomValue` (2351-2352) tests `this.naiveFold !==
undefined` on every routed atom read, purely to serve the checker.

**Why complex.** `naiveValue`/`foldAtom` here duplicate the oracle model's
`evaluate`/`foldAtom` (`model.ts` 467-518) — a third naive evaluator beyond
the model and model-view. ~170 shipped lines + a read-path branch exist to
support a referee that production never arms.

**Simpler general form.** Move the divergence checker to a test-side wrapper
that reaches into arena state through the `__arena*ForTest` accessors that
already exist (3370-3439), deleting `naiveValue`/`naiveFold`/`aValidate`/
`__checkArenas`/`arenaCheckOn`/`inArenaCheck` and the `atomValue` `naiveFold`
branch from the shipped module. Deletes ~170 lines + 1 hot-path branch.

**Cost.** `__checkArenas`'s discipline is "serve from the arena's *own* walks
FIRST, then compare" — it needs private access to `aServe` mid-operation, so
extracting it means widening the `__*ForTest` surface (trade one test-only
surface for another) or accepting less faithful checks. `aValidate` is a
genuine structural self-check worth keeping shippable (like the cycle caps).
Behavior: none (arm defaults off). Tests: `oracle-adapter.ts`/`fuzz` drive
`__setArenaCheck`; `arena-*.spec`; the `naiveFold` deletion needs
`graph-consumers.spec`.

**Verdict: TRADE** for the checker as a whole (in-process fidelity vs shipped
weight + a hot branch). **SAFE-split**: at minimum, `naiveValue` duplicates
the oracle model and could be replaced by importing/reusing the model's
evaluator in the test harness; and the `atomValue` `naiveFold` branch is pure
test tax on a hot path — gating the whole checker behind a build flag removes
it. Counts as category (5) "test-only affordances in runtime."

### 3. Referee-only effect constructors + the `Subscription.body` path live in the runtime — SAFE-split

**What.** `mountReactEffect` (4418-4423), `mountReactEffectPick` (4427-4432),
`captureRead` (4484-4490), `replayReactEffect` (4527-4535), plus the `body`
field on `Subscription` (579) and the `body` arm of `runCommittedSub`
(4540-4555), exist **only** for lockstep: production `useSignalEffect` uses
`mountCommittedObserver` + `captureRun` + `refire` (see `shim.ts` 603-625).
`mountReactEffect*` are thin wrappers that set `body` and call
`captureRun`; they are invoked from `oracle-adapter.ts` (151-160) and
`schedule.ts`, never from `cosignal-react`.

**Why complex.** `Subscription` is one record carrying two firing
configurations (`refire` = production/queued, `body` = referee/inline); the
`runCommittedSub` and `flushNotify` code branch on which. The referee shape
is dead weight in the shipped class.

**Simpler general form.** Move `mountReactEffect`/`mountReactEffectPick`/
`captureRead`/`replayReactEffect`/`body`/the `body` arm into a test helper
built on the already-public `mountCommittedObserver` + `captureRun`. Deletes
~5 methods + one union field + one branch from the runtime `Subscription`.

**Cost.** `oracle-adapter.ts` and `schedule.ts` call these directly; the move
updates the harness to construct the body via `captureRun`. `captureRead`
requires an open capture frame — the harness already has `captureRun`, so it
can express the same bodies. Behavior: none. Tests: `concurrent-*` lockstep,
`fuzz`.

**Verdict: SAFE-SIMPLIFICATION** (mechanical; the primitives are already
public). The one nuance: lockstep must run the *real* mechanism, and it still
does — `captureRun` + `refire` are production paths. Only the convenience
constructors move.

### 4. The committed-boundary epilogue is copied across four sites — SAFE

**What.** The sequence "fan touched atoms into committed arenas → durable
drain → `revalidateCommittedSubs` → `directFlushCoreEffects` → `arenaDecay`
→ `flushNotify` → `arenaOpEpilogue`" recurs, with the same ordering and the
same `committedSubCount`/`newestSubCount` guards, in: `__quietWrite`
(3905-3913), `retireInternal` (4946-4963 + the drain loop), the commit arm of
`passEndInner` (4759-4783), and the `settlementDrain` cone loop (3243-3260).
The oracle mirrors the same recurrence (`retireInternal` /
`revalidateReactEffects` / `drainCommittedObservers`, `model.ts` 1207-1231).

**Why complex.** Four hand-maintained copies of a load-bearing ordering
("mutate → fan → drain → boundary sub-scan → flush," plan §4.3's joint). A
future ordering fix must land in all four; drift is a correctness bug, not a
cosmetic one.

**Simpler general form.** One `private runCommittedBoundary(touchedAtoms,
roots, cause)` that performs fan + decay + the two sub-scans (guarded) +
`flushNotify`, called by all four sites (each still owns its own
receipt-stamp/lock-in mutation before calling it). Deletes ~3 copies of the
6-8-line tail (~20-25 lines) and centralizes the ordering invariant.

**Cost.** The four sites differ slightly in which drains they gate (retire
drains per-root with a slot-bit gate; commit drains one root; quiet drains
all watchers directly). The helper covers the *common* tail (sub-scans +
decay + flush); the site-specific drain stays at the call site. Behavior:
none if the extraction preserves order. Tests: `concurrent-battery`,
`concurrent-scars`, `quiet-mode.spec`, the lockstep corpus (this ordering is
exactly what lockstep polices).

**Verdict: SAFE-SIMPLIFICATION** for the sub-scan+decay+flush tail; the
per-site drain call stays explicit.

### 5. The watcher correction block (×4) and the cross-world cycle-error (×6) are copy-pasted — SAFE

**What.** Two small verbatim repetitions:
- The correct-a-watcher block — `evaluate committed; if changedValue: [log];
  w.lastRenderedValue = now; w.dedupBits = 0; if (onCorrection) queueNotify(2,
  w,…)` — appears in `settlementDrain` (3248-3254), `quietDrain` (3925-3930),
  `drainCommittedObservers` (5158-5164), and `mountFixup`'s urgent arm
  (5250-5255). (The oracle mirrors it in `drainCommittedObservers`,
  `model.ts` 1281-1286.)
- The identical `BridgeScheduleError('cyclic evaluation of ${name} within one
  world …')` is thrown at **6** sites in `concurrent.ts`
  (`kernelTrackedReader`, `kernelUntrackedReader`, `kernelComputed`, `aServe`,
  `evaluate`, `naiveValue`) and 2 in the oracle.

**Why complex.** Four correction sites must agree that a correction resets
`dedupBits` *and* updates `lastRenderedValue` *and* queues kind-2 — a subtle
triple that is easy to get wrong in a new fifth site. Six cycle-error strings
are just noise.

**Simpler general form.** `private correctWatcher(w, world, cause):
boolean` (does the evaluate + changedValue + log + the triple + queueNotify);
`private cycleError(node): never`. Deletes ~15 lines of correction block and
5 duplicate throw strings; the correction contract lives in one place.

**Cost.** Trivial; correction sites are cold (drains/mounts). Behavior: none.
Tests: `concurrent-battery`, `concurrent-scars`, `quiet-mode`.

**Verdict: SAFE-SIMPLIFICATION.**

### 6. World-resolution ladder duplicated ×2, plus dead `effectiveWorld` — SAFE

**What.** `hostRead` (1747-1783) and `hostComputedRead` (1795-1824) contain
the *identical* prelude: `inFoldCallback` guard, then
`world = activeWorld ?? (captureFrame ? committed-for-cap : worldProvider())`,
capturing `cap`. They must stay identical for atom/computed parity.
Separately, `effectiveWorld()` (1735-1739) — a third, smaller copy of the
same resolution — **is defined but never called** (confirmed: only the
definition matches; zero call sites).

**Why complex.** Two hooks encode the read-world resolution order; a change
to that order (e.g. capture-frame precedence) must be mirrored. `syncReadRouting`
(1728) re-derives the "armed" predicate from the same three fields inline, a
fourth partial copy.

**Simpler general form.** `private resolveReadWorld(): { world: World |
undefined; cap: CaptureFrame | undefined }`, called by both hooks. Delete
`effectiveWorld` outright (dead). Deletes ~20 lines + the dead method.

**Cost.** The resolver runs per routed read while a world is armed — one
extra function call, but these already do object work; negligible, and it
removes the atom/computed drift hazard. Behavior: none. Tests:
`graph-consumers`, `scenarios`.

**Verdict: SAFE-SIMPLIFICATION** (and `effectiveWorld` is an unconditional
dead-code delete).

### 7. Fold-purity enforced by two mechanisms + a redundant assert + a fixed double-wrap idiom — TRADE (+ SAFE idiom)

**What.** "No signal read/write inside an updater/reducer/equals" is enforced
two ways: the kernel swaps the operation table to `POISON` (`runFold`,
index.ts 1901-1909) so raw kernel `.state`/`.set` throw; the bridge sets
`inFoldCallback` (`inCallback`, concurrent.ts 2221-2229) so *world-routed*
reads throw. A replayed op runs under **both** — `applyOp`/`applyOpPacked`/
`__quietWrite` all wrap as `inCallback(() => __hostRunFold(() => …))`
(2241, 2315, 3894). Additionally `__assertHostWritable` (index.ts 1571-1575)
re-checks `forbidWritesInComputeds && activeIsComputed()`, the same test
`writeAtom` already performs (index.ts 1870-1872).

**Why complex.** Two guards for one rule, applied together at every fold
site; the `inCallback(() => __hostRunFold(...))` idiom is repeated verbatim
three times; and one policy check is written twice.

**Simpler general form.** (a) One `private replayPure<T>(fn): T` = `inCallback(()
=> __hostRunFold(fn))`, used by `applyOp`/`applyOpPacked`/`__quietWrite` —
deletes the repeated double-wrap. (b) `__assertHostWritable` and the
`writeAtom` check can share one predicate.

**Cost.** The two *mechanisms* genuinely cover different entry points: POISON
catches raw kernel access (which bypasses the bridge), the flag catches
bridge-routed reads (served before the kernel). Collapsing to one mechanism
would leave a gap — so **keep both** (TRADE). Only the *idiom* and the
duplicated assert collapse. Behavior: none. Tests: `policy.spec`,
`concurrent-*`.

**Verdict: TRADE** on the two mechanisms (both needed); **SAFE** on the
`replayPure` idiom and the double-written policy check.

### 8. A family of near-identical graph walks — TRADE (hot) / SAFE (the cold pair)

**What.** `concurrent.ts` has ≥6 DFS walks with bespoke visited-stamp
bookkeeping: `deliveryWalk`+`walkArenaStrong` (3713-3761, forward strong subs),
`drainCommittedObservers`'s inline walk (5104-5142, forward both lists),
`closureOverArena` (5308-5334, reverse strong deps), `closureOverKernel`
(5293-5305, reverse kernel deps), `newestReaches` (4178-4191, reverse kernel
deps with early-exit). `closureOverKernel` and `newestReaches` are the *same*
kernel-deps DFS — the latter is the former plus a target early-exit.

**Why complex.** Each re-implements stack + `walk`/`lastWalk`/`seen` stamping.
Five near-copies of "DFS this packed graph in direction D over link-mode M,
visiting nodes."

**Simpler general form.** For the cold kernel pair: one
`kernelDepsDFS(kid, visit)` with an optional stop predicate serves both
`closureOverKernel` and `newestReaches` (deletes ~12 lines, removes a
copy). For the arena walks: a generic `arenaWalk(a, start, dir, mode,
visit)` could subsume the other four (~60 lines).

**Cost.** The arena walks are on the write/commit/mount hot paths; a generic
walk taking a visitor callback risks the megamorphic-callback cost the kernel
studiously avoids (its walks are hand-inlined for exactly this reason). So the
arena merge is a **TRADE** leaning "keep." The kernel `closureOverKernel`/
`newestReaches` pair is **cold** (per-mount / per-newest-sub-per-write) and
mergeable safely. Tests: `graph-consumers`, `observe-*`, `concurrent-*`.

**Verdict: TRADE** for the hot arena walks; **SAFE-SIMPLIFICATION** for the
`closureOverKernel`/`newestReaches` cold pair.

### 9. Exceptional-value ("box") handling implemented in both kernel and arena — TRADE (sub-finding of #1)

**What.** "Cache the thrown value/pending thenable, serve by re-throwing,
self-heal on settle, treat a stable `SuspendedRead` as the still-pending
identity" exists twice: kernel `HAS_BOX`/`BOX_SUSPENDED` +
`storeThrown`/`boxedRead`/`attachSettle`/`unwrapThenable` (index.ts
2102-2175), and arena `HAS_BOX`/`BOX_SUSPENDED`/`BOX_THROWN` +
`aNoteThrow`/`aFoldOutcome` + the `aServe` self-heal + `settlementDrain`
(concurrent.ts 2704-2718, 2898-2916, 2755-2761). The arena adds a third bit
(`BOX_THROWN`) to distinguish a *thrown* suspension from a *returned* sentinel
value.

**Why complex.** Same suspension protocol, two encodings; the extra
`BOX_THROWN` bit exists because the arena serves the shim's
"background-suspension-folds-to-sentinel-value" translation that the kernel
does not.

**Simpler general form.** This is downstream of Finding 1: the two boxings
exist because there are two graphs. If the walk core were shared, the box
protocol would share too. Standalone, they can't merge without the engines
merging (the kernel boxes are in `Int32Array` flags on `M`; the arena's on
`a.W`).

**Cost/Verdict: TRADE** — inherent to the two-engine split; note it as a
second cost of Finding 1's duplication rather than an independent fix.

### 10. Newest-effect flush: reach-scoped vs full-scan copies — SAFE (small)

**What.** `flushNewestSubs` (4153-4170) and `directFlushCoreEffects`
(4197-4207) share the identical per-sub body — `evaluate(node, NEWEST);
if (!Object.is(value, e.lastValue)) { e.lastValue = value; e.runs++; [log] }`
— differing only in the candidate set (reach-filtered vs all). The oracle's
`flushCoreEffects` (`model.ts` 785-795) is the same body with an optional
`reached` filter, i.e. the oracle already unified them into one method with a
parameter.

**Simpler general form.** Follow the oracle: one `flushNewest(candidates?)`
where `undefined` means full-scan; `flushNewestSubs` supplies the reach set.
Deletes ~10 lines and the second copy of the value-gate.

**Cost.** Negligible (a filter test). Behavior: none. Tests: `concurrent-*`,
core-effect scenarios.

**Verdict: SAFE-SIMPLIFICATION** (and the oracle is the proof it's fine).

### 11. Evaluation frame save/restore boilerplate repeated ×5 — TRADE

**What.** `evaluate` (2381-2428), `aUpdateComputed` (2822-2865),
`makeKernelGetter` (2068-2085), `makeAdoptedKernelGetter` (2092-2105), and
`naiveValue` (3532-3571) each: save a subset of {`activeWorld`, `currentSink`,
`obsCapture`, `aFrameArena`/`aFrameShadow`/`aFrameCycle`, `aOnly`, `naiveFold`,
`evalDepth`, `evalMark`}, set them, run `fn` in `try`, restore in `finally`,
then obs-sync.

**Why complex.** Five hand-rolled frame managers; the restore lists must stay
in sync with the field set, and a missed restore is a subtle world-leak bug.

**Simpler general form.** A `withEvalFrame(config, fn)` helper.

**Cost.** The subsets genuinely differ (kernel getters don't touch `aFrame*`;
`aUpdateComputed` sets `aFrame*`+`aOnly`; `naiveValue` sets `naiveFold`), and
these are the *hottest* eval paths — the code was deliberately flattened to
scalars because "one object per evaluation showed up in the cold-pass gate"
(2507). A config-object helper would reintroduce exactly that allocation.

**Verdict: TRADE** — the repetition is the price of the measured
no-allocation frame. Leave it; note it so a future reader doesn't "clean it
up" into a regression.

### 12. Quiet-mode as a parallel write path — TRADE

**What.** `__quietWrite` (3889-3914) re-does equality-drop, kernel apply,
committed-arena fanout, drain, both sub-scans, decay, and flush that the main
`writeInner` path (3990-4097) also performs.

**Why complex.** A second write path exists so that, while nothing is
pending, a write mints no token/receipt/tape/event (the "sync by default"
posture, README lines 190-203).

**Cost/Verdict: TRADE.** The whole *point* is to skip the receipt machinery,
which a single path can only do behind a branch — and that branch *is* quiet
mode. Keep it. But note: its tail is exactly Finding 4's committed-boundary
epilogue, so folding #4 shrinks `__quietWrite` too. The residual duplication
after #4 (the equality-drop check, also in `writeInner` 4022-4041 and
`writeAtom`) is small and not worth a third abstraction.

### 13. Is `mode: 'direct'` reachable in production? — QUESTION

**What.** `CosignalBridge` starts `mode: 'direct'` and flips to `'concurrent'`
at `registerBridge()`; `writeInner` (3991-4002) has a whole direct-mode arm
(mutate base, no receipt). But the only public entry, `registerReactBridge()`,
constructs *and* registers in one call (774-782), and `registerCosignalReact`
registers immediately (hooks.ts 45-46). Pre-registration atom writes are
handled by `adoptAtom` capturing current value as base (1953-1960), not by
direct-mode writes.

**Question.** Is the `writeInner` direct-mode arm reachable by any shipped
path, or only by tests that construct a bare `CosignalBridge`? If the latter,
the arm + the `mode` field's `'direct'` state are a test-only affordance that
could be documented as such (or the direct arm removed and pre-registration
writes routed through the kernel directly). Low confidence — flagged for the
owner to confirm against the test harness, not asserted.

---

## Already-minimal (no change recommended)

- **`trace.ts`** — a clean leaf: one packed-record emit path, one decode path,
  a small query set; imports the engine as *types only*; the "one nullable
  check when detached" discipline is genuinely the floor. No duplication with
  the engine (it consumes `BridgeEvent`, doesn't re-derive it).
- **`graphviz.ts`** — 88 lines, types-only imports, two pure renderers.
- **`cosignal-react/src/index.ts`** — a pure curated re-export; nothing to cut.
- **The host-seam design** (`__setHostRead`/`__setHostWrite` +
  `__HOST_MISS`, index.ts 1500-1667) — two nullable hooks and one
  `!== undefined` branch per public read/write is the minimal way to make the
  concurrency feature zero-cost-when-dormant; `one-core.spec` pins it.
- **`ReducerAtom`** (index.ts 2343-2355) — `dispatch(a) = update(s =>
  reduce(s,a))`; already the thinnest possible layer.
- **`effect`/`effectScope`/`batch`/`untracked`/`startBatch`/`endBatch`** —
  thin, correct wrappers over kernel ops; no fat to trim.
- **`Tape`** (concurrent.ts 248-321) — tight packed-column store with an
  amortized rebase; the column parallelism is intrinsic, not duplication.
- **`oracle/invariants.ts` and `oracle/schedule.ts`** — single-purpose,
  readable; the oracle's *deliberate* re-derivation of the contract (its
  `visible`/`foldAtom`/`evaluate` vs the engine's) is the methodology, not
  duplication to remove (merging engine and oracle would destroy the
  independent-oracle property — this is the one "don't unify" QUESTION whose
  answer is firmly "keep separate").

---

## Ranked one-liners

1. **Two hand-mirrored push-pull engines** (kernel `M` vs shadow arena `W`,
   `NodeField/NodeFlag` vs `AF/AFlag`, ~600-800 lines) — the shape of the
   whole; full merge is a QUESTION the perf notes answer "keep," but the
   *shared-const-enum* sub-part is a safe removal of a hand-maintained
   layout invariant.
2. **Test-only divergence checker in the runtime** (`naiveValue`/`aValidate`/
   `__checkArenas` ~170 lines + a `naiveFold` hot-read branch) — TRADE;
   `naiveValue` duplicates the oracle and the hot branch is pure test tax.
3. **Referee-only effect constructors + `Subscription.body`** — SAFE-split;
   move `mountReactEffect*`/`captureRead`/`replayReactEffect`/`body` to a test
   helper over the already-public `mountCommittedObserver`/`captureRun`.
4. **Committed-boundary epilogue copied ×4** (fan→drain→sub-scans→decay→flush)
   — SAFE; one `runCommittedBoundary` centralizes a load-bearing ordering.
5. **Watcher-correction block ×4 + cycle-error string ×6** — SAFE; two tiny
   helpers (`correctWatcher`, `cycleError`) delete ~20 lines and a triple-step
   contract's drift risk.
6. **World-resolution ladder ×2 + dead `effectiveWorld`** — SAFE; one
   `resolveReadWorld`; delete `effectiveWorld` outright (unreachable).
7. **Fold-purity: two mechanisms + redundant assert + ×3 double-wrap idiom** —
   TRADE on the two mechanisms (both cover distinct paths); SAFE on a
   `replayPure` idiom and the double-written policy check.
8. **Graph-walk family (≥6 DFS variants)** — TRADE for the hot arena walks
   (megamorphic-callback risk); SAFE for the cold
   `closureOverKernel`/`newestReaches` pair (same kernel-deps DFS).
9. **Box/suspension handling in kernel and arena** — TRADE; a second cost of
   #1's split, not independently fixable.
10. **Newest-effect flush: reach vs full-scan copies** — SAFE; unify to one
    parameterized method (the oracle already did).
11. **Eval frame save/restore ×5** — TRADE; the repetition is the measured
    no-allocation frame; leave, but document so it isn't "cleaned up."
12. **Quiet-mode parallel write path** — TRADE; inherent to sync-by-default;
    #4 shrinks it.
13. **`mode:'direct'` write arm reachable in production?** — QUESTION for the
    owner to confirm; may be a test-only affordance.
