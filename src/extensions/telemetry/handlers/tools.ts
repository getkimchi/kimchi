import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
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
	telemetry: TelemetryContext,
	event: { toolCallId: string; toolName: string; args: unknown },
): void {
	telemetry.pendingArgs.set(event.toolCallId, { toolName: event.toolName, args: event.args })
	telemetry.toolStartTimes.set(event.toolCallId, Date.now())
}

export function handleToolExecutionEnd(
	telemetry: TelemetryContext,
	ctx: ExtensionContext,
	event: { toolCallId: string; isError?: boolean; result?: unknown },
): void {
	const pending = telemetry.pendingArgs.get(event.toolCallId)
	if (!pending) return
	telemetry.pendingArgs.delete(event.toolCallId)

	const { toolName, args: rawArgs } = pending
	const args = (rawArgs ?? {}) as ToolArgs
	const toolDurationMs = Date.now() - (telemetry.toolStartTimes.get(event.toolCallId) ?? telemetry.processStartMs)

	// --- Tool usage & duration (all tools) ------------------------------------
	const startMs = telemetry.toolStartTimes.get(event.toolCallId) ?? Date.now()
	telemetry.toolStartTimes.delete(event.toolCallId)
	accumulateToolUsage(telemetry.cumulative, toolName, Date.now() - startMs)

	// --- Cumulative metrics ---------------------------------------------------
	if (toolName === "bash") {
		handleBashCumulativeMetrics(telemetry.cumulative, args)
	} else if (["edit", "multiedit", "patch", "write"].includes(toolName)) {
		handleEditCumulativeMetrics(telemetry.cumulative, toolName, args)
	}

	// --- Per-tool events ------------------------------------------------------

	const sizeChars = resultSizeChars(event.result)

	if (toolName === "read" && !event.isError) {
		const filePath = extractFilePath(args)
		if (filePath) {
			telemetry.emit(
				"tool_result",
				{
					tool_name: "read",
					success: true,
					duration_ms: toolDurationMs,
					tool_result_size_chars: sizeChars,
					turn_index: telemetry.turnIndex,
				},
				ctx,
			)
			telemetry.emit(
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
					turn_index: telemetry.turnIndex,
				},
				ctx,
			)
		}
	} else if (toolName === "write" && !event.isError) {
		const filePath = extractFilePath(args)
		telemetry.emit(
			"tool_result",
			{
				tool_name: "write",
				success: true,
				duration_ms: toolDurationMs,
				tool_result_size_chars: sizeChars,
				turn_index: telemetry.turnIndex,
			},
			ctx,
		)
		if (filePath) {
			telemetry.emit(
				"file_written",
				{
					language: inferLanguage(filePath),
					file_hash: hashFilePath(filePath),
					lines_added: computeWriteLines(args),
					duration_ms: toolDurationMs,
					turn_index: telemetry.turnIndex,
				},
				ctx,
			)
		}
	} else if (["edit", "multiedit", "patch"].includes(toolName) && !event.isError) {
		telemetry.emit(
			"tool_result",
			{
				tool_name: toolName,
				success: true,
				duration_ms: toolDurationMs,
				tool_result_size_chars: sizeChars,
				turn_index: telemetry.turnIndex,
			},
			ctx,
		)
		const filePath = extractFilePath(args)
		const changes = computeLineChanges(toolName, args)
		if (filePath) {
			telemetry.emit(
				"file_edited",
				{
					language: inferLanguage(filePath),
					file_hash: hashFilePath(filePath),
					lines_added: changes.added,
					lines_deleted: changes.removed,
					duration_ms: toolDurationMs,
					turn_index: telemetry.turnIndex,
				},
				ctx,
			)
		}
	} else if (toolName === "bash") {
		telemetry.emit(
			"tool_result",
			{
				tool_name: "bash",
				success: !event.isError,
				duration_ms: toolDurationMs,
				tool_result_size_chars: sizeChars,
				turn_index: telemetry.turnIndex,
			},
			ctx,
		)
		telemetry.emit(
			"command_executed",
			{
				command_type: "bash",
				exit_code: event.isError ? 1 : 0,
				duration_ms: toolDurationMs,
				bash_output_size_chars: sizeChars,
				turn_index: telemetry.turnIndex,
			},
			ctx,
		)
	}

	// --- Error tracking -------------------------------------------------------
	if (event.isError) {
		let errorMsg = "unknown tool error"
		if (
			event.result &&
			typeof event.result === "object" &&
			Array.isArray((event.result as { content?: unknown }).content)
		) {
			const result = event.result as { content: Array<{ type: string; text?: string }> }
			errorMsg = result.content
				.filter((c: { type: string; text?: string }) => c.type === "text")
				.map((c: { type: string; text?: string }) => c.text ?? "")
				.join("\n")
				.slice(0, 300)
		}
		telemetry.emit(
			"error",
			{
				error_type: "tool_failure",
				tool_name: toolName,
				error_message: errorMsg,
				turn_index: telemetry.turnIndex,
			},
			ctx,
		)
	}
}
