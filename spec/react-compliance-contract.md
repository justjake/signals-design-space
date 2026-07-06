# The React Compliance Contract

**What a signals library must do to be correct under React's concurrent
rendering.** Drafted 2026-07-05.

## 1. Purpose and status

This document is the behavioral contract a signals library must satisfy
to be correct under React's concurrent rendering. It exists so that
future designs are evaluated against a fixed spec instead of inventing
semantics ad hoc: every requirement here is **mechanism-free** — it
states what must be observable, never how to build it. No requirement
statement names receipts, worlds, tapes, slots, kernels, or any other
implementation device of the current engine; a completely different
data-oriented design that satisfies every line of section 3 and stays
inside section 4's boundaries is, by definition, compliant.

Standing of this document relative to the other artifacts:

- **Executable form:** `packages/cosignal-oracle` — the reference model.
  The oracle is a deliberately simple, obviously-correct implementation
  of this contract plus the lockstep diff harness that referees any
  engine against it. Where this document and the oracle disagree, that
  is a bug in one of them and requires an owner ruling; neither silently
  wins.
- **Worked examples:** the 17-case correctness battery
  (`packages/cosignal-oracle/tests/battery.spec.ts`, mirrored at React
  level in `packages/cosignal-react/tests/battery.spec.tsx`). Case
  numbers are stable identifiers shared across suites.
- **Host ground truth:** the patched React build ("the fork", branch
  `cosignal-fork` in `vendor/react`) and its pinning tests, reported in
  `fork/S2-REPORT.md`, `fork/S3-REPORT.md`, `fork/S4-REPORT.md`. Fork
  test numbers below use the fork spec's §4.4 numbering as reported
  there.

Why this document has to exist at all: React documents almost none of
this. react.dev states, on the Suspense page: "Suspense-enabled data
fetching without the use of an opinionated framework is not yet
supported. The requirements for implementing a Suspense-enabled data
source are unstable and undocumented." [react.dev: Suspense]. The same
is true of render-pass lifecycle, per-root commit reporting, and batch
retirement — React exposes none of it. So most of this contract was
established **empirically**, by patching React to emit its internal
lifecycle (the fork) and pinning what current-generation React actually
does, with react.dev quotes used where React does document a rule.

### 1.1 Provenance tags

Every requirement line carries at least one provenance tag:

- `[react.dev: <page>]` — React's own documented contract; quoted
  verbatim in this document where load-bearing (all quotes fetched
  2026-07-05).
- `[fork test N]` — an existence proof pinned against the patched React
  build (fork spec §4.4 numbering; see the S2–S4 reports).
- `[battery case N]` / `[battery case N (React)]` — a worked example in
  the oracle's 17-case battery, or its React-level mirror in
  `cosignal-react/tests/battery.spec.tsx`; `[scenario RN]` names the
  React-level concurrency scenarios in
  `cosignal-react/tests/scenarios.spec.tsx`.
- `[ruling YYYY-MM-DD: <name>]` — an owner decision recorded in
  `plans/2026-07-05-one-core-convergence.md` (the amendment header
  records the rulings) or in the reviews it cites
  (`reviews/2026-07-05-*.md`).
- `[oracle: <section>]` — the reference model's stated contract
  (`packages/cosignal-oracle/README.md`), for shipped semantics the
  fork/battery pin only indirectly.

### 1.2 Terms (define before use; host-level vocabulary only)

- **Batch** — the group of state writes belonging to one UI update: one
  event handler, one transition, one async action. React schedules each
  batch at a single priority ("lane"). A batch is **deferred** if it
  renders at transition (background) priority, **urgent** otherwise.
- **Render pass** — one attempt by React to render one root. It may
  **yield** (pause) and resume any number of times; it ends exactly once,
  in a **commit** (its output reaches the screen) or a **discard**.
- **Included batches** — the set of batches whose writes a given pass is
  rendering. A pass may include several batches (React entangles lanes).
- **Root** — one independently rendered React tree. Commits are per
  root; each root has its own committed state.
- **Committed state (of a root)** — the state the root's on-screen UI
  reflects: everything permanently written, plus the writes of batches
  that root has committed UI from.
- **Newest state** — every write applied, pending or not.
- **Retirement** — the end of a batch's life, exactly once, with a
  disposition: committed (its writes are already, or now become,
  permanent) or abandoned (no React work will ever commit from it — but
  see CR3: its data still persists).
- **Parked batch** — a batch backing an async action, kept pending until
  the action's promise settles.
- **Consumer** — one subscribed observer of library state: a component
  instance, a derived value, or an effect.
