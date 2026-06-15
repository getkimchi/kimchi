import { accumulateToolUsage, handleBashCumulativeMetrics, handleEditCumulativeMetrics } from "../accumulator.js"
import {
	type ToolArgs,
	computeLineChanges,
	computeWriteLines,
	extractFilePath,
	hashFilePath,
	inferLanguage,
} from "../helpers.js"
import type { SessionContext } from "../session-context.js"

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
	ctx: SessionContext,
	event: { toolCallId: string; toolName: string; args: unknown },
): void {
	ctx.pendingArgs.set(event.toolCallId, { toolName: event.toolName, args: event.args })
	ctx.toolStartTimes.set(event.toolCallId, Date.now())
}

export function handleToolExecutionEnd(
	ctx: SessionContext,
	event: { toolCallId: string; isError?: boolean; result?: unknown },
): void {
	const pending = ctx.pendingArgs.get(event.toolCallId)
	if (!pending) return
	ctx.pendingArgs.delete(event.toolCallId)

	const { toolName, args: rawArgs } = pending
	const args = (rawArgs ?? {}) as ToolArgs
	const toolDurationMs = Date.now() - (ctx.toolStartTimes.get(event.toolCallId) ?? ctx.sessionStartMs)

	// --- Tool usage & duration (all tools) ------------------------------------
	const startMs = ctx.toolStartTimes.get(event.toolCallId) ?? Date.now()
	ctx.toolStartTimes.delete(event.toolCallId)
	accumulateToolUsage(ctx.cumulative, toolName, Date.now() - startMs)

	// --- Cumulative metrics ---------------------------------------------------
	if (toolName === "bash") {
		handleBashCumulativeMetrics(ctx.cumulative, args)
	} else if (["edit", "multiedit", "patch", "write"].includes(toolName)) {
		handleEditCumulativeMetrics(ctx.cumulative, toolName, args)
	}

	// --- Per-tool events ------------------------------------------------------

	const model = ctx.currentModel
	const sizeChars = resultSizeChars(event.result)

	if (toolName === "read" && !event.isError) {
		const filePath = extractFilePath(args)
		if (filePath) {
			ctx.emit("tool_result", {
				tool_name: "read",
				model,
				success: true,
				duration_ms: toolDurationMs,
				tool_result_size_chars: sizeChars,
				turn_index: ctx.turnIndex,
			})
			ctx.emit("file_read", {
				model,
				language: inferLanguage(filePath),
				file_hash: hashFilePath(filePath),
				duration_ms: toolDurationMs,
				file_size_chars: sizeChars,
				// read_is_truncated signals that the caller passed a `limit` arg, capping
				// the number of lines returned. A limited read may have omitted content
				// that would otherwise have been returned. Reads without a limit return
				// the full file (up to the built-in size cap), so they are not truncated.
				read_is_truncated: !!args?.limit,
				turn_index: ctx.turnIndex,
			})
		}
	} else if (toolName === "write" && !event.isError) {
		const filePath = extractFilePath(args)
		ctx.emit("tool_result", {
			tool_name: "write",
			model,
			success: true,
			duration_ms: toolDurationMs,
			tool_result_size_chars: sizeChars,
			turn_index: ctx.turnIndex,
		})
		if (filePath) {
			ctx.emit("file_written", {
				model,
				language: inferLanguage(filePath),
				file_hash: hashFilePath(filePath),
				lines_added: computeWriteLines(args),
				duration_ms: toolDurationMs,
				turn_index: ctx.turnIndex,
			})
		}
	} else if (["edit", "multiedit", "patch"].includes(toolName) && !event.isError) {
		ctx.emit("tool_result", {
			tool_name: toolName,
			model,
			success: true,
			duration_ms: toolDurationMs,
			tool_result_size_chars: sizeChars,
			turn_index: ctx.turnIndex,
		})
		const filePath = extractFilePath(args)
		const changes = computeLineChanges(toolName, args)
		if (filePath) {
			ctx.emit("file_edited", {
				model,
				language: inferLanguage(filePath),
				file_hash: hashFilePath(filePath),
				lines_added: changes.added,
				lines_deleted: changes.removed,
				duration_ms: toolDurationMs,
				turn_index: ctx.turnIndex,
			})
		}
	} else if (toolName === "bash") {
		ctx.emit("tool_result", {
			tool_name: "bash",
			model,
			success: !event.isError,
			duration_ms: toolDurationMs,
			tool_result_size_chars: sizeChars,
			turn_index: ctx.turnIndex,
		})
		ctx.emit("command_executed", {
			model,
			command_type: "bash",
			exit_code: event.isError ? 1 : 0,
			duration_ms: toolDurationMs,
			bash_output_size_chars: sizeChars,
			turn_index: ctx.turnIndex,
		})
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
		ctx.emit("error", {
			model,
			error_type: "tool_failure",
			tool_name: toolName,
			error_message: errorMsg,
			turn_index: ctx.turnIndex,
		})
	}
}
