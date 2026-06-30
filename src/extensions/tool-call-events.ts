/**
 * Generic tool-call domain event channels published via pi.events.
 *
 * Any guard extension that blocks a tool call should emit
 * `TOOL_CALL_EVENTS.BLOCK` so downstream subscribers (e.g. telemetry)
 * can distinguish harness-level blocks from real tool failures without
 * needing guard-specific knowledge. The `guard` field on the payload
 * identifies which extension performed the block, when relevant.
 */

export const TOOL_CALL_EVENTS = {
	BLOCK: "tool_call:block",
} as const

export type ToolCallEventChannel = (typeof TOOL_CALL_EVENTS)[keyof typeof TOOL_CALL_EVENTS]

export interface ToolCallBlockPayload {
	/** The toolCallId of the tool call that was blocked. */
	toolCallId: string
	/** The tool name of the blocked call, when known. */
	toolName?: string
	/** The reason message sent back to the model explaining the block. */
	reason: string
	/** Identifier of the guard extension that performed the block. */
	guard?: string
}
