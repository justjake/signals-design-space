#!/usr/bin/env bash
set -euo pipefail

PACKAGE_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$PACKAGE_DIR/../.." && pwd)"
CHECKOUT="${TMPDIR:-/tmp}/react-signals-sh1-$$"

git -C "$ROOT/vendor/react" worktree add --detach "$CHECKOUT" e71a6393e66b0d2add46ba2b2c5db563a0563828
trap 'git -C "$ROOT/vendor/react" worktree remove --force "$CHECKOUT" || true; git -C "$ROOT/vendor/react" worktree prune' EXIT
git -C "$CHECKOUT" am "$PACKAGE_DIR"/patches/*.patch

mkdir "$CHECKOUT/node_modules"
for entry in "$ROOT/vendor/react/node_modules"/* "$ROOT/vendor/react/node_modules"/.[!.]*; do
  name="$(basename "$entry")"
  target="$(readlink "$entry" || true)"
  if [[ "$target" == ../packages/* ]]; then
    ln -s "$target" "$CHECKOUT/node_modules/$name"
  else
    ln -s "$entry" "$CHECKOUT/node_modules/$name"
  fi
done
cd "$CHECKOUT"
ENTRIES="react/index,react/jsx,react/compiler-runtime,react-dom/index,react-dom/client,react-dom/test-utils,scheduler"
if command -v mise >/dev/null 2>&1; then
  NODE_RUNNER=(mise exec "node@$(tr -d 'v[:space:]' <.nvmrc)" -- node)
else
  NODE_RUNNER=(node)
fi
RELEASE_CHANNEL=experimental "${NODE_RUNNER[@]}" \
  ./scripts/rollup/build.js "$ENTRIES" --type=NODE_DEV,NODE_PROD

rm -rf "$ROOT/vendor/react/build/oss-experimental"
mv build/node_modules "$ROOT/vendor/react/build/oss-experimental"
cd "$ROOT/vendor/react/build/oss-experimental"
mkdir -p node_modules
for package in react react-dom scheduler; do
  ln -sfn "../$package" "node_modules/$package"
done

echo "Built: $(node -p "require('./react/package.json').version") ($(git -C "$CHECKOUT" rev-parse --short HEAD))"
