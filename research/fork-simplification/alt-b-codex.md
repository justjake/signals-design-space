# How small can the React fork be for cosignals-alt-b?

## Executive result

The current React patch is much larger than alt-b's actual dependency on it. The exact
`e71a6393e6..HEAD -- packages` delta is 5,012 added lines in 19 files, but that splits into:

| Surface | Added LoC | What it contains |
| --- | ---: | --- |
| Non-test implementation/support | 1,510 | Generic public API, renderer/provider transport, batch registry, pass lifecycle, `runInBatch`, mutation brackets, discard/reset support |
| React-internal tests | 3,502 | 41 tests across four files |
| Total | 5,012 | |

If the fork exists only for alt-b, the safe target is **about 300–370 non-test fork LoC**
(roughly 75–80% less than 1,510), in **three or four reconciler files**, with no new public
React exports. A focused reconciler test suite should cost another 450–650 LoC, putting the
whole fork delta around **750–1,020 LoC**, roughly 80–85% below the current 5,012.

That target preserves the behavior the current bridge and 27 real-React/RTL tests exercise:
transition/React-state lockstep, pass-specific reads, interruption and rebase, mount during a
transition, context-sensitive Suspense, strict-lane visibility, multiple roots, committed
effects, and late corrective scheduling. It does so with one alt-b-specific object on React's
already-exported shared internals instead of the current generic public channel.

There is also a plausible **0–30 fork-LoC** architecture based on a required root provider and
a React Context/update-queue “world carrier.” It is not an equivalent drop-in simplification.
It moves roughly 250–450 LoC and a React update allocation per root/batch into alt-b, and its
abort, pruning, root-lifecycle, late-subscription, and performance properties are not proved.
It deserves a bounded falsification spike, not a claim that the fork can already be deleted.

### Counting convention

The current counts above are exact `git diff --numstat` additions. Proposed counts are physical
fork-diff LoC estimates, including concise types/comments/imports but excluding generated build
artifacts. Ranges are intentional: a spike is required to price React feature-flag branches and
the retained tests exactly. “Alt LoC delta” below is similarly a review estimate, not a measured
patch.

## 1. Inventory: what alt-b actually consumes

### 1.1 Current patch allocation

| Current patch region | Added LoC | Alt-b disposition |
| --- | ---: | --- |
| `packages/react/src/ReactExternalRuntime.js` | 334 | Generic isomorphic façade; replace completely |
| `ReactClient` + `ReactSharedInternalsClient` + seven `index*.js` files | 71 | Public export plumbing; replace completely |
| `ReactFiberBatchRegistry.js` | 564 | Semantically important, structurally over-general and comment-heavy; retain a smaller core |
| `ReactFiberExternalRuntime.js` | 204 | Retain only pass start/end and an exact “rendering root now” query |
| `ReactFiberWorkLoop.js` additions | 291 | Retain write attribution, pass/commit hooks, and deferred `runInBatch`; delete unrelated paths |
| `ReactFiberRootScheduler.js` additions | 33 | Retain close/backfill and the lane pin |
| `react-noop-renderer` canceled-commit support | 13 | Added for `discardAllWip`; delete with that unused API |
| Four reconciler test files | 3,502 | Replace with an alt-b contract matrix |

The public React export list has seven unstable functions (`vendor/react/packages/react/src/ReactClient.js:131-138`), while the actual bridge's runtime type requests only six of them plus `startTransition` and an optional test reset (`packages/cosignals-alt-b/src/react.ts:448-469`). This mismatch is the first indication that the channel was built for a broader design than alt-b.

### 1.2 API calls

