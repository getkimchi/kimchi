#!/usr/bin/env bash
# Run terminal-bench with PiWorkflowAgent: stock pi plus the kimchi-workflows
# extension, running one named workflow. No kimchi binary is built or used.
#
# Usage examples:
#   ./scripts/run-pi-workflow.sh -i terminal-bench/fix-git
#   WORKFLOW=deep-solve ./scripts/run-pi-workflow.sh -i terminal-bench/fix-git -k 3
#   EXTENSION=dir:/path/to/kimchi-workflows ./scripts/run-pi-workflow.sh -i terminal-bench/fix-git
#
# Extra args go straight to `harbor run` (-i include, -x exclude, -l task cap,
# -k attempts, -n concurrency). Drop -i to run the whole dataset.
set -euo pipefail

DATASET="${DATASET:-terminal-bench/terminal-bench-2-1}"
MODEL="${MODEL:-kimchi-dev/kimi-k2.7}"

BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$BENCH_DIR/scripts/model_api_key.sh"
require_model_api_key "$MODEL" kimchi-dev openrouter moonshotai zai

# Optional offline install bundle (node + pi + pi-kimchi-provider). Built
# automatically; skip with SKIP_PI_BUNDLE=1 to force the network install.
if [ -z "${SKIP_PI_BUNDLE:-}" ]; then
    "$BENCH_DIR/scripts/build-pi-bundle.sh"
fi

# Resolved on the host and uploaded, never in the container: task images ship no
# node toolchain. Use dir:<checkout> to test unreleased engine changes.
EXTENSION="${EXTENSION:-npm:@kimchi-dev/kimchi-workflows@latest}"
# The workflow's declared name, not a filename.
WORKFLOW="${WORKFLOW:-deep-solve}"

# The adapter reconstructs each task's agent timeout to size the workflow
# deadline and step budgets. Export TB_AGENT_TIMEOUT_SEC to force one value for
# every task (debugging aid).
cd "$BENCH_DIR"
exec uv run --python 3.14 harbor run \
    --agent kimchi_agent:PiWorkflowAgent \
    --env docker \
    --model "$MODEL" \
    --ae "$MODEL_API_KEY_ENV=${!MODEL_API_KEY_ENV}" \
    ${TB_AGENT_TIMEOUT_SEC:+--ae "TB_AGENT_TIMEOUT_SEC=$TB_AGENT_TIMEOUT_SEC"} \
    --agent-kwarg "extension=$EXTENSION" \
    --agent-kwarg "workflow=$WORKFLOW" \
    -d "$DATASET" \
    "$@"
