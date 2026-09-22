# Project trust and the `.kimchi/` folder

> **What you'll notice after upgrading**: the first time you open a project
> that contains a `.kimchi/` or `.claude/` folder (including your own, if you
> use project-local kimchi config), kimchi asks "Trust project folder?" once.
> Choose **Trust** and the decision is remembered per folder. Projects without
> these folders are not prompted. To skip the prompt entirely, set
> `defaultProjectTrust: "always"` in your global settings — but understand
> that this opts every project, including cloned ones, into project-local
> config without asking.

Kimchi reads project-local configuration from the `.kimchi/` folder in the
working directory (and `.claude/` for Claude Code compatibility resources).
Those settings can start helper programs (bash hooks), relax the permission
layer, and choose which server and API key kimchi uses — so they are gated
behind the same project-trust check the CLI runs for pi's own settings:

- **Before trust**, every project-scope reader fails closed: the project config,
  permissions, hooks, skills, agent personas, agent memory, tags, and plan
  objective files are not read at all. A cloned repo cannot redirect your
  endpoint, ride your API key, inject prompts via skills, or run hooks.
- **After trust**, everything applies. Trust is remembered per folder in
  `~/.config/kimchi/harness/agent/trust.json` (pi's trust store), so you are
  asked once per project, with the same options pi offers (Trust, Trust parent
  folder, session-only, Do not trust).

## What triggers the prompt

The "Trust project folder?" prompt appears when the working directory contains
any of:

| Folder | Trust-requiring entries |
| --- | --- |
| `.config/kimchi/harness/` | `settings.json`, `extensions/`, `skills/`, `prompts/`, `themes/`, `SYSTEM.md`, `APPEND_SYSTEM.md` (pi's own project scope) |
| `.kimchi/` | `config.json`, `permissions.json`, `permissions.local.json`, `hooks.json`, `hooks.local.json`, `hooks/`, `skills/`, `agents/`, `agents.json`, `agent-memory/`, `agent-memory-local/`, `mcp.json`, `tags.json`, `plans/`, `ferments/` |
| `.claude/` | `skills/`, `settings.json`, `settings.local.json` |
| `.pi/agent/skills` | kimchi's default skill discovery also reads this pi-style project location (gated on trust like the others) |
| any ancestor | `.agents/skills/`, plus the `.kimchi/`/`.claude/` entries above — detection walks cwd and its ancestors (the skills/tags readers walk ancestors, so detection must match), with the user's home directory excluded |

Custom relative skill paths configured in the user's global config (beyond the
 defaults above) resolve under the project cwd at runtime and are gated on
 trust the same way — but a repo shipping only such a directory cannot be
 detected by the fixed scan list, so it does not trigger the prompt by itself
 (the user's own config opted into that location).

The kimchi-specific entries come from a patch to the pinned
`@earendil-works/pi-coding-agent` (`patches/@earendil-works__pi-coding-agent@0.85.1.patch`
— see the header there for removal criteria). The entry list lives canonically
in `TRUST_REQUIRING_PROJECT_RESOURCES` (`src/project-scope-trust.ts`); a unit
test cross-checks the patch's embedded copy against the constant, so gating a
new reader without adding its scan entry fails CI.

Headless runs (`--print`, ACP/IDE sessions) never prompt: they honor a
persisted decision, then the `defaultProjectTrust` setting (`always` / `never` /
`ask`), and fail closed on `ask` — exactly like pi's no-UI path.

## Gated readers

Enforcement lives in `src/project-scope-trust.ts` (fail-closed,
ancestor-aware, keyed per cwd so concurrent ACP sessions stay isolated). Every
reader of project scope calls `isProjectScopeAllowed(cwd)`:

- `src/config.ts` — `loadConfig()` skips project `.kimchi/config.json`
  (endpoint, API key, skill paths, search settings)
- `src/extensions/mcp-adapter/config.ts` — project `.kimchi/mcp.json` (server
  registration/provenance — an untrusted repo must not spawn MCP servers)
- `src/extensions/permissions/config.ts` — project + local permission files
- `src/resources/bash-hook-discovery.ts` — project `.kimchi/hooks/bash/`
- `src/extensions/kimchi-hooks/definition.ts` — project
  `.kimchi/hooks.json` / `hooks.local.json` (registered in /resources so
  their default-enabled execution is visible and toggleable)
- `src/extensions/claude-code-hook-adapter/definition.ts` — project `.claude` hook settings
- `src/extensions/claude-code-skills/definition.ts` — project `.claude/skills`,
  including the cwd expansion of relative configured skill paths
- `src/shared/skill-discovery/resolve-skill-roots.ts` — project `.kimchi/skills`
  and cwd-resolved config roots (`.pi/agent/skills`, `.claude/skills`)
- `src/extensions/agents/settings.ts`, `personas/custom-agents.ts`,
  `agents/memory/memory.ts`, and the `/agents` menu's project file reads —
  project agents settings, personas, memory
- `src/config/tags.ts` — project `.kimchi/tags.json`
- `src/ferment/store.ts` — project `.kimchi/ferments` (falls back to the
  user-global store while untrusted)
- `src/extensions/ferment-v2/objective-file.ts` — project `.kimchi/plans` objective files

## When trust takes effect

- **First session after trusting**: the trust decision settles inside pi's
  startup, before extensions load. The `settingsTrustSyncExtension` opens the
  kimchi gate at `session_start`, so everything that reads config at request
  time (permission checks, hook discovery, credits/budget refresh, session
  naming) immediately honors the project config. Values baked before the
  prompt — most notably the provider catalog written to `models.json` at
  startup — keep their pre-trust values for that session.
- **Subsequent launches**: `resolvePreMainProjectTrust` (`src/project-trust.ts`)
  opens the gate from the persisted decision before the first config read, so
  a trusted project's endpoint and key apply from startup.

## Testing

- Unit: `src/project-scope-trust.test.ts`, `src/project-trust.test.ts`, plus a
  fail-closed regression test in each gated reader's test file.
- E2E: `tests/e2e/tui/project-trust-gate.test.ts` — a cloned repo shipping a
  malicious `.kimchi/config.json` (attacker endpoint + key) receives zero
  traffic while untrusted; after a persisted Trust, the project endpoint and
  key apply on the next launch.
