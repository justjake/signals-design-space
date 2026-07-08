# royale/verify — orchestrator scoring kit

Shared, entrant-independent tools for scoring a Signals Royale entry. Nothing
here depends on any entrant's design; every entry is measured through the
same battery, the same LOC script, and its own declared gates.

Contents:

- `battery/` — the shared Real-React gate battery (RULES.md scenarios 1-18),
  written only against the `RoyaleAdapter` surface + DOM + the React modules
  the adapter itself provides. `battery/README.md` covers per-entrant
  provisioning details.
- `calibration/` — the alt-b reference adapter and `RESULTS.md` (calibration
  verdicts, count-loc baselines, and the RULES ambiguity rulings to apply
  consistently across entries).
- `count-loc.mjs` — both LOC metrics.

## Scoring an entry end-to-end

Inputs: the contestant's clone with `packages/signals-royale-<slug>`,
`packages/react-signals-royale-<slug>`, their React checkout on
`royale/<slug>-react`, and their REPORT.md.

1. **Copy the entry in.** Copy the two package directories into this repo's
   `packages/`. Keep their clone available for the fork measurement (or use
   the `patches/` series against a pristine base checkout).

2. **Build their fork.** In their clone: `./fork/build-react.sh` (or apply
   `patches/` to a pristine checkout at base
   `e71a6393e66b0d2add46ba2b2c5db563a0563828`, then build). Artifacts land in
   `<their-clone>/vendor/react/build/oss-experimental/{react,react-dom,scheduler}`.

3. **Provision the battery** (details in `battery/README.md`):
   - Replace `battery/ADAPTER.ts` with a re-export of the entry's
     `royale/adapter.ts` default export.
   - Rewrite `battery/package.json` link targets: `react`, `react-dom`,
     `scheduler` → the entry's fork build; replace the `cosignals-alt-b` dev
     dependency with `link:` entries for the entry's two packages.
   - `pnpm install --ignore-workspace` inside `battery/`.

4. **Run the battery**: `pnpm test` in `battery/`. Pass bar: all scenarios
   green. Scenario 18 alone may fail-as-skip when `serialize`/`initialize`
   are genuinely absent (the thrown message says so); that still scores SSR
   as missing. Any other red scenario fails the correctness gate. Judge
   trace-vocabulary failures (scenario 15's `/write/i`, `/retire|write/i`
   matching) per `calibration/RESULTS.md` ruling 3 before calling them bugs.

5. **Measure LOC**:

   ```sh
   node royale/verify/count-loc.mjs \
     --fork <their-clone>/vendor/react \
     --base e71a6393e66b0d2add46ba2b2c5db563a0563828 \
     --head royale/<slug>-react \
     --lib packages/signals-royale-<slug> \
     --lib packages/react-signals-royale-<slug>
   ```

   Cross-check against the REPORT.md self-count; disagreement is an honesty
   flag, not a rounding error. Baselines: incumbent fork 1510; alt-a 4689;
   alt-b 4909 (see `calibration/RESULTS.md` for the exclusion rulings).

6. **Run the entrant's own suites.** In each of their two packages:
   `pnpm install --ignore-workspace`, `pnpm typecheck`, `pnpm test`. This
   covers their conformance run (must be 179/179), their randomized oracle
   (note the seed count), engine specs, GC/leak audit, and their real-React
   suite against their own fork build.

7. **Run their fork suites.** In their React checkout:
   `yarn test --no-watchman <their protocol suites>`, plus the upstream
   suites adjacent to files their diff touches. All green required.

8. **Record.** Per entry: battery scenario table, LOC pair, their gate table
   with verified numbers, and any adjudications made under the rulings in
   `calibration/RESULTS.md`. Rank by the RULES objectives; any failed
   required gate ranks the entry below all gate-passing entries.

## Re-running the calibration

```sh
cd royale/verify/battery
pnpm install --ignore-workspace
pnpm typecheck && pnpm test   # expected: 24/25, scenario 2b red (alt-b gap)
```

The checked-in `ADAPTER.ts` points at `calibration/alt-b-adapter.ts`;
`calibration/node_modules` is a symlink into `battery/node_modules` (recreate
with `ln -sfn ../battery/node_modules calibration/node_modules` if lost).
