# Review panel, reconciliation, and wrap-up

`src/extensions/review-panel/` owns panel selection, scheduling, durable run
state, deterministic fallback output, semantic reconciliation, and idempotent
wrap-up. It does not register a command or change print-mode/ACP/TUI behavior.
It uses stage 2 targets and stage 3's real `ReviewRunner` for every child.

## Coordinator API

```ts
runReviewPanel(options: RunReviewPanelOptions): Promise<ReviewPanelResult>
wrapUpReviewPanel(options: WrapUpReviewPanelOptions): Promise<ReviewPanelResult>
resolveReviewPanel(input?: ReviewPanelSelectionInput): ResolvedReviewPanel
loadReviewPanelState(outputDir: string): Promise<ReviewPanelRunState>
```

A surface adapter resolves a target first, parses the manifest deadline to an
absolute epoch-millisecond timestamp, and calls the same fresh-panel path:

```ts
const parsed = parseReviewTargetArgs(args)
const target = await resolveReviewTarget(parsed as ExplicitReviewRequest, {
  root: checkoutPath,
  contextDir,
})
const result = await runReviewPanel({
  ctx,
  pi,
  target,
  outputDir,
  ...parsed.panel,
  requiredLenses, // trusted invoking-session policy, never reviewed-tree input
  checkDefinitions,
  deadline: Date.parse(manifest.deadline),
  signal,
  onProgress(update) {
    // Render pinned scope from target.scope, lens reasons/status/counts,
    // reconciliation state, and structured coverage in either UI surface.
  },
  onChildUsage(usage, signal) {
    // Synchronous enqueue; no promise to cancel. signal is also provided for I/O callbacks.
  },
  parentToolCallId,
})
```

`ReviewPanelResult` exposes `state`, `progress`, final `findings`, `summary`,
and final artifact paths. Stage 5 renders coverage from the result rather than
inferring completeness from finding count. `onChildUsage` is buffered and
flushed at reserve entry, completion, and once more after runner cleanup.
Repeated differential flushes contain only deltas. `onChildUsage` receives
`(usage, signal)` and must honour the signal on delivery timeout and closure so
pending I/O, sockets, requests, or timers cannot retain the process. Stage 5's
emitter is a synchronous stdout enqueue, so it has no asynchronous delivery to
cancel. Other asynchronous output must finish inside `D - 100ms`. A delta that
cannot be delivered by then is not awaited or replayed; the coordinator aborts
its delivery signal. `onUsageDropped` receives its writer, actual
provider/model, complete delta, and `reason: "deadline"`; the coordinator also
logs a matching warning. Subscriptions are then detached; usage emitted by a
late child after that final closure is not replayed by a later wrap-up. The
child session is intentionally not transferred, so that post-detach traffic is
a documented accounting loss. `onProgress` and `onUsageDropped` are synchronous;
spawned agents already receive cancellation through their runner options.

For resumed wrap-up, stage 5 reloads no reviewers and supplies the **new**
manifest's deadline. It verifies the rest of the identity explicitly:

```ts
const result = await wrapUpReviewPanel({
  ctx,
  pi,
  outputDir: manifest.output_dir,
  expected: {
    baseSha: manifest.base_sha,
    headSha: manifest.head_sha,
    checkoutPath: manifest.checkout_path,
    contextDir: manifest.context_dir,
    outputDir: manifest.output_dir,
  },
  checkDefinitions,
  deadline: Date.parse(manifest.deadline),
  onProgress,
  onChildUsage,
})
```

A changed deadline is valid. Any other identity mismatch fails before verifier
creation or response publication. Wrap-up rescans every reviewer writer because a
kill can happen after its append but before the fallback checkpoint. Queued or
running lenses become cancelled and no reviewer is launched. Within one
process, a registry tracks live review children per output directory. Wrap-up
cancels them and waits with the same bounded path as reserve. Final publication
rescans every writer, so an accepted submission that arrived after the initial
scan is included. Across processes, wrap-up assumes the previous process has
exited or been killed (APA kills its process group before resuming). A
submission after the final publication-boundary rescan is recovered by the next
wrap-up.

## Selection

The default panel is `spec`, `standards`, `operational`, `adversarial`.
`--lens` repeats and deduplicates, `--all` includes `security`, and their
combination is invalid. Explicit concurrency must be a positive integer;
effective slots are `min(requested, selected lens count)`. Required lenses carry
their trusted policy reason in durable state and progress updates.

A lens is `submitted` only after a non-error terminal assistant stop reason and
completion evidence: a valid summary or at least one accepted candidate. A
terminal provider error or a run with no accepted submission is `failed`, with
`no_submission` in its durable error. Accepted candidates remain usable when a
later provider call fails, but coverage stays partial.

## Durable run state

Atomic `review-output/state/panel.json` uses `review-panel/v1`:

- `scope`: the complete pinned stage 2 scope, including base/head/tip SHAs,
  snapshot ref, checkout/context paths, and anchor-map path;
- `contextDir`, `outputDir`: external artifact roots;
- `panel`: CLI selection, resolved lens focus/writer/reasons, required lenses,
  requested concurrency, and effective `slotCount`;
- `lenses`: `queued | running | submitted | failed | cancelled`, candidate IDs,
  error, worktree path, and completed command evidence;
- `candidates`: stable source IDs and full original `review-finding/v1` records;
- `reconciliation`: `pending | fallback | reconciled`, reason, candidate-input
  SHA-256 digest, complete ordered provenance per final finding, truncated-source
  count, and validated semantic output when applicable;
