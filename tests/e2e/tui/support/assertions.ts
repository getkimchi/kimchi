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

/**
 * Waits for the harness to finish processing the main agent turn AND any
 * follow-up completions. Polls request count until stable for settleForMs.
 * Shared across TUI E2E tests that need to wait for the agent to fully settle.
 */
/**
 * Types `/ferment` into the main prompt and submits it.
 *
 * A one-shot `terminal.submit("/ferment")` can race with the editor prompt
 * that opens immediately after the command runs: the trailing return may be
 * processed by the editor, causing it to submit the literal `/ferment` as the
 * intent and skip the "What would you like to ferment?" prompt. Splitting the
 * write and the return, and waiting for the slash text to render first, keeps
 * the return in the main input.
 */
export async function submitFermentCommand(terminal: Terminal): Promise<void> {
	terminal.write("/ferment")
	await waitForText(terminal, "/ferment", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
	terminal.submit("")
}

export async function waitForTurnToSettle(requests: { length: number }): Promise<void> {
	const settleForMs = 1_200
	const timeoutMs = 30_000
	const startedAt = Date.now()
	let lastCount = requests.length
	let stableSince = Date.now()
	while (Date.now() - startedAt < timeoutMs) {
		await new Promise((resolve) => setTimeout(resolve, 100))
		const currentCount = requests.length
		if (currentCount !== lastCount) {
			lastCount = currentCount
			stableSince = Date.now()
		} else if (Date.now() - stableSince >= settleForMs) {
			return
		}
	}
}