- **Delivery** — the notification that schedules a consumer to
  re-render/re-run after a write.
- **Mount window** — the gap between a component's render and the
  activation of its subscription at commit.

## 2. The four state lifetimes

**The classification rule: every new feature must classify each piece of
state it introduces into exactly one of these four lifetimes BEFORE any
data structure is chosen.** The adversarial reviews of 2026-07-05 found
that every design failure in this project's history was a lifetime
misclassification — state filed under machinery built for a different
lifetime (the codex review's closing diagnosis: the failed plan
"conflates four lifetimes that React keeps distinct"). The lifetimes,
and what each demands:

### L1 — COMMITTED state

Permanent application data. **Writes never silently revert** — not on
render discard, not on batch abandonment, not on subscriber absence.
Even a batch abandoned before any rendering commits its data (CR3,
battery case 12): persistence never depends on who was subscribed.
This is the lifetime of user data written through the library's public
write surface. Anything filed here must survive everything.

### L2 — PENDING-BATCH state

State scoped to one batch's life: it survives render yields, restarts,
and rebases (the batch outlives any individual render attempt), and it
**dies-or-commits with the batch** — exactly one retirement, one
disposition. This is the lifetime of a pending transition's writes and
of the bookkeeping that keeps them visible-together-or-not-at-all.
A batch is NOT a render attempt: React discards passes freely while the
batch lives on (fork `discardAllWip` keeps batches live and re-renders
them fresh; fork S3).

### L3 — PER-ATTEMPT RENDER state

State scoped to one render attempt of one component: hook state minted
during an uncommitted render, render output, anything derived during a
speculative pass. **React discards this freely and without notice** —
on restarts, on urgent interruption, on Suspense before first mount, on
StrictMode double-invocation. React's own documented handling: "React
will discard its output and immediately attempt to render it again"
[react.dev: useState]; "React does not preserve any state for renders
that got suspended before they were able to mount for the first time"
[react.dev: Suspense]. React clears aborted render-phase updates on
unwind. Anything filed here must be re-creatable from scratch at any
moment and must never leak into L1 or L2 machinery — the moment it
does, a discarded render becomes permanent history (incident I1).

### L4 — RESOURCE state

Cached answers to requests: **keyed by what was asked, indifferent to
who asked**. A resource entry is monotone (pending → settled, never
mutated afterward), so sharing one entry across concurrent views is
safe exactly when the key carries every input that varies the request —
two views asking different questions have different keys and never
collide. This is the lifetime of Suspense request caches. Filing
resource state per-consumer or per-attempt (positional slots) makes
concurrent views clobber each other (incident I2); filing it per-batch
makes settled data die with a transition.

### 2.1 The incident ledger (why the rule exists)

Each incident below shipped in a design or plan, was caught by review
or audit — never by luck — and is a lifetime misclassification. New
features repeat these unless classified first.

- **I1 — function versions filed as batch-lifetime (L3 filed as L2).
  FAILED.** The "stable node" `useComputed` design routed the hook's
  per-render evaluation function through batch-scoped write machinery.
  But batches retire with unconditional persistence (L1/L2 semantics:
  writes never revert), while a render-phase function version is
  speculative by construction (L3): both 2026-07-05 reviews walked
  schedules where a discarded render's closure became permanently
  visible to committed consumers — side effects firing on values
  "derived from a render that never existed"
  (reviews/2026-07-05-one-core-plan-review-fable.md F1; codex findings
  1/5/6). Owner ruling: Phase 1 DROPPED — `useComputed` keeps deps-keyed
  node recreation, delegating function-version lifecycle to React's own
  render-artifact machinery (hook state), which already implements L3
  [ruling 2026-07-05]. The same misclassification had already failed
  once before in the pre-oracle era: the "staged evaluator" designs
  (regression schedules S28/S32/S34/S40) versioned functions beside the
  write machinery and were removed wholesale.
- **I2 — suspense requests filed per-node positional (L4 filed as L3).
  FAILED.** The base `ctx.use` kept one positional slot array per
  computed node ("the slot's previous work wins for the whole attempt")
  — one evaluation stream assumed. Under concurrency one node evaluates
  in many views; a single positional slot cannot carry per-view
  identity: a pending fetch for a transition's query captured the
  committed view too (committed frame suspends on — then shows — data
  the user's committed query never asked for; fable F2, codex finding
  7). Owner ruling: resource identity is per KEY; `ctx.use(key,
  factory)` keeps a per-key map on the living node, and the bare
  positional-factory form is DELETED [ruling 2026-07-05]. Pinned by the
  cross-key test in battery case 15 (React).
