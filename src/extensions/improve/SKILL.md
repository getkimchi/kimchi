---
name: improve
description: Run the self-improvement loop — analyze the skill library and session history, then create, update, or consolidate skills
triggers:
  - user types "/improve"
  - user asks to "run self-improvement"
  - user asks to "review skills"
category: harness
state: active
version: 1
---
# Self-Improvement Loop

Use this skill when the user asks to run the self-improvement loop. You will analyze the skill library and session history, then create, update, or consolidate skills based on patterns found.

## Setup

First, determine the paths:

```
AGENT_DIR = process.env.KIMCHI_CODING_AGENT_DIR or ~/.config/kimchi/harness
SKILLS_DIR = <AGENT_DIR>/skills
MEMORY_DIR = <AGENT_DIR>/memory
SUMMARIES_DIR = <MEMORY_DIR>/summaries
FAILURE_LOG = <MEMORY_DIR>/failure-log.jsonl
```

## Step 1: Inventory the Skill Library

Run: `ls -la <SKILLS_DIR>`

Read every `SKILL.md` file in subdirectories. For each skill, note:
- name, description, triggers, actions, category
- `use_count` and `last_used_at` from `.usage.json` (if it exists)
- `state` field (active / stale / archived)

Build a mental map of:
- Which skills overlap or cover similar ground
- Which skills are stale (not used in 30+ days)
- Which skills are missing: topics the harness knows nothing about?

## Step 2: Analyze Session Summaries

Run: `find <SUMMARIES_DIR> -name "*.md" -type f | sort | tail -20`

Read the last 20 session summaries. For each, extract:
- What was built or worked on
- Any failures or mistakes logged
- Patterns that could become a skill

Look specifically for:
- Recurring errors or misconceptions → high priority, these should become skills
- Techniques discovered that were non-obvious
- Workflow patterns that saved time
- Tools or APIs used that aren't covered by any skill

## Step 3: Analyze Failure Log

Run: `tail -50 <FAILURE_LOG>`

Each line is a JSON failure record: `{"session_id", "timestamp", "type", "description", "resolution"}`

Failures are your highest-priority signal. For each failure:
- Was a skill created to prevent it? If not, should there be one?
- Is the resolution pattern generalizable?

Then read the full log: `cat <FAILURE_LOG>`

Look for clusters: same type of failure across multiple sessions = skill gap.

## Step 4: Produce Your Analysis

Report a structured analysis:

### Skills to CREATE
For each new skill, write the full `SKILL.md` content:
```
## Skill: <name>
- Category: research | coding | ops | harness | debugging
- Triggers: (what prompts the user to load this skill)
- Actions: (step-by-step instructions)
- Examples: (concrete examples of when to use this)
```

### Skills to UPDATE
For each existing skill that needs changes:
```
## Update: <skill-path relative to SKILLS_DIR>
- What to change:
- Why:
```

### Skills to UMBRELLA
Groups of related skills that should be consolidated:
```
## Umbrella: <name>
- Member skills: <list>
- Rationale: <why these belong together>
```

### Stale Skills
```
## Archive: <skill-path>
- Reason: <why this is stale>
```

### Skill Gaps
Topics with no matching skill:
```
## Gap: <topic>
- Evidence: <what you saw that suggests this is needed>
- Suggested approach:
```

## Step 5: Execute

Ask the user to confirm before writing files, or proceed if they already agreed.

For each "Skills to CREATE":
1. Create the directory: `<SKILLS_DIR>/<category>/<skill-name>/`
2. Write the `SKILL.md`
3. Update `.usage.json` to add the new skill with `use_count: 0, state: active`

For each "Skills to UPDATE":
1. Read the existing `SKILL.md`
2. Apply your changes

For each "Skills to UMBRELLA":
1. Create the umbrella directory
2. Write a consolidated `SKILL.md` that references the member skills
3. Move member skill directories under the umbrella (use `git mv`)

For each "Stale Skills":
1. Update `.usage.json`: set `state: archived`

After all changes:
```bash
cd <SKILLS_DIR>
git add .
git commit -m "improve: <short summary of changes>

Co-Authored-By: Kimchi <noreply@kimchi.dev>"
```

## Output

Always produce:
1. A numbered action list
2. The full analysis report (Step 4)
3. A one-paragraph summary: "Created N skills, updated M skills, archived L skills, identified K gaps"