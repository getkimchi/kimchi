# Harness profiles

Kimchi supports fully independent local profiles — "like running kimchi on
two different machines" on one machine. Each profile owns its own config,
logins (`auth.json`, OAuth/MCP tokens), sessions, memory, skills, extensions,
daemon state, update state, and its own teleport-managed ssh_config.

## Selecting a profile

```sh
kimchi --profile test          # per invocation
KIMCHI_PROFILE=test kimchi    # per process (IDE profiles, CI, shell wrappers)
```

Resolution order: `--profile <name>` → `KIMCHI_PROFILE` → the default profile.

The name `default` is reserved: `--profile default` is exactly equivalent to
passing nothing. Profile names must match `[a-zA-Z0-9][a-zA-Z0-9_-]*` (max 32
chars) — anything else fails fast at startup with a clear error.

## The default profile

The default profile is `~/.config/kimchi/` itself, for everyone: old users,
new users, no exceptions. There is no migration, no probe, no alternate
location. A fresh machine and a machine that has used kimchi for years
resolve the exact same default profile root.

## Layout

```
~/.config/kimchi/                 ← the default profile, always
├── config.json                   ← main config
├── org-policy.json, tags.json, memory/, ssh_config, daemons/
└── harness/                      ← agent dir: sessions/, auth.json,
                                     models.json, mcp.json, mcp-oauth/,
                                     skills/, extensions/, logs/, …

~/.config/kimchi/profiles/<name>/ ← any other profile
└── … same relative layout …
```

Scoped per profile: `config.json`, the whole agent dir (`harness/` —
sessions, logins, model lists, MCP config/OAuth, skills, extensions, logs,
ferment locks), `memory/`, `daemons/`, `ferments/`, `ide/`, `tags.json`,
`org-policy.json`, the teleport-managed `ssh_config`, and the update-state
cache (`~/.cache/kimchi` for the default profile;
`~/.cache/kimchi/profiles/<name>/` for named profiles).

Not scoped (machine-global by design): agent discovery of other tools
(Claude Code, Codex, …) and shell profiles.

## Managing profiles

```sh
kimchi profile list             # profiles on this machine (active marked *)
kimchi profile which            # the profile active for this invocation + its root
kimchi profile create <name>    # pre-create the profile root and harness dir
kimchi profile vars [--values]  # recognised environment variables
```

There is no persistent "active profile" pointer: selection is per
invocation. For a persistent default, export `KIMCHI_PROFILE=<name>` in the
shell/IDE profile.

## ACP / IDE clients

An ACP client that spawns plain `kimchi` (no `--profile`, no
`KIMCHI_PROFILE`) always lands in the default profile — `~/.config/kimchi`
— so existing sessions keep replaying from their unchanged location. To
scope an IDE workspace to a profile, start the server with
`KIMCHI_PROFILE=<name>` (or pass `--profile <name>`); its sessions, logins,
and config then live entirely under that profile's tree.

## Implementation notes

- Profile resolution happens at process start in `src/entry.ts` via
  `src/profile-root.ts` (pure) and `src/profile-root-init.ts` (import-time
  side effect that publishes `KIMCHI_PROFILE`, `KIMCHI_PROFILE_ROOT`,
  `KIMCHI_PROFILE_DEFAULT` before any config path is frozen). The import
  order invariant is enforced by `src/entry-import-graph.test.ts`.
- Path derivation in downstream modules goes through
  `profileRoot()` / `profileAgentDir()`; `KIMCHI_CODING_AGENT_DIR` is
  published by `profile-root-init.ts` at import time and is internal
  plumbing (an inherited value is preserved in
  `KIMCHI_ORIGINAL_CODING_AGENT_DIR`), not a supported agent-dir override
  for binary launches.
- Child processes (bash tools, subagents, the auto-updater) inherit the
  `KIMCHI_PROFILE*` variables, so a nested `kimchi` stays in the same
  profile.
- Self-update behavior is profile-independent in v1: the update always
  targets the running binary, and its state/backups are scoped per profile
  as described above.
