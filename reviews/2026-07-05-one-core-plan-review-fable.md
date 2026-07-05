# Adversarial review: One Core convergence plan (2026-07-05)

Reviewer role: break the plan, not improve it. Grounding: the plan
(`plans/2026-07-05-one-core-convergence.md`), engine source
(`packages/cosignal/src/index.ts`, `src/logged.ts`), adapter
(`packages/cosignal-react/src/shim.ts`, `src/hooks.ts`), the oracle contract
(`packages/cosignal-oracle/README.md`, `src/model.ts`), the bindings test
battery (`packages/cosignal-react/tests/*`), the independent review the plan
answers (`reviews/2026-07-05-cosignal-simplification-review.md`), and
react.dev's documented contracts for render-phase `setState`
(react.dev/reference/react/useState) and `use` promise caching
(react.dev/reference/react/use), fetched 2026-07-05.

Provenance: all code citations and line numbers are at HEAD (`3ce4289`,
"plan: One Core convergence"), the state the plan was written against.
Phase 0 checkpoint work was IN FLIGHT in the working tree during this
review (uncommitted edits deleting prototype patching and introducing a
shim-maintained "ambient world" + host op-capture hook) — which confirms
F7's substance: the deleted mechanisms' duties require successor designs
the plan does not state.

Verdict summary: Phase 0 sound-with-amendments; Phase 1 unsound as specified;
Phase 2 unsound as specified; Phase 3 sound-with-amendments (contingent);
Phase 4 sound-with-amendments. Details per finding; verdicts at the end.

---

## F1 — BLOCKER (Phase 1): a discarded render's fn write does NOT vanish; the batch machinery makes it permanent

The plan's central Phase 1 claim: "a pending world folds its own function
version; the committed world folds the committed one; **discard drops the
version with the batch**; rebase re-renders and re-writes. No parallel
versioning channel."

The claim conflates two lifecycles. React discards **passes** (render
attempts); the engine discards nothing — **batches retire**, and retirement is
defined, in both the engine and the oracle contract, as unconditional
persistence:

- `logged.ts` `retireInternal` (~line 2530): "committed=false batches retire
  through this same path — **whether writes persist never depends on who was
  subscribed**."
- oracle README ("Batch and slot lifecycle"): "An abandoned batch (no React
  work ever committed) retires through the same path: **writes never silently
  revert**."

That rule is correct for user data (an event-handler write must not evaporate
because a render was thrown away). It is exactly wrong for a render-phase fn
write, which is speculative **by construction** — it mirrors work-in-progress
hook state, whose entire lifecycle in React is "dies with the discarded
attempt / with the abandoned lanes."

### Walked schedule A (abandon)

1. Component C committed with `useComputed(fn_v1, [1])`; fnAtom's committed
   fold is `{deps:[1], fn_v1}`.
2. A transition renders C with new props → render-phase write
   `w1 = {deps:[2], fn_v2}` into transition batch T (deps differ → not
   droppable). Pass yields.
3. The transition is abandoned (superseded update; its target fiber deleted;
   async action rejected — the protocol emits `onBatchRetired(token,
   committed=false)`, which the shim maps to `retire(mapped, false)`,
   `shim.ts` `handleBatchRetired`). The pass is discarded; **the batch is
   retired, not discarded**.
4. Retirement stamps w1 → w1 is now permanent history visible to EVERY world
   (`visible`, committed clause: `retiredSeq !== undefined → true`).
5. The committed world of C's root now folds fnAtom = `{deps:[2], fn_v2}`.
   Every committed-world evaluation of the stable node — retirement drains
   (`drainCommittedObservers`), `useSignalEffect` reads
   (`shim.effectRead` → `committedValue`), mount fixups — **calls fn_v2**, a
   closure over props React never committed. The drain's value compare sees a
   change → `reconcile-correction` → urgent pre-paint re-render of C, which
   still has OLD props: the frame it produces mixes old-prop DOM with
   new-closure-derived values. `useSignalEffect` observers fire side effects
   on a value derived from a render that never existed. The corruption
   persists until the next committed render of C happens to re-write the atom.

