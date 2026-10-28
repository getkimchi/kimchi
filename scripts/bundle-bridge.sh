#!/usr/bin/env bash
#
# Put the work-reporting plugins for official Claude Code and Codex
# (getkimchi/kimchi-bridge) into dist/share/kimchi/bridge, where
# install.sh and the updater install them from. The package is the same
# on every platform: its code runs on this binary's runtime.
#
# Usage: scripts/bundle-bridge.sh
# Needs GH_TOKEN for gh; getkimchi/kimchi-bridge is public, so the job token reads its releases.

set -euo pipefail

# Bump both together. The pinned SHA-256 makes a re-uploaded release asset fail the build.
VERSION=v0.1.0-rc.11
SHA256=79008efcc20f46196902eb9ac95f41ef2c5468427636b2c66ae1ed8f525ce43d
ASSET=kimchi-bridge.tar.gz

[ -n "$SHA256" ] || { echo "Set the SHA-256 of kimchi-bridge $VERSION in $0." >&2; exit 1; }

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

gh release download "$VERSION" --repo getkimchi/kimchi-bridge --dir "$TEMP_DIR" --pattern "$ASSET"
echo "$SHA256  $TEMP_DIR/$ASSET" | shasum -a 256 -c -
mkdir -p dist/share/kimchi/bridge
tar -xzf "$TEMP_DIR/$ASSET" -C dist/share/kimchi/bridge
[ "$(cat dist/share/kimchi/bridge/VERSION)" = "$VERSION" ]