| React/fork surface | Exact alt-b consumer | Feature powered | Minimal-fork verdict |
| --- | --- | --- | --- |
| `unstable_registerBatchIdAllocator(allocate)` | `ReactFork` mints `(serial << 1) \| deferred`, records the live token, and emits its local open edge (`packages/cosignals-alt-b/src/react.ts:488-494`). The engine reads the low bit instead of making a second classification call (`packages/cosignals-alt-b/src/engine.ts:2286-2291`). | One integer namespace, deferred classification, live-token set, and the DIRECT→LOGGED edge. This underlies transition lockstep (`packages/cosignals-alt-b/test/react-real.test.tsx:79-98`) and the two gate modes (`packages/cosignals-alt-b/test/react-real.test.tsx:811-853`). | Retain as one nullable `allocate(deferred) -> token` field on the internal host object. No registration function or public export. |
| `unstable_subscribeToExternalRuntime(listener)` | Installed once by `ReactFork` (`packages/cosignals-alt-b/src/react.ts:495-538`), then fanned out through a second listener `Set` (`packages/cosignals-alt-b/src/react.ts:542-553`). Registration is already singleton-enforced (`packages/cosignals-alt-b/src/react.ts:686-694`). | Transport for pass, retirement, and per-root commit facts. | Delete both listener layers. The reconciler calls one alt-b consumer object directly. |
| `unstable_getCurrentWriteBatch()` | The write path calls it once per logged write (`packages/cosignals-alt-b/src/react.ts:573-584`; `packages/cosignals-alt-b/src/engine.ts:2280-2291`). The transition helper also forces minting after its scope (`packages/cosignals-alt-b/src/react.ts:646-652`). | Attributes each log record and watcher delivery to the same React batch/lane as surrounding state updates; enables W0/draft separation and rebase. | Retain. It is one of the irreducible reconciler facts. It may be narrower than the generic implementation because alt-b forbids writes during render before asking for a batch (`packages/cosignals-alt-b/src/engine.ts:2227-2230`). |
| `unstable_getRenderContext()` | `ReactFork.getRenderContext` delegates directly (`packages/cosignals-alt-b/src/react.ts:600-602`). The engine uses it to distinguish actual render execution from an open pass gap (`packages/cosignals-alt-b/src/engine.ts:447-463`) and to reject render writes (`packages/cosignals-alt-b/src/engine.ts:2227-2230`); `useSignalEffect` captures its root during render (`packages/cosignals-alt-b/src/react.ts:927-945`). | Exact per-callstack render truth, render purity, yield-gap writes, and effect-root identity. | Retain as `renderingRoot(): container | null`. A Context provider can replace the root identity, but not all raw render reads without an API/performance tradeoff. |
| `unstable_runInBatch(token, fn)` | Wrapped at `packages/cosignals-alt-b/src/react.ts:604-613`. Deferred watcher groups use it (`packages/cosignals-alt-b/src/engine.ts:2539-2554`), urgent writes re-evaluate every live deferred world through it (`packages/cosignals-alt-b/src/engine.ts:2559-2576`), and the post-subscribe fixup uses it (`packages/cosignals-alt-b/src/react.ts:178-197`). | Schedules a correction into an **existing** transition lane, so it cannot commit after the batch it corrects. The unit contract is explicit at `packages/cosignals-alt-b/test/react.test.ts:131-145`; React's lane override is at `vendor/react/packages/react-reconciler/src/ReactFiberRootScheduler.js:710-735`. | Retain for full semantics, but narrow it to deferred live tokens and a boolean result. Alt-b itself owns the retired-token urgent fallback, so React need not run urgent/unknown callbacks. |
| `unstable_resetBatchRegistryForTest()` | Called only in RTL setup/teardown (`packages/cosignals-alt-b/test/react-real.test.tsx:34-55`). It is not in `ReactFork`'s production behavior. | Test isolation. | Remove from public React. Prefer module-reset/fresh-renderer tests or a DEV-only method on the private host object (about 8–12 LoC if still needed). |
| `unstable_discardAllWip()` | Exported by React (`vendor/react/packages/react/src/ReactClient.js:131-138`) but absent from alt-b's exhaustive `ReactRuntime` type (`packages/cosignals-alt-b/src/react.ts:448-469`) and never called. | Nothing in alt-b. | Delete, along with the noop-renderer cancellation patch it induced. |
| Shared-internals transition slot `T` | `ReactFork` reads the already-exported internals (`packages/cosignals-alt-b/src/react.ts:564-570`). It remembers `T -> token` for read-your-own-draft (`packages/cosignals-alt-b/src/react.ts:573-598`) and probes `T` before lazy minting for the loose gate (`packages/cosignals-alt-b/src/react.ts:627-643`). React sets/restores `T` around public `startTransition` (`vendor/react/packages/react/src/ReactStartTransition.js:45-76`, `vendor/react/packages/react/src/ReactStartTransition.js:94-117`). | Pre-mint transition detection and synchronous read-your-own-draft. | Keep using it; it is upstream machinery, not fork LoC. Document that it covers the synchronous scope, not a bare post-`await` continuation. |
| Public `startTransition` / `useTransition` / `use` | The bridge's helper uses public `startTransition` (`packages/cosignals-alt-b/src/react.ts:646-652`); the exported hook uses public `useTransition` (`packages/cosignals-alt-b/src/react.ts:948-960`); suspended boxes use public `use` (`packages/cosignals-alt-b/src/react.ts:753-799`). | Throughput helper, pending UI, and Suspense retry. | Upstream; no fork patch. |

Two bridge methods are dead weight. `isCurrentWriteDeferred()` is implemented by minting/reading a token (`packages/cosignals-alt-b/src/react.ts:555-557`), but the engine classifies from the token low bit. The `createReactBindings().signalTransition()` analogue (`packages/cosignals-alt-b/src/react.ts:335-352`) duplicates the real hook's public-React implementation (`packages/cosignals-alt-b/src/react.ts:948-960`) and exists for the fork-double unit layer, not the production hook.

### 1.3 Event consumption

