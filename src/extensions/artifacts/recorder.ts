// Artifact recorder: persists artifact detection as a session custom
// entry, one row per agent run, so any client that replays the session
// log can re-emit exactly the artifacts the live run produced instead of
// re-deriving them from raw tool output (which can only approximate live:
// files may be deleted and data-shaped tokens masquerade as paths). See
// docs/artifacts.md — "Replay from recorded rows".
//
// Runs on both surfaces (TUI + ACP): sessions authored anywhere carry
// rows. ctx.sessionManager.getCwd() is the (possibly cd-navigated)
// session cwd, mirroring what the ACP server's live path tracks. ACP
// replay hydrates these rows (never re-derives from output): sessions
// without rows emit no artifacts on reload.

import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent"
import { type Artifact, artifactsFromToolCall } from "./detect.js"

export const ARTIFACTS_ENTRY_TYPE = "kimchi-artifacts"

export interface RecordedArtifact {
	path: string
	name: string
	mimeType: string | null
	/** bash/powershell-sniffed: eviction-eligible at the turn cap. */
	sniffed: boolean
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

type DetectedArtifact = Artifact & { sniffed: boolean }

// Run-scoped artifact accumulator: detection runs per turn_end, but the
// row is written once per agent run (agent_end) so it lands AFTER the
// run's last assistant message in the session log — matching the live ACP
// flush, which emits artifact chunks after the last agent message. Writing
// at the first producing turn_end misplaced the row between that turn's
// tool results and the run's final agent message.
class RunArtifactAccumulator {
	private readonly seen = new Set<string>()
	private readonly sniffedKeys: string[] = []
	private readonly out: DetectedArtifact[] = []

	add(artifact: DetectedArtifact): void {
		const sniffed = artifact.sniffed
		const existing = this.seen.has(artifact.path) ? this.out.findIndex((a) => a.path === artifact.path) : -1
		if (sniffed && existing >= 0) return
		if (!sniffed && existing >= 0) {
			// Intentional path promotes out of sniffed eviction eligibility.
			this.out[existing] = { ...this.out[existing], sniffed: false }
			const idx = this.sniffedKeys.indexOf(artifact.path)
			if (idx >= 0) this.sniffedKeys.splice(idx, 1)
			return
		}
		this.seen.add(artifact.path)
		if (sniffed) {
			this.sniffedKeys.push(artifact.path)
			if (this.sniffedKeys.length > MAX_TURN_RECORDED) {
				const evicted = this.sniffedKeys.shift()
				if (evicted !== undefined) {
					this.seen.delete(evicted)
					this.out.splice(
						this.out.findIndex((a) => a.path === evicted),
						1,
					)
				}
			}
		}
		this.out.push(artifact)
	}

	list(): DetectedArtifact[] {
		return this.out
	}

	clear(): void {
		this.seen.clear()
		this.sniffedKeys.length = 0
		this.out.length = 0
	}
}

function detectTurnArtifacts(event: TurnEndEvent, cwd: string, acc: RunArtifactAccumulator): void {
	if (event.message.role !== "assistant") return
	const toolCalls = new Map<string, { name: string; arguments: Record<string, unknown> }>()
	for (const block of event.message.content) {
		if (block.type === "toolCall") toolCalls.set(block.id, block)
	}
	if (toolCalls.size === 0) return
	// Anchor the mtime window at the message, not at the earliest result:
	// a long-running command writes its artifact early and finishes long
	// after — anchoring at result time can push that mtime outside the
	// window, while live (per-call start − skew) caught it.
	const windowStart = event.message.timestamp - CLOCK_SKEW_MS
	for (const result of event.toolResults) {
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
			acc.add({ ...artifact, sniffed: artifact.origin === "sniffed" })
		}
	}
}

export function artifactRecorderExtension(pi: ExtensionAPI) {
	const acc = new RunArtifactAccumulator()

	pi.on("turn_end", (event, ctx: ExtensionContext) => {
		try {
			detectTurnArtifacts(event, ctx.sessionManager.getCwd(), acc)
		} catch {
			// Persistence must never break a turn; partial state stays buffered.
		}
	})

	// The row lands after the run's final assistant message: pi dispatches
	// events serially and the message is persisted on its message_end, which
	// precedes agent_end. Rows stay one-per-run even when several turns
	// produced artifacts, mirroring the live per-turn flush.
	pi.on("agent_end", () => {
		// Snapshot: list() exposes the live buffer; clearing before the map
		// would empty the very array being serialized.
		const artifacts = [...acc.list()]
		if (!artifacts.length) return
		acc.clear()
		const entry: ArtifactsEntry = {
			v: 1,
			artifacts: artifacts.map((a) => ({
				path: a.path,
				name: a.name,
				mimeType: a.mimeType ?? null,
				sniffed: a.sniffed,
			})),
		}
		pi.appendEntry(ARTIFACTS_ENTRY_TYPE, entry)
	})
}