- **I3 — observation liveness wired to one store (a union property
  filed as single-consumer-kind state). FAILED.** The atom
  observed-lifecycle callback (`AtomOptions.effect`) fired on the plain
  library's first-subscriber transition only; an atom observed
  exclusively by React components never triggered it — a documented
  remote-subscription feature inert in the flagship deployment (fable
  F13; independent review #9). Owner ruling: liveness is defined over
  the union of ALL consumer kinds — one observation state, observe
  exactly once, clean up when the last consumer of every kind is gone
  [ruling 2026-07-05: the union fix]; shipped as the documented
  `AtomOptions.effect` contract (cosignal README, `observe-union`
  spec).
- **I4 — ambient batch with no committed-transition rule (L1 filed as
  L2). FAILED.** Writes outside any UI context were filed into a
  lazily-opened ambient batch that nothing ever retired: immortal
  pending state, tapes that never fully compact, quiescence never
  reached — and every plain synchronous write paid full recording cost
  despite no transition existing (fable F9; codex finding 13). Owner
  ruling: while nothing is pending, a write IS committed state the
  moment it lands — it folds directly into permanent history with no
  pending representation at all [ruling 2026-07-05: quiet-mode
  criterion; plan Phase 1b]. Pending-batch machinery may hold only
  state that has a retirement.

The pattern across all four: **choose the lifetime first; the data
structure follows.** L1 machinery must never hold L3 state (I1), L4
state is keyed by request, not by consumer (I2), a property of the
whole consumer set cannot live in one consumer kind (I3), and state
with no retirement event must not enter machinery whose correctness
depends on retirement (I4).

## 3. The requirements

Requirement lines are MUST (the library is incorrect without it), MAY
(explicitly permitted; a design need not fight to prevent it), or
WON'T-PROMISE (deliberately outside the contract; the full list with
rationale is section 4). Identifiers are stable: cite them as
`RCC-RT1`, etc.

### 3.1 Reads and tearing

- **RT1 (MUST).** A render pass observes exactly one frozen,
  self-consistent view of state for its entire life: the committed
  state of its root as of the moment the pass started, plus the write
  sets of exactly its included batches up to that same moment. The view
  does not move across yields, time slices, or resumption — a paused
  and resumed render answers every read identically before and after
  the pause. [fork tests 7, 8] (yield/resume edges exist and bracket
  exactly the gaps), [fork test 22] (an urgent commit discarding an
  older yielded pass never lets that pass's view advance),
  [battery case 7].
- **RT2 (MUST).** Writes landing while a pass is paused — including
  late writes from a batch the pass includes, or from a batch already
  committed into the pass's root — are NOT observed by that pass. They
  are observed by later passes. [fork tests 9, 10] (yield-gap handlers
  execute outside any render context; their writes join their own
  ambient batch and commit separately, after the open pass commits its
  write set unpolluted), [battery case 7], [oracle: flag 4 — the pin
  cap; removing it makes a yielded pass's value change across a yield].
- **RT3 (MUST).** An urgent render whose batch set excludes a pending
  deferred batch never observes that batch's writes — no pending value
  leaks into an urgent frame, and committed state stays intact while
  the pending view diverges. [battery case 1] (the world-divergent
  dependency family — the shape naive stores tear on),
  [scenario R3, R4].
- **RT4 (MUST).** A read outside any render pass observes newest state
  — every write applied, pending or not. In particular, a pass that has
  COMPLETED rendering but not yet committed captures no reads on
  foreign call stacks (event handlers, timers, promise continuations):
  "in a pass frame" and "on a render call stack" are different
  predicates, and read routing follows the call stack. [ruling
  2026-07-05, scenario R15] (pinned after review: an armed-at-passStart
  ambient view routed timer reads through a completed speculative
  render; reviews/2026-07-05-one-core-plan-review-codex.md finding 2),
  [oracle: visibility — the newest world].
- **RT5 (MUST).** No committed frame mixes views: all components
  committed together in one root agree — each component reads in the
  view of the render it is part of, so sibling readers can never tear
  within one commit, and a value computed from pending state never
  appears beside a value computed from committed state in one frame.
  This is the library's core promise; every other line in this section
  serves it. [battery case 1], [scenario R5], [oracle: contract
  preamble].
- **RT6 (MUST).** A component mounting while updates are in flight
  never paints a frame that disagrees with its committed siblings and
  never reveals a pending value early. Concretely: for every live batch
  that affected what it rendered but was not included in its render,
  the mount joins that batch's own scheduled work (so it updates
  together with the pending update); and anything that committed or
  retired during its mount window is corrected urgently before paint.
  [battery cases 9, 10] (mount mid-transition, foreign retirement in
  the window, late subscriber joining a pending batch),
  [scenario R6, R11].

### 3.2 Updates arriving mid-render

- **UM1 (MUST).** A new update is never spliced into an in-flight
  pass's view. React's two dispositions, both of which the library must
  tolerate and neither of which may tear: (a) the pass is restarted at
  a fresh freeze point — an update inserted after a pass has completed
  rendering but before it commits forces a pre-commit restart [fork
  test 24]; or (b) React commits exactly what the pass rendered and
  renders the new update in a follow-up pass — a delivery landing
  mid-render on an included batch's own lane produces two reported
  commits of that batch (rendered writes first, the late update after),
  with the batch retiring exactly once at the end [fork test 18, the
  flush-split pin]. What is forbidden is the third thing: the
  in-flight pass's already-frozen view gaining the new write (see RT1).
- **UM2 (MUST).** Render-phase writes to shared state are forbidden,
  and the library rejects them in all builds. Rendering must be pure:
  "Side effects should not run in render, as React can render
  components multiple times"; components "should never modify values
  that aren't created locally in render" [react.dev:
  components-and-hooks-must-be-pure]. [battery case 14] (render-phase
  writes throw in all builds), [scenario R7].
