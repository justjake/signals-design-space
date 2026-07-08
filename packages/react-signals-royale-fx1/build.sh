#!/usr/bin/env bash
# Build the React fork this package binds to.
#
# From a pristine React checkout at the pinned base
# (e71a6393e66b0d2add46ba2b2c5db563a0563828), apply the patch series in
# ./patches, then build the 7-entry bundle set. When run inside this
# repository (vendor/react already carries the series on its branch), the
# apply step is skipped and this simply wraps fork/build-react.sh.
#
# Usage:
#   ./build.sh                 # build vendor/react in place
#   REACT_CHECKOUT=/path ./build.sh   # provision a pristine checkout first
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
CHECKOUT="${REACT_CHECKOUT:-$REPO_ROOT/vendor/react}"
BASE=e71a6393e66b0d2add46ba2b2c5db563a0563828

if ! git -C "$CHECKOUT" merge-base --is-ancestor "$BASE" HEAD 2>/dev/null; then
  echo "error: $CHECKOUT is not a React checkout containing the pinned base $BASE" >&2
  exit 1
fi

# Apply the patch series when the checkout sits at the pristine base.
if [ "$(git -C "$CHECKOUT" rev-parse HEAD)" = "$BASE" ]; then
  echo "Applying patch series from $HERE/patches"
  git -C "$CHECKOUT" am "$HERE"/patches/*.patch
fi

if [ ! -d "$CHECKOUT/node_modules" ]; then
  (cd "$CHECKOUT" && yarn install --frozen-lockfile)
fi

exec "$REPO_ROOT/fork/build-react.sh"