| Current event | Actual downstream work | Feature/test it powers | Verdict |
| --- | --- | --- | --- |
| `onRenderPassStart(container, included)` | `ReactFork` filters and forwards it (`packages/cosignals-alt-b/src/react.ts:496-508`). Bindings remember the pass token set (`packages/cosignals-alt-b/src/react.ts:77-84`); the engine captures its sequence pin and include mask (`packages/cosignals-alt-b/src/engine.ts:3815-3838`). | A mount in a transition reads the pending world (`packages/cosignals-alt-b/test/react-real.test.tsx:147-174`); transition refresh suspends instead of committing stale data (`packages/cosignals-alt-b/test/react-real.test.tsx:386-424`); render-time `useLatest` remains pass-pure (`packages/cosignals-alt-b/test/react-real.test.tsx:713-756`). | Retain, without a lineage argument. Pass start is the only sound place to capture alt-b's sequence pin. Also remove the bridge's `included.filter(...)` allocation: the host registry already emits only allocated live tokens (`vendor/react/packages/react-reconciler/src/ReactFiberBatchRegistry.js:533-563`). |
| `onRenderPassYield` / `onRenderPassResume` | The adapter forwards them (`packages/cosignals-alt-b/src/react.ts:509-517`); the engine flips `currentCtx` (`packages/cosignals-alt-b/src/engine.ts:3840-3845`). | Intended to make gap code non-rendering. | Delete both. Alt-b already polls exact render truth whenever its scalar says RENDER and downgrades gaps to NEWEST (`packages/cosignals-alt-b/src/engine.ts:447-463`). Leaving the scalar RENDER from start to end gives the same behavior: the getter is null in a gap and non-null on resume. This removes duplicated representations of “rendering now.” |
| `onRenderPassEnd(container, committed)` | The adapter ignores `committed` and clears its pass (`packages/cosignals-alt-b/src/react.ts:519-525`); bindings clear `currentPass` (`packages/cosignals-alt-b/src/react.ts:85-87`); the engine closes the pin, sweeps, and checks quiescence (`packages/cosignals-alt-b/src/engine.ts:3846-3860`). | Releases retained history and returns to the idle fast path after commit/discard. | Retain `passEnd(container)` only. No disposition is consumed. |
| `onBatchRetired(token, committed)` | The adapter removes the token and forwards both fields (`packages/cosignals-alt-b/src/react.ts:527-530`), but bindings and engine use only the token (`packages/cosignals-alt-b/src/react.ts:98-107`; `packages/cosignals-alt-b/src/engine.ts:3866-3873`). | Absorb/promote or abandon tape entries, clear pending state, free watcher baselines, and return to DIRECT. Held-transition rebase depends on it (`packages/cosignals-alt-b/test/react-real.test.tsx:100-145`); W0/latest separation depends on it (`packages/cosignals-alt-b/test/react-real.test.tsx:652-700`). | Retain `retire(token)` only. The `committed` boolean is dead for alt-b: its logged operations remain real in either outcome. |
| `onRootCommitted(container, tokens, generation)` | The adapter ignores `generation`, fans tokens out as `onBatchCommitted` (`packages/cosignals-alt-b/src/react.ts:531-535`), and bindings advance a root pin/lock-in set (`packages/cosignals-alt-b/src/react.ts:88-107`). | Per-root committed reads/effects while a batch remains pending elsewhere (`packages/cosignals-alt-b/test/react.test.ts:33-64`, `packages/cosignals-alt-b/test/react.test.ts:67-90`) and committed-effect ordering (`packages/cosignals-alt-b/test/react-real.test.tsx:933-952`). | Retain `rootCommit(container, tokens)` only. Drop generation and per-token fan-out. |
| `onBeforeMutation` / `onAfterMutation` | The adapter re-emits them (`packages/cosignals-alt-b/src/react.ts:536-537`), but neither of the two exhaustive alt-b listener objects handles them (`packages/cosignals-alt-b/src/react.ts:77-109`; `packages/cosignals-alt-b/src/engine.ts:3811-3875`). Only the fork-double's own protocol test observes them (`packages/cosignals-alt-b/test/fork.test.ts:179-189`). | Nothing in the real alt-b API or RTL suite. | Delete the events, WorkLoop calls, public types, and test. The older design document says they would be re-exported, but the implemented package does not do so. |

### 1.4 Facts derived in the bridge, not additional fork APIs

The bridge's `liveTokens`, `isBatchLive`, and `isQuiescent` are all derived from allocator and retirement events (`packages/cosignals-alt-b/src/react.ts:615-625`). `hasOpenWork` combines that live set, the pass scalar, upstream `T`, and `getRenderContext` (`packages/cosignals-alt-b/src/react.ts:627-644`). `getAmbientReadToken` is entirely the upstream `T -> last minted token` heuristic (`packages/cosignals-alt-b/src/react.ts:559-598`). None needs a fork entry point.

The engine does need efficient access to the live set: it seeds watcher worlds (`packages/cosignals-alt-b/src/engine.ts:3302-3318`), evaluates urgent writes in every live deferred world (`packages/cosignals-alt-b/src/engine.ts:2559-2576`), and prunes dead baselines (`packages/cosignals-alt-b/src/engine.ts:3321-3344`). A tandem cleanup should expose the adapter's canonical `Set<number>` as an iterable instead of allocating `[...keys]` on every `liveTokens()` call (`packages/cosignals-alt-b/src/react.ts:615-617`).

### 1.5 What the 27 RTL tests do and do not prove

The real-React suite is strong on functional presentation: lockstep, rebase, mount during transition, Suspense, two async API gate modes, ambient W0, StrictMode, two roots, and effects are all named at `packages/cosignals-alt-b/test/react-real.test.tsx:78-200`, `packages/cosignals-alt-b/test/react-real.test.tsx:203-315`, `packages/cosignals-alt-b/test/react-real.test.tsx:317-585`, `packages/cosignals-alt-b/test/react-real.test.tsx:588-780`, and `packages/cosignals-alt-b/test/react-real.test.tsx:783-953`.

It has four important blind spots when using “passes RTL” as the minimization boundary:

1. The real `flushSync` schedule does **not** exclude the default lane on this build; the test says so explicitly and therefore checks only side-by-side parity in a case where both values are included (`packages/cosignals-alt-b/test/react-real.test.tsx:783-791`). Exact excluded-lane reconstruction remains a spec/fork-test requirement, not an RTL existence proof.
2. The two-root RTL test observes only the final equal value (`packages/cosignals-alt-b/test/react-real.test.tsx:856-871`). The staggered A-committed/B-pending view is proved only by the fork-double tests (`packages/cosignals-alt-b/test/react.test.ts:33-90`).
3. The same-lane late-subscriber correction is also fork-double-only (`packages/cosignals-alt-b/test/react.test.ts:131-160`). The real mount-during-transition case starts in a pass that already includes the token, so it does not exercise an excluded-pass fixup (`packages/cosignals-alt-b/test/react-real.test.tsx:147-174`).
4. There is no raw `startTransition(async () => ...)` store-only test and no deterministic Scheduler-controlled yield/resume test. The current `startTransition` helpers accept a synchronous `() => void` scope (`packages/cosignals-alt-b/src/fork.ts:60-62`; `packages/cosignals-alt-b/src/react.ts:948-960`).

