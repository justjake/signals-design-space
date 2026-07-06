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

> **§3–§4 REVISED 2026-07-06, second pass** (supersedes the first-pass
> text per amendment 7). Written against the tree AS IT STANDS after
> Program 1 landed (`3b0063a`): one core `Subscription` record with the
> capture frame (`mountCommittedObserver`/`captureRun`/`captureRead`),
> EF2-amended boundary re-checks (`revalidateCommittedSubs` at commit /
> discard-close / retirement / settlement / quiet fold, at op end,
> never under an open same-root frame), refires as notify-queue kind 3,
> `committedDirtySlots` + the `restaled` set gating drains, the
> `subDepRefs` plane, and `obsCapture` fed pre-dedup inside
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
  green on segregated planes by construction; 200-iteration
  discard-churn with alternating surgical/bulk teardown leaks zero
  links.
- Sync-path neutrality: chain/fan write shapes +0.4–1.4% (within
  noise); the ONE real regression is **+0.5 ns (~19%) on a bare clean
  computed read** — the `spikeRoute` scalar branch in `Computed.state`.
  Idle live worlds +1–10%, bounded by the read-clock dedup.
- Discard churn at parity: bulk plane drop −4.3%, per-edge surgical
  +0.8% vs the shipped pass memo plane. **Important for §4.8: the
  spike had NO cross-world fast path at all — every world read routed
  to its plane — so these numbers already price the fast-path deletion
  §4.4 commits to.**
- World evaluation 2.5× (1 dirty atom) / 5.5× (all dirty) vs the
  cheapest shipped memo plane, 29× vs what a render pass pays today;
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
7. Plane pooling / read-clock wrap / growth-mid-op reload → §4.5.7–8,
   §4.6 (pool claim generations).
8. Receipts/retirement/tape/slot/token layer: untouched by NF2 either
   way (unchanged from the first pass; re-verified — nothing below
   writes a receipt or moves a stamp).

**What the spike also never exercised** (the second-pass additions all
live here, per the reviews): untracked reads, folds, watchers, drains,
quiet mode, quiescence, suspense. The spike had none of them; §4's new
mechanisms (weak plane links, the four flip sites, plane persistence,
the settlement re-mark, the population rule) are exactly the closure of
that gap.

## 4. Program 2 — the production mechanism (§3–§4 REVISED 2026-07-06, second pass)

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
  job dissolves because effect re-checks validate through plane marks
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

### 4.1 Which worlds get planes — and the ONE lifecycle story (fable B2)

- **newest** — IS the kernel; no plane, no shadow (the `newestMemos`
  ladder arm survives until S-C as the temporary newest
  representation — §4.8, codex 7 — then deletes).
- **pass worlds** — one pooled plane per open pass: claimed at
  `passStart`, dropped in `reclaimAfterPassEnd` — which already runs
  AFTER mount fixup and after the re-staled detection loop, so the
  fixup closure and the populator both see the plane (m2's ordering,
  pinned with a dev assert: fixup/re-staled touching a dropped plane
  throws). Commit and discard drop identically.
- **committed-for-root worlds** — one plane per root, materialized
  lazily at the root's first committed-world evaluation. **Committed
  planes are permanent for the root's life: they survive pass ends,
  retirements, quiet mode, and QUIESCENCE.** They die only with the
  root record (host teardown) or bridge disposal. This is the single
  story replacing the first pass's three (fable B2): no drop at
  quiesce, no "pool at quiescence", and the first pass's "zero live
  worlds while quiet" invariant is STRUCK — the true asserted
  invariant is **zero live PASS planes while quiet** (quiet ⇔ no open
  passes) plus §4.3's quiet-fold fanout site (d).
- **mountFix worlds** — remain one-shot planeless fold-throughs
  (unchanged).

**Consequences of committed-plane persistence, each walked:**

