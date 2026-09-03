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
} {
	let pendingAssistantText = ""
	let pendingToolCall: { title: string; rawOutput?: unknown; toolCallId?: string } | undefined
	let pendingRawInput: unknown
	let pendingRawInputId: string | undefined
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

	const callbacks: AcpSessionCallbacks = {
		onToolActivity: (activity) => {
			if (activity.status === "in_progress") {
				if (pendingAssistantText) {
					writeEntry("assistant", { role: "assistant", content: [{ type: "text", text: pendingAssistantText }] })
					pendingAssistantText = ""
				}
				pendingToolCall = { title: activity.toolName, toolCallId: pendingRawInputId }
				// Use the actual tool-call ID (from the ACP toolCallId) for the
				// tool_use entry's id field so consumers can correlate tool_use and
				// tool_result. Fall back to the display title only if no id arrived
				// (should not happen in practice — toolCallId is present from the
				// first tool_call notification).
				writeEntry("assistant", {
					role: "assistant",
					content: [
						{
							type: "tool_use",
							name: activity.toolName,
							id: pendingRawInputId ?? activity.toolName,
							input: pendingRawInput ?? {},
						},
					],
				})
			}
			if (activity.status !== "in_progress" && pendingToolCall) {
				const outputText =
					pendingToolCall.rawOutput != null ? JSON.stringify(pendingToolCall.rawOutput) : activity.toolName
				writeEntry("toolResult", { role: "tool", content: [{ type: "text", text: outputText }] })
				pendingToolCall = undefined
				pendingRawInput = undefined
				pendingRawInputId = undefined
				flush()
			}
			innerCallbacks.onToolActivity?.(activity)
		},
		onTextDelta: (delta, fullText) => {
			pendingAssistantText = fullText
			innerCallbacks.onTextDelta?.(delta, fullText)
		},
		onTurnEnd: (turnCount) => {
			if (pendingAssistantText) {
				writeEntry("assistant", { role: "assistant", content: [{ type: "text", text: pendingAssistantText }] })
				pendingAssistantText = ""
			}
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
					if (pendingToolCall) pendingToolCall.toolCallId = u.toolCallId
				}
				if (u.rawOutput != null && pendingToolCall) {
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
		if (pendingToolCall) {
			const outputText =
				pendingToolCall.rawOutput != null ? JSON.stringify(pendingToolCall.rawOutput) : pendingToolCall.title
			writeEntry("toolResult", { role: "tool", content: [{ type: "text", text: outputText }] })
			pendingToolCall = undefined
			pendingRawInput = undefined
			pendingRawInputId = undefined
		}
		flush()
	}

	return { callbacks, setOutputPath, flushRemaining }
}
