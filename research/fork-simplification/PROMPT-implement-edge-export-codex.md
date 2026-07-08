# Implement the edge-export React fork (brief for the implementing agent)

You are implementing a planned simplification of this repo's React fork. The full
design is `research/fork-simplification/PLAN-edge-export.md` (599 lines, all
file:line citations verified against this tree); this brief is the work order.
Read the plan's section when a step references it — do not re-derive the design.

## Mission in one paragraph

We maintain a fork of React (`vendor/react`, branch `cosignal-fork`, currently
+~5,000 lines over upstream `e71a6393e6`) whose only job is letting an external
signals engine cooperate with concurrent rendering. Two engines consume it:
`packages/cosignals-alt-a` (bridge: `src/react/bridge.ts`) and
`packages/cosignals-alt-b` (bridge: `src/react.ts`). Today the fork contains a
564-line batch registry (batch identity, merging, backfill, per-root commit
lock-ins, async-action parking), a 334-line generic event channel, and public
`unstable_*` exports. After this work the fork exposes only **raw facts and raw
capabilities, in React's own vocabulary (lanes, containers, thenables), on a
private object — ~230 product lines, zero public exports** — and all cooked
logic lives ONCE in a new shared package, `packages/react-signals-utils`,
consumed by both bridges. Owner rulings behind this are in
`research/fork-simplification/CONSTRAINTS.md` (all five rules are binding).

## Already done (do not redo)

- alt-a bridge probe made side-effect-free (parent commits `0183c31`, `84420cd`).
- alt-b `ReactFork.emit` error guard + `listenerErrors` (parent commit `1fd4fa6`).
- `ReactDOMUseUrgentActStall-test.js` committed in the fork (`702772f472`) and
  pushed; parent pointer bumped (`d5c01b7`).

## Ground rules

- **Never leak.** Any leak is a bug, at any bound. Package state must have total
  reclamation: WeakMap-keyed per-container state, slot sets cleared at
  retirement, parked settlements self-invalidate, `resetForTest()`/`dispose()`
  scrub everything. Leak coverage (heap plateau under `--expose-gc`, counter
  balance) is a required test family for the new package.
- **Vocabulary: say "create", never "mint"** — in code, comments, tests, docs.
- **New-package docs are npm-standalone**: no research-doc jargon, no "§" refs
  to files outside the package; explain concepts in place.
- **Comments state engineering rationale** (why the code must be this way), not
  benchmark rationale and not change-narration.
- **Both engines' full suites green at every step** (gate battery below). The
  engines' kernels (`engine.ts` both sides) must not change; only bridges.
- **The fork is Flow, not TypeScript** — fork-side types are Flow; the
  TypeScript below is the normative shape.
- **Monorepo submodule rule**: a commit inside `vendor/react` is followed by a
  parent-repo pointer bump in the same work unit.
- The branch modifies `ReactFiberWorkLoop.js` / `ReactFiberRootScheduler.js`,
  which the repo owner may concurrently edit — rebase onto the fork branch tip
  before merging and flag any conflict to the owner rather than resolving it
  silently.

## The protocol: the complete surface the cleaned-up fork exposes

Zero public exports. The reconciler creates one host object at module
evaluation and assigns it to `ReactSharedInternals.E` — reachable from userspace
via React's existing `__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE`
export (alt-b already reads this object today for its transition probes).

