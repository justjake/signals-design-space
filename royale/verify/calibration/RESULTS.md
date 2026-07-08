# Battery calibration against cosignals-alt-b — results

Run: `royale/verify/battery` with `ADAPTER.ts` → `calibration/alt-b-adapter.ts`,
react/react-dom/scheduler linked to `vendor/react/build/oss-experimental/*`
(the incumbent fork build, branch `cosignal-fork`). vitest 4, jsdom, pool=forks.

Headline: **24/25 tests green, typecheck green, stable across 3 consecutive
runs** (including the wall-clock time-slicing scenario, ~220ms). The one red
test is a genuine incumbent gap, left failing by design.

## Per-scenario verdicts

| # | Scenario | Verdict |
|---|---|---|
| 1 | urgent write one commit; batch one commit | green |
| 2a | transition invisibility + read family (read/committed/latest) | green |
| 2b | useIsPending true during a pending transition write | **incumbent gap** (see below) |
| 3 | urgent-during-transition; (1+1)×2 = 4 replay | green |
| 4 | sibling readers never tear | green |
| 5 | mount mid-transition (committed value, joins commit, suspending variant) | green |
| 6 | flushSync excludes pending deferred work | green |
| 7 | transition spanning two roots; per-root committed views | green |
| 8 | StrictMode nets one observation; subscription survives | green |
| 9 | unmount: no deliveries; observation released | green |
| 10 | write-during-render fails loudly | green |
| 11 | Suspense first-load fetch-count-1; refresh stale+isPending; settlement-in-transition | green |
| 12 | time slicing: urgent flushSync lands mid-transition-render | green |
| 13 | branch state 1 → 2 → 6, never 3/4 | green |
| 14 | lifetime effects (React + engine subscriber union, flap coalescing, ctx.set) | green |
| 15 | causality trace explains urgent + post-retirement re-renders | green (**battery-fixed**, see below) |
| 16 | DOM mutation window vs MutationObserver | green |
| 17 | lazy initializers (first-read; set-before-read) | green |
| 18 | SSR serialize → install → zero-corrective first render | green |

## Battery fixes made during calibration

- **Scenario 15 (battery bug, fixed in the alt-b adapter mapping):** the first
  `whyLastDelivery` mapping picked the newest broadcast record for the node,
  including cutoff-SUPPRESSED broadcasts (alt-b re-decides per world at batch
  retirement without firing the watcher). A suppressed decision is not a
  delivery; the mapping now selects the newest broadcast that actually fired
  the watcher. After the fix the urgent chain terminates at the urgent
  `atom-write` and the post-retirement chain passes through `batch-retired`,
  exactly what the scenario demands.
- vitest 4 transforms with oxc, not esbuild: the JSX-to-`React.createElement`
  pragma had to move to the `oxc.jsx` config block. (Battery bug; fixed.)

## Incumbent gap (left failing)

- **Scenario 2b — `useIsPending(x)` during a plain transition write.** alt-b's
  `isPending` is async-shaped: it is true only while a signal holds a pending
  thenable with stale data behind it (it flips for `refresh`/suspense, which
  scenario 11 proves green). A plain transition-written atom is never
  "pending" to alt-b, so the probe stays false while the transition is held.
  RULES' scenario list explicitly requires the flip ("useIsPending true
  meanwhile"), so the test asserts it and stays red against alt-b. The
  invisibility half of scenario 2 lives in its own test (2a) so this gap
  cannot mask core coverage. Entrants must implement the transition-aware
  reading; alt-b would need a probe over "any newer intent exists" rather
  than "a thenable is in flight" to pass.

## count-loc calibration (actual outputs)

- Fork metric — `node royale/verify/count-loc.mjs --fork vendor/react --base
  e71a6393e66b0d2add46ba2b2c5db563a0563828 --head cosignal-fork` →
  **forkLoc = 1510** (matches the published incumbent number exactly).
  Largest rows: ReactFiberBatchRegistry.js 564, ReactExternalRuntime.js 334,
  ReactFiberWorkLoop.js 291, ReactFiberExternalRuntime.js 204.
- Library metric — `--lib packages/cosignals-alt-a` → **4689** (stated ≈4700);
  `--lib packages/cosignals-alt-b` → **4909** (stated ≈5000).
  Calibration ruling: `src/debug/` and `*.debug.ts` count as excluded tooling
  (both incumbents' stated numbers match only with that exclusion; with debug
  included they measure 4874/5130).

## RULES.md ambiguities resolved here (adjudicate consistently at scoring)

1. **Replay arithmetic prose vs scenario list.** The "Required features" prose
   example (transition ×2, urgent +1, "shows 4") is inconsistent with React
   updater-queue insertion-order replay, which yields 3 for that schedule.
   The scenario list's own "(1+1)×2 = 4" (transition +1 first, urgent ×2
   second) IS insertion-order replay, and it is what the incumbents implement.
   The battery pins the scenario-list form (and scenario 13's 1→2→6 variant).
   An entry that implemented the prose example literally will fail scenario 3
   — that is a correct failure under this ruling.
2. **isPending on plain transition writes** (scenario 2 vs the read-family
   definition "true while newer data loads behind stale"). The battery follows
   the scenario list: the flip is required for transition writes too. Kept as
   a separate test so the two halves of scenario 2 are graded independently.
3. **Causality event vocabulary is unpinned.** The battery asserts the
   formatted chains mention something matching `/write/i` (urgent chain) and
   `/retire|write/i` (post-retirement chain), plus structural validity of
   `events()` (every `cause` names an earlier, existing event). Entrants whose
   tracers use other words for writes/retirement will fail the regex — flag
   for manual adjudication rather than silently renaming.
4. **LOC exclusions**: "tests, adapters, tools, docs" extended to `debug`
   directories and `.debug.ts(x)` files (see calibration above). Required
   feature code moved under an excluded segment is a scoring dodge; recount
   manually if review finds it.
5. **Scenario 8 "nets one engine subscription"** is not observable through the
   RoyaleAdapter surface; the battery uses the union-of-kinds lifetime
   observation (exactly one `observe`) plus write delivery after the
   StrictMode remount as the observable proxy.
6. **`serialize(atoms)` keys**: the adapter takes an array, so the battery
   serializes with positional keys; "app-supplied keys" remain the entrant's
   own API concern, mapped positionally by their adapter.
7. **`RoyaleHandle.errors`** has no defined producer in RULES; the battery
   treats it as the adapter's internal error channel and asserts it is empty
   after every scenario (snapshot taken before `resetForTest`).
8. **`committed(x, container)`** container identity: the battery passes the
   element handed to `createRoot` and requires per-root views keyed by it.

## alt-b adapter mapping notes (gaps documented in-code too)

- `trace()`: alt-b's PackedTracer has no root-commit / effect-run / component
  render kinds; deliveries surface as `broadcast` (watcher fire) records.
  Suspense settlement appears as the settlement write's log events. Fully
  quiescent DIRECT-mode writes are untraced by design; every traced scenario
  runs with a live batch, where all writes are LOGGED and traced.
- `onDomMutation` re-emits the fork's before/after-mutation edges; container
  is `root.containerInfo` (the createRoot element).
- `resetForTest()` = dispose bindings/fork registration → scrub React's batch
  registry → engine reset; `register()` re-creates on demand (idempotent).
- Provisioning quirk: `calibration/node_modules` is a symlink to
  `../battery/node_modules` so the adapter (which lives outside the battery
  package root) resolves react/cosignals-alt-b through the battery's install.