- `coverage`: complete/partial, unfinished lenses, selected/submitted/failed/
  cancelled lens counts, accepted candidate count, final finding count, and
  `provenance_truncated_count` for IDs emitted only in durable provenance.

Every update is serialized and written to a mode-0600 temp file followed by
rename. Stage 3's `routine-checks.json` remains the shared command evidence.
`reconciliation-request.json` is the immutable verifier input for one digest.

## Candidate and final checkpoints

Reviewer files remain `findings/<lens>.jsonl`. Every ingest revalidates writer,
sequence, stable ID, all fields, and anchors against the original
`commentable-lines.json`; a temporary test or other reviewer-created line cannot
be anchored. New accepted candidates are persisted before a fallback write.

`findings/final.jsonl` is created empty before reviewer launch. It is then
atomically replaced as candidates arrive using only exact-duplicate collapsing.
Provenance is emitted in `derived_from`. Ranking uses the published finding's
severity (`critical`, `warning`, `info`), path, line, type, description, and
suggestion, then semantic/source-ID tie-breaks before applying the finding cap.
Rank assigns contiguous `seq` and deterministic `final-<seq>` IDs, replacing
provisional ranks as new candidates arrive. The same finalized input produces
the same bytes, including deterministic earliest-source `created_at`.
Checkpoint packing enforces 50 findings, 16 KiB description/suggestion fields,
50 provenance IDs, NUL-free validated fields, and 1 MiB total output. When more
than 50 sources support one finding, only the first 50 sorted IDs appear in
`derived_from`; the complete list remains in durable panel state and the
remainder is counted in structured coverage. One defect is never split just to
work around provenance size.

## Semantic reconciliation

The verifier gets a fresh stage 3 verifier worktree plus the saved candidate,
worktree, command, routine-check, and optional comments paths. Thread history,
including the previous revision when supplied, is also embedded in the
reconciliation request. It must return one `review-reconciliation/v1` JSON
object with `findings`, `decisions`, and `threads`.

Code rejects the entire semantic result unless:

- every candidate occurs exactly once as retained, merged, or rejected with a
  reason, and decisions have exact bidirectional agreement with each finding's
  `candidate_ids`;
- group membership, fields, severities, anchors, field/count/file limits and
  schema keys are valid against the original snapshot;
- equivalent re-review candidates are rejected and linked to their thread;
- every thread passes stage 1's reply fields, supported verdicts, and producer-
  supplied `is_ours`/`mentions_bot` scope validation.

Distinct defects on the same line stay separate. Invalid, cancelled, or expired
verification leaves the current fallback untouched and records its reason.
Reply batches are deduplicated against existing records and prevalidated as one
aggregate against the 30-reply and 1 MiB limits. Overflow rejects the semantic
result before findings or semantic state change and retains fallback. The whole
reply JSONL file is replaced atomically, so no partially appended batch exists.

A validated semantic result replaces fallback findings before replies or the
summary are written. Reconciliation for an identical input digest is cached, so
repeat wrap-up cannot change IDs or invoke another verdict. Existing identical
thread replies are not appended again.

`summary/final.json` remains `review-summary/v1` with optional structured
`coverage` and is written last. When its logical content is unchanged, the
coordinator preserves the existing file rather than refreshing `created_at`.
Findings, summaries, and replies are therefore byte-stable across wrap-up.

## Reserve timing

Given deadline `D`, reconciliation reserve begins at `D - min(120s, time left)`.
Entry synchronously prevents queued launches and closes stage 3's check queue to
new checks; launch has a second reserve check immediately before
`spawnReviewer`. Active reviewers get up to 30 seconds to submit, followed by a
bounded one-second post-cancellation settlement wait. Every wait is capped by
`D - H`, where `H` is the supported, non-negative `finalWriteHeadroomMs`
coordinator option (default 5000 ms). Stage 5 can tune it for workspace and
filesystem performance. Its default follows a local 100-write benchmark of
900,001-byte atomic files (5.07 ms median, 5.91 ms p95, 12.70 ms maximum),
leaving substantial room for a complete artifact set on a slower workspace.
Verifier execution receives a timeout ending at that same cutoff and is
raced independently against settlement. A verifier that observes cancellation
but remains pending produces fallback within the headroom; its eventual result
and usage are ignored after closure. Every timer-based race in the panel, live
child lease, cleanup, and stage 3 queue path uses a shared helper that clears
its timer when either side wins, so completed local processes are not retained
by abandoned timeouts.

If `D - H` has passed at panel start, no reviewer launches. If cancellation
does not settle in time, running lenses become cancelled and finalization uses
the last durable checkpoint instead of waiting for workers or cleanup. Runner
cleanup itself is bounded by `D`; retained stage 3 manifests remain available
for recovery. Without enough verifier time, fallback finalization still writes
findings and coverage.

Before either entry point returns, it closes coordinator-owned publication and
drains queued state updates. Closed stores ignore subsequent writes. Late
reviewers cannot ingest candidates, create checkpoints, change panel state,
emit progress, or replace final artifacts; only their per-lens source writer
files may change. Stage 3's check queue is closed before awaiting active
agents: results settling before closure may persist within the bound, while no
check result persists afterward. Cancellation and the check queue's wait share
the runner's bounded cleanup. A subsequent `wrapUpReviewPanel` opens a new
store and recovers saved lens submissions.

A complete zero-finding result requires every selected lens to submit and
finalization to succeed. Otherwise coverage is partial and lists every
unfinished lens. No time-limit wording is emitted; the consumer owns that.
