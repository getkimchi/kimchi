#!/usr/bin/env bash
# Chunk U — update scenarios (plan §5), driven the way refreshBridge drives
# them (src/update/install.ts): swap the sandbox share's bridge bundle for the
# target release's (what applyUpdate's share phase does), then run the bundled
# `install.sh update` per client with KIMCHI_BIN — the exact refresh child
# command. The `kimchi update` orchestration itself is deferred pending the
# version-reporting anomaly (see ISSUES.md IS-9).
set -uo pipefail
cd "$(dirname "$0")"
source ./sandbox.sh

RESULTS=()

start_old() {
  new_sandbox
  export PATH="$(sandbox_path "$@")"
  fixture_synth_old
  install_kimchi "$E2E_OLD"
}

# apply_bundle <version>: replace the sandbox share's bridge with the target
# release's bundle — mirrors applyUpdate: rm vendor+bridge, then copy.
apply_bundle() {
  local v="$1"
  fixture "$v"
  rm -rf "$SAND/data/kimchi/vendor" "$SAND/data/kimchi/bridge"
  cp -R "$E2E_FIXTURES/$v/share/kimchi/bridge" "$SAND/data/kimchi/bridge"
}

# refresh [clients...]: run the refreshBridge child command for the installed
# clients. Clients without a receipt are skipped (as refreshBridge filters).
refresh() {
  local installer="$SAND/data/kimchi/bridge/install.sh"
  local clients=()
  for c in "$@"; do
    [ -f "$(b_prefix)/installed/$c" ] && clients+=("$c")
  done
  [ "${#clients[@]}" -eq 0 ] && return 0
  KIMCHI_BIN="$SAND/bin/kimchi" /bin/sh -c \
    'for client in "$@"; do bash "$0" update "$client"; done' \
    "$installer" "${clients[@]}"
}

# decide_refresh <extra-cond>: mirrors refreshBridge's skip logic — skip when
# no bundled version, no client receipts, or installed/code == bundled.
decide_refresh() {
  local bundled code cl cx
  bundled="$(b_bundled_version)"
  code="$(b_code_marker)"
  cl="$(b_receipt claude)"; cx="$(b_receipt codex)"
  if [ -z "$bundled" ] || { [ -z "$cl" ] && [ -z "$cx" ]; }; then return 1; fi
  if [ -n "$code" ] && [ "$code" = "$bundled" ]; then return 1; fi
  return 0
}

wait_for() {
  local i=0
  while [ "$i" -lt "${2:-90}" ]; do
    if eval "$1" 2>/dev/null; then return 0; fi
    sleep 1; i=$((i + 1))
  done
  return 1
}

INSTALLED_LIB="$(b_prefix)/releases/v0.1.0-rc.8/lib/kimchi-bridge.mjs"

run_u1() {
  # Same bridge version re-applied -> refreshBridge skips (installed/code
  # already matches the bundled version); state stays byte-identical.
  start_old claude codex
  local r1 c1 m1
  r1="$(ls "$(b_prefix)/releases")"; c1="$(b_receipt claude)"; m1="$(b_current_target)"
  apply_bundle "$E2E_OLD"          # swap in the SAME rc.5 bundle
  if decide_refresh; then refresh claude codex; fi
  assert_eq "receipts unchanged" "$c1" "$(b_receipt claude)"
  assert_eq "current.mjs unchanged" "$m1" "$(b_current_target)"
  assert_eq "releases list unchanged" "$r1" "$(ls "$(b_prefix)/releases")"
  assert_eq "code marker unchanged" "v0.1.0-rc.5" "$(b_code_marker)"
  teardown_sandbox
}

run_u2() {
  # Code-only change (codex market hash identical between rc.5 and rc.8):
  # update must relink to the new bundle WITHOUT re-registering.
  start_old codex
  assert_eq "old codex receipt" "kimchi-bridge-6eb38bce548f" "$(b_receipt codex)"
  apply_bundle "$E2E_LATEST"
  refresh codex
  assert_eq "codex receipt unchanged (no re-registration)" "kimchi-bridge-6eb38bce548f" "$(b_receipt codex)"
  assert_eq "current.mjs -> rc.8" "$(b_prefix)/releases/v0.1.0-rc.8/lib/kimchi-bridge.mjs" "$(b_current_target)"
  assert_eq "installed/code bumped" "v0.1.0-rc.8" "$(b_code_marker)"
  local listed; listed="$(codex plugin list --json 2>&1)"
  case "$listed" in *"kimchi-work@kimchi-bridge-6eb38bce548f"*'"enabled": true'*) pass "codex plugin still enabled under same market" ;; *) fail "codex plugin after update: $listed" ;; esac
  teardown_sandbox
}

