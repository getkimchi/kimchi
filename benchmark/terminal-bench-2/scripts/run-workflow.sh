#!/usr/bin/env bash
# Run terminal-bench with WorkflowAgent: kimchi plus the kimchi-workflows
# extension, running one named workflow. Always cross-builds a Linux amd64
# kimchi binary, matching run-local.sh.
#
# Usage examples:
#   ./scripts/run-workflow.sh -i terminal-bench/fix-git
#   WORKFLOW=tb-solver ./scripts/run-workflow.sh -i terminal-bench/fix-git -k 3
#   EXTENSION=dir:/path/to/kimchi-workflows ./scripts/run-workflow.sh -i terminal-bench/fix-git
set -euo pipefail

DATASET="${DATASET:-terminal-bench/terminal-bench-2-1}"
MODEL="${MODEL:-kimchi-dev/kimi-k2.7}"

BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(git -C "$BENCH_DIR" rev-parse --show-toplevel)"
source "$BENCH_DIR/scripts/model_api_key.sh"
require_model_api_key "$MODEL" kimchi-dev openrouter anthropic moonshotai zai multi-model

echo "==> Cross-building kimchi (target=linux-x64)"
(cd "$REPO_ROOT" && pnpm run build:binary-linux-x64)
# `build:binary-linux-x64` produces dist/bin/kimchi alongside dist/share/kimchi/{package.json,theme,export-html}.
# The agent walks up from the binary to find the share/ tree, so point KIMCHI_CODE_BINARY at bin/kimchi.
export KIMCHI_CODE_BINARY="$REPO_ROOT/dist/bin/kimchi"

# The extension is resolved on the host and uploaded, never installed in the
# container: task images ship no Node toolchain, so `-e npm:...` fails there
# with `Executable not found in $PATH: "npm"`. Pin the version — host
# resolution caches by `<pkg>@<version>`, so a job resolves once, not per trial.
# Use `dir:<path to a checkout>` to test unreleased engine changes.
EXTENSION="${EXTENSION:-npm:@kimchi-dev/kimchi-workflows@0.0.1-alpha.2}"
# The workflow's declared name, not a filename.
WORKFLOW="${WORKFLOW:-ferment-oneshot}"

cd "$BENCH_DIR"
exec uv run --python 3.14 harbor run \
    --agent kimchi_agent:WorkflowAgent \
    --env docker \
    --model "$MODEL" \
    --ae "$MODEL_API_KEY_ENV=${!MODEL_API_KEY_ENV}" \
    --agent-kwarg "extension=$EXTENSION" \
    --agent-kwarg "workflow=$WORKFLOW" \
    -d "$DATASET" \
    "$@"
