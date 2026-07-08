# alt-a-only React fork simplification

## Result

The 5,012-line fork is mostly a generic external-runtime product and its standalone test suite, not the minimum needed by `cosignals-alt-a`:

| Patch class | Current added LoC |
|---|---:|
| Production/API code | 1,510 |
| Reconciler tests | 3,502 |
| Total | 5,012 |

Those numbers are the physical added lines from `git diff --numstat e71a6393e6..HEAD -- packages` at React `da7a2366e8`. The untracked `ReactDOMUseUrgentActStall-test.js` is not in that diff and is not counted.

An alt-a-only fork can retain all alt-a-observable implemented protocol guarantees in about **430–535 production lines**. A focused 650–850-line reconciler suite, with the existing 778-line RTL suite carrying end-to-end coverage, puts the whole maintained fork delta at about **1,080–1,385 lines**: a **65–72% production reduction** and **72–78% total reduction**.

The high-confidence cuts are:

- delete the 334-line isomorphic client channel and all 71 export/shared-internals additions;
- use React's already-exported private shared-internals object as one pinned-fork driver object;
- support one alt-a listener, not a generic listener set;
- have React mint alt-a's encoded integer tokens directly;
- expose events in the shape the engine consumes, without array-to-event adapters, generation numbers, dispositions, or unused capabilities;
- delete `discardAllWip`, DOM mutation brackets, driverless token allocation, the public test reset, and the react-noop fix;
- replace “yield plus a per-read repair query” with an explicit render-callstack exit edge that also fires when a render completes or suspends.

There is a lower, test-shaped candidate around **250–340 production lines**, but it gives up exact per-root committed views and/or same-lane late corrections. The current RTL assertions are weaker than the design text in those areas. That candidate is a reduced-feature point, not an honest “all features” answer.

## Scope and evidence boundary

This report distinguishes three things:

1. **Consumed today:** reachable from `src/react/bridge.ts` into the engine.
2. **RTL-verified today:** asserted by `tests/react/real-react.spec.tsx`.
3. **Advertised but not presently asserted by RTL:** requirements in the original test plan or the fork's own tests.

That distinction matters. For example, the design calls for a real yield-gap test, a deferred batch spanning two roots, and exactly one late-subscriber correction commit (`react-concurrent-signals-arena-alt-a.md:3284-3288`, `react-concurrent-signals-arena-alt-a.md:3311-3318`, `react-concurrent-signals-arena-alt-a.md:3326-3329`). The current RTL file instead has an eventual-value late-mount assertion and a two-root urgent-write test (`packages/cosignals-alt-a/tests/react/real-react.spec.tsx:199-255`, `packages/cosignals-alt-a/tests/react/real-react.spec.tsx:400-425`). I do not count the stronger behavior as RTL-verified merely because comments describe it.

The source audit used the current working tree for alt-a and React `HEAD` for the 19-file fork diff. No build or test was run because this investigation was constrained to write only this report. All proposed LoC numbers are implementation estimates on the same physical-line basis as `git diff --numstat`, not measured diffs.

The complete 19-file accounting is:

| Current patch area | Files | Added LoC |
|---|---:|---:|
| `ReactFiberBatchRegistry.js` | 1 | 564 |
| `ReactFiberExternalRuntime.js` | 1 | 204 |
| `ReactFiberWorkLoop.js` | 1 | 291 |
| `ReactFiberRootScheduler.js` | 1 | 33 |
| Four reconciler test files | 4 | 3,502 |
| Seven `packages/react/index*.js` entry points | 7 | 49 |
| `ReactClient.js` | 1 | 17 |
| `ReactExternalRuntime.js` | 1 | 334 |
| `ReactSharedInternalsClient.js` | 1 | 5 |
| `createReactNoop.js` | 1 | 13 |
| **Total** | **19** | **5,012** |

## 1. Inventory: what alt-a actually consumes

### Queries and commands

