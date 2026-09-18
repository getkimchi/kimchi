import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import type { EditorTheme, TUI } from "@earendil-works/pi-tui"
import { Container, Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui"
import { FeedbackEditor } from "./editor.js"

export type FeedbackSentiment = "positive" | "negative"

export interface FeedbackDetailsResult {
	reason: string
}

const TYPE_OWN_ANSWER_LABEL = "Type your own answer"

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
	// Remove the auto-model option (always the entry just before "Type your own answer").
	const ownIdx = all.indexOf(TYPE_OWN_ANSWER_LABEL)
	if (ownIdx <= 1) return all
	return [...all.slice(0, ownIdx - 1), ...all.slice(ownIdx)]
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
		const editorText = this.editor.getText().trim()
		this.done({ reason: editorText })
	}

	override render(width: number): string[] {
		const innerW = Math.max(1, width - 2)
		const contentW = Math.max(1, innerW - 4)

		const b = (s: string) => this.theme.fg("border", s)
		const emptyRow = `${b("│")}${" ".repeat(innerW)}${b("│")}`
		const contentRow = (styledText: string, rawLen: number) =>
			`${b("│")}  ${styledText}${" ".repeat(Math.max(0, contentW - rawLen))}  ${b("│")}`
		const wrapEditorLine = (line: string) => {
			const visLen = visibleWidth(line)
			return `${b("│")}  ${line}${" ".repeat(Math.max(0, contentW - visLen))}  ${b("│")}`
		}

		// Update focus on inner widgets so the editor renders its cursor.
		this.editor.focused = this.isInputFocused()

		const lines: string[] = []

		// Top border with the title centered inside it.
		const titleText = " Rate response "
		const borderLen = Math.max(0, innerW - titleText.length)
		const leftB = Math.floor(borderLen / 2)
		const rightB = borderLen - leftB
		const titleStyled = this.theme.bold(this.theme.fg("accent", titleText))
		lines.push(`${b(`╭${"─".repeat(leftB)}`)}${titleStyled}${b(`${"─".repeat(rightB)}╮`)}`)

		// Breathing room between the title and the first body row.
		lines.push(emptyRow)

		// Subtitle row in muted text.
		const sentimentLabel = this.sentiment === "positive" ? "Good" : "Bad"
		const subtitlePlain = `Your rating: ${sentimentLabel}`
		lines.push(contentRow(this.theme.fg("muted", subtitlePlain), subtitlePlain.length))

		// Empty row for spacing.
		lines.push(emptyRow)

		// Prompt in text color.
		const promptPlain = "Why? (optional)"
		lines.push(contentRow(this.theme.fg("text", promptPlain), promptPlain.length))

		// Predefined options.
		for (let i = 0; i < this.reasons.length; i++) {
			const reason = this.reasons[i]
			if (reason === undefined) continue
			const line = this.renderReasonLine(reason, i, contentW)
			lines.push(wrapEditorLine(line))
		}

		// The editor is only visible when focus is on the last reason
		// ("Type your own answer") or on the input field itself. When focus is
		// on a predefined reason (any index < reasons.length - 1) or nothing
		// is selected we skip the spacing row above the editor AND the editor
		// lines themselves.
		const editorVisible = this.focusIndex !== null && this.focusIndex >= this.reasons.length - 1
		if (editorVisible) {
			lines.push(emptyRow)
			const editorLines = this.editor.render(contentW)
			for (const line of editorLines) {
				lines.push(wrapEditorLine(line))
			}
		}
		lines.push(emptyRow)

		// Hint row, then bottom border.
		const hintPlain = `[Enter] Submit  [↑↓] Select  [Esc] Cancel`
		lines.push(contentRow(this.theme.fg("dim", hintPlain), hintPlain.length))
		lines.push(emptyRow)
		lines.push(b(`╰${"─".repeat(innerW)}╯`))

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

		// Digit jump keys: jump focus to the corresponding reason (1-based),
		// regardless of current focus. Digits never type into the editor.
		// Only `1`..`N` are honored where N is the number of available reasons,
		// so out-of-range digits fall through and never reach the editor.
		if (/^[1-9]$/.test(data)) {
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
