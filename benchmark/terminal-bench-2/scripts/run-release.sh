#!/usr/bin/env bash
# Run terminal-bench against the latest published kimchi release. The
# agent downloads the tarball from GitHub, verifies its sha256, and installs
# it inside the container. No local build toolchain required.
#
# Usage examples:
#   ./scripts/run-release.sh -i terminal-bench/fix-git
#   MODEL=kimchi-dev/minimax-m3 ./scripts/run-release.sh -i terminal-bench/fix-git
#   MODEL=multi-model ./scripts/run-release.sh -i terminal-bench/fix-git -k 3
set -euo pipefail

DATASET="${DATASET:-terminal-bench/terminal-bench-2-1}"
MODEL="${MODEL:-kimchi-dev/kimi-k2.7}"

BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$BENCH_DIR/scripts/model_api_key.sh"
require_model_api_key "$MODEL" kimchi-dev openrouter anthropic moonshotai zai multi-model
cd "$BENCH_DIR"

# Force the release path: ignore any host-side binary.
unset KIMCHI_CODE_BINARY

exec uv run --python 3.14 harbor run \
    --agent kimchi_agent:Kimchi \
    --env docker \
    --model "$MODEL" \
    --ae "$MODEL_API_KEY_ENV=${!MODEL_API_KEY_ENV}" \
    -d "$DATASET" \
    --jobs-dir "${JOBS_DIR:-benchmark/${DATASET#terminal-bench/}/jobs}" \
    "$@"
