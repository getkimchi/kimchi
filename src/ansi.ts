import type { Theme } from "@mariozechner/pi-coding-agent"

export const TRUECOLOR = process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit"
export const RST = "\x1b[0m"

function tc(rgb: string, fallback256: string): string {
	return TRUECOLOR ? `38;2;${rgb}` : `38;5;${fallback256}`
}

export function fg(code: string, text: string): string {
	if (!code) return text
	return `\x1b[${code}m${text}\x1b[0m`
}

export const TEAL_FG = TRUECOLOR ? "\x1b[38;2;93;202;165m" : "\x1b[38;5;79m"
export const TEAL_DIM_FG = TRUECOLOR ? "\x1b[38;2;74;150;125m" : "\x1b[38;5;35m"
// Semantic state foregrounds, matching master's kimchi.json hexes (teal-500 /
// amber-500 / red-500). Used by surfaces like the permissions footer that need
// fixed semantic colors regardless of the active theme — the kimchi-minimal
// theme intentionally inherits these tokens from the terminal scheme, which
// flattens the visual cue, so callers hardcode the kimchi values here.
export const SUCCESS_FG = TRUECOLOR ? "\x1b[38;2;74;150;125m" : "\x1b[38;5;35m"
export const WARNING_FG = TRUECOLOR ? "\x1b[38;2;239;159;39m" : "\x1b[38;5;214m"
export const ORANGE_FG = TRUECOLOR ? "\x1b[38;2;244;87;46m" : "\x1b[38;5;202m"
export const ERROR_FG = TRUECOLOR ? "\x1b[38;2;204;102;102m" : "\x1b[38;5;167m"
export const RST_FG = "\x1b[39m"

export function semanticFg(c: "success" | "warning" | "error"): string {
	return c === "success" ? SUCCESS_FG : c === "warning" ? WARNING_FG : ERROR_FG
}

// Returns the theme's ANSI open-sequence for `c`, or the hardcoded kimchi
// palette value when the theme has an empty token (e.g. kimchi-minimal).
// Pi stores `fgAnsi("") = RST_FG` for empty tokens, so that's our sentinel.
export function resolvedSemanticFg(theme: Theme, c: "success" | "warning" | "error"): string {
	const ansi = theme.getFgAnsi(c)
	return ansi === RST_FG ? semanticFg(c) : ansi
}

export const ANSI = {
	accent: "38;2;138;190;183",
	dim: tc("102;102;102", "242"),
}
