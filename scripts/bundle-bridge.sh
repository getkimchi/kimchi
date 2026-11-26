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

SOURCE=package
VERSION=v0.1.0-rc.0
ASSET=kimchi-bridge.tar.gz

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

if [ "$SOURCE" = package ]; then
  BRIDGE_COMMIT="$(node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const spec = JSON.parse(readFileSync("package.json", "utf8")).dependencies["@getkimchi/kimchi-bridge"];
    const commit = spec.split("#").at(-1);
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Bridge dependency is not pinned to a full commit");
    console.log(commit);
  ')"
  BRIDGE_DIR="$(cd node_modules/@getkimchi/kimchi-bridge && pwd -P)"
  KIMCHI_BRIDGE_COMMIT="$BRIDGE_COMMIT" bun "$BRIDGE_DIR/scripts/package.ts" "$VERSION" "$TEMP_DIR"
  SHA256="$(cut -d' ' -f1 "$TEMP_DIR/SHA256SUMS")"
else
  SHA256=3a7c5e4919db5d1aef0307892780ddbf2cb1158fabb298fda761f241c88cd34b
  gh release download "$VERSION" --repo getkimchi/kimchi-bridge --dir "$TEMP_DIR" --pattern "$ASSET"
fi

[ -n "$SHA256" ] || {
  echo "Set or compute the SHA-256 of kimchi-bridge $VERSION in $0." >&2
  exit 1
}
echo "$SHA256  $TEMP_DIR/$ASSET" | shasum -a 256 -c -
mkdir -p dist/share/kimchi/bridge
tar -xzf "$TEMP_DIR/$ASSET" -C dist/share/kimchi/bridge
[ "$(cat dist/share/kimchi/bridge/VERSION)" = "$VERSION" ]
if [ "$SOURCE" = package ]; then
  [ "$(cat dist/share/kimchi/bridge/lib/worker.build)" = "$BRIDGE_COMMIT" ]
fi
