#!/usr/bin/env bash
# Run the smoke dataset against the current working tree. Cross-builds a
# Linux amd64 kimchi-code binary like terminal-bench-2/scripts/run-local.sh.
#
# Usage:
#   ./scripts/run-local.sh                       # all 3 tasks
#   ./scripts/run-local.sh -i go-rate-limiter    # one task by name
#   ./scripts/run-local.sh --path tasks/go-task-api  # one task by path
#   ./scripts/run-local.sh --ae KIMCHI_MULTI_MODEL=false --ae KIMCHI_TAGS=mode:single
set -euo pipefail

: "${KIMCHI_API_KEY:?set KIMCHI_API_KEY in env}"

BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SMOKE_TASKS_DIR="$BENCH_DIR/tasks"
AGENT_DIR="$(cd "$BENCH_DIR/../terminal-bench-2" && pwd)"
REPO_ROOT="$(git -C "$BENCH_DIR" rev-parse --show-toplevel)"

echo "==> Cross-building kimchi-code (target=linux-x64)"
(cd "$REPO_ROOT" && pnpm run build:binary-linux-x64)
export KIMCHI_CODE_BINARY="$REPO_ROOT/dist/bin/kimchi-code"

# Default to the whole smoke dataset; user-supplied --path / -p wins.
DEFAULT_PATH=("--path" "$SMOKE_TASKS_DIR")
for arg in "$@"; do
    case "$arg" in
        --path|-p) DEFAULT_PATH=() ;;
    esac
done

cd "$AGENT_DIR"
exec uv run --python 3.14 harbor run \
    --agent-import-path kimchi_agent:KimchiCode \
    --env docker \
    --model "${MODEL:-kimchi-dev/kimi-k2.5}" \
    --ae "KIMCHI_API_KEY=$KIMCHI_API_KEY" \
    --jobs-dir "$BENCH_DIR/jobs" \
    "${DEFAULT_PATH[@]}" \
    "$@"
