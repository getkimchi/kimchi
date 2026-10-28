#!/usr/bin/env bash
# kimchi-bridge e2e — sandbox + assertion helpers (source me, don't execute).
#
# Every scenario runs in an isolated $HOME sandbox so the bridge prefix, bridge
# state, ~/.claude and ~/.codex all stay contained. Release assets are real
# GitHub tarballs downloaded once into $E2E_FIXTURES and replayed per scenario
# (the real `curl | bash` path is exercised end-to-end by the --real scenarios).
set -euo pipefail

E2E_FIXTURES="${E2E_FIXTURES:-/tmp/kimchi-e2e-fixtures}"
E2E_RUNS="${E2E_RUNS:-/tmp/kimchi-e2e-runs}"
E2E_LATEST="${E2E_LATEST:-v1.22.0}"
# Synthetic "old" kimchi: the real v1.21.6 binary + the real rc.5 bridge
# package grafted into its share. The binary must be older than E2E_LATEST so
# `kimchi update v1.22.0` actually applies; v1.21.6 predates bridge bundling,
# so the bridge dir is grafted (see fixture_synth_old).
E2E_OLD="${E2E_OLD:-v1.21.6-rc5bridge}"
CLAUDE_BIN="${CLAUDE_BIN:-/Applications/cmux.app/Contents/Resources/bin/claude}"
# The cmux wrapper passes through to the real claude elsewhere on PATH; the
# sandbox PATH must include that dir too (see ISSUES.md IS-8).
CLAUDE_REAL_DIR="${CLAUDE_REAL_DIR:-/opt/homebrew/bin}"
CODEX_BIN="${CODEX_BIN:-$HOME/.nvm/versions/node/v24.16.0/bin/codex}"
# The real rc.5 package source for the synthetic old fixture. Resolved against
# the REAL home at source time: scenarios sandbox HOME before running.
RC5_PACKAGE="${RC5_PACKAGE:-$HOME/.local/share/kimchi-bridge/releases/v0.1.0-rc.5}"
mkdir -p "$E2E_FIXTURES" "$E2E_RUNS"

PASSES=()
FAILURES=()
SAND=""
SCENARIO=""

fail() { printf 'FAIL|%s|%s\n' "$SCENARIO" "$1" >&2; FAILURES+=("$SCENARIO: $1"); exit 1; }
pass() { printf 'PASS|%s|%s\n' "$SCENARIO" "$1"; PASSES+=("$1"); }

# assert <name> <command...>: run command, PASS if exit 0 and stdout non-empty
assert() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi
}
assert_eq() { local name="$1" expected="$2" actual="$3"; if [ "$expected" = "$actual" ]; then pass "$name"; else fail "$name (expected '$expected', got '$actual')"; fi; }
assert_file() { if [ -f "$1" ]; then pass "$2"; else fail "$2 ($1 missing)"; fi; }
assert_symlink() { if [ -L "$1" ]; then pass "$2"; else fail "$2 ($1 not a symlink)"; fi; }
assert_no_file() { if [ ! -e "$1" ]; then pass "$2"; else fail "$2 ($1 unexpectedly exists)"; fi; }

# new_sandbox: fresh isolated HOME
new_sandbox() {
  SAND="$(mktemp -d "$E2E_RUNS/sandbox.XXXXXX")"
  mkdir -p "$SAND/home" "$SAND/data" "$SAND/state" "$SAND/config" "$SAND/bin"
  export HOME="$SAND/home"
  export XDG_DATA_HOME="$SAND/data" XDG_STATE_HOME="$SAND/state" XDG_CONFIG_HOME="$SAND/config"
  export KIMCHI_INSTALL_DIR="$SAND/bin"
  # $HOME/.local/bin is where the bridge CLI lands (HOME is sandboxed).
  mkdir -p "$HOME/.local/bin"
}
teardown_sandbox() { rm -rf "$SAND"; SAND=""; }

# sandbox_path [claude] [codex]: build the scenario PATH — sandbox bin + the
# requested real clients (+ the sandboxed bridge CLI dir) + system dirs.
sandbox_path() {
  local dirs=("$SAND/bin" "$HOME/.local/bin")
  for c in "$@"; do
    case "$c" in
      claude) dirs+=("$(dirname "$CLAUDE_BIN")" "$CLAUDE_REAL_DIR") ;;
      codex)  dirs+=("$(dirname "$CODEX_BIN")") ;;
    esac
  done
  local IFS=:
  echo "${dirs[*]}:/usr/bin:/bin:/usr/sbin:/sbin"
}

# fixture <version>: ensure the release tarball is downloaded and extracted.
fixture() {
  local v="$1"
  local file="$E2E_FIXTURES/$v.tar.gz"
  local dir="$E2E_FIXTURES/$v"
  if [ ! -d "$dir" ]; then
    [ -f "$file" ] || curl -fsSL "https://github.com/getkimchi/kimchi/releases/download/$v/kimchi_darwin_arm64.tar.gz" -o "$file"
    mkdir -p "$dir"
    tar -xzf "$file" -C "$dir" --strip-components=1 2>/dev/null || { rm -rf "$dir"; mkdir -p "$dir"; tar -xzf "$file" -C "$dir"; }
    # Normalize a possible top-level folder (archives that strip a prefix dir).
    if [ ! -d "$dir/bin" ] && [ -d "$dir"/*/bin ]; then
      local sub; sub=$(cd "$dir" && find . -maxdepth 2 -type d -name bin | head -1)
      [ -n "$sub" ] && { rm -rf "$dir/.stage"; mkdir -p "$dir/.stage"; mv "$dir"/* "$dir/.stage/"; mv "$dir/.stage"/*/* "$dir/"; rm -rf "$dir/.stage"; }
    fi
  fi
  [ -f "$dir/bin/kimchi" ] && chmod +x "$dir/bin/kimchi" || { echo "fixture $v missing bin/kimchi" >&2; exit 1; }
}

