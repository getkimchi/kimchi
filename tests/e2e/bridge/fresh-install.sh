#!/usr/bin/env bash
# Chunk F — fresh install scenarios (plan §4). Each scenario runs in its own
# sandbox; a failing assertion fails that scenario only and we report all.
set -uo pipefail
cd "$(dirname "$0")"
source ./sandbox.sh

RESULTS=()
run_f1() {
  new_sandbox
  export PATH="$(sandbox_path)"
  install_kimchi "$E2E_LATEST"
  assert_file "$SAND/bin/kimchi" "kimchi binary installed"
  assert_eq "kimchi runs" "1.22.0" "$("$SAND/bin/kimchi" --version 2>/dev/null | head -1)"
  assert_eq "bundled bridge version" "v0.1.0-rc.8" "$(b_bundled_version)"
  assert_no_file "$(b_prefix)/installed/claude" "no claude receipt (no client)"
  assert_no_file "$(b_prefix)/installed/codex" "no codex receipt (no client)"
  assert_no_file "$(b_bin)" "no kimchi-bridge CLI (no client)"
  assert_no_file "$(b_prefix)/install.lock" "no install.lock left"
  teardown_sandbox
}

run_f2() {
  new_sandbox
  export PATH="$(sandbox_path claude)"
  install_kimchi "$E2E_LATEST"
  local market; market="$(b_market claude)"
  assert_eq "claude receipt == bundled market" "$market" "$(b_receipt claude)"
  assert_eq "code marker == version" "v0.1.0-rc.8" "$(b_code_marker)"
  assert_no_file "$(b_prefix)/installed/codex" "no codex receipt (codex absent)"
  assert_symlink "$(b_prefix)/current.mjs" "current.mjs symlink"
  assert_eq "current.mjs -> rc.8 lib" "$(b_prefix)/releases/v0.1.0-rc.8/lib/kimchi-bridge.mjs" "$(b_current_target)"
  assert_eq "runtime -> sandbox kimchi" "$SAND/bin/kimchi" "$(b_runtime_target)"
  assert_symlink "$(b_bin)" "bridge CLI symlink"
  assert_eq "bridge CLI -> rc.8 shim" "$(b_prefix)/releases/v0.1.0-rc.8/bin/kimchi-bridge" "$(readlink "$(b_bin)")"
  assert_file "$(b_prefix)/releases/v0.1.0-rc.8/lib/kimchi-bridge.mjs" "rc.8 package copied"
  assert_no_file "$(b_prefix)/install.lock" "no install.lock left"
  local listed; listed="$(claude plugin list 2>&1)"
  case "$listed" in *"kimchi-work@$market"*) pass "claude plugin registered + enabled" ;; *) fail "claude plugin registration: $listed" ;; esac
  teardown_sandbox
}

run_f3() {
  new_sandbox
  export PATH="$(sandbox_path codex)"
  install_kimchi "$E2E_LATEST"
  local market; market="$(b_market codex)"
  assert_eq "codex receipt == bundled market" "$market" "$(b_receipt codex)"
  assert_eq "code marker == version" "v0.1.0-rc.8" "$(b_code_marker)"
  assert_no_file "$(b_prefix)/installed/claude" "no claude receipt (claude absent)"
  local listed; listed="$(codex plugin list --json 2>&1)"
  case "$listed" in
    *"kimchi-work@$market"*) pass "codex plugin installed" ;;
    *) fail "codex plugin registration: $listed" ;;
  esac
  case "$listed" in *'"enabled": true'*) pass "codex plugin enabled" ;; *) fail "codex plugin not enabled: $listed" ;; esac
  teardown_sandbox
}

run_f4() {
  new_sandbox
  export PATH="$(sandbox_path claude codex)"
  install_kimchi "$E2E_LATEST"
  assert_eq "claude receipt" "$(b_market claude)" "$(b_receipt claude)"
  assert_eq "codex receipt" "$(b_market codex)" "$(b_receipt codex)"
  assert_eq "code marker == version (both registered)" "v0.1.0-rc.8" "$(b_code_marker)"
  assert_eq "one release dir" "v0.1.0-rc.8" "$(ls "$(b_prefix)/releases" | tr '\n' ' ' | tr -d ' ')"
  assert_no_file "$(b_prefix)/install.lock" "no install.lock left"
  teardown_sandbox
}

run_f5() {
  new_sandbox
  export PATH="$(sandbox_path claude codex)"
  install_kimchi "$E2E_LATEST"
  local c1 c2 market
  c1="$(b_receipt claude)"; c2="$(b_receipt codex)"; market="$(b_market claude)"
  # Second run: same bundle, same wiring -> no re-registration.
  install_kimchi "$E2E_LATEST"
  assert_eq "claude receipt unchanged" "$c1" "$(b_receipt claude)"
  assert_eq "codex receipt unchanged" "$c2" "$(b_receipt codex)"
  assert_eq "code marker unchanged" "v0.1.0-rc.8" "$(b_code_marker)"
  assert_eq "one release dir still" "v0.1.0-rc.8" "$(ls "$(b_prefix)/releases" | tr '\n' ' ' | tr -d ' ')"
  assert_no_file "$(b_prefix)/install.lock" "no install.lock left"
  local listed; listed="$(claude plugin list 2>&1)"
  case "$listed" in *"kimchi-work@$market"*) pass "claude still registered once" ;; *) fail "claude registration changed: $listed" ;; esac
  teardown_sandbox
}

