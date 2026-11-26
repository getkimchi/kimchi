import type { FakeOpenAiServer } from "../e2e/tui/support/fake-openai-server.js"

export function contentText(content: unknown): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.map((part) =>
			part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
				? (part as { text: string }).text
				: "",
		)
		.join("")
}

export function fakeModelSawPrompt(fake: FakeOpenAiServer, prompt: string): boolean {
	return fake.requests
		.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
		.some((request) => {
			const messages = (request.body as { messages?: Array<{ role?: string; content?: unknown }> } | undefined)
				?.messages
			return (messages ?? []).some(
				(message) => message.role === "user" && contentText(message.content).includes(prompt),
			)
		})
}
