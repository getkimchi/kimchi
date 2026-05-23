import { CustomEditor, type Theme } from "@earendil-works/pi-coding-agent"
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent"
import type { EditorTheme, TUI } from "@earendil-works/pi-tui"
import { isKittyProtocolActive, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { wordWrapLine } from "@earendil-works/pi-tui/dist/components/editor.js"
import { extractAnsiCode } from "@earendil-works/pi-tui/dist/utils.js"
import { RST_FG } from "../ansi.js"

const CHEVRON_WIDTH = 2
const PLACEHOLDER_TEXT = "ask anything or type / for commands"

const SCROLL_INDICATOR_RE = /^─── ([↑↓] \d+ more )/
// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI escapes
const ANSI_RE = /\x1b\[[^m]*m/g

/** Strip ANSI / OSC / APC escape sequences so the plain text can be compared. */
function stripAnsi(s: string): string {
	if (!s.includes("\x1b")) return s
	let result = ""
	let i = 0
	while (i < s.length) {
		const ansi = extractAnsiCode(s, i)
		if (ansi) {
			i += ansi.length
			continue
		}
		result += s[i]
		i++
	}
	return result
}

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
	// ─── mouse click tracking ──────────────────────────────────────────
	private _lastTopBorderPlain = ""
	private _lastRenderHeight = 0
	private _lastInnerWidth = 0
	private _lastLayoutWidth = 0

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
		const indicatorRaw = this._pendingImageIndicator
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

		// ─── Store metadata for mouse click handling ─────────────────────
		this._lastTopBorderPlain = stripAnsi(topBorder)
		this._lastRenderHeight = result.length
		this._lastInnerWidth = innerWidth
		// layoutWidth is what super.render() uses for wrapping.
		// Upstream paddingX defaults to 0, so:
		//   contentWidth = contentRenderWidth
		//   layoutWidth  = contentWidth - 1 = contentRenderWidth - 1
		this._lastLayoutWidth = Math.max(1, contentRenderWidth - 1)

		return result.map((line) => truncateToWidth(line, width))
	}

	// ═══════════════════════════════════════════════════════════════════
	//  Mouse click → cursor positioning
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Handle a mouse click inside the editor.
	 *
	 * @param screenX 1-indexed column (from SGR mouse report).
	 * @param screenY 1-indexed row    (from SGR mouse report).
	 * @returns `true` if the click was consumed (inside the editor).
	 */
	handleMouseClick(screenX: number, screenY: number): boolean {
		const tui = (this as unknown as { tui: TUI }).tui
		const prevLines: string[] | undefined = (tui as unknown as { previousLines?: string[] }).previousLines
		const prevViewportTop: number = (tui as unknown as { previousViewportTop?: number }).previousViewportTop ?? 0
		if (!prevLines || prevLines.length === 0) {
			return false
		}

		// Convert screen Y to absolute index in previousLines.
		const clickAbsRow = prevViewportTop + screenY - 1
		if (clickAbsRow < 0 || clickAbsRow >= prevLines.length) {
			return false
		}

		// Find our top border by matching the plain-text signature we stored
		// during the last render().  We search backwards from the click because
		// the editor is usually near the bottom.  Multiple borders can share the
		// same plain text (LogoHeader, tool blocks, etc.), so we verify that the
		// candidate's height range actually contains the click before accepting.
		let editorTopRow = -1
		for (let i = Math.min(clickAbsRow, prevLines.length - 1); i >= 0; i--) {
			if (stripAnsi(prevLines[i]) === this._lastTopBorderPlain) {
				const candidateBottom = i + this._lastRenderHeight - 1
				if (clickAbsRow >= i && clickAbsRow <= candidateBottom) {
					editorTopRow = i
					break
				}
				// Wrong component — keep looking upward.
			}
		}
		if (editorTopRow === -1) {
			return false
		}

		const editorBottomRow = editorTopRow + this._lastRenderHeight - 1
		if (clickAbsRow < editorTopRow || clickAbsRow > editorBottomRow) {
			return false
		}

		// Click on borders: move cursor to start / end of content.
		if (clickAbsRow === editorTopRow) {
			this._setCursor(0, 0)
			this.tui.requestRender()
			return true
		}
		if (clickAbsRow === editorBottomRow) {
			const lines = this.getLines()
			const lastLine = lines.length > 0 ? lines[lines.length - 1] : ""
			this._setCursor(lines.length - 1, [...lastLine].length)
			this.tui.requestRender()
			return true
		}

		// Content area click.
		const contentRow = clickAbsRow - editorTopRow - 1 // 0-based inside visible content

		// Account for vertical scroll inside the editor.
		const scrollOffset = (this as unknown as { scrollOffset: number }).scrollOffset ?? 0
		const layoutIdx = contentRow + scrollOffset
		if (layoutIdx < 0) {
			return false
		}

		// Reconstitute the full visual layout from logical lines using the same
		// wrapping regime the Editor uses (wordWrapLine).
		const editorLines = this.getLines()
		const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

		let currentLayoutIdx = 0
		const marginCols = CHEVRON_WIDTH // our "❯ " prefix
		const targetCol = Math.max(0, screenX - 1 - marginCols)

		for (let li = 0; li < editorLines.length; li++) {
			const chunks = wordWrapLine(editorLines[li], this._lastLayoutWidth, [...segmenter.segment(editorLines[li])])
			for (const chunk of chunks) {
				if (currentLayoutIdx === layoutIdx) {
					// Found the visual line that was clicked.  Map click column to
					// character offset inside this chunk.
					const colInChunk = this._graphemeOffsetAtCol(chunk.text, targetCol)
					this._setCursor(li, chunk.startIndex + colInChunk)
					this.tui.requestRender()
					return true
				}
				currentLayoutIdx++
			}
		}

		return false
	}

	/**
	 * Given a plain text string and a target visual column, count how many
	 * graphemes fit within that column using visibleWidth().
	 *
	 * The returned value is a *byte* offset suitable for slicing the original
	 * UTF-16 string (which is what the Editor's cursor col field expects).
	 */
	private _graphemeOffsetAtCol(text: string, targetCol: number): number {
		if (text.length === 0 || targetCol <= 0) return 0
		const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" })
		let col = 0
		let byteOffset = 0
		for (const g of seg.segment(text)) {
			const w = visibleWidth(g.segment)
			if (col + w > targetCol) break
			col += w
			byteOffset += g.segment.length
		}
		return byteOffset
	}

	private _setCursor(line: number, col: number) {
		const state = (this as unknown as { state: { cursorLine: number; cursorCol: number; lines: string[] } }).state
		const maxLine = Math.max(0, state.lines.length - 1)
		state.cursorLine = Math.max(0, Math.min(line, maxLine))
		const lineText = state.lines[state.cursorLine] ?? ""
		const maxCol = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(lineText)].length
		state.cursorCol = Math.max(0, Math.min(col, maxCol))
	}
}
