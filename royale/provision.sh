#!/usr/bin/env bash
# Provision one signals-royale contestant environment: a fully isolated local
# clone of this repo (branch royale/<slug>) with vendor/react cloned at the
# pinned upstream base on branch royale/<slug>-react and node_modules populated.
# Contestants never touch the orchestrator repo: all git writes land in their
# own clone (local clones hardlink immutable objects; new objects stay local).
#
# Usage: royale/provision.sh <slug> [dest-root]   # default dest-root /tmp
set -euo pipefail

SLUG="$1"
DEST_ROOT="${2:-/tmp}"
MAIN="$(cd "$(dirname "$0")/.." && pwd)"
REACT_BASE=e71a6393e66b0d2add46ba2b2c5db563a0563828
DEST="$DEST_ROOT/royale-$SLUG"

[ -e "$DEST" ] && { echo "already exists: $DEST" >&2; exit 1; }

git clone --quiet --local --no-tags "$MAIN" "$DEST"
git -C "$DEST" checkout --quiet -b "royale/$SLUG"
git -C "$DEST" remote remove origin   # no pushing anywhere, ever
command -v mise >/dev/null && mise trust "$DEST/mise.toml" >/dev/null 2>&1 || true

git clone --quiet --local --no-tags "$MAIN/vendor/react" "$DEST/vendor/react"
git -C "$DEST/vendor/react" checkout --quiet -b "royale/$SLUG-react" "$REACT_BASE"
git -C "$DEST/vendor/react" remote remove origin
cp -Rc "$MAIN/vendor/react/node_modules" "$DEST/vendor/react/node_modules"

echo "provisioned $DEST (react @ $(git -C "$DEST/vendor/react" rev-parse --short HEAD))"