The report therefore distinguishes the **RTL-observable floor** from the **all-feature semantic floor** instead of treating 27 green tests as proof that an aggressive redesign is equivalent.

## 2. The minimal all-feature protocol

### 2.1 One private object, eight facts

React already exports its shared-internals object (`vendor/react/packages/react/src/ReactClient.js:118-123`), and the reconciler already imports that same object through `shared/ReactSharedInternals`. The fork does not need `ReactExternalRuntime.js`, a provider registration layer, a listener `Set`, `ReactClient` exports, or seven index shims. The reconciler can assign an alt-b-specific object to a dynamically named private property; `registerAltBReact()` already requires `react-dom/client` to have loaded before registration (`packages/cosignals-alt-b/src/react.ts:680-684`).

The whole boundary can be conceptually this small:

```ts
type AltBHost = {
  consumer: null | {
    // Called once when a lane first needs an alt-b identity. The callback
    // records the token in alt-b's live Set and returns serial<<1|deferred.
    allocate(deferred: boolean): number

    passStart(container: unknown, includedTokens: readonly number[]): void
    passEnd(container: unknown): void
    rootCommit(container: unknown, committedTokens: readonly number[]): void
    retire(token: number): void
  }

  currentBatch(): number
  renderingRoot(): unknown | null
  runInBatch(token: number, callback: () => void): boolean
}
```

That is five host→alt-b facts (mint, pass start, pass end, root commit, retire) and three alt-b→host operations (current batch, rendering root, in-batch scheduling). The consumer is singular because alt-b registration is singular. The allocator itself is the batch-open edge; no separate `onBatchOpened` event is necessary.

### 2.2 Required semantics

1. **Mint and identity.** `currentBatch()` chooses the lane React would choose for a state update in the same callstack, reuses the lane's live token, or calls `allocate(deferred)` once. Tokens stay unique while live. The present implementation's one-slot-per-lane model and merge-on-live-lane-reuse are the correct mechanism (`vendor/react/packages/react-reconciler/src/ReactFiberBatchRegistry.js:21-60`, `vendor/react/packages/react-reconciler/src/ReactFiberBatchRegistry.js:168-190`). Alt-b retains policy: low bit means deferred.
2. **Pending roots and backfill.** Once a token exists, scheduling that lane on a root records the root. The scheduler backfill must remain, because ordinary `startTransition(() => { setState(); atom.set(); })` creates React work before the token (`vendor/react/packages/react-reconciler/src/ReactFiberBatchRegistry.js:214-255`; `vendor/react/packages/react-reconciler/src/ReactFiberRootScheduler.js:317-324`).
3. **Pass start.** A fresh stack reports the exact entangled lane expansion plus that root's committed-while-pending lock-ins. The current registry computes both (`vendor/react/packages/react-reconciler/src/ReactFiberBatchRegistry.js:517-563`). Alt-b captures its own sequence pin at this edge; React does not need to know that policy.
4. **Per-callstack render truth.** `renderingRoot()` is non-null only while React executes render code. An open pass is not enough. The current query is only nine implementation lines (`vendor/react/packages/react-reconciler/src/ReactFiberWorkLoop.js:884-894`); it replaces both yield/resume callbacks in the slim design.
5. **Pass end.** Commit, discard, or restart closes the corresponding pin exactly once. No committed/discarded payload is needed by alt-b.
6. **Root commit before retirement.** A commit reports only tokens whose operations the pass made visible on that root, including re-pended same-lane work, and records lock-ins while other roots remain pending. The current ordering and re-pend tests justify retaining this logic (`vendor/react/packages/react-reconciler/src/ReactFiberBatchRegistry.js:295-405`; `vendor/react/packages/react-reconciler/src/ReactFiberWorkLoop.js:3992-4034`). Root generation is not needed.
7. **Retirement.** The last root finish, or the event-close edge for a store-only token, emits exactly one `retire(token)`. The close edge remains at the scheduler microtask boundary (`vendor/react/packages/react-reconciler/src/ReactFiberRootScheduler.js:343-359`).
8. **Deferred corrective scheduling.** `runInBatch` returns false without running the callback when the token is dead. For a live deferred token, it temporarily pins `requestTransitionLane` to that token's lane and installs a transition-shaped `T`; nesting restores prior state. The current implementation's live-urgent and internal urgent-fallback branches are unnecessary for alt-b, whose call sites pass only deferred tokens and perform their own false-result fallback (`packages/cosignals-alt-b/src/engine.ts:2539-2554`; `packages/cosignals-alt-b/src/react.ts:190-197`).

### 2.3 What disappears with no alt-b behavior loss

