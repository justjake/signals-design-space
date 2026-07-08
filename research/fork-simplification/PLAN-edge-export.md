# PLAN: the edge-export fork (one fork, two engines, registry in userspace)

Executes the owner ruling of 2026-07-08 (CONSTRAINTS.md rules 4-5): fork-side lines of
code is the top objective; the React fork exposes only raw facts and capabilities, in
React's own vocabulary (lanes, containers, thenables); every piece of cooked logic —
batch identity, the merge rule, backfill, per-root commit lock-ins, async-action
parking, pass-frame pairing — moves out of the fork into ONE shared TypeScript package,
`packages/react-signals-utils`, consumed by both engine bridges. This supersedes
SYNTHESIS.md's §1.1 verdict that the registry should stay fork-side; the synthesis'
drift-risk findings become the shared package's test obligations.

Terms used throughout (self-contained glossary):

- **fork** — vendor/react, a patched React whose only job is letting an external
  signals engine cooperate with concurrent rendering (currently +5,012 lines over
  upstream `e71a6393e6`).
- **batch** — a set of updates React renders and retires as a unit; today identified
  by an integer id the fork's batch registry maintains per lane.
- **lane** — React's internal scheduling bit (31 bits, one bit per lane); transition
  lanes are "deferred" (renders don't block paint).
- **the registry** — `ReactFiberBatchRegistry.js` (564 lines), the fork module that
  turns raw lane events into batch identity, merge, backfill, per-root commit reports,
  lock-ins, async-action parking, and retirement. This plan deletes it from the fork
  and re-homes its logic, once, in `packages/react-signals-utils`.
- **taps** — the new minimal raw surface the fork exposes: callbacks that fire at
  reconciler edges plus three pull methods, carried on a private host object.
- **bridge** — each engine's adapter: `packages/cosignals-alt-a/src/react/bridge.ts`
  (190 lines) and `packages/cosignals-alt-b/src/react.ts` (`ReactFork`, lines 471-663).
- **alt-a-fable's edge-export list** — the tap inventory proposed in
  research/fork-simplification/alt-a-fable.md line 135 (there labeled "T6"/"F2": a fork
  that exports raw lane facts and moves the registry to userspace); this plan adapts it
  for two-engine service.

All file:line citations below were read from the working tree during this planning
session. WorkLoop/RootScheduler line references are to the fork diff hunks
(`git -C vendor/react diff e71a6393e6..HEAD`), marked "hunk +NNN".

---

## 1. Tap surface

### 1.1 Transport: the private host object

Zero public exports. The reconciler creates one host object at module evaluation and
assigns it to `ReactSharedInternals.E` — the slot the fork already added
(`ReactSharedInternalsClient.js` +5, kept) on React's existing
`__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE` export
(ReactClient.js, upstream). Feasibility is already proven in the tree: alt-b reads
this exact internals object today for its transition-scope probes
(cosignals-alt-b/src/react.ts:564-571 and :635-641).

```ts
// ReactSharedInternals.E after migration (Flow in the fork; TS shape shown)
type ReactSignalsTaps = {
  // Handshake. The shared package asserts exact equality and throws otherwise,
  // so lane-layout or semantics drift fails loudly at attach, never silently.
  forkProtocolVersion: number,

  // Exactly one consumer (the shared package). The package throws on double
  // install; the two engines are alternatives in one process, not cohabitants.
  consumer: null | TapConsumer,

  // Filter mask, WRITTEN by the consumer, READ by the fork's hottest taps:
  // the union of lanes currently holding live batch identities. The consumer
  // sets a bit when it creates a batch identity for a lane and clears it at
  // retirement/reset. Keeps the per-setState tap cost at one AND + branch
  // when no batch is live — the same cost profile as today's inline check
  // (ReactFiberBatchRegistry.js:219-221).
  watchedLanes: Lanes,

  // Pull methods (package → fork), detailed in 1.3.
  getCurrentWriteLane(): number,
  getRenderContext(): null | {container: mixed},
  runInBatch<R>(lane: Lane, fn: () => R): R,
};
```

Both bridges already throw loudly when the protocol is absent
(cosignals-alt-a/src/react/bridge.ts:74-86; cosignals-alt-b/src/react.ts:480-487);
that posture carries over — the shared package feature-detects `internals.E` and
refuses stock React.

### 1.2 Consumer callbacks (fork → shared package), all nine

Every callback fires only when `consumer !== null`; the three schedule-path taps are
additionally gated on `watchedLanes` as noted. "Port of registry:N-M" means the shared
package reproduces those exact lines in TypeScript (section 2).

| # | Tap signature (React terms) | Fires from (upstream file, call site) | Replaces / feeds |
|---|---|---|---|
| 1 | `onRootUpdated(container: mixed, updatedLanes: Lanes)` | ReactFiberWorkLoop.js, the fork's `markRootUpdated` wrapper (hunk +1964, today calling `batchRegistryOnRootUpdated`). Gate: `(updatedLanes & watchedLanes) !== 0`. | Pending edge — package records the container in the batch's root set (port of registry:218-227). Retirement truth for both engines. |
| 2 | `onScheduledRootPending(container: mixed, pendingLanes: Lanes)` | ReactFiberRootScheduler.js, `processRootScheduleInMicrotask`, inside the "root still has work" branch — the exact line where `batchRegistryBackfillRoot(root)` sits today (hunk +317-324), with the fork's own comment "Must run before the close edge below". Gate: `(pendingLanes & watchedLanes) !== 0`. | Backfill — package adds the container to every live batch whose lane is pending (port of registry:242-255). See 1.4 on timing. |
| 3 | `onEventClosed(actionLane: Lane, actionThenable: Thenable<void> \| null)` | ReactFiberRootScheduler.js, end of `processRootScheduleInMicrotask` — the exact line where `batchRegistryOnEventClosed()` sits today (hunk +354-359). Args read at the call site from `peekEntangledActionLane()` / `peekEntangledActionThenable()` (ReactFiberAsyncAction, the same imports the registry holds today, registry:16-19). Gate: `watchedLanes !== 0`. | Close edge + async-action parking (port of registry:422-472). See 1.5. |
| 4 | `onRenderPassStart(container: mixed, entangledRenderLanes: Lanes)` | ReactFiberWorkLoop.js, `prepareFreshStack` after `finishQueueingConcurrentUpdates()` — today's `notifyRenderPassStart` site (hunk +2483). Second arg: `lanes !== NoLanes ? getEntangledLanes(root, lanes) : NoLanes` (`getEntangledLanes` is already imported by upstream WorkLoop, base file line 199). `NoLanes` means "stack reset without new work" — the discard signal. | Frame open + implicit end of any prior frame on this container; the render-time entangled stash the finish edge needs (port of registry:121-134); the include-set computation (port of registry:533-564). |
| 5 | `onRenderPassYield(container: mixed)` | ReactFiberWorkLoop.js, 2 sites: `renderRootSync` incomplete-tree exit (hunk +2962-2970) and `renderRootConcurrent` yield exit (hunk +3255-3263). RAW: may fire when the frame already yielded; the package's per-frame yielded flag dedupes (the guard that lives in ReactFiberExternalRuntime.js:134 today). | alt-a's edge-driven read-context flip; alt-b ignores (shadow of its poll). |
| 6 | `onRenderPassResume(container: mixed)` | ReactFiberWorkLoop.js, 2 sites: `renderRootSync` continuation branch (hunk +2856-2860) and `renderRootConcurrent` re-entry (hunk +3030-3035). RAW: also fires for a just-prepared stack that never yielded; package filters via the yielded flag (today's guard, ReactFiberExternalRuntime.js:154). | Same consumers as tap 5. |
| 7 | `onRootCommitted(container: mixed, finishedEntangledLanes: Lanes, remainingLanes: Lanes, rependedLanes: Lanes)` | ReactFiberWorkLoop.js, `commitRoot`: `finishedEntangledLanes = getEntangledLanes(root, lanes)` captured BEFORE `markRootFinished` clears entanglement bookkeeping, `rependedLanes = mergeLanes(updatedLanes, concurrentlyUpdatedLanes)` (both computed exactly as the fork does today, hunk +3992-4010); the tap fires after `markRootFinished`, replacing BOTH today's `notifyRenderPassCommitted` and `batchRegistryOnRootFinished` calls (hunk +4017-4035). `remainingLanes = root.pendingLanes` at that moment. | Frame close (committed), per-root commit report, re-pend refinement, committed-root lock-ins, retirement (port of registry:295-406). Package preserves the internal order: frame-end → per-root report → retirements. |
| 8 | `onBeforeMutation(container: mixed)` | ReactFiberWorkLoop.js, `flushMutationEffects`, before `commitMutationEffects` (hunk +4294-4300). | The DOM mutation window's open edge — required by CONSTRAINTS rule 1 (MutationObserver use case), unconsumed by either engine today but not deletable. Direct consumer callback; no generic dispatch. |
| 9 | `onAfterMutation(container: mixed)` | ReactFiberWorkLoop.js, same function, in the `finally` (hunk +4311-4316) so a mutation-phase error cannot leave observers paused. | The window's close edge. alt-b's `ReactFork` already forwards both to its listeners (react.ts:536-537). |

### 1.3 Pull methods (shared package → fork), all three

| # | Method | What it does fork-side | Why it cannot leave the fork |
|---|---|---|---|
| 10 | `getCurrentWriteLane(): number` — returns `lane \| (deferred ? SIGN_BIT : 0)` packed in one integer (lanes occupy bits 0-30, so bit 31 is free; negative result = deferred). Returns 0 only if no renderer loaded (bridges reject that configuration already). | The write-classification cascade exactly as today's provider `getCurrentWriteBatch` (hunk +876): render-phase arm `pickArbitraryLane(workInProgressRootRenderLanes)` with `deferred = isTransitionLane(lane)`; transition arm `requestTransitionLane(transition)` with `deferred = true` (gesture transitions excluded, same branch); else `eventPriorityToLane(resolveUpdatePriority())`. Then `ensureScheduleIsScheduled()` — an UPSTREAM function (RootScheduler base line 154, zero fork cost) — so any write that causes the package to create a batch identity is guaranteed a later `onEventClosed`. The `getOrCreateBatchId` call is gone: identity creation is the package's job. | Reads `executionContext`, `workInProgressRootRenderLanes`, `ReactSharedInternals.T`, and claims the event's transition lane via `requestTransitionLane` — all invisible or unperformable from userspace. |
| 11 | `getRenderContext(): null \| {container: mixed}` | Unchanged from today's provider (hunk +876 block): non-null exactly while render code executes on this thread. | `executionContext & RenderContext` is unobservable from userspace. Directly consumed by alt-b per RENDER-context read (engine.ts:452-463 `forkRenderingNow`/`ctxNow`), per write (engine.ts:2228), and for effect-root identity (react.ts:931-935, :600-602); consumed by alt-a's suspension-gap self-heal (engine.ts:1557-1564) and write gate (engine.ts:2451). |
| 12 | `runInBatch<R>(lane: Lane, fn: () => R): R` — `lane === NoLane` requests the documented urgent fallback. | Today's `runInBatchImpl` (hunk +967-1019) minus the `lookupLiveBatchSlot` resolution (the caller now supplies the lane) and minus the live-urgent branch (dead: both engines call only for deferred batches — alt-a engine.ts:2165-2166, :2298-2306, :2409-2416; alt-b engine.ts:2540-2543, :2568-2570). Keeps: the render-phase throw (error 605), unconditional save/restore of priority + transition + pin (nesting composes), the transition-scope object creation, and the RootScheduler lane pin (`setRunInBatchTransitionLane` + the `requestTransitionLane` override, RootScheduler hunk +707-735). `lane !== NoLane` pins the transition lane; `NoLane` runs `fn` at `DiscreteEventPriority` outside any transition. | The keystone (CONSTRAINTS rule 2): scheduling updates into an EXISTING batch's lane has no userspace substitute — a fresh `startTransition` claims a lane React never entangles with the pending batch. |

The retired-token contract is preserved at the package layer: the package's
`runInBatch(token, fn)` always executes `fn` — live deferred token → fork
`runInBatch(lane, fn)`; retired/unknown token → fork `runInBatch(NoLane, fn)` (urgent
fallback). alt-a's bridge depends on always-execute (bridge.ts:166-170 returns true
unconditionally); alt-b treats any non-false result as "ran" (react.ts:604-613).

### 1.4 Backfill timing — verified, no approximation needed

The concern: the registry repairs pending edges ("backfill") in the root scheduler's
microtask BEFORE the close edge, and a tap that fired anywhere else would let the close
edge retire a batch early. Why backfill exists: in
`startTransition(() => { setState(x); store.write(y) })` — ordinary line order — the
setState is scheduled before the store write creates the batch identity, so the pending
edge (tap 1) saw no live batch and recorded nothing; without repair, the close edge
would see an empty root set and retire the batch while React still has its work
pending, leaking the draft into ambient committed state pre-commit.

Verified in the working tree: `processRootScheduleInMicrotask` calls
`batchRegistryBackfillRoot(root)` inside its per-root loop for every root that still
has work (RootScheduler hunk +317-324), and calls `batchRegistryOnEventClosed()` at the
end of the same microtask (hunk +354-359). Both are one-line call sites the fork
already owns. Tap 2 (`onScheduledRootPending`) fires from the first line; tap 3
(`onEventClosed`) from the second. The shared package therefore observes
(root, pendingLanes) for every scheduled root strictly before it runs its close-edge
decision, in the same microtask, in the same order — the backfill semantics port
without any timing approximation. No new timing point had to be invented; the tap
list's `scheduledRootPending` entry (alt-a-fable.md line 135) lands at exactly the
right line.

One behavior note ported with it: the pending edge (tap 1) plus backfill (tap 2) are
both idempotent set-adds package-side, exactly as registry:224-226 and :249-253 are
today.

### 1.5 Async-action parking — reconstruction

Today (registry:422-472): at the close edge, a store-only DEFERRED batch whose lane
equals the entangled async-action lane, with a live action thenable, is PARKED instead
of retired — the action's post-await updates commit later, and retiring at event close
would make the batch's store writes visible mid-action. The parked slot re-runs the
close decision when the thenable settles, with self-invalidation: the settle callback
captures the batch id it parked and no-ops if the slot's tenancy changed (test reset,
or retire-then-reuse of the lane).

