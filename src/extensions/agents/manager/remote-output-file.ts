/**
 * streamRemoteToOutputFile — writes JSONL transcript entries from ACP events.
 *
 * Remote agents have no AgentSession, so streamToOutputFile (which subscribes
 * to session events) can't be used. This helper wraps AcpSessionCallbacks
 * to intercept events and write them to the output file incrementally.
 */

import { appendFileSync } from "node:fs"
import type { SessionNotification } from "@agentclientprotocol/sdk"
import type { AcpSessionCallbacks } from "../../../sandbox/worker/acp-client.js"

export function streamRemoteToOutputFile(
	innerCallbacks: AcpSessionCallbacks,
	cwd: string,
): {
	callbacks: AcpSessionCallbacks
	setOutputPath: (path: string, agentId: string) => void
	/** Flushes any buffered assistant text and pending entries. Call on cleanup/abort. */
	flushRemaining: () => void
	/** Resets text-slice state for a WS reattach. Call on activity_reset. */
	resetForReattach: () => void
} {
	let pendingAssistantText = ""
	/** Length of text already consumed by previous assistant messages.
	 *  ACP's onTextDelta sends full accumulated text for the turn — after a
	 *  tool call, only the text that came after should be shown. */
	let textOffset = 0
	/** Length of the last full text seen via onTextDelta — used to set
	 *  textOffset when a tool completes (pendingAssistantText is already
	 *  cleared by then, so we track the length separately). */
	let lastFullTextLength = 0
	let pendingToolCall: { title: string; rawOutput?: unknown; toolCallId?: string } | undefined
	let pendingRawInput: unknown
	let pendingRawInputId: string | undefined
	/** toolCallIds already forwarded to innerCallbacks as in_progress — used to
	 *  drop the ACP server's repeated in_progress notifications before they
	 *  reach the activity tracker. */
	const forwardedToolCalls = new Set<string>()
	let outputPath = ""
	let agentId = ""
	let pendingEntries: { type: string; message: unknown; timestamp: string }[] = []

	const setOutputPath = (path: string, id: string) => {
		outputPath = path
		agentId = id
	}

	// Entries are stored as objects and serialized at flush time, so that
	// agentId/outputPath are resolved by then even if the entry was created
	// before setOutputPath() was called.
	const writeEntry = (type: string, message: unknown) => {
		pendingEntries.push({ type, message, timestamp: new Date().toISOString() })
	}

	const flush = () => {
		if (!outputPath || pendingEntries.length === 0) return
		const serialized = pendingEntries
			.map((e) => {
				const entry = { isSidechain: true, agentId, type: e.type, message: e.message, timestamp: e.timestamp, cwd }
				return JSON.stringify(entry)
			})
			.join("\n")
		try {
			appendFileSync(outputPath, `${serialized}\n`, "utf-8")
		} catch (err) {
			console.error(
				`[remote-output-file] failed to write transcript entry: ${err instanceof Error ? err.message : String(err)}`,
			)
			// Do NOT clear pendingEntries on write failure — retain the failed batch
			// so the next flush attempt can retry.
			return
		}
		pendingEntries = []
	}

	/** Writes the single tool_use transcript entry for a tool call. Deferred to
	 *  completion/abort so repeated in_progress notifications don't duplicate it
	 *  and its input carries the fully streamed args. This means no entry exists
	 *  for a call while it runs — live progress is surfaced via the forwarded
	 *  activity callbacks, not this file. The entry's id prefers the ACP
	 *  toolCallId (so consumers can correlate tool_use and tool_result), falling
	 *  back to the display title only if no id arrived (should not happen in
	 *  practice — toolCallId is present from the first notification). */
	const writeToolUseEntry = (toolCall: { title: string; toolCallId?: string }) => {
		writeEntry("assistant", {
			role: "assistant",
			content: [
				{
					type: "tool_use",
					name: toolCall.title,
					id: toolCall.toolCallId ?? toolCall.title,
					input: pendingRawInput ?? {},
				},
			],
		})
	}

	/** Two channel ids refer to the same call when either side is missing
	 *  (can't disprove identity) or they match. */
	const sameCall = (a: string | undefined, b: string | undefined) => a === undefined || b === undefined || a === b

	/** Finalizes the pending tool call: writes its single tool_use entry plus a
	 *  toolResult (the real rawOutput if it arrived, otherwise the title as a
	 *  degraded placeholder), then clears the pending state. Does NOT flush —
	 *  the caller decides when to write to disk. */
	const finalizePendingToolCall = () => {
		if (!pendingToolCall) return
		writeToolUseEntry(pendingToolCall)
		const outputText =
			pendingToolCall.rawOutput != null ? JSON.stringify(pendingToolCall.rawOutput) : pendingToolCall.title
		writeEntry("toolResult", { role: "tool", content: [{ type: "text", text: outputText }] })
		pendingToolCall = undefined
		pendingRawInput = undefined
		pendingRawInputId = undefined
	}

	const callbacks: AcpSessionCallbacks = {
		onToolActivity: (activity) => {
			if (activity.status === "in_progress") {
				if (pendingAssistantText) {
					writeEntry("assistant", { role: "assistant", content: [{ type: "text", text: pendingAssistantText }] })
					pendingAssistantText = ""
				}
				if (pendingToolCall === undefined) {
					pendingToolCall = { title: activity.toolName, toolCallId: pendingRawInputId ?? activity.toolCallId }
				} else if (sameCall(activity.toolCallId, pendingToolCall.toolCallId)) {
					// Repeated in_progress for the same call — the ACP server re-sends
					// these as args/title stream in, and cloud agents broadcast them
					// periodically (~80ms) while a long-running tool executes. Only
					// refresh the display state; a transcript entry per repeat would
					// append thousands of identical tool_use lines to the .output
					// file (observed: 29MB files, ~99% duplicate lines).
					pendingToolCall.title = activity.toolName
					pendingToolCall.toolCallId ??= activity.toolCallId
				} else {
					// A different tool call started before this one completed
					// (parallel tool use, or a call abandoned without a completion
					// event) — finalize the pending call with a degraded result so
					// its entry keeps its own id and title, then start fresh.
					finalizePendingToolCall()
					pendingToolCall = { title: activity.toolName, toolCallId: pendingRawInputId ?? activity.toolCallId }
				}
			}
			// Ignores completions for a call that was already finalized via the
			// mismatch path above (late completion of a parallel/abandoned call).
			if (
				activity.status !== "in_progress" &&
				pendingToolCall &&
				sameCall(activity.toolCallId, pendingToolCall.toolCallId)
			) {
				finalizePendingToolCall()
				// Set textOffset so the next onTextDelta only shows text after this tool call.
				// Use lastFullTextLength (not pendingAssistantText.length) because
				// pendingAssistantText is cleared when the tool started.
				textOffset = lastFullTextLength
				flush()
			}
			// Forward to the activity tracker at most once per tool call: the ACP
			// server re-sends in_progress notifications for the same toolCallId as
			// args/title stream in. The transcript logic above tolerates every
			// repeat (it refreshes the pending tool's title), but downstream
			// consumers would stack a duplicate progress-line entry per repeat
			// ("run_command, run_command, …").
			if (activity.toolCallId) {
				if (activity.status === "in_progress") {
					if (forwardedToolCalls.has(activity.toolCallId)) return
					forwardedToolCalls.add(activity.toolCallId)
				} else {
					forwardedToolCalls.delete(activity.toolCallId)
				}
			}
			innerCallbacks.onToolActivity?.(activity)
		},
		onTextDelta: (delta, fullText) => {
			pendingAssistantText = fullText
			lastFullTextLength = fullText.length
			// Slice from textOffset so the activity tracker shows only the
			// current text segment, not the entire accumulated turn text.
			const relevantText = textOffset > 0 ? fullText.slice(textOffset) : fullText
			innerCallbacks.onTextDelta?.(delta, relevantText)
		},
		onTurnEnd: (turnCount) => {
			if (pendingAssistantText) {
				writeEntry("assistant", { role: "assistant", content: [{ type: "text", text: pendingAssistantText }] })
				pendingAssistantText = ""
			}
			textOffset = 0
			flush()
			innerCallbacks.onTurnEnd?.(turnCount)
		},
		onAssistantUsage: innerCallbacks.onAssistantUsage,
		onRawNotification: (params: SessionNotification) => {
			const u = params.update
			if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
				// Always capture the toolCallId so onToolActivity("in_progress") can use it
				// for the tool_use entry's id field. rawInput may arrive in a later
				// tool_call_update, but toolCallId is present from the first notification.
				if (u.toolCallId != null) {
					pendingRawInputId = u.toolCallId
					// Attach state to the pending call only when it plausibly belongs
					// to it — under parallel tool use, updates for a different call
					// must not overwrite the pending call's id or output.
					if (pendingToolCall && sameCall(pendingToolCall.toolCallId, u.toolCallId)) {
						pendingToolCall.toolCallId = u.toolCallId
					}
				}
				if (u.rawOutput != null && pendingToolCall && sameCall(pendingToolCall.toolCallId, u.toolCallId)) {
					pendingToolCall.rawOutput = u.rawOutput
				}
				if (u.rawInput != null) {
					// Only store rawInput if it belongs to the current pending tool call,
					// or if no tool call is pending yet (store it for the next "start").
					if (
						!pendingToolCall ||
						pendingToolCall.toolCallId === undefined ||
						pendingToolCall.toolCallId === u.toolCallId
					) {
						pendingRawInput = u.rawInput
					}
				}
			}
			innerCallbacks.onRawNotification?.(params)
		},
	}

	/** Flushes any buffered assistant text and pending entries on cleanup/abort. */
	const flushRemaining = () => {
		if (pendingAssistantText) {
			writeEntry("assistant", { role: "assistant", content: [{ type: "text", text: pendingAssistantText }] })
			pendingAssistantText = ""
		}
		// The tool_use entry is deferred to completion — on abort it has not
		// been written yet, so finalize writes it with whatever input
		// streamed in before the abort.
		finalizePendingToolCall()
		flush()
	}

	/** Resets text-slice state when the WS reattaches (activity_reset).
	 *  The fresh AcpSessionClient restarts full-text accumulation at "" — without
	 *  this, every post-reattach onTextDelta is sliced against stale pre-disconnect
	 *  offsets, producing empty or mid-string garbage.
	 *
	 *  Pending pre-disconnect state is DISCARDED, not flushed: after a reattach
	 *  the run finishes via recovery, which backfills the complete remote
	 *  entries from session.jsonl. A reattach-time flush would stamp the
	 *  partial segment with the local clock — duplicating it against the
	 *  backfill's dedup boundary, or degrading a pending tool to a title-only
	 *  result. Keeps outputPath/agentId. */
	const resetForReattach = () => {
		pendingAssistantText = ""
		pendingToolCall = undefined
		pendingEntries = []
		textOffset = 0
		lastFullTextLength = 0
		pendingRawInput = undefined
		pendingRawInputId = undefined
	}

	return { callbacks, setOutputPath, flushRemaining, resetForReattach }
}
