/**
 * context.ts — Extract parent conversation context for subagent inheritance.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent"

/** Extract text from a message content block array. */
export function extractText(content: unknown[]): string {
	return content
		.filter((c: unknown) => (c as { type: string }).type === "text")
		.map((c: unknown) => (c as { text?: string }).text ?? "")
		.join("\n")
}

/**
 * Build a text representation of the parent conversation context.
 */
export function buildParentContext(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getBranch()
	if (!entries || entries.length === 0) return ""

	const parts: string[] = []

	for (const entry of entries) {
		if (entry.type === "message") {
			const msg = entry.message
			if (msg.role === "user") {
				const text = typeof msg.content === "string" ? msg.content : extractText(msg.content)
				if (text.trim()) parts.push(`[User]: ${text.trim()}`)
			} else if (msg.role === "assistant") {
				const text = extractText(msg.content)
				if (text.trim()) parts.push(`[Assistant]: ${text.trim()}`)
			}
			// Skip toolResult messages — too verbose for context
		} else if (entry.type === "compaction") {
			// Include compaction summaries — they're already condensed
			if ((entry as { summary?: string }).summary) {
				parts.push(`[Summary]: ${(entry as { summary: string }).summary}`)
			}
		}
	}

	if (parts.length === 0) return ""

	return `# Parent Conversation Context
The following is the conversation history from the parent session that spawned you.
Use this context to understand what has been discussed and decided so far.

${parts.join("\n\n")}

---
# Your Task (below)
`
}
