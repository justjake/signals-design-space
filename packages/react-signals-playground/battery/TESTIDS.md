# Test instrumentation contract — v1

The battery drives the app exclusively through the surfaces listed here.
This file is versioned: renaming or removing anything below is a breaking
change to the battery and bumps the version header, in the same commit that
updates the specs. Additions are non-breaking; append them to the tables.

Everything in the "testkit" sections exists only when the page URL carries
`?test=1` (`src/testkit.tsx`); the app sections are always present.

## App testids (src/App.tsx)

| testid | element | meaning |
| --- | --- | --- |
| impl-name | span | shim `name` — page identity |
| impl-tab-`<label>` | a | implementation tab links |
| clock | span | 100ms urgent clock (liveness probe) |
| view-name / view-target | span | committed route / pending target |
| pending | span | `yes`/`no` — app-derived transition-pending flag |
| last-nav-ms | span | last settled navigation duration (effect-written; may lag one commit) |
| renders-committed | span | committed-render tally (imperative tile) |
| consistency / torn-count | span | cross-hook verdict; latched torn tally |
| count | output | shared counter (urgent controls strip) |
| increment / increment-transition | button | +1 urgent / +10 in transition |
| toggle-evens | button | equality-cutoff-safe urgent write |
| filter-input | input | urgent live filter (value-changing derived write) |
| add-rows / remove-rows / row-total | button/span | row-count writes and tally |
| latency-`<label>` | button | nav latency knob: `instant` `250ms` `1s` `3s` `hold` |
| cpu-`<label>` | button | row-work knob: `off` `light` `medium` `heavy` |
| back / forward / addr / release | button/span | mini-browser chrome; release settles held resources |
| view-tab-`<route>` | button | navigate to `dashboard` `table` `detail` |
| view-panel (`data-view`) | div | committed page; `data-view` names it |
| data-epoch | span | committed navigation epoch |
| dash-count / doubled / parity / scaled | output | dashboard deriveds |
| row-visible / seed / row-0 | span/li | table view state |
| reseed-transition / reseed-urgent | button | table reseed writes |
| detail-index / detail-value / detail-prev / detail-next | output/button | detail view |
| timeline-live / timeline-live-ms / timeline-record | div/span | transition timeline bars |
| errors | section | error strip (absent when healthy) |

## Testkit testids (src/testkit.tsx, `?test=1` only)

| testid | element | meaning |
| --- | --- | --- |
| mount-probe-toggle | button | mounts/unmounts the mount probe (urgent state) |
| mount-probe (`data-count`, `data-doubled`, `data-render-count`) | span | RT6 probe; committed values per frame |
| render-write-toggle | button | mounts the UM2 render-phase-write probe |
| render-write-outcome | span | `rejected: <error>` or `wrote-without-error` |
| flushsync-increment | button | `flushSync(() => count+1)` |
| increment-one-transition | button | `startSignalTransition(() => count+1)` (daishi branching) |
| double-urgent | button | urgent `count *= 2` (daishi branching) |
| lattice-show-plain / lattice-show-deferred / lattice-hide | button | mounts the tear lattice via transition |
| lattice (`data-mode`) / lattice-main | div/output | lattice container and main mirror |
| `[data-lat]` spans (`data-render-count`) | span | 20 lattice readers; committed value per reader |
| pair (`data-a`, `data-b`) | span | AT1 dual-atom probe |
| double-read (`data-agree`) | span | R5 same-atom two-hooks probe |
| mirror-write / mirror | button/span | SP3 signal+useState+flushSync parity probe |
| action-sync / action-post / action-rejoin | output | async-action harness observables |
| gate-a / gate-b / gate-action (`data-epoch`) | span | hold-gate states; `gate-*-fallback` shows on cold-mount suspension |
| use-probe / use-probe-fallback | span | urgent React.use probe |
| second-root-count | output | second-root mirror (WP1), mounted under `#second-root` |
| effect-log | ol | effect-timing DOM log (last 50 entries, imperative) |

## window.__store (`?test=1` only)

Typed as `TestStore` in `src/testkit.tsx`; the battery imports the type.
Key surfaces: `read`/`write`/`transitionWrite`/`transitionWriteMany`/
`increment` by label, `transitionScopeProbe`, `holdTransition`/`releaseHold`
(+`B` pair), `beginAsyncAction`/`settleAsyncAction`/`releaseAsyncAction`,
`setForeignThenable`, `setLatticeWork`, `startAutoIncrement`/`stopAutoIncrement`,
`mountSecondRoot`/`unmountSecondRoot`, `armUseProbe`/`settleUseProbe`, and the
logs: `effectLog`, `fetchLog`, `lattice`, `pairTorn`, `mirrorFrames`,
`mountProbeLog`, `splitEffectLog`, `renderCounts`.

Registered signal labels: the App atoms (`count`, `doubled`, `parity`,
`clockMs`, `targetRoute`, `targetEpoch`, `currentRoute`, `routeEpoch`,
`navPending`, `navLatency`, `heldCount`, `rowCount`, `tableSeed`,
`filterText`, `selectedRow`, `markEvens`, `cpuRounds`, `visibleCount`,
`consistency`, `tornCommits`) plus the testkit atoms (`storeOnly`, `pairA`,
`pairB`, `mirrorSig`, `actionSync`, `actionPost`, `actionRejoin`,
`latticeMode`, `renderWriteVictim`, `splitEffectValue`, `splitEffectDep`,
`splitEffectRender`, `splitEffectMounted`).

## Rules the instrumentation keeps

- Verdicts latch via effects (layout effects of the committed frame), so a
  discarded speculative pass can never count as torn.
- `update(fn)` fixtures are pure: implementations replay updaters per
  pending world.
- The lattice work knob is a plain module number, not a signal — moving the
  knob must not itself re-render the readers it prices.
- Log arrays only grow during a page's life; tests read deltas, not resets.