| Fork surface | Actual consumer | Feature powered | Keep? |
|---|---|---|---|
| `unstable_subscribeToExternalRuntime(listener)` | The bridge installs exactly one listener and forwards six event kinds (`packages/cosignals-alt-a/src/react/bridge.ts:101-124`, `packages/cosignals-alt-a/src/react/bridge.ts:125-153`). The package itself permits only one active React composition (`packages/cosignals-alt-a/src/react/hooks.ts:28-53`). | Connects pass, commit, and retirement edges to `engine.attachFork` (`packages/cosignals-alt-a/src/react/bridge.ts:179-179`, `packages/cosignals-alt-a/src/engine.ts:2890-2937`). | Keep the attachment fact, but replace the public subscription API and `Set` with one private listener slot. |
| `unstable_registerBatchIdAllocator(allocate)` | The bridge mints `(serial << 1) | deferred` tokens (`packages/cosignals-alt-a/src/react/bridge.ts:105-105`, `packages/cosignals-alt-a/src/react/bridge.ts:173-178`). React stores the returned ID in its lane slot (`vendor/react/packages/react-reconciler/src/ReactFiberBatchRegistry.js:168-189`). | One integer names the writer world, render inclusion, per-root commit, retirement, and lane re-entry. Bit 0 drives applied-vs-deferred writes (`packages/cosignals-alt-a/src/engine.ts:2481-2505`) and transition-render suspense (`packages/cosignals-alt-a/src/engine.ts:3672-3689`). | Keep encoded IDs, not allocator registration. React can increment the serial and encode the bit itself. |
| `unstable_getCurrentWriteBatch()` | The bridge forwards it on every logged write (`packages/cosignals-alt-a/src/react/bridge.ts:160-162`, `packages/cosignals-alt-a/src/engine.ts:2476-2505`). It also calls it from the adapter's supposed classification probe (`packages/cosignals-alt-a/src/react/bridge.ts:156-159`). | Attributes writes to the same lane batch as React state, supplies read-your-own-draft inside a deferred scope, and gives tapes a stable token (`packages/cosignals-alt-a/src/engine.ts:1573-1584`, `packages/cosignals-alt-a/src/engine.ts:2481-2512`). This underlies lockstep and rebase (`packages/cosignals-alt-a/tests/react/real-react.spec.tsx:112-197`) and the ambient-W0/read-own-draft tests (`packages/cosignals-alt-a/tests/react/real-react.spec.tsx:648-713`). | Keep, but make it `currentBatch(claim: boolean)`. `false` is a non-minting peek for reads; `true` claims for writes. |
| `unstable_getRenderContext()` | The bridge maps `null` to `undefined` (`packages/cosignals-alt-a/src/react/bridge.ts:163-165`). The engine consults it only to repair a stale edge-tracked render context (`packages/cosignals-alt-a/src/engine.ts:1550-1563`). | Prevents a handler/read after a suspending render from being mistaken for render code; this protects ambient W0 and the render-write guard (`packages/cosignals-alt-a/src/engine.ts:1587-1597`, `packages/cosignals-alt-a/src/engine.ts:2447-2459`). | Delete after adding an exact render-exit callback. |
| `unstable_runInBatch(batchId, fn)` | The bridge invokes React and always returns `true`, because React itself performs the retired-ID urgent fallback (`packages/cosignals-alt-a/src/react/bridge.ts:166-170`). The engine calls it only for odd/deferred tokens (`packages/cosignals-alt-a/src/engine.ts:2162-2171`, `packages/cosignals-alt-a/src/engine.ts:2396-2422`, `packages/cosignals-alt-a/src/engine.ts:3540-3555`). | Puts watcher updates and post-subscribe corrections back into the original transition lane. The critical scenario is a subscriber mounted while a transition is pending (`packages/cosignals-alt-a/tests/react/real-react.spec.tsx:199-255`); the engine's correction site is `subscribeWithFixup` (`packages/cosignals-alt-a/src/engine.ts:3513-3560`). | Keep for the all-feature point, but narrow it to deferred tokens and make “always execute, urgent if retired” the sole contract. |
| `unstable_resetBatchRegistryForTest()` | Optional in the bridge type and called only during bridge disposal (`packages/cosignals-alt-a/src/react/bridge.ts:71-71`, `packages/cosignals-alt-a/src/react/bridge.ts:181-188`). RTL disposes only after awaited root unmounts (`packages/cosignals-alt-a/tests/react/real-react.spec.tsx:44-51`). | Test isolation; no product behavior. | Delete from the minimum. Require disposal only after work is drained, keep IDs monotonic, and use module reset/reload in fork unit tests if needed. |

One current allocation bug falls out of this inventory: `ambientScopeWorld` explicitly wants a non-minting probe (`packages/cosignals-alt-a/src/engine.ts:1573-1582`), but the real bridge implements it by calling the minting `unstable_getCurrentWriteBatch` (`packages/cosignals-alt-a/src/react/bridge.ts:156-159`). While any deferred batch is live, an ambient read can therefore mint an urgent batch and schedule its close microtask (`vendor/react/packages/react-reconciler/src/ReactFiberWorkLoop.js:900-922`). `currentBatch(false)` removes both the semantic mismatch and the allocation.

### Events

