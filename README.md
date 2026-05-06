# kimchi

A coding agent CLI powered by [kimchi](https://kimchi.dev/). Built on the [pi-mono](https://github.com/badlogic/pi-mono) coding agent SDK, kimchi gives you an AI-powered development assistant in your terminal that connects to kimchi's LLM infrastructure.

## Quick start

Install the latest release:

```bash
curl -fsSL https://github.com/castai/kimchi-dev/releases/latest/download/install.sh | bash
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

MIT
