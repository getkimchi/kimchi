#!/usr/bin/env bash
# Run terminal-bench with YOUR files on both sides: a locally built kimchi and
# the pi-workflows extension straight from its checkout — no bundle step.
#
# The extension is uploaded as TypeScript and transpiled in the container by
# jiti (PI's extension loader), with `typebox` and `@earendil-works/*` served
# from the copies compiled into the binary. So editing a workflow file and
# re-running this script is the whole edit loop.
#
# Differences from run-workflow.sh:
#   * --agent-import-path kimchi_agent:LocalWorkflowKimchi
#   * TB_WORKFLOW_DIR instead of TB_WORKFLOW_BUNDLE (no `bun build`)
#   * TB_LOG_DIR=/logs/agent, so the engine's run log lands in the trial's
#     agent dir on the host instead of inside the graded workspace. That is
#     what pi-workflows' tools/job-report.py reads.
#   * Reuses an existing KIMCHI_CODE_BINARY instead of cross-building again.
#
# Usage:
#   ./scripts/run-workflow-local.sh -i terminal-bench/fix-git
#   TB_TIMEOUT=600 ./scripts/run-workflow-local.sh -i terminal-bench/fix-git
#   KIMCHI_CODE_BINARY=/path/to/dist/bin/kimchi ./scripts/run-workflow-local.sh -i ...
set -euo pipefail

DATASET="terminal-bench/terminal-bench-2"

: "${KIMCHI_API_KEY:?set KIMCHI_API_KEY in env}"

BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(git -C "$BENCH_DIR" rev-parse --show-toplevel)"

# Resolve the pi-workflows checkout. Default to a sibling directory, override with PI_WORKFLOWS_DIR.
PI_WORKFLOWS_DIR="${PI_WORKFLOWS_DIR:-$REPO_ROOT/../pi-workflows}"
PI_WORKFLOWS_DIR="$(cd "$PI_WORKFLOWS_DIR" 2>/dev/null && pwd || true)"
if [ -z "$PI_WORKFLOWS_DIR" ] || [ ! -f "$PI_WORKFLOWS_DIR/benchmarks/terminal-bench/extension.ts" ]; then
    echo "error: pi-workflows not found at ${PI_WORKFLOWS_DIR:-<unset>}"
    echo "set PI_WORKFLOWS_DIR to the pi-workflows checkout path"
    exit 1
fi
export TB_WORKFLOW_DIR="$PI_WORKFLOWS_DIR"

# The container is linux, so a darwin binary from ~/.local/bin cannot be reused —
# cross-build unless the caller already points at a linux build.
if [ -n "${KIMCHI_CODE_BINARY:-}" ]; then
    echo "==> Reusing kimchi binary: $KIMCHI_CODE_BINARY"
else
    echo "==> Cross-building kimchi (target=linux-x64)"
    (cd "$REPO_ROOT" && pnpm run build:binary-linux-x64)
    export KIMCHI_CODE_BINARY="$REPO_ROOT/dist/bin/kimchi"
fi

echo "==> Extension source: $TB_WORKFLOW_DIR/benchmarks/terminal-bench/extension.ts"

# Per-task agent budgets vary from 900s to 12000s and the adapter cannot read a
# task's own [agent] timeout_sec. Pin BOTH ends together or not at all: harbor's
# --agent-timeout is the kill deadline, TB_AGENT_TIMEOUT_SEC is what the workflow
# schedules against. Setting only the second is how a 12000s task gets a 900s plan.
TIMEOUT_ARGS=()
if [ -n "${TB_TIMEOUT:-}" ]; then
    echo "==> Pinning agent timeout to ${TB_TIMEOUT}s (harness + workflow)"
    TIMEOUT_ARGS=(--agent-timeout "$TB_TIMEOUT" --ae "TB_AGENT_TIMEOUT_SEC=$TB_TIMEOUT")
fi

cd "$BENCH_DIR"
exec uv run --python 3.14 harbor run \
    --agent-import-path kimchi_agent:LocalWorkflowKimchi \
    --env docker \
    --model "${MODEL:-kimchi-dev/kimi-k2.7}" \
    --ae "KIMCHI_API_KEY=$KIMCHI_API_KEY" \
    --ae "TB_LOG_DIR=/logs/agent" \
    "${TIMEOUT_ARGS[@]}" \
    -d "$DATASET" \
    "$@"