run_u3() {
  # Wiring change (claude market hash differs rc.5->rc.8): re-registration,
  # old market cleaned, codex untouched, marker bumped. This is the exact
  # rc.5 -> rc.8 case seen on the developer machine (IS-1).
  start_old claude codex
  assert_eq "claude on rc.5 market" "kimchi-bridge-3164b81d581f" "$(b_receipt claude)"
  apply_bundle "$E2E_LATEST"
  refresh claude codex
  assert_eq "claude receipt updated" "kimchi-bridge-f1bdadb7cadf" "$(b_receipt claude)"
  assert_eq "codex receipt unchanged" "kimchi-bridge-6eb38bce548f" "$(b_receipt codex)"
  assert_eq "current.mjs -> rc.8" "$(b_prefix)/releases/v0.1.0-rc.8/lib/kimchi-bridge.mjs" "$(b_current_target)"
  assert_eq "installed/code == rc.8" "v0.1.0-rc.8" "$(b_code_marker)"
  assert_file "$(b_prefix)/releases/v0.1.0-rc.8/lib/kimchi-bridge.mjs" "rc.8 package copied"
  assert_file "$(b_prefix)/releases/v0.1.0-rc.5/VERSION" "rc.5 release retained"
  assert_no_file "$(b_prefix)/install.lock" "no install.lock left"
  local listed; listed="$(claude plugin list 2>&1)"
  case "$listed" in *"kimchi-work@kimchi-bridge-f1bdadb7cadf"*) pass "claude plugin re-registered + enabled" ;; *) fail "claude plugin after update: $listed" ;; esac
  teardown_sandbox
}

run_u4() {
  # Update after uninstall: refresh skips clients with no receipts; nothing
  # re-added, nothing copied.
  start_old claude codex
  bash "$(b_prefix)/install.sh" uninstall both
  assert_no_file "$(b_prefix)/installed/claude" "claude receipt removed"
  apply_bundle "$E2E_LATEST"
  refresh claude codex
  assert_no_file "$(b_prefix)/installed/claude" "update did not re-add claude"
  assert_no_file "$(b_prefix)/installed/codex" "update did not re-add codex"
  assert_no_file "$(b_prefix)/releases/v0.1.0-rc.8/VERSION" "no rc.8 copied (refresh skipped)"
  teardown_sandbox
}

run_u5() {
  # IS-1 regression, exact repro: refresh child env can't find EITHER client ->
  # the installer fails in preflight for both legs and NOTHING changes (the
  # silent-failure seen on the developer machine). Retry completes.
  start_old claude codex
  export PATH="$(sandbox_path)"                # neither client on the child's PATH
  apply_bundle "$E2E_LATEST"
  refresh claude codex || true
  assert_eq "code marker still rc.5" "v0.1.0-rc.5" "$(b_code_marker)"
  assert_eq "current.mjs still rc.5" "$(b_prefix)/releases/v0.1.0-rc.5/lib/kimchi-bridge.mjs" "$(b_current_target)"
  assert_eq "claude receipt still rc.5 market" "kimchi-bridge-3164b81d581f" "$(b_receipt claude)"
  assert_no_file "$(b_prefix)/releases/v0.1.0-rc.8/VERSION" "no rc.8 copied by failed refresh"
  assert_no_file "$(b_prefix)/install.lock" "no lock left after failed refresh"
  # Retry with the full environment: the refresh completes.
  export PATH="$(sandbox_path claude codex)"
  refresh claude codex
  assert_eq "claude receipt updated on retry" "kimchi-bridge-f1bdadb7cadf" "$(b_receipt claude)"
  assert_eq "current.mjs -> rc.8" "$(b_prefix)/releases/v0.1.0-rc.8/lib/kimchi-bridge.mjs" "$(b_current_target)"
  assert_eq "installed/code == rc.8" "v0.1.0-rc.8" "$(b_code_marker)"
  teardown_sandbox

  # Partial env: only codex reachable -> claude leg fails, codex leg completes;
  # the stale claude receipt keeps the code marker at rc.5 until the retry.
  new_sandbox
  export PATH="$(sandbox_path claude codex)"
  fixture_synth_old; install_kimchi "$E2E_OLD"
  export PATH="$(sandbox_path codex)"          # claude missing from child PATH
  apply_bundle "$E2E_LATEST"
  refresh claude codex || true
  assert_eq "code marker held at rc.5 (claude not migrated)" "v0.1.0-rc.5" "$(b_code_marker)"
  assert_eq "claude receipt still rc.5 market" "kimchi-bridge-3164b81d581f" "$(b_receipt claude)"
  assert_eq "codex receipt moved to rc.8 bundle" "kimchi-bridge-6eb38bce548f" "$(b_receipt codex)"
  assert_eq "current.mjs -> rc.8 (codex leg relinked)" "$(b_prefix)/releases/v0.1.0-rc.8/lib/kimchi-bridge.mjs" "$(b_current_target)"
  # Retry with the full env: claude migrates, marker finally bumps.
  export PATH="$(sandbox_path claude codex)"
  refresh claude codex
  assert_eq "claude receipt migrated on retry" "kimchi-bridge-f1bdadb7cadf" "$(b_receipt claude)"
  assert_eq "installed/code == rc.8" "v0.1.0-rc.8" "$(b_code_marker)"
  teardown_sandbox
}

