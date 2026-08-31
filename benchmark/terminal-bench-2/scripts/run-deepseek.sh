#!/usr/bin/env bash
# Run terminal-bench with the DeepSeek Harness (dsh) adapter.
# Routes LLM inference through the Kimchi gateway (KIMCHI_API_KEY).
# The selected model must use the kimchi-dev/* route (routing through the Kimchi gateway).
#
# Usage examples:
#   ./scripts/run-deepseek.sh -i terminal-bench/fix-git
#   MODEL=kimchi-dev/kimi-k2.7 ./scripts/run-deepseek.sh -i terminal-bench/fix-git
#   ./scripts/run-deepseek.sh --disable-verification -i terminal-bench/fix-git
set -euo pipefail

DATASET="${DATASET:-terminal-bench/terminal-bench-2-1}"
MODEL="${MODEL:-kimchi-dev/kimi-k2.7}"

BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$BENCH_DIR/scripts/model_api_key.sh"
require_model_api_key "$MODEL" kimchi-dev
cd "$BENCH_DIR"

exec uv run --python 3.14 harbor run \
    --agent kimchi_agent:DeepSeekAgent \
    --env docker \
    --model "$MODEL" \
    --ae "$MODEL_API_KEY_ENV=${!MODEL_API_KEY_ENV}" \
    -d "$DATASET" \
    --jobs-dir "${JOBS_DIR:-benchmark/${DATASET#terminal-bench/}/jobs}" \
    "$@"
