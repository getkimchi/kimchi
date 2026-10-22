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
3. Bash/powershell detection — two sources per call, merged and deduped: redirect targets taken from `args.command` (`>`out.csv``, `>>`, via the taxonomy segmenter; stderr/fd forms excluded), and file-path tokens sniffed from the result text. Candidates must pass an extension allowlist, path resolution (a leading `cd`/`Set-Location` segment redirects relative paths), a live existence check, and an mtime window: the file must have been touched at-or-after the tool call started. Tree-materializing git commands (checkout/merge/pull/…) are excluded — they refresh mtimes of files the agent did not author; invocations are unwrapped through common launchers (sudo/doas/env/time/…) first, and anything unrecognized degrades to plain sniffing.

## Emission and replay

- `TurnArtifactBuffer` flushes once per turn as `agent_message_chunk` `resource_link`s, attached to the turn's last text block, identically on live and replayed sessions. Text-less turns emit nothing.
- Live flush re-verifies existence, so files produced and deleted within one turn never link to ghosts; replay omits the check so artifact links survive for files created and later removed by subsequent turns.
- Chunks carry `_meta["kimchi.dev"].type = "artifact"` so clients can distinguish generated files from links the model merely references; capability is advertised in initialize as `artifacts: true`.

## Replay from recorded rows

The artifact-recorder extension (`src/extensions/artifacts/recorder.ts`, both
surfaces) runs the same detection at every turn end, accumulates across the
agent run, and appends the result once at `agent_settled` (once per prompt —
`agent_end` may fire multiple times per prompt across auto-retry/compaction
chains) — so the row lands after the prompt's last assistant message in the
session log, the same position the live ACP flush emits artifact chunks. The
row is a session custom entry: `{ customType: "kimchi-artifacts", data: { v: 1,
artifacts: [{ path, name, mimeType, sniffed }] } }` (`sniffed: true` =
bash/powershell-sniffed, eviction-eligible at the cap the way live is) —
already stat-gated, deduped, label-resolved and capped (32). `pi.appendEntry` persists it into the
session log, so rows travel with branch trees (kill-branch, intersections)
exactly like the turns that produced them.

On replay, sighting a row adopts it verbatim (`TurnArtifactBuffer
.adoptRecorded`): replay shows exactly what the live turn emitted,
including links to files since deleted or renamed, and never ghosts that
never existed (candidates were stat-gated at record time). Replay does NOT
re-run detection — detection is live-only, stat-verified by construction;
a replayed session shows exactly the artifacts its rows recorded. Non-goals as before: backgrounded commands, subagent files.
