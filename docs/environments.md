# Harness environments

Kimchi supports fully independent local environments — "like running kimchi on
two different machines" on one machine. Each environment owns its own config,
logins (`auth.json`, OAuth/MCP tokens), sessions, memory, skills, extensions,
daemon state, and (optionally) its own kimchi binary version.

## Selecting an environment

```sh
kimchi --env test          # per invocation
KIMCHI_ENV=test kimchi    # per process (IDE profiles, CI, shell wrappers)
```

Resolution order: `--env <name>` → `KIMCHI_ENV` → the default environment.

The name `default` is reserved: `--env default` is exactly equivalent to
passing nothing. Env names must match `[a-zA-Z0-9][a-zA-Z0-9_-]*` (max 32
chars) — anything else fails fast at startup with a clear error.

## The default environment (backward compatibility)

The default environment is resolved per machine, nothing ever migrates:

- If the legacy layout exists (any state at `~/.config/kimchi/` besides
  the `envs/` tree and the machine-global teleport `ssh_config` — e.g.
  `config.json`, `harness/`, `memory/`, `tags.json`), it **is** the default
  environment, used in place. Existing users see zero change: same paths,
  same sessions, same update behavior.
- On a machine with no kimchi state at all, the default environment is
  created at `~/.config/kimchi/envs/default/`.

## Layout

```
~/.config/kimchi/                 ← legacy root (= default env, in place)
├── config.json                   ← main config
├── org-policy.json, tags.json, memory/, ide/, daemons/
└── harness/                      ← agent dir: sessions/, auth.json,
                                     models.json, mcp.json, mcp-oauth/,
                                     skills/, extensions/, logs/, …

~/.config/kimchi/envs/<name>/     ← any other environment
├── … same relative layout …
├── bin/kimchi                    ← (optional) this env's own binary
└── share/kimchi                  ← (optional) its binary-adjacent share files
```

Scoped per environment: `config.json`, the whole agent dir (`harness/` —
sessions, logins, model lists, MCP config/OAuth, skills, extensions, logs,
ferment locks, pr-watch), `memory/`, `daemons/`, `ferments/`, `ide/`,
`tags.json`, `org-policy.json`, and the update-state cache
(`~/.cache/kimchi/envs/<name>/` for named envs; the legacy default keeps
`~/.cache/kimchi/`).

Not scoped (machine-global by design): agent discovery of other tools
(Claude Code, Codex, …), shell profiles, the teleport-managed
`~/.config/kimchi/ssh_config`, binary-adjacent share files for the
global install.

## Managing environments

```sh
kimchi env list              # environments on this machine (active marked *)
kimchi env which             # the env active for this invocation + its root
kimchi env create <name>     # pre-create the env root and harness dir
kimchi env vars [--values]   # recognised environment variables (the
                             # historical `kimchi env` output)
```

There is no persistent "active env" pointer: selection is per invocation. For
a persistent default, export `KIMCHI_ENV=<name>` in the shell/IDE profile.

## Per-environment binary versions (optional)

When an env owns its state tree under `envs/` (i.e. it is not the legacy
default), self-update installs the binary to `<envRoot>/bin/kimchi` instead of
replacing the global executable — share files land at
`<envRoot>/share/kimchi`, following the standard `<binary>/../share/kimchi`
convention. On startup, a packaged `kimchi --env <name>` delegates to the
env's binary when one exists and differs from the running one (loop-safe,
symlink-aware; dev launches are excluded). The legacy default keeps today's
in-place update behavior. Env-scoped installs never touch the machine-global
Claude Code / Codex bridge — that stays bound to the global install.

**Trust model for env binaries:** the env tree is user-writable state, so
it is *not* a security boundary against code you run inside your own
sessions. The delegation applies two guardrails — it only runs a binary
owned by the invoking user and refuses group/world-writable files — so
another local user cannot plant an executable in your env tree. Anything
written by your own sessions is equivalent-privilege to replacing
`~/.local/bin/kimchi` itself.

## ACP / IDE clients

An ACP client that spawns plain `kimchi` (no `--env`, no `KIMCHI_ENV`) always
lands in the default environment — the legacy layout on existing machines, so
existing sessions keep replaying from their unchanged location. To scope an
IDE workspace to an environment, start the server with `KIMCHI_ENV=<name>`
(or pass `--env <name>`); its sessions, logins, and config then live entirely
under that env's tree.

## Implementation notes

- Environment resolution happens at process start in `src/entry.ts` via
  `src/env-root.ts` (pure) and `src/env-root-init.ts` (import-time side
  effect that publishes `KIMCHI_ENV`, `KIMCHI_ENV_ROOT`,
  `KIMCHI_ENV_LEGACY_DEFAULT` before any config path is frozen). The import
  order invariant is enforced by `src/entry-import-graph.test.ts`.
- Path derivation in downstream modules goes through
  `envRootOrLegacy()` / `envAgentDir()`; `KIMCHI_CODING_AGENT_DIR` is
  published by `env-root-init.ts` at import time and is internal plumbing
  (an inherited value is preserved in `KIMCHI_ORIGINAL_CODING_AGENT_DIR`),
  not a supported agent-dir override for binary launches.
- Child processes (bash tools, subagents, the auto-updater) inherit the
  `KIMCHI_ENV*` variables, so a nested `kimchi` stays in the same
  environment.
