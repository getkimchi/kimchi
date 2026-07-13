#!/usr/bin/env bash
# Run terminal-bench against the latest published kimchi release. The
# agent downloads the tarball from GitHub, verifies its sha256, and installs
# it inside the container. No local build toolchain required.
#
# Usage examples:
#   ./scripts/run-release.sh -i terminal-bench/fix-git
#   MODEL=kimchi-dev/minimax-m2.7 ./scripts/run-release.sh -i terminal-bench/fix-git
#   MODEL=multi-model ./scripts/run-release.sh -i terminal-bench/fix-git -k 3
set -euo pipefail

DATASET="terminal-bench/terminal-bench-2"

: "${KIMCHI_API_KEY:?set KIMCHI_API_KEY in env}"

BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$BENCH_DIR"

# Force the release path: ignore any host-side binary.
unset KIMCHI_CODE_BINARY

exec uv run --python 3.14 harbor run \
    --agent-import-path kimchi_agent:Kimchi \
    --env docker \
    --model "${MODEL:-kimchi-dev/kimi-k2.5}" \
    --ae "KIMCHI_API_KEY=$KIMCHI_API_KEY" \
    -d "$DATASET" \
    "$@"
