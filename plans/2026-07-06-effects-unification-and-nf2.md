# Effects unification by promotion + NF2 productionization (2026-07-06)

> **AMENDED 2026-07-06 after adversarial review + owner rulings.**
> Reviews: `reviews/2026-07-06-unification-nf2-plan-review-{codex,fable}.md`
> (converged: Program 1 sound-with-amendments; Program 2 unsound as
> specified, sent back for design revision). Binding amendments:
> 1. **EF2 ruled** (owner, 2026-07-06; recorded in the contract):
>    boundary semantics — effects re-fire only at boundaries where the
>    root's committed truth legally advances (commit report,
>    retirement, settlement), coalesced to the boundary value, cleanup
>    guaranteed at unmount, never under an open same-root frame.
>    Production's immediate revalidation is RE-PINNED to this; the
>    three killing schedules (codex 2's open-frame run-ahead; fable
>    M3's unmount-loss; coalescing) become pins.
> 2. **Timing layer fixed** (codex 1): effect revalidation stays at the
>    root-commit report, NOT pass-end — pass-end precedes React's
>    re-pend classification.
> 3. **RUL-2 dissolved**: contract OL1 already rules — effects COUNT
>    toward observation liveness. Not optional.
> 4. **Oracle co-evolution enlarged** (codex 8 / fable M5): schedule
>    ops must model real dependency capture (bodies that re-choose deps
>    causally), effect removal, cleanup, StrictMode-style replay, and
>    the dedup rule when one pass locks in two tokens (one re-check per
>    boundary, not per token) — or declare each gap explicitly.
> 5. **obsCapture placement constraint** (codex 9): observation capture
>    feeds from every dependency read BEFORE any reuse/dedup check —
>    never from link insertion.
> 6. **Ordering joint defined** (codex 9): committed-side fanout/marks
>    land before the member-write effect scan at the same boundary.
> 7. **Program 2 sections (§3–§4, and §6 risks as they concern P2) are
>    SUPERSEDED pending a design revision** addressing: untracked-read
>    coverage (weak edges are load-bearing at HEAD — codex 3/fable B1),
>    committed-arena lifecycle (one consistent story — fable B2),
>    suspense settlement fanout per arena (codex 5/fable M2), per-world
>    equality policy (codex 6), S-A executability (codex 7), and the
>    mandatory lifetime classification for arenas/marks/boxes. The
>    revision gets a focused re-review before any stage runs.

> **RULINGS RESOLVED (owner, 2026-07-06): RUL-5** — infrastructure
> exemption GRANTED; the contract's four-lifetime rule is now scoped to
> application/history state (amendment recorded in the contract §2);
> the pool / settlement tap+queue / policy columns stay outside the
> taxonomy with mandatory per-row lifetime+reclamation documentation.
> **RUL-6** — the consumer-refcount reclamation ships; the
> fork-protocol root-destroy event is PRE-AUTHORIZED as the fallback if
> refcounting proves insufficient. S-A's ruling gate is CLEAR pending
> the third-pass verifier.

> **STATUS: COMPLETE (2026-07-06).** Every stage landed and pushed:
> Program 1 (effects unification) 3b0063a · S-A dual bookkeeping
> ca04129 (stopped at its cold-pass gate; resolved by the B1 shaves
> 487b91c) · S-B routing transfer 1d4ca4b · S-C one-computed-API
> 70c6eb3 (entry pins + the untracked-sampling ruling f563b74; the
> historical kernel hang fixed at its root) · S-D closure c4e54a5
> (NF2 final numbers in research/experiments/cosignal-gates.md:
> cold-pass 0.54x, wide-mask 0.76x, untracked-fan 1.08x vs the
> pre-NF2 anchor; armed writes -44/-49%). Remaining deferred markers
> are outside NF2's staging by design (the provably-quiet TODO(perf)
> fast path with its N-4 constraint; the B2 over-limit pin
> discipline).

> **Historical status: DRAFT — plan only, no code has changed.** Written for
> adversarial review (codex + a fresh no-priors reviewer) before any
> implementation, per this repo's process. Every mechanism, invariant,
> cost, and open risk is stated to be attacked; §7 lists the rulings the
> plan needs before its riskiest steps.

Two owner-queued programs, one plan, because both rewire the same
delivery/notification plumbing and must be sequenced deliberately:

- **Program 1 — effects unification by PROMOTION.** Owner ruling:
  generalize/subsume effects into core; the adapter keeps only
  React-specific timing. Resolves review finding F1
  (`reviews/2026-07-05-cosignal-simplification-review-2.md`): the
  engine's committed-effect machinery is production-dead while the
  adapter reimplements it. The fix is promotion — the adapter's real
  mechanism moves INTO core and becomes the refereed one — not deletion.
- **Program 2 — NF2 productionization.** Owner: "I want to queue up the
  NF2 design as well." Productionizes the de-risked mechanism of
  `research/experiments/world-tagged-links-spike.md` (per-world
  segregated shadow arenas; prototype archived at
  `research/experiments/world-tagged-links-spike-code/`), whose prize is
  review finding F5's death: ONE computed API, with unmodified kernel
  `Computed` objects evaluating under any world.

Governing artifacts: `spec/react-compliance-contract.md` (cited below as
"the contract"; requirement ids `RCC-*` are its §3 lines), the oracle
(`packages/cosignal-oracle` — the reference model and lockstep referee),
and `plans/2026-07-05-one-core-convergence.md` (whose Principles —
concept convergence, parity not gold-plating, core owns magic,
verification first — this plan inherits without restating).

**Source baseline for every file:line citation: commit `5fc3c08`**
(HEAD at drafting time). Concurrent grind work (review-2 F8/F10
deletions) is in flight in the working tree and will shift line numbers
by small deltas; every citation therefore also names its symbol, and the
symbol is authoritative. Neither program below depends on F8/F10's
outcome (nothing here touches dispatch ops or the dev-warning event
shape beyond the notification-queue kind numbering, which is ordinal).

## 0. Vocabulary (defined before use)

Terms already defined by the contract §1.2/§2 (batch, render pass, root,
committed state, newest state, retirement, consumer, delivery, the four
lifetimes L1–L4) and by the engine header (`packages/cosignal/src/logged.ts`:
receipt, tape, fold, world, token, slot, pin, mask, watcher, drain,
K0/K1, touched word, memo, memo table, memo ladder, episode, quiescence)
are used with those meanings. New terms this plan introduces:

- **Subscription** — the one core consumer record Program 1 defines: a
  registration that says *who* is notified (a component instance via the
  host's delivery callback, or a callback the library runs), *in which
  world its reads resolve*, and *at which triggers it is re-checked*.
  Watchers and both effect kinds become configurations of it.
- **Notification action** — the subscription parameter choosing what a
  notification does: `deliver` (schedule a re-render through the host's
  delivery callback — React owns the component execution that follows)
  vs `run` (the library invokes a callback — the library owns the
  execution).
- **World-read policy** — the subscription parameter choosing the world
  its reads resolve in: `pass` (the render pass's frozen view),
  `committed` (committed-for-root), or `newest`.
- **Dep snapshot** — the `(node, value)` pairs a `run`-action
  subscription captured during its last run; the value-gated
  re-check surface (today this lives in the adapter as `EffectRec.deps`,
  `packages/cosignal-react/src/shim.ts:123-131`).
- **Shadow arena** (NF2) — one world's private copy of graph structure:
  shadow node records mirroring kernel nodes plus link records in the
  kernel's exact `LinkField` layout, stored in a per-world `Int32Array`
  the kernel's lists never share. The spike-era word for this structure
  is RETIRED from all live surfaces (it was overloaded three ways: this
  structure, the kernel's packed storage, and logged.ts's per-world memo
  `Map`s — which NF2 deletes). Current vocabulary: shadow / pass /
  committed / live / dead **arena** here, **arena** for the kernel's
  packed storage, **memo table(s)** for the per-world memo `Map`s.
  Historical docs (research/, reviews/) keep the old word — see the
  terminology note atop `research/experiments/world-tagged-links-spike.md`.
- **Fanout** (NF2) — the write-path step that marks, in each live world
  arena that can see the write, the written atom's shadow as changed
  (kernel-style PENDING/DIRTY flag propagation), with a **read-clock
  dedup**: a per-(node, world) stamp so an idle world's Nth write-storm
  mark costs O(1) after the first.
- **Discriminant edge argument** — the soundness argument for delivery
  reachability under structural (per-world) graphs, stated and attacked
  in §4.4: for a computed's dependency set to differ between worlds,
  some already-linked dependency must differ first, so the write that
  flips the dep set is itself routable through existing links.

---

## 1. Program 1 — current state: three effect systems (verified at HEAD)

The inventory review-2 F1 found, re-verified against today's sources
(line numbers are HEAD's, not the review's — F3's referee extraction
moved things):

1. **Kernel `effect()`** (`packages/cosignal/src/index.ts:2081`) — the
   plain library's effect on the kernel's own dependency graph. Newest
   world by construction (RCC-EF3). Serves sync apps and, under a
   registered bridge, still fires through the kernel's eager apply.
   **Not part of this unification** — it is the kernel's own mechanism
   and the sync 80%'s hot path; forcing it through bridge machinery
   would tax exactly the app class RCC-PR1 protects.
2. **Bridge `ReactEffect` / `CoreEffect`**
   (`logged.ts:526-543` types; `mountReactEffect` :2705,
   `mountCoreEffect` :2723; effect halves of `drainCommittedObservers`
   :3217-3225, `quietDrain` :2293-2299, `flushEffectQueue` :2497,
   `directFlushCoreEffects` :2514). Single-node observers: a
   `ReactEffect` evaluates one node committed-for-root and re-runs
   value-gated at durable flips; a `CoreEffect` evaluates one node
   newest and flushes after the delivery walk. **Production-dead**:
   zero call sites in `cosignal-react` (grep verified). They exist so
   the oracle's `reactEffect`/`coreEffect` schedule ops
   (`cosignal-oracle/src/schedule.ts:52-53`) can referee
   committed/newest observer semantics in lockstep.
3. **Adapter `EffectRec`** (`shim.ts:123-131`, `registerEffect` :605,
   `captureEffectRun` :618, `revalidateEffects` :643-665) — the REAL
   `useSignalEffect` mechanism (`cosignal-react/src/hooks.ts:306-333`).
   Multi-dep: running the user's effect body under an
   effect-capture frame (`shim.effectCapture`, fed by the bridge's
   `readObserver` seam and the world provider's committed arm,
   shim.ts:197-211) records every routed read as a `(node, value)` dep
   snapshot in the committed world of the effect's root; re-validation
   compares each dep's committed value and re-fires on any change.
   Validated only by the React test suite — the oracle referees the
   *other* implementation.

The F1 failure mode: two implementations of "committed-world effect
revalidation" with different shapes (single-node vs multi-dep-snapshot),
where the heavily documented, oracle-refereed one is the one production
never runs. The owner's ruling picks review option (a)'s spirit with the
direction inverted: instead of synthesizing bridge nodes to fit the dead
mechanism, the LIVE mechanism (dep-snapshot revalidation) is promoted
into core and becomes the refereed one.

## 2. Program 1 — the core subscription mechanism

### 2.1 Constraints (owner-ratified; restated so the review can check each)

- **Re-rendering stays a notification ACTION, never library-owned
  execution.** React owns component execution — per-attempt lifetime,
  contract §2 L3: the library must never run a component; it schedules a
  re-render through the host's delivery callback and React discards or
  replays the attempt freely. The library owns effect execution —
  committed lifetime: an effect record is created by the adapter from
  React's own effect phase (post-commit), never during render, so no
  subscription record ever exists for a discarded attempt. This is why
  `EffectRec` never needed attempt-discard machinery, and the promoted
  mechanism must preserve that property (registration is illegal inside
  an open evaluation/render frame — enforced, not assumed).
- **Effect observable timing must not change** (RCC-EF1/EF2/EF3;
  battery case 16). §2.4 is the trigger-by-trigger ledger; §2.5 plans
  the oracle co-evolution explicitly because the oracle models effect
  semantics and currently models the WRONG (single-node) shape.
- **StrictMode/React timing shells stay adapter-side**: `useEffect`
  registration and deps arrays, cleanup invocation and the `disposed`
  flag, StrictMode double-invoke tolerance, root resolution
  (`hooks.ts:306-333`), the watcher claim/orphan-sweep/debounce
  discipline — all unchanged. The adapter remains the only code that
  knows what a React commit *feels* like; core knows only the protocol
  events the bridge already consumes.

### 2.2 The mechanism

One record, replacing three:

```
Subscription = {
  id, name,
  action:  'deliver' | 'run',
  policy:  {kind:'pass'} | {kind:'committed', root} | {kind:'newest'},
  // action='deliver' (watcher configuration):
  node, lastRenderedValue, snapshot (pin/mask/gen), dedupBits, live,
  // action='run' (effect configurations):
  deps: (node, value)[],        // dep snapshot, re-captured per run
  refire: () => void,           // queued at the operation boundary
  runs, lastGen,
}
```

Configurations:

| today | action | policy | notified by | value gate |
|---|---|---|---|---|
| `Watcher` | deliver | pass (render) / committed (drains) | write-time delivery walk; durable-drain corrections; mount fixup | delivery value-blind (RCC-SP5); corrections value-gated |
| shim `EffectRec` (promoted) | run | committed(root) | durable-flip triggers (§2.4) | value-gated over the dep snapshot |
| bridge `CoreEffect` (absorbed) | run | newest | post-delivery-walk flush | value-gated on the node's value |

Mechanism points, each stated so it can be attacked:

1. **Watchers become the `deliver` configuration nominally, not
   structurally.** Their state (snapshot, dedup bits, `live` feeding the
   observation union via `obsShift`) is untouched; what unifies is the
   *indexing and firing machinery*: today three parallel per-node
   indices (`watchersByNode`, `reactEffectsByNode`, `coreEffectsByNode`,
   logged.ts:949-951) and three copies of the collection block inside
   `deliveryWalk`, `drainCommittedObservers`, `quietDrain`, `sweepK1`'s
   reachability seeds, and `quiesce`'s refresh-target scan. After
   Program 1 there is ONE per-node subscription index and one collection
   rule; the action field dispatches at fire time. This is the part
   Program 2 depends on (§5): NF2 rewrites every one of those walks, and
   it should rewrite one collection rule, not three.
2. **The capture frame moves into core.** `captureRun(id, body)` opens a
   core-side frame: the effective world becomes `committed(root)`, and
   every routed read (atom reads through the host read hook; bound/
   kernel computed reads through the evaluation surface) appends to the
   subscription's dep snapshot. This deletes the adapter's
   `effectCapture` field, the `readObserver` seam usage, and the world
   provider's committed arm (shim.ts:197-211) — the world provider
   shrinks to its render/pass arm, which is genuinely React-specific
   (it consults React's render-context API). The frame preserves the
   existing suppression rule: reads inside a bound-computed evaluation
   belong to the computed, not the effect (shim.ts:207-211).
3. **Refires ride the operation-boundary notification queue.** The
   bridge already queues deliveries/corrections/dev-warnings into
   reusable columns and invokes listeners only after the public
   operation's mutations complete (`queueNotify`/`flushNotify`,
   logged.ts:836-887) so "a listener can never re-enter a half-finished
   operation." Effect refires become a new queue kind. Consequence: a refire
   triggered by a retirement runs after the retirement fully completes —
   the same observable point as today's adapter, which calls
   `revalidateEffects` after `bridge.retire` returns
   (shim.ts:449-460).
4. **v1 re-check strategy is the production one: per-root full scan.**
   Today's adapter iterates every `EffectRec` of the triggering root and
   value-compares its snapshot (shim.ts:643-665) — O(effects) per
   trigger. The promoted mechanism keeps exactly that (scoped by the
   drain's root, exactly as engine drains already iterate per root), and
   does NOT build per-dep-node registration/re-pointing machinery in v1.
   Rationale: identical cost and timing to production, no new
   bookkeeping to get wrong, and the cone-scoping optimization the
   engine's dead `ReactEffect` half had is exactly the piece NF2
   replaces anyway (§4.4). A `TODO(perf)` marks the seam with the
   profile trigger, matching the file's existing convention.
5. **`SuspendedRead` in dep snapshots is not a flip.** The adapter's
   rule (shim.ts:653-656): a dep whose committed re-read throws/yields a
   still-pending suspension does not count as changed. Promoted verbatim
   and pinned (§2.5 battery 16d).
6. **Registration surface** (core): `mountCommittedObserver(root,
   refire)` / `removeSubscription(id)` / `captureRun(id, body)`.
   The adapter's `registerEffect`/`unregisterEffect`/`captureEffectRun`
   become one-line delegations and then fold away; `hooks.ts`
   `useSignalEffect` keeps its exact shape.

### 2.3 Lifetime classification (contract §6 step 1 — mandatory)

State the promoted mechanism introduces or moves, each with exactly one
lifetime:

- **The subscription record + dep snapshot**: consumer-scoped state of a
  committed consumer. It is created from React's commit-side effect
  phase and destroyed at teardown (RCC-OL2); it never exists for a
  discarded attempt (L3 never touches it); it has no retirement event
  (not L2); it is not keyed by request (not L4). It is bookkeeping ABOUT
  committed truth, re-creatable by re-running the capture — the same
  class as watcher records, which the contract's incident ledger never
  had to file because they carry no application data. The classification
  rule's teeth here: **no part of the dep snapshot may be consulted by
  fold/visibility machinery** (it is observer bookkeeping, not history),
  and registration during render throws (keeping L3 out).
- **No new L1/L2 state.** The mechanism writes nothing; it reads
  committed worlds and compares.

### 2.4 The observable-timing ledger (what must not move — and one seam that needs a ruling)

Production `useSignalEffect` timing today, trigger by trigger:

| trigger | production path (adapter) | promoted path (core) | delta |
|---|---|---|---|
| batch retirement / async settlement | `handleBatchRetired` → `bridge.retire`/`settleAction` returns → `revalidateEffects()` (all roots) | retirement's durable drain re-checks the root's `run/committed` subscriptions; refires queue to the op boundary | none observable: body runs after the retire op completes in both; all roots covered in both |
| per-root commit | `handleRootCommitted` → `revalidateEffects(root)` | `passEnd(commit)`'s per-root lock-in drain re-checks that root's subscriptions | none observable (commit drains already run per locked-in token; value gate coalesces) |
| **write into a batch already committed into a root** | `classifyWrite`/`scopeWrite` → `revalidateEffects(root)` **immediately, at the write** (shim.ts:584-600) | **must be added**: the write path already computes exactly this membership to set `committedDirtySlots` (logged.ts:2417-2423); the promoted trigger re-checks that root's subscriptions at the same operation boundary | **none, if built as specified — but see the ruling below** |
| quiet-mode fold | n/a under the React adapter (the classifier owns every write; the fork mints a batch per write, so the quiet short-circuit is bypassed); engine `quietDrain` re-checks only the production-dead `ReactEffect`s | `quietDrain`'s committed arm retargets the promoted records | none for either host class (React hosts never take the quiet path; non-React hosts have no committed observers today) |

**The discovered seam (ruling needed, RUL-1 in §7).** The adapter revalidates
*immediately* when a write lands in a batch some root has already
committed (committed truth moves at that instant — the membership clause
of the visibility rule). The engine's dead `ReactEffect` half and the
ORACLE both defer that re-check to the next durable drain
(`committedDirtySlots`' own comment: "the reference model's full
observer scan catches this at any retirement/commit"). And RCC-EF2's
trigger list ("a per-root commit that includes a batch, a batch
retirement, an async settlement") does not name this trigger at all. So
today: production fires earlier than both the contract's letter and the
model. Promotion forces the question. **Recommended resolution: amend
EF2 to name the committed-member write as a durable flip** (it is
durable — once a root has committed UI from a batch it must keep
agreeing with its own screen, which is the visibility rule's membership
clause, and the batch's data can never revert, RCC-CR3), model it in the oracle,
pin it as battery case 16b. The alternative — adopting the model's
deferred timing — changes production behavior and violates this plan's
own constraint. Until the ruling lands, Program 1 does not start
(oracle-first discipline, contract §6 step 4).

**A second seam (ruling needed, RUL-2 in §7): the observation union.** RCC-OL1
defines observation liveness over the union of ALL consumer kinds —
"library computeds and effects, host components, anything that
subscribes." Kernel effects retain through the kernel's watched edges;
watchers retain through `Watcher.live` → `obsShift` (and, since
7456c7b, transitively over their computed's current strong deps). But
`EffectRec` deps hold NO observation retains today — an atom with
`AtomOptions.effect` observed *only* by a `useSignalEffect` never
triggers its observe lifecycle. That is incident-I3-shaped (a consumer
kind missing from the union) unless it was a deliberate scope decision;
nothing in `observe-union.spec.ts` pins it either way. Promotion is the
cheap moment to close it: the promoted subscription's dep snapshot holds
one retain per snapshot node through the existing `obsShift` observation index
(re-pointed per run exactly like 7456c7b's `obsSyncDeps`; the kernel's
microtask flush already damps same-tick flaps). **This is a behavior
change** (the lifecycle fires in new cases) and needs an owner ruling
plus an `observe-union` pin either way — including if the answer is
"effects deliberately don't count," which must then be written into
OL1's text.

### 2.5 Oracle co-evolution (before engine code — contract §6 step 4)

The oracle currently models the wrong shape (single-node observers), so
promotion without model work would leave the real mechanism un-refereed
— re-creating F1's complaint one level down. In order:

1. **Model**: replace the model's `ReactEffect` with a dep-snapshot
   committed observer: `{root, deps: [(nodeIndex, value)], runs}`. Its
   "run" evaluates every listed node committed-for-root and re-captures.
   Re-check triggers: retirement, per-root commit, settlement, and (per
   RUL-1) the committed-member write. The `CoreEffect` model
   (newest, value-gated, post-walk) is unchanged in semantics and
   becomes the `run/newest` configuration.
2. **Schedule ops**: `{t:'reactEffect', root, node}` becomes
   `{t:'reactEffect', root, nodes: number[]}` (1–3 nodes), plus a new
   `{t:'reactEffectSwap', effect, nodes}` op modeling a body whose reads
   changed between runs (the dep-FLIP dynamics are where snapshot
   mechanisms rot; static lists would never exercise them). The engine
   adapter mirrors by re-registering a body reading the new list.
3. **Events**: `react-effect-run` gains the captured values (or a new
   `committed-observer-run` shape); the twin comparator compares these
   exactly, as it does all non-delivery events (`tests/helpers.ts` —
   only delivery-ish events use the documented ⊆-counts tolerance).
4. **Battery**: case 16 extensions — 16b committed-member-write
   immediacy (RUL-1), 16c dep-flip re-track, 16d SuspendedRead-dep is not a
   flip; plus React-level mirrors. **Characterization pins first**: the
   16b/16d behaviors are pinned against TODAY's adapter before any core
   code moves, so the migration diffs against reality, not intention.

### 2.6 Deliverables and sequencing (each step lands only fully verified)

- **P1.S0** — rulings RUL-1/RUL-2 (§7); characterization pins (battery 16b/16d
  at React level against HEAD).
- **P1.S1** — oracle: model + schedule + events per §2.5; model-only
  suites green; fuzz corpus regenerated and green.
- **P1.S2** — core: the subscription record, the unified per-node index,
  the capture frame, the refire queue kind, the trigger wiring (including
  the RUL-1 write trigger). Bridge `ReactEffect`/`CoreEffect` types deleted;
  `mountReactEffect`/`mountCoreEffect` become configuration
  constructors so the lockstep adapter drives the REAL mechanism.
  Engine suites + lockstep green.
- **P1.S3** — adapter: `useSignalEffect` re-seated on the core surface;
  `EffectRec`/`revalidateEffects`/`effectCapture`/`readObserver`-capture
  deleted; world provider shrinks to the render arm. React suite (53+)
  green; scenarios green.
- **P1.S4** — full battery: package suites, oracle lockstep fuzz corpus,
  conformance ×3, React battery + scenarios, typechecks; quiet-mode and
  one-core probes unchanged (PR1 untouched — no new work on quiet
  paths); README updates (cosignal-react's README stops needing F1's
  "does NOT ride it" caveat because it now does).

### 2.7 Deletes vs adds (honest ledger)

**Deletes**: adapter `EffectRec` + `registerEffect`/`unregisterEffect`/
`captureEffectRun`/`effectRead`/`revalidateEffects` + `effectCapture` +
the `readObserver` wiring and the world provider's committed arm (~110
adapter lines); bridge `ReactEffect`/`CoreEffect` as distinct types and
their three per-node indices and duplicated collection blocks (~120
engine lines, REPLACED not net-deleted); the oracle's single-node
effect shape.

**Adds**: the core subscription record + registration/capture surface +
the RUL-1 write trigger (~100–150 engine lines); oracle model/schedule
changes (~80 lines); new battery cases and characterization pins.

**Net**: adapter −~110 lines and one whole concept; engine roughly flat
in lines but −2 concepts (two effect types → one mechanism with a
parameter; three indices → one); oracle +1 op arm. Concept resolution:
the "three effect systems" reading collapses to kernel `effect()` (sync,
untouched) + one core subscription mechanism, refereed end to end.
What this does NOT buy: fewer walks (that is Program 2), or any
performance change (v1 is cost-identical by design).

---

## 3. Program 2 — what the NF2 spike proved, and what it deliberately did not build

> **§3–§4 REVISED 2026-07-06, second pass** (supersedes the first-pass
> text per amendment 7). Written against the tree AS IT STANDS after
> Program 1 landed (`3b0063a`): one core `Subscription` record with the
> capture frame (`mountCommittedObserver`/`captureRun`/`captureRead`),
> EF2-amended boundary re-checks (`revalidateCommittedSubs` at commit /
> discard-close / retirement / settlement / quiet fold, at op end,
> never under an open same-root frame), refires as notify-queue kind 3,
> `committedDirtySlots` + the `restaled` set gating drains, the
> `subDepRefs` table, and `obsCapture` fed pre-dedup inside
> `recordEdge` (codex-9's placement, landed). Every hole named by the
> reviews (codex 3/4/5/6/7/9; fable B1/B2/B3/M1/M2/M4/M6/m1–m6) is
> answered below with a mechanism, a walked schedule, or an explicit
> scoped retreat.

From `research/experiments/world-tagged-links-spike.md` (all §-refs
below are that report's; numbers are its medians):

**Proved:**
- The hang schedule — NF2's entry criterion (contract §5) — written
  first, red on the documented failed design (`__naiveWorldRead`
  pinned: kernel-hosted world evaluation corrupts the newest cache),
  green on segregated arenas by construction; 200-iteration
  discard-churn with alternating surgical/bulk teardown leaks zero
  links.
- Sync-path neutrality: chain/fan write shapes +0.4–1.4% (within
  noise); the ONE real regression is **+0.5 ns (~19%) on a bare clean
  computed read** — the `spikeRoute` scalar branch in `Computed.state`.
  Idle live worlds +1–10%, bounded by the read-clock dedup.
- Discard churn at parity: bulk arena drop −4.3%, per-edge surgical
  +0.8% vs the shipped pass memo table. **Important for §4.8: the
  spike had NO cross-world fast path at all — every world read routed
  to its arena — so these numbers already price the fast-path deletion
  §4.4 commits to.**
- World evaluation 2.5× (1 dirty atom) / 5.5× (all dirty) vs the
  cheapest shipped memo table, 29× vs what a render pass pays today;
  zero-allocation steady state; conformance smoke 179/179 with zero
  worlds open; per-world footprint 32–64 KB at the bench shapes.

**Left UNBUILT (the report's §4 ledger — each item now has a §4.5
disposition, cross-referenced):**
1. World atom values from FOLDS → §4.2.
2. Pin discipline for pass worlds → §4.3.
3. Per-world equality cutoff → §4.5.3 (codex 6's record shape).
4. Per-world suspense/sentinel boxes, `ctx.previous`, `ctx.use` →
   §4.5.4–4.5.6 (the settlement re-mark site, fable M2/codex 5).
5. Watcher-delivery integration → §4.4.
6. Commit-generation re-keying for committed worlds → §4.3(b) WITH
   fable B3's carve-out (refold-always at lock-in).
7. Arena pooling / read-clock wrap / growth-mid-op reload → §4.5.7–9,
   §4.6 (pool claim generations).
8. Receipts/retirement/tape/slot/token layer: untouched by NF2 either
   way (unchanged from the first pass; re-verified — nothing below
   writes a receipt or moves a stamp).

**What the spike also never exercised** (the second-pass additions all
live here, per the reviews): untracked reads, folds, watchers, drains,
quiet mode, quiescence, suspense. The spike had none of them; §4's new
mechanisms (weak arena links, the four flip sites, arena persistence,
the settlement re-mark, the population rule) are exactly the closure of
that gap.

## 4. Program 2 — the production mechanism (§3–§4 REVISED 2026-07-06, second pass; targeted THIRD PASS 2026-07-06 closing `reviews/2026-07-06-p2-revision-review-{codex,fable}.md` — re-revised sections are marked "third pass 2026-07-06" in place)

### 4.0 The landed Program-1 substrate this design consumes

Stated so every §4 mechanism can cite its joint instead of assuming it:

- **Effect re-checks are boundary scans, not drains.** `run/committed`
  subscriptions re-check by per-root full scan
  (`revalidateCommittedSubs`) at the EF2-amended boundaries, evaluating
  each dep via `evaluate(node, committed)` — so P2 changes what that
  evaluation COSTS and how its cache invalidates, never who collects
  candidates. Drains collect watchers only.
- **The member-write immediate scan is GONE** (EF2 ruling): a
  committed-member write only marks (`committedDirtySlots`) and the
  next boundary flushes. Codex-9's first ordering coupling
  (fanout-before-member-write-scan) is therefore dissolved by the
  ruling itself; the surviving joint is §4.3's boundary-ordering rule.
- **`restaled`** (per-root re-staled watcher set, fed by `passEnd`'s
  detection loop) gates drains alongside slot bits. It SURVIVES P2
  verbatim — it is watcher-value bookkeeping, not K1 machinery — and
  the loop that feeds it is promoted to a named, load-bearing role
  (§4.4, fable M1).
- **`subDepRefs`** exists to protect K1's sweep and the quiesce
  refresh for effect-dep nodes. Both consumers die in S-B; §4.8 deletes
  the field with them (the P1 handoff item, resolved: its protective
  job dissolves because effect re-checks validate through arena marks
  fed directly at flip sites, not through touched-word fast paths).
  The `obsShift` retains it was bundled with (RCC-OL1) are untouched.
- **`obsCapture` feeds pre-dedup inside `recordEdge`** (landed). The
  fn-reader path keeps that discipline through S-A/S-B unchanged;
  §4.7 carries it into the transliterated walks at S-C (fable M6).
- **m5 (P1, recorded as landed):** core enforces the evaluation-frame
  half of the registration guard; the render-stack half is
  adapter-enforced — the split is in the code comments at
  `mountCommittedObserver`. m6 (P1, landed): retirement/settlement
  scans run unconditionally even write-free (battery 16's write-free
  retirement pin); P2 keeps all boundary calls, so the
  motion-implies-boundary invariant m6 asked for holds by construction
  and stays pinned.

### 4.1 Which worlds get arenas — and the ONE lifecycle story (fable B2)

- **newest** — IS the kernel; no arena, no shadow (the `newestMemos`
  ladder arm survives until S-C as the temporary newest
  representation — §4.8, codex 7 — then deletes).
- **pass worlds** — one pooled arena per open pass: claimed at
  `passStart`, dropped in `reclaimAfterPassEnd` — which already runs
  AFTER mount fixup and after the re-staled detection loop, so the
  fixup closure and the populator both see the arena (m2's ordering,
  pinned with a dev assert: fixup/re-staled touching a dropped arena
  throws). Commit and discard drop identically.
- **committed-for-root worlds** *(third pass 2026-07-06: "the root's
  life" is hereby DEFINED as its CONSUMER-POPULATED life — §4.5.8)* —
  one arena per root, materialized lazily at the root's first
  committed-world evaluation. **Committed arenas persist for the
  root's consumer-populated life: while the root holds ≥1 committed
  consumer (live watcher or `run/committed` subscription), the arena
  survives pass ends, retirements, quiet mode, and QUIESCENCE.** A
  root whose consumer population is ZERO at a quiescence RELEASES its
  arena there (the watcher-population refcount, §4.5.8 — codex
  new-blocker 4 / fable N-6/N-7) and rematerializes on demand through
  the same lazy path, repopulated by §4.4.2's rule. Hard death remains
  bridge disposal; **no root-teardown event exists in the engine or
  the fork protocol** (nothing ever deletes from `this.roots` — fable
  N-7), so the second pass's "die with the root record (host
  teardown)" is STRUCK as citing a nonexistent event; a fork-protocol
  root-destroy event is the recorded-open fallback (RUL-6). The rest
  of the single story stands (fable B2): no drop at pass end,
  retirement, or (while populated) quiescence; the asserted invariant
  is **zero live PASS arenas while quiet** (quiet ⇔ no open passes)
  plus §4.3's quiet-fold fanout site (d).
- **mountFix worlds** — remain one-shot arena-less fold-throughs
  (unchanged).

**Consequences of committed-arena persistence, each walked:**

1. **Quiescence sheds work instead of gaining it.** Today `quiesce()`
   bulk-resets K1 and then runs the kernel-pull refresh precisely
   because the routing coverage committed observers rely on dies with
   the old episode's K1. Arena links are CURRENT structure, not an
   episode-accumulated log — nothing resets, so **the kernel-pull
   refresh is replaced by persistence, not by a substitute mechanism**.
   Fable B2's resolution-2 schedule now walks green: watcher `w` on
   `C` (deps `{A}`) committed in R; quiesce (R's arena keeps `A→C`);
   event-handler write to `A` in new batch T → the delivery walk over
   kernel ∪ live arenas finds `A→C` in R's arena → `w` delivered in
   T's lane. What `quiesce()` keeps: the residue asserts, epoch bump +
   event, slot/dedup zeroes, dead-record reclamation — plus two new
   duties, in order (third pass 2026-07-06): the zero-consumer arena
   reclamation sweep (§4.5.8) FIRST, then per-arena read-clock
   renumber (§4.5.7) over the surviving arenas only. Renumbering is
   thereby O(consumer-populated arenas): codex new-blocker 4's
   "quiescence stops shedding work once dead-root high-water arenas
   accumulate" is answered structurally — dead-root arenas are
   exactly what the sweep removes before the renumber runs.
2. **Quiet mode runs ON arenas — flip site (d).** `__quietWrite`
   already calls `quietDrain` + `revalidateCommittedSubs(undefined)`,
   both of which evaluate committed worlds; under NF2 those
   evaluations use the surviving committed arenas, so the quiet fold
   must fan: after `base/cas` advance, mark the folded atom's shadow
   in every live committed arena (guarded by one `arenasLive !== 0`
   scalar check). Fable B2's resolution-1 schedule walks green:
   quiesce → quiet write to `A` → fanout marks `A` in R's arena →
   `quietDrain` evaluates the watcher's computed committed → mark
   propagation reached it → refold → fresh value →
   `quiet-mode.spec.ts` stays green. PR1 accounting: an app with NO
   React consumers never materializes a root, hence never a arena —
   its quiet write pays exactly the one scalar check (same class as
   today's `watchers.size !== 0` branch); an app WITH live watchers
   already pays `quietDrain`'s full evaluation sweep per quiet write
   today, and marks make that sweep cheaper, not dearer (unmarked
   shadows serve O(1)). Gated by the logged-quiet bench residuals P1
   just re-published.
3. **The zero-worlds steady state, stated:** quiet + no consumers ⇒
   no arenas exist at all (lazy materialization has no trigger; and
   a root that HAD consumers returns to this state at the first
   quiescence after its population hits zero — §4.5.8, third pass);
   quiet + consumers ⇒ pass arenas zero, committed arenas idle with
   all shadows clean, fanout O(marked=1) per quiet write with the
   read-clock dedup making repeat marks O(1). Fable B2's zero-arena
   contradiction (mount, commit, unmount every consumer, quiesce —
   permanence said the arena remains, "no consumers ⇒ no arenas"
   said not) dissolves: the reclamation sweep makes BOTH true, in
   sequence.
4. **The fourth fanout site exists** — (d) quiet fold, added to
   §4.3's list. B2's "missing fourth site" is thereby answered rather
   than argued away.

Pooling: pass arenas pool (per-pass churn is the hot case); committed
arenas do not cycle through the pool while populated (long-lived), but
a reclaimed committed arena's buffer RETURNS to the pool (§4.5.8,
third pass 2026-07-06). Every pool tenancy carries a claim generation
checked by the structural validator so a dead tenancy's residue can
never validate (§4.6).

### 4.2 Values: grounding shadow atoms in folds — and mark consumption WITHOUT fingerprints (REVISED third pass 2026-07-06)

A world's atom value is `foldAtom(atom, world)` — the existing packed
fold under the existing two-clause visibility rule — computed lazily at
the atom's first read in that arena and stored in the arena's value
column. **The second pass's per-arena atom fingerprint column is
STRUCK — no per-arena fp column is built, and no fingerprint is
CONSULTED at mark consumption** (the resolution of codex new-blocker 2,
below). What dies is every PER-COMPUTED fingerprint too, as before:
computeds validate structurally (shadow flags + `wCheckDirty` + the
§4.5.3 value cutoff), never by per-dep fp scans.
**The ledger, made exact (fourth pass 2026-07-06 — the verifier caught
the overclaim):** what is deleted is the fp GATING; the fold's fp
STORE is retained until S-D. S-A reuses `foldAtom` VERBATIM, and
HEAD's fold computes `fp = max(...)` into `lastFoldFp` during every
scan (`logged.ts` `foldAtom` — "computes the memo fingerprint … into
`lastFoldFp` during the same scan"), arena folds included. That scalar
max-tracking stays as written: it is load-bearing for the ladder's
surviving newest arm through S-B (§4.8's temporary-newest rule), and
for arena folds it is a few instructions of dead weight, carried
knowingly. It is removed at S-D cleanup as a named line item (§4.8
S-D) once S-C has deleted the ladder's last arm — its only reader. No
arena code READS a fingerprint at any stage; every "fp work deleted"
claim in this plan means exactly this: fp gating deleted, fold fp
store retained until S-D.

**The consumption-side representation, CHOSEN (codex new-blocker 2).**
The two re-reviews read the second pass's split-by-site fp rule
oppositely because marks carry no cause: nothing at consumption time
distinguished a site-(b) mark ("never trust fp") from any other. Three
representations could close that: (i) a sticky per-shadow force-refold
bit set by site-(b) fanout; (ii) eager refold at the flip site inside
the per-token loop; (iii) no-fp-on-marked-atoms — drop fp gating
entirely. **Chosen: (iii).** The rule, uniform across all four sites:
**a marked shadow atom, when consumed by any evaluation or drain,
REFOLDS unconditionally and value-compares (write-equality per world /
the §4.5.3 cutoff) before propagating; propagation is gated by the
VALUE cutoff only.** Marks need no provenance because there is no
fp-trusting path for a lock-in mark to be distinguished from — the
ambiguity is removed by deleting the machinery it was about.

Why (iii), priced against the alternatives:

- The second pass's per-site analysis survives as the JUSTIFICATION:
  at sites (a)/(c)/(d) the flip that fans an atom always ADVANCES its
  visible maximum (a retirement mints `retirementStamp` above every
  prior seq; a member write appends a new maximum; a quiet fold
  advances `baseSeq`) — so an fp gate could never skip there (fp
  provably moved); at site (b) membership exposes receipts at-or-below
  the visible maximum — so an fp gate must never be trusted there
  (`validateMemoInner`'s evict-never-fingerprint-rescue rule). Both
  halves point the same way: the gate has NO successful skip site
  (codex major 7's own analysis), and testing it means recomputing
  `fpOf` — a tape scan of the same cost class as the fold it would
  skip. Deleting it is strictly cheaper than the written second-pass
  mechanism, deletes a column, and deletes the per-site split.
- (i) would keep fp machinery alive solely to bypass it at one site —
  dead weight plus a provenance bit to maintain and get wrong.
- (ii) would load folds into React's commit phase for atoms that may
  never be read again (fable N-11's concern); deferred consumption
  keeps folds where HEAD already pays them (the boundary's drains and
  committed evaluations).

**Codex's fp-100/seq-50 schedule, re-walked under (iii):** retired
seq 100 visible on atom `A` (R's committed arena holds the fold at
100); live token T holds seq 50 on `A`; `passEnd(commit)` locks T in →
site-(b) fanout marks `A`'s shadow in R's arena (mark + dedup only,
O(1)) → the same boundary's per-token drain (or any later committed
evaluation) consumes the mark: refold UNCONDITIONAL — no fp consulted;
the verbatim fold still computes its `lastFoldFp` scalar, dead weight
per this section's ledger (S-A step 0, 2026-07-06 — was "none
stored", stale against the verbatim-`foldAtom` choice) — the fold's
visible set now includes T's seq-50 receipt
by membership → value flips to T's write → value-compare says changed →
PENDING propagates → the watcher's compare corrects. Green with no
reliance on any fingerprint motion; **pinned engine test** (§4.9.3):
exactly this shape.

**Wide-mask pricing (codex major 7 — the missing benchmark, now a
named gate).** Per-commit cost at site (b) is O(|`atomsTouched`|)
mark+dedup — duplicate atoms, which HEAD's append rule permits under
interleaved writes, cost O(1) each after the first via the read-clock
dedup — plus the deferred refold burst where consumption happens: the
commit's own drain for watched cones, the same boundary where HEAD's
re-staled loop already refolds every rendered watcher's cone through
gen-evicted memos (fable N-11: plausibly cheaper net; named in R5
either way). **The wide-mask lock-in shape is an S-A bench gate**
(§4.9.6): one commit locking in a token with W≈200 `atomsTouched`
against a committed arena shadowing all of them, measuring the
commit-phase fan+mark cost and the drain's refold burst vs the
head-bridge anchor — *fourth pass 2026-07-06: the gate now carries a
number and a failure disposition, §4.9.6 (≤ 1.4× the anchor; breach =
mid-stage STOP before S-B).*

This is also the honest form of the first pass's "lock-in fanout
replaces commit-generation re-keying": re-keying evicted the whole
arena because fp could not see below-max flips; (b)-fanout plus
refold-on-consumption refolds precisely the flipped atoms instead —
and under (iii) no site trusts a fingerprint, because none exists.

### 4.3 Invalidation: fanout at four flip sites, the pass-arena rule, and the ordering joint

`writeAtom`'s changed-write tail and the boundary operations fan into
live arenas with the read-clock dedup — but not uniformly:

- **Pass arenas receive NO receipt-driven fanout, ever.** The pin
  proof stands for everything receipts can do: every later write's seq
  postdates the pin (clause 2 excludes it), a later retirement's stamp
  postdates the pin (clause 1), compaction is pin-gated, and writes
  during render throw (RCC-UM2). So a pass-arena value, once folded,
  is valid for the pass's whole life AGAINST RECEIPT MOTION — enforced
  by a dev assert (a receipt-flip fanout reaching a pass arena is a
  bug). **The one pin-exempt mark source is L4 resource settlement**
  (§4.5.4): SU5 requires a suspended pass's retry to observe
  settlement, settlement is monotone (pending→settled, never a value
  revert), and RT1's freezing quantifies over STATE (receipts), not
  over resource entries — the contract's own L4 definition says
  entries are shared across views by key. Codex 5's schedule is
  exactly this: the assert is scoped to receipt flips so the
  settlement re-mark can pass.
- **Committed arenas receive fanout at COMMITTED-TRUTH motion.** The
  four sites and their code joints, each fanning the flipped atoms'
  shadows (mark + read-clock dedup) and propagating kernel-style
  PENDING over the arena's out-links (strong AND weak — §4.4):
  - **(a) retirement** — in `retireInternal`, after stamps + `cas` +
    compaction, before the drain loop: fan the retiring token's
    `atomsTouched` into EVERY committed arena.
  - **(b) per-root lock-in** — in `passEnd(commit)`'s
    `maskTokenRecords` loop, immediately after each
    `committedTokens.add`/`commitGen++`/`cas` and before that token's
    drain call: fan THAT token's `atomsTouched` into THAT root's
    arena, **per locked-in token** (m4 — commits lock in SETS of
    tokens; the fanout runs inside the per-token loop, not once per
    commit), with §4.2's refold-always consumption.
  - **(c) committed-member write** — at the write-path lines that set
    `committedDirtySlots`: fan the ONE written atom into each member
    root's arena. Marks only — the effect scan stays at the next
    boundary (EF2 as amended; §4.0).
  - **(d) quiet fold** — in `__quietWrite` after `base/cas` advance,
    before `quietDrain`/the sub scan (§4.1.2).
- **Newest needs no fanout**: the kernel's own propagate IS newest
  invalidation (unchanged).

**The ordering joint (amendment 6), in arena terms:** at every
boundary operation, fanout marks land immediately after the
committed-side mutation they describe and BEFORE any same-operation
committed-world evaluation — and both consumers of those marks (the
watcher drain's value re-checks and the boundary's
`revalidateCommittedSubs` scan at op end) are evaluations, so both see
the marked arenas. Concretely the per-site order is: mutate
(membership/stamps/cas) → fan → drain → …rest of the operation… →
`revalidateCommittedSubs` → `flushNotify`. One pinned ordering test
per site; site (c)'s marks land at the write, strictly before any
boundary that could scan them, which is what remains of codex-9's
first coupling after the EF2 ruling.

**Mark consumption discipline** (the keep-the-dirt analog): a shadow's
mark clears only when its refold/revalidation actually ran — marks are
consumed by evaluation, which is always safe because marks are
per-world and no other world can see them. Each committed arena keeps
a dirty LIST (ids appended on a mark's 0→1 edge — the arena analog of
`slotTouched`); a drain swaps the list, collects, and re-appends any
entry still marked after its evaluations, so an unconsumed mark (a
cone no observer evaluated) survives to the next boundary instead of
being lost. **The decay rule (third pass 2026-07-06 — fable N-5): the
re-append is not immortal.** When the drain's collection finds a
listed entry that no evaluation consumed THIS drain and whose node has
no live same-root watcher (the per-node watcher lookup the drain
already performs), it MAY evict the shadow's cached value and clear
the mark instead of re-appending — drop-to-cold. Never-serve-stale is
preserved by construction (a cold shadow refolds on demand — the same
evict-don't-serve shape as `validateMemoInner`'s rule; a subscription
whose boundary scan later evaluates that node hits cold and refolds
correctly), the invariant is amended to "a mark may never clear
without its refold having run OR its value having been evicted", and
the dirty list stays bounded by live consumers' cones — restoring the
write-free-boundary O(1) drain gate that immortal re-appends from
grown-then-shrunk sessions would erode (m6's pinned property).
**Pinned** (§4.9.3): the grown-then-shrunk schedule — mount a consumer
cone, unmount it, write-storm ⇒ dirty lists decay instead of
re-appending forever; remount ⇒ cold refold serves fresh values.

### 4.4 Deliveries and drains — the redesigned plumbing (the load-bearing section)

Today write-time value-blind deliveries walk K0∪K1; durable drains
seed from per-slot touched lists expanded over weak edges plus the
`restaled` set; mount fixup closes over reverse K1. NF2 deletes K1's
memo-invalidation job; the ROUTING jobs are re-homed as follows.

**4.4.1 Untracked-read coverage: per-arena WEAK LINKS (codex 3 / fable B1).**
The first pass's premise ("untracked reads leave no link in any
design") was false at HEAD — `recordWeakEdge` fires unconditionally on
every untracked read — and its TAINT replacement provably
under-covered. The replacement mechanism: **an untracked read records
a weak-flagged link in the evaluating arena** (one flag bit in the
link record's spare field; same record layout, same in-place-reuse
discipline), unconditionally, exactly as HEAD's weak table does —
restoring BOTH of HEAD's mechanisms with one structure:

- *Value validation* (B1's mechanism 1): weak links participate in
  mark/PENDING propagation and in `wCheckDirty` — a marked untracked
  dep refolds, value-compares per world, and on change marks its weak
  dependents PENDING, so the cached computed refolds. This is the
  structural transliteration of HEAD's "untracked dep enters the
  memo frame's fingerprint set".
- *Drain candidates* (B1's mechanism 2): drain collection expands
  marks over ALL arena links, weak included — subsuming HEAD's
  weak-expansion AND its strong-past-weak-hop rule (transitive arena
  propagation walks both kinds).
- *Never a notification carrier*: the write-time delivery walk tests
  the weak bit and does NOT traverse weak links (untracked reads never
  notify — HEAD's rule, preserved); newest-policy subscriptions keep
  kernel-links-only reach, matching HEAD (weak edges never fed
  `deliveryWalk` or `flushEffectQueue`).

Walked schedules: **codex 3's pinned battery member** ("taint member"
in `logged-battery.spec.ts`: `c = tracked(b) + untracked(a)`, watcher
on `d = c*1` in root A; T writes only `a` → no delivery ✓ (weak links
untraversed); U writes `b` → delivery ✓; T retires → site-(a) fanout
marks `a` in A's arena → weak `a→c` propagates PENDING → `c`, `d`
marked → drain collects the watcher off the dirty list → committed
re-evaluation → correction to 3 ✓ — the pinned schedule stays green
byte-identical). **Fable B1's read-before-pending schedule**: `C`
reads `A` untracked while committed-quiet — C's committed-arena
evaluation recorded weak `A→C` at that moment (recording is
unconditional, not pending-gated, which is exactly where TAINT
failed) → T writes `A`, retires → fanout + weak propagation + drain →
correction ✓. Newest evaluations record no weak residue anywhere —
matching HEAD's observable behavior, since HEAD's weak edges feed only
committed drains, and a node with a committed consumer gets its weak
links recorded by that consumer's own committed evaluations (§4.4.2).
Price: weak links are ordinary arena links (spike's link-record cost
tables apply); the delivery walk pays one bit test per traversed
arena link; TAINT and its propagation DELETE at S-B (its only
remaining consumer after the fast-path deletion below is `sweepK1`'s
keep-mask, which dies with K1) — the taint bit was strictly weaker
coverage than weak links, so nothing is lost.

**Mode semantics for mixed and changing tracked/untracked reads
(third pass 2026-07-06 — codex new-blocker 3).** One `(dep, sub)`
link record carries ONE mode bit, and the same dep may be read both
ways within one evaluation and differently across evaluations; the
reuse algorithm therefore maintains the bit explicitly:

- *Per-evaluation first-occurrence reset*: the FIRST occurrence of a
  dep in an evaluation SETS the link's mode from that occurrence's
  read kind (tracked ⇒ strong, untracked ⇒ weak), overwriting the
  previous evaluation's mode — on fresh links and on REUSED links
  alike (the reuse cursor's in-place/tail fast paths must perform
  this write; §4.7 carries the discipline into `wLink`, whose spike
  form early-returns with no mode logic and may not be transplanted
  bare).
- *Strong dominates duplicates*: a LATER occurrence of the same dep
  within the same evaluation may only upgrade weak→strong, never
  downgrade.
- *Total on reuse*: after any evaluation, every surviving link's mode
  is exactly "strong iff some tracked read of that dep occurred in
  that evaluation".

Walked — codex's schedule, both orders and both transitions: `C`
reads `A` tracked then untracked in one evaluation → first occurrence
sets strong, the duplicate cannot downgrade → strong; `A`'s write
delivers ✓. Untracked then tracked → first sets weak, the duplicate
upgrades → strong; delivers ✓. Across evaluations, untracked→tracked:
the reused link's first occurrence resets it strong — delivery
resumes ✓; tracked→untracked: reset to weak — delivery correctly
stops while validation and drain coverage continue over the weak
link ✓. **Observation capture takes STRONG occurrences only (OL1
protected):** the pre-dedup capture hook (§4.0/§4.7) rides the
TRACKED read path (`recordEdge` / the strong `wLink` arm) — exactly
HEAD, where `recordWeakEdge` never fed `obsCapture` — so an atom read
only-untracked gains NO retain and never triggers its observe
lifecycle; read both ways it gains exactly one retain, from the
strong occurrence. The second pass's "every dependency read" wording
is corrected to "every TRACKED dependency read". **Pinned** (§4.9.3):
the four-phase mode-transition schedule above, asserting
delivery/no-delivery plus drain coverage per phase, and the OL1
capture pin (untracked-only ⇒ no retain; mixed ⇒ one retain).

**The write-path cost story (codex major 6 — the named bench
shape).** HEAD keeps weak adjacency in a separate table the delivery
walk never visits; a combined per-arena link list makes the walk
visit-and-bit-test every weak edge merely to skip it — a hot atom
with K untracked-only dependents across R arenas pays O(R·K)
bit-tests per write where HEAD paid zero weak-edge delivery work.
**The untracked-fan shape is an S-B bench gate** (§4.9.6): one hot
atom, K≈100 weak-only dependents in each of R=4 committed arenas,
write-storm delivery cost vs the head-bridge anchor. The recorded
fallback if it regresses beyond the idle-world envelope: a per-shadow
SECOND out-list head segregating weak links (delivery walks the
strong list only; mark propagation and drains walk both) — same
record layout, one extra column per shadow, decided by the gate, not
built preemptively.

**4.4.2 The committed-arena POPULATION RULE (fable M1) — first-class.**
Fanout writes marks; drains expand marks over links; so the coverage
argument needs the arena to already HOLD the consumer's committed dep
links. The populators are the committed-world evaluations themselves —
link recording happens on every arena evaluation — and the rule names
their unconditional sites:

1. **The `passEnd` re-staled detection loop** — committed-evaluates
   EVERY rendered watcher's node at EVERY commit (mounted watchers
   included, since `mountWatcher` adds to `p.rendered`), recursively
   populating the root arena with each watcher node's full current
   committed dep cone (strong + weak) before `passEnd` returns —
   i.e., before any post-commit write needs routing. **This loop is
   hereby DECLARED load-bearing for routing** (M1's demand): its fate
   is survival verbatim plus a new dev assert pinning the property
   ("after a commit of pass P, every live `w ∈ p.rendered` has a
   shadow for its node in the root's arena") and a pinned schedule
   (M1's walked shape: mount `C=f(A)` in R, commit, handler write to
   `A` in fresh batch T2 → the walk finds `A→C` in R's arena →
   delivery ✓).
2. **Durable drains' value re-checks** and **`quietDrain`** — every
   correction compare is a committed evaluation.
3. **The boundary effect scans** — `captureRun`/`captureRead` and
   `revalidateCommittedSubs` evaluate every effect dep
   committed-for-root, populating the arena with effect-dep cones per
   run.
4. **The shim's reveal compare** (`resubscribeAtLayout`'s
   `committedValue` call) — M1's second unnamed carrier, named: it
   survives verbatim and is itself a populator.

Commit-time migration of pass-arena links into the committed arena —
M1's other candidate — is REJECTED, on lifetime grounds (§4.6): links
enter a arena only paired with the evaluation that chose them; a pass
world's dep choice can differ from the committed world's (that is
battery case 1's whole point), so migrated links would be
wrong-not-just-extra structure filed across a lifetime boundary. The
re-staled loop re-DERIVES instead, at a cost the engine already pays
today.

**4.4.3 Write-time delivery** becomes reachability over the kernel's
subs links ∪ every live arena's STRONG links (pass arenas included —
the walk visits structure, never values or marks, so §4.3's pin
invariant is untouched), collecting live `deliver`-subscriptions
(watchers) and enqueuing newest-policy subscriptions on visited nodes.
Value-blind by construction (RCC-SP5 preserved); the per-(watcher,
slot) dedup bit and the interleaved-delivery rule are per-subscription
policy, untouched. Per-arena walk-generation columns give termination
without allocation, as in the spike.

**4.4.4 The coverage argument, restated honestly (M1's sharpening
adopted).** Under NF2, deliveries and drain candidates share ONE
structural source — arena links — where HEAD had two independent nets
(episode-union K1 for deliveries; slot-touched lists + weak edges for
drains). A routing miss is therefore stale-until-cone-motion, not a
lane demotion; the first pass's R2 wording understated this and is
corrected in §6. The argument that the required coverage survives:
(i) an already-rendered consumer's links exist in its pass arena
(alive until pass end) and in its root's committed arena (populated
per §4.4.2, alive for the root's consumer-populated life per
§4.1/§4.5.8 — reclamation happens only at a ZERO-consumer quiescence,
when no coverage is owed to anyone, and rematerialization repopulates
before a new consumer's first post-commit write needs routing); (ii) dep flips re-track links at the refold that observes the
flip, and the write that CAUSES a flip is routable through the
pre-flip links (the discriminant edge argument), which the arena
holds; (iii) untracked deps are covered by §4.4.1's weak links in
every arena a committed consumer evaluates in.

**4.4.5 The known residual — codex 4's dead-arena gap: a SCOPED
RETREAT, pinned.** Schedule: committed `c = flag ? a : b` with
`flag=false`; parked T writes `flag=true` (delivered into T); T's
pass evaluates the `a` branch and is DISCARDED (its arena — and the
only `a→c` link — dies) while T stays pending; independent batch U
writes `a` in the gap. No live arena holds `a→c` (the committed
arena's links are `{flag,b}→c`, correctly — committed truth still
shows the `b` branch), so U's write delivers nothing to `c`'s
watcher. HEAD's episode-union K1 would have scheduled the watcher in
U's lane. Under NF2 the repair arrives at the next committed-truth
motion: when T commits, site-(b) fanout marks `flag`, the refold
re-tracks `c`'s committed links to `{flag,a}`, and U's later
retirement corrects value via the drain — value-correct, lane-
degraded. **This is accepted and DECLARED, not hand-waved**: RCC-SP5's
MUST half is met (the watcher's committed view did not change at U's
pending write; when it durably changes, the drain notifies), SP4
governs work the library schedules (here it schedules none at the
write), and the oracle's delivery comparator admits fewer engine
deliveries (⊆-counts) while its EXACT correction stream verifies the
repair. Pinned as schedule family **S-NF2-D1** in three
interleavings: second-write-before-pass-restart,
write-after-discard-before-restart, and codex 4's batch-attribution
variant — each with the documented degraded-but-correct expected
outcome, so any future silent worsening (or fix) diffs loudly.

**4.4.6 Durable drains** keep their trigger sites, id-order firing,
value gates, and the `restaled` merge (all landed P1 behavior); their
candidate set becomes: the root arena's dirty list (marks from §4.3's
sites, already expanded over strong+weak links at fanout time) →
collect live same-root watchers on listed nodes → union the
`restaled` set → sort by id → compare committed-vs-lastRendered.
Committed SUBSCRIPTIONS still do not drain here (boundary scans,
§4.0). The delivery-precedes-correction fuzz invariant is SCOPED per
m3: it asserts only for corrections caused by member-slot writes newer
than the watcher's last render, and excludes quiet-mode corrections,
mount-window repairs, older-write visibility flips, and the S-NF2-D1
family — m3's counterexamples — so it polices the class it can police
instead of crying wolf.

**4.4.7 Mount fixup** keeps its semantics wholesale (corrective loop +
four-conjunct fast-out + covered-audit + compare). `dependencyClosureOf`
walks reverse links over kernel ∪ the mounting pass's arena ∪ the
root's committed arena (three reverse walks; the pass arena is alive
here by §4.1/m2's ordering). That triple covers everything HEAD's
episode union held FOR THIS NODE except dead foreign cones, whose
exclusion is safe by the same discriminant argument — and the landed
fast-out AUDIT (divergence under a passing fast-out must be exactly
covered by scheduled correctives, asserted on every mount) is the
standing tripwire for closure under-coverage, so this narrowing is
audited at runtime, not assumed.

**4.4.8 The touched word, TAINT, and the world-read fast path.** Bits
0–30 and `slotTouched` die at S-B (drains seed from arena dirty
lists). The `evaluate()` fast path — "touched word 0 ⇒ serve the
validated newest memo to any world" — DELETES at S-A when world reads
route to arenas, and TAINT (its poison guard) with it at S-B. Price,
stated: cold first-reads in a fresh pass arena fold instead of
borrowing the newest cache. The spike's churn bench already measured
exactly this regime at parity (§3). **The cold-pass gate runs AT S-A,
with a number (third pass 2026-07-06 — both re-reviews flagged the
S-D staging):** §4.9.6's cold-pass shape (N≈200 quiet computeds,
first render) gates the S-A deletion itself, not a diagnosis three
stages later — acceptance is per-computed cold-read cost ≤ 1.4× the
head-bridge anchor on the same shape, the spike's own worst published
no-fast-path delta (none-dirty revalidation 12.0 → 16.7 ns, +39%,
rounded up); a breach is a mid-stage STOP that forces the re-entry
decision BEFORE S-B. **The TODO(perf) re-entry carries a correctness
constraint (fable N-4), written into the TODO text itself:** this
deletion is load-bearing for §4.4.1/§4.4.2 — the first committed
evaluation's cold in-arena fn run is what RECORDS the strong and weak
links the whole coverage argument stands on — so any future "provably
quiet" fast path may value-serve ONLY when the arena already holds
the node's links; structure recording may never be skipped. The B1
read-before-pending pin (§4.9.3) is the constraint's standing
tripwire: a re-entry that skips recording turns it red.

**4.4.9 Referee precision (fable N1, adopted).** `reconcile-correction`,
`react-effect-run`, `react-effect-cleanup`, and `core-effect-run` are
in the lockstep EXACT stream — only delivery/suppressed/
mount-corrective get the ⊆-counts bound. So a required-coverage miss
that changes any committed value is caught per-op at the next drain by
the exact correction compare, not merely "as downstream divergence";
the genuinely blind spots are lane placement (⊆-tolerant — where
S-NF2-D1's pins stand guard) and `ctx.use`/thenables (outside the
model — where §4.5.4's React-battery pins stand guard). Pinned-
schedule effort is allocated by that map.

### 4.5 Per-world policy state (item-by-item; this is where "simpler does not hold" lived)

1. **Folds** — §4.2; reuses `foldAtom`/`visibleAt` verbatim with
   §4.2's refold-on-consumption rule (third pass: no arena fp column
   exists; `fpOf` keeps only its surviving ladder role until S-C —
   §4.8); no new fold logic.
2. **Pins** — §4.3; the receipt-fanout ban plus pin-gated compaction
   are the entire pin story; no per-arena pin state exists; the one
   pin-exempt mark source is settlement (§4.5.4).
3. **Per-world equality (codex 6) — the record shape, made explicit.**
   The kernel's custom-equality `Computed` wraps its fn around the
   KERNEL value slot and returns the kernel's old reference on
   equality — calling that wrapper from a arena compares against the
   wrong world's previous value (codex 6's `[0]`/`[1]` counterexample:
   false change reported, reference preservation broken). The
   production shape separates four things:
   - *raw getter* — the unwrapped user fn, stored separately at
     construction (a side column keyed by kernel id, populated only
     when `equals` is non-default; default-equality computeds need no
     entry);
   - *comparator* — the `equals` fn, same side column;
   - *arena-local previous value* — the shadow's value-column slot in
     THE EVALUATING ARENA (never the kernel slot);
   - *exceptional-outcome bits* — per-shadow flag bits (has-box /
     box-suspended, mirroring the kernel's own box discipline) with
     the box payload in the value column.
   `wUpdate` then is: `prev = arena value slot; next = rawFn();
   changed = !(prevValid && !exceptional && equals(prev, next))` —
   **argument order is HEAD's `isEqual(prev, next)`, preserved (third
   pass 2026-07-06, codex checklist 6):** the second pass wrote
   `equals(next, prev)`, and comparators are not required to be
   equivalence relations — with `isEqual(old, next) = next <= old`,
   `prev=2, next=1` is EQUAL at HEAD (no change) but the flipped
   order reports a change and regresses the world to 1. Order
   preserved at every arena compare site, with a mirrored comment
   citing the kernel's `writeAtom` order. On unchanged, KEEP `prev`'s
   reference (write nothing, clear DIRTY, no propagate); on changed,
   store + propagate. Equality never bridges an exceptional boundary
   (value↔box is always changed; box→same-box by sentinel identity is
   unchanged — the arena-level twin of battery 16d's still-pending
   rule). Until S-C, overlay `ComputedNode`s get the same cutoff
   through the fn-reader epilogue writing the shadow value column
   (their equals semantics today are `Object.is` at the memo compare;
   unchanged).
   **Id tenancy (third pass 2026-07-06 — fable N-1).** Kernel node
   records are free-listed and REUSED (`nodeFreeHead`), and the
   kernel keeps a GEN field bumped on free precisely so stale ids can
   be defused; a permanent arena or a kernel-id-keyed side column
   outliving a disposed node would otherwise serve the dead node's
   value or run the dead node's rawFn/comparator under the reused id
   (mainstream post-S-C: `useComputed` deps change ⇒ old kernel
   computed disposed ⇒ id reused). The discipline, mirroring the
   pool's claim generations: **every arena shadow and every
   side-column entry stamps the kernel GEN observed at recording;
   serve/walk validates the stamp against the kernel's current GEN
   for that id; a dead-GEN shadow/entry never serves** — it is
   treated as cold (evict, refold under the new tenant, purge links
   lazily). This is an S-C ENTRY GATE beside the M6 pin (§4.8);
   pre-S-C stages are safe because overlay node ids are never freed.
   **Pinned tests:** one per equality arm, codex 6's
   reference-preservation shape run in three arenas at once, the
   comparator-order pin (a deliberately non-symmetric comparator,
   asserting HEAD-equal behavior), and the dispose-reuse-read
   schedule (dispose a custom-equality computed under a live
   committed arena, force id reuse, read — assert cold refold under
   the new tenant, never the dead value/fn) — §4.9.3.
4. **Sentinel boxes + SETTLEMENT (REWRITTEN WHOLE, third pass
   2026-07-06 — codex new-blocker 1, fable N-2/N-3/N-10; supersedes
   the second pass's `invalidateComputed` hook, which sat BELOW the
   event it had to observe).** A suspended background evaluation
   stores the thenable's stable `SuspendedRead` sentinel (`t.sr` —
   ONE identity per thenable, minted lazily by the kernel) in the
   evaluating arena's value column with the box-suspended bit, and
   appends the shadow id to that arena's **suspended list** (the
   dirty list's sibling) so settlement scans are O(suspensions), not
   O(shadows). **The list invariant (fourth pass 2026-07-06 —
   verifier major 2): append is gated on the per-shadow box-suspended
   bit's 0→1 transition, per (computed, arena).** The bit makes the
   list a SET: a repeat pending evaluation of an already-suspended
   shadow (same or different thenable — the value column just swaps
   sentinels) appends nothing. **Compaction (S-A step 0, 2026-07-06 —
   the fourth-pass verifier's missing removal mechanism): the
   per-shadow suspended field stores the LIST INDEX, not a bare bit**
   (a sentinel value means not-suspended; non-sentinel IS the set
   bit). On the 1→0 clear (refold to a value, eviction, arena
   reclamation) the entry is removed by **swap-remove at that index**:
   the list's last entry moves into the hole, the moved shadow's
   stored index is updated, the list pops. The list is therefore a
   DENSE set at all times — clear→re-suspend appends exactly one
   fresh entry, never a duplicate. Scanning is
   therefore O(current suspensions), never O(suspending evaluations),
   and idempotent marks never depend on list dedup — the list is
   deduped structurally by the index field. Render-path
   evaluations rethrow; the `suspendDepth` discipline stays
   adapter-side, unchanged. **Serving a box-suspended shadow
   RETHROWS the sentinel, `boxedRead`-style, after the self-heal
   probe below** — so the effect scan's 16d arm and the shim observe
   HEAD's thrown shape (fable N-10, answered). Settlement then has
   TWO halves, exactly the two the kernel itself needed:
   - **The push half — notification AT thenable settlement (codex
     new-blocker 1).** The second pass hooked `invalidateComputed`;
     HEAD reaches that primitive only when KERNEL `storeThrown`
     cached the thenable AND `attachSettle`'s stale guard passes — a
     world-only suspension never necessarily arrives there. The hook
     moves UP to the settlement event itself: **the kernel's
     per-thenable shared listener — the pair `unwrapThenable`
     installs exactly once per thenable to instrument
     `status`/`value`/`reason` — gains one call to a
     bridge-registered settle tap, `settleTap(t)`, after the status
     write.** **Sentinel minting — ONE rule, mint-on-tap (fourth pass
     2026-07-06, verifier major 2):** the tap's first act is the
     kernel's own lazy-mint expression, `t.sr ??= new
     SuspendedRead(t)` — create or look up. This is load-bearing for
     synchronous custom thenables: `unwrapThenable`'s default arm
     calls `t.then(listener)` BEFORE the `throw (t.sr ??= …)`
     statement runs, so a thenable that invokes its callbacks
     synchronously fires the tap while `t.sr` does not yet exist.
     Mint-on-tap closes the window with no second code path: the tap
     always holds THE sentinel identity, the later throw's `??=`
     reuses that same instance, and the suspending evaluation caches
     it — so the queued sentinel and the cached sentinel are one
     object and the epilogue scan (below) matches it by identity. (In
     that synchronous case no arena holds the sentinel at tap time —
     the throw hasn't been caught yet — which is harmless: the tap
     defers mid-evaluation by the firing rule below, and the
     operation's epilogue scan runs after the arena has cached it.)
     Distinct-thenable dedup IS the kernel's instrument-once
     discipline (one shared listener per thenable, by construction);
     distinct-computed dedup needs no listener bookkeeping because
     the tap's action is idempotent marking — the same computed
     suspended on `t` in three arenas takes three idempotent marks,
     and different computeds suspended on different thenables match
     only their own sentinel by identity. Registration: set at
     `registerReactBridge`, cleared at dispose, ONE closure per
     bridge, consulted at FIRE time (so listener-attach order vs
     bridge registration is immaterial, and a thenable instrumented
     before the bridge existed still notifies). Honest price, this
     time with the mechanism supplied: one branch in the kernel's
     shared listener + the per-arena suspended lists; zero
     per-key/per-computed/per-arena closures. Fire action: for each
     live arena (pass AND committed — the §4.3 pin-exempt case),
     scan its suspended list for shadows whose box payload IS `t.sr`
     (identity); mark DIRTY + propagate PENDING over strong and weak
     links, subject to the firing-context rule below. A dead arena
     is simply absent from the walk (nothing retains thenables). The
     kernel-cached path (`attachSettle` → stale-guarded
     `invalidateComputed`) is untouched and keeps handling KERNEL
     suspensions precisely; until S-C the shim's second ctx wiring
     forwards its settle callback through the same tap.
   - **The pull half — read-site self-heal (fable N-2).** The
     kernel's `boxedRead` tail self-heals a settled-but-not-yet-
     invalidated suspension AT THE READ, "so a read after `await` is
     deterministic even before the settle listener's microtask
     runs". Arenas transliterate it, mirrored comment at both sites:
     serving a box-suspended shadow first probes the cached
     thenable's status exactly as `boxedRead` does (`t.status ===
     undefined || t.status === 'pending'` ⇒ still pending ⇒ rethrow
     `t.sr`); settled ⇒ self-invalidate (mark + refold now; the
     PROPAGATE half rides the deferral rule below when mid-walk) and
     serve the refolded outcome. Without this half, `await K`
     followed by `committedValue(C, R)` in the continuation can
     observe pending AFTER settlement — ordering against the tap's
     microtask is not guaranteed, and is definitively lost for
     custom thenables settled before instrumentation — a window HEAD
     does not have and RCC-SU5 forbids.

   **The firing context (fable N-3) — REWRITTEN fourth pass
   2026-07-06 (verifier blocker: the third pass's "before
   `revalidateCommittedSubs`" was one insertion point, not a
   boundary; marking without an executable drain leaves a
   background-only suspended effect dirty until an unrelated
   operation, contrary to RCC-SU5).** The discipline is a
   transliteration of what the kernel's OWN settle listener already
   does — `attachSettle` does not merely invalidate, it invalidates
   and then runs the flush to completion when at rest
   (`E.invalidateComputed(c); if (batchDepth === 0) flush()`), and
   defers to the enclosing batch otherwise. Arena settlement adopts
   the same two modes plus an explicit fixed point, mirrored comment
   at the `attachSettle` site:
   - **ONE drain shape, and it OWNS the notification flush (S-A
     step 0, 2026-07-06 — the fourth-pass verifier's outermost-
     boundary gap).** The **settlement drain** is a single queue-
     owning loop, the only consumer of the pending-settlement queue,
     identical at every drain site:
     `do { take the queued sentinels; scan every live arena's
     suspended list (pass AND committed) for shadows whose box
     payload is a taken sentinel by identity — mark DIRTY + propagate
     over strong and weak links; drain the marked cones through the
     same durable-drain path every boundary uses (arena dirty lists +
     `restaled`; open-pass roots keep their marks for the frame's
     close, HEAD's own `openPassByRoot` deferral);
     revalidateCommittedSubs; flushNotify } while (queue nonempty)`.
     `flushNotify` is INSIDE the loop: HEAD invokes refire callbacks
     synchronously during `flushNotify`, and a callback that
     synchronously settles another custom thenable fires the tap
     mid-drain — its sentinel lands in the queue and gets the NEXT
     iteration. The drain never returns with a queued settlement
     unscanned OR unflushed. The drain IS the EF2 settlement boundary
     (settlement is one of the ruled committed-truth-advance
     boundaries, §2.4); §4.3's ordering joint is preserved per
     iteration (scans see the marks; keep-the-dirt carries unconsumed
     remainder forward).
   - **At rest** (no evaluation frame, no arena walk, no bridge
     operation in flight — the plain-microtask case, the kernel's
     `batchDepth === 0` arm): `settleTap(t)` enqueues the sentinel
     and runs the settlement drain NOW. A background-only suspended
     watcher or effect therefore refires FROM the settlement event
     itself — no unrelated operation is ever needed.
   - **Mid-operation** (any evaluation frame, arena walk, drain
     compare, `revalidateCommittedSubs` scan, or the settlement
     drain itself open): the tap ENQUEUES the sentinel on the
     pending-settlement queue (dedup via a queued bit on the
     sentinel, cleared when the drain takes it; marks are idempotent,
     so a duplicate landing is harmless). No arena flag column or
     dirty list is ever mutated under a mid-flight walk. EVERY public
     operation's epilogue, after the operation's own mutations
     complete, runs the settlement drain (the loop above; a no-op on
     an empty queue) — the LOOP, not any single insertion point, is
     what closes the windows the verifier named: a settlement landing
     DURING a watcher drain, DURING `revalidateCommittedSubs`, or
     DURING the drain's own `flushNotify` gets its OWN iteration.
   - **Read-context settlements (S-A step 0, 2026-07-06 — the
     stranded-entry fix).** Standalone `committedValue`/`passValue`
     and every other epilogue-less read surface keep the read-site
     status probe (the pull half, third pass N-2) for synchronous
     determinism — but a synchronous custom thenable can settle
     DURING such a read's evaluation frame, queueing its minted
     sentinel with no epilogue to consume it. **Enqueueing while no
     public operation (hence no epilogue) is in flight schedules a
     microtask drain — the kernel's own `attachSettle` discipline
     (`queueMicrotask`) — guarded by ONE scheduled-drain flag so
     multiple settlements coalesce into one drain.** The microtask
     runs the same settlement drain (no-op if an interleaving
     operation's epilogue already emptied the queue). The two halves
     partition exactly: operations drain at their epilogue, reads
     probe synchronously and the scheduled drain consumes the queue —
     no queued sentinel is ever stranded (retention bounded), no
     refire waits for an unrelated operation.
   - **Termination (S-A step 0, 2026-07-06 — replacing the fourth
     pass's at-most-once-per-thenable argument, which distinct
     thenables defeat).** The loop adopts the engine's existing
     flush bound discipline verbatim: settlements taken per iteration
     are finite; a chain of user callbacks that synchronously settles
     ever-new thenables extends the loop exactly like an effect that
     endlessly re-notifies extends `flushNotify` — that is USER
     feedback, not a system obligation. The loop carries an
     **iteration cap with a dev diagnostic on breach**
     (`BridgeInvariantViolation` naming the settlement chain), the
     same posture as the structural validator's cycle caps: bound the
     damage, name the user bug, never mask it as progress.

   **The verifier's background-only schedule, walked green (fourth
   pass 2026-07-06):** committed watcher's dep `C` suspends on
   thenable `T` in R's arena (sentinel cached, suspended list gains
   `C` on the bit's 0→1) → the app goes fully at rest — no operation
   open, no further writes → `T` settles → the shared listener
   writes status → `settleTap(T)`: no frame open ⇒ the settlement
   drain runs NOW — suspended-list scan matches `t.sr`, marks +
   propagates; the cone drain refolds `C` (sentinel→value IS a flip,
   §4.5.3); `revalidateCommittedSubs` re-checks R's subscriptions;
   `flushNotify` delivers the correction/refire. SU5 holds with no
   unrelated operation. Variant, mid-operation: `T` settles inside
   an unrelated write's watcher drain ⇒ enqueue ⇒ that operation's
   epilogue, iteration 1: scan + mark + cone drain +
   `revalidateCommittedSubs` ⇒ queue empty ⇒ `flushNotify`. A
   settlement landing during THAT scan gets iteration 2. Pinned
   below as the at-rest background-settlement pin.

   **Codex's key-A/key-B schedule, walked green:** committed R
   evaluates `C` with world key A → `ctx.use` tracks thenable A (the
   shared listener attaches, once) → evaluation suspends → R's arena
   caches sentinel-A, suspended list gains `C`. Newest evaluates `C`
   with key B → kernel `C` caches B's SETTLED value; kernel never
   cached A and never will. A settles → the shared listener fires
   (it is attached to thenable A itself, independent of kernel `C`'s
   cache state or any stale guard) → status write → `settleTap(A)` →
   the suspended-list scan finds R's shadow of `C` holding
   sentinel-A → mark + propagate (deferred iff mid-op) → the
   settlement drain — run immediately at rest, or by the ENCLOSING
   operation's own epilogue fixed point, never a later unrelated
   operation (fourth pass 2026-07-06) — refolds `C` in R → `ctx.use(keyA)` now
   hits the settled L4 entry → sentinel→value IS a flip (§4.5.3) →
   correction/refire. No stranded clean sentinel. Fable M2's
   schedule stays green — the tap strictly subsumes the old hook's
   trigger. **The HEAD-gap claim, restated honestly (fable's
   correction):** at HEAD, overlay evaluations never CACHE sentinels
   (a throwing evaluation stores no memo), so every re-check re-runs
   the fn and picks settlement up for free — NF2 INTRODUCES the
   background caching, and both halves above are the new mechanism's
   own necessary companions, not primarily a HEAD repair; only the
   kernel-path variant of the gap may predate NF2. **Pins (§4.9.3):**
   the key-A/key-B world-only settlement engine pin (above, verbatim);
   the read-after-await pin (suspend committed, cache the sentinel,
   `await` the key, read `committedValue` in the continuation —
   deterministically settled, N-2); the firing-context pin (a
   synchronously-settling custom thenable settling inside a drain
   compare — deferred marks land at the op epilogue's drain-to-empty
   loop, structural validator green, N-3); **the at-rest
   background-settlement pin (fourth pass 2026-07-06 — the verifier's
   blocker schedule, verbatim: suspend a committed watcher's dep in
   the background, go fully at rest, settle — assert the
   correction/refire arrives from the settlement drain itself, with
   NO subsequent operation; plus the mid-drain variant asserting the
   epilogue fixed point consumes a settlement that lands during a
   watcher drain)**; **the step-0 quartet (S-A step 0, 2026-07-06):
   the reentrant settle-during-flush pin (a refire callback invoked
   by the drain's `flushNotify` synchronously settles another
   thenable — the NEXT loop iteration delivers it before the
   operation returns); the read-context microtask drain pin (a
   synchronous custom thenable settles during a standalone
   `committedValue` — the coalesced `queueMicrotask` drain consumes
   the queued sentinel; nothing stranded, refire arrives with no
   subsequent operation); the termination-cap pin (a settlement
   chain that mints ever-new synchronously-settling thenables trips
   the iteration cap's dev diagnostic instead of hanging); the
   list-compaction pin (suspend → clear → re-suspend leaves ONE
   dense suspended-list entry; swap-remove keeps every stored index
   valid under interleaved clears)**; the React-battery
   background-settlement
   case (the coverage fable M2 showed the battery lacks); RCC-SU5
   cited in all.
5. **`ctx.use`** — unchanged L4 semantics: ONE per-key cache scoped to
   the living node, shared across worlds BY DESIGN (SU3's key carries
   world-varying inputs). Arenas add only §4.5.4's re-mark. The F5
   unification still deletes the shim's second wiring at S-C in favor
   of the kernel ctx layer's packed side-column cache.
6. **`ctx.previous`** — unchanged from the first pass: inside a world
   evaluation frame `previous` serves the node's last-COMMITTED cell
   (maintained at `passEnd(commit)`, moving from `shim.previousCells`
   into the bridge at S-C); plain path keeps kernel semantics; its own
   test.
7. **Read-clock wrap (int32)** — per-arena clocks renumber (stamps
   zeroed, clock reset) at quiescence as §4.1.1's new `quiesce()`
   duty; a forced-wrap test drives a arena past 2^31 stamps via a
   test-only clock preset. If quiescence proves too rare in
   long-session profiles, the fallback (widen to float64 columns) is
   recorded; decided at implementation, tested either way.
8. **Committed-arena RECLAMATION — the watcher-population refcount
   (NEW §4.5.8, third pass 2026-07-06 — codex new-blocker 4, fable
   N-6/N-7).** Permanence with no death event was disguised resource
   unsoundness: populate an arena, unmount every consumer, repeat
   with fresh root containers — unbounded buffers, links, and cached
   references, with every fanout/settlement scan O(roots ever seen)
   and quiescence renumbering dead arenas' stamps forever. The
   mechanism:
   - *The refcount.* Each `RootState` keeps `consumerCount`: live
     watchers of that root + `run/committed` subscriptions of that
     root, incremented/decremented by exactly the existing lifecycle
     events (`mountWatcher` / watcher unmount + orphan sweep;
     subscription registration / `removeSubscription`). No new
     protocol events; the count is derivable, dev-asserted against
     the registries.
   - *The reclamation point.* At `quiesce()`, BEFORE read-clock
     renumbering (§4.1.1): every live committed arena whose root's
     `consumerCount === 0` is RELEASED — buffer returned to the pool
     with its claim generation bumped (dead-tenancy residue can never
     validate, §4.6), value columns dropped (payload release — the
     dead-root half of fable N-6), dirty + suspended lists discarded
     (their unconsumed marks describe cones nobody observes — safe by
     the same evict-don't-serve argument as §4.3's decay rule),
     root removed from `arenasLive`. The root RECORD stays: it is
     small, and no teardown event exists to remove it (fable N-7) —
     an honest residue, bounded by RUL-6's fallback.
   - *Why quiescence is the safe point.* The residue asserts prove
     all tapes empty ⇒ committed == newest for every root ⇒ the arena
     is pure re-derivable cache with no pending flip owed to anyone —
     and zero consumers means no deliveries or re-checks are owed at
     all (SP5 quantifies over consumers). Mid-episode zero-crossings
     do NOT reclaim (marks/boxes may be in flight; the arena is cheap
     to keep until the rest point).
   - *Rematerialization.* The SAME lazy path as first materialization
     (§4.1): a later consumer's first committed evaluation claims a
     fresh arena, and §4.4.2's population rule — the `passEnd`
     re-staled loop at the very commit that makes the watcher live —
     rebuilds the cone links BEFORE any post-commit write needs
     routing. Coverage is never owed in the unpopulated window
     because coverage is owed only to consumers.
   - *"Permanent for the root's life", reconciled.* LIFE is redefined
     as CONSUMER-POPULATED life: the span with ≥1 committed consumer,
     extended to the next quiescence. §4.1, §4.4.4(i), and the §4.6
     row now say so. B2's one-story property is preserved: still one
     story, now with a defined death.
   - *Cost honesty (fable N-6).* While populated, value columns
     retain cached derived values (arbitrarily large app objects)
     that HEAD freed at EVERY quiescence (`quiesce()` clears the
     committed memo tables). That retention-class delta is stated in
     R5, with a recorded option decided by measurement (like the
     read-clock fallback): a quiesce-time value-column sweep for LIVE
     arenas too — drop values to cold, KEEP shadows/links so routing
     coverage (§4.1's whole point) survives; refold on demand.
   - *Scan bounds restored.* Fanout, settlement taps, and quiesce
     renumbering are O(consumer-populated arenas + not-yet-quiesced
     dead ones), never O(roots ever seen).
   - *The fallback (owner decision, recorded OPEN — RUL-6).* No
     root-destroy event exists in the fork protocol. If refcount
     reclamation proves insufficient — the known holes are an app
     that NEVER quiesces while dead roots accumulate, and the
     immortal root records themselves — the fallback is a
     fork-protocol root-destroy notification (host teardown ⇒ drop
     arena + root record immediately). Adding a protocol event is an
     owner call; recorded open, not presumed.
   **Pinned tests (§4.9.3):** the root-churn retention schedule
   (mount → commit → unmount all consumers → quiesce ⇒ arena
   released, pool count restored, `arenasLive` shrinks; touching a
   reclaimed arena throws — m2's dev-assert discipline) and the
   rematerialization schedule (remount after reclamation → handler
   write → delivery routes; §4.4.2's population pin re-run against a
   reclaimed-then-rebuilt arena).
9. **Growth-mid-op reload** — every allocating world call re-loads
   `w.W`; enforced by (a) the spike's structural validator promoted to
   a dev-mode invariant run after every op in engine tests, (b) a
   stride-sized-initial-arena test so every growth path exercises
   mid-walk, and (c) React scenarios run with a tiny default arena
   size in test builds (the R8 hunt, unchanged).

### 4.6 Lifetime classification (contract §2/§6 step 1 — the mandatory table; REVISED third pass 2026-07-06)

Every piece of state Program 2 introduces (contract rule: classify
BEFORE choosing the data structure; the "derived-of" column says what
the state is bookkeeping ABOUT, since caches inherit obligations from
what they mirror). **Third pass, per codex blocker 5: every row now
carries EXACTLY one of L1/L2/L3/L4** — the second pass's "L1-derived",
"same lifetime as their arena", and "node lifetime" hybrids are
expanded — **except the three genuinely-infrastructure rows, which are
NOT forced into invented categories and instead sit under the owner
block at the table's foot.** **Fourth pass 2026-07-06 (verifier
verdict 5, under the now-GRANTED RUL-5):** the third pass's remaining
L1 labels were still not semantically exact — L1 state "must survive
everything" (contract §2), while committed arenas, their marks, and
their cached outcomes are destroyed at zero-consumer quiescence
(§4.5.8). The ruling's letter resolves this without force: the
four-lifetime rule is scoped to application and history state —
content a consumer could observe that is not rebuildable from
classified state — and these rows are REBUILDABLE CACHES of
classified content. They are re-labeled below as
**mechanism: cache of L1 (or L3/L4) content**, each carrying the
exemption's mandatory actual-lifetime + reclamation documentation in
its created/destroyed columns.

| state | lifetime | derived of | created | destroyed | teeth (what the classification forbids) |
|---|---|---|---|---|---|
| pass arena (shadows, strong+weak links, value columns, marks, walk/read-clock stamps) | **L3** per-attempt | the pass world's frozen view | `passStart` (pool claim) | `reclaimAfterPassEnd` (pool release; after fixup + re-staled loop, m2) | never consulted by fold/visibility machinery; nothing in it survives the pass — no value/link migration to any other arena (§4.4.2's rejection); settlement re-mark may INVALIDATE entries, never persist them |
| committed arena (same columns, per root) | **mechanism: cache of L1 content** (RUL-5 exemption regime — fourth pass 2026-07-06; not itself L1: consumers observe committed truth THROUGH it, never state existing only in it. Actual lifetime + reclamation, per the exemption's mandate: destroyed at zero-consumer quiescence, rebuilt lazily on the next consumer; content re-derives from L1/L2 history via `foldAtom` over tapes/base, so reclamation loses no observable state. Obligation inherited from the L1 content it mirrors: never-serve-what-tapes-don't-support) | `foldAtom` over tapes/base per the visibility rule | lazily at the root's first committed evaluation; rematerialized the same way (§4.5.8) | zero-consumer quiescence reclamation (§4.5.8) or bridge dispose — **no root-teardown event exists** (fable N-7; RUL-6 records the fallback) | never a source of truth (tapes+base are); serves only through the §4.2/§4.3 mark discipline; holds no receipt, stamp, or payload the tape doesn't; a shadow with a dead kernel GEN never serves (§4.5.3 id tenancy) |
| fanout marks + per-arena dirty/suspended lists | **mechanism: cache-maintenance state of its owning arena's content — L3 content (pass) / L1 content (committed)** (RUL-5 exemption regime — fourth pass 2026-07-06. Actual lifetime + reclamation: consumed by evaluation, decayed by eviction, discarded with the arena at zero-consumer quiescence; a discarded mark's work is re-derived by the refold the §4.3 decay rule licenses, so no observable state is lost) | pending invalidation/settlement facts about that arena | flip sites (a)–(d), settlement (§4.5.4) | consumed by evaluation, decayed by eviction (§4.3, fable N-5), or with the arena (§4.5.8) | a mark may never clear without its refold having run OR its value having been evicted (the §4.3 decay rule); marks never cross arenas |
| per-arena cached evaluation outcomes: values, `SuspendedRead` sentinels, error boxes, outcome bits, arena-local previous values (§4.5.3–4) | **mechanism: cache of one world's evaluation outcome — L3 content (pass) / L1-or-L4-derived content (committed)** (RUL-5 exemption regime — fourth pass 2026-07-06. Actual lifetime + reclamation: overwritten by refold, evicted to cold, destroyed at zero-consumer quiescence; rebuilt lazily by re-evaluation — content derives from L1/L2 history (folds) or the L4 entry (sentinels/settled payloads), so no observable state is lost) | one world's last evaluation outcome | that arena's evaluation | with the arena, overwritten by refold, or evicted to cold (§4.3 decay / §4.5.8 value sweep) | a sentinel cached here is an OUTCOME record, not the resource: it must be invalidatable without touching the L4 entry (§4.5.4, both halves) and must never gate another world's read |
| the `ctx.use` per-key entry (thenable, settled value) | **L4** (unchanged, pre-existing) | the request | first read of the key | with the living node (WP3) | keyed by request, never by consumer or arena; monotone; shared across worlds by design |
| arena POOL (free Int32Array buffers) | **foot block** (infrastructure) | — | bridge init / growth | bridge dispose | holds NO tenant state between claims; each tenancy stamps a claim generation; the validator rejects any record citing a dead generation (no I4-shaped immortal residue) |
| the settlement tap + pending-settlement queue (§4.5.4) | **foot block** (infrastructure) | — | `registerReactBridge` | bridge dispose | one closure + one small queue per bridge; holds the bridge only; **queued-entry lifetime, stated truly (fourth pass 2026-07-06 — the third pass's "retains no thenables" was FALSE: a queue entry is a `SuspendedRead`, which strongly holds its thenable, `index.ts` `readonly thenable`):** the queue retains each settled thenable exactly from tap landing to the next drain — released at the at-rest settlement drain or the next operation epilogue's drain-to-empty, so retention is bounded by the §4.5.4 fixed point, never open-ended; marks idempotent; arenas looked up at fire time |
| per-kernel-id rawFn/equals side column (§4.5.3) | **foot block** (infrastructure) | the authored computed | node registration | node disposal | policy lookup only; never consulted by folds; every entry GEN-stamped — a dead-GEN entry never serves (§4.5.3 id tenancy, S-C entry gate) |

> **RUL-5 GRANTED (owner ruling 2026-07-06, recorded as the contract
> §2 scope amendment; foot block updated fourth pass 2026-07-06).**
> The ruling took option (b): the four-lifetime rule governs
> application and history state — anything whose content a consumer
> could ever observe and which is not rebuildable from classified
> state; mechanism infrastructure sits outside the taxonomy but MUST
> document its actual lifetime and reclamation per row. That letter
> covers the three foot rows (pool, tap/queue, policy columns) — and,
> per the third-pass verifier's verdict 5, it is also what makes the
> arena/marks/outcomes rows above exact: they are rebuildable caches
> whose observable content is L1 (or L3/L4) content served THROUGH
> them — destroyed at zero-consumer quiescence, rebuilt lazily,
> re-derivable from tapes/base — so an L1 label falsely promised the
> survive-everything immortality §4.5.8's reclamation deliberately
> breaks. Re-labeled above as mechanism-caches under the exemption,
> each with the mandatory lifetime+reclamation documentation. The
> per-row teeth are unchanged and mandatory. **No longer blocks S-A's
> §4.6 sign-off (§5 gate ii — RUL-5 is answered).**

No new L2 state exists: Program 2 writes no receipts and touches no
retirement machinery (§3 item 8). The P1 subscription record's
classification (§2.3) is unchanged. Resistance check (contract §6),
re-run for the fourth pass 2026-07-06: the rows that still carry a
lifetime carry it without force — the pass arena IS L3 (it dies with
its attempt, exactly what L3 demands, at `reclaimAfterPassEnd`); the
`ctx.use` entry IS L4. The rows that resisted in the third pass —
labeled L1 while §4.5.8 destroys them at zero-consumer quiescence,
the exact contradiction verdict 5 named against the contract's
"survive everything" — no longer resist because they are no longer
forced: they are mechanism-caches of classified content under
RUL-5's granted letter, documented with their true lifetime and
reclamation. Nothing observable rides on them (a cached sentinel is
an arena-lifetime OUTCOME of reading an L4 entry, not the entry;
arena values re-derive from tapes/base), which is precisely why the
exemption covers them.

### 4.7 The ~300 lines of walk specializations — and the two disciplines they must carry

The first pass's honest answer stands (parameterizing the kernel's
walks taxes world-0; codegen trades line count for build machinery;
realistic landing ~300 lines of fenced duplication with the
`KERNEL-WALK-MIRROR` convention, the structural validator after every
op, and the hang schedule pinning both). Two additions from review:

- **The obsCapture pre-dedup discipline in `wLink` (fable M6 /
  codex 9).** P1 landed the rule in `recordEdge`: observation capture
  fires on EVERY dependency read BEFORE any reuse/dedup check. The
  spike's `wLink` returns early for an in-place reused dependency —
  if S-C transplants that shape verbatim, a world re-evaluation with
  unchanged deps captures an empty set and releases retains while the
  watcher lives (RCC-OL1 violation, silently arriving at R4's
  rejected arm). Rule: the world walks route every TRACKED dependency
  read (strong occurrences only — §4.4.1's OL1 rule, third pass
  2026-07-06) through the same capture hook AT THE READ, before
  `wLink`'s reuse cursor logic — mirrored comment at both sites. **Pinned BEFORE S-C
  lands** (M6's schedule): observed computed `C` with committed-world
  deps `{A}` and newest deps `{B}` (world-divergent flag); drive a
  committed re-evaluation through a drain — via the WORLD path — and
  assert `A` gains/holds its retain and `B`'s releases.
- **The weak bit in the walks (§4.4.1):** `wPropagate`/mark
  propagation traverse weak links; the delivery walk skips them;
  `wCheckDirty` consults them; teardown unlinks them identically.
  The validator checks weak-link list symmetry exactly like strong.
  *(third pass 2026-07-06)* `wLink`'s reuse cursor additionally
  carries §4.4.1's MODE maintenance — first-occurrence reset and
  strong-dominates-duplicates happen on the in-place/tail fast paths
  too; the spike's early-return has no mode logic and may not be
  transplanted bare (codex new-blocker 3). Mirrored comment at the
  kernel `link` site.

### 4.8 Migration path, re-derived so every stage is green-runnable (codex 7)

The +0.5 ns computed-read seam still lands only in S-C. The stages,
each with its executable-state answer, what it deletes, and its
divergence rule:

- **P2.S-A — arenas as the WHOLE value+invalidation layer for pass
  and committed worlds; K1 still owns all routing.** Honest contents
  (m1's restatement adopted — this is the majority of NF2's new
  write-path logic, not a value-store stub): arena
  allocator/registry/claim-generations; shadow records + strong/weak
  link recording BY THE EXISTING fn-reader (`trackedReader`/
  `untrackedReader` record into the active world's arena in addition
  to K1), including §4.4.1's weak-mode maintenance (third pass);
  folds into value columns under §4.2's no-fp consumption rule (the
  fp column is never built; `foldAtom` reused verbatim, its
  `lastFoldFp` store retained — §4.2 fourth pass 2026-07-06); ALL
  FOUR flip sites + BOTH settlement halves with the pending-settlement
  queue, suspended lists, AND the operation-epilogue drain-to-empty
  fixed point + at-rest settlement drain (§4.3, §4.5.4 fourth pass
  2026-07-06) — mandatory in this stage, since with
  `validateMemoInner`'s pass/committed arms deleted, arena values
  are correct ONLY under complete fanout; §4.3's mark decay rule;
  the §4.5.3 equality record with HEAD's comparator order; the
  §4.5.8 refcount + quiesce reclamation sweep; the world-read fast
  path deletes (§4.8 note: its cold-pass gate is AT THIS STAGE,
  §4.4.8).
  **The temporary newest representation (codex 7's demand):
  `newestMemos` + the newest arm of `validateMemo`/`fpOf` SURVIVE
  S-A and S-B** — `ComputedNode` has no kernel links until S-C, so
  newest reads, core-effect flushes, and obsEnter discovery keep the
  ladder's newest arm; only the pass/committed arms
  (`passClocksQuiet`/`committedClocksQuiet`, the per-dep fp scans,
  `Pass.memos`/`RootState.memos`) delete now. **What dual bookkeeping
  actually compares:** the lockstep per-op world snapshots
  (newest/committed-per-root/open-pass values) plus the EXACT
  correction/effect event streams are the cross-check between the
  arena values and the model; the structural validator checks each
  graph internally. **Divergence mid-stage is a STOP** — with K1
  still routing, any lockstep diff indicts the arena value layer
  (folds/fanout/equality/boxes) in isolation, which is this stage's
  entire point (§6-R3). **Bench gates at this stage (third pass
  2026-07-06):** dual-write cost within the spike's live-world
  envelope; the cold-pass shape with its ≤1.4× threshold (moved
  here from S-D — both re-reviews; it gates the fast-path deletion
  this stage performs, §4.4.8); the wide-mask lock-in shape (§4.2 /
  §4.9.6, codex major 7). **Test-first additions this stage**
  (red-first where the mechanism doesn't exist yet, §5 gate iii):
  the key-A/key-B world-only settlement, read-after-await,
  firing-context, and at-rest background-settlement pins (§4.5.4,
  fourth pass 2026-07-06); the mixed-mode strong/weak schedule
  + OL1 capture pin (§4.4.1); the fp-100/seq-50 walk under no-fp
  (§4.2); the root-churn retention + rematerialization pins
  (§4.5.8); the grown-then-shrunk decay pin (§4.3); the
  comparator-order pin (§4.5.3).
- **P2.S-B — routing re-homed; K1 deleted.** Delivery walk →
  kernel ∪ arenas with the weak-skip (§4.4.3); drains → arena dirty
  lists + `restaled` (§4.4.6); mount fixup closure → the §4.4.7
  triple; quiesce body shrinks (no K1 reset, no kernel-pull refresh,
  no weak reset; arenas persist; read-clock renumber added). Deletes:
  `outSets`/`outList`/`inList`, `recordEdge`'s K1 half (the
  obsCapture hook and arena recording remain in the fn-reader),
  `sweepK1`, `propagateBits`/`applyBits`/`slotTouched`/touched bits
  0–30, TAINT + `propagateTaint`, `weakOutSets`/`weakOutList`,
  `recordWeakEdge` (superseded by arena weak links), `subDepRefs`
  (§4.0), the quiesce refresh-target scan. Delivery-decision changes
  are possible here (fewer, never more): the ⊆ bound plus S-NF2-D1
  and the §4.4.2 pins police it; comparator noise beyond the
  documented band is a STOP, not a tolerance to widen. **Bench gate
  at this stage (third pass 2026-07-06):** the untracked-fan shape
  (§4.4.1 / §4.9.6, codex major 6) — the weak-edge bit-test cost
  lands with this stage's walk re-home, and the segregated-list
  fallback is decided here if it regresses.
- **P2.S-C — F5: one computed.** Kernel `Computed` evaluates under
  worlds via the transliterated walks carrying §4.7's disciplines.
  **TWO entry gates, each written and green against S-B first (third
  pass 2026-07-06): the M6 world-path retain pin, and fable N-1's
  dispose-reuse-read id-tenancy pin** — the identity re-key walks
  into the kernel's free-list id reuse otherwise, and §4.5.3's GEN
  stamps are what make it sound. The fn-reader/`ComputedNode` path,
  `newestMemos` + the ladder's last arm, the shim's second ctx wiring,
  `makeComputedNode` + `previousCells`, and `useSignal`'s kernel-
  computed rejection all delete; the read seams land (+0.5 ns pinned);
  `useComputed` keeps its deps-keyed contract (WP3). Node identity
  re-keys to kernel ids — the §4.5.3 side columns are already keyed
  (and GEN-stamped) that way. The hang schedule pins GREEN here (it
  needs kernel computeds under worlds; it is ported and red-wired
  during S-A).
- **P2.S-D — perf closure.** Arena pooling hardened, wrap tests,
  full bench battery (§4.9.5), spike benches ported under real names
  (F7 hygiene), README/API docs for the unified computed story;
  **named line item (fourth pass 2026-07-06, §4.2):** remove
  `foldAtom`'s `lastFoldFp` store — dead weight since S-C deleted the
  ladder's newest arm, its last reader; kept verbatim through
  S-A/S-B/S-C by §4.2's reuse-verbatim choice.

Each stage remains its own verified commit series with a revert story
(additive until the stage's deletion commit, which lands last).

### 4.9 Verification gates (Program 2)

1. **The hang schedule** as a permanent regression (ported at S-A,
   pinned green at S-C — §4.8) plus the pinned `__naiveWorldRead`
   corruption witness; the structural validator (with claim-gen and
   weak-symmetry checks) after every op in engine tests from S-A.
2. **Per-view acyclicity fuzzed** (NF2 entry criterion #2):
   schedule-generator coverage of battery case 1's union-cycle member
   + the validator's cycle caps under fuzz.
3. **The review-mandated pins, by name (extended third pass
   2026-07-06):** codex 3's "taint member" battery schedule green
   byte-identical (§4.4.1); fable B1's read-before-pending schedule
   (new engine pin; doubles as the §4.4.8 re-entry tripwire); fable
   B3's seq-50-under-100 lock-in shape, re-walked under the no-fp
   rule (§4.2); M1's population schedule + the post-commit population
   assert (§4.4.2); S-NF2-D1 ×3 interleavings with documented
   degraded-but-correct outcomes (§4.4.5); **the settlement octet
   (§4.5.4; trio extended fourth pass 2026-07-06; quartet extended
   S-A step 0, 2026-07-06): the key-A/key-B
   world-only settlement pin, the read-after-await self-heal pin,
   the firing-context settle-inside-a-drain pin, the at-rest
   background-settlement pin (settle with no operation open ⇒ the
   settlement drain itself delivers; mid-drain variant ⇒ the
   epilogue fixed point consumes it), the reentrant
   settle-during-flush pin (a refire callback settles another
   thenable ⇒ the next drain iteration delivers it), the
   read-context microtask drain pin (settle during standalone
   `committedValue` ⇒ the coalesced `queueMicrotask` drain consumes
   the queued sentinel), the termination-cap pin (a
   self-perpetuating settlement chain ⇒ dev diagnostic at the
   iteration cap), and the suspended-list compaction pin
   (clear→re-suspend ⇒ one dense entry; swap-remove index
   integrity)** + the React-battery
   background-settlement case (RCC-SU5); **the mixed-mode
   strong/weak transition schedule + the OL1 strong-only capture pin
   (§4.4.1)**; codex 6's reference-preservation shape ×3 arenas +
   **the comparator-order pin (non-symmetric comparator, §4.5.3)**;
   **the root-churn retention + rematerialization pins and the
   reclaimed-arena-touch dev assert (§4.5.8)**; **the
   grown-then-shrunk mark-decay pin (§4.3)**; M6's world-path retain
   re-point schedule and **the dispose-reuse-read id-tenancy pin
   (§4.5.3)** as S-C's two entry gates (§4.7, §4.8); m2's
   arena-drop-after-fixup dev assert; the §4.3 per-site ordering
   pins; the m3-scoped delivery-precedes-correction fuzz invariant.
4. **Full battery per stage**: package suites, 17-case battery at
   model and React level (16b–16h included — the P1 boundary pins
   must stay green untouched through every P2 stage), scars, flags,
   conformance ×3, typechecks.
5. **Lockstep**, with the oracle-survival claim verified as before
   (the model is representation-free where NF2 changes
   representation), and fable N1's precision adopted: corrections and
   effect runs are EXACT-stream compared, so value-changing coverage
   misses surface per-op; residual blind spots are lane placement
   (S-NF2-D1 pins) and thenables (React battery + §4.5.4 pins,
   declared in `tests/SKIPPED-FOR-FORK-SUITE.md`).
6. **Bench battery (third pass 2026-07-06: four review shapes, two
   of them staged as GATES, not S-D diagnostics)**: sync shapes with
   the head-bridge anchor; discard churn (bulk + surgical); world
   evaluation (1/all/none dirty); idle-world scaling at w1/w4; plus:
   - the write+commit+drain CYCLING shape (fable N2 — the read-clock
     dedup resets every consume cycle, so idle-mark numbers alone
     under-price drain-heavy apps);
   - the **cold-pass shape** (N≈200 quiet computeds, first render) —
     **an S-A gate with a number**: per-computed cold read ≤ 1.4×
     the head-bridge anchor (§4.4.8's derivation from the spike's
     worst no-fast-path delta); breach is a mid-stage STOP;
   - the **wide-mask lock-in shape** (codex major 7 / fable N-11):
     one commit locking in a token with W≈200 `atomsTouched` against
     a committed arena shadowing all of them — commit-phase fan+mark
     plus the drain's refold burst vs the head-bridge anchor; **an
     S-A gate WITH a number and a disposition (fourth pass
     2026-07-06, mirroring the cold-pass gate's form):** end-to-end
     commit+drain cost on the shape ≤ 1.4× the head-bridge anchor —
     the threshold reuses the spike's worst published delta (+39%,
     none-dirty revalidation 12.0 → 16.7 ns, rounded up), which is
     the regime a wide mark fan lands in when most refolds come back
     value-unchanged (a marked-but-unchanged consumption IS a
     none-dirty revalidation), while the spike's published dirty-fold
     advantage (2.5×/5.5×) prices the genuinely-changed remainder;
     **breach is a mid-stage STOP before S-B**, forcing the §4.2
     representation re-decision (sticky force-refold bit or an
     fp-gate restoration) before any routing re-home;
   - the **untracked-fan shape** (codex major 6): one hot atom,
     K≈100 weak-only dependents in each of R=4 committed arenas,
     write-storm delivery cost vs the head-bridge anchor; **an S-B
     gate WITH a number and a disposition (S-A step 0, 2026-07-06 —
     the last gate without a numeric form, given the same form as
     the others): write-storm delivery cost on the shape ≤ 1.4× the
     head-bridge anchor; breach is a mid-stage STOP before S-C**,
     forcing the §4.4.1 segregated-list fallback decision before any
     further stage lands;
   - a grown-then-shrunk long-session shape exercising §4.3's decay
     + §4.5.8's reclamation (fable N-5's bench alternative, kept
     alongside the decay rule).
   Checksum parity across impls as the spike did.
7. **Quiet-mode / sync-neutrality re-proof**: `quiet-mode.spec.ts` and
   `one-core.spec.ts` probes green untouched; PR1 ledger updated (the
   +0.5 ns branch pinned; the quiet write's one `arenasLive` branch
   documented per §4.1.2); PR2 re-proof via §4.1.2's flip-site (d)
   walk (quiet folds ARE fanned — the first pass's "quiet folds bypass
   arenas" claim is retracted).

### 4.10 Deletes vs adds (honest ledger, second pass)

**Deletes**: memo ladder ~200 (S-A: pass/committed arms; S-C: newest
arm); K1 log + sweep + touched/taint machinery + weak lists ~250
(S-B); quiesce refresh + refresh-target scan + `subDepRefs` ~60
(S-B); newest-table special case ~40 (S-C); `ComputedNode` path + shim
second wiring ~150 in cosignal-react + ~80 in cosignal (S-C).
**Adds**: arenas/pooling/claim-gens ~140; transliterated walks ~300
(incl. weak-bit handling + capture hook); fanout at FOUR sites +
settlement re-mark hook ~110; §4.5 policy items (equality columns,
boxes, previous, wrap) ~110; validator + pins (test-side).
**Net**: cosignal roughly +200 to +350 source lines and −3 concepts
(ladder, K1-as-invalidation, second computed API) against +2 (arenas,
fanout); cosignal-react −~150 lines; public surface −1 API. Still
adopted as a PERFORMANCE mechanism with an API prize, per the spike's
verdict — the second pass has made it slightly LARGER, not smaller,
because the reviews showed the untracked/lifecycle/settlement halves
were real mechanism, not detail; that cost is now priced instead of
hidden. Third pass 2026-07-06: +~40 lines (settlement pull half +
deferral queue, suspended lists, weak-mode maintenance,
`consumerCount` + the quiesce reclamation sweep, GEN stamps) and −1
column (the per-arena atom fp is never built, §4.2) — same verdict.

---

## 5. Sequencing (updated 2026-07-06, second pass: P1 has LANDED)

**Program 1 landed in full at `3b0063a`** (S0–S4 collapsed into one
verified series; suites 216/81/62, conformance ×3, lockstep zero
diffs). The P1-first rationale is now a description of the substrate
rather than a recommendation — restated honestly per fable M4:

1. P2's walk rewrite touches ONE per-node index (`watchersByNode` +
   `subsByNode` for deliver/newest collection) **plus** the root-scoped
   full scan for `run/committed` subscriptions — 3 indices became
   1 index + 1 root list, not 1; both survive P2 unchanged, since P2
   changes candidate collection for drains only (§4.4.6) and the
   boundary scans are collection-free by construction.
2. Lockstep now referees the REAL effect mechanism (capture frame,
   causal bodies, cleanup events), so P2.S-B's routing re-homing is
   policed by the exact correction/effect streams (§4.4.9).
3. The interface joint held: subscriptions re-check via
   `evaluate(node, world)` — the same call before and after arenas —
   and the record references nodes opaquely, so S-C's identity re-key
   touches no subscription code.
4. The member-write joint landed as `committedDirtySlots` marking
   (no immediate scan — EF2 as ruled); P2's flip-site (c) fans at the
   same lines (§4.3), the deliberate joint the first pass promised.

**P2 stage gates, in order (third pass 2026-07-06):** (i) this
revision passes its focused re-review (amendment 7's condition);
(ii) RUL-3 AND RUL-5 (§7) are answered — the
landing-without-profile-evidence question and the §4.6
infrastructure-exemption ruling both block S-A *(fourth pass
2026-07-06: RUL-5 is now GRANTED and applied in §4.6; RUL-3 remains
the open half of this gate)*; (iii) S-A's
test-first artifacts (hang-schedule port, acyclicity fuzz ops, the
§4.9.3 pin list written red-first where the mechanism doesn't exist
yet — including the settlement quartet (fourth pass), mode-transition,
reclamation, decay, and comparator-order pins) precede S-A engine
code, and S-A's two bench gates (cold-pass with its threshold;
wide-mask) run inside the stage; (iv) the M6 pin AND the
dispose-reuse-read id-tenancy pin are green before S-C starts (§4.7,
§4.5.3); (v) RUL-4 before S-C's public-API change. Battery 16b–16h (P1's boundary pins) must stay green untouched
through every P2 stage — they are the regression fence for the
substrate P2 builds on.

## 6. Risks — written against this plan (attack surfaces first)

- **R1 — RESOLVED (2026-07-06).** The EF2 seam was ruled (boundary
  semantics, amendment 1), the pins were written mutation-verified
  (battery 16b–16h), and P1 landed on them. Kept for the record; P2
  must not reopen it (the 16-series stays green through every stage).
- **R2 — delivery coverage under one structural source (REWRITTEN,
  second pass).** §4.4 now names the mechanisms the first pass left
  implicit: per-arena weak links (§4.4.1) carry the untracked family;
  the population rule (§4.4.2, the re-staled loop + reveal compare,
  declared and pinned) carries the committed-arena premise; arena
  persistence (§4.1) carries the post-quiescence window. The
  remaining, DECLARED residual is codex 4's dead-arena gap
  (§4.4.5) — value-correct, lane-degraded, pinned as S-NF2-D1 with
  documented outcomes, defensible under SP5's letter and the
  comparator's ⊆ delivery bound. M1's sharpening is adopted: a
  routing miss under NF2 is also a drain-candidate miss (one shared
  source), which is exactly why the population rule and the §4.4.9
  exact-stream map are load-bearing, and why S-B comparator noise
  stays a STOP.
- **R3 — per-world policy state (AMENDED per m1).** Folds under
  arenas remain the sharpest edge, but S-A is now honestly scoped as
  the folds+fanout+flip-sites+equality+boxes stage — the majority of
  NF2's new write-path logic — with K1 still routing so every
  divergence indicts the value layer in isolation; the divergence
  detector (lockstep per-op world snapshots + exact
  correction/effect streams) and the mid-stage STOP rule are stated
  in §4.8, not assumed. Third pass 2026-07-06: S-A additionally
  carries both settlement halves, weak-mode maintenance, mark decay,
  and the reclamation sweep — all value-layer, so the isolation
  claim stands — and its gate list now includes the cold-pass
  (numeric) and wide-mask benches plus the third-pass pin set
  (§4.8), so the stage's new mechanisms are test-first, not
  improvised at implementation time (the fable-recommendation
  condition).
- **R4 — RESOLVED INTO MECHANISM + ONE REMAINING TRIPWIRE.** P1
  landed the conservative arm: `obsCapture` feeds pre-dedup inside
  `recordEdge`, and effect snapshots joined the union (RUL-2 ruled
  via OL1). The surviving risk is exactly fable M6's: the S-C walk
  swap silently dropping the capture (or placing it post-reuse-check)
  — closed by §4.7's discipline and its BEFORE-S-C pin. The
  watched-links collapse stays a rejected follow-up with the same
  walked entry test.
- **R5 — world-count scaling (REWRITTEN third pass 2026-07-06).**
  Fanout is O(live arenas) per changed write — and "live" now means
  CONSUMER-POPULATED (§4.5.8): the many-root residual is R arenas ×
  32–64 KB for roots WITH consumers (spike: 4 idle worlds
  +6.9–9.6%), while dead-root arenas release at the next quiescence
  and rematerialize on demand — codex new-blocker 4's unbounded
  "roots ever seen" mode is closed, with two honest residues behind
  RUL-6 (apps that never quiesce; the immortal root records).
  Value-payload retention stated per fable N-6: populated arenas
  retain cached derived values that HEAD freed at every quiescence —
  a retention-class delta, not KB of Int32Array — with the
  live-arena value-column sweep recorded as the measured option.
  Refold-on-consumption places some fold cost in commit-phase drains
  (fable N-11) — bounded by the same boundary's existing re-staled
  refolds and gated by §4.9.6's wide-mask + cycling shapes; the
  weak-edge write-path delta is gated by the untracked-fan shape
  (codex major 6). Other mitigations unchanged (lazy
  materialization, read-clock dedup, pooling, R=4 bench gate with
  the head-bridge anchor; fable N2's cycling shape stays part of the
  gate). Residual measured and published, not hidden.
- **R6 — migration atomicity (REWRITTEN against §4.8's staging).**
  S-A is now the largest stage (m1) but is value-layer-only by
  construction; S-B is a routing-only diff whose failures surface as
  exact-stream diffs; S-C concentrates the public-API and identity
  re-key risk and carries three entry gates (M6 pin; the N-1
  dispose-reuse id-tenancy pin — the re-key walks into the kernel's
  free-list reuse unguarded otherwise, §4.5.3; RUL-4). The
  temporary newest representation (`newestMemos` until S-C) is the
  price of green stages — codex 7's finding, now budgeted: it means
  the "ladder deleted" claim is only two-thirds true until S-C, and
  the ledger (§4.10) counts it that way. Stages stay additive until
  their deletion commit; every stage keeps a revert story.
- **R7 — walk-mirror drift.** Two hand-maintained specializations of
  nine walks WILL drift when the kernel changes (the kernel is
  "already minimal — leave it" per review, but perf work touches it).
  Mitigations: the mirror-comment convention, the structural validator
  in every engine test run, and the hang schedule exercising the exact
  transitions (flags, tail reuse, reverse dispose) that drift breaks.
  Residual: a semantics-preserving kernel optimization that the mirror
  misses stays invisible until a world-side bench regresses — accepted.
- **R8 — arena growth-mid-op is a new bug CLASS, not a bug.** `w.W`
  reload after allocating calls has no type-system enforcement.
  Mitigations (§4.5.9): stride-sized-arena growth tests + validator.
  Residual: a growth path only reachable under real React interleavings
  — the React scenarios run with a tiny default arena size in test
  builds to hunt it.
- **R9 — RESOLVED (2026-07-06).** RUL-2 was ruled by OL1's letter
  (amendment 3): effect dep snapshots joined the union and P1 landed
  the obsShift re-pointing with the watcher discipline; the
  logged-quiet bench residuals were re-published IMPROVED with it in.
  Remaining trace: every effect re-capture is a committed-world
  evaluation moving retains, which compounds with the S-C capture-path
  dependency — folded into R4's tripwire (the M6 pin).
- **R10 — the two programs' combined churn lands on logged.ts within
  weeks of the F3/F6 referee-extraction grind.** The model-view referee
  (tests/model-view.ts) mirrors the visibility rule and tape shapes;
  P2 deletes or moves several fields it materializes. Every stage's
  definition of done includes the model-view adapter compiling and the
  twin suites green — the referee is load-bearing, and "rewire the
  adapter mechanically" (prior plan's rule) still applies: comparison
  semantics never weaken.

## 7. Rulings requested before implementation (blocking, in order)

Ruling ids are `RUL-n` (distinct from the risk ids `R1–R10` in §6).

1. **RUL-1 — RESOLVED 2026-07-06** (superseded by the EF2 boundary
   ruling, amendment 1; recorded in the contract; pinned as battery
   16b–16h; P1 landed on it).
2. **RUL-2 — RESOLVED 2026-07-06** (dissolved by OL1's letter,
   amendment 3: effects count; landed with the P1 obsShift wiring).
3. **RUL-3 — NF2 landing gate (blocks P2.S-A)** — the spike's recommendation
   gates landing on world-read cost appearing in real profiles; the
   owner has queued the DESIGN. Confirm whether the F5 API prize plus
   the recorded numbers justify landing without the profile evidence,
   or whether P2 waits armed behind a profiling task. This plan is
   written to be executable either way; it does not presume the gate
   away.
4. **RUL-4 — F5 surface ruling (blocks P2.S-C)** — module-scope derived values
   readable in a render's world becomes a supported, documented
   capability (review F5's owner question, answered YES by the
   mechanism); confirm the README/API posture and whether
   `BoundComputed` survives as a deprecated alias for one release of
   the internal consumers.
5. **RUL-5 — RESOLVED 2026-07-06 (fourth pass): exemption GRANTED**
   as the contract §2 scope amendment — the four-lifetime rule
   governs application and history state (content a consumer could
   observe, not rebuildable from classified state); mechanism
   infrastructure sits outside the taxonomy with mandatory per-row
   lifetime+reclamation documentation. §4.6 applies it: the three
   foot rows, AND (per the third-pass verifier's verdict 5) the
   committed-arena / marks / cached-outcome rows re-labeled as
   mechanism-caches of L1 (or L3/L4) content. The per-row teeth
   stand. No longer blocks S-A.
6. **RUL-6 — fork-protocol root-destroy event (recorded OPEN;
   non-blocking; third pass 2026-07-06)** — §4.5.8's fallback if the
   watcher-population refcount proves insufficient (the known holes:
   apps that never quiesce while dead roots accumulate; the immortal
   root records). Adding a protocol event is an owner call; the plan
   ships the refcount and does not presume the event.

## 8. Gate summary (every stage, no exceptions)

Package suites (`packages/cosignal`, `cosignal-react`,
`cosignal-oracle`) + typechecks; oracle lockstep fuzz corpus with zero
diffs (tolerances only as documented — any new tolerance is a finding);
the 17-case battery at model and React level + scars + flags;
conformance ×3 (179 cases per configuration); the React scenarios; the
hang schedule (ported at P2.S-A, pinned green from S-C when kernel
computeds evaluate under worlds) and the structural validator (from
P2.S-A); the
bench battery — *staging corrected fourth pass 2026-07-06 to match
§4.8/§4.9.6:* published numbers at P1.S4 and P2.S-D as before, but S-D
is the FULL battery, not the first bench point — the staged P2 bench
GATES run inside their stages, each with its threshold and STOP
disposition: cold-pass (≤ 1.4× anchor) and wide-mask lock-in (≤ 1.4×
anchor) inside S-A, untracked-fan (≤ 1.4× anchor; breach = STOP —
S-A step 0, 2026-07-06) inside S-B (sync shapes +
head-bridge anchor, discard churn, world evaluation, idle-world
scaling, cycling, grown-then-shrunk, quiet-mode probes). Any stage
that surfaces a contract question stops
for an owner ruling rather than inventing semantics.
