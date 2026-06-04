# Agent Guidelines for Kimchi-Dev

You are editing the kimchi-code CLI harness. This repo extends the pi-mono SDK (`@earendil-works/pi-coding-agent`) — core agent loop lives upstream; this repo adds extensions in `src/extensions/`.

## Environment
- **Package manager**: pnpm (NEVER use npm/yarn)
- **Runtime**: Bun for dev (`pnpm run dev`), Node 22+ for built binaries
- **Test runner**: vitest (`pnpm run test` — unit, `pnpm run test:smoke` — e2e)
- **Linter**: biome (`pnpm run lint`, `pnpm run lint:fix`)
- **Type check**: TypeScript (`pnpm run typecheck`)

## Hard Constraints
- **NEVER modify `patches/` files directly** — patches apply at install; changes here don't affect runtime
- **NEVER touch `src/core/export-html/` HTML templates** — bundled JS is auto-generated from source
- **Test files**: Co-locate as `*.test.ts` alongside source (NOT in a separate test/ folder)

## Development Patterns
- **Auto-formatting**: `lint:fix` runs automatically after file edits (PostToolUse hook) — don't run manually
- **Pre-commit**: `.husky/pre-commit` runs `pnpm run lint` — CI runs full `check` (lint + typecheck)
- **README changes**: Run `./scripts/copy-resources.js --dev` after editing to propagate to dist/

## Documents Directory
- `.kimchi/docs/` → Transient AI working files — git-ignored, do NOT commit
- `/docs/` → Permanent project documentation — commit here

## PR Labeling

A CI job auto-labels PRs based on the PR template checklist. If you create a PR directly via `gh pr create`, assign the correct label(s) explicitly:

| Type of Change | Label |
|---|---|
| Bug fix | `bug` |
| New feature | `new feature` |
| Breaking change | `breaking change` |
| Documentation update | `documentation` |

Example: `gh pr create --label "bug" ...`

## Before Adding Features

This repo extends `@earendil-works/pi-coding-agent` (pi-mono). Most
capabilities you might be asked to add already exist upstream or in a
sibling package. Re-implementing them locally creates maintenance debt
and divergence. Before writing any new feature, work through the phases
below.

### Phase A — Frame (sequential)

1. **State the capability in one sentence.** What does the user actually
   need? (e.g. "read pasted images from the clipboard", not "add a
   clipboard extension".) This sentence is the search term every
   investigation in Phase B uses.

### Phase B — Investigate (run in parallel)

Steps B1, B2, B3 are **independent lookups** — none of them depends on
the others' results. Run them concurrently, not serially:

- If you can do them yourself in a single turn, batch the tool calls
  (one `grep`, one `web_fetch`/`web_search`, one issues lookup) in the
  same response.
- If they warrant delegation (large codebase scan, deep registry
  triage), spawn up to 3 parallel subagents — one per step — per the
  delegation rules in your system prompt. Do NOT spawn them serially.
- Do NOT short-circuit Phase B when one step returns a hit. All three
  results feed into Phase C; partial information leads to wrong layer
  choices (e.g. picking "reimpl" because step B1 was empty, without
  knowing step B2 found a sibling package).

**B1. Search upstream source you already depend on.** The pinned
pi-mono version is the source of truth for what your harness actually
runs against:
```bash
grep -r "<concept>" node_modules/@earendil-works/pi-coding-agent/dist
```
Also check exported utilities, the `Extension` interface, and existing
hooks (`onPasteImage`, `onSubmit` transforms, etc.).

**B2. Check the pi.dev package registry.** Scan https://pi.dev/packages
for sibling packages — especially under the `@earendil-works/*` scope.
~60 seconds, names and one-line descriptions only. Goal: eliminate "I
didn't know that package existed." Do NOT deep-read READMEs at this
stage.

**B3. Check upstream issues/PRs/discussions** for the capability. It
may be in flight, recently merged, or explicitly rejected with a
reason.

### Phase C — Decide & implement (sequential, consumes all of Phase B)

2. **Choose the implementation layer.** Stop at the FIRST layer that
   fits. Do not "upgrade" to a heavier layer because it feels cleaner:
   - **Re-export** — upstream is fine as-is.
   - **Adapter / decorator** — wrap upstream, add pre/post-processing.
   - **Extension hook** — register against an upstream callback API.
   - **Patch** (`patches/*.patch`) — upstream needs a behavioural change;
     MUST be paired with a tracking issue and an upstream PR plan.
   - **From-scratch reimplementation** — last resort, only for genuinely
     product-specific code (CastAI auth, branding, custom telemetry).

3. **If from-scratch:** justify in the PR/commit description why all of
   Phase B came up empty. If you find yourself duplicating ≥50% of an
   upstream file, STOP and ask the user whether to upstream the fix
   instead.

### Patches are debt

Every file in `patches/` must have a header comment naming the upstream
tracking issue/PR and the removal criteria. Patches are temporary by
definition — they expire when upstream merges or when the need
disappears.
