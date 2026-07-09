#!/usr/bin/env bash
# Build the fx2 React fork from a pristine checkout: verify the base, apply
# the patch series, then drive the repository's own build.
#
# Usage: ./build.sh [path-to-react-checkout]
#   default checkout: ../../vendor/react (the workspace layout)
set -euo pipefail

BASE=e71a6393e66b0d2add46ba2b2c5db563a0563828
HERE="$(cd "$(dirname "$0")" && pwd)"
REACT="${1:-$HERE/../../vendor/react}"

cd "$REACT"

if ! git cat-file -e "$BASE^{commit}" 2>/dev/null; then
  echo "error: base commit $BASE not present in $REACT" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "error: $REACT has uncommitted changes; refusing to build" >&2
  exit 1
fi

# Apply the series only when the checkout is AT the pristine base; if HEAD
# already carries the series (the fork branch), build as-is.
if [ "$(git rev-parse HEAD)" = "$BASE" ]; then
  git am "$HERE"/patches/*.patch
fi

if [ ! -d node_modules ]; then
  yarn install --frozen-lockfile
fi

cd "$HERE/../.."
exec ./fork/build-react.sh
