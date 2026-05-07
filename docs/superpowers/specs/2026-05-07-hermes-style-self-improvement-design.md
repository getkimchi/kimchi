# Hermes-Style Self-Improvement Loop

**Date:** 2026-05-07
**Branch:** feature/skills-manager (adapt existing work)
**Reference:** [Hermes Agent](https://github.com/nousresearch/hermes-agent) — `agent/curator.py`, `tools/skill_manager_tool.py`

## Summary

Implement a self-improvement loop that mirrors Hermes: the model creates skills inline during sessions guided by tool description triggers, and a background curator periodically consolidates the growing skill library.

The existing `feature/skills-manager` branch has `skill_manage`, `SkillManager`, `UsageTracker`, and auto-transitions already built. This design keeps that work and replaces the session-summary-based curator pipeline with a Hermes-faithful implementation.

---

## Two Independent Pieces

### 1. Inline Skill Creation

Driven entirely by the `skill_manage` tool description. No infrastructure changes — the model creates skills opportunistically during sessions based on trigger guidance.

Skills created via `skill_manage action=create` are flagged `agent_created: true` in `.usage.json`. The curator only ever touches these skills.

**Tool description additions (mirrors Hermes `skill_manager_tool.py`):**

> Create when: complex task succeeded (5+ tool calls), errors overcome, user-corrected approach worked, non-trivial workflow discovered, or user asks you to remember a procedure.
> Update when: instructions stale/wrong, OS-specific failures, missing steps or pitfalls found during use.
> After difficult/iterative tasks, offer to save as a skill. Skip for simple one-offs. Confirm with user before creating/deleting.

### 2. Curator

Background consolidation pass that runs automatically on session start and on demand via `/improve`.

---

## Architecture

```
src/extensions/curator/
  state.ts        — load/save .curator_state.json
  transitions.ts  — applyAutoTransitions()
  review.ts       — runCuratorReview() + subagent prompt
  index.ts        — maybeCurator() + session_start hook
```

**What gets dropped** from the existing `feature/skills-manager` curator:
- `curator.ts`, `executor.ts`, `review-agent.ts`, `log-summarizer.ts`
- `inventory.ts`, `auto-transitions.ts`, `backup.ts`, `audit.ts`, `tdd-runner.ts`

All tied to session-summary gap analysis. The session summary / failure log approach is replaced entirely.

**What gets kept:**
- `skill_manage` tool + `SkillManager` — skill CRUD
- `UsageTracker` — `agent_created` flag, use counts, state, pinned
- `/improve` SKILL.md — rewritten to trigger consolidation

---

## Data Flow

```
session_start
  └── maybeCurator(idleSeconds)
        ├── shouldRunNow() — .curator_state + 7d interval + 2h idle → no-op if not due
        ├── applyAutoTransitions() — mutates .usage.json (stale/archive/reactivate), no LLM
        └── runCuratorReview() [background, non-blocking]
              ├── build candidate list (agent_created skills, names + descriptions)
              ├── spawnSubagent(umbrellaPrompt + candidate list)
              │     └── tools: skill_manage, skill_view, skill_list — no terminal, no bash
              └── update .curator_state (last_run_at, run_count, last_run_summary, running: false)

/improve (manual)
  └── runCuratorReview() [foreground, bypasses interval check]
```

---

## Curator State

`.curator_state.json` lives at `<skillsDir>/.curator_state.json`:

```json
{
  "last_run_at": "2026-05-07T12:00:00.000Z",
  "last_session_at": "2026-05-07T14:00:00.000Z",
  "run_count": 3,
  "paused": false,
  "running": false,
  "last_run_summary": "3 merged, 1 archived"
}
```

`last_session_at` is updated on every `session_start`, before the idle check. `idleSeconds` = `now - last_session_at_previous` (i.e., the gap between this session and the previous one).

**`shouldRunNow(idleSeconds)`:**
- Returns false if `paused: true`
- Returns false if `running: true` (concurrent run guard)
- Returns false if `last_run_at` is within 7 days
- Returns false if `idleSeconds < 2 * 3600` (2h idle minimum)
- Otherwise returns true

---

## Auto-Transitions

Pure computation, no LLM. Runs before every curator pass (background and manual).

| Condition | Action |
|---|---|
| last_activity > 90 days, state !== archived | → archived |
| last_activity > 30 days, state === active | → stale |
| last_activity ≤ 30 days, state === stale | → active (reactivate) |

`last_activity` = max(last_used_at, last_patched_at, created_at).

Mutations written atomically to `.usage.json` via `UsageTracker`.

---

## Curator Subagent Prompt

Mirrors Hermes `CURATOR_REVIEW_PROMPT`. Key constraints:

- **Consolidation only** — not a gap-finder, not a creator of new skills from scratch
- **Agent-created skills only** — candidate list is pre-filtered; bundled/harness skills are never touched
- **No deletion** — only archive via `skill_manage action=delete`. Archives are recoverable.
- **Pinned skills are off-limits** — skip entirely
- **Three consolidation strategies:**
  1. Merge into existing umbrella — patch it, archive siblings with `absorbed_into`
  2. Create new umbrella — `skill_manage action=create`, archive absorbed skills
  3. Demote to references/templates/scripts — `skill_manage action=write_file` under umbrella, archive sibling

**Tools available to subagent:** `skill_manage`, `skill_view`, `skill_list`. No `terminal`, no `bash`.

**Required output format:**
```yaml
## Structured summary (required)
consolidations:
  - from: <old-skill-name>
    into: <umbrella-skill-name>
    reason: <one sentence>
prunings:
  - name: <skill-name>
    reason: <one sentence>
```

Every archived skill must appear in exactly one list.

---

## `/improve` Command

`/improve` SKILL.md rewritten to:
1. Confirm with user (dry-run preview first if requested)
2. Call `runCuratorReview()` directly — same pipeline, no interval check
3. Report the structured summary when done

No session summary reading. No failure log analysis. Pure consolidation.

---

## Error Handling

| Context | Behavior |
|---|---|
| `maybeCurator()` fails | Swallowed, logged at debug. Never blocks session startup. |
| `applyAutoTransitions()` fails | Skip LLM pass, log. Best-effort. |
| Subagent errors | Log, write failure note to `.curator_state`, don't retry. |
| `running: true` on session start | Skip — previous run still in progress or crashed mid-run. |
| `/improve` subagent errors | Surface to user. |

---

## What's Not Implemented (by design)

- **Session summaries / failure log** — dropped. Organic skill creation via tool description is the signal.
- **Backup/snapshot before curator run** — Hermes does this; we skip for now. `.archive/` provides recovery.
- **`hermes curator status`** equivalent — out of scope for now. `.curator_state.json` is human-readable.
- **External memory providers** (Hindsight, Mem0, etc.) — out of scope.
