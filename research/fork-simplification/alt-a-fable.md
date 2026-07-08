# Fork simplification for cosignals-alt-a (fable)

**Question.** If `vendor/react` (+5,012 insertions over upstream `e71a6393e6`, 19 files)
only had to support `packages/cosignals-alt-a`, how small could it get? alt-a may be
redesigned in tandem.

**Headline.** The 5,012-line diff is 3,502 lines of reconciler tests + 13 lines of
noop-renderer test support + **1,497 lines of product patch**. Of the product patch,
alt-a's bridge consumes a strict subset: two whole capability families
(`discardAllWip`, the DOM mutation window) and four protocol refinements (batch-id
allocator, pass-end disposition, retirement disposition, root commit generation) are
**never consumed or immediately discarded**. A same-architecture minimal fork lands at
**≈ 480–520 product LoC (−66%)** with zero expected RTL regressions; an "edge-export"
fork that moves the batch registry into alt-a lands at **≈ 200–220 LoC (−86%)**, still
full fidelity. Zero-fork kills every flagship guarantee alt-a exists for.

All line numbers below were read from the working tree; all LoC figures are counted
from `git diff e71a6393e6..HEAD` hunks (`-U0` + awk per-hunk added-line counts) or from
line ranges of the new files.

---

## 1. Inventory: what the fork ships vs. what alt-a consumes

### 1.1 The fork's product surface (counted)

