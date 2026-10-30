# Skill auto-load on prompt keywords

Deterministic, harness-driven loading of skills when the user's prompt
matches a skill's declared keywords — no model discretion involved. Ships
with the four bundled document skills (`pdf`, `docx`, `xlsx`/`xlsm`,
`pptx`).

## Why it exists

Skills are advertised in the system prompt (`<available_skills>`), but
loading them has always been the model's choice: notice the description
match, call `skill_view(name)`. Models regularly skip that step and reach
for shell tools instead (`pdftotext`, `pypdf`, `openpyxl`…). Auto-load
closes that gap: a keyword hit in the prompt IS the load.

## Declaring triggers

A skill opts in via structured `triggers:` frontmatter in its SKILL.md:

```yaml
---
name: pdf
description: …
triggers:
  prompt:
    - '\.pdf\b'
---
```

`prompt` entries are regex source strings, compiled case-insensitively and
matched against the prompt text (capped at 32 KB per prompt). The older
decorative form — a plain YAML list of prose strings
(`triggers: ["user asks to …"]`) — remains valid and means "no automatic
triggers".

**Scope: harness and bundled skills only.** Discovered skills (project
`.kimchi/skills`, npm packages, `.cursor/skills`, configured `skillPaths`)
are never scanned for triggers: their patterns would run synchronously
against prompt text and their bodies would arrive as user-role steers with
no model-in-the-loop step — an unacceptable reach for third-party- or
repo-controlled content.

## What happens on a match

- The harness listens on pi's `input` event (both surfaces: TUI
  `interactive`, ACP `rpc`). Inputs with `source: "extension"` never
  trigger — subagent task briefs are out of scope.
- On a regex hit, the harness calls `SkillManager.view(name)` itself and
  delivers the result — body, `Skill directory:`, `Linked files:` — as a
  **steer message** (`<system-reminder>`-wrapped, `display: false`). It
  lands in context before the first inference; the visible transcript shows
  nothing. A literal `</system-reminder>` inside the body is neutralized so
  it cannot close the wrapper early.
- **One-shot per session per skill.** A later prompt repeating the keyword
  adds nothing. A skill the session already loaded — through the model's
  `skill_view`, or through the user's `/skill:<name>` command (pi TUI form
  or the ACP server's `Invoking skill:` rewrite) — is never auto-loaded on
  top. For the raw `/skill:<name> args` form, `args` still trigger-match
  other skills; the ACP rewrite embeds the skill body and is not matched
  at all.
- **Compaction-safe.** If compaction folds the steer into the summary, the
  body is re-steered once (marked "back in context after compaction"); a
  steer that survived in the kept window is not duplicated.
- **Gates.** A skill that doesn't resolve through `SkillManager` (missing
  or unreadable) is skipped; a skill declaring `requires-resource:` whose
  toggle is off (user- or org-forced) is skipped at registry build; a skill
  setting `disable-model-invocation: true` is skipped — it is user-facing
  only (pi keeps it out of the model's prompt catalog, and
  `listInventory()` does not filter it). An unreadable or malformed
  `triggers:` block is dropped with a warning, never fatal. A failed
  `view()` is rolled back so a later match can retry.
- **Observability.** Each first injection appends a `skill_autoload_loaded`
  custom entry (`{name, pattern, turnIndex}`) to the session, visible in
  exported session JSONL next to `behaviour_loaded`. `turnIndex` is the
  number of turns completed in the session when the injection lands (0 for
  the first prompt).

## Adding triggers to a skill

1. Add the `triggers.prompt` list to its SKILL.md frontmatter. Keep
   patterns anchored (file extensions, distinctive verbs) — every match
   costs one steer (the full skill body). Only skills in the harness or
   bundled tiers are eligible.
2. Extend the contract test in
   `src/shared/skill-discovery/resources-skills.test.ts`
   (`DOCUMENT_TRIGGERS`) with match/reject samples.

Implementation: `src/extensions/skills-manager/auto-load.ts` (wiring),
`skill-triggers.ts` (frontmatter schema + resource and
`disable-model-invocation` gates). Steer-survival logic is shared with
behaviours in `src/extensions/steer-survival.ts`; marker helpers in
`src/extensions/steer-marker.ts`.
