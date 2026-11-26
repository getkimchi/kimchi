import type { SessionNotification, ToolCallContent } from "@agentclientprotocol/sdk/unstable"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent"
import { ARTIFACTS_ENTRY_TYPE, type ArtifactsEntry } from "../../extensions/artifacts/recorder.js"
import { snapshotArtifactsOptedIn } from "../../extensions/artifacts/snapshot-policy.js"
import { parseToolCallId } from "../../sandbox/worker/acp-protocol.js"
import { BASH_BACKGROUND_SETTLE_MESSAGE_TYPE, isBashBackgroundSettleData } from "../../shared/bash-background-settle.js"
import { TurnArtifactBuffer } from "./artifact-links.js"
import { COMPACT_COMMAND_ENTRY_TYPE, isCompactCommandEntryData } from "./commands.js"
import { type ModelAttribution, modelAttributionFrom, modelMetaFor, spreadModelMeta } from "./model-attribution.js"
import type { SessionRecord } from "./session-record.js"
import { backgroundHandoffHandle, normalizeUnheldHandoffResult } from "./tool-calls/background.js"
import {
	BASH_CONTROL_WAIT_META_KEY,
	BASH_CONTROL_WAIT_TARGETS_ENTRY_TYPE,
	type BashControlBackgroundCommand,
	type BashControlWaitTargetsData,
	buildToolCall,
	buildToolCallUpdate,
	isHiddenToolCall,
} from "./tool-calls/utils.js"

/** Transport and presentation owned by the parent ACP adapter, without sharing process-global state. */
export interface TranscriptReplayHost {
	rootRecord(sessionId: string): SessionRecord | undefined
	send(params: SessionNotification): void
	allocateAcpToolCallId(record: SessionRecord, piToolCallId: string, toolName: string): string
	displayText(sessionId: string, text: string): string
	displayArgs(sessionId: string, toolName: string, args: Record<string, unknown>): Record<string, unknown>
	displayContent<T>(sessionId: string, content: T[] | undefined): T[] | undefined
	displayOptionalRecord(
		sessionId: string,
		value: Record<string, unknown> | undefined,
	): Record<string, unknown> | undefined
	userMessageText(content: unknown): string
	toolResultContent(result: unknown): ToolCallContent[]
	wireSafeToolResult(
		toolName: string,
		result: unknown,
		exposeManualHandoff: boolean,
	): Record<string, unknown> | undefined
	clientOptedIntoMcpOAuthTurn(): boolean
	stripAnsi(text: string): string
}

// Persisted assistant text from hide-thinking-aware models can contain ANSI styling
// around inner <think> content. Live TUI styling means "this is reasoning"; ACP plaintext
// has no such styling, so replay splits wrappers into agent_thought_chunk blocks.
// Build CSI regexes from String.fromCharCode to keep literal ESC bytes out of source.
const ANSI_ESC = String.fromCharCode(0x1b)
const ANSI_PATTERN = new RegExp(`${ANSI_ESC}\\[[0-9;]*[A-Za-z]`, "g")
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const ANSI_THINKING_OPEN_CODES = ["2", "38;2;102;102;102", "38;5;242"]
const ANSI_THINKING_PATTERN = new RegExp(
	`${ANSI_ESC}\\[(?:${ANSI_THINKING_OPEN_CODES.map(escapeRegExp).join("|")})m([\\s\\S]*?)(?:${ANSI_ESC}\\[(?:0|22)m|$)`,
	"g",
)
export function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "")
}

type ReplayTextPart = { kind: "text" | "thinking"; text: string }

function replayTextParts(text: string): ReplayTextPart[] {
	const parts: ReplayTextPart[] = []
	let lastIndex = 0
	for (const match of text.matchAll(ANSI_THINKING_PATTERN)) {
		const index = match.index ?? 0
		const before = stripAnsi(text.slice(lastIndex, index))
		if (before.length > 0) parts.push({ kind: "text", text: before })
		const thinking = stripAnsi(match[1] ?? "")
		if (thinking.length > 0) parts.push({ kind: "thinking", text: thinking })
		lastIndex = index + match[0].length
	}
	const after = stripAnsi(text.slice(lastIndex))
	if (after.length > 0) parts.push({ kind: "text", text: after })
	return parts
}

