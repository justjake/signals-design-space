#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
react="$root/vendor/react"
base=e71a6393e66b0d2add46ba2b2c5db563a0563828

if [[ -n "$(git -C "$react" status --porcelain)" ]]; then
  echo "vendor/react must be clean before building" >&2
  exit 1
fi

head="$(git -C "$react" rev-parse HEAD)"
if [[ "$head" == "$base" ]]; then
  git -C "$react" am "$root/packages/react-signals-royale-sm1/patches/"*.patch
elif ! git -C "$react" merge-base --is-ancestor "$base" HEAD; then
  echo "vendor/react is not based on the pinned React commit" >&2
  exit 1
fi

"$root/fork/build-react.sh"