| Fork event | Actual consumer | Feature powered | Keep? |
|---|---|---|---|
| `onRenderPassStart(container, includedBatches)` | Forwarded with synthetic lineage `0` (`packages/cosignals-alt-a/src/react/bridge.ts:125-138`). The engine captures a seq pin, interns the included token set, records the root container, and selects the pass world (`packages/cosignals-alt-a/src/engine.ts:2847-2874`). | Every render read resolves the same world as its React update set; hooks retain the rendered pin/tokens for the subscribe fixup (`packages/cosignals-alt-a/src/react/hooks.ts:108-145`). It is required by interleaved transition worlds (`packages/cosignals-alt-a/tests/react/real-react.spec.tsx:288-356`) and transition-sensitive refresh suspension (`packages/cosignals-alt-a/tests/react/real-react.spec.tsx:527-604`). | Keep. Lineage is already gone. Reuse one scratch ID array because alt-a consumes it synchronously. |
| `onRenderPassYield` / `onRenderPassResume` | Forwarded directly (`packages/cosignals-alt-a/src/react/bridge.ts:139-140`) and used only to flip `passExecuting` and `readCtx` (`packages/cosignals-alt-a/src/engine.ts:2901-2909`). | Distinguishes “frame remains pinned” from “React is executing render code now.” | Keep the distinction, but rename it to render exit/resume and emit exit for every work-loop return, including completed/suspended returns. That removes `getRenderContext`. |
| `onRenderPassEnd(container, committed)` | The bridge discards `committed` and forwards only end (`packages/cosignals-alt-a/src/react/bridge.ts:141-145`). The engine releases the pin, sweeps, and tries quiescence (`packages/cosignals-alt-a/src/engine.ts:2877-2888`). | Bounds receipt retention and makes abandoned/restarted work stop pinning old records. | Keep one parameterless engine-facing end edge; delete disposition. |
| `onRootCommitted(container, committedBatches, generation)` | The bridge discards `generation` and expands the batch array into one engine callback per token (`packages/cosignals-alt-a/src/react/bridge.ts:147-152`). The engine advances the container's committed view and notifies commit listeners (`packages/cosignals-alt-a/src/engine.ts:2911-2926`). | Per-root `useSignalEffect` and `useCommitted` semantics (`packages/cosignals-alt-a/src/react/hooks.ts:245-320`), verified for ordinary two-root updates and pending-vs-committed effects (`packages/cosignals-alt-a/tests/react/real-react.spec.tsx:400-472`, `packages/cosignals-alt-a/tests/react/real-react.spec.tsx:715-727`). | Keep a direct `onBatchCommitted(container, id)` edge for full fidelity. Delete generation and the allocated delta array. |
| `onBatchRetired(batchId, committed)` | Forwarded directly (`packages/cosignals-alt-a/src/react/bridge.ts:146-146`); the engine deliberately ignores `committed` (`packages/cosignals-alt-a/src/engine.ts:2575-2587`). | Marks entries retired, absorbs the fold into W0, advances/clears committed views, revalidates other pending worlds, and frees logs (`packages/cosignals-alt-a/src/engine.ts:2588-2669`). It is essential to interruption/rebase and async-action invisibility (`packages/cosignals-alt-a/tests/react/real-react.spec.tsx:141-197`, `packages/cosignals-alt-a/tests/react/real-react.spec.tsx:648-713`). | Keep `onBatchRetired(id)`; delete the boolean. |

### Patch surface that alt-a does not consume

| Existing fork work | Evidence | Disposition |
|---|---|---|
| DOM mutation events | They are in the generic listener (`vendor/react/packages/react/src/ReactExternalRuntime.js:120-124`) and reconciler helper (`vendor/react/packages/react-reconciler/src/ReactFiberExternalRuntime.js:185-204`), but are absent from the bridge's listener type (`packages/cosignals-alt-a/src/react/bridge.ts:59-66`). The design itself says the signals library never references `MutationObserver` (`react-concurrent-signals-arena-alt-a.md:839-846`). | Delete all mutation hooks. |
| `unstable_discardAllWip` | The 40-line mechanism lives in the work loop (`vendor/react/packages/react-reconciler/src/ReactFiberWorkLoop.js:1022-1061`) but is absent from `ForkReact` (`packages/cosignals-alt-a/src/react/bridge.ts:58-71`). | Delete. |
| Live-urgent `runInBatch` targeting | React implements urgent-lane targeting (`vendor/react/packages/react-reconciler/src/ReactFiberWorkLoop.js:1006-1013`), while every engine call is guarded by an odd token (`packages/cosignals-alt-a/src/engine.ts:2165-2166`, `packages/cosignals-alt-a/src/engine.ts:2409-2416`). | Delete; only deferred-live and retired-fallback cases remain. |
| Commit generation, pass disposition, retirement disposition | Generation is omitted by the bridge (`packages/cosignals-alt-a/src/react/bridge.ts:147-152`), pass disposition is named `_committed` (`packages/cosignals-alt-a/src/react/bridge.ts:141-145`), and retirement disposition is named `_committed` by the engine (`packages/cosignals-alt-a/src/engine.ts:2576-2587`). | Delete all three payloads and their bookkeeping. |
| Driverless/fallback IDs and multiple allocators | The bridge registers its allocator before attaching the engine (`packages/cosignals-alt-a/src/react/bridge.ts:173-179`), and registration is required before roots render (`packages/cosignals-alt-a/src/react/hooks.ts:30-40`). | Delete fallback counter, allocator registration, collision policy, and related tests. |
| Multiple listeners/providers | React keeps a listener `Set` (`vendor/react/packages/react/src/ReactExternalRuntime.js:174-189`), but alt-a enforces one active handle (`packages/cosignals-alt-a/src/react/hooks.ts:28-53`). | One nullable listener and one driver object. |
| Seven public API re-exports | The reconciler already imports the exact object exported publicly as `__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE` (`vendor/react/packages/shared/ReactSharedInternals.js:10-14`, `vendor/react/packages/react/src/ReactClient.js:110-123`). | Put the pinned-fork driver on that object; delete all public external-runtime names. |
| react-noop canceled-commit fix | RTL uses `react-dom/client.createRoot`, not react-noop (`packages/cosignals-alt-a/tests/react/real-react.spec.tsx:11-14`, `packages/cosignals-alt-a/tests/react/real-react.spec.tsx:58-66`). | Drop the 13-line react-noop patch from this fork. If upstream needs the bug fix independently, carry it as a separate upstreamable patch, not alt-a LoC. |
| `onRootRegistered` and `onBatchOpened` | The real bridge synthesizes activation at attach (`packages/cosignals-alt-a/src/react/bridge.ts:122-124`); the engine explicitly ignores `onBatchOpened` (`packages/cosignals-alt-a/src/engine.ts:2928-2930`). | No React event for either. |

