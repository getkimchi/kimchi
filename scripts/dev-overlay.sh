#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

SANDBOX_HOME="${KIMCHI_OVERLAY_HOME:-$(mktemp -d "${TMPDIR:-/tmp}/kimchi-overlay.XXXXXX")}"
SANDBOX_WORKDIR="$SANDBOX_HOME/workdir"
CONFIG_DIR="$SANDBOX_HOME/.config/kimchi"

cleanup() {
	if [[ -z "${KIMCHI_OVERLAY_HOME:-}" && "${KEEP_KIMCHI_OVERLAY_HOME:-0}" != "1" ]]; then
		rm -rf "$SANDBOX_HOME"
	fi
}
trap cleanup EXIT

mkdir -p "$CONFIG_DIR" "$SANDBOX_WORKDIR"
cat > "$CONFIG_DIR/config.json" <<'JSON'
{
  "skillPaths": [],
  "migrationState": "done",
  "onboarding": {
    "hideSessionModeDialog": true
  },
  "telemetry": {
    "enabled": false
  }
}
JSON

echo "Starting Kimchi overlay check with isolated HOME:"
echo "  $SANDBOX_HOME"
echo
echo "Expected manual check:"
echo "  1. The existing Shift+Enter / Ctrl+J terminal overlay appears."
echo "  2. Press any key to dismiss it."
echo "  3. Kimchi continues startup normally."
echo
echo "Set KEEP_KIMCHI_OVERLAY_HOME=1 to preserve this HOME after exit."
echo

make -C "$PROJECT_ROOT/tools/proxy-helper" copy-for-dev

cd "$SANDBOX_WORKDIR"
env \
	HOME="$SANDBOX_HOME" \
	TMUX="/tmp/kimchi-overlay-test,1,0" \
	TERMINAL_EMULATOR="" \
	KIMCHI_TELEMETRY_ENABLED=0 \
	PI_SKIP_VERSION_CHECK=1 \
	bun run --preload "$PROJECT_ROOT/src/set-package-dir.ts" "$PROJECT_ROOT/src/entry.ts" "$@"
