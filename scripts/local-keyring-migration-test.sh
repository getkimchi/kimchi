#!/usr/bin/env bash
# Manual local test for the MCP OAuth keychain service rename + migration.
# macOS only — this exercises the REAL login keychain (no file-backed test
# double), unlike the unit/e2e suites which use KIMCHI_MCP_E2E_KEYRING_DIR.
#
# What it verifies end-to-end with a locally built (or installed) binary:
#   1. A legacy-service credential (pi-mcp-adapter.oauth, as created by older
#      kimchi builds or other pi-mcp-adapter consumers) is copied to the
#      kimchi-owned service (dev.kimchi.mcp.oauth) when the server is probed.
#   2. The legacy entry is preserved, byte-for-byte.
#   3. A second run leaves the migrated credential unchanged (idempotent).
#
# Usage:
#   pnpm run build:binary                       # or let the script build it
#   ./scripts/local-keyring-migration-test.sh   # uses dist/bin/kimchi
#   ./scripts/local-keyring-migration-test.sh "$(command -v kimchi)"   # test an installed release
#
# To also see the real one-time macOS keychain prompt this rename limits,
# run with PROMPT_DEMO=1: the seeded legacy item then has no pre-trusted
# app, so the probe's first legacy read shows the "kimchi wants to access
# keychain item …" dialog. Click Always Allow to let the migration proceed.
#
# The test uses a unique server name per run, so it never collides with real
# credentials, and it deletes both keychain items it created on exit.
#
# NOTE: the probe intentionally runs with the real $HOME — on macOS the
# keyring resolves the login keychain through it, so an isolated HOME would
# make the real keychain (and the seeded legacy item) invisible to the run.
# The e2e suites can isolate HOME only because they use the file-backed
# KIMCHI_MCP_E2E_KEYRING_DIR test double.

set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
	echo "This test exercises the macOS keychain and only runs on Darwin." >&2
	exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BINARY="${1:-$REPO_ROOT/dist/bin/kimchi}"
if [ ! -x "$BINARY" ]; then
	echo "kimchi binary not found at $BINARY — building…" >&2
	(cd "$REPO_ROOT" && pnpm run build:binary)
fi
BINARY="$(cd "$(dirname "$BINARY")" && pwd)/$(basename "$BINARY")"

NEW_SERVICE="dev.kimchi.mcp.oauth"
LEGACY_SERVICE="pi-mcp-adapter.oauth"
SERVER_NAME="kimchi-local-test-$(date +%s)"
ACCOUNT="sha256-$(printf '%s' "$SERVER_NAME" | shasum -a 256 | cut -d' ' -f1)"
# Closed local port: the probe fails fast, but only after the keychain
# service migration has already run.
SERVER_URL="http://127.0.0.1:9/mcp"
PAYLOAD="$(printf '{"serverUrl":"%s","tokens":{"accessToken":"local-test-token"}}' "$SERVER_URL")"

WORK_DIR=""

cleanup() {
	security delete-generic-password -s "$NEW_SERVICE" -a "$ACCOUNT" >/dev/null 2>&1 || true
	security delete-generic-password -s "$LEGACY_SERVICE" -a "$ACCOUNT" >/dev/null 2>&1 || true
	[ -n "$WORK_DIR" ] && rm -rf "$WORK_DIR"
}
trap cleanup EXIT

# Read an MCP OAuth credential through the binary's own recovery helper.
# The helper goes through the same remapping Entry as the adapter, so the
# new service reads the real keychain as the binary itself (no ACL prompt).
helper_read_value() {
	printf '{"operation":"read","service":"%s","account":"%s"}' "$1" "$ACCOUNT" \
		| "$BINARY" mcp-keyring-helper \
		| node -e 'const out = JSON.parse(require("node:fs").readFileSync(0, "utf8")); if (!out.ok) process.exit(1); process.stdout.write(out.found ? out.value : "")'
}

# Read a keychain item as /usr/bin/security, which created the legacy item
# (the creator is always allowed to read it back).
security_read_value() {
	security find-generic-password -s "$1" -a "$2" -w 2>/dev/null || true
}

run_probe() {
	(
		cd "$WORK_DIR"
		printf '{"name":"%s","server":{"url":"%s"}}' "$SERVER_NAME" "$SERVER_URL" \
			| env -u KIMCHI_MCP_E2E_KEYRING_DIR PATH="$PATH" KIMCHI_NO_UPDATE_CHECK=1 \
				"$BINARY" mcp probe --json >/dev/null 2>&1 || true
	)
}

echo "→ seeding legacy credential (service=$LEGACY_SERVICE account=$SERVER_NAME)"
if [ -n "${PROMPT_DEMO:-}" ]; then
	echo "  (PROMPT_DEMO: no pre-trusted app — expect one macOS keychain prompt on the first probe; click Always Allow)"
	security add-generic-password -s "$LEGACY_SERVICE" -a "$ACCOUNT" -w "$PAYLOAD" -U
else
	security add-generic-password -s "$LEGACY_SERVICE" -a "$ACCOUNT" -w "$PAYLOAD" -U -T "$BINARY"
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kimchi-keyring-test-work-XXXXXX")"

echo "→ first probe run"
run_probe

NEW_VALUE="$(helper_read_value "$NEW_SERVICE")"
if [ "$NEW_VALUE" != "$PAYLOAD" ]; then
	echo "✗ migration did not copy the credential to $NEW_SERVICE (got: ${NEW_VALUE:-<absent>})" >&2
	exit 1
fi
echo "✓ credential present under $NEW_SERVICE with identical payload"

LEGACY_VALUE="$(security_read_value "$LEGACY_SERVICE" "$ACCOUNT")"
if [ "$LEGACY_VALUE" != "$PAYLOAD" ]; then
	echo "✗ legacy entry was modified or deleted" >&2
	exit 1
fi
echo "✓ legacy entry preserved untouched"

echo "→ second probe run"
run_probe

if [ "$(helper_read_value "$NEW_SERVICE")" != "$PAYLOAD" ]; then
	echo "✗ second run changed the migrated credential" >&2
	exit 1
fi
echo "✓ second run is a no-op"

echo "✓ local keychain migration test passed (test items cleaned up)"
