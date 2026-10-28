#!/usr/bin/env bash
# Chunk A — auth & reporting scenarios (plan §6). Credentialed scenarios
# (A1/A2/A9/A11/A12 — API key) run here; the OAuth ones (A3–A5) are driven
# interactively (browser) in interactive-oauth.sh. Local-only scenarios
# (A6–A8) need no credentials.
#
# Secrets: the API key arrives via $E2E_API_KEY (env only), is never written to
# any file or log, and is used only inside the disposable sandbox.
set -uo pipefail
cd "$(dirname "$0")"
source ./sandbox.sh

RESULTS=()

start_auth() {
  new_sandbox
  export PATH="$(sandbox_path claude codex)"
  # Isolate the gateway port from the real machine's :8766 proxy.
  export KIMCHI_GATEWAY_PORT="${KIMCHI_GATEWAY_PORT:-18766}"
  install_kimchi "$E2E_LATEST"
}

st() { "$(b_bin)" status 2>/dev/null || true; }
st_has() { st | grep -qF "$1"; }
uuid() { grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1; }

run_a1() {
  # A1 — env API key: key resolved, verified via api-keys:verify, reports as "key".
  [ -n "${E2E_API_KEY:-}" ] || fail "E2E_API_KEY not set"
  start_auth
  export KIMCHI_API_KEY="$E2E_API_KEY"   # every status/flush call carries it
  if out="$("$(b_bin)" flush 2>&1)"; then pass "flush verifies with env key"; else fail "flush with env key: $out"; fi
  st_has '"reportingVerified":true' || fail "reportingVerified not true: $(st)"
  st_has '"signInSource":"key"' || fail "signInSource not key: $(st)"
  st_has '"kimchiReporting":true' || fail "kimchiReporting not true: $(st)"
  local org; org="$(st | uuid)"
  [ -n "$org" ] && pass "organization bound from key ($org)" || fail "no org: $(st)"
  teardown_sandbox
}

run_a2() {
  # A2 — global config API key (~/.config/kimchi/config.json), no env.
  [ -n "${E2E_API_KEY:-}" ] || fail "E2E_API_KEY not set"
  start_auth
  mkdir -p "$HOME/.config/kimchi"
  umask 077
  printf '{"apiKey":"%s"}\n' "$E2E_API_KEY" > "$HOME/.config/kimchi/config.json"
  if out="$("$(b_bin)" flush 2>&1)"; then pass "flush verifies with config key"; else fail "flush with config key: $out"; fi
  st_has '"reportingVerified":true' || fail "reportingVerified: $(st)"
  st_has '"signInSource":"kimchi"' || fail "signInSource should be kimchi (config): $(st)"
  teardown_sandbox
}

run_a6() {
  # A6 — signed out: nothing uploaded; session stays local; status unverified.
  start_auth
  st_has '"kimchiSignedIn":false' || fail "should be signed out: $(st)"
  st_has '"reportingVerified":false' || fail "should be unverified: $(st)"
  st_has '"signInSource":"none"' || fail "signInSource: $(st)"
  "$(b_bin)" export jsonl >/dev/null 2>&1 && pass "export works signed out" || fail "export failed"
  teardown_sandbox
}

run_a7() {
  # A7 — PR reporting off (/pr-reporting off): nothing uploaded, status shows off.
  start_auth
  mkdir -p "$HOME/.config/kimchi/harness/pr-cost-reporting"
  umask 077
  printf '{"followsTelemetry":false,"enabled":false}\n' > "$HOME/.config/kimchi/harness/pr-cost-reporting/state.json"
  st_has '"kimchiReporting":false' || fail "kimchiReporting should be false: $(st)"
  teardown_sandbox
}

run_a8() {
  # A8 — telemetry off (env): reporting follows telemetry off.
  start_auth
  export KIMCHI_TELEMETRY_ENABLED=0
  st_has '"kimchiReporting":false' || fail "kimchiReporting should be false with telemetry off: $(st)"
  teardown_sandbox
}

