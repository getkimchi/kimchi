import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import type { EditorTheme, TUI } from "@earendil-works/pi-tui"
import { Container, Key, matchesKey } from "@earendil-works/pi-tui"
import { createDialogChrome } from "./dialog-chrome.js"
import { FeedbackEditor } from "./editor.js"

export type FeedbackSentiment = "positive" | "negative"

export interface FeedbackDetailsResult {
	reason: string
}

const TYPE_OWN_ANSWER_LABEL = "Type your own answer"

/**
 * Cap on a typed reason, applied when the dialog submits.
 *
 * The editor accepts bracketed paste, so without a cap a stray paste of a log
 * or a whole file would be stored verbatim in the session transcript and sent
 * on to telemetry. Telemetry clamps again at its own boundary — this is the
 * UI-side half of that, so the transcript and the emitted event agree.
 *
 * 300 characters matches the convention used for every other user-controlled
 * string in the telemetry pipeline, and is far longer than a usable sentence
 * of feedback.
 */
export const MAX_REASON_LENGTH = 300

function clampReason(reason: string): string {
	return reason.length <= MAX_REASON_LENGTH ? reason : reason.slice(0, MAX_REASON_LENGTH)
}

/**
 * Reasons that only make sense when the turn actually ran on the auto-model.
 * Tagged explicitly rather than by position so reordering the lists below
 * cannot silently drop the wrong option from the dialog.
 */
const AUTO_MODEL_REASONS: ReadonlySet<string> = new Set([
	"Auto-model picked the right model",
	"Auto-model picked the wrong model",
])

const POSITIVE_REASONS: string[] = [
	"Solved my task",
	"Followed my instructions",
	"Good code/output quality",
	"Fast response",
	"Auto-model picked the right model",
	TYPE_OWN_ANSWER_LABEL,
]

const NEGATIVE_REASONS: string[] = [
	"Didn't solve the task",
	"Ignored my instructions",
	"Gave incorrect code/output",
	"Too slow",
	"Auto-model picked the wrong model",
	TYPE_OWN_ANSWER_LABEL,
]

export interface ShowFeedbackDetailsDialogOptions {
	sentiment: FeedbackSentiment
	autoModelUsed: boolean
}

/**
 * Whether a submitted reason is one of the predefined labels rather than text
 * the user typed. Telemetry reports this so free-form text (which may contain
 * paths, hostnames or pasted code) can be filtered downstream.
 */
export function isPredefinedReason(reason: string): boolean {
	return POSITIVE_REASONS.includes(reason) || NEGATIVE_REASONS.includes(reason)
}

export async function showFeedbackDetailsDialog(
	ctx: ExtensionContext,
	options: ShowFeedbackDetailsDialogOptions,
): Promise<FeedbackDetailsResult | undefined> {
	return ctx.ui.custom<FeedbackDetailsResult | undefined>(
		(tui, theme, keybindings, done) => new FeedbackDetailsComponent(tui, theme, keybindings, options, done),
		{ overlay: true, overlayOptions: { anchor: "center", width: "70%", maxHeight: "80%" } },
	)
}

function buildReasons(sentiment: FeedbackSentiment, autoModelUsed: boolean): string[] {
	const all = sentiment === "positive" ? POSITIVE_REASONS : NEGATIVE_REASONS
	if (autoModelUsed) return all
	return all.filter((reason) => !AUTO_MODEL_REASONS.has(reason))
}

