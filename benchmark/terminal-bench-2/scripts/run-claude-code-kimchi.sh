#!/usr/bin/env bash
# Run terminal-bench with the Claude Code scaffold, configured to use an
# Anthropic-compatible gateway. The selected model is controlled by MODEL:
# kimchi-dev/* routes via Kimchi, openrouter/* via OpenRouter, and
# moonshotai/* via Moonshot's native API.
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

BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$BENCH_DIR/scripts/model_api_key.sh"
require_model_api_key "$MODEL" kimchi-dev openrouter moonshotai zai
cd "$BENCH_DIR"

# The retry config sets exponential backoff (10s→20s→40s→80s→120s) for
# transient Cloudflare 524 / API errors. The CLI --max-retries flag overrides
# only the retry count; the backoff curve and include_exceptions always come
# from the config file because harbor exposes no CLI flags for
# wait_multiplier/min_wait/max_wait, and passing --retry-include here would
# clobber include_exceptions from the YAML.
RETRY_CONFIG="${RETRY_CONFIG:-$BENCH_DIR/config/retry.yaml}"

HARBOR_ARGS=(
    --agent kimchi_agent:ClaudeCodeKimchi
    --env docker
    --model "$MODEL"
    --config "$RETRY_CONFIG"
    --max-retries "${CLAUDE_CODE_API_MAX_RETRIES:-5}"
    -d "$DATASET"
    --jobs-dir "${JOBS_DIR:-benchmark/${DATASET#terminal-bench/}/jobs}"
)

# Provider keys stay in the host process for native routes. The adapter maps
# them to ANTHROPIC_AUTH_TOKEN, so the raw key need not enter the task container.
if [[ "$MODEL_API_KEY_ENV" == "KIMCHI_API_KEY" ]]; then
    HARBOR_ARGS+=(--ae "KIMCHI_API_KEY=$KIMCHI_API_KEY")
fi

if [[ -n "${CLAUDE_CODE_VERSION:-}" ]]; then
    HARBOR_ARGS+=(--agent-kwarg "version=$CLAUDE_CODE_VERSION")
fi

exec uv run --python 3.14 harbor run "${HARBOR_ARGS[@]}" "$@"
