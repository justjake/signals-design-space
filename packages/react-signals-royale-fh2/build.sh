#!/usr/bin/env bash
# Builds the external-signals React fork these bindings require.
#
# From a provisioned clone (vendor/react already on the fork branch), this
# just drives the repo build. From a pristine checkout at the pinned base
# (e71a6393e66b0d2add46ba2b2c5db563a0563828), apply patches/ first:
#
#   git -C vendor/react checkout e71a6393e66b0d2add46ba2b2c5db563a0563828
#   git -C vendor/react am packages/react-signals-royale-fh2/patches/*.patch
#
# Artifacts land in vendor/react/build/oss-experimental/{react,react-dom,scheduler},
# consumed by this package through link: dependencies (rebuilds need no reinstall).
set -euo pipefail
cd "$(dirname "$0")/../.."

if ! git -C vendor/react log --oneline e71a6393e6..HEAD -- packages/react-reconciler/src/ReactFiberExternalSignals.js | grep -q .; then
  echo "vendor/react lacks the external-signals patches; applying patches/ ..."
  git -C vendor/react am "$(pwd)/packages/react-signals-royale-fh2/patches/"*.patch
fi

exec ./fork/build-react.sh
