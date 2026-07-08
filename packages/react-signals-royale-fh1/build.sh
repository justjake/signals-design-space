#!/usr/bin/env bash
# Build the signal-seam React fork this package binds to.
#
# From a pristine checkout: apply patches/ onto the pinned base
# e71a6393e66b0d2add46ba2b2c5db563a0563828, then build. When vendor/react is
# already on the fork branch (the normal workspace state), this just builds.
set -euo pipefail
cd "$(dirname "$0")/../.."

BASE=e71a6393e66b0d2add46ba2b2c5db563a0563828
if [ "$(git -C vendor/react rev-parse HEAD)" = "$BASE" ]; then
  git -C vendor/react am packages/react-signals-royale-fh1/patches/*.patch
fi
exec ./fork/build-react.sh
