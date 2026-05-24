# Superpowers Distribution by Default — Design Spec

> **Scope:** Make the `obra/superpowers` skill set available out-of-the-box in every kimchi installation, without depending on third-party npm wrappers.
> **Approach:** Runtime auto-installer ("C" from brainstorming) → lazy download on first session start.
> **Upstream follow-up:** The user will separately pursue upstreaming pi-native packaging ("D").

---

## Problem Statement

New kimchi users do not get the `obra/superpowers` methodology unless they manually install skills into `~/.config/kimchi/harness/skills/`. The third-party `coctan/pi-superpowers` npm package:
- Reimplements subagent dispatch (redundant with kimchi's native `Agent` tool)
- Hardcodes `~/.pi` config paths (incompatible with kimchi's `~/.config/kimchi` layout)
- Adds maintenance debt as a wrapper around upstream

We want first-class, native integration without a wrapper.

---

## Goals

| # | Goal | Must / Should |
|---|------|-------------|
| 1 | All superpowers skills load by default on first use | Must |
| 2 | No dependency on `pi-superpowers` npm package | Must |
| 3 | No custom tools (dispatch_agent, TodoWrite) — use native equivalents | Must |
| 4 | Kimchi-specific bootstrap injection with tool mapping | Must |
| 5 | Works offline after first install | Must |
| 6 | Zero startup latency after first install | Must |
| 7 | Pinned version per kimchi release | Must |
| 8 | Best-effort install (don't block/fail if download fails) | Should |
| 9 | No persona conversion (code-reviewer.md stays a template) | Must |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  User starts kimchi                                     │
│  └─► session_start event                                │
│       └─► ensureSuperpowersInstalled()                  │
│             ├── exists? ──► skip (zero latency)         │
│             └── missing? ─► download tarball            │
│                             extract to vendor dir       │
│                             write .version marker       │
│                                                           │
├─────────────────────────────────────────────────────────┤
│  before_agent_start event                               │
│  └─► buildSuperpowersBootstrap()                        │
│        ├── read skills/using-superpowers/SKILL.md       │
│        └── append Kimchi Tool Mapping appendix          │
│        └── return { systemPrompt: ... }                 │
│                                                           │
├─────────────────────────────────────────────────────────┤
│  pi.loadSkills() from skill paths                       │
│  └─► includes ~/.config/kimchi/vendor/superpowers/skills│
│        (registered as a default skill path)             │
└─────────────────────────────────────────────────────────┘
```

---

## Design Decisions

### Decision 1: Tarball download (not git clone)

**Choice:** Download release tarball via `fetch` + extract with `tar`.

**Rationale:** No git binary dependency, smaller payload, deterministic deep-link via tag.

```typescript
const url = `https://github.com/obra/superpowers/archive/refs/tags/${VERSION}.tar.gz`
```

**Version:** Pinned constant in source. Bumped manually with each kimchi release. No auto-update.

---

### Decision 2: Lazy installation at session_start (not build time, not startup)

**Choice:** Hook `session_start` to check vendor directory. Download only if missing.

**Rationale:** Zero latency after first run. No blocking during CLI argument parsing. No build-time network dependency. If offline, silently skips and shows a status footer.

---

### Decision 3: Static skills path (relative to home)

**Choice:** Register `join(".config", "kimchi", "vendor", "superpowers", "skills")` as a default skill path.

**Rationale:** Consistent with existing `ALWAYS_SHOWN_SKILL_PATHS` which use relative-to-home paths (`join(".config", "kimchi", "harness", "skills")`). Avoids mixing absolute/relative paths in `expandSkillPaths`.

The `buildSkillPathOptions` helper resolves relative paths against `homedir()`, so the vendor path behaves identically.

---

### Decision 4: Bootstrap via `before_agent_start` returning `{ systemPrompt }`

**Choice:** Extension hooks `before_agent_start`, reads `using-superpowers/SKILL.md`, appends Kimchi tool mapping, and returns the augmented system prompt.

**Rationale:** This is the canonical pi ExtensionAPI pattern used by `prompt-enrichment.ts`. It runs before each agent turn, caches the read file, and prepends the bootstrap to the system prompt.

**Position:** Prepended (first in system prompt, before dynamic context) for Anthropic prompt caching.

**Return value:** `{ systemPrompt: bootstrap + "\n\n" + event.systemPrompt }` — never `ctx.pushMessage()`.

---

### Decision 5: Tool mapping as an appendix (not in-place markdown patching)

**Choice:** Append a minimal markdown table to the bootstrap. Do NOT mutate upstream SKILL.md files.

**Rationale:** Simpler, transparent, no divergence from upstream, no transform maintenance. The table is three rows — negligible token cost.

```markdown
## Kimchi Platform Tool Mapping

| Skill reference | Kimchi action |
|-----------------|---------------|
| `Skill` tool | `/skill:<name>` or `read` its SKILL.md |
| `TodoWrite` | `write`/`edit` on `TODO.md` with `- [ ]` |
| `Task` tool | `Agent` tool (default `General-Purpose`) |
```

---

### Decision 6: No custom tools, no personas

**Choice:** Do NOT register `dispatch_agent`, do NOT convert `code-reviewer.md` to a persona.

**Rationale:**
- `Agent` tool already does what `Task` + `dispatch_agent` do, with better orchestration
- `write`/`edit` on `TODO.md` replaces `TodoWrite`
- `code-reviewer.md` is a prompt template passed as `Agent(prompt=...)` — converting it to a persona is wrapper logic

---

## File Changes

| File | Change Type | Purpose |
|------|-------------|---------|
| `src/extensions/superpowers/config.ts` | Create | Version, URL, path constants |
| `src/extensions/superpowers/installer.ts` | Create | Tarball download + extract |
| `src/extensions/superpowers/installer.test.ts` | Create | Installer unit tests |
| `src/extensions/superpowers/bootstrap.ts` | Create | Build bootstrap system prompt text |
| `src/extensions/superpowers/bootstrap.test.ts` | Create | Bootstrap unit tests |
| `src/extensions/superpowers.ts` | Create | Extension entry point (session + agent hooks) |
| `src/extensions/superpowers.test.ts` | Create | Extension integration tests |
| `src/config.ts` | Modify | Add vendor skills path to defaults |
| `src/cli.ts` | Modify | Register extension factory |
| `package.json` | No change | `tar` already at `^7.5.15` |

---

## Extension API Usage

```typescript
export default function superpowersExtension(pi: ExtensionAPI) {
  // Lazy install check on every new session
  pi.on("session_start", async (_event, ctx) => {
    try {
      await ensureSuperpowersInstalled()
      // Optional: set UI status if installed fresh
    } catch {
      // Best-effort: don't block harness launch
    }
  })

  // Inject bootstrap before every agent start
  pi.on("before_agent_start", async (_event, ctx) => {
    if (ctx.isSubagent) return   // Only main agent

    const bootstrap = buildSuperpowersBootstrap()
    if (!bootstrap) return

    return {
      systemPrompt: `${bootstrap}\n\n${ctx.systemPrompt}`,
    }
  })
}
```

---

## State & Lifecycle

### Version marker

After extraction, write a `.version` file containing the tag string:

```
~/.config/kimchi/vendor/superpowers/.version   → "v5.1.0"
```

`ensureSuperpowersInstalled()` checks this file against the constant. If mismatched, re-downloads.

### Extraction layout

GitHub tarballs extract to `superpowers-<tag>/`. The `tar` library's `strip: 1` option flattens this so the final layout is:

```
~/.config/kimchi/vendor/superpowers/
  .version
  skills/
    using-superpowers/
      SKILL.md
    brainstorming/
      SKILL.md
    ... (14 skills total)
  hooks/              ← ignored by skill loader
  tests/              ← ignored by skill loader
  .git/               ← not present (tarball)
```

### Caching

`buildSuperpowersBootstrap()` should memoize the read of `SKILL.md` in module scope. It never changes during a process lifetime.

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| No network on first run | Skip install, log warning, no skills available |
| GitHub returns 404 | Throw → caught by extension → silent skip |
| Partial/corrupt extract | `.version` missing → re-download on next session |
| User deletes vendor dir | Re-download on next session |
| Version bump in kimchi | `.version` mismatch → overwrite on next session |

---

## Testing Strategy

| Layer | Tests | Scope |
|-------|-------|-------|
| **Unit** | `config.test.ts` | URL construction, path constants |
| **Unit** | `installer.test.ts` | Mock `fetch`, mock `fs`, mock `tar` extract. Assert idempotency (second call is no-op). |
| **Unit** | `bootstrap.test.ts` | Mock `fs` with synthetic `SKILL.md`. Assert output contains mapping table. |
| **Integration** | `superpowers.test.ts` | Mock extension API, assert `session_start` and `before_agent_start` handlers registered. |
| **E2E (smoke)** | Manual | Start kimchi in a fresh environment. Verify `~/.config/kimchi/vendor/superpowers/skills/` exists and skills are loadable. |

---

## Open Questions (resolved)

| Question | Resolution |
|----------|-----------|
| Git clone vs tarball | Tarball (no git dep) |
| Eager vs lazy install | Lazy at `session_start` |
| Append-only vs in-place patch | Append-only mapping table |
| Custom tools? | No — native equivalents are better |
| Persona conversion? | No — pass template as `Agent` prompt |
| Update mechanism? | Pinned to kimchi version, no auto-update |

---

## Not In Scope

- Marketplace plugin manifests (`.claude-plugin/`, `.codex-plugin/`)
- `hooks/` scripts (harness-specific for other platforms)
- `tests/` integration suites (not shipped to end users)
- Upstream PR to `obra/superpowers` (user is handling separately)

---

**Approval needed before proceeding to implementation planning.**
