#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASE=e71a6393e66b0d2add46ba2b2c5db563a0563828
CHECKOUT="$(mktemp -d "${TMPDIR:-/tmp}/react-signals-sx1.XXXXXX")"
trap 'git -C "$ROOT/vendor/react" worktree remove --force "$CHECKOUT" >/dev/null 2>&1 || true' EXIT

git -C "$ROOT/vendor/react" worktree add --detach "$CHECKOUT" "$BASE"
git -C "$CHECKOUT" am "$ROOT/packages/react-signals-royale-sx1/patches/"*.patch
mkdir "$CHECKOUT/node_modules"
while IFS= read -r -d '' dependency; do
	name="$(basename "$dependency")"
	if [[ -L "$dependency" && "$(readlink "$dependency")" == ../packages/* ]]; then
		ln -s "$(readlink "$dependency")" "$CHECKOUT/node_modules/$name"
	else
		ln -s "$dependency" "$CHECKOUT/node_modules/$name"
	fi
done < <(find "$ROOT/vendor/react/node_modules" -mindepth 1 -maxdepth 1 -print0)

ENTRIES="react/index,react/jsx,react/compiler-runtime,react-dom/index,react-dom/client,react-dom/test-utils,scheduler"
if command -v mise >/dev/null 2>&1; then
	NODE_RUNNER=(mise exec "node@$(tr -d 'v[:space:]' <"$CHECKOUT/.nvmrc")" -- node)
else
	NODE_RUNNER=(node)
fi

cd "$CHECKOUT"
RELEASE_CHANNEL=experimental "${NODE_RUNNER[@]}" \
	./scripts/rollup/build.js "$ENTRIES" --type=NODE_DEV,NODE_PROD

rm -rf "$ROOT/vendor/react/build/oss-experimental"
mv "$CHECKOUT/build/node_modules" "$ROOT/vendor/react/build/oss-experimental"
cd "$ROOT/vendor/react/build/oss-experimental"
mkdir -p node_modules
for package in react react-dom scheduler; do
	ln -sfn "../$package" "node_modules/$package"
done

echo "Built pristine React patch series at $(git -C "$CHECKOUT" rev-parse --short HEAD)"
