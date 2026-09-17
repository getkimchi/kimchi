// Terminal focus tracking via DECSET 1004 (focus reporting).
//
// When enabled with `\x1b[?1004h`, the terminal pushes focus-in as `\x1b[I`
// and focus-out as `\x1b[O` onto stdin — the same stream the TUI reads. We
// wrap stdin.emit (the same technique as paste-interceptor.ts) so those
// 3-byte sequences are stripped before the TUI's input parser can mistake
// them for keystrokes, and we record the focus state for other modules
// (currently done-sound.ts).
//
// Supported: iTerm2, kitty, Alacritty, WezTerm, Ghostty, GNOME Terminal,
// Konsole, Windows Terminal, xterm, VS Code / Warp integrated terminals.
// NOT supported: Apple Terminal.app, Linux console; tmux only forwards focus
// events with `set -g focus-events on` (we can't introspect tmux config, so
// we bail); GNU screen is unreliable. A terminal that doesn't support the
// mode simply never sends events, which is indistinguishable from "never
// lost focus" — callers that need a play-or-not decision treat "tracking
// unavailable" as "user is away" (see done-sound.ts).

const ESC = String.fromCharCode(0x1b)

export const FOCUS_IN = `${ESC}[I`
export const FOCUS_OUT = `${ESC}[O`
export const ENABLE_FOCUS_REPORTING = `${ESC}[?1004h`
export const DISABLE_FOCUS_REPORTING = `${ESC}[?1004l`

export type FocusEvent = "in" | "out"

export interface FocusEnv {
	TMUX?: string
	TERM?: string
	TERM_PROGRAM?: string
	WT_SESSION?: string
	platform?: string
}

/**
 * Environment-based capability gate, mirroring terminal-bg-probe's skip
 * list. There is no query/response for mode 1004 (unlike OSC 11), so an
 * unsupporting terminal can only be ruled out heuristically.
 */
export function canDetectFocus(env: FocusEnv = process.env): boolean {
	if (!process.stdin.isTTY || !process.stdout.isTTY) return false
	const platform = env.platform ?? process.platform
	// tmux swallows focus events unless `set -g focus-events on` — bail since
	// we can't introspect its config from here.
	if (env.TMUX) return false
	const term = env.TERM ?? ""
	// Linux console (no escape interpretation) and GNU screen (drops or
	// mangles unknown sequences) — both unreliable.
	if (term === "linux" || term === "dumb" || term.startsWith("screen")) return false
	// Apple Terminal.app never implemented DECSET 1004.
	if (env.TERM_PROGRAM === "Apple_Terminal") return false
	// Windows conhost doesn't implement it; Windows Terminal sets WT_SESSION.
	if (platform === "win32" && !env.WT_SESSION) return false
	return true
}

/**
 * Streaming filter that removes complete `\x1b[I` / `\x1b[O` sequences from
 * input chunks while preserving every other byte in order. A focus sequence
 * split across chunk boundaries (e.g. `\x1b[` then `I`) is held in `pending`
 * and completed on the next `feed` — merging is byte-preserving, so a real
 * key sequence that happens to start with ESC is passed through intact.
 */
export class FocusEventFilter {
	private pending = ""
	/** Assume focused until a focus-out tells us otherwise. */
	private focused = true

	feed(chunk: string): string {
		const data = this.pending + chunk
		this.pending = ""
		const { out, events, partial } = extractFocusEvents(data)
		for (const event of events) {
			this.focused = event === "in"
		}
		if (partial) this.pending = partial
		return out
	}

	isFocused(): boolean {
		return this.focused
	}
}

function extractFocusEvents(data: string): { out: string; events: FocusEvent[]; partial: string } {
	const events: FocusEvent[] = []
	let out = ""
	let i = 0
	const n = data.length
	while (i < n) {
		// Complete focus sequence at i?
		if (data[i] === ESC && i + 2 < n && data[i + 1] === "[") {
			const final = data[i + 2]
			if (final === "I" || final === "O") {
				events.push(final === "I" ? "in" : "out")
				i += 3
				continue
			}
		}
		// A trailing ESC or ESC[ at the end of the chunk may be the start of a
		// focus sequence split across chunks — hold it for the next feed.
		// (Trailing ESC[ is also the prefix of any CSI key sequence, so this
		// only delays emission, never reorders bytes.)
		if (i === n - 1 && data[i] === ESC) break
		if (i === n - 2 && data[i] === ESC && data[i + 1] === "[") break
		out += data[i]
		i += 1
	}
	return { out, events, partial: data.slice(i) }
}

let filter: FocusEventFilter | undefined
let trackingEnabled = false
let installAttempted = false

export function isFocusTrackingEnabled(): boolean {
	return trackingEnabled
}

export function hasTerminalFocus(): boolean {
	return filter?.isFocused() ?? true
}

type MarkedEmit = NodeJS.ReadStream["emit"] & { focusTracker?: boolean }

/**
 * Arms focus reporting: writes the enable sequence and wraps `stdin.emit` so
 * focus events are stripped before the TUI sees them. Idempotent — a failed
 * capability probe marks the attempt done so later calls don't re-probe.
 * Returns whether tracking is active.
 */
export function installFocusTracking(
	stdin: NodeJS.ReadStream = process.stdin,
	write: (s: string) => void = (s) => {
		process.stdout.write(s)
	},
	env: FocusEnv = process.env,
): boolean {
	if (installAttempted) return trackingEnabled
	installAttempted = true
	if (!canDetectFocus(env)) return false

	trackingEnabled = true
	filter = new FocusEventFilter()
	const originalEmit = stdin.emit.bind(stdin)
	const wrapped: MarkedEmit = (event: string | symbol, ...args: unknown[]) => {
		if (event === "data" && args.length > 0) {
			const chunk = args[0]
			const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : null
			if (text !== null && filter) {
				const cleaned = filter.feed(text)
				if (cleaned !== text) return originalEmit("data", cleaned)
			}
		}
		return originalEmit(event, ...args)
	}
	wrapped.focusTracker = true
	stdin.emit = wrapped
	write(ENABLE_FOCUS_REPORTING)
	return true
}

/** Disarms focus reporting. Safe to call when tracking was never enabled. */
export function disableFocusTracking(
	write: (s: string) => void = (s) => {
		process.stdout.write(s)
	},
): void {
	if (trackingEnabled) write(DISABLE_FOCUS_REPORTING)
}
