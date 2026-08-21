import type { KeybindingsManager } from "@earendil-works/pi-coding-agent"
import { CustomEditor, type Theme } from "@earendil-works/pi-coding-agent"
import type { EditorTheme, TUI } from "@earendil-works/pi-tui"
import { isKittyProtocolActive, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { isNativeModifierPressed } from "@earendil-works/pi-tui/dist/native-modifiers.js"
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
	private _ideSelectionIndicator: string | null = null

	constructor(tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager, appTheme: Theme) {
		super(tui, editorTheme, keybindings)
		this.appTheme = appTheme
		this.kb = keybindings
	}

	setExpandHandler(handler: () => void) {
		this.expandHandler = handler
	}

	/**
	 * Show a short status string in its own row just inside the editor's top
	 * border. Stays visible regardless of editor content until cleared with
	 * `null`. Used by the clipboard-image extension to surface pending pasted
	 * attachments.
	 */
	setPendingImageIndicator(text: string | null) {
		if (this._pendingImageIndicator === text) return
		this._pendingImageIndicator = text
		this.tui.requestRender()
	}

	/**
	 * Show a short session label in its own row just inside the editor's top
	 * border. Used by the teleport extension to remind the user they are
	 * connected to a remote worker. Pass `null` to clear.
	 */
	setSessionIndicator(text: string | null) {
		if (this._sessionIndicator === text) return
		this._sessionIndicator = text
		this.tui.requestRender()
	}

	/**
	 * Show the current IDE selection (e.g. `@src/foo.ts:10-20`) right-aligned
	 * on the prompt's first row, next to the other indicators. Pass `null` to clear.
	 */
	setIdeSelectionIndicator(text: string | null) {
		if (this._ideSelectionIndicator === text) return
		this._ideSelectionIndicator = text
		this.tui.requestRender()
	}

	/**
	 * Compose the current session + pending-image + ide-selection indicators
	 * into a single raw string, or null if none is set.
	 */
	private combinedIndicator(): string | null {
		const parts: string[] = []
		if (this._sessionIndicator) parts.push(this._sessionIndicator)
		if (this._pendingImageIndicator) parts.push(this._pendingImageIndicator)
		if (this._ideSelectionIndicator) parts.push(this._ideSelectionIndicator)
		return parts.length > 0 ? parts.join(" ") : null
	}

	/**
	 * Build a right-aligned, muted indicator row that fits inside `width`.
	 * Truncates with an ellipsis if the indicator text is wider than the row.
	 * Returns null when no indicator is set so the editor's row count stays
	 * unchanged when nothing is pending.
	 */
	private renderIndicatorRow(width: number): string | null {
		const raw = this.combinedIndicator()
		if (!raw) return null
		const muted = this.appTheme.getFgAnsi("muted")
		// truncateToWidth handles the wider-than-width case via cell-aware
		// truncation (preserves ANSI escapes, replaces the tail with "...").
		const truncated = truncateToWidth(raw, width)
		const tw = visibleWidth(truncated)
		const pad = " ".repeat(Math.max(0, width - tw))
		return `${pad}${muted}${truncated}${RST_FG}`
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
		// macOS-native text editing shortcuts using the Cmd (super) modifier.
		//
		// Terminals handle these inconsistently:
		// - iTerm2/Kitty/WezTerm: send raw super-modified Kitty sequences
		// - Ghostty: translates cmd+backspace→alt+w, cmd+left→ctrl+a,
		//   cmd+right→ctrl+e; cmd+delete is swallowed entirely
		// - Terminal.app: translates cmd+backspace→ctrl+u (already works)
		//
		// ctrl+a (cmd+left) and ctrl+e (cmd+right) already work via default
		// keybindings. We intercept the remaining cases and re-emit the
		// equivalent raw control sequences that the upstream Editor already
		// handles via its default keybindings (ctrl+u, ctrl+k, home, end).
		//
		// This cannot be done via keybindings.json because user bindings
		// REPLACE defaults rather than augmenting them.
		const isGhostty = process.env.TERM_PROGRAM === "ghostty"
		// For super+backspace: Ghostty translates to alt+w, so intercept that
		// ONLY on Ghostty to avoid clobbering real alt+w on other terminals.
		if (matchesKey(data, Key.super("backspace")) || (isGhostty && matchesKey(data, "alt+w"))) {
			super.handleInput("\x15") // ctrl+u → deleteToLineStart
			return
		}
		if (matchesKey(data, Key.super("delete"))) {
			super.handleInput("\x0b") // ctrl+k → deleteToLineEnd
			return
		}
		if (matchesKey(data, Key.super("left"))) {
			super.handleInput("\x1b[H") // home → cursorLineStart
			return
		}
		if (matchesKey(data, Key.super("right"))) {
			super.handleInput("\x1b[F") // end → cursorLineEnd
			return
		}
		// Ghostty strips the Option modifier from opt+backspace and opt+delete,
		// sending plain DEL (\x7f) or plain delete (\x1b[3~) with no way to
		// distinguish from a plain keypress via the byte stream alone. Use the
		// native macOS modifier detection (same mechanism pi-tui uses for
		// Terminal.app's Shift+Enter) to check if Option is physically pressed.
		// Only works when pi runs on the same Mac as the terminal (not over SSH).
		if (process.platform === "darwin") {
			if (data === "\x7f" && isNativeModifierPressed("option")) {
				super.handleInput("\x1b\x7f") // alt+backspace → deleteWordBackward
				return
			}
			if (data === "\x1b[3~" && isNativeModifierPressed("option")) {
				super.handleInput("\x1b[3;3~") // alt+delete → deleteWordForward
				return
			}
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

		// Editor body always renders at the full content width — the indicator
		// lives in its own row (renderIndicatorRow below), so the user's text
		// is never squeezed to make room for a right-aligned status string.
		const lines = super.render(contentWidth)

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

		// Indicator row sits between the top border and the first content row,
		// rendered at the full inner width (right-aligned, muted). When no
		// indicator is set, this row is omitted entirely so the editor's row
		// count is unchanged from the no-indicator case.
		const indicatorRow = this.renderIndicatorRow(innerWidth)
		if (indicatorRow !== null) {
			result.push(indicatorRow)
		}

		if (this.getText().length === 0) {
			const cursorMarker = "\x1b_pi:c\x07"
			// Use terminal's native cursor — no custom styling
			const cursor = `${cursorMarker} `
			// The indicator no longer competes for placeholder space — it lives
			// on its own row above this one.
			const cursorCellWidth = 1 // width of the space the terminal-native cursor occupies
			const leadWidth = CHEVRON_WIDTH + cursorCellWidth
			const placeholderBudget = innerWidth - leadWidth
			const placeholderText = placeholderBudget >= visibleWidth(PLACEHOLDER_TEXT) ? PLACEHOLDER_TEXT : ""
			const placeholderRendered = placeholderText.length > 0 ? `${muted}${placeholderText}${RST_FG}` : ""
			const usedWidth = leadWidth + visibleWidth(placeholderText)
			const middlePad = " ".repeat(Math.max(0, innerWidth - usedWidth))
			result.push(`${chevronColor}❯${RST_FG} ${cursor}${placeholderRendered}${middlePad}`)
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
				const rightPad = " ".repeat(Math.max(0, contentWidth - styledWidth))
				result.push(`${prefix}${textColor}${styled}${rightPad}${RST_FG}`)
			}
		}

		result.push(bottomBorder)

		for (let i = bottomIdx + 1; i < lines.length; i++) {
			result.push(lines[i])
		}

		return result.map((line) => truncateToWidth(line, width))
	}
}
