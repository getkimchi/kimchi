#!/usr/bin/env bash
# Run terminal-bench with PiWorkflowAgent: stock pi plus the kimchi-workflows
# extension, running one named workflow. No kimchi binary is built or used
# anywhere in this path — that is the point of this agent, and the reason this
# script has no build step at all (compare run-workflow.sh, which cross-builds
# kimchi first).
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

: "${KIMCHI_API_KEY:?set KIMCHI_API_KEY in env}"

BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Optional offline install bundle (node + pi + pi-kimchi-provider). Built here
# so a local run picks it up automatically; skip with SKIP_PI_BUNDLE=1 to force
# the in-container network install.
if [ -z "${SKIP_PI_BUNDLE:-}" ]; then
    "$BENCH_DIR/scripts/build-pi-bundle.sh"
fi

# Resolved on the host and uploaded, never installed in the container: task
# images ship no node toolchain, so an in-container resolve fails with
# `Executable not found in $PATH: "npm"`. Use `dir:<checkout>` to test
# unreleased engine changes.
EXTENSION="${EXTENSION:-npm:@kimchi-dev/kimchi-workflows@latest}"
# The workflow's declared name, not a filename.
WORKFLOW="${WORKFLOW:-deep-solve}"

# The adapter reconstructs each task's own agent timeout (task.toml + the
# trial's config.json, harbor's own formula) to size the workflow deadline and
# every step budget. Export TB_AGENT_TIMEOUT_SEC only to force one value for
# every task, which is a debugging aid rather than a normal run.
cd "$BENCH_DIR"
exec uv run --python 3.14 harbor run \
    --agent-import-path kimchi_agent:PiWorkflowAgent \
    --env docker \
    --model "${MODEL:-kimchi-dev/kimi-k2.7}" \
    --ae "KIMCHI_API_KEY=$KIMCHI_API_KEY" \
    ${TB_AGENT_TIMEOUT_SEC:+--ae "TB_AGENT_TIMEOUT_SEC=$TB_AGENT_TIMEOUT_SEC"} \
    --agent-kwarg "extension=$EXTENSION" \
    --agent-kwarg "workflow=$WORKFLOW" \
    -d "$DATASET" \
    "$@"
