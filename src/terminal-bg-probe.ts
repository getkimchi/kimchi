// OSC 11 query: ask the terminal what its current background color is.
// Response shape: \x1b]11;rgb:RRRR/GGGG/BBBB(\x07|\x1b\\) — channels are
// 1-4 hex digits each; we take the most-significant byte. Modern terminals
// (iTerm2, Terminal.app, Alacritty, Kitty, WezTerm, GNOME Terminal) all
// support this; we time out after 200ms for ones that don't.

export const QUERY_BG = "\x1b]11;?\x07"
const QUERY_TIMEOUT_MS = 200
// OSC 11 response is ~25 bytes. Cap the buffer well above that so a flood of
// unrelated bytes (paste fragments, mouse events) can't grow it unbounded
// during the probe window. We slice from the tail when over the cap.
const MAX_BUFFER_BYTES = 4096

export type Rgb = { r: number; g: number; b: number }

// Module-level cache so other extensions (notably terminal-colors.ts) can
// reuse the probe result instead of re-querying. `probed` separates "didn't
// query yet" from "queried and got nothing back".
//
// We also cache the raw OSC 11 payload (e.g. `rgb:1A1A/1818/1818`) because
// terminal-colors uses it to write the exact original value back on restore;
// re-deriving from the parsed Rgb would lose the low-byte precision that
// 16-bit terminals send (`1A2B` → we'd write back `1A1A`).
let cachedProbedBg: Rgb | undefined
let cachedRawBgPayload: string | undefined
let probed = false

export function getProbedBackground(): Rgb | undefined {
	return cachedProbedBg
}

export function getRawBgPayload(): string | undefined {
	return cachedRawBgPayload
}

// Bail without running the probe in environments known to either swallow
// OSC 11 (so we'd just sit through the 200ms timeout for nothing) or where
// the response can come back garbled. Caller falls back to a static hex.
function shouldSkipProbe(): boolean {
	if (!process.stdin.isTTY || !process.stdout.isTTY) return true
	// tmux without `set-option -g allow-passthrough on` swallows OSC queries.
	// We can't introspect tmux config from here, so always bail when in tmux.
	if (process.env.TMUX) return true
	const term = process.env.TERM ?? ""
	// Linux virtual console (no escape interpretation) and GNU screen (drops
	// or mangles unknown OSC sequences) — both unreliable for this query.
	if (term === "linux" || term === "dumb" || term.startsWith("screen")) return true
	// Windows Conhost doesn't implement OSC 11. Windows Terminal sets WT_SESSION.
	if (process.platform === "win32" && !process.env.WT_SESSION) return true
	return false
}

export async function probeTerminalBackground(): Promise<Rgb | undefined> {
	if (probed) return cachedProbedBg
	probed = true

	if (shouldSkipProbe()) return undefined

	const wasRaw = process.stdin.isRaw
	process.stdin.setRawMode?.(true)
	process.stdin.resume()

	return new Promise<Rgb | undefined>((resolveResult) => {
		let buffer = ""

		// Anything that arrived during the probe window but isn't the OSC 11
		// response (early keystrokes, focus events, mouse, paste fragments)
		// gets pushed BACK into stdin so pi sees it when it takes over. Without
		// this the user's first few bytes after launch silently vanish.
		const finish = (result: Rgb | undefined, rawPayload: string | undefined, leftover: string) => {
			clearTimeout(timeout)
			process.stdin.removeListener("data", handler)
			cachedProbedBg = result
			cachedRawBgPayload = rawPayload
			if (leftover.length > 0) process.stdin.unshift(Buffer.from(leftover, "utf8"))
			if (!wasRaw) process.stdin.setRawMode?.(false)
			process.stdin.pause()
			resolveResult(result)
		}

		const handler = (data: Buffer | string) => {
			buffer += data.toString()
			// Cap buffer growth — a flood of unrelated bytes shouldn't be able
			// to grow this unbounded. Keep the tail since the OSC response, if
			// it arrives, is at the end of whatever's most recent.
			if (buffer.length > MAX_BUFFER_BYTES) {
				buffer = buffer.slice(buffer.length - MAX_BUFFER_BYTES)
			}
			// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC terminal escape sequence
			const re = /\x1b\]11;(rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+))(?:\x07|\x1b\\)/
			const match = buffer.match(re)
			if (match) {
				// Per X11 spec, a 1-digit channel replicates to fill: "A" → "AA" = 170.
				// padEnd then slice handles 2-4 digit channels correctly; special-case 1.
				const toByte = (h: string) =>
					h.length === 1 ? Number.parseInt(h + h, 16) : Number.parseInt(h.padEnd(4, "0").slice(0, 2), 16)
				const idx = match.index ?? 0
				const leftover = buffer.slice(0, idx) + buffer.slice(idx + match[0].length)
				const rgb = { r: toByte(match[2]), g: toByte(match[3]), b: toByte(match[4]) }
				finish(rgb, match[1], leftover)
			}
		}

		const timeout = setTimeout(() => finish(undefined, undefined, buffer), QUERY_TIMEOUT_MS)

		process.stdin.on("data", handler)
		process.stdout.write(QUERY_BG)
	})
}

// Mirrors pi's own detectColorMode in dist/modes/interactive/theme/theme.js.
// Inlined here because we need the mode at theme-write time, before pi loads.
export function detectColorMode(): "truecolor" | "256color" {
	const colorterm = process.env.COLORTERM
	if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor"
	if (process.env.WT_SESSION) return "truecolor"
	const term = process.env.TERM ?? ""
	if (term === "dumb" || term === "" || term === "linux") return "256color"
	if (process.env.TERM_PROGRAM === "Apple_Terminal") return "256color"
	if (term === "screen" || term.startsWith("screen-") || term.startsWith("screen.")) return "256color"
	return "truecolor"
}

