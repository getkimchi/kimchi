import { CustomEditor, type Theme } from "@earendil-works/pi-coding-agent"
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent"
import type { EditorTheme, TUI } from "@earendil-works/pi-tui"
import { Editor, isKittyProtocolActive, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { RST_FG } from "../ansi.js"

const CHEVRON_WIDTH = 2
const PLACEHOLDER_TEXT = "ask anything or type / for commands"

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI escapes
const ANSI_RE = /\x1b\[[^m]*m/g
const SCROLL_INDICATOR_RE = /^─── ([↑↓] \d+ more )/

function rebuildBorder(baseLine: string, targetWidth: number, borderFn: (s: string) => string): string {
	const raw = baseLine.replace(ANSI_RE, "")
	const match = raw.match(SCROLL_INDICATOR_RE)
	if (match) {
		const indicator = `─── ${match[1]}`
		return borderFn(indicator + "─".repeat(Math.max(0, targetWidth - indicator.length)))
	}
	return borderFn("─".repeat(targetWidth))
}

export class PromptEditor extends CustomEditor {
	private readonly appTheme: Theme
	private readonly kb: KeybindingsManager
	private expandHandler?: () => void
	private _pendingImageIndicator: string | null = null
	private _sessionIndicator: string | null = null

	/**
	 * Computes the width available for the editor's content text when a
	 * right-aligned indicator is shown. Ensures at least 1 cell remains so
	 * super.render() doesn't receive a zero/negative width.
	 *
	 * Layout invariant: contentWidth = contentRenderWidth + indicatorVisibleWidth + indicatorGutter
	 * where indicatorGutter is 1 space between text and indicator when indicator is present, 0 otherwise.
	 */
	private computeContentWidth(contentWidth: number, indicatorRaw: string | null): number {
		const indicatorVisibleWidth = indicatorRaw ? visibleWidth(indicatorRaw) : 0
		const indicatorGutter = indicatorVisibleWidth > 0 ? 1 : 0
		return Math.max(
			1,
			indicatorVisibleWidth > 0 ? contentWidth - indicatorVisibleWidth - indicatorGutter : contentWidth,
		)
	}

	constructor(tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager, appTheme: Theme) {
		super(tui, editorTheme, keybindings)
		this.appTheme = appTheme
		this.kb = keybindings
	}

	setExpandHandler(handler: () => void) {
		this.expandHandler = handler
	}

	/**
	 * Show a short status string right-aligned on the prompt's first line
	 * (the placeholder row). Stays visible regardless of editor content until
	 * cleared with `null`. Used by the clipboard-image extension to surface
	 * pending pasted attachments.
	 */
	setPendingImageIndicator(text: string | null) {
		if (this._pendingImageIndicator === text) return
		this._pendingImageIndicator = text
		this.tui.requestRender()
	}

	/**
	 * Show a short session label right-aligned on the prompt's first line.
	 * Used by the teleport extension to remind the user they are connected
	 * to a remote worker. Pass `null` to clear.
	 */
	setSessionIndicator(text: string | null) {
		if (this._sessionIndicator === text) return
		this._sessionIndicator = text
		this.tui.requestRender()
	}

	override handleInput(data: string) {
		if (this.expandHandler && this.kb.matches(data, "app.tools.expand")) {
			this.expandHandler()
			return
		}
		// tmux and some terminals send \x1b\r for Shift+Enter. Upstream parses
		// it as alt+enter when kitty protocol is not active, so app.message.followUp
		// intercepts it before Editor.handleInput can create a newline. Route it
		// directly to the Editor as \n, which the Editor always treats as newline.
		if (!isKittyProtocolActive() && (data === "\x1b\r" || data === "\x1b\n")) {
			// Re-emit as \n so Editor.handleInput treats it as a newline
			// (its explicit fallback catches \n before the submit path).
			// Going through super avoids brittle prototype-chain jumps.
			super.handleInput("\n")
			return
		}
		super.handleInput(data)
	}

	render(width: number): string[] {
		const border = (s: string) => (this.borderColor ? this.borderColor(s) : s)
		const chevronColor = this.appTheme.getFgAnsi("accent")
		const textColor = this.appTheme.getFgAnsi("text")
		const muted = this.appTheme.getFgAnsi("muted")

		const innerWidth = width
		const contentWidth = innerWidth - CHEVRON_WIDTH

		// When an attachment indicator is shown, the editor body must wrap one
		// indicator-width earlier on every row so the indicator (always pinned to
		// the first row's right edge) never collides with typed text. Computed
		// before super.render() because we need the *narrower* layout up front.
		const indicatorParts: string[] = []
		if (this._sessionIndicator) indicatorParts.push(this._sessionIndicator)
		if (this._pendingImageIndicator) indicatorParts.push(this._pendingImageIndicator)
		const indicatorRaw = indicatorParts.length > 0 ? indicatorParts.join(" ") : null
		const contentRenderWidth = this.computeContentWidth(contentWidth, indicatorRaw)
		const lines = super.render(contentRenderWidth)

		const indicatorVisibleWidth = indicatorRaw ? visibleWidth(indicatorRaw) : 0
		const indicatorGutter = indicatorVisibleWidth > 0 ? 1 : 0

		// Find bottom border: scan backwards for a line starting with ─
		let bottomIdx = Math.min(2, lines.length - 1)
		for (let i = lines.length - 1; i >= 2; i--) {
			const stripped = lines[i].replace(ANSI_RE, "")
			if (/^─/.test(stripped)) {
				bottomIdx = i
				break
			}
		}

		const topBorder = rebuildBorder(lines[0], innerWidth, border)
		const bottomBorder = rebuildBorder(lines[bottomIdx], innerWidth, border)
		const result: string[] = [topBorder]

		// Right-aligned status segment pinned to the first content row of the
		// prompt. Always shown when set: typed text is wrapped one indicator-
		// width earlier (see contentRenderWidth above) so the indicator never
		// collides with text. Persists across empty/non-empty editor states
		// until cleared via setPendingImageIndicator(null).
		const indicatorStyled = indicatorRaw ? `${muted}${indicatorRaw}${RST_FG}` : ""

		if (this.getText().length === 0) {
			const cursorMarker = "\x1b_pi:c\x07"
			// Use terminal's native cursor — no custom styling
			const cursor = `${cursorMarker} `
			// Reserve room for the indicator (plus one space gutter) on the right.
			// If the placeholder no longer fits, drop it entirely rather than
			// truncating mid-word — the cursor still anchors the row.
			const cursorCellWidth = 1 // width of the space the terminal-native cursor occupies
			const leadWidth = CHEVRON_WIDTH + cursorCellWidth
			const placeholderBudget = innerWidth - leadWidth - indicatorVisibleWidth - indicatorGutter
			const placeholderText = placeholderBudget >= visibleWidth(PLACEHOLDER_TEXT) ? PLACEHOLDER_TEXT : ""
			const placeholderRendered = placeholderText.length > 0 ? `${muted}${placeholderText}${RST_FG}` : ""
			const usedWidth = leadWidth + visibleWidth(placeholderText) + indicatorVisibleWidth + indicatorGutter
			const middlePad = " ".repeat(Math.max(0, innerWidth - usedWidth))
			result.push(
				`${chevronColor}❯${RST_FG} ${cursor}${placeholderRendered}${middlePad}${indicatorStyled}${indicatorGutter > 0 ? " " : ""}`,
			)
		} else {
			const contentLines = lines.slice(1, bottomIdx)
			let cursorIdx = contentLines.findIndex((l) => l.includes("\x1b_pi:c"))
			if (cursorIdx === -1) cursorIdx = 0
			for (let i = 0; i < contentLines.length; i++) {
				const line = contentLines[i]
				// Strip inverse-video cursor styling — use terminal's native cursor
				const styled = i === cursorIdx ? line.replace("\x1b[7m", "").replaceAll("\x1b[0m", `\x1b[0m${textColor}`) : line
				const prefix = i === cursorIdx ? `${chevronColor}❯${RST_FG} ` : "  "
				const styledWidth = visibleWidth(styled)
				if (i === 0 && indicatorVisibleWidth > 0) {
					// First row hosts the indicator. Editor body was rendered at
					// contentRenderWidth so styledWidth <= contentRenderWidth and the
					// gap below is always non-negative.
					const gap = " ".repeat(Math.max(0, contentWidth - styledWidth - indicatorVisibleWidth))
					result.push(`${prefix}${textColor}${styled}${RST_FG}${gap}${indicatorStyled}`)
				} else {
					const rightPad = " ".repeat(Math.max(0, contentWidth - styledWidth))
					result.push(`${prefix}${textColor}${styled}${rightPad}${RST_FG}`)
				}
			}
		}

		result.push(bottomBorder)

		for (let i = bottomIdx + 1; i < lines.length; i++) {
			result.push(lines[i])
		}

		return result.map((line) => truncateToWidth(line, width))
	}
}