run_u7() {
  # Hot-session code swap: after the update, the registered plugins' shims
  # resolve the NEW bundle through current.mjs — no client restart needed.
  start_old claude codex
  apply_bundle "$E2E_LATEST"
  refresh claude codex
  assert_eq "CLI reports new version" "v0.1.0-rc.8" "$("$(b_bin)" version 2>&1 | head -1)"
  assert_eq "old-release shim reports new version" "v0.1.0-rc.8" "$("$(b_prefix)/releases/v0.1.0-rc.5/bin/kimchi-bridge" version 2>&1 | head -1)"
  teardown_sandbox
}

run_u8() {
  # Legacy market migration: a pre-bridge-era registration (kimchi-work-<ver>
  # marketplace) is migrated to kimchi-bridge-<hash> by the update.
  local legacy="$E2E_FIXTURES/v1.21.6-legacy"
  if [ ! -d "$legacy" ]; then
    fixture_synth_old
    cp -R "$E2E_FIXTURES/$E2E_OLD" "$legacy.tmp"
    printf 'kimchi-work-v0-1-0-rc-3\n' > "$legacy.tmp/share/kimchi/bridge/markets/claude"
    sed -i '' 's|kimchi-bridge-[0-9a-f]*|kimchi-work-v0-1-0-rc-3|g' "$legacy.tmp/share/kimchi/bridge/.claude-plugin/marketplace.json"
    mv "$legacy.tmp" "$legacy"
  fi
  new_sandbox
  export PATH="$(sandbox_path claude)"
  mkdir -p "$SAND/bin" "$SAND/data"
  cp "$legacy/bin/kimchi" "$SAND/bin/kimchi" && chmod +x "$SAND/bin/kimchi"
  cp -R "$legacy/share/kimchi" "$SAND/data/kimchi"
  KIMCHI_BIN="$SAND/bin/kimchi" bash "$SAND/data/kimchi/bridge/install.sh" install claude </dev/null
  assert_eq "legacy receipt written" "kimchi-work-v0-1-0-rc-3" "$(b_receipt claude)"
  apply_bundle "$E2E_LATEST"
  refresh claude
  assert_eq "receipt migrated to new market" "kimchi-bridge-f1bdadb7cadf" "$(b_receipt claude)"
  assert_no_file "$(b_prefix)/installed/claude.cleanup" "no leftover cleanup receipt"
  assert_eq "installed/code == rc.8" "v0.1.0-rc.8" "$(b_code_marker)"
  local listed; listed="$(claude plugin list 2>&1)"
  case "$listed" in *"kimchi-work@kimchi-bridge-f1bdadb7cadf"*) pass "claude plugin migrated + enabled" ;; *) fail "claude plugin after migration: $listed" ;; esac
  teardown_sandbox
}

SCENARIOS=( "U1:run_u1" "U2:run_u2" "U3:run_u3" "U4:run_u4" "U5:run_u5" "U7:run_u7" "U8:run_u8" )
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
printf '\n=== U-chunk results ===\n'
printf '%s\n' "${RESULTS[@]}"