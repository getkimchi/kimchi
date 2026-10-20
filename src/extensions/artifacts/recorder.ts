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
	// Anchor the mtime window at the message, not at the earliest result:
	// a long-running command writes its artifact early and finishes long
	// after — anchoring at result time can push that mtime outside the
	// window, while live (per-call start − skew) caught it.
	const windowStart = event.message.timestamp - CLOCK_SKEW_MS
	const seen = new Set<string>()
	const out: Artifact[] = []
	// Cap parity with live: sniffed (bash/powershell) entries evict
	// oldest-past-the-cap; intentional (write/edit/declared) always land.
	const sniffedKeys: string[] = []
	for (const result of event.toolResults) {
		const toolCall = toolCalls.get(result.toolCallId)
		if (!toolCall) continue
		const sniffed = toolCall.name === "bash" || toolCall.name === "powershell"
		for (const artifact of artifactsFromToolCall(
			toolCall.name,
			toolCall.arguments,
			// artifactsFromToolCall handles errored/partial shapes itself.
			{ content: result.content, details: result.details, isError: result.isError },
			cwd,
			{ windowStart },
		)) {
			if (sniffed && sniffedKeys.includes(artifact.path)) continue
			if (!sniffed && seen.has(artifact.path)) {
				// Intentional path promotes out of sniffed eviction eligibility.
				const idx = sniffedKeys.indexOf(artifact.path)
				if (idx >= 0) sniffedKeys.splice(idx, 1)
				continue
			}
			seen.add(artifact.path)
			if (sniffed) {
				sniffedKeys.push(artifact.path)
				if (sniffedKeys.length > MAX_TURN_RECORDED) {
					const evicted = sniffedKeys.shift()
					if (evicted !== undefined) {
						seen.delete(evicted)
						out.splice(
							out.findIndex((a) => a.path === evicted),
							1,
						)
					}
				}
			}
			out.push(artifact)
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
