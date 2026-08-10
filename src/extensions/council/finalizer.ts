import type { AssistantMessage, Context, TextContent, ToolCall } from "@earendil-works/pi-ai"

export const LEAD_OUTPUT_SYSTEM_PROMPT =
	"Finish this turn with either a normal user-facing answer or a valid tool call. Do not return only internal reasoning."
export const LEAD_RETRY_SYSTEM_PROMPT =
	"The previous attempt ended without a user-facing answer or tool call. Correct that now."
export const LEAD_VERIFY_STAGED_SYSTEM_PROMPT =
	"Before finishing this turn, verify your staged changes: call council_check_candidate with a catalog check id. " +
	"If the check fails, fix the staged files and check again."
const SERIALIZED_TOOL_CALL_MARKERS = [
	"<|tool_calls_section_begin|>",
	"<|tool_call_begin|>",
	"<|tool_call_argument_begin|>",
] as const

export function publicContent(message: AssistantMessage): (TextContent | ToolCall)[] {
	return message.content.filter((block): block is TextContent | ToolCall => block.type !== "thinking")
}

export function hasInvalidToolCalls(blocks: readonly (TextContent | ToolCall)[], context: Context): boolean {
	const ids = new Set<string>()
	const allowedNames = new Set(context.tools?.map((tool) => tool.name) ?? [])
	for (const block of blocks) {
		if (block.type !== "toolCall") continue
		if (
			typeof block.id !== "string" ||
			!block.id.trim() ||
			typeof block.name !== "string" ||
			!block.name.trim() ||
			!allowedNames.has(block.name) ||
			block.arguments === null ||
			typeof block.arguments !== "object" ||
			Array.isArray(block.arguments)
		) {
			return true
		}
		if (ids.has(block.id)) return true
		ids.add(block.id)
	}
	return false
}

export function hasSerializedToolCallMarkup(text: string): boolean {
	return SERIALIZED_TOOL_CALL_MARKERS.some((marker) => text.includes(marker))
}
