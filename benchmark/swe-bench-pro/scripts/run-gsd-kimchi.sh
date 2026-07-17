#!/usr/bin/env bash
# Run SWE-bench Pro with GSD, configured to use one selected Kimchi model.
#
# Usage examples:
#   MODEL=kimchi-dev/kimi-k2.5 ./scripts/run-gsd-kimchi.sh -i instance_ansible__ansible-cd473dfb2fdbc97acf3293c134b21cbbcfa89ec3
#   GSD_VERSION=3.0.0 MODEL=kimchi-dev/kimi-k2.5 ./scripts/run-gsd-kimchi.sh -n 4
set -euo pipefail

DATASET="${DATASET:-swebenchpro}"
JOBS_DIR="${JOBS_DIR:-benchmark/swe-bench-pro/jobs}"

: "${KIMCHI_API_KEY:?set KIMCHI_API_KEY in env}"

BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(git -C "$BENCH_DIR" rev-parse --show-toplevel)"

HARBOR_PROJECT="$REPO_ROOT/benchmark/terminal-bench-2"

cd "$REPO_ROOT"
HARBOR_ARGS=(
    --agent-import-path kimchi_agent:GsdKimchi
    --env docker
    --model "${MODEL:-kimchi-dev/minimax-m3}"
    --ae "KIMCHI_API_KEY=$KIMCHI_API_KEY"
    -d "$DATASET"
    --jobs-dir "$JOBS_DIR"
)

if [[ -n "${GSD_VERSION:-}" ]]; then
    HARBOR_ARGS+=(--agent-kwarg "version=$GSD_VERSION")
fi

exec uv run --project "$HARBOR_PROJECT" --python 3.14 harbor run "${HARBOR_ARGS[@]}" "$@"
