# Battery manifest — browser-real concurrent-signals verification

The contract for `battery/`: every scenario this battery owes, where it came
from, what each implementation is expected to do, and whether it is built yet.
Scenarios are deduplicated by compliance-contract clause; parameter variants
(hold mechanism × latency × timing) are separate rows when they change what is
exercised. Test titles cite row ids, so a report line reads `RCC-RT3.hold
[alt-b]`.

## Scenario count

- **77 rows total**: 64 runnable scenario rows + 13 documentation rows
  (fork-only clauses, tolerances that constrain other rows, out-of-scope
  surfaces — each says why and where the clause IS covered).
- Contract coverage: all 37 requirement clauses of `spec/react-compliance-contract.md`
  §3 (RT1–OL2, including the §3 WON'T-PROMISE entries UM3/EF4 as tolerances)
  plus the six §4 WON'T-PROMISE tolerances WP1–WP6.
- Per-source: RCC clauses 43 · cosignals-react scenarios/battery 12 rows
  (generic halves) · concurrent-solid-react 4 rows · alt-a/alt-b 6 rows ·
  daishi levels 10 rows · session findings 7 rows · meta/smoke 5 rows —
  counted after dedup, so one row may discharge several sources (listed per
  row).

## The four implementations

| project | shim name | holdStyle | RT4 ruling |
| --- | --- | --- | --- |
| cosignals | `cosignals` | suspense | **newest** (scenario R15, canonical) |
| alt-a | `cosignals-alt-a` | suspense | **drafts-hidden** (ambient-W0, SPEC-RESOLUTIONS divergence) |
| alt-b | `cosignals-alt-b` | suspense | **drafts-hidden** (ambient-W0, pinned in both gate modes) |
| solid-react | `concurrent-solid-react` | defer-write | **drafts-hidden** (discovered — see below) |

**solid-react RT4 ruling, as discovered (2026-07-08):** its own suite and
README never exercise or state the outside-render-read case. Source analysis
(`src/solid/core.ts`, the world-selection ternary in `read()`): a context-free
accessor call — the default for event handlers, timers, promise continuations,
and this playground's shim (`SolidAtom.state` is a bare accessor) — always
returns the committed `_value`, never the staged `_pendingValue`
(drafts-hidden). The library's own documented `runWithOwner` idiom re-enters a
non-null owner and falls through to the pending value (newest). The battery
asserts the shim-reachable behavior: **drafts-hidden**, recorded as discovered
rather than ruled — the split is unaudited in that package, not a deliberate
divergence.

## WON'T-PROMISE guardrail

Rows tagged `tolerance` exist to keep the battery honest: a battery failure
against behavior sanctioned by WP1–WP6 (or the §3 tolerances UM3/EF4) is a bug
in the battery. Concretely: never assert cross-root frame simultaneity (WP1),
never count discarded-consumer request re-runs as refetch livelock (WP2/SU4),
never assert cache survival across deps changes (WP3), never expect post-await
writes to stay in the transition (WP4), never expect mid-render write
visibility (WP5), never look for rollback (WP6), never assert sibling effect
firing order (EF4).

## Expectation notation

- `pass` — asserted green for that implementation.
- `FINDING` — the implementation's known-divergent behavior is asserted (via
  `test.fail` or branch assertions) so a silent fix or regression is loud.
- `variant:<x>` — the row asserts implementation-specific ruled behavior `<x>`.
- `skip:<why>` — mechanism not reachable on that implementation; skipped with
  the reason as the annotation.
- Column order: cosignals · alt-a · alt-b · solid-react.

## Hold mechanisms (row parameter `hold=`)

- `hold=gate` — the testkit's write-hold harness: a transition writes atoms
  and flips a gate component that suspends on a held promise; the transition
  stays pending until released. Reachable on suspense-style implementations;
  on solid-react a thrown foreign promise freezes all commits (its documented
  divergence — exercised only by the FIND-THENABLE rows).