1. **Quiescence sheds work instead of gaining it.** Today `quiesce()`
   bulk-resets K1 and then runs the kernel-pull refresh precisely
   because the routing coverage committed observers rely on dies with
   the old episode's K1. Plane links are CURRENT structure, not an
   episode-accumulated log — nothing resets, so **the kernel-pull
   refresh is replaced by persistence, not by a substitute mechanism**.
   Fable B2's resolution-2 schedule now walks green: watcher `w` on
   `C` (deps `{A}`) committed in R; quiesce (R's plane keeps `A→C`);
   event-handler write to `A` in new batch T → the delivery walk over
   kernel ∪ live planes finds `A→C` in R's plane → `w` delivered in
   T's lane. What `quiesce()` keeps: the residue asserts, epoch bump +
   event, slot/dedup zeroes, dead-record reclamation — plus one new
   duty: per-plane read-clock renumber (§4.5.7).
2. **Quiet mode runs ON planes — flip site (d).** `__quietWrite`
   already calls `quietDrain` + `revalidateCommittedSubs(undefined)`,
   both of which evaluate committed worlds; under NF2 those
   evaluations use the surviving committed planes, so the quiet fold
   must fan: after `base/cas` advance, mark the folded atom's shadow
   in every live committed plane (guarded by one `planesLive !== 0`
   scalar check). Fable B2's resolution-1 schedule walks green:
   quiesce → quiet write to `A` → fanout marks `A` in R's plane →
   `quietDrain` evaluates the watcher's computed committed → mark
   propagation reached it → refold → fresh value →
   `quiet-mode.spec.ts` stays green. PR1 accounting: an app with NO
   React consumers never materializes a root, hence never a plane —
   its quiet write pays exactly the one scalar check (same class as
   today's `watchers.size !== 0` branch); an app WITH live watchers
   already pays `quietDrain`'s full evaluation sweep per quiet write
   today, and marks make that sweep cheaper, not dearer (unmarked
   shadows serve O(1)). Gated by the logged-quiet bench residuals P1
   just re-published.
3. **The zero-worlds steady state, stated:** quiet + no consumers ⇒
   no planes exist at all (lazy materialization has no trigger);
   quiet + consumers ⇒ pass planes zero, committed planes idle with
   all shadows clean, fanout O(marked=1) per quiet write with the
   read-clock dedup making repeat marks O(1).
4. **The fourth fanout site exists** — (d) quiet fold, added to
   §4.3's list. B2's "missing fourth site" is thereby answered rather
   than argued away.

Pooling: pass planes pool (per-pass churn is the hot case); committed
planes do not pool (long-lived). Every pool tenancy carries a claim
generation checked by the structural validator so a dead tenancy's
residue can never validate (§4.6).

### 4.2 Values: grounding shadow atoms in folds — and the fp rule with B3's carve-out

A world's atom value is `foldAtom(atom, world)` — the existing packed
fold under the existing two-clause visibility rule — computed lazily at
the atom's first read in that plane and stored in the plane's value
column together with a per-plane atom fingerprint (`fpOf(atom, world)`,
the max-visible-seq the fold observed). What dies is every PER-COMPUTED
fingerprint: computeds validate structurally (shadow flags +
`wCheckDirty` + the §4.5.3 value cutoff), never by per-dep fp scans.

**The fp decision procedure, per flip site (fable B3).** A re-marked
shadow atom must decide whether its fold actually changed before
propagating. `fpOf` tracks only the visible MAXIMUM sequence, and the
engine's own rule at `validateMemoInner` — "evict, never
fingerprint-rescue" — exists because a per-root commit flips visibility
of receipts BELOW that maximum. So the rule is split by what each flip
site can do:

- **Sites (a) retirement, (c) member write, (d) quiet fold:**
  monotone-max flips — a retirement mints a fresh `retirementStamp`
  above every prior seq, a member write appends a new maximum, a quiet
  fold advances `baseSeq`. Here `fp unchanged ⇒ fold unchanged` is
  sound, and mark consumption MAY fp-gate (skip the refold when the
  stored fp equals the recomputed one) before falling back to
  refold + value-compare.
- **Site (b) per-root lock-in: NEVER fp-gate.** Membership exposes
  receipts at or below the already-visible maximum. Every atom marked
  by a lock-in fanout REFOLDS unconditionally and value-compares
  (write-equality per world) before propagating; fp serves only
  one-directionally (fp moved ⇒ certainly refold), honoring
  evict-never-fingerprint-rescue at exactly the site where the old
  mechanism enforced it. Completeness: lock-in of token T changes
  visibility of exactly T's receipts, and T's receipts live on exactly
  `T.atomsTouched` — so refolding the fanned set is the whole flip.
  **Pinned engine test:** B3's seq-50-under-100 shape (retired seq 100
  visible; live T holds seq 50 on the same atom; lock T in; the
  committed world must show T's write despite an unmoved fp).

This split is also the honest form of the first pass's
"lock-in fanout replaces commit-generation re-keying": it replaces it
only TOGETHER with refold-always at (b) — re-keying evicted the whole
plane because fp could not see below-max flips; (b)-fanout refolds
precisely the flipped atoms instead, and never trusts fp there.

### 4.3 Invalidation: fanout at four flip sites, the pass-plane rule, and the ordering joint

`writeAtom`'s changed-write tail and the boundary operations fan into
live planes with the read-clock dedup — but not uniformly:

- **Pass planes receive NO receipt-driven fanout, ever.** The pin
  proof stands for everything receipts can do: every later write's seq
  postdates the pin (clause 2 excludes it), a later retirement's stamp
  postdates the pin (clause 1), compaction is pin-gated, and writes
  during render throw (RCC-UM2). So a pass-plane value, once folded,
  is valid for the pass's whole life AGAINST RECEIPT MOTION — enforced
  by a dev assert (a receipt-flip fanout reaching a pass plane is a
  bug). **The one pin-exempt mark source is L4 resource settlement**
  (§4.5.4): SU5 requires a suspended pass's retry to observe
  settlement, settlement is monotone (pending→settled, never a value
  revert), and RT1's freezing quantifies over STATE (receipts), not
  over resource entries — the contract's own L4 definition says
  entries are shared across views by key. Codex 5's schedule is
  exactly this: the assert is scoped to receipt flips so the
  settlement re-mark can pass.
- **Committed planes receive fanout at COMMITTED-TRUTH motion.** The
  four sites and their code joints, each fanning the flipped atoms'
  shadows (mark + read-clock dedup) and propagating kernel-style
  PENDING over the plane's out-links (strong AND weak — §4.4):
  - **(a) retirement** — in `retireInternal`, after stamps + `cas` +
    compaction, before the drain loop: fan the retiring token's
    `atomsTouched` into EVERY committed plane.
  - **(b) per-root lock-in** — in `passEnd(commit)`'s
    `maskTokenRecords` loop, immediately after each
    `committedTokens.add`/`commitGen++`/`cas` and before that token's
    drain call: fan THAT token's `atomsTouched` into THAT root's
    plane, **per locked-in token** (m4 — commits lock in SETS of
    tokens; the fanout runs inside the per-token loop, not once per
    commit), with §4.2's refold-always consumption.
  - **(c) committed-member write** — at the write-path lines that set
    `committedDirtySlots`: fan the ONE written atom into each member
    root's plane. Marks only — the effect scan stays at the next
    boundary (EF2 as amended; §4.0).
  - **(d) quiet fold** — in `__quietWrite` after `base/cas` advance,
    before `quietDrain`/the sub scan (§4.1.2).
- **Newest needs no fanout**: the kernel's own propagate IS newest
  invalidation (unchanged).

**The ordering joint (amendment 6), in plane terms:** at every
boundary operation, fanout marks land immediately after the
committed-side mutation they describe and BEFORE any same-operation
committed-world evaluation — and both consumers of those marks (the
watcher drain's value re-checks and the boundary's
`revalidateCommittedSubs` scan at op end) are evaluations, so both see
the marked planes. Concretely the per-site order is: mutate
(membership/stamps/cas) → fan → drain → …rest of the operation… →
`revalidateCommittedSubs` → `flushNotify`. One pinned ordering test
per site; site (c)'s marks land at the write, strictly before any
boundary that could scan them, which is what remains of codex-9's
first coupling after the EF2 ruling.

**Mark consumption discipline** (the keep-the-dirt analog): a shadow's
mark clears only when its refold/revalidation actually ran — marks are
consumed by evaluation, which is always safe because marks are
per-world and no other world can see them. Each committed plane keeps
a dirty LIST (ids appended on a mark's 0→1 edge — the plane analog of
`slotTouched`); a drain swaps the list, collects, and re-appends any
entry still marked after its evaluations, so an unconsumed mark (a
cone no observer evaluated) survives to the next boundary instead of
being lost.

### 4.4 Deliveries and drains — the redesigned plumbing (the load-bearing section)

Today write-time value-blind deliveries walk K0∪K1; durable drains
seed from per-slot touched lists expanded over weak edges plus the
`restaled` set; mount fixup closes over reverse K1. NF2 deletes K1's
memo-invalidation job; the ROUTING jobs are re-homed as follows.

**4.4.1 Untracked-read coverage: per-plane WEAK LINKS (codex 3 / fable B1).**
The first pass's premise ("untracked reads leave no link in any
design") was false at HEAD — `recordWeakEdge` fires unconditionally on
every untracked read — and its TAINT replacement provably
under-covered. The replacement mechanism: **an untracked read records
a weak-flagged link in the evaluating plane** (one flag bit in the
link record's spare field; same record layout, same in-place-reuse
discipline), unconditionally, exactly as HEAD's weak plane does —
restoring BOTH of HEAD's mechanisms with one structure:

- *Value validation* (B1's mechanism 1): weak links participate in
  mark/PENDING propagation and in `wCheckDirty` — a marked untracked
  dep refolds, value-compares per world, and on change marks its weak
  dependents PENDING, so the cached computed refolds. This is the
  structural transliteration of HEAD's "untracked dep enters the
  memo frame's fingerprint set".
- *Drain candidates* (B1's mechanism 2): drain collection expands
  marks over ALL plane links, weak included — subsuming HEAD's
  weak-expansion AND its strong-past-weak-hop rule (transitive plane
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
marks `a` in A's plane → weak `a→c` propagates PENDING → `c`, `d`
marked → drain collects the watcher off the dirty list → committed
re-evaluation → correction to 3 ✓ — the pinned schedule stays green
byte-identical). **Fable B1's read-before-pending schedule**: `C`
reads `A` untracked while committed-quiet — C's committed-plane
evaluation recorded weak `A→C` at that moment (recording is
unconditional, not pending-gated, which is exactly where TAINT
failed) → T writes `A`, retires → fanout + weak propagation + drain →
correction ✓. Newest evaluations record no weak residue anywhere —
matching HEAD's observable behavior, since HEAD's weak edges feed only
committed drains, and a node with a committed consumer gets its weak
links recorded by that consumer's own committed evaluations (§4.4.2).
Price: weak links are ordinary plane links (spike's link-record cost
tables apply); the delivery walk pays one bit test per traversed
plane link; TAINT and its propagation DELETE at S-B (its only
remaining consumer after the fast-path deletion below is `sweepK1`'s
keep-mask, which dies with K1) — the taint bit was strictly weaker
coverage than weak links, so nothing is lost.

**4.4.2 The committed-plane POPULATION RULE (fable M1) — first-class.**
Fanout writes marks; drains expand marks over links; so the coverage
argument needs the plane to already HOLD the consumer's committed dep
links. The populators are the committed-world evaluations themselves —
link recording happens on every plane evaluation — and the rule names
their unconditional sites:

1. **The `passEnd` re-staled detection loop** — committed-evaluates
   EVERY rendered watcher's node at EVERY commit (mounted watchers
   included, since `mountWatcher` adds to `p.rendered`), recursively
   populating the root plane with each watcher node's full current
   committed dep cone (strong + weak) before `passEnd` returns —
   i.e., before any post-commit write needs routing. **This loop is
   hereby DECLARED load-bearing for routing** (M1's demand): its fate
   is survival verbatim plus a new dev assert pinning the property
   ("after a commit of pass P, every live `w ∈ p.rendered` has a
   shadow for its node in the root's plane") and a pinned schedule
   (M1's walked shape: mount `C=f(A)` in R, commit, handler write to
   `A` in fresh batch T2 → the walk finds `A→C` in R's plane →
   delivery ✓).
2. **Durable drains' value re-checks** and **`quietDrain`** — every
   correction compare is a committed evaluation.
3. **The boundary effect scans** — `captureRun`/`captureRead` and
   `revalidateCommittedSubs` evaluate every effect dep
   committed-for-root, populating the plane with effect-dep cones per
   run.
4. **The shim's reveal compare** (`resubscribeAtLayout`'s
   `committedValue` call) — M1's second unnamed carrier, named: it
   survives verbatim and is itself a populator.

Commit-time migration of pass-plane links into the committed plane —
M1's other candidate — is REJECTED, on lifetime grounds (§4.6): links
enter a plane only paired with the evaluation that chose them; a pass
world's dep choice can differ from the committed world's (that is
battery case 1's whole point), so migrated links would be
wrong-not-just-extra structure filed across a lifetime boundary. The
re-staled loop re-DERIVES instead, at a cost the engine already pays
today.

**4.4.3 Write-time delivery** becomes reachability over the kernel's
subs links ∪ every live plane's STRONG links (pass planes included —
the walk visits structure, never values or marks, so §4.3's pin
invariant is untouched), collecting live `deliver`-subscriptions
(watchers) and enqueuing newest-policy subscriptions on visited nodes.
Value-blind by construction (RCC-SP5 preserved); the per-(watcher,
slot) dedup bit and the interleaved-delivery rule are per-subscription
policy, untouched. Per-plane walk-generation columns give termination
without allocation, as in the spike.

**4.4.4 The coverage argument, restated honestly (M1's sharpening
adopted).** Under NF2, deliveries and drain candidates share ONE
structural source — plane links — where HEAD had two independent nets
(episode-union K1 for deliveries; slot-touched lists + weak edges for
drains). A routing miss is therefore stale-until-cone-motion, not a
lane demotion; the first pass's R2 wording understated this and is
corrected in §6. The argument that the required coverage survives:
(i) an already-rendered consumer's links exist in its pass plane
(alive until pass end) and in its root's committed plane (populated
per §4.4.2, alive for the root's life, surviving quiescence per
§4.1); (ii) dep flips re-track links at the refold that observes the
flip, and the write that CAUSES a flip is routable through the
pre-flip links (the discriminant edge argument), which the plane
holds; (iii) untracked deps are covered by §4.4.1's weak links in
every plane a committed consumer evaluates in.

**4.4.5 The known residual — codex 4's dead-plane gap: a SCOPED
RETREAT, pinned.** Schedule: committed `c = flag ? a : b` with
`flag=false`; parked T writes `flag=true` (delivered into T); T's
pass evaluates the `a` branch and is DISCARDED (its plane — and the
only `a→c` link — dies) while T stays pending; independent batch U
writes `a` in the gap. No live plane holds `a→c` (the committed
plane's links are `{flag,b}→c`, correctly — committed truth still
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
candidate set becomes: the root plane's dirty list (marks from §4.3's
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
walks reverse links over kernel ∪ the mounting pass's plane ∪ the
root's committed plane (three reverse walks; the pass plane is alive
here by §4.1/m2's ordering). That triple covers everything HEAD's
episode union held FOR THIS NODE except dead foreign cones, whose
exclusion is safe by the same discriminant argument — and the landed
fast-out AUDIT (divergence under a passing fast-out must be exactly
covered by scheduled correctives, asserted on every mount) is the
standing tripwire for closure under-coverage, so this narrowing is
audited at runtime, not assumed.

**4.4.8 The touched word, TAINT, and the world-read fast path.** Bits
0–30 and `slotTouched` die at S-B (drains seed from plane dirty
lists). The `evaluate()` fast path — "touched word 0 ⇒ serve the
validated newest memo to any world" — DELETES at S-A when world reads
route to planes, and TAINT (its poison guard) with it at S-B. Price,
stated: cold first-reads in a fresh pass plane fold instead of
borrowing the newest cache. The spike's churn bench already measured
exactly this regime at parity (§3), and §4.9.6 adds a cold-pass shape
(N≈200 quiet computeds, first render) as an explicit gate; the
header's TODO(perf) re-entry (a kernel-side fast path for provably
quiet reads) is recorded as the follow-up if that gate regresses.

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

1. **Folds** — §4.2; reuses `foldAtom`/`visibleAt`/`fpOf` verbatim
   with §4.2's per-site consumption rules; no new fold logic.
2. **Pins** — §4.3; the receipt-fanout ban plus pin-gated compaction
   are the entire pin story; no per-plane pin state exists; the one
   pin-exempt mark source is settlement (§4.5.4).
3. **Per-world equality (codex 6) — the record shape, made explicit.**
   The kernel's custom-equality `Computed` wraps its fn around the
   KERNEL value slot and returns the kernel's old reference on
   equality — calling that wrapper from a plane compares against the
   wrong world's previous value (codex 6's `[0]`/`[1]` counterexample:
   false change reported, reference preservation broken). The
   production shape separates four things:
   - *raw getter* — the unwrapped user fn, stored separately at
     construction (a side column keyed by kernel id, populated only
     when `equals` is non-default; default-equality computeds need no
     entry);
   - *comparator* — the `equals` fn, same side column;
   - *plane-local previous value* — the shadow's value-column slot in
     THE EVALUATING PLANE (never the kernel slot);
   - *exceptional-outcome bits* — per-shadow flag bits (has-box /
     box-suspended, mirroring the kernel's own box discipline) with
     the box payload in the value column.
   `wUpdate` then is: `prev = plane value slot; next = rawFn();
   changed = !(prevValid && !exceptional && equals(next, prev))`; on
   unchanged, KEEP `prev`'s reference (write nothing, clear DIRTY, no
   propagate); on changed, store + propagate. Equality never bridges
   an exceptional boundary (value↔box is always changed; box→same-box
   by sentinel identity is unchanged — the plane-level twin of
   battery 16d's still-pending rule). Until S-C, overlay
   `ComputedNode`s get the same cutoff through the fn-reader epilogue
   writing the shadow value column (their equals semantics today are
   `Object.is` at the memo compare; unchanged). One pinned test per
   arm, including codex 6's reference-preservation shape run in three
   planes at once.
4. **Sentinel boxes + THE SETTLEMENT RE-MARK SITE (codex 5 / fable
   M2 / P1 handoff item 2).** A suspended background evaluation
   stores its stable `SuspendedRead` sentinel in the evaluating
   plane's value column with the box-suspended bit (render-path
   evaluations rethrow; the `suspendDepth` discipline stays
   adapter-side, unchanged). **Settlement re-marks:** the kernel's D5
   settlement-invalidate primitive (`invalidateComputed`, already
   called by every `ctx.use` settle listener) gains ONE
   bridge-registered hook — set at `registerReactBridge`, cleared at
   dispose, one closure per BRIDGE, zero per-plane or per-key
   allocation. On settle of a key held by computed `c`, the hook
   walks the live planes (pass AND committed — the pin-exempt case,
   §4.3): for each plane whose shadow of `c` holds a box whose
   payload IS this key's sentinel (identity — sentinels are stable
   per thenable), mark DIRTY + propagate PENDING; a plane that died
   first is a lookup miss (no dangling listener — the hook holds the
   bridge, the bridge holds planes, nothing retains thenables).
   Until S-C, the shim's second ctx wiring forwards its settle
   callback through the same hook. Scheduling stays the host's:
   React's own retry ping re-renders suspended trees; the library's
   job is that the retry and the next boundary scan SEE the settled
   value — which the mark guarantees (fable M2's schedule: sentinel
   cached in R's plane; K settles → re-mark; the effect's next
   boundary re-check refolds → sentinel→value IS a flip → refire; no
   more sentinel-forever). **This FIXES a pre-existing HEAD gap** (P1
   handoff, confirmed watcher-reachable at HEAD): today a committed
   memo caching a sentinel refreshes only when committed-truth motion
   happens to move `cas`; the re-mark is precise and unconditional.
   Pins: an engine re-mark test (background-cached sentinel, settle,
   assert next drain/scan refolds) + a React-battery settlement case
   through the background path (the coverage fable M2 showed the
   battery lacks), + RCC-SU5 cited in both.
5. **`ctx.use`** — unchanged L4 semantics: ONE per-key cache scoped to
   the living node, shared across worlds BY DESIGN (SU3's key carries
   world-varying inputs). Planes add only §4.5.4's re-mark. The F5
   unification still deletes the shim's second wiring at S-C in favor
   of the kernel ctx layer's packed side-column cache.
6. **`ctx.previous`** — unchanged from the first pass: inside a world
   evaluation frame `previous` serves the node's last-COMMITTED cell
   (maintained at `passEnd(commit)`, moving from `shim.previousCells`
   into the bridge at S-C); plain path keeps kernel semantics; its own
   test.
7. **Read-clock wrap (int32)** — per-plane clocks renumber (stamps
   zeroed, clock reset) at quiescence as §4.1.1's new `quiesce()`
   duty; a forced-wrap test drives a plane past 2^31 stamps via a
   test-only clock preset. If quiescence proves too rare in
   long-session profiles, the fallback (widen to float64 columns) is
   recorded; decided at implementation, tested either way.
8. **Growth-mid-op reload** — every allocating world call re-loads
   `w.W`; enforced by (a) the spike's structural validator promoted to
   a dev-mode invariant run after every op in engine tests, (b) a
   stride-sized-initial-plane test so every growth path exercises
   mid-walk, and (c) React scenarios run with a tiny default plane
   size in test builds (the R8 hunt, unchanged).

### 4.6 Lifetime classification (contract §2/§6 step 1 — the mandatory table)

Every piece of state Program 2 introduces, exactly one lifetime each
(contract rule: classify BEFORE choosing the data structure; the
"derived-of" column says what the state is bookkeeping ABOUT, since
caches inherit obligations from what they mirror):

| state | lifetime | derived of | created | destroyed | teeth (what the classification forbids) |
|---|---|---|---|---|---|
| pass plane (shadows, strong+weak links, value columns, marks, walk/read-clock stamps) | **L3** per-attempt | the pass world's frozen view | `passStart` (pool claim) | `reclaimAfterPassEnd` (pool release; after fixup + re-staled loop, m2) | never consulted by fold/visibility machinery; nothing in it survives the pass — no value/link migration to any other plane (§4.4.2's rejection); settlement re-mark may INVALIDATE entries, never persist them |
| committed plane (same columns, per root) | **L1**-derived (re-creatable cache OF committed truth) | `foldAtom` over tapes/base per the visibility rule | lazily at the root's first committed evaluation | with the root record / bridge dispose — NOT at quiescence (§4.1) | never a source of truth (tapes+base are); serves only through the §4.2/§4.3 mark discipline; holds no receipt, stamp, or payload the tape doesn't |
| fanout marks + per-plane dirty lists | same lifetime as their plane | pending invalidation facts about that plane | flip sites (a)–(d), settlement | consumed by evaluation only (§4.3's keep-the-dirt analog) | a mark may never clear without its refold having run; marks never cross planes |
| plane POOL (free Int32Array buffers) | mechanism, not state — holds NO tenant state between claims | — | bridge init / growth | bridge dispose | each tenancy stamps a claim generation; the validator rejects any record citing a dead generation (no I4-shaped immortal residue) |
| per-plane cached evaluation outcomes: values, `SuspendedRead` sentinels, error boxes, outcome bits, plane-local previous values (§4.5.3–4) | the OWNING PLANE's lifetime (L3 or L1-derived) | one world's last evaluation outcome | that plane's evaluation | with the plane, or overwritten by refold | a sentinel cached here is an OUTCOME record, not the resource: it must be invalidatable without touching the entry (§4.5.4) and must never gate another world's read |
| the `ctx.use` per-key entry (thenable, settled value) | **L4** (unchanged, pre-existing) | the request | first read of the key | with the living node (WP3) | keyed by request, never by consumer or plane; monotone; shared across worlds by design |
| the settlement hook (one closure per bridge) | mechanism (bridge lifetime) | — | `registerReactBridge` | bridge dispose | holds the bridge only; retains no thenables, planes looked up at fire time |
| per-kernel-id rawFn/equals side column (§4.5.3) | node lifetime (registration bookkeeping, same class as the node record itself) | the authored computed | node registration | node disposal | policy lookup only; never consulted by folds |

No new L2 state exists: Program 2 writes no receipts and touches no
retirement machinery (§3 item 8). The P1 subscription record's
classification (§2.3) is unchanged. Resistance check (contract §6):
every row above took exactly one lifetime without force — the two
that resisted in the first pass (committed planes "long-lived or
pooled?"; sentinel boxes "resource or cache?") are resolved by the
derived-of column: a committed plane is L1-derived bookkeeping and so
survives episodes like the obs plane does; a cached sentinel is a
plane-lifetime OUTCOME of reading an L4 entry, not the entry.

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
  rejected arm). Rule: the world walks route every dependency read
  through the same capture hook AT THE READ, before `wLink`'s reuse
  cursor logic — mirrored comment at both sites. **Pinned BEFORE S-C
  lands** (M6's schedule): observed computed `C` with committed-world
  deps `{A}` and newest deps `{B}` (world-divergent flag); drive a
  committed re-evaluation through a drain — via the WORLD path — and
  assert `A` gains/holds its retain and `B`'s releases.
- **The weak bit in the walks (§4.4.1):** `wPropagate`/mark
  propagation traverse weak links; the delivery walk skips them;
  `wCheckDirty` consults them; teardown unlinks them identically.
  The validator checks weak-link list symmetry exactly like strong.

### 4.8 Migration path, re-derived so every stage is green-runnable (codex 7)

The +0.5 ns computed-read seam still lands only in S-C. The stages,
each with its executable-state answer, what it deletes, and its
divergence rule:

- **P2.S-A — planes as the WHOLE value+invalidation layer for pass
  and committed worlds; K1 still owns all routing.** Honest contents
  (m1's restatement adopted — this is the majority of NF2's new
  write-path logic, not a value-store stub): plane
  allocator/registry/claim-generations; shadow records + strong/weak
  link recording BY THE EXISTING fn-reader (`trackedReader`/
  `untrackedReader` record into the active world's plane in addition
  to K1); folds into value columns (§4.2); ALL FOUR flip sites +
  settlement re-mark (§4.3, §4.5.4) — mandatory in this stage, since
  with `validateMemoInner`'s pass/committed arms deleted, plane
  values are correct ONLY under complete fanout; the §4.5.3 equality
  record; the world-read fast path deletes (§4.4.8).
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
  plane values and the model; the structural validator checks each
  graph internally. **Divergence mid-stage is a STOP** — with K1
  still routing, any lockstep diff indicts the plane value layer
  (folds/fanout/equality/boxes) in isolation, which is this stage's
  entire point (§6-R3). Bench gate: dual-write cost within the
  spike's live-world envelope.
- **P2.S-B — routing re-homed; K1 deleted.** Delivery walk →
  kernel ∪ planes with the weak-skip (§4.4.3); drains → plane dirty
  lists + `restaled` (§4.4.6); mount fixup closure → the §4.4.7
  triple; quiesce body shrinks (no K1 reset, no kernel-pull refresh,
  no weak reset; planes persist; read-clock renumber added). Deletes:
  `outSets`/`outList`/`inList`, `recordEdge`'s K1 half (the
  obsCapture hook and plane recording remain in the fn-reader),
  `sweepK1`, `propagateBits`/`applyBits`/`slotTouched`/touched bits
  0–30, TAINT + `propagateTaint`, `weakOutSets`/`weakOutList`,
  `recordWeakEdge` (superseded by plane weak links), `subDepRefs`
  (§4.0), the quiesce refresh-target scan. Delivery-decision changes
  are possible here (fewer, never more): the ⊆ bound plus S-NF2-D1
  and the §4.4.2 pins police it; comparator noise beyond the
  documented band is a STOP, not a tolerance to widen.
- **P2.S-C — F5: one computed.** Kernel `Computed` evaluates under
  worlds via the transliterated walks carrying §4.7's two
  disciplines (the M6 pin is an ENTRY GATE for this stage, written
  and green against S-B first); the fn-reader/`ComputedNode` path,
  `newestMemos` + the ladder's last arm, the shim's second ctx wiring,
  `makeComputedNode` + `previousCells`, and `useSignal`'s kernel-
  computed rejection all delete; the read seams land (+0.5 ns pinned);
  `useComputed` keeps its deps-keyed contract (WP3). Node identity
  re-keys to kernel ids — the §4.5.3 side columns are already keyed
  that way. The hang schedule pins GREEN here (it needs kernel
  computeds under worlds; it is ported and red-wired during S-A).
- **P2.S-D — perf closure.** Plane pooling hardened, wrap tests,
  full bench battery (§4.9.5), spike benches ported under real names
  (F7 hygiene), README/API docs for the unified computed story.

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
3. **The review-mandated pins, by name:** codex 3's "taint member"
   battery schedule green byte-identical (§4.4.1); fable B1's
   read-before-pending schedule (new engine pin); fable B3's
   seq-50-under-100 lock-in shape (§4.2); M1's population schedule +
   the post-commit population assert (§4.4.2); S-NF2-D1 ×3
   interleavings with documented degraded-but-correct outcomes
   (§4.4.5); the settlement re-mark engine pin + React-battery
   background-settlement case (§4.5.4, RCC-SU5); codex 6's
   reference-preservation shape ×3 planes (§4.5.3); M6's world-path
   retain re-point schedule as S-C's entry gate (§4.7); m2's
   plane-drop-after-fixup dev assert; the §4.3 per-site ordering
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
6. **Bench battery re-run**: sync shapes with the head-bridge anchor;
   discard churn (bulk + surgical); world evaluation (1/all/none
   dirty); idle-world scaling at w1/w4; **plus two shapes the reviews
   added**: a write+commit+drain CYCLING shape (fable N2 — the
   read-clock dedup resets every consume cycle, so idle-mark numbers
   alone under-price drain-heavy apps) and the §4.4.8 cold-pass shape
   (N≈200 first-render reads). Checksum parity across impls as the
   spike did.
7. **Quiet-mode / sync-neutrality re-proof**: `quiet-mode.spec.ts` and
   `one-core.spec.ts` probes green untouched; PR1 ledger updated (the
   +0.5 ns branch pinned; the quiet write's one `planesLive` branch
   documented per §4.1.2); PR2 re-proof via §4.1.2's flip-site (d)
   walk (quiet folds ARE fanned — the first pass's "quiet folds bypass
   planes" claim is retracted).

### 4.10 Deletes vs adds (honest ledger, second pass)

**Deletes**: memo ladder ~200 (S-A: pass/committed arms; S-C: newest
arm); K1 log + sweep + touched/taint machinery + weak lists ~250
(S-B); quiesce refresh + refresh-target scan + `subDepRefs` ~60
(S-B); newest-plane special case ~40 (S-C); `ComputedNode` path + shim
second wiring ~150 in cosignal-react + ~80 in cosignal (S-C).
**Adds**: planes/pooling/claim-gens ~140; transliterated walks ~300
(incl. weak-bit handling + capture hook); fanout at FOUR sites +
settlement re-mark hook ~110; §4.5 policy items (equality columns,
boxes, previous, wrap) ~110; validator + pins (test-side).
**Net**: cosignal roughly +200 to +350 source lines and −3 concepts
(ladder, K1-as-invalidation, second computed API) against +2 (planes,
fanout); cosignal-react −~150 lines; public surface −1 API. Still
adopted as a PERFORMANCE mechanism with an API prize, per the spike's
verdict — the second pass has made it slightly LARGER, not smaller,
because the reviews showed the untracked/lifecycle/settlement halves
were real mechanism, not detail; that cost is now priced instead of
hidden.

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
   `evaluate(node, world)` — the same call before and after planes —
   and the record references nodes opaquely, so S-C's identity re-key
   touches no subscription code.
4. The member-write joint landed as `committedDirtySlots` marking
   (no immediate scan — EF2 as ruled); P2's flip-site (c) fans at the
   same lines (§4.3), the deliberate joint the first pass promised.

**P2 stage gates, in order:** (i) this revision passes its focused
re-review (amendment 7's condition); (ii) RUL-3 (§7) is answered —
the landing-without-profile-evidence question is unchanged and still
blocks S-A; (iii) S-A's test-first artifacts (hang-schedule port,
acyclicity fuzz ops, the §4.9.3 pin list written red-first where the
mechanism doesn't exist yet) precede S-A engine code; (iv) the M6 pin
is green before S-C starts (§4.7); (v) RUL-4 before S-C's public-API
change. Battery 16b–16h (P1's boundary pins) must stay green untouched
through every P2 stage — they are the regression fence for the
substrate P2 builds on.

## 6. Risks — written against this plan (attack surfaces first)

- **R1 — RESOLVED (2026-07-06).** The EF2 seam was ruled (boundary
  semantics, amendment 1), the pins were written mutation-verified
  (battery 16b–16h), and P1 landed on them. Kept for the record; P2
  must not reopen it (the 16-series stays green through every stage).
- **R2 — delivery coverage under one structural source (REWRITTEN,
  second pass).** §4.4 now names the mechanisms the first pass left
  implicit: per-plane weak links (§4.4.1) carry the untracked family;
  the population rule (§4.4.2, the re-staled loop + reveal compare,
  declared and pinned) carries the committed-plane premise; plane
  persistence (§4.1) carries the post-quiescence window. The
  remaining, DECLARED residual is codex 4's dead-plane gap
  (§4.4.5) — value-correct, lane-degraded, pinned as S-NF2-D1 with
  documented outcomes, defensible under SP5's letter and the
  comparator's ⊆ delivery bound. M1's sharpening is adopted: a
  routing miss under NF2 is also a drain-candidate miss (one shared
  source), which is exactly why the population rule and the §4.4.9
  exact-stream map are load-bearing, and why S-B comparator noise
  stays a STOP.
- **R3 — per-world policy state (AMENDED per m1).** Folds under
  planes remain the sharpest edge, but S-A is now honestly scoped as
  the folds+fanout+flip-sites+equality+boxes stage — the majority of
  NF2's new write-path logic — with K1 still routing so every
  divergence indicts the value layer in isolation; the divergence
  detector (lockstep per-op world snapshots + exact
  correction/effect streams) and the mid-stage STOP rule are stated
  in §4.8, not assumed.
- **R4 — RESOLVED INTO MECHANISM + ONE REMAINING TRIPWIRE.** P1
  landed the conservative arm: `obsCapture` feeds pre-dedup inside
  `recordEdge`, and effect snapshots joined the union (RUL-2 ruled
  via OL1). The surviving risk is exactly fable M6's: the S-C walk
  swap silently dropping the capture (or placing it post-reuse-check)
  — closed by §4.7's discipline and its BEFORE-S-C pin. The
  watched-links collapse stays a rejected follow-up with the same
  walked entry test.
- **R5 — world-count scaling (kept; pricing widened).** Fanout is
  O(live planes) per changed write; committed planes are long-lived,
  per-root, and now explicitly PERMANENT (§4.1), so the many-root
  residual is permanent too: R planes × 32–64 KB plus the fanout
  branch per write (spike: 4 idle worlds +6.9–9.6%). Mitigations
  unchanged (lazy materialization, read-clock dedup, pooling, R=4
  bench gate with the head-bridge anchor) — plus fable N2's
  correction: idle-mark numbers under-price drain-heavy apps because
  consuming marks resets the dedup, so §4.9.6's cycling shape is part
  of the gate. Residual measured and published, not hidden.
- **R6 — migration atomicity (REWRITTEN against §4.8's staging).**
  S-A is now the largest stage (m1) but is value-layer-only by
  construction; S-B is a routing-only diff whose failures surface as
  exact-stream diffs; S-C concentrates the public-API and identity
  re-key risk and carries two entry gates (M6 pin; RUL-4). The
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
- **R8 — plane growth-mid-op is a new bug CLASS, not a bug.** `w.W`
  reload after allocating calls has no type-system enforcement.
  Mitigations (§4.5.8): stride-sized-plane growth tests + validator.
  Residual: a growth path only reachable under real React interleavings
  — the React scenarios run with a tiny default plane size in test
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

## 8. Gate summary (every stage, no exceptions)

Package suites (`packages/cosignal`, `cosignal-react`,
`cosignal-oracle`) + typechecks; oracle lockstep fuzz corpus with zero
diffs (tolerances only as documented — any new tolerance is a finding);
the 17-case battery at model and React level + scars + flags;
conformance ×3 (179 cases per configuration); the React scenarios; the
hang schedule (ported at P2.S-A, pinned green from S-C when kernel
computeds evaluate under worlds) and the structural validator (from
P2.S-A); the
bench battery with published numbers at P1.S4 and P2.S-D (sync shapes +
head-bridge anchor, discard churn, world evaluation, idle-world scaling,
quiet-mode probes). Any stage that surfaces a contract question stops
for an owner ruling rather than inventing semantics.
