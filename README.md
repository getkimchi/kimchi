# kimchi

A coding agent CLI powered by [kimchi](https://kimchi.dev/). Built on the [pi-mono](https://github.com/badlogic/pi-mono) coding agent SDK, kimchi gives you an AI-powered development assistant in your terminal that connects to kimchi's LLM infrastructure.

![kimchi](./kimchi.png)

## Quick start

Install the latest release:

**Homebrew (macOS / Linux):**

```bash
brew tap castai/tap
brew install castai/tap/kimchi
```

**Install script:**

```bash
curl -fsSL https://github.com/castai/kimchi/releases/latest/download/install.sh | bash
```

Then configure your API key and tools, and launch:

```bash
kimchi setup   # one-time interactive setup
kimchi         # launch the coding harness
```

Run `kimchi --help` to see all available subcommands and flags.

## Configuration

### Authentication

The API key is resolved in this order:

1. `KIMCHI_API_KEY` environment variable (takes precedence)
2. `~/.config/kimchi/config.json` field `api_key`

Run `kimchi setup` for an interactive first-time configuration.

### Agent config

kimchi stores its own configuration (settings, sessions, models) under:

```
~/.config/kimchi/harness/
```

### Migrating from another coding agent

On first run, kimchi-code looks for an existing **Claude Code** or **OpenCode** installation on your machine and offers to migrate its MCP servers and report any user-level skills it finds. If anything is migratable you'll see a one-shot prompt:

```
┌  Claude Code + OpenCode configuration found
│
│  MCP servers: filesystem, github, ripgrep
│  Claude Code skills: 4 in ~/.claude/skills
│  OpenCode skills: 2 in ~/.config/opencode/skills
│
◇  Migrate MCP servers to Kimchi?
│  ● Migrate now
│  ○ Skip this time
│  ○ Never ask again
```

When you accept, the discovered MCP servers are merged into `~/.config/kimchi/harness/mcp.json`. Existing Kimchi entries always win on name collisions, so re-running the migration is safe — your hand-edited Kimchi config is never overwritten.

The prompt is only shown when something is actually worth migrating (at least one MCP server, or at least one skill subdirectory). If neither agent is installed, or both are installed but empty, the wizard skips the migration step silently and never asks again.

#### Sources scanned

| Agent | Config files (read in order, results merged) | Skills directory |
|---|---|---|
| Claude Code | `~/.claude.json` (top-level `mcpServers` + per-project `projects[*].mcpServers`) | `~/.claude/skills/` |
| OpenCode | `$OPENCODE_CONFIG`, then `~/.config/opencode/opencode.json`, `opencode.jsonc`, `config.json`, `~/.opencode.json` | `~/.config/opencode/skills/` (with `skill/` as a fallback) |

For OpenCode, both the modern (`mcp` block, `type: "local" \| "remote"`, `command: string[]`, `environment`, `enabled`) and legacy Go-binary (`mcpServers` block, `type: "stdio" \| "sse"`, `env` as either an object or a `KEY=VAL` array) schemas are supported. Servers with `enabled: false` are skipped. Files that don't exist are silently ignored; files that fail to read or parse emit a warning and the wizard moves on.

#### Conflict resolution

If the same MCP server name shows up in more than one place, the first one wins, deduplicated at the **server-name** level rather than the file level:

1. **Within one agent**: earlier files in the agent's path list win over later files; within a single Claude Code config, project-level entries win over top-level; within a single OpenCode config, the modern `mcp` block wins over the legacy `mcpServers` block.
2. **Across agents**: Claude Code wins over OpenCode (same default as the historical migration).
3. **Against your existing Kimchi config**: your existing entries in `~/.config/kimchi/harness/mcp.json` always win.

#### Choosing "Never ask again"

Kimchi remembers your choice in `~/.config/kimchi/config.json` (`migrationState: "skip-forever"`) and won't prompt again on future runs, even if you later install another supported agent. To re-trigger the prompt, delete that field from the config file.

Adding support for another coding agent (Cursor, Cline, Aider, Cody, ...) is a small change — drop a new `AgentDefinition` into [`src/agent-discovery/agents/`](src/agent-discovery/) and append it to `AGENT_DEFINITIONS`; the wizard, merging, prompt gating, and migration write all pick it up automatically.

### Models

The supported model list is fetched at startup from the kimchi metadata service.

Use `/model` in the interactive CLI to switch between available models.

### Multi-model orchestration

By default, kimchi runs in multi-model mode: the main agent classifies each task, executes what it can directly, and delegates the rest to specialised subagents picked from the available model roster.

To disable orchestration and run as a single, direct coding assistant:

```bash
kimchi --multi-model=false
```

You can also toggle the mode at any time during a session with the **option/alt+tab** keyboard shortcut. The current state is shown in the footer (`multi-model: on` / `multi-model: off`).

When multi-model is off the agent uses a single-model system prompt: environment, tools, research rules, guidelines, and phase tagging are all active, but task classification and delegation logic are disabled. The subagent tool is still available if you explicitly ask the agent to delegate a task.

### HTTP proxy

kimchi respects `HTTP_PROXY` / `HTTPS_PROXY` environment variables for network requests.

### Token optimization (RTK)

When [RTK](https://github.com/rtk-ai/rtk) (`rtk`) is installed and on your `PATH`, kimchi automatically rewrites bash tool calls through `rtk rewrite` before execution. This compresses command output (git, cargo, npm, docker, etc.) by 60-90%, significantly reducing LLM context usage.

**How it works:** before every bash tool execution, kimchi calls `rtk rewrite "<command>"`. If RTK returns a rewritten command (e.g. `git status` becomes `rtk git status`), the rewritten version is executed instead. The agent receives compact, filtered output without any workflow changes.

**Installation:**

```bash
brew install rtk    # macOS / Linux
```

RTK is auto-detected at startup. No configuration is needed — if `rtk` is on your PATH, it's active.

**Disabling:**

```bash
KIMCHI_RTK=0 kimchi   # disable for this session
```

Set `KIMCHI_RTK` to `0`, `false`, or `off` to disable rewriting even when RTK is installed.

You can also disable persistently in `~/.config/kimchi/harness/settings.json`:

```json
{ "rtk": false }
```

### Subagent sessions

Every `subagent` invocation writes its own persistent session file alongside the parent's, in the same session directory. The child's session header back-references its parent, and the parent's tool-result records the child's session id and file path. Nested subagents (sub-subagents) follow the same rule at any depth — all descendants land next to the original top-level parent.

This means subagent runs are fully recoverable from disk: open the parent's `.jsonl`, follow the `sessionFile` on any `subagent` tool-result to the child, and replay it like any other session. In pi's session-selector, children render under their parent as a tree. Deleting the parent's session directory removes its children automatically.

## Tags

kimchi supports tagging LLM requests for usage tracking and cost attribution. Tags are automatically included with every LLM request and displayed in the footer of the interactive UI.

### Commands

| Command | Description |
|---------|-------------|
| `/tags` | List all active tags |
| `/tags add key:value ...` | Add one or more tags (e.g., `/tags add project:myapp team:backend`) |
| `/tags remove tag ...` | Remove one or more user-defined tags |
| `/tags clear` | Remove all user-defined tags |

Use `/tags` without arguments to see help and current static tag configuration.

### Tag format

Tags use `key:value` format with these rules:
- Must start and end with alphanumeric characters
- Middle characters can include hyphens (`-`), underscores (`_`), and dots (`.`) 
- Key and value must each be 64 characters or less
- Maximum 10 tags total (including static tags and the auto-added model tag)

**Valid examples:** `project:myapp`, `team:backend`

### Static tags

Static tags are set via the `KIMCHI_TAGS` environment variable (comma-separated):

```bash
export KIMCHI_TAGS="team:backend,project:api"
```

Static tags are read-only within the session and cannot be added, removed, or cleared via `/tags` commands. They are displayed with a `[static]` marker when listing tags.

### Persistence

User-defined tags (those added via `/tags add`) are automatically persisted to:

```
~/.config/kimchi/tags.json
```

These tags persist across sessions. Static tags from `KIMCHI_TAGS` are not persisted and must be set via environment variable each session.

## Ferment — Cross-Session Project Management

Ferment is Kimchi's progressive-refinement project mode for multi-session work. Instead of starting from scratch each chat, Ferment persists a structured plan (goal, phases, steps) across sessions as a JSON state file.

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

- **Ferment** — the top-level project (e.g. "Build Tetris", "Auth rewrite")
- **Phase** — a milestone within the project (e.g. "Canvas & Grid", "Movement")
- **Step** — a single executable task within a phase (e.g. "Create index.html")
- **Decision** — an architectural choice recorded for posterity
- **Memory** — a gotcha, convention, or pattern encountered during work

### State machine

All lifecycle transitions (create → scope → activate → start → complete) are validated by a **deterministic finite state machine** that enforces valid state changes and prevents illegal operations (e.g., completing a step before it starts, skipping an already-completed phase). The FSM produces declarative next-action guidance so the harness derives behavior directly from state.

```
draft → planned → running → [paused] → complete
```

1. **draft** — created via `/ferment new`, agent collects goal + phases conversationally
2. **planned** — `scope_ferment` sets goal, criteria, constraints, phase breakdown
3. **running** — `activate_ferment_phase` starts a phase, agent executes steps
4. **paused** — user intervention required, or paused with `/ferment pause`
5. **complete** — all phases terminal, done

Ferment tool visibility is session-profile based. Active planners see the full
namespaced lifecycle surface for a whole run, and the FSM/tool result text says
which call is legal next; worker subagents do not receive ferment lifecycle
tools.

### Continuation policy

Continuation policy controls whether the active ferment advances across phase boundaries.

| Policy | Behavior | Command |
|--------|----------|---------|
| **manual** | Ask before moving to the next phase. | `/ferment manual` |
| **automated** | Keep going until complete, blocked, paused, or user input is needed. | `/ferment auto` |

Pause/resume is separate lifecycle control: `/ferment pause` stops the ferment, and `/ferment resume` continues it using the current policy.

### Commands

| Command | Description |
|---------|-------------|
| `/ferment` | Start a new ferment via prompt |
| `/ferment new "Name"` | Create new ferment |
| `/ferment switch <id>` | Resume by ID prefix or name |
| `/ferment delete <id>` | Delete permanently |
| `/ferment export` | Export stats to JSON for analysis |
| `/ferment progress` | Open phase/step navigator overlay |
| `/ferment manual` | Set manual continuation policy |
| `/ferment auto` | Set automated continuation policy |
| `/ferment pause` | Pause the active ferment lifecycle |
| `/ferment resume` | Resume the active ferment lifecycle |

### Recovery

Every session writes a `ferment_reference` entry in the session log. On next start, the harness reads this entry, loads the JSON state from `.kimchi/ferments/<uuid>.json`, and immediately tells the agent what to do next.

```bash
# Day 1
$ kimchi --ferment "Build Tetris"
# … agent works, crashes, terminal closes …

# Day 2
$ kimchi --ferment "Build Tetris"
# → Rehydrates state, continues Phase 2 exactly where it left off
```

### Where state lives

```
.kimchi/
├── ferments/
│   ├── <uuid>.json          ← snapshot cache (machine-readable plan state)
│   └── <uuid>.events.jsonl  ← append-only audit log of every transition
├── sessions/
│   └── <timestamp>.jsonl    ← chat history + tool calls
└── .<uuid>.progress.log     ← human-readable audit trail
```

Every mutate operation is persisted as an **append-only event** with pre/post state hashes, enabling full auditability. A deterministic **finite state machine (FSM)** validates all lifecycle transitions and prevents illegal operations (e.g., completing a step before it starts). Stats (aggregate phase/step counts, timing percentiles, worker model usage, grade distributions) are computed on demand from the snapshot — surfaced inline (elapsed time, model, grade per step) and exported via `/ferment export` to a JSON file in the cwd.

For full documentation see `docs/ferment.md` and `docs/ferment-storage-schema.md`.

### Visual display

Active ferment is shown in the footer:
```
ferment: Build Tetris [running] phase 2/5 "Pieces"
```

---

### Visual display

Active tags are displayed in the footer, grouped by key with color coding for visual distinction. Tags with the same key are shown together (e.g., `project:api,web`).

## Auto-tagging

A `model:{model_id}` tag is automatically added to every LLM request (e.g., `model:kimi-k2.5`). This tag does not count toward the 10 tag limit and cannot be removed.

A `phase:{phase}` tag is automatically added since kimchi supports phase tracking for usage analytics and cost attribution. Phases represent the high-level type of work being done (exploration, planning, building, reviewing, or researching).

### Available phases

| Phase | Description |
|-------|-------------|
| `explore` | Exploring/navigating the codebase, reading files to understand structure |
| `plan` | Planning, designing, breaking down tasks, writing specs |
| `build` | Writing, modifying, or refactoring code |
| `review` | Code review, analyzing output, verifying correctness |
| `research` | Researching documentation, investigating issues |

### Setting phases

Use the `set_phase` tool to set the current phase:

```
set_phase({"phase": "explore"})
```

**Important:** Only the orchestrator (main agent) can set phases. Subagents receive the current phase from the orchestrator but cannot change it.

### Phase lifecycle

1. The orchestrator sets the phase at the start of work and when transitioning between activities
2. The phase is displayed in the footer (e.g., `↳ explore`)
3. The phase is included as a `phase:{name}` tag in all LLM requests for analytics
4. When delegating to subagents, the current phase is passed automatically

### Example workflow

```
User: "Add user authentication"
→ set_phase({"phase": "explore"})     # Understand existing auth code
→ set_phase({"phase": "plan"})        # Design auth flow
→ set_phase({"phase": "build"})       # Implement the auth code
→ set_phase({"phase": "review"})      # Verify the implementation
```

## Benchmarking

The `benchmark/` directory contains tools for smoke-testing kimchi sessions and auditing their quality.

### Manual benchmarks

Run predefined tasks (simple, complex, research) against different models and compare results:

```bash
cd benchmark/manual
./new-session.sh                              # create a new session with run scripts
./sessions/session-01/run-all.sh              # run all task x model combinations
python3 analyze-session.py                    # analyze the latest session
python3 compare-sessions.py 1 2              # compare two sessions
```

See `benchmark/manual/README.md` for full documentation on tasks, session structure, and analysis.

### Terminal-bench-2

Run the [terminal-bench](https://www.harborframework.com/) suite (89 tasks) against kimchi inside Docker containers. The agent is installed in each task container and runs non-interactively; token and cost counters are parsed from the JSONL output.

```bash
cd benchmark/terminal-bench-2
export KIMCHI_API_KEY=...

# Single task (from local build)
./scripts/run-local.sh -i terminal-bench/fix-git

# Full suite, 8 parallel trials (from latest release)
./scripts/run-release.sh -n 8
```

See `benchmark/terminal-bench-2/README.md` for Apple Silicon caveats, timeout tuning, and result interpretation.

### Session phase audit

Audit a completed session for phase discipline, code quality, architecture, testing, model alignment, and cost efficiency. The audit agent parses the session JSONL, reconstructs the phase timeline, and produces a graded report.
See `benchmark/audit-session/README.md` for the full evaluation criteria and an end-to-end example.

## Development

### Prerequisites

- Node.js 22 (LTS)
- [Bun](https://bun.sh/) (used for dev server and binary compilation)
- [corepack](https://nodejs.org/api/corepack.html) enabled (`corepack enable`)
- pnpm (installed automatically via corepack)

### Quick Setup (Automated)

Use the dev startup script to automatically set up the environment and start the harness:

```bash
./scripts/dev-startup.sh
```

This script will:
- Check and install node, pnpm, and bun (if missing)
- Install dependencies with `pnpm install`
- Copy necessary resources
- Start the harness with `pnpm run dev`

### Manual Setup

```bash
git clone git@github.com:castai/kimchi.git
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

### Running locally

Run the folling script to propagate all necessary resources:
```
node ./scripts/copy-resources.js --dev
```

Run the CLI directly via Bun:

```bash
pnpm run dev
```

Or build a standalone binary and run it:

```bash
pnpm run build:binary
./dist/bin/kimchi
```

### Project structure

```
src/
  cli.ts          — Entry point
  config.ts       — Auth & config loading
  env.ts          — Environment variable helpers
  models.ts       — Default model definitions
  extensions/     — Agent extensions (orchestration, web-fetch)
  modes/          — Interactive mode & theme assets
```

## Release

Standalone binaries are built automatically by GitHub Actions when a version tag is pushed (`v*`). Binaries are compiled with `bun build --compile` and require no runtime on the user's machine.

Supported platforms:

- macOS (amd64, arm64)
- Linux (amd64, arm64)

Release assets follow the naming convention `kimchi_{os}_{arch}.tar.gz` with a `checksums.txt` (SHA256) for verification.

## License

[Apache License 2.0](LICENSE) — see [CONTRIBUTING.md](CONTRIBUTING.md) for the CLA and contributor guidelines.
