// Detect whether the terminal supports the Kitty keyboard protocol (CSI u),
// which is required for modifier-aware Enter (Shift+Enter → newline).
//
// Unsupported terminals include:
//   - macOS Terminal.app, Windows Conhost, many SSH clients
//   - tmux without `extended-keys on`
//   - screen / GNU screen
// Supported terminals include:
//   - Ghostty, Kitty, WezTerm, Alacritty, iTerm2, Warp, VS Code terminal
//
// Probe sequence: send CSI ? u, expect CSI ? <flags> u within the timeout.
//
// Adapted from the same pattern used in src/terminal-bg-probe.ts.

export const QUERY_KITTY_KEYBOARD = "\x1b[?u"
const QUERY_TIMEOUT_MS = 200
const MAX_BUFFER_BYTES = 4096

let cachedSupportsKittyKeyboard: boolean | undefined
let inFlightProbe: Promise<boolean> | undefined

export function getKittyKeyboardSupport(): boolean | undefined {
	return cachedSupportsKittyKeyboard
}

function shouldSkipProbe(): boolean {
	if (!process.stdin.isTTY || !process.stdout.isTTY) return true
	// tmux intercepts and may not forward the query correctly.
	if (process.env.TMUX) return true
	// screen historically mangles unknown CSI sequences.
	const term = process.env.TERM ?? ""
	if (term === "dumb" || term.startsWith("screen")) return true
	return false
}

export async function probeKittyKeyboardSupport(): Promise<boolean> {
	if (inFlightProbe) return inFlightProbe

	inFlightProbe = (async () => {
		if (shouldSkipProbe()) {
			cachedSupportsKittyKeyboard = false
			return false
		}

		const wasRaw = process.stdin.isRaw
		process.stdin.setRawMode?.(true)
		process.stdin.resume()

		return new Promise<boolean>((resolveResult) => {
			let buffer = ""

			const finish = (supported: boolean, leftover: string) => {
				clearTimeout(timeout)
				process.stdin.removeListener("data", handler)
				cachedSupportsKittyKeyboard = supported
				if (leftover.length > 0) process.stdin.unshift(Buffer.from(leftover, "utf8"))
				if (!wasRaw) process.stdin.setRawMode?.(false)
				process.stdin.pause()
				resolveResult(supported)
			}

			const handler = (data: Buffer | string) => {
				buffer += data.toString()
				if (buffer.length > MAX_BUFFER_BYTES) {
					buffer = buffer.slice(buffer.length - MAX_BUFFER_BYTES)
				}
				// Look for CSI ? <digits> u  response
				// biome-ignore lint/suspicious/noControlCharactersInRegex: Kitty keyboard protocol response
				const match = buffer.match(/\[\?(\d+)u/)
				if (match) {
					const idx = match.index ?? 0
					const leftover = buffer.slice(0, idx) + buffer.slice(idx + match[0].length)
					finish(true, leftover)
				}
			}

			const timeout = setTimeout(() => finish(false, buffer), QUERY_TIMEOUT_MS)

			process.stdin.on("data", handler)
			process.stdout.write(QUERY_KITTY_KEYBOARD)
		})
	})()

	return inFlightProbe
}