run_a9() {
  # A9 — org policy FORCE_OFF for the signed-in org: reporting off.
  [ -n "${E2E_API_KEY:-}" ] || fail "E2E_API_KEY not set"
  start_auth
  export KIMCHI_API_KEY="$E2E_API_KEY"
  "$(b_bin)" flush >/dev/null 2>&1
  local org; org="$(st | uuid)"
  [ -n "$org" ] || fail "no org signed in"
  mkdir -p "$HOME/.config/kimchi"
  umask 077
  printf '{"orgId":"%s","policy":{"usageReporting":"FORCE_OFF"}}\n' "$org" > "$HOME/.config/kimchi/org-policy.json"
  st_has '"kimchiReporting":false' || fail "kimchiReporting should be false with FORCE_OFF: $(st)"
  teardown_sandbox
}

run_a11() {
  # A11 — local control: export/flush/disable/enable.
  [ -n "${E2E_API_KEY:-}" ] || fail "E2E_API_KEY not set"
  start_auth
  export KIMCHI_API_KEY="$E2E_API_KEY"
  "$(b_bin)" flush >/dev/null 2>&1 || true
  "$(b_bin)" export jsonl >/dev/null 2>&1 && pass "export jsonl" || fail "export jsonl"
  "$(b_bin)" disable >/dev/null 2>&1 || fail "disable"
  st_has '"disabled":true' || fail "disabled not reflected: $(st)"
  "$(b_bin)" enable >/dev/null 2>&1 || fail "enable"
  st_has '"disabled":false' || fail "enable not reflected: $(st)"
  teardown_sandbox
}

run_a12() {
  # A12 — gateway lifecycle with an API-key sign-in. Since the C3 region-URL
  # change, a us/eu key sign-in derives the gateway URL itself — enable works
  # WITHOUT KIMCHI_BASE_URL (direct mode); an unknown region still needs it.
  [ -n "${E2E_API_KEY:-}" ] || fail "E2E_API_KEY not set"
  start_auth
  export KIMCHI_API_KEY="$E2E_API_KEY"
  "$(b_bin)" flush >/dev/null 2>&1 || true
  # (a) us/eu key sign-in: direct mode with the region-derived URL, no env.
  mkdir -p "$HOME/.claude"
  printf '{"env":{"ORIGINAL":"kept"}}\n' > "$HOME/.claude/settings.json"
  "$(b_bin)" gateway enable >/dev/null 2>&1 || fail "gateway enable (region-derived, no KIMCHI_BASE_URL)"
  local gs; gs="$("$(b_bin)" gateway status 2>&1)"
  case "$gs" in *'"mode":"direct"'*) pass "gateway direct mode (region-derived URL)" ;; *) fail "gateway mode: $gs" ;; esac
  grep -q "llm.kimchi.dev" "$HOME/.claude/settings.json" 2>/dev/null && pass "claude settings wired" || fail "claude settings not wired: $(cat "$HOME/.claude/settings.json" 2>&1)"
  "$(b_bin)" gateway disable >/dev/null 2>&1 || fail "gateway disable"
  grep -q "llm.kimchi.dev" "$HOME/.claude/settings.json" 2>/dev/null && fail "settings not restored after disable" || pass "settings restored after disable"
  # (b) an unknown region still requires KIMCHI_BASE_URL.
  KIMCHI_REMOTE_ENDPOINT="https://app.self-hosted.example/api" "$(b_bin)" gateway enable >/dev/null 2>&1 \
    && fail "unknown region should require KIMCHI_BASE_URL" || pass "unknown region declined without KIMCHI_BASE_URL"
  teardown_sandbox
}

SCENARIOS=( "A1:run_a1" "A2:run_a2" "A6:run_a6" "A7:run_a7" "A8:run_a8" "A9:run_a9" "A11:run_a11" "A12:run_a12" )
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
printf '\n=== A-chunk results ===\n'
printf '%s\n' "${RESULTS[@]}"