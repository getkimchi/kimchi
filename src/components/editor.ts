import type { KeybindingsManager } from "@earendil-works/pi-coding-agent"
import { CustomEditor, type Theme } from "@earendil-works/pi-coding-agent"
import type { EditorTheme, TUI } from "@earendil-works/pi-tui"
import { isKittyProtocolActive, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { RST_FG } from "../ansi.js"
import { leadingImageMarker, parseImageMarkers, trailingImageMarker } from "../utils/image-marker.js"

const CHEVRON_WIDTH = 2
const PLACEHOLDER_TEXT = "ask anything or type / for commands"

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI escapes
const ANSI_RE = /\x1b\[[^m]*m/g
const SCROLL_INDICATOR_RE = /^─── ([↑↓] \d+ more )/

function setsEqual(a: Set<number>, b: Set<number>): boolean {
	if (a.size !== b.size) return false
	for (const item of a) if (!b.has(item)) return false
	return true
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
	private _sessionIndicator: string | null = null
	private _ideSelectionIndicator: string | null = null
	/**
	 * Registered by the clipboard-image extension (via ui.ts). Called with the
	 * content of a complete bracketed paste before insertion; return true to
	 * consume it (e.g. a dropped image path rendered as an inline marker).
	 */
	onImagePathDrop?: (pastedText: string) => boolean
	/**
	 * Registered by the clipboard-image extension (via ui.ts). Fired whenever
	 * input processing changes the set of `[Image #N]` markers in the draft,
	 * by ANY edit (backspace, bulk delete, undo, kill-ring yank, typing).
	 * The extension reconciles its pending drops against the reported set:
	 * a vanished marker detaches its image (indicator updates immediately),
	 * a fully restored marker (e.g. undo) re-arms it.
	 */
	onImageMarkersEdited?: (presentIds: Set<number>, cause?: "atomic-marker-delete") => void
	/**
	 * Buffer for a bracketed paste whose opener arrived without its closer in
	 * the same input chunk. We cannot defer this to upstream: upstream completes
	 * multi-chunk pastes internally as plain text insertion, bypassing
	 * onImagePathDrop — the dropped image's raw path would land in the draft.
	 */
	private pendingBracketedPaste: string | null = null
	/** Set when the current dispatchInput consumed a marker atomically. */
	private atomicMarkerDeleteRan = false

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
		const markersBefore = this.imageMarkersPresent()
		this.atomicMarkerDeleteRan = false
		this.dispatchInput(data)
		const markersAfter = this.imageMarkersPresent()
		if (!setsEqual(markersBefore, markersAfter)) {
			this.onImageMarkersEdited?.(markersAfter, this.atomicMarkerDeleteRan ? "atomic-marker-delete" : undefined)
		}
	}

	private dispatchInput(data: string): void {
		// A bracketed paste split across chunks resumes here: glue the
		// continuation onto the buffered opener so routeBracketedPastes sees the
		// completed paste in full.
		if (this.pendingBracketedPaste !== null) {
			// A control-only chunk (a keypress, not paste bytes) means the paste's
			// closer is never coming: without an abort path every further
			// keystroke — backspace, arrows, Enter — would glue onto the buffer
			// and vanish. Flush the buffered partial paste as plain text (minus
			// the opener escape, which would drop upstream's own paste buffering
			// into the same livelock) and let the keypress through.
			// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal CSI escape sequences is the point
			const withoutCsi = data.replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, "")
			// Bare CR/LF chunks are glued as continuation, not aborted: a chunk
			// boundary can legitimately land inside a newline run of the paste
			// payload. Any OTHER control-only chunk (arrows, backspace, escape)
			// breaks the buffer — that is also the user's escape hatch.
			// biome-ignore lint/suspicious/noControlCharactersInRegex: control-only input means a keypress, not paste bytes
			const isControlOnlyKeypress = !/[^\x00-\x1f\x7f]/.test(withoutCsi) && !/^[\r\n]+$/.test(data)
			if (!data.includes("\x1b[201~") && isControlOnlyKeypress) {
				const buffered = this.pendingBracketedPaste
				this.pendingBracketedPaste = null
				// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the paste opener escape is the point
				super.handleInput(buffered.replace(/^\x1b\[200~/, ""))
			} else {
				data = this.pendingBracketedPaste + data
				this.pendingBracketedPaste = null
			}
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
		const isCharBackspace =
			this.kb.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, "shift+backspace")
		const isWordBackspace = this.kb.matches(data, "tui.editor.deleteWordBackward")
		if ((isCharBackspace || isWordBackspace) && this.deleteImageMarker(data, isWordBackspace, false)) return
		// shift+delete mirrors upstream's forward-delete fallback (and the
		// shift+backspace side above) so it cannot char-delete INTO a marker.
		const isCharForwardDelete =
			this.kb.matches(data, "tui.editor.deleteCharForward") || matchesKey(data, "shift+delete")
		const isWordForwardDelete = this.kb.matches(data, "tui.editor.deleteWordForward")
		if ((isCharForwardDelete || isWordForwardDelete) && this.deleteImageMarker(data, isWordForwardDelete, true)) return
		if (this.kb.matches(data, "tui.editor.cursorRight") && this.jumpOverImageMarker(data, true)) return
		if (this.kb.matches(data, "tui.editor.cursorLeft") && this.jumpOverImageMarker(data, false)) return
		const dropHandler = this.onImagePathDrop
		if (dropHandler) {
			this.routeBracketedPastes(data, dropHandler)
			return
		}
		super.handleInput(data)
	}

	/**
	 * The set of `[Image #N]` marker numbers currently in the draft. Cheap
	 * substring precheck first: handleInput runs this twice per keystroke and
	 * most drafts never contain a marker, so the full regex only pays when a
	 * marker could exist.
	 */
	private imageMarkersPresent(): Set<number> {
		const text = this.getLines().join("\n")
		return text.includes("[Image #") ? parseImageMarkers(text) : new Set()
	}

	/**
	 * pi-tui keeps undo control private, and its char-delete handler pushes one
	 * undo snapshot per replayed character — an unbracketed replay would make a
	 * 10-char marker take 10 undos to restore. Bracket the replay with a single
	 * pre-delete snapshot and swallow the intermediate ones so the delete lands
	 * as one undo entry, mirroring upstream's atomic `[paste #N]` deletion.
	 */
	private withSingleUndoSnapshot(run: () => void): void {
		const privates = this as unknown as { pushUndoSnapshot: () => void }
		privates.pushUndoSnapshot()
		privates.pushUndoSnapshot = () => {}
		try {
			run()
		} finally {
			// Remove the instance shadow; the prototype method is used again.
			// (delete is required — assigning undefined would keep a broken
			// own-property shadow over the prototype method.)
			// biome-ignore lint/performance/noDelete: see comment above
			delete (privates as Record<string, unknown>).pushUndoSnapshot
		}
	}

	/**
	 * Char- or word-wise delete (backward or forward) against an `[Image #N]`
	 * marker deletes the whole marker in one keystroke (mirrors upstream's
	 * atomic `[paste #N]` deletion — pi-tui's private marker segmentation
	 * can't cover custom marker formats, so we re-emit a single-character
	 * delete once per marker character through upstream's own handler and keep
	 * cursor/render handling entirely upstream-owned). A word-wise delete is
	 * replayed as single-char deletes (\x7f backward, \x1b[3~ forward) so it
	 * cannot stop mid-marker; if the user's keybindings moved the char-delete
	 * action off that sequence the interception bails out and upstream's plain
	 * word-wise delete applies. Detaching the pending image flows through
	 * onImageMarkersEdited with the "atomic-marker-delete" cause.
	 */
	private deleteImageMarker(deleteData: string, isWord: boolean, forward: boolean): boolean {
		const { line, col } = this.getCursor()
		if (!forward && col === 0) return false
		const text = this.getLines()[line] ?? ""
		const marker = forward ? leadingImageMarker(text.slice(col)) : trailingImageMarker(text.slice(0, col))
		if (!marker) return false
		const charSeq = forward ? "\x1b[3~" : "\x7f"
		const action = forward ? "tui.editor.deleteCharForward" : "tui.editor.deleteCharBackward"
		const replay = isWord ? (this.kb.matches(charSeq, action) ? charSeq : null) : deleteData
		if (replay === null) return false
		this.atomicMarkerDeleteRan = true
		this.withSingleUndoSnapshot(() => {
			for (let i = 0; i < marker.length; i++) {
				super.handleInput(replay)
			}
		})
		return true
	}

	/**
	 * Plain arrow-key motion treats an `[Image #N]` marker as one atom: moving
	 * right onto a marker lands after it, moving left off a marker lands
	 * before it (replay of the same cursor input, once per character).
	 * Shift+arrow selection keeps upstream's char-wise granularity.
	 */
	private jumpOverImageMarker(cursorData: string, forward: boolean): boolean {
		const { line, col } = this.getCursor()
		const text = this.getLines()[line] ?? ""
		const marker = forward ? leadingImageMarker(text.slice(col)) : trailingImageMarker(text.slice(0, col))
		if (!marker) return false
		for (let i = 0; i < marker.length; i++) {
			super.handleInput(cursorData)
		}
		return true
	}

	/**
	 * Offer each complete bracketed paste in `data` to `onImagePathDrop` before
	 * upstream insertion, preserving segment order: text before the paste is
	 * processed first, unhandled pastes are re-emitted with their bracket
	 * escapes intact, and bytes after the paste are processed last.
	 *
	 * An incomplete paste (opener without a closer) is buffered in
	 * pendingBracketedPaste and completed by the next chunk. Deferring
	 * multi-chunk pastes to upstream's own buffering would bypass the drop
	 * handler — upstream completes them internally as plain text insertion.
	 */
	private routeBracketedPastes(data: string, dropHandler: (pastedText: string) => boolean): void {
		const OPEN = "\x1b[200~"
		const CLOSE = "\x1b[201~"
		// Tokenize first — complete text/paste segments in order. An opener with
		// no closer captures the rest of the chunk into `remainder`, which WE
		// buffer in pendingBracketedPaste for the next chunk(s) — upstream never
		// sees it (its internal completion would bypass the drop handler).
		// dispatchInput aborts the buffer on a control-only chunk.
		const segments: { pasted: string | null; text: string }[] = []
		let rest = data
		let remainder: string | null = null
		while (rest.length > 0) {
			const open = rest.indexOf(OPEN)
			if (open === -1) {
				segments.push({ pasted: null, text: rest })
				rest = ""
				break
			}
			const close = rest.indexOf(CLOSE, open + OPEN.length)
			if (close === -1) {
				if (open > 0) segments.push({ pasted: null, text: rest.slice(0, open) })
				remainder = rest.slice(open)
				rest = ""
				break
			}
			if (open > 0) segments.push({ pasted: null, text: rest.slice(0, open) })
			segments.push({ pasted: rest.slice(open + OPEN.length, close), text: "" })
			rest = rest.slice(close + CLOSE.length)
		}
		// A lone incomplete paste is held for the continuation chunk instead of
		// going to upstream's buffering (which would swallow the drop).
		if (segments.length === 0) {
			this.pendingBracketedPaste = data
			return
		}
		for (const segment of segments) {
			if (segment.pasted === null) {
				if (segment.text.length > 0) this.handleTextSegment(segment.text)
				continue
			}
			if (segment.pasted.length === 0 || !dropHandler(segment.pasted)) {
				super.handleInput(`${OPEN}${segment.pasted}${CLOSE}`)
			}
		}
		// A chunk ending mid-paste buffers the tail too — handing it to upstream
		// would let the next chunk complete there and bypass the drop handler.
		if (remainder !== null) this.pendingBracketedPaste = remainder
	}

	/**
	 * Process a plain-text segment lying between/around bracketed pastes.
	 * Applies the same shift+enter remap as dispatchInput so a chunk that
	 * coalesces shift+enter with a paste cannot lose its newline.
	 */
	private handleTextSegment(text: string): void {
		if (!isKittyProtocolActive() && (text === "\x1b\r" || text === "\x1b\n")) {
			super.handleInput("\n")
			return
		}
		super.handleInput(text)
	}

	render(width: number): string[] {
		const border = (s: string) => (this.borderColor ? this.borderColor(s) : s)
		const chevronColor = this.appTheme.getFgAnsi("accent")
		const textColor = this.appTheme.getFgAnsi("text")
		const muted = this.appTheme.getFgAnsi("muted")

		const innerWidth = width
		// Upstream Editor crashes on negative widths ("─".repeat(-1)) when the
		// terminal is narrower than the chevron prefix; clamp to a minimum of 1
		// and let the trailing truncateToWidth fit the result to `width`.
		const contentWidth = Math.max(1, innerWidth - CHEVRON_WIDTH)

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
