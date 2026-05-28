#!/usr/bin/env bash
#
# Install the kimchi coding-harness CLI from the latest GitHub release.
#
# Usage:
#   curl -fsSL https://github.com/castai/kimchi/releases/latest/download/install.sh | bash
#
# Optional env:
#   KIMCHI_INSTALL_DIR  Override install dir. Defaults to /usr/local/bin if
#                      writable, else $HOME/.local/bin (with a PATH hint).
#   KIMCHI_VERSION      Pin a specific version tag (e.g. v0.2.0). Defaults
#                      to "latest", which resolves to the GitHub "Latest
#                      release" pointer.

set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
NC='\033[0m'

REPO="${KIMCHI_REPO_OVERRIDE:-castai/kimchi}"
VERSION="${KIMCHI_VERSION:-latest}"

echo -e "${BLUE}Installing Kimchi from ${REPO}${VERSION:+ (${VERSION})}…${NC}"

# Detect OS.
OS_RAW="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$OS_RAW" in
darwin*) OS="darwin" ;;
linux*) OS="linux" ;;
*)
	echo -e "${RED}Unsupported OS: $OS_RAW${NC}" >&2
	echo "Windows: download the .zip from https://github.com/${REPO}/releases" >&2
	exit 1
	;;
esac

# Detect architecture.
ARCH_RAW="$(uname -m)"
case "$ARCH_RAW" in
x86_64 | amd64) ARCH="amd64" ;;
aarch64 | arm64) ARCH="arm64" ;;
*)
	echo -e "${RED}Unsupported architecture: $ARCH_RAW${NC}" >&2
	exit 1
	;;
esac

# Resolve the download URL. For "latest" we use GitHub's redirect alias;
# for a pinned tag we go straight to the release.
if [ "$VERSION" = "latest" ]; then
	BINARY_URL="https://github.com/${REPO}/releases/latest/download/kimchi_${OS}_${ARCH}.tar.gz"
else
	BINARY_URL="https://github.com/${REPO}/releases/download/${VERSION}/kimchi_${OS}_${ARCH}.tar.gz"
fi

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

echo -e "${BLUE}Downloading kimchi for ${OS}/${ARCH}…${NC}"
if ! curl -fsSL "$BINARY_URL" | tar -xzf - -C "$TEMP_DIR"; then
	echo -e "${RED}Failed to download kimchi from $BINARY_URL${NC}" >&2
	echo "Please check that the release exists at:" >&2
	echo "  https://github.com/${REPO}/releases" >&2
	exit 1
fi

# The release tarball contains bin/kimchi and share/kimchi/.
if [ ! -f "$TEMP_DIR/bin/kimchi" ]; then
	echo -e "${RED}Archive did not contain a 'bin/kimchi' binary.${NC}" >&2
	exit 1
fi
chmod +x "$TEMP_DIR/bin/kimchi"

# Pick install dir. Allow override; otherwise prefer /usr/local/bin if we
# can write to it (system-wide install), else fall back to ~/.local/bin
# (user install) and remind the user to ensure it's on PATH.
if [ -n "${KIMCHI_INSTALL_DIR:-}" ]; then
	INSTALL_DIR="$KIMCHI_INSTALL_DIR"
	DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
	NEEDS_PATH_SETUP="maybe"
elif [ -w /usr/local/bin ]; then
	INSTALL_DIR="/usr/local/bin"
	DATA_DIR="/usr/local/share"
	NEEDS_PATH_SETUP="no"
else
	INSTALL_DIR="$HOME/.local/bin"
	DATA_DIR="$HOME/.local/share"
	NEEDS_PATH_SETUP="yes"
fi

mkdir -p "$INSTALL_DIR"
INSTALL_PATH="$INSTALL_DIR/kimchi"
mv "$TEMP_DIR/bin/kimchi" "$INSTALL_PATH"

# Install share files (themes, export templates, etc.) if present.
if [ -d "$TEMP_DIR/share/kimchi" ]; then
	mkdir -p "$DATA_DIR"
	rm -rf "$DATA_DIR/kimchi"
	mv "$TEMP_DIR/share/kimchi" "$DATA_DIR/kimchi"
fi

echo ""
echo -e "${GREEN}✓ Installed kimchi to ${INSTALL_PATH}${NC}"

# Returns 0 if the install dir is already on PATH or present in an active
# (non-commented) line in the rc file, or if we already wrote our marker.
path_already_configured() {
	local rc="$1" dir="$2"
	case ":${PATH}:" in
	*":${dir}:"*) return 0 ;;
	esac
	[ -f "$rc" ] || return 1
	grep -qF "# Kimchi CLI" "$rc" && return 0
}

# Writes the PATH export line to the rc file if not already present.
add_to_path() {
	local rc="$1" dir="$2"
	if path_already_configured "$rc" "$dir"; then
		return
	fi
	echo ""
	echo -e "${YELLOW}Note: ${dir} is not on your PATH.${NC}"
	printf '\n# Kimchi CLI\nexport PATH="%s:$PATH"\n' "$dir" >> "$rc"
	echo -e "${GREEN}✓ Added ${dir} to PATH in ${rc}${NC}"
	echo -e "${YELLOW}  Restart your shell or run: source ${rc}${NC}"
}

# PATH setup when we landed somewhere a fresh shell may not see.
if [ "$NEEDS_PATH_SETUP" = "yes" ] || { [ "$NEEDS_PATH_SETUP" = "maybe" ] && ! command -v kimchi >/dev/null 2>&1; }; then
	case "${SHELL:-}" in
	*/fish*)
		echo ""
		echo -e "${YELLOW}Note: ${INSTALL_DIR} is not on your PATH.${NC}"
		echo "  Run: fish_add_path ${INSTALL_DIR}"
		;;
	*/zsh*)
		add_to_path "$HOME/.zshrc" "$INSTALL_DIR"
		;;
	*/bash*)
		# macOS bash sources .bash_profile for login shells; Linux uses .bashrc.
		case "$OS" in
		darwin) RC="$HOME/.bash_profile" ;;
		*)      RC="$HOME/.bashrc" ;;
		esac
		add_to_path "$RC" "$INSTALL_DIR"
		;;
	*)
		echo ""
		echo -e "${YELLOW}Note: ${INSTALL_DIR} is not on your PATH.${NC}"
		echo "  Add ${INSTALL_DIR} to your PATH in your shell's config file."
		;;
	esac
fi

echo ""
echo -e "${BLUE}Next:${NC} run ${GREEN}kimchi setup${NC} to configure your API key and migrate your skills and MCPs,"
echo -e "      or just ${GREEN}kimchi${NC} to launch the coding harness."