| Removed mechanism | Why it is removable | Estimated current fork LoC removed |
| --- | --- | ---: |
| Isomorphic façade, public unstable functions, shared-internals `E` typing, seven index exports | Existing client internals object is already exported; one private consumer and renderer are enough | 390–410 |
| Listener `Set`, event-name string dispatch, error-isolation wrapper, generic provider registration/fallback counter | Alt-b enforces one registration and owns token allocation | 45–70 (mostly inside the row above) |
| Yield/resume event state and four WorkLoop call sites | Exact `renderingRoot()` polling already supplies the fact alt-b uses | 55–80 |
| Mutation brackets | No alt-b consumer | 40–60 |
| `discardAllWip` and noop-renderer canceled-subscription support | No alt-b consumer | 70–100 |
| Public test reset | Test harness concern | 25–40 |
| Root commit generation, pass-end disposition, retirement `committed` payload | Bridge ignores all three | 15–25 |
| Driverless fallback IDs, multiple allocators/listeners, broad renderer-generic prose/types | Only alt-b is in scope | 25–45 |

These rows overlap; they should not be summed. The file-level estimate below is the non-overlapping total.

### 2.4 Retained patch estimate

| Fork region | Current non-test LoC | Slim alt-b estimate | Retained responsibility |
| --- | ---: | ---: | --- |
| React package façade/exports/shared-internals typing | 405 | **0** | Use existing internal export and a dynamic private property |
| Batch registry | 564 | **150–190** | Token/lane slot, pending roots/backfill, render token set, per-root finish/lock-in, close/retire |
| Reconciler runtime/pass state | 204 | **35–50** | One consumer pointer, pass start/end pairing, exact rendering-root query |
| WorkLoop integration | 291 | **85–110** | Current-batch classification, `runInBatch`, pass/commit call sites |
| Root scheduler integration | 33 | **20–30** | Backfill, close, transition-lane pin |
| Noop renderer | 13 | **0** | Delete with discard support |
| **Total** | **1,510** | **290–380; target 300–370** | |

The low end assumes terse alt-b-specific code and drops raw async-action parking. Keeping the current generic behavior for a store-only `startTransition(async () => ...)` adds approximately **35–50 fork LoC** for the parked thenable and stale-settlement guard (`vendor/react/packages/react-reconciler/src/ReactFiberBatchRegistry.js:408-472`). No current RTL test exercises it, so this is an owner decision before implementation, not something to preserve or delete silently.

A focused 12–16-test reconciler suite should be 450–650 LoC. It needs: mint/reuse; state-before-store backfill; included/urgent-excluded passes; store-only close; multi-root lock-in/pruning; entangled pass tokens; root-commit-before-retire; live/retired/nested `runInBatch`; re-pend during a completed or committing pass; pass restart/end; and exact render-context truth in a yield gap. Generic driverless, multiple-listener, mutation, discard, public-reset, generation, and urgent-`runInBatch` tests go away.

### 2.5 Upstream replacements and their fidelity

| Candidate upstream mechanism | What it can replace | Fidelity/cost |
| --- | --- | --- |
| Existing client shared internals export | Entire public external-runtime transport | Exact for the pinned React build. It deliberately becomes an alt-b-private ABI, so it is not a general React proposal. No extra render/write allocations. |
| Existing `T` transition slot | Pre-mint deferred-scope test and read-your-own-draft | Exact during the synchronous transition scope (`vendor/react/packages/react/src/ReactStartTransition.js:49-76`, `vendor/react/packages/react/src/ReactStartTransition.js:116-117`). It does not identify a later render pass or a bare post-`await` write. |
| Public `startTransition` / `useTransition` | Alt-b transition helpers | Exact for starting work. It **cannot** replace `runInBatch`: a fresh transition may get another lane and commit separately; the current spec explains the tear at `react-concurrent-signals-arena-alt-b.md:789-830`. |
| Public `use` with node-held thenables | Suspense retry identity | Exact; this is already the bridge implementation (`packages/cosignals-alt-b/src/react.ts:758-797`). It does not say whether the current pass is deferred, so it cannot choose transition-suspend versus urgent-stale by itself. |
| Public `useSyncExternalStore` | Basic subscription/no-tearing for a single current snapshot | High fidelity cost. React says the model works because store updates are always synchronous (`vendor/react/packages/react-reconciler/src/ReactFiberHooks.js:1697-1700`, `vendor/react/packages/react-reconciler/src/ReactFiberHooks.js:1731-1735`) and forces subscription changes onto `SyncLane` (`vendor/react/packages/react-reconciler/src/ReactFiberHooks.js:1860-1893`). That destroys alt-b's deferred worlds, lane parity, old-UI hold, and transition Suspense alignment. |
| Public Context provider carrying a reducer state | Pass-specific world and per-root committed state | Potentially exact for the reducer actions React actually processes, because React's own update queue chooses lane subsets. Public `useContext` records a dependency (`vendor/react/packages/react-reconciler/src/ReactFiberNewContext.js:580-610`) and propagation scans/schedules consumers (`vendor/react/packages/react-reconciler/src/ReactFiberNewContext.js:420-489`), so every signal consumer becomes dependent on every world-carrier change unless more machinery is added. |
| Direct `context._currentValue` / `_currentValue2` probe | Non-subscribing current Context value | Zero fork LoC but private and renderer-slot-dependent; the two fields exist precisely for primary/secondary renderers (`vendor/react/packages/react/src/ReactContext.js:18-45`). A 15–30 LoC fork primitive could expose this honestly. It still does not solve world-action delivery/retirement by itself. |
| `useLayoutEffect` in a root provider | Approximate per-root commit event | It runs after the DOM commit and can report the provider's committed reducer state. It does not by itself identify a pruned action, a root that disappeared before committing, or whether another root still owns the same pending work. Those facts have to move into the provider/action protocol. |
| Dispatcher (`ReactSharedInternals.H`) identity heuristic | “Am I rendering?” | Not adequate for full semantics. React restores `ContextOnlyDispatcher` after function rendering (`vendor/react/packages/react-reconciler/src/ReactFiberHooks.js:633-656`), but userland has no stable public identity, class renders are different, and it gives no root or pass token set. |

