# battery — browser-real verification of five concurrent-signals implementations

A Playwright battery that drives the playground app in a real Chromium
against every implementation entry and asserts the React compliance
contract's browser-observable clauses, the ported source-suite scenarios, and
the session-finding regression pins. `MANIFEST.md` is the scenario contract
(ids, per-implementation expectations, statuses); `TESTIDS.md` is the
instrumentation contract.

## Running

```sh
cd packages/react-signals-playground
npx playwright install chromium   # once per machine: the pinned bundled browser
pnpm battery                      # full battery: builds, previews, runs all five projects
pnpm battery --project=alt-b      # one implementation
pnpm battery -g RCC-RT4           # one manifest row family
```

- The browser is the **bundled Chromium** pinned by the exact
  `@playwright/test` version in `package.json` — never `channel: 'chrome'` —
  so local runs and CI drive the identical engine.
- Six projects: one per implementation plus **react-control**, which runs
  only `k1-host-control.spec.ts` against the vanilla-React `/control/` page
  (same patched React build, no signals engine). Behavior shared by all five
  implementations is attributed against the control before blaming an engine.
- The web server is `vite build && vite preview` on port 4599: every run
  verifies a fresh production build, never a checked-in `dist/`. Locally a
  server already on that port is reused (rebuild yourself after app edits);
  in CI it is always rebuilt.
- `workers: 1`, no retries: scenarios measure timing and some deliberately
  wedge a page's main thread, so nothing may share the machine clock with
  them. Wedge-prone specs live in `z9-wedge.spec.ts`, run last, and guard
  every blocking step with a watchdog that captures the spinning stack over
  CDP before failing.

## Layout

- `playwright.config.ts` — projects (one per implementation), web server,
  determinism decisions.
- `entries.ts` — the battery's implementation table, derived from
  `src/shims/implementations.ts`; holdStyle declared here and verified
  against the page at runtime by the smoke spec.
- `fixtures.ts` — `entry` option and the console/pageerror budget (zero
  unexpected errors per test; findings call `errors.allow` beside the
  scenario they excuse).
- `helpers.ts` — promoted lab patterns: MutationObserver transient capture,
  instant-of-commit snapshots, one-commit-boundary-tolerant settles, wedge
  watchdogs with CDP stack capture.
- `expectations.ts` — per-implementation expected behavior keyed by manifest
  row id: pass / FINDING / variant / skip.
- `specs/*.spec.ts` — scenarios; titles cite manifest row ids.

## Reading a report

Lines read `RCC-RT3.hold [alt-b]`. Failures marked FINDING are asserted
divergences (`test.fail` — a wedge or documented quirk the manifest expects);
if one starts passing, the run goes red so the manifest gets updated. Skips
carry the ruling as the reason (`RCC-RT4-newest [alt-b]` skips with "ruled
drafts-hidden" — the other RT4 variant is the one alt-b must pass).
