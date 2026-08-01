#!/usr/bin/env bash
# Run terminal-bench with the bare pi CLI (upstream @earendil-works/pi-coding-agent),
# configured to use the Kimchi LLM gateway. The selected model is controlled by MODEL.
#
# Unlike run-opencode-kimchi.sh / run-claude-code-kimchi.sh, this runs the base pi
# agent loop without kimchi extensions — isolating pi's behaviour from kimchi's
# extension layer (ferment, model-guard, model catalog, etc.).
#
# The pi-kimchi-provider extension registers the kimchi-dev provider with pi at
# startup, fetching live model metadata from the gateway and routing chat
# completions through the OpenAI-compatible endpoint.
#
# Usage examples:
#   MODEL=kimchi-dev/kimi-k2.5 ./scripts/run-pi-kimchi.sh -i terminal-bench/fix-git
#   MODEL=kimchi-dev/minimax-m2.7 ./scripts/run-pi-kimchi.sh -i terminal-bench/fix-git -k 3
#   PI_VERSION=0.79.10 MODEL=kimchi-dev/kimi-k2.5 ./scripts/run-pi-kimchi.sh -i terminal-bench/fix-git
set -euo pipefail

DATASET="${DATASET:-terminal-bench/terminal-bench-2-1}"

: "${KIMCHI_API_KEY:?set KIMCHI_API_KEY in env}"

BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$BENCH_DIR"

HARBOR_ARGS=(
    --agent-import-path kimchi_agent:PiKimchi
    --env docker
    --model "${MODEL:-kimchi-dev/kimi-k2.5}"
    --ae "KIMCHI_API_KEY=$KIMCHI_API_KEY"
    -d "$DATASET"
    --jobs-dir "${JOBS_DIR:-benchmark/${DATASET#terminal-bench/}/jobs}"
)

if [[ -n "${PI_VERSION:-}" ]]; then
    HARBOR_ARGS+=(--agent-kwarg "version=$PI_VERSION")
fi

exec uv run --python 3.14 harbor run "${HARBOR_ARGS[@]}" "$@"
