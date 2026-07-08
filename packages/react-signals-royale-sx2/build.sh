#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REACT="$ROOT/vendor/react"
BASE=e71a6393e66b0d2add46ba2b2c5db563a0563828

if [[ "$(git -C "$REACT" rev-parse HEAD)" == "$BASE" ]]; then
  git -C "$REACT" am "$ROOT/packages/react-signals-royale-sx2/patches/"*.patch
elif ! git -C "$REACT" merge-base --is-ancestor "$BASE" HEAD; then
  echo "vendor/react is not based on $BASE" >&2
  exit 1
fi

"$ROOT/fork/build-react.sh"
