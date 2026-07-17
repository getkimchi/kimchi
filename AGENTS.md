# Agent guidelines for Kimchi

You are editing the kimchi coding harness. This repo extends the pi-mono SDK (`@earendil-works/pi-coding-agent`) — core agent loop lives upstream; this repo adds extensions in `src/extensions/`.

## Environment

- **Package manager**: pnpm (NEVER use npm/yarn)
- **Runtime**: Bun for dev (`pnpm run dev`), Node 22+ for built binaries
- **Test runner**: vitest (`pnpm run test` — unit, `pnpm run test:smoke`, `pnpm run test:e2e:tui`, `pnpm run test:e2e:acp` — e2e)
- **Linter**: biome (`pnpm run lint`, `pnpm run lint:fix`)
- **Type check**: TypeScript (`pnpm run typecheck`)

## Hard constraints

- **NEVER modify `patches/` files directly** — patches apply at install; changes here don't affect runtime
- **NEVER touch `src/core/export-html/` HTML templates** — bundled JS is auto-generated from source
- **Test files**: Co-locate as `*.test.ts` alongside source (NOT in a separate test/ folder)

## Development patterns

- **Auto-formatting**: `lint:fix` runs automatically after file edits (PostToolUse hook) — don't run manually
- **Pre-commit**: `.husky/pre-commit` runs `pnpm run lint` — CI runs full `check` (lint + typecheck)
- **README changes**: Run `./scripts/copy-resources.js --dev` after editing to propagate to dist/

## Testing expectations

- **Always add or update tests with behavior changes.** Bug fixes should include a regression test that fails before the fix; new features should cover the user-visible behavior they introduce. If a test is not practical, say why in the PR/commit notes.
- **Keep unit/integration tests close to the code** as `*.test.ts` beside the source file. Prefer focused tests that exercise the contract of the module or extension being changed.
- **Use TUI E2E tests for user workflows.** Put terminal-level scenarios under `tests/e2e/tui/*.test.ts` and run them with `pnpm run test:e2e:tui`.
- **Treat TUI E2E tests as human-designed behavioural specs.** They should describe important UX flows a user would recognize, not broad agent-generated coverage. Keep one clear workflow per test, name it by the behavior, and assert on user-visible terminal text/state.
- **Structure TUI tests through the shared fixture.** Use `runKimchiSession`, deterministic fake OpenAI responses, isolated temp `HOME`/workdir, and trace steps for meaningful checkpoints. Avoid brittle ANSI/snapshot assertions unless the rendering itself is the behavior under test.
- **Known product bugs can use `test.fail`.** Add a short comment naming the bug/repro. When the underlying issue is fixed, the unexpected pass is the signal to remove `test.fail`.
- **Quarantine only for unstable tests.** Use `tests/e2e/tui/skip-list.js` with a specific reason and remove the entry as soon as the instability is fixed.
- **Don't hand-write common dependency mocks in tests.** Avoid creating `ExtensionContext` (`ctx`) or `ExtensionAPI` (`pi`) mocks inline inside a test file. Use shared mocks (e.g. under `src/extensions/__mocks__/**` for unit tests) when they exist, and add new ones there if several tests need the same dependency. Don't copy-paste partial mocks across tests.

## Code clean-up checklist

AI agents often introduce a few recurring issues (likely picked up from existing code patterns). Before finishing a PR, review the diff for these and clean them up:

- **Duplicating Pi types** — creating a new local type when `@earendil-works/pi-coding-agent` already exports one.  
  **Fix:** import the existing type from the Pi library.

- **Inline dynamic type imports** — using `import(...).Type` in the middle of a file.  
  **Fix:** import the type normally at the top of the file. This pattern is usually a hallucination.

- **Unnecessary casts** — adding `as` casts where TypeScript already has enough information.  
  **Fix:** remove the cast. If the cast was hiding a real mismatch, fix the root cause instead (e.g., correct the props, or use `Pick<Type, 'prop'>`).

- **Barrel exports from unrelated files** — re-exporting code or types through a file that doesn't own them.  
  **Fix:** update call sites to import directly from the source module.

