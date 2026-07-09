#!/usr/bin/env bash
set -euo pipefail

package_dir="$(cd "$(dirname "$0")" && pwd)"
repo_dir="$(cd "$package_dir/../.." && pwd)"
react_dir="$repo_dir/vendor/react"
base=e71a6393e66b0d2add46ba2b2c5db563a0563828

git -C "$react_dir" diff --quiet
git -C "$react_dir" diff --cached --quiet

if [[ "$(git -C "$react_dir" rev-parse HEAD)" == "$base" ]]; then
  git -C "$react_dir" am "$package_dir"/patches/*.patch
elif ! git -C "$react_dir" merge-base --is-ancestor "$base" HEAD; then
  echo "vendor/react HEAD is not based on $base" >&2
  exit 1
fi

"$repo_dir/fork/build-react.sh"
