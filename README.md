# kimchi

A coding agent CLI powered by [kimchi](https://kimchi.dev/). Built on the [pi-mono](https://github.com/badlogic/pi-mono) coding agent SDK, kimchi gives you an AI-powered development assistant in your terminal that connects to kimchi's LLM infrastructure.

![kimchi](./kimchi.png)

## Quick start

Install the latest release:

**Homebrew (macOS / Linux):**

```bash
brew install getkimchi/tap/kimchi
```

**Install script:**

```bash
curl -fsSL https://github.com/getkimchi/kimchi/releases/latest/download/install.sh | bash
```

Then configure your API key and launch:

```bash
kimchi setup   # one-time interactive setup
kimchi         # launch the coding agent
```

Run `kimchi --help` to see all available subcommands and flags.

## Models

### Model selection

The supported model list is fetched at startup from the kimchi metadata service. Use `/model` or `ctrl+p` in the interactive CLI to switch between available models.

Kimchi operates in one of two modes:

| Mode | Footer indicator | Behavior |
|------|-----------------|----------|
| **Multi-model** | `multi-model (orchestrator-id)` | The orchestrator delegates each task to the model assigned for that role |
| **Single-model** | model name | All work runs on the selected model directly |

Use `ctrl+p` to cycle through models. The last entry in the cycle is `multi-model`. You can also open the `/model` picker and select a specific model or `multi-model` from the list.

In single-model mode the orchestration system prompt (environment, tools, research rules, guidelines, phase tagging) stays active, but task classification and delegation are disabled. The subagent tool remains available if you explicitly ask the agent to delegate.

### Model roles

In multi-model mode, each task type is handled by a specific role. Each role can have one model or a **pool of candidates** — the orchestrator reads model descriptions (tier, capabilities) and picks the best fit for each task.

Use `/multi-model` in the interactive CLI to toggle models on/off per role, or edit `~/.config/kimchi/harness/settings.json` directly:

```json
{
  "modelRoles": {
    "orchestrator": "kimchi-dev/kimi-k2.6",
    "builder": ["kimchi-dev/minimax-m2.7", "anthropic/claude-sonnet-4-5"],
    "reviewer": "anthropic/claude-sonnet-4-5",
    "explorer": "kimchi-dev/nemotron-3-ultra-fp4"
  }
}
```

| Role | Default | Description |
|------|---------|-------------|
| **orchestrator** | `kimi-k2.6` | Runs the main loop, classifies tasks, delegates work. Single model. |
| **planner** | `kimi-k2.6` | Designs the approach, writes specs. When same as orchestrator, planning is done in-process. |
| **builder** | `minimax-m2.7` | Code implementation. For complex tasks the orchestrator may pick a heavier model from the pool. |
| **reviewer** | `kimi-k2.6`, `minimax-m2.7` | Code review. Orchestrator picks the strongest by tier for initial review. |
| **explorer** | `kimi-k2.6`, `nemotron-3-ultra-fp4` | Codebase exploration, research. Light models for broad scans, heavy for deep analysis. |

Defaults are derived from model capabilities in `MODEL_CAPABILITIES`. Roles accept any `provider/model-id` string or an array of strings. Only non-default values need to be specified; missing keys fall back to defaults.

#### How model selection works

The orchestrator sees each role's model pool with tier and description. It picks the model whose description best matches the task:

- **Simple build chunk** (CRUD, parsers, CLI): picks standard-tier builder (minimax-m2.7)
- **Complex build chunk** (concurrency, graph algorithms): picks the heaviest model whose description confirms correctness reasoning
- **Code review**: picks the strongest reviewer by tier — fresh Agent context provides independence
- **Exploration**: picks a light model for broad file reading, heavy for deep analysis

#### Example: using Claude for builds

To use Claude Sonnet for all build work while keeping kimchi-dev models for orchestration and review:

```json
{
  "modelRoles": {
    "builder": "anthropic/claude-sonnet-4-5"
  }
}
```

#### Example: mixed pool with tier-based selection

To give the orchestrator a choice between a cheap builder and a strong one, and let it pick based on chunk complexity:

```json
{
  "modelRoles": {
    "builder": ["kimchi-dev/minimax-m2.7", "anthropic/claude-sonnet-4-5"],
    "reviewer": "anthropic/claude-sonnet-4-5"
  }
}
```

The orchestrator will use minimax for simple chunks and Claude for complex ones (based on the plan's complexity classification).

### Phase tracking

Kimchi tags every LLM request with a `phase:{name}` label for usage analytics and cost attribution. The orchestrator sets the phase as work progresses and it is displayed in the footer.

| Phase | Description |
|-------|-------------|
| `explore` | Navigating the codebase, reading files to understand structure |
| `plan` | Designing, breaking down tasks, writing specs |
| `build` | Writing, modifying, or refactoring code |
| `review` | Analyzing output, verifying correctness |
| `research` | Investigating documentation, researching issues |

Subagents inherit the current phase from the orchestrator but cannot change it.

## Tags

Kimchi supports tagging LLM requests for usage tracking and cost attribution. Tags are included with every request and displayed in the footer, grouped by key with color coding.

### Commands

| Command | Description |
|---------|-------------|
| `/tags` | List all active tags |
| `/tags add key:value ...` | Add one or more tags (e.g., `/tags add project:myapp team:backend`) |
| `/tags remove tag ...` | Remove one or more user-defined tags |
| `/tags clear` | Remove all user-defined tags |

### Tag format

Tags use `key:value` format. Key and value must start and end with alphanumeric characters (middle characters may include `-`, `_`, `.`), each 64 characters max, 10 tags total.

### Static tags

Set via the `KIMCHI_TAGS` environment variable (comma-separated). Static tags are read-only within the session and shown with a `[static]` marker.

```bash
export KIMCHI_TAGS="team:backend,project:api"
```

### Auto-tags

Two tags are added automatically to every request and do not count toward the 10 tag limit:

- `model:{model_id}` -- the model handling the request
- `phase:{phase}` -- the current work phase

### Persistence

User-defined tags (added via `/tags add`) are persisted to `~/.config/kimchi/tags.json` and survive across sessions. Static tags from `KIMCHI_TAGS` must be set each session.

## Ferment -- cross-session project management

Ferment is Kimchi's progressive-refinement project mode for multi-session work. Instead of starting from scratch each chat, Ferment persists a structured plan (goal, phases, steps) as a JSON state file.

### Quick start

```bash
kimchi --ferment "Build Tetris"
```

Or inside an active session:

```
/ferment new "Build Tetris"    # create a ferment
/ferment auto                   # keep going until done or blocked
```

### Concepts

- **Ferment** -- the top-level project (e.g. "Build Tetris", "Auth rewrite")
- **Phase** -- a milestone within the project (e.g. "Canvas & Grid", "Movement")
- **Step** -- a single executable task within a phase (e.g. "Create index.html")
- **Decision** -- an architectural choice recorded for posterity
- **Memory** -- a gotcha, convention, or pattern encountered during work

### State machine

All lifecycle transitions are validated by a deterministic finite state machine that enforces valid state changes and prevents illegal operations (e.g. completing a step before it starts, skipping an already-completed phase).

```
draft -> planned -> running -> [paused] -> complete
```

1. **draft** -- created via `/ferment new`, agent collects goal and phases conversationally
2. **planned** -- `scope_ferment` sets goal, criteria, constraints, phase breakdown
3. **running** -- `activate_ferment_phase` starts a phase, agent executes steps
4. **paused** -- user intervention required, or paused with `/ferment pause`
5. **complete** -- all phases terminal

### Continuation policy

Controls whether the active ferment advances across phase boundaries.

| Policy | Behavior | Command |
|--------|----------|---------|
| **manual** | Ask before moving to the next phase | `/ferment manual` |
| **automated** | Keep going until complete, blocked, paused, or user input is needed | `/ferment auto` |

Pause/resume is separate: `/ferment pause` stops the ferment, `/ferment resume` continues it using the current policy. `/ferment exit` leaves Ferment mode without deleting or abandoning the ferment; planned/running work is paused first, active Ferment UI/tools are cleared, and you can later select it from `/ferment list` or `/ferment switch`.

### Commands

| Command | Description |
|---------|-------------|
| `/ferment` | Start a new ferment via prompt |
| `/ferment new "Name"` | Create new ferment |
| `/ferment switch <id>` | Resume by ID prefix or name |
| `/ferment delete <id>` | Delete permanently |
| `/ferment export` | Export stats to JSON |
| `/ferment progress` | Open phase/step navigator overlay |
| `/ferment manual` | Set manual continuation policy |
| `/ferment auto` | Set automated continuation policy |
| `/ferment pause` | Pause the active ferment lifecycle |
| `/ferment resume` | Resume the active ferment lifecycle |
| `/ferment exit` | Leave Ferment mode without deleting the ferment |

### Recovery

Every session writes a `ferment_reference` entry in the session log. On next start, the harness reads this entry and resumes from the exact state.

```bash
# Day 1
$ kimchi --ferment "Build Tetris"
# ... agent works, crashes, terminal closes ...

# Day 2
$ kimchi --ferment "Build Tetris"
# -> Rehydrates state, continues Phase 2 exactly where it left off
```

### Where state lives

```
.kimchi/
  ferments/
    <uuid>.json          -- snapshot (machine-readable plan state)
    <uuid>.events.jsonl  -- append-only audit log of every transition
  sessions/
    <timestamp>.jsonl    -- chat history + tool calls
```

Every mutation is persisted as an append-only event with pre/post state hashes, enabling full auditability. Stats (phase/step counts, timing, model usage, grade distributions) are computed on demand from the snapshot and exported via `/ferment export`.

For full documentation see `docs/ferment.md` and `docs/ferment-storage-schema.md`.

## Remote teleport (preview)

Launch with `kimchi --teleport` to enable session-multiplex commands. The local TUI stays the home base; remote workers are spawned, detached, and re-attached without restarting kimchi.

```bash
kimchi --teleport
```

Slash commands available inside the TUI:

| Command | Description |
|---------|-------------|
| `/teleport [name] [flags]` | Rsync the working tree to a fresh remote sandbox and foreground it. Flags: `--allow-dirty`, `--exclude <glob>`, `--include-ignored`, `--abandon-pending`, `--force` |
| `/detach [--abandon-pending]` | Drop the WebSocket to the foreground remote and return to the local home base. The server keeps the session running. |
| `/attach <name-or-id>` | Re-attach to a previously detached remote |
| `/sessions` | List everything: foreground remote, detached remotes, server-side sessions |
| `/connect [name-or-id]` | Open an interactive SSH shell on the sandbox via the teleport proxy |

`--teleport` and `--remote` are mutually exclusive. Use `--remote --session <id>` to attach to a single remote at startup; use `--teleport` to multiplex from a local home base.

## Configuration

### Authentication

The API key is resolved in this order:

1. `KIMCHI_API_KEY` environment variable (takes precedence)
2. `~/.config/kimchi/config.json` field `api_key`

Run `kimchi setup` for an interactive first-time configuration.

### Agent config

Kimchi stores its configuration (settings, sessions, models) under:

```
~/.config/kimchi/harness/
```

### Context files

You can provide custom instructions that are injected into the system prompt on every session. Kimchi discovers two kinds of context files:

**Global** — applied to every session, regardless of project:

```
~/.config/kimchi/harness/AGENTS.md
```

Place rules that apply everywhere (e.g., your name, code style preferences, or global tool defaults) in this file. It is loaded before any project-level files.

**Project-level** — applied when working in a specific directory tree. Kimchi walks from the working directory up to the filesystem root and collects one context file per directory:

```
AGENTS.md
CLAUDE.md
```

Per directory, `AGENTS.md` takes priority over `CLAUDE.md`. A `.local.md` variant (e.g. `AGENTS.local.md`) is appended to its primary file for user-specific, gitignored overrides.

When both global and project files exist, global instructions appear first in the prompt, followed by ancestor directories, and finally the working directory. This means project-level rules can refine or override global ones.

### Packages

Kimchi supports native Pi packages. `kimchi install npm:<package>` installs a package only for Kimchi, while `pi install npm:<package>` keeps the package owned by the original Pi harness. Kimchi can also load original Pi packages through the **Pi package lookup** resource, so both CLIs can use Pi packages without sharing Kimchi's install scope.

If the same package is installed in both places, the Kimchi install wins. Disable original Pi package lookup with:

```bash
kimchi resources disable extensions.pi-package-lookup
```

Update packages with:

```bash
kimchi update                  # update installed packages, then Kimchi itself
kimchi update --extensions     # update installed packages only
kimchi update context-mode     # update one package by source or display name
kimchi update self             # update Kimchi itself only
```

### HTTP proxy

Kimchi respects `HTTP_PROXY` / `HTTPS_PROXY` environment variables for network requests.

### Token optimization (RTK)

Kimchi installs [RTK](https://github.com/rtk-ai/rtk) during setup and keeps the `rtk` command available on startup. When enabled, kimchi rewrites bash tool calls through `rtk rewrite` before execution. This compresses command output (git, cargo, npm, docker, etc.) by 60-90%, reducing LLM context usage.

Before every bash tool execution, kimchi calls `rtk rewrite "<command>"`. If RTK returns a rewritten command (e.g. `git status` becomes `rtk git status`), the rewritten version is executed instead.

```bash
brew install rtk    # macOS / Linux
```

RTK rewrite is managed from resources:

```bash
kimchi resources disable hooks.rtk-rewrite
kimchi resources enable hooks.rtk-rewrite
```

### Hooks

Users can add custom Bash hooks to rewrite or block shell commands before they run. Global hooks live in `~/.config/kimchi/harness/hooks/bash/`; project hooks live in `.kimchi/hooks/bash/` and default to disabled until enabled from `/resources` or `kimchi resources enable ...`.

See `docs/hooks.md` for the hook protocol and examples.

### Migrating from another coding agent

On first run, kimchi looks for an existing **Claude Code**, **OpenCode**, or **Cursor** installation and offers to migrate its MCP servers. If anything is migratable you will see a one-shot prompt:

```
+  Claude Code + OpenCode + Cursor configuration found
|
|  MCP servers: filesystem, github, ripgrep
|  Claude Code skills: 4 in ~/.claude/skills
|  OpenCode skills: 2 in ~/.config/opencode/skills
|  Cursor skills: 3 in ~/.cursor/skills
|
*  Migrate MCP servers to Kimchi?
|  * Migrate now
|  * Skip this time
|  * Never ask again
```

Discovered MCP servers are merged into `~/.config/kimchi/harness/mcp.json`. Existing Kimchi entries always win on name collisions, so re-running the migration is safe.

The prompt is only shown when something is actually worth migrating. If neither agent is installed or both are empty, the wizard skips silently.

#### Sources scanned

| Agent | Config files (read in order, results merged) | Skills directory |
|---|---|---|
| Claude Code | `~/.claude.json` (top-level `mcpServers` + per-project `projects[*].mcpServers`) | `~/.claude/skills/` |
| OpenCode | `$OPENCODE_CONFIG`, then `~/.config/opencode/opencode.json`, `opencode.jsonc`, `config.json`, `~/.opencode.json` | `~/.config/opencode/skills/` |
| Cursor | `~/.cursor/mcp.json`, then `~/.config/cursor/mcp.json` | `.cursor/skills/`, then `~/.cursor/skills/` |

For OpenCode, both the modern (`mcp` block) and legacy Go-binary (`mcpServers` block) schemas are supported. Servers with `enabled: false` are skipped. For Cursor, servers with `disabled: true` are skipped.

#### Conflict resolution

When the same MCP server name appears in multiple sources:

1. **Within one agent**: earlier files win; project-level entries win over top-level (Claude Code); modern `mcp` block wins over legacy `mcpServers` (OpenCode); `~/.cursor/mcp.json` wins over `~/.config/cursor/mcp.json` (Cursor).
2. **Across agents**: Claude Code wins over OpenCode, which wins over Cursor.
3. **Against existing Kimchi config**: your entries in `~/.config/kimchi/harness/mcp.json` always win.

#### "Never ask again"

Stored in `~/.config/kimchi/config.json` (`migrationState: "skip-forever"`). Delete that field to re-trigger the prompt. Adding support for another agent is a small change -- drop a new definition into `src/agent-discovery/agents/` and append it to the registry.

## Development

### Prerequisites

- Node.js 22 (LTS)
- [Bun](https://bun.sh/) (dev server and binary compilation)
- [corepack](https://nodejs.org/api/corepack.html) enabled (`corepack enable`)
- pnpm (installed automatically via corepack)

### Quick setup

```bash
./scripts/dev-startup.sh
```

This script checks and installs node, pnpm, and bun if missing, runs `pnpm install`, copies resources, and starts the harness with `pnpm run dev`.

### Manual setup

```bash
git clone git@github.com:getkimchi/kimchi.git
cd kimchi
corepack enable
pnpm install
```

### Commands

| Command | Description |
|---------|-------------|
| `pnpm run build` | Compile TypeScript to `dist/` and copy theme assets |
| `pnpm run dev` | Run the CLI locally via Bun |
| `pnpm run check` | Biome lint + TypeScript type check |
| `pnpm run lint` | Biome lint only |
| `pnpm run lint:fix` | Biome lint with auto-fix |
| `pnpm run test` | Run tests with vitest |
| `pnpm run test:smoke` | End-to-end smoke tests |

### Running locally

Propagate resources before first run:

```bash
node ./scripts/copy-resources.js --dev
```

Run the CLI directly via Bun:

```bash
pnpm run dev
```

Or build a standalone binary:

```bash
pnpm run build:binary
./dist/bin/kimchi
```

### Project structure

```
src/
  entry.ts              -- Entry point
  cli.ts                -- CLI logic & harness initialization
  cli-args.ts           -- Argument parsing
  config.ts             -- Auth & config loading
  models.ts             -- Model metadata fetching & registration
  setup-wizard.ts       -- First-run wizard
  commands/             -- CLI subcommands (setup, login, config, update, ...)
  extensions/           -- Agent extensions
    agents/             -- Subagent system (personas, manager, memory)
    orchestration/      -- Task classification, model registry, delegation
    ferment/            -- Ferment lifecycle tools & UI
    mcp-adapter/        -- MCP server integration
    permissions/        -- Tool auth flows
    behaviours/         -- Contextual prompt behaviours
    web-fetch/          -- Web content fetching
    web-search/         -- Web search
    lsp/                -- Language Server Protocol
    login/              -- OAuth flows
    onboarding/         -- Session mode startup wizard
  ferment/              -- Ferment state machine, event store, stats
  modes/
    interactive/        -- TUI harness
    acp/                -- JSON-RPC over stdio (IDE integration)
    teleport/           -- Remote session multiplexing
  agent-discovery/      -- Detection & migration of other coding agents
  config/               -- Config loading & merging
  auth/                 -- API key management
  utils/                -- Shared helpers
```

## Benchmarking

The `benchmark/` directory contains tools for smoke-testing kimchi sessions and auditing their quality.

- **Manual benchmarks** (`benchmark/manual/`) -- run predefined tasks against different models and compare results. See `benchmark/manual/README.md`.
- **Terminal-bench-2** (`benchmark/terminal-bench-2/`) -- run the [terminal-bench](https://www.harborframework.com/) suite (89 tasks) against kimchi inside Docker containers. See `benchmark/terminal-bench-2/README.md`.
- **Session audit** (`benchmark/audit-session/`) -- audit a completed session for phase discipline, code quality, architecture, testing, model alignment, and cost efficiency. See `benchmark/audit-session/README.md`.

## Release

Standalone binaries are built automatically by GitHub Actions when a version tag is pushed (`v*`). Binaries are compiled with `bun build --compile` and require no runtime on the user's machine.

Supported platforms:

- macOS (amd64, arm64)
- Linux (amd64, arm64)

Release assets follow the naming convention `kimchi_{os}_{arch}.tar.gz` with a `checksums.txt` (SHA256) for verification.

## License

[Apache License 2.0](LICENSE) -- see [CONTRIBUTING.md](CONTRIBUTING.md) for the CLA and contributor guidelines.
