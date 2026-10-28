#!/usr/bin/env bash
# Chunk X — uninstall & control scenarios (plan §8).
set -uo pipefail
cd "$(dirname "$0")"
source ./sandbox.sh

RESULTS=()

run_x1() {
  # Uninstall one client: claude removed, codex intact, data retained.
  new_sandbox
  export PATH="$(sandbox_path claude codex)"
  install_kimchi "$E2E_LATEST"
  bash "$(b_prefix)/install.sh" uninstall claude
  assert_no_file "$(b_prefix)/installed/claude" "claude receipt removed"
  assert_eq "codex receipt intact" "$(b_market codex)" "$(b_receipt codex)"
  local listed; listed="$(claude plugin list 2>&1)"
  case "$listed" in *"kimchi-work@"*) fail "claude still lists kimchi-work: $listed" ;; *) pass "claude plugin removed" ;; esac
  listed="$(codex plugin list --json 2>&1)"
  case "$listed" in *"kimchi-work@$(b_market codex)"*'"enabled": true'*) pass "codex plugin still enabled" ;; *) fail "codex plugin after claude uninstall: $listed" ;; esac
  assert_file "$(b_prefix)/releases/v0.1.0-rc.8/VERSION" "release files retained"
  teardown_sandbox
}

run_x2() {
  # Uninstall both: registrations removed, disable ran, local data retained.
  new_sandbox
  export PATH="$(sandbox_path claude codex)"
  install_kimchi "$E2E_LATEST"
  bash "$(b_prefix)/install.sh" uninstall both
  assert_no_file "$(b_prefix)/installed/claude" "claude receipt removed"
  assert_no_file "$(b_prefix)/installed/codex" "codex receipt removed"
  assert_no_file "$(b_prefix)/installed/claude.cleanup" "no cleanup receipts left"
  local st; st="$("$(b_bin)" status 2>&1)"
  case "$st" in *'"disabled":true'*) pass "kimchi-bridge disable ran" ;; *) fail "disabled not set: $st" ;; esac
  assert_file "$(b_prefix)/releases/v0.1.0-rc.8/VERSION" "release files retained"
  assert_file "$HOME/.local/state/kimchi-bridge/config.json" "state dir retained"
  teardown_sandbox
}

run_x3() {
  # Reinstall after uninstall: the bundled installer re-adds both clients.
  new_sandbox
  export PATH="$(sandbox_path claude codex)"
  install_kimchi "$E2E_LATEST"
  bash "$(b_prefix)/install.sh" uninstall both
  KIMCHI_BIN="$SAND/bin/kimchi" bash "$SAND/data/kimchi/bridge/install.sh" install both </dev/null
  assert_eq "claude receipt recreated" "$(b_market claude)" "$(b_receipt claude)"
  assert_eq "codex receipt recreated" "$(b_market codex)" "$(b_receipt codex)"
  assert_eq "code marker restored" "v0.1.0-rc.8" "$(b_code_marker)"
  local listed; listed="$(claude plugin list 2>&1)"
  case "$listed" in *"kimchi-work@$(b_market claude)"*) pass "claude plugin re-enabled" ;; *) fail "claude plugin after reinstall: $listed" ;; esac
  teardown_sandbox
}

run_x4() {
  # Concurrent installers: one wins, the other reports the lock, state stays sane.
  new_sandbox
  export PATH="$(sandbox_path claude codex)"
  install_kimchi "$E2E_LATEST"
  KIMCHI_BIN="$SAND/bin/kimchi" bash "$SAND/data/kimchi/bridge/install.sh" install both </dev/null \
    >"$E2E_RUNS/X4a.log" 2>&1 &
  local p1=$!
  KIMCHI_BIN="$SAND/bin/kimchi" bash "$SAND/data/kimchi/bridge/install.sh" install both </dev/null \
    >"$E2E_RUNS/X4b.log" 2>&1 &
  local p2=$!
  local rc=0
  wait $p1 || rc=1
  wait $p2 || rc=1
  local locked; locked="$(grep -c "Another installer is running" "$E2E_RUNS/X4a.log" "$E2E_RUNS/X4b.log" 2>/dev/null | awk -F: '{s+=$2} END{print s}')"
  assert_eq "at least one installer hit the lock" "1" "${locked:-0}"
  assert_no_file "$(b_prefix)/install.lock" "lock released after"
  assert_eq "claude receipt present" "$(b_market claude)" "$(b_receipt claude)"
  teardown_sandbox
}

run_x5() {
  # Stale lock recovery: an install.lock whose holder is gone is replaced.
  new_sandbox
  export PATH="$(sandbox_path claude codex)"
  install_kimchi "$E2E_LATEST"
  mkdir -p "$(b_prefix)/install.lock"
  echo "999999" > "$(b_prefix)/install.lock/pid"   # a dead pid
  KIMCHI_BIN="$SAND/bin/kimchi" bash "$SAND/data/kimchi/bridge/install.sh" install both </dev/null
  assert_no_file "$(b_prefix)/install.lock" "stale lock replaced and released"
  assert_eq "claude receipt present" "$(b_market claude)" "$(b_receipt claude)"
  teardown_sandbox
}

run_x6() {
  # Unmanaged kimchi-bridge binary: the installer refuses to clobber it.
  new_sandbox
  export PATH="$(sandbox_path claude)"
  install_kimchi "$E2E_LATEST"
  rm -f "$(b_bin)"        # drop the managed symlink itself
  printf '#!/bin/sh\necho foreign\n' > "$(b_bin)"   # an unmanaged regular file
  chmod +x "$(b_bin)"
  local out
  if out="$(KIMCHI_BIN="$SAND/bin/kimchi" bash "$SAND/data/kimchi/bridge/install.sh" install claude </dev/null 2>&1)"; then
    fail "installer should refuse an unmanaged kimchi-bridge"
  else
    case "$out" in *"Refusing to replace an unmanaged"*) pass "unmanaged binary refused" ;; *) fail "wrong error: $out" ;; esac
  fi
  assert_eq "foreign binary untouched" "foreign" "$("$(b_bin)" 2>&1 | head -1)"
  teardown_sandbox
}

SCENARIOS=( "X1:run_x1" "X2:run_x2" "X3:run_x3" "X4:run_x4" "X5:run_x5" "X6:run_x6" )
for entry in "${SCENARIOS[@]}"; do
  name="${entry%%:*}"
  fn="${entry##*:}"
  log="$E2E_RUNS/$name.log"
  if ( set -e; "$fn" ) >"$log" 2>&1; then
    RESULTS+=("PASS $name")
  else
    RESULTS+=("FAIL $name")
    echo "--- $name log (tail) ---" >&2
    tail -25 "$log" >&2
  fi
done
printf '\n=== X-chunk results ===\n'
printf '%s\n' "${RESULTS[@]}"