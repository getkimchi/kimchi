/**
 * Helpers for asserting on the recorded wire requests of a TUI E2E session —
 * the system prompt never renders in the terminal, so prompt-shape specs
 * inspect the captured chat-completion bodies instead.
 */

type WireRequest = { url: string; body: unknown }

/** All recorded chat-completion requests (the LLM turns). */
export function chatRequests(fixture: { fake: { requests: WireRequest[] } }): WireRequest[] {
	return fixture.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
}

/** The concatenated system message of a recorded chat request. */
export function systemPromptOf(request: { body: unknown }): string {
	const body = request.body as { messages?: { role: string; content: unknown }[] }
	const system = body.messages?.find((message) => message.role === "system")
	if (typeof system?.content === "string") return system.content
	if (Array.isArray(system?.content)) {
		return system.content
			.map((part) => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
			.join("\n")
	}
	return ""
}
