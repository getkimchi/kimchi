// Artifact recorder: persists artifact detection as a session custom
// entry, one row per prompt, so any client that replays the session
// log can re-emit exactly the artifacts the live run produced instead of
// re-deriving them from raw tool output (which can only approximate live:
// files may be deleted and data-shaped tokens masquerade as paths). See
// docs/artifacts.md — "Replay from recorded rows".
//
// Runs on both surfaces (TUI + ACP): sessions authored anywhere carry
// rows. ctx.cwd is the session-relative path anchor, mirroring what the ACP
// server's live path tracks; the SessionManager is only the shared-snapshot
// scope. ACP
// replay hydrates these rows (never re-derives from output): sessions
// without rows emit no artifacts on reload.

import { statSync } from "node:fs"
import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent"
import { clearDeclaredArtifactEmissions, wasDeclaredArtifactEmitted } from "./declared-emissions.js"
import {
	type Artifact,
	type ArtifactFileSnapshot,
	type ArtifactSnapshotClaim,
	artifactsFromToolCall,
	observeDirectArtifactWrite,
	releaseArtifactSnapshot,
	snapshotArtifactFiles,
} from "./detect.js"
import { snapshotArtifactsOptedIn } from "./snapshot-policy.js"

export const ARTIFACTS_ENTRY_TYPE = "kimchi-artifacts"

export interface RecordedArtifact {
	path: string
	name: string
	mimeType: string | null
	/** bash/powershell output or snapshot-derived: eviction-eligible at the run cap. */
	sniffed: boolean
	/** Additive v1 marker; absent on legacy and non-snapshot rows. */
	snapshot?: boolean
}

export interface ArtifactsEntry {
	v: 1
	artifacts: RecordedArtifact[]
}

// Mirrors MAX_TURN_ARTIFACTS (ACP layer, not exported): the recorder
// applies the same run-scoped bound — live's TurnArtifactBuffer is
// turn(prompt)-scoped the same way — so a burst run can't write an
// oversized row.
const MAX_RUN_RECORDED = 32

// Slack between the tool result timestamp and the artifact mtime —
// mirrors the ACP live path's clock-skew allowance.
const CLOCK_SKEW_MS = 5000

type DetectedArtifact = Artifact & { sniffed: boolean }

type PendingArtifactCall = {
	toolName: string
	args: unknown
	cwd: string
	startedAt: number
	fileSnapshot: ArtifactFileSnapshot
	snapshotClaim: ArtifactSnapshotClaim
}

// Run-scoped artifact accumulator: detection runs per turn_end, but the
// row is written once per prompt (agent_settled) so it lands AFTER the
// prompt's last assistant message in the session log — matching the live
// ACP flush, which emits artifact chunks after the last agent message.
class RunArtifactAccumulator {
	private readonly seen = new Set<string>()
	private readonly sniffedKeys: string[] = []
	private readonly out: DetectedArtifact[] = []

