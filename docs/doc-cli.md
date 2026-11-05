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
skips the classifier (decision source `bundled_skill_cli`). In default
mode with a UI, the read-only subcommands (`pdf read/info/fields/dump-shapes`,
`docx read/info`, `xlsx read/info`, `pptx read/inspect/check`) accept the
same way; mutating subcommands still prompt. Plan mode treats the bare
read-only shape as a read-only bash command (`plan_readonly`), same as
cat/grep; mutating subcommands and env-prefixed forms are rejected there.
Everything else, including
the legacy `BUN_BE_BUN=1 kimchi <path>/pdf.mjs …` script form and any
`cd … &&` compound variant, goes through the classifier as before.
User deny rules still win.

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

## Intake guard (read tool and `@file`)

A separate extension (`src/extensions/documents/intake.ts`) keeps binary
documents out of the model's context so the redirect above has something
to redirect from:

- **`read` tool:** a `read` call on a file whose extension routes to a
  skill and whose first bytes match the container magic (`%PDF-` or a zip
  head) is blocked in every permission mode; the block reason names the
  `kimchi doc-cli <skill> read <path>` command (shell-quoted). Detection is
  an 8-byte head read, never extraction.
- **`@file` inlining:** upstream inlines non-image files as lossy UTF-8
  text with no size cap, so `kimchi @deck.pptx …` puts the whole binary into
  the first prompt. The input transform replaces such a block — only when
  it still byte-matches its file's UTF-8 decode, which is exactly what
  upstream produced for that path — with a one-line stub carrying the
  size and the `kimchi doc-cli` command. Within the size cap
  (`maxFileBytes()`), user-typed look-alikes never match and are left
  untouched; over the cap, the magic + length checks alone justify the
  stub. The stub keeps the file name, so prompt-triggered skill auto-load
  still fires.

Both fail open: unreadable files, non-binary content, and unrecognized
formats keep their previous behaviour.

## Cross-version note

Bundled SKILL.md files teach the route as the primary form, with a
`node <skill-dir>/scripts/<skill>.mjs …` fallback for `kimchi` missing
from PATH or a binary older than the route; that fallback is
classifier-gated like any other script invocation.

Matchers and tests: `src/extensions/permissions/bundled-skill-cli.ts`,
`tests/e2e/acp/doc-cli-permissions.test.ts`,
`tests/smoke/document-skills.test.ts`.