- **UM3 (WON'T-PROMISE).** React's one sanctioned render-phase write —
  same-component `setState` during render ("Calling the set function
  during rendering is only allowed from within the currently rendering
  component. React will discard its output and immediately attempt to
  render it again with the new state"; "Calling the set function of
  another component during rendering is an error" [react.dev:
  useState]) — is React-internal machinery for L3 state. The library
  does not extend this pattern to library state: there is no
  render-phase write channel, because a library write is L1/L2 state
  whose machinery cannot deliver React's "discard the output" half
  (incident I1). [ruling 2026-07-05: fn-as-atom dropped].
- **UM4 (MUST).** Re-running a render attempt with the same inputs is
  observably idempotent for the library: no read mutates the dependency
  graph's observable behavior, and StrictMode double-invocation and
  render replays produce the same values and net to one subscription.
  [react.dev: components-and-hooks-must-be-pure] ("Idempotent — you
  always get the same result every time you run it with the same
  inputs"), [battery case 14].

### 3.3 Commit and retirement

- **CR1 (MUST).** Each per-root commit reports (and applies to that
  root's committed state) exactly the write set the committing pass
  rendered — no more and no less. "No less" is load-bearing under lane
  entanglement and mid-render re-pends: a sibling batch whose updates
  the pass consumed via entanglement is part of the write set [fork
  test 25, replayed over every commit; the S3 entanglement fix and S4
  re-pend fix were both real under-reporting bugs this line pins
  against].
- **CR2 (MUST).** A batch retires exactly once, with exactly one
  disposition, after every root that rendered it has reported. A root
  where the batch's work was pruned (subtree deleted) never reports it,
  and pruning still retires the batch exactly once. [fork tests 16, 17].
- **CR3 (MUST).** A batch abandoned before any React work committed
  still commits its DATA: its writes become permanent state observable
  everywhere, and persistence never depends on having subscribers. A
  store-only transition (writes to state no component reads) persists
  identically. Abandonment discards RENDERING, never data — there is no
  rollback (see WP6 / battery case 17). [battery case 12],
  [battery case 12 (React)].
- **CR4 (MUST).** A root's committed state never advances while that
  same root has an open pass frame. (Frames close at commit or discard;
  cross-root advances are permitted while a foreign root's frame is
  open — see WP1.) [fork test 28] (by construction after S3: the frame
  closes inside the commit, before the commit report).
- **CR5 (MUST).** Within one commit, the observable order is fixed:
  the pass frame closes with a commit disposition, then the per-root
  commit is reported, then the retirements that commit causes, then
  host-tree mutation, then layout effects. A consumer snapshotting at
  frame-close observes the pre-commit baseline (the commit's own
  updates cannot mask foreign motion). Only batches the committing pass
  rendered may retire inside its commit; a foreign batch retires at its
  own closure. [fork test 26], [oracle: flag 5 legality rule].

### 3.4 Suspense

- **SU1 (MUST).** A promise consumed by a use-like read MUST be
  reference-stable across re-renders of a LIVING consumer: the same
  pending request yields the same promise instance every time that
  consumer re-evaluates, across urgent interruptions, replays, and
  concurrent attempts. "Promises passed to `use` must be cached so the
  same Promise instance is reused across re-renders"; "If a new Promise
  is created directly in render, React will display the Suspense
  fallback on every re-render"; "Promises created during render are
  recreated on every render, which causes React to show the Suspense
  fallback repeatedly and prevents content from appearing" [react.dev:
  use]. [battery case 15 (React)] (no refetch livelock).
- **SU2 (MUST).** Providing that stability for the batteries-included
  path is the LIBRARY's job, not the application's: "Normally, the
  caching logic would be inside a framework" [react.dev: use]. The
  library must also accept a caller-cached promise as-is (the app's
  data layer owns it; the library stores nothing). [ruling 2026-07-05:
  two-form `ctx.use`; plan amendment].
- **SU3 (MUST).** Resource identity is per KEY, never per consumer
  slot position: the key carries every input that varies the request,
  a settled entry is immutable, and concurrent views asking different
  questions never share one pending answer. The cross-key pin: with a
  pending transition's request in flight, a mount evaluating the same
  consumer in the committed view must synchronously serve the committed
  key's settled entry — not suspend on, or later display, the pending
  key's data. [ruling 2026-07-05; battery case 15 (React), the
  cross-key world test] (incident I2 is the failure this forbids).
