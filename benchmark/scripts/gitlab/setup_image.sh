#!/usr/bin/env bash
# Setup-image job orchestrator. Installs toolchain, checks out target ref,
# builds Kimchi binary, then builds & pushes the runner image to GitLab
# Container Registry.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

# ── Base packages ────────────────────────────────────────────────────────────
echo "==> Installing base packages"
apt-get update -qq
apt-get install -y --no-install-recommends \
  bash build-essential ca-certificates curl docker.io file git gnupg jq python3 xz-utils

# ── uv ───────────────────────────────────────────────────────────────────────
echo "==> Installing uv"
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"

# ── Go ───────────────────────────────────────────────────────────────────────
GO_VERSION=1.25.5
echo "==> Installing Go ${GO_VERSION}"
curl -fsSLo /tmp/go.tgz "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz"
rm -rf /usr/local/go
tar -C /usr/local -xzf /tmp/go.tgz
export PATH="/usr/local/go/bin:$PATH"

# ── Bun ──────────────────────────────────────────────────────────────────────
echo "==> Installing Bun"
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"

# ── Build Kimchi binary from target ref ──────────────────────────────────────
# The pipeline branch provides infrastructure files (Dockerfile.bench, scripts,
# etc.). The target_ref provides the kimchi source under test. We build the
# kimchi binary in a worktree so CI_PROJECT_DIR stays on the pipeline branch
# (the docker build context needs docker/Dockerfile.bench to exist).
if [ "${CODING_AGENT:-kimchi}" = "kimchi" ]; then
  KIMCHI_BUILD_DIR="${KIMCHI_BUILD_DIR:-${CI_PROJECT_DIR}}"
  if [ -n "${BENCHMARK_TARGET_REF:-}" ]; then
    echo "==> Fetching benchmark target ref: ${BENCHMARK_TARGET_REF}"
    git fetch --depth="${GIT_DEPTH:-20}" origin "${BENCHMARK_TARGET_REF}"
    KIMCHI_BUILD_DIR="$(mktemp -d)"
    git worktree add --detach "${KIMCHI_BUILD_DIR}" FETCH_HEAD
  fi
  echo "==> Building Kimchi binary in ${KIMCHI_BUILD_DIR}"
  (
    cd "${KIMCHI_BUILD_DIR}"
    corepack enable
    corepack prepare pnpm@10.8.1 --activate
    pnpm install --frozen-lockfile
    GOOS=linux GOARCH=amd64 make -C tools/proxy-helper build
    pnpm run build:binary-linux-x64
    git rev-parse HEAD > "${CI_PROJECT_DIR}/.bench_target_sha"
  )
  export BENCHMARK_TARGET_SHA="$(cat .bench_target_sha)"
  rm -f .bench_target_sha

  # Stage the built binary inside CI_PROJECT_DIR so it lives inside the docker
  # build context (Dockerfile COPY paths must be relative to the context).
  if [ "${KIMCHI_BUILD_DIR}" != "${CI_PROJECT_DIR}" ]; then
    mkdir -p "${CI_PROJECT_DIR}/dist/bin"
    cp "${KIMCHI_BUILD_DIR}/dist/bin/kimchi" "${CI_PROJECT_DIR}/dist/bin/kimchi"
    chmod +x "${CI_PROJECT_DIR}/dist/bin/kimchi"
    cp -r "${KIMCHI_BUILD_DIR}/dist/share" "${CI_PROJECT_DIR}/dist/share"
    git worktree remove --force "${KIMCHI_BUILD_DIR}"
  fi
else
  export BENCHMARK_TARGET_SHA="$(git rev-parse HEAD)"
fi
echo "Benchmark target: ${BENCHMARK_TARGET_REF:-HEAD}@${BENCHMARK_TARGET_SHA}"

# ── Authenticate with GitLab Container Registry ──────────────────────────────
# GitLab-provided CI variables: $CI_REGISTRY, $CI_REGISTRY_USER,
# $CI_REGISTRY_PASSWORD. The job container's `docker login` stores credentials
# locally; the CLI forwards X-Registry-Auth to the daemon on `docker push`,
# so the daemon uses those credentials without needing its own config.
echo "$CI_REGISTRY_PASSWORD" | docker login -u "$CI_REGISTRY_USER" --password-stdin "$CI_REGISTRY"

# ── Build & push runner image ────────────────────────────────────────────────
echo "==> Building & pushing runner image"
BENCH_IMAGE="${CI_REGISTRY_IMAGE}/kimchi-bench-runner:${BENCHMARK_TARGET_SHA}"

if docker manifest inspect "${BENCH_IMAGE}" > /dev/null 2>&1; then
  echo "Image ${BENCH_IMAGE} already exists in registry, skipping build"
else
  docker build \
    --cache-from "${BENCH_IMAGE}" \
    --build-arg "KIMCHI_DIST=dist" \
    --build-arg "HARBOR_DATASET=${DATASET:-terminal-bench/terminal-bench-2}" \
    -t "${BENCH_IMAGE}" \
    -f docker/Dockerfile.bench \
    .

  docker push "${BENCH_IMAGE}"
fi

echo "BENCH_IMAGE=${BENCH_IMAGE}" > bench.env