Two more simplifications are specific to the current implementation:

- React tracks several simultaneously open pass frames (`vendor/react/packages/react-reconciler/src/ReactFiberExternalRuntime.js:50-72`), while the bridge keeps one pass and forcibly ends the previous one on a new start (`packages/cosignals-alt-a/src/react/bridge.ts:107-111`, `packages/cosignals-alt-a/src/react/bridge.ts:125-138`). An alt-only pass helper can use one active-root scalar and ignore an end for a non-active root; that is smaller and avoids the current possibility that a late end for root A closes root B's current scalar pass.
- The current work-loop patch emits yield only while `workInProgress !== null`; a completed/suspended render returns without a yield event (`vendor/react/packages/react-reconciler/src/ReactFiberWorkLoop.js:2962-2984`, `vendor/react/packages/react-reconciler/src/ReactFiberWorkLoop.js:3252-3284`). The engine documents and repairs exactly this hole with `getRenderContext` (`packages/cosignals-alt-a/src/engine.ts:1550-1563`). Emitting a render-exit edge on every return is both smaller and more truthful.

## 2. Minimal all-feature protocol

### Canonical private shape

The fork should expose no new public React API. After `react-dom/client` initializes, the existing private shared-internals object should contain one alt-a driver. The bridge feature-detects that one object and installs one listener.

Conceptually, the whole boundary is:

```ts
type AltAReactDriver = {
  listener?: {
    onPassStart(container: unknown, included: readonly number[]): void
    onRenderExit(): void
    onRenderResume(): void
    onPassEnd(): void
    onBatchCommitted(container: unknown, batch: number): void
    onBatchRetired(batch: number): void
  }

  // claim=false is a pure peek; claim=true mints if needed.
  currentBatch(claim: boolean): number

  // Always runs fn. A live odd token uses its original transition lane;
  // a retired token uses discrete priority.
  runInBatch<R>(batch: number, fn: () => R): R
}
```

This is the engine's canonical model rather than a generic model translated twice. It removes the current listener-array-to-per-batch conversion, `null` conversion, ignored fields, allocator callback, and boolean fallback adapter (`packages/cosignals-alt-a/src/react/bridge.ts:8-51`, `packages/cosignals-alt-a/src/react/bridge.ts:113-179`).

### What must remain inside React

1. **Lane slot to monotonic encoded batch ID.** Lane bits recycle, so a raw lane cannot be the token (`react-concurrent-signals-arena-alt-a.md:673-698`). React should mint `(serial << 1) | deferred` directly. The bridge does not need to own the serial.
2. **Pending roots, backfill, finish, close, and async-action parking.** The pending edge records roots (`vendor/react/packages/react-reconciler/src/ReactFiberBatchRegistry.js:214-227`); backfill handles `setState` before the external write (`vendor/react/packages/react-reconciler/src/ReactFiberBatchRegistry.js:229-255`); finish reports the rendered write set and retires only after the last root (`vendor/react/packages/react-reconciler/src/ReactFiberBatchRegistry.js:257-405`); close/parking handles store-only and async-action batches (`vendor/react/packages/react-reconciler/src/ReactFiberBatchRegistry.js:408-472`). Userspace cannot reconstruct those facts after the event.
3. **Render inclusion and committed-root lock-in.** Entangled render lanes and batches already committed on one root while pending elsewhere determine the pass world (`vendor/react/packages/react-reconciler/src/ReactFiberBatchRegistry.js:517-564`). This is what makes interleaved worlds and per-root committed views exact.
4. **Fresh pass, render exit/resume, and pass end insertion points.** Pass start fixes the engine pin and included set; render exit controls only the ambient context; pass end releases the pin. These are distinct facts (`packages/cosignals-alt-a/src/engine.ts:2847-2888`, `packages/cosignals-alt-a/src/engine.ts:2900-2910`).
5. **Original-lane re-entry.** A fresh `startTransition` may choose another lane; only the reconciler can pin an update to the existing lane (`react-concurrent-signals-arena-alt-a.md:787-828`). The current scheduler override is the irreducible hook (`vendor/react/packages/react-reconciler/src/ReactFiberRootScheduler.js:710-735`).

