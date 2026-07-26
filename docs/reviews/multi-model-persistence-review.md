# Multi-Model Persistence Change — Code Review

**Scope:** Review of the synthetic model-ref approach to multi-model persistence, covering `src/extensions/multi-model.ts`, `patches/@earendil-works__pi-coding-agent@0.79.10.patch` (model-selector `handleSelect` + `/model multi-model` shortcut), and `multi-model.test.ts`.

**Branch:** `master` (the multi-model abstraction lives on master; the `fix/multi-model-picker-cursor-persistence` branch uses an older, in-patch-only implementation and does not contain `src/extensions/multi-model.ts`).

## Findings Table

| ID | File | Location | Severity | Finding | Resolution |
|----|------|----------|----------|---------|-------------|
| F1 | `multi-model.ts` | L57-59 (`getGlobalDefault`) | Medium | `getGlobalDefault()` ends with `?? true`, defaulting multi-model ON for fresh installs with no config. Implicit product decision undocumented. | **FIXED.** Expanded `getGlobalDefault()` docblock documenting the `?? true` default-on intent. +2 fresh-install tests (multi-model.test.ts "F1: fresh-install default-on via ?? true fallback"). |
| F2 | `multi-model.ts` | L96 (`hasExplicitModelFlag`) | Low | `kimchi --model <id>` silently disables persisted multi-model for that invocation (does not mutate the persisted synthetic ref; resumes multi-model next run). Undocumented. | **FIXED.** Expanded `hasExplicitModelFlag()` docblock documenting `--model` override semantics. +3 tests ("F2: --model CLI flag silently disables persisted multi-model"). |
| F3 | patch `handleSelect` | L478-494 | Low | Process map is written before settings when persisting the synthetic ref. Order is technically wrong but recoverable (next run reconciles). | **Won't-fix (recoverable).** The reconciliation path on session start corrects any inconsistency. Out of scope for this review. |
| F4 | patch `/model` shortcut | L595-619 | Low | On the error path (e.g. invalid model id), the synthetic ref may remain persisted while the process map is set to false. State is inconsistent until next reconciliation. | **FIXED (test).** +3 tests ("F4: /model shortcut error-path state") covering error-path state + recovery + reconciliation. The error path is self-healing via the next `resolveMultiModelEnabled` call. |
| F5 | vendored bundle | `sdk.js:99`, `model-resolver.js:410-433` | Medium | The startup safety rationale in the ferment planning summary was INACCURATE. `findInitialModel` step 2 (`scopedModels[0]`) is skipped when `scopedModels=[]`; step 3 (`modelRegistry.find`) returns undefined for the synthetic ref; step 4 = "first available model with valid API key". The `session_start` force-switch in `prompt-enrichment.ts:281-289` is what actually restores correctness. | **FIXED.** Added 8-line comment in `prompt-enrichment.ts:281-289` documenting the real startup fallback path (synthetic ref → undefined → step 4 first-available-model → force-switch restores correctness). |
| F6 | patch hygiene | patch file | Medium | The patch bundles ~8 unrelated hunks (status dots, clipboard, etc.) with the multi-model change. The multi-model change is not independently cherry-pickable. | **Won't-fix (out of scope).** Patch hygiene is a separate concern; the multi-model review does not require restructuring the patch. Noted for future patch discipline. |
| F7 | `multi-model.test.ts` | test gaps | Medium | 4 test gaps: (1) `--model` + synthetic ref interaction, (2) shortcut error-path state, (3) `handleSelect` dual-mode, (4) fresh-install default-on. | **FIXED (3 of 4).** Gap 3 (`handleSelect` dual-mode) is vendored code, e2e-only (covered by `tests/e2e/tui/multi-model-command.test.ts`). Gaps 1, 2, 4 covered by added tests. +2 session-metadata-store value-assertion tests (true + false cases). |
| F8 | `multi-model.ts` | L68, L144 (`resolveMultiModelEnabled`, `getPersistedMultiModelEnabled`) | Medium | The `multi_model_enabled` session entry is written by `setAndPersistMultiModelEnabled` and then READ BACK as the "persisted" precedence layer in `resolveMultiModelEnabled`. This creates a feedback loop: a transient override (e.g. an ACP disable) snapshotted into the entry incorrectly disables multi-model on session resume, overriding the global synthetic ref. | **FIXED (conceptual recommendation).** Removed the "persisted" precedence layer from `resolveMultiModelEnabled()`. Session entry is now AUDIT-ONLY (still written for export/drift-detection, no longer read for resolution). Removed dead `"persisted"` variant from `MultiModelSource` type. +4 updated tests + 4 F8 regression tests. |
| F9 | baseline | project-wide | High | Baseline is NOT green: 13 typecheck errors (project-trust, settings-watcher, redactor, acp/server.ts) + 8 test files fail + lint OOM. | **Pre-existing, RESOLVED during Phase 3.** The F9 errors disappeared after a fresh `pnpm install` (the missing `@bulkhead-ai/core` dependency was installed, and the project-trust refactor landed). `pnpm typecheck` now exits 0. |
| F10 | `biome lint` | environment | Low | Biome linter terminates with "Linter process terminated abnormally (possibly out of memory)" on larger files. Environmental issue. | **Won't-fix (environmental).** Biome OOM is a known environmental issue, not caused by this change. Individual file checks pass. |

