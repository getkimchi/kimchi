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
- Multiple entries allowed; empty/malformed entries are skipped.
- Declared paths are authoritative (no freshness window), but existence is still verified on live turns. Only declare files the tool actually wrote.

Current producers: `submit_plan` and the ferment plan tools (they save `.kimchi/plans/*.md` inside `execute`).

## How detection works

Source of truth: `src/modes/acp/tool-calls/artifacts.ts`. Three inputs per tool call, in order:

1. `details.artifacts` declarations (above).
2. `write`/`edit` tool args (`args.path`).
3. Bash/powershell detection — two sources per call, merged and deduped: redirect targets taken from `args.command` (`>`out.csv``, `>>`, via the taxonomy segmenter; stderr/fd forms excluded), and file-path tokens sniffed from the result text. Candidates must pass an extension allowlist, path resolution (a leading `cd`/`Set-Location` segment redirects relative paths), a live existence check, and an mtime window: the file must have been touched at-or-after the tool call started. Tree-materializing git commands (checkout/merge/pull/…) are excluded — they refresh mtimes of files the agent did not author; invocations are unwrapped through common launchers (sudo/doas/env/time/…) first, and anything unrecognized degrades to plain sniffing.

## Emission and replay

- `TurnArtifactBuffer` flushes once per turn as `agent_message_chunk` `resource_link`s, attached to the turn's last text block, identically on live and replayed sessions. Text-less turns emit nothing.
- Live flush re-verifies existence, so files produced and deleted within one turn never link to ghosts; replay omits the check so artifact links survive for files created and later removed by subsequent turns.
- Chunks carry `_meta["kimchi.dev"].type = "artifact"` so clients can distinguish generated files from links the model merely references; capability is advertised in initialize as `artifacts: true`.

## Replay divergence (accepted v1 trade-off)

Replay re-runs detection without the live gates — no mtime window and no existence check — because the session record stores tool results, not tool-call start times, and replayed files may legitimately be gone. Consequence: historical read-only output (`cat report.md`, `git log --name-only`) can surface artifact links on replay that the live turn suppressed. Exact parity would require persisting the per-turn detection result, which is intentionally out of scope; the zero-prefix-token filter (`wrote a .md file`) removes the most visible nonsense in both paths. Non-goals as before: backgrounded commands, subagent files.