The run-in-batch implementation can be shorter and cheaper than today's. Store the originating `Transition` object in the lane slot when a deferred ID is claimed, then reuse it while setting the lane override. That replaces the feature-flag-dependent transition-object construction and its DEV `Set` allocation on every call (`vendor/react/packages/react-reconciler/src/ReactFiberWorkLoop.js:967-1019`) with save/assign/call/restore.

### Estimated retained production patches

| Retained patch | Estimated added LoC | Why it cannot be userspace |
|---|---:|---|
| Slim `ReactFiberAltABatchRegistry` | 260–310 | Stable IDs across lane reuse, pending-root set, backfill, last-root retirement, async-action parking, committed-root lock-in, rendered-lane stash, pass ID collection. |
| Slim pass helper | 40–55 | One active root, fresh-pass start, exact render exit/resume, end-at-commit/restart. No mutation window, discard-all enumeration, dispositions, or multi-listener emits. |
| `ReactFiberWorkLoop.js` insertion points and provider methods | 105–130 | `currentBatch(claim)`, deferred-only `runInBatch`, mark-root edge, pass entry/exit, finish edge. |
| `ReactFiberRootScheduler.js` | 25–35 | Backfill and close hooks plus the transition-lane override. |
| React client/API/shared-internals files | 0–3 | A dynamic private property on the already-shared object; no public Flow/API surface is necessary. |
| react-noop | 0 | Not part of alt-a's DOM runtime. |
| **Production total** | **430–535** | Down from 1,510. |

The same total by semantic capability is approximately: batch identity/close/parking 105–135; per-root tracking/commit/lock-in/inclusion 135–165; pass context 55–75; lane re-entry 70–90; work-loop wiring/private carrier 50–70. These ranges overlap slightly at module boundaries; the file total is the accounting target.

### Test patch estimate

The 3,502 fork-test lines prove a generic protocol. The alt-only fork needs a smaller seam suite:

- token stability, deferred-bit encoding, retirement, store-only close, and async parking;
- `setState`-before-store backfill;
- pass inclusion, completed/suspended render exit, restart/end pairing;
- multi-root commit lock-in and commit-before-retire order;
- live deferred `runInBatch`, retired fallback, and pre-commit restart.

Those can be 650–850 lines if fixtures are shared and the RTL suite remains the product-level conformance suite. Do not delete the fork tests entirely: RTL cannot prove that a passing schedule was not accidental, and several insertion-edge properties are not currently asserted there.

### Upstream mechanisms and their fidelity

