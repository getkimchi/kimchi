# Council: Refactor Plan

Council runs one pipeline — panel, analyst, synthesis — over two artifact types: a code patch and a
text answer. That pipeline is currently written twice, end to end. This plan collapses it to one.

Current size: 7,356 implementation lines, 7,705 test lines. `coordinator.ts` is 1,264 lines.

## The duplication

`coordinator.ts` contains the same algorithm twice — the text branch at 773-936 and the code branch
at 962-1169:

| Step | Text | Code |
| --- | ---: | ---: |
| degrade-to-lead helper | 774 | 962 |
| solver assignments from `panelSize` | 783 | 978 |
| concurrent solver loop, drop failures | 800 | 996 |
| fewer than two usable -> `panel_unavailable` | 846 | 1048 |
| analyst comparison | 876 | 1113 |
| synthesis | 901 | 1138 |
| degrade on each stage failure | 839, 894, 936 | 1038, 1106, 1131, 1169 |

The stage modules are doubled the same way, each half carrying its own packet builder, context
builder, prompt, and prompt/schema version pair:

- `panel.ts` — `runSolverStage` / `runTextSolverStage`
- `adjudicator.ts` — `runAnalystStage` / `runTextAnalystStage`
- `synthesis.ts` — `runSynthesisStage` / `runTextSynthesisStage` (plus `runCombinedStage`)

Only three things actually differ between the two paths:

1. **What a solver emits** — a `CandidatePatch` or a `CouncilAnswer`.
2. **How candidates are rendered for the analyst** — a runtime-computed diff, or the answer text.
3. **What happens to the synthesized result** — staged into a transaction and applied, or returned.

Everything else — panel sizing, concurrency, dropping unusable candidates, the two-candidate
minimum, anonymized hash-seeded shuffling, the five analysis buckets, and degrade-to-lead on every
failure — is identical.

## Target shape

One generic pipeline parameterized by artifact type:

```ts
interface FusionArtifact<T> {
  runSolver: (rt, req) => Promise<StructuredStageResult<T> | undefined>
  runAnalyst: (rt, req) => Promise<StructuredStageResult<FusionAnalysis> | undefined>
  runSynthesis: (rt, req) => Promise<StructuredStageResult<T> | undefined>
  render: (candidates: readonly T[], seed: string) => Promise<AnonymizedCandidate[]>
  usable: (candidates: readonly T[]) => Promise<readonly T[]>
}

runFusionPipeline<T>(artifact: FusionArtifact<T>, input, deps): Promise<FusionOutcome<T>>
```

`runFusionPipeline` owns: solver assignment and dispatch, concurrency, dropping failed or
unrenderable candidates, the `panel_unavailable` fallback, the analyst call, the synthesis call, and
uniform degrade-to-lead on any stage failure, deadline, or budget exhaustion. The coordinator then
has one call per branch plus the branch-specific ending (stage and apply, or return the answer).

The two artifact descriptors live next to their schemas — patch in `patch.ts`, answer in
`schemas.ts` — so a third artifact type would be a new descriptor, not a third copy of the pipeline.

## Steps

Each step lands as its own commit with `pnpm vitest run --dir src src/extensions/council`,
`pnpm typecheck`, `pnpm test`, and `pnpm lint` green.

### 1. Unify the stage modules

Collapse each doubled pair into one generic function taking the prompt, schema, parser, and version
constants as parameters. `panel.ts`, `adjudicator.ts`, and `synthesis.ts` each keep one exported
stage runner plus two small descriptor objects. Prompts and version constants stay distinct per
artifact — only the plumbing merges.

### 2. Extract `runFusionPipeline`

New `fusion-pipeline.ts`. Move the shared orchestration out of both coordinator branches. The
coordinator keeps: lead invocation, the deliberation decision, context freezing, and the two
endings. Target: `coordinator.ts` under 800 lines.

### 3. Unify the degrade helpers

`degradeToLeadAnswer` and `degradeToLeadCandidate` become one `degradeToLead` inside the pipeline,
parameterized by how the lead's own artifact is promoted. This is the safety-critical guarantee —
Council never does worse than its lead model — so it must exist once, not twice.

### 4. Trim the export surface

These are exported but referenced nowhere outside their defining module. Make them module-private
(or delete where genuinely dead):

`adjudicator.ts`: `FUSION_ANALYST_SYSTEM_PROMPT`, `hashSeededShuffle`, `solutionLabel`,
`renderAnonymizedCandidateDiffs`, `analystContext`, `TEXT_FUSION_ANALYST_RESULT_SCHEMA`,
`TEXT_FUSION_ANALYST_SYSTEM_PROMPT`, `textAnalystContext`
`synthesis.ts`: `COMBINED_PROMPT_VERSION`, `COMBINED_SCHEMA_VERSION`, `SYNTHESIS_SYSTEM_PROMPT`,
`COMBINED_SYSTEM_PROMPT`, `combinedSystemPrompt`, `synthesisPacket`
`schemas.ts`: `FUSION_ANALYSIS_LIST_MAX_ITEMS`, `FUSION_ANALYSIS_LIST_MAX_LENGTH`,
`parseDeterministicJson`
`coordinator.ts`: `resolveNoOpPublicMessage` · `patch.ts`: `CandidatePatchStageError` ·
`stage-runner.ts`: `REPAIR_SYSTEM_PROMPT`

Verify each against the whole repository, not just this directory, before changing it.

### 5. Consolidate test fixtures

Five fixture and harness modules total 580 lines with overlapping helpers:
`runtime-test-fixtures.ts` (24), `runtime-test-harness.ts` (157), `stage-test-harness.ts` (77),
`coordinator-transaction-fixtures.ts` (243), `coordinator-text-fusion-fixtures.ts` (79). Merge into
one harness plus per-area fixtures, with a single model-registry mock and a single redactor mock —
two competing `vi.mock` registrations for the same module have already caused one silent test
failure.

## What must not change

- Apply, rollback, settlement, the mutation guard, and catalog-only validation.
- The degrade-to-lead guarantee on every failure path.
- Solver independence: identical frozen packet, no cross-visibility.
- Analyst anonymization and hash-seeded shuffling.
- Budget, deadline, and concurrency enforcement.
- The `kimchi/council*` model contract and preset behaviour.

Behaviour is unchanged throughout: this is a structural refactor, and the existing tests are the
contract.
