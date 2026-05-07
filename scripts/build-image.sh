#!/usr/bin/env bash
# Build the kimchi container image for autonomous mode.
#
# Usage:
#   ./scripts/build-image.sh                              # builds for current arch only
#   ./scripts/build-image.sh --multi                      # multi-arch via buildx (linux/amd64,linux/arm64)
#   IMAGE=kimchi:dev ./scripts/build-image.sh             # custom tag
#   PUSH=1 ./scripts/build-image.sh --multi               # push to registry
#
# Requires:
#   - pnpm
#   - docker (or orbstack / podman aliased to docker)
#   - buildx (for --multi)

set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE="${IMAGE:-kimchi:latest}"
MULTI=0
for arg in "$@"; do
    case "$arg" in
        --multi) MULTI=1 ;;
    esac
done

echo "[1/3] Building cross-compiled linux binaries..."
pnpm build:binary-linux-x64
mv dist/bin/kimchi dist/bin/kimchi-linux-amd64
pnpm build:binary-linux-arm64
mv dist/bin/kimchi dist/bin/kimchi-linux-arm64

if [[ "$MULTI" -eq 1 ]]; then
    echo "[2/3] Building multi-arch image $IMAGE via buildx..."
    PUSH_FLAG=""
    if [[ "${PUSH:-0}" -eq 1 ]]; then
        PUSH_FLAG="--push"
    else
        PUSH_FLAG="--load"
        echo "  (--load only supports a single arch — pass PUSH=1 for true multi-arch publish)"
    fi
    docker buildx build \
        --platform linux/amd64,linux/arm64 \
        -t "$IMAGE" \
        $PUSH_FLAG \
        .
else
    echo "[2/3] Building single-arch image $IMAGE..."
    docker build -t "$IMAGE" .
fi

echo "[3/3] Done. Test with:"
echo "    docker run --rm -v \$PWD:/workspace $IMAGE --task /workspace/.kimchi/task.json"