	add(artifact: DetectedArtifact): void {
		const sniffed = artifact.sniffed
		const existing = this.seen.has(artifact.path) ? this.out.findIndex((a) => a.path === artifact.path) : -1
		if (sniffed && existing >= 0) return
		if (!sniffed && existing >= 0) {
			// Intentional provenance replaces snapshot/sniffed provenance as
			// well as eviction eligibility, matching the live buffer.
			this.out[existing] = artifact
			const idx = this.sniffedKeys.indexOf(artifact.path)
			if (idx >= 0) this.sniffedKeys.splice(idx, 1)
			return
		}
		this.seen.add(artifact.path)
		if (sniffed) {
			this.sniffedKeys.push(artifact.path)
			if (this.sniffedKeys.length > MAX_RUN_RECORDED) {
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

	/** Snapshot and reset atomically. */
	drain(): DetectedArtifact[] {
		const out = this.out.slice()
		this.seen.clear()
		this.sniffedKeys.length = 0
		this.out.length = 0
		return out
	}
}

function detectTurnArtifacts(
	event: TurnEndEvent,
	cwd: string,
	acc: RunArtifactAccumulator,
	completedShellCalls: Map<string, Artifact[]>,
): void {
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
		const completed = completedShellCalls.get(result.toolCallId)
		if (completed) {
			completedShellCalls.delete(result.toolCallId)
			for (const artifact of completed) {
				acc.add({ ...artifact, sniffed: artifact.origin === "sniffed" || artifact.origin === "snapshot" })
			}
			continue
		}
		for (const artifact of artifactsFromToolCall(
			toolCall.name,
			toolCall.arguments,
			// artifactsFromToolCall handles errored/partial shapes itself.
			{ content: result.content, details: result.details, isError: result.isError },
			cwd,
			{ windowStart },
		)) {
			acc.add({ ...artifact, sniffed: artifact.origin === "sniffed" || artifact.origin === "snapshot" })
		}
	}
}

export function artifactRecorderExtension(pi: ExtensionAPI) {
	const acc = new RunArtifactAccumulator()
	const pendingShellCalls = new Map<string, PendingArtifactCall>()
	const pendingProducerClaims = new Map<string, ArtifactSnapshotClaim>()
	const completedShellCalls = new Map<string, Artifact[]>()

	pi.on("tool_execution_start", (event, ctx) => {
		try {
			const startedAt = Date.now()
			const cwd = ctx.cwd
			const snapshotClaim = {
				scope: ctx.sessionManager,
				toolCallId: event.toolCallId,
				consumer: "recorder" as const,
				capture: !event.parentToolCallId && snapshotArtifactsOptedIn(ctx.sessionManager),
			}
			const fileSnapshot = snapshotArtifactFiles(event.toolName, event.args, cwd, snapshotClaim)
			// Explicit paths are known before a write starts; nested and ineligible
			// calls never capture a snapshot but still track producer ambiguity.
			observeDirectArtifactWrite(event.toolName, event.args, cwd)
			if (!fileSnapshot) {
				pendingProducerClaims.set(event.toolCallId, snapshotClaim)
				return
			}
			pendingShellCalls.set(event.toolCallId, {
				toolName: event.toolName,
				args: event.args,
				cwd,
				startedAt,
				fileSnapshot,
				snapshotClaim,
			})
		} catch {
			// Detection must never prevent the command from executing.
		}
	})

	pi.on("tool_execution_end", (event) => {
		const producerClaim = pendingProducerClaims.get(event.toolCallId)
		pendingProducerClaims.delete(event.toolCallId)
		if (producerClaim) releaseArtifactSnapshot(producerClaim)
		if (event.parentToolCallId) return
		try {
			const pending = pendingShellCalls.get(event.toolCallId)
			pendingShellCalls.delete(event.toolCallId)
			if (!pending) return
			try {
				// Match live ACP and the legacy detector: failed calls produce no
				// artifacts. Consume an explicit empty result so turn_end cannot
				// fall back and re-admit a file created before the failure.
				completedShellCalls.set(
					event.toolCallId,
					event.isError
						? []
						: artifactsFromToolCall(pending.toolName, pending.args, event.result, pending.cwd, {
								windowStart: pending.startedAt,
								fileSnapshot: pending.fileSnapshot,
							}),
				)
			} finally {
				releaseArtifactSnapshot(pending.snapshotClaim)
			}
		} catch {
			// The legacy turn_end path remains as a conservative fallback.
		}
	})

	pi.on("turn_end", (event, ctx: ExtensionContext) => {
		try {
			detectTurnArtifacts(event, ctx.cwd, acc, completedShellCalls)
		} catch {
			// Persistence must never break a turn; partial state stays buffered.
		}
	})

	// `agent_settled`, not `agent_end`: after `agent_end` Pi may still
	// auto-retry, auto-compact and retry, or run queued follow-up messages —
	// each chained run emits its own agent_end (see the feedback extension
	// for the same trap). agent_settled fires once per prompt, serially
	// after the last assistant message's message_end persistence, so the row
	// lands after the prompt's final agent message — the exact position the
	// live ACP flush (finalizeTurn) emits artifact chunks. One row per
	// prompt even when several turns produced artifacts.
	pi.on("agent_settled", (_event, ctx) => {
		const artifacts = acc.drain().filter((artifact) => {
			// A declaration that actually chipped mid-turn retains its link after
			// deletion. If no text block existed for emitNow, live retains no such
			// chip: apply the same existence check to avoid recording a replay ghost.
			if (artifact.origin === "declared" && wasDeclaredArtifactEmitted(ctx.sessionManager, artifact.path)) {
				return true
			}
			try {
				return statSync(artifact.path).isFile()
			} catch {
				return false
			}
		})
		clearDeclaredArtifactEmissions(ctx.sessionManager)
		for (const claim of pendingProducerClaims.values()) releaseArtifactSnapshot(claim)
		pendingProducerClaims.clear()
		for (const pending of pendingShellCalls.values()) releaseArtifactSnapshot(pending.snapshotClaim)
		pendingShellCalls.clear()
		completedShellCalls.clear()
		if (!artifacts.length) return
		const entry: ArtifactsEntry = {
			v: 1,
			artifacts: artifacts.map((a) => ({
				path: a.path,
				name: a.name,
				mimeType: a.mimeType ?? null,
				sniffed: a.sniffed,
				...(a.origin === "snapshot" ? { snapshot: true } : {}),
			})),
		}
		pi.appendEntry(ARTIFACTS_ENTRY_TYPE, entry)
	})
}
