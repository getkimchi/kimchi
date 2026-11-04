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
import { classifyToolError, type ToolErrorClassification } from "./tool-error-classification.js"

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

export function resultSizeChars(result: unknown): number {
	const r = result as { content?: Array<{ text?: string }> } | null
	return (r?.content ?? []).reduce((sum, c) => sum + (c.text?.length ?? 0), 0)
}

/** Join all text blocks of a tool result into one string — the shared
 *  extraction contract for error classification (per-result and run-final). */
export function extractToolResultText(result: unknown): string {
	if (!result || typeof result !== "object" || !Array.isArray((result as { content?: unknown }).content)) return ""
	const blocks = (result as { content: Array<{ type: string; text?: string }> }).content
	return blocks
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n")
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

	// --- Error classification (before per-tool emission) ----------------------
	// The bash execution record and the error funnel both consume the
	// classification, and bash needs the parsed exit code below.
	let fullMsg = ""
	let classification: ToolErrorClassification | undefined
	if (event.isError) {
		fullMsg = extractToolResultText(event.result)
		classification = classifyToolError(toolName, fullMsg)
	}
	// Under backend routing the concrete pick lives in lastRoutedModel; carry
	// it so command/outcome records stay sliceable by backend. currentModel
	// (the user-facing selection) is already part of the common attributes.
	const modelOverrides = tm.lastRoutedModel ? { routed_model: tm.lastRoutedModel } : undefined

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
		// --- Execution-result signal -------------------------------------------
		// Exactly one command_executed record per COMPLETED bash execution, with
		// the real parsed exit code — never a fabricated 1 for timeouts,
		// aborts, or exceptions. A recognized pre-execution block/decline never
		// ran a command and emits no misleading execution record; its signal
		// is the tool_outcome event from the error section below. Trace
		// attributes keep the record correlated to the provider request that
		// issued the call — with ordinary failures no longer emitting errors,
		// this is their only trace link.
		const commandAttrs: Record<string, string | number> = {
			command_type: "bash",
			duration_ms: toolDurationMs,
			bash_output_size_chars: sizeChars,
			turn_index: tm.turnIndex,
			tool_use_id: event.toolCallId,
			canonicalization: "v1",
			...tm.getTraceAttributes(),
		}
		if (!event.isError || !classification) {
			tm.emit("command_executed", { ...commandAttrs, command_outcome: "success", exit_code: 0 }, ctx, modelOverrides)
		} else if (classification.kind === "command_outcome") {
			// Ordinary execution results: non-zero exits, timeouts, termination.
			// Not errors — how much execution friction an agent encounters and how
			// it recovers is the analytical question, not harness health.
			tm.emit(
				"command_executed",
				{
					...commandAttrs,
					command_outcome: classification.commandOutcome,
					...(classification.exitCode !== undefined ? { exit_code: classification.exitCode } : {}),
					...(classification.commandOutcome === "timeout" && classification.attrs?.timeout_seconds !== undefined
						? { timeout_seconds: classification.attrs.timeout_seconds }
						: {}),
				},
				ctx,
				modelOverrides,
			)
		} else if (classification.kind === "aborted") {
			tm.emit("command_executed", { ...commandAttrs, command_outcome: "aborted" }, ctx, modelOverrides)
		} else if (classification.kind === "failure") {
			// Unknown bash error: conservatively an execution error — provenance
			// is not perfectly recoverable from strings.
			tm.emit("command_executed", { ...commandAttrs, command_outcome: "execution_error" }, ctx, modelOverrides)
		}
		// blocked / declined / model_mistake: pre-execution — no record.
	}

	// --- Error / outcome tracking ----------------------------------------------
	//
	// Taxonomy contract (tool-error-classification.ts is the single source of
	// truth; message-source owners: keep patterns and fixtures in sync when
	// you change a gate/decline/error string):
	//   - `aborted`           → no error/outcome event; `agent.interrupted`
	//                           (messages.ts) owns the abort signal.
	//   - `command_outcome`    → no error; `command_executed` above records it.
	//   - `blocked`/`declined`/`model_mistake` → `tool_outcome`, never `error`:
	//                           gates, user decisions, and recognized input
	//                           rejections are not harness anomalies.
	//   - `failure`            → `error` with a canonical message where the
	//                           family is known; unrecognized messages keep
	//                           today's raw slice(0, 300) fail-open behavior.
	if (event.isError && classification) {
		const traceAttrs = tm.getTraceAttributes()
		if (classification.kind === "aborted") {
			// No generic emission — see the taxonomy contract above.
		} else if (classification.kind === "command_outcome") {
			// Recorded by command_executed — avoid double-counting.
		} else if (classification.kind === "failure") {
			// A timeout killed by the subagent budget clamp is expected lifecycle
			// behavior, not a tool failure: the `subagent.bash_clamped` event
			// (emitted by the clamp channel handler when the clamp fired) already
			// reports it, and command_executed records the failed run. Suppress the
			// generic error record. The match runs against the FULL text — upstream
			// appends the timeout status after the command output, so a 300-char
			// truncation would hide it on verbose commands and emit a spurious
			// tool_failure. Other bash failures on a clamped call (e.g. non-zero
			// exit before the timeout) still emit normally.
			const clampedTimeout = wasClampedBashCall && BASH_TIMEOUT_STATUS_PATTERN.test(fullMsg)
			if (!clampedTimeout) {
				tm.emit(
					"error",
					{
						error_type: "tool_failure",
						tool_name: toolName,
						error_message: classification.message || "unknown tool error",
						turn_index: tm.turnIndex,
						tool_use_id: event.toolCallId,
						canonicalization: "v1",
						...(classification.attrs ?? {}),
						...traceAttrs,
					},
					ctx,
				)
			}
		} else {
			tm.emit(
				"tool_outcome",
				{
					outcome_kind: classification.kind,
					message: classification.message,
					tool_name: toolName,
					turn_index: tm.turnIndex,
					tool_use_id: event.toolCallId,
					canonicalization: "v1",
					...(classification.attrs ?? {}),
					...traceAttrs,
				},
				ctx,
				modelOverrides,
			)
		}
	}
}
