/**
 * LLM Response Log Extension
 *
 * Logs detailed LLM response metadata (model, usage, tool calls, stop reason)
 * as custom session entries for debugging and analytics.
 */

import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

interface LLMResponseDebugEntry {
	model: string
	provider: string
	api: string
	stopReason: string
	errorMessage?: string
	usage: {
		input: number
		output: number
		cacheRead: number
		cacheWrite: number
		totalTokens: number
		cost: {
			input: number
			output: number
			cacheRead: number
			cacheWrite: number
			total: number
		}
	}
	toolCalls: Array<{
		name: string
		id: string
		arguments: unknown
	}>
	contentSummary: string[]
	timestamp: number
}

export default function llmResponseLogExtension(pi: ExtensionAPI): void {
	pi.on("message_end", async (event) => {
		const message = event.message
		if (message.role !== "assistant") {
			return
		}

		try {
			// Extract tool calls from content blocks
			const toolCalls: Array<{ name: string; id: string; arguments: unknown }> = []
			const contentSummary: string[] = []

			for (const block of message.content) {
				if (block.type === "toolCall") {
					toolCalls.push({
						name: block.name,
						id: block.id,
						arguments: block.arguments,
					})
				}
				contentSummary.push(block.type)
			}

			const entry: LLMResponseDebugEntry = {
				model: message.model,
				provider: message.provider,
				api: message.api,
				stopReason: message.stopReason,
				errorMessage: message.errorMessage,
				usage: {
					input: message.usage.input,
					output: message.usage.output,
					cacheRead: message.usage.cacheRead,
					cacheWrite: message.usage.cacheWrite,
					totalTokens: message.usage.totalTokens,
					cost: message.usage.cost,
				},
				toolCalls,
				contentSummary,
				timestamp: Date.now(),
			}

			await pi.appendEntry("llm_response_debug", entry)
		} catch (err) {
			console.error("[llm-response-log] failed to append debug entry:", err)
		}
	})
}
