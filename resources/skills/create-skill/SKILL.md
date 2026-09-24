---
name: create-skill
description: Create or update reusable skills from a task or workflow.
---

# Create a skill

Turn the user's workflow into a skill Kimchi can reuse. Use plain language: a skill is a folder with instructions, and most skills need no code.

## Understand the workflow

Use the request and conversation to identify what the skill should do, when to use it, the inputs it needs, and what a good result looks like. This can be a business task (meeting notes, customer updates, report preparation) or a technical task. If the purpose is missing, ask for one example of work the user wants to repeat. Ask only for information that would change the result; do not make the user fill out a technical template.

Inspect an existing skill before updating it. Reuse a matching skill instead of creating a duplicate, and preserve unrelated instructions and supporting files.

## Choose where to save

Honor an explicit destination and any workspace instructions. Otherwise ask whether the skill is for this project or for all the user's projects, explaining the choice without requiring a path:

- This project: `.kimchi/skills/<name>/SKILL.md` in the project root. Project skills load only after the folder is trusted.
- All projects: `~/.config/kimchi/harness/skills/<name>/SKILL.md`.

Use an existing project skills root when one is already present. Check for a same-name skill before writing; update it only when that is the requested intent, otherwise choose a distinct name. Do not write into this bundled skill's directory or a temporary discovery copy.

## Write the skill

Create a folder named after the skill and a `SKILL.md` with YAML frontmatter. The name is 1–64 lowercase letters, digits, or hyphens, with no leading, trailing, or consecutive hyphens. The description is a nonempty string of at most 1024 characters explaining both the task and when to use it. Quote descriptions containing YAML punctuation such as a colon followed by a space.

For example, a small business workflow can be entirely self-contained:

```markdown
---
name: meeting-actions
description: Turn meeting notes into decisions and action items when preparing a meeting follow-up.
---

# Meeting actions

Read the supplied notes. Return a short summary, decisions, and an action table with task, owner, and due date. Preserve stated names and dates; mark missing owners or dates as unspecified. Separate open questions from decisions. Draft the follow-up without sending it.
```

Write instructions for the actual workflow, including required inputs, concrete steps, the expected output, and relevant limits. Capture useful domain knowledge and examples rather than generic advice. Refer only to tools available in the target environment; creating a skill does not install integrations or grant permission to send, publish, delete, or deploy.

Start with `SKILL.md` alone. Add supporting files only when they serve the workflow:

- `references/` for detailed guidance needed only in certain cases. Link each file from `SKILL.md` and explain when to read it.
- `assets/` for templates or other files used in the output.
- `scripts/` for repeatable operations that benefit from executable code. Run changed scripts with a safe example. When using or testing the skill must leave its folder unchanged, keep outputs and caches in the caller's workspace; use `python3 -B` for Python helpers and tests to avoid `__pycache__` writes.

Use paths relative to the skill folder for bundled files. Keep secrets and machine-specific paths out of reusable content. Do not add placeholder files, require Python for a text-only skill, or introduce metadata intended solely for another harness.

## Check and try it

Read back the saved files. Check the frontmatter, folder/name match, referenced paths, and that instructions preserve the user's intended workflow. Remove unfinished placeholders.

Try a representative request using supplied or clearly labeled sample input and check the actual result against the requested output. For a meeting skill, for example, include a missing owner or date and verify it is not invented. Keep tests local or draft-only when the workflow would otherwise change an external system. If a required tool or input is unavailable, or execution is blocked pending approval, say what remains untested instead of claiming success. Do not relax permission rules to make a check pass.

Finish with the saved path and an example `/skill:<name> <request>`. Tell the user to run `/reload` (or start a new session) so Kimchi discovers the new skill; do not claim discovery was verified unless it was checked. Revise the skill when the trial reveals a concrete problem.

Authoring structure informed by [OpenAI's skill-creator](https://github.com/openai/skills/tree/main/skills/.system/skill-creator), adapted to Kimchi's native skill format and discovery paths. This skill is self-contained; the link is attribution, not a runtime dependency.
