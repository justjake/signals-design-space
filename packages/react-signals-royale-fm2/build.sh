#!/usr/bin/env bash
# Build the patched React this package targets.
#
# From a clone that already has vendor/react on the fork branch, this just
# wraps fork/build-react.sh. From a pristine base checkout
# (e71a6393e66b0d2add46ba2b2c5db563a0563828), pass --apply-patches to apply
# the patches/ series first.
#
# Artifacts: vendor/react/build/oss-experimental/{react,react-dom,scheduler},
# consumed by this package via link: (rebuilds need no reinstall).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../.."
REACT="$ROOT/vendor/react"

if [[ "${1:-}" == "--apply-patches" ]]; then
	git -C "$REACT" checkout e71a6393e66b0d2add46ba2b2c5db563a0563828
	git -C "$REACT" am "$HERE"/patches/*.patch
fi

exec "$ROOT/fork/build-react.sh"