```ts
/** One bit of React's 31-bit lane word. Opaque to the package except as a
 * set member: slot index = 31 - Math.clz32(lane). */
type Lane = number;
/** Bitmask of lanes. The package only intersects/unions these. */
type Lanes = number;

/** The host object at ReactSharedInternals.E (fork side: Flow, one new module
 * `react-reconciler/src/ReactFiberSignalsTaps.js`, ~55 lines). */
interface ReactSignalsTaps {
	/** Handshake. The consumer asserts EXACT equality at attach and throws on
	 * mismatch, so a rebase that changes lane semantics fails loudly at
	 * startup, never as silent tearing. Starts at 1; bump on every fork
	 * rebase that touches lane semantics or tap timing. */
	readonly forkProtocolVersion: 1;

	/** Single consumer slot, written by the shared package (which throws if it
	 * finds the slot already taken). All nine callbacks fire only while
	 * non-null. */
	consumer: TapConsumer | null;

	/** Filter mask, WRITTEN by the consumer, READ by the fork's hottest taps:
	 * the union of lanes currently holding live batch identities. The
	 * consumer sets a lane's bit when it creates a batch identity on that
	 * lane and clears it at retirement/reset. Keeps the per-setState tap
	 * (onRootUpdated) at one AND + branch while no batch is live. */
	watchedLanes: Lanes;

	/** Classify a write issued right now, WITHOUT creating anything.
	 * Packing: lanes occupy bits 0-30, so bit 31 carries deferredness —
	 * `lane | SIGN_BIT` when the write would join a deferred (transition)
	 * batch; the result is negative exactly when deferred. Unpack:
	 * `lane = value & 0x7fffffff; deferred = value < 0`. Returns 0 only if
	 * no renderer has loaded. Fork side this is today's classification
	 * cascade (render-phase arm → transition arm → event-priority arm) plus
	 * an `ensureScheduleIsScheduled()` call so every write that leads the
	 * package to create a batch identity is guaranteed a later
	 * onEventClosed. The old getOrCreateBatchId call is GONE — identity
	 * creation is the package's job. */
	getCurrentWriteLane(): number;

	/** Non-null exactly while render code executes on this thread.
	 * `container` is the root's container object (`root.containerInfo`) —
	 * the same identity every existing protocol event uses. */
	getRenderContext(): { container: unknown } | null;

	/** THE keystone (CONSTRAINTS rule 2): run `fn` so updates scheduled
	 * inside it join the batch living on `lane` (transition-lane pin via the
	 * RootScheduler override — mechanics unchanged from today's
	 * runInBatchImpl). `lane === 0` (NoLane) requests the documented urgent
	 * fallback: `fn` runs at discrete event priority outside any transition.
	 * Keeps: the render-phase throw (error 605), unconditional save/restore
	 * of priority + transition + pin (nesting composes). DELETED vs today:
	 * the batch-id → lane slot lookup (the caller supplies the lane) and the
	 * live-urgent branch (verified dead: both engines call this only for
	 * deferred batches). */
	runInBatch<R>(lane: Lane, fn: () => R): R;
}

/** The nine callbacks, fired at reconciler edges. Every callback site in the
 * fork replaces an EXISTING registry/notify call site — no new reconciler
 * edges are invented (PLAN §1.2 table maps each to its exact line). */
interface TapConsumer {
	/** From the markRootUpdated wrapper in ReactFiberWorkLoop.
	 * Gated: fires only when `(updatedLanes & watchedLanes) !== 0`.
	 * Feeds the pending edge: the package records `container` in each live
	 * batch root set — retirement truth for both engines. */
	onRootUpdated(container: unknown, updatedLanes: Lanes): void;

	/** From processRootScheduleInMicrotask's per-root loop, at the exact
	 * line batchRegistryBackfillRoot(root) occupies today — strictly before
	 * onEventClosed in the same microtask, preserving backfill ordering
	 * (PLAN §1.4: verified, no timing approximation needed).
	 * Gated: `(pendingLanes & watchedLanes) !== 0`. */
	onScheduledRootPending(container: unknown, pendingLanes: Lanes): void;

	/** From the end of processRootScheduleInMicrotask (today's
	 * batchRegistryOnEventClosed line). Args read at the call site from
	 * peekEntangledActionLane()/peekEntangledActionThenable(). Carries
	 * everything async-action parking needs (PLAN §1.5).
	 * Gated: `watchedLanes !== 0`. */
	onEventClosed(actionLane: Lane, actionThenable: PromiseLike<void> | null): void;

	/** From prepareFreshStack after finishQueueingConcurrentUpdates (today's
	 * notifyRenderPassStart site). `entangledRenderLanes` is
	 * `lanes !== NoLanes ? getEntangledLanes(root, lanes) : NoLanes`;
	 * NoLanes means "stack reset without new work" — the discard signal.
	 * The package derives: frame open, implicit end of any prior frame on
	 * this container, the render-time entangled stash the commit edge needs,
	 * and the include set for the pass. */
	onRenderPassStart(container: unknown, entangledRenderLanes: Lanes): void;

	/** RAW yield edge, 2 sites (renderRootSync incomplete exit,
	 * renderRootConcurrent yield exit). May fire when the frame already
	 * yielded — the package's per-frame `yielded` flag dedupes (the guard
	 * that lives in ReactFiberExternalRuntime today). */
	onRenderPassYield(container: unknown): void;

	/** RAW resume edge, 2 sites (renderRootSync continuation,
	 * renderRootConcurrent re-entry). Also fires for a just-prepared stack
	 * that never yielded; package filters via the yielded flag. */
	onRenderPassResume(container: unknown): void;

	/** From commitRoot, AFTER markRootFinished, replacing both of today's
	 * notifyRenderPassCommitted and batchRegistryOnRootFinished calls.
	 * `finishedEntangledLanes` is captured BEFORE markRootFinished clears
	 * entanglement bookkeeping; `rependedLanes = updatedLanes |
	 * concurrentlyUpdatedLanes` (both computed exactly as the fork does
	 * today); `remainingLanes = root.pendingLanes` at that moment. The
	 * package derives, in order: frame close (committed) → per-root commit
	 * report → re-pend refinement + committed-root lock-ins → retirements. */
	onRootCommitted(
		container: unknown,
		finishedEntangledLanes: Lanes,
		remainingLanes: Lanes,
		rependedLanes: Lanes,
	): void;

	/** DOM mutation window (CONSTRAINTS rule 1 — REQUIRED, direct consumer
	 * callbacks, no generic dispatch). Open edge: from flushMutationEffects
	 * before commitMutationEffects. */
	onBeforeMutation(container: unknown): void;

	/** Close edge, in the same function's `finally` so a mutation-phase
	 * error cannot leave a userspace MutationObserver disconnected. */
	onAfterMutation(container: unknown): void;
}
```