- **SU4 (MAY).** A consumer discarded together with speculative work
  MAY re-issue its requests on the retried attempt. React's own story:
  "React does not preserve any state for renders that got suspended
  before they were able to mount for the first time. When the component
  has loaded, React will retry rendering the suspended tree from
  scratch" [react.dev: Suspense], and any promise created during such a
  render is recreated [react.dev: use]. Cross-death request dedup is
  the data layer's job (WP2). [ruling 2026-07-05: parity boundary,
  pinned as battery case 15b (React)].
- **SU5 (MUST).** A settled resource reads synchronously in every view
  that may see it; a pending one suspends exactly the reads that need
  it; settlement re-evaluates the consumers that suspended. Settled
  entries replay everywhere — retries make progress (no livelock).
  [battery case 15 (React)].

### 3.5 Async actions and transitions

- **AT1 (MUST).** Writes in the synchronous part of a transition
  action join the transition's batch: "React calls action immediately
  with no parameters and marks all state updates scheduled
  synchronously during the action function call as Transitions"
  [react.dev: startTransition]. [scenario R12], [fork §4.4
  classification pins (S4): same-event transitions share one batch].
- **AT2 (MUST).** A write after an `await` is ambient (urgent) unless
  explicitly re-wrapped — the library follows React's own rule rather
  than restoring context across awaits: "You must wrap any state
  updates after any async requests in another startTransition to mark
  them as Transitions" [react.dev: startTransition]. The library
  provides an explicit re-entry affordance (an action scope) and MAY
  warn in development on bare post-await writes (the lint is
  implemented adapter-only, in cosignal-react's shim; the engine and
  the reference model emit no dev events). [ruling 2026-07-05:
  the async-transition cut — parity, not gold-plating; plan Principles
  §2], [battery case 12], [scenario R12].
- **AT3 (MUST).** A re-wrapped continuation rejoins the SAME batch as
  the action's synchronous part — one pending update per action, not
  one per continuation. [fork flag-3 pin (S4): a re-wrapped
  async-action continuation gets the same parked token].
- **AT4 (MUST).** A parked action batch retires exactly once, at the
  action's settlement — never earlier, even if every render that
  included it has long since committed or been discarded; its pending
  state stays pending across the whole action. [fork flag-3 pin (S4)],
  [oracle: vocabulary — parked batches], [scenario R12], [battery
  case 12] (scoped writes fold only at settlement).

### 3.6 Effects

- **EF1 (MUST).** React-level side effects observe committed state
  only — never applied-but-uncommitted writes — because pending work
  may still be discarded and side effects cannot be un-run. [ruling:
  the `useSignalEffect` contract], [battery case 16].
- **EF2 (MUST).** Such effects re-run exactly at durable flips of
  values they read: a per-root commit that includes a batch, a batch
  retirement, an async settlement — including flips where an OLDER
  write becomes visible beneath a newer one (visibility changes, not
  just value writes). [battery case 16].
  **Amended 2026-07-06 (owner ruling, derived from parity + EF1 +
  CR4):** these are BOUNDARY semantics — an effect never re-runs
  mid-write, and never while the same root has an open render-pass
  frame (CR4 makes a boundary under an open frame impossible);
  multiple member writes before one boundary COALESCE to a single
  re-run at the boundary value (React's own model: several setState
  calls in one handler produce one render and one effect fire —
  [react.dev: useEffect/commit timing]); cleanup is GUARANTEED at
  unmount (a make-up fire is not — matching React). Retirement,
  settlement, and unmount are guaranteed flush points, so deferral is
  never indefinite. History: production originally revalidated
  immediately at committed-member writes; the 2026-07-06 plan reviews
  proved immediate violates EF1/CR4 (effect ahead of the screen under
  an open frame) and naive next-drain deferral loses unmount-adjacent
  fires — both schedules are pinned. [ruling 2026-07-06: EF2 boundary
  semantics].
