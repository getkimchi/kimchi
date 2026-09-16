# Skills

This document describes how Kimchi discovers skills, how they are surfaced to the
agent, and the authoring conventions that make discovery work.

## Discovery

Skills are SKILL.md files (YAML frontmatter + markdown body) collected by pi's
resource loader from several sources, in precedence order:

1. Project skills — the nearest ancestor `.kimchi/skills` directory (unconditional)
2. Global harness skills — `~/.config/kimchi/harness/skills`
3. Bundled skills — shipped with the harness (read-only)
4. Package skills — npm packages (e.g. `@plannotator/pi-extension`)
5. Configured `skillPaths` in kimchi settings, plus `.cursor/skills`

Precedence, trust, `--skill`/`--no-skills` flags, and name collisions are all
handled by the upstream loader; kimchi contributes its sources via a
`resources_discover` hook (see `src/extensions/prompt-construction/prompt-enrichment.ts`).

## How skills reach the agent

- Every session's system prompt contains an `<available_skills>` block listing
  each skill's **name, one-line description, and file location**. The full
  SKILL.md content is never auto-injected — the model decides whether to load it.
- The `skill_view` tool loads a skill's content by name (including its
  references/templates/scripts), from any source. It is always registered —
  the `<available_skills>` instruction and the auto-suggest reminder both
  direct the model to it. Plain `read` on the SKILL.md path works as a
  fallback. (`skill_manage`, the write-side tool, is currently not registered
  at the CLI wiring point — disabled since #235 pending review.)
- **Auto-suggest:** when a user message matches a skill's name/description
  (stopword-filtered token overlap with a threshold), the harness delivers a
  short `<system-reminder>` steer naming the matched skill and how to load it —
  a reminder, not a directive. Each skill is suggested at most once per session;
  a later strongly-matching input re-arms the suggestion. No match means
  nothing is injected (the normal outcome).
- The `skill_manage` tool creates, edits, pins, and lists skills in the global
  harness skills dir.

## Writing skill descriptions (convention)

The description is the **only matching signal** for both the model and the
auto-suggest matcher. A description that says what a skill is *about* without
saying *when to invoke it* will not fire — models assume routine competence for
git commits, code review, and other everyday tasks unless told otherwise.

A good description states:

1. **What it does** — one sentence.
2. **When to invoke it** — concrete trigger conditions ("Use when drafting,
   revising, or auditing any writing the user will share or publish:
   documentation, READMEs, articles…").
3. **When NOT to invoke it** — the adjacent-but-wrong cases ("Do not load for
   code implementation, planning-only work, code reviews…").

Example (`ai-writing-proofreader` style):

```yaml
---
name: api-migration-helper
description: Guide API consumers through breaking-change migrations. Use when
  upgrading a dependency with a changed public API, writing migration notes, or
  answering "how do I migrate from X to Y". Do not load for new API design or
  internal refactors.
---
```

Anti-patterns:

- Topic lists with no trigger ("Safe and disciplined Git workflow — staging,
  committing, branching") — the model reads this as background knowledge, not
  as a call to action.
- Internal jargon ("Run the curator via umbrella-building") — nothing matches
  unless the user repeats the jargon verbatim.

The matcher scores skill **names** as well as descriptions (a name hit doubles
the match score), so keep names descriptive of the task domain too. Two
matching behaviors matter for authors:

- **Inflection is normalized**: write/writing, story/stories, and
  commit/committing compare equal, so singular/plural and verb forms in the
  description all count.
- **The leading word matters most**: an imperative prompt ("write a story",
  "debug the parser") matches on its first content word — when that word
  matches the skill *name*, the skill is suggested even if the topic nouns
  match nothing. An action verb in the name ("…-debugging", "…-writing")
  makes the skill fire on the corresponding imperative.
- **Matching is English-oriented**: tokens are `[a-z0-9']` sequences, so
  prompts in non-ASCII scripts (CJK, accented Latin) yield few or no tokens
  and simply never match — no suggestion, no error. English trigger
  vocabulary in descriptions is what the matcher (and the model) rely on.
