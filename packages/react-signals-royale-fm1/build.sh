#!/usr/bin/env bash
# Build the signal-seam React fork this package binds to.
#
# From a pristine checkout of facebook/react at the pinned base
# (e71a6393e66b0d2add46ba2b2c5db563a0563828), apply the patch series in
# patches/ and build with the repo's fork build script. When the checkout in
# vendor/react already carries the series (the normal case in this repo),
# this just rebuilds.
set -euo pipefail

cd "$(dirname "$0")/../.."
REACT=vendor/react
BASE=e71a6393e66b0d2add46ba2b2c5db563a0563828
PATCHES="packages/react-signals-royale-fm1/patches"

if ! git -C "$REACT" merge-base --is-ancestor "$BASE" HEAD 2>/dev/null; then
	echo "vendor/react is not on the pinned base $BASE" >&2
	exit 1
fi

if [ "$(git -C "$REACT" rev-parse HEAD)" = "$BASE" ]; then
	echo "Applying patch series onto the pinned base..."
	git -C "$REACT" am "$(pwd)/$PATCHES"/*.patch
fi

exec fork/build-react.sh
