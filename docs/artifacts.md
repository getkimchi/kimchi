# Artifacts (generated files)

Product behavior: when a turn produces a user-openable file (a report, export, generated document, plan, …), ACP clients render an "Open <file>" artifact link. Detection is conservative — false negatives preferred over false positives.

## Declaring artifacts from a tool

Tools that write files internally (bypassing the `write` tool) declare them in the result:

```ts
return {
	content: [...],
	details: { artifacts: [{ path: "/abs/path/to/report.md", name: "Report" }] },
}
```

- Shape follows ACP's `ToolCallLocation`; `name` is optional and defaults to the basename.
- Multiple entries allowed (capped per result at 32 — a buggy tool must not burst chunks); empty/malformed entries are skipped.
- Declared paths are authoritative (no freshness window), but existence is still verified on live turns. Only declare files the tool actually wrote.

Current producers: `submit_plan` and the ferment plan tools (they save `.kimchi/plans/*.md` inside `execute`).

## How detection works

Source of truth: `src/extensions/artifacts/detect.ts`. Three inputs per tool call, in order:

1. `details.artifacts` declarations (above).
2. `write`/`edit` tool args (`args.path`).
3. Bash/powershell detection — three sources per call, merged and deduped: redirect targets taken from `args.command` (`>`out.csv``, `>>`, via the taxonomy segmenter; stderr/fd forms excluded), file-path tokens sniffed from the result text, and command-scoped file snapshots. The snapshots cover allowlisted files directly in the effective working directory at execution start and end; newly created files and files whose size or mtime changed are candidates even when stdout is empty. Unchanged pre-existing files are excluded. The scope is deliberately shallow — no recursive tree or filesystem monitoring. Candidates from every source must pass an extension allowlist, path resolution (a leading `cd`/`Set-Location` segment redirects relative paths), a live existence check, and an mtime window: the file must have been touched at-or-after the tool call started. Tree-materializing git commands (checkout/merge/pull/…) are excluded — they refresh mtimes of files the agent did not author; invocations are unwrapped through common launchers (sudo/doas/env/time/…) first, and anything unrecognized degrades to plain sniffing. Nested tool executions with a
`parentToolCallId` are excluded from both live detection and recording so
subagent work cannot create live-only links; their tool-call UI is unchanged.
Only the filesystem-snapshot source requires an explicit
`clientCapabilities._meta["kimchi.dev"].artifacts: true` opt-in. With no
opt-in, live ACP and the recorder skip snapshot capture and replay omits
snapshot-marked entries. Existing write/edit, declared, redirect, and
output-sniffed artifacts retain their prior behavior on every surface.

## Emission and replay

- `TurnArtifactBuffer` flushes once per turn as `agent_message_chunk` `resource_link`s, attached to the turn's last text block, identically on live and replayed sessions. Text-less turns emit nothing.
- Live flush re-verifies existence, so files produced and deleted within one turn never link to ghosts; replay omits the check so artifact links survive for files created and later removed by subsequent turns.
- Chunks carry `_meta["kimchi.dev"].type = "artifact"` so clients can distinguish generated files from links the model merely references; capability is advertised in initialize as `artifacts: true`.

## Replay from recorded rows

The artifact-recorder extension (`src/extensions/artifacts/recorder.ts`, both
surfaces) runs the same detection at every turn end. For foreground shell
calls it claims the same cached pre-execution snapshot as live ACP through
the shared SessionManager and tool-call ID. The startup directory scan runs
once; each consumer releases its claim after diffing at tool execution end.
Turn-end detection remains the backward-compatible fallback for events without
execution-start captures. Results accumulate across the
agent run, and the recorder appends one row at `agent_settled` (once per prompt —
`agent_end` may fire multiple times per prompt across auto-retry/compaction
chains) — so the row lands after the prompt's last assistant message in the
session log, the same position the live ACP flush emits artifact chunks. The
row is a session custom entry: `{ customType: "kimchi-artifacts", data: { v: 1,
artifacts: [{ path, name, mimeType, sniffed, snapshot? }] } }` (`sniffed: true` =
output- or snapshot-derived, eviction-eligible at the cap the way live is;
optional `snapshot: true` marks filesystem-delta entries and is absent on
legacy rows) —
already stat-gated, deduped, label-resolved and capped (32). `pi.appendEntry` persists it into the
session log, so rows travel with branch trees (kill-branch, intersections)
exactly like the turns that produced them.

On replay, sighting a row adopts it through the same capability filter
(`TurnArtifactBuffer.adoptRecorded`): replay shows exactly what that client
was allowed to see live, while legacy and non-snapshot rows replay verbatim,
including links to files since deleted or renamed, and never ghosts that
never existed (candidates were stat-gated at record time). Replay does NOT
re-run detection — detection is live-only, stat-verified by construction;
a replayed session shows exactly the artifacts its rows recorded. Non-goals as before: backgrounded commands, subagent files.