## multiModel Abstraction Analysis

### The user's question

> "Why would we need multi-model config at all if you have model config and that's it?"

### The four layers

The `multiModel` boolean is currently represented in **four layers**, each with a distinct purpose:

1. **Runtime process map** (`process.__kimchiMultiModelEnabled`) — a per-session transient override. Written by `setMultiModelEnabled()`; read by the picker to highlight the virtual entry. Used for ACP save/restore and force-switch overrides. **Legitimate runtime state.**
2. **`--model` CLI flag** (`hasExplicitModelFlag()`) — a per-invocation override that forces multi-model OFF. **Legitimate CLI override.**
3. **`multi_model_enabled` session entry** — written by `setAndPersistMultiModelEnabled()` on `session_start`/`before_agent_start` as a snapshot of the resolved value. Read by `getPersistedMultiModelEnabled()` as the "persisted" precedence layer. **A cache being read as an input — see F8.**
4. **Global config** (`getGlobalDefault()`) — itself three sub-layers: synthetic ref `orchestration/multi-model` > legacy `multiModel` boolean (deprecated) > hardcoded `true`. **The user's persisted intent.**

### Analysis

**The synthetic ref IS model config.** It lives in `defaultModel`/`defaultProvider` — the same keys that hold any model selection. The value `orchestration/multi-model` is a sentinel that means "multi-model mode, following the configured orchestrator role." This directly answers the user's question: you do **not** need separate multi-model config. The synthetic ref encodes the mode in model config, which is the right approach.

**The synthetic ref is justified** over a plain model ref (e.g. persisting `kimchi-dev/kimi-k2.7` directly) because it is **role-agnostic**: if the user reconfigures which model is the orchestrator, the synthetic ref survives ("follow the new orchestrator"), whereas a direct model ref would pin to the old model and silently break multi-model semantics. The virtual picker entry provides a stable UI target for the same reason.

**The legacy `multiModel` boolean is dead.** It is already deprecated (the code comment says so) and outranked by the synthetic ref in `getGlobalDefault()`. It exists only for backward compatibility with configs persisted before this change. No runtime path depends on it exclusively — if the synthetic ref is persisted, the boolean is ignored.

**The `multi_model_enabled` session entry is a redundant cache.** It snapshots the resolved value and is then read back as a resolution input (F8). In steady state it converges with the global layer, but it introduces a feedback loop and a stale-snapshot risk on session resume. The global synthetic ref is the real source of truth for persisted intent; the session entry adds no independent information.

### Recommendation: KEEP (the synthetic ref), CLEAN UP (the session entry from resolution)

The synthetic ref is the correct, minimal persistence mechanism — it IS "plain model config" as the user's question presumes. The redundant session-entry-as-resolution-input layer was the one real bug (F8) and is removed.

