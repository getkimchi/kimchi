// Heuristic fallback for terminals that don't honor bracketed-paste mode (ESC[?2004h).
// Without bracketed paste, a pasted multi-line block arrives as raw keystrokes — every \r matches the Editor's Enter keybinding and submits the first line as a message. The intent (a single multi-line prompt) is lost.
// This interceptor watches process.stdin and, when a single chunk looks like a burst paste, re-emits it wrapped in ESC[200~...ESC[201~ so pi-tui's existing bracketed-paste pipeline handles it. If the heuristic doesn't fire, behavior is unchanged.

// Use String.fromCharCode — biome strips literal control bytes from string literals.
const ESC = String.fromCharCode(0x1b)
const BRACKETED_START = `${ESC}[200~`
const BRACKETED_END = `${ESC}[201~`

const MIN_CHUNK_LEN = 4
const MIN_CR_COUNT = 2

// Count \r only, not \n. In raw mode Enter is \r, so human pastes arrive as \r-separated; \n in a stdin chunk means programmatic input, not a paste. Adding \n to the count would wrap benign program output in bracketed-paste markers.
export function looksLikeRawPaste(chunk: string): boolean {
	if (chunk.length < MIN_CHUNK_LEN) return false
	// Conservative guard: if the chunk contains any escape byte, leave it alone. A real paste is plain text; an ESC here likely means the chunk also carries a key sequence we shouldn't corrupt.
	if (chunk.includes(ESC)) return false
	let crCount = 0
	for (const ch of chunk) {
		if (ch === "\r" && ++crCount >= MIN_CR_COUNT) return true
	}
	return false
}

export function wrapAsBracketedPaste(chunk: string): string {
	return BRACKETED_START + chunk.replace(/\r\n?/g, "\n") + BRACKETED_END
}

type MarkedEmit = NodeJS.ReadStream["emit"] & { installed?: boolean }

export function installPasteInterceptor(stdin: NodeJS.ReadStream = process.stdin): void {
	if ((stdin.emit as MarkedEmit).installed) return
	const originalEmit = stdin.emit.bind(stdin)
	const wrapped: MarkedEmit = (event: string | symbol, ...args: unknown[]) => {
		if (event === "data" && args.length > 0) {
			const chunk = args[0]
			const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : null
			if (text !== null && looksLikeRawPaste(text)) {
				return originalEmit("data", wrapAsBracketedPaste(text))
			}
		}
		return originalEmit(event, ...args)
	}
	wrapped.installed = true
	stdin.emit = wrapped
}
