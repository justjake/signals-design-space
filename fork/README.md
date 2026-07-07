# The cosignal React fork (S1 bring-up record)

The fork lives at **`github.com/justjake/react`, branch `cosignal-fork`**,
vendored into this repo as the submodule **`vendor/react`** (see
`.gitmodules`; the submodule tracks that branch). Spec: `spec/cosignal-v1.md`
§4 (fork protocol). Plan: `fork/PLAN.md`.

## Pinned base

- Upstream base: `e71a6393e66b` — facebook/react `main` 2026-07-02, the
  commit published as npm `19.3.0-canary-e71a6393-20260702` /
  `0.0.0-experimental-e71a6393-20260702`, so the pin names an auditable
  upstream artifact.
- The fork branch is that base + the patch series below. Nothing else.

## Patch series on `cosignal-fork` (11 commits)

Ported from the prior-generation fork (`~/src/react-signals-fable/vendor/react`
branch `react-signals-patch`, base `7ce677d40659`) via
`git format-patch 7ce677d406..react-signals-patch` + `git am` — applied
clean, zero drift:

1. `Add external-runtime introspection channel for external state libraries`
2. `Add batch-token registry to the external-runtime channel`
3. `Add unstable_isCurrentWriteDeferred: pure write classification, no minting`
   — LATER REMOVED (consumers read the deferred flag from
   `getCurrentWriteBatch()`'s low bit; render lineage ids, S4, were
   removed at the same time for having no consumer)
4. `Slim the external-runtime surface to the token protocol`
5. `Trim external-runtime surface: drop onCommit and renderLanes`
6. `Batch registry: async-action parking + per-root commit lock-in`
7. `Reconciler-level test suite for the batch-token protocol`
8. `Distinguish committed and pruned batch roots`
9. `Repair pending edges missed by setState-before-store-write ordering`

New in this repo (S1):

10. `Batch tokens are integers: serial<<1 | deferred bit, 0 reserved for none`
    — spec fact 1's token shape; `token & 1` = deferred, `0` = no batch.
11. `Versioned external-runtime handshake: v1 + capability bits, loud on skew`
    — LATER REMOVED (`Remove the versioned handshake` at the top of the
    branch): consumers feature-detect the fork by the protocol entry
    points' existence (`unstable_subscribeToExternalRuntime` etc. simply
    don't exist on stock React); there is no
    `unstable_externalRuntimeProtocol` export, no capability bits, and no
    registration-time version check.

## Fresh-checkout recipe

```sh
git submodule update --init vendor/react   # clones justjake/react @ pinned SHA
cd vendor/react && yarn install --frozen-lockfile && cd ../..
fork/build-react.sh                        # ~13s; build/oss-experimental/{react,react-dom,scheduler}
pnpm install                               # link: overrides resolve to the build
```

- `fork/build-react.sh` drives `scripts/rollup/build.js` directly
  (`RELEASE_CHANNEL=experimental`, NODE_DEV+NODE_PROD, the 7-entry bundle
  set) and renames `build/node_modules` → `build/oss-experimental`. Node
  version comes from `vendor/react/.nvmrc` via mise when available.
- The workspace consumes the artifacts through `pnpm.overrides` in the root
  `package.json` (`react`/`react-dom`/`scheduler` → `link:vendor/react/
  build/oss-experimental/*`). `link:` means a rebuild is picked up without
  re-running `pnpm install`. No current workspace member depends on react;
  the override binds future `libs/`/`packages/` consumers to the fork.

## Tests

- Fork suite (the rebase gate): `pnpm fork:test` from the repo root, or
  `cd vendor/react && yarn test --no-watchman ReactFiberBatchRegistry`.
  The 7 ported protocol tests (adapted to integer tokens); S2–S4 added
  the ExternalRuntimePass/Commit and RunInBatch suites alongside.
- Upstream regression check run for S1 (all green, 96 tests): the
  WorkLoop/RootScheduler-adjacent suites — ReactAsyncActions,
  ReactBatching.internal, ReactFlushSync, ReactIncrementalScheduling,
  ReactIncrementalUpdates, ReactInterleavedUpdates,
  ReactSchedulerIntegration, ReactTransition, ReactUpdatePriority,
  ReactDefaultTransitionIndicator.
- Also green for S1: `yarn linc` (lint changed), `yarn flow dom-node`.

## Rebase procedure (recorded for later)

Fetch upstream main in the submodule, branch, `git rebase --onto` the new
base, re-run the fork suite + `fork/build-react.sh`, push, and update the
submodule pin here. The fork suite re-run per rebase is the mitigation the spec mandates
(§4.3); `fork/PLAN.md` §8.5 has the checklist pointer.

## Error codes

The fork's throws use React's production error-code system. After adding
or editing `Error(...)` messages in the fork: build, then `yarn
extract-errors`, then rebuild (codes 604–605 are the protocol's:
discardAllWip/runInBatch called during render).