- **EF3 (MUST).** Library-level effects created outside React
  (`effect()`) observe newest state and re-run after a write's
  notification, batching permitted. [oracle: contract — effects],
  [cosignal README].

### 3.7 Scheduling and priority

- **SP1 (MUST).** Deferred batches render in the background over
  interruptible slices; urgent updates land and commit BETWEEN slices
  without adopting, revealing, or losing the deferred batch's state.
  "A state update marked as a Transition will be interrupted by other
  state updates" [react.dev: startTransition]. [fork tests 9, 10],
  [scenario R4].
- **SP2 (MUST-tolerate; host fact).** Default-priority (non-discrete)
  urgent work does NOT preempt a yielded transition pass — the open
  pass commits its write set unpolluted first and the gap batch commits
  after; discrete/sync work DOES preempt, discarding the yielded pass
  before any committed-state advance. A library must be correct under
  both interleavings and must not assume preemption where React does
  not provide it. [fork test 10] (default does not preempt), [fork
  test 22] (discrete does; discard precedes any committed-view
  advance).
- **SP3 (MUST).** A synchronous flush (`flushSync`) commits urgently
  and excludes pending deferred batches: the synchronous frame shows
  none of the deferred batch's writes (all-old, never half-applied),
  and the deferred batch lands later, whole. Caveat pinned with the
  requirement: in current-generation React the Default lane is
  entangled with the Sync lane ("unified sync lane"), so a DEFAULT
  batch cannot stay pending across `flushSync` at React level — the
  React-reachable exclusion window is a DEFERRED (transition) batch;
  the default-batch exclusion shape is pinned engine-side only.
  [battery case 2], [battery case 2 (React), which documents the
  caveat], [scenario R13].
- **SP4 (MUST).** Work the library schedules on a batch's behalf —
  deliveries to subscribed consumers, a mount joining a pending batch
  it rendered without — is scheduled INTO that batch's own lane, so it
  renders and commits together with its cause, at its cause's priority.
  [battery cases 4, 6, 10], [oracle: delivery].
- **SP5 (MAY / MUST pair).** The library MAY over-notify — schedule a
  re-render that evaluates to an unchanged value (notification is
  value-blind; any value comparison at notification time would compare
  across views and either leak pending state or miss updates) — but
  MUST never fail to notify a consumer whose view of what it rendered
  changed, and MUST keep rendered output value-correct under
  over-notification. [battery cases 4, 5], [scenario R14], [oracle:
  delivery — declared tolerance for the lockstep referee].

### 3.8 Sync pricing

- **PR1 (MUST).** An application that never uses transitions (or any
  deferred/async update) pays no concurrency costs beyond predictable
  branches: while nothing is pending — no live batch, no open pass, no
  parked action — a write folds directly into permanent state and the
  current value, minting no pending representation, no notification
  bookkeeping beyond the plain library's, and no events. [ruling
  2026-07-05: the quiet-mode criterion (owner-ratified sync-price
  criterion; plan Phase 1b)], [cosignal README: quiet mode].
- **PR2 (MUST).** A deferred update starting after a run of quiet
  writes begins from the already-advanced committed state — quiet
  writes ARE permanent history the moment they land; there is no
  history to reconstruct and no window where they read as pending.
  [ruling 2026-07-05: plan Phase 1b acceptance], [cosignal README].

### 3.9 Observation lifecycle

- **OL1 (MUST).** Subscription liveness — "does this atom have any
  observer?", the first-observer and last-observer transitions — is
  defined over the union of ALL consumer kinds: library computeds and
  effects, host components, anything that subscribes. An atom observed
  by several kinds at once observes exactly once and cleans up only
  when the last consumer of EVERY kind is gone; observe/unobserve flaps
  within one tick coalesce. [ruling 2026-07-05: the union fix
  (incident I3)], [cosignal README: `AtomOptions.effect`].
- **OL2 (MUST).** An unmounted consumer receives nothing: no
  deliveries, no corrections, no effect re-runs after teardown.
  [scenario R8].

## 4. The WON'T-PROMISE list

