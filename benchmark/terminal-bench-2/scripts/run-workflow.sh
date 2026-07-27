#!/usr/bin/env bash
# Run terminal-bench with the pi-workflows terminal-bench solver.
#
# This script does three things the stock run-local.sh does not:
#   1. Builds the pi-workflows extension bundle (bun build extension.ts → tb-workflow.js)
#   2. Sets TB_WORKFLOW_BUNDLE so the WorkflowKimchi agent can find and upload it
#   3. Uses --agent-import-path kimchi_agent:WorkflowKimchi instead of :Kimchi
#
# Usage:
#   ./scripts/run-workflow.sh -i terminal-bench/fix-git
#   MODEL=kimchi-dev/kimi-k2.7 ./scripts/run-workflow.sh -i terminal-bench/fix-git -k 3
#   TB_AGENT_TIMEOUT_SEC=900 ./scripts/run-workflow.sh -i terminal-bench/fix-git
set -euo pipefail

DATASET="terminal-bench/terminal-bench-2"

: "${KIMCHI_API_KEY:?set KIMCHI_API_KEY in env}"

BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(git -C "$BENCH_DIR" rev-parse --show-toplevel)"

# Resolve the pi-workflows checkout. Default to a sibling directory, override with PI_WORKFLOWS_DIR.
PI_WORKFLOWS_DIR="${PI_WORKFLOWS_DIR:-$REPO_ROOT/../pi-workflows}"
if [ ! -f "$PI_WORKFLOWS_DIR/benchmarks/terminal-bench/extension.ts" ]; then
    echo "error: pi-workflows not found at $PI_WORKFLOWS_DIR"
    echo "set PI_WORKFLOWS_DIR to the pi-workflows checkout path"
    exit 1
fi

echo "==> Cross-building kimchi (target=linux-x64)"
(cd "$REPO_ROOT" && pnpm run build:binary-linux-x64)
export KIMCHI_CODE_BINARY="$REPO_ROOT/dist/bin/kimchi"

echo "==> Building pi-workflows extension bundle"
TB_EXTENSION_SRC="$PI_WORKFLOWS_DIR/benchmarks/terminal-bench/extension.ts"
TB_BUNDLE_DIR="$BENCH_DIR/.tb-workflow-build"
mkdir -p "$TB_BUNDLE_DIR"
TB_BUNDLE_PATH="$TB_BUNDLE_DIR/tb-workflow.js"

# bun is the dev runtime for kimchi and is already available.
bun build "$TB_EXTENSION_SRC" --target=node --format=esm --outfile "$TB_BUNDLE_PATH"
export TB_WORKFLOW_BUNDLE="$TB_BUNDLE_PATH"

echo "==> Bundle: $TB_BUNDLE_PATH"
echo "==> PI_WORKFLOWS_DIR: $PI_WORKFLOWS_DIR"

cd "$BENCH_DIR"
exec uv run --python 3.14 harbor run \
    --agent-import-path kimchi_agent:WorkflowKimchi \
    --env docker \
    --model "${MODEL:-kimchi-dev/kimi-k2.7}" \
    --ae "KIMCHI_API_KEY=$KIMCHI_API_KEY" \
    -d "$DATASET" \
    "$@"
