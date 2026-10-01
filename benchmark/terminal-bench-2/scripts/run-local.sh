#!/usr/bin/env bash
# Run terminal-bench against the current working tree. Always cross-builds a
# Linux amd64 kimchi binary, since terminal-bench task images are amd64
# (often amd64-only — Apple Silicon hosts run them under Rosetta translation).
#
# Usage examples:
#   ./scripts/run-local.sh -i terminal-bench/fix-git
#   MODEL=kimchi-dev/kimi-k2.7 ./scripts/run-local.sh -i terminal-bench/fix-git -k 3
#   MODEL=multi-model ./scripts/run-local.sh -i terminal-bench/fix-git -k 3
set -euo pipefail

DATASET="${DATASET:-terminal-bench/terminal-bench-2-1}"
MODEL="${MODEL:-kimchi-dev/kimi-k2.7}"

BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(git -C "$BENCH_DIR" rev-parse --show-toplevel)"
source "$BENCH_DIR/scripts/model_api_key.sh"
require_model_api_key "$MODEL" kimchi-dev openrouter anthropic moonshotai zai multi-model

echo "==> Cross-building kimchi (target=linux-x64)"
(cd "$REPO_ROOT" && pnpm run build:binary-linux-x64)
# `build:binary-linux-x64` produces dist/bin/kimchi alongside dist/share/kimchi/{package.json,theme,export-html}.
# The agent walks up from the binary to find the share/ tree, so point KIMCHI_CODE_BINARY at bin/kimchi.
export KIMCHI_CODE_BINARY="$REPO_ROOT/dist/bin/kimchi"

cd "$BENCH_DIR"
exec uv run --python 3.14 harbor run \
    --agent kimchi_agent:Kimchi \
    --env docker \
    --model "$MODEL" \
    --ae "$MODEL_API_KEY_ENV=${!MODEL_API_KEY_ENV}" \
    -d "$DATASET" \
    --jobs-dir "${JOBS_DIR:-benchmark/${DATASET#terminal-bench/}/jobs}" \
    "$@"
