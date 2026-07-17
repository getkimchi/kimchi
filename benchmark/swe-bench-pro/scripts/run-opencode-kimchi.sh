#!/usr/bin/env bash
# Run SWE-bench Pro with the OpenCode scaffold, configured to use the Kimchi
# OpenAI-compatible gateway. The selected model is controlled by MODEL.
#
# Usage examples:
#   MODEL=kimchi-dev/kimi-k2.5 ./scripts/run-opencode-kimchi.sh -i instance_ansible__ansible-cd473dfb2fdbc97acf3293c134b21cbbcfa89ec3
#   OPENCODE_VERSION=1.14.33 MODEL=kimchi-dev/kimi-k2.5 ./scripts/run-opencode-kimchi.sh -n 4
set -euo pipefail

DATASET="${DATASET:-swebenchpro}"
JOBS_DIR="${JOBS_DIR:-benchmark/swe-bench-pro/jobs}"

: "${KIMCHI_API_KEY:?set KIMCHI_API_KEY in env}"

BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(git -C "$BENCH_DIR" rev-parse --show-toplevel)"

HARBOR_PROJECT="$REPO_ROOT/benchmark/terminal-bench-2"

cd "$REPO_ROOT"
HARBOR_ARGS=(
    --agent-import-path kimchi_agent:OpenCodeKimchi
    --env docker
    --model "${MODEL:-kimchi-dev/minimax-m3}"
    --ae "KIMCHI_API_KEY=$KIMCHI_API_KEY"
    -d "$DATASET"
    --jobs-dir "$JOBS_DIR"
)

if [[ -n "${OPENCODE_VERSION:-}" ]]; then
    HARBOR_ARGS+=(--agent-kwarg "version=$OPENCODE_VERSION")
fi

exec uv run --project "$HARBOR_PROJECT" --python 3.14 harbor run "${HARBOR_ARGS[@]}" "$@"
