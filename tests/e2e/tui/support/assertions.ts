import type { Terminal } from "@microsoft/tui-test/lib/terminal/term.js"

export function viewText(terminal: Terminal): string {
	return terminal
		.getViewableBuffer()
		.map((row) => row.join("").trimEnd())
		.join("\n")
}

export function fullText(terminal: Terminal): string {
	return terminal
		.getBuffer()
		.map((row) => row.join("").trimEnd())
		.join("\n")
}

export async function waitForText(
	terminal: Terminal,
	pattern: string | RegExp,
	options: { timeoutMs?: number; full?: boolean } = {},
): Promise<void> {
	const { timeoutMs = 15_000, full = true } = options
	const startedAt = Date.now()
	while (Date.now() - startedAt < timeoutMs) {
		const text = full ? fullText(terminal) : viewText(terminal)
		if (typeof pattern === "string" ? text.includes(pattern) : pattern.test(text)) return
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
	throw new Error(
		`Timed out waiting for ${String(pattern)}.\n\nTerminal:\n${full ? fullText(terminal) : viewText(terminal)}`,
	)
}

export function normalizeTerminalText(text: string): string {
	return text
		.replaceAll(process.cwd(), "<repo>")
		.replace(/\/var\/folders\/[^\s]+/g, "<tmp>")
		.replace(/\/tmp\/[^\s]+/g, "<tmp>")
		.replace(/\b\d+(?:\.\d+)?s\b/g, "<duration>")
		.replace(/\b\d+ms\b/g, "<duration>")
}
