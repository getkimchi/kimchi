// Artifact recorder: persists per-turn artifact detection as a session
// custom entry, so any client that replays the session log can re-emit
// exactly the artifacts the live turn produced instead of re-deriving
// them from raw tool output (which can only approximate live: files may
// be deleted and data-shaped tokens masquerade as paths). See
// docs/artifacts.md — "Replay from recorded rows".
//
// Runs on both surfaces (TUI + ACP): sessions authored anywhere carry
// rows. ctx.sessionManager.getCwd() is the (possibly cd-navigated)
// session cwd, mirroring what the ACP server's live path tracks. The
// ACP replay hydrators only these rows (no re-derivation): sessions
// recorded before the recorder shipped emit no artifacts on reload.

import { extname } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
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

type TurnEndEventShape = {
	message: {
		role?: string
		timestamp?: number
		content?: Array<{ type: string; id?: string; arguments?: Record<string, unknown> }>
	}
	toolResults?: Array<{
		toolCallId?: string
		toolName?: string
		content?: unknown
		details?: unknown
		isError?: boolean
		timestamp?: number
	}>
}

function turnArtifacts(event: TurnEndEventShape, cwd: string): Artifact[] {
	const message = event.message
	if (message.role !== "assistant" || !message.content) return []
	const argsByToolCallId = new Map<string, unknown>()
	for (const block of message.content) {
		if (block.type === "toolCall" && block.id) argsByToolCallId.set(block.id, block.arguments)
	}
	if (argsByToolCallId.size === 0) return []
	const results = event.toolResults ?? []
	const timestamps = results.map((r) => r.timestamp).filter((t): t is number => typeof t === "number")
	const windowStart =
		(timestamps.length > 0 ? Math.min(...timestamps) : (message.timestamp ?? Date.now())) - CLOCK_SKEW_MS
	const seen = new Set<string>()
	const out: Artifact[] = []
	for (const result of results) {
		if (!result.toolCallId || argsByToolCallId.get(result.toolCallId) === undefined) continue
		if (result.isError) continue
		for (const artifact of artifactsFromToolCall(
			// The message drives tool identity; fall back to the result's.
			result.toolName ?? "",
			argsByToolCallId.get(result.toolCallId),
			{ content: result.content, details: result.details, isError: false },
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
			artifacts = turnArtifacts(event as TurnEndEventShape, ctx.sessionManager.getCwd())
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
