#!/usr/bin/env bash
set -euo pipefail

PACKAGE_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$PACKAGE_DIR/../.." && pwd)"
CHECKOUT="${TMPDIR:-/tmp}/react-signals-sh1-$$"

git -C "$ROOT/vendor/react" worktree add --detach "$CHECKOUT" e71a6393e66b0d2add46ba2b2c5db563a0563828
trap 'git -C "$ROOT/vendor/react" worktree remove --force "$CHECKOUT"' EXIT
git -C "$CHECKOUT" am "$PACKAGE_DIR"/patches/*.patch

"$ROOT/fork/build-react.sh"
