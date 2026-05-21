#!/usr/bin/env bash
# Run terminal-bench with the OpenCode scaffold, configured to use the Kimchi
# OpenAI-compatible gateway. The selected model is controlled by MODEL.
#
# Usage examples:
#   MODEL=kimchi-dev/kimi-k2.5 ./scripts/run-opencode-kimchi.sh -i terminal-bench/fix-git
#   MODEL=kimchi-dev/minimax-m2.7 ./scripts/run-opencode-kimchi.sh -i terminal-bench/fix-git -k 3
#   OPENCODE_VERSION=1.14.33 MODEL=kimchi-dev/kimi-k2.5 ./scripts/run-opencode-kimchi.sh -i terminal-bench/fix-git
set -euo pipefail

DATASET="terminal-bench/terminal-bench-2"

: "${KIMCHI_API_KEY:?set KIMCHI_API_KEY in env}"

BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$BENCH_DIR"

HARBOR_ARGS=(
    --agent-import-path kimchi_agent:OpenCodeKimchi
    --env docker
    --model "${MODEL:-kimchi-dev/kimi-k2.5}"
    --ae "KIMCHI_API_KEY=$KIMCHI_API_KEY"
    -d "$DATASET"
)

if [[ -n "${OPENCODE_VERSION:-}" ]]; then
    HARBOR_ARGS+=(--agent-kwarg "version=$OPENCODE_VERSION")
fi

exec uv run --python 3.14 harbor run "${HARBOR_ARGS[@]}" "$@"