type ReplayToolResult = {
	content?: unknown
	isError: boolean
	// Pass-through `details` so the replay's tool_call_update rawOutput carries
	// the same shape as the live path's event.result (AgentToolResult includes
	// details). Clients keying UI off rawOutput.details would otherwise see a
	// thinner payload on replay.
	details?: unknown
	toolName?: string
	/**
	 * Settle facts only: the ACP id the settled call was announced under in
	 * the live session. Replay re-binds it so a client that kept its live
	 * rows across the replay sees ONE id for the call, terminal — not a
	 * duplicate row under a fresh id (wake-replay zombie).
	 */
	acpToolCallId?: string
}

// First pass over the branch: index tool results by their toolCallId so the
// replay walker can stitch each historical toolCall block to its terminal
// outcome (status + content) in O(1). Tool results land as separate message
// entries in the JSONL — without this map we'd have to scan forward inside
// the walker on every toolCall, turning replay into O(N²).
/**
 * Wait-target records persisted for completed bash_control calls (metadata
 * CustomEntry rows under BASH_CONTROL_WAIT_TARGETS_ENTRY_TYPE), queued per
 * pi toolCallId like tool results: a recycled id's targets belong to the
 * wait block whose completion recorded them.
 */
function isBashControlWaitTargetsData(data: unknown): data is BashControlWaitTargetsData {
	if (!data || typeof data !== "object") return false
	const d = data as { toolCallId?: unknown; commands?: unknown }
	return typeof d.toolCallId === "string" && Array.isArray(d.commands)
}

// SessionManagerEntry isn't re-exported by the pi package root, but the
// branch entry type is exactly what getBranch returns — derived, zero cast.
type BranchEntry = ReturnType<SessionManager["getBranch"]>[number]

function collectBashControlWaitTargets(entries: BranchEntry[]): Map<string, BashControlBackgroundCommand[][]> {
	const out = new Map<string, BashControlBackgroundCommand[][]>()
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== BASH_CONTROL_WAIT_TARGETS_ENTRY_TYPE) continue
		if (!isBashControlWaitTargetsData(entry.data)) continue
		const queued = out.get(entry.data.toolCallId) ?? []
		queued.push(entry.data.commands)
		out.set(entry.data.toolCallId, queued)
	}
	return out
}

/** FIFO-consume one queued wait-target record for a pi toolCallId. */
function takeReplayWaitTargets(
	map: Map<string, BashControlBackgroundCommand[][]>,
	toolCallId: string,
): BashControlBackgroundCommand[] {
	const queued = map.get(toolCallId)
	if (!queued || queued.length === 0) return []
	const out = queued.shift() ?? []
	if (queued.length === 0) map.delete(toolCallId)
	return out
}

// The queue is first-match-consumed per id: the model may recycle a pi id
// (a handed-off bash call, then a NEW call reusing the same id), and a
// last-wins map would pair the handed-off call's block with the recycled
// call's result — replaying a still-running call as completed, showing
// another call's content.
function collectToolResults(entries: unknown[]): Map<string, ReplayToolResult[]> {
	const out = new Map<string, ReplayToolResult[]>()
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue
		const e = entry as { type?: unknown; message?: unknown }
		if (e.type !== "message") continue
		const m = e.message as
			| {
					role?: unknown
					toolCallId?: unknown
					toolName?: unknown
					content?: unknown
					details?: unknown
					isError?: unknown
			  }
			| undefined
		if (m?.role !== "toolResult" || typeof m.toolCallId !== "string") continue
		const queued = out.get(m.toolCallId) ?? []
		queued.push({
			content: m.content,
			isError: m.isError === true,
			details: m.details,
			toolName: typeof m.toolName === "string" ? m.toolName : undefined,
		})
		out.set(m.toolCallId, queued)
	}
	return out
}

