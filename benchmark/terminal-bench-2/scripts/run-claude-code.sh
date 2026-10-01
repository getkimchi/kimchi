#!/usr/bin/env bash
# Run terminal-bench with the standard Claude Code release, using the native
# Anthropic API. The selected model is controlled by MODEL and must be an
# Anthropic model ID (e.g. anthropic/claude-sonnet-4-20250514).
#
# Usage examples:
#   ./scripts/run-claude-code.sh -i terminal-bench/fix-git
#   MODEL=anthropic/claude-sonnet-4-20250514 ./scripts/run-claude-code.sh -i terminal-bench/fix-git
#   CLAUDE_CODE_VERSION=2.1.144 ./scripts/run-claude-code.sh -i terminal-bench/fix-git -k 3
set -euo pipefail

DATASET="${DATASET:-terminal-bench/terminal-bench-2-1}"
MODEL="${MODEL:-anthropic/claude-sonnet-5}"

: "${ANTHROPIC_API_KEY:?set ANTHROPIC_API_KEY in env}"

BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$BENCH_DIR"

RETRY_CONFIG="${RETRY_CONFIG:-$BENCH_DIR/config/retry.yaml}"

HARBOR_ARGS=(
    --agent kimchi_agent:ClaudeCodeStandard
    --env docker
    --model "$MODEL"
    --config "$RETRY_CONFIG"
    --max-retries "${CLAUDE_CODE_API_MAX_RETRIES:-5}"
    --ae "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"
    -d "$DATASET"
    --jobs-dir "${JOBS_DIR:-benchmark/${DATASET#terminal-bench/}/jobs}"
)

if [[ -n "${CLAUDE_CODE_VERSION:-}" ]]; then
    HARBOR_ARGS+=(--agent-kwarg "version=$CLAUDE_CODE_VERSION")
fi

exec uv run --python 3.14 harbor run "${HARBOR_ARGS[@]}" "$@"
