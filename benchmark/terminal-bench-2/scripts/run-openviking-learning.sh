#!/usr/bin/env bash
# Run sequential Terminal-Bench 2.1 attempts with task-scoped OpenViking memory.
set -euo pipefail

: "${KIMCHI_API_KEY:?set KIMCHI_API_KEY in env}"
: "${OPENVIKING_URL:?set OPENVIKING_URL to a container-reachable server}"

BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(git -C "$BENCH_DIR" rev-parse --show-toplevel)"
DEFAULT_OPENVIKING_EXTENSION_DIR="$HOME/.config/kimchi/harness/packages/openviking"
export OPENVIKING_EXTENSION_DIR="${OPENVIKING_EXTENSION_DIR:-$DEFAULT_OPENVIKING_EXTENSION_DIR}"

if [[ ! -f "$OPENVIKING_EXTENSION_DIR/index.ts" ]]; then
  echo "OpenViking Pi extension not found at $OPENVIKING_EXTENSION_DIR" >&2
  echo "Set OPENVIKING_EXTENSION_DIR to the official extension directory." >&2
  exit 2
fi

OLLAMA_WARMUP_PID=""
cleanup_ollama_warmup() {
  if [[ -n "$OLLAMA_WARMUP_PID" ]]; then
    kill "$OLLAMA_WARMUP_PID" 2>/dev/null || true
    wait "$OLLAMA_WARMUP_PID" 2>/dev/null || true
  fi
}
trap cleanup_ollama_warmup EXIT

if [[ -n "${OPENVIKING_OLLAMA_URL:-}" ]]; then
  echo "==> Warming the OpenViking embedding model"
  (
    cd "$BENCH_DIR"
    uv run --python 3.14 python -c \
      'import sys; sys.path.insert(0, "scripts"); from openviking_learning import warm_ollama; warm_ollama()'
  ) &
  OLLAMA_WARMUP_PID="$!"
fi

echo "==> Cross-building kimchi (target=linux-x64)"
(cd "$REPO_ROOT" && pnpm run build:binary-linux-x64)
export KIMCHI_CODE_BINARY="$REPO_ROOT/dist/bin/kimchi"

if [[ -n "$OLLAMA_WARMUP_PID" ]]; then
  wait "$OLLAMA_WARMUP_PID"
  OLLAMA_WARMUP_PID=""
fi

cd "$BENCH_DIR"
exec uv run --python 3.14 python scripts/openviking_learning.py "$@"