Reconstruction from taps: tap 3 carries both raw facts — `actionLane` and
`actionThenable` — read at the close edge, the only moment they are knowable-and-needed
(entanglement is only established after the transition scope returns, which precedes
the scheduling microtask; registry:415-420 documents this). The package ports
registry:434-441 (park decision) and :445-472 (`parkUntilActionSettles`, including the
captured-id self-invalidation and the "if the action scheduled React work, the finish
edge owns retirement" convergence rule) verbatim. Stale-settlement safety is identical
because the guard state (`slot.parked`, `slot.batchId`) lives wholly package-side, and
the package's test reset scrubs it exactly as `resetBatchRegistryForTest`
(registry:503-515) scrubs slots today.

### 1.6 Every consumed registry behavior, mapped to taps

CONSTRAINTS rule 3/5: each behavior either reconstructs exactly or its loss is priced.
Result: all reconstruct; nothing is lost. "Package" = `react-signals-utils`.

| Consumed behavior | Engine consumption evidence (read this session) | Reconstruction |
|---|---|---|
| Batch identity, ONE number space, deferred bit 0 | alt-b: one call per logged write, `token & 1` is the classification (engine.ts:2288-2290); token capture for ambient reads (react.ts:573-585) and startTransition (react.ts:646-653). alt-a: same single-call discipline (engine.ts:2481-2484); bridge forwards (bridge.ts:160-162). | Package `getCurrentWriteBatch()`: tap 10 → lane+deferred → its own lane-slot table → existing live id, or create `(++serial << 1) \| deferred` — the identical encoding BOTH bridges produce in their allocators today (alt-a bridge.ts:176-178; alt-b react.ts:489-494). |
| Merge rule (lane reused while its batch is pending → same id) | Both engines' lockstep/rebase families depend on it (every transition write resolves through it). | React reuses the lane bit; tap 10 returns that bit; the package's slot for that lane still holds the live id → reused. Port of registry:168-190's early return. |
| Open edge + live set (alt-b's gate and drain inputs) | Allocator callback is alt-b's DIRECT→LOGGED flip (`onBatchOpened`, react.ts:488-494 → engine.ts:3812-3814); `liveTokens()` drives urgent drains deciding in every live deferred world (engine.ts:2567-2576) and the commit-phase fixup scan (react.ts:181-190); `isBatchLive` feeds lock-ins (react.ts:93). | Identity creation happens inside the package's `getCurrentWriteBatch`, i.e. synchronously inside the engine's first logged write — the same moment the allocator fires today. Package maintains the live map and emits `onBatchOpened(token)`; `liveTokens`/`isBatchLive` become package methods. |
| Pre-creation open-work probe (alt-b's lazy-identity hole) | Per-write `fork.hasOpenWork()` in DIRECT mode (engine.ts:2243-2254); implemented as live set + open pass + `internals.T` read + `getRenderContext` (react.ts:627-644). | Live set and frame state are package state; the `internals.T` read stays bridge-side unchanged; `getRenderContext` is tap 11. Zero fork involvement beyond tap 11 — same as today. |
| Pending edge (retirement truth) | Retirement must wait for the real commit on every root the batch touched; both engines fold state at `onBatchRetired` (alt-a engine.ts:2576-2601; alt-b react.ts:527-529 → engine.ts:3866-3874). | Tap 1 → package root sets. |
| Backfill | Same retirement-truth consumers; the setState-before-store-write line order. | Tap 2 (section 1.4). |
| Finish edge: per-root commit report | alt-a: per-root committed views + commit listeners (`onBatchCommitted`, engine.ts:2911-2927; bridge fans out per batch, bridge.ts:147-152). alt-b: RootView pin bump + lock-in add + effect flush (react.ts:88-97; fan-out react.ts:531-535). | Tap 7 + the stash from tap 4 → port of registry:295-406: same committed-batch delta, same "report before retirement" order. |
| Re-pend refinement + committed-root lock-ins | Renders on a root that already committed a still-pending batch must keep including it or an urgent pass tears against that root's own DOM (registry:517-531 rationale). alt-b locks in via `isBatchLive` at commit (react.ts:88-97); alt-a via view mask (engine.ts:2915-2923). | The lock-in state (`committedRoots` per slot) and the re-pend test (`rependedLanes & finished & renderedStash & roots.has(root)`, registry:335-350) port verbatim; tap 7 carries all four lane masks, tap 4 the render-time stash. |
| Include set for a pass (`batchIdsForRender`) | alt-a resolves the pass world from the include mask (engine.ts:2847-2875); alt-b builds the pass frame + include mask (engine.ts:3815-3838) and the bindings' `currentPass`/`renderingDeferredPass` (react.ts:78-84, :361-366). | Package computes includes at tap 4: live ids on `entangledRenderLanes` bits, plus lock-ins for this container (port of registry:533-564), then emits cooked `onRenderPassStart(container, tokens)`. Same synchronous moment (inside `prepareFreshStack`). |
| Pass-frame pairing (exactly-once end, implicit end on restart, yield/resume alternation) | alt-a flattens to one open pass and defensively closes stale ones (bridge.ts:108-111, :125-145); alt-b container-filters (react.ts:496-526). Both need end-of-pass: alt-a sweep+quiescence (engine.ts:2877-2888), alt-b sweep + LOGGED→DIRECT flip (engine.ts:3846-3861). | Frame state (open flag + yielded flag per container) moves package-side; taps 4/5/6/7 are the raw edges; the package applies today's guards (ReactFiberExternalRuntime.js:99-105, :134, :154, :176-182) and emits cooked start/yield/resume/end. |
| Yield/resume events themselves | alt-a is edge-driven: flips `readCtx` (engine.ts:2901-2909) with only a one-way heal (RENDER→NEWEST, engine.ts:1557-1564) — deleting the events would make resumed time-sliced renders read the wrong world (SYNTHESIS §1.3 keep ruling). alt-b's arms are a harmless shadow (engine.ts:3840-3845). | Taps 5/6 keep the fork emitting; ~12 fork lines total across 4 call sites. |
| Close edge + async-action parking | Store-only retirement is alt-b's quiescence boundary (`maybeQuiesce` → DIRECT flip, engine.ts:3846-3860; pinned by `__debug.isDirect()` react-real.test.tsx:814). Mid-action invisibility protects both engines' users. | Tap 3 (section 1.5). |
| Retirement (absorption edge, exactly once) | alt-a folds tape entries into canonical state (engine.ts:2576-2601, disposition bit consumed only by its tracer at :2586); alt-b deletes from live + folds (react.ts:527-529, engine.ts:3866-3874). | Package emits `onBatchRetired(token, committed)` after the per-root report / at close-edge decisions — order preserved because the package owns the whole sequence. The `committed` bit is a free byproduct of the ported finish-edge logic (registry:373-378), so it is kept (alt-a's tracer keeps its debug bit at zero cost). |
| Root-commit generation (3rd arg of onRootCommitted) | Consumed by NEITHER: alt-a drops it (bridge.ts:147-152 signature ignores arg 3); alt-b voids it (react.ts:531-535 destructures only two args). | Not reconstructed. Deleted with the registry (registry:105-111, :301-304, :397). |
| Pass-end disposition (`committed` param) | Neither: alt-a drops (bridge.ts:141-145); alt-b voids (react.ts:524). | Not reconstructed; cooked `onRenderPassEnd(container)` has no bit. |
| Test reset | Both RTL harnesses scrub between tests (alt-b react-real.test.tsx:34-55 calls `unstable_resetBatchRegistryForTest`; alt-a bridge.ts:187 optional-chains it). | Becomes `resetForTest()` on the package — the fork no longer HOLDS any registry state to scrub (frame flags, stash, slots, parked settlements are all package state; the fork's save/restore in runInBatch is scoped; `watchedLanes` is cleared by the package's reset). The fork-side reset method is deleted, not kept: there is nothing left for it to reset. Harness call sites move to the package (two files). |

Tap count: **9 callbacks + 3 pull methods + 2 fields (version, watchedLanes)**.
Versus alt-a-fable's edge-export list (line 135): same nine facts/capabilities, with
three adaptations — (a) `onBeforeMutation`/`onAfterMutation` added (CONSTRAINTS rule 1;
the source list predates that ruling), (b) the `watchedLanes` filter field added so the
per-setState and per-microtask taps keep today's near-zero idle cost, (c)
`forkProtocolVersion` added per the owner ruling; and two simplifications —
`runInBatch` drops the `deferred` parameter (NoLane vs lane encodes the only two live
cases; the live-urgent branch is dead code, evidence in 1.3 row 12), and
`getCurrentWriteLane` packs deferredness into the sign bit so per-write calls allocate
nothing and the package needs zero knowledge of which lane bits are transition lanes.

---

## 2. Shared package design: `packages/react-signals-utils`

One new monorepo package holding the relocated cooked logic ONCE, consumed by both
bridges (CONSTRAINTS rule 5). It is the single installer of `taps.consumer` and the
single creator of batch identity.

### 2.1 Exported API

```ts
export type BatchToken = number; // (serial << 1) | deferredBit; bit 0 = deferred. Positive; 0 = "no batch".

// The cooked event stream — deliberately shaped like what BOTH bridges consume
// today, so porting them is mostly deleting their duplicated plumbing.
export type RegistryListener = {
  onBatchOpened?(token: BatchToken): void;              // identity created (alt-b's DIRECT→LOGGED gate edge)
  onRenderPassStart?(container: unknown, includedTokens: readonly BatchToken[]): void;
  onRenderPassYield?(container: unknown): void;
  onRenderPassResume?(container: unknown): void;
  onRenderPassEnd?(container: unknown): void;           // no disposition bit (unconsumed)
  onRootCommitted?(container: unknown, committedTokens: readonly BatchToken[]): void; // no generation (unconsumed)
  onBatchRetired?(token: BatchToken, committed: boolean): void; // bit kept: free byproduct; alt-a's tracer reads it
  onBeforeMutation?(container: unknown): void;          // forwarded taps 8/9
  onAfterMutation?(container: unknown): void;
};

export class ReactBatchRegistry {
  // Locates ReactSharedInternals.E via React's __CLIENT_INTERNALS export,
  // asserts forkProtocolVersion, throws on stock React or version drift,
  // throws if a consumer is already installed (single-consumer rule).
  constructor(react: typeof import('react'));

  subscribe(l: RegistryListener): () => void;   // error-guarded emit (see 2.4)

  // Cooked capabilities (what the bridges call today, same semantics):
  getCurrentWriteBatch(): BatchToken;           // classify (tap 10) + create-or-reuse identity
  getRenderContext(): { container: unknown } | null;    // tap 11 forwarded
  runInBatch<R>(token: BatchToken, fn: () => R): R;     // token→lane, tap 12; retired → NoLane urgent fallback; always executes
  liveTokens(): BatchToken[];                   // alt-b drains + fixups
  isBatchLive(token: BatchToken): boolean;      // alt-b lock-ins
  resetForTest(): void;                         // replaces the fork-side reset; both RTL harnesses move here
  dispose(): void;                              // uninstalls the consumer, clears watchedLanes and all state
}
```

Not in the API: an allocator hook. The package owns token creation with the one
encoding both bridges already produce independently today — alt-a's bridge allocator
`(++serial << 1) | (deferred ? 1 : 0)` (bridge.ts:176-178) and alt-b's identical line
(react.ts:489-494). One number space, one creator, bit 0 stays the classification both
engines read (alt-a engine.ts:2481-2484; alt-b engine.ts:2288-2290). alt-b's
expectation that the batch id arrives WITH its deferred bit at the open edge is met by
`onBatchOpened(token)` firing synchronously inside the same `getCurrentWriteBatch`
call that creates the identity — the timing its gate flip has today via the allocator
callback (react.ts:488-494 → engine.ts:3812-3814). alt-a's expectation — tokens are
opaque ints, bit 0 = deferred, slot interning by value (engine.ts:2853-2858) — is met
by the same encoding.

### 2.2 State held (all of it — the fork keeps none of this)

- `slots[31]` — per lane index: `{ token, deferred, roots: Set<container>, committedRoots: Set<container>, parked: Thenable|null }` (port of registry:75-99).
- `serial` — token counter, monotonic for the module's life (never reset, mirroring registry:100-103's rule so stale ids never collide).
- `live: Map<token, laneIndex>` — O(1) `runInBatch`/`isBatchLive`; replaces the fork's 31-slot scan (registry:200-212).
- `renderedLanesStash: WeakMap<container, Lanes>` — the render-time entangled expansion per container (port of registry:121-134). WeakMap: consumed at commit, dropped with the container if a root dies mid-pass; never enumerated.
- `frames: WeakMap<container, { yielded: boolean }>` — open-pass pairing state (replaces the fork's `rootsWithActivePass`/`rootsWithYieldedPass` sets, ReactFiberExternalRuntime.js:67-72). WeakMaps are sufficient because the only enumeration consumer was `discardAllWip`'s `getRootsWithOpenPassFrames` (ReactFiberExternalRuntime.js:79-85), which is deleted (unconsumed by both engines — absent from alt-a's `ForkReact` type bridge.ts:58-72 and alt-b's `ReactRuntime` type react.ts:448-469). Reclamation is total: frame entries delete at end/implicit-end; slot sets clear at retirement; parked settlements self-invalidate (1.5); the stash deletes at commit and reset.
- `listeners: Set<RegistryListener>` + installed-consumer handle.

Container identity note: the registry keys roots by `FiberRoot` today (registry:88-95
Sets, :111/:121 WeakMaps); the package keys by container (`root.containerInfo`). The
existing protocol already treats container as THE root identity everywhere userspace
sees (ReactFiberExternalRuntime.js:29-31 states it; both bridges key views by
container), so this is the same one-to-one mapping the product already relies on.

### 2.3 Tap subscription and identity creation flow

- Construction installs `taps.consumer` (the nine callbacks of 1.2) and asserts the
  version. The nine handlers run the ported registry/pairing logic and emit the cooked
  events of 2.1.
- `getCurrentWriteBatch()`: `packed = taps.getCurrentWriteLane()`; `lane = packed & ~SIGN`,
  `deferred = packed < 0`; slot lookup by `31 - clz32(lane)`; live slot → existing
  token (the merge rule); empty slot → create token, set `taps.watchedLanes |= lane`,
  record live, emit `onBatchOpened`. The fork's `ensureScheduleIsScheduled()` inside
  tap 10 guarantees the close edge for identities created by store-only writes.
- Retirement/reset clears the slot, the live entry, and the lane's `watchedLanes` bit.

### 2.4 Error isolation

The fork's generic channel is the only error guard today
(ReactExternalRuntime.js:176-190 wraps every listener in try/catch +
`reportGlobalError`); it dies with the channel. The guard moves here: the package's
emit wraps each listener callback, collects the error, and reports it without letting
it propagate into React's commit phase (taps run synchronously inside commitRoot and
the scheduler microtask). alt-a's bridge additionally guards its own callbacks already
(bridge.ts:115-121); alt-b's `ReactFork.emit` does not (react.ts:542-546, bare loop) —
fixed in migration step 0 regardless, as defense in depth while both transports exist.

### 2.5 Size estimate

| Region | est. LoC |
|---|---:|
| Registry port (slots, identity/merge, pending/backfill/finish/close/park/retire, includes) | ~300 |
| Pass-frame pairing (open/implicit-end/yield-dedupe/close) | ~60 |
| Token creation, live map, watchedLanes maintenance | ~40 |
| Taps attach: version assert, consumer install, feature detection | ~35 |
| Guarded emit + listener set + reset/dispose | ~45 |
| Types + documentation at npm-package density | ~120 |
| **Total product** | **~600 (±100)** |

Plus package scaffolding (package.json, tsconfig, vitest config) ~40 and the ported
test suite (section 5). By design, lane bitmasks and container references cross into
this package; the `forkProtocolVersion` assert is the tripwire for lane-layout or
tap-semantics drift (section 7 discusses the residual coupling).

### 2.6 What each bridge becomes

- **alt-b**: `ReactFork` (react.ts:471-663) drops its live map, serial, allocator
  registration, pass-container filtering, and fan-out — the package provides them. It
  keeps and composes the alt-b-specific pieces: `getAmbientReadToken`/`lastScopeT`
  (react.ts:559-598), `hasOpenWork`'s `internals.T` arm (react.ts:627-644),
  `startTransition` token capture (react.ts:646-653), and the `entangleLog` test
  surface (react.ts:477-478, :604-613). Net: roughly −80 lines, mechanical.
- **alt-a**: bridge.ts drops its allocator registration and serial (bridge.ts:173-178)
  and its pass-pairing defense (bridge.ts:108-111, :125-145 — the package now
  guarantees pairing); keeps the `ForkAdapter` shaping (fan-out of `onRootCommitted`
  into per-batch `onBatchCommitted`, bridge.ts:147-152; synthesized `onRootRegistered`,
  bridge.ts:123; lineage constant 0, bridge.ts:137) and the step-0 non-side-effecting
  deferred probe. Net: roughly −30 lines.

The engines themselves (`engine.ts` on both sides) are untouched: their fork-facing
seams (`ForkAdapter` for alt-a, `ForkLike` for alt-b, fork.ts:28-62) keep their shapes,
which is what keeps both unit/oracle suites pinning semantics through the migration.

---

## 3. What remains in the fork

File-by-file. "Upstream-owned" = files that exist in stock React, where every retained
line is rebase cost; "new file" = fork-created, rebases trivially. Doc density for
retained hunks is upstream-normal (the protocol spec prose moves to the shared package
and the fork test headers).

| File | Today | After | Contents after |
|---|---:|---:|---|
| `react-reconciler/src/ReactFiberWorkLoop.js` (upstream-owned) | 291 | **~135** | imports (~8); `getCurrentWriteLane` cascade + `ensureScheduleIsScheduled` call (~25); `getRenderContext` (~10); `runInBatchImpl` less slot lookup and live-urgent branch, plus host-install of the three pull methods (~50); tap 1 in `markRootUpdated` (~4); tap 4 in `prepareFreshStack` (~5); taps 5/6 at 4 sites (~12); tap 7 capture + emit in `commitRoot` (~12); taps 8/9 mutation bracket (~9). |
| `react-reconciler/src/ReactFiberRootScheduler.js` (upstream-owned) | 33 | **~32** | `runInBatchTransitionLane` pin + `requestTransitionLane` override (~21, unchanged mechanics); tap 2 in the microtask loop (~6); tap 3 at microtask end (~5). |
| `react-reconciler/src/ReactFiberSignalsTaps.js` (NEW file, replaces ReactFiberExternalRuntime.js) | (204) | **~55** | host-object creation + `ReactSharedInternals.E` assignment; Flow types for the tap surface; `forkProtocolVersion`; tiny null-checked emit helpers so the WorkLoop/RootScheduler call sites stay 1-2 lines each. No frame sets, no exactly-once logic, no registry. |
| `react/src/ReactSharedInternalsClient.js` (upstream-owned) | 5 | **5** | the `E` slot (type + `E: null` init) — the whole transport. |
| `scripts/error-codes/codes.json` | 4 | **2** | 605 (`runInBatch` during render) stays; 601 (unrelated) stays; 604 (discardAllWip) and 606 (allocator) die. |
| `react-reconciler/src/ReactFiberBatchRegistry.js` | 564 | **0** | deleted (section 4). |
| `react/src/ReactExternalRuntime.js` | 334 | **0** | deleted. |
| `react/src/ReactClient.js` + 7 `index*.js` | 66 | **0** | deleted (zero public exports). |
| `react-noop-renderer/src/createReactNoop.js` | 13 | **0** | deleted with the discard-driven fork tests. |
| **Fork product total** | **1,510** | **≈ 230 (±30)** | |
| — of which upstream-owned | ~412 | **≈ 175** (WorkLoop ~135 + RootScheduler ~32 + SharedInternals 5 + codes 2) | |
| — of which new files | ~1,102 | **≈ 55** | |

What stays and why, in one list:

- **Taps 1-9** — raw facts only the reconciler can see, at lines the fork already
  touches today (every tap call site replaces an existing registry/notify call site;
  no new reconciler edges are invented).
- **`runInBatch` + the transition-lane pin** — the keystone capability (CONSTRAINTS
  rule 2); userspace cannot schedule into an existing batch's lane.
- **The mutation window** (taps 8/9) — CONSTRAINTS rule 1, as direct consumer
  callbacks; ~9 lines at the two `flushMutationEffects` sites plus the two host fields.
- **Yield/resume** (taps 5/6) — alt-a consumes resume healing: its read context is
  edge-driven with only a one-way self-heal (engine.ts:2901-2909, :1557-1564;
  SYNTHESIS §1.3 ruling), so a resumed time-sliced render needs the resume edge or it
  reads the newest world instead of the pass world.
- **The private transport** — the 5-line `E` slot; host object rides it.

Honest comparison of the three plans' fork sizes:

| Plan | Fork product LoC | Upstream-owned | Registry location |
|---|---:|---:|---|
| SYNTHESIS §4 (registry stays fork-side) | ~920 (~660 doc-trimmed) | ~200 | fork |
| alt-a-fable's single-engine edge-export ("F2") | ~210 | (not split) | alt-a's bridge only |
| **This plan (two engines)** | **≈ 230 (±30)** | **≈ 175** | `react-signals-utils`, once |

The two-engine number lands within ~10% of the single-engine floor because the second
engine's extra consumption is almost entirely cooked-layer (per-root views, open-edge
gate, live set) — it moves to the shared package, not the fork. The only fork-side
costs this plan carries beyond that floor are the mutation window (~15, a constraint
the single-engine estimate predates) and the version field (~2).

---

## 4. What gets deleted from the fork

Per-item, with counted lines (from the diff stat and file reads):

| Deletion | LoC | Where it goes |
|---|---:|---|
| `ReactFiberBatchRegistry.js`, entire file | −564 | logic → `react-signals-utils` (~300 of the port); identity-creation ceremony (allocator branch + DEV check + fallback counter, registry:100-103, :174-186), commit-generation WeakMap (registry:105-111, :301-304, :397 — consumed by neither engine, evidence 1.6), and `resetBatchRegistryForTest` (registry:489-515) are not ported to the fork side at all. |
| `react/src/ReactExternalRuntime.js` (isomorphic channel), entire file | −334 | listener Set + string-dispatch emit + error isolation → package emit guard (2.4); provider slot + allocator registration → host object + package token creation; public wrapper functions → nothing (bridges call the package). |
| Public exports: `ReactClient.js` hunk (17) + 7 `index*.js` hunks (49) | −66 | nothing — zero-export transport (1.1). |
| `ReactFiberExternalRuntime.js`, entire file | −204 | frame sets + exactly-once notify logic → package pairing (~60 of the port); `getExternalRuntime`/provider registration → the ~55-line taps module; `getRootsWithOpenPassFrames` → nowhere (its only caller dies). |
| `discardAllWip` (WorkLoop hunk 1014-1061, ~48 incl. docs) + provider line + wrappers + error 604 | −~60 | nowhere: absent from both engines' runtime types (alt-a bridge.ts:58-72; alt-b react.ts:448-469). |
| Live-urgent `runInBatch` branch + slot lookup in `runInBatchImpl` | −~10 | dead branch deleted (1.3 row 12); lookup → package. |
| noop-renderer patch (canceled-suspended-commit support) | −13 | dies with the discard-driven fork test scenarios that needed it. |
| errors 604, 606 in codes.json | −2 | capabilities they served are gone. |
| Fork jest: registry/commit/pass families that pin relocated logic (section 5) | −~2,400 test lines | invariants re-pinned in package vitest + retained fork taps suite. |

Gross fork-side product deletion: ~1,280 of 1,510; net after the ~55-line taps module
and tap call sites: the fork lands at ≈230 (section 3 table).

---

## 5. Test strategy

Baseline: 4 fork jest files, 3,502 lines — `ReactFiberBatchRegistry-test.js` (657),
`ReactFiberExternalRuntimeCommit-test.js` (891), `ReactFiberExternalRuntimePass-test.js`
(1,025), `ReactFiberRunInBatch-test.js` (929) — plus the untracked
`ReactDOMUseUrgentActStall-test.js` (228, committed in step 0).

### 5.1 Where each family's invariants get re-pinned

| Fork jest family | Invariants it pins | New home |
|---|---|---|
| BatchRegistry-test (657) — dies fork-side | identity creation/laziness, merge-on-lane-reuse, pending edge, backfill line-order repair, close-edge retirement, parking + stale-settlement no-op, retire-exactly-once, reset hygiene | **Package vitest**, driven by a scripted tap driver (a `TapsDouble` analogous to alt-b's `ForkDouble`, fork.ts:102-128, but speaking the raw tap surface: scripted lanes, microtask edges, thenables). Pure TS, runs in ~1s, and both engines' oracle harnesses can fuzz it. |
| Commit-test (891) — splits | per-root commit report, committed-root lock-ins, re-pend refinement, multi-root staggering, report-before-retirement order | Cooked logic → **package vitest** (scripted taps). Raw-fact truth → **fork taps suite**: tap 7 fires post-`markRootFinished` with correct masks (finished expansion captured pre-`markRootFinished`; `rependedLanes = updated \| concurrentlyUpdated`); ordering vs the mutation bracket. |
| Pass-test (1,025) — splits | frame pairing, implicit end on restart, yield/resume alternation, includes at start, mutation window | Pairing/includes → **package vitest**. Raw emission points → **fork taps suite**: tap 4 fires from `prepareFreshStack` after the concurrent queue drains, `NoLanes` reset emits 0, the four yield/resume sites fire (including the raw double-fire cases the package must dedupe). Mutation-window bracket (incl. the `finally` close and View-Transition placement) stays **fork jest** — it has no package logic. |
| RunInBatch-test (929) — mostly stays | lane pin joins the pending batch, nesting save/restore, render-phase throw (605), urgent fallback for `NoLane`, pin does not disturb event bookkeeping | **Fork taps suite** keeps the capability pins against `runInBatch(lane, fn)`; token-level behavior (retired token → urgent fallback; always-execute; the merge window during a retiring commit's report) → **package vitest**. |

Target sizes: fork jest ≈ 900-1,100 (one consolidated taps suite + RunInBatch capability
suite + mutation window + ActStall 228); package vitest ≈ 1,200-1,500 (ported scenario
names — port names first, delete second, so no invariant is silently dropped).

### 5.2 Named tests for the three drift failure modes

The synthesis identified what breaks users if the relocated logic drifts. Each gets a
named test in the new layout, plus the existing RTL pins as end-to-end backstops:

1. **Backfill drift → pending drafts leak into ambient committed state pre-commit.**
   Package vitest `backfill: setState-before-store-write transition survives event close`
   (scripted: tap 1 for a lane with no identity → identity created later in the same
   event → tap 2 with that lane pending → tap 3 must NOT retire). RTL backstops:
   alt-a `real-react.spec.tsx:648` ambient-W0 family; alt-b `react-real.test.tsx:100`
   held-open-rebase and the :588+ ambient family.
2. **Lock-in drift → an urgent pass tears against a root's own DOM.** Package vitest
   `lock-in: root that committed a pending batch keeps including it` and
   `re-pend: mid-render delivery keeps the rendered lane reported + locked in`
   (scripted: two containers, staggered tap 7s, then tap 4 on the committed container
   asserting the include set). RTL backstops: alt-a `real-react.spec.tsx:199`
   (mount-during-transition), :400 (multi-root committed effects); alt-b
   `react-real.test.tsx:147`, :135 (urgent pass excludes the draft).
3. **Parking drift → an async action's writes visible mid-action.** Package vitest
   `parking: store-only action batch retires at settlement, not event close` and
   `parking: stale settlement after reset/lane-reuse no-ops` (scripted thenable on
   tap 3). RTL backstop: alt-b quiescence pin `react-real.test.tsx:814`
   (`__debug.isDirect()`); plus the new raw store-only async-action RTL test added in
   step 1 (a known blind spot — today's RTL suites exercise parking only indirectly).

### 5.3 Oracle/fuzz obligations

Both engines already run oracle-style suites against their fork doubles. New
obligation (CONSTRAINTS rule 5): the package is fuzzed once, centrally — random
interleavings of scripted taps (multi-root, lane reuse, restarts, parked actions,
resets) asserting registry invariants (retire exactly once; report precedes
retirement; includes ⊇ lock-ins for committed roots; no slot leaks after retirement).
During migration soak (step 6), both engines' RTL + oracle suites run against the
package-backed bridges, and a differential harness compares the package's cooked
event stream against the still-installed fork registry's channel events, event for
event, under both engines' full suites.

---

## 6. Migration steps

Gate battery, run green at EVERY step: alt-a full suite incl.
`tests/react/real-react.spec.tsx` + alt-b full suite incl. `test/react-real.test.tsx`
in both gate modes + surviving fork jest + `ReactDOMUseUrgentActStall-test.js` + fork
build + alt-b perf suite unchanged (coarse floors, no steady-state deoptimizations).

- **Step 0 (fixed by owner ruling; before any fork work).**
  - (a) Fix the alt-a bridge probe bug: `isCurrentWriteDeferred` (bridge.ts:156-159)
    is implemented as `unstable_getCurrentWriteBatch() & 1`, which CREATES an urgent
    batch identity on the ambient-read path — a read with a write's side effects,
    called under the engine's explicitly non-side-effecting guard
    (engine.ts:1573-1584, "a read must never mint"). Replace the body with a direct
    read of `internals.T` (non-null, non-gesture ⇒ deferred) via the
    `__CLIENT_INTERNALS…` export — the pattern alt-b already ships side-effect-free
    (react.ts:564-571, :592-598), mirroring the classifier's own transition arm
    (WorkLoop hunk +876: `transition !== null && !transition.gesture`). Add a bridge
    test asserting the identity-creation callback count stays 0 across ambient reads
    while a deferred batch is live. ~±4 lines, zero fork lines.
  - (b) Add the error guard to alt-b's `ReactFork.emit` (react.ts:542-546, currently a
    bare loop): try/catch per listener, collect + report, ~4 lines. Must exist before
    any transport without channel-side isolation carries events.
  - (c) `git add` + commit the untracked
    `vendor/react/packages/react-dom/src/__tests__/ReactDOMUseUrgentActStall-test.js`
    (228 lines; a backup copy sits in this directory). Touches vendor/react.
- **Step 1 — harden gates before moving anything** (adopting the synthesis' blind-spot
  list): add RTL/fork tests for state-before-store backfill, staggered two-root
  commit, raw store-only `startTransition(async …)` parking, deterministic
  yield-gap write, and the mutation bracket's `finally`/View-Transition placement.
  Touches vendor/react (test files only) + both engine test suites.
- **Step 2 — introduce taps BESIDE the registry** (vendor/react): add the nine tap
  call sites, the three pull methods, and the taps module; during this transitional
  window the host object hangs at `internals.E.taps` (the legacy channel object keeps
  owning `E` itself, so nothing existing moves). Registry and channel untouched; new
  fork taps jest suite lands here. Touches WorkLoop + RootScheduler — the highest
  collision risk with the owner's concurrent vendor/react workstream; land as one
  small, reviewed diff.
- **Step 3 — build `react-signals-utils` against the taps**: the registry port, the
  scripted tap driver, the vitest suite (5.1-5.2), and the differential harness
  (package cooked stream vs live channel stream). No consumer switches yet.
- **Step 4 — port the alt-b bridge behind a flag**: `ReactFork` gains a package-backed
  construction path selected by an env flag; alt-b RTL runs in BOTH transports in CI.
  alt-b changes only (react.ts).
- **Step 5 — port the alt-a bridge** the same way (bridge.ts).
- **Step 6 — soak**: both engines package-backed by default; oracle fuzz + full RTL +
  differential comparison for a burn-in window; any divergence is a package bug (the
  fork registry is the oracle here — that is the point of keeping it alive one step
  longer).
- **Step 7 — delete** (vendor/react): `ReactFiberBatchRegistry.js`,
  `ReactExternalRuntime.js`, `ReactFiberExternalRuntime.js` (its ~55 surviving lines
  land in the new taps module), the ReactClient/index exports, `discardAllWip` + noop
  patch + errors 604/606; the reconciler now assigns `internals.E` directly. Bridges
  drop their legacy transport paths and flags; RTL harness reset call sites switch to
  the package's `resetForTest` (react-real.test.tsx:34-55; bridge.ts:187).
- **Step 8 — prune/port fork tests** per section 5 (port scenario names into the
  package suite first, then delete the fork files).

vendor/react collision flag: steps 0c, 1, 2, and 7 touch vendor/react while the
owner's implementation workstream is also active there. Steps 2 and 7 modify
WorkLoop/RootScheduler hunks that other work may also touch — sequence those two
through the owner; steps 0c and 1 are test-file-only and low risk.

---

## 7. Risks and open questions

1. **Lane-layout coupling (accepted by ruling, posture stated).** Lane bitmasks cross
   the boundary by design. The package's actual layout knowledge is deliberately
   minimal: lanes are opaque one-bit values in a 31-bit mask (slot index =
   `31 - clz32(lane)`, mask intersections); deferredness arrives pre-computed in tap
   10's sign bit, so the package never knows WHICH bits are transition lanes. Residual
   exposure: an upstream rebase that changes the 31-lane word size, entanglement
   semantics (`getEntangledLanes`), or `pendingLanes` meaning. Mitigation: bump
   `forkProtocolVersion` on every rebase that touches lane semantics; the package
   asserts exact equality at attach and throws — drift fails loudly at startup, never
   as silent tearing.
2. **Per-update tap cost.** Tap 1 fires per scheduled update (per setState) once any
   batch is live, crossing a JS function boundary where today's code runs an inline
   array-load + null check. The `watchedLanes` gate keeps the no-live-batch case at
   one AND + branch (identical to today's idle profile). The live-batch case is one
   extra indirect call per update. UNVERIFIED: not measured this session; the alt-b
   perf gate in the step battery covers the engine write path but NOT React's
   setState path — add a coarse setState-burst floor to the step-2 gate before
   trusting this.
3. **Timing points without a natural tap today: none found.** Every tap lands on a
   line the fork already occupies (each row of 1.2 names the existing call site it
   replaces); the backfill and close edges were the risky ones and both verify (1.4).
   The one SYNTHESIZED behavior is pass-frame pairing moving from fork sets to package
   state over raw taps 4-7 — semantics-preserving on the current call-site inventory,
   but it is reconstruction, not relocation. Mitigation: the step-6 differential soak
   (fork frame sets still alive) is specifically the gate for pairing drift, and the
   raw double-fire cases get their own fork taps tests (5.1).
4. **Container-vs-FiberRoot keying.** The package keys per-root state by container
   where the registry used FiberRoot objects (2.2). Sound iff container↔root stays
   one-to-one for live roots — the assumption the existing cooked protocol already
   makes for every event both bridges consume. UNVERIFIED edge: `createRoot` twice on
   the same container object (unmount + remount) while a batch from the first root is
   still live; the registry would see two FiberRoots, the package one container. Add a
   package vitest for remount-into-same-container before step 4; if it misbehaves, tap
   1/2/7 can carry an opaque root token alongside the container at ~zero cost.
5. **Thenable retention.** Tap 3 hands the action thenable to userspace; the package
   parks slots on it exactly as the registry does (registry:445-472), and
   self-invalidation plus `resetForTest` scrubbing give the same reclamation story.
   Leak-parity is a hard requirement: the package suite must include the gc-leak
   coverage the engines already run for their own state (both packages ship leak
   suites; the parked-slot case joins them).
6. **Single consumer slot.** One `taps.consumer` means one package instance per
   process; running both engines in one process for a head-to-head harness would need
   two subscribers on the PACKAGE (supported — it has a listener set), not two
   consumers on the fork. Matches today's singleton posture (alt-b throws on double
   registration, react.ts:686-689).
7. **UNVERIFIED items, marked rather than guessed.**
   - alt-a's "accessor layers ≈20% of a tick" (the reason yield/resume stay
     edge-driven rather than polled) is carried from alt-a-fable.md §T7, not
     re-measured; it only reinforces a keep-decision already forced by SYNTHESIS §1.3.
   - alt-b perf ratios (DIRECT vs always-logged) carried from alt-b-fable.md §R1; same
     status.
   - Exact WorkLoop absolute line numbers post-rebase will differ from the hunk
     references used here; the hunks were read in full this session.
   - `enableParallelTransitions` (www-channel sibling-transition entanglement,
     registry:527-531) is covered by the ported include-set logic, but no www-channel
     RTL exists in either engine's suite; the fork Commit-test scenarios covering
     entangled expansion must be among the ported names (5.1), or this edge is pinned
     nowhere.
8. **Open question — should `onBatchOpened` ride the taps instead?** The package
   emits it from `getCurrentWriteBatch` (2.3), which is correct for both engines
   today. If a future consumer needs identity creation React initiates (none exists:
   the fork's fallback-counter path served driverless tests only), the tap surface
   would need an explicit creation callback. Not added now — YAGNI, and the version
   field prices adding it later at one integer bump.

---

*Plan complete. Deliverable of the edge-export design task, 2026-07-08. No code was
changed; sections 1-7 above are the build spec for steps 0-8.*
