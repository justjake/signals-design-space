# Round <NN>: <slug>

> Historical naming: `signals-royale-fx2` is now named `cosignals`.

## Before editing

- Base SHA:
- Candidate chosen by implementer:
- Primary benchmark command:
- Fixed repetitions:
- Raw baseline output:
- Causal performance hypothesis:
- Measurement integrity boundary:
- TypeScript compiler host Node path/version and binary hash:
- Sampler Node path/version and binary hash, reported from `process.execPath`:
- Package-local TypeScript version, launcher hash, and resolved compiler binary
  hash:
- Emit-config/effective-config/probe hashes:
- Baseline source/runtime manifests:
- Baseline artifact directory and full-manifest hash:

Exact preparation/run commands (replace `NN-SLUG` and `REVISION`):

```sh
set -eu
round=/tmp/fx2-simplify-loop/NN-SLUG
revision=REVISION
probe="$round/probe.mts"
package="$PWD/packages/signals-royale-fx2"
compiler_node=$(realpath "$(command -v node)")
sampler_node="$compiler_node"
tsc=$(realpath "$package/node_modules/typescript/bin/tsc")
emit=$(mktemp -d "$round/emit-$revision.XXXXXX")
emitted_probe="$emit${probe%.mts}.mjs"

NODE_OPTIONS= "$compiler_node" "$tsc" -p "$round/tsconfig.emit.json" --outDir "$emit" --showConfig > "$round/config-$revision.json"
NODE_OPTIONS= "$compiler_node" "$tsc" -p "$round/tsconfig.emit.json" --outDir "$emit" --pretty false --listEmittedFiles > "$round/emitted-$revision.txt"
cp "$package/package.json" "$emit/package.json"
mkdir "$emit/node_modules"
for dependency in react react-dom scheduler; do
	cp -RL "$(realpath "$package/node_modules/$dependency")" "$emit/node_modules/$dependency"
done
test -f "$emitted_probe"
(
	cd "$emit"
	find node_modules -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256
) > "$round/runtime-$revision.sha256"
(
	cd "$emit"
	find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256
) > "$round/emit-$revision.before.sha256"
find "$emit" -type f -exec chmod a-w {} +
find "$emit" -type d -exec chmod a-w {} +
NODE_ENV=production NODE_OPTIONS= "$sampler_node" -e 'console.log(JSON.stringify({execPath: process.execPath, version: process.version}))' > "$round/sampler-$revision.json"
reported_sampler=$(NODE_OPTIONS= "$sampler_node" -p 'process.execPath')
test "$(realpath "$reported_sampler")" = "$(realpath "$sampler_node")"
shasum -a 256 "$reported_sampler" > "$round/sampler-binary-$revision.sha256"
NODE_ENV=production NODE_OPTIONS= "$sampler_node" "$emitted_probe"
(
	cd "$emit"
	find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256
) > "$round/emit-$revision.after.sha256"
cmp "$round/emit-$revision.before.sha256" "$round/emit-$revision.after.sha256"
```

The per-round config extends the package's `tsconfig.perf.json`, compiles live
`src` plus the frozen `.mts` probe in one NodeNext program, and rewrites `.ts`
imports. Compare the runtime manifests between baseline and candidate.
Hash the exact path reported in `sampler-$revision.json`; do not infer the
sampler from the controller shell's `command -v node`. The controller must use
the same sampler binary for reproduction.

The sections below may evolve during implementation but must be complete before
handoff.

## Opportunity

Why this is the highest-leverage current comprehension and execution cost,
with source/runtime evidence.

## Current model

- Canonical state and owner:
- Duplicate representations/translations:
- Representative operation, step by step:
- Hot-path allocations, calls, branches, or indirections:

## Chosen change

- Concept/representation/operation expected to disappear:
- Ownership before -> after:
- Code/control flow expected to disappear:
- Things that must remain separate, and why:
- New state or abstraction, if any, and why deletion alone cannot work:

## Alternatives considered

Every materially different approach considered, with its tradeoff and why the
chosen approach is stronger. This is the implementer's decision, not a request
for controller approval.

## Semantic boundary

- Existing focused tests:
- Tests to add/change:
- Observable behavior that must remain identical:
- Material edge cases and how the existing contract resolves them:

## Integrity checks

Why the selected benchmark exercises the changed path and why no observable
work, timing boundary, configuration, or input is changing.

## Candidate emission

- Candidate source/runtime manifests:
- Candidate artifact directory and full-manifest hash:
- Post-sample manifest comparison:

## Abandon rule

What evidence should make the implementer replace or abandon this approach
instead of adding compensating complexity.