- **Defensive optional chaining** — writing `pi?.getFlag?.(...)` when `pi` is known to exist.  
  **Fix:** only optional-chain when the value can actually be missing. Don't add dead production code to compensate for weak test mocks—improve the mocks instead.

When you spot these, ask the agent to clean them up before the final PR review.

## Documentation directory

- `.kimchi/docs/` → Transient AI working files — git-ignored, do NOT commit
- `/docs/` → Permanent project documentation — commit here

## PR labeling

A CI job auto-labels PRs based on the PR template checklist. If you create a PR directly via `gh pr create`, assign the correct label(s) explicitly:

| Type of Change       | Label             |
| -------------------- | ----------------- |
| Bug fix              | `bug`             |
| New feature          | `new feature`     |
| Breaking change      | `breaking change` |
| Documentation update | `documentation`   |

Example: `gh pr create --label "bug" ...`

## Before adding features

Before adding a new capability, check whether it already exists upstream
or in a sibling package. This repo extends `@earendil-works/pi-coding-agent`
(pi-mono), so re-implementing upstream features creates maintenance debt
and divergence.

Use the checklist below **during the Explore/Research/Plan phases** of your
orchestration workflow. It does not replace your main orchestration
pipeline; it replaces the normal Explore/Research/Plan content for
feature-work sessions.

### Frame the capability

1. **State the capability in one sentence.** What does the user actually
   need? (e.g. "read pasted images from the clipboard", not "add a
   clipboard extension".) This sentence is the search term every
   subsequent investigation uses.

### Investigate upstream options

The following lookups are **independent** — none of them depends on the
others' results. Run them concurrently, not serially:

- If you can do them yourself in a single turn, batch the tool calls
  (one `grep`, one `web_fetch`/`web_search`, one issues lookup) in the
  same response.
- If they warrant delegation (large codebase scan, deep registry
  triage), spawn up to 3 parallel subagents — one per step — per the
  delegation rules in your system prompt. Do NOT spawn them serially.
- Do NOT short-circuit the investigation when one step returns a hit.
  All three results feed into the decision; partial information leads
  to wrong layer choices (e.g. picking "reimpl" because B1 was empty,
  without knowing B2 found a sibling package).

**1. Search upstream source you already depend on.** The pinned pi-mono
version is the source of truth for what your harness actually runs
against:

```bash
grep -r "<concept>" node_modules/@earendil-works/pi-coding-agent/dist
```

Also check exported utilities, the `Extension` interface, and existing
hooks (`onPasteImage`, `onSubmit` transforms, etc.).

**2. Check the pi.dev package registry.** Scan https://pi.dev/packages
for sibling packages — especially under the `@earendil-works/*` scope.
~60 seconds, names and one-line descriptions only. Goal: eliminate "I
didn't know that package existed." Do NOT deep-read READMEs at this
stage.

**3. Check upstream issues/PRs/discussions** for the capability. It may
be in flight, recently merged, or explicitly rejected with a reason.

## Decide the implementation layer

Once you've confirmed a capability involves upstream behaviour, choose the
integration layer. Stop at the FIRST layer that fits. Do not "upgrade" to a
heavier layer because it feels cleaner:

- **Re-export** — upstream is fine as-is.
- **Adapter / decorator** — wrap upstream, add pre/post-processing.
- **Extension hook** — register against an upstream callback API.
- **Patch** (`patches/*.patch`) — upstream needs a behavioural change;
  MUST be paired with a tracking issue and an upstream PR plan.
- **From-scratch reimplementation** — last resort, only for genuinely
  product-specific code (CastAI auth, branding, custom telemetry).

**If from-scratch:** justify in the PR/commit description why the
investigation came up empty. If you find yourself duplicating ≥50% of an
upstream file, STOP and ask the user whether to upstream the fix
instead.

### Patches are debt

Every file in `patches/` must have a header comment naming the upstream
tracking issue/PR and the removal criteria. Patches are temporary by
definition — they expire when upstream merges or when the need
disappears.
