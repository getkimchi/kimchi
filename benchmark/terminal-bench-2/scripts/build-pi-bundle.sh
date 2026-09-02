#!/usr/bin/env bash
# Stage a self-contained pi bundle into .cache/pi-bundle/: a linux-x64 node
# runtime, the pi CLI, and pi-kimchi-provider with real node_modules.
#
# PiKimchi (and so PiWorkflowAgent) uploads it into task containers when
# present, making agent install need no network — required for tasks with
# allow_internet=false. Without a bundle, every run falls back to the in-container
# npm install.
#
# The kimchi-workflows extension is NOT bundled: it is resolved on the host from
# the run's own extension= spec, so baking a copy here would override what a
# run says it is testing.
#
#   ./scripts/build-pi-bundle.sh
#   PI_VERSION=0.84.1 ./scripts/build-pi-bundle.sh
#
# Env: PI_VERSION (default latest), NODE_VERSION, PI_KIMCHI_PROVIDER_DIR.
set -euo pipefail

BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE="$BENCH_DIR/.cache/pi-bundle"
NODE_VERSION="${NODE_VERSION:-22.21.1}"
PI_VERSION="${PI_VERSION:-latest}"

# Where pi-kimchi-provider's sources are. Same default as the adapter's own
# lookup (src/kimchi_agent/extensions/pi-kimchi-provider), with the sibling
# checkout as a fallback for local development.
PROVIDER_DIR="${PI_KIMCHI_PROVIDER_DIR:-}"
if [ -z "$PROVIDER_DIR" ]; then
    for candidate in \
        "$BENCH_DIR/src/kimchi_agent/extensions/pi-kimchi-provider" \
        "$BENCH_DIR/../../../pi-kimchi-provider"; do
        if [ -f "$candidate/package.json" ]; then
            PROVIDER_DIR="$(cd "$candidate" && pwd)"
            break
        fi
    done
fi
if [ ! -f "${PROVIDER_DIR:-}/package.json" ]; then
    echo "error: pi-kimchi-provider not found. Check it out beside this repo, or set" >&2
    echo "       PI_KIMCHI_PROVIDER_DIR=<path>. (The adapter can clone it with GITHUB_TOKEN" >&2
    echo "       at install time, but a bundle has to be built from a real checkout.)" >&2
    exit 1
fi

mkdir -p "$BUNDLE"

# Official linux-x64 node is glibc-linked. Alpine/musl images cannot execute it;
# the adapter probes and falls back to the network install when it fails.
if [ ! -x "$BUNDLE/node/bin/node" ]; then
    echo "==> downloading node v$NODE_VERSION"
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" | tar -xJ -C "$BUNDLE"
    rm -rf "$BUNDLE/node"
    mv "$BUNDLE/node-v$NODE_VERSION-linux-x64" "$BUNDLE/node"
fi
export PATH="$BUNDLE/node/bin:$PATH"

echo "==> staging pi ($PI_VERSION)"
rm -rf "$BUNDLE/pi"
mkdir -p "$BUNDLE/pi"
npm install --global --prefix "$BUNDLE/pi" --no-audit --no-fund "@earendil-works/pi-coding-agent@$PI_VERSION"

echo "==> staging pi-kimchi-provider from $PROVIDER_DIR"
DEST="$BUNDLE/extensions/pi-kimchi-provider"
rm -rf "$DEST"
mkdir -p "$DEST"
cp "$PROVIDER_DIR/package.json" "$DEST/"
cp -r "$PROVIDER_DIR/src" "$DEST/src"
# npm, not pnpm: the staged node_modules must be real directories, not symlinks
# into a pnpm store that does not exist inside the container.
# --legacy-peer-deps stops npm from pulling a second pi-coding-agent copy for the
# peer ranges; pi virtualizes those imports with its own bundle.
(cd "$DEST" && npm install --omit=dev --legacy-peer-deps --no-audit --no-fund)

echo "==> bundle ready: $BUNDLE ($(du -sh "$BUNDLE" | cut -f1))"
