#!/usr/bin/env bash
# Run terminal-bench with the Cursor Agent CLI scaffold.
# Uses Cursor's own cloud backend for inference (requires CURSOR_API_KEY).
# Supports all models in Cursor's hosted catalog, including OSS models
# like GLM 5.2 and Kimi K2.7 Code.
#
# Usage examples:
#   ./scripts/run-cursor.sh -i terminal-bench/fix-git
#   MODEL=cursor/glm-5.2 ./scripts/run-cursor.sh -i terminal-bench/fix-git
#   MODEL=cursor/kimi-k2.7-code ./scripts/run-cursor.sh -i terminal-bench/fix-git -k 3
set -euo pipefail

DATASET="${DATASET:-terminal-bench/terminal-bench-2-1}"

: "${CURSOR_API_KEY:?set CURSOR_API_KEY in env}"

BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$BENCH_DIR"

HARBOR_ARGS=(
    --agent kimchi_agent:CursorAgent
    --env docker
    --model "${MODEL:-cursor/composer-2.5}"
    --ae "CURSOR_API_KEY=$CURSOR_API_KEY"
    -d "$DATASET"
)

exec uv run --python 3.14 harbor run "${HARBOR_ARGS[@]}" "$@"