React's contract for the state this write models: render output of a
discarded attempt is thrown away, and updates queued against deleted fibers
are dropped with them. react.dev (useState): "When you call the set function
during render, React will re-render that component immediately … **and the
result will be thrown away**." The engine's receipt machinery has no
"thrown away" mode — that is precisely why the old design recreated nodes in
WIP hook state (hooks.ts useComputed doc: "adopted if the render commits,
dropped if it is discarded" — React's own double-buffered hook state does the
discarding for free).

### Walked schedule A′ (no abandon needed: restart + bail-out)

1. Transition attempt 1 renders C with props P2 → write
   `{deps:[P2], fn_v2}` into T.
2. An interleaved urgent update lands; React discards the attempt and
   restarts T's render. In the restart, the parent's output gives C props
   equal to the CURRENT fiber's props → React **bails out** over C; C never
   re-renders; no healing write.
3. T's restart commits. T locks into the root (`passEnd` lock-in) → the
   committed world's membership clause folds `fn_v2/deps:[P2]` **now**, while
   the committed tree renders from P1 and fn_v1's output.
4. Same corruption as schedule A: drains/effects observe fn_v2-derived
   values; an urgent correction re-render is minted to chase a value the
   committed UI never produced.

So the "stable node" claim (plan risk 2) has its update-path counterexample:
React discards the fiber's attempt while the batch carrying the fn write
survives — via abandon (A) or via restart-plus-bailout (A′). Note the
concurrent-passes variant the plan worries about is structurally impossible
(one open pass per root, one hook instance per component ⇒ two passes can
never race writes to one fnAtom); the killer is **sequential** batches, which
makes it worse — it needs no exotic interleaving.

The fix space is unpleasant for the plan's own principle: receipts that die
with a pass/attempt, or an owner-batch re-write-on-restart obligation the
host must guarantee, are precisely a "parallel versioning channel" with extra
steps — the thing Phase 1 exists to avoid. This needs an owner ruling and an
oracle model of abandon-with-render-writes before any engine code.

## F2 — BLOCKER (Phase 2): node-scoped `ctx.use` slots are shared mutable state across worlds; deleting capsules breaks pinned behavior and leaks pending data into committed frames

The plan: "With stable nodes, the node-scoped `ctx.use` cache (the base
design) satisfies React's documented contract by construction: the consumer
lives across re-renders, so the same Promise instance is reused."

The base slot protocol (`index.ts` `ctxUse`/`suspenseEvalFn`) was designed
for ONE evaluation stream: one `_slots` array per node, "the slot's previous
work wins for the whole attempt," and "a dependency-driven re-evaluation is a
fresh attempt — settled slots are dropped." Under the concurrent engine, one
stable node is evaluated in MANY worlds (pass, committed-per-root, newest,
mountFix), interleaved. A single shared slot array cannot carry per-world
identity; the capsule system's whole reason to exist is that "a world's
identity is carried by the values its replay produced" (`shim.ts` `capsules`
doc). Deleting it re-introduces the cross-world confusion:

### Walked schedule (this is bindings battery **case 15**, currently green)

`battery.spec.tsx` case 15 — "Suspense across worlds: capsule identity by
content, no refetch livelock": a stable `useComputed` (deps `[]`) reads
`q.state` then `ctx.use(() => fetchLike(query))`.

1. Committed world: q='q1' → slot0 = p1; suspends; p1 resolves DATA1; settle
   replay consumes slot0 → committed shows DATA1. (`fetches === 1`.)
2. `startTransition(() => q.set('q2'))` → transition world evaluates the SAME
   node. Dependency-driven fresh attempt → settled slot0 is DROPPED, slot0 =
   p2 = fetch('q2'), pending. (`fetches === 2`.)
3. Mid-transition urgent mount (`root.render(<App two />)`): the committed
   world re-evaluates the node → slot0 holds pending p2 → "previous work wins
   for the whole attempt" → **the committed world suspends on the
   transition's q2 fetch**. The test's pinned expectation
   `text === 'one:DATA1;two:DATA1;'` becomes `'fb;'` — the committed frame
   regresses to a fallback because of a pending transition.