// Lift toward white on dark bgs, drop toward black on light bgs.
//
// `delta` controls how strong the shift is. Useful values:
//   ~6   barely-there tile (tool boxes — content is dense, want minimal interference)
//   ~14  subtle but clearly visible block (user message)
//   ~22  pronounced (custom message — skill invocations, summaries)
//   ~30  prominent (selected item in selectors — needs to mark the cursor)
//
// `redBias > 0` skews the result toward red without changing the overall delta
// magnitude. On dark bgs we add MORE to R and LESS to G/B; on light bgs we
// drop R LESS and G/B MORE. End result: a rosy/red-tinged variant of the same
// brightness shift. Used for error-state surfaces (toolErrorBg).
//
// In 256-color mode (Terminal.app, screen, Linux console, dumb terminals) the
// 24-step gray ramp jumps in 10-unit RGB increments. We need both:
//   1. Each surface to land on a different gray slot than the base bg (else
//      it's invisible) — hence the floor of 10.
//   2. Each surface to land on a different slot from EACH OTHER (else
//      toolPending and userMessage collide on the same slot, looking
//      identical) — hence the 1.4× scale that keeps the hierarchy spaced.
// Truecolor mode is unaffected — deltas pass through as-is.
export function tintBackground(bg: Rgb, delta = 14, redBias = 0, mode?: "truecolor" | "256color"): string {
	const resolvedMode = mode ?? detectColorMode()
	const effectiveDelta = resolvedMode === "256color" ? Math.max(Math.round(delta * 1.4), 10) : delta
	const luminance = 0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b
	const sign = luminance < 128 ? 1 : -1
	const dr = effectiveDelta + sign * redBias
	const dg = Math.max(2, effectiveDelta - sign * redBias)
	const db = Math.max(2, effectiveDelta - sign * redBias)
	const clamp = (n: number) => Math.max(0, Math.min(255, n))
	const r = clamp(bg.r + sign * dr)
	const g = clamp(bg.g + sign * dg)
	const b = clamp(bg.b + sign * db)
	const hex = (n: number) => n.toString(16).padStart(2, "0")
	return `#${hex(r)}${hex(g)}${hex(b)}`
}

// Used when the OSC 11 probe couldn't run (tmux, conhost, non-TTY, ACP, etc).
// We pick a plausible terminal bg from COLORFGBG so downstream tints derive
// from a consistent base. Defaults to a dark estimate since most kimchi users
// run on dark schemes.
export function estimateTerminalBackground(): Rgb {
	const colorfgbg = process.env.COLORFGBG ?? ""
	const parts = colorfgbg.split(";")
	if (parts.length >= 2) {
		const bg = Number.parseInt(parts[1], 10)
		if (!Number.isNaN(bg) && bg >= 8) {
			return { r: 0xff, g: 0xff, b: 0xff }
		}
	}
	return { r: 0x1a, g: 0x18, b: 0x18 }
}

// Foreground ANSI color conversion utilities — mirrors pi's fgAnsi in theme.js.
// Used by kimchi-minimal-tints to apply auto-contrast text colors.

export function hexToFgAnsi(hex: string, mode: "truecolor" | "256color"): string {
	const r = Number.parseInt(hex.slice(1, 3), 16)
	const g = Number.parseInt(hex.slice(3, 5), 16)
	const b = Number.parseInt(hex.slice(5, 7), 16)
	if (mode === "truecolor") return `\x1b[38;2;${r};${g};${b}m`
	return `\x1b[38;5;${rgbTo256(r, g, b)}m`
}

// BG ANSI color conversion utilities — used by kimchi-minimal-tints to apply
// tint hex values as ANSI background codes. Co-located here with the rest of
// the terminal color math.

// 6×6×6 color cube entry points and 24-step gray ramp (indices 232–255).
export const CUBE = [0, 95, 135, 175, 215, 255]
export const GRAY = Array.from({ length: 24 }, (_, i) => 8 + i * 10)

function findClosest(value: number, candidates: readonly number[]): number {
	let minDist = Number.POSITIVE_INFINITY
	let minIdx = 0
	for (let i = 0; i < candidates.length; i++) {
		const d = Math.abs(value - candidates[i])
		if (d < minDist) {
			minDist = d
			minIdx = i
		}
	}
	return minIdx
}

function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
	const dr = r1 - r2
	const dg = g1 - g2
	const db = b1 - b2
	return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114
}

export function rgbTo256(r: number, g: number, b: number): number {
	const ri = findClosest(r, CUBE)
	const gi = findClosest(g, CUBE)
	const bi = findClosest(b, CUBE)
	const cubeIdx = 16 + 36 * ri + 6 * gi + bi
	const cubeDist = colorDistance(r, g, b, CUBE[ri], CUBE[gi], CUBE[bi])
	const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
	const gi2 = findClosest(gray, GRAY)
	const grayValue = GRAY[gi2]
	const grayIdx = 232 + gi2
	const grayDist = colorDistance(r, g, b, grayValue, grayValue, grayValue)
	const spread = Math.max(r, g, b) - Math.min(r, g, b)
	if (spread < 10 && grayDist < cubeDist) return grayIdx
	return cubeIdx
}

export function hexToBgAnsi(hex: string, mode: "truecolor" | "256color"): string {
	const r = Number.parseInt(hex.slice(1, 3), 16)
	const g = Number.parseInt(hex.slice(3, 5), 16)
	const b = Number.parseInt(hex.slice(5, 7), 16)
	if (mode === "truecolor") return `\x1b[48;2;${r};${g};${b}m`
	return `\x1b[48;5;${rgbTo256(r, g, b)}m`
}