## The shared package `packages/react-signals-utils`

New workspace package (TypeScript, strict, tabs, vitest — match the alt
packages' config). Its public API is the cooked surface both bridges consume
today, so porting them is mostly deleting their duplicated plumbing:

```ts
export type BatchToken = number; // (serial << 1) | deferredBit; bit 0 = deferred; 0 = "no batch"

export type RegistryListener = {
	onBatchOpened?(token: BatchToken): void; // identity created (alt-b's DIRECT→LOGGED gate edge)
	onRenderPassStart?(container: unknown, includedTokens: readonly BatchToken[]): void;
	onRenderPassYield?(container: unknown): void;
	onRenderPassResume?(container: unknown): void;
	onRenderPassEnd?(container: unknown): void;
	onRootCommitted?(container: unknown, committedTokens: readonly BatchToken[]): void;
	onBatchRetired?(token: BatchToken, committed: boolean): void;
	onBeforeMutation?(container: unknown): void;
	onAfterMutation?(container: unknown): void;
};

export class ReactBatchRegistry {
	/** Locates ReactSharedInternals.E via React's client-internals export,
	 * asserts forkProtocolVersion === 1 (throws on stock React or drift),
	 * throws if taps.consumer is already installed. */
	constructor(react: typeof import('react'));
	subscribe(l: RegistryListener): () => void; // error-guarded emit: per-listener try/catch, collected + reported, never rethrown into React
	getCurrentWriteBatch(): BatchToken; // classify via taps.getCurrentWriteLane(), then create-or-reuse identity; emits onBatchOpened synchronously on create
	getRenderContext(): { container: unknown } | null;
	runInBatch<R>(token: BatchToken, fn: () => R): R; // token→lane; retired/unknown token → taps.runInBatch(0, fn) urgent fallback; ALWAYS executes fn
	liveTokens(): BatchToken[];
	isBatchLive(token: BatchToken): boolean;
	resetForTest(): void; // replaces the fork-side reset; there is no fork state left to scrub
	dispose(): void; // uninstalls consumer, clears watchedLanes and all state
}
```

State, identity-creation flow, container keying (by `container`, with the
remount-into-same-container caveat), and the ported registry logic are
specified in PLAN §2.2–2.4 and §1.6 (the behavior-by-behavior reconstruction
table — every row cites the registry lines to port and the engine lines that
consume the behavior). Port `ReactFiberBatchRegistry.js` logic **surgically,
not rewritten**: the shipping code is proven by 657 lines of tests and two
past seam bugs lived exactly in these edges. Size target ~600 lines including
npm-standalone docs.

## The work: one hardening commit, then one branch, merged when green

No feature flags, no dual-transport CI, no soak window: both consumers live in
this monorepo, so the cutover is atomic and the rollback is `git revert`. This
supersedes PLAN §6's staged migration; PLAN §1–5 and §7 remain normative for
WHAT to build. Intermediate branch commits should each build and pass the
suites that exist at that commit, but no commit needs old and new transports
working side by side.

**Gate battery** (the merge gate; also run it as you go): alt-a full suite
(`packages/cosignals-alt-a`: `pnpm typecheck && pnpm test`), alt-b full suite
(same commands), surviving fork jest, fork build (`fork/build-react.sh`), and
the setState-burst floor (below).

1. **On main first: harden the blind spots.** Add the missing tests: RTL
   state-before-store backfill; staggered two-root commit; a RAW store-only
   `startTransition(async …)` parking scenario (today's RTL suites exercise
   parking only indirectly); deterministic yield-gap write; mutation bracket
   `finally` placement. Fork test files + both engines' test dirs only.
2. **Branch: everything else**, as a reviewable commit sequence —
   - **Taps** (`vendor/react`): add `ReactFiberSignalsTaps.js`, the nine call
     sites, the three pull methods; fork taps jest suite (raw emission points,
     mask capture correctness, yield/resume double-fire cases). Measure the
     setState-burst floor here (React-only updates, no live batches): PLAN
     §7.2 flags the per-update tap cost as the one unmeasured number — the
     watchedLanes gate must keep today's idle profile.
   - **Package**: build `react-signals-utils` — the registry port, a scripted
     `TapsDouble` driver (model on alt-b's `ForkDouble`,
     `packages/cosignals-alt-b/src/fork.ts:102-128`, speaking the raw tap
     surface), the vitest suite (port fork-jest scenario NAMES first — PLAN
     §5.1 maps each family to its new home — then the three named drift tests
     of PLAN §5.2: backfill leak, lock-in tear, parking mid-action
     visibility), package fuzz (random tap interleavings asserting: retire
     exactly once, report precedes retirement, includes ⊇ lock-ins, no slot
     leaks), leak tests, and the remount-into-same-container test (PLAN §7.4;
     if container keying misbehaves, add an opaque root token to the
     onRootUpdated/onScheduledRootPending/onRootCommitted taps rather than
     switching keys). While the registry is still alive in these commits you
     MAY use it as a comparison oracle in a dev-time test if a behavior is
     hard to pin — that is a debugging aid, not a shipped mode.
   - **Cut both bridges over** — just change the code. alt-b's `ReactFork`
     drops its live map, serial, allocator registration, pass-container
     filtering, fan-out (≈ −80 lines); keeps ambient-token probes,
     `hasOpenWork`'s transition-slot arm, startTransition token capture,
     entangleLog. alt-a's bridge drops its allocator and pass-pairing defense
     (≈ −30); keeps the ForkAdapter shaping and the side-effect-free deferred
     probe. Engines (`engine.ts`) untouched on both sides.
   - **Delete** (`vendor/react`): `ReactFiberBatchRegistry.js`,
     `ReactExternalRuntime.js`, `ReactFiberExternalRuntime.js` (its ~55
     surviving lines land in the taps module, which now owns `internals.E`
     directly), the ReactClient/index `unstable_*` exports, `discardAllWip` +
     noop-renderer patch + errors 604/606; both RTL harnesses switch reset
     call sites to the package's `resetForTest()`. Target: fork ≈230 product
     lines, ≈175 in upstream-owned files (PLAN §3 has the file-by-file
     budget).
   - **Prune fork tests** per PLAN §5.1 (port names first, delete second;
     keep the runInBatch capability suite, the mutation-window suite, the
     taps suite, and the act-stall pin — target ≈900–1,100 fork jest lines).
3. **Merge when the full battery is green.** Commit the fork branch, push it,
   bump the parent submodule pointer, and land the parent branch — same work
   unit (monorepo rule above).

## Acceptance criteria

- Fork product diff vs upstream ≈230 (±30) lines; upstream-owned files ≈175;
  zero public export additions; `git -C vendor/react diff e71a6393e6..HEAD --stat -- packages`
  is the measure.
- Both engines: full suites green, zero engine (`engine.ts`) changes.
- Package: every PLAN §1.6 behavior has a test; the three drift scenarios are
  named tests; fuzz + leak families pass. Pass-frame pairing is the one
  RECONSTRUCTED (not relocated) behavior (PLAN §7.3) — its raw double-fire
  cases and pairing tests must exist before the deletion commit.
- Perf: setState-burst floor at parity with pre-tap baseline; both engines'
  existing coarse perf gates unchanged (no steady-state deoptimizations).
- Every claim of "unconsumed, safe to delete" carries a citation into both
  bridges' runtime types (the plan already lists them — verify they still hold
  at implementation time).
