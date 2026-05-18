import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai"
import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { isSubagent } from "./prompt-construction/prompt-enrichment.js"

const PRUNE_THRESHOLD = 35_000
const PROTECT_WINDOW = 30
const MAX_PROTECTED_CHARS = 100_000
const MIN_PRUNE_CHARS = 500

/**
 * Walk backwards through messages to find the cutoff index.
 * Messages at index >= cutoff are kept; messages before cutoff are candidates for pruning.
 *
 * Stops protecting at whichever bound is hit first:
 * - PROTECT_WINDOW messages from the end, OR
 * - Accumulated tool-result chars exceed MAX_PROTECTED_CHARS
 *
 * Returns 0 if everything fits within the protected budget (nothing to prune).
 */
export function computeCutoff(
	messages: ContextEvent["messages"],
	protectWindow: number,
	maxProtectedChars: number,
): number {
	let cutoff = 0
	let protectedChars = 0

	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages.length - i > protectWindow) {
			cutoff = i + 1
			break
		}
		const m = messages[i] as ToolResultMessage
		if (m.role === "toolResult") {
			for (const block of m.content) {
				if (block.type === "text") protectedChars += block.text.length
			}
		}
		if (protectedChars > maxProtectedChars) {
			cutoff = i + 1
			break
		}
	}

	// Clamp to last message: if recent outputs blew the char budget, still prune everything
	// older than the final message rather than silently skipping compaction entirely.
	return Math.min(cutoff, Math.max(0, messages.length - 1))
}

/**
 * Return a pruned copy of a ToolResultMessage.
 * - Large text blocks are replaced with a placeholder (preserves all other fields).
 * - Error outputs keep the last 2000 chars so the agent can still read the crash reason.
 * - Non-text content blocks (images, etc.) are left untouched.
 */
export function pruneToolResult(msg: ToolResultMessage, minPruneChars: number): ToolResultMessage {
	return {
		...msg,
		content: msg.content.map((block) => {
			if (block.type !== "text") return block
			if (block.text.length < minPruneChars) return block
			if (msg.isError) {
				const tail = block.text.slice(-2000)
				return {
					...block,
					text: `[compacted: ${msg.toolName} error, ${block.text.length} chars]\n...\n${tail}`,
				}
			}
			return {
				...block,
				text: `[compacted: ${msg.toolName} output, ${block.text.length} chars]`,
			}
		}),
	}
}

export default function contextCompactorExtension(pi: ExtensionAPI) {
	if (isSubagent()) return

	// Closure-scoped: independent per agent instance, safe if multiple are constructed.
	let lastInputTokens = 0

	pi.on("message_end", async (event) => {
		const msg = event.message as AssistantMessage
		if (msg.role !== "assistant") return
		lastInputTokens = msg.usage?.input ?? 0
	})

	pi.on("context", async (event) => {
		if (lastInputTokens < PRUNE_THRESHOLD) return

		const { messages } = event
		const cutoff = computeCutoff(messages, PROTECT_WINDOW, MAX_PROTECTED_CHARS)
		if (cutoff === 0) return

		let prunedCount = 0
		let totalCharsRemoved = 0

		const pruned = messages.map((msg, i) => {
			if (i >= cutoff) return msg
			// Explicit cast required: AgentMessage = Message | CustomAgentMessages union;
			// role check alone does not narrow to ToolResultMessage in TypeScript.
			const m = msg as ToolResultMessage
			if (m.role !== "toolResult") return msg
			const originalLen = m.content.reduce((sum, b) => sum + (b.type === "text" ? b.text.length : 0), 0)
			const result = pruneToolResult(m, MIN_PRUNE_CHARS)
			const newLen = result.content.reduce((sum, b) => sum + (b.type === "text" ? b.text.length : 0), 0)
			if (newLen < originalLen) {
				prunedCount++
				totalCharsRemoved += originalLen - newLen
			}
			return result
		})

		if (prunedCount > 0) {
			pi.appendEntry("tool_result_pruning", { prunedCount, totalCharsRemoved, cutoff })
		}

		return { messages: pruned }
	})
}
