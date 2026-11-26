import type { SessionEntry } from "@earendil-works/pi-coding-agent"

type MessageSessionEntry = Extract<SessionEntry, { type: "message" }>
export type AssistantMessage = Extract<MessageSessionEntry["message"], { role: "assistant" }>

/** A session `message` entry holding a complete assistant message with zero-cost usage. */
export function createAssistantEntry(
	content: AssistantMessage["content"],
	options: { id?: string; parentId?: string | null; stopReason?: AssistantMessage["stopReason"] } = {},
): MessageSessionEntry {
	const message: AssistantMessage = {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options.stopReason ?? "stop",
		timestamp: 1,
	}
	return {
		type: "message",
		id: options.id ?? "assistant-1",
		parentId: options.parentId ?? null,
		timestamp: "1",
		message,
	}
}
