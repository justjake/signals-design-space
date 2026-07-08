#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
base=e71a6393e66b0d2add46ba2b2c5db563a0563828
head="$(git -C "$root/vendor/react" rev-parse HEAD)"

if [[ "$head" == "$base" ]]; then
  git -C "$root/vendor/react" am "$root/packages/react-signals-royale-sh2/patches/"*.patch
elif ! git -C "$root/vendor/react" merge-base --is-ancestor "$base" HEAD; then
  echo "vendor/react is not based on $base" >&2
  exit 1
fi

exec "$root/fork/build-react.sh"
