#!/usr/bin/env bash
# Run DeepSWE against the current working tree via Pier.
# Cross-builds a Linux amd64 kimchi binary (DeepSWE task images are amd64).
#
# Usage:
#   ./scripts/run-local.sh -i fastapi-deprecation-response-headers
#   MODEL=kimchi-dev/kimi-k2.7 ./scripts/run-local.sh -n 8
#   ./scripts/run-local.sh -i abs-module-cache-flags -k 3
set -euo pipefail

BENCHMARK_NAME="${BENCHMARK_NAME:-deep-swe}"
JOBS_DIR="${JOBS_DIR:-benchmark/deep-swe/jobs}"
DEEP_SWE_REPO="${DEEP_SWE_REPO:-https://github.com/datacurve-ai/deep-swe}"
DEEP_SWE_PATH="${DEEP_SWE_PATH:-/tmp/deep-swe/tasks}"

: "${KIMCHI_API_KEY:?set KIMCHI_API_KEY in env}"

BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(git -C "$BENCH_DIR" rev-parse --show-toplevel)"

echo "==> Cross-building kimchi (target=linux-x64)"
(cd "$REPO_ROOT" && pnpm run build:binary-linux-x64)
export KIMCHI_CODE_BINARY="$REPO_ROOT/dist/bin/kimchi"

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
