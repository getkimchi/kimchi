# Ferment v0.2 — Memory Layout

On-disk layout and frontmatter schema for ferment's Markdown-based memory store.

## Directory tree

```
~/.kimchi/memory/user/           ← HOME-scoped (cross-project)
├── identity.md
└── preferences.md

<repo>/.kimchi/memory/project/  ← repo-scoped, committed
├── planner-history.md
└── judge-failure-patterns.md

<repo>/.kimchi/memory/local/    ← per-checkout, gitignored
└── <ferment-id>/
    ├── scope.md
    └── decisions.md
```

### Scoping rules

| Scope | Root | Committed? | Coordinator needed? |
|---|---|---|---|
| `user` | `~/.kimchi/memory/user/` | n/a (HOME, outside repo) | No |
| `project` | `<repo>/.kimchi/memory/project/` | Yes | No |
| `local` | `<repo>/.kimchi/memory/local/<ferment-id>/` | No (gitignored) | No — per-process by convention (if two agents share one checkout, behaviour is undefined in v0.2) |

### File-per-concern

One file = one topic. Do not bundle unrelated concerns into a single file. Agents read and write plain Markdown after the frontmatter block — no custom parser required.

### Filename rules

- Allowed charset: `[a-z0-9-]+\.md` (lowercase, digits, hyphens; `.md` extension).
- No spaces, no slashes inside filenames, no unicode in v0.2.
- Filenames are stable identifiers — renaming a memory file is treated as deleting one topic and creating another.

## Frontmatter schema

```typescript
import { z } from "zod";

export const MemoryFrontmatter = z.object({
  schema_version: z.literal(1),
  scope: z.enum(["user", "project", "local"]),
  agent: z.string().optional(),       // e.g. "judge", "planner", "worker"
  ferment_id: z.string().optional(),  // present iff scope=local
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  tags: z.array(z.string()).default([]),
});
```

### Required fields

- `schema_version` — must be `1` for v0.2
- `scope` — which memory tier this file belongs to
- `created_at` — ISO 8601 datetime, set on first write
- `updated_at` — ISO 8601 datetime, updated on every write

### Optional fields

- `agent` — authoring agent name (useful in `project/` files shared across multiple agents)
- `ferment_id` — required for `local` scope; absent for `user` and `project`
- `tags` — free-form string array; defaults to `[]`

## Conflict policy

- **Last-writer-wins** at the file level.
- **Atomic rename pattern** (write to temp file + rename) prevents torn reads. Implemented in the `MarkdownFsMemoryStore` adapter (card 1.0.3).
- **No concurrent-edit detection** in v0.2.
- `local/` is per-process by convention — no cross-process write coordination needed.

## Git treatment

- `.kimchi/memory/local/` is gitignored (per-process scratch, not shared).
- `.kimchi/memory/project/` is NOT gitignored — it is the committed project memory and lives in the repo.
- `.kimchi/memory/user/` lives outside the repo (HOME-scoped) and is never gitmanaged here.