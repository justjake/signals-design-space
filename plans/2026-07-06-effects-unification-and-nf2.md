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
>    committed-plane lifecycle (one consistent story — fable B2),
>    suspense settlement fanout per plane (codex 5/fable M2), per-world
>    equality policy (codex 6), S-A executability (codex 7), and the
>    mandatory lifetime classification for planes/marks/boxes. The
>    revision gets a focused re-review before any stage runs.

> **STATUS: DRAFT — plan only, no code has changed.** Written for
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
  segregated shadow planes; prototype archived at
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
K0/K1, touched word, memo, memo plane, memo ladder, episode, quiescence)
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
- **Shadow plane** (NF2) — one world's private copy of graph structure:
  shadow node records mirroring kernel nodes plus link records in the
  kernel's exact `LinkField` layout, stored in a per-world `Int32Array`
  the kernel's lists never share. "Plane" here is the spike's usage —
  a per-world storage layer — distinct from logged.ts's "memo plane"
  (a per-world `Map` of memos), which NF2 deletes.
- **Fanout** (NF2) — the write-path step that marks, in each live world
  plane that can see the write, the written atom's shadow as changed
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
one retain per snapshot node through the existing `obsShift` plane
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

From `research/experiments/world-tagged-links-spike.md` (all §-refs
below are that report's; numbers are its medians):

**Proved:**
- The hang schedule — NF2's entry criterion (contract §5) — written
  first, red on the documented failed design (`__naiveWorldRead`
  pinned: kernel-hosted world evaluation corrupts the newest cache),
  green on segregated planes by construction; 200-iteration
  discard-churn with alternating surgical/bulk teardown leaks zero
  links.
- Sync-path neutrality: chain/fan write shapes +0.4–1.4% (within noise);
  the ONE real regression is **+0.5 ns (~19%) on a bare clean computed
  read** — the `spikeRoute` scalar branch in `Computed.state`, the price
  of one computed class (an operation-table swap would zero it but the
  kernel's own POISON note prices that at +15–25%; the branch is the
  cheaper trade). Idle live worlds +1–10%, bounded by the read-clock
  dedup; one idle world costs less than the shipped machinery's one
  live batch.
- Discard churn at parity: bulk plane drop −4.3%, per-edge surgical
  +0.8% vs the shipped pass memo plane — the O(edges) teardown concern
  dissolved (95 links + 37 shadows per pass at the churn shape).
- World evaluation 2.5× (1 dirty atom) / 5.5× (all dirty) vs the
  CHEAPEST shipped memo plane, 29× vs what a render pass pays today;
  zero-allocation steady state (50 rounds, links byte-stable).
- Conformance smoke 179/179 with zero worlds open; per-world footprint
  32–64 KB at the bench shapes.

**Left UNBUILT (the report's §4 ledger, enumerated — this is the
per-world POLICY state, where "simpler does not hold" lived):**
1. World atom values from FOLDS — tape + the two-clause visibility rule
   replacing the spike's `__worldSet` stand-in.
2. Pin discipline for pass worlds (RCC-RT1 freezing) — the spike had no
   pins at all.
3. Per-world equality cutoff (custom `equals` in folds; the computed
   update cutoff per plane).
4. Per-world suspense/sentinel boxes (`SuspendedRead` values per plane),
   `ctx.previous`, `ctx.use` integration.
5. Watcher-delivery integration (the spike had no watchers, no
   deliveries, no drains — worlds had no effects; render pulls).
6. Commit-generation re-keying for committed worlds.
7. Plane pooling; int32 read-clock wrap handling; the growth-mid-op
   reload discipline (`w.W` must be re-loaded after any allocating call
   — the report flags this as "a real bug class").
8. Receipts/retirement interplay, tape/slot/token layer: untouched by
   NF2 either way (the report says so; this plan keeps it so).

## 4. Program 2 — the production mechanism

### 4.1 Which worlds get planes

- **newest** — IS the kernel; no plane, no shadow, no memo (deletes the
  `newestMemos` special case, logged.ts:1462).
- **pass worlds** — one pooled plane per open pass, created at
  `passStart`, dropped in bulk at `passEnd` (commit or discard) — the
  measured-at-parity abandonment path.
- **committed-for-root worlds** — one long-lived plane per root,
  materialized LAZILY, only when the root first evaluates a computed in
  its committed world (matching `memoPlaneOf`'s existing never-create
  rule, logged.ts:1473-1481). Lazy materialization is the first defense
  against world-count scaling (§6-R5).
- **mountFix worlds** — remain one-shot fold-throughs with no plane
  (exactly today's `memoPlaneOf` → `undefined` arm); fixup runs once per
  mount and caches nothing.

### 4.2 Values: grounding shadow atoms in folds

A world's atom value is `foldAtom(atom, world)` — the existing packed
fold under the existing two-clause visibility rule (logged.ts:1353-1417)
— computed lazily at the atom's first read in that plane and stored in
the plane's value column. The atom-granularity fingerprint (`fpOf`)
SURVIVES: it is how a re-marked shadow atom decides whether its fold
actually changed (write-equality per world) before propagating. What
dies is every PER-COMPUTED fingerprint: computeds validate structurally
(flag checks + `wCheckDirty`), never by per-dep fingerprint scans.

### 4.3 Invalidation: fanout, and the pin argument for pass planes

`writeAtom`'s changed-write tail fans into live planes with the
read-clock dedup — but not uniformly:

- **Pass planes receive NO fanout, ever.** Stronger than the spike's
  "skip pinned worlds and re-arm at resume": a pass world's visible
  receipt set is IMMUTABLE from `passStart` — every later write's seq
  postdates the pin (clause 2 excludes it), a later retirement's stamp
  postdates the pin (clause 1 excludes it), and compaction is already
  pin-gated below every live pin (logged.ts:3056-3066). Writes during
  render throw (RCC-UM2), so the plane cannot be invalidated from
  inside either. Therefore a pass-plane value, once folded, is valid
  for the pass's whole life; no re-arm at resume is needed because
  resume does not move the pin (RCC-RT1's exact text). This must be
  written down as an engine invariant with a dev-mode assert (a fanout
  reaching a pass plane is a bug), because it is the load-bearing
  reason discard churn stays cheap.
- **Committed planes receive fanout at COMMITTED-TRUTH motion, not at
  raw writes.** A live batch's write is invisible to committed worlds
  until membership or retirement flips it (visibility rule clauses), so
  raw-write fanout into committed planes would be wrong, not just
  wasteful. The three flips and their fanout sites: (a) retirement —
  fan the retiring token's `atomsTouched` into every committed plane
  (replaces the retirement drain's slot-cone seed); (b) per-root
  lock-in at `passEnd(commit)` — fan the locked-in token's
  `atomsTouched` into THAT root's plane (this **replaces
  commit-generation re-keying** — item 6 of §3 — structurally: instead
  of evicting the whole plane because fingerprints cannot see
  below-max visibility flips, the flip's own atoms re-mark precisely);
  (c) a write into an already-committed member batch — fan into the
  member roots' planes at the write (the same sites that today set
  `committedDirtySlots`, and the same instant Program 1's RUL-1 trigger
  fires).
- **Newest** needs no fanout: the kernel's own propagate IS newest
  invalidation (unchanged).

### 4.4 Deliveries and drains — the redesigned plumbing (the load-bearing section)

Today both ride K1: write-time value-blind deliveries walk K0∪K1
(logged.ts:2077-2119); durable drains seed from per-slot touched lists
plus weak edges (:3125-3228); mount fixup closes over reverse K1
(:3323). NF2 deletes K1's memo-invalidation job, but its ROUTING jobs
must be re-homed:

- **Write-time delivery** becomes reachability over the kernel's subs
  links ∪ every live plane's subs links (pass planes included — the walk
  visits structure; it does not read or mark pass-plane values, so the
  §4.3 invariant is untouched), collecting live `deliver`-subscriptions
  on visited nodes. Value-blind by construction: plane traversal is
  link-following, and the kernel-style value cutoff lives in `update`,
  which delivery never calls (RCC-SP5's prohibition on notification-time
  value comparison is preserved). The per-(watcher, slot) dedup bit and
  the interleaved-delivery rule (open-pass mask + pin compare,
  logged.ts:2474-2494) are untouched — they are per-subscription
  policy, not graph policy.
- **Coverage argument** (attack this): HEAD's K1 is the union of edges
  observed in any world THIS EPISODE (add-only, swept, bulk-reset);
  live-planes-∪-kernel is the union of CURRENT structural sets. The
  engine may therefore deliver LESS than HEAD after a plane dies (a
  dep-flip edge recorded by a dead pass is forgotten). The discriminant
  edge argument says the required deliveries survive: a consumer's view
  in world w changes only if some dependency in w's CURRENT dep set
  changes; w's current dep set is exactly w's plane links (or kernel
  links for newest), which the walk traverses. The cross-world worry —
  "the write matters to a world that hasn't evaluated yet" — is covered
  because a not-yet-evaluated (node, world) pair folds fresh at its
  first read; deliveries exist to re-render already-rendered consumers,
  and an already-rendered consumer's links exist in the plane it
  rendered in (its pass plane, alive until its pass ends) and in its
  root's committed plane (alive as long as the root). The two
  deliberate non-coverages match HEAD: untracked reads leave no link in
  ANY design (the TAINT bit survives for exactly them), and a
  gap-window write with no open pass falls to the dedup rule's
  "scheduled-but-unstarted work will fold it" arm, exactly as HEAD's
  `deliver()` suppresses when no open pass exists.
- **Referee compatibility**: the twin comparator already checks
  delivery-ish events as a ⊆-counts bound against the model's
  deliberately conservative union (`tests/helpers.ts:148-160`; oracle
  README's declared tolerance), and misses on the REQUIRED side surface
  as value divergence in the per-op snapshot/correction compare and in
  the React battery. So more-precise delivery needs no comparator
  change — but the plan treats the ⊇-required half as under-policed and
  adds the walked schedules of §6-R2 as pinned engine tests plus a
  fuzz assertion (every watcher correction at drain time whose value
  changed must have been preceded by a delivery or a scheduled
  corrective — an engine-side invariant, checkable per op).
- **Durable drains** keep their trigger sites and ordering (RCC-CR5) but
  their candidate set comes from the committed plane's fanout marks
  (§4.3 b/c) expanded over the plane's links, instead of slot-touched
  lists + weak-edge expansion. Weak (untracked) coverage: the drain
  additionally re-checks any subscription whose node carries TAINT —
  the conservative arm that replaces weak-edge expansion (untracked
  reads still leave no link in any design). Value-gating and id-order
  firing are unchanged. Program 1's `run/committed` subscriptions
  re-check per root full-scan (v1 semantics), so drains need no
  per-node effect indexing at all — the interaction that makes the
  P1→P2 order pay (§5).
- **Mount fixup** keeps its semantics wholesale (corrective loop +
  fast-out + audit); `dependencyClosureOf` walks reverse links over
  kernel + the mounting pass's plane instead of reverse K1. The
  `tokenTouches` premise (per-token `atomsTouched`) is representation-
  free and unchanged.
- **TOUCHED word / slotTouched**: bits 0–30 (per-slot conservative
  reach) become unnecessary once drains seed from plane marks; the
  TAINT bit (31) survives as a per-node flag with its propagation now
  running over kernel+plane links. The keep-the-dirt discipline
  transfers to plane marks: a committed plane's mark may clear only
  when its re-fold ran (marks are consumed by evaluation, which is
  always safe — simpler than the slot-carried watermark rule, because
  marks are per-world and worlds cannot see each other's dirt).

### 4.5 Per-world policy state (item-by-item, since this is where "simpler does not hold" lived)

1. **Folds** — §4.2; reuses `foldAtom`/`visibleAt`/`fpOf` verbatim; no
   new fold logic.
2. **Pins** — §4.3; the no-fanout invariant plus the existing pin-gated
   compaction are the ENTIRE pin story; no per-plane pin state exists.
3. **Equality** — atom-level custom `equals` runs inside `foldAtom`
   (already per-world, already fold-guarded); computed-level cutoff is
   the transliterated `wUpdate`'s value compare against the plane's
   value column (kernel discipline replayed; per-plane by construction).
4. **Sentinel boxes** — a suspended evaluation folds to its stable
   `SuspendedRead` sentinel per plane value column; "still pending"
   caches and compares like any value, per plane, exactly as the shim's
   translation rule states today. Hook-initiated evaluations rethrow
   (the `suspendDepth` discipline stays adapter-side, unchanged).
5. **`ctx.use`** — already ONE implementation with a per-key cache
   scoped to the living node (L4: keyed by request, shared across
   worlds BY DESIGN — SU3's key carries the world-varying inputs).
   Planes change nothing here; the F5 unification deletes the shim's
   second wiring (`makeComputedNode`'s holder) in favor of the kernel
   ctx layer's own (index.ts's packed side-column cache).
6. **`ctx.previous`** — the committed-value hint. Under one computed
   API the kernel's plain-path `previous` (its own last value) is wrong
   for React's uses; the rule becomes: inside a world evaluation frame,
   `previous` serves the node's last-COMMITTED cell (maintained at
   `passEnd(commit)` exactly as today, moving from `shim.previousCells`
   into the bridge, keyed by kernel id); on the plain path it keeps
   kernel semantics. This is a policy override at the world-frame seam
   — small, but it is a semantic branch and gets its own test.
7. **Read-clock wrap** (int32) — planes renumber their clocks at
   quiescence alongside the existing renumber duty list, or the clock
   widens to a float64 column; decided at implementation with a forced-
   wrap test either way.
8. **Growth-mid-op reload** — every allocating world call re-loads
   `w.W`; enforced by (a) the spike's structural validator promoted to a
   dev-mode invariant run in engine tests after every op, and (b) a
   dedicated test configuring pathological initial plane sizes (stride-
   sized) so every growth path exercises mid-walk.

### 4.6 What lands vs what deletes (F5 dies)

**Deletes** (engine, logged.ts):
- The WorldMemo ladder: `WorldMemo`, `validateMemo`/`validateMemoInner`,
  `passClocksQuiet`/`committedClocksQuiet`, `scanFp`, the memo halves of
  `atomValue`/`evaluate` (~200 lines) → shadow flags + `wCheckDirty`.
- The K1 union edge log as such: `outSets`/`outList`/`inList`,
  `recordEdge`/`recordWeakEdge`, `sweepK1`, edge-add bit propagation,
  slot-touched lists and touched bits 0–30 (~250 lines) → per-plane
  links + fanout marks + the TAINT survivor. (The spike called this
  "partial"; §4.4 is the full re-homing that makes it whole.)
- The newest-plane special case (`newestMemos`, `newestFrameTaint` as a
  frame accumulator — taint derivation moves to the kernel-link walk).
- **The second computed API (F5 — the prize):** `ComputedNode`/
  `ComputedFn`/the fn-reader evaluation path; cosignal-react's
  `makeComputedNode` + `previousCells` + `BoundComputed`'s separate
  routing (`routeComputedRead` collapses to the world seam);
  `useSignal`'s rejection of kernel `Computed`
  (hooks.ts `resolveNode`) — module-scope kernel computeds become
  readable in a render's world, answering review F5's owner question
  with YES. `useComputed` keeps its deps-keyed recreation contract
  (ruling I1; WP3) but mints kernel `Computed`s.

**Lands**: plane allocator/registry/pooling (~130 lines); the
transliterated walks (§4.7); fanout + read-clock dedup; the two read
seams (`Atom.state`/`Computed.state` world routing — the +0.5 ns
branch); committed-plane fanout at the three flip sites; the §4.5
policy items; the hang schedule + validator as permanent tests.

### 4.7 The ~350 lines of walk specializations — can they shrink? (honest answer)

Mostly no, and the plan budgets for that. The spike transliterated nine
kernel walks (`link`/`linkInsert`/`unlink`/`purgeDeps`/
`disposeAllDepsInReverse`/`propagate`/`shallowPropagate`/`checkDirty`/
`update`) with `M → w.W`. Parameterizing the kernel's own walks over a
plane argument taxes world-0 (the file's documented closure-constant
history); build-time codegen of both specializations from one template
trades line count for build machinery and a worse debugging story —
rejected. Real shrink available: the world walks need no notify branch
(worlds have no effects; render pulls — `wPropagate` loses the effect
arm), no lifecycle (D1) branches, and `wUnlink`/`wPurgeDeps` can share
a body; realistic landing is **~300 lines of contained, clearly-fenced
duplication**. The honest posture: "one mechanism" is one *design*, two
*code* specializations — mitigated by (a) the structural validator
running in dev/test after every op on both graphs, (b) a
`KERNEL-WALK-MIRROR` comment convention at each kernel walk pointing at
its twin (drift tripwire for future kernel changes), and (c) conformance
+ the hang schedule pinning both.

### 4.8 Migration path (staged so every commit is lockstep-green)

The +0.5 ns computed-read seam lands in stage C (it exists only when a
routing branch must choose planes); stages A–B keep today's read costs.

- **P2.S-A — planes as the value store, dual bookkeeping.** Plane
  structure + links recorded by the EXISTING fn-based evaluator
  (`trackedReader` records into the active world's plane IN ADDITION to
  K1), world values served from planes, the memo ladder deleted.
  Double-pays edge recording for the stage's lifetime — accepted and
  measured (bench gate: the dual-write cost must stay within the
  spike's live-world envelope). K1 still owns delivery/drains; lockstep
  and battery green with zero semantic change.
- **P2.S-B — routing re-homed; K1 deleted.** Deliveries walk
  kernel∪planes (§4.4); drains seed from committed-plane marks; mount
  fixup closes over plane links; TAINT re-homed; `sweepK1` and the
  quiesce K1 bulk-reset replaced by plane lifecycle (pass planes die
  with passes; committed planes renumber/pool at quiescence; the
  7456c7b obs plane is fed from plane-link recording — §6-R4).
  Delivery-decision changes are possible here (fewer, never more) —
  the ⊆ comparator bound plus the §6-R2 schedules police it.
- **P2.S-C — F5: one computed.** Kernel `Computed` evaluates under
  worlds via the transliterated walks; the fn-reader/`ComputedNode`
  path and the shim's second ctx wiring delete; `useSignal` accepts
  kernel computeds; the read seams land (+0.5 ns pinned in the bench
  gate). This is the public-API stage and the atomicity concentration
  point (§6-R6).
- **P2.S-D — perf closure.** Plane pooling, wrap handling hardened, the
  bench battery re-run in full (§4.9), spike benches ported into
  `packages/cosignal/bench` under real names (review F7's hygiene),
  README/API docs for the unified computed story.

### 4.9 Verification gates (Program 2)

1. **The hang schedule as a permanent regression**: the spike's
   `hang.spec.ts` ported into `packages/cosignal/tests` (dep-flipping
   computed across worlds, kernel deliveries interleaved, mid-eval
   tolerated write, kernel-side dep flip under live worlds, disposal
   cascade, both teardown modes, step-capped structural validation) —
   plus the pinned `__naiveWorldRead` corruption witness so the failed
   design stays red forever.
2. **Per-view acyclicity fuzzed** (NF2 entry criterion #2): schedule-
   generator coverage of battery case 1's union-cycle member (per-view
   acyclic, union cyclic) + the validator's cycle caps under fuzz.
3. **Full battery**: package suites, 17-case battery at model and React
   level, scars, flags, conformance ×3 (the three framework
   configurations, 179 cases each), typechecks — per stage, not per
   program.
4. **Lockstep** — with the oracle-survival claim VERIFIED, not assumed:
   the claim holds because the model is representation-free where NF2
   changes representation — worlds are pure replays (no memo/plane
   vocabulary anywhere in `model.ts`), the adapter compares world
   VALUES via `snapshot()` (newest/committed-per-root/open-pass worlds)
   and events, and the delivery comparator's tolerance band already
   admits a more-precise engine. Residual gaps, stated: (a) the model
   never sees plane lifecycle, so plane-pooling/growth bugs are
   invisible to lockstep — covered by the validator + hang schedule +
   growth tests instead; (b) required-delivery misses reach lockstep
   only as downstream value/correction divergence — covered by the
   §6-R2 pinned schedules and the delivery-precedes-correction
   invariant; (c) `ctx.use`/thenables stay outside the model
   (declared in `tests/SKIPPED-FOR-FORK-SUITE.md`; the React battery is
   the referee of record there). If S-B's delivery re-homing produces
   comparator noise beyond the band, that is a STOP — a finding, not a
   tolerance to widen silently.
5. **Bench battery re-run, including the spike's own benches**: sync
   shapes (chain/fan/clean-read) with the **head-bridge anchor**
   re-measured — the production write path now runs delivery walk +
   fanout, and the spike's "fanout replaces the delivery walk" framing
   was true only for memo invalidation, so the combined write cost must
   be re-proved against HEAD's bridge path, not assumed; discard churn
   (typeahead shape, bulk + surgical); world evaluation (1-dirty /
   all-dirty / none-dirty vs HEAD-newest and HEAD-pass); idle-world
   scaling at w1/w4; checksum parity across impls as the spike did.
6. **Quiet-mode / sync-neutrality re-proof**: `quiet-mode.spec.ts` and
   `one-core.spec.ts` probes untouched; PR1's ledger updated honestly —
   the +0.5 ns `Computed.state` branch is a "predictable branch" under
   PR1's letter and is pinned as such in the read bench; PR2 unaffected
   (quiet folds bypass planes entirely — zero live worlds while quiet
   is an invariant, asserted).

### 4.10 Deletes vs adds (honest ledger)

**Deletes**: memo ladder ~200; K1 log + sweep + touched machinery ~250
(TAINT survives); newest-plane special case ~40; `ComputedNode` path +
shim second wiring ~150 in cosignal-react + ~80 in cosignal.
**Adds**: planes/pooling ~130; transliterated walks ~300; fanout + flip
sites ~80; policy items ~100; validator + tests (test-side).
**Net**: cosignal roughly +150 to +300 source lines and −3 concepts
(ladder, K1-as-invalidation, second computed API) against +2 (planes,
fanout); cosignal-react −~150 lines; the public surface −1 whole API.
Consistent with the spike's verdict: the engine gets FASTER and its
public surface simpler; its internals do not get smaller — this plan
adopts NF2 as a performance mechanism with an API prize, exactly the
spike's recommendation, and does not resell it as a simplification.

---

## 5. Sequencing: Program 1 first, then Program 2 — and why

**Recommendation: P1.S0–S4 land fully, then P2.S-A–S-D.** Both programs
touch the delivery/notification plumbing; the order is chosen so each
piece of plumbing is rewritten once:

1. **P2 rewrites every walk that collects consumers** (delivery, drains,
   sweep seeds, quiesce refresh). Under HEAD those walks collect from
   THREE per-node indices with three duplicated blocks; after P1 they
   collect from ONE subscription index with one rule. P2-first would
   rebuild the three-index collection into planes and then P1 would
   churn it again.
2. **P1's oracle co-evolution is world-representation-free** (dep
   snapshots and triggers never mention memos or planes), so landing it
   first means P2's riskiest stage (S-B, routing re-homing) is refereed
   by a model of the REAL effect mechanism — committed-observer timing
   is exactly where FLAGS.md historically found bugs, and today's
   lockstep referees the dead one.
3. **P1's v1 full-scan re-check needs no per-dep-node indexing**, which
   is precisely the machinery P2's drains would otherwise have to carry
   through the K1→plane swap. P1-then-P2 means drains never grow an
   effect-index at all.
4. **The interface P1 leaves for P2 is stable**: subscriptions re-check
   via `evaluate(node, world)` — the same call before and after planes.
   To keep it stable, P1 carries one forward-compatibility rule: the
   subscription record references nodes opaquely (whatever `AnyNode`
   resolves to), deepening no `ComputedNode` coupling, since P2.S-C
   re-keys node identity to kernel computeds.

Counter-argument, stated: P1 builds trigger plumbing against drain
machinery P2 partially replaces. Rebuttal: P1's triggers are SITES
(retire, lock-in, member-write, quiet fold) not mechanisms; every site
survives P2 verbatim — only the candidate-collection under two of them
changes, and P1's full-scan collection is collection-free by
construction. The one truly shared file region (the write path's
member-write detection) is written once in P1 (the RUL-1 trigger) and reused
by P2's flip-site (c) fanout — a deliberate joint.

Parallelization: P1.S1 (oracle) and P2's test-first artifacts (porting
the hang schedule red/green harness, the acyclicity fuzz ops) are
independent and can proceed concurrently; no engine code of P2 starts
before P1.S4 is green.

## 6. Risks — written against this plan (attack surfaces first)

- **R1 — the EF2 timing seam is a contract hole this plan walked into,
  not around.** Production fires committed observers at committed-member
  writes; the model and contract don't. If the ruling goes the other
  way (defer to drains), P1's "timing must not change" constraint is
  violated by the ruling itself and the characterization pins must be
  rewritten first. Tripwire: P1.S0 blocks on the ruling; battery 16b is
  written against whichever answer the owner gives, BEFORE S2.
- **R2 — the delivery coverage argument (§4.4) is the plan's most
  attackable claim.** The discriminant edge argument has two known
  soft spots: consumers whose only cross-world routing lived in a DEAD
  pass plane during a no-open-pass gap (currently absorbed by the dedup
  rule's scheduled-work arm — schedule S-NF2-D1, the flag-flip family,
  must be pinned in both the "second write before pass start" and
  "write after pass discard, before restart" interleavings), and
  taint-only paths (untracked reads) where drains, not deliveries,
  carry correctness. A miss here paints stale committed frames fixed
  only by urgent corrections — value-correct but lane-degraded
  (RCC-SP4 erosion). Mitigation: the pinned schedules, the
  delivery-precedes-correction fuzz invariant, and S-B's rule that
  comparator noise is a STOP.
- **R3 — per-world policy state is where the spike's "simpler does not
  hold" lived, and folds are its sharpest edge.** The spike never
  folded under a plane; wiring `foldAtom` (with fold-purity guards,
  custom equals, updater replay) into shadow value columns crosses the
  packed-int world (planes) with the object world (payloads, equals
  fns) — the exact boundary where the engine's history says bugs
  breed. Mitigation: stage S-A isolates folds-under-planes with K1
  still carrying routing, so fold bugs surface under an unchanged
  delivery regime; the model replays folds from first principles and
  diffs every op.
- **R4 — interaction with 7456c7b (transitive-observation retains).**
  The obs plane's capture rides `recordEdge` — deleted in S-B. Two
  re-homings: (kept, default) feed `obsCapture` from plane/kernel link
  recording, preserving 7456c7b's exact semantics — retains follow the
  most recent evaluation in ANY world, the throw rule keeps partial
  captures, zero flap across quiesce (all three are pinned tests that
  must stay green untouched); (rejected for now) collapse watcher
  retains onto kernel watched links once computeds are kernel nodes —
  more deletion, but it silently changes the retained set to
  newest-evaluation deps only (a computed whose pending-world
  evaluation reads an atom its newest evaluation does not would drop
  that atom's retain), an OL1-observable difference nobody has ruled
  on. The plan takes the conservative arm and files the collapse as a
  named follow-up with that walked difference as its entry test.
- **R5 — world-count scaling.** Fanout is O(live planes) per changed
  write; committed planes are long-lived and per-root. A many-root app
  (WP1's declared "degraded multi-root" scope) pays R planes × 32–64 KB
  and the fanout branch per write (spike: 4 idle worlds cost +6.9–9.6%
  on working shapes). Mitigations: lazy committed planes (§4.1), the
  read-clock dedup (idle-plane marks are O(1) after the first), pooling
  (S-D), and a bench gate at R=4 with the head-bridge anchor. Unmitigated
  residual: an app with many roots ALL holding committed-world
  observers genuinely pays more than HEAD's single K1 — measured and
  published, not hidden.
- **R6 — migration atomicity concentrates in S-B and S-C.** S-B swaps
  routing wholesale (delivery + drains + fixup + taint in one stage —
  they share the walk buffers and cannot swap piecemeal without a third
  temporary regime). S-C changes public API (`useSignal` acceptance,
  `BoundComputed` collapse) — user-visible, and hooks.ts's four
  render-path branches (mount/re-render/reveal-adopt/defensive-newest)
  all re-seat onto kernel nodes at once. Mitigations: S-A's dual
  bookkeeping makes S-B a routing-only diff; S-C keeps `useComputed`'s
  external contract byte-identical (deps-keyed recreation, WP3) so the
  React battery diffs cleanly; each stage is its own verified commit
  series with a revert story (stages are additive until their deletion
  commit, which lands last within each stage).
- **R7 — walk-mirror drift.** Two hand-maintained specializations of
  nine walks WILL drift when the kernel changes (the kernel is
  "already minimal — leave it" per review, but perf work touches it).
  Mitigations: the mirror-comment convention, the structural validator
  in every engine test run, and the hang schedule exercising the exact
  transitions (flags, tail reuse, reverse dispose) that drift breaks.
  Residual: a semantics-preserving kernel optimization that the mirror
  misses stays invisible until a world-side bench regresses — accepted.
- **R8 — plane growth-mid-op is a new bug CLASS, not a bug.** `w.W`
  reload after allocating calls has no type-system enforcement.
  Mitigations (§4.5.8): stride-sized-plane growth tests + validator.
  Residual: a growth path only reachable under real React interleavings
  — the React scenarios run with a tiny default plane size in test
  builds to hunt it.
- **R9 — P1's promotion could quietly WIDEN the refereed surface's
  cost.** Registering promoted subscriptions into the observation union
  (RUL-2) makes every effect run re-point retains (obsShift
  traffic per run). If the ruling adopts union membership, the
  microtask coalescing must be re-benched under effect-heavy React
  suites; if it doesn't, OL1's text must change. Either way the cost
  or the contract moves — this plan refuses to let both stand.
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

1. **RUL-1 (blocks P1.S0)** — amend RCC-EF2 to name "a write into a
   batch already committed into the effect's root" as a durable flip
   (recommended), or rule production's immediate revalidation a bug to
   fix toward the model's deferred timing. Contract §6 amendment
   process applies (dated ruling, line edited in place).
2. **RUL-2 (blocks P1.S2)** — do promoted committed-observer deps join
   the RCC-OL1 observation union? Recommended: yes (closes an
   incident-I3-shaped asymmetry); either answer becomes an OL1 edit +
   an `observe-union` pin.
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

## 8. Gate summary (every stage, no exceptions)

Package suites (`packages/cosignal`, `cosignal-react`,
`cosignal-oracle`) + typechecks; oracle lockstep fuzz corpus with zero
diffs (tolerances only as documented — any new tolerance is a finding);
the 17-case battery at model and React level + scars + flags;
conformance ×3 (179 cases per configuration); the React scenarios; the
hang schedule (from P2.S-A onward) and the structural validator; the
bench battery with published numbers at P1.S4 and P2.S-D (sync shapes +
head-bridge anchor, discard churn, world evaluation, idle-world scaling,
quiet-mode probes). Any stage that surfaces a contract question stops
for an owner ruling rather than inventing semantics.
