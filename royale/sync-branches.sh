#!/usr/bin/env bash
# Harvest every royale contestant's committed work into the orchestrator repo and
# push it to GitHub, so no tournament work lives only in /tmp. Contestant clones
# have no remotes (isolation); this script pulls from them instead:
#   /tmp/royale-<slug>            royale/* branches -> parent repo -> origin
#   /tmp/royale-<slug>/vendor/react  royale/* branches -> vendor/react -> origin
# Also snapshots uncommitted package work to ~/.claude/royale-snapshots (latest
# per slug), covering the window between an agent's edits and its next commit.
# Prints one line per problem; silent-ish on success (summary line at the end).
set -uo pipefail

MAIN="$(cd "$(dirname "$0")/.." && pwd)"
SNAP_DIR="$HOME/.claude/royale-snapshots"
mkdir -p "$SNAP_DIR"
fails=0; synced=0

for d in /tmp/royale-*/; do
  slug="$(basename "$d" | sed 's/^royale-//')"
  [ -d "$d/.git" ] || continue
  case "$slug" in fm1|fm2|fh1|fh2|fx1|fx2|sh1|sh2|sx1|sx2|sm1|sm2) ;; *) continue;; esac  # contestants only

  if git -C "$MAIN" fetch --quiet "$d" "+refs/heads/royale/*:refs/heads/royale/*" 2>/dev/null; then
    synced=$((synced+1))
  else
    echo "sync FAIL: parent fetch from $slug"; fails=$((fails+1))
  fi

  if [ -d "$d/vendor/react/.git" ] || [ -f "$d/vendor/react/.git" ]; then
    git -C "$MAIN/vendor/react" fetch --quiet "$d/vendor/react" \
      "+refs/heads/royale/*:refs/heads/royale/*" 2>/dev/null \
      || { echo "sync FAIL: react fetch from $slug"; fails=$((fails+1)); }
  fi

  tar -czf "$SNAP_DIR/$slug.tar.gz" -C "$d" \
    --exclude 'node_modules' --exclude '.git' --exclude 'build' \
    packages royale 2>/dev/null \
    || { echo "sync FAIL: snapshot $slug"; fails=$((fails+1)); }
done

push_branches() { # repo-dir
  git -C "$1" for-each-ref --format '%(refname:short)' refs/heads/royale/ \
    | xargs -n 20 git -C "$1" push --quiet --force origin 2>/dev/null
}
push_branches "$MAIN"        || { echo "sync FAIL: parent push to origin"; fails=$((fails+1)); }
push_branches "$MAIN/vendor/react" || { echo "sync FAIL: react push to origin"; fails=$((fails+1)); }

echo "sync ok: $synced clones harvested, $fails failures, $(date '+%H:%M:%S')"
exit 0
