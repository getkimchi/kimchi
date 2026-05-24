#!/usr/bin/env bash
# Run terminal-bench with the Claude Code scaffold, configured to use the
# Kimchi Anthropic-compatible gateway. The selected model is controlled by MODEL.
#
# Usage examples:
#   MODEL=kimchi-dev/kimi-k2.5 ./scripts/run-claude-code-kimchi.sh -i terminal-bench/fix-git
#   MODEL=kimchi-dev/minimax-m2.7 ./scripts/run-claude-code-kimchi.sh -i terminal-bench/fix-git -k 3
#   CLAUDE_CODE_VERSION=2.1.144 MODEL=kimchi-dev/kimi-k2.5 ./scripts/run-claude-code-kimchi.sh -i terminal-bench/fix-git
#   CLAUDE_CODE_API_MAX_RETRIES=0 ./scripts/run-claude-code-kimchi.sh -i terminal-bench/fix-git
set -euo pipefail

DATASET="terminal-bench/terminal-bench-2"

: "${KIMCHI_API_KEY:?set KIMCHI_API_KEY in env}"

BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$BENCH_DIR"

HARBOR_ARGS=(
    --agent-import-path kimchi_agent:ClaudeCodeKimchi
    --env docker
    --model "${MODEL:-kimchi-dev/kimi-k2.5}"
    --ae "KIMCHI_API_KEY=$KIMCHI_API_KEY"
    --max-retries "${CLAUDE_CODE_API_MAX_RETRIES:-2}"
    --retry-include RetryableApiError
    -d "$DATASET"
)

if [[ -n "${CLAUDE_CODE_VERSION:-}" ]]; then
    HARBOR_ARGS+=(--agent-kwarg "version=$CLAUDE_CODE_VERSION")
fi

exec uv run --python 3.14 harbor run "${HARBOR_ARGS[@]}" "$@"
