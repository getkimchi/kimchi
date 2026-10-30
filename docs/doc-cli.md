# Document-skill CLI route (`kimchi doc-cli`)

The bundled document skills (pdf/docx/xlsx/pptx) drive a hidden in-binary
route: `kimchi doc-cli <skill> <command> …`. The binary resolves and
imports the staged CLI bundle itself (`src/extensions/documents/doc-cli-main.ts`),
so the model never supplies a script path — and the `BUN_BE_BUN`
script-exec bootstrap (with its tempdir-EPERM failure class) is not
involved at all. The route is dispatched before org-policy/telemetry
startup, following the same hidden-subcommand convention as the internal
workers, so repeated calls stay invisible to `app_started` instrumentation.

## Permission behaviour

In auto mode (and headless default mode) the permission gate
deterministically accepts the fixed command shape — one segment, no env
prefix, no redirection/substitution/compound tails, bare `kimchi` — and
skips the classifier (decision source `bundled_skill_cli`). Everything
else, including the legacy `BUN_BE_BUN=1 kimchi <path>/pdf.mjs …` script
form and any `cd … &&` compound variant, goes through the classifier as
before. Default mode with a UI still prompts; user deny rules still win.

The bundled skills dir — where the route loads its staged bundles from —
is protected by a deterministic write/edit deny (decision source
`bundled_skill_dir_deny`); a session warning fires when the root fails to
resolve, since the deny is inactive in that state.

## Deliberate residuals

- The allow trusts PATH resolution of the bare name `kimchi` (the
  executing shell resolves it, not the harness). Planting a same-named
  executable earlier on PATH requires separately gated steps.
- The write/edit deny covers exactly those two tools by design; bash-level
  file writes inside the dir — like every other bash file write in auto
  mode — stay behind the classifier.

## Cross-version note

Bundled SKILL.md files teach the route as the primary form, with a
`node <skill-dir>/scripts/<skill>.mjs …` fallback for `kimchi` missing
from PATH or a binary older than the route; that fallback is
classifier-gated like any other script invocation.

Matchers and tests: `src/extensions/permissions/bundled-skill-cli.ts`,
`tests/e2e/acp/doc-cli-permissions.test.ts`,
`tests/smoke/document-skills.test.ts`.
