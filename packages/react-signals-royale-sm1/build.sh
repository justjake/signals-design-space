#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
git -C "$root/vendor/react" diff --quiet
git -C "$root/vendor/react" diff --cached --quiet
"$root/fork/build-react.sh"
