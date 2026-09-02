/** Minimal tool result with text content and empty details. */
export function textResult(message: string) {
	return { content: [{ type: "text" as const, text: message }], details: {} }
}
