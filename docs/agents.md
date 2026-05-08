# Agents

Kimchi's `agents` extension brings Claude-Code-style subagents to the harness. The
LLM can spawn specialized agents via the `Agent` tool — each runs as a focused
child session with its own system prompt, model, and tool restrictions.

## Phase model

Kimchi has a separate phase system that gates the **parent session's** autonomy
(read-only vs full edit, etc.). Phases and agents are independent:

- **Phases** (managed by kimchi's `behaviours` extension and `set_phase` tool)
  control what the parent session is allowed to do.
- **Agents** (this extension) handle delegation. Each persona declares its own
  tool set independently of the parent's phase.

A `plan`-phase parent (read-only) can still spawn an `expert-coder` agent that
edits files — that's by design. Agents are isolated child sessions; their
authority is scoped to the persona's `tools` field, not the parent's phase.

## How it works

When the LLM calls `Agent({ subagent_type: "expert-coder", prompt: "...", description: "..." })`:

1. The persona named `expert-coder` is looked up across three locations
2. Its frontmatter resolves the model, tools, thinking level, etc.
3. Its body becomes the subagent's system prompt
4. The user's prompt is appended and the subagent runs in-process
5. Results stream into the conversation; press <kbd>ctrl+o</kbd> to expand

While agents run, a persistent widget above the editor shows live status, token
counts, and current activity. Open `/agents` to see the menu — select any
running or completed agent to view its full conversation in a live overlay.

## Discovery hierarchy

Agents are discovered from three locations, in priority order (later wins):

| Priority | Location | Scope |
|---|---|---|
| 1 (highest) | `<cwd>/.kimchi/agents/<name>.md` | Project — per-repo agents |
| 2 | `~/.config/kimchi/harness/agents/<name>.md` | User — available everywhere |
| 3 (lowest) | `<extension-package>/agents/<name>.md` | Extension — bundled with installed packages |

The filename (without `.md`) is the canonical agent name and how the LLM refers
to it in `subagent_type`.

## Built-in agents

Four default agents are always available:

| Type | Display | Models | Tools | Purpose |
|---|---|---|---|---|
| `General-Purpose` | Agent | `nemotron-3-super-fp4` → `minimax-m2.7` → `kimi-k2.6` (LLM picks per call) | all | General multi-step tasks; inherits the parent's full system prompt |
| `Explore` | Explore | `kimchi-dev/nemotron-3-super-fp4` | read-only | Fast codebase exploration |
| `Plan` | Plan | `kimchi-dev/minimax-m2.7` | read-only | Architecture and implementation planning |
| `Researcher` | Researcher | `kimchi-dev/kimi-k2.6` | read-only + web | Web and docs research with cited sources |

Override any of them by creating a project or user agent file with the same name.

## Frontmatter reference

Every agent file is a Markdown document with a YAML frontmatter block followed
by the persona body. All fields are optional — sensible defaults apply.

```yaml
---
description: <string>            # One-line summary shown in /agents and in the Agent tool description
display_name: <string>           # Optional UI label (e.g. "Final Validator"); falls back to filename
models: ["<provider>/<id>", ...] # Optional: set of allowed models for this persona. List order has NO
                                 # semantics — it is not a tier ranking. The CALLING LLM picks per spawn
                                 # via the Agent tool's `model` parameter, using its knowledge of model
                                 # tier/strengths. If omitted at the call site, the runtime falls back to
                                 # the first entry (a stable default, not a complexity-aware pick). Omit
                                 # `models` entirely to inherit the parent's model.
thinking: <string>               # off | minimal | low | medium | high | xhigh
tools: <csv>                     # Comma-separated built-in tools, "none", or omit (= inherit all)
disallowed_tools: <csv>          # Comma-separated tools to deny even if otherwise inherited
extensions: <bool|csv>           # true (inherit MCP/extension tools) | false (disable) | comma-list
skills: <bool|csv>               # true (inherit) | false | comma-list of skill names to preload
memory: <scope>                  # user | project | local — enables persistent agent memory
max_turns: <int>                 # Cap conversation turns; omit for unlimited (pi's 30-min hard cap still applies)
inherit_context: <bool>          # If true, fork parent conversation into the subagent's history
isolated: <bool>                 # If true, agent gets no extension/MCP tools — only built-ins
run_in_background: <bool>        # Default to background mode for this agent type
prompt_mode: <string>            # "replace" (default — body is full prompt) | "append" (append to parent's)
enabled: <bool>                  # false to hide this agent without deleting the file
---

You are a senior X engineer who...
(persona body — markdown, becomes the subagent's system prompt)
```

### Built-in tool names

`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`

### Field details

- **`models`** — Set of models this persona may use, e.g. `["kimchi-dev/nemotron-3-super-fp4", "kimchi-dev/minimax-m2.7", "kimchi-dev/kimi-k2.6"]`. **List order has no semantics** — it is not a tier ranking. The set is shown to the calling LLM as part of the `Agent` tool description; the LLM picks per spawn using its knowledge of each model's tier/strengths (from the orchestration model registry). If the caller omits `model`, the runtime falls back to the first entry as a stable default — this is **not** a complexity-aware pick, so for non-trivial tasks always pass an explicit `model`. Omit `models` entirely to inherit the parent session's model. For default agents, kimchi resolves `models` from the strength registry at startup; see `default-agents.ts` for the strength-tag mapping.
- **`tools`** — Omit or set `none` to inherit/disable. Comma-separated lists
  restrict the agent to a subset.
- **`extensions`** — `true` (default) inherits the parent's MCP and extension
  tools. `false` disables them. A comma-list whitelists specific names.
- **`skills`** — `true` (default) inherits all parent skills. A comma-list
  preloads named skills from the project's skill paths into the system prompt
  (useful when the agent needs reference material).
- **`memory`** — Enables a persistent directory keyed by agent name and scope:
  - `user` → `~/.config/kimchi/harness/agent-memory/<name>/`
  - `project` → `<cwd>/.kimchi/agent-memory/<name>/`
  - `local` → `<cwd>/.kimchi/agent-memory-local/<name>/`
- **`prompt_mode: append`** — Treat body as an addendum to the parent's full
  system prompt. The default `replace` makes the persona fully self-contained.
- **`disallowed_tools`** — Always-deny list. Wins over `extensions` and inherited
  tools. Useful for read-only agents that may inherit a write tool from MCP.

## Examples

### Read-only researcher

`~/.config/kimchi/harness/agents/researcher.md`:

```markdown
---
description: Researches codebases and writes summary reports — read-only
tools: read, grep, find, ls
models: ["kimchi-dev/kimi-k2.6"]
thinking: high
disallowed_tools: web_fetch
---

You are a senior research engineer. Investigate the codebase thoroughly,
prefer reading source over guessing, and write a focused report with
file:line citations.
```

Use it: *"Use researcher to figure out how authentication flows through this app."*

### Implementation worker with persistent memory

`.kimchi/agents/expert-coder.md`:

```markdown
---
description: Implements features, refactors, and bug fixes following codebase conventions
tools: read, write, edit, grep, find, bash
models: ["kimchi-dev/minimax-m2.7"]
thinking: medium
memory: project
skills: code-style
---

You are a senior software engineer who treats consistency as a feature.
Read 3+ existing files in the area before writing new code, match
naming/style/error-handling patterns, and never introduce a new
abstraction without removing two duplications.
```

Memory persists across sessions at `.kimchi/agent-memory/expert-coder/MEMORY.md`,
so the agent can record corrections and preferences for the next run.

### Inherits parent context (planning second-opinion)

`~/.config/kimchi/harness/agents/critic.md`:

```markdown
---
description: Second opinion on plans — challenges assumptions, never edits
tools: read, grep, find
thinking: xhigh
inherit_context: true
prompt_mode: append
---

# Critic role

Before any non-trivial implementation, the parent agent should ask you to
review its plan. Look for:

- Hidden assumptions
- Missing edge cases
- Premature abstraction
- Incompatibility with established codebase patterns

You do not edit code. Output a written critique, not a corrected plan.
```

Omitting `models` ensures the critic inherits the same model the user picked,
and `inherit_context: true` forks the parent conversation in so the critic
sees what's been discussed.

### Background work with turn cap

`.kimchi/agents/auditor.md`:

```markdown
---
description: Security auditor for diffs — runs in background, reports findings
display_name: Security Auditor
tools: read, grep, find, bash
models: ["kimchi-dev/kimi-k2.6"]
thinking: high
max_turns: 30
run_in_background: true
memory: project
---

You are a security auditor. Review the requested diff for:

- Injection (SQL, command, XSS, prototype pollution)
- Auth/authz bypasses
- Secret leakage
- Race conditions and TOCTOU

Report each finding with file:line, severity (high/med/low), and a
concrete fix. Cite OWASP or CWE where applicable.
```

Use it: *"Run an auditor in the background on this diff while I keep working."*

The widget shows it running concurrently; the result lands as a notification
when complete.

### Tool restrictions via `extensions: false`

`.kimchi/agents/file-mapper.md`:

```markdown
---
description: Locates files and patterns — minimal tool set, no MCP, fast
tools: read, grep, find, ls
models: ["kimchi-dev/nemotron-3-super-fp4"]
thinking: low
extensions: false
---

You are a fast file locator. Find paths matching the user's intent and
report grouped by relevance. No analysis, no suggestions.
```

`extensions: false` strips MCP-provided tools so this agent can't accidentally
call into a heavy database or browser tool.

### Adaptive model selection with `models`

`.kimchi/agents/adaptive-reader.md`:

```markdown
---
description: Adapts to task — simple lookups use a fast model, deep work escalates
tools: read, grep, find, ls
models:
  - kimchi-dev/nemotron-3-super-fp4   # default — fast, light
  - kimchi-dev/minimax-m2.7           # medium
  - kimchi-dev/kimi-k2.6              # heavy
thinking: medium
---

You are an adaptive code reader. Use the cheapest sufficient effort.
For simple file lookups, finish in one tool call. For multi-file traces,
escalate analysis depth.
```

The runtime picks the first model (`nemotron-3-super-fp4`) by default. Pass an
explicit `model` argument to the `Agent` tool to override for a specific call.

## Recovery

If a session is interrupted while an `Agent` call is in flight, kimchi will
emit a recovery message on the next session start showing what was captured
before the interruption. No manual cleanup is needed.

## Recursion

Subagents cannot spawn further subagents. The `Agent`, `get_subagent_result`,
and `steer_subagent` tools are filtered out of any spawned agent's tool set,
preventing fork-bombs and runaway delegation chains.

## Persistent memory

Agents with `memory:` enabled get a private directory at session start. The
runtime exposes the path via the `KIMCHI_AGENT_MEMORY_DIR` environment variable
inside the agent's tool calls. Conventional layout:

```
.kimchi/agent-memory/<agent-name>/
├── MEMORY.md      # Free-form notes the agent maintains across runs
├── corrections/   # Optional: curated correction logs
└── examples/      # Optional: known-good solution patterns
```

Memory is read-only for agents whose `tools` set lacks `write`/`edit` — the
runtime detects this and skips memory injection rather than confusing the agent
with directives it cannot act on.
