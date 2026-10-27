#!/usr/bin/env bash
#
# Put the work-reporting plugins for official Claude Code and Codex
# (getkimchi/kimchi-adapters) into dist/share/kimchi/adapters, where
# install.sh and the updater install them from.
#
# Usage: scripts/bundle-adapters.sh darwin|linux amd64|arm64
# Needs GH_TOKEN with read access to getkimchi/kimchi-adapters releases.

set -euo pipefail

VERSION=v0.1.0-rc.6
ASSET="kimchi-adapters_${1}_${2}.tar.gz"

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

gh release download "$VERSION" --repo getkimchi/kimchi-adapters --dir "$TEMP_DIR" --pattern "$ASSET" --pattern SHA256SUMS
(cd "$TEMP_DIR" && awk -v asset="$ASSET" '$2 == asset' SHA256SUMS | shasum -a 256 -c -)
mkdir -p dist/share/kimchi/adapters
tar -xzf "$TEMP_DIR/$ASSET" -C dist/share/kimchi/adapters
[ "$(cat dist/share/kimchi/adapters/VERSION)" = "$VERSION" ]
