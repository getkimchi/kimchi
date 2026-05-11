import { truncateToWidth } from "@earendil-works/pi-tui"

// 4 logo lines + 1 empty spacer + 1 version line + 1 path line
export const SPLASH_HEADER_CONTENT_LINES = 7

// widgetAbove spacer (pi-coding-agent layout) + editor(3) + footer(1)
export const SPLASH_CHROME_LINES = 1 + 3 + 1

export const SPLASH_FIXED_LINES = SPLASH_HEADER_CONTENT_LINES + SPLASH_CHROME_LINES

export function splashTopPadding(): number {
	const termRows = process.stdout.rows ?? 24
	return Math.max(1, Math.floor((termRows - SPLASH_FIXED_LINES) / 2))
}

export function splashBottomPaddingFor(editorLines: number): number {
	const termRows = process.stdout.rows ?? 24
	const used = splashTopPadding() + SPLASH_HEADER_CONTENT_LINES + 1 + editorLines + 1
	return Math.max(0, termRows - used)
}

export function clampLines(lines: string[], width: number): string[] {
	return lines.map((line) => truncateToWidth(line, width))
}
