---
name: create-skill
description: Create or update reusable skills from a task or workflow.
---

# Create a skill

Turn the user's workflow into a skill Kimchi can reuse. Use plain language: a skill is a folder containing instructions and any scripts, references, or assets needed for the workflow.

## 1. Define the workflow

Use the request and conversation to identify what the skill should do, when to use it, the inputs it needs, and what a good result looks like. This can be a business task (meeting notes, customer updates, report preparation) or a technical task. If the purpose is missing, ask for one example of work the user wants to repeat. Ask only for information that would change the result; do not make the user fill out a technical template.

Inspect an existing skill before updating it. Reuse a matching skill instead of creating a duplicate, and preserve unrelated instructions and supporting files.

## 2. Choose where to save

Honor an explicit destination and any workspace instructions. Otherwise ask whether the skill is for this project or for all the user's projects, explaining the choice without requiring a path:

- This project: `.kimchi/skills/<name>/SKILL.md` in the project root. Project skills load only after the folder is trusted.
- All projects: `~/.config/kimchi/harness/skills/<name>/SKILL.md`.

Use an existing project skills root when one is already present. Check for a same-name skill before writing; update it only when that is the requested intent, otherwise choose a distinct name. Do not write into this bundled skill's directory or a temporary discovery copy.

## 3. Write the instructions

Create a folder named after the skill and a `SKILL.md` with YAML frontmatter:

- `name`: 1–64 lowercase letters, digits, or hyphens, with no leading, trailing, or consecutive hyphens.
- `description`: a nonempty string of at most 1024 characters explaining the task and when to use it. Quote descriptions containing YAML punctuation such as a colon followed by a space.

Write the required inputs, concrete steps, expected output, and relevant limits. Lead with the first action. Use short sections and numbered steps for multi-step work. Finish with a clear next action.

Capture useful domain knowledge rather than generic advice. Refer only to tools available in the target environment; creating a skill does not install integrations or grant permission to send, publish, delete, or deploy.

## 4. Add supporting files when useful

Start with `SKILL.md` alone. Add supporting files only when they serve the workflow:

- `references/` for detailed guidance needed only in certain cases. Link each file from `SKILL.md` and explain when to read it.
- `assets/` for templates or other files used in the output.
- `scripts/` for repeatable operations that benefit from executable code. Run changed scripts with safe sample input.

When using or testing the skill must leave its folder unchanged, keep outputs and caches in the caller's workspace and configure tools to avoid writing into the skill folder.

Use paths relative to the skill folder for bundled files. Keep secrets and machine-specific paths out of reusable content. Do not add placeholder files, unnecessary dependencies, or metadata intended solely for another harness.

## 5. Check the result

Read back the saved files. Check the frontmatter, folder/name match, referenced paths, and that instructions preserve the user's intended workflow. Remove unfinished placeholders.

Try a representative request using supplied or clearly labeled sample input. Check the actual result against the requested output, including how the skill handles missing information. Revise the skill when the trial reveals a concrete problem.

Keep tests local or draft-only when the workflow would otherwise change an external system. If a required tool or input is unavailable, or execution is blocked pending approval, say what remains untested instead of claiming success. Do not relax permission rules to make a check pass.

Finish with the saved path, what was tested, and how to invoke it: `/skill:<name> <request>`. Give one next action: run `/reload` (or start a new session) so Kimchi discovers the new skill. Do not claim discovery was verified unless it was checked.
