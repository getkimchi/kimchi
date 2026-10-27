import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { BASH_TIMEOUT_STATUS_PATTERN } from "../../agents/subagent-bash-clamp.js"
import { accumulateToolUsage, handleBashCumulativeMetrics, handleEditCumulativeMetrics } from "../accumulator.js"
import {
	computeLineChanges,
	computeWriteLines,
	extractFilePath,
	hashFilePath,
	inferLanguage,
	type ToolArgs,
} from "../helpers.js"
import type { TelemetryContext } from "../session-context.js"

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

export function resultSizeChars(result: unknown): number {
	const r = result as { content?: Array<{ text?: string }> } | null
	return (r?.content ?? []).reduce((sum, c) => sum + (c.text?.length ?? 0), 0)
}

// ---------------------------------------------------------------------------
// Tool execution handlers
// ---------------------------------------------------------------------------

export function handleToolExecutionStart(
	tm: TelemetryContext,
	event: { toolCallId: string; toolName: string; args: unknown },
): void {
	tm.pendingArgs.set(event.toolCallId, { toolName: event.toolName, args: event.args })
	tm.toolStartTimes.set(event.toolCallId, Date.now())
}

export function handleToolExecutionEnd(
	tm: TelemetryContext,
	ctx: ExtensionContext,
	event: { toolCallId: string; isError?: boolean; result?: unknown },
): void {
	const pending = tm.pendingArgs.get(event.toolCallId)
	// Release the clamp marker for this call regardless of outcome — the id
	// is only needed for the error-reclassification below.
	const wasClampedBashCall = tm.clampedBashCalls.delete(event.toolCallId)
	if (!pending) return
	tm.pendingArgs.delete(event.toolCallId)

	const { toolName, args: rawArgs } = pending
	const args = (rawArgs ?? {}) as ToolArgs
	const toolDurationMs = Date.now() - (tm.toolStartTimes.get(event.toolCallId) ?? tm.telemetryStartMs)

	// --- Tool usage & duration (all tools) ------------------------------------
	const startMs = tm.toolStartTimes.get(event.toolCallId) ?? Date.now()
	tm.toolStartTimes.delete(event.toolCallId)
	accumulateToolUsage(tm.cumulative, toolName, Date.now() - startMs)

	// --- Cumulative metrics ---------------------------------------------------
	if (toolName === "bash") {
		handleBashCumulativeMetrics(tm.cumulative, args)
	} else if (["edit", "multiedit", "patch", "write"].includes(toolName)) {
		handleEditCumulativeMetrics(tm.cumulative, toolName, args)
	}

	// --- Per-tool events ------------------------------------------------------

	const sizeChars = resultSizeChars(event.result)

	if (toolName === "read" && !event.isError) {
		const filePath = extractFilePath(args)
		if (filePath) {
			tm.emit(
				"tool_result",
				{
					tool_name: "read",
					success: true,
					duration_ms: toolDurationMs,
					tool_result_size_chars: sizeChars,
					turn_index: tm.turnIndex,
				},
				ctx,
			)
			tm.emit(
				"file_read",
				{
					language: inferLanguage(filePath),
					file_hash: hashFilePath(filePath),
					duration_ms: toolDurationMs,
					file_size_chars: sizeChars,
					// read_is_truncated signals that the caller passed a `limit` arg, capping
					// the number of lines returned. A limited read may have omitted content
					// that would otherwise have been returned. Reads without a limit return
					// the full file (up to the built-in size cap), so they are not truncated.
					read_is_truncated: !!args?.limit,
					turn_index: tm.turnIndex,
				},
				ctx,
			)
		}
	} else if (toolName === "write" && !event.isError) {
		const filePath = extractFilePath(args)
		tm.emit(
			"tool_result",
			{
				tool_name: "write",
				success: true,
				duration_ms: toolDurationMs,
				tool_result_size_chars: sizeChars,
				turn_index: tm.turnIndex,
			},
			ctx,
		)
		if (filePath) {
			tm.emit(
				"file_written",
				{
					language: inferLanguage(filePath),
					file_hash: hashFilePath(filePath),
					lines_added: computeWriteLines(args),
					duration_ms: toolDurationMs,
					turn_index: tm.turnIndex,
				},
				ctx,
			)
		}
	} else if (["edit", "multiedit", "patch"].includes(toolName) && !event.isError) {
		tm.emit(
			"tool_result",
			{
				tool_name: toolName,
				success: true,
				duration_ms: toolDurationMs,
				tool_result_size_chars: sizeChars,
				turn_index: tm.turnIndex,
			},
			ctx,
		)
		const filePath = extractFilePath(args)
		const changes = computeLineChanges(toolName, args)
		if (filePath) {
			tm.emit(
				"file_edited",
				{
					language: inferLanguage(filePath),
					file_hash: hashFilePath(filePath),
					lines_added: changes.added,
					lines_deleted: changes.removed,
					duration_ms: toolDurationMs,
					turn_index: tm.turnIndex,
				},
				ctx,
			)
		}
	} else if (toolName === "bash") {
		tm.emit(
			"tool_result",
			{
				tool_name: "bash",
				success: !event.isError,
				duration_ms: toolDurationMs,
				tool_result_size_chars: sizeChars,
				turn_index: tm.turnIndex,
			},
			ctx,
		)
		tm.emit(
			"command_executed",
			{
				command_type: "bash",
				exit_code: event.isError ? 1 : 0,
				duration_ms: toolDurationMs,
				bash_output_size_chars: sizeChars,
				turn_index: tm.turnIndex,
			},
			ctx,
		)
	}

	// --- Error tracking -------------------------------------------------------
	if (event.isError) {
		let fullMsg = ""
		if (
			event.result &&
			typeof event.result === "object" &&
			Array.isArray((event.result as { content?: unknown }).content)
		) {
			const result = event.result as { content: Array<{ type: string; text?: string }> }
			fullMsg = result.content
				.filter((c: { type: string; text?: string }) => c.type === "text")
				.map((c: { type: string; text?: string }) => c.text ?? "")
				.join("\n")
		}
		// A timeout killed by the subagent budget clamp is expected lifecycle
		// behavior, not a tool failure: the `subagent.bash_clamped` event
		// (emitted by the clamp channel handler when the clamp fired) already
		// reports it, and command_executed records the failed run. Suppress the
		// generic error record so error funnels stay anomaly-only. The match runs
		// against the FULL text — upstream appends the timeout status after the
		// command output, so a 300-char truncation would hide it on verbose
		// commands and emit a spurious tool_failure. Other bash failures on a
		// clamped call (e.g. non-zero exit before the timeout) still emit
		// normally.
		const clampedTimeout = wasClampedBashCall && BASH_TIMEOUT_STATUS_PATTERN.test(fullMsg)
		if (!clampedTimeout) {
			tm.emit(
				"error",
				{
					error_type: "tool_failure",
					tool_name: toolName,
					error_message: fullMsg.slice(0, 300) || "unknown tool error",
					turn_index: tm.turnIndex,
					...tm.getTraceAttributes(),
				},
				ctx,
			)
		}
	}
}
