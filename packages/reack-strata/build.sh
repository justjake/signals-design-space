#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKOUT="${1:-$HERE/.react}"
BASE=6117d7cca4906492c51fe6a03381e35adfd86e7d

if [[ ! -d "$CHECKOUT/.git" ]]; then
	git clone https://github.com/facebook/react.git "$CHECKOUT"
fi
if ! git -C "$CHECKOUT" diff --quiet || ! git -C "$CHECKOUT" diff --cached --quiet; then
	echo "React checkout has source changes: $CHECKOUT" >&2
	exit 1
fi

git -C "$CHECKOUT" checkout --detach "$BASE"
git -C "$CHECKOUT" am "$HERE"/patches/*.patch

if [[ ! -d "$CHECKOUT/node_modules" ]]; then
	yarn --cwd "$CHECKOUT" install --frozen-lockfile
fi

(
	cd "$CHECKOUT"
	npm_config_cache="${npm_config_cache:-/tmp/strata-react-npm-cache}" \
		RELEASE_CHANNEL=stable node scripts/rollup/build.js \
		react/index,react/jsx,react-dom/index,react-dom/client,react-dom/server,react-dom-server.node,react-dom-server-legacy.node,scheduler \
		--type=NODE_DEV,NODE_PROD
)

ln -sfn "$CHECKOUT/build/node_modules" "$HERE/react-build"
echo "Built React 19.2.7 with the Strata patch at $HERE/react-build"
