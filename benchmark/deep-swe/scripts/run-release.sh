#!/usr/bin/env bash
# Run DeepSWE against the latest published kimchi release via Pier.
# Downloads the tarball from GitHub, verifies its sha256, and installs it
# inside the container. No local build toolchain required.
#
# Usage:
#   ./scripts/run-release.sh -i fastapi-deprecation-response-headers
#   MODEL=kimchi-dev/minimax-m3 ./scripts/run-release.sh -n 8
set -euo pipefail

BENCHMARK_NAME="${BENCHMARK_NAME:-deep-swe}"
JOBS_DIR="${JOBS_DIR:-benchmark/deep-swe/jobs}"
DEEP_SWE_REPO="${DEEP_SWE_REPO:-https://github.com/datacurve-ai/deep-swe}"
DEEP_SWE_PATH="${DEEP_SWE_PATH:-/tmp/deep-swe/tasks}"

: "${KIMCHI_API_KEY:?set KIMCHI_API_KEY in env}"

BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(git -C "$BENCH_DIR" rev-parse --show-toplevel)"

# Force the release path: ignore any host-side binary.
unset KIMCHI_CODE_BINARY

echo "==> Cloning DeepSWE tasks"
rm -rf /tmp/deep-swe
git clone --depth 1 "$DEEP_SWE_REPO" /tmp/deep-swe

HARBOR_PROJECT="$REPO_ROOT/benchmark/terminal-bench-2"

cd "$REPO_ROOT"
export USE_PIER=true
export DEEP_SWE_TASKS_PATH="$DEEP_SWE_PATH"
exec uv run --project "$HARBOR_PROJECT" --python 3.14 pier run \
    --agent-import-path kimchi_agent:Kimchi \
    --env docker \
    --model "${MODEL:-kimchi-dev/minimax-m3}" \
    --ae "KIMCHI_API_KEY=$KIMCHI_API_KEY" \
    -p "$DEEP_SWE_PATH" \
    --jobs-dir "$JOBS_DIR" \
    "$@"