| File | Added LoC | Content |
|---|---:|---|
| `packages/react-reconciler/src/ReactFiberBatchRegistry.js` | 564 (new) | batch slots, id mint, pending/backfill/finish/close edges, async-action parking, per-root commit report, `batchIdsForRender` lock-in, test reset |
| `packages/react/src/ReactExternalRuntime.js` | 334 (new) | isomorphic channel: listener Set + error-isolated `emit`, provider slot, batch-id **allocator** registration, public wrappers |
| `packages/react-reconciler/src/ReactFiberWorkLoop.js` | 291 (277 non-blank) | provider registration + `getCurrentWriteBatch` cascade (hunk `+876,187` = 184 lines: provider ≈57, `runInBatchImpl` ≈81, `discardAllWorkInProgress` ≈48), notify call-sites, commit-edge capture, mutation-window brackets |
| `packages/react-reconciler/src/ReactFiberExternalRuntime.js` | 204 (new) | reconciler-side channel: pass **frame sets** (`rootsWithActivePass`/`rootsWithYieldedPass`, lines 50–85), exactly-once notify fns (87–183), mutation-window notifiers (185–204) |
| `packages/react-reconciler/src/ReactFiberRootScheduler.js` | 33 (30 non-blank) | backfill call (+320), close edge (+357), `runInBatchTransitionLane` pin (+710,15 and +731,6) |
| `packages/react/src/ReactClient.js` + 7 entry `index*.js` + `ReactSharedInternalsClient.js` | 17 + 49 + 5 = 71 | 7 `unstable_*` exports × 7 entry points, `E` slot |
| `packages/react-noop-renderer/src/createReactNoop.js` | 13 | canceled-suspended-commit inertness (test infra for fork's own suite) |
| **Product total** | **1,497** (+13 noop) | |
| 4 reconciler test files | 3,502 | `BatchRegistry` 657, `ExternalRuntimeCommit` 891, `ExternalRuntimePass` 1,025, `RunInBatch` 929 |

### 1.2 What the bridge + engine actually call

The bridge (`packages/cosignals-alt-a/src/react/bridge.ts`, 190 lines) is the complete
consumer. Its `ForkReact` type (bridge.ts:58–72) names the whole consumed surface:

| Fork API / event | Bridge site | Engine consumer | Powers | RTL test that fails without it |
|---|---|---|---|---|
| `unstable_registerBatchIdAllocator` | bridge.ts:176–178 (mints `(++serial<<1)\|deferred`) | bit-0 encoding read at engine.ts:2483–2484, 2165, 2298; slot interning engine.ts:1462 | §6.2 one-number-space tokens; deferred classification without a second call | none *by itself* — replaceable by fork-side minting in the same encoding (§3, T1) |
| `unstable_subscribeToExternalRuntime` | bridge.ts:124–153 | `attachFork` listener engine.ts:2895–2932 | everything below | all |
| — `onRenderPassStart(container, included)` | bridge.ts:125–138 (lineage hard-coded 0) | `onPassStartEdge` engine.ts:2847–2875: pass world = include **mask** + pin; `renderInfo` engine.ts:3630; `inTransitionRender` engine.ts:3676–3690 | render reads resolve the pass's world; two-level suspense rule; thenable identity = node×mask (bridge.ts:22–27) | interleaved suspending transitions (real-react.spec.tsx:288–358), mounting-during-transition (:199–255), refresh-in-transition no-tearing (:527) |
| — `onRenderPassYield` / `onRenderPassResume` | bridge.ts:139–140 | engine.ts:2901–2909 (`readCtx` flips); backup heal engine.ts:1550–1564 | gap code reads NEWEST, resumed render reads pass world | suspense/interruption family (:141–197, :258–357) — resumes would read the wrong world |
| — `onRenderPassEnd(container, committed)` | bridge.ts:141–145 — **`committed` bit dropped** | `onPassEndEdge` engine.ts:2877–2888: sweep + quiescence | tape folding, memory reclamation | gc-leaks/memory suites; indirectly all (stuck pass ⇒ stale reads healed, but tape pinned) |
| — `onBatchRetired(id, committed)` | bridge.ts:146 | `onBatchRetiredEdge` engine.ts:2576–2670 — **disposition ignored** (engine.ts:2576–2577 `_committed`, "folds identically"; used only by the tracer at :2586) | absorption of the batch's tape entries into W0, exactly once | lockstep (:113–139), invisibility family (:648–728) |
| — `onRootCommitted(container, batches, gen)` | bridge.ts:147–152 — **`gen` dropped**, fanned out per batch | `onBatchCommitted` engine.ts:2911–2927: `rootViews` pin+mask, `commitListeners` → `committedEffect` engine.ts:3472–3511 | per-root committed views; `useSignalEffect`/`useCommitted` (hooks.ts:253–321) | multi-root committed effects (:400–426), committed-only effect (:427–473), `useCommitted` (:715–729) |
| `unstable_getCurrentWriteBatch` | bridge.ts:158, 160–162 | write classification `writeOp` engine.ts:2483–2484; ambient probe engine.ts:1582; `forkBatchDuringCallback` engine.ts:2148 | every LOGGED write's token; alt-family W0 ambient rule | every transition test |
| `unstable_getRenderContext` | bridge.ts:163–165 | `healStaleRenderCtx` engine.ts:1557–1564 (suspension-exit healing — the fork emits **no yield edge on suspend-exit**, engine.ts:1550–1556); write gate engine.ts:2451 | self-healed render-context truth; render-write throw | write-gate.spec; suspense (:258) |
| `unstable_runInBatch` | bridge.ts:166–170 | `decideEntangled` engine.ts:2164–2172; drain groups engine.ts:2298–2311, 2409–2422; `subscribeWithFixup` check-2 engine.ts:3543–3555; hooks rely on lane inheritance (hooks.ts:10–12, 153–156) | watcher setStates join the writing batch's **own lane** → single-commit lockstep; mount-join corrections | lockstep (:113), interruption+rebase (:141), mounting-during-transition (:199) |
| `unstable_resetBatchRegistryForTest` | bridge.ts:187 (optional-chained) | test hygiene only | — | — |

### 1.3 Shipped but **never consumed** by alt-a

| Fork surface | Where it lives | Counted LoC | Evidence of non-consumption |
|---|---|---:|---|
| `onBeforeMutation` / `onAfterMutation` | FiberExternalRuntime.js:185–204 (20), WorkLoop +4297,6 & +4314,3 (9), ExternalRuntime.js types/emits (~22), listener docs (~8) | **~59** | bridge listener (bridge.ts:124–153) never subscribes them; engine `attachFork` (engine.ts:2895–2931) has no handler. Only the *fork test double* still simulates them (fork-double.ts:383–390) |
| `unstable_discardAllWip` | WorkLoop 1014–1061 (48), `getRootsWithOpenPassFrames` FiberExternalRuntime.js:74–85 (12), ExternalRuntime.js:318–323 + provider-type docs (~14), 7 index exports (7) | **~81** | absent from the bridge's `ForkReact` type (bridge.ts:58–72); zero grep hits in alt-a src/tests |
| Batch-id **allocator machinery** | ExternalRuntime.js:74–86 (13) + 264–289 (26) + runtime field/docs (~8), registry branch ReactFiberBatchRegistry.js:174–177 & fallback counter 101–103 (~10), 7 exports (7) | **~64** | consumed (bridge.ts:176–178) but **invertible**: alt-a's allocator is 1 pure line, `(++serial<<1)\|deferred` — the fork can mint that itself (§3, T1) |
| `onRenderPassEnd` disposition + fork-side exactly-once **frame sets** | FiberExternalRuntime.js:50–72 (23) + implicit-end block 99–105 (7) + `notifyRenderPassCommitted` 162–183 (22) + WorkLoop +4020 site (2) + emit plumbing (~8) | **~62** | bridge drops the bit (bridge.ts:141) *and* keeps its own `passOpen`/`openContainer` pairing state anyway (bridge.ts:108–111, 127–129) — pairing is enforced twice |
| `onRootCommitted` generation | registry 105–111 + 301–304 + emit params | **~15** | bridge.ts:147–152 ignores arg 3; engine uses its own `ticket()` (engine.ts:2919) |
| `onBatchRetired` disposition | `retireSlot` disposition computation ReactFiberBatchRegistry.js:373–378 + params | **~10** | engine.ts:2576–2577 ignores it |
| Multi-listener Set + error isolation | ExternalRuntime.js:174–190, 253–262 | **~30** | single consumer by construction; the bridge already `guard()`s every callback into its `errors` array (bridge.ts:115–121, 92) |
| Noop-renderer patch | createReactNoop.js | **13** | supports the fork's own jest test (commit 925210e6f8); alt-a runs react-dom |
| Render lineage, versioned handshake, `unstable_isCurrentWriteDeferred` | already deleted fork-side (commits 30ca859c7b, e04aa18116) | 0 | precedent: alt-a's Solid-adapted async model keys thenables on node×mask, so lineage died (bridge.ts:22–27, 131–136) |

**Sum of dead-or-invertible surface: ≈ 334 LoC** before touching anything alt-a
actually depends on.

One wart worth recording: the bridge implements the engine's *non-minting* deferred
probe (`isCurrentWriteDeferred`, demanded non-minting at engine.ts:1578–1580) as
`unstable_getCurrentWriteBatch() & 1` (bridge.ts:156–159) — which **mints** an urgent
event batch on ambient reads while any deferred batch is live (provider
`getCurrentWriteBatch` funnels into `getOrCreateBatchId`, WorkLoop 896–925 →
ReactFiberBatchRegistry.js:168–190). Harmless (the empty batch retires
`committed=false` at the close edge and `onBatchRetiredEdge` ignores unknown tokens,
engine.ts:2578–2581) but it churns a slot per probed event. Fixed for free in §3, T2.

---

## 2. The minimal protocol (same architecture, full fidelity) — "F1"

Design rule: **the fork emits raw edges from lines the reconciler already touches; all
protocol *semantics* (pairing, exactly-once, dispositions, allocation, tables the
consumer ignores) move into the bridge**, which already holds the state to enforce
them. The engine-facing `ForkAdapter` seam (fork-double.ts:49–55) does not change, so
the entire unit/oracle suite keeps pinning semantics.

Kept, per patch (retained-LoC estimates are sums of the counted ranges above with
docs trimmed to upstream-normal density):

| # | Patch | Current | Retained | Why kept / what changed |
|---|---|---:|---:|---|
| 1 | Registry core: slots, `getOrCreateBatchId`, `lookupLiveBatchSlot`, pending edge (registry 63–227) | ~200 | ~75 | **allocator inverted**: mint is `(++serial<<1)\|deferred` inline (2 lines); fallback counter and allocator branch die |
| 2 | Finish edge + per-root commit report incl. `committedRoots` lock-in and the repended/rendered-lanes refinement (registry 105–134, 257–406; WorkLoop +3992,19 & +4020,16) | ~215 | ~100 | generation and retirement disposition dropped. Lock-in kept: without it an urgent pass on a root that already committed a still-pending batch would *exclude* it and tear against its own DOM (registry 517–564 rationale; multi-root RTL :400). Refinement kept in F1: it is what makes `onRootCommitted` truthful when a `runInBatch` mount-correction re-pends the lane the committing pass rendered — exactly the mounting-during-transition (:199) machinery |
| 3 | Close edge + backfill + async-action parking (registry 229–255, 408–472; RootScheduler +320,5 & +357,3) | ~100 | ~75 | all load-bearing: backfill prevents early retirement for `startTransition(() => { setState(x); store.write(y) })` ordinary line order (registry 229–241); parking keeps store-only async-action drafts invisible until settlement (registry 421–441) |
| 4 | Pass lifecycle emits (WorkLoop +2483, +2856, +2965, +3033, +3258; `batchIdsForRender` registry 533–564) | ~120 | ~55 | frame sets deleted; fork emits **raw** start/yield/resume from the 5 existing sites; `prepareFreshStack(root, NoLanes)` emits an empty start = reset. Pass-end synthesized in the bridge (§3, T3) |
| 5 | Provider: `getRenderContext` + `getCurrentWriteBatch` cascade + `ensureScheduleIsScheduled` (WorkLoop 876–932) | ~57 | ~45 | untouched — this *is* the write classifier and must call `requestTransitionLane`/`resolveUpdatePriority` fork-side |
| 6 | `runInBatch` + transition-lane pin (WorkLoop 933–1013; RootScheduler +710,15 & +731,6) | ~100 | ~70 | untouched semantics; docs trimmed. Sole mechanism for lane-scoped corrections — no upstream substitute exists (a fresh `startTransition` mints a lane React never entangles with the pending batch; the update commits separately = tear) |
| 7 | Isomorphic channel (ExternalRuntime.js) | 334 | ~50 | single-listener slot on `ReactSharedInternals.E`; Set/emit/error isolation/allocator/wrapper docs die; bridge already isolates errors |
| 8 | Exports + `E` slot (ReactClient + 7 index files + SharedInternals) | 71 | ~20 | one `unstable_externalRuntime` namespace export instead of 7 names × 7 entries |
| 9 | markRootUpdated pending-edge hook (WorkLoop +1964,4) | 3 | 3 | untouched |
| 10 | `discardAllWip`, mutation window, noop patch, dispositions, generation, multi-listener | ~240 | **0** | deleted (§1.3) |

**F1 total ≈ 480–520 product LoC** (vs 1,497), same file set minus
`ReactFiberExternalRuntime.js` (its ~40 surviving lines merge into the registry).
Fork tests shrink proportionally: the pass-frame suite (1,025 lines) mostly tests
machinery that moved to the bridge — its invariants become vitest tests against
fork-double/bridge, which run in ~1s instead of jest-against-source.

Upstream-mechanism substitutions considered and rejected for F1:

- **`useSyncExternalStore` for delivery** — replaces nothing the fork does; uSES
  forces sync consistency by *de-opting* transitions, the opposite of alt-a's product.
- **`ReactSharedInternals.T` read for classification** — replaces the *probe* (T2
  below) but not `getCurrentWriteBatch`: identity must match React's lane merging
  (registry 42–46 merge rule), unknowable from `T` alone.
- **MutationObserver / layout-effect sentinels for commits** — cannot observe
  prop-only or effect-only commits per root reliably; per-root report stays fork-side.

## 3. Tandem alt-a redesigns, priced

| ID | Change | alt-a Δ | Fork Δ | Semantics risk |
|---|---|---:|---:|---|
| T1 | **Invert the allocator**: fork mints `(serial<<1)\|deferred` itself; delete `registerBatchIdAllocator` | −8 (bridge.ts:67, 105, 172–178) | **−64** | none: the encoding is spec §6.2 and the engine already treats bit 0 as the classification (engine.ts:2481–2484). Contract pinned by one fork test |
| T2 | **Non-minting deferred probe**: bridge's `isCurrentWriteDeferred` reads `ReactSharedInternals.T !== null && !T.gesture` instead of `getCurrentWriteBatch() & 1` | ±0 (swap 2 lines) | 0 | kills the mint-on-ambient-read wart (§1.3). Coupling to internals shape is moot — we own the fork; mirrors the classifier's own branch (WorkLoop 905–911) |
| T3 | **Bridge-synthesized pass-end**: fork drops frame sets, `notifyRenderPassCommitted`, `emitRenderPassEnd`, the end disposition. Bridge closes the open pass on (a) next `onRenderPassStart` — it already does, bridge.ts:127–129 — and (b) `onRootCommitted` for the open container (before fanning out commits, preserving "no committed-view advance under an open same-root frame") | +10 | **−~62** | the fork's multi-frame truth (several open frames, FiberExternalRuntime.js:56–58) is *already* flattened to one pass by the bridge (bridge.ts:108–111) and one global pass state in the engine (engine.ts:2847–2888) — so nothing observable changes. Residual: a discarded pass with no successor render keeps the engine's pass open until the next render **anywhere** → sweep/quiescence delayed (bounded by next render; correctness self-heals via `healStaleRenderCtx`) |
| T4 | **Single-listener channel** (drop Set/emit/error isolation) | 0 | **−~30** | none: bridge guards every callback (bridge.ts:115–121) |
| T5 | Drop retirement disposition + commit generation from the wire | −2 (types) | **−~25** | none: both already discarded (engine.ts:2576; bridge.ts:147) |
| T6 | **Registry-in-bridge ("edge-export fork", F2)**: fork exports only raw facts it alone can see — `getCurrentWriteLane():{lane,deferred}` (cascade + `ensureScheduleIsScheduled`), `getRenderContext()`, `runInBatch(lane,deferred,fn)` (pin), and raw emits: `rootUpdated(container,lane)`, `passStart(container,entangledLanes)`, yield/resume, `rootCommitted(container, entangledFinishedLanes, remainingLanes, rependedLanes)`, `eventClosed(actionLane, actionThenable)`, `scheduledRootPending(container, pendingLanes)`. The bridge re-implements slots/mint/merge/lock-in/parking in TS | **+~260** (bridge 190 → ~450) | **−~300 more** (fork ≈ 200–220 total) | the subtle logic (merge rule, lock-in, parking self-invalidation, backfill) moves to vitest-land where alt-a's oracle can fuzz it. Costs: lane bitmasks cross the userspace boundary (couples bridge to 31-lane layout — acceptable for a pinned fork, bad for an upstreamable protocol); the fork's 3,502-line jest suite is largely rewritten as ~1/3 as much vitest |
| T7 | **Drop yield/resume**, heal both directions by probing `getRenderContext` while `passOpen` | +6 engine | −~14 | rejected for the default: render-path reads already probe (engine.ts:2944–2951 calls `healStaleRenderCtx` on hot render reads), but the *resume* direction would add a fork probe to every NEWEST read while a pass is open — the accessor layers were ~20% of a kairo tick (engine.ts:2941–2943); 14 fork lines don't buy that risk |
| T8 | **Avoid `runInBatch` via same-event `startTransition`** (watcher deliveries for the writing batch run synchronously inside the user's transition scope, where a plain `startTransition` joins the same event lane) | +15 | −~70 | **rejected**: covers only synchronous same-event deliveries. `subscribeWithFixup` check-2 (engine.ts:3543–3555) fires in a *later* urgent commit's layout effect, and urgent-drain expansions (engine.ts:2404–2422) fire in later events — both would mint fresh lanes and commit separately → mounting-during-transition (:199) and lockstep (:113) fail by one-frame tears. `runInBatch` is the flagship's load-bearing wall |

## 4. The capability/LoC curve

| Point | Product fork LoC | alt-a Δ | What dies |
|---|---:|---:|---|
| **F0** current | 1,497 (+13 noop, +3,502 tests) | — | nothing |
| **F1** minimal protocol (T1–T5, deletions §1.3) | **≈ 500** | +2 net | nothing observable. Residuals: delayed sweep after an orphaned discarded pass (T3); protocol no longer speaks to any consumer but alt-a |
| **F2** edge-export fork (T6) | **≈ 210** | +~260 | nothing observable; loses upstream-shaped protocol and version-skew tolerance (lane bits on the wire); registry tests move to vitest |
| **F3** reduced | ≈ 150 | +~10 | drop parking → a store-only async action's drafts absorb at event close, **mid-action invisibility violated** for `startTransition(async () => { sig.set(d); await save(); … })`; drop backfill → setState-before-store-write transitions retire early, **pending drafts leak into ambient W0 pre-commit**; drop repended refinement → lock-in gap after a mount-correction re-pends a rendered lane: one urgent pass can tear against the root's own DOM (:199 family under racy timing); drop yield/resume → T7 read-cost |
| **F4** zero-fork (unpatched React) | **0** | bridge rewritten as a uSES-class shim (~+300, most of the engine's world machinery inert) | **lane-aligned broadcasts die** (no `runInBatch`: watcher setStates flush urgently or in fresh lanes → lockstep single-commit `:113` fails — a frame can mix old/new); **mount-during-transition dies** (`:199` — late reader either tears or force-syncs the whole transition); **interleaved pending transitions die** (`:288` — no included-batches, so one pass cannot tell which world it renders; thenable identity node×mask collapses → refetch loops or cross-transition aliasing); **per-root commits die** (`:400`, `:427`, `:715` — no commit edge exists in userspace; layout-effect sentinels only see commits that re-render the sentinel); **retirement dies** (absorption timing guessed from wrapped `useTransition` sentinels; unwrapped `startTransition` invisible); classification degrades to a `ReactSharedInternals.T` read (deferredness ok-ish, identity/merge-rule gone). Survives: W0 urgent semantics, basic `useSignal` re-render, first-load suspense via `use()`, StrictMode hygiene — i.e. exactly the uSES class alt-a was built to beat. flushSync parity (`:359`) partially survives only if delivery goes back to synchronous per-hook subscription |

## 5. Recommendation + migration

**Adopt F1 now; hold F2 as the destination if rebase cost dominates.** F1 is
mechanical, keeps the protocol shape recognizable (upstream-conversation value), cuts
the fork by two thirds, and — the real maintenance win — shrinks the diff inside
*upstream-owned* files (WorkLoop 291→~135, RootScheduler 33→21; everything else is
new files that rebase trivially). F2 is strictly smaller and moves the subtle,
bug-prone registry logic behind alt-a's vitest/oracle harness, at the price of lane
bits on the wire; take it only after F1 has burned in, since it rewrites the fork's
test suite.

Migration (each step lands green on the alt-a RTL suite + the surviving fork tests;
the `ForkAdapter` seam and fork-double are untouched throughout, so unit/oracle
suites pin semantics at every step):

1. **T1 + T2** (allocator inversion, T-probe): fork −64, bridge −8. Pin the token
   encoding with one registry test.
2. **T4 + T5** (single-listener channel, drop dispositions/generation): fork −55,
   bridge types −2.
3. **T3** (bridge-synthesized pass-end, delete frame sets): fork −62, bridge +10.
   Port the pass-pairing invariants from `ReactFiberExternalRuntimePass-test.js` to
   bridge-level vitest.
4. **Delete** `discardAllWip` (−81), mutation window (−59), noop patch (−13), and the
   now-orphaned exports; collapse to the namespace export (−~50 across entries).
5. Trim doc-comments in the registry/WorkLoop hunks to upstream density (−~150).
   → **F1 ≈ 500 LoC.**
6. (Optional, later) **T6**: introduce the raw-edge surface beside the registry, port
   the bridge to it behind a flag, run both under the oracle fuzz for a soak, then
   delete the fork-side registry. → **F2 ≈ 210 LoC.**

The one thing never to cut: `runInBatch` + the transition-lane pin. Every analysis
path (T8, F4) converges on the same fact — scheduling a correction *into an existing
batch's lane* is the only capability with no userspace substitute, and it is what the
product's headline guarantees (`:113`, `:141`, `:199`) rest on.
