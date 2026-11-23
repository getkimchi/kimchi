# Agent rules (`.agents/rules/`)

Kimchi loads project rules from `.agents/rules/` directories — markdown rule files
(`.mdc` or `.md`) with optional YAML frontmatter that controls **when** each rule
reaches the model. This is the agent-agnostic rules convention (see the
[agents.md rules proposal](https://github.com/agentsmd/agents.md/issues/179)); it is
distinct from `AGENTS.md`/`CLAUDE.md` project context, which is always loaded in
full.

The feature is implemented by the `extensions.agents-rules` extension (source:
`src/extensions/agents-rules/`), enabled by default. Disable it with:

```bash
kimchi resources disable extensions.agents-rules
```

## Discovery

Kimchi walks from the current working directory up to the filesystem root,
collecting `.agents/rules/` directories at every ancestor level. Each rules
directory is scanned recursively; hidden files and directories are skipped.
Rules are ordered ancestor-first (root-level rules provide the baseline, closer
rules refine them) and deduplicated by absolute path.

Rules are re-discovered on every session start (including `/reload`, fork, and
resume), so edits to rule files are picked up without restarting Kimchi.

Because rule files ship with the repository and their bodies reach the system
prompt (always-apply rules) or steers (glob rules), `.agents/rules/` is a
trust-requiring project resource: a folder that contains it triggers the
project-trust prompt, and until the folder is trusted no rules are loaded at
all (fail closed, see [project trust](project-trust.md)).

## File format

```markdown
---
description: TypeScript conventions
globs:
  - "src/**/*.ts"
  - "src/**/*.tsx"
alwaysApply: false
---

# TypeScript

Use strict mode. Prefer unknown over any.
```

Frontmatter fields (all optional):

| Field          | Type               | Effect                                                              |
| -------------- | ------------------ | ------------------------------------------------------------------- |
| `description`  | string             | One-line summary; shown in the available-rules index                |
| `globs`        | string or list     | Glob patterns that trigger the rule when a touched file matches     |
| `alwaysApply`  | boolean            | When `true`, the rule is always merged into the system prompt       |

Notes:

- `globs` accepts a YAML list or a comma-separated string (`"*.ts, *.tsx"`).
- `alwaysApply: "true"` (string) is coerced to a boolean.
- A file with no frontmatter is valid and treated as an available rule.
- A file with malformed YAML frontmatter is skipped with a console warning —
  it never breaks the session.

## Activation modes

| Mode    | Condition                                | Behavior                                                                 |
| ------- | ---------------------------------------- | ------------------------------------------------------------------------ |
| always  | `alwaysApply: true`                     | Body merged into the `## Rules` block of the system prompt at every turn  |
| glob    | `globs` present, `alwaysApply` not true  | Steered into the conversation when the agent reads/writes/edits a matching file |
| avail.  | `description` only / no frontmatter     | Name + description listed in the system prompt index; the agent reads the file on demand |

`alwaysApply` takes priority regardless of whether `globs` is also present.

### Glob semantics

- Patterns are matched with [micromatch](https://github.com/micromatch/micromatch).
- Relative patterns are resolved against the directory that contains the `.agents/`
  folder — a rule in an ancestor's `.agents/rules/` with `globs: ["src/**"]` matches
  `src/**` under that ancestor, regardless of where inside the tree the session runs.
- Absolute patterns (leading `/`) match against the absolute file path.
- To match a directory **and everything under it**, write `services/catalog/**` —
  a bare `services/catalog` only matches the directory itself.

### Glob-matched delivery

Glob rules activate at most once per session, on the first matching
`read`/`edit`/`write` tool call. The rule body is delivered as a harness steer
(wrapped in `<system-reminder>` tags) right after the tool result, so the model
sees it before its next inference in the same turn. After a context compaction,
activated rules are re-steered so the guidance stays actionable. This
steer-only delivery (instead of a late system-prompt render) keeps the provider
prompt cache intact.

## Example: keeping a document in sync with a directory

The reference example lives at `src/extensions/agents-rules/README-example.mdc`
in the Kimchi repository. A typical use — force significant changes in a service
directory to be mirrored in an architecture document:

```markdown
---
description: Keep docs/catalog-architecture.md in sync with services/catalog changes
globs:
  - "services/catalog/**"
---

# Catalog documentation mirror

After finishing a significant change in `services/catalog/` — new service, changed
responsibility boundaries, renamed module, changed data flow or API contract —
mirror the change in `docs/catalog-architecture.md` before finishing the task.
```

With this rule in place, the first time the agent reads or edits a file under
`services/catalog/`, Kimchi steers the rule body into the conversation and the
model mirrors the change in the architecture document.

## Rules vs AGENTS.md vs skills

- **`AGENTS.md` / `CLAUDE.md`** — free-form project context, always loaded in
  full. Use for the "how this project works" narrative.
- **`.agents/rules/*.mdc`** — structured, path-scoped rules. Use for "when
  working on files in X, follow Y" instructions that should only consume prompt
  budget when relevant.
- **Skills** (`SKILL.md`) — on-demand procedures. Use for reusable workflows,
  not path-scoped constraints.