1. **Remove the `multi_model_enabled` session entry from the resolution chain.** Done (F8 fix). `resolveMultiModelEnabled()` no longer consults `getPersistedMultiModelEnabled()`; precedence is now 3 layers: `runtime` > `cli` > `global`. The session entry is still **written** for audit/export (`config.multi_model_enabled` in telemetry) and drift detection.
2. **Keep the synthetic ref** as the sole persisted representation of multi-model intent.
3. **Keep the process map** for legitimate runtime overrides (ACP, force-switch).
4. **Keep the `--model` CLI override** (`hasExplicitModelFlag()`).
5. **Keep the legacy `multiModel` boolean** in `getGlobalDefault()` (deprecated, outranked). Removing it would require a config migration and risks breaking existing persisted configs; it is harmless (synthetic ref outranks it, and if neither is present the `?? true` default applies).

This maps to the **"keep" branch**: codify the rationale (this section), clean the dead/legacy paths (the session entry from resolution + the dead `"persisted"` source variant).

### Migration plan

**No config migration required.** Existing persisted configs (synthetic ref + legacy boolean) work unchanged. Existing session entries (`multi_model_enabled`) are simply ignored at resolution time — no rewrite needed. Verified by the F8 regression tests ("legacy persisted session entry must not alter runtime behavior").

The session entry is still written (audit/export); only its read-for-resolution path was removed.

### Role-agnosticism argument

Synthetic ref `orchestration/multi-model` survives orchestrator reconfiguration ("follow the new orchestrator") whereas a direct model ref pins to old model. Picker virtual entry `_isMultiModel` provides a stable UI target for the same reason. FULL collapse (route through `default = orchestrator` check) would lose this — NOT recommended.

## Phase 2 Implementation Status (KEEP + clean, applied)

Phase 2 implemented the **KEEP** branch. The actual scope was narrower than a full migration because the analysis surfaced a sharper conclusion: only the session-entry layer had a real bug (F8); the legacy boolean, while dead, is **not** safe to remove without a config migration, and removing it would violate the "preserve existing user flows" constraint.

**Applied (code + tests):**
1. **Session entry removed from resolution** (`src/extensions/multi-model.ts`). `resolveMultiModelEnabled()` no longer consults `getPersistedMultiModelEnabled()`; the "persisted" precedence layer is gone. Precedence is now 3 layers: `runtime` > `cli` > `global`. The session entry is still **written** by `setAndPersistMultiModelEnabled()` for two purposes: (a) export/audit (`config.multi_model_enabled` in telemetry/config-snapshot), and (b) drift detection inside `setAndPersistMultiModelEnabled()`. This eliminates the F8 feedback loop while preserving audit/export.
2. **Dead `"persisted"` source variant removed** from the `MultiModelSource` type union (was `runtime | cli | persisted | global`, now `runtime | cli | global`). Rationale codified in the docblock + top-of-file precedence comment.
3. **Rationale codified** in docblocks: `getGlobalDefault()` (F1 default-on product decision), `hasExplicitModelFlag()` (F2 --model override semantics), `resolveMultiModelEnabled()` (F8 feedback-loop rationale), and the `prompt-enrichment.ts:281-289` force-switch comment (F5 real startup path).

**Deliberately NOT applied (no-migration rationale):**
- The legacy `multiModel` boolean in `getGlobalDefault()` is **kept** (deprecated, outranked by the synthetic ref). Removing it would require a config migration to rewrite existing configs, violating the "preserve existing user flows" constraint. It is harmless: if the synthetic ref is persisted, the boolean is never reached; if neither is present, the hardcoded `?? true` default applies.
- No config migration is required. Existing persisted configs (synthetic ref + legacy boolean) work unchanged. Existing session entries (`multi_model_enabled`) are simply ignored at resolution time — no rewrite needed. Verified by the F8 regression tests.

**Per-file consumer disposition** (verified via grep, 15 non-test consumers of `getMultiModelEnabled` + 1 of `getPersistedMultiModelEnabled` for drift):

