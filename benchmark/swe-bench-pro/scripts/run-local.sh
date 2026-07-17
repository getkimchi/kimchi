#!/usr/bin/env bash
# Run SWE-bench Pro against the current working tree. Always cross-builds a
# Linux amd64 kimchi binary, since SWE-bench Pro task images are amd64
# (jefzda/sweap-images on DockerHub).
#
# Usage examples:
#   ./scripts/run-local.sh -i instance_ansible__ansible-cd473dfb2fdbc97acf3293c134b21cbbcfa89ec3
#   MODEL=kimchi-dev/kimi-k2.5 ./scripts/run-local.sh -n 8
#   ./scripts/run-local.sh -i instance_nodebb__nodebb-00c70ce7b0541cfc94afe567921d7668cdc8f4ac -k 3
set -euo pipefail

DATASET="${DATASET:-swebenchpro}"
BENCHMARK_NAME="${BENCHMARK_NAME:-swe-bench-pro}"
JOBS_DIR="${JOBS_DIR:-benchmark/swe-bench-pro/jobs}"

: "${KIMCHI_API_KEY:?set KIMCHI_API_KEY in env}"

BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(git -C "$BENCH_DIR" rev-parse --show-toplevel)"

echo "==> Cross-building kimchi (target=linux-x64)"
(cd "$REPO_ROOT" && pnpm run build:binary-linux-x64)
export KIMCHI_CODE_BINARY="$REPO_ROOT/dist/bin/kimchi"

# The Harbor project and kimchi_agent package live in benchmark/terminal-bench-2/
HARBOR_PROJECT="$REPO_ROOT/benchmark/terminal-bench-2"

cd "$REPO_ROOT"
exec uv run --project "$HARBOR_PROJECT" --python 3.14 harbor run \
    --agent-import-path kimchi_agent:Kimchi \
    --env docker \
    --model "${MODEL:-kimchi-dev/minimax-m3}" \
    --ae "KIMCHI_API_KEY=$KIMCHI_API_KEY" \
    -d "$DATASET" \
    --jobs-dir "$JOBS_DIR" \
    "$@"
