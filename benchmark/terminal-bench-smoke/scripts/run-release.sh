#!/usr/bin/env bash
# Run the smoke dataset against the latest published kimchi-code release.
set -euo pipefail

: "${KIMCHI_API_KEY:?set KIMCHI_API_KEY in env}"

BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SMOKE_TASKS_DIR="$BENCH_DIR/tasks"
AGENT_DIR="$(cd "$BENCH_DIR/../terminal-bench-2" && pwd)"

unset KIMCHI_CODE_BINARY

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
