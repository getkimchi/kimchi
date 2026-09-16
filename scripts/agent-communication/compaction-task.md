# Repair continuation through mid-run compaction

A long non-Ferment tool chain crosses the context-compaction threshold while work remains. Print mode can exit 1 after the run is aborted, before the task continues. Interactive mode can require another user prompt. Repair this lifecycle so the original request stays pending through summarization and finishes its remaining work automatically.

## Required behavior

1. Continue the same awaited run after successful compaction. Later requests must use the compacted context, preserve tool-call/result pairs and perform remaining work once. Do not synthesize another user prompt or abort the task as part of ordinary compaction.
2. Compact only at a safe boundary. Current-turn unpaired calls defer compaction; abandoned calls before a new user turn must not block it forever. Keep the existing context threshold, settings toggle and active-Ferment behavior.
3. Support repeated effective compaction as a long session grows. Use successful, nonzero assistant usage to assess relief. Suppress repeated attempts during an ineffective pressure episode, then rearm after a below-threshold response. Avoid overlapping attempts. An error or aborted response is not evidence of relief.
4. Handle unavailable adapters, ordinary no-op outcomes, concurrent compaction, cancellation and session replacement. A late result from an old session must not notify or clear the new session's in-flight attempt. Preserve existing context/image guard behavior. Headless runs need useful diagnostics; routine cancellation must not schedule more work.
5. Add meaningful tests and verify the integrated result. Use the existing Pi integration and hooks; avoid a new scheduler, dependency changes, edits to `patches/`, or unrelated refactoring. Report remaining failures honestly.

## Shared workspace

Every participant can read all source, installed dependencies and task artifacts. The team has three initial workers and one subsequent repair worker; a solo agent performs the same repair itself.

- Lifecycle investigator owns `LIFECYCLE.md`. Trace the CLI-to-session-to-compaction lifecycle and report observed causes, safe options and evidence. Do not edit production or other workers' tests.
- Boundary investigator owns `BOUNDARIES.md` and `src/extensions/compaction-evaluation.test.ts`. Independently investigate tool pairing, cancellation, repeated pressure and session changes. Write useful behavioral checks and findings. Do not edit production or the implementation owner's tests.
- Implementation owner owns the repair in `src/extensions/model-guard.ts`, `src/extensions/compaction-thresholds.ts`, `src/tool-call-in-flight.ts`, `src/upstream-inline-compact-patch.ts`, their existing tests, new compaction-specific helpers/tests, and `IMPLEMENTATION.md`. Implement and verify the complete behavior. You are not alone; preserve the other workers' edits.

Write findings to the owned shared notes when established. Use available communication for an unresolved dependency or a finding another worker can act on. There is no posting or question quota. The parent may inspect notes and relay findings while workers run; after collecting all three results it reviews the combined work and assigns remaining gaps to one Repair owner. That worker takes ownership of the task-specific production files and tests, preserves useful checks, repairs remaining gaps and runs all three public checks. The parent collects its result without doing production repairs itself. No other workers or resumes.

Use ordinary TODOs and evidence notes. Worker Ferment is disabled in every arm. Maintain source compatibility and preserve the other owner's tests. Manifests, lockfiles, test/build configuration and this task are protected. Do not inspect original Git history, other trials, other projects, personal settings, credentials or skills. Do not install dependencies, research externally, commit or publish.

## Public verification

Dependencies are already available. Run the following separately and report their actual results:

```sh
pnpm run test:compaction-local
pnpm run typecheck
pnpm run check:compaction-style
```

The test script supplies a clean local test HOME. Use that same environment for focused test commands. Update old tests when they describe the behavior being repaired, while retaining useful regression coverage. The evaluator will separately build the result and exercise continuation and cancellation through a real process. Exact diagnostic wording is not a requirement.