| Replacement | What it can replace | Fidelity cost |
|---|---|---|
| Existing private shared internals | All public export/client-channel plumbing. The reconciler already obtains this exact public-secret object from `react` (`vendor/react/packages/shared/ReactSharedInternals.js:10-14`), and React already exports it (`vendor/react/packages/react/src/ReactClient.js:110-123`). | No runtime semantic cost in a pinned fork. It is intentionally private, so the bridge must fail loudly on absence/shape mismatch. |
| `ReactSharedInternals.T` | Detects a transition while the synchronous `startTransition` scope is running. React sets it before calling the scope and restores it in `finally` (`vendor/react/packages/react/src/ReactStartTransition.js:45-76`, `vendor/react/packages/react/src/ReactStartTransition.js:94-117`). | Cannot identify the lane/batch, a render of that transition, a post-scope correction, retirement, or per-root commit. It is useful inside `currentBatch`, not a protocol replacement. |
| Public `startTransition` / `useTransition` | Wrap explicit alt-a writes and ordinary synchronous watcher callbacks. Alt-a already does this in its throughput helpers (`packages/cosignals-alt-a/src/react/hooks.ts:336-375`). | Plain `React.startTransition` is supported and used by RTL (`packages/cosignals-alt-a/tests/react/real-react.spec.tsx:648-713`), so wrapper-only tracking is incomplete. A fresh transition also cannot replace same-lane `runInBatch`. |
| `useSyncExternalStore` | Stock-React urgent subscription, render/subscribe consistency checks, SSR snapshot plumbing. | React's implementation states that store updates are always synchronous (`vendor/react/packages/react-reconciler/src/ReactFiberHooks.js:1697-1700`) and forces subscription changes onto `SyncLane` (`vendor/react/packages/react-reconciler/src/ReactFiberHooks.js:1860-1872`). It therefore destroys non-blocking transition lane parity, writer worlds, pending invisibility, and exact `flushSync` inclusion. |
| `useLayoutEffect` commit probe | A component can publish “this rendered descriptor committed” after its own commit. | Can approximate current `useCommitted`/`useSignalEffect` assertions, but misses roots with no surviving alt-a hook, runs after React's internal retirement point, and does not by itself provide per-root batch deltas or lock-in. Exact multi-root semantics require extra alt state and retirement reordering. |
| Promise/scope settlement heuristic | A wrapper can retire a store-only async action when its returned promise settles. | A synchronous transition can remain pending because its render suspended after the scope returned; scope settlement is then too early. It also misses plain/nested framework transitions. |
| Scheduler priority or microtask boundaries | Approximate urgent/default event classification and event close. | Priority is not batch identity; microtask close is not last-root commit. Both alias interleaved transitions and expose drafts early under Suspense. |
| MutationObserver / DevTools commit hooks | Notice some DOM commits after the fact. | Host-specific, post-hoc, no lane/write-set identity, and misses no-mutation commits. It cannot feed pass reads or pre-commit consistency. |

## 3. Tandem redesigns of alt-a

Savings below are marginal estimates for the named change and overlap where noted.

| Tandem change | Alt-a LoC delta | Fork LoC saved | Result |
|---|---:|---:|---|
| Make the hidden React driver match the engine adapter directly | **−90 to −130** | **−360 to −410** | Deletes most of the 190-line bridge, the 334-line client channel, public re-exports, listener `Set`, allocator adapter, and ignored payload conversion. No fidelity loss; this is the primary recommendation. |
| Replace `isCurrentWriteDeferred` + minting get with `currentBatch(claim)` | **−10 to −20** | **−35 to −55** | One canonical token answer; reads use a non-minting peek and writes claim. Removes the current ambient-read mint. No fidelity loss. Overlaps the direct-driver saving. |
| Replace yield/query repair with render-exit/resume edges | **−12 to −20** | **−25 to −40** | Deletes `getRenderContext`, `healStaleRenderCtx`, and the multi-frame generic helper. No fidelity loss if exit is in every sync/concurrent work-loop return/finally path. |
| Reuse the originating `Transition` object and one included-ID scratch array | **0 to −10** | **−15 to −25** | Removes per-`runInBatch` transition/DEV-Set allocation and per-pass ID-array allocation. Safe only because there is one pinned consumer and it does not retain the array. |
| Publish committed render descriptors from layout effects | **+30 to +50** | **−80 to −120** | Can replace `onBatchCommitted` for roots/components containing alt-a hooks. Exact spanning-root lock-in, retirement ordering, effect-only roots, and roots whose last signal hook unmounts need explicit decisions. Reduced fidelity unless those cases are declared out of scope. |
| Track only deferred batches; encode urgent writes as token-0 pseudo records | **+15 to +30** | **−40 to −70** | The engine already has applied+retired pseudo records (`packages/cosignals-alt-a/src/engine.ts:2493-2512`, `packages/cosignals-alt-a/src/engine.ts:1690-1706`). But a default-lane write excluded by `flushSync` would become visible merely because its seq precedes the pass pin, breaking exact useState parity. This is not an all-feature change. |
| Drop `runInBatch`; let callbacks inherit their current scope or issue a new transition | **−35 to −55** | **−70 to −95** | Initial synchronous writes often still align, but late subscription, grouped drains after scope exit, mid-pass delivery, and retired-race fallback lose atomicity. A fresh transition may commit separately; this removes the guarantee the mechanism exists to provide. |
| Wrapper-owned transitions only | **+40 to +80** | **−180 to −260** | Can support simple `startSignalTransition` cases. It misses the plain `React.startTransition` RTL cases, nested/framework transitions, interleaved render batch sets, and commit/retirement truth. |

### Gate choices

The activation edge is already free in fork LoC: the bridge flips the monotonic gate at attach (`packages/cosignals-alt-a/src/react/bridge.ts:122-124`). There is no reason to add a root-registration patch.

