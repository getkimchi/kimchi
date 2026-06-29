#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

echo -e "${GREEN}🚀 Starting Kimchi dev environment setup...${NC}"

# Check if Homebrew is installed
if ! command -v brew &> /dev/null; then
    echo -e "${YELLOW}⚠️  Homebrew not found. Please install Homebrew first:${NC}"
    echo "   /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
    exit 1
fi

# Install node and pnpm via brew (skip if already installed)
echo -e "${GREEN}📦 Checking node and pnpm...${NC}"

if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}   Installing node...${NC}"
    brew install node
else
    echo -e "${GREEN}   ✓ node already installed ($(node --version))${NC}"
fi

if ! command -v pnpm &> /dev/null; then
    echo -e "${YELLOW}   Installing pnpm...${NC}"
    brew install pnpm
else
    echo -e "${GREEN}   ✓ pnpm already installed ($(pnpm --version))${NC}"
fi

# Initialize submodules
echo -e "${GREEN}📦 Initializing git submodules...${NC}"
git submodule update --init --recursive

# Install dependencies
echo -e "${GREEN}📦 Installing dependencies with pnpm...${NC}"
pnpm install

# Install bun if not present
echo -e "${GREEN}📦 Checking bun...${NC}"
BUN_JUST_INSTALLED=false
if ! command -v bun &> /dev/null; then
    echo -e "${YELLOW}   Installing bun...${NC}"
    curl -fsSL https://bun.sh/install | bash
    BUN_JUST_INSTALLED=true
else
    echo -e "${GREEN}   ✓ bun already installed ($(bun --version))${NC}"
fi

# Always ensure bun is in PATH for this session
export PATH="$HOME/.bun/bin:$PATH"

# Copy resources
echo -e "${GREEN}📂 Copying resources...${NC}"
node ./scripts/copy-resources.js --dev

# Start the harness
echo -e "${GREEN}🎯 Starting Kimchi harness...${NC}"
pnpm run dev "$@"

# Remind user to add bun to shell profile if it was just installed
if [ "$BUN_JUST_INSTALLED" = true ]; then
    echo ""
    echo -e "${YELLOW}⚠️  Important: bun was just installed. To use it in future terminal sessions,${NC}"
    echo -e "${YELLOW}   add the following line to your shell profile:${NC}"
    echo ""
    echo -e "   ${GREEN}export PATH=\"\$HOME/.bun/bin:\$PATH\"${NC}"
    echo ""
    echo -e "   ${YELLOW}Shell profile locations:${NC}"
    echo -e "   • bash: ~/.bashrc or ~/.bash_profile"
    echo -e "   • zsh:  ~/.zshrc"
fi
