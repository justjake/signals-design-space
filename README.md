# signals-design-space

Wherein we explore integrating signals with React. Many agents used here for research and development.

## Published Packages

| Package                                        | Purpose                                                                                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [`cosignals`](packages/cosignals/)             | The main implementation. It includes the React-free graph, React bindings, async values, SSR state transfer, tracing, and testing APIs.         |
| [`cosignals-arena`](packages/cosignals-arena/) | The same public API and concurrent behavior with nodes and links stored in typed-array records. It is retained as the data-oriented comparison. |
| [`cosignals-devtools`](packages/devtools/)     | A dependency-graph explorer and causal event log for both engines, available inline or as a Chrome DevTools panel.                              |

## Repository map

| Path                                                                      | Purpose                                                                                                                    |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [`harness`](harness/)                                                     | Shared signal conformance, core benchmarks, memory probes, and inlining checks.                                            |
| [`packages/react-signals-playground`](packages/react-signals-playground/) | Browser playground plus Playwright batteries for concurrent behavior and devtools.                                         |
| [`packages/react-seam-bench`](packages/react-seam-bench/)                 | Measures write-to-commit fan-out, urgent latency during transitions, and mount cost.                                       |
| [`packages/dalien-signals`](packages/dalien-signals/)                     | Submodule containing data-oriented alien-signals fork, used for benchmarks.                                                |
| [`libs`](libs/)                                                           | Focused graph-layout and propagation experiments used by the core harness.                                                 |
| [`research`](research/), [`plans`](plans/), [`reviews`](reviews/)         | Design studies, measured experiments, implementation plans, and adversarial reviews.                                       |
| [`spec`](spec/)                                                           | Behavioral specifications: the branching store model, the cosignal v1 API, and the React compliance contract.             |
| [`docs`](docs/)                                                           | Performance benchmark results as charts and CSV data.                                                                     |
| [`royale`](royale/)                                                       | Archived results and notes from the independent implementation tournament. Its old harness and adapters have been removed. |
| [`vendor`](vendor/)                                                       | Reference material for study (some used in benchmarks?).                                                                   |

## Development

```sh
mise trust
mise install
git submodule update --init packages/dalien-signals vendor/alien-signals
pnpm install --frozen-lockfile
```

Run the package checks directly:

```sh
pnpm --dir packages/cosignals typecheck
pnpm --dir packages/cosignals test
pnpm --dir packages/cosignals test:react18

pnpm --dir packages/cosignals-arena typecheck
pnpm --dir packages/cosignals-arena test

pnpm --dir packages/devtools typecheck
pnpm --dir packages/devtools test
```

Run the shared verification surfaces from the repository root:

```sh
FRAMEWORK=cosignals pnpm conformance
pnpm inlining
pnpm play
```

The browser battery uses the Chromium version bundled with Playwright:

```sh
cd packages/react-signals-playground
pnpm exec playwright install chromium
pnpm check
pnpm battery
pnpm devtools-e2e
```

## CI and releases

[`verify.yml`](.github/workflows/verify.yml) runs the main package suites, a
React 19 compatibility matrix, inlining verification, and the Chromium battery.

[`release.yml`](.github/workflows/release.yml) builds npm tarballs for
`cosignals`, `cosignals-arena`, and `cosignals-devtools`, installs those
artifacts into isolated consumers, runs production-build browser tests, and
runs the React 18 package suites before publishing. GitHub Actions are pinned to
release commit SHAs. Its build, verification, and publish jobs invoke the same
release command as local publishing.

Run the same release locally with npm authentication:

```sh
pnpm run publish
```

The command runs package typechecks and tests, packs all three packages,
typechecks an isolated consumer against the tarballs, and publishes those
tarballs in dependency order. It chooses the versions and npm tags with the
same policy as CI and skips versions already on npm. The release plan and
tarballs are written under the ignored `build/` directory.

Use `--dry-run` to invoke `pnpm publish --dry-run`. Use `--full` to add the
Playwright battery and production devtools tests. A live publish requires a
clean worktree unless `--allow-dirty` is passed.