/** Consumed first-match from collectToolResults' per-id queue. */
function takeReplayToolResult(toolResults: Map<string, ReplayToolResult[]>, id: string): ReplayToolResult | undefined {
	const queued = toolResults.get(id)
	return queued && queued.length > 0 ? queued.shift() : undefined
}

/**
 * Settle outcomes persisted for held background calls (metadata-only
 * CustomEntry records — `type: "custom"` — under
 * BASH_BACKGROUND_SETTLE_MESSAGE_TYPE), queued per id exactly like results:
 * a recycled id's settle belongs to the block whose handoff it settled, so
 * replay consumes them FIFO off the block walk too.
 */
function collectBashBackgroundSettles(entries: BranchEntry[]): Map<string, ReplayToolResult[]> {
	const out = new Map<string, ReplayToolResult[]>()
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== BASH_BACKGROUND_SETTLE_MESSAGE_TYPE) continue
		if (!isBashBackgroundSettleData(entry.data)) continue
		const queued = out.get(entry.data.toolCallId) ?? []
		queued.push({
			content: entry.data.text.length > 0 ? [{ type: "text", text: entry.data.text }] : [],
			isError: entry.data.isError,
			details: entry.data.details,
			acpToolCallId: entry.data.acpToolCallId,
		})
		out.set(entry.data.toolCallId, queued)
	}
	return out
}

// Replay: walk the persisted transcript on the leaf path and emit
// session/update notifications per content block — text, thinking, tool
// calls. Tool results are paired with their originating toolCall by id so
// the historical tool render shape (tool_call + terminal tool_call_update)
// matches what live turns produce. Compaction / branch_summary /
// model_change entries emit nothing — using getBranch() (raw entries)
// instead of buildSessionContext() avoids surfacing compaction summaries
// as synthetic user messages. Custom entries: the artifact-recorder
// extension's rows are adopted as the turn's exact artifacts (recorded
// live, stat-gated), replacing replay-side re-derivation; compact-command
// rows re-emit their persisted text as a user message (the locally-handled
// command never became a session message); other custom entries still emit
// nothing.
//
// Notifications go straight from this method to conn.sessionUpdate; we do
// NOT replay through the AgentSession event emitter, so extensions like
// telemetryExtension don't double-count historical turns.
export function replayTranscript(
	session: AgentSession,
	record: SessionRecord | undefined,
	host: TranscriptReplayHost,
): void {
	const sessionId = session.sessionId
	const entries = session.sessionManager.getBranch()
	const toolResults = collectToolResults(entries)
	const replayWaitTargets = collectBashControlWaitTargets(entries)
	const settles = collectBashBackgroundSettles(entries)
	// Turn-scoped, matching the live path: artifacts accumulate across
	// the turn's assistant messages and flush once per turn, attached to
	// the turn's last text block id — right before the next user message,
	// or at branch end. Only block ids replay already emitted are used,
	// preserving messageId parity with live (seedBlockCounterFromBranch).
	const artifactBuffer = new TurnArtifactBuffer()
	const flushTurnArtifacts = () => {
		// verifyExists:false: replayed artifacts keep pointing at files that may
		// legitimately be gone (detection already skipped the on-disk check).
		for (const update of artifactBuffer.flush(
			record?.emittedModelMeta ?? host.rootRecord(sessionId)?.emittedModelMeta,
			{
				verifyExists: false,
			},
		)) {
			host.send({ sessionId, update })
		}
	}

	for (const entry of entries) {
		if (entry && entry.type === "custom") {
			const custom = entry as { customType?: unknown; data?: unknown }
			if (custom.customType === COMPACT_COMMAND_ENTRY_TYPE && isCompactCommandEntryData(custom.data)) {
				// A locally-handled /compact command never became a session
				// message, so re-surface it here as the user message the client
				// rendered when it sent the prompt (no live echo — see
				// runCompactCommand). Positioned like any user turn boundary:
				// the previous turn's artifacts flush before it.
				flushTurnArtifacts()
				host.send({
					sessionId,
					update: {
						sessionUpdate: "user_message_chunk",
						content: { type: "text", text: host.displayText(sessionId, custom.data.text) },
					},
				})
				continue
			}
			// Recorded artifact row (extension): adopt it for this turn — the
			// row is written once per prompt (at agent_settled), after the
			// prompt's last assistant message (live parity), and replaces what re-derivation sniffed
			// (exact: live detection was stat-gated).
			const data = custom.customType === ARTIFACTS_ENTRY_TYPE ? (custom.data as ArtifactsEntry | undefined) : undefined
			if (data?.v === 1 && Array.isArray(data.artifacts)) {
				artifactBuffer.adoptRecorded(data.artifacts, {
					includeSnapshotArtifacts: snapshotArtifactsOptedIn(session.sessionManager),
				})
			}
			continue
		}
		if (!entry || typeof entry !== "object" || entry.type !== "message") continue
		const msg = entry.message
		if (msg.role === "user") {
			// Turn boundary: the previous turn's artifacts flush before the
			// next user message renders.
			flushTurnArtifacts()
			const text = host.userMessageText(msg.content)
			if (!text) continue
			host.send({
				sessionId,
				update: {
					sessionUpdate: "user_message_chunk",
					content: { type: "text", text: host.displayText(sessionId, text) },
				},
			})
		} else if (msg.role === "assistant") {
			const lastTextBlockId = replayAssistantBlocks(
				sessionId,
				msg.content,
				toolResults,
				replayWaitTargets,
				settles,
				record,
				modelAttributionFrom(msg),
				host,
			)
			if (lastTextBlockId !== undefined) {
				artifactBuffer.noteTextBlock(lastTextBlockId, modelAttributionFrom(msg))
			}
		}
		// toolResult: handled inline alongside its originating toolCall above.
	}
	// Final turn in the branch: flush whatever it left behind.
	flushTurnArtifacts()
}

