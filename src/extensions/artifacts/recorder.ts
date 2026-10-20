// Artifact recorder: persists per-turn artifact detection as a session
// custom entry, so any client that replays the session log can re-emit
// exactly the artifacts the live turn produced instead of re-deriving
// them from raw tool output (which can only approximate live: files may
// be deleted and data-shaped tokens masquerade as paths). See
// docs/artifacts.md — "Replay from recorded rows".
//
// Runs on both surfaces (TUI + ACP): sessions authored anywhere carry
// rows. ctx.sessionManager.getCwd() is the (possibly cd-navigated)
// session cwd, mirroring what the ACP server's live path tracks. ACP
// replay hydrates only these rows (no re-derivation): sessions recorded
// before the recorder shipped emit no artifacts on reload.

import { extname } from "node:path"
import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent"
import { ARTIFACT_EXTENSIONS, type Artifact, artifactsFromToolCall } from "./detect.js"

export const ARTIFACTS_ENTRY_TYPE = "kimchi-artifacts"

export interface RecordedArtifact {
	path: string
	name: string
	mimeType: string | null
}

export interface ArtifactsEntry {
	v: 1
	artifacts: RecordedArtifact[]
}

// Mirrors MAX_TURN_ARTIFACTS (ACP layer, not exported): the recorder
// applies the same bound so a burst turn can't write an oversized row.
const MAX_TURN_RECORDED = 32

// Slack between the tool result timestamp and the artifact mtime —
// mirrors the ACP live path's clock-skew allowance.
const CLOCK_SKEW_MS = 5000

function turnArtifacts(event: TurnEndEvent, cwd: string): Artifact[] {
	if (event.message.role !== "assistant") return []
	const toolCalls = new Map<string, { name: string; arguments: Record<string, unknown> }>()
	for (const block of event.message.content) {
		if (block.type === "toolCall") toolCalls.set(block.id, block)
	}
	if (toolCalls.size === 0) return []
	const results = event.toolResults
	const timestamps = results.map((r) => r.timestamp).filter((t): t is number => typeof t === "number")
	const windowStart = (timestamps.length > 0 ? Math.min(...timestamps) : event.message.timestamp) - CLOCK_SKEW_MS
	const seen = new Set<string>()
	const out: Artifact[] = []
	for (const result of results) {
		const toolCall = toolCalls.get(result.toolCallId)
		if (!toolCall) continue
		for (const artifact of artifactsFromToolCall(
			toolCall.name,
			toolCall.arguments,
			// artifactsFromToolCall handles errored/partial shapes itself.
			{ content: result.content, details: result.details, isError: result.isError },
			cwd,
			{ windowStart },
		)) {
			if (seen.has(artifact.path)) continue
			seen.add(artifact.path)
			out.push(artifact)
			if (out.length >= MAX_TURN_RECORDED) return out
		}
	}
	return out
}

export function artifactRecorderExtension(pi: ExtensionAPI) {
	pi.on("turn_end", (event, ctx: ExtensionContext) => {
		let artifacts: Artifact[]
		try {
			artifacts = turnArtifacts(event, ctx.sessionManager.getCwd())
		} catch {
			return // Persistence must never break a turn.
		}
		if (!artifacts.length) return
		const entry: ArtifactsEntry = {
			v: 1,
			artifacts: artifacts.map((a) => ({
				path: a.path,
				name: a.name,
				mimeType: ARTIFACT_EXTENSIONS[extname(a.path).toLowerCase()] ?? null,
			})),
		}
		pi.appendEntry(ARTIFACTS_ENTRY_TYPE, entry)
	})
}
