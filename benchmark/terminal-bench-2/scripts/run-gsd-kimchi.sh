#!/usr/bin/env bash
# Run terminal-bench with GSD, configured to use one selected Kimchi model.
#
# Usage examples:
#   MODEL=kimchi-dev/kimi-k2.5 ./scripts/run-gsd-kimchi.sh -i terminal-bench/fix-git
#   MODEL=kimchi-dev/minimax-m2.7 ./scripts/run-gsd-kimchi.sh -i terminal-bench/fix-git -k 3
#   GSD_VERSION=3.0.0 MODEL=kimchi-dev/kimi-k2.5 ./scripts/run-gsd-kimchi.sh -i terminal-bench/fix-git
set -euo pipefail

DATASET="terminal-bench/terminal-bench-2"

: "${KIMCHI_API_KEY:?set KIMCHI_API_KEY in env}"

BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$BENCH_DIR"

HARBOR_ARGS=(
    --agent-import-path kimchi_agent:GsdKimchi
    --env docker
    --model "${MODEL:-kimchi-dev/kimi-k2.5}"
    --ae "KIMCHI_API_KEY=$KIMCHI_API_KEY"
    -d "$DATASET"
)

if [[ -n "${GSD_VERSION:-}" ]]; then
    HARBOR_ARGS+=(--agent-kwarg "version=$GSD_VERSION")
fi

exec uv run --python 3.14 harbor run "${HARBOR_ARGS[@]}" "$@"