/**
 * Walk the persisted branch and count how many ACP content chunks the
 * replay would emit (text segments + dimmed text parts + non-redacted
 * thinking blocks). Sets `record.nextBlockId` so that:
 *   - replayTranscript emits the same messageIds a live turn would have
 *     for the historical blocks, and
 *   - any new block the user creates after the load gets a fresh, non-
 *     colliding id.
 *
 * Mirrors replayAssistantBlocks' emission logic exactly — coalescing
 * contiguous text blocks into one chunk, and gating thinking emission on
 * the hideThinkingBlock setting. If these drift, messageIds replayed
 * after a load won't line up with what the client saw during the live
 * turn.
 */
export function seedBlockCounterFromBranch(session: AgentSession, record: SessionRecord): void {
	const entries = session.sessionManager.getBranch()

	let count = 0
	for (const entry of entries) {
		if (entry?.type !== "message" || entry.message.role !== "assistant") continue

		let inTextSegment = false
		const countTextSegment = () => {
			if (!inTextSegment) {
				count++
				inTextSegment = true
			}
		}

		const content = entry.message.content
		for (const block of content) {
			if (block.type === "text") {
				if (!block.text) continue
				countTextSegment()
				for (const part of replayTextParts(block.text)) {
					if (part.kind === "thinking") count++
				}
			} else if (block.type === "thinking") {
				inTextSegment = false
				if (block.redacted || !block.thinking) continue
				count++
			} else {
				// toolCall / unknown: replay flushes the text buffer before
				// emitting the structural block, which terminates any open
				// text segment.
				inTextSegment = false
			}
		}
	}
	record.nextBlockId = count + 1
}