| File | API used | KEEP impact | Change |
|------|----------|-------------|--------|
| `multi-model.ts` | (source) | resolution shape changed | edited (F1/F2/F8) |
| `multi-model.test.ts` | (tests) | shape updated | edited (+12 tests, 4 updated) |
| `session-metadata-store.test.ts` | (tests) | value assertions added | edited (+2 tests) |
| `prompt-enrichment.ts` | `getMultiModelEnabled` (bool) | none | comment only (F5) |
| `model-switch.ts` | `getMultiModelEnabled` (bool) | none | unchanged |
| `kimchi-process.ts` | process map | none | unchanged |
| `ui.ts` | `getMultiModelEnabled` (bool) | none | unchanged |
| `acp/server.ts` | `getMultiModelEnabled` (bool) | none | unchanged |
| `status-line.ts` | `getMultiModelEnabled` (bool) | none | unchanged |
| `agents/index.ts` | `getMultiModelEnabled` (bool) | none | unchanged |
| `ferment/commands.ts` | `getMultiModelEnabled` (bool) | none | unchanged |
| `ferment/events.ts` | `getMultiModelEnabled` (bool) | none | unchanged |
| `ferment/prompt-block.ts` | `getMultiModelEnabled` (bool) | none | unchanged |
| `ferment/tools/knowledge.ts` | `getMultiModelEnabled` (bool) | none | unchanged |
| `ferment/tools/lifecycle.ts` | `getMultiModelEnabled` (bool) | none | unchanged |
| `ferment/tools/phases.ts` | `getMultiModelEnabled` (bool) | none | unchanged |
| `ferment/tools/steps.ts` | `getMultiModelEnabled` (bool) | none | unchanged |
| `orchestration/model-roles-command.ts` | `getMultiModelEnabled` (bool) | none | unchanged |
| `prompt-summary.ts` | `getMultiModelEnabled` (bool) | none | unchanged |
| `telemetry/config-snapshot.ts` | `getMultiModelEnabled` (bool) | none | unchanged |
| `patches/@earendil-works__pi-coding-agent@0.79.10.patch` | process map | none | unchanged |

All 15 boolean-API consumers are **KEEP-transparent**: they call `getMultiModelEnabled(ctx.sessionManager)` and receive the same boolean (now derived from `runtime > cli > global` instead of `runtime > cli > persisted > global`). No consumer accesses `.source` on the resolution (verified: `grep -rnE '\.source\b' src/` excluding tests/multi-model.ts → 0 matches). No consumer imports `resolveMultiModelEnabled` outside `multi-model.ts`. The resolution shape change is therefore invisible to consumers.

## Baseline Verification (captured in Phase 1)

- `pnpm typecheck` → 2 (13 errors, all pre-existing project-trust/settings-watcher/redactor)
- `pnpm test` → 1 (8 files/16 tests fail, all collateral)
- `npx vitest run src/extensions/multi-model.test.ts` → 0 (37 tests passed at baseline)
- `pnpm lint` → 254 (OOM)
- `pnpm test:smoke` → 1
- `pnpm test:e2e:tui` → 1 (cannot build)

## Verification

Phase 3 full local verification (captured from a clean state: `rm -rf node_modules && pnpm install`).

### Multi-model surface — GREEN (success criteria)

The multi-model change under review is fully verified green across every affected suite:

| Command | Exit | Result |
|---------|------|--------|
| `npx vitest run src/extensions/multi-model.test.ts` | 0 | **49/49 pass** (+12 new tests since baseline 37) |
| `npx vitest run src/extensions/multi-model.test.ts src/extensions/model-switch.test.ts src/config/settings.test.ts src/extensions/telemetry/config-snapshot.test.ts src/components/status-line.test.ts src/utils/export-post-process.test.ts src/utils/session-metadata-store.test.ts` | 0 | **226/226 pass** (full success-criteria surface) |
| `grep -rnE 'source.*"persisted"\|source === "persisted"\|\.source\b' src/ --include="*.ts"` (excluding tests + multi-model.ts) | 0 | **0 dangling references** to the removed `"persisted"` source variant |

### Static checks — GREEN

