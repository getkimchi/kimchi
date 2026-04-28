# Kimchi

**Configure your AI coding tools to use Kimchi's open-source models in seconds.**

[![Release](https://img.shields.io/github/v/release/castai/kimchi?include_prereleases)](https://github.com/castai/kimchi/releases)
[![License](https://img.shields.io/badge/license-Cast%20AI-blue)](LICENSE)
[![Go Report Card](https://goreportcard.com/badge/github.com/castai/kimchi)](https://goreportcard.com/report/github.com/castai/kimchi)

---

## What is Kimchi?

Kimchi is a CLI tool that configures your favorite AI coding assistants to use open-source models hosted by Kimchi:

| Model            | Role                   | Best For                                                          | Context | Output      |
|------------------|------------------------|-------------------------------------------------------------------|---------|-------------|
| **kimi-k2.5**    | Primary model          | Reasoning, planning, code generation, and image processing        | 262K tokens | 32K tokens  |
| **nemotron-3-super-fp4** | Coding subagent | Writing, refactoring, and debugging code                    | 1M tokens | 256K tokens |
| **minimax-m2.7** | Secondary subagent     | Code generation and debugging (available across all tools)        | 196.6K tokens | 32K tokens  |
| **nemotron-3-super-fp4** | Reasoning model | High-performance reasoning for complex tasks                | 1M tokens | 256K tokens |

No API keys from Anthropic or OpenAI needed — just your Kimchi API key.

---

## Quick Start

### One-Line Install

```bash
curl -fsSL https://github.com/castai/kimchi/releases/latest/download/install.sh | bash
```

This downloads and installs Kimchi. Run `kimchi` to launch the [Kimchi coding harness](https://github.com/castai/kimchi-dev), or `kimchi setup` to configure another AI tool.

### Manual Install

Download the latest release for your platform:

| Platform | Architecture | Download |
|----------|--------------|----------|
| macOS | Intel | `kimchi_darwin_amd64.tar.gz` |
| macOS | Apple Silicon | `kimchi_darwin_arm64.tar.gz` |
| Linux | x86_64 | `kimchi_linux_amd64.tar.gz` |
| Linux | ARM64 | `kimchi_linux_arm64.tar.gz` |

```bash
# Download and extract
curl -fsSL https://github.com/castai/kimchi/releases/latest/download/kimchi_linux_amd64.tar.gz | tar xzf -

# Make executable and move to PATH
chmod +x kimchi
sudo mv kimchi /usr/local/bin/
```

---

## Getting Started

### 1. Get Your API Key

1. Go to [app.kimchi.dev](https://app.kimchi.dev)
2. Create and copy your API key

### 2. Run Kimchi

Running `kimchi` launches the [Kimchi coding harness](https://github.com/castai/kimchi-dev) — a coding agent pre-wired to Kimchi's models. The harness binary is installed and kept up to date automatically alongside this CLI.

To configure another AI tool to use Kimchi instead, run:

```bash
kimchi setup
```

The interactive wizard will guide you through:

1. **Auth** — Enter and validate your Kimchi API key
2. **Detect Tools** — Automatically finds installed AI tools
3. **Select Tools** — Choose which tools to configure
4. **Scope** — Global (all projects) or project-specific
5. **GSD Setup** — Optional: Install Goal-Driven Development agents
6. **Configure** — Writes configuration files
7. **Done** — Ready to code!

---

## Supported Tools

| Tool | Description | Config File |
|------|-------------|-------------|
| [OpenCode](https://opencode.ai) | Agentic coding CLI | `~/.config/opencode/opencode.json` |
| [Claude Code](https://claude.ai/code) | Anthropic's coding agent | `~/.claude/settings.json` |
| [Codex](https://github.com/openai/codex) | OpenAI's coding CLI | `~/.codex/.env` |
| [Cursor](https://cursor.com) | AI-powered code editor | `state.vscdb` (SQLite) |
| [Windsurf](https://windsurf.com) | AI-powered IDE | `globalStorage/storage.json` |
| [Zed](https://zed.dev) | High-performance editor | `~/.zed/settings.json` |
| [Cline](https://cline.bot) | VS Code extension | `~/.cline/data/globalState.json` |
| [OpenClaw](https://openclaw.ai) | AI agent framework | `~/.openclaw/openclaw.json` |
| Generic | Environment variables | Prints to stdout |

---

## Usage

```bash
# Launch the Kimchi coding harness
kimchi

# Run the interactive wizard to configure other AI tools
kimchi setup

# Show version
kimchi version

# Update to the latest version
kimchi update

# Enable debug output
kimchi --debug

# Generate shell completion
kimchi completion bash > /etc/bash_completion.d/kimchi
kimchi completion zsh > "${fpath[1]}/_kimchi"
kimchi completion fish > ~/.config/fish/completions/kimchi.fish
```

---

## How It Works

Kimchi configures each tool to use Kimchi's inference endpoint:

```
Your AI Tool ──► Kimchi Config ──► Kimchi Endpoint ──► Open-Source Models
                                        │
                                        ▼
                               https://llm.kimchi.dev
```

**Configuration Example (OpenCode):**

```json
{
  "model": "kimchi/kimi-k2.5",
  "provider": {
    "kimchi": {
      "name": "Kimchi",
      "options": {
        "baseURL": "https://llm.kimchi.dev/openai/v1",
        "apiKey": "your-api-key"
      },
      "models": {
        "kimi-k2.5": { "reasoning": true },
        "nemotron-3-super-fp4": { "reasoning": true },
        "minimax-m2.7": { "reasoning": true }
      }
    }
  }
}
```

---

## FAQ

### Will this break my existing config?

No. Kimchi preserves your existing tool configurations and only adds its provider settings.

### Can I switch back?

Yes. Simply remove the `kimchi` provider from your tool's config file, or re-run the tool's original setup.

### Where is my API key stored?

- **Config file**: `~/.config/kimchi/config.json` (permissions: 600)
- **Environment variable**: `KIMCHI_API_KEY`

### How does telemetry work?

Kimchi collects anonymous usage data to help improve the tool, i.e., the CLI version running and the fact that the tool has been used. You can disable telemetry at any time:

```bash
kimchi config telemetry off         # disable via CLI
export KIMCHI_TELEMETRY=false       # disable via env var
```

To check your current telemetry status: `kimchi config telemetry`

---

## Development

```bash
# Build
make build

# Test
make test

# Run locally
go run .

# Lint
golangci-lint run ./...
```

---

## License

Copyright © Cast AI. All rights reserved.
