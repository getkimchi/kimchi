#!/usr/bin/env bash
# Run terminal-bench with the OpenCode scaffold, configured to use the Kimchi
# OpenAI-compatible gateway. The selected model is controlled by MODEL.
#
# Usage examples:
#   MODEL=kimchi-dev/kimi-k2.7 ./scripts/run-opencode-kimchi.sh -i terminal-bench/fix-git
#   MODEL=kimchi-dev/minimax-m3 ./scripts/run-opencode-kimchi.sh -i terminal-bench/fix-git -k 3
#   OPENCODE_VERSION=1.14.33 MODEL=kimchi-dev/kimi-k2.7 ./scripts/run-opencode-kimchi.sh -i terminal-bench/fix-git
set -euo pipefail

DATASET="${DATASET:-terminal-bench/terminal-bench-2-1}"
MODEL="${MODEL:-kimchi-dev/kimi-k2.7}"

BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$BENCH_DIR/scripts/model_api_key.sh"
require_model_api_key "$MODEL" kimchi-dev openrouter moonshotai zai
cd "$BENCH_DIR"

HARBOR_ARGS=(
    --agent kimchi_agent:OpenCodeKimchi
    --env docker
    --model "$MODEL"
    --ae "$MODEL_API_KEY_ENV=${!MODEL_API_KEY_ENV}"
    -d "$DATASET"
    --jobs-dir "${JOBS_DIR:-benchmark/${DATASET#terminal-bench/}/jobs}"
)

if [[ -n "${OPENCODE_VERSION:-}" ]]; then
    HARBOR_ARGS+=(--agent-kwarg "version=$OPENCODE_VERSION")
fi

exec uv run --python 3.14 harbor run "${HARBOR_ARGS[@]}" "$@"