run_f6() {
  new_sandbox
  export PATH="$(sandbox_path claude codex)"
  local out
  out="$(SUDO_USER=root install_kimchi "$E2E_LATEST" 2>&1)"
  assert_no_file "$(b_prefix)/installed/claude" "no claude receipt under sudo"
  assert_no_file "$(b_prefix)/installed/codex" "no codex receipt under sudo"
  assert_no_file "$(b_bin)" "no bridge CLI under sudo"
  case "$out" in *"Skipping Kimchi work reporting under sudo"*) pass "sudo skip warning printed" ;; *) fail "sudo skip warning missing: $out" ;; esac
  assert_file "$SAND/bin/kimchi" "kimchi itself still installed"
  teardown_sandbox
}

run_f7() {
  new_sandbox
  export PATH="$(sandbox_path claude)"
  install_kimchi "$E2E_LATEST"
  assert_eq "claude receipt present" "$(b_market claude)" "$(b_receipt claude)"
  assert_no_file "$(b_prefix)/installed/codex" "codex not yet registered"
  # Install codex later, re-run the installer (documented flow).
  export PATH="$(sandbox_path claude codex)"
  install_kimchi "$E2E_LATEST"
  assert_eq "claude receipt unchanged" "$(b_market claude)" "$(b_receipt claude)"
  assert_eq "codex receipt now present" "$(b_market codex)" "$(b_receipt codex)"
  assert_eq "code marker == version" "v0.1.0-rc.8" "$(b_code_marker)"
  teardown_sandbox
}

run_f8() {
  new_sandbox
  export PATH="$(sandbox_path claude codex)"
  export KIMCHI_INSTALL_DIR="$SAND/altbin"
  install_kimchi "$E2E_LATEST"
  assert_file "$SAND/altbin/kimchi" "kimchi in custom install dir"
  assert_file "$SAND/data/kimchi/bridge/VERSION" "share in XDG_DATA_HOME/kimchi"
  assert_eq "claude receipt" "$(b_market claude)" "$(b_receipt claude)"
  assert_eq "code marker" "v0.1.0-rc.8" "$(b_code_marker)"
  teardown_sandbox
}

run_f9() {
  new_sandbox
  export PATH="$(sandbox_path claude codex)"
  # The genuine curl | bash flow (pinned version): the script arrives on stdin.
  KIMCHI_VERSION="$E2E_LATEST" KIMCHI_REPO_OVERRIDE="getkimchi/kimchi" \
    bash -s < <(curl -fsSL "https://github.com/getkimchi/kimchi/releases/latest/download/install.sh")
  assert_file "$SAND/bin/kimchi" "kimchi installed via real installer"
  assert_eq "claude receipt" "$(b_market claude)" "$(b_receipt claude)"
  assert_eq "codex receipt" "$(b_market codex)" "$(b_receipt codex)"
  assert_eq "code marker" "v0.1.0-rc.8" "$(b_code_marker)"
  assert_no_file "$(b_prefix)/install.lock" "no install.lock left"
  teardown_sandbox
}

run_f10() {
  # Degenerate bundles: (a) release without share/kimchi/bridge, (b) without bin/kimchi.
  local nb="$E2E_FIXTURES/v1.22.0-nobridge"
  if [ ! -d "$nb" ]; then
    cp -R "$E2E_FIXTURES/$E2E_LATEST" "$nb.tmp" && rm -rf "$nb.tmp/share/kimchi/bridge" && mv "$nb.tmp" "$nb"
  fi
  new_sandbox
  export PATH="$(sandbox_path claude codex)"
  local saved="$E2E_LATEST"; E2E_LATEST=v1.22.0-nobridge
  install_kimchi v1.22.0-nobridge
  E2E_LATEST="$saved"
  assert_file "$SAND/bin/kimchi" "kimchi installed (no bridge in release)"
  assert_no_file "$(b_prefix)/installed/claude" "no bridge artifacts when bundle lacks bridge"
  assert_no_file "$(b_prefix)/installed/codex" "no bridge artifacts when bundle lacks bridge"
  assert_no_file "$(b_bin)" "no bridge CLI when bundle lacks bridge"
  teardown_sandbox

  local nbin="$E2E_FIXTURES/v1.22.0-nobin"
  if [ ! -d "$nbin" ]; then
    cp -R "$E2E_FIXTURES/$E2E_LATEST" "$nbin.tmp" && rm -f "$nbin.tmp/bin/kimchi" && mv "$nbin.tmp" "$nbin"
  fi
  new_sandbox
  export PATH="$(sandbox_path)"
  # fixture() exits 1 on a missing binary, so probe it inside a subshell so
  # the exit is caught by the if, not by the runner's set -e.
  if ( fixture v1.22.0-nobin ) >/dev/null 2>&1; then
    fail "missing bin/kimchi should fail cleanly"
  else
    pass "missing bin/kimchi fails cleanly"
  fi
  teardown_sandbox
}

SCENARIOS=( "F1:run_f1" "F2:run_f2" "F3:run_f3" "F4:run_f4" "F5:run_f5" "F6:run_f6" "F7:run_f7" "F8:run_f8" "F9:run_f9" "F10:run_f10" )
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
printf '\n=== F-chunk results ===\n'
printf '%s\n' "${RESULTS[@]}"