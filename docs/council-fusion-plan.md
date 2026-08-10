# Council: Fusion Implementation Plan

Turns the pipeline in [council-fusion-design.md](council-fusion-design.md) into landable steps.
Each step keeps `pnpm vitest run --dir src src/extensions/council`, `pnpm typecheck`, and `pnpm test`
green, and lands as its own commit.

## What already exists and is reused unchanged

- `transaction-runtime.ts`, `transaction-tools.ts` — overlay, mutation guard, apply/settle state
  machine, rollback, post-apply check bookkeeping by catalog ID.
- `validation.ts` — project check catalog, expected-output filtering, git drift canary.
- `physical-invoker.ts`, `run-context.ts` — model pools, fallback, budgets, deadline, recursion guard.
- `stage-runner.ts` — invoke → parse → repair → fallback → cache for any structured stage.
- `context-compiler.ts` — evidence compilation, fail-closed redaction, byte bounding.
- `cache.ts`, `telemetry.ts`, `progress-ui.ts`, `stream.ts`, `config.ts`, `resume-dispatch.ts`.

## Step 1 — Patch schema and local diffing

New module `patch.ts`:

- `CandidatePatchSchema` — the structured output every solver and the synthesis stage emits:
  a list of file operations, each one of
  `{op:"create", path, content}` / `{op:"update", path, content}` / `{op:"delete", path}` /
  `{op:"rename", path, new_path}`, where `content` is the complete new file text.
- `renderPatchDiff(base, patch)` — computes a unified diff from real base bytes against the proposed
  content. Runtime-computed; a model never authors a diff that another stage reads.
- `stagePatch(transaction, patch)` — applies a validated patch into a `ChangeTransaction` overlay
  using the existing staged-mutation paths, so all current path/traversal/binary/drift guards apply
  unchanged.

Constraints: paths normalized and workspace-relative; traversal, symlinks, directories, binary
content, and unknown ops rejected; total patch bounded by the existing transaction size limits
(files, lines, bytes).

## Step 2 — Solver stage

Replace the reviewer role in `panel.ts` with the solver:

- One prompt: solve the objective against the frozen context, emit a complete patch. No mention of
  other models, no critique framing.
- Runs through `runStructuredStage` with `CandidatePatchSchema`, so caching, one repair, and pool
  fallback come for free. Bump the prompt/schema version constants so no stale cache entry can be
  reused across the change.
- N solvers dispatched concurrently under the existing concurrency cap; a solver that fails or
  returns an unparseable patch after repair is dropped, and the run continues with the remainder.
  Fewer than two usable patches means no comparison is possible: fall back to the lead's own patch
  with a `panel_unavailable` degraded reason.

The lead's own patch is panel member one. It is produced from the frozen context before any solver
output exists, which is what makes it independent.

## Step 3 — Analyst stage

Replace the judge in `adjudicator.ts` with the analyst:

- Input: objective, constraints, and every candidate patch rendered by `renderPatchDiff`, labelled
  anonymously and in hash-seeded shuffled order so position and model identity carry no weight.
- Output schema: `{consensus, contradictions, partial_coverage, unique_insights, blind_spots,
  required_checks}` — the five Fusion buckets, plus 1–3 validation check IDs drawn from the catalog
  when the turn changes code.
- Prompt frames the task as comparison, explicitly not merging and not rewriting code.
- `required_checks` validation stays exactly as it is: IDs must exist in the catalog, and the runtime
  resolves each ID to its exact argument vector.

## Step 4 — Synthesis stage

- Input: objective, the analysis, and the candidate patches.
- Output: `CandidatePatchSchema` — the final patch, written by the lead pool so final authorship sits
  with the context-holding model.
- Staged through `stagePatch` as the single transaction candidate, then handed to the existing
  apply → checks → settle path untouched.
- Consensus is the safe core, contradictions are where synthesis must choose, unique insights are
  what it should fold in. It writes one coherent patch, never a union of others.

For `council-fast`, analysis and synthesis are one call: the same stage returns the comparison and
the final patch together.

## Step 5 — Wire the coordinator

`coordinator.ts` orchestrates: explore → freeze → panel → analyst → synthesis → promote.

- The lead runs with read tools through the host agent loop as it does now. A turn that stages no
  changes and needs no review answers directly and streams.
- When the lead produces a code candidate, freeze the compiled context and fan out. The lead's
  candidate becomes panel member one rather than the promoted patch.
- Delete what the review chain needed: revision gating and reopening, revision verification,
  per-finding severity handling, and the review-policy branches that only distinguished reviewer
  roles. Triage that skips deliberation for trivial diffs (doc-only, rename-only, tiny single-file
  edits) stays — it is the deliberation decision, and it is what keeps cheap turns cheap.
- Progress labels become: exploring, solving (n of N), comparing, writing, applying, checking.

## Step 6 — Configuration and presets

- `panelSize` per preset: fast 2, normal 3, deep 5. `KIMCHI_COUNCIL_PANEL_SIZE` overrides.
- `KIMCHI_COUNCIL_PANEL_MODELS` supplies the solver pool; members are drawn from it cyclically when
  the panel is larger than the list, so a panel can legitimately contain the same model twice —
  self-fusion is a supported configuration, not a degenerate case.
- `KIMCHI_COUNCIL_ANALYST_MODEL` (with fallbacks) selects the analyst; it defaults to the first panel
  model.
- Retire the per-role reviewer variables; keep `KIMCHI_COUNCIL_LEAD_*` for the lead and synthesis.
- Fast folds analysis and synthesis into one call; normal and deep keep them separate.

## Step 7 — Tests and docs

- Behavior-level tests: given N solver patches, assert which patch is staged, that solvers never see
  each other's output, that a failed check rolls back, that fewer than two usable patches degrades
  rather than fails, and that a text-only turn costs one call and streams.
- Delete tests that pinned reviewer roles, judge dispositions, and the revision loop.
- Rewrite `docs/council.md` around the fusion contract: presets, panel configuration, environment
  variables, and the pipeline diagram.

## Budgets

Per code turn, at the default presets: fast ~3 calls, normal ~5, deep ~7. Text-only turns cost one.
The whole-run deadline, aggregate token caps, and concurrency cap continue to bound every turn, and
solver dispatch respects the existing concurrency limit.
