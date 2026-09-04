---
name: improve
description: Run the curator — consolidate the agent-created skill library via umbrella-building
triggers:
  - user types "/improve"
  - user asks to "run self-improvement"
  - user asks to "consolidate skills"
  - user asks to "review the skill library"
category: harness
state: active
version: 2
---
# Skill Curator (/improve)

Use this skill when the user asks to run the self-improvement loop or consolidate skills.

## What the curator does

The curator consolidates **agent-created skills** — skills you created during sessions via `skill_manage action=create`. It does NOT touch bundled or harness skills. It does NOT delete anything — it archives (recoverable from `.archive/`).

## Step 1: Check curator status

Call `curator action=status` to check if a background run is in progress.

If the response shows `"running": true` with a recent `last_run_at` (< 4h ago), report:
> "The curator is currently running in the background. Check back later or wait for it to finish."

Then stop.

## Step 2: Confirm with user

Before running, confirm:
> "I'll review your agent-created skills and consolidate overlapping ones into umbrellas. No skills will be deleted — only archived (recoverable). Want to proceed? (Add 'dry-run' to preview without changes.)"

If the user says **dry-run**: call `skill_manage action=list` to show agent-created skills, describe what you'd consolidate, then stop without calling `curator action=run`.

## Step 3: Run the curator

Call `curator action=run`.

The curator will:
1. Apply auto-transitions (stale/reactivate/archive by age)
2. Spawn a consolidation subagent with access to skill_manage, skill_view, skill_list
3. Return a structured summary

## Step 4: Report results

Present the summary from the curator tool result:
- How many skills were consolidated (X → umbrella)
- How many were archived
- If nothing changed: "No consolidations found. Your skill library is already well-organized."
