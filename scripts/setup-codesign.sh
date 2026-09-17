#!/usr/bin/env bash
# Prepare a throwaway keychain holding the Developer ID Application certificate
# so scripts/build-binary.js can sign macOS binaries non-interactively, then
# export CSC_NAME (the signing identity) for it.
#
# Inputs (GitHub secrets, passed via step env):
#   CSC_LINK         — base64-encoded .p12 (certificate + private key)
#   CSC_KEY_PASSWORD — password for the .p12
#
# No-op when CSC_LINK is absent (forks, local runs): build-binary.js falls
# back to ad-hoc signing.
# With CSC_LINK set, only disposable GitHub-hosted runners are supported.
# The keychain search list and default must persist into the later build step;
# they are not restored when this script exits.
#
# Hardening lessons ported from kimchi-studio's .gitlab .mac-signing anchor:
#   * Import into OUR OWN keychain and allow it via
#     `security set-key-partition-list` — otherwise codesign blocks on an
#     invisible GUI authorization prompt and hangs forever (macOS 10.12+).
# Improvements over the GitLab version:
#   * Keychain lives under RUNNER_TEMP (auto-cleaned with the job workspace)
#     instead of a stable path in $HOME/Library/Keychains.
#   * The Developer ID G2 intermediate goes into our keychain too — no sudo,
#     no writes to the shared System keychain.
#   * Identity is resolved and validated immediately, so a bad password or an
#     unexpected certificate fails this step instead of the build step.
set -euo pipefail

if [ -z "${CSC_LINK:-}" ]; then
	echo "CSC_LINK not set — macOS binaries will be ad-hoc signed."
	exit 0
fi

if [ "${RUNNER_ENVIRONMENT:-}" != "github-hosted" ]; then
	echo "Developer ID setup requires a disposable GitHub-hosted runner; it changes user keychain state without restoring it." >&2
	exit 1
fi

RUNNER_TEMP="${RUNNER_TEMP:-$(mktemp -d)}"
KEYCHAIN="$RUNNER_TEMP/kimchi-signing.keychain-db"
KEYCHAIN_PW=$(openssl rand -hex 16)

security create-keychain -p "$KEYCHAIN_PW" "$KEYCHAIN"
# Keep the keychain unlocked for the whole job (6h) regardless of build time.
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PW" "$KEYCHAIN"
security list-keychains -d user -s "$KEYCHAIN" login.keychain-db
security default-keychain -s "$KEYCHAIN"

P12_PATH="$RUNNER_TEMP/developer-id.p12"
G2_PATH="$RUNNER_TEMP/DeveloperIDG2CA.cer"
trap 'rm -f "$P12_PATH" "$G2_PATH"' EXIT

echo "$CSC_LINK" | base64 -D -o "$P12_PATH"
security import "$P12_PATH" -k "$KEYCHAIN" -P "${CSC_KEY_PASSWORD:?CSC_KEY_PASSWORD is required when CSC_LINK is set}" -A -T /usr/bin/codesign -T /usr/bin/security
rm -f "$P12_PATH"

# Allow codesign (and its Apple helper tools) to use the imported private key
# without a GUI prompt. Output muted — it echoes the partition list.
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PW" "$KEYCHAIN" >/dev/null

# Developer ID G2 intermediate certificate, for chain building during
# verification. Import is idempotent (duplicate import errors are tolerated).
curl -fsSL -o "$G2_PATH" "https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer"
security import "$G2_PATH" -k "$KEYCHAIN" -A || true
rm -f "$G2_PATH"

# Require exactly one Developer ID Application identity; fail fast otherwise.
IDENTITIES=$(security find-identity -v -p codesigning "$KEYCHAIN")
MATCHES=$(awk '/Developer ID Application/ {count++} END {print count+0}' <<< "$IDENTITIES")
if [ "$MATCHES" -ne 1 ]; then
	echo "Expected exactly one 'Developer ID Application' identity after import, found $MATCHES — check CSC_LINK/CSC_KEY_PASSWORD." >&2
	printf '%s\n' "$IDENTITIES" >&2
	exit 1
fi
IDENTITY=$(awk -F '"' '/Developer ID Application/ {print $2}' <<< "$IDENTITIES")

echo "Signing identity: $IDENTITY"
if [ -n "${GITHUB_ENV:-}" ]; then
	echo "CSC_NAME=$IDENTITY" >>"$GITHUB_ENV"
else
	echo "CSC_NAME=$IDENTITY"
fi