4. When p2 settles, the committed world's next evaluation consumes it →
   committed UI shows **DATA2 beside q='q1'** — pending-world data leaked
   into a committed frame. The shim doc's own line: "a duplicate fetch is
   acceptable; **stale data never is**."

React never faces this case because React hook state is double-buffered per
attempt (current vs work-in-progress fiber); the engine's node is one object
shared by every world. So this is not a parity judgment call the plan can
argue past — react.dev's contract ("Promises passed to `use` must be cached
so the same Promise instance is reused across re-renders"; "React doesn't
preserve state for renders that suspended before mounting… any Promise
created during render is recreated") covers retry-of-a-dying-consumer, which
the plan cites correctly; it says nothing that licenses a **living committed
consumer** being clobbered by a speculative evaluation of the same node.
That's an UNDERSHOOT of the package's own core promise (committed frames
never mix in pending state), not gold-plating removal.

A world-aware slot store (slots keyed per memo plane / per world) is the
obvious repair — and it is a third suspense implementation, i.e. exactly the
"hidden new glue while claiming convergence" failure mode. Pass memo planes
die with the pass (`reclaimAfterPassEnd`), so naive per-pass slots refetch
per attempt and re-open the livelock the capsule doc describes ("node-keyed
capsules would miss on every retry and refetch forever, never settling";
react.dev documents the symptom: "causes React to show the Suspense fallback
repeatedly and prevents content from appearing"). Phase 2 as written deletes
the only mechanism that makes case 15 pass, and offers no replacement design.

## F3 — MAJOR (Phase 1): "attributed to the rendering pass's batch" is ill-defined — a pass renders a SET of batches, and members retire independently

`handlePassStart(container, includedBatches, lineageId)` receives a **list**;
`passStart(rootId, includeTokens)` builds a multi-token mask. Two transitions
started in different events have different protocol tokens and can render in
one pass (entangled lanes). The plan says the fn write is "attributed to the
rendering pass's batch (the host's write-context API says which)" — singular.
Which member?

React's own answer for render-phase setState is to pick an arbitrary lane
from the current render's lanes — sound in React only because a committing
pass commits ALL its renderLanes together. Here the analogous move is
unsound: batches in one mask retire **independently**, each with its own
`committed` flag (`handleBatchRetired` fires per protocol token). Attribute
the fn write to member T1 when the deps change actually rode T2's update, and
T1's abandonment (F1) or early retirement gives the fn version the wrong
lifecycle: it becomes permanent history before/without T2's commit, or dies
in reputation with a batch whose UI did commit. The current protocol's
write-context API (`unstable_getCurrentWriteBatch`, one token + one deferred
bit) has no "on behalf of which included batch am I rendering" answer at all
during a render — the plan asserts a capability the protocol, as described in
`shim.ts`'s handshake and the README, does not have. This is a protocol
revision (React fork work) hiding inside a signals-library phase.

## F4 — MAJOR (Phase 1): the "free" deps cutoff is only free on an empty tape; under any live concurrency the render-phase write appends, walks, and delivers — and render-phase delivery to OTHER components is the thing React documents as an error

The engine's drop rule (`write`, `logged.ts` ~1986): a write may be dropped
**only when the tape is empty** and the op evaluates equal against base —
"once receipts exist, worlds may fold different previous values, so equality
here proves nothing" (oracle README: "Equality dropping is allowed only for a
write that lands on an empty tape"). Consequences for the hook's per-render
`fnAtom.set`:

- While ANY batch holds an un-retired fn receipt (i.e. exactly when the
  concurrent machinery is active), every render/replay/StrictMode-double of
  the component **must append a receipt** even with equal deps: slot intern,
  seq mint, marking walk, and a value-blind `deliveryWalk` that schedules
  re-renders for every watcher downstream of the computed. Stepwise fold
  equality (`foldAtom` keeps the old reference when `equals` says equal)
  neutralizes the VALUE per world, so correctness survives — but "equal deps
  ⇒ the write drops before minting anything — StrictMode double-renders and
  render replays are free" is false in precisely the regime the engine
  exists for. A true fix needs a NEW drop rule (compare the incoming record
  against the **writing batch's own world fold**), which is a second equality
  primitive the plan does not spec and the oracle does not model.
- The delivery story is unspecified. A render-phase write runs the delivery
  walk synchronously in the render stack. Watchers of the same BoundComputed
  in OTHER components (the handle is a value; it flows through props/context)
  get deliveries → `translate` → `unstable_runInBatch(bump)` **during
  render**. The shim's own doc: "The protocol permits scheduling updates from
  its yield and commit callbacks … (writes during render are not, and
  throw)." And react.dev: "Calling the `set` function of *another* component
  during rendering is an error." The carve-out must either suppress/defer the
  walk to pass end (new mechanism, must be modeled) or perform exactly the
  cross-component render-phase update React forbids. Also unaddressed: the
  self-delivery to the writing component's own watcher schedules a redundant
  re-render of the component that just rendered (React avoids this by
  re-rendering inline before children; the plan adopts neither behavior
  explicitly).

## F5 — MAJOR (Phase 0, checkpoint 4): "Behavior must be observably identical (the fuzz corpus proves it)" is false, and the cited review says so

Checkpoint 4 adopts the reviewer's covered-check-as-rule for mount fixup and
claims observational identity. The review it responds to (finding #1) states
the opposite: "Behavior change: **strictly fewer `mount-urgent-correction`
events** (suppressed exactly when covered). **This is a contract change**, so
model and engine co-change, and tests that pin dispositions or
urgent-correction counts need re-pinning" — enumerating oracle battery case 9
variants, flags-5 tests, scars, their engine twins, and trace disposition
tests (`'fast-out' | 'fast-out-covered'` in `trace.ts`/`logged.ts` die).
Today, when the four conjuncts fail spuriously but the divergence is
corrective-covered, an urgent correction FIRES; under the new rule it is
suppressed — an event-stream-visible delta on exactly the schedules FLAGS.md
flag 5 pins. The fuzz corpus cannot "prove identity": model and engine
co-change, so lockstep proves only self-consistency with the NEW contract.
The checkpoint is fine as a contract change; as written ("observably
identical") it instructs the implementer to expect green pins that will be
red, inviting either silent re-pinning without a ruling or a stalled phase.
Also note the review's honest loss: the deleted audit was an in-engine fuzz
oracle (it threw on unsoundness); as the rule it can never fail — one layer
of the verification story goes away and the plan doesn't acknowledge it.

## F6 — MAJOR (Phase 0, checkpoint 3): direct listeners change WHEN the adapter reacts — mid-operation emission is a re-entrancy hazard — and the split streams un-referee the shim

Today the shim is post-hoc: `withBridge` drains `eventsSince(mark)` **after**
the bridge method returns, so every setState-shaped reaction
(`bumpInBatch` → `unstable_runInBatch`) runs against settled bridge state.
Direct callbacks fire at the `log()` sites, i.e. mid-operation:

- mid-`write`: delivery listeners fire before `flushEffectQueue` and before
  `opEnd`;
- mid-`retireInternal`: reconcile-correction listeners fire after stamping
  and draining but **before** per-root row clearing and slot release;
- mid-`passEnd`: mount-corrective/urgent-correction listeners fire between
  lock-in, drains, and fixups.

If a listener's `runInBatch(0, bump)` can flush synchronously (discrete
fallback; or user `flushSync` in a bumped component's render path), React
re-enters the bridge (`passStart`, more writes) while an operation is
half-applied — a state class the engine has never been exercised in; the
whole lockstep corpus drives operations to completion before the next op.
The plan must pin the emission point ("listeners fire at operation end") —
at which point the implementation is a queue of pending notifications, i.e.
a small event log again, just unshared. Second cost: today the referee
compares the exact stream the shim consumes (one source of truth). After the
split, listener emission and log emission are two code paths that can drift;
a listener that fires without a logged twin (or vice versa) is invisible to
the lockstep harness, and the bindings tests assert only React-visible
outcomes. Third cost: `scenarios.spec.tsx` R6/R11 and battery tests assert
`bridge.eventsOfType('mount-corrective')` — under consume-gated allocation
the React harness must arm recording, so the bindings battery permanently
tests a non-production configuration of the very path being changed. And the
trace ruling keeps `tr.event(e)` taking a `BridgeEvent` object at the log
waist — with a tracer attached the one-object-per-write floor returns, so
the "zero events" promise needs its wording scoped to "no consumers."

## F7 — MAJOR (Phase 0, checkpoints 1–2): the deleted mechanisms have duties with no named successor; and the deepest twin (K0/K1, three computed representations) survives the "One Core" name

Checkpoint 1 deletes prototype patching "and its recursion guard";
checkpoint 2 deletes the table arming "and the read/write routing words."
What those mechanisms do today, beyond op capture:

- **Read routing with stack-accurate render detection.** `readState`/
  `routeRead` resolve, per read: bound-eval frame → effect capture → "is the
  current call stack inside a tracked render pass" (via
  `React.unstable_getRenderContext()`, a React API) → kernel. The core cannot
  call React. The successor must be a host-maintained world/render word kept
  accurate across yield/resume/start/end plus effect-capture and eval-frame
  scopes — a real design (correct only if protocol events exactly bracket
  render slices) that appears nowhere in the plan. "Delete the routing
  words" is only coherent as "rename them into core fields"; the check
  itself is irreducible.
- **The recursion guard's job.** The bridge applies folded values to the
  kernel through the public handle (`applyToKernel` → `handle.set`) and
  reads it through `kernelValueOf` (with world-suppression around
  `handle.state`). With capture moved into the core methods, those calls
  re-classify and recurse unless the bridge gets internal unrouted
  apply/read paths. Deletable, but it is new core surface the checkpoint
  doesn't name.
- **Representation unification is blocked by a documented hang.** The engine
  deliberately does NOT host overlay computeds on kernel computed records:
  "stale cross-evaluation links … form kernel link cycles the kernel's
  unwatched-dispose walk cannot traverse (measured as a hang)"
  (`logged.ts` ~1224). So after all phases, `Computed`, `ComputedNode`, and
  `BoundComputed` (or their renamed forms), the K0 and K1 graphs, dual memo
  systems, and the eager-kernel-apply glue all remain — the independent
  review's "twins all the way down" core finding. The plan converges the
  package seams; it should not imply (title, "This plan removes the twins")
  that the in-file engine twins die, or Phase 4's second review will re-file
  the same report.

## F8 — MAJOR (Phase 2): no referee exists for the phase — the oracle deliberately models no thenables

Plan principle 5: "the reference model … models every semantic change
*before* engine code." Oracle README, "What the model deliberately does not
do": "**no Suspense capsules or thenables**." The fuzz corpus, scars, and
invariants are all silent on `ctx.use`; Phase 2's semantics are pinned by
exactly one bindings test (case 15) plus the base-build `suspense.spec.ts`
(single-world only). So the phase with the subtlest cross-world semantics
(F2) is the one phase the project's verification methodology cannot referee.
Either the oracle grows a thenable model first (contradicting its own
minimalism charter — an owner ruling), or Phase 2's "battery green" bar is
one test deep and the plan should say so instead of invoking principle 5.

## F9 — MINOR (Phase 1): ownership is unenforceable below the hook, and the no-pass render branch attributes fn writes to an immortal ambient batch

"Legal only from the owner (dev-checked)": the protocol identifies the
rendering CONTAINER (`unstable_getRenderContext()` → container), never the
component; the engine sees neither. The only real gate is a per-atom
render-writable capability flag plus encapsulation (the fnAtom never
escapes the hook). Fine — but then the dev check can only assert "flagged
atom, write-context is a render on the owning root," which cannot detect a
non-owner and should be documented as such, not as ownership enforcement.
Sharper edge: hooks.ts has a defensive "render outside a tracked pass"
branch (lines ~206–209, unrouted newest read) — it exists because that state
is reachable. A render-phase fn write in that state has no pass batch; it
would classify ambient (`bareWrite`). The ambient token is opened lazily and
**nothing in the React path ever retires it** (`handleBatchRetired` only
maps protocol tokens; grep shows no shim-side ambient retirement), so its
receipts never retire, tapes never fully compact, `quiescent()` never holds
— and now those immortal receipts hold **render closures** (props, elements)
for the life of the process. The carve-out needs an explicit rule for the
no-pass case (throw? drop?), and the ambient-retirement gap deserves a line
in Phase 0 regardless.

## F10 — MINOR (Phase 1): answered — deps-equal-but-different-closure is reachable and matches React's own contract; the one true delta is StrictMode keeping the FIRST closure

The prompt's question: deps shallow-equal while the closure captures
different values. Reachable exactly as with `useMemo` (deps that under-cover
captures); the dropped/fold-neutralized write serves the OLD closure — the
same stale-closure behavior as today's recreation design and as React's
documented `useMemo` contract; not a new break. The real (tiny) parity
delta: StrictMode double-invokes render; React keeps the SECOND invocation's
memo results, while the deps cutoff drops the second write and keeps the
FIRST closure. Both closures are same-render siblings, so this is observable
only through function identity, which the API doesn't expose — but it is a
divergence a future test could trip over; pin it deliberately.

## F11 — MINOR (Phase 0, checkpoint 2): a documented user-facing promise is silently revoked, not just a test

`cosignal` README: "if you import only this entry, your bundle carries zero
concurrency code (a build-isolation test enforces this)." Checkpoint 2
replaces the TEST with a behavioral promise ("mints zero receipts…"), which
is weaker: it is a runtime claim, not a bundle claim. One Core matches
React's posture (React doesn't promise transition-free bundles either), so
this is defensible under the mandate — but it is a README-documented
guarantee dying, and the plan should state the revocation explicitly (it
currently reads as a test swap). The sync-only price also gains a permanent
host-word branch on every public op; Phase 4's table covers the honesty, but
the promise wording in checkpoint 2 should say "zero receipts/tokens/
worlds/events **and the branch is the entire cost**," or the behavioral test
will pass while the bench regresses.

## F12 — MINOR (Phases 0–2): nothing ever unregisters; Phase 1 makes the leak per-hook-instance and F1 makes it closure-shaped

`bridge.nodes`, `nodesArr`, `byKernelId`, `watchersByNode` only grow;
`indexNode` has no inverse; unmount reclaims watchers but never nodes.
Today's useComputed leaks one `ComputedNode` per deps change; Phase 1 leaks
one atom + one node per hook INSTANCE across the app's lifetime of mounts
(better rate, same unboundedness), and with F1 the retired fn receipts fold
render closures into `atom.base`, retained by the bridge's strong maps even
after the component is gone. The plan claims "surviving subscriptions/caches"
as strictly better; without an unmount/reclaim story it is also strictly
more retained memory. Phase 3's "anything engine-shaped … migrates down or
dies" should name node reclamation explicitly.

## F13 — NOTE (kept ruling collides with One Core): `AtomOptions.effect` is dead in the flagship path the convergence makes the only path

The observed-lifecycle option fires on K0 first-subscriber transitions
(`linkInsert` D1). React watchers subscribe in K1/watcher tables; an atom
observed only via `useSignal` never flips the K0 bit, so the effect never
fires (independent review #9's blind spot). Pre-merge this was a base-build
feature with a logged caveat; post-merge there is one build and the caveat
is the behavior. Keeping it "by explicit ruling (orthogonal)" ships a
documented remote-subscription feature that is inert in the primary
deployment of the ONE core. Either bridge-level lifecycle lands with Phase 3
or the option's doc must carry the blind spot.

## F14 — NOTE (Phases 0/4): benchmark-integrity tripwires the merge can silently trip

- Const enums inline only same-file under esbuild-based toolchains
  (documented in `index.ts` ~line 275, measured +15–21% when demoted).
  Merging `logged.ts` into the entry (or splitting the merged core
  differently) moves `OpKind`/`SlotBits`/`RegBit`/`NodeField` consumers
  across file boundaries at your peril; the merge plan should pin file
  placement.
- The POISON fold-purity mechanism is the operation TABLE swap; checkpoint 2
  deletes the twin-factory arming but must keep the table + swap, or fold
  purity becomes the per-op flag check the design measurably avoids
  (`index.ts` POISON doc).
- Phase 4 benches "One Core vs the old base entry" — the old entry no longer
  exists; the baseline must come from a pinned git ref, and `bench/*.mjs`
  import the engine by absolute machine path (review smell), so the
  comparison is currently reproducible on exactly one machine.

## F15 — NOTE (Phase 1): the oracle extension is real vocabulary work, not just a new op

The model has no writes attributable to an open pass, no per-op ownership,
no world-relative drop, and its computeds have fixed functions. Modeling
Phase 1 means: fnAtoms as ordinary atoms read by derived definitions (fits
the model's recompute-everything charter), a new ScheduleOp with legality
("apply returns 'skipped' iff illegal — legality must match the model's"),
generator weights for it, and the write-kind coercion tables that exist
TWICE by design (`schedule.ts` ~99–107 and `tests/oracle-adapter.ts`
~96–104) co-updated. Also: F1's abandon semantics must be modeled and FUZZED
before the engine carve-out — the plan's order-of-work says this; the plan's
semantics (F1) mean the model will formalize the wrong behavior unless the
ruling happens first.

---

## Per-phase verdicts

- **Phase 0 — sound-with-amendments.** Checkpoints 1–3 are the right
  deletions with three unstated obligations: a successor design for
  stack-accurate read routing + unrouted bridge apply (F7), a pinned
  emission point and referee story for direct listeners (F6), and honest
  wording for the revoked bundle promise (F11). Checkpoint 4 must be
  re-labeled a contract change with the re-pin list from the review it
  cites; its "observably identical" claim is false (F5).
- **Phase 1 — unsound as specified.** The load-bearing sentence ("discard
  drops the version with the batch") is contradicted by the batch
  machinery's defining property (retired writes never revert, committed or
  not) — walked schedules A/A′ (F1) produce permanent committed-world
  corruption from discarded renders. Batch attribution is ill-defined for
  multi-batch masks (F3), and the dedup/delivery story needs primitives the
  plan doesn't spec (F4). The phase needs a redesigned discard story
  (speculative receipts, owner-batch rewrite obligations, or pass-scoped
  writes) and an owner ruling before the oracle models anything.
- **Phase 2 — unsound as specified.** Node-scoped slots shared across worlds
  regress pinned battery case 15 and leak pending data into committed frames
  (F2); the parity argument covers dying consumers, not living ones; and no
  referee exists for the phase (F8). Needs a world-aware cache design (which
  the plan must then admit is a suspense implementation, not a deletion) or
  an explicit owner-ruled behavioral regression with test re-pins.
- **Phase 3 — sound-with-amendments.** Contingent on 0–2; the host contract
  must additionally name the render/world word, the unrouted apply, node
  reclamation (F12), and the lifecycle-option decision (F13). The exit
  criterion (documented host-agnostic protocol) is good.
- **Phase 4 — sound-with-amendments.** Add: pinned git-ref baseline,
  portable bench imports, const-enum/POISON placement checks (F14), and an
  explicit README diff for every promise the merge revokes (F11).

## Overall assessment

The convergence direction is right and Phase 0 is mostly executable
grunt-work with known nets — but the plan's two novel claims both fail on
walked schedules, and for the same root cause: the machinery being reused
was designed with lifecycle semantics chosen for USER DATA evaluated by a
disciplined driver (writes are truth and never revert; one evaluation stream
per node), and the plan re-purposes it for SPECULATIVE RENDER ARTIFACTS
evaluated in many worlds (fn versions that must die with discarded attempts;
suspense state that must not bleed between a committed and a pending
evaluation of one node). "The function is state" and "the node-scoped cache
satisfies the contract by construction" are each one sentence in the plan
and each conceal a semantic redesign: receipts with a discard story, and a
world-keyed use-cache. Until those two designs exist — modeled in the oracle
first, per the plan's own principle 5, which Phase 2 currently cannot even
invoke — Phases 1 and 2 are not implementable as written, and the honest
convergence claim is "One Package, One Adapter, twins retained inside the
engine" (F7). Phase 0 can and should proceed with the F5/F6/F7/F11
amendments; everything after it needs owner rulings on F1 and F2 first.