A dynamic “log only while a deferred batch is live” gate is smaller in steady-state engine cost but is not semantically free. The original design's stronger idle-default-plus-`flushSync` test exists precisely because a React render may exclude a non-deferred lane while an external write has already happened (`react-concurrent-signals-arena-alt-a.md:3294-3310`). The current RTL `flushSync` test checks same-task mirror equality but does not hold a pending idle/default lane in the stronger shape (`packages/cosignals-alt-a/tests/react/real-react.spec.tsx:359-397`). Do not take the dynamic-gate or urgent-token-0 saving unless exact idle/default exclusion is intentionally dropped or that stronger test is added and passes.

### Context-probe choices

There are three viable designs, in descending fidelity:

1. **Explicit pass start + render exit/resume + pass end**: event-driven, no per-read fork call, preserves pin lifetime and callstack truth. Recommended.
2. **Per-read private query returning root, rendered batch set, and render-attempt serial**: fewer callbacks but a fork call and likely allocation/scan on every signal read; it also needs a cleanup rule for completed-but-uncommitted attempts.
3. **Dispatcher/transition heuristics from shared internals**: can answer “some hook render” or “inside a transition scope,” but not root, render batch set, attempt lifetime, or transition render. This cannot preserve interleaved worlds or the context-sensitive two-level Suspense rule.

## 4. Capability/LoC curve

Production fork LoC only:

| Point | Estimated LoC | What remains | What is lost |
|---|---:|---|---|
| Current generic fork | 1,510 | Everything, including unused generic APIs. | Nothing; large maintenance surface. |
| **Alt-only exact protocol (recommended)** | **430–535** | Encoded stable batches, backfill, async parking, pass worlds, interruption/rebase, exact render context, per-root commit lock-in, retirement, and same-lane late corrections. Covers every current RTL feature and retains the stronger core protocol semantics. | Public/general external-runtime API, multiple consumers/renderers, mutation windows, discard-all, driverless mode, generic dispositions/generations. |
| Commit-lite / no spanning-root exactness | 320–420 | Single-root and ordinary multi-root eventual rendering, transition worlds, retirement, Suspense, lane re-entry. A hook commit probe can likely preserve the current simple committed-effect assertions. | A batch committed on root A while pending on B cannot be represented exactly; committed effects may run late or sample too much; committed-root lock-in is gone. |
| No lane re-entry | 240–335 | Write classification, pass worlds, retirement, interruption/rebase, first-load and transition-aware Suspense. | Late subscriber/grouped-drain corrections are not guaranteed to commit with the originating transition. The mount-during-transition feature degrades from atomic to eventual. |
| One root, one pending transition | 120–190 | One deferred token scalar, simple held transition, W0-vs-writer visibility, first-load/refresh suspension. | Interleaved transitions alias; multi-root, entangled batch sets, exact `flushSync` lane inclusion, and per-root committed views disappear. The distinct-fetch scenario is no longer guaranteed (`packages/cosignals-alt-a/tests/react/real-react.spec.tsx:288-356`). |
| **Unpatched React** | **0** | Urgent graph semantics, atoms/computeds, lazy initialization, StrictMode lifecycle, first-load Suspense, error propagation, `isPending`, and urgent stale-while-refreshing can remain as ordinary external-store behavior. | All exact transition integration listed below. |

The middle points are capability points, not claims that the current tests pass without an implementation. The current RTL file is not strong enough to certify their lost edges.

### What exactly dies at zero fork

**Survives:**

- ordinary urgent writes and rerenders;
- graph equality, computed propagation, batching within the signal engine;
- component-local atoms/reducers/computeds, lazy state, and StrictMode cleanup (`packages/cosignals-alt-a/tests/react/real-react.spec.tsx:74-110`, `packages/cosignals-alt-a/tests/react/real-react.spec.tsx:730-778`);
- first-load Suspense, because a no-latest `SuspendedBox` can still throw its gate (`packages/cosignals-alt-a/src/react/hooks.ts:75-97`, `packages/cosignals-alt-a/tests/react/real-react.spec.tsx:258-285`);
- urgent refetch stale content and a boolean pending probe, because that choice can be made without a transition render (`packages/cosignals-alt-a/tests/react/real-react.spec.tsx:606-645`).

**Dies or becomes heuristic:**

