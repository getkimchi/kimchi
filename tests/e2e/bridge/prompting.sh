#!/usr/bin/env bash
# Chunk P — prompting through the wired gateway (plan §7). P2 runs now with an
# API key in direct mode; P1/P3 (proxy mode via OAuth) run after the
# interactive SSO sign-in (interactive-oauth.sh).
set -uo pipefail
cd "$(dirname "$0")"
source ./sandbox.sh

RESULTS=()

start_p() {
  new_sandbox
  export PATH="$(sandbox_path claude codex)"
  export KIMCHI_GATEWAY_PORT="${KIMCHI_GATEWAY_PORT:-18766}"
  install_kimchi "$E2E_LATEST"
}

run_p2() {
  # Direct mode (API key + custom gateway URL): clients wired to
  # llm.kimchi.dev complete real prompts.
  [ -n "${E2E_API_KEY:-}" ] || fail "E2E_API_KEY not set"
  start_p
  export KIMCHI_API_KEY="$E2E_API_KEY"
  "$(b_bin)" flush >/dev/null 2>&1 || true
  KIMCHI_BASE_URL="https://llm.kimchi.dev" "$(b_bin)" gateway enable >/dev/null 2>&1 || fail "gateway enable (direct)"
  local out code
  out="$(claude -p "Reply with exactly: OK" 2>&1)"; code=$?
  if [ $code -eq 0 ]; then
    case "$out" in *OK*) pass "claude prompt via direct gateway" ;; *) fail "claude no OK: $(echo "$out" | tail -2)" ;; esac
  else
    fail "claude prompt failed ($code): $(echo "$out" | tail -3)"
  fi
  out="$(codex exec "Reply with exactly: OK" --skip-git-repo-check 2>&1)"; code=$?
  if [ $code -eq 0 ]; then
    case "$out" in *OK*) pass "codex prompt via direct gateway" ;; *) fail "codex no OK: $(echo "$out" | tail -2)" ;; esac
  else
    fail "codex prompt failed ($code): $(echo "$out" | tail -3)"
  fi
  teardown_sandbox
}

SCENARIOS=( "P2:run_p2" )
for entry in "${SCENARIOS[@]}"; do
  name="${entry%%:*}"
  fn="${entry##*:}"
  log="$E2E_RUNS/$name.log"
  if ( set -e; "$fn" ) >"$log" 2>&1; then
    RESULTS+=("PASS $name")
  else
    RESULTS+=("FAIL $name")
    echo "--- $name log (tail) ---" >&2
    tail -30 "$log" >&2
  fi
done
printf '\n=== P-chunk results ===\n'
printf '%s\n' "${RESULTS[@]}"