function replayAssistantBlocks(
	sessionId: string,
	content: AssistantMessage["content"],
	toolResults: Map<string, ReplayToolResult[]>,
	replayWaitTargets: Map<string, BashControlBackgroundCommand[][]>,
	settles: Map<string, ReplayToolResult[]>,
	record: SessionRecord | undefined,
	attribution: ModelAttribution,
	host: TranscriptReplayHost,
): string | undefined {
	if (!Array.isArray(content)) return
	// Allocates a fresh session-unique messageId for every emitted chunk
	// and leaves it off the wire if the SessionRecord isn't loaded (e.g.
	// the unit-test harness wiring a partial replay path).
	const nextMessageId = () => {
		if (!record) return undefined
		return `km.${record.nextBlockId++}`
	}
	// Last agent_message block id emitted for this message, returned so
	// the caller can register it as the turn's artifact attachment point
	// (thinking chunks are excluded).
	let lastTextMessageId: string | undefined
	// Artifacts are replayed strictly from recorded rows by the caller
	// (replayTranscript) — replay never re-runs live detection.
	// Buffer contiguous text blocks so a single assistant message renders as
	// one agent_message_chunk per natural text segment — emit the full
	// message as a single chunk, no per-token chunking. When a thinking or
	// toolCall block interrupts the run, flush the buffered text first so
	// ordering relative to those structural blocks is preserved.
	let textBuffer = ""
	const flushText = () => {
		if (textBuffer.length === 0) return
		const messageId = nextMessageId()
		lastTextMessageId = messageId ?? lastTextMessageId
		const modelMeta = modelMetaFor(record?.emittedModelMeta, messageId, attribution)
		host.send({
			sessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: host.displayText(sessionId, textBuffer) },
				...(messageId !== undefined ? { messageId } : {}),
				...spreadModelMeta(modelMeta),
			},
		})
		textBuffer = ""
	}
	for (const block of content) {
		if (!block || typeof block !== "object") continue
		const b = block
		if (b.type === "text") {
			const text = (b as { text?: unknown }).text
			if (typeof text !== "string" || text.length === 0) continue
			for (const part of replayTextParts(text)) {
				if (part.kind === "text") {
					textBuffer += part.text
				} else if (part.kind === "thinking") {
					flushText()
					const messageId = nextMessageId()
					const modelMeta = modelMetaFor(record?.emittedModelMeta, messageId, attribution)
					host.send({
						sessionId,
						update: {
							sessionUpdate: "agent_thought_chunk",
							content: { type: "text", text: host.displayText(sessionId, part.text) },
							...(messageId !== undefined ? { messageId } : {}),
							...spreadModelMeta(modelMeta),
						},
					})
				}
			}
		} else if (b.type === "thinking") {
			flushText()
			const thinking = (b as { thinking?: unknown; redacted?: unknown }).thinking
			const redacted = (b as { redacted?: unknown }).redacted === true
			// Redacted thinking has no plaintext to surface — the encrypted
			// payload only matters for multi-turn provider continuity.
			if (redacted || typeof thinking !== "string" || thinking.length === 0) continue
			const messageId = nextMessageId()
			const modelMeta = modelMetaFor(record?.emittedModelMeta, messageId, attribution)
			host.send({
				sessionId,
				update: {
					sessionUpdate: "agent_thought_chunk",
					content: { type: "text", text: host.displayText(sessionId, host.stripAnsi(thinking)) },
					...(messageId !== undefined ? { messageId } : {}),
					...spreadModelMeta(modelMeta),
				},
			})
		} else if (b.type === "toolCall") {
			flushText()
			const tc = b
			const upstreamId = typeof tc.id === "string" ? tc.id : undefined
			const name = typeof tc.name === "string" ? tc.name : undefined
			if (!upstreamId || !name) continue
			const args = (tc.arguments ?? {}) as Record<string, unknown>
			if (isHiddenToolCall(name, args)) continue
			const result = takeReplayToolResult(toolResults, upstreamId)
			// The recorded wait targets (custom entry, FIFO per id like the
			// results) restore the historical cohort as _meta — the recorded
			// args alone cannot name what a handle-less wait blocked on.
			const waitTargets = takeReplayWaitTargets(replayWaitTargets, upstreamId)
			// Background reload overlay: the recorded result of a backgrounded
			// bash call is its pre-exit HANDOFF. When the process is still running
			// in this harness process (registry and held map are in-process), replay
			// presents the call as STILL RUNNING under the same ACP id the live flow
			// handed out — the exit watcher flips it to its final status when the
			// process exits, and the client never sees a running process flip back
			// and forth across its reload. An UN-held handoff result (cross-process
			// reload, fresh record) falls back to the recorded terminal status, so
			// its replayed details are normalized to not contradict that status.
			const handoffHandle = result ? backgroundHandoffHandle(result) : undefined
			const heldAcpId = handoffHandle !== undefined ? record?.heldBackgroundToolCalls.get(handoffHandle) : undefined
			const replayResult =
				result && handoffHandle !== undefined && heldAcpId === undefined ? normalizeUnheldHandoffResult(result) : result
			// A persisted settle overrides the pre-exit handoff for a call replayed
			// terminal: without it a FAILED process replays as completed with no
			// exit outcome, because the handoff records isError false and no exit
			// code. A persisted settle belongs to a HANDOFF result only — a recycled
			// upstream id can pair a same-id plain result with a later handoff,
			// and consuming the settle on the plain block would slam the
			// background outcome (and the rebound live id) onto the wrong call.
			// Consumed FIFO like the results: the handoff's settle follows its
			// block in the branch, so pairing holds per occurrence — a recycled
			// id's settle belongs to the block whose handoff it settled.
			const settleResult =
				heldAcpId === undefined && handoffHandle !== undefined ? takeReplayToolResult(settles, upstreamId) : undefined
			const finalResult = settleResult ?? replayResult
			// A call settled before this replay carries its live ACP id in the
			// persisted settle: re-bind that id so the re-announcement updates
			// the row the client already holds instead of opening a zombie
			// duplicate under a fresh id. The numeric suffix must also stay
			// ahead of record.nextToolCallId — a replay allocating counters
			// from 0 could otherwise mint the same id for a LATER call.
			if (record && heldAcpId === undefined && settleResult?.acpToolCallId !== undefined) {
				record.toolCallIdMap.set(upstreamId, settleResult.acpToolCallId)
				const seqN = parseToolCallId(settleResult.acpToolCallId)?.seq
				if (seqN !== undefined && Number.isSafeInteger(seqN))
					record.nextToolCallId = Math.max(record.nextToolCallId, seqN + 1)
			}
			const preservedToolId = record?.childToolIdHistory?.takeForReplay(upstreamId)
			if (record && preservedToolId !== undefined) record.toolCallIdMap.set(upstreamId, preservedToolId)
			const acpToolCallId = heldAcpId
				? heldAcpId.acpToolCallId
				: record
					? host.allocateAcpToolCallId(record, upstreamId, name)
					: upstreamId
			// No persisted result → the call never finished (interrupted mid
			// turn). "failed" is the closest terminal status; leaving the call
			// in_progress would hang the client's spinner forever on replay —
			// except a held background process, whose exit watcher owns finality.
			const status: "in_progress" | "completed" | "failed" =
				heldAcpId !== undefined
					? "in_progress"
					: finalResult
						? finalResult.isError
							? "failed"
							: "completed"
						: "failed"
			host.send({
				sessionId,
				update: buildToolCall({
					toolName: name,
					toolCallId: acpToolCallId,
					piToolCallId: tc.id,
					status,
					// Historical args stay as recorded: live-registry info
					// here would name today's cohort as this old wait's targets.
					// The recorded cohort (if any) comes back via _meta below.
					rawInput: host.displayArgs(sessionId, name, args),
					_meta: waitTargets.length > 0 ? { [BASH_CONTROL_WAIT_META_KEY]: { commands: waitTargets } } : undefined,
					cwd: record?.cwd,
				}),
			})
			host.send({
				sessionId,
				update: buildToolCallUpdate({
					toolCallId: acpToolCallId,
					piToolCallId: tc.id,
					status,
					content: host.displayContent(sessionId, finalResult ? host.toolResultContent(finalResult) : []),
					rawOutput: host.displayOptionalRecord(
						sessionId,
						finalResult ? host.wireSafeToolResult(name, finalResult, host.clientOptedIntoMcpOAuthTurn()) : undefined,
					),
				}),
			})
			// The branch may contain multiple toolCalls with the same upstream id
			// (e.g., across a compaction boundary). Drop the mapping after replaying
			// each call so the next one with the same upstream id gets a fresh id.
			record?.toolCallIdMap.delete(upstreamId)
		}
	}
	// Trailing text after the last structural block (or a text-only message)
	// still needs to land — flushText is a no-op when the buffer is empty.
	flushText()
	return lastTextMessageId
}