Deliberate parity boundaries. Each is a place where exceeding React
was considered and rejected — usually because the "improvement" is
gold-plating that React's own machinery does not honor, so building it
buys complexity without buying an observable guarantee React apps can
rely on. A design review that finds a candidate design "fixing" one of
these has found a bug in the design, not a feature. Changing any entry
requires an owner ruling and a contract amendment, in that order.

- **WP1 — Cross-root frame simultaneity.** Roots commit independently;
  two roots reading the same state may briefly show different committed
  values (visible skew). The promise is per-root self-consistency (RT5
  within each root, CR1–CR4 per root), plus exactly-once retirement
  across all roots — not atomic multi-root frames. Why: React itself
  commits roots independently; a spanning batch commits per root with
  independent generations [fork tests 15, 16]. Declared scope:
  "degraded multi-root" [battery case 11], [scenario R10].
- **WP2 — Request dedup across consumer death.** If React discards
  speculative work that included a consumer's very first render, the
  retried attempt MAY re-run request factories (SU4). No cross-death
  request registry exists. Why: react.dev assigns that caching to data
  layers/frameworks above the render cycle ("The way you cache Promises
  depends on the framework you use… Frameworks typically provide
  built-in caching mechanisms" [react.dev: use]); React itself
  recreates promises for consumers that die before mounting
  [react.dev: Suspense]. Apps needing cross-death dedup cache the
  promise in their data layer and pass it in (SU2's caller-cached
  form). The previous attempt to promise more (the capsule registry
  keyed on function source text) was world-unsound and is deleted.
  [ruling 2026-07-05], [battery case 15b (React)].
- **WP3 — Guaranteed cache survival across dependency changes.**
  A derived-value handle keyed on deps (the `useMemo` model) is
  recreated when deps change, and its caches (including SU3's keyed
  resource map) die with it. Why: React documents its own memo cache
  as discardable — "React will not throw away the cached value unless
  there is a specific reason to do that… in development… when you edit
  the file… React will throw away the cache if your component suspends
  during the initial mount… In the future, React may add more features
  that take advantage of throwing away the cache… You should only rely
  on useMemo as a performance optimization" [react.dev: useMemo].
  Guaranteeing survival would exceed a lifetime React reserves the
  right to end (incident I1's cousin: it also breaks the fresh-handle
  signal existing code keys effects on). [ruling 2026-07-05: Phase 1
  dropped].
- **WP4 — Post-await transition context without re-wrapping.** A bare
  write after an `await` inside an action is ambient/urgent; the
  library does not restore the transition context across the await.
  Why: this is React's own documented limitation and rule for its own
  state ("You must wrap any state updates after any async requests in
  another startTransition" [react.dev: startTransition]); restoring
  context for library state while React state follows the other rule
  would make one action's writes land at two priorities. The explicit
  scope affordance (AT2/AT3) is the supported path. [ruling
  2026-07-05: the async-transition cut].
- **WP5 — Splicing updates into in-flight renders.** The library never
  promises that a write landing mid-render becomes visible to the
  render in flight — React itself restarts or follow-up-commits instead
  (UM1); the in-flight pass's view is frozen (RT1). Anything that wants
  mid-render visibility is asking for tearing by definition. [fork
  test 24], [fork test 18].
- **WP6 — Optimistic rollback.** No truncation, rollback, or revert
  affordance exists: written history is append-only, and abandonment
  discards rendering, never data (CR3). Optimistic UI composes ABOVE
  the library (pending flags in app state; React's own optimistic
  affordances), not as history surgery inside it. [battery case 17].

## 5. Named future mechanisms (recorded, not committed)

Designs the project has named but not adopted. Recording them here
fixes their shape and their entry criteria, so a future need finds a
vetted starting point instead of re-deriving one under pressure.
Neither is part of the contract; nothing in section 3 depends on them.

- **NF1 — A per-action lifecycle flag on writes** (the
  `stillCommitIfWorldIsRetired` concept, proposed by the owner
  2026-07-05; antecedent in the original design notes:
  `spec/branching-store.md` — a write is like a transaction statement,
  `SET X = Y ON ABORT STILL COMMIT` vs `ON ABORT ROLLBACK`). Today
  every library write is L1/L2: it persists unconditionally (CR3).
  Incident I1 showed some writes want L3: die with the discarded
  attempt. IF render-artifact writes ever return (a future
  stable-node/`useComputed` design, engine-level optimistic markers),
  the correct shape is a per-write lifecycle flag chosen by the writer
  — attempt-scoped (vanishes when the attempt/batch is discarded)
  versus committed-scoped (today's rule) — so the lifetime is declared
  at the write site instead of inferred by machinery built for the
  other lifetime. Entry criteria: an owner ruling; the oracle models
  the flag and its discard semantics FIRST (including fuzz coverage of
  abandon-with-attempt-scoped-writes); the I1 walked schedules
  (reviews/2026-07-05-one-core-plan-review-fable.md F1 schedules A/A′;
  codex findings 1/5/6) become pinned regression tests.
- **NF2 status (2026-07-06): QUEUED by owner ruling** — the owner
  explicitly queued NF2 productionization ("I want to queue up the NF2
  design as well"), which is the owner-evidence entry criterion; the
  2026-07-06 plan's Program 2 was reviewed adversarially and sent back
  for one design revision (untracked-read coverage, committed-plane
  lifecycle, settlement fanout, per-world equality, lifetime
  classification) before staged implementation.
- **NF2 spike result (2026-07-05,
  `research/experiments/world-tagged-links-spike.md`): MIXED.** Faster
  holds where it matters (world evaluation 2.5×–29× vs the shipped memo
  approach; sync path neutral except one +0.5ns computed-read seam;
  discard churn at parity via segregated per-world planes with bulk
  abandonment — the O(edges) teardown concern dissolved). Simpler does
  NOT hold net (~350 lines of duplicated walk specializations; per-world
  policy state unbuilt). Owner-facing recommendation recorded: pursue as
  a performance mechanism with the one-computed-API prize, gated on
  world-read cost appearing in real profiles. The hang schedule is
  pinned green in the prototype
  (`research/experiments/world-tagged-links-spike-code/`).
- **NF2 — World-tagged kernel links** (the unification door for the
  two-computed-APIs question). The library currently ships two derived-
  value representations: the plain library's computed and the
  concurrent engine's overlay computed — because hosting overlay
  computeds on the plain dependency graph was tried and failed: a
  computed whose dependencies flip between evaluations in different
  views leaves stale cross-evaluation links that form link cycles the
  graph's unwatched-dispose walk cannot traverse — measured as a hang
  (`packages/cosignal/src/logged.ts`, the newest-plane comment; the
  2026-07-05 simplification review filed "two computed APIs" as a
  top finding). IF unification is attempted, the named mechanism is
  tagging each dependency edge with the view that observed it, so
  edges from different views cannot alias into one cycle and disposal
  can walk per-view-acyclic subgraphs. Entry criteria: the
  disposal-hang schedule (dependency-flipping evaluation across views,
  then dispose-while-unwatched) is written as the FIRST regression
  test, red before the mechanism and green after; the per-view
  acyclicity claim is fuzzed (battery case 1's union-cycle member —
  per-view acyclic, union cyclic — is the model-level shape).

## 6. How to use this document

For any new feature, optimization, or redesign:

1. **Classify the state** (section 2). Every piece of state the change
   introduces or moves gets exactly one lifetime — L1 committed, L2
   pending-batch, L3 per-attempt, L4 resource — BEFORE choosing a data
   structure. If a piece resists classification, that is a contract
   question: stop and get an owner ruling (this is how I1–I4 would have
   been caught at design time).
2. **Find its requirements** (section 3). Collect every RCC line that
   mentions the affected surface; the design must state, per line, how
   it satisfies it. A design that cannot point at the line it satisfies
   is asserting a new semantic.
3. **Check the boundaries** (section 4). If the design "improves" a
   WON'T-PROMISE entry, it is out of contract: either cut the
   improvement or obtain an owner ruling amending section 4 first.
   Check section 5 before inventing a mechanism a recorded one already
   shapes.
4. **Extend the oracle FIRST if the semantics are new.** New observable
   behavior is modeled in `cosignal-oracle` — model, invariants,
   schedule-generator ops, battery case — before engine code exists, so
   the referee never lags the engine. (Where the oracle deliberately
   lacks vocabulary — e.g. thenables — the gap is declared in
   `tests/SKIPPED-FOR-FORK-SUITE.md` and the React-level battery is the
   referee of record; say so explicitly rather than claiming lockstep
   coverage.)
5. **Verify by lockstep, battery, and bench.** A candidate design is
   accepted when it passes the oracle lockstep fuzz corpus, the pinned
   regression schedules, the 17-case battery at both model and React
   level, the fork-pinned host facts it touches, and the sync-price
   criterion (PR1) in the benches. Requirement IDs (RCC-RT1 …) are the
   shared language for review findings, test names, and ruling records.

Amendments: this contract changes only by owner ruling, recorded with
date and rationale, with the affected requirement lines edited in place
(history in git). Provenance tags are part of the contract — a new line
without a react.dev citation, a fork pin, a battery case, or a dated
ruling is a proposal, not a requirement.