## 3. Tandem alt-b redesigns

The deltas below overlap; each row states its comparison point.

| Redesign | Alt-b LoC delta | Fork LoC saved | Behavioral/performance price |
| --- | ---: | ---: | --- |
| **Private singleton ABI** (current → slim full protocol) | **−90 to −140** | **390–420** | No functional loss. Delete `ReactRuntime` public surface, `ReactFork`'s listener `Set`, filtering/fan-out, dead fields, and generic version-skew plumbing. Keep one small `ForkLike` adapter so the deterministic double remains useful. |
| **Collapse redundant bridge state** (within either design) | **−35 to −70** | **55–100** | No intended loss: remove `isCurrentWriteDeferred`, lineage=0, yield/resume handlers, mutation handlers, Map values never read, duplicate transition analogue, and array-producing live-token snapshots. Some fork saving overlaps the private-ABI row. |
| **Always LOGGED / strict-only alt-b** (slim full protocol) | **−45 to −80** | **0–10** | Deletes loose-gate policy and its `T`/quiescence probes, but does not remove batch/pass/retirement machinery. Loses the package's defining idle DIRECT performance contract (`packages/cosignals-alt-b/src/engine.ts:2243-2275`; `packages/cosignals-alt-b/src/engine.ts:2931-2936`). Poor fork-LoC trade. |
| **Single registered root; replace dynamic `useSignalEffect` with `useSignal(s); useEffect(...,[s])`** (slim full protocol) | **−160 to −230** | **70–100** | Removes per-root sets, lock-ins, root-commit callback, and dynamically tracked committed effects. Single-root transition, rebase, Suspense, and W0 semantics remain. Loses the current two-root requirement and effects that discover dependencies dynamically. This is the same deliberate scope shape documented by the narrower design at `design-loop/oneoff-codex/DESIGN.md:374-379`, not an all-feature result. |
| **Drop `runInBatch`; rely on synchronous writer-stack `setState`** (slim full protocol) | **−35 to −60** | **45–65** | Existing subscribers written during a `startTransition` still receive that transition's lane because the watcher calls `setState` in the writer stack (`react-concurrent-signals-arena-alt-b.md:2334-2354`). Late subscribers, callbacks drained after the scope, and completed-pass corrections can land in a new/default lane and commit separately. The fork-double late-subscriber contract fails. |
| **Root Context carrier, public `useContext`** (slim protocol → stock React) | **+220 to +360** | **300–370, reaching 0** | Every logged operation dispatches a reducer action to every registered root in the original callstack. The provider's WIP Context value becomes the pass world; a root layout effect becomes the commit report. It can plausibly cover the current 27 RTL cases, including raw `React.startTransition`, but every signal hook is invalidated by every carrier change, and abort/prune/root-removal semantics need new proofs. |
| **Root Context carrier plus a non-subscribing probe** | **+250 to +450** | **270–355, reaching 15–30** | A tiny reconciler primitive returns the active renderer's Context value without recording a dependency. Existing signal watchers stay fine-grained; a newly mounted hook can subscribe to the carrier for one adoption render, then switch to the probe. This is the strongest tiny-fork candidate, but it is a new architecture with at least one React update/action allocation per root/batch and substantial lifecycle machinery in alt-b. |
| **Direct private Context-field probe** | Same as previous | **All remaining fork LoC, reaching 0** | Same architecture, but casts `_currentValue` for React DOM. It is tied to private Context layout and primary-renderer selection. Given that the project already pins React, it is testable, but it makes a zero-fork marketing claim depend on undocumented internals. |
| **`useSyncExternalStore` fallback** | **−200 to −350** | **All remaining fork LoC, reaching 0** | Smallest conservative implementation, largest capability loss. Keep only one committed snapshot and synchronous subscriptions. No exact deferred world, transition hold/rebase, mount-in-transition world, strict lane visibility, or per-root committed effect. |

### 3.1 The Context-carrier design in concrete terms

The carrier is worth spelling out because it is the only credible route below the roughly
300-LoC semantic floor; merely “probing Context” is not enough.

1. A required `<SignalsRoot>` owns `useReducer(viewReducer, initialView)` and provides
   `{rootId, view}`. It registers its dispatch with the engine.
2. A logged signal operation creates one immutable receipt and calls every registered root's
   dispatch synchronously. React assigns those dispatches exactly the lane it assigns adjacent
   `setState` calls. The reducer state is the ordered receipt set that this root/pass processed.
3. `useSignal` resolves the engine against that reducer state. Public `useContext` makes this
   coarse but self-scheduling. A non-subscribing probe keeps steady-state subscriptions
   fine-grained; first-mount adoption must temporarily subscribe so an already-pending carrier
   update can schedule the new Fiber in its original lane.
4. A provider layout effect reports the committed receipt state for that root. Once every root
   targeted by a receipt has reported it (or unmounted), the engine can retire/promote it.
5. The existing upstream `T` maps a synchronous transition scope to a deferred receipt/token,
   preserving read-your-own-draft. `use()` still owns Suspense waiting.