export class FeedbackDetailsComponent extends Container {
	private readonly theme: Theme
	private readonly editor: FeedbackEditor
	private readonly sentiment: FeedbackSentiment
	private readonly autoModelUsed: boolean
	private readonly done: (result: FeedbackDetailsResult | undefined) => void
	private readonly reasons: string[]
	/**
	 * Single focus index into the list of focusable items:
	 * - `null`              → nothing selected (initial state)
	 * - `0..reasons.length-1` → a reason is selected
	 * - `reasons.length`    → the editor input field is selected
	 */
	private focusIndex: number | null = null

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		options: ShowFeedbackDetailsDialogOptions,
		done: (result: FeedbackDetailsResult | undefined) => void,
	) {
		super()
		this.theme = theme
		this.sentiment = options.sentiment
		this.autoModelUsed = options.autoModelUsed
		this.done = done

		const editorTheme: EditorTheme = {
			borderColor: (s: string) => theme.fg("muted", s),
			selectList: {
				selectedPrefix: (s: string) => theme.fg("accent", s),
				selectedText: (s: string) => theme.bold(s),
				description: (s: string) => theme.fg("muted", s),
				scrollInfo: (s: string) => theme.fg("dim", s),
				noMatch: (s: string) => theme.fg("muted", s),
			},
		}
		this.editor = new FeedbackEditor(tui, editorTheme, keybindings, theme)

		this.reasons = buildReasons(this.sentiment, this.autoModelUsed)
	}

	private isInputFocused(): boolean {
		return this.focusIndex !== null && this.focusIndex >= this.reasons.length
	}

	/**
	 * Whether the custom answer spans more than one line, i.e. whether caret
	 * navigation inside the editor is meaningful. Based on the text rather than
	 * the editor's visual line count because upstream keeps its
	 * `isOnFirstVisualLine`/`isOnLastVisualLine` helpers private.
	 */
	private editorIsMultiLine(): boolean {
		return this.editor.getText().includes("\n")
	}

	private focusedReason(): string | null {
		if (this.focusIndex === null || this.focusIndex >= this.reasons.length) return null
		return this.reasons[this.focusIndex] ?? null
	}

	private setFocusIndex(idx: number | null): void {
		if (idx === null) {
			this.focusIndex = null
			return
		}
		const clamped = Math.max(0, Math.min(this.reasons.length, idx))
		this.focusIndex = clamped
	}

	private renderReasonLine(reason: string, index: number, contentW: number): string {
		const isFocused = this.focusIndex === index
		const label = `${index + 1}. ${reason}`
		if (isFocused) {
			return this.theme.fg("accent", "→ ") + this.theme.bold(this.theme.fg("accent", label))
		}
		const pad = Math.max(0, contentW - 2 - label.length)
		return `  ${label}${" ".repeat(pad)}`
	}

	private submit(): void {
		const focused = this.focusedReason()

		// Predefined reason: submit { reason: focused }.
		if (focused !== null && focused !== TYPE_OWN_ANSWER_LABEL) {
			this.done({ reason: focused })
			return
		}

		// "Type your own answer" focused, the input field focused, or
		// nothing selected: submit the editor text (possibly empty).
		//
		// Clamped here as well as at the telemetry boundary: the editor accepts
		// bracketed paste, so an accidental paste of a log or a file would
		// otherwise be stored verbatim in the session transcript.
		const editorText = clampReason(this.editor.getText().trim())
		this.done({ reason: editorText })
	}

	override render(width: number): string[] {
		const { emptyRow, contentRow, measuredRow, topBorder, bottomBorder, contentWidth } = createDialogChrome(
			this.theme,
			width,
		)

		// Update focus on inner widgets so the editor renders its cursor.
		this.editor.focused = this.isInputFocused()

		const sentimentLabel = this.sentiment === "positive" ? "Good" : "Bad"
		const subtitlePlain = `Your rating: ${sentimentLabel}`
		const promptPlain = "Why? (optional)"
		const hintPlain = `[Enter] Submit  [↑↓] Select  [Esc] Cancel`

		const lines: string[] = [
			topBorder("Rate response"),
			// Breathing room between the title and the first body row.
			emptyRow,
			contentRow(this.theme.fg("muted", subtitlePlain), subtitlePlain),
			emptyRow,
			contentRow(this.theme.fg("text", promptPlain), promptPlain),
			...this.reasons.map((reason, i) => measuredRow(this.renderReasonLine(reason, i, contentWidth))),
		]

		// The editor is only visible when focus is on the last reason
		// ("Type your own answer") or on the input field itself. When focus is
		// on a predefined reason (any index < reasons.length - 1) or nothing
		// is selected we skip the spacing row above the editor AND the editor
		// lines themselves.
		const editorVisible = this.focusIndex !== null && this.focusIndex >= this.reasons.length - 1
		if (editorVisible) {
			lines.push(emptyRow, ...this.editor.render(contentWidth).map(measuredRow))
		}

		lines.push(emptyRow, contentRow(this.theme.fg("dim", hintPlain), hintPlain), emptyRow, bottomBorder)

		return lines
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.done(undefined)
			return
		}

		// Shift+Enter always inserts a newline in the editor regardless of focus.
		if (matchesKey(data, Key.shift("enter"))) {
			this.setFocusIndex(this.reasons.length)
			this.editor.handleInput(data)
			return
		}

		// Arrows normally move focus between the reasons and the input field.
		// Once the user has written a multi-line custom answer, though, they
		// belong to the editor: upstream binds `up`/`down` to cursorUp/cursorDown,
		// and stealing them would leave a multi-line answer with no way to move
		// the caret off the line it was typed on.
		//
		// Single-line answers keep the focus-movement behavior, so arrowing out
		// of the editor back to the reason list still works in the common case.
		if (this.isInputFocused() && this.editorIsMultiLine() && (matchesKey(data, Key.up) || matchesKey(data, Key.down))) {
			this.editor.handleInput(data)
			return
		}

		// Down arrow: move focus to the next item (clamps on the input field).
		if (matchesKey(data, Key.down)) {
			// From "nothing selected" → jump to the first reason.
			if (this.focusIndex === null) {
				this.setFocusIndex(0)
				return
			}
			if (this.focusIndex < this.reasons.length) {
				this.setFocusIndex(this.focusIndex + 1)
			}
			return
		}

		// Up arrow: move focus to the previous item (clamps on the first reason).
		if (matchesKey(data, Key.up)) {
			if (this.focusIndex !== null && this.focusIndex > 0) {
				this.setFocusIndex(this.focusIndex - 1)
			}
			return
		}

		// Digit jump keys: jump focus to the corresponding reason (1-based).
		// Only `1`..`N` are honored where N is the number of available reasons.
		//
		// These are jump keys ONLY while the editor is unfocused. Once the user
		// is typing a custom answer, digits are ordinary text — intercepting
		// them there silently corrupts the free-form reason (e.g. "took 3
		// attempts" would lose the "3" and yank focus away mid-word).
		if (!this.isInputFocused() && /^[1-9]$/.test(data)) {
			const idx = Number(data) - 1
			if (idx >= 0 && idx < this.reasons.length) {
				this.setFocusIndex(idx)
				return
			}
			// Out-of-range digit: consume it so it cannot reach the editor.
			return
		}

		// Plain Enter: submit, with behavior depending on focus.
		if (matchesKey(data, Key.enter)) {
			this.submit()
			return
		}

		// Focus is on the input field: forward everything to the editor.
		if (this.isInputFocused()) {
			this.editor.handleInput(data)
			return
		}

		// Focus is on a reason (or nothing is selected). Treat printable input
		// as typing: move focus to the input field and forward the character
		// so the user can start typing immediately without an extra keystroke.
		if (data.charCodeAt(0) >= 32) {
			this.setFocusIndex(this.reasons.length)
			this.editor.handleInput(data)
		}
	}
}
