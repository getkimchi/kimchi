/**
 * diff-viewer.ts — Live unified-diff overlay for the PR review phase.
 *
 * Full-screen Component modeled on agents/ui/conversation-viewer.ts: bordered
 * box, j/k + PgUp/PgDn + Home/End scrolling, auto-scroll tail while the SSH
 * patch stream is arriving, Esc/q closes (the completion dropdown re-shows
 * afterwards). Diffs are NOT wrapped — long lines truncate like
 * ConversationViewer tool output. Coloring is diff-aware via the theme:
 * green additions, red deletions, bold diff/@@ headers, grey context.
 */
import { type Component, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import type { Theme } from "../../agents/ui/agent-widget.js"

// Expand tabs so visibleWidth() matches the terminal's 8-column rendering —
// diffs are full of tab-indented code (same rationale as ConversationViewer).
function expandTabs(s: string): string {
	return s.replace(/\t/g, "        ")
}

const CHROME_LINES = 6
const MIN_VIEWPORT = 3

/** Minimal theme surface for diff coloring — structurally compatible with
 *  both the agents/ui Theme and the pi-tui Theme (both have fg/bold). */
export type DiffTheme = {
	fg(color: string, text: string): string
	bold(text: string): string
}

/** Diff-aware coloring shared by the live overlay and the persisted
 *  remote_run:diff transcript renderer. */
export function colorDiffLine(th: DiffTheme, raw: string): string {
	if (raw.startsWith("+++") || raw.startsWith("---")) return th.fg("muted", raw)
	if (raw.startsWith("+")) return th.fg("success", raw)
	if (raw.startsWith("-")) return th.fg("error", raw)
	if (raw.startsWith("diff --git") || raw.startsWith("index ") || raw.startsWith("@@")) return th.bold(raw)
	if (
		raw.startsWith("new file") ||
		raw.startsWith("deleted file") ||
		raw.startsWith("similarity index") ||
		raw.startsWith("rename from") ||
		raw.startsWith("rename to") ||
		raw.startsWith("Binary files") ||
		raw.startsWith("\\ ")
	) {
		return th.fg("dim", raw)
	}
	return th.fg("muted", raw)
}

export interface DiffViewerOptions {
	/** Header line, e.g. "kimchi/fix-login — 5 files (+120/-30)". */
	title: string
}

export class DiffViewer implements Component {
	private lines: string[] = []
	private partial = ""
	private scrollOffset = 0
	private autoScroll = true
	private streaming = true
	private closed = false

	constructor(
		private tui: TUI,
		private theme: Theme,
		private options: DiffViewerOptions,
		private done: () => void,
	) {}

	/** Feed a patch chunk (from streamRemotePatch's onChunk). Lines split
	 *  across chunk boundaries are buffered until terminated. */
	appendChunk(chunk: string): void {
		if (this.closed) return
		const text = this.partial + chunk
		const splitIdx = text.lastIndexOf("\n")
		if (splitIdx >= 0) {
			const complete = text.slice(0, splitIdx)
			this.partial = text.slice(splitIdx + 1)
			for (const raw of complete.split("\n")) {
				this.lines.push(this.colorLine(raw))
			}
		} else {
			this.partial = text
		}
		this.tui.requestRender()
	}

	/** No more chunks are coming — flush the unterminated tail (a patch whose
	 *  last line lacks a newline, "\ No newline at end of file" aside). */
	finish(): void {
		if (this.closed) return
		this.streaming = false
		if (this.partial.length > 0) {
			this.lines.push(this.colorLine(this.partial))
			this.partial = ""
		}
		this.tui.requestRender()
	}

	get lineCount(): number {
		return this.lines.length
	}

	private colorLine(raw: string): string {
		return colorDiffLine(this.theme, raw)
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			if (this.closed) return
			this.closed = true
			this.done()
			return
		}

		const totalLines = this.lines.length
		const viewportHeight = this.viewportHeight()
		const maxScroll = Math.max(0, totalLines - viewportHeight)

		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1)
			this.autoScroll = this.scrollOffset >= maxScroll
		} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1)
			this.autoScroll = this.scrollOffset >= maxScroll
		} else if (matchesKey(data, "pageUp")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight)
			this.autoScroll = false
		} else if (matchesKey(data, "pageDown")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight)
			this.autoScroll = this.scrollOffset >= maxScroll
		} else if (matchesKey(data, "home")) {
			this.scrollOffset = 0
			this.autoScroll = false
		} else if (matchesKey(data, "end")) {
			this.scrollOffset = maxScroll
			this.autoScroll = true
		}
	}

	render(width: number): string[] {
		if (width < 6) return []
		const th = this.theme
		const innerW = width - 4
		const lines: string[] = []

		const pad = (s: string, len: number) => {
			const expanded = expandTabs(s)
			const vis = visibleWidth(expanded)
			return expanded + " ".repeat(Math.max(0, len - vis))
		}
		const row = (content: string) =>
			`${th.fg("border", "│")} ${truncateToWidth(pad(content, innerW), innerW)} ${th.fg("border", "│")}`
		const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`)
		const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`)
		const hrMid = row(th.fg("dim", "─".repeat(innerW)))

		lines.push(hrTop)
		const statusIcon = this.streaming ? th.fg("accent", "●") : th.fg("success", "✓")
		const state = this.streaming ? th.fg("dim", "streaming…") : th.fg("dim", "complete")
		lines.push(row(`${statusIcon} ${th.bold(this.options.title)} ${th.fg("dim", "·")} ${state}`))
		lines.push(hrMid)

		const contentLines = this.lines.length > 0 ? this.lines : [th.fg("dim", "(waiting for patch…)")]
		const viewportHeight = this.viewportHeight()
		const maxScroll = Math.max(0, contentLines.length - viewportHeight)
		if (this.autoScroll) this.scrollOffset = maxScroll
		const visibleStart = Math.min(this.scrollOffset, maxScroll)
		const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight)
		for (let i = 0; i < viewportHeight; i++) {
			lines.push(row(visible[i] ?? ""))
		}

		lines.push(hrMid)
		const scrollPct =
			contentLines.length <= viewportHeight
				? "100%"
				: `${Math.round(((visibleStart + viewportHeight) / contentLines.length) * 100)}%`
		const hintLeft = th.fg("dim", `${contentLines.length} lines · ${scrollPct}`)
		const hintRight = th.fg("dim", "j/k scroll · PgUp/PgDn · Esc close")
		const hintGap = Math.max(1, innerW - visibleWidth(hintLeft) - visibleWidth(hintRight))
		lines.push(row(hintLeft + " ".repeat(hintGap) + hintRight))
		lines.push(hrBot)

		return lines
	}

	invalidate(): void {
		/* no cached state to clear */
	}

	dispose(): void {
		this.closed = true
	}

	private viewportHeight(): number {
		return Math.max(MIN_VIEWPORT, this.tui.terminal.rows - CHROME_LINES)
	}
}