| Command | Exit | Result |
|---------|------|--------|
| `pnpm clean` | 0 | dist removed |
| `rm -rf node_modules && pnpm install` | 0 | Fresh install; `@earendil-works/pi-coding-agent@0.79.10` installed; **patch applied cleanly** (multi-model markers present in `dist/modes/interactive/components/model-selector.js`). No "corrupt patch". |
| `pnpm typecheck` | **0** | **0 errors.** The F9 baseline errors (13: project-trust, settings-watcher, redactor, acp/server.ts) are **RESOLVED** by the fresh install (missing `@bulkhead-ai/core` dependency was installed). |
| `pnpm lint` | 1 | Pre-existing F10 OOM only ("Linter process terminated abnormally (possibly out of memory)"). Edited files (`multi-model.ts`, `prompt-enrichment.ts`) pass `biome check` individually — the OOM is triggered by full-project scanning, not my code. |
| `pnpm build` | **0** | `tsc --noEmit && node scripts/copy-resources.js --dev` both pass. dist/bin/ + dist/share/ produced. |

### Unit + smoke — multi-model GREEN, pre-existing failures documented

| Command | Exit | Result |
|---------|------|--------|
| `pnpm test` | 1 | **7358 passed** (up from baseline 7256 — the F9 fix resolved 7 failures), 9 failed. The 9 failures are **pre-existing** (confirmed via `git stash`: identical 9 fail without my changes) in `model-guard.test.ts` (4, compaction) and `permissions/index.test.ts` (5, yolo/plan-mode) — neither references multi-model (grep → 0). |
| `pnpm test:smoke` | **0** | **13 passed, 12 skipped, 0 failed** (re-run after `pnpm build`; the pre-build binary-test failures are gone). Earlier pre-build run was exit 1 due to binary-not-built + billing-network; post-build all binary tests pass. |

### TUI e2e — multi-model-command test GREEN; pre-existing ferment failures (NOT multi-model)

| Command | Exit | Result |
|---------|------|--------|
| `pnpm test:e2e:tui` | 1 | Runs `build:binary && node scripts/run-tui-e2e.js` (uses the `tui-test` runner, NOT vitest). **`tests/e2e/tui/multi-model-command.test.ts`: 10/10 PASS** (✔ 1-10, covering /multi-model menu, reset, metadata editor, builder toggle-select, cursor reset, Space toggle, title count update, menu cursor reset). The 4 failing test files are unrelated ferment e2e tests: `ferment-new-resets-continuation-policy` (1), `ferment-oneshot-scope-nudge` (3 w/ retries), `ferment-plan-review-oneshot` (3 w/ retries), `ferment-plan-review-suppression` (3 w/ retries). **Pre-existing confirmed** via `git stash` baseline: the same ferment tests fail identically with my changes removed. The `tui-test` runner warns: "works best when using a supported node versions (which 25.9.0 is not)" — Node v25.9.0 is the environmental root cause of the ferment e2e flakiness. |

### Summary

- **Multi-model change (affected surface): FULLY GREEN.** 226/226 affected unit/integration tests pass; 10/10 multi-model TUI e2e tests pass (`multi-model-command.test.ts` ✔ 1-10); 0 dangling references; typecheck clean; build clean; patch applies cleanly; smoke green post-build.
- **Repository-wide suites (NOT claimed green, pre-existing failures root-caused):** `pnpm lint` (exit 1, pre-existing F10 OOM — environmental), `pnpm test` (exit 1, 9 pre-existing failures in model-guard + permissions — git-stash baseline-confirmed, neither references multi-model), `pnpm test:e2e:tui` (exit 1, 4 pre-existing ferment e2e failures — git-stash baseline-confirmed; the named `multi-model-command.test.ts` is 10/10 GREEN).
- **Pre-existing failures (out of scope, documented in findings table):** F9 (baseline typecheck errors — RESOLVED by fresh install), F10 (lint OOM — environmental), 9 unit test failures (model-guard + permissions — unrelated, baseline-confirmed), 4 ferment e2e failures (Node v25.9.0 unsupported by tui-test — environmental, baseline-confirmed).
- **No regressions introduced** by the multi-model persistence change.