- `hold=nav` — the app's own navigation hold (latency=hold + RELEASE), which
  works identically on all four (defer-write derives the same pending window).
- `hold=sliced` — a CPU-heavy transition render (lattice work knob) opens a
  finite pending window with no suspension; works on all four.

---

## A. Meta / smoke (5 rows)

| id | scenario | parameters | expected | instrumentation | status |
| --- | --- | --- | --- | --- | --- |
| META-IDENT | impl-name tile matches entry; exactly one active tab | — | all pass | testids impl-name, tabbar | pending |
| META-HOLDSTYLE | page's declared holdStyle matches battery entry table | ?test=1 | all pass | `__store.holdStyle` | pending |
| META-ISOLATION | only the selected implementation's shim chunk is requested (session pin: chunk isolation) | all 4 pages, request log | all pass | request URL capture | pending |
| META-REGISTER | clean boot: register() succeeded, root rendered, zero pageerrors/console errors (session pin: registration exclusivity) | — | all pass | error budget | pending |
| META-CLOCK | 100ms clock ticks at rest; renders-committed advances | — | all pass | clock tile | pending |

## B. Reads and tearing — RCC §3.1 (16 rows)

| id | scenario | parameters | expected | instrumentation | status |
| --- | --- | --- | --- | --- | --- |
| RCC-RT1.scope-read | inside a transition scope, a read after a write sees the scope's own draft; sources: alt-a#15, alt-b#18/19 | scope read via `__store.holdTransition` | pass · pass · pass · variant:hidden (bare accessor in scope does not see own staged write — recorded) | `__store` scope-read capture | pending |
| RCC-RT1.frozen-view | a paused-and-resumed render answers reads identically across the pause | fork-only | — | — | doc: needs yield-edge introspection ([fork tests 7,8]); browser-indirect via RCC-RT5.lattice latch |
| RCC-RT2.yield-gap | writes landing while a pass is paused are not observed by that pass | fork-only | — | — | doc: [fork tests 9,10]; browser-indirect via DAISHI-3/DAISHI-6 transient checks |
| RCC-RT3.hold | urgent +1 commits alone while a held transition's count+10 stays invisible; release folds both; sources: R3/R4, alt-a#4, alt-b#2 | hold=gate | pass · pass · pass · skip:gate-freeze | write-hold harness, count trace | pending |
| RCC-RT3.sliced | urgent write mid-slice of a heavy transition render never reveals the transition's writes | hold=sliced, lattice work 20ms×25 | all pass | lattice knob, count trace | pending |
| RCC-RT3.nav-hold | urgent counter/evens commits while a navigation is held; committed view stays on the old page (lab hold scenario) | hold=nav | all pass | app testids, hold/release | pending |
| RCC-RT4-newest | outside-render read (evaluate stack) during a pending count transition sees the pending write | hold=gate / sliced (solid) | variant:newest · skip:ruled-hidden · skip:ruled-hidden · skip:ruled-hidden | `__store.read` | pending |
| RCC-RT4-drafts-hidden | outside-render read during a pending count transition sees only committed state | hold=gate / sliced (solid) | skip:ruled-newest · variant:hidden · variant:hidden · variant:hidden(discovered) | `__store.read` | pending |
| RCC-RT5.lattice | N=20 lattice readers agree in every committed frame across a burst of transition increments | lattice, per-commit latch | all pass | tear lattice + latch | pending |
| RCC-RT5.cross-hook | app consistency verdict never flips TORN through the standard drive (hold, urgent interleave, release, filter) | hold=nav | all pass | armTornWatch, torn tally | pending |
| RCC-RT5.double-read | one component reading the same atom through two hooks never sees them disagree (source: R5) | during increments burst | all pass | probe component, latch | pending |
| RCC-RT6.mount-mid-nav-hold | probe mounted during a held navigation paints committed values, self-consistent, converges after release (sources: R6/R11, alt-a#5, battery 9/10) | hold=nav, mount-probe toggle | all pass | mount probe log | pending |
| RCC-RT6.mount-mid-count-hold | probe mounted while count+10 is pending shows committed count, never the draft; joins the transition's commit at release | hold=gate / sliced (solid) | pass · pass · pass · skip:gate-freeze | mount probe log | pending |
| RCC-RT6.daishi-mount | 20 readers mounted via transition while an outside-React interval increments urgently: no torn commit, final agreement | auto-increment 50ms, hold=sliced | all pass | lattice latch, auto-inc | pending (shares DAISHI-2/4) |
| RCC-RT5/6.alt-b-mount-world | alt-b ruling (its suite #3): a component mounting inside a transition's commit reads the pending world in that same commit — same-commit agreement is what RT5/RT6 demand; which world the joint commit shows may differ | hold=sliced | all pass (agreement asserted, world recorded) | mount probe log | pending |
| RCC-RT2.late-write-not-spliced | a write landing after a transition started (while pending) does not appear in the transition's committed frame unless rebased in order (sources: daishi-6 arithmetic, UM1) | hold=gate | pass · pass · pass · skip:gate-freeze | count trace | pending |

## C. Updates mid-render — RCC §3.2 (4 rows)

| id | scenario | parameters | expected | instrumentation | status |
| --- | --- | --- | --- | --- | --- |
| RCC-UM1.rebase | +10 transition and +1 urgent dispatched in one task: urgent commits alone first, final = 11, committed sequence never shows 10 (sources: R-lab rebase, daishi-6) | same-task dispatch | all pass | count text trace | pending |
| RCC-UM2.render-write | a render-phase write to a shared atom is rejected (error boundary catches; committed state unmoved) (source: R7) | test-mode probe under error boundary | pass · pass · pass · FINDING (not rejected — recorded) | render-write probe, error boundary | pending |
| RCC-UM3 | tolerance: React's same-component setState-in-render pattern is not extended to library state; battery never exercises a render-phase library write channel | — | — | — | doc: tolerance |
| RCC-UM4.replay | interrupted/replayed renders are idempotent: interruption burst produces exact arithmetic, no duplicate resource creations per epoch | during DAISHI-5 + SU1 | all pass | fetch counters | pending (asserted inside DAISHI-5 / RCC-SU1) |

StrictMode double-invocation (UM4's other half, R9/alt-a#18/alt-b#25) is
development-only behavior; this battery drives production builds, so those
stay package-suite territory. Documented here so nobody "adds" a prod
StrictMode row that can't double-invoke.

## D. Commit and retirement — RCC §3.3 (5 rows)

| id | scenario | parameters | expected | instrumentation | status |
| --- | --- | --- | --- | --- | --- |
| RCC-CR1.no-lost-writes | interleaved urgent auto-increments and a transition write all land: final value is the exact sum | auto-inc 10 ticks + transition +10 | all pass | count trace, auto-inc | pending |
| RCC-CR2/4/5 | exactly-once retirement, no advance under an open frame, intra-commit order | fork-only | — | — | doc: [fork tests 16,17,26,28]; browser-indirect via CR1/EF1 rows |
| RCC-CR3.store-only | a transition writing only an unobserved atom persists its data (no subscribers anywhere) | transitionWrite storeOnly | all pass | `__store.read` after settle | pending |
| RCC-CR3.superseded-nav | a held navigation superseded by a second one: data of both epochs persisted, first timeline record marked superseded, committed view = newest epoch | hold=nav ×2 | all pass | timeline records, fetch log | pending |
| RCC-WP6.no-rollback | tolerance: abandonment discards rendering never data; battery asserts persistence (CR3 rows) and never asserts a revert | — | — | — | doc: tolerance backing CR3 rows |

## E. Suspense — RCC §3.4 (7 rows)

| id | scenario | parameters | expected | instrumentation | status |
| --- | --- | --- | --- | --- | --- |
| RCC-SU1.stable-promise | held navigation with urgent interleaving: resource created exactly once per epoch — re-renders re-throw the same instance, no refetch livelock (source: battery 15) | hold=nav, urgent writes during hold | all pass | fetch counters | pending |
| RCC-SU3.nav-keyed | two in-flight navigations keep distinct per-epoch resources; committed view lands on the newest epoch's data, never a mix (source: alt-a#7 / alt-b#6 shape, app-level) | hold=nav ×2, release both | all pass | fetch log, data-epoch testid | pending |
| RCC-SU3.interleaved-gates | two independent held transitions (count gate + marker gate) settle independently: releasing B commits marker while count stays pending (sources: alt-a#7, alt-b#6) | hold=gate ×2 | pass · pass · pass · skip:gate-freeze | dual write-hold harness | pending |
| RCC-SU5.settle-replay | release settles → exactly the suspended consumers re-evaluate and commit; settled data then reads synchronously (no fallback flash on later renders) | hold=nav | all pass | fallback watch, fetch counters | pending |
| RCC-SU5.cold-boot | initial page load never suspends (epoch-0 resource settled before render): no fallback at boot | — | all pass | fallback watch | pending |
| RCC-SU2 | library-provided promise caching for the batteries-included path | — | — | — | doc: the app caches promises itself (caller-cached form, SU2's second half); library-side caching is package-suite territory (battery case 15) |
| RCC-SU4/WP2 | tolerance: a consumer discarded with speculative work MAY re-issue requests; fetch-counter assertions in SU1/UM4 rows exclude discarded-consumer re-runs | — | — | — | doc: tolerance constraining SU1 |

## F. Async actions and transitions — RCC §3.5 (4 rows)

| id | scenario | parameters | expected | instrumentation | status |
| --- | --- | --- | --- | --- | --- |
| RCC-AT1.sync-writes-join | two atoms written in one transition scope stay pending together and commit together — no frame shows one without the other (sources: R12 sync half, alt-b#1, solid#3) | hold=gate; sliced for solid | all pass | dual-atom probe, latch | pending |
| RCC-AT2.post-await-urgent | async action: sync prefix stays pending (held); post-await bare write commits urgently while the prefix is still pending (WP4's positive half) (source: R12) | hold=gate action harness | pass · pass · pass · skip:gate-freeze | async-action harness testids | pending |
| RCC-AT3.rejoin | a re-wrapped (startSignalTransition) continuation after the await rejoins the same pending action batch — commits at the action's settlement, not independently | hold=gate action harness | pass · pass · pass · skip:gate-freeze — per-impl behavior recorded on first green run | async-action harness | pending |
| RCC-AT4.parked-retirement | the action's batch retires only at settlement: prefix invisible until release even after post-await writes committed | asserted within AT2 | pass · pass · pass · skip:gate-freeze | async-action harness | pending (within AT2) |

## G. Effects — RCC §3.6 (5 rows)

| id | scenario | parameters | expected | instrumentation | status |
| --- | --- | --- | --- | --- | --- |
| RCC-EF1.committed-only | route effect probe never logs a pending route during a held navigation; logs it exactly after settle (sources: battery 16, alt-a#10, solid#14) | hold=nav | all pass | effect log | pending |
| RCC-EF1.count-hold | count effect probe never logs the pending +10 during a count hold | hold=gate / sliced (solid) | pass · pass · pass · pass (sliced) | effect log | pending |
| RCC-EF2.coalesce | several writes in one handler produce one effect re-run at the final value | 3 writes, 1 handler | all pass | effect log | pending |
| RCC-EF3 | library-level `effect()` observes newest | — | — | — | doc: core `effect()` is not on the common shim surface; package suites cover (battery case 16) |
| RCC-EF4 | tolerance: sibling effect firing order is implementation-defined; effect-log assertions compare multisets per boundary, never sequences across effects | — | — | — | doc: tolerance constraining effect-log assertions |

## H. Scheduling and priority — RCC §3.7 (6 rows)

| id | scenario | parameters | expected | instrumentation | status |
| --- | --- | --- | --- | --- | --- |
| RCC-SP1.interruptibility | daishi level-3 port: 20 readers × 20ms sync work; 5 transition increments; average click-to-return < 300ms while total naive render ≈ 400ms+ | lattice work 20ms | all pass | lattice knob, in-page timestamps | pending (=DAISHI-5) |
| RCC-SP2 | default vs discrete preemption of a yielded pass | fork-only | — | — | doc: [fork tests 10,22]; browser-indirect: clock keeps committing during sliced transitions (SP1 rows) |
| RCC-SP3.flushsync-hold | flushSync during a held count transition: its frame excludes the pending +10 (all-old), pending intact after, folds at release (sources: R13, battery 2, alt-a#8, alt-b#22/23, solid#9) | hold=gate | pass · pass · pass · skip:gate-freeze | flushSync button, count trace | pending |
| RCC-SP3.flushsync-quiet | flushSync with nothing pending commits synchronously and agrees with useState mirrors (the §9.1 parity form) | quiet | all pass | flushSync button, mirror probe | pending |
| RCC-SP4.lane-join | delivery/mount work rides the causing batch's lane — mount probe joins the pending batch's commit | asserted within RT6 rows | all pass | mount probe log | pending (within RT6) |
| RCC-SP5.over-notify | renders stay bounded and value-correct under an over-notifying burst: lattice reader render counts ≤ commits + slack; every committed value correct (sources: R14, battery 4/5, alt-b#14 shape) | increments burst | all pass | data-render-count attrs | pending |

## I. Sync pricing — RCC §3.8 (2 rows)

| id | scenario | parameters | expected | instrumentation | status |
| --- | --- | --- | --- | --- | --- |
| RCC-PR1.quiet | a pure-urgent session never shows pending state: pending tile stays 'no', no fallback ever, writes commit immediately | urgent-only drive | all pass | pending tile watch | pending |
| RCC-PR2.quiet-then-defer | urgent +5, then held transition +10: committed shows 5 through the hold (quiet writes are already permanent), 15 after release | hold=gate / sliced (solid) | all pass | count trace | pending |

## J. Observation lifecycle — RCC §3.9 (2 rows)

| id | scenario | parameters | expected | instrumentation | status |
| --- | --- | --- | --- | --- | --- |
| RCC-OL1 | first/last-observer union liveness | — | — | — | doc: needs `AtomOptions.effect`-style lifecycle API, not on the common surface; package suites cover (hooks.spec observation-union block, alt-b#25) |
| RCC-OL2.unmounted-silence | after the mount probe unmounts, its render/effect counters freeze while writes keep landing (source: R8) | mount, write, unmount, write | all pass | render counters | pending |

## K. WON'T-PROMISE — RCC §4 (2 runnable + 4 doc rows; WP2/WP6 doc'd above)

| id | scenario | parameters | expected | instrumentation | status |
| --- | --- | --- | --- | --- | --- |
| RCC-WP1.two-roots | a second root over the same atoms converges after writes; per-root self-consistency asserted, cross-root simultaneity deliberately NOT asserted (sources: R10, battery 11, solid#10, alt-b#24) | test-mode second root | all pass | second-root harness | pending |
| RCC-WP4.post-await-ambient | a bare post-await write is ambient/urgent — same fact as RCC-AT2, asserted from the tolerance side: battery never expects it to stay in the transition | within AT2 | pass · pass · pass · skip:gate-freeze | async-action harness | pending (within AT2) |
| RCC-WP3 | deps-keyed derived handles may be recreated; caches die with them | — | — | — | doc: tolerance (useComputed deps rows are package-suite territory) |
| RCC-WP5 | no mid-render write splicing promised | — | — | — | doc: tolerance backing RT2/UM1 rows |

## L. daishi-concurrent-benchmark ports (10 rows)

All ported against the four playground implementations through the shim
surface (its uSES-adapter variants are deliberately not ported). The lattice
is the testkit's port of daishi's counter grid: N readers + per-commit
equality latch + Main-mirror, `syncBlock`-style per-reader work knob,
auto-increment interval. daishi's tests 2/8 had assertions that were
documented no-ops (unawaited evaluate); the ports assert real value equality —
stronger than the original on purpose, noted here for comparability.

| id | scenario | parameters | expected | instrumentation | status |
| --- | --- | --- | --- | --- | --- |
| DAISHI-1 | no tearing finally on update (transition): 5 transition increments over the mounted lattice → all readers settle at exactly 5 | transition increments | all pass | lattice | pending |
| DAISHI-2 | no tearing finally on mount (transition): auto-increment running, lattice mounted via transition → readers agree at settle | auto-inc 50ms | all pass | lattice, auto-inc | pending |
| DAISHI-3 | no tearing temporarily on update: per-commit latch stays clean through the increment burst | transition increments | all pass | lattice latch | pending |
| DAISHI-4 | no tearing temporarily on mount: latch stays clean while mounting under auto-increment | auto-inc 50ms | all pass | lattice latch | pending |
| DAISHI-5 | can interrupt render: avg click-to-return < 300ms with 20ms×20 reader work | lattice work 20ms | all pass | in-page timestamps | pending |
| DAISHI-6 | can branch state (wip): settle at 1; two pending transition +1s; while pending readers still show 1; urgent double → 2 everywhere; settle → 6 | transition +1 button, double button | all pass | lattice, count trace | pending |
| DAISHI-7 | useDeferredValue: no tearing finally on update (urgent increments, deferred readers) | deferred lattice | all pass | deferred lattice | pending |
| DAISHI-8 | useDeferredValue: no tearing finally on mount | deferred lattice, auto-inc | all pass | deferred lattice | pending |
| DAISHI-9 | useDeferredValue: no tearing temporarily on update | deferred lattice | all pass | deferred latch | pending |
| DAISHI-10 | useDeferredValue: no tearing temporarily on mount | deferred lattice, auto-inc | all pass | deferred latch | pending |

## M. Session-finding regression pins (7 rows)

| id | scenario | parameters | expected | instrumentation | status |
| --- | --- | --- | --- | --- | --- |
| FIND-ALTB-WEDGE.filter | value-changing derived write (table filter) during a held navigation wedges alt-b's main thread in an update loop | hold=nav, filter input | pass · pass · **FINDING (test.fail: wedge)** · pass | watchdog + CDP stack capture | pending |
| FIND-ALTB-WEDGE.rows | same wedge class via add-rows during hold | hold=nav, add-rows | pass · pass · **FINDING (test.fail: wedge)** · pass | watchdog + CDP stack | pending |
| FIND-EQUAL-SAFE | equality-cutoff urgent writes (counter, evens toggle) during hold stay safe on every implementation — the wedge's positive boundary | hold=nav | all pass | watchdog (must not fire) | pending |
| FIND-SOLID-HEAP | dirty-heap lockup trio pin: urgent signal write outside any transition with computed-subscribed components keeps the page live (rAF cadence + clock + responsive evaluate) — pins the degraded-memo workaround in the solid-react shim | urgent write, dashboard computeds | all pass (solid-react is the pinned subject) | rAF health, watchdog | pending |
| FIND-THENABLE.gate | foreign (non-Promise) thenable thrown by the write-hold gate: suspense impls hold normally; solid-react freezes all commits until resolve, then recovers with a sync render (per-holdStyle FINDING annotations) | foreign-thenable toggle, hold=gate | pass · pass · pass · **FINDING (freeze-then-recover)** | thenable toggle, clock watch, error allowance | pending |
| FIND-THENABLE.nav | foreign thenable on route resources during a held navigation: suspense impls unaffected; solid-react unaffected too (defer-write never throws it) — divergence boundary recorded | foreign-thenable toggle, hold=nav | all pass | thenable toggle | pending |
| FIND-URGENT-USE | urgent-lane React.use(pendingPromise) retry in a real browser: resolve pings the retry and content appears (positive pin). The repro's wedge is an act()-harness artifact (non-awaited sync act; identical on pristine upstream — SPEC-RESOLUTIONS item 12), unreachable in a browser, so this row pins the working browser behavior instead of expecting failure | test-mode use(P) probe | all pass | use-probe testids | pending |

## N. Remaining source-suite dedup notes (0 rows — accounting)

- cosignals-react `scenarios.spec.tsx`: R1/R2 → RCC-SP5/EF2 rows; R3/R4 →
  RCC-RT3 rows; R5 → RCC-RT5.double-read; R6/R11 → RCC-RT6 rows; R7 →
  RCC-UM2; R8 → RCC-OL2; R9 → StrictMode doc note (§C); R10 → RCC-WP1;
  R12/R12b → RCC-AT1/AT2/AT4; R13 → RCC-SP3; R14 → RCC-SP5; R15 → RCC-RT4.
  battery.spec.tsx generic halves: case 1 → RT3/RT5 rows; case 2 → SP3; cases
  4/5/6 → SP4/SP5; cases 9/10 → RT6; case 11 → WP1; case 12 → CR3; cases
  15/15b → SU1/SU3/SU4; case 16 → EF1/EF2; case 17 → WP6. Engine-internal
  describes (W20, BATCH_NONE, EF2-boundary raw writes, commit-report,
  dev-checks, graph-consumers, trace, hooks' internals) are not portable —
  they drive private bridge surfaces; the package suite is their referee.
- concurrent-solid-react `react-real.test.tsx`: generic tests 1–5, 9–13 →
  rows above; 6–8, 14–18 use package-only APIs (`useIsPending`, `useLatest`,
  `refresh`, `createOptimistic`, async-memo resources) — package-suite
  territory. `suspense-alignment.test.tsx` #19/#20 → the cross-layer
  settlement shape is covered by FIND-URGENT-USE + RCC-SU5; its
  promise-in-signal idiom is package-specific.
- alt-a `real-react.spec.tsx`: #1→SP5, #3→RT5/AT1, #4→RT3, #5→RT6, #6→SU1,
  #7→SU3.interleaved-gates, #8→SP3, #9/#10→EF1, #11/#13→SU5, #14/#15→RT4 +
  RT1.scope-read, #18→StrictMode doc. #2/#12/#16/#17 package-specific
  (`useAtom`, `useReducerAtom`, `api.refresh`, `useCommitted`, lazy init).
- alt-b `react-real.test.tsx`: #1→RT5/AT1, #2→RT3, #3→RT5/6.alt-b-mount-world,
  #5→SU1, #6→SU3.interleaved-gates, #16–19→RT4 + RT1.scope-read, #22/#23→SP3,
  #24→WP1, #27→EF1/EF2. Gate modes: every loose/strictLanes pair in the
  source asserts identical outcomes (gate mode is orthogonal); `configure()`
  is not on the shim surface, so the battery runs alt-b in its default
  (loose) mode and the strictLanes axis stays package-suite territory —
  recorded here as the deliberate dedup decision. #4/#7/#14/#15/#20/#21/#25/#26
  package-specific (`useSignalTransition`, `configure`/`__debug`,
  `useIsPending`, `useLatest`/`useCommitted`, lazy init, `AtomOptions.effect`).

---

## Status ledger

- implemented: rows marked `implemented` have a green scenario in `specs/`
  citing the row id in its title. Everything runnable starts `pending` and
  flips as tranches land.
- doc rows (13): RCC-RT1.frozen-view, RCC-RT2.yield-gap, RCC-UM3,
  RCC-CR2/4/5, RCC-WP6.no-rollback, RCC-SU2, RCC-SU4/WP2, RCC-EF3, RCC-EF4,
  RCC-SP2, RCC-OL1, RCC-WP3, RCC-WP5 — each names its referee.
