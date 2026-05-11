// Heuristic fallback for terminals that don't honor bracketed-paste mode (ESC[?2004h).
// Without bracketed paste, a pasted multi-line block arrives as raw \r-separated keystrokes — every \r matches the Editor's Enter keybinding and submits the first line as a message. The intent (a single multi-line prompt) is lost.
// This interceptor watches process.stdin and, when a chunk looks like a paste burst, rewrites \r → \n in place so the Editor treats the bytes as newlines (tui.input.newLine matches \n) instead of submits (tui.input.submit matches \r). A 100 ms trailing-fragment window catches chunk-boundary tails (e.g. the trailing "\rZ" that follows a large paste's main chunk after kernel TTY scheduling, tmux forwarding, or SSH transport latency).
// Why \r → \n rewriting instead of bracketed-paste wrapping: wrapping interacted poorly with pi-tui's StdinBuffer paste-mode tracking and required a debounce/coalesce buffer that reordered events and could swallow a user's Enter immediately after a paste. Direct rewriting transforms each chunk synchronously, with no cross-layer state, no buffering, and no event reordering. See the LLM-1358 follow-up plan in /Users/michal/.claude/plans/paste-auto-send-fix-v2-cr-to-lf-rewriter.md.

// Use String.fromCharCode — biome strips literal control bytes from string literals.
const ESC = String.fromCharCode(0x1b)

const MIN_CHUNK_LEN = 4
const MIN_CR_COUNT = 2

// How long after a seeding paste-burst we treat additional \r-bearing chunks as paste tails. The window only opens after a multi-\r seeding chunk, so a typed Enter (single \r, length 1) cannot trigger it on its own. The realistic threats it must cover are inter-chunk gaps under tmux, SSH (including cross-continent latency), and Windows ConPTY — observed up to ~100 ms. The realistic threat it must NOT cover is a user pressing Enter to submit *after* a paste, which requires perceive-decide-press latency of ≥300 ms. 100 ms sits comfortably between the two.
const TRAILING_WINDOW_MS = 100

// Count \r only, not \n. In raw mode Enter is \r, so human pastes arrive as \r-separated; \n in a stdin chunk means programmatic input, not a paste. Adding \n to the count would treat benign program output as a paste.
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

// Replace \r\n and bare \r with \n. The Editor's tui.input.newLine binding accepts \n (see editor.js handleInput) and inserts a newline; tui.input.submit binds to \r, so any \r left in the chunk would still submit. Rewriting is safe inside an active bracketed paste too — Editor.handlePaste's normalizeText collapses both \r and \n to \n before inserting.
export function rewriteCRToLF(chunk: string): string {
	return chunk.replace(/\r\n?/g, "\n")
}

type MarkedEmit = NodeJS.ReadStream["emit"] & { installed?: boolean }

// `now` is injectable so tests can advance time without sleeping. Defaults to Date.now in production.
export function installPasteInterceptor(stdin: NodeJS.ReadStream = process.stdin, now: () => number = Date.now): void {
	if ((stdin.emit as MarkedEmit).installed) return
	const originalEmit = stdin.emit.bind(stdin)
	let lastRewriteAt = 0

	const wrapped: MarkedEmit = (event: string | symbol, ...args: unknown[]) => {
		if (event === "data" && args.length > 0) {
			const chunk = args[0]
			const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : null
			if (text !== null && !text.includes(ESC) && text.includes("\r")) {
				// Seeding: a chunk that's plainly a multi-line burst.
				if (looksLikeRawPaste(text)) {
					lastRewriteAt = now()
					return originalEmit("data", rewriteCRToLF(text))
				}
				// Trailing fragment: tail of a paste whose head we just rewrote.
				if (now() - lastRewriteAt < TRAILING_WINDOW_MS) {
					lastRewriteAt = now()
					return originalEmit("data", rewriteCRToLF(text))
				}
			}
		}
		return originalEmit(event, ...args)
	}
	wrapped.installed = true
	stdin.emit = wrapped
}
