import type { Terminal } from "@microsoft/tui-test/lib/terminal/term.js"

/** Named timeouts, tunable in one place. */
export const STARTUP_TIMEOUT_MS = 10_000
export const STREAM_TIMEOUT_MS = 15_000
export const INPUT_TIMEOUT_MS = 5_000

function render(rows: string[][]): string {
	return rows.map((row) => row.join("").trimEnd()).join("\n")
}

export function viewText(terminal: Terminal): string {
	return render(terminal.getViewableBuffer())
}

export function fullText(terminal: Terminal): string {
	return render(terminal.getBuffer())
}

export async function waitForText(
	terminal: Terminal,
	pattern: string | RegExp,
	options: { timeoutMs?: number; full?: boolean } = {},
): Promise<void> {
	const { timeoutMs = 15_000, full = true } = options
	const read = () => (full ? fullText(terminal) : viewText(terminal))
	const matches = (text: string) => {
		if (typeof pattern === "string") return text.includes(pattern)
		// Reset lastIndex so a global/sticky regex doesn't skip matches across polls.
		pattern.lastIndex = 0
		return pattern.test(text)
	}
	const startedAt = Date.now()
	let text = read()
	while (Date.now() - startedAt < timeoutMs) {
		if (matches(text)) return
		await new Promise((resolve) => setTimeout(resolve, 100))
		text = read()
	}
	throw new Error(`Timed out waiting for ${String(pattern)}.\n\nTerminal:\n${text}`)
}
