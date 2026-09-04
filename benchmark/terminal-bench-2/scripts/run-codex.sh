#!/usr/bin/env bash
# Run terminal-bench with Harbor's built-in Codex adapter and the native
# OpenAI API. The selected model must use the openai/* route.
#
# Usage examples:
#   ./scripts/run-codex.sh -i terminal-bench/fix-git
#   MODEL=openai/gpt-5.6-terra ./scripts/run-codex.sh -i terminal-bench/fix-git
#   ./scripts/run-codex.sh --disable-verification -i terminal-bench/fix-git
set -euo pipefail

DATASET="${DATASET:-terminal-bench/terminal-bench-2-1}"
MODEL="${MODEL:-openai/gpt-5.6-luna}"

BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$BENCH_DIR/scripts/model_api_key.sh"
require_model_api_key "$MODEL" openai
cd "$BENCH_DIR"

exec uv run --python 3.14 harbor run \
    --agent codex \
    --env docker \
    --model "$MODEL" \
    --ae "$MODEL_API_KEY_ENV=${!MODEL_API_KEY_ENV}" \
    -d "$DATASET" \
    --jobs-dir "${JOBS_DIR:-benchmark/${DATASET#terminal-bench/}/jobs}" \
    "$@"