# fixture_synth_old: build "v1.21.6-rc5bridge" — the older release with the
# real rc.5 bridge package grafted into its share. The binary (1.21.6) is older
# than E2E_LATEST so the real update applies; v1.21.6 has no bridge dir of its
# own, and rc.5 predates the packaged tarball format, so the package comes from
# an installed rc.5 release dir (override with RC5_PACKAGE).
fixture_synth_old() {
  local src="$RC5_PACKAGE"
  fixture v1.21.6
  local out="$E2E_FIXTURES/$E2E_OLD"
  if [ ! -d "$out" ]; then
    [ -f "$src/VERSION" ] && [ -f "$src/install.sh" ] || { echo "rc.5 package missing at $src" >&2; exit 1; }
    rm -rf "$out"; cp -R "$E2E_FIXTURES/v1.21.6" "$out"
    rm -rf "$out/share/kimchi/bridge"
    cp -R "$src" "$out/share/kimchi/bridge"
  fi
  [ "$(cat "$out/share/kimchi/bridge/VERSION")" = "v0.1.0-rc.5" ] || { echo "synthetic old fixture invalid" >&2; exit 1; }
  [ "$("$out/bin/kimchi" --version)" = "1.21.6" ] || { echo "synthetic old binary wrong version" >&2; exit 1; }
}

# install_kimchi <version> [--real]: replay the fixture into the sandbox exactly
# as scripts/install.sh does (extract, mv bin, mv share, bridge installer per
# client on PATH). --real runs the actual installer end-to-end instead.
# The scenario controls PATH (sandbox_path) so `command -v claude` etc. match
# the scenario's client list.
install_kimchi() {
  local v="$1" real="${2:-}"
  fixture "$v"
  if [ -n "$real" ]; then
    # Real curl | bash: pinned version, sandbox dirs.
    KIMCHI_VERSION="$v" KIMCHI_REPO_OVERRIDE="getkimchi/kimchi" \
      bash <(curl -fsSL "https://github.com/getkimchi/kimchi/releases/latest/download/install.sh") </dev/null
    return $?
  fi
  rm -rf "$SAND/bin/kimchi" "$SAND/data/kimchi"
  local bindir="${KIMCHI_INSTALL_DIR:-$SAND/bin}"
  local data_dir="${XDG_DATA_HOME:-$SAND/data}"
  mkdir -p "$bindir" "$data_dir"
  cp "$E2E_FIXTURES/$v/bin/kimchi" "$bindir/kimchi"
  chmod +x "$bindir/kimchi"
  if [ -d "$E2E_FIXTURES/$v/share/kimchi" ]; then
    cp -R "$E2E_FIXTURES/$v/share/kimchi" "$data_dir/kimchi"
  fi
  # Faithful replay of install.sh's bridge section (incl. the sudo skip and
  # the </dev/null stdin + KIMCHI_BIN override).
  local installer="$data_dir/kimchi/bridge/install.sh"
  if [ -f "$installer" ]; then
    if [ -n "${SUDO_USER:-}" ]; then
      printf '\033[0;33mSkipping Kimchi work reporting under sudo. Rerun this installer without sudo to add it to Claude Code and Codex.\033[0m\n' >&2
    else
      for client in claude codex; do
        command -v "$client" >/dev/null 2>&1 || continue
        KIMCHI_BIN="$bindir/kimchi" bash "$installer" install "$client" </dev/null
      done
    fi
  fi
}

# run_bridge_installer <install|update|uninstall|status> <claude|codex|both>
run_bridge_installer() {
  local installer="$SAND/data/kimchi/bridge/install.sh"
  KIMCHI_BIN="$SAND/bin/kimchi" bash "$installer" "$1" "$2" </dev/null
}

# --- bridge state helpers (run inside a sandbox; HOME is sandboxed per
# scenario, so paths must be resolved lazily, not at source time) ---
b_prefix() { echo "$HOME/.local/share/kimchi-bridge"; }
b_bin() { echo "$HOME/.local/bin/kimchi-bridge"; }
b_receipt() { cat "$(b_prefix)/installed/$1" 2>/dev/null || true; }
b_code_marker() { cat "$(b_prefix)/installed/code" 2>/dev/null || true; }
b_current_target() { readlink "$(b_prefix)/current.mjs" 2>/dev/null || true; }
b_runtime_target() { readlink "$(b_prefix)/runtime" 2>/dev/null || true; }
b_bundled_version() { cat "$SAND/data/kimchi/bridge/VERSION" 2>/dev/null || true; }
b_market() { cat "$SAND/data/kimchi/bridge/markets/$1" 2>/dev/null || true; }