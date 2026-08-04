#!/usr/bin/env bash
# Run terminal-bench with the Claude Code scaffold, configured to use an
# Anthropic-compatible gateway. The selected model is controlled by MODEL:
# kimchi-dev/* routes via the Kimchi gateway, openrouter/* via OpenRouter.
#
# Usage examples:
#   MODEL=kimchi-dev/kimi-k2.7 ./scripts/run-claude-code-kimchi.sh -i terminal-bench/fix-git
#   MODEL=kimchi-dev/minimax-m3 ./scripts/run-claude-code-kimchi.sh -i terminal-bench/fix-git -k 3
#   MODEL=openrouter/@preset/glm-5-1-zai ./scripts/run-claude-code-kimchi.sh -i terminal-bench/fix-git
#   CLAUDE_CODE_VERSION=2.1.144 MODEL=kimchi-dev/kimi-k2.7 ./scripts/run-claude-code-kimchi.sh -i terminal-bench/fix-git
#   CLAUDE_CODE_API_MAX_RETRIES=0 ./scripts/run-claude-code-kimchi.sh -i terminal-bench/fix-git
set -euo pipefail

DATASET="${DATASET:-terminal-bench/terminal-bench-2-1}"
MODEL="${MODEL:-kimchi-dev/kimi-k2.7}"

# OpenRouter models authenticate with OPENROUTER_API_KEY, read from the host
# env by the agent. It is deliberately not forwarded into the task container
# with --ae: Claude Code authenticates with ANTHROPIC_AUTH_TOKEN, so the raw
# key never needs to exist inside the container.
if [[ "$MODEL" == openrouter/* ]]; then
    : "${OPENROUTER_API_KEY:?set OPENROUTER_API_KEY in env for openrouter/* models}"
else
    : "${KIMCHI_API_KEY:?set KIMCHI_API_KEY in env}"
fi

BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$BENCH_DIR"

# The retry config sets exponential backoff (10s→20s→40s→80s→120s) for
# transient Cloudflare 524 / API errors. The CLI --max-retries flag overrides
# only the retry count; the backoff curve and include_exceptions always come
# from the config file because harbor exposes no CLI flags for
# wait_multiplier/min_wait/max_wait, and passing --retry-include here would
# clobber include_exceptions from the YAML.
RETRY_CONFIG="${RETRY_CONFIG:-$BENCH_DIR/config/retry.yaml}"

HARBOR_ARGS=(
    --agent-import-path kimchi_agent:ClaudeCodeKimchi
    --env docker
    --model "$MODEL"
    --config "$RETRY_CONFIG"
    --max-retries "${CLAUDE_CODE_API_MAX_RETRIES:-5}"
    -d "$DATASET"
    --jobs-dir "${JOBS_DIR:-benchmark/${DATASET#terminal-bench/}/jobs}"
)

if [[ "$MODEL" != openrouter/* ]]; then
    HARBOR_ARGS+=(--ae "KIMCHI_API_KEY=$KIMCHI_API_KEY")
fi

if [[ -n "${CLAUDE_CODE_VERSION:-}" ]]; then
    HARBOR_ARGS+=(--agent-kwarg "version=$CLAUDE_CODE_VERSION")
fi

exec uv run --python 3.14 harbor run "${HARBOR_ARGS[@]}" "$@"