This converges the duplicate world descriptions: React's reducer queue becomes the canonical
“which operations this pass includes” model, instead of React lanes being translated into an
alt-b token mask by a fork. The cost is equally concrete: React Update objects and immutable
carrier states become part of the write path; every root receives work even when the changed
signal has no consumer; public Context is O(all signal consumers) per change; and userland must
reconstruct retirement/pruning that the current registry observes exactly at React's bookkeeping
edges. It is a very different performance profile from alt-b's DIRECT goal.

Before treating it as feature-preserving, it must falsify at least: a root unmount during a held
transition; a provider action pruned by deletion; a same-token write after one root committed;
a late subscriber mounted by an excluded urgent pass; a completed-but-uncommitted Suspense pass;
StrictMode provider re-registration; a portal; two interleaved transitions; and 10k unrelated
signal hooks. Passing today's RTL alone would not answer those cases.

## 4. Capability/LoC curve

### 4.1 Main, mechanism-preserving curve

| Point | Estimated non-test fork LoC | What remains | What is intentionally lost |
| --- | ---: | --- | --- |
| Current generic channel | 1,510 | All current alt-b behavior plus mutation events, discard, generic listeners/provider, driverless mode, reset, generations, raw async-action parking | Nothing, but most extras have no alt-b consumer |
| **Slim alt-b protocol (recommended all-feature point)** | **300–370** | All 27 RTL behaviors; exact pass worlds; strict/loose gates; transition rebase; context-sensitive Suspense; late same-lane correction; multi-root lock-ins/effects; provider-free hooks | Generic public channel, mutation/discard APIs, generation/disposition payloads, multiple consumers/renderers. Add 35–50 LoC if raw store-only async-action parking is declared a feature. |
| Single-root v1 | 210–280 | All single-root transition, Suspense, W0/latest, strict-lane, and late-correction behavior | Second root rejected; no per-root lock-ins; dynamically tracked `useSignalEffect` replaced by native value dependencies |
| Single-root, synchronous delivery only | 160–220 | Existing subscribers notified in the original writer callstack; pass worlds, rebase, ordinary transition mounts, and Suspense still work | Excluded-pass late subscriber and delayed correction can commit separately; no `runInBatch` guarantee |
| Stock React, committed-snapshot adapter | 0 | Core signals/computeds/reducers; urgent/synchronous hooks; lazy state; SSR serialization; StrictMode cleanup; first-load Suspense and ordinary resolved retry | The transition/visibility guarantees listed below |

The curve has a cliff: once pass-specific visibility is removed, batch identity, include sets,
retirement, and same-lane correction stop paying for themselves together. There is no honest
“80 LoC generic protocol” that retains those facts. The separate Context-carrier branch can reach
0–30 LoC only by moving their representation and lifecycle into alt-b.

### 4.2 What survives on unpatched React

With a conventional committed-snapshot or `useSyncExternalStore` adapter, these features survive:

- Atom/ReducerAtom/Computed semantics, equality, lazy initialization, batching, tracing, and the
  non-React graph. None depends on the fork.
- Component ownership and StrictMode-safe cleanup (`packages/cosignals-alt-b/src/react.ts:840-868`;
  `packages/cosignals-alt-b/test/react-real.test.tsx:873-930`).
- SSR serialize/initialize (`packages/cosignals-alt-b/src/react.ts:387-421`).
- Node-held thenable identity, first-load fallback, and a normal retry after settlement. The basic
  case is `packages/cosignals-alt-b/test/react-real.test.tsx:203-223` and the bridge uses public
  `React.use` at `packages/cosignals-alt-b/src/react.ts:758-797`.
- Urgent refetch stale-through can be kept by returning `box.latest` whenever the pass is treated
  as urgent. `useLatest` and the boolean `useIsPending` node can remain useful.

The following current guarantees die without either the fork protocol or the full Context-carrier redesign:

| Lost guarantee | Why stock React is insufficient | Current evidence |
| --- | --- | --- |
| Signal and React state commit in one transition frame | Userland cannot ask which batch/lane owns the external operation or later render | `packages/cosignals-alt-b/test/react-real.test.tsx:79-98` |
| Held transition keeps old signal UI while urgent work rebases operations | One global external snapshot is either too new for the old frame or too old for the transition frame | `packages/cosignals-alt-b/test/react-real.test.tsx:100-145` |
| A component first mounting inside a transition reads that pass's world | A late hook can see only the global snapshot; it cannot infer the pass's included lanes | `packages/cosignals-alt-b/test/react-real.test.tsx:147-174` |
| Exact W0 outside, own draft inside scope, Wn via `latest`, and Wp during render | `T` identifies only the synchronous scope; stock React exposes neither later pass membership nor retirement | `packages/cosignals-alt-b/SPEC-RESOLUTIONS.md:78-106`; `packages/cosignals-alt-b/test/react-real.test.tsx:652-756` |
| Context-sensitive Suspense: transition refresh suspends/holds, urgent refresh serves stale | Public `use` can wait, but it does not reveal whether this render is a transition pass | `packages/cosignals-alt-b/SPEC-RESOLUTIONS.md:9-28`; `packages/cosignals-alt-b/test/react-real.test.tsx:378-435` |
| Signal-side and direct React-side waiters of one promise land together | The signal side cannot join/identify the direct React transition lane | `packages/cosignals-alt-b/test/react-real.test.tsx:438-513` |
| Exact strict-lane exclusion and flushSync parity | `useSyncExternalStore` forces SyncLane; an ordinary callback `setState` has no pass snapshot from which to reconstruct an excluded operation | `packages/cosignals-alt-b/src/engine.ts:2243-2275`; caveat that the present real test does not manifest exclusion at `packages/cosignals-alt-b/test/react-real.test.tsx:783-791` |
| Late corrective update joins the already-live batch | A fresh `startTransition` is a new scheduling request; no public API pins an existing lane | `packages/cosignals-alt-b/test/react.test.ts:131-145`; `react-concurrent-signals-arena-alt-b.md:789-830` |
| Per-root committed effects and committed-while-pending lock-ins | Public subscriptions expose no root commit delta or last-root retirement edge | `packages/cosignals-alt-b/test/react.test.ts:33-90`; `packages/cosignals-alt-b/src/react.ts:88-107` |

