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

	if (toolName === "read" && !event.isError) {
		const filePath = extractFilePath(args)
		if (filePath) {
			ctx.emit("tool_result", { tool_name: "read", model, success: true, duration_ms: toolDurationMs })
			ctx.emit("file_read", {
				model,
				language: inferLanguage(filePath),
				file_hash: hashFilePath(filePath),
				duration_ms: toolDurationMs,
			})
		}
	} else if (toolName === "write" && !event.isError) {
		const filePath = extractFilePath(args)
		ctx.emit("tool_result", { tool_name: "write", model, success: true, duration_ms: toolDurationMs })
		if (filePath) {
			ctx.emit("file_written", {
				model,
				language: inferLanguage(filePath),
				file_hash: hashFilePath(filePath),
				lines_added: computeWriteLines(args),
				duration_ms: toolDurationMs,
			})
		}
	} else if (["edit", "multiedit", "patch"].includes(toolName) && !event.isError) {
		ctx.emit("tool_result", { tool_name: toolName, model, success: true, duration_ms: toolDurationMs })
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
			})
		}
	} else if (toolName === "bash") {
		ctx.emit("tool_result", { tool_name: "bash", model, success: !event.isError, duration_ms: toolDurationMs })
		ctx.emit("command_executed", {
			model,
			command_type: "bash",
			exit_code: event.isError ? 1 : 0,
			duration_ms: toolDurationMs,
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
		ctx.emit("error", { model, error_type: "tool_failure", tool_name: toolName, error_message: errorMsg })
	}
}
