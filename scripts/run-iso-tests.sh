#!/usr/bin/env bash
# Run Kimchi's unit suite with an isolated HOME, so developer config in
# ~/.config/kimchi/harness/{permissions,settings}.json cannot leak into tests.
#
# Why: src/extensions/permissions/config.ts hardcodes
#   USER_CONFIG_PATH = ~/.config/kimchi/harness/permissions.json
# so a developer who has ever pressed Shift+Tab (defaultMode: "auto")
# sees ~21 spurious failures that do NOT reproduce in CI.
#
#   Usage: bash run-iso-tests.sh <label> [extra vitest args...]
set -uo pipefail

LABEL="${1:?usage: run-iso-tests.sh <label> [vitest args...]}"; shift || true
OUT="${OUT_DIR:-/tmp/pi-iso}"; mkdir -p "$OUT"
LOG="$OUT/$LABEL.txt"

# Capture the REAL Go caches before HOME is replaced. Isolating them too would
# force a cold debug build of the Go stdlib, which blows the 30s DAP timeouts.
if command -v go >/dev/null 2>&1; then
  REAL_GOCACHE="$(go env GOCACHE)"
  REAL_GOMODCACHE="$(go env GOMODCACHE)"
fi

TMPHOME="$(mktemp -d)"
trap 'rm -rf "$TMPHOME"' EXIT
export HOME="$TMPHOME"
[ -n "${REAL_GOCACHE:-}" ]    && export GOCACHE="$REAL_GOCACHE"
[ -n "${REAL_GOMODCACHE:-}" ] && export GOMODCACHE="$REAL_GOMODCACHE"

echo "── $LABEL ─────────────────────────────"
echo "  repo:   $(pwd)"
echo "  branch: $(git branch --show-current 2>/dev/null)"
echo "  HEAD:   $(git rev-parse --short HEAD 2>/dev/null)"
echo "  HOME:   $HOME  (isolated)"
echo "  GOCACHE:${GOCACHE:-<unset>}  (real, preserved)"
echo "  log:    $LOG"
echo

pnpm run test "$@" >"$LOG" 2>&1
status=$?

grep -E "^ (Test Files|Tests) " "$LOG" || tail -5 "$LOG"
echo
echo "── failing tests ──"
sed -n 's/^ FAIL  //p' "$LOG" | sort -u > "$OUT/$LABEL-fails.txt"
if [ -s "$OUT/$LABEL-fails.txt" ]; then cat "$OUT/$LABEL-fails.txt"; else echo "  (none)"; fi
echo
echo "Saved: $LOG  and  $OUT/$LABEL-fails.txt"
exit $status