The zero-fork Context-carrier can potentially recover most functional rows because its reducer
queue is itself lane-aware. What it definitely does **not** preserve without further work is the
current provider-free API, fine-grained render cost, DIRECT write cost, or the existing proof that
retirement/pruning follows React's internal bookkeeping.

## 5. Recommendation and migration sketch

### Recommendation

Build the **300–370 LoC private alt-b protocol**. It removes roughly four fifths of the fork while
keeping the irreducible facts at the layer that actually owns them. It also follows a clean
policy/mechanism split:

- React reports only scheduling facts: token/lane tenancy, pass membership, current render root,
  root commit, retirement, and lane-scoped execution.
- Alt-b owns policy: token encoding, strict versus loose gate, W0/Wn/Wp interpretation, Suspense
  stale-versus-wait choice, root-effect filtering, and urgent fallback.

Do not keep the generic public external-runtime API “just in case.” Its public exports, listener
fan-out, mutation brackets, discard operation, driverless mode, generations, and reset are most
of the maintenance surface and have no alt-b feature behind them.

Run the Context-carrier as a separate, bounded spike only if absolute fork LoC is worth changing
the write-path allocation model. Its exit rule should be strict: if it cannot pass the expanded
correctness battery and a matched allocation/render-count benchmark without additional React
patches, stop rather than rebuilding the current registry indirectly in userspace.

Before implementation, the owner should explicitly decide three edges rather than letting them
silently bloat or disappear:

1. Is raw store-only `startTransition(async () => ...)` parking a supported alt-b feature? Keeping
   it costs about 35–50 fork LoC; today's RTL does not exercise it.
2. Are multiple simultaneous renderers, listener-error isolation, and gesture-transition writes
   supported? The current bridge already assumes the first renderer and one registration, so the
   minimal recommendation drops the generic forms.
3. Is the current two-root behavior mandatory at the semantic level, or is a loud single-root v1
   acceptable? The existing RTL includes two roots, so this report's all-feature point keeps it.

### Migration

1. **Strengthen the boundary tests before changing code.** Keep all 27 real-React tests unchanged,
   then add real-React cases for: state-before-store ordering; an excluded-pass late subscriber;
   a staggered two-root commit with `useSignalEffect`; and a deterministic yield-gap write. Add a
   deterministic lane-exclusion test using React's Scheduler test renderer because the current DOM
   `flushSync` test explicitly does not exercise exclusion.
2. **Introduce the private host object without deleting the old channel.** In the reconciler, put
   the eight-fact object on the existing shared internals export. Change `ReactFork` to prefer it,
   but retain the old public path temporarily for differential runs. This makes version skew a
   presence check on one private property.
3. **Replace the registry in place.** Keep the proven slot/lane, backfill, entangled-render,
   repended-finish, lock-in, and close algorithms. Delete fallback allocation, generations,
   parked async actions unless selected, reset, and generic runtime lookups. Make root commit emit
   one token array and retirement emit one token.
4. **Narrow WorkLoop and scheduler hooks.** Keep `currentBatch`, `renderingRoot`, pass start/end,
   root finish, event close/backfill, and deferred `runInBatch`. Delete yield/resume, mutation,
   discard, urgent/unknown execution policy, and noop-renderer support.
5. **Simplify alt-b in tandem.** In `packages/cosignals-alt-b/src/react.ts`, remove the generic
   `ReactRuntime` type, listener `Set`, event filtering/fan-out, dead classification method,
   mutation fields, lineage placeholder, and duplicate transition analogue. In
   `packages/cosignals-alt-b/src/fork.ts`, slim `ForkLike` to facts the engine actually calls and
   keep richer scripting methods only on `ForkDouble`. In the engine, delete yield/resume handlers
   and let `ctxNow()`'s existing render query own gap truth.
6. **Delete the old surface only after differential green.** Remove
   `ReactExternalRuntime.js`, all seven index additions, `ReactClient` external-runtime exports,
   `ReactSharedInternalsClient.E`, `discardAllWip`, the noop patch, mutation hooks, and public reset.
7. **Validate the real built pair.** Run the focused reconciler tests, `pnpm fork:build`,
   `pnpm --filter cosignals-alt-b typecheck`, the full alt-b suite, and the 27-test RTL file against
   the rebuilt linked React packages. Repeat the real-React suite in both gate modes and run the
   existing held-transition/read benchmark: the protocol cut should not change engine hot paths.

### Success criterion

The migration succeeds when the non-test `vendor/react/packages` diff is at or below **380 added
lines**, no public `react` export was added, the full and expanded RTL battery is green, and the
bridge has exactly one canonical representation each for live tokens, current pass, and current
transition scope. If the implementation needs mutation events, generations, lineage, discard,
or a second listener/provider layer to make alt-b pass, that is evidence of scope drift, not a
reason to restore the generic channel.
