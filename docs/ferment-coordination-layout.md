# Ferment Coordination Layout — Spec v1

> **Card:** 1.0.2 (spec only, implementation in 1.0.4)
> **Author:** pm-kimchi
> **Status:** accepted

---

## Directory tree

```
.kimchi/
└── coordination/
    ├── todo/          # newly created work items, not yet ready
    ├── ready/         # items whose parents are all done — eligible for claim
    ├── in-progress/   # item currently being worked by an agent
    ├── blocked/       # item parked mid-work due to an external dependency
    ├── done/          # item completed, awaiting review/gc
    └── archive/       # items archived after done + gc
```

Each state is a directory. Each work item is a JSON file named `<item-id>.json` inside the appropriate state directory.

---

## Design decision: directory-as-state

**Why not a single directory with a `state` field in JSON?**

| Concern | Directory-as-state | JSON + state field |
|---|---|---|
| State transition | `rename(2)` — POSIX-atomic on same fs | Read → mutate → write (2 ops, not atomic) |
| "What's ready?" | `readdir()` of one dir — O(n) where n = ready items | Scan all items, filter by `state === "ready"` |
| Index corruption | Impossible — no central index | JSON drift, partial writes |
| Crash recovery | Walk dirs, no repair step needed | Must repair/reconcile index |

State transitions are **atomic renames** because `rename(2)` is atomic on the same filesystem. This means concurrent claim attempts cannot result in a split-brain state — exactly one rename wins.

The filesystem IS the index.

---

## Work-item JSON schema

```typescript
import { z } from "zod";

export const WorkItemSchema = z.object({
  schema_version: z.literal(1),
  id: z.string(),                                  // e.g. "wi_a1b2c3d4"
  title: z.string(),
  body: z.string(),                                // markdown allowed
  ferment_id: z.string(),                          // parent ferment
  phase_id: z.string().optional(),                 // parent phase within the ferment
  agent_role: z.enum(["planner", "judge", "worker"]).optional(),
  parents: z.array(z.string()).default([]),        // other work-item ids this item depends on
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  claimed_by: z.string().optional(),               // agent/session id holding the lock
  claimed_at: z.string().datetime().optional(),
  result_summary: z.string().optional(),           // set on transition to done
  block_reason: z.string().optional(),             // set on transition to blocked
});
```

### Field semantics

| Field | When set | Who sets |
|---|---|---|
| `id` | creation | dispatcher |
| `ferment_id` | creation | dispatcher |
| `phase_id` | creation (if applicable) | dispatcher |
| `agent_role` | creation | dispatcher |
| `parents` | creation | dispatcher |
| `created_at` | creation | dispatcher |
| `updated_at` | every write | last writer |
| `claimed_by` | transition `ready → in-progress` | claimer |
| `claimed_at` | transition `ready → in-progress` | claimer |
| `result_summary` | transition `in-progress → done` | claimer |
| `block_reason` | transition `in-progress → blocked` | claimer |

---

## Lock files

A lock file `ready/wi_<id>.json.lock` is held by the claimer while the item is in `in-progress/`. Uses `proper-lockfile` (already in `package.json`).

Lock lifecycle:
1. **Acquire:** before `ready → in-progress` rename, acquire lock via `proper-lockfile`
2. **Hold:** while item is `in-progress/`, lock is held
3. **Release:** on `in-progress → done` or `in-progress → blocked`, release lock after rename

Lock files themselves are ephemeral and do not need to be committed.

---

## Transition table

| From | To | Precondition | Who | Effect |
|---|---|---|---|---|
| *(none)* | `todo/` | — | dispatcher | create `<id>.json` in `todo/` |
| `todo/` | `ready/` | all `parents` items are in `done/` | dispatcher / parent-done signal | atomic rename |
| `ready/` | `in-progress/` | item has no active lock | claimer (atomic rename) | acquires `.lock`, sets `claimed_by/at` |
| `in-progress/` | `done/` | — | claimer (atomic rename) | sets `result_summary`, releases lock |
| `in-progress/` | `blocked/` | — | claimer (atomic rename) | sets `block_reason`, releases lock |
| `blocked/` | `ready/` | — | unblock action | drops `block_reason`, atomic rename |
| `done/` | `archive/` | — | gc / manual | atomic rename |

### Parent-done enforcement (todo → ready)

Before renaming `todo/<id>.json` → `ready/<id>.json`, the dispatcher must verify all entries in `parents` exist as files in `done/`. If any parent is not done, the rename is rejected.

### Blocked state (in-progress → blocked)

The item is renamed into `blocked/` with `block_reason` written into the JSON. The lock is released. To unblock, an external agent or human writes `block_reason: null` into the JSON and renames it back to `ready/`.

---

## File naming conventions

- JSON files: `<item-id>.json` — e.g. `wi_a1b2c3d4.json`
- Lock files: `<item-id>.json.lock` — e.g. `wi_a1b2c3d4.json.lock`
- Item IDs: `wi_<8 hex chars>` — generated by the dispatcher at creation time

---

## What is NOT in this spec (deferred to 1.0.4)

- How the dispatcher watches for parent-done events
- How the lock is actually acquired/released via `proper-lockfile` API
- The `CoordinationStore` class interface
- Concurrency edge cases beyond atomic rename