- **Signal/React-state lockstep.** Stock `useSyncExternalStore` schedules `SyncLane`, not the transition lane (`vendor/react/packages/react-reconciler/src/ReactFiberHooks.js:1860-1872`), so the no-mixed-frame guarantee in the lockstep test is no longer provided (`packages/cosignals-alt-a/tests/react/real-react.spec.tsx:112-139`).
- **Interruption and rebase against React's updater queue.** There is no batch identity or retirement edge with which to keep the deferred receipt unapplied and later fold it over the urgent write (`packages/cosignals-alt-a/tests/react/real-react.spec.tsx:141-197`).
- **Pending-draft invisibility and read-your-own-draft.** A stock external store either publishes immediately, leaking `A=1` to the urgent handler, or stages behind a userspace wrapper that cannot observe plain/framework transitions and commits (`packages/cosignals-alt-a/tests/react/real-react.spec.tsx:648-713`).
- **Interleaved pass worlds.** No public API says which transition batches a render consumed, so node×world thenable slots cannot distinguish the two pending works (`packages/cosignals-alt-a/SPEC-RESOLUTIONS.md:50-57`, `packages/cosignals-alt-a/tests/react/real-react.spec.tsx:288-356`).
- **The context-sensitive two-level Suspense rule.** Without knowing that the current render includes a deferred batch, alt-a must either always serve latest—allowing a signal-only refresh transition to commit stale early—or always suspend—causing urgent refetch fallback flashes. The required split is explicit in `SPEC-RESOLUTIONS.md:80-95` and implemented at `packages/cosignals-alt-a/src/api.ts:640-651`.
- **Signal/use(P) co-suspension as a guarantee.** Throwing the same gate still works by chance when another `use(P)` consumer holds the boundary, but a signal-only transition cannot know it must suspend (`packages/cosignals-alt-a/tests/react/real-react.spec.tsx:527-604`).
- **Late-subscription atomicity.** A fresh transition is not the original lane; the correction may paint after the rest of the transition (`packages/cosignals-alt-a/src/engine.ts:3540-3555`).
- **Exact per-root committed views/effects.** Public effects tell a component that it committed, not which external batch delta became visible on which root (`packages/cosignals-alt-a/src/engine.ts:2911-2926`, `packages/cosignals-alt-a/src/react/hooks.ts:245-320`).
- **Exact `flushSync` inclusion parity.** A synchronous external-store notification can be included when the corresponding React lane is excluded, or can force React to restart as blocking (`vendor/react/packages/react-reconciler/src/ReactFiberHooks.js:1676-1694`, `vendor/react/packages/react-reconciler/src/ReactFiberHooks.js:1697-1700`).

## 5. Recommendation and migration sketch

Choose the **430–535-line alt-only exact protocol** first. It captures nearly all available savings without changing the product's concurrency contract. The irreducible center is not the public API; it is the lane-to-batch registry, pass inclusion, last-root retirement, and lane re-entry.

### Migration

1. **Pin the behavioral gate before deleting code.** Keep the current RTL suite and add focused assertions for the currently under-asserted edges that are intended to survive: completed/suspended render exit, real yield-gap ambient access, `setState` before signal write, a deferred batch spanning two roots, and exactly one late-subscriber commit. If those are deliberately not product requirements, mark them as reduced-feature decisions instead of silently dropping them.
2. **Converge the model in alt-a.** Replace `ForkReact` plus the mapping adapter with one `AltAReactDriver` shape shared by the real bridge and fork double. Change classification/get to `currentBatch(claim)`, make `runInBatch` always execute, and remove ignored event fields. The real bridge should become presence checking, guarded listener installation, and disposal only.
3. **Install the driver privately.** Have the reconciler attach the driver to `React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE`. Delete `ReactExternalRuntime.js`, all seven index export blocks, the `ReactClient` imports/exports, and the typed `E` field. A dynamic pinned-fork property is sufficient.
4. **Slim the registry without weakening its edges.** Mint encoded IDs internally; retain pending/backfill/finish/close, async parking, rendered-lane stash, root lock-in, and lookup for lane re-entry. Emit one committed callback per ID and one retirement callback without extra payloads. Remove fallback allocation, allocator registration, generation counters, public reset, and generic listener checks.
5. **Replace pass repair with exact edges.** Keep one alt-a active-root scalar. Fresh stack starts a pass; every render function exit pauses render context; continuation resumes it; commit/restart/discard ends it. Delete `getRenderContext`, frame `Set`/`WeakSet`, mutation notifications, and discard-all enumeration.
6. **Narrow `runInBatch`.** Only odd/deferred live tokens need lane pinning. Reuse the stored Transition object; unknown/retired IDs execute at discrete priority. Remove live-urgent targeting and transition-object construction.
7. **Delete unrelated fork code and collapse tests.** Remove the react-noop patch and generic protocol tests. Retain the focused insertion-edge suite above plus alt-a RTL.
8. **Verify in this order:** build the vendored React artifacts; run the focused reconciler tests; run `packages/cosignals-alt-a/tests/react/real-react.spec.tsx`; run all alt-a tests; then measure the final diff with the same `e71a6393e6..HEAD -- packages` numstat command. Also profile that ambient reads no longer mint batches and grouped watcher delivery no longer allocates a Transition/DEV Set per `runInBatch`.

Only after that lands should the project consider the commit-lite, deferred-only, or no-`runInBatch` points. Those are product-scope changes, not cleanup. The owner decision needed for a second phase is explicit: whether exact spanning-root committed views, idle/default `flushSync` exclusion, real yield-gap behavior, and one-commit late correction remain requirements even though today's RTL file does not fully assert them